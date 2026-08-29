import type { createTestRenderer } from "@opentui/core/testing"
import type { Multiplexer } from "../../src/multiplexer.ts"

type Setup = Awaited<ReturnType<typeof createTestRenderer>>

/** Exercise fmx's internal creation engine without adding a public driver. */
export function createAgent(
  multiplexer: Multiplexer,
  directory = process.cwd(),
  focus = true,
): Promise<unknown> {
  return multiplexer.createAgent({ directory, focus })
}

export async function startVisibleAgent(
  setup: Setup,
  multiplexer: Multiplexer,
  id = 1,
  timeoutMs = 4_000,
): Promise<void> {
  await createAgent(multiplexer)
  const deadline = Date.now() + timeoutMs
  while (setup.renderer.root.findDescendantById(`fx-${id}`) === undefined) {
    if (Date.now() >= deadline) throw new Error(`agent ${id} never appeared`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
