import { createHash } from "node:crypto"
import { access, constants, mkdir, realpath, stat } from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import companionPin from "../companion.json" with { type: "json" }
import { fmxDirectory } from "./state.ts"

/** The development override for where the Companion binary is. */
export const COMPANION_PATH_ENV_VAR = "FMX_ZMX_PATH"
/** Where the Companion keeps its sessions; a test or demo points it somewhere private. */
export const COMPANION_DIRECTORY_ENV_VAR = "FMX_ZMX_DIR"
/** What the Companion is called when it is found beside fmx or on PATH rather than named. */
export const COMPANION_BINARY_NAME = "fmx-zmx"

/**
 * The Companion pin: the fork commit this fmx was released with, and the
 * build string a Companion built from it reports (`fmx-zmx version`, first
 * line). A release ships the pair; fmx refuses any other Companion it finds
 * beside itself or on PATH, because the protocol is the pair's and a build
 * that is not the pinned one has nothing to promise.
 */
export const COMPANION_PIN: { repository: string; branch: string; commit: string; build: string } = companionPin

/**
 * Variables the Companion's own protocol defines. Any of them inherited by
 * fmx name a zmx that is not ours — a human running fmx inside their own zmx
 * session — and would make the Companion create into, or prefix for, a
 * stranger's directory. Every Companion command and every fx fmx starts is
 * started without them.
 */
export const INHERITED_COMPANION_VARIABLES = [
  "ZMX_DIR",
  "ZMX_SESSION",
  "ZMX_SESSION_PREFIX",
  "ZMX_SCROLLBACK_LINES",
  "ZMX_NO_DETACH_KEY",
] as const

/**
 * The Home id: what labels every session this fmx creates and keys its
 * stable agent socket. Derived from the fmx directory's path rather than
 * minted and stored, so a Home whose manifest is lost can still recognize
 * its own sessions by label, and two Homes on one machine (two
 * `XDG_CONFIG_HOME`s) never collide.
 */
export function homeIdFor(directory: string): string {
  return createHash("sha256").update(directory).digest("hex").slice(0, 12)
}

export function homeId(env: NodeJS.ProcessEnv = process.env): string {
  return homeIdFor(fmxDirectory(env))
}

/**
 * Where the Companion keeps sockets and exit records. Under `/tmp` rather
 * than the config directory because macOS caps a socket path near 104 bytes
 * and a session name carries a 32-character instance id; and because the
 * sessions themselves do not survive a reboot, so neither need their records.
 */
export function companionDirectory(
  env: NodeJS.ProcessEnv = process.env,
  uid: number = userInfo().uid,
): string {
  return companionDirectories(env, uid).at(-1)!
}

/**
 * The directories fmx owns on the way to the Companion's, outermost first:
 * `/tmp/fmx-<uid>` and its `zmx` by default, or just the one an override
 * names — whatever is above that is the caller's.
 */
export function companionDirectories(
  env: NodeJS.ProcessEnv = process.env,
  uid: number = userInfo().uid,
): string[] {
  if (env[COMPANION_DIRECTORY_ENV_VAR]) return [env[COMPANION_DIRECTORY_ENV_VAR]]
  return [`/tmp/fmx-${uid}`, `/tmp/fmx-${uid}/zmx`]
}

/**
 * The environment a Companion command runs in, and therefore the one its
 * child inherits: the caller's (normally the fx environment already built
 * for the instance) with every inherited zmx variable removed and ours set.
 */
export function companionEnvironment(
  parent: NodeJS.ProcessEnv,
  directory: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if ((INHERITED_COMPANION_VARIABLES as readonly string[]).includes(key)) continue
    env[key] = value
  }
  env.ZMX_DIR = directory
  return env
}

/**
 * Make the Companion's directory ours, or refuse it. `/tmp` is shared, so
 * the path is predictable and anyone could have made it first: a directory
 * another user owns, or one others can write to, could hold sockets that
 * answer as our sessions and be joined as them. Both levels are created
 * private and checked every start; nothing is created into one that fails.
 */
export async function ensureCompanionDirectories(directories: readonly string[], uid: number = userInfo().uid): Promise<void> {
  for (const path of directories) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error(`Companion directory ${path} is not a directory`)
    if (info.uid !== uid) throw new Error(`Companion directory ${path} is owned by uid ${info.uid}, not ${uid}; refusing to use it`)
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`Companion directory ${path} is readable or writable by others (mode ${(info.mode & 0o777).toString(8)}); refusing to use it`)
    }
  }
}

