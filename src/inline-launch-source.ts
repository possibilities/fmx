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
  fxLaunchAdmissionFinalMessageSchema,
  type EnsureLifecycleMessage,
  type FxLaunchAdmissionFinalMessage,
} from "./agentworkplace-contracts.ts"
import {
  CONTRACT_FRAME_HEADER_BYTES,
  CONTRACT_MAX_FRAME_BYTES,
  decodeStrictJson,
  encodeCanonicalJson,
  type JsonValue,
} from "./contract-codec.ts"
import { acquireExclusiveLock, type HeldLock } from "./file-lock.ts"

export const INLINE_LAUNCH_SOURCE_SCHEMA_ID = "fmx.inline-launch-source"
export const INLINE_LAUNCH_SOURCE_SCHEMA_VERSION = 2
export const INLINE_INITIAL_WORK_MAX_BYTES = 512 * 1024
export const INLINE_LAUNCH_CONTROLS_MAX_BYTES = 128 * 1024
export const INLINE_SOURCE_COMBINED_MAX_BYTES = 640 * 1024

const LEDGER_SCHEMA_ID = "fmx.inline-launch-source-ledger"
const LEDGER_SCHEMA_VERSION = 1
const LOCK_FILE = ".inline-launch-source.lock"
const RECORD_FILE = /^[0-9a-f]{64}\.json$/u
const TEMPORARY_FILE = /^[0-9a-f]{64}\.json\.[0-9]+\.[0-9a-f]{16}\.tmp$/u
const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u
const FMX_SESSION = /^(?:default|[a-z][a-z0-9_-]{0,31})$/u
const AGENT_ID = /^[0-9a-f]{32}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

type LiteralMessage<Shape, Type extends string> = Shape extends unknown
  ? Omit<Shape, "message_type"> & { message_type: Type }
  : never

export type FrozenLaunchRequest = LiteralMessage<
  Extract<FxLaunchAdmissionFinalMessage, { initial_work_digest: unknown }>,
  "launch_request"
>
export type FrozenEnsureRequest = LiteralMessage<
  Extract<EnsureLifecycleMessage, { planned_worktree: unknown }>,
  "ensure_request"
>

const inlineBytesSchema = z.strictObject({
  encoding: z.literal("base64"),
  data: z.string().max(Math.ceil(INLINE_INITIAL_WORK_MAX_BYTES / 3) * 4),
  byte_length: z.number().int().nonnegative().max(INLINE_INITIAL_WORK_MAX_BYTES),
  sha256: z.string().regex(SHA256),
})

/**
 * A separately-versioned, implementation-private request. It intentionally is
 * not part of the frozen public AgentWorkplace v1 union.
 */
export const inlineLaunchSourceRequestSchema = z.strictObject({
  schema_id: z.literal(INLINE_LAUNCH_SOURCE_SCHEMA_ID),
  schema_version: z.literal(INLINE_LAUNCH_SOURCE_SCHEMA_VERSION),
  message_type: z.literal("source_request"),
  request_id: z.string().regex(SAFE_TOKEN),
  workplace_instance_id: z.string().regex(SAFE_TOKEN),
  fmx_session: z.string().regex(FMX_SESSION),
  ensure_id: z.string().regex(SAFE_TOKEN),
  ensure_digest: z.string().regex(SHA256),
  worktree_id: z.string().regex(SAFE_TOKEN),
  agent_id: z.string().regex(AGENT_ID),
  launch_id: z.string().regex(SAFE_TOKEN),
  launch_digest: z.string().regex(SHA256),
  admission_key: z.string().regex(SAFE_TOKEN),
  source_id: z.string().regex(SAFE_TOKEN),
  source_digest: z.string().regex(SHA256),
  launch_request: fxLaunchAdmissionFinalMessageSchema,
  initial_work: inlineBytesSchema,
  launch_controls: inlineBytesSchema.extend({
    byte_length: z.number().int().nonnegative().max(INLINE_LAUNCH_CONTROLS_MAX_BYTES),
    data: z.string().max(Math.ceil(INLINE_LAUNCH_CONTROLS_MAX_BYTES / 3) * 4),
  }),
})

export type InlineLaunchSourceRequest = z.infer<typeof inlineLaunchSourceRequestSchema> & {
  launch_request: FrozenLaunchRequest
}

