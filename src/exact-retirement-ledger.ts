import { createHash, randomBytes } from "node:crypto"
import { constants, fstatSync, type Stats } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"
import * as z from "zod/v4"
import {
  ensureLifecycleMessageSchema,
  type EnsureLifecycleMessage,
} from "./agentworkplace-contracts.ts"
import { identityFor } from "./agent-manifest.ts"
import {
  CONTRACT_MAX_FRAME_BYTES,
  decodeStrictJson,
  encodeCanonicalJson,
  type JsonValue,
} from "./contract-codec.ts"
import {
  deriveEnsureDigest,
  type EnsureLifecycleRecord,
  type EnsureLifecycleStage,
  type EnsureRequest,
} from "./ensure-lifecycle-ledger.ts"
import { acquireExclusiveLock, type HeldLock } from "./file-lock.ts"

const LEDGER_SCHEMA_ID = "fmx.exact-retirement-ledger"
const LEDGER_SCHEMA_VERSION = 1
const LOCK_FILE = ".exact-retirement.lock"
const RECORD_FILE = /^[0-9a-f]{64}\.json$/u
const TEMPORARY_FILE = /^[0-9a-f]{64}\.json\.[0-9]+\.[0-9a-f]{16}\.tmp$/u
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const STAGES: readonly EnsureLifecycleStage[] = [
  "claimed",
  "worktree_created",
  "manifest_claimed",
  "companion_started",
  "fx_started",
]

type LiteralMessage<Shape, Type extends string> = Shape extends unknown
  ? Omit<Shape, "message_type"> & { message_type: Type }
  : never

export type EndRequest = LiteralMessage<
  Extract<EnsureLifecycleMessage, { reason: unknown }>,
  "end_request"
>
export type EndReceipt = LiteralMessage<
  Extract<EnsureLifecycleMessage, { proof: unknown }>,
  "end_receipt"
>
export type CleanupRequest = LiteralMessage<
  Exclude<Extract<EnsureLifecycleMessage, { cleanup_id: unknown }>, { outcome: unknown }>,
  "cleanup_request"
>
export type CleanupReceipt = LiteralMessage<
  Extract<EnsureLifecycleMessage, { outcome: unknown }>,
  "cleanup_receipt"
>
export type RetirementReceiptAcknowledgement = LiteralMessage<
  Extract<EnsureLifecycleMessage, { acknowledgement_id: unknown }>,
  "receipt_acknowledgement"
>

export type RetirementEnsureSnapshot = {
  request: EnsureRequest
  stage: EnsureLifecycleStage
  effects: EnsureLifecycleRecord["effects"]
}

export type CleanupPrepare = {
  repository: string
  worktree_directory: string
  head_commit: string
  status_digest: string
  prepared_at: string
}

export type ExactRetirementRecord = {
  schema_id: typeof LEDGER_SCHEMA_ID
  schema_version: typeof LEDGER_SCHEMA_VERSION
  revision: number
  ensure: RetirementEnsureSnapshot
  end: null | {
    request: EndRequest
    kill: null | {
      intent_at: string
      write_flushed_at: string | null
    }
    receipt: EndReceipt | null
    acknowledgement: RetirementReceiptAcknowledgement | null
  }
  cleanup: null | {
    request: CleanupRequest
    prepare: CleanupPrepare | null
    receipt: CleanupReceipt | null
    acknowledgement: RetirementReceiptAcknowledgement | null
  }
}

export type ExactRetirementLedgerFaultPoint =
  | "before_write"
  | "after_file_sync"
  | "before_rename"
  | "after_rename"
  | "after_directory_sync"

export type ExactRetirementLedgerOptions = {
  uid?: number
  lockAttempts?: number
  lockDelayMs?: number
  fault?: (
    point: ExactRetirementLedgerFaultPoint,
    record: Readonly<ExactRetirementRecord>,
  ) => void | Promise<void>
}

export type ExactRetirementLedgerErrorCode =
  | "acknowledgement_conflict"
  | "conflicting_ensure"
  | "corrupt_record"
  | "invalid_acknowledgement"
  | "invalid_request"
  | "invalid_root"
  | "invalid_transition"
  | "lock_unavailable"
  | "receipt_conflict"
  | "unsafe_storage"

export class ExactRetirementLedgerError extends Error {
  constructor(
    readonly code: ExactRetirementLedgerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ExactRetirementLedgerError"
  }
}

