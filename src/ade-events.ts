import { chmodSync } from "node:fs"
import { userInfo } from "node:os"
import { acquireExclusiveLock, type HeldLock } from "./file-lock.ts"
import { homeId } from "./zmx-environment.ts"
import { isAddressInUse, listenerAnswers, removeSocketFile } from "./unix-socket.ts"

type SocketListener = ReturnType<typeof Bun.listen>

const MAX_RECORD_BYTES = 2 * 1024 * 1024
const MAX_STARTUP_BACKLOG_RECORDS = 128
const MAX_STARTUP_BACKLOG_BYTES = 8 * 1024 * 1024
const SINGLETON_HANDOFF_TIMEOUT_MS = 1_000
const SINGLETON_HANDOFF_INTERVAL_MS = 25

export type AdeAgentRole = "main" | "subagent"
export type AdeAgentState = "idle" | "working" | "blocked"
export type AdeAttentionKind = "permission" | "question" | "route_recovery"

export type AdeRecord = {
  schemaVersion: 1
  sequence: number
  event: string
  instanceId: string
  context: {
    agentRole: AdeAgentRole
    workspaceRoot: string | null
    sessionId: string | null
    parentSessionId: string | null
    subagentId: number | null
    turnId: number | null
    agentState: AdeAgentState
    attentionKind: AdeAttentionKind | null
  }
  payload: Record<string, unknown>
}

export type AdeEventListener = (record: AdeRecord) => void

/** The ADE surface Multiplexer consumes; kept structural for deterministic tests. */
export type AdeEventSource = {
  readonly path: string
  addEventListener(listener: AdeEventListener): void
}

export type AdeSocketOptions = {
  /** Keys the stable default path. Defaults to this process's Home. */
  homeId?: string
  path?: string
}

/** Another Runtime owns this Home's ADE socket and Manifest authority. */
export class HomeActiveError extends Error {
  constructor(readonly path: string) {
    super(`another fmx Runtime is already running for this Home (listening on ${path})`)
  }
}

/**
 * The one-way ADE feed emitted by interactive fx processes. One stable socket
 * serves every Agent; `instance_id` is the Agent's stable Manifest identity.
 * Fx never waits for a reply, so this receiver never writes one.
 */
export class AdeSocket implements AdeEventSource {
  readonly path: string
  private listener: SocketListener | null = null
  /** Held from start to close: the right to probe, unlink, and bind the path. */
  private lock: HeldLock | null = null
  private readonly pending = new WeakMap<object, Buffer>()
  private readonly oversized = new WeakSet<object>()
  private readonly listeners = new Set<AdeEventListener>()
  /** Records accepted before Multiplexer has installed the restored Agents. */
  private startupBacklog: { record: AdeRecord; bytes: number }[] = []
  private startupBacklogBytes = 0

  constructor(options: AdeSocketOptions = {}) {
    this.path = options.path ?? defaultAdeSocketPath(options.homeId ?? homeId())
  }

  addEventListener(listener: AdeEventListener): void {
    this.listeners.add(listener)
    if (this.startupBacklog.length === 0) return
    const backlog = this.startupBacklog
    this.startupBacklog = []
    this.startupBacklogBytes = 0
    for (const { record } of backlog) this.emit(record)
  }

  /**
   * Bind the feed as the Home singleton. A live holder is refused and never
   * unlinked; residue from a crashed Runtime is replaced only while holding
   * the Home lock.
   */
  async start(): Promise<void> {
    if (this.listener) return
    let lock = acquireExclusiveLock(lockPathFor(this.path))
    if (lock === null) lock = await waitForSingletonHandoff(lockPathFor(this.path))
    if (lock === null) throw new HomeActiveError(this.path)
    this.lock = lock ?? null
    if (await listenerAnswers(this.path)) {
      this.releaseLock()
      throw new HomeActiveError(this.path)
    }
    removeSocketFile(this.path)
    try {
      this.listener = Bun.listen({
        unix: this.path,
        socket: {
          data: (socket, data) => this.acceptData(socket as object, data),
          close: (socket) => this.acceptClose(socket as object),
          error: (socket) => this.acceptClose(socket as object),
        },
      })
      // Titles summarize prompt text, so the feed is private to this user.
      chmodSync(this.path, 0o600)
    } catch (error) {
      // Bun.listen can lose a same-instant bind race when flock is
      // unavailable. Only clean up the path when this process actually bound
      // it (for example, when chmod failed after the bind); otherwise the
      // path belongs to the winner and must remain live.
      const ownedPath = this.listener !== null
      this.listener?.stop(true)
      this.listener = null
      if (ownedPath) removeSocketFile(this.path)
      this.releaseLock()
      if (isAddressInUse(error)) throw new HomeActiveError(this.path)
      throw error
    }
  }

