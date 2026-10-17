# 分析-opencode v2 请求指纹与免费道准入（v2.0.29）

> 2026-10-15 实测 + v2.0.29 源码（tag `v2.0.29`，commit `042d083`）交叉验证。
> 前置结论：1.x 三扇门体系（见 `过程与坑.md`）自 2026-09 后已失效，匿名伪造调用一律 403；
> 本文档记录 v2 客户端真实指纹与新版准入模型，以及本代理的适配方式与边界。

## 一、实验矩阵（本机全部实测）

| 调用方式 | model=deepseek-v4.1-flash-free | 结论 |
|---|---|---|
| opencode-proxy（1.x 兼容层补齐三扇门） | ❌ 403 FreeTierError | 1.x 准入已升级，形态校验不够 |
| 源码 v1.18.32 `bun run dev run` | ❌ 403 | 真实旧客户端也被拒 |
| 源码 v1.19.0 `bun run dev run`（含 big-pickle 对照） | ❌ 403 | 同上；v1.19 已出现 ConsoleMigration 过渡 |
| **官方安装 opencode v2.0.29** | ✅ 200 | 新通道可用 |
| **源码自建 v2.0.29 二进制**（`OPENCODE_VERSION=2.0.29 bun run --cwd packages/cli build --target=opencode-windows-x64 --skip-web-ui`） | ✅ 200 | 与官方版行为一致 |
| 官方 v2.0.29 但 baseURL 重定向到本地代理 | ❌ 403 | 唯一差异是连接路径 → 准入含通道/链路信任，非纯 header 形态 |

补充：
- `verify-go` 24 针在线重放：全部 410（Go 时代抓包 payload 的 model `mimo-v2.5-free` 已 410 ModelDeprecated，换 `mimo-v2.6-flash-free` / `deepseek-v4.1-flash-free` 则 403 FreeTierError）。
- 出口 IP `loc=CN`（cf-placement remote-ORD/SEA/LAX 变动）；v1 源码中已有 `isModelCountryRestricted` 与 deepseek 非 free 变体 `region=cn` opt-in 逻辑，地理封锁是候选因素之一，但 v2 同 IP 直连可用，说明最终拦截点不是单纯国家码。

## 二、v2.0.29 请求指纹（真实抓包，ZEN_COMPAT=false 透明转发）

请求（POST /zen/v1/chat/completions，title 2375B / agent 22283B）：

```
authorization: Bearer public                      # 未登录匿名 key（v2 仍沿用 "public"）
user-agent: opencode/latest/2.0.29/cli            # 新格式 opencode/<channel>/<version>/<artifact>
x-opencode-client: cli                            # artifact 名（v2 新语义）
x-opencode-session: ses_ec0c1f777ffet7Iu4ihfUz3HwZ   # 1.x 同款 ses_ 格式（12 hex 降序 + 14 随机）
x-opencode-session-id: ses_...                    # v2 新增：session 真实 ID
x-session-affinity: ses_...                       # v2 新增：粘性路由
x-session-id: ses_...                             # v2 新增
x-opencode-project: <40 hex 项目哈希>
b3: <traceid>-<spanid>-1-<...>                    # v2 新增：Zipkin B3
traceparent: 00-<traceid>-<spanid>-01             # v2 新增：W3C TraceContext
accept: */*
accept-encoding: gzip, deflate, br, zstd
content-type: application/json
```

body 特征：
- 仍强制 SSE；title 请求自带完整 "You are a title generator" 模板（1.x 门③模板在 v2 是自然产物，非注入）；
- agent 请求 system 为 "You are an AI agent running in OpenCode..."；
- `promptCacheKey` = session id 去 `ses_` 前缀（`model-request.ts:295`）；
- tools 为 v2 全新工具面（不再是 1.x 12 工具白名单）。