const timestampSchema = z.string().datetime({ offset: false })
const cleanupPrepareSchema = z.strictObject({
  repository: z.string(),
  worktree_directory: z.string(),
  head_commit: z.string().regex(GIT_OBJECT_ID),
  status_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  prepared_at: timestampSchema,
})
const privateRecordSchema = z.strictObject({
  schema_id: z.literal(LEDGER_SCHEMA_ID),
  schema_version: z.literal(LEDGER_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  ensure: z.strictObject({
    request: ensureLifecycleMessageSchema,
    stage: z.enum(STAGES as [EnsureLifecycleStage, ...EnsureLifecycleStage[]]),
    effects: z.unknown(),
  }),
  end: z.strictObject({
    request: ensureLifecycleMessageSchema,
    kill: z.strictObject({
      intent_at: timestampSchema,
      write_flushed_at: timestampSchema.nullable(),
    }).nullable(),
    receipt: ensureLifecycleMessageSchema.nullable(),
    acknowledgement: ensureLifecycleMessageSchema.nullable(),
  }).nullable(),
  cleanup: z.strictObject({
    request: ensureLifecycleMessageSchema,
    prepare: cleanupPrepareSchema.nullable(),
    receipt: ensureLifecycleMessageSchema.nullable(),
    acknowledgement: ensureLifecycleMessageSchema.nullable(),
  }).nullable(),
})

type StorageGuard = {
  directory: FileHandle
  lock: HeldLock
  rootIdentity: Stats
  lockIdentity: Stats
}

type RecordIndex = {
  records: ExactRetirementRecord[]
  byEnsureId: Map<string, ExactRetirementRecord>
  identities: Map<string, Stats>
}

/**
 * Separate private authority for retirement and cleanup effects. It retains
 * exact frozen envelopes but does not extend or rewrite the ensure ledger.
 */
export class ExactRetirementLedger {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly uid: number
  private readonly lockAttempts: number
  private readonly lockDelayMs: number
  private readonly fault: NonNullable<ExactRetirementLedgerOptions["fault"]> | null

  private constructor(
    readonly root: string,
    options: ExactRetirementLedgerOptions,
  ) {
    this.uid = options.uid ?? userInfo().uid
    this.lockAttempts = options.lockAttempts ?? 1_000
    this.lockDelayMs = options.lockDelayMs ?? 2
    this.fault = options.fault ?? null
  }

  static async open(
    root: string,
    options: ExactRetirementLedgerOptions = {},
  ): Promise<ExactRetirementLedger> {
    assertRootPath(root)
    const ledger = new ExactRetirementLedger(root, options)
    await ledger.serial(() => ledger.withLock(async (guard) => {
      await ledger.readIndex(guard)
    }))
    return ledger
  }

  bindEnsure(input: EnsureLifecycleRecord): Promise<ExactRetirementRecord> {
    return this.mutate(input.request.ensure_id, (record, index) => {
      const ensure = snapshotEnsure(input)
      if (record) {
        if (!sameCanonical(record.ensure, ensure)) {
          throw ledgerError(
            "conflicting_ensure",
            `ensure ${ensure.request.ensure_id} is already bound to a different durable snapshot`,
          )
        }
        return record
      }
      if (index.records.some(({ ensure: candidate }) =>
        candidate.request.agent_id === ensure.request.agent_id ||
        candidate.request.worktree_id === ensure.request.worktree_id
      )) {
        throw ledgerError("conflicting_ensure", "Agent or Worktree identity belongs to another ensure")
      }
      return {
        schema_id: LEDGER_SCHEMA_ID,
        schema_version: LEDGER_SCHEMA_VERSION,
        revision: 1,
        ensure,
        end: null,
        cleanup: null,
      }
    })
  }

  get(ensureId: string): Promise<ExactRetirementRecord | null> {
    return this.serial(() => this.withLock(async (guard) => {
      const record = (await this.readIndex(guard)).byEnsureId.get(ensureId)
      return record ? copyRecord(record) : null
    }))
  }

  list(): Promise<ExactRetirementRecord[]> {
    return this.serial(() => this.withLock(async (guard) =>
      (await this.readIndex(guard)).records.map(copyRecord)))
  }

  beginEnd(requestInput: EndRequest): Promise<ExactRetirementRecord> {
    const request = parseEndRequest(requestInput)
    return this.mutate(request.ensure_id, (record, index) => {
      const current = requireRecord(record, request.ensure_id)
      if (current.end) {
        if (!sameCanonical(current.end.request, request)) {
          throw ledgerError("invalid_request", `end ${request.end_id} conflicts with retained end intent`)
        }
        return current
      }
      if (index.records.some((candidate) => candidate.end?.request.end_id === request.end_id)) {
        throw ledgerError("invalid_request", `end id ${request.end_id} belongs to another ensure`)
      }
      assertEndCorrelation(current.ensure, request)
      const next = copyRecord(current)
      next.revision++
      next.end = { request, kill: null, receipt: null, acknowledgement: null }
      return next
    })
  }

  markKillIntent(ensureId: string, intentAt: string): Promise<ExactRetirementRecord> {
    assertTimestamp(intentAt, "kill intent")
    return this.mutate(ensureId, (record) => {
      const current = requireRecord(record, ensureId)
      if (!current.end) throw ledgerError("invalid_transition", "end intent is not retained")
      if (current.end.request.reason === "cancelled_before_start") {
        throw ledgerError("invalid_transition", "never-started retirement cannot send Kill")
      }
      if (current.end.kill) return current
      const next = copyRecord(current)
      next.revision++
      next.end!.kill = { intent_at: intentAt, write_flushed_at: null }
      return next
    })
  }

  markKillWriteFlushed(ensureId: string, flushedAt: string): Promise<ExactRetirementRecord> {
    assertTimestamp(flushedAt, "Kill write flush")
    return this.mutate(ensureId, (record) => {
      const current = requireRecord(record, ensureId)
      if (!current.end?.kill) throw ledgerError("invalid_transition", "Kill intent is not durable")
      if (current.end.kill.write_flushed_at !== null) return current
      const next = copyRecord(current)
      next.revision++
      next.end!.kill!.write_flushed_at = flushedAt
      return next
    })
  }

  retainEndReceipt(receiptInput: EndReceipt): Promise<ExactRetirementRecord> {
    const receipt = parseEndReceipt(receiptInput)
    return this.mutate(receipt.ensure_id, (record, index) => {
      const current = requireRecord(record, receipt.ensure_id)
      if (!current.end) throw ledgerError("invalid_transition", "end intent is not retained")
      if (current.end.receipt) {
        if (!sameCanonical(current.end.receipt, receipt)) {
          throw ledgerError("receipt_conflict", `end receipt ${receipt.receipt_id} changed bytes`)
        }
        return current
      }
      assertReceiptIdAvailable(index.records, receipt.receipt_id)
      assertEndReceiptCorrelation(current, receipt)
      const next = copyRecord(current)
      next.revision++
      next.end!.receipt = receipt
      return next
    })
  }

  beginCleanup(requestInput: CleanupRequest): Promise<ExactRetirementRecord> {
    const request = parseCleanupRequest(requestInput)
    return this.mutate(request.ensure_id, (record, index) => {
      const current = requireRecord(record, request.ensure_id)
      if (!current.end?.receipt) {
        throw ledgerError("invalid_transition", "cleanup requires a retained exact end receipt")
      }
      if (current.cleanup) {
        if (!sameCanonical(current.cleanup.request, request)) {
          throw ledgerError("invalid_request", `cleanup ${request.cleanup_id} conflicts with retained cleanup intent`)
        }
        return current
      }
      if (index.records.some((candidate) => candidate.cleanup?.request.cleanup_id === request.cleanup_id)) {
        throw ledgerError("invalid_request", `cleanup id ${request.cleanup_id} belongs to another ensure`)
      }
      assertCleanupCorrelation(current, request)
      const next = copyRecord(current)
      next.revision++
      next.cleanup = { request, prepare: null, receipt: null, acknowledgement: null }
      return next
    })
  }

  prepareCleanup(ensureId: string, input: CleanupPrepare): Promise<ExactRetirementRecord> {
    const prepare = parsePrepare(input)
    return this.mutate(ensureId, (record) => {
      const current = requireRecord(record, ensureId)
      if (!current.cleanup) throw ledgerError("invalid_transition", "cleanup intent is not retained")
      if (prepare.repository !== current.ensure.request.planned_worktree.repository ||
        prepare.worktree_directory !== current.cleanup.request.worktree_directory
      ) {
        throw ledgerError("invalid_transition", "cleanup prepare changed repository or Worktree identity")
      }
      if (current.cleanup.prepare) {
        if (!sameCanonical(current.cleanup.prepare, prepare)) {
          throw ledgerError("invalid_transition", "cleanup prepare snapshot changed")
        }
        return current
      }
      const next = copyRecord(current)
      next.revision++
      next.cleanup!.prepare = prepare
      return next
    })
  }

  retainCleanupReceipt(receiptInput: CleanupReceipt): Promise<ExactRetirementRecord> {
    const receipt = parseCleanupReceipt(receiptInput)
    return this.mutate(receipt.ensure_id, (record, index) => {
      const current = requireRecord(record, receipt.ensure_id)
      if (!current.cleanup) throw ledgerError("invalid_transition", "cleanup intent is not retained")
      if (current.cleanup.receipt) {
        if (!sameCanonical(current.cleanup.receipt, receipt)) {
          throw ledgerError("receipt_conflict", `cleanup receipt ${receipt.receipt_id} changed bytes`)
        }
        return current
      }
      assertReceiptIdAvailable(index.records, receipt.receipt_id)
      assertCleanupReceiptCorrelation(current, receipt)
      const next = copyRecord(current)
      next.revision++
      next.cleanup!.receipt = receipt
      return next
    })
  }

  acknowledge(input: RetirementReceiptAcknowledgement): Promise<ExactRetirementRecord> {
    const acknowledgement = parseAcknowledgement(input)
    return this.mutate(acknowledgement.ensure_id, (record, index) => {
      const current = requireRecord(record, acknowledgement.ensure_id)
      const target = acknowledgement.receipt_kind === "end" ? current.end : current.cleanup
      if (!target?.receipt ||
        target.receipt.receipt_id !== acknowledgement.receipt_id ||
        target.receipt.receipt_digest !== acknowledgement.receipt_digest
      ) {
        throw ledgerError(
          "invalid_acknowledgement",
          `acknowledgement ${acknowledgement.acknowledgement_id} does not name an exact retained receipt`,
        )
      }
      if (target.acknowledgement) {
        if (!sameCanonical(target.acknowledgement, acknowledgement)) {
          throw ledgerError(
            "acknowledgement_conflict",
            `receipt ${acknowledgement.receipt_id} already has a different acknowledgement`,
          )
        }
        return current
      }
      for (const candidate of index.records) {
        for (const retained of [candidate.end?.acknowledgement, candidate.cleanup?.acknowledgement]) {
          if (retained?.acknowledgement_id === acknowledgement.acknowledgement_id) {
            throw ledgerError(
              "acknowledgement_conflict",
              `acknowledgement id ${acknowledgement.acknowledgement_id} belongs to another receipt`,
            )
          }
        }
      }
      const next = copyRecord(current)
      next.revision++
      if (acknowledgement.receipt_kind === "end") next.end!.acknowledgement = acknowledgement
      else next.cleanup!.acknowledgement = acknowledgement
      return next
    })
  }

  private mutate(
    ensureId: string,
    change: (
      current: ExactRetirementRecord | null,
      index: RecordIndex,
    ) => ExactRetirementRecord,
  ): Promise<ExactRetirementRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const index = await this.readIndex(guard)
      const current = index.byEnsureId.get(ensureId) ?? null
      const next = change(current, index)
      validateRecord(next, recordPathFor(this.root, ensureId))
      if (current && sameCanonical(current, next)) return copyRecord(current)
      await this.writeRecord(next, guard, current ? requireIdentity(index, ensureId) : null)
      return copyRecord(next)
    }))
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async withLock<T>(operation: (guard: StorageGuard) => Promise<T>): Promise<T> {
    const rootIdentity = await ensurePrivateRoot(this.root, this.uid)
    const lockIdentity = await ensureLockFile(this.root, this.uid)
    for (let attempt = 0; attempt < this.lockAttempts; attempt++) {
      const lock = acquireExclusiveLock(resolve(this.root, LOCK_FILE), {
        create: false,
        noFollow: true,
      })
      if (lock === undefined) throw ledgerError("lock_unavailable", "native flock is unavailable")
      if (lock !== null) {
        let directory: FileHandle | null = null
        try {
          const lockedIdentity = fstatSync(lock.descriptor)
          assertSafeFileStats(resolve(this.root, LOCK_FILE), lockedIdentity, this.uid)
          if (!sameFileIdentity(lockIdentity, lockedIdentity)) {
            throw unsafeStorage("retirement ledger lock changed before acquisition")
          }
          directory = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
          const currentRoot = await directory.stat()
          assertSafeRootStats(this.root, currentRoot, this.uid)
          if (!sameRootIdentity(rootIdentity, currentRoot)) {
            throw unsafeStorage("retirement ledger root changed before acquisition")
          }
          const guard = { directory, lock, rootIdentity: currentRoot, lockIdentity: lockedIdentity }
          await assertStorageGuard(this.root, guard, this.uid)
          const result = await operation(guard)
          await assertStorageGuard(this.root, guard, this.uid)
          return result
        } finally {
          lock.release()
          await directory?.close().catch(() => undefined)
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.lockDelayMs))
    }
    throw ledgerError("lock_unavailable", "retirement ledger lock remained held")
  }

  private async readIndex(guard: StorageGuard): Promise<RecordIndex> {
    await assertStorageGuard(this.root, guard, this.uid)
    const entries = await readdir(this.root, { withFileTypes: true })
    const records: ExactRetirementRecord[] = []
    const identities = new Map<string, Stats>()
    const temporaries: string[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(this.root, entry.name)
      if (entry.name === LOCK_FILE) {
        if (!entry.isFile()) throw unsafeStorage(`${path} is not a regular lock file`)
        await assertSafeFile(path, this.uid)
        continue
      }
      if (TEMPORARY_FILE.test(entry.name)) {
        if (!entry.isFile()) throw unsafeStorage(`${path} is not a regular temporary file`)
        await assertSafeFile(path, this.uid)
        temporaries.push(path)
        continue
      }
      if (!RECORD_FILE.test(entry.name) || !entry.isFile()) {
        throw ledgerError("corrupt_record", `foreign or unsafe retirement ledger entry: ${path}`)
      }
      const { identity, record } = await readRecord(path, this.uid)
      if (entry.name !== recordFileName(record.ensure.request.ensure_id)) {
        throw ledgerError("corrupt_record", `${path} does not match its ensure identity`)
      }
      records.push(record)
      identities.set(record.ensure.request.ensure_id, identity)
    }
    validateIndex(records)
    for (const temporary of temporaries) await unlink(temporary)
    await guard.directory.sync()
    return {
      records,
      identities,
      byEnsureId: new Map(records.map((record) => [record.ensure.request.ensure_id, record])),
    }
  }

  private async writeRecord(
    record: ExactRetirementRecord,
    guard: StorageGuard,
    expectedTarget: Stats | null,
  ): Promise<void> {
    validateRecord(record, recordPathFor(this.root, record.ensure.request.ensure_id))
    const target = recordPathFor(this.root, record.ensure.request.ensure_id)
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    const canonical = encodeCanonicalJson(record as unknown as JsonValue)
    const bytes = Buffer.concat([Buffer.from(canonical), Buffer.from("\n")])
    if (bytes.byteLength > CONTRACT_MAX_FRAME_BYTES) {
      throw ledgerError("corrupt_record", "retirement record exceeds the 1 MiB bound")
    }
    await this.inject("before_write", record)
    await assertStorageGuard(this.root, guard, this.uid)
    await assertTargetSnapshot(target, expectedTarget, this.uid)
    let handle: FileHandle | null = null
    let renamed = false
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile(bytes)
      await handle.chmod(0o600)
      const temporaryIdentity = await handle.stat()
      assertSafeFileStats(temporary, temporaryIdentity, this.uid)
      await handle.sync()
      await this.inject("after_file_sync", record)
      await assertStorageGuard(this.root, guard, this.uid)
      await this.inject("before_rename", record)
      await assertTargetSnapshot(target, expectedTarget, this.uid)
      const pathnameIdentity = await assertSafeFile(temporary, this.uid)
      if (!sameFileIdentity(temporaryIdentity, pathnameIdentity)) {
        throw unsafeStorage(`${temporary} changed before durable rename`)
      }
      await handle.close()
      handle = null
      await rename(temporary, target)
      renamed = true
      const renamedIdentity = await assertSafeFile(target, this.uid)
      if (!sameFileIdentity(temporaryIdentity, renamedIdentity)) {
        throw unsafeStorage(`${target} changed during durable rename`)
      }
      await this.inject("after_rename", record)
      await guard.directory.sync()
      await this.inject("after_directory_sync", record)
      await assertStorageGuard(this.root, guard, this.uid)
    } finally {
      await handle?.close().catch(() => undefined)
      if (!renamed) await unlink(temporary).catch(() => undefined)
    }
  }

  private async inject(
    point: ExactRetirementLedgerFaultPoint,
    record: ExactRetirementRecord,
  ): Promise<void> {
    await this.fault?.(point, copyRecord(record))
  }
}

