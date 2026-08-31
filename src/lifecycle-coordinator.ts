import {
  type EnsureLifecycleRecord,
  type EnsureLifecycleStage,
  type EnsureReceipt,
  type EnsureRequest,
  type FxAdmissionDecision,
  type FxFinalReceipt,
  type FxFinalReceiptAcknowledgement,
  type FxFinalReceiptAuthority,
  type FxFinalReceiptAuthorityBinding,
  EnsureLifecycleLedger,
} from "./ensure-lifecycle-ledger.ts"
import {
  InlineLaunchSourceLedger,
  type InlineLaunchSourceRequest,
} from "./inline-launch-source.ts"
import type { FxWorkControlBinding, FxWorkControlResult } from "./fx-work-control.ts"
import type { RuntimeExtensionLifecycleInbound } from "./runtime-extension.ts"

type FxAdmissionDecisionFor<Kind extends FxAdmissionDecision["decision"]["kind"]> =
  Omit<FxAdmissionDecision, "decision"> & {
    decision: Extract<FxAdmissionDecision["decision"], { kind: Kind }>
  }

export type AdmittedFxAdmissionDecision = FxAdmissionDecisionFor<"admitted">
export type CancelledFxAdmissionDecision = FxAdmissionDecisionFor<"cancelled_before_start">

/**
 * A held authorization to start one Companion session.  The cancellation
 * authority keeps the corresponding retirement path behind this lease until
 * `release` is called.
 */
export type LifecycleStartLease = {
  release(): void
}

export type LifecycleAdmissionOutcome =
  | { kind: "pending" }
  | { kind: "final"; receipt: FxFinalReceipt }
  | {
      kind: "admitted"
      decision: AdmittedFxAdmissionDecision
      conversationId: string
    }
  | {
      kind: "cancelled_before_start"
      decision: CancelledFxAdmissionDecision
    }

/**
 * The deliberately small, private orchestration seam between the durable
 * AgentWorkplace intent ledgers and fmx's exact-effect implementations.
 *
 * No port reads Fx's private launch ledger. Fx remains the authority for the
 * admission result and active Conversation; fmx persists only its own staged
 * effects and forwards the exact initial UTF-8 text through Work-control.
 */
