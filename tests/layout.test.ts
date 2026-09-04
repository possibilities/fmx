import { describe, expect, test } from "bun:test"
import { dividerGlyphs, dragDivider, fitLayout, fitLengths, layoutSessions, paneGeometries, requiredLength } from "../src/layout.ts"
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

  test("a divider between two remainder children moves, pinning one side", () => {
    const root: LayoutNode = { row: [{ session: "a" }, { session: "b" }] }
    // 100 cols less one divider splits 50/49, so the boundary starts at 50.
    expect(fitLayout(root, stage).dividers[0]!.rect.x).toBe(50)
    const dragged = dragDivider(root, ":0", 12, stage)!
    expect(fitLayout(dragged, stage).dividers[0]!.rect.x).toBe(62)
    const rects = Object.fromEntries(fitLayout(dragged, stage).leaves.map((leaf) => [leaf.path, leaf.rect]))
    expect(rects["0"]!.cols).toBe(62)
    expect(rects["1"]!.cols).toBe(37)
  })

  test("a remainder divider drags up as well as left", () => {
    const root: LayoutNode = { column: [{ session: "a" }, { session: "b" }] }
    expect(fitLayout(root, stage).dividers[0]!.rect.y).toBe(15)
    const dragged = dragDivider(root, ":0", -6, stage)!
    expect(fitLayout(dragged, stage).dividers[0]!.rect.y).toBe(9)
  })

  test("a remainder drag still refuses to cross a minimum", () => {
    const root: LayoutNode = { row: [{ session: "a", min: 40 }, { session: "b" }] }
    const dragged = dragDivider(root, ":0", -30, stage)!
    expect(fitLayout(dragged, stage).dividers[0]!.rect.x).toBe(40)
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

  test("the boundary under the pointer is the one that moves, by the distance asked", () => {
    // A remainder before the divider: adjusting the child before it would let
    // that remainder absorb the change, pinning the grabbed boundary while a
    // different one walks the other way.
    const tree: LayoutNode = { row: [{ session: "a" }, { session: "b", size: 10 }, { session: "c", size: 10 }] }
    const small = { cols: 60, rows: 20 }
    const at = (node: LayoutNode, id: string) => fitLayout(node, small).dividers.find((divider) => divider.id === id)!.rect.x
    const before = { first: at(tree, ":0"), second: at(tree, ":1") }

    for (const delta of [1, 3, 6, -4]) {
      const dragged = dragDivider(tree, ":1", delta, small)!
      expect(at(dragged, ":1"), `dragging by ${delta}`).toBe(before.second + delta)
      // Nothing else moves, and the elastic Pane keeps every cell it had.
      expect(at(dragged, ":0"), `dragging by ${delta}`).toBe(before.first)
    }
  })

  test("a drag between two fixed Panes moves cells across and leaves the rest alone", () => {
    const tree: LayoutNode = {
      row: [{ session: "a" }, { session: "b", size: 10 }, { session: "c", size: 10 }],
    }
    const small = { cols: 60, rows: 20 }
    const widths = (node: LayoutNode) => fitLayout(node, small).leaves.map((leaf) => leaf.rect.cols)
    expect(widths(tree)).toEqual([38, 10, 10])
    expect(widths(dragDivider(tree, ":1", 3, small)!)).toEqual([38, 13, 7])
  })

  test("a container is never handed fewer cells than its subtree needs", () => {
    // A column whose only child needs ten rows cannot be drawn in three, so
    // the fit gives it what it needs or gives it up — never a blank band.
    const tree: LayoutNode = {
      column: [{ column: [{ text: "drawer", size: 10, min: 10 }], size: 3, min: 3 }, { session: "main" }],
    }
    expect(requiredLength(tree.column[0]!, "column")).toBe(10)
    const fitted = fitLayout(tree, { cols: 40, rows: 20 })
    const drawn = fitted.leaves.filter((leaf) => leaf.rect.rows > 0)
    expect(drawn.map((leaf) => [leaf.rect.y, leaf.rect.rows])).toEqual([
      [0, 10],
      [11, 9],
    ])
    // No divider without a Pane on both sides of it.
    for (const divider of fitted.dividers) {
      expect(drawn.some((leaf) => leaf.rect.y + leaf.rect.rows === divider.rect.y)).toBe(true)
    }
  })

  test("a squeezed-out Pane is reported at zero rather than dropped", () => {
    const tree: LayoutNode = {
      row: [
        { session: "a", size: 40, min: 40 },
        { session: "b", size: 40, min: 40 },
        { session: "c", size: 40, min: 40 },
      ],
    }
    // The contract says every Pane appears in tree order; a caller zipping
    // this against its own leaves must not silently misalign.
    for (const [cols, expected] of [
      [122, [40, 40, 40]],
      [81, [40, 40, 0]],
      [60, [60, 0, 0]],
    ] as const) {
      const panes = paneGeometries(fitLayout(tree, { cols, rows: 20 }), null)
      expect(panes.map((pane) => pane.session), `at ${cols}`).toEqual(["a", "b", "c"])
      expect(panes.map((pane) => pane.cols), `at ${cols}`).toEqual([...expected])
    }
  })

  test("one Session named twice reports one focused Pane", () => {
    const panes = paneGeometries(
      fitLayout({ row: [{ session: "a", size: 20 }, { session: "a" }] }, { cols: 60, rows: 20 }),
      "a",
    )
    expect(panes).toHaveLength(2)
    expect(panes.filter((pane) => pane.focused)).toHaveLength(1)
  })
})

describe("dividerGlyphs", () => {
  const glyphsFor = (root: LayoutNode, size = stage) => dividerGlyphs(fitLayout(root, size).dividers)

  test("a crossing resolves to a join rather than one line overwriting the other", () => {
    const grid: LayoutNode = {
      row: [
        { column: [{ session: "a" }, { session: "b" }] },
        { column: [{ session: "c" }, { session: "d" }] },
      ],
    }
    const glyphs = glyphsFor(grid, { cols: 21, rows: 7 })
    // The vertical divider sits at x=10, the two horizontals at y=3.
    expect(glyphs.get("10,3")).toBe("┼")
    expect(glyphs.get("10,2")).toBe("│")
    expect(glyphs.get("9,3")).toBe("─")
    expect(glyphs.get("11,3")).toBe("─")
  })

  test("a divider that stops against another becomes a T", () => {
    const sidebar: LayoutNode = {
      column: [
        { text: "header", size: 1 },
        { row: [{ column: [{ session: "a" }, { session: "b" }], size: 6 }, { session: "c" }] },
        { text: "footer", size: 1 },
      ],
    }
    const glyphs = glyphsFor(sidebar, { cols: 20, rows: 11 })
    // Header divider at y=1, footer divider at y=9, the sidebar's vertical at
    // x=6 between them, and the sidebar's own horizontal stopping against it.
    expect(glyphs.get("6,1")).toBe("┬")
    expect(glyphs.get("6,9")).toBe("┴")
    expect(glyphs.get("6,5")).toBe("┤")
    expect(glyphs.get("0,1")).toBe("─")
  })

  test("a lone divider is still a line", () => {
    expect(glyphsFor({ row: [{ session: "a" }, { session: "b" }] }).get("50,0")).toBe("│")
    expect(glyphsFor({ column: [{ session: "a" }, { session: "b" }] }).get("0,15")).toBe("─")
  })

  test("no dividers, no glyphs", () => {
    expect(glyphsFor({ session: "a" }).size).toBe(0)
  })
})
