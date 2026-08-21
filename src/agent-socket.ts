import { unlinkSync } from "node:fs"
import {
  decodeFrame,
  errorReply,
  LineAssembler,
  successReply,
  type SocketFrame,
} from "./socket-frames.ts"

type SocketListener = ReturnType<typeof Bun.listen>
type SocketConnection = { write: (data: string) => unknown }

export type AgentSocketOptions = {
  path?: string
}

export type FrameListener = (frame: SocketFrame) => void

/**
 * The Unix socket fx instances report their lifecycle to.
 *
 * One socket serves every instance: fx opens a connection per message and
 * addresses each one by pane id, so there is no per-instance connection to
 * keep. Replies are written before anything else happens with the request —
 * fx blocks its send path on our newline reply with a 250ms timeout, so any
 * work done first is latency charged directly to the agent.
 */
export class AgentSocket {
  readonly path: string
  private listener: SocketListener | null = null
  private readonly assemblers = new WeakMap<object, LineAssembler>()
  private readonly listeners = new Set<FrameListener>()
  private seq = 0

  constructor(options: AgentSocketOptions = {}) {
    this.path = options.path ?? defaultSocketPath()
  }

  addFrameListener(listener: FrameListener): void {
    this.listeners.add(listener)
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
  }

  close(): void {
    this.listener?.stop(true)
    this.listener = null
    removeSocketFile(this.path)
  }

  /**
   * fx treats the pane id as an opaque string. The `p_<n>` shape keeps it
   * parseable by herdr-compatible tooling without costing anything here.
   */
  paneIdFor(instanceId: number): string {
    return `p_${instanceId}`
  }

  private acceptData(socket: SocketConnection, data: Uint8Array): void {
    const assembler = this.assemblerFor(socket)
    for (const line of assembler.push(new TextDecoder().decode(data))) {
      this.acceptLine(socket, line)
    }
  }

  private acceptClose(socket: SocketConnection): void {
    const assembler = this.assemblers.get(socket as object)
    if (!assembler) return
    // A peer that closed mid-record leaves bytes worth showing, but there is
    // no longer a connection to answer on.
    for (const line of assembler.flush()) {
      this.emit(decodeFrame(this.seq++, Date.now(), line))
    }
    this.assemblers.delete(socket as object)
  }

  private acceptLine(socket: SocketConnection, line: string): void {
    const request = decodeFrame(this.seq++, Date.now(), line)
    const reply = request.malformed
      ? errorReply(request.requestId, "invalid_request", "expected one JSON object per line")
      : successReply(request.requestId)

    // Reply first, unconditionally: a handler that throws must not leave fx
    // waiting out its timeout.
    try {
      socket.write(reply)
    } catch {
      // A peer that vanished mid-exchange is ordinary; fx ignores send
      // failures on its side too.
    }

    // The reply is fmx's own and identical every time; only fx's request is
    // worth reporting.
    this.emit(request)
  }

  private emit(frame: SocketFrame): void {
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        // Observation must never take the multiplexer down.
      }
    }
  }

  private assemblerFor(socket: SocketConnection): LineAssembler {
    const existing = this.assemblers.get(socket as object)
    if (existing) return existing
    const assembler = new LineAssembler()
    this.assemblers.set(socket as object, assembler)
    return assembler
  }
}

/**
 * macOS caps `sun_path` near 104 bytes, so the socket lives directly in the
 * temporary directory rather than under a nested per-user path.
 */
export function defaultSocketPath(pid = process.pid): string {
  return `/tmp/fmx-${pid}.sock`
}

function removeSocketFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Absent is the expected case; a stale file from a crashed run is the
    // reason to try at all.
  }
}
