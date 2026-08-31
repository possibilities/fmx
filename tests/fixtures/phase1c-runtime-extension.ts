#!/usr/bin/env bun

/**
 * A deliberately provider-independent Runtime-extension child for the Phase
 * 1C acceptance seam. It only speaks framed stdio: no PTY, Companion, or Fx
 * process is involved here.
 */
import { createHash } from "node:crypto"
import { existsSync, watch, type FSWatcher } from "node:fs"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, dirname } from "node:path"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  ENSURE_LIFECYCLE_SCHEMA_ID,
  RUNTIME_EXTENSION_CAPABILITIES,
  RUNTIME_EXTENSION_SCHEMA_ID,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  ensureLifecycleMessageSchema,
  runtimeExtensionMessageSchema,
  type EnsureLifecycleMessage,
  type RuntimeExtensionMessage,
} from "../../src/agentworkplace-contracts.ts"
import { ContractFrameDecoder, encodeCanonicalJson, encodeContractFrame, type JsonValue } from "../../src/contract-codec.ts"
import {
  deriveCleanupDigest,
  deriveEndDigest,
  deriveLifecycleReceiptDigest,
  type CleanupRequest,
  type EndRequest,
} from "../../src/exact-retirement-ledger.ts"
import { deriveEnsureDigest, type EnsureRequest } from "../../src/ensure-lifecycle-ledger.ts"
import {
  deriveFrozenLaunchDigest,
  deriveInlineLaunchSourceDigest,
  encodeInlineLaunchControls,
  encodeInlineSourceBytes,
  parseInlineLaunchSourceRequest,
  type FrozenLaunchRequest,
  type InlineLaunchSourceRequest,
} from "../../src/inline-launch-source.ts"

type Initialize = {
  request_id: string
  workplace_instance_id: string
  extension_id: string
  configuration_id: string
  placement_id: string
  fmx_session: string
  protocol_version: 1
}
type EnsureReceipt = Extract<EnsureLifecycleMessage, { effects: unknown }>
type EndReceipt = Extract<EnsureLifecycleMessage, { proof: unknown }>
type CleanupReceipt = Extract<EnsureLifecycleMessage, { outcome: unknown }>
type LifecycleReceipt = EnsureReceipt | EndReceipt | CleanupReceipt

type ReceiptEvidence = {
  kind: "ensure" | "end" | "cleanup"
  receipt_id: string
  receipt_digest: string
  conversation_id: string | null
  acknowledgement: ReceiptAcknowledgement | null
}

type ReceiptAcknowledgement = Extract<EnsureLifecycleMessage, { acknowledgement_id: unknown }>

type FixtureAuthority = Pick<EnsureRequest,
  "workplace_instance_id" | "fmx_session" | "ensure_id" | "ensure_digest" | "launch_id" |
  "launch_digest" | "worktree_id" | "agent_id"> & {
  source_id: string
  source_digest: string
  admission_key: string
}

type FixtureState = {
  schema_version: 2
  authority: FixtureAuthority | null
  receipts: ReceiptEvidence[]
  end: EndRequest | null
  cleanup: CleanupRequest | null
}

const statePath = requiredEnvironment("FMX_PHASE1C_FIXTURE_STATE")
const releaseMarker = process.env.FMX_PHASE1C_FIXTURE_RELEASE_MARKER
const logPath = process.env.FMX_PHASE1C_FIXTURE_LOG
const crashAfter = process.env.FMX_PHASE1C_FIXTURE_CRASH_AFTER
const decoder = new ContractFrameDecoder()
let initialized = false
let state = await readState(statePath)
let fixture: FixtureMessages | null = null
let releaseTail: Promise<void> = Promise.resolve()
let endSent = false
let cleanupSent = false
let crashed = false
const acknowledgementSent = new Set<string>()
const releaseWatcher = releaseMarker === undefined ? null : watchReleaseMarker(releaseMarker)

