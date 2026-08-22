import { expect, test } from "bun:test"
import { BoxRenderable, type RGBA, type TerminalColors, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import { resolveKeybindings } from "../src/keybindings.ts"
import { EXIT_CONFIRMATION_TIMEOUT_MS, Multiplexer } from "../src/multiplexer.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))

async function createMultiplexer(width: number, height: number) {
  const setup = await createTestRenderer({ width, height })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: process.execPath,
    cwd: process.cwd(),
    initialFxArgs: [FAKE_FX],
    keybindings: resolveKeybindings().keybindings,
  })
  multiplexer.start()
  const sidebar = setup.renderer.root.findDescendantById("fmx-sidebar") as BoxRenderable
  const divider = setup.renderer.root.findDescendantById("fmx-divider") as BoxRenderable
  const content = setup.renderer.root.findDescendantById("fmx-content") as BoxRenderable
  return { setup, multiplexer, sidebar, divider, content }
}

test("starts without an fx, hiding the sidebar and centering dimmed prefix actions", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const { keybindings } = resolveKeybindings({ prefix: "ctrl+space" })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    initialFxArgs: [],
    keybindings,
  })
  const sidebar = setup.renderer.root.findDescendantById("fmx-sidebar") as BoxRenderable
  const divider = setup.renderer.root.findDescendantById("fmx-divider") as BoxRenderable
  const content = setup.renderer.root.findDescendantById("fmx-content") as BoxRenderable
  const emptyState = setup.renderer.root.findDescendantById("fmx-empty-state") as TextRenderable

  try {
    multiplexer.setHostPalette(
      hostPalette({}, { foreground: "#a0a0a0", background: "#000000" }),
    )
    multiplexer.start()
    await setup.renderOnce()

    expect(sidebar.visible).toBe(false)
    expect(divider.visible).toBe(false)
    expect([content.x, content.y, content.width, content.height]).toEqual([0, 0, 80, 24])
    expect(emptyState).toBeInstanceOf(TextRenderable)
    expect([emptyState.x, emptyState.y, emptyState.width, emptyState.height]).toEqual([28, 11, 24, 2])
    expect(rgb(emptyState.fg)).toEqual([48, 48, 48])
    expect(setup.captureCharFrame()).toContain("prefix+c to create agent")
    expect(setup.captureCharFrame()).toContain("prefix+l to prompt agent")
    expect(setup.captureCharFrame()).not.toContain("ctrl+space+c")

    setup.mockInput.pressKey(" ", { ctrl: true })
    setup.mockInput.pressKey("c")
    await setup.renderOnce()

    expect(setup.renderer.root.findDescendantById("fx-1")).toBeDefined()
    expect(sidebar.visible).toBe(true)
    expect(divider.visible).toBe(true)
    expect(emptyState.visible).toBe(false)
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
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    initialFxArgs: [],
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
    expect(setup.captureCharFrame()).not.toContain("prefix+c to create agent")

    await Bun.sleep(EXIT_CONFIRMATION_TIMEOUT_MS + 50)
    await setup.renderOnce()
    expect(done).toBe(false)
    expect(setup.captureCharFrame()).toContain("prefix+c to create agent")

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

test("lays out sidebar, divider line, and content row", async () => {
  const { setup, multiplexer, sidebar, divider, content } = await createMultiplexer(90, 24)
  try {
    expect(sidebar).toBeInstanceOf(BoxRenderable)
    expect(divider).toBeInstanceOf(BoxRenderable)
    expect(content).toBeInstanceOf(BoxRenderable)

    await setup.renderOnce()
    expect([sidebar.x, sidebar.y, sidebar.width, sidebar.height]).toEqual([0, 0, 26, 24])
    expect([divider.x, divider.y, divider.width, divider.height]).toEqual([26, 0, 1, 24])
    expect([content.x, content.y, content.width, content.height]).toEqual([27, 0, 63, 24])

    // The line is invisible until the host palette reveals it.
    multiplexer.setHostPalette(hostPalette({}))
    await setup.renderOnce()
    const frame = setup.captureCharFrame().split("\n").filter((row) => row.length > 0)
    expect(frame).toHaveLength(24)
    for (const row of frame) expect(row[26]).toBe("│")
  } finally {
    await multiplexer.shutdown()
  }
})

test("toggles the sidebar with prefix+b and keeps it hidden across a new agent", async () => {
  const { setup, multiplexer, sidebar, divider, content } = await createMultiplexer(90, 24)
  try {
    await setup.renderOnce()
    expect(sidebar.visible).toBe(true)

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(sidebar.visible).toBe(false)
    expect(divider.visible).toBe(false)
    expect([content.x, content.width]).toEqual([0, 90])

    // A second instance does not bring the sidebar back on its own.
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("c")
    await setup.renderOnce()
    expect(setup.renderer.root.findDescendantById("fx-2")).toBeDefined()
    expect(sidebar.visible).toBe(false)

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(sidebar.visible).toBe(true)
    expect(divider.visible).toBe(true)
    expect([sidebar.width, content.x, content.width]).toEqual([26, 27, 63])
  } finally {
    await multiplexer.shutdown()
  }
})

test("resizes the sidebar by dragging the divider, clamped to 16..width/3", async () => {
  const { setup, multiplexer, sidebar, divider, content } = await createMultiplexer(90, 24)
  try {
    await setup.renderOnce()

    await setup.mockMouse.drag(26, 10, 20, 10)
    await setup.renderOnce()
    expect(sidebar.width).toBe(20)
    expect(divider.x).toBe(20)
    expect(content.x).toBe(21)
    expect(content.width).toBe(69)

    // Far past the maximum: clamps to a third of the screen.
    await setup.mockMouse.drag(20, 10, 80, 10)
    await setup.renderOnce()
    expect(sidebar.width).toBe(30)

    // Far past the minimum: clamps to 16.
    await setup.mockMouse.drag(30, 10, 2, 10)
    await setup.renderOnce()
    expect(sidebar.width).toBe(16)
  } finally {
    await multiplexer.shutdown()
  }
})

test("re-clamps the sidebar when the terminal shrinks", async () => {
  const { setup, multiplexer, sidebar } = await createMultiplexer(90, 24)
  try {
    await setup.renderOnce()
    expect(sidebar.width).toBe(26)

    setup.resize(60, 24)
    await setup.renderOnce()
    expect(sidebar.width).toBe(20)
  } finally {
    await multiplexer.shutdown()
  }
})

test("themes the divider from the host palette", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: process.cwd(),
    initialFxArgs: [],
    keybindings: resolveKeybindings().keybindings,
  })
  const divider = setup.renderer.root.findDescendantById("fmx-divider") as BoxRenderable
  try {
    // Invisible until the host palette settles: painting a guessed color first
    // would flash and then swap once the real theme arrives.
    expect(divider.borderColor.toInts()[3]).toBe(0)

    // A palette without usable colors still reveals the fallback.
    multiplexer.setHostPalette(hostPalette({}))
    expect(rgb(divider.borderColor)).toEqual([76, 86, 106])

    // Detected foreground + background: a faint blend 20% toward the foreground.
    multiplexer.setHostPalette(
      hostPalette({ 8: "#334455" }, { foreground: "#f1f2f3", background: "#102030" }),
    )
    expect(rgb(divider.borderColor)).toEqual([61, 74, 87])

    // Without both defaults, fall back through the palette grays.
    multiplexer.setHostPalette(hostPalette({ 8: "#334455" }))
    expect(rgb(divider.borderColor)).toEqual([51, 68, 85])

    multiplexer.setHostPalette(hostPalette({ 7: "#667788" }))
    expect(rgb(divider.borderColor)).toEqual([102, 119, 136])
  } finally {
    await multiplexer.shutdown()
  }
})

