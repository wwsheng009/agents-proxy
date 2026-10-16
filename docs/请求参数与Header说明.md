# 请求参数与 Header 说明

> 用途：集中说明 opencode → `https://opencode.ai/zen/v1/chat/completions` 请求的**全部参数与 header**（来源代码、服务端处理、实验证据）、ID 唯一性机制、以及每个参数对应的分析脚本。
> 关联文档：准入校验与判别实验的完整结论见 [分析-会话标识与免费额度校验.md](./分析-会话标识与免费额度校验.md)；代理设计与合规见 [方案.md](./方案.md)。
> 源码基线：opencode `v1.18.32`（commit `545f51d`）；抓包基线：`data/replay/manifest.json`（5 条请求）。

## 1. 请求概览

- **方法/端点**：`POST https://opencode.ai/zen/v1/chat/completions`（SSE 流式，`stream: true`）
- **认证**：`authorization: Bearer public`（未登录匿名路径；登录后会是账号 token）
- 已捕获的 5 条请求：

| # | 记录 id | 时间 (UTC) | 字节 | 完整? | session / request 头 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `muc7umlx-1qdmbboy` | 05:11:00.598 | 2467 | ✅ | 原始 `ses_…` / `msg_…` | 标题生成（payload 完整，判别实验基座） |
| 2 | `muc7unhs-0gi9390t` | 05:11:01.744 | 35387 | ❌ 仅 4000B | 同上（**同一 msg**） | 主对话请求，日志预览被截断 |
| 3 | `muc7ur4h-n0497vft` | 05:11:06.450 | 35809 | ❌ 仅 4000B | 同上（**同一 msg**） | 后续调用，同会话同消息 |
| 4 | `muc7xyrj-kd2vztfk` | 05:13:36.320 | 346 | ✅ | `ses_curl_test_001` | 手工 curl 探针（非法 ID → 403） |
| 5 | `muc7y7l9-806olgm3` | 05:13:47.757 | 346 | ✅ | `ses_curl_test_002` | 手工 curl 探针（非法 ID → 403） |

> 关键观察：请求 1~3 的 `x-opencode-request` **完全相同**——一条用户消息可以触发多次 LLM 调用（标题生成 + 主对话），该 header 标识的是"触发本轮的用户消息"，不是"这一次 HTTP 请求"。

## 2. Header 全量清单

### 2.1 实际捕获到的 11 个 header

| Header | 实测值 | 客户端来源 | 服务端处理（证据） |
|---|---|---|---|
| `authorization` | `Bearer public` | 未登录时自动填充（`core/src/plugin/provider/opencode.ts:174-187`） | 匿名路径放行免费模型（`handler.ts:103-104, 695-698`），`billingSource="anonymous"`（:833） |
| `content-type` | `application/json` | AI SDK 请求构造 | 常规解析 |
| `user-agent` | `opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` | `request.ts:18` 定义 `opencode/${InstallationVersion}`，后两段由 ai-sdk/provider-utils 运行时追加 | **校验**：子串、大小写不敏感解析 `opencode/<semver>`，`>= 1.18.0`；解析失败 403、过旧 426（P8/P10/P11/P17/P18/P20~P22/P24） |
| `x-opencode-client` | `cli` | `request.ts:193` = `flags.client`；`effect/runtime-flags.ts:56` 环境变量 `OPENCODE_CLIENT`，默认 `cli`（可为 `app`/`desktop` 等） | **不校验**（P9 删除仍 200）；服务端用于埋点分类 |
| `x-opencode-project` | `global` | `request.ts:190` = `InstanceState.context.project.id`（仅 opencode provider） | **不校验**（P19 删除仍 200）；服务端用于 workspace 归属 |
| `x-opencode-session` | `ses_` + 26 位 | `request.ts:191` = `input.sessionID` | **校验（准入键）**：`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`，否则 403（P4/P5/P7/P12/P13/P16/P25） |
| `x-opencode-request` | `msg_` + 26 位 | `request.ts:192` = `input.user.id`（触发本次请求的用户消息 ID） | **不校验**（P15 整头省略仍 200；伪造值 200）；用于埋点/sticky/用量归属 |
| `accept` | `*/*` | curl / AI SDK 运行时 | 常规 |
| `accept-encoding` | `gzip, deflate, br, zstd` | 运行时 HTTP 栈 | 常规 |
| `content-length` | 各请求不同 | HTTP 栈自动计算 | 每次请求唯一必变的 header（proxy.log 5 请求对比结论） |
| `host` | `opencode.ai` | HTTP 栈 | —（重放脚本跳过，不手工伪造） |

