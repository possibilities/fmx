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

/** Both defaults answered, so the ramp is the host's rather than the fallback tier. */
export function hasDetectedDefaults(colors: TerminalColors | null): boolean {
  return (
    detectedTerminalColor(colors?.defaultForeground) !== null &&
    detectedTerminalColor(colors?.defaultBackground) !== null
  )
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
 * The ramp: every color fmx paints on a surface of its own — the tray, the
 * help and error modals, the launch dialog, the toast, and the unused field
 * around a smaller sizing owner.
 *
 * fx draws with five fixed grays. fmx reproduces the relationships between
 * them as blends between the host terminal's own background and foreground,
 * so fmx never paints a theme the terminal did not choose. The ratios are
 * fx's (fxnk `style/tokens.json`: 255/252/250/245/240 on a dark canvas,
 * 235/238/241/247/250 on a light one); the fallback tier, for a host that
 * answers no color query, keeps fx's dark column exactly and derives fmx's
 * two fill steps from its endpoints. Two hues survive — focus, the host's
 * blue, and error, the host's red. Nothing else takes a hue: state is carried
 * by glyph and weight.
 */
const RAMP_BLEND = {
  /** fx 252 — one step below primary: semantic-state text, a done marker. */
  accent: 0.85,
  /** fx 250 — labels and secondary text. */
  secondary: 0.75,
  /** fx 245 — chrome, standing hints, agent names. */
  dim: 0.5,
  /** fx 240 — hairlines, nearest the background. */
  divider: 0.3,
  /** Below the divider: a raised fill — the active tray row, the toast body. */
  surface: 0.12,
  /** Below every surface: the flat field outside a smaller sizing owner. */
  unused: 0.06,
} as const

export const RAMP_FALLBACK = {
  background: "#1c1c1c",
  unused: "#292929",
  surface: "#353535",
  divider: "#585858",
  dim: "#8a8a8a",
  secondary: "#bcbcbc",
  accent: "#d0d0d0",
  foreground: "#eeeeee",
  focus: "#7dd3fc",
  error: "#e5484d",
  backdrop: "#00000033",
}

export type Ramp = typeof RAMP_FALLBACK

/** fx's light-column primary, for a host whose background answered light but
 * whose foreground did not. */
const LIGHT_FALLBACK_FOREGROUND = "#262626"

export function hostRamp(colors: TerminalColors | null): Ramp {
  const focus = ansi(colors, 4, 12) ?? RAMP_FALLBACK.focus
  const error = ansi(colors, 1, 9) ?? RAMP_FALLBACK.error
  const detectedForeground = detectedTerminalColor(colors?.defaultForeground)
  const detectedBackground = detectedTerminalColor(colors?.defaultBackground)
  if (!detectedForeground && !detectedBackground) return { ...RAMP_FALLBACK, focus, error }

  const background = detectedBackground ?? RAMP_FALLBACK.background
  const foreground =
    detectedForeground ??
    (detectedBackground && isLight(detectedBackground) ? LIGHT_FALLBACK_FOREGROUND : RAMP_FALLBACK.foreground)
  const step = (amount: number) => mixHexColors(background, foreground, amount)
  return {
    background,
    unused: step(RAMP_BLEND.unused),
    surface: step(RAMP_BLEND.surface),
    divider: step(RAMP_BLEND.divider),
    dim: step(RAMP_BLEND.dim),
    secondary: step(RAMP_BLEND.secondary),
    accent: step(RAMP_BLEND.accent),
    foreground,
    focus,
    error,
    backdrop: RAMP_FALLBACK.backdrop,
  }
}

/** Weighted channel brightness is enough to tell a light canvas from a dark one. */
function isLight(color: string): boolean {
  const red = parseInt(color.slice(1, 3), 16)
  const green = parseInt(color.slice(3, 5), 16)
  const blue = parseInt(color.slice(5, 7), 16)
  return red * 0.299 + green * 0.587 + blue * 0.114 > 128
}

/** Prefer the normal ANSI slot, fall back to its bright twin. */
function ansi(colors: TerminalColors | null, normal: number, bright: number): string | null {
  return detectedTerminalColor(colors?.palette[normal]) ?? detectedTerminalColor(colors?.palette[bright])
}