export function deriveEndDigest(request: EndRequest): string {
  return digest({
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
    reason: request.reason,
  })
}

export function deriveCleanupDigest(request: CleanupRequest): string {
  return digest({
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
    cleanup_id: request.cleanup_id,
    worktree_directory: request.worktree_directory,
  })
}

export function deriveLifecycleReceiptDigest(receipt: EndReceipt | CleanupReceipt): string {
  const { receipt_digest: _digest, ...content } = receipt
  return digest(content as unknown as JsonValue)
}

export function retirementRecordPathFor(root: string, ensureId: string): string {
  return resolve(root, recordFileName(ensureId))
}

function snapshotEnsure(input: EnsureLifecycleRecord): RetirementEnsureSnapshot {
  const snapshot: RetirementEnsureSnapshot = {
    request: structuredClone(input.request),
    stage: input.stage,
    effects: structuredClone(input.effects),
  }
  validateEnsureSnapshot(snapshot, "ensure input")
  return snapshot
}

function parseEndRequest(input: EndRequest): EndRequest {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (!parsed.success || parsed.data.message_type !== "end_request") {
    throw ledgerError("invalid_request", "end intent is not a strict frozen end_request")
  }
  const request = structuredClone(parsed.data) as EndRequest
  if (deriveEndDigest(request) !== request.end_digest) {
    throw ledgerError("invalid_request", `end ${request.end_id} has an invalid digest`)
  }
  return request
}

