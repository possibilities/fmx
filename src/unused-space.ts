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
export function clearToUnusedSpace(colors: TerminalColors | null): string {
  const background = unusedSpaceBackground(colors)
  const red = parseInt(background.slice(1, 3), 16)
  const green = parseInt(background.slice(3, 5), 16)
  const blue = parseInt(background.slice(5, 7), 16)
  return `\x1b[48;2;${red};${green};${blue}m\x1b[2J\x1b[H\x1b[0m`
}
