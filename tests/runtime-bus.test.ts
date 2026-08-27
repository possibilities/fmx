import { expect, test } from "bun:test"
import type { AgentInfo } from "../src/control-protocol.ts"
import { RuntimeBus, type BusUpdate } from "../src/runtime-bus.ts"
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
    name: "runtime-bus",
    session_id: "1772000000000-1772000000000000000-session",
    label: "runtime-bus",
    state: "idle",
    attention: null,
    active: true,
    awaiting_work: false,
    subagents: [],
    ...overrides,
  }
}

test("retains one deduplicated authoritative state with monotonic revisions", () => {
  const bus = new RuntimeBus({ homeId: "home-1", version: "0.3.0", runtimeId: "runtime-1", pid: 123 })
  const updates: BusUpdate[] = []
  bus.subscribe((update) => updates.push(update))

  expect(bus.runtime).toEqual({ id: "runtime-1", home_id: "home-1", pid: 123, version: "0.3.0" })
  expect(bus.snapshot()).toEqual({ stateRevision: 0, state: { active_agent_id: null, agents: [] } })

  const state = { active_agent_id: agent().agent_id, agents: [agent()] }
  expect(bus.updateState(state, "agent_added")).toBe(true)
  expect(bus.updateState({ active_agent_id: state.active_agent_id, agents: [agent()] }, "duplicate")).toBe(false)
  expect(bus.updateState({ ...state, agents: [agent({ state: "working" })] }, "lifecycle")).toBe(true)

  expect(bus.snapshot()).toEqual({
    stateRevision: 2,
    state: { ...state, agents: [agent({ state: "working" })] },
  })
  expect(updates.map((update) => update.kind === "state" && [update.stateRevision, update.cause])).toEqual([
    [1, "agent_added"],
    [2, "lifecycle"],
  ])
})

test("activity is live-only and carries the state revision current when it was accepted", () => {
  const bus = new RuntimeBus({ homeId: "home-1", version: "0.3.0", runtimeId: "runtime-1" })
  const ade = record("PromptQueued", { sequence: 3 })

  bus.publishActivity(ade, ade.instanceId, 1, true)
  const updates: BusUpdate[] = []
  const unsubscribe = bus.subscribe((update) => updates.push(update))
  bus.updateState({ active_agent_id: ade.instanceId, agents: [agent()] }, "lifecycle")
  bus.publishActivity(ade, ade.instanceId, 1, true)
  unsubscribe()
  bus.publishActivity(record("PostTurnEnd", { sequence: 4 }), ade.instanceId, 1, false)

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
  const bus = new RuntimeBus({ homeId: "home-1", version: "0.3.0" })
  let received = 0
  bus.subscribe(() => {
    throw new Error("peer failed")
  })
  bus.subscribe(() => received += 1)
  expect(bus.updateState({ active_agent_id: null, agents: [agent({ active: false })] }, "agent_added")).toBe(true)
  expect(received).toBe(1)
})
