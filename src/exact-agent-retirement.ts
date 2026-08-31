import { createHash } from "node:crypto"
import { resolve } from "node:path"
import {
  CompanionConnection,
  CompanionOwnershipMismatchError,
  type CompanionOwnership,
  type OwnedKillObservation,
} from "./companion-client.ts"
import { ownershipLabels } from "./agent-reconcile.ts"
import { identityFor } from "./agent-manifest.ts"
import { encodeCanonicalJson, type JsonValue } from "./contract-codec.ts"
import type { EnsureLifecycleRecord } from "./ensure-lifecycle-ledger.ts"
import {
  deriveLifecycleReceiptDigest,
  type EndReceipt,
  type EndRequest,
  type ExactRetirementRecord,
  type ExactRetirementLedger,
  type RetirementEnsureSnapshot,
  type RetirementReceiptAcknowledgement,
} from "./exact-retirement-ledger.ts"
import type { SessionEntry } from "./zmx-command.ts"
import { ExitReason, type Exit } from "./zmx-protocol.ts"

export type RetirementCompanionConnection = Pick<
  CompanionConnection,
  "killIfOwned" | "close"
>

export type RetirementCompanionAuthority = {
  /** Unfiltered inventory: filters must not hide exit or foreign-name authority. */
  list: () => Promise<SessionEntry[]>
  connect: (socketPath: string) => Promise<RetirementCompanionConnection>
}

export type NeverStartedProof = Extract<EndReceipt["proof"], { kind: "never_started" }>

export type NeverStartedProofSource = {
  /** An injected frozen authority. Absence remains pending; it is never inferred. */
  prove: (
    request: Readonly<EndRequest>,
    ensure: Readonly<RetirementEnsureSnapshot>,
  ) => Promise<NeverStartedProof | null>
}

export type ExactAgentRetirementOptions = {
  now?: () => Date
  labelTimeoutMs?: number
  outcomeTimeoutMs?: number
  refusedReinspectionAttempts?: number
  refusedReinspectionDelayMs?: number
}

export type ExactAgentRetirementErrorCode =
  | "ambiguous_session"
  | "invalid_exit"
  | "ownership_mismatch"
  | "session_mismatch"

export class ExactAgentRetirementError extends Error {
  constructor(
    readonly code: ExactAgentRetirementErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ExactAgentRetirementError"
  }
}

/**
 * Recoverable exact retirement without Runtime/Manifest wiring. The caller
 * supplies the already-authoritative ensure record and the private Companion
 * authority; this package never exposes a general stop surface.
 */
export class ExactAgentRetirement {
  private readonly now: () => Date
  private readonly labelTimeoutMs: number
  private readonly outcomeTimeoutMs: number
  private readonly refusedReinspectionAttempts: number
  private readonly refusedReinspectionDelayMs: number

  constructor(
    private readonly ledger: ExactRetirementLedger,
    private readonly homeId: string,
    private readonly companionDirectory: string,
    private readonly companion: RetirementCompanionAuthority,
    options: ExactAgentRetirementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.labelTimeoutMs = options.labelTimeoutMs ?? 1_000
    this.outcomeTimeoutMs = options.outcomeTimeoutMs ?? 5_000
    // The pinned daemon's forced teardown window is two seconds. Observe a
    // refused/draining name across that whole bounded window before yielding
    // pending recovery to the next call.
    this.refusedReinspectionAttempts = options.refusedReinspectionAttempts ?? 61
    this.refusedReinspectionDelayMs = options.refusedReinspectionDelayMs ?? 50
  }

