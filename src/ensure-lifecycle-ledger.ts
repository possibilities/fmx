import { createHash, randomBytes } from "node:crypto"
import { constants, type Stats } from "node:fs"
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
import { acquireExclusiveLock } from "./file-lock.ts"

const LEDGER_SCHEMA_ID = "fmx.ensure-lifecycle-ledger"
const LEDGER_SCHEMA_VERSION = 1
const LOCK_FILE = ".ensure-lifecycle.lock"
const RECORD_FILE = /^[0-9a-f]{64}\.json$/u
const TEMPORARY_FILE = /^[0-9a-f]{64}\.json\.[0-9]+\.[0-9a-f]{16}\.tmp$/u
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const CONVERSATION_ID = /^\d{13}-\d{19}-[0-9a-f]{8}$/u
const STAGES = [
  "claimed",
  "worktree_created",
  "manifest_claimed",
  "companion_started",
  "fx_started",
] as const

export type EnsureLifecycleStage = (typeof STAGES)[number]
type LiteralMessage<Shape, Type extends string> = Shape extends unknown
  ? Omit<Shape, "message_type"> & { message_type: Type }
  : never

export type EnsureRequest = LiteralMessage<
  Extract<EnsureLifecycleMessage, { planned_worktree: unknown }>,
  "ensure_request"
>
export type EnsureReceipt = LiteralMessage<
  Extract<EnsureLifecycleMessage, { effects: unknown }>,
  "ensure_receipt"
>
export type EnsureReceiptAcknowledgement = LiteralMessage<
  Extract<EnsureLifecycleMessage, { acknowledgement_id: unknown }>,
  "receipt_acknowledgement"
>

export type EnsureLifecycleEffects = EnsureReceipt["effects"]

export type EnsureLifecycleRecord = {
  schema_id: typeof LEDGER_SCHEMA_ID
  schema_version: typeof LEDGER_SCHEMA_VERSION
  revision: number
  request: EnsureRequest
  stage: EnsureLifecycleStage
  effects: EnsureLifecycleEffects
  receipts: EnsureReceipt[]
  acknowledgements: EnsureReceiptAcknowledgement[]
}

export type EnsureLifecycleTransition =
  | {
      kind: "worktree_created"
      directory: string
      head_commit: string
    }
  | {
      kind: "manifest_claimed"
      agent_id: string
    }
  | {
      kind: "companion_started"
      session_name: string
      pane_id: string
    }
  | {
      kind: "fx_started"
      conversation_id: string
    }

export type EnsureLifecycleLedgerFaultPoint =
  | "before_write"
  | "after_file_sync"
  | "before_rename"
  | "after_rename"
  | "after_directory_sync"

export type EnsureLifecycleLedgerOptions = {
  fault?: (
    point: EnsureLifecycleLedgerFaultPoint,
    record: Readonly<EnsureLifecycleRecord>,
  ) => void | Promise<void>
  uid?: number
  lockAttempts?: number
  lockDelayMs?: number
}

export type EnsureLifecycleLedgerErrorCode =
  | "acknowledgement_conflict"
  | "conflicting_claim"
  | "corrupt_record"
  | "invalid_acknowledgement"
  | "invalid_request"
  | "invalid_root"
  | "invalid_transition"
  | "lock_unavailable"
  | "receipt_conflict"
  | "unsafe_storage"

export class EnsureLifecycleLedgerError extends Error {
  constructor(
    readonly code: EnsureLifecycleLedgerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "EnsureLifecycleLedgerError"
  }
}

const worktreeEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("planned"), directory: z.string() }),
  z.strictObject({
    status: z.literal("created"),
    directory: z.string(),
    head_commit: z.string().regex(GIT_OBJECT_ID),
  }),
])

const manifestEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("claimed"), agent_id: z.string() }),
])

const companionEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    session_name: z.string(),
    pane_id: z.string(),
  }),
  z.strictObject({
    status: z.literal("started"),
    session_name: z.string(),
    pane_id: z.string(),
  }),
])

const fxEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("started"), conversation_id: z.string() }),
])

