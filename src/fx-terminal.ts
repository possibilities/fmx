import {
  type CliRenderer,
  type EmbeddedTerminalOptions,
  EmbeddedTerminalRenderable,
  type KeyEvent,
  type KittyKeyboardOptions,
  type TerminalColors,
} from "@opentui/core"
import { buildHostPaletteSequence } from "./host-palette.ts"

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
 * - without child mouse reporting, OpenTUI owns an ordinary drag;
 * - with child mouse reporting, fx owns the click and drag exclusively;
 * - the outer terminal can still reserve Shift-drag as its native override.
 *
 * OpenTUI starts selection before its embedded terminal tries to encode the
 * mouse press. A prevented press means the native encoder produced a child
 * mouse report, so clear that provisional selection in the same event turn.
 */
export class FxTerminalRenderable extends EmbeddedTerminalRenderable {
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

  public applyHostPalette(colors: TerminalColors): boolean {
    const sequence = buildHostPaletteSequence(colors)
    if (!sequence) return false
    this.write(sequence)
    return true
  }

  public override encodeKey(key: KeyEvent): Uint8Array {
    // fmx reserves only its own prefix commands. Every other key must reach fx
    // exactly as the host terminal reported it; parsing and re-encoding changes
    // control bytes and modified special keys (notably Ctrl-U and Backspace).
    return new TextEncoder().encode(key.raw)
  }
}
