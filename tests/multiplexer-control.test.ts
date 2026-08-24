import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentSocket } from "../src/agent-socket.ts"
import { AdeSocket } from "../src/ade-events.ts"
import { type CatalogInfo, ControlFailure, type DraftInfo, type Snapshot } from "../src/control-protocol.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"
import { LineAssembler } from "../src/socket-frames.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))
const CONTROL_PATH = `/tmp/fmx-control-test-${process.pid}.ctl`
const NEVER = new AbortController().signal

type Setup = Awaited<ReturnType<typeof createTestRenderer>>

async function workspace(): Promise<{ home: string; code: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "fmx-control-")))
  const code = join(home, "code")
  for (const name of ["alpha", "beta"]) await mkdir(join(code, name), { recursive: true })
  return { home, code }
}

async function harness(name: string, withAde = false) {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const agentSocket = new AgentSocket({ path: `/tmp/fmx-control-test-${name}-${process.pid}.sock` })
  await agentSocket.start()
  const adeSocket = withAde
    ? new AdeSocket({ path: `/tmp/fmx-control-test-${name}-${process.pid}.ade.sock` })
    : null
  adeSocket?.start()
  const options = agentOptions()
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: join(code, "alpha"),
    keybindings: resolveKeybindings().keybindings,
    projectRoots: ["~/code"],
    home,
    agentSocket,
    adeSocket,
    controlSocketPath: CONTROL_PATH,
  })
  const control = (method: Parameters<typeof multiplexer.control.handle>[0], params: Record<string, unknown> = {}) =>
    multiplexer.control.handle(method, params, NEVER)
  const close = async () => {
    await multiplexer.shutdown()
    adeSocket?.close()
    agentSocket.close()
  }
  /**
   * The pane id fx would address: an Agent's is minted with its identity,
   * so a test names the Agent by number and looks the pane up.
   */
  const paneOf = async (ref: string): Promise<string> => {
    const match = /^p_(\d+)$/.exec(ref)
    if (!match) return ref
    const snapshot = (await control("orient")) as Snapshot
    const info = snapshot.agents.find((candidate) => candidate.id === Number(match[1]))
    if (!info) throw new Error(`no agent ${match[1]}`)
    return info.pane_id
  }
  /** Report to the agent socket exactly as fx does: one line, one reply. */
  const report = async (pane: string, state: string, extra = "") => {
    const paneId = await paneOf(pane)
    const payload = `{"id":"${Date.now()}","method":"pane.report_agent","params":{"pane_id":"${paneId}","source":"custom:fx","agent":"fx","state":"${state}"${extra}}}`
    await exchange(agentSocket.path, payload)
    await setup.renderOnce()
  }
  const session = async (pane: string, sessionId: string) => {
    const paneId = await paneOf(pane)
    await exchange(
      agentSocket.path,
      `{"id":"s","method":"pane.report_agent_session","params":{"pane_id":"${paneId}","source":"custom:fx","agent":"fx","agent_session_id":"${sessionId}"}}`,
    )
    await setup.renderOnce()
  }
  const launch = (params: Record<string, unknown> = {}) =>
    control("launch", params) as Promise<{ agent: { id: number } }>
  return { setup, multiplexer, control, close, report, session, launch, home, code, adeSocket, options }
}

async function sendAde(socket: AdeSocket, record: Record<string, unknown>): Promise<void> {
  const connection = await Bun.connect({
    unix: socket.path,
    socket: { data: () => {} },
  })
  connection.write(`${JSON.stringify(record)}\n`)
  connection.end()
}

function adeRecord(
  sequence: number,
  instanceId: string,
  event: string,
  sessionId: string | null,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    sequence,
    event,
    instance_id: instanceId,
    context: {
      agent_role: "main",
      workspace_root: "/work",
      session_id: sessionId,
      parent_session_id: null,
    },
    payload,
  }
}

