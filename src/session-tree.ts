import type { AgentAttention, DisplayState } from "./agent-registry.ts"

/**
 * Flattening a project → branch → agent tree into the rows the sidebar draws.
 * Pure: no renderer, no colors, no widths.
 */

/** One fx instance as the list knows it, before grouping. */
export type SessionEntry = {
  instanceId: number
  project: string
  /** null when the instance is not in a git worktree. */
  branch: string | null
  sessionId: string | null
  state: DisplayState
  attention: AgentAttention | null
  active: boolean
}

export type TreeRow = {
  kind: "project" | "branch" | "agent"
  depth: number
  label: string
  /** Set on agent rows only. */
  instanceId: number | null
  state: DisplayState
  attention: AgentAttention | null
  active: boolean
  /** The active agent and every ancestor of it: the path through the tree. */
  onPath: boolean
}

/**
 * Group entries into rows, preserving the order instances were created in.
 * A branch level only appears when git gave us one, so an instance outside a
 * repository nests directly under its project rather than under an empty rung.
 */
export function buildTree(entries: SessionEntry[]): TreeRow[] {
  const rows: TreeRow[] = []
  const active = entries.find((entry) => entry.active) ?? null

  for (const [project, projectEntries] of groupBy(entries, (entry) => entry.project)) {
    rows.push({
      kind: "project",
      depth: 0,
      label: project,
      instanceId: null,
      state: "unknown",
      attention: null,
      active: false,
      onPath: active?.project === project,
    })

    for (const [branch, branchEntries] of groupBy(projectEntries, (entry) => entry.branch ?? "")) {
      const depth = branch ? 2 : 1
      if (branch) {
        rows.push({
          kind: "branch",
          depth: 1,
          label: branch,
          instanceId: null,
          state: "unknown",
          attention: null,
          active: false,
          onPath: active?.project === project && active.branch === branch,
        })
      }
      for (const entry of branchEntries) {
        rows.push({
          kind: "agent",
          depth,
          label: entry.sessionId ?? "",
          instanceId: entry.instanceId,
          state: entry.state,
          attention: entry.attention,
          active: entry.active,
          onPath: entry.active,
        })
      }
    }
  }

  return rows
}

/**
 * The rails standing to the left of a row. A solid rail carries the project's
 * children, a dashed one a branch's, so depth reads by texture as well as
 * indentation — and the dashed glyph is one of the few tree characters that is
 * not East-Asian-ambiguous.
 */
export function railsFor(depth: number): string {
  if (depth <= 0) return ""
  return depth === 1 ? "│ " : `│ ${"╎ ".repeat(depth - 1)}`
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
