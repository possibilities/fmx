import type { LayoutNode, PaneGeometry, Stage } from "./protocol.ts"

/**
 * The Layout engine, pure: a tree of rows and columns is fitted to the stage
 * and every leaf gets a rectangle, every boundary between siblings a
 * one-cell divider. No renderer, no sessions; `stage.ts` draws the answer.
 *
 * Fitting rule: a container's sized children keep their sizes while they
 * fit and every remainder child keeps its `min`; when they do not fit, sized
 * children are squeezed from the last to the first down to their `min`, then
 * children are dropped from the last until what remains fits — by position,
 * whatever their kind, so a trailing fixed child goes before a leading
 * elastic one. Remainder children share what is left equally, the first ones
 * taking the odd cells.
 *
 * A container's own floor is whatever its subtree needs, so a container is
 * never handed fewer cells than it can draw in: a band of the stage that
 * nothing could appear in is worse than one Pane fewer.
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
  const lengths = fitLengths(children, length, axis)
  let cursor = axis === "row" ? rect.x : rect.y
  let drawn = 0
  for (const [index, child] of children.entries()) {
    const size = lengths[index]!
    const childPath = path === "" ? String(index) : `${path}/${index}`
    if (size === 0) {
      // A Pane the fit squeezed out is still a Pane the caller wrote, and the
      // contract reports it at zero rather than dropping it from the list.
      collapse(child, childPath, axis === "row" ? { ...rect, x: cursor, cols: 0 } : { ...rect, y: cursor, rows: 0 }, fitted)
      continue
    }
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
    place(child, childPath, childRect, fitted)
    cursor += size
    drawn += 1
  }
}

/** Report a squeezed-out subtree's leaves at zero, in tree order. */
function collapse(node: LayoutNode, path: string, rect: Rect, fitted: FittedLayout): void {
  const children = containerChildren(node)
  if (children === null) {
    fitted.leaves.push({ path, node, rect: { ...rect, cols: 0, rows: 0 } })
    return
  }
  for (const [index, child] of children.entries()) {
    collapse(child, path === "" ? String(index) : `${path}/${index}`, rect, fitted)
  }
}

function containerChildren(node: LayoutNode): LayoutNode[] | null {
  if ("row" in node) return node.row
  if ("column" in node) return node.column
  return null
}

/**
 * The smallest length a node can be drawn in along `axis`. A leaf answers its
 * own `min`; a container answers what its children need, which is their sum
 * plus dividers along its own axis and their largest across it.
 */
export function requiredLength(node: LayoutNode, axis: Axis): number {
  const declared = Math.max(1, node.min ?? 1)
  const children = containerChildren(node)
  if (children === null) return declared
  const own: Axis = "row" in node ? "row" : "column"
  const parts = children.map((child) => requiredLength(child, axis))
  const needed =
    own === axis
      ? parts.reduce((sum, value) => sum + value, 0) + DIVIDER * (children.length - 1)
      : Math.max(...parts)
  return Math.max(declared, needed)
}

