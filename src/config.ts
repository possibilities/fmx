import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveKeybindings, type Keybindings } from "./keybindings.ts"

const CONFIG_PATH_ENV_VAR = "FMX_CONFIG_PATH"

type LoadedConfig = {
  keybindings: Keybindings
  /** Directories whose children the launch dialog offers as projects. */
  projectRoots: string[]
  /** Where a launch's new worktree is checked out. */
  worktreeRoot: string
  /** Ordered terminal tools available in the active agent's tools panel. */
  panels: PanelDefinition[]
  diagnostics: string[]
}

/** One configured terminal tool. Its id is stable state and Companion identity;
 * the label is presentation alone. */
export type PanelDefinition = {
  id: string
  label: string
  /** argv, the executable first. Commands are never evaluated by a shell. */
  command: string[]
  /** Whether the Companion keeps the tool when it is not attached to fmx. */
  persistent: boolean
}

const KNOWN_SECTIONS = new Set(["keys", "project_roots", "worktree_root", "panels"])
const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u

/** Unlike the project roots, this one has a usable default: it names fmx's
 * own directory rather than guessing where anybody keeps their work. */
export const DEFAULT_WORKTREE_ROOT = "~/.fmx/worktrees"

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
    worktreeRoot: resolveWorktreeRoot(document.worktree_root, diagnostics),
    panels: resolvePanels(document.panels, diagnostics),
    diagnostics,
  }
}

export function isPanelId(value: unknown): value is string {
  return typeof value === "string" && PANEL_ID.test(value)
}

function resolvePanels(raw: unknown, diagnostics: string[]): PanelDefinition[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    diagnostics.push("invalid [[panels]]: must be an array of tables; ignoring it")
    return []
  }

  const panels: PanelDefinition[] = []
  const ids = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const name = `panels[${index}]`
    if (!isRecord(entry)) {
      diagnostics.push(`invalid ${name}: must be a table; ignoring entry`)
      continue
    }
    if (!isPanelId(entry.id)) {
      diagnostics.push(`invalid ${name}.id: use 1-32 lowercase letters, digits, or hyphens; ignoring entry`)
      continue
    }
    if (ids.has(entry.id)) {
      diagnostics.push(`duplicate panel id ${JSON.stringify(entry.id)}; ignoring later entry`)
      continue
    }
    if (
      !Array.isArray(entry.command) ||
      entry.command.length === 0 ||
      !entry.command.every((part) => typeof part === "string") ||
      entry.command[0]?.trim() === ""
    ) {
      diagnostics.push(`invalid ${name}.command: must be a non-empty argv array; ignoring entry`)
      continue
    }
    const label = entry.label === undefined ? entry.id : entry.label
    if (typeof label !== "string" || label.trim() === "") {
      diagnostics.push(`invalid ${name}.label: must be a non-empty string; ignoring entry`)
      continue
    }
    if (entry.persistent !== undefined && typeof entry.persistent !== "boolean") {
      diagnostics.push(`invalid ${name}.persistent: must be true or false; using true`)
    }
    ids.add(entry.id)
    panels.push({
      id: entry.id,
      label: label.trim(),
      command: [...entry.command],
      persistent: typeof entry.persistent === "boolean" ? entry.persistent : true,
    })
  }
  return panels
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

function resolveWorktreeRoot(raw: unknown, diagnostics: string[]): string {
  if (raw === undefined) return DEFAULT_WORKTREE_ROOT
  if (typeof raw !== "string" || raw.trim() === "") {
    diagnostics.push("invalid worktree_root: must be a directory; using the default")
    return DEFAULT_WORKTREE_ROOT
  }
  return raw
}

function defaultConfig(...diagnostics: string[]): LoadedConfig {
  return {
    keybindings: resolveKeybindings().keybindings,
    projectRoots: [],
    worktreeRoot: DEFAULT_WORKTREE_ROOT,
    panels: [],
    diagnostics,
  }
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
