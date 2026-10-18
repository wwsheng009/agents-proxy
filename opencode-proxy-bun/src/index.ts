import { isSupportedBunVersion, SUPPORTED_BUN_RANGE } from "./bun-version"
import { loadConfig, parseListen } from "./config"
import { OutboundState } from "./outbound"
import { handle } from "./proxy"
import { RuntimeState } from "./runtime"
import { SessionStore } from "./session"

if (!isSupportedBunVersion(Bun.version)) {
  console.error(`[opencode-proxy-bun] unsupported Bun ${Bun.version}.`)
  console.error(`Supported versions: ${SUPPORTED_BUN_RANGE} (tested: 1.3.14 / 1.4.2 / 1.4.3).`)
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