export type LifecycleCoordinatorPorts = {
  worktree: {
    create(input: Readonly<{ request: EnsureRequest; source: InlineLaunchSourceRequest }>): Promise<{
      directory: string
      headCommit: string
    }>
  }
  manifest: {
    /** Resolve only after the exact creating claim, including Work-control authority, is durable. */
    claim(input: Readonly<{ request: EnsureRequest; source: InlineLaunchSourceRequest }>): Promise<void>
    /** Read the bearer binding that was minted and made durable by `claim`. */
    workControl(agentId: string): Promise<FxWorkControlBinding>
    /** Startup reconciliation must retain these entries and their Work-control binding. */
    protect?(agentIds: readonly string[]): Promise<void>
  }
  launch: {
    /** Prepare the exact Fx invocation without starting its Companion session. */
    prepare(input: Readonly<{
      record: EnsureLifecycleRecord
      source: InlineLaunchSourceRequest
      workControl: FxWorkControlBinding
    }>): Promise<{
      invocation: unknown
      /** Exact reserved or resumed Conversation returned by Fx's provider build. */
      conversationId: string
      finalReceiptAuthority: FxFinalReceiptAuthorityBinding
    }>
  }
  companion: {
    /** Start is idempotent for this exact ensure/identity; its effect is persisted immediately after return. */
    start(input: Readonly<{ record: EnsureLifecycleRecord; invocation: unknown }>): Promise<{
      sessionName: string
      paneId: string
    }>
  }
  workControl: {
    /** Authenticated Work-control is the only initial text delivery path. */
    admitInitial(input: Readonly<{
      binding: FxWorkControlBinding
      text: string
      source: InlineLaunchSourceRequest
    }>): Promise<{
      /** Fx's authoritative admission disposition; never inferred by fmx. */
      admission: FxWorkControlResult
      /** Fx's current active Conversation after admission. */
      conversationId: string
    } | null>
  }
  admission: {
    /**
     * Import Fx's exact admission decision and active Conversation into the
     * pending launch provider. This is idempotent by launch correlation;
     * fmx neither derives a decision nor reads Fx's private ledger.
     */
    import(input: Readonly<{
      record: EnsureLifecycleRecord
      delivered: Readonly<{ admission: FxWorkControlResult; conversationId: string }> | null
      expectedConversationId: string
    }>): Promise<LifecycleAdmissionOutcome>
  }
  cancellation: {
    /**
     * Atomically choose never-started cancellation or permission to spawn.
     * Once `start` is returned, an end request must use ordinary retirement;
     * it cannot be reclassified as cancelled-before-start.
     */
    beginStart(ensureId: string): Promise<
      | { kind: "start"; lease: LifecycleStartLease }
      | { kind: "cancelled_before_start"; decision: CancelledFxAdmissionDecision }
    >
  }
  retirement?: {
    /** Called only after a correlated final Fx receipt is retained durably. */
    afterFinalReceipt(ensureId: string, receipt: FxFinalReceipt): Promise<void>
    /** Idempotently retire a partial launch after Fx's retained negative winner. */
    afterAdmissionCancellation?(
      ensureId: string,
      decision: CancelledFxAdmissionDecision,
    ): Promise<void>
    /** End/cleanup retain their own durable intents in the retirement slice. */
    accept?(message: Exclude<RuntimeExtensionLifecycleInbound, EnsureRequest>): Promise<void>
  }
  receipts?: {
    /** Build the correlated immutable receipt for this exact persisted state. */
    ensure(record: EnsureLifecycleRecord): Promise<EnsureReceipt | null>
    /** Publish exact bytes at least once until their durable acknowledgement arrives. */
    publish(receipt: EnsureReceipt): Promise<void>
  }
  onError?: (error: unknown, ensureId: string) => void
}

export type LifecycleCoordinatorOptions = {
  ledger: EnsureLifecycleLedger
  sources: InlineLaunchSourceLedger
  ports: LifecycleCoordinatorPorts
  /** Bound external effects; durable admission remains cheap and in-band. */
  maxConcurrentEffects?: number
  /** Total exact Work-control/provider attempts before leaving durable pending state. */
  pendingAdmissionAttempts?: number
  /** Delay between pending attempts; the timer is unrefed and cancelled by close(). */
  pendingAdmissionRetryDelayMs?: number
}

const STAGE_ORDER: readonly EnsureLifecycleStage[] = [
  "claimed",
  "worktree_created",
  "manifest_claimed",
  "companion_started",
  "fx_started",
]

/**
 * A background-only durable lifecycle driver. `accept` does no external
 * effect: it persists/joins immutable intent and schedules a drain, allowing
 * the Runtime-extension's bounded handler to return within its host deadline.
 */
export class LifecycleCoordinator {
  private readonly scheduled = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  private readonly queued: string[] = []
  private readonly admissionGates = new Map<string, Promise<void>>()
  private readonly pendingRetries = new Map<
    string,
    { attempts: number; timer: ReturnType<typeof setTimeout> | null }
  >()
  private closed = false
  private activeEffects = 0
  private readonly maxConcurrentEffects: number
  private readonly pendingAdmissionAttempts: number
  private readonly pendingAdmissionRetryDelayMs: number

