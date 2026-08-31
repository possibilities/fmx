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
import { deriveCleanupDigest, deriveEndDigest, type CleanupRequest, type EndRequest } from "../../src/exact-retirement-ledger.ts"
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
  acknowledgement_id: string | null
  conversation_id: string | null
}

type FixtureState = {
  schema_version: 1
  receipts: ReceiptEvidence[]
  end_conversation_id: string | null
  end_requested: boolean
  cleanup_requested: boolean
}

const statePath = requiredEnvironment("FMX_PHASE1C_FIXTURE_STATE")
const releaseMarker = process.env.FMX_PHASE1C_FIXTURE_RELEASE_MARKER
const logPath = process.env.FMX_PHASE1C_FIXTURE_LOG
const decoder = new ContractFrameDecoder()
let initialized = false
let state = await readState(statePath)
let fixture: FixtureMessages | null = null
let releaseTail: Promise<void> = Promise.resolve()
let endSent = false
let cleanupSent = false
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

function buildFixture(initialize: Initialize): FixtureMessages {
  const initialWork = encodeInlineSourceBytes(Buffer.from("Phase 1C fixture work\n", "utf8"))
  const launchControls = encodeInlineSourceBytes(encodeInlineLaunchControls(["--record"]))
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
    directory: "/var/tmp/fmx-phase1c-runtime-extension/worktree",
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
      repository: "/var/tmp/fmx-phase1c-runtime-extension/repository",
      base_commit: "a".repeat(40),
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

async function retainReceipt(receipt: LifecycleReceipt): Promise<void> {
  const kind: ReceiptEvidence["kind"] = "effects" in receipt ? "ensure" : "proof" in receipt ? "end" : "cleanup"
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
    acknowledgement_id: null,
    conversation_id: conversation,
  })
  await saveState()
}

async function releasePending(): Promise<void> {
  releaseTail = releaseTail.then(releaseAvailable)
  return releaseTail
}

async function releaseAvailable(): Promise<void> {
  if (fixture === null || releaseMarker === undefined || !existsSync(releaseMarker)) return
  for (const receipt of state.receipts) {
    if (receipt.acknowledgement_id !== null) continue
    receipt.acknowledgement_id = acknowledgementId(receipt)
    await saveState()
    writeLifecycle({
      schema_id: ENSURE_LIFECYCLE_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "receipt_acknowledgement",
      acknowledgement_id: receipt.acknowledgement_id,
      receipt_kind: receipt.kind,
      receipt_id: receipt.receipt_id,
      receipt_digest: receipt.receipt_digest,
      ensure_id: fixture.ensure.ensure_id,
    })
    await evidence("outbound", {
      message_type: "receipt_acknowledgement",
      acknowledgement_id: receipt.acknowledgement_id,
      receipt_kind: receipt.kind,
      receipt_id: receipt.receipt_id,
      receipt_digest: receipt.receipt_digest,
      ensure_id: fixture.ensure.ensure_id,
    })
    await deriveAfterAcknowledgement(receipt)
  }
  await replayDerivedIntents()
}

async function deriveAfterAcknowledgement(receipt: ReceiptEvidence): Promise<void> {
  if (fixture === null) return
  if (receipt.kind === "ensure" && receipt.conversation_id !== null && !state.end_requested) {
    state.end_conversation_id = receipt.conversation_id
    state.end_requested = true
    await saveState()
  }
  if (receipt.kind === "end" && state.end_conversation_id !== null && !state.cleanup_requested) {
    state.cleanup_requested = true
    await saveState()
  }
}

async function replayDerivedIntents(): Promise<void> {
  if (fixture === null || state.end_conversation_id === null) return
  if (state.end_requested && !endSent) {
    const end = fixture.end(state.end_conversation_id)
    writeLifecycle(end)
    await evidence("outbound", end)
    endSent = true
  }
  if (state.cleanup_requested && !cleanupSent) {
    const cleanup = fixture.cleanup(state.end_conversation_id)
    writeLifecycle(cleanup)
    await evidence("outbound", cleanup)
    cleanupSent = true
  }
}

function acknowledgementId(receipt: ReceiptEvidence): string {
  return `phase1c-ack-${createHash("sha256")
    .update(`${receipt.kind}\u0000${receipt.receipt_id}\u0000${receipt.receipt_digest}`)
    .digest("hex").slice(0, 40)}`
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
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.receipts) ||
      typeof parsed.end_conversation_id !== "string" && parsed.end_conversation_id !== null ||
      typeof parsed.end_requested !== "boolean" || typeof parsed.cleanup_requested !== "boolean") {
      throw new Error("invalid state")
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: 1, receipts: [], end_conversation_id: null, end_requested: false, cleanup_requested: false }
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
