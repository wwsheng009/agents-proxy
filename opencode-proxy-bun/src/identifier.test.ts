import { describe, expect, test } from "bun:test"
import { MESSAGE_ID_RE, SESSION_ID_RE, makeId } from "./identifier"

describe("identifier", () => {
  test("session format", () => {
    expect(makeId("ses_", true)).toMatch(SESSION_ID_RE)
  })

  test("message format", () => {
    expect(makeId("msg_", false)).toMatch(MESSAGE_ID_RE)
  })

  test("ids are unique", () => {
    const ids = new Set(Array.from({ length: 100 }, () => makeId("ses_", true)))
    expect(ids.size).toBe(100)
  })

  test("ses is descending, msg is ascending", () => {
    const oldSes = makeId("ses_", true, 1000)
    const newSes = makeId("ses_", true, 2000)
    const oldMsg = makeId("msg_", false, 1000)
    const newMsg = makeId("msg_", false, 2000)

    const oldSesTime = BigInt("0x" + oldSes.slice(4, 16))
    const newSesTime = BigInt("0x" + newSes.slice(4, 16))
    const oldMsgTime = BigInt("0x" + oldMsg.slice(4, 16))
    const newMsgTime = BigInt("0x" + newMsg.slice(4, 16))

    expect(newSesTime < oldSesTime).toBe(true)
    expect(newMsgTime > oldMsgTime).toBe(true)
  })
})