  constructor(private readonly options: LifecycleCoordinatorOptions) {
    const maximum = options.maxConcurrentEffects ?? 4
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32) {
      throw new Error("lifecycle coordinator maxConcurrentEffects must be an integer from 1 through 32")
    }
    this.maxConcurrentEffects = maximum
    const attempts = options.pendingAdmissionAttempts ?? 4
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 16) {
      throw new Error("lifecycle coordinator pendingAdmissionAttempts must be an integer from 1 through 16")
    }
    this.pendingAdmissionAttempts = attempts
    const retryDelay = options.pendingAdmissionRetryDelayMs ?? 100
    if (!Number.isInteger(retryDelay) || retryDelay < 0 || retryDelay > 10_000) {
      throw new Error(
        "lifecycle coordinator pendingAdmissionRetryDelayMs must be an integer from 0 through 10000",
      )
    }
    this.pendingAdmissionRetryDelayMs = retryDelay
  }

  /** Persist exact private source bytes before an ensure can consume them. */
  async acceptInlineSource(source: InlineLaunchSourceRequest): Promise<void> {
    const claimed = await this.options.sources.claim(source)
    const ensure = await this.options.ledger.get(claimed.request.ensure_id)
    if (ensure === null) return
    await this.options.sources.bindEnsureRequestForEnsure(ensure.request)
    this.schedule(ensure.request.ensure_id)
  }

  /** Admit an extension lifecycle message without running a long external effect. */
  async accept(message: RuntimeExtensionLifecycleInbound): Promise<void> {
    if (message.message_type === "ensure_request") {
      const record = await this.options.ledger.claim(message)
      const source = await this.options.sources.bindEnsureRequestForEnsureIfPresent(record.request)
      if (source !== null) this.schedule(record.request.ensure_id)
      return
    }
    if (message.message_type === "receipt_acknowledgement" && message.receipt_kind === "ensure") {
      await this.options.ledger.acknowledgeEnsureReceipt(message)
      return
    }
    await this.options.ports.retirement?.accept?.(message)
  }

  /** Resume every incomplete persisted record; safe to call during startup and repeatedly. */
  async recover(): Promise<void> {
    const records = await this.options.ledger.list()
    const protectedIds = records
      .filter((record) => atOrAfter(record.stage, "manifest_claimed"))
      .map((record) => record.request.agent_id)
    if (protectedIds.length > 0) await this.options.ports.manifest.protect?.(protectedIds)
    for (const record of records) {
      if (record.stage !== "fx_started" || record.fx_final.receipt !== null) {
        this.schedule(record.request.ensure_id)
      }
    }
  }

  /** Retain Fx's final receipt before any Manifest-removal/retirement hook can run. */
  async retainFinalReceipt(ensureId: string, receipt: FxFinalReceipt): Promise<void> {
    // Serialize terminal receipt persistence against initial Work-control
    // submission.  Whichever side enters first may finish; once the final
    // receipt is durable, no later admission request can cross this gate.
    await this.withAdmissionGate(ensureId, async () => {
      await this.options.ledger.retainFxFinalReceipt(ensureId, receipt)
    })
    if (this.closed) return
    await this.options.ports.retirement?.afterFinalReceipt(ensureId, receipt)
  }

  /** Durable acknowledgement replay for Fx's final-receipt authority. */
  acknowledgeFinalReceipt(
    ensureId: string,
    acknowledgement: FxFinalReceiptAcknowledgement,
    authority: FxFinalReceiptAuthority,
  ): Promise<EnsureLifecycleRecord> {
    return this.options.ledger.acknowledgeFxFinalReceipt(ensureId, acknowledgement, authority)
  }

  /**
   * Wait for active/queued effects only. Deferred pending timers are excluded
   * by design; hosts call close() before teardown to cancel those redrives.
   */
  async settled(): Promise<void> {
    while (this.scheduled.size > 0) {
      await Promise.all([...this.scheduled.values()].map(({ promise }) => promise))
    }
  }

  /** Stop pending-delay redrives; durable records remain for the next Runtime's recover(). */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const { timer } of this.pendingRetries.values()) {
      if (timer !== null) clearTimeout(timer)
    }
    this.pendingRetries.clear()
    for (const ensureId of this.queued.splice(0)) {
      const completion = this.scheduled.get(ensureId)
      if (completion === undefined) continue
      this.scheduled.delete(ensureId)
      completion.resolve()
    }
  }

  private schedule(ensureId: string, preservePendingBudget = false): void {
    if (this.closed) return
    if (!preservePendingBudget) this.clearPendingRetry(ensureId)
    if (this.scheduled.has(ensureId)) return
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    this.scheduled.set(ensureId, { promise: completion, resolve: resolveCompletion })
    this.queued.push(ensureId)
    this.pump()
  }

  private pump(): void {
    if (this.closed) return
    while (this.activeEffects < this.maxConcurrentEffects && this.queued.length > 0) {
      const ensureId = this.queued.shift()!
      const completion = this.scheduled.get(ensureId)
      if (completion === undefined) continue
      this.activeEffects++
      void this.drive(ensureId)
        .then((pending) => {
          if (pending) this.deferPendingRetry(ensureId)
          else this.clearPendingRetry(ensureId)
        })
        .catch((error) => {
          this.clearPendingRetry(ensureId)
          try {
            this.options.ports.onError?.(error, ensureId)
          } catch {
            // Diagnostics cannot strand the durable queue.
          }
        })
        .finally(() => {
          this.activeEffects--
          this.scheduled.delete(ensureId)
          completion.resolve()
          this.pump()
        })
    }
  }

  private async drive(ensureId: string): Promise<boolean> {
    for (;;) {
      const record = await this.require(ensureId)
      if (this.closed) return false
      if (record.fx_final.receipt !== null) {
        await this.options.ports.retirement?.afterFinalReceipt(
          ensureId,
          record.fx_final.receipt,
        )
        if (this.closed) return false
        await this.publish(ensureId)
        return false
      }
      if (record.fx_admission_decision?.decision.kind === "cancelled_before_start") {
        await this.options.ports.retirement?.afterAdmissionCancellation?.(
          ensureId,
          record.fx_admission_decision as CancelledFxAdmissionDecision,
        )
        if (this.closed) return false
        await this.publish(ensureId)
        return false
      }
      if (record.stage === "fx_started") {
        await this.publish(ensureId)
        return false
      }
      const source = await this.options.sources.sourceForEnsure(record.request)
      if (source === null) throw new Error(`ensure ${ensureId} has no durably bound inline source`)
      if (this.closed) return false

      if (record.stage === "claimed") {
        const effect = await this.options.ports.worktree.create({ request: record.request, source })
        await this.options.ledger.advance(ensureId, {
          kind: "worktree_created",
          directory: effect.directory,
          head_commit: effect.headCommit,
        })
        if (this.closed) return false
        await this.publish(ensureId)
        continue
      }

      if (record.stage === "worktree_created") {
        await this.options.ports.manifest.claim({ request: record.request, source })
        await this.options.ledger.advance(ensureId, {
          kind: "manifest_claimed",
          agent_id: record.request.agent_id,
        })
        if (this.closed) return false
        await this.publish(ensureId)
        continue
      }

      const workControl = await this.workControlFor(record)
      if (this.closed) return false
      const prepared = await this.options.ports.launch.prepare({ record, source, workControl })
      assertPreparedAuthority(prepared.finalReceiptAuthority, source)
      await this.options.ledger.bindFxFinalReceiptAuthority(ensureId, prepared.finalReceiptAuthority)

      if (record.stage === "manifest_claimed") {
        if (this.closed) return false
        const gate = await this.options.ports.cancellation.beginStart(ensureId)
        if (gate.kind === "cancelled_before_start") {
          await this.options.ledger.retainFxAdmissionDecision(ensureId, gate.decision)
          if (this.closed) return false
          await this.options.ports.retirement?.afterAdmissionCancellation?.(
            ensureId,
            gate.decision,
          )
          if (this.closed) return false
          await this.publish(ensureId)
          return false
        }
        try {
          if (this.closed) return false
          const effect = await this.options.ports.companion.start({ record, invocation: prepared.invocation })
          await this.options.ledger.advance(ensureId, {
            kind: "companion_started",
            session_name: effect.sessionName,
            pane_id: effect.paneId,
          })
          if (this.closed) return false
          await this.publish(ensureId)
          continue
        } finally {
          // Cancellation/retirement must not observe a never-started winner
          // while the Companion start is in flight or before its durable
          // companion_started boundary makes that start recoverable.
          gate.lease.release()
        }
      }

      const result = await this.withAdmissionGate(ensureId, async () => {
        const current = await this.require(ensureId)
        if (this.closed) return { kind: "stopped" as const }
        if (current.fx_final.receipt !== null) {
          return { kind: "final" as const, receipt: current.fx_final.receipt }
        }

        // A crash may happen after Fx's positive keyed winner is durable
        // locally but before the final stage transition.  That winner is
        // sufficient to finish recovery with the provider-reserved
        // Conversation; replay must not submit initial Work-control again.
        if (current.fx_admission_decision?.decision.kind === "admitted") {
          await this.options.ledger.advance(ensureId, {
            kind: "fx_started",
            conversation_id: prepared.conversationId,
          })
          return { kind: "advanced" as const }
        }

        const bytes = await this.options.sources.retrieve(sourceAuthority(source))
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.initialWork)
        if (this.closed) return { kind: "stopped" as const }
        const delivered = await this.options.ports.workControl.admitInitial({
          binding: workControl,
          text,
          source,
        })
        if (this.closed) return { kind: "stopped" as const }
        const outcome = await this.options.ports.admission.import({
          record: current,
          delivered,
          expectedConversationId: prepared.conversationId,
        })
        if (outcome.kind === "pending") return { kind: "pending" as const }
        if (outcome.kind === "final") {
          await this.options.ledger.retainFxFinalReceipt(ensureId, outcome.receipt)
          return { kind: "final" as const, receipt: outcome.receipt }
        }
        if (outcome.kind === "cancelled_before_start") {
          await this.options.ledger.retainFxAdmissionDecision(ensureId, outcome.decision)
          return { kind: "cancelled" as const, decision: outcome.decision }
        }
        assertAdmittedObservation(outcome, delivered, prepared.conversationId)
        await this.options.ledger.retainFxAdmissionDecision(ensureId, outcome.decision)
        await this.options.ledger.advance(ensureId, {
          kind: "fx_started",
          conversation_id: outcome.conversationId,
        })
        return { kind: "advanced" as const }
      })

      if (result.kind === "final") {
        if (this.closed) return false
        await this.options.ports.retirement?.afterFinalReceipt(ensureId, result.receipt)
        if (this.closed) return false
        await this.publish(ensureId)
        return false
      }
      if (result.kind === "stopped") return false
      if (result.kind === "pending") return true
      if (result.kind === "cancelled") {
        if (this.closed) return false
        await this.options.ports.retirement?.afterAdmissionCancellation?.(
          ensureId,
          result.decision,
        )
        if (this.closed) return false
        await this.publish(ensureId)
        return false
      }
      if (this.closed) return false
      await this.publish(ensureId)
      return false
    }
  }

  private async workControlFor(record: EnsureLifecycleRecord): Promise<FxWorkControlBinding> {
    // The Manifest owns both allocation and lookup. This is intentionally a
    // read: a resumed coordinator must never manufacture a replacement token.
    return this.options.ports.manifest.workControl(record.request.agent_id)
  }

  private async publish(ensureId: string): Promise<void> {
    const receipts = this.options.ports.receipts
    if (!receipts || this.closed) return
    const record = await this.require(ensureId)
    if (this.closed) return
    const pending = record.receipts.filter((receipt) =>
      !record.acknowledgements.some((acknowledgement) =>
        acknowledgement.receipt_id === receipt.receipt_id &&
        acknowledgement.receipt_digest === receipt.receipt_digest
      )
    )
    const current = await receipts.ensure(record)
    if (current !== null) {
      await this.options.ledger.retainEnsureReceipt(current)
      if (!pending.some(({ receipt_id }) => receipt_id === current.receipt_id)) {
        pending.push(current)
      }
    }
    for (const receipt of pending) {
      if (this.closed) return
      await receipts.publish(receipt)
    }
  }

  private async require(ensureId: string): Promise<EnsureLifecycleRecord> {
    const record = await this.options.ledger.get(ensureId)
    if (record === null) throw new Error(`ensure ${ensureId} disappeared from its durable ledger`)
    return record
  }

  private async withAdmissionGate<T>(ensureId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.admissionGates.get(ensureId) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => held)
    this.admissionGates.set(ensureId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.admissionGates.get(ensureId) === tail) this.admissionGates.delete(ensureId)
    }
  }

  private deferPendingRetry(ensureId: string): void {
    if (this.closed) return
    const attempts = (this.pendingRetries.get(ensureId)?.attempts ?? 0) + 1
    this.clearPendingRetry(ensureId)
    if (attempts >= this.pendingAdmissionAttempts) {
      try {
        this.options.ports.onError?.(
          new Error(
            `ensure ${ensureId} remains pending after ${attempts} bounded admission attempts`,
          ),
          ensureId,
        )
      } catch {
        // Diagnostics cannot change durable pending state.
      }
      return
    }
    const retry = { attempts, timer: null as ReturnType<typeof setTimeout> | null }
    const timer = setTimeout(() => {
      retry.timer = null
      if (this.pendingRetries.get(ensureId) !== retry || this.closed) return
      this.schedule(ensureId, true)
    }, this.pendingAdmissionRetryDelayMs)
    timer.unref?.()
    retry.timer = timer
    this.pendingRetries.set(ensureId, retry)
  }

  private clearPendingRetry(ensureId: string): void {
    const retry = this.pendingRetries.get(ensureId)
    if (retry?.timer !== null && retry?.timer !== undefined) clearTimeout(retry.timer)
    this.pendingRetries.delete(ensureId)
  }
}

