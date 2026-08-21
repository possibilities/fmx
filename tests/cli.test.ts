import { describe, expect, test } from "bun:test"
import { parseArgs } from "../src/cli.ts"

describe("parseArgs", () => {
  test("uses the current workspace by default", () => {
    expect(parseArgs([], "/tmp/work")).toMatchObject({
      cwd: "/tmp/work",
      initialFxArgs: [],
      maxScrollback: 1_000_000,
    })
  })

  test("maps resume modes to fx's interactive launch language", () => {
    expect(parseArgs(["-r"]).initialFxArgs).toEqual(["-r"])
    expect(parseArgs(["--resume-last"]).initialFxArgs).toEqual(["--resume-last"])
    expect(parseArgs(["--resume", "session-123"]).initialFxArgs).toEqual(["--resume", "session-123"])
  })

  test("passes trailing arguments only after the separator", () => {
    expect(parseArgs(["--", "--record"]).initialFxArgs).toEqual(["--record"])
    expect(() => parseArgs(["--record"])).toThrow("unknown option")
    expect(() => parseArgs(["-r", "--", "--record"])).toThrow("conflicts")
  })

  test("resolves a requested workspace", () => {
    expect(parseArgs(["-C", "project"], "/tmp").cwd).toBe("/tmp/project")
  })

  test("rejects scrollback values outside OpenTUI's native u32 range", () => {
    expect(() => parseArgs(["--scrollback", "-1"])).toThrow("between 0")
    expect(() => parseArgs(["--scrollback", "4294967296"])).toThrow("between 0")
  })
})
