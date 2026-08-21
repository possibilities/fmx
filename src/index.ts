#!/usr/bin/env bun

import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { access, constants, realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { parseArgs, usage, VERSION } from "./cli.ts"
import { Multiplexer } from "./multiplexer.ts"

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

  const workspace = await realpath(options.cwd)
  if (!(await stat(workspace)).isDirectory()) throw new Error(`workspace is not a directory: ${workspace}`)
  const fxPath = await resolveExecutable(options.fxPath ?? process.env.FMX_FX_PATH ?? "fx")

  let renderer: CliRenderer | null = null
  let app: Multiplexer | null = null
  const signalHandlers = new Map<NodeJS.Signals, () => void>()

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      useKittyKeyboard: { events: true },
    })
    renderer.start()
    app = new Multiplexer(renderer, {
      fxPath,
      cwd: workspace,
      initialFxArgs: options.initialFxArgs,
      maxScrollback: options.maxScrollback,
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

    app.start()
    await app.waitUntilDone()
  } catch (error) {
    if (app) await app.shutdown(1)
    else renderer?.destroy()
    throw error
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
  }
}

async function resolveExecutable(requested: string): Promise<string> {
  const candidate = requested.includes("/")
    ? isAbsolute(requested)
      ? requested
      : resolve(process.cwd(), requested)
    : Bun.which(requested)
  if (!candidate) throw new Error(`fx executable not found: ${requested} (use --fx or FMX_FX_PATH)`)
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
