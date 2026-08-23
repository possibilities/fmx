import { createCliRenderer } from "@opentui/core"
import { FX_KEYBOARD_PROTOCOL } from "../src/fx-terminal.ts"
import { UiGalleryApp } from "./app.ts"
import { buildUiGallery } from "./build.ts"
import { UI_STORIES } from "./stories.ts"

export async function runUiGallery(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args)
  const built = await buildUiGallery()
  if (options.check) {
    process.stdout.write(`UI gallery: ${built.stories.dark.length} states rendered and asserted in 2 themes\n`)
    return
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("the interactive UI gallery requires a TTY")
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useKittyKeyboard: FX_KEYBOARD_PROTOCOL,
  })
  const app = new UiGalleryApp(renderer, built.stories, UI_STORIES)
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  try {
    for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const) {
      const handler = () => app.close()
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }
    renderer.start()
    await app.waitUntilDone()
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    await app.destroy()
    renderer.destroy()
  }
}

function parseArgs(args: readonly string[]): { check: boolean } {
  let check = false
  for (const argument of args) {
    if (argument === "--check") {
      check = true
      continue
    }
    throw new Error(`unknown UI gallery option: ${argument}`)
  }
  return { check }
}

if (import.meta.main) {
  await runUiGallery().catch((error) => {
    process.stderr.write(`UI gallery: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
