# 06 · Bun 1.3.14 TLS/HTTP2 指纹门与 sidecar 方案

> 2026-10-18 12:00 左右，已修复的代理再次返回
> `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`。
> 本文记录第二次根因、证据、解决方案与部署方式。

## 1. 现象

- 同一个 `opencode-proxy-go`（二进制哈希与当前源码构建一致）在 10:38 还是 429（已过准入）；
- 12:01 起，**同样的 `/v1/chat/completions` → `/zen/v1/chat/completions`，同样的 headers/body**，
  变成 **403 FreeTierError**；
- 新 session、旧 default session、不同模型（`big-pickle`、`deepseek-v4.1-flash-free` 等）都 403；
- 直连 `/zen/v1`、`/inference/openai/v1`、`/inference/v1` 也都是 403；
- 响应只带 `x-opencode-log-id`、`Server: cloudflare`、`CF-RAY`，没有 `Retry-After`。

这说明不是路径、session、模型或额度问题，而是**上游新增了一层拒绝条件**。

## 2. 关键实验：官方客户端还能用

用官方 npm `opencode-ai@1.19.3` 客户端（隔离 HOME/XDG 环境）执行：

```powershell
opencode run "hi" --model opencode/big-pickle --print-logs --log-level INFO
```

结果：

```
Hi! How can I help you?
```

匿名免费层**仍然可用**，所以 403 是“我们的请求特征”问题，不是服务关闭。

## 3. 捕获官方客户端的真实请求

为了排除 headers/body 差异，启动一个本地捕获服务器，把 1.19.3 客户端的
`provider.opencode.options.baseURL` 指到 `http://127.0.0.1:8899/zen/v1`，
捕获到两条真实请求（title 生成 + 主请求）。

主请求的关键内容：

```http
Authorization: Bearer public
Content-Type: application/json
User-Agent: opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
x-opencode-client: cli
x-opencode-project: d54a50bcf9592ceff879479c034d7e0e37daa12a
x-opencode-request: msg_14d3e0c94001Q6p1If1Z6e8nxj
x-opencode-session: ses_eb2c1f454ffevNDUFdZ0fKtynT
x-opencode-session-id: ses_eb2c1f454ffevNDUFdZ0fKtynT
Accept: */*
Accept-Encoding: gzip, deflate, br, zstd
```

Body（33 KB）包含：

- `model: big-pickle`
- `max_tokens: 32000`
- `messages`: system prompt + user message
- `tools`: 11 个（bash/edit/glob/grep/read/skill/task/todowrite/webfetch/websearch/write）
- `tool_choice`
- `stream: true`
- `stream_options: { include_usage: true }`

## 4. 决定性实验：不是 headers/body，而是 Bun 版本

把**完整捕获的 headers + body**分别用不同客户端重放：

| 客户端 | 结果 |
|---|---|
| Python `urllib`（OpenSSL） | **403 FreeTierError** |
| Go `net/http` | **403 FreeTierError** |
| Bun **1.4.3** `fetch` | **403 FreeTierError** |
| Bun **1.3.14** `fetch` | **200 + SSE** |

进一步用 Bun 1.3.14 测试“最小 body + 代理当前 headers”（UA 2.0.32、project global、
四个 session 头、traceparent/b3，无 `x-opencode-request`）：

| 组合 | 结果 |
|---|---|
| minimal body + proxy headers | **200** |
| minimal body + official headers | **200** |
| minimal body + stream_options + proxy headers | **200** |
| full body + proxy headers | **200** |

**结论：**

- 代理现有的 headers/body **没有问题**；
- 上游新增的是 **Bun 1.3.14 的 TLS/HTTP2 指纹门**；
- Go/Python/Bun 1.4.x 的 ClientHello/HTTP2 特征都会被拒绝；
- 只有 Bun **1.3.14** 的 `fetch` 能通过。

> 这解释了为什么改 UA、project、request、session、模型、IP 都无效：
> 拒绝发生在 TLS/HTTP2 层，而不是应用层 header。

## 5. 解决方案：Bun 1.3.14 sidecar

```
客户端
  → opencode-proxy-go (:8788)
     路径改写 + v2 身份头 + body 修正
  → 明文 HTTP 拨到 127.0.0.1:8898
  → forward.ts (Bun 1.3.14)
     → HTTPS + Bun 1.3.14 TLS/HTTP2
  → https://opencode.ai
```

Go 代理仍然负责：

- `/v1/*`、`/inference/*`、旧 `/inference/v1/*` → `/zen/*` 的路径改写；
- UA / 四个 session 头 / client / project / trace / body fixup；
- 入站 session → 上游 `ses_` 的稳定映射。

Bun sidecar 只负责：

- 用 Bun 1.3.14 完成到 `https://opencode.ai` 的 TLS/HTTP2；
- 原样转发 headers/body；
- 把上游 SSE 流式回传给 Go 代理。

## 6. 代码改动

