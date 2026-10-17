# opencode.md —— 用 https-proxy 观测 opencode

> 适用：opencode CLI（实测 v2.0.29，2026-10-17）。
> 通用代理机制见 [`proxy.md`](./proxy.md)；WorkBuddy 见 [`workbuddy.md`](./workbuddy.md)。
>
> 注意分工：`https-proxy` **只观测不改写**；让 opencode 免费道通过准入的改写逻辑在
> [`../../opencode-proxy-go/`](../../opencode-proxy-go/README.md)。两者用途不同。

---

## 1. 结论先行

标准代理模式（`HTTP_PROXY`/`HTTPS_PROXY`）**抓不到 opencode 的流量**。原因有三条，
都是实测得出的：

| # | 现象 | 结论 |
|---|---|---|
| 1 | 设置 `HTTP_PROXY`/`HTTPS_PROXY` 后 `opencode run` 照常成功，但代理日志零记录 | opencode 的 Bun 网络栈**不读**这两个环境变量 |
| 2 | 在配置里写 `provider.opencode.options.baseURL` / `providers.opencode.settings.baseURL` 均被忽略（`opencode debug config` 能看到配置已加载，请求仍直奔 `https://opencode.ai`） | 内置 provider 的 baseURL **不可覆盖** |
| 3 | 用 `OPENCODE_CONFIG` 声明自定义 OpenAI 兼容 provider，把 `baseURL` 指到代理 | ✅ **可行**，请求与 SSE 响应完整落盘 |

所以正确做法是：**反向代理模式 + 自定义 provider**。

---

## 2. 为什么不能靠 MITM 抓

理论上 MITM 可以解密任意 HTTPS 流量，但对 opencode 不成立：

- opencode 不读 `HTTP_PROXY`，根本不会把 `CONNECT` 发给代理；
- 若用系统级代理（Windows 全局 / WinHTTP），Bun 也未必遵循；
- 即使强行让流量进代理，内置 provider 仍会直连 `opencode.ai`，你抓到的是「可用的请求」，
  但无法修改 baseURL 做对照实验。

反向代理模式则把「客户端 base URL」直接指到代理，是最稳的观测点。

---

## 3. 操作步骤

### 步骤 1：启动反向代理

```powershell
cd E:\projects\ai\opencode-proxy

$env:TARGET_BASE_URL = "https://opencode.ai"
pwsh -NoProfile -ExecutionPolicy Bypass -File https-proxy\scripts\start-proxy.ps1
```

此时 `http://127.0.0.1:8787` 会把相对路径拼到 `https://opencode.ai`。
不需要 `-Mitm`：流量以明文 HTTP 进入代理，代理再用 HTTPS 连上游。

### 步骤 2：写一份临时 opencode 配置

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "observe": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Observe",
      "options": {
        "baseURL": "http://127.0.0.1:8787/inference/v1",
        "apiKey": "public"
      },
      "models": {
        "deepseek-v4.1-flash-free": { "name": "deepseek-v4.1-flash-free" }
      }
    }
  }
}
```

保存为例如 `C:\tmp\observe.json`。

### 步骤 3：启动 opencode

```powershell
$env:OPENCODE_CONFIG = "C:\tmp\observe.json"
opencode run --standalone --auto -m observe/deepseek-v4.1-flash-free "hi" < NUL
```

> 无 TTY 时必须重定向 stdin（`< /dev/null` 或 PowerShell 的 `< NUL`），
> 否则会一直等待输入而挂住。

### 步骤 4：看日志

```powershell
cd https-proxy
node scripts\show-log.js -n 5
```

---

## 4. 实测抓到的内容

```text
POST /inference/v1/chat/completions      body 约 22 KB
authorization: Bearer public             （默认原样记录）
user-agent: opencode/latest/2.0.29/cli
x-opencode-session / x-opencode-session-id / x-session-affinity / x-session-id
traceparent / b3
响应: 200 text/event-stream + 完整 SSE 原文
```

`LOG_BODY=true`（默认）时 `body.preview` 是完整请求 JSON，响应体同样是完整 SSE。

---

## 5. 与 opencode-proxy-go 的分工

| 需求 | 用哪个 |
|---|---|
| 观察 opencode 真实发出的请求 | `https-proxy` 反向模式（本文） |
| 让任意 OpenAI 客户端通过 opencode 免费道 | [`opencode-proxy-go`](../../opencode-proxy-go/README.md)（会改写 header/body） |
| 两者同时跑 | 可以：`https-proxy` 用 8787/8789，`opencode-proxy-go` 用 8788 |

`opencode-proxy-go` 的兼容改写（v2 身份头、`read` 工具、`stream:true`、会话映射）在
[`../../opencode-proxy-go/README.md`](../../opencode-proxy-go/README.md)；它不负责通用观测。

---

## 6. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 日志零记录 | 用了标准代理模式 | 改反向模式 + 自定义 provider |
| 请求仍打 `opencode.ai` | 配置没生效 | 确认 `OPENCODE_CONFIG` 指向正确；`opencode debug config` 检查 |
| `opencode run` 挂住 | 无 TTY 且未重定向 stdin | 加 `< NUL` |
| 404 / 403 | 路径或 provider 名写错 | `baseURL` 要以 `/inference/v1` 结尾，model 用 `-free` |
| 想要请求体但只有字节数 | `LOG_BODY=false` | 设为 `true` 重启代理 |

---

## 7. 合规

仅用于观察**自己有权访问**的 opencode 实例与上游。不用于伪造第三方客户端身份、
绕过 free-tier 配额或访问控制。日志含 token / 会话 ID，请勿外发。
