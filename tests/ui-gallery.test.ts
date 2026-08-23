import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { UiGalleryApp } from "../ui-gallery/app.ts"
import { buildUiGallery, validateUiStories } from "../ui-gallery/build.ts"
import { UI_STORIES } from "../ui-gallery/stories.ts"
import { UI_GALLERY_COMPONENTS } from "../ui-gallery/story.ts"

test(
  "every UI gallery story renders, asserts its state, and appears in the interactive catalog",
  async () => {
    expect(() => validateUiStories(UI_STORIES)).not.toThrow()
    const built = await buildUiGallery()
    expect(built.stories).toHaveLength(UI_STORIES.length)
    expect(new Set(built.stories.map((story) => story.component))).toEqual(new Set(UI_GALLERY_COMPONENTS))
    expect(built.stories.every((story) => story.frame.cols > 0 && story.frame.rows > 0)).toBe(true)

    const setup = await createTestRenderer({ width: 112, height: 34, kittyKeyboard: true, exitOnCtrlC: false })
    const app = new UiGalleryApp(setup.renderer, built.stories)
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("UI GALLERY")
      expect(setup.captureCharFrame()).toContain(built.stories[0]!.title)

      setup.mockInput.pressArrow("down")
      await setup.renderOnce()
      expect(app.activeStoryId).toBe(built.stories[1]!.id)
      expect(setup.captureCharFrame()).toContain(built.stories[1]!.title)
    } finally {
      app.destroy()
      setup.renderer.destroy()
    }
  },
  20_000,
)
