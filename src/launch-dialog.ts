import {
  bold,
  BoxRenderable,
  type CliRenderer,
  fg,
  type KeyEvent,
  StyledText,
  type TerminalColors,
  TextRenderable,
} from "@opentui/core"
import { MODAL_FALLBACK_COLORS, type ModalColors, modalColors } from "./host-palette.ts"
import { isCancelKey } from "./keybindings.ts"
import { cycleByLetter, matchProjects, type ProjectChoice } from "./projects.ts"

/**
 * The launch dialog: what an instance is started with, gathered before fx
 * runs. Today that is one choice — the project — so the dialog is one row, but
 * it is a row rather than a bare list on purpose. A row answers a letter by
 * cycling to the next project starting with it, which is the fastest way to
 * reach a project whose name you know; the project picker it opens on space
 * answers a filter instead, which is the way to reach one you only half
 * remember. Further choices join as further rows.
 */

const DIALOG_TITLE = " launch "
const PICKER_TITLE = " project "
const DIALOG_MAX_WIDTH = 56
const DIALOG_MIN_WIDTH = 32
/** Border, the row, a blank line, and the hint. */
const DIALOG_HEIGHT = 5
const PICKER_MAX_ROWS = 10
const ROW_LABEL = "project"
const HINT = "space pick · ←→ cycle · ⏎ start · esc cancel"
const PICKER_HINT = "type to filter"
const EMPTY = "no projects found — set project_roots in the config"

type LaunchDialogEvents = {
  onLaunch: (directory: string) => void
  onClose: () => void
}

export class LaunchDialog {
  readonly root: BoxRenderable
  private readonly dialog: BoxRenderable
  private readonly rowText: TextRenderable
  private readonly hintText: TextRenderable
  private readonly picker: BoxRenderable
  private readonly filterText: TextRenderable
  private readonly pickerRows: BoxRenderable
  private rows: BoxRenderable[] = []

  private colors: ModalColors = MODAL_FALLBACK_COLORS
  private projects: ProjectChoice[] = []
  private selected = 0
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
    this.rowText = new TextRenderable(renderer, {
      id: "fmx-launch-row",
      content: "",
      height: 1,
      selectable: false,
    })
    this.hintText = new TextRenderable(renderer, {
      id: "fmx-launch-hint",
      content: "",
      height: 1,
      marginTop: 1,
      selectable: false,
    })
    this.dialog.add(this.rowText)
    this.dialog.add(this.hintText)

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
    this.open = true
    this.picking = false
    this.root.visible = true
    this.picker.visible = false
    this.layout()
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.picking = false
    this.root.visible = false
    this.picker.visible = false
    this.clearRows()
    this.events.onClose()
    this.renderer.requestRender()
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
    for (const text of [this.rowText, this.hintText, this.filterText]) {
      text.fg = this.colors.foreground
      text.bg = this.colors.background
    }
    if (this.open) this.layout()
  }

  /** Every key while the dialog is open belongs to it; the caller has already
   * swallowed it, so nothing here needs to fall through. */
  handleKey(key: KeyEvent): void {
    if (!this.open) return
    // Escape steps back one layer, closing the picker onto the row it came
    // from; ctrl+c leaves outright, from whichever layer is in front.
    if (isCancelKey(key)) {
      this.close()
      return
    }
    if (this.picking) this.handlePickerKey(key)
    else this.handleRowKey(key)
  }

  layout(): void {
    if (!this.open) return
    const width = Math.max(
      DIALOG_MIN_WIDTH,
      Math.min(DIALOG_MAX_WIDTH, this.renderer.width - 8),
    )
    center(this.dialog, width, DIALOG_HEIGHT)
    this.paintRow(width - 4)
    if (this.picking) this.paintPicker(width)
    this.renderer.requestRender()
  }

  private handleRowKey(key: KeyEvent): void {
    if (key.name === "escape") {
      this.close()
      return
    }
    if (key.name === "enter" || key.name === "return") {
      this.launch(this.projects[this.selected])
      return
    }
    // One row, so every arrow steps its value. A second row would give the
    // vertical pair to row movement and leave stepping to left and right.
    if (key.name === "left" || key.name === "up") {
      this.step(-1)
      return
    }
    if (key.name === "right" || key.name === "down") {
      this.step(1)
      return
    }
    if (key.name === "space" || key.sequence === " ") {
      this.openPicker()
      return
    }
    const letter = printableFrom(key)
    if (letter) {
      this.selected = cycleByLetter(this.projects, this.selected, letter)
      this.layout()
    }
  }

  private handlePickerKey(key: KeyEvent): void {
    if (key.name === "escape") {
      this.closePicker()
      return
    }
    if (key.name === "enter" || key.name === "return") {
      const chosen = this.matches()[this.highlighted]
      if (!chosen) return
      this.selected = this.projects.indexOf(chosen)
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

  private openPicker(): void {
    if (this.projects.length === 0) return
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

  private launch(project: ProjectChoice | undefined): void {
    if (!project) return
    const { directory } = project
    this.close()
    this.events.onLaunch(directory)
  }

  private step(delta: number): void {
    const count = this.projects.length
    if (count === 0) return
    this.selected = (((this.selected + delta) % count) + count) % count
    this.layout()
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

  private paintRow(inner: number): void {
    const project = this.projects[this.selected]
    if (!project) {
      this.rowText.content = new StyledText([fg(this.colors.key)(EMPTY)])
      this.hintText.content = new StyledText([fg(this.colors.key)("esc cancel")])
      return
    }
    const label = `${ROW_LABEL}  `
    const available = Math.max(4, inner - 2 - label.length)
    this.rowText.content = new StyledText([
      bold(fg(this.colors.accent)("▎ ")),
      fg(this.colors.key)(label),
      fg(this.colors.foreground)(truncate(project.display, available)),
    ])
    this.hintText.content = new StyledText([fg(this.colors.key)(truncate(HINT, inner))])
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
        : fg(this.colors.key)(PICKER_HINT),
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
          this.selected = this.projects.indexOf(project)
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
      this.rows.push(row)
    }
  }

  private clearRows(): void {
    for (const child of this.pickerRows.getChildren()) {
      this.pickerRows.remove(child)
      child.destroyRecursively()
    }
    this.rows = []
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
