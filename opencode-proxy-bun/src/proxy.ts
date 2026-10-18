import type { Config } from "./config"
import { fixupBody } from "./body"
import { buildPassthroughHeaders, buildUpstreamHeaders, pickSession } from "./headers"
import { makeId } from "./identifier"
import type { OutboundState } from "./outbound"
import { isChatPath, isZenPath, rewritePath } from "./rewrite"
import type { RuntimeState } from "./runtime"
import type { SessionStore } from "./session"

const EXPOSE_HEADERS = "X-Proxy-Session, X-Proxy-Request, X-Proxy-Via"

function applyCors(headers: Headers): void {
  headers.set("access-control-allow-origin", "*")
  headers.set("access-control-allow-headers", "*")
  headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS")
  headers.set("access-control-expose-headers", EXPOSE_HEADERS)
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  applyCors(headers)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function errorResponse(status: number, type: string, message: string): Response {
  return withCors(Response.json({ error: { type, message } }, { status }))
}

export async function handle(
  request: Request,
  config: Config,
  store: SessionStore,
  runtime: RuntimeState,
  outbound: OutboundState,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }))
  }

  const url = new URL(request.url)
  if (url.pathname === "/healthz" || url.pathname === "/__proxy/health") {
    const state = runtime.snapshot()
    const degraded =
      config.watchdog.enabled && state.consecutive403 >= config.watchdog.failureThreshold
    return withCors(
      Response.json({
        status: degraded ? "degraded" : "ok",
        bun: Bun.version,
        upstream: config.upstream,
        sessions: store.count(),
        proxy: {
          configured: outbound.configured,
          no_proxy: config.proxy.noProxy,
          from_env: config.proxy.fromEnv,
          effective: outbound.probe(config.upstream),
        },
        watchdog: {
          enabled: config.watchdog.enabled,
          failure_threshold: config.watchdog.failureThreshold,
          probe_interval_ms: config.watchdog.probeIntervalMs,
        },
        upstream_403_streak: state.consecutive403,
        last_upstream_status: state.lastUpstreamStatus,
        last_upstream_log_id: state.lastUpstreamLogId,
        last_upstream_cf_ray: state.lastUpstreamCfRay,
        last_403_at: state.last403At,
        last_ok_at: state.lastOkAt,
      }),
    )
  }

  const started = performance.now()
  const targetPath = rewritePath(url.pathname)
  const zen = isZenPath(targetPath)
  const chat = isChatPath(targetPath)

  const sessionKey = pickSession(request.headers, config)
  const session = store.map(sessionKey)
  const message = makeId("msg_", false)

  let body: Uint8Array<ArrayBuffer> | undefined
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.arrayBuffer()
    if (raw.byteLength > 0 && zen && chat) {
      body = fixupBody(new Uint8Array(raw), targetPath, config.bodyFixup.mode) as Uint8Array<ArrayBuffer>
    } else {
      body = new Uint8Array(raw)
    }
  }

  const headers = zen
    ? buildUpstreamHeaders(request.headers, {
        session,
        message,
        config,
        chat,
      })
    : buildPassthroughHeaders(request.headers)

  const target = config.upstream.replace(/\/$/, "") + targetPath + url.search

  // 出站代理决策：配置了 url 时显式传 proxy 选项；否则交给启动时归一化过的
  // 环境变量。直连时不传选项（1.3.14 的 proxy:false 会被忽略）。
  const route = outbound.route(target)

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      // Bun 的 BodyInit 类型不接受 Uint8Array，运行时支持；显式转成 Blob。
      body: body ? new Blob([body]) : undefined,
      redirect: "manual",
      proxy: route.option,
    })
  } catch (error) {
    const elapsed = performance.now() - started
    console.error(
      `proxy error ${request.method} ${url.pathname} -> ${targetPath}: ${String(error)} ` +
        `(via=${route.effective}, ${elapsed.toFixed(0)}ms)`,
    )
    return errorResponse(502, "proxy_error", String(error))
  }

  const responseHeaders = new Headers(upstream.headers)
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) {
    responseHeaders.delete(name)
  }
  responseHeaders.set("X-Proxy-Session", session)
  responseHeaders.set("X-Proxy-Request", message)
  responseHeaders.set("X-Proxy-Via", route.effective)
  applyCors(responseHeaders)

  // Keep the streak bookkeeping cheap: only chat calls to the zen lane can
  // produce FreeTierError, and only they need diagnostics.
  if (zen) {
    const isFreeTier =
      upstream.status === 403 && (await peekFreeTierError(upstream.clone()))
    // A 403 streak is only meaningful while the last result is still a 403.
    // A later 500 (for example during an upstream incident) must not leave
    // /healthz permanently degraded.
    const errorType = isFreeTier ? "FreeTierError" : null
    runtime.record(upstream.status, upstream.headers, errorType)
    if (isFreeTier) {
      console.error(
        `upstream 403 FreeTierError ${request.method} ${url.pathname} -> ${targetPath} ` +
          `log_id=${upstream.headers.get("x-opencode-log-id") ?? "-"} ` +
          `cf_ray=${upstream.headers.get("cf-ray") ?? "-"} ` +
          `streak=${runtime.snapshot().consecutive403}`,
      )
      if (runtime.shouldRecycle(config.watchdog.failureThreshold)) {
        console.error(
          `watchdog: ${runtime.snapshot().consecutive403} consecutive FreeTierError responses; ` +
            "restart the proxy process (see docs/operations.md §8)",
        )
      }
    }
  }

  if (config.log.requests) {
    const elapsed = performance.now() - started
    console.log(
      `${request.method} ${url.pathname} -> ${targetPath} ${upstream.status} ${elapsed.toFixed(0)}ms ` +
        `session=${sessionKey} upstream_session=${session} via=${route.effective}`,
    )
  }

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

async function peekFreeTierError(response: Response): Promise<boolean> {
  try {
    const text = await response.text()
    return text.includes('"type":"FreeTierError"')
  } catch {
    return false
  }
}
