import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"

async function workspace(): Promise<{ home: string; code: string }> {
  const home = await mkdtemp(join(tmpdir(), "fmx-launch-"))
  const code = join(home, "code")
  for (const name of ["agentlaunch", "fmx", "zulu"]) {
    await mkdir(join(code, name), { recursive: true })
  }
  return { home, code }
}

test("picks a project by cycling the row and by filtering the picker", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: join(code, "fmx"),
    initialFxArgs: [],
    keybindings: resolveKeybindings().keybindings,
    projectRoots: ["~/code"],
    home,
    initialProjectLaunches: { [join(code, "zulu")]: 3 },
  })
  const backdrop = setup.renderer.root.findDescendantById("fmx-launch-backdrop")
  const picker = setup.renderer.root.findDescendantById("fmx-launch-picker")
  expect(backdrop).toBeInstanceOf(BoxRenderable)
  expect(picker).toBeInstanceOf(BoxRenderable)
  if (!(backdrop instanceof BoxRenderable) || !(picker instanceof BoxRenderable)) return

  try {
    expect(backdrop.visible).toBe(false)

    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    await setup.renderOnce()

    // Opens on the directory fmx itself was started in, whatever the order.
    expect(backdrop.visible).toBe(true)
    expect(picker.visible).toBe(false)
    expect(setup.captureCharFrame()).toContain("project  ~/code/fmx")

    // A letter cycles the row to the next project whose name starts with it.
    setup.mockInput.pressKey("a")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("project  ~/code/agentlaunch")

    // Space opens the picker, which lists every project most-started first.
    setup.mockInput.pressKey(" ")
    await setup.renderOnce()
    expect(picker.visible).toBe(true)
    const listed = setup.captureCharFrame()
    // The launch count orders the list; it is never written into it.
    expect(listed.indexOf("~/code/zulu")).toBeLessThan(listed.indexOf("~/code/agentlaunch"))
    expect(listed).not.toContain("· 3")
    expect(listed).toContain("type to filter")

    // Typing filters it; enter applies the highlighted project to the row.
    await setup.mockInput.typeText("zu")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("~/code/agentlaunch")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    expect(picker.visible).toBe(false)
    expect(setup.captureCharFrame()).toContain("project  ~/code/zulu")

    setup.mockInput.pressEscape()
    await setup.renderOnce()
    expect(backdrop.visible).toBe(false)
  } finally {
    await multiplexer.shutdown()
  }
})

test("dismisses the picker back to the row without changing the choice", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: join(code, "fmx"),
    initialFxArgs: [],
    keybindings: resolveKeybindings().keybindings,
    projectRoots: ["~/code"],
    home,
  })
  const backdrop = setup.renderer.root.findDescendantById("fmx-launch-backdrop")
  const picker = setup.renderer.root.findDescendantById("fmx-launch-picker")
  if (!(backdrop instanceof BoxRenderable) || !(picker instanceof BoxRenderable)) return

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    setup.mockInput.pressKey(" ")
    await setup.mockInput.typeText("zu")
    setup.mockInput.pressEscape()
    await setup.renderOnce()

    expect(backdrop.visible).toBe(true)
    expect(picker.visible).toBe(false)
    expect(setup.captureCharFrame()).toContain("project  ~/code/fmx")
  } finally {
    await multiplexer.shutdown()
  }
})

test("offers fmx's own workspace when no root is configured", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: join(code, "fmx"),
    initialFxArgs: [],
    keybindings: resolveKeybindings().keybindings,
    home,
  })

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    setup.mockInput.pressKey(" ")
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("~/code/fmx")
    expect(frame).not.toContain("~/code/zulu")
  } finally {
    await multiplexer.shutdown()
  }
})