export type InlineLaunchSourceAuthorityKey = Pick<
  InlineLaunchSourceRequest,
  | "workplace_instance_id"
  | "fmx_session"
  | "ensure_id"
  | "ensure_digest"
  | "worktree_id"
  | "agent_id"
  | "launch_id"
  | "launch_digest"
  | "admission_key"
  | "source_id"
  | "source_digest"
>

export type InlineLaunchSourceRecord = {
  schema_id: typeof LEDGER_SCHEMA_ID
  schema_version: typeof LEDGER_SCHEMA_VERSION
  revision: 1 | 2
  request: InlineLaunchSourceRequest
  bound_ensure_request: FrozenEnsureRequest | null
}

export type InlineLaunchSourceBytes = {
  initialWork: Uint8Array
  launchControls: Uint8Array
}

export type InlineLaunchSourceMetadata = InlineLaunchSourceAuthorityKey & {
  initial_work_byte_length: number
  initial_work_sha256: string
  launch_controls_byte_length: number
  launch_controls_sha256: string
  ensure_bound: boolean
}

export type InlineLaunchSourceFaultPoint =
  | "before_write"
  | "after_file_sync"
  | "before_rename"
  | "after_rename"
  | "after_directory_sync"
  | "after_commit_before_return"

export type InlineLaunchSourceOptions = {
  fault?: (
    point: InlineLaunchSourceFaultPoint,
    operation: "claim" | "bind_ensure",
    record: Readonly<InlineLaunchSourceRecord>,
  ) => void | Promise<void>
  uid?: number
  lockAttempts?: number
  lockDelayMs?: number
}

export type InlineLaunchSourceErrorCode =
  | "conflicting_claim"
  | "correlation_mismatch"
  | "corrupt_record"
  | "invalid_request"
  | "invalid_root"
  | "lock_unavailable"
  | "unauthorized"
  | "unsafe_storage"

export class InlineLaunchSourceError extends Error {
  constructor(
    readonly code: InlineLaunchSourceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "InlineLaunchSourceError"
  }
}

const privateRecordSchema = z.strictObject({
  schema_id: z.literal(LEDGER_SCHEMA_ID),
  schema_version: z.literal(LEDGER_SCHEMA_VERSION),
  revision: z.union([z.literal(1), z.literal(2)]),
  request: inlineLaunchSourceRequestSchema,
  bound_ensure_request: ensureLifecycleMessageSchema.nullable(),
})

type StorageGuard = {
  directory: FileHandle
  lock: HeldLock
  lockIdentity: Stats
  rootIdentity: Stats
}

type RecordIndex = {
  records: InlineLaunchSourceRecord[]
  bySourceId: Map<string, InlineLaunchSourceRecord>
  identities: Map<string, Stats>
}

/** Durable byte authority for one exact inline-v2 launch source. */
export class InlineLaunchSourceLedger {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly uid: number
  private readonly fault: NonNullable<InlineLaunchSourceOptions["fault"]> | null
  private readonly lockAttempts: number
  private readonly lockDelayMs: number

  private constructor(
    readonly root: string,
    options: InlineLaunchSourceOptions,
  ) {
    this.uid = options.uid ?? userInfo().uid
    this.fault = options.fault ?? null
    this.lockAttempts = options.lockAttempts ?? 1_000
    this.lockDelayMs = options.lockDelayMs ?? 1
  }

  static async open(
    root: string,
    options: InlineLaunchSourceOptions = {},
  ): Promise<InlineLaunchSourceLedger> {
    assertRootPath(root)
    const ledger = new InlineLaunchSourceLedger(root, options)
    await ledger.serial(() => ledger.withLock(async (guard) => {
      await ledger.readIndex(guard)
    }))
    return ledger
  }

