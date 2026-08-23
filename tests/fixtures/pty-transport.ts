import { InstanceManifest, type ManifestEntry } from "../../src/instance-manifest.ts"
import {
  HandlerRelay,
  InstanceEndedError,
  type InstanceLaunch,
  type InstanceTransport,
  type InstanceTransportFactory,
  type TerminalSize,
  type TransportHandlers,
} from "../../src/instance-transport.ts"

/**
 * A Bun PTY behind the Instance transport seam, for the renderer's tests:
 * the multiplexer suites can start a fake fx and watch it without a
 * Companion on the machine. It is a test fixture and nothing more — a
 * detach here ends the process, because a test must not leak one, where
 * the Companion's detach leaves fx running.
 */
export class PtyTransportFactory implements InstanceTransportFactory {
  readonly started: PtyTransport[] = []
  /** How many times `attach` was asked, per Instance. */
  readonly attaches = new Map<string, number>()
  /**
   * What `attach` does. A PTY cannot be re-attached, so by default an
   * attach says the Instance ended; a test of the unreachable path makes it
   * fail some other way, and one of the recovered path hands back the PTY
   * it lost.
   */
  attachBehavior: "ended" | "unreachable" | ((entry: ManifestEntry) => InstanceTransport) = "ended"
  /** Holds every `start` until released; for tests of what happens before `adopt`. */
  gate: Promise<void> | null = null

  async start(launch: InstanceLaunch): Promise<InstanceTransport> {
    const transport = new PtyTransport(launch)
    this.started.push(transport)
    if (this.gate) await this.gate
    return transport
  }

  async attach(entry: ManifestEntry): Promise<InstanceTransport> {
    this.attaches.set(entry.instanceId, (this.attaches.get(entry.instanceId) ?? 0) + 1)
    if (this.attachBehavior === "ended") throw new InstanceEndedError(entry, null)
    if (this.attachBehavior === "unreachable") throw new Error("the Companion is not answering")
    return this.attachBehavior(entry)
  }
}

export class PtyTransport implements InstanceTransport {
  private readonly relay = new HandlerRelay()
  private readonly process: ReturnType<typeof Bun.spawn>
  private closed = false
  /** The last size the Instance asked for. */
  lastResize: TerminalSize | null = null
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

  constructor(launch: InstanceLaunch) {
    this.process = Bun.spawn(launch.command, {
      cwd: launch.cwd,
      env: launch.env,
      terminal: {
        cols: launch.size.cols,
        rows: launch.size.rows,
        data: (_pty, data) => this.relay.emit((handlers) => handlers.output(data)),
      },
    })
    void this.process.exited.then((code) => {
      if (this.closed) return
      this.closed = true
      const signal = this.process.signalCode ? 1 : 0
      this.relay.emit((handlers) => handlers.exit({ code, signal }))
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

/** The two options every multiplexer test needs and none cares about: a Manifest nothing writes, a PTY behind the seam. */
export function instanceOptions(): { manifest: InstanceManifest; transport: PtyTransportFactory } {
  return { manifest: InstanceManifest.ephemeral("test"), transport: new PtyTransportFactory() }
}