源码锚点：
- header 组装：`packages/core/src/session/model-request.ts:282-292`
- UA 构造：`packages/core/src/app.ts:24-26`（`opencode/${channel}/${version}/${name}`）
- 版本常量：`packages/cli/src/version.ts`（构建期 define `OPENCODE_VERSION/CHANNEL/ARTIFACT`）
- 匿名 key 注入：`packages/core/src/plugin/provider/opencode.ts:339-345`（无 key 时 `apiKey: "public"`）
- provider api 端点：`packages/core/src/models-dev/snapshot.txt` → `opencode.api = https://opencode.ai/zen/v1`

## 三、v2 准入模型（与 1.x 三扇门对照）

| 层 | 1.x（已失效） | v2（现行，2026-10-15 实验测定） |
|---|---|---|
| 端点 | `POST /zen/v1/chat/completions` | **`POST /inference/v1/chat/completions`**（live catalog `models.opencode.ai/api.json` 的 `opencode.api`；旧 zen 端点 2026-10-15 实测 403，但 2026-10-16 复验在 `read` 注入后**同样 200** —— **闸门不是端点**，见 §四 复验记录） |
| 会话 ID | `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`，先截断再取反 | 同正则；**算法精确形态**：`current = ms*0x1000+counter`，ses_ 取 `(~current) & 0xFFFFFFFFFFFF` hex（降序），msg_ 取 `current & mask`（升序）——先截断再取反的结果不同，必须按 v2 源码顺序（`packages/schema/src/identifier.ts`） |
| 鉴权 | `Bearer public` | 保留 `Bearer public` |
| UA | `opencode/<semver>` | `opencode/<channel>/<version>/<artifact>`（`opencode/latest/2.0.29/cli`） |
| body.stream | 必须 true | **必须 true**（`stream:false` → 403，针 W） |
| body.tools | 12 真实工具 schema 且 ≥2 个 | **必须含名为 `read` 的 opencode 工具**（名称匹配即可；schema 可改、可混入任意自有工具；`read` 单工具即过——针 T/H；外来工具再多没有 read 也 403——针 O） |
| system 内容 | 真 title 模板（无完整身份头时必需） | **完全不校验**（极简 user 消息即可——针 E/G） |
| `x-opencode-request`（msg_） | 可选 | **禁止发送**：真实 v2 客户端不发此头，带上即 403（bisect-headers 针 2） |
| `x-opencode-project` | 不校验 | 不校验（`global` 即可——针 Z） |
| traceparent/b3 | 无 | 不校验（可发可不发——针 3） |
| TLS 栈 | 无关 | 无关（node/bun/curl/python 全部同结果——tls-diff 实验） |
| ~~通道信任~~ | — | **不存在**：此前"需官方分发链路/CF-Access"的判断被推翻——本地铸造合法 ses_ + read 工具 + stream:true 即 200（针 Y/compat-final） |

**v2 最终准入规则（全部单变量实验可复现，脚本在 `scripts/experiments/bisect/bisect-body*.js`、`bisect-headers.js`）**：

```
POST https://opencode.ai/inference/v1/chat/completions
  Authorization: Bearer public
  User-Agent: opencode/latest/<semver>/cli
  x-opencode-session: ses_<v2 算法铸造>       （本地铸造即可，无需注册）
  body.stream: true
  body.tools 含 name="read" 的 opencode 工具
禁止 x-opencode-request 头
其余全部不校验
```

合规与使用路径：
1. **本代理兼容层现已完整支持 v2 规则**（见 §四），第三方 OpenAI 客户端可直接使用；
2. 官方 v2 客户端照常可用（同一规则体系）；
3. 免费额度仍按 IP 限流（200 请求/天），429 `FreeUsageLimitError` 表示配额耗尽，等窗口重置即可；
4. 旧 `/zen/v1` 端点已锁死（410/403），仅作观测历史。

