import { expect, test } from "bun:test"
import { BoxRenderable, type TerminalColors, TextAttributes, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import { AgentSocket } from "../src/agent-socket.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { launchAgent } from "./fixtures/launch-keys.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"
import { RAMP_FALLBACK } from "../src/host-palette.ts"
import { rowText, SessionList, stateIcon, stateRole, truncate } from "../src/session-list.ts"
import { buildTree, type SessionEntry } from "../src/session-tree.ts"

const SESSION_ID = "909bc46b64721838"
const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    agentId: 1,
    project: "fmx",
    branch: "main",
    sessionId: SESSION_ID,
    name: null,
    state: "idle",
    attention: null,
    active: false,
    subagents: [],
    ...overrides,
  }
}

test("gives each state its own icon", () => {
  expect(stateIcon("working", null)).toBe("◐")
  expect(stateIcon("done", null)).toBe("✓")
  expect(stateIcon("idle", null)).toBe("○")
  expect(stateIcon("unknown", null)).toBe("·")
})

test("draws state as a step of the ramp, never a hue", () => {
  expect(stateRole("blocked")).toBe("foreground")
  expect(stateRole("done")).toBe("accent")
  expect(stateRole("working")).toBe("dim")
  expect(stateRole("idle")).toBe("dim")
  expect(stateRole("unknown")).toBe("dim")
})

