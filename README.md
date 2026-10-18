# opencode-proxy

多个相互独立的本地代理，各管一件事：

| 目录 | 角色 | 语言 |
|---|---|---|
| [`opencode-proxy-bun/`](./opencode-proxy-bun/README.md) | **opencode 免费道单进程代理**（路径改写 + 会话映射 + Bun 1.3.14/1.4.x TLS 指纹），推荐主实现 | Bun |
| [`opencode-proxy-go/`](./opencode-proxy-go/README.md) | opencode 免费道兼容代理（Go；需配合 `forwarder/` 的 Bun sidecar） | Go + Bun |
| [`https-proxy/`](./https-proxy/README.md) | **通用 HTTP/HTTPS 请求观测代理**：只转发、只记录，不改写任何内容 | Node（零依赖） |

> **2026-10-18 重要更新**：上游收紧了 **Bun/TLS/HTTP2 指纹与出口 IP 准入**。
> 远程复验 Bun **1.3.14 / 1.4.2 / 1.4.3** 均可返回 200；早期“只有 1.3.14”结论已修正。
> 本机 403 且官方 OpenCode 也 403 时，优先检查本地出口 IP/网络。
> 推荐使用 [`opencode-proxy-bun/`](./opencode-proxy-bun/README.md)（单进程，无二次代理）；
> Go 方案必须同时启动 [`opencode-proxy-go/forwarder/`](./opencode-proxy-go/forwarder/README.md)。

```text
opencode-proxy/
├── opencode-proxy-bun/   # Bun 1.3.14/1.4.x 单进程代理（推荐）
├── opencode-proxy-go/    # Go 兼容代理（需 forwarder/ 的 Bun sidecar）
│   └── forwarder/        # Bun 1.3.14/1.4.x 出站 sidecar
├── https-proxy/          # 通用 HTTP/HTTPS 观测代理（Node，含本地证书与启动脚本）
├── opencode-verify-go/   # 准入规则离线验证程序（24 针证据表比对 + 可选在线重放）
├── docs/                 # 设计与逆向分析文档
├── scripts/              # 工具脚本：start-opencode.ps1、日志抽取/重放、一次性实验
├── opencode_tools.json   # v2 准入所需的 canonical read 工具面
└── data/                 # 抓包/重放证据产物（本地保留，已 gitignore）
```

> **拆分记录（2026-10-17）**：原先根目录的 Node 单文件 `proxy.js` 同时承担「zen 兼容改写」
> 与「通用观测」两件事。现已拆分——兼容改写只保留在 `opencode-proxy-go/`，观测代理独立到
> `https-proxy/` 且**不再做任何改写**。旧 Node 兼容层实现见 git 历史（提交 `1afd58a`），
> 相关文档中出现的 `proxy.js` 兼容层描述均为该历史实现的记录。

## 快速开始 0：Bun 单进程（推荐）

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-bun
npm install bun@1.4.3 --prefix .bun142
.\run.ps1
```

客户端 base URL：`http://127.0.0.1:8788/v1/chat/completions`。

该方案在**一个 Bun 1.3.14/1.4.x 进程**内完成路径改写、会话映射、header/body 修正和出站 TLS，
没有 Go → Bun 的二次代理。详见
[`opencode-proxy-bun/README.md`](./opencode-proxy-bun/README.md)。

> 已知限制（Bun 1.3.14+/1.4.x、SSE-only、无鉴权、单 SQLite 等）见
> [`opencode-proxy-bun/docs/limitations.md`](./opencode-proxy-bun/docs/limitations.md)。

## 快速开始 1：opencode 兼容代理（opencode-proxy-go）

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-go
go run .                       # 默认 127.0.0.1:8788，读 ./config.yaml，库 ./proxy-go.db
go run . -listen 0.0.0.0:8788  # 局域网可访问
```

任意 OpenAI 兼容客户端把 base URL 指向 `http://127.0.0.1:8788/v1`，api_key 任意，
model 用 `-free` 结尾的模型（如 `deepseek-v4.1-flash-free`）：

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "content-type: application/json" \
  -H "x-session-id: my-app-session-42" \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