/**
 * Where a Companion was found. `override` is `FMX_ZMX_PATH`, the development
 * loop: a checkout's fmx against a checkout's fork, which may be a debug
 * build or a commit ahead of the pin. `sibling` is the release layout —
 * `fmx-zmx` beside the fmx binary, where the installer put it — and `path`
 * is `fmx-zmx` on PATH. Only the override may run an unpinned build.
 */
export type CompanionOrigin = "override" | "sibling" | "path"
export type ResolvedCompanion = { path: string; origin: CompanionOrigin }

/**
 * The directory the running fmx was installed in: where the installer put
 * `fmx-zmx` beside it. Only a compiled release has one — `process.execPath`
 * is the binary itself (symlinks resolved) when Bun's main module is the
 * embedded one; from a checkout it would be `bun`, whose directory is no
 * installation of fmx.
 */
export function installedDirectory(): string | null {
  if (!Bun.main.startsWith("/$bunfs/")) return null
  return dirname(process.execPath)
}

/**
 * `FMX_ZMX_PATH` first, then `fmx-zmx` beside the installed fmx, then
 * `fmx-zmx` on PATH. Never a plain `zmx`: the protocol is the fork's, and a
 * human's own zmx would neither speak it nor keep its sessions where fmx
 * looks.
 */
export async function resolveCompanion(
  env: NodeJS.ProcessEnv = process.env,
  installDirectory: string | null = installedDirectory(),
): Promise<ResolvedCompanion> {
  const requested = env[COMPANION_PATH_ENV_VAR]
  if (requested !== undefined) {
    const candidate = requested.includes("/")
      ? isAbsolute(requested)
        ? requested
        : resolve(process.cwd(), requested)
      : Bun.which(requested)
    if (!candidate) throw new Error(`Companion executable not found: ${requested} (${COMPANION_PATH_ENV_VAR})`)
    return { path: await executable(candidate), origin: "override" }
  }
  if (installDirectory !== null) {
    const sibling = join(installDirectory, COMPANION_BINARY_NAME)
    if (await isExecutable(sibling)) return { path: await realpath(sibling), origin: "sibling" }
  }
  const onPath = Bun.which(COMPANION_BINARY_NAME, { PATH: env.PATH ?? "" })
  if (!onPath) {
    const beside = installDirectory === null ? "" : ` beside ${join(installDirectory, "fmx")} or`
    throw new Error(
      `Companion executable not found:${beside} no ${COMPANION_BINARY_NAME} on PATH (reinstall fmx, or set ${COMPANION_PATH_ENV_VAR})`,
    )
  }
  return { path: await executable(onPath), origin: "path" }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function executable(candidate: string): Promise<string> {
  if (!(await isExecutable(candidate))) throw new Error(`Companion executable is not executable: ${candidate}`)
  return realpath(candidate)
}

/**
 * The build a Companion reports: the first line of `fmx-zmx version` is
 * `zmx<tabs><build>`. Run in the Companion's own directory, which the
 * caller has already made private — the command creates the directory if
 * it must, and a stock-built fork would create it with a mode fmx refuses.
 */
export async function companionBuild(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  directory: string = companionDirectory(env),
): Promise<string> {
  const proc = Bun.spawn([path, "version"], {
    env: companionEnvironment(env, directory),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  const build = proc.exitCode === 0 ? parseCompanionVersion(stdout) : null
  if (build === null) {
    const detail = stderr.trim() || stdout.trim() || `exit ${proc.exitCode}`
    throw new Error(`Companion ${path} did not report a build from \`version\`: ${detail}`)
  }
  return build
}

export function parseCompanionVersion(output: string): string | null {
  const match = /^zmx[ \t]+(\S+)[ \t]*$/m.exec(output)
  return match ? match[1]! : null
}

/**
 * What a Companion that is not the pinned build is told. Under the override
 * it is a diagnostic and fmx runs — the wire still negotiates, and a fork
 * under development is exactly what the override is for. Found beside fmx
 * or on PATH, it is fatal: that is an installation, and a mismatched pair
 * is never used quietly.
 */
export function companionMismatch(companion: ResolvedCompanion, build: string, protocolVersion: number): string {
  const where = companion.origin === "override" ? ` (${COMPANION_PATH_ENV_VAR})` : companion.origin === "sibling" ? " (beside fmx)" : " (on PATH)"
  const facts = `Companion ${companion.path}${where} is build ${build}; this fmx was released with ${COMPANION_PIN.build} (protocol ${protocolVersion})`
  if (companion.origin === "override") return `${facts}; running under the override`
  return `${facts}. Reinstall fmx to restore the pair, or set ${COMPANION_PATH_ENV_VAR} to a matching build`
}
