import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { AgentSocket } from "../src/agent-socket.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { layoutRow, SessionList, stateIcon, type SessionRow } from "../src/session-list.ts"

const SESSION_ID = "909bc46b64721838"

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    instanceId: 1,
    project: "fmx",
    sessionId: SESSION_ID,
    state: "idle",
    attention: null,
    active: false,
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
  // fx reported blocked without saying why.
  expect(stateIcon("blocked", null)).toBe("×")
})

test("lays a row out inside the default sidebar", () => {
  // icon 1 + gutter 1 + "fmx" 3 + gutter 1 + id 16 = 22 of 26.
  expect(layoutRow(row(), 26)).toEqual({ project: "fmx", session: SESSION_ID })
})

test("cuts the trailing id rather than putting an ellipsis mid-line", () => {
  const narrow = layoutRow(row({ project: "agentbrain" }), 26)
  expect(narrow.project).toBe("agentbrain")
  expect(narrow.session).toBe("909bc46b6472…")
  expect(`${narrow.project} ${narrow.session}`.length + 2).toBeLessThanOrEqual(26)
})

test("gives the ellipsis to the project when it fills the row alone", () => {
  const cramped = layoutRow(row({ project: "agentbrain-worktree" }), 14)
  expect(cramped.project).toBe("agentbrain-…")
  expect(cramped.session).toBe("")
})

test("never leaves an ellipsis anywhere but the end of the row", () => {
  for (const width of [8, 12, 16, 20, 26, 40]) {
    for (const project of ["fmx", "agentbrain", "agentbrain-worktree"]) {
      const laid = layoutRow(row({ project }), width)
      const line = laid.session ? `${laid.project} ${laid.session}` : laid.project
      const ellipsis = line.indexOf("…")
      if (ellipsis !== -1) expect(ellipsis).toBe([...line].length - 1)
    }
  }
})

test("shows a placeholder until fx reports its session", () => {
  expect(layoutRow(row({ sessionId: null }), 26).session).toBe("—")
})

async function createMultiplexer(width: number, height: number) {
  const setup = await createTestRenderer({ width, height })
  const agentSocket = new AgentSocket({ path: `/tmp/fmx-list-test-${process.pid}.sock` })
  const multiplexer = new Multiplexer(setup.renderer, {
    fxPath: "fx",
    cwd: process.cwd(),
    initialFxArgs: [],
    keybindings: resolveKeybindings().keybindings,
    agentSocket,
  })
  const find = (id: string) => setup.renderer.root.findDescendantById(id) as BoxRenderable | undefined
  return { setup, multiplexer, find }
}

test("mounts the list into the sidebar", async () => {
  const { setup, multiplexer, find } = await createMultiplexer(90, 24)
  try {
    await setup.renderOnce()
    const list = find("fmx-session-list")!
    const sidebar = find("fmx-sidebar")!
    expect(list).toBeInstanceOf(BoxRenderable)
    expect([list.x, list.width]).toEqual([sidebar.x, sidebar.width])
  } finally {
    await multiplexer.shutdown()
  }
})

test("renders a row per session, one line tall, and reports clicks", async () => {
  const setup = await createTestRenderer({ width: 30, height: 10 })
  const selected: number[] = []
  const list = new SessionList(setup.renderer, (instanceId) => selected.push(instanceId))
  setup.renderer.root.add(list.root)
  try {
    list.render(
      [
        row({ instanceId: 1, state: "blocked", attention: "question" }),
        row({ instanceId: 2, state: "working", sessionId: "5a75126ce54edb04", active: true }),
        row({ instanceId: 3, state: "done", sessionId: "84af73d3e9e42cb1" }),
      ],
      26,
    )
    await setup.renderOnce()

    const rows = [1, 2, 3].map(
      (id) => setup.renderer.root.findDescendantById(`fmx-session-row-${id}`) as BoxRenderable,
    )
    for (const rendered of rows) expect(rendered.height).toBe(1)

    const frame = setup.captureCharFrame().split("\n")
    // One space of inset before the icon column.
    expect(frame[0]).toStartWith(` ? fmx ${SESSION_ID}`)
    expect(frame[1]).toContain("◐ fmx 5a75126ce54edb04")
    expect(frame[2]).toContain("✓ fmx 84af73d3e9e42cb1")

    await setup.mockMouse.click(rows[2]!.x + 1, rows[2]!.y)
    expect(selected).toEqual([3])
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("shades the active row and nothing else", async () => {
  const setup = await createTestRenderer({ width: 30, height: 10 })
  const list = new SessionList(setup.renderer, () => {})
  setup.renderer.root.add(list.root)
  try {
    list.render([row({ instanceId: 1 }), row({ instanceId: 2, active: true })], 26)
    await setup.renderOnce()

    const inactive = setup.renderer.root.findDescendantById("fmx-session-row-1") as BoxRenderable
    const active = setup.renderer.root.findDescendantById("fmx-session-row-2") as BoxRenderable
    expect(inactive.backgroundColor).not.toEqual(active.backgroundColor)
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})

test("the icon column keeps every row's text aligned", async () => {
  const setup = await createTestRenderer({ width: 30, height: 10 })
  const list = new SessionList(setup.renderer, () => {})
  setup.renderer.root.add(list.root)
  try {
    // Every glyph the list can draw, including the ambiguous-width ones.
    list.render(
      (["blocked", "working", "done", "idle", "unknown"] as const).map((state, index) =>
        row({ instanceId: index + 1, state }),
      ),
      26,
    )
    await setup.renderOnce()

    // A wide-rendered glyph would push "fmx" off column 3 on that row alone.
    for (const line of setup.captureCharFrame().split("\n").slice(0, 5)) {
      expect(line.slice(3, 6)).toBe("fmx")
    }
  } finally {
    list.root.destroy()
    setup.renderer.destroy()
  }
})
