#!/usr/bin/env bun

import { createCliRenderer, type CliRenderer, type TerminalColors } from "@opentui/core"
import { access, constants, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { AgentSocket } from "./agent-socket.ts"
import { parseArgs, usage, VERSION } from "./cli.ts"
import { loadConfig } from "./config.ts"
import { debugPanelRequested } from "./debug-panel.ts"
import { FX_KEYBOARD_PROTOCOL } from "./fx-terminal.ts"
import { Multiplexer } from "./multiplexer.ts"
import { loadState, saveState } from "./state.ts"

async function main(): Promise<void> {
  let options
  try {
    options = parseArgs(Bun.argv.slice(2))
  } catch (error) {
    process.stderr.write(`fmx: ${errorMessage(error)}\n\n${usage()}`)
    process.exitCode = 2
    return
  }

  if (options.help) {
    process.stdout.write(usage())
    return
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
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

  let renderer: CliRenderer | null = null
  let app: Multiplexer | null = null
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  const debugPanel = debugPanelRequested()
  const agentSocket = new AgentSocket()

  try {
    agentSocket.start()
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      useKittyKeyboard: FX_KEYBOARD_PROTOCOL,
    })
    renderer.start()
    app = new Multiplexer(renderer, {
      fxPath,
      cwd: workspace,
      initialFxArgs: options.initialFxArgs,
      keybindings: loadedConfig.keybindings,
      agentSocket,
      debugPanel,
      projectRoots: loadedConfig.projectRoots,
      slug: loadedConfig.slug,
      initialSidebarWidth: persistedState.sidebarWidth,
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
    agentSocket.close()
  }
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
  process.exitCode = 1
})
