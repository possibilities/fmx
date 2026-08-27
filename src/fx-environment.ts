import { CONTROL_SOCKET_ENV_VAR } from "./control-protocol.ts"
import { INHERITED_COMPANION_VARIABLES } from "./zmx-environment.ts"

/**
 * Fx may inherit a Herdr integration from fmx's own parent. That integration
 * belongs to the outer surface, so every fx fmx starts is isolated from it.
 */
export const INHERITED_HERDR_VARIABLES = [
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
  ...INHERITED_HERDR_VARIABLES,
  "FX_ADE_SOCKET_PATH",
  "FX_ADE_INSTANCE_ID",
  // These identify fmx's own Companion-held Runtime process. An Agent may
  // launch fmx itself and must become an ordinary Client, not inherit the
  // hidden Runtime role or its one-use bootstrap marker.
  "FMX_RUNTIME_PROCESS",
  "FMX_RUNTIME_BOOTSTRAP_PATH",
  // The Companion's own names: an fmx started inside a human's zmx must not
  // hand that session on to fx, and the Companion sets its own when it
  // starts the child.
  ...INHERITED_COMPANION_VARIABLES,
] as const

/** The passive ADE event feed shared by Agents, with this Agent's stable identity. */
export type FxAdeBinding = {
  socketPath: string
  instanceId: string
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
 * Inherited Herdr variables are cleared for the same reason: they name an
 * outer surface, while fmx consumes lifecycle only from its ADE feed.
 */
export function createFxEnvironment(
  parent: NodeJS.ProcessEnv,
  agentId: number,
  cwd: string,
  controlSocketPath: string | null = null,
  launchLevel: FxLaunchLevel | null = null,
  ade: FxAdeBinding | null = null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent,
    PWD: cwd,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "fmx",
    // fmx owns this private fork binary and upgrades it only through its
    // pinned installer. Fx must never replace it with an upstream release.
    FX_AUTO_UPGRADE: "0",
  }
  const inheritedScreenSession = env.STY !== undefined
  for (const variable of OUTER_MULTIPLEXER_VARIABLES) delete env[variable]
  if (inheritedScreenSession) delete env.WINDOW
  delete env.TERM_PROGRAM_VERSION
  env.FMX_AGENT_ID = String(agentId)

  // The control socket is fmx's own: an agent inside the agent drives
  // this fmx through it, and `FMX_AGENT_ID` says which agent it is.
  if (controlSocketPath) env[CONTROL_SOCKET_ENV_VAR] = controlSocketPath
  else delete env[CONTROL_SOCKET_ENV_VAR]
  if (ade) {
    env.FX_ADE_SOCKET_PATH = ade.socketPath
    env.FX_ADE_INSTANCE_ID = ade.instanceId
  }
  if (launchLevel) {
    env.FX_MODEL = launchLevel.model
    env.FX_EFFORT = launchLevel.effort
  }
  return env
}