  async end(
    ensure: EnsureLifecycleRecord,
    request: EndRequest,
    neverStartedSource?: NeverStartedProofSource,
  ): Promise<EndReceipt | null> {
    let record = await this.ledger.bindEnsure(ensure)
    record = await this.ledger.beginEnd(request)
    if (record.end!.receipt) return record.end!.receipt

    if (request.reason === "cancelled_before_start") {
      if (!neverStartedSource) return null
      const proof = await neverStartedSource.prove(request, record.ensure)
      if (!proof) return null
      return (await this.ledger.retainEndReceipt(buildEndReceipt(request, proof))).end!.receipt
    }

    await this.ledger.markKillIntent(request.ensure_id, canonicalNow(this.now))
    const initial = await this.reinspectExact(request, false)
    if (initial.kind === "exit") return await this.retainExit(request, initial.exit)
    if (initial.kind !== "live") return null

    let connection: RetirementCompanionConnection
    try {
      connection = await this.companion.connect(initial.socketPath)
    } catch {
      const recovered = await this.reinspectExact(request, true)
      return recovered.kind === "exit" ? await this.retainExit(request, recovered.exit) : null
    }
    let observation: OwnedKillObservation
    let durableWriteFailure: unknown = null
    try {
      observation = await connection.killIfOwned(expectedOwnership(this.homeId, request.agent_id), {
        labelTimeoutMs: this.labelTimeoutMs,
        outcomeTimeoutMs: this.outcomeTimeoutMs,
        afterFlush: async () => {
          try {
            await this.ledger.markKillWriteFlushed(request.ensure_id, canonicalNow(this.now))
          } catch (error) {
            durableWriteFailure = error
            throw error
          }
        },
      })
    } catch (error) {
      if (error instanceof CompanionOwnershipMismatchError) {
        throw retirementError(
          "ownership_mismatch",
          `session ${initial.sessionName} changed ownership before Kill`,
        )
      }
      if (durableWriteFailure !== null) throw durableWriteFailure
      // The Kill frame may or may not have reached the daemon. Durable intent
      // plus exact inventory is the only recovery boundary.
      const recovered = await this.reinspectExact(request, true)
      if (recovered.kind === "exit") return await this.retainExit(request, recovered.exit)
      return null
    } finally {
      connection.close()
    }

    if (observation.kind === "exit") {
      return await this.retainExit(request, exitFromWire(observation.status, canonicalNow(this.now)))
    }
    const recovered = await this.reinspectExact(request, true)
    return recovered.kind === "exit" ? await this.retainExit(request, recovered.exit) : null
  }

  acknowledge(acknowledgement: RetirementReceiptAcknowledgement): Promise<ExactRetirementRecord> {
    return this.ledger.acknowledge(acknowledgement)
  }

  private async retainExit(request: EndRequest, exit: ExactExit): Promise<EndReceipt> {
    const proof: Extract<EndReceipt["proof"], { kind: "ended" }> = {
      kind: "ended",
      companion_session: identityFor(request.agent_id).zmxName,
      pane_id: identityFor(request.agent_id).paneId,
      exit_code: exit.code,
      signal: exit.signal,
      reason: exit.reason,
      observed_at: exit.observedAt,
    }
    const record = await this.ledger.retainEndReceipt(buildEndReceipt(request, proof))
    return record.end!.receipt!
  }

  private async reinspectExact(
    request: EndRequest,
    afterKill: boolean,
  ): Promise<ExactSessionObservation> {
    const attempts = afterKill ? this.refusedReinspectionAttempts : 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      const observation = inspectInventory(
        await this.companion.list(),
        this.homeId,
        this.companionDirectory,
        request.agent_id,
      )
      if (observation.kind !== "refused") return observation
      if (attempt + 1 < attempts) {
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, this.refusedReinspectionDelayMs))
      }
    }
    return { kind: "pending" }
  }
}

type ExactExit = {
  code: number
  signal: number
  reason: "natural" | "requested" | "daemon_failure" | "exec_failure"
  observedAt: string
}

type ExactSessionObservation =
  | { kind: "live"; socketPath: string; sessionName: string }
  | { kind: "exit"; exit: ExactExit }
  | { kind: "refused" }
  | { kind: "pending" }

