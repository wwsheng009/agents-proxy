# 运维手册

## 1. 前置：Bun 1.3.14

**必须精确使用 Bun 1.3.14。** 1.4.x 会被上游 `403 FreeTierError` 拒绝。

### Windows

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-bun
npm install bun@1.3.14 --prefix .bun1314
.\.bun1314\node_modules\bun\bin\bun.exe --version   # 1.3.14
```

### Linux

```bash
npm install -g bun@1.3.14
bun --version   # 1.3.14
```

或者从 npm 解包固定二进制：

```bash
curl -sS -o /tmp/bun1314.tgz \
  https://registry.npmjs.org/@oven/bun-linux-x64-baseline/-/bun-linux-x64-baseline-1.3.14.tgz
mkdir -p /opt/opencode-proxy-bun/bun-1.3.14
tar -xzf /tmp/bun1314.tgz -C /opt/opencode-proxy-bun/bun-1.3.14 --strip-components=1
/opt/opencode-proxy-bun/bun-1.3.14/bin/bun --version
```

## 2. 配置

`config.json`：

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
  "proxy": { "url": "", "noProxy": [], "fromEnv": true }
}
```

环境变量覆盖：`CONFIG`、`LISTEN`、`UPSTREAM`、`DB_PATH`；
出站代理：`PROXY_URL`、`PROXY_NO_PROXY`（逗号分隔）、`PROXY_FROM_ENV`（`1`/`0`）。

生产环境建议：

- `listen` 保持 `127.0.0.1:8788`；
- `dbPath` 用绝对路径；
- `log.requests: true`，日志交给 systemd/journald；
- 如果使用真实 key，`upstreamHeaders.authorization` 改为 `Bearer <key>`，不要把 key 提交到仓库。

## 3. 启动

### 前台

```powershell
cd opencode-proxy-bun
bun run start
```

### Windows 脚本

```powershell
.\run.ps1
```

`run.ps1` 默认启动 `watchdog.ps1`：每 30 秒检查一次 `/healthz`，连续 3 次
`degraded`/不可达后，先用新的 Bun 1.3.14 进程直连上游确认准入仍然正常；
只有“直连正常、代理仍 degraded”时才重启本地代理，避免上游故障时反复重启。
watchdog 自身日志写到 `watchdog.log`；包装进程的原始输出在
`watchdog.out.log` / `watchdog.err.log`；代理本身继续追加到
`proxy.console.log` / `proxy.console.err.log`。

需要裸启动（例如自己接 systemd/Windows 服务）时：

```powershell
$env:NO_WATCHDOG = "1"
.\run.ps1
```

守护参数：

```powershell
.\watchdog.ps1 -Listen 127.0.0.1:8788 -FailureThreshold 3 -ProbeIntervalSeconds 30
```

多实例/测试时用 `-LogBase` 隔离日志（默认 `proxy`）：

```powershell
.\watchdog.ps1 -Listen 127.0.0.1:8794 -LogBase test-8794
```

直连探测可通过环境变量覆盖目标与模型（用于测试或特殊上游）：
`PROBE_UPSTREAM`、`PROBE_MODEL`。

### Linux 脚本

```bash
./run.sh
```

`run.sh` 同样默认进入 `watchdog.sh`；`NO_WATCHDOG=1 ./run.sh` 为裸启动。

### systemd

单元文件：`deploy/opencode-proxy-bun.service`

```ini
[Unit]
Description=OpenCode free-tier proxy (Bun 1.3.14)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy-bun
Environment=CONFIG=/opt/opencode-proxy-bun/config.json
Environment=DB_PATH=/opt/opencode-proxy-bun/proxy.db
Environment=BUN_1314=/opt/opencode-proxy-bun/bun-1.3.14/bin/bun
ExecStart=/opt/opencode-proxy-bun/watchdog.sh
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp deploy/opencode-proxy-bun.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-proxy-bun
systemctl status opencode-proxy-bun --no-pager
journalctl -u opencode-proxy-bun -f
```

## 4. 远程部署

目录示例：

```
/opt/opencode-proxy-bun/
├── bun-1.3.14/
│   └── bin/bun
├── src/
├── config.json
├── package.json
├── tsconfig.json
└── proxy.db
```

上传后用固定 Bun 运行：

```bash
cd /opt/opencode-proxy-bun
/opt/opencode-proxy-bun/bun-1.3.14/bin/bun run src/index.ts
```

验证：

```bash
curl -sS http://127.0.0.1:8788/healthz
# {"status":"ok","bun":"1.3.14","upstream":"https://opencode.ai","sessions":N}

curl -sS -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Opencode-Session-Id: remote-smoke-1' \
  --data-binary '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"max_tokens":8}' \
  -D - -o /tmp/body.txt -w '%{http_code}'
```

预期：`200` + SSE，`X-Proxy-Via: direct`（配置出站代理后为代理地址）。

## 5. 健康与日志

- 健康检查：`GET /healthz` 或 `GET /__proxy/health`
- 响应观测头：
  - `X-Proxy-Session`
  - `X-Proxy-Request`
  - `X-Proxy-Via`: 实际生效的出站代理地址；直连为 `direct`
