import {
  bold,
  BoxRenderable,
  type CliRenderer,
  fg,
  type KeyEvent,
  StyledText,
  type TerminalColors,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { MODAL_FALLBACK_COLORS, type ModalColors, modalColors } from "./host-palette.ts"
import { isCancelKey } from "./keybindings.ts"
import { cycleByLetter, matchProjects, type ProjectChoice } from "./projects.ts"
import { isStructuralKey, PromptEditor } from "./prompt-editor.ts"

/**
 * The launch dialog: what an instance is started with, gathered before fx
 * runs. Three rows — the prompt to start on, the project to start in, and
 * whether to cut a fresh worktree for it.
 *
 * The chooser rows are rows rather than a bare list on purpose. A row answers
 * a letter by cycling to the next project starting with it, which is the
 * fastest way to reach a project whose name you know; the project picker it
 * opens on space answers a filter instead, which is the way to reach one you
 * only half remember.
 */

const DIALOG_TITLE = " launch "
const PICKER_TITLE = " project "
const DIALOG_MAX_WIDTH = 56
const DIALOG_MIN_WIDTH = 32
const PICKER_MAX_ROWS = 10
/** Wide enough for the longest label, plus the gap to its value. */
const LABEL_COLUMN = 10

const ROWS = ["prompt", "project", "worktree"] as const
type Row = (typeof ROWS)[number]

/** Border and the chooser rows — everything but the prompt, which is as tall
 * as what has been written in it. */
const DIALOG_CHROME_HEIGHT = ROWS.length + 1

const PICKER_HINT = "type to filter"
const EMPTY = "no projects found — set project_roots in the config"
const WORKTREE_UNAVAILABLE = "unavailable — not a repository"

export type LaunchRequest = {
  directory: string
  /** Empty when none was given; fx then opens on nothing, as it always has. */
  prompt: string
  worktree: boolean
}

type LaunchDialogEvents = {
  onLaunch: (request: LaunchRequest) => void
  onClose: () => void
  /** Asks whether a worktree can be cut here; answered by
   * `setWorktreeAvailability`, possibly after several more selections. */
  onProjectChange: (directory: string) => void
}

export class LaunchDialog {
  readonly root: BoxRenderable
  private readonly dialog: BoxRenderable
  private readonly rowTexts = new Map<Row, TextRenderable>()
  private readonly promptRow: BoxRenderable
  private readonly editor: PromptEditor
  private readonly picker: BoxRenderable
  private readonly filterText: TextRenderable
  private readonly pickerRows: BoxRenderable

  private colors: ModalColors = MODAL_FALLBACK_COLORS
  private projects: ProjectChoice[] = []
  private selected = 0
  private focus = 0
  private worktree = false
  /** Null until the answer for the selected project arrives. */
  private worktreeAvailable: boolean | null = null
  private open = false
  private picking = false
  private filter = ""
  private highlighted = 0
  private scroll = 0

  constructor(
    private readonly renderer: CliRenderer,
    private readonly events: LaunchDialogEvents,
  ) {
    this.root = new BoxRenderable(renderer, {
      id: "fmx-launch-backdrop",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: MODAL_FALLBACK_COLORS.backdrop,
      zIndex: 100,
      visible: false,
      onMouseDown: () => this.close(),
    })
    this.dialog = new BoxRenderable(renderer, {
      id: "fmx-launch-dialog",
      position: "absolute",
      left: "50%",
      top: "50%",
      flexDirection: "column",
      paddingX: 1,
      border: true,
      borderStyle: "single",
      borderColor: MODAL_FALLBACK_COLORS.accent,
      backgroundColor: MODAL_FALLBACK_COLORS.background,
      title: DIALOG_TITLE,
      titleAlignment: "left",
      onMouseDown: (event) => event.stopPropagation(),
    })
    this.editor = new PromptEditor(renderer, { onChange: () => this.layout() })
    for (const [index, row] of ROWS.entries()) {
      const text = new TextRenderable(renderer, {
        id: `fmx-launch-row-${row}`,
        content: "",
        height: 1,
        // The prompt's label sits beside a field that grows; the chooser
        // rows are their whole line.
        width: row === "prompt" ? LABEL_COLUMN + 2 : undefined,
        selectable: false,
        onMouseDown: (event) => {
          // A press on a row is its primary action: focus it, and act where
          // the row has an action of its own.
          event.preventDefault()
          event.stopPropagation()
          this.setFocus(index)
          if (row === "worktree") this.toggleWorktree()
          else if (row === "project") this.openPicker()
        },
      })
      this.rowTexts.set(row, text)
      if (row !== "prompt") this.dialog.add(text)
    }
    this.promptRow = new BoxRenderable(renderer, {
      id: "fmx-launch-prompt-row",
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      onMouseDown: (event) => {
        event.stopPropagation()
        this.setFocus(ROWS.indexOf("prompt"))
      },
    })
    this.promptRow.add(this.rowTexts.get("prompt")!)
    this.promptRow.add(this.editor.root)
    // The prompt leads, as it does in the form fmx borrowed this from.
    this.dialog.insertBefore(this.promptRow, this.rowTexts.get("project"))

    this.picker = new BoxRenderable(renderer, {
      id: "fmx-launch-picker",
      position: "absolute",
      left: "50%",
      top: "50%",
      zIndex: 110,
      visible: false,
      flexDirection: "column",
      paddingX: 1,
      border: true,
      borderStyle: "single",
      borderColor: MODAL_FALLBACK_COLORS.accent,
      backgroundColor: MODAL_FALLBACK_COLORS.background,
      title: PICKER_TITLE,
      titleAlignment: "left",
      onMouseDown: (event) => event.stopPropagation(),
      onMouseScroll: (event) => {
        const direction = event.scroll?.direction
        if (direction !== "up" && direction !== "down") return
        // The wheel stays clamped where the arrows wrap: spatial scrolling
        // that teleports across the list reads as a glitch.
        this.moveHighlight(direction === "down" ? 1 : -1, false)
        event.preventDefault()
      },
    })
    this.filterText = new TextRenderable(renderer, {
      id: "fmx-launch-filter",
      content: "",
      height: 1,
      selectable: false,
    })
    this.pickerRows = new BoxRenderable(renderer, {
      id: "fmx-launch-picker-rows",
      flexDirection: "column",
      marginTop: 1,
    })
    this.picker.add(this.filterText)
    this.picker.add(this.pickerRows)

    this.root.add(this.dialog)
    this.root.add(this.picker)
  }

  isOpen(): boolean {
    return this.open
  }

  /** Opens over `projects`, on the choice for `preselect` when it is offered. */
  show(projects: readonly ProjectChoice[], preselect: string | null): void {
    this.projects = [...projects]
    const at = this.projects.findIndex((project) => project.directory === preselect)
    this.selected = at === -1 ? 0 : at
    this.editor.reset()
    this.worktree = false
    this.worktreeAvailable = null
    this.focus = 0
    this.open = true
    this.picking = false
    this.root.visible = true
    this.picker.visible = false
    this.editor.focus()
    this.askAboutWorktree()
    this.layout()
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.picking = false
    this.editor.blur()
    this.root.visible = false
    this.picker.visible = false
    this.clearRows()
    this.events.onClose()
    this.renderer.requestRender()
  }

  /** The answer to an earlier `onProjectChange`. A stale answer is dropped, so
   * a slow repository check cannot overwrite a newer selection. */
  setWorktreeAvailability(directory: string, available: boolean): void {
    if (this.projects[this.selected]?.directory !== directory) return
    this.worktreeAvailable = available
    if (!available) this.worktree = false
    if (this.open) this.layout()
  }

  applyPalette(colors: TerminalColors | null): void {
    this.colors = modalColors(colors)
    this.root.backgroundColor = this.colors.backdrop
    for (const box of [this.dialog, this.picker]) {
      box.backgroundColor = this.colors.background
      box.borderColor = this.colors.accent
      box.focusedBorderColor = this.colors.accent
      box.titleColor = this.colors.key
    }
    for (const text of [...this.rowTexts.values(), this.filterText]) {
      text.fg = this.colors.foreground
      text.bg = this.colors.background
    }
    this.promptRow.backgroundColor = this.colors.background
    this.editor.applyPalette(this.colors)
    if (this.open) this.layout()
  }

  /**
   * Answers whether the dialog kept the key. A false means the focused prompt
   * field should have it, and the caller must leave it alone: the widget is
   * fed by the renderer's own dispatch, which a swallowed key never reaches.
   */
  handleKey(key: KeyEvent): boolean {
    if (!this.open) return false
    // While $EDITOR holds the terminal the keys are its own.
    if (this.editor.suspended) return false
    // Escape steps back one layer, closing the picker onto the row it came
    // from; ctrl+c leaves outright, from whichever layer is in front.
    if (isCancelKey(key)) {
      this.close()
      return true
    }
    if (this.picking) {
      this.handlePickerKey(key)
      return true
    }
    if (this.currentRow() === "prompt" && !isStructuralKey(key)) {
      // The field owns every readline chord, ctrl+k included — it is
      // kill-to-line-end here whatever it may be on another row.
      this.editor.observe(key)
      return false
    }
    this.handleRowKey(key)
    return true
  }

  /** Paste reaches the focused field through the renderer; the dialog only
   * has to re-measure once it lands. */
  handlePaste(): void {
    if (this.open && this.currentRow() === "prompt") this.editor.observePaste()
  }

  layout(): void {
    if (!this.open) return
    const width = Math.max(DIALOG_MIN_WIDTH, Math.min(DIALOG_MAX_WIDTH, this.renderer.width - 8))
    const promptRows = this.editor.measure(width - 4 - LABEL_COLUMN - 2)
    this.promptRow.height = promptRows
    center(this.dialog, width, DIALOG_CHROME_HEIGHT + promptRows)
    this.paintRows(width - 4)
    if (this.picking) this.paintPicker(width)
    this.renderer.requestRender()
  }

  private currentRow(): Row {
    return ROWS[this.focus] ?? "prompt"
  }

  private handleRowKey(key: KeyEvent): void {
    if (key.name === "escape") {
      this.close()
      return
    }
    if (key.name === "tab" || key.name === "down") {
      this.moveFocus(1)
      return
    }
    if (key.name === "backtab" || key.name === "up") {
      this.moveFocus(-1)
      return
    }
    if (key.name === "enter" || key.name === "return") {
      // Enter on the prompt commits the text and moves on, the way it does in
      // any form; from a chooser there is nothing left to confirm, so it goes.
      if (this.currentRow() === "prompt") this.moveFocus(1)
      else this.launch()
      return
    }
    switch (this.currentRow()) {
      case "prompt":
        if (key.ctrl === true && key.name === "g") void this.editExternally()
        return
      case "project":
        this.handleProjectKey(key)
        return
      case "worktree":
        this.handleWorktreeKey(key)
        return
    }
  }

  private async editExternally(): Promise<void> {
    await this.editor.editExternally()
    if (!this.open) return
    this.editor.focus()
    this.layout()
  }

  private handleProjectKey(key: KeyEvent): void {
    if (key.name === "left") {
      this.step(-1)
      return
    }
    if (key.name === "right") {
      this.step(1)
      return
    }
    if (key.name === "space" || key.sequence === " ") {
      this.openPicker()
      return
    }
    const letter = printableFrom(key)
    if (letter === null) return
    const next = cycleByLetter(this.projects, this.selected, letter)
    if (next === this.selected) this.layout()
    else this.selectProject(next)
  }

  private handleWorktreeKey(key: KeyEvent): void {
    if (key.name === "space" || key.sequence === " " || key.name === "left" || key.name === "right") {
      this.toggleWorktree()
      return
    }
    // y and n say it outright, for a hand that would rather not count presses.
    const letter = printableFrom(key)?.toLowerCase()
    if (letter !== "y" && letter !== "n") return
    this.worktree = letter === "y" && this.worktreeAvailable !== false
    this.layout()
  }

  private handlePickerKey(key: KeyEvent): void {
    if (key.name === "escape") {
      this.closePicker()
      return
    }
    if (key.name === "enter" || key.name === "return") {
      const chosen = this.matches()[this.highlighted]
      if (!chosen) return
      this.selectProject(this.projects.indexOf(chosen))
      this.closePicker()
      return
    }
    if (key.name === "up") {
      this.moveHighlight(-1, true)
      return
    }
    if (key.name === "down") {
      this.moveHighlight(1, true)
      return
    }
    if (key.name === "backspace") {
      this.setFilter(this.filter.slice(0, -1))
      return
    }
    const character = printableFrom(key)
    if (character) this.setFilter(this.filter + character)
  }

  private moveFocus(delta: number): void {
    this.setFocus((((this.focus + delta) % ROWS.length) + ROWS.length) % ROWS.length)
  }

  /** Focus is the field's too: a blurred field neither takes keys nor draws a
   * cursor, which is what leaves a letter on the project row free to cycle. */
  private setFocus(index: number): void {
    this.focus = index
    if (this.currentRow() === "prompt") this.editor.focus()
    else this.editor.blur()
    this.layout()
  }

  private toggleWorktree(): void {
    if (this.worktreeAvailable === false) return
    this.worktree = !this.worktree
    this.layout()
  }

  private selectProject(index: number): void {
    this.selected = index
    this.worktreeAvailable = null
    this.askAboutWorktree()
    this.layout()
  }

  /** Focus without a repaint, for callers that lay out immediately after. */
  private setFocusQuietly(index: number): void {
    this.focus = index
    this.editor.blur()
  }

  private askAboutWorktree(): void {
    const directory = this.projects[this.selected]?.directory
    if (directory) this.events.onProjectChange(directory)
  }

  private openPicker(): void {
    if (this.projects.length === 0) return
    this.setFocusQuietly(ROWS.indexOf("project"))
    this.picking = true
    this.filter = ""
    // The picker opens on the row's own choice, so dismissing it changes
    // nothing and choosing from where you already are is one keystroke.
    this.highlighted = this.selected
    this.scroll = 0
    this.picker.visible = true
    this.layout()
  }

  private closePicker(): void {
    this.picking = false
    this.picker.visible = false
    this.clearRows()
    this.layout()
  }

  private launch(): void {
    const project = this.projects[this.selected]
    if (!project) return
    const request: LaunchRequest = {
      directory: project.directory,
      prompt: this.editor.text.trim(),
      worktree: this.worktree,
    }
    this.close()
    this.events.onLaunch(request)
  }

  private step(delta: number): void {
    const count = this.projects.length
    if (count === 0) return
    this.selectProject((((this.selected + delta) % count) + count) % count)
  }

  private moveHighlight(delta: number, wrap: boolean): void {
    const count = this.matches().length
    if (count === 0) return
    const next = this.highlighted + delta
    if (wrap) this.highlighted = ((next % count) + count) % count
    else this.highlighted = Math.min(count - 1, Math.max(0, next))
    this.layout()
  }

  private setFilter(filter: string): void {
    this.filter = filter
    this.highlighted = 0
    this.scroll = 0
    this.layout()
  }

  private matches(): ProjectChoice[] {
    return matchProjects(this.projects, this.filter)
  }

  private paintRows(inner: number): void {
    const project = this.projects[this.selected]
    const available = Math.max(4, inner - 2 - LABEL_COLUMN)
    for (const [index, row] of ROWS.entries()) {
      const text = this.rowTexts.get(row)
      if (!text) continue
      text.content = new StyledText([
        index === this.focus ? bold(fg(this.colors.accent)("▎ ")) : fg(this.colors.background)("  "),
        fg(this.colors.key)(row.padEnd(LABEL_COLUMN)),
        ...this.rowValue(row, project, available),
      ])
    }
  }

  private rowValue(row: Row, project: ProjectChoice | undefined, width: number): TextChunk[] {
    switch (row) {
      // The prompt draws itself: the field is a renderable beside the label,
      // with its own cursor, scroll, and placeholder.
      case "prompt":
        return []
      case "project":
        return [
          project
            ? fg(this.colors.foreground)(truncate(project.display, width))
            : fg(this.colors.key)(truncate(EMPTY, width)),
        ]
      case "worktree":
        return this.worktreeAvailable === false
          ? [fg(this.colors.dim)(truncate(WORKTREE_UNAVAILABLE, width))]
          : [fg(this.colors.foreground)(this.worktree ? "yes" : "no")]
    }
  }

  private paintPicker(width: number): void {
    const visible = this.matches()
    if (this.highlighted >= visible.length) this.highlighted = Math.max(0, visible.length - 1)
    const rowCount = Math.min(
      Math.max(1, visible.length),
      Math.max(3, this.renderer.height - 8),
      PICKER_MAX_ROWS,
    )
    if (this.highlighted < this.scroll) this.scroll = this.highlighted
    if (this.highlighted >= this.scroll + rowCount) this.scroll = this.highlighted - rowCount + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, visible.length - rowCount)))
    center(this.picker, width, rowCount + 4)

    this.filterText.content = new StyledText([
      bold(fg(this.colors.accent)("> ")),
      this.filter.length > 0
        ? fg(this.colors.foreground)(this.filter)
        : fg(this.colors.dim)(PICKER_HINT),
    ])

    this.clearRows()
    const inner = width - 4
    if (visible.length === 0) {
      this.pickerRows.add(
        new TextRenderable(this.renderer, {
          id: "fmx-launch-picker-empty",
          content: new StyledText([fg(this.colors.key)("no match")]),
          height: 1,
          selectable: false,
        }),
      )
      return
    }
    for (const [offset, project] of visible.slice(this.scroll, this.scroll + rowCount).entries()) {
      const index = this.scroll + offset
      const row = new BoxRenderable(this.renderer, {
        id: `fmx-launch-picker-row-${index}`,
        width: "100%",
        height: 1,
        flexShrink: 0,
        backgroundColor: this.colors.background,
        onMouseDown: (event) => {
          event.preventDefault()
          event.stopPropagation()
          this.selectProject(this.projects.indexOf(project))
          this.closePicker()
        },
      })
      const isHighlighted = index === this.highlighted
      // The launch count orders the list and nothing more: a tally beside
      // every project is noise in a list already sorted by it.
      row.add(
        new TextRenderable(this.renderer, {
          id: `fmx-launch-picker-text-${index}`,
          content: new StyledText([
            isHighlighted ? bold(fg(this.colors.accent)("▎ ")) : fg(this.colors.background)("  "),
            fg(isHighlighted ? this.colors.foreground : this.colors.key)(
              truncate(project.display, Math.max(4, inner - 2)),
            ),
          ]),
          selectable: false,
        }),
      )
      this.pickerRows.add(row)
    }
  }

  private clearRows(): void {
    for (const child of this.pickerRows.getChildren()) {
      this.pickerRows.remove(child)
      child.destroyRecursively()
    }
  }
}

function center(box: BoxRenderable, width: number, height: number): void {
  box.width = width
  box.height = height
  box.marginLeft = -Math.floor(width / 2)
  box.marginTop = -Math.floor(height / 2)
}

/** The one printable character a key event carries, or null for anything
 * modified, named, or invisible. */
function printableFrom(key: KeyEvent): string | null {
  if (key.ctrl || key.meta || key.option) return null
  const sequence = key.sequence ?? ""
  if ([...sequence].length !== 1) return null
  const character = [...sequence][0]!
  const codepoint = character.codePointAt(0)!
  if (codepoint < 0x20 || codepoint === 0x7f) return null
  return character
}

function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  const characters = [...value]
  if (characters.length <= width) return value
  if (width === 1) return "…"
  return `${characters.slice(0, width - 1).join("")}…`
}
