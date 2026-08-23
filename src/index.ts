#!/usr/bin/env bun

import { createCliRenderer, type CliRenderer, type TerminalColors } from "@opentui/core"
import { access, constants, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { AgentSocket, AgentSocketActiveError } from "./agent-socket.ts"
import { parseArgs, UsageError, usage, VERSION } from "./cli.ts"
import { loadConfig } from "./config.ts"
import { EXIT_USAGE, runCommand } from "./control-client.ts"
import { ControlSocket } from "./control-socket.ts"
import { debugPanelRequested } from "./debug-panel.ts"
import { InstanceManifest, manifestPath } from "./instance-manifest.ts"
import { reconcileInstances, type ReconcileOutcome } from "./instance-reconcile.ts"
import { FX_KEYBOARD_PROTOCOL } from "./fx-terminal.ts"
import { Multiplexer } from "./multiplexer.ts"
import { loadState, saveState } from "./state.ts"
import { CompanionCommand } from "./zmx-command.ts"
import { companionDirectory, homeId, resolveCompanion } from "./zmx-environment.ts"

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

  const workspace = await realpath(process.cwd())
  const fxPath = await resolveExecutable(process.env.FMX_FX_PATH ?? "fx")
  const loadedConfig = await loadConfig()
  for (const diagnostic of loadedConfig.diagnostics) process.stderr.write(`fmx: ${diagnostic}\n`)
  const persistedState = await loadState()
  const home = homeId()

  let renderer: CliRenderer | null = null
  let app: Multiplexer | null = null
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  const debugPanel = debugPanelRequested()
  const agentSocket = new AgentSocket({ homeId: home })
  let controlSocket: ControlSocket | null = null

  try {
    // The socket is the Home's singleton; only its holder may touch the
    // Manifest, so the join runs after the bind and before anything is drawn.
    await agentSocket.start()
    await reconcileAtStartup(home)
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      useKittyKeyboard: FX_KEYBOARD_PROTOCOL,
    })
    renderer.start()
    app = new Multiplexer(renderer, {
      fxPath,
      cwd: workspace,
      keybindings: loadedConfig.keybindings,
      agentSocket,
      debugPanel,
      projectRoots: loadedConfig.projectRoots,
      worktreeRoot: loadedConfig.worktreeRoot,
      slug: loadedConfig.slug,
      controlSocketPath: ControlSocket.pathFor(process.pid),
      initialSidebarWidth: persistedState.sidebarWidth,
      initialSidebarHidden: persistedState.sidebarHidden,
      initialProjectLaunches: persistedState.projectLaunches,
      onProjectLaunch: (launches) => {
        persistedState.projectLaunches = launches
        void saveState(persistedState).catch(() => {})
      },
      onSidebarWidthChange: (width) => {
        persistedState.sidebarWidth = width
        // State persistence is an enhancement; a failed write must never
        // disturb the running session.
        void saveState(persistedState).catch(() => {})
      },
      onSidebarHiddenChange: (hidden) => {
        if (hidden) persistedState.sidebarHidden = true
        else delete persistedState.sidebarHidden
        void saveState(persistedState).catch(() => {})
      },
    })

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

    controlSocket = new ControlSocket(app.control)
    controlSocket.start()

    const hostPalette = await detectHostPalette(renderer)
    if (hostPalette) app.setHostPalette(hostPalette)
    app.start()
    await app.waitUntilDone()
  } catch (error) {
    if (app) await app.shutdown(1)
    else renderer?.destroy()
    throw error
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    controlSocket?.close()
    // Only the fmx that bound the socket may unlink it; the one refused at
    // start never had it.
    agentSocket.close()
  }
}

/**
 * Join the Manifest against the Companion's sessions before anything is
 * drawn: adopt what a crash left unrecorded, drop what has ended, and say
 * what survived. Attaching survivors to visible terminals is the next
 * tranche; until then fmx reports them and starts as it always has. A
 * Companion that cannot be found, or a join that fails, is reported and
 * changes nothing: fmx started before any of this existed, and a failed
 * read must never be taken for an empty Companion.
 */
async function reconcileAtStartup(home: string): Promise<ReconcileOutcome | null> {
  let companionPath: string
  try {
    companionPath = await resolveCompanion()
  } catch (error) {
    process.stderr.write(`fmx: ${errorMessage(error)}; instances will not survive this fmx\n`)
    return null
  }
  let outcome: ReconcileOutcome
  try {
    const directory = companionDirectory()
    const companion = new CompanionCommand(directory, process.env, companionPath)
    const manifest = await InstanceManifest.open(manifestPath(), home)
    outcome = await reconcileInstances(manifest, companion)
  } catch (error) {
    process.stderr.write(`fmx: could not reconcile instances: ${errorMessage(error)}\n`)
    return null
  }
  const survivors = outcome.attached.length + outcome.adopted.length
  if (survivors > 0) {
    process.stderr.write(
      `fmx: ${survivors} surviving instance(s) in the Companion (${outcome.adopted.length} adopted); attaching them is not yet supported\n`,
    )
  }
  if (outcome.cleared.length > 0) {
    process.stderr.write(`fmx: cleared ${outcome.cleared.length} stale Companion socket(s)\n`)
  }
  if (outcome.unresolved.length > 0) {
    process.stderr.write(`fmx: ${outcome.unresolved.length} Companion session(s) unreachable; left for the next start\n`)
  }
  return outcome
}

async function detectHostPalette(renderer: CliRenderer): Promise<TerminalColors | null> {
  try {
    return await renderer.getPalette({ size: 16 })
  } catch {
    // Palette mirroring is an enhancement; keep fmx usable when a terminal
    // cannot answer OSC color queries.
    return null
  }
}

async function resolveExecutable(requested: string): Promise<string> {
  const candidate = requested.includes("/")
    ? isAbsolute(requested)
      ? requested
      : resolve(process.cwd(), requested)
    : Bun.which(requested)
  if (!candidate) throw new Error(`fx executable not found: ${requested} (set FMX_FX_PATH)`)
  try {
    await access(candidate, constants.X_OK)
  } catch {
    throw new Error(`fx executable is not executable: ${candidate}`)
  }
  return realpath(candidate)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

await main().catch((error) => {
  process.stderr.write(`fmx: ${errorMessage(error)}\n`)
  process.exitCode = error instanceof AgentSocketActiveError ? 2 : 1
})
