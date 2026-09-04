import type { LayoutNode, PaneGeometry, Stage } from "./protocol.ts"

/**
 * The Layout engine, pure: a tree of rows and columns is fitted to the stage
 * and every leaf gets a rectangle, every boundary between siblings a
 * one-cell divider. No renderer, no sessions; `stage.ts` draws the answer.
 *
 * Fitting rule: a container's sized children keep their sizes while they
 * fit and every remainder child keeps its `min`; when they do not fit, sized
 * children are squeezed from the last to the first down to their `min`, then
 * remainder children from the last to the first down to nothing. Remainder
 * children share what is left equally, the first ones taking the odd cells.
 * A child squeezed to nothing is not drawn and its divider goes with it.
 */

export type Rect = { x: number; y: number; cols: number; rows: number }

export type FittedLeaf = {
  /** The path of child indexes from the root; the leaf's identity across fits. */
  path: string
  node: LayoutNode
  rect: Rect
}

export type Axis = "row" | "column"

export type FittedDivider = {
  /** `<container path>:<index>`: the divider after child `index`. */
  id: string
  axis: Axis
  rect: Rect
}

export type FittedLayout = {
  leaves: FittedLeaf[]
  dividers: FittedDivider[]
}

const DIVIDER = 1

export function fitLayout(root: LayoutNode | null, stage: Stage): FittedLayout {
  const fitted: FittedLayout = { leaves: [], dividers: [] }
  if (root === null) return fitted
  place(root, "", { x: 0, y: 0, cols: Math.max(0, stage.cols), rows: Math.max(0, stage.rows) }, fitted)
  return fitted
}

function place(node: LayoutNode, path: string, rect: Rect, fitted: FittedLayout): void {
  const children = containerChildren(node)
  if (children === null) {
    fitted.leaves.push({ path, node, rect })
    return
  }
  const axis: Axis = "row" in node ? "row" : "column"
  const length = axis === "row" ? rect.cols : rect.rows
  const lengths = fitLengths(children, length)
  let cursor = axis === "row" ? rect.x : rect.y
  let drawn = 0
  for (const [index, child] of children.entries()) {
    const size = lengths[index]!
    if (size === 0) continue
    if (drawn > 0) {
      fitted.dividers.push({
        id: `${path}:${index - 1}`,
        axis,
        rect: axis === "row" ? { x: cursor, y: rect.y, cols: DIVIDER, rows: rect.rows } : { x: rect.x, y: cursor, cols: rect.cols, rows: DIVIDER },
      })
      cursor += DIVIDER
    }
    const childRect: Rect =
      axis === "row" ? { x: cursor, y: rect.y, cols: size, rows: rect.rows } : { x: rect.x, y: cursor, cols: rect.cols, rows: size }
    place(child, path === "" ? String(index) : `${path}/${index}`, childRect, fitted)
    cursor += size
    drawn += 1
  }
}

function containerChildren(node: LayoutNode): LayoutNode[] | null {
  if ("row" in node) return node.row
  if ("column" in node) return node.column
  return null
}

/** How long each child is along the container's axis; 0 is squeezed out. */
export function fitLengths(children: readonly LayoutNode[], length: number): number[] {
  const count = children.length
  const sized = children.map((child) => child.size !== undefined)
  const mins = children.map((child) => Math.max(1, child.min ?? 1))
  const wants = children.map((child, index) => (sized[index] ? Math.max(child.size!, mins[index]!) : mins[index]!))
  // Try to keep every child; give up children from the last one when even
  // their minimums and dividers cannot fit.
  for (let kept = count; kept >= 1; kept -= 1) {
    const available = length - DIVIDER * (kept - 1)
    if (available < 0) continue
    const lengths = fitKept(wants.slice(0, kept), mins.slice(0, kept), sized.slice(0, kept), available)
    if (lengths === null) continue
    while (lengths.length < count) lengths.push(0)
    return lengths
  }
  return children.map(() => 0)
}

function fitKept(wants: number[], mins: number[], sized: boolean[], available: number): number[] | null {
  const lengths = [...wants]
  let need = lengths.reduce((sum, value) => sum + value, 0)
  // Squeeze sized children from the last down to their minimums.
  for (let index = lengths.length - 1; index >= 0 && need > available; index -= 1) {
    if (!sized[index]) continue
    const give = Math.min(lengths[index]! - mins[index]!, need - available)
    lengths[index]! -= give
    need -= give
  }
  if (need > available) return null
  const remainder = lengths.map((_, index) => !sized[index])
  const remainderCount = remainder.filter(Boolean).length
  let leftover = available - need
  if (remainderCount > 0) {
    const share = Math.floor(leftover / remainderCount)
    let extra = leftover - share * remainderCount
    for (let index = 0; index < lengths.length; index += 1) {
      if (!remainder[index]) continue
      lengths[index]! += share + (extra > 0 ? 1 : 0)
      if (extra > 0) extra -= 1
    }
  } else if (lengths.length > 0) {
    // Nothing elastic: the last child absorbs the rest so no cell is unowned.
    lengths[lengths.length - 1]! += leftover
  }
  return lengths
}

