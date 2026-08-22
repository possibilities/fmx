import { watch, type FSWatcher } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentAttention, DisplayState } from "./agent-registry.ts"
import { exclusiveLockHeld } from "./file-lock.ts"
import { fxProfileDirectory, isSessionId } from "./fx-sessions.ts"

const CONTROL_STATES = [
  "idle",
  "queued",
  "running",
  "awaiting_approval",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
  "archived",
] as const

type ControlState = (typeof CONTROL_STATES)[number]

type SubagentRecord = {
  childId: string
  parentId: string
  generation: number
  label: string
  state: ControlState
  createdAt: number
}

type StableState = {
  state: DisplayState
  attention: AgentAttention | null
  pending: string | null
  pendingSamples: number
}

export type SubagentEntry = {
  sessionId: string
  label: string
  state: DisplayState
  attention: AgentAttention | null
  children: SubagentEntry[]
}

export type SubagentObserverOptions = {
  home?: string
  onChange: () => void
  lockProbe?: (path: string) => boolean | null
  pollIntervalMs?: number
  watch?: boolean
}

/**
 * A filesystem projection of fx's subagent store. The Agent socket has no
 * child-scoped lifecycle, so this joins child control records to the full
 * session ids fx already reported for live Instances.
 */
export class SubagentObserver {
  private readonly sessionsDirectory: string
  private readonly onChange: () => void
  private readonly lockProbe: (path: string) => boolean | null
  private readonly pollIntervalMs: number
  private readonly shouldWatch: boolean
  private readonly parents = new Set<string>()
  private records = new Map<string, SubagentRecord>()
  private byParent = new Map<string, SubagentRecord[]>()
  private readonly stableStates = new Map<string, StableState>()
  private readonly childWatchers = new Map<string, FSWatcher>()
  private readonly discoveryTimers = new Set<ReturnType<typeof setTimeout>>()
  private rootWatcher: FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private refreshPromise: Promise<void> | null = null
  private refreshAgain = false
  private started = false
  private stopped = false

  constructor(options: SubagentObserverOptions) {
    const environment = options.home ? { ...process.env, HOME: options.home } : process.env
    this.sessionsDirectory = join(fxProfileDirectory(environment), "sessions")
    this.onChange = options.onChange
    this.lockProbe = options.lockProbe ?? exclusiveLockHeld
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.shouldWatch = options.watch ?? true
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.ensureRootWatcher()
    this.pollTimer = setInterval(() => this.sampleReachableStates(), this.pollIntervalMs)
    if (this.parents.size > 0) void this.refresh()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.rootWatcher?.close()
    this.rootWatcher = null
    for (const watcher of this.childWatchers.values()) watcher.close()
    this.childWatchers.clear()
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
    for (const timer of this.discoveryTimers) clearTimeout(timer)
    this.discoveryTimers.clear()
  }

  /** The live parent sessions whose descendants are worth probing. */
  setParents(sessionIds: Iterable<string>): void {
    const next = new Set([...sessionIds].filter(isSessionId))
    if (sameSet(this.parents, next)) return
    this.parents.clear()
    for (const sessionId of next) this.parents.add(sessionId)
    this.ensureRootWatcher()
    this.syncChildWatchers()
    if (this.parents.size > 0) void this.refresh()
    else if (this.stableStates.size > 0) {
      this.stableStates.clear()
      this.notify()
    }
  }

  childrenOf(parentId: string): SubagentEntry[] {
    return this.childrenOfInner(parentId, new Set())
  }

  /** Full discovery is startup/new-session work, never the one-second tick. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.refreshPromise) {
      this.refreshAgain = true
      return this.refreshPromise
    }
    this.refreshPromise = (async () => {
      do {
        this.refreshAgain = false
        await this.scanAll()
      } while (this.refreshAgain && !this.stopped)
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  /** Exposed so the lock/state reducer stays directly testable. */
  sampleReachableStates(): void {
    if (this.stopped) return
    const reachable = this.reachableChildren()
    let changed = false
    for (const childId of reachable) {
      const record = this.records.get(childId)
      if (!record) continue
      const lock = record.state === "running" ? this.lockProbe(this.lockPath(childId)) : null
      changed = this.acceptSample(record, displayState(record.state, lock)) || changed
    }
    for (const childId of [...this.stableStates.keys()]) {
      if (reachable.has(childId)) continue
      this.stableStates.delete(childId)
      changed = true
    }
    if (changed) this.notify()
  }

