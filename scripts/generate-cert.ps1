param(
    [string]$OutDir = (Join-Path $PSScriptRoot "..\certs"),
    [int]$ValidDays = 825
)

$ErrorActionPreference = "Stop"

if ($ValidDays -lt 1) {
    throw "ValidDays must be positive"
}

$resolvedOutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $resolvedOutDir | Out-Null

$caCertPath = Join-Path $resolvedOutDir "ca.pem"
$serverCertPath = Join-Path $resolvedOutDir "server.crt"
$serverKeyPath = Join-Path $resolvedOutDir "server.key"

function Export-CertPem([System.Security.Cryptography.X509Certificates.X509Certificate2]$cert, [string]$path) {
    $der = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    $base64 = [Convert]::ToBase64String($der)
    $lines = [System.Text.StringBuilder]::new()
    [void]$lines.AppendLine("-----BEGIN CERTIFICATE-----")
    for ($i = 0; $i -lt $base64.Length; $i += 64) {
        $length = [Math]::Min(64, $base64.Length - $i)
        [void]$lines.AppendLine($base64.Substring($i, $length))
    }
    [void]$lines.AppendLine("-----END CERTIFICATE-----")
    [System.IO.File]::WriteAllText($path, $lines.ToString())
}

$notBefore = [DateTimeOffset]::UtcNow.AddDays(-1)
$notAfter = [DateTimeOffset]::UtcNow.AddDays($ValidDays)

# Local CA used only by this debugging proxy.
$caRsa = [System.Security.Cryptography.RSA]::Create(2048)
$caRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=opencode-proxy local CA",
    $caRsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$caRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $true, 0, $true)
)
$caRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign,
        $true
    )
)
$caRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false)
)

$caCert = $caRequest.CreateSelfSigned($notBefore, $notAfter)

# Leaf certificate for the local HTTPS reverse-proxy listener.
$serverRsa = [System.Security.Cryptography.RSA]::Create(2048)
$serverRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=localhost",
    $serverRsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$serverRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
)
$serverRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,
        $true
    )
)
$serverAuthOid = [System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1")
$serverAuthOids = [System.Security.Cryptography.OidCollection]::new()
[void]$serverAuthOids.Add($serverAuthOid)
$serverRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($serverAuthOids, $false)
)

$sanBuilder = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$sanBuilder.AddDnsName("localhost")
$sanBuilder.AddIpAddress([System.Net.IPAddress]::Loopback)
$sanBuilder.AddIpAddress([System.Net.IPAddress]::IPv6Loopback)
$serverRequest.CertificateExtensions.Add($sanBuilder.Build($false))
$serverRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($serverRequest.PublicKey, $false)
)

$serial = [byte[]]::new(16)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($serial)
$rng.Dispose()
$serverCert = $serverRequest.Create($caCert, $notBefore, $notAfter, $serial)

Export-CertPem $caCert $caCertPath
Export-CertPem $serverCert $serverCertPath
$exportKeyMethod = $serverRsa.GetType().GetMethods() |
    Where-Object { $_.Name -eq "ExportPkcs8PrivateKeyPem" -and $_.GetParameters().Count -eq 0 } |
    Select-Object -First 1
if (-not $exportKeyMethod) {
    throw "This PowerShell runtime does not support RSA.ExportPkcs8PrivateKeyPem()"
}
$keyPem = [string]$exportKeyMethod.Invoke($serverRsa, @())
[System.IO.File]::WriteAllText($serverKeyPath, $keyPem + [Environment]::NewLine)

Write-Host "Generated local debugging certificates:"
Write-Host "  CA:     $caCertPath"
Write-Host "  Cert:   $serverCertPath"
Write-Host "  Key:    $serverKeyPath"
Write-Host ""
Write-Host "Use only on this machine. Do not commit or share the private key."
