# 05 · 远程服务器部署与测试

> 2026-10-18 部署记录。远程服务器：华为云 Debian 12（x86_64），root，systemd。
> 本文不记录服务器密码；请使用 SSH key 或自行保管凭据。

## 1. 目标

把 `opencode-proxy-go` 部署到远程服务器，验证：

1. 服务器能否直连 `opencode.ai`；
2. 代理在无本地 Mihomo 的环境下能否正常转发；
3. 远程出口 IP 是否能绕开本地 429（结论：不能，见 §6）。

## 2. 构建 Linux 二进制

在 Windows 开发机：

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-go
$env:CGO_ENABLED = "0"      # SQLite 驱动是纯 Go（ncruces/go-sqlite3）
$env:GOOS = "linux"
$env:GOARCH = "amd64"
go build -o proxy-go-linux-amd64 .
```

产物约 17 MB，ELF 头：

```powershell
$b = [System.IO.File]::ReadAllBytes((Resolve-Path proxy-go-linux-amd64))
[System.Text.Encoding]::ASCII.GetString($b, 0, 4)   # ELF
```

> `go build -o proxy-go.exe .` 只能得到 Windows 二进制；
> 远程部署必须显式设置 `GOOS=linux`。

## 3. 远程目录与文件

```
/opt/opencode-proxy-go/
├── proxy-go-linux-amd64     # Linux 二进制（chmod 755）
├── config.yaml              # 远程配置（见 §4）
├── opencode_tools.json      # v2 准入要求的 read 工具面
└── proxy-go.db              # 运行时生成（SQLite）
```

上传方式（任选）：

```powershell
# PuTTY 工具
pscp -pw <password> proxy-go-linux-amd64 root@<server>:/opt/opencode-proxy-go/
pscp -pw <password> config.remote.yaml     root@<server>:/opt/opencode-proxy-go/config.yaml
pscp -pw <password> ..\opencode_tools.json root@<server>:/opt/opencode-proxy-go/

# 或 OpenSSH（交互输入密码）
scp proxy-go-linux-amd64 root@<server>:/opt/opencode-proxy-go/
```

远程：

```bash
chmod 755 /opt/opencode-proxy-go/proxy-go-linux-amd64
```

## 4. 远程配置差异

远程 `config.yaml` 与本地的主要差异：

| 字段 | 本地 | 远程 |
|---|---|---|
| `listen` | `127.0.0.1:8788` | `127.0.0.1:8788`（仅本机，测试用 SSH 隧道） |
| `proxy.url` | `""`（由 Bun forwarder 出站） | `""`（由 Bun forwarder 出站） |
| `proxy.from_env` | `false` | `false`（避免继承服务器环境代理） |
| `forwarder.addr` | `127.0.0.1:8898` | `127.0.0.1:8898`（Bun 1.3.14 sidecar） |
| `body_fixup.tools_file` | `../opencode_tools.json` | `opencode_tools.json`（同目录） |
| `session.headers` | 含 `x-opencode-session-id` / `x-session-affinity` | 同左 |
| `upstream_headers.user_agent` | `opencode/latest/2.0.32/cli` | 同左 |

模板 `config.remote.yaml` 已放在仓库中，可直接复用。

## 5. systemd 服务

`/etc/systemd/system/opencode-proxy-go.service`：

```ini
[Unit]
Description=OpenCode free-tier proxy (opencode-proxy-go)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy-go
ExecStart=/opt/opencode-proxy-go/proxy-go-linux-amd64 -config /opt/opencode-proxy-go/config.yaml
Restart=on-failure
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

启用：

```bash
systemctl daemon-reload
systemctl enable --now opencode-proxy-go
systemctl is-active opencode-proxy-go
ss -lntp | grep 8788
journalctl -u opencode-proxy-go -n 20 --no-pager
```

本次部署结果：

```
active
LISTEN 127.0.0.1:8788  users:(("proxy-go-linux-",pid=58820,...))
INFO upstream proxy resolved configured="" no_proxy=[] from_env=false
INFO opencode-proxy-go listening listen=127.0.0.1:8788 upstream=https://opencode.ai db=proxy-go.db
```

## 6. 远程测试结果（关键）

服务器出口 IPv4：`<server>`（`curl -4 https://ifconfig.me/ip`）。

服务器直连 `opencode.ai`：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://opencode.ai/zen/v1/models
# 200
```

通过远程代理请求：

```bash
curl -sS -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Opencode-Session-Id: remote-test-1' \
  --data-binary '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}],"max_tokens":8}' \
  -D - -o /tmp/remote_body.txt -w '%{http_code}'
```

结果：

```
HTTP/1.1 429 Too Many Requests
Retry-After: 76869
Cf-Placement: remote-ORD
Cf-Ray: a4c42b51fd174328-EWR
X-Proxy-Session: ses_eb31fb390ffed5WX8bpTcAyrw1
X-Proxy-Via: direct