function parseCleanupRequest(input: CleanupRequest): CleanupRequest {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (!parsed.success || parsed.data.message_type !== "cleanup_request") {
    throw ledgerError("invalid_request", "cleanup intent is not a strict frozen cleanup_request")
  }
  const request = structuredClone(parsed.data) as CleanupRequest
  if (deriveCleanupDigest(request) !== request.cleanup_digest) {
    throw ledgerError("invalid_request", `cleanup ${request.cleanup_id} has an invalid digest`)
  }
  return request
}

function parseEndReceipt(input: EndReceipt): EndReceipt {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (!parsed.success || parsed.data.message_type !== "end_receipt") {
    throw ledgerError("receipt_conflict", "retained end receipt is not strict frozen v1")
  }
  const receipt = structuredClone(parsed.data) as EndReceipt
  if (deriveLifecycleReceiptDigest(receipt) !== receipt.receipt_digest) {
    throw ledgerError("receipt_conflict", `end receipt ${receipt.receipt_id} has an invalid digest`)
  }
  return receipt
}

function parseCleanupReceipt(input: CleanupReceipt): CleanupReceipt {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (!parsed.success || parsed.data.message_type !== "cleanup_receipt") {
    throw ledgerError("receipt_conflict", "retained cleanup receipt is not strict frozen v1")
  }
  const receipt = structuredClone(parsed.data) as CleanupReceipt
  if (deriveLifecycleReceiptDigest(receipt) !== receipt.receipt_digest) {
    throw ledgerError("receipt_conflict", `cleanup receipt ${receipt.receipt_id} has an invalid digest`)
  }
  return receipt
}