test("restores a persisted width and reports changes on drag end", async () => {
  const widthChanges: number[] = []
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: process.execPath,
    cwd: process.cwd(),
    initialFxArgs: [FAKE_FX],
    keybindings: resolveKeybindings().keybindings,
    initialSidebarWidth: 22,
    onSidebarWidthChange: (width) => widthChanges.push(width),
  })
  multiplexer.start()
  const sidebar = setup.renderer.root.findDescendantById("fmx-sidebar") as BoxRenderable
  try {
    await setup.renderOnce()
    expect(sidebar.width).toBe(22)

    await setup.mockMouse.drag(22, 10, 28, 10)
    await setup.renderOnce()
    expect(sidebar.width).toBe(28)
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
    fxPath: process.execPath,
    cwd: process.cwd(),
    initialFxArgs: [FAKE_FX],
    keybindings: resolveKeybindings().keybindings,
    initialSidebarWidth: 70,
  })
  multiplexer.start()
  const sidebar = setup.renderer.root.findDescendantById("fmx-sidebar") as BoxRenderable
  try {
    await setup.renderOnce()
    expect(sidebar.width).toBe(30)
  } finally {
    await multiplexer.shutdown()
  }
})

function hostPalette(
  entries: Record<number, string>,
  defaults: { foreground?: string; background?: string } = {},
): TerminalColors {
  const palette: Array<string | null> = Array(16).fill(null)
  for (const [index, color] of Object.entries(entries)) palette[Number(index)] = color
  return {
    palette,
    defaultForeground: defaults.foreground ?? null,
    defaultBackground: defaults.background ?? null,
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