async function exchange(path: string, payload: string): Promise<string> {
  const assembler = new LineAssembler()
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const connection = await Bun.connect({
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
  try {
    return await promise
  } finally {
    connection.end()
  }
}

function terminal(setup: Setup, id: number): BoxRenderable {
  return setup.renderer.root.findDescendantById(`fx-${id}`) as BoxRenderable
}

async function failure(run: Promise<unknown>): Promise<ControlFailure> {
  try {
    await run
  } catch (error) {
    if (error instanceof ControlFailure) return error
    throw error
  }
  throw new Error("expected a ControlFailure")
}

test("orients an empty fmx", async () => {
  const h = await harness("empty")
  try {
    const snapshot = (await h.control("orient", { caller: 1 })) as Snapshot
    expect(snapshot.fmx).toMatchObject({ pid: process.pid, socket: CONTROL_PATH, cols: 100, rows: 30 })
    expect(snapshot.you).toBeNull()
    expect(snapshot.active).toBeNull()
    expect(snapshot.agents).toEqual([])
    expect(snapshot.tray).toMatchObject({ visible: false, rows: [] })
    expect(snapshot.surface).toEqual({ kind: "none" })
  } finally {
    await h.close()
  }
})

test("launches in the background once something is on screen, and says where the caller is", async () => {
  const h = await harness("launch")
  try {
    const first = await h.launch()
    expect(first.agent.id).toBe(1)
    await h.setup.renderOnce()
    expect(terminal(h.setup, 1).visible).toBe(true)

    const second = await h.launch({ caller: 1, directory: join(h.code, "beta"), prompt: "write tests" })
    await h.setup.renderOnce()
    expect(second.agent.id).toBe(2)
    expect(terminal(h.setup, 2).visible).toBe(false)
    expect(terminal(h.setup, 1).visible).toBe(true)

    const snapshot = (await h.control("orient", { caller: 1 })) as Snapshot
    expect(snapshot.active).toBe(1)
    expect(snapshot.you).toMatchObject({ id: 1, active: true, cwd: join(h.code, "alpha"), project: "alpha" })
    expect(snapshot.agents.map((agent) => [agent.id, agent.project, agent.awaiting_work])).toEqual([
      [1, "alpha", false],
      [2, "beta", true],
    ])
    expect(snapshot.tray.visible).toBe(true)
    expect(snapshot.tray.rows.map((row) => [row.kind, row.depth, row.text, row.agent])).toEqual([
      ["project", 0, "alpha", null],
      ["branch", 1, "(untracked)", null],
      ["agent", 2, "· —", 1],
      ["project", 0, "beta", null],
      ["branch", 1, "(untracked)", null],
      ["agent", 2, "· —", 2],
    ])

    const focused = await h.launch({ focus: true })
    await h.setup.renderOnce()
    expect(focused.agent.id).toBe(3)
    expect(terminal(h.setup, 3).visible).toBe(true)
    expect(terminal(h.setup, 1).visible).toBe(false)
  } finally {
    await h.close()
  }
})

test("includes filesystem subagents in the tray orientation", async () => {
  const h = await harness("subagents")
  const parent = "1787368596567-1787368596567934000-ba9a9f7e16e5ef8c"
  const child = "1787368609310-1787368609310138000-3e38dc7a8d7c16c2"
  try {
    await h.launch()
    await mkdir(join(h.home, ".fx", "sessions", parent), { recursive: true })
    const subagentDirectory = join(h.home, ".fx", "sessions", child, "subagent")
    await mkdir(subagentDirectory, { recursive: true })
    await writeFile(
      join(subagentDirectory, "control.json"),
      JSON.stringify({
        schema_version: 7,
        child_id: child,
        parent_id: parent,
        generation: 1,
        configuration: { name: "test-subagent" },
        state: "completed",
        created_at_ms: 1,
      }),
    )
    await h.session("p_1", parent)

    const snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (candidate) => candidate.tray.rows.some((row) => row.kind === "subagent"),
    )
    expect(snapshot.tray.rows.map((row) => [row.kind, row.depth, row.text, row.agent])).toEqual([
      ["project", 0, "alpha", null],
      ["branch", 1, "(untracked)", null],
      ["agent", 2, "· ba9a9f7e16e5ef8c", 1],
      ["subagent", 3, "✓ test-subagent", null],
    ])
    // The model carries them too, so an agent need not parse the drawing.
    expect(snapshot.agents[0]?.subagents).toEqual([
      { session_id: child, label: "test-subagent", state: "done", attention: null, children: [] },
    ])
    expect(((await h.control("orient", { caller: 1 })) as Snapshot).you?.subagents).toHaveLength(1)
  } finally {
    await h.close()
  }
})

test("refuses a launch it cannot honour without drawing anything", async () => {
  const h = await harness("refuse")
  try {
    const missing = await failure(h.launch({ directory: join(h.code, "nowhere") }))
    expect(missing.code).toBe("invalid_params")

    const worktree = await failure(h.launch({ directory: join(h.code, "beta"), worktree: true }))
    expect(worktree.code).toBe("failed")
    expect(worktree.message).toContain("not a git repository")
    const snapshot = (await h.control("orient")) as Snapshot
    expect(snapshot.surface).toEqual({ kind: "none" })
    expect(snapshot.agents).toEqual([])
  } finally {
    await h.close()
  }
})

test("focuses by position, id, and name, and refuses while something is open", async () => {
  const h = await harness("focus")
  try {
    await h.launch()
    await h.launch()
    await h.launch()
    await h.setup.renderOnce()
    expect(((await h.control("orient")) as Snapshot).active).toBe(1)

    expect(await h.control("focus", { target: "next" })).toMatchObject({ agent: { id: 2 } })
    expect(await h.control("focus", { target: "previous" })).toMatchObject({ agent: { id: 1 } })
    expect(await h.control("focus", { target: "previous" })).toMatchObject({ agent: { id: 3 } })
    expect(await h.control("focus", { target: "2", caller: 1 })).toMatchObject({ agent: { id: 2 } })
    expect(await h.control("focus", { target: "current", caller: 1 })).toMatchObject({ agent: { id: 1 } })
    await h.setup.renderOnce()
    expect(terminal(h.setup, 1).visible).toBe(true)

    await h.session("p_3", "sess_cafe0123")
    expect(await h.control("focus", { target: "sess_ca" })).toMatchObject({ agent: { id: 3 } })
    expect((await failure(h.control("focus", { target: "nobody" }))).code).toBe("not_found")
    expect((await failure(h.control("focus", { target: "9" }))).code).toBe("not_found")
    expect((await failure(h.control("focus", { target: "current" }))).code).toBe("invalid_params")

    await h.control("keys", { show: true })
    expect(((await h.control("orient")) as Snapshot).surface).toEqual({ kind: "help" })
    const busy = await failure(h.control("focus", { target: "next" }))
    expect(busy.code).toBe("busy")
    expect(busy.data).toEqual({ surface: { kind: "help" } })
  } finally {
    await h.close()
  }
})

test("adopts native session names over ADE, recovers gaps, and keeps eager identity authoritative", async () => {
  const h = await harness("ade-names", true)
  const firstSession = "1787362101388-1787362101388156000-2897385323da2683"
  const secondSession = "1787362101389-1787362101389156000-2897385323da2684"
  const replacementSession = "1787362101390-1787362101390156000-2897385323da2685"
  const writeName = async (sessionId: string, title: string) => {
    const directory = join(h.home, ".fx", "sessions", sessionId)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "display.json"),
      `${JSON.stringify({ schema_version: 1, title, preview: null, origin_workspace_root: null })}\n`,
    )
  }

  try {
    await h.launch()
    await h.launch()
    const ade = h.adeSocket!
    const [first, second] = h.options.manifest.entries
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    await sendAde(ade, adeRecord(1, first!.agentId, "FxStarted", firstSession))
    await sendAde(
      ade,
      adeRecord(2, first!.agentId, "SessionMetadataChanged", firstSession, {
        title: "Coordinate the review",
      }),
    )
    let snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[0]?.name === "Coordinate the review",
    )
    expect(snapshot.agents[0]).toMatchObject({ session_id: firstSession, name: "Coordinate the review" })
    expect(snapshot.tray.rows.find((row) => row.agent === 1)?.text).toContain("Coordinate the review")

    // A late frame on the legacy socket cannot rewind ADE's eager identity.
    await h.session("p_1", "legacy-session")
    expect(((await h.control("orient")) as Snapshot).agents[0]?.session_id).toBe(firstSession)

    // An unknown additive event still carries authoritative envelope context.
    // This is the first record a restarted fmx could see after fx changed
    // sessions while detached.
    await writeName(replacementSession, "Recovered from additive context")
    await sendAde(ade, adeRecord(3, first!.agentId, "FutureObservation", replacementSession))
    snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[0]?.name === "Recovered from additive context",
    )
    expect(snapshot.agents[0]?.session_id).toBe(replacementSession)

    // A later gap re-reads fx's durable sidecar before ignoring the event.
    await writeName(replacementSession, "Recovered after gap")
    await sendAde(ade, adeRecord(5, first!.agentId, "FutureObservation", replacementSession))
    snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[0]?.name === "Recovered after gap",
    )

    await sendAde(ade, adeRecord(1, second!.agentId, "FxStarted", secondSession))
    await sendAde(
      ade,
      adeRecord(2, second!.agentId, "SessionMetadataChanged", secondSession, {
        title: "Recovered after gap",
      }),
    )
    await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[1]?.name === "Recovered after gap",
    )
    const ambiguous = await failure(h.control("focus", { target: "Recovered after gap" }))
    expect(ambiguous.code).toBe("ambiguous")
    expect(ambiguous.data).toEqual({ agents: [1, 2] })

    // Exact duplicate names remain ambiguous even when that same text is a
    // unique prefix of another Agent's session id.
    const collidingName = firstSession.slice(0, firstSession.indexOf("-") + 4)
    await sendAde(
      ade,
      adeRecord(6, first!.agentId, "SessionMetadataChanged", replacementSession, {
        title: collidingName,
      }),
    )
    await sendAde(
      ade,
      adeRecord(3, second!.agentId, "SessionMetadataChanged", secondSession, {
        title: collidingName,
      }),
    )
    await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents.every((agent) => agent.name === collidingName),
    )
    const nameBeforePrefix = await failure(h.control("focus", { target: collidingName }))
    expect(nameBeforePrefix.code).toBe("ambiguous")
    expect(nameBeforePrefix.data).toEqual({ agents: [1, 2] })

    await writeName(firstSession, "Replacement session")
    await sendAde(
      ade,
      adeRecord(7, first!.agentId, "SessionChanged", firstSession, {
        previous_session_id: replacementSession,
        session_id: firstSession,
      }),
    )
    snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[0]?.session_id === firstSession,
    )
    expect(snapshot.agents[0]?.name).toBe("Replacement session")
    await h.session("p_1", replacementSession)
    expect(((await h.control("orient")) as Snapshot).agents[0]).toMatchObject({
      session_id: firstSession,
      name: "Replacement session",
    })
  } finally {
    await h.close()
  }
})

