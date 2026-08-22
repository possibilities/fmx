import { expect, test } from "bun:test"
import { BoxRenderable, type RGBA, type TerminalColors, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import { FxTerminalRenderable } from "../src/fx-terminal.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))

test("propagates an initial fx spawn failure after removing its provisional tab", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "/definitely/missing/fx",
    cwd: process.cwd(),
    initialFxArgs: [],
    keybindings: resolveKeybindings().keybindings,
  })

  try {
    expect(() => multiplexer.start()).toThrow("failed to start fx")
    expect(setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
  } finally {
    await multiplexer.shutdown()
  }
})

test("rolls back a later spawn failure without stopping the active fx", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const options = {
    fxPath: process.execPath,
    cwd: process.cwd(),
    initialFxArgs: [FAKE_FX],
    keybindings: resolveKeybindings().keybindings,
  }
  const multiplexer = new Multiplexer(setup.renderer, options)
  const modalBackdrop = setup.renderer.root.findDescendantById("fmx-modal-backdrop")
  const modal = setup.renderer.root.findDescendantById("fmx-modal")
  const modalText = setup.renderer.root.findDescendantById("fmx-modal-text")
  expect(modalBackdrop).toBeInstanceOf(BoxRenderable)
  expect(modal).toBeInstanceOf(BoxRenderable)
  expect(modalText).toBeInstanceOf(TextRenderable)
  if (!(modalBackdrop instanceof BoxRenderable)) return
  if (!(modal instanceof BoxRenderable) || !(modalText instanceof TextRenderable)) return

  try {
    multiplexer.setHostPalette(hostPalette("#cc3344"))
    multiplexer.start()
    options.fxPath = "/definitely/missing/fx"
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("c")
    await setup.renderOnce()

    expect(setup.renderer.root.findDescendantById("fx-1")).toBeDefined()
    expect(setup.renderer.root.findDescendantById("fx-2")).toBeUndefined()
    expect(modalBackdrop.visible).toBe(true)
    expect(modal.visible).toBe(true)
    expect(modal.title).toBe(" error ")
    expect(setup.captureCharFrame()).toContain("fx did not start")
    expect(setup.captureCharFrame()).toContain("ENOENT")
    expect(setup.captureCharFrame()).not.toContain("dismiss")
    expect(rgb(modal.borderColor)).toEqual([204, 51, 68])
    expect(rgb(modalText.chunks.find((chunk) => chunk.text.includes("fx did not start"))?.fg)).toEqual([
      204, 51, 68,
    ])

    setup.mockInput.pressEscape()
    await setup.renderOnce()
    expect(modalBackdrop.visible).toBe(false)
    expect(modal.visible).toBe(false)
    const activeTerminal = setup.renderer.root.findDescendantById("fx-1")
    expect(activeTerminal).toBeInstanceOf(FxTerminalRenderable)
    if (!(activeTerminal instanceof FxTerminalRenderable)) return
    activeTerminal.onData?.(Uint8Array.of(3, 3), "input")
    await within(multiplexer.waitUntilDone(), 2_000)
  } finally {
    await multiplexer.shutdown()
  }
})

function hostPalette(error: string): TerminalColors {
  const palette: Array<string | null> = Array(16).fill(null)
  palette[1] = error
  return {
    palette,
    defaultForeground: "#d8dee9",
    defaultBackground: "#232938",
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

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("condition timed out")), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
