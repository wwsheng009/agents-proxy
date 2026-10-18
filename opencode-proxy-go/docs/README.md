# opencode-proxy-go 文档

> 本目录记录 **2026-10-18 OpenCode 端点迁移事件**的版本影响、根因、解决方案、
> 验证过程与排查手册。所有结论均来自本仓库代码、`opencode-v2` 源码与真实上游探针。

## TL;DR

- OpenCode 客户端从 live catalog（`https://models.opencode.ai/api.json`）读取 provider 的
  `api` 字段，并把它直接当作 `settings.baseURL`。
- 2026-10-18 实测 live catalog 已把：
  - `opencode.api` 从 `https://opencode.ai/zen/v1` 改为 **`https://opencode.ai/inference/openai/v1`**
  - `opencode-go.api` 从 `https://opencode.ai/zen/go/v1` 改为 **`https://opencode.ai/inference/go/openai/v1`**
- 匿名免费道（`Bearer public`）**直连 `/inference/*` 会返回 403 `FreeTierError`**；
  只有 Console 兼容层 `/zen/v1/*`（以及 `/zen/go/v1/*`）会剥掉匿名凭据并转发到新推理后端。
- 因此代理的正确行为是：**把所有新 `/inference/*` 地址、以及裸 `/v1/*`、旧 `/inference/v1/*`
  统一反向重写回 `/zen/*`**，再注入 v2 身份头。
- 修复后，客户端 baseURL `http://127.0.0.1:8788/v1/chat/completions` 的请求从
  **403 FreeTierError** 变为 **429 FreeUsageLimitError**（已过准入，仅触发免费额度限流）。
- 远程华为云服务器（`<server>`）实测同样 429：匿名免费额度是**全局/每日重置**，
  `Retry-After` 指向 **00:00 UTC（08:00 CST）**；换服务器/IP 不能绕过。
- **会话头修复**：OpenCode 客户端实际发送 `x-opencode-session-id` / `x-session-affinity`；
  代理旧 `session.headers` 未收录这两个头，导致所有请求共用 `default → ses_...`
  （历史 `hits=2561`）。现已在 `config.yaml` 中补齐，日志显示
  `session_via=x-opencode-session-id`。
- **第二次 403（2026-10-18 12:01 起）**：上游收紧了 **Bun/TLS/HTTP2 指纹与出口 IP 准入**。
  同机早期对照：Go / Python / Bun 1.4.x 都 403，Bun **1.3.14** 才 200。
  后续华为云远程复验：Bun **1.4.2 / 1.4.3** 也返回 200；sidecar 启动脚本现接受
  `1.3.14+ / 1.4.x`。详见 [06](./06-bun-tls-fingerprint.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-version-change-impact.md](./01-version-change-impact.md) | OpenCode v2.0.29 → v2.0.32 的版本变化、端点协议重组、live catalog 变化及影响矩阵 |
| [02-root-cause-and-fix.md](./02-root-cause-and-fix.md) | 403 的完整链路、`inference-proxy.ts` 机制、路由判定矩阵、代码修复方案 |
| [03-verification-and-troubleshooting.md](./03-verification-and-troubleshooting.md) | 静态路由探针、单元测试、真实上游探针、端到端验证、403/429 判读与排查决策树 |
| [04-client-version-pinning-and-git.md](./04-client-version-pinning-and-git.md) | 如何固定特定 OpenCode 客户端版本、git 变化、编译/运行、强制 `/zen/v1` 的配置 |
| [05-remote-deployment.md](./05-remote-deployment.md) | 华为云 Debian 12 远程部署、systemd、SSH 隧道、远程 429/Retry-After 日额度实测 |
| [06-bun-tls-fingerprint.md](./06-bun-tls-fingerprint.md) | 第二次 403：Bun 1.3.14 TLS/HTTP2 指纹门、sidecar 方案、本地/远程验证 |

## 最终结论与时间线

