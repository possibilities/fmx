import { chmodSync } from "node:fs"
import {
  busActivity,
  busError,
  busResponse,
  busSocketPathFor,
  decodeBusClientMessage,
  encodeBusServerMessage,
  retiredSocketPathsFor,
  BUS_SCHEMA_VERSION,
  type BusErrorMessage,
  type BusEventMessage,
  type BusProtocolError,
  type BusSubscription,
} from "./bus-protocol.ts"
import {
  AfterControlReply,
  errorReply,
  failureFrom,
  successReply,
  type ControlReply,
  type ControlRequest,
  type ControlSurface,
} from "./control-protocol.ts"
import { type RuntimeBus, type BusUpdate } from "./runtime-bus.ts"
import { removeSocketFile } from "./unix-socket.ts"

type SocketListener = ReturnType<typeof Bun.listen>
type SocketConnection = {
  write(data: Uint8Array | string): number
  end(): void
}

const DEFAULT_FIRST_MESSAGE_TIMEOUT_MS = 2_000
const DEFAULT_MAX_CONNECTIONS = 64
const DEFAULT_MAX_SUBSCRIBERS = 32
const DEFAULT_MAX_PENDING_REQUESTS = 32
const DEFAULT_MAX_QUEUE_RECORDS = 128
const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024
const MAX_MESSAGE_CHARS = 64 * 1024

export type BusSocketOptions = {
  firstMessageTimeoutMs?: number
  maxConnections?: number
  maxSubscribers?: number
  maxPendingRequests?: number
  maxQueueRecords?: number
  maxQueueBytes?: number
}

type OutboundRecord = {
  bytes: Uint8Array
  offset: number
  lane: "priority" | "event"
  afterWrite: (() => void) | null
}

type Connection = {
  socket: SocketConnection
  decoder: TextDecoder
  input: string
  firstMessageTimer: ReturnType<typeof setTimeout> | null
  subscription: BusSubscription | null
  priorityQueue: OutboundRecord[]
  eventQueue: OutboundRecord[]
  current: OutboundRecord | null
  queuedRecords: number
  queuedBytes: number
  streamSequence: number
  requests: Map<string, AbortController>
  closeWhenDrained: boolean
  closed: boolean
}

/**
 * The Home's one public Runtime bus. Connections may subscribe to retained
 * state and live activity, issue any typed control request, or do both.
 *
 * Every input and output record is versioned NDJSON. Event queues are bounded
 * per connection and may be evicted for a control response; a slow Bus peer
 * is disconnected rather than delaying the Runtime, Fx, or another connection.
 */
export class BusSocket {
  readonly path: string
  private listener: SocketListener | null = null
  private readonly connections = new Set<Connection>()
  private readonly connectionBySocket = new WeakMap<object, Connection>()
  private unsubscribe: (() => void) | null = null
  private readonly firstMessageTimeoutMs: number
  private readonly maxConnections: number
  private readonly maxSubscribers: number
  private readonly maxPendingRequests: number
  private readonly maxQueueRecords: number
  private readonly maxQueueBytes: number

  constructor(
    private readonly bus: RuntimeBus,
    private readonly surface: ControlSurface,
    path: string,
    options: BusSocketOptions = {},
  ) {
    this.path = path
    this.firstMessageTimeoutMs = options.firstMessageTimeoutMs ?? DEFAULT_FIRST_MESSAGE_TIMEOUT_MS
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
    this.maxSubscribers = options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS
    this.maxQueueRecords = options.maxQueueRecords ?? DEFAULT_MAX_QUEUE_RECORDS
    this.maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES
  }

  static pathFor(basePath: string): string {
    return busSocketPathFor(basePath)
  }

  /** Binding and retired-path cleanup are safe only under the ADE Home singleton. */
  start(): void {
    if (this.listener) return
    removeSocketFile(this.path)
    for (const path of retiredSocketPathsFor(this.path)) removeSocketFile(path)
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
      this.unsubscribe = this.bus.subscribe((update) => this.publish(update))
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
    if (this.connections.size >= this.maxConnections) {
      socket.end()
      return
    }
    const connection: Connection = {
      socket,
      decoder: new TextDecoder(),
      input: "",
      firstMessageTimer: null,
      subscription: null,
      priorityQueue: [],
      eventQueue: [],
      current: null,
      queuedRecords: 0,
      queuedBytes: 0,
      streamSequence: 0,
      requests: new Map(),
      closeWhenDrained: false,
      closed: false,
    }
    connection.firstMessageTimer = setTimeout(() => this.drop(connection), this.firstMessageTimeoutMs)
    this.connections.add(connection)
    this.connectionBySocket.set(socket as object, connection)
  }

