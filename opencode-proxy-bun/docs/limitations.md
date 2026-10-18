# 限制与已知差异

> 本文件是 `opencode-proxy-bun` 的**限制项单一来源**。
> 其它文档（README、architecture、operations、migration）只做摘要并链接到这里。

## 1. 运行时：Bun 1.3.14+ / 1.4.x

- 已在远程服务器实测：Bun **1.3.14**、**1.4.2**、**1.4.3** 都能通过上游准入并返回 200。
- 早期“1.4.x 一律 403”的结论是**本地出口 IP/网络**被拒绝造成的，不是 Bun 版本本身；
  同一台远程服务器上，官方 OpenCode（内嵌 Bun 1.4.2）、独立 Bun 1.4.2/1.4.3 都正常。
- `src/index.ts` 启动时接受 `1.3.14+` 与 `1.4.x`；`1.5+` / `2.x` 未验证，直接退出。
- 启动脚本支持 `BUN_BIN`，也可以使用 `.bun1314` / `.bun142` 目录。
- 升级到 1.5+ 或更换出口网络前仍必须重新验证上游准入。

## 2. 流式：始终返回 SSE

- 代理会强制上游 `stream: true`（免费层准入要求），并把上游 SSE 原样流式返回。
- **当前没有把 SSE 组装回 JSON**。
- 使用流式请求的 OpenCode 客户端不受影响。
- 如果客户端要求非流式 JSON：
  - 继续使用 `opencode-proxy-go`（它会把 SSE 组装回 JSON）；或
  - 在本项目后续补充 `translate` 逻辑。

## 3. 鉴权：代理本身无鉴权

- 默认只监听 `127.0.0.1:8788`，不提供 API key/token 校验。
- 不要直接暴露公网；远程访问请用 SSH 隧道：
  ```powershell
  ssh -L 18788:127.0.0.1:8788 root@<server>
  ```
- 如果必须公开部署，必须在前面加带鉴权/限流的反向代理。

## 4. 监听地址：不支持 IPv6 括号写法

- `listen` 使用最后一个 `:` 分割 host/port。
- 支持 `127.0.0.1:8788`、`0.0.0.0:8788`；
- **不支持** `[::1]:8788` 这种 IPv6 字面量写法。

## 5. 持久化：只有 `session_map`

- 只有 `session_map` 表（incoming key → upstream `ses_`）。
- 没有 Go 版本的 `message_map` / `request_log` 表。
- 请求日志输出到 stdout，由 systemd/journald 收集，不落 SQLite。
- SQLite 采用 WAL；**不要让两个代理进程同时写同一个数据库文件**。
- 多实例部署时每个实例使用独立 `dbPath`，会话映射不共享。

## 6. 配置：JSON，且不包含旧兼容项

- 配置格式是 `config.json`，不是 Go 版本的 YAML。
- 不支持 `strip_prefix`。
- 不支持 `body_fixup.mode: inject_template`（1.x 遗留模式）。
- 只保留 `bodyFixup.mode: "v2"` / `"off"`。

## 6.1 出站代理：仅 http/https，行为受已验证 Bun 版本限制

- `proxy.url` / `proxy.noProxy` / `proxy.fromEnv` 已支持，作用范围仅限
  「本代理 → 上游」；入站连接不受影响。
- **不支持 SOCKS5**：当前验证的 Bun 1.3.14/1.4.x 对 `socks5://` 抛 `UnsupportedProxyProtocol`；
  配置 `socks5://` / `socks5h://` / `socks://` 会在启动时直接报错。
  需要 SOCKS5 请继续使用 `opencode-proxy-go`，或在本机加一层
  HTTP → SOCKS5 转换代理。
- **不读 `ALL_PROXY`**：实测 1.3.14/1.4.x 只认 scheme 对应的
  `HTTP_PROXY` / `HTTPS_PROXY`（大小写均可），`ALL_PROXY` 被忽略。
- **环境变量在进程启动时读取并缓存**：运行期修改 / 删除 `process.env` 无效；
   `proxy: false`、`respectNoProxy` 也被这些版本忽略，无法在请求级绕过环境变量。
  因此以下配置会直接拒绝启动（而不是静默走错路径）：
  - `proxy.fromEnv=false` 且 `HTTP(S)_PROXY` 非空；
  - `proxy.url` + 非空 `proxy.noProxy` 且 `HTTP(S)_PROXY` 非空
    （命中直连的请求不传 proxy 选项，会回落到环境变量代理）。
- **`noProxy` 的 CIDR 由本项目自行匹配**：Bun 原生的 `NO_PROXY` 不支持 CIDR
  （`10.0.0.0/8` 实测不命中）；本项目用自研匹配器实现，命中直连时不再传 proxy。
  但 `fromEnv=true` 时用的是 Bun 原生 `NO_PROXY` 语义，**不支持 CIDR**。
- 代理认证可内嵌在 URL（`http://user:pass@host:port`），Bun 会转成
  `Proxy-Authorization`；响应头 / 日志中的 `X-Proxy-Via` 会去掉凭据。
- `forwarder.addr` 仍然不需要：本项目单进程直接出站。

## 7. 上游额度：匿名免费层是全局/每日的

- 429 `FreeUsageLimitError` 表示**已过准入**，只是匿名额度/限流。
- 若响应带 `Retry-After`，按该时间等待；2026-10-18 实测重置点为
  **00:00 UTC / 08:00 CST**。
- 换 IP、换服务器、换 session、换模型都不能绕过日额度。
- 需要更高额度时使用真实 `OPENCODE_API_KEY` / Console 账号。

## 8. 上游指纹可能再次变化

- 当前通过 Bun 1.3.14 / 1.4.x 的 TLS/HTTP2 指纹。
- 上游未来可能再次调整指纹、路径、出口 IP 准入规则。
- 变更时应先：
  1. 用官方客户端验证是否仍可用；
  2. 检查 live catalog 的 `opencode.api`；
  3. 用不同 Bun 版本/客户端做重放对比；
  4. 再调整本项目，而不是继续改 headers/body。

## 9. 无重试、无熔断、无模型列表缓存

- 上游错误（4xx/5xx/网络错误）会原样/502 返回，不做自动重试。
- `/zen/v1/models` 直接代理，不缓存模型列表。
- 需要重试/熔断时由客户端或前置网关处理。
- 代理**不自动重启**；`run.ps1`/`run.sh` 默认启动的外部 watchdog 负责：
  连续 3 次 `degraded` 且“新进程直连正常”时才重启；`/healthz` 完全不可用时
  直接重启本地进程（不受上游探测结果影响）。
- watchdog 不重放用户请求，只重启进程；进行中的 SSE 会中断。
- watchdog 依赖 `/healthz` 的 403 计数；上游 5xx/429 会清零，不会触发重启。

## 10. 平台与进程管理

- 默认没有 Windows 服务安装器；用 `run.ps1` 或 `Start-Process` 启动。
- Linux 提供 `deploy/opencode-proxy-bun.service`（systemd）。
- 进程退出不会自动重启，除非由 systemd/外部守护管理。
- 日志默认输出到 stdout/stderr；生产环境交给 journald 或重定向文件。

## 11. 安全与数据

- `proxy.db` 可能包含客户端会话 key，注意文件权限。
- 真实 `OPENCODE_API_KEY` 不要提交到仓库或写入 `config.json` 的版本控制。
- 代理不记录请求 body；上游错误可能包含模型/请求信息，按需脱敏。
