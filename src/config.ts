import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, normalize, relative, resolve, sep } from "node:path"
import { resolveFmxHome } from "./home.ts"
import { resolveKeybindings, type Keybindings } from "./keybindings.ts"

export type AgentDefaults = {
  stateDir?: string
  model?: string
  effort?: string
}

export type WorkplaceMember = {
  placementId: string
  fmxSession: string
}

export type WorkplaceAssociation = {
  workplaceInstanceId: string
  extensionId: string
  configurationId: string
  members: readonly WorkplaceMember[]
}

export type WorkplaceMembership = WorkplaceAssociation & WorkplaceMember

export type LoadedConfig = {
  keybindings: Keybindings
  /** Directories fmx may use as a Home's working directory. */
  projectRoots: string[]
  /** Where a requested Agent Worktree is checked out. */
  worktreeRoot: string
  /** Strict, role-neutral Runtime-extension associations. */
  workplaceAssociations: readonly WorkplaceAssociation[]
  /** Exact fmx Session selectors to independent Fx launch defaults. */
  agentDefaults: Readonly<Record<string, AgentDefaults>>
  /** New contracts fail closed on Runtime creation instead of becoming plain fmx. */
  runtimeConfigurationErrors: readonly string[]
  diagnostics: string[]
}

const KNOWN_SECTIONS = new Set([
  "keys",
  "project_roots",
  "worktree_root",
  "workplace_instances",
  "agent_defaults",
])
const CONFIGURED_CONTRACT_SECTION = /(?:^|\n)\s*\[(?:workplace_instances|agent_defaults)(?:\.|\])/u
const OPAQUE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u
const EXTENSION_ID = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/u
const FMX_SESSION = /^(?:default|[a-z][a-z0-9_-]{0,31})$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

/** Unlike the project roots, this one has a usable default: it names fmx's
 * own directory rather than guessing where anybody keeps their work. */
export const DEFAULT_WORKTREE_ROOT = "~/.fmx/worktrees"

export function configPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return resolveFmxHome(null, env, homeDirectory).configPath
}

export async function loadConfig(
  path = configPath(),
  homeDirectory: string = homedir(),
): Promise<LoadedConfig> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return defaultConfig()
    return defaultConfig([`config read error: ${errorMessage(error)}; using defaults`])
  }

  let document: unknown
  try {
    document = Bun.TOML.parse(content)
  } catch (error) {
    const diagnostic = `config parse error: ${errorMessage(error)}; using defaults`
    return defaultConfig(
      [diagnostic],
      CONFIGURED_CONTRACT_SECTION.test(content) ? [diagnostic] : [],
    )
  }

  if (!isRecord(document)) {
    const diagnostic = "config parse error: top-level config must be a table; using defaults"
    return defaultConfig([diagnostic], CONFIGURED_CONTRACT_SECTION.test(content) ? [diagnostic] : [])
  }

  const diagnostics: string[] = []
  for (const section of Object.keys(document)) {
    if (!KNOWN_SECTIONS.has(section)) {
      diagnostics.push(`unknown config section [${section}]; ignoring section`)
    }
  }
  const resolved = resolveKeybindings(document.keys)
  diagnostics.push(...resolved.diagnostics)
  const runtimeConfigurationErrors: string[] = []
  const workplaceAssociations = resolveWorkplaceAssociations(
    document.workplace_instances,
    runtimeConfigurationErrors,
  )
  const agentDefaults = resolveAgentDefaultsTable(
    document.agent_defaults,
    homeDirectory,
    runtimeConfigurationErrors,
  )
  return {
    keybindings: resolved.keybindings,
    projectRoots: resolveProjectRoots(document.project_roots, diagnostics),
    worktreeRoot: resolveWorktreeRoot(document.worktree_root, diagnostics),
    workplaceAssociations,
    agentDefaults,
    runtimeConfigurationErrors,
    diagnostics,
  }
}