  private acceptData(socket: SocketConnection, data: Uint8Array): void {
    const connection = this.connectionBySocket.get(socket as object)
    if (!connection || connection.closed || connection.closeWhenDrained) return
    connection.input += connection.decoder.decode(data, { stream: true })
    for (;;) {
      const newline = connection.input.indexOf("\n")
      if (newline === -1) break
      const line = connection.input.slice(0, newline)
      connection.input = connection.input.slice(newline + 1)
      if (line.length > MAX_MESSAGE_CHARS) {
        this.rejectProtocol(connection, { code: "invalid_request", message: "bus message is too large" })
        return
      }
      if (line.trim() !== "") this.acceptLine(connection, line)
      if (connection.closed || connection.closeWhenDrained) return
    }
    if (connection.input.length > MAX_MESSAGE_CHARS) {
      this.rejectProtocol(connection, { code: "invalid_request", message: "bus message is too large" })
    }
  }

  private acceptLine(connection: Connection, line: string): void {
    if (connection.firstMessageTimer) clearTimeout(connection.firstMessageTimer)
    connection.firstMessageTimer = null
    const decoded = decodeBusClientMessage(line)
    if ("error" in decoded) {
      this.rejectProtocol(connection, decoded.error)
      return
    }
    if ("reply" in decoded) {
      this.sendControlResponse(connection, decoded.reply)
      return
    }
    if (decoded.message.type === "subscribe") {
      this.acceptSubscription(connection, decoded.message.subscription)
      return
    }
    this.acceptRequest(connection, decoded.message.request)
  }

  private acceptSubscription(connection: Connection, subscription: BusSubscription): void {
    if (connection.subscription === null && this.subscriberCount() >= this.maxSubscribers) {
      this.rejectProtocol(connection, { code: "capacity", message: "too many bus subscriptions" })
      return
    }
    connection.subscription = subscription
    const current = this.bus.snapshot()
    this.sendState(connection, "snapshot", "subscribed", current.stateRevision, current.state)
  }

  private acceptRequest(connection: Connection, request: ControlRequest): void {
    if (connection.requests.has(request.id)) {
      this.sendControlResponse(
        connection,
        errorReply(request.id, { code: "invalid_request", message: `request ${request.id} is already pending` }),
      )
      return
    }
    if (connection.requests.size >= this.maxPendingRequests) {
      this.sendControlResponse(
        connection,
        errorReply(request.id, { code: "busy", message: "too many requests are pending on this connection" }),
      )
      return
    }
    const abort = new AbortController()
    connection.requests.set(request.id, abort)
    void this.handleRequest(connection, request, abort)
  }

  private async handleRequest(
    connection: Connection,
    request: ControlRequest,
    abort: AbortController,
  ): Promise<void> {
    let reply: ControlReply
    let afterWrite: (() => void) | null = null
    try {
      const handled = await this.surface.handle(request.method, request.params, abort.signal)
      const result = handled instanceof AfterControlReply ? handled.result : handled
      if (handled instanceof AfterControlReply) afterWrite = handled.run
      reply = successReply(request.id, result)
    } catch (error) {
      reply = errorReply(request.id, failureFrom(error))
    } finally {
      if (connection.requests.get(request.id) === abort) connection.requests.delete(request.id)
    }
    if (connection.closed || connection.closeWhenDrained) {
      this.runAfterWrite(afterWrite)
      return
    }
    this.sendControlResponse(connection, reply, afterWrite)
  }

  private sendControlResponse(
    connection: Connection,
    reply: ControlReply,
    afterWrite: (() => void) | null = null,
  ): void {
    if (connection.closeWhenDrained) {
      this.runAfterWrite(afterWrite)
      return
    }
    const message = busResponse(reply, this.bus.runtime, this.bus.snapshot().stateRevision)
    this.enqueue(connection, encodeBusServerMessage(message), "priority", afterWrite)
  }

  private rejectProtocol(connection: Connection, error: BusProtocolError): void {
    if (connection.closeWhenDrained) return
    const message: BusErrorMessage = busError(error)
    connection.closeWhenDrained = true
    for (const request of connection.requests.values()) request.abort()
    connection.requests.clear()
    this.discardUnwrittenEvents(connection)
    this.enqueue(connection, encodeBusServerMessage(message), "priority")
  }

  private publish(update: BusUpdate): void {
    for (const connection of [...this.connections]) {
      const subscription = connection.subscription
      if (!subscription || connection.closed || connection.closeWhenDrained) continue
      if (update.kind === "state") {
        if (!subscription.topics.includes("state")) continue
        this.sendState(connection, "state_changed", update.cause, update.stateRevision, update.state)
        continue
      }
      if (!subscription.topics.includes("activity")) continue
      const message: BusEventMessage = {
        schema_version: BUS_SCHEMA_VERSION,
        type: "event",
        runtime: this.bus.runtime,
        stream_sequence: ++connection.streamSequence,
        state_revision: update.stateRevision,
        event: "activity",
        activity: busActivity(
          update.record,
          update.agentId,
          update.displayId,
          update.gapBefore,
          subscription.activityPayload,
        ),
      }
      this.enqueue(connection, encodeBusServerMessage(message), "event")
    }
  }

  private sendState(
    connection: Connection,
    event: "snapshot" | "state_changed",
    cause: string,
    stateRevision: number,
    state: ReturnType<RuntimeBus["snapshot"]>["state"],
  ): void {
    const message: BusEventMessage = {
      schema_version: BUS_SCHEMA_VERSION,
      type: "event",
      runtime: this.bus.runtime,
      stream_sequence: ++connection.streamSequence,
      state_revision: stateRevision,
      event,
      cause,
      state,
    }
    this.enqueue(connection, encodeBusServerMessage(message), "event")
  }

