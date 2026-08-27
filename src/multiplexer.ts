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
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename } from "node:path"
import {
  AgentRegistry,
  type AgentState,
  type DisplayState,
  displayStateFor,
  shortSessionId,
} from "./agent-registry.ts"
import type { AdeEventSource, AdeRecord } from "./ade-events.ts"
import { VERSION } from "./cli.ts"
import { CODEX_MODELS, codexEffort, codexModel, DEFAULT_CODEX_MODEL } from "./codex-catalog.ts"
import { DEFAULT_WORKTREE_ROOT } from "./config.ts"
import {
  ControlFailure,
  type ControlMethod,
  type AgentInfo,
  type CatalogInfo,
  type ControlSurface,
  type KeysInfo,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringList,
  parseTarget,
  requiredString,
  type TrayRow,
  type Snapshot,
  type SubagentInfo,
  type Surface,
  type Target,
} from "./control-protocol.ts"
import { CursorReportAdapter } from "./cursor-report-adapter.ts"
import {
  createFxEnvironment,
  type FxAdeBinding,
  type FxLaunchLevel,
} from "./fx-environment.ts"
import type { AgentManifest, ManifestEntry } from "./agent-manifest.ts"
import {
  AgentEndedError,
  AgentUnreachableError,
  type AgentExit,
  type AgentTransport,
  type AgentTransportFactory,
  stringEnvironment,
  type TerminalSize,
} from "./agent-transport.ts"
import { FxTerminalRenderable } from "./fx-terminal.ts"
import {
  type FxnkThemeResolution,
  fxnkRamp,
  type Ramp,
  themeModeReport,
} from "./host-palette.ts"
import {
  actionForKey,
  isCancelKey,
  keyIdentity,
  keyMatchesCombo,
  parseKeyCombo,
  type KeyAction,
  type Keybindings,
  type ResolvedBinding,
} from "./keybindings.ts"
import {
  isRepositoryDirectory,
  readGitContext,
  projectNameFor,
  type GitContext,
} from "./git-context.ts"
import { isSessionId } from "./fx-sessions.ts"
import { expandTilde, scanProjectRoots } from "./projects.ts"
import { SessionList, stateIcon } from "./session-list.ts"
import { SessionNames } from "./session-names.ts"
import { buildTree, type SessionEntry } from "./session-tree.ts"
import { type SubagentEntry, SubagentObserver } from "./subagents.ts"
import { OscTitleParser, sanitizeTitle } from "./title-parser.ts"
import { createWorktree, planWorktree, readHeadCommit, readWorktreeContext } from "./worktree.ts"
import type { BusState } from "./bus-protocol.ts"
import type { BusPublisher } from "./runtime-bus.ts"

/** The tray the embedded terminal sits beside; exported so tests can
 * address the terminal by its real screen column rather than a guess. */
export const TRAY_DEFAULT_WIDTH = 26
// The tray carries a project → branch → agent tree whose rows are names, and a
// name is the thing worth reading: half the stage is the useful ceiling, and
// the floor rises with it so a drag cannot leave a column too narrow to read a
// branch in. Both scale together — the range moved, not just its top.
const TRAY_MIN_WIDTH = 24
const TRAY_MAX_SCREEN_FRACTION = 1 / 2
const HELP_MODAL_TITLE = " keys "
const ERROR_MODAL_TITLE = " error "

const CTRL_D_KEY = parseKeyCombo("ctrl+d")!
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
/** How long after fx first reports itself the launch prompt is pasted in. */
const PROMPT_SETTLE_MS = 250
/** How long after the paste the send follows, so fx sees them apart. */
const PROMPT_SUBMIT_MS = 120
const PASTE_START = "\u001b[200~"
const PASTE_END = "\u001b[201~"

/** Preserve newlines while typing a CLI Launch prompt into Fx. The submit is
 * always a later write because Fx discards a paste followed in the same one. */
