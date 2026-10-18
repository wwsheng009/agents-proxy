# 03 · 验证过程与排查思路

> 本文记录 2026-10-18 事件中实际执行的验证步骤，可作为后续端点变化的复用手册。

## 1. 验证分层

| 层级 | 目的 | 是否消耗免费额度 |
|---|---|---|
| ① 静态路由探针 | 用代理真实代码确认路径改写与 `isZenTarget` | 否 |
| ② 单元测试 | 固化路径映射、ID 算法、header 注入 | 否 |
| ③ 真实上游探针 | 直接验证 `/zen/*` 与 `/inference/*` 的准入差异 | 是（少量） |
| ④ 端到端 | 通过本地代理用客户端真实 baseURL 验证 | 是（少量） |

## 2. 静态路由探针

在 `opencode-proxy-go` 下临时加一个 `_test.go`（验证后删除）：

```go
func TestTmpRouteProbe(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Upstream = "https://opencode.ai"
	p, _ := NewProxy(&cfg, nil)

	for _, path := range []string{
		"/v1/chat/completions",
		"/zen/v1/chat/completions",
		"/inference/v1/chat/completions",
		"/inference/openai/v1/chat/completions",
		"/inference/anthropic/v1/messages",
		"/inference/google/v1beta/models/gemini-3",
		"/inference/go/openai/v1/chat/completions",
		"/zen/go/v1/chat/completions",
	} {
		r := httptest.NewRequest("POST", "http://local"+path, nil)
		target := p.resolveTarget(r)
		t.Logf("in=%-45s upstream=%-55s zen=%v", path, target.Path, p.isZenTarget(target))
	}
}
```

运行：

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-go
go test -run TestTmpRouteProbe -v
```

修复前的输出（关键行）：

```
in=/v1/chat/completions                  upstream=/inference/v1/chat/completions     zen=true
in=/inference/openai/v1/chat/completions upstream=/inference/openai/v1/...           zen=false
in=/inference/anthropic/v1/messages      upstream=/inference/anthropic/v1/messages   zen=false
in=/inference/go/openai/v1/...           upstream=/inference/go/openai/v1/...        zen=false
in=/zen/go/v1/chat/completions           upstream=/zen/go/v1/chat/completions        zen=false
```

> `zen=false` 意味着走 `buildPassthroughHeaders`，不注入 UA/session，必然 403。

## 3. 单元测试

修复后新增/更新：

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-go
gofmt -l .          # 无输出
go vet ./...        # 通过
go test -count=1 ./...
```

当前结果：

```
ok  	proxy-go	2.065s
```

覆盖点：

- `TestUpstreamURLRewritesInferenceCompat`：
  `/v1/*`、`/v1beta/models`、`/v1/*` 裸路径、`/inference/v1/*`、
  `/inference/openai|anthropic|systemone|google/v1/*`、`/inference/go/*` → `/zen/*`。
- `TestIsZenTargetInferenceCompat`：
  新路径重写后必须被识别为免费道；chat 路径必须匹配 `zenChatRe`。
- `TestUpstreamURLJoin`：`strip_prefix` + query 拼接不受影响。
- 原有 E2E/ID/header 测试：全部保持通过。

## 4. 真实上游探针

### 4.1 请求头

模拟真实 v2 客户端（与 `packages/core/src/session/model-request.ts` 对齐）：

```http
Content-Type: application/json
Accept: text/event-stream
Authorization: Bearer public
User-Agent: opencode/latest/2.0.32/cli
Accept-Encoding: identity
X-OpenCode-Session: ses_<12hex><14base62>
X-OpenCode-Session-Id: ses_<...>
X-Session-Affinity: ses_<...>
X-Session-Id: ses_<...>
X-OpenCode-Client: cli
X-OpenCode-Project: global
traceparent: 00-<32hex>-<16hex>-01
b3: <32hex>-<16hex>-1-<16hex>
```

Body（最小可用）：

