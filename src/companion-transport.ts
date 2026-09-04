import { unlink } from "node:fs/promises"
import { CompanionConnection } from "./companion-client.ts"
import { ownedSessionName, type SessionIdentity } from "./session-identity.ts"
import {
  HandlerRelay,
  SessionEndedError,
  SessionUnreachableError,
  type SessionEndpoint,
  type SessionStart,
  type SessionTransport,
  type SessionTransportFactory,
  type TerminalSize,
  type TransportHandlers,
} from "./session-transport.ts"
import { CompanionCreateError, type CompanionCommand, type SessionEntry } from "./zmx-command.ts"
import { ExitReason } from "./zmx-protocol.ts"

/**
 * How much of a Session's terminal the Companion keeps for a restore. In
 * lines, because that is the Companion's unit; the visible terminal's own
 * allowance is 10 MB of bytes, and at ordinary widths this is under half of
 * that, measured.
 */
export const COMPANION_SCROLLBACK_LINES = 50_000
/** How long a session mid-teardown is given to become an exit record. */
const EXIT_RECORD_WAIT_MS = 5000

/**
 * The Companion as a source of Sessions: `create` then a negotiated socket
 * for a new one, a negotiated socket alone for one that is already running.
 * Every session it creates carries the Instance's ownership labels, and
 * every exit it sees consumes the record the daemon leaves, so the next
 * start's adoption has nothing to clean up for a Session that ended while
 * watched.
 */
export class CompanionTransportFactory implements SessionTransportFactory {
  private closed = false

  constructor(
    private readonly companion: CompanionCommand,
    private readonly instanceId: string,
    private readonly options: {
      scrollbackLines?: number
      client?: string
      connect?: typeof connectCompanionSession
    } = {},
  ) {}

  /** fmx is leaving: stop waiting on anything. What is not consumed is the next start's. */
  close(): void {
    this.closed = true
  }

  async start(request: SessionStart): Promise<SessionTransport> {
    const { identity } = request
    let socketPath: string
    try {
      const created = await this.companion.create({
        name: identity.companionName,
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        labels: identity.labels,
        scrollbackLines: this.options.scrollbackLines ?? COMPANION_SCROLLBACK_LINES,
      })
      socketPath = created.socketPath
    } catch (error) {
      // A timeout is the one refusal that may have started the process
      // anyway; what it became is looked up, never assumed. Ended or absent:
      // it is not running, and the start failed. Still starting: it may yet
      // be, and the Session is recovered rather than given up on.
      if (!(error instanceof CompanionCreateError) || !error.sessionMayExist) throw error
      let session: SessionEntry
      try {
        session = await this.companion.settle(identity.companionName, undefined, undefined, () => this.closed)
      } catch (caught) {
        throw new SessionUnreachableError(identity, caught instanceof Error ? caught : new Error(String(caught)))
      }
      if (session.state === "exited" || session.state === "absent") throw error
      if (session.state !== "live" || !session.socketPath || ownedSessionName(session, this.instanceId) !== identity.name) {
        throw new SessionUnreachableError(identity, error)
      }
      socketPath = session.socketPath
    }
    // From here the process is running whatever happens: a failure to reach
    // it is the transport's, and the Session is recovered, never removed.
    try {
      return await this.connect(identity, socketPath, request.size)
    } catch (error) {
      throw new SessionUnreachableError(identity, error instanceof Error ? error : new Error(String(error)))
    }
  }

  async attach(identity: SessionIdentity, size: TerminalSize, endpoint?: SessionEndpoint): Promise<SessionTransport> {
    if (endpoint) {
      try {
        // Ownership is proved on this exact connection, so a path the caller
        // read a moment ago is safe to try before asking again.
        return await this.connectOwned(identity, endpoint.socketPath, size)
      } catch (error) {
        if (error instanceof SessionEndedError) throw error
        // The session may have ended since the caller read it. Inspecting now
        // recovers the exact ended/unreachable classification instead of
        // treating a stale endpoint as truth.
      }
    }

    const session = await this.companion.settle(identity.companionName, undefined, undefined, () => this.closed)
    if (this.closed) throw new Error("fmx is shutting down")
    if (session.state === "exited") {
      await this.companion.forget(identity.companionName).catch(() => {})
      throw new SessionEndedError(identity, session.exit ? { code: session.exit.code, signal: session.exit.signal, reason: session.exit.reason } : null)
    }
    if (session.state === "absent") throw new SessionEndedError(identity, null)
    if (session.state === "refused") {
      // Still refused after the settle window: nothing holds the socket and
      // nothing will. Adoption clears the same thing on the next start.
      if (session.socketPath) await unlink(session.socketPath).catch(() => {})
      throw new SessionEndedError(identity, null)
    }
    if (session.state !== "live" || !session.socketPath) {
      throw new Error(`Companion session ${identity.companionName} is ${session.state}${session.detail ? ` (${session.detail})` : ""}`)
    }
    if (ownedSessionName(session, this.instanceId) !== identity.name) throw new SessionEndedError(identity, null)
    return this.connectOwned(identity, session.socketPath, size)
  }

