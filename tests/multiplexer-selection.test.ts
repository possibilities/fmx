import { expect, test } from "bun:test"
import { CliRenderEvents, type Selection } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"

test("clears provisional, empty, and successfully copied selections", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: process.cwd(),
    initialFxArgs: [],
    keybindings: resolveKeybindings().keybindings,
  })
  const originalClearSelection = setup.renderer.clearSelection.bind(setup.renderer)
  const copied: string[] = []
  let clearCount = 0
  let copySucceeds = true

  setup.renderer.clearSelection = () => {
    clearCount += 1
    originalClearSelection()
  }
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text)
    return copySucceeds
  }

  const provisionalSelection = {
    isStart: true,
    getSelectedText: () => "one cell",
  } as Selection
  const emptySelection = {
    isStart: false,
    getSelectedText: () => "",
  } as Selection
  const activatedSelection = {
    isStart: false,
    getSelectedText: () => "selected text",
  } as Selection

  try {
    setup.renderer.emit(CliRenderEvents.SELECTION, provisionalSelection)
    expect(copied).toEqual([])
    expect(clearCount).toBe(1)

    setup.renderer.emit(CliRenderEvents.SELECTION, emptySelection)
    expect(copied).toEqual([])
    expect(clearCount).toBe(2)

    setup.renderer.emit(CliRenderEvents.SELECTION, activatedSelection)
    expect(copied).toEqual(["selected text"])
    expect(clearCount).toBe(3)

    copySucceeds = false
    setup.renderer.emit(CliRenderEvents.SELECTION, activatedSelection)
    expect(copied).toEqual(["selected text", "selected text"])
    expect(clearCount).toBe(3)
  } finally {
    await multiplexer.shutdown()
  }
})
