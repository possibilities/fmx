import { expect, test } from "bun:test"
import { type RGBA, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Toast } from "../src/toast.ts"

test("centers queued toasts above the bottom edge and themes them from fxnk", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const toast = new Toast(setup.renderer, { durationMs: 30 })
  setup.renderer.root.add(toast.root)
  toast.applyTheme("dark")

  const text = toast.root.findDescendantById("fmx-toast-text")
  expect(text).toBeInstanceOf(TextRenderable)
  if (!(text instanceof TextRenderable)) return

  try {
    toast.show("agent 1 started", "neutral")
    toast.show("agent 2 exited · code 7", "error")
    await setup.renderOnce()

    expect(toast.root.visible).toBe(true)
    expect([toast.root.x, toast.root.y, toast.root.width, toast.root.height]).toEqual([30, 20, 19, 3])
    expect(setup.captureCharFrame()).toContain("agent 1 started")
    expect(setup.captureCharFrame()).not.toContain("agent 2 exited")
    // The fixed surface gets the dim hairline and the fx foreground — no hue
    // for "started".
    expect(rgb(toast.root.backgroundColor)).toEqual([48, 48, 48])
    expect(rgb(toast.root.borderColor)).toEqual([138, 138, 138])
    expect(rgb(text.fg)).toEqual([238, 238, 238])

    await Bun.sleep(40)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("agent 1 started")
    expect(setup.captureCharFrame()).toContain("agent 2 exited · code 7")
    // A failure spends direct ANSI red on the border alone.
    expect(toast.root.borderColor.slot).toBe(1)
    expect(rgb(text.fg)).toEqual([238, 238, 238])

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
    toast.show("agent 123456789 started", "neutral")
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

function rgb(color: RGBA | undefined): number[] | undefined {
  return color?.toInts().slice(0, 3)
}
