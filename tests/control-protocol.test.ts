import { describe, expect, test } from "bun:test"
import {
  ControlFailure,
  decodeReply,
  decodeRequest,
  encodeReply,
  encodeRequest,
  errorReply,
  failureFrom,
  parseTarget,
  successReply,
} from "../src/control-protocol.ts"

describe("requests", () => {
  test("round-trip through one line", () => {
    const line = encodeRequest({ id: "7", method: "focus", params: { target: "next" } })
    expect(line.endsWith("\n")).toBe(true)
    expect(decodeRequest(line.trim())).toEqual({
      request: { id: "7", method: "focus", params: { target: "next" } },
    })
  })

  test("answer a malformed line with an error the server can send back", () => {
    const decoded = decodeRequest("not json")
    expect("reply" in decoded && decoded.reply.ok).toBe(false)
    if ("reply" in decoded && !decoded.reply.ok) expect(decoded.reply.error.code).toBe("invalid_request")
  })

  test("name an unknown method and list the known ones", () => {
    const decoded = decodeRequest('{"id":"1","method":"pane.kill"}')
    if (!("reply" in decoded) || decoded.reply.ok) throw new Error("expected an error reply")
    expect(decoded.reply.id).toBe("1")
    expect(decoded.reply.error.code).toBe("unknown_method")
    expect(decoded.reply.error.data).toEqual({ methods: expect.arrayContaining(["orient", "launch"]) })
  })

  test("default params to an empty object", () => {
    expect(decodeRequest('{"id":"1","method":"orient"}')).toEqual({
      request: { id: "1", method: "orient", params: {} },
    })
  })
})

describe("replies", () => {
  test("round-trip success and failure", () => {
    expect(decodeReply(encodeReply(successReply("1", { instance: 3 })).trim())).toEqual({
      id: "1",
      ok: true,
      result: { instance: 3 },
    })
    const failure = errorReply("2", { code: "busy", message: "something is open", data: { surface: "help" } })
    expect(decodeReply(encodeReply(failure).trim())).toEqual(failure)
  })

  test("map a ControlFailure to its code and anything else to failed", () => {
    expect(failureFrom(new ControlFailure("not_found", "no instance 9"))).toEqual({
      code: "not_found",
      message: "no instance 9",
    })
    expect(failureFrom(new Error("boom"))).toEqual({ code: "failed", message: "boom" })
  })

  test("tolerate an answer that is not JSON", () => {
    const reply = decodeReply("garbage")
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.code).toBe("invalid_request")
  })
})

describe("targets", () => {
  test("read ids, pane ids, relative words, and names", () => {
    expect(parseTarget("3")).toEqual({ kind: "id", id: 3 })
    expect(parseTarget("p_3")).toEqual({ kind: "id", id: 3 })
    expect(parseTarget("next")).toEqual({ kind: "next" })
    expect(parseTarget("prev")).toEqual({ kind: "previous" })
    expect(parseTarget("current")).toEqual({ kind: "current" })
    expect(parseTarget("fix-flaky-test")).toEqual({ kind: "name", name: "fix-flaky-test" })
  })

  test("refuse an empty target", () => {
    expect(() => parseTarget("  ")).toThrow(ControlFailure)
  })
})
