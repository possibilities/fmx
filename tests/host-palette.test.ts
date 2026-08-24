import { expect, test } from "bun:test"
import type { TerminalColors } from "@opentui/core"
import { hasDetectedDefaults, hostRamp, mixHexColors, RAMP_FALLBACK } from "../src/host-palette.ts"

const HEX = /^#[0-9a-f]{6}$/u

function host(
  foreground: string | null,
  background: string | null,
  slots: Record<number, string> = {},
): TerminalColors {
  const palette: Array<string | null> = Array(16).fill(null)
  for (const [index, color] of Object.entries(slots)) palette[Number(index)] = color
  return {
    palette,
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

test("a host that answers nothing gets the fallback Ramp verbatim", () => {
  expect(hostRamp(null)).toEqual(RAMP_FALLBACK)
  expect(hostRamp(host(null, null))).toEqual(RAMP_FALLBACK)
  expect(hasDetectedDefaults(null)).toBe(false)
})

test("focus and error come from the ANSI slots, normal before bright, even without defaults", () => {
  expect(hostRamp(host(null, null, { 12: "#112233", 9: "#aa0000" }))).toEqual({
    ...RAMP_FALLBACK,
    focus: "#112233",
    error: "#aa0000",
  })
  expect(hostRamp(host(null, null, { 4: "#0000aa", 12: "#112233", 1: "#bb0000", 9: "#aa0000" }))).toEqual({
    ...RAMP_FALLBACK,
    focus: "#0000aa",
    error: "#bb0000",
  })
})

test("blends every step from the host background toward its foreground in fx's ratios", () => {
  const ramp = hostRamp(host("#f0f0f0", "#101010"))
  expect(hasDetectedDefaults(host("#f0f0f0", "#101010"))).toBe(true)
  expect(ramp.background).toBe("#101010")
  expect(ramp.foreground).toBe("#f0f0f0")
  expect(ramp.unused).toBe(mixHexColors("#101010", "#f0f0f0", 0.06))
  expect(ramp.surface).toBe(mixHexColors("#101010", "#f0f0f0", 0.12))
  expect(ramp.divider).toBe(mixHexColors("#101010", "#f0f0f0", 0.3))
  expect(ramp.dim).toBe(mixHexColors("#101010", "#f0f0f0", 0.5))
  expect(ramp.secondary).toBe(mixHexColors("#101010", "#f0f0f0", 0.75))
  expect(ramp.accent).toBe(mixHexColors("#101010", "#f0f0f0", 0.85))
  expect(ramp.backdrop).toBe(RAMP_FALLBACK.backdrop)
})

test("a background alone picks fx's light or dark primary by its brightness", () => {
  const light = hostRamp(host(null, "#f5f5f5"))
  expect(light.foreground).toBe("#262626")
  expect(light.dim).toBe(mixHexColors("#f5f5f5", "#262626", 0.5))
  const dark = hostRamp(host(null, "#202020"))
  expect(dark.foreground).toBe(RAMP_FALLBACK.foreground)
  expect(hasDetectedDefaults(host(null, "#f5f5f5"))).toBe(false)
})

test("a foreground alone blends against the fallback background", () => {
  const ramp = hostRamp(host("#a0a0a0", null))
  expect(ramp.background).toBe(RAMP_FALLBACK.background)
  expect(ramp.foreground).toBe("#a0a0a0")
  expect(ramp.divider).toBe(mixHexColors(RAMP_FALLBACK.background, "#a0a0a0", 0.3))
})

test("every step is a well-formed hex color on every path", () => {
  for (const colors of [null, host(null, null), host("#F0F0F0", "#101010"), host(null, "#fafafa"), host("#abcdef", null), host("not-a-color", "#101010")]) {
    const ramp = hostRamp(colors)
    for (const [key, value] of Object.entries(ramp)) {
      if (key === "backdrop") continue
      expect(value).toMatch(HEX)
    }
  }
})
