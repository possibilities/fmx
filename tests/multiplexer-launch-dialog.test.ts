import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"

type Setup = Awaited<ReturnType<typeof createTestRenderer>>

async function workspace(): Promise<{ home: string; code: string }> {
  const home = await mkdtemp(join(tmpdir(), "fmx-launch-"))
  const code = join(home, "code")
  for (const name of ["agentlaunch", "fmx", "zulu"]) {
    await mkdir(join(code, name), { recursive: true })
  }
  return { home, code }
}

function launcher(setup: Setup, home: string, code: string, roots = ["~/code"]): Multiplexer {
  return new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: join(code, "fmx"),
    initialFxArgs: [],
    keybindings: resolveKeybindings().keybindings,
    projectRoots: roots,
    home,
  })
}

async function initRepository(directory: string): Promise<void> {
  const git = (...args: string[]) =>
    Bun.spawn(["git", "-C", directory, ...args], { stdout: "ignore", stderr: "ignore" }).exited
  await git("init", "--quiet")
  await git("config", "user.email", "fmx@example.invalid")
  await git("config", "user.name", "fmx test")
  await Bun.write(join(directory, "README.md"), "test\n")
  await git("add", "README.md")
  await git("commit", "--quiet", "-m", "initial")
}

/** Repository checks are subprocesses, so a row that depends on one settles a
 * few frames after the keystroke that asked for it. */
async function waitForFrame(setup: Setup, text: string): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (frame.includes(text)) return frame
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return setup.captureCharFrame()
}

test("opens on the prompt, over the project fmx was started in", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code)

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("prompt    what should the agent do?")
    expect(frame).toContain("project   ~/code/fmx")
    expect(frame).toContain("worktree  no")

    // The prompt has focus, so printables are text rather than commands —
    // space included, which is the picker's key one row down.
    await setup.mockInput.typeText("fix the flaky test")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("prompt    fix the flaky test")
    expect(setup.renderer.root.findDescendantById("fmx-launch-picker")?.visible).toBe(false)
  } finally {
    await multiplexer.shutdown()
  }
})

test("edits the prompt as a real field: readline keys, kills, and yanks", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code)

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    await setup.mockInput.typeText("fix the flaky test")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("prompt    fix the flaky test")

    // ctrl+a to the line start, then ctrl+k kills the line into the ring.
    setup.mockInput.pressKey("a", { ctrl: true })
    setup.mockInput.pressKey("k", { ctrl: true })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("fix the flaky test")

    // ctrl+y yanks it back — the ring is fmx's, the kill was the widget's.
    setup.mockInput.pressKey("y", { ctrl: true })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("prompt    fix the flaky test")
  } finally {
    await multiplexer.shutdown()
  }
})

test("grows with a multiline prompt and keeps enter for the form", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code)
  const dialog = setup.renderer.root.findDescendantById("fmx-launch-dialog")
  if (!(dialog instanceof BoxRenderable)) return

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    await setup.renderOnce()
    const oneLine = dialog.height

    await setup.mockInput.typeText("first")
    setup.mockInput.pressEnter({ shift: true })
    await setup.mockInput.typeText("second")
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("first")
    expect(frame).toContain("second")
    expect(dialog.height).toBe(oneLine + 1)

    // Plain enter is still the form's: it advances rather than inserting.
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    expect(dialog.height).toBe(oneLine + 1)
    expect(setup.captureCharFrame()).toContain("space pick")
  } finally {
    await multiplexer.shutdown()
  }
})

test("hands typing back to the rows once the prompt loses focus", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code)

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    await setup.mockInput.typeText("a prompt")
    setup.mockInput.pressTab()
    // On the project row the same letter cycles instead of typing.
    setup.mockInput.pressKey("z")
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("prompt    a prompt")
    expect(frame).toContain("project   ~/code/zulu")
  } finally {
    await multiplexer.shutdown()
  }
})

