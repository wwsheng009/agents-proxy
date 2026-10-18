# 架构与根因

## 1. 背景：端点迁移

OpenCode v2.0.29 → v2.0.32 期间：

- `#55680` 把 Console/Go 端点按协议重组：
  - `/inference/v1/chat/completions` → `/inference/openai/v1/chat/completions`
  - `/inference/v1/messages` → `/inference/anthropic/v1/messages`
  - `/inference/v1/models/*` → `/inference/google/v1beta/models/*`
  - `/inference/v1/systemone` → `/inference/systemone/v1/systemone`
  - Go 侧：`/inference/go/openai/v1/*`、`/inference/go/anthropic/v1/*`
- 客户端从 `https://models.opencode.ai/api.json` 读取 `provider.api`，
  并直接作为 `settings.baseURL`。
- 2026-10-18 实测 live catalog：
  - `opencode.api = https://opencode.ai/inference/openai/v1`
  - `opencode-go.api = https://opencode.ai/inference/go/openai/v1`

## 2. 第一次 403：路径与匿名凭据

- 客户端实际请求 `/inference/...`；
- 匿名 `Bearer public` 直连 `/inference/*` 返回 403；
- Console 兼容层 `/zen/*` 会在转发到新推理后端前**剥掉匿名凭据**；
- 因此代理必须把所有新/旧路径统一重写回 `/zen/*`。

本项目的 `src/rewrite.ts` 完整复刻了这个反向映射。

## 3. 第二次 403：Bun 1.3.14 TLS/HTTP2 指纹门

2026-10-18 12:01 起，即使路径/headers/body 全部正确，仍然 403。

用官方 `opencode-ai@1.19.3` 客户端捕获真实请求（headers + 33KB body），
再用不同客户端重放：

| 出站客户端 | 结果 |
|---|---|
| Python `urllib` | 403 FreeTierError |
| Go `net/http` | 403 FreeTierError |
| Bun **1.4.3** `fetch` | 403 FreeTierError |
| Bun **1.3.14** `fetch` | **200 + SSE** |

进一步用 Bun 1.3.14 测试：

| 组合 | 结果 |
|---|---|
| 最小 body + 代理当前 headers | **200** |
| 最小 body + 官方 headers | **200** |
| 完整捕获 body + 代理 headers | **200** |

结论：

- 代理的 headers/body 没有问题；
- 上游拒绝的是 **TLS/HTTP2 指纹**；
- 只有 Bun **1.3.14** 的 ClientHello/HTTP2 特征能通过；
- 因此本项目直接在 Bun 1.3.14 中运行，不再让 Go 出站。

## 4. 单进程请求流程

```
客户端
  │  POST /v1/chat/completions
  ▼
Bun.serve (:8788)
  │
  ├─ OPTIONS / healthz
  ├─ rewritePath(url.pathname)
  │    /v1/*、/inference/*、旧 /inference/v1/* → /zen/*
  ├─ pickSession(headers)
  │    x-opencode-session-id → x-session-affinity → x-session-id → ...
  ├─ SessionStore.map(key)
  │    原生 ses_ 透传；否则 SQLite 稳定映射
  ├─ makeId("msg_", false)
  ├─ fixupBody(body, targetPath)
  │    stream:true + stream_options + read 工具
  ├─ buildUpstreamHeaders(...)
  │    UA / 四个 session 头 / client / project / trace
  └─ fetch("https://opencode.ai" + targetPath, ...)
       │  Bun 1.3.14 TLS/HTTP2
       ▼
     /zen/*（Console 兼容层：剥匿名凭据并转发）
       ▼
     新推理后端
       ▼
     SSE 原样流式返回客户端
```

## 5. 身份头

上游注入：

```http
authorization: Bearer public
user-agent: opencode/latest/2.0.32/cli
x-opencode-session: ses_...
x-opencode-session-id: ses_...
x-session-affinity: ses_...
x-session-id: ses_...
x-opencode-client: cli
x-opencode-project: global
x-opencode-request: msg_...
traceparent: 00-<32hex>-<16hex>-01
b3: <32hex>-<16hex>-1-<16hex>
accept-encoding: identity
```

客户端自带的 `x-opencode-*` / 会话头会被丢弃后统一注入；
`cookie` 等普通头保留。

## 6. 会话 ID 算法

复刻 `packages/schema/src/identifier.ts`：