/** Fitted leaves as the API reports them. */
export function paneGeometries(fitted: FittedLayout, focus: string | null): PaneGeometry[] {
  return fitted.leaves.map((leaf) => ({
    session: "session" in leaf.node ? leaf.node.session : null,
    text: "text" in leaf.node ? leaf.node.text : null,
    x: leaf.rect.x,
    y: leaf.rect.y,
    cols: leaf.rect.cols,
    rows: leaf.rect.rows,
    focused: "session" in leaf.node && leaf.node.session === focus,
  }))
}

/** Every Session name a tree shows. */
export function layoutSessions(root: LayoutNode | null): string[] {
  const names: string[] = []
  const visit = (node: LayoutNode): void => {
    if ("session" in node) names.push(node.session)
    for (const child of containerChildren(node) ?? []) visit(child)
  }
  if (root) visit(root)
  return names
}

/**
 * A divider drag: move the boundary after `index` in the container at
 * `containerPath` by `delta` cells. The sized child beside the divider
 * changes — the one before it, or the one after — and neither side may drop
 * below its minimum. Two remainder children have no size to change.
 * Returns the new tree, or null when nothing can move.
 */
export function dragDivider(
  root: LayoutNode,
  dividerId: string,
  delta: number,
  stage: Stage,
): LayoutNode | null {
  const separator = dividerId.lastIndexOf(":")
  if (separator === -1) return null
  const containerPath = dividerId.slice(0, separator)
  const index = Number(dividerId.slice(separator + 1))
  if (!Number.isInteger(index) || index < 0) return null
  const copy = cloneNode(root)
  const container = nodeAt(copy, containerPath)
  const children = container ? containerChildren(container) : null
  if (!children || index + 1 >= children.length) return null

  const before = children[index]!
  const after = children[index + 1]!
  const fitted = fitLayout(copy, stage)
  const axis: Axis = container && "row" in container ? "row" : "column"
  const extent = (child: LayoutNode, childPath: string): number => {
    const own = fitted.leaves.find((leaf) => leaf.path === childPath || leaf.path.startsWith(`${childPath}/`))
    if (!own) return 0
    // A container's extent along the axis is the union of its leaves.
    const leaves = fitted.leaves.filter((leaf) => leaf.path === childPath || leaf.path.startsWith(`${childPath}/`))
    const start = Math.min(...leaves.map((leaf) => (axis === "row" ? leaf.rect.x : leaf.rect.y)))
    const end = Math.max(...leaves.map((leaf) => (axis === "row" ? leaf.rect.x + leaf.rect.cols : leaf.rect.y + leaf.rect.rows)))
    return child === undefined ? 0 : end - start
  }
  const beforePath = containerPath === "" ? String(index) : `${containerPath}/${index}`
  const afterPath = containerPath === "" ? String(index + 1) : `${containerPath}/${index + 1}`
  const beforeLength = extent(before, beforePath)
  const afterLength = extent(after, afterPath)
  const beforeMin = Math.max(1, before.min ?? 1)
  const afterMin = Math.max(1, after.min ?? 1)
  const pair = beforeLength + afterLength

  if (before.size !== undefined) {
    const next = clamp(beforeLength + delta, beforeMin, Math.max(beforeMin, pair - afterMin))
    if (next === beforeLength) return null
    before.size = next
    return copy
  }
  if (after.size !== undefined) {
    const next = clamp(afterLength - delta, afterMin, Math.max(afterMin, pair - beforeMin))
    if (next === afterLength) return null
    after.size = next
    return copy
  }
  return null
}

function nodeAt(root: LayoutNode, path: string): LayoutNode | null {
  if (path === "") return root
  let node: LayoutNode = root
  for (const part of path.split("/")) {
    const children = containerChildren(node)
    const child = children?.[Number(part)]
    if (!child) return null
    node = child
  }
  return node
}

function cloneNode(node: LayoutNode): LayoutNode {
  if ("row" in node) return { ...node, row: node.row.map(cloneNode) }
  if ("column" in node) return { ...node, column: node.column.map(cloneNode) }
  return { ...node }
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}
