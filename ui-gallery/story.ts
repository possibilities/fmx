import { BoxRenderable, type CapturedFrame, type TerminalColors } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"

export const UI_GALLERY_COMPONENTS = [
  "Multiplexer",
  "Agent terminal",
  "Session list",
  "Launch dialog",
  "Prompt editor",
  "Tools panel",
  "Debug panel",
  "Toast",
] as const

export type UiGalleryComponent = (typeof UI_GALLERY_COMPONENTS)[number]
export type UiGalleryPaletteName = "dark" | "light"

export type UiStory = {
  id: string
  component: UiGalleryComponent
  title: string
  description: string
  viewport: { cols: number; rows: number }
  expectedText: readonly string[]
  arrange(context: UiStoryContext): void | Promise<void>
  verify?(context: UiStoryContext, frame: string): void | Promise<void>
}

export type UiStoryContext = {
  setup: TestRendererSetup
  canvas: BoxRenderable
  palette: TerminalColors
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

export const UI_GALLERY_PALETTES: Readonly<Record<UiGalleryPaletteName, TerminalColors>> = {
  dark: terminalPalette(ANSI_DARK, "#dbe3eb", "#171c23"),
  light: terminalPalette(ANSI_LIGHT, "#17201e", "#eef2f1"),
}

export async function renderUiStory(
  story: UiStory,
  paletteName: UiGalleryPaletteName,
): Promise<RenderedUiStory> {
  const setup = await createTestRenderer({
    width: story.viewport.cols,
    height: story.viewport.rows,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const palette = UI_GALLERY_PALETTES[paletteName]
  const canvas = new BoxRenderable(setup.renderer, {
    id: `ui-gallery-canvas-${story.id}`,
    width: "100%",
    height: "100%",
    backgroundColor: palette.defaultBackground ?? "#171c23",
  })
  setup.renderer.root.add(canvas)
  const cleanups: Array<() => void | Promise<void>> = []
  const context: UiStoryContext = {
    setup,
    canvas,
    palette,
    defer(cleanup) {
      cleanups.push(cleanup)
    },
  }

  try {
    await story.arrange(context)
    await setup.renderOnce()
    const text = setup.captureCharFrame()
    for (const expected of story.expectedText) {
      if (!text.includes(expected)) {
        throw new Error(`${story.id}: expected the rendered frame to contain ${JSON.stringify(expected)}`)
      }
    }
    await story.verify?.(context, text)
    return {
      id: story.id,
      component: story.component,
      title: story.title,
      description: story.description,
      viewport: story.viewport,
      palette: paletteName,
      expectedText: story.expectedText,
      frame: setup.captureSpans(),
      text,
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    if (!setup.renderer.isDestroyed) {
      canvas.destroyRecursively()
      setup.renderer.destroy()
    }
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
