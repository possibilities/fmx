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
import { describeFrame, type SocketFrame } from "./socket-frames.ts"

export const DEBUG_PANEL_ENV_VAR = "FMX_DEBUG_PANEL"
export const DEBUG_PANEL_SCREEN_FRACTION = 1 / 3
/** Older entries are dropped rather than paged; this is a live tail. */
const MAX_ENTRIES = 2000

const FALLBACK_COLORS = {
  foreground: "#d8dee9",
  incoming: "#7dd3fc",
  outgoing: "#a3e635",
  payload: "#9aa5b1",
  malformed: "#f87171",
  heading: "#a3a3a3",
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
 * A scrollable tail of every frame crossing the agent socket, pinned to the
 * bottom so the newest exchange stays visible while scrollback stays reachable.
 */
export class DebugPanel {
  readonly root: BoxRenderable
  private readonly scroll: ScrollBoxRenderable
  private readonly heading: TextRenderable
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
    this.heading = new TextRenderable(renderer, {
      id: "fmx-debug-panel-heading",
      content: this.headingText(),
      fg: FALLBACK_COLORS.heading,
      selectable: false,
      flexShrink: 0,
    })
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
    this.root.add(this.heading)
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

  applyPalette(colors: TerminalColors | null): void {
    this.colors = panelColors(colors)
    this.heading.fg = this.colors.heading
    this.heading.content = this.headingText()
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
    const directionColor = frame.malformed
      ? this.colors.malformed
      : frame.direction === "in"
        ? this.colors.incoming
        : this.colors.outgoing
    const chunks: TextChunk[] = [
      bold(fg(directionColor)(describeFrame(frame))),
      fg(this.colors.payload)(`\n${frame.payload}\n`),
    ]
    return new StyledText(chunks)
  }
}

function panelColors(colors: TerminalColors | null): PanelColors {
  const foreground = detectedTerminalColor(colors?.defaultForeground) ?? FALLBACK_COLORS.foreground
  return {
    foreground,
    incoming:
      detectedTerminalColor(colors?.palette[6]) ??
      detectedTerminalColor(colors?.palette[14]) ??
      FALLBACK_COLORS.incoming,
    outgoing:
      detectedTerminalColor(colors?.palette[2]) ??
      detectedTerminalColor(colors?.palette[10]) ??
      FALLBACK_COLORS.outgoing,
    payload: detectedTerminalColor(colors?.palette[7]) ?? foreground,
    malformed:
      detectedTerminalColor(colors?.palette[1]) ??
      detectedTerminalColor(colors?.palette[9]) ??
      FALLBACK_COLORS.malformed,
    heading: detectedTerminalColor(colors?.palette[8]) ?? FALLBACK_COLORS.heading,
  }
}
