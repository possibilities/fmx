import {
  type EnsureLifecycleRecord,
  type EnsureLifecycleStage,
  type EnsureReceipt,
  type EnsureRequest,
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
    }>
  }
  admission: {
    /**
     * Import Fx's exact admission decision and active Conversation into the
     * pending launch provider. This is idempotent by launch correlation;
     * fmx neither derives a decision nor reads Fx's private ledger.
     */
    import(input: Readonly<{
      record: EnsureLifecycleRecord
      admission: FxWorkControlResult
      conversationId: string
    }>): Promise<void>
  }
  cancellation: {
    /**
     * Atomically choose never-started cancellation or permission to spawn.
     * Once `start` is returned, an end request must use ordinary retirement;
     * it cannot be reclassified as cancelled-before-start.
     */
    beginStart(ensureId: string): Promise<"start" | "cancelled_before_start">
  }
  retirement?: {
    /** Called only after a correlated final Fx receipt is retained durably. */
    afterFinalReceipt(ensureId: string, receipt: FxFinalReceipt): Promise<void>
    /** End/cleanup retain their own durable intents in the retirement slice. */
    accept?(message: Exclude<RuntimeExtensionLifecycleInbound, EnsureRequest>): Promise<void>
  }
  receipts?: {
    /** Build a correlated immutable receipt for this exact persisted state, or suppress publication. */
    ensure(record: EnsureLifecycleRecord): Promise<EnsureReceipt | null>
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
  private activeEffects = 0
  private readonly maxConcurrentEffects: number

  constructor(private readonly options: LifecycleCoordinatorOptions) {
    const maximum = options.maxConcurrentEffects ?? 4
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32) {
      throw new Error("lifecycle coordinator maxConcurrentEffects must be an integer from 1 through 32")
    }
    this.maxConcurrentEffects = maximum
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
      if (record.stage !== "fx_started") this.schedule(record.request.ensure_id)
    }
  }

  /** Retain Fx's final receipt before any Manifest-removal/retirement hook can run. */
  async retainFinalReceipt(ensureId: string, receipt: FxFinalReceipt): Promise<void> {
    await this.options.ledger.retainFxFinalReceipt(ensureId, receipt)
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

  /** Test/host shutdown aid: waits for work already scheduled by this coordinator. */
  async settled(): Promise<void> {
    while (this.scheduled.size > 0) {
      await Promise.all([...this.scheduled.values()].map(({ promise }) => promise))
    }
  }

  private schedule(ensureId: string): void {
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
    while (this.activeEffects < this.maxConcurrentEffects && this.queued.length > 0) {
      const ensureId = this.queued.shift()!
      const completion = this.scheduled.get(ensureId)
      if (completion === undefined) continue
      this.activeEffects++
      void this.drive(ensureId)
        .catch((error) => {
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

  private async drive(ensureId: string): Promise<void> {
    for (;;) {
      const record = await this.require(ensureId)
      if (record.stage === "fx_started") {
        await this.publish(ensureId)
        return
      }
      const source = await this.options.sources.sourceForEnsure(record.request)
      if (source === null) throw new Error(`ensure ${ensureId} has no durably bound inline source`)

      if (record.stage === "claimed") {
        const effect = await this.options.ports.worktree.create({ request: record.request, source })
        await this.options.ledger.advance(ensureId, {
          kind: "worktree_created",
          directory: effect.directory,
          head_commit: effect.headCommit,
        })
        await this.publish(ensureId)
        continue
      }

      if (record.stage === "worktree_created") {
        await this.options.ports.manifest.claim({ request: record.request, source })
        await this.options.ledger.advance(ensureId, {
          kind: "manifest_claimed",
          agent_id: record.request.agent_id,
        })
        await this.publish(ensureId)
        continue
      }

      const workControl = await this.workControlFor(record)
      const prepared = await this.options.ports.launch.prepare({ record, source, workControl })
      await this.options.ledger.bindFxFinalReceiptAuthority(ensureId, prepared.finalReceiptAuthority)

      if (record.stage === "manifest_claimed") {
        if (await this.options.ports.cancellation.beginStart(ensureId) === "cancelled_before_start") {
          await this.publish(ensureId)
          return
        }
        const effect = await this.options.ports.companion.start({ record, invocation: prepared.invocation })
        await this.options.ledger.advance(ensureId, {
          kind: "companion_started",
          session_name: effect.sessionName,
          pane_id: effect.paneId,
        })
        await this.publish(ensureId)
        continue
      }

      const bytes = await this.options.sources.retrieve(sourceAuthority(source))
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.initialWork)
      const admitted = await this.options.ports.workControl.admitInitial({ binding: workControl, text, source })
      await this.options.ports.admission.import({
        record,
        admission: admitted.admission,
        conversationId: admitted.conversationId,
      })
      await this.options.ledger.advance(ensureId, {
        kind: "fx_started",
        conversation_id: admitted.conversationId,
      })
      await this.publish(ensureId)
      return
    }
  }

  private async workControlFor(record: EnsureLifecycleRecord): Promise<FxWorkControlBinding> {
    // The Manifest owns both allocation and lookup. This is intentionally a
    // read: a resumed coordinator must never manufacture a replacement token.
    return this.options.ports.manifest.workControl(record.request.agent_id)
  }

  private async publish(ensureId: string): Promise<void> {
    const receipts = this.options.ports.receipts
    if (!receipts) return
    const record = await this.require(ensureId)
    const receipt = await receipts.ensure(record)
    if (receipt === null) return
    await this.options.ledger.retainEnsureReceipt(receipt)
    await receipts.publish(receipt)
  }

  private async require(ensureId: string): Promise<EnsureLifecycleRecord> {
    const record = await this.options.ledger.get(ensureId)
    if (record === null) throw new Error(`ensure ${ensureId} disappeared from its durable ledger`)
    return record
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
