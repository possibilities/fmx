import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_INSTANCE_NAME = "default"
export const INSTANCE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u

const CONFIG_PATH_ENV_VAR = "FMX_CONFIG_PATH"

/**
 * One independent fmx: its own Runtime, Clients, Sessions, and Layout. Every
 * Instance reads the one shared configuration, and nothing else about an
 * Instance is stored — its Sessions are the Companion's, labelled with its id.
 */
export type Instance = {
  /** `default` for plain `fmx`. */
  name: string
  configDirectory: string
  /** Shared by every Instance. */
  configPath: string
  /** Labels this Instance's Companion sessions and keys its private sockets. */
  id: string
}

export class InvalidInstanceNameError extends Error {
  constructor(readonly value: string) {
    super(
      `invalid Instance name: ${JSON.stringify(value)}; use 1-32 lowercase letters, digits, _ or -, starting with a letter`,
    )
    this.name = "InvalidInstanceNameError"
  }
}

export function normalizeInstanceName(name: string | null | undefined): string {
  if (name === null || name === undefined) return DEFAULT_INSTANCE_NAME
  if (!INSTANCE_NAME_PATTERN.test(name)) throw new InvalidInstanceNameError(name)
  return name
}

/** The one directory holding the shared `config.toml`. */
export function fmxConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME || join(homeDirectory, ".config")
  return join(configHome, "fmx")
}

/**
 * An Instance id labels every Companion session it creates and keys its
 * private socket. It is derived from the name rather than stored, so nothing
 * fmx could lose can cost an Instance its Sessions.
 */
export function instanceIdFor(name: string): string {
  return createHash("sha256").update(`fmx-instance:${name}`).digest("hex").slice(0, 12)
}

export function resolveInstance(
  requestedName: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): Instance {
  const name = normalizeInstanceName(requestedName)
  const configDirectory = fmxConfigDirectory(env, homeDirectory)
  return {
    name,
    configDirectory,
    configPath: env[CONFIG_PATH_ENV_VAR] || join(configDirectory, "config.toml"),
    id: instanceIdFor(name),
  }
}
