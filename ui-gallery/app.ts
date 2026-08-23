import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { UI_GALLERY_PALETTES, type RenderedUiStory, type UiGalleryComponent } from "./story.ts"

const RAIL_WIDTH = 34
const RAIL_MIN_WIDTH = 24
const PREVIEW_MIN_WIDTH = 30
const SELECTED_BACKGROUND = "#2a3640"

const FOREGROUND = RGBA.fromIndex(7)
const DIM = RGBA.fromIndex(8)
const ACCENT = RGBA.fromIndex(6)
const SIGNAL = RGBA.fromIndex(3)

export class UiGalleryApp {
  readonly root: BoxRenderable

  private readonly rail: BoxRenderable
  private readonly storyList: ScrollBoxRenderable
  private readonly storyRows = new Map<string, BoxRenderable>()
  private readonly storyLabels = new Map<string, TextRenderable>()
  private readonly previewHeading: TextRenderable
  private readonly previewDescription: TextRenderable
  private readonly previewScroll: ScrollBoxRenderable
  private frame: BoxRenderable | null = null
  private selected = 0
  private closed = false
  private readonly done: Promise<void>
  private resolveDone!: () => void

  constructor(
    private readonly renderer: CliRenderer,
    private readonly stories: readonly RenderedUiStory[],
  ) {
    if (stories.length === 0) throw new Error("the UI gallery needs at least one story")
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })

    this.root = new BoxRenderable(renderer, {
      id: "ui-gallery",
      width: "100%",
      height: "100%",
      flexDirection: "row",
    })
    this.rail = new BoxRenderable(renderer, {
      id: "ui-gallery-rail",
      width: this.railWidth(),
      height: "100%",
      flexShrink: 0,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    })
    const identity = new TextRenderable(renderer, {
      id: "ui-gallery-identity",
      height: 3,
      flexShrink: 0,
      selectable: false,
      content: new StyledText([
        textChunk("UI GALLERY", ACCENT, undefined, TextAttributes.BOLD),
        textChunk(`\n${stories.length} examples`, FOREGROUND),
        textChunk(` · ${new Set(stories.map((story) => story.component)).size} components`, DIM),
      ]),
    })
    this.storyList = new ScrollBoxRenderable(renderer, {
      id: "ui-gallery-story-list",
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      scrollX: false,
      scrollY: true,
      viewportCulling: true,
      contentOptions: { flexDirection: "column" },
    })
    const hints = new TextRenderable(renderer, {
      id: "ui-gallery-hints",
      height: 2,
      flexShrink: 0,
      selectable: false,
      content: new StyledText([
        textChunk("↑↓", ACCENT, undefined, TextAttributes.BOLD),
        textChunk(" browse   ", DIM),
        textChunk("←→", ACCENT, undefined, TextAttributes.BOLD),
        textChunk(" frame", DIM),
        textChunk("\npgup/pgdn scroll   q close", DIM),
      ]),
    })
    this.rail.add(identity)
    this.rail.add(this.storyList)
    this.rail.add(hints)
    this.buildStoryList()

    const divider = new BoxRenderable(renderer, {
      id: "ui-gallery-divider",
      width: 1,
      height: "100%",
      flexShrink: 0,
      border: ["left"],
      borderStyle: "single",
      borderColor: DIM,
    })
    const preview = new BoxRenderable(renderer, {
      id: "ui-gallery-preview",
      flexGrow: 1,
      flexShrink: 1,
      height: "100%",
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 1,
    })
    this.previewHeading = new TextRenderable(renderer, {
      id: "ui-gallery-preview-heading",
      height: 2,
      flexShrink: 0,
      selectable: false,
      content: "",
    })
    this.previewDescription = new TextRenderable(renderer, {
      id: "ui-gallery-preview-description",
      height: 2,
      flexShrink: 0,
      selectable: false,
      fg: DIM,
      content: "",
    })
    this.previewScroll = new ScrollBoxRenderable(renderer, {
      id: "ui-gallery-preview-scroll",
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      scrollX: true,
      scrollY: true,
      viewportCulling: true,
      paddingTop: 1,
      paddingBottom: 1,
      contentOptions: { flexDirection: "column" },
    })
    preview.add(this.previewHeading)
    preview.add(this.previewDescription)
    preview.add(this.previewScroll)

    this.root.add(this.rail)
    this.root.add(divider)
    this.root.add(preview)
    renderer.root.add(this.root)
    renderer.keyInput.on("keypress", this.keypressHandler)
    this.showStory(0)
  }

  get activeStoryId(): string {
    return this.stories[this.selected]!.id
  }

  waitUntilDone(): Promise<void> {
    return this.done
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.renderer.keyInput.off("keypress", this.keypressHandler)
    this.resolveDone()
  }

  destroy(): void {
    this.close()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }

  private readonly keypressHandler = (key: KeyEvent): void => {
    if (key.name === "escape" || key.name === "q" || (key.ctrl === true && key.name === "c")) {
      this.swallow(key)
      this.close()
      return
    }
    if (key.name === "down" || key.name === "j") {
      this.swallow(key)
      this.showStory(this.selected + 1)
      return
    }
    if (key.name === "up" || key.name === "k") {
      this.swallow(key)
      this.showStory(this.selected - 1)
      return
    }
    if (key.name === "home") {
      this.swallow(key)
      this.showStory(0)
      return
    }
    if (key.name === "end") {
      this.swallow(key)
      this.showStory(this.stories.length - 1)
      return
    }
    if (key.name === "left" || key.name === "h") {
      this.swallow(key)
      this.previewScroll.scrollBy({ x: -4, y: 0 }, "absolute")
      return
    }
    if (key.name === "right" || key.name === "l") {
      this.swallow(key)
      this.previewScroll.scrollBy({ x: 4, y: 0 }, "absolute")
      return
    }
    if (key.name === "pageup") {
      this.swallow(key)
      this.previewScroll.scrollBy({ x: 0, y: -1 }, "viewport")
      return
    }
    if (key.name === "pagedown") {
      this.swallow(key)
      this.previewScroll.scrollBy({ x: 0, y: 1 }, "viewport")
    }
  }

  private buildStoryList(): void {
    let component: UiGalleryComponent | null = null
    for (const [index, story] of this.stories.entries()) {
      if (story.component !== component) {
        component = story.component
        this.storyList.add(
          new TextRenderable(this.renderer, {
            id: `ui-gallery-group-${slug(component)}`,
            height: 2,
            flexShrink: 0,
            paddingTop: 1,
            selectable: false,
            content: new StyledText([textChunk(component.toUpperCase(), SIGNAL, undefined, TextAttributes.BOLD)]),
          }),
        )
      }
      const label = new TextRenderable(this.renderer, {
        id: `ui-gallery-story-label-${story.id}`,
        content: "",
        height: 1,
        selectable: false,
      })
      const row = new BoxRenderable(this.renderer, {
        id: `ui-gallery-story-${story.id}`,
        width: "100%",
        height: 1,
        flexShrink: 0,
        onMouseDown: (event) => {
          event.preventDefault()
          event.stopPropagation()
          this.showStory(index)
        },
      })
      row.add(label)
      this.storyLabels.set(story.id, label)
      this.storyRows.set(story.id, row)
      this.storyList.add(row)
    }
  }

  private showStory(index: number): void {
    const normalized = Math.max(0, Math.min(this.stories.length - 1, index))
    this.selected = normalized
    const story = this.stories[normalized]!
    this.paintStoryList()
    this.storyList.scrollChildIntoView(`ui-gallery-story-${story.id}`)
    this.previewScroll.scrollTo({ x: 0, y: 0 })

    this.previewHeading.content = new StyledText([
      textChunk(story.title, FOREGROUND, undefined, TextAttributes.BOLD),
      textChunk(`\n${story.component}`, ACCENT, undefined, TextAttributes.BOLD),
      textChunk(` · ${story.palette} · ${story.frame.cols}×${story.frame.rows}`, DIM),
    ])
    this.previewDescription.content = story.description

    if (this.frame) {
      this.previewScroll.remove(this.frame)
      this.frame.destroyRecursively()
    }
    const background = UI_GALLERY_PALETTES[story.palette].defaultBackground ?? "#171c23"
    this.frame = new BoxRenderable(this.renderer, {
      id: "ui-gallery-frame",
      width: story.frame.cols,
      height: story.frame.rows,
      flexShrink: 0,
      backgroundColor: background,
    })
    this.frame.add(
      new TextRenderable(this.renderer, {
        id: "ui-gallery-frame-text",
        width: story.frame.cols,
        height: story.frame.rows,
        flexShrink: 0,
        selectable: true,
        content: frameText(story),
      }),
    )
    this.previewScroll.add(this.frame)
    this.renderer.requestRender()
  }

  private paintStoryList(): void {
    for (const [index, story] of this.stories.entries()) {
      const active = index === this.selected
      const row = this.storyRows.get(story.id)
      const label = this.storyLabels.get(story.id)
      if (!row || !label) continue
      row.backgroundColor = active ? SELECTED_BACKGROUND : undefined
      label.content = new StyledText([
        textChunk(active ? "▎ " : "  ", active ? ACCENT : DIM, undefined, active ? TextAttributes.BOLD : 0),
        textChunk(truncate(story.title, Math.max(4, this.railWidth() - 4)), active ? FOREGROUND : DIM),
      ])
    }
  }

  private railWidth(): number {
    return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_WIDTH, this.renderer.width - PREVIEW_MIN_WIDTH - 1))
  }

  private swallow(key: KeyEvent): void {
    key.preventDefault()
    key.stopPropagation()
  }
}

function frameText(story: RenderedUiStory): StyledText {
  const chunks: TextChunk[] = []
  for (const [lineIndex, line] of story.frame.lines.entries()) {
    for (const span of line.spans) {
      chunks.push(textChunk(span.text, span.fg, span.bg, span.attributes))
    }
    if (lineIndex < story.frame.lines.length - 1) {
      chunks.push(
        textChunk(
          "\n",
          FOREGROUND,
          RGBA.fromHex(UI_GALLERY_PALETTES[story.palette].defaultBackground ?? "#171c23"),
        ),
      )
    }
  }
  return new StyledText(chunks)
}

function textChunk(text: string, foreground: RGBA, background?: RGBA, attributes = 0): TextChunk {
  return { __isChunk: true, text, fg: foreground, bg: background, attributes }
}

function truncate(value: string, width: number): string {
  const characters = [...value]
  if (characters.length <= width) return value
  if (width <= 1) return "…"
  return `${characters.slice(0, width - 1).join("")}…`
}

function slug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "")
}
