import { describe, expect, test } from "bun:test"
import { expandTilde } from "../src/projects.ts"

const HOME = "/home/me"

describe("expandTilde", () => {
  test("expands home-relative directories and leaves others alone", () => {
    expect(expandTilde("~", HOME)).toBe(HOME)
    expect(expandTilde("~/code", HOME)).toBe("/home/me/code")
    expect(expandTilde("/opt/work", HOME)).toBe("/opt/work")
    expect(expandTilde("~notme/code", HOME)).toBe("~notme/code")
  })
})
