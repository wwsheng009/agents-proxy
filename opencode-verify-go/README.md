# opencode-verify-go —— 准入规则验证程序（Go）

对 `https://opencode.ai/zen/v1/chat/completions` 的**双门准入规则**做可复算验证：
复刻判定逻辑 × 24 针实测证据表逐条比对。完整证据链见
[分析-会话标识与免费额度校验.md](../docs/分析-会话标识与免费额度校验.md) §4/§5。

## 规则（复刻自实验证据）

```
门① x-opencode-session: ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$   失败 → 403 FreeTierError（先执行，P23）
门② user-agent: 子串解析 opencode/<主>.<次>[.<修>]（大小写不敏感）
    解析失败 → 403 FreeTierError；版本 < 1.18.0 → 426 UpgradeRequired
其余（x-opencode-request / x-opencode-client / x-opencode-project / body）→ 不参与准入（P9/P15/P19）
```

另含 `identifier.ts` 的 Go 复刻：`ses_`（降序）/ `msg_`（正序）ID 生成与低36位时间解码，
黄金向量与原 JS 实现逐字节一致、抓包原始 ID 解码与文档记录时间戳互证。

## 实测记录（2026-09-22）

- 离线：`go run .` → **24/24 通过**；`go test ./...` → ok（6 组测试，含黄金向量与抓包 ID 解码）。
- 在线：`go run . -live` 全量 24 针 → **24 匹配 / 0 不匹配 / 0 不确定**（27.5s，exit=0），
  逐针结果落盘 `data/replay/probe-matrix-go.json`（predicted/actual/class/响应片段）。

## 用法

```powershell
# 离线验证（默认）：零网络、零额度消耗，复刻规则 × 证据表逐条比对
go run .

# 单组用例（前缀匹配）
go run . -case P2

# 单元测试（含黄金向量 / 结构边界 / 校验顺序）
go test ./...

# 在线验证：真实重放用例，比对实际状态码（⚠ 消耗免费额度）
go run . -live                 # 全部 24 针
go run . -live -case P23       # 只发一针
go run . -live -max-tokens 8   # 压小生成量省额度（默认即 8；0=原样）
```

- 在线模式自动探测 payload：`data/replay/muc7umlx-1qdmbboy.json`（在 `opencode-verify-go/` 内运行时回退 `../data/replay/…`）。
- 结果写入 `data/replay/probe-matrix-go.json`；`429/401/5xx` 归为 `inconclusive`（额度/系统），不构成准入证据。
- body 不参与准入（文档 §7 已注明为推断边界），因此压小 `max_tokens` 不改变判定。

## 文件

| 文件 | 内容 |
|---|---|
| `admit.go` | 复刻的双门判定（`sessionRe` / `uaRe` / 版本比较 / 顺序） |
| `identifier.go` | `identifier.ts` 复刻：MakeID/MakeSession/MakeMessage/DecodeTimeLow36 |
| `cases.go` | 24 针证据表（P0~P25，期望状态码取自 probe-matrix 实测） |
| `main.go` | CLI + 离线验证入口 |
| `live.go` | 在线探针（HTTP 重放 + JSON 结果落盘） |
| `admit_test.go` | 表驱动测试：证据表一致性、边界、顺序、黄金向量、抓包 ID 解码 |
