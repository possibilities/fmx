import { readFileSync } from "node:fs"
import { fxSessionDirectory, isSessionId } from "./fx-sessions.ts"

export const NATIVE_SESSION_NAME_MAX_BYTES = 240

export type SessionNamesOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
}

/** Native fx names, keyed by fx session rather than by the Agent showing it. */
export class SessionNames {
  private readonly env: NodeJS.ProcessEnv
  private readonly names = new Map<string, string>()

  constructor(options: SessionNamesOptions = {}) {
    this.env = { ...(options.env ?? process.env) }
    if (options.home) this.env.HOME = options.home
  }

  nameFor(sessionId: string): string | null {
    return this.names.get(sessionId) ?? null
  }

  apply(sessionId: string, rawName: string): boolean {
    if (!isSessionId(sessionId)) return false
    const name = nativeSessionName(rawName)
    if (!name || this.names.get(sessionId) === name) return false
    this.names.set(sessionId, name)
    return true
  }

  /** Re-read fx's durable authority after startup, identity change, or a feed gap. */
  recover(sessionId: string): boolean {
    if (!isSessionId(sessionId)) return false
    const name = readNativeSessionName(sessionId, this.env)
    if (name === null) return this.names.delete(sessionId)
    return this.apply(sessionId, name)
  }

  forget(sessionId: string): void {
    this.names.delete(sessionId)
  }
}

export function readNativeSessionName(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const directory = fxSessionDirectory(sessionId, env)
  if (!directory) return null
  let value: unknown
  try {
    value = JSON.parse(readFileSync(`${directory}/display.json`, "utf8"))
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.title !== "string") return null
  return nativeSessionName(value.title)
}

export function nativeSessionName(raw: string): string | null {
  if (raw.trim().length === 0 || Buffer.byteLength(raw, "utf8") > NATIVE_SESSION_NAME_MAX_BYTES) return null
  for (const character of raw) {
    const codepoint = character.codePointAt(0)!
    if (codepoint <= 0x1f || codepoint === 0x7f) return null
  }
  return raw
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