function inspectInventory(
  sessions: SessionEntry[],
  homeId: string,
  companionDirectory: string,
  agentId: string,
): ExactSessionObservation {
  const identity = identityFor(agentId)
  const named = sessions.filter(({ name }) => name === identity.zmxName)
  if (named.length > 1) {
    throw retirementError("ambiguous_session", `Companion repeats session ${identity.zmxName}`)
  }
  const session = named[0]
  if (!session || session.state === "absent") return { kind: "pending" }
  const expected = expectedOwnership(homeId, agentId)
  if (!labelsMatch(session.labels, expected)) {
    throw retirementError(
      "ownership_mismatch",
      `session ${identity.zmxName} is not owned by the exact Home and Agent`,
    )
  }
  if (session.state === "exited") {
    if (!session.exit) return { kind: "pending" }
    return { kind: "exit", exit: exitFromRecord(session.exit) }
  }
  if (session.state === "live") {
    const expectedSocket = resolve(companionDirectory, identity.zmxName)
    if (session.socketPath !== expectedSocket) {
      throw retirementError(
        "session_mismatch",
        `session ${identity.zmxName} changed its canonical Companion socket`,
      )
    }
    return { kind: "live", socketPath: expectedSocket, sessionName: identity.zmxName }
  }
  if (session.state === "refused") return { kind: "refused" }
  return { kind: "pending" }
}

function expectedOwnership(homeId: string, agentId: string): CompanionOwnership {
  const labels = ownershipLabels(homeId, agentId)
  return {
    owner: labels.owner,
    home: labels.home,
    agent: labels.agent,
    pane: labels.pane,
  }
}

function labelsMatch(
  actual: Readonly<Record<string, string>>,
  expected: CompanionOwnership,
): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value)
}

function exitFromRecord(exit: SessionEntry["exit"] & {}): ExactExit {
  // Companion JSON timestamps are whole Unix seconds (the existing startup
  // reconciliation applies the same seconds-to-milliseconds conversion).
  const observedAt = new Date(exit.endedAt * 1_000)
  if (!Number.isSafeInteger(exit.endedAt) || exit.endedAt <= 0 || Number.isNaN(observedAt.valueOf())) {
    throw retirementError("invalid_exit", "Companion exit record has no valid observation time")
  }
  return checkedExit(exit.code, exit.signal, exit.reason, observedAt.toISOString())
}

function exitFromWire(exit: Exit, observedAt: string): ExactExit {
  const reason = exit.reason === ExitReason.natural
    ? "natural"
    : exit.reason === ExitReason.requested
      ? "requested"
      : exit.reason === ExitReason.daemonFailure
        ? "daemon_failure"
        : exit.reason === ExitReason.execFailure
          ? "exec_failure"
          : null
  if (!reason) throw retirementError("invalid_exit", `unknown Companion Exit reason ${exit.reason}`)
  return checkedExit(exit.code, exit.signal, reason, observedAt)
}

function checkedExit(
  code: number,
  signal: number,
  reason: string,
  observedAt: string,
): ExactExit {
  if (!Number.isInteger(code) || code < 0 || code > 255 ||
    !Number.isInteger(signal) || signal < 0 || signal > 255 ||
    (code !== 0 && signal !== 0) ||
    !["natural", "requested", "daemon_failure", "exec_failure"].includes(reason)
  ) {
    throw retirementError("invalid_exit", "Companion supplied an invalid exact Exit record")
  }
  return {
    code,
    signal,
    reason: reason as ExactExit["reason"],
    observedAt,
  }
}

function buildEndReceipt(request: EndRequest, proof: EndReceipt["proof"]): EndReceipt {
  const partial = {
    schema_id: request.schema_id,
    schema_version: request.schema_version,
    message_type: "end_receipt" as const,
    request_id: request.request_id,
    receipt_id: deterministicId("end-receipt", request),
    receipt_digest: "0".repeat(64),
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    ensure_digest: request.ensure_digest,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    worktree_id: request.worktree_id,
    agent_id: request.agent_id,
    conversation_id: request.conversation_id,
    end_id: request.end_id,
    end_digest: request.end_digest,
    proof: structuredClone(proof),
  } satisfies EndReceipt
  partial.receipt_digest = deriveLifecycleReceiptDigest(partial)
  return partial
}

function deterministicId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256")
    .update(encodeCanonicalJson(value as JsonValue))
    .digest("hex")
    .slice(0, 32)}`
}

function canonicalNow(now: () => Date): string {
  const value = now()
  if (Number.isNaN(value.valueOf())) throw new Error("retirement clock returned an invalid date")
  return value.toISOString()
}

function retirementError(
  code: ExactAgentRetirementErrorCode,
  message: string,
): ExactAgentRetirementError {
  return new ExactAgentRetirementError(code, message)
}
