import { expect, test } from "bun:test"
import { AgentRegistry, displayStateFor, shortSessionId } from "../src/agent-registry.ts"
import { record } from "./fixtures/ade-feed.ts"

const SESSION_ID = "1787199707291-1787199707291996000-909bc46b64721838"

test("folds an ADE startup snapshot into one record", () => {
  const store = new AgentRegistry()
  store.apply("p_1", record("FxStarted", { sessionId: SESSION_ID, state: "idle" }))
  expect(store.get("p_1")).toMatchObject({
    paneId: "p_1",
    sessionId: SESSION_ID,
    state: "idle",
    attention: null,
  })
})

test("keeps every ADE attention kind and clears it on resolution", () => {
  const store = new AgentRegistry()
  store.apply("p_1", record("AttentionRequired", { state: "blocked", attention: "permission" }))
  expect(store.get("p_1")?.attention).toBe("permission")
  store.apply("p_1", record("AttentionRequired", { state: "blocked", attention: "route_recovery" }))
  expect(store.get("p_1")?.attention).toBe("route_recovery")
  store.apply("p_1", record("AttentionResolved", { state: "working" }))
  expect(store.get("p_1")?.attention).toBeNull()
})

test("applies snapshots from unknown additive events", () => {
  const store = new AgentRegistry()
  store.apply("p_1", record("FutureEvent", { sessionId: SESSION_ID, state: "blocked", attention: "question" }))
  expect(store.get("p_1")).toMatchObject({ sessionId: SESSION_ID, state: "blocked", attention: "question" })
})

test("advances the state sequence only when lifecycle state changes", () => {
  const store = new AgentRegistry()
  store.apply("p_1", record("PromptQueued", { state: "working" }))
  const first = store.get("p_1")!.stateSeq
  store.apply("p_1", record("PreToolUse", { state: "working" }))
  expect(store.get("p_1")!.stateSeq).toBe(first)
  store.apply("p_1", record("PostTurnEnd", { state: "idle" }))
  expect(store.get("p_1")!.stateSeq).toBeGreaterThan(first)
})

test("FxStopped drops lifecycle authority back to unknown", () => {
  const store = new AgentRegistry()
  store.apply("p_1", record("PromptQueued", { state: "working" }))
  store.apply("p_1", record("FxStopped", { state: "idle" }))
  expect(store.get("p_1")?.state).toBe("unknown")
  expect(store.get("p_1")?.attention).toBeNull()
})

test("separates a turn finished unwatched from one already seen", () => {
  const store = new AgentRegistry()
  store.apply("p_1", record("PromptQueued", { state: "working" }))
  store.apply("p_1", record("PostTurnEnd", { state: "idle" }))
  const current = store.get("p_1")!
  expect(displayStateFor(current, 0)).toBe("done")
  expect(displayStateFor(current, current.stateSeq)).toBe("idle")
})

test("blocked and working outrank whether the Agent was seen", () => {
  const store = new AgentRegistry()
  store.apply("p_1", record("AttentionRequired", { state: "blocked", attention: "question" }))
  expect(displayStateFor(store.get("p_1"), 0)).toBe("blocked")
  store.apply("p_1", record("AttentionResolved", { state: "working" }))
  expect(displayStateFor(store.get("p_1"), Number.MAX_SAFE_INTEGER)).toBe("working")
})

test("an Agent that has never reported is unknown", () => {
  expect(displayStateFor(null, 0)).toBe("unknown")
})

test("forgets a pane id once its Agent is gone", () => {
  const store = new AgentRegistry()
  store.apply("p_1", record("FxStarted"))
  store.forget("p_1")
  expect(store.get("p_1")).toBeNull()
})

test("shortens a session id to the segment that distinguishes it", () => {
  expect(shortSessionId(SESSION_ID)).toBe("909bc46b64721838")
  expect(shortSessionId(null)).toBeNull()
  expect(shortSessionId("plain")).toBe("plain")
})

test("seeding after a restart restores the last ADE snapshot", () => {
  const store = new AgentRegistry()
  const seeded = store.seed("p_a", {
    sessionId: "sess-a",
    state: "idle",
    attention: null,
  })
  expect(seeded).toMatchObject({ sessionId: "sess-a", state: "idle", attention: null })
  expect(displayStateFor(seeded, seeded.stateSeq)).toBe("idle")
  expect(displayStateFor(seeded, seeded.stateSeq - 1)).toBe("done")

  store.seed("p_a", { sessionId: "sess-old", state: "blocked", attention: "question" })
  expect(store.get("p_a")?.sessionId).toBe("sess-a")
  expect(store.get("p_a")?.state).toBe("idle")
})

test("a live snapshot advances beyond a restored state version", () => {
  const store = new AgentRegistry()
  const restored = store.seed("p_1", { sessionId: SESSION_ID, state: "working", attention: null })
  const restoredSeq = restored.stateSeq
  store.apply("p_1", record("PostTurnEnd", { sessionId: SESSION_ID, state: "idle" }))
  expect(store.get("p_1")!.stateSeq).toBeGreaterThan(restoredSeq)
})
