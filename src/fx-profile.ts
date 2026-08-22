import { renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fxProfileDirectory } from "./fx-sessions.ts"
import { fmxDirectory } from "./state.ts"

/**
 * The half of slug inference that has to reach into fx's own configuration.
 *
 * Naming runs `fx ask`, which means it runs at whatever model and reasoning
 * effort the human configured for their own work — a session titled at `max`
 * costs what a session's work costs. The model is overridable per call through
 * `FX_MODEL`; the effort is not, and no environment variable or project file
 * can set it: fx rejects `effort` from a workspace's own `.fx.json` as a
 * user-only setting.
 *
 * What fx does honor is a per-workspace entry in the human's own settings:
 * `workspaces["<absolute path>"]` overrides settings for work done in exactly
 * that directory. So naming runs in a workspace fmx owns and nothing else uses,
 * and fmx adds one entry for that path. It touches no other key, writes only
 * when the entry is missing or its effort differs, and abandons the write if
 * the file changed while it was being read — losing a `/model` a human just
 * chose is a far worse outcome than a slug minted at the wrong effort.
 */

export type FxProvider = "gateway" | "codex" | "grok"

const PROVIDERS: readonly string[] = ["gateway", "codex", "grok"]

/** Where slug completions run. It stays empty: `fx ask` starts an agent, and
 * an agent that finds nothing to read cannot wander into a real project. */
export function inferenceWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return join(fmxDirectory(env, homeDirectory), "inference")
}

export function fxSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(fxProfileDirectory(env), "settings.json")
}

/**
 * Which provider fx is configured for, which is what decides the model naming
 * asks for. Gateway is fx's own default and so fmx's.
 */
export function readFxProvider(settingsPath: string): FxProvider {
  const settings = readSettings(settingsPath)
  const provider = settings?.document.provider
  return typeof provider === "string" && PROVIDERS.includes(provider)
    ? (provider as FxProvider)
    : "gateway"
}

export type ProfileOutcome = "written" | "current" | "skipped"

/**
 * Give the inference workspace its own reasoning effort in fx's settings.
 *
 * `skipped` is the ordinary answer on a machine with no fx settings file at
 * all: fx's own default effort is already the cheap one, so there is nothing
 * to correct and no reason for fmx to create a file in someone else's profile.
 */
export function ensureInferenceEffort(
  settingsPath: string,
  workspace: string,
  effort: string,
): ProfileOutcome {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(effort)) return "skipped"
  const settings = readSettings(settingsPath)
  if (!settings) return "skipped"

  const workspaces = isRecord(settings.document.workspaces) ? settings.document.workspaces : {}
  const existing = isRecord(workspaces[workspace]) ? workspaces[workspace] : {}
  if (existing.effort === effort) return "current"

  const updated = {
    ...settings.document,
    // Merge rather than replace: the entry is fmx's to add, but anything a
    // human put beside it there is theirs to keep.
    workspaces: { ...workspaces, [workspace]: { ...existing, effort } },
  }
  return writeSettings(settingsPath, updated, settings) ? "written" : "skipped"
}

type LoadedSettings = {
  document: Record<string, unknown>
  mtimeMs: number
  mode: number
}

function readSettings(path: string): LoadedSettings | null {
  try {
    const stat = statSync(path)
    const document: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isRecord(document)) return null
    return { document, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 }
  } catch {
    // Missing, unreadable, or not JSON fmx should be rewriting.
    return null
  }
}

function writeSettings(
  path: string,
  document: Record<string, unknown>,
  read: LoadedSettings,
): boolean {
  const temporaryPath = `${path}.fmx.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: read.mode,
    })
  } catch {
    return false
  }
  try {
    // The window between the read and this rename is the only one in which fx
    // could have written the file itself. Checking it here does not close the
    // window, but it narrows it to a rename, and a lost entry costs one slug
    // at the wrong effort — the next start adds it again.
    if (statSync(path).mtimeMs !== read.mtimeMs) {
      unlinkSync(temporaryPath)
      return false
    }
    renameSync(temporaryPath, path)
    return true
  } catch {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // Nothing left to clean up.
    }
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
