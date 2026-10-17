# trust-ca.ps1 - 把本地观测代理的 CA 安装到当前用户信任库，并同步 WorkBuddy 的 CA bundle。
#
# 用法:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\trust-ca.ps1
#
# 背景:
#   · Node.js 默认不读 Windows 证书库，需要 NODE_EXTRA_CA_CERTS 或 --use-system-ca；
#   · WorkBuddy 启动 daemon 时会设置
#       NODE_EXTRA_CA_CERTS=%USERPROFILE%\.workbuddy-ai\system-ca-bundle.pem
#     该 bundle 由「Windows 根证书库」导出，但只在文件缺失时生成；CA 后装不会自动进 bundle。
#   · 因此这里同时做两件事：导入 CurrentUser\Root + 把 CA 追加进现有 bundle。
#
# 安装后需要完全退出并重启 WorkBuddy（daemon 会继承新的 NODE_EXTRA_CA_CERTS）。

param(
    [string]$CaFile = (Join-Path $PSScriptRoot "..\certs\ca.pem"),
    [string]$WorkBuddyConfigDir = (Join-Path $HOME ".workbuddy-ai"),
    [switch]$SkipSystemStore
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $CaFile)) {
    throw "找不到 CA 证书: $CaFile（先运行 generate-cert.ps1 或 start-proxy.ps1）"
}

$caPath = (Resolve-Path $CaFile).Path
$caPem = [System.IO.File]::ReadAllText($caPath)
$caCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($caPath)
$caIdentity = [Convert]::ToBase64String($caCert.RawData)

Write-Host "[trust-ca] CA: $caPath"
Write-Host "[trust-ca] Subject: $($caCert.Subject)"
Write-Host "[trust-ca] Thumbprint: $($caCert.Thumbprint)"

# 1. 导入当前用户「受信任的根证书颁发机构」
if (-not $SkipSystemStore) {
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
        "Root",
        [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
    )
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
        $exists = $store.Certificates | Where-Object { $_.Thumbprint -eq $caCert.Thumbprint }
        if ($exists) {
            Write-Host "[trust-ca] 系统信任库已存在，跳过导入"
        } else {
            $store.Add($caCert)
            Write-Host "[trust-ca] 已导入 CurrentUser\Root"
        }
    } finally {
        $store.Close()
    }
}

# 2. 把 CA 追加进 WorkBuddy 的 system-ca-bundle.pem（若存在）
$bundlePath = Join-Path $WorkBuddyConfigDir "system-ca-bundle.pem"
if (Test-Path $bundlePath) {
    $bundle = [System.IO.File]::ReadAllText($bundlePath)
    $blocks = [regex]::Matches(
        $bundle,
        '-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----'
    )

    $alreadyThere = $false
    foreach ($block in $blocks) {
        try {
            $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
                [System.Text.Encoding]::ASCII.GetBytes($block.Value)
            )
            if ($cert.Thumbprint -eq $caCert.Thumbprint) {
                $alreadyThere = $true
                break
            }
        } catch {
            # 忽略无法解析的块
        }
    }

    if ($alreadyThere) {
        Write-Host "[trust-ca] WorkBuddy bundle 已包含该 CA，跳过追加"
    } else {
        $block = "-----BEGIN CERTIFICATE-----`n"
        $base64 = [Convert]::ToBase64String($caCert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
        $block += $base64 + "`n-----END CERTIFICATE-----`n"
        if (-not $bundle.EndsWith("`n")) { $bundle += "`n" }
        [System.IO.File]::WriteAllText($bundlePath, $bundle + $block)
        Write-Host "[trust-ca] 已追加到 WorkBuddy bundle: $bundlePath"
    }
} else {
    Write-Host "[trust-ca] 未找到 WorkBuddy bundle（未安装或尚未启动过），跳过"
}

Write-Host ""
Write-Host "[trust-ca] 完成。请完全退出并重启 WorkBuddy，使其 daemon 重新读取 CA bundle。" -ForegroundColor Yellow
Write-Host "[trust-ca] 其它 Node 程序仍需在启动前设置 NODE_EXTRA_CA_CERTS=$caPath（或用 node --use-system-ca）。"
