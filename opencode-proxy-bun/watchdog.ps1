param(
    [string]$Listen = "127.0.0.1:8788",
    [int]$FailureThreshold = 3,
    [int]$ProbeIntervalSeconds = 30,
    [int]$RestartDelaySeconds = 2,
    [switch]$Once,
    [string]$Bun,
    [string]$LogBase = "proxy"
)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-SupportedBunVersion([string]$value) {
    try {
        $parsed = [version](($value.Trim() -split '[-+]')[0])
        return ($parsed -ge [version]'1.3.14' -and $parsed -lt [version]'1.5.0')
    } catch {
        return $false
    }
}

$bun = $Bun
$candidates = @()
if ($env:BUN_BIN) { $candidates += $env:BUN_BIN }
if ($env:BUN_1314) { $candidates += $env:BUN_1314 }
$candidates += (Join-Path $here ".bun1314\node_modules\bun\bin\bun.exe")
$candidates += (Join-Path $here ".bun142\node_modules\bun\bin\bun.exe")
$candidates += (Join-Path $here "..\.bun1314\node_modules\bun\bin\bun.exe")
$candidates += (Join-Path $here "..\.bun142\node_modules\bun\bin\bun.exe")
$candidates += (Join-Path $here "..\.tmp-bun1314\node_modules\bun\bin\bun.exe")
$candidates += (Join-Path $here "..\.tmp-bun142\node_modules\bun\bin\bun.exe")
$candidates += "bun"

if ($bun) {
    $version = (& $bun --version 2>$null | Select-Object -First 1)
    if (-not $version -or -not (Test-SupportedBunVersion $version)) {
        Write-Error "指定的 Bun 不受支持: $bun ($version)；可用版本: 1.3.14+ / 1.4.x"
        exit 1
    }
} else {
    foreach ($candidate in $candidates) {
        try {
            $version = (& $candidate --version 2>$null | Select-Object -First 1)
            if ($version -and (Test-SupportedBunVersion $version)) {
                $bun = $candidate
                break
            }
        } catch { }
    }
}

if (-not $bun) {
    Write-Error "需要 Bun 1.3.14+ 或 1.4.x（已验证 1.3.14 / 1.4.2 / 1.4.3）。可通过 BUN_BIN 指定二进制。"
    exit 1
}

$port = ($Listen -split ":")[-1]
$base = "http://127.0.0.1:$port"
$log = Join-Path $here "$LogBase.console.log"
$errLog = Join-Path $here "$LogBase.console.err.log"
$outLog = Join-Path $here "$LogBase.watchdog.out.log"
$watchErrLog = Join-Path $here "$LogBase.watchdog.err.log"
$watchdogLog = if ($LogBase -eq "proxy") {
    Join-Path $here "watchdog.log"
} else {
    Join-Path $here "$LogBase.watchdog.log"
}

function Write-Watchdog([string]$message) {
    $line = "$(Get-Date -Format o) $message"
    Write-Host $line
    Add-Content -Path $watchdogLog -Value $line
}

function Start-Proxy {
    Write-Watchdog "[watchdog] starting Bun $( & $bun --version ): $bun"
    $existing = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Watchdog "[watchdog] port $port already has a listener (pid=$($existing[0].OwningProcess)); attaching"
        return $null
    }
    $env:LISTEN = $Listen
    # Start-Process redirection truncates the target on every start, so the
    # proxy runs under a shell that appends to the main log instead.
    $process = Start-Process -FilePath pwsh `
        -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
            "& '$bun' run '$here/src/index.ts' *>> '$log'"
        ) `
        -WorkingDirectory $here `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $watchErrLog `
        -PassThru
    Write-Watchdog "[watchdog] pid=$($process.Id)"
    return $process
}

function Stop-Proxy($process) {
    if ($null -eq $process) { return }
    try {
        Write-Watchdog "[watchdog] stopping pid=$($process.Id)"
        # The process started here is the shell wrapper; stop its whole tree so
        # the Bun child does not keep holding the port.
        & taskkill /PID $process.Id /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 500
    } catch {
        Write-Watchdog "[watchdog] stop failed: $_"
    }
}

