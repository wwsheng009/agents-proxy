# opencode-proxy-go —— opencode 免费道独立代理服务（Go，v2 兼容层）

单二进制 HTTP 代理：让**任意程序**以 OpenAI 兼容方式接入 opencode 免费道，
代理在转发时统一改写为 **opencode v2 准入**所需的身份 header 与 body，
并把「入站会话 → 上游会话」的对应关系做**稳定映射 + 缓存 + SQLite 持久化**。

> 功能基准是拆分前仓库根目录的 Node 版 `proxy.js`（`ZEN_COMPAT`，2026-10-17 拆分后已移除，
> 代码见 git 历史提交 `1afd58a`；通用观测部分现独立为 [`../https-proxy/`](../https-proxy/README.md)）。
> v2 指纹与准入的实验证据、端点迁移、毒头结论见
> [`../docs/分析-opencode-v2指纹与准入.md`](../docs/分析-opencode-v2指纹与准入.md)；
> ID 算法证据见 `../docs/分析-会话标识与免费额度校验.md` 与 `../opencode-verify-go/`。

## v2 与 1.x 的关键差异（本代理已全部对齐）

| 维度 | 1.x（已失效） | v2（现行，本代理行为） |
|---|---|---|
| 端点 | `POST /zen/v1/chat/completions` | `POST /inference/v1/chat/completions`（`/v1/*`、裸 OpenAI/Gemini 路径自动改写；旧 `/zen/v1/*` 仍接受但上游已锁死） |
| UA | `opencode/<semver>` | `opencode/<channel>/<version>/<artifact>`（`opencode/latest/2.0.29/cli`） |
| 会话头 | 仅 `x-opencode-session` | 会话 ID 同步到 4 个头：`x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id` |
| 链路头 | 无 | `traceparent`（W3C）+ `b3`（Zipkin），每请求新生成 |
| `x-opencode-request`（msg_） | 可选 | **毒头**：带上即 403。入站一律剥离，且**绝不注入上游** |
| `body.stream` | 必须 true | **必须 true**（`stream:false` → 403） |
| `body.tools` | 12 工具白名单且 ≥2 个 | **必须含名为 `read` 的 opencode 工具**（名称匹配即可；schema/顺序不限，可与自有工具混用） |
| `system` 内容 | 必须含真实模板 | **完全不校验** → v2 模式不再注入任何模板 |
| 鉴权 | `Bearer public` | 保留 `Bearer public` |

## 工作方式

```
其它程序 ──HTTP──▶ opencode-proxy-go(:8788) ──改写 header/body──▶ https://opencode.ai/inference/v1
                     │
                     ├─ 端点改写：/v1/* → /inference/v1/*；/v1beta/models → /inference/v1/models
                     ├─ session key（session.headers 按序匹配，缺失→fallback 桶；
                     │    可配原生 x-opencode-session 入口，值合法则原样透传）
                     │    └─ 同一 key 永远 → 同一条上游 ses_（内存缓存 → SQLite）
                     ├─ message key（message.headers 按序匹配，可缺）
                     │    ├─ 带 key：稳定映射（按会话分域，落库）
                     │    └─ 不带  ：每请求新生成 msg_（仅审计/观测，不上行）
                     ├─ 注入 v2 身份头：authorization / user-agent / 四个会话头 / traceparent + b3
                     │    （客户端自带的一切 x-opencode-* / 会话头 / 毒头先丢弃再统一注入）
                     └─ body 修正（仅道内 chat 端点）：强制 stream:true + 补齐 read 工具
```

ID 算法 = `packages/schema/src/identifier.ts` 复刻：`prefix + 12位hex(时间低48位,
ses 降序) + 14位base62`，同毫秒 counter 自增；与原 JS 实现黄金向量逐字节一致
（`identifier_test.go`）。

## 快速开始

```powershell
cd opencode-proxy-go
go run .                      # 默认 127.0.0.1:8788，读 ./config.yaml，库 ./proxy-go.db
go run . -listen 0.0.0.0:8788 # 局域网可访问
go run . -config other.yaml -upstream https://opencode.ai -db D:\data\proxy.db
```

