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
#   LOG_BODY        是否记录完整原始 body 到日志文件（不折叠、不截断），默认 false；
#                   默认只记字节数与摘要（model/stream/messages/tools 名），设为 true 记录完整 body；
#                   完整 body 只写入日志文件，控制台永远不会打印 body 内容
#   LOG_STDOUT      控制台是否输出日志摘要行（不含 body），默认 true；
#                   设为 false 后控制台完全静默，日志只写 LOG_FILE
#   LOG_BODY_BASE64 附加 body 的 base64 原样副本（用于二进制/压缩流的完整捕获），默认 false
#   LOG_SENSITIVE_HEADERS  记录 authorization 等敏感 header 明文，默认 false（脱敏）
#   ZEN_TEMPLATE_FILE / ZEN_AGENT_TEMPLATE_FILE / ZEN_TOOLS_FILE
#                   zen 兼容层资源文件（第三方转储；opencode_tools.json 的最小版已随仓库跟踪，其余仍不入库，见 .gitignore）。
#                   不设置时本脚本按 <项目根>\ → <项目根>\proxy-go\ 顺序自动定位后导出（**根目录优先**：
#                   根目录命中即不再看 proxy-go\；proxy-go\ 那份被 .gitignore 排除，作本地覆盖用，
#                   要用它需显式设置本变量或先移走根目录那份），
#                   使资源位置与 proxy.js 的 __dirname 解耦；外部已设置的值不覆盖。
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
$env:LOG_STDOUT = if ($env:LOG_STDOUT) { $env:LOG_STDOUT } else { "true" }
$env:LOG_BODY_BASE64 = if ($env:LOG_BODY_BASE64) { $env:LOG_BODY_BASE64 } else { "false" }
$env:LOG_SENSITIVE_HEADERS = if ($env:LOG_SENSITIVE_HEADERS) { $env:LOG_SENSITIVE_HEADERS } else { "false" }
$env:TLS_KEY_FILE = $keyFile
$env:TLS_CERT_FILE = $crtFile

# 2b. zen 兼容层资源文件（第三方转储；opencode_tools.json 的最小版已随仓库跟踪，其余仍不入库，见 .gitignore；
#     proxy-go\opencode_tools.json 同样被 .gitignore 排除，是留给本地覆盖的位置，但下面的定位顺序是根目录优先）
# proxy.js 对这三个文件有基于 __dirname 的默认路径，且加载失败时静默降级（'' / []）：
# 文件一旦不在 proxy.js 同级目录，"tools 缺 read 时前插 canonical read 工具"就会无声失效，
# 表现为缺 read 的请求被上游 403。这里显式定位并导出，使资源位置与 proxy.js 所在目录解耦；
# 外部已设置的变量优先，不覆盖。
$zenResourceCandidates = [ordered]@{
    ZEN_TEMPLATE_FILE       = @("opencode_system_prompt.txt",       "proxy-go\opencode_system_prompt.txt")
    ZEN_AGENT_TEMPLATE_FILE = @("opencode_agent_system_prompt.txt", "proxy-go\opencode_agent_system_prompt.txt")
    ZEN_TOOLS_FILE          = @("opencode_tools.json",              "proxy-go\opencode_tools.json")
}
$zenResolved = [ordered]@{}
$zenMissing = @()
foreach ($zenName in $zenResourceCandidates.Keys) {
    $existing = [Environment]::GetEnvironmentVariable($zenName)
    if (-not [string]::IsNullOrEmpty($existing)) {
        $zenResolved[$zenName] = "$existing (外部指定)"
        continue
    }
    $hit = $null
    foreach ($rel in $zenResourceCandidates[$zenName]) {
        $candidate = Join-Path $projectRoot $rel
        if (Test-Path -LiteralPath $candidate) { $hit = $candidate; break }
    }
    if ($hit) {
        [Environment]::SetEnvironmentVariable($zenName, $hit)
        $zenResolved[$zenName] = $hit
    } else {
        $zenMissing += $zenName
    }
}

# 3. 代理进程自己不走代理，避免回环
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue

Write-Host "[proxy] HTTP   http://127.0.0.1:$($env:PORT)"
Write-Host "[proxy] HTTPS  https://127.0.0.1:$($env:HTTPS_PORT)"
Write-Host "[proxy] 目标   $($env:TARGET_BASE_URL)"
Write-Host "[proxy] 日志   $($env:LOG_FILE)"
Write-Host "[proxy] LOG_BODY=$($env:LOG_BODY)（true=完整 body 写入日志文件；控制台只输出摘要行，不打 body）"
foreach ($zenName in $zenResolved.Keys) {
    Write-Host "[proxy] zen    $zenName = $($zenResolved[$zenName])"
}
if ($zenMissing.Count -gt 0) {
    Write-Host "[proxy] zen    未定位到: $($zenMissing -join ', ')" -ForegroundColor Yellow
}
if ($zenMissing -contains "ZEN_TOOLS_FILE") {
    Write-Host "[proxy] 警告   无 tools 文件 → 无法补齐 canonical read 工具，缺 read 的请求会被上游 403" -ForegroundColor Yellow
    Write-Host "[proxy] 警告   （与 proxy-go 启动期 warn 同语义；调用方自带 read 工具时不受影响）" -ForegroundColor Yellow
}
if ($env:LOG_SENSITIVE_HEADERS -match '^(1|true|yes)$') {
    Write-Host "[proxy] 警告   LOG_SENSITIVE_HEADERS 已开启，authorization 等敏感 header 将以明文写入日志" -ForegroundColor Yellow
}
Write-Host "[proxy] 另开一个终端运行 scripts\start-opencode.ps1"
Write-Host ""

& node (Join-Path $projectRoot "proxy.js")
