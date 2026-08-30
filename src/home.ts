import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_FMX_NAME = "default"
export const FMX_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u

const CONFIG_PATH_ENV_VAR = "FMX_CONFIG_PATH"
const STATE_PATH_ENV_VAR = "FMX_STATE_PATH"
const MANIFEST_PATH_ENV_VAR = "FMX_MANIFEST_PATH"

/** One explicitly selected fmx Home. Configuration remains shared. */
export type FmxHome = {
  /** null is the unnamed/default fmx. */
  name: string | null
  /** Shared by the default and every named fmx. */
  configDirectory: string
  configPath: string
  /** Owns this fmx's Manifest and machine UI state. */
  directory: string
  manifestPath: string
  statePath: string
  /** Keys Companion ownership and every stable private Runtime path. */
  id: string
}

export class InvalidFmxNameError extends Error {
  constructor(readonly value: string) {
    super(
      `invalid fmx name: ${JSON.stringify(value)}; use 1-32 lowercase letters, digits, _ or -, starting with a letter`,
    )
    this.name = "InvalidFmxNameError"
  }
}

/** `default` is an explicit spelling of the existing unnamed fmx. */
export function normalizeFmxName(name: string | null | undefined): string | null {
  if (name === null || name === undefined || name === DEFAULT_FMX_NAME) return null
  if (!FMX_NAME_PATTERN.test(name)) throw new InvalidFmxNameError(name)
  return name
}

/** The one directory that holds shared config.toml and the default Home. */
export function fmxConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME || join(homeDirectory, ".config")
  return join(configHome, "fmx")
}

/**
 * A Home id labels every Companion session the selected fmx creates and keys
 * its stable ADE-feed and Runtime-bridge sockets. It is derived rather than
 * stored so a lost Manifest does not lose ownership, and the default digest
 * remains exactly the one fmx used before named Homes existed.
 */
export function homeIdFor(directory: string): string {
  return createHash("sha256").update(directory).digest("hex").slice(0, 12)
}

/** Resolve the shared configuration and one independent fmx-owned-state Home. */
export function resolveFmxHome(
  requestedName: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): FmxHome {
  const name = normalizeFmxName(requestedName)
  const configDirectory = fmxConfigDirectory(env, homeDirectory)
  const directory = name === null ? configDirectory : join(configDirectory, "homes", name)
  return {
    name,
    configDirectory,
    configPath: env[CONFIG_PATH_ENV_VAR] || join(configDirectory, "config.toml"),
    directory,
    manifestPath: env[MANIFEST_PATH_ENV_VAR] || join(directory, "agents.json"),
    statePath: env[STATE_PATH_ENV_VAR] || join(directory, "state.json"),
    id: homeIdFor(directory),
  }
}
