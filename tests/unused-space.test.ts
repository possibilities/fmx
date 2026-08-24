import { expect, test } from "bun:test"
import type { TerminalColors } from "@opentui/core"
import { clearToUnusedSpace, unusedSpaceBackground } from "../src/unused-space.ts"

test("unused space darkens a dark host background", () => {
  expect(unusedSpaceBackground(hostPalette("#202830"), "dark")).toBe("#181e24")
  expect(unusedSpaceBackground(hostPalette("#202830"), null)).toBe("#181e24")
})

test("unused space lightens a light host background", () => {
  expect(unusedSpaceBackground(hostPalette("#e0e8f0"), "light")).toBe("#e8eef4")
  expect(unusedSpaceBackground(hostPalette("#e0e8f0"), null)).toBe("#e8eef4")
})

test("the clear paints a flat field, homes the cursor, and resets the drawing color", () => {
  expect(clearToUnusedSpace(hostPalette("#202830"), "dark")).toBe(
    "\x1b[48;2;24;30;36m\x1b[2J\x1b[H\x1b[0m",
  )
})

function hostPalette(background: string): TerminalColors {
  return {
    palette: Array(16).fill(null),
    defaultForeground: null,
    defaultBackground: background,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}
