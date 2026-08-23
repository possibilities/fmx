import {
  BoxRenderable,
  type CliRenderer,
  type EmbeddedTerminalDataSource,
  fg,
  StyledText,
  type TerminalColors,
  TextRenderable,
  type ThemeMode,
  underline,
} from "@opentui/core"
import type { PanelDefinition } from "./config.ts"
import { CursorReportAdapter } from "./cursor-report-adapter.ts"
import { DebugPanel } from "./debug-panel.ts"
import { FmxTerminalRenderable } from "./fx-terminal.ts"
import { hasDetectedBackground, modalColors, themeModeReport } from "./host-palette.ts"
import type { TerminalSize, TerminalTransport } from "./instance-transport.ts"
import type { PanelContext, PanelSessionController } from "./panel-session.ts"
import type { SocketFrame } from "./socket-frames.ts"
import { sanitizeTitle } from "./title-parser.ts"

/** Invalid as a configured panel id, so the opt-in diagnostic tool can never
 * collide with a human's stable id. */
export const DEBUG_TOOL_ID = "$debug"
const MAX_SCROLLBACK_BYTES = 10_000_000
const TERMINAL_RESET = new Uint8Array([0x1b, 0x63])

export type ToolPanelTab = {
  id: string
  label: string
  persistent: boolean
  diagnostic?: boolean
}

export type ToolPanelOptions = {
  definitions: readonly PanelDefinition[]
  sessions: PanelSessionController | null
  debugSocketPath?: string | null
  initialSelectedId?: string
  onSelectedChange?: (id: string) => void
  onFocusRequest?: () => void
  onFocusLost?: () => void
}

type ToolEntry =
  | { kind: "terminal"; definition: PanelDefinition; tab: ToolPanelTab }
  | { kind: "debug"; tab: ToolPanelTab }

type RuntimeState = "loading" | "ready" | "exited" | "failed" | "lost"

/**
 * The right-side dock and the terminals shown inside it. A terminal runtime is
 * cached per Instance and configured tool for the lifetime of this fmx: local
 * tools therefore survive hiding, tab changes, and Instance switches, while
 * persistent tools keep living in the Companion after every transport lets go.
 */
