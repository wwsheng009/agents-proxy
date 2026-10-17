# workbuddy.md —— 用 https-proxy 观测 WorkBuddy AI

> 适用：**WorkBuddy AI 5.8.4**（Electron 37.10.3 / 内置 CLI 2.161.0），2026-10-17 实测。
> 通用代理机制见 [`proxy.md`](./proxy.md)；opencode 见 [`opencode.md`](./opencode.md)。

---

## 1. 它的结构

`C:\Users\vince\AppData\Local\Programs\WorkBuddyAI\WorkBuddyAI.exe` 是腾讯的 Electron 应用，
内部分三层：

| 组件 | 说明 |
|---|---|
| Electron 主进程 | UI、窗口、系统集成；`WorkBuddyAI.exe` |
| `workbuddy-server` daemon | 后台服务：会话、模型调用、代理设置；日志 `.workbuddy-ai/logs/daemon.log` |
| `@genie/agent-cli`（CodeBuddy） | 内置 CLI 2.161.0，实际发起模型请求；bundle `codebuddy-lite-wb.mjs` |

关键差异：它的代理**由自身设置驱动**（设置界面 / `settings.json`），解析后再把
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 注入 daemon 子进程。因此只给启动环境设
`HTTP_PROXY` **不会生效**。

---

## 2. 设置项

```json
// C:\Users\vince\.workbuddy-ai\settings.json
{
  "http.proxy": "https://127.0.0.1:8789",
  "http.proxySupport": "override"
}
```

| 设置 | 含义 |
|---|---|
| `http.proxySupport: "off"` | 不用代理（`mode=none`） |
| `http.proxySupport: "on"` | 使用系统代理（`mode=system`） |
| `http.proxySupport: "override"` + `http.proxy` | 手动代理（`mode=manual`） |

设置界面的「测试连接」走 IPC `proxySettings:testConnection`，结果写进 `daemon.log`。

### 该填哪个地址

| 填写 | 结果 |
|---|---|
| `https://127.0.0.1:8789` | ✅ 推荐：HTTPS 代理（先 TLS 到代理，再 CONNECT） |
| `http://127.0.0.1:8787` | ✅ 可用：标准 HTTP 代理 + MITM |
| `https://127.0.0.1:8787` | ❌ `WRONG_VERSION_NUMBER`（8787 是明文 HTTP） |
| `http://127.0.0.1:8789` | ❌ 协议不匹配，握手失败 |

原因：`testConnection` 用 `HttpsProxyAgent(url)` 请求 `https://www.workbuddy.ai`，
它会先与**代理地址本身**做 TLS 握手，所以 scheme 必须与监听协议一致。

---

## 3. 关键坑：它有自己的 CA bundle

WorkBuddy 启动 daemon 时给子进程设置：

```text
NODE_EXTRA_CA_CERTS=C:\Users\vince\.workbuddy-ai\system-ca-bundle.pem
```

生成逻辑（从 `app.asar` 还原）：

```text
1. 配置目录 = WORKBUDDY_CONFIG_DIR（本机 C:\Users\vince\.workbuddy-ai）
               缺省回退 %USERPROFILE%\.workbuddy
2. 若 system-ca-bundle.pem 已存在 → 直接复用，不再读系统库
3. 否则用 powershell.exe 读 Cert:\LocalMachine\Root + Cert:\CurrentUser\Root，
   导出 PEM 写入 <configDir>\system-ca-bundle.pem
4. 触发条件：Windows 恒为真；非 Windows 仅在配置了代理时
```

因此：

- **后装的 CA 不会自动进入 bundle**；
- CA 已在 Windows 信任库也可能仍报错（bundle 陈旧）；
- 删 bundle 可触发重建，但更稳的做法是追加。

另：`WORKBUDDY_DISABLE_SYSTEM_CA=1` 会跳过 Windows 系统库，只剩 Node 内置根证书 +
`NODE_EXTRA_CA_CERTS`。不要设置。

---

## 4. 一次配置好

### 步骤 1：启动代理

```powershell
cd E:\projects\ai\opencode-proxy
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\start-proxy.ps1 -Mitm
```

