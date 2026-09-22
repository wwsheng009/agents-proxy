# start-proxy.ps1 - 生成证书（如缺失）、配置环境变量并启动本地代理。
#
# 用法:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\start-proxy.ps1
#
# 可选环境变量（启动前设置）:
#   PORT            HTTP 监听端口，默认 8787
#   HTTPS_PORT      HTTPS 监听端口，默认 8788
#   TARGET_BASE_URL 反向代理目标，默认 https://opencode.ai
#   LOG_FILE        日志文件路径，默认 <项目根>\proxy.log
#   LOG_BODY        是否记录 body 预览，默认 false
#   LOG_SENSITIVE_HEADERS  记录 authorization 等敏感 header 明文，默认 false（脱敏）
#
# 代理在前台运行，Ctrl+C 停止。

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$certDir = Join-Path $projectRoot "certs"
$caFile = Join-Path $certDir "ca.pem"
$keyFile = Join-Path $certDir "server.key"
$crtFile = Join-Path $certDir "server.crt"

# 1. 证书缺失时自动生成
if (-not (Test-Path $caFile) -or -not (Test-Path $keyFile) -or -not (Test-Path $crtFile)) {
    Write-Host "[proxy] 证书缺失，正在生成本地证书..."
    & (Get-Command pwsh).Source -NoProfile -ExecutionPolicy Bypass `
        -File (Join-Path $PSScriptRoot "generate-cert.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "证书生成失败"
    }
}

# 2. 代理自身环境变量
$env:PORT = if ($env:PORT) { $env:PORT } else { "8787" }
$env:HTTPS_PORT = if ($env:HTTPS_PORT) { $env:HTTPS_PORT } else { "8788" }
$env:TARGET_BASE_URL = if ($env:TARGET_BASE_URL) { $env:TARGET_BASE_URL } else { "https://opencode.ai" }
$env:LOG_FILE = if ($env:LOG_FILE) { $env:LOG_FILE } else { Join-Path $projectRoot "proxy.log" }
$env:LOG_BODY = if ($env:LOG_BODY) { $env:LOG_BODY } else { "false" }
$env:LOG_SENSITIVE_HEADERS = if ($env:LOG_SENSITIVE_HEADERS) { $env:LOG_SENSITIVE_HEADERS } else { "false" }
$env:TLS_KEY_FILE = $keyFile
$env:TLS_CERT_FILE = $crtFile

# 3. 代理进程自己不走代理，避免回环
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue

Write-Host "[proxy] HTTP   http://127.0.0.1:$($env:PORT)"
Write-Host "[proxy] HTTPS  https://127.0.0.1:$($env:HTTPS_PORT)"
Write-Host "[proxy] 目标   $($env:TARGET_BASE_URL)"
Write-Host "[proxy] 日志   $($env:LOG_FILE)"
if ($env:LOG_SENSITIVE_HEADERS -match '^(1|true|yes)$') {
    Write-Host "[proxy] 警告   LOG_SENSITIVE_HEADERS 已开启，authorization 等敏感 header 将以明文写入日志" -ForegroundColor Yellow
}
Write-Host "[proxy] 另开一个终端运行 scripts\start-opencode.ps1"
Write-Host ""

& node (Join-Path $projectRoot "proxy.js")