```json
{
  "model": "glm-5.3-flash-free",
  "messages": [{"role": "user", "content": "hi"}],
  "stream": true,
  "max_tokens": 8,
  "tools": [{
    "type": "function",
    "function": {
      "name": "read",
      "description": "Read a file from the local filesystem.",
      "parameters": {
        "type": "object",
        "properties": {
          "filePath": {"type": "string"},
          "offset": {"type": "integer"},
          "limit": {"type": "integer"}
        },
        "required": ["filePath"]
      }
    }
  }]
}
```

> `ses_` 可用 `opencode-proxy-go/identifier.go` 的算法生成，
> 或直接写一个结构合法的值（服务端只校验结构，不校验注册/新鲜度）。

### 4.2 结果（2026-10-18）

| 路径 | 状态 | 类型 |
|---|---|---|
| `POST /zen/v1/chat/completions` | **429** | `FreeUsageLimitError` |
| `POST /inference/v1/chat/completions` | **403** | `FreeTierError` |
| `POST /inference/openai/v1/chat/completions` | **403** | `FreeTierError` |
| `POST /inference/anthropic/v1/messages` | **403** | `FreeTierError` |
| `POST /inference/openai/v1/chat/completions`（无 Authorization） | **403** | `FreeTierError` |
| `POST /inference/openai/v1/chat/completions`（Bearer dummy） | **403** | `FreeTierError` |

结论：**匿名免费道只有 `/zen/*` 能过准入**；`/inference/*` 直连不放行。

## 5. 端到端验证

### 5.1 启动代理（临时端口）

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-go
go run . -config config.yaml -listen 127.0.0.1:8799 -db e2e_proxy_tmp.db
```

`config.yaml` 中的出站代理默认是 `http://127.0.0.1:10810`，确保它可用。

### 5.2 用客户端真实 baseURL 请求

```powershell
curl.exe -sS --max-time 90 -X POST "http://127.0.0.1:8799/v1/chat/completions" `
  -H "Content-Type: application/json" `
  -H "X-Session-Id: e2e-v1-path" `
  --data-binary '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}],"max_tokens":8,"reasoning_effort":"max"}' `
  -D - -o resp.txt -w "%{http_code}"
```

### 5.3 修复前 / 修复后

| | 修复前 | 修复后 |
|---|---|---|
| `/v1/chat/completions` | **403 FreeTierError** | **429 FreeUsageLimitError** |
| `/inference/v1/chat/completions` | 403 | **429** |
| `/inference/openai/v1/chat/completions` | 403 | **429** |

响应头中的观测字段：

```
X-Proxy-Session: ses_...
X-Proxy-Request: msg_...
X-Proxy-Via: http://127.0.0.1:10810
```

> 429 不是修复失败：它表示请求已通过免费层准入，只是触发了额度/频率限制。
> 等限流窗口恢复后，同样请求应返回 200。

## 6. 403 / 429 / 410 判读

| 状态 | 错误类型 | 含义 | 下一步 |
|---|---|---|---|
| 403 | `FreeTierError` | 未过准入：路径、UA、session 结构、匿名凭据、**TLS/HTTP2 指纹**任一不合规 | 按 §7 决策树检查；headers/body 都正常时查 §13（Bun 1.3.14 forwarder） |
| 429 | `FreeUsageLimitError` | 已过准入，额度/频率受限；若带 `Retry-After`，按该时间等待。匿名免费层可能是**全局/每日额度**，换 IP/session 未必有效 | 按 `Retry-After` 等待，或改用真实 `OPENCODE_API_KEY` |
| 410 | `ModelDeprecated` | 模型已退役 | 换 live catalog 中可用的 free 模型 |
| 401 | 鉴权 | key/token 问题 | 检查 `OPENCODE_API_KEY` / Console 登录 |
| 5xx | 系统 | 上游/网络问题 | 重试、检查出站代理 |

## 7. 排查决策树

