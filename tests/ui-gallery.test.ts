import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { UiGalleryApp } from "../ui-gallery/app.ts"
import { buildUiGallery, validateUiStories } from "../ui-gallery/build.ts"
import { UI_STORIES } from "../ui-gallery/stories.ts"
import { UI_GALLERY_COMPONENTS } from "../ui-gallery/story.ts"

test(
  "every component state renders in both themes and the catalog navigates each axis independently",
  async () => {
    expect(() => validateUiStories(UI_STORIES)).not.toThrow()
    expect(UI_GALLERY_COMPONENTS).toEqual([
      "Multiplexer",
      "Session list",
      "Launch dialog",
      "Tools panel",
      "Toast",
    ])
    const toastStates = UI_STORIES.filter((story) => story.component === "Toast")
    expect(toastStates).toHaveLength(3)
    expect(new Set(toastStates.map((story) => `${story.viewport.cols}×${story.viewport.rows}`))).toEqual(
      new Set(["62×12"]),
    )
    const built = await buildUiGallery()
    expect(built.stories.dark).toHaveLength(UI_STORIES.length)
    expect(built.stories.light).toHaveLength(UI_STORIES.length)
    for (const palette of ["dark", "light"] as const) {
      expect(new Set(built.stories[palette].map((story) => story.component))).toEqual(
        new Set(UI_GALLERY_COMPONENTS),
      )
      expect(built.stories[palette].every((story) => story.palette === palette)).toBe(true)
      expect(built.stories[palette].every((story) => story.frame.cols > 0 && story.frame.rows > 0)).toBe(true)
    }

    const setup = await createTestRenderer({ width: 112, height: 34, kittyKeyboard: true, exitOnCtrlC: false })
    const app = new UiGalleryApp(setup.renderer, built.stories, UI_STORIES)
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("UI GALLERY")
      expect(setup.captureCharFrame()).toContain("5 components · 20 states")
      expect(app.activeComponent).toBe("Multiplexer")
      expect(app.activeStoryId).toBe(built.stories.dark[0]!.id)

      setup.mockInput.pressArrow("right")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Multiplexer")
      expect(app.activeStoryId).toBe(built.stories.dark[1]!.id)
      expect(setup.captureCharFrame()).toContain("state 2/3")

      setup.mockInput.pressKey("t")
      await setup.renderOnce()
      expect(app.activePalette).toBe("light")
      expect(app.activeStoryId).toBe(built.stories.light[1]!.id)
      expect(setup.captureCharFrame()).toContain("LIGHT")

      setup.mockInput.pressArrow("down")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Session list")
      expect(app.activeStoryId).toBe(built.stories.light[3]!.id)
      expect(setup.captureCharFrame()).toContain("state 1/3")

      setup.mockInput.pressArrow("down")
      await setup.renderOnce()
      expect(app.activeComponent).toBe("Launch dialog")
      expect(setup.captureCharFrame()).toContain("ENTER TO INTERACT")

      setup.mockInput.pressEnter()
      await app.waitForInteraction()
      await setup.renderOnce()
      expect(app.isInteracting).toBe(true)
      expect(setup.captureCharFrame()).toContain("INTERACTING")

      await setup.mockInput.typeText("Audit")
      await app.waitForInteraction()
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("Audit")

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
