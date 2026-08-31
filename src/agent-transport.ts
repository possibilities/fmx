import type { ManifestEntry } from "./agent-manifest.ts"

/**
 * The terminal seam: what an Agent's renderer needs from whatever holds the
 * fx process and its PTY, and nothing about how it is held. Bytes go in and
 * out, the size follows the terminal, and the two ways it ends are told apart
 * — fx ending, with a status, against the transport itself ending, which says
 * nothing about fx at all.
 *
 * One implementation ships: the Companion's, in `companion-transport.ts`.
 * Tests keep a Bun PTY behind the same seam so the renderer can be exercised
 * without a Companion on the machine.
 */
export interface AgentTransport {
  /**
   * Wire the consumer. Whatever arrived before this call is delivered now,
   * in order, so a transport that was attached before its Agent was
   * listening loses nothing.
   */
  bind(handlers: TransportHandlers): void
  write(bytes: Uint8Array): void
  resize(size: TerminalSize): void
  /** Stop watching. fx keeps running; nothing is sent to it. */
  detach(): void
}

export type TransportHandlers = {
  /** Terminal bytes from fx, restored or live. */
  output(bytes: Uint8Array): void
  /**
   * The transport is about to replay the terminal's state. The terminal
   * resets here, because what follows is the whole state, not a
   * continuation — and it happens on every attach, first or not.
   */
  restoreBegin(): void
  /** The replay is over; every byte after this is live. */
  ready(): void
  /** fx ended with exactly this status. Final output has already been delivered. */
  exit(status: AgentExit): void
  /**
   * The transport ended without an Exit: the connection dropped, the
   * daemon went away. fx may be running still; only asking can tell.
   */
  lost(error: Error): void
}

export type AgentExit = {
  code: number
  /** Non-zero when a signal ended it. */
  signal: number
}

export type TerminalSize = { cols: number; rows: number }

/** Everything needed to start fx for an Agent the Manifest has already claimed. */
export type AgentStart = {
  entry: ManifestEntry
  /** argv, the executable first. */
  command: string[]
  cwd: string
  env: Record<string, string>
  size: TerminalSize
  /**
   * A managed lifecycle replay may follow a lost create response or a crash
   * before its durable stage transition. In that one path, an existing exact
   * owned session is the start result; ordinary starts still reject a name
   * which already exists.
   */
  recoverExisting?: boolean
}

/**
 * Where Agents come from. `start` is the only way fx is ever started;
 * `attach` reaches one that is already running, whether it outlived the
 * fmx that started it or only lost its transport.
 */
export interface AgentTransportFactory {
  /**
   * Start fx and attach to it. Resolves once attached. Rejects with
   * `AgentUnreachableError` when fx was started but could not be
   * attached to — it is running, and the Agent is to be recovered, not
   * removed — and with anything else when fx was not started at all.
   */
  start(request: AgentStart): Promise<AgentTransport>
  /**
   * Attach to a running Agent. Rejects with `AgentEndedError` when
   * fx has ended — with its status, when that is known — and with anything
   * else when it could not be reached, which says nothing about fx.
   */
  attach(entry: ManifestEntry, size: TerminalSize): Promise<AgentTransport>
}

export class AgentEndedError extends Error {
  constructor(
    readonly entry: ManifestEntry,
    /** `null` when the end was observed but its status was not. */
    readonly exit: AgentExit | null,
  ) {
    super(
      exit
        ? `agent ${entry.displayId} ended with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}`
        : `agent ${entry.displayId} is gone`,
    )
  }
}

/** fx is running; only the transport to it failed. */
export class AgentUnreachableError extends Error {
  constructor(
    readonly entry: ManifestEntry,
    readonly cause: Error,
  ) {
    super(`agent ${entry.displayId} is running but could not be reached: ${cause.message}`)
  }
}

/** A session under the expected stable name exists, but is not this Agent's. */
export class AgentStartConflictError extends Error {
  constructor(
    readonly entry: ManifestEntry,
    readonly cause: Error,
  ) {
    super(`agent ${entry.displayId} Companion session is not owned by its managed identity: ${cause.message}`)
  }
}

/** An environment as the transport needs it: every value a string. */
export function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

/**
 * Delivers handler calls in order, holding them until the consumer binds.
 * Shared by the transports so neither reimplements the backlog.
 */
export class HandlerRelay {
  private handlers: TransportHandlers | null = null
  private backlog: ((handlers: TransportHandlers) => void)[] = []
  private stopped = false

  bind(handlers: TransportHandlers): void {
    this.handlers = handlers
    const held = this.backlog
    this.backlog = []
    for (const deliver of held) {
      // A held handler may stop the relay (an Exit detaches); nothing after it goes out.
      if (this.stopped) return
      deliver(handlers)
    }
  }

  /** After this nothing is delivered: the consumer let go. */
  stop(): void {
    this.stopped = true
    this.backlog = []
  }

  emit(deliver: (handlers: TransportHandlers) => void): void {
    if (this.stopped) return
    if (this.handlers) deliver(this.handlers)
    else this.backlog.push(deliver)
  }
}