  /** Claim and durably snapshot the exact bytes before any launch effect. */
  claim(input: InlineLaunchSourceRequest): Promise<InlineLaunchSourceRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const request = parseInlineLaunchSourceRequest(input)
      const index = await this.readIndex(guard)
      const existing = index.bySourceId.get(request.source_id)
      if (existing !== undefined) {
        if (!sameCanonical(existing.request, request)) {
          throw sourceError(
            "conflicting_claim",
            `source id ${request.source_id} is already bound to different request bytes`,
          )
        }
        await this.inject("after_commit_before_return", "claim", existing)
        return copyRecord(existing)
      }
      assertSecondaryClaimsAvailable(index.records, request)
      const record: InlineLaunchSourceRecord = {
        schema_id: LEDGER_SCHEMA_ID,
        schema_version: LEDGER_SCHEMA_VERSION,
        revision: 1,
        request,
        bound_ensure_request: null,
      }
      validateRecord(record, recordPathFor(this.root, request.source_id))
      await this.writeRecord(record, guard, null, "claim")
      await this.inject("after_commit_before_return", "claim", record)
      return copyRecord(record)
    }))
  }

  /**
   * Bind the later frozen ensure request to the already-durable source. The
   * prompt bytes stay solely in this ledger; the Manifest needs only its
   * existing ensure/launch correlation.
   */
  bindEnsureRequest(
    authorityInput: InlineLaunchSourceAuthorityKey,
    ensureInput: FrozenEnsureRequest,
  ): Promise<InlineLaunchSourceRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const authority = parseAuthority(authorityInput)
      const ensureRequest = parseFrozenEnsureRequest(ensureInput)
      const index = await this.readIndex(guard)
      const record = requireAuthorizedRecord(index, authority)
      assertEnsureCorrelation(record.request, ensureRequest)
      if (record.bound_ensure_request !== null) {
        if (!sameCanonical(record.bound_ensure_request, ensureRequest)) {
          throw sourceError(
            "conflicting_claim",
            `source ${authority.source_id} is already bound to another ensure request`,
          )
        }
        await this.inject("after_commit_before_return", "bind_ensure", record)
        return copyRecord(record)
      }
      const next = copyRecord(record)
      next.revision = 2
      next.bound_ensure_request = ensureRequest
      validateRecord(next, recordPathFor(this.root, authority.source_id))
      await this.writeRecord(
        next,
        guard,
        requireRecordIdentity(index, authority.source_id),
        "bind_ensure",
      )
      await this.inject("after_commit_before_return", "bind_ensure", next)
      return copyRecord(next)
    }))
  }

  /** Return decoded bytes only to a caller presenting the complete authority. */
  retrieve(authorityInput: InlineLaunchSourceAuthorityKey): Promise<InlineLaunchSourceBytes> {
    return this.serial(() => this.withLock(async (guard) => {
      const authority = parseAuthority(authorityInput)
      const record = requireAuthorizedRecord(await this.readIndex(guard), authority)
      return {
        initialWork: decodeCanonicalBase64(record.request.initial_work.data),
        launchControls: decodeCanonicalBase64(record.request.launch_controls.data),
      }
    }))
  }

  /** Inspect non-content facts, still requiring the complete exact authority. */
  inspect(authorityInput: InlineLaunchSourceAuthorityKey): Promise<InlineLaunchSourceMetadata> {
    return this.serial(() => this.withLock(async (guard) => {
      const authority = parseAuthority(authorityInput)
      const record = requireAuthorizedRecord(await this.readIndex(guard), authority)
      return {
        ...authorityFor(record.request),
        initial_work_byte_length: record.request.initial_work.byte_length,
        initial_work_sha256: record.request.initial_work.sha256,
        launch_controls_byte_length: record.request.launch_controls.byte_length,
        launch_controls_sha256: record.request.launch_controls.sha256,
        ensure_bound: record.bound_ensure_request !== null,
      }
    }))
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async withLock<T>(operation: (guard: StorageGuard) => Promise<T>): Promise<T> {
    const expectedRoot = await ensurePrivateRoot(this.root, this.uid)
    const expectedLock = await ensureLockFile(this.root, this.uid)
    for (let attempt = 0; attempt < this.lockAttempts; attempt++) {
      const lock = acquireExclusiveLock(resolve(this.root, LOCK_FILE), {
        create: false,
        noFollow: true,
      })
      if (lock === undefined) {
        throw sourceError("lock_unavailable", "native flock is unavailable for the source ledger")
      }
      if (lock !== null) {
        let directory: FileHandle | null = null
        try {
          const lockedIdentity = fstatSync(lock.descriptor)
          assertSafeStats(resolve(this.root, LOCK_FILE), lockedIdentity, this.uid)
          if (!sameFileIdentity(expectedLock, lockedIdentity)) {
            throw unsafeStorage("source ledger lock changed before it was acquired")
          }
          directory = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
          const directoryIdentity = await directory.stat()
          assertSafeRootStats(this.root, directoryIdentity, this.uid)
          if (!sameRootIdentity(expectedRoot, directoryIdentity)) {
            throw unsafeStorage("source ledger root changed before its lock was acquired")
          }
          const guard = {
            directory,
            lock,
            lockIdentity: lockedIdentity,
            rootIdentity: directoryIdentity,
          }
          await assertStorageGuard(this.root, guard, this.uid)
          const result = await operation(guard)
          await assertStorageGuard(this.root, guard, this.uid)
          return result
        } finally {
          lock.release()
          await directory?.close().catch(() => undefined)
        }
      }
      await delay(this.lockDelayMs)
    }
    throw sourceError("lock_unavailable", "the source ledger lock remained held")
  }

  private async readIndex(guard: StorageGuard): Promise<RecordIndex> {
    await assertStorageGuard(this.root, guard, this.uid)
    const entries = await readdir(this.root, { withFileTypes: true })
    const records: InlineLaunchSourceRecord[] = []
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
        throw sourceError("corrupt_record", `foreign or unsafe entry in source ledger: ${path}`)
      }
      await assertStorageGuard(this.root, guard, this.uid)
      const { identity, record } = await readRecord(path, this.uid)
      if (entry.name !== recordFileName(record.request.source_id)) {
        throw sourceError("corrupt_record", `source ledger filename does not match its source identity`)
      }
      records.push(record)
      identities.set(record.request.source_id, identity)
    }
    validateIndex(records)
    for (const temporary of temporaries) {
      await assertStorageGuard(this.root, guard, this.uid)
      try {
        await unlink(temporary)
      } catch (error) {
        throw unsafeStorage(`cannot remove abandoned source ledger temporary ${temporary}`, error)
      }
    }
    await guard.directory.sync()
    await assertStorageGuard(this.root, guard, this.uid)
    return {
      records,
      bySourceId: new Map(records.map((record) => [record.request.source_id, record])),
      identities,
    }
  }

  private async writeRecord(
    record: InlineLaunchSourceRecord,
    guard: StorageGuard,
    expectedTarget: Stats | null,
    operation: "claim" | "bind_ensure",
  ): Promise<void> {
    await assertStorageGuard(this.root, guard, this.uid)
    validateRecord(record, recordPathFor(this.root, record.request.source_id))
    const canonical = encodeCanonicalJson(record as unknown as JsonValue)
    const bytes = Buffer.concat([Buffer.from(canonical), Buffer.from("\n")])
    if (bytes.byteLength > CONTRACT_MAX_FRAME_BYTES) {
      throw sourceError("invalid_request", "source ledger record exceeds the 1 MiB bound")
    }
    const target = recordPathFor(this.root, record.request.source_id)
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    await this.inject("before_write", operation, record)
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
      assertSafeStats(temporary, temporaryIdentity, this.uid)
      await handle.sync()
      await this.inject("after_file_sync", operation, record)
      await assertStorageGuard(this.root, guard, this.uid)
      await this.inject("before_rename", operation, record)
      await assertTargetSnapshot(target, expectedTarget, this.uid)
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
      await this.inject("after_rename", operation, record)
      await assertStorageGuard(this.root, guard, this.uid)
      await guard.directory.sync()
      await this.inject("after_directory_sync", operation, record)
      await assertStorageGuard(this.root, guard, this.uid)
    } finally {
      await handle?.close().catch(() => undefined)
      if (!renamed) await unlink(temporary).catch(() => undefined)
    }
  }

  private async inject(
    point: InlineLaunchSourceFaultPoint,
    operation: "claim" | "bind_ensure",
    record: InlineLaunchSourceRecord,
  ): Promise<void> {
    await this.fault?.(point, operation, copyRecord(record))
  }
}

