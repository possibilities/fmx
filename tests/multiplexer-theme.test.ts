import { expect, test } from "bun:test"
import { BoxRenderable, type RGBA, TextAttributes, TextRenderable } from "@opentui/core"
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
    initialTheme: { theme: "light", background: "#f1f2f3", source: "osc11", explicit: false },
  })

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
    expect(setup.captureCharFrame()).toContain("no agents")
    expect(emptyState.fg.slot).toBe(247)

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("?")
    await setup.renderOnce()

    const helpFrame = setup.captureCharFrame()
    expect(modalBackdrop.visible).toBe(true)
    expect(modal.visible).toBe(true)
    expect([modalBackdrop.x, modalBackdrop.y, modalBackdrop.width, modalBackdrop.height]).toEqual([0, 0, 80, 24])
    expect(modal.borderStyle).toBe("single")
    expect(modal.title).toBe(" keys ")
    expect(modal.titleColor?.slot).toBe(235)
    expect(helpFrame).toContain("keybinds")
    expect(helpFrame).toContain("prefix+p")
    expect([modalText.x - modal.x, modalText.y - modal.y]).toEqual([2, 1])
    expect([
      modal.width - (modalText.x - modal.x) - modalText.width,
      modal.height - (modalText.y - modal.y) - modalText.height,
    ]).toEqual([2, 1])
    expect(rgba(modalBackdrop.backgroundColor)).toEqual([0, 0, 0, 51])
    expect(modal.backgroundColor.intent).toBe("default")
    expect(modal.borderColor.intent).toBe("indexed")
    expect(modal.borderColor.slot).toBe(4)
    expect(modalText.fg.slot).toBe(235)
    expect(modalText.bg.intent).toBe("default")
    const keyChunk = modalText.chunks.find((chunk) => chunk.text.startsWith("ctrl+b"))
    const labelChunk = modalText.chunks.find((chunk) => chunk.text === "prev agent")
    // Keys are labels: bold, at fx's fixed secondary step.
    expect(keyChunk?.fg?.slot).toBe(241)
    expect((keyChunk?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    expect(labelChunk?.fg?.slot).toBe(235)

    multiplexer.setTheme({ theme: "dark", background: "#111213", source: "osc11", explicit: false })

    expect(rgba(modalBackdrop.backgroundColor)).toEqual([0, 0, 0, 51])
    expect(modal.backgroundColor.intent).toBe("default")
    expect(modal.borderColor.slot).toBe(4)
    expect(modalText.fg.slot).toBe(255)
    expect(modalText.bg.intent).toBe("default")
    expect(modalText.chunks.find((chunk) => chunk.text.startsWith("ctrl+b"))?.fg?.slot).toBe(250)
    expect(emptyState.fg.slot).toBe(245)

    await setup.mockMouse.click(modal.x + 1, modal.y + 1)
    await setup.renderOnce()
    expect(modalBackdrop.visible).toBe(true)

    await setup.mockMouse.click(0, 0)
    await setup.renderOnce()
    expect(modalBackdrop.visible).toBe(false)
    expect(modal.visible).toBe(false)
    expect(setup.captureCharFrame()).toContain("no agents")
  } finally {
    await multiplexer.shutdown()
  }
})

function rgba(color: RGBA | undefined): number[] | undefined {
  return color?.toInts()
}