function bracketedPaste(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`
}
/** How many times, and how far apart, a lost transport is reached for before the Agent is let go of. */
const RECOVERY_ATTEMPTS = 3
const RECOVERY_INTERVAL_MS = 250
/** Restore the selected Agent alone, then bound inactive replay pressure. */
const RESTORE_CONCURRENCY = 4
export const EXIT_CONFIRMATION_TIMEOUT_MS = 2_000
const MAX_SCROLLBACK_BYTES = 10_000_000

type MultiplexerOptions = {
  fxPath: string
  cwd: string
  keybindings: Keybindings
  /** The Home's record of its Agents; every start and end is written through it. */
  manifest: AgentManifest
  /** Where Agents are started and reached. */
  transport: AgentTransportFactory
  /** Agents the join found running: attached, in display order, before anything else. */
  survivors?: readonly ManifestEntry[]
  adeSocket?: AdeEventSource | null
  initialTrayWidth?: number
  onTrayWidthChange?: (width: number) => void
  initialTrayHidden?: boolean
  onTrayHiddenChange?: (hidden: boolean) => void
  /** Stable identity to focus before the first restored frame. */
  initialActiveAgentId?: string
  onActiveAgentChange?: (agentId: string | null) => void
  /** Directories scanned one level deep for a CLI launch's default project. */
  projectRoots?: string[]
  /** Where a launch's new worktree is checked out. */
  worktreeRoot?: string
  home?: string
  /** Where every Bus peer, including `fmx control`, reaches this Runtime. */
  busSocketPath?: string
  /** State and activity the Multiplexer publishes onto the Runtime Bus. */
  bus?: BusPublisher | null
  /** Resolved before the first frame: FX_THEME -> OSC 11 -> COLORFGBG -> dark. */
  initialTheme?: FxnkThemeResolution
}

/** Default states `agent wait` waits for: any that needs someone. */
const WAIT_DEFAULT_STATES: readonly DisplayState[] = ["idle", "done", "blocked"]
const DISPLAY_STATES: readonly string[] = ["blocked", "working", "done", "idle", "unknown"]
type LaunchRequest = {
  directory: string
  prompt: string
  worktree: boolean
  model: string
  effort: string
}

type LaunchOverrides = {
  directory?: string
  prompt?: string
  worktree?: boolean
  model?: string
  effort?: string
}

const DEFAULT_THEME: FxnkThemeResolution = {
  theme: "dark",
  background: null,
  source: "default",
  explicit: false,
}

type AgentWaiter = {
  agentId: number
  states: readonly DisplayState[]
  settle: (state: DisplayState | null) => void
}

type AgentStatus = "starting" | "running" | "exited"
type ModalKind = "help" | "spawn-error"

type AgentEvents = {
  onTitleChange: (agent: FxAgent) => void
  onExit: (agent: FxAgent, exit: AgentExit) => void
  /** The transport went away under a running fx; nothing is known until asked. */
  onLost: (agent: FxAgent, error: Error) => void
}

/** RIS. Everything — screen, scrollback, modes — so a restore lands on nothing. */
const TERMINAL_RESET = new Uint8Array([0x1b, 0x63])

/**
 * One Agent as fmx shows it: the visible terminal, what fx has said its
 * title is, and the prompt it was launched with. The process and its PTY
 * are the transport's; this owns only the rendering side and the bytes
 * between the two.
 */
class FxAgent {
  readonly terminal: FxTerminalRenderable
  /** The number fmx's UI knows it by: the Manifest's display id. */
  readonly id: number
  /** Retained stable control and Companion-label identity. */
  readonly paneId: string
  private readonly fallbackLabel: string
  label: string
  status: AgentStatus = "starting"

  private transport: AgentTransport | null = null
  private detached = false
  /** The terminal's size as last laid out, for a transport attached later. */
  private size: TerminalSize = { cols: 80, rows: 24 }
  /** The prompt this agent was launched with, kept past the typing so
   * naming can use it without waiting for fx to write it down. */
  launchPrompt: string | null = null
  /** A launch prompt waiting for fx to be ready to be typed into. */
  private pendingPrompt: string | null = null
  /** fx reported before the transport arrived; the prompt is armed again at `adopt`. */
  private promptWaitingForTransport = false
  /** A prompt has gone in and fx has not yet said it is working on it. */
  awaitingWork = false
  /** A trustworthy idle boundary observed after `awaitingWork` was armed. */
  private awaitingWorkSawIdle = false
  private promptTimer: ReturnType<typeof setTimeout> | null = null
  private cursorReportAdapter = new CursorReportAdapter()
  private readonly titleParser: OscTitleParser

  constructor(
    renderer: CliRenderer,
    readonly entry: ManifestEntry,
    readonly cwd: string,
    private hostTheme: FxnkThemeResolution,
    private readonly events: AgentEvents,
  ) {
    this.id = entry.displayId
    this.paneId = entry.paneId
    const workspace = basename(cwd) || "workspace"
    this.fallbackLabel = sanitizeTitle(workspace) || "fx"
    this.label = this.fallbackLabel
    this.titleParser = new OscTitleParser({
      onTitle: (title) => {
        this.label = title || this.fallbackLabel
        this.events.onTitleChange(this)
      },
    })

    this.terminal = new FxTerminalRenderable(renderer, {
      id: `fx-${this.id}`,
      cols: 80,
      rows: 24,
      width: "100%",
      height: "100%",
      visible: false,
      maxScrollback: MAX_SCROLLBACK_BYTES,
      onData: (data, source) => this.writeInput(data, source),
      onTerminalResize: (cols, rows) => this.resizePty(cols, rows),
    })
    this.terminal.applyHostTheme(hostTheme)
  }

  /** fx takes no prompt on its command line, so a launch prompt is typed in
   * once fx is running — see `armPrompt`. */
  setPendingPrompt(prompt: string): void {
    if (prompt === "") return
    this.pendingPrompt = prompt
    this.launchPrompt = prompt
    this.awaitingWork = true
    this.awaitingWorkSawIdle = false
  }

  /** Whether a launch prompt is still waiting for fx to be ready. */
  get promptPending(): boolean {
    return this.pendingPrompt !== null
  }

  /** Paste `text` into a running fx and send it, the way a launch prompt
   * goes in — the two writes a beat apart, for the same reason. */
  send(text: string, lifecycleState: AgentState): void {
    if (this.status !== "running") throw new ControlFailure("busy", "the agent is not running")
    if (!this.transport) throw new ControlFailure("busy", "the agent is reconnecting")
    if (this.pendingPrompt !== null || this.promptTimer !== null) {
      throw new ControlFailure("busy", "the launch prompt has not been sent yet")
    }
    this.awaitingWork = true
    this.awaitingWorkSawIdle = lifecycleState === "idle"
    const encoder = new TextEncoder()
    this.writeInput(encoder.encode(bracketedPaste(text)), "input")
    this.promptTimer = setTimeout(() => {
      this.promptTimer = null
      if (this.status === "running") this.writeInput(encoder.encode("\r"), "input")
    }, PROMPT_SUBMIT_MS)
  }

  /** Observe admission without confusing an already-running turn for the
   * prompt whose latch was just armed. */
  observeWorkAdmission(event: string, state: AgentState): void {
    if (!this.awaitingWork) return
    if (event === "PromptQueued" || (this.awaitingWorkSawIdle && state !== "idle" && state !== "unknown")) {
      this.awaitingWork = false
      this.awaitingWorkSawIdle = false
      return
    }
    if (state === "idle") this.awaitingWorkSawIdle = true
  }

  /**
   * Type the launch prompt and send it. The first ADE record says fx's
   * lifecycle observer is up, but its input is drawn a beat later, so the
   * text goes in after a short settle rather than the instant fx speaks.
   */
  armPrompt(): void {
    if (this.pendingPrompt === null || this.promptTimer !== null) return
    this.promptTimer = setTimeout(() => {
      this.promptTimer = null
      // fx can report before the transport is adopted — `create` returns
      // once fx is running, and fx speaks first. The prompt waits for the
      // transport rather than being dropped on the floor.
      if (this.status === "starting") {
        this.promptWaitingForTransport = true
        return
      }
      const prompt = this.pendingPrompt
      this.pendingPrompt = null
      if (prompt === null || this.status !== "running") return
      // As a bracketed paste, not as typed bytes: a newline typed into fx
      // submits at the first line, where a pasted one stays part of the text.
      const encoder = new TextEncoder()
      this.writeInput(encoder.encode(bracketedPaste(prompt)), "input")
      // The send is a separate write: fx discards a paste when anything
      // follows its end marker in the same one.
      this.promptTimer = setTimeout(() => {
        this.promptTimer = null
        if (this.status === "running") this.writeInput(encoder.encode("\r"), "input")
      }, PROMPT_SUBMIT_MS)
    }, PROMPT_SETTLE_MS)
  }

  /** What a transport should be opened at: the terminal's size once it has one. */
  currentSize(): TerminalSize {
    return {
      cols: Math.max(1, this.terminal.width || this.size.cols),
      rows: Math.max(1, this.terminal.height || this.size.rows),
    }
  }

  /**
   * Take a transport, first or replacement. Bound before anything else so
   * the restore it answers the attach with has somewhere to land; the
   * terminal resets at its `RestoreBegin`, so a replacement replays onto a
   * clean screen rather than over the one the lost transport left.
   */
  adopt(transport: AgentTransport): void {
    if (this.detached || this.status === "exited") {
      transport.detach()
      return
    }
    this.transport?.detach()
    this.transport = transport
    transport.bind({
      output: (bytes) => this.acceptOutput(bytes),
      restoreBegin: () => this.resetTerminal(),
      ready: () => {},
      exit: (status) => this.recordExit(status),
      lost: (error) => {
        if (this.transport !== transport) return
        this.transport = null
        this.events.onLost(this, error)
      },
    })
    // The transport was opened at the size the terminal had when it was
    // asked for; the layout pass has usually run since, and its resize
    // found no transport to tell. A size that has not changed is a no-op
    // at the PTY.
    transport.resize(this.currentSize())
    if (this.status === "starting") this.status = "running"
    if (this.promptWaitingForTransport) {
      this.promptWaitingForTransport = false
      this.armPrompt()
    }
  }

  /** Whether a transport is carrying this agent right now. */
  get connected(): boolean {
    return this.transport !== null
  }

  updateHostTheme(resolution: FxnkThemeResolution): void {
    const changed =
      resolution.theme !== this.hostTheme.theme || resolution.background !== this.hostTheme.background
    this.hostTheme = resolution
    this.terminal.applyHostTheme(resolution)
    if (changed && !resolution.explicit) {
      this.writeInput(themeModeReport(resolution.theme), "response")
    }
  }

  /** Let go of fx without ending it, and take the terminal down. */
  destroy(): void {
    this.detach()
    this.terminal.blur()
    this.terminal.destroy()
  }

  /** Stop watching fx. It keeps running; the Companion holds it. */
  detach(): void {
    if (this.promptTimer !== null) clearTimeout(this.promptTimer)
    this.promptTimer = null
    this.detached = true
    this.transport?.detach()
    this.transport = null
  }

  private acceptOutput(data: Uint8Array): void {
    this.titleParser.push(data)
    const terminalData = this.cursorReportAdapter.toTerminal(data)
    if (terminalData.byteLength > 0) this.terminal.write(terminalData)
  }

  /**
   * What the transport replays is the whole terminal, so the one here must
   * hold nothing first: not the screen, not the scrollback, not a cursor
   * query half-translated when the last transport dropped. The resolved
   * terminal-default background goes back on afterwards — the replay restores
   * what fx set, not fmx's terminal state.
   */
  private resetTerminal(): void {
    this.cursorReportAdapter = new CursorReportAdapter()
    this.terminal.write(TERMINAL_RESET)
    this.terminal.applyHostTheme(this.hostTheme)
  }

  private writeInput(data: Uint8Array, source: EmbeddedTerminalDataSource): void {
    const transport = this.transport
    if (!transport || this.status === "exited") return
    const ptyData = source === "response" ? this.cursorReportAdapter.toPty(data) : data
    transport.write(ptyData)
  }

  private resizePty(cols: number, rows: number): void {
    this.size = { cols: Math.max(1, cols), rows: Math.max(1, rows) }
    this.transport?.resize(this.size)
  }

  private recordExit(status: AgentExit): void {
    if (this.status === "exited") return
    const trailingTerminalData = this.cursorReportAdapter.flushTerminalBytes()
    if (trailingTerminalData.byteLength > 0) this.terminal.write(trailingTerminalData)
    this.status = "exited"
    this.transport?.detach()
    this.transport = null
    this.events.onExit(this, status)
  }
}

export class Multiplexer {
  private readonly stage: BoxRenderable
  private readonly tray: BoxRenderable
  private readonly divider: BoxRenderable
  private readonly content: BoxRenderable
  private readonly emptyState: TextRenderable
  private readonly adeSocket: AdeEventSource | null
  private adeSubscribed = false
  private readonly registry = new AgentRegistry()
  private readonly sessionNames: SessionNames
  private readonly adeSequences = new Map<string, number>()
  /** Instances whose last accepted process generation ended orderly. */
  private readonly adeStoppedInstances = new Set<string>()
  private readonly sessionList: SessionList
  /** Hold restored Session-list mutations in the model until one final publish. */
  private sessionListPublicationHeld: boolean
  private readonly subagents: SubagentObserver
  private readonly seenSeq = new Map<number, number>()
  /** Per-directory git context, read once and reused by every agent there. */
  private readonly gitContexts = new Map<string, GitContext | null>()
  /** In-flight reads stay shared too, so lifecycle notices for a fast exit
   * resolve against the same answer and keep their arrival order. */
  private readonly gitContextLoads = new Map<string, Promise<GitContext | null>>()
  private trayWidth = TRAY_DEFAULT_WIDTH
  /** Hidden by the toggle key; orthogonal to the empty state, which hides the
   * tray because there is nothing to list. */
  private trayHidden = false
  private dividerDragging = false
  private dragStartWidth = TRAY_DEFAULT_WIDTH
  private readonly modalBackdrop: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly keybindings: Keybindings
  private readonly agents: FxAgent[] = []
  private activeIndex = -1
  private prefixArmed = false
  private modalKind: ModalKind | null = null
  private spawnErrorLines: string[] = []
  private spawnErrorHeading = "fx did not start"
  private theme: FxnkThemeResolution = DEFAULT_THEME
  private shuttingDown = false
  private exitConfirmationTimer: ReturnType<typeof setTimeout> | null = null
  private exitConfirmationKey: "ctrl+c" | "ctrl+d" | null = null
  private readonly swallowedReleases = new Set<string>()
  private readonly agentWaiters = new Set<AgentWaiter>()
  /** What `fmx control <command>` drives. */
  readonly control: ControlSurface = {
    handle: (method, params, signal) => this.handleControl(method, params, signal),
  }
  private readonly donePromise: Promise<void>
  private resolveDone!: () => void
  private readonly keypressHandler = (key: KeyEvent) => this.onKeyPress(key)
  private readonly keyreleaseHandler = (key: KeyEvent) => this.onKeyRelease(key)
  private readonly selectionHandler = (selection: Selection) => this.onSelection(selection)
  private readonly resizeHandler = () => this.applyLayout()
  private readonly adeHandler = (record: AdeRecord) => this.acceptAdeRecord(record)

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: MultiplexerOptions,
  ) {
    this.donePromise = new Promise((resolveDone) => {
      this.resolveDone = resolveDone
    })
    this.theme = options.initialTheme ?? DEFAULT_THEME
    const initialRamp = fxnkRamp(this.theme.theme)
    // The physical Client is cleared to the unused-field color before each
    // owner-sized frame. A transparent renderer would leave that clear visible
    // anywhere no child draws — around the splash text on first paint and in
    // stale tray cells after the last Agent disappears. The renderer's base is
    // the terminal-default canvas, chosen before any frame is exposed.
    this.renderer.setBackgroundColor(initialRamp.background)
    this.keybindings = options.keybindings
    this.trayWidth = options.initialTrayWidth ?? TRAY_DEFAULT_WIDTH
    this.trayHidden = options.initialTrayHidden ?? false
    this.sessionNames = new SessionNames({ home: options.home })
    this.subagents = new SubagentObserver({
      home: options.home,
      onChange: () => {
        this.refreshSessionList()
        this.publishBusState("subagents_changed")
      },
    })
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
    this.tray = new BoxRenderable(renderer, {
      id: "fmx-tray",
      width: this.trayWidth,
      height: "100%",
      flexShrink: 0,
      visible: false,
    })
    this.divider = new BoxRenderable(renderer, {
      id: "fmx-divider",
      width: 1,
      height: "100%",
      flexShrink: 0,
      border: ["left"],
      borderStyle: "single",
      borderColor: initialRamp.divider,
      visible: false,
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
      alignItems: "center",
      justifyContent: "center",
    })
    this.emptyState = new TextRenderable(renderer, {
      id: "fmx-empty-state",
      content: emptyStateContent(),
      fg: initialRamp.dim,
      selectable: false,
    })
    this.content.add(this.emptyState)
    this.stage.add(this.tray)
    this.stage.add(this.divider)
    this.stage.add(this.content)

    this.adeSocket = options.adeSocket ?? null
    this.sessionList = new SessionList(renderer, (agentId) => this.selectAgent(agentId))
    this.sessionList.applyTheme(this.theme.theme)
    this.sessionListPublicationHeld = (options.survivors?.length ?? 0) > 0
    this.sessionList.root.visible = !this.sessionListPublicationHeld
    this.tray.add(this.sessionList.root)

    this.modalBackdrop = new BoxRenderable(renderer, {
      id: "fmx-modal-backdrop",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: initialRamp.backdrop,
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
      borderColor: initialRamp.focus,
      backgroundColor: initialRamp.background,
      title: HELP_MODAL_TITLE,
      titleAlignment: "left",
      visible: false,
      onMouseDown: (event) => event.stopPropagation(),
    })
    this.modalText = new TextRenderable(renderer, {
      id: "fmx-modal-text",
      content: styledHelpContent(this.keybindings, initialRamp),
      fg: initialRamp.foreground,
      bg: initialRamp.background,
      selectable: false,
    })
    this.modal.add(this.modalText)
    this.modalBackdrop.add(this.modal)
    this.applyModalTheme()

    this.renderer.root.add(this.stage)
    this.renderer.root.add(this.modalBackdrop)
    this.renderer.keyInput.on("keypress", this.keypressHandler)
    this.renderer.keyInput.on("keyrelease", this.keyreleaseHandler)
    this.renderer.on(CliRenderEvents.SELECTION, this.selectionHandler)
    this.renderer.on(CliRenderEvents.RESIZE, this.resizeHandler)
    this.applyLayout()
    this.refreshTerminalTitle()
    this.publishBusState("initialized")
  }

  /**
   * Bring up what the join found running before anything new can be asked
   * for, in the order the Agents were numbered. Each attach is its own:
   * one that fails is reported and the rest still come up.
   */
  async start(): Promise<void> {
    if (this.shuttingDown) return
    this.subagents.start()
    const survivors = [...(this.options.survivors ?? [])].sort((a, b) => a.displayId - b.displayId)
    const restoring = survivors.map((entry) => this.prepareRestoredAgent(entry))
    // AdeSocket may already hold records accepted during the Companion join.
    // Subscribe only after their stable Manifest identities exist so replay
    // can fold them instead of discarding them as unknown instances.
    this.subscribeAde()
    if (restoring.length === 0) return

    const savedIndex = restoring.findIndex(
      (agent) => agent.entry.agentId === this.options.initialActiveAgentId,
    )
    this.switchTo(savedIndex === -1 ? 0 : savedIndex)

    // Reach the selected terminal first, while keeping the tray itself in
    // display-id order. It is the surface the renderer is about to expose.
    const active = this.activeAgent()!
    await this.attachRestoredAgent(active)
    if (this.shuttingDown) return
    await forEachConcurrent(
      restoring.filter((agent) => agent !== active),
      RESTORE_CONCURRENCY,
      async (agent) => {
        if (!this.shuttingDown) await this.attachRestoredAgent(agent)
      },
    )
    // Git, fx's display metadata, and subagent control records are durable
    // authorities, not copies in fmx. An older Manifest may not carry every
    // session identity, so install the final parent set after attach has had a
    // chance to supply it, then query both filesystem authorities together.
    await Promise.all([
      Promise.all(restoring.map((agent) => this.loadGitContext(agent.cwd))),
      this.syncSubagentParents(),
    ])
    if (this.shuttingDown) return
    this.sessionListPublicationHeld = false
    this.sessionList.root.visible = true
    this.refreshSessionList()
    this.publishBusState("restored")
  }

  setTheme(resolution: FxnkThemeResolution): void {
    if (this.shuttingDown) return
    this.theme = resolution
    const ramp = fxnkRamp(resolution.theme)
    this.renderer.setBackgroundColor(ramp.background)
    this.applyModalTheme()
    this.applyDividerTheme()
    this.refreshEmptyState()
    for (const agent of this.agents) agent.updateHostTheme(resolution)
    this.renderer.requestRender()
  }

  waitUntilDone(): Promise<void> {
    return this.donePromise
  }

  async shutdown(exitCode = 0): Promise<void> {
    if (this.shuttingDown) return this.donePromise
    this.shuttingDown = true
    this.cancelPrefix()
    if (this.exitConfirmationTimer !== null) clearTimeout(this.exitConfirmationTimer)
    this.exitConfirmationTimer = null
    this.exitConfirmationKey = null
    this.hideModal()
    this.subagents.stop()
    for (const waiter of this.agentWaiters) waiter.settle(null)
    this.agentWaiters.clear()

    try {
      // Let go, never end: fx and its terminal are the Companion's, and the
      // next fmx for this Home finds them where this one left them.
      for (const agent of this.agents) agent.detach()
      this.renderer.keyInput.off("keypress", this.keypressHandler)
      this.renderer.keyInput.off("keyrelease", this.keyreleaseHandler)
      this.renderer.off(CliRenderEvents.SELECTION, this.selectionHandler)
      this.renderer.off(CliRenderEvents.RESIZE, this.resizeHandler)
      this.renderer.clearSelection()
      for (const agent of this.agents) agent.destroy()
    } finally {
      this.agents.length = 0
      this.renderer.destroy()
      process.exitCode = exitCode
      this.resolveDone()
    }
  }

  /**
   * Start an fx. `focus` false leaves the screen where it is — an agent
   * starting workers should not keep taking the human's view — unless nothing
   * is on it yet, when the new agent is the only thing to show.
   *
   * The Manifest is written first and the Companion asked second, so a crash
   * anywhere between leaves a claim the next start's join resolves against
   * what the Companion actually holds. The Agent is on screen from the
   * claim: a start that fails takes it down again with the reason.
   */
  private async createAgent(
    // Named, never defaulted: `performLaunch` is the only caller and it has
    // already held this directory to a Git context.
    cwd: string,
    prompt = "",
    focus = true,
    launchLevel: FxLaunchLevel | null = null,
  ): Promise<FxAgent | null> {
    if (this.shuttingDown) return null
    this.cancelExitConfirmation()
    const { result: entry, saved } = this.options.manifest.claim({
      cwd,
      fxPath: this.options.fxPath,
      fxArgs: [],
      createdAt: Date.now(),
    })
    const agent = this.addAgent(entry, cwd, focus)
    agent.setPendingPrompt(prompt)
    this.publishBusState("awaiting_work_changed")
    let transport: AgentTransport
    try {
      await saved
      if (this.shuttingDown) throw new ControlFailure("shutting_down", "fmx is shutting down")
      transport = await this.options.transport.start({
        entry,
        // The claim's, not the option's: what the Manifest says was started is what is started.
        command: [entry.fxPath, ...(entry.fxArgs ?? [])],
        cwd,
        env: stringEnvironment(
          createFxEnvironment(
            process.env,
            entry.displayId,
            cwd,
            this.options.busSocketPath ?? null,
            launchLevel,
            this.adeBinding(entry.agentId),
          ),
        ),
        size: agent.currentSize(),
      })
    } catch (error) {
      if (error instanceof AgentUnreachableError) {
        // fx is running; only the way to it failed. It is recovered like a
        // lost transport, never removed — the Manifest says so first.
        await this.options.manifest.markRunning(entry.agentId).catch(() => {})
        void this.recoverAgent(agent, error)
        return agent
      }
      this.removeAgent(agent)
      // A write that fails here is the same disk that failed above; the
      // reason the start failed is the one to show.
      await this.options.manifest.remove(entry.agentId).catch(() => {})
      throw error
    }
    // fx is running whatever happens from here; the record says so before
    // anything else, because this is the acknowledgement a crash loses. A
    // write that fails leaves `creating` on disk, which the join resolves.
    await this.options.manifest.markRunning(entry.agentId).catch(() => {})
    if (this.shuttingDown || !this.agents.includes(agent)) {
      transport.detach()
      return null
    }
    agent.adopt(transport)
    return agent
  }

  /**
   * Attach to an Agent the Companion held between runs. The last ADE
   * truth is seeded before the renderer can expose this row; it stays true
   * until fx reports something newer. A launch prompt is not replayed —
   * there is none.
   */
  private prepareRestoredAgent(entry: ManifestEntry): FxAgent {
    const agent = this.addAgent(entry, entry.cwd, false, false)
    const checkpoint = entry.agentStatus
    const record = this.registry.seed(agent.paneId, {
      sessionId: entry.fxSessionId,
      state: checkpoint?.state ?? "unknown",
      attention: checkpoint?.attention ?? null,
    })
    this.seenSeq.set(
      agent.id,
      checkpoint?.seen === false ? Math.max(0, record.stateSeq - 1) : record.stateSeq,
    )
    if (entry.fxSessionId) this.sessionNames.recover(entry.fxSessionId)
    this.refreshSessionList()
    return agent
  }

  private async attachRestoredAgent(agent: FxAgent): Promise<void> {
    const entry = agent.entry
    try {
      const transport = await this.options.transport.attach(entry, agent.currentSize())
      if (this.shuttingDown || !this.agents.includes(agent)) {
        transport.detach()
        return
      }
      agent.adopt(transport)
    } catch (error) {
      this.removeAgent(agent)
      if (error instanceof AgentEndedError) {
        await this.options.manifest.remove(entry.agentId).catch(() => {})
        return
      }
      // Unreachable is not ended: the claim stays for the next start.
      this.showError(`agent ${entry.displayId} could not be restored`, error)
    }
  }

  /** Put an Agent on screen under its Manifest identity; nothing is attached yet. */
  private addAgent(
    entry: ManifestEntry,
    cwd: string,
    focus: boolean,
    selectIfEmpty = true,
  ): FxAgent {
    const agent = new FxAgent(this.renderer, entry, cwd, this.theme, {
      onTitleChange: (candidate) => {
        if (this.activeAgent() === candidate) this.refreshTerminalTitle()
        this.publishBusState("agent_label_changed")
      },
      onExit: (candidate) => this.handleAgentExit(candidate),
      onLost: (candidate, error) => void this.recoverAgent(candidate, error),
    })
    this.agents.push(agent)
    this.content.add(agent.terminal)
    this.refreshAgentChrome()
    if (focus || (selectIfEmpty && this.activeIndex === -1)) this.switchTo(this.agents.length - 1)
    this.loadGitContext(cwd)
    this.refreshSessionList()
    this.publishBusState("agent_added")
    return agent
  }

  /**
   * fx ended: the Agent, its claim, and whatever the Companion recorded
   * all go.
   */
  private handleAgentExit(agent: FxAgent): void {
    // The claim goes even mid-shutdown: the record is being consumed
    // regardless, and an entry without one is an exit the next start
    // cannot explain.
    void this.options.manifest.remove(agent.entry.agentId).catch(() => {})
    if (this.shuttingDown) return
    this.removeAgent(agent)
  }

  /**
   * The transport dropped under a running fx. Reach for it again: a live
   * session is re-attached and replays onto a reset terminal; one that
   * ended is removed exactly as an Exit would have; one that cannot be
   * reached after a few tries is let go of on screen but kept in the
   * Manifest, where the next start's join will find it.
   */
  private async recoverAgent(agent: FxAgent, lost: Error): Promise<void> {
    let error: unknown = lost
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RECOVERY_INTERVAL_MS))
      if (this.shuttingDown || !this.agents.includes(agent)) return
      try {
        const transport = await this.options.transport.attach(agent.entry, agent.currentSize())
        if (this.shuttingDown || !this.agents.includes(agent)) {
          transport.detach()
          return
        }
        agent.adopt(transport)
        return
      } catch (caught) {
        if (caught instanceof AgentEndedError) {
          this.handleAgentExit(agent)
          return
        }
        error = caught
      }
    }
    if (this.shuttingDown || !this.removeAgent(agent)) return
    this.showError(`lost agent ${agent.id}`, error)
  }

  private removeAgent(agent: FxAgent): boolean {
    const index = this.agents.indexOf(agent)
    if (index === -1) return false
    const wasActive = this.activeAgent() === agent
    this.content.remove(agent.terminal)
    agent.destroy()
    this.agents.splice(index, 1)
    this.registry.forget(this.paneIdFor(agent))
    this.adeSequences.delete(agent.entry.agentId)
    this.adeStoppedInstances.delete(agent.entry.agentId)
    this.seenSeq.delete(agent.id)
    this.refreshAgentChrome()
    for (const waiter of this.agentWaiters) {
      if (waiter.agentId !== agent.id) continue
      this.agentWaiters.delete(waiter)
      waiter.settle(null)
    }

    if (this.agents.length === 0) {
      this.activeIndex = -1
      this.options.onActiveAgentChange?.(null)
      this.refreshTerminalTitle()
      this.refreshSessionList()
    } else if (wasActive) {
      this.activeIndex = -1
      this.switchTo(Math.min(index, this.agents.length - 1))
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1
    }
    this.publishBusState("agent_removed")
    return true
  }

  private switchTo(index: number): void {
    this.renderer.clearSelection()
    if (this.agents.length === 0) {
      this.activeIndex = -1
      this.options.onActiveAgentChange?.(null)
      this.refreshTerminalTitle()
      return
    }
    const normalized = ((index % this.agents.length) + this.agents.length) % this.agents.length
    const previous = this.activeAgent()
    if (previous) {
      previous.terminal.setHostSelectionEnabled(false)
      previous.terminal.blur()
      previous.terminal.visible = false
    }

    this.activeIndex = normalized
    const active = this.agents[normalized]!
    this.options.onActiveAgentChange?.(active.entry.agentId)
    active.terminal.visible = true
    active.terminal.setHostSelectionEnabled(true)
    // A surface drawn over fx keeps the keys; it hands them back when it
    // closes, so an agent shown behind it must not take them now.
    if (!this.modalKind) this.restoreFocus()
    this.markSeen(active)
    this.refreshTerminalTitle()
    this.refreshSessionList()
    this.publishBusState("active_agent_changed")
  }

  private activeAgent(): FxAgent | null {
    return this.agents[this.activeIndex] ?? null
  }

  private refreshSessionList(): void {
    if (this.sessionListPublicationHeld) return
    void this.syncSubagentParents()
    this.sessionList.render(buildTree(this.sessionEntries()), this.trayWidth)
  }

  private syncSubagentParents(): Promise<void> {
    return this.subagents.setParents(
      this.agents.flatMap((agent) => {
        const sessionId = this.sessionIdOf(agent)
        return sessionId ? [sessionId] : []
      }),
    )
  }

  private setTrayHidden(hidden: boolean): void {
    if (hidden === this.trayHidden) return
    this.trayHidden = hidden
    this.refreshAgentChrome()
    this.options.onTrayHiddenChange?.(this.trayHidden)
  }

  private restoreFocus(): void {
    if (this.modalKind) return
    this.activeAgent()?.terminal.focus()
  }

  private refreshAgentChrome(): void {
    const hasAgents = this.agents.length > 0
    const showTray = hasAgents && !this.trayHidden
    this.tray.visible = showTray
    this.divider.visible = showTray
    this.emptyState.visible = !hasAgents
    if (!hasAgents) this.refreshEmptyState()
    this.applyLayout()
  }

  private refreshEmptyState(): void {
    const confirmingExit = this.exitConfirmationTimer !== null
    const palette = fxnkRamp(this.theme.theme)
    this.emptyState.content = confirmingExit
      ? `press ${this.exitConfirmationKey ?? "ctrl+c"} again to exit`
      : emptyStateContent()
    this.emptyState.fg = confirmingExit ? palette.foreground : palette.dim
  }

  private requestExitConfirmation(key: "ctrl+c" | "ctrl+d"): void {
    if (this.exitConfirmationTimer !== null) {
      clearTimeout(this.exitConfirmationTimer)
      this.exitConfirmationTimer = null
      this.exitConfirmationKey = null
      void this.shutdown()
      return
    }

    this.exitConfirmationKey = key
    this.exitConfirmationTimer = setTimeout(() => {
      this.exitConfirmationTimer = null
      this.exitConfirmationKey = null
      if (!this.shuttingDown && this.agents.length === 0) this.refreshEmptyState()
    }, EXIT_CONFIRMATION_TIMEOUT_MS)
    this.refreshEmptyState()
  }

  private cancelExitConfirmation(): void {
    if (this.exitConfirmationTimer !== null) clearTimeout(this.exitConfirmationTimer)
    this.exitConfirmationTimer = null
    this.exitConfirmationKey = null
    this.refreshEmptyState()
  }

  private sessionEntries(): SessionEntry[] {
    return this.agents.map((agent, index) => {
      const record = this.registry.get(this.paneIdFor(agent))
      const sessionId = this.sessionIdOf(agent)
      const git = this.gitContexts.get(agent.cwd) ?? null
      return {
        agentId: agent.id,
        project: projectNameFor(git, agent.cwd),
        branch: git?.branch ?? null,
        sessionId: shortSessionId(sessionId),
        name: sessionId ? this.sessionNames.nameFor(sessionId) : null,
        state: displayStateFor(record, this.seenSeq.get(agent.id) ?? 0),
        attention: record?.attention ?? null,
        active: index === this.activeIndex,
        subagents: sessionId ? this.subagents.childrenOf(sessionId) : [],
      }
    })
  }

  /**
   * fx never reports where it is working, so fmx reads it from the directory
   * it spawned the agent in. A live launch renders without a branch rung
   * until the answer arrives, which is why this refreshes rather than
   * blocking. Restored Agents await these reads behind the first-paint
   * preparation barrier.
   *
   * Only an answer is remembered. A read that fails — git slow enough to trip
   * its timeout while a start joins several at once, say — leaves nothing
   * behind, so the next call asks again instead of pinning that directory to
   * "no branch" for the life of the Runtime.
   */
  private loadGitContext(cwd: string): Promise<GitContext | null> {
    const pending = this.gitContextLoads.get(cwd)
    if (pending) return pending
    if (this.gitContexts.has(cwd)) return Promise.resolve(this.gitContexts.get(cwd) ?? null)
    const load = readGitContext(cwd).then((context) => {
      if (!this.shuttingDown && context) {
        this.gitContexts.set(cwd, context)
        this.refreshSessionList()
        this.publishBusState("git_context_changed")
      }
      return context
    }).finally(() => {
      this.gitContextLoads.delete(cwd)
    })
    this.gitContextLoads.set(cwd, load)
    return load
  }

  /**
   * Mark an agent acknowledged: its current state is now one the human has
   * looked at, so a finished turn stops reading as `done`.
   */
  private markSeen(agent: FxAgent): void {
    const record = this.registry.get(this.paneIdFor(agent))
    this.seenSeq.set(agent.id, record?.stateSeq ?? 0)
    this.checkpointAgent(agent)
  }

  /** Keep the last trustworthy ADE snapshot and its acknowledgement relation. */
  private checkpointAgent(agent: FxAgent): void {
    const record = this.registry.get(this.paneIdFor(agent))
    if (!record) return
    void this.options.manifest.setAgentStatus(agent.entry.agentId, {
      state: record.state,
      attention: record.attention,
      seen: (this.seenSeq.get(agent.id) ?? 0) >= record.stateSeq,
    }).catch(() => {})
  }

  private selectAgent(agentId: number): void {
    const index = this.agents.findIndex((agent) => agent.id === agentId)
    if (index === -1 || index === this.activeIndex) return
    this.switchTo(index)
  }

  private acceptAdeRecord(record: AdeRecord): void {
    const agent = this.agents.find((candidate) => candidate.entry.agentId === record.instanceId)
    if (!agent) return

    let previousSequence = this.adeSequences.get(record.instanceId)
    if (
      record.event === "FxStarted" &&
      record.sequence === 1 &&
      this.adeStoppedInstances.has(record.instanceId)
    ) {
      // An orderly in-place Fx relaunch keeps fmx's stable instance identity
      // but begins a new process-local ADE sequence at one.
      previousSequence = undefined
      this.adeSequences.delete(record.instanceId)
      this.adeStoppedInstances.delete(record.instanceId)
    }
    if (previousSequence !== undefined && record.sequence <= previousSequence) return
    const gap = previousSequence === undefined ? record.sequence !== 1 : record.sequence !== previousSequence + 1
    this.adeSequences.set(record.instanceId, record.sequence)
    // The first record observed is the only lifecycle-owned signal that fx is
    // ready for the delayed launch-prompt paste. A dropped FxStarted can be
    // repaired by any later record.
    agent.armPrompt()

    let changed = false
    // Identity and lifecycle are envelope context, not event payload. Main
    // records alone replace the active main identity: a child's parent
    // attribution can intentionally name an older session after `/new`.
    const previousSession = this.sessionIdOf(agent)
    const contextualIdentityChanged =
      record.context.agentRole === "main" && previousSession !== record.context.sessionId
    if (record.context.agentRole === "main") {
      changed = this.installAdeSession(agent, record.context.sessionId) || changed
    }
    if (gap) {
      const recoverySession = this.sessionIdOf(agent)
      // Installing a different identity already reads its durable sidecar.
      if (recoverySession && !contextualIdentityChanged) {
        changed = this.sessionNames.recover(recoverySession) || changed
      }
    }
    if (record.context.agentRole !== "main") {
      changed = this.subagents.applyAdeRecord(record) || changed
      if (changed) this.refreshSessionList()
      this.publishBusState("lifecycle")
      this.options.bus?.publishActivity(record, agent.entry.agentId, agent.id, gap)
      return
    }

    const folded = this.registry.apply(this.paneIdFor(agent), record)
    agent.observeWorkAdmission(record.event, folded.state)
    if (record.event === "FxStopped") this.adeStoppedInstances.add(record.instanceId)

    switch (record.event) {
      case "FxStarted":
        break
      case "SessionChanged":
        break
      case "SessionMetadataChanged": {
        const sessionId = record.context.sessionId
        const title = record.payload.title
        if (sessionId && typeof title === "string") {
          changed = this.sessionNames.apply(sessionId, title) || changed
        }
        break
      }
      default:
        // Schema 1 is additive. Unknown events still advance sequence.
        break
    }
    // A visible Agent is seen at the snapshot it just reported; an inactive
    // one is checkpointed as unseen so a completed turn survives Detach.
    if (this.activeAgent() === agent) this.markSeen(agent)
    else this.checkpointAgent(agent)
    this.refreshSessionList()
    this.settleAgentWaiters()
    this.publishBusState("lifecycle")
    this.options.bus?.publishActivity(record, agent.entry.agentId, agent.id, gap)
  }

  private installAdeSession(agent: FxAgent, sessionId: string | null): boolean {
    if (sessionId !== null && !isSessionId(sessionId)) return false
    const hadRecord = this.registry.get(this.paneIdFor(agent)) !== null
    const previous = this.sessionIdOf(agent)
    const identityChanged = !hadRecord || previous !== sessionId
    this.registry.setSessionId(this.paneIdFor(agent), sessionId)
    if (identityChanged) {
      void this.options.manifest.setFxSessionId(agent.entry.agentId, sessionId).catch(() => {})
    }
    const recovered = identityChanged && sessionId ? this.sessionNames.recover(sessionId) : false
    return previous !== sessionId || recovered
  }

  private home(): string {
    return this.options.home ?? homedir()
  }

  private paneIdFor(agent: FxAgent): string {
    return agent.paneId
  }

  private adeBinding(instanceId: string): FxAdeBinding | null {
    const socket = this.adeSocket
    return socket ? { socketPath: socket.path, instanceId } : null
  }

  private subscribeAde(): void {
    if (this.adeSubscribed || !this.adeSocket) return
    this.adeSubscribed = true
    this.adeSocket.addEventListener(this.adeHandler)
  }

  private sessionIdOf(agent: FxAgent): string | null {
    return this.registry.get(this.paneIdFor(agent))?.sessionId ?? null
  }

  private beginDividerDrag(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    this.dividerDragging = true
    this.dragStartWidth = this.trayWidth
    // Capture immediately: OpenTUI only latches drag capture on the first drag
    // event, and a fast flick can put that event past this one-cell divider —
    // over the terminal, which forwards motion to fx and stops propagation.
    this.captureMouse(this.divider)
  }

  private continueDividerDrag(event: MouseEvent): void {
    if (!this.dividerDragging) return
    event.preventDefault()
    event.stopPropagation()
    this.applyTrayWidth(event.x)
  }

  private endDividerDrag(): void {
    if (!this.dividerDragging) return
    this.dividerDragging = false
    if (this.trayWidth !== this.dragStartWidth) {
      this.options.onTrayWidthChange?.(this.trayWidth)
    }
  }

  private captureMouse(renderable: BoxRenderable): void {
    // Not in CliRenderer's public typings; the renderer clears it on mouse-up.
    const capturer = this.renderer as unknown as {
      setCapturedRenderable?: (renderable: BoxRenderable) => void
    }
    capturer.setCapturedRenderable?.(renderable)
  }

  private applyLayout(requestedTrayWidth = this.trayWidth): void {
    this.applyTrayWidth(requestedTrayWidth)
  }

  private applyTrayWidth(requested = this.trayWidth): void {
    // The ceiling is measured against the whole stage, so a given drag always
    // reaches the same width.
    const max = Math.max(1, Math.floor(this.renderer.width * TRAY_MAX_SCREEN_FRACTION))
    const min = Math.min(TRAY_MIN_WIDTH, max)
    this.trayWidth = Math.max(min, Math.min(max, requested))
    this.tray.width = this.trayWidth
    this.refreshSessionList()
  }

  private applyDividerTheme(): void {
    const color = fxnkRamp(this.theme.theme).divider
    this.divider.borderColor = color
    this.divider.focusedBorderColor = color
    this.sessionList.applyTheme(this.theme.theme)
    this.refreshSessionList()
  }

  /** The modal takes keys, so its border is the focus hue — or the error hue
   * when what took the screen is a failure. */
  private applyModalTheme(): void {
    const palette = fxnkRamp(this.theme.theme)
    const isError = this.modalKind === "spawn-error"
    const borderColor = isError ? palette.error : palette.focus
    this.modalBackdrop.backgroundColor = palette.backdrop
    this.modal.backgroundColor = palette.background
    this.modal.borderColor = borderColor
    this.modal.focusedBorderColor = borderColor
    // Every surface fmx draws over fx names itself in its own border, so what
    // took the screen is legible before any of its content is read.
    this.modal.title = isError ? ERROR_MODAL_TITLE : HELP_MODAL_TITLE
    this.modal.titleColor = palette.foreground
    this.modalText.fg = palette.foreground
    this.modalText.bg = palette.background
    this.modalText.content =
      this.modalKind === "spawn-error"
        ? styledSpawnErrorContent(this.spawnErrorHeading, this.spawnErrorLines, palette)
        : styledHelpContent(this.keybindings, palette)
  }

  private onSelection(selection: Selection): void {
    // FxTerminalRenderable keeps a gesture provisional until it has covered two
    // cells. Treat gestures that never cross that threshold as focus, not a
    // clipboard mutation. Activated selections may later contract to one cell.
    if (selection.isStart) {
      this.renderer.clearSelection()
      return
    }

    const text = selection.getSelectedText()
    if (!text) {
      // Blank terminal rows can form a real multi-cell selection but yield no
      // clipboard text. There is nothing useful to preserve after mouse-up.
      this.renderer.clearSelection()
      return
    }
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
        isCancelKey(key) ||
        (this.modalKind === "help" && keyMatchesCombo(key, HELP_CLOSE_KEY))
      ) {
        this.hideModal()
      }
      return
    }

    const emptyStateExitKey = isCancelKey(key) ? "ctrl+c" : keyMatchesCombo(key, CTRL_D_KEY) ? "ctrl+d" : null
    if (this.agents.length === 0 && emptyStateExitKey !== null) {
      this.swallow(key)
      this.cancelPrefix()
      this.requestExitConfirmation(emptyStateExitKey)
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
      case "detach":
        // A thin Client consumes this binding before its bytes reach the
        // Runtime. Treat a leaked or stale binding as inert: terminal input
        // must never turn one Client's Detach into a shared shutdown.
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
      case "toggle_tray":
        this.setTrayHidden(!this.trayHidden)
        return
    }
  }

  private cancelPrefix(): void {
    this.prefixArmed = false
  }

  /** The configured Projects, freshly scanned so a repository made a minute
   * ago is already available to a CLI launch that names no directory. */
  private projectDirectories(): string[] {
    const home = this.options.home ?? homedir()
    return scanProjectRoots(this.options.projectRoots ?? [], home)
  }

  /**
   * Check the repository, cut the worktree if asked, then start fx. Every CLI
   * launch passes here, making the repository a condition of running an Agent
   * rather than a rule the client has to remember. The context git answers with is kept,
   * so the row this launch adds is drawn under its branch from the first
   * frame rather than a beat later.
   */
  private async performLaunch(request: LaunchRequest, focus: boolean): Promise<FxAgent> {
    const origin = await readGitContext(request.directory)
    if (!origin) throw new NotARepositoryError(request.directory)
    this.gitContexts.set(request.directory, origin)
    let directory = request.directory
    if (request.worktree) {
      try {
        directory = await this.cutWorktree(request.directory)
      } catch (error) {
        throw new WorktreeError(errorMessage(error))
      }
      const cut = await readGitContext(directory)
      if (cut) this.gitContexts.set(directory, cut)
    }
    if (this.shuttingDown) throw new ControlFailure("shutting_down", "fmx is shutting down")
    const agent = await this.createAgent(directory, request.prompt, focus, {
      model: request.model,
      effort: request.effort,
    })
    if (!agent) throw new ControlFailure("shutting_down", "fmx is shutting down")
    return agent
  }

  /** Branch from what the launch was looking at and check it out under the
   * worktree root, returning where the agent should start. */
  private async cutWorktree(directory: string): Promise<string> {
    const context = await readWorktreeContext(directory)
    if (!context) throw new Error(`${directory} is not a git repository`)
    const base = await readHeadCommit(directory)
    const root = expandTilde(this.options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT, this.home())
    const plan = planWorktree(context, root)
    await createWorktree(context, plan, base)
    return plan.checkout
  }

  private showHelp(): void {
    const helpLines = helpPlainText(this.keybindings).split("\n")
    this.showModal(
      "help",
      Math.max(...helpLines.map((line) => line.length)) + 5,
      helpLines.length + 2,
    )
  }

  private showError(heading: string, error: unknown): void {
    const message = sanitizeTitle(errorMessage(error)) || "unknown error"
    const lineWidth = Math.max(1, Math.min(68, this.renderer.width - 5))
    this.spawnErrorHeading = heading
    this.spawnErrorLines = wrapText(message, lineWidth)
    const contentWidth = Math.max(
      heading.length,
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
    this.applyModalTheme()
    this.modalBackdrop.visible = true
    this.modal.visible = true
    this.activeAgent()?.terminal.blur()
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
    if (!this.shuttingDown) this.restoreFocus()
  }

  private swallow(key: KeyEvent): void {
    key.preventDefault()
    key.stopPropagation()
    this.swallowedReleases.add(keyIdentity(key))
  }

  /* ------------------------------------------------------------ control */

  /**
   * One method per `fmx control <command>`. Reads answer from what the screen already
   * knows; writes go through the same paths the keys and mouse take, so an
   * agent can do nothing a hand could not.
   */
  private async handleControl(
    method: ControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.shuttingDown) throw new ControlFailure("shutting_down", "fmx is shutting down")
    const caller = optionalInteger(params, "caller") ?? null
    switch (method) {
      case "orient":
        return this.snapshot(caller)
      case "agent.list":
        return { agents: this.agents.map((agent) => this.agentInfo(agent)) }
      case "agent.wait":
        return this.waitForAgent(
          this.resolveTarget(parseTarget(optionalString(params, "target") ?? "current"), caller),
          waitStates(optionalStringList(params, "states")),
          optionalInteger(params, "timeout_ms") ?? null,
          signal,
        )
      case "agent.send": {
        const agent = this.resolveTarget(parseTarget(requiredString(params, "target")), caller)
        const text = requiredString(params, "text").trim()
        if (text === "") throw new ControlFailure("invalid_params", "text is empty")
        const lifecycleState = this.registry.get(this.paneIdFor(agent))?.state ?? "unknown"
        agent.send(text, lifecycleState)
        this.publishBusState("awaiting_work_changed")
        return { agent: this.agentInfo(agent) }
      }
      case "launch": {
        const request = this.launchRequestFrom(params, caller)
        const focus = optionalBoolean(params, "focus") ?? false
        if (focus) this.refuseIfBusy()
        const agent = await this.performLaunch(request, focus)
        return { agent: this.agentInfo(agent) }
      }
      case "focus": {
        const agent = this.resolveTarget(parseTarget(requiredString(params, "target")), caller)
        this.refuseIfBusy()
        this.selectAgent(agent.id)
        return { agent: this.agentInfo(agent) }
      }
      case "catalog":
        return catalogInfo()
      case "tray": {
        const width = optionalInteger(params, "width")
        if (width !== undefined) {
          if (width < 1) throw new ControlFailure("invalid_params", "width must be at least 1")
          this.applyTrayWidth(width)
          this.options.onTrayWidthChange?.(this.trayWidth)
        }
        const hidden = optionalBoolean(params, "hidden")
        if (hidden !== undefined) this.setTrayHidden(hidden)
        else if (optionalBoolean(params, "toggle")) this.setTrayHidden(!this.trayHidden)
        return this.trayInfo()
      }
      case "keys": {
        if (optionalBoolean(params, "show")) {
          this.refuseIfBusy()
          this.showHelp()
        }
        return this.keysInfo()
      }
    }
  }

  /** Something drawn over fx takes the keys; a command that would fight it
   * for the screen is refused rather than silently stealing focus. */
  private refuseIfBusy(): void {
    if (this.modalKind) {
      throw new ControlFailure("busy", "something is already open", { surface: this.surface() })
    }
  }

  private resolveTarget(target: Target, caller: number | null): FxAgent {
    switch (target.kind) {
      case "id":
        return this.agentById(target.id)
      case "current":
        if (caller === null) {
          throw new ControlFailure("invalid_params", "current needs a caller inside an agent (FMX_AGENT_ID)")
        }
        return this.agentById(caller)
      case "active": {
        const active = this.activeAgent()
        if (!active) throw new ControlFailure("not_found", "no agent is active")
        return active
      }
      case "next":
      case "previous": {
        if (this.agents.length === 0) throw new ControlFailure("not_found", "no agents")
        const count = this.agents.length
        const step = target.kind === "next" ? 1 : -1
        return this.agents[(((this.activeIndex + step) % count) + count) % count]!
      }
      case "name": {
        const byName = this.agents.filter((agent) => this.nameOf(agent) === target.name)
        if (byName.length === 1) return byName[0]!
        if (byName.length > 1) {
          throw new ControlFailure("ambiguous", `${target.name} names more than one agent`, {
            agents: byName.map((agent) => agent.id),
          })
        }
        const bySession = this.agents.filter((agent) => this.sessionIdOf(agent)?.startsWith(target.name))
        if (bySession.length === 1) return bySession[0]!
        if (bySession.length > 1) {
          throw new ControlFailure("ambiguous", `${target.name} names more than one agent`, {
            agents: bySession.map((agent) => agent.id),
          })
        }
        throw new ControlFailure("not_found", `no agent named ${target.name}`)
      }
    }
  }

  /**
   * Where a launch that names no project and comes from no agent starts: fmx's
   * own workspace when it is a repository, and otherwise the first configured
   * Project on offer.
   * The first configured root is commonly a directory of repositories rather
   * than one itself, and `~/code` is the very line startup tells a human to
   * add, so this is the ordinary case and not an edge.
   */
  private defaultLaunchDirectory(): string {
    const workspace = this.options.cwd
    if (isRepositoryDirectory(workspace)) return workspace
    const [first] = this.projectDirectories()
    if (!first) throw new NotARepositoryError(workspace)
    return first
  }

  private agentById(id: number): FxAgent {
    const agent = this.agents.find((candidate) => candidate.id === id)
    if (!agent) throw new ControlFailure("not_found", `no agent ${id}`)
    return agent
  }

  private launchRequestFrom(params: Record<string, unknown>, caller: number | null): LaunchRequest {
    const overrides = this.launchOverridesFrom(params)
    const callerAgent = caller === null ? null : (this.agents.find((agent) => agent.id === caller) ?? null)
    return {
      directory: overrides.directory ?? callerAgent?.cwd ?? this.defaultLaunchDirectory(),
      prompt: overrides.prompt ?? "",
      worktree: overrides.worktree ?? false,
      model: overrides.model ?? DEFAULT_CODEX_MODEL.id,
      effort: overrides.effort ?? DEFAULT_CODEX_MODEL.defaultEffort,
    }
  }

  /** Validate the optional fields supplied by `fmx control launch`. */
  private launchOverridesFrom(fields: Record<string, unknown>): LaunchOverrides {
    const overrides: LaunchOverrides = {}
    const directory = optionalString(fields, "directory")
    if (directory !== undefined) {
      let resolved: string
      try {
        resolved = realpathSync(expandTilde(directory, this.home()))
        if (!statSync(resolved).isDirectory()) throw new Error("not a directory")
      } catch {
        throw new ControlFailure("invalid_params", `${directory} is not a directory`)
      }
      if (!isRepositoryDirectory(resolved)) throw new NotARepositoryError(directory)
      overrides.directory = resolved
    }
    const prompt = optionalString(fields, "prompt")
    if (prompt !== undefined) overrides.prompt = prompt
    const worktree = optionalBoolean(fields, "worktree")
    if (worktree !== undefined) overrides.worktree = worktree
    const modelId = optionalString(fields, "model")
    const model = codexModel(modelId ?? DEFAULT_CODEX_MODEL.id)
    if (!model) throw new ControlFailure("invalid_params", `unknown Codex model: ${modelId}`)
    if (modelId !== undefined) overrides.model = modelId
    const effort = optionalString(fields, "effort")
    if (effort !== undefined) {
      if (!codexEffort(model, effort)) {
        throw new ControlFailure("invalid_params", `${model.id} does not support effort ${effort}`, {
          model: model.id,
          efforts: model.efforts,
        })
      }
      overrides.effort = effort
    }
    return overrides
  }

  private waitForAgent(
    agent: FxAgent,
    states: readonly DisplayState[],
    timeoutMs: number | null,
    signal: AbortSignal,
  ): Promise<{ agent: AgentInfo; state: DisplayState }> {
    const settled = this.waitedState(agent, states)
    if (settled) return Promise.resolve({ agent: this.agentInfo(agent), state: settled })
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const waiter: AgentWaiter = {
        agentId: agent.id,
        states,
        settle: (state) => {
          cleanup()
          if (state === null) reject(new ControlFailure("not_found", `agent ${agent.id} exited`))
          else resolve({ agent: this.agentInfo(agent), state })
        },
      }
      const abort = () => {
        cleanup()
        reject(new ControlFailure("cancelled", `waiting for agent ${agent.id} was cancelled`))
      }
      const cleanup = () => {
        this.agentWaiters.delete(waiter)
        if (timer) clearTimeout(timer)
        signal.removeEventListener("abort", abort)
      }
      this.agentWaiters.add(waiter)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          cleanup()
          reject(
            new ControlFailure("timeout", `agent ${agent.id} is ${this.displayStateOf(agent)} after ${timeoutMs}ms`),
          )
        }, timeoutMs)
      }
    })
  }

  /** The state a wait resolves on, or null while it should keep waiting. A
   * prompt that has gone in but not yet been picked up holds the wait: the
   * idle fx reports at startup is not the idle that means it has finished. */
  private waitedState(agent: FxAgent, states: readonly DisplayState[]): DisplayState | null {
    if (agent.awaitingWork) return null
    const state = this.displayStateOf(agent)
    return states.includes(state) ? state : null
  }

  private settleAgentWaiters(): void {
    for (const waiter of this.agentWaiters) {
      const agent = this.agents.find((candidate) => candidate.id === waiter.agentId)
      if (!agent) {
        waiter.settle(null)
        continue
      }
      const state = this.waitedState(agent, waiter.states)
      if (state) waiter.settle(state)
    }
  }

  private displayStateOf(agent: FxAgent): DisplayState {
    return displayStateFor(this.registry.get(this.paneIdFor(agent)), this.seenSeq.get(agent.id) ?? 0)
  }

  private nameOf(agent: FxAgent): string | null {
    const sessionId = this.sessionIdOf(agent)
    return sessionId ? this.sessionNames.nameFor(sessionId) : null
  }

  private agentInfo(agent: FxAgent): AgentInfo {
    const record = this.registry.get(this.paneIdFor(agent))
    const sessionId = this.sessionIdOf(agent)
    const git = this.gitContexts.get(agent.cwd) ?? null
    return {
      agent_id: agent.entry.agentId,
      id: agent.id,
      display_id: agent.id,
      pane_id: this.paneIdFor(agent),
      created_at: agent.entry.createdAt,
      cwd: agent.cwd,
      project: projectNameFor(git, agent.cwd),
      git_root: git?.root ?? null,
      main_git_root: git?.mainRoot ?? null,
      branch: git?.branch ?? null,
      worktree: git ? git.root !== git.mainRoot : null,
      name: this.nameOf(agent),
      session_id: sessionId,
      label: agent.label,
      state: this.displayStateOf(agent),
      attention: record?.attention ?? null,
      active: this.activeAgent() === agent,
      awaiting_work: agent.awaitingWork,
      subagents: sessionId ? subagentInfos(this.subagents.childrenOf(sessionId)) : [],
    }
  }

  private busState(): BusState {
    return {
      active_agent_id: this.activeAgent()?.entry.agentId ?? null,
      agents: this.agents.map((agent) => this.agentInfo(agent)),
    }
  }

  private publishBusState(cause: string): void {
    this.options.bus?.updateState(this.busState(), cause)
  }

  private surface(): Surface {
    if (this.modalKind === "help") return { kind: "help" }
    if (this.modalKind === "spawn-error") {
      return { kind: "error", heading: this.spawnErrorHeading, message: this.spawnErrorLines.join("") }
    }
    return { kind: "none" }
  }

  private snapshot(caller: number | null): Snapshot {
    const you = caller === null ? null : (this.agents.find((agent) => agent.id === caller) ?? null)
    const rows: TrayRow[] = buildTree(this.sessionEntries()).map((row) => ({
      kind: row.kind,
      depth: row.depth,
      text:
        row.kind === "agent" || row.kind === "subagent"
          ? `${stateIcon(row.state, row.attention)} ${row.label || "—"}`
          : row.label,
      agent: row.agentId,
      active: row.active,
    }))
    return {
      fmx: {
        pid: process.pid,
        version: VERSION,
        cwd: this.options.cwd,
        socket: this.options.busSocketPath ?? "",
        cols: this.renderer.width,
        rows: this.renderer.height,
      },
      you: you ? this.agentInfo(you) : null,
      active: this.activeAgent()?.id ?? null,
      agents: this.agents.map((agent) => this.agentInfo(agent)),
      tray: { ...this.trayInfo(), rows },
      surface: this.surface(),
    }
  }

  /** `visible` is what is drawn; `hidden` is the human's choice, which an
   * empty fmx keeps without showing. */
  private trayInfo(): { visible: boolean; hidden: boolean; width: number } {
    return { visible: this.tray.visible, hidden: this.trayHidden, width: this.trayWidth }
  }

  private keysInfo(): KeysInfo {
    const commands: Record<string, string | null> = {
      help: "fmx control keys --show",
      detach: null,
      previous_tab: "fmx control focus previous",
      next_tab: "fmx control focus next",
      toggle_tray: "fmx control tray --toggle",
    }
    const bindings: KeysInfo["bindings"] = {}
    for (const action of [
      "help",
      "detach",
      "previous_tab",
      "next_tab",
      "toggle_tray",
    ] as const) {
      bindings[action] = {
        keys: this.keybindings[action].map((binding) => binding.label),
        command: commands[action] ?? null,
      }
    }
    return { prefix: this.keybindings.prefixLabel, bindings }
  }

  private refreshTerminalTitle(): void {
    if (this.shuttingDown && this.renderer.isDestroyed) return
    const active = this.activeAgent()
    this.renderer.setTerminalTitle(active ? `fmx · ${active.label}` : "fmx")
  }
}

type HelpEntry = readonly [key: string, description: string]


function helpEntries(keybindings: Keybindings): HelpEntry[] {
  return [
    [keybindings.prefixLabel, "prefix mode"],
    [bindingLabel(keybindings.help), "keybinds"],
    [bindingLabel(keybindings.detach), "detach client"],
    [bindingLabel(keybindings.previous_tab), "prev agent"],
    [bindingLabel(keybindings.next_tab), "next agent"],
    [bindingLabel(keybindings.toggle_tray), "toggle tray"],
  ]
}

function helpPlainText(keybindings: Keybindings): string {
  const entries = helpEntries(keybindings)
  const keyColumn = helpKeyColumn(entries)
  return entries.map(([key, description]) => ` ${key.padEnd(keyColumn)}${description}`).join("\n")
}

/** Keys are labels — bold, one step down the ramp; what they do is the text. */
function styledHelpContent(keybindings: Keybindings, ramp: Ramp): StyledText {
  const entries = helpEntries(keybindings)
  const keyColumn = helpKeyColumn(entries)
  const chunks: TextChunk[] = []
  for (const [index, [key, description]] of entries.entries()) {
    chunks.push(fg(ramp.foreground)(index === 0 ? " " : "\n "))
    chunks.push(bold(fg(ramp.secondary)(key.padEnd(keyColumn))))
    chunks.push(fg(ramp.foreground)(description))
  }
  return new StyledText(chunks)
}

/** The border already says failure; the heading is fx's red role, which is
 * a gray one step below primary, set bold. */
function styledSpawnErrorContent(heading: string, lines: string[], ramp: Ramp): StyledText {
  const chunks: TextChunk[] = [bold(fg(ramp.accent)(` ${heading}`)), fg(ramp.foreground)("\n\n ")]
  chunks.push(fg(ramp.foreground)(lines.join("\n ")))
  return new StyledText(chunks)
}

function helpKeyColumn(entries: HelpEntry[]): number {
  return Math.max(...entries.map(([key]) => key.length)) + 2
}

function emptyStateContent(): string {
  return "no agents"
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

async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  visit: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      await visit(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, () => worker()))
}

function subagentInfos(entries: SubagentEntry[]): SubagentInfo[] {
  return entries.map((entry) => ({
    session_id: entry.sessionId,
    label: entry.label,
    state: entry.state,
    attention: entry.attention,
    children: subagentInfos(entry.children),
  }))
}

function catalogInfo(): CatalogInfo {
  return {
    default: { model: DEFAULT_CODEX_MODEL.id, effort: DEFAULT_CODEX_MODEL.defaultEffort },
    models: CODEX_MODELS.map((model) => ({
      id: model.id,
      efforts: [...model.efforts],
      default_effort: model.defaultEffort,
    })),
  }
}

function waitStates(raw: string[] | undefined): readonly DisplayState[] {
  if (!raw || raw.length === 0) return WAIT_DEFAULT_STATES
  for (const state of raw) {
    if (!DISPLAY_STATES.includes(state)) {
      throw new ControlFailure("invalid_params", `unknown state: ${state}`, { states: DISPLAY_STATES })
    }
  }
  return raw as DisplayState[]
}

/** A launch that failed before Fx ran, reported to the CLI caller. */
class WorktreeError extends ControlFailure {
  constructor(message: string) {
    super("failed", message)
    this.name = "WorktreeError"
  }
}

/** An agent runs in a repository or it does not run. */
class NotARepositoryError extends ControlFailure {
  constructor(directory: string) {
    super("invalid_params", `${directory} is not a git repository`)
    this.name = "NotARepositoryError"
  }
}