{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}
```

`Retry-After: 76869` 秒 ≈ 21h21m；从响应时间
`2026-10-18 02:38:51 UTC` 推算，重置时间正好是：

```
2026-10-19 00:00:00 UTC
= 2026-10-19 08:00:00 CST（北京时间）
```

**结论：**

- 这是**匿名额度的每日重置**（UTC 零点），不是 IP、session、模型、UA、project/client 限流；
- 换到华为云出口 IP（<server>）仍然 429，进一步证明限流是全局/匿名 key 级别；
- 代理本身工作正常：`429` 表示已通过准入，只是额度用尽；
- 之前的 `403 FreeTierError` 已经解决，路径/UA/session 都正确。

### 6.1 2026-10-18 12:31 更新：Bun 1.3.14 sidecar

12:01 出现第二次 `403 FreeTierError`。根因不是路径/UA/session，而是上游新增的
**Bun 1.3.14 TLS/HTTP2 指纹门**（详见 [06-bun-tls-fingerprint.md](./06-bun-tls-fingerprint.md)）。

远程已新增：

- `/opt/opencode-proxy-go/bun-1.3.14/bun`
  （从 `@oven/bun-linux-x64-baseline@1.3.14` 解包）；
- `/opt/opencode-proxy-go/forwarder/forward.ts`；
- `opencode-forwarder.service`，监听 `127.0.0.1:8898`；
- 新的 `proxy-go-linux-amd64` 与 `config.yaml`（`forwarder.addr`）。

验证：

```bash
systemctl is-active opencode-forwarder   # active
systemctl is-active opencode-proxy-go     # active
ss -lntp | grep -E '8788|8898'
# 127.0.0.1:8898 bun
# 127.0.0.1:8788 proxy-go-linux-amd64

curl -sS -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Opencode-Session-Id: remote-forwarder-test' \
  --data-binary '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"max_tokens":8}' \
  -D - -o /tmp/remote_body.txt -w '%{http_code}'
# 200
# X-Proxy-Via: forwarder:127.0.0.1:8898
```

forwarder 日志：

```
bun forwarder listening on http://127.0.0.1:8898 (bun 1.3.14)
POST /zen/v1/chat/completions -> 200
```

> §6 的 429 是 10:38 的历史结果（当时匿名日额度用尽）；12:31 的 200 是加入
> Bun 1.3.14 sidecar 后的结果。两者不矛盾：429 是额度，403 是指纹门。

## 7. 从 Windows 访问远程代理（推荐）

远程只监听 `127.0.0.1:8788`，不要直接暴露公网（代理无鉴权）。用 SSH 本地端口转发：

```powershell
ssh -L 18788:127.0.0.1:8788 root@<server>
```

保持 SSH 会话，然后把客户端 baseURL 指向：

```
http://127.0.0.1:18788/v1/chat/completions
```

或在本机 curl：

```powershell
curl.exe -sS -X POST http://127.0.0.1:18788/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "X-Opencode-Session-Id: tunnel-test-1" `
  --data-binary '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

## 8. 使用真实 API Key（绕过匿名日额度）

如果手上有 `OPENCODE_API_KEY` / Console 账号，远程 `config.yaml` 改为：

```yaml
upstream_headers:
  authorization: "Bearer <YOUR_OPENCODE_API_KEY>"
```

然后：

```bash
systemctl restart opencode-proxy-go
journalctl -u opencode-proxy-go -n 20 --no-pager
```

原因：Console 兼容层 `/zen/*` 对 `public` 会按匿名处理（剥掉凭据）；
对其它 key 会作为真实凭据转发到新推理后端，走账号额度而不是匿名日额度。

## 9. 运维命令

```bash
systemctl status opencode-proxy-go --no-pager
systemctl restart opencode-proxy-go
systemctl stop opencode-proxy-go
systemctl disable --now opencode-proxy-go
journalctl -u opencode-proxy-go -f
```

查看监听：

```bash
ss -lntp | grep 8788
```

查看数据库：

```bash
sqlite3 /opt/opencode-proxy-go/proxy-go.db \
  'select incoming_key, upstream_session, hits from session_map order by last_seen_ms desc limit 10;'
```

## 10. 安全注意事项

1. **不要公开 8788 端口**：代理没有鉴权，任何能访问的人都能消耗你的免费额度/API key。
   远程配置保持 `listen: "127.0.0.1:8788"`，用 SSH 隧道访问。
2. **服务器密码不要写入仓库/脚本**：本次部署脚本已删除；建议改用 SSH key 并修改 root 密码。
3. **`Authorization` 是敏感信息**：如果改用真实 key，不要把 `config.yaml` 提交到仓库。
4. **日志**：`journalctl` 会记录请求路径/session/状态，不记录 body；如需更详细排查再临时开日志。

## 11. 重新部署

```powershell
# 1) 本机重新构建
$env:CGO_ENABLED="0"; $env:GOOS="linux"; $env:GOARCH="amd64"
go build -o proxy-go-linux-amd64 .

# 2) 上传
pscp -pw <password> proxy-go-linux-amd64 root@<server>:/opt/opencode-proxy-go/
pscp -pw <password> config.remote.yaml     root@<server>:/opt/opencode-proxy-go/config.yaml
pscp -pw <password> ..\opencode_tools.json root@<server>:/opt/opencode-proxy-go/

# 3) 重启
ssh root@<server> "chmod 755 /opt/opencode-proxy-go/proxy-go-linux-amd64 && systemctl restart opencode-proxy-go"
```

## 12. 结论速记

| 项目 | 结果 |
|---|---|
| 远程直连 `opencode.ai` | ✅ 200 |
| systemd 服务 | ✅ `opencode-proxy-go` + `opencode-forwarder` 均 active |
| 代理路径/UA/session | ✅ 正确 |
| Bun 1.3.14 forwarder | ✅ active，127.0.0.1:8898 |
| 远程出口 IP | <server> |
| 10:38 免费层状态 | ❌ 匿名日额度用尽，`Retry-After` 至 2026-10-19 00:00 UTC（08:00 CST）（历史） |
| 12:31 sidecar 后 | ✅ **200**，`X-Proxy-Via: forwarder:127.0.0.1:8898` |
| 换服务器/IP 是否能绕过 | 日额度：❌ 不能；TLS 指纹门：✅ 由 Bun 1.3.14 sidecar 解决 |
| 下一步 | 等 UTC 零点重置匿名额度，或配置真实 `OPENCODE_API_KEY` |
