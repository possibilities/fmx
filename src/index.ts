#!/usr/bin/env bun

import {
  CliRenderEvents,
  CliRenderer,
  createTerminalPalette,
  type TerminalColors,
  type TerminalPaletteDetector,
} from "@opentui/core"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { AgentSocket, AgentSocketActiveError } from "./agent-socket.ts"
import { AdeSocket, adeSocketPathFor } from "./ade-events.ts"
import { parseArgs, UsageError, usage, VERSION } from "./cli.ts"
import { configPath, loadConfig } from "./config.ts"
import { EXIT_USAGE, runCommand } from "./control-client.ts"
import { ControlSocket } from "./control-socket.ts"
import { doctor } from "./doctor.ts"
import { resolveFx } from "./executable.ts"
import { AgentManifest, manifestPath } from "./agent-manifest.ts"
import { reconcileAgents, type ReconciledAgent, type ReconcileOutcome } from "./agent-reconcile.ts"
import { stringEnvironment } from "./agent-transport.ts"
import { FX_KEYBOARD_PROTOCOL } from "./fx-terminal.ts"
import { Multiplexer } from "./multiplexer.ts"
import { expandTilde } from "./projects.ts"
import { loadState, saveState, type PersistedState } from "./state.ts"
import { CompanionTransportFactory } from "./companion-transport.ts"
import { CompanionCommand } from "./zmx-command.ts"
import {
  currentRuntimeCommand,
  ensureRuntimeSession,
  isRuntimeProcess,
  RUNTIME_BOOTSTRAP_ENV_VAR,
  waitForRuntimeBootstrap,
} from "./runtime-session.ts"
import { runTerminalClient } from "./terminal-client.ts"
import {
  beginSynchronizedResizeClear,
  clearToUnusedSpace,
  paintSizingOwnerDefaultBackground,
} from "./unused-space.ts"
import { PROTOCOL_VERSION } from "./zmx-protocol.ts"
import {
  COMPANION_PIN,
  companionBuild,
  companionDirectories,
  companionDirectory,
  companionMismatch,
  ensureCompanionDirectories,
  homeId,
  resolveCompanion,
} from "./zmx-environment.ts"

/** One 60 Hz frame is enough for a responsive terminal to answer its palette
 * query, and short enough that a silent terminal does not delay first paint. */
const FIRST_FRAME_PALETTE_BUDGET_MS = 16

