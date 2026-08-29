import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { RuntimeBus, type BusUpdate } from "../src/runtime-bus.ts"
import { record, TestAdeSocket } from "./fixtures/ade-feed.ts"
import { initRepository } from "./fixtures/git-workspace.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))
const NEVER = new AbortController().signal

test("projects active Agent metadata and folds ADE state before attributed activity", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "fmx-bus-")))
  const project = join(home, "code", "fmx")
  await initRepository(project, "main")
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const adeSocket = new TestAdeSocket(`/tmp/fmx-bus-mux-${process.pid}.ade.sock`)
  const bus = new RuntimeBus({ homeId: "home", version: "0.3.0", runtimeId: "runtime" })
  const updates: BusUpdate[] = []
  bus.subscribe((update) => updates.push(update))
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: project,
    keybindings: resolveKeybindings().keybindings,
    home,
    adeSocket,
    bus,
    busSocketPath: "/tmp/fmx-home.bus",
  })
  const control = (method: Parameters<typeof multiplexer.control.handle>[0], params: Record<string, unknown> = {}) =>
    multiplexer.control.handle(method, params, NEVER)

  await multiplexer.start()
  try {
    const first = { agent: await multiplexer.startAgent({ directory: project }) }
    const second = { agent: await multiplexer.startAgent({ directory: project, focus: false }) }
    const initial = bus.snapshot().state
    expect(initial.active_agent_id).toBe(first.agent.agent_id)
    expect(initial.agents).toHaveLength(2)
    expect(initial.agents[0]).toMatchObject({
      agent_id: first.agent.agent_id,
      id: 1,
      display_id: 1,
      created_at: expect.any(Number),
      cwd: project,
      project: "fmx",
      git_root: project,
      main_git_root: project,
      branch: "main",
      worktree: false,
      active: true,
      state: "unknown",
    })

    updates.splice(0)
    await control("focus", { target: String(second.agent.id) })
    expect(bus.snapshot().state.active_agent_id).toBe(second.agent.agent_id)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ kind: "state", cause: "active_agent_changed" })

    await control("focus", { target: String(first.agent.id) })
    updates.splice(0)
    const firstSession = "1772000000000-1772000000000000000-first"
    adeSocket.main(first.agent.pane_id, "FxStarted", {
      sessionId: firstSession,
      workspaceRoot: project,
      turnId: 1,
    })
    expect(updates.map((update) => update.kind)).toEqual(["state", "activity"])
    expect(updates[0]).toMatchObject({ kind: "state", cause: "lifecycle" })
    expect(updates[1]).toMatchObject({
      kind: "activity",
      agentId: first.agent.agent_id,
      displayId: 1,
      gapBefore: false,
      record: {
        event: "FxStarted",
        context: { workspaceRoot: project, sessionId: firstSession, turnId: 1 },
      },
    })
    expect(updates[0]!.stateRevision).toBe(updates[1]!.stateRevision)

    updates.splice(0)
    adeSocket.emit(record("PreToolUse", {
      sequence: 3,
      instanceId: first.agent.agent_id,
      sessionId: firstSession,
      workspaceRoot: project,
      turnId: 2,
      state: "working",
      payload: { tool_name: "terminal", arguments: { command: "bun test" } },
    }))
    expect(updates.map((update) => update.kind)).toEqual(["state", "activity"])
    expect(updates[1]).toMatchObject({ kind: "activity", gapBefore: true })
    expect(bus.snapshot().state.agents[0]).toMatchObject({ session_id: firstSession, state: "working" })

    updates.splice(0)
    adeSocket.emit(record("PostTurnEnd", {
      // Older than the accepted sequence and therefore not public activity.
      sequence: 2,
      instanceId: first.agent.agent_id,
      sessionId: firstSession,
      state: "idle",
    }))
    expect(updates).toEqual([])

    const nextSession = "1772000000001-1772000000001000000-next"
    adeSocket.emit(record("SessionChanged", {
      sequence: 4,
      instanceId: first.agent.agent_id,
      sessionId: nextSession,
      state: "working",
      payload: { previous_session_id: firstSession, session_id: nextSession },
    }))
    adeSocket.emit(record("SessionMetadataChanged", {
      sequence: 5,
      instanceId: first.agent.agent_id,
      sessionId: nextSession,
      state: "working",
      payload: { title: "bus-runtime-activity" },
    }))
    expect(bus.snapshot().state.agents[0]).toMatchObject({
      session_id: nextSession,
      name: "bus-runtime-activity",
    })

    await control("focus", { target: String(second.agent.id) })
    updates.splice(0)
    adeSocket.emit(record("PostTurnEnd", {
      sequence: 6,
      instanceId: first.agent.agent_id,
      sessionId: nextSession,
      state: "idle",
      payload: { outcome: "completed", provider_disposition: "completed" },
    }))
    expect(updates.map((update) => update.kind)).toEqual(["state", "activity"])
    expect(updates[1]).toMatchObject({ kind: "activity", gapBefore: false })
    const completed = bus.snapshot().state
    expect(completed.active_agent_id).toBe(second.agent.agent_id)
    expect(completed.agents[0]).toMatchObject({ agent_id: first.agent.agent_id, state: "done" })

    const orientation = await control("orient") as { fmx: Record<string, unknown> }
    expect(orientation.fmx).not.toHaveProperty("socket")
  } finally {
    await multiplexer.shutdown()
    await rm(home, { recursive: true, force: true })
  }
})