export function parseInlineLaunchSourceRequest(input: unknown): InlineLaunchSourceRequest {
  const parsed = inlineLaunchSourceRequestSchema.safeParse(input)
  if (
    !parsed.success ||
    parsed.data.launch_request.message_type !== "launch_request" ||
    !("initial_work_digest" in parsed.data.launch_request)
  ) {
    throw sourceError("invalid_request", "inline source is not one strict source_request")
  }
  const request = structuredClone(parsed.data) as InlineLaunchSourceRequest
  validateSourceRequest(request)
  return request
}

export function deriveInlineLaunchSourceDigest(request: InlineLaunchSourceRequest): string {
  return sha256(encodeCanonicalJson({
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    ensure_digest: request.ensure_digest,
    worktree_id: request.worktree_id,
    agent_id: request.agent_id,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    admission_key: request.admission_key,
    source_id: request.source_id,
    launch_request: structuredClone(request.launch_request),
    initial_work: structuredClone(request.initial_work),
    launch_controls: structuredClone(request.launch_controls),
  }))
}

export function deriveFrozenLaunchDigest(request: FrozenLaunchRequest): string {
  const specification: Record<string, JsonValue> = {
    admission_key: request.admission_key,
    conversation_name: request.conversation_name,
    directory: request.directory,
  }
  if (request.effort !== undefined) specification.effort = request.effort
  specification.initial_work_digest = request.initial_work_digest
  specification.launch_id = request.launch_id
  if (request.model !== undefined) specification.model = request.model
  specification.remaining_launch_controls_digest = request.remaining_launch_controls_digest
  specification.resume = structuredClone(request.resume)
  specification.state_root = request.state_root
  return sha256(encodeCanonicalJson(specification))
}

