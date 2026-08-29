import { chmodSync } from "node:fs"
import {
  decodeRuntimeBridgeClientMessage,
  encodeRuntimeBridgeServerMessage,
  RUNTIME_BRIDGE_MAX_REQUEST_CHARS,
  RUNTIME_BRIDGE_MAX_RESPONSE_BYTES,
  retiredRuntimeSocketPathsFor,
  runtimeBridgeError,
  runtimeBridgeResponse,
  runtimeSocketPathFor,
  type RuntimeBridgeProtocolError,
} from "./runtime-bridge-protocol.ts"
import {
  errorReply,
  failureFrom,
  successReply,
  type ControlRequest,
  type ControlSurface,
} from "./control-protocol.ts"
import { removeSocketFile } from "./unix-socket.ts"

type SocketListener = ReturnType<typeof Bun.listen>
type SocketConnection = {
  write(data: Uint8Array | string): number
  end(): void
}

const DEFAULT_FIRST_MESSAGE_TIMEOUT_MS = 2_000
const DEFAULT_MAX_CONNECTIONS = 64

export type RuntimeBridgeOptions = {
  firstMessageTimeoutMs?: number
  maxConnections?: number
  maxMessageChars?: number
  maxResponseBytes?: number
}

type Connection = {
  socket: SocketConnection
  decoder: TextDecoder
  input: string
  firstMessageTimer: ReturnType<typeof setTimeout> | null
  request: AbortController | null
  output: Uint8Array | null
  outputOffset: number
  accepted: boolean
  closed: boolean
}

/**
 * The Home's implementation-private MCP-to-Runtime request bridge. Each
 * bounded connection carries one correlated request and one response, then
 * closes. It is not an observation stream and does not keep the Runtime alive.
 */
export class RuntimeBridge {
  readonly path: string
  private listener: SocketListener | null = null
  private readonly connections = new Set<Connection>()
  private readonly connectionBySocket = new WeakMap<object, Connection>()
  private readonly firstMessageTimeoutMs: number
  private readonly maxConnections: number
  private readonly maxMessageChars: number
  private readonly maxResponseBytes: number

  constructor(
    private readonly surface: ControlSurface,
    path: string,
    options: RuntimeBridgeOptions = {},
  ) {
    this.path = path
    this.firstMessageTimeoutMs = options.firstMessageTimeoutMs ?? DEFAULT_FIRST_MESSAGE_TIMEOUT_MS
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
    this.maxMessageChars = options.maxMessageChars ?? RUNTIME_BRIDGE_MAX_REQUEST_CHARS
    this.maxResponseBytes = options.maxResponseBytes ?? RUNTIME_BRIDGE_MAX_RESPONSE_BYTES
  }

  static pathFor(basePath: string): string {
    return runtimeSocketPathFor(basePath)
  }

  /** Binding and retired-path cleanup are safe only under the ADE Home singleton. */
  start(): void {
    if (this.listener) return
    removeSocketFile(this.path)
    for (const path of retiredRuntimeSocketPathsFor(this.path)) removeSocketFile(path)
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
    } catch (error) {
      this.listener?.stop(true)
      this.listener = null
      removeSocketFile(this.path)
      throw error
    }
  }

  close(): void {
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
      request: null,
      output: null,
      outputOffset: 0,
      accepted: false,
      closed: false,
    }
    connection.firstMessageTimer = setTimeout(() => this.drop(connection), this.firstMessageTimeoutMs)
    this.connections.add(connection)
    this.connectionBySocket.set(socket as object, connection)
  }

  private acceptData(socket: SocketConnection, data: Uint8Array): void {
    const connection = this.connectionBySocket.get(socket as object)
    if (!connection || connection.closed || connection.output) return
    connection.input += connection.decoder.decode(data, { stream: true })
    const newline = connection.input.indexOf("\n")
    if (newline === -1) {
      if (connection.input.length > this.maxMessageChars) {
        this.rejectProtocol(connection, { code: "invalid_request", message: "Runtime bridge request is too large" })
      }
      return
    }
    if (newline > this.maxMessageChars) {
      this.rejectProtocol(connection, { code: "invalid_request", message: "Runtime bridge request is too large" })
      return
    }
    const line = connection.input.slice(0, newline)
    const trailing = connection.input.slice(newline + 1)
    connection.input = ""
    if (connection.firstMessageTimer) clearTimeout(connection.firstMessageTimer)
    connection.firstMessageTimer = null
    if (connection.accepted || trailing.trim() !== "") {
      this.rejectProtocol(connection, { code: "invalid_request", message: "one request is allowed per connection" })
      return
    }
    if (line.trim() === "") {
      this.rejectProtocol(connection, { code: "invalid_request", message: "request must not be empty" })
      return
    }
    connection.accepted = true
    const decoded = decodeRuntimeBridgeClientMessage(line)
    if ("error" in decoded) {
      this.rejectProtocol(connection, decoded.error)
      return
    }
    if ("reply" in decoded) {
      this.send(connection, encodeRuntimeBridgeServerMessage(runtimeBridgeResponse(decoded.reply)))
      return
    }
    this.acceptRequest(connection, decoded.request)
  }

  private acceptRequest(connection: Connection, request: ControlRequest): void {
    const abort = new AbortController()
    connection.request = abort
    void this.handleRequest(connection, request, abort)
  }

  private async handleRequest(
    connection: Connection,
    request: ControlRequest,
    abort: AbortController,
  ): Promise<void> {
    try {
      const result = await this.surface.handle(request.method, request.params, abort.signal)
      if (!connection.closed) {
        this.send(
          connection,
          encodeRuntimeBridgeServerMessage(runtimeBridgeResponse(successReply(request.id, result))),
        )
      }
    } catch (error) {
      if (!connection.closed) {
        this.send(
          connection,
          encodeRuntimeBridgeServerMessage(runtimeBridgeResponse(errorReply(request.id, failureFrom(error)))),
        )
      }
    } finally {
      if (connection.request === abort) connection.request = null
    }
  }

  private rejectProtocol(connection: Connection, error: RuntimeBridgeProtocolError): void {
    this.send(connection, encodeRuntimeBridgeServerMessage(runtimeBridgeError(error)))
  }

  private send(connection: Connection, line: string): void {
    if (connection.closed || connection.output) return
    const bytes = new TextEncoder().encode(line)
    if (bytes.byteLength > this.maxResponseBytes) {
      this.drop(connection)
      return
    }
    connection.output = bytes
    this.flush(connection)
  }

  private flushFor(socket: SocketConnection): void {
    const connection = this.connectionBySocket.get(socket as object)
    if (connection) this.flush(connection)
  }

  private flush(connection: Connection): void {
    const output = connection.output
    if (connection.closed || !output) return
    try {
      const remaining = output.subarray(connection.outputOffset)
      const written = connection.socket.write(remaining)
      if (written <= 0) return
      connection.outputOffset += Math.min(written, remaining.byteLength)
      if (connection.outputOffset >= output.byteLength) connection.socket.end()
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
    connection.request?.abort()
    connection.request = null
    connection.output = null
    connection.input = ""
    this.connections.delete(connection)
    this.connectionBySocket.delete(connection.socket as object)
  }
}
