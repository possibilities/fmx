import {
  type CliRenderer,
  type EmbeddedTerminalOptions,
  EmbeddedTerminalRenderable,
  type KeyEvent,
  type KittyKeyboardOptions,
  type OptimizedBuffer,
  type Selection,
} from "@opentui/core"
import { buildEmbeddedThemeSequence, type FxnkThemeResolution } from "./host-palette.ts"

type FxTerminalOptions = Omit<EmbeddedTerminalOptions, "selectable">

// fx requests Kitty's disambiguate flag and no other progressive-enhancement
// flags. The host terminal must use the same mode so raw key reports can pass
// through unchanged.
export const FX_KEYBOARD_PROTOCOL = {
  disambiguate: true,
  alternateKeys: false,
  events: false,
  allKeysAsEscapes: false,
  reportText: false,
} satisfies KittyKeyboardOptions

/**
 * Compose terminal-style selection with fx mouse handling:
 *
 * - without fx mouse reporting, OpenTUI owns an ordinary drag;
 * - with fx mouse reporting, fx owns the click and drag exclusively;
 * - the outer terminal can still reserve Shift-drag as its native override.
 *
 * OpenTUI starts selection before its embedded terminal tries to encode the
 * mouse press. A prevented press means the native encoder produced a child
 * mouse report, so clear that provisional selection in the same event turn.
 */
export class FxTerminalRenderable extends EmbeddedTerminalRenderable {
  // A fresh emulator reports a visible cursor at the origin, and fmx focuses a
  // new Agent before fx has drawn anything. Control-only startup output can
  // leave that provisional cursor untouched, so conceal it until fx places it.
  private cursorPositionEstablished = false
  private selectionGesture: Selection | null = null
  private selectionActivated = false

  constructor(renderer: CliRenderer, options: FxTerminalOptions) {
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

  public setHostSelectionEnabled(enabled: boolean): void {
    this.selectable = enabled
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

  public override encodeKey(key: KeyEvent): Uint8Array {
    // fmx reserves only its own prefix commands. Every other key must reach fx
    // exactly as the host terminal reported it; parsing and re-encoding changes
    // control bytes and modified special keys (notably Ctrl-U and Backspace).
    return new TextEncoder().encode(key.raw)
  }
}
