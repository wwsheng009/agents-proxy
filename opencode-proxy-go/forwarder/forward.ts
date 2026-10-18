// opencode-proxy-go Bun 1.3.14 转发 sidecar
//
// 为什么需要它：2026-10-18 起 opencode.ai 对匿名免费道新增了
// Bun 1.3.14 的 TLS/HTTP2 指纹门。同样的 headers/body：
//   Bun 1.3.14 fetch → 200
//   Go / Python / Bun 1.4.x fetch → 403 FreeTierError
// 因此 Go 代理把出站请求以明文 HTTP 交给本 sidecar，由 Bun 1.3.14
// 完成到 https://opencode.ai 的 TLS/HTTP2。
//
// 运行（必须 Bun 1.3.14）：
//   bun run forward.ts
// 环境变量：
//   FORWARDER_HOST  默认 127.0.0.1
//   FORWARDER_PORT  默认 8898

const UPSTREAM = "https://opencode.ai"
const HOST = process.env.FORWARDER_HOST ?? "127.0.0.1"
const PORT = Number(process.env.FORWARDER_PORT ?? 8898)
const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "proxy-connection",
  "upgrade",
])

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const target = UPSTREAM + url.pathname + url.search
    const headers = new Headers(req.headers)
    for (const name of HOP_BY_HOP) headers.delete(name)

    try {
      const res = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual",
      })
      const out = new Headers(res.headers)
      // Bun fetch 会自动解压；删除编码/长度，交给 Bun 重新流式编码。
      out.delete("content-encoding")
      out.delete("content-length")
      out.delete("transfer-encoding")
      console.error(`${req.method} ${url.pathname}${url.search} -> ${res.status}`)
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: out,
      })
    } catch (error) {
      console.error(`${req.method} ${url.pathname}${url.search} -> 502 ${error}`)
      return Response.json(
        { error: { type: "forwarder_error", message: String(error) } },
        { status: 502 },
      )
    }
  },
})

console.error(`bun forwarder listening on http://${HOST}:${PORT} (bun ${Bun.version})`)
void server
