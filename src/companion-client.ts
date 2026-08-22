import {
  clientHello,
  decodeExit,
  decodeWelcome,
  encodeFrame,
  encodeHello,
  encodeResize,
  FrameReader,
  type Exit,
  type Frame,
  type Hello,
  ProtocolError,
  type Resize,
  Tag,
  type Welcome,
} from "./zmx-protocol.ts"

type Socket = Awaited<ReturnType<typeof Bun.connect>>

/**
 * Where a listener's failure goes. It cannot be returned to a caller — we are
 * inside a socket callback — and it must not take the read loop with it, so
 * it is reported here instead. The default writes to stderr; a program that
 * owns the screen should point this somewhere that does not corrupt it.
 */
let listenerErrorHandler: (error: unknown) => void = (error) => {
  console.error("companion listener failed:", error)
}

export function setListenerErrorHandler(handler: (error: unknown) => void): void {
  listenerErrorHandler = handler
}

const safely = (run: () => void): void => {
  try {
    run()
  } catch (error) {
    listenerErrorHandler(error)
  }
}

export type CompanionConnectionOptions = {
  /** Name the daemon logs for this client. */
  client?: string
  /** How long to wait for the daemon's Welcome before giving up. */
  helloTimeoutMs?: number
  /** Versions to claim instead of the pinned one; for tests of refusal only. */
  versions?: { min: number; max: number }
}

export type CloseReason = { kind: "detached" } | { kind: "peer-closed" } | { kind: "error"; error: Error }

export type OutputListener = (bytes: Uint8Array) => void
export type RestoreListener = () => void
export type ExitListener = (status: Exit) => void
export type CloseListener = (reason: CloseReason) => void
export type FrameListener = (frame: Frame) => void

/**
 * One negotiated connection to a Companion daemon's socket.
 *
 * `connect` resolves only once the daemon's Welcome has accepted this client's
 * version, so a connection that exists can be attached to. Frames go out in
 * order through one queue that honors partial writes; Output frames come in
 * through `onOutput` as the raw terminal bytes the daemon read from its PTY.
 *
 * Closing the socket is a detach, never a kill: the daemon and its child
 * outlive every connection.
 */
export class CompanionConnection {
  readonly welcome: Welcome
  private readonly outputListeners = new Set<OutputListener>()
  private readonly restoreBeginListeners = new Set<RestoreListener>()
  private readonly readyListeners = new Set<RestoreListener>()
  private readonly exitListeners = new Set<ExitListener>()
  private lastExit: Exit | null = null
  private readonly closeListeners = new Set<CloseListener>()
  private readonly frameListeners = new Set<FrameListener>()
  private closed: CloseReason | null = null

  private constructor(welcome: Welcome, private readonly transport: Transport) {
    this.welcome = welcome
    transport.bindHandlers(
      (frame) => this.dispatch(frame),
      (reason) => this.finish(reason),
    )
  }

  /**
   * Frames that arrived before anyone was listening — the daemon can put its
   * Welcome and the frames after it in one packet, and `connect` has not
   * returned yet, so no caller can have registered. They are held until the
   * first listener appears rather than dropped on the floor.
   */
  private backlog: Frame[] = []
  private backlogBytes = 0
  private static readonly BACKLOG_MAX_BYTES = 1024 * 1024