for await (const chunk of Bun.stdin.stream()) {
  for (const payload of decoder.push(chunk)) {
    const message = decodeAgentWorkplacePayload(payload)
    if (!initialized) {
      const parsed = runtimeExtensionMessageSchema.safeParse(message)
      if (!parsed.success || parsed.data.message_type !== "initialize") {
        throw new Error("phase1c fixture expected Runtime-extension initialize")
      }
      initialized = true
      fixture = buildFixture(parsed.data as unknown as Initialize)
      await bindAuthority(fixture)
      writeRuntime(readyFor(parsed.data as unknown as Initialize))
      writeInline(fixture.source)
      writeLifecycle(fixture.ensure)
      await evidence("outbound", fixture.source)
      await evidence("outbound", fixture.ensure)
      await releasePending()
      continue
    }

    await evidence("inbound", message)
    const lifecycle = ensureLifecycleMessageSchema.safeParse(message)
    if (lifecycle.success && isReceipt(lifecycle.data)) await retainReceipt(lifecycle.data)
    await releasePending()
  }
}
decoder.finish()
releaseWatcher?.close()

type FixtureMessages = {
  source: InlineLaunchSourceRequest
  ensure: EnsureRequest
  end: (conversationId: string) => EndRequest
  cleanup: (conversationId: string) => CleanupRequest
}

async function bindAuthority(current: FixtureMessages): Promise<void> {
  const authority = authorityFor(current)
  if (state.authority === null) {
    state.authority = authority
    await saveState()
  } else if (!sameCanonical(state.authority, authority)) {
    throw new Error("phase1c fixture state belongs to another Workplace, Session, or lifecycle authority")
  }
  assertPersistedIntents(current)
}

function authorityFor(current: FixtureMessages): FixtureAuthority {
  return {
    workplace_instance_id: current.ensure.workplace_instance_id,
    fmx_session: current.ensure.fmx_session,
    ensure_id: current.ensure.ensure_id,
    ensure_digest: current.ensure.ensure_digest,
    launch_id: current.ensure.launch_id,
    launch_digest: current.ensure.launch_digest,
    worktree_id: current.ensure.worktree_id,
    agent_id: current.ensure.agent_id,
    source_id: current.source.source_id,
    source_digest: current.source.source_digest,
    admission_key: current.source.admission_key,
  }
}

function assertPersistedIntents(current: FixtureMessages): void {
  if (state.end !== null) {
    if (state.end.conversation_id === null || !sameCanonical(state.end, current.end(state.end.conversation_id))) {
      throw new Error("phase1c fixture retained end intent is not the exact bound authority")
    }
  }
  if (state.cleanup !== null) {
    if (state.end === null || state.end.conversation_id === null ||
      !sameCanonical(state.cleanup, current.cleanup(state.end.conversation_id))) {
      throw new Error("phase1c fixture retained cleanup intent is not the exact bound authority")
    }
  }
  for (const receipt of state.receipts) {
    if (receipt.acknowledgement === null) continue
    const expected = acknowledgementFor(receipt)
    if (!sameCanonical(receipt.acknowledgement, expected)) {
      throw new Error(`phase1c fixture retained acknowledgement ${receipt.acknowledgement.acknowledgement_id} changed authority`)
    }
  }
}