确认输出：

```text
[proxy] HTTP   http://127.0.0.1:8787
[proxy] HTTPS  https://127.0.0.1:8789
[proxy] MITM   已开启：HTTPS 将在本地解密并记录明文
```

### 步骤 2：安装并同步 CA

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\trust-ca.ps1
# 或 cd https-proxy; npm run trust-ca
```

它做两件事：

1. 把 `certs/ca.pem` 导入「当前用户 → 受信任的根证书颁发机构」（已存在则跳过）；
2. 把 CA 追加到 `.workbuddy-ai\system-ca-bundle.pem`（已存在则跳过）。

正常输出：

```text
[trust-ca] Subject: CN=https-proxy local CA
[trust-ca] Thumbprint: 75688E94BF1968180378341C6C6C9B9597B26ADF
[trust-ca] 系统信任库已存在，跳过导入
[trust-ca] 已追加到 WorkBuddy bundle: C:\Users\vince\.workbuddy-ai\system-ca-bundle.pem
```

### 步骤 3：完全退出并重启 WorkBuddy

daemon 只在启动时读 `NODE_EXTRA_CA_CERTS`。托盘退出后确认：

```powershell
Get-Process -Name WorkBuddyAI,workbuddy-server -ErrorAction SilentlyContinue
```

### 步骤 4：设置代理并测试

设置 → 代理 → 手动：`https://127.0.0.1:8789`，然后点「测试连接」。
成功时 `daemon.log`：

```json
{"scope":"daemon-server:runtime",
 "message":["[ProxySettingsHandlers] testConnection: done, result.ok=true, ..."]}
```

---

## 5. 实测证据（2026-10-17）

**连接测试**

| 时间 | proxyUrl | 结果 |
|---|---|---|
| 10:52:47 | `https://127.0.0.1:8789` | ❌ `TLS / UNABLE_TO_VERIFY_LEAF_SIGNATURE` |
| 10:52:52 | `https://127.0.0.1:8787` | ❌ `WRONG_VERSION_NUMBER` |
| 11:04:37 | `https://127.0.0.1:8789` | ✅ `result.ok=true` |

**一条测试消息的流量**（`https-proxy/proxy.log`）

```text
11:05:04  POST https://www.workbuddy.ai/v2/chat/completions  1,250 B
          x-agent-type=auxiliary  x-agent-purpose=conversation_topic
          → 200 text/event-stream, 7,463 B

11:05:04  POST https://www.workbuddy.ai/v2/chat/completions  51,842 B
          x-agent-type=main  x-agent-purpose=conversation
          → 200 text/event-stream, 14,129 B

11:05:07  POST https://www.workbuddy.ai/v2/chat/completions  52,199 B
          x-agent-type=main
          → 200 text/event-stream, 10,053 B
```

身份头：

```text
user-agent: WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0
x-ide-type: WorkBuddy
x-ide-version: 5.8.4
x-agent-intent: craft
x-conversation-id: e6288684-f817-49d6-860e-2216cd84162c
traceparent / b3 / x-b3-traceid / x-b3-spanid
authorization: <明文，默认不脱敏>
x-device-token: v3:...
```

**会话状态机**（`.workbuddy-ai/logs/<date>/sdk/conversations/<id>.log`）

```text
11:05:04  planning
11:05:06  working   (agent_thought_chunk, tool_call)
11:05:07  planning
11:05:08  working   (agent_message_chunk)
11:05:09  runtime.applyStopReason  TURN_COMPLETED, stopReason=end_turn,
          hasFatalError=false, hasTurnError=false
```

**流量总览（40 分钟）**

```text
records=286
request 64 / response 63 / response_body 63 / connect 53
status: 200×50, 304×4, 204×1, 401×5, 404×3

www.workbuddy.ai        38
sg.tgalileo.com          6
tgalileo.com             5
static.workbuddy.cn      4
www.workbuddy.cn         3
tencent.sso.codebuddy.cn 2
```

---

## 6. 常见现象

### 6.1 大批 `ECONNRESET`

