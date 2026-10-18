# opencode-proxy-bun 文档

> 单进程 Bun 1.3.14 / 1.4.x 的 OpenCode 免费道代理。沉淀 2026-10-18 的端点迁移、
> 两次 403 根因、Bun 指纹门与最终的单进程方案。

## TL;DR

- OpenCode 客户端从 live catalog 读取 `provider.api`，用作 `baseURL`；
  2026-10-18 已变为 `https://opencode.ai/inference/openai/v1`。
- 匿名免费道只有 Console 兼容层 `/zen/*` 能过准入；代理把所有
  `/inference/*`、裸 `/v1/*`、旧 `/inference/v1/*` 统一重写回 `/zen/*`。
- 上游随后收紧 **Bun/TLS/HTTP2 指纹与出口 IP 准入**；远程复验 Bun
  **1.3.14 / 1.4.2 / 1.4.3** 均可返回 200，早期“只有 1.3.14”结论已被修正。
- 本项目用一个 Bun 1.3.14 / 1.4.x 进程同时完成：
  路径改写、会话映射、v2 身份头、body 修正、出站 TLS、SSE 回传。
- 相比 `opencode-proxy-go` + Bun forwarder，**少一个进程/端口/二次转发**。
- 匿名免费层额度是**全局/每日**的（`Retry-After` 指向 00:00 UTC）；
  429 不是代理错误，等待或使用真实 `OPENCODE_API_KEY`。

## 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](./architecture.md) | 端点迁移、两次 403 根因、Bun 指纹门修正、单进程设计、ID/会话/头/body 细节 |
| [operations.md](./operations.md) | Bun 1.3.14/1.4.x 安装、配置、运行、systemd、远程部署、日志、升级回滚、排查、安全 |
| [migration-from-go.md](./migration-from-go.md) | 从 `opencode-proxy-go` + forwarder 迁移到本项目、并行运行、差异与回滚 |
| [limitations.md](./limitations.md) | **限制项单一来源**：Bun 版本、SSE-only、无鉴权、IPv6、SQLite、配置、额度、上游指纹变更 |

## 限制（摘要）

完整清单见 [limitations.md](./limitations.md)，要点：

- 支持 **Bun 1.3.14+ / 1.4.x**；1.5+ 未验证；
- 始终返回 **SSE**，当前不做 SSE→JSON 组装；
- 代理**无鉴权**，只监听 `127.0.0.1`；
- 只有 `session_map`，没有 `message_map` / `request_log`；
- 配置是 JSON，不支持 `strip_prefix` / `inject_template`；
- 匿名免费额度是**全局/每日**的，换 IP/服务器/session 无效；
- 上游指纹可能再次变化，升级 Bun 前必须重新验证。

## 关键判读

| 现象 | 含义 | 处理 |
|---|---|---|
| 启动退出：Bun 版本不符 | 不是 1.3.14+ / 1.4.x | 安装受支持版本，或用 `BUN_BIN` 指定 |
| `403 FreeTierError` | 未过准入：路径、UA、session、匿名凭据、TLS 指纹、出口 IP | 先看 `bun --version` 是否在范围；再看 `X-Proxy-Via`；官方客户端也 403 时查出口 IP |
| 长时间运行后突然连续 `403 FreeTierError` | 旧进程运行态失效，重启即恢复 | 看 `/healthz` 的 `upstream_403_streak`；由 `watchdog` 自动重启 |
| `429 FreeUsageLimitError` | 已过准入，匿名额度/限流 | 按 `Retry-After` 等待，或真实 key |
| `410 ModelDeprecated` | 模型退役 | 换 live catalog 中可用的 free 模型 |
| `502 proxy_error` | 上游网络/DNS/TLS 失败 | 检查网络、上游、`/healthz` |
| 所有请求共用 session | 客户端没有发会话头，落到 `default` | 客户端加 `X-Opencode-Session-Id` |

## 相关历史文档

`opencode-proxy-go/docs/` 保留了完整的事件复盘、实验记录和远程部署细节：

- `01-version-change-impact.md`
- `02-root-cause-and-fix.md`
- `03-verification-and-troubleshooting.md`
- `04-client-version-pinning-and-git.md`
- `05-remote-deployment.md`
- `06-bun-tls-fingerprint.md`

本项目是其结论的**单进程实现**；上面的历史文档作为证据链保留。
