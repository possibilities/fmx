import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const STATE_PATH_ENV_VAR = "FMX_STATE_PATH"

/** Machine-owned UI state, kept out of the hand-edited config.toml. */
export type PersistedState = {
  trayWidth?: number
  /** Hidden by the toggle key; absent when shown, so an untouched state.json
   * stays as it was. */
  trayHidden?: boolean
  /** Agents started per directory, which orders the project picker. */
  projectLaunches?: Record<string, number>
  /** Stable Manifest identity of the agent that most recently owned focus. */
  activeAgentId?: string
}

/** Everything fmx keeps for itself lives here, alongside the config file the
 * human edits. */
export function fmxDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME || join(homeDirectory, ".config")
  return join(configHome, "fmx")
}

export function statePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  if (env[STATE_PATH_ENV_VAR]) return env[STATE_PATH_ENV_VAR]
  return join(fmxDirectory(env, homeDirectory), "state.json")
}

export async function loadState(path = statePath()): Promise<PersistedState> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch {
    return {}
  }

  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    return {}
  }
  if (!isRecord(document)) return {}

  const state: PersistedState = {}
  if (
    typeof document.trayWidth === "number" &&
    Number.isInteger(document.trayWidth) &&
    document.trayWidth > 0
  ) {
    state.trayWidth = document.trayWidth
  }
  if (document.trayHidden === true) state.trayHidden = true
  const launches = readLaunches(document.projectLaunches)
  if (launches) state.projectLaunches = launches
  if (typeof document.activeAgentId === "string" && /^[0-9a-f]{32}$/u.test(document.activeAgentId)) {
    state.activeAgentId = document.activeAgentId
  }
  return state
}

/** Counts a hand-edit or an older fmx could have left in any shape; only
 * whole positive tallies for absolute directories are kept. */
function readLaunches(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null
  const launches: Record<string, number> = {}
  for (const [directory, count] of Object.entries(raw)) {
    if (!directory.startsWith("/")) continue
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) continue
    launches[directory] = count
  }
  return Object.keys(launches).length > 0 ? launches : null
}

export async function saveState(state: PersistedState, path = statePath()): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(temporaryPath, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
