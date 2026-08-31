import {
  bold,
  BoxRenderable,
  type CliRenderer,
  fg,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import type { AgentAttention, DisplayState } from "./agent-registry.ts"
import { type FxnkTheme, fxnkRamp, RAMP_FALLBACK, type Ramp } from "./host-palette.ts"
import { indentFor, type TreeRow } from "./session-tree.ts"

/** One extension-owned unavailable slot in the navigation list, never an Agent row. */
export type RecoveryCardListRow = {
  kind: "recovery-card"
  depth: 0
  label: string
  slotId: string
  agentId: null
  state: "unknown"
  attention: null
  active: boolean
  onPath: boolean
}

export type SessionListRow = TreeRow | RecoveryCardListRow

/** Inset the text; the row's shading still spans the full tray width. */
const ROW_PADDING_LEFT = 1
const ICON_COLUMN = 2
const MISSING_SESSION = "—"
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
export function rowText(row: SessionListRow, width: number): string {
  const available = width - ROW_PADDING_LEFT - indentFor(row.depth).length
  if (!isAgentRow(row) && row.kind !== "recovery-card") return truncate(row.label, available)
  return truncate(row.label || MISSING_SESSION, available - ICON_COLUMN)
}

/** What the row's click handler reads; kept mutable so a reused row rebinds. */
type RowBinding = { agentId: number | null; recoveryCardId: string | null }

/** One drawn row: its renderables, what it was drawn from, and its identity. */
type RenderedRow = {
  key: string
  signature: string
  container: BoxRenderable
  text: TextRenderable
  binding: RowBinding
}

/** An Agent keeps its row; structural rows are identified by their position. */
function rowKey(row: SessionListRow, index: number): string {
  if (row.kind === "recovery-card") return `recovery-card-${row.slotId}`
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
  private rows: RenderedRow[] = []
  /** Bumped whenever a theme change makes every drawn row stale. */
  private themeGeneration = 0

  constructor(
    private readonly renderer: CliRenderer,
    private readonly onSelect: (agentId: number) => void,
    private readonly onSelectRecoveryCard: (slotId: string) => void = () => {},
  ) {
    this.root = new BoxRenderable(renderer, {
      id: "fmx-session-list",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    })
  }

  render(rows: SessionListRow[], width: number): void {
    const keys = rows.map((row, index) => rowKey(row, index))
    const shapeChanged =
      keys.length !== this.rows.length || keys.some((key, index) => this.rows[index]!.key !== key)

    if (!shapeChanged) {
      let repainted = false
      for (const [index, row] of rows.entries()) {
        repainted = this.paint(this.rows[index]!, row, width) || repainted
      }
      if (repainted) this.renderer.requestRender()
      return
    }

    const reusable = new Map(this.rows.map((rendered) => [rendered.key, rendered]))
    const next: RenderedRow[] = []
    for (const [index, row] of rows.entries()) {
      const key = keys[index]!
      const existing = reusable.get(key)
      if (existing) {
        reusable.delete(key)
        this.paint(existing, row, width)
        next.push(existing)
      } else {
        next.push(this.buildRow(row, key, width))
      }
    }
    for (const rendered of this.rows) this.root.remove(rendered.container)
    for (const orphan of reusable.values()) orphan.container.destroyRecursively()
    this.rows = next
    for (const rendered of this.rows) this.root.add(rendered.container)
    this.renderer.requestRender()
  }

  applyTheme(theme: FxnkTheme): void {
    this.ramp = fxnkRamp(theme)
    this.themeGeneration += 1
  }

  /** Bring one already-built row up to date, in place. */
  private paint(rendered: RenderedRow, row: SessionListRow, width: number): boolean {
    const signature = this.signatureOf(row, width)
    if (rendered.signature === signature) return false
    rendered.signature = signature
    rendered.binding.agentId = row.agentId
    rendered.binding.recoveryCardId = row.kind === "recovery-card" ? row.slotId : null
    rendered.container.backgroundColor = row.active ? this.ramp.surface : undefined
    rendered.text.content = this.styleRow(row, width)
    return true
  }

  private signatureOf(row: SessionListRow, width: number): string {
    return [
      width,
      this.themeGeneration,
      row.kind,
      row.depth,
      row.state,
      row.attention ?? "",
      row.active,
      row.onPath,
      row.label,
    ].join("\u0000")
  }

  private buildRow(row: SessionListRow, key: string, width: number): RenderedRow {
    const binding: RowBinding = {
      agentId: row.agentId,
      recoveryCardId: row.kind === "recovery-card" ? row.slotId : null,
    }
    const container = new BoxRenderable(this.renderer, {
      id: `fmx-session-row-${key}`,
      width: "100%",
      height: 1,
      flexShrink: 0,
      paddingLeft: ROW_PADDING_LEFT,
      // Only the active row is filled. Its ancestors are marked by weight, so
      // two faint backgrounds never have to be told apart.
      backgroundColor: row.active ? this.ramp.surface : undefined,
      onMouseDown: (event) => {
        // Navigation is a press action, like a keybinding: waiting for release
        // makes a fast switch feel delayed by the human's click duration.
        event.preventDefault()
        event.stopPropagation()
        if (binding.agentId !== null) this.onSelect(binding.agentId)
        else if (binding.recoveryCardId !== null) this.onSelectRecoveryCard(binding.recoveryCardId)
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

  private styleRow(row: SessionListRow, width: number): StyledText {
    const ramp = this.ramp
    const chunks: TextChunk[] = [fg(ramp.foreground)(indentFor(row.depth))]
    if (row.kind === "recovery-card") {
      chunks.push(bold(fg(ramp.accent)("! ")))
      chunks.push(fg(row.active ? ramp.foreground : ramp.dim)(rowText(row, width)))
      return new StyledText(chunks)
    }
    if (isAgentRow(row)) {
      const glyph = fg(ramp[stateRole(row.state)])(`${stateIcon(row.state, row.attention)} `)
      chunks.push(row.state === "blocked" ? bold(glyph) : glyph)
      // The selected row's name steps up to the ramp's primary: dim text on
      // the raised fill is the one place the tray asks a name to be read
      // against something other than the background it was measured from.
      chunks.push(fg(row.active ? ramp.foreground : ramp.dim)(rowText(row, width)))
      return new StyledText(chunks)
    }
    // An ancestor of the active agent is marked by weight: the path reads
    // without costing a column.
    const label = fg(this.ramp.foreground)(rowText(row, width))
    chunks.push(row.onPath ? bold(label) : label)
    return new StyledText(chunks)
  }
}

function isAgentRow(row: SessionListRow): boolean {
  return row.kind === "agent" || row.kind === "subagent"
}
