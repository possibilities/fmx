import { chmodSync } from "node:fs"
import { userInfo } from "node:os"
import type { Socket } from "bun"
import { acquireExclusiveLock, type HeldLock } from "./file-lock.ts"
import {
  ApiFailure,
  encodeFrame,
  type ErrorCode,
  type EventFrame,
  failureFrame,
  isMethod,
  METHODS,
  type Method,
  requestSchema,
  successFrame,
} from "./protocol.ts"
import { isAddressInUse, listenerAnswers, removeSocketFile } from "./unix-socket.ts"
import { privateRootDirectory } from "./zmx-environment.ts"

const MAX_FRAME_BYTES = 1 << 20
const SINGLETON_HANDOFF_TIMEOUT_MS = 1_000
const SINGLETON_HANDOFF_INTERVAL_MS = 25

/** Another Runtime owns this Instance's API socket. */
export class InstanceActiveError extends Error {
  constructor(readonly path: string) {
    super(`another fmx Runtime is already running for this Instance (listening on ${path})`)
    this.name = "InstanceActiveError"
  }
}

export type ApiHandler = (method: Method, params: unknown) => Promise<unknown>

type Connection = {
  id: number
  buffer: string
  subscribed: boolean
  /** Frames not yet fully written; a large result can exceed the socket buffer. */
  outgoing: Uint8Array[]
}

const encoder = new TextEncoder()

/**
 * The one API socket of a Runtime: newline-delimited JSON, any number of
 * long-lived connections, events to those that subscribed. Binding it makes
 * this process the Instance's singleton: a live holder is refused and never
 * unlinked; residue from a crashed Runtime is replaced only under the lock.
 */
export class ApiServer {
  private readonly connections = new Map<number, Connection>()
  private nextId = 1
  private server: ReturnType<typeof Bun.listen<Connection>> | null = null
  /** Held from start to stop: the right to probe, unlink, and bind the path. */
  private lock: HeldLock | null = null

  constructor(
    readonly path: string,
    private readonly handle: ApiHandler,
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    const lockPath = lockPathFor(this.path)
    let lock = acquireExclusiveLock(lockPath)
    if (lock === null) lock = await waitForSingletonHandoff(lockPath)
    if (lock === null) throw new InstanceActiveError(this.path)
    this.lock = lock ?? null
    if (await listenerAnswers(this.path)) {
      this.releaseLock()
      throw new InstanceActiveError(this.path)
    }
    removeSocketFile(this.path)
    for (const retired of retiredSocketPathsFor(this.path)) removeSocketFile(retired)
    try {
      this.server = Bun.listen<Connection>({
        unix: this.path,
        socket: {
          open: (socket) => this.open(socket),
          data: (socket, data) => this.data(socket, data),
          drain: (socket) => this.flush(socket),
          close: (socket) => this.forget(socket.data.id),
          error: (socket) => this.forget(socket.data.id),
        },
      })
      chmodSync(this.path, 0o600)
    } catch (error) {
      const owned = this.server !== null
      this.server?.stop(true)
      this.server = null
      if (owned) removeSocketFile(this.path)
      this.releaseLock()
      if (isAddressInUse(error)) throw new InstanceActiveError(this.path)
      throw error
    }
  }

  stop(): void {
    if (!this.server) return
    this.server.stop(true)
    this.server = null
    removeSocketFile(this.path)
    this.releaseLock()
    this.connections.clear()
  }

  broadcast(frame: EventFrame): void {
    if (!this.server) return
    const bytes = encoder.encode(encodeFrame(frame))
    for (const connection of this.connections.values()) {
      if (!connection.subscribed) continue
      connection.outgoing.push(bytes)
      this.flushConnection(connection)
    }
  }

  get subscribers(): number {
    let count = 0
    for (const connection of this.connections.values()) if (connection.subscribed) count += 1
    return count
  }

  private readonly sockets = new Map<number, Socket<Connection>>()

