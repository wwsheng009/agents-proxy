import { describe, expect, test } from "bun:test"
import { fixupBody } from "./body"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

function decode(value: Uint8Array): any {
  return JSON.parse(decoder.decode(value))
}

describe("fixupBody", () => {
  test("forces stream and injects read", () => {
    const body = fixupBody(
      encode({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
      "/zen/v1/chat/completions",
      "v2",
    )
    const parsed = decode(body)
    expect(parsed.stream).toBe(true)
    expect(parsed.stream_options).toEqual({ include_usage: true })
    expect(parsed.max_tokens).toBe(8)
    expect(parsed.tools).toHaveLength(1)
    expect(parsed.tools[0].function.name).toBe("read")
  })

  test("preserves existing tools and does not duplicate read", () => {
    const body = fixupBody(
      encode({
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { type: "function", function: { name: "read", description: "custom" } },
          { type: "function", function: { name: "bash" } },
        ],
      }),
      "/zen/v1/chat/completions",
      "v2",
    )
    const parsed = decode(body)
    expect(parsed.tools).toHaveLength(2)
    expect(parsed.tools[0].function.description).toBe("custom")
    expect(parsed.tools[1].function.name).toBe("bash")
  })

  test("does not modify non-chat endpoints", () => {
    const input = encode({ model: "big-pickle", stream: false })
    const output = fixupBody(input, "/zen/v1/responses", "v2")
    expect(output).toEqual(input)
  })

  test("does not modify when mode is off", () => {
    const input = encode({ model: "big-pickle", stream: false })
    const output = fixupBody(input, "/zen/v1/chat/completions", "off")
    expect(output).toEqual(input)
  })

  test("invalid JSON is passed through", () => {
    const input = encoder.encode("not-json")
    const output = fixupBody(input, "/zen/v1/chat/completions", "v2")
    expect(output).toEqual(input)
  })
})
