import {
  bold,
  BoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  type EmbeddedTerminalDataSource,
  fg,
  type KeyEvent,
  type Selection,
  StyledText,
  type TerminalColors,
  type TextChunk,
  TextRenderable,
  type ThemeMode,
} from "@opentui/core"
import { basename } from "node:path"
import { CursorReportAdapter } from "./cursor-report-adapter.ts"
import { createFxEnvironment } from "./fx-environment.ts"
import { FxTerminalRenderable } from "./fx-terminal.ts"
import { detectedTerminalColor, hasDetectedBackground, themeModeReport } from "./host-palette.ts"
import {
  actionForKey,
  keyMatchesCombo,
  parseKeyCombo,
  resolveKeybindings,
  type KeyAction,
  type Keybindings,
  type ResolvedBinding,
} from "./keybindings.ts"
import { keyIdentity } from "./keys.ts"
import { OscTitleParser, sanitizeTitle } from "./title-parser.ts"

const HELP_FALLBACK_COLORS = {
  background: "#232938",
  foreground: "#d8dee9",
  accent: "#7dd3fc",
  key: "#a3a3a3",
}

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

export type MultiplexerOptions = {
  fxPath: string
  cwd: string
  initialFxArgs: string[]
  hostPalette?: TerminalColors | null
  keybindings?: Keybindings
}

