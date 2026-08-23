import type { SocketFrame } from "./socket-frames.ts"

/**
 * What fx reports about itself over the agent socket, folded into one record
 * per pane. Pure: no renderer, no clock, no knowledge of which pane a human is
 * looking at — that belongs to the multiplexer, because fx cannot know it.
 */

/** The four states fx reports. `unknown` also covers "has not reported yet". */
export type AgentState = "idle" | "working" | "blocked" | "unknown"

/** fx's attention kinds, sent as `custom_status` alongside a blocked state. */
export type AgentAttention = "permission" | "question" | "recovery"

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
  label: string | null
  agentName: string | null
  /**
   * The frame sequence at the last state change. Compared against the
   * multiplexer's per-instance "seen" sequence to tell `done` from `idle`
   * without either side needing a clock or a callback into the other.
   */
  stateSeq: number
}

const ATTENTION_VALUES: readonly string[] = ["permission", "question", "recovery"]

export class AgentRegistry {
  private readonly records = new Map<string, AgentRecord>()

  /** Fold one of fx's frames into the record for its pane. */
  apply(frame: SocketFrame): void {
    if (frame.malformed || !frame.paneId || !frame.method) return
    const params = readParams(frame)
    if (!params) return
    const record = this.ensure(frame.paneId)

    switch (frame.method) {
      case "pane.report_agent": {
        const state = readState(params.state)
        if (state !== record.state) record.stateSeq = frame.seq
        record.state = state
        record.attention = readAttention(params.custom_status)
        return
      }
      case "pane.report_agent_session":
        record.sessionId = readString(params.agent_session_id)
        return
      case "pane.rename":
        record.label = readString(params.label)
        return
      case "agent.rename":
        record.agentName = readString(params.name)
        return
      case "pane.clear_agent_authority":
        // fx is releasing the pane on its way out. Nothing it said still
        // stands, so the record drops back to knowing nothing.
        record.state = "unknown"
        record.attention = null
        record.stateSeq = frame.seq
        return
      default:
        return
    }
  }

  /**
   * What a restart already knows about a pane from the Manifest: its fx
   * session id. The state stays `unknown` and nothing needs attention —
   * durability of the PTY says nothing about what fx is doing in it — until
   * fx's next frame says otherwise. A record fx has already reported into is
   * left alone.
   */
  seed(paneId: string, sessionId: string | null): void {
    if (this.records.has(paneId)) return
    const record = this.ensure(paneId)
    record.sessionId = sessionId
  }

  get(paneId: string): AgentRecord | null {
    return this.records.get(paneId) ?? null
  }

  /** Drop a pane's record once its instance is gone. */
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
      label: null,
      agentName: null,
      stateSeq: 0,
    }
    this.records.set(paneId, record)
    return record
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

function readParams(frame: SocketFrame): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(frame.payload)
    if (parsed === null || typeof parsed !== "object") return null
    const params = (parsed as Record<string, unknown>).params
    if (params === null || typeof params !== "object" || Array.isArray(params)) return null
    return params as Record<string, unknown>
  } catch {
    return null
  }
}

function readState(value: unknown): AgentState {
  return value === "idle" || value === "working" || value === "blocked" ? value : "unknown"
}

function readAttention(value: unknown): AgentAttention | null {
  return typeof value === "string" && ATTENTION_VALUES.includes(value)
    ? (value as AgentAttention)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}
