import { expect, test } from "bun:test"
import { type RGBA, type TerminalColors, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Toast } from "../src/toast.ts"

test("centers queued toasts above the bottom edge and themes them from the terminal palette", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const toast = new Toast(setup.renderer, { durationMs: 30 })
  setup.renderer.root.add(toast.root)
  toast.applyPalette(hostPalette())

  const text = toast.root.findDescendantById("fmx-toast-text")
  expect(text).toBeInstanceOf(TextRenderable)
  if (!(text instanceof TextRenderable)) return

  try {
    toast.show("agent 1 started", "success")
    toast.show("agent 2 exited · code 7", "error")
    await setup.renderOnce()

    expect(toast.root.visible).toBe(true)
    expect([toast.root.x, toast.root.y, toast.root.width, toast.root.height]).toEqual([30, 20, 19, 3])
    expect(setup.captureCharFrame()).toContain("agent 1 started")
    expect(setup.captureCharFrame()).not.toContain("agent 2 exited")
    expect(rgb(toast.root.backgroundColor)).toEqual([43, 57, 71])
    expect(rgb(toast.root.borderColor)).toEqual([34, 187, 68])
    expect(rgb(text.fg)).toEqual([34, 187, 68])

    await Bun.sleep(40)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("agent 1 started")
    expect(setup.captureCharFrame()).toContain("agent 2 exited · code 7")
    expect(rgb(toast.root.borderColor)).toEqual([204, 51, 68])
    expect(rgb(text.fg)).toEqual([204, 51, 68])

    await Bun.sleep(40)
    await setup.renderOnce()
    expect(toast.root.visible).toBe(false)
    expect(setup.captureCharFrame()).not.toContain("agent 2 exited")
  } finally {
    toast.destroy()
    setup.renderer.destroy()
  }
})

test("truncates within a narrow viewport and hides when the Toast cannot fit", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const toast = new Toast(setup.renderer, { durationMs: 500 })
  setup.renderer.root.add(toast.root)

  try {
    toast.show("agent 123456789 started", "success")
    setup.resize(12, 5)
    toast.layout()
    await setup.renderOnce()

    expect([toast.root.x, toast.root.y, toast.root.width, toast.root.height]).toEqual([1, 1, 10, 3])
    expect(setup.captureCharFrame()).toContain("agent…")

    setup.resize(7, 5)
    toast.layout()
    await setup.renderOnce()
    expect(toast.root.visible).toBe(false)

    setup.resize(80, 2)
    toast.layout()
    await setup.renderOnce()
    expect(toast.root.visible).toBe(false)
  } finally {
    toast.destroy()
    setup.renderer.destroy()
  }
})

function hostPalette(): TerminalColors {
  const palette: Array<string | null> = Array(16).fill(null)
  palette[1] = "#cc3344"
  palette[2] = "#22bb44"
  palette[8] = "#667788"
  return {
    palette,
    defaultForeground: "#f0f1f2",
    defaultBackground: "#102030",
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
