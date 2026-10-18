import { describe, expect, test } from "bun:test"
import { isSupportedBunVersion } from "./bun-version"

describe("isSupportedBunVersion", () => {
  test("accepts the verified range", () => {
    for (const version of ["1.3.14", "1.3.15", "1.4.0", "1.4.2", "1.4.3", "1.4.3-canary"]) {
      expect(isSupportedBunVersion(version)).toBe(true)
    }
  })

  test("rejects older and untested versions", () => {
    for (const version of ["1.3.13", "1.2.20", "1.5.0", "2.0.0", "not-a-version", ""]) {
      expect(isSupportedBunVersion(version)).toBe(false)
    }
  })
})
