import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fmxDirectory } from "./state.ts"
import { isSessionId } from "./fx-sessions.ts"

/**
 * Where minted slugs live: one file per fx session, named by the session id
 * and holding the slug. One file rather than a key in `state.json` because a
 * slug outlives the fmx that paid for it and two fmx processes name sessions
 * at the same time — a whole-file rewrite would lose one of them, while
 * separate files cannot collide.
 *
 * The store is also the index the other direction. A slug stands in for a
 * session id wherever one is accepted, so it has to be unique: minting checks
 * the store and suffixes a collision rather than pointing one name at two
 * conversations.
 */

/** A claim is held only while a naming attempt runs. Its owner writes its pid
 * so an attempt killed mid-flight (a reboot, a `kill -9`) does not lock its
 * session out of ever being named. */
const CLAIM_SUFFIX = ".naming"
const MAX_COLLISION_SUFFIX = 99

export function slugDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return join(fmxDirectory(env, homeDirectory), "slugs")
}

export function readSlug(directory: string, sessionId: string): string | null {
  if (!isSessionId(sessionId)) return null
  return readSlugFile(join(directory, sessionId))
}

/**
 * Persist a slug, disambiguating it against the slugs already stored. Answers
 * the slug as stored, which is the one to draw and the one that resolves.
 * Answers null when the store cannot be written — inference was paid for and
 * lost, but a session that cannot be named still runs.
 */
export function storeSlug(directory: string, sessionId: string, slug: string): string | null {
  if (!isSessionId(sessionId)) return null
  const unique = uniqueSlug(directory, sessionId, slug)
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, sessionId), `${unique}\n`, "utf8")
    return unique
  } catch {
    return null
  }
}

/** The session a reference names, whether it is a slug or a session id. */
export function resolveRef(directory: string, ref: string): string | null {
  if (isSessionId(ref) && readSlug(directory, ref) !== null) return ref
  for (const [sessionId, slug] of storedSlugs(directory)) {
    if (slug === ref) return sessionId
  }
  return null
}

/**
 * Take the right to name a session, so concurrent fmx processes spend one
 * completion between them rather than one each. An exclusive create elects the
 * owner; a claim whose owner is gone was orphaned and is taken over.
 */
export function claimNaming(directory: string, sessionId: string): boolean {
  if (!isSessionId(sessionId)) return false
  const path = join(directory, `${sessionId}${CLAIM_SUFFIX}`)
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, `${process.pid}\n`, { encoding: "utf8", flag: "wx" })
    return true
  } catch {
    // Anything already there is either a live namer's claim or an orphan.
    if (!claimIsOrphaned(path)) return false
  }
  try {
    writeFileSync(path, `${process.pid}\n`, "utf8")
    return true
  } catch {
    return false
  }
}

/** Release a claim so a later attempt can re-arm. Held claims are never a
 * record of anything; only the slug file is. */
export function releaseNaming(directory: string, sessionId: string): void {
  if (!isSessionId(sessionId)) return
  try {
    unlinkSync(join(directory, `${sessionId}${CLAIM_SUFFIX}`))
  } catch {
    // Already gone, or never ours to release.
  }
}

function claimIsOrphaned(path: string): boolean {
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return true
  if (pid === process.pid) return true
  try {
    // Signal 0 tests for the process without disturbing it.
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means a live process fmx may not signal, which is still a live
    // claim; anything else means the owner is gone.
    return (error as NodeJS.ErrnoException).code !== "EPERM"
  }
}

function uniqueSlug(directory: string, sessionId: string, slug: string): string {
  const taken = new Set<string>()
  for (const [storedSession, storedSlug] of storedSlugs(directory)) {
    if (storedSession !== sessionId) taken.add(storedSlug)
  }
  if (!taken.has(slug)) return slug
  for (let suffix = 2; suffix <= MAX_COLLISION_SUFFIX; suffix += 1) {
    const candidate = `${slug}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${slug}-${sessionId.slice(-8)}`
}

function* storedSlugs(directory: string): Generator<[string, string]> {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.endsWith(CLAIM_SUFFIX)) continue
    const slug = readSlugFile(join(directory, entry))
    if (slug !== null) yield [entry, slug]
  }
}

function readSlugFile(path: string): string | null {
  try {
    const slug = readFileSync(path, "utf8").trim()
    return slug === "" ? null : slug
  } catch {
    return null
  }
}