const privateRecordSchema = z.strictObject({
  schema_id: z.literal(LEDGER_SCHEMA_ID),
  schema_version: z.literal(LEDGER_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  request: ensureLifecycleMessageSchema,
  stage: z.enum(STAGES),
  effects: z.strictObject({
    worktree: worktreeEffectSchema,
    manifest: manifestEffectSchema,
    companion: companionEffectSchema,
    fx: fxEffectSchema,
  }),
  receipts: z.array(ensureLifecycleMessageSchema).max(4096),
  acknowledgements: z.array(ensureLifecycleMessageSchema).max(4096),
})

type RecordIndex = {
  byEnsureId: Map<string, EnsureLifecycleRecord>
  records: EnsureLifecycleRecord[]
}

/**
 * Private durable authority for one Runtime's recoverable ensure effects.
 *
 * This store deliberately does not extend the frozen public lifecycle wire.
 * It records only already-versioned request/receipt envelopes and opaque
 * effect facts. All mutations are serialized, flocked across store instances,
 * and made durable before their promises resolve.
 */
export class EnsureLifecycleLedger {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly uid: number
  private readonly fault: NonNullable<EnsureLifecycleLedgerOptions["fault"]> | null
  private readonly lockAttempts: number
  private readonly lockDelayMs: number

  private constructor(
    readonly root: string,
    options: EnsureLifecycleLedgerOptions,
  ) {
    this.uid = options.uid ?? userInfo().uid
    this.fault = options.fault ?? null
    this.lockAttempts = options.lockAttempts ?? 1000
    this.lockDelayMs = options.lockDelayMs ?? 2
  }

  static async open(
    root: string,
    options: EnsureLifecycleLedgerOptions = {},
  ): Promise<EnsureLifecycleLedger> {
    assertRootPath(root)
    const ledger = new EnsureLifecycleLedger(root, options)
    await ledger.serial(() => ledger.withLock(async () => {
      await ledger.readIndex()
    }))
    return ledger
  }

  claim(requestInput: EnsureRequest): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async () => {
      const request = parseEnsureRequest(requestInput)
      const index = await this.readIndex()
      const existing = index.byEnsureId.get(request.ensure_id)
      if (existing) {
        if (!sameEnsureClaim(existing.request, request)) {
          throw ledgerError(
            "conflicting_claim",
            `ensure id ${request.ensure_id} is already bound to a different immutable request`,
          )
        }
        return copyRecord(existing)
      }
      assertSecondaryClaimsAvailable(index.records, request)
      const record: EnsureLifecycleRecord = {
        schema_id: LEDGER_SCHEMA_ID,
        schema_version: LEDGER_SCHEMA_VERSION,
        revision: 1,
        request,
        stage: "claimed",
        effects: effectsForClaim(request),
        receipts: [],
        acknowledgements: [],
      }
      await this.writeRecord(record)
      return copyRecord(record)
    }))
  }

  get(ensureId: string): Promise<EnsureLifecycleRecord | null> {
    return this.serial(() => this.withLock(async () => {
      const record = (await this.readIndex()).byEnsureId.get(ensureId)
      return record ? copyRecord(record) : null
    }))
  }

  list(): Promise<EnsureLifecycleRecord[]> {
    return this.serial(() => this.withLock(async () =>
      (await this.readIndex()).records.map(copyRecord)))
  }

  advance(ensureId: string, transition: EnsureLifecycleTransition): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async () => {
      const index = await this.readIndex()
      const record = requireRecord(index, ensureId)
      const advanced = advanceRecord(record, transition)
      if (advanced === record) return copyRecord(record)
      await this.writeRecord(advanced)
      return copyRecord(advanced)
    }))
  }

  retainEnsureReceipt(receiptInput: EnsureReceipt): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async () => {
      const receipt = parseEnsureReceipt(receiptInput)
      const index = await this.readIndex()
      const record = requireRecord(index, receipt.ensure_id)
      const existing = record.receipts.find(({ receipt_id }) => receipt_id === receipt.receipt_id)
      if (existing) {
        if (!sameCanonical(existing, receipt)) {
          throw ledgerError(
            "receipt_conflict",
            `receipt id ${receipt.receipt_id} is already bound to different bytes`,
          )
        }
        return copyRecord(record)
      }
      assertReceiptCorrelation(record, receipt)
      for (const candidate of index.records) {
        if (candidate.receipts.some(({ receipt_id }) => receipt_id === receipt.receipt_id)) {
          throw ledgerError("receipt_conflict", `receipt id ${receipt.receipt_id} belongs to another ensure`)
        }
      }
      const next = copyRecord(record)
      next.revision++
      next.receipts.push(receipt)
      validateRecord(next, recordPathFor(this.root, receipt.ensure_id))
      await this.writeRecord(next)
      return copyRecord(next)
    }))
  }

  acknowledgeEnsureReceipt(
    acknowledgementInput: EnsureReceiptAcknowledgement,
  ): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async () => {
      const acknowledgement = parseEnsureAcknowledgement(acknowledgementInput)
      const index = await this.readIndex()
      const record = requireRecord(index, acknowledgement.ensure_id)
      const receipt = record.receipts.find(
        ({ receipt_id }) => receipt_id === acknowledgement.receipt_id,
      )
      if (!receipt || receipt.receipt_digest !== acknowledgement.receipt_digest) {
        throw ledgerError(
          "invalid_acknowledgement",
          `acknowledgement ${acknowledgement.acknowledgement_id} does not name an exact retained receipt`,
        )
      }
      const existing = record.acknowledgements.find(
        ({ acknowledgement_id }) => acknowledgement_id === acknowledgement.acknowledgement_id,
      )
      if (existing) {
        if (!sameCanonical(existing, acknowledgement)) {
          throw ledgerError(
            "acknowledgement_conflict",
            `acknowledgement id ${acknowledgement.acknowledgement_id} is already bound to different bytes`,
          )
        }
        return copyRecord(record)
      }
      const existingForReceipt = record.acknowledgements.find(
        ({ receipt_id }) => receipt_id === acknowledgement.receipt_id,
      )
      if (existingForReceipt) {
        throw ledgerError(
          "acknowledgement_conflict",
          `receipt ${acknowledgement.receipt_id} is already acknowledged by ${existingForReceipt.acknowledgement_id}`,
        )
      }
      for (const candidate of index.records) {
        if (candidate.acknowledgements.some(
          ({ acknowledgement_id }) => acknowledgement_id === acknowledgement.acknowledgement_id,
        )) {
          throw ledgerError(
            "acknowledgement_conflict",
            `acknowledgement id ${acknowledgement.acknowledgement_id} belongs to another ensure`,
          )
        }
      }
      const next = copyRecord(record)
      next.revision++
      next.acknowledgements.push(acknowledgement)
      validateRecord(next, recordPathFor(this.root, acknowledgement.ensure_id))
      await this.writeRecord(next)
      return copyRecord(next)
    }))
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await ensurePrivateRoot(this.root, this.uid)
    await ensureLockFile(this.root, this.uid)
    for (let attempt = 0; attempt < this.lockAttempts; attempt++) {
      const lock = acquireExclusiveLock(resolve(this.root, LOCK_FILE))
      if (lock === undefined) {
        throw ledgerError("lock_unavailable", "native flock is unavailable for the ensure ledger")
      }
      if (lock !== null) {
        try {
          await ensurePrivateRoot(this.root, this.uid)
          await assertSafeFile(resolve(this.root, LOCK_FILE), this.uid)
          return await operation()
        } finally {
          lock.release()
        }
      }
      await delay(this.lockDelayMs)
    }
    throw ledgerError("lock_unavailable", "the ensure ledger lock remained held")
  }

  private async readIndex(): Promise<RecordIndex> {
    const entries = await readdir(this.root, { withFileTypes: true })
    const records: EnsureLifecycleRecord[] = []
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
        throw ledgerError("corrupt_record", `foreign or unsafe entry in ensure ledger: ${path}`)
      }
      const record = await readRecord(path, this.uid)
      if (entry.name !== recordFileName(record.request.ensure_id)) {
        throw ledgerError("corrupt_record", `ensure ledger filename does not match ${record.request.ensure_id}`)
      }
      records.push(record)
    }
    validateIndex(records)
    for (const temporary of temporaries) {
      try {
        await unlink(temporary)
      } catch (error) {
        throw unsafeStorage(`cannot remove abandoned ensure ledger temporary ${temporary}`, error)
      }
    }
    // A prior process may have died after rename but before syncing the
    // directory. Re-sync even when no temporary remains so retry turns either
    // observable pre-rename or post-rename state into durable authority.
    await syncDirectory(this.root)
    return {
      byEnsureId: new Map(records.map((record) => [record.request.ensure_id, record])),
      records,
    }
  }

  private async writeRecord(record: EnsureLifecycleRecord): Promise<void> {
    validateRecord(record, recordPathFor(this.root, record.request.ensure_id))
    const canonical = encodeCanonicalJson(record as unknown as JsonValue)
    const bytes = Buffer.concat([Buffer.from(canonical), Buffer.from("\n")])
    if (bytes.byteLength > CONTRACT_MAX_FRAME_BYTES) {
      throw ledgerError("corrupt_record", "ensure ledger record exceeds the 1 MiB bound")
    }
    const target = recordPathFor(this.root, record.request.ensure_id)
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    await this.inject("before_write", record)
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
      assertSafeStats(temporary, temporaryIdentity, this.uid)
      await handle.sync()
      await this.inject("after_file_sync", record)
      await this.inject("before_rename", record)
      const pathnameIdentity = await assertSafeFile(temporary, this.uid)
      if (!sameFileIdentity(temporaryIdentity, pathnameIdentity)) {
        throw unsafeStorage(`${temporary} changed before its durable rename`)
      }
      await handle.close()
      handle = null
      await rename(temporary, target)
      renamed = true
      const renamedIdentity = await assertSafeFile(target, this.uid)
      if (!sameFileIdentity(temporaryIdentity, renamedIdentity)) {
        throw unsafeStorage(`${target} changed during its durable rename`)
      }
      await this.inject("after_rename", record)
      await syncDirectory(this.root)
      await this.inject("after_directory_sync", record)
    } finally {
      await handle?.close().catch(() => undefined)
      if (!renamed) await unlink(temporary).catch(() => undefined)
    }
  }

  private async inject(
    point: EnsureLifecycleLedgerFaultPoint,
    record: EnsureLifecycleRecord,
  ): Promise<void> {
    await this.fault?.(point, copyRecord(record))
  }
}

