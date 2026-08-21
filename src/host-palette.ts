import type { TerminalColors, ThemeMode } from "@opentui/core"

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

export function detectedTerminalColor(color: string | null | undefined): string | null {
  if (!color || !/^#[0-9a-f]{6}$/iu.test(color)) return null
  return color.toLowerCase()
}
