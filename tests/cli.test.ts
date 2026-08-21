import { describe, expect, test } from "bun:test"
import { parseArgs } from "../src/cli.ts"

describe("parseArgs", () => {
  test("uses the current workspace by default", () => {
    expect(parseArgs([], "/tmp/work")).toMatchObject({
      cwd: "/tmp/work",
      initialFxArgs: [],
      maxScrollback: 10_000_000,
    })
  })

  test("passes trailing arguments only after the separator", () => {
    expect(parseArgs(["--", "--record"]).initialFxArgs).toEqual(["--record"])
    expect(() => parseArgs(["--record"])).toThrow("unknown option")
  })

  test("resolves a requested workspace", () => {
    expect(parseArgs(["-C", "project"], "/tmp").cwd).toBe("/tmp/project")
  })

  test("rejects scrollback values outside OpenTUI's native u32 range", () => {
    expect(() => parseArgs(["--scrollback", "-1"])).toThrow("between 0")
    expect(() => parseArgs(["--scrollback", "4294967296"])).toThrow("between 0")
  })
})
