import { expect, test } from "bun:test"
import { buildTree, indentFor, type SessionEntry } from "../src/session-tree.ts"

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    agentId: 1,
    project: "fmx",
    branch: "main",
    sessionId: "909bc46b64721838",
    name: null,
    state: "idle",
    attention: null,
    active: false,
    subagents: [],
    ...overrides,
  }
}

function shape(entries: SessionEntry[]): string[] {
  return buildTree(entries).map((row) => `${indentFor(row.depth)}${row.label}`)
}

test("nests agents under their branch and project", () => {
  expect(
    shape([
      entry({ agentId: 1, sessionId: "909bc46b64721838" }),
      entry({ agentId: 2, sessionId: "5a75126ce54edb04" }),
      entry({ agentId: 3, branch: "feat/list", sessionId: "84af73d3e9e42cb1" }),
    ]),
  ).toEqual([
    "fmx",
    "  feat/list",
    "    84af73d3e9e42cb1",
    "  main",
    "    5a75126ce54edb04",
    "    909bc46b64721838",
  ])
})

test("keeps several projects apart", () => {
  expect(
    shape([entry({ agentId: 1 }), entry({ agentId: 2, project: "fx", branch: "integration" })]),
  ).toEqual(["fx", "  integration", "    909bc46b64721838", "fmx", "  main", "    909bc46b64721838"])
})

test("hangs an agent git has no answer for straight off its project", () => {
  expect(shape([entry({ branch: null })])).toEqual(["fmx", "  909bc46b64721838"])
})

test("nests the subagents of a branchless agent one rung shallower too", () => {
  const rows = buildTree([
    entry({
      branch: null,
      subagents: [
        { sessionId: "child", label: "reviewer", state: "working", attention: null, children: [] },
      ],
    }),
  ])
  expect(rows.map((row) => [row.kind, row.depth, row.label])).toEqual([
    ["project", 0, "fmx"],
    ["agent", 1, "909bc46b64721838"],
    ["subagent", 2, "reviewer"],
  ])
})

test("marks the active agent and every ancestor of it", () => {
  const rows = buildTree([
    entry({ agentId: 1 }),
    entry({ agentId: 2, branch: "feat/list", active: true }),
  ])
  expect(rows.map((row) => [row.kind, row.onPath])).toEqual([
    ["project", true],
    ["branch", true],
    ["agent", true],
    ["branch", false],
    ["agent", false],
  ])
})

test("marks the project of a branchless active agent as part of the path", () => {
  const rows = buildTree([entry({ branch: null, active: true })])
  expect(rows.map((row) => [row.label, row.onPath])).toEqual([
    ["fmx", true],
    ["909bc46b64721838", true],
  ])
})

test("nothing is on the path when no agent is active", () => {
  expect(buildTree([entry()]).every((row) => !row.onPath)).toBe(true)
})

test("only selectable agent rows carry an agent", () => {
  const rows = buildTree([
    entry({
      agentId: 7,
      subagents: [
        { sessionId: "child", label: "reviewer", state: "working", attention: null, children: [] },
      ],
    }),
  ])
  expect(rows.map((row) => row.agentId)).toEqual([null, null, 7, null])
})

test("shows agents newest first, whatever their state", () => {
  const rows = buildTree([
    entry({ agentId: 3, sessionId: "aaa", state: "working" }),
    entry({ agentId: 1, sessionId: "bbb", state: "done" }),
  ])
  expect(rows.filter((row) => row.kind === "agent").map((row) => row.label)).toEqual(["bbb", "aaa"])
})

test("sorts a project and branch by its newest agent", () => {
  expect(
    shape([
      entry({ agentId: 1, project: "fx", branch: "integration", sessionId: "aaa" }),
      entry({ agentId: 2, sessionId: "bbb" }),
      entry({ agentId: 3, project: "fx", branch: "integration", sessionId: "ccc" }),
    ]),
  ).toEqual(["fx", "  integration", "    ccc", "    aaa", "fmx", "  main", "    bbb"])
})

test("indents two columns per level, with nothing that can render wide", () => {
  expect(indentFor(0)).toBe("")
  expect(indentFor(1)).toBe("  ")
  expect(indentFor(2)).toBe("    ")
})

test("a named session shows its native name in place of its id", () => {
  expect(
    shape([
      entry({ agentId: 1, name: "Name every agent" }),
      entry({ agentId: 2, sessionId: "5a75126ce54edb04" }),
    ]),
  ).toEqual(["fmx", "  main", "    5a75126ce54edb04", "    Name every agent"])
})

test("nests subagents recursively beneath their parent agent", () => {
  const rows = buildTree([
    entry({
      name: "Coordinate the review",
      subagents: [
        {
          sessionId: "child-a",
          label: "reviewer",
          state: "working",
          attention: null,
          children: [
            {
              sessionId: "grandchild",
              label: "test-reader",
              state: "idle",
              attention: null,
              children: [],
            },
          ],
        },
        {
          sessionId: "child-b",
          label: "docs-reader",
          state: "blocked",
          attention: "permission",
          children: [],
        },
      ],
    }),
  ])

  expect(rows.map((row) => [row.kind, row.depth, row.label])).toEqual([
    ["project", 0, "fmx"],
    ["branch", 1, "main"],
    ["agent", 2, "Coordinate the review"],
    ["subagent", 3, "reviewer"],
    ["subagent", 4, "test-reader"],
    ["subagent", 3, "docs-reader"],
  ])
  expect(rows.slice(3).every((row) => !row.active && !row.onPath && row.agentId === null)).toBe(true)
})
