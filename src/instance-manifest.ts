import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fmxDirectory } from "./state.ts"

const MANIFEST_PATH_ENV_VAR = "FMX_MANIFEST_PATH"
export const MANIFEST_VERSION = 1

/**
 * The Manifest: fmx's own record of the Instances its Companion holds, so a
 * restart can find them. It is a claim, not the truth — the Companion's
 * sessions are the truth, and `instance-reconcile.ts` joins the two.
 *
 * Nothing sensitive is kept: no prompt text, no environment. A crash before a
 * launch prompt is delivered leaves an unprompted fx, which is safer than a
 * replayed secret.
 */

/** The three names one Instance is known by; all three carry the same token. */
export type InstanceIdentity = {
  /** 128 random bits as 32 hex characters; the one id that never changes. */
  instanceId: string
  /** What fx addresses its frames to; the wire's term, `p_<instanceId>`. */
  paneId: string
  /** The Companion session name, `fmx-<instanceId>`. */
  zmxName: string
}

export type ManifestPhase = "creating" | "running"

export type ManifestEntry = InstanceIdentity & {
  /** The number fmx's UI knows the Instance by; persisted, never reused. */
  displayId: number
  cwd: string
  fxPath: string
  /** `null` when unknown: an adopted Instance's argv comes from a display string the Companion truncates. */
  fxArgs: string[] | null
  createdAt: number
  fxSessionId: string | null
  /**
   * `creating` from the moment the entry is written until the Companion
   * acknowledges the start. An entry still `creating` after a restart is a
   * crash inside that window, and only the Companion can say what became of
   * it.
   */
  phase: ManifestPhase
}

export type Manifest = {
  version: typeof MANIFEST_VERSION
  homeId: string
  nextDisplayId: number
  instances: ManifestEntry[]
}

export function manifestPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  if (env[MANIFEST_PATH_ENV_VAR]) return env[MANIFEST_PATH_ENV_VAR]
  return join(fmxDirectory(env, homeDirectory), "instances.json")
}

export function mintIdentity(token: string = randomBytes(16).toString("hex")): InstanceIdentity {
  return identityFor(token)
}

export function identityFor(instanceId: string): InstanceIdentity {
  return { instanceId, paneId: `p_${instanceId}`, zmxName: `fmx-${instanceId}` }
}

const INSTANCE_ID = /^[0-9a-f]{32}$/

export function isInstanceId(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_ID.test(value)
}

export function emptyManifest(homeId: string): Manifest {
  return { version: MANIFEST_VERSION, homeId, nextDisplayId: 1, instances: [] }
}

/**
 * Read a manifest, keeping only what validates. A missing or unreadable file
 * is an empty manifest; a file for another Home is too — its entries name
 * sessions this Home does not own, and the reconciliation would ignore them
 * anyway. Individual bad entries are dropped, not the whole file.
 */
export function parseManifest(content: string, homeId: string): Manifest {
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    return emptyManifest(homeId)
  }
  if (!isRecord(document)) return emptyManifest(homeId)
  if (document.version !== MANIFEST_VERSION || document.homeId !== homeId) return emptyManifest(homeId)

  const instances: ManifestEntry[] = []
  const seenIds = new Set<string>()
  const seenDisplayIds = new Set<number>()
  let highestDisplayId = 0
  if (Array.isArray(document.instances)) {
    for (const raw of document.instances) {
      const entry = readEntry(raw)
      if (!entry) continue
      if (seenIds.has(entry.instanceId) || seenDisplayIds.has(entry.displayId)) continue
      seenIds.add(entry.instanceId)
      seenDisplayIds.add(entry.displayId)
      highestDisplayId = Math.max(highestDisplayId, entry.displayId)
      instances.push(entry)
    }
  }
  const declared = document.nextDisplayId
  const nextDisplayId = Math.max(
    highestDisplayId + 1,
    typeof declared === "number" && Number.isInteger(declared) && declared > 0 ? declared : 1,
  )
  return { version: MANIFEST_VERSION, homeId, nextDisplayId, instances }
}

function readEntry(raw: unknown): ManifestEntry | null {
  if (!isRecord(raw)) return null
  const { instanceId, displayId, cwd, fxPath, fxArgs, createdAt, fxSessionId, phase } = raw
  if (!isInstanceId(instanceId)) return null
  const identity = identityFor(instanceId)
  if (raw.paneId !== identity.paneId || raw.zmxName !== identity.zmxName) return null
  if (typeof displayId !== "number" || !Number.isInteger(displayId) || displayId <= 0) return null
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null
  if (typeof fxPath !== "string" || fxPath.length === 0) return null
  if (fxArgs !== null && (!Array.isArray(fxArgs) || !fxArgs.every((arg) => typeof arg === "string"))) return null
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null
  if (fxSessionId !== null && fxSessionId !== undefined && typeof fxSessionId !== "string") return null
  if (phase !== "creating" && phase !== "running") return null
  return {
    ...identity,
    displayId,
    cwd,
    fxPath,
    fxArgs: fxArgs === null ? null : [...(fxArgs as string[])],
    createdAt,
    fxSessionId: typeof fxSessionId === "string" && fxSessionId.length > 0 ? fxSessionId : null,
    phase,
  }
}

export async function loadManifest(path: string, homeId: string): Promise<Manifest> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch {
    return emptyManifest(homeId)
  }
  return parseManifest(content, homeId)
}

/** Temp file beside the target, then rename: a reader sees the old file or the new one, never a torn one. */
export async function saveManifest(manifest: Manifest, path: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  await rename(temporaryPath, path)
}

