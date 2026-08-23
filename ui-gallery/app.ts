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
import {
  UI_GALLERY_COMPONENTS,
  UI_GALLERY_PALETTES,
  type RenderedUiStory,
  type UiGalleryComponent,
  type UiGalleryPaletteName,
  type UiGalleryStoriesByPalette,
} from "./story.ts"

const RAIL_WIDTH = 30
const RAIL_MIN_WIDTH = 22
const PREVIEW_MIN_WIDTH = 30

type GalleryTheme = {
  background: RGBA
  foreground: RGBA
  dim: RGBA
  accent: RGBA
  signal: RGBA
  selectedBackground: RGBA
}

export class UiGalleryApp {
  readonly root: BoxRenderable

  private readonly components: readonly UiGalleryComponent[]
  private readonly rail: BoxRenderable
  private readonly identity: TextRenderable
  private readonly componentList: ScrollBoxRenderable
  private readonly componentRows = new Map<UiGalleryComponent, BoxRenderable>()
  private readonly componentLabels = new Map<UiGalleryComponent, TextRenderable>()
  private readonly hints: TextRenderable
  private readonly divider: BoxRenderable
  private readonly preview: BoxRenderable
  private readonly previewHeading: TextRenderable
  private readonly previewDescription: TextRenderable
  private readonly previewScroll: ScrollBoxRenderable
  private readonly stateByComponent = new Map<UiGalleryComponent, number>()
  private frame: BoxRenderable | null = null
  private palette: UiGalleryPaletteName = "dark"
  private selectedComponent = 0
  private closed = false
  private readonly done: Promise<void>
  private resolveDone!: () => void

