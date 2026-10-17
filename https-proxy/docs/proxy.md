# proxy.md —— https-proxy 通用说明

> 适用于所有客户端。Agent 专项接入见 [`opencode.md`](./opencode.md)、
> [`workbuddy.md`](./workbuddy.md)。
>
> 实测环境：Windows + PowerShell 7 + Node v24.14.0（2026-10-17）。

---

## 1. 它是什么

零第三方依赖的 Node.js 单文件代理，只有三个能力：**转发、记录、（可选）解密**。
它**不改写** URL、header 或 body。

| 目录 | 角色 | 默认端口 | 是否改写 |
|---|---|---|---|
| `https-proxy/` | 通用 HTTP/HTTPS **观测**代理 | HTTP `8787` / HTTPS `8789` | 否 |
| `proxy-go/` | opencode 免费道**兼容**代理 | `8788` | 是 |

两者可同时运行，端口不能撞：

```text
127.0.0.1:8787  https-proxy  HTTP 监听
127.0.0.1:8788  proxy-go     兼容代理
127.0.0.1:8789  https-proxy  HTTPS 监听
```

---

## 2. 四种工作方式

### 2.1 标准 HTTP 代理（8787）

客户端把 `HTTP_PROXY` 指向 `http://127.0.0.1:8787`，请求行是绝对 URL：

```text
GET http://example.com/path HTTP/1.1
```

### 2.2 HTTPS 代理（8789，先 TLS 再 CONNECT）

`HTTPS_PROXY=https://127.0.0.1:8789` 时：

```text
客户端 ──TLS(到代理)──▶ https-proxy:8789 ──CONNECT host:443──▶ 上游
```

`8789` 是真正的 TLS 监听（`certs/server.crt`），同时接受普通 HTTPS 请求与 `CONNECT`。

> 注意 scheme 必须与监听协议一致：`http://…:8789` 会握手失败。

### 2.3 MITM 解密（`-Mitm` / `MITM=true`）

不开 MITM 时 `CONNECT` 是盲隧道，只能看到 `host:port` 与字节数。开启后：

```text
1. 客户端 CONNECT example.com:443
2. 代理回 200 Connection Established
3. 代理按 SNI 现签 example.com 证书（本地 CA 签发）
4. 客户端与代理完成 TLS（客户端必须信任 ca.pem）
5. 代理解密 HTTP/1.1 → 记录明文 → 以客户端身份重新 TLS 连上游
6. 上游响应 → 记录 → 回写客户端
```

限制：

| 项 | 行为 |
|---|---|
| 端口 | 只对 `CONNECT host:443` 解密；其它端口仍走盲隧道 |
| 协议 | 只协商 HTTP/1.1（不提供 h2）；SSE 不受影响 |
| WebSocket | 只记录握手头，之后字节透传 |
| 证书固定 / 双向 TLS | 抓不到 |
| 上游压缩 | 自动解压后记录（gzip / deflate / br / zstd），保留 `bytes` 与 `decodedBytes` |

### 2.4 反向代理（`TARGET_BASE_URL`）

```powershell
$env:TARGET_BASE_URL = "https://api.example.com"
$env:PORT = "8787"
node proxy.js
# 客户端 base URL → http://127.0.0.1:8787
```

适合不支持 `HTTP_PROXY`、但支持自定义 base URL 的客户端（opencode 就是这种，
见 [`opencode.md`](./opencode.md)）。

### 2.5 数据流

```text
                         ┌─────────────── 8787 (HTTP) ───────────────┐
客户端 ──HTTP───────────▶│  resolveTarget → forwardHttp → 记录        │──▶ 上游
客户端 ──CONNECT────────▶│  ├─ 盲隧道（MITM=false 或非 443）          │
                         │  └─ MITM：现签证书 → 解密 → 同一套转发      │
                         └───────────────────────────────────────────┘
                         ┌─────────────── 8789 (HTTPS) ──────────────┐
客户端 ──TLS────────────▶│  直接 HTTPS 请求 → forwardHttp             │──▶ 上游
客户端 ──TLS+CONNECT────▶│  CONNECT → 同上（MITM 或盲隧道）            │
                         └───────────────────────────────────────────┘
```

---

## 3. 启动与停止

### 3.1 推荐方式

```powershell
cd E:\projects\ai\opencode-proxy
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\start-proxy.ps1 -Mitm
```

脚本顺序执行：

