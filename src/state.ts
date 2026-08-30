import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { resolveFmxHome } from "./home.ts"

/** Machine-owned UI state, kept out of the hand-edited config.toml. */
export type PersistedState = {
  trayWidth?: number
  /** Hidden by the toggle key; absent when shown, so an untouched state.json
   * stays as it was. */
  trayHidden?: boolean
  /** Stable Manifest identity of the agent that most recently owned focus. */
  activeAgentId?: string
}

export function statePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
  name: string | null = null,
): string {
  return resolveFmxHome(name, env, homeDirectory).statePath
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
  if (typeof document.activeAgentId === "string" && /^[0-9a-f]{32}$/u.test(document.activeAgentId)) {
    state.activeAgentId = document.activeAgentId
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