function parseAcknowledgement(
  input: RetirementReceiptAcknowledgement,
): RetirementReceiptAcknowledgement {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (!parsed.success || !("acknowledgement_id" in parsed.data) ||
    parsed.data.message_type !== "receipt_acknowledgement" ||
    (parsed.data.receipt_kind !== "end" && parsed.data.receipt_kind !== "cleanup")
  ) {
    throw ledgerError("invalid_acknowledgement", "acknowledgement is not for an end or cleanup receipt")
  }
  return structuredClone(parsed.data) as RetirementReceiptAcknowledgement
}

function parsePrepare(input: CleanupPrepare): CleanupPrepare {
  const parsed = cleanupPrepareSchema.safeParse(input)
  if (!parsed.success || !isAbsolute(parsed.data.repository) ||
    resolve(parsed.data.repository) !== parsed.data.repository ||
    !isAbsolute(parsed.data.worktree_directory) ||
    resolve(parsed.data.worktree_directory) !== parsed.data.worktree_directory
  ) {
    throw ledgerError("invalid_transition", "cleanup prepare is not an exact bounded snapshot")
  }
  return structuredClone(parsed.data)
}

function assertEndCorrelation(ensure: RetirementEnsureSnapshot, request: EndRequest): void {
  assertRequestCorrelation(ensure.request, request)
  if (request.reason === "cancelled_before_start") {
    if (STAGES.indexOf(ensure.stage) >= STAGES.indexOf("companion_started")) {
      throw ledgerError("invalid_request", "never-started end conflicts with a started Companion")
    }
    return
  }
  if (ensure.stage !== "fx_started" || ensure.effects.fx.status !== "started" ||
    request.conversation_id !== ensure.effects.fx.conversation_id
  ) {
    throw ledgerError("invalid_request", "started end does not name the exact durable Fx Conversation")
  }
}

function assertCleanupCorrelation(record: ExactRetirementRecord, request: CleanupRequest): void {
  const end = record.end!
  assertRequestCorrelation(record.ensure.request, request)
  for (const field of ["conversation_id", "end_id", "end_digest"] as const) {
    if (request[field] !== end.request[field]) {
      throw ledgerError("invalid_request", `cleanup request changed ${field}`)
    }
  }
  if (request.worktree_directory !== record.ensure.request.planned_worktree.directory) {
    throw ledgerError("invalid_request", "cleanup changed the planned Worktree directory")
  }
}

