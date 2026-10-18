# opencode-proxy-bun

**单进程 Bun 1.3.14 / 1.4.x 的 OpenCode 免费道代理。**

把路径改写、会话映射、v2 身份头、body 修正和出站 TLS/HTTP2 都放在同一个
Bun 进程里，避免 `opencode-proxy-go` 的「Go 代理 + Bun sidecar」二次代理。

> **支持 Bun 1.3.14 与 1.4.x。**
> 已在远程服务器实测：Bun 1.3.14、1.4.2、1.4.3 都能通过上游准入并返回 200。
> `src/index.ts` 会在启动时检查版本，只接受 `1.3.14+` 与 `1.4.x`，拒绝未验证的
> `1.5+` / `2.x`，避免未来 Bun 升级静默改变 TLS/HTTP2 指纹。

## 为什么独立成一个项目

之前为了绕过指纹门，采用了两段式：

```
客户端 → opencode-proxy-go(:8788) → 明文 HTTP → Bun sidecar(:8898) → opencode.ai
```

这虽然可用，但多了一个进程、一个端口和一次本地转发。本项目把 Go 代理的逻辑
完整搬到 Bun：

```
客户端 → opencode-proxy-bun(:8788) → Bun 1.3.14/1.4.x fetch → opencode.ai
```

- 少一个进程/端口；
- 不再有 Go ↔ Bun 的二次代理；
- 路径改写、session 映射、header/body 修正、SSE 流式回传都在一个进程内完成；
- 仍然使用已验证的 Bun 1.3.14 / 1.4.x TLS/HTTP2 指纹。

## 快速开始

### 1. 准备 Bun（1.3.14 或 1.4.x）

```powershell
# Windows（二选一；项目内固定版本，不影响全局 bun）
npm install bun@1.3.14 --prefix .bun1314
.\.bun1314\node_modules\bun\bin\bun.exe --version   # 1.3.14

npm install bun@1.4.3 --prefix .bun142
.\.bun142\node_modules\bun\bin\bun.exe --version    # 1.4.3

# 也可以直接指定已有二进制
$env:BUN_BIN = "C:\path\to\bun.exe"

# Linux（远程）：安装 1.3.14 或 1.4.x 均可
npm install -g bun@1.4.3
bun --version
```

### 2. 启动

```powershell
cd opencode-proxy-bun
bun run start
# 或使用固定版本：
.\.bun1314\node_modules\bun\bin\bun.exe run src/index.ts
```

推荐用带守护的启动方式（连续 403 时先探测上游，再自动重启本地进程）：

```powershell
.\run.ps1
```

裸启动（不启用 watchdog）：`$env:NO_WATCHDOG = "1"; .\run.ps1`。

默认监听 `127.0.0.1:8788`，读取 `./config.json`，SQLite 库 `./proxy.db`。

### 3. 客户端接入

任意 OpenAI 兼容客户端：

```
baseURL: http://127.0.0.1:8788/v1/chat/completions
apiKey:  任意（代理会注入 Bearer public）
model:   big-pickle / deepseek-v4.1-flash-free / ...
```

如果 `opencode-proxy-go` 仍在 8788 运行，先用 `LISTEN` 换端口：

```powershell
$env:LISTEN = "127.0.0.1:8790"
bun run start
```

### 4. 验证

```powershell
curl.exe -sS http://127.0.0.1:8788/healthz
curl.exe -sS -X POST http://127.0.0.1:8788/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "X-Opencode-Session-Id: quick-start-1" `
  --data-binary '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

预期：`200` + SSE，响应头：

```
X-Proxy-Session: ses_...
X-Proxy-Request: msg_...
X-Proxy-Via: direct            # 配置出站代理后为代理地址
```

## 架构

```
客户端
  │  POST /v1/chat/completions
  ▼
opencode-proxy-bun (:8788)
  ├─ rewritePath：/v1/*、/inference/*、旧 /inference/v1/* → /zen/*
  ├─ pickSession：x-opencode-session-id / x-session-affinity / ... → 上游 ses_
  ├─ buildUpstreamHeaders：UA / 四个 session 头 / client / project / trace
  ├─ fixupBody：强制 stream:true + 注入 read 工具 + stream_options
  ├─ outbound：可选出站代理（proxy.url / HTTP_PROXY），响应头观测实际路由
  └─ fetch（Bun 1.3.14 / 1.4.x TLS/HTTP2）
        ▼
     https://opencode.ai/zen/v1/*   （Console 兼容层，匿名凭据在此被剥离）
        ▼
     新推理后端 /openai/v1/* 等
```

