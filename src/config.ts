import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveKeybindings, type Keybindings } from "./keybindings.ts"

const CONFIG_PATH_ENV_VAR = "FMX_CONFIG_PATH"

type LoadedConfig = {
  keybindings: Keybindings
  /** Directories whose children the launch dialog offers as projects. */
  projectRoots: string[]
  diagnostics: string[]
}

const KNOWN_SECTIONS = new Set(["keys", "project_roots"])

export function configPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  if (env[CONFIG_PATH_ENV_VAR]) return env[CONFIG_PATH_ENV_VAR]
  const configHome = env.XDG_CONFIG_HOME || join(homeDirectory, ".config")
  return join(configHome, "fmx", "config.toml")
}

export async function loadConfig(path = configPath()): Promise<LoadedConfig> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return defaultConfig()
    return defaultConfig(`config read error: ${errorMessage(error)}; using defaults`)
  }

  let document: unknown
  try {
    document = Bun.TOML.parse(content)
  } catch (error) {
    return defaultConfig(`config parse error: ${errorMessage(error)}; using defaults`)
  }

  if (!isRecord(document)) {
    return defaultConfig("config parse error: top-level config must be a table; using defaults")
  }

  const diagnostics: string[] = []
  for (const section of Object.keys(document)) {
    if (!KNOWN_SECTIONS.has(section)) {
      diagnostics.push(`unknown config section [${section}]; ignoring section`)
    }
  }
  const resolved = resolveKeybindings(document.keys)
  diagnostics.push(...resolved.diagnostics)
  return {
    keybindings: resolved.keybindings,
    projectRoots: resolveProjectRoots(document.project_roots, diagnostics),
    diagnostics,
  }
}

/**
 * Where projects live on this machine, so the default is empty: a shipped
 * guess at someone's directory layout would offer a list that is wrong
 * everywhere it is not exactly right.
 */
function resolveProjectRoots(raw: unknown, diagnostics: string[]): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    diagnostics.push("invalid project_roots: must be an array of directories; ignoring it")
    return []
  }
  const roots: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      diagnostics.push(`invalid project root: ${JSON.stringify(entry)}; ignoring entry`)
      continue
    }
    if (!roots.includes(entry)) roots.push(entry)
  }
  return roots
}

function defaultConfig(...diagnostics: string[]): LoadedConfig {
  return { keybindings: resolveKeybindings().keybindings, projectRoots: [], diagnostics }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