function assertEndReceiptCorrelation(record: ExactRetirementRecord, receipt: EndReceipt): void {
  const request = record.end!.request
  for (const field of [
    "request_id",
    "workplace_instance_id",
    "fmx_session",
    "ensure_id",
    "ensure_digest",
    "launch_id",
    "launch_digest",
    "worktree_id",
    "agent_id",
    "conversation_id",
    "end_id",
    "end_digest",
  ] as const) {
    if (receipt[field] !== request[field]) {
      throw ledgerError("receipt_conflict", `end receipt changed ${field}`)
    }
  }
  const identity = identityFor(record.ensure.request.agent_id)
  if (receipt.proof.companion_session !== identity.zmxName || receipt.proof.pane_id !== identity.paneId) {
    throw ledgerError("receipt_conflict", "end proof changed the exact Companion identity")
  }
  if (receipt.proof.kind === "ended" && !record.end!.kill) {
    throw ledgerError("receipt_conflict", "started end proof has no durable Kill intent")
  }
}

function assertCleanupReceiptCorrelation(
  record: ExactRetirementRecord,
  receipt: CleanupReceipt,
): void {
  const request = record.cleanup!.request
  for (const field of [
    "request_id",
    "workplace_instance_id",
    "fmx_session",
    "ensure_id",
    "ensure_digest",
    "launch_id",
    "launch_digest",
    "worktree_id",
    "agent_id",
    "conversation_id",
    "end_id",
    "end_digest",
    "cleanup_id",
    "cleanup_digest",
    "worktree_directory",
  ] as const) {
    if (receipt[field] !== request[field]) {
      throw ledgerError("receipt_conflict", `cleanup receipt changed ${field}`)
    }
  }
  if (receipt.outcome.kind === "removed" && !record.cleanup!.prepare) {
    throw ledgerError("receipt_conflict", "removed outcome has no durable prepare marker")
  }
  if (receipt.outcome.kind === "removed" &&
    receipt.outcome.head_commit !== record.cleanup!.prepare?.head_commit
  ) {
    throw ledgerError("receipt_conflict", "removed outcome changed the prepared Worktree HEAD")
  }
}

function assertRequestCorrelation(
  ensure: EnsureRequest,
  request: EndRequest | CleanupRequest,
): void {
  for (const field of [
    "workplace_instance_id",
    "fmx_session",
    "ensure_id",
    "ensure_digest",
    "launch_id",
    "launch_digest",
    "worktree_id",
    "agent_id",
  ] as const) {
    if (request[field] !== ensure[field]) {
      throw ledgerError("invalid_request", `${request.message_type} changed ${field}`)
    }
  }
}

function validateEnsureSnapshot(snapshot: RetirementEnsureSnapshot, path: string): void {
  const parsed = ensureLifecycleMessageSchema.safeParse(snapshot.request)
  if (!parsed.success || parsed.data.message_type !== "ensure_request" ||
    deriveEnsureDigest(snapshot.request) !== snapshot.request.ensure_digest
  ) {
    throw ledgerError("corrupt_record", `${path} has an invalid ensure request`)
  }
  const stageIndex = STAGES.indexOf(snapshot.stage)
  if (stageIndex < 0) throw ledgerError("corrupt_record", `${path} has an invalid ensure stage`)
  const { worktree, manifest, companion, fx } = snapshot.effects
  const identity = identityFor(snapshot.request.agent_id)
  const expectedWorktree = stageIndex >= 1 ? "created" : "planned"
  const expectedManifest = stageIndex >= 2 ? "claimed" : "pending"
  const expectedCompanion = stageIndex >= 3 ? "started" : "pending"
  const expectedFx = stageIndex >= 4 ? "started" : "pending"
  if (worktree.status !== expectedWorktree || manifest.status !== expectedManifest ||
    companion.status !== expectedCompanion || fx.status !== expectedFx ||
    worktree.directory !== snapshot.request.planned_worktree.directory ||
    companion.session_name !== identity.zmxName || companion.pane_id !== identity.paneId ||
    (manifest.status === "claimed" && manifest.agent_id !== snapshot.request.agent_id)
  ) {
    throw ledgerError("corrupt_record", `${path} effects do not match stage ${snapshot.stage}`)
  }
}