> **勘误记录**：本文档 §三 曾两度给出错误结论（先称"通道信任不可伪造"，后称"IP 行为风控不可绕过"）。
> 真正原因链：① 端点迁移到 /inference/v1 未被发现（429/403 双层拒绝掩盖了端点错误）；
> ② session 铸造算法位序错误；③ msg_ 毒头。全部由同窗口 A/B 实验逐一排除后定位。

## 四、本代理（opencode-proxy）v2 适配（已完整打通，端到端 200 验证）

> **拆分说明（2026-10-17）**：本节描述的 `proxy.js` 兼容层（`ZEN_COMPAT`）已随拆分移除，
> 兼容改写现由 [`../proxy-go/`](../proxy-go/README.md) 实现（规则与本节逐条对齐）。
> 下文为拆分前 Node 实现的记录，代码见 git 历史提交 `1afd58a`。

`proxy.js` 兼容层（`ZEN_COMPAT`，默认开）当前行为：
- **端点路由**：`/v1/*` 与裸 OpenAI 路径 → `/inference/v1/*`；`/v1beta/models`（Gemini 探测）→ `/inference/v1/models`；`/zen/v1/*` 显式路径原样透传（2026-10-16 复验：`read` 注入后同样 200，见本节末尾复验记录）；
- **身份头**：`Bearer public`、UA `opencode/latest/2.0.29/cli`（`ZEN_USER_AGENT` 可覆盖）、v2 算法铸造 `ses_` 会话（同 key 稳定映射）、`x-opencode-session-id`/`x-session-affinity`/`x-session-id`、`traceparent`/`b3`；**删除 `x-opencode-request`（msg_ 毒头）**；
- **body 修正**：强制 `stream:true`（非流式调用方由 translate 组装回 JSON）；tools 缺 `read` 时自动注入 canonical `read` 工具 schema（调用方自有工具全部保留）——schema 取自外部 `opencode_tools.json`（**仓内根目录已自带一份满足准入的最小文件**，2026-10-16 起纳入跟踪），**取不到时只 warn 并跳过注入**，缺 `read` 的请求随即 403（见 `过程与坑.md` 坑 8）；`reasoning_effort` 值域降级映射保留；**不再注入 1.x 模板**（v2 不校验 system，注入反而污染响应）；
- **模型列表**：`/v1/models`、`/v1beta/models`、`/inference/v1/models` 全部返回上游 86 个模型（含 401 修复：models 路径同样注入兼容头）。

端到端验证（`scripts/experiments/smoke/compat-final.mjs`）：
```
POST http://127.0.0.1:8787/inference/v1/chat/completions   （或 /v1/chat/completions）
  极简 body：{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"Say ok"}]}
→ 200 {"choices":[{"message":{"content":"ok"},...}],"usage":{...}}
```
`auto` 协议探测（openai/anthropic/gemini models endpoint）全部 200（`scripts/experiments/smoke/models-test.mjs`）。

> **复验记录（2026-10-16）**：上面那条 200 **有前置条件**——极简 body 不带 `tools`，准入②是靠代理注入的 `read` 补上的，
> 因此必须存在工具面文件。同日在本机复验：工具面文件缺失时同一命令返回 403 `FreeTierError`
> （`scripts/experiments/smoke/verify-zen-tools-warn.mjs` 用例 `missing-file`）；把工具面文件补上后
> `/inference/v1` 与 `/zen/v1` **两条路径都 200**（各观测 2 次，抓包见 `fresh-capture.log`）。
> 即：**现行闸门是 body/tools 与会话，不是端点**——本节与 §三 表格中"旧 zen 端点已锁死"的说法均已按此勘误。

**使用方式**：任意 OpenAI 兼容客户端指向 `http://127.0.0.1:8787/v1`，api_key 任意值，model 填 `-free` 结尾的模型。免费额度按 IP 限流（200 请求/天），429 时等重置。

**剩余边界**：非 free 付费模型需要真实 Zen key（代理对付费道做纯透传）；上游偶发 502/超时重试即可。
