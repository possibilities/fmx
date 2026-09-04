import type { Socket } from "bun"
import {
  ApiFailure,
  encodeFrame,
  type EventFrame,
  METHODS,
  type Method,
  type Params,
  PROTOCOL_VERSION,
  type RequestFrame,
  type ResponseFrame,
  type Result,
} from "./protocol.ts"

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export type ApiClientOptions = {
  onEvent?: (event: EventFrame) => void
  onClose?: () => void
}

/** One connection to a Runtime's API socket: requests by name, events by subscription. */
export class ApiClient {
  private readonly pending = new Map<string, Pending>()
  private buffer = ""
  private nextId = 1
  private socket: Socket | null = null
  private closed = false

  private constructor(private readonly options: ApiClientOptions) {}

  static async connect(path: string, options: ApiClientOptions = {}): Promise<ApiClient> {
    const client = new ApiClient(options)
    const opened = Promise.withResolvers<void>()
    // A missing socket makes Bun.connect throw and fire connectError, which
    // rejects `opened` too; without a listener that second rejection is
    // reported as unhandled even though the caller catches the first.
    opened.promise.catch(() => {})
    client.socket = await Bun.connect({
      unix: path,
      socket: {
        open: () => opened.resolve(),
        data: (_socket, data) => client.data(data),
        close: () => client.handleClose(),
        error: () => client.handleClose(),
        connectError: (_socket, error) => {
          opened.reject(error)
          client.handleClose()
        },
      },
    })
    await opened.promise
    return client
  }

  /** Connect, retrying until `retryMs` passes: a Runtime binds its socket a moment after it exists. */
  static async connectWithRetry(path: string, options: ApiClientOptions = {}, retryMs = 10_000): Promise<ApiClient> {
    const deadline = Date.now() + retryMs
    for (;;) {
      try {
        return await ApiClient.connect(path, options)
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await Bun.sleep(50)
      }
    }
  }

  async request<M extends Method>(method: M, params?: Params<M>): Promise<Result<M>> {
    const raw = await this.call(method, params)
    const checked = METHODS[method].result.safeParse(raw)
    if (!checked.success) {
      throw new ApiFailure("internal", `${method} returned an unexpected result: ${checked.error.message}`)
    }
    return checked.data as Result<M>
  }

  /** One request by name, unchecked. */
  call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed || !this.socket) return Promise.reject(new ApiFailure("internal", "not connected"))
    const id = String(this.nextId++)
    const frame: RequestFrame = {
      v: PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      params: (params ?? {}) as Record<string, unknown>,
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket!.write(encodeFrame(frame))
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket?.end()
    this.failPending()
  }

  private data(data: Buffer): void {
    this.buffer += data.toString("utf8")
    let newline = this.buffer.indexOf("\n")
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) this.handle(line)
      newline = this.buffer.indexOf("\n")
    }
  }

  private handle(line: string): void {
    let frame: ResponseFrame | EventFrame
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (frame.type === "event") {
      this.options.onEvent?.(frame)
      return
    }
    if (frame.type !== "response" || frame.id === null) return
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    if (frame.ok) pending.resolve(frame.result)
    else pending.reject(new ApiFailure(frame.error.code, frame.error.message))
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    this.failPending()
    this.options.onClose?.()
  }

  private failPending(): void {
    for (const pending of this.pending.values()) pending.reject(new ApiFailure("internal", "connection closed"))
    this.pending.clear()
  }
}
