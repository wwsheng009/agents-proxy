$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @()
if ($env:BUN_1314) { $candidates += $env:BUN_1314 }
$candidates += (Join-Path $here "..\.bun1314\node_modules\bun\bin\bun.exe")
$candidates += (Join-Path $here ".bun1314\node_modules\bun\bin\bun.exe")
$candidates += (Join-Path $here "..\.tmp-bun1314\node_modules\bun\bin\bun.exe")
$candidates += (Join-Path $here "..\..\.bun1314\node_modules\bun\bin\bun.exe")
$candidates += (Join-Path $here "..\..\.tmp-bun1314\node_modules\bun\bin\bun.exe")
$candidates += "bun"

$bun = $null
foreach ($candidate in $candidates) {
    try {
        $version = (& $candidate --version 2>$null | Select-Object -First 1)
        if ($version -and $version.Trim() -eq "1.3.14") {
            $bun = $candidate
            break
        }
    } catch { }
}

if (-not $bun) {
    Write-Error "需要 Bun 1.3.14（上游 TLS/HTTP2 指纹门；1.4.x 会 403）。请先: npm install bun@1.3.14 --prefix .bun1314"
    exit 1
}

Write-Host "using Bun 1.3.14: $bun"
& $bun run (Join-Path $here "forward.ts")
