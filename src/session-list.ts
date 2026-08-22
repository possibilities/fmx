import {
  BoxRenderable,
  type CliRenderer,
  fg,
  StyledText,
  type TerminalColors,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import type { AgentAttention, DisplayState } from "./agent-registry.ts"
import { detectedTerminalColor, mixHexColors } from "./host-palette.ts"

/** How far the active row's background sits from the terminal's own. */
const ACTIVE_ROW_BLEND = 0.12
const ICON_COLUMN = 2
/** Inset the text; the row's shading still spans the full sidebar width. */
const ROW_PADDING_LEFT = 1
const MISSING_SESSION = "—"

const FALLBACK_COLORS = {
  foreground: "#d8dee9",
  blocked: "#f87171",
  working: "#facc15",
  done: "#2dd4bf",
  idle: "#4ade80",
  unknown: "#6b7280",
  session: "#9aa5b1",
  activeBackground: "#2a2f3a",
}

type ListColors = typeof FALLBACK_COLORS

/**
 * One row's worth of what the list needs. The multiplexer assembles these:
 * `project` and `active` are its own, `state` and `attention` come from what fx
 * reported.
 */
export type SessionRow = {
  instanceId: number
  project: string
  sessionId: string | null
  state: DisplayState
  attention: AgentAttention | null
  active: boolean
}

/**
 * The icon carries the whole status. A blocked pane varies its glyph by what
 * fx is waiting for, which is possible only because fx sends `custom_status`
 * and fmx keeps it.
 */
export function stateIcon(state: DisplayState, attention: AgentAttention | null): string {
  switch (state) {
    case "blocked":
      switch (attention) {
        case "question":
          return "?"
        case "recovery":
          return "↻"
        default:
          return "×"
      }
    case "working":
      return "◐"
    case "done":
      return "✓"
    case "idle":
      return "○"
    case "unknown":
      return "·"
  }
}

/**
 * Lay a row out to `width`. Text is only ever cut at the right-hand end of the
 * row, so an ellipsis never appears mid-line: the project keeps its full
 * length and the session id, which trails it, takes whatever is left.
 */
export function layoutRow(row: SessionRow, width: number): { project: string; session: string } {
  const available = width - ICON_COLUMN
  if (available <= 0) return { project: "", session: "" }

  const session = row.sessionId ?? MISSING_SESSION
  // A project long enough to fill the row is itself the last thing on the
  // line, so it takes the ellipsis and the id has nowhere to go.
  const sessionRoom = available - row.project.length - 1
  if (sessionRoom <= 0) return { project: truncate(row.project, available), session: "" }
  return { project: row.project, session: truncate(session, sessionRoom) }
}

function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  const characters = [...value]
  if (characters.length <= width) return value
  if (width === 1) return "…"
  return `${characters.slice(0, width - 1).join("")}…`
}

/**
 * The sidebar's list of fx instances: one row each, status in the icon, the
 * active row shaded. Clicking a row makes that instance the visible one.
 */
export class SessionList {
  readonly root: BoxRenderable
  private colors: ListColors = FALLBACK_COLORS
  private rows: BoxRenderable[] = []

  constructor(
    private readonly renderer: CliRenderer,
    private readonly onSelect: (instanceId: number) => void,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: "fmx-session-list",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    })
  }

  render(rows: SessionRow[], width: number): void {
    this.clearRows()
    for (const row of rows) this.rows.push(this.buildRow(row, width))
    for (const rendered of this.rows) this.root.add(rendered)
    this.renderer.requestRender()
  }

  applyPalette(colors: TerminalColors | null): void {
    this.colors = listColors(colors)
  }

  private clearRows(): void {
    for (const rendered of this.rows) {
      this.root.remove(rendered)
      rendered.destroy()
    }
    this.rows = []
  }

  private buildRow(row: SessionRow, width: number): BoxRenderable {
    const container = new BoxRenderable(this.renderer, {
      id: `fmx-session-row-${row.instanceId}`,
      width: "100%",
      height: 1,
      flexShrink: 0,
      paddingLeft: ROW_PADDING_LEFT,
      backgroundColor: row.active ? this.colors.activeBackground : undefined,
      onMouseDown: (event) => {
        // The press selects a pane; it must not start a drag selection or
        // reach the embedded terminal underneath.
        event.preventDefault()
        event.stopPropagation()
        this.onSelect(row.instanceId)
      },
    })
    container.add(
      new TextRenderable(this.renderer, {
        id: `fmx-session-row-text-${row.instanceId}`,
        content: this.styleRow(row, width),
        selectable: false,
      }),
    )
    return container
  }

  private styleRow(row: SessionRow, width: number): StyledText {
    const { project, session } = layoutRow(row, width - ROW_PADDING_LEFT)
    const chunks: TextChunk[] = [
      fg(this.stateColor(row.state))(`${stateIcon(row.state, row.attention)} `),
      fg(this.colors.foreground)(project),
    ]
    if (session) chunks.push(fg(this.colors.session)(`${project ? " " : ""}${session}`))
    return new StyledText(chunks)
  }

  private stateColor(state: DisplayState): string {
    return this.colors[state]
  }
}

function listColors(colors: TerminalColors | null): ListColors {
  const foreground = detectedTerminalColor(colors?.defaultForeground) ?? FALLBACK_COLORS.foreground
  const background = detectedTerminalColor(colors?.defaultBackground)
  return {
    foreground,
    blocked: ansi(colors, 1, 9) ?? FALLBACK_COLORS.blocked,
    working: ansi(colors, 3, 11) ?? FALLBACK_COLORS.working,
    done: ansi(colors, 6, 14) ?? FALLBACK_COLORS.done,
    idle: ansi(colors, 2, 10) ?? FALLBACK_COLORS.idle,
    unknown: ansi(colors, 8, 7) ?? FALLBACK_COLORS.unknown,
    session: ansi(colors, 8, 7) ?? FALLBACK_COLORS.session,
    activeBackground:
      background && foreground
        ? mixHexColors(background, foreground, ACTIVE_ROW_BLEND)
        : FALLBACK_COLORS.activeBackground,
  }
}

/** Prefer the normal ANSI slot, fall back to its bright twin. */
function ansi(colors: TerminalColors | null, index: number, bright: number): string | null {
  return (
    detectedTerminalColor(colors?.palette[index]) ?? detectedTerminalColor(colors?.palette[bright])
  )
}
