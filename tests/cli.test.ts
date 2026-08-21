import { describe, expect, test } from "bun:test"
import { parseArgs } from "../src/cli.ts"

describe("parseArgs", () => {
  test("passes trailing arguments only after the separator", () => {
    expect(parseArgs([]).initialFxArgs).toEqual([])
    expect(parseArgs(["--", "--record"]).initialFxArgs).toEqual(["--record"])
    expect(() => parseArgs(["--record"])).toThrow("unknown option")
  })

  test("parses help and version flags", () => {
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--version"]).version).toBe(true)
  })
})
