import { CONTROL_SOCKET_ENV_VAR } from "./control-protocol.ts"
import { INHERITED_COMPANION_VARIABLES } from "./zmx-environment.ts"

/**
 * An fx reads the agent socket it reports to out of its environment. Any of
 * these inherited from fmx's own parent name a surface that is not this one,
 * so every fx fmx starts — the instances it renders and the short-lived one
 * that names them — is started without them.
 */
export const INHERITED_AGENT_SOCKET_VARIABLES = [
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_BIN_PATH",
] as const

const OUTER_MULTIPLEXER_VARIABLES = [
  "TMUX",
  "TMUX_PANE",
  "STY",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  ...INHERITED_AGENT_SOCKET_VARIABLES,
  // The Companion's own names: an fmx started inside a human's zmx must not
  // hand that session on to fx, and the Companion sets its own when it
  // starts the child.
  ...INHERITED_COMPANION_VARIABLES,
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

/** Model settings applied to one fx process without changing the profile. */
export type FxLaunchLevel = {
  model: string
  effort: string
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
  controlSocketPath: string | null = null,
  launchLevel: FxLaunchLevel | null = null,
): NodeJS.ProcessEnv {
  const env = createEmbeddedEnvironment(parent, cwd)
  env.FMX_INSTANCE_ID = String(instanceId)

  if (agentSocket) {
    env.HERDR_SOCKET_PATH = agentSocket.socketPath
    env.HERDR_PANE_ID = agentSocket.paneId
  }
  // The control socket is fmx's own: an agent inside the instance drives
  // this fmx through it, and `FMX_INSTANCE_ID` says which instance it is.
  if (controlSocketPath) env[CONTROL_SOCKET_ENV_VAR] = controlSocketPath
  else delete env[CONTROL_SOCKET_ENV_VAR]
  if (launchLevel) {
    env.FX_MODEL = launchLevel.model
    env.FX_EFFORT = launchLevel.effort
  }
  return env
}

/** A configured terminal tool runs in the active Instance's context but is not
 * itself an fx and must never report on the Agent socket. */
export function createPanelEnvironment(
  parent: NodeJS.ProcessEnv,
  instanceId: number,
  cwd: string,
  controlSocketPath: string | null,
  panelId: string,
): NodeJS.ProcessEnv {
  const env = createEmbeddedEnvironment(parent, cwd)
  env.FMX_INSTANCE_ID = String(instanceId)
  env.FMX_PANEL_ID = panelId
  if (controlSocketPath) env[CONTROL_SOCKET_ENV_VAR] = controlSocketPath
  else delete env[CONTROL_SOCKET_ENV_VAR]
  return env
}

function createEmbeddedEnvironment(parent: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent,
    PWD: cwd,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "fmx",
  }
  const inheritedScreenSession = env.STY !== undefined
  for (const variable of OUTER_MULTIPLEXER_VARIABLES) delete env[variable]
  if (inheritedScreenSession) delete env.WINDOW
  delete env.TERM_PROGRAM_VERSION
  delete env.FMX_PANEL_ID
  return env
}