```
请求 403 FreeTierError
│
├─ 1. 客户端 baseURL 是什么？
│    ├─ /v1/*                  → 代理应改写为 /zen/v1/*
│    ├─ /inference/v1/*        → 代理应改写为 /zen/v1/*
│    ├─ /inference/{openai,anthropic,...}/v1/* → 代理应改写为 /zen/...
│    └─ 已是 /zen/*            → 进入第 3 步
│
├─ 2. resolveTarget 改写后的路径是 /zen/* 吗？
│    └─ 否 → 检查 rewriteInferenceCompat / 裸路径改写分支
│
├─ 3. isZenTarget 为 true 吗？
│    └─ 否 → zenLaneRe 未覆盖该路径（zen/go、systemone、google 等）
│           → 扩展正则或补映射
│
├─ 4. 上游是否收到完整 v2 身份头？
│    ├─ User-Agent: opencode/<channel>/<version>/<name>（>= 1.18.0）
│    ├─ x-opencode-session: ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
│    ├─ x-opencode-session-id / x-session-affinity / x-session-id
│    ├─ x-opencode-client / x-opencode-project
│    └─ traceparent + b3
│
├─ 5. 是否误把 x-opencode-request（msg_）发给上游？
│    └─ v2 毒头，带上即 403；代理已剥离
│
├─ 6. 是否直连 /inference/* 且带 Bearer public？
│    └─ 是 → 改走 /zen/*（Console 兼容层会剥掉匿名凭据）
│
└─ 7. 以上都正常？
     ├─ 429 → 限流，不是准入问题
     │    ├─ 有 Retry-After → 按该时间等待（可能是每日额度）
     │    └─ 无 Retry-After → 换 session/模型/出站 IP 做单变量对比
     ├─ 410 → 模型退役
     └─ 仍 403 → 用真实上游探针逐步删减变量定位
          └─ headers/body 都正确 → 查 §13：Bun 1.3.14 forwarder / TLS 指纹
```

## 8. 常见坑

1. **改完代码没有重启代理**：Windows 上旧 `proxy-go.exe` 仍在监听 8788 时，
   新请求仍走旧逻辑。务必 `go build -o proxy-go.exe .` 后停止旧进程再启动。
2. **只改 `/inference/openai/v1`，漏了裸 `/v1/*`**：客户端 baseURL 是
   `http://127.0.0.1:8788/v1/chat/completions` 时仍会 403。
3. **只扩展 `zenLaneRe`，没有重写路径**：头注入了，但直连 `/inference/*` 仍 403。
4. **把 `upstream` 写成 `https://opencode.ai/zen`**：路径会被钉死，任何改写都异常。
5. **live catalog 缓存**：客户端每 5 分钟刷新目录；服务端改了 `api` 后，
   客户端可能在几分钟内自动切换路径。
6. **geo 限制**：部分 free 模型（如 Beam Free）在特定地区不可用；
   错误可能表现为 403/429，需要结合出站 IP 判断。
7. **模型退役**：live catalog 会删除/弃用模型；先用 `/zen/v1/models` 或
   live catalog 确认模型仍存在。
8. **客户端会话头没有收录**：OpenCode 客户端发的是
   `x-opencode-session-id` / `x-session-affinity`；如果 `session.headers` 只配了
   `x-session-id` / `x-opencode-session` / `x-session`，请求会全部落到
   `fallback_key: default`，共用同一条上游 `ses_`（曾出现 `hits=2561`）。
9. **把 429 当成准入失败**：429 表示已经过准入；真正的准入失败是 403。
   若响应带 `Retry-After`，优先按它等待，不要继续高频重试。
10. **换 IP 就一定好**：匿名免费层可能是**全局/每日额度**。本次香港/日本/美国/华为云
    四个出口 IP 全部 429，最终 `Retry-After` 指向 00:00 UTC，说明是每日额度而非 IP 限流。
