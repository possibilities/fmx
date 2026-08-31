import { lstat, unlink } from "node:fs/promises"
import { identityFor, isAgentId, type AgentManifest, type ManifestEntry } from "./agent-manifest.ts"
import { removeFxWorkControlResidue } from "./fx-work-control.ts"
import type { CompanionCommand, SessionEntry } from "./zmx-command.ts"

/**
 * The join between the Manifest's claims and the Companion's sessions. Pure:
 * it is handed both sides and answers what each Agent is, so every
 * crash-window combination can be tested as a table.
 */

export const OWNER_LABEL = "fmx"

/** The labels every session this Home creates carries. */
export function ownershipLabels(homeId: string, agentId: string): Record<string, string> {
  const identity = identityFor(agentId)
  return { owner: OWNER_LABEL, home: homeId, agent: agentId, pane: identity.paneId }
}

/** A session is this Home's only when every label and the name itself agree. */
export function ownedAgentId(session: SessionEntry, homeId: string): string | null {
  const { owner, home, agent, pane } = session.labels
  if (owner !== OWNER_LABEL || home !== homeId || !isAgentId(agent)) return null
  const identity = identityFor(agent)
  if (session.name !== identity.zmxName || pane !== identity.paneId) return null
  return agent
}

export type Reconciliation = {
  /** Manifest entry and a live owned session: the Agent survived. */
  attach: { entry: ManifestEntry; session: SessionEntry }[]
  /** Live owned session nobody wrote down: a crash between the Companion's start and `markRunning`, or a lost Manifest. */
  adopt: { agentId: string; session: SessionEntry }[]
  /** Manifest entry whose session ended or never existed; `session` carries the exit record when there is one. */
  remove: { entry: ManifestEntry; session: SessionEntry | null }[]
  /** Exit records of this Home's sessions that no entry claims: a crash between `remove` and `forget`, or a lost Manifest. Consume them. */
  forget: SessionEntry[]
  /** Sessions under our naming (with or without an entry) that cannot be read yet: refused or unreachable. Ask again. */
  unresolved: { entry: ManifestEntry | null; session: SessionEntry }[]
  /** Sessions that are not this Home's. Never touched. */
  ignored: SessionEntry[]
}

export function reconcile(entries: readonly ManifestEntry[], sessions: readonly SessionEntry[], homeId: string): Reconciliation {
  const result: Reconciliation = { attach: [], adopt: [], remove: [], forget: [], unresolved: [], ignored: [] }
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
    if (ownedAgentId(session, homeId) === entry.agentId) result.attach.push({ entry, session })
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
    const agentId = ownedAgentId(session, homeId)
    if (session.state === "live" && agentId) result.adopt.push({ agentId, session })
    else if (session.state === "exited" && agentId) result.forget.push(session)
    else result.ignored.push(session)
  }
  return result
}

export type ReconcileOutcome = {
  attached: ReconciledAgent[]
  adopted: ReconciledAgent[]
  removed: { entry: ManifestEntry; session: SessionEntry | null }[]
  /** Stale sockets cleared after the settle window: nothing held them, so nothing can come back. */
  cleared: SessionEntry[]
  /** Still unreachable after the settle window; left for the next start. */
  unresolved: SessionEntry[]
  ignored: SessionEntry[]
}

/** A durable Manifest identity paired with the live transport endpoint that
 * the same reconciliation read proved belonged to it. */
export type ReconciledAgent = {
  entry: ManifestEntry
  session: SessionEntry
}

export type ReconcileOptions = {
  /** How long to wait for a refused/unreachable session to settle. */
  settleMs?: number
  now?: () => number
  /** Exact Runtime path used to validate dead Agents' work-control residue. */
  runtimeSocketPath?: string
  /**
   * Persist any external correlation/finalization which must precede removal
   * of this exact Manifest identity. A rejection is fail-closed: neither the
   * claim nor its Work-control endpoint is removed, so the next startup can
   * retry the same durable operation.
   */
  beforeRemove?: (removal: AgentRemoval) => void | Promise<void>
}

export type AgentRemovalReason = "absent" | "exited" | "foreign" | "refused"

export type AgentRemoval = {
  entry: ManifestEntry
  reason: AgentRemovalReason
  session: SessionEntry | null
}

/**
 * Run the join against the real Manifest and Companion, then apply it:
 * adopt what is live, remove what ended (consuming the exit record), and
 * give a session mid-teardown its settle window before deciding.
 */
