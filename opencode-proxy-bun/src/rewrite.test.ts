import { describe, expect, test } from "bun:test"
import { isChatPath, isZenPath, rewritePath } from "./rewrite"

const cases: Array<[string, string]> = [
  ["/v1/chat/completions", "/zen/v1/chat/completions"],
  ["/v1/models", "/zen/v1/models"],
  ["/v1beta/models", "/zen/v1/models"],
  ["/v1beta/models/gemini-3:generateContent", "/zen/v1/models/gemini-3:generateContent"],
  ["/inference/v1/chat/completions", "/zen/v1/chat/completions"],
  ["/inference/openai/v1/chat/completions", "/zen/v1/chat/completions"],
  ["/inference/openai/v1/responses", "/zen/v1/responses"],
  ["/inference/anthropic/v1/messages", "/zen/v1/messages"],
  ["/inference/systemone/v1/systemone", "/zen/v1/systemone"],
  [
    "/inference/google/v1beta/models/gemini-3:generateContent",
    "/zen/v1/models/gemini-3:generateContent",
  ],
  ["/inference/go/openai/v1/chat/completions", "/zen/go/v1/chat/completions"],
  ["/inference/go/anthropic/v1/messages", "/zen/go/v1/messages"],
  ["/inference/go/v1/models", "/zen/go/v1/models"],
  ["/zen/v1/chat/completions", "/zen/v1/chat/completions"],
  ["/zen/go/v1/chat/completions", "/zen/go/v1/chat/completions"],
  ["/chat/completions", "/zen/v1/chat/completions"],
  ["/responses", "/zen/v1/responses"],
  ["/vendors", "/vendors"],
]

describe("rewritePath", () => {
  for (const [input, expected] of cases) {
    test(`${input} -> ${expected}`, () => {
      expect(rewritePath(input)).toBe(expected)
    })
  }
})

describe("lane detection", () => {
  test("zen paths", () => {
    expect(isZenPath("/zen/v1/chat/completions")).toBe(true)
    expect(isZenPath("/zen/go/v1/chat/completions")).toBe(true)
    expect(isZenPath("/zen/v1/models/gemini-3:generateContent")).toBe(true)
    expect(isZenPath("/v1/chat/completions")).toBe(false)
  })

  test("chat paths", () => {
    expect(isChatPath("/zen/v1/chat/completions")).toBe(true)
    expect(isChatPath("/zen/go/v1/chat/completions")).toBe(true)
    expect(isChatPath("/zen/v1/responses")).toBe(false)
    expect(isChatPath("/zen/v1/messages")).toBe(false)
  })
})
