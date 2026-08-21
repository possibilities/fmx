import {
  BoxRenderable,
  type CliRenderer,
  EmbeddedTerminalRenderable,
  type KeyEvent,
  TextRenderable,
} from "@opentui/core"
import { basename } from "node:path"
import { createFxEnvironment } from "./fx-environment.ts"
import { commandKeyName, isPrefixKey, keyIdentity } from "./keys.ts"
import { OscTitleParser, sanitizeTitle } from "./title-parser.ts"

const COLORS = {
  background: "#090b10",
  chrome: "#171a23",
  chromeStrong: "#232938",
  text: "#d8dee9",
  muted: "#87909f",
  accent: "#7dd3fc",
  warning: "#fbbf24",
  error: "#fb7185",
}

const CTRL_B = new Uint8Array([0x02])
const CTRL_C = new Uint8Array([0x03])
const PREFIX_TIMEOUT_MS = 2_000
const GRACEFUL_EXIT_TIMEOUT_MS = 2_000
const FORCED_EXIT_TIMEOUT_MS = 500

export type MultiplexerOptions = {
  fxPath: string
  cwd: string
  initialFxArgs: string[]
  maxScrollback: number
}

type InstanceStatus = "starting" | "running" | "closing" | "exited" | "failed"
type FxProcess = ReturnType<typeof Bun.spawn>

type InstanceEvents = {
  isActive: (instance: FxInstance) => boolean
  onChange: () => void
}

class FxInstance {
  readonly terminal: EmbeddedTerminalRenderable
  readonly fallbackLabel: string
  label: string
  status: InstanceStatus = "starting"
  exitCode: number | null = null
  signalCode: string | null = null
  unread = false
  attention = false

  private processHandle: FxProcess | null = null
  private ptyClosed = false
  private stopPromise: Promise<void> | null = null
  private pendingInput: Uint8Array[] = []
  private readonly titleParser: OscTitleParser

