import { createHash } from "node:crypto"
import { unlink } from "node:fs/promises"
import { connectCompanionTerminal, COMPANION_SCROLLBACK_LINES } from "./companion-transport.ts"
import { isPanelId, type PanelDefinition } from "./config.ts"
import { createPanelEnvironment } from "./fx-environment.ts"
import { OWNER_LABEL } from "./agent-reconcile.ts"
import {
  HandlerRelay,
  stringEnvironment,
  type TerminalSize,
  type TerminalTransport,
  type TransportHandlers,
} from "./agent-transport.ts"
import { CompanionCreateError, type CompanionCommand, type SessionEntry } from "./zmx-command.ts"

const PANEL_SESSION_PREFIX = "fmxp"
const PANEL_SESSION_KIND = "panel"
const PANEL_FINGERPRINT_LENGTH = 12
const PANEL_ID_FINGERPRINT_LENGTH = 12
const EXIT_RECORD_WAIT_MS = 5_000
const RETIREMENT_WINDOW_MS = 30_000
const RETIREMENT_INITIAL_POLL_MS = 100
const RETIREMENT_MAX_POLL_MS = 2_000

export type PanelContext = {
  /** Stable Manifest identity, used in the Companion session name. */
  agentId: string
  /** Human-facing Agent number, exported to the tool. */
  displayId: number
  cwd: string
}

export type PanelSessionIdentity = {
  name: string
  agentId: string
  fingerprint: string
  labels: Record<string, string>
}

export type PanelReconcileOutcome = {
  kept: string[]
  stopped: string[]
  forgotten: string[]
  unresolved: string[]
  ignored: string[]
}

export interface PanelSessionController {
  open(definition: PanelDefinition, context: PanelContext, size: TerminalSize): Promise<TerminalTransport>
  stopAgent(agentId: string): Promise<void>
  close(): void
}

type PanelSessionOptions = {
  parentEnvironment?: NodeJS.ProcessEnv
  scrollbackLines?: number
  client?: string
}

type Retirement = {
  promise: Promise<void>
  waitThroughAbsent: boolean
}

/**
 * Starts configured tools either in a local PTY or in a deterministic
 * Companion session. Persistent identity includes the command fingerprint, so
 * editing argv creates the new tool rather than attaching to stale behavior.
 */
export class CompanionPanelSessions implements PanelSessionController {
  private closed = false
  /** An Agent identity is never reused. Marking an ended one prevents an
   * in-flight create from leaving a persistent tool behind after its owner. */
  private readonly stoppedAgents = new Set<string>()
  private readonly retirements = new Map<string, Retirement>()

  constructor(
    private readonly companion: CompanionCommand,
    private readonly homeId: string,
    private readonly controlSocketPath: string | null,
    private readonly definitions: readonly PanelDefinition[],
    private readonly options: PanelSessionOptions = {},
  ) {}

  close(): void {
    this.closed = true
  }