export function recordPathFor(root: string, ensureId: string): string {
  return resolve(root, recordFileName(ensureId))
}

export function deriveEnsureDigest(request: EnsureRequest): string {
  const specification = ensureSpecification(request)
  return createHash("sha256").update(encodeCanonicalJson(specification)).digest("hex")
}

function parseEnsureRequest(input: EnsureRequest): EnsureRequest {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    !("planned_worktree" in parsed.data) ||
    parsed.data.message_type !== "ensure_request"
  ) {
    throw ledgerError("invalid_request", "ensure claim is not a strict frozen ensure_request")
  }
  const request: EnsureRequest = {
    ...structuredClone(parsed.data),
    message_type: "ensure_request",
  }
  const derived = deriveEnsureDigest(request)
  if (derived !== request.ensure_digest) {
    throw ledgerError(
      "invalid_request",
      `ensure digest ${request.ensure_digest} does not match immutable request ${derived}`,
    )
  }
  return request
}

function parseEnsureReceipt(input: EnsureReceipt): EnsureReceipt {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    !("effects" in parsed.data) ||
    parsed.data.message_type !== "ensure_receipt"
  ) {
    throw ledgerError("receipt_conflict", "retained receipt is not a strict ensure_receipt")
  }
  const receipt: EnsureReceipt = {
    ...structuredClone(parsed.data),
    message_type: "ensure_receipt",
  }
  if (deriveReceiptDigest(receipt) !== receipt.receipt_digest) {
    throw ledgerError("receipt_conflict", `receipt ${receipt.receipt_id} has an invalid digest`)
  }
  return receipt
}