export function encodeInlineSourceBytes(bytes: Uint8Array): {
  encoding: "base64"
  data: string
  byte_length: number
  sha256: string
} {
  return {
    encoding: "base64",
    data: Buffer.from(bytes).toString("base64"),
    byte_length: bytes.byteLength,
    sha256: sha256(bytes),
  }
}

export function authorityFor(request: InlineLaunchSourceRequest): InlineLaunchSourceAuthorityKey {
  return {
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    ensure_digest: request.ensure_digest,
    worktree_id: request.worktree_id,
    agent_id: request.agent_id,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    admission_key: request.admission_key,
    source_id: request.source_id,
    source_digest: request.source_digest,
  }
}

export function inlineLaunchSourceRecordPath(root: string, sourceId: string): string {
  return recordPathFor(root, sourceId)
}

function validateSourceRequest(request: InlineLaunchSourceRequest): void {
  const launch = request.launch_request
  if (
    launch.launch_id !== request.launch_id ||
    launch.launch_digest !== request.launch_digest ||
    launch.admission_key !== request.admission_key
  ) {
    throw sourceError("correlation_mismatch", "inline source changed frozen launch correlation")
  }
  if (deriveFrozenLaunchDigest(launch) !== launch.launch_digest) {
    throw sourceError("invalid_request", "frozen launch request has an invalid launch digest")
  }
  const initialWork = validateInlineBytes(
    request.initial_work,
    INLINE_INITIAL_WORK_MAX_BYTES,
    "initial work",
  )
  if (launch.initial_work_digest !== request.initial_work.sha256) {
    throw sourceError("correlation_mismatch", "initial-work digest does not match frozen launch request")
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(initialWork)
  } catch {
    throw sourceError("invalid_request", "initial work is not valid UTF-8")
  }
  if (initialWork.includes(0)) {
    throw sourceError("invalid_request", "initial work contains a NUL byte")
  }
  const launchControls = validateInlineBytes(
    request.launch_controls,
    INLINE_LAUNCH_CONTROLS_MAX_BYTES,
    "launch controls",
  )
  if (launch.remaining_launch_controls_digest !== request.launch_controls.sha256) {
    throw sourceError("correlation_mismatch", "launch-controls digest does not match frozen launch request")
  }
  let controlsValue: JsonValue
  try {
    controlsValue = decodeStrictJson(launchControls)
  } catch {
    throw sourceError("invalid_request", "launch controls are not strict UTF-8 JSON")
  }
  if (!Buffer.from(encodeCanonicalJson(controlsValue)).equals(Buffer.from(launchControls))) {
    throw sourceError("invalid_request", "launch controls are not exact canonical JSON bytes")
  }
  if (initialWork.byteLength + launchControls.byteLength > INLINE_SOURCE_COMBINED_MAX_BYTES) {
    throw sourceError("invalid_request", "inline source exceeds the 640 KiB combined byte bound")
  }
  if (deriveInlineLaunchSourceDigest(request) !== request.source_digest) {
    throw sourceError("invalid_request", "inline source has an invalid source digest")
  }
  const payload = encodeCanonicalJson(request as unknown as JsonValue)
  if (payload.byteLength + CONTRACT_FRAME_HEADER_BYTES > CONTRACT_MAX_FRAME_BYTES) {
    throw sourceError("invalid_request", "complete inline source frame exceeds the 1 MiB bound")
  }
}

