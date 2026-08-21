import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const STATE_PATH_ENV_VAR = "FMX_STATE_PATH"

/** Machine-owned UI state, kept out of the hand-edited config.toml. */
export type PersistedState = {
  sidebarWidth?: number
}

export function statePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  if (env[STATE_PATH_ENV_VAR]) return env[STATE_PATH_ENV_VAR]
  const configHome = env.XDG_CONFIG_HOME || join(homeDirectory, ".config")
  return join(configHome, "fmx", "state.json")
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
    typeof document.sidebarWidth === "number" &&
    Number.isInteger(document.sidebarWidth) &&
    document.sidebarWidth > 0
  ) {
    state.sidebarWidth = document.sidebarWidth
  }
  return state
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