其它程序接入（session 由你方任意取值，代理负责稳定映射）：

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "content-type: application/json" \
  -H "x-session-id: my-app-session-42" \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

- 上游 URL 由 `upstream` 决定：默认 `https://opencode.ai`，`/v1/chat/completions`
  自动改写为 `/inference/v1/chat/completions`。**不要**把 `upstream` 写成 `…/zen`。
- 响应头 `x-proxy-session` / `x-proxy-request` 可看到实际使用的上游 ID
  （`x-proxy-request` 仅审计/观测，msg_ 不再上行）。
- 流式（`"stream":true`）逐块即写即刷，`[DONE]` 与尾部 cost 块原样透传；
  非流式调用方由代理强制上游流式后**组装回 JSON**（对外契约不变）。
- 入口 header 可配置（`session.headers` / `message.headers` 顺序匹配多个候选）；
  直接传原生 `x-opencode-session` 也可以——值已符合上游结构时**原样透传**
  （见 `passthrough_native`），否则照常稳定重映射。

## 出站代理（`proxy`，支持 http/https/socks5）

只作用于「本代理 → 上游 opencode.ai」这一段；客户端连本代理的入站链路不变。
http / https / socks5 / socks5h 四种 scheme 由 Go `net/http` 原生实现，无需额外依赖
（`socks5` 与 `socks5h` 等价，均在代理端解析域名）。认证可内嵌在 URL。

```yaml
proxy:
  url: "http://127.0.0.1:10810"   # 也可 socks5://user:pass@127.0.0.1:1080
  no_proxy: ["localhost", "127.0.0.1", ".internal", "10.0.0.0/8"]
  from_env: true                  # url 为空时回退 HTTP_PROXY/HTTPS_PROXY/NO_PROXY
```

```powershell
go run . -proxy http://127.0.0.1:10810        # CLI 覆盖配置
go run . -proxy socks5://127.0.0.1:1080
```

- `url` 留空 = 不使用显式代理；此时 `from_env: true`（默认）仍会读取
  `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（与改造前行为一致）；`from_env: false`
  则强制直连。
- `no_proxy` 命中即绕过代理，支持 `*`、域名（含子域）、`host:port`、IP、CIDR。
- 非法 scheme / 地址会在启动自检（`Config.Validate`）阶段直接报错退出。

### 怎么确认代理真的生效

「配置了」不等于「真的走了」。按证据强度从弱到强：

1. **启动日志**：`INFO upstream proxy resolved configured=… no_proxy=[] from_env=true`
   —— 只证明配置被解析、判定函数已挂到 transport 上。
2. **每条请求日志**：`INFO proxy … status=200 upstream_proxy=http://127.0.0.1:10810 …`
   —— `upstream_proxy=direct` 表示这次直连（含 `no_proxy` 命中）。
3. **响应头 `X-Proxy-Via`**：与上一条同源，直接回显本次转发使用的代理地址（`direct` = 未走代理）。
   已加入 CORS `Access-Control-Expose-Headers`，浏览器调用方也能读到。
4. **`GET /healthz`**：返回 `proxy_configured` / `proxy_no_proxy` / `proxy_from_env` /
   `proxy_effective`，其中 `proxy_effective` 是对真实 upstream 做一次判定后的结果。
5. **外部实证（最强）**：在代理端看连接日志；或把 `proxy.url` 指向一个不可达地址
   —— 若请求立即以 `502 upstream request failed` 失败，说明确实经过代理；若仍 200，说明没走。

注意：`proxy.url` 留空且 `from_env: true` 时，生效代理来自 `HTTP_PROXY`/`HTTPS_PROXY`
环境变量，`proxy_effective` 会显示该值。

## v2 body 自动修正（`body_fixup.mode: v2`，默认）

`../scripts/experiments/bisect/bisect-body*.js` / `bisect-headers.js` 单变量实验（见
`../docs/分析-opencode-v2指纹与准入.md` §三）证明 v2 只要求 body 满足两条：

