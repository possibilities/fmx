import { access, constants, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

/** The development override for where fx is. */
export const FX_PATH_ENV_VAR = "FMX_FX_PATH"
export const MIN_FXNK_VERSION = "0.5.0"
const FXNK_PROBE_TIMEOUT_MS = 2_000

/**
 * Resolve fx from `FMX_FX_PATH`, else `fx` on PATH. A path is taken as
 * given; a bare name is looked up. The resolved executable must expose the
 * ADE lifecycle contract carried by fxnk 0.5.0 or newer.
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
  const path = await realpath(candidate)
  const version = await probeFxnkVersion(path, env)
  if (!version || compareVersions(version, MIN_FXNK_VERSION) < 0) {
    const detail = version ? `${path} reports fxnk ${version}` : `${path} has no compatible --fxnk-version probe`
    throw new Error(`fmx requires fxnk >= ${MIN_FXNK_VERSION}; ${detail}`)
  }
  return path
}

export async function probeFxnkVersion(path: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const child = Bun.spawn([path, "--fxnk-version"], { env, stdout: "pipe", stderr: "pipe" })
    const timeout = setTimeout(() => child.kill(), FXNK_PROBE_TIMEOUT_MS)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout as ReadableStream<Uint8Array>).text(),
        new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      ])
      if (exitCode !== 0 || stderr !== "") return null
      const match = /^fxnk ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?) \(fx [^)\n]+\)\n?$/u.exec(stdout)
      return match?.[1] ?? null
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return null
  }
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = a.numbers[index]! - b.numbers[index]!
    if (difference !== 0) return difference
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true })
}

function parseVersion(value: string): { numbers: [number, number, number]; prerelease: string | null } {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([^+]+))?/u.exec(value)
  if (!match) return { numbers: [0, 0, 0], prerelease: null }
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  }
}
