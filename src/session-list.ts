import {
  bold,
  BoxRenderable,
  type CliRenderer,
  fg,
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
 * The icon carries the whole status. A blocked Agent varies its glyph by the
 * attention kind Fx carries in its ADE lifecycle snapshot.
 */
export function stateIcon(state: DisplayState, attention: AgentAttention | null): string {
  switch (state) {
    case "blocked":
      switch (attention) {
        case "question":
          return "?"
        case "route_recovery":
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

/** What the row's click handler reads; kept mutable so a reused row rebinds. */
type RowBinding = { agentId: number | null }

/** One drawn row: its renderables, what it was drawn from, and its identity. */
type RenderedRow = {
  key: string
  signature: string
  container: BoxRenderable
  text: TextRenderable
  binding: RowBinding
}

/**
 * A row's identity across renders. An Agent keeps its row through any change
 * to it; every other row is identified by where it sits, which is what makes
 * a project or branch that moved a different row.
 */
function rowKey(row: TreeRow, index: number): string {
  return row.agentId !== null ? `agent-${row.agentId}` : `${row.kind}-${index}`
}

/**
 * The tray's tree of fx agents: project, branch, and one row per agent.
 * Project and branch labels are the foreground, bold along the path to the
 * active agent; agent names are dim, except on the filled active row, where
 * the name takes the primary step; the active row alone is filled.
 */
export class SessionList {
  readonly root: BoxRenderable
  private ramp: Ramp = RAMP_FALLBACK
  /** The ramp the active row's fill was chosen from. Under the startup lock
   * it lags `ramp`, and everything drawn on that fill is drawn from it, so a
   * fallback-dark fill never carries a light host's dark glyph. */
  private fillRamp: Ramp = RAMP_FALLBACK
  private sessionColor: RGBA | string = SESSION_COLOR
  private rows: RenderedRow[] = []
  /** Bumped whenever a palette change makes every drawn row stale. */
  private paletteGeneration = 0

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

  /**
   * Draw `rows`, reusing what is already on screen. The tray is refreshed
   * from every ADE record, and Fx reports before each tool call, so a
   * rebuild-per-call would churn every renderable many times a second for a
   * tray that usually has not changed. A render that changes nothing touches
   * nothing and does not ask for a frame.
   */
  render(rows: TreeRow[], width: number): void {
    const keys = rows.map((row, index) => rowKey(row, index))
    let changed = keys.length !== this.rows.length
    if (!changed) {
      for (const [index, key] of keys.entries()) {
        if (this.rows[index]!.key !== key) {
          changed = true
          break
        }
      }
    }

    if (!changed) {
      // Same rows in the same order: only their contents can differ.
      let repainted = false
      for (const [index, row] of rows.entries()) repainted = this.paint(this.rows[index]!, row, width) || repainted
      if (repainted) this.renderer.requestRender()
      return
    }

    // The shape moved. Keep every row whose key survives — a reused row keeps
    // its native renderables — and build only what is genuinely new.
    const reusable = new Map(this.rows.map((rendered) => [rendered.key, rendered]))
    const next: RenderedRow[] = []
    for (const [index, row] of rows.entries()) {
      const key = keys[index]!
      const existing = reusable.get(key)
      if (existing) {
        reusable.delete(key)
        this.paint(existing, row, width)
        next.push(existing)
        continue
      }
      next.push(this.buildRow(row, key, width))
    }
    for (const rendered of this.rows) this.root.remove(rendered.container)
    for (const orphan of reusable.values()) orphan.container.destroyRecursively()
    this.rows = next
    for (const rendered of this.rows) this.root.add(rendered.container)
    this.renderer.requestRender()
  }

  /** Bring one already-built row up to date, in place. */
  private paint(rendered: RenderedRow, row: TreeRow, width: number): boolean {
    const signature = this.signatureOf(row, width)
    if (rendered.signature === signature) return false
    rendered.signature = signature
    rendered.binding.agentId = row.agentId
    rendered.container.backgroundColor = row.active ? this.fillRamp.surface : undefined
    rendered.text.content = this.styleRow(row, width)
    return true
  }

  /**
   * Everything `styleRow` and the row's fill are drawn from. The palette
   * generation stands in for the three ramps, which change together.
   */
  private signatureOf(row: TreeRow, width: number): string {
    return [
      width,
      this.paletteGeneration,
      row.kind,
      row.depth,
      row.state,
      row.attention ?? "",
      row.active,
      row.onPath,
      row.label,
    ].join("\u0000")
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
    // Every row on screen was drawn from the old ramps.
    this.paletteGeneration += 1
  }

  private buildRow(row: TreeRow, key: string, width: number): RenderedRow {
    // The click target outlives any one TreeRow, so the handler reads the
    // agent from a binding this row keeps rather than from a captured row.
    const binding: RowBinding = { agentId: row.agentId }
    const container = new BoxRenderable(this.renderer, {
      id: `fmx-session-row-${key}`,
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
        if (binding.agentId !== null) this.onSelect(binding.agentId)
      },
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
      },
    })
    const text = new TextRenderable(this.renderer, {
      id: `fmx-session-row-text-${key}`,
      content: this.styleRow(row, width),
      // Selection delays navigation until mouse-up and replacing a row while
      // OpenTUI holds a selection leaves it holding a destroyed renderable.
      selectable: false,
    })
    container.add(text)
    return { key, signature: this.signatureOf(row, width), container, text, binding }
  }

  private styleRow(row: TreeRow, width: number): StyledText {
    // What sits on the active row's fill is painted from the fill's own ramp.
    const ramp = row.active ? this.fillRamp : this.ramp
    const chunks: TextChunk[] = [fg(ramp.foreground)(indentFor(row.depth))]
    if (isAgentRow(row)) {
      const glyph = fg(ramp[stateRole(row.state)])(`${stateIcon(row.state, row.attention)} `)
      chunks.push(row.state === "blocked" ? bold(glyph) : glyph)
      // The selected row's name steps up to the ramp's primary: dim text on
      // the raised fill is the one place the tray asks a name to be read
      // against something other than the background it was measured from.
      chunks.push(fg(row.active ? ramp.foreground : this.sessionColor)(rowText(row, width)))
      return new StyledText(chunks)
    }
    // An ancestor of the active agent is marked by weight: the path reads
    // without costing a column.
    const label = fg(this.ramp.foreground)(rowText(row, width))
    chunks.push(row.onPath ? bold(label) : label)
    return new StyledText(chunks)
  }
}

function isAgentRow(row: TreeRow): boolean {
  return row.kind === "agent" || row.kind === "subagent"
}
