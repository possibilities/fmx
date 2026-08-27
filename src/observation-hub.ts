import { randomBytes } from "node:crypto"
import type { AdeRecord } from "./ade-events.ts"
import type { ObservationRuntime, ObservationState } from "./observation-protocol.ts"

export type ObservationUpdate =
  | {
      kind: "state"
      stateRevision: number
      cause: string
      state: ObservationState
    }
  | {
      kind: "activity"
      stateRevision: number
      record: AdeRecord
      agentId: string
      displayId: number
      gapBefore: boolean
    }

export type ObservationListener = (update: ObservationUpdate) => void

/** The structural surface Multiplexer publishes onto. */
export type ObservationSink = {
  updateState(state: ObservationState, cause: string): boolean
  publishActivity(record: AdeRecord, agentId: string, displayId: number, gapBefore: boolean): void
}

export type ObservationHubOptions = {
  homeId: string
  version: string
  runtimeId?: string
  pid?: number
}

/**
 * One current Runtime projection and its live observations. State is retained
 * for a subscriber's initial snapshot; activity is deliberately never replayed.
 */
export class ObservationHub implements ObservationSink {
  readonly runtime: ObservationRuntime
  private listeners = new Set<ObservationListener>()
  private stateRevision = 0
  private state: ObservationState = { active_agent_id: null, agents: [] }
  private stateFingerprint = JSON.stringify(this.state)

  constructor(options: ObservationHubOptions) {
    this.runtime = {
      id: options.runtimeId ?? randomBytes(16).toString("hex"),
      home_id: options.homeId,
      pid: options.pid ?? process.pid,
      version: options.version,
    }
  }

  snapshot(): { stateRevision: number; state: ObservationState } {
    return { stateRevision: this.stateRevision, state: this.state }
  }

  subscribe(listener: ObservationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  updateState(state: ObservationState, cause: string): boolean {
    const fingerprint = JSON.stringify(state)
    if (fingerprint === this.stateFingerprint) return false
    this.state = state
    this.stateFingerprint = fingerprint
    this.stateRevision += 1
    this.emit({ kind: "state", stateRevision: this.stateRevision, cause, state })
    return true
  }

  publishActivity(record: AdeRecord, agentId: string, displayId: number, gapBefore: boolean): void {
    this.emit({
      kind: "activity",
      stateRevision: this.stateRevision,
      record,
      agentId,
      displayId,
      gapBefore,
    })
  }

  private emit(update: ObservationUpdate): void {
    for (const listener of this.listeners) {
      try {
        listener(update)
      } catch {
        // Observation is passive. A local integration cannot disturb the TUI.
      }
    }
  }
}
