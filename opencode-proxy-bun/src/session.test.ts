import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "./config"
import { SessionStore } from "./session"

describe("SessionStore", () => {
  const config = { ...DEFAULT_CONFIG, dbPath: ":memory:" }

  test("stable mapping per incoming key", () => {
    const store = new SessionStore(config)
    try {
      const first = store.map("conversation-a")
      const second = store.map("conversation-a")
      const other = store.map("conversation-b")
      expect(first).toBe(second)
      expect(first).not.toBe(other)
      expect(first).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      expect(store.count()).toBe(2)
    } finally {
      store.close()
    }
  })

  test("native session ids pass through", () => {
    const store = new SessionStore(config)
    try {
      const native = "ses_0123456789abABCDEFGHIJKL12"
      expect(store.map(native)).toBe(native)
      expect(store.count()).toBe(0)
    } finally {
      store.close()
    }
  })

  test("passthrough can be disabled", () => {
    const store = new SessionStore({
      ...config,
      session: { ...config.session, passthroughNative: false },
    })
    try {
      const native = "ses_0123456789abABCDEFGHIJKL12"
      const mapped = store.map(native)
      expect(mapped).not.toBe(native)
      expect(mapped).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    } finally {
      store.close()
    }
  })
})