function atOrAfter(stage: EnsureLifecycleStage, threshold: EnsureLifecycleStage): boolean {
  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(threshold)
}

function sourceAuthority(source: InlineLaunchSourceRequest) {
  return {
    workplace_instance_id: source.workplace_instance_id,
    fmx_session: source.fmx_session,
    ensure_id: source.ensure_id,
    ensure_digest: source.ensure_digest,
    worktree_id: source.worktree_id,
    agent_id: source.agent_id,
    launch_id: source.launch_id,
    launch_digest: source.launch_digest,
    admission_key: source.admission_key,
    source_id: source.source_id,
    source_digest: source.source_digest,
  }
}

function assertPreparedAuthority(
  binding: FxFinalReceiptAuthorityBinding,
  source: InlineLaunchSourceRequest,
): void {
  if (
    binding.admission_key !== source.admission_key ||
    binding.state_root !== source.launch_request.state_root
  ) {
    throw new Error("Fx launch provider changed the frozen admission authority")
  }
}

function assertAdmittedObservation(
  outcome: Extract<LifecycleAdmissionOutcome, { kind: "admitted" }>,
  delivered: Readonly<{ admission: FxWorkControlResult; conversationId: string }> | null,
  expectedConversationId: string,
): void {
  if (outcome.conversationId !== expectedConversationId) {
    throw new Error("Fx admission changed the provider-reserved Conversation")
  }
  if (delivered === null) return
  if (
    delivered.conversationId !== outcome.conversationId ||
    delivered.admission.turn_id !== outcome.decision.decision.turn_id ||
    delivered.admission.disposition !== outcome.decision.decision.disposition
  ) {
    throw new Error("Fx admission decision conflicts with the exact Work-control observation")
  }
}
