# Bun 1.3.14 转发 sidecar

## 为什么需要它

2026-10-18 起，`opencode.ai` 的匿名免费道新增了 **Bun 1.3.14 的 TLS/HTTP2 指纹门**。
同一份请求（相同的 headers/body）实测：

| 出站客户端 | 结果 |
|---|---|
| Bun **1.3.14** `fetch` | **200**（正常 SSE） |
| Bun 1.4.3 `fetch` | 403 `FreeTierError` |
| Go `net/http` | 403 `FreeTierError` |
| Python `urllib` | 403 `FreeTierError` |

所以 Go 代理本身无法直接通过上游；需要一个 Bun 1.3.14 的 sidecar 完成出站 TLS。

## 架构

```
客户端
  → opencode-proxy-go (:8788)
     路径改写 + v2 身份头 + body 修正
  → 明文 HTTP 拨到 127.0.0.1:8898
  → forward.ts (Bun 1.3.14)
     → HTTPS + Bun 1.3.14 TLS/HTTP2
  → https://opencode.ai
```

Go 代理的 `forwarder.addr` 启用后：

- Go 侧把 `opencode.ai:*` 的拨号重定向到 sidecar；
- URL 仍然是 `http://opencode.ai/...`（host/path 不变，路径改写与 `isZenTarget` 不受影响）；
- sidecar 用 Bun 1.3.14 的 `fetch` 发到 `https://opencode.ai`。

## 安装 Bun 1.3.14

必须 **精确使用 1.3.14**；1.4.x 会被上游 403。

```powershell
# 方式 A：装到项目临时目录，不影响全局 bun
npm install bun@1.3.14 --prefix .bun1314
.\.bun1314\node_modules\bun\bin\bun.exe --version   # 1.3.14

# 方式 B：全局安装（会覆盖全局 bun 版本）
npm install -g bun@1.3.14
bun --version
```

Linux（远程服务器）：

```bash
npm install -g bun@1.3.14
bun --version
# 或使用官方安装脚本并锁定版本
```

## 启动

```powershell
# 在 opencode-proxy-go/forwarder 下
..\..\.bun1314\node_modules\bun\bin\bun.exe run forward.ts
# 或
.\run.ps1
```

默认监听 `127.0.0.1:8898`；可覆盖：

```powershell
$env:FORWARDER_PORT = "8898"
$env:FORWARDER_HOST = "127.0.0.1"
```

Linux：

```bash
bun run forward.ts
# 或
./run.sh
```

启动日志：

```
bun forwarder listening on http://127.0.0.1:8898 (bun 1.3.14)
```

## 配置 Go 代理

`config.yaml`：

```yaml
forwarder:
  addr: "127.0.0.1:8898"   # 留空 = 不启用

proxy:
  url: ""                  # forwarder 启用时不需要 Go 侧出站代理
  from_env: false
```

然后重启 Go 代理：

```powershell
go build -o proxy-go.exe .
Get-Process proxy-go -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process .\proxy-go.exe -WorkingDirectory (Get-Location) -WindowStyle Hidden
```

日志应出现：

```
upstream transport resolved ... forwarder=127.0.0.1:8898
```

## 验证

通过 Go 代理请求：

```powershell
curl.exe -sS -X POST http://127.0.0.1:8788/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "X-Opencode-Session-Id: bun-forwarder-test" `
  --data-binary '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

预期：`200` + SSE（或额度不足时 `429`，但不应再是 `403 FreeTierError`）。

## systemd（Linux）

```ini
[Unit]
Description=OpenCode Bun 1.3.14 forwarder
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy-go/forwarder
ExecStart=/usr/local/bin/bun run /opt/opencode-proxy-go/forwarder/forward.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now opencode-forwarder
journalctl -u opencode-forwarder -f
```

## 注意事项

- sidecar 只监听 `127.0.0.1`，不要暴露公网（无鉴权）。
- `forwarder` 启用时，Go 代理的 `proxy.url` / 环境变量代理会被忽略；
  sidecar 自己遵循系统路由（TUN/Mihomo 或直连）。
- 如果 Bun 版本不是 1.3.14，启动脚本会拒绝运行（见 `run.ps1`/`run.sh`）。
- 上游未来可能再次变更指纹要求；届时先验证 Bun 版本，再调整 sidecar/Transport。