11. **Bun 版本不对**：2026-10-18 12:01 起上游新增 **Bun 1.3.14 TLS/HTTP2 指纹门**。
    同一份 headers/body：Go/Python/Bun 1.4.x 都 403，只有 Bun **1.3.14** 200。
    代理必须启用 `forwarder/` sidecar，并确认 `bun --version` 是 1.3.14（见 §13）。

## 9. 日志与观测

- 代理控制台日志（重启后）：
  - `proxy-go.console.log`
  - `proxy-go.console.err.log`
- 每个请求的观测头：
  - `X-Proxy-Session`：上游 `ses_`
  - `X-Proxy-Request`：上游 `msg_`（仅审计，不上行）
  - `X-Proxy-Via`：实际出站代理（`direct` 或代理 URL）
- 代理请求日志字段：`path`、`status`、`session`、`upstream_session`、
  `upstream_message`、`upstream_proxy`、`duration_ms`。
- `opencode-verify-go`：
  - 离线：`go run .`
  - 在线：`go run . -live -max-tokens 8`（⚠ 消耗额度；
    默认 payload 中的旧模型可能需要替换为 live catalog 中仍可用的 free 模型）。

## 10. 复现命令速查

```powershell
# 1) 静态路由
cd E:\projects\ai\opencode-proxy\opencode-proxy-go
go test -run 'TestUpstreamURLRewritesInferenceCompat|TestIsZenTargetInferenceCompat' -v

# 2) 全量测试
go test -count=1 ./...

# 3) 构建
go build -o proxy-go.exe .

# 4) 重启（先停旧进程）
Get-Process proxy-go -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process .\proxy-go.exe -WorkingDirectory (Get-Location) -WindowStyle Hidden

# 5) 客户端真实路径验证
curl.exe -sS -X POST "http://127.0.0.1:8788/v1/chat/completions" `
  -H "Content-Type: application/json" `
  -H "X-Session-Id: manual-check" `
  --data-binary '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

## 11. 会话标识与 `default` 桶（2026-10-18 补充）

### 11.1 出口请求里到底有什么

用 `buildUpstreamHeaders` 打出的完整头组：

| 头 | 示例值 | 稳定性 |
|---|---|---|
| `X-Opencode-Session` | `ses_ebdee7822ffeh3r8ItZGeOkmG6` | ✅ 每个上游会话固定 |
| `X-Opencode-Session-Id` | 同上 | ✅ |
| `X-Session-Affinity` | 同上 | ✅ |
| `X-Session-Id` | 同上 | ✅ |
| `X-Opencode-Client` | `cli` | ✅ 固定 |
| `X-Opencode-Project` | `global` | ✅ 固定 |
| `User-Agent` | `opencode/latest/2.0.32/cli` | ✅ 固定 |
| `Authorization` | `Bearer public` | ✅ 固定匿名 key |
| `Traceparent` / `B3` | 随机 | ❌ 每请求新生成 |
| `Cookie` | 客户端发送则透传 | ⚠️ 可能稳定 |
| `X-Opencode-Request`（msg_） | 不发送 | — 毒头已剥离 |

### 11.2 客户端实际发送的会话头

`packages/core/src/session/model-request.ts`：

```ts
"x-opencode-session-id": session.id,
"x-session-affinity": affinity,
"X-Session-Id": affinity,
"x-opencode-project": session.projectID,
"x-opencode-session": affinity,
"x-opencode-client": app.name,
```

但旧 `config.yaml` 的 `session.headers` 只有：

```yaml
- x-session-id
- x-opencode-session
- x-session
```

因此 `x-opencode-session-id` / `x-session-affinity` 未命中，全部落到
`fallback_key: "default"`。数据库实测：

```
('default', 'ses_ebdee7822ffeh3r8ItZGeOkmG6', hits=2561, ...)
```

即：**所有不带已识别会话头的请求共用同一条上游 `ses_` 2561 次**。

### 11.3 修复与验证