export class ToolPanel {
  readonly root: BoxRenderable
  private readonly rail: BoxRenderable
  private readonly body: BoxRenderable
  private readonly contextStatus: TextRenderable
  private readonly entries: ToolEntry[]
  private readonly links = new Map<string, TextRenderable>()
  private readonly runtimes = new Map<string, ToolRuntime>()
  private readonly debugPanel: DebugPanel | null
  private selectedId: string
  private context: PanelContext | null = null
  private visible = false
  private wantsFocus = false
  private destroyed = false
  private colors: TerminalColors | null = null
  private themeMode: ThemeMode | null = null

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: ToolPanelOptions,
  ) {
    const terminalEntries: ToolEntry[] = options.definitions.map((definition) => ({
      kind: "terminal",
      definition,
      tab: { id: definition.id, label: definition.label, persistent: definition.persistent },
    }))
    const debugEntry: ToolEntry[] = options.debugSocketPath
      ? [{ kind: "debug", tab: { id: DEBUG_TOOL_ID, label: "Agent socket", persistent: false, diagnostic: true } }]
      : []
    this.entries = [...terminalEntries, ...debugEntry]
    if (this.entries.length === 0) throw new Error("a Tool panel needs at least one terminal or diagnostic tool")

    const requested = this.entries.find((entry) => entry.tab.id === options.initialSelectedId)
    // Preserve the old FMX_DEBUG_PANEL behavior: without saved selection, the
    // diagnostic it explicitly requested is the surface that opens.
    this.selectedId = requested?.tab.id ?? debugEntry[0]?.tab.id ?? this.entries[0]!.tab.id

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
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      visible: this.entries.length > 1,
    })
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
      content: "no active Instance",
      selectable: false,
      visible: false,
    })
    this.body.add(this.contextStatus)

    for (const entry of this.entries) this.addLink(entry)
    this.debugPanel = options.debugSocketPath ? new DebugPanel(renderer, options.debugSocketPath) : null
    if (this.debugPanel) {
      this.debugPanel.root.width = "100%"
      this.debugPanel.root.height = "100%"
      this.debugPanel.root.visible = false
      this.body.add(this.debugPanel.root)
    }
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
    if (this.entry(this.selectedId)?.kind !== "terminal" || this.context === null) return false
    return !this.currentRuntime()?.retryable
  }

  setWidth(width: number): void {
    this.root.width = width
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
      this.context?.instanceId === context?.instanceId &&
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

  /** Keep terminal focus in the Tool panel, including across an async attach. */
  focus(): boolean {
    if (!this.visible || !this.focusable) return false
    this.wantsFocus = true
    const runtime = this.activateCurrent()
    runtime?.focusWhenReady()
    return true
  }

  /** Hand focus ownership back to the Instance. */
  blur(): void {
    this.wantsFocus = false
    this.suspendFocus()
  }

  /** Temporarily remove cursor/input focus while a modal owns the screen. */
  suspendFocus(): void {
    for (const runtime of this.runtimes.values()) runtime.blur()
  }

  appendDebug(frame: SocketFrame): void {
    this.debugPanel?.append(frame)
  }

  applyPalette(colors: TerminalColors | null, themeMode: ThemeMode | null): void {
    this.colors = colors
    this.themeMode = themeMode
    this.contextStatus.fg = modalColors(colors).dim
    this.debugPanel?.applyPalette(colors)
    for (const runtime of this.runtimes.values()) runtime.applyPalette(colors, themeMode)
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

  /** An Instance ended, so no local renderer or PTY for its context remains. */
  forgetContext(instanceId: string): void {
    for (const [key, runtime] of this.runtimes) {
      if (runtime.context.instanceId !== instanceId) continue
      this.body.remove(runtime.root)
      runtime.destroy()
      this.runtimes.delete(key)
    }
    if (this.context?.instanceId === instanceId) this.setContext(null)
  }

  private addLink(entry: ToolEntry): void {
    const text = new TextRenderable(this.renderer, {
      id: `fmx-tool-panel-tab-label-${entry.tab.id}`,
      content: entry.tab.label,
      selectable: false,
    })
    const link = new BoxRenderable(this.renderer, {
      id: `fmx-tool-panel-tab-${entry.tab.id}`,
      width: [...entry.tab.label].length + 2,
      height: 1,
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      onMouseDown: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.select(entry.tab.id)
      },
    })
    link.add(text)
    this.links.set(entry.tab.id, text)
    this.rail.add(link)
  }

  private refreshLinks(): void {
    const colors = modalColors(this.colors)
    for (const entry of this.entries) {
      const text = this.links.get(entry.tab.id)
      if (!text) continue
      const active = entry.tab.id === this.selectedId
      text.content = new StyledText([
        active ? underline(fg(colors.accent)(entry.tab.label)) : fg(colors.dim)(entry.tab.label),
      ])
    }
  }

  private activateCurrent(forceRetry = false): ToolRuntime | null {
    this.contextStatus.visible = false
    if (this.debugPanel) this.debugPanel.root.visible = false
    for (const runtime of this.runtimes.values()) runtime.setVisible(false)

    const entry = this.entry(this.selectedId)
    if (!entry) return null
    if (entry.kind === "debug") {
      if (this.debugPanel) this.debugPanel.root.visible = true
      return null
    }
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
    const key = runtimeKey(definition.id, context.instanceId)
    const existing = this.runtimes.get(key)
    if (existing && (!forceRetry || !existing.retryable)) return existing
    if (existing) {
      this.body.remove(existing.root)
      existing.destroy()
      this.runtimes.delete(key)
    }
    const sessions = this.options.sessions
    if (!sessions) throw new Error("configured Tool panels need a session controller")
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
    runtime.applyPalette(this.colors, this.themeMode)
    this.runtimes.set(key, runtime)
    this.body.add(runtime.root)
    runtime.start()
    return runtime
  }

  private currentRuntime(): ToolRuntime | null {
    const entry = this.entry(this.selectedId)
    if (entry?.kind !== "terminal" || !this.context) return null
    return this.runtimes.get(runtimeKey(entry.definition.id, this.context.instanceId)) ?? null
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

  applyPalette(colors: TerminalColors | null, themeMode: ThemeMode | null): void {
    this.colors = colors
    this.status.fg = modalColors(colors).dim
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

function runtimeKey(panelId: string, instanceId: string): string {
  return `${instanceId}\0${panelId}`
}

function errorMessage(error: unknown): string {
  return sanitizeTitle(error instanceof Error ? error.message : String(error)) || "unknown error"
}