test("opens a draft prefilled, lets it be read, changed, and cancelled", async () => {
  const h = await harness("draft")
  try {
    await h.launch()
    const opened = (await h.control("draft.open", {
      caller: 1,
      fields: { prompt: "fix the flaky test", model: "gpt-5.6-luna", effort: "max" },
    })) as DraftInfo
    expect(opened).toMatchObject({
      draft: "d1",
      kind: "launch",
      status: "open",
      opened_by: "agent",
      fields: {
        prompt: "fix the flaky test",
        directory: join(h.code, "alpha"),
        worktree: false,
        model: "gpt-5.6-luna",
        effort: "max",
      },
    })
    await h.setup.renderOnce()
    const frame = h.setup.captureCharFrame()
    expect(frame).toContain("prompt    fix the flaky test")
    expect(frame).toContain("project   ~/code/alpha")
    expect(frame).toContain("model     gpt-5.6-luna")
    expect(frame).toContain("effort    max")

    const snapshot = (await h.control("orient")) as Snapshot
    expect(snapshot.surface).toMatchObject({ kind: "launch", draft: { draft: "d1" } })
    expect((await failure(h.control("draft.open"))).code).toBe("busy")

    // The human's keys still reach the prompt while the draft is open.
    await h.setup.mockInput.typeText(" now")
    await h.setup.renderOnce()
    expect(((await h.control("draft.show")) as DraftInfo).fields.prompt).toBe("fix the flaky test now")

    const changed = (await h.control("draft.set", {
      draft: "d1",
      fields: { directory: join(h.code, "beta"), prompt: "write tests" },
    })) as DraftInfo
    expect(changed.fields).toMatchObject({ directory: join(h.code, "beta"), prompt: "write tests" })
    await h.setup.renderOnce()
    expect(h.setup.captureCharFrame()).toContain("project   ~/code/beta")

    const narrowed = (await h.control("draft.set", {
      draft: "d1",
      fields: { model: "gpt-5.4" },
    })) as DraftInfo
    expect(narrowed.fields).toMatchObject({ model: "gpt-5.4", effort: "high" })
    const invalid = await failure(h.control("draft.set", { draft: "d1", fields: { effort: "max" } }))
    expect(invalid.code).toBe("invalid_params")

    const cancelled = (await h.control("draft.cancel", { draft: "d1" })) as DraftInfo
    expect(cancelled.status).toBe("cancelled")
    expect(((await h.control("orient")) as Snapshot).surface).toEqual({ kind: "none" })
    expect(((await h.control("draft.wait", { draft: "d1" })) as DraftInfo).status).toBe("cancelled")
    expect((await failure(h.control("draft.set", { draft: "d1", fields: {} }))).code).toBe("busy")
    expect((await failure(h.control("draft.show"))).code).toBe("not_found")
  } finally {
    await h.close()
  }
})

