import { BoxRenderable, type CliRenderer, type MouseEvent, TextRenderable } from "@opentui/core"
import { fxnkRamp, type FxnkThemeResolution } from "./host-palette.ts"
import {
  dragDivider,
  type FittedDivider,
  type FittedLayout,
  fitLayout,
  layoutSessions,
  paneGeometries,
  type Rect,
} from "./layout.ts"
import { ApiFailure, type LayoutNode, type LayoutView } from "./protocol.ts"
import type { PaneTerminalRenderable } from "./pane-terminal.ts"

/** Where the Stage gets a Session's emulator; the roster owns their lifetime. */
export type PaneSource = {
  terminalFor(name: string): PaneTerminalRenderable | null
  setShown(names: Iterable<string>): void
}

export type StageOptions = {
  renderer: CliRenderer
  panes: PaneSource
  theme: FxnkThemeResolution
  onChanged: (cause: "apply" | "drag" | "resize") => void
}

type TextPane = { box: BoxRenderable; label: TextRenderable; text: string }
type DividerPane = { box: BoxRenderable; axis: FittedDivider["axis"] }

/**
 * The drawn Layout. Applying one mutates only what moved: a Pane that keeps
 * its rectangle is not resized, so its emulator neither reflows nor tells its
 * PTY anything, and a Session that stays on screen across an apply never
 * blinks. Geometry is fmx's own — every Pane is absolutely positioned at the
 * rectangle `layout.ts` computed — so one apply is one layout pass.
 */
export class Stage {
  private readonly root: BoxRenderable
  private readonly textPanes = new Map<string, TextPane>()
  private readonly dividers = new Map<string, DividerPane>()
  private readonly renderer: CliRenderer
  private readonly panes: PaneSource
  private readonly onChanged: StageOptions["onChanged"]
  private theme: FxnkThemeResolution
  private tree: LayoutNode | null = null
  /** Bumped by every change to the tree, so a caller can refuse a stale write. */
  private treeRevision = 0
  private fitted: FittedLayout = { leaves: [], dividers: [] }
  private focusName: string | null = null
  /** Sessions with a Pane right now, in tree order. */
  private shown: string[] = []
  private drag: { id: string; root: LayoutNode; x: number; y: number } | null = null

  constructor(options: StageOptions) {
    this.renderer = options.renderer
    this.panes = options.panes
    this.onChanged = options.onChanged
    this.theme = options.theme
    this.root = new BoxRenderable(this.renderer, {
      id: "fmx-stage",
      width: "100%",
      height: "100%",
    })
    this.renderer.root.add(this.root)
  }

  get view(): LayoutView {
    return {
      revision: this.treeRevision,
      root: this.tree,
      focus: this.focusName,
      stage: this.size,
      panes: paneGeometries(this.fitted, this.focusName),
    }
  }

  get size(): { cols: number; rows: number } {
    return { cols: Math.max(1, this.renderer.width), rows: Math.max(1, this.renderer.height) }
  }

  /** Session names a Pane shows, in tree order. */
  get shownSessions(): string[] {
    return [...this.shown]
  }

  /**
   * Replace the Layout. `revision` is the one the caller built its tree from:
   * a human's divider drag moves the Layout on, and an apply carrying an older
   * revision is refused rather than silently undoing that gesture.
   */
  apply(
    root: LayoutNode | null,
    focus: string | null | undefined,
    options: { revision?: number; cause?: "apply" | "drag" } = {},
  ): LayoutView {
    if (options.revision !== undefined && options.revision !== this.treeRevision) {
      throw new ApiFailure(
        "conflict",
        `the Layout has moved on: revision ${this.treeRevision}, not ${options.revision}`,
      )
    }
    this.tree = root
    this.treeRevision += 1
    if (focus !== undefined) this.focusName = focus
    this.draw()
    this.onChanged(options.cause ?? "apply")
    return this.view
  }

  /** Re-fit the current tree; the roster changed or the stage did. */
  refit(cause: "apply" | "resize" = "apply"): LayoutView {
    this.draw()
    this.onChanged(cause)
    return this.view
  }

  setTheme(resolution: FxnkThemeResolution): void {
    this.theme = resolution
    const ramp = fxnkRamp(resolution.theme)
    for (const pane of this.textPanes.values()) {
      pane.label.fg = ramp.dim
    }
    for (const divider of this.dividers.values()) {
      divider.box.borderColor = ramp.divider
      divider.box.focusedBorderColor = ramp.divider
    }
  }

  destroy(): void {
    for (const pane of this.textPanes.values()) pane.box.destroy()
    for (const divider of this.dividers.values()) divider.box.destroy()
    this.textPanes.clear()
    this.dividers.clear()
    this.root.destroy()
  }

