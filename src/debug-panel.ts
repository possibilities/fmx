import {
  bold,
  BoxRenderable,
  type CliRenderer,
  fg,
  ScrollBoxRenderable,
  StyledText,
  type TerminalColors,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { detectedTerminalColor } from "./host-palette.ts"
import { describeFrame, formatPayload, type SocketFrame } from "./socket-frames.ts"

export const DEBUG_PANEL_ENV_VAR = "FMX_DEBUG_PANEL"
export const DEBUG_PANEL_SCREEN_FRACTION = 1 / 3
/** Older entries are dropped rather than paged; this is a live tail. */
const MAX_ENTRIES = 2000
const CLEAR_LABEL = "[clear]"

const FALLBACK_COLORS = {
  foreground: "#d8dee9",
  header: "#7dd3fc",
  payload: "#9aa5b1",
  malformed: "#f87171",
  heading: "#a3a3a3",
  button: "#7dd3fc",
}

type PanelColors = typeof FALLBACK_COLORS

/** The panel exists only when its environment variable is present, at any value. */
export function debugPanelRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEBUG_PANEL_ENV_VAR] !== undefined
}

/**
 * A plain third of the screen. Narrow terminals get a cramped column rather
 * than a reserved minimum, so the embedded terminal always keeps two thirds.
 */
export function debugPanelWidth(screenWidth: number): number {
  return Math.max(1, Math.floor(screenWidth * DEBUG_PANEL_SCREEN_FRACTION))
}

/**
 * A scrollable tail of what fx reports over the agent socket, pinned to the
 * bottom so the newest frame stays visible while scrollback stays reachable.
 */
export class DebugPanel {
  readonly root: BoxRenderable
  private readonly scroll: ScrollBoxRenderable
  private readonly heading: TextRenderable
  private readonly clearLabel: TextRenderable
  private readonly entries: TextRenderable[] = []
  private colors: PanelColors = FALLBACK_COLORS
  private nextEntryId = 0

  constructor(
    private readonly renderer: CliRenderer,
    private readonly socketPath: string,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: "fmx-debug-panel",
      height: "100%",
      flexShrink: 0,
      flexDirection: "column",
      paddingLeft: 1,
    })
    const headingRow = new BoxRenderable(renderer, {
      id: "fmx-debug-panel-heading-row",
      width: "100%",
      flexDirection: "row",
      alignItems: "flex-start",
      flexShrink: 0,
    })
    this.heading = new TextRenderable(renderer, {
      id: "fmx-debug-panel-heading",
      content: this.headingText(),
      fg: FALLBACK_COLORS.heading,
      selectable: false,
      flexGrow: 1,
      flexShrink: 1,
    })
    this.clearLabel = new TextRenderable(renderer, {
      id: "fmx-debug-panel-clear-label",
      content: CLEAR_LABEL,
      fg: FALLBACK_COLORS.button,
      selectable: false,
    })
    // A box, not the label itself, owns the click: only BoxRenderable carries
    // the mouse handlers, and the hit area should cover the whole affordance.
    const clearButton = new BoxRenderable(renderer, {
      id: "fmx-debug-panel-clear",
      width: CLEAR_LABEL.length,
      height: 1,
      flexShrink: 0,
      onMouseDown: (event) => {
        // Keep the press out of the selection layer and away from fx.
        event.preventDefault()
        event.stopPropagation()
        this.clear()
      },
    })
    clearButton.add(this.clearLabel)
    this.scroll = new ScrollBoxRenderable(renderer, {
      id: "fmx-debug-panel-scroll",
      flexGrow: 1,
      flexShrink: 1,
      width: "100%",
      scrollX: false,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column" },
    })
    headingRow.add(this.heading)
    headingRow.add(clearButton)
    this.root.add(headingRow)
    this.root.add(this.scroll)
  }

  append(frame: SocketFrame): void {
    const entry = new TextRenderable(this.renderer, {
      id: `fmx-debug-frame-${this.nextEntryId++}`,
      content: this.styleFrame(frame),
      fg: this.colors.payload,
      selectable: true,
      flexShrink: 0,
    })
    this.entries.push(entry)
    this.scroll.add(entry)
    this.trim()
  }

  /** Drop the tail. The socket keeps running; only the view is emptied. */
  clear(): void {
    for (const entry of this.entries) {
      this.scroll.remove(entry)
      entry.destroy()
    }
    this.entries.length = 0
    this.scroll.scrollTop = 0
  }

  applyPalette(colors: TerminalColors | null): void {
    this.colors = panelColors(colors)
    this.heading.fg = this.colors.heading
    this.heading.content = this.headingText()
    this.clearLabel.fg = this.colors.button
  }

  setWidth(width: number): void {
    this.root.width = width
  }

  private headingText(): string {
    return `agent socket · ${this.socketPath}`
  }

  private trim(): void {
    while (this.entries.length > MAX_ENTRIES) {
      const oldest = this.entries.shift()
      if (!oldest) return
      this.scroll.remove(oldest)
      oldest.destroy()
    }
  }

  private styleFrame(frame: SocketFrame): StyledText {
    const headerColor = frame.malformed ? this.colors.malformed : this.colors.header
    const chunks: TextChunk[] = [
      bold(fg(headerColor)(describeFrame(frame))),
      fg(this.colors.payload)(`\n${formatPayload(frame)}\n`),
    ]
    return new StyledText(chunks)
  }
}

function panelColors(colors: TerminalColors | null): PanelColors {
  const foreground = detectedTerminalColor(colors?.defaultForeground) ?? FALLBACK_COLORS.foreground
  return {
    foreground,
    header:
      detectedTerminalColor(colors?.palette[6]) ??
      detectedTerminalColor(colors?.palette[14]) ??
      FALLBACK_COLORS.header,
    payload: detectedTerminalColor(colors?.palette[7]) ?? foreground,
    malformed:
      detectedTerminalColor(colors?.palette[1]) ??
      detectedTerminalColor(colors?.palette[9]) ??
      FALLBACK_COLORS.malformed,
    heading: detectedTerminalColor(colors?.palette[8]) ?? FALLBACK_COLORS.heading,
    button:
      detectedTerminalColor(colors?.palette[4]) ??
      detectedTerminalColor(colors?.palette[12]) ??
      FALLBACK_COLORS.button,
  }
}