test("submits a draft and answers with the agent it started; escape resolves a waiter", async () => {
  const h = await harness("submit")
  try {
    const opened = (await h.control("draft.open", { fields: { prompt: "go" } })) as DraftInfo
    const submitted = (await h.control("draft.submit", { draft: opened.draft })) as DraftInfo
    expect(submitted.status).toBe("submitted")
    expect(submitted.outcome).toEqual({ agent: 1 })
    await h.setup.renderOnce()
    expect(terminal(h.setup, 1).visible).toBe(true)
    expect(((await h.control("orient")) as Snapshot).agents[0]?.awaiting_work).toBe(true)

    const second = (await h.control("draft.open")) as DraftInfo
    expect(second.draft).toBe("d2")
    const waiting = h.control("draft.wait", { draft: "d2" }) as Promise<DraftInfo>
    h.setup.mockInput.pressEscape()
    await h.setup.renderOnce()
    expect((await waiting).status).toBe("cancelled")

    // A dialog the human opens is a draft too, so an agent can finish it.
    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("l")
    await h.setup.renderOnce()
    const byKeys = (await h.control("draft.show")) as DraftInfo
    expect(byKeys).toMatchObject({ draft: "d3", opened_by: "keys" })
    const timedOut = await failure(h.control("draft.wait", { draft: "d3", timeout_ms: 20 }))
    expect(timedOut.code).toBe("timeout")
    expect((await h.control("draft.cancel", { draft: "d3" }) as DraftInfo).status).toBe("cancelled")
  } finally {
    await h.close()
  }
})

