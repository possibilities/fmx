import { expect, test } from "bun:test"
import type { CapturedFrame } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { UiGalleryApp } from "../ui-gallery/app.ts"
import { buildUiGallery, validateUiStories } from "../ui-gallery/build.ts"
import { UI_STORIES } from "../ui-gallery/stories.ts"
import { UI_GALLERY_COMPONENTS, UI_GALLERY_PALETTE_NAMES } from "../ui-gallery/story.ts"

test(
  "every component state renders in every theme and the catalog navigates each axis independently",
  async () => {
    expect(() => validateUiStories(UI_STORIES)).not.toThrow()
    expect(UI_GALLERY_COMPONENTS).toEqual([
      "Multiplexer",
      "Agent picker",
      "Session list",
    ])
    const built = await buildUiGallery()
    expect(UI_GALLERY_PALETTE_NAMES).toEqual(["dark", "light", "fallback"])
    for (const palette of UI_GALLERY_PALETTE_NAMES) {
      expect(built.stories[palette]).toHaveLength(UI_STORIES.length)
      expect(new Set(built.stories[palette].map((story) => story.component))).toEqual(
        new Set(UI_GALLERY_COMPONENTS),
      )
      expect(built.stories[palette].every((story) => story.palette === palette)).toBe(true)
      expect(built.stories[palette].every((story) => story.frame.cols > 0 && story.frame.rows > 0)).toBe(true)

      const multiplexer = new Map(
        built.stories[palette]
          .filter((story) => story.component === "Multiplexer")
          .map((story) => [story.id, story.text.split("\n")]),
      )
      expect(multiplexer.get("multiplexer-empty")?.[11]).toContain("no agents")
      expect(multiplexer.get("multiplexer-working")?.[0]).toContain("Working on the UI gallery")
      expect(multiplexer.get("multiplexer-working")?.[23]).toContain("│")
      expect(multiplexer.get("multiplexer-larger-client")?.[0]).toContain("Working on the UI gallery")

      const client = built.stories[palette].find((story) => story.id === "multiplexer-larger-client")
      expect(client).toBeDefined()
      const expectedUnused = {
        dark: [38, 38, 38],
        light: [238, 238, 238],
        fallback: [38, 38, 38],
      }[palette]
      expect(backgroundAt(client!.frame, 85, 0)).toEqual(expectedUnused)
      expect(backgroundAt(client!.frame, 0, 23)).toEqual(expectedUnused)
    }

    const setup = await createTestRenderer({ width: 112, height: 34, kittyKeyboard: true, exitOnCtrlC: false })
    const app = new UiGalleryApp(setup.renderer, built.stories, UI_STORIES)
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("UI GALLERY")
      expect(setup.captureCharFrame()).toContain("3 components · 9 states")
      expect(app.activeComponent).toBe("Multiplexer")
      expect(app.activeStoryId).toBe(built.stories.dark[0]!.id)

      setup.mockInput.pressArrow("right")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Multiplexer")
      expect(app.activeStoryId).toBe(built.stories.dark[1]!.id)
      expect(setup.captureCharFrame()).toContain("state 2/3")

      setup.mockInput.pressArrow("right")
      setup.mockInput.pressArrow("right")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Agent picker")
      expect(app.activeStoryId).toBe(built.stories.dark[3]!.id)
      expect(setup.captureCharFrame()).toContain("state 1/3")

      setup.mockInput.pressArrow("left")
      setup.mockInput.pressArrow("left")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Multiplexer")
      expect(app.activeStoryId).toBe(built.stories.dark[1]!.id)

      setup.mockInput.pressKey("t")
      await setup.renderOnce()
      expect(app.activePalette).toBe("light")
      expect(app.activeStoryId).toBe(built.stories.light[1]!.id)
      expect(setup.captureCharFrame()).toContain("LIGHT")

      setup.mockInput.pressArrow("down")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Agent picker")
      expect(app.activeStoryId).toBe(built.stories.light[3]!.id)
      expect(setup.captureCharFrame()).toContain("state 1/3")

      setup.mockInput.pressArrow("down")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Session list")
      expect(app.activeStoryId).toBe(built.stories.light[6]!.id)

      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Multiplexer")
      expect(setup.captureCharFrame()).toContain("ENTER TO INTERACT")

      setup.mockInput.pressEnter()
      await app.waitForInteraction()
      await setup.renderOnce()
      expect(app.isInteracting).toBe(true)
      expect(setup.captureCharFrame()).toContain("INTERACTING")

      setup.mockInput.pressEscape()
      await app.waitForInteraction()
      await setup.renderOnce()
      expect(app.isInteracting).toBe(false)
    } finally {
      await app.destroy()
      setup.renderer.destroy()
    }
  },
  20_000,
)