  private async connect(
    identity: SessionIdentity,
    socketPath: string,
    size: TerminalSize,
    ownership?: Record<string, string>,
  ): Promise<SessionTransport> {
    return (this.options.connect ?? connectCompanionSession)(socketPath, size, {
      client: this.options.client ?? "fmx",
      onExited: () => this.reap(identity),
      ownership,
    })
  }

  /** Connect, then prove that exact daemon still owns the Session before attaching. */
  private async connectOwned(identity: SessionIdentity, socketPath: string, size: TerminalSize): Promise<SessionTransport> {
    try {
      return await this.connect(identity, socketPath, size, identity.labels)
    } catch (error) {
      if (error instanceof CompanionOwnershipError) throw new SessionEndedError(identity, null)
      throw error
    }
  }

  /**
   * The daemon records an exit after it has sent it — after the grace it
   * gives the process group and the reap — so the record is waited for,
   * then consumed. Best effort: a record left behind is the next start's
   * to forget.
   */
  private async reap(identity: SessionIdentity): Promise<void> {
    const deadline = Date.now() + EXIT_RECORD_WAIT_MS
    let session: SessionEntry = await this.companion.inspect(identity.companionName)
    while (session.state !== "exited" && session.state !== "absent" && Date.now() < deadline && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      session = await this.companion.inspect(identity.companionName)
    }
    if (session.state === "exited" && !this.closed) await this.companion.forget(identity.companionName)
  }
}

type CompanionSessionOptions = {
  client?: string
  onExited?: () => Promise<void>
  /** Required labels on this exact connection, checked before Init exposes its terminal. */
  ownership?: Record<string, string>
}

class CompanionOwnershipError extends Error {}

/** Attach a Session transport to its live Companion session. */
export async function connectCompanionSession(
  socketPath: string,
  size: TerminalSize,
  options: CompanionSessionOptions = {},
): Promise<SessionTransport> {
  const connection = await CompanionConnection.connect(socketPath, { client: options.client ?? "fmx" })
  if (options.ownership) {
    let labels: Record<string, string>
    try {
      labels = await connection.labels()
    } catch (error) {
      connection.close()
      throw error
    }
    if (!Object.entries(options.ownership).every(([key, value]) => labels[key] === value)) {
      connection.close()
      throw new CompanionOwnershipError("Companion session ownership changed before attach")
    }
  }
  // Listeners first, then the attach: the restore the daemon answers with must
  // have somewhere to go before it is asked for.
  const transport = new CompanionTransport(connection, options.onExited ?? (async () => {}))
  connection.attach({ rows: size.rows, cols: size.cols })
  return transport
}

const EXIT_REASONS: Record<number, string> = {
  [ExitReason.natural]: "natural",
  [ExitReason.requested]: "requested",
  [ExitReason.daemonFailure]: "daemon_failure",
  [ExitReason.execFailure]: "exec_failure",
}

class CompanionTransport implements SessionTransport {
  private readonly relay = new HandlerRelay()
  private exited = false
  private detached = false

  constructor(
    private readonly connection: CompanionConnection,
    onExited: () => Promise<void>,
  ) {
    connection.onRestoreBegin(() => this.relay.emit((handlers) => handlers.restoreBegin()))
    connection.onOutput((bytes) => this.relay.emit((handlers) => handlers.output(bytes)))
    connection.onReady(() => this.relay.emit((handlers) => handlers.ready()))
    connection.onExit((status) => {
      this.exited = true
      this.relay.emit((handlers) =>
        handlers.exit({
          code: status.code,
          signal: status.signal,
          reason: EXIT_REASONS[status.reason] ?? `reason_${status.reason}`,
        }),
      )
      // The record is the daemon's to write after this; a failure to consume
      // it is not the Session's problem.
      void onExited().catch(() => {})
    })
    connection.onClose((reason) => {
      // A close after Exit is the daemon finishing; a close we asked for is
      // ours. Anything else is the transport going away under a running process.
      if (this.exited || this.detached || reason.kind === "detached") return
      const error = reason.kind === "error" ? reason.error : new Error("the Companion closed the connection")
      this.relay.emit((handlers) => handlers.lost(error))
    })
  }

  bind(handlers: TransportHandlers): void {
    this.relay.bind(handlers)
  }

  write(bytes: Uint8Array): void {
    if (this.connection.isClosed) return
    this.connection.write(bytes)
  }

  resize(size: TerminalSize): void {
    if (this.connection.isClosed) return
    this.connection.resize({ rows: size.rows, cols: size.cols })
  }

  detach(): void {
    if (this.detached) return
    this.detached = true
    this.relay.stop()
    this.connection.detach()
  }
}