test("sets the blocked glyph bold in the foreground and the done glyph in the accent step", async () => {
  const { setup, list } = await createList(30, 10)
  try {
    list.render(
      buildTree([
        entry({ agentId: 1, state: "blocked", attention: "permission" }),
        entry({ agentId: 2, sessionId: "5a75126ce54edb04", state: "done" }),
      ]),
      26,
    )
    await setup.renderOnce()
    const glyph = (id: number) => {
      const text = setup.renderer.root.findDescendantById(`fmx-session-row-text-agent-${id}`) as TextRenderable
      return text.chunks[1]!
    }
    expect(glyph(1).text).toBe("× ")
    expect(glyph(1).attributes! & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    expect(glyph(1).fg?.toInts().slice(0, 3)).toEqual([238, 238, 238])
    expect(glyph(2).text).toBe("✓ ")
    expect((glyph(2).attributes ?? 0) & TextAttributes.BOLD).toBe(0)
    expect(glyph(2).fg?.toInts().slice(0, 3)).toEqual([208, 208, 208])
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("keeps the active row legible when a light host answers under the startup lock", async () => {
  const { setup, list } = await createList(30, 10)
  const light: TerminalColors = {
    palette: Array(16).fill(null),
    defaultForeground: "#1c1c1c",
    defaultBackground: "#ffffff",
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
  const rows = () => {
    const active = setup.renderer.root.findDescendantById("fmx-session-row-agent-1") as BoxRenderable
    const activeText = setup.renderer.root.findDescendantById("fmx-session-row-text-agent-1") as TextRenderable
    const otherText = setup.renderer.root.findDescendantById("fmx-session-row-text-agent-2") as TextRenderable
    return {
      fill: active.backgroundColor.toInts().slice(0, 3),
      activeGlyph: activeText.chunks[1]!.fg?.toInts().slice(0, 3),
      otherGlyph: otherText.chunks[1]!.fg?.toInts().slice(0, 3),
    }
  }
  const tree = buildTree([
    entry({ agentId: 1, state: "blocked", attention: "permission", active: true }),
    entry({ agentId: 2, sessionId: "5a75126ce54edb04", state: "blocked", attention: "permission" }),
  ])
  try {
    // Nothing answered before first paint: the fallback tier, then locked.
    list.applyPalette(null)
    list.render(tree, 26)
    await setup.renderOnce()
    expect(rows()).toEqual({ fill: [53, 53, 53], activeGlyph: [238, 238, 238], otherGlyph: [238, 238, 238] })

    // The late answer restyles the other rows but not the fill, and what
    // sits on the fill stays painted from the fill's own ramp.
    list.applyPalette(light, true)
    list.render(tree, 26)
    await setup.renderOnce()
    expect(rows()).toEqual({ fill: [53, 53, 53], activeGlyph: [238, 238, 238], otherGlyph: [28, 28, 28] })

    // Unlocked, a real theme change moves everything together.
    list.applyPalette(light)
    list.render(tree, 26)
    await setup.renderOnce()
    expect(rows()).toEqual({ fill: [228, 228, 228], activeGlyph: [28, 28, 28], otherGlyph: [28, 28, 28] })
    expect(RAMP_FALLBACK.surface).toBe("#353535")
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("varies the blocked icon by what fx is waiting for", () => {
  expect(stateIcon("blocked", "permission")).toBe("×")
  expect(stateIcon("blocked", "question")).toBe("?")
  expect(stateIcon("blocked", "recovery")).toBe("↻")
  expect(stateIcon("blocked", null)).toBe("×")
})

test("fits an agent row inside the default tray", () => {
  const [, , agent] = buildTree([entry()])
  // inset 1 + indent 4 + icon 2 + id 16 = 23 of 26.
  expect(rowText(agent!, 26)).toBe(SESSION_ID)
})

test("cuts a row only at its right-hand end", () => {
  const [project] = buildTree([entry({ project: "agentbrain-worktree" })])
  expect(rowText(project!, 12)).toBe("agentbrain…")
  expect(truncate("agentbrain", 7)).toBe("agentb…")
  expect(truncate("fmx", 7)).toBe("fmx")
})

test("shows a placeholder until fx reports its session", () => {
  const [, , agent] = buildTree([entry({ sessionId: null })])
  expect(rowText(agent!, 26)).toBe("—")
})

test("draws session names in the terminal's gray until the host answers, then in the ramp's dim step", async () => {
  const { setup, list } = await createList(30, 10)
  const palette: TerminalColors = {
    palette: Array.from({ length: 16 }, (_, index) => `#${index.toString(16).repeat(6)}`),
    defaultForeground: "#eeeeee",
    defaultBackground: "#111111",
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
  const sessionColor = () => {
    const text = setup.renderer.root.findDescendantById("fmx-session-row-text-agent-1") as TextRenderable
    return text.chunks.find((chunk) => chunk.text === SESSION_ID)?.fg
  }

  try {
    list.render(buildTree([entry()]), 26)
    expect(sessionColor()?.intent).toBe("indexed")
    expect(sessionColor()?.slot).toBe(8)

    // A late initial answer, with the startup chrome locked, leaves the
    // names as they were drawn.
    list.applyPalette(palette, true)
    list.render(buildTree([entry()]), 26)
    expect(sessionColor()?.intent).toBe("indexed")
    expect(sessionColor()?.slot).toBe(8)

    list.applyPalette(palette)
    list.render(buildTree([entry()]), 26)
    expect(sessionColor()?.intent).not.toBe("indexed")
    expect(sessionColor()?.toInts().slice(0, 3)).toEqual([128, 128, 128])
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("paints the selected row's name in the fill's own primary step", async () => {
  const { setup, list } = await createList(30, 10)
  const nameColor = () => {
    const text = setup.renderer.root.findDescendantById("fmx-session-row-text-agent-1") as TextRenderable
    return text.chunks.find((chunk) => chunk.text === SESSION_ID)?.fg
  }

  try {
    list.render(buildTree([entry({ active: true })]), 26)
    expect(nameColor()?.toInts().slice(0, 3)).toEqual([238, 238, 238])

    list.render(buildTree([entry({ active: false })]), 26)
    expect(nameColor()?.intent).toBe("indexed")
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

async function createList(width: number, height: number) {
  const setup = await createTestRenderer({ width, height })
  const selected: number[] = []
  const list = new SessionList(setup.renderer, (agentId) => selected.push(agentId))
  setup.renderer.root.add(list.root)
  return { setup, list, selected }
}

test("draws the tree and reports clicks on agent rows", async () => {
  const { setup, list, selected } = await createList(30, 10)
  try {
    list.render(
      buildTree([
        entry({ agentId: 1, state: "blocked", attention: "question" }),
        entry({ agentId: 2, sessionId: "5a75126ce54edb04", state: "working", active: true }),
        entry({ agentId: 3, branch: "feat/list", sessionId: "84af73d3e9e42cb1", state: "done" }),
      ]),
      26,
    )
    await setup.renderOnce()

    const frame = setup.captureCharFrame().split("\n")
    expect(frame[0]).toStartWith(" fmx")
    expect(frame[1]).toStartWith("   feat/list")
    expect(frame[2]).toStartWith("     ✓ 84af73d3e9e42cb1")
    expect(frame[3]).toStartWith("   main")
    expect(frame[4]).toStartWith("     ◐ 5a75126ce54edb04")
    expect(frame[5]).toStartWith(`     ? ${SESSION_ID}`)

    const row = setup.renderer.root.findDescendantById("fmx-session-row-agent-3") as BoxRenderable
    await setup.mockMouse.click(row.x + 6, row.y)
    expect(selected).toEqual([3])
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("draws recursive subagent state rows without making them selectable", async () => {
  const { setup, list, selected } = await createList(34, 10)
  try {
    list.render(
      buildTree([
        entry({
          name: "Coordinate the review",
          subagents: [
            {
              sessionId: "child",
              label: "reviewer",
              state: "working",
              attention: null,
              children: [
                {
                  sessionId: "grandchild",
                  label: "test-reader",
                  state: "blocked",
                  attention: "permission",
                  children: [],
                },
              ],
            },
          ],
        }),
      ]),
      30,
    )
    await setup.renderOnce()

    const frame = setup.captureCharFrame().split("\n")
    expect(frame[2]).toStartWith("     ○ Coordinate the review")
    expect(frame[3]).toStartWith("       ◐ reviewer")
    expect(frame[4]).toStartWith("         × test-reader")

    const child = setup.renderer.root.findDescendantById("fmx-session-row-subagent-3") as BoxRenderable
    await setup.mockMouse.click(child.x + 9, child.y)
    expect(selected).toEqual([])
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("hangs an agent with no branch straight off its project", async () => {
  const { setup, list } = await createList(30, 10)
  try {
    list.render(buildTree([entry({ project: "arthack", branch: null, active: true })]), 26)
    await setup.renderOnce()

    // No rung stands in for the branch, so the agent moves up one level
    // rather than sitting under a label naming something that is not there.
    const frame = setup.captureCharFrame().split("\n")
    expect(frame[0]).toStartWith(" arthack")
    expect(frame[1]).toStartWith(`   ○ ${SESSION_ID}`)
    expect(setup.renderer.root.findDescendantById("fmx-session-row-branch-1")).toBeUndefined()
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("selects an agent on mouse-down without starting tray text selection", async () => {
  const { setup, list, selected } = await createList(30, 10)
  try {
    list.render(buildTree([entry()]), 26)
    await setup.renderOnce()

    const row = setup.renderer.root.findDescendantById("fmx-session-row-agent-1") as BoxRenderable
    await setup.mockMouse.pressDown(row.x + 7, row.y)
    expect(selected).toEqual([1])
    expect(setup.renderer.getSelection()).toBeNull()

    await setup.mockMouse.release(row.x + 7, row.y)
    expect(selected).toEqual([1])
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("a click on a project or branch row selects nothing", async () => {
  const { setup, list, selected } = await createList(30, 10)
  try {
    list.render(buildTree([entry()]), 26)
    await setup.renderOnce()
    for (const id of ["fmx-session-row-project-0", "fmx-session-row-branch-1"]) {
      const row = setup.renderer.root.findDescendantById(id) as BoxRenderable
      await setup.mockMouse.click(row.x + 1, row.y)
    }
    expect(selected).toEqual([])
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("fills the active row and nothing else", async () => {
  const { setup, list } = await createList(30, 10)
  try {
    list.render(buildTree([entry({ agentId: 1 }), entry({ agentId: 2, active: true })]), 26)
    await setup.renderOnce()

    const rows = ["project-0", "branch-1", "agent-1", "agent-2"].map(
      (id) => setup.renderer.root.findDescendantById(`fmx-session-row-${id}`) as BoxRenderable,
    )
    const [project, branch, inactive, active] = rows
    // Ancestors are marked by their rails, never by a second background.
    expect(project!.backgroundColor).toEqual(inactive!.backgroundColor)
    expect(branch!.backgroundColor).toEqual(inactive!.backgroundColor)
    expect(active!.backgroundColor).not.toEqual(inactive!.backgroundColor)
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("the indent keeps every row's text aligned", async () => {
  const { setup, list } = await createList(30, 10)
  try {
    list.render(
      buildTree(
        (["blocked", "working", "done", "idle", "unknown"] as const).map((state, index) =>
          entry({ agentId: index + 1, state }),
        ),
      ),
      26,
    )
    await setup.renderOnce()

    // A wide-rendered icon would shift that row's id alone.
    for (const line of setup.captureCharFrame().split("\n").slice(2, 7)) {
      expect(line.slice(7, 23)).toBe(SESSION_ID)
    }
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("mounts the list into the tray", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...agentOptions(),
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    agentSocket: new AgentSocket({ path: `/tmp/fmx-list-test-${process.pid}.sock` }),
  })
  await multiplexer.start()
  await launchAgent(setup)
  try {
    await setup.renderOnce()
    const list = setup.renderer.root.findDescendantById("fmx-session-list") as BoxRenderable
    const tray = setup.renderer.root.findDescendantById("fmx-tray") as BoxRenderable
    expect([list.x, list.width]).toEqual([tray.x, tray.width])
  } finally {
    await multiplexer.shutdown()
  }
})
