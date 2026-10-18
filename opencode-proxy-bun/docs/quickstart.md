# 简要使用说明

本文只给最短可用路径。完整参数、部署和排障见
[operations.md](./operations.md)，限制见 [limitations.md](./limitations.md)。

## 1. 选择运行模式

| 模式 | 适用场景 | 链路 |
|---|---|---|
| 本机直连 | 本机出口能通过上游准入 | 客户端 → 本机 Bun 代理(:8788) → opencode.ai |
| 远程隧道 | 本机出口被 403、或想复用远程网络 | 客户端 → 本机 8788 → SSH → 远程 8788 → opencode.ai |

## 2. 本机直连

### 准备 Bun

支持 **Bun 1.3.14+ / 1.4.x**（已验证 1.3.14、1.4.2、1.4.3）。

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-bun

# 任选一种：
npm install bun@1.3.14 --prefix .bun1314
npm install bun@1.4.3  --prefix .bun142

# 或指定已有二进制
$env:BUN_BIN = "C:\path\to\bun.exe"
```

### 启动

```powershell
.\run.ps1
```

默认监听 `127.0.0.1:8788`，并启动 watchdog。裸启动：

```powershell
$env:NO_WATCHDOG = "1"
.\run.ps1
```

Linux：

```bash
./run.sh
# 或
NO_WATCHDOG=1 ./run.sh
```

### 客户端配置

```text
baseURL: http://127.0.0.1:8788/v1/chat/completions
apiKey:  任意值（代理会注入 Bearer public）
model:   big-pickle / deepseek-v4.1-flash-free / ...
```

建议客户端发送唯一会话头：

```http
X-Opencode-Session-Id: my-client-session-1
```

### 验证

```powershell
curl.exe -sS http://127.0.0.1:8788/healthz
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:8788/v1/models
```

预期：

- `/healthz` 返回 `status: ok`
- `/v1/models` 返回 `200`

## 3. 远程隧道（本机出口 403 时）

前提：远程服务器已运行代理，且本机已配置免密 SSH。

### 确认远程代理

```bash
ssh root@<server> "curl -sS http://127.0.0.1:8788/healthz"
```

### 建立隧道

```bash
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8788:127.0.0.1:8788 \
  root@<server>
```

Windows 后台启动：

```powershell
Start-Process ssh -ArgumentList @(
  "-N",
  "-o", "BatchMode=yes",
  "-o", "ExitOnForwardFailure=yes",
  "-L", "127.0.0.1:8788:127.0.0.1:8788",
  "root@<server>"
)
```

隧道建立后，客户端配置不变，仍然使用：

```text
http://127.0.0.1:8788/v1/chat/completions
```

### 验证走的是远程

```powershell
curl.exe -sS http://127.0.0.1:8788/healthz
```

远程实例的返回中会显示远程 Bun 版本和连接数；本机原代理此时应已停止。

## 4. 停止

### 停止本机代理 / watchdog

```powershell
$listener = Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue
$listener | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

如果 watchdog 仍在后台，先用任务管理器或 `Stop-Process` 结束对应的 `pwsh` 进程。

### 停止 SSH 隧道

```powershell
$listener = Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue
$listener | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### 停止远程代理

```bash
ssh root@<server> "systemctl stop opencode-proxy-bun"
```

## 5. 常见错误

| 现象 | 含义 | 处理 |
|---|---|---|
| `403 FreeTierError` | 未过上游准入 | 先确认 Bun 版本在 1.3.14+ / 1.4.x；官方 OpenCode 也 403 时检查本机出口 IP，改用远程隧道 |
| `429 FreeUsageLimitError` | 已过准入，匿名额度/限流 | 按 `Retry-After` 等待，或使用真实 `OPENCODE_API_KEY` |
| `502 proxy_error` | 上游网络/DNS/TLS/代理失败 | 检查 `/healthz`、网络和 `proxy.effective` |
| 所有请求共用 session | 客户端没发会话头 | 加 `X-Opencode-Session-Id` |
| 启动退出，提示 Bun 版本 | 版本不在支持范围 | 安装 1.3.14+ / 1.4.x，或设置 `BUN_BIN` |

## 6. 安全

- 代理无鉴权，默认只监听 `127.0.0.1`，不要直接暴露公网。
- 远程访问使用 SSH 隧道，并优先使用 SSH key 登录。
- 不要把真实 `OPENCODE_API_KEY` 写入仓库或提交到版本控制。