### 2.2 代码里存在、但本次未捕获到的条件性 header

| Header | 条件 | 来源 |
|---|---|---|
| `x-parent-session-id` | 存在父会话（子任务/subagent）时 | `request.ts:201` |
| `x-session-affinity`、`X-Session-Id` | **非** opencode provider 分支（值都是 sessionID） | `request.ts:197-198` |
| provider 自定义 headers | `input.model.providers` 配置合并 | `request.ts:202` |
| 插件注入 headers | `chat.headers` 插件钩子（`request.ts:134-146, 203`），如 STT/TTS 插件的 region header | `chat.headers` trigger |

合并顺序（`request.ts:187-204`）：opencode 分支头 → `x-parent-session-id` → `model.headers` → 插件 `headers`（后者可覆盖前者）。

### 2.3 User-Agent 的两个格式（勿混淆）

```text
request.ts:18   LLM 请求:   opencode/<InstallationVersion>            // + ai-sdk 运行时追加段
installation/index.ts:41-45  userAgent(): opencode/<channel>/<version>/<client>   // 其他 API 链路用
```

服务端版本门的匹配规则（P22/P24 确立）是"在 UA 中子串搜索 `opencode/<数字>.<数字>…`"。据此**推导**（未单独探针）：

- `opencode/1.18.32 …` → 匹配 ✅（实测 P0 等全部 200）
- `opencode/latest/1.18.32/cli` → `opencode/` 后紧跟的是通道名 `latest` 而非数字 → **推导不匹配，应 403**——这解释了为什么 LLM 请求不用 `userAgent()` 格式而单独定义 `request.ts:18`。

## 3. Body 参数

### 3.1 顶层字段（基座 payload `muc7umlx-1qdmbboy.json` 实测）

| 字段 | 值 | 说明 |
|---|---|---|
| `model` | `mimo-v2.5-free` | opencode zen 免费模型（`allowAnonymous`，匿名可调） |
| `max_tokens` | 数值 | 模型/agent 配置决定 |
| `temperature` | 数值 | 模型/agent 配置决定 |
| `messages` | 3 条：`system, user, user` | 完整会话上下文（非增量） |
| `stream` | `true` | SSE 流式 |
| `stream_options` | 对象 | 流式补充选项（如 usage 统计） |
| `tools` | 0 个 | 标题生成请求不带工具；对话请求通常携带工具清单 |

基座 payload 的首条 user 内容为 `"Generate a title for this conversation:\n…"`（opencode 的自动标题生成，这就是请求 #1）。

### 3.2 与抓包完整度相关的代理参数

| 参数 | 默认 | 影响 |
|---|---|---|
| `LOG_BODY` | `false` | 关闭时 body 只记字节数与摘要；开启才有 `preview` |
| `MAX_PREVIEW_CHARS` | `4000` | 预览字符上限——请求 #2/#3（35KB）因此被截断、`complete:false` |
| `MAX_BODY_LOG_BYTES` | `16384` | body 预览字节上限 |
| `LOG_SENSITIVE_HEADERS` | `false` | 关闭时 `authorization` 等记为 `[redacted]`（manifest 中能看到明文 `Bearer public` 是因为该值非机密） |

**复现完整 payload 的做法**：`LOG_BODY=true` + `MAX_PREVIEW_CHARS`/`MAX_BODY_LOG_BYTES` 调到大于目标请求体积，再跑一次会话。

### 3.3 `reasoning_effort`（2026-09-22 补测：协议定位 + 上游值域）