function buildFixture(initialize: Initialize): FixtureMessages {
  const paths = fixturePaths()
  const initialWork = encodeInlineSourceBytes(Buffer.from("Phase 1C fixture work\n", "utf8"))
  const launchControls = encodeInlineSourceBytes(encodeInlineLaunchControls(["--context-limit", "128000"]))
  const launch = {
    schema_id: "fx.launch-admission-final",
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "launch_request",
    request_id: "phase1c-launch-request",
    launch_id: "phase1c-launch",
    launch_digest: "0".repeat(64),
    admission_key: "phase1c-admission",
    conversation_name: "phase1c-runtime-extension",
    resume: { mode: "fresh" },
    state_root: "/var/tmp/fmx-phase1c-runtime-extension/state",
    directory: paths.directory,
    initial_work_digest: initialWork.sha256,
    remaining_launch_controls_digest: launchControls.sha256,
  } satisfies FrozenLaunchRequest
  launch.launch_digest = deriveFrozenLaunchDigest(launch)

  const ensure = {
    schema_id: ENSURE_LIFECYCLE_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "ensure_request",
    request_id: "phase1c-ensure-request",
    workplace_instance_id: initialize.workplace_instance_id,
    fmx_session: initialize.fmx_session,
    ensure_id: "phase1c-ensure",
    ensure_digest: "0".repeat(64),
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    worktree_id: "phase1c-worktree",
    agent_id: "c".repeat(32),
    planned_worktree: {
      repository: paths.repository,
      base_commit: paths.baseCommit,
      branch: "phase1c-runtime-extension",
      directory: launch.directory,
    },
    fx_conversation: { name: launch.conversation_name, resume_conversation_id: null },
  } satisfies EnsureRequest
  ensure.ensure_digest = deriveEnsureDigest(ensure)

  const source = {
    schema_id: "fmx.inline-launch-source",
    schema_version: 2,
    message_type: "source_request",
    request_id: "phase1c-source-request",
    workplace_instance_id: ensure.workplace_instance_id,
    fmx_session: ensure.fmx_session,
    ensure_id: ensure.ensure_id,
    ensure_digest: ensure.ensure_digest,
    worktree_id: ensure.worktree_id,
    agent_id: ensure.agent_id,
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    admission_key: launch.admission_key,
    source_id: "phase1c-source",
    source_digest: "0".repeat(64),
    launch_request: launch,
    initial_work: initialWork,
    launch_controls: launchControls,
  } satisfies InlineLaunchSourceRequest
  source.source_digest = deriveInlineLaunchSourceDigest(source)
  parseInlineLaunchSourceRequest(source)
  ensureLifecycleMessageSchema.parse(ensure)

  const correlation = {
    schema_id: ENSURE_LIFECYCLE_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    workplace_instance_id: ensure.workplace_instance_id,
    fmx_session: ensure.fmx_session,
    ensure_id: ensure.ensure_id,
    ensure_digest: ensure.ensure_digest,
    launch_id: ensure.launch_id,
    launch_digest: ensure.launch_digest,
    worktree_id: ensure.worktree_id,
    agent_id: ensure.agent_id,
  } as const
  return {
    source,
    ensure,
    end: (conversation_id) => {
      const request = {
        ...correlation,
        message_type: "end_request" as const,
        request_id: "phase1c-end-request",
        end_id: "phase1c-end",
        end_digest: "0".repeat(64),
        conversation_id,
        reason: "retire" as const,
      } satisfies EndRequest
      request.end_digest = deriveEndDigest(request)
      return ensureLifecycleMessageSchema.parse(request) as EndRequest
    },
    cleanup: (conversation_id) => {
      const end = fixtureEndFor(correlation, conversation_id)
      const request = {
        ...correlation,
        message_type: "cleanup_request" as const,
        request_id: "phase1c-cleanup-request",
        cleanup_id: "phase1c-cleanup",
        cleanup_digest: "0".repeat(64),
        end_id: end.end_id,
        end_digest: end.end_digest,
        conversation_id,
        worktree_directory: ensure.planned_worktree.directory,
      } satisfies CleanupRequest
      request.cleanup_digest = deriveCleanupDigest(request)
      return ensureLifecycleMessageSchema.parse(request) as CleanupRequest
    },
  }
}

/**
 * Focused composition tests may bind the immutable fixture request to a real
 * temporary repository. Unit tests retain the historical deterministic bytes.
 */
