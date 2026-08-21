import { expect, test } from "bun:test"
import { BoxRenderable, type RGBA, type TerminalColors, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Multiplexer } from "../src/multiplexer.ts"

test("renders no persistent chrome and themes keyboard-opened help", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: process.cwd(),
    initialFxArgs: [],
    maxScrollback: 1_000,
    hostPalette: hostPalette("#102030", "#f1f2f3", "#00aabb"),
  })

  const stage = setup.renderer.root.findDescendantById("fmx-stage")
  const helpModal = setup.renderer.root.findDescendantById("fmx-help")
  const helpText = setup.renderer.root.findDescendantById("fmx-help-text")

  expect(stage).toBeInstanceOf(BoxRenderable)
  expect(helpModal).toBeInstanceOf(BoxRenderable)
  expect(helpText).toBeInstanceOf(TextRenderable)
  expect(setup.renderer.root.findDescendantById("fmx-header")).toBeUndefined()
  expect(setup.renderer.root.findDescendantById("fmx-footer")).toBeUndefined()
  if (!(stage instanceof BoxRenderable)) return
  if (!(helpModal instanceof BoxRenderable) || !(helpText instanceof TextRenderable)) return

  try {
    await setup.renderOnce()
    expect([stage.x, stage.y, stage.width, stage.height]).toEqual([0, 0, 80, 24])
    expect(helpModal.visible).toBe(false)
    expect(setup.captureCharFrame()).not.toContain("fmx commands")

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("?")
    await setup.renderOnce()

    expect(helpModal.visible).toBe(true)
    expect(setup.captureCharFrame()).toContain("fmx commands")
    expect(rgb(helpModal.backgroundColor)).toEqual([241, 242, 243])
    expect(rgb(helpModal.borderColor)).toEqual([0, 170, 187])
    expect(rgb(helpModal.titleColor)).toEqual([0, 170, 187])
    expect(rgb(helpText.fg)).toEqual([16, 32, 48])
    expect(rgb(helpText.bg)).toEqual([241, 242, 243])

    multiplexer.setHostPalette(hostPalette("#e8e9ea", "#111213", "#33ccdd"))

    expect(rgb(helpModal.backgroundColor)).toEqual([17, 18, 19])
    expect(rgb(helpModal.borderColor)).toEqual([51, 204, 221])
    expect(rgb(helpModal.titleColor)).toEqual([51, 204, 221])
    expect(rgb(helpText.fg)).toEqual([232, 233, 234])
    expect(rgb(helpText.bg)).toEqual([17, 18, 19])

    setup.mockInput.pressKey("?")
    await setup.renderOnce()
    expect(helpModal.visible).toBe(false)
    expect(setup.captureCharFrame()).not.toContain("fmx commands")
  } finally {
    await multiplexer.shutdown()
  }
})

function hostPalette(foreground: string, background: string, accent: string): TerminalColors {
  const palette: Array<string | null> = Array(16).fill(null)
  palette[14] = accent
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

function rgb(color: RGBA | undefined): number[] | undefined {
  return color?.toInts().slice(0, 3)
}