function validateInlineBytes(
  input: { data: string; byte_length: number; sha256: string },
  maximum: number,
  label: string,
): Uint8Array {
  if (!CANONICAL_BASE64.test(input.data)) {
    throw sourceError("invalid_request", `${label} is not canonical base64`)
  }
  const decoded = decodeCanonicalBase64(input.data)
  if (decoded.byteLength !== input.byte_length || decoded.byteLength > maximum) {
    throw sourceError("invalid_request", `${label} byte length does not match its bounded bytes`)
  }
  if (sha256(decoded) !== input.sha256) {
    throw sourceError("invalid_request", `${label} SHA-256 does not match its bytes`)
  }
  return decoded
}

function decodeCanonicalBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, "base64")
  if (decoded.toString("base64") !== data) {
    throw sourceError("invalid_request", "inline bytes are not canonical base64")
  }
  return new Uint8Array(decoded)
}

function parseFrozenEnsureRequest(input: unknown): FrozenEnsureRequest {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    parsed.data.message_type !== "ensure_request" ||
    !("planned_worktree" in parsed.data)
  ) {
    throw sourceError("invalid_request", "source binding is not one strict frozen ensure_request")
  }
  const request = structuredClone(parsed.data) as FrozenEnsureRequest
  if (deriveFrozenEnsureDigest(request) !== request.ensure_digest) {
    throw sourceError("invalid_request", "frozen ensure request has an invalid ensure digest")
  }
  return request
}

function deriveFrozenEnsureDigest(request: FrozenEnsureRequest): string {
  return sha256(encodeCanonicalJson({
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    worktree_id: request.worktree_id,
    agent_id: request.agent_id,
    planned_worktree: structuredClone(request.planned_worktree),
    fx_conversation: structuredClone(request.fx_conversation),
  }))
}

function assertEnsureCorrelation(
  source: InlineLaunchSourceRequest,
  ensure: FrozenEnsureRequest,
): void {
  for (const field of [
    "workplace_instance_id",
    "fmx_session",
    "ensure_id",
    "ensure_digest",
    "worktree_id",
    "agent_id",
    "launch_id",
    "launch_digest",
  ] as const) {
    if (source[field] !== ensure[field]) {
      throw sourceError("correlation_mismatch", `frozen ensure request changed ${field}`)
    }
  }
  const launch = source.launch_request
  const expectedResume = launch.resume.mode === "exact" ? launch.resume.conversation_id : null
  if (
    ensure.planned_worktree.directory !== launch.directory ||
    ensure.fx_conversation.name !== launch.conversation_name ||
    ensure.fx_conversation.resume_conversation_id !== expectedResume
  ) {
    throw sourceError("correlation_mismatch", "frozen ensure request changed launch target identity")
  }
}

function validateRecord(record: InlineLaunchSourceRecord, path: string): void {
  const parsed = privateRecordSchema.safeParse(record)
  if (!parsed.success) {
    throw sourceError("corrupt_record", `${path} is not a bounded private source record`)
  }
  try {
    const request = parseInlineLaunchSourceRequest(record.request)
    if (request.source_id !== record.request.source_id) {
      throw sourceError("corrupt_record", `${path} changed source identity during parsing`)
    }
    if ((record.bound_ensure_request === null ? 1 : 2) !== record.revision) {
      throw sourceError("corrupt_record", `${path} has an invalid source revision`)
    }
    if (record.bound_ensure_request !== null) {
      const ensure = parseFrozenEnsureRequest(record.bound_ensure_request)
      assertEnsureCorrelation(request, ensure)
    }
    const bytes = Buffer.concat([
      Buffer.from(encodeCanonicalJson(record as unknown as JsonValue)),
      Buffer.from("\n"),
    ])
    if (bytes.byteLength > CONTRACT_MAX_FRAME_BYTES) {
      throw sourceError("corrupt_record", `${path} exceeds the 1 MiB record bound`)
    }
  } catch (error) {
    if (error instanceof InlineLaunchSourceError && error.code === "corrupt_record") throw error
    const wrapped = sourceError("corrupt_record", `${path} contains invalid source authority`)
    wrapped.cause = error
    throw wrapped
  }
}

