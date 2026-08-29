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
  test("reads stable ids, display ids, relative words, and names", () => {
    const agentId = "0123456789abcdef0123456789abcdef"
    expect(parseTarget("3")).toEqual({ kind: "display_id", displayId: 3 })
    expect(parseTarget(agentId)).toEqual({ kind: "agent_id", agentId })
    expect(parseTarget(`p_${agentId}`)).toEqual({ kind: "pane_id", paneId: `p_${agentId}` })
    expect(parseTarget("next")).toEqual({ kind: "next" })
    expect(parseTarget("current")).toEqual({ kind: "current" })
    expect(parseTarget("fix-flaky-test")).toEqual({ kind: "name", name: "fix-flaky-test" })
  })

  test("refuse an empty target", () => {
    expect(() => parseTarget("  ")).toThrow(ControlFailure)
  })
})
