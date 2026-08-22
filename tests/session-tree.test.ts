import { expect, test } from "bun:test"
import { buildTree, indentFor, type SessionEntry } from "../src/session-tree.ts"

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    instanceId: 1,
    project: "fmx",
    branch: "main",
    sessionId: "909bc46b64721838",
    slug: null,
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
      entry({ instanceId: 1, sessionId: "909bc46b64721838" }),
      entry({ instanceId: 2, sessionId: "5a75126ce54edb04" }),
      entry({ instanceId: 3, branch: "feat/list", sessionId: "84af73d3e9e42cb1" }),
    ]),
  ).toEqual([
    "fmx",
    "  main",
    "    909bc46b64721838",
    "    5a75126ce54edb04",
    "  feat/list",
    "    84af73d3e9e42cb1",
  ])
})

test("keeps several projects apart", () => {
  expect(
    shape([entry({ instanceId: 1 }), entry({ instanceId: 2, project: "fx", branch: "integration" })]),
  ).toEqual(["fmx", "  main", "    909bc46b64721838", "fx", "  integration", "    909bc46b64721838"])
})

test("nests agents outside a repository under an untracked branch", () => {
  expect(shape([entry({ branch: null })])).toEqual(["fmx", "  (untracked)", "    909bc46b64721838"])
})

test("marks the active agent and every ancestor of it", () => {
  const rows = buildTree([
    entry({ instanceId: 1 }),
    entry({ instanceId: 2, branch: "feat/list", active: true }),
  ])
  expect(rows.map((row) => [row.kind, row.onPath])).toEqual([
    ["project", true],
    ["branch", false],
    ["agent", false],
    ["branch", true],
    ["agent", true],
  ])
})

test("marks the untracked branch as part of the active path", () => {
  const rows = buildTree([entry({ branch: null, active: true })])
  expect(rows.map((row) => [row.label, row.onPath])).toEqual([
    ["fmx", true],
    ["(untracked)", true],
    ["909bc46b64721838", true],
  ])
})

test("nothing is on the path when no instance is active", () => {
  expect(buildTree([entry()]).every((row) => !row.onPath)).toBe(true)
})

test("only selectable agent rows carry an instance", () => {
  const rows = buildTree([
    entry({
      instanceId: 7,
      subagents: [
        { sessionId: "child", label: "reviewer", state: "working", attention: null, children: [] },
      ],
    }),
  ])
  expect(rows.map((row) => row.instanceId)).toEqual([null, null, 7, null])
})

test("preserves the order instances were created in", () => {
  const rows = buildTree([
    entry({ instanceId: 3, sessionId: "aaa" }),
    entry({ instanceId: 1, sessionId: "bbb" }),
  ])
  expect(rows.filter((row) => row.kind === "agent").map((row) => row.label)).toEqual(["aaa", "bbb"])
})

test("indents two columns per level, with nothing that can render wide", () => {
  expect(indentFor(0)).toBe("")
  expect(indentFor(1)).toBe("  ")
  expect(indentFor(2)).toBe("    ")
})

test("a named session shows its slug in place of its id", () => {
  expect(
    shape([
      entry({ instanceId: 1, slug: "name-every-instance" }),
      entry({ instanceId: 2, sessionId: "5a75126ce54edb04" }),
    ]),
  ).toEqual(["fmx", "  main", "    name-every-instance", "    5a75126ce54edb04"])
})

test("nests subagents recursively beneath their parent agent", () => {
  const rows = buildTree([
    entry({
      slug: "coordinate-the-review",
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
    ["agent", 2, "coordinate-the-review"],
    ["subagent", 3, "reviewer"],
    ["subagent", 4, "test-reader"],
    ["subagent", 3, "docs-reader"],
  ])
  expect(rows.slice(3).every((row) => !row.active && !row.onPath && row.instanceId === null)).toBe(true)
})
