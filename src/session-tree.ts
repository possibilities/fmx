import type { AgentAttention, DisplayState } from "./agent-registry.ts"
import { UNTRACKED_TREE_NAME } from "./git-context.ts"
import type { SubagentEntry } from "./subagents.ts"

/**
 * Flattening a project → branch → agent tree into the rows the tray draws.
 * Pure: no renderer, no colors, no widths.
 */

/** One fx agent as the list knows it, before grouping. */
export type SessionEntry = {
  agentId: number
  project: string
  /** null when the agent is not in a git worktree. */
  branch: string | null
  sessionId: string | null
  /** Fx's native session name, once it has one. The row falls back to the
   * short session id until then. */
  name: string | null
  state: DisplayState
  attention: AgentAttention | null
  active: boolean
  /** Filesystem-discovered fx children, already ordered and nested. */
  subagents: SubagentEntry[]
}

export type TreeRow = {
  kind: "project" | "branch" | "agent" | "subagent"
  depth: number
  label: string
  /** Set only on selectable agent rows; subagents have no Agent to switch to. */
  agentId: number | null
  state: DisplayState
  attention: AgentAttention | null
  active: boolean
  /** The active agent and every ancestor of it: the path through the tree. */
  onPath: boolean
  /** True only for a synthetic grouping row rather than repository data. */
  virtual: boolean
}

/**
 * Group entries into rows, newest agent first. Creation order is reversed
 * before grouping, so a project or branch sorts by its newest agent and the
 * newest agent stands at the top of its branch. Nothing else — state,
 * attention, activity — moves a row. Agents outside a repository keep the
 * same project → branch → agent shape through a virtual `(untracked)`
 * branch.
 */
export function buildTree(entries: SessionEntry[]): TreeRow[] {
  const rows: TreeRow[] = []
  const active = entries.find((entry) => entry.active) ?? null
  const newestFirst = [...entries].reverse()

  for (const [project, projectEntries] of groupBy(newestFirst, (entry) => entry.project)) {
    rows.push({
      kind: "project",
      depth: 0,
      label: project,
      agentId: null,
      state: "unknown",
      attention: null,
      active: false,
      onPath: active?.project === project,
      virtual: false,
    })

    for (const [branch, branchEntries] of groupBy(projectEntries, (entry) => entry.branch)) {
      rows.push({
        kind: "branch",
        depth: 1,
        label: branch ?? UNTRACKED_TREE_NAME,
        agentId: null,
        state: "unknown",
        attention: null,
        active: false,
        onPath: active?.project === project && active.branch === branch,
        virtual: branch === null,
      })
      for (const entry of branchEntries) {
        rows.push({
          kind: "agent",
          depth: 2,
          label: entry.name ?? entry.sessionId ?? "",
          agentId: entry.agentId,
          state: entry.state,
          attention: entry.attention,
          active: entry.active,
          onPath: entry.active,
          virtual: false,
        })
        appendSubagents(rows, entry.subagents, 3)
      }
    }
  }

  return rows
}

function appendSubagents(rows: TreeRow[], subagents: SubagentEntry[], depth: number): void {
  for (const subagent of subagents) {
    rows.push({
      kind: "subagent",
      depth,
      label: subagent.label,
      agentId: null,
      state: subagent.state,
      attention: subagent.attention,
      active: false,
      onPath: false,
      virtual: false,
    })
    appendSubagents(rows, subagent.children, depth + 1)
  }
}

/**
 * The blank space standing to the left of a row. Depth is carried by
 * indentation alone — no connecting glyphs — which costs the same columns as
 * rails did and leaves nothing that can render double-width.
 */
export function indentFor(depth: number): string {
  return "  ".repeat(Math.max(0, depth))
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const existing = groups.get(key(item))
    if (existing) existing.push(item)
    else groups.set(key(item), [item])
  }
  return groups
}