  private async scanAll(): Promise<void> {
    this.ensureRootWatcher()
    let directories: string[]
    try {
      directories = (await readdir(this.sessionsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && isSessionId(entry.name))
        .map((entry) => entry.name)
    } catch {
      directories = []
    }

    const scanned = await Promise.all(directories.map((childId) => this.readRecord(childId)))
    const next = new Map<string, SubagentRecord>()
    for (const record of scanned) {
      if (!record) continue
      const current = this.records.get(record.childId)
      next.set(record.childId, current && current.generation > record.generation ? current : record)
    }
    const recordsChanged = !sameRecords(this.records, next)
    this.records = next
    if (recordsChanged) this.rebuildParentIndex()
    this.syncChildWatchers()
    const stateChanged = this.sampleReachableStatesWithoutNotify()
    if (recordsChanged || stateChanged) this.notify()
  }

  private async refreshChild(childId: string): Promise<void> {
    if (this.stopped) return
    const record = await this.readRecord(childId)
    if (!record) return
    const current = this.records.get(childId)
    if (current && current.generation >= record.generation) return
    this.records.set(childId, record)
    this.rebuildParentIndex()
    this.sampleReachableStatesWithoutNotify()
    this.notify()
  }

  private async readRecord(childId: string): Promise<SubagentRecord | null> {
    let value: unknown
    try {
      value = JSON.parse(await readFile(this.controlPath(childId), "utf8"))
    } catch {
      return null
    }
    if (!isRecord(value) || value.child_id !== childId || !isSessionId(childId)) return null
    const parentId = nonEmptyString(value.parent_id)
    const state = CONTROL_STATES.includes(value.state as ControlState) ? (value.state as ControlState) : null
    if (!parentId || !isSessionId(parentId) || !state) return null
    const configuration = isRecord(value.configuration) ? value.configuration : null
    return {
      childId,
      parentId,
      generation: nonNegativeNumber(value.generation) ?? 0,
      label: nonEmptyString(configuration?.name) ?? shortSessionId(childId),
      state,
      createdAt: nonNegativeNumber(value.created_at_ms) ?? 0,
    }
  }

  private rebuildParentIndex(): void {
    const next = new Map<string, SubagentRecord[]>()
    for (const record of this.records.values()) {
      const children = next.get(record.parentId)
      if (children) children.push(record)
      else next.set(record.parentId, [record])
    }
    for (const children of next.values()) {
      children.sort((left, right) => left.createdAt - right.createdAt || left.childId.localeCompare(right.childId))
    }
    this.byParent = next
  }

  private reachableChildren(): Set<string> {
    const reachable = new Set<string>()
    const pending = [...this.parents]
    while (pending.length > 0) {
      const parentId = pending.pop()!
      for (const child of this.byParent.get(parentId) ?? []) {
        if (reachable.has(child.childId)) continue
        reachable.add(child.childId)
        pending.push(child.childId)
      }
    }
    return reachable
  }

  private sampleReachableStatesWithoutNotify(): boolean {
    const reachable = this.reachableChildren()
    let changed = false
    for (const childId of reachable) {
      const record = this.records.get(childId)
      if (!record) continue
      const lock = record.state === "running" ? this.lockProbe(this.lockPath(childId)) : null
      changed = this.acceptSample(record, displayState(record.state, lock)) || changed
    }
    for (const childId of [...this.stableStates.keys()]) {
      if (reachable.has(childId)) continue
      this.stableStates.delete(childId)
      changed = true
    }
    return changed
  }

  private acceptSample(
    record: SubagentRecord,
    candidate: { state: DisplayState; attention: AgentAttention | null },
  ): boolean {
    const current = this.stableStates.get(record.childId)
    if (!current) {
      this.stableStates.set(record.childId, { ...candidate, pending: null, pendingSamples: 0 })
      return true
    }
    const candidateKey = stateKey(candidate.state, candidate.attention)
    const currentKey = stateKey(current.state, current.attention)
    if (candidateKey === currentKey) {
      current.pending = null
      current.pendingSamples = 0
      return false
    }
    if (current.state !== "working" || candidate.state === "working") {
      current.state = candidate.state
      current.attention = candidate.attention
      current.pending = null
      current.pendingSamples = 0
      return true
    }
    if (current.pending === candidateKey) current.pendingSamples += 1
    else {
      current.pending = candidateKey
      current.pendingSamples = 1
    }
    if (current.pendingSamples < 2) return false
    current.state = candidate.state
    current.attention = candidate.attention
    current.pending = null
    current.pendingSamples = 0
    return true
  }

  private childrenOfInner(parentId: string, ancestors: Set<string>): SubagentEntry[] {
    if (ancestors.has(parentId)) return []
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(parentId)
    return (this.byParent.get(parentId) ?? []).map((record) => {
      const stable = this.stableStates.get(record.childId)
      const fallback = displayState(record.state, null)
      return {
        sessionId: record.childId,
        label: record.label,
        state: stable?.state ?? fallback.state,
        attention: stable?.attention ?? fallback.attention,
        children: this.childrenOfInner(record.childId, nextAncestors),
      }
    })
  }

  private ensureRootWatcher(): void {
    if (!this.shouldWatch || !this.started || this.stopped || this.rootWatcher) return
    try {
      this.rootWatcher = watch(this.sessionsDirectory, { persistent: false }, () => {
        // The root reports the new session directory before fx necessarily
        // finishes its subagent files. Two event-driven passes cover both ends
        // without turning the one-second lock tick into a store-wide scan.
        this.scheduleDiscovery(75)
        this.scheduleDiscovery(750)
      })
      this.rootWatcher.on("error", () => {
        this.rootWatcher?.close()
        this.rootWatcher = null
      })
    } catch {
      this.rootWatcher = null
    }
  }

  private scheduleDiscovery(delay: number): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      this.discoveryTimers.delete(timer)
      void this.refresh()
    }, delay)
    this.discoveryTimers.add(timer)
  }

  private syncChildWatchers(): void {
    if (!this.shouldWatch || !this.started || this.stopped) return
    const reachable = this.reachableChildren()
    for (const [childId, watcher] of this.childWatchers) {
      if (reachable.has(childId)) continue
      watcher.close()
      this.childWatchers.delete(childId)
    }
    for (const childId of reachable) {
      if (this.childWatchers.has(childId)) continue
      try {
        const watcher = watch(this.subagentDirectory(childId), { persistent: false }, () => {
          void this.refreshChild(childId)
        })
        watcher.on("error", () => {
          watcher.close()
          this.childWatchers.delete(childId)
        })
        this.childWatchers.set(childId, watcher)
      } catch {
        // A later discovery pass retries a directory that was replaced while
        // watchers were being installed.
      }
    }
  }

  private notify(): void {
    if (!this.stopped) this.onChange()
  }

  private subagentDirectory(childId: string): string {
    return join(this.sessionsDirectory, childId, "subagent")
  }

  private controlPath(childId: string): string {
    return join(this.subagentDirectory(childId), "control.json")
  }

  private lockPath(childId: string): string {
    return join(this.sessionsDirectory, childId, "session.lock")
  }
}