function parseEnsureAcknowledgement(
  input: EnsureReceiptAcknowledgement,
): EnsureReceiptAcknowledgement {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    !("acknowledgement_id" in parsed.data) ||
    parsed.data.message_type !== "receipt_acknowledgement" ||
    parsed.data.receipt_kind !== "ensure"
  ) {
    throw ledgerError(
      "invalid_acknowledgement",
      "ensure acknowledgement is not a strict ensure receipt acknowledgement",
    )
  }
  return {
    ...structuredClone(parsed.data),
    message_type: "receipt_acknowledgement",
  }
}

function ensureSpecification(request: EnsureRequest): JsonValue {
  return {
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    worktree_id: request.worktree_id,
    agent_id: request.agent_id,
    planned_worktree: structuredClone(request.planned_worktree),
    fx_conversation: structuredClone(request.fx_conversation),
  }
}

function deriveReceiptDigest(receipt: EnsureReceipt): string {
  const { receipt_digest: _receiptDigest, ...specification } = receipt
  return createHash("sha256")
    .update(encodeCanonicalJson(specification as unknown as JsonValue))
    .digest("hex")
}

function effectsForClaim(request: EnsureRequest): EnsureLifecycleEffects {
  const identity = identityFor(request.agent_id)
  return {
    worktree: { status: "planned", directory: request.planned_worktree.directory },
    manifest: { status: "pending" },
    companion: {
      status: "pending",
      session_name: identity.zmxName,
      pane_id: identity.paneId,
    },
    fx: { status: "pending" },
  }
}

