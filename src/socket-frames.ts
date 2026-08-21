/**
 * Decoding for the line-delimited JSON that fx instances report over fmx's
 * agent socket. Pure: no I/O, no renderer, no process state.
 *
 * fx opens a fresh connection per message, writes one newline-terminated
 * request, waits up to 250ms for one newline-terminated reply, then closes.
 * The frame types here describe both halves of that exchange.
 */

export type FrameDirection = "in" | "out"

export type SocketFrame = {
  seq: number
  at: number
  direction: FrameDirection
  paneId: string | null
  method: string | null
  requestId: string | null
  payload: string
  malformed: boolean
}

/** Longer lines are truncated for display; fx's own send buffer is 1KiB. */
const MAX_PAYLOAD_CHARS = 4096
/** A peer that never sends a newline must not grow the buffer without bound. */
const MAX_PENDING_CHARS = 64 * 1024

/**
 * Reassembles newline-delimited records from arbitrary chunk boundaries. fx
 * sends exactly one line per connection, so this is defensive rather than
 * load-bearing — but a partial write must not be decoded as a whole record.
 */
export class LineAssembler {
  private pending = ""

  push(chunk: string): string[] {
    if (this.pending.length + chunk.length > MAX_PENDING_CHARS) {
      this.pending = ""
      return []
    }
    this.pending += chunk
    const lines: string[] = []
    let newline = this.pending.indexOf("\n")
    while (newline !== -1) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      if (line.trim().length > 0) lines.push(line)
      newline = this.pending.indexOf("\n")
    }
    return lines
  }

  /** Any bytes left when a peer closes without a trailing newline. */
  flush(): string[] {
    const remainder = this.pending.trim()
    this.pending = ""
    return remainder.length > 0 ? [remainder] : []
  }
}

export function decodeFrame(seq: number, at: number, direction: FrameDirection, line: string): SocketFrame {
  const payload = truncatePayload(line.trim())
  const frame: SocketFrame = {
    seq,
    at,
    direction,
    paneId: null,
    method: null,
    requestId: null,
    payload,
    malformed: false,
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ...frame, malformed: true }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...frame, malformed: true }
  }

  const record = parsed as Record<string, unknown>
  return {
    ...frame,
    requestId: readString(record.id),
    method: readString(record.method),
    paneId: readPaneId(record.params),
  }
}

/**
 * fx addresses every request to a pane. Both `pane_id` and `target` appear:
 * `agent.rename` names the pane through `target`, everything else uses
 * `pane_id`.
 */
function readPaneId(params: unknown): string | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null
  const record = params as Record<string, unknown>
  return readString(record.pane_id) ?? readString(record.target)
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function truncatePayload(payload: string): string {
  return payload.length > MAX_PAYLOAD_CHARS ? `${payload.slice(0, MAX_PAYLOAD_CHARS)}…` : payload
}

/** herdr's reply shape: a string id and a result object, newline-terminated. */
export function successReply(requestId: string | null): string {
  return `${JSON.stringify({ id: requestId ?? "", result: {} })}\n`
}

export function errorReply(requestId: string | null, code: string, message: string): string {
  return `${JSON.stringify({ id: requestId ?? "", error: { code, message } })}\n`
}

export function formatFrameTime(at: number): string {
  const time = new Date(at)
  const hours = String(time.getHours()).padStart(2, "0")
  const minutes = String(time.getMinutes()).padStart(2, "0")
  const seconds = String(time.getSeconds()).padStart(2, "0")
  const millis = String(time.getMilliseconds()).padStart(3, "0")
  return `${hours}:${minutes}:${seconds}.${millis}`
}

export function frameArrow(direction: FrameDirection): string {
  return direction === "in" ? "◀" : "▶"
}

/** Header line for the debug panel: when, which way, which pane, what. */
export function describeFrame(frame: SocketFrame): string {
  const pane = frame.paneId ?? "—"
  const method = frame.malformed ? "malformed" : (frame.method ?? "reply")
  return `${formatFrameTime(frame.at)} ${frameArrow(frame.direction)} ${pane} ${method}`
}