## 路径改写

| 入站 | 上游 |
|---|---|
| `/v1/*` | `/zen/v1/*` |
| `/v1beta/models*` | `/zen/v1/models*` |
| `/inference/v1/*` | `/zen/v1/*` |
| `/inference/openai/v1/*` | `/zen/v1/*` |
| `/inference/anthropic/v1/*` | `/zen/v1/*` |
| `/inference/systemone/v1/*` | `/zen/v1/*` |
| `/inference/google/v1beta/models/*` | `/zen/v1/models/*` |
| `/inference/go/openai/v1/*` | `/zen/go/v1/*` |
| `/inference/go/anthropic/v1/*` | `/zen/go/v1/*` |
| `/inference/go/systemone/v1/*` | `/zen/go/v1/*` |
| `/inference/go/v1/*` | `/zen/go/v1/*` |
| `/zen/*` | 原样 |

## 请求头与 body

### 注入上游的身份头

- `authorization: Bearer public`（可配置）
- `user-agent: opencode/latest/2.0.32/cli`
- `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id`
- `x-opencode-client: cli`
- `x-opencode-project: global`
- `x-opencode-request: msg_...`
- `traceparent` + `b3`（每请求新生成）
- `accept-encoding: identity`

客户端自带的 `x-opencode-*` / 会话头会被丢弃，由代理统一注入。

### body 修正（仅 chat/completions）

- 强制 `stream: true`；
- 补充 `stream_options: { include_usage: true }`；
- `tools` 缺少 `read` 时前插 canonical `read` 工具（保留客户端自有工具）；
- 其它字段（`messages`、`system`、`max_tokens`、`temperature`、`reasoning_effort` 等）原样保留。

## 会话映射

入站 session key 按 `config.json` 的 `session.headers` 顺序匹配：

```
x-opencode-session-id
x-session-affinity
x-session-id
x-opencode-session
x-session
```

- 值已符合 `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` 且 `passthroughNative=true` → 原样透传；
- 否则在 SQLite `session_map` 中做稳定映射：同一个入站 key 永远对应同一条上游 `ses_`；
- 都没有 → `fallbackKey`（默认 `default`），此时所有无会话客户端共享一条 `ses_`。

> 建议客户端发送唯一的 `X-Opencode-Session-Id` / `X-Session-Id`，避免共用 `default`。

## 配置

`config.json`（所有字段都有默认值，可只写要覆盖的项）：

```json
{
  "listen": "127.0.0.1:8788",
  "upstream": "https://opencode.ai",
  "dbPath": "proxy.db",
  "session": {
    "headers": [
      "x-opencode-session-id",
      "x-session-affinity",
      "x-session-id",
      "x-opencode-session",
      "x-session"
    ],
    "fallbackKey": "default",
    "passthroughNative": true
  },
  "upstreamHeaders": {
    "userAgent": "opencode/latest/2.0.32/cli",
    "authorization": "Bearer public",
    "client": "cli",
    "project": "global"
  },
  "bodyFixup": { "mode": "v2" },
  "log": { "requests": true },
  "proxy": { "url": "", "noProxy": [], "fromEnv": true },
  "watchdog": { "enabled": true, "failureThreshold": 3, "probeIntervalMs": 30000 }
}
```

环境变量覆盖：

| 变量 | 作用 |
|---|---|
| `CONFIG` | 配置文件路径（默认 `config.json`） |
| `LISTEN` | 监听地址，如 `127.0.0.1:8790` |
| `UPSTREAM` | 上游 base URL |
| `DB_PATH` | SQLite 路径；`:memory:` 可用于测试 |
| `WATCHDOG_ENABLED` | `1`/`0`，是否把连续 403 标为 `degraded` |
| `WATCHDOG_FAILURE_THRESHOLD` | 标记 `degraded` 的连续 403 次数 |
| `PROXY_URL` | 覆盖 `proxy.url`（对应 Go 的 `--proxy`），如 `http://127.0.0.1:10810` |
| `PROXY_NO_PROXY` | 覆盖 `proxy.noProxy`，逗号分隔，如 `*.internal,10.0.0.0/8` |
| `PROXY_FROM_ENV` | `1`/`0`，覆盖 `proxy.fromEnv` |

