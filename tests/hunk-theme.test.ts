import { expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostRamp, RAMP_FALLBACK, type Ramp } from "../src/host-palette.ts"
import {
  DIFF_ADDED_COLOR,
  DIFF_REMOVED_COLOR,
  HUNK_RAMP_ENV_VAR,
  HUNK_THEME_ID,
  hunkRampValue,
  materializeHunkThemeExtension,
} from "../src/hunk-theme.ts"

const HEX = /^#[0-9a-f]{6}$/u

/**
 * Load the extension the way hunk loads it: a real file, imported, handed an
 * object with `registerTheme`. Testing the string any other way would test a
 * copy of it rather than the thing that ships.
 */
async function registeredTheme(ramp: string | undefined): Promise<Record<string, unknown> | null> {
  const directory = await mkdtemp(join(tmpdir(), "fmx-hunk-theme-"))
  const path = join(directory, "hunk-theme.js")
  try {
    await materializeHunkThemeExtension(path)
    const previous = process.env[HUNK_RAMP_ENV_VAR]
    if (ramp === undefined) delete process.env[HUNK_RAMP_ENV_VAR]
    else process.env[HUNK_RAMP_ENV_VAR] = ramp
    try {
      const module = (await import(path)) as { default: (hunk: unknown) => void }
      let registered: Record<string, unknown> | null = null
      module.default({ registerTheme: (theme: Record<string, unknown>) => (registered = theme) })
      return registered
    } finally {
      if (previous === undefined) delete process.env[HUNK_RAMP_ENV_VAR]
      else process.env[HUNK_RAMP_ENV_VAR] = previous
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("the extension is written private and rewritten over whatever was there", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-hunk-theme-"))
  const path = join(directory, "hunk-theme.js")
  try {
    await Bun.write(path, "// somebody else's idea")
    await materializeHunkThemeExtension(path)
    const written = await Bun.file(path).text()
    expect(written).not.toContain("somebody else")
    expect(written).toContain("registerTheme")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("every color the theme registers is a hex literal hunk will accept", async () => {
  const theme = await registeredTheme(hunkRampValue(RAMP_FALLBACK))
  expect(theme).not.toBeNull()
  const entries = Object.entries(theme!).filter(([key]) => key !== "id" && key !== "label" && key !== "base")
  expect(entries.length).toBeGreaterThan(25)
  for (const [key, value] of entries) {
    expect(`${key}=${value}`).toMatch(new RegExp(`^${key}=#[0-9a-f]{6}$`, "u"))
  }
  expect(theme!.id).toBe(HUNK_THEME_ID)
  // Syntax highlighting is the one thing inherited, so code stays readable.
  expect(theme).not.toHaveProperty("syntaxScopes")
})

test("the Ramp paints every neutral surface and the diff carries the two hues", async () => {
  const ramp = hostRamp(colors("#0d1117", "#e6edf3"))
  const theme = (await registeredTheme(hunkRampValue(ramp)))!

  expect(theme.base).toBe("github-dark-default")
  expect(theme.background).toBe(ramp.background)
  expect(theme.contextBg).toBe(ramp.background)
  expect(theme.lineNumberBg).toBe(ramp.background)
  expect(theme.panel).toBe(ramp.surface)
  expect(theme.panelAlt).toBe(ramp.surface)
  expect(theme.border).toBe(ramp.divider)
  expect(theme.text).toBe(ramp.foreground)
  expect(theme.muted).toBe(ramp.dim)
  expect(theme.lineNumberFg).toBe(ramp.dim)

  // Selection is the Ramp's one blue over its raised fill, never a diff hue.
  expect(theme.accent).toBe(ramp.focus)
  expect(theme.accentMuted).toBe(ramp.surface)
  expect(theme.selectedHunk).toBe(ramp.surface)
  expect(theme.noteBorder).toBe(ramp.focus)
  expect(theme.noteBackground).toBe(ramp.surface)

  // The signs are full strength; the row and word-diff spans are the same hues
  // mixed toward the host's background, the row fainter than the span.
  expect(theme.addedSignColor).toBe(DIFF_ADDED_COLOR)
  expect(theme.removedSignColor).toBe(DIFF_REMOVED_COLOR)
  expect(theme.badgeAdded).toBe(DIFF_ADDED_COLOR)
  expect(theme.badgeRemoved).toBe(DIFF_REMOVED_COLOR)
  expect(theme.fileNew).toBe(DIFF_ADDED_COLOR)
  expect(theme.fileDeleted).toBe(DIFF_REMOVED_COLOR)
  expect(theme.movedAddedBg).toBe(theme.addedBg)
  expect(theme.movedRemovedBg).toBe(theme.removedBg)
  for (const [row, span, sign] of [
    [theme.addedBg, theme.addedContentBg, DIFF_ADDED_COLOR],
    [theme.removedBg, theme.removedContentBg, DIFF_REMOVED_COLOR],
  ] as const) {
    expect(row).not.toBe(ramp.background)
    expect(distance(row as string, ramp.background)).toBeLessThan(distance(span as string, ramp.background))
    expect(distance(span as string, sign)).toBeLessThan(distance(row as string, sign))
  }

  // Everything that is not add-or-remove stays on the Ramp's grays.
  expect(theme.badgeNeutral).toBe(ramp.dim)
  expect(theme.fileModified).toBe(ramp.secondary)
  expect(theme.fileRenamed).toBe(ramp.secondary)
  expect(theme.fileUntracked).toBe(ramp.dim)
})

test("a light host takes the light base and tints toward its own background", async () => {
  const light = hostRamp(colors("#ffffff", "#1f2328"))
  const theme = (await registeredTheme(hunkRampValue(light)))!

  expect(theme.base).toBe("github-light-default")
  expect(theme.background).toBe("#ffffff")
  // The signs do not change column — fx paints the same two on either canvas.
  expect(theme.addedSignColor).toBe(DIFF_ADDED_COLOR)
  expect(theme.removedSignColor).toBe(DIFF_REMOVED_COLOR)
  // A tint mixed toward white is lighter than the sign it came from, which is
  // the whole reason the tints are computed rather than shipped as constants.
  expect(luminance(theme.addedBg as string)).toBeGreaterThan(luminance(DIFF_ADDED_COLOR))
  expect(luminance(theme.removedBg as string)).toBeGreaterThan(luminance(DIFF_REMOVED_COLOR))
  expect(theme.addedBg).toMatch(HEX)
  expect(theme.removedBg).toMatch(HEX)
})

test("a missing or unusable Ramp registers nothing, leaving hunk its own theme", async () => {
  expect(await registeredTheme(undefined)).toBeNull()
  expect(await registeredTheme("")).toBeNull()
  expect(await registeredTheme("not json")).toBeNull()
  expect(await registeredTheme("[]")).toBeNull()
  expect(await registeredTheme(JSON.stringify({ background: "#0d1117" }))).toBeNull()
  // A slot hunk would reject takes the whole theme down rather than leaking
  // the base theme's colors into a surface fmx claims to own.
  expect(await registeredTheme(JSON.stringify({ ...RAMP_FALLBACK, focus: "rgb(1,2,3)" }))).toBeNull()
  expect(await registeredTheme(JSON.stringify({ ...RAMP_FALLBACK, dim: "#abc" }))).toBeNull()
})

function colors(background: string, foreground: string) {
  return {
    defaultBackground: background,
    defaultForeground: foreground,
    palette: Array.from({ length: 16 }, () => null),
  } as unknown as Parameters<typeof hostRamp>[0]
}

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function distance(a: string, b: string): number {
  const [ar, ag, ab] = channels(a)
  const [br, bg, bb] = channels(b)
  return Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)
}

function luminance(hex: string): number {
  const [red, green, blue] = channels(hex)
  return red * 0.299 + green * 0.587 + blue * 0.114
}

/** The Ramp type is what the extension is documented against; keep them tied. */
const _rampShape: Ramp = RAMP_FALLBACK
void _rampShape