function fixturePaths(): { repository: string; baseCommit: string; directory: string } {
  const repository = process.env.FMX_PHASE1C_FIXTURE_REPOSITORY
  const baseCommit = process.env.FMX_PHASE1C_FIXTURE_BASE_COMMIT
  const directory = process.env.FMX_PHASE1C_FIXTURE_WORKTREE_DIRECTORY
  if (repository === undefined && baseCommit === undefined && directory === undefined) {
    return {
      repository: "/var/tmp/fmx-phase1c-runtime-extension/repository",
      baseCommit: "a".repeat(40),
      directory: "/var/tmp/fmx-phase1c-runtime-extension/worktree",
    }
  }
  if (
    repository === undefined || baseCommit === undefined || directory === undefined ||
    !repository.startsWith("/") || !directory.startsWith("/") || !/^[0-9a-f]{40}$/u.test(baseCommit)
  ) {
    throw new Error("phase1c fixture repository, base commit, and Worktree directory must be exact")
  }
  return { repository, baseCommit, directory }
}

function fixtureEndFor(
  correlation: Pick<EndRequest,
    "schema_id" | "schema_version" | "workplace_instance_id" | "fmx_session" | "ensure_id" |
    "ensure_digest" | "launch_id" | "launch_digest" | "worktree_id" | "agent_id">,
  conversation_id: string,
): EndRequest {
  const request = {
    ...correlation,
    message_type: "end_request" as const,
    request_id: "phase1c-end-request",
    end_id: "phase1c-end",
    end_digest: "0".repeat(64),
    conversation_id,
    reason: "retire" as const,
  } satisfies EndRequest
  request.end_digest = deriveEndDigest(request)
  return request
}

function readyFor(initialize: Initialize): RuntimeExtensionMessage {
  return {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "ready",
    request_id: initialize.request_id,
    workplace_instance_id: initialize.workplace_instance_id,
    extension_id: initialize.extension_id,
    configuration_id: initialize.configuration_id,
    placement_id: initialize.placement_id,
    fmx_session: initialize.fmx_session,
    protocol_version: initialize.protocol_version,
    capabilities: [...RUNTIME_EXTENSION_CAPABILITIES],
  }
}

function isReceipt(message: EnsureLifecycleMessage): message is LifecycleReceipt {
  return "receipt_id" in message && "receipt_digest" in message &&
    ("effects" in message || "proof" in message || "outcome" in message)
}

function assertAcceptedReceipt(receipt: LifecycleReceipt, kind: ReceiptEvidence["kind"]): void {
  if (fixture === null || state.authority === null) throw new Error("phase1c fixture receipt arrived before authority binding")
  const expected = kind === "ensure" ? fixture.ensure : kind === "end" ? state.end : state.cleanup
  if (expected === null) throw new Error(`phase1c fixture received ${kind} receipt before its exact intent`)
  const fields = [
    "schema_id", "schema_version", "request_id", "workplace_instance_id", "fmx_session", "ensure_id",
    "ensure_digest", "launch_id", "launch_digest", "worktree_id", "agent_id",
    ...(kind === "end" || kind === "cleanup" ? ["end_id", "end_digest", "conversation_id"] : []),
    ...(kind === "cleanup" ? ["cleanup_id", "cleanup_digest", "worktree_directory"] : []),
  ]
  assertExactFields(receipt, expected, fields, `${kind} receipt`)
}

function assertExactFields(
  received: object,
  expected: object,
  fields: readonly string[],
  label: string,
): void {
  const actual = received as Record<string, unknown>
  const authority = expected as Record<string, unknown>
  for (const field of fields) {
    if (actual[field] !== authority[field]) {
      throw new Error(`phase1c fixture rejected ${label}: ${field} does not match bound authority`)
    }
  }
}

