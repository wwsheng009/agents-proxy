# 02 · 根因与解决方案

> 对应错误：
> `403 {"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}`

## 1. 完整错误链路

以客户端 baseURL `http://127.0.0.1:8788/v1/chat/completions` 为例：

```
客户端（opencode_proxy / deepseek-v4.1-flash-free）
  │  POST /v1/chat/completions
  ▼
opencode-proxy-go(:8788)
  │  ① 识别 session → 生成上游 ses_
  │  ② resolveTarget：/v1/chat/completions → /inference/v1/chat/completions   ← 旧逻辑
  │  ③ isZenTarget(/inference/v1/...) = true → 注入 UA/session/client/project/trace
  ▼
https://opencode.ai/inference/v1/chat/completions
  │  匿名 Bearer public 直连新推理后端
  ▼
403 FreeTierError
```

这里有两个独立问题叠加：

1. **路径问题**：live catalog 已把客户端推到 `/inference/openai/v1/*`，而代理的
   `zenLaneRe` 只认 `/zen/v1/*` 与 `/inference/v1/*`，新路径不会被识别为免费道。
2. **匿名凭据问题**：即使路径被识别、头也注入了，**直连 `/inference/*` 仍会 403**。
   新推理后端不是匿名公共入口；匿名入口是 Console 兼容层 `/zen/*`。

## 2. 错误文案为什么有误导性

`FreeTierError` 是上游的**兜底错误**，只要以下任一条件不满足就会返回同一句话：

- `x-opencode-session` 结构不合法（`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`）；
- `User-Agent` 解析不出 `opencode/<semver>`，或版本 < 1.18.0；
- 请求走了错误的端点/匿名凭据不被接受。

它**不是**“检测到你不是 OpenCode 客户端”的密码学验证。
本项目的 `docs/分析-会话标识与免费额度校验.md` §0.5 与 `opencode-verify-go/admit.go`
已经用 24 针证据证明了这一点。

## 3. Console 兼容层：`inference-proxy.ts`

`opencode-v2` 仓库中的 `packages/console/app/src/lib/inference-proxy.ts`
是理解新旧路径关系的关键：

```ts
const paths = {
  "POST /zen/v1/chat/completions": "/openai/v1/chat/completions",
  "POST /zen/v1/responses": "/openai/v1/responses",
  "POST /zen/v1/messages": "/anthropic/v1/messages",
  "POST /zen/v1/systemone": "/systemone/v1/systemone",
  "POST /zen/go/v1/chat/completions": "/go/openai/v1/chat/completions",
  "POST /zen/go/v1/responses": "/go/openai/v1/responses",
  "POST /zen/go/v1/messages": "/go/anthropic/v1/messages",
  "POST /zen/go/v1/systemone": "/go/systemone/v1/systemone",
  "GET /zen/v1/models": "/v1/models",
  "GET /zen/go/v1/models": "/go/v1/models",
  "GET /zen/go/v1/usage": "/go/v1/usage",
}
```

关键逻辑：

```ts
const key = url.pathname.endsWith("/messages")
  ? request.headers.get("x-api-key")
  : ... request.headers.get("authorization")?.split(" ")[1]

const anonymous = !key || key === "public"
if (anonymous)
  for (const name of ["authorization", "x-api-key", "x-goog-api-key"])
    forwarded.headers.delete(name)
if (!anonymous) forwarded.headers.set("authorization", `Bearer ${key}`)
```

即：

- `/zen/v1/*` 是**匿名免费道的公共入口**；
- 它会把 `Bearer public` / `x-api-key: public` 剥掉，再通过 Cloudflare service binding
  转发到新推理后端；
- 新推理后端 `owns authentication, model availability, free-tier access, and billing`。

**所以：匿名场景下，`/inference/*` 直连不是正确入口，`/zen/*` 才是。**

## 4. 路由判定矩阵（代理真实代码）

用 `resolveTarget` + `isZenTarget` 跑出的结果（修复前）：