`config.yaml`：

```yaml
session:
  headers:
    - x-opencode-session-id
    - x-session-affinity
    - x-session-id
    - x-opencode-session
    - x-session
```

重启后日志：

```
session=final-check-... session_via=final-check-...
upstream_session=ses_eb324b9beffe...
```

说明新会话不再落到 `default`。如果仍有旧客户端不带这些头，可以：

```sql
DELETE FROM session_map WHERE incoming_key = 'default';
```

然后重启代理（内存缓存会重新加载）。

## 12. 限流归因与远程部署结论

### 12.1 单变量实验

| 变量 | 实验 | 结果 |
|---|---|---|
| session | 多个全新 `X-Opencode-Session-Id`（`mihomo-node-test-*` 等） | 429 |
| 模型 | `deepseek-v4.1-flash-free` / `big-pickle` / `glm-5.3-flash-free` / `mimo-v2.6-flash-free` | 429 |
| 出口 IP | 香港 `<proxy-ip-hk>` / 日本 `<proxy-ip-jp>` / 美国 `<proxy-ip-us>` | 429 |
| 服务器 | 华为云 `<server>`（直连 opencode.ai `/zen/v1/models` = 200） | 429 |
| UA | `opencode/latest/2.0.29/cli` → `2.0.32/cli` | 429 |
| project/client | `global`/`cli` → 随机 project + `opencode` | 429 |

### 12.2 `Retry-After` 给出的答案

远程服务器响应：

```
HTTP/1.1 429 Too Many Requests
Retry-After: 76869
Date: Sun, 18 Oct 2026 02:38:51 GMT
```

`76869` 秒 ≈ 21h21m；`02:38:51 UTC + 21:21:09 = 00:00:00 UTC`。

即重置点是：

```
2026-10-19 00:00:00 UTC
= 2026-10-19 08:00:00 CST
```

### 12.3 结论

- 429 是**匿名免费层的全局/每日额度**，不是 IP、session、模型、UA、project/client 限流；
- 换服务器/出口 IP 不能绕过；
- 代理本身已正确：`429` 表示已过准入，`403` 才是准入失败；
- 等待 `Retry-After` 或改用真实 `OPENCODE_API_KEY` 是仅有的两条路；
- 远程部署细节见 [05-remote-deployment.md](./05-remote-deployment.md)。

## 13. 第二次 403：Bun 1.3.14 TLS/HTTP2 指纹门（2026-10-18 12:01）

### 13.1 现象

- 同一个代理 binary（哈希与当前源码构建一致）在 10:38 还是 429；
- 12:01 起同样的 `/v1/chat/completions` → `/zen/v1/chat/completions` 变成 **403**；
- 新 session、旧 session、不同模型都 403；
- 直连 `/zen/v1`、`/inference/openai/v1`、`/inference/v1` 也都是 403；
- 响应只有 `x-opencode-log-id` / `CF-RAY`，没有 `Retry-After`。

### 13.2 决定性实验

用官方 `opencode-ai@1.19.3` 客户端捕获真实请求（headers + body），再用不同客户端重放：

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

**结论：代理的 headers/body 没有问题；上游新增的是 Bun 1.3.14 的
TLS/HTTP2 指纹门。**

### 13.3 解决方案

新增 `forwarder/`（Bun 1.3.14 sidecar）：

```
Go 代理 → 明文 HTTP 127.0.0.1:8898 → Bun 1.3.14 fetch → https://opencode.ai
```

- Go 代理仍负责路径改写、v2 身份头、body fixup；
- sidecar 只负责 Bun 1.3.14 的 TLS/HTTP2 出站；
- 配置：`forwarder.addr: "127.0.0.1:8898"`；
- 本地/远程验证：**200**，`X-Proxy-Via: forwarder:127.0.0.1:8898`。

完整原理、代码、部署与排查见
[06-bun-tls-fingerprint.md](./06-bun-tls-fingerprint.md)。
