import { READ_TOOL } from "./tools"

export function fixupBody(body: Uint8Array, path: string, mode: "v2" | "off"): Uint8Array {
  if (mode !== "v2") return body
  if (!/\/chat\/completions\/?$/.test(path)) return body

  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return body
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return body

  const payload = json as Record<string, unknown>
  payload.stream = true
  const streamOptions =
    typeof payload.stream_options === "object" && payload.stream_options !== null
      ? (payload.stream_options as Record<string, unknown>)
      : {}
  payload.stream_options = { ...streamOptions, include_usage: true }

  if (!Array.isArray(payload.tools)) payload.tools = []
  const tools = payload.tools as Array<Record<string, unknown>>
  const hasRead = tools.some((tool) => {
    const fn = tool.function as Record<string, unknown> | undefined
    return fn?.name === "read" || tool.name === "read"
  })
  if (!hasRead) tools.unshift(structuredClone(READ_TOOL))

  return new TextEncoder().encode(JSON.stringify(payload))
}
