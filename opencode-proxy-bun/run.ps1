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

$bun = $null
$bunVersion = $null
foreach ($candidate in $candidates) {
    try {
        $version = (& $candidate --version 2>$null | Select-Object -First 1)
        if ($version -and (Test-SupportedBunVersion $version)) {
            $bun = $candidate
            $bunVersion = $version.Trim()
            break
        }
    } catch { }
}

if (-not $bun) {
    Write-Error "需要 Bun 1.3.14+ 或 1.4.x（已验证 1.3.14 / 1.4.2 / 1.4.3）。请先安装受支持的 Bun，或设置 BUN_BIN。"
    exit 1
}

Write-Host "using Bun ${bunVersion}: $bun"

if ($env:NO_WATCHDOG -eq "1") {
    & $bun run (Join-Path $here "src\index.ts")
    exit $LASTEXITCODE
}

& (Join-Path $here "watchdog.ps1") -Bun $bun @args
