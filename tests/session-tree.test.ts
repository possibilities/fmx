import { expect, test } from "bun:test"
import { buildTree, railsFor, type SessionEntry } from "../src/session-tree.ts"

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    instanceId: 1,
    project: "fmx",
    branch: "main",
    sessionId: "909bc46b64721838",
    state: "idle",
    attention: null,
    active: false,
    ...overrides,
  }
}

function shape(entries: SessionEntry[]): string[] {
  return buildTree(entries).map((row) => `${railsFor(row.depth)}${row.label}`)
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
    "│ main",
    "│ ╎ 909bc46b64721838",
    "│ ╎ 5a75126ce54edb04",
    "│ feat/list",
    "│ ╎ 84af73d3e9e42cb1",
  ])
})

test("keeps several projects apart", () => {
  expect(
    shape([entry({ instanceId: 1 }), entry({ instanceId: 2, project: "fx", branch: "integration" })]),
  ).toEqual(["fmx", "│ main", "│ ╎ 909bc46b64721838", "fx", "│ integration", "│ ╎ 909bc46b64721838"])
})

test("drops the branch rung outside a repository", () => {
  expect(shape([entry({ branch: null })])).toEqual(["fmx", "│ 909bc46b64721838"])
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

test("nothing is on the path when no instance is active", () => {
  expect(buildTree([entry()]).every((row) => !row.onPath)).toBe(true)
})

test("only agent rows carry an instance to select", () => {
  const rows = buildTree([entry({ instanceId: 7 })])
  expect(rows.map((row) => row.instanceId)).toEqual([null, null, 7])
})

test("preserves the order instances were created in", () => {
  const rows = buildTree([
    entry({ instanceId: 3, sessionId: "aaa" }),
    entry({ instanceId: 1, sessionId: "bbb" }),
  ])
  expect(rows.filter((row) => row.kind === "agent").map((row) => row.label)).toEqual(["aaa", "bbb"])
})

test("rails carry a solid project rung and dashed branch rungs", () => {
  expect(railsFor(0)).toBe("")
  expect(railsFor(1)).toBe("│ ")
  expect(railsFor(2)).toBe("│ ╎ ")
})