type InstanceStatus = "starting" | "running" | "closing" | "exited" | "failed"
type FxProcess = ReturnType<typeof Bun.spawn>

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
  private stopPromise: Promise<void> | null = null
  private pendingInput: Array<{ data: Uint8Array; source: EmbeddedTerminalDataSource }> = []
  private readonly cursorReportAdapter = new CursorReportAdapter()
  private readonly titleParser: OscTitleParser

  constructor(
    renderer: CliRenderer,
    private readonly id: number,
    private readonly cwd: string,
    private readonly argv: string[],
    private readonly fxPath: string,
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
    if (this.processHandle) return

    try {
      const processHandle = Bun.spawn([this.fxPath, ...this.argv], {
        cwd: this.cwd,
        env: createFxEnvironment(process.env, this.id, this.cwd),
        terminal: {
          cols: Math.max(1, this.terminal.width || 80),
          rows: Math.max(1, this.terminal.height || 24),
          data: (_pty, data) => this.acceptOutput(data),
        },
      })
      this.processHandle = processHandle
      this.status = "running"
      this.flushPendingInput()
      void processHandle.exited.then((exitCode) => this.recordExit(processHandle, exitCode))
    } catch (error) {
      this.status = "failed"
      this.terminal.write(`\r\nfmx: failed to start fx: ${errorMessage(error)}\r\n`)
    }
  }

  updateHostPalette(colors: TerminalColors, themeMode: ThemeMode | null): void {
    if (!this.terminal.applyHostPalette(colors)) return
    if (themeMode && hasDetectedBackground(colors)) this.writeInput(themeModeReport(themeMode), "response")
  }

  stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopImpl()
    return this.stopPromise
  }

  destroy(): void {
    this.terminal.blur()
    this.closePty()
    this.terminal.destroy()
  }

  private acceptOutput(data: Uint8Array): void {
    this.titleParser.push(data)
    const terminalData = this.cursorReportAdapter.toTerminal(data)
    if (terminalData.byteLength > 0) this.terminal.write(terminalData)
  }

  private writeInput(data: Uint8Array, source: EmbeddedTerminalDataSource): void {
    const pty = this.processHandle?.terminal
    if (!pty || this.status === "exited" || this.status === "failed") {
      if (this.status === "starting") this.pendingInput.push({ data: data.slice(), source })
      return
    }
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

  private flushPendingInput(): void {
    if (!this.processHandle?.terminal) return
    for (const { data, source } of this.pendingInput) this.writeInput(data, source)
    this.pendingInput = []
  }

  private resizePty(cols: number, rows: number): void {
    try {
      this.processHandle?.terminal?.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      // A resize racing process exit is harmless.
    }
  }

  private recordExit(processHandle: FxProcess, exitCode: number): void {
    if (this.processHandle !== processHandle) return
    const trailingTerminalData = this.cursorReportAdapter.flushTerminalBytes()
    if (trailingTerminalData.byteLength > 0) this.terminal.write(trailingTerminalData)
    if (this.status !== "failed") this.status = "exited"
    this.closePty()
    this.events.onExit(this, exitCode)
  }

  private async stopImpl(): Promise<void> {
    const processHandle = this.processHandle
    if (!processHandle || this.status === "exited" || this.status === "failed") {
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
  private readonly helpModal: BoxRenderable
  private readonly helpText: TextRenderable
  private readonly keybindings: Keybindings
  private readonly instances: FxInstance[] = []
  private activeIndex = -1
  private nextId = 1
  private prefixArmed = false
  private helpVisible = false
  private hostPalette: TerminalColors | null = null
  private shuttingDown = false
  private readonly swallowedReleases = new Set<string>()
  private readonly donePromise: Promise<void>
  private resolveDone!: () => void
  private readonly keypressHandler = (key: KeyEvent) => this.onKeyPress(key)
  private readonly keyreleaseHandler = (key: KeyEvent) => this.onKeyRelease(key)
  private readonly selectionHandler = (selection: Selection) => this.onSelection(selection)
  private readonly paletteHandler = (colors: TerminalColors) => this.onPalette(colors)

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: MultiplexerOptions,
  ) {
    this.donePromise = new Promise((resolveDone) => {
      this.resolveDone = resolveDone
    })
    this.hostPalette = options.hostPalette ?? null
    this.keybindings = options.keybindings ?? resolveKeybindings().keybindings
    const help = helpPlainText(this.keybindings)
    const helpLines = help.split("\n")
    const helpWidth = Math.max(...helpLines.map((line) => line.length)) + 5
    const helpHeight = helpLines.length + 2

    this.stage = new BoxRenderable(renderer, {
      id: "fmx-stage",
      width: "100%",
      height: "100%",
    })

    this.helpModal = new BoxRenderable(renderer, {
      id: "fmx-help",
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
      borderColor: HELP_FALLBACK_COLORS.accent,
      backgroundColor: HELP_FALLBACK_COLORS.background,
      zIndex: 100,
      visible: false,
    })
    this.helpText = new TextRenderable(renderer, {
      id: "fmx-help-text",
      content: styledHelpContent(this.keybindings, helpColors(this.hostPalette)),
      fg: HELP_FALLBACK_COLORS.foreground,
      bg: HELP_FALLBACK_COLORS.background,
      selectable: false,
    })
    this.helpModal.add(this.helpText)
    this.applyHelpPalette(this.hostPalette)

    this.renderer.root.add(this.stage)
    this.renderer.root.add(this.helpModal)
    this.renderer.keyInput.on("keypress", this.keypressHandler)
    this.renderer.keyInput.on("keyrelease", this.keyreleaseHandler)
    this.renderer.on(CliRenderEvents.SELECTION, this.selectionHandler)
    this.renderer.on(CliRenderEvents.PALETTE, this.paletteHandler)
    this.refreshTerminalTitle()
  }

  start(): void {
    this.createInstance(this.options.initialFxArgs)
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
    this.hideHelp()

    try {
      await Promise.allSettled(this.instances.map((instance) => instance.stop()))
      this.renderer.keyInput.off("keypress", this.keypressHandler)
      this.renderer.keyInput.off("keyrelease", this.keyreleaseHandler)
      this.renderer.off(CliRenderEvents.SELECTION, this.selectionHandler)
      this.renderer.off(CliRenderEvents.PALETTE, this.paletteHandler)
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
    const instance = new FxInstance(
      this.renderer,
      this.nextId++,
      this.options.cwd,
      argv,
      this.options.fxPath,
      this.hostPalette,
      {
        onTitleChange: (candidate) => {
          if (this.activeInstance() === candidate) this.refreshTerminalTitle()
        },
        onExit: (candidate, exitCode) => this.handleInstanceExit(candidate, exitCode),
      },
    )
    this.instances.push(instance)
    this.stage.add(instance.terminal)
    this.switchTo(this.instances.length - 1)
    instance.start()
  }

  private handleInstanceExit(instance: FxInstance, exitCode: number): void {
    if (this.shuttingDown || !this.removeInstance(instance)) return
    if (this.instances.length === 0) void this.shutdown(exitCode)
  }

  private removeInstance(instance: FxInstance): boolean {
    const index = this.instances.indexOf(instance)
    if (index === -1) return false
    const wasActive = this.activeInstance() === instance
    this.stage.remove(instance.terminal)
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

  private onPalette(colors: TerminalColors): void {
    this.hostPalette = colors
    this.applyHelpPalette(colors)
    const themeMode = this.renderer.themeMode
    for (const instance of this.instances) instance.updateHostPalette(colors, themeMode)
  }

  private applyHelpPalette(colors: TerminalColors | null): void {
    const palette = helpColors(colors)
    this.helpModal.backgroundColor = palette.background
    this.helpModal.borderColor = palette.accent
    this.helpModal.focusedBorderColor = palette.accent
    this.helpText.fg = palette.foreground
    this.helpText.bg = palette.background
    this.helpText.content = styledHelpContent(this.keybindings, palette)
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

    if (this.helpVisible) {
      this.swallow(key)
      if (key.name === "escape" || keyMatchesCombo(key, HELP_CLOSE_KEY)) this.hideHelp()
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
        this.createInstance()
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
    this.helpVisible = true
    this.helpModal.visible = true
    this.activeInstance()?.terminal.blur()
  }

  private hideHelp(): void {
    if (!this.helpVisible) return
    this.helpVisible = false
    this.helpModal.visible = false
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

type HelpColors = typeof HELP_FALLBACK_COLORS
type HelpEntry = readonly [key: string, description: string]

function helpColors(colors: TerminalColors | null): HelpColors {
  const foreground = detectedTerminalColor(colors?.defaultForeground) ?? HELP_FALLBACK_COLORS.foreground
  return {
    foreground,
    background: detectedTerminalColor(colors?.defaultBackground) ?? HELP_FALLBACK_COLORS.background,
    accent:
      detectedTerminalColor(colors?.palette[4]) ??
      detectedTerminalColor(colors?.palette[12]) ??
      HELP_FALLBACK_COLORS.accent,
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

function styledHelpContent(keybindings: Keybindings, colors: HelpColors): StyledText {
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

function helpKeyColumn(entries: HelpEntry[]): number {
  return Math.max(...entries.map(([key]) => key.length)) + 2
}

function bindingLabel(bindings: ResolvedBinding[]): string {
  return bindings.map((binding) => binding.label).join(" / ") || "unset"
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