function advanceRecord(
  record: EnsureLifecycleRecord,
  transition: EnsureLifecycleTransition,
): EnsureLifecycleRecord {
  const expectedIndex = STAGES.indexOf(record.stage) + 1
  const target = transition.kind
  const targetIndex = STAGES.indexOf(target)
  if (targetIndex < 1) throw ledgerError("invalid_transition", `unknown transition ${target}`)

  if (targetIndex <= STAGES.indexOf(record.stage)) {
    if (transitionMatches(record, transition)) return record
    throw ledgerError(
      "invalid_transition",
      `${transition.kind} conflicts with the durable ${record.stage} state`,
    )
  }
  if (targetIndex !== expectedIndex) {
    throw ledgerError(
      "invalid_transition",
      `cannot advance ensure ${record.request.ensure_id} from ${record.stage} to ${target}`,
    )
  }

  const next = copyRecord(record)
  next.revision++
  next.stage = target
  switch (transition.kind) {
    case "worktree_created":
      if (
        transition.directory !== record.request.planned_worktree.directory ||
        !GIT_OBJECT_ID.test(transition.head_commit)
      ) {
        throw ledgerError("invalid_transition", "created Worktree does not match the exact plan")
      }
      next.effects.worktree = {
        status: "created",
        directory: transition.directory,
        head_commit: transition.head_commit,
      }
      break
    case "manifest_claimed":
      if (transition.agent_id !== record.request.agent_id) {
        throw ledgerError("invalid_transition", "Manifest claim changed the planned Agent identity")
      }
      next.effects.manifest = { status: "claimed", agent_id: transition.agent_id }
      break
    case "companion_started":
      const identity = identityFor(record.request.agent_id)
      if (
        transition.session_name !== identity.zmxName ||
        transition.pane_id !== identity.paneId
      ) {
        throw ledgerError("invalid_transition", "Companion identity changed the planned Agent identity")
      }
      next.effects.companion = {
        status: "started",
        session_name: transition.session_name,
        pane_id: transition.pane_id,
      }
      break
    case "fx_started":
      if (!CONVERSATION_ID.test(transition.conversation_id)) {
        throw ledgerError("invalid_transition", "Fx start did not return a valid Conversation identity")
      }
      next.effects.fx = { status: "started", conversation_id: transition.conversation_id }
      break
  }
  validateRecord(next, `ensure ${record.request.ensure_id}`)
  return next
}

function transitionMatches(
  record: EnsureLifecycleRecord,
  transition: EnsureLifecycleTransition,
): boolean {
  switch (transition.kind) {
    case "worktree_created":
      return record.effects.worktree.status === "created" &&
        record.effects.worktree.directory === transition.directory &&
        record.effects.worktree.head_commit === transition.head_commit
    case "manifest_claimed":
      return record.effects.manifest.status === "claimed" &&
        record.effects.manifest.agent_id === transition.agent_id
    case "companion_started":
      return record.effects.companion.status === "started" &&
        record.effects.companion.session_name === transition.session_name &&
        record.effects.companion.pane_id === transition.pane_id
    case "fx_started":
      return record.effects.fx.status === "started" &&
        record.effects.fx.conversation_id === transition.conversation_id
  }
}

function assertReceiptCorrelation(record: EnsureLifecycleRecord, receipt: EnsureReceipt): void {
  const request = record.request
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
  ] as const) {
    if (receipt[field] !== request[field]) {
      throw ledgerError("receipt_conflict", `receipt ${receipt.receipt_id} changed ${field}`)
    }
  }
  if (!sameCanonical(receipt.effects, record.effects)) {
    throw ledgerError(
      "receipt_conflict",
      `receipt ${receipt.receipt_id} does not describe the current durable effects`,
    )
  }
  const expectedStatus = record.stage === "fx_started" ? "complete" : "in_progress"
  if (receipt.status !== expectedStatus) {
    throw ledgerError(
      "receipt_conflict",
      `receipt ${receipt.receipt_id} status does not match ${record.stage}`,
    )
  }
}

