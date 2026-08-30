import { expect, test } from "bun:test"
import {
  type KeyEvent,
  type RGBA,
  TextAttributes,
  TextRenderable,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { AgentPicker, type AgentPickerEntry } from "../src/agent-picker.ts"

function entry(overrides: Partial<AgentPickerEntry> = {}): AgentPickerEntry {
  return {
    agentId: 1,
    project: "fmx",
    branch: "main",
    sessionId: "909bc46b64721838",
    name: "implement-picker",
    state: "idle",
    attention: null,
    active: false,
    ...overrides,
  }
}

const key = (overrides: Partial<KeyEvent> = {}): KeyEvent => {
  const name = overrides.name ?? "r"
  return {
    name,
    sequence: overrides.sequence ?? name,
    raw: overrides.raw ?? name,
    shift: false,
    ctrl: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
    ...overrides,
  } as KeyEvent
}

test("draws one full-width control and a downward fxnk selector over the stage", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const selected: number[] = []
  const opened: boolean[] = []
  const picker = new AgentPicker(setup.renderer, {
    theme: "dark",
    onSelect: (agentId) => selected.push(agentId),
    onOpenChange: (open) => opened.push(open),
  })
  picker.visible = true
  picker.resizeForSize(80, 24)
  picker.setEntries([
    entry({ agentId: 1, name: "available", state: "idle" }),
    entry({ agentId: 2, name: "implement-picker", state: "working", active: true }),
    entry({ agentId: 3, name: "review-complete", state: "done" }),
  ])
  setup.renderer.root.add(picker)

  try {
    await setup.renderOnce()
    expect([picker.x, picker.y, picker.width, picker.height]).toEqual([0, 0, 80, 3])
    expect(picker.button.borderColor.slot).toBe(240)
    expect(picker.selector.visible).toBe(false)
    expect(setup.captureCharFrame()).toContain("agent ◐ 2 · implement-picker · fmx · main ▾")

    await setup.mockMouse.pressDown(picker.button.screenX + 2, picker.button.screenY + 1)
    await setup.renderOnce()

    expect(picker.open).toBe(true)
    expect(opened).toEqual([true])
    expect(picker.selector.focused).toBe(true)
    expect(picker.selector.focusedBorderColor.slot).toBe(4)
    expect(picker.selector.height).toBe(7)
    expect(picker.menuHeight).toBe(4)
    expect(picker.backdrop.visible).toBe(true)
    expect(picker.backdrop.height).toBe(24)
    expect(picker.backdrop.backgroundColor.toInts()).toEqual([0, 0, 0, 51])
    expect(picker.optionRow(0)?.screenY).toBe(3)

    const newest = setup.renderer.root.findDescendantById("fmx-agent-picker-option-text-0")
    const active = setup.renderer.root.findDescendantById("fmx-agent-picker-option-text-1")
    expect(newest).toBeInstanceOf(TextRenderable)
    expect(active).toBeInstanceOf(TextRenderable)
    if (!(newest instanceof TextRenderable) || !(active instanceof TextRenderable)) return
    expect(newest.chunks.some((chunk) => chunk.text === "✓ ")).toBe(true)
    expect(newest.chunks.some((chunk) => chunk.text === "review-complete")).toBe(true)
    const highlightedName = active.chunks.find((chunk) => chunk.text === "implement-picker")
    expect((highlightedName?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)

    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    const visibleSpans = spans.filter((span) => span.text.trim().length > 0)
    const chromatic = visibleSpans.filter((span) => !isGrayscale(span.fg))
    expect(chromatic.length).toBeGreaterThan(0)
    expect(chromatic.every((span) => span.fg.intent === "indexed" && span.fg.slot === 4)).toBe(true)
    expect(chromatic.every((span) => /^[┌─┐│└┘▎> ]+$/u.test(span.text))).toBe(true)

    await setup.mockMouse.pressDown(picker.optionRow(0)!.screenX + 2, picker.optionRow(0)!.screenY)
    expect(selected).toEqual([3])
    expect(opened).toEqual([true, false])
    expect(picker.open).toBe(false)
  } finally {
    picker.destroy()
    setup.renderer.destroy()
  }
})

test("scrolls a shallow menu around the stable highlighted Agent and closes on keyboard selection", async () => {
  const setup = await createTestRenderer({ width: 40, height: 6, kittyKeyboard: true })
  const selected: number[] = []
  const picker = new AgentPicker(setup.renderer, {
    theme: "light",
    onSelect: (agentId) => selected.push(agentId),
  })
  picker.visible = true
  picker.resizeForSize(40, 6)
  picker.setEntries([
    entry({ agentId: 1, name: "one" }),
    entry({ agentId: 2, name: "two" }),
    entry({ agentId: 3, name: "three" }),
    entry({ agentId: 4, name: "four" }),
    entry({ agentId: 5, name: "five", active: true }),
  ])
  setup.renderer.root.add(picker)

  try {
    await setup.renderOnce()
    picker.openMenu()
    await setup.renderOnce()
    expect(picker.selector.height).toBe(6)
    expect(picker.menuHeight).toBe(3)
    expect(picker.optionRow(0)?.visible).toBe(true)
    expect(picker.optionRow(1)?.visible).toBe(true)
    expect(picker.optionRow(2)).toBeNull()

    picker.handleKeyPress(key({ name: "down" }))
    picker.handleKeyPress(key({ name: "down" }))
    picker.handleKeyPress(key({ name: "down" }))
    await setup.renderOnce()
    expect(picker.highlightedAgentId).toBe(2)
    expect(setup.captureCharFrame()).toContain("3 · three")
    expect(setup.captureCharFrame()).toContain("2 · two")
    const firstVisible = setup.renderer.root.findDescendantById("fmx-agent-picker-option-text-0")
    expect(firstVisible).toBeInstanceOf(TextRenderable)
    if (!(firstVisible instanceof TextRenderable)) return
    expect(firstVisible.chunks.some((chunk) => chunk.text === "five")).toBe(false)

    expect(picker.handleKeyPress(key({ name: "enter" }))).toBe(true)
    expect(selected).toEqual([2])
    expect(picker.open).toBe(false)

    picker.openMenu()
    expect(picker.handleKeyPress(key({ name: "c", ctrl: true }))).toBe(true)
    expect(picker.open).toBe(false)
    picker.applyTheme("dark")
    expect(picker.button.borderColor.slot).toBe(240)
  } finally {
    picker.destroy()
    setup.renderer.destroy()
  }
})

function isGrayscale(color: RGBA): boolean {
  const [red, green, blue] = color.toInts()
  return red === green && green === blue
}
