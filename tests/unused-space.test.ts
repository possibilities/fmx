import { expect, test } from "bun:test"
import type { TerminalColors } from "@opentui/core"
import { hostRamp } from "../src/host-palette.ts"
import { clearToUnusedSpace, unusedSpaceBackground } from "../src/unused-space.ts"

test("unused space lifts pure and near-black canvases below every raised surface", () => {
  const black = hostPalette("#000000", "#ffffff")
  expect(hostRamp(black)).toMatchObject({
    background: "#000000",
    unused: "#0f0f0f",
    surface: "#1f1f1f",
  })

  const nearBlack = hostPalette("#080808", "#f0f0f0")
  expect(hostRamp(nearBlack)).toMatchObject({
    background: "#080808",
    unused: "#161616",
    surface: "#242424",
  })
})

test("unused space lowers a light canvas above every raised surface", () => {
  const light = hostPalette("#ffffff", "#000000")
  expect(hostRamp(light)).toMatchObject({
    background: "#ffffff",
    unused: "#f0f0f0",
    surface: "#e0e0e0",
  })
})

test("unused space uses the designated Ramp step, including its fallback", () => {
  expect(unusedSpaceBackground(hostPalette("#202830"))).toBe("#2c343b")
  expect(unusedSpaceBackground(hostPalette("#e0e8f0"))).toBe("#d5dce4")
  expect(unusedSpaceBackground(null)).toBe("#292929")
})

test("the clear paints a flat field, homes the cursor, and resets the drawing color", () => {
  expect(clearToUnusedSpace(hostPalette("#202830"))).toBe(
    "\x1b[48;2;44;52;59m\x1b[2J\x1b[H\x1b[0m",
  )
})

function hostPalette(background: string, foreground: string | null = null): TerminalColors {
  return {
    palette: Array(16).fill(null),
    defaultForeground: foreground,
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