  constructor(
    renderer: CliRenderer,
    private readonly id: number,
    private readonly cwd: string,
    private readonly argv: string[],
    private readonly fxPath: string,
    maxScrollback: number,
    private readonly events: InstanceEvents,
  ) {
    const workspace = basename(cwd) || "workspace"
    const fallback = argv.length > 0 ? `${workspace} (${launchLabel(argv)})` : workspace
    this.fallbackLabel = sanitizeTitle(fallback) || "fx"
    this.label = this.fallbackLabel
    this.titleParser = new OscTitleParser({
      onTitle: (title) => {
        this.label = title || this.fallbackLabel
        this.events.onChange()
      },
      onBell: () => {
        if (!this.events.isActive(this)) this.attention = true
      },
    })

    this.terminal = new EmbeddedTerminalRenderable(renderer, {
      id: `fx-${id}`,
      cols: 80,
      rows: 24,
      width: "100%",
      flexGrow: 1,
      visible: false,
      maxScrollback,
      selectable: true,
      onData: (data) => this.writeInput(data),
      onTerminalResize: (cols, rows) => this.resizePty(cols, rows),
    })
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
      void processHandle.exited.then((code) => this.recordExit(processHandle, code))
    } catch (error) {
      this.status = "failed"
      this.exitCode = 1
      this.terminal.write(`\r\nfmx: failed to start fx: ${errorMessage(error)}\r\n`)
      this.events.onChange()
    }
  }

  sendLiteralPrefix(): void {
    this.writeInput(CTRL_B)
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

  statusLabel(): string {
    switch (this.status) {
      case "starting":
        return "starting"
      case "running":
        return "running"
      case "closing":
        return "closing"
      case "failed":
        return "failed"
      case "exited":
        if (this.signalCode) return `signal ${this.signalCode}`
        return `exit ${this.exitCode ?? "?"}`
    }
  }

  private acceptOutput(data: Uint8Array): void {
    const unreadBefore = this.unread
    const attentionBefore = this.attention
    this.titleParser.push(data)
    this.terminal.write(data)
    if (!this.events.isActive(this)) this.unread = true
    if (this.unread !== unreadBefore || this.attention !== attentionBefore) this.events.onChange()
  }

  private writeInput(data: Uint8Array): void {
    const pty = this.processHandle?.terminal
    if (!pty || this.status === "exited" || this.status === "failed") {
      if (this.status === "starting") this.pendingInput.push(data.slice())
      return
    }
    try {
      pty.write(data)
    } catch {
      // Exit reconciliation owns the final state; stale input can be dropped.
    }
  }

  private flushPendingInput(): void {
    if (!this.processHandle?.terminal) return
    for (const data of this.pendingInput) this.writeInput(data)
    this.pendingInput = []
  }

  private resizePty(cols: number, rows: number): void {
    try {
      this.processHandle?.terminal?.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      // A resize racing process exit is harmless.
    }
  }

  private recordExit(processHandle: FxProcess, code: number): void {
    if (this.processHandle !== processHandle) return
    this.exitCode = code
    this.signalCode = processHandle.signalCode
    if (this.status !== "failed") this.status = "exited"
    this.closePty()
    this.events.onChange()
  }

  private async stopImpl(): Promise<void> {
    const processHandle = this.processHandle
    if (!processHandle || this.status === "exited" || this.status === "failed") {
      this.closePty()
      return
    }

    this.status = "closing"
    this.events.onChange()

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
  private readonly root: BoxRenderable
  private readonly headerText: TextRenderable
  private readonly stage: BoxRenderable
  private readonly footerText: TextRenderable
  private readonly helpModal: BoxRenderable
  private readonly instances: FxInstance[] = []
  private activeIndex = -1
  private nextId = 1
  private prefixArmed = false
  private prefixTimer: ReturnType<typeof setTimeout> | null = null
  private messageTimer: ReturnType<typeof setTimeout> | null = null
  private transientMessage: string | null = null
  private helpVisible = false
  private shuttingDown = false
  private readonly swallowedReleases = new Set<string>()
  private readonly donePromise: Promise<void>
  private resolveDone!: () => void
  private readonly keypressHandler = (key: KeyEvent) => this.onKeyPress(key)
  private readonly keyreleaseHandler = (key: KeyEvent) => this.onKeyRelease(key)

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: MultiplexerOptions,
  ) {
    this.donePromise = new Promise((resolveDone) => {
      this.resolveDone = resolveDone
    })

    this.root = new BoxRenderable(renderer, {
      id: "fmx-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: COLORS.background,
    })

    const header = new BoxRenderable(renderer, {
      id: "fmx-header",
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: COLORS.chromeStrong,
    })
    this.headerText = new TextRenderable(renderer, {
      id: "fmx-header-text",
      width: "100%",
      height: 1,
      content: " fmx",
      fg: COLORS.text,
      bg: COLORS.chromeStrong,
      wrapMode: "none",
      truncate: true,
    })
    header.add(this.headerText)

    this.stage = new BoxRenderable(renderer, {
      id: "fmx-stage",
      width: "100%",
      flexGrow: 1,
      backgroundColor: COLORS.background,
    })

    const footer = new BoxRenderable(renderer, {
      id: "fmx-footer",
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: COLORS.chrome,
    })
    this.footerText = new TextRenderable(renderer, {
      id: "fmx-footer-text",
      width: "100%",
      height: 1,
      content: "",
      fg: COLORS.muted,
      bg: COLORS.chrome,
      wrapMode: "none",
      truncate: true,
    })
    footer.add(this.footerText)

    this.helpModal = new BoxRenderable(renderer, {
      id: "fmx-help",
      position: "absolute",
      left: "50%",
      top: "50%",
      width: 56,
      height: 16,
      marginLeft: -28,
      marginTop: -8,
      padding: 1,
      border: true,
      borderStyle: "double",
      borderColor: COLORS.accent,
      backgroundColor: COLORS.chromeStrong,
      title: "fmx commands",
      titleAlignment: "center",
      zIndex: 100,
      visible: false,
    })
    this.helpModal.add(
      new TextRenderable(renderer, {
        id: "fmx-help-text",
        content: [
          "Ctrl-B c       new fx session",
          "Ctrl-B r       open fx session picker",
          "Ctrl-B R       resume latest session",
          "Ctrl-B n / p   next / previous instance",
          "Ctrl-B 1..9    select instance",
          "Ctrl-B x       gracefully close active instance",
          "Ctrl-B q       gracefully quit fmx",
          "Ctrl-B b       send literal Ctrl-B to fx",
          "Ctrl-B ?       toggle this help",
          "",
          "Ctrl-C, paste, mouse, and all other input go to fx.",
          "Press Escape or ? to close this help.",
        ].join("\n"),
        fg: COLORS.text,
      }),
    )

    this.root.add(header)
    this.root.add(this.stage)
    this.root.add(footer)
    this.renderer.root.add(this.root)
    this.renderer.root.add(this.helpModal)
    this.renderer.keyInput.on("keypress", this.keypressHandler)
    this.renderer.keyInput.on("keyrelease", this.keyreleaseHandler)
    this.renderer.setBackgroundColor(COLORS.background)
    this.refreshChrome()
  }

  start(): void {
    this.createInstance(this.options.initialFxArgs)
  }

  waitUntilDone(): Promise<void> {
    return this.donePromise
  }

  async shutdown(exitCode = 0): Promise<void> {
    if (this.shuttingDown) return this.donePromise
    this.shuttingDown = true
    this.cancelPrefix()
    this.hideHelp()
    this.showMessage("shutting down fx instances…", 0)

    try {
      await Promise.allSettled(this.instances.map((instance) => instance.stop()))
      this.renderer.keyInput.off("keypress", this.keypressHandler)
      this.renderer.keyInput.off("keyrelease", this.keyreleaseHandler)
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
      this.options.maxScrollback,
      {
        isActive: (candidate) => this.activeInstance() === candidate,
        onChange: () => this.refreshChrome(),
      },
    )
    this.instances.push(instance)
    this.stage.add(instance.terminal)
    this.switchTo(this.instances.length - 1)
    instance.start()
    this.refreshChrome()
  }

  private async closeActive(): Promise<void> {
    const instance = this.activeInstance()
    if (!instance || this.shuttingDown || instance.status === "closing") return
    this.showMessage(`closing ${instance.label}…`, 0)

    try {
      await instance.stop()
      if (this.shuttingDown) return

      const index = this.instances.indexOf(instance)
      if (index === -1) return
      const wasActive = this.activeInstance() === instance
      this.stage.remove(instance.terminal)
      instance.destroy()
      this.instances.splice(index, 1)
      this.transientMessage = null

      if (this.instances.length === 0) {
        this.activeIndex = -1
        this.refreshChrome()
      } else if (wasActive) {
        this.activeIndex = -1
        this.switchTo(Math.min(index, this.instances.length - 1))
      } else {
        if (index < this.activeIndex) this.activeIndex -= 1
        this.refreshChrome()
      }
    } catch (error) {
      if (!this.shuttingDown) this.showMessage(`failed to close ${instance.label}: ${errorMessage(error)}`)
    }
  }

  private switchTo(index: number): void {
    if (this.instances.length === 0) {
      this.activeIndex = -1
      this.refreshChrome()
      return
    }
    const normalized = ((index % this.instances.length) + this.instances.length) % this.instances.length
    const previous = this.activeInstance()
    if (previous) {
      previous.terminal.blur()
      previous.terminal.visible = false
    }

    this.activeIndex = normalized
    const active = this.instances[normalized]!
    active.unread = false
    active.attention = false
    active.terminal.visible = true
    active.terminal.focus()
    this.refreshChrome()
  }

  private activeInstance(): FxInstance | null {
    return this.instances[this.activeIndex] ?? null
  }

  private onKeyPress(key: KeyEvent): void {
    if (this.shuttingDown) {
      this.swallow(key)
      return
    }

    if (this.helpVisible) {
      this.swallow(key)
      if (key.name === "escape" || key.name === "?" || key.sequence === "?") this.hideHelp()
      return
    }

    if (this.prefixArmed) {
      this.swallow(key)
      this.cancelPrefix()
      this.runCommand(key)
      return
    }

    if (isPrefixKey(key)) {
      this.swallow(key)
      this.armPrefix()
    }
  }

  private onKeyRelease(key: KeyEvent): void {
    const identity = keyIdentity(key)
    if (!this.swallowedReleases.delete(identity)) return
    key.preventDefault()
    key.stopPropagation()
  }

  private runCommand(key: KeyEvent): void {
    const name = commandKeyName(key)
    switch (name) {
      case "c":
        this.createInstance()
        return
      case "r":
        this.createInstance(["-r"])
        return
      case "R":
        this.createInstance(["--resume-last"])
        return
      case "n":
        this.switchTo(this.activeIndex + 1)
        return
      case "p":
        this.switchTo(this.activeIndex - 1)
        return
      case "x":
        void this.closeActive()
        return
      case "q":
        void this.shutdown(0)
        return
      case "b":
        this.activeInstance()?.sendLiteralPrefix()
        return
      case "?":
        this.showHelp()
        return
      case "escape":
        this.refreshChrome()
        return
    }

    if (/^[1-9]$/u.test(name)) {
      const index = Number(name) - 1
      if (index < this.instances.length) this.switchTo(index)
      else this.showMessage(`instance ${name} does not exist`)
      return
    }
    this.showMessage(`unknown command: ${printableKey(key)}`)
  }

  private armPrefix(): void {
    this.prefixArmed = true
    if (this.prefixTimer) clearTimeout(this.prefixTimer)
    this.prefixTimer = setTimeout(() => {
      this.prefixTimer = null
      this.prefixArmed = false
      this.refreshChrome()
    }, PREFIX_TIMEOUT_MS)
    this.refreshChrome()
  }

  private cancelPrefix(): void {
    this.prefixArmed = false
    if (this.prefixTimer) clearTimeout(this.prefixTimer)
    this.prefixTimer = null
    this.refreshChrome()
  }

  private showHelp(): void {
    this.helpVisible = true
    this.helpModal.visible = true
    this.activeInstance()?.terminal.blur()
    this.refreshChrome()
  }

  private hideHelp(): void {
    if (!this.helpVisible) return
    this.helpVisible = false
    this.helpModal.visible = false
    if (!this.shuttingDown) this.activeInstance()?.terminal.focus()
    this.refreshChrome()
  }

  private swallow(key: KeyEvent): void {
    key.preventDefault()
    key.stopPropagation()
    this.swallowedReleases.add(keyIdentity(key))
  }

  private showMessage(message: string, durationMs = 2_000): void {
    this.transientMessage = message
    if (this.messageTimer) clearTimeout(this.messageTimer)
    this.messageTimer = null
    if (durationMs > 0) {
      this.messageTimer = setTimeout(() => {
        this.messageTimer = null
        this.transientMessage = null
        this.refreshChrome()
      }, durationMs)
    }
    this.refreshChrome()
  }

  private refreshChrome(): void {
    if (this.shuttingDown && this.renderer.isDestroyed) return
    const tabs = this.instances.map((instance, index) => {
      const marker = instance.attention ? "!" : instance.unread ? "*" : instance.status === "exited" ? "x" : ""
      const label = truncate(instance.label, 24)
      return index === this.activeIndex ? `[${index + 1}:${label}${marker}]` : `${index + 1}:${label}${marker}`
    })
    this.headerText.content = tabs.length > 0 ? ` fmx  ${tabs.join("  ")}` : " fmx  no instances"

    const active = this.activeInstance()
    const outerTitle = active ? `fmx · ${active.label}` : "fmx"
    this.renderer.setTerminalTitle(outerTitle)

    if (this.helpVisible) {
      this.footerText.content = " help open — Escape or ? closes"
      this.footerText.fg = COLORS.accent
    } else if (this.prefixArmed) {
      this.footerText.content = " command: c new | r picker | R last | n/p switch | 1-9 select | x close | q quit | b literal | ? help"
      this.footerText.fg = COLORS.accent
    } else if (this.transientMessage) {
      this.footerText.content = ` ${this.transientMessage}`
      this.footerText.fg = COLORS.warning
    } else if (active) {
      this.footerText.content = ` ${active.statusLabel()}  |  Ctrl-B command  |  Ctrl-B ? help`
      this.footerText.fg = active.status === "failed" ? COLORS.error : COLORS.muted
    } else {
      this.footerText.content = " Ctrl-B c new fx  |  Ctrl-B r resume  |  Ctrl-B q quit"
      this.footerText.fg = COLORS.muted
    }
  }
}

function printableKey(key: KeyEvent): string {
  if (key.sequence) return JSON.stringify(key.sequence)
  return key.name || "unknown"
}

function launchLabel(argv: string[]): string {
  if (argv[0] === "-r") return "resume picker"
  if (argv[0] === "--resume-last" || argv[0] === "-c") return "resume last"
  if (argv[0] === "--resume") return argv[1] ? `resume ${argv[1].slice(0, 8)}` : "resume last"
  return argv.join(" ")
}

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value)
  if (characters.length <= maxLength) return value
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`
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
