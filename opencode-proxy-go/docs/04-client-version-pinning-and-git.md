# 04 · 固定客户端版本、Git 变化与编译验证

> 目标：在端点频繁变化的时期，用**可复现的客户端版本 + 明确的 git 基线**定位问题，
> 而不是依赖“最新 live catalog”带来的不确定性。

## 1. 为什么要固定客户端版本

- OpenCode 客户端从 **live catalog**（`https://models.opencode.ai/api.json`）读取
  provider 的 `api`，并作为 `baseURL`。
- 这意味着：**即使客户端二进制不变，服务端目录变化也会改变实际请求地址**。
- 固定版本 + 记录 git 基线，可以区分：
  - 客户端代码变化；
  - 服务端目录变化；
  - 代理自身路由变化。

## 2. 拉取与切换 v2.0.32

仓库：`E:\projects\ai\opencode-v2`（remote `https://github.com/anomalyco/opencode`）

```powershell
cd E:\projects\ai\opencode-v2

# 网络不稳定时，先只拉目标 tag；失败就重试（GitHub 可能 reset/超时）
git fetch origin "refs/tags/v2.0.32:refs/tags/v2.0.32"

# 确认 tag 已到本地
git tag -l "v2.0.3*"      # v2.0.29 / v2.0.32

# 切换到 v2.0.32（detached HEAD，正常）
git checkout v2.0.32
git describe --tags --always
git rev-parse HEAD         # 843a6c51...（release: v2.0.32）
```

> 本仓库当前可能仍停在 `v2.0.29`（`042d0832`）。切换前先确认没有本地修改：
> `git status --short`。

## 3. Git 变化速查

```powershell
# 提交列表
git log --oneline v2.0.29..v2.0.32

# 规模
git rev-list --count v2.0.29..v2.0.32      # 120
git diff --stat v2.0.29 v2.0.32            # 655 files, +12534/-10463

# 关键协议提交
git show 1ca34aee --stat                   # #55680 protocol-specific endpoints
git show 1ca34aee -- packages/ai/src/providers/opencode.ts

# 免费模型默认选择
git show 8db638c5 -- packages/core/src/model.ts   # #55852 preferBigPickle
git show 4cce6aef -- packages/core/src/model.ts   # #55972 PREFERRED_FREE

# 内置目录快照的变化（单行巨型 JSON，建议用 Python 解析，不要直接 diff）
git diff v2.0.29 v2.0.32 -- packages/core/src/models-dev/snapshot.txt
```

关键提交：

| 提交 | 内容 |
|---|---|
| `1ca34aee` | `fix(ai): use protocol-specific inference endpoints` |
| `8db638c5` | 只有 free 模型时默认 `big-pickle` |
| `4cce6aef` | `PREFERRED_FREE` 优先级列表 |
| `d68cf94d` / `7049e5af` / `a20a614d` | 内置 models.dev 快照刷新 |

## 4. 内置快照 vs live catalog

| | 内置快照 | live catalog |
|---|---|---|
| 位置 | `packages/core/src/models-dev/snapshot.txt` | `https://models.opencode.ai/api.json` |
| v2.0.32 的 `opencode.api` | `https://opencode.ai/zen/v1` | **`https://opencode.ai/inference/openai/v1`** |
| 更新方式 | 随客户端版本 | 服务端每 12 小时刷新；客户端每 5 分钟缓存 |
| 是否可被客户端配置覆盖 | 可以 | 可以（provider `settings.baseURL`） |

> **重要**：v2.0.32 的 tag 里内置快照仍是 `/zen/v1`，但运行时会被 live catalog 覆盖。
> 所以“用 v2.0.32 就一定走 `/zen/v1`”是不成立的。

### 4.1 验证 live catalog 的 provider api

```powershell
# 直连或经出站代理（文件约 5.8 MB，网络慢时用较长超时）
curl.exe -sS --max-time 280 -x http://127.0.0.1:10810 `
  -o live-api.json https://models.opencode.ai/api.json
```

```python
import json
d = json.load(open("live-api.json", encoding="utf-8"))
for pid in ("opencode", "opencode-go"):
    print(pid, d[pid]["api"])