test(
  "slideshow mode traverses every state in catalog order and keeps theme independent",
  async () => {
    const built = await buildUiGallery()
    const setup = await createTestRenderer({ width: 112, height: 34, kittyKeyboard: true, exitOnCtrlC: false })
    const app = new UiGalleryApp(setup.renderer, built.stories, UI_STORIES, { slideshowIntervalMs: 50 })
    try {
      await setup.renderOnce()
      setup.mockInput.pressKey("s")
      await setup.renderOnce()
      expect(app.isSlideshow).toBe(true)
      expect(app.isSlideshowPaused).toBe(false)
      expect(app.activeStoryId).toBe(built.stories.dark[0]!.id)
      expect(setup.captureCharFrame()).toContain("▶ PLAYING · space pauses")
      expect(setup.captureCharFrame()).toContain("slide 1/9 · playing")

      setup.mockInput.pressArrow("left")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Session list")
      expect(app.activeStoryId).toBe(built.stories.dark.at(-1)!.id)
      expect(setup.captureCharFrame()).toContain("SLIDESHOW · 9/9")

      setup.mockInput.pressArrow("right")
      setup.mockInput.pressKey("t")
      await setup.renderOnce()
      expect(app.activePalette).toBe("light")
      expect(app.activeStoryId).toBe(built.stories.light[0]!.id)
      expect(setup.captureCharFrame()).toContain("UI GALLERY  LIGHT")

      setup.mockInput.pressKey(" ")
      await setup.renderOnce()
      expect(app.isSlideshowPaused).toBe(true)
      expect(setup.captureCharFrame()).toContain("Ⅱ PAUSED · space resumes")
      await new Promise((resolve) => setTimeout(resolve, 70))
      await setup.renderOnce()
      expect(app.activeStoryId).toBe(built.stories.light[0]!.id)

      setup.mockInput.pressKey(" ")
      await new Promise((resolve) => setTimeout(resolve, 70))
      await setup.renderOnce()
      expect(app.isSlideshowPaused).toBe(false)
      expect(app.activeStoryId).toBe(built.stories.light[1]!.id)
      expect(setup.captureCharFrame()).toContain("▶ PLAYING · space pauses")
      expect(setup.captureCharFrame()).toContain("SLIDESHOW · 2/9")

      setup.mockInput.pressEscape()
      await setup.renderOnce()
      expect(app.isSlideshow).toBe(false)
      expect(setup.captureCharFrame()).toContain("3 components · 9 states")
      const stoppedStory = app.activeStoryId
      await new Promise((resolve) => setTimeout(resolve, 70))
      expect(app.activeStoryId).toBe(stoppedStory)
    } finally {
      await app.destroy()
      setup.renderer.destroy()
    }
  },
  20_000,
)

function backgroundAt(frame: CapturedFrame, x: number, y: number): number[] {
  const line = frame.lines[y]
  if (!line) throw new Error(`frame has no row ${y}`)
  let column = 0
  for (const span of line.spans) {
    if (x < column + span.width) return span.bg.toInts().slice(0, 3)
    column += span.width
  }
  throw new Error(`frame row ${y} has no column ${x}`)
}
