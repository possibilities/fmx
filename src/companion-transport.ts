import { unlink } from "node:fs/promises"
import { CompanionConnection } from "./companion-client.ts"
import type { ManifestEntry } from "./instance-manifest.ts"
import { ownedInstanceId, ownershipLabels } from "./instance-reconcile.ts"
import {
  HandlerRelay,
  InstanceEndedError,
  InstanceUnreachableError,
  type InstanceLaunch,
  type InstanceTransport,
  type InstanceTransportFactory,
  type TerminalTransport,
  type TerminalSize,
  type TransportHandlers,
} from "./instance-transport.ts"
import { CompanionCreateError, type CompanionCommand, type SessionEntry } from "./zmx-command.ts"

/**
 * How much of an Instance's terminal the Companion keeps for a restore. In
 * lines, because that is the Companion's unit; the visible terminal's own
 * allowance is 10 MB of bytes, and at the widths fx draws at this is under
 * half of that, measured.
 */
export const COMPANION_SCROLLBACK_LINES = 50_000
/** How long a session mid-teardown is given to become an exit record. */
const EXIT_RECORD_WAIT_MS = 5000

/**
 * The Companion as a source of Instances: `create` then a negotiated socket
 * for a new one, a negotiated socket alone for one that is already running.
 * Every session it creates carries the Home's ownership labels, and every
 * exit it sees consumes the record the daemon leaves, so the next start's
 * join has nothing to clean up for an Instance that ended while watched.
 */
export class CompanionTransportFactory implements InstanceTransportFactory {
  private closed = false

  constructor(
    private readonly companion: CompanionCommand,
    private readonly homeId: string,
    private readonly options: { scrollbackLines?: number; client?: string } = {},
  ) {}

  /** fmx is leaving: stop waiting on anything. What is not consumed is the next start's. */
  close(): void {
    this.closed = true
  }

  async start(launch: InstanceLaunch): Promise<InstanceTransport> {
    const { entry } = launch
    let socketPath: string
    try {
      const created = await this.companion.create({
        name: entry.zmxName,
        command: launch.command,
        cwd: launch.cwd,
        env: launch.env,
        labels: ownershipLabels(this.homeId, entry.instanceId),
        scrollbackLines: this.options.scrollbackLines ?? COMPANION_SCROLLBACK_LINES,
      })
      socketPath = created.socketPath
    } catch (error) {
      // A timeout is the one refusal that may have started fx anyway; what
      // it became is looked up, never assumed. Ended or absent: fx is not
      // running, and the start failed. Still starting: it may yet be, and
      // the Instance is recovered rather than given up on.
      if (!(error instanceof CompanionCreateError) || !error.sessionMayExist) throw error
      const session = await this.companion.settle(entry.zmxName, undefined, undefined, () => this.closed)
      if (session.state === "exited" || session.state === "absent") throw error
      if (session.state !== "live" || !session.socketPath || ownedInstanceId(session, this.homeId) !== entry.instanceId) {
        throw new InstanceUnreachableError(entry, error)
      }
      socketPath = session.socketPath
    }
    // From here fx is running whatever happens: a failure to reach it is
    // the transport's, and the Instance is recovered, never removed.
    try {
      return await this.connect(entry, socketPath, launch.size)
    } catch (error) {
      throw new InstanceUnreachableError(entry, error instanceof Error ? error : new Error(String(error)))
    }
  }

  async attach(entry: ManifestEntry, size: TerminalSize): Promise<InstanceTransport> {
    const session = await this.companion.settle(entry.zmxName, undefined, undefined, () => this.closed)
    if (this.closed) throw new Error("fmx is shutting down")
    if (session.state === "exited") {
      await this.companion.forget(entry.zmxName).catch(() => {})
      throw new InstanceEndedError(entry, session.exit ? { code: session.exit.code, signal: session.exit.signal } : null)
    }
    if (session.state === "absent") throw new InstanceEndedError(entry, null)
    if (session.state === "refused") {
      // Still refused after the settle window: nothing holds the socket and
      // nothing will. The join clears the same thing on the next start; a
      // record, if the daemon got to write one, is consumed there too.
      if (session.socketPath) await unlink(session.socketPath).catch(() => {})
      throw new InstanceEndedError(entry, null)
    }
    if (session.state !== "live" || !session.socketPath) {
      throw new Error(`Companion session ${entry.zmxName} is ${session.state}${session.detail ? ` (${session.detail})` : ""}`)
    }
    return this.connect(entry, session.socketPath, size)
  }

  private async connect(entry: ManifestEntry, socketPath: string, size: TerminalSize): Promise<InstanceTransport> {
    return connectCompanionTerminal(socketPath, size, {
      client: this.options.client ?? "fmx",
      onExited: () => this.reap(entry),
    })
  }

  /**
   * The daemon records an exit after it has sent it — after the grace it
   * gives the process group and the reap — so the record is waited for,
   * then consumed. Best effort: a record left behind is the join's to
   * forget on the next start.
   */
  private async reap(entry: ManifestEntry): Promise<void> {
    const deadline = Date.now() + EXIT_RECORD_WAIT_MS
    let session: SessionEntry = await this.companion.inspect(entry.zmxName)
    while (session.state !== "exited" && session.state !== "absent" && Date.now() < deadline && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      session = await this.companion.inspect(entry.zmxName)
    }
    if (session.state === "exited" && !this.closed) await this.companion.forget(entry.zmxName)
  }
}

export type CompanionTerminalOptions = {
  client?: string
  onExited?: () => Promise<void>
}

/** Attach the shared terminal transport to any live Companion session. */
export async function connectCompanionTerminal(
  socketPath: string,
  size: TerminalSize,
  options: CompanionTerminalOptions = {},
): Promise<TerminalTransport> {
  const connection = await CompanionConnection.connect(socketPath, { client: options.client ?? "fmx" })
  // Listeners first, then the attach: the restore the daemon answers with must
  // have somewhere to go before it is asked for.
  const transport = new CompanionTransport(connection, options.onExited ?? (async () => {}))
  connection.attach({ rows: size.rows, cols: size.cols })
  return transport
}

class CompanionTransport implements TerminalTransport {
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
      this.relay.emit((handlers) => handlers.exit({ code: status.code, signal: status.signal }))
      // The record is the daemon's to write after this; a failure to consume
      // it is not the Instance's problem.
      void onExited().catch(() => {})
    })
    connection.onClose((reason) => {
      // A close after Exit is the daemon finishing; a close we asked for is
      // ours. Anything else is the transport going away under a running fx.
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
