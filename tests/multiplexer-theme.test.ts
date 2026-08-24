import { expect, test } from "bun:test"
import { BoxRenderable, type RGBA, type TerminalColors, TextAttributes, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

test("themes the empty state and keyboard-opened help", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: "fx",
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  })
  multiplexer.setHostPalette(hostPalette("#102030", "#f1f2f3", "#00aabb"))

  const stage = setup.renderer.root.findDescendantById("fmx-stage")
  const modalBackdrop = setup.renderer.root.findDescendantById("fmx-modal-backdrop")
  const modal = setup.renderer.root.findDescendantById("fmx-modal")
  const modalText = setup.renderer.root.findDescendantById("fmx-modal-text")
  const emptyState = setup.renderer.root.findDescendantById("fmx-empty-state")

  expect(stage).toBeInstanceOf(BoxRenderable)
  expect(modalBackdrop).toBeInstanceOf(BoxRenderable)
  expect(modal).toBeInstanceOf(BoxRenderable)
  expect(modalText).toBeInstanceOf(TextRenderable)
  expect(emptyState).toBeInstanceOf(TextRenderable)
  expect(setup.renderer.root.findDescendantById("fmx-header")).toBeUndefined()
  expect(setup.renderer.root.findDescendantById("fmx-footer")).toBeUndefined()
  if (!(stage instanceof BoxRenderable)) return
  if (!(modalBackdrop instanceof BoxRenderable)) return
  if (!(modal instanceof BoxRenderable) || !(modalText instanceof TextRenderable)) return
  if (!(emptyState instanceof TextRenderable)) return

  try {
    await setup.renderOnce()
    expect([stage.x, stage.y, stage.width, stage.height]).toEqual([0, 0, 80, 24])
    expect(modalBackdrop.visible).toBe(false)
    expect(modal.visible).toBe(false)
    expect(setup.captureCharFrame()).toContain("prefix+c to create agent")
    // dim: halfway from the host background to its foreground.
    expect(rgb(emptyState.fg)).toEqual([129, 137, 146])

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("?")
    await setup.renderOnce()

    const helpFrame = setup.captureCharFrame()
    expect(modalBackdrop.visible).toBe(true)
    expect(modal.visible).toBe(true)
    expect([modalBackdrop.x, modalBackdrop.y, modalBackdrop.width, modalBackdrop.height]).toEqual([0, 0, 80, 24])
    expect(modal.borderStyle).toBe("single")
    expect(modal.title).toBe(" keys ")
    expect(rgb(modal.titleColor)).toEqual([16, 32, 48])
    expect(helpFrame).toContain("keybinds")
    expect(helpFrame).toContain("prefix+c")
    expect([modalText.x - modal.x, modalText.y - modal.y]).toEqual([2, 1])
    expect([
      modal.width - (modalText.x - modal.x) - modalText.width,
      modal.height - (modalText.y - modal.y) - modalText.height,
    ]).toEqual([2, 1])
    expect(rgba(modalBackdrop.backgroundColor)).toEqual([0, 0, 0, 51])
    expect(rgb(modal.backgroundColor)).toEqual([241, 242, 243])
    expect(rgb(modal.borderColor)).toEqual([0, 170, 187])
    expect(rgb(modalText.fg)).toEqual([16, 32, 48])
    expect(rgb(modalText.bg)).toEqual([241, 242, 243])
    const keyChunk = modalText.chunks.find((chunk) => chunk.text.startsWith("ctrl+b"))
    const labelChunk = modalText.chunks.find((chunk) => chunk.text === "new agent")
    // Keys are labels: bold, one step down the ramp (secondary, 75%).
    expect(rgb(keyChunk?.fg)).toEqual([72, 85, 97])
    expect((keyChunk?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    expect(rgb(labelChunk?.fg)).toEqual([16, 32, 48])

    multiplexer.setHostPalette(hostPalette("#e8e9ea", "#111213", "#33ccdd"))

    expect(rgba(modalBackdrop.backgroundColor)).toEqual([0, 0, 0, 51])
    expect(rgb(modal.backgroundColor)).toEqual([17, 18, 19])
    expect(rgb(modal.borderColor)).toEqual([51, 204, 221])
    expect(rgb(modalText.fg)).toEqual([232, 233, 234])
    expect(rgb(modalText.bg)).toEqual([17, 18, 19])
    expect(rgb(modalText.chunks.find((chunk) => chunk.text.startsWith("ctrl+b"))?.fg)).toEqual([178, 179, 180])
    expect(rgb(emptyState.fg)).toEqual([125, 126, 127])

    await setup.mockMouse.click(modal.x + 1, modal.y + 1)
    await setup.renderOnce()
    expect(modalBackdrop.visible).toBe(true)

    await setup.mockMouse.click(0, 0)
    await setup.renderOnce()
    expect(modalBackdrop.visible).toBe(false)
    expect(modal.visible).toBe(false)
    expect(setup.captureCharFrame()).toContain("prefix+c to create agent")
  } finally {
    await multiplexer.shutdown()
  }
})

function hostPalette(foreground: string, background: string, focus: string): TerminalColors {
  const palette: Array<string | null> = Array(16).fill(null)
  palette[4] = focus
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

function rgba(color: RGBA | undefined): number[] | undefined {
  return color?.toInts()
}
