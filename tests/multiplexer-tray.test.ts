import { expect, test } from "bun:test"
import {
  BoxRenderable,
  type CapturedFrame,
  TextRenderable,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import { FxTerminalRenderable } from "../src/fx-terminal.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { EXIT_CONFIRMATION_TIMEOUT_MS, Multiplexer } from "../src/multiplexer.ts"
import { launchAgent, startAgent } from "./fixtures/agent-launch.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))

async function createMultiplexer(width: number, height: number) {
  const setup = await createTestRenderer({ width, height })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  })
  await multiplexer.start()
  await launchAgent(setup, multiplexer)
  const tray = setup.renderer.root.findDescendantById("fmx-tray") as BoxRenderable
  const divider = setup.renderer.root.findDescendantById("fmx-divider") as BoxRenderable
  const content = setup.renderer.root.findDescendantById("fmx-content") as BoxRenderable
  return { setup, multiplexer, tray, divider, content }
}

test("starts without an Fx, hiding the tray and centering the empty state", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const { keybindings } = resolveKeybindings({ prefix: "ctrl+space" })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings,
  })
  const tray = setup.renderer.root.findDescendantById("fmx-tray") as BoxRenderable
  const divider = setup.renderer.root.findDescendantById("fmx-divider") as BoxRenderable
  const content = setup.renderer.root.findDescendantById("fmx-content") as BoxRenderable
  const emptyState = setup.renderer.root.findDescendantById("fmx-empty-state") as TextRenderable

  try {
    multiplexer.start()
    await setup.renderOnce()

    expect(tray.visible).toBe(false)
    expect(divider.visible).toBe(false)
    expect([content.x, content.y, content.width, content.height]).toEqual([0, 0, 80, 24])
    expect(emptyState).toBeInstanceOf(TextRenderable)
    expect([emptyState.x, emptyState.y, emptyState.width, emptyState.height]).toEqual([35, 11, 9, 1])
    expect(emptyState.fg.slot).toBe(245)
    expect(setup.captureCharFrame()).toContain("no agents")

    void startAgent(multiplexer)
    await waitFor(() => setup.renderer.root.findDescendantById("fx-1") !== undefined)
    await setup.renderOnce()

    expect(setup.renderer.root.findDescendantById("fx-1")).toBeDefined()
    expect(tray.visible).toBe(true)
    expect(divider.visible).toBe(true)
    expect(emptyState.visible).toBe(false)
  } finally {
    await multiplexer.shutdown()
  }
})

test("paints the full owner frame when empty before and after the last Agent", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  })
  const expectOwnerBackground = (expected: number[]) => {
    const frame = setup.captureSpans()
    for (const [x, y] of [[0, 0], [25, 0], [27, 0], [79, 0], [0, 23], [79, 23]]) {
      expect(backgroundAt(frame, x, y)).toEqual(expected)
    }
  }

  try {
    await multiplexer.start()
    await setup.renderOnce()
    expectOwnerBackground([0, 0, 0, 255])

    multiplexer.setTheme({ theme: "light", background: "#ffffff", source: "osc11", explicit: false })
    await setup.renderOnce()
    expectOwnerBackground([0, 0, 0, 255])

    void startAgent(multiplexer)
    await waitFor(() => setup.renderer.root.findDescendantById("fx-1") !== undefined)
    await waitForText(setup, "fake fx ready")
    const terminal = setup.renderer.root.findDescendantById("fx-1")
    expect(terminal).toBeInstanceOf(FxTerminalRenderable)
    if (!(terminal instanceof FxTerminalRenderable)) return
    terminal.onData?.(Uint8Array.of(3, 3), "input")
    await waitFor(() => setup.renderer.root.findDescendantById("fx-1") === undefined)
    await setup.renderOnce()
    expectOwnerBackground([0, 0, 0, 255])
  } finally {
    await multiplexer.shutdown()
  }
})

