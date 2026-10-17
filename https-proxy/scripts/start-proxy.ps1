# start-proxy.ps1 - 生成证书（如缺失）、配置环境变量并启动本地 HTTP/HTTPS 观测代理。
#
# 用法:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\start-proxy.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\start-proxy.ps1 -Mitm
#
# -Mitm：开启 MITM，CONNECT 后按 SNI 现签证书、在本地解密 HTTPS 并记录明文。
#        客户端必须信任 certs\ca.pem，否则会报证书错误；需要系统有 openssl。
#
# 本脚本只负责「转发 + 记录」的通用观测代理（proxy.js）；opencode 兼容改写由
# 仓库根 proxy-go/ 负责，两者互不依赖。
#
# 可选环境变量（启动前设置）:
#   PORT            HTTP 监听端口，默认 8787
#   HTTPS_PORT      HTTPS 监听端口，默认 8789（证书缺失时自动生成；8788 留给 proxy-go；
#                   端口被占用时自动顺延到下一个空闲端口）
#   TARGET_BASE_URL 反向代理目标；**留空 = 仅标准代理模式**（请求行需带绝对 URL）
#   MITM            等价于 -Mitm（true/false），环境变量方式便于其它脚本调用
#   LOG_FILE        日志文件路径，默认 <https-proxy 目录>\proxy.log；
#                   设为 off / false / none 可关闭文件写入（只输出控制台）
#   LOG_BODY        是否记录完整原始 body 到日志文件（不折叠、不截断），默认 true；
#                   设为 false 则只记字节数与摘要（model/stream/messages/tools 名）；
#                   完整 body 只写入日志文件，控制台永远不会打印 body 内容
#   LOG_STDOUT      控制台是否输出日志摘要行（不含 body），默认 true；
#                   设为 false 后控制台完全静默，日志只写 LOG_FILE
#   LOG_BODY_BASE64 附加 body 的 base64 原样副本（用于二进制/压缩流的完整捕获），默认 true
#   LOG_REDACT_HEADERS     是否脱敏 authorization / cookie / api key 等，默认 false
#                          （默认完整记录，便于端到端观察；日志文件已 gitignore，勿外发）
#
# 代理在前台运行，Ctrl+C 停止。

param(
    [switch]$Mitm
)

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

# 2. 代理自身环境变量（TARGET_BASE_URL 不设默认值：留空即只跑标准代理模式）
$env:PORT = if ($env:PORT) { $env:PORT } else { "8787" }
$env:HTTPS_PORT = if ($env:HTTPS_PORT) { $env:HTTPS_PORT } else { "8789" }
$env:LOG_FILE = if ($env:LOG_FILE) { $env:LOG_FILE } else { Join-Path $projectRoot "proxy.log" }
$env:LOG_BODY = if ($env:LOG_BODY) { $env:LOG_BODY } else { "true" }
$env:LOG_STDOUT = if ($env:LOG_STDOUT) { $env:LOG_STDOUT } else { "true" }
$env:LOG_BODY_BASE64 = if ($env:LOG_BODY_BASE64) { $env:LOG_BODY_BASE64 } else { "true" }
$env:LOG_REDACT_HEADERS = if ($env:LOG_REDACT_HEADERS) { $env:LOG_REDACT_HEADERS } else { "false" }
Remove-Item Env:LOG_SENSITIVE_HEADERS -ErrorAction SilentlyContinue
$env:TLS_KEY_FILE = $keyFile
$env:TLS_CERT_FILE = $crtFile

# 2a. HTTPS 端口占用时自动顺延（8788 常被 proxy-go 占用；HTTPS 反向监听是可选能力）
function Test-LoopbackPortFree([int]$Port) {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) {
            try { $listener.Stop() } catch { }
        }
    }
}

$httpsPort = 0
if ([int]::TryParse($env:HTTPS_PORT, [ref]$httpsPort) -and $httpsPort -gt 0) {
    if (-not (Test-LoopbackPortFree $httpsPort)) {
        $fallbackPort = $null
        for ($candidate = $httpsPort + 1; $candidate -le $httpsPort + 20; $candidate++) {
            if (Test-LoopbackPortFree $candidate) {
                $fallbackPort = $candidate
                break
            }
        }
        if ($fallbackPort) {
            Write-Host "[proxy] HTTPS $httpsPort 已被占用，自动改用 $fallbackPort（可用 HTTPS_PORT 覆盖）" -ForegroundColor Yellow
            $env:HTTPS_PORT = "$fallbackPort"
        } else {
            Write-Host "[proxy] HTTPS $httpsPort 已被占用，且附近端口均不可用；反向监听将不会启用" -ForegroundColor Yellow
        }
    }
}

# 2b. MITM 开关（-Mitm 或环境变量 MITM=true）
if ($Mitm) {
    $env:MITM = "true"
} elseif (-not $env:MITM) {
    $env:MITM = "false"
}
if ($env:MITM -match '^(1|true|yes)$') {
    if (-not (Test-Path (Join-Path $certDir "ca.key"))) {
        Write-Host "[proxy] MITM 需要 CA 私钥 certs\ca.key，当前缺失，正在重新生成证书..." -ForegroundColor Yellow
        & (Get-Command pwsh).Source -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $PSScriptRoot "generate-cert.ps1")
        if ($LASTEXITCODE -ne 0) { throw "证书生成失败" }
    }
    $env:MITM_CA_CERT = $caFile
    $env:MITM_CA_KEY = Join-Path $certDir "ca.key"
}

# 3. 代理进程自己不走代理，避免回环
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue

Write-Host "[proxy] HTTP   http://127.0.0.1:$($env:PORT)"
Write-Host "[proxy] HTTPS  https://127.0.0.1:$($env:HTTPS_PORT)"
if ($env:TARGET_BASE_URL) {
    Write-Host "[proxy] 目标   $($env:TARGET_BASE_URL)（反向代理模式）"
} else {
    Write-Host "[proxy] 目标   未设置 TARGET_BASE_URL → 仅标准代理模式（HTTP_PROXY 绝对 URL）" -ForegroundColor Yellow
}
Write-Host "[proxy] 日志   $($env:LOG_FILE)"
Write-Host "[proxy] LOG_BODY=$($env:LOG_BODY)（true=完整 body 写入日志文件；控制台只输出摘要行，不打 body）"
Write-Host "[proxy] LOG_REDACT_HEADERS=$($env:LOG_REDACT_HEADERS)（false=header 原样记录，含 token/API key）"
if ($env:MITM -match '^(1|true|yes)$') {
    Write-Host "[proxy] MITM   已开启：HTTPS 将在本地解密并记录明文" -ForegroundColor Yellow
    Write-Host "[proxy] MITM   客户端必须信任 $caFile，否则报证书错误" -ForegroundColor Yellow
} else {
    Write-Host "[proxy] MITM   关闭：HTTPS 只记 CONNECT 隧道（加 -Mitm 可解密）"
}
if ($env:LOG_REDACT_HEADERS -notmatch '^(1|true|yes)$') {
    Write-Host "[proxy] 警告   日志将明文记录 authorization / cookie / API key；日志文件含机密，勿提交或外发" -ForegroundColor Yellow
}
Write-Host "[proxy] 另开一个终端运行 ..\scripts\start-opencode.ps1（让 opencode 走本代理）"
Write-Host ""

& node (Join-Path $projectRoot "proxy.js")
