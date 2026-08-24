import type { TerminalColors, ThemeMode } from "@opentui/core"
import { detectedTerminalColor, mixHexColors, RAMP_FALLBACK } from "./host-palette.ts"

/** Enough separation to read as unused without becoming a second surface. */
const UNUSED_SPACE_BLEND = 0.25

/**
 * The area outside the sizing owner's frame stays visually quiet: one flat
 * field, derived from the same host background as the shared UI. Dark themes
 * move toward black and light themes toward white.
 */
export function unusedSpaceBackground(colors: TerminalColors | null, themeMode: ThemeMode | null): string {
  const background = detectedTerminalColor(colors?.defaultBackground) ?? RAMP_FALLBACK.background
  const mode = themeMode ?? (brightness(background) >= 128 ? "light" : "dark")
  return mixHexColors(background, mode === "light" ? "#ffffff" : "#000000", UNUSED_SPACE_BLEND)
}

/** Paint every physical Client before OpenTUI repaints only the owner-sized frame. */
export function clearToUnusedSpace(colors: TerminalColors | null, themeMode: ThemeMode | null): string {
  const background = unusedSpaceBackground(colors, themeMode)
  const red = parseInt(background.slice(1, 3), 16)
  const green = parseInt(background.slice(3, 5), 16)
  const blue = parseInt(background.slice(5, 7), 16)
  return `\x1b[48;2;${red};${green};${blue}m\x1b[2J\x1b[H\x1b[0m`
}

function brightness(color: string): number {
  const red = parseInt(color.slice(1, 3), 16)
  const green = parseInt(color.slice(3, 5), 16)
  const blue = parseInt(color.slice(5, 7), 16)
  return red * 0.299 + green * 0.587 + blue * 0.114
}