function validateRecord(record: EnsureLifecycleRecord, path: string): void {
  if (!privateRecordSchema.safeParse(record).success) {
    throw ledgerError("corrupt_record", `${path} is not a bounded private ensure ledger record`)
  }
  const request = parseEnsureRequest(record.request)
  if (request.ensure_id !== record.request.ensure_id) {
    throw ledgerError("corrupt_record", `${path} changed its ensure identity during parsing`)
  }
  validateStageEffects(record, path)
  const expectedRevision = 1 + STAGES.indexOf(record.stage) +
    record.receipts.length + record.acknowledgements.length
  if (record.revision !== expectedRevision) {
    throw ledgerError(
      "corrupt_record",
      `${path} has revision ${record.revision}; expected ${expectedRevision}`,
    )
  }
  const receiptIds = new Set<string>()
  for (const receiptInput of record.receipts) {
    const receipt = parseEnsureReceipt(receiptInput)
    if (receiptIds.has(receipt.receipt_id)) {
      throw ledgerError("corrupt_record", `${path} repeats receipt ${receipt.receipt_id}`)
    }
    receiptIds.add(receipt.receipt_id)
    assertHistoricalReceipt(record, receipt, path)
  }
  const acknowledgementIds = new Set<string>()
  for (const acknowledgementInput of record.acknowledgements) {
    const acknowledgement = parseEnsureAcknowledgement(acknowledgementInput)
    if (acknowledgementIds.has(acknowledgement.acknowledgement_id)) {
      throw ledgerError(
        "corrupt_record",
        `${path} repeats acknowledgement ${acknowledgement.acknowledgement_id}`,
      )
    }
    acknowledgementIds.add(acknowledgement.acknowledgement_id)
    const receipt = record.receipts.find(
      ({ receipt_id }) => receipt_id === acknowledgement.receipt_id,
    )
    if (
      acknowledgement.ensure_id !== record.request.ensure_id ||
      !receipt ||
      receipt.receipt_digest !== acknowledgement.receipt_digest
    ) {
      throw ledgerError("corrupt_record", `${path} contains an orphaned acknowledgement`)
    }
  }
}

function validateStageEffects(record: EnsureLifecycleRecord, path: string): void {
  const stageIndex = STAGES.indexOf(record.stage)
  const expected = effectsAtStage(record, record.stage)
  if (!sameCanonical(expected, record.effects)) {
    throw ledgerError("corrupt_record", `${path} effects do not match stage ${record.stage}`)
  }
  if (stageIndex < 0) throw ledgerError("corrupt_record", `${path} has an unknown stage`)
}

function assertHistoricalReceipt(
  record: EnsureLifecycleRecord,
  receipt: EnsureReceipt,
  path: string,
): void {
  const request = record.request
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
  ] as const) {
    if (receipt[field] !== request[field]) {
      throw ledgerError("corrupt_record", `${path} receipt changed ${field}`)
    }
  }
  const receiptStage = stageForEffects(record, receipt.effects)
  if (receiptStage === null || STAGES.indexOf(receiptStage) > STAGES.indexOf(record.stage)) {
    throw ledgerError("corrupt_record", `${path} receipt contains impossible effects`)
  }
  const expectedStatus = receiptStage === "fx_started" ? "complete" : "in_progress"
  if (receipt.status !== expectedStatus) {
    throw ledgerError("corrupt_record", `${path} receipt status conflicts with its effects`)
  }
}

function stageForEffects(
  record: EnsureLifecycleRecord,
  effects: EnsureLifecycleEffects,
): EnsureLifecycleStage | null {
  for (const stage of STAGES) {
    if (sameCanonical(effectsAtStage(record, stage), effects)) return stage
  }
  return null
}

function effectsAtStage(
  record: EnsureLifecycleRecord,
  stage: EnsureLifecycleStage,
): EnsureLifecycleEffects {
  const index = STAGES.indexOf(stage)
  const claimed = effectsForClaim(record.request)
  const worktree = record.effects.worktree.status === "created"
    ? structuredClone(record.effects.worktree)
    : null
  const manifest = record.effects.manifest.status === "claimed"
    ? structuredClone(record.effects.manifest)
    : null
  const companion = record.effects.companion.status === "started"
    ? structuredClone(record.effects.companion)
    : null
  const fx = record.effects.fx.status === "started" ? structuredClone(record.effects.fx) : null
  return {
    worktree: index >= 1 && worktree ? worktree : claimed.worktree,
    manifest: index >= 2 && manifest ? manifest : claimed.manifest,
    companion: index >= 3 && companion ? companion : claimed.companion,
    fx: index >= 4 && fx ? fx : claimed.fx,
  }
}

