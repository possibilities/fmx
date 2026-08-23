import { expect, test } from "bun:test"
import { AgentRegistry, displayStateFor, shortSessionId } from "../src/agent-registry.ts"
import { decodeFrame } from "../src/socket-frames.ts"

const SESSION_ID = "1787199707291-1787199707291996000-909bc46b64721838"

let seq = 0

function fold(registry: AgentRegistry, line: string): void {
  registry.apply(decodeFrame(seq++, 0, line))
}

function report(state: string, attention?: string): string {
  const custom = attention ? `,"custom_status":"${attention}"` : ""
  return `{"id":"1","method":"pane.report_agent","params":{"pane_id":"p_1","source":"custom:fx","agent":"fx","state":"${state}"${custom}}}`
}

function registry(): AgentRegistry {
  seq = 1
  return new AgentRegistry()
}

test("folds fx's startup sequence into one record", () => {
  const store = registry()
  fold(
    store,
    `{"id":"1","method":"pane.report_agent_session","params":{"pane_id":"p_1","source":"custom:fx","agent":"fx","agent_session_id":"${SESSION_ID}"}}`,
  )
  fold(store, report("idle"))
  fold(store, '{"id":"3","method":"pane.rename","params":{"pane_id":"p_1","label":"fx"}}')
  fold(store, '{"id":"4","method":"agent.rename","params":{"target":"p_1","name":"fx"}}')

  const record = store.get("p_1")!
  expect(record.sessionId).toBe(SESSION_ID)
  expect(record.state).toBe("idle")
  expect(record.label).toBe("fx")
  expect(record.agentName).toBe("fx")
})

test("keeps the attention kind fx sends with a blocked state", () => {
  const store = registry()
  fold(store, report("blocked", "permission"))
  expect(store.get("p_1")!.attention).toBe("permission")

  fold(store, report("blocked", "recovery"))
  expect(store.get("p_1")!.attention).toBe("recovery")

  fold(store, report("working"))
  expect(store.get("p_1")!.attention).toBeNull()
})

test("ignores an attention value fx does not define", () => {
  const store = registry()
  fold(store, report("blocked", "something-else"))
  expect(store.get("p_1")!.attention).toBeNull()
})

test("advances the state sequence only when the state actually changes", () => {
  const store = registry()
  fold(store, report("working"))
  const first = store.get("p_1")!.stateSeq
  fold(store, report("working"))
  expect(store.get("p_1")!.stateSeq).toBe(first)
  fold(store, report("idle"))
  expect(store.get("p_1")!.stateSeq).toBeGreaterThan(first)
})

test("a released pane drops back to knowing nothing", () => {
  const store = registry()
  fold(store, report("working"))
  fold(
    store,
    '{"id":"9","method":"pane.clear_agent_authority","params":{"pane_id":"p_1","source":"custom:fx"}}',
  )
  expect(store.get("p_1")!.state).toBe("unknown")
  expect(store.get("p_1")!.attention).toBeNull()
})

test("separates a turn finished unwatched from one already seen", () => {
  const store = registry()
  fold(store, report("working"))
  fold(store, report("idle"))
  const record = store.get("p_1")!

  // Nothing acknowledged yet: the turn finished while the human was elsewhere.
  expect(displayStateFor(record, 0)).toBe("done")
  // Acknowledged at the current state: ordinary idle.
  expect(displayStateFor(record, record.stateSeq)).toBe("idle")
})

test("blocked and working outrank whether the pane was seen", () => {
  const store = registry()
  fold(store, report("blocked", "question"))
  expect(displayStateFor(store.get("p_1"), 0)).toBe("blocked")
  fold(store, report("working"))
  expect(displayStateFor(store.get("p_1"), Number.MAX_SAFE_INTEGER)).toBe("working")
})

test("an instance that has never reported is unknown", () => {
  expect(displayStateFor(null, 0)).toBe("unknown")
})

test("forgets a pane once its instance is gone", () => {
  const store = registry()
  fold(store, report("idle"))
  store.forget("p_1")
  expect(store.get("p_1")).toBeNull()
})

test("ignores frames that name no pane or carry no method", () => {
  const store = registry()
  fold(store, '{"id":"1","result":{}}')
  expect(store.get("p_1")).toBeNull()
})

test("shortens a session id to the segment that distinguishes it", () => {
  expect(shortSessionId(SESSION_ID)).toBe("909bc46b64721838")
  expect(shortSessionId(null)).toBeNull()
  // Anything without the expected shape is shown as-is rather than mangled.
  expect(shortSessionId("plain")).toBe("plain")
})

test("seeding a pane after a restart restores the last reported state", () => {
  const registry = new AgentRegistry()
  const seeded = registry.seed("p_a", {
    sessionId: "sess-a",
    state: "idle",
    attention: null,
  })
  expect(seeded).toMatchObject({ sessionId: "sess-a", state: "idle", attention: null })
  expect(displayStateFor(seeded, seeded.stateSeq)).toBe("idle")
  expect(displayStateFor(seeded, seeded.stateSeq - 1)).toBe("done")

  // A pane fx has already reported into is not overwritten by a stale seed.
  registry.seed("p_a", { sessionId: "sess-old", state: "blocked", attention: "question" })
  expect(registry.get("p_a")?.sessionId).toBe("sess-a")
  expect(registry.get("p_a")?.state).toBe("idle")
})

test("a live state change advances beyond a restored state version", () => {
  const store = registry()
  const restored = store.seed("p_1", { sessionId: SESSION_ID, state: "working", attention: null })
  const restoredSeq = restored.stateSeq
  fold(store, report("idle"))
  expect(store.get("p_1")!.stateSeq).toBeGreaterThan(restoredSeq)
})
