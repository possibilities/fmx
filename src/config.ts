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
  slug: SlugSettings
  diagnostics: string[]
}

/** How an instance earns a name from its first prompt. */
export type SlugSettings = {
  enabled: boolean
  /** Reasoning effort the naming completion runs at. */
  effort: string
  /** Whether fmx may give its inference workspace that effort in fx's own
   * settings — the only place fx accepts one. */
  manageEffort: boolean
  timeoutMs: number
  /** Model to name at, per fx provider. A provider with no entry names at
   * whatever model fx is already configured for. */
  models: Record<string, string>
}

const KNOWN_SECTIONS = new Set(["keys", "project_roots", "worktree_root", "slug"])

/** Unlike the project roots, this one has a usable default: it names fmx's
 * own directory rather than guessing where anybody keeps their work. */
export const DEFAULT_WORKTREE_ROOT = "~/.fmx/worktrees"

/**
 * Naming asks for very little — a title of a few words — so it should ask the
 * smallest model a provider offers. Only codex has a default: a shipped guess
 * at another provider's catalog would be a model id that does not exist there,
 * and a provider fmx has no default for names at the configured model, which
 * always works.
 */
const DEFAULT_SLUG_MODELS: Readonly<Record<string, string>> = { codex: "gpt-5.4-mini" }
const DEFAULT_SLUG_EFFORT = "low"
const DEFAULT_SLUG_TIMEOUT_MS = 60_000

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
    slug: resolveSlugSettings(document.slug, diagnostics),
    diagnostics,
  }
}

export function defaultSlugSettings(): SlugSettings {
  return {
    enabled: true,
    effort: DEFAULT_SLUG_EFFORT,
    manageEffort: true,
    timeoutMs: DEFAULT_SLUG_TIMEOUT_MS,
    models: { ...DEFAULT_SLUG_MODELS },
  }
}

function resolveSlugSettings(raw: unknown, diagnostics: string[]): SlugSettings {
  const settings = defaultSlugSettings()
  if (raw === undefined) return settings
  if (!isRecord(raw)) {
    diagnostics.push("invalid [slug]: must be a table; using defaults")
    return settings
  }

  const enabled = readBoolean(raw.enabled, "slug.enabled", diagnostics)
  if (enabled !== null) settings.enabled = enabled
  const manageEffort = readBoolean(raw.manage_effort, "slug.manage_effort", diagnostics)
  if (manageEffort !== null) settings.manageEffort = manageEffort

  if (raw.effort !== undefined) {
    if (typeof raw.effort === "string" && raw.effort.trim() !== "") {
      settings.effort = raw.effort.trim()
    } else {
      diagnostics.push("invalid slug.effort: must be a non-empty string; using the default")
    }
  }

  if (raw.timeout_ms !== undefined) {
    if (typeof raw.timeout_ms === "number" && Number.isInteger(raw.timeout_ms) && raw.timeout_ms > 0) {
      settings.timeoutMs = raw.timeout_ms
    } else {
      diagnostics.push("invalid slug.timeout_ms: must be a positive whole number; using the default")
    }
  }

  if (raw.models !== undefined) {
    if (!isRecord(raw.models)) {
      diagnostics.push("invalid [slug.models]: must be a table of provider = model; ignoring it")
    } else {
      for (const [provider, model] of Object.entries(raw.models)) {
        if (typeof model === "string" && model.trim() !== "") {
          settings.models[provider] = model.trim()
        } else {
          diagnostics.push(`invalid slug model for ${provider}: must be a model id; ignoring entry`)
        }
      }
    }
  }

  return settings
}

function readBoolean(raw: unknown, name: string, diagnostics: string[]): boolean | null {
  if (raw === undefined) return null
  if (typeof raw === "boolean") return raw
  diagnostics.push(`invalid ${name}: must be true or false; using the default`)
  return null
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
    slug: defaultSlugSettings(),
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