## 出站代理（可选）

只影响「本代理 → 上游」这一段；入站客户端到本代理的连接不受影响。

```json
"proxy": {
  "url": "http://127.0.0.1:10810",
  "noProxy": ["*.internal", "10.0.0.0/8"],
  "fromEnv": false
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `url` | `""` | 代理地址。支持 `http://` / `https://`，认证可内嵌（`http://user:pass@host:port`）。留空 = 不配显式代理 |
| `noProxy` | `[]` | 直连名单：`*` / 域名（含子域）/ `host:port` / IP / CIDR。仅 `url` 非空时生效 |
| `fromEnv` | `true` | `url` 为空时是否读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（大小写均可） |

生效观测：

- 响应头 `X-Proxy-Via`：实际生效的代理地址（已去凭据）；直连为 `direct`；
- `/healthz` 的 `proxy` 段：`configured` / `no_proxy` / `from_env` / `effective`；
- 请求日志末尾的 `via=`。

Bun 1.3.14 / 1.4.x 的限制（详见 [limitations.md](./docs/limitations.md)）：

- 只支持 `http` / `https` 代理，**不支持 SOCKS5**（配置 `socks5://` 会在启动时报错）；
- **不读 `ALL_PROXY`**，只认 scheme 对应的 `HTTP_PROXY` / `HTTPS_PROXY`；
- 代理环境变量在进程启动时读取并缓存，运行期修改 `process.env` 无效；因此
  `fromEnv=false` 且环境变量非空、或 `url` + `noProxy` 同时存在且环境变量非空时，
  启动会直接报错，而不是静默走错路径。

## 健康检查与观测

```bash
curl http://127.0.0.1:8788/healthz
# {"status":"ok","bun":"1.4.3","upstream":"https://opencode.ai","sessions":N,
#  "proxy":{"configured":"","no_proxy":[],"from_env":true,"effective":"direct"},
#  "upstream_403_streak":0,"last_upstream_log_id":null,...}
```

连续 `FreeTierError` 达到阈值时 `status` 变为 `degraded`；
`watchdog.ps1`/`watchdog.sh` 据此触发“探测上游 → 必要时重启”。
如果 `/healthz` 完全不可用（进程退出/卡死），watchdog 会直接重启本地进程，
不受上游探测结果影响。

每个响应带：

- `X-Proxy-Session`：上游 `ses_`
- `X-Proxy-Request`：上游 `msg_`
- `X-Proxy-Via`：实际生效的出站代理地址；直连为 `direct`

## 测试

```powershell
bun test
```

当前 87 个测试，覆盖：

- 路径改写（新 `/inference/*`、裸 `/v1/*`、旧 `/inference/v1/*`、`/zen/*`）；
- `ses_`/`msg_` 算法（格式、唯一性、升降序）；
- 上游身份头（UA、四个 session 头、client/project、trace、客户端头剥离）；
- body 修正（stream、stream_options、read 注入、保留自有工具）；
- SQLite 会话映射（稳定映射、原生透传、关闭透传）；
- 出站代理（scheme 校验、no_proxy 匹配含 CIDR、from_env 解析、冲突检测、观测值）。

## 与 Go 项目的关系

| | `opencode-proxy-go` + forwarder | `opencode-proxy-bun`（本项目） |
|---|---|---|
| 进程数 | 2（Go + Bun） | **1（Bun）** |
| 出站 TLS | Bun sidecar | Bun 1.3.14 / 1.4.x 直接出站 |
| 出站代理 | `proxy.url` / `no_proxy` / `from_env`，支持 socks5 | 同左，但仅 http/https，无 SOCKS5（见限制） |
| 路径/头/body | Go | Bun |
| 客户端 baseURL | `:8788/v1/chat/completions` | 同左（drop-in） |
| 非流式客户端 | Go 会把 SSE 组装回 JSON | 当前始终返回 SSE（见「限制」） |

迁移步骤见 [`docs/migration-from-go.md`](./docs/migration-from-go.md)。

## 部署

Linux systemd 单元见 [`deploy/opencode-proxy-bun.service`](./deploy/opencode-proxy-bun.service)；
安装、远程部署、日志、排查见 [`docs/operations.md`](./docs/operations.md)。