test("requires a second ctrl+c before the empty-state exit timeout", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  })
  let done = false
  void multiplexer.waitUntilDone().then(() => {
    done = true
  })

  try {
    multiplexer.start()
    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.renderOnce()

    expect(done).toBe(false)
    expect(setup.captureCharFrame()).toContain("press ctrl+c again to exit")
    expect(setup.captureCharFrame()).not.toContain("no agents")

    await Bun.sleep(EXIT_CONFIRMATION_TIMEOUT_MS + 50)
    await setup.renderOnce()
    expect(done).toBe(false)
    expect(setup.captureCharFrame()).toContain("no agents")

    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.renderOnce()
    expect(done).toBe(false)
    expect(setup.captureCharFrame()).toContain("press ctrl+c again to exit")

    setup.mockInput.pressKey("c", { ctrl: true })
    await multiplexer.waitUntilDone()
    expect(done).toBe(true)
  } finally {
    await multiplexer.shutdown()
  }
})

test("requires a second ctrl+d to exit from the empty state", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  })
  let done = false
  void multiplexer.waitUntilDone().then(() => {
    done = true
  })

  try {
    multiplexer.start()
    setup.mockInput.pressKey("d", { ctrl: true })
    await setup.renderOnce()

    expect(done).toBe(false)
    expect(setup.captureCharFrame()).toContain("press ctrl+d again to exit")

    setup.mockInput.pressKey("d", { ctrl: true })
    await multiplexer.waitUntilDone()
    expect(done).toBe(true)
  } finally {
    await multiplexer.shutdown()
  }
})

test("lays out tray, divider line, and content row", async () => {
  const { setup, multiplexer, tray, divider, content } = await createMultiplexer(90, 24)
  try {
    expect(tray).toBeInstanceOf(BoxRenderable)
    expect(divider).toBeInstanceOf(BoxRenderable)
    expect(content).toBeInstanceOf(BoxRenderable)

    await setup.renderOnce()
    expect([tray.x, tray.y, tray.width, tray.height]).toEqual([0, 0, 26, 24])
    expect([divider.x, divider.y, divider.width, divider.height]).toEqual([26, 0, 1, 24])
    expect([content.x, content.y, content.width, content.height]).toEqual([27, 0, 63, 24])

    await setup.renderOnce()
    const frame = setup.captureCharFrame().split("\n").filter((row) => row.length > 0)
    expect(frame).toHaveLength(24)
    for (const row of frame) expect(row[26]).toBe("│")
  } finally {
    await multiplexer.shutdown()
  }
})

test("toggles the tray with prefix+b and keeps it hidden across a new agent", async () => {
  const { setup, multiplexer, tray, divider, content } = await createMultiplexer(90, 24)
  try {
    await setup.renderOnce()
    expect(tray.visible).toBe(true)

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(tray.visible).toBe(false)
    expect(divider.visible).toBe(false)
    expect([content.x, content.width]).toEqual([0, 90])

    // A second agent does not bring the tray back on its own.
    await launchAgent(setup, multiplexer, 2)
    await setup.renderOnce()
    expect(setup.renderer.root.findDescendantById("fx-2")).toBeDefined()
    expect(tray.visible).toBe(false)

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(tray.visible).toBe(true)
    expect(divider.visible).toBe(true)
    expect([tray.width, content.x, content.width]).toEqual([26, 27, 63])
  } finally {
    await multiplexer.shutdown()
  }
})

test("restores a persisted hidden tray and reports each toggle", async () => {
  const hiddenChanges: boolean[] = []
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    initialTrayHidden: true,
    onTrayHiddenChange: (hidden) => hiddenChanges.push(hidden),
  })
  await multiplexer.start()
  await launchAgent(setup, multiplexer)
  const tray = setup.renderer.root.findDescendantById("fmx-tray") as BoxRenderable
  try {
    await setup.renderOnce()
    expect(tray.visible).toBe(false)

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(tray.visible).toBe(true)
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(tray.visible).toBe(false)
    expect(hiddenChanges).toEqual([false, true])
  } finally {
    await multiplexer.shutdown()
  }
})