function Stop-ListenerOnPort {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if (-not $listener) { return }
    foreach ($pidValue in ($listener | Select-Object -ExpandProperty OwningProcess -Unique)) {
        try {
            Write-Watchdog "[watchdog] stopping listener pid=$pidValue"
            # Kill the wrapper and its Bun child; a bare Stop-Process would
            # leave the child holding the port.
            & taskkill /PID $pidValue /T /F 2>$null | Out-Null
        } catch {
            Write-Watchdog "[watchdog] stop listener failed: $_"
        }
    }
    Start-Sleep -Milliseconds 500
}

function Get-Health {
    try {
        $response = Invoke-WebRequest -Uri "$base/healthz" -TimeoutSec 5 -UseBasicParsing
        return ($response.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-UpstreamAdmission {
    # A single direct request from a fresh Bun process. If this fails too,
    # the problem is upstream-wide and a restart will not help.
    $probe = Join-Path $here "scripts\probe-upstream.ts"
    try {
        $output = & $bun run $probe 2>&1 | Out-String
        Write-Watchdog "[watchdog] upstream probe: $output"
        return ($LASTEXITCODE -eq 0)
    } catch {
        Write-Watchdog "[watchdog] upstream probe failed: $_"
        return $false
    }
}

function Test-ExistingInstanceHealthy {
    $health = Get-Health
    return ($null -ne $health -and $health.status -ne "degraded")
}

$process = $null
$consecutiveDegraded = 0
$ownProcess = $false

# Attach to an already-running instance instead of launching a duplicate.
$listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($listener) {
    Write-Watchdog "[watchdog] found existing listener on $port (pid=$($listener[0].OwningProcess)); monitoring only"
} else {
    $process = Start-Proxy
    $ownProcess = $null -ne $process
    if ($ownProcess) {
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (Get-Health) { break }
            Start-Sleep -Milliseconds 250
        }
    }
    if ($ownProcess -and -not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
        Write-Watchdog "[watchdog] proxy did not start listening on $port; check $log"
    }
}

while ($true) {
    $health = Get-Health
    $healthUnavailable = $false
    if ($null -eq $health) {
        Write-Watchdog "[watchdog] /healthz unavailable"
        $healthUnavailable = $true
        $consecutiveDegraded++
    } elseif ($health.status -eq "degraded") {
        Write-Watchdog "[watchdog] healthz degraded: 403 streak=$($health.upstream_403_streak) last_log_id=$($health.last_upstream_log_id)"
        $consecutiveDegraded++
    } else {
        $consecutiveDegraded = 0
    }

    if ($consecutiveDegraded -ge $FailureThreshold) {
        Write-Watchdog "[watchdog] threshold reached ($consecutiveDegraded); checking upstream admission"
        if ($healthUnavailable) {
            # The local process is gone or wedged. Restart it regardless of
            # upstream admission; otherwise a dead proxy stays dead forever
            # while the upstream is also returning 403.
            Write-Watchdog "[watchdog] /healthz unavailable; restarting local proxy"
            Stop-Proxy $process
            Stop-ListenerOnPort
            Start-Sleep -Seconds $RestartDelaySeconds
            $process = Start-Proxy
            $ownProcess = $null -ne $process
            $consecutiveDegraded = 0
        } elseif (-not (Test-UpstreamAdmission)) {
            Write-Watchdog "[watchdog] upstream admission also failing; not restarting (wait for upstream)"
            $consecutiveDegraded = 0
        } elseif (-not (Test-ExistingInstanceHealthy)) {
            Write-Watchdog "[watchdog] upstream probe passed but /healthz is still degraded; restarting local proxy"
            Stop-Proxy $process
            Stop-ListenerOnPort
            Start-Sleep -Seconds $RestartDelaySeconds
            $process = Start-Proxy
            $ownProcess = $null -ne $process
            $consecutiveDegraded = 0
        } else {
            Write-Watchdog "[watchdog] upstream admission is healthy and /healthz recovered; not restarting"
            $consecutiveDegraded = 0
        }
    }

    if ($Once) { break }
    Start-Sleep -Seconds $ProbeIntervalSeconds
}

if ($ownProcess -and $null -ne $process) {
    Stop-Proxy $process
} else {
    Write-Watchdog "[watchdog] attached to an existing listener; leaving it running"
}