export function displayState(
  state: ControlState,
  lockHeld: boolean | null,
): { state: DisplayState; attention: AgentAttention | null } {
  switch (state) {
    case "queued":
      return { state: "working", attention: null }
    case "running":
      return { state: lockHeld === true ? "working" : "unknown", attention: null }
    case "awaiting_approval":
      return { state: "blocked", attention: "permission" }
    case "completed":
      return { state: "done", attention: null }
    case "idle":
      return { state: "idle", attention: null }
    case "interrupted":
    case "failed":
    case "cancelled":
    case "archived":
      return { state: "unknown", attention: null }
  }
}

function sameRecords(left: Map<string, SubagentRecord>, right: Map<string, SubagentRecord>): boolean {
  if (left.size !== right.size) return false
  for (const [childId, record] of left) {
    const other = right.get(childId)
    if (!other || recordKey(record) !== recordKey(other)) return false
  }
  return true
}

function recordKey(record: SubagentRecord): string {
  return [record.parentId, record.generation, record.label, record.state, record.createdAt].join("\0")
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

function stateKey(state: DisplayState, attention: AgentAttention | null): string {
  return `${state}\0${attention ?? ""}`
}

function shortSessionId(sessionId: string): string {
  const segments = sessionId.split("-")
  return segments[segments.length - 1] || sessionId
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
