import { identityFor, isInstanceId, type InstanceManifest, type ManifestEntry } from "./instance-manifest.ts"
import type { CompanionCommand, SessionEntry } from "./zmx-command.ts"

/**
 * The join between the Manifest's claims and the Companion's sessions. Pure:
 * it is handed both sides and answers what each Instance is, so every
 * crash-window combination can be tested as a table.
 */

export const OWNER_LABEL = "fmx"

/** The labels every session this Home creates carries. */
export function ownershipLabels(homeId: string, instanceId: string): Record<string, string> {
  const identity = identityFor(instanceId)
  return { owner: OWNER_LABEL, home: homeId, instance: instanceId, pane: identity.paneId }
}

/** A session is this Home's only when every label and the name itself agree. */
export function ownedInstanceId(session: SessionEntry, homeId: string): string | null {
  const { owner, home, instance, pane } = session.labels
  if (owner !== OWNER_LABEL || home !== homeId || !isInstanceId(instance)) return null
  const identity = identityFor(instance)
  if (session.name !== identity.zmxName || pane !== identity.paneId) return null
  return instance
}

export type Reconciliation = {
  /** Manifest entry and a live owned session: the Instance survived. */
  attach: { entry: ManifestEntry; session: SessionEntry }[]
  /** Live owned session nobody wrote down: a crash between the Companion's start and `markRunning`, or a lost Manifest. */
  adopt: { instanceId: string; session: SessionEntry }[]
  /** Manifest entry whose session ended or never existed; `session` carries the exit record when there is one. */
  remove: { entry: ManifestEntry; session: SessionEntry | null }[]
  /** Owned sessions (with or without an entry) that cannot be read yet: refused or unreachable. Ask again. */
  unresolved: { entry: ManifestEntry | null; session: SessionEntry }[]
  /** Sessions that are not this Home's. Never touched. */
  ignored: SessionEntry[]
}

export function reconcile(entries: readonly ManifestEntry[], sessions: readonly SessionEntry[], homeId: string): Reconciliation {
  const result: Reconciliation = { attach: [], adopt: [], remove: [], unresolved: [], ignored: [] }
  const byName = new Map<string, SessionEntry>()
  for (const session of sessions) byName.set(session.name, session)

  const claimed = new Set<string>()
  for (const entry of entries) {
    claimed.add(entry.zmxName)
    const session = byName.get(entry.zmxName) ?? null
    if (!session || session.state === "absent") {
      result.remove.push({ entry, session: null })
      continue
    }
    if (session.state === "exited") {
      result.remove.push({ entry, session })
      continue
    }
    if (session.state === "refused" || session.state === "unreachable") {
      result.unresolved.push({ entry, session })
      continue
    }
    // Live. A session under our name that does not carry our labels is not
    // ours to attach to — something else took the name — and the entry is
    // stale, but the session is left alone.
    if (ownedInstanceId(session, homeId) === entry.instanceId) result.attach.push({ entry, session })
    else {
      result.remove.push({ entry, session: null })
      result.ignored.push(session)
    }
  }

  for (const session of sessions) {
    if (claimed.has(session.name)) continue
    if (session.state === "refused" || session.state === "unreachable") {
      // Labels cannot be read, so ownership cannot be decided; the name can.
      if (/^fmx-[0-9a-f]{32}$/.test(session.name)) result.unresolved.push({ entry: null, session })
      else result.ignored.push(session)
      continue
    }
    const instanceId = ownedInstanceId(session, homeId)
    if (session.state === "live" && instanceId) result.adopt.push({ instanceId, session })
    else result.ignored.push(session)
  }
  return result
}

export type ReconcileOutcome = {
  attached: ManifestEntry[]
  adopted: ManifestEntry[]
  removed: { entry: ManifestEntry; session: SessionEntry | null }[]
  /** Still unreadable after the settle window; left for the next start. */
  unresolved: SessionEntry[]
  ignored: SessionEntry[]
}

export type ReconcileOptions = {
  /** How long to wait for a refused/unreachable session to settle. */
  settleMs?: number
  now?: () => number
}

/**
 * Run the join against the real Manifest and Companion, then apply it:
 * adopt what is live, remove what ended (consuming the exit record), and
 * give a session mid-teardown its settle window before deciding.
 */
export async function reconcileInstances(
  manifest: InstanceManifest,
  companion: CompanionCommand,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const settleMs = options.settleMs ?? 3000
  const now = options.now ?? Date.now
  const outcome: ReconcileOutcome = { attached: [], adopted: [], removed: [], unresolved: [], ignored: [] }

  let sessions = await companion.list()
  let plan = reconcile(manifest.entries, sessions, manifest.homeId)
  const deadline = now() + settleMs
  while (plan.unresolved.length > 0 && now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    sessions = await companion.list()
    plan = reconcile(manifest.entries, sessions, manifest.homeId)
  }

  for (const { entry } of plan.attach) {
    // A live session is the acknowledgement a crash kept fmx from recording.
    outcome.attached.push(entry.phase === "creating" ? await manifest.markRunning(entry.instanceId) : entry)
  }
  for (const { instanceId, session } of plan.adopt) {
    const [fxPath = "", ...fxArgs] = session.command ?? []
    outcome.adopted.push(
      await manifest.adopt({
        identity: identityFor(instanceId),
        cwd: session.cwd ?? "/",
        fxPath: fxPath || "fx",
        fxArgs,
        createdAt: (session.createdAt ?? Math.floor(now() / 1000)) * 1000,
      }),
    )
  }
  for (const { entry, session } of plan.remove) {
    await manifest.remove(entry.instanceId)
    if (session?.state === "exited") {
      try {
        await companion.forget(session.name)
      } catch {
        // The record is advisory once the entry is gone; a later start forgets it again.
      }
    }
    outcome.removed.push({ entry, session })
  }
  outcome.unresolved = plan.unresolved.map(({ session }) => session)
  outcome.ignored = plan.ignored
  return outcome
}
