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
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename } from "node:path"
import { AgentRegistry, type DisplayState, displayStateFor, shortSessionId } from "./agent-registry.ts"
import type { AgentSocket } from "./agent-socket.ts"
import { VERSION } from "./cli.ts"
import { CODEX_MODELS, codexEffort, codexModel, DEFAULT_CODEX_MODEL } from "./codex-catalog.ts"
import { DEFAULT_WORKTREE_ROOT, defaultSlugSettings, type SlugSettings } from "./config.ts"
import {
  ControlFailure,
  type ControlMethod,
  type DraftInfo,
  type InstanceInfo,
  type CatalogInfo,
  type KeysInfo,
  type LaunchChoices,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringList,
  parseTarget,
  requiredString,
  isRecord,
  type SidebarRow,
  type Snapshot,
  type SubagentInfo,
  type Surface,
  type Target,
} from "./control-protocol.ts"
import type { ControlSurface } from "./control-socket.ts"
import { CursorReportAdapter } from "./cursor-report-adapter.ts"
import { DebugPanel, debugPanelWidth } from "./debug-panel.ts"
import { createFxEnvironment, type FxAgentSocketBinding, type FxLaunchLevel } from "./fx-environment.ts"
import type { InstanceManifest, ManifestEntry } from "./instance-manifest.ts"
import {
  InstanceEndedError,
  type InstanceExit,
  type InstanceTransport,
  type InstanceTransportFactory,
  stringEnvironment,
  type TerminalSize,
} from "./instance-transport.ts"
import { FxTerminalRenderable } from "./fx-terminal.ts"
import { LaunchDialog, type LaunchDialogOutcome, type LaunchPrefill, type LaunchRequest } from "./launch-dialog.ts"
import { type KnownPrompt, SlugNamer } from "./slug-namer.ts"
import {
  detectedTerminalColor,
  hasDetectedBackground,
  MODAL_FALLBACK_COLORS,
  type ModalColors,
  modalColors,
  mixHexColors,
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
import { readGitContext, projectNameFor, type GitContext } from "./git-context.ts"
import { expandTilde, orderProjects, type ProjectChoice, scanProjectRoots } from "./projects.ts"
import { SessionList, stateIcon } from "./session-list.ts"
import { buildTree, type SessionEntry } from "./session-tree.ts"
import type { SocketFrame } from "./socket-frames.ts"
import { type SubagentEntry, SubagentObserver } from "./subagents.ts"
import { bracketedPaste } from "./prompt-editor.ts"
import { OscTitleParser, sanitizeTitle } from "./title-parser.ts"
import { createWorktree, planWorktree, readHeadCommit, readWorktreeContext } from "./worktree.ts"

/** The sidebar the embedded terminal sits beside; exported so tests can
 * address the terminal by its real screen column rather than a guess. */
export const SIDEBAR_DEFAULT_WIDTH = 26
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

const HELP_MODAL_TITLE = " keys "
const ERROR_MODAL_TITLE = " error "

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
/** How many times, and how far apart, a lost transport is reached for before the Instance is let go of. */
const RECOVERY_ATTEMPTS = 3
const RECOVERY_INTERVAL_MS = 250
const EMPTY_STATE_CONTENT = "prefix+c to create agent\nprefix+l to prompt agent"
const EXIT_CONFIRMATION_CONTENT = "press ctrl+c again to exit"
export const EXIT_CONFIRMATION_TIMEOUT_MS = 2_000
const MAX_SCROLLBACK_BYTES = 10_000_000

type MultiplexerOptions = {
  fxPath: string
  cwd: string
  keybindings: Keybindings
  /** The Home's record of its Instances; every start and end is written through it. */
  manifest: InstanceManifest
  /** Where Instances are started and reached. */
  transport: InstanceTransportFactory
  /** Instances the join found running: attached, in display order, before anything else. */
  survivors?: readonly ManifestEntry[]
  agentSocket?: AgentSocket | null
  debugPanel?: boolean
  initialSidebarWidth?: number
  onSidebarWidthChange?: (width: number) => void
  initialSidebarHidden?: boolean
  onSidebarHiddenChange?: (hidden: boolean) => void
  /** Directories the launch dialog scans one level deep for projects. */
  projectRoots?: string[]
  /** Where a launch's new worktree is checked out. */
  worktreeRoot?: string
  home?: string
  /** Instances started per directory so far, which orders the picker. */
  initialProjectLaunches?: Record<string, number>
  onProjectLaunch?: (launches: Record<string, number>) => void
  /** How instances earn a name from their first prompt. */
  slug?: SlugSettings
  /** Where `fmx control <command>` reaches this fmx; handed to every instance. */
  controlSocketPath?: string
}

/** Default states `instance wait` waits for: any that needs someone. */
const WAIT_DEFAULT_STATES: readonly DisplayState[] = ["idle", "done", "blocked"]
const DISPLAY_STATES: readonly string[] = ["blocked", "working", "done", "idle", "unknown"]
/** How many resolved drafts stay readable after they close. */
const DRAFT_HISTORY = 32

type Draft = {
  info: DraftInfo
  waiters: Set<(info: DraftInfo) => void>
}

type InstanceWaiter = {
  instanceId: number
  states: readonly DisplayState[]
  settle: (state: DisplayState | null) => void
}

type InstanceStatus = "starting" | "running" | "exited"
type ModalKind = "help" | "spawn-error"

type InstanceEvents = {
  onTitleChange: (instance: FxInstance) => void
  onExit: (instance: FxInstance, exit: InstanceExit) => void
  /** The transport went away under a running fx; nothing is known until asked. */
  onLost: (instance: FxInstance, error: Error) => void
}

/** RIS. Everything — screen, scrollback, modes — so a restore lands on nothing. */
const TERMINAL_RESET = new Uint8Array([0x1b, 0x63])

/**
 * One Instance as fmx shows it: the visible terminal, what fx has said its
 * title is, and the prompt it was launched with. The process and its PTY
 * are the transport's; this owns only the rendering side and the bytes
 * between the two.
 */
class FxInstance {
  readonly terminal: FxTerminalRenderable
  /** The number fmx's UI knows it by: the Manifest's display id. */
  readonly id: number
  /** What fx addresses its frames to; the identity's, so it survives fmx. */
  readonly paneId: string
  private readonly fallbackLabel: string
  label: string
  status: InstanceStatus = "starting"

  private transport: InstanceTransport | null = null
  private detached = false
  /** The terminal's size as last laid out, for a transport attached later. */
  private size: TerminalSize = { cols: 80, rows: 24 }
  /** The prompt this instance was launched with, kept past the typing so
   * naming can use it without waiting for fx to write it down. */
  launchPrompt: string | null = null
  /** A launch prompt waiting for fx to be ready to be typed into. */
  private pendingPrompt: string | null = null
  /** A prompt has gone in and fx has not yet said it is working on it. */
  awaitingWork = false
  private promptTimer: ReturnType<typeof setTimeout> | null = null
  private cursorReportAdapter = new CursorReportAdapter()
  private readonly titleParser: OscTitleParser

  constructor(
    renderer: CliRenderer,
    readonly entry: ManifestEntry,
    readonly cwd: string,
    private hostPalette: TerminalColors | null,
    private readonly events: InstanceEvents,
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
    if (hostPalette) this.terminal.applyHostPalette(hostPalette)
  }

  /** fx takes no prompt on its command line, so a launch prompt is typed in
   * once fx is running — see `armPrompt`. */
  setPendingPrompt(prompt: string): void {
    if (prompt === "") return
    this.pendingPrompt = prompt
    this.launchPrompt = prompt
    this.awaitingWork = true
  }

  /** Whether a launch prompt is still waiting for fx to be ready. */
  get promptPending(): boolean {
    return this.pendingPrompt !== null
  }

  /** Paste `text` into a running fx and send it, the way a launch prompt
   * goes in — the two writes a beat apart, for the same reason. */
  send(text: string): void {
    if (this.status !== "running") throw new ControlFailure("busy", "the instance is not running")
    if (this.pendingPrompt !== null || this.promptTimer !== null) {
      throw new ControlFailure("busy", "the launch prompt has not been sent yet")
    }
    this.awaitingWork = true
    const encoder = new TextEncoder()
    this.writeInput(encoder.encode(bracketedPaste(text)), "input")
    this.promptTimer = setTimeout(() => {
      this.promptTimer = null
      if (this.status === "running") this.writeInput(encoder.encode("\r"), "input")
    }, PROMPT_SUBMIT_MS)
  }

  /**
   * Type the launch prompt and send it. The pane's first report over the agent
   * socket is fx saying it is up, but its input is drawn a beat later, so the
   * text goes in after a short settle rather than the instant fx speaks.
   */
  armPrompt(): void {
    if (this.pendingPrompt === null || this.promptTimer !== null) return
    this.promptTimer = setTimeout(() => {
      this.promptTimer = null
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
  adopt(transport: InstanceTransport): void {
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
    if (this.status === "starting") this.status = "running"
  }

  /** Whether a transport is carrying this instance right now. */
  get connected(): boolean {
    return this.transport !== null
  }

  updateHostPalette(colors: TerminalColors, themeMode: ThemeMode | null): void {
    this.hostPalette = colors
    if (!this.terminal.applyHostPalette(colors)) return
    if (themeMode && hasDetectedBackground(colors)) this.writeInput(themeModeReport(themeMode), "response")
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
   * query half-translated when the last transport dropped. The host palette
   * goes back on afterwards — the replay restores what fx set, and the
   * host's colors were never fx's.
   */
  private resetTerminal(): void {
    this.cursorReportAdapter = new CursorReportAdapter()
    this.terminal.write(TERMINAL_RESET)
    if (this.hostPalette) this.terminal.applyHostPalette(this.hostPalette)
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

  private recordExit(status: InstanceExit): void {
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
  private readonly sidebar: BoxRenderable
  private readonly divider: BoxRenderable
  private readonly content: BoxRenderable
  private readonly emptyState: TextRenderable
  private readonly debugDivider: BoxRenderable | null = null
  private readonly debugPanel: DebugPanel | null = null
  private readonly agentSocket: AgentSocket | null
  private readonly registry = new AgentRegistry()
  private readonly sessionList: SessionList
  private readonly subagents: SubagentObserver
  private readonly seenSeq = new Map<number, number>()
  /** Per-directory git context, read once and reused by every instance there. */
  private readonly gitContexts = new Map<string, GitContext | null>()
  private sidebarWidth = SIDEBAR_DEFAULT_WIDTH
  /** Hidden by the toggle key; orthogonal to the empty state, which hides the
   * sidebar because there is nothing to list. */
  private sidebarHidden = false
  private dividerDragging = false
  private dragStartWidth = SIDEBAR_DEFAULT_WIDTH
  private readonly launchDialog: LaunchDialog
  private readonly projectLaunches: Map<string, number>
  private readonly modalBackdrop: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly keybindings: Keybindings
  private readonly instances: FxInstance[] = []
  private activeIndex = -1
  private prefixArmed = false
  private modalKind: ModalKind | null = null
  private spawnErrorLines: string[] = []
  private spawnErrorHeading = "fx did not start"
  private hostPalette: TerminalColors | null = null
  private shuttingDown = false
  private exitConfirmationTimer: ReturnType<typeof setTimeout> | null = null
  private readonly swallowedReleases = new Set<string>()
  private readonly slugNamer: SlugNamer
  /** Every launch dialog opening, by id, the open one included. */
  private readonly drafts = new Map<string, Draft>()
  private openDraft: Draft | null = null
  /** Handed from the dialog's close to the launch that follows it. */
  private submittedDraft: Draft | null = null
  private nextDraftId = 1
  private readonly instanceWaiters = new Set<InstanceWaiter>()
  /** What `fmx control <command>` drives. */
  readonly control: ControlSurface = {
    handle: (method, params, signal) => this.handleControl(method, params, signal),
  }
  private readonly donePromise: Promise<void>
  private resolveDone!: () => void
  private readonly keypressHandler = (key: KeyEvent) => this.onKeyPress(key)
  private readonly keyreleaseHandler = (key: KeyEvent) => this.onKeyRelease(key)
  private readonly selectionHandler = (selection: Selection) => this.onSelection(selection)
  private readonly paletteHandler = (colors: TerminalColors) => this.onPalette(colors)
  private readonly pasteHandler = () => this.launchDialog.handlePaste()
  private readonly resizeHandler = () => this.applyLayout()
  private readonly frameHandler = (frame: SocketFrame) => this.debugPanel?.append(frame)
  private readonly registryHandler = (frame: SocketFrame) => {
    this.registry.apply(frame)
    // A session id is the first thing fx reports that naming can act on, and
    // every later frame is a chance to notice one that arrived while an
    // attempt was cooling down.
    if (frame.paneId) {
      const sessionId = this.registry.get(frame.paneId)?.sessionId
      if (sessionId) this.slugNamer.note(sessionId, this.launchPromptFor(frame.paneId))
      // fx reporting itself is the only signal fmx has that it is ready to be
      // typed into.
      const instance = this.instanceForPane(frame.paneId)
      instance?.armPrompt()
      // The session id is what a restart seeds the name from; written the
      // moment fx first says it, and never again for the same one.
      if (instance && sessionId) {
        void this.options.manifest.setFxSessionId(instance.entry.instanceId, sessionId).catch(() => {})
      }
      if (instance && this.registry.get(frame.paneId)?.state === "working") instance.awaitingWork = false
    }
    // A pane the human is already watching is seen the moment it reports, so
    // finishing in the foreground never shows as an unacknowledged `done`.
    const active = this.activeInstance()
    if (active) this.markSeen(active)
    this.refreshSessionList()
    this.settleInstanceWaiters()
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: MultiplexerOptions,
  ) {
    this.donePromise = new Promise((resolveDone) => {
      this.resolveDone = resolveDone
    })
    this.keybindings = options.keybindings
    this.sidebarWidth = options.initialSidebarWidth ?? SIDEBAR_DEFAULT_WIDTH
    this.sidebarHidden = options.initialSidebarHidden ?? false
    this.slugNamer = new SlugNamer({
      fxPath: options.fxPath,
      settings: options.slug ?? defaultSlugSettings(),
      home: options.home,
      onSlug: () => this.refreshSessionList(),
    })
    this.subagents = new SubagentObserver({
      home: options.home,
      onChange: () => this.refreshSessionList(),
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
    this.sidebar = new BoxRenderable(renderer, {
      id: "fmx-sidebar",
      width: this.sidebarWidth,
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
      borderColor: DIVIDER_UNREVEALED_COLOR,
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
      content: EMPTY_STATE_CONTENT,
      fg: MODAL_FALLBACK_COLORS.dim,
      selectable: false,
    })
    this.content.add(this.emptyState)
    this.stage.add(this.sidebar)
    this.stage.add(this.divider)
    this.stage.add(this.content)

    this.agentSocket = options.agentSocket ?? null
    this.sessionList = new SessionList(renderer, (instanceId) => this.selectInstance(instanceId))
    this.sidebar.add(this.sessionList.root)
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
      title: HELP_MODAL_TITLE,
      titleAlignment: "left",
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

    this.projectLaunches = new Map(Object.entries(options.initialProjectLaunches ?? {}))
    this.launchDialog = new LaunchDialog(renderer, {
      onLaunch: (request) => void this.startLaunch(request),
      onClose: (outcome) => {
        if (!this.shuttingDown) this.activeInstance()?.terminal.focus()
        this.closeDraft(outcome)
      },
      onProjectChange: (directory) => this.answerWorktreeAvailability(directory),
    })

    this.renderer.root.add(this.stage)
    this.renderer.root.add(this.modalBackdrop)
    this.renderer.root.add(this.launchDialog.root)
    this.renderer.keyInput.on("keypress", this.keypressHandler)
    this.renderer.keyInput.on("keyrelease", this.keyreleaseHandler)
    this.renderer.keyInput.on("paste", this.pasteHandler)
    this.renderer.on(CliRenderEvents.SELECTION, this.selectionHandler)
    this.renderer.on(CliRenderEvents.PALETTE, this.paletteHandler)
    this.renderer.on(CliRenderEvents.RESIZE, this.resizeHandler)
    if (this.debugPanel) this.agentSocket?.addFrameListener(this.frameHandler)
    this.agentSocket?.addFrameListener(this.registryHandler)
    this.applyLayout()
    this.refreshTerminalTitle()
  }

  /**
   * Bring up what the join found running before anything new can be asked
   * for, in the order the Instances were numbered. Each attach is its own:
   * one that fails is reported and the rest still come up.
   */
  async start(): Promise<void> {
    this.subagents.start()
    // The host palette query has settled by the time an fx can launch; if it
    // never produced colors, the fallback is the best divider color there will
    // be once an agent makes the sidebar visible.
    if (!this.hostPalette) this.applyDividerPalette(null)
    const survivors = [...(this.options.survivors ?? [])].sort((a, b) => a.displayId - b.displayId)
    for (const entry of survivors) {
      if (this.shuttingDown) return
      await this.restoreInstance(entry)
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
    if (this.exitConfirmationTimer !== null) clearTimeout(this.exitConfirmationTimer)
    this.exitConfirmationTimer = null
    this.launchDialog.close()
    this.hideModal()
    this.slugNamer.stop()
    this.subagents.stop()
    for (const waiter of this.instanceWaiters) waiter.settle(null)
    this.instanceWaiters.clear()

    try {
      // Let go, never end: fx and its terminal are the Companion's, and the
      // next fmx for this Home finds them where this one left them.
      for (const instance of this.instances) instance.detach()
      this.renderer.keyInput.off("keypress", this.keypressHandler)
      this.renderer.keyInput.off("keyrelease", this.keyreleaseHandler)
      this.renderer.keyInput.off("paste", this.pasteHandler)
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

  /**
   * Start an fx. `focus` false leaves the screen where it is — an agent
   * starting workers should not keep taking the human's view — unless nothing
   * is on it yet, when the new instance is the only thing to show.
   *
   * The Manifest is written first and the Companion asked second, so a crash
   * anywhere between leaves a claim the next start's join resolves against
   * what the Companion actually holds. The Instance is on screen from the
   * claim: a start that fails takes it down again with the reason.
   */
  private async createInstance(
    cwd: string = this.options.cwd,
    prompt = "",
    focus = true,
    launchLevel: FxLaunchLevel | null = null,
  ): Promise<FxInstance | null> {
    if (this.shuttingDown) return null
    this.cancelExitConfirmation()
    const { result: entry, saved } = this.options.manifest.claim({
      cwd,
      fxPath: this.options.fxPath,
      fxArgs: [],
      createdAt: Date.now(),
    })
    const instance = this.addInstance(entry, cwd, focus)
    instance.setPendingPrompt(prompt)
    this.countLaunch(cwd)
    try {
      await saved
      if (this.shuttingDown) throw new ControlFailure("shutting_down", "fmx is shutting down")
      const transport = await this.options.transport.start({
        entry,
        // The claim's, not the option's: what the Manifest says was started is what is started.
        command: [entry.fxPath, ...(entry.fxArgs ?? [])],
        cwd,
        env: stringEnvironment(
          createFxEnvironment(
            process.env,
            entry.displayId,
            cwd,
            this.agentSocketBinding(entry.paneId),
            this.options.controlSocketPath ?? null,
            launchLevel,
          ),
        ),
        size: instance.currentSize(),
      })
      // fx is running whatever happened here meanwhile; the record says so
      // before anything else, because this is the acknowledgement a crash
      // loses.
      await this.options.manifest.markRunning(entry.instanceId)
      if (this.shuttingDown || !this.instances.includes(instance)) {
        transport.detach()
        return null
      }
      instance.adopt(transport)
    } catch (error) {
      this.removeInstance(instance)
      await this.options.manifest.remove(entry.instanceId)
      throw error
    }
    return instance
  }

  /**
   * Attach to an Instance the Companion held between runs. What fx last
   * reported is seeded so its name shows; its state is unknown until it
   * reports again, and a launch prompt is not replayed — there is none.
   */
  private async restoreInstance(entry: ManifestEntry): Promise<void> {
    const instance = this.addInstance(entry, entry.cwd, false)
    if (entry.fxSessionId) {
      this.registry.seed(instance.paneId, entry.fxSessionId)
      this.slugNamer.note(entry.fxSessionId, null)
      this.refreshSessionList()
    }
    try {
      const transport = await this.options.transport.attach(entry, instance.currentSize())
      if (this.shuttingDown || !this.instances.includes(instance)) {
        transport.detach()
        return
      }
      instance.adopt(transport)
    } catch (error) {
      this.removeInstance(instance)
      if (error instanceof InstanceEndedError) {
        await this.options.manifest.remove(entry.instanceId)
        return
      }
      // Unreachable is not ended: the claim stays for the next start.
      this.showError(`instance ${entry.displayId} could not be restored`, error)
    }
  }

  /** Put an Instance on screen under its Manifest identity; nothing is attached yet. */
  private addInstance(entry: ManifestEntry, cwd: string, focus: boolean): FxInstance {
    const instance = new FxInstance(this.renderer, entry, cwd, this.hostPalette, {
      onTitleChange: (candidate) => {
        if (this.activeInstance() === candidate) this.refreshTerminalTitle()
      },
      onExit: (candidate) => this.handleInstanceExit(candidate),
      onLost: (candidate, error) => void this.recoverInstance(candidate, error),
    })
    this.instances.push(instance)
    this.content.add(instance.terminal)
    this.refreshInstanceChrome()
    if (focus || this.activeIndex === -1) this.switchTo(this.instances.length - 1)
    this.loadGitContext(cwd)
    this.refreshSessionList()
    return instance
  }

  /** fx ended: the Instance, its claim, and whatever the Companion recorded all go. */
  private handleInstanceExit(instance: FxInstance): void {
    if (this.shuttingDown) return
    this.removeInstance(instance)
    void this.options.manifest.remove(instance.entry.instanceId).catch(() => {})
  }

  /**
   * The transport dropped under a running fx. Reach for it again: a live
   * session is re-attached and replays onto a reset terminal; one that
   * ended is removed exactly as an Exit would have; one that cannot be
   * reached after a few tries is let go of on screen but kept in the
   * Manifest, where the next start's join will find it.
   */
  private async recoverInstance(instance: FxInstance, lost: Error): Promise<void> {
    let error: unknown = lost
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
      if (this.shuttingDown || !this.instances.includes(instance)) return
      try {
        const transport = await this.options.transport.attach(instance.entry, instance.currentSize())
        if (this.shuttingDown || !this.instances.includes(instance)) {
          transport.detach()
          return
        }
        instance.adopt(transport)
        return
      } catch (caught) {
        if (caught instanceof InstanceEndedError) {
          this.handleInstanceExit(instance)
          return
        }
        error = caught
      }
      await new Promise((resolve) => setTimeout(resolve, RECOVERY_INTERVAL_MS))
    }
    if (this.shuttingDown || !this.removeInstance(instance)) return
    this.showError(`lost instance ${instance.id}`, error)
  }

  private removeInstance(instance: FxInstance): boolean {
    const index = this.instances.indexOf(instance)
    if (index === -1) return false
    const wasActive = this.activeInstance() === instance
    this.content.remove(instance.terminal)
    instance.destroy()
    this.instances.splice(index, 1)
    this.registry.forget(this.paneIdFor(instance))
    this.seenSeq.delete(instance.id)
    this.refreshInstanceChrome()
    for (const waiter of this.instanceWaiters) {
      if (waiter.instanceId !== instance.id) continue
      this.instanceWaiters.delete(waiter)
      waiter.settle(null)
    }

    if (this.instances.length === 0) {
      this.activeIndex = -1
      this.refreshTerminalTitle()
      this.refreshSessionList()
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
    // A surface drawn over fx keeps the keys; it hands them back when it
    // closes, so an instance shown behind it must not take them now.
    if (!this.launchDialog.isOpen() && !this.modalKind) active.terminal.focus()
    this.markSeen(active)
    this.refreshTerminalTitle()
    this.refreshSessionList()
  }

  private activeInstance(): FxInstance | null {
    return this.instances[this.activeIndex] ?? null
  }

  private refreshSessionList(): void {
    this.subagents.setParents(
      this.instances.flatMap((instance) => {
        const sessionId = this.registry.get(this.paneIdFor(instance))?.sessionId
        return sessionId ? [sessionId] : []
      }),
    )
    this.sessionList.render(buildTree(this.sessionEntries()), this.sidebarWidth)
  }

  private setSidebarHidden(hidden: boolean): void {
    if (hidden === this.sidebarHidden) return
    this.sidebarHidden = hidden
    this.refreshInstanceChrome()
    this.options.onSidebarHiddenChange?.(this.sidebarHidden)
  }

  private refreshInstanceChrome(): void {
    const hasInstances = this.instances.length > 0
    const showSidebar = hasInstances && !this.sidebarHidden
    this.sidebar.visible = showSidebar
    this.divider.visible = showSidebar
    this.emptyState.visible = !hasInstances
    if (!hasInstances) this.refreshEmptyState()
  }

  private refreshEmptyState(): void {
    const confirmingExit = this.exitConfirmationTimer !== null
    const palette = modalColors(this.hostPalette)
    this.emptyState.content = confirmingExit ? EXIT_CONFIRMATION_CONTENT : EMPTY_STATE_CONTENT
    this.emptyState.fg = confirmingExit ? palette.foreground : palette.dim
  }

  private requestExitConfirmation(): void {
    if (this.exitConfirmationTimer !== null) {
      clearTimeout(this.exitConfirmationTimer)
      this.exitConfirmationTimer = null
      void this.shutdown()
      return
    }

    this.exitConfirmationTimer = setTimeout(() => {
      this.exitConfirmationTimer = null
      if (!this.shuttingDown && this.instances.length === 0) this.refreshEmptyState()
    }, EXIT_CONFIRMATION_TIMEOUT_MS)
    this.refreshEmptyState()
  }

  private cancelExitConfirmation(): void {
    if (this.exitConfirmationTimer !== null) clearTimeout(this.exitConfirmationTimer)
    this.exitConfirmationTimer = null
    this.refreshEmptyState()
  }

  private sessionEntries(): SessionEntry[] {
    return this.instances.map((instance, index) => {
      const record = this.registry.get(this.paneIdFor(instance))
      const git = this.gitContexts.get(instance.cwd) ?? null
      return {
        instanceId: instance.id,
        project: projectNameFor(git, instance.cwd),
        branch: git?.branch ?? null,
        sessionId: shortSessionId(record?.sessionId ?? null),
        slug: record?.sessionId ? this.slugNamer.slugFor(record.sessionId) : null,
        state: displayStateFor(record, this.seenSeq.get(instance.id) ?? 0),
        attention: record?.attention ?? null,
        active: index === this.activeIndex,
        subagents: record?.sessionId ? this.subagents.childrenOf(record.sessionId) : [],
      }
    })
  }

  /**
   * fx never reports where it is working, so fmx reads it from the directory
   * it spawned the instance in. The list renders without a branch rung until
   * the answer arrives, which is why this refreshes rather than blocking.
   */
  private loadGitContext(cwd: string): void {
    if (this.gitContexts.has(cwd)) return
    this.gitContexts.set(cwd, null)
    void readGitContext(cwd).then((context) => {
      if (this.shuttingDown || !context) return
      this.gitContexts.set(cwd, context)
      this.refreshSessionList()
    })
  }

  /**
   * Mark an instance acknowledged: its current state is now one the human has
   * looked at, so a finished turn stops reading as `done`.
   */
  private markSeen(instance: FxInstance): void {
    const record = this.registry.get(this.paneIdFor(instance))
    this.seenSeq.set(instance.id, record?.stateSeq ?? 0)
  }

  private selectInstance(instanceId: number): void {
    const index = this.instances.findIndex((instance) => instance.id === instanceId)
    if (index === -1 || index === this.activeIndex) return
    this.switchTo(index)
  }

  private instanceForPane(paneId: string): FxInstance | null {
    return this.instances.find((instance) => this.paneIdFor(instance) === paneId) ?? null
  }

  private home(): string {
    return this.options.home ?? homedir()
  }

  /** What fmx itself typed into this pane, if anything. */
  private launchPromptFor(paneId: string): KnownPrompt | null {
    const instance = this.instances.find((candidate) => this.paneIdFor(candidate) === paneId)
    if (!instance?.launchPrompt) return null
    return { text: instance.launchPrompt, workspaceRoot: instance.cwd }
  }

  private paneIdFor(instance: FxInstance): string {
    return instance.paneId
  }

  private agentSocketBinding(paneId: string): FxAgentSocketBinding | null {
    const socket = this.agentSocket
    if (!socket) return null
    return { socketPath: socket.path, paneId }
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
    this.launchDialog.layout()
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
    this.refreshSessionList()
  }

  private reservedDebugWidth(): number {
    if (!this.debugPanel) return 0
    return debugPanelWidth(this.renderer.width) + 1
  }

  private onPalette(colors: TerminalColors): void {
    this.hostPalette = colors
    this.applyModalPalette(colors)
    this.applyDividerPalette(colors)
    this.refreshEmptyState()
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
    this.launchDialog.applyPalette(colors)
    this.sessionList.applyPalette(colors)
    this.refreshSessionList()
  }

  private applyModalPalette(colors: TerminalColors | null): void {
    const palette = modalColors(colors)
    const isError = this.modalKind === "spawn-error"
    const borderColor = isError ? palette.error : palette.accent
    this.modalBackdrop.backgroundColor = palette.backdrop
    this.modal.backgroundColor = palette.background
    this.modal.borderColor = borderColor
    this.modal.focusedBorderColor = borderColor
    // Every surface fmx draws over fx names itself in its own border, so what
    // took the screen is legible before any of its content is read.
    this.modal.title = isError ? ERROR_MODAL_TITLE : HELP_MODAL_TITLE
    this.modal.titleColor = palette.key
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

    if (this.launchDialog.isOpen()) {
      if (MODIFIER_ONLY_KEYS.has(key.name.toLowerCase())) {
        this.swallow(key)
        return
      }
      // A key the dialog declines belongs to its focused prompt field, which
      // the renderer feeds through its own dispatch — swallowing it here
      // would stop it ever arriving. fx is blurred, so nothing else can take
      // it either.
      if (this.launchDialog.handleKey(key)) this.swallow(key)
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

    if (this.instances.length === 0 && isCancelKey(key)) {
      this.swallow(key)
      this.cancelPrefix()
      this.requestExitConfirmation()
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
        void this.createInstance().catch((error) => {
          if (!this.shuttingDown) this.showError("fx did not start", error)
        })
        return
      case "launch":
        try {
          this.showLaunchDialog()
        } catch (error) {
          if (!(error instanceof ControlFailure)) throw error
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
      case "toggle_sidebar":
        this.setSidebarHidden(!this.sidebarHidden)
        return
    }
  }

  private cancelPrefix(): void {
    this.prefixArmed = false
  }

  /**
   * The projects on offer, freshly scanned so a directory made a minute ago is
   * already there. fmx's own workspace joins the list unconditionally, which
   * keeps the dialog useful before any root is configured.
   */
  private projectChoices(): ProjectChoice[] {
    const home = this.options.home ?? homedir()
    const scanned = scanProjectRoots(this.options.projectRoots ?? [], home)
    const directories = scanned.includes(this.options.cwd)
      ? scanned
      : [...scanned, this.options.cwd]
    return orderProjects(directories, this.projectLaunches, home)
  }

  private showLaunchDialog(openedBy: "keys" | "agent" = "keys", prefill: LaunchPrefill = {}): Draft {
    if (this.shuttingDown) throw new ControlFailure("shutting_down", "fmx is shutting down")
    if (this.modalKind || this.launchDialog.isOpen()) {
      throw new ControlFailure("busy", "something is already open", { surface: this.surface() })
    }
    const active = this.activeInstance()
    this.launchDialog.applyPalette(this.hostPalette)
    const projects = this.projectChoices()
    if (prefill.directory !== undefined) {
      projects.push(...orderProjects([prefill.directory], this.projectLaunches, this.home()))
    }
    const draft: Draft = {
      info: {
        draft: `d${this.nextDraftId++}`,
        kind: "launch",
        status: "open",
        opened_by: openedBy,
        fields: {
          prompt: "",
          directory: "",
          worktree: false,
          worktree_available: null,
          model: DEFAULT_CODEX_MODEL.id,
          effort: DEFAULT_CODEX_MODEL.defaultEffort,
        },
        outcome: null,
      },
      waiters: new Set(),
    }
    this.drafts.set(draft.info.draft, draft)
    this.openDraft = draft
    this.forgetOldDrafts()
    this.launchDialog.show(projects, prefill.directory ?? active?.cwd ?? this.options.cwd, prefill)
    active?.terminal.blur()
    return draft
  }

  /** The dialog has left the screen. A submitted draft stays open until its
   * launch has answered; a cancelled one is resolved here. */
  private closeDraft(outcome: LaunchDialogOutcome): void {
    const draft = this.openDraft
    if (!draft) return
    draft.info.fields = this.launchDialog.fields()
    this.openDraft = null
    if (outcome === "cancelled") this.resolveDraft(draft, "cancelled", null)
    else this.submittedDraft = draft
  }

  private resolveDraft(draft: Draft, status: DraftInfo["status"], outcome: DraftInfo["outcome"]): void {
    draft.info.status = status
    draft.info.outcome = outcome
    for (const waiter of draft.waiters) waiter(draft.info)
    draft.waiters.clear()
  }

  private forgetOldDrafts(): void {
    for (const [id, draft] of this.drafts) {
      if (this.drafts.size <= DRAFT_HISTORY) return
      if (draft.info.status === "open") continue
      this.drafts.delete(id)
    }
  }

  /** The dialog's path: what goes wrong is shown, since there is no caller
   * to answer. */
  private async startLaunch(request: LaunchRequest): Promise<void> {
    const draft = this.submittedDraft
    this.submittedDraft = null
    try {
      const instance = await this.performLaunch(request, true)
      if (draft) this.resolveDraft(draft, "submitted", { instance: instance.id })
    } catch (error) {
      if (draft) this.resolveDraft(draft, "failed", { error: errorMessage(error) })
      if (error instanceof ControlFailure && error.code === "shutting_down") return
      this.showError(launchErrorHeading(error), error)
    }
  }

  /** Cut the worktree if asked, then start fx; throws with the reason. */
  private async performLaunch(request: LaunchRequest, focus: boolean): Promise<FxInstance> {
    let directory = request.directory
    if (request.worktree) {
      try {
        directory = await this.cutWorktree(request.directory)
      } catch (error) {
        throw new WorktreeError(errorMessage(error))
      }
    }
    if (this.shuttingDown) throw new ControlFailure("shutting_down", "fmx is shutting down")
    const instance = await this.createInstance(directory, request.prompt, focus, {
      model: request.model,
      effort: request.effort,
    })
    if (!instance) throw new ControlFailure("shutting_down", "fmx is shutting down")
    return instance
  }

  /** Branch from what the launch was looking at and check it out under the
   * worktree root, returning where the instance should start. */
  private async cutWorktree(directory: string): Promise<string> {
    const context = await readWorktreeContext(directory)
    if (!context) throw new Error(`${directory} is not a git repository`)
    const base = await readHeadCommit(directory)
    const root = expandTilde(this.options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT, this.home())
    const plan = planWorktree(context, root)
    await createWorktree(context, plan, base)
    return plan.checkout
  }

  /** Whether a worktree can be cut in `directory`, answered from the git
   * contexts the session list already keeps. */
  private answerWorktreeAvailability(directory: string): void {
    const known = this.gitContexts.get(directory)
    if (known) {
      this.launchDialog.setWorktreeAvailability(directory, true)
      return
    }
    void readGitContext(directory).then((context) => {
      if (this.shuttingDown) return
      if (context) this.gitContexts.set(directory, context)
      this.launchDialog.setWorktreeAvailability(directory, context !== null)
    })
  }

  /** Every start counts, whichever key opened it, so the picker's order
   * reflects where work actually happens. */
  private countLaunch(cwd: string): void {
    this.projectLaunches.set(cwd, (this.projectLaunches.get(cwd) ?? 0) + 1)
    this.options.onProjectLaunch?.(Object.fromEntries(this.projectLaunches))
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
      case "instance.list":
        return { instances: this.instances.map((instance) => this.instanceInfo(instance)) }
      case "instance.wait":
        return this.waitForInstance(
          this.resolveTarget(parseTarget(optionalString(params, "target") ?? "current"), caller),
          waitStates(optionalStringList(params, "states")),
          optionalInteger(params, "timeout_ms") ?? null,
          signal,
        )
      case "instance.send": {
        const instance = this.resolveTarget(parseTarget(requiredString(params, "target")), caller)
        const text = requiredString(params, "text").trim()
        if (text === "") throw new ControlFailure("invalid_params", "text is empty")
        instance.send(text)
        return { instance: this.instanceInfo(instance) }
      }
      case "launch": {
        const request = this.launchRequestFrom(params, caller)
        const focus = optionalBoolean(params, "focus") ?? false
        if (focus) this.refuseIfBusy()
        const instance = await this.performLaunch(request, focus)
        return { instance: this.instanceInfo(instance) }
      }
      case "focus": {
        const instance = this.resolveTarget(parseTarget(requiredString(params, "target")), caller)
        this.refuseIfBusy()
        this.selectInstance(instance.id)
        return { instance: this.instanceInfo(instance) }
      }
      case "draft.open": {
        const kind = optionalString(params, "kind") ?? "launch"
        if (kind !== "launch") throw new ControlFailure("invalid_params", `unknown draft kind: ${kind}`)
        const fields = isRecord(params.fields) ? params.fields : {}
        const draft = this.showLaunchDialog("agent", this.prefillFrom(fields))
        return this.draftInfo(draft)
      }
      case "draft.show":
        return this.draftInfo(this.draftFor(optionalString(params, "draft")))
      case "draft.set": {
        const draft = this.openDraftFor(requiredString(params, "draft"))
        const fields = isRecord(params.fields) ? params.fields : {}
        const prefill = this.prefillFrom(fields, this.launchDialog.fields().model)
        if (prefill.directory !== undefined) {
          const [choice] = orderProjects([prefill.directory], this.projectLaunches, this.home())
          if (choice) this.launchDialog.offerProject(choice)
        }
        this.launchDialog.apply(prefill)
        return this.draftInfo(draft)
      }
      case "draft.submit": {
        const draft = this.openDraftFor(requiredString(params, "draft"))
        const resolved = this.waitForDraft(draft, null, signal)
        this.launchDialog.submit()
        const info = await resolved
        if (info.status === "failed") {
          throw new ControlFailure("failed", info.outcome && "error" in info.outcome ? info.outcome.error : "launch failed")
        }
        return info
      }
      case "draft.cancel": {
        const draft = this.openDraftFor(requiredString(params, "draft"))
        this.launchDialog.close()
        return this.draftInfo(draft)
      }
      case "draft.wait":
        return this.waitForDraft(
          this.draftFor(optionalString(params, "draft")),
          optionalInteger(params, "timeout_ms") ?? null,
          signal,
        )
      case "catalog":
        return catalogInfo()
      case "sidebar": {
        const width = optionalInteger(params, "width")
        if (width !== undefined) {
          if (width < 1) throw new ControlFailure("invalid_params", "width must be at least 1")
          this.applySidebarWidth(width)
          this.options.onSidebarWidthChange?.(this.sidebarWidth)
        }
        const hidden = optionalBoolean(params, "hidden")
        if (hidden !== undefined) this.setSidebarHidden(hidden)
        else if (optionalBoolean(params, "toggle")) this.setSidebarHidden(!this.sidebarHidden)
        return this.sidebarInfo()
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
    if (this.modalKind || this.launchDialog.isOpen()) {
      throw new ControlFailure("busy", "something is already open", { surface: this.surface() })
    }
  }

  private resolveTarget(target: Target, caller: number | null): FxInstance {
    switch (target.kind) {
      case "id":
        return this.instanceById(target.id)
      case "current":
        if (caller === null) {
          throw new ControlFailure("invalid_params", "current needs a caller inside an instance (FMX_INSTANCE_ID)")
        }
        return this.instanceById(caller)
      case "active": {
        const active = this.activeInstance()
        if (!active) throw new ControlFailure("not_found", "no instance is active")
        return active
      }
      case "next":
      case "previous": {
        if (this.instances.length === 0) throw new ControlFailure("not_found", "no instances")
        const count = this.instances.length
        const step = target.kind === "next" ? 1 : -1
        return this.instances[(((this.activeIndex + step) % count) + count) % count]!
      }
      case "name": {
        const bySlug = this.instances.filter((instance) => this.slugOf(instance) === target.name)
        if (bySlug.length === 1) return bySlug[0]!
        const bySession = this.instances.filter((instance) =>
          this.registry.get(this.paneIdFor(instance))?.sessionId?.startsWith(target.name),
        )
        if (bySession.length === 1) return bySession[0]!
        if (bySession.length > 1 || bySlug.length > 1) {
          throw new ControlFailure("ambiguous", `${target.name} names more than one instance`, {
            instances: [...bySlug, ...bySession].map((instance) => instance.id),
          })
        }
        throw new ControlFailure("not_found", `no instance named ${target.name}`)
      }
    }
  }

  private instanceById(id: number): FxInstance {
    const instance = this.instances.find((candidate) => candidate.id === id)
    if (!instance) throw new ControlFailure("not_found", `no instance ${id}`)
    return instance
  }

  private launchRequestFrom(params: Record<string, unknown>, caller: number | null): LaunchRequest {
    const prefill = this.prefillFrom(params)
    const callerInstance = caller === null ? null : (this.instances.find((instance) => instance.id === caller) ?? null)
    return {
      directory: prefill.directory ?? callerInstance?.cwd ?? this.options.cwd,
      prompt: prefill.prompt ?? "",
      worktree: prefill.worktree ?? false,
      model: prefill.model ?? DEFAULT_CODEX_MODEL.id,
      effort: prefill.effort ?? DEFAULT_CODEX_MODEL.defaultEffort,
    }
  }

  /** Fields an agent gave, checked; a directory must exist to be offered. */
  private prefillFrom(fields: Record<string, unknown>, currentModel = DEFAULT_CODEX_MODEL.id): LaunchPrefill {
    const prefill: LaunchPrefill = {}
    const directory = optionalString(fields, "directory")
    if (directory !== undefined) {
      let resolved: string
      try {
        resolved = realpathSync(expandTilde(directory, this.home()))
        if (!statSync(resolved).isDirectory()) throw new Error("not a directory")
      } catch {
        throw new ControlFailure("invalid_params", `${directory} is not a directory`)
      }
      prefill.directory = resolved
    }
    const prompt = optionalString(fields, "prompt")
    if (prompt !== undefined) prefill.prompt = prompt
    const worktree = optionalBoolean(fields, "worktree")
    if (worktree !== undefined) prefill.worktree = worktree
    const modelId = optionalString(fields, "model")
    const model = codexModel(modelId ?? currentModel)
    if (!model) throw new ControlFailure("invalid_params", `unknown Codex model: ${modelId ?? currentModel}`)
    if (modelId !== undefined) prefill.model = modelId
    const effort = optionalString(fields, "effort")
    if (effort !== undefined) {
      if (!codexEffort(model, effort)) {
        throw new ControlFailure("invalid_params", `${model.id} does not support effort ${effort}`, {
          model: model.id,
          efforts: model.efforts,
        })
      }
      prefill.effort = effort
    }
    return prefill
  }

  private draftFor(id: string | undefined): Draft {
    if (id === undefined) {
      if (!this.openDraft) throw new ControlFailure("not_found", "no draft is open")
      return this.openDraft
    }
    const draft = this.drafts.get(id)
    if (!draft) throw new ControlFailure("not_found", `no draft ${id}`)
    return draft
  }

  /** A draft a command may change: the one on screen, named by its own id. */
  private openDraftFor(id: string): Draft {
    const draft = this.draftFor(id)
    if (draft !== this.openDraft || !this.launchDialog.isOpen()) {
      throw new ControlFailure("busy", `draft ${id} is ${draft.info.status}`, { draft: this.draftInfo(draft) })
    }
    return draft
  }

  private draftInfo(draft: Draft): DraftInfo {
    if (draft === this.openDraft && this.launchDialog.isOpen()) draft.info.fields = this.launchDialog.fields()
    return { ...draft.info, fields: { ...draft.info.fields }, choices: launchChoices(draft.info.fields.model) }
  }

  private waitForDraft(draft: Draft, timeoutMs: number | null, signal: AbortSignal): Promise<DraftInfo> {
    if (draft.info.status !== "open") return Promise.resolve(this.draftInfo(draft))
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const waiter = (info: DraftInfo) => {
        cleanup()
        resolve({ ...info, fields: { ...info.fields } })
      }
      const cleanup = () => {
        draft.waiters.delete(waiter)
        if (timer) clearTimeout(timer)
        signal.removeEventListener("abort", cleanup)
      }
      draft.waiters.add(waiter)
      signal.addEventListener("abort", cleanup)
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          cleanup()
          reject(new ControlFailure("timeout", `draft ${draft.info.draft} is still open after ${timeoutMs}ms`))
        }, timeoutMs)
      }
    })
  }

  private waitForInstance(
    instance: FxInstance,
    states: readonly DisplayState[],
    timeoutMs: number | null,
    signal: AbortSignal,
  ): Promise<{ instance: InstanceInfo; state: DisplayState }> {
    const settled = this.waitedState(instance, states)
    if (settled) return Promise.resolve({ instance: this.instanceInfo(instance), state: settled })
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const waiter: InstanceWaiter = {
        instanceId: instance.id,
        states,
        settle: (state) => {
          cleanup()
          if (state === null) reject(new ControlFailure("not_found", `instance ${instance.id} exited`))
          else resolve({ instance: this.instanceInfo(instance), state })
        },
      }
      const cleanup = () => {
        this.instanceWaiters.delete(waiter)
        if (timer) clearTimeout(timer)
        signal.removeEventListener("abort", cleanup)
      }
      this.instanceWaiters.add(waiter)
      signal.addEventListener("abort", cleanup)
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          cleanup()
          reject(
            new ControlFailure("timeout", `instance ${instance.id} is ${this.displayStateOf(instance)} after ${timeoutMs}ms`),
          )
        }, timeoutMs)
      }
    })
  }

  /** The state a wait resolves on, or null while it should keep waiting. A
   * prompt that has gone in but not yet been picked up holds the wait: the
   * idle fx reports at startup is not the idle that means it has finished. */
  private waitedState(instance: FxInstance, states: readonly DisplayState[]): DisplayState | null {
    if (instance.awaitingWork) return null
    const state = this.displayStateOf(instance)
    return states.includes(state) ? state : null
  }

  private settleInstanceWaiters(): void {
    for (const waiter of this.instanceWaiters) {
      const instance = this.instances.find((candidate) => candidate.id === waiter.instanceId)
      if (!instance) {
        waiter.settle(null)
        continue
      }
      const state = this.waitedState(instance, waiter.states)
      if (state) waiter.settle(state)
    }
  }

  private displayStateOf(instance: FxInstance): DisplayState {
    return displayStateFor(this.registry.get(this.paneIdFor(instance)), this.seenSeq.get(instance.id) ?? 0)
  }

  private slugOf(instance: FxInstance): string | null {
    const sessionId = this.registry.get(this.paneIdFor(instance))?.sessionId
    return sessionId ? this.slugNamer.slugFor(sessionId) : null
  }

  private instanceInfo(instance: FxInstance): InstanceInfo {
    const record = this.registry.get(this.paneIdFor(instance))
    const git = this.gitContexts.get(instance.cwd) ?? null
    return {
      id: instance.id,
      pane_id: this.paneIdFor(instance),
      cwd: instance.cwd,
      project: projectNameFor(git, instance.cwd),
      branch: git?.branch ?? null,
      worktree: git ? git.root !== git.mainRoot : null,
      slug: this.slugOf(instance),
      session_id: record?.sessionId ?? null,
      label: instance.label,
      state: this.displayStateOf(instance),
      attention: record?.attention ?? null,
      active: this.activeInstance() === instance,
      awaiting_work: instance.awaitingWork,
      subagents: record?.sessionId ? subagentInfos(this.subagents.childrenOf(record.sessionId)) : [],
    }
  }

  private surface(): Surface {
    if (this.launchDialog.isOpen() && this.openDraft) return { kind: "launch", draft: this.draftInfo(this.openDraft) }
    if (this.modalKind === "help") return { kind: "help" }
    if (this.modalKind === "spawn-error") {
      return { kind: "error", heading: this.spawnErrorHeading, message: this.spawnErrorLines.join("") }
    }
    return { kind: "none" }
  }

  private snapshot(caller: number | null): Snapshot {
    const you = caller === null ? null : (this.instances.find((instance) => instance.id === caller) ?? null)
    const rows: SidebarRow[] = buildTree(this.sessionEntries()).map((row) => ({
      kind: row.kind,
      depth: row.depth,
      text:
        row.kind === "agent" || row.kind === "subagent"
          ? `${stateIcon(row.state, row.attention)} ${row.label || "—"}`
          : row.label,
      instance: row.instanceId,
      active: row.active,
    }))
    return {
      fmx: {
        pid: process.pid,
        version: VERSION,
        cwd: this.options.cwd,
        socket: this.options.controlSocketPath ?? "",
        cols: this.renderer.width,
        rows: this.renderer.height,
      },
      you: you ? this.instanceInfo(you) : null,
      active: this.activeInstance()?.id ?? null,
      instances: this.instances.map((instance) => this.instanceInfo(instance)),
      sidebar: { ...this.sidebarInfo(), rows },
      surface: this.surface(),
    }
  }

  /** `visible` is what is drawn; `hidden` is the human's choice, which an
   * empty fmx keeps without showing. */
  private sidebarInfo(): { visible: boolean; hidden: boolean; width: number } {
    return { visible: this.sidebar.visible, hidden: this.sidebarHidden, width: this.sidebarWidth }
  }

  private keysInfo(): KeysInfo {
    const commands: Record<string, string> = {
      help: "fmx control keys --show",
      new_tab: "fmx control launch",
      launch: "fmx control launch --editable",
      previous_tab: "fmx control focus previous",
      next_tab: "fmx control focus next",
      toggle_sidebar: "fmx control sidebar --toggle",
    }
    const bindings: KeysInfo["bindings"] = {}
    for (const action of ["help", "new_tab", "launch", "previous_tab", "next_tab", "toggle_sidebar"] as const) {
      bindings[action] = {
        keys: this.keybindings[action].map((binding) => binding.label),
        command: commands[action]!,
      }
    }
    return { prefix: this.keybindings.prefixLabel, bindings }
  }

  private refreshTerminalTitle(): void {
    if (this.shuttingDown && this.renderer.isDestroyed) return
    const active = this.activeInstance()
    this.renderer.setTerminalTitle(active ? `fmx · ${active.label}` : "fmx")
  }
}

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

function helpEntries(keybindings: Keybindings): HelpEntry[] {
  return [
    [keybindings.prefixLabel, "prefix mode"],
    [bindingLabel(keybindings.help), "keybinds"],
    [bindingLabel(keybindings.new_tab), "new agent"],
    [bindingLabel(keybindings.launch), "launch agent"],
    [bindingLabel(keybindings.previous_tab), "prev agent"],
    [bindingLabel(keybindings.next_tab), "next agent"],
    [bindingLabel(keybindings.toggle_sidebar), "toggle sidebar"],
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

function styledSpawnErrorContent(heading: string, lines: string[], colors: ModalColors): StyledText {
  const chunks: TextChunk[] = [bold(fg(colors.error)(` ${heading}`)), fg(colors.foreground)("\n\n ")]
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

function subagentInfos(entries: SubagentEntry[]): SubagentInfo[] {
  return entries.map((entry) => ({
    session_id: entry.sessionId,
    label: entry.label,
    state: entry.state,
    attention: entry.attention,
    children: subagentInfos(entry.children),
  }))
}

function launchChoices(modelId: string): LaunchChoices {
  const model = codexModel(modelId) ?? DEFAULT_CODEX_MODEL
  return { models: CODEX_MODELS.map((candidate) => candidate.id), efforts: [...model.efforts] }
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

/** A launch that failed before fx ran: the error modal names the worktree
 * rather than fx, and a caller sees it as a plain failure. */
class WorktreeError extends ControlFailure {
  constructor(message: string) {
    super("failed", message)
    this.name = "WorktreeError"
  }
}

function launchErrorHeading(error: unknown): string {
  return error instanceof WorktreeError ? "worktree not created" : "fx did not start"
}

