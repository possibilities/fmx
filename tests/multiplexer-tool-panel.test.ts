import { expect, test } from "bun:test"
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { PanelDefinition } from "../src/config.ts"
import { type PanelInfo, ControlFailure, type Snapshot } from "../src/control-protocol.ts"
import { FmxTerminalRenderable, FxTerminalRenderable } from "../src/fx-terminal.ts"
import { HandlerRelay, type TerminalSize, type TerminalTransport, type TransportHandlers } from "../src/agent-transport.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import type { PanelContext, PanelSessionController } from "../src/panel-session.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))
const NEVER = new AbortController().signal

const PANELS: PanelDefinition[] = [
  { id: "diff", label: "Diff", command: ["hunk", "diff", "--watch"], persistent: true },
  { id: "tests", label: "Tests", command: ["bun", "test", "--watch"], persistent: false },
]

class FakePanelSessions implements PanelSessionController {
  readonly opens: { definition: PanelDefinition; context: PanelContext; size: TerminalSize; transport: FakeToolTransport }[] = []
  readonly stopped: string[] = []
  closed = false

  async open(definition: PanelDefinition, context: PanelContext, size: TerminalSize): Promise<TerminalTransport> {
    const transport = new FakeToolTransport(`${definition.id}:${context.cwd}\r\n`)
    this.opens.push({ definition, context: { ...context }, size: { ...size }, transport })
    return transport
  }

  async stopAgent(agentId: string): Promise<void> {
    this.stopped.push(agentId)
  }

  close(): void {
    this.closed = true
  }
}

class FakeToolTransport implements TerminalTransport {
  private readonly relay = new HandlerRelay()
  readonly writes: Uint8Array[] = []
  sizes: TerminalSize[] = []
  detached = false

  constructor(output: string) {
    const bytes = new TextEncoder().encode(output)
    this.relay.emit((handlers) => handlers.output(bytes))
    this.relay.emit((handlers) => handlers.ready())
  }

  bind(handlers: TransportHandlers): void {
    this.relay.bind(handlers)
  }

  write(bytes: Uint8Array): void {
    this.writes.push(bytes.slice())
  }

  resize(size: TerminalSize): void {
    this.sizes.push({ ...size })
  }

  detach(): void {
    this.detached = true
    this.relay.stop()
  }

  exit(code = 1): void {
    this.relay.emit((handlers) => handlers.exit({ code, signal: 0 }))
  }
}

async function harness(options: {
  width?: number
  panels?: PanelDefinition[]
  initialPanelVisible?: boolean
  initialPanelWidth?: number
  initialPanelId?: string
} = {}) {
  const setup = await createTestRenderer({ width: options.width ?? 90, height: 24, kittyKeyboard: true })
  const sessions = new FakePanelSessions()
  const visibility: boolean[] = []
  const widths: number[] = []
  const selected: string[] = []
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    panels: options.panels ?? PANELS,
    panelSessions: sessions,
    initialPanelVisible: options.initialPanelVisible,
    initialPanelWidth: options.initialPanelWidth,
    initialPanelId: options.initialPanelId,
    onPanelVisibleChange: (value) => visibility.push(value),
    onPanelWidthChange: (value) => widths.push(value),
    onPanelIdChange: (value) => selected.push(value),
  })
  multiplexer.start()
  const control = (params: Record<string, unknown> = {}) =>
    multiplexer.control.handle("panel", params, NEVER) as Promise<PanelInfo>
  const find = (id: string) => setup.renderer.root.findDescendantById(id) as BoxRenderable | undefined
  const close = () => multiplexer.shutdown()
  return { setup, sessions, multiplexer, control, find, close, visibility, widths, selected }
}

async function launchWithKeys(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  h.setup.mockInput.pressKey("b", { ctrl: true })
  h.setup.mockInput.pressKey("c")
  await Bun.sleep(20)
  await h.setup.renderOnce()
}