function validateIndex(records: EnsureLifecycleRecord[]): void {
  const ensureIds = new Set<string>()
  const requestIds = new Set<string>()
  const launchIds = new Set<string>()
  const worktreeIds = new Set<string>()
  const agentIds = new Set<string>()
  const directories = new Set<string>()
  const receiptIds = new Set<string>()
  const acknowledgementIds = new Set<string>()
  for (const record of records) {
    const request = record.request
    assertUnique(ensureIds, request.ensure_id, "ensure id")
    assertUnique(requestIds, request.request_id, "request id")
    assertUnique(launchIds, request.launch_id, "launch id")
    assertUnique(worktreeIds, request.worktree_id, "Worktree id")
    assertUnique(agentIds, request.agent_id, "Agent id")
    assertUnique(directories, request.planned_worktree.directory, "Worktree directory")
    for (const receipt of record.receipts) assertUnique(receiptIds, receipt.receipt_id, "receipt id")
    for (const acknowledgement of record.acknowledgements) {
      assertUnique(
        acknowledgementIds,
        acknowledgement.acknowledgement_id,
        "acknowledgement id",
      )
    }
  }
}

function assertSecondaryClaimsAvailable(
  records: EnsureLifecycleRecord[],
  request: EnsureRequest,
): void {
  for (const record of records) {
    const existing = record.request
    for (const [label, left, right] of [
      ["request id", existing.request_id, request.request_id],
      ["launch id", existing.launch_id, request.launch_id],
      ["Worktree id", existing.worktree_id, request.worktree_id],
      ["Agent id", existing.agent_id, request.agent_id],
      ["Worktree directory", existing.planned_worktree.directory, request.planned_worktree.directory],
    ] as const) {
      if (left === right) {
        throw ledgerError(
          "conflicting_claim",
          `${label} ${right} is already bound to ensure ${existing.ensure_id}`,
        )
      }
    }
  }
}

function assertUnique(values: Set<string>, value: string, label: string): void {
  if (values.has(value)) throw ledgerError("corrupt_record", `ensure ledger repeats ${label} ${value}`)
  values.add(value)
}

function requireRecord(index: RecordIndex, ensureId: string): EnsureLifecycleRecord {
  const record = index.byEnsureId.get(ensureId)
  if (!record) throw ledgerError("conflicting_claim", `unknown ensure id ${ensureId}`)
  return record
}

async function readRecord(path: string, uid: number): Promise<EnsureLifecycleRecord> {
  const { bytes, initial } = await readSafeFile(path, uid)
  try {
    if (bytes.byteLength < 2 || bytes[bytes.byteLength - 1] !== 0x0a) {
      throw ledgerError("corrupt_record", `${path} is not one canonical JSON line`)
    }
    const payload = bytes.subarray(0, bytes.byteLength - 1)
    const value = decodeStrictJson(payload)
    const canonical = encodeCanonicalJson(value)
    if (!Buffer.from(canonical).equals(payload)) {
      throw ledgerError("corrupt_record", `${path} is not canonical JSON`)
    }
    const parsed = privateRecordSchema.safeParse(value)
    if (!parsed.success) {
      throw ledgerError("corrupt_record", `${path} is not a valid private ensure ledger record`)
    }
    if (
      !("planned_worktree" in parsed.data.request) ||
      parsed.data.request.message_type !== "ensure_request"
    ) {
      throw ledgerError("corrupt_record", `${path} does not retain an ensure request`)
    }
    const receipts: EnsureReceipt[] = []
    for (const message of parsed.data.receipts) {
      if (!("effects" in message) || message.message_type !== "ensure_receipt") {
        throw ledgerError("corrupt_record", `${path} retains a non-ensure receipt`)
      }
      receipts.push({ ...message, message_type: "ensure_receipt" })
    }
    const acknowledgements: EnsureReceiptAcknowledgement[] = []
    for (const message of parsed.data.acknowledgements) {
      if (
        !("acknowledgement_id" in message) ||
        message.message_type !== "receipt_acknowledgement" ||
        message.receipt_kind !== "ensure"
      ) {
        throw ledgerError("corrupt_record", `${path} retains a non-ensure acknowledgement`)
      }
      acknowledgements.push({ ...message, message_type: "receipt_acknowledgement" })
    }
    const record: EnsureLifecycleRecord = {
      schema_id: LEDGER_SCHEMA_ID,
      schema_version: LEDGER_SCHEMA_VERSION,
      revision: parsed.data.revision,
      request: { ...parsed.data.request, message_type: "ensure_request" },
      stage: parsed.data.stage,
      effects: parsed.data.effects,
      receipts,
      acknowledgements,
    }
    validateRecord(record, path)
    if (initial.size !== bytes.byteLength) {
      throw ledgerError("corrupt_record", `${path} changed while being read`)
    }
    return record
  } catch (error) {
    if (error instanceof EnsureLifecycleLedgerError && error.code === "corrupt_record") throw error
    const wrapped = ledgerError("corrupt_record", `${path} could not be decoded as a private ensure record`)
    wrapped.cause = error
    throw wrapped
  }
}

