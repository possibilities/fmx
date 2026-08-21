import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"

test("uses the configured prefix and renders configured bindings", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const { keybindings } = resolveKeybindings({ prefix: "ctrl+space" })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: process.cwd(),
    initialFxArgs: [],
    maxScrollback: 10_000_000,
    keybindings,
  })
  const helpModal = setup.renderer.root.findDescendantById("fmx-help")
  expect(helpModal).toBeInstanceOf(BoxRenderable)
  if (!(helpModal instanceof BoxRenderable)) return

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("?")
    expect(helpModal.visible).toBe(false)

    setup.mockInput.pressKey(" ", { ctrl: true })
    setup.renderer.keyInput.processParsedKey({
      name: "leftshift",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "",
      raw: "\u001b[57441u",
      number: false,
      eventType: "press",
      source: "kitty",
    })
    setup.mockInput.pressKey("?")
    await setup.renderOnce()

    expect(helpModal.visible).toBe(true)
    const frame = setup.captureCharFrame()
    for (const line of [
      "┌───────────────────────────┐",
      "│  ctrl+space  prefix mode  │",
      "│  prefix+?    keybinds     │",
      "│  prefix+c    new agent    │",
      "│  prefix+p    prev agent   │",
      "│  prefix+n    next agent   │",
      "└───────────────────────────┘",
    ]) {
      expect(frame).toContain(line)
    }
    expect(frame).not.toContain("1…9")
    expect(frame).not.toContain("close tab")
    expect(frame).not.toContain("send prefix")

    setup.renderer.keyInput.processParsedKey({
      name: "/",
      ctrl: false,
      meta: false,
      shift: true,
      option: false,
      sequence: "/",
      raw: "\u001b[47;2u",
      number: false,
      eventType: "press",
      source: "kitty",
    })
    expect(helpModal.visible).toBe(false)
  } finally {
    await multiplexer.shutdown()
  }
})