```

期望（2026-10-18）：

```
opencode https://opencode.ai/inference/openai/v1
opencode-go https://opencode.ai/inference/go/openai/v1
```

> 服务端可能不支持 Range，断点续传会失败；网络中断就重新下载。

## 5. 强制客户端走 `/zen/v1`

如果不想依赖 live catalog 的新地址，可以在 OpenCode 配置中显式覆盖 provider 的
`settings.baseURL`：

```json
{
  "provider": {
    "opencode": {
      "settings": {
        "baseURL": "https://opencode.ai/zen/v1"
      }
    }
  }
}
```

依据：

- `packages/schema/src/config/provider.ts` 的 `Settings` 使用
  `Schema.StructWithRest`，允许任意 `baseURL` 键；
- `packages/core/src/plugin/provider/opencode.ts` 读取 `item.settings?.baseURL`；
- provider 级 `settings.baseURL` 会覆盖目录里的 baseURL（并删除 model 级 `baseURL`）。

> 注意：这只改变客户端请求地址；**匿名准入仍然需要正确的 UA/session/body**。
> 如果使用本代理，更推荐让代理统一重写到 `/zen/*`（见 [02](./02-root-cause-and-fix.md)），
> 这样客户端不需要改配置。

## 6. 编译与运行（v2.0.32）

仓库使用 **Bun**（`packageManager: bun@1.4.2`）：

```powershell
cd E:\projects\ai\opencode-v2

# 前提：已安装 bun
bun --version

bun install

# 开发运行（CLI）
bun run dev

# 或按仓库脚本构建（以 packages/cli 的 build 脚本为准）
bun run --cwd packages/cli script/build.ts
```

> Windows 上若 `bun install` / GitHub fetch 受网络影响，优先使用可用代理，
> 并在失败后重试；不要假设一次 fetch 成功。

## 7. 用两个版本复现差异

```powershell
# 基线：v2.0.29（内置 /zen/v1，且当时 live catalog 尚未切换）
git checkout v2.0.29
bun run dev
# 通过代理请求 /v1/chat/completions，观察是否 200/429

# 对照：v2.0.32（代码变化 + live catalog 已切换）
git checkout v2.0.32
bun run dev
# 观察 baseURL 是否变成 /inference/openai/v1，是否 403 FreeTierError
```

建议同时记录：

- 客户端版本/tag/commit；
- live catalog 中 `opencode.api` / `opencode-go.api`；
- 代理 `/v1/*` 的改写结果（`resolveTarget`）；
- 上游实际路径（`/zen/*` 还是 `/inference/*`）；
- 上游状态码与错误类型。

## 8. 升级客户端版本检查清单

- [ ] `git fetch` 目标 tag 成功，`git describe --tags` 正确；
- [ ] `git diff --stat` 确认变更范围；
- [ ] 检查 `packages/core/src/models-dev.ts` 的 `defaultSource` 是否变化；
- [ ] 检查 live catalog 的 `opencode.api` / `opencode-go.api`；
- [ ] 检查 `packages/console/app/src/lib/inference-proxy.ts` 的路径表是否新增/改名；
- [ ] 检查 `packages/core/src/session/model-request.ts` 的请求头是否新增；
- [ ] 检查 `packages/core/src/model.ts` 的 free 默认选择逻辑；
- [ ] 跑本代理的 `go test -count=1 ./...`；
- [ ] 用客户端真实 baseURL 做一次 E2E，确认 403→200/429。

## 9. 本代理仓库的 Git 变化

```powershell
cd E:\projects\ai\opencode-proxy
git log --oneline -8
git diff --stat
```

本次修复涉及：

| 文件 | 变更 |
|---|---|
| `opencode-proxy-go/server.go` | 新增 `rewriteInferenceCompat`；`resolveTarget` 把裸 `/v1/*` 与旧 `/inference/v1/*` 改写到 `/zen/*`；扩展 `zenLaneRe`/`zenChatRe` |
| `opencode-proxy-go/server_test.go` | 新增 13 条路径映射断言 + 免费道识别断言 |

提交前建议：

```powershell
cd E:\projects\ai\opencode-proxy\opencode-proxy-go
gofmt -l .
go vet ./...
go test -count=1 ./...
go build -o proxy-go.exe .
```

回滚（确认不再需要新行为时）：

```powershell
cd E:\projects\ai\opencode-proxy
git checkout -- opencode-proxy-go/server.go opencode-proxy-go/server_test.go
```

> 不建议回滚到“裸 `/v1/*` → `/inference/v1/*`”的旧行为：
> 2026-10-18 实测该路径匿名直连已 403。

## 10. 备注

- `opencode-v2` 仓库可能是 detached HEAD；切换 tag 后不要直接 `git pull`，
  先确认当前分支/目标 tag。
- GitHub 在当前网络下容易 `Connection was reset` / `early EOF`；
  `git fetch origin refs/tags/<tag>:refs/tags/<tag>` 比 `fetch --all --tags` 更稳。
- live catalog 文件约 5.8 MB；解析时优先用 Python/`jq`，不要直接 `git diff`
  单行巨型 JSON。
