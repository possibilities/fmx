import { createHash } from "node:crypto"
import { access, constants, realpath } from "node:fs/promises"
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
  if (env[COMPANION_DIRECTORY_ENV_VAR]) return env[COMPANION_DIRECTORY_ENV_VAR]
  return `/tmp/fmx-${uid}/zmx`
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
  // The detach chord is for a human at `zmx attach`; fmx is the only client
  // of these sessions and every byte it sends belongs to fx.
  env.ZMX_NO_DETACH_KEY = "1"
  return env
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
