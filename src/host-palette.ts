import type { TerminalColors, ThemeMode } from "@opentui/core"

const DIM_TEXT_BLEND = 0.3

const OSC = "\x1b]"
const ST = "\x1b\\"
const ANSI_PALETTE_SIZE = 16

type DynamicColorKey = Exclude<keyof TerminalColors, "palette">

const DYNAMIC_COLORS: ReadonlyArray<readonly [number, DynamicColorKey]> = [
  [10, "defaultForeground"],
  [11, "defaultBackground"],
  [12, "cursorColor"],
  [13, "mouseForeground"],
  [14, "mouseBackground"],
  [15, "tekForeground"],
  [16, "tekBackground"],
  [17, "highlightBackground"],
  [19, "highlightForeground"],
]

const DARK_THEME_REPORT = new TextEncoder().encode("\x1b[?997;1n")
const LIGHT_THEME_REPORT = new TextEncoder().encode("\x1b[?997;2n")

/** Build terminal-native color updates for an embedded terminal. */
export function buildHostPaletteSequence(colors: TerminalColors): string {
  const sequences: string[] = []
  const ansiColors: string[] = []

  for (let index = 0; index < Math.min(colors.palette.length, ANSI_PALETTE_SIZE); index += 1) {
    const color = detectedTerminalColor(colors.palette[index])
    if (color) ansiColors.push(`${index};${color}`)
  }
  if (ansiColors.length > 0) sequences.push(`${OSC}4;${ansiColors.join(";")}${ST}`)

  for (const [osc, key] of DYNAMIC_COLORS) {
    const color = detectedTerminalColor(colors[key])
    if (color) sequences.push(`${OSC}${osc};${color}${ST}`)
  }

  return sequences.join("")
}

export function hasDetectedBackground(colors: TerminalColors): boolean {
  return detectedTerminalColor(colors.defaultBackground) !== null
}

/** Ghostty's color-scheme notification consumed by fx's theme monitor. */
export function themeModeReport(mode: ThemeMode): Uint8Array {
  return mode === "light" ? LIGHT_THEME_REPORT : DARK_THEME_REPORT
}

/**
 * Blend `base` toward `tint` by `amount` (0..1). Both must be `#rrggbb`, which
 * is what `detectedTerminalColor` guarantees. Used for surfaces that should sit
 * a measured distance from the terminal's own background rather than at a fixed
 * grey the theme never chose.
 */
export function mixHexColors(base: string, tint: string, amount: number): string {
  const channel = (offset: number) => {
    const from = parseInt(base.slice(offset, offset + 2), 16)
    const to = parseInt(tint.slice(offset, offset + 2), 16)
    return Math.round(from + (to - from) * amount)
      .toString(16)
      .padStart(2, "0")
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

export function detectedTerminalColor(color: string | null | undefined): string | null {
  if (!color || !/^#[0-9a-f]{6}$/iu.test(color)) return null
  return color.toLowerCase()
}

/**
 * Colors for fmx's own surfaces drawn over the terminal — the help modal, the
 * spawn error, the launch dialog. They are derived from the host's palette so
 * fmx never paints a theme the terminal did not choose; the fallbacks are only
 * for a host that answers no color query at all.
 */
export const MODAL_FALLBACK_COLORS = {
  background: "#232938",
  foreground: "#d8dee9",
  accent: "#7dd3fc",
  backdrop: "#00000033",
  error: "#f87171",
  key: "#a3a3a3",
  dim: "#6b7280",
}

export type ModalColors = typeof MODAL_FALLBACK_COLORS

export function modalColors(colors: TerminalColors | null): ModalColors {
  const foreground =
    detectedTerminalColor(colors?.defaultForeground) ?? MODAL_FALLBACK_COLORS.foreground
  return {
    foreground,
    background: detectedTerminalColor(colors?.defaultBackground) ?? MODAL_FALLBACK_COLORS.background,
    accent:
      detectedTerminalColor(colors?.palette[4]) ??
      detectedTerminalColor(colors?.palette[12]) ??
      MODAL_FALLBACK_COLORS.accent,
    backdrop: MODAL_FALLBACK_COLORS.backdrop,
    error:
      detectedTerminalColor(colors?.palette[1]) ??
      detectedTerminalColor(colors?.palette[9]) ??
      MODAL_FALLBACK_COLORS.error,
    key:
      detectedTerminalColor(colors?.palette[7]) ??
      detectedTerminalColor(colors?.palette[8]) ??
      foreground,
    dim: dimColor(colors, foreground),
  }
}

/** Standing instructional text — a hint that is always on screen — sits
 * nearer the background than any other text, the way the divider does: it has
 * to be readable when looked for and recede when it is not. */
function dimColor(colors: TerminalColors | null, foreground: string): string {
  const background = detectedTerminalColor(colors?.defaultBackground)
  if (background) return mixHexColors(background, foreground, DIM_TEXT_BLEND)
  return detectedTerminalColor(colors?.palette[8]) ?? MODAL_FALLBACK_COLORS.dim
}
