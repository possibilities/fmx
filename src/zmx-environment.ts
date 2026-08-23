import { createHash } from "node:crypto"
import { access, constants, mkdir, realpath, stat } from "node:fs/promises"
import { userInfo } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { fmxDirectory } from "./state.ts"

/** The development override for where the Companion binary is. */
export const COMPANION_PATH_ENV_VAR = "FMX_ZMX_PATH"
/** Where the Companion keeps its sessions; a test or demo points it somewhere private. */
export const COMPANION_DIRECTORY_ENV_VAR = "FMX_ZMX_DIR"
/** What the Companion is called when it is found on PATH rather than named. */
export const COMPANION_BINARY_NAME = "fmx-zmx"

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
 * `FMX_ZMX_PATH` first, then `fmx-zmx` on PATH. Never a plain `zmx`: the
 * protocol is the fork's, and a human's own zmx would neither speak it nor
 * keep its sessions where fmx looks.
 */
export async function resolveCompanion(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const requested = env[COMPANION_PATH_ENV_VAR] ?? COMPANION_BINARY_NAME
  const candidate = requested.includes("/")
    ? isAbsolute(requested)
      ? requested
      : resolve(process.cwd(), requested)
    : Bun.which(requested)
  if (!candidate) {
    throw new Error(`Companion executable not found: ${requested} (set ${COMPANION_PATH_ENV_VAR})`)
  }
  try {
    await access(candidate, constants.X_OK)
  } catch {
    throw new Error(`Companion executable is not executable: ${candidate}`)
  }
  return realpath(candidate)
}