1. `"stream": true`（`stream:false` → 403）；
2. `tools` 含一个 `name="read"` 的 opencode 工具（名称匹配即可，schema 可改、
   可与任意自有工具混用；缺 `read` 时外来工具再多也 403）。

`mode: v2` 时代理自动：

- 顶层补/改 `"stream":true`；调用方原本非流式 → 响应侧把上游 SSE **组装回 JSON**
  （usage/cost/tool_calls 保留）；
- `tools` 缺 `read` 时把 `../opencode_tools.json` 里的 canonical `read` 工具**前插**，
  调用方自有工具字节与顺序不变；已有 `read` 则不动 `tools`；
- `reasoning_effort` 归一化为上游支持的 `none/low/medium/high`
  （`max/xhigh`→`high`，`minimal`→`low`，未知值移除，避免 500）；
- **不注入任何 system 模板**（v2 不校验 system，注入只会拖慢并污染响应）。

修正只作用于**道内 chat 端点**（`/…/chat/completions`）的 JSON 对象请求体；
`/v1/models` 等 GET 或非 JSON body 在 `injectOrderedV2` 解析失败即原样透传、不报错。

> `mode: inject_template` 是遗留的 1.x「门③」规则（模板注入 + 12 工具白名单），
> 对现行上游一律 403，仅作存档对照，默认不再启用。

## 端点

| 路径 | 说明 |
|---|---|
| `*`（catch-all） | 转发到 `{upstream}{path}`（可先 `strip_prefix`） |
| `POST /v1/chat/completions` | → `/inference/v1/chat/completions`，走 v2 头组 + body 修正 |
| `GET /v1/models`、`/v1beta/models` | → `/inference/v1/models`，同样注入 v2 兼容头（返回上游模型列表） |
| `GET /healthz` | 存活检查 |
| `GET /_sessions` | 查看映射（incoming/upstream/hits/last_seen，默认最近 200 条） |

## SQLite（`db_path`）

| 表 | 内容 |
|---|---|
| `session_map` | incoming_key → upstream_session（UNIQUE，1:1 稳定；hits/last_seen） |
| `message_map` | (session_key, incoming_key) → upstream_message（按会话分域） |
| `request_log` | 每次转发审计：时间/路径/两端 session+msg/状态/耗时（`keep_days` 自动清理） |

内存缓存启动时预载，重启后映射不变（`store_test.go` 覆盖）。

## 配置（config.yaml）

关键项：`listen` / `upstream` / `db_path` / `strip_prefix` /
`session.headers`+`fallback_key`+`passthrough_native` / `message.headers`+`passthrough_native` /
`upstream_headers.{user_agent,authorization,client,project}` /
`proxy.{url,no_proxy,from_env}` /
`body_fixup.{mode,template_file,agent_template_file,tools_file}` /
`log.{requests,keep_days}`。
CLI `-listen` `-upstream` `-db` `-proxy` 可覆盖同名配置。默认只监听 `127.0.0.1`；
对外暴露前请自行加认证/防火墙（`_sessions` 是内部观测面）。

## 验证

```powershell
gofmt -l . ; go vet ./... ; go test ./...
```

测试全部离线（httptest 假上游）：稳定映射、重启持久、伪造 header 替换、
v2 头组（四会话头同步 + traceparent/b3 + 毒头剥离）、v2 body 修正
（强制 stream / 前插 read / 保留调用方工具）、SSE/错误透传、CORS、路径拼接、
ID 黄金向量与结构唯一性、SSE→JSON 组装、入口 header 优先级与原生 ID 透传。

端到端（真实上游，需联网）：

```bash
curl http://127.0.0.1:8788/inference/v1/chat/completions \
  -H "content-type: application/json" \
  -H "x-session-id: e2e" \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"Say ok"}]}'
# → 200 {"choices":[{"message":{"content":"ok"},...}],"usage":{...}}
```

免费额度按 IP 限流（200 请求/天），429 `FreeUsageLimitError` 表示配额耗尽，
等窗口重置即可；非 free 付费模型需真实 Zen key（代理对付费道做纯透传）。