**字段定位（OpenAI 官方协议）**：`reasoning_effort` 是 OpenAI **标准参数**，同时存在于 Chat Completions 与 Responses API。协议依据采用官方 SDK 类型定义（由 OpenAI OpenAPI spec 直接生成，2026-09 现状）：

- `openai-node` `src/resources/shared.ts:364`：`type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null`；
- `openai-python` `src/openai/types/shared/reasoning_effort.py`：`Optional[Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]]`；
- 官方注明："Not all reasoning models support every value"（并非所有推理模型都支持每个取值，见 reasoning guide 模型支持矩阵）。

即：**官方法定取值 7 个**（`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`），`max` 是合法值（早前"max 非官方值"的预判作废）。

**上游实测值域**（单变量：H13 基准 body = G1 真实形态减 effort，模型 `mimo-v2.6-flash-free`，完整身份头；仅改 `reasoning_effort` 值，见 `scripts/experiments/replay/run-effort-values*.py`）：

| `reasoning_effort` | 上游结果 | 说明 |
|---|---|---|
| 缺省 / `none` / `low` / `medium` / `high` | **200** | medium 两次复核均 200 |
| `max` / `minimal` / `xhigh` / 任意非法值 | **500** `Internal server error` | max 与 H 系列历史复现一致 |

→ 上游（`mimo-v2.6-flash-free` 后端）**只认 `{none, low, medium, high}` 四值**，恰好是官方新增 `minimal/xhigh/max` 之前的旧枚举；新档位与非法值一律 500。行为与官方"not all models support every value"逐字对应。

**结论（aicli 侧修复依据）**：`reasoning_effort:"max"` → 500 的根因是**取值超出该模型后端的支持面**，不是字段非法、也不是协议非标准。修复应**改值而非删字段**：`max → "high"`（保最高档语义，实测 200）或 `"medium"`。若由代理层转换，做**值降级映射**（`max/xhigh → high`、`minimal → low`）即可，无需剥离字段。

## 4. ID 与唯一性：每一条用户消息如何区分

### 4.1 生成器（`packages/schema/src/identifier.ts`，全文 30 行）

```ts
const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0   // 模块级状态（进程内共享）
let counter = 0

export function create(descending, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) { lastTimestamp = timestamp; counter = 0 }
  counter++                                   // 同一毫秒内 1,2,3,… 递增
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = /* 低48位 → 12位小写hex */
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12))  // 14 字节
  return time + /* 14 个 base62 字符: chars[byte % 62] */
}
```

### 4.2 `msg_` ID 的创建点

```text
packages/schema/src/session-message.ts:12-14
  export const ID = startsWith("msg_") … statics: create: () => "msg_" + ascending()

packages/opencode/src/session/prompt.ts:656-657   ← 普通用户消息的主创建点
  const info: SessionV1.User = { id: input.messageID ?? MessageID.ascending(), role: "user", … }

prompt.ts:471                                     ← 合成用户消息（工具结果转用户输入）同样生成新 ID
prompt.ts:269/490、session.ts:707、compaction.ts  ← assistant/摘要消息也用 MessageID.ascending()
```

即：**每次创建一条消息对象，就现场调用一次 `ascending()`，得到一个全新的 `msg_` ID。**

### 4.3 唯一性的三层保障

| 层 | 机制 | 覆盖场景 |
|---|---|---|
| 1. 毫秒时间戳 | 48 位时间段 = `ms × 4096 + counter` 的低位 | 不同毫秒的消息 → 时间段必不同 |
| 2. 同毫秒计数器 | `lastTimestamp`/`counter` 模块级状态，同一毫秒内 `counter++` | **同一毫秒连发多条消息** → counter 1,2,3,… 各不相同 |
| 3. 随机后缀 | 14 位 base62 ≈ `62^14 ≈ 7.7×10^24` | 跨进程/跨机器碰撞（counter 是进程本地的）几乎不可能 |

所以"每一条用户消息都不一样"是**构造性保证**，不依赖任何去重查询：时间 + 计数器 + 随机数三者拼接。

### 4.4 header 语义：按消息而非按请求

