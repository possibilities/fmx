import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import { AgentSocket } from "../src/agent-socket.ts"
import type { Snapshot } from "../src/control-protocol.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { LineAssembler } from "../src/socket-frames.ts"
import { instanceOptions, type PtyTransport } from "./fixtures/pty-transport.ts"

/**
 * The multiplexer against the transport seam: what it does with the size,
 * the prompt, and a transport that goes away — through the PTY fixture, so
 * every path is a table here rather than a race against a daemon.
 */
const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))
const NEVER = new AbortController().signal

async function harness(name: string) {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const agentSocket = new AgentSocket({ path: `/tmp/fmx-transport-test-${name}-${process.pid}.sock` })
  await agentSocket.start()
  const options = instanceOptions()
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    agentSocket,
  })
  const control = (method: Parameters<typeof multiplexer.control.handle>[0], params: Record<string, unknown> = {}) =>
    multiplexer.control.handle(method, params, NEVER)
  const snapshot = () => control("orient") as Promise<Snapshot>
  const paneOf = async (id: number) => (await snapshot()).instances.find((i) => i.id === id)!.pane_id
  const report = async (id: number, state: string) => {
    const paneId = await paneOf(id)
    await exchange(
      agentSocket.path,
      `{"id":"${Date.now()}","method":"pane.report_agent","params":{"pane_id":"${paneId}","source":"custom:fx","agent":"fx","state":"${state}"}}`,
    )
    await setup.renderOnce()
  }
  const close = async () => {
    await multiplexer.shutdown()
    agentSocket.close()
  }
  const modal = setup.renderer.root.findDescendantById("fmx-modal") as BoxRenderable
  await multiplexer.start()
  return { setup, multiplexer, options, control, snapshot, report, close, modal }
}

async function exchange(path: string, payload: string): Promise<string> {
  const assembler = new LineAssembler()
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  await Bun.connect({
    unix: path,
    socket: {
      open: (socket) => void socket.write(`${payload}\n`),
      data: (_socket, data) => {
        const [line] = assembler.push(new TextDecoder().decode(data))
        if (line !== undefined) resolve(line)
      },
      error: (_socket, error) => reject(error),
    },
  })
  return promise
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
}

test("a transport adopted after the layout pass is told the terminal's real size", async () => {
  const h = await harness("size")
  try {
    // Hold the start until the renderer has laid the terminal out beside the sidebar.
    let release!: () => void
    h.options.transport.gate = new Promise((resolve) => {
      release = resolve
    })
    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("c")
    await waitFor(() => h.options.transport.started.length === 1)
    const transport = h.options.transport.started[0]!
    await h.setup.renderOnce()
    await h.setup.renderOnce()
    const terminal = h.setup.renderer.root.findDescendantById("fx-1") as { width: number; height: number }
    expect(terminal.width).toBeGreaterThan(0)
    expect(terminal.width).not.toBe(80)
    expect(transport.lastResize).toBeNull()
    release()
    await waitFor(() => transport.lastResize !== null)
    expect(transport.lastResize).toEqual({ cols: terminal.width, rows: terminal.height })
  } finally {
    await h.close()
  }
})

test("selects the saved survivor before restoring any terminal", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const options = instanceOptions()
  const firstClaim = options.manifest.claim({
    cwd: process.cwd(),
    fxPath: FAKE_FX,
    fxArgs: [],
    createdAt: 1,
  }).result
  const secondClaim = options.manifest.claim({
    cwd: process.cwd(),
    fxPath: FAKE_FX,
    fxArgs: [],
    createdAt: 2,
  }).result
  const [first, second] = await Promise.all([
    options.manifest.markRunning(firstClaim.instanceId),
    options.manifest.markRunning(secondClaim.instanceId),
  ])
  const attached: string[] = []
  options.transport.attachBehavior = (entry) => {
    attached.push(entry.instanceId)
    return { bind() {}, write() {}, resize() {}, detach() {} }
  }
  const selections: Array<string | null> = []
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    survivors: [first, second],
    initialActiveInstanceId: second.instanceId,
    onActiveInstanceChange: (instanceId) => selections.push(instanceId),
  })

  try {
    await multiplexer.start()
    const snapshot = (await multiplexer.control.handle("orient", {}, NEVER)) as Snapshot
    expect(snapshot.active).toBe(2)
    expect(snapshot.instances.map((instance) => [instance.id, instance.active])).toEqual([
      [1, false],
      [2, true],
    ])
    expect(snapshot.sidebar.rows.filter((row) => row.kind === "agent").map((row) => [row.instance, row.active])).toEqual([
      [1, false],
      [2, true],
    ])
    expect((setup.renderer.root.findDescendantById("fx-1") as BoxRenderable).visible).toBe(false)
    expect((setup.renderer.root.findDescendantById("fx-2") as BoxRenderable).visible).toBe(true)
    expect(attached[0]).toBe(second.instanceId)
    expect(selections).toEqual([second.instanceId])
  } finally {
    await multiplexer.shutdown()
  }
})

