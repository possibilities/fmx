import type { TerminalColors } from "@opentui/core"
import { hostRamp } from "./host-palette.ts"

/**
 * The area outside the sizing owner's frame stays visually quiet: one flat
 * field. It is the Ramp's first step away from the host background toward its
 * foreground: lighter on a dark canvas and darker on a light canvas, while
 * remaining below every raised surface.
 */
export function unusedSpaceBackground(colors: TerminalColors | null): string {
  return hostRamp(colors).unused
}

/** Paint every physical Client before OpenTUI repaints only the owner-sized frame. */
export function clearToUnusedSpace(
  colors: TerminalColors | null,
  options: { concealCursor?: boolean } = {},
): string {
  const background = unusedSpaceBackground(colors)
  const red = parseInt(background.slice(1, 3), 16)
  const green = parseInt(background.slice(3, 5), 16)
  const blue = parseInt(background.slice(5, 7), 16)
  const concealCursor = options.concealCursor ? "\x1b[?25l" : ""
  return `${concealCursor}\x1b[48;2;${red};${green};${blue}m\x1b[2J\x1b[H\x1b[0m`
}

/**
 * Start one synchronized terminal update with the physical clear. OpenTUI's
 * immediately requested frame starts the same mode again, then its ordinary
 * synchronized-output end marker publishes the clear and resized UI together.
 */
export function beginSynchronizedResizeClear(colors: TerminalColors | null): string {
  return `\x1b[?2026h${clearToUnusedSpace(colors, { concealCursor: true })}`
}

/**
 * Paint only the sizing owner's frame with the terminal's native default
 * background while its RGB value is still being queried. ECH is deliberate:
 * unlike a line erase, it stops at the owner's right edge on a larger Client.
 */
export function paintSizingOwnerDefaultBackground(cols: number, rows: number): string {
  const width = terminalDimension(cols)
  const height = terminalDimension(rows)
  const eraseRows = Array.from(
    { length: height },
    (_, row) => `\x1b[${row + 1};1H\x1b[${width}X`,
  ).join("")
  return `\x1b[49m${eraseRows}\x1b[H\x1b[0m`
}

function terminalDimension(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(0xffff, Math.trunc(value)))
}