test("configured Tool panels exist but start hidden and remember a resized width", async () => {
  const h = await harness()
  try {
    await launchWithKeys(h)
    const panel = h.find("fmx-tool-panel")!
    const divider = h.find("fmx-tool-panel-divider")!
    const content = h.find("fmx-content")!
    expect(panel.visible).toBe(false)
    expect(divider.visible).toBe(false)
    expect(h.sessions.opens).toHaveLength(0)
    expect([content.x, content.width]).toEqual([27, 63])

    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("r")
    await Bun.sleep(10)
    await h.setup.renderOnce()
    expect(panel.visible).toBe(true)
    expect([panel.x, panel.width]).toEqual([60, 30])
    expect(divider.x).toBe(59)
    expect(h.sessions.opens.map((entry) => entry.definition.id)).toEqual(["diff"])
    expect(h.visibility).toEqual([true])
    const toolTerminal = h.setup.renderer.root.findDescendantById("fmx-tool-terminal-diff-1")
    expect(toolTerminal).toBeInstanceOf(FmxTerminalRenderable)
    if (toolTerminal instanceof FmxTerminalRenderable) expect(toolTerminal.selectable).toBe(true)
    const activeLink = h.setup.renderer.root.findDescendantById("fmx-tool-panel-tab-label-diff")
    const inactiveLink = h.setup.renderer.root.findDescendantById("fmx-tool-panel-tab-label-tests")
    expect(activeLink).toBeInstanceOf(TextRenderable)
    expect(inactiveLink).toBeInstanceOf(TextRenderable)
    if (activeLink instanceof TextRenderable && inactiveLink instanceof TextRenderable) {
      expect(activeLink.chunks[0]!.attributes! & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE)
      expect(inactiveLink.chunks[0]!.attributes! & TextAttributes.UNDERLINE).toBe(0)
    }

    await h.setup.mockMouse.drag(divider.x, 10, 68, 10)
    await h.setup.renderOnce()
    expect(panel.width).toBe(21)
    expect(h.widths).toEqual([21])

    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("r")
    await h.setup.renderOnce()
    expect(panel.visible).toBe(false)
    expect(panel.width).toBe(21)
    expect(h.visibility).toEqual([true, false])
    if (toolTerminal instanceof FmxTerminalRenderable) expect(toolTerminal.selectable).toBe(false)
  } finally {
    await h.close()
  }
})

test("restores Tool panel visibility, width, and selection without drawing a rail for one tool", async () => {
  const h = await harness({
    panels: [PANELS[1]!],
    initialPanelVisible: true,
    initialPanelWidth: 22,
    initialPanelId: "tests",
  })
  try {
    await launchWithKeys(h)
    expect(h.find("fmx-tool-panel")).toMatchObject({ visible: true, width: 22 })
    expect(h.find("fmx-tool-panel-rail")).toMatchObject({ visible: false })
    expect(await h.control()).toMatchObject({
      visible: true,
      hidden: false,
      width: 22,
      selected: "tests",
      tabs: [{ id: "tests", label: "Tests", persistent: false }],
    })
    expect(h.visibility).toEqual([])
    expect(h.widths).toEqual([])
    expect(h.selected).toEqual([])
  } finally {
    await h.close()
  }
})

test("the selected tool follows the active Agent and cached contexts resume without restarting", async () => {
  const h = await harness({ initialPanelVisible: true, initialPanelId: "diff" })
  const root = await mkdtemp(join(tmpdir(), "fmx-tool-context-"))
  await mkdir(join(root, "alpha"))
  await mkdir(join(root, "beta"))
  const alpha = await realpath(join(root, "alpha"))
  const beta = await realpath(join(root, "beta"))
  try {
    const first = (await h.multiplexer.control.handle(
      "launch",
      { directory: alpha, focus: true },
      NEVER,
    )) as { agent: { id: number } }
    await Bun.sleep(10)
    expect(h.sessions.opens.map((entry) => [entry.definition.id, entry.context.cwd])).toEqual([["diff", alpha]])

    const second = (await h.multiplexer.control.handle(
      "launch",
      { directory: beta, focus: true },
      NEVER,
    )) as { agent: { id: number } }
    await Bun.sleep(10)
    expect(h.sessions.opens.map((entry) => [entry.definition.id, entry.context.cwd])).toEqual([
      ["diff", alpha],
      ["diff", beta],
    ])

    await h.multiplexer.control.handle("focus", { target: String(first.agent.id) }, NEVER)
    await Bun.sleep(10)
    expect(h.sessions.opens).toHaveLength(2)
    expect((await h.control()).selected).toBe("diff")

    await h.control({ select: "tests" })
    await Bun.sleep(10)
    expect(h.sessions.opens.at(-1)).toMatchObject({
      definition: { id: "tests", persistent: false },
      context: { cwd: alpha },
    })
    expect(h.selected).toEqual(["tests"])

    await h.multiplexer.control.handle("focus", { target: String(second.agent.id) }, NEVER)
    await Bun.sleep(10)
    expect(h.sessions.opens.at(-1)).toMatchObject({ definition: { id: "tests" }, context: { cwd: beta } })

    const diffLink = h.find("fmx-tool-panel-tab-diff")!
    await h.setup.mockMouse.click(diffLink.x, diffLink.y)
    await h.setup.renderOnce()
    expect((await h.control()).selected).toBe("diff")
    expect(h.selected).toEqual(["tests", "diff"])
    expect(h.sessions.opens).toHaveLength(4)
  } finally {
    await h.close()
  }
})