### 6.1 `forwarder/forward.ts`

- `Bun.serve` 监听 `127.0.0.1:8898`；
- 把 `req.url` 的 path/query 拼到 `https://opencode.ai`；
- 删除 hop-by-hop 头，`fetch` 转发；
- 删除响应的 `content-encoding`/`content-length`/`transfer-encoding`，流式返回。

### 6.2 Go 配置

`config.go`：

```go
type ForwarderConfig struct {
    Addr string `yaml:"addr"`
}
```

`config.yaml`：

```yaml
forwarder:
  addr: "127.0.0.1:8898"   # 留空 = 不启用

proxy:
  url: ""
  from_env: false
```

### 6.3 Go transport

`proxy.go`：启用 forwarder 时：

- `tr.Proxy = nil`（forwarder 取代 Go 侧出站代理）；
- `tr.DialContext` 把 `opencode.ai:*` 的拨号重定向到 `cfg.Forwarder.Addr`；
- 仍然使用明文 HTTP，避免 Go 与 sidecar 之间再做 TLS。

`server.go`：forwarder 启用时把 upstream scheme 改为 `http`（host/path 不变），
并在日志/`X-Proxy-Via` 中显示 `forwarder:<addr>`。

## 7. 本地验证

启动 forwarder：

```powershell
cd opencode-proxy-go\forwarder
npm install bun@1.3.14 --prefix ..\.bun1314
..\.bun1314\node_modules\bun\bin\bun.exe run forward.ts
```

启动 Go 代理后请求：

```powershell
curl.exe -sS -X POST http://127.0.0.1:8788/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "X-Opencode-Session-Id: bun-forwarder-test" `
  --data-binary '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

实测：

```
HTTP/1.1 200 OK
X-Proxy-Via: forwarder:127.0.0.1:8898
{"id":"mai-api-...","object":"chat.completion","model":"big-pickle",...}
```

代理日志：

```
upstream transport resolved ... forwarder=127.0.0.1:8898
proxy ... status=200 upstream_proxy=forwarder:127.0.0.1:8898
```

## 8. 远程部署

远程 `/opt/opencode-proxy-go`：

```
bun-1.3.14/bun                  # 从 npm @oven/bun-linux-x64-baseline@1.3.14 解包
forwarder/forward.ts
proxy-go-linux-amd64            # 新二进制
config.yaml                     # forwarder.addr=127.0.0.1:8898
```

新增 systemd 服务 `opencode-forwarder.service`：

```ini
[Unit]
Description=OpenCode Bun 1.3.14 forwarder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy-go/forwarder
ExecStart=/opt/opencode-proxy-go/bun-1.3.14/bun run /opt/opencode-proxy-go/forwarder/forward.ts
Restart=on-failure
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

启用：

```bash
systemctl daemon-reload
systemctl enable --now opencode-forwarder
systemctl restart opencode-proxy-go
```

远程验证：

```
opencode-forwarder: active
opencode-proxy-go: active
127.0.0.1:8898 bun
127.0.0.1:8788 proxy-go-linux-amd64

curl ... -> 200
X-Proxy-Via: forwarder:127.0.0.1:8898
```

forwarder 日志：

```
bun forwarder listening on http://127.0.0.1:8898 (bun 1.3.14)
POST /zen/v1/chat/completions -> 200
```

## 9. 排查清单

1. **Bun 版本**：`bun --version` 必须是 **1.3.14**；1.4.x 会 403。
2. **forwarder 是否在跑**：`ss -lntp | grep 8898`；日志在
   Windows `forwarder.console.err.log` / Linux `journalctl -u opencode-forwarder`。
3. **Go 代理是否启用 forwarder**：日志应出现
   `upstream transport resolved ... forwarder=127.0.0.1:8898`；
   响应头 `X-Proxy-Via: forwarder:127.0.0.1:8898`。
4. **403 还是 429**：
   - 403 `FreeTierError` → 指纹/准入；先查 Bun 版本与 forwarder。
   - 429 `FreeUsageLimitError` → 已过准入，额度/限流；按 `Retry-After` 等待。
5. **502 / 连接拒绝**：forwarder 没启动、端口不对，或 Go 代理未重启加载新配置。
6. **不要把 8898 暴露公网**：sidecar 无鉴权，只监听 `127.0.0.1`。

## 10. 结论

- 第一次 403：路径/匿名凭据问题（`/inference/*` → `/zen/*`），已修复。
- 第二次 403：上游新增 **Bun 1.3.14 TLS/HTTP2 指纹门**，代理 headers/body 本身正确。
- 解决方案：**Bun 1.3.14 sidecar**，Go 代理通过明文 HTTP 拨到 sidecar，由 Bun 完成出站 TLS。
- 本地与远程（华为云 Debian 12）均已验证 **200**。
- 未来若上游再次变更指纹要求，优先检查 Bun 版本与 sidecar 日志，而不是继续改 headers/body。
