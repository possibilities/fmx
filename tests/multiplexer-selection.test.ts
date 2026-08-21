import { expect, test } from "bun:test"
import { CliRenderEvents, type Selection } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Multiplexer } from "../src/multiplexer.ts"

test("clears a selection only after a successful clipboard copy", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: process.cwd(),
    initialFxArgs: [],
    maxScrollback: 1_000,
  })
  const originalClearSelection = setup.renderer.clearSelection.bind(setup.renderer)
  let clearCount = 0
  let copySucceeds = true

  setup.renderer.clearSelection = () => {
    clearCount += 1
    originalClearSelection()
  }
  setup.renderer.copyToClipboardOSC52 = () => copySucceeds

  const selection = {
    isStart: false,
    getSelectedText: () => "selected text",
  } as Selection

  try {
    setup.renderer.emit(CliRenderEvents.SELECTION, selection)
    expect(clearCount).toBe(1)

    copySucceeds = false
    setup.renderer.emit(CliRenderEvents.SELECTION, selection)
    expect(clearCount).toBe(1)
  } finally {
    await multiplexer.shutdown()
  }
})
