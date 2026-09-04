import { describe, expect, test } from "bun:test"
import { dragDivider, fitLayout, fitLengths, layoutSessions, paneGeometries } from "../src/layout.ts"
import type { LayoutNode } from "../src/protocol.ts"

const stage = { cols: 100, rows: 30 }

/** agentmux's shape: a left stack, a dock, the agents pane, a right panel. */
const sixPanels: LayoutNode = {
  row: [
    {
      column: [
        { text: "top drawer", size: 8, min: 3 },
        { session: "tray" },
        { text: "bottom drawer", size: 8, min: 3 },
      ],
      size: 26,
      min: 24,
    },
    { session: "dock", size: 20, min: 10 },
    { session: "reviewer", min: 20 },
    { session: "notes", size: 20, min: 10 },
  ],
}

describe("fitLengths", () => {
  test("sized children keep their size and remainder children share the rest", () => {
    expect(fitLengths([{ session: "a", size: 26 }, { session: "b" }, { session: "c" }], 100)).toEqual([26, 36, 36])
  })

  test("odd cells go to the first remainder children", () => {
    expect(fitLengths([{ session: "a" }, { session: "b" }, { session: "c" }], 20)).toEqual([6, 6, 6])
    expect(fitLengths([{ session: "a" }, { session: "b" }, { session: "c" }], 22)).toEqual([7, 7, 6])
  })

  test("with nothing elastic the last child absorbs the leftover", () => {
    expect(fitLengths([{ session: "a", size: 10 }, { session: "b", size: 10 }], 50)).toEqual([10, 39])
  })

  test("sized children are squeezed from the last to the first down to their minimums", () => {
    expect(
      fitLengths(
        [
          { session: "left", size: 26, min: 24 },
          { session: "dock", size: 40, min: 10 },
          { session: "main", min: 20 },
          { session: "right", size: 40, min: 10 },
        ],
        80,
      ),
    ).toEqual([26, 21, 20, 10])
  })

  test("children that cannot fit at all are dropped from the last, dividers with them", () => {
    expect(fitLengths([{ session: "a", min: 5 }, { session: "b", min: 5 }, { session: "c", min: 5 }], 8)).toEqual([8, 0, 0])
    expect(fitLengths([{ session: "a", size: 4 }, { session: "b", size: 4 }], 9)).toEqual([4, 4])
    expect(fitLengths([{ session: "a", size: 4 }, { session: "b", size: 4 }], 8)).toEqual([4, 3])
    expect(fitLengths([{ session: "a", size: 4, min: 4 }, { session: "b", size: 4, min: 4 }], 8)).toEqual([8, 0])
  })

  test("an empty stage draws nothing", () => {
    expect(fitLengths([{ session: "a" }], 0)).toEqual([0])
  })
})

describe("fitLayout", () => {
  test("nests columns inside rows with one-cell dividers between siblings", () => {
    const fitted = fitLayout(sixPanels, stage)
    const rects = Object.fromEntries(fitted.leaves.map((leaf) => [leaf.path, leaf.rect]))
    expect(rects["0/0"]).toEqual({ x: 0, y: 0, cols: 26, rows: 8 })
    expect(rects["0/1"]).toEqual({ x: 0, y: 9, cols: 26, rows: 12 })
    expect(rects["0/2"]).toEqual({ x: 0, y: 22, cols: 26, rows: 8 })
    expect(rects["1"]).toEqual({ x: 27, y: 0, cols: 20, rows: 30 })
    expect(rects["2"]).toEqual({ x: 48, y: 0, cols: 31, rows: 30 })
    expect(rects["3"]).toEqual({ x: 80, y: 0, cols: 20, rows: 30 })
    expect(fitted.dividers.map((divider) => [divider.id, divider.axis, divider.rect.x, divider.rect.y])).toEqual([
      ["0:0", "column", 0, 8],
      ["0:1", "column", 0, 21],
      [":0", "row", 26, 0],
      [":1", "row", 47, 0],
      [":2", "row", 79, 0],
    ])
  })

  test("a single leaf takes the whole stage", () => {
    const fitted = fitLayout({ session: "only" }, stage)
    expect(fitted.leaves).toHaveLength(1)
    expect(fitted.leaves[0]!.rect).toEqual({ x: 0, y: 0, cols: 100, rows: 30 })
    expect(fitted.dividers).toEqual([])
  })

  test("no layout fits to nothing", () => {
    expect(fitLayout(null, stage)).toEqual({ leaves: [], dividers: [] })
  })

  test("geometries name the session or text of each pane and who has focus", () => {
    const panes = paneGeometries(fitLayout(sixPanels, stage), "reviewer")
    expect(panes.map((pane) => [pane.session, pane.text, pane.focused])).toEqual([
      [null, "top drawer", false],
      ["tray", null, false],
      [null, "bottom drawer", false],
      ["dock", null, false],
      ["reviewer", null, true],
      ["notes", null, false],
    ])
    expect(layoutSessions(sixPanels)).toEqual(["tray", "dock", "reviewer", "notes"])
  })
})

describe("dragDivider", () => {
  test("moves a sized child beside the divider and refits", () => {
    const dragged = dragDivider(sixPanels, ":0", 4, stage)!
    expect((dragged as { row: LayoutNode[] }).row[0]!.size).toBe(30)
    expect(fitLayout(dragged, stage).leaves.find((leaf) => leaf.path === "1")!.rect.x).toBe(31)
  })

  test("takes from the sized child after the divider when the one before is elastic", () => {
    const dragged = dragDivider(sixPanels, ":2", 5, stage)!
    expect((dragged as { row: LayoutNode[] }).row[3]!.size).toBe(15)
  })

  test("neither side drops below its minimum", () => {
    const dragged = dragDivider(sixPanels, ":0", -50, stage)!
    expect((dragged as { row: LayoutNode[] }).row[0]!.size).toBe(24)
    expect(dragDivider(sixPanels, ":0", 0, stage)).toBeNull()
  })

  test("a divider between two remainder children cannot move", () => {
    expect(dragDivider({ row: [{ session: "a" }, { session: "b" }] }, ":0", 3, stage)).toBeNull()
  })

  test("drawers drag inside their column", () => {
    const dragged = dragDivider(sixPanels, "0:0", 2, stage)!
    const column = (dragged as { row: LayoutNode[] }).row[0] as { column: LayoutNode[] }
    expect(column.column[0]!.size).toBe(10)
  })

  test("a divider that does not exist is refused", () => {
    expect(dragDivider(sixPanels, "9:9", 1, stage)).toBeNull()
    expect(dragDivider(sixPanels, "nonsense", 1, stage)).toBeNull()
  })
})
