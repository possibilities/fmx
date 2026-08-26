import type {
  AdeAgentRole,
  AdeAgentState,
  AdeAttentionKind,
  AdeEventListener,
  AdeRecord,
} from "../../src/ade-events.ts"

type MainOptions = {
  sessionId?: string | null
  state?: AdeAgentState
  attention?: AdeAttentionKind | null
  payload?: Record<string, unknown>
}

type ChildOptions = MainOptions & {
  parentSessionId: string
  sessionId: string
}

/** Synchronous ADE surface for Multiplexer unit tests. */
export class TestAdeSocket {
  readonly path: string
  private readonly listeners = new Set<AdeEventListener>()
  private readonly sequences = new Map<string, number>()
  private readonly mainContexts = new Map<string, {
    sessionId: string | null
    state: AdeAgentState
    attention: AdeAttentionKind | null
  }>()

  constructor(path = `/tmp/fmx-test-${process.pid}.ade.sock`) {
    this.path = path
  }

  addEventListener(listener: AdeEventListener): void {
    this.listeners.add(listener)
  }

  main(paneId: string, event: string, options: MainOptions = {}): AdeRecord {
    const instanceId = instanceIdForPane(paneId)
    const previous = this.mainContexts.get(instanceId) ?? {
      sessionId: null,
      state: "idle" as const,
      attention: null,
    }
    const state = options.state ?? defaultState(event, previous.state)
    const attention = state === "blocked" ? (options.attention ?? previous.attention) : null
    const context = {
      sessionId: options.sessionId === undefined ? previous.sessionId : options.sessionId,
      state,
      attention,
    }
    this.mainContexts.set(instanceId, context)
    return this.emit({
      schemaVersion: 1,
      sequence: this.nextSequence(instanceId),
      event,
      instanceId,
      context: {
        agentRole: "main",
        sessionId: context.sessionId,
        parentSessionId: null,
        agentState: state,
        attentionKind: attention,
      },
      payload: options.payload ?? {},
    })
  }

  child(paneId: string, event: string, options: ChildOptions): AdeRecord {
    const instanceId = instanceIdForPane(paneId)
    const state = options.state ?? defaultState(event, "idle")
    const attention = state === "blocked" ? (options.attention ?? null) : null
    return this.emit({
      schemaVersion: 1,
      sequence: this.nextSequence(instanceId),
      event,
      instanceId,
      context: {
        agentRole: "subagent",
        sessionId: options.sessionId,
        parentSessionId: options.parentSessionId,
        agentState: state,
        attentionKind: attention,
      },
      payload: options.payload ?? {},
    })
  }

  emit(record: AdeRecord): AdeRecord {
    for (const listener of this.listeners) listener(record)
    return record
  }

  private nextSequence(instanceId: string): number {
    const next = (this.sequences.get(instanceId) ?? 0) + 1
    this.sequences.set(instanceId, next)
    return next
  }
}

export function instanceIdForPane(paneId: string): string {
  if (!paneId.startsWith("p_") || paneId.length <= 2) throw new Error(`invalid pane id: ${paneId}`)
  return paneId.slice(2)
}

export function record(
  event: string,
  options: {
    sequence?: number
    instanceId?: string
    role?: AdeAgentRole
    sessionId?: string | null
    parentSessionId?: string | null
    state?: AdeAgentState
    attention?: AdeAttentionKind | null
    payload?: Record<string, unknown>
  } = {},
): AdeRecord {
  const state = options.state ?? defaultState(event, "idle")
  return {
    schemaVersion: 1,
    sequence: options.sequence ?? 1,
    event,
    instanceId: options.instanceId ?? "0123456789abcdef0123456789abcdef",
    context: {
      agentRole: options.role ?? "main",
      sessionId: options.sessionId ?? null,
      parentSessionId: options.parentSessionId ?? null,
      agentState: state,
      attentionKind: state === "blocked" ? (options.attention ?? null) : null,
    },
    payload: options.payload ?? {},
  }
}

function defaultState(event: string, previous: AdeAgentState): AdeAgentState {
  switch (event) {
    case "PromptQueued":
    case "TurnStarted":
    case "AttentionResolved":
      return "working"
    case "AttentionRequired":
      return "blocked"
    case "PostTurnEnd":
    case "FxStarted":
    case "FxStopped":
      return "idle"
    default:
      return previous
  }
}
