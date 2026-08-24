import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

test("uses the configured prefix and renders configured bindings", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const { keybindings } = resolveKeybindings({ prefix: "ctrl+space" })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: "fx",
    cwd: process.cwd(),
    keybindings,
  })
  const helpModal = setup.renderer.root.findDescendantById("fmx-modal")
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
"┌─ keys ──────────────────────┐",
      "│  ctrl+space  prefix mode    │",
      "│  prefix+?    keybinds       │",
      "│  prefix+d    detach client  │",
      "│  prefix+l    launch agent   │",
      "│  prefix+p    prev agent     │",
      "│  prefix+n    next agent     │",
      "│  prefix+b    toggle tray    │",
      "│  prefix+r    toggle tools   │",
      "│  prefix+o    focus tools    │",
      "│  prefix+[    previous tool  │",
      "│  prefix+]    next tool      │",
      "└─────────────────────────────┘",
    ]) {
      expect(frame).toContain(line)
    }

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

    setup.mockInput.pressKey(" ", { ctrl: true })
    setup.mockInput.pressKey("?")
    await setup.renderOnce()
    expect(helpModal.visible).toBe(true)
    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.renderOnce()
    expect(helpModal.visible).toBe(false)

    setup.mockInput.pressKey(" ", { ctrl: true })
    setup.mockInput.pressKey("d")
    expect(await multiplexer.control.handle("orient", {}, new AbortController().signal)).toMatchObject({
      active: null,
    })
  } finally {
    await multiplexer.shutdown()
  }
})
