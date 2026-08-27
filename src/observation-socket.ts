import { chmodSync } from "node:fs"
import { type ObservationHub, type ObservationUpdate } from "./observation-hub.ts"
import {
  encodeObservationMessage,
  decodeObservationSubscription,
  observationActivity,
  OBSERVATION_SCHEMA_VERSION,
  type ObservationErrorMessage,
  type ObservationMessage,
  type ObservationSubscription,
} from "./observation-protocol.ts"
import { removeSocketFile } from "./unix-socket.ts"

type SocketListener = ReturnType<typeof Bun.listen>
type SocketConnection = {
  write(data: Uint8Array | string): number
  end(): void
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000
const DEFAULT_MAX_OBSERVERS = 32
const DEFAULT_MAX_QUEUE_RECORDS = 128
const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024
const MAX_HANDSHAKE_BYTES = 64 * 1024

export type ObservationSocketOptions = {
  handshakeTimeoutMs?: number
  maxObservers?: number
  maxQueueRecords?: number
  maxQueueBytes?: number
}

type Connection = {
  socket: SocketConnection
  decoder: TextDecoder
  handshake: string
  handshakeBytes: number
  handshakeTimer: ReturnType<typeof setTimeout> | null
  subscription: ObservationSubscription | null
  queue: Uint8Array[]
  queuedBytes: number
  streamSequence: number
  endWhenDrained: boolean
  closed: boolean
}

/**
 * Runtime → Observer: one subscription line in, then a bounded NDJSON stream
 * out. It is deliberately separate from both Fx's ADE ingress and control RPC.
 */
export class ObservationSocket {
  readonly path: string
  private listener: SocketListener | null = null
  private readonly connections = new Set<Connection>()
  private readonly connectionBySocket = new WeakMap<object, Connection>()
  private unsubscribe: (() => void) | null = null
  private readonly handshakeTimeoutMs: number
  private readonly maxObservers: number
  private readonly maxQueueRecords: number
  private readonly maxQueueBytes: number

  constructor(
    private readonly hub: ObservationHub,
    path: string,
    options: ObservationSocketOptions = {},
  ) {
    this.path = path
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.maxObservers = options.maxObservers ?? DEFAULT_MAX_OBSERVERS
    this.maxQueueRecords = options.maxQueueRecords ?? DEFAULT_MAX_QUEUE_RECORDS
    this.maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES
  }

  static pathFor(basePath: string): string {
    return `${basePath.replace(/(?:(?:\.ade)?\.sock|\.ctl|\.obs)$/u, "")}.obs`
  }

  /** Binding and stale-path replacement are safe only under the ADE Home singleton. */
  start(): void {
    if (this.listener) return
    removeSocketFile(this.path)
    try {
      this.listener = Bun.listen({
        unix: this.path,
        socket: {
          open: (socket) => this.acceptOpen(socket),
          data: (socket, data) => this.acceptData(socket, data),
          drain: (socket) => this.flushFor(socket),
          close: (socket) => this.acceptClose(socket),
          error: (socket) => this.acceptClose(socket),
        },
      })
      chmodSync(this.path, 0o600)
      this.unsubscribe = this.hub.subscribe((update) => this.publish(update))
    } catch (error) {
      this.listener?.stop(true)
      this.listener = null
      removeSocketFile(this.path)
      throw error
    }
  }

  close(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const connection of [...this.connections]) this.drop(connection)
    this.listener?.stop(true)
    this.listener = null
    removeSocketFile(this.path)
  }

  private acceptOpen(socket: SocketConnection): void {
    if (this.connections.size >= this.maxObservers) {
      socket.end()
      return
    }
    const connection: Connection = {
      socket,
      decoder: new TextDecoder(),
      handshake: "",
      handshakeBytes: 0,
      handshakeTimer: null,
      subscription: null,
      queue: [],
      queuedBytes: 0,
      streamSequence: 0,
      endWhenDrained: false,
      closed: false,
    }
    connection.handshakeTimer = setTimeout(() => this.drop(connection), this.handshakeTimeoutMs)
    this.connections.add(connection)
    this.connectionBySocket.set(socket as object, connection)
  }

  private acceptData(socket: SocketConnection, data: Uint8Array): void {
    const connection = this.connectionBySocket.get(socket as object)
    if (!connection || connection.closed) return
    // The wire is passive after its one subscription request.
    if (connection.subscription) {
      this.drop(connection)
      return
    }
    connection.handshakeBytes += data.byteLength
    if (connection.handshakeBytes > MAX_HANDSHAKE_BYTES) {
      this.drop(connection)
      return
    }
    connection.handshake += connection.decoder.decode(data, { stream: true })
    const newline = connection.handshake.indexOf("\n")
    if (newline === -1) return
    const line = connection.handshake.slice(0, newline)
    const remainder = connection.handshake.slice(newline + 1)
    connection.handshake = ""
    if (remainder.trim() !== "") {
      this.drop(connection)
      return
    }
    this.acceptSubscription(connection, line)
  }

  private acceptSubscription(connection: Connection, line: string): void {
    const decoded = decodeObservationSubscription(line)
    if ("error" in decoded) {
      const message: ObservationErrorMessage = {
        schema_version: OBSERVATION_SCHEMA_VERSION,
        event: "error",
        error: decoded.error,
      }
      this.enqueue(connection, encodeObservationMessage(message))
      connection.endWhenDrained = true
      this.flush(connection)
      return
    }
    if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer)
    connection.handshakeTimer = null
    connection.subscription = decoded.subscription
    const current = this.hub.snapshot()
    this.sendState(connection, "snapshot", "subscribed", current.stateRevision, current.state)
  }

  private publish(update: ObservationUpdate): void {
    for (const connection of [...this.connections]) {
      const subscription = connection.subscription
      if (!subscription || connection.closed) continue
      if (update.kind === "state") {
        if (!subscription.topics.includes("state")) continue
        this.sendState(connection, "state_changed", update.cause, update.stateRevision, update.state)
        continue
      }
      if (!subscription.topics.includes("activity")) continue
      const message: ObservationMessage = {
        schema_version: OBSERVATION_SCHEMA_VERSION,
        runtime: this.hub.runtime,
        stream_sequence: ++connection.streamSequence,
        state_revision: update.stateRevision,
        event: "activity",
        activity: observationActivity(
          update.record,
          update.agentId,
          update.displayId,
          update.gapBefore,
          subscription.activityPayload,
        ),
      }
      this.enqueue(connection, encodeObservationMessage(message))
    }
  }

  private sendState(
    connection: Connection,
    event: "snapshot" | "state_changed",
    cause: string,
    stateRevision: number,
    state: ReturnType<ObservationHub["snapshot"]>["state"],
  ): void {
    const message: ObservationMessage = {
      schema_version: OBSERVATION_SCHEMA_VERSION,
      runtime: this.hub.runtime,
      stream_sequence: ++connection.streamSequence,
      state_revision: stateRevision,
      event,
      cause,
      state,
    }
    this.enqueue(connection, encodeObservationMessage(message))
  }

  private enqueue(connection: Connection, line: string): void {
    if (connection.closed) return
    const bytes = new TextEncoder().encode(line)
    if (
      connection.queue.length >= this.maxQueueRecords ||
      connection.queuedBytes + bytes.byteLength > this.maxQueueBytes
    ) {
      this.drop(connection)
      return
    }
    connection.queue.push(bytes)
    connection.queuedBytes += bytes.byteLength
    this.flush(connection)
  }

  private flushFor(socket: SocketConnection): void {
    const connection = this.connectionBySocket.get(socket as object)
    if (connection) this.flush(connection)
  }

  private flush(connection: Connection): void {
    if (connection.closed) return
    while (connection.queue.length > 0) {
      const head = connection.queue[0]!
      const written = connection.socket.write(head)
      if (written <= 0) return
      connection.queuedBytes -= written
      if (written < head.byteLength) {
        connection.queue[0] = head.subarray(written)
        return
      }
      connection.queue.shift()
    }
    if (connection.endWhenDrained) connection.socket.end()
  }

  private acceptClose(socket: SocketConnection): void {
    const connection = this.connectionBySocket.get(socket as object)
    if (connection) this.release(connection)
  }

  private drop(connection: Connection): void {
    if (connection.closed) return
    connection.socket.end()
    this.release(connection)
  }

  private release(connection: Connection): void {
    if (connection.closed) return
    connection.closed = true
    if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer)
    connection.handshakeTimer = null
    connection.queue = []
    connection.queuedBytes = 0
    this.connections.delete(connection)
    this.connectionBySocket.delete(connection.socket as object)
  }
}
