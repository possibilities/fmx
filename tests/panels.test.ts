import { expect, test } from "bun:test"
import { HUNK_THEME_ID } from "../src/hunk-theme.ts"
import { builtinPanels, isPanelId } from "../src/panels.ts"

test("the Diff panel is fmx's own, themed, and persistent", () => {
  const panels = builtinPanels({ hunk: true }, {})
  expect(panels).toEqual([
    {
      id: "diff",
      label: "Diff",
      command: ["hunk", "diff", "--watch", "--pager"],
      persistent: true,
      theme: HUNK_THEME_ID,
    },
  ])
  expect(panels.every((panel) => isPanelId(panel.id))).toBe(true)
})

test("the panel's argv takes the override as written, never a resolved path", () => {
  // A realpath goes through the installed version's own directory, so putting
  // one in the argv would orphan the panel's session on every hunk upgrade.
  const [panel] = builtinPanels({ hunk: true }, { FMX_HUNK_PATH: "/opt/hunk/bin/hunk" })
  expect(panel!.command[0]).toBe("/opt/hunk/bin/hunk")
})

test("no hunk is no Tools panel rather than a tab that cannot start", () => {
  expect(builtinPanels({ hunk: false }, {})).toEqual([])
})
