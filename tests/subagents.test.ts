import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { displayState, stateFromPhase, SubagentObserver } from "../src/subagents.ts"
import { record } from "./fixtures/ade-feed.ts"

const PARENT = "1787368596567-1787368596567934000-ba9a9f7e16e5ef8c"
const UNRELATED_PARENT = "1787368597000-1787368597000000000-cccccccccccccccc"
const CHILD_A = "1787368609310-1787368609310138000-3e38dc7a8d7c16c2"
const CHILD_B = "1787368610000-1787368610000000000-aaaaaaaaaaaaaaaa"
const GRANDCHILD = "1787368620000-1787368620000000000-bbbbbbbbbbbbbbbb"

type ControlOptions = {
  generation?: number
  name?: string | null
  state?: string
  createdAt?: number
}

async function homeDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fmx-subagents-"))
}

async function writeControl(
  home: string,
  childId: string,
  parentId: string,
  options: ControlOptions = {},
): Promise<void> {
  const directory = join(home, ".fx", "sessions", childId, "subagent")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "control.json"),
    JSON.stringify({
      schema_version: 7,
      child_id: childId,
      parent_id: parentId,
      generation: options.generation ?? 1,
      mode: "persistent",
      configuration: { name: options.name === undefined ? "worker" : options.name },
      state: options.state ?? "idle",
      created_at_ms: options.createdAt ?? 1,
      updated_at_ms: options.createdAt ?? 1,
    }),
  )
}

type RegistryChild = {
  id: string
  agent?: string | null
  phase?: string
  lastOutcome?: string | null
}

/** One parent's children as fx's registry records them. */
async function writeRegistry(
  home: string,
  parentId: string,
  children: RegistryChild[],
  options: { generation?: number; owner?: string } = {},
): Promise<void> {
  const directory = join(home, ".fx", "sessions", parentId, "subagent")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "children.json"),
    JSON.stringify({
      schema_version: 1,
      parent_id: options.owner ?? parentId,
      generation: options.generation ?? 1,
      children: children.map((child) => ({
        id: child.id,
        kind: child.agent ? "persistent" : "one_off",
        persistent: child.agent ? { agent: child.agent, instructions: "do the work" } : null,
        phase: child.phase ?? "idle",
        work_generation: 1,
        active: null,
        last_work_id: null,
        last_request_fingerprint: null,
        last_outcome: child.lastOutcome ?? null,
      })),
    }),
  )
}

/** The file fx wrote beside a retired control record. */
async function writeOwner(home: string, childId: string, parentId: string): Promise<void> {
  const directory = join(home, ".fx", "sessions", childId, "subagent")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "owner.json"), JSON.stringify({ parent_id: parentId }))
}

describe("subagent state projection", () => {
  test("maps fx lifecycle and observed locks onto the Session list states", () => {
    expect(displayState("queued", false)).toEqual({ state: "working", attention: null })
    expect(displayState("running", true)).toEqual({ state: "working", attention: null })
    expect(displayState("running", false)).toEqual({ state: "unknown", attention: null })
    expect(displayState("running", null)).toEqual({ state: "unknown", attention: null })
    expect(displayState("awaiting_approval", false)).toEqual({ state: "blocked", attention: "permission" })
    expect(displayState("completed", false)).toEqual({ state: "done", attention: null })
    expect(displayState("idle", false)).toEqual({ state: "idle", attention: null })
    for (const state of ["interrupted", "failed", "cancelled", "archived"] as const) {
      expect(displayState(state, false)).toEqual({ state: "unknown", attention: null })
    }
  })

  test("narrows the registry's phase to a state the Session list can draw", () => {
    expect(stateFromPhase("idle", null)).toBe("idle")
    expect(stateFromPhase("running", null)).toBe("running")
    expect(stateFromPhase("awaiting_approval", null)).toBe("awaiting_approval")
    expect(stateFromPhase("interrupted", null)).toBe("interrupted")
    expect(stateFromPhase("finished", "completed")).toBe("completed")
    expect(stateFromPhase("finished", "failed")).toBe("failed")
    expect(stateFromPhase("finished", "cancelled")).toBe("cancelled")
    expect(stateFromPhase("finished", "interrupted")).toBe("interrupted")
    // Fx has finished but has not said how: a finished child is a done child.
    expect(stateFromPhase("finished", null)).toBe("completed")
  })
})