export type CreateParams = {
  cwd: string
  fxPath: string
  /** `null` when unknown: an adopted Instance's argv comes from a display string the Companion truncates. */
  fxArgs: string[] | null
  createdAt: number
  identity?: InstanceIdentity
}

/**
 * The Manifest as a live object: every mutation lands in memory at once and
 * is written through before its promise resolves, with the writes
 * serialized so two in flight cannot land out of order. Callers hold the
 * entries they were handed as snapshots.
 */
export class InstanceManifest {
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    /** `null` for a Manifest that is never written: a test's, or a demo's. */
    readonly path: string | null,
    private manifest: Manifest,
  ) {}

  static async open(path: string, homeId: string): Promise<InstanceManifest> {
    return new InstanceManifest(path, await loadManifest(path, homeId))
  }

  /** A Manifest held in memory alone. Nothing survives the process, which is the point. */
  static ephemeral(homeId: string): InstanceManifest {
    return new InstanceManifest(null, emptyManifest(homeId))
  }

  get homeId(): string {
    return this.manifest.homeId
  }

  get entries(): readonly ManifestEntry[] {
    return this.manifest.instances.map(copy)
  }

  get(instanceId: string): ManifestEntry | null {
    const entry = this.manifest.instances.find((candidate) => candidate.instanceId === instanceId)
    return entry ? copy(entry) : null
  }

  /** Step 1 of creation: the claim is on disk before the Companion is asked. */
  beginCreate(params: CreateParams): Promise<ManifestEntry> {
    return this.mutate((manifest) => this.claimIn(manifest, params))
  }

  /**
   * Step 1 as two halves: the entry now, for an Instance that should be on
   * screen the moment it is asked for, and the write to wait for before
   * the Companion is asked — the claim must be on disk first.
   */
  claim(params: CreateParams): { result: ManifestEntry; saved: Promise<void> } {
    return this.apply((manifest) => this.claimIn(manifest, params))
  }

  private claimIn(manifest: Manifest, params: CreateParams): ManifestEntry {
    const identity = params.identity ?? mintIdentity()
    if (manifest.instances.some((entry) => entry.instanceId === identity.instanceId)) {
      throw new Error(`instance already in manifest: ${identity.instanceId}`)
    }
    const entry: ManifestEntry = {
      ...identity,
      displayId: manifest.nextDisplayId++,
      cwd: params.cwd,
      fxPath: params.fxPath,
      fxArgs: params.fxArgs && [...params.fxArgs],
      createdAt: params.createdAt,
      fxSessionId: null,
      phase: "creating",
    }
    manifest.instances.push(entry)
    return copy(entry)
  }

  /** Step 3: the Companion acknowledged the start. */
  markRunning(instanceId: string): Promise<ManifestEntry> {
    return this.mutate((manifest) => {
      const entry = find(manifest, instanceId)
      entry.phase = "running"
      return copy(entry)
    })
  }

  /** A session seen in the Companion that the Manifest did not know. */
  adopt(params: CreateParams & { identity: InstanceIdentity; fxSessionId?: string | null }): Promise<ManifestEntry> {
    return this.mutate((manifest) => {
      const existing = manifest.instances.find((entry) => entry.instanceId === params.identity.instanceId)
      if (existing) return copy(existing)
      const entry: ManifestEntry = {
        ...params.identity,
        displayId: manifest.nextDisplayId++,
        cwd: params.cwd,
        fxPath: params.fxPath,
        fxArgs: params.fxArgs && [...params.fxArgs],
        createdAt: params.createdAt,
        fxSessionId: params.fxSessionId ?? null,
        phase: "running",
      }
      manifest.instances.push(entry)
      return copy(entry)
    })
  }

  setFxSessionId(instanceId: string, fxSessionId: string | null): Promise<void> {
    // Checked before the write is queued: every frame fx sends is a chance
    // to record the id, and all but the first would otherwise be a rewrite.
    const current = this.manifest.instances.find((candidate) => candidate.instanceId === instanceId)
    if (!current || current.fxSessionId === fxSessionId) return Promise.resolve()
    return this.mutate((manifest) => {
      const entry = manifest.instances.find((candidate) => candidate.instanceId === instanceId)
      if (!entry || entry.fxSessionId === fxSessionId) return
      entry.fxSessionId = fxSessionId
    })
  }

  /** Steps 4 and 5: a definite failure, an exit, or an absence. Removing what is not there is fine. */
  remove(instanceId: string): Promise<void> {
    return this.mutate((manifest) => {
      manifest.instances = manifest.instances.filter((entry) => entry.instanceId !== instanceId)
    })
  }

  private mutate<T>(change: (manifest: Manifest) => T): Promise<T> {
    try {
      const { result, saved } = this.apply(change)
      return saved.then(() => result)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** The change now, in memory; the write of that snapshot behind every write before it. */
  private apply<T>(change: (manifest: Manifest) => T): { result: T; saved: Promise<void> } {
    const next: Manifest = {
      ...this.manifest,
      instances: this.manifest.instances.map(copy),
    }
    // A change that throws changes nothing: `next` is dropped unsaved.
    const result = change(next)
    this.manifest = next
    const saved = this.queue.then(async () => {
      if (this.path !== null) await saveManifest(next, this.path)
    })
    // A failed write must not wedge every later one behind a rejected promise.
    this.queue = saved.catch(() => {})
    return { result, saved }
  }
}

function copy(entry: ManifestEntry): ManifestEntry {
  return { ...entry, fxArgs: entry.fxArgs && [...entry.fxArgs] }
}

function find(manifest: Manifest, instanceId: string): ManifestEntry {
  const entry = manifest.instances.find((candidate) => candidate.instanceId === instanceId)
  if (!entry) throw new Error(`instance not in manifest: ${instanceId}`)
  return entry
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
