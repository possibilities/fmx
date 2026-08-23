import { chmodSync, unlinkSync } from "node:fs"

type SocketListener = ReturnType<typeof Bun.listen>

const MAX_RECORD_BYTES = 2 * 1024 * 1024

export type AdeAgentRole = "main" | "subagent"

export type AdeRecord = {
  schemaVersion: 1
  sequence: number
  event: string
  instanceId: string
  context: {
    agentRole: AdeAgentRole
    sessionId: string | null
    parentSessionId: string | null
  }
  payload: Record<string, unknown>
}

export type AdeEventListener = (record: AdeRecord) => void

export type AdeSocketOptions = {
  path: string
}

/**
 * The one-way ADE feed emitted by interactive fx processes. One stable socket
 * serves every Agent; `instance_id` is the Agent's stable Manifest identity.
 * Fx never waits for a reply, so this receiver never writes one.
 */
export class AdeSocket {
  readonly path: string
  private listener: SocketListener | null = null
  private readonly pending = new WeakMap<object, Buffer>()
  private readonly oversized = new WeakSet<object>()
  private readonly listeners = new Set<AdeEventListener>()

  constructor(options: AdeSocketOptions) {
    this.path = options.path
  }

  addEventListener(listener: AdeEventListener): void {
    this.listeners.add(listener)
  }

  /** The Agent socket's singleton lock already serializes this stable path. */
  start(): void {
    if (this.listener) return
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
      this.listener?.stop(true)
      this.listener = null
      removeSocketFile(this.path)
      throw error
    }
  }

  close(): void {
    if (!this.listener) return
    this.listener.stop(true)
    this.listener = null
    removeSocketFile(this.path)
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
    for (const listener of this.listeners) {
      try {
        listener(record)
      } catch {
        // ADE is observational. A consumer bug cannot take the TUI down.
      }
    }
  }
}

export function adeSocketPathFor(agentSocketPath: string): string {
  return agentSocketPath.replace(/\.sock$/u, "") + ".ade.sock"
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
  const sessionId = value.context.session_id
  if (sessionId !== null && typeof sessionId !== "string") return null
  const parentSessionId = value.context.parent_session_id
  if (parentSessionId !== null && typeof parentSessionId !== "string") return null

  return {
    schemaVersion: 1,
    sequence: value.sequence as number,
    event: value.event,
    instanceId: value.instance_id,
    context: {
      agentRole: role,
      sessionId,
      parentSessionId,
    },
    payload: value.payload,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function removeSocketFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Missing is normal; the Agent socket singleton makes replacement safe.
  }
}
