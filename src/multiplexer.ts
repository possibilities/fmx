import {
  bold,
  BoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  type EmbeddedTerminalDataSource,
  fg,
  type KeyEvent,
  type MouseEvent,
  type Selection,
  StyledText,
  type TerminalColors,
  type TextChunk,
  TextRenderable,
  type ThemeMode,
} from "@opentui/core"
import { basename } from "node:path"
import type { AgentSocket } from "./agent-socket.ts"
import { CursorReportAdapter } from "./cursor-report-adapter.ts"
import { DebugPanel, debugPanelWidth } from "./debug-panel.ts"
import { createFxEnvironment, type FxAgentSocketBinding } from "./fx-environment.ts"
import { FxTerminalRenderable } from "./fx-terminal.ts"
import { detectedTerminalColor, hasDetectedBackground, themeModeReport } from "./host-palette.ts"
import {
  actionForKey,
  keyIdentity,
  keyMatchesCombo,
  parseKeyCombo,
  type KeyAction,
  type Keybindings,
  type ResolvedBinding,
} from "./keybindings.ts"
import type { SocketFrame } from "./socket-frames.ts"
import { OscTitleParser, sanitizeTitle } from "./title-parser.ts"

const MODAL_FALLBACK_COLORS = {
  background: "#232938",
  foreground: "#d8dee9",
  accent: "#7dd3fc",
  backdrop: "#00000033",
  error: "#f87171",
  key: "#a3a3a3",
}

const SIDEBAR_DEFAULT_WIDTH = 26
const SIDEBAR_MIN_WIDTH = 16
const SIDEBAR_MAX_SCREEN_FRACTION = 1 / 3
// Blending the background slightly toward the foreground keeps the divider a
// faint hairline in any theme; a full palette gray reads visibly heavier.
const DIVIDER_BLEND = 0.2
const DIVIDER_FALLBACK_COLOR = "#4c566a"
// Dividers stay invisible until the host palette is known (or fx starts and it
// is definitively unknowable) so the theme-derived color never flashes over a
// guessed one on startup.
const DIVIDER_UNREVEALED_COLOR = "transparent"

const CTRL_C = new Uint8Array([0x03])
const HELP_CLOSE_KEY = parseKeyCombo("?")!
const MODIFIER_ONLY_KEYS = new Set([
  "leftshift",
  "leftctrl",
  "leftalt",
  "leftsuper",
  "lefthyper",
  "leftmeta",
  "rightshift",
  "rightctrl",
  "rightalt",
  "rightsuper",
  "righthyper",
  "rightmeta",
  "iso_level3_shift",
  "iso_level5_shift",
])
const GRACEFUL_EXIT_TIMEOUT_MS = 21_000
const FORCED_EXIT_TIMEOUT_MS = 500
const MAX_SCROLLBACK_BYTES = 10_000_000

type MultiplexerOptions = {
  fxPath: string
  cwd: string
  initialFxArgs: string[]
  keybindings: Keybindings
  agentSocket?: AgentSocket | null
  debugPanel?: boolean
  initialSidebarWidth?: number
  onSidebarWidthChange?: (width: number) => void
}

type InstanceStatus = "starting" | "running" | "closing" | "exited"
type FxProcess = ReturnType<typeof Bun.spawn>
type ModalKind = "help" | "spawn-error"

type InstanceEvents = {
  onTitleChange: (instance: FxInstance) => void
  onExit: (instance: FxInstance, exitCode: number) => void
}

class FxInstance {
  readonly terminal: FxTerminalRenderable
  private readonly fallbackLabel: string
  label: string
  status: InstanceStatus = "starting"

  private processHandle: FxProcess | null = null
  private ptyClosed = false
  private readonly cursorReportAdapter = new CursorReportAdapter()
  private readonly titleParser: OscTitleParser

