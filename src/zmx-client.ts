import {
  clientHello,
  decodeWelcome,
  encodeFrame,
  encodeHello,
  encodeResize,
  FrameReader,
  type Frame,
  type Hello,
  ProtocolError,
  type Resize,
  Tag,
  type Welcome,
} from "./zmx-protocol.ts"

type Socket = Awaited<ReturnType<typeof Bun.connect>>

export type ZmxConnectionOptions = {
  /** Name the daemon logs for this client. */
  client?: string
  /** How long to wait for the daemon's Welcome before giving up. */
  helloTimeoutMs?: number
  /** Versions to claim instead of the pinned one; for tests of refusal only. */
  versions?: { min: number; max: number }
}

export type CloseReason = { kind: "detached" } | { kind: "peer-closed" } | { kind: "error"; error: Error }

export type OutputListener = (bytes: Uint8Array) => void
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
export class ZmxConnection {
  readonly welcome: Welcome
  private readonly outputListeners = new Set<OutputListener>()
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

  static async connect(socketPath: string, options: ZmxConnectionOptions = {}): Promise<ZmxConnection> {
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
    return new ZmxConnection(welcome, transport)
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

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener)
    if (this.closed) listener(this.closed)
    return () => this.closeListeners.delete(listener)
  }

  /** Every frame that is not Output, for callers that want the rest of the contract. */
  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener)
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

  private dispatch(frame: Frame): void {
    if (frame.tag === Tag.Output) {
      for (const listener of this.outputListeners) listener(frame.payload)
      return
    }
    for (const listener of this.frameListeners) listener(frame)
  }

  private finish(reason: CloseReason): void {
    if (this.closed) return
    this.closed = reason
    for (const listener of this.closeListeners) listener(reason)
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
  private queued = 0
  private drained: (() => void)[] = []
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
    this.queued += bytes.byteLength
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
      this.queued -= written
      if (written < head.byteLength) {
        this.queue[0] = head.subarray(written)
        return
      }
      this.queue.shift()
    }
    const waiters = this.drained
    this.drained = []
    for (const resolve of waiters) resolve()
  }

  flushed(): Promise<void> {
    if (this.queue.length === 0 || this.closeReason) return Promise.resolve()
    return new Promise((resolve) => this.drained.push(resolve))
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const socket = this.socket
    if (!socket) return
    if (this.queue.length === 0) socket.end()
    else this.drained.push(() => socket.end())
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
    this.queue = []
    this.queued = 0
    const waiters = this.drained
    this.drained = []
    for (const resolve of waiters) resolve()
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
