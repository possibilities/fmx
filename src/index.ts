#!/usr/bin/env bun

import { createCliRenderer, type CliRenderer, type TerminalColors } from "@opentui/core"
import { realpath } from "node:fs/promises"
import { AgentSocket, AgentSocketActiveError } from "./agent-socket.ts"
import { parseArgs, UsageError, usage, VERSION } from "./cli.ts"
import { loadConfig } from "./config.ts"
import { EXIT_USAGE, runCommand } from "./control-client.ts"
import { ControlSocket } from "./control-socket.ts"
import { debugPanelRequested } from "./debug-panel.ts"
import { doctor, resolveFx } from "./doctor.ts"
import { InstanceManifest, type ManifestEntry, manifestPath } from "./instance-manifest.ts"
import { reconcileInstances, type ReconcileOutcome } from "./instance-reconcile.ts"
import { FX_KEYBOARD_PROTOCOL } from "./fx-terminal.ts"
import { Multiplexer } from "./multiplexer.ts"
import { loadState, saveState } from "./state.ts"
import { CompanionTransportFactory } from "./companion-transport.ts"
import { CompanionCommand } from "./zmx-command.ts"
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

  const workspace = await realpath(process.cwd())
  const fxPath = await resolveFx(process.env.FMX_FX_PATH ?? "fx")
  const companionPath = await resolveCompanion()
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
  let transport: CompanionTransportFactory | null = null
  let manifest: InstanceManifest | null = null

  try {
    // The socket is the Home's singleton; only its holder may touch the
    // Manifest, so the join runs after the bind and before anything is drawn.
    await agentSocket.start()
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
    manifest = await InstanceManifest.open(manifestPath(), home)
    const survivors = await reconcileAtStartup(manifest, companion)
    transport = new CompanionTransportFactory(companion, home)
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
      manifest,
      transport,
      survivors,
      agentSocket,
      debugPanel,
      projectRoots: loadedConfig.projectRoots,
      worktreeRoot: loadedConfig.worktreeRoot,
      slug: loadedConfig.slug,
      controlSocketPath: ControlSocket.pathFor(agentSocket.path),
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

    // Beside the agent socket and under the same singleton: an fx that
    // outlives this fmx still reaches the next one for this Home by the path
    // it was given.
    controlSocket = new ControlSocket(app.control, ControlSocket.pathFor(agentSocket.path))
    controlSocket.start()

    // Detection takes seconds in a terminal that never answers, and a
    // renderer destroyed under it never settles the query: a shutdown in
    // that window must still reach the cleanup below.
    const hostPalette = await Promise.race([detectHostPalette(renderer), app.waitUntilDone().then(() => null)])
    if (hostPalette) app.setHostPalette(hostPalette)
    await app.start()
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
    controlSocket?.close()
    // Only the fmx that bound the socket may unlink it; the one refused at
    // start never had it.
    agentSocket.close()
  }
}

/**
 * Join the Manifest against the Companion's sessions before anything is
 * drawn: adopt what a crash left unrecorded, drop what has ended, and hand
 * back what survived for the multiplexer to attach. A join that fails is
 * reported and changes nothing — a failed read must never be taken for an
 * empty Companion — and fmx starts with nothing attached, the Instances
 * left where they are for the next start.
 */
async function reconcileAtStartup(manifest: InstanceManifest, companion: CompanionCommand): Promise<ManifestEntry[]> {
  let outcome: ReconcileOutcome
  try {
    outcome = await reconcileInstances(manifest, companion)
  } catch (error) {
    process.stderr.write(`fmx: could not reconcile instances: ${errorMessage(error)}\n`)
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

async function detectHostPalette(renderer: CliRenderer): Promise<TerminalColors | null> {
  try {
    return await renderer.getPalette({ size: 16 })
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
