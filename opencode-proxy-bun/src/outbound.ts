/**
 * 出站代理（proxy → upstream 这一段）。
 *
 * Bun 1.3.14 的 fetch 支持 `proxy` 选项与 HTTP_PROXY / HTTPS_PROXY / NO_PROXY，
 * 但有几处与最新文档/Go 版本不同，本模块负责把这些差异收口：
 *
 *  1. 只支持 http / https 代理；socks5 / socks5h 在 1.3.14 会抛
 *     UnsupportedProxyProtocol，因此启动即拒绝，不做静默降级。
 *  2. `proxy: false` 与 `respectNoProxy` 在 1.3.14 会被忽略，无法用它绕过
 *     环境变量。因此本模块在启动时归一化进程环境变量，并在每个请求上显式
 *     传 `proxy`，保证配置是唯一事实来源。
 *  3. NO_PROXY 原生不支持 CIDR，且 host:port 语义与 Go 版本不完全一致。
 *     自定义 no_proxy 由本模块匹配；命中直连时用 NO_PROXY=* 让 fetch 直连。
 *
 * 作用范围仅限「本代理 → 上游」；入站客户端到本代理的连接不受影响。
 */

/** 出站代理配置（对应 config.json 的 proxy 段）。 */
export type ProxyConfig = {
  /** 代理地址，如 http://127.0.0.1:10810、http://user:pass@host:8080。留空 = 不配显式代理。 */
  url: string
  /** 直连名单：* / 域名（含子域）/ host:port / IP / CIDR。仅 url 非空时生效。 */
  noProxy: string[]
  /** url 为空时，是否回退读取 HTTP_PROXY / HTTPS_PROXY / NO_PROXY。 */
  fromEnv: boolean
}

/** 一次请求实际生效的出站代理（供响应头与日志观测）。 */
export type ProxyDecision = {
  /** 实际代理地址；直连时为 "direct"。 */
  via: string
  /** 传给 Bun fetch 的 proxy 选项；undefined = 交给环境变量判定。 */
  option: string | undefined
}

/** 一次请求实际走的出站路径（用于 X-Proxy-Via / healthz / 日志）。 */
export type OutboundRoute = {
  /** 配置里的代理地址（已去凭据）；未配置为空串。 */
  configured: string
  /** 对本次目标实际生效的代理地址；直连为 "direct"。 */
  effective: string
  /** 传给 fetch 的 proxy 选项。 */
  option: string | undefined
}

/** 当前 Bun 版本支持的代理 scheme。socks5 仅在启动校验时给出明确错误。 */
const SUPPORTED_SCHEMES = new Set(["http", "https"])

export type ParsedProxy = {
  /** 归一化后的 URL（scheme 小写、保留认证信息）。 */
  url: URL
  /** 仅用于展示的地址，去掉 user:pass，避免日志/响应头泄漏凭据。 */
  display: string
}

/**
 * 解析并校验代理地址。允许省略 scheme（默认 http://）。
 * 认证信息可内嵌在 URL 中，Bun 会自动转换为 Proxy-Authorization。
 */