  static async connect(socketPath: string, options: CompanionConnectionOptions = {}): Promise<CompanionConnection> {
    const transport = new Transport()
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data: (_socket, data) => transport.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
        drain: () => transport.flush(),
        close: () => transport.closed({ kind: "peer-closed" }),
        error: (_socket, error) => transport.closed({ kind: "error", error }),
        connectError: (_socket, error) => transport.closed({ kind: "error", error }),
      },
    })
    transport.bind(socket)
    const hello = clientHello(options.client ?? "fmx")
    if (options.versions) {
      hello.minVersion = options.versions.min
      hello.maxVersion = options.versions.max
    }
    transport.send(encodeFrame(Tag.Hello, encodeHello(hello)))
    const welcome = await transport.awaitWelcome(options.helloTimeoutMs ?? 5000, hello)
    return new CompanionConnection(welcome, transport)
  }

  /** Attach as a terminal of this size. The daemon replies with its restore, if any, then live output. */
  attach(size: Resize): void {
    this.send(Tag.Init, encodeResize(size))
  }

  write(input: Uint8Array | string): void {
    this.send(Tag.Input, typeof input === "string" ? new TextEncoder().encode(input) : input)
  }

  resize(size: Resize): void {
    this.send(Tag.Resize, encodeResize(size))
  }

  /** Tell the daemon this client is leaving, then close. The child keeps running. */
  detach(): void {
    if (this.closed) return
    this.send(Tag.Detach)
    this.transport.end()
    this.finish({ kind: "detached" })
  }

  close(): void {
    if (this.closed) return
    this.transport.end()
    this.finish({ kind: "detached" })
  }

  /**
   * The daemon is about to replay this session's screen. Reset the terminal
   * here: what follows is state, not a continuation of what is on it, and
   * every attach — first or reconnect — is preceded by this.
   */
  onRestoreBegin(listener: RestoreListener): () => void {
    this.restoreBeginListeners.add(listener)
    this.flushBacklog()
    return () => this.restoreBeginListeners.delete(listener)
  }

  /** The replay is complete; every byte after this is live. */
  onReady(listener: RestoreListener): () => void {
    this.readyListeners.add(listener)
    this.flushBacklog()
    return () => this.readyListeners.delete(listener)
  }

  /**
   * The child ended, with exactly the status the daemon reaped. A connection
   * that closes without this says nothing about the child: it is still
   * running, and this client simply stopped watching.
   */
  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener)
    if (this.lastExit) safely(() => listener(this.lastExit!))
    this.flushBacklog()
    return () => this.exitListeners.delete(listener)
  }

  /** The exit already reported, for a caller that subscribed too late to see it. */
  get exit(): Exit | null {
    return this.lastExit
  }

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener)
    this.flushBacklog()
    return () => this.outputListeners.delete(listener)
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener)
    if (this.closed) safely(() => listener(this.closed!))
    return () => this.closeListeners.delete(listener)
  }

  /** Every frame that is not Output, for callers that want the rest of the contract. */
  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener)
    this.flushBacklog()
    return () => this.frameListeners.delete(listener)
  }

  get isClosed(): boolean {
    return this.closed !== null
  }

  /** Resolves once everything queued has been handed to the socket. */
  flushed(): Promise<void> {
    return this.transport.flushed()
  }

  private send(tag: number, payload?: Uint8Array): void {
    if (this.closed) throw new Error("zmx connection is closed")
    this.transport.send(encodeFrame(tag, payload))
  }

  private get hasListeners(): boolean {
    return (
      this.outputListeners.size > 0 ||
      this.frameListeners.size > 0 ||
      this.restoreBeginListeners.size > 0 ||
      this.readyListeners.size > 0 ||
      this.exitListeners.size > 0
    )
  }

  private dispatch(frame: Frame): void {
    if (!this.hasListeners) {
      if (this.backlogBytes + frame.payload.byteLength <= CompanionConnection.BACKLOG_MAX_BYTES) {
        this.backlog.push(frame)
        this.backlogBytes += frame.payload.byteLength
      }
      return
    }
    this.deliver(frame)
  }

  private flushBacklog(): void {
    if (this.backlog.length === 0) return
    const held = this.backlog
    this.backlog = []
    this.backlogBytes = 0
    for (const frame of held) this.deliver(frame)
  }

  /**
   * One listener's failure is its own: it must not skip the listeners after
   * it, and it must not escape into the socket's data callback, where it
   * would abort the read loop and strand frames already in the reader.
   */
  private deliver(frame: Frame): void {
    switch (frame.tag) {
      case Tag.Output:
        for (const listener of this.outputListeners) safely(() => listener(frame.payload))
        return
      case Tag.RestoreBegin:
        for (const listener of this.restoreBeginListeners) safely(() => listener())
        return
      case Tag.Ready:
        for (const listener of this.readyListeners) safely(() => listener())
        return
      case Tag.Exit: {
        let status: Exit
        try {
          status = decodeExit(frame.payload)
        } catch (error) {
          safely(() => {
            throw error
          })
          return
        }
        this.lastExit = status
        for (const listener of this.exitListeners) safely(() => listener(status))
        return
      }
      default:
        for (const listener of this.frameListeners) safely(() => listener(frame))
    }
  }

  private finish(reason: CloseReason): void {
    if (this.closed) return
    this.closed = reason
    for (const listener of this.closeListeners) safely(() => listener(reason))
  }
}

/**
 * The byte-level half: an ordered write queue that survives partial writes,
 * a FrameReader on the inbound side, and the one-time wait for Welcome.
 */
