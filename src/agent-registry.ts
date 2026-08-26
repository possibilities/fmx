import type { AdeAttentionKind, AdeRecord } from "./ade-events.ts"

/**
 * What fx reports about itself over the ADE feed, folded into one record
 * per pane. Pure: no renderer, no clock, no knowledge of which pane a human is
 * looking at — that belongs to the multiplexer, because fx cannot know it.
 */

/** The four states fx reports. `unknown` also covers "has not reported yet". */
export type AgentState = "idle" | "working" | "blocked" | "unknown"

/** Fx's attention kinds, carried with every blocked ADE snapshot. */
export type AgentAttention = AdeAttentionKind

/**
 * What the row shows. Five values from four states: an idle pane that went
 * idle while the human was elsewhere is `done` — finished and unacknowledged —
 * rather than merely `idle`.
 */
export type DisplayState = "blocked" | "working" | "done" | "idle" | "unknown"

export type AgentRecord = {
  paneId: string
  state: AgentState
  attention: AgentAttention | null
  sessionId: string | null
  /**
   * The registry-local version at the last state change. Compared against
   * the multiplexer's per-agent "seen" version to tell `done` from
   * `idle` without either side needing a clock or a callback into the other.
   */
  stateSeq: number
}

export type AgentSeed = {
  sessionId: string | null
  state: AgentState
  attention: AgentAttention | null
}

export class AgentRegistry {
  private readonly records = new Map<string, AgentRecord>()
  /** Monotonic across live ADE snapshots and restored seeds alike. */
  private nextStateSeq = 1

  /** Fold one schema-1 snapshot into the record for fmx's retained pane id. */
  apply(paneId: string, event: AdeRecord): AgentRecord {
    const record = this.ensure(paneId)
    const state: AgentState = event.event === "FxStopped" ? "unknown" : event.context.agentState
    if (state !== record.state) this.advanceState(record)
    record.state = state
    record.attention = state === "blocked" ? event.context.attentionKind : null
    if (event.context.agentRole === "main") record.sessionId = event.context.sessionId
    return record
  }

  /**
   * What a restart already knows about a pane from the Manifest: the last
   * facts fx reported before fmx detached. They remain true until a newer ADE
   * snapshot says otherwise. A record already updated is left alone.
   */
  seed(paneId: string, seed: AgentSeed): AgentRecord {
    const existing = this.records.get(paneId)
    if (existing) return existing
    const record = this.ensure(paneId)
    record.sessionId = seed.sessionId
    record.state = seed.state
    record.attention = seed.attention
    if (seed.state !== "unknown") this.advanceState(record)
    return record
  }

  get(paneId: string): AgentRecord | null {
    return this.records.get(paneId) ?? null
  }

  /** Install the session identity from the ADE envelope. */
  setSessionId(paneId: string, sessionId: string | null): AgentRecord {
    const record = this.ensure(paneId)
    record.sessionId = sessionId
    return record
  }

  /** Drop a pane's record once its agent is gone. */
  forget(paneId: string): void {
    this.records.delete(paneId)
  }

  private ensure(paneId: string): AgentRecord {
    const existing = this.records.get(paneId)
    if (existing) return existing
    const record: AgentRecord = {
      paneId,
      state: "unknown",
      attention: null,
      sessionId: null,
      stateSeq: 0,
    }
    this.records.set(paneId, record)
    return record
  }

  private advanceState(record: AgentRecord): void {
    record.stateSeq = this.nextStateSeq++
  }
}

/**
 * `seenSeq` is the `stateSeq` this pane had when the human last had it in
 * front of them. An idle pane whose state moved on since then finished
 * unwatched, which is what separates `done` from `idle`.
 */
export function displayStateFor(record: AgentRecord | null, seenSeq: number): DisplayState {
  if (!record) return "unknown"
  switch (record.state) {
    case "blocked":
      return "blocked"
    case "working":
      return "working"
    case "idle":
      return record.stateSeq > seenSeq ? "done" : "idle"
    case "unknown":
      return "unknown"
  }
}

/**
 * fx session ids are `<millis>-<nanos>-<hex>`. The two leading timestamps are
 * near-identical for anything started the same day, so the trailing segment is
 * the only part that tells two sessions apart in a narrow column.
 */
export function shortSessionId(sessionId: string | null): string | null {
  if (!sessionId) return null
  const segments = sessionId.split("-")
  return segments[segments.length - 1] || sessionId
}
