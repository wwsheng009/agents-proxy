# experiments —— 临时实验脚本（保留归档）

这些是 opencode-proxy 逆向过程中写过的一次性**判别 / 差分**脚本。保留它们的价值在于
**可复现结论**（对应 [分析-opencode-v2指纹与准入.md](../../docs/分析-opencode-v2指纹与准入.md)、
[分析-会话标识与免费额度校验.md](../../docs/分析-会话标识与免费额度校验.md)、
[过程与坑.md](../../docs/过程与坑.md)）。

它们**不是**产品运行路径的一部分。运维入口脚本（`../start-opencode.ps1`，以及已迁到
`../../https-proxy/scripts/` 的 `start-proxy.ps1`、`generate-cert.ps1`）与观测工具
（`../probe-session.js`、`../probe-response.js`、`../extract-payloads.js`、
`../replay-payloads.js`、`../bin-ctx.js`）不属于本目录。

> **拆分影响（2026-10-17）**：`smoke/*.mjs` 会 spawn 根目录的 `proxy.js`，该文件含 zen
> 兼容层，已在拆分中移除（通用观测部分迁到 `https-proxy/`）。因此 `smoke/` 下的脚本
> **不再可直接运行**，需从 git 历史提交 `1afd58a` 取回当时的 `proxy.js` 才能复现；
> 现行兼容层实现见 [`../../proxy-go/`](../../proxy-go/README.md)。

## 目录与用途

| 子目录 | 用途 | 脚本 |
|---|---|---|
| `bisect/` | 直连上游、单变量二分 body / header，逐针定位准入规则 | `bisect-body.js` ~ `bisect-body10.js`、`bisect-headers.js` |
| `replay/` | 经本机代理（默认 `127.0.0.1:8791/zen/v1/chat/completions`）重放，真实上游判定 | `run-g-tests.py`、`run-h-tests.py`、`run-h3-variants.py`、`run-h6.py`、`run-h7.py`、`run-h8-10.py`、`run-effort-values.py`、`run-effort-values2.py`、`run-precision.py`、`run-precision2.py`、`verify-g1-h10.py` |
| `tls-diff/` | TLS 栈指纹差分（node/bun/curl/python 同结果） | `tls-diff.js`、`tls-diff.py`、`tls-diff2.js`、`tls-diff3.js`、`tls-diff4.mjs` |
| `smoke/` | 兼容层与模型列表冒烟（自起拆分前的 `proxy.js`，**拆分后不可直接运行**） | `compat-final.mjs`、`models-test.mjs` |

## 运行前置

- **一律从仓库根** `E:\projects\ai\opencode-proxy` 运行（部分脚本依赖仓库根相对的 CWD 路径，脚本内没有 `chdir`）：
  - `bisect/bisect-headers.js` 读 `clean-capture.log`；
  - `tls-diff/tls-diff*.{js,py}` 读 `replay-headers.json` / `replay-body.json`（历史实验输入，当前仓库已无此文件，属归档残留）；
  - `replay/*.py` 读 `proxy.log` 与 aicli 请求日志（均为写死的绝对路径），需先按要求抓包生成输入。
- `bisect/*.js`、`compat-final.mjs`、`models-test.mjs`、`tls-diff4.mjs` 内含写死的绝对路径
  （`E:\projects\ai\opencode-proxy\...`），换机器需自行替换。
- `smoke/*.mjs` 会 `spawn('node', ['proxy.js'], { cwd: 仓库根 })`，分别占用 **8795 / 8796** 端口；
  拆分后根目录已无 `proxy.js`，需先从 git 历史 `1afd58a` 取回再运行。
- Python 脚本通过 `subprocess` 调用外部 `curl.exe`；`replay/*` 与 `bisect/*` 直连真实上游，
  注意免费额度（按 IP 约 200 请求/天，429 = 配额耗尽）。

## 命名约定

- `bisect-bodyN.js`：同一实验的递进版本（N 越大越新）；`bisect-headers.js` 为 header 变体。
- `run-<族>-<子集>.py`：G / H / precision / effort 判别族——`run-g-tests.py` = G 族、
  `run-h-tests.py` = H 族主集、`run-h3-variants.py` / `run-h6.py` / `run-h7.py` / `run-h8-10.py` = H 族子集。
- `verify-g1-h10.py`：G1 与 H10 深度 diff + 重复重放（区分确定性 500 与上游间歇 500）。
- `tls-diffN`：TLS 栈差分实验的递进版本。