  constructor(
    renderer: CliRenderer,
    private readonly id: number,
    private readonly cwd: string,
    private readonly argv: string[],
    private readonly fxPath: string,
    private readonly agentSocket: FxAgentSocketBinding | null,
    hostPalette: TerminalColors | null,
    private readonly events: InstanceEvents,
  ) {
    const workspace = basename(cwd) || "workspace"
    const fallback = argv.length > 0 ? `${workspace} (${argv.join(" ")})` : workspace
    this.fallbackLabel = sanitizeTitle(fallback) || "fx"
    this.label = this.fallbackLabel
    this.titleParser = new OscTitleParser({
      onTitle: (title) => {
        this.label = title || this.fallbackLabel
        this.events.onTitleChange(this)
      },
    })

    this.terminal = new FxTerminalRenderable(renderer, {
      id: `fx-${id}`,
      cols: 80,
      rows: 24,
      width: "100%",
      height: "100%",
      visible: false,
      maxScrollback: MAX_SCROLLBACK_BYTES,
      onData: (data, source) => this.writeInput(data, source),
      onTerminalResize: (cols, rows) => this.resizePty(cols, rows),
    })
    if (hostPalette) this.terminal.applyHostPalette(hostPalette)
  }

  start(): void {
    const processHandle = Bun.spawn([this.fxPath, ...this.argv], {
      cwd: this.cwd,
      env: createFxEnvironment(process.env, this.id, this.cwd, this.agentSocket),
      terminal: {
        cols: Math.max(1, this.terminal.width || 80),
        rows: Math.max(1, this.terminal.height || 24),
        data: (_pty, data) => this.acceptOutput(data),
      },
    })
    this.processHandle = processHandle
    this.status = "running"
    void processHandle.exited.then((exitCode) => this.recordExit(exitCode))
  }

  updateHostPalette(colors: TerminalColors, themeMode: ThemeMode | null): void {
    if (!this.terminal.applyHostPalette(colors)) return
    if (themeMode && hasDetectedBackground(colors)) this.writeInput(themeModeReport(themeMode), "response")
  }

  destroy(): void {
    this.terminal.blur()
    this.closePty()
    this.terminal.destroy()
  }

  private acceptOutput(data: Uint8Array): void {
    this.titleParser.push(data)
    const terminalData = this.cursorReportAdapter.toTerminal(data)
    if (terminalData.byteLength > 0) {
      this.terminal.write(terminalData)
      this.terminal.revealCursor()
    }
  }

  private writeInput(data: Uint8Array, source: EmbeddedTerminalDataSource): void {
    const pty = this.processHandle?.terminal
    if (!pty || this.status === "exited") return
    // Stop accepting user input once shutdown begins, but keep terminal-query
    // responses flowing so fx can restore and finalize its terminal cleanly.
    if (this.status === "closing" && source === "input") return
    const ptyData = source === "response" ? this.cursorReportAdapter.toPty(data) : data
    try {
      pty.write(ptyData)
    } catch {
      // Exit reconciliation owns the final state; stale input can be dropped.
    }
  }

  private resizePty(cols: number, rows: number): void {
    try {
      this.processHandle?.terminal?.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      // A resize racing process exit is harmless.
    }
  }

  private recordExit(exitCode: number): void {
    const trailingTerminalData = this.cursorReportAdapter.flushTerminalBytes()
    if (trailingTerminalData.byteLength > 0) this.terminal.write(trailingTerminalData)
    this.status = "exited"
    this.closePty()
    this.events.onExit(this, exitCode)
  }

  async stop(): Promise<void> {
    const processHandle = this.processHandle
    if (!processHandle || this.status === "exited") {
      this.closePty()
      return
    }

    this.status = "closing"

    // fx owns raw input and treats a second semantic Ctrl-C as a graceful exit,
    // including persistence finalization and its resume handoff. Extra presses
    // allow fx-owned modal surfaces to dismiss before the composer sees the pair.
    for (let attempt = 0; attempt < 4 && processHandle.exitCode === null; attempt += 1) {
      try {
        processHandle.terminal?.write(CTRL_C)
      } catch {
        break
      }
      await Bun.sleep(50)
    }

    if (!(await exitsWithin(processHandle, GRACEFUL_EXIT_TIMEOUT_MS))) {
      try {
        processHandle.kill("SIGTERM")
      } catch {
        // The child may have exited between the timeout and signal delivery.
      }
      if (!(await exitsWithin(processHandle, FORCED_EXIT_TIMEOUT_MS))) {
        try {
          processHandle.kill("SIGKILL")
        } catch {
          // Nothing remains to kill.
        }
        await exitsWithin(processHandle, FORCED_EXIT_TIMEOUT_MS)
      }
    }
    this.closePty()
  }

  private closePty(): void {
    if (this.ptyClosed) return
    this.ptyClosed = true
    try {
      this.processHandle?.terminal?.close()
    } catch {
      // PTY close is idempotent from fmx's perspective.
    }
  }
}

