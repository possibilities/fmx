import {
  HandlerRelay,
  SessionEndedError,
  type SessionStart,
  type SessionTransport,
  type SessionTransportFactory,
  type TerminalSize,
  type TransportHandlers,
} from "../../src/session-transport.ts"
import type { SessionIdentity } from "../../src/session-identity.ts"

/**
 * A Bun PTY behind the Session transport seam, for the renderer's tests: the
 * Runtime suites can start a fake program and watch it without a Companion on
 * the machine. It is a test fixture and nothing more — a detach here ends the
 * process, because a test must not leak one, where the Companion's detach
 * leaves it running.
 */
export class PtyTransportFactory implements SessionTransportFactory {
  readonly started: PtyTransport[] = []
  /** How many times `attach` was asked, per Session. */
  readonly attaches = new Map<string, number>()
  /**
   * What `attach` does. A PTY cannot be re-attached, so by default an attach
   * says the Session ended; a test of the unreachable path makes it fail some
   * other way, and one of the recovered path hands back the PTY it lost.
   */
  attachBehavior:
    | "ended"
    | "unreachable"
    | ((identity: SessionIdentity) => SessionTransport | Promise<SessionTransport>) = "ended"
  /** Holds every `start` until released; for tests of what happens before `adopt`. */
  gate: Promise<void> | null = null

  async start(request: SessionStart): Promise<SessionTransport> {
    const transport = new PtyTransport(request)
    this.started.push(transport)
    if (this.gate) await this.gate
    return transport
  }

  async attach(identity: SessionIdentity): Promise<SessionTransport> {
    this.attaches.set(identity.name, (this.attaches.get(identity.name) ?? 0) + 1)
    if (this.attachBehavior === "ended") throw new SessionEndedError(identity, null)
    if (this.attachBehavior === "unreachable") throw new Error("the Companion is not answering")
    return this.attachBehavior(identity)
  }

  /** The transport a Session was started with, by name. */
  forName(name: string): PtyTransport | undefined {
    return this.started.find((transport) => transport.request.identity.name === name)
  }
}

export class PtyTransport implements SessionTransport {
  private readonly relay = new HandlerRelay()
  private readonly process: ReturnType<typeof Bun.spawn>
  private closed = false
  /** The last size the Session asked for. */
  lastResize: TerminalSize | null = null

  constructor(readonly request: SessionStart) {
    this.process = Bun.spawn(request.command, {
      cwd: request.cwd,
      env: request.env,
      terminal: {
        cols: request.size.cols,
        rows: request.size.rows,
        data: (_pty, data) => this.relay.emit((handlers) => handlers.output(data)),
      },
    })
    void this.process.exited.then((code) => {
      if (this.closed) return
      this.closed = true
      const signal = this.process.signalCode ? 1 : 0
      this.relay.emit((handlers) => handlers.exit({ code, signal, reason: "natural" }))
      try {
        this.process.terminal?.close()
      } catch {
        // Already closed.
      }
    })
  }

  get pid(): number {
    return this.process.pid
  }

  /** Simulate the transport going away under a running process. */
  lose(error = new Error("transport lost")): void {
    if (this.closed) return
    this.closed = true
    try {
      this.process.terminal?.close()
    } catch {
      // Already closed.
    }
    this.relay.emit((handlers) => handlers.lost(error))
    this.relay.stop()
  }

  bind(handlers: TransportHandlers): void {
    this.relay.bind(handlers)
  }

  write(bytes: Uint8Array): void {
    if (this.closed) return
    try {
      this.process.terminal?.write(bytes)
    } catch {
      // The process is on its way out; the exit will say so.
    }
  }

  resize(size: TerminalSize): void {
    if (this.closed) return
    this.lastResize = size
    try {
      this.process.terminal?.resize(size.cols, size.rows)
    } catch {
      // A resize racing the exit is harmless.
    }
  }

  detach(): void {
    if (this.closed) return
    this.closed = true
    this.relay.stop()
    try {
      this.process.terminal?.close()
    } catch {
      // Already closed.
    }
    try {
      this.process.kill("SIGKILL")
    } catch {
      // Already gone.
    }
  }
}
