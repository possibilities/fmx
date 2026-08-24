import {
  BoxRenderable,
  bold,
  type CliRenderer,
  type EmbeddedTerminalDataSource,
  fg,
  StyledText,
  type TerminalColors,
  TextRenderable,
  type ThemeMode,
} from "@opentui/core"
import type { PanelDefinition } from "./config.ts"
import { CursorReportAdapter } from "./cursor-report-adapter.ts"
import { FmxTerminalRenderable } from "./fx-terminal.ts"
import {
  hasDetectedBackground,
  hostRamp,
  RAMP_FALLBACK,
  type Ramp,
  themeModeReport,
} from "./host-palette.ts"
import type { TerminalSize, TerminalTransport } from "./agent-transport.ts"
import type { PanelContext, PanelSessionController } from "./panel-session.ts"
import { sanitizeTitle } from "./title-parser.ts"

const MAX_SCROLLBACK_BYTES = 10_000_000
// The rail is a rule tab: labels over a hairline whose span under the
// selected label is drawn heavy in the foreground. fx has no tab surface to
// copy, so this is fmx's own, built from fx's principles — selection by
// weight and glyph, never hue or underline. See fxnk style/STYLE.md
// "Switching items in a panel".
const RULE_LIGHT = "\u2500" // ─
const RULE_HEAVY = "\u2501" // ━
const LINK_PADDING = 1
const TERMINAL_RESET = new Uint8Array([0x1b, 0x63])

export type ToolPanelTab = {
  id: string
  label: string
  persistent: boolean
}

export type ToolPanelOptions = {
  definitions: readonly PanelDefinition[]
  sessions: PanelSessionController | null
  initialSelectedId?: string
  onSelectedChange?: (id: string) => void
  onFocusRequest?: () => void
  onFocusLost?: () => void
}

type ToolEntry = { definition: PanelDefinition; tab: ToolPanelTab }

type RuntimeState = "loading" | "ready" | "exited" | "failed" | "lost"

/**
 * The right-side dock and the terminals shown inside it. A terminal runtime is
 * cached per Agent and configured tool for the lifetime of this fmx: local
 * tools therefore survive hiding, tab changes, and Agent switches, while
 * persistent tools keep living in the Companion after every transport lets go.
 */