  private forget(id: number): void {
    this.connections.delete(id)
    this.sockets.delete(id)
  }

  private open(socket: Socket<Connection>): void {
    const id = this.nextId++
    const connection: Connection = { id, buffer: "", subscribed: false, outgoing: [] }
    socket.data = connection
    this.connections.set(id, connection)
    this.sockets.set(id, socket)
  }

  private send(connection: Connection, line: string): void {
    connection.outgoing.push(encoder.encode(line))
    this.flushConnection(connection)
  }

  private flushConnection(connection: Connection): void {
    const socket = this.sockets.get(connection.id)
    if (socket) this.flush(socket)
  }

  /** Write what the kernel will take; the rest waits for `drain`. */
  private flush(socket: Socket<Connection>): void {
    const connection = socket.data
    while (connection.outgoing.length > 0) {
      const chunk = connection.outgoing[0]!
      let written: number
      try {
        written = socket.write(chunk)
      } catch {
        this.forget(connection.id)
        return
      }
      if (written < chunk.byteLength) {
        connection.outgoing[0] = chunk.subarray(Math.max(0, written))
        return
      }
      connection.outgoing.shift()
    }
  }

  private data(socket: Socket<Connection>, data: Buffer): void {
    const connection = socket.data
    connection.buffer += data.toString("utf8")
    if (connection.buffer.length > MAX_FRAME_BYTES) {
      this.send(connection, encodeFrame(failureFrame(null, "invalid_request", "frame too large")))
      socket.end()
      return
    }
    let newline = connection.buffer.indexOf("\n")
    while (newline >= 0) {
      const line = connection.buffer.slice(0, newline).trim()
      connection.buffer = connection.buffer.slice(newline + 1)
      if (line.length > 0) void this.accept(line, connection)
      newline = connection.buffer.indexOf("\n")
    }
  }

  private async accept(line: string, connection: Connection): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.send(connection, encodeFrame(failureFrame(null, "invalid_request", "expected one JSON object per line")))
      return
    }
    const request = requestSchema.safeParse(parsed)
    if (!request.success) {
      const id = isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : null
      this.send(connection, encodeFrame(failureFrame(id, "invalid_request", request.error.issues.map((issue) => issue.message).join("; "))))
      return
    }
    const { id, method, params } = request.data
    if (!isMethod(method)) {
      this.send(connection, encodeFrame(failureFrame(id, "unknown_method", `unknown method ${JSON.stringify(method)}`)))
      return
    }
    const checked = METHODS[method].params.safeParse(params ?? {})
    if (!checked.success) {
      const reasons = checked.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      this.send(connection, encodeFrame(failureFrame(id, "invalid_params", reasons.join("; "))))
      return
    }
    if (method === "events.subscribe") {
      connection.subscribed = true
      this.send(connection, encodeFrame(successFrame(id, {})))
      return
    }
    try {
      const result = await this.handle(method, checked.data)
      this.send(connection, encodeFrame(successFrame(id, result)))
    } catch (error) {
      const code: ErrorCode = error instanceof ApiFailure ? error.code : "internal"
      const message = error instanceof Error ? error.message : String(error)
      this.send(connection, encodeFrame(failureFrame(id, code, message)))
    }
  }

  private releaseLock(): void {
    this.lock?.release()
    this.lock = null
  }
}

export function apiSocketPathFor(instanceId: string, uid: number = userInfo().uid): string {
  return `${privateRootDirectory(uid)}/${instanceId}.api`
}

export function lockPathFor(apiSocketPath: string): string {
  return apiSocketPath.replace(/\.api$/u, "") + ".lock"
}

/** Paths earlier fmx versions bound for the same Instance; residue only. */
export function retiredSocketPathsFor(apiSocketPath: string): string[] {
  const base = apiSocketPath.replace(/\.api$/u, "")
  return [`${base}.ade.sock`, `${base}.bus`, `${base}.ctl`, `${base}.obs`]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
