import { describe, expect, test } from "bun:test"
import packageMetadata from "../package.json" with { type: "json" }
import { parseArgs, VERSION } from "../src/cli.ts"

describe("parseArgs", () => {
  test("rejects anything other than fmx options", () => {
    expect(parseArgs([])).toEqual({ help: false, version: false })
    expect(() => parseArgs(["--record"])).toThrow("unknown option")
    expect(() => parseArgs(["--", "--record"])).toThrow("unknown option: --")
  })

  test("parses help and version flags", () => {
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--version"]).version).toBe(true)
  })

  test("uses the package version", () => {
    expect(VERSION).toBe(packageMetadata.version)
  })
})
