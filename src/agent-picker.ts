import {
  bold,
  BoxRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  StyledText,
  TextRenderable,
} from "@opentui/core"
import type { AgentAttention, DisplayState } from "./agent-registry.ts"
import { type FxnkTheme, fxnkRamp, RAMP_FALLBACK, type Ramp } from "./host-palette.ts"
import { isCancelKey } from "./keybindings.ts"
import { stateIcon, stateRole } from "./session-list.ts"

const CONTROL_HEIGHT = 3
const SELECTOR_CHROME_HEIGHT = 4

export type AgentPickerEntry = {
  agentId: number
  project: string
  branch: string | null
  sessionId: string | null
  name: string | null
  state: DisplayState
  attention: AgentAttention | null
  active: boolean
}

export type AgentPickerOptions = {
  theme?: FxnkTheme
  onSelect: (agentId: number) => void
  onOpenChange?: (open: boolean) => void
}

type OptionRow = {
  box: BoxRenderable
  text: TextRenderable
}

/**
 * The alternate Agent navigation surface: one persistent outlined control and
 * a downward-opening selector that flies over the terminal beneath it.
 */
export class AgentPicker extends BoxRenderable {
  readonly backdrop: BoxRenderable
  readonly button: BoxRenderable
  readonly selector: BoxRenderable
  readonly separator: TextRenderable
  readonly menuRows: OptionRow[] = []

  private readonly buttonText: TextRenderable
  private readonly selectorText: TextRenderable
  private readonly renderContext: RenderContext
  private readonly options: AgentPickerOptions
  private entries: AgentPickerEntry[] = []
  private visibleEntryIndices: number[] = []
  private ramp: Ramp = RAMP_FALLBACK
  private highlighted = 0
  private scrollOffset = 0
  private maximumHeight: number
  private visibleMenuRows = 0
  private opened = false
  private published = true

  constructor(ctx: RenderContext, options: AgentPickerOptions) {
    const ramp = fxnkRamp(options.theme ?? "dark")
    super(ctx, {
      id: "fmx-agent-picker",
      width: "100%",
      height: CONTROL_HEIGHT,
      flexShrink: 0,
      backgroundColor: ramp.background,
      overflow: "visible",
      visible: false,
    })
    this.renderContext = ctx
    this.options = options
    this.ramp = ramp
    this.maximumHeight = Math.max(0, Math.trunc(ctx.height))

    this.backdrop = new BoxRenderable(ctx, {
      id: "fmx-agent-picker-backdrop",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: this.maximumHeight,
      backgroundColor: ramp.backdrop,
      shouldFill: true,
      zIndex: 1,
      visible: false,
    })
    this.backdrop.onMouseDown = (event) => {
      if (event.button !== 0) return
      this.close()
      event.preventDefault()
      event.stopPropagation()
    }

    this.button = new BoxRenderable(ctx, {
      id: "fmx-agent-picker-button",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: CONTROL_HEIGHT,
      border: true,
      borderStyle: "single",
      borderColor: ramp.divider,
      backgroundColor: ramp.background,
      justifyContent: "center",
      shouldFill: true,
      zIndex: 2,
    })
    this.buttonText = new TextRenderable(ctx, {
      id: "fmx-agent-picker-value",
      width: "100%",
      height: 1,
      content: "",
      fg: ramp.foreground,
      bg: ramp.background,
      selectable: false,
      truncate: true,
    })
    this.button.add(this.buttonText)
    this.button.onMouseDown = (event) => {
      if (event.button !== 0) return
      this.showMenu()
      event.preventDefault()
      event.stopPropagation()
    }

    this.selector = new BoxRenderable(ctx, {
      id: "fmx-agent-picker-selector",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: SELECTOR_CHROME_HEIGHT,
      flexDirection: "column",
      flexShrink: 0,
      border: true,
      borderStyle: "single",
      borderColor: ramp.divider,
      focusedBorderColor: ramp.focus,
      backgroundColor: ramp.background,
      focusable: true,
      shouldFill: true,
      zIndex: 3,
      visible: false,
    })
    this.selectorText = new TextRenderable(ctx, {
      id: "fmx-agent-picker-selector-value",
      width: "100%",
      height: 1,
      flexShrink: 0,
      content: "",
      fg: ramp.foreground,
      bg: ramp.background,
      selectable: false,
      truncate: true,
    })
    this.separator = new TextRenderable(ctx, {
      id: "fmx-agent-picker-divider",
      width: "100%",
      height: 1,
      flexShrink: 0,
      content: "",
      fg: ramp.divider,
      bg: ramp.background,
      selectable: false,
      truncate: true,
    })
    this.selector.add(this.selectorText)
    this.selector.add(this.separator)
    this.selector.onMouseDown = (event) => {
      if (event.button !== 0) return
      this.selector.focus()
      event.preventDefault()
      event.stopPropagation()
    }

    this.add(this.backdrop)
    this.add(this.button)
    this.add(this.selector)
    this.refresh()
  }

