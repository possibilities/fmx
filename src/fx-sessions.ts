import { homedir } from "node:os"
import { join } from "node:path"

/** Safe paths into fx's profile-owned session store. */

export function fxHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || homedir()
}

export function fxProfileDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(fxHomeDirectory(env), ".fx")
}

/**
 * fx addresses sessions by an id that reaches fmx over a socket, so it is
 * checked before it is ever joined to a path. Real ids are
 * `<millis>-<nanos>-<hex>`; anything that could climb out of the sessions
 * directory is not one.
 */
export function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..")
}

export function fxSessionDirectory(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isSessionId(sessionId)) return null
  return join(fxProfileDirectory(env), "sessions", sessionId)
}