  close(): void {
    if (!this.listener) return
    this.listener.stop(true)
    this.listener = null
    removeSocketFile(this.path)
    this.releaseLock()
    this.startupBacklog = []
    this.startupBacklogBytes = 0
  }

  private releaseLock(): void {
    this.lock?.release()
    this.lock = null
  }

  private acceptData(socket: object, data: Uint8Array): void {
    if (this.oversized.has(socket)) return
    const previous = this.pending.get(socket) ?? Buffer.alloc(0)
    const bytes = Buffer.concat([previous, Buffer.from(data)])
    if (bytes.length > MAX_RECORD_BYTES + 1) {
      this.pending.delete(socket)
      this.oversized.add(socket)
      return
    }

    let offset = 0
    for (;;) {
      const newline = bytes.indexOf(0x0a, offset)
      if (newline < 0) break
      if (newline - offset <= MAX_RECORD_BYTES) {
        this.acceptLine(bytes.subarray(offset, newline).toString("utf8"))
      }
      offset = newline + 1
    }
    this.pending.set(socket, bytes.subarray(offset))
  }

  private acceptClose(socket: object): void {
    this.pending.delete(socket)
    this.oversized.delete(socket)
  }

  private acceptLine(line: string): void {
    const record = decodeAdeRecord(line)
    if (!record) return
    if (this.listeners.size === 0) {
      this.bufferStartupRecord(record, Buffer.byteLength(line, "utf8") + 1)
      return
    }
    this.emit(record)
  }

  private bufferStartupRecord(record: AdeRecord, bytes: number): void {
    while (
      this.startupBacklog.length >= MAX_STARTUP_BACKLOG_RECORDS ||
      this.startupBacklogBytes + bytes > MAX_STARTUP_BACKLOG_BYTES
    ) {
      const dropped = this.startupBacklog.shift()
      if (!dropped) break
      this.startupBacklogBytes -= dropped.bytes
    }
    this.startupBacklog.push({ record, bytes })
    this.startupBacklogBytes += bytes
  }

  private emit(record: AdeRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(record)
      } catch {
        // ADE is observational. A consumer bug cannot take the TUI down.
      }
    }
  }
}

export function defaultAdeSocketPath(home: string, uid: number = userInfo().uid): string {
  return `/tmp/fmx-${uid}-${home}.ade.sock`
}

export function adeSocketPathFor(basePath: string): string {
  return basePath.replace(/(?:\.ade)?\.sock$/u, "") + ".ade.sock"
}

export function lockPathFor(adeSocketPath: string): string {
  return adeSocketPath.replace(/(?:\.ade)?\.sock$/u, "") + ".lock"
}

/** Unknown additive schema-1 events remain valid records and are ignored by consumers. */
export function decodeAdeRecord(line: string): AdeRecord | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value) || value.schema_version !== 1) return null
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0) return null
  if (typeof value.event !== "string" || value.event.length === 0) return null
  if (typeof value.instance_id !== "string" || value.instance_id.length === 0) return null
  if (!isRecord(value.context) || !isRecord(value.payload)) return null
  const role = value.context.agent_role
  if (role !== "main" && role !== "subagent") return null
  const workspaceRoot = typeof value.context.workspace_root === "string" ? value.context.workspace_root : null
  const sessionId = value.context.session_id
  if (sessionId !== null && typeof sessionId !== "string") return null
  const parentSessionId = value.context.parent_session_id
  if (parentSessionId !== null && typeof parentSessionId !== "string") return null
  const subagentId = nullableSafeInteger(value.context.subagent_id)
  const turnId = nullableSafeInteger(value.context.turn_id)
  const agentState = value.context.agent_state
  if (agentState !== "idle" && agentState !== "working" && agentState !== "blocked") return null
  const attentionKind = value.context.attention_kind
  if (
    attentionKind !== null &&
    attentionKind !== "permission" &&
    attentionKind !== "question" &&
    attentionKind !== "route_recovery"
  ) return null
  if (agentState !== "blocked" && attentionKind !== null) return null

  return {
    schemaVersion: 1,
    sequence: value.sequence as number,
    event: value.event,
    instanceId: value.instance_id,
    context: {
      agentRole: role,
      workspaceRoot,
      sessionId,
      parentSessionId,
      subagentId,
      turnId,
      agentState,
      attentionKind,
    },
    payload: value.payload,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nullableSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null
}

async function waitForSingletonHandoff(path: string): Promise<HeldLock | null | undefined> {
  const deadline = Date.now() + SINGLETON_HANDOFF_TIMEOUT_MS
  let lock: HeldLock | null | undefined = null
  while (lock === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SINGLETON_HANDOFF_INTERVAL_MS))
    lock = acquireExclusiveLock(path)
  }
  return lock
}