  get open(): boolean {
    return this.opened
  }

  get highlightedAgentId(): number | null {
    return this.entries[this.highlighted]?.agentId ?? null
  }

  get menuHeight(): number {
    return this.opened ? this.visibleMenuRows + 1 : 0
  }

  setPublished(published: boolean): void {
    if (published === this.published) return
    this.published = published
    if (!published) this.close()
    this.button.visible = published
    this.refresh()
  }

  setEntries(entries: readonly AgentPickerEntry[]): void {
    const highlightedId = this.highlightedAgentId
    this.entries = [...entries].reverse()
    if (this.entries.length === 0) {
      this.highlighted = 0
      this.scrollOffset = 0
      this.close()
      this.refresh()
      return
    }

    const retained = highlightedId === null
      ? -1
      : this.entries.findIndex((entry) => entry.agentId === highlightedId)
    const active = this.entries.findIndex((entry) => entry.active)
    this.highlighted = retained >= 0 ? retained : active >= 0 ? active : 0
    this.refresh()
  }

  applyTheme(theme: FxnkTheme): void {
    this.ramp = fxnkRamp(theme)
    this.backgroundColor = this.ramp.background
    this.backdrop.backgroundColor = this.ramp.backdrop
    this.button.backgroundColor = this.ramp.background
    this.button.borderColor = this.ramp.divider
    this.button.focusedBorderColor = this.ramp.divider
    this.buttonText.bg = this.ramp.background
    this.selector.backgroundColor = this.ramp.background
    this.selector.borderColor = this.ramp.divider
    this.selector.focusedBorderColor = this.ramp.focus
    this.selectorText.bg = this.ramp.background
    this.separator.fg = this.ramp.divider
    this.separator.bg = this.ramp.background
    for (const row of this.menuRows) {
      row.box.backgroundColor = this.ramp.background
      row.text.bg = this.ramp.background
    }
    this.refresh()
  }

  resizeForSize(width: number, height: number): void {
    void width
    this.maximumHeight = Math.max(0, Math.trunc(height))
    this.backdrop.height = this.maximumHeight
    if (this.opened && this.rowCapacity() === 0) this.close()
    this.refresh()
  }

  openMenu(): void {
    this.showMenu()
  }

  toggle(): void {
    if (this.opened) this.close()
    else this.showMenu()
  }

  close(): void {
    if (!this.opened) return
    this.opened = false
    if (this.selector.focused) this.selector.blur()
    this.backdrop.visible = false
    this.selector.visible = false
    this.visibleMenuRows = 0
    this.visibleEntryIndices = []
    this.refreshRows([])
    this.refreshChrome()
    this.options.onOpenChange?.(false)
  }

  handleKeyPress(key: KeyEvent): boolean {
    const name = key.name.toLowerCase()
    if (name === "up" || name === "left") {
      this.moveHighlight(-1)
      return true
    }
    if (name === "down" || name === "right") {
      this.moveHighlight(1)
      return true
    }
    if (name === "return" || name === "enter") {
      this.chooseHighlighted()
      return true
    }
    if (name === "escape" || isCancelKey(key)) {
      this.close()
      return true
    }
    return false
  }

  optionRow(rowIndex: number): BoxRenderable | null {
    return this.menuRows[rowIndex]?.box ?? null
  }

  private showMenu(): void {
    if (this.opened || !this.visible || !this.published || this.entries.length === 0 || this.rowCapacity() === 0) return
    const active = this.entries.findIndex((entry) => entry.active)
    this.highlighted = active >= 0 ? active : 0
    this.scrollOffset = 0
    this.opened = true
    this.refresh()
    this.selector.focus()
    this.refreshChrome()
    this.options.onOpenChange?.(true)
  }

  private moveHighlight(delta: -1 | 1): void {
    if (this.entries.length === 0) return
    this.highlighted = wrapIndex(this.highlighted + delta, this.entries.length)
    this.refresh()
  }

  private chooseHighlighted(): void {
    const entry = this.entries[this.highlighted]
    if (!entry) return
    this.options.onSelect(entry.agentId)
    this.close()
  }

  private chooseVisibleRow(rowIndex: number): void {
    const entryIndex = this.visibleEntryIndices[rowIndex]
    if (entryIndex === undefined) return
    this.highlighted = entryIndex
    this.chooseHighlighted()
  }

  private rowCapacity(): number {
    return Math.max(0, this.maximumHeight - SELECTOR_CHROME_HEIGHT)
  }

