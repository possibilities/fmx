import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FxTerminalRenderable } from "../src/fx-terminal.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { launchAgent, startAgent } from "./fixtures/agent-launch.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))

test("reports an Fx spawn failure to the caller after removing its provisional Agent", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: "/definitely/missing/fx",
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  })

  try {
    await multiplexer.start()
    await expect(startAgent(multiplexer)).rejects.toThrow("ENOENT")
    expect(setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("no agents")
  } finally {
    await multiplexer.shutdown()
  }
})

test("rolls back a later spawn failure without stopping the active Fx", async () => {
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
  try {
    await multiplexer.start()
    await launchAgent(setup, multiplexer)
    options.fxPath = "/definitely/missing/fx"
    await expect(startAgent(multiplexer)).rejects.toThrow("ENOENT")

    expect(setup.renderer.root.findDescendantById("fx-1")).toBeDefined()
    expect(setup.renderer.root.findDescendantById("fx-2")).toBeUndefined()
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
    expect(setup.captureCharFrame()).toContain("no agents")

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

test("refuses a CLI launch outside a repository", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false })
  const cwd = await mkdtemp(join(tmpdir(), "fmx-no-repository-"))
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd,
    keybindings: resolveKeybindings().keybindings,
  })

  try {
    await multiplexer.start()
    await expect(startAgent(multiplexer, cwd)).rejects.toThrow("not a git repository")
    await setup.renderOnce()

    expect(setup.captureCharFrame()).toContain("no agents")
    expect(setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
  } finally {
    await multiplexer.shutdown()
    await rm(cwd, { recursive: true, force: true })
  }
})

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
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