  constructor(
    private readonly renderer: CliRenderer,
    private readonly storiesByPalette: UiGalleryStoriesByPalette,
  ) {
    if (storiesByPalette.dark.length === 0 || storiesByPalette.light.length === 0) {
      throw new Error("the UI gallery needs at least one state in each theme")
    }
    const darkIds = storiesByPalette.dark.map((story) => story.id).join("\0")
    const lightIds = storiesByPalette.light.map((story) => story.id).join("\0")
    if (darkIds !== lightIds) throw new Error("the UI gallery themes must contain the same states")
    this.components = UI_GALLERY_COMPONENTS.filter((component) =>
      storiesByPalette.dark.some((story) => story.component === component),
    )
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
    this.identity = new TextRenderable(renderer, {
      id: "ui-gallery-identity",
      height: 3,
      flexShrink: 0,
      selectable: false,
      content: "",
    })
    this.componentList = new ScrollBoxRenderable(renderer, {
      id: "ui-gallery-component-list",
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      scrollX: false,
      scrollY: true,
      viewportCulling: true,
      contentOptions: { flexDirection: "column" },
    })
    this.hints = new TextRenderable(renderer, {
      id: "ui-gallery-hints",
      height: 4,
      flexShrink: 0,
      selectable: false,
      content: "",
    })
    this.rail.add(this.identity)
    this.rail.add(this.componentList)
    this.rail.add(this.hints)
    this.buildComponentList()

    this.divider = new BoxRenderable(renderer, {
      id: "ui-gallery-divider",
      width: 1,
      height: "100%",
      flexShrink: 0,
      border: ["left"],
      borderStyle: "single",
    })
    this.preview = new BoxRenderable(renderer, {
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
    this.preview.add(this.previewHeading)
    this.preview.add(this.previewDescription)
    this.preview.add(this.previewScroll)

    this.root.add(this.rail)
    this.root.add(this.divider)
    this.root.add(this.preview)
    renderer.root.add(this.root)
    renderer.keyInput.on("keypress", this.keypressHandler)
    this.applyTheme()
    this.showComponent(0)
  }

  get activeStoryId(): string {
    return this.activeStory.id
  }

  get activePalette(): UiGalleryPaletteName {
    return this.palette
  }

  get activeComponent(): UiGalleryComponent {
    return this.components[this.selectedComponent]!
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

  private get stories(): readonly RenderedUiStory[] {
    return this.storiesByPalette[this.palette]
  }

  private get activeStory(): RenderedUiStory {
    const states = this.statesFor(this.activeComponent)
    return states[this.stateIndex(this.activeComponent)]!
  }

  private readonly keypressHandler = (key: KeyEvent): void => {
    if (key.name === "escape" || key.name === "q" || (key.ctrl === true && key.name === "c")) {
      this.swallow(key)
      this.close()
      return
    }
    if (key.name === "down" || key.name === "j") {
      this.swallow(key)
      this.showComponent(this.selectedComponent + 1)
      return
    }
    if (key.name === "up" || key.name === "k") {
      this.swallow(key)
      this.showComponent(this.selectedComponent - 1)
      return
    }
    if (key.name === "home") {
      this.swallow(key)
      this.showComponent(0)
      return
    }
    if (key.name === "end") {
      this.swallow(key)
      this.showComponent(this.components.length - 1)
      return
    }
    if (key.name === "left" || key.name === "h") {
      this.swallow(key)
      this.cycleState(-1)
      return
    }
    if (key.name === "right" || key.name === "l") {
      this.swallow(key)
      this.cycleState(1)
      return
    }
    if (key.name === "t") {
      this.swallow(key)
      this.palette = this.palette === "dark" ? "light" : "dark"
      this.applyTheme()
      this.showActiveStory()
      return
    }
    if (key.name === "[") {
      this.swallow(key)
      this.previewScroll.scrollBy({ x: -4, y: 0 }, "absolute")
      return
    }
    if (key.name === "]") {
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

  private buildComponentList(): void {
    for (const [index, component] of this.components.entries()) {
      const label = new TextRenderable(this.renderer, {
        id: `ui-gallery-component-label-${slug(component)}`,
        content: "",
        height: 1,
        selectable: false,
      })
      const row = new BoxRenderable(this.renderer, {
        id: `ui-gallery-component-${slug(component)}`,
        width: "100%",
        height: 1,
        flexShrink: 0,
        onMouseDown: (event) => {
          event.preventDefault()
          event.stopPropagation()
          this.showComponent(index)
        },
      })
      row.add(label)
      this.componentLabels.set(component, label)
      this.componentRows.set(component, row)
      this.componentList.add(row)
    }
  }

  private showComponent(index: number): void {
    this.selectedComponent = Math.max(0, Math.min(this.components.length - 1, index))
    const component = this.activeComponent
    if (!this.stateByComponent.has(component)) this.stateByComponent.set(component, 0)
    this.paintComponentList()
    this.componentList.scrollChildIntoView(`ui-gallery-component-${slug(component)}`)
    this.showActiveStory()
  }

  private cycleState(offset: number): void {
    const component = this.activeComponent
    const states = this.statesFor(component)
    const next = (this.stateIndex(component) + offset + states.length) % states.length
    this.stateByComponent.set(component, next)
    this.showActiveStory()
  }

  private showActiveStory(): void {
    const story = this.activeStory
    const states = this.statesFor(story.component)
    const theme = galleryTheme(this.palette)
    this.previewScroll.scrollTo({ x: 0, y: 0 })
    this.previewHeading.content = new StyledText([
      textChunk(story.component, theme.accent, undefined, TextAttributes.BOLD),
      textChunk(` · state ${this.stateIndex(story.component) + 1}/${states.length}`, theme.dim),
      textChunk(`\n${story.title}`, theme.foreground, undefined, TextAttributes.BOLD),
      textChunk(` · ${story.frame.cols}×${story.frame.rows}`, theme.dim),
    ])
    this.previewDescription.fg = theme.dim
    this.previewDescription.content = story.description

    if (this.frame) {
      this.previewScroll.remove(this.frame)
      this.frame.destroyRecursively()
    }
    this.frame = new BoxRenderable(this.renderer, {
      id: "ui-gallery-frame",
      width: story.frame.cols,
      height: story.frame.rows,
      flexShrink: 0,
      backgroundColor: theme.background,
    })
    this.frame.add(
      new TextRenderable(this.renderer, {
        id: "ui-gallery-frame-text",
        width: story.frame.cols,
        height: story.frame.rows,
        flexShrink: 0,
        selectable: true,
        content: frameText(story, theme.foreground),
      }),
    )
    this.previewScroll.add(this.frame)
    this.renderer.requestRender()
  }

  private applyTheme(): void {
    const theme = galleryTheme(this.palette)
    this.root.backgroundColor = theme.background
    this.rail.backgroundColor = theme.background
    this.componentList.backgroundColor = theme.background
    this.divider.backgroundColor = theme.background
    this.divider.borderColor = theme.dim
    this.preview.backgroundColor = theme.background
    this.previewScroll.backgroundColor = theme.background
    this.previewDescription.fg = theme.dim
    this.identity.content = new StyledText([
      textChunk("UI GALLERY", theme.accent, undefined, TextAttributes.BOLD),
      textChunk(`  ${this.palette.toUpperCase()}`, theme.signal, undefined, TextAttributes.BOLD),
      textChunk(`\n${this.components.length} components`, theme.foreground),
      textChunk(` · ${this.stories.length} states`, theme.dim),
    ])
    this.hints.content = new StyledText([
      textChunk("↑↓", theme.accent, undefined, TextAttributes.BOLD),
      textChunk(" component", theme.dim),
      textChunk("\n←→", theme.accent, undefined, TextAttributes.BOLD),
      textChunk(" state", theme.dim),
      textChunk("\npgup/pgdn scroll", theme.dim),
      textChunk("\n[ ] pan · ", theme.dim),
      textChunk("t", theme.accent, undefined, TextAttributes.BOLD),
      textChunk(" theme · q close", theme.dim),
    ])
    this.paintComponentList()
    this.renderer.requestRender()
  }

  private paintComponentList(): void {
    const theme = galleryTheme(this.palette)
    for (const [index, component] of this.components.entries()) {
      const active = index === this.selectedComponent
      const row = this.componentRows.get(component)
      const label = this.componentLabels.get(component)
      if (!row || !label) continue
      const count = this.statesFor(component).length
      row.backgroundColor = active ? theme.selectedBackground : theme.background
      label.content = new StyledText([
        textChunk(active ? "▎ " : "  ", active ? theme.accent : theme.dim, undefined, active ? TextAttributes.BOLD : 0),
        textChunk(truncate(component, Math.max(4, this.railWidth() - 10)), active ? theme.foreground : theme.dim),
        textChunk(` · ${count}`, active ? theme.signal : theme.dim),
      ])
    }
  }

  private statesFor(component: UiGalleryComponent): readonly RenderedUiStory[] {
    return this.stories.filter((story) => story.component === component)
  }

  private stateIndex(component: UiGalleryComponent): number {
    return this.stateByComponent.get(component) ?? 0
  }

  private railWidth(): number {
    return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_WIDTH, this.renderer.width - PREVIEW_MIN_WIDTH - 1))
  }

  private swallow(key: KeyEvent): void {
    key.preventDefault()
    key.stopPropagation()
  }
}

function frameText(story: RenderedUiStory, foreground: RGBA): StyledText {
  const chunks: TextChunk[] = []
  for (const [lineIndex, line] of story.frame.lines.entries()) {
    for (const span of line.spans) {
      chunks.push(textChunk(span.text, span.fg, span.bg, span.attributes))
    }
    if (lineIndex < story.frame.lines.length - 1) {
      chunks.push(
        textChunk(
          "\n",
          foreground,
          RGBA.fromHex(UI_GALLERY_PALETTES[story.palette].defaultBackground ?? "#171c23"),
        ),
      )
    }
  }
  return new StyledText(chunks)
}

function galleryTheme(name: UiGalleryPaletteName): GalleryTheme {
  const palette = UI_GALLERY_PALETTES[name]
  return {
    background: RGBA.fromHex(palette.defaultBackground ?? "#171c23"),
    foreground: RGBA.fromHex(palette.defaultForeground ?? "#dbe3eb"),
    dim: RGBA.fromHex(palette.palette[8] ?? "#687384"),
    accent: RGBA.fromHex(palette.palette[6] ?? "#67c7c2"),
    signal: RGBA.fromHex(palette.palette[3] ?? "#e5c07b"),
    selectedBackground: RGBA.fromHex(name === "dark" ? "#2a3640" : "#d5dfde"),
  }
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