  private refresh(): void {
    const open = this.opened && this.published && this.entries.length > 0
    this.visibleMenuRows = open ? Math.min(this.entries.length, this.rowCapacity()) : 0
    const visible = this.visibleMenuRows > 0
    this.backdrop.visible = visible
    this.selector.visible = visible
    if (!visible) {
      this.visibleEntryIndices = []
      this.refreshRows([])
      this.refreshChrome()
      return
    }

    const maximumOffset = Math.max(0, this.entries.length - this.visibleMenuRows)
    if (this.highlighted < this.scrollOffset) this.scrollOffset = this.highlighted
    if (this.highlighted >= this.scrollOffset + this.visibleMenuRows) {
      this.scrollOffset = this.highlighted - this.visibleMenuRows + 1
    }
    this.scrollOffset = Math.min(this.scrollOffset, maximumOffset)
    const shown = this.entries.slice(this.scrollOffset, this.scrollOffset + this.visibleMenuRows)
    this.visibleEntryIndices = shown.map((_entry, index) => this.scrollOffset + index)
    this.selector.height = this.visibleMenuRows + SELECTOR_CHROME_HEIGHT
    this.refreshRows(shown)
    this.refreshChrome()
  }

  private refreshChrome(): void {
    if (this.buttonText.isDestroyed || this.selectorText.isDestroyed) return
    const active = this.entries.find((entry) => entry.active) ?? null
    this.buttonText.content = this.controlContent(active, false)
    this.selectorText.content = this.controlContent(active, true)
    this.separator.content = "─".repeat(Math.max(0, this.width - 2))
  }

  private controlContent(entry: AgentPickerEntry | null, focused: boolean): StyledText {
    if (!entry) return new StyledText([fg(this.ramp.dim)("  agent  —")])
    const value = entryLabel(entry)
    return new StyledText([
      fg(focused ? this.ramp.focus : this.ramp.dim)(focused ? "▎" : " "),
      fg(this.ramp.secondary)(" agent "),
      stateGlyph(entry, this.ramp),
      fg(this.ramp.dim)(`${entry.agentId} · `),
      focused ? bold(fg(this.ramp.foreground)(value)) : fg(this.ramp.foreground)(value),
      fg(this.ramp.dim)(` · ${entryContext(entry)} ▾`),
    ])
  }

  private refreshRows(visible: readonly AgentPickerEntry[]): void {
    this.ensureRows(visible.length)
    for (const [rowIndex, row] of this.menuRows.entries()) {
      const entry = visible[rowIndex]
      row.box.visible = this.selector.visible && entry !== undefined
      row.box.backgroundColor = this.ramp.background
      row.text.bg = this.ramp.background
      if (!entry) {
        row.text.content = ""
        continue
      }
      const entryIndex = this.visibleEntryIndices[rowIndex]
      const highlighted = entryIndex === this.highlighted
      const label = entryLabel(entry)
      row.text.content = new StyledText([
        fg(highlighted ? this.ramp.focus : this.ramp.dim)(highlighted ? "> " : "  "),
        stateGlyph(entry, this.ramp),
        fg(this.ramp.dim)(`${entry.agentId} · `),
        highlighted ? bold(fg(this.ramp.foreground)(label)) : fg(this.ramp.secondary)(label),
        fg(this.ramp.dim)(` · ${entryContext(entry)}`),
      ])
    }
  }

  private ensureRows(count: number): void {
    while (this.menuRows.length < count) {
      const rowIndex = this.menuRows.length
      const box = new BoxRenderable(this.renderContext, {
        id: `fmx-agent-picker-option-${rowIndex}`,
        width: "100%",
        height: 1,
        flexShrink: 0,
        backgroundColor: this.ramp.background,
      })
      const text = new TextRenderable(this.renderContext, {
        id: `fmx-agent-picker-option-text-${rowIndex}`,
        width: "100%",
        height: 1,
        content: "",
        fg: this.ramp.secondary,
        bg: this.ramp.background,
        selectable: false,
        truncate: true,
      })
      box.add(text)
      box.onMouseDown = (event) => {
        if (event.button !== 0 || !box.visible) return
        this.chooseVisibleRow(rowIndex)
        event.preventDefault()
        event.stopPropagation()
      }
      this.selector.add(box)
      this.menuRows.push({ box, text })
    }
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height)
    this.refreshChrome()
  }
}

function stateGlyph(entry: AgentPickerEntry, ramp: Ramp) {
  const glyph = fg(ramp[stateRole(entry.state)])(`${stateIcon(entry.state, entry.attention)} `)
  return entry.state === "blocked" ? bold(glyph) : glyph
}

function entryLabel(entry: AgentPickerEntry): string {
  return entry.name ?? entry.sessionId ?? "—"
}

function entryContext(entry: AgentPickerEntry): string {
  return entry.branch ? `${entry.project} · ${entry.branch}` : entry.project
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length
}
