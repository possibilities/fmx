const OUTER_MULTIPLEXER_VARIABLES = [
  "TMUX",
  "TMUX_PANE",
  "STY",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_BIN_PATH",
] as const

/**
 * The agent socket fx reports its lifecycle to. fx reads the pane id and the
 * socket path from its environment at startup and reports to both or neither,
 * so they are set together or not at all.
 */
export type FxAgentSocketBinding = {
  socketPath: string
  paneId: string
}

/**
 * fx is attached to fmx's embedded terminal, not directly to an outer tmux,
 * screen, or Zellij session. Hiding those parent markers prevents fx from
 * selecting protocols or issuing control commands for the wrong terminal.
 *
 * The agent-socket variables are cleared for the same reason: an inherited
 * socket path and pane id name a surface that is not this one, and fx would
 * report this instance's lifecycle against a stranger's pane.
 */
export function createFxEnvironment(
  parent: NodeJS.ProcessEnv,
  instanceId: number,
  cwd: string,
  agentSocket: FxAgentSocketBinding | null = null,
): NodeJS.ProcessEnv {
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

  if (agentSocket) {
    env.HERDR_SOCKET_PATH = agentSocket.socketPath
    env.HERDR_PANE_ID = agentSocket.paneId
  }
  return env
}
