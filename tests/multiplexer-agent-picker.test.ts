import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { startVisibleAgent } from "./fixtures/agent-start.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))

test("replaces the Tray with the shared top Agent picker and routes its focus", async () => {
  const setup = await createTestRenderer({
    width: 90,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    agentPicker: true,
  })
  await multiplexer.start()
  const picker = setup.renderer.root.findDescendantById("fmx-agent-picker") as BoxRenderable
  const selector = setup.renderer.root.findDescendantById("fmx-agent-picker-selector") as BoxRenderable
  const tray = setup.renderer.root.findDescendantById("fmx-tray") as BoxRenderable
  const divider = setup.renderer.root.findDescendantById("fmx-divider") as BoxRenderable
  const content = setup.renderer.root.findDescendantById("fmx-content") as BoxRenderable

  try {
    await setup.renderOnce()
    expect(picker.visible).toBe(false)
    expect([content.x, content.y, content.width, content.height]).toEqual([0, 0, 90, 24])

    await startVisibleAgent(setup, multiplexer)
    await startVisibleAgent(setup, multiplexer, 2)
    await setup.renderOnce()
    expect(picker.visible).toBe(true)
    expect(tray.visible).toBe(false)
    expect(divider.visible).toBe(false)
    expect([picker.x, picker.y, picker.width, picker.height]).toEqual([0, 0, 90, 3])
    expect([content.x, content.y, content.width, content.height]).toEqual([0, 3, 90, 21])
    expect(setup.captureCharFrame()).toContain("agent · 2 · — · fmx · ")

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(selector.visible).toBe(true)
    expect(selector.focused).toBe(true)
    expect(await multiplexer.control.handle("orient", {}, new AbortController().signal)).toMatchObject({
      active: 2,
      tray: { visible: false },
      surface: { kind: "agent_picker" },
    })
    await expect(
      multiplexer.control.handle("focus", { target: "1" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "busy" })

    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await setup.flush()
    expect(await multiplexer.control.handle("orient", {}, new AbortController().signal)).toMatchObject({
      active: 1,
      surface: { kind: "none" },
    })
    expect(selector.visible).toBe(false)

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(selector.visible).toBe(true)
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(selector.visible).toBe(false)

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("?")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("toggle agent picker")
  } finally {
    await multiplexer.shutdown()
  }
})
