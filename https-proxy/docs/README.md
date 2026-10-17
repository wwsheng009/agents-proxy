# https-proxy 文档索引

`https-proxy` 是**只转发、只记录**的本地 HTTP/HTTPS 观测代理。通用能力见
[`proxy.md`](./proxy.md)，各客户端（Agent）的接入方式分开维护，避免互相污染：

| 文档 | 适用对象 | 内容 |
|---|---|---|
| [`proxy.md`](./proxy.md) | 所有客户端 | 工作方式、启动、端口、证书、日志、通用排障 |
| [`opencode.md`](./opencode.md) | opencode CLI | 为什么标准代理抓不到、自定义 provider + 反向代理、与 `proxy-go` 的分工 |
| [`workbuddy.md`](./workbuddy.md) | WorkBuddy AI | Electron 结构、`http.proxy` 设置、私有 CA bundle、实测证据 |

新增其它 Agent（如 Cursor、Claude Code、CodeBuddy CLI）时，在本目录再建一份
`<agent>.md`，并在上表登记；通用机制写进 `proxy.md`，不要复制粘贴。

---

## 端口分配（先看这个）

| 端口 | 归属 | 协议 | 用途 |
|---|---|---|---|
| `8787` | `https-proxy` | HTTP | 标准代理 / 反向代理入口 |
| `8788` | `proxy-go` | HTTP | opencode 免费道兼容代理（会改写请求） |
| `8789` | `https-proxy` | HTTPS | HTTPS 代理（先 TLS 再 CONNECT）/ 直连观测 |

`https-proxy` 的启动脚本默认用 `8789` 作为 HTTPS 端口，避开 `proxy-go` 的 `8788`；
被占用时自动向后顺延最多 20 个端口。

---

## 三分钟上手

```powershell
cd E:\projects\ai\opencode-proxy

# 1) 启动（MITM 解密；HTTPS 在 8789）
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\start-proxy.ps1 -Mitm

# 2) 健康检查
curl.exe -sS http://127.0.0.1:8787/__proxy/health
```

默认配置（自 2026-10-17 起）：

```text
LOG_BODY=true            完整记录请求/响应体
LOG_BODY_BASE64=true     额外保留 base64 原始字节
LOG_REDACT_HEADERS=false 完整记录 header（含 authorization / cookie / API key）
LOG_FILE=<https-proxy>/proxy.log  默认落盘
```

日志类开关**默认全部打开**；只有 `MITM` 仍需显式加 `-Mitm`。

> ⚠️ 日志含明文凭证。`.gitignore` 已排除 `*.log`、`https-proxy/certs*`、
> `.workbuddy-ai/`；仍请勿提交或外发日志。

---

## 目录

```text
https-proxy/
├── proxy.js               # 代理本体（零依赖）
├── scripts/
│   ├── generate-cert.ps1  # 本地 CA / 服务器证书 / 私钥
│   ├── start-proxy.ps1    # 启动（证书、端口、环境变量）
│   ├── trust-ca.ps1       # 导入系统信任库 + 同步 WorkBuddy CA bundle
│   └── show-log.js        # 日志折叠查看
├── docs/                  # ← 本目录：按 Agent 拆分的接入文档
│   ├── README.md
│   ├── proxy.md
│   ├── opencode.md
│   └── workbuddy.md
├── certs/                 # 运行时生成（gitignore）
└── proxy.log              # 运行日志（gitignore）
```
