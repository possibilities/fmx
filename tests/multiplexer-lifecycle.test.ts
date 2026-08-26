import { expect, test } from "bun:test"
import {
  BoxRenderable,
  type RGBA,
  type TerminalColors,
  TextRenderable,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { FxTerminalRenderable } from "../src/fx-terminal.ts"
import { projectNameFor, readGitContext, treeNameFor } from "../src/git-context.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { TestAdeSocket } from "./fixtures/ade-feed.ts"
import { launchAgent, pressLaunch } from "./fixtures/launch-keys.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))
const FAILING_FX = fileURLToPath(new URL("./fixtures/failing-fx.sh", import.meta.url))
const SESSION_ID = "1732673860000-123456789-deadbeef"

test("reports an fx spawn failure after removing its provisional agent", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: "/definitely/missing/fx",
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  })

  try {
    await multiplexer.start()
    // On screen from the claim, gone again with the reason once the start fails.
    pressLaunch(setup)
    await waitForText(setup, "fx did not start", 4_000)
    expect(setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
  } finally {
    await multiplexer.shutdown()
  }
})

test("rolls back a later spawn failure without stopping the active fx", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const options = {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  }
  const multiplexer = new Multiplexer(setup.renderer, options)
  const modalBackdrop = setup.renderer.root.findDescendantById("fmx-modal-backdrop")
  const modal = setup.renderer.root.findDescendantById("fmx-modal")
  const modalText = setup.renderer.root.findDescendantById("fmx-modal-text")
  expect(modalBackdrop).toBeInstanceOf(BoxRenderable)
  expect(modal).toBeInstanceOf(BoxRenderable)
  expect(modalText).toBeInstanceOf(TextRenderable)
  if (!(modalBackdrop instanceof BoxRenderable)) return
  if (!(modal instanceof BoxRenderable) || !(modalText instanceof TextRenderable)) return

  try {
    multiplexer.setHostPalette(hostPalette("#cc3344"))
    await multiplexer.start()
    await launchAgent(setup)
    options.fxPath = "/definitely/missing/fx"
    pressLaunch(setup)
    await waitFor(() => modalBackdrop.visible, 4_000)
    await setup.renderOnce()

    expect(setup.renderer.root.findDescendantById("fx-1")).toBeDefined()
    expect(setup.renderer.root.findDescendantById("fx-2")).toBeUndefined()
    expect(modalBackdrop.visible).toBe(true)
    expect(modal.visible).toBe(true)
    expect(modal.title).toBe(" error ")
    expect(setup.captureCharFrame()).toContain("fx did not start")
    expect(setup.captureCharFrame()).toContain("ENOENT")
    expect(setup.captureCharFrame()).not.toContain("dismiss")
    // The border carries the failure hue; the heading is fx's red role,
    // which is the accent gray, one step below the foreground.
    expect(rgb(modal.borderColor)).toEqual([204, 51, 68])
    expect(rgb(modalText.chunks.find((chunk) => chunk.text.includes("fx did not start"))?.fg)).toEqual([
      189, 195, 206,
    ])

    setup.mockInput.pressEscape()
    await setup.renderOnce()
    expect(modalBackdrop.visible).toBe(false)
    expect(modal.visible).toBe(false)
    const activeTerminal = setup.renderer.root.findDescendantById("fx-1")
    expect(activeTerminal).toBeInstanceOf(FxTerminalRenderable)
    if (!(activeTerminal instanceof FxTerminalRenderable)) return
    let done = false
    void multiplexer.waitUntilDone().then(() => {
      done = true
    })

    activeTerminal.onData?.(Uint8Array.of(3, 3), "input")
    await waitFor(() => setup.renderer.root.findDescendantById("fx-1") === undefined, 2_000)
    await setup.renderOnce()
    expect(done).toBe(false)
    expect(setup.captureCharFrame()).toContain("prefix+l to launch agent")

    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.renderOnce()
    expect(done).toBe(false)
    expect(setup.captureCharFrame()).toContain("press ctrl+c again to exit")

    setup.mockInput.pressKey("c", { ctrl: true })
    await within(multiplexer.waitUntilDone(), 2_000)
    expect(done).toBe(true)
  } finally {
    await multiplexer.shutdown()
  }
})