/** Resolve one exact selector. Associations never infer or classify roles. */
export function workplaceMembershipFor(
  config: LoadedConfig,
  fmxSession: string,
): WorkplaceMembership | null {
  assertRuntimeConfiguration(config)
  for (const association of config.workplaceAssociations) {
    const member = association.members.find((candidate) => candidate.fmxSession === fmxSession)
    if (member) return { ...association, ...member }
  }
  return null
}

/** Independent field values for one exact named/default fmx Session. */
export function agentDefaultsFor(config: LoadedConfig, fmxSession: string): AgentDefaults {
  assertRuntimeConfiguration(config)
  const defaults = config.agentDefaults[fmxSession]
  return defaults ? { ...defaults } : {}
}

export function assertRuntimeConfiguration(config: LoadedConfig): void {
  if (config.runtimeConfigurationErrors.length === 0) return
  throw new Error(`invalid Runtime configuration: ${config.runtimeConfigurationErrors.join("; ")}`)
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

function defaultConfig(
  diagnostics: string[] = [],
  runtimeConfigurationErrors: string[] = [],
): LoadedConfig {
  return {
    keybindings: resolveKeybindings().keybindings,
    projectRoots: [],
    worktreeRoot: DEFAULT_WORKTREE_ROOT,
    workplaceAssociations: [],
    agentDefaults: {},
    runtimeConfigurationErrors,
    diagnostics,
  }
}

function resolveWorkplaceAssociations(
  raw: unknown,
  errors: string[],
): WorkplaceAssociation[] {
  if (raw === undefined) return []
  if (!isRecord(raw)) {
    errors.push("[workplace_instances] must be a table")
    return []
  }

  const associations: WorkplaceAssociation[] = []
  const sessionOwners = new Map<string, string>()
  for (const [workplaceInstanceId, value] of Object.entries(raw)) {
    const label = `workplace_instances.${workplaceInstanceId}`
    if (!OPAQUE_ID.test(workplaceInstanceId)) {
      errors.push(`${label} has an invalid Workplace instance id`)
      continue
    }
    if (!isRecord(value)) {
      errors.push(`${label} must be a table`)
      continue
    }
    const unknown = unknownKeys(value, ["schema_version", "extension", "configuration", "role_surfaces"])
    if (unknown.length > 0) {
      errors.push(`${label} has unknown field ${unknown[0]}`)
      continue
    }
    if (value.schema_version !== 1) {
      errors.push(`${label}.schema_version must be 1`)
      continue
    }
    if (typeof value.extension !== "string" || !EXTENSION_ID.test(value.extension)) {
      errors.push(`${label}.extension must be a safe extension id`)
      continue
    }
    if (typeof value.configuration !== "string" || !OPAQUE_ID.test(value.configuration)) {
      errors.push(`${label}.configuration must be an opaque configuration id`)
      continue
    }
    if (!isRecord(value.role_surfaces)) {
      errors.push(`${label}.role_surfaces must be a table with exactly two members`)
      continue
    }
    const placements = Object.entries(value.role_surfaces)
    if (placements.length !== 2) {
      errors.push(`${label}.role_surfaces must contain exactly two members`)
      continue
    }
    const members: WorkplaceMember[] = []
    let valid = true
    for (const [placementId, fmxSession] of placements) {
      if (!OPAQUE_ID.test(placementId)) {
        errors.push(`${label}.role_surfaces has an invalid placement id ${JSON.stringify(placementId)}`)
        valid = false
      } else if (typeof fmxSession !== "string" || !FMX_SESSION.test(fmxSession)) {
        errors.push(`${label}.role_surfaces.${placementId} must name an exact fmx Session selector`)
        valid = false
      } else {
        members.push({ placementId, fmxSession })
      }
    }
    if (!valid) continue
    if (members[0]!.fmxSession === members[1]!.fmxSession) {
      errors.push(`${label}.role_surfaces must name two distinct fmx Sessions`)
      continue
    }
    for (const member of members) {
      const owner = sessionOwners.get(member.fmxSession)
      if (owner !== undefined) {
        errors.push(`fmx Session ${member.fmxSession} belongs to both ${owner} and ${workplaceInstanceId}`)
        valid = false
      }
    }
    if (!valid) continue
    members.sort((left, right) => left.placementId < right.placementId ? -1 : left.placementId > right.placementId ? 1 : 0)
    for (const member of members) sessionOwners.set(member.fmxSession, workplaceInstanceId)
    associations.push({
      workplaceInstanceId,
      extensionId: value.extension,
      configurationId: value.configuration,
      members,
    })
  }
  return associations
}

function resolveAgentDefaultsTable(
  raw: unknown,
  homeDirectory: string,
  errors: string[],
): Record<string, AgentDefaults> {
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    errors.push("[agent_defaults] must be a table")
    return {}
  }
  const defaults: Record<string, AgentDefaults> = {}
  for (const [fmxSession, value] of Object.entries(raw)) {
    const label = `agent_defaults.${fmxSession}`
    if (!FMX_SESSION.test(fmxSession)) {
      errors.push(`${label} has an invalid fmx Session selector`)
      continue
    }
    if (!isRecord(value)) {
      errors.push(`${label} must be a table`)
      continue
    }
    const unknown = unknownKeys(value, ["state_dir", "model", "effort"])
    if (unknown.length > 0) {
      errors.push(`${label} has unknown field ${unknown[0]}`)
      continue
    }
    const entry: AgentDefaults = {}
    let valid = true
    if (value.state_dir !== undefined) {
      try {
        entry.stateDir = resolveConfiguredStateDirectory(value.state_dir, homeDirectory, `${label}.state_dir`)
      } catch (error) {
        errors.push(errorMessage(error))
        valid = false
      }
    }
    for (const [source, target, maximumBytes] of [
      ["model", "model", 160],
      ["effort", "effort", 64],
    ] as const) {
      const valueForField = value[source]
      if (valueForField === undefined) continue
      if (!isVisibleSetting(valueForField, maximumBytes)) {
        errors.push(`${label}.${source} must be nonblank, one-line text of at most ${maximumBytes} UTF-8 bytes`)
        valid = false
      } else {
        entry[target] = valueForField
      }
    }
    if (valid) defaults[fmxSession] = entry
  }
  return defaults
}