/** How long each child is along the container's axis; 0 is squeezed out. */
export function fitLengths(children: readonly LayoutNode[], length: number, axis: Axis = "row"): number[] {
  const count = children.length
  const sized = children.map((child) => child.size !== undefined)
  const mins = children.map((child) => requiredLength(child, axis))
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
  const leftover = available - need
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
  // A tree may name one Session twice, and only one Pane can hold the
  // keyboard: the last drawn one, which is the one `Stage.draw` leaves the
  // renderable at.
  const drawnFocus = fitted.leaves.reduce(
    (last, leaf, index) =>
      "session" in leaf.node && leaf.node.session === focus && leaf.rect.cols > 0 && leaf.rect.rows > 0 ? index : last,
    -1,
  )
  return fitted.leaves.map((leaf, index) => ({
    session: "session" in leaf.node ? leaf.node.session : null,
    text: "text" in leaf.node ? leaf.node.text : null,
    x: leaf.rect.x,
    y: leaf.rect.y,
    cols: leaf.rect.cols,
    rows: leaf.rect.rows,
    focused: index === drawnFocus,
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
 * A divider drag: put the boundary after `index` in the container at
 * `containerPath` `delta` cells from where it is.
 *
 * A drag changes only the two children the boundary lies between. Changing
 * one of them by `delta` is not the same as moving the boundary by `delta`,
 * because a remainder sibling absorbs from the same pool: adjust the child
 * before the divider while a remainder also precedes it and the boundary
 * stays put while a different one walks the other way. So each way of
 * spending the drag is measured against the real fit, and the one that lands
 * the boundary wins.
 *
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
  const container = nodeAt(root, containerPath)
  const children = container ? containerChildren(container) : null
  if (!children || index + 1 >= children.length) return null
  if (delta === 0) return null

  const axis: Axis = container && "row" in container ? "row" : "column"
  const from = boundaryOf(root, dividerId, axis, stage)
  if (from === null) return null
  const target = from + delta

  const fitted = fitLayout(root, stage)
  const beforeLength = extentOf(fitted, childPathOf(containerPath, index), axis)
  const afterLength = extentOf(fitted, childPathOf(containerPath, index + 1), axis)
  const beforeSized = children[index]!.size !== undefined
  const afterSized = children[index + 1]!.size !== undefined
  const beforeFloor = requiredLength(children[index]!, axis)
  const afterFloor = requiredLength(children[index + 1]!, axis)

  const candidates: LayoutNode[] = []
  if (beforeSized && afterSized) {
    // Both fixed: move cells straight across, so every other child — elastic
    // or not — keeps exactly what it had.
    const room = Math.min(delta > 0 ? afterLength - afterFloor : beforeLength - beforeFloor, Math.abs(delta))
    if (room > 0) {
      const step = delta > 0 ? room : -room
      candidates.push(
        withSizes(root, containerPath, [
          [index, beforeLength + step],
          [index + 1, afterLength - step],
        ]),
      )
    }
  }
  // Otherwise spend the drag on whichever adjacent child is fixed. Both are
  // tried, because which one actually moves the boundary depends on where the
  // elastic children are. When neither is fixed the boundary is only implied
  // by the remainder split, so pin one side to where the drag put it — the
  // other stays elastic and keeps absorbing the stage.
  if (beforeSized || !afterSized) {
    candidates.push(withSizes(root, containerPath, [[index, Math.max(beforeFloor, beforeLength + delta)]]))
  }
  if (afterSized || !beforeSized) {
    candidates.push(withSizes(root, containerPath, [[index + 1, Math.max(afterFloor, afterLength - delta)]]))
  }
  if (candidates.length === 0) return null

  let best: { tree: LayoutNode; distance: number } | null = null
  for (const candidate of candidates) {
    const landed = boundaryOf(candidate, dividerId, axis, stage)
    if (landed === null || landed === from) continue
    const distance = Math.abs(landed - target)
    if (best === null || distance < best.distance) best = { tree: candidate, distance }
    if (distance === 0) break
  }
  return best?.tree ?? null
}

/** Where a divider sits along its axis in a given tree, or null when it is not drawn. */
function boundaryOf(root: LayoutNode, dividerId: string, axis: Axis, stage: Stage): number | null {
  const divider = fitLayout(root, stage).dividers.find((candidate) => candidate.id === dividerId)
  if (!divider) return null
  return axis === "row" ? divider.rect.x : divider.rect.y
}

/** How much of the axis a child occupies, including anything nested in it. */
function extentOf(fitted: FittedLayout, path: string, axis: Axis): number {
  const leaves = fitted.leaves.filter(
    (leaf) => (leaf.path === path || leaf.path.startsWith(`${path}/`)) && leaf.rect.cols > 0 && leaf.rect.rows > 0,
  )
  if (leaves.length === 0) return 0
  const start = Math.min(...leaves.map((leaf) => (axis === "row" ? leaf.rect.x : leaf.rect.y)))
  const end = Math.max(...leaves.map((leaf) => (axis === "row" ? leaf.rect.x + leaf.rect.cols : leaf.rect.y + leaf.rect.rows)))
  return end - start
}

function childPathOf(containerPath: string, index: number): string {
  return containerPath === "" ? String(index) : `${containerPath}/${index}`
}

function withSizes(root: LayoutNode, containerPath: string, sizes: [number, number][]): LayoutNode {
  const copy = cloneNode(root)
  const children = containerChildren(nodeAt(copy, containerPath)!)!
  for (const [index, size] of sizes) children[index] = { ...children[index]!, size: Math.max(1, size) }
  return copy
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