async function retainReceipt(receipt: LifecycleReceipt): Promise<void> {
  const kind: ReceiptEvidence["kind"] = "effects" in receipt ? "ensure" : "proof" in receipt ? "end" : "cleanup"
  assertAcceptedReceipt(receipt, kind)
  assertReceiptDigest(receipt, kind)
  const existing = state.receipts.find(({ kind: savedKind, receipt_id }) =>
    savedKind === kind && receipt_id === receipt.receipt_id)
  if (existing !== undefined) {
    if (existing.receipt_digest !== receipt.receipt_digest) {
      throw new Error(`phase1c fixture receipt ${receipt.receipt_id} changed digest`)
    }
    return
  }
  const conversation = "effects" in receipt
    ? receipt.effects.fx.status === "started" ? receipt.effects.fx.conversation_id : null
    : "conversation_id" in receipt ? receipt.conversation_id : null
  state.receipts.push({
    kind,
    receipt_id: receipt.receipt_id,
    receipt_digest: receipt.receipt_digest,
    conversation_id: conversation,
    acknowledgement: null,
  })
  await saveState()
}

function assertReceiptDigest(receipt: LifecycleReceipt, kind: ReceiptEvidence["kind"]): void {
  if (kind === "ensure") {
    if (!("effects" in receipt) || receipt.status !== "complete") {
      throw new Error("phase1c fixture rejected ensure receipt without a complete authoritative effect")
    }
    if (deriveEnsureReceiptDigest(receipt) !== receipt.receipt_digest) {
      throw new Error("phase1c fixture rejected ensure receipt with an invalid canonical digest")
    }
    return
  }
  if (deriveLifecycleReceiptDigest(receipt as never) !== receipt.receipt_digest) {
    throw new Error(`phase1c fixture rejected ${kind} receipt with an invalid canonical digest`)
  }
}

function deriveEnsureReceiptDigest(receipt: EnsureReceipt): string {
  const { receipt_digest: _receiptDigest, ...content } = receipt
  return createHash("sha256").update(encodeCanonicalJson(content as JsonValue)).digest("hex")
}

async function releasePending(): Promise<void> {
  releaseTail = releaseTail.then(releaseAvailable)
  return releaseTail
}

async function releaseAvailable(): Promise<void> {
  if (fixture === null || releaseMarker === undefined || !existsSync(releaseMarker)) return
  for (const receipt of state.receipts) {
    if (receipt.acknowledgement === null) {
      receipt.acknowledgement = acknowledgementFor(receipt)
      await saveState()
      crashAt("acknowledgement_intent_saved")
    }
    if (!acknowledgementSent.has(receiptKey(receipt))) {
      writeLifecycle(receipt.acknowledgement)
      await evidence("outbound", receipt.acknowledgement)
      acknowledgementSent.add(receiptKey(receipt))
    }
    await deriveAfterAcknowledgement(receipt)
  }
  await replayDerivedIntents()
}

async function deriveAfterAcknowledgement(receipt: ReceiptEvidence): Promise<void> {
  if (fixture === null) return
  if (receipt.kind === "ensure" && receipt.conversation_id !== null && state.end === null) {
    state.end = fixture.end(receipt.conversation_id)
    await saveState()
    crashAt("end_intent_saved")
  }
  if (receipt.kind === "end" && state.end !== null && state.cleanup === null) {
    state.cleanup = fixture.cleanup(state.end.conversation_id!)
    await saveState()
    crashAt("cleanup_intent_saved")
  }
}

async function replayDerivedIntents(): Promise<void> {
  if (state.end !== null && !endSent) {
    writeLifecycle(state.end)
    await evidence("outbound", state.end)
    endSent = true
  }
  if (state.cleanup !== null && !cleanupSent) {
    writeLifecycle(state.cleanup)
    await evidence("outbound", state.cleanup)
    cleanupSent = true
  }
}

function acknowledgementFor(receipt: ReceiptEvidence): ReceiptAcknowledgement {
  if (fixture === null) throw new Error("phase1c fixture has no initialized authority")
  return {
    schema_id: ENSURE_LIFECYCLE_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "receipt_acknowledgement",
    acknowledgement_id: `phase1c-ack-${createHash("sha256")
    .update(`${receipt.kind}\u0000${receipt.receipt_id}\u0000${receipt.receipt_digest}`)
    .digest("hex").slice(0, 40)}`,
    receipt_kind: receipt.kind,
    receipt_id: receipt.receipt_id,
    receipt_digest: receipt.receipt_digest,
    ensure_id: fixture.ensure.ensure_id,
  } as ReceiptAcknowledgement
}

