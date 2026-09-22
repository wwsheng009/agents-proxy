# opencode-proxy

一个无第三方依赖的 Node.js 本地请求观测代理，用于调试自己有权访问的 OpenCode 流量。

## 快速开始

推荐用两个脚本分别在两个终端运行。

终端 1 —— 生成证书（如缺失）、配置环境并启动代理：

```powershell
cd E:\projects\ai\opencode-proxy
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\start-proxy.ps1
```

终端 2 —— 配置代理环境变量并启动 opencode（参数原样透传）：

```powershell
cd E:\projects\ai\opencode-proxy
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\start-opencode.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\start-opencode.ps1 --model <模型>
```

`start-opencode.ps1` 启动前会检查代理健康；代理未运行会提示并以退出码 1 结束。

脚本默认值：

| 脚本 | 环境变量 | 默认值 |
|---|---|---|
| `start-proxy.ps1` | `PORT` / `HTTPS_PORT` | `8787` / `8788` |
| `start-proxy.ps1` | `TARGET_BASE_URL` | `https://opencode.ai` |
| `start-proxy.ps1` | `LOG_FILE` | `<项目根>\proxy.log` |
| `start-proxy.ps1` | `LOG_BODY` | `false` |
| `start-proxy.ps1` | `LOG_SENSITIVE_HEADERS` | `false`（开启后 authorization 等以明文写入日志） |
| `start-opencode.ps1` | `PROXY_PORT` | `8787` |
| `start-opencode.ps1` | `NO_PROXY_EXTRA` | 追加到 `NO_PROXY` 的地址 |

手动方式（不使用脚本）：

```powershell
npm start
```

默认监听：

```text
http://127.0.0.1:8787
```

默认转发到：

```text
https://opencode.ai
```

健康检查：

```powershell
curl http://127.0.0.1:8787/__proxy/health
```

## 反向代理示例

```powershell
$env:TARGET_BASE_URL = "https://opencode.ai"
$env:PORT = "8787"
node proxy.js
```

然后把允许配置 base URL 的客户端指向：

```text
http://127.0.0.1:8787
```

## 标准代理示例

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:8787"
$env:HTTPS_PROXY = "http://127.0.0.1:8787"
$env:NO_PROXY = "localhost,127.0.0.1"
```

## 生成本地证书

生成只用于本机调试的 CA、服务器证书和私钥：

```powershell
cd E:\projects\ai\opencode-proxy
npm run cert
```

生成文件：

```text
certs/ca.pem       # 本地 CA，可加入客户端信任列表
certs/server.crt    # HTTPS 监听使用的服务器证书
certs/server.key    # 服务器私钥，禁止提交或分享
```

## 启用 HTTPS 反向代理

```powershell
$env:HTTPS_PORT = "8788"
$env:TLS_KEY_FILE = "E:\projects\ai\opencode-proxy\certs\server.key"
$env:TLS_CERT_FILE = "E:\projects\ai\opencode-proxy\certs\server.crt"
$env:TARGET_BASE_URL = "https://opencode.ai"
$env:PORT = "8787"
node proxy.js
```

验证：

```powershell
curl --cacert E:\projects\ai\opencode-proxy\certs\ca.pem https://127.0.0.1:8788/__proxy/health
```

如果报 `schannel: the revocation status is unknown`，是 Windows Schannel 对本地 CA 做吊销检查失败（本地 CA 没有 CRL/OCSP），不是证书链错误。仅在本机调试时可以跳过吊销检查：

```powershell
curl --ssl-no-revoke --cacert E:\projects\ai\opencode-proxy\certs\ca.pem https://127.0.0.1:8788/__proxy/health
```

不要在访问外部或生产服务时使用 `--ssl-no-revoke`。

如果 Windows 的 `curl` 使用 Schannel 并提示本地 CA “吊销状态未知”，可用 Node.js 做严格验证：

```powershell
node -e "const https=require('https'),fs=require('fs');https.get({host:'127.0.0.1',port:8788,path:'/__proxy/health',ca:fs.readFileSync('certs/ca.pem')},r=>{r.resume();r.on('end',()=>console.log(r.statusCode))}).on('error',e=>{console.error(e);process.exit(1)})"
```

如果客户端是 Node.js，并且需要访问该本地 HTTPS 端点：

```powershell
$env:NODE_EXTRA_CA_CERTS = "E:\projects\ai\opencode-proxy\certs\ca.pem"
```

标准 `HTTPS_PROXY` 的 `CONNECT` 仍然是盲隧道；证书和 `HTTPS_PORT` 只用于本代理自己的 HTTPS 反向监听，不会自动解密第三方 HTTPS 流量。

## Body 日志

默认只记录结构摘要，不记录原文：

```powershell
$env:LOG_BODY = "false"
```

需要查看 body 预览时：

```powershell
$env:LOG_BODY = "true"
$env:MAX_PREVIEW_CHARS = "4000"
$env:LOG_SENSITIVE_HEADERS = "true"  # 明文记录 authorization，仅供本机学习/调试
node proxy.js
```

`Authorization`、API key、Cookie 等敏感 header 默认会被脱敏。

## 保存请求日志到文件

代理默认只打印到终端，进程退出后日志就没了。用 `LOG_FILE` 追加写入文件：

```powershell
$env:LOG_FILE = "E:\projects\ai\opencode-proxy\proxy.log"
node proxy.js
```

日志是 JSON Lines 格式，每行一条 JSON 记录。

## OpenCode 自身保存的数据

上面的 `proxy.log` 是**代理**记录的请求。OpenCode 自己保存的是会话和日志，不是原始 HTTP 请求：

```text
%USERPROFILE%\.local\share\opencode\log\          # 运行日志
%USERPROFILE%\.local\share\opencode\storage\      # session/ message/ 等会话数据
%USERPROFILE%\.local\share\opencode\opencode.db   # SQLite 数据库
```

OpenCode 不保存最终发出的原始请求 header/body；要看这部分必须经过代理或抓包。

## 文档

- 完整设计、限制和合规说明见 [方案.md](./方案.md)。
- `x-opencode-session` 生成算法与免费额度准入校验的逆向分析（24 针判别实验）见 [分析-会话标识与免费额度校验.md](./分析-会话标识与免费额度校验.md)。
- 请求全量参数/header、ID 唯一性机制与脚本映射见 [请求参数与Header说明.md](./请求参数与Header说明.md)。
