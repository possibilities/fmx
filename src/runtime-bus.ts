import { randomBytes } from "node:crypto"
import type { AdeRecord } from "./ade-events.ts"
import type { BusRuntime, BusState } from "./bus-protocol.ts"

export type BusUpdate =
  | {
      kind: "state"
      stateRevision: number
      cause: string
      state: BusState
    }
  | {
      kind: "activity"
      stateRevision: number
      record: AdeRecord
      agentId: string
      displayId: number
      gapBefore: boolean
    }

export type BusListener = (update: BusUpdate) => void

/** The structural surface Multiplexer publishes onto. */
export type BusPublisher = {
  updateState(state: BusState, cause: string): boolean
  publishActivity(record: AdeRecord, agentId: string, displayId: number, gapBefore: boolean): void
}

export type RuntimeBusOptions = {
  homeId: string
  version: string
  runtimeId?: string
  pid?: number
}

/**
 * One current Runtime projection and its live bus publications. State is
 * retained for a subscription's initial snapshot; activity is never replayed.
 */
export class RuntimeBus implements BusPublisher {
  readonly runtime: BusRuntime
  private listeners = new Set<BusListener>()
  private stateRevision = 0
  private state: BusState = { active_agent_id: null, agents: [] }
  private stateFingerprint = JSON.stringify(this.state)

  constructor(options: RuntimeBusOptions) {
    this.runtime = {
      id: options.runtimeId ?? randomBytes(16).toString("hex"),
      home_id: options.homeId,
      pid: options.pid ?? process.pid,
      version: options.version,
    }
  }

  snapshot(): { stateRevision: number; state: BusState } {
    return { stateRevision: this.stateRevision, state: this.state }
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  updateState(state: BusState, cause: string): boolean {
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

  private emit(update: BusUpdate): void {
    for (const listener of this.listeners) {
      try {
        listener(update)
      } catch {
        // A local Bus listener cannot disturb the Runtime or another connection.
      }
    }
  }
}
