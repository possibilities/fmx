import {
  BoxRenderable,
  type CapturedFrame,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { RAMP_FALLBACK } from "../src/host-palette.ts"
import {
  UI_GALLERY_COMPONENTS,
  UI_GALLERY_PALETTE_NAMES,
  UI_GALLERY_PALETTES,
  type RenderedUiStory,
  type UiStory,
  UiStorySession,
  type UiGalleryComponent,
  type UiGalleryPaletteName,
  type UiGalleryStoriesByPalette,
} from "./story.ts"

const RAIL_WIDTH = 26
const RAIL_MIN_WIDTH = 22
const PREVIEW_MIN_WIDTH = 30
const DEFAULT_SLIDESHOW_INTERVAL_MS = 3_000

type UiGalleryAppOptions = {
  slideshowIntervalMs?: number
}

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
  private readonly previewInteraction: TextRenderable
  private readonly previewScroll: ScrollBoxRenderable
  private readonly sourceById: ReadonlyMap<string, UiStory>
  private readonly stateByComponent = new Map<UiGalleryComponent, number>()
  private frame: BoxRenderable | null = null
  private frameText: TextRenderable | null = null
  private interactionSession: UiStorySession | null = null
  private interactionTask: Promise<void> = Promise.resolve()
  private interactionGeneration = 0
  private interacting = false
  private interactionPending = false
  private slideshow = false
  private slideshowPaused = false
  private slideshowTimer: ReturnType<typeof setTimeout> | null = null
  private readonly slideshowIntervalMs: number
  private palette: UiGalleryPaletteName = "dark"
  private selectedComponent = 0
  private closed = false
  private readonly done: Promise<void>
  private resolveDone!: () => void

  constructor(
    private readonly renderer: CliRenderer,
    private readonly storiesByPalette: UiGalleryStoriesByPalette,
    sourceStories: readonly UiStory[],
    options: UiGalleryAppOptions = {},
  ) {
    for (const palette of UI_GALLERY_PALETTE_NAMES) {
      if (storiesByPalette[palette].length === 0) throw new Error("the UI gallery needs at least one state in each theme")
    }
    const idsByPalette = new Set(
      UI_GALLERY_PALETTE_NAMES.map((palette) => storiesByPalette[palette].map((story) => story.id).join("\0")),
    )
    if (idsByPalette.size !== 1) throw new Error("the UI gallery themes must contain the same states")
    this.sourceById = new Map(sourceStories.map((story) => [story.id, story]))
    for (const story of storiesByPalette.dark) {
      if (!this.sourceById.has(story.id)) throw new Error(`the UI gallery is missing source state ${story.id}`)
    }
    this.slideshowIntervalMs = options.slideshowIntervalMs ?? DEFAULT_SLIDESHOW_INTERVAL_MS
    if (!Number.isFinite(this.slideshowIntervalMs) || this.slideshowIntervalMs <= 0) {
      throw new Error("the UI gallery slideshow interval must be positive")
    }
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
      height: 5,
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
    this.previewInteraction = new TextRenderable(renderer, {
      id: "ui-gallery-preview-interaction",
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
    this.preview.add(this.previewInteraction)
    this.preview.add(this.previewScroll)

    this.root.add(this.rail)
    this.root.add(this.divider)
    this.root.add(this.preview)
    renderer.root.add(this.root)
    renderer.keyInput.on("keypress", this.keypressHandler)
    renderer.keyInput.on("paste", this.pasteHandler)
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

  get isInteracting(): boolean {
    return this.interacting
  }

  get isSlideshow(): boolean {
    return this.slideshow
  }

  get isSlideshowPaused(): boolean {
    return this.slideshowPaused
  }

  waitForInteraction(): Promise<void> {
    return this.interactionTask
  }

  waitUntilDone(): Promise<void> {
    return this.done
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.clearSlideshowTimer()
    this.renderer.keyInput.off("keypress", this.keypressHandler)
    this.resolveDone()
  }

  async destroy(): Promise<void> {
    this.close()
    this.interactionGeneration++
    await this.interactionTask.catch(() => {})
    await this.disposeInteractionSession()
    this.renderer.keyInput.off("paste", this.pasteHandler)
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
    if (this.interacting || this.interactionPending) {
      if (key.name === "escape") {
        this.swallow(key)
        this.leaveInteraction()
        return
      }
      this.swallow(key)
      if (this.interacting) this.queueInteraction(() => this.forwardKey(key))
      return
    }
    if (this.slideshow) {
      this.handleSlideshowKey(key)
      return
    }
    if (key.name === "escape" || key.name === "q" || (key.ctrl === true && key.name === "c")) {
      this.swallow(key)
      this.close()
      return
    }
    if (key.name === "enter" || key.name === "return") {
      if (!this.activeStory.interaction) return
      this.swallow(key)
      this.beginInteraction()
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
      this.togglePalette()
      return
    }
    if (key.name === "s") {
      this.swallow(key)
      this.startSlideshow()
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

  private readonly pasteHandler = (event: PasteEvent): void => {
    if (!this.interacting) return
    event.preventDefault()
    event.stopPropagation()
    const bytes = event.bytes.slice()
    this.queueInteraction(async () => {
      const session = this.interactionSession
      if (!session) return
      const snapshot = await session.sendPaste(bytes)
      this.paintInteractiveSnapshot(snapshot.frame)
    })
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
    this.leaveInteraction()
    this.selectedComponent = Math.max(0, Math.min(this.components.length - 1, index))
    const component = this.activeComponent
    if (!this.stateByComponent.has(component)) this.stateByComponent.set(component, 0)
    if (this.slideshow) this.applyTheme()
    else this.paintComponentList()
    this.componentList.scrollChildIntoView(`ui-gallery-component-${slug(component)}`)
    this.showActiveStory()
    if (this.slideshow) this.armSlideshow()
  }

  private cycleState(offset: number): void {
    this.leaveInteraction()
    this.advanceCatalog(offset)
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
    this.paintInteractionHint()

    if (this.frame) {
      this.previewScroll.remove(this.frame)
      this.frame.destroyRecursively()
    }
    this.frame = new BoxRenderable(this.renderer, {
      id: "ui-gallery-frame",
      width: story.frame.cols + 2,
      height: story.frame.rows + 2,
      flexShrink: 0,
      backgroundColor: theme.background,
      border: true,
      borderStyle: "single",
      borderColor: theme.dim,
      title: " viewport ",
      titleColor: theme.dim,
      onMouseDown: (event) => this.forwardMouse(event, "down"),
      onMouseUp: (event) => this.forwardMouse(event, "up"),
      onMouseDrag: (event) => this.forwardMouse(event, "drag"),
      onMouseScroll: (event) => this.forwardMouse(event, "scroll"),
    })
    this.frameText = new TextRenderable(this.renderer, {
      id: "ui-gallery-frame-text",
      width: story.frame.cols,
      height: story.frame.rows,
      flexShrink: 0,
      selectable: true,
      content: frameText(story.frame, story.palette, theme.foreground),
    })
    this.frame.add(this.frameText)
    this.previewScroll.add(this.frame)
    this.paintFrameMode()
    this.renderer.requestRender()
  }

  private handleSlideshowKey(key: KeyEvent): void {
    if (key.name === "escape" || key.name === "s") {
      this.swallow(key)
      this.stopSlideshow()
      return
    }
    if (key.name === "q" || (key.ctrl === true && key.name === "c")) {
      this.swallow(key)
      this.close()
      return
    }
    if (key.name === "space") {
      this.swallow(key)
      this.slideshowPaused = !this.slideshowPaused
      if (this.slideshowPaused) this.clearSlideshowTimer()
      else this.armSlideshow()
      this.applyTheme()
      return
    }
    if (key.name === "left" || key.name === "h") {
      this.swallow(key)
      this.advanceCatalog(-1)
      return
    }
    if (key.name === "right" || key.name === "l") {
      this.swallow(key)
      this.advanceCatalog(1)
      return
    }
    if (key.name === "t") {
      this.swallow(key)
      this.togglePalette()
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

  private startSlideshow(): void {
    if (this.slideshow) return
    this.leaveInteraction()
    this.slideshow = true
    this.slideshowPaused = false
    this.applyTheme()
    this.showActiveStory()
    this.armSlideshow()
  }

  private stopSlideshow(): void {
    if (!this.slideshow) return
    this.clearSlideshowTimer()
    this.slideshow = false
    this.slideshowPaused = false
    this.applyTheme()
    this.showActiveStory()
  }

  private advanceCatalog(offset: number): void {
    const next = (this.slideIndex() + offset + this.stories.length) % this.stories.length
    const story = this.stories[next]!
    this.selectedComponent = this.components.indexOf(story.component)
    this.stateByComponent.set(
      story.component,
      this.statesFor(story.component).findIndex((state) => state.id === story.id),
    )
    if (this.slideshow) this.applyTheme()
    else this.paintComponentList()
    this.componentList.scrollChildIntoView(`ui-gallery-component-${slug(story.component)}`)
    this.showActiveStory()
    this.armSlideshow()
  }

  private armSlideshow(): void {
    this.clearSlideshowTimer()
    if (!this.slideshow || this.slideshowPaused || this.closed) return
    this.slideshowTimer = setTimeout(() => {
      this.slideshowTimer = null
      this.advanceCatalog(1)
    }, this.slideshowIntervalMs)
  }

  private clearSlideshowTimer(): void {
    if (this.slideshowTimer === null) return
    clearTimeout(this.slideshowTimer)
    this.slideshowTimer = null
  }

  private slideIndex(): number {
    const index = this.stories.findIndex((story) => story.id === this.activeStory.id)
    return Math.max(0, index)
  }

  private togglePalette(): void {
    this.leaveInteraction()
    const next = (UI_GALLERY_PALETTE_NAMES.indexOf(this.palette) + 1) % UI_GALLERY_PALETTE_NAMES.length
    this.palette = UI_GALLERY_PALETTE_NAMES[next]!
    this.applyTheme()
    this.showActiveStory()
  }

  private beginInteraction(): void {
    if (this.interacting || this.interactionPending || !this.activeStory.interaction) return
    const source = this.sourceById.get(this.activeStory.id)
    if (!source) return
    const generation = ++this.interactionGeneration
    this.interactionPending = true
    this.paintInteractionHint()
    this.paintFrameMode()
    const palette = this.palette
    this.interactionTask = this.interactionTask.catch(() => {}).then(async () => {
      const session = await UiStorySession.open(source, palette)
      if (generation !== this.interactionGeneration || this.closed) {
        await session.dispose()
        return
      }
      this.interactionSession = session
      this.interactionPending = false
      this.interacting = true
      const snapshot = await session.snapshot()
      if (generation !== this.interactionGeneration) return
      this.paintInteractiveSnapshot(snapshot.frame)
      this.paintInteractionHint()
      this.paintFrameMode()
    }).catch((error) => this.reportInteractionError(error))
  }

  private leaveInteraction(): void {
    if (!this.interacting && !this.interactionPending && !this.interactionSession) return
    this.interactionGeneration++
    this.interacting = false
    this.interactionPending = false
    const session = this.interactionSession
    this.interactionSession = null
    this.interactionTask = this.interactionTask.catch(() => {}).then(async () => {
      await session?.dispose()
    })
    this.paintInteractionHint()
    this.paintFrameMode()
  }

  private async disposeInteractionSession(): Promise<void> {
    const session = this.interactionSession
    this.interactionSession = null
    this.interacting = false
    this.interactionPending = false
    await session?.dispose()
  }

  private queueInteraction(operation: () => Promise<void>): void {
    this.interactionTask = this.interactionTask.catch(() => {}).then(operation).catch((error) =>
      this.reportInteractionError(error))
  }

  private async forwardKey(key: Pick<KeyEvent, "raw" | "sequence">): Promise<void> {
    const session = this.interactionSession
    const generation = this.interactionGeneration
    if (!session) return
    const snapshot = await session.sendKey(key)
    if (session !== this.interactionSession || generation !== this.interactionGeneration) return
    this.paintInteractiveSnapshot(snapshot.frame)
  }

  private forwardMouse(event: MouseEvent, type: "down" | "up" | "drag" | "scroll"): void {
    const frame = this.frame
    const session = this.interactionSession
    if (!this.interacting || !frame || !session) return
    const x = event.x - frame.screenX - 1
    const y = event.y - frame.screenY - 1
    const story = this.activeStory
    if (x < 0 || y < 0 || x >= story.frame.cols || y >= story.frame.rows) return
    event.preventDefault()
    event.stopPropagation()
    const generation = this.interactionGeneration
    this.queueInteraction(async () => {
      const snapshot = await session.sendMouse(
        type,
        x,
        y,
        event.button,
        event.modifiers,
        event.scroll?.direction,
      )
      if (session !== this.interactionSession || generation !== this.interactionGeneration) return
      this.paintInteractiveSnapshot(snapshot.frame)
    })
  }

  private paintInteractiveSnapshot(frame: CapturedFrame): void {
    const story = this.activeStory
    const theme = galleryTheme(this.palette)
    if (!this.frameText) return
    this.frameText.content = frameText(frame, story.palette, theme.foreground)
    this.renderer.requestRender()
  }

  private paintInteractionHint(): void {
    const theme = galleryTheme(this.palette)
    if (this.slideshow) {
      this.previewInteraction.content = new StyledText([
        textChunk(
          this.slideshowPaused ? "Ⅱ PAUSED" : "▶ PLAYING",
          this.slideshowPaused ? theme.signal : theme.accent,
          undefined,
          TextAttributes.BOLD,
        ),
        textChunk(` · space ${this.slideshowPaused ? "resumes" : "pauses"} · ← → step · Esc returns`, theme.dim),
      ])
      return
    }
    const instruction = this.activeStory.interaction
    if (!instruction) {
      this.previewInteraction.content = new StyledText([
        textChunk("REFERENCE", theme.dim, undefined, TextAttributes.BOLD),
        textChunk(" · use ← → to compare states", theme.dim),
      ])
      return
    }
    const label = this.interactionPending ? "OPENING" : this.interacting ? "INTERACTING" : "ENTER TO INTERACT"
    this.previewInteraction.content = new StyledText([
      textChunk(label, this.interacting ? theme.signal : theme.accent, undefined, TextAttributes.BOLD),
      textChunk(` · ${instruction}`, theme.dim),
      ...(this.interacting ? [textChunk(" · Esc returns", theme.dim)] : []),
    ])
  }

  private paintFrameMode(): void {
    if (!this.frame) return
    const theme = galleryTheme(this.palette)
    const activeColor = this.slideshowPaused ? theme.signal : theme.accent
    this.frame.borderColor = this.interacting || this.slideshow ? activeColor : theme.dim
    this.frame.focusedBorderColor = this.interacting || this.slideshow ? activeColor : theme.dim
    this.frame.title = this.slideshow
      ? ` slide ${this.slideIndex() + 1}/${this.stories.length} · ${this.slideshowPaused ? "paused" : "playing"} `
      : this.interactionPending
        ? " opening "
        : this.interacting
          ? " interactive · Esc returns "
          : " viewport "
    this.frame.titleColor = this.interacting || this.slideshow ? activeColor : theme.dim
    this.renderer.requestRender()
  }

  private async reportInteractionError(error: unknown): Promise<void> {
    const session = this.interactionSession
    this.interacting = false
    this.interactionPending = false
    this.interactionSession = null
    await session?.dispose()
    const theme = galleryTheme(this.palette)
    this.previewInteraction.content = new StyledText([
      textChunk("INTERACTION ENDED", theme.signal, undefined, TextAttributes.BOLD),
      textChunk(` · ${error instanceof Error ? error.message : String(error)}`, theme.dim),
    ])
    this.paintFrameMode()
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
    applyScrollbarTheme(this.componentList, theme)
    applyScrollbarTheme(this.previewScroll, theme)
    this.previewDescription.fg = theme.dim
    this.identity.content = new StyledText([
      textChunk("UI GALLERY", theme.accent, undefined, TextAttributes.BOLD),
      textChunk(`  ${this.palette.toUpperCase()}`, theme.signal, undefined, TextAttributes.BOLD),
      ...(this.slideshow
        ? [
            textChunk("\nSLIDESHOW", theme.foreground, undefined, TextAttributes.BOLD),
            textChunk(` · ${this.slideIndex() + 1}/${this.stories.length}`, theme.dim),
          ]
        : [
            textChunk(`\n${this.components.length} components`, theme.foreground),
            textChunk(` · ${this.stories.length} states`, theme.dim),
          ]),
    ])
    this.hints.content = this.slideshow
      ? new StyledText([
          textChunk("space", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(this.slideshowPaused ? " resume" : " pause", theme.dim),
          textChunk("\n←→", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" previous/next", theme.dim),
          textChunk("\nt", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" theme", theme.dim),
          textChunk("\nesc", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" browse", theme.dim),
          textChunk("\nq", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" close", theme.dim),
        ])
      : new StyledText([
          textChunk("↑↓", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" component · ", theme.dim),
          textChunk("←→", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" state", theme.dim),
          textChunk("\nenter", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" interact", theme.dim),
          textChunk("\ns", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" slideshow", theme.dim),
          textChunk("\npg/dn scroll · [ ] pan", theme.dim),
          textChunk("\nt", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" theme · ", theme.dim),
          textChunk("q", theme.accent, undefined, TextAttributes.BOLD),
          textChunk(" close", theme.dim),
        ])
    this.paintInteractionHint()
    this.paintFrameMode()
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

function frameText(
  frame: CapturedFrame,
  palette: UiGalleryPaletteName,
  foreground: RGBA,
): StyledText {
  const chunks: TextChunk[] = []
  for (const [lineIndex, line] of frame.lines.entries()) {
    for (const span of line.spans) {
      chunks.push(textChunk(span.text, span.fg, span.bg, span.attributes))
    }
    if (lineIndex < frame.lines.length - 1) {
      chunks.push(
        textChunk(
          "\n",
          foreground,
          RGBA.fromHex(UI_GALLERY_PALETTES[palette]?.defaultBackground ?? RAMP_FALLBACK.background),
        ),
      )
    }
  }
  return new StyledText(chunks)
}

function galleryTheme(name: UiGalleryPaletteName): GalleryTheme {
  const palette = UI_GALLERY_PALETTES[name]
  if (!palette) {
    // Nothing detected: the gallery's own chrome takes the same tier fmx does.
    return {
      background: RGBA.fromHex(RAMP_FALLBACK.background),
      foreground: RGBA.fromHex(RAMP_FALLBACK.foreground),
      dim: RGBA.fromHex(RAMP_FALLBACK.dim),
      accent: RGBA.fromHex(RAMP_FALLBACK.accent),
      signal: RGBA.fromHex(RAMP_FALLBACK.focus),
      selectedBackground: RGBA.fromHex(RAMP_FALLBACK.surface),
    }
  }
  return {
    background: RGBA.fromHex(palette.defaultBackground ?? "#171c23"),
    foreground: RGBA.fromHex(palette.defaultForeground ?? "#dbe3eb"),
    dim: RGBA.fromHex(palette.palette[8] ?? "#687384"),
    accent: RGBA.fromHex(palette.palette[6] ?? "#67c7c2"),
    signal: RGBA.fromHex(palette.palette[3] ?? "#e5c07b"),
    selectedBackground: RGBA.fromHex(name === "dark" ? "#2a3640" : "#d5dfde"),
  }
}

function applyScrollbarTheme(scroll: ScrollBoxRenderable, theme: GalleryTheme): void {
  for (const bar of [scroll.verticalScrollBar, scroll.horizontalScrollBar]) {
    bar.slider.backgroundColor = theme.background
    bar.slider.foregroundColor = theme.selectedBackground
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