export class Multiplexer {
  private readonly stage: BoxRenderable
  private readonly sidebar: BoxRenderable
  private readonly divider: BoxRenderable
  private readonly content: BoxRenderable
  private readonly debugDivider: BoxRenderable | null = null
  private readonly debugPanel: DebugPanel | null = null
  private readonly agentSocket: AgentSocket | null
  private sidebarWidth = SIDEBAR_DEFAULT_WIDTH
  private dividerDragging = false
  private dragStartWidth = SIDEBAR_DEFAULT_WIDTH
  private readonly modalBackdrop: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly keybindings: Keybindings
  private readonly instances: FxInstance[] = []
  private activeIndex = -1
  private nextId = 1
  private prefixArmed = false
  private modalKind: ModalKind | null = null
  private spawnErrorLines: string[] = []
  private hostPalette: TerminalColors | null = null
  private shuttingDown = false
  private readonly swallowedReleases = new Set<string>()
  private readonly donePromise: Promise<void>
  private resolveDone!: () => void
  private readonly keypressHandler = (key: KeyEvent) => this.onKeyPress(key)
  private readonly keyreleaseHandler = (key: KeyEvent) => this.onKeyRelease(key)
  private readonly selectionHandler = (selection: Selection) => this.onSelection(selection)
  private readonly paletteHandler = (colors: TerminalColors) => this.onPalette(colors)
  private readonly resizeHandler = () => this.applyLayout()
  private readonly frameHandler = (frame: SocketFrame) => this.debugPanel?.append(frame)

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: MultiplexerOptions,
  ) {
    this.donePromise = new Promise((resolveDone) => {
      this.resolveDone = resolveDone
    })
    this.keybindings = options.keybindings
    this.sidebarWidth = options.initialSidebarWidth ?? SIDEBAR_DEFAULT_WIDTH
    const help = helpPlainText(this.keybindings)
    const helpLines = help.split("\n")
    const helpWidth = Math.max(...helpLines.map((line) => line.length)) + 5
    const helpHeight = helpLines.length + 2

    this.stage = new BoxRenderable(renderer, {
      id: "fmx-stage",
      width: "100%",
      height: "100%",
      flexDirection: "row",
    })
    this.sidebar = new BoxRenderable(renderer, {
      id: "fmx-sidebar",
      width: this.sidebarWidth,
      height: "100%",
      flexShrink: 0,
    })
    this.divider = new BoxRenderable(renderer, {
      id: "fmx-divider",
      width: 1,
      height: "100%",
      flexShrink: 0,
      border: ["left"],
      borderStyle: "single",
      borderColor: DIVIDER_UNREVEALED_COLOR,
      onMouseDown: (event) => this.beginDividerDrag(event),
      onMouseDrag: (event) => this.continueDividerDrag(event),
      onMouseUp: () => this.endDividerDrag(),
      onMouseDragEnd: () => this.endDividerDrag(),
    })
    this.content = new BoxRenderable(renderer, {
      id: "fmx-content",
      flexGrow: 1,
      flexShrink: 1,
      height: "100%",
    })
    this.stage.add(this.sidebar)
    this.stage.add(this.divider)
    this.stage.add(this.content)

    this.agentSocket = options.agentSocket ?? null
    if (options.debugPanel && this.agentSocket) {
      this.debugDivider = new BoxRenderable(renderer, {
        id: "fmx-debug-divider",
        width: 1,
        height: "100%",
        flexShrink: 0,
        border: ["left"],
        borderStyle: "single",
        borderColor: DIVIDER_UNREVEALED_COLOR,
      })
      this.debugPanel = new DebugPanel(renderer, this.agentSocket.path)
      this.stage.add(this.debugDivider)
      this.stage.add(this.debugPanel.root)
    }

    this.modalBackdrop = new BoxRenderable(renderer, {
      id: "fmx-modal-backdrop",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: MODAL_FALLBACK_COLORS.backdrop,
      zIndex: 100,
      visible: false,
      onMouseDown: () => this.hideModal(),
    })
    this.modal = new BoxRenderable(renderer, {
      id: "fmx-modal",
      position: "absolute",
      left: "50%",
      top: "50%",
      width: helpWidth,
      height: helpHeight,
      marginLeft: -Math.floor(helpWidth / 2),
      marginTop: -Math.floor(helpHeight / 2),
      paddingX: 1,
      border: true,
      borderStyle: "single",
      borderColor: MODAL_FALLBACK_COLORS.accent,
      backgroundColor: MODAL_FALLBACK_COLORS.background,
      visible: false,
      onMouseDown: (event) => event.stopPropagation(),
    })
    this.modalText = new TextRenderable(renderer, {
      id: "fmx-modal-text",
      content: styledHelpContent(this.keybindings, modalColors(this.hostPalette)),
      fg: MODAL_FALLBACK_COLORS.foreground,
      bg: MODAL_FALLBACK_COLORS.background,
      selectable: false,
    })
    this.modal.add(this.modalText)
    this.modalBackdrop.add(this.modal)
    this.applyModalPalette(this.hostPalette)

    this.renderer.root.add(this.stage)
    this.renderer.root.add(this.modalBackdrop)
    this.renderer.keyInput.on("keypress", this.keypressHandler)
    this.renderer.keyInput.on("keyrelease", this.keyreleaseHandler)
    this.renderer.on(CliRenderEvents.SELECTION, this.selectionHandler)
    this.renderer.on(CliRenderEvents.PALETTE, this.paletteHandler)
    this.renderer.on(CliRenderEvents.RESIZE, this.resizeHandler)
    if (this.debugPanel) this.agentSocket?.addFrameListener(this.frameHandler)
    this.applyLayout()
    this.refreshTerminalTitle()
  }

  start(): void {
    // The host palette query has settled by the time fx launches; if it never
    // produced colors, the fallback is the best divider color there will be.
    if (!this.hostPalette) this.applyDividerPalette(null)
    try {
      this.createInstance(this.options.initialFxArgs)
    } catch (error) {
      throw new Error(`failed to start fx: ${errorMessage(error)}`)
    }
  }

  setHostPalette(colors: TerminalColors): void {
    this.onPalette(colors)
  }

  waitUntilDone(): Promise<void> {
    return this.donePromise
  }

  async shutdown(exitCode = 0): Promise<void> {
    if (this.shuttingDown) return this.donePromise
    this.shuttingDown = true
    this.cancelPrefix()
    this.hideModal()

    try {
      await Promise.allSettled(this.instances.map((instance) => instance.stop()))
      this.renderer.keyInput.off("keypress", this.keypressHandler)
      this.renderer.keyInput.off("keyrelease", this.keyreleaseHandler)
      this.renderer.off(CliRenderEvents.SELECTION, this.selectionHandler)
      this.renderer.off(CliRenderEvents.PALETTE, this.paletteHandler)
      this.renderer.off(CliRenderEvents.RESIZE, this.resizeHandler)
      this.renderer.clearSelection()
      for (const instance of this.instances) instance.destroy()
    } finally {
      this.instances.length = 0
      this.renderer.destroy()
      process.exitCode = exitCode
      this.resolveDone()
    }
  }

  private createInstance(argv: string[] = []): void {
    if (this.shuttingDown) return
    const instanceId = this.nextId++
    const instance = new FxInstance(
      this.renderer,
      instanceId,
      this.options.cwd,
      argv,
      this.options.fxPath,
      this.agentSocketBinding(instanceId),
      this.hostPalette,
      {
        onTitleChange: (candidate) => {
          if (this.activeInstance() === candidate) this.refreshTerminalTitle()
        },
        onExit: (candidate, exitCode) => this.handleInstanceExit(candidate, exitCode),
      },
    )
    this.instances.push(instance)
    this.content.add(instance.terminal)
    this.switchTo(this.instances.length - 1)
    try {
      instance.start()
    } catch (error) {
      this.removeInstance(instance)
      throw error
    }
  }

  private handleInstanceExit(instance: FxInstance, exitCode: number): void {
    if (this.shuttingDown || !this.removeInstance(instance)) return
    if (this.instances.length === 0) void this.shutdown(exitCode)
  }

  private removeInstance(instance: FxInstance): boolean {
    const index = this.instances.indexOf(instance)
    if (index === -1) return false
    const wasActive = this.activeInstance() === instance
    this.content.remove(instance.terminal)
    instance.destroy()
    this.instances.splice(index, 1)

    if (this.instances.length === 0) {
      this.activeIndex = -1
      this.refreshTerminalTitle()
    } else if (wasActive) {
      this.activeIndex = -1
      this.switchTo(Math.min(index, this.instances.length - 1))
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1
    }
    return true
  }

  private switchTo(index: number): void {
    this.renderer.clearSelection()
    if (this.instances.length === 0) {
      this.activeIndex = -1
      this.refreshTerminalTitle()
      return
    }
    const normalized = ((index % this.instances.length) + this.instances.length) % this.instances.length
    const previous = this.activeInstance()
    if (previous) {
      previous.terminal.setHostSelectionEnabled(false)
      previous.terminal.blur()
      previous.terminal.visible = false
    }

    this.activeIndex = normalized
    const active = this.instances[normalized]!
    active.terminal.visible = true
    active.terminal.setHostSelectionEnabled(true)
    active.terminal.focus()
    this.refreshTerminalTitle()
  }

  private activeInstance(): FxInstance | null {
    return this.instances[this.activeIndex] ?? null
  }

  private agentSocketBinding(instanceId: number): FxAgentSocketBinding | null {
    const socket = this.agentSocket
    if (!socket) return null
    return { socketPath: socket.path, paneId: socket.paneIdFor(instanceId) }
  }

  private beginDividerDrag(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    this.dividerDragging = true
    this.dragStartWidth = this.sidebarWidth
    // Capture immediately: OpenTUI only latches drag capture on the first drag
    // event, and a fast flick can put that event past this one-cell divider —
    // over the terminal, which forwards motion to fx and stops propagation.
    this.captureMouse(this.divider)
  }

  private continueDividerDrag(event: MouseEvent): void {
    if (!this.dividerDragging) return
    event.preventDefault()
    event.stopPropagation()
    this.applySidebarWidth(event.x)
  }

  private endDividerDrag(): void {
    if (!this.dividerDragging) return
    this.dividerDragging = false
    if (this.sidebarWidth !== this.dragStartWidth) {
      this.options.onSidebarWidthChange?.(this.sidebarWidth)
    }
  }

  private captureMouse(renderable: BoxRenderable): void {
    // Not in CliRenderer's public typings; the renderer clears it on mouse-up.
    const capturer = this.renderer as unknown as {
      setCapturedRenderable?: (renderable: BoxRenderable) => void
    }
    capturer.setCapturedRenderable?.(renderable)
  }

  private applyLayout(requestedSidebarWidth = this.sidebarWidth): void {
    this.applyDebugPanelWidth()
    this.applySidebarWidth(requestedSidebarWidth)
  }

  private applyDebugPanelWidth(): void {
    this.debugPanel?.setWidth(debugPanelWidth(this.renderer.width))
  }

  private applySidebarWidth(requested = this.sidebarWidth): void {
    // The sidebar's third is measured against the space the debug panel leaves
    // behind, so the embedded terminal keeps the middle rather than being
    // squeezed between two fixed columns.
    const available = this.renderer.width - this.reservedDebugWidth()
    const max = Math.max(1, Math.floor(available * SIDEBAR_MAX_SCREEN_FRACTION))
    const min = Math.min(SIDEBAR_MIN_WIDTH, max)
    this.sidebarWidth = Math.max(min, Math.min(max, requested))
    this.sidebar.width = this.sidebarWidth
  }

  private reservedDebugWidth(): number {
    if (!this.debugPanel) return 0
    return debugPanelWidth(this.renderer.width) + 1
  }

  private onPalette(colors: TerminalColors): void {
    this.hostPalette = colors
    this.applyModalPalette(colors)
    this.applyDividerPalette(colors)
    const themeMode = this.renderer.themeMode
    for (const instance of this.instances) instance.updateHostPalette(colors, themeMode)
  }

  private applyDividerPalette(colors: TerminalColors | null): void {
    const color = dividerColor(colors)
    this.divider.borderColor = color
    this.divider.focusedBorderColor = color
    if (this.debugDivider) {
      this.debugDivider.borderColor = color
      this.debugDivider.focusedBorderColor = color
    }
    this.debugPanel?.applyPalette(colors)
  }

  private applyModalPalette(colors: TerminalColors | null): void {
    const palette = modalColors(colors)
    const borderColor = this.modalKind === "spawn-error" ? palette.error : palette.accent
    this.modalBackdrop.backgroundColor = palette.backdrop
    this.modal.backgroundColor = palette.background
    this.modal.borderColor = borderColor
    this.modal.focusedBorderColor = borderColor
    this.modalText.fg = palette.foreground
    this.modalText.bg = palette.background
    this.modalText.content =
      this.modalKind === "spawn-error"
        ? styledSpawnErrorContent(this.spawnErrorLines, palette)
        : styledHelpContent(this.keybindings, palette)
  }

  private onSelection(selection: Selection): void {
    // A plain click creates a provisional one-cell OpenTUI selection. Treat it
    // as focus, not a clipboard mutation; real drags clear isStart on movement.
    if (selection.isStart) {
      this.renderer.clearSelection()
      return
    }

    const text = selection.getSelectedText()
    if (!text) return
    if (this.renderer.copyToClipboardOSC52(text)) this.renderer.clearSelection()
  }

  private onKeyPress(key: KeyEvent): void {
    if (this.renderer.hasSelection) this.renderer.clearSelection()
    if (this.shuttingDown) {
      this.swallow(key)
      return
    }

    if (this.modalKind) {
      this.swallow(key)
      if (
        key.name === "escape" ||
        (this.modalKind === "help" && keyMatchesCombo(key, HELP_CLOSE_KEY))
      ) {
        this.hideModal()
      }
      return
    }

    if (this.prefixArmed) {
      this.swallow(key)
      if (MODIFIER_ONLY_KEYS.has(key.name.toLowerCase())) return
      this.cancelPrefix()
      if (key.name === "escape") return
      const action = actionForKey(this.keybindings, key, "prefix")
      if (action) this.executeAction(action)
      return
    }

    const directAction = actionForKey(this.keybindings, key, "direct")
    if (directAction) {
      this.swallow(key)
      this.executeAction(directAction)
      return
    }

    if (keyMatchesCombo(key, this.keybindings.prefix)) {
      this.swallow(key)
      this.prefixArmed = true
    }
  }

  private onKeyRelease(key: KeyEvent): void {
    const identity = keyIdentity(key)
    if (!this.swallowedReleases.delete(identity)) return
    key.preventDefault()
    key.stopPropagation()
  }

  private executeAction(action: KeyAction): void {
    switch (action.name) {
      case "new_tab":
        try {
          this.createInstance()
        } catch (error) {
          this.showSpawnError(error)
        }
        return
      case "previous_tab":
        this.switchTo(this.activeIndex - 1)
        return
      case "next_tab":
        this.switchTo(this.activeIndex + 1)
        return
      case "help":
        this.showHelp()
        return
    }
  }

  private cancelPrefix(): void {
    this.prefixArmed = false
  }

  private showHelp(): void {
    const helpLines = helpPlainText(this.keybindings).split("\n")
    this.showModal(
      "help",
      Math.max(...helpLines.map((line) => line.length)) + 5,
      helpLines.length + 2,
    )
  }

  private showSpawnError(error: unknown): void {
    const message = sanitizeTitle(errorMessage(error)) || "unknown error"
    const lineWidth = Math.max(1, Math.min(68, this.renderer.width - 5))
    this.spawnErrorLines = wrapText(message, lineWidth)
    const contentWidth = Math.max(
      "fx did not start".length,
      ...this.spawnErrorLines.map((line) => line.length),
    )
    this.showModal(
      "spawn-error",
      Math.min(this.renderer.width, contentWidth + 6),
      this.spawnErrorLines.length + 4,
    )
  }

  private showModal(kind: ModalKind, width: number, height: number): void {
    this.modalKind = kind
    this.resizeModal(width, height)
    this.applyModalPalette(this.hostPalette)
    this.modalBackdrop.visible = true
    this.modal.visible = true
    this.activeInstance()?.terminal.blur()
  }

  private resizeModal(width: number, height: number): void {
    this.modal.width = width
    this.modal.height = height
    this.modal.marginLeft = -Math.floor(width / 2)
    this.modal.marginTop = -Math.floor(height / 2)
  }

  private hideModal(): void {
    if (!this.modalKind) return
    this.modalKind = null
    this.modal.visible = false
    this.modalBackdrop.visible = false
    if (!this.shuttingDown) this.activeInstance()?.terminal.focus()
  }

  private swallow(key: KeyEvent): void {
    key.preventDefault()
    key.stopPropagation()
    this.swallowedReleases.add(keyIdentity(key))
  }

  private refreshTerminalTitle(): void {
    if (this.shuttingDown && this.renderer.isDestroyed) return
    const active = this.activeInstance()
    this.renderer.setTerminalTitle(active ? `fmx · ${active.label}` : "fmx")
  }
}