1. 证书缺失 → 调用 `generate-cert.ps1`；
2. 设置 `PORT`（8787）、`HTTPS_PORT`（8789）、`LOG_FILE`、`TLS_*`；
3. **端口占用自动顺延**（最多 +20）；
4. 清掉自身 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`，避免回环；
5. 前台运行 `node proxy.js`，`Ctrl+C` 停止。

### 3.2 手动方式

```powershell
cd https-proxy
npm start          # 等价 node proxy.js
npm run cert       # 只生成证书
npm run trust-ca   # 导入系统信任库 + 同步 WorkBuddy bundle
```

### 3.3 健康检查

```powershell
curl.exe -sS http://127.0.0.1:8787/__proxy/health
curl.exe -sS --ssl-no-revoke --cacert https-proxy\certs\ca.pem https://127.0.0.1:8789/__proxy/health
```

```json
{"ok":true,"targetBaseUrl":null,"logBody":true,
 "logFile":"...\\proxy.log","redactHeaders":false,"httpsPort":8789,"mitm":true}
```

### 3.4 端口冲突

| 场景 | 行为 |
|---|---|
| HTTP 端口被占用 | 打印错误并以非零码退出 |
| HTTPS 端口被占用（脚本） | 自动顺延 |
| HTTPS 端口被占用（直接 `node proxy.js`） | 记 `https_error`，HTTP 继续服务 |
| `proxy-go` 占用 8788 | 预期行为 |

---

## 4. 环境变量

| 变量 | 默认（脚本） | 说明 |
|---|---|---|
| `PORT` | `8787` | HTTP 监听，只绑定 `127.0.0.1` |
| `HTTPS_PORT` | `8789` | HTTPS 监听；`0` = 禁用 |
| `TLS_KEY_FILE` / `TLS_CERT_FILE` | `certs/server.key` / `server.crt` | HTTPS 监听证书 |
| `TARGET_BASE_URL` | 空 | 反向代理目标；留空 = 仅标准代理 |
| `MITM` | `false` | 解密 CONNECT（需 CA + openssl） |
| `MITM_CA_CERT` / `MITM_CA_KEY` | `certs/ca.pem` / `ca.key` | MITM 签发 CA |
| `MITM_CERT_DIR` | `certs/mitm` | 按域名签发缓存 |
| `OPENSSL_BIN` | 自动探测 | 指定 `openssl.exe` |
| `LOG_FILE` | `<https-proxy>\proxy.log` | JSON Lines 追加；`off`/`false`/`none` = 不写文件 |
| `LOG_BODY` | `true` | 完整 body；`false` = 只记字节数与摘要 |
| `LOG_BODY_BASE64` | `true` | 额外附加 base64 原始副本（与 `preview` 并存） |
| `LOG_STDOUT` | `true` | `false` 时只写文件 |
| `LOG_REDACT_HEADERS` | `false` | **默认不脱敏**；`true` 才写 `[redacted]` |
| `LOG_SENSITIVE_HEADERS` | 空 | 旧变量名，兼容保留 |
| `UPSTREAM_TIMEOUT_MS` | `60000` | 上游超时 |

> **日志类开关默认全开**：不设任何 `LOG_*` 也会写文件、记完整 body 与 header。
> 只有 `MITM` 仍需显式开启（`-Mitm`），因为它要求客户端先信任本地 CA。

> `start-proxy.ps1` 会**继承当前 shell 的 `$env:` 值**。想回默认：
> `Remove-Item Env:HTTPS_PORT`，或开新终端。

---

## 5. 证书

### 5.1 文件

```text
https-proxy/certs/
├── ca.pem        # 本地 CA（需被客户端信任）
├── ca.key        # CA 私钥（勿外发）
├── ca.cer        # 同 CA 的 DER 格式（Windows 导入用）
├── server.crt    # 8789 监听证书（CN=localhost，SAN 含 127.0.0.1 / ::1）
├── server.key    # 8789 监听私钥
└── mitm/         # 按域名签发的缓存 + _leaf.key
```

### 5.2 生成与轮换

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\generate-cert.ps1
# 可选：-OutDir D:\certs -ValidDays 365
```

默认 **825 天**，CA 主题 `CN=https-proxy local CA`。

