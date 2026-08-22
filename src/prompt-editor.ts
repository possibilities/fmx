import {
  type CliRenderer,
  defaultTextareaKeyBindings,
  type KeyEvent,
  type TextareaAction,
  TextareaRenderable,
} from "@opentui/core"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModalColors } from "./host-palette.ts"
import {
  createKillRing,
  killDirectionFor,
  type KillRing,
  pushKill,
  removedText,
  ringEntry,
} from "./kill-ring.ts"

/**
 * The launch prompt's field: OpenTUI's textarea, which is a real line editor
 * — word motions, kills, selection, undo, and paste — rather than a string
 * fmx appends to. Everything readline-shaped is the widget's; this owns only
 * what the widget has no opinion about: a kill ring to yank from, and the
 * handoff to `$EDITOR` for a brief too long to write on one screen.
 *
 * Keys reach the widget through the renderer's own dispatch to the focused
 * renderable, which is also what draws the cursor and delivers bracketed
 * paste. So the field must be focused to be typed into, and the surrounding
 * dialog must let its keys through rather than swallowing them.
 */

/** Tall enough for a paragraph before it scrolls, and still well under half
 * of an ordinary terminal. */
export const PROMPT_MAX_ROWS = 8

const PLACEHOLDER = "what should the agent do?"

const PASTE_START = "\u001b[200~"
const PASTE_END = "\u001b[201~"

/**
 * A launch prompt on its way into fx, wrapped as a bracketed paste. Typed
 * bytes would submit at the first newline, where a pasted newline stays part
 * of the text. The send is deliberately not included: fx discards a paste
 * when anything follows its end marker in the same write, so the carriage
 * return has to be a write of its own.
 */
