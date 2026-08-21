import { describe, expect, test } from "bun:test"
import {
  commandKeyName,
  hasCommandModifier,
  isPrefixKey,
  isSuspendKey,
  keyIdentity,
  type CommandKey,
} from "../src/keys.ts"

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

test("prefix detection accepts plain Ctrl-B on semantic and base layouts", () => {
  expect(isPrefixKey(key({ name: "b", ctrl: true }))).toBe(true)
  expect(isPrefixKey(key({ name: "β", ctrl: true, baseCode: 98 }))).toBe(true)
  expect(isPrefixKey(key({ name: "b", ctrl: false }))).toBe(false)
  expect(isPrefixKey(key({ name: "b", ctrl: true, shift: true }))).toBe(false)
  expect(isPrefixKey(key({ name: "b", ctrl: true, option: true }))).toBe(false)
})

test("suspend detection accepts plain Ctrl-Z on semantic and base layouts", () => {
  expect(isSuspendKey(key({ name: "z", ctrl: true }))).toBe(true)
  expect(isSuspendKey(key({ name: "ω", ctrl: true, baseCode: 122 }))).toBe(true)
  expect(isSuspendKey(key({ name: "z", ctrl: true, meta: true }))).toBe(false)
})

test("command modifier detection allows Shift but rejects command modifiers", () => {
  expect(hasCommandModifier(key({ shift: true }))).toBe(false)
  expect(hasCommandModifier(key({ ctrl: true }))).toBe(true)
  expect(hasCommandModifier(key({ option: true }))).toBe(true)
  expect(hasCommandModifier(key({ super: true }))).toBe(true)
})

test("release identity survives modifier changes for the same physical key", () => {
  expect(keyIdentity(key({ code: "KeyR", ctrl: true }))).toBe(keyIdentity(key({ code: "KeyR", ctrl: false })))
  expect(keyIdentity(key({ code: "KeyR" }))).not.toBe(keyIdentity(key({ code: "KeyB" })))
})