| 时间（CST） | 事件 | 结果 |
|---|---|---|
| 2026-10-18 上午 | 客户端报 `403 FreeTierError`，live catalog 把 `opencode.api` 改为 `/inference/openai/v1` | 定位到端点迁移 + 匿名凭据问题 |
| 同日 | 代理新增 `rewriteInferenceCompat`，把新 `/inference/*`、裸 `/v1/*`、旧 `/inference/v1/*` 统一重写回 `/zen/*` | 单元测试通过 |
| 同日 | 端到端验证：`/v1/chat/completions` 从 403 变为 **429 FreeUsageLimitError** | 准入通过 |
| 同日 | 发现客户端未命中 `session.headers`，所有请求共用 `default → ses_...`（2561 次） | 补齐 `x-opencode-session-id` / `x-session-affinity` |
| 同日 | 切换 Mihomo 香港/日本/美国节点（出口 IP 分别变化） | 仍然 429 → 排除 IP 因素 |
| 同日 | 更换 UA / 模型 / 新 session / project / client | 仍然 429 → 排除这些因素 |
| 2026-10-18 10:38 | 部署到华为云 Debian 12（`<server>`），直连 `opencode.ai` | 仍然 429，`Retry-After: 76869` |
| 2026-10-18 12:01 | 403 复发；官方 1.19.3 客户端仍可用 | 捕获官方真实请求 |
| 同日 12:23 | 完整捕获请求：Go/Python/Bun 1.4.3 重放 403，Bun **1.3.14** 200 | 定位 TLS/HTTP2 指纹门 |
| 同日 12:27 | 本地加入 Bun 1.3.14 `forwarder/` sidecar | 200，`X-Proxy-Via: forwarder:...` |
| 同日 12:31 | 远程部署 sidecar + 新 Go 二进制 | 200 |
| 2026-10-19 08:00 | `Retry-After` 推算的重置点（00:00 UTC） | 匿名日额度重置 |

**一句话：403 是代理路径/准入问题，已修复；429 是匿名免费层的每日额度，已用尽，换 IP/服务器无效。**

## 关键判读（先看这个）

| 现象 | 含义 | 处理 |
|---|---|---|
| `403 FreeTierError` + "can only be used from within OpenCode" | **未过免费层准入**：路径、UA、session 结构、匿名凭据、**TLS/HTTP2 指纹**任一不合规 | 先按 [03](./03-verification-and-troubleshooting.md) 决策树检查；若 headers/body 都正确，检查 [06](./06-bun-tls-fingerprint.md) 的 Bun 1.3.14 forwarder |
| `429 FreeUsageLimitError` | **已过准入**，触发免费额度/限流；若响应带 `Retry-After`，说明是上游明确的重置时间。匿名免费层可能是全局/每日额度，换 IP/session 未必有效 | 按 `Retry-After` 等待（本次为 00:00 UTC / 08:00 CST），或改用真实 `OPENCODE_API_KEY` |
| `410 ModelDeprecated` | 模型已退役 | 换 live catalog 中仍可用的 free 模型 |
| `401` / `5xx` | 鉴权/系统问题，不构成准入证据 | 检查 key、网络、上游状态 |

## 当前代码行为（一句话版）

```
任意客户端
  → http://127.0.0.1:8788/v1/*              （本代理 OpenAI 兼容面）
  → rewriteInferenceCompat + 裸路径改写
  → 127.0.0.1:8898 (Bun 1.3.14 forwarder)   （Go 以明文 HTTP 拨 sidecar）
  → https://opencode.ai/zen/v1/*            （Bun TLS/HTTP2；Console 兼容层剥匿名凭据）
  → 新推理后端 /openai/v1/* 等
```

## 相关文档（上级仓库）

- [`../../docs/分析-opencode-v2指纹与准入.md`](../../docs/分析-opencode-v2指纹与准入.md)
  —— v2 指纹、准入、端点迁移的早期实验记录（部分结论已被 2026-10-18 事件更新）。
- [`../../docs/分析-会话标识与免费额度校验.md`](../../docs/分析-会话标识与免费额度校验.md)
  —— `ses_`/`msg_` 结构与双门准入证据。
- [`../../docs/请求参数与Header说明.md`](../../docs/请求参数与Header说明.md)
  —— 请求头/参数逐项说明。
- [`../../opencode-verify-go/`](../../opencode-verify-go/)
  —— 双门准入的离线/在线验证工具。

## 本次变更清单

| 文件 | 变更 |
|---|---|
| `server.go` | 新增 `rewriteInferenceCompat`；裸 `/v1/*`、旧 `/inference/v1/*`、新 `/inference/*` → `/zen/*`；扩展 `zenLaneRe`/`zenChatRe` |
| `server_test.go` | 新增路径映射 + 免费道识别断言 |
| `config.yaml` | `session.headers` 增加 `x-opencode-session-id` / `x-session-affinity`；UA 更新为 `2.0.32` |
| `config.go` / `proxy.go` / `server.go` | 新增 `forwarder.addr`；Go transport 把 `opencode.ai:*` 拨到 Bun sidecar；`X-Proxy-Via` 显示 forwarder |
| `forwarder/` | Bun 1.3.14 sidecar（`forward.ts`、`run.ps1`、`run.sh`、README） |
| `config.remote.yaml` | 远程部署配置模板（直连、127.0.0.1、Bun forwarder、同目录工具面） |
| `docs/01` ~ `docs/06` | 版本影响、根因、验证排查、客户端版本/git、远程部署、Bun 指纹门 |
| `.gitignore` | 忽略 `proxy-go-linux-amd64` |