function resolveConfiguredStateDirectory(raw: unknown, homeDirectory: string, label: string): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 4096 ||
    raw.trim() !== raw ||
    CONTROL_CHARACTERS.test(raw) ||
    raw.includes("\\")
  ) {
    throw new Error(`${label} must be a safe absolute or ~/ directory`)
  }
  const normalizedHome = normalize(homeDirectory)
  if (!isAbsolute(normalizedHome) || normalizedHome === "/") {
    throw new Error(`${label} cannot be resolved against an invalid home directory`)
  }
  const usesHome = raw === "~" || raw.startsWith("~/")
  if ((raw.startsWith("~") && !usesHome) || (!usesHome && !isAbsolute(raw))) {
    throw new Error(`${label} must be a safe absolute or ~/ directory`)
  }
  const expanded = usesHome
    ? raw === "~"
      ? normalizedHome
      : resolve(normalizedHome, raw.slice(2))
    : resolve(raw)
  const normalizedPath = normalize(expanded)
  if (normalizedPath === "/") throw new Error(`${label} must not name the filesystem root`)
  if (usesHome) {
    const fromHome = relative(normalizedHome, normalizedPath)
    if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
      throw new Error(`${label} must not escape the home directory`)
    }
  }
  return normalizedPath
}

function isVisibleSetting(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    !CONTROL_CHARACTERS.test(value) &&
    Buffer.byteLength(value) <= maximumBytes
}

function unknownKeys(value: Record<string, unknown>, known: readonly string[]): string[] {
  const allowed = new Set(known)
  return Object.keys(value).filter((key) => !allowed.has(key))
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
