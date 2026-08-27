import { expect, test } from "bun:test"
import type { AgentInfo } from "../src/control-protocol.ts"
import { ObservationHub, type ObservationUpdate } from "../src/observation-hub.ts"
import { record } from "./fixtures/ade-feed.ts"

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    agent_id: "0123456789abcdef0123456789abcdef",
    id: 1,
    display_id: 1,
    pane_id: "p_0123456789abcdef0123456789abcdef",
    created_at: 1_772_000_000_000,
    cwd: "/workspace/fmx",
    project: "fmx",
    git_root: "/workspace/fmx",
    main_git_root: "/workspace/fmx",
    branch: "main",
    worktree: false,
    name: "observation-stream",
    session_id: "1772000000000-1772000000000000000-session",
    label: "observation-stream",
    state: "idle",
    attention: null,
    active: true,
    awaiting_work: false,
    subagents: [],
    ...overrides,
  }
}

test("retains one deduplicated authoritative state with monotonic revisions", () => {
  const hub = new ObservationHub({ homeId: "home-1", version: "0.3.0", runtimeId: "runtime-1", pid: 123 })
  const updates: ObservationUpdate[] = []
  hub.subscribe((update) => updates.push(update))

  expect(hub.runtime).toEqual({ id: "runtime-1", home_id: "home-1", pid: 123, version: "0.3.0" })
  expect(hub.snapshot()).toEqual({ stateRevision: 0, state: { active_agent_id: null, agents: [] } })

  const state = { active_agent_id: agent().agent_id, agents: [agent()] }
  expect(hub.updateState(state, "agent_added")).toBe(true)
  expect(hub.updateState({ active_agent_id: state.active_agent_id, agents: [agent()] }, "duplicate")).toBe(false)
  expect(hub.updateState({ ...state, agents: [agent({ state: "working" })] }, "lifecycle")).toBe(true)

  expect(hub.snapshot()).toEqual({
    stateRevision: 2,
    state: { ...state, agents: [agent({ state: "working" })] },
  })
  expect(updates.map((update) => update.kind === "state" && [update.stateRevision, update.cause])).toEqual([
    [1, "agent_added"],
    [2, "lifecycle"],
  ])
})

test("activity is live-only and carries the state revision current when it was accepted", () => {
  const hub = new ObservationHub({ homeId: "home-1", version: "0.3.0", runtimeId: "runtime-1" })
  const ade = record("PromptQueued", { sequence: 3 })

  hub.publishActivity(ade, ade.instanceId, 1, true)
  const updates: ObservationUpdate[] = []
  const unsubscribe = hub.subscribe((update) => updates.push(update))
  hub.updateState({ active_agent_id: ade.instanceId, agents: [agent()] }, "lifecycle")
  hub.publishActivity(ade, ade.instanceId, 1, true)
  unsubscribe()
  hub.publishActivity(record("PostTurnEnd", { sequence: 4 }), ade.instanceId, 1, false)

  expect(updates).toHaveLength(2)
  expect(updates[0]).toMatchObject({ kind: "state", stateRevision: 1 })
  expect(updates[1]).toMatchObject({
    kind: "activity",
    stateRevision: 1,
    agentId: ade.instanceId,
    displayId: 1,
    gapBefore: true,
  })
})

test("one failing local listener cannot disturb publishers or other listeners", () => {
  const hub = new ObservationHub({ homeId: "home-1", version: "0.3.0" })
  let received = 0
  hub.subscribe(() => {
    throw new Error("observer failed")
  })
  hub.subscribe(() => received += 1)
  expect(hub.updateState({ active_agent_id: null, agents: [agent({ active: false })] }, "agent_added")).toBe(true)
  expect(received).toBe(1)
})
