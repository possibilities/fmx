import { expect, test } from "bun:test"
import {
  beginSynchronizedFrame,
  beginSynchronizedResizeClear,
  clearToUnusedSpace,
  endSynchronizedFrame,
  unusedSpaceBackground,
} from "../src/unused-space.ts"

test("unused space uses the fixed step nearest each fxnk canvas", () => {
  expect(unusedSpaceBackground("dark").intent).toBe("indexed")
  expect(unusedSpaceBackground("dark").slot).toBe(235)
  expect(unusedSpaceBackground("light").intent).toBe("indexed")
  expect(unusedSpaceBackground("light").slot).toBe(255)
})

test("the clear paints a flat indexed field, homes the cursor, and resets color", () => {
  expect(clearToUnusedSpace("dark")).toBe("\x1b[48;5;235m\x1b[2J\x1b[H\x1b[0m")
  expect(clearToUnusedSpace("light")).toBe("\x1b[48;5;255m\x1b[2J\x1b[H\x1b[0m")
})

test("a resize clear conceals the cursor before homing it", () => {
  expect(clearToUnusedSpace("dark", { concealCursor: true })).toBe(
    "\x1b[?25l\x1b[48;5;235m\x1b[2J\x1b[H\x1b[0m",
  )
})

test("a resize clear joins the synchronized update the next OpenTUI frame closes", () => {
  expect(beginSynchronizedResizeClear("light")).toBe(
    "\x1b[?2026h\x1b[?25l\x1b[48;5;255m\x1b[2J\x1b[H\x1b[0m",
  )
})

test("a full-screen transition conceals the cursor before OpenTUI takes over", () => {
  expect(beginSynchronizedFrame()).toBe("\x1b[?2026h\x1b[?25l")
  expect(endSynchronizedFrame()).toBe("\x1b[?2026l")
})
