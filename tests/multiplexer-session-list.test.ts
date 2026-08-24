import { expect, test } from "bun:test"
import { BoxRenderable, type TerminalColors, TextAttributes, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import { AgentSocket } from "../src/agent-socket.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"
import { rowText, SessionList, stateIcon, truncate } from "../src/session-list.ts"
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
    expect(frame[1]).toStartWith("   main")
    expect(frame[2]).toStartWith(`     ? ${SESSION_ID}`)
    expect(frame[3]).toStartWith("     ◐ 5a75126ce54edb04")
    expect(frame[4]).toStartWith("   feat/list")
    expect(frame[5]).toStartWith("     ✓ 84af73d3e9e42cb1")

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

test("draws an untracked branch between a plain directory and its agent", async () => {
  const { setup, list } = await createList(30, 10)
  try {
    list.render(buildTree([entry({ project: "arthack", branch: null, active: true })]), 26)
    await setup.renderOnce()

    const frame = setup.captureCharFrame().split("\n")
    expect(frame[0]).toStartWith(" arthack")
    expect(frame[1]).toStartWith("   (untracked)")
    expect(frame[2]).toStartWith(`     ○ ${SESSION_ID}`)

    const label = setup.renderer.root.findDescendantById("fmx-session-row-text-branch-1") as TextRenderable
    const untracked = label.chunks.find((chunk) => chunk.text === "(untracked)")!
    expect(untracked.attributes! & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC)
    expect(untracked.attributes! & TextAttributes.BOLD).toBe(0)
    // The fallback tier's secondary step: fx's 250.
    expect(untracked.fg?.toInts().slice(0, 3)).toEqual([188, 188, 188])
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
  multiplexer.start()
  setup.mockInput.pressKey("b", { ctrl: true })
  setup.mockInput.pressKey("c")
  try {
    await setup.renderOnce()
    const list = setup.renderer.root.findDescendantById("fmx-session-list") as BoxRenderable
    const tray = setup.renderer.root.findDescendantById("fmx-tray") as BoxRenderable
    expect([list.x, list.width]).toEqual([tray.x, tray.width])
  } finally {
    await multiplexer.shutdown()
  }
})