  async open(definition: PanelDefinition, context: PanelContext, size: TerminalSize): Promise<TerminalTransport> {
    this.assertActive(context.agentId)
    const environment = stringEnvironment(
      createPanelEnvironment(
        this.options.parentEnvironment ?? process.env,
        context.displayId,
        context.cwd,
        this.controlSocketPath,
        definition.id,
      ),
    )
    if (!definition.persistent) {
      return new LocalPanelTransport(definition.command, context.cwd, environment, size)
    }

    const identity = panelSessionIdentity(this.homeId, context.agentId, definition)
    let session = await this.companion.settle(identity.name, undefined, undefined, () => this.closed)
    this.assertActive(context.agentId)
    if (session.state === "live") return this.attachOwned(identity, session, size)
    if (session.state === "exited") {
      if (!ownedPanelSession(session, identity)) {
        throw new Error(`Companion session ${identity.name} does not belong to this tools panel`)
      }
      await this.companion.forget(identity.name)
      this.assertActive(context.agentId)
    } else if (session.state === "refused" || session.state === "unreachable") {
      throw new Error(`tools panel ${definition.id} is unreachable${session.detail ? ` (${session.detail})` : ""}`)
    }

    let socketPath: string
    try {
      const created = await this.companion.create({
        name: identity.name,
        command: definition.command,
        cwd: context.cwd,
        env: environment,
        labels: identity.labels,
        scrollbackLines: this.options.scrollbackLines ?? COMPANION_SCROLLBACK_LINES,
      })
      socketPath = created.socketPath
    } catch (error) {
      if (!(error instanceof CompanionCreateError) || !error.sessionMayExist) throw error
      try {
        session = await this.companion.settle(identity.name, undefined, undefined, () => this.closed)
      } catch (settleError) {
        if (this.stoppedAgents.has(context.agentId)) this.scheduleRetirement(identity, true)
        if (this.closed) throw new Error("fmx is shutting down")
        throw settleError
      }
      if (this.stoppedAgents.has(context.agentId)) {
        if (session.state === "live" && ownedPanelSession(session, identity)) {
          await this.stopAndForget(identity.name)
        } else if (session.state === "exited" && ownedPanelSession(session, identity)) {
          await this.companion.forget(identity.name).catch(() => {})
        } else if (session.state !== "exited") {
          this.scheduleRetirement(identity, true)
        }
        throw new Error(`Agent ${context.displayId} has ended`)
      }
      if (this.closed) throw new Error("fmx is shutting down")
      if (session.state !== "live") throw error
      return this.attachOwned(identity, session, size)
    }
    if (this.stoppedAgents.has(context.agentId)) {
      await this.stopAndForget(identity.name)
      throw new Error(`Agent ${context.displayId} has ended`)
    }
    return connectCompanionTerminal(socketPath, size, {
      client: this.options.client ?? "fmx-panel",
      onExited: () => this.reap(identity.name),
    })
  }

  /** End every persistent tool belonging to an Agent that definitely ended. */
  async stopAgent(agentId: string): Promise<void> {
    this.stoppedAgents.add(agentId)
    await Promise.all(
      this.definitions
        .filter((definition) => definition.persistent)
        .map(async (definition) => {
          const identity = panelSessionIdentity(this.homeId, agentId, definition)
          let session: SessionEntry
          try {
            session = await this.companion.inspect(identity.name)
          } catch {
            this.scheduleRetirement(identity, true)
            return
          }
          if (session.state === "live" && ownedPanelSession(session, identity)) {
            await this.stopAndForget(identity.name)
          } else if (session.state === "exited" && ownedPanelSession(session, identity)) {
            await this.companion.forget(identity.name).catch(() => {})
          } else if (session.state === "refused" || session.state === "unreachable") {
            this.scheduleRetirement(identity, false)
          }
        }),
    )
  }

  /**
   * Remove sessions whose Agent or panel definition no longer exists. Live
   * sessions are touched only when their full ownership labels agree.
   */
  async reconcile(agentIds: readonly string[]): Promise<PanelReconcileOutcome> {
    const outcome: PanelReconcileOutcome = { kept: [], stopped: [], forgotten: [], unresolved: [], ignored: [] }
    const expected = new Map<string, PanelSessionIdentity>()
    for (const agentId of agentIds) {
      for (const definition of this.definitions) {
        if (!definition.persistent) continue
        const identity = panelSessionIdentity(this.homeId, agentId, definition)
        expected.set(identity.name, identity)
      }
    }

    for (const session of await this.companion.list()) {
      const parsed = parsePanelSessionName(session.name)
      if (!parsed || parsed.homeId !== this.homeId) continue
      const identity = expected.get(session.name)
      if (identity) {
        if (session.state === "live") {
          if (ownedPanelSession(session, identity)) outcome.kept.push(session.name)
          else outcome.ignored.push(session.name)
        } else if (session.state === "exited") {
          if (ownedPanelSession(session, identity)) {
            await this.companion.forget(session.name).catch(() => {})
            outcome.forgotten.push(session.name)
          } else {
            outcome.ignored.push(session.name)
          }
        } else if (session.state === "unreachable") {
          outcome.unresolved.push(session.name)
        } else if (session.state === "refused") {
          outcome.unresolved.push(session.name)
        }
        continue
      }

      if (session.state === "live" && ownedPanelSessionForHome(session, this.homeId)) {
        await this.stopAndForget(session.name)
        outcome.stopped.push(session.name)
      } else if (session.state === "exited" && ownedPanelSessionForHome(session, this.homeId)) {
        await this.companion.forget(session.name).catch(() => {})
        outcome.forgotten.push(session.name)
      } else if (session.state === "refused" || session.state === "unreachable") {
        outcome.unresolved.push(session.name)
      } else {
        outcome.ignored.push(session.name)
      }
    }
    return outcome
  }

