import { BoxRenderable, type CapturedFrame, type KeyEvent, type TerminalColors, type ThemeMode } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"

export const UI_GALLERY_COMPONENTS = [
  "Multiplexer",
  "Session list",
  "Toast",
] as const

export type UiGalleryComponent = (typeof UI_GALLERY_COMPONENTS)[number]
/** Dark and light OSC 11 outcomes and, third, the default-dark no-signal case.
 * Every case uses a fixed fxnk token set; `t` cycles them in this order. */
export const UI_GALLERY_PALETTE_NAMES = ["dark", "light", "fallback"] as const
export type UiGalleryPaletteName = (typeof UI_GALLERY_PALETTE_NAMES)[number]

export type UiStory = {
  id: string
  component: UiGalleryComponent
  title: string
  description: string
  viewport: { cols: number; rows: number }
  expectedText: readonly string[]
  /** What a human can usefully do after handing keys and mouse input to this state. */
  interaction?: string
  arrange(context: UiStoryContext): void | Promise<void>
  verify?(context: UiStoryContext, frame: string): void | Promise<void>
}

export type UiStoryContext = {
  setup: TestRendererSetup
  canvas: BoxRenderable
  /** Null for the no-signal case; present only to simulate OSC 11 background. */
  palette: TerminalColors | null
  paletteName: UiGalleryPaletteName
  themeMode: ThemeMode
  defer(cleanup: () => void | Promise<void>): void
}

export type RenderedUiStory = Omit<UiStory, "arrange" | "verify"> & {
  palette: UiGalleryPaletteName
  frame: CapturedFrame
  text: string
}

export type UiGalleryStoriesByPalette = Readonly<
  Record<UiGalleryPaletteName, readonly RenderedUiStory[]>
>

export type UiStorySnapshot = {
  frame: CapturedFrame
  text: string
}

/**
 * A story kept alive in its exact-size test renderer. The gallery paints its
 * captured spans, then forwards input back here while interaction mode is on.
 * That keeps components which measure against their renderer (notably the
 * Multiplexer and Toast) honest without making production renderables aware of
 * the gallery's surrounding chrome.
 */
export class UiStorySession {
  private disposed = false
  private readonly encoder = new TextEncoder()

  private constructor(
    readonly story: UiStory,
    readonly paletteName: UiGalleryPaletteName,
    private readonly setup: TestRendererSetup,
    private readonly canvas: BoxRenderable,
    private readonly cleanups: Array<() => void | Promise<void>>,
  ) {}

  static async open(story: UiStory, paletteName: UiGalleryPaletteName): Promise<UiStorySession> {
    const setup = await createTestRenderer({
      width: story.viewport.cols,
      height: story.viewport.rows,
      kittyKeyboard: true,
      exitOnCtrlC: false,
    })
    const palette = UI_GALLERY_PALETTES[paletteName]
    // Some stories mount root-owned surfaces beside this background. Keep it
    // out of root flow so both still measure against the full viewport.
    const canvas = new BoxRenderable(setup.renderer, {
      id: `ui-gallery-canvas-${story.id}`,
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: palette?.defaultBackground ?? "#1c1c1c",
    })
    setup.renderer.root.add(canvas)
    const cleanups: Array<() => void | Promise<void>> = []
    const context: UiStoryContext = {
      setup,
      canvas,
      palette,
      paletteName,
      themeMode: paletteName === "light" ? "light" : "dark",
      defer(cleanup) {
        cleanups.push(cleanup)
      },
    }

    const session = new UiStorySession(story, paletteName, setup, canvas, cleanups)
    try {
      await story.arrange(context)
      const snapshot = await session.snapshot()
      for (const expected of story.expectedText) {
        if (!snapshot.text.includes(expected)) {
          throw new Error(`${story.id}: expected the rendered frame to contain ${JSON.stringify(expected)}`)
        }
      }
      await story.verify?.(context, snapshot.text)
      return session
    } catch (error) {
      await session.dispose()
      throw error
    }
  }

  async sendKey(key: Pick<KeyEvent, "raw" | "sequence">): Promise<UiStorySnapshot> {
    this.ensureOpen()
    const raw = key.raw || key.sequence
    this.setup.renderer.stdin.emit("data", this.encoder.encode(raw))
    return this.snapshot()
  }