type ModalColors = typeof MODAL_FALLBACK_COLORS
type HelpEntry = readonly [key: string, description: string]

function dividerColor(colors: TerminalColors | null): string {
  const background = detectedTerminalColor(colors?.defaultBackground)
  const foreground = detectedTerminalColor(colors?.defaultForeground)
  if (background && foreground) return mixHexColors(background, foreground, DIVIDER_BLEND)
  return (
    detectedTerminalColor(colors?.palette[8]) ??
    detectedTerminalColor(colors?.palette[7]) ??
    DIVIDER_FALLBACK_COLOR
  )
}

function mixHexColors(base: string, tint: string, amount: number): string {
  const channel = (offset: number) => {
    const from = parseInt(base.slice(offset, offset + 2), 16)
    const to = parseInt(tint.slice(offset, offset + 2), 16)
    return Math.round(from + (to - from) * amount)
      .toString(16)
      .padStart(2, "0")
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

function modalColors(colors: TerminalColors | null): ModalColors {
  const foreground = detectedTerminalColor(colors?.defaultForeground) ?? MODAL_FALLBACK_COLORS.foreground
  return {
    foreground,
    background: detectedTerminalColor(colors?.defaultBackground) ?? MODAL_FALLBACK_COLORS.background,
    accent:
      detectedTerminalColor(colors?.palette[4]) ??
      detectedTerminalColor(colors?.palette[12]) ??
      MODAL_FALLBACK_COLORS.accent,
    backdrop: MODAL_FALLBACK_COLORS.backdrop,
    error:
      detectedTerminalColor(colors?.palette[1]) ??
      detectedTerminalColor(colors?.palette[9]) ??
      MODAL_FALLBACK_COLORS.error,
    key:
      detectedTerminalColor(colors?.palette[7]) ?? detectedTerminalColor(colors?.palette[8]) ?? foreground,
  }
}

function helpEntries(keybindings: Keybindings): HelpEntry[] {
  return [
    [keybindings.prefixLabel, "prefix mode"],
    [bindingLabel(keybindings.help), "keybinds"],
    [bindingLabel(keybindings.new_tab), "new agent"],
    [bindingLabel(keybindings.previous_tab), "prev agent"],
    [bindingLabel(keybindings.next_tab), "next agent"],
  ]
}

function helpPlainText(keybindings: Keybindings): string {
  const entries = helpEntries(keybindings)
  const keyColumn = helpKeyColumn(entries)
  return entries.map(([key, description]) => ` ${key.padEnd(keyColumn)}${description}`).join("\n")
}

function styledHelpContent(keybindings: Keybindings, colors: ModalColors): StyledText {
  const entries = helpEntries(keybindings)
  const keyColumn = helpKeyColumn(entries)
  const chunks: TextChunk[] = []
  for (const [index, [key, description]] of entries.entries()) {
    chunks.push(fg(colors.foreground)(index === 0 ? " " : "\n "))
    chunks.push(bold(fg(colors.key)(key.padEnd(keyColumn))))
    chunks.push(fg(colors.foreground)(description))
  }
  return new StyledText(chunks)
}

function styledSpawnErrorContent(lines: string[], colors: ModalColors): StyledText {
  const chunks: TextChunk[] = [bold(fg(colors.error)(" fx did not start")), fg(colors.foreground)("\n\n ")]
  chunks.push(fg(colors.foreground)(lines.join("\n ")))
  return new StyledText(chunks)
}

function helpKeyColumn(entries: HelpEntry[]): number {
  return Math.max(...entries.map(([key]) => key.length)) + 2
}

function bindingLabel(bindings: ResolvedBinding[]): string {
  return bindings.map((binding) => binding.label).join(" / ") || "unset"
}

function wrapText(value: string, width: number): string[] {
  const characters = [...value]
  const lines: string[] = []
  for (let offset = 0; offset < characters.length; offset += width) {
    lines.push(characters.slice(offset, offset + width).join(""))
  }
  return lines.length > 0 ? lines : [""]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function exitsWithin(processHandle: FxProcess, timeoutMs: number): Promise<boolean> {
  if (processHandle.exitCode !== null) return true
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      processHandle.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
