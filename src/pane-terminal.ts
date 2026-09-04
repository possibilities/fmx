import {
  type CliRenderer,
  type EmbeddedTerminalOptions,
  EmbeddedTerminalRenderable,
  type EmbeddedTerminalScreen,
  type KittyKeyboardOptions,
  OptimizedBuffer,
  type Selection,
} from "@opentui/core"
import { buildEmbeddedThemeSequence, type FxnkThemeResolution } from "./host-palette.ts"

type PaneTerminalOptions = Omit<EmbeddedTerminalOptions, "selectable">

/**
 * The host terminal's keyboard mode: Kitty's disambiguate flag and no other
 * progressive enhancement, so modified keys reach the Runtime unambiguously.
 * Each Session's own mode is the embedded emulator's business: the native
 * encoder re-encodes every key for the flags that Session requested.
 */
export const HOST_KEYBOARD_PROTOCOL = {
  disambiguate: true,
  alternateKeys: false,
  events: false,
  allKeysAsEscapes: false,
  reportText: false,
} satisfies KittyKeyboardOptions

/**
 * One Session's screen: a libghostty emulator in a rectangle of the stage.
 *
 * Focus is the API's. OpenTUI's embedded terminal takes keyboard focus on a
 * left mouse-down; here a click forwards the mouse report and moves nothing,
 * because a keyboard that follows the pointer is one a program driving the
 * Layout cannot reason about.
 *
 * Selection composes with the Session's own mouse handling: without mouse
 * reporting, OpenTUI owns an ordinary drag; with it, the Session owns the
 * click and drag exclusively; the outer terminal can still reserve
 * Shift-drag as its native override.
 */
export class PaneTerminalRenderable extends EmbeddedTerminalRenderable {
  // A fresh emulator reports a visible cursor at the origin, and a Pane may
  // be focused before its Session has drawn anything. Control-only startup
  // output can leave that provisional cursor untouched, so conceal it until
  // the Session places it.
  private cursorPositionEstablished = false
  private selectionGesture: Selection | null = null
  private selectionActivated = false
  private focusPermitted = false
  private scratch: OptimizedBuffer | null = null

  constructor(renderer: CliRenderer, options: PaneTerminalOptions) {
    const onMouseDown = options.onMouseDown
    super(renderer, {
      ...options,
      selectable: options.visible !== false,
      onMouseDown(event) {
        if (event.defaultPrevented) renderer.clearSelection()
        onMouseDown?.call(this, event)
      },
    })
  }

  /** The one way keyboard focus reaches a Pane: the stage, on the API's word. */
  public takeFocus(): void {
    this.focusPermitted = true
    try {
      super.focus()
    } finally {
      this.focusPermitted = false
    }
  }

  public override focus(): void {
    if (!this.focusPermitted) return
    super.focus()
  }

  public setHostSelectionEnabled(enabled: boolean): void {
    this.selectable = enabled
  }

  /**
   * The screen as text, whether or not this Pane is on the Layout. OpenTUI's
   * own `screen()` reads the frame buffer the render pass fills, which a
   * hidden Pane never gets, so the emulator is composed into a buffer of this
   * Pane's own instead. The size is the caller's because it is the emulator's:
   * a Pane that has never been drawn has no layout to ask.
   */
  public captureScreen(cols: number, rows: number): EmbeddedTerminalScreen {
    const internals = this as unknown as {
      handle: unknown
      lib: {
        embeddedTerminalCompose: (handle: unknown, target: unknown, x: number, y: number) => void
        embeddedTerminalInvalidate: (handle: unknown) => void
        embeddedTerminalCursor: (handle: unknown) => { x: number; y: number; visible: boolean; hasValue: boolean }
      }
    }
    const cursor = { x: 0, y: 0, visible: false }
    if (!internals.handle) return { text: "", lines: [], columns: cols, rows, cursor }
    const width = Math.max(1, cols)
    const height = Math.max(1, rows)
    if (!this.scratch || this.scratch.width !== width || this.scratch.height !== height) {
      this.scratch?.destroy()
      this.scratch = OptimizedBuffer.create(width, height, this._ctx.widthMethod, { id: `${this.id}-capture` })
    }
    // A compose carries only what changed since the last one, so a capture
    // after a frame would read blanks. Mark the whole screen dirty first, and
    // again afterwards so this read does not swallow the next frame's damage.
    internals.lib.embeddedTerminalInvalidate(internals.handle)
    internals.lib.embeddedTerminalCompose(internals.handle, this.scratch.ptr, 0, 0)
    internals.lib.embeddedTerminalInvalidate(internals.handle)
    this.requestRender()
    const lines = new TextDecoder()
      .decode(this.scratch.getRealCharBytes(true))
      .split("\n")
      .slice(0, height)
      .map((line) => line.trimEnd())
    while (lines.at(-1) === "") lines.pop()
    const reported = internals.lib.embeddedTerminalCursor(internals.handle)
    return {
      text: lines.join("\n"),
      lines,
      columns: width,
      rows: height,
      cursor: { x: reported.x, y: reported.y, visible: reported.visible && reported.hasValue },
    }
  }

  protected override destroySelf(): void {
    this.scratch?.destroy()
    this.scratch = null
    super.destroySelf()
  }

  public override onSelectionChanged(selection: Selection | null): boolean {
    if (!selection?.isActive) {
      this.selectionGesture = null
      this.selectionActivated = false
      return super.onSelectionChanged(null)
    }

    if (selection !== this.selectionGesture) {
      this.selectionGesture = selection
      this.selectionActivated = false
    }

    if (!this.selectionActivated) {
      const { anchor, focus } = selection
      this.selectionActivated = anchor.x !== focus.x || anchor.y !== focus.y
      if (!this.selectionActivated) {
        // OpenTUI sets isStart false on any drag event, even when the pointer is
        // still in its original cell. Keep the gesture provisional so mouse-up
        // clears it without copying. Once two cells have been covered, the latch
        // stays open and the user may contract the selection back to one cell.
        selection.isStart = true
        return super.onSelectionChanged(null)
      }
    }

    return super.onSelectionChanged(selection)
  }

  /** The one dynamic color the Session needs to answer its own OSC 11 query. */
  public applyHostTheme(resolution: FxnkThemeResolution): void {
    this.write(buildEmbeddedThemeSequence(resolution))
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)
    if (!this.focused || this.cursorPositionEstablished) return
    const cursor = this.screen().cursor
    if (cursor.visible && (cursor.x !== 0 || cursor.y !== 0)) {
      this.cursorPositionEstablished = true
      return
    }
    this._ctx.setCursorPosition(0, 0, false)
  }
}
