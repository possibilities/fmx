const OUTER_MULTIPLEXER_VARIABLES = [
  "TMUX",
  "TMUX_PANE",
  "STY",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
] as const

/**
 * fx is attached to fmx's embedded terminal, not directly to an outer tmux,
 * screen, or Zellij session. Hiding those parent markers prevents fx from
 * selecting protocols or issuing control commands for the wrong terminal.
 */
export function createFxEnvironment(parent: NodeJS.ProcessEnv, instanceId: number, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent,
    PWD: cwd,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "fmx",
    FMX_INSTANCE_ID: String(instanceId),
  }

  const inheritedScreenSession = env.STY !== undefined
  for (const variable of OUTER_MULTIPLEXER_VARIABLES) delete env[variable]
  if (inheritedScreenSession) delete env.WINDOW
  delete env.TERM_PROGRAM_VERSION
  return env
}