```
ID = prefix + 12 hex（timestamp*0x1000+counter 的低 48 位） + 14 base62
ses_ = 降序（取反）
msg_ = 正序
```

正则：

```
^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$
```

`src/identifier.ts` 与官方算法逐字节一致（同毫秒 counter 自增）。

## 7. 会话映射

`session_map` 表：

```sql
CREATE TABLE session_map (
  incoming_key     TEXT PRIMARY KEY,
  upstream_session TEXT NOT NULL UNIQUE,
  created_at_ms    INTEGER NOT NULL,
  last_seen_ms     INTEGER NOT NULL,
  hits             INTEGER NOT NULL DEFAULT 1
);
```

- 入站 key 按 `config.json` 的 `session.headers` 顺序匹配；
- 值已是合法 `ses_` 且 `passthroughNative=true` → 原样透传；
- 否则同一个 key 稳定映射到同一条 `ses_`；
- 都没有 → `fallbackKey`（默认 `default`），无会话客户端共享一条 `ses_`。

> 建议客户端发送唯一 `X-Opencode-Session-Id`，避免共用 `default` 导致的
> 缓存/限流耦合。

## 8. body 修正

仅对 `/zen/*/chat/completions`：

- 强制 `stream: true`；
- `stream_options.include_usage = true`；
- `tools` 缺少 `read` 时前插 canonical `read` 工具；
- 保留客户端自有 tools、`system`、`messages`、`generation` 参数。

`/responses`、`/messages` 只做路径/头改写，不改 body。

## 9. 为什么不再需要二次代理

| 方案 | 进程 | 出站 TLS | 本地转发 |
|---|---|---|---|
| Go 代理 + Bun forwarder | 2 | Bun 1.3.14 | Go → 127.0.0.1:8898 → Bun |
| 本项目 | **1** | Bun 1.3.14 | 无 |

本项目直接在 Bun 的 `fetch` 中出站，路径/头/body 也在同一进程完成，
因此没有二次代理、没有额外端口、没有本地转发开销。

如果出站需要走网络代理（例如本机 Mihomo/Clash），用 `proxy.url` 或
`HTTP(S)_PROXY` 即可：它是同一个 `fetch` 调用上的 `proxy` 选项，
仍然只有一个进程、一个端口（观测见 `X-Proxy-Via` / `/healthz`）。
受 Bun 1.3.14 限制只支持 http/https，细节见
[limitations.md §6.1](./limitations.md)。

## 9.1 运行态 403 与 watchdog

2026-10-18 观测到另一种 403：同一份代码、同一个 Bun 1.3.14，长生命周期
进程在连续 416 次 200 后开始连续 403；重启进程立即恢复。对照实验：

- 同一时刻用新 Bun 1.3.14 进程直连上游（同会话/新会话、带/不带
  `x-opencode-request`）全部 200；
- 旧进程 8788 对新会话也 403；
- 重启旧进程后立即 200。

因此这类 403 不是请求内容问题，而是进程运行态问题。`RuntimeState`
只统计响应体为 `FreeTierError` 的 403，并在 `/healthz` 暴露
`upstream_403_streak`；达到阈值后外部 watchdog 先做一次“新进程直连”
探测，只有探测通过且代理仍 `degraded` 时才重启。上游整体故障（探测也失败）
时不会反复重启。

## 10. 限制

完整清单见 [limitations.md](./limitations.md)。摘要：

- 必须 Bun 1.3.14；1.4.x 会被上游 403。
- 强制上游流式，当前不把 SSE 组装回 JSON；非流式客户端请用
  `opencode-proxy-go` 或后续补充 translate。
- 代理无鉴权，默认只监听 `127.0.0.1`。
- `listen` 解析使用最后一个 `:`，暂不支持 `[::1]:8788`。
- 出站代理仅支持 http/https（无 SOCKS5），不读 `ALL_PROXY`；
  环境变量与 `proxy` 配置冲突时拒绝启动（见 limitations.md §6.1）。

## 11. 参考

- 完整实验与证据链：`../opencode-proxy-go/docs/06-bun-tls-fingerprint.md`
- 端点迁移与路由矩阵：`../opencode-proxy-go/docs/01-version-change-impact.md`
- 根因与代码修复：`../opencode-proxy-go/docs/02-root-cause-and-fix.md`
- 验证与排查：`../opencode-proxy-go/docs/03-verification-and-troubleshooting.md`
