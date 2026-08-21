import { expect, test } from "bun:test"
import { BoxRenderable, type RGBA, type TerminalColors } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"

async function createMultiplexer(width: number, height: number) {
  const setup = await createTestRenderer({ width, height })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: process.cwd(),
    initialFxArgs: [],
    keybindings: resolveKeybindings().keybindings,
  })
  const sidebar = setup.renderer.root.findDescendantById("fmx-sidebar") as BoxRenderable
  const divider = setup.renderer.root.findDescendantById("fmx-divider") as BoxRenderable
  const content = setup.renderer.root.findDescendantById("fmx-content") as BoxRenderable
  return { setup, multiplexer, sidebar, divider, content }
}

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

    const frame = setup.captureCharFrame().split("\n").filter((row) => row.length > 0)
    expect(frame).toHaveLength(24)
    for (const row of frame) expect(row[26]).toBe("│")
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
  const { multiplexer, divider } = await createMultiplexer(90, 24)
  try {
    expect(rgb(divider.borderColor)).toEqual([76, 86, 106])

    multiplexer.setHostPalette(hostPalette({ 8: "#334455" }))
    expect(rgb(divider.borderColor)).toEqual([51, 68, 85])

    multiplexer.setHostPalette(hostPalette({ 7: "#667788" }))
    expect(rgb(divider.borderColor)).toEqual([102, 119, 136])
  } finally {
    await multiplexer.shutdown()
  }
})

function hostPalette(entries: Record<number, string>): TerminalColors {
  const palette: Array<string | null> = Array(16).fill(null)
  for (const [index, color] of Object.entries(entries)) palette[Number(index)] = color
  return {
    palette,
    defaultForeground: null,
    defaultBackground: null,
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
