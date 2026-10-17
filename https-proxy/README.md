# https-proxy —— 通用本地 HTTP/HTTPS 请求观测代理

零第三方依赖的 Node.js 单文件代理，**只做两件事：转发、记录**（可选 MITM 解密）。
它不改写 URL、header 或 body；opencode 免费道的兼容改写见
[`../opencode-proxy-go/`](../opencode-proxy-go/README.md)。

## 文档（按 Agent 拆分）

| 文档 | 适用对象 |
|---|---|
| [`docs/README.md`](./docs/README.md) | 文档索引、端口分配、三分钟上手 |
| [`docs/proxy.md`](./docs/proxy.md) | **通用**：四种工作方式、启动、证书、日志、排障 |
| [`docs/opencode.md`](./docs/opencode.md) | **opencode CLI**：为什么标准代理抓不到、反向代理 + 自定义 provider |
| [`docs/workbuddy.md`](./docs/workbuddy.md) | **WorkBuddy AI**：`http.proxy` 设置、私有 CA bundle、实测证据 |

新增其它 Agent 时在 `docs/` 下再建 `<agent>.md` 并登记，通用机制只写在 `docs/proxy.md`。

## 快速开始

```powershell
cd E:\projects\ai\opencode-proxy
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\start-proxy.ps1 -Mitm
```

| 端口 | 协议 | 用途 |
|---|---|---|
| `8787` | HTTP | 标准代理 / 反向代理 |
| `8788` | HTTP | `opencode-proxy-go`（不归本目录） |
| `8789` | HTTPS | HTTPS 代理（先 TLS 再 CONNECT）/ 直连观测 |

健康检查：

```powershell
curl.exe -sS http://127.0.0.1:8787/__proxy/health
```

默认记录策略（2026-10-17 起）：

```text
LOG_BODY=true             完整请求/响应体
LOG_BODY_BASE64=true      额外保留 base64 原始字节
LOG_REDACT_HEADERS=false  完整 header（含 authorization / cookie / API key）
LOG_FILE=<https-proxy>/proxy.log  默认落盘
```

日志类开关默认全部打开；只有 `MITM` 仍需显式加 `-Mitm`。

> ⚠️ 日志含明文凭证。`.gitignore` 已排除 `*.log`、`https-proxy/certs*`、
> `.workbuddy-ai/`；仍请勿提交或外发。

## 目录

```text
https-proxy/
├── proxy.js               # 代理本体（零依赖）
├── package.json
├── scripts/
│   ├── generate-cert.ps1  # 本地 CA / 服务器证书 / 私钥
│   ├── start-proxy.ps1    # 启动（证书、端口顺延、环境变量）
│   ├── trust-ca.ps1       # 导入系统信任库 + 同步 WorkBuddy CA bundle
│   └── show-log.js        # 日志折叠查看
├── docs/                  # 按 Agent 拆分的接入文档
├── certs/                 # 运行时生成（gitignore，含私钥）
└── proxy.log              # 运行日志（gitignore）
```

## 常用命令

```powershell
cd https-proxy
npm start                 # 等价 node proxy.js
npm run cert              # 只生成证书
npm run trust-ca          # 导入 CA + 同步 WorkBuddy bundle

node scripts\show-log.js            # 最近 20 条摘要
node scripts\show-log.js -n 5
node scripts\show-log.js --all
node scripts\show-log.js --raw
```

## 与仓库其它部分的关系

| 位置 | 说明 |
|---|---|
| [`../opencode-proxy-go/`](../opencode-proxy-go/README.md) | opencode 免费道兼容代理（v2 改写 + SQLite 会话映射） |
| [`../scripts/start-opencode.ps1`](../scripts/start-opencode.ps1) | 设置代理环境变量并启动 opencode |
| [`../docs/`](../docs/README.md) | 设计与逆向分析文档 |

## 合规

仅用于调试**自己有权访问**的客户端与上游，不用于绕过第三方服务的访问控制。
日志包含 token / API key / 完整请求体等机密信息，请勿外发。
