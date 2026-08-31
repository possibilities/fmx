import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import type { Snapshot } from "../src/control-protocol.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer, RuntimeExtensionSurfaceError } from "../src/multiplexer.ts"
import type { RecoveryCardActionCorrelation, RecoveryCardSpec } from "../src/recovery-card.ts"
import { createAgent } from "./fixtures/agent-start.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))
const NEVER = new AbortController().signal

function card(overrides: Partial<RecoveryCardSpec> = {}): RecoveryCardSpec {
  return {
    slot_id: "slot-a",
    card_revision: "12",
    title: "Member unavailable",
    message: "The exact member cannot be restored. Existing records remain intact.",
    action: {
      action_id: "request-fresh-member",
      label: "Request fresh member",
      ...overrides.action,
    },
    ...overrides,
  }
}

function pressPrefixAction(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  key: string,
): void {
  setup.mockInput.pressKey("b", { ctrl: true })
  setup.mockInput.pressKey(key)
}

test("keeps one recovery card selectable in the Tray without inventing an Agent or MCP action", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24, kittyKeyboard: true, exitOnCtrlC: false })
  const actions: RecoveryCardActionCorrelation[] = []
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    onRecoveryCardAction: (correlation) => actions.push(correlation),
  })
  await multiplexer.start()

  try {
    multiplexer.extension.publishRecoveryCard(card())
    await setup.renderOnce()

    const tray = setup.renderer.root.findDescendantById("fmx-tray") as BoxRenderable
    const divider = setup.renderer.root.findDescendantById("fmx-divider") as BoxRenderable
    const emptyState = setup.renderer.root.findDescendantById("fmx-empty-state") as TextRenderable
    const recovery = setup.renderer.root.findDescendantById("fmx-recovery-card-slot-a") as BoxRenderable
    expect(tray.visible).toBe(true)
    expect(divider.visible).toBe(true)
    expect(emptyState.visible).toBe(false)
    expect(recovery.visible).toBe(true)
    expect(setup.captureCharFrame()).toContain("Member unavailable")
    expect(setup.captureCharFrame()).toContain("Request fresh member")

    const publicSnapshot = (await multiplexer.control.handle("orient", {}, NEVER)) as Snapshot
    expect(publicSnapshot.active).toBeNull()
    expect(publicSnapshot.agents).toEqual([])
    expect(publicSnapshot.tray.rows).toEqual([])
    expect(await multiplexer.extension.snapshot()).toMatchObject({
      selected_agent_id: null,
      agents: [],
    })

    setup.mockInput.pressEnter()
    expect(actions).toEqual([{
      slot_id: "slot-a",
      card_revision: "12",
      action_id: "request-fresh-member",
    }])

    await createAgent(multiplexer, process.cwd(), false)
    await setup.renderOnce()
    const terminal = setup.renderer.root.findDescendantById("fx-1") as BoxRenderable
    expect(terminal.visible).toBe(false)
    expect(recovery.visible).toBe(true)

    pressPrefixAction(setup, "n")
    await setup.renderOnce()
    expect(terminal.visible).toBe(true)
    expect(recovery.visible).toBe(false)
    expect((await multiplexer.extension.snapshot()).selected_agent_id).not.toBeNull()

    const row = setup.renderer.root.findDescendantById("fmx-session-row-recovery-card-slot-a") as BoxRenderable
    await setup.mockMouse.pressDown(row.screenX + 2, row.screenY)
    await setup.renderOnce()
    expect(terminal.visible).toBe(false)
    expect(recovery.visible).toBe(true)
    expect((await multiplexer.extension.snapshot()).selected_agent_id).toBeNull()

    expect(() => multiplexer.extension.clearRecoveryCard("slot-a", "11"))
      .toThrow(RuntimeExtensionSurfaceError)
    try {
      multiplexer.extension.clearRecoveryCard("slot-a", "11")
    } catch (error) {
      expect(error).toMatchObject({ code: "stale" })
    }
    multiplexer.extension.clearRecoveryCard("slot-a", "12")
    await setup.renderOnce()
    expect(setup.renderer.root.findDescendantById("fmx-recovery-card-slot-a")).toBeUndefined()
    expect(setup.renderer.root.findDescendantById("fmx-session-row-recovery-card-slot-a")).toBeUndefined()
    expect(terminal.visible).toBe(true)
    expect((await multiplexer.extension.snapshot()).selected_agent_id).not.toBeNull()
  } finally {
    await multiplexer.shutdown()
  }
})

test("keeps the recovery card reachable in picker mode and preserves the lone-Agent modifier", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24, kittyKeyboard: true, exitOnCtrlC: false })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    agentPicker: true,
    hideSingleAgentPicker: true,
  })
  await multiplexer.start()

  try {
    const picker = setup.renderer.root.findDescendantById("fmx-agent-picker") as BoxRenderable
    const selector = setup.renderer.root.findDescendantById("fmx-agent-picker-selector") as BoxRenderable
    const content = setup.renderer.root.findDescendantById("fmx-content") as BoxRenderable
    expect(picker.visible).toBe(false)

    multiplexer.extension.publishRecoveryCard(card())
    await setup.renderOnce()
    expect(picker.visible).toBe(true)
    expect([content.y, content.height]).toEqual([3, 21])
    expect(setup.captureCharFrame()).toContain("unavailable ! Member unavailable")

    await createAgent(multiplexer, process.cwd(), false)
    await setup.renderOnce()
    const terminal = setup.renderer.root.findDescendantById("fx-1") as BoxRenderable
    expect(picker.visible).toBe(true)
    expect(terminal.visible).toBe(false)

    pressPrefixAction(setup, "b")
    await setup.renderOnce()
    expect(selector.visible).toBe(true)
    const cardOption = setup.renderer.root.findDescendantById("fmx-agent-picker-option-text-0") as TextRenderable
    expect(cardOption.chunks.some((chunk) => chunk.text === "Member unavailable")).toBe(true)
    expect(cardOption.chunks.some((chunk) => chunk.text === " · unavailable")).toBe(true)
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await setup.flush()
    expect(selector.visible).toBe(false)
    expect(terminal.visible).toBe(true)
    expect((await multiplexer.extension.snapshot()).selected_agent_id).not.toBeNull()

    pressPrefixAction(setup, "b")
    await setup.renderOnce()
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressEnter()
    await setup.flush()
    expect(terminal.visible).toBe(false)
    expect((await multiplexer.extension.snapshot()).selected_agent_id).toBeNull()

    multiplexer.extension.clearRecoveryCard("slot-a", "12")
    await setup.renderOnce()
    expect(picker.visible).toBe(false)
    expect([content.y, content.height]).toEqual([0, 24])
    expect(terminal.visible).toBe(true)
  } finally {
    await multiplexer.shutdown()
  }
})