  private attachOwned(
    identity: PanelSessionIdentity,
    session: SessionEntry,
    size: TerminalSize,
  ): Promise<TerminalTransport> {
    if (!ownedPanelSession(session, identity)) {
      throw new Error(`Companion session ${identity.name} does not belong to this tools panel`)
    }
    if (!session.socketPath) throw new Error(`Companion session ${identity.name} has no terminal socket`)
    return connectCompanionTerminal(session.socketPath, size, {
      client: this.options.client ?? "fmx-panel",
      onExited: () => this.reap(identity.name),
    })
  }

  private async stopAndForget(name: string): Promise<void> {
    await this.companion.kill(name).catch(() => {})
    const session = await this.companion.settle(name, EXIT_RECORD_WAIT_MS, undefined, () => this.closed).catch(() => null)
    if (session?.state === "exited") await this.companion.forget(name).catch(() => {})
    else if (session?.state === "refused" && session.socketPath) await unlink(session.socketPath).catch(() => {})
  }

  private async reap(name: string): Promise<void> {
    if (this.closed) return
    const session = await this.companion.settle(name, EXIT_RECORD_WAIT_MS, undefined, () => this.closed)
    if (!this.closed && session.state === "exited") await this.companion.forget(name)
  }

  /** A timed-out create may materialize after its first inspection. Keep a
   * tombstoned identity under observation until it is safe to end or fmx
   * detaches, when startup reconciliation takes over. */
  private scheduleRetirement(identity: PanelSessionIdentity, waitThroughAbsent: boolean): void {
    const existing = this.retirements.get(identity.name)
    if (existing) {
      existing.waitThroughAbsent ||= waitThroughAbsent
      return
    }
    const retirement: Retirement = { promise: Promise.resolve(), waitThroughAbsent }
    retirement.promise = this.retireWhenSettled(identity, retirement)
      .catch(() => {})
      .finally(() => {
        if (this.retirements.get(identity.name) === retirement) this.retirements.delete(identity.name)
      })
    this.retirements.set(identity.name, retirement)
  }

  private async retireWhenSettled(identity: PanelSessionIdentity, retirement: Retirement): Promise<void> {
    const deadline = Date.now() + RETIREMENT_WINDOW_MS
    let delayMs = RETIREMENT_INITIAL_POLL_MS
    while (!this.closed && this.stoppedAgents.has(identity.agentId) && Date.now() < deadline) {
      let session: SessionEntry
      try {
        session = await this.companion.inspect(identity.name)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        delayMs = Math.min(RETIREMENT_MAX_POLL_MS, delayMs * 2)
        continue
      }
      if (session.state === "live") {
        if (ownedPanelSession(session, identity)) await this.stopAndForget(identity.name)
        return
      }
      if (session.state === "exited") {
        if (ownedPanelSession(session, identity)) await this.companion.forget(identity.name).catch(() => {})
        return
      }
      if (session.state === "absent" && !retirement.waitThroughAbsent) return
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      delayMs = Math.min(RETIREMENT_MAX_POLL_MS, delayMs * 2)
    }
  }

  private assertActive(agentId: string): void {
    if (this.closed) throw new Error("fmx is shutting down")
    if (this.stoppedAgents.has(agentId)) throw new Error("the tools panel's agent has ended")
  }
}

