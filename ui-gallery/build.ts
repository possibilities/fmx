import { UI_STORIES } from "./stories.ts"
import {
  renderUiStories,
  UI_GALLERY_COMPONENTS,
  type UiGalleryStoriesByPalette,
  type UiStory,
} from "./story.ts"

export type UiGalleryBuild = {
  stories: UiGalleryStoriesByPalette
}

export async function buildUiGallery(stories: readonly UiStory[] = UI_STORIES): Promise<UiGalleryBuild> {
  validateUiStories(stories)
  const dark = await renderUiStories(stories, "dark")
  const light = await renderUiStories(stories, "light")
  return { stories: { dark, light } }
}

export function validateUiStories(stories: readonly UiStory[]): void {
  const ids = new Set<string>()
  for (const story of stories) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(story.id)) {
      throw new Error(`UI gallery story id must be a lowercase slug: ${story.id}`)
    }
    if (ids.has(story.id)) throw new Error(`duplicate UI gallery story id: ${story.id}`)
    ids.add(story.id)
    if (story.expectedText.length === 0) throw new Error(`${story.id}: a story needs at least one visible assertion`)
  }

  const covered = new Set(stories.map((story) => story.component))
  const missing = UI_GALLERY_COMPONENTS.filter((component) => !covered.has(component))
  if (missing.length > 0) throw new Error(`UI gallery has no example for: ${missing.join(", ")}`)
}
