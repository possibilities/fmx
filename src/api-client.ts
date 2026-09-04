import type { Socket } from "bun"
import { LineBuffer } from "./line-buffer.ts"
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

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const encoder = new TextEncoder()

export type ApiClientOptions = {
  onEvent?: (event: EventFrame) => void
  onClose?: () => void
  /** A deadline fails the connection; a mutating request may already have acted. */
  timeoutMs?: number
}

/** One connection to a Runtime's API socket: requests by name, events by subscription. */
export class ApiClient {
  private readonly pending = new Map<string, Pending>()
  private readonly buffer = new LineBuffer(4 * 1024 * 1024)
  private nextId = 1
  private socket: Socket | null = null
  private closed = false
  /** Frames not yet fully written: a socket takes what it takes. */
  private outgoing: Uint8Array[] = []

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
        drain: () => client.flush(),
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
    if (this.pending.size >= 128) return Promise.reject(new ApiFailure("internal", "too many pending requests"))
    const id = String(this.nextId++)
    const frame: RequestFrame = {
      v: PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      params: (params ?? {}) as Record<string, unknown>,
    }
    const bytes = encoder.encode(encodeFrame(frame))
    if (bytes.byteLength > (1 << 20) + 1) return Promise.reject(new ApiFailure("invalid_request", "frame too large"))
    if (this.outgoing.reduce((sum, chunk) => sum + chunk.byteLength, 0) + bytes.byteLength > 4 * 1024 * 1024)
      return Promise.reject(new ApiFailure("internal", "outbound queue is full"))
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.disconnect(new ApiFailure("internal", `${method} timed out; its outcome is unknown`))
      }, this.options.timeoutMs ?? 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.outgoing.push(bytes)
      this.flush()
    })
  }

  close(): void {
    this.disconnect(new ApiFailure("internal", "connection closed"), false)
  }

  private disconnect(error: Error, notify = true): void {
    if (this.closed) return
    this.closed = true
    this.socket?.terminate()
    this.failPending(error)
    if (notify) this.options.onClose?.()
  }

  private flush(): void {
    const socket = this.socket
    if (!socket) return
    while (this.outgoing.length > 0) {
      const chunk = this.outgoing[0]!
      let written: number
      try {
        written = socket.write(chunk)
      } catch {
        this.handleClose()
        return
      }
      // A negative result is an errored or closed socket; `close` cleans up.
      if (written < 0) {
        this.handleClose()
        return
      }
      if (written < chunk.byteLength) {
        this.outgoing[0] = chunk.subarray(written)
        return
      }
      this.outgoing.shift()
    }
  }

  private data(data: Buffer): void {
    try {
      this.buffer.push(data, (line) => {
        if (line.trim().length > 0) this.handle(line)
      })
    } catch {
      this.socket?.terminate()
      this.handleClose()
    }
  }

  private handle(line: string): void {
    let frame: ResponseFrame | EventFrame
    try {
      frame = JSON.parse(line)
      if (frame?.v !== 1 || (frame.type !== "event" && frame.type !== "response")) throw new Error("invalid frame")
      if (
        frame.type === "response" &&
        ((typeof frame.id !== "string" && frame.id !== null) ||
          typeof frame.ok !== "boolean" ||
          (frame.ok && frame.id === null) ||
          (!frame.ok && (typeof frame.error?.code !== "string" || typeof frame.error?.message !== "string")))
      )
        throw new Error("invalid response")
    } catch {
      this.disconnect(new ApiFailure("internal", "invalid response frame"))
      return
    }
    if (frame.type === "event") {
      this.options.onEvent?.(frame)
      return
    }
    if (frame.type !== "response") return
    if (frame.id === null) {
      // A refusal the Runtime could not correlate: it could not tell what was
      // asked, so nothing in flight can be trusted to be answered. Failing
      // them is honest; waiting forever is not.
      if (!frame.ok) this.disconnect(new ApiFailure(frame.error.code, frame.error.message))
      return
    }
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.ok) pending.resolve(frame.result)
    else pending.reject(new ApiFailure(frame.error.code, frame.error.message))
  }

  private handleClose(): void {
    this.disconnect(new ApiFailure("internal", "connection closed"))
  }

  private failPending(error: Error = new ApiFailure("internal", "connection closed")): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.outgoing = []
    this.buffer.clear()
  }
}