```text
connect_error host=www.workbuddy.ai   err=read ECONNRESET
connect_error host=sg.tgalileo.com    err=read ECONNRESET
mitm_error    err=read ECONNRESET
```

WorkBuddy **主动断开空闲隧道**（同刻会话日志出现
`runtime refresh requires worker restart` / `killWorker`）。请求已完成，不影响结果。

### 6.2 401 / 404

| 请求 | 状态 | 原因 |
|---|---|---|
| `tencent.sso.codebuddy.cn/api/v2/open-platform/buddy/entrance` | 401 | 未登录该 SSO |
| `www.workbuddy.cn/a2a/credentials/wecom-cli/tickets` | 401 | 企微凭据未配置 |
| `www.workbuddy.ai/api/v1/artifact-recommend/...` | 404 | 上游无此接口 |
| `www.workbuddy.ai/v2/feature-flag/api/feature-flags/check` | 404 | 上游无此接口 |

### 6.3 响应体是 Brotli

上游返回 `content-encoding: br`。代理会自动解压后记录，日志里同时有 `bytes`
（网络原始）与 `decodedBytes`（解压后），`preview` 为可读文本。

### 6.4 证书错误排查

```powershell
# a. CA 是否在 Windows 当前用户信任库
Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -match 'https-proxy' }

# b. WorkBuddy bundle 是否包含该 CA
node -e "const fs=require('fs'),{X509Certificate}=require('crypto');const ca=new X509Certificate(fs.readFileSync('https-proxy/certs/ca.pem'));const s=fs.readFileSync(process.env.USERPROFILE+'/.workbuddy-ai/system-ca-bundle.pem','utf8');const b=s.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[];console.log('contains CA:',b.some(x=>{try{return new X509Certificate(x).fingerprint256===ca.fingerprint256}catch{return false}}))"

# c. 代理 8789 自身证书
node -e "const https=require('https'),fs=require('fs');https.get('https://127.0.0.1:8789/__proxy/health',{ca:fs.readFileSync('https-proxy/certs/ca.pem')},r=>{console.log(r.statusCode);r.resume()}).on('error',e=>console.error(e.code,e.message))"
```

a 假 → 跑 `trust-ca.ps1`；a 真但 b 假 → 跑 `trust-ca.ps1` 后重启；c 失败 → 查证书/端口。

### 6.5 代理没收到流量

- WorkBuddy 是否真的重启过；
- `settings.json` 的 `http.proxy` 是否写成了 `https://127.0.0.1:8787`（协议错）；
- 代理是否在跑：`Get-NetTCPConnection -LocalPort 8787,8789 -State Listen`；
- 部分请求走 WorkBuddy 内部路由（`network-failover.jsonl` 里
  `routeMode: disabled / kill_switch`），不经过外部代理。

---

## 7. 相关文件

| 路径 | 说明 |
|---|---|
| `%USERPROFILE%\.workbuddy-ai\settings.json` | 设置（`http.proxy`） |
| `%USERPROFILE%\.workbuddy-ai\system-ca-bundle.pem` | 它的 CA bundle |
| `%USERPROFILE%\.workbuddy-ai\logs\daemon.log` | 代理测试 / daemon 日志 |
| `%USERPROFILE%\.workbuddy-ai\logs\<date>\sdk\conversations\` | 会话事件日志 |
| `%USERPROFILE%\.workbuddy-ai\logs\network-failover.jsonl` | 内部路由决策 |
| `https-proxy/scripts/trust-ca.ps1` | 同步 CA 的脚本 |

---

## 8. 安全与合规

- `certs/ca.key` 是本机 HTTPS 的万能钥匙：只留本机；
- 默认 `LOG_REDACT_HEADERS=false`，`authorization`、`x-device-token` 等**明文入库**；
  需要脱敏时设 `LOG_REDACT_HEADERS=true`；
- `*.log`、`https-proxy/certs*`、`.workbuddy-ai/` 已在 `.gitignore` 排除；
- 日志含用户 ID、会话 ID、trace ID、完整请求体，请勿外发；
- 仅用于调试**自己有权访问**的客户端与上游，不用于绕过访问控制。
