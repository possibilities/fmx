import {
  BoxRenderable,
  type CliRenderer,
  italic,
  StyledText,
  type TerminalColors,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { detectedTerminalColor, mixHexColors } from "./host-palette.ts"

export const TOAST_DURATION_MS = 3_000

const TOAST_HEIGHT = 3
const TOAST_HORIZONTAL_INSET = 1
const TOAST_CONTENT_OVERHEAD = 4
const TOAST_MIN_WIDTH = 8
const TOAST_SURFACE_BLEND = 0.12

const FALLBACK_COLORS = {
  background: "#2a2f3a",
  border: "#6b7280",
  foreground: "#d8dee9",
  success: "#4ade80",
  error: "#f87171",
}

export type ToastTone = "success" | "neutral" | "error"

type ToastMessage = {
  text: string
  tone: ToastTone
  italic: readonly string[]
}

type ToastColors = typeof FALLBACK_COLORS

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
  private colors: ToastColors = FALLBACK_COLORS
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
      borderColor: FALLBACK_COLORS.border,
      backgroundColor: FALLBACK_COLORS.background,
      zIndex: 50,
      visible: false,
    })
    this.text = new TextRenderable(renderer, {
      id: "fmx-toast-text",
      content: "",
      height: 1,
      fg: FALLBACK_COLORS.foreground,
      bg: FALLBACK_COLORS.background,
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
    this.colors = toastColors(colors)
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

  private paint(): void {
    const tone = this.current?.tone ?? "neutral"
    const signal =
      tone === "success" ? this.colors.success : tone === "error" ? this.colors.error : this.colors.border
    this.root.backgroundColor = this.colors.background
    this.root.borderColor = signal
    this.root.focusedBorderColor = signal
    this.text.bg = this.colors.background
    this.text.fg = tone === "neutral" ? this.colors.foreground : signal
  }
}

function toastColors(colors: TerminalColors | null): ToastColors {
  const foreground = detectedTerminalColor(colors?.defaultForeground) ?? FALLBACK_COLORS.foreground
  const background = detectedTerminalColor(colors?.defaultBackground)
  return {
    foreground,
    background: background
      ? mixHexColors(background, foreground, TOAST_SURFACE_BLEND)
      : FALLBACK_COLORS.background,
    border: ansi(colors, 8, 7) ?? FALLBACK_COLORS.border,
    success: ansi(colors, 2, 10) ?? FALLBACK_COLORS.success,
    error: ansi(colors, 1, 9) ?? FALLBACK_COLORS.error,
  }
}

function ansi(colors: TerminalColors | null, normal: number, bright: number): string | null {
  return detectedTerminalColor(colors?.palette[normal]) ?? detectedTerminalColor(colors?.palette[bright])
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