> 重新生成后指纹会变：必须重跑 `trust-ca.ps1` 并重启相关客户端，否则
> `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。

### 5.3 openssl 自动探测

顺序：`OPENSSL_BIN` → `Git\usr\bin` → `Git\mingw64\bin` →
`OpenSSL-Win64` → `OpenSSL-Win32` → `PATH`。启动日志会写：

```json
{"event":"mitm_openssl","bin":"C:\\Program Files\\Git\\usr\\bin\\openssl.exe","available":true}
```

找不到时 MITM 降级为盲隧道并记 `mitm_error`，代理仍可用。

### 5.4 客户端信任方式

| 客户端 | 做法 |
|---|---|
| Windows 全局（Chrome/Edge/Electron） | 导入「当前用户 → 受信任的根证书颁发机构」 |
| Node.js | `NODE_EXTRA_CA_CERTS=<...>\certs\ca.pem`（启动前） |
| Node.js（CA 已在系统库） | `node --use-system-ca` / `NODE_USE_SYSTEM_CA=1` |
| Python requests | `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE` |
| curl（Schannel） | `--cacert certs\ca.pem --ssl-no-revoke` |
| curl（OpenSSL） | `--cacert certs\ca.pem` |

Node 细节：

- `NODE_EXTRA_CA_CERTS` / `NODE_USE_SYSTEM_CA` 只在进程启动时读取；
- Node 24 的 `fetch` 默认不读 `HTTP_PROXY`/`HTTPS_PROXY`，需 `NODE_USE_ENV_PROXY=1`
  或 `node --use-env-proxy`；
- `--use-env-proxy` 对 `fetch` 生效，对 `https.get`/`axios` 默认 agent 不生效；
- 仅调试可用 `NODE_TLS_REJECT_UNAUTHORIZED=0`。

---

## 6. 日志

### 6.1 记录阶段

JSON Lines，用 `id` 串起同一请求：

| `direction` | 内容 |
|---|---|
| `connect` / `connect_error` | CONNECT 隧道建立 / 失败 |
| `request` | method、完整 URL、header（默认原样）、body |
| `response` / `response_body` | 状态码、响应头、响应体 |
| `error` | 转发失败 |
| `mitm_error` | 签发证书 / TLS 失败（可能带 `fallback`） |
| `upgrade` | WebSocket 握手 |
| `event` | `listening` / `https_listening` / `mitm_openssl` / `https_error` |

### 6.2 body

`LOG_BODY=true`（默认）：

- 可逆 UTF-8 → `preview` 全文；
- 二进制 → `rawBase64`；
- 超 64MB → 只留 `bytes` + `truncated`；
- 压缩响应自动解压，同时保留 `bytes`（原始）与 `decodedBytes`（解压后）；
  解压失败记 `decodeError` / `undecodedEncoding`。

`LOG_BODY=false` 时只记 `bytes` + 结构摘要（`model` / `stream` / `messages` / `tools`）。

### 6.3 header

**默认完整记录**，包括 `authorization`、`cookie`、`x-api-key`、`x-device-token`、
`x-access-token`、`x-refresh-token` 等。设 `LOG_REDACT_HEADERS=true` 才脱敏。

> ⚠️ 日志含明文凭证与完整请求体。`.gitignore` 已排除 `*.log`、`https-proxy/certs*`、
> `.workbuddy-ai/`；仍请勿外发或提交。

### 6.4 查看

```powershell
cd https-proxy
node scripts\show-log.js          # 最近 20 条
node scripts\show-log.js -n 5
node scripts\show-log.js --all
node scripts\show-log.js --raw
node scripts\show-log.js --file D:\x.log
```

---

## 7. 通用排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `EADDRINUSE 127.0.0.1:8788` | `proxy-go` 占用 | 正常，改用 8789 |
| `EADDRINUSE 127.0.0.1:8789` | 端口被占 | 脚本自动顺延，或清 `$env:HTTPS_PORT` |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 客户端未信任 CA | 见 §5.4 |
| `WRONG_VERSION_NUMBER` | 明文端口用了 `https://` | 8787 用 `http://`，8789 用 `https://` |
| `mitm_error: openssl 不可用` | openssl 不在 PATH | 设 `OPENSSL_BIN` |
| `certificate has expired` | 证书过期 | 重新生成 + 重新信任 |
| `ERR_TLS_CERT_ALTNAME_INVALID` | IP 访问但证书只签域名 | 用域名或传 `servername` |
| `preview` 为空 | 解压失败 / 不支持编码 | 看 `decodeError` / `undecodedEncoding` |
| 大量 `ECONNRESET` | 客户端主动断空闲隧道 | 正常，不影响已完成请求 |

---

## 8. 合规

仅用于调试**自己有权访问**的客户端与上游。不用于绕过第三方服务的访问控制。
日志可能包含 token、设备标识、个人信息；默认已 gitignore，请勿外发。