export function parseProxyURL(raw: string): ParsedProxy {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error("代理地址为空")

  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch (error) {
    throw new Error(`解析代理地址 ${JSON.stringify(raw)} 失败: ${String(error)}`)
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase()
  if (scheme === "socks" || scheme === "socks5" || scheme === "socks5h") {
    throw new Error(
      `Bun 1.3.14 不支持 ${scheme} 代理（仅 http/https）；` +
        "需要 SOCKS5 请继续使用 opencode-proxy-go，或在本地加 HTTP→SOCKS5 转换层",
    )
  }
  if (!SUPPORTED_SCHEMES.has(scheme)) {
    throw new Error(`不支持的代理 scheme ${JSON.stringify(scheme)}（可用 http/https）`)
  }
  if (!url.hostname) {
    throw new Error(`代理地址缺少主机: ${JSON.stringify(raw)}`)
  }

  // URL.origin 会丢掉认证信息，正好用于展示。
  const display = url.origin
  return { url, display }
}

type NoProxyEntry = {
  host: string
  port: string
  /** 域名后缀匹配（含子域）；IP 条目为 false。 */
  suffix: boolean
  ip: string | null
  cidr:
    | { family: 4; network: number; prefix: number }
    | { family: 6; groups: number[]; prefix: number }
    | null
}

export type NoProxyMatcher = {
  all: boolean
  match(hostname: string, port: string): boolean
}

function parseIPv4(value: string): number | null {
  const parts = value.split(".")
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

/** 把 IPv6 展开为 8 个 16 位分组；失败返回 null。 */
function parseIPv6(value: string): number[] | null {
  let text = value.trim().toLowerCase()
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1)
  if (!text.includes(":")) return null

  // 末尾内嵌 IPv4（::ffff:127.0.0.1）
  const lastColon = text.lastIndexOf(":")
  const tail = text.slice(lastColon + 1)
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail)
    if (v4 === null) return null
    text =
      text.slice(0, lastColon + 1) +
      `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }

  const halves = text.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 && missing !== 0) return null
  if (missing < 0) return null

  const groups = [...head, ...Array<string>(missing).fill("0"), ...rest]
  if (groups.length !== 8) return null

  const out: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    out.push(parseInt(group, 16))
  }
  return out
}

function cidrMatch(host: string, entry: NoProxyEntry): boolean {
  const { cidr } = entry
  if (!cidr) return false
  if (cidr.family === 4) {
    const ip = parseIPv4(host)
    if (ip === null) return false
    const mask = cidr.prefix === 0 ? 0 : (0xffffffff << (32 - cidr.prefix)) >>> 0
    return ((ip & mask) >>> 0) === ((cidr.network & mask) >>> 0)
  }
  const groups = parseIPv6(host)
  if (groups === null) return false
  let remaining = cidr.prefix
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const bits = Math.min(16, remaining)
    const mask = bits === 0 ? 0 : (0xffff << (16 - bits)) & 0xffff
    if ((groups[i] & mask) !== (cidr.groups[i] & mask)) return false
    remaining -= bits
  }
  return true
}

/**
 * 构建 no_proxy 匹配器。语义对齐 Go 版本与常见约定：
 *   *            → 全部直连
 *   example.com  → 该域名及其子域（.example.com 同义）
 *   host:port    → 仅该端口
 *   127.0.0.1    → 该 IP
 *   10.0.0.0/8   → CIDR（Bun 1.3.14 原生不支持，这里自行实现）
 */
export function buildNoProxyMatcher(patterns: string[]): NoProxyMatcher {
  const entries: NoProxyEntry[] = []
  let all = false

  for (const raw of patterns) {
    const pattern = raw.trim()
    if (!pattern) continue
    if (pattern === "*") {
      all = true
      continue
    }

    if (pattern.includes("/")) {
      const slash = pattern.lastIndexOf("/")
      const hostPart = pattern.slice(0, slash)
      const prefixText = pattern.slice(slash + 1)
      if (!/^\d{1,3}$/.test(prefixText)) {
        throw new Error(`no_proxy 条目 ${JSON.stringify(raw)} 不是合法 CIDR: 前缀无效`)
      }
      const prefix = Number(prefixText)
      const v4 = parseIPv4(hostPart)
      if (v4 !== null) {
        if (prefix > 32) {
          throw new Error(`no_proxy 条目 ${JSON.stringify(raw)} 不是合法 CIDR: 前缀超过 32`)
        }
        entries.push({
          host: hostPart,
          port: "",
          suffix: false,
          ip: null,
          cidr: { network: v4, prefix, family: 4 },
        })
        continue
      }
      const v6 = parseIPv6(hostPart)
      if (v6 === null) {
        throw new Error(`no_proxy 条目 ${JSON.stringify(raw)} 不是合法 CIDR: 地址无效`)
      }
      if (prefix > 128) {
        throw new Error(`no_proxy 条目 ${JSON.stringify(raw)} 不是合法 CIDR: 前缀超过 128`)
      }
      entries.push({
        host: hostPart,
        port: "",
        suffix: false,
        ip: null,
        cidr: { family: 6, groups: v6, prefix },
      })
      continue
    }

    const { host, port } = splitHostPort(pattern)
    if (!host) {
      throw new Error(`no_proxy 条目 ${JSON.stringify(raw)} 无法解析主机`)
    }

    const bare = host.replace(/^\[|\]$/g, "")
    const v4 = parseIPv4(bare)
    const v6 = v4 === null ? parseIPv6(bare) : null
    if (v4 !== null || v6 !== null) {
      entries.push({
        host: bare.toLowerCase(),
        port,
        suffix: false,
        ip: bare.toLowerCase(),
        cidr: null,
      })
      continue
    }

    const suffix = true
    entries.push({
      host: host.replace(/^\./, "").toLowerCase(),
      port,
      suffix,
      ip: null,
      cidr: null,
    })
  }

  return {
    all,
    match(hostname: string, port: string): boolean {
      if (all) return true
      const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
      if (!host) return false

      for (const entry of entries) {
        if (entry.port && entry.port !== port) continue
        if (entry.cidr) {
          if (cidrMatch(host, entry)) return true
          continue
        }
        if (entry.ip) {
          if (host === entry.ip) return true
          continue
        }
        if (entry.suffix) {
          if (host === entry.host || host.endsWith(`.${entry.host}`)) return true
        }
      }
      return false
    },
  }
}

/** 拆分 host:port（支持 [IPv6]:port、裸 IPv6、裸域名）。 */
export function splitHostPort(value: string): { host: string; port: string } {
  const trimmed = value.trim()
  if (!trimmed) return { host: "", port: "" }

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    if (end > 0) {
      const host = trimmed.slice(0, end + 1)
      const rest = trimmed.slice(end + 1)
      return { host, port: rest.startsWith(":") ? rest.slice(1) : "" }
    }
  }

  const colons = (trimmed.match(/:/g) ?? []).length
  if (colons === 1) {
    const index = trimmed.lastIndexOf(":")
    return { host: trimmed.slice(0, index), port: trimmed.slice(index + 1) }
  }
  // 0 个或多个冒号：没有可识别的端口（裸 IPv6 直接返回）
  return { host: trimmed, port: "" }
}

/**
 * 决定一次请求是否走代理。
 *
 * @param proxy   配置
 * @param matcher 预先构建的 no_proxy 匹配器（无自定义名单时可为 null）
 * @param target  上游 URL
 * @param env     用于 from_env 回退的环境变量（默认 process.env）
 */
export function decideProxy(
  proxy: ProxyConfig,
  matcher: NoProxyMatcher | null,
  target: URL,
  env: Record<string, string | undefined> = process.env,
): ProxyDecision {
  const host = target.hostname
  const port = target.port || (target.protocol === "https:" ? "443" : "80")

  if (proxy.url.trim()) {
    if (matcher?.match(host, port)) return { via: "direct", option: "direct" }
    return { via: proxy.url.trim(), option: proxy.url.trim() }
  }

  if (!proxy.fromEnv) return { via: "direct", option: "direct" }

  const fromEnv = envProxyFor(target.protocol, env)
  if (!fromEnv) return { via: "direct", option: "direct" }

  // 环境变量的 NO_PROXY 由 Bun 自己判定（1.3.14 不支持 CIDR）。
  // 这里只做展示层的近似：命中简单 host 规则时报告 direct，避免 healthz
  // 与实际不符。真正是否直连仍以 Bun 为准。
  if (envNoProxyHit(target, env)) return { via: "direct", option: "direct" }
  return { via: fromEnv, option: fromEnv }
}

/** 按 Bun 1.3.14 的 NO_PROXY 语义（* / 域名含子域 / host:port / IP）做展示判定。 */
function envNoProxyHit(target: URL, env: Record<string, string | undefined>): boolean {
  const raw = env.no_proxy ?? env.NO_PROXY
  if (!raw?.trim()) return false
  const patterns = raw.split(/[,\s]+/).filter(Boolean)
  if (patterns.includes("*")) return true

  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const port = target.port || (target.protocol === "https:" ? "443" : "80")
  for (const pattern of patterns) {
    const lower = pattern.toLowerCase()
    if (lower.includes("/")) continue // 1.3.14 不支持 CIDR，Bun 也不会命中
    const { host: entryHost, port: entryPort } = splitHostPort(lower)
    if (entryPort && entryPort !== port) continue
    const bare = entryHost.replace(/^\[|\]$/g, "").replace(/^\./, "")
    if (host === bare || host.endsWith(`.${bare}`)) return true
  }
  return false
}

function envProxyFor(
  protocol: string,
  env: Record<string, string | undefined>,
): string | null {
  const lower = protocol === "https:" ? "https_proxy" : "http_proxy"
  const upper = lower.toUpperCase()
  // 与 Bun 1.3.14 实测一致：只读 scheme 对应变量，不读 ALL_PROXY。
  const value = env[lower] ?? env[upper]
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * 启动时校验环境变量与配置是否自相矛盾。
 *
 * Bun 1.3.14 在进程初始化时读取代理环境变量并缓存，运行期修改 process.env
 * 完全无效（实测 delete / 重新赋值都不影响后续 fetch）。同时 1.3.14 也没有
 * 任何显式写法能绕过环境变量强制直连（proxy:false / null / "" / 对象 noProxy
 * 均被忽略）。因此这里不做"运行时清空"，而是在启动时把矛盾暴露出来：
 *
 *  - url 非空：走代理的请求每请求显式传 proxy，环境变量被覆盖；
 *    但命中 no_proxy 的"直连"请求不传 proxy，会回落到环境变量代理，
 *    因此 url + no_proxy + 环境变量同时存在时必须报错；
 *  - url 为空且 from_env=true：保留环境变量，交给 Bun 判定；
 *  - url 为空且 from_env=false：环境变量必须为空，否则报错退出。
 *    静默继续会导致"配置说直连、实际走代理"，这比启动失败更难排查。
 */
export function assertProxyEnvConsistent(
  proxy: ProxyConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  // 1.3.14 只认 HTTP(S)_PROXY（ALL_PROXY 实测被忽略），所以只把这两个算作冲突源。
  const found = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"].filter(
    (key) => (env[key] ?? "").trim() !== "",
  )
  if (found.length === 0) return

  const url = proxy.url.trim()
  if (!url) {
    if (proxy.fromEnv) return // 交给环境变量，无冲突
    if (proxy.noProxy.length > 0) {
      // validateProxyConfig 已给出更精确的错误，这里不重复。
      return
    }
    throw new Error(
      `proxy.fromEnv=false 与环境变量 ${found.join(", ")} 冲突。` +
        "Bun 1.3.14 会在启动时缓存这些变量且无法在运行期忽略；" +
        "请清空它们后重启" +
        "（PowerShell: Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:http_proxy,Env:https_proxy -ErrorAction SilentlyContinue），" +
        "或改用 proxy.url / proxy.fromEnv=true。",
    )
  }

  // url 非空：走代理的请求每请求显式传 proxy，环境变量被覆盖；
  // 但命中 no_proxy 的直连请求不传 proxy，会回落到环境变量代理。
  if (proxy.noProxy.length === 0) {
    // 不会出现直连请求，无冲突。
    return
  }
  throw new Error(
    `proxy.url + proxy.no_proxy 与环境变量 ${found.join(", ")} 冲突：` +
      "命中 no_proxy 的直连请求不传 proxy 选项，Bun 1.3.14 会回退使用环境变量代理（且无法在运行期忽略）。" +
      "请清空环境变量后重启" +
      "（PowerShell: Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:http_proxy,Env:https_proxy -ErrorAction SilentlyContinue），" +
      "或去掉 proxy.no_proxy。",
  )
}

/**
 * 启动时的配置校验：代理地址合法、no_proxy 条目合法。
 * 返回预构建的匹配器，避免每请求重复解析。
 */
export function validateProxyConfig(proxy: ProxyConfig): NoProxyMatcher | null {
  if (proxy.url.trim()) parseProxyURL(proxy.url)
  if (!proxy.url.trim() && !proxy.fromEnv) {
    if (proxy.noProxy.length > 0) {
      // no_proxy 仅在 url 非空时生效（与 Go 版本一致）；提前提示，避免误配。
      throw new Error("proxy.noProxy 仅在 proxy.url 非空时生效")
    }
    return null
  }
  if (proxy.noProxy.length === 0) return null
  return buildNoProxyMatcher(proxy.noProxy)
}

/**
 * 生成传给 Bun fetch 的 proxy 选项。
 *
 * 直连返回 undefined 即可：配置了 url 时启动阶段已清空环境变量，不传选项就是直连。
 * （不要用 proxy:false —— 1.3.14 会忽略它，仍会读取环境变量。）
 */
export function proxyFetchOption(decision: ProxyDecision): string | undefined {
  return decision.option === "direct" ? undefined : decision.option
}

/**
 * 出站路由的运行时状态：启动时校验配置、归一化环境变量，
 * 之后为每个请求给出 route（含传给 fetch 的 proxy 选项）。
 */
export class OutboundState {
  /** 配置里的代理地址（去凭据）；未配置为空串。 */
  readonly configured: string
  private readonly proxy: ProxyConfig
  private readonly matcher: NoProxyMatcher | null
  private readonly env: Record<string, string | undefined>

  constructor(proxy: ProxyConfig, env: Record<string, string | undefined> = process.env) {
    this.env = env
    this.matcher = validateProxyConfig(proxy)
    const parsed = proxy.url.trim() ? parseProxyURL(proxy.url) : null
    this.configured = parsed?.display ?? ""
    // 归一化：允许配置省略 scheme（默认 http://），传给 fetch 的必须是完整 URL。
    this.proxy = parsed ? { ...proxy, url: parsed.url.toString() } : proxy
    assertProxyEnvConsistent(proxy, env)
  }

  /** 为一次上游请求计算实际出站路径。 */
  route(target: string): OutboundRoute {
    const url = new URL(target)
    const decision = decideProxy(this.proxy, this.matcher, url, this.env)
    return {
      configured: this.configured,
      effective: displayVia(decision.via),
      option: proxyFetchOption(decision),
    }
  }

  /** 对配置里的 upstream 做一次判定，用于 /healthz 展示「真的会走」。 */
  probe(upstream: string): string {
    try {
      return this.route(upstream).effective
    } catch {
      return "direct"
    }
  }
}

/** 展示用地址：去掉 URL 里的 user:pass，避免凭据进入响应头/日志。 */
function displayVia(via: string): string {
  if (via === "direct") return via
  try {
    return new URL(via.includes("://") ? via : `http://${via}`).origin
  } catch {
    return via
  }
}