function validateRecord(record: ExactRetirementRecord, path: string): void {
  if (!privateRecordSchema.safeParse(record).success) {
    throw ledgerError("corrupt_record", `${path} is not a bounded private retirement record`)
  }
  validateEnsureSnapshot(record.ensure, path)
  if (record.end) {
    const request = parseEndRequest(record.end.request)
    assertEndCorrelation(record.ensure, request)
    if (record.end.kill && request.reason === "cancelled_before_start") {
      throw ledgerError("corrupt_record", `${path} sends Kill for never-started retirement`)
    }
    if (record.end.kill) {
      assertTimestamp(record.end.kill.intent_at, "retained Kill intent")
      if (record.end.kill.write_flushed_at !== null) {
        assertTimestamp(record.end.kill.write_flushed_at, "retained Kill write flush")
      }
    }
    if (record.end.receipt) assertEndReceiptCorrelation(record, parseEndReceipt(record.end.receipt))
    if (record.end.acknowledgement) validateRetainedAcknowledgement(record, "end")
  }
  if (record.cleanup) {
    if (!record.end?.receipt) throw ledgerError("corrupt_record", `${path} cleanup precedes end proof`)
    assertCleanupCorrelation(record, parseCleanupRequest(record.cleanup.request))
    if (record.cleanup.prepare) {
      const prepare = parsePrepare(record.cleanup.prepare)
      assertTimestamp(prepare.prepared_at, "retained cleanup prepare")
      if (prepare.repository !== record.ensure.request.planned_worktree.repository ||
        prepare.worktree_directory !== record.cleanup.request.worktree_directory
      ) {
        throw ledgerError("corrupt_record", `${path} cleanup prepare changed durable identity`)
      }
    }
    if (record.cleanup.receipt) {
      assertCleanupReceiptCorrelation(record, parseCleanupReceipt(record.cleanup.receipt))
    }
    if (record.cleanup.acknowledgement) validateRetainedAcknowledgement(record, "cleanup")
  }
  const expectedRevision = 1 + Number(record.end !== null) +
    Number(record.end?.kill !== null && record.end?.kill !== undefined) +
    Number(record.end?.kill?.write_flushed_at !== null && record.end?.kill?.write_flushed_at !== undefined) +
    Number(record.end?.receipt !== null && record.end?.receipt !== undefined) +
    Number(record.end?.acknowledgement !== null && record.end?.acknowledgement !== undefined) +
    Number(record.cleanup !== null) +
    Number(record.cleanup?.prepare !== null && record.cleanup?.prepare !== undefined) +
    Number(record.cleanup?.receipt !== null && record.cleanup?.receipt !== undefined) +
    Number(record.cleanup?.acknowledgement !== null && record.cleanup?.acknowledgement !== undefined)
  if (record.revision !== expectedRevision) {
    throw ledgerError("corrupt_record", `${path} revision ${record.revision} should be ${expectedRevision}`)
  }
}

function validateRetainedAcknowledgement(
  record: ExactRetirementRecord,
  kind: "end" | "cleanup",
): void {
  const target = kind === "end" ? record.end! : record.cleanup!
  const acknowledgement = parseAcknowledgement(target.acknowledgement!)
  if (acknowledgement.receipt_kind !== kind ||
    acknowledgement.ensure_id !== record.ensure.request.ensure_id ||
    !target.receipt ||
    acknowledgement.receipt_id !== target.receipt.receipt_id ||
    acknowledgement.receipt_digest !== target.receipt.receipt_digest
  ) {
    throw ledgerError("corrupt_record", "retained acknowledgement is orphaned")
  }
}

function validateIndex(records: ExactRetirementRecord[]): void {
  const ensureIds = new Set<string>()
  const agentIds = new Set<string>()
  const worktreeIds = new Set<string>()
  const endIds = new Set<string>()
  const cleanupIds = new Set<string>()
  const receiptIds = new Set<string>()
  const acknowledgementIds = new Set<string>()
  for (const record of records) {
    validateRecord(record, `ensure ${record.ensure.request.ensure_id}`)
    if (ensureIds.has(record.ensure.request.ensure_id)) {
      throw ledgerError("corrupt_record", "retirement ledger repeats an ensure id")
    }
    ensureIds.add(record.ensure.request.ensure_id)
    if (agentIds.has(record.ensure.request.agent_id) ||
      worktreeIds.has(record.ensure.request.worktree_id)
    ) {
      throw ledgerError("corrupt_record", "retirement ledger repeats an Agent or Worktree identity")
    }
    agentIds.add(record.ensure.request.agent_id)
    worktreeIds.add(record.ensure.request.worktree_id)
    for (const [value, values, label] of [
      [record.end?.request.end_id, endIds, "end id"],
      [record.cleanup?.request.cleanup_id, cleanupIds, "cleanup id"],
      [record.end?.receipt?.receipt_id, receiptIds, "receipt id"],
      [record.cleanup?.receipt?.receipt_id, receiptIds, "receipt id"],
      [record.end?.acknowledgement?.acknowledgement_id, acknowledgementIds, "acknowledgement id"],
      [record.cleanup?.acknowledgement?.acknowledgement_id, acknowledgementIds, "acknowledgement id"],
    ] as const) {
      if (value === undefined) continue
      if (values.has(value)) throw ledgerError("corrupt_record", `retirement ledger repeats ${label} ${value}`)
      values.add(value)
    }
  }
}

function assertReceiptIdAvailable(records: ExactRetirementRecord[], receiptId: string): void {
  if (records.some((candidate) =>
    candidate.end?.receipt?.receipt_id === receiptId ||
    candidate.cleanup?.receipt?.receipt_id === receiptId
  )) {
    throw ledgerError("receipt_conflict", `receipt id ${receiptId} belongs to another retained receipt`)
  }
}

async function readRecord(
  path: string,
  uid: number,
): Promise<{ identity: Stats; record: ExactRetirementRecord }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const identity = await handle.stat()
    assertSafeFileStats(path, identity, uid)
    if (identity.size < 2 || identity.size > CONTRACT_MAX_FRAME_BYTES) {
      throw ledgerError("corrupt_record", `${path} has an invalid bounded size`)
    }
    const pathnameIdentity = await assertSafeFile(path, uid)
    if (!sameFileSnapshot(identity, pathnameIdentity)) throw unsafeStorage(`${path} changed while opening`)
    const bytes = await handle.readFile()
    const finalIdentity = await handle.stat()
    if (bytes.byteLength !== identity.size || !sameFileSnapshot(identity, finalIdentity)) {
      throw ledgerError("corrupt_record", `${path} changed while being read`)
    }
    if (bytes.at(-1) !== 0x0a) throw ledgerError("corrupt_record", `${path} lacks its canonical newline`)
    const value = decodeStrictJson(bytes.subarray(0, -1))
    const parsed = privateRecordSchema.safeParse(value)
    if (!parsed.success) throw ledgerError("corrupt_record", `${path} is not a private retirement record`)
    const record = structuredClone(parsed.data) as ExactRetirementRecord
    validateRecord(record, path)
    return { identity, record }
  } finally {
    await handle.close()
  }
}