async function readSafeFile(path: string, uid: number): Promise<{ bytes: Buffer; initial: Stats }> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw unsafeStorage(`${path} could not be opened without following links`, error)
  }
  try {
    const initial = await handle.stat()
    assertSafeStats(path, initial, uid)
    if (initial.size < 1 || initial.size > CONTRACT_MAX_FRAME_BYTES) {
      throw ledgerError("corrupt_record", `${path} has unsafe size ${initial.size}`)
    }
    const bytes = Buffer.alloc(initial.size + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const final = await handle.stat()
    if (
      offset !== initial.size ||
      !sameFileIdentity(initial, final) ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      throw ledgerError("corrupt_record", `${path} changed while being read`)
    }
    return { bytes: bytes.subarray(0, offset), initial }
  } finally {
    await handle.close()
  }
}

async function ensurePrivateRoot(root: string, uid: number): Promise<void> {
  let existed = true
  try {
    await lstat(root)
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw unsafeStorage(`cannot inspect ledger root ${root}`, error)
    existed = false
    await mkdir(root, { recursive: true, mode: 0o700 })
  }
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw unsafeStorage(`ensure ledger root ${root} is not a real directory`)
  }
  if (info.uid !== uid || (info.mode & 0o777) !== 0o700) {
    throw unsafeStorage(`ensure ledger root ${root} must be owned by uid ${uid} with mode 0700`)
  }
  if (await realpath(root) !== root) {
    throw unsafeStorage(`ensure ledger root ${root} crosses a symbolic link`)
  }
  if (!existed) await syncDirectory(dirname(root))
}

async function ensureLockFile(root: string, uid: number): Promise<void> {
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
    if (!isErrno(error, "EEXIST")) throw unsafeStorage(`cannot create ensure ledger lock ${path}`, error)
  } finally {
    await handle?.close()
  }
  await assertSafeFile(path, uid)
  if (created) await syncDirectory(root)
}

async function assertSafeFile(path: string, uid: number): Promise<Stats> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw unsafeStorage(`${path} could not be opened without following links`, error)
  }
  try {
    const info = await handle.stat()
    assertSafeStats(path, info, uid)
    return info
  } finally {
    await handle.close()
  }
}

function assertSafeStats(path: string, info: Stats, uid: number): void {
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
    throw unsafeStorage(`${path} must be one uid-${uid} regular file with mode 0600`)
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

function assertRootPath(root: string): void {
  if (!isAbsolute(root) || root === "/" || resolve(root) !== root || root.includes("\0")) {
    throw ledgerError("invalid_root", `ensure ledger root must be one normalized absolute directory: ${root}`)
  }
}

function recordFileName(ensureId: string): string {
  return `${createHash("sha256").update(ensureId).digest("hex")}.json`
}

function sameEnsureClaim(left: EnsureRequest, right: EnsureRequest): boolean {
  return sameCanonical(left, right)
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalJson(left as JsonValue))
    .equals(Buffer.from(encodeCanonicalJson(right as JsonValue)))
}

function copyRecord(record: EnsureLifecycleRecord): EnsureLifecycleRecord {
  return structuredClone(record)
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.nlink === right.nlink
}

function ledgerError(
  code: EnsureLifecycleLedgerErrorCode,
  message: string,
): EnsureLifecycleLedgerError {
  return new EnsureLifecycleLedgerError(code, message)
}

function unsafeStorage(message: string, cause?: unknown): EnsureLifecycleLedgerError {
  const error = ledgerError("unsafe_storage", message)
  if (cause !== undefined) error.cause = cause
  return error
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}
