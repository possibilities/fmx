import {
  HandlerRelay,
  type AgentLaunch,
  type AgentTransport,
  type AgentTransportFactory,
  type TerminalSize,
  type TransportHandlers,
} from "../src/agent-transport.ts"
import type { ManifestEntry } from "../src/agent-manifest.ts"

const encoder = new TextEncoder()

export class GalleryTransport implements AgentTransport {
  private readonly relay = new HandlerRelay()
  readonly writes: Uint8Array[] = []
  readonly sizes: TerminalSize[] = []
  detached = false

  bind(handlers: TransportHandlers): void {
    this.relay.bind(handlers)
  }

  write(bytes: Uint8Array): void {
    this.writes.push(bytes.slice())
  }

  resize(size: TerminalSize): void {
    this.sizes.push({ ...size })
  }

  detach(): void {
    this.detached = true
    this.relay.stop()
  }

  restoreBegin(): void {
    this.relay.emit((handlers) => handlers.restoreBegin())
  }

  output(text: string): void {
    this.relay.emit((handlers) => handlers.output(encoder.encode(text)))
  }

  ready(): void {
    this.relay.emit((handlers) => handlers.ready())
  }

  exit(code = 0, signal = 0): void {
    this.relay.emit((handlers) => handlers.exit({ code, signal }))
  }

  lose(message = "the Companion connection closed"): void {
    this.relay.emit((handlers) => handlers.lost(new Error(message)))
  }
}

export class GalleryAgentTransportFactory implements AgentTransportFactory {
  readonly transports: GalleryTransport[] = []

  constructor(
    private readonly screen: string,
    private readonly onStart?: (launch: AgentLaunch) => void,
  ) {}

  start(launch: AgentLaunch): Promise<AgentTransport> {
    this.onStart?.(launch)
    return Promise.resolve(this.transport())
  }

  attach(_entry: ManifestEntry, _size: TerminalSize): Promise<AgentTransport> {
    return Promise.resolve(this.transport())
  }

  private transport(): GalleryTransport {
    const transport = new GalleryTransport()
    transport.restoreBegin()
    transport.output(this.screen)
    transport.ready()
    this.transports.push(transport)
    return transport
  }
}

export class RejectingAgentTransportFactory implements AgentTransportFactory {
  start(_launch: AgentLaunch): Promise<AgentTransport> {
    return Promise.reject(new Error("ENOENT: fx executable was not found"))
  }

  attach(_entry: ManifestEntry, _size: TerminalSize): Promise<AgentTransport> {
    return Promise.reject(new Error("the Agent cannot be reached"))
  }
}
