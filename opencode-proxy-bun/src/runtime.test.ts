import { describe, expect, test } from "bun:test"
import { RuntimeState } from "./runtime"

function headers(values: Record<string, string> = {}): Headers {
  const out = new Headers()
  for (const [key, value] of Object.entries(values)) out.set(key, value)
  return out
}

describe("RuntimeState", () => {
  test("counts consecutive FreeTierError responses", () => {
    const state = new RuntimeState()
    state.record(403, headers({ "x-opencode-log-id": "log-1" }), "FreeTierError")
    state.record(403, headers(), "FreeTierError")
    expect(state.snapshot().consecutive403).toBe(2)
    expect(state.snapshot().lastUpstreamLogId).toBe("log-1")
  })

  test("does not count other 403 responses", () => {
    const state = new RuntimeState()
    state.record(403, headers(), null)
    expect(state.snapshot().consecutive403).toBe(0)
  })

  test("success resets the streak", () => {
    const state = new RuntimeState()
    state.record(403, headers(), "FreeTierError")
    state.record(200, headers())
    expect(state.snapshot().consecutive403).toBe(0)
    expect(state.snapshot().lastOkAt).not.toBeNull()
  })

  test("429 resets the streak because admission succeeded", () => {
    const state = new RuntimeState()
    state.record(403, headers(), "FreeTierError")
    state.record(429, headers())
    expect(state.snapshot().consecutive403).toBe(0)
  })

  test("5xx resets the streak because admission was not evaluated", () => {
    const state = new RuntimeState()
    state.record(403, headers(), "FreeTierError")
    state.record(500, headers())
    expect(state.snapshot().consecutive403).toBe(0)
  })

  test("non-403 4xx resets the streak", () => {
    const state = new RuntimeState()
    state.record(403, headers(), "FreeTierError")
    state.record(400, headers())
    expect(state.snapshot().consecutive403).toBe(0)
  })

  test("recycle threshold", () => {
    const state = new RuntimeState()
    state.record(403, headers(), "FreeTierError")
    state.record(403, headers(), "FreeTierError")
    expect(state.shouldRecycle(3)).toBe(false)
    state.record(403, headers(), "FreeTierError")
    expect(state.shouldRecycle(3)).toBe(true)
  })
})