代理在转发时统一补齐 v2 准入要素：端点 `/v1/*`、`/inference/*` → `/zen/*`、`Bearer public`、
四段 UA、四个会话头 + `traceparent`/`b3`、强制 `stream:true`、tools 缺 `read` 时前插 canonical 工具。
**2026-10-18 起上游收紧 Bun TLS/HTTP2 指纹与出口 IP 准入，Go 方案必须先启动
[`opencode-proxy-go/forwarder/`](./opencode-proxy-go/forwarder/README.md)（Bun 1.3.14/1.4.x）。**
详见 [`opencode-proxy-go/README.md`](./opencode-proxy-go/README.md)。

匿名免费额度是**全局/每日**的；`429` 按 `Retry-After` 等待，换 IP/服务器/session 无效。

## 快速开始 2：通用观测代理（https-proxy）

```powershell
cd E:\projects\ai\opencode-proxy
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\start-proxy.ps1
```

- HTTP `http://127.0.0.1:8787`、HTTPS `https://127.0.0.1:8789`（证书缺失时自动生成；
  `8788` 默认留给 `opencode-proxy-go`，可用 `HTTPS_PORT` 覆盖）；
- 反向代理：设 `TARGET_BASE_URL` 后把客户端 base URL 指向 `http://127.0.0.1:8787`；
- 标准代理：`HTTP_PROXY`/`HTTPS_PROXY` 指向 `http://127.0.0.1:8787`；
- 日志为 JSON Lines，按 `id` 串起 request / response / response_body / error 四个阶段。

让 opencode 走这个观测代理（另开一个终端）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\start-opencode.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\start-opencode.ps1 --model <模型>
```

注意：标准 `HTTPS_PROXY` 的 `CONNECT` 是**盲隧道**，不解密 TLS；要看 HTTPS 明文请用
反向代理模式。详见 [`https-proxy/README.md`](./https-proxy/README.md)。

### 让 WorkBuddy AI 走本代理

```powershell
# 1) 启动（HTTPS 监听在 8789，MITM 解密）
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\start-proxy.ps1 -Mitm

# 2) 安装 CA 到系统信任库，并同步进 WorkBuddy 自己的 CA bundle
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\trust-ca.ps1

# 3) 完全退出并重启 WorkBuddy，代理设置填 https://127.0.0.1:8789
```

WorkBuddy 的代理由自己的 `settings.json`（`http.proxy`）驱动；它的 daemon 通过
`.workbuddy-ai\system-ca-bundle.pem` 信任 CA，且该文件只在缺失时生成——这就是
`trust-ca.ps1` 存在的原因。完整机制、端口协议对照与排障见
[`https-proxy/docs/workbuddy.md`](./https-proxy/docs/workbuddy.md)。

## 文档

> 全部设计与逆向分析文档收录在 [`docs/`](./docs/README.md)，附总索引与阅读顺序。

- 完整设计、限制和合规说明见 [方案.md](./docs/方案.md)（记录的是拆分前 Node 单文件代理的设计）。
- opencode v2（v2.0.29）请求指纹、`/inference/v1` 端点迁移、v2 准入规则全解与代理适配记录见
  [分析-opencode-v2指纹与准入.md](./docs/分析-opencode-v2指纹与准入.md)。
- `x-opencode-session` 生成算法与免费额度准入校验的逆向分析（24 针判别实验）见
  [分析-会话标识与免费额度校验.md](./docs/分析-会话标识与免费额度校验.md)。
- 请求全量参数/header、ID 唯一性机制与脚本映射见 [请求参数与Header说明.md](./docs/请求参数与Header说明.md)。
- 逆向全过程总账：时间线、踩坑清单、成功请求三扇门完整要求见 [过程与坑.md](./docs/过程与坑.md)。
- Go 版准入规则验证程序见 [opencode-verify-go/](./opencode-verify-go/README.md)。
- 一次性实验脚本索引见 [scripts/experiments/](./scripts/experiments/README.md)。

## 合规

本项目仅用于调试**自己有权访问**的客户端与上游服务，用于理解请求结构、排查兼容性问题。
不用于伪造第三方客户端身份或绕过 free-tier / 配额 / 授权限制。日志可能含 token 与个人信息，
默认脱敏，请勿外发。