function receiptKey(receipt: ReceiptEvidence): string {
  return `${receipt.kind}\u0000${receipt.receipt_id}\u0000${receipt.receipt_digest}`
}

function crashAt(point: string): void {
  if (!crashed && crashAfter === point) {
    crashed = true
    process.exit(86)
  }
}

function writeRuntime(message: RuntimeExtensionMessage): void {
  process.stdout.write(Buffer.from(encodeAgentWorkplaceFrame(message)))
}

function writeLifecycle(message: EnsureLifecycleMessage): void {
  process.stdout.write(Buffer.from(encodeAgentWorkplaceFrame(message)))
}

function writeInline(message: InlineLaunchSourceRequest): void {
  process.stdout.write(Buffer.from(encodeContractFrame(encodeCanonicalJson(message as unknown as JsonValue))))
}

async function evidence(direction: "inbound" | "outbound", message: unknown): Promise<void> {
  if (logPath === undefined || typeof message !== "object" || message === null) return
  const input = message as Record<string, unknown>
  const output: Record<string, unknown> = { direction, message_type: input.message_type }
  for (const key of [
    "request_id", "acknowledgement_id", "receipt_kind", "receipt_id", "receipt_digest",
    "workplace_instance_id", "fmx_session", "ensure_id", "ensure_digest", "launch_id",
    "launch_digest", "worktree_id", "agent_id", "end_id", "end_digest", "cleanup_id", "cleanup_digest",
  ]) {
    if (key in input) output[key] = input[key]
  }
  await appendFile(logPath, `${JSON.stringify(output)}\n`, { encoding: "utf8", mode: 0o600 })
}

function watchReleaseMarker(path: string): FSWatcher {
  const marker = basename(path)
  return watch(dirname(path), { persistent: false }, (_event, filename) => {
    if (filename === marker) void releasePending()
  })
}

async function readState(path: string): Promise<FixtureState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as FixtureState
    if (parsed.schema_version !== 2 || !Array.isArray(parsed.receipts) ||
      parsed.authority !== null && (typeof parsed.authority !== "object" ||
        parsed.authority === null || !isAuthority(parsed.authority)) ||
      parsed.end !== null && typeof parsed.end !== "object" ||
      parsed.cleanup !== null && typeof parsed.cleanup !== "object" ||
      !parsed.receipts.every(isReceiptEvidence)) {
      throw new Error("invalid state")
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: 2, authority: null, receipts: [], end: null, cleanup: null }
    }
    throw new Error(`phase1c fixture cannot read state: ${String(error)}`)
  }
}

async function saveState(): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  const temporary = `${statePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, statePath)
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function isAuthority(value: object): value is FixtureAuthority {
  const input = value as Record<string, unknown>
  return [
    "workplace_instance_id", "fmx_session", "ensure_id", "ensure_digest", "launch_id", "launch_digest",
    "worktree_id", "agent_id", "source_id", "source_digest", "admission_key",
  ].every((key) => typeof input[key] === "string")
}

function isReceiptEvidence(value: unknown): value is ReceiptEvidence {
  if (typeof value !== "object" || value === null) return false
  const input = value as Record<string, unknown>
  return (input.kind === "ensure" || input.kind === "end" || input.kind === "cleanup") &&
    typeof input.receipt_id === "string" && typeof input.receipt_digest === "string" &&
    (typeof input.conversation_id === "string" || input.conversation_id === null) &&
    (input.acknowledgement === null || typeof input.acknowledgement === "object")
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalJson(left as JsonValue)).equals(
    Buffer.from(encodeCanonicalJson(right as JsonValue)),
  )
}
