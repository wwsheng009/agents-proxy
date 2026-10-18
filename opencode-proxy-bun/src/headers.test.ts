import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "./config"
import { buildUpstreamHeaders, pickSession } from "./headers"

const SESSION = "ses_0123456789abABCDEFGHIJKL12"
const MESSAGE = "msg_0123456789abABCDEFGHIJKL12"

function incoming(): Headers {
  const headers = new Headers()
  headers.set("content-type", "application/json")
  headers.set("authorization", "Bearer client-key")
  headers.set("user-agent", "client-ua")
  headers.set("accept-encoding", "gzip")
  headers.set("x-opencode-session", "ses_client_value_000000000000")
  headers.set("x-session-id", "client-session")
  headers.set("x-custom", "kept")
  headers.set("cookie", "a=b")
  return headers
}

describe("buildUpstreamHeaders", () => {
  const out = buildUpstreamHeaders(incoming(), {
    session: SESSION,
    message: MESSAGE,
    config: DEFAULT_CONFIG,
    chat: true,
  })

  test("identity headers", () => {
    expect(out.get("authorization")).toBe("Bearer public")
    expect(out.get("user-agent")).toBe(DEFAULT_CONFIG.upstreamHeaders.userAgent)
    expect(out.get("x-opencode-client")).toBe("cli")
    expect(out.get("x-opencode-project")).toBe("global")
    expect(out.get("x-opencode-request")).toBe(MESSAGE)
  })

  test("four session headers", () => {
    expect(out.get("x-opencode-session")).toBe(SESSION)
    expect(out.get("x-opencode-session-id")).toBe(SESSION)
    expect(out.get("x-session-affinity")).toBe(SESSION)
    expect(out.get("x-session-id")).toBe(SESSION)
  })

  test("client identity headers are replaced", () => {
    expect(out.get("x-opencode-session")).not.toBe("ses_client_value_000000000000")
    expect(out.get("x-session-id")).not.toBe("client-session")
  })

  test("non-identity headers are preserved", () => {
    expect(out.get("content-type")).toBe("application/json")
    expect(out.get("x-custom")).toBe("kept")
    expect(out.get("cookie")).toBe("a=b")
    expect(out.get("accept-encoding")).toBe("identity")
    expect(out.get("accept")).toBe("text/event-stream")
  })

  test("trace headers are regenerated", () => {
    expect(out.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(out.get("b3")).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/)
  })
})

describe("pickSession", () => {
  test("prefers the OpenCode session id", () => {
    const headers = new Headers()
    headers.set("x-session", "last")
    headers.set("x-opencode-session", "third")
    headers.set("x-session-id", "second")
    headers.set("x-session-affinity", "affinity")
    headers.set("x-opencode-session-id", "first")
    expect(pickSession(headers, DEFAULT_CONFIG)).toBe("first")
  })

  test("falls back to the configured key", () => {
    expect(pickSession(new Headers(), DEFAULT_CONFIG)).toBe("default")
  })
})
