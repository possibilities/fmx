import {
  bold,
  BoxRenderable,
  type CliRenderer,
  fg,
  italic,
  RGBA,
  StyledText,
  type TerminalColors,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import type { AgentAttention, DisplayState } from "./agent-registry.ts"
import { detectedTerminalColor, mixHexColors } from "./host-palette.ts"
import { indentFor, type TreeRow } from "./session-tree.ts"

/** How far the active row's background sits from the terminal's own. */
const ACTIVE_ROW_BLEND = 0.12
/** Pull synthetic labels slightly toward a dark background so they read light gray. */
const VIRTUAL_LABEL_BACKGROUND_BLEND = 0.22
/** Inset the text; the row's shading still spans the full sidebar width. */
const ROW_PADDING_LEFT = 1
const ICON_COLUMN = 2
const MISSING_SESSION = "—"
/** Let the terminal render its own ANSI gray from the first frame. Unlike an
 * RGB fallback, this does not change when palette detection finishes. */
const SESSION_COLOR = RGBA.fromIndex(8)

const FALLBACK_COLORS = {
  foreground: "#d8dee9",
  blocked: "#f87171",
  working: "#facc15",
  done: "#2dd4bf",
  idle: "#4ade80",
  unknown: "#6b7280",
  session: SESSION_COLOR,
  virtual: "#b0b6c2",
  activeBackground: "#2a2f3a",
}

type ListColors = typeof FALLBACK_COLORS

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
 * Text is only ever cut at the right-hand end of a row, so an ellipsis never
 * appears mid-line.
 */
export function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  const characters = [...value]
  if (characters.length <= width) return value
  if (width === 1) return "…"
  return `${characters.slice(0, width - 1).join("")}…`
}

/** What a row's text is, once its rails and icon have taken their columns. */
export function rowText(row: TreeRow, width: number): string {
  const available = width - ROW_PADDING_LEFT - indentFor(row.depth).length
  if (!isAgentRow(row)) return truncate(row.label, available)
  return truncate(row.label || MISSING_SESSION, available - ICON_COLUMN)
}

/**
 * The sidebar's tree of fx instances: project, branch, and one row per agent.
 * The active row is filled; the rails on the path up to it are drawn in the
 * foreground while every other rail stays dim.
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

  render(rows: TreeRow[], width: number): void {
    this.clearRows()
    for (const [index, row] of rows.entries()) this.rows.push(this.buildRow(row, width, index))
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

  private buildRow(row: TreeRow, width: number, index: number): BoxRenderable {
    const id = row.instanceId !== null ? `agent-${row.instanceId}` : `${row.kind}-${index}`
    const container = new BoxRenderable(this.renderer, {
      id: `fmx-session-row-${id}`,
      width: "100%",
      height: 1,
      flexShrink: 0,
      paddingLeft: ROW_PADDING_LEFT,
      // Only the active row is filled. Its ancestors are marked by their
      // rails, so two faint backgrounds never have to be told apart.
      backgroundColor: row.active ? this.colors.activeBackground : undefined,
      onMouseDown: (event) => {
        // Keep the press local to the sidebar while its text child starts an
        // ordinary host selection.
        event.preventDefault()
        event.stopPropagation()
      },
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        // OpenTUI marks a gesture as no longer at its start once it has become
        // a drag. Navigate only for a click so selecting an inactive row does
        // not rebuild the list in the middle of the selection gesture.
        const selection = this.renderer.getSelection()
        if (row.instanceId !== null && (!selection || selection.isStart)) this.onSelect(row.instanceId)
      },
    })
    container.add(
      new TextRenderable(this.renderer, {
        id: `fmx-session-row-text-${id}`,
        content: this.styleRow(row, width),
        selectable: true,
      }),
    )
    return container
  }

  private styleRow(row: TreeRow, width: number): StyledText {
    const chunks: TextChunk[] = [fg(this.colors.foreground)(indentFor(row.depth))]
    if (isAgentRow(row)) {
      chunks.push(fg(this.colors[row.state])(`${stateIcon(row.state, row.attention)} `))
      chunks.push(fg(this.colors.session)(rowText(row, width)))
      return new StyledText(chunks)
    }
    // With no rails to brighten, an ancestor of the active agent is marked by
    // weight instead: the path still reads without costing a column. Virtual
    // branches stay light gray, italic, and unbolded even on that path.
    const label = fg(row.virtual ? this.colors.virtual : this.colors.foreground)(rowText(row, width))
    chunks.push(row.virtual ? italic(label) : row.onPath ? bold(label) : label)
    return new StyledText(chunks)
  }
}

function isAgentRow(row: TreeRow): boolean {
  return row.kind === "agent" || row.kind === "subagent"
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
    session: SESSION_COLOR,
    virtual:
      background && colorBrightness(background) < colorBrightness(foreground)
        ? mixHexColors(foreground, background, VIRTUAL_LABEL_BACKGROUND_BLEND)
        : background
          ? foreground
          : FALLBACK_COLORS.virtual,
    activeBackground:
      background && foreground
        ? mixHexColors(background, foreground, ACTIVE_ROW_BLEND)
        : FALLBACK_COLORS.activeBackground,
  }
}

/** Weighted channel brightness is enough to tell a dark palette from a light one. */
function colorBrightness(color: string): number {
  const red = parseInt(color.slice(1, 3), 16)
  const green = parseInt(color.slice(3, 5), 16)
  const blue = parseInt(color.slice(5, 7), 16)
  return red * 0.299 + green * 0.587 + blue * 0.114
}

/** Prefer the normal ANSI slot, fall back to its bright twin. */
function ansi(colors: TerminalColors | null, index: number, bright: number): string | null {
  return (
    detectedTerminalColor(colors?.palette[index]) ?? detectedTerminalColor(colors?.palette[bright])
  )
}
