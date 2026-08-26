import { chmodSync, unlinkSync } from "node:fs"
import {
  type ControlMethod,
  decodeRequest,
  encodeReply,
  errorReply,
  failureFrom,
  successReply,
} from "./control-protocol.ts"
import { LineAssembler } from "./line-assembler.ts"

type SocketListener = ReturnType<typeof Bun.listen>
type SocketConnection = { write: (data: string) => unknown; end: () => unknown }

/**
 * What the socket drives: the running Runtime, behind one method. `signal` aborts
 * when the client hangs up, so a waiting method can stop waiting.
 */
export type ControlSurface = {
  handle(method: ControlMethod, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

/** A successful result whose action must wait until its reply is delivered. */
export class AfterControlReply {
  constructor(
    readonly result: unknown,
    readonly run: () => void,
  ) {}
}

export function afterControlReply(result: unknown, run: () => void): AfterControlReply {
  return new AfterControlReply(result, run)
}

type Connection = {
  assembler: LineAssembler
  decoder: TextDecoder
  abort: AbortController
  afterReply: (() => void) | null
}

/**
 * The Unix socket `fmx control <command>` talks to. It is separate from the
 * one-way ADE feed because a command needs its result and may wait.
 *
 * One request per connection, answered and then closed from this side. The
 * file is mode 0600 — anything that can open it can drive the screen.
 */
export class ControlSocket {
  readonly path: string
  private listener: SocketListener | null = null
  private readonly connections = new WeakMap<object, Connection>()

  constructor(
    private readonly surface: ControlSurface,
    path: string,
  ) {
    this.path = path
  }

  /**
   * Beside the ADE feed and as stable as it, so an fx that outlives one fmx
   * still reaches the next by the path it was given. Binding is safe under
   * the feed's Home singleton.
   */
  static pathFor(adeSocketPath: string): string {
    return `${adeSocketPath.replace(/(?:\.ade)?\.sock$/, "")}.ctl`
  }

  start(): void {
    if (this.listener) return
    removeSocketFile(this.path)
    this.listener = Bun.listen({
      unix: this.path,
      socket: {
        data: (socket, data) => this.acceptData(socket, data),
        close: (socket) => this.acceptClose(socket),
        error: (socket) => this.acceptClose(socket),
      },
    })
    chmodSync(this.path, 0o600)
  }

  close(): void {
    this.listener?.stop(true)
    this.listener = null
    removeSocketFile(this.path)
  }

  private acceptData(socket: SocketConnection, data: Uint8Array): void {
    const connection = this.connectionFor(socket)
    // One decoder for the life of the connection: a prompt arriving in more
    // than one read can be cut mid-character, and a fresh decoder per chunk
    // would replace both halves with U+FFFD before the line is assembled.
    for (const line of connection.assembler.push(connection.decoder.decode(data, { stream: true }))) {
      void this.acceptLine(socket, connection, line)
    }
  }

  private acceptClose(socket: SocketConnection): void {
    const connection = this.connections.get(socket as object)
    if (!connection) return
    connection.abort.abort()
    this.connections.delete(socket as object)
    this.runAfterReply(connection)
  }

  private async acceptLine(socket: SocketConnection, connection: Connection, line: string): Promise<void> {
    const decoded = decodeRequest(line)
    if ("reply" in decoded) {
      this.answer(socket, connection, encodeReply(decoded.reply))
      return
    }
    const { request } = decoded
    let reply: string
    let afterReply: (() => void) | null = null
    try {
      const handled = await this.surface.handle(request.method, request.params, connection.abort.signal)
      const result = handled instanceof AfterControlReply ? handled.result : handled
      if (handled instanceof AfterControlReply) afterReply = handled.run
      reply = encodeReply(successReply(request.id, result))
    } catch (error) {
      reply = encodeReply(errorReply(request.id, failureFrom(error)))
    }
    if (connection.abort.signal.aborted) {
      afterReply?.()
      return
    }
    connection.afterReply = afterReply
    this.answer(socket, connection, reply)
  }

  private answer(socket: SocketConnection, connection: Connection, reply: string): void {
    try {
      socket.write(reply)
      socket.end()
    } catch {
      // A client that gave up before the answer is ordinary.
      this.runAfterReply(connection)
    }
  }

  private runAfterReply(connection: Connection): void {
    const action = connection.afterReply
    connection.afterReply = null
    action?.()
  }

  private connectionFor(socket: SocketConnection): Connection {
    const existing = this.connections.get(socket as object)
    if (existing) return existing
    const connection: Connection = {
      assembler: new LineAssembler(),
      decoder: new TextDecoder(),
      abort: new AbortController(),
      afterReply: null,
    }
    this.connections.set(socket as object, connection)
    return connection
  }
}

function removeSocketFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Absent is the expected case.
  }
}
