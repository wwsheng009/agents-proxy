// One-shot upstream admission probe used by watchdog.ps1.
//
// Exit 0 only when a direct request from the selected Bun runtime
// (1.3.14+ / 1.4.x) to /zen/v1/chat/completions passes admission
// (HTTP 200 or 429). A 403 FreeTierError means the local proxy process
// should be restarted; any other failure means the upstream itself is
// unavailable, so restarting the proxy will not help.

import { makeId } from "../src/identifier"
import { READ_TOOL } from "../src/tools"

const upstream = (
  process.env.PROBE_UPSTREAM ??
  process.env.UPSTREAM ??
  "https://opencode.ai"
).replace(/\/$/, "")
const model = process.env.PROBE_MODEL ?? "big-pickle"

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

function traceHeaders(): Record<string, string> {
  const trace = hex(16)
  const span = hex(8)
  return {
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1-${span}`,
  }
}

const session = makeId("ses_", true)
const headers: Record<string, string> = {
  authorization: "Bearer public",
  "user-agent": "opencode/latest/2.0.32/cli",
  "x-opencode-session": session,
  "x-opencode-session-id": session,
  "x-session-affinity": session,
  "x-session-id": session,
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-request": makeId("msg_", false),
  "content-type": "application/json",
  accept: "text/event-stream",
  "accept-encoding": "identity",
  ...traceHeaders(),
}

const response = await fetch(`${upstream}/zen/v1/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 4,
    stream: true,
    stream_options: { include_usage: true },
    tools: [READ_TOOL],
  }),
})

const text = await response.text()
const freeTier = text.includes('"type":"FreeTierError"')
console.log(
  JSON.stringify({
    status: response.status,
    free_tier: freeTier,
    log_id: response.headers.get("x-opencode-log-id"),
    cf_ray: response.headers.get("cf-ray"),
    body: text.slice(0, 200),
  }),
)

// 200 = admission passed and the model responded.
// 429 = admission passed, daily quota exhausted.
// Any other status means a fresh process cannot reach upstream either, so
// restarting the long-lived proxy would not help.
process.exit(response.status === 200 || response.status === 429 ? 0 : 1)