export function bracketedPaste(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`
}

type PromptBinding = {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  action: TextareaAction
}

/**
 * The field's keymap: the widget's full default set with plain enter
 * submitting instead of inserting, explicit newline spellings beside it, and
 * the classic undo aliases — ctrl+_ as the legacy 0x1F spelling, emacs
 * ctrl+/.
 */
export function promptKeyBindings(defaults: readonly PromptBinding[]): PromptBinding[] {
  return [
    ...defaults.filter(
      (binding) =>
        !(
          (binding.name === "return" || binding.name === "kpenter") &&
          binding.shift !== true &&
          binding.action === "newline"
        ),
    ),
    { name: "return", action: "submit" },
    { name: "kpenter", action: "submit" },
    { name: "return", shift: true, action: "newline" },
    { name: "j", ctrl: true, action: "newline" },
    { name: "_", ctrl: true, action: "undo" },
    { name: "/", ctrl: true, action: "undo" },
  ]
}

/**
 * Keys the dialog keeps for itself while the field has focus. Everything
 * else belongs to the widget — ctrl+k is kill-to-line-end here, whatever it
 * may mean on another row.
 */
export function isStructuralKey(key: KeyEvent): boolean {
  const name = key.name
  return (
    name === "escape" ||
    name === "tab" ||
    name === "backtab" ||
    ((name === "return" || name === "enter") && key.shift !== true) ||
    (key.ctrl === true && name === "g")
  )
}

/** The editor's answer replaces the prompt wholesale; a trailing newline is
 * the editor's punctuation, not the operator's. */
export function normalizeEditedPrompt(text: string): string {
  return text.replace(/\r\n/gu, "\n").replace(/\n+$/u, "")
}

type PromptEditorEvents = {
  /** The text changed, so the dialog can re-measure and repaint. */
  onChange: () => void
}

export class PromptEditor {
  readonly root: TextareaRenderable
  private readonly killRing: KillRing = createKillRing()
  private lastEdit: "kill" | "yank" | null = null
  private yankRegion: { start: number; length: number; index: number } | null = null
  private shadow = { text: "", cursor: 0 }
  private editing = false

  constructor(
    private readonly renderer: CliRenderer,
    private readonly events: PromptEditorEvents,
  ) {
    this.root = new TextareaRenderable(renderer, {
      id: "fmx-launch-prompt",
      minHeight: 1,
      height: 1,
      wrapMode: "word",
      placeholder: PLACEHOLDER,
      keyBindings: promptKeyBindings(defaultTextareaKeyBindings),
      // Enter is bound to submit so it never inserts a newline, but the
      // dialog acts on it as a structural key. Advancing here as well would
      // move focus twice or once depending on which listener ran first.
      onSubmit: () => {},
    })
  }

  get text(): string {
    return this.root.plainText
  }

  /** Whether the field is being edited elsewhere, and keys are not ours. */
  get suspended(): boolean {
    return this.editing
  }

  reset(): void {
    this.root.setText("")
    this.killRing.entries.length = 0
    this.lastEdit = null
    this.yankRegion = null
    this.shadow = { text: "", cursor: 0 }
  }

  /** Replace the text outright, cursor at the end, as an external edit does. */
  setText(text: string): void {
    this.root.setText(normalizeEditedPrompt(text))
    this.root.cursorOffset = this.text.length
    this.lastEdit = null
    this.yankRegion = null
    this.settle()
  }

  focus(): void {
    this.root.focus()
  }

  blur(): void {
    this.root.blur()
  }

  /**
   * Fit the field to `width` and answer how many rows it now wants: one per
   * wrapped line, capped. Past the cap it scrolls, which is the only way a
   * long brief stays composable in a dialog that must not swallow the screen.
   *
   * The width is set rather than flexed: left to grow, the field measures
   * against its parent's full width and wraps columns past the dialog's edge
   * before snapping back. Rows come from the native wrap layout, which counts
   * wrapped lines as well as typed ones — `virtualLineCount` is capped by the
   * viewport and so could never grow the field that holds it.
   */
  measure(width: number): number {
    this.root.width = Math.max(4, width)
    const rows = Math.max(1, Math.min(PROMPT_MAX_ROWS, this.root.lineInfo.lineWraps.length))
    this.root.height = rows
    this.clampScroll(rows)
    return rows
  }

  applyPalette(colors: ModalColors): void {
    this.root.backgroundColor = colors.background
    this.root.focusedBackgroundColor = colors.background
    this.root.textColor = colors.foreground
    this.root.focusedTextColor = colors.foreground
    this.root.placeholderColor = colors.dim
    this.root.cursorColor = colors.accent
  }

  /**
   * A key that reached the dialog while the field had focus. Yank and
   * yank-pop are answered here — the widget has no ring of its own. Anything
   * else is the widget's, and is only watched: the diff runs in a microtask,
   * after the widget's own dispatch, whichever listener ran first.
   */
  observe(key: KeyEvent): void {
    if (key.ctrl === true && key.name === "y") {
      this.yank()
      return
    }
    if (key.meta === true && key.name === "y") {
      this.yankPop()
      return
    }
    const kill = killDirectionFor({
      name: key.name,
      ...(key.ctrl === true ? { ctrl: true } : {}),
      ...(key.meta === true ? { meta: true } : {}),
      ...(key.shift === true ? { shift: true } : {}),
    })
    const before = this.shadow
    queueMicrotask(() => {
      if (kill !== null) {
        pushKill(this.killRing, removedText(before.text, this.text), kill, this.lastEdit === "kill")
        this.lastEdit = "kill"
      } else {
        this.lastEdit = null
      }
      this.settle()
    })
  }

  /** Paste arrives at the focused widget through the renderer; the dialog
   * only has to re-measure once it has landed. */
  observePaste(): void {
    this.lastEdit = null
    queueMicrotask(() => this.settle())
  }

  /**
   * The way the harnesses do it: suspend the renderer, hand the prompt to
   * `$EDITOR` (`$VISUAL` first, its arguments honored through the shell),
   * and read the answer back on exit. fx keeps running underneath; its
   * output buffers until the renderer comes back.
   *
   * An editor that will not run, or that exits nonzero, leaves the prompt as
   * it was. There is nothing to report: the operator is looking straight at
   * the text they were about to edit, unchanged.
   */
  async editExternally(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (this.editing) return
    this.editing = true
    const editor = env.VISUAL ?? env.EDITOR ?? "vi"
    const file = join(tmpdir(), `fmx-prompt-${process.pid}-${Date.now()}.md`)
    let edited: string | null = null
    try {
      await Bun.write(file, this.text)
      this.renderer.suspend()
      try {
        const editorProcess = Bun.spawn(["/bin/sh", "-c", `${editor} "$1"`, "sh", file], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: env as Record<string, string>,
        })
        if ((await editorProcess.exited) === 0) edited = await Bun.file(file).text()
      } finally {
        this.renderer.resume()
      }
    } catch {
      // An editor that cannot be spawned changes nothing.
    } finally {
      try {
        unlinkSync(file)
      } catch {
        // Already gone; nothing to clean.
      }
      this.editing = false
    }

    if (edited === null) return
    this.root.setText(normalizeEditedPrompt(edited))
    this.root.cursorOffset = this.text.length
    this.lastEdit = null
    this.settle()
  }

  /**
   * OpenTUI follows the cursor down as the prompt grows but does not clamp
   * that scroll origin when trailing lines are deleted while the field stays
   * at its cap. Keep the viewport inside the newly shorter prompt.
   */
  private clampScroll(rows: number): void {
    const view = (this.root as unknown as { editorView?: EditorView }).editorView
    if (!view) return
    const viewport = view.getViewport()
    const maxOffsetY = Math.max(0, view.getTotalVirtualLineCount() - rows)
    if (viewport.offsetY <= maxOffsetY) return
    view.setViewport(viewport.offsetX, maxOffsetY, viewport.width, viewport.height, false)
  }

  private yank(): void {
    const top = ringEntry(this.killRing, 0)
    if (top === null) return
    const start = this.root.cursorOffset
    this.root.insertText(top)
    this.yankRegion = { start, length: top.length, index: 0 }
    this.lastEdit = "yank"
    this.settle()
  }

  private yankPop(): void {
    if (this.lastEdit !== "yank" || this.yankRegion === null) return
    const next = ringEntry(this.killRing, this.yankRegion.index + 1)
    if (next === null) return
    const { start, length, index } = this.yankRegion
    const text = this.text
    this.root.setText(`${text.slice(0, start)}${next}${text.slice(start + length)}`)
    this.root.cursorOffset = start + next.length
    this.yankRegion = { start, length: next.length, index: index + 1 }
    this.settle()
  }

  private settle(): void {
    this.shadow = { text: this.text, cursor: this.root.cursorOffset }
    this.events.onChange()
    this.renderer.requestRender()
  }
}

type EditorView = {
  getViewport(): { offsetX: number; offsetY: number; width: number; height: number }
  getTotalVirtualLineCount(): number
  setViewport(x: number, y: number, width: number, height: number, moveCursor?: boolean): void
}