  private enqueue(
    connection: Connection,
    line: string,
    lane: "priority" | "event",
    afterWrite: (() => void) | null = null,
  ): void {
    if (connection.closed) {
      this.runAfterWrite(afterWrite)
      return
    }
    const bytes = new TextEncoder().encode(line)
    if (lane === "priority") {
      this.preemptUnwrittenEvent(connection)
      this.evictEventsFor(connection, bytes.byteLength)
    }
    if (
      connection.queuedRecords >= this.maxQueueRecords ||
      connection.queuedBytes + bytes.byteLength > this.maxQueueBytes
    ) {
      this.runAfterWrite(afterWrite)
      this.drop(connection)
      return
    }
    const record: OutboundRecord = { bytes, offset: 0, lane, afterWrite }
    if (lane === "priority") connection.priorityQueue.push(record)
    else connection.eventQueue.push(record)
    connection.queuedRecords += 1
    connection.queuedBytes += bytes.byteLength
    this.flush(connection)
  }

  private evictEventsFor(connection: Connection, incomingBytes: number): void {
    while (
      connection.eventQueue.length > 0 &&
      (connection.queuedRecords >= this.maxQueueRecords ||
        connection.queuedBytes + incomingBytes > this.maxQueueBytes)
    ) {
      // Keep the freshest complete state/activity tail. The next retained
      // stream sequence makes the loss visible to the peer.
      const evicted = connection.eventQueue.shift()!
      connection.queuedRecords -= 1
      connection.queuedBytes -= evicted.bytes.byteLength - evicted.offset
      this.runAfterWrite(evicted.afterWrite)
    }
  }

  private preemptUnwrittenEvent(connection: Connection): void {
    const current = connection.current
    if (!current || current.lane !== "event" || current.offset !== 0) return
    connection.current = null
    connection.eventQueue.unshift(current)
  }

  private discardUnwrittenEvents(connection: Connection): void {
    if (connection.current?.lane === "event" && connection.current.offset === 0) {
      const discarded = connection.current
      connection.current = null
      connection.queuedRecords -= 1
      connection.queuedBytes -= discarded.bytes.byteLength
      this.runAfterWrite(discarded.afterWrite)
    }
    for (const discarded of connection.eventQueue) {
      connection.queuedRecords -= 1
      connection.queuedBytes -= discarded.bytes.byteLength - discarded.offset
      this.runAfterWrite(discarded.afterWrite)
    }
    connection.eventQueue = []
  }

  private flushFor(socket: SocketConnection): void {
    const connection = this.connectionBySocket.get(socket as object)
    if (connection) this.flush(connection)
  }

  private flush(connection: Connection): void {
    if (connection.closed) return
    try {
      for (;;) {
        connection.current ??= connection.priorityQueue.shift() ?? connection.eventQueue.shift() ?? null
        const current = connection.current
        if (!current) break
        const remaining = current.bytes.subarray(current.offset)
        const written = connection.socket.write(remaining)
        if (written <= 0) return
        const accepted = Math.min(written, remaining.byteLength)
        current.offset += accepted
        connection.queuedBytes -= accepted
        if (current.offset < current.bytes.byteLength) return
        connection.current = null
        connection.queuedRecords -= 1
        this.runAfterWrite(current.afterWrite)
      }
      if (connection.closeWhenDrained) connection.socket.end()
    } catch {
      this.drop(connection)
    }
  }

  private acceptClose(socket: SocketConnection): void {
    const connection = this.connectionBySocket.get(socket as object)
    if (connection) this.release(connection)
  }

  private drop(connection: Connection): void {
    if (connection.closed) return
    try {
      connection.socket.end()
    } finally {
      this.release(connection)
    }
  }

  private release(connection: Connection): void {
    if (connection.closed) return
    connection.closed = true
    if (connection.firstMessageTimer) clearTimeout(connection.firstMessageTimer)
    connection.firstMessageTimer = null
    for (const request of connection.requests.values()) request.abort()
    connection.requests.clear()
    this.runAfterWrite(connection.current?.afterWrite ?? null)
    for (const record of connection.priorityQueue) this.runAfterWrite(record.afterWrite)
    for (const record of connection.eventQueue) this.runAfterWrite(record.afterWrite)
    connection.current = null
    connection.priorityQueue = []
    connection.eventQueue = []
    connection.queuedRecords = 0
    connection.queuedBytes = 0
    this.connections.delete(connection)
    this.connectionBySocket.delete(connection.socket as object)
  }

  private subscriberCount(): number {
    let count = 0
    for (const connection of this.connections) if (connection.subscription !== null) count += 1
    return count
  }

  private runAfterWrite(action: (() => void) | null): void {
    if (!action) return
    try {
      action()
    } catch {
      // Delivery follow-ups are isolated from the bus and the Runtime.
    }
  }
}