```bash
# 远程目录示例
/opt/opencode-proxy-bun/
├── bun-1.3.14/bun   # 或 bun-1.4.x/bun
├── src/
├── config.json
├── package.json
└── proxy.db
```

```bash
systemctl enable --now opencode-proxy-bun
systemctl status opencode-proxy-bun --no-pager
journalctl -u opencode-proxy-bun -f
```

## 限制

完整清单见 [`docs/limitations.md`](./docs/limitations.md)。要点：

- **仅支持 Bun 1.3.14+ / 1.4.x**：1.5+、2.x 未验证，`src/index.ts` 会拒绝启动。
- **始终返回 SSE**：代理会强制上游 `stream:true`；当前没有把 SSE 组装回 JSON。
  OpenCode 客户端使用流式请求，不受影响；非流式客户端请继续使用
  `opencode-proxy-go`（它会 translate SSE → JSON），或后续在本项目补充。
- **代理无鉴权**：默认只监听 `127.0.0.1`，不要直接暴露公网。
- **IPv6 监听**：`listen` 解析使用最后一个 `:`，暂不支持 `[::1]:8788` 这种写法。
- **只有 `session_map`**：没有 `message_map` / `request_log`；请求日志走 stdout/journald。
- **配置是 JSON**：不支持 `strip_prefix` / `inject_template`；只有 `bodyFixup.mode: "v2" | "off"`。
- **出站代理限 http/https**：不支持 SOCKS5；不读 `ALL_PROXY`；环境变量在启动时缓存，冲突配置会拒绝启动。
- **匿名额度是全局/每日的**：429 按 `Retry-After` 等待；换 IP、服务器、session 都无效。
- **无重试 / 熔断 / 模型列表缓存**：上游错误原样或 502 返回。
- **上游准入可能再次变化**：升级 Bun 或切换网络前必须重新验证。

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即退出，提示 Bun 版本 | 不是 1.3.14+ / 1.4.x | 安装受支持的 Bun，或用 `BUN_BIN` 指定 |
| `403 FreeTierError` | TLS 指纹/路径/UA/session/出口 IP 不合规 | 先确认 `bun --version` 在支持范围；再看 `X-Proxy-Via`；官方客户端也 403 时检查出口 IP |
| `429 FreeUsageLimitError` | 已过准入，匿名额度/限流 | 按 `Retry-After` 等待，或配置真实 `OPENCODE_API_KEY` |
| `502 proxy_error` | 上游网络/DNS/TLS/代理失败 | 检查网络与代理；看 `/healthz` 的 `proxy.effective` 与日志 `via=` |
| 启动即退出，提示 proxy 冲突 | 环境变量与 `fromEnv=false` / `url+noProxy` 冲突 | 清空 `HTTP(S)_PROXY` 后重启，或改用 `proxy.url` / `fromEnv=true` |
| 所有请求共用 session | 客户端没发会话头，落到 `default` | 客户端加 `X-Opencode-Session-Id`，或清 `session_map` 的 `default` 行 |

## 安全

- 只监听 `127.0.0.1`；需要远程访问用 SSH 隧道：
  ```powershell
  ssh -L 18788:127.0.0.1:8788 root@<server>
  ```
- 不要提交 `config.json` 中的真实 `OPENCODE_API_KEY`。
- 如果使用真实 key，建议通过环境变量/密钥管理注入，而不是写入仓库。

## 目录结构

```
opencode-proxy-bun/
├── config.json
├── package.json
├── tsconfig.json
├── run.ps1 / run.sh
├── deploy/
│   └── opencode-proxy-bun.service
├── docs/
│   ├── README.md
│   ├── architecture.md
│   ├── operations.md
│   ├── limitations.md
│   └── migration-from-go.md
└── src/
    ├── index.ts          # 入口 + Bun 版本检查
    ├── config.ts         # 配置加载
    ├── proxy.ts          # 请求编排 + Bun fetch + SSE 回传
    ├── outbound.ts       # 出站代理（解析/no_proxy/from_env/观测）
    ├── runtime.ts        # 403 连续计数与 watchdog 状态
    ├── rewrite.ts        # /inference/*、/v1/* → /zen/*
    ├── headers.ts        # v2 身份头
    ├── body.ts           # stream/read/stream_options
    ├── identifier.ts     # ses_/msg_ 算法
    ├── session.ts        # SQLite 会话映射
    ├── tools.ts          # canonical read 工具
    └── *.test.ts         # bun test
```