- `/healthz` 的运行时字段：
  - `status`: `ok` / `degraded`（连续 `FreeTierError` 达到阈值时为 `degraded`）
  - `proxy`: `configured` / `no_proxy` / `from_env` / `effective`（实际生效的出站代理）
  - `upstream_403_streak`: 连续 403 次数
  - `last_upstream_log_id` / `last_upstream_cf_ray`: 上游诊断标识
  - `last_403_at` / `last_ok_at`: 最近一次 403 / 成功时间
- 请求日志（stdout）：
  ```
  POST /v1/chat/completions -> /zen/v1/chat/completions 200 123ms session=... upstream_session=ses_... via=direct
  ```
- 403 诊断（stderr）：
  ```
  upstream 403 FreeTierError POST /v1/chat/completions -> /zen/v1/chat/completions log_id=... cf_ray=... streak=3
  ```
- systemd：`journalctl -u opencode-proxy-bun -f`

## 6. 数据与清理

SQLite 表 `session_map`：

```sql
SELECT incoming_key, upstream_session, hits, last_seen_ms
FROM session_map ORDER BY last_seen_ms DESC LIMIT 20;
```

清理长时间不用的映射（可选）：

```sql
DELETE FROM session_map
WHERE last_seen_ms < (strftime('%s','now') * 1000 - 7*24*3600*1000);
```

如果客户端不带会话头、全部落到 `default`，可以删除该行并重启：

```sql
DELETE FROM session_map WHERE incoming_key = 'default';
```

## 7. 升级 / 回滚

### 升级本项目

```bash
systemctl stop opencode-proxy-bun
# 替换 src/、config.json 等
systemctl start opencode-proxy-bun
```

### 回滚到 Go + forwarder

1. 停止本服务：`systemctl disable --now opencode-proxy-bun`
2. 启动 `opencode-forwarder` 和 `opencode-proxy-go`
3. 客户端 baseURL 不变（都是 `:8788/v1/chat/completions`）

数据库 `session_map` 结构兼容，可以直接复用 Go 的 `proxy-go.db`；
但**不要**让两个代理同时写同一个 SQLite 文件。

## 8. 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动退出：Bun 版本 | 不是 1.3.14 | 用 `bun@1.3.14` 的固定二进制 |
| `403 FreeTierError` | TLS 指纹/路径/UA/session 不合规 | 先确认 `bun --version`；再看 `X-Proxy-Via`（应为 `direct` 或你配置的代理）；查 `/healthz` |
| 长时间运行后突然连续 `403 FreeTierError` | 旧进程运行态失效（重启即恢复） | 看 `/healthz` 的 `upstream_403_streak`；用 `watchdog.ps1`/`watchdog.sh` 自动重启；诊断字段见 §5 |
| `429 FreeUsageLimitError` | 已过准入，匿名额度/限流 | 按 `Retry-After` 等待；或配置真实 key |
| `502 proxy_error` | 上游网络/DNS/TLS/代理失败 | 检查网络、DNS、系统时间、`/healthz` 的 `proxy.effective` 与日志 `via=` |
| 启动即退出，提示 proxy 冲突 | 环境变量与 `fromEnv=false` / `url+noProxy` 冲突 | 清空 `HTTP(S)_PROXY` 后重启，或改用 `proxy.url` / `fromEnv=true` |
| 所有请求共用 session | 客户端没发会话头 | 客户端加 `X-Opencode-Session-Id`；或清 `default` |
| `/healthz` 正常但请求 404 | 路径未命中改写 | 检查入站路径；`/zen/*`、`/v1/*`、`/inference/*` 都应命中 |
| 启动报 EEXIST | Bun 1.3.14 `mkdirSync(".")` 行为 | 已在 `session.ts` 处理；确认使用当前版本源码 |

## 9. 安全

- **只监听 `127.0.0.1`**：代理没有鉴权，任何能访问的人都能消耗额度/key。
- 远程访问用 SSH 隧道：
  ```powershell
  ssh -L 18788:127.0.0.1:8788 root@<server>
  ```
  客户端 baseURL 改为 `http://127.0.0.1:18788/v1/chat/completions`。
- 不要把真实 `OPENCODE_API_KEY` 写入仓库；用环境变量/密钥管理。
- `proxy.db` 可能包含客户端会话 key，注意文件权限。
- 如果公开部署，必须加反向代理鉴权/限流，并评估滥用风险。

## 10. 性能与并发

- Bun 单进程事件循环；SQLite 同步 API 但操作很短；
- SSE 流式回传不缓冲整条响应；
- `idleTimeout: 255`，适合长流；
- 大量并发时监控 `journalctl` 的延迟和 5xx；
- 需要水平扩展时，每个实例独立 SQLite，或后续换共享存储。

## 11. 限制

完整清单见 [limitations.md](./limitations.md)。运维相关要点：

- 只能 Bun 1.3.14；升级前必须重新验证上游指纹；
- 始终返回 SSE；非流式客户端继续用 Go 方案；
- 代理无鉴权，只监听 `127.0.0.1`；
- 只有 `session_map`；不要让两个进程同时写同一个 SQLite；
- 配置是 JSON；不支持 `strip_prefix` / `inject_template`；
- 匿名额度全局/每日；429 按 `Retry-After` 等待；
- 无重试/熔断/模型列表缓存。