| 入站路径 | 改写后 | `zen` |
|---|---|---|
| `/v1/chat/completions` | `/inference/v1/chat/completions` | ✅ true |
| `/zen/v1/chat/completions` | 原样 | ✅ true |
| `/inference/v1/chat/completions` | 原样 | ✅ true |
| `/zen/go/v1/chat/completions` | 原样 | ❌ false |
| `/inference/openai/v1/chat/completions` | 原样 | ❌ false |
| `/inference/anthropic/v1/messages` | 原样 | ❌ false |
| `/inference/google/v1beta/models/...` | 原样 | ❌ false |
| `/inference/go/openai/v1/chat/completions` | 原样 | ❌ false |
| `/inference/systemone/v1/systemone` | 原样 | ❌ false |

`zen=false` → `buildPassthroughHeaders` → **不注入** UA/session/client/project/trace，
也不做 body fixup，直接 403。

## 5. 真实上游探针（修复前）

使用完整 v2 身份头（四个 session 头、client/project、traceparent、b3、真实生成的 `ses_`）
与 `Authorization: Bearer public`：

| 路径 | 状态 | 错误类型 |
|---|---|---|
| `POST /zen/v1/chat/completions` | **429** | `FreeUsageLimitError`（已过准入，限流） |
| `POST /inference/v1/chat/completions` | **403** | `FreeTierError` |
| `POST /inference/openai/v1/chat/completions` | **403** | `FreeTierError` |
| `POST /inference/anthropic/v1/messages` | **403** | `FreeTierError` |
| `POST /inference/openai/v1/chat/completions`（不带 Authorization） | **403** | `FreeTierError` |
| `POST /inference/openai/v1/chat/completions`（Bearer dummy） | **403** | `FreeTierError` |

结论：

- 路径不是唯一判据，但 `/inference/*` 匿名直连确实不放行；
- `/zen/*` 才过准入；
- **只把新路径加进 `zenLaneRe` 并不够**，必须重写回 `/zen/*`。

## 6. 修复方案

### 6.1 核心思路

> 把“客户端从 live catalog 拿到的新地址”反向映射回“Console 兼容层的公共入口”，
> 让 Console 兼容层负责匿名凭据剥离与后端转发；代理只负责路径归一化 + v2 身份头。

### 6.2 `rewriteInferenceCompat()`

在 `server.go` 中新增（`resolveTarget` 调用）：

```go
func rewriteInferenceCompat(path string) string {
	for _, m := range []struct{ from, to string }{
		{"/inference/go/openai/v1/", "/zen/go/v1/"},
		{"/inference/go/anthropic/v1/", "/zen/go/v1/"},
		{"/inference/go/systemone/v1/", "/zen/go/v1/"},
		{"/inference/go/v1/", "/zen/go/v1/"},
		{"/inference/google/v1beta/models/", "/zen/v1/models/"},
		{"/inference/openai/v1/", "/zen/v1/"},
		{"/inference/anthropic/v1/", "/zen/v1/"},
		{"/inference/systemone/v1/", "/zen/v1/"},
		{"/inference/v1/", "/zen/v1/"}, // 旧 v2 通道，匿名直连已 403
	} {
		if strings.HasPrefix(path, m.from) {
			return m.to + strings.TrimPrefix(path, m.from)
		}
	}
	return path
}
```

### 6.3 `resolveTarget()` 的裸路径改写

```go
if p.cfg.ZenCompat && u.Hostname() == "opencode.ai" {
	u.Path = rewriteInferenceCompat(u.Path)
	if !strings.HasPrefix(u.Path, "/zen/") && !strings.HasPrefix(u.Path, "/inference/") {
		switch {
		case v1PathRe.MatchString(u.Path):
			u.Path = "/zen" + u.Path                    // /v1/* → /zen/v1/*
		case v1betaModelsRe.MatchString(u.Path):
			u.Path = "/zen/v1/models"                   // /v1beta/models → /zen/v1/models
		case bareLaneRe.MatchString(u.Path):
			u.Path = "/zen/v1" + strings.TrimSuffix(u.Path, "/")
		}
	}
}
```

> 注意：这里把**裸 `/v1/*` 与旧 `/inference/v1/*` 都改成 `/zen/*`**。
> 仅改 `/inference/openai/v1` 是不够的——客户端 baseURL 是 `/v1/chat/completions` 时仍会 403。

### 6.4 免费道正则

```go
zenLaneRe = regexp.MustCompile(
	`/(?:zen/(?:go/)?v1|inference/v1)/(?:chat/completions|responses|messages|systemone|usage|models)` +
	`(?:/[^/]+(?::(?:generateContent|streamGenerateContent))?)?/?$`)
zenChatRe = regexp.MustCompile(`/(?:zen/(?:go/)?v1|inference/v1)/chat/completions/?$`)
```