test("toasts project and Worktree on start, then uses the native session name on exit", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const home = await mkdtemp(join(tmpdir(), "fmx-lifecycle-home-"))
  const adeSocket = new TestAdeSocket(`/tmp/fmx-lifecycle-${process.pid}.ade.sock`)
  const sessionDirectory = join(home, ".fx", "sessions", SESSION_ID)
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(
    join(sessionDirectory, "display.json"),
    `${JSON.stringify({ schema_version: 1, title: "Clear cloud", preview: null, origin_workspace_root: null })}\n`,
  )
  const options = agentOptions()
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    adeSocket,
    home,
    toastDurationMs: 100,
  })
  const location = await lifecycleLocation(process.cwd())

  try {
    await multiplexer.start()
    await launchAgent(setup)
    await waitForText(setup, `${location} / agent 1 started`, 2_000)

    // The retained pane id carries the same stable token as the ADE instance.
    const paneId = options.manifest.entries[0]!.paneId
    adeSocket.main(paneId, "FxStarted", { sessionId: SESSION_ID, state: "idle" })

    await Bun.sleep(110)
    const terminal = setup.renderer.root.findDescendantById("fx-1")
    expect(terminal).toBeInstanceOf(FxTerminalRenderable)
    if (!(terminal instanceof FxTerminalRenderable)) return
    terminal.onData?.(Uint8Array.of(3, 3), "input")
    await waitFor(() => setup.renderer.root.findDescendantById("fx-1") === undefined, 2_000)
    await waitForText(setup, `${location} / Clear cloud exited`, 2_000)
  } finally {
    await multiplexer.shutdown()
    await rm(home, { recursive: true, force: true })
  }
})

test("falls back to the Agent id and includes a nonzero exit code", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAILING_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    toastDurationMs: 100,
  })
  const location = await lifecycleLocation(process.cwd())

  try {
    await multiplexer.start()
    pressLaunch(setup)
    await waitForText(setup, `${location} / agent 1 started`, 2_000)

    await Bun.sleep(110)
    await waitForText(setup, `${location} / agent 1 exited / code 7`, 2_000)
  } finally {
    await multiplexer.shutdown()
  }
})

test("offers nothing to launch outside a repository", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false })
  const cwd = await mkdtemp(join(tmpdir(), "fmx-no-repository-"))
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd,
    keybindings: resolveKeybindings().keybindings,
    toastDurationMs: 100,
  })

  try {
    await multiplexer.start()
    pressLaunch(setup)
    await setup.renderOnce()

    // The directory fmx was started in is not a repository, so the project
    // row has nothing on it and the enter that would launch does nothing.
    expect(setup.captureCharFrame()).toContain("no repositories found")
    expect(setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
    expect(basename(cwd)).not.toBe("")
  } finally {
    await multiplexer.shutdown()
    await rm(cwd, { recursive: true, force: true })
  }
})

function hostPalette(error: string): TerminalColors {
  const palette: Array<string | null> = Array(16).fill(null)
  palette[1] = error
  return {
    palette,
    defaultForeground: "#d8dee9",
    defaultBackground: "#232938",
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

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
}

async function waitForText(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await setup.renderOnce()
    if (setup.captureCharFrame().includes(expected)) return
    await Bun.sleep(5)
  }
  throw new Error(`did not render ${JSON.stringify(expected)}`)
}

async function lifecycleLocation(cwd: string): Promise<string> {
  const context = await readGitContext(cwd)
  const project = projectNameFor(context, cwd)
  const tree = treeNameFor(context)
  return tree === null ? project : `${project} / ${tree}`
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("condition timed out")), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