export async function reconcileAgents(
  manifest: AgentManifest,
  companion: CompanionCommand,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const settleMs = options.settleMs ?? 3000
  const now = options.now ?? Date.now
  const removeEntry = async (
    removal: AgentRemoval,
    actions: { removeResidue?: boolean; forgetExit?: boolean; clearRefused?: boolean } = {},
  ) => {
    await options.beforeRemove?.({
      entry: structuredClone(removal.entry),
      reason: removal.reason,
      session: removal.session === null ? null : structuredClone(removal.session),
    })
    const revalidate = () => assertRemovalStillValid(companion, manifest.homeId, removal)
    if (actions.removeResidue !== false) {
      await revalidate()
      await removeFxWorkControlResidue(
        removal.entry.workControl,
        options.runtimeSocketPath ?? null,
        { beforeUnlink: revalidate },
      )
    }
    if (actions.forgetExit) {
      await revalidate()
      await companion.forget(removal.entry.zmxName)
    }
    if (actions.clearRefused && removal.session?.socketPath) {
      await unlinkStablePath(removal.session.socketPath, revalidate)
    }
    if (actions.forgetExit || actions.clearRefused) {
      await assertRemovalConsumedOrStillValid(companion, manifest.homeId, removal)
    } else {
      await revalidate()
    }
    await manifest.remove(removal.entry.agentId)
  }
  const outcome: ReconcileOutcome = { attached: [], adopted: [], removed: [], cleared: [], unresolved: [], ignored: [] }

  let sessions = await companion.list()
  let plan = reconcile(manifest.entries, sessions, manifest.homeId)
  const deadline = now() + settleMs
  while (plan.unresolved.length > 0 && now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    sessions = await companion.list()
    plan = reconcile(manifest.entries, sessions, manifest.homeId)
  }

  for (const { entry, session } of plan.attach) {
    // A live session is the acknowledgement a crash kept fmx from recording.
    outcome.attached.push({
      entry: entry.phase === "creating" ? await manifest.markRunning(entry.agentId) : entry,
      session,
    })
  }
  for (const { agentId, session } of plan.adopt) {
    // The Companion's `cmd` is a display string, truncated past 256 bytes;
    // the executable is its first word, the arguments are not to be trusted.
    const [fxPath = ""] = session.command ?? []
    outcome.adopted.push({
      entry: await manifest.adopt({
        identity: identityFor(agentId),
        cwd: session.cwd ?? "/",
        fxPath: fxPath || "fx",
        fxArgs: null,
        createdAt: (session.createdAt ?? Math.floor(now() / 1000)) * 1000,
      }),
      session,
    })
  }
  const ignoredByName = new Map(plan.ignored.map((session) => [session.name, session]))
  for (const { entry, session } of plan.remove) {
    // A live foreign session under our old name is left wholly alone: it may
    // have taken the filesystem endpoint too. Absence, exit, and a dead
    // refused socket prove no process remains to own the old endpoint.
    const foreign = ignoredByName.get(entry.zmxName) ?? null
    const removal = {
      entry,
      reason: foreign !== null ? "foreign" : session?.state === "exited" ? "exited" : "absent",
      session: foreign ?? session,
    } satisfies AgentRemoval
    await removeEntry(removal, {
      removeResidue: foreign === null,
      forgetExit: session?.state === "exited",
    })
    outcome.removed.push({ entry, session })
  }
  for (const session of plan.forget) {
    try {
      await companion.forget(session.name)
    } catch {
      // Advisory; the next start sees it again.
    }
  }
  for (const { entry, session } of plan.unresolved) {
    // `refused` after the settle window is a socket nothing holds: the
    // daemon was killed without cleaning up. It cannot come back, and
    // without a daemon no exit record will ever appear. The Companion's
    // interactive `list` sweeps the same thing; here it is done by name.
    // `unreachable` (a connect that hung) stays for the next start.
    if (session.state !== "refused") {
      outcome.unresolved.push(session)
      continue
    }
    if (entry) {
      await removeEntry(
        { entry, reason: "refused", session },
        { clearRefused: session.socketPath !== null },
      )
      outcome.removed.push({ entry, session })
    } else if (session.socketPath) await unlink(session.socketPath).catch(() => {})
    outcome.cleared.push(session)
  }
  outcome.ignored = plan.ignored
  return outcome
}

async function assertRemovalConsumedOrStillValid(
  companion: CompanionCommand,
  homeId: string,
  removal: AgentRemoval,
): Promise<void> {
  const named = (await companion.list()).filter(({ name }) => name === removal.entry.zmxName)
  if (named.length > 1) {
    throw new Error(`Companion repeats session ${removal.entry.zmxName} after finalization`)
  }
  const current = named[0] ?? null
  if (current === null || current.state === "absent") return
  if (removal.reason === "exited" && current.state === "exited") return
  if (
    removal.reason === "refused" && current.state === "refused" &&
    current.socketPath === removal.session?.socketPath
  ) return
  if (current.state === "live" && ownedAgentId(current, homeId) !== removal.entry.agentId) {
    throw new Error(
      `foreign Companion session ${removal.entry.zmxName} appeared after managed finalization`,
    )
  }
  throw new Error(
    `Companion session ${removal.entry.zmxName} changed after its managed identity was finalized`,
  )
}

async function assertRemovalStillValid(
  companion: CompanionCommand,
  homeId: string,
  removal: AgentRemoval,
): Promise<void> {
  const named = (await companion.list()).filter(({ name }) => name === removal.entry.zmxName)
  if (named.length > 1) {
    throw new Error(`Companion repeats session ${removal.entry.zmxName} during finalization`)
  }
  const current = named[0] ?? null
  switch (removal.reason) {
    case "absent":
      if (current === null || current.state === "absent") return
      break
    case "exited":
      if (current?.state === "exited") return
      break
    case "foreign":
      if (current?.state === "live" && ownedAgentId(current, homeId) !== removal.entry.agentId) return
      break
    case "refused":
      if (
        current?.state === "refused" &&
        current.socketPath === removal.session?.socketPath
      ) return
      break
  }
  throw new Error(
    `Companion session ${removal.entry.zmxName} changed while its managed identity was finalized`,
  )
}

async function unlinkStablePath(
  path: string,
  revalidate: () => Promise<void>,
): Promise<void> {
  const before = await lstat(path)
  await revalidate()
  const current = await lstat(path)
  if (
    current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode ||
    current.uid !== before.uid
  ) {
    throw new Error(`Companion endpoint changed before removal: ${path}`)
  }
  await unlink(path)
}