test("waits for an agent through the prompt it was launched with", async () => {
  const h = await harness("wait")
  try {
    await h.launch({ prompt: "do the work" })
    const waiting = h.control("agent.wait", { target: "1" }) as Promise<{ state: string }>
    let settled = false
    void waiting.then(() => (settled = true))

    // The idle fx reports at startup is not the idle that means finished.
    await h.report("p_1", "idle")
    await Bun.sleep(10)
    expect(settled).toBe(false)
    await h.report("p_1", "working")
    expect(((await h.control("orient")) as Snapshot).agents[0]?.awaiting_work).toBe(false)
    // Agent 1 is on screen, so its finish is seen as it happens: idle, not done.
    await h.report("p_1", "idle")
    expect((await waiting).state).toBe("idle")
    expect(await h.control("agent.wait", { target: "1", states: ["idle"] })).toMatchObject({ state: "idle" })

    // A finish nobody was looking at is done until someone looks.
    await h.launch({ prompt: "more work" })
    const background = h.control("agent.wait", { target: "2" }) as Promise<{ state: string }>
    await h.report("p_2", "working")
    await h.report("p_2", "idle")
    expect((await background).state).toBe("done")
    await h.control("focus", { target: "2" })
    expect(await h.control("agent.wait", { target: "2" })).toMatchObject({ state: "idle" })
    await h.control("focus", { target: "1" })
    const timedOut = await failure(h.control("agent.wait", { target: "1", states: ["blocked"], timeout_ms: 20 }))
    expect(timedOut.code).toBe("timeout")
    expect((await failure(h.control("agent.wait", { target: "1", states: ["napping"] }))).code).toBe(
      "invalid_params",
    )

    await h.report("p_1", "blocked", ',"custom_status":"question"')
    expect(await h.control("agent.wait", { target: "1" })).toMatchObject({
      state: "blocked",
      agent: { attention: "question" },
    })
  } finally {
    await h.close()
  }
})