覆盖：

- `/zen/v1/*`（主免费道）；
- `/zen/go/v1/*`（opencode-go）；
- `/inference/v1/*`（自建镜像/重放兼容）；
- `systemone`、`usage`；
- Google 模型 `models/<id>:generateContent` / `:streamGenerateContent`。

### 6.5 改写后的判定矩阵（修复后）

| 入站路径 | 改写后 | `zen` |
|---|---|---|
| `/v1/chat/completions` | `/zen/v1/chat/completions` | ✅ |
| `/v1/models` | `/zen/v1/models` | ✅ |
| `/v1beta/models` | `/zen/v1/models` | ✅ |
| `/inference/v1/chat/completions` | `/zen/v1/chat/completions` | ✅ |
| `/inference/openai/v1/chat/completions` | `/zen/v1/chat/completions` | ✅ |
| `/inference/anthropic/v1/messages` | `/zen/v1/messages` | ✅ |
| `/inference/google/v1beta/models/<id>:generateContent` | `/zen/v1/models/<id>:generateContent` | ✅ |
| `/inference/go/openai/v1/chat/completions` | `/zen/go/v1/chat/completions` | ✅ |
| `/zen/go/v1/chat/completions` | 原样 | ✅ |

## 7. 为什么不能只扩展 `zenLaneRe`

如果只把 `/inference/openai/v1/*` 加进 `zenLaneRe`：

- 代理会注入身份头；
- 但请求仍然直连 `/inference/openai/v1/*`；
- 真实探针显示：即使完整头 + `Bearer public` + 真实 `ses_`，仍然 **403**；
- 因此必须重写到 `/zen/*`，让 Console 兼容层处理匿名凭据。

## 8. 边界与注意事项

- **只对 `opencode.ai` 生效**：`rewriteInferenceCompat` 在 `u.Hostname() == "opencode.ai"`
  分支内调用，自建镜像/重放不受影响。
- **`upstream` 保持站点根**：`https://opencode.ai`，不要写成 `.../zen` 或 `.../inference`。
- **`Bearer public` 不需要删**：重写到 `/zen/*` 后，Console 兼容层会自动剥离；
  但若将来改为直连 `/inference/*`，必须在匿名时删掉 `Authorization`/`x-api-key`。
- **body fixup 只对 chat/completions 生效**：`zenChatRe` 控制 `stream:true` + `read` 工具注入；
  `/responses` 与 `/messages` 只做头改写。
- **Google 模型路径**：`models/<id>:generateContent` 需要单独的正则分支，旧规则只匹配到 `models`。
- **限流与准入是两回事**：429 不是失败，是“已过准入但额度/频率受限”。

## 9. 后续修复：session 头与限流归因

403 修复后，客户端仍返回 429。继续排查发现两件事：

### 9.1 会话头未收录

OpenCode 客户端实际发送：

```ts
"x-opencode-session-id": session.id,
"x-session-affinity": affinity,
"X-Session-Id": affinity,
"x-opencode-session": affinity,
```

旧 `session.headers` 只收录了 `x-session-id` / `x-opencode-session` / `x-session`，
导致请求全部落到 `fallback_key: default`，共用同一条上游 `ses_`（实测 `hits=2561`）。

修复：在 `config.yaml` 的 `session.headers` 前置加入
`x-opencode-session-id` / `x-session-affinity`，重启后日志显示
`session_via=x-opencode-session-id`。

### 9.2 429 是全局/每日额度

单变量实验（新 session、不同模型、香港/日本/美国/华为云 IP、UA、project/client）
全部 429；远程服务器响应带：

```
Retry-After: 76869
Date: Sun, 18 Oct 2026 02:38:51 GMT
```

推算重置点为 **2026-10-19 00:00:00 UTC（08:00 CST）**。
因此 429 不是路径/准入问题，而是匿名免费层的每日额度用尽；
换 IP/服务器/session 不能绕过，等待或使用真实 `OPENCODE_API_KEY` 才有用。

详细实验数据见 [03-verification-and-troubleshooting.md](./03-verification-and-troubleshooting.md)
§11/§12，远程部署见 [05-remote-deployment.md](./05-remote-deployment.md)。
