import { access, constants, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

/** The development override for where fx is. */
export const FX_PATH_ENV_VAR = "FMX_FX_PATH"

/**
 * Resolve fx from `FMX_FX_PATH`, else `fx` on PATH. A path is taken as
 * given; a bare name is looked up. There is deliberately no flag.
 */
export async function resolveFx(
  requested: string = process.env[FX_PATH_ENV_VAR] ?? "fx",
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidate = requested.includes("/")
    ? isAbsolute(requested)
      ? requested
      : resolve(process.cwd(), requested)
    : Bun.which(requested, { PATH: env.PATH ?? "" })
  if (!candidate) throw new Error(`fx executable not found: ${requested} (set ${FX_PATH_ENV_VAR})`)
  try {
    await access(candidate, constants.X_OK)
  } catch {
    throw new Error(`fx executable is not executable: ${candidate}`)
  }
  return realpath(candidate)
}