test("sends text into a running agent and holds a wait until it is picked up", async () => {
  const h = await harness("send")
  try {
    await h.launch({ prompt: "first" })
    expect((await failure(h.control("agent.send", { target: "1", text: "second" }))).code).toBe("busy")
    await h.report("p_1", "idle")
    await Bun.sleep(450)
    await h.report("p_1", "working")
    await h.report("p_1", "idle")

    expect(await h.control("agent.send", { target: "1", text: "second" })).toMatchObject({
      agent: { id: 1, awaiting_work: true },
    })
    const waiting = h.control("agent.wait", { target: "1", timeout_ms: 2000 }) as Promise<{ state: string }>
    await h.report("p_1", "working")
    await h.report("p_1", "idle")
    expect((await waiting).state).toBe("idle")
    expect((await failure(h.control("agent.send", { target: "1", text: "  " }))).code).toBe("invalid_params")
  } finally {
    await h.close()
  }
})

test("offers the catalog the pickers draw from, and a draft's choices follow its model", async () => {
  const h = await harness("catalog")
  try {
    const catalog = (await h.control("catalog")) as CatalogInfo
    expect(catalog.default).toEqual({ model: "gpt-5.6-sol", effort: "high" })
    expect(catalog.models[0]).toEqual({
      id: "gpt-5.6-sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default_effort: "high",
    })
    expect(catalog.models.map((model) => model.id)).toContain("gpt-5.4-mini")

    const opened = (await h.control("draft.open", { fields: { model: "gpt-5.4-mini" } })) as DraftInfo
    expect(opened.choices).toEqual({
      models: catalog.models.map((model) => model.id),
      efforts: ["low", "medium", "high", "xhigh"],
    })
    const changed = (await h.control("draft.set", { draft: opened.draft, fields: { model: "gpt-5.6-sol" } })) as DraftInfo
    expect(changed.choices?.efforts).toContain("ultra")
    expect(((await h.control("orient")) as Snapshot).surface).toMatchObject({
      kind: "launch",
      draft: { choices: { efforts: expect.arrayContaining(["ultra"]) } },
    })
    await h.control("draft.cancel", { draft: opened.draft })
  } finally {
    await h.close()
  }
})

test("lists the keys with their command equivalents, and resizes the tray", async () => {
  const h = await harness("keys")
  try {
    expect(await h.control("keys")).toEqual({
      prefix: "ctrl+b",
      bindings: {
        help: { keys: ["prefix+?"], command: "fmx control keys --show" },
        detach: { keys: ["prefix+d"], command: null },
        new_tab: { keys: ["prefix+c"], command: "fmx control launch" },
        launch: { keys: ["prefix+l"], command: "fmx control launch --editable" },
        previous_tab: { keys: ["prefix+p"], command: "fmx control focus previous" },
        next_tab: { keys: ["prefix+n"], command: "fmx control focus next" },
        toggle_tray: { keys: ["prefix+b"], command: "fmx control tray --toggle" },
        toggle_panel: { keys: ["prefix+r"], command: "fmx control panel --toggle" },
        focus_panel: { keys: ["prefix+o"], command: "fmx control panel --focus toggle" },
        previous_panel: { keys: ["prefix+["], command: "fmx control panel --previous" },
        next_panel: { keys: ["prefix+]"], command: "fmx control panel --next" },
      },
    })
    expect(await h.control("tray", { hidden: true })).toEqual({ visible: false, hidden: true, width: 26 })
    await h.launch()
    expect(await h.control("tray", { width: 30 })).toEqual({ visible: false, hidden: true, width: 30 })
    expect(await h.control("tray", { toggle: true })).toEqual({ visible: true, hidden: false, width: 30 })
    expect(await h.control("tray", { width: 400 })).toEqual({ visible: true, hidden: false, width: 33 })
    expect(await h.control("tray", { hidden: false })).toEqual({ visible: true, hidden: false, width: 33 })
    expect(((await h.control("orient")) as Snapshot).tray).toMatchObject({ visible: true, hidden: false })
  } finally {
    await h.close()
  }
})

async function waitForSnapshot(
  read: () => Promise<Snapshot>,
  condition: (snapshot: Snapshot) => boolean,
  timeoutMs = 2_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const snapshot = await read()
    if (condition(snapshot)) return snapshot
    if (Date.now() >= deadline) throw new Error("snapshot condition timed out")
    await Bun.sleep(10)
  }
}