export class ToolPanel {
  readonly root: BoxRenderable
  private readonly rail: BoxRenderable
  private readonly labels: BoxRenderable
  private readonly rule: TextRenderable
  private readonly body: BoxRenderable
  private readonly contextStatus: TextRenderable
  private readonly entries: ToolEntry[]
  private readonly links = new Map<string, TextRenderable>()
  private readonly runtimes = new Map<string, ToolRuntime>()
  private selectedId: string
  private width = 0
  private context: PanelContext | null = null
  private visible = false
  private wantsFocus = false
  private destroyed = false
  private colors: TerminalColors | null = null
  private themeMode: ThemeMode | null = null
  /** The Ramp fmx-owned panel chrome was first drawn from. A late initial
   * palette may update the embedded terminal without mixing a new rule/status
   * gray with the startup dividers already on screen. */
  private chromeRamp: Ramp = RAMP_FALLBACK

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: ToolPanelOptions,
  ) {
    this.entries = options.definitions.map((definition) => ({
      definition,
      tab: { id: definition.id, label: definition.label, persistent: definition.persistent },
    }))
    if (this.entries.length === 0) throw new Error("a tools panel needs at least one configured tool")

    const requested = this.entries.find((entry) => entry.tab.id === options.initialSelectedId)
    this.selectedId = requested?.tab.id ?? this.entries[0]!.tab.id

    this.root = new BoxRenderable(renderer, {
      id: "fmx-tool-panel",
      height: "100%",
      flexShrink: 0,
      flexDirection: "column",
      visible: false,
    })
    this.rail = new BoxRenderable(renderer, {
      id: "fmx-tool-panel-rail",
      width: "100%",
      height: 2,
      flexShrink: 0,
      flexDirection: "column",
      visible: this.entries.length > 1,
    })
    this.labels = new BoxRenderable(renderer, {
      id: "fmx-tool-panel-labels",
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
    })
    this.rule = new TextRenderable(renderer, {
      id: "fmx-tool-panel-rule",
      width: "100%",
      height: 1,
      selectable: false,
    })
    this.rail.add(this.labels)
    this.rail.add(this.rule)
    this.body = new BoxRenderable(renderer, {
      id: "fmx-tool-panel-body",
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      alignItems: "center",
      justifyContent: "center",
    })
    this.contextStatus = new TextRenderable(renderer, {
      id: "fmx-tool-panel-status",
      content: "no active agent",
      selectable: false,
      visible: false,
    })
    this.body.add(this.contextStatus)

    for (const entry of this.entries) this.addLink(entry)
    this.root.add(this.rail)
    this.root.add(this.body)
    this.applyPalette(null, null)
    this.refreshLinks()
  }

  get available(): boolean {
    return this.entries.length > 0
  }

  get selected(): string {
    return this.selectedId
  }

  get tabs(): ToolPanelTab[] {
    return this.entries.map((entry) => ({ ...entry.tab }))
  }

  get isVisible(): boolean {
    return this.visible
  }

  /** Whether the selected surface can accept terminal input in this context. */
  get focusable(): boolean {
    if (!this.entry(this.selectedId) || this.context === null) return false
    return !this.currentRuntime()?.retryable
  }

  setWidth(width: number): void {
    this.width = width
    this.root.width = width
    this.refreshLinks()
  }

  setVisible(visible: boolean): void {
    if (this.destroyed || visible === this.visible) return
    this.visible = visible
    this.root.visible = visible
    if (visible) this.activateCurrent()
    else {
      for (const runtime of this.runtimes.values()) runtime.setVisible(false)
      this.suspendFocus()
    }
  }

  setContext(context: PanelContext | null): void {
    if (
      this.context?.agentId === context?.agentId &&
      this.context?.displayId === context?.displayId &&
      this.context?.cwd === context?.cwd
    ) {
      return
    }
    this.context = context
    if (this.visible) this.activateCurrent()
  }

  /** Select by stable id. Selecting a failed or exited tool retries it. */
  select(id: string): boolean {
    if (!this.entry(id)) return false
    const changed = id !== this.selectedId
    this.selectedId = id
    this.refreshLinks()
    if (this.visible) this.activateCurrent(true)
    if (changed) this.options.onSelectedChange?.(id)
    return true
  }

  step(direction: 1 | -1): string {
    const index = this.entries.findIndex((entry) => entry.tab.id === this.selectedId)
    const next = ((index + direction) % this.entries.length + this.entries.length) % this.entries.length
    this.select(this.entries[next]!.tab.id)
    return this.selectedId
  }

  /** Keep terminal focus in the tools panel, including across an async attach. */
  focus(): boolean {
    if (!this.visible || !this.focusable) return false
    this.wantsFocus = true
    const runtime = this.activateCurrent()
    runtime?.focusWhenReady()
    return true
  }

  /** Hand focus ownership back to the Agent. */
  blur(): void {
    this.wantsFocus = false
    this.suspendFocus()
  }

  /** Temporarily remove cursor/input focus while a modal owns the screen. */
  suspendFocus(): void {
    for (const runtime of this.runtimes.values()) runtime.blur()
  }

  applyPalette(
    colors: TerminalColors | null,
    themeMode: ThemeMode | null,
    preserveStartupChrome = false,
  ): void {
    this.colors = colors
    this.themeMode = themeMode
    if (!preserveStartupChrome) this.chromeRamp = hostRamp(colors)
    this.contextStatus.fg = this.chromeRamp.dim
    for (const runtime of this.runtimes.values()) runtime.applyPalette(colors, themeMode, this.chromeRamp)
    this.refreshLinks()
  }

  /** Drop every local PTY and every attachment. Companion-owned tools remain. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.wantsFocus = false
    for (const runtime of this.runtimes.values()) {
      this.body.remove(runtime.root)
      runtime.destroy()
    }
    this.runtimes.clear()
  }

  /** An Agent ended, so no local renderer or PTY for its context remains. */
  forgetContext(agentId: string): void {
    for (const [key, runtime] of this.runtimes) {
      if (runtime.context.agentId !== agentId) continue
      this.body.remove(runtime.root)
      runtime.destroy()
      this.runtimes.delete(key)
    }
    if (this.context?.agentId === agentId) this.setContext(null)
  }

  private addLink(entry: ToolEntry): void {
    const text = new TextRenderable(this.renderer, {
      id: `fmx-tool-panel-tab-label-${entry.tab.id}`,
      content: entry.tab.label,
      selectable: false,
    })
    const link = new BoxRenderable(this.renderer, {
      id: `fmx-tool-panel-tab-${entry.tab.id}`,
      width: [...entry.tab.label].length + LINK_PADDING * 2,
      height: 1,
      flexShrink: 0,
      paddingLeft: LINK_PADDING,
      paddingRight: LINK_PADDING,
      onMouseDown: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.select(entry.tab.id)
      },
    })
    link.add(text)
    this.links.set(entry.tab.id, text)
    this.labels.add(link)
  }

  /** Repaint the rule tab: the selected label bold in the foreground, the
   * others dim, and the hairline beneath drawn heavy under the selection. */
  private refreshLinks(): void {
    const colors = this.chromeRamp
    const rule: StyledText["chunks"] = []
    let drawn = 0
    for (const entry of this.entries) {
      const text = this.links.get(entry.tab.id)
      if (!text) continue
      const active = entry.tab.id === this.selectedId
      text.content = new StyledText([
        active ? bold(fg(colors.foreground)(entry.tab.label)) : fg(colors.dim)(entry.tab.label),
      ])
      const span = [...entry.tab.label].length
      rule.push(fg(colors.divider)(RULE_LIGHT.repeat(LINK_PADDING)))
      rule.push(active ? fg(colors.foreground)(RULE_HEAVY.repeat(span)) : fg(colors.divider)(RULE_LIGHT.repeat(span)))
      rule.push(fg(colors.divider)(RULE_LIGHT.repeat(LINK_PADDING)))
      drawn += span + LINK_PADDING * 2
    }
    if (this.width > drawn) rule.push(fg(colors.divider)(RULE_LIGHT.repeat(this.width - drawn)))
    this.rule.content = new StyledText(rule)
  }

  private activateCurrent(forceRetry = false): ToolRuntime | null {
    this.contextStatus.visible = false
    for (const runtime of this.runtimes.values()) runtime.setVisible(false)

    const entry = this.entry(this.selectedId)
    if (!entry) return null
    const context = this.context
    if (!context) {
      this.contextStatus.visible = true
      return null
    }
    const runtime = this.runtime(entry.definition, context, forceRetry)
    runtime.setVisible(true)
    if (this.wantsFocus) runtime.focusWhenReady()
    return runtime
  }

  private runtime(definition: PanelDefinition, context: PanelContext, forceRetry: boolean): ToolRuntime {
    const key = runtimeKey(definition.id, context.agentId)
    const existing = this.runtimes.get(key)
    if (existing && (!forceRetry || !existing.retryable)) return existing
    if (existing) {
      this.body.remove(existing.root)
      existing.destroy()
      this.runtimes.delete(key)
    }
    const sessions = this.options.sessions
    if (!sessions) throw new Error("configured tools panels need a session controller")
    const runtime = new ToolRuntime(
      this.renderer,
      sessions,
      definition,
      context,
      () => {
        if (this.wantsFocus && this.currentRuntime() === runtime) runtime.focusWhenReady()
      },
      () => this.options.onFocusRequest?.(),
      () => {
        if (this.wantsFocus && this.currentRuntime() === runtime) this.options.onFocusLost?.()
      },
    )
    runtime.applyPalette(this.colors, this.themeMode, this.chromeRamp)
    this.runtimes.set(key, runtime)
    this.body.add(runtime.root)
    runtime.start()
    return runtime
  }

  private currentRuntime(): ToolRuntime | null {
    const entry = this.entry(this.selectedId)
    if (!entry || !this.context) return null
    return this.runtimes.get(runtimeKey(entry.definition.id, this.context.agentId)) ?? null
  }

  private entry(id: string): ToolEntry | undefined {
    return this.entries.find((entry) => entry.tab.id === id)
  }
}

