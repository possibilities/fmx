import { describe, expect, test } from "bun:test"
import {
  fxProfileDirectory,
  fxSessionDirectory,
  isSessionId,
} from "../src/fx-sessions.ts"

const SESSION_ID = "1787362101388-1787362101388156000-2897385323da2683"

describe("isSessionId", () => {
  test("accepts fx's own ids and rejects anything that could climb a path", () => {
    expect(isSessionId(SESSION_ID)).toBe(true)
    expect(isSessionId("../../etc/passwd")).toBe(false)
    expect(isSessionId("..")).toBe(false)
    expect(isSessionId("a/b")).toBe(false)
    expect(isSessionId("")).toBe(false)
  })
})

describe("fxSessionDirectory", () => {
  test("resolves under the fx profile of the given home", () => {
    const env = { HOME: "/home/me" }
    expect(fxProfileDirectory(env)).toBe("/home/me/.fx")
    expect(fxSessionDirectory(SESSION_ID, env)).toBe(`/home/me/.fx/sessions/${SESSION_ID}`)
  })

  test("answers null for an id it will not join to a path", () => {
    expect(fxSessionDirectory("../elsewhere", { HOME: "/home/me" })).toBeNull()
  })
})