test("resizes the tray by dragging the divider, clamped to 24..width/2", async () => {
  const { setup, multiplexer, tray, divider, content } = await createMultiplexer(90, 24)
  try {
    await setup.renderOnce()

    await setup.mockMouse.drag(26, 10, 34, 10)
    await setup.renderOnce()
    expect(tray.width).toBe(34)
    expect(divider.x).toBe(34)
    expect(content.x).toBe(35)
    expect(content.width).toBe(55)

    // Far past the maximum: clamps to half the screen.
    await setup.mockMouse.drag(34, 10, 80, 10)
    await setup.renderOnce()
    expect(tray.width).toBe(45)

    // Far past the minimum: clamps to 24, wide enough to still read a name.
    await setup.mockMouse.drag(45, 10, 2, 10)
    await setup.renderOnce()
    expect(tray.width).toBe(24)
  } finally {
    await multiplexer.shutdown()
  }
})

test("re-clamps the tray when the terminal shrinks", async () => {
  const { setup, multiplexer, tray } = await createMultiplexer(90, 24)
  try {
    await setup.renderOnce()
    expect(tray.width).toBe(26)

    setup.resize(40, 24)
    await setup.renderOnce()
    expect(tray.width).toBe(20)
  } finally {
    await multiplexer.shutdown()
  }
})

test("themes the divider from fx's fixed dark and light roles", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: "fx",
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  })
  const divider = setup.renderer.root.findDescendantById("fmx-divider") as BoxRenderable
  try {
    expect(divider.borderColor.intent).toBe("indexed")
    expect(divider.borderColor.slot).toBe(240)

    multiplexer.setTheme({ theme: "light", background: "#f5f5f5", source: "osc11", explicit: false })
    expect(divider.borderColor.intent).toBe("indexed")
    expect(divider.borderColor.slot).toBe(250)
  } finally {
    await multiplexer.shutdown()
  }
})

test("switches divider and selected-row colors together on a live theme change", async () => {
  const { setup, multiplexer, divider } = await createMultiplexer(90, 24)
  const selectedSlot = () => {
    const row = setup.renderer.root.findDescendantById("fmx-session-row-agent-1") as BoxRenderable
    return row.backgroundColor.slot
  }

  try {
    expect([divider.borderColor.slot, selectedSlot()]).toEqual([240, 236])
    multiplexer.setTheme({ theme: "light", background: "#ffffff", source: "osc11", explicit: false })
    expect([divider.borderColor.slot, selectedSlot()]).toEqual([250, 254])
  } finally {
    await multiplexer.shutdown()
  }
})

test("restores a persisted width and reports changes on drag end", async () => {
  const widthChanges: number[] = []
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    initialTrayWidth: 26,
    onTrayWidthChange: (width) => widthChanges.push(width),
  })
  await multiplexer.start()
  await launchAgent(setup, multiplexer)
  const tray = setup.renderer.root.findDescendantById("fmx-tray") as BoxRenderable
  try {
    await setup.renderOnce()
    expect(tray.width).toBe(26)

    await setup.mockMouse.drag(26, 10, 28, 10)
    await setup.renderOnce()
    expect(tray.width).toBe(28)
    expect(widthChanges).toEqual([28])

    // A click that never moves reports nothing.
    await setup.mockMouse.click(28, 10)
    expect(widthChanges).toEqual([28])
  } finally {
    await multiplexer.shutdown()
  }
})

test("clamps a stale persisted width to the current screen", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    initialTrayWidth: 70,
  })
  await multiplexer.start()
  await launchAgent(setup, multiplexer)
  const tray = setup.renderer.root.findDescendantById("fmx-tray") as BoxRenderable
  try {
    await setup.renderOnce()
    expect(tray.width).toBe(45)
  } finally {
    await multiplexer.shutdown()
  }
})

function backgroundAt(frame: CapturedFrame, x: number, y: number): number[] {
  const line = frame.lines[y]
  if (!line) throw new Error(`frame has no row ${y}`)
  let column = 0
  for (const span of line.spans) {
    if (x < column + span.width) return span.bg.toInts()
    column += span.width
  }
  throw new Error(`frame row ${y} has no column ${x}`)
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
}

async function waitForText(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  expected: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await setup.renderOnce()
    if (setup.captureCharFrame().includes(expected)) return
    await Bun.sleep(10)
  }
  throw new Error(`did not render ${JSON.stringify(expected)}`)
}