class ToolRuntime {
  readonly root: BoxRenderable
  readonly terminal: FmxTerminalRenderable
  private readonly status: TextRenderable
  private transport: TerminalTransport | null = null
  private state: RuntimeState = "loading"
  private size: TerminalSize = { cols: 80, rows: 24 }
  private cursorReportAdapter = new CursorReportAdapter()
  private colors: TerminalColors | null = null
  private visible = false
  private wantsFocus = false
  private destroyed = false

  constructor(
    renderer: CliRenderer,
    private readonly sessions: PanelSessionController,
    readonly definition: PanelDefinition,
    readonly context: PanelContext,
    private readonly onReady: () => void,
    onFocusRequest: () => void,
    private readonly onUnavailable: () => void,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: `fmx-tool-runtime-${definition.id}-${context.displayId}`,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      visible: false,
    })
    this.terminal = new FmxTerminalRenderable(renderer, {
      id: `fmx-tool-terminal-${definition.id}-${context.displayId}`,
      cols: 80,
      rows: 24,
      width: "100%",
      height: "100%",
      visible: false,
      maxScrollback: MAX_SCROLLBACK_BYTES,
      onData: (data, source) => this.writeInput(data, source),
      onTerminalResize: (cols, rows) => this.resize(cols, rows),
      onMouseDown: () => onFocusRequest(),
    })
    this.status = new TextRenderable(renderer, {
      id: `fmx-tool-status-${definition.id}-${context.displayId}`,
      content: `loading ${definition.label}…`,
      selectable: false,
    })
    this.root.add(this.terminal)
    this.root.add(this.status)
  }

  get retryable(): boolean {
    return this.state === "exited" || this.state === "failed" || this.state === "lost"
  }

  start(): void {
    const size = this.currentSize()
    void this.sessions.open(this.definition, this.context, size).then(
      (transport) => this.adopt(transport),
      (error) => this.fail("failed", `could not start ${this.definition.label}: ${errorMessage(error)}`),
    )
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.root.visible = visible
    this.terminal.setHostSelectionEnabled(visible)
    if (!visible) this.terminal.blur()
    else if (this.wantsFocus) this.focusWhenReady()
  }

  focusWhenReady(): void {
    this.wantsFocus = true
    if (this.visible && this.state === "ready") this.terminal.focus()
  }

  blur(): void {
    this.wantsFocus = false
    this.terminal.blur()
  }

  applyPalette(colors: TerminalColors | null, themeMode: ThemeMode | null, chromeRamp: Ramp): void {
    this.colors = colors
    this.status.fg = chromeRamp.dim
    if (!colors || !this.terminal.applyHostPalette(colors)) return
    if (this.transport && themeMode && hasDetectedBackground(colors)) {
      this.writeInput(themeModeReport(themeMode), "response")
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.wantsFocus = false
    this.transport?.detach()
    this.transport = null
    this.terminal.blur()
    this.root.destroy()
  }

  private adopt(transport: TerminalTransport): void {
    if (this.destroyed) {
      transport.detach()
      return
    }
    this.transport = transport
    transport.bind({
      output: (bytes) => this.acceptOutput(bytes),
      restoreBegin: () => this.resetTerminal(),
      ready: () => {
        if (this.destroyed || this.transport !== transport) return
        this.state = "ready"
        this.status.visible = false
        this.terminal.visible = true
        this.onReady()
      },
      exit: (exit) => {
        if (this.destroyed || this.transport !== transport) return
        this.transport = null
        const reason = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`
        this.fail("exited", `${this.definition.label} exited (${reason}); select its link to restart`)
      },
      lost: (error) => {
        if (this.destroyed || this.transport !== transport) return
        this.transport = null
        this.fail("lost", `${this.definition.label} disconnected: ${error.message}; select its link to retry`)
      },
    })
    transport.resize(this.currentSize())
  }

  private fail(state: Extract<RuntimeState, "exited" | "failed" | "lost">, message: string): void {
    if (this.destroyed) return
    this.state = state
    this.wantsFocus = false
    this.terminal.blur()
    this.terminal.visible = false
    this.status.content = message
    this.status.visible = true
    this.onUnavailable()
  }

  private acceptOutput(bytes: Uint8Array): void {
    const terminalData = this.cursorReportAdapter.toTerminal(bytes)
    if (terminalData.byteLength > 0) this.terminal.write(terminalData)
  }

  private resetTerminal(): void {
    this.cursorReportAdapter = new CursorReportAdapter()
    this.terminal.write(TERMINAL_RESET)
    if (this.colors) this.terminal.applyHostPalette(this.colors)
  }

  private writeInput(bytes: Uint8Array, source: EmbeddedTerminalDataSource): void {
    if (!this.transport || this.state === "exited") return
    this.transport.write(source === "response" ? this.cursorReportAdapter.toPty(bytes) : bytes)
  }

  private resize(cols: number, rows: number): void {
    this.size = { cols: Math.max(1, cols), rows: Math.max(1, rows) }
    this.transport?.resize(this.size)
  }

  private currentSize(): TerminalSize {
    return {
      cols: Math.max(1, this.terminal.width || this.size.cols),
      rows: Math.max(1, this.terminal.height || this.size.rows),
    }
  }
}

function runtimeKey(panelId: string, agentId: string): string {
  return `${agentId}\0${panelId}`
}

function errorMessage(error: unknown): string {
  return sanitizeTitle(error instanceof Error ? error.message : String(error)) || "unknown error"
}