  async sendPaste(bytes: Uint8Array): Promise<UiStorySnapshot> {
    this.ensureOpen()
    await this.setup.mockInput.pasteBracketedText(new TextDecoder().decode(bytes))
    return this.snapshot()
  }

  async sendMouse(
    type: "down" | "up" | "drag" | "scroll",
    x: number,
    y: number,
    button: number,
    modifiers: { shift: boolean; alt: boolean; ctrl: boolean },
    scrollDirection?: "up" | "down" | "left" | "right",
  ): Promise<UiStorySnapshot> {
    this.ensureOpen()
    if (type === "scroll" && scrollDirection) {
      await this.setup.mockMouse.scroll(x, y, scrollDirection, { modifiers })
    } else {
      await this.setup.mockMouse.emitMouseEvent(
        type,
        x,
        y,
        button as Parameters<typeof this.setup.mockMouse.emitMouseEvent>[3],
        { modifiers },
      )
    }
    return this.snapshot()
  }

  async snapshot(): Promise<UiStorySnapshot> {
    this.ensureOpen()
    // Several component actions deliberately finish through microtasks. Two
    // passes make those immediate transitions visible without waiting on the
    // long timers used by Toasts and launch prompting.
    await Promise.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await this.setup.renderOnce()
    await Promise.resolve()
    await this.setup.renderOnce()
    return { frame: this.setup.captureSpans(), text: this.setup.captureCharFrame() }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      for (const cleanup of this.cleanups.reverse()) await cleanup()
    } finally {
      if (!this.setup.renderer.isDestroyed) {
        this.canvas.destroyRecursively()
        this.setup.renderer.destroy()
      }
    }
  }

  private ensureOpen(): void {
    if (this.disposed || this.setup.renderer.isDestroyed) throw new Error(`${this.story.id}: story is closed`)
  }
}

const ANSI_DARK = [
  "#1b2028",
  "#e66b72",
  "#7bc99a",
  "#e5c07b",
  "#6fa8dc",
  "#c792ea",
  "#67c7c2",
  "#c8d1dc",
  "#687384",
  "#ff858b",
  "#8fe0ad",
  "#f2d18b",
  "#82baf0",
  "#d7a6f3",
  "#79d9d4",
  "#f0f3f7",
] as const

const ANSI_LIGHT = [
  "#e7eceb",
  "#9d313c",
  "#236b46",
  "#865c10",
  "#245c8f",
  "#72469a",
  "#176f70",
  "#394542",
  "#77817e",
  "#b64550",
  "#34805a",
  "#9b701c",
  "#3773aa",
  "#875cae",
  "#2b8384",
  "#17201e",
] as const

export const UI_GALLERY_PALETTES: Readonly<Record<UiGalleryPaletteName, TerminalColors | null>> = {
  dark: terminalPalette(ANSI_DARK, "#dbe3eb", "#171c23"),
  light: terminalPalette(ANSI_LIGHT, "#17201e", "#eef2f1"),
  fallback: null,
}

export async function renderUiStory(
  story: UiStory,
  paletteName: UiGalleryPaletteName,
): Promise<RenderedUiStory> {
  const session = await UiStorySession.open(story, paletteName)
  try {
    const { frame, text } = await session.snapshot()
    return {
      id: story.id,
      component: story.component,
      title: story.title,
      description: story.description,
      viewport: story.viewport,
      palette: paletteName,
      expectedText: story.expectedText,
      interaction: story.interaction,
      frame,
      text,
    }
  } finally {
    await session.dispose()
  }
}

export async function renderUiStories(
  stories: readonly UiStory[],
  palette: UiGalleryPaletteName,
): Promise<RenderedUiStory[]> {
  const rendered: RenderedUiStory[] = []
  for (const story of stories) rendered.push(await renderUiStory(story, palette))
  return rendered
}

function terminalPalette(
  palette: readonly string[],
  defaultForeground: string,
  defaultBackground: string,
): TerminalColors {
  return {
    palette: [...palette],
    defaultForeground,
    defaultBackground,
    cursorColor: palette[12] ?? null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: palette[8] ?? null,
    highlightForeground: defaultForeground,
  }
}
