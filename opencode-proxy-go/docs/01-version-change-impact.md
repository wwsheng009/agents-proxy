# 01 · OpenCode v2.0.29 → v2.0.32 版本变化与影响

> 对照仓库：`E:\projects\ai\opencode-v2`（remote: `https://github.com/anomalyco/opencode`）
> 对比区间：`v2.0.29`（`042d0832`）… `v2.0.32`（`843a6c51`）

## 1. 版本规模

| 指标 | 数值 |
|---|---|
| 提交数 | **120** |
| 文件变更 | **655** |
| 行变更 | **+12,534 / −10,463** |
| 领域分布（提交数） | core 22、tui 11、app/desktop 8、ai 4、cli 4、mcp/plugin 3、docs 16、chore/ci 18、test 3、release 1、其它 27 |

> 说明：`v2.0.29` 是本次事件前本项目对齐的版本；`v2.0.32` 是当时最新 tag。
> 仓库当前 `HEAD` 仍可能停在 `v2.0.29`（detached HEAD），切换方法见 [04](./04-client-version-pinning-and-git.md)。

## 2. 与请求协议直接相关的提交

| 提交 | 标题 | 影响 |
|---|---|---|
| `1ca34aee` (#55680) | `fix(ai): use protocol-specific inference endpoints` | **最关键的协议变化**：把 `/inference/v1/*` 按 SDK 协议拆分为 `/inference/{openai,anthropic,google}/v1/*`；`@opencode/ai` 的 SystemOne baseURL 改为 `/inference/systemone/v1` |
| `8db638c5` (#55852) | `fix(core): default to big-pickle when only free OpenCode models are available` | 未登录且只有免费模型时，默认优先 `big-pickle` |
| `4cce6aef` (#55972) | `fix(core): prioritize preferred free OpenCode models when signed out` | 扩展为 `PREFERRED_FREE` 列表（见 §5） |
| `d68cf94d` / `7049e5af` / `a20a614d` | `chore(core): refresh bundled models.dev snapshot` | 内置模型目录快照刷新 |
| `78fa607a` / `6488d3da` | models.dev 快照每 12 小时刷新 | live catalog 与客户端解耦，服务端可先于客户端变化 |

## 3. 端点协议重组（#55680）

v2.0.29 的 Console/Go 端点是不带协议前缀的；v2.0.32 改为按 SDK 协议分命名空间：

| 用途 | v2.0.29 | v2.0.32 |
|---|---|---|
| OpenAI Responses | `https://opencode.ai/inference/v1/responses` | `https://opencode.ai/inference/openai/v1/responses` |
| Anthropic Messages | `https://opencode.ai/inference/v1/messages` | `https://opencode.ai/inference/anthropic/v1/messages` |
| OpenAI-compatible Chat | `https://opencode.ai/inference/v1/chat/completions` | `https://opencode.ai/inference/openai/v1/chat/completions` |
| Google Gemini | `https://opencode.ai/inference/v1/models/<id>` | `https://opencode.ai/inference/google/v1beta/models/<id>` |
| SystemOne（evaluation） | `https://opencode.ai/inference/v1/systemone` | `https://opencode.ai/inference/systemone/v1/systemone` |

同时 `packages/ai/src/providers/opencode.ts` 的 `baseURL` 从
`https://opencode.ai/inference/v1` 改为 `https://opencode.ai/inference/systemone/v1`。

> 注意：这条提交只改了 **SDK/文档端点**；真正让代理出错的是 live catalog 的
> `opencode.api` 变化（见 §4），它发生在服务端，不在 v2.0.32 的 tag diff 里。

## 4. live catalog：本次事件的真正触发器

客户端源码：

- `packages/core/src/models-dev.ts`：
  ```ts
  const defaultSource = "https://models.opencode.ai"
  ...
  ...(item.api ? { settings: { baseURL: item.api } } : {})
  ```
- 也就是说：**provider 的 `api` 字段 = 客户端实际请求的 baseURL**。
- 目录每 5 分钟缓存刷新一次，因此客户端可能在**不升级版本**的情况下改变上游地址。

2026-10-18 抓取 `https://models.opencode.ai/api.json`（约 5.8 MB）得到：

| provider | v2.0.32 内置快照 | live catalog（2026-10-18） |
|---|---|---|
| `opencode` | `https://opencode.ai/zen/v1` | **`https://opencode.ai/inference/openai/v1`** |
| `opencode-go` | `https://opencode.ai/zen/go/v1` | **`https://opencode.ai/inference/go/openai/v1`** |

free 模型的 per-model `provider.api` 分布（live catalog）：

| 模型组 | baseURL | 最终路径 |
|---|---|---|
| 绝大多数 free（`glm-5.3-flash-free`、`deepseek-v4.1-flash-free`、`beam-free`、`big-pickle` 等） | `/inference/openai/v1` | `/chat/completions` |
| `qwen3.6-plus-free`、`minimax-m3-free`、`minimax-m2.5-free`、`minimax-m2.1-free` | `/inference/anthropic/v1` | `/messages` |
| `muse-spark-1.2-contributor-free`、`muse-spark-1.3-contributor-free` | `/inference/openai/v1` + `@ai-sdk/openai` | `/responses` |

> 这也解释了为什么“模型列表已是最新（51 个模型）”仍会 403：
> **模型列表更新和端点准入是两件事**。

## 5. 免费模型与默认选择

- `PREFERRED_FREE`（未登录、只有免费模型时的默认优先级）：
  ```ts
  ["big-pickle", "deepseek-v4.1-flash-free", "glm-5.3-flash-free", "muse-spark-1.3-contributor-free"]
  ```
- 文档新增的 free 模型（部分）：`glm-5.3-flash-free`、`deepseek-v4.1-flash-free`、
  `beam-free`、`ll-alpha-free`、`space-bunny-free`、`longcat-2.5-preview-free`、
  `exo-free`、`mimo-v2.6-flash-free`、`mimo-v2.5-free`、`nemotron-*`、
  `muse-spark-1.3-contributor-free`、`jev-1.13-free`。
- `cat-jam-free` → **`beam-free`**（更名）。
- `step-5-preview-free`（无限额度）→ `step-5-preview`（requests 1720 / allowance 60 / bonus 4），
  但 opencode-go 侧仍保留 `step-5-preview-free`。
- live catalog 中 `opencode` 约有 127 个模型、42 个 free；`opencode-go` 约 32 个模型、4 个 free。

## 6. 客户端请求头（v2.0.32）

`packages/core/src/session/model-request.ts` 为每个模型请求注入：

```ts
"x-opencode-session-id": session.id,
"x-session-affinity": affinity,        // root: session.id；child/fork: 继承来源
"X-Session-Id": affinity,
"User-Agent": App.useragent(app),      // opencode/<channel>/<version>/<name>
"x-opencode-project": session.projectID,
"x-opencode-session": affinity,
"x-opencode-client": app.name,
```

其中：

- `App.useragent()` = `opencode/${channel}/${version}/${name}`；
- `app.name` 默认 `"opencode"`，CLI 实际使用 `"cli"`；
- `Project.ID.global = "global"`，因此 `x-opencode-project: global` 是合法值；
- `ses_` 算法与代理复刻一致：`prefix + 12 hex（时间低 48 位，ses 降序）+ 14 base62`。

## 7. 对代理的影响矩阵

| 入站路径（客户端/调用方） | 旧代理行为 | 结果 |
|---|---|---|
| `/v1/chat/completions` | 改写为 `/inference/v1/chat/completions` | **403**（匿名直连 `/inference/*` 已不放行） |
| `/zen/v1/chat/completions` | 原样 | 通过（429/200） |
| `/zen/go/v1/chat/completions` | 原样，但 `zenLaneRe` 不匹配 | 不注入身份头 → 403 |
| `/inference/v1/chat/completions` | 原样 | **403** |
| `/inference/openai/v1/chat/completions` | 原样 | 不注入身份头 → 403 |
| `/inference/anthropic/v1/messages` | 原样 | 不注入身份头 → 403 |
| `/inference/go/openai/v1/chat/completions` | 原样 | 不注入身份头 → 403 |

> 结论：**客户端换了 baseURL，代理的路径路由与准入目标必须同步迁移。**

## 8. 版本变化之外的注意点

- **live catalog 可以先于客户端版本变化**：即使客户端固定在 v2.0.32，运行时的
  `opencode.api` 仍会随服务端更新。版本固定只能固定代码，不能固定目录。
- **服务端准入是闭源的**：仓库里搜不到 `FreeTierError` 文案；
  只能通过真实探针与 `inference-proxy.ts` 的路由表反推。
- **错误文案有误导性**：`FreeTierError` 是“UA/session/匿名凭据/路径”未过的兜底错误，
  不是“客户端真实性验证”。详见 [02](./02-root-cause-and-fix.md)。
