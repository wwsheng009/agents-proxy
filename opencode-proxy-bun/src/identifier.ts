// OpenCode identifier algorithm (packages/schema/src/identifier.ts)
//   ID = prefix + 12 hex (low 48 bits of timestamp*0x1000+counter) + 14 base62
//   ses_ = descending, msg_ = ascending
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

let lastTimestamp = 0
let counter = 0

export function makeId(
  prefix: "ses_" | "msg_",
  descending: boolean,
  timestamp = Date.now(),
): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  let time = ""
  for (let index = 0; index < 6; index++) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  }

  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return prefix + time + Array.from(bytes, (byte) => BASE62[byte % 62]).join("")
}

export const SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
export const MESSAGE_ID_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