async function ensurePrivateRoot(root: string, uid: number): Promise<Stats> {
  let existed = true
  try {
    await lstat(root)
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw unsafeStorage(`cannot inspect ${root}`)
    existed = false
    await mkdir(root, { recursive: true, mode: 0o700 })
  }
  const identity = await lstat(root)
  assertSafeRootStats(root, identity, uid)
  if (await realpath(root) !== root) throw unsafeStorage(`${root} must not traverse a symlink`)
  if (!existed) await syncDirectory(dirname(root))
  return identity
}

async function ensureLockFile(root: string, uid: number): Promise<Stats> {
  const path = resolve(root, LOCK_FILE)
  let handle: FileHandle | null = null
  let created = false
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    created = true
    await handle.chmod(0o600)
    await handle.sync()
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw unsafeStorage(`cannot create retirement ledger lock ${path}`)
    }
  } finally {
    await handle?.close()
  }
  const identity = await assertSafeFile(path, uid)
  if (created) await syncDirectory(root)
  return identity
}

async function assertStorageGuard(root: string, guard: StorageGuard, uid: number): Promise<void> {
  const currentRoot = await guard.directory.stat()
  const pathnameRoot = await lstat(root)
  assertSafeRootStats(root, currentRoot, uid)
  assertSafeRootStats(root, pathnameRoot, uid)
  if (!sameRootIdentity(guard.rootIdentity, currentRoot) ||
    !sameRootIdentity(guard.rootIdentity, pathnameRoot) ||
    await realpath(root) !== root
  ) {
    throw unsafeStorage(`${root} changed while its lock was held`)
  }
  const currentLock = fstatSync(guard.lock.descriptor)
  const pathnameLock = await assertSafeFile(resolve(root, LOCK_FILE), uid)
  if (!sameFileIdentity(guard.lockIdentity, currentLock) ||
    !sameFileIdentity(guard.lockIdentity, pathnameLock)
  ) {
    throw unsafeStorage("retirement ledger lock changed while held")
  }
}

async function assertTargetSnapshot(path: string, expected: Stats | null, uid: number): Promise<void> {
  try {
    const actual = await assertSafeFile(path, uid)
    if (!expected || !sameFileSnapshot(expected, actual)) {
      throw unsafeStorage(`${path} changed before replacement`)
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      if (expected) throw unsafeStorage(`${path} disappeared before replacement`)
      return
    }
    throw error
  }
}

async function assertSafeFile(path: string, uid: number): Promise<Stats> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const identity = await handle.stat()
    assertSafeFileStats(path, identity, uid)
    return identity
  } finally {
    await handle.close()
  }
}

function assertSafeFileStats(path: string, identity: Stats, uid: number): void {
  if (!identity.isFile() || identity.isSymbolicLink() || identity.uid !== uid ||
    (identity.mode & 0o777) !== 0o600 || identity.nlink !== 1
  ) {
    throw unsafeStorage(`${path} must be one uid-${uid} regular file with mode 0600`)
  }
}

function assertSafeRootStats(path: string, identity: Stats, uid: number): void {
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== uid ||
    (identity.mode & 0o777) !== 0o700
  ) {
    throw unsafeStorage(`${path} must be one uid-${uid} real directory with mode 0700`)
  }
}

function assertRootPath(root: string): void {
  if (!isAbsolute(root) || root === "/" || resolve(root) !== root || root.includes("\0")) {
    throw ledgerError("invalid_root", `retirement root must be one normalized absolute directory: ${root}`)
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!timestampSchema.safeParse(value).success || new Date(value).toISOString() !== value) {
    throw ledgerError("invalid_transition", `${label} is not a canonical UTC timestamp`)
  }
}

function recordFileName(ensureId: string): string {
  return `${createHash("sha256").update(ensureId).digest("hex")}.json`
}

function recordPathFor(root: string, ensureId: string): string {
  return resolve(root, recordFileName(ensureId))
}

function requireRecord(
  record: ExactRetirementRecord | null,
  ensureId: string,
): ExactRetirementRecord {
  if (!record) throw ledgerError("invalid_transition", `ensure ${ensureId} is not bound`)
  return record
}

function requireIdentity(index: RecordIndex, ensureId: string): Stats {
  const identity = index.identities.get(ensureId)
  if (!identity) throw ledgerError("corrupt_record", `ensure ${ensureId} lacks file identity`)
  return identity
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(encodeCanonicalJson(value)).digest("hex")
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalJson(left as JsonValue))
    .equals(Buffer.from(encodeCanonicalJson(right as JsonValue)))
}

function copyRecord(record: ExactRetirementRecord): ExactRetirementRecord {
  return structuredClone(record)
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.nlink === right.nlink
}

function sameRootIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function ledgerError(
  code: ExactRetirementLedgerErrorCode,
  message: string,
): ExactRetirementLedgerError {
  return new ExactRetirementLedgerError(code, message)
}

function unsafeStorage(message: string): ExactRetirementLedgerError {
  return ledgerError("unsafe_storage", message)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
