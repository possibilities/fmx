import type { createTestRenderer } from "@opentui/core/testing"

type Setup = Awaited<ReturnType<typeof createTestRenderer>>

/**
 * Start an agent from the keyboard, which is the only way a key starts one:
 * the launch dialog opens on the project fmx was started in, enter commits
 * the empty prompt and moves on, and the next enter launches from the rows as
 * they stand.
 */
export function pressLaunch(setup: Setup): void {
  setup.mockInput.pressKey("b", { ctrl: true })
  setup.mockInput.pressKey("l")
  setup.mockInput.pressEnter()
  setup.mockInput.pressEnter()
}

/**
 * The same, held until the agent is on screen. A launch reads the project's
 * Git context before it claims anything, so the row a key asks for arrives a
 * few frames later rather than in the same tick.
 */
export async function launchAgent(setup: Setup, id = 1, timeoutMs = 4_000): Promise<void> {
  pressLaunch(setup)
  const deadline = Date.now() + timeoutMs
  while (setup.renderer.root.findDescendantById(`fx-${id}`) === undefined) {
    if (Date.now() >= deadline) throw new Error(`agent ${id} never appeared`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Held further, until the start notice has come and gone. A lifecycle toast
 * is drawn over the surface it announces, so a test measuring the layout
 * underneath waits it out rather than reading a frame it covers.
 */
export async function launchAgentQuietly(setup: Setup, id = 1, timeoutMs = 4_000): Promise<void> {
  await launchAgent(setup, id, timeoutMs)
  const deadline = Date.now() + timeoutMs
  while (setup.renderer.root.findDescendantById("fmx-toast")?.visible !== false) {
    if (Date.now() >= deadline) throw new Error("the start notice never cleared")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
