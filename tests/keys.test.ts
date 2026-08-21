import { describe, expect, test } from "bun:test"
import { commandKeyName, isPrefixKey, keyIdentity, type CommandKey } from "../src/keys.ts"

const key = (overrides: Partial<CommandKey> = {}): CommandKey => ({
  name: "r",
  sequence: "r",
  raw: "r",
  shift: false,
  ctrl: false,
  meta: false,
  ...overrides,
})

describe("commandKeyName", () => {
  test("preserves shifted letter commands", () => {
    expect(commandKeyName(key({ name: "r", sequence: "R", raw: "R", shift: true }))).toBe("R")
  })

  test("normalizes shifted slash to question mark", () => {
    expect(commandKeyName(key({ name: "/", sequence: "?", raw: "?", shift: true }))).toBe("?")
  })

  test("retains named keys", () => {
    expect(commandKeyName(key({ name: "escape", sequence: "\u001b", raw: "\u001b" }))).toBe("escape")
  })
})

test("prefix detection accepts semantic Ctrl-B and physical base-layout b", () => {
  expect(isPrefixKey(key({ name: "b", ctrl: true }))).toBe(true)
  expect(isPrefixKey(key({ name: "β", ctrl: true, baseCode: 98 }))).toBe(true)
  expect(isPrefixKey(key({ name: "b", ctrl: false }))).toBe(false)
})

test("release identity includes modifiers", () => {
  expect(keyIdentity(key({ code: "KeyR", shift: false }))).not.toBe(keyIdentity(key({ code: "KeyR", shift: true })))
})
