import {
  BoxRenderable,
  type CliRenderer,
  italic,
  StyledText,
  type TerminalColors,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { hostRamp, RAMP_FALLBACK, type Ramp } from "./host-palette.ts"

export const TOAST_DURATION_MS = 3_000

const TOAST_HEIGHT = 3
const TOAST_HORIZONTAL_INSET = 1
const TOAST_CONTENT_OVERHEAD = 4
const TOAST_MIN_WIDTH = 8

/** A notice reports a failure or it does not; the words carry everything
 * else ("started", "exited"), the way fx's semantic states are all one gray. */
export type ToastTone = "neutral" | "error"

type ToastMessage = {
  text: string
  tone: ToastTone
  italic: readonly string[]
}

type ToastOptions = {
  durationMs?: number
}

type ToastTextStyle = {
  italic?: readonly string[]
}

/** A bottom-center transient notice. Messages queue so a lifecycle burst never
 * replaces an event before the human has had a chance to see it. */
export class Toast {
  readonly root: BoxRenderable

  private readonly text: TextRenderable
  private readonly durationMs: number
  private readonly queue: ToastMessage[] = []
  private ramp: Ramp = RAMP_FALLBACK
  private current: ToastMessage | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(
    private readonly renderer: CliRenderer,
    options: ToastOptions = {},
  ) {
    this.durationMs = options.durationMs ?? TOAST_DURATION_MS
    this.root = new BoxRenderable(renderer, {
      id: "fmx-toast",
      position: "absolute",
      width: TOAST_MIN_WIDTH,
      height: TOAST_HEIGHT,
      paddingX: 1,
      border: true,
      borderStyle: "single",
      borderColor: RAMP_FALLBACK.dim,
      backgroundColor: RAMP_FALLBACK.surface,
      zIndex: 50,
      visible: false,
    })
    this.text = new TextRenderable(renderer, {
      id: "fmx-toast-text",
      content: "",
      height: 1,
      fg: RAMP_FALLBACK.foreground,
      bg: RAMP_FALLBACK.surface,
      selectable: false,
    })
    this.root.add(this.text)
  }

  show(text: string, tone: ToastTone = "neutral", style: ToastTextStyle = {}): void {
    if (this.destroyed || text === "") return
    const message = { text, tone, italic: [...(style.italic ?? [])] }
    if (this.current) {
      this.queue.push(message)
      return
    }
    this.present(message)
  }

  applyPalette(colors: TerminalColors | null): void {
    this.ramp = hostRamp(colors)
    this.paint()
  }

  layout(): void {
    if (!this.current) return
    const availableWidth = Math.max(0, this.renderer.width - TOAST_HORIZONTAL_INSET * 2)
    if (availableWidth < TOAST_MIN_WIDTH || this.renderer.height < TOAST_HEIGHT) {
      this.root.visible = false
      return
    }

    const width = Math.min(this.current.text.length + TOAST_CONTENT_OVERHEAD, availableWidth)
    const contentWidth = width - TOAST_CONTENT_OVERHEAD
    this.root.width = width
    this.root.left = Math.floor((this.renderer.width - width) / 2)
    this.root.top = Math.max(0, this.renderer.height - TOAST_HEIGHT - 1)
    this.text.content = styleText(truncate(this.current.text, contentWidth), this.current.italic)
    this.root.visible = true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue.length = 0
    this.current = null
    this.root.destroy()
  }

  private present(message: ToastMessage): void {
    this.current = message
    this.paint()
    this.layout()
    this.renderer.requestRender()
    this.timer = setTimeout(() => this.advance(), this.durationMs)
  }

  private advance(): void {
    this.timer = null
    const next = this.queue.shift() ?? null
    if (next) {
      this.present(next)
      return
    }
    this.current = null
    this.root.visible = false
    this.renderer.requestRender()
  }

  /** Text on a raised surface. The toast takes no keys, so its border is a
   * dim hairline rather than the focus hue; only a failure colors it. */
  private paint(): void {
    const border = this.current?.tone === "error" ? this.ramp.error : this.ramp.dim
    this.root.backgroundColor = this.ramp.surface
    this.root.borderColor = border
    this.root.focusedBorderColor = border
    this.text.bg = this.ramp.surface
    this.text.fg = this.ramp.foreground
  }
}

function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value
  if (width === 1) return "…"
  return `${value.slice(0, width - 1)}…`
}

function styleText(value: string, italicValues: readonly string[]): string | StyledText {
  const ranges = italicValues
    .flatMap((target) => occurrences(value, target))
    .sort((left, right) => left.start - right.start)
  if (ranges.length === 0) return value

  const chunks: TextChunk[] = []
  let offset = 0
  for (const range of ranges) {
    if (range.start < offset) continue
    if (range.start > offset) chunks.push(textChunk(value.slice(offset, range.start)))
    chunks.push(italic(value.slice(range.start, range.end)))
    offset = range.end
  }
  if (offset < value.length) chunks.push(textChunk(value.slice(offset)))
  return new StyledText(chunks)
}

function occurrences(value: string, target: string): Array<{ start: number; end: number }> {
  if (target === "") return []
  const ranges: Array<{ start: number; end: number }> = []
  let start = value.indexOf(target)
  while (start !== -1) {
    ranges.push({ start, end: start + target.length })
    start = value.indexOf(target, start + target.length)
  }
  return ranges
}

function textChunk(text: string): TextChunk {
  return { __isChunk: true, text }
}
