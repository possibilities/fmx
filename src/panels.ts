import { hunkCommandName } from "./executable.ts"
import { HUNK_THEME_ID } from "./hunk-theme.ts"

const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u

/**
 * One terminal tool the Tools panel offers. Its id is stable state and
 * Companion identity; the label is presentation alone.
 *
 * These are fmx's, not the human's. A tool fmx ships is one it can theme,
 * flag, and version together with itself; a configured one could only ever be
 * a bare command fmx renders and hopes about. There is deliberately no
 * `[[panels]]` table.
 */
export type PanelDefinition = {
  id: string
  label: string
  /** argv, the executable first. Commands are never evaluated by a shell. */
  command: string[]
  /** Whether the Companion keeps the tool when it is not attached to fmx. */
  persistent: boolean
  /**
   * The theme fmx injects for this tool, or none. Part of the panel's identity
   * because it is the reason the effective argv differs from `command`: the
   * extension path and the Ramp are both volatile, and neither belongs in a
   * fingerprint, while the name of the theme does not move.
   */
  theme?: typeof HUNK_THEME_ID
}

export function isPanelId(value: unknown): value is string {
  return typeof value === "string" && PANEL_ID.test(value)
}

/**
 * The tools this fmx offers, in rule-tab order.
 *
 * hunk is offered only when it resolves. A tool that is not installed is not a
 * tab that fails to start: with none available the Tools panel does not exist,
 * which is what the dock has always done with nothing to show.
 */
export function builtinPanels(
  available: { hunk: boolean },
  env: NodeJS.ProcessEnv = process.env,
): PanelDefinition[] {
  const panels: PanelDefinition[] = []
  if (available.hunk) {
    panels.push({
      id: "diff",
      label: "Diff",
      command: [hunkCommandName(env), "diff", "--watch", "--pager"],
      persistent: true,
      theme: HUNK_THEME_ID,
    })
  }
  return panels
}
