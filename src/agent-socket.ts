import { unlinkSync } from "node:fs"
import { userInfo } from "node:os"
import { acquireExclusiveLock, type HeldLock } from "./file-lock.ts"
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

/** A closing fmx normally drops its singleton in a handful of milliseconds.
 * Give that handoff one bounded window so the replacement invocation can be
 * the one that attaches, without ever taking the lock from a live holder. */
const SINGLETON_HANDOFF_TIMEOUT_MS = 1_000
const SINGLETON_HANDOFF_INTERVAL_MS = 25

export type AgentSocketOptions = {
  /** Keys the stable default path; see `defaultSocketPath`. Defaults to this process's Home. */
  homeId?: string
  path?: string
}

/**
 * Another fmx is listening on this Home's agent socket. One Home runs one
 * fmx at a time: the socket is where every surviving fx reports, and a
 * second process that unlinked it would silently take the first one's
 * agents off the air.
 */
export class AgentSocketActiveError extends Error {
  constructor(readonly path: string) {
    super(`another fmx Runtime is already running for this Home (listening on ${path})`)
  }
}

export type FrameListener = (frame: SocketFrame) => void

/**
 * The Unix socket fx agents report their lifecycle to.
 *
 * One socket serves every agent: fx opens a connection per message and
 * addresses each one by pane id, so there is no per-agent connection to
 * keep. Replies are written before anything else happens with the request —
 * fx blocks its send path on our newline reply with a 250ms timeout, so any
 * work done first is latency charged directly to the agent.
 */
export class AgentSocket {
  readonly path: string
  private listener: SocketListener | null = null
  /** Held from start to close: the right to probe, unlink, and bind the path. */
  private lock: HeldLock | null = null
  private readonly assemblers = new WeakMap<object, LineAssembler>()
  private readonly listeners = new Set<FrameListener>()

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
    // The lock closes the window between "nothing answers" and "bound", in
    // which a second fmx would otherwise unlink what the first just bound.
    // It is held until close, so a live fmx is refused at the lock before
    // its socket is ever probed.
    let lock = acquireExclusiveLock(lockPathFor(this.path))
    if (lock === null) lock = await waitForSingletonHandoff(lockPathFor(this.path))
    if (lock === null) throw new AgentSocketActiveError(this.path)
    this.lock = lock ?? null
    if (await listenerAnswers(this.path)) {
      this.releaseLock()
      throw new AgentSocketActiveError(this.path)
    }
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
      this.releaseLock()
      // Without a working flock, two fmx starting in the same instant can
      // both find the path stale; the one that loses the bind is the second.
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
    this.releaseLock()
  }

  private releaseLock(): void {
    this.lock?.release()
    this.lock = null
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
    // A peer that closed mid-record may still have sent lifecycle data worth
    // processing, but there is no longer a connection to answer on.
    for (const line of assembler.flush()) {
      this.emit(decodeFrame(line))
    }
    this.assemblers.delete(socket as object)
  }

  private acceptLine(socket: SocketConnection, line: string): void {
    const request = decodeFrame(line)
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

    // The reply is fmx's own and identical every time; listeners receive only
    // what fx requested.
    this.emit(request)
  }

  private emit(frame: SocketFrame): void {
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        // One listener must never take the others or the multiplexer down.
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

export function lockPathFor(socketPath: string): string {
  return socketPath.replace(/\.sock$/, "") + ".lock"
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

/**
 * A terminal disappearing and its replacement shell starting are independent
 * processes, so the replacement can reach the flock while the old fmx is in
 * its final cleanup. Poll only the flock: it is the authority, and acquiring
 * it is the only observation that permits the caller to touch the socket.
 */
async function waitForSingletonHandoff(path: string): Promise<HeldLock | null | undefined> {
  const deadline = Date.now() + SINGLETON_HANDOFF_TIMEOUT_MS
  let lock: HeldLock | null | undefined = null
  while (lock === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SINGLETON_HANDOFF_INTERVAL_MS))
    lock = acquireExclusiveLock(path)
  }
  return lock
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