- `x-opencode-request = input.user.id`：标识**触发本次 LLM 调用的那条用户消息**；
- 同一条用户消息触发的多次调用（标题生成、主对话、重试、子任务回传）**共享同一个 msg ID**——manifest 请求 #1/#2/#3 正是实证；
- 反过来，服务端/分析时要区分"哪一次对话轮次"，看这个 header 就够了；要区分"哪一次 HTTP 请求"，需要另行记录（如 `x-opencode-request` + 时间/流 ID）。

### 4.5 实测对拍

```text
ses_f3879bba0ffe… 时间段解码 → 2026-09-22T05:11:00.447Z（会话创建）
msg_0c786447b001… 时间段解码 → 2026-09-22T05:11:00.475Z（首条用户消息，晚 28ms）
同毫秒递增实证: now 与 now-2ms 生成的 ses 时间段 hex 差恰为 0x2000（=2×4096）
```

## 5. 服务端处理速查（详细证据见分析文档 §4/§5）

| Header | 准入判定 | 结论 |
|---|---|---|
| `x-opencode-session` | **必需且校验结构**：`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`，先于 UA 校验 | 唯一的"硬门槛" header |
| `user-agent` | **必需**：子串（大小写不敏感）解析 `opencode/<semver>` 且 `>= 1.18.0` | 失败 403 / 过旧 426 |
| `x-opencode-request` | 不校验（省略、伪造均 200） | 纯埋点/归属字段 |
| `x-opencode-client` | 不校验（删除仍 200） | 客户端类型埋点（cli/app/desktop） |
| `x-opencode-project` | 不校验（删除仍 200） | workspace 归属埋点 |
| `authorization` | 走鉴权分流：`public` → 匿名免费路径 | 非 `public` 则走账号/API key 体系 |
| 其余（accept/encoding/content-length/host） | 传输层常规处理 | — |

## 6. 脚本文件映射

| 脚本 | 输入 | 输出 | 涉及的参数/header |
|---|---|---|---|
| `proxy.js` | 上游 `TARGET_BASE_URL` + 环境变量 | 终端 / `proxy.log`（JSON Lines） | 记录全部 header（敏感项默认脱敏）、body 摘要/预览；参数见 §3.2 |
| `scripts/start-proxy.ps1` | — | 启动代理 | `PORT`/`HTTPS_PORT`/`TARGET_BASE_URL`/`LOG_FILE`/`LOG_BODY`/`LOG_SENSITIVE_HEADERS` |
| `scripts/start-opencode.ps1` | — | 启动 opencode（注入 `HTTP_PROXY`/`NO_PROXY`/`NODE_EXTRA_CA_CERTS`） | 让流量经过代理 |
| `scripts/extract-payloads.js` | `proxy.log` | `data/replay/*.json` + `manifest.json`（含**每个请求的完整 header 快照**） | 判定 `complete`/`jsonParseOk`（预览是否截断） |
| `scripts/replay-payloads.js` | `manifest.json` + 本地 payload | 经本地代理重放到上游的 HTTP 状态 | 重放时跳过 `host/content-length/connection/transfer-encoding`，其余 header 原样 |
| `scripts/probe-session.js` | 基座 `muc7umlx-1qdmbboy.json` + `extra`~`extra6` 参数 | `data/replay/probe-matrix*.json`（24 针结果） | **单变量改 header**：session/UA/client/project/msg；内置 `makeId()` 复刻生成器 |
| `scripts/bin-ctx.js` | opencode.exe 二进制 + 搜索串（默认 `"ses_"`） | 命中点前后上下文 | 在**本地二进制**中验证 `"ses_"` 等字符串常量（源码与产物一致性抽查） |
| `proxy-go/`（Go 子模块） | config.yaml + 抓包 system 模板 | 本地监听 + `data/replay/proxy-go.db` | **独立代理服务**：header 重写/会话稳定映射/SQLite；门③自动修正（注入模板+强制流式+SSE→JSON） |
| `scripts/probe-response.js` | manifest 首条完整 payload（仅压小 `max_tokens` 强制快收流） | `data/replay/resp-headers.txt` + `resp-body.sse` | 抓**响应**头与完整 SSE，检查 usage/cost/限流字段（§8） |
| `verify-go/`（Go 子模块） | 24 针证据表 + 复刻双门规则 | 终端报告 / `data/replay/probe-matrix-go.json` | **验证程序**：离线 `go run .` 零耗额度；`-live` 在线重放比对；`go test` 含 ID 生成黄金向量；2026-09-22 在线复验 **24/24 匹配** |
| `scripts/generate-cert.ps1` | — | `certs/ca.pem`、`server.crt`、`server.key` | HTTPS 反代用，与上游 header 无关 |

