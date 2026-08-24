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
import { hasDetectedDefaults, hostRamp, RAMP_FALLBACK, type Ramp } from "./host-palette.ts"
import { indentFor, type TreeRow } from "./session-tree.ts"

/** Inset the text; the row's shading still spans the full tray width. */
const ROW_PADDING_LEFT = 1
const ICON_COLUMN = 2
const MISSING_SESSION = "—"
/** Agent names before the host palette answers: the terminal's own ANSI gray,
 * which reads as dim text on a light theme and a dark one alike. Once the
 * host has answered they take the ramp's dim step. */
const SESSION_COLOR = RGBA.fromIndex(8)

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
 * Which step of the ramp a status glyph is drawn in. The glyph says what the
 * state is; the ramp says how loudly. Blocked is the brightest thing in the
 * tray — what needs the human — and is also set bold. Done sits one step
 * brighter than its row, the way fx marks a finished tool call. Everything
 * else recedes. No hue: the shapes are distinct on their own.
 */
export function stateRole(state: DisplayState): "foreground" | "accent" | "dim" {
  switch (state) {
    case "blocked":
      return "foreground"
    case "done":
      return "accent"
    case "working":
    case "idle":
    case "unknown":
      return "dim"
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
 * The tray's tree of fx agents: project, branch, and one row per agent.
 * Project and branch labels are the foreground, bold along the path to the
 * active agent; agent names are dim; the active row alone is filled.
 */
export class SessionList {
  readonly root: BoxRenderable
  private ramp: Ramp = RAMP_FALLBACK
  /** The ramp the active row's fill was chosen from. Under the startup lock
   * it lags `ramp`, and everything drawn on that fill is drawn from it, so a
   * fallback-dark fill never carries a light host's dark glyph. */
  private fillRamp: Ramp = RAMP_FALLBACK
  private sessionColor: RGBA | string = SESSION_COLOR
  private rows: BoxRenderable[] = []

  constructor(
    private readonly renderer: CliRenderer,
    private readonly onSelect: (agentId: number) => void,
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

  /**
   * The selected-row fill and the agent names are on screen from the first
   * frame; while the startup chrome is locked, a late initial palette answer
   * themes everything else and leaves those two as they were drawn — the
   * fill together with the ramp it came from, which is what the active row's
   * glyph is painted in. Names take the dim step only once both host
   * defaults have answered; until then they are the terminal's own gray.
   */
  applyPalette(colors: TerminalColors | null, preserveStartupChrome = false): void {
    const fillRamp = this.fillRamp
    const sessionColor = this.sessionColor
    this.ramp = hostRamp(colors)
    this.fillRamp = this.ramp
    this.sessionColor = hasDetectedDefaults(colors) ? this.ramp.dim : SESSION_COLOR
    if (preserveStartupChrome) {
      this.fillRamp = fillRamp
      this.sessionColor = sessionColor
    }
  }

  private clearRows(): void {
    for (const rendered of this.rows) {
      this.root.remove(rendered)
      rendered.destroy()
    }
    this.rows = []
  }

  private buildRow(row: TreeRow, width: number, index: number): BoxRenderable {
    const id = row.agentId !== null ? `agent-${row.agentId}` : `${row.kind}-${index}`
    const container = new BoxRenderable(this.renderer, {
      id: `fmx-session-row-${id}`,
      width: "100%",
      height: 1,
      flexShrink: 0,
      paddingLeft: ROW_PADDING_LEFT,
      // Only the active row is filled. Its ancestors are marked by weight, so
      // two faint backgrounds never have to be told apart.
      backgroundColor: row.active ? this.fillRamp.surface : undefined,
      onMouseDown: (event) => {
        // Navigation is a press action, like a keybinding: waiting for release
        // makes a fast switch feel delayed by the human's click duration.
        event.preventDefault()
        event.stopPropagation()
        if (row.agentId !== null) this.onSelect(row.agentId)
      },
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
      },
    })
    container.add(
      new TextRenderable(this.renderer, {
        id: `fmx-session-row-text-${id}`,
        content: this.styleRow(row, width),
        // Selection delays navigation until mouse-up and rebuilding the list
        // mid-selection leaves OpenTUI holding destroyed renderables.
        selectable: false,
      }),
    )
    return container
  }

  private styleRow(row: TreeRow, width: number): StyledText {
    // What sits on the active row's fill is painted from the fill's own ramp.
    const ramp = row.active ? this.fillRamp : this.ramp
    const chunks: TextChunk[] = [fg(ramp.foreground)(indentFor(row.depth))]
    if (isAgentRow(row)) {
      const glyph = fg(ramp[stateRole(row.state)])(`${stateIcon(row.state, row.attention)} `)
      chunks.push(row.state === "blocked" ? bold(glyph) : glyph)
      chunks.push(fg(this.sessionColor)(rowText(row, width)))
      return new StyledText(chunks)
    }
    // An ancestor of the active agent is marked by weight: the path reads
    // without costing a column. A virtual branch is one step down the ramp,
    // italic, and never bold, even on that path.
    const label = fg(row.virtual ? this.ramp.secondary : this.ramp.foreground)(rowText(row, width))
    chunks.push(row.virtual ? italic(label) : row.onPath ? bold(label) : label)
    return new StyledText(chunks)
  }
}

function isAgentRow(row: TreeRow): boolean {
  return row.kind === "agent" || row.kind === "subagent"
}