test("a launch prompt armed before the transport arrives goes in once it has", async () => {
  const h = await harness("prompt")
  try {
    let release!: () => void
    h.options.transport.gate = new Promise((resolve) => {
      release = resolve
    })
    const launched = h.control("launch", { prompt: "hello there", directory: process.cwd(), focus: true })
    await waitFor(() => h.options.transport.started.length === 1)
    // fx reports before fmx has adopted the transport, and the settle passes.
    await h.report(1, "idle")
    await Bun.sleep(400)
    expect((await h.snapshot()).instances[0]?.awaiting_work).toBe(true)
    release()
    await launched
    // The prompt reaches the fake fx, which echoes what it is sent.
    await waitFor(async () => {
      await h.setup.renderOnce()
      return h.setup.captureCharFrame().includes("hello there")
    })
  } finally {
    await h.close()
  }
})

test("a lost transport whose Instance has ended is removed like an exit", async () => {
  const h = await harness("ended")
  try {
    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("c")
    await waitFor(() => h.options.transport.started.length === 1 && h.options.manifest.entries[0]?.phase === "running")
    const entry = h.options.manifest.entries[0]!
    h.options.transport.attachBehavior = "ended"
    ;(h.options.transport.started[0] as PtyTransport).lose()
    await waitFor(() => (h.setup.renderer.root.findDescendantById("fx-1") as unknown) === undefined)
    expect(h.options.manifest.get(entry.instanceId)).toBeNull()
    expect(h.options.transport.attaches.get(entry.instanceId)).toBe(1)
    expect(h.modal.visible).toBe(false)
  } finally {
    await h.close()
  }
})

test("a lost transport that cannot be reached again leaves the screen but keeps its claim", async () => {
  const h = await harness("unreachable")
  try {
    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("c")
    await waitFor(() => h.options.transport.started.length === 1 && h.options.manifest.entries[0]?.phase === "running")
    const entry = h.options.manifest.entries[0]!
    h.options.transport.attachBehavior = "unreachable"
    ;(h.options.transport.started[0] as PtyTransport).lose()
    await waitFor(() => (h.setup.renderer.root.findDescendantById("fx-1") as unknown) === undefined, 5_000)
    await h.setup.renderOnce()
    expect(h.options.transport.attaches.get(entry.instanceId)).toBe(3)
    expect(h.options.manifest.get(entry.instanceId)?.phase).toBe("running")
    expect(h.modal.visible).toBe(true)
    expect(h.setup.captureCharFrame()).toContain("lost instance 1")
  } finally {
    await h.close()
  }
})

test("a lost transport that can be reached again is adopted and the Instance stays", async () => {
  const h = await harness("recovered")
  try {
    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("c")
    await waitFor(() => h.options.transport.started.length === 1 && h.options.manifest.entries[0]?.phase === "running")
    const entry = h.options.manifest.entries[0]!
    const first = h.options.transport.started[0] as PtyTransport
    // A second fx behind the seam stands in for the same one re-attached.
    let second: PtyTransport | null = null
    h.options.transport.attachBehavior = () => {
      second = new (first.constructor as new (launch: unknown) => PtyTransport)({
        entry,
        command: [FAKE_FX],
        cwd: process.cwd(),
        env: { ...process.env, FMX_INSTANCE_ID: "1" } as Record<string, string>,
        size: { cols: 80, rows: 24 },
      })
      return second
    }
    first.lose()
    await waitFor(() => second !== null && second.lastResize !== null)
    await Bun.sleep(50)
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeDefined()
    expect(h.options.manifest.get(entry.instanceId)?.phase).toBe("running")
    expect(h.modal.visible).toBe(false)
    expect((await h.snapshot()).instances.map((i) => i.id)).toEqual([1])
  } finally {
    await h.close()
  }
})
