# 从 opencode-proxy-go 迁移

## 1. 两种方案对比

| | `opencode-proxy-go` + forwarder | `opencode-proxy-bun` |
|---|---|---|
| 进程数 | 2（Go proxy + Bun forwarder） | **1（Bun）** |
| 端口 | 8788 + 8898 | **8788** |
| 出站 TLS | Bun 1.3.14 sidecar | Bun 1.3.14 直接出站 |
| 路径/header/body | Go | Bun |
| 会话映射 | Go + SQLite | Bun + SQLite |
| 客户端 baseURL | `:8788/v1/chat/completions` | **同左** |
| 非流式客户端 | Go 会把 SSE 组装回 JSON | 当前始终返回 SSE |

两者对客户端是 drop-in 兼容：baseURL、模型名、OpenAI 兼容接口都不变。

## 2. 切换步骤

### 2.1 准备

1. 安装 Bun **1.3.14**（见 `operations.md`）。
2. 记录当前 Go 方案使用的端口/数据库/配置。
3. 确认客户端当前 baseURL（通常是 `http://127.0.0.1:8788/v1/chat/completions`）。

### 2.2 停止旧服务

Windows（当前会话的 Go 代理 + forwarder）：

```powershell
Get-Process proxy-go -ErrorAction SilentlyContinue | Stop-Process -Force
# forwarder 是 bun 进程；如果开了独立窗口，关闭它
```

Linux（systemd）：

```bash
systemctl disable --now opencode-forwarder
systemctl disable --now opencode-proxy-go
```

### 2.3 启动新代理

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-bun
npm install bun@1.3.14 --prefix .bun1314
.\.bun1314\node_modules\bun\bin\bun.exe run src/index.ts
```

或：

```bash
bun run start
```

### 2.4 验证

```powershell
curl.exe -sS http://127.0.0.1:8788/healthz
curl.exe -sS -X POST http://127.0.0.1:8788/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "X-Opencode-Session-Id: migration-check" `
  --data-binary '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

预期：

```
200
X-Proxy-Via: direct
X-Proxy-Session: ses_...
X-Proxy-Request: msg_...
```

### 2.5 客户端

不需要改 baseURL；重启客户端或新开会话即可。

## 3. 并行运行（灰度）

如果不想立刻停掉 Go 方案，可以让两者同时跑：

```powershell
# Go 方案继续占用 8788 + 8898
# 新 Bun 代理用 8790
$env:LISTEN = "127.0.0.1:8790"
bun run start
```

客户端临时指向 `http://127.0.0.1:8790/v1/chat/completions` 验证；
确认无误后再切换 8788。

> 不要两个代理同时写同一个 SQLite 文件；并行时使用不同的 `DB_PATH`。

## 4. 配置映射

| Go `config.yaml` | Bun `config.json` |
|---|---|
| `listen` | `listen` |
| `upstream` | `upstream` |
| `db_path` | `dbPath` |
| `session.headers` | `session.headers` |
| `session.fallback_key` | `session.fallbackKey` |
| `session.passthrough_native` | `session.passthroughNative` |
| `upstream_headers.user_agent` | `upstreamHeaders.userAgent` |
| `upstream_headers.authorization` | `upstreamHeaders.authorization` |
| `upstream_headers.client` | `upstreamHeaders.client` |
| `upstream_headers.project` | `upstreamHeaders.project` |
| `body_fixup.mode: v2` | `bodyFixup.mode: "v2"` |
| `log.requests` | `log.requests` |
| `proxy.url` | `proxy.url`（支持 http/https；**不支持 socks5**） |
| `proxy.no_proxy` | `proxy.noProxy`（支持 CIDR，自行匹配） |
| `proxy.from_env` | `proxy.fromEnv`（默认 `true`） |
| `forwarder.addr` | 不再需要（同一进程） |
| `strip_prefix` | 暂不支持 |

## 5. 数据兼容

新项目的 `session_map` 表与 Go 版本结构一致：

```sql
incoming_key, upstream_session, created_at_ms, last_seen_ms, hits
```

如果希望复用旧映射：

1. 停止 Go 代理；
2. 把 `proxy-go.db` 复制为 `proxy.db`；
3. 在 `config.json` 设置 `dbPath: "proxy.db"`；
4. 启动 Bun 代理。

不要在两个进程同时写同一个 SQLite 文件。

## 6. 已知差异

完整限制见 [limitations.md](./limitations.md)。迁移相关差异：

1. **SSE-only**：本项目强制上游流式，但不把 SSE 组装回 JSON。
   如果某个客户端要求非流式 JSON，请暂时继续使用 `opencode-proxy-go`。
2. **没有 `message_map` / `request_log` 表**：只有 `session_map`；
   请求日志输出到 stdout，由 systemd/journald 收集。
3. **没有 `strip_prefix` / `inject_template`**：只保留现代 v2 行为。
4. **配置是 JSON**，不是 YAML。
5. **Bun 版本严格 1.3.14**：1.4.x 无法通过上游指纹门。
6. **出站代理能力不等价**：Go 支持 http/https/socks5/socks5h；Bun 1.3.14
   只支持 http/https（无 SOCKS5），不读 `ALL_PROXY`，且代理环境变量在启动时
   缓存、冲突配置（`fromEnv=false` + 非空环境变量，或 `url+noProxy` + 非空环境
   变量）会拒绝启动。详见 [limitations.md §6.1](./limitations.md)。

## 7. 回滚

```bash
# 停新代理
systemctl disable --now opencode-proxy-bun

# 恢复旧方案
systemctl enable --now opencode-forwarder
systemctl enable --now opencode-proxy-go
```

客户端 baseURL 不变。

## 8. 迁移检查清单

- [ ] Bun `--version` = 1.3.14
- [ ] 旧 Go 代理 + forwarder 已停止（或使用不同端口/DB）
- [ ] 新代理 `/healthz` 返回 `bun: "1.3.14"`
- [ ] `/v1/chat/completions` 返回 200 + `X-Proxy-Via: direct`（或配置的代理地址）
- [ ] 客户端新会话可用
- [ ] 日志无 403/502
- [ ] 如使用真实 key，确认未提交到仓库
