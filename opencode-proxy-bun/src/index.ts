import { loadConfig, parseListen } from "./config"
import { OutboundState } from "./outbound"
import { handle } from "./proxy"
import { RuntimeState } from "./runtime"
import { SessionStore } from "./session"

const REQUIRED_BUN = "1.3.14"

if (Bun.version !== REQUIRED_BUN) {
  console.error(
    `[opencode-proxy-bun] Bun ${REQUIRED_BUN} is required (current ${Bun.version}).`,
  )
  console.error(
    "The upstream free tier accepts only the Bun 1.3.14 TLS/HTTP2 fingerprint; 1.4.x returns 403.",
  )
  process.exit(1)
}

const config = await loadConfig()
const outbound = new OutboundState(config.proxy)
const store = new SessionStore(config)
const runtime = new RuntimeState()
const { hostname, port } = parseListen(config.listen)

const server = Bun.serve({
  hostname,
  port,
  idleTimeout: 255,
  fetch: (request) => handle(request, config, store, runtime, outbound),
})

console.log(
  `[opencode-proxy-bun] listening on http://${hostname}:${port} (bun ${Bun.version}, upstream ${config.upstream})`,
)
console.log(
  `[opencode-proxy-bun] outbound proxy: ` +
    (outbound.configured
      ? `${outbound.configured}${config.proxy.noProxy.length ? ` (no_proxy: ${config.proxy.noProxy.join(", ")})` : ""}`
      : config.proxy.fromEnv
        ? "from environment (HTTP_PROXY/HTTPS_PROXY/NO_PROXY)"
        : "direct"),
)

let stopping = false
function shutdown(signal: string): void {
  if (stopping) return
  stopping = true
  console.log(`[opencode-proxy-bun] ${signal} received, shutting down…`)
  server.stop(true)
  store.close()
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
