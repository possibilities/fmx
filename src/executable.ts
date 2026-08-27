import { access, constants, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import fxPin from "../fx.json" with { type: "json" }
import { installedDirectory } from "./zmx-environment.ts"

/** The development override for where fx is. */
export const FX_PATH_ENV_VAR = "FMX_FX_PATH"
export const FMX_FX_BINARY_NAME = "fmx-fx"
export const MIN_FXNK_VERSION = fxPin.fxnk
export const FX_PIN: { repository: string; branch: string; commit: string; fxnk: string } = fxPin
const FXNK_PROBE_TIMEOUT_MS = 2_000

/**
 * Resolve Fx once for a Runtime: `FMX_FX_PATH`, the installed sibling
 * `fmx-fx`, `fmx-fx` on PATH, then the legacy `fx` on PATH. A path is taken
 * as given; a bare override is looked up. The resolved executable must expose
 * the ADE lifecycle contract carried by the pinned minimum fxnk version.
 */
export async function resolveFx(
  requested: string | undefined = process.env[FX_PATH_ENV_VAR],
  env: NodeJS.ProcessEnv = process.env,
  installDirectory: string | null = installedDirectory(),
): Promise<string> {
  let candidate: string | null = null
  if (requested) {
    candidate = requested.includes("/")
      ? isAbsolute(requested)
        ? requested
        : resolve(process.cwd(), requested)
      : Bun.which(requested, { PATH: env.PATH ?? "" })
    if (!candidate) throw new Error(`Fx executable not found: ${requested} (${FX_PATH_ENV_VAR})`)
  } else {
    if (installDirectory !== null) {
      const sibling = join(installDirectory, FMX_FX_BINARY_NAME)
      if (await isExecutable(sibling)) candidate = sibling
    }
    candidate ??= Bun.which(FMX_FX_BINARY_NAME, { PATH: env.PATH ?? "" })
    candidate ??= Bun.which("fx", { PATH: env.PATH ?? "" })
    if (!candidate) {
      const beside = installDirectory === null ? "" : ` beside ${join(installDirectory, "fmx")},`
      throw new Error(
        `Fx executable not found:${beside} no ${FMX_FX_BINARY_NAME} or fx on PATH (reinstall fmx, or set ${FX_PATH_ENV_VAR})`,
      )
    }
  }
  if (!(await isExecutable(candidate))) throw new Error(`Fx executable is not executable: ${candidate}`)
  const path = await realpath(candidate)
  const version = await probeFxnkVersion(path, env)
  if (!version || compareVersions(version, MIN_FXNK_VERSION) < 0) {
    const detail = version ? `${path} reports fxnk ${version}` : `${path} has no compatible --fxnk-version probe`
    throw new Error(`fmx requires fxnk >= ${MIN_FXNK_VERSION}; ${detail}`)
  }
  return path
}

/** A regular file we may execute: a directory passes access(X_OK) and is not one. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
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