常用命令：

```powershell
node scripts/extract-payloads.js                      # proxy.log → manifest + payload
node scripts/replay-payloads.js                       # 原样重放（对照 200）
node scripts/probe-session.js                         # P0~P3 主矩阵
node scripts/probe-session.js extra                   # 其余各组: extra/extra2…extra6
node scripts/probe-response.js                        # 抓完整响应头+SSE（费用/用量/限流字段）
go run -C verify-go .                                 # Go 版离线验证（24 针证据表×双门规则，零耗额度）
node scripts/bin-ctx.js <exe路径> '"ses_"'            # 二进制串上下文
```

## 7. 相关想法与待验证清单

**已形成的工作假设（有证据但仍属推断）：**

1. `x-opencode-session` 的角色是**会话亲和键**：服务端 sticky 路由（`handler.ts:172`）+ 用量按会话聚合（:1137）+ 准入结构校验三合一；结构校验的目的更可能是"挡掉明显非客户端流量"而非防伪（P1~P3 证明不查注册/签名）。
2. `x-opencode-request` 是**轮次键**：一条用户消息的多次 LLM 调用共享它，可用于服务端把标题生成/主对话归到同一轮。
3. `x-opencode-client`（`OPENCODE_CLIENT`）理论上可设为任意字符串（如 `app`）——服务端不校验，但**是否有下游行为差异未测**（不建议用于规避任何控制）。
4. `>= 1.18.0` 门槛的动机推测：该版本前后 header 语义/请求格式发生过变化，服务端据此淘汰旧客户端；具体原因闭源不可考。
5. `opencode/<channel>/<version>/<client>` 格式 UA 按已证规则推导会 403（§2.3），可作为一条廉价判别针验证匹配是否真的不锚定。

**可继续的判别实验（低优先）：**

- 随机段字符集逐枚举（`_`/`!`/空格/Unicode）；
- 版本解析边界：`opencode/1`、`opencode/1.18.0.1`、`opencode/01.18.0`；
- 小写时间 hex + 大写随机段混合已通过（生成器输出），单字符大小写敏感性矩阵；
- `body/URL/model` 维度：**2026-09-22 已补单变量实验（T1~T11）**——`body` **参与准入**（此前“仅 header”结论过窄）：门③ = `messages` 首条 system 含真实 opencode 模板内容 **且** `stream:true`（缺一 403，大小/user 内容无关；`proxy-go/fixup.go` 已按此自动修正）。`URL`/`model` 值仍为常量未单列。
- `x-parent-session-id`（子任务流量）出现时的服务端行为。

**代理改进想法：**

- 抓完整 body：`LOG_BODY=true` 且 `MAX_PREVIEW_CHARS`/`MAX_BODY_LOG_BYTES` ≥ 目标体积（§3.2）；
- 记录**响应** header（当前只记请求），可观察上游是否回传配额/限流头；
- 对 SSE 首帧打时间戳，量化 TTFT。

## 8. 响应侧：费用、用量与限流信息

> 实测脚本 `scripts/probe-response.js`；产物 `data/replay/resp-headers.txt`、`resp-body.sse`、`probe-response-payload.json`（2026-09-22）。

### 8.1 成功响应包含什么（实测）

**响应头（200，SSE）**：

```text
Date, Content-Type: text/event-stream, Transfer-Encoding, Connection,
Cache-Control: no-cache, Cf-Placement, Server, CF-RAY
rate-limit/quota 相关头: (none)  ← 成功响应不含任何限流头
```