export function panelDefinitionFingerprint(definition: Pick<PanelDefinition, "id" | "command">): string {
  return createHash("sha256")
    .update(JSON.stringify([definition.id, definition.command]))
    .digest("hex")
    .slice(0, PANEL_FINGERPRINT_LENGTH)
}

function panelIdFingerprint(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, PANEL_ID_FINGERPRINT_LENGTH)
}

export function panelSessionIdentity(
  homeId: string,
  agentId: string,
  definition: PanelDefinition,
): PanelSessionIdentity {
  const fingerprint = panelDefinitionFingerprint(definition)
  return {
    // 63 bytes with the current 12-byte Home and fingerprint plus 32-byte Agent id.
    name: `${PANEL_SESSION_PREFIX}-${homeId}-${agentId}-${fingerprint}`,
    agentId,
    fingerprint,
    labels: {
      owner: OWNER_LABEL,
      home: homeId,
      kind: PANEL_SESSION_KIND,
      agent: agentId,
      panel: definition.id,
      panel_id: panelIdFingerprint(definition.id),
      definition: fingerprint,
    },
  }
}

export function parsePanelSessionName(name: string): {
  homeId: string
  agentId: string
  fingerprint: string
} | null {
  const match = /^fmxp-([0-9a-f]{12})-([0-9a-f]{32})-([0-9a-f]{12})$/u.exec(name)
  if (!match) return null
  return { homeId: match[1]!, agentId: match[2]!, fingerprint: match[3]! }
}

function ownedPanelSession(session: SessionEntry, identity: PanelSessionIdentity): boolean {
  if (session.name !== identity.name) return false
  return Object.entries(identity.labels).every(([key, value]) => session.labels[key] === value)
}

function ownedPanelSessionForHome(session: SessionEntry, homeId: string): boolean {
  const parsed = parsePanelSessionName(session.name)
  const panelId = session.labels.panel
  return (
    session.labels.owner === OWNER_LABEL &&
    session.labels.home === homeId &&
    session.labels.kind === PANEL_SESSION_KIND &&
    parsed?.homeId === homeId &&
    session.labels.agent === parsed.agentId &&
    session.labels.definition === parsed.fingerprint &&
    isPanelId(panelId) &&
    session.labels.panel_id === panelIdFingerprint(panelId)
  )
}

/** A non-persistent panel process belongs to this fmx and dies when detached. */
class LocalPanelTransport implements TerminalTransport {
  private readonly relay = new HandlerRelay()
  private readonly process: ReturnType<typeof Bun.spawn>
  private closed = false

  constructor(command: string[], cwd: string, env: Record<string, string>, size: TerminalSize) {
    this.process = Bun.spawn(command, {
      cwd,
      env,
      terminal: {
        cols: size.cols,
        rows: size.rows,
        data: (_terminal, bytes) => this.relay.emit((handlers) => handlers.output(bytes)),
      },
    })
    this.relay.emit((handlers) => handlers.ready())
    void this.process.exited.then((code) => {
      if (this.closed) return
      this.closed = true
      this.relay.emit((handlers) => handlers.exit({ code, signal: this.process.signalCode ? 1 : 0 }))
      this.closeTerminal()
    })
  }

  bind(handlers: TransportHandlers): void {
    this.relay.bind(handlers)
  }

  write(bytes: Uint8Array): void {
    if (this.closed) return
    try {
      this.process.terminal?.write(bytes)
    } catch {
      // Exit is authoritative.
    }
  }

  resize(size: TerminalSize): void {
    if (this.closed) return
    try {
      this.process.terminal?.resize(size.cols, size.rows)
    } catch {
      // A resize racing exit is harmless.
    }
  }

  detach(): void {
    if (this.closed) return
    this.closed = true
    this.relay.stop()
    this.closeTerminal()
    try {
      this.process.kill("SIGKILL")
    } catch {
      // Already gone.
    }
  }

  private closeTerminal(): void {
    try {
      this.process.terminal?.close()
    } catch {
      // Already closed.
    }
  }
}
