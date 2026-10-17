# docs —— 设计与逆向分析文档总索引

本目录收录 opencode-proxy 的**设计、参数手册与逆向分析**文档。使用说明与快速开始见仓库根
[README.md](../README.md)；代码与子项目入口见文末「相关代码」。

## 文档一览

| 文档 | 内容 | 定位 |
|---|---|---|
| [方案.md](./方案.md) | 代理整体设计：反向 / 标准双模式、抓包与脱敏、会话稳定映射、限制与合规边界（§9） | 设计与合规总纲 |
| [`../https-proxy/docs/`](../https-proxy/docs/README.md) | 观测代理接入文档（按 Agent 拆分）：[`proxy.md`](../https-proxy/docs/proxy.md) 通用、[`opencode.md`](../https-proxy/docs/opencode.md)、[`workbuddy.md`](../https-proxy/docs/workbuddy.md) | **使用手册 / 客户端接入** |
| [分析-opencode-v2指纹与准入.md](./分析-opencode-v2指纹与准入.md) | opencode v2（v2.0.29）请求指纹、`/zen/v1` → `/inference/v1` 端点迁移、v2 准入全解（read 工具门 + v2 session 算法 + `msg_` 毒头剥离）与代理适配记录 | **现行** v2 规则 |
| [请求参数与Header说明.md](./请求参数与Header说明.md) | 11 个实捕 header 全量清单、body 顶层字段、ID 唯一性机制（`msg_` 三层）、响应 usage/cost/限流 | 字段级参考手册 |
| [分析-会话标识与免费额度校验.md](./分析-会话标识与免费额度校验.md) | `x-opencode-session` 生成算法（源码级）+ 双门准入规则逆向：24 针 P 系列 + T1~T11 body 判别矩阵、证伪史、不可知项 | 逆向分析（1.x / 双门） |
| [过程与坑.md](./过程与坑.md) | 逆向全过程总账：时间线（P1~P24 / T1~T11 证据编号）、踩坑清单、成功请求三扇门完整要求 | 过程账本 / 排障索引 |

## 建议阅读顺序

1. [`../README.md`](../README.md) —— 安装、启动与使用；v2 免费道兼容现状。
2. [`../https-proxy/docs/`](../https-proxy/docs/README.md) —— 观测代理怎么用、证书怎么信；opencode / WorkBuddy 分别怎么接。
3. [`方案.md`](./方案.md) —— 代理设计意图与合规边界。
4. [`分析-opencode-v2指纹与准入.md`](./分析-opencode-v2指纹与准入.md) —— **现行**（v2）准入规则与指纹要求。
5. [`请求参数与Header说明.md`](./请求参数与Header说明.md) —— 逐字段手册，排查具体 header/body 时查。
6. [`分析-会话标识与免费额度校验.md`](./分析-会话标识与免费额度校验.md) —— 1.x / 双门规则的完整判别实验与证伪过程。
7. [`过程与坑.md`](./过程与坑.md) —— 全过程账本，按证据编号回溯单一结论时查。

> 注：1.x 三扇门（模板 + `stream` + 旧 session 算法）自 2026-09 后已失效；**现行以 v2 规则为准**，
> 新旧对照见 `分析-opencode-v2指纹与准入.md`。

## 相关代码

| 位置 | 说明 |
|---|---|
| [`../opencode-proxy-go/`](../opencode-proxy-go/README.md) | 独立 Go 代理服务（v2 兼容层 + SQLite 会话映射）——**opencode 兼容的现行实现** |
| [`../https-proxy/`](../https-proxy/README.md) | 通用 HTTP/HTTPS 请求观测代理（只转发+记录，无改写）；接入文档在 [`../https-proxy/docs/`](../https-proxy/docs/README.md) |
| [`../opencode-verify-go/`](../opencode-verify-go/README.md) | 准入规则离线验证程序（24 针证据表比对 + 可选在线重放） |
| [`../scripts/experiments/`](../scripts/experiments/README.md) | 一次性判别 / 差分 / 重放实验脚本（保留归档，结论可复现） |

> **拆分说明（2026-10-17）**：根目录的 Node 单文件 `proxy.js`（含 `ZEN_COMPAT` 兼容层）
> 已拆分为 `../https-proxy/proxy.js`（纯观测）+ `../opencode-proxy-go/`（兼容层）。
> 下文文档中出现的 `proxy.js` 兼容层描述均为拆分前实现的记录，代码见 git 历史提交 `1afd58a`。

## 合规声明

本目录文档用于理解**自有** OpenCode 实例的流量结构、会话标识与上游校验行为，以及排查兼容性问题。
结论与探针脚本**不用于**伪造第三方客户端身份或绕过 free-tier / 配额 / 授权限制
（与 [`方案.md`](./方案.md) §9 一致）。
