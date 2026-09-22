# start-opencode.ps1 - 设置代理环境变量并启动 opencode。
#
# 用法:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\start-opencode.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\start-opencode.ps1 --model xxx
#
# 传给本脚本的所有参数都会原样透传给 opencode。
#
# 可选环境变量（启动前设置）:
#   PROXY_PORT      代理 HTTP 端口，默认 8787
#   NO_PROXY_EXTRA  追加到 NO_PROXY 的地址（逗号分隔）

# 本脚本不声明 param 块：所有入参进入 $args，原样透传给 opencode。

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$proxyPort = if ($env:PROXY_PORT) { $env:PROXY_PORT } else { "8787" }
$proxyUrl = "http://127.0.0.1:$proxyPort"

# 1. 先确认代理在运行
$healthUrl = "$proxyUrl/__proxy/health"
try {
    $null = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
} catch {
    Write-Host "[opencode] 代理未运行: $healthUrl"
    Write-Host "[opencode] 请先在另一个终端运行 scripts\start-proxy.ps1"
    exit 1
}

# 2. 代理环境变量
$noProxy = "localhost,127.0.0.1,::1"
if ($env:NO_PROXY_EXTRA) {
    $noProxy = "$noProxy,$($env:NO_PROXY_EXTRA)"
}
$env:HTTP_PROXY = $proxyUrl
$env:HTTPS_PROXY = $proxyUrl
$env:NO_PROXY = $noProxy

# 3. 信任本地 CA（访问代理自己的 HTTPS 端点时需要）
$caFile = Join-Path $projectRoot "certs\ca.pem"
if (Test-Path $caFile) {
    $env:NODE_EXTRA_CA_CERTS = $caFile
}

Write-Host "[opencode] HTTP_PROXY  = $($env:HTTP_PROXY)"
Write-Host "[opencode] HTTPS_PROXY = $($env:HTTPS_PROXY)"
Write-Host "[opencode] NO_PROXY    = $($env:NO_PROXY)"
if ($env:NODE_EXTRA_CA_CERTS) {
    Write-Host "[opencode] CA          = $($env:NODE_EXTRA_CA_CERTS)"
}
Write-Host ""

# 4. 启动 opencode，透传所有参数
& opencode @args
exit $LASTEXITCODE