  private draw(): void {
    const stage = this.size
    this.fitted = fitLayout(this.tree, stage)
    const ramp = fxnkRamp(this.theme.theme)

    const shown: string[] = []
    const liveText = new Set<string>()
    for (const leaf of this.fitted.leaves) {
      if (leaf.rect.cols <= 0 || leaf.rect.rows <= 0) continue
      if ("session" in leaf.node) {
        const terminal = this.panes.terminalFor(leaf.node.session)
        // A Pane naming a Session that does not exist draws nothing; the
        // Layout stays as the caller wrote it, so creating that Session later
        // fills the Pane without another apply.
        if (!terminal) continue
        if (terminal.parent !== this.root) this.root.add(terminal)
        placeAt(terminal, leaf.rect)
        terminal.visible = true
        shown.push(leaf.node.session)
        continue
      }
      if ("text" in leaf.node) {
        liveText.add(leaf.path)
        this.drawText(leaf.path, leaf.node.text, leaf.rect, ramp.dim)
      }
    }

    // Anything not in this Layout leaves the screen but keeps running: what
    // the last draw showed, plus anything this tree names but could not fit.
    const shownSet = new Set(shown)
    for (const name of new Set([...this.shown, ...layoutSessions(this.tree)])) {
      if (shownSet.has(name)) continue
      const terminal = this.panes.terminalFor(name)
      if (terminal) terminal.visible = false
    }
    for (const [path, pane] of this.textPanes) {
      if (liveText.has(path)) continue
      pane.box.destroy()
      this.textPanes.delete(path)
    }

    this.drawDividers(ramp.divider)
    this.shown = shown
    this.panes.setShown(shown)
    this.applyFocus()
  }

  private drawText(path: string, text: string, rect: Rect, color: ReturnType<typeof fxnkRamp>["dim"]): void {
    let pane = this.textPanes.get(path)
    if (!pane) {
      const box = new BoxRenderable(this.renderer, {
        id: `fmx-text-${path || "root"}`,
        position: "absolute",
        alignItems: "center",
        justifyContent: "center",
      })
      const label = new TextRenderable(this.renderer, {
        id: `fmx-text-label-${path || "root"}`,
        content: text,
        fg: color,
        selectable: false,
      })
      box.add(label)
      this.root.add(box)
      pane = { box, label, text }
      this.textPanes.set(path, pane)
    }
    if (pane.text !== text) {
      pane.text = text
      pane.label.content = text
    }
    pane.label.fg = color
    placeAt(pane.box, rect)
    pane.box.visible = true
  }

  private drawDividers(color: ReturnType<typeof fxnkRamp>["divider"]): void {
    const live = new Set<string>()
    for (const divider of this.fitted.dividers) {
      live.add(divider.id)
      let pane = this.dividers.get(divider.id)
      if (!pane || pane.axis !== divider.axis) {
        pane?.box.destroy()
        const box = new BoxRenderable(this.renderer, {
          id: `fmx-divider-${divider.id}`,
          position: "absolute",
          border: divider.axis === "row" ? ["left"] : ["top"],
          borderStyle: "single",
          borderColor: color,
          onMouseDown: (event) => this.beginDrag(divider.id, event),
          onMouseDrag: (event) => this.continueDrag(divider, event),
          onMouseUp: () => this.endDrag(),
          onMouseDragEnd: () => this.endDrag(),
        })
        this.root.add(box)
        pane = { box, axis: divider.axis }
        this.dividers.set(divider.id, pane)
      }
      pane.box.borderColor = color
      pane.box.focusedBorderColor = color
      placeAt(pane.box, divider.rect)
      pane.box.visible = true
    }
    for (const [id, pane] of this.dividers) {
      if (live.has(id)) continue
      pane.box.destroy()
      this.dividers.delete(id)
    }
  }

  /**
   * Keyboard focus is the API's alone: a click forwards its mouse report and
   * moves nothing. A focused Session that leaves the screen takes the
   * keyboard with it, and keys go nowhere until the next apply.
   */
  private applyFocus(): void {
    const focused = this.focusName !== null && this.shown.includes(this.focusName) ? this.focusName : null
    if (focused === null) this.focusName = null
    for (const name of this.shown) {
      const terminal = this.panes.terminalFor(name)
      if (!terminal) continue
      if (name === focused) terminal.takeFocus()
      else if (terminal.focused) terminal.blur()
    }
  }

  private beginDrag(id: string, event: MouseEvent): void {
    if (!this.tree) return
    event.preventDefault()
    event.stopPropagation()
    this.drag = { id, root: this.tree, x: event.x, y: event.y }
    // Capture immediately: OpenTUI latches drag capture on the first drag
    // event, and a fast flick can put that event past a one-cell divider.
    const capturer = this.renderer as unknown as { setCapturedRenderable?: (renderable: BoxRenderable) => void }
    const pane = this.dividers.get(id)
    if (pane) capturer.setCapturedRenderable?.(pane.box)
  }

  private continueDrag(divider: FittedDivider, event: MouseEvent): void {
    const drag = this.drag
    if (!drag || drag.id !== divider.id) return
    event.preventDefault()
    event.stopPropagation()
    // Cumulative from the tree the drag started on, so a slow drag does not
    // accumulate rounding the way per-event deltas would.
    const delta = divider.axis === "row" ? event.x - drag.x : event.y - drag.y
    const next = dragDivider(drag.root, divider.id, delta, this.size)
    if (!next) return
    this.tree = next
    this.treeRevision += 1
    this.draw()
    this.onChanged("drag")
  }

  private endDrag(): void {
    this.drag = null
  }
}

function placeAt(renderable: { position: unknown; left: unknown; top: unknown; width: unknown; height: unknown }, rect: Rect): void {
  const target = renderable as { position: string; left: number; top: number; width: number; height: number }
  target.position = "absolute"
  target.left = rect.x
  target.top = rect.y
  target.width = rect.cols
  target.height = rect.rows
}

