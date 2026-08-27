import type { RGBA } from "@opentui/core"
import { type FxnkTheme, fxnkRamp } from "./host-palette.ts"

/**
 * The area outside the sizing owner's frame stays visually quiet: one flat
 * field. It is the fixed fxnk step nearest the terminal-default canvas,
 * remaining below every raised surface.
 */
export function unusedSpaceBackground(theme: FxnkTheme): RGBA {
  return fxnkRamp(theme).unused
}

/** Paint every physical Client before OpenTUI repaints only the owner-sized frame. */
export function clearToUnusedSpace(
  theme: FxnkTheme,
  options: { concealCursor?: boolean } = {},
): string {
  const background = unusedSpaceBackground(theme)
  const concealCursor = options.concealCursor ? "\x1b[?25l" : ""
  return `${concealCursor}\x1b[48;5;${background.slot}m\x1b[2J\x1b[H\x1b[0m`
}

/** Hold a terminal transition until OpenTUI publishes its next complete frame. */
export function beginSynchronizedFrame(): string {
  return "\x1b[?2026h\x1b[?25l"
}

/** Release a transition when startup cannot hand it to an OpenTUI frame. */
export function endSynchronizedFrame(): string {
  return "\x1b[?2026l"
}

/**
 * Start one synchronized terminal update with the physical clear. OpenTUI's
 * immediately requested frame starts the same mode again, then its ordinary
 * synchronized-output end marker publishes the clear and resized UI together.
 */
export function beginSynchronizedResizeClear(theme: FxnkTheme): string {
  return `${beginSynchronizedFrame()}${clearToUnusedSpace(theme)}`
}