function validateIndex(records: readonly InlineLaunchSourceRecord[]): void {
  const identities = {
    source_id: new Set<string>(),
    source_digest: new Set<string>(),
    ensure_id: new Set<string>(),
    ensure_digest: new Set<string>(),
    worktree_id: new Set<string>(),
    agent_id: new Set<string>(),
    launch_id: new Set<string>(),
    launch_digest: new Set<string>(),
    admission_key: new Set<string>(),
  }
  for (const record of records) {
    for (const field of Object.keys(identities) as Array<keyof typeof identities>) {
      const value = record.request[field]
      if (identities[field].has(value)) {
        throw sourceError("corrupt_record", `source ledger repeats ${field}`)
      }
      identities[field].add(value)
    }
  }
}

function assertSecondaryClaimsAvailable(
  records: readonly InlineLaunchSourceRecord[],
  request: InlineLaunchSourceRequest,
): void {
  for (const record of records) {
    for (const [label, left, right] of [
      ["source digest", record.request.source_digest, request.source_digest],
      ["ensure id", record.request.ensure_id, request.ensure_id],
      ["ensure digest", record.request.ensure_digest, request.ensure_digest],
      ["Worktree id", record.request.worktree_id, request.worktree_id],
      ["Agent id", record.request.agent_id, request.agent_id],
      ["launch id", record.request.launch_id, request.launch_id],
      ["launch digest", record.request.launch_digest, request.launch_digest],
      ["admission key", record.request.admission_key, request.admission_key],
    ] as const) {
      if (left === right) {
        throw sourceError(
          "conflicting_claim",
          `${label} is already bound to source ${record.request.source_id}`,
        )
      }
    }
  }
}

function parseAuthority(input: InlineLaunchSourceAuthorityKey): InlineLaunchSourceAuthorityKey {
  const schema = inlineLaunchSourceRequestSchema.pick({
    workplace_instance_id: true,
    fmx_session: true,
    ensure_id: true,
    ensure_digest: true,
    worktree_id: true,
    agent_id: true,
    launch_id: true,
    launch_digest: true,
    admission_key: true,
    source_id: true,
    source_digest: true,
  })
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw sourceError("unauthorized", "source authority is incomplete or invalid")
  return structuredClone(parsed.data)
}

function requireAuthorizedRecord(
  index: RecordIndex,
  authority: InlineLaunchSourceAuthorityKey,
): InlineLaunchSourceRecord {
  const record = index.bySourceId.get(authority.source_id)
  if (record === undefined || !sameCanonical(authorityFor(record.request), authority)) {
    throw sourceError("unauthorized", "no source matches the complete exact authority")
  }
  return record
}

function requireRecordIdentity(index: RecordIndex, sourceId: string): Stats {
  const identity = index.identities.get(sourceId)
  if (identity === undefined) throw sourceError("corrupt_record", "source record lost file identity")
  return identity
}

async function readRecord(
  path: string,
  uid: number,
): Promise<{ identity: Stats; record: InlineLaunchSourceRecord }> {
  const { bytes, initial } = await readSafeFile(path, uid)
  try {
    if (bytes.byteLength < 2 || bytes[bytes.byteLength - 1] !== 0x0a) {
      throw sourceError("corrupt_record", `${path} is not one canonical JSON line`)
    }
    const payload = bytes.subarray(0, bytes.byteLength - 1)
    const value = decodeStrictJson(payload)
    if (!Buffer.from(encodeCanonicalJson(value)).equals(payload)) {
      throw sourceError("corrupt_record", `${path} is not canonical JSON`)
    }
    const parsed = privateRecordSchema.safeParse(value)
    if (!parsed.success) throw sourceError("corrupt_record", `${path} is not a private source record`)
    const request = parseInlineLaunchSourceRequest(parsed.data.request)
    let bound: FrozenEnsureRequest | null = null
    if (parsed.data.bound_ensure_request !== null) {
      bound = parseFrozenEnsureRequest(parsed.data.bound_ensure_request)
    }
    const record: InlineLaunchSourceRecord = {
      schema_id: LEDGER_SCHEMA_ID,
      schema_version: LEDGER_SCHEMA_VERSION,
      revision: parsed.data.revision,
      request,
      bound_ensure_request: bound,
    }
    validateRecord(record, path)
    if (initial.size !== bytes.byteLength) {
      throw sourceError("corrupt_record", `${path} changed while being read`)
    }
    return { identity: initial, record }
  } catch (error) {
    if (error instanceof InlineLaunchSourceError && error.code === "corrupt_record") throw error
    const wrapped = sourceError("corrupt_record", `${path} could not be decoded as a source record`)
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
      throw sourceError("corrupt_record", `${path} has unsafe size ${initial.size}`)
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
      throw sourceError("corrupt_record", `${path} changed while being read`)
    }
    return { bytes: bytes.subarray(0, offset), initial }
  } finally {
    await handle.close()
  }
}