class Transport {
  private onFrame: ((frame: Frame) => void) | null = null
  private onClose: ((reason: CloseReason) => void) | null = null
  /** Frames and a close that arrived between Welcome and the handlers being bound. */
  private backlog: Frame[] = []
  private socket: Socket | null = null
  private readonly reader = new FrameReader()
  private queue: Uint8Array[] = []
  private drained: { resolve: () => void; reject: (error: Error) => void }[] = []
  private endWhenDrained = false
  private welcomeWaiter: { resolve: (w: Welcome) => void; reject: (e: Error) => void } | null = null
  private closeReason: CloseReason | null = null
  private ended = false
  private hello: Hello | null = null

  bind(socket: Socket): void {
    this.socket = socket
    this.flush()
  }

  /** Frames received since Welcome are delivered now, in order, then a close if one already happened. */
  bindHandlers(onFrame: (frame: Frame) => void, onClose: (reason: CloseReason) => void): void {
    this.onFrame = onFrame
    this.onClose = onClose
    const backlog = this.backlog
    this.backlog = []
    for (const frame of backlog) onFrame(frame)
    if (this.closeReason) onClose(this.closeReason)
  }

  send(bytes: Uint8Array): void {
    if (this.ended) return
    this.queue.push(bytes)
    this.flush()
  }

  /** Writes as much of the queue as the socket takes; the rest waits for drain. */
  flush(): void {
    const socket = this.socket
    if (!socket) return
    while (this.queue.length > 0) {
      const head = this.queue[0]!
      const written = socket.write(head)
      if (written < 0) return
      if (written < head.byteLength) {
        this.queue[0] = head.subarray(written)
        return
      }
      this.queue.shift()
    }
    const waiters = this.drained
    this.drained = []
    for (const waiter of waiters) waiter.resolve()
    if (this.endWhenDrained) {
      this.endWhenDrained = false
      socket.end()
    }
  }

  /** Rejects rather than resolves if the connection dies with bytes still queued. */
  flushed(): Promise<void> {
    if (this.closeReason) {
      return this.queue.length === 0
        ? Promise.resolve()
        : Promise.reject(new ProtocolError("connection closed with unsent bytes still queued"))
    }
    if (this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve, reject) => this.drained.push({ resolve, reject }))
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const socket = this.socket
    if (!socket) return
    if (this.queue.length === 0) socket.end()
    else this.endWhenDrained = true
  }

  receive(bytes: Uint8Array): void {
    try {
      this.reader.push(bytes)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (let frame = this.reader.next(); frame; frame = this.reader.next()) {
      if (this.welcomeWaiter) {
        this.acceptWelcome(frame)
        continue
      }
      if (this.onFrame) this.onFrame(frame)
      else this.backlog.push(frame)
    }
  }

  awaitWelcome(timeoutMs: number, hello: Hello): Promise<Welcome> {
    this.hello = hello
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new ProtocolError(`no Welcome from daemon within ${timeoutMs}ms`))
      }, timeoutMs)
      this.welcomeWaiter = {
        resolve: (welcome) => {
          clearTimeout(timer)
          resolve(welcome)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }

  closed(reason: CloseReason): void {
    if (this.closeReason) return
    this.closeReason = reason
    this.ended = true
    const dropped = this.queue.length > 0
    this.queue = []
    const waiters = this.drained
    this.drained = []
    for (const waiter of waiters) {
      if (dropped) waiter.reject(new ProtocolError("connection closed with unsent bytes still queued"))
      else waiter.resolve()
    }
    if (this.welcomeWaiter) {
      const waiter = this.welcomeWaiter
      this.welcomeWaiter = null
      waiter.reject(reason.kind === "error" ? reason.error : new ProtocolError("daemon closed the connection before Welcome"))
      return
    }
    if (this.onClose) this.onClose(reason)
  }

  private acceptWelcome(frame: Frame): void {
    const waiter = this.welcomeWaiter!
    if (frame.tag !== Tag.Welcome) {
      this.fail(new ProtocolError(`expected Welcome, daemon sent tag ${frame.tag}`))
      return
    }
    let welcome: Welcome
    try {
      welcome = decodeWelcome(frame.payload)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (welcome.version === 0) {
      const mine = this.hello ? `${this.hello.minVersion}..${this.hello.maxVersion}` : "?"
      this.fail(new ProtocolError(`daemon speaks protocol ${welcome.minVersion}..${welcome.maxVersion}; this client speaks ${mine}`))
      return
    }
    this.welcomeWaiter = null
    waiter.resolve(welcome)
  }

  private fail(error: Error): void {
    // Record the reason first: terminate() can fire `close` synchronously.
    this.closed({ kind: "error", error })
    this.socket?.terminate()
  }
}