原因：网关**响应头白名单**（`handler.ts:308-315`）只放行 `content-type`、`cache-control`，上游的 `x-ratelimit-*`、`x-opencode-endpoint-id` 等全部被剥离（其余头是 Cloudflare/框架自动加的）。

**SSE 尾部（`stream_options.include_usage=true` 时）**：

```text
data: {…"finish_reason":"length"…}
data: {…, "usage": {"prompt_tokens":530, "completion_tokens":64, "total_tokens":594,
       "prompt_tokens_details":{"cached_tokens":512, …},
       "completion_tokens_details":{"reasoning_tokens":63, …}}}   ← 上游透传的 token 用量
data: [DONE]
data: {"choices":[],"cost":"0"}                                  ← 网关注入的费用块
```

- **token 用量**：来自请求体 `stream_options:{"include_usage":true}`（§3.1）；非流式 200 则直接在 `usage` 字段。
- **费用块**：网关在流结束时追加（`handler.ts:397-398` → `buildCostChunk`，`provider.ts:169-180`，oa-compat 格式 = `data: {"choices":[],"cost":…}`）；**注意它出现在 `[DONE]` 之后**，标准 OpenAI 客户端在 `[DONE]` 即停止，通常读不到。
- **cost 数值语义**（`handler.ts:1065-1067`）：`billingSource === "balance"`（付费余额）→ `totalCostInCent/100`（美元，8 位小数）；**匿名/免费 → 恒为 `"0"`**。非流式响应对应 `json.cost`（`handler.ts:331`）。
- **opencode 客户端不读这个 cost 块**（全仓无 ping/cost chunk 解析）：它自己用 `tokens × 模型单价` 本地计算 `message.cost`（`session.ts:363-400`、`processor.ts:458-468`），存到消息的 `cost`/`tokens` 字段供 `/stats` 等展示。

### 8.2 限流/配额信息只出现在错误响应

成功响应**不含**“剩余次数/配额”字段；触顶时才通过错误返回（`handler.ts:480-532`）：

| 状态 | 错误类型 | 携带信息 |
|---|---|---|
| 429 | `RateLimitError` / `FreeUsageLimitError` / `GoUsageLimitError` / `BlackUsageLimitError` | **`retry-after` 头**（若有 retryAfter）+ 文案（`i18n/en.ts:387` “Rate limit exceeded. Please try again later.”）；Go 类额外 `metadata:{workspace, limitName}` |
| 401 | `CreditsError` / `MonthlyLimitError` / `UserLimitError` / `AuthError` / `ModelError` | 文案消息（余额/月限/用户限） |
| 403 | `RegionError` / `DataPolicyError` + FreeTier 准入类 | 文案消息 |

网关内部（不开源给客户端看的）：IP 限流 `ipRateLimiter.ts:40` 抛 `FreeUsageLimitError(retryAfter)`、key 限流 `keyRateLimiter.ts:28`（60s 窗口）、TPM/TPS/周月滚动限额（`handler.ts:853-950` 带 `limit`/`usage` 但只用于内部判定与上述错误）。每次成功调用的 usage+cost 由 `trackUsage` 写入计费表（含 `session_id`，`handler.ts:1137`），客户端无查询接口，只能从响应 usage 自行累计。

### 8.3 结论

| 问题 | 答案 |
|---|---|
| 返回中有 token 用量吗？ | **有**（需请求带 `include_usage`）：prompt/completion/total + 缓存/推理明细 |
| 返回中有费用吗？ | **有**：流式 `[DONE]` 后 `cost` 块 / 非流式 `json.cost`；免费匿名恒 `"0"`，付费余额为真实美元值 |
| 返回中有“剩余次数/配额”吗？ | **没有**；只有触顶时的 429/401 错误（含 `retry-after`、limit 文案、Go 类 `limitName`） |
| 返回有限流头吗？ | 成功响应被白名单清洗，**无** `x-ratelimit-*` |

## 9. 使用边界

本参数清单用于理解自有实例流量、兼容性排查与代理调试。不用于伪造客户端身份或绕过 free-tier/配额/授权限制（与 [方案.md](./方案.md) §9 一致）。
