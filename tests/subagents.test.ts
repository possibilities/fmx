import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { displayState, SubagentObserver } from "../src/subagents.ts"
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
})

describe("SubagentObserver", () => {
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
