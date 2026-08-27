import type { createTestRenderer } from "@opentui/core/testing"
import type { Multiplexer } from "../../src/multiplexer.ts"

type Setup = Awaited<ReturnType<typeof createTestRenderer>>
const NEVER = new AbortController().signal

/** Start an Agent through the same control method the CLI drives. */
export function startAgent(
  multiplexer: Multiplexer,
  directory = process.cwd(),
  focus = true,
): Promise<unknown> {
  return multiplexer.control.handle("launch", { directory, focus }, NEVER)
}

export async function launchAgent(
  setup: Setup,
  multiplexer: Multiplexer,
  id = 1,
  timeoutMs = 4_000,
): Promise<void> {
  await startAgent(multiplexer)
  const deadline = Date.now() + timeoutMs
  while (setup.renderer.root.findDescendantById(`fx-${id}`) === undefined) {
    if (Date.now() >= deadline) throw new Error(`agent ${id} never appeared`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Wait until the lifecycle notice clears before measuring the UI beneath. */
export async function launchAgentQuietly(
  setup: Setup,
  multiplexer: Multiplexer,
  id = 1,
  timeoutMs = 4_000,
): Promise<void> {
  await launchAgent(setup, multiplexer, id, timeoutMs)
  const deadline = Date.now() + timeoutMs
  while (setup.renderer.root.findDescendantById("fmx-toast")?.visible !== false) {
    if (Date.now() >= deadline) throw new Error("the start notice never cleared")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