test("cycles the project by letter and filters it in the picker", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code)
  const picker = setup.renderer.root.findDescendantById("fmx-launch-picker")
  if (!(picker instanceof BoxRenderable)) return

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    setup.mockInput.pressTab()
    await setup.renderOnce()

    setup.mockInput.pressKey("a")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("project   ~/code/agentlaunch")

    setup.mockInput.pressKey(" ")
    await setup.renderOnce()
    expect(picker.visible).toBe(true)

    await setup.mockInput.typeText("zu")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("~/code/agentlaunch")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    expect(picker.visible).toBe(false)
    expect(setup.captureCharFrame()).toContain("project   ~/code/zulu")
  } finally {
    await multiplexer.shutdown()
  }
})

test("dismisses the picker back to the row without changing the choice", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code)
  const backdrop = setup.renderer.root.findDescendantById("fmx-launch-backdrop")
  const picker = setup.renderer.root.findDescendantById("fmx-launch-picker")
  if (!(backdrop instanceof BoxRenderable) || !(picker instanceof BoxRenderable)) return

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    setup.mockInput.pressTab()
    setup.mockInput.pressKey(" ")
    await setup.mockInput.typeText("zu")
    setup.mockInput.pressEscape()
    await setup.renderOnce()

    expect(backdrop.visible).toBe(true)
    expect(picker.visible).toBe(false)
    expect(setup.captureCharFrame()).toContain("project   ~/code/fmx")
  } finally {
    await multiplexer.shutdown()
  }
})

test("leaves the dialog on ctrl+c from either layer", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code)
  const backdrop = setup.renderer.root.findDescendantById("fmx-launch-backdrop")
  const picker = setup.renderer.root.findDescendantById("fmx-launch-picker")
  if (!(backdrop instanceof BoxRenderable) || !(picker instanceof BoxRenderable)) return

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.renderOnce()
    expect(backdrop.visible).toBe(false)

    // From the picker it leaves outright, where escape would step back a layer.
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    setup.mockInput.pressTab()
    setup.mockInput.pressKey(" ")
    await setup.renderOnce()
    expect(picker.visible).toBe(true)
    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.renderOnce()
    expect(backdrop.visible).toBe(false)
    expect(picker.visible).toBe(false)
  } finally {
    await multiplexer.shutdown()
  }
})

test("offers the worktree toggle where there is a commit to branch from", async () => {
  const { home, code } = await workspace()
  await initRepository(join(code, "fmx"))
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code)

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    setup.mockInput.pressTab()
    setup.mockInput.pressTab()
    setup.mockInput.pressKey(" ")
    // The toggle holds only if the repository check came back able; an
    // unavailable answer forces it back off when it lands.
    expect(await waitForFrame(setup, "worktree  yes")).toContain("worktree  yes")
    await new Promise((resolve) => setTimeout(resolve, 200))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("worktree  yes")
  } finally {
    await multiplexer.shutdown()
  }
})

test("says so on a project no worktree can be cut from", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code)

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    setup.mockInput.pressTab()
    setup.mockInput.pressKey("z")
    const frame = await waitForFrame(setup, "worktree  unavailable")
    expect(frame).toContain("project   ~/code/zulu")
    expect(frame).toContain("worktree  unavailable — not a repository")

    // And refuses to turn on, rather than failing after the launch is sent.
    setup.mockInput.pressTab()
    setup.mockInput.pressKey(" ")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("worktree  unavailable")
  } finally {
    await multiplexer.shutdown()
  }
})

test("offers fmx's own workspace when no root is configured", async () => {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const multiplexer = launcher(setup, home, code, [])

  try {
    setup.mockInput.pressKey("b", { ctrl: true })
    setup.mockInput.pressKey("l")
    setup.mockInput.pressTab()
    setup.mockInput.pressKey(" ")
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("~/code/fmx")
    expect(frame).not.toContain("~/code/zulu")
  } finally {
    await multiplexer.shutdown()
  }
})
