import type { ProxyConfig } from "./outbound"

export type Config = {
  listen: string
  upstream: string
  dbPath: string
  session: {
    headers: string[]
    fallbackKey: string
    passthroughNative: boolean
  }
  upstreamHeaders: {
    userAgent: string
    authorization: string
    client: string
    project: string
  }
  bodyFixup: {
    mode: "v2" | "off"
  }
  log: {
    requests: boolean
  }
  watchdog: {
    enabled: boolean
    failureThreshold: number
    probeIntervalMs: number
  }
  proxy: ProxyConfig
}

export const DEFAULT_CONFIG: Config = {
  listen: "127.0.0.1:8788",
  upstream: "https://opencode.ai",
  dbPath: "proxy.db",
  session: {
    headers: [
      "x-opencode-session-id",
      "x-session-affinity",
      "x-session-id",
      "x-opencode-session",
      "x-session",
    ],
    fallbackKey: "default",
    passthroughNative: true,
  },
  upstreamHeaders: {
    userAgent: "opencode/latest/2.0.32/cli",
    authorization: "Bearer public",
    client: "cli",
    project: "global",
  },
  bodyFixup: { mode: "v2" },
  log: { requests: true },
  watchdog: {
    enabled: false,
    failureThreshold: 3,
    probeIntervalMs: 30_000,
  },
  // 默认不配置显式代理，但保留与 Go 版本一致的历史行为：跟随环境变量。
  proxy: {
    url: "",
    noProxy: [],
    fromEnv: true,
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function merge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override ?? base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? merge(out[key], value) : value
  }
  return out
}

export async function loadConfig(path = process.env.CONFIG ?? "config.json"): Promise<Config> {
  const file = Bun.file(path)
  const user = (await file.exists()) ? await file.json() : {}
  const config = merge(DEFAULT_CONFIG, user) as Config

  if (process.env.LISTEN) config.listen = process.env.LISTEN
  if (process.env.UPSTREAM) config.upstream = process.env.UPSTREAM
  if (process.env.DB_PATH) config.dbPath = process.env.DB_PATH
  if (process.env.WATCHDOG_FAILURE_THRESHOLD) {
    config.watchdog.failureThreshold = Number(process.env.WATCHDOG_FAILURE_THRESHOLD)
  }
  if (process.env.WATCHDOG_ENABLED) {
    config.watchdog.enabled = process.env.WATCHDOG_ENABLED === "1"
  }
  // 与 Go 的 --proxy 对齐：命令行环境变量覆盖配置文件。
  if (process.env.PROXY_URL !== undefined) config.proxy.url = process.env.PROXY_URL
  if (process.env.PROXY_NO_PROXY !== undefined) {
    config.proxy.noProxy = process.env.PROXY_NO_PROXY.split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (process.env.PROXY_FROM_ENV !== undefined) {
    config.proxy.fromEnv = process.env.PROXY_FROM_ENV === "1"
  }

  return config
}

export function parseListen(listen: string): { hostname: string; port: number } {
  const index = listen.lastIndexOf(":")
  if (index < 0) throw new Error(`invalid listen address: ${listen}`)
  const hostname = listen.slice(0, index) || "127.0.0.1"
  const port = Number(listen.slice(index + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port in listen address: ${listen}`)
  }
  return { hostname, port }
}
