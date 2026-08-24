import { access, constants, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

/** The development override for where fx is. */
export const FX_PATH_ENV_VAR = "FMX_FX_PATH"
/** The development override for where hunk is. */
export const HUNK_PATH_ENV_VAR = "FMX_HUNK_PATH"

/**
 * Find one tool fmx runs: the override's value, else the bare name on PATH.
 * A path is taken as given; a bare name is looked up. There are deliberately
 * no flags — a tool is where the machine says it is, or where one variable
 * says it is.
 */
export async function resolveExecutable(
  name: string,
  requested: string,
  variable: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidate = requested.includes("/")
    ? isAbsolute(requested)
      ? requested
      : resolve(process.cwd(), requested)
    : Bun.which(requested, { PATH: env.PATH ?? "" })
  if (!candidate) throw new Error(`${name} executable not found: ${requested} (set ${variable})`)
  try {
    await access(candidate, constants.X_OK)
  } catch {
    throw new Error(`${name} executable is not executable: ${candidate}`)
  }
  return realpath(candidate)
}

/** fx: `FMX_FX_PATH`, else `fx` on PATH. */
export async function resolveFx(
  requested: string = process.env[FX_PATH_ENV_VAR] ?? "fx",
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return resolveExecutable("fx", requested, FX_PATH_ENV_VAR, env)
}

/**
 * hunk: `FMX_HUNK_PATH`, else `hunk` on PATH.
 *
 * Only whether it resolves decides whether the Diff panel is offered. The
 * panel's own argv keeps the name as asked for (`hunkCommandName`), never this
 * resolved path: a realpath goes through the installed version's directory and
 * would orphan the panel's Companion session on every hunk upgrade.
 */
export async function resolveHunk(
  requested: string = process.env[HUNK_PATH_ENV_VAR] ?? "hunk",
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return resolveExecutable("hunk", requested, HUNK_PATH_ENV_VAR, env)
}

/** What the Diff panel puts in its argv: the override as written, or `hunk`. */
export function hunkCommandName(env: NodeJS.ProcessEnv = process.env): string {
  return env[HUNK_PATH_ENV_VAR] ?? "hunk"
}
