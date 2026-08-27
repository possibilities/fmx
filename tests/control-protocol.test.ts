import { describe, expect, test } from "bun:test"
import {
  ControlFailure,
  failureFrom,
  parseTarget,
} from "../src/control-protocol.ts"

describe("failures", () => {
  test("map a ControlFailure to its code and anything else to failed", () => {
    expect(failureFrom(new ControlFailure("not_found", "no agent 9"))).toEqual({
      code: "not_found",
      message: "no agent 9",
    })
    expect(failureFrom(new Error("boom"))).toEqual({ code: "failed", message: "boom" })
  })

})

describe("targets", () => {
  test("read ids, pane ids, relative words, and names", () => {
    expect(parseTarget("3")).toEqual({ kind: "id", id: 3 })
    expect(parseTarget("p_3")).toEqual({ kind: "id", id: 3 })
    expect(parseTarget("next")).toEqual({ kind: "next" })
    expect(parseTarget("current")).toEqual({ kind: "current" })
    expect(parseTarget("fix-flaky-test")).toEqual({ kind: "name", name: "fix-flaky-test" })
  })

  test("refuse an empty target", () => {
    expect(() => parseTarget("  ")).toThrow(ControlFailure)
  })
})