test("focus handoff routes typing to the selected tool while prefix actions stay with fmx", async () => {
  const h = await harness({ initialPanelVisible: true })
  try {
    await launchWithKeys(h)
    await Bun.sleep(10)
    const diff = h.sessions.opens[0]!.transport

    expect(await h.control({ focus: "panel" })).toMatchObject({ focused: "panel", visible: true })
    h.setup.mockInput.pressKey("x")
    await Bun.sleep(10)
    expect(new TextDecoder().decode(diff.writes.at(-1))).toBe("x")
    const writesBeforePrefix = diff.writes.length

    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("]")
    await Bun.sleep(10)
    expect((await h.control()).selected).toBe("tests")
    expect(h.sessions.opens.at(-1)?.definition.id).toBe("tests")
    expect(diff.writes).toHaveLength(writesBeforePrefix)

    expect(await h.control({ focus: "agent" })).toMatchObject({ focused: "agent" })
    const tests = h.sessions.opens.at(-1)!.transport
    h.setup.mockInput.pressKey("y")
    await Bun.sleep(10)
    expect(tests.writes).toHaveLength(0)

    tests.exit()
    await Bun.sleep(10)
    await expect(h.control({ focus: "panel" })).rejects.toMatchObject({ code: "not_found" })
    expect(await h.control()).toMatchObject({ focused: "agent" })

    await h.control({ select: "tests", focus: "panel" })
    expect(h.sessions.opens).toHaveLength(3)
    expect(await h.control()).toMatchObject({ focused: "panel" })
  } finally {
    await h.close()
  }
})

test("an Agent exit tears down its local Tool panel runtime and stops its owned persistent sessions", async () => {
  const h = await harness({ initialPanelVisible: true })
  try {
    await launchWithKeys(h)
    const opened = h.sessions.opens[0]!
    expect(opened.transport.detached).toBe(false)

    const agent = h.setup.renderer.root.findDescendantById("fx-1")
    expect(agent).toBeInstanceOf(FxTerminalRenderable)
    if (!(agent instanceof FxTerminalRenderable)) return
    agent.onData?.(Uint8Array.of(3, 3), "input")
    const deadline = Date.now() + 2_000
    while (h.sessions.stopped.length === 0 && Date.now() < deadline) await Bun.sleep(10)

    expect(h.sessions.stopped).toEqual([opened.context.agentId])
    expect(opened.transport.detached).toBe(true)
  } finally {
    await h.close()
  }
})

test("panel controls report unavailability when no tool is configured", async () => {
  const h = await harness({ panels: [] })
  try {
    expect(h.find("fmx-tool-panel")).toBeUndefined()
    expect(await h.control()).toMatchObject({ available: false, visible: false, selected: null, tabs: [] })
    try {
      await h.control({ hidden: false })
      throw new Error("expected control failure")
    } catch (error) {
      expect(error).toBeInstanceOf(ControlFailure)
      expect((error as ControlFailure).code).toBe("not_found")
    }
    const snapshot = (await h.multiplexer.control.handle("orient", {}, NEVER)) as Snapshot
    expect(snapshot.panel.available).toBe(false)
  } finally {
    await h.close()
  }
})
