import { unlinkSync } from "node:fs"
import { userInfo } from "node:os"
import { homeId } from "./zmx-environment.ts"
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
  /** Keys the stable default path; see `defaultSocketPath`. Defaults to this process's Home. */
  homeId?: string
  path?: string
}

/**
 * Another fmx is listening on this Home's agent socket. One Home runs one
 * fmx at a time: the socket is where every surviving fx reports, and a
 * second process that unlinked it would silently take the first one's
 * instances off the air.
 */
export class AgentSocketActiveError extends Error {
  constructor(readonly path: string) {
    super(`another fmx is already running for this Home (listening on ${path})`)
  }
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
    this.path = options.path ?? defaultSocketPath(options.homeId ?? homeId())
  }

  addFrameListener(listener: FrameListener): void {
    this.listeners.add(listener)
  }

  /**
   * Bind the socket. The path is stable across runs, so a file already there
   * is either a live fmx — refused, never unlinked — or what a crashed one
   * left behind, which is cleared and replaced.
   */
  async start(): Promise<void> {
    if (this.listener) return
    if (await listenerAnswers(this.path)) throw new AgentSocketActiveError(this.path)
    removeSocketFile(this.path)
    try {
      this.listener = Bun.listen({
        unix: this.path,
        socket: {
          data: (socket, data) => this.acceptData(socket, data),
          close: (socket) => this.acceptClose(socket),
          error: (socket) => this.acceptClose(socket),
        },
      })
    } catch (error) {
      // Two fmx starting in the same instant can both find the path stale;
      // the one that loses the bind is the second fmx.
      if (isAddressInUse(error)) throw new AgentSocketActiveError(this.path)
      throw error
    }
  }

  /** Only the socket that bound the path unlinks it; a refused one never owned it. */
  close(): void {
    if (!this.listener) return
    this.listener.stop(true)
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
 * One path per Home, the same on every run, so an fx that outlives the fmx
 * that started it reports to the next one. macOS caps `sun_path` near 104
 * bytes, so the socket lives directly in the temporary directory rather than
 * under a nested per-user path; the uid keeps two users apart.
 */
export function defaultSocketPath(homeId: string, uid: number = userInfo().uid): string {
  return `/tmp/fmx-${uid}-${homeId}.sock`
}

/** Whether something accepts connections at `path`. Absent or refused is `false`. */
export async function listenerAnswers(path: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timeout = setTimeout(() => resolve(false), 500)
  try {
    const connection = await Bun.connect({
      unix: path,
      socket: {
        data: () => {},
        open: (socket) => {
          clearTimeout(timeout)
          resolve(true)
          socket.end()
        },
        error: () => resolve(false),
        connectError: () => resolve(false),
        close: () => resolve(false),
      },
    })
    connection.end()
  } catch {
    resolve(false)
  }
  clearTimeout(timeout)
  return promise
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EADDRINUSE"
}

function removeSocketFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Absent is the expected case; a stale file from a crashed run is the
    // reason to try at all.
  }
}
