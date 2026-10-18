import type { Config } from "./config"

const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
])

const DROP_FOR_ZEN = new Set([
  ...HOP_BY_HOP,
  "user-agent",
  "accept-encoding",
  "traceparent",
  "b3",
])

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

function traceHeaders(): { traceparent: string; b3: string } {
  const trace = randomHex(16)
  const span = randomHex(8)
  return {
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1-${span}`,
  }
}

export function pickSession(headers: Headers, config: Config): string {
  for (const name of config.session.headers) {
    const value = headers.get(name)?.trim()
    if (value) return value
  }
  return config.session.fallbackKey
}

export function buildUpstreamHeaders(
  incoming: Headers,
  options: {
    session: string
    message: string
    config: Config
    chat: boolean
  },
): Headers {
  const { session, message, config, chat } = options
  const out = new Headers()

  for (const [key, value] of incoming) {
    const lower = key.toLowerCase()
    if (DROP_FOR_ZEN.has(lower)) continue
    if (lower.startsWith("x-opencode-")) continue
    if (lower.startsWith("x-session-")) continue
    if (lower === "x-session-id") continue
    out.set(key, value)
  }

  out.set("authorization", config.upstreamHeaders.authorization || incoming.get("authorization") || "")
  out.set("user-agent", config.upstreamHeaders.userAgent)
  out.set("x-opencode-session", session)
  out.set("x-opencode-session-id", session)
  out.set("x-session-affinity", session)
  out.set("x-session-id", session)
  out.set("x-opencode-client", config.upstreamHeaders.client)
  out.set("x-opencode-project", config.upstreamHeaders.project)
  out.set("x-opencode-request", message)
  out.set("accept-encoding", "identity")
  if (chat) out.set("accept", "text/event-stream")
  if (!out.has("content-type")) out.set("content-type", "application/json")

  const trace = traceHeaders()
  out.set("traceparent", trace.traceparent)
  out.set("b3", trace.b3)

  return out
}

export function buildPassthroughHeaders(incoming: Headers): Headers {
  const out = new Headers()
  for (const [key, value] of incoming) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    out.set(key, value)
  }
  return out
}
