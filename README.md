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

### OpenCode Zen 免费道兼容（v2，已打通）

当目标是 `opencode.ai` 时，`proxy.js` 会自动把 OpenAI 风格请求改写到 v2 推理端点
（`/inference/v1`），并补齐免费道准入所需的全部要素（2026-10 实验测定，证据见
[分析-opencode-v2指纹与准入.md](./docs/分析-opencode-v2指纹与准入.md) §三）：

- `Bearer public` 鉴权、`opencode/latest/<ver>/cli` 四段 UA；
- v2 算法本地铸造 `ses_` 会话（同调用方 key 稳定映射）+ v2 新头组（`x-opencode-session-id`、
  `x-session-affinity`、`x-session-id`、`traceparent`/`b3`）；**剔除 msg_ 毒头** `x-opencode-request`；
- 强制 `stream:true`（非流式调用方 SSE→JSON 回组）；tools 自动补 opencode `read` 工具（自有工具保留）；
- `reasoning_effort` 值域降级映射；模型列表 `/v1/models`、`/v1beta/models` 均可探测（auto 协议可用）。

设置 `ZEN_COMPAT=false` 恢复纯透传（观测模式，记录真实 v2 客户端流量）。

**使用**：任意 OpenAI 兼容客户端指向 `http://127.0.0.1:8787/v1`，api_key 任意，model 用
`-free` 结尾模型（如 `deepseek-v4.1-flash-free`）。免费额度按 IP 限流（约 200 请求/天），
429 = 配额耗尽，等窗口重置。付费模型需真实 Zen key（纯透传）。

> **2026-10 准入变更记录**：上游已从 `/zen/v1` 迁移到 `/inference/v1`，1.x 三扇门
> （模板+stream+旧 session 算法）全部失效；v2 新规则（read 工具 + stream + v2 session 算法 +
> 禁 msg_ 头）已由本代理完整适配。历史分析与新旧对照见
> [分析-opencode-v2指纹与准入.md](./docs/分析-opencode-v2指纹与准入.md)。

兼容层当前只消费 `opencode_tools.json`（**随仓库自带一份满足准入的最小文件**；路径可用 `ZEN_TOOLS_FILE` 覆盖）：调用方 `tools` 缺 `read` 时，
把其中的 canonical `read` 工具前插；该文件按需读取（首次用到时读一次并缓存），取不到 `read` 时跳过注入
并输出一条 `event=zen_tools_missing` 的 warn（每进程至多一次，与 `proxy-go` 的启动期告警对称；
`start-proxy.ps1` 另会在启动时警示未定位到）。1.x 的 `opencode_system_prompt.txt` 与
`opencode_agent_system_prompt.txt` 已不再注入（v2 无需模板），对应加载函数无调用点，仅为兼容旧配置保留。
这些文件只在命中 `opencode.ai` 的 `/zen/v1/*` 或 `/inference/v1/*`
（`chat/completions`、`responses`、`messages`、`models`）时才会被读取。
注意：该兼容层作用于 HTTP 反向代理请求；标准 `HTTPS_PROXY` 的 `CONNECT`
是盲隧道，无法改写其中的 TLS 请求。其它工具请把 OpenAI base URL 指向本机
HTTP 代理（如 `http://127.0.0.1:8787`）。

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

> 全部设计与逆向分析文档收录在 [`docs/`](./docs/README.md) 目录，附总索引与阅读顺序。

- 完整设计、限制和合规说明见 [方案.md](./docs/方案.md)。
- `x-opencode-session` 生成算法与免费额度准入校验的逆向分析（24 针判别实验）见 [分析-会话标识与免费额度校验.md](./docs/分析-会话标识与免费额度校验.md)。
- **opencode v2（v2.0.29）请求指纹、/inference/v1 端点迁移、v2 准入规则全解（read 工具门 + session 算法 + msg_ 毒头）与代理适配记录**见 [分析-opencode-v2指纹与准入.md](./docs/分析-opencode-v2指纹与准入.md)。
- 请求全量参数/header、ID 唯一性机制与脚本映射见 [请求参数与Header说明.md](./docs/请求参数与Header说明.md)。
- Go 版准入规则验证程序（离线 24 针证据表比对 + 可选在线重放）见 [verify-go/](./verify-go/README.md)。
- 独立 Go 代理服务（v2 兼容层：`/inference/v1` 端点改写、v2 身份头组 + msg_ 毒头剥离、入口 header 可配置、原生 ID 透传、会话稳定映射 + SQLite、v2 body 自动修正）见 [proxy-go/](./proxy-go/README.md)。
- 逆向全过程总账：时间线（P1~P24 / T1~T11 证据编号）、踩坑清单、成功请求三扇门完整要求见 [过程与坑.md](./docs/过程与坑.md)。
- 一次性实验脚本（判别 / 差分 / 重放，按用途归类）索引见 [scripts/experiments/](./scripts/experiments/README.md)。