async function ensurePrivateRoot(root: string, uid: number): Promise<Stats> {
  let existed = true
  try {
    await lstat(root)
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw unsafeStorage(`cannot inspect source root ${root}`, error)
    existed = false
    await mkdir(root, { recursive: true, mode: 0o700 })
  }
  const info = await lstat(root)
  assertSafeRootStats(root, info, uid)
  if (await realpath(root) !== root) throw unsafeStorage(`source root ${root} crosses a symbolic link`)
  if (!existed) await syncDirectory(dirname(root))
  return info
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
    if (!isErrno(error, "EEXIST")) throw unsafeStorage(`cannot create source lock ${path}`, error)
  } finally {
    await handle?.close()
  }
  const identity = await assertSafeFile(path, uid)
  if (created) await syncDirectory(root)
  return identity
}

async function assertStorageGuard(root: string, guard: StorageGuard, uid: number): Promise<void> {
  const directoryIdentity = await guard.directory.stat()
  assertSafeRootStats(root, directoryIdentity, uid)
  if (!sameRootIdentity(guard.rootIdentity, directoryIdentity)) {
    throw unsafeStorage(`source ledger root descriptor changed: ${root}`)
  }
  const rootPathIdentity = await lstat(root)
  assertSafeRootStats(root, rootPathIdentity, uid)
  if (!sameRootIdentity(guard.rootIdentity, rootPathIdentity) || await realpath(root) !== root) {
    throw unsafeStorage(`source ledger root path changed while locked: ${root}`)
  }
  const lockPath = resolve(root, LOCK_FILE)
  const lockedIdentity = fstatSync(guard.lock.descriptor)
  assertSafeStats(lockPath, lockedIdentity, uid)
  if (!sameFileIdentity(guard.lockIdentity, lockedIdentity)) {
    throw unsafeStorage(`source ledger lock descriptor changed: ${lockPath}`)
  }
  const lockPathIdentity = await assertSafeFile(lockPath, uid)
  if (!sameFileIdentity(guard.lockIdentity, lockPathIdentity)) {
    throw unsafeStorage(`source ledger lock path changed while held: ${lockPath}`)
  }
}

async function assertTargetSnapshot(path: string, expected: Stats | null, uid: number): Promise<void> {
  if (expected === null) {
    try {
      await lstat(path)
    } catch (error) {
      if (isErrno(error, "ENOENT")) return
      throw unsafeStorage(`cannot inspect new source target ${path}`, error)
    }
    throw unsafeStorage(`new source target already exists: ${path}`)
  }
  const current = await assertSafeFile(path, uid)
  if (!sameFileSnapshot(expected, current)) {
    throw unsafeStorage(`source target changed during its transaction: ${path}`)
  }
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

function assertSafeRootStats(path: string, info: Stats, uid: number): void {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700) {
    throw unsafeStorage(`${path} must be one uid-${uid} real directory with mode 0700`)
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
    throw sourceError("invalid_root", `source root must be one normalized absolute directory: ${root}`)
  }
}

function recordPathFor(root: string, sourceId: string): string {
  return resolve(root, recordFileName(sourceId))
}

function recordFileName(sourceId: string): string {
  return `${sha256(sourceId)}.json`
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalJson(left as JsonValue))
    .equals(Buffer.from(encodeCanonicalJson(right as JsonValue)))
}

function copyRecord(record: InlineLaunchSourceRecord): InlineLaunchSourceRecord {
  return structuredClone(record)
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.nlink === right.nlink
}

function sameRootIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function sourceError(code: InlineLaunchSourceErrorCode, message: string): InlineLaunchSourceError {
  return new InlineLaunchSourceError(code, message)
}

function unsafeStorage(message: string, cause?: unknown): InlineLaunchSourceError {
  const error = sourceError("unsafe_storage", message)
  if (cause !== undefined) error.cause = cause
  return error
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