describe("SubagentObserver", () => {
  test("restores a parent's children from fx's registry, nesting a child that is a parent in turn", async () => {
    const home = await homeDirectory()
    await writeRegistry(home, PARENT, [
      { id: CHILD_A, agent: "first-worker", phase: "running" },
      { id: CHILD_B, phase: "awaiting_approval" },
    ])
    await writeRegistry(home, CHILD_A, [{ id: GRANDCHILD, agent: "nested-worker", phase: "idle" }])

    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false, lockProbe: () => true })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT)).toEqual([
        {
          sessionId: CHILD_A,
          label: "first-worker",
          state: "working",
          attention: null,
          children: [
            {
              sessionId: GRANDCHILD,
              label: "nested-worker",
              state: "idle",
              attention: null,
              children: [],
            },
          ],
        },
        {
          // A one-off child has no configured name to draw.
          sessionId: CHILD_B,
          label: "aaaaaaaaaaaaaaaa",
          state: "blocked",
          attention: "permission",
          children: [],
        },
      ])
    } finally {
      observer.stop()
    }
  })

  test("restores an awaiting_approval child as blocked on permission", async () => {
    const home = await homeDirectory()
    await writeRegistry(home, PARENT, [{ id: CHILD_A, agent: "reviewer", phase: "awaiting_approval" }])
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT)).toEqual([
        { sessionId: CHILD_A, label: "reviewer", state: "blocked", attention: "permission", children: [] },
      ])
    } finally {
      observer.stop()
    }
  })

  test("leaves a finished child off the screen unless its live feed is still speaking", async () => {
    const home = await homeDirectory()
    await writeRegistry(home, PARENT, [
      { id: CHILD_A, agent: "done-worker", phase: "finished", lastOutcome: "completed" },
      { id: CHILD_B, agent: "idle-worker", phase: "idle" },
    ])
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      // An Agent that ended took its children with it, so a child fx has
      // finished is not restored onto the Session list.
      expect(observer.childrenOf(PARENT).map((child) => child.sessionId)).toEqual([CHILD_B])

      observer.applyAdeRecord(childRecord("TurnStarted", "working"))
      await observer.refresh()
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({
        sessionId: CHILD_A,
        label: "done-worker",
        state: "working",
      })
    } finally {
      observer.stop()
    }
  })

  test("prefers the registry over a control record the session still carries", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { name: "legacy-worker", state: "completed", createdAt: 10 })
    await writeControl(home, CHILD_B, PARENT, { name: "retired-worker", state: "idle", createdAt: 20 })
    await writeRegistry(home, PARENT, [{ id: CHILD_A, agent: "registry-worker", phase: "running" }])

    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false, lockProbe: () => true })
    await observer.setParents([PARENT])
    try {
      // The registry is the file fx maintains: it owns the whole child set,
      // so a control record it does not list is not a second child.
      expect(observer.childrenOf(PARENT)).toEqual([
        { sessionId: CHILD_A, label: "registry-worker", state: "working", attention: null, children: [] },
      ])
    } finally {
      observer.stop()
    }
  })

  test("restores an older session directory from the control records beside its owner file", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { name: "legacy-worker", state: "awaiting_approval" })
    await writeOwner(home, CHILD_A, PARENT)
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT)).toEqual([
        { sessionId: CHILD_A, label: "legacy-worker", state: "blocked", attention: "permission", children: [] },
      ])
    } finally {
      observer.stop()
    }
  })

  test("skips a registry entry it could not draw a row for", async () => {
    const home = await homeDirectory()
    await writeRegistry(home, PARENT, [
      { id: "", agent: "nameless-worker" },
      { id: "../escape", agent: "traversing-worker" },
      { id: CHILD_B, agent: "future-worker", phase: "reticulating" },
      { id: CHILD_A, agent: "session-worker", phase: "idle" },
    ])
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT).map((child) => child.sessionId)).toEqual([CHILD_A])
    } finally {
      observer.stop()
    }
  })

  test("follows a later registry revision", async () => {
    const home = await homeDirectory()
    await mkdir(join(home, ".fx", "sessions"), { recursive: true })
    const observer = new SubagentObserver({ home, onChange: () => {}, pollIntervalMs: 20, lockProbe: () => true })
    observer.start()
    await observer.setParents([PARENT])
    try {
      await writeRegistry(home, PARENT, [{ id: CHILD_A, agent: "worker", phase: "idle" }], { generation: 1 })
      await waitFor(() => observer.childrenOf(PARENT)[0]?.state === "idle")

      await writeRegistry(home, PARENT, [{ id: CHILD_A, agent: "worker", phase: "running" }], { generation: 2 })
      await waitFor(() => observer.childrenOf(PARENT)[0]?.state === "working")
    } finally {
      observer.stop()
    }
  })

  test("joins children to a live parent recursively and preserves creation order", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { name: "first-worker", createdAt: 10 })
    await writeControl(home, CHILD_B, PARENT, { name: "second-worker", state: "awaiting_approval", createdAt: 20 })
    await writeControl(home, GRANDCHILD, CHILD_A, { name: "nested-worker", state: "completed", createdAt: 30 })

    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT)).toEqual([
        {
          sessionId: CHILD_A,
          label: "first-worker",
          state: "idle",
          attention: null,
          children: [
            {
              sessionId: GRANDCHILD,
              label: "nested-worker",
              state: "done",
              attention: null,
              children: [],
            },
          ],
        },
        {
          sessionId: CHILD_B,
          label: "second-worker",
          state: "blocked",
          attention: "permission",
          children: [],
        },
      ])
      expect(observer.childrenOf(CHILD_B)).toEqual([])
    } finally {
      observer.stop()
    }
  })

  test("falls back to the short child id and skips malformed control records", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { name: null })
    const badDirectory = join(home, ".fx", "sessions", CHILD_B, "subagent")
    await mkdir(badDirectory, { recursive: true })
    await writeFile(join(badDirectory, "control.json"), '{"child_id":"wrong","state":"idle"}')

    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT).map((child) => child.label)).toEqual(["3e38dc7a8d7c16c2"])
    } finally {
      observer.stop()
    }
  })

  test("requires two agreeing samples before a working row becomes done", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { state: "running", generation: 1 })
    let held = true
    const observer = new SubagentObserver({
      home,
      onChange: () => {},
      watch: false,
      lockProbe: () => held,
    })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT)[0]?.state).toBe("working")

      held = false
      await writeControl(home, CHILD_A, PARENT, { state: "completed", generation: 2 })
      await observer.refresh()
      expect(observer.childrenOf(PARENT)[0]?.state).toBe("working")

      observer.sampleReachableStates()
      expect(observer.childrenOf(PARENT)[0]?.state).toBe("done")
    } finally {
      observer.stop()
    }
  })

  test("folds live ADE snapshots, including recovery resolution and a skipped transition repair", async () => {
    const home = await homeDirectory()
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      observer.applyAdeRecord(childRecord("TurnStarted", "working"))
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({ state: "working", attention: null })

      observer.applyAdeRecord(childRecord("AttentionRequired", "blocked", "route_recovery"))
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({
        state: "blocked",
        attention: "route_recovery",
      })

      observer.applyAdeRecord(childRecord("AttentionResolved", "working"))
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({ state: "working", attention: null })

      // Pretend PostTurnEnd was dropped. An unrelated later record's context
      // still repairs the row to the idle snapshot, presented as unseen done.
      observer.applyAdeRecord(childRecord("FutureObservation", "idle"))
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({ state: "done", attention: null })

      observer.applyAdeRecord(childRecord("FxStopped", "idle"))
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({ state: "unknown", attention: null })
    } finally {
      observer.stop()
    }
  })

  test("does not let filesystem polling overwrite live ADE state", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { name: "durable-worker", state: "completed" })
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({ state: "done", label: "durable-worker" })

      observer.applyAdeRecord(childRecord("TurnStarted", "working"))
      observer.sampleReachableStates()
      await observer.refresh()
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({ state: "working", label: "durable-worker" })
    } finally {
      observer.stop()
    }
  })

  test("replaces an ADE fallback label when control metadata becomes durable", async () => {
    const home = await homeDirectory()
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      observer.applyAdeRecord(childRecord("TurnStarted", "working"))
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({
        label: "3e38dc7a8d7c16c2",
        state: "working",
      })

      await writeControl(home, CHILD_A, PARENT, { name: "configured-worker", state: "completed" })
      await observer.refresh()
      expect(observer.childrenOf(PARENT)[0]).toMatchObject({
        label: "configured-worker",
        state: "working",
      })
    } finally {
      observer.stop()
    }
  })

  test("probes locks only for children reachable from live parent sessions", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { state: "running" })
    await writeControl(home, CHILD_B, UNRELATED_PARENT, { state: "running" })
    const paths: string[] = []
    const observer = new SubagentObserver({
      home,
      onChange: () => {},
      watch: false,
      lockProbe: (path) => {
        paths.push(path)
        return true
      },
    })
    await observer.setParents([PARENT])
    try {
      expect(paths.length).toBeGreaterThan(0)
      expect(paths.every((path) => path.includes(CHILD_A))).toBe(true)
    } finally {
      observer.stop()
    }
  })

  test("discovers new session directories and follows later control replacements", async () => {
    const home = await homeDirectory()
    await mkdir(join(home, ".fx", "sessions"), { recursive: true })
    const observer = new SubagentObserver({ home, onChange: () => {}, pollIntervalMs: 20 })
    observer.start()
    await observer.setParents([PARENT])
    try {
      await writeControl(home, CHILD_A, PARENT, { state: "idle", generation: 1 })
      await waitFor(() => observer.childrenOf(PARENT)[0]?.state === "idle")

      await writeControl(home, CHILD_A, PARENT, { state: "completed", generation: 2 })
      await waitFor(() => observer.childrenOf(PARENT)[0]?.state === "done")
    } finally {
      observer.stop()
    }
  })

  test("joining an unchanged parent set awaits one discovery without queuing another", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT)
    class CountingObserver extends SubagentObserver {
      refreshCalls = 0

      override refresh(): Promise<void> {
        this.refreshCalls += 1
        return super.refresh()
      }
    }
    const observer = new CountingObserver({ home, onChange: () => {}, watch: false })
    try {
      const discovery = observer.setParents([PARENT])
      const joined = observer.setParents([PARENT])
      await Promise.all([discovery, joined])
      expect(observer.refreshCalls).toBe(1)
      expect(observer.childrenOf(PARENT)).toHaveLength(1)
    } finally {
      observer.stop()
    }
  })

  test("drops a live child once its parent is no longer tracked", async () => {
    const home = await homeDirectory()
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      observer.applyAdeRecord(childRecord("TurnStarted", "working"))
      expect(observer.childrenOf(PARENT)).toHaveLength(1)

      // The Agent ended: a subagent exists only under a parent fmx tracks.
      await observer.setParents([])
      observer.sampleReachableStates()
      expect(observer.childrenOf(PARENT)).toEqual([])

      // And it does not come back when that session is tracked again.
      await observer.setParents([PARENT])
      expect(observer.childrenOf(PARENT)).toEqual([])
    } finally {
      observer.stop()
    }
  })

  test("keeps Fx's own parent when a live capture names a superseded session", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { state: "running" })
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT, UNRELATED_PARENT])
    try {
      // A child's ADE attribution is captured with its work, so after `/new`
      // it can name the session fx has already rebound the child away from.
      observer.applyAdeRecord(
        record("TurnStarted", {
          role: "subagent",
          sessionId: CHILD_A,
          parentSessionId: UNRELATED_PARENT,
          state: "working",
        }),
      )
      expect(observer.childrenOf(UNRELATED_PARENT)).toEqual([])
      expect(observer.childrenOf(PARENT).map((child) => child.state)).toEqual(["working"])
    } finally {
      observer.stop()
    }
  })

  test("screens a configured child name before it becomes row text", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { name: "review\u001b[31mer\u0007" })
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT)[0]?.label).toBe("review[31mer")
    } finally {
      observer.stop()
    }
  })

  test("falls back to the short session id when a name has nothing to draw", async () => {
    const home = await homeDirectory()
    await writeControl(home, CHILD_A, PARENT, { name: "\u001b\u0007" })
    const observer = new SubagentObserver({ home, onChange: () => {}, watch: false })
    await observer.setParents([PARENT])
    try {
      expect(observer.childrenOf(PARENT)[0]?.label).toBe("3e38dc7a8d7c16c2")
    } finally {
      observer.stop()
    }
  })
})

function childRecord(
  event: string,
  state: "idle" | "working" | "blocked",
  attention: "permission" | "question" | "route_recovery" | null = null,
) {
  return record(event, {
    role: "subagent",
    sessionId: CHILD_A,
    parentSessionId: PARENT,
    state,
    attention,
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
}
