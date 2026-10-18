// Fake upstream used only by the watchdog integration test.
// Always returns a 403 FreeTierError so the proxy enters the degraded state.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8898),
  async fetch(request) {
    const body = await request.json().catch(() => ({}))
    if (body && body.model === "probe-ok") {
      return new Response(
        [
          'data: {"id":"fake-probe","object":"chat.completion.chunk","created":0,"model":"probe-ok","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-opencode-log-id": "fake-probe-ok",
          },
        },
      )
    }
    return Response.json(
      {
        type: "error",
        error: {
          type: "FreeTierError",
          message: "OpenCode's free tier can only be used from within OpenCode.",
        },
      },
      {
        status: 403,
        headers: {
          "x-opencode-log-id": "fake-log-id",
          "cf-ray": "fake-cf-ray",
        },
      },
    )
  },
})

console.log(`fake upstream listening on ${server.hostname}:${server.port}`)