async function main(): Promise<void> {
  let options
  try {
    options = parseArgs(Bun.argv.slice(2))
  } catch (error) {
    const topic = error instanceof UsageError ? error.topic : null
    process.stderr.write(`fmx: ${errorMessage(error)}\n\n${usage(topic)}`)
    process.exitCode = EXIT_USAGE
    return
  }

  if (options.help) {
    process.stdout.write(usage(options.command ? "control" : null))
    return
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (options.doctor) {
    const report = await doctor()
    process.stdout.write(`${report.lines.join("\n")}\n`)
    process.exitCode = report.ok ? 0 : 1
    return
  }
  if (options.command) {
    const outcome = await runCommand(options.command, options.socket, {
      env: process.env,
      cwd: process.cwd(),
      readStdin: () => Bun.stdin.text(),
    })
    if (outcome.error) process.stderr.write(`${JSON.stringify({ error: outcome.error })}\n`)
    else process.stdout.write(`${JSON.stringify(outcome.result ?? null, null, 2)}\n`)
    process.exitCode = outcome.exitCode
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("fmx requires an interactive terminal (TTY)")
  }
  if (typeof Bun.Terminal !== "function") {
    throw new Error("fmx requires Bun 1.4 or newer")
  }

  if (!isRuntimeProcess()) {
    await startTerminalClient()
    return
  }
  const bootstrapPath = process.env[RUNTIME_BOOTSTRAP_ENV_VAR]
  if (!bootstrapPath) throw new Error("fmx Runtime has no Client bootstrap path")
  await waitForRuntimeBootstrap(bootstrapPath)

  const loadedConfig = await loadConfig()
  for (const diagnostic of loadedConfig.diagnostics) process.stderr.write(`fmx: ${diagnostic}\n`)
  if (loadedConfig.projectRoots.length === 0) {
    throw new Error(`no project roots configured; add project_roots = ["~/code"] to ${configPath()}`)
  }
  const workspace = await realpath(expandTilde(loadedConfig.projectRoots[0]!, homedir()))
  const fxPath = await resolveFx()
  const companionPath = await resolveCompanion()
  const persistedState = await loadState()
  let stateSave: Promise<void> = Promise.resolve()
  const persistState = () => {
    const snapshot: PersistedState = { ...persistedState }
    if (persistedState.projectLaunches) snapshot.projectLaunches = { ...persistedState.projectLaunches }
    stateSave = stateSave.then(() => saveState(snapshot)).catch(() => {})
  }
  const home = homeId()

  let renderer: CliRenderer | null = null
  let startupPaletteDetector: TerminalPaletteDetector | null = null
  let app: Multiplexer | null = null
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  const agentSocket = new AgentSocket({ homeId: home })
  let adeSocket: AdeSocket | null = null
  let controlSocket: ControlSocket | null = null
  let transport: CompanionTransportFactory | null = null
  let manifest: AgentManifest | null = null
  let runtimeResizeHandler: (() => void) | null = null
  let runtimePaletteHandler: ((colors: TerminalColors) => void) | null = null
  let runtimePalette: TerminalColors | null = null

  try {
    // The socket is the Home's singleton; only its holder may touch the
    // Manifest, so the join runs after the bind and before anything is drawn.
    await agentSocket.start()
    adeSocket = new AdeSocket({ path: adeSocketPathFor(agentSocket.path) })
    adeSocket.start()

    // Start the host query as soon as this Runtime owns the Home, while the
    // Companion join still runs. The one-frame choice remains fixed 16 ms
    // after the query; only its wait is removed from the later critical path.
    // Constructing the renderer starts its input parser but does not expose the
    // alternate screen, so replies can arrive while nothing has been painted.
    const createdRenderer = new CliRenderer(
      process.stdin,
      process.stdout,
      process.stdout.columns || 80,
      process.stdout.rows || 24,
      {
        exitOnCtrlC: false,
        exitSignals: [],
        useKittyKeyboard: FX_KEYBOARD_PROTOCOL,
      },
    )
    renderer = createdRenderer
    const termProgram = process.env.TERM_PROGRAM?.toLowerCase()
    const tmuxVersion = termProgram?.includes("tmux") ? process.env.TERM_PROGRAM_VERSION : undefined
    startupPaletteDetector = createTerminalPalette({
      stdin: process.stdin,
      stdout: process.stdout,
      isTmux: Boolean(process.env.TMUX) || Boolean(termProgram?.includes("tmux")),
      isLegacyTmux:
        tmuxVersion !== undefined && tmuxVersion.localeCompare("3.6", undefined, { numeric: true }) < 0,
      oscSource: {
        subscribeOsc: (handler) => createdRenderer.subscribeOsc(handler),
      },
    })
    const paletteDetection = detectHostPalette(startupPaletteDetector)
    const firstPaletteChoice = Promise.race([
      paletteDetection.then((colors) => ({ kind: "settled" as const, colors })),
      Bun.sleep(FIRST_FRAME_PALETTE_BUDGET_MS).then(() => ({ kind: "pending" as const })),
    ])

    await ensureCompanionDirectories(companionDirectories())
    // The pair is checked once the directory is ours: `version` creates the
    // directory if it must, and a stock-built fork would create one fmx
    // refuses. An installed Companion that is not the pinned build never
    // runs; one named by the override runs with a word about it.
    const build = await companionBuild(companionPath.path)
    if (build !== COMPANION_PIN.build) {
      const message = companionMismatch(companionPath, build, PROTOCOL_VERSION)
      if (companionPath.origin !== "override") throw new Error(message)
      process.stderr.write(`fmx: ${message}\n`)
    }
    const companion = new CompanionCommand(companionDirectory(), process.env, companionPath.path)
    manifest = await AgentManifest.open(manifestPath(), home)
    const restored = await reconcileAtStartup(manifest, companion)
    transport = new CompanionTransportFactory(companion, home, {
      attachHints: new Map(restored.map(({ entry, session }) => [entry.agentId, session])),
    })
    const survivors = restored.map(({ entry }) => entry)
    const controlSocketPath = ControlSocket.pathFor(agentSocket.path)
    const firstPalette = await firstPaletteChoice
    runtimePalette = firstPalette.kind === "settled" ? firstPalette.colors : null
    await renderer.setupTerminal()
    // One Runtime frame is broadcast to every Client. Apply the new owner size
    // synchronously before clearing every physical terminal; input can follow
    // the resize before OpenTUI's debounced SIGWINCH handler runs, and that
    // interaction must not paint one last frame at the previous owner's size.
    // OpenTUI then repaints only the sizing owner's shared frame. Larger
    // observers retain the field at the right and bottom.
    runtimeResizeHandler = () => {
      createdRenderer.resize(
        Math.max(1, process.stdout.columns || createdRenderer.width),
        Math.max(1, process.stdout.rows || createdRenderer.height),
      )
      // Keep the clear and the resized frame in one synchronized terminal
      // update. OpenTUI's frame closes the mode after restoring its cursor.
      process.stdout.write(beginSynchronizedResizeClear(runtimePalette))
    }
    process.stdout.on("resize", runtimeResizeHandler)
    // A live host-theme change updates the shared frame through Multiplexer;
    // repaint the physical field too so larger observers do not retain the
    // previous theme's unused margins until another resize.
    runtimePaletteHandler = (colors) => {
      runtimePalette = colors
      process.stdout.write(clearToUnusedSpace(colors))
    }
    createdRenderer.on(CliRenderEvents.PALETTE, runtimePaletteHandler)

    app = new Multiplexer(renderer, {
      fxPath,
      cwd: workspace,
      keybindings: loadedConfig.keybindings,
      manifest,
      transport,
      survivors,
      agentSocket,
      adeSocket,
      projectRoots: loadedConfig.projectRoots,
      worktreeRoot: loadedConfig.worktreeRoot,
      controlSocketPath,
      initialTrayWidth: persistedState.trayWidth,
      initialTrayHidden: persistedState.trayHidden,
      initialActiveAgentId: persistedState.activeAgentId,
      initialProjectLaunches: persistedState.projectLaunches,
      initialPalettePending: firstPalette.kind === "pending",
      onProjectLaunch: (launches) => {
        persistedState.projectLaunches = launches
        persistState()
      },
      onTrayWidthChange: (width) => {
        persistedState.trayWidth = width
        // State persistence is an enhancement; a failed write must never
        // disturb the running session.
        persistState()
      },
      onTrayHiddenChange: (hidden) => {
        if (hidden) persistedState.trayHidden = true
        else delete persistedState.trayHidden
        persistState()
      },
      onActiveAgentChange: (agentId) => {
        if (agentId === null) {
          if (persistedState.activeAgentId === undefined) return
          delete persistedState.activeAgentId
        } else {
          if (persistedState.activeAgentId === agentId) return
          persistedState.activeAgentId = agentId
        }
        persistState()
      },
    })
    app.lockStartupChrome(firstPalette.kind === "settled" ? firstPalette.colors : null)
    if (firstPalette.kind === "pending") {
      // Do not put a guessed opaque RGB on screen while the terminal is still
      // answering. SGR 49 paints its exact native background, and row-bounded
      // ECH keeps a larger observing Client's unused right and bottom margins.
      process.stdout.write(paintSizingOwnerDefaultBackground(renderer.width, renderer.height))
    }

    for (const [signal, exitCode] of [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGQUIT", 131],
      ["SIGTERM", 143],
    ] as const) {
      const handler = () => void app?.shutdown(exitCode)
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }

    // Choose the truthful first surface before anything may render. The chrome
    // was fixed above, before the renderer could expose an empty or partially
    // restored application. Multiplexer holds the restored Session list until
    // every durable source and transport-discovered identity has been read.
    const startup = app.start()
    renderer.start()
    await startup

    // Beside the agent socket and under the same singleton: an fx that
    // outlives this fmx still reaches the next one for this Home by the path
    // it was given. Do not accept control requests until restored Agents are
    // attached and the selected terminal is ready to receive input.
    controlSocket = new ControlSocket(app.control, ControlSocket.pathFor(agentSocket.path))
    controlSocket.start()

    // Detection takes seconds in a terminal that never answers, and a
    // renderer destroyed under it never settles the query: a shutdown in
    // that window must still reach the cleanup below.
    const hostPalette = await Promise.race([paletteDetection, app.waitUntilDone().then(() => null)])
    if (hostPalette) {
      runtimePalette = hostPalette
      // The pending frame already has the terminal's native background. Make
      // that same detected color OpenTUI's opaque base without first clearing
      // the owner to the lighter unused-field step, which would visibly flash
      // until the renderer's next frame. Future resizes use runtimePalette;
      // genuine later theme changes still repaint every physical margin.
      app.setHostPalette(hostPalette)
    }
    app.unlockStartupChrome()
    await app.waitUntilDone()
  } catch (error) {
    if (app) await app.shutdown(1)
    else renderer?.destroy()
    throw error
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    // Nothing the Companion is still being asked about is waited for; what
    // is not consumed is the next start's. The Manifest's last write is.
    transport?.close()
    await manifest?.settled()
    await stateSave
    controlSocket?.close()
    adeSocket?.close()
    startupPaletteDetector?.cleanup()
    if (runtimeResizeHandler) process.stdout.off("resize", runtimeResizeHandler)
    if (runtimePaletteHandler) renderer?.off(CliRenderEvents.PALETTE, runtimePaletteHandler)
    // Only the fmx that bound the socket may unlink it; the one refused at
    // start never had it.
    agentSocket.close()
  }
}

async function startTerminalClient(): Promise<void> {
  const loadedConfig = await loadConfig()
  for (const diagnostic of loadedConfig.diagnostics) process.stderr.write(`fmx: ${diagnostic}\n`)
  if (loadedConfig.projectRoots.length === 0) {
    throw new Error(`no project roots configured; add project_roots = ["~/code"] to ${configPath()}`)
  }
  const workspace = await realpath(expandTilde(loadedConfig.projectRoots[0]!, homedir()))
  const companionPath = await resolveCompanion()
  await ensureCompanionDirectories(companionDirectories())
  const build = await companionBuild(companionPath.path)
  if (build !== COMPANION_PIN.build) {
    const message = companionMismatch(companionPath, build, PROTOCOL_VERSION)
    if (companionPath.origin !== "override") throw new Error(message)
    process.stderr.write(`fmx: ${message}\n`)
  }
  const companion = new CompanionCommand(companionDirectory(), process.env, companionPath.path)
  const runtime = await ensureRuntimeSession(companion, {
    homeId: homeId(),
    cwd: workspace,
    command: currentRuntimeCommand(),
    env: stringEnvironment(process.env),
  })
  process.exitCode = await runTerminalClient({
    socketPath: runtime.socketPath,
    bootstrapPath: runtime.bootstrapPath,
    keybindings: loadedConfig.keybindings,
  })
}

/**
 * Join the Manifest against the Companion's sessions before anything is
 * drawn: adopt what a crash left unrecorded, drop what has ended, and hand
 * back what survived for the multiplexer to attach. A join that fails is
 * reported and changes nothing — a failed read must never be taken for an
 * empty Companion — and fmx starts with nothing attached, the Agents
 * left where they are for the next start.
 */
async function reconcileAtStartup(manifest: AgentManifest, companion: CompanionCommand): Promise<ReconciledAgent[]> {
  let outcome: ReconcileOutcome
  try {
    outcome = await reconcileAgents(manifest, companion)
  } catch (error) {
    process.stderr.write(`fmx: could not reconcile agents: ${errorMessage(error)}\n`)
    return []
  }
  if (outcome.cleared.length > 0) {
    process.stderr.write(`fmx: cleared ${outcome.cleared.length} stale Companion socket(s)\n`)
  }
  if (outcome.unresolved.length > 0) {
    process.stderr.write(`fmx: ${outcome.unresolved.length} Companion session(s) unreachable; left for the next start\n`)
  }
  return [...outcome.attached, ...outcome.adopted]
}

async function detectHostPalette(detector: TerminalPaletteDetector): Promise<TerminalColors | null> {
  try {
    return await detector.detect({ size: 16 })
  } catch {
    // Palette mirroring is an enhancement; keep fmx usable when a terminal
    // cannot answer OSC color queries.
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

await main().catch((error) => {
  process.stderr.write(`fmx: ${errorMessage(error)}\n`)
  process.exitCode = error instanceof AgentSocketActiveError ? 2 : 1
})
