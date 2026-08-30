import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import * as z from "zod/v4"
import {
  AGENT_DEFAULTS_SCHEMA_ID,
  AGENTWORKPLACE_CONTRACT_VERSION,
  ENSURE_LIFECYCLE_SCHEMA_ID,
  FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID,
  RUNTIME_EXTENSION_SCHEMA_ID,
  decodeAgentWorkplaceFrame,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  encodeAgentWorkplacePayload,
  type AgentWorkplaceMessage,
} from "../src/agentworkplace-contracts.ts"
import {
  CONTRACT_FRAME_HEADER_BYTES,
  CONTRACT_MAX_FRAME_BYTES,
  decodeStrictJson,
  encodeCanonicalJson,
  type JsonValue,
} from "../src/contract-codec.ts"

const MANIFEST_SCHEMA_ID = "fmx.agentworkplace.contract-manifest"
const DEFAULT_CONTRACT_DIRECTORY = resolve(import.meta.dir, "../contracts/agentworkplace/v1")
const EXPECTED_FIXTURES = new Map([
  ["agent-defaults.jsonl", AGENT_DEFAULTS_SCHEMA_ID],
  ["ensure-lifecycle.jsonl", ENSURE_LIFECYCLE_SCHEMA_ID],
  ["fx-launch-admission-final.jsonl", FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID],
  ["runtime-extension.jsonl", RUNTIME_EXTENSION_SCHEMA_ID],
])

const manifestSchema = z.strictObject({
  schema_id: z.literal(MANIFEST_SCHEMA_ID),
  schema_version: z.literal(AGENTWORKPLACE_CONTRACT_VERSION),
  contract_set: z.literal("phase-0-fmx-contracts"),
  canonical_encoding: z.strictObject({
    format: z.literal("utf-8-jsonl"),
    json: z.literal("sorted-keys-no-whitespace"),
    line_ending: z.literal("lf"),
  }),
  frame: z.strictObject({
    header_bytes: z.literal(CONTRACT_FRAME_HEADER_BYTES),
    length_byte_order: z.literal("big-endian"),
    max_payload_bytes: z.literal(CONTRACT_MAX_FRAME_BYTES),
  }),
  files: z.array(z.strictObject({
    path: z.string().regex(/^[a-z][a-z0-9-]*\.jsonl$/u),
    schema_id: z.enum([
      RUNTIME_EXTENSION_SCHEMA_ID,
      AGENT_DEFAULTS_SCHEMA_ID,
      ENSURE_LIFECYCLE_SCHEMA_ID,
      FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID,
    ]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().positive().safe(),
    messages: z.number().int().positive().safe(),
  })).length(EXPECTED_FIXTURES.size),
})

export type VerifiedContractFixture = {
  path: string
  schema_id: string
  sha256: string
  bytes: number
  messages: number
}

export type ContractVerification = {
  schema_version: 1
  ok: true
  manifest_path: string
  manifest_sha256: string
  fixtures: VerifiedContractFixture[]
}

export async function verifyAgentWorkplaceContracts(
  directory: string = DEFAULT_CONTRACT_DIRECTORY,
): Promise<ContractVerification> {
  const manifestPath = resolve(directory, "manifest.json")
  const manifestBytes = await readFile(manifestPath)
  const manifestValue = decodeStrictJson(withoutOneTrailingLf(manifestBytes, "manifest.json"))
  const canonicalManifest = Buffer.concat([Buffer.from(encodeCanonicalJson(manifestValue)), Buffer.from("\n")])
  if (!canonicalManifest.equals(manifestBytes)) throw new Error("manifest.json is not canonical JSON plus one LF")
  const manifest = manifestSchema.parse(manifestValue)

  const named = new Set<string>()
  const messagesBySchema = new Map<string, AgentWorkplaceMessage[]>()
  const fixtures: VerifiedContractFixture[] = []
  for (const file of manifest.files) {
    if (named.has(file.path)) throw new Error(`duplicate fixture path in manifest: ${file.path}`)
    named.add(file.path)
    const expectedSchema = EXPECTED_FIXTURES.get(file.path)
    if (expectedSchema !== file.schema_id) {
      throw new Error(`${file.path} must carry ${expectedSchema ?? "no schema"}, not ${file.schema_id}`)
    }
    if (basename(file.path) !== file.path) throw new Error(`fixture path escapes its contract directory: ${file.path}`)

    const bytes = await readFile(resolve(directory, file.path))
    if (bytes.byteLength !== file.bytes) {
      throw new Error(`${file.path} has ${bytes.byteLength} bytes; manifest records ${file.bytes}`)
    }
    const digest = sha256(bytes)
    if (digest !== file.sha256) throw new Error(`${file.path} digest is ${digest}; manifest records ${file.sha256}`)
    if (bytes.includes(0x0d)) throw new Error(`${file.path} contains CR instead of canonical LF records`)
    const text = new TextDecoder("utf-8", { fatal: true }).decode(withoutOneTrailingLf(bytes, file.path))
    const lines = text.split("\n")
    if (lines.length !== file.messages || lines.some((line) => line.length === 0)) {
      throw new Error(`${file.path} has ${lines.length} noncanonical records; manifest records ${file.messages}`)
    }

    const messages: AgentWorkplaceMessage[] = []
    for (const [index, line] of lines.entries()) {
      const payload = new TextEncoder().encode(line)
      const message = decodeAgentWorkplacePayload(payload)
      if (message.schema_id !== file.schema_id) {
        throw new Error(`${file.path}:${index + 1} carries ${message.schema_id}`)
      }
      if (!Buffer.from(encodeAgentWorkplacePayload(message)).equals(Buffer.from(payload))) {
        throw new Error(`${file.path}:${index + 1} is not the canonical envelope encoding`)
      }
      const frame = encodeAgentWorkplaceFrame(message)
      if (!deepEqual(decodeAgentWorkplaceFrame(frame), message)) {
        throw new Error(`${file.path}:${index + 1} does not round-trip through the framed codec`)
      }
      messages.push(message)
    }
    messagesBySchema.set(file.schema_id, messages)
    fixtures.push({
      path: file.path,
      schema_id: file.schema_id,
      sha256: file.sha256,
      bytes: file.bytes,
      messages: file.messages,
    })
  }
  if (named.size !== EXPECTED_FIXTURES.size || [...EXPECTED_FIXTURES.keys()].some((path) => !named.has(path))) {
    throw new Error("manifest does not name the complete fmx Phase 0 contract family set")
  }

  verifyRuntimeExtension(messagesBySchema.get(RUNTIME_EXTENSION_SCHEMA_ID) ?? [])
  verifyAgentDefaults(messagesBySchema.get(AGENT_DEFAULTS_SCHEMA_ID) ?? [])
  verifyEnsureLifecycle(messagesBySchema.get(ENSURE_LIFECYCLE_SCHEMA_ID) ?? [])
  verifyFxLaunchAdmissionFinal(messagesBySchema.get(FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID) ?? [])
  verifyCrossFamilyCorrelation(
    messagesBySchema.get(RUNTIME_EXTENSION_SCHEMA_ID) ?? [],
    messagesBySchema.get(AGENT_DEFAULTS_SCHEMA_ID) ?? [],
    messagesBySchema.get(ENSURE_LIFECYCLE_SCHEMA_ID) ?? [],
    messagesBySchema.get(FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID) ?? [],
  )

  return {
    schema_version: 1,
    ok: true,
    manifest_path: manifestPath,
    manifest_sha256: sha256(manifestBytes),
    fixtures,
  }
}

function verifyRuntimeExtension(messages: AgentWorkplaceMessage[]): void {
  const association = exactlyOne(messages, "association")
  const registration = exactlyOne(messages, "registration")
  const initialize = exactlyOne(messages, "initialize")
  const ready = exactlyOne(messages, "ready")
  const invalidated = exactlyOne(messages, "snapshot_invalidated")
  const result = exactlyOne(messages, "snapshot_result")
  const present = exactlyOne(messages, "present")
  const publish = exactlyOne(messages, "unavailable_slot_publish")
  const action = exactlyOne(messages, "unavailable_slot_action")
  const clear = exactlyOne(messages, "unavailable_slot_clear")
  const responses = records(messages, "response")

  const protocol = asRecord(registration.protocol, "registration protocol")
  if (!(Number(protocol.minimum) <= AGENTWORKPLACE_CONTRACT_VERSION &&
    Number(protocol.maximum) >= AGENTWORKPLACE_CONTRACT_VERSION)) {
    throw new Error("registration protocol range does not include v1")
  }
  for (const field of ["extension_id", "configuration_id", "workplace_instance_id"] as const) {
    if (field in registration && registration[field] !== initialize[field]) {
      throw new Error(`Runtime-extension ${field} does not match initialization`)
    }
    if (field in association && association[field] !== initialize[field]) {
      throw new Error(`association ${field} does not match initialization`)
    }
  }
  assertCorrelation(initialize, ready, [
    "request_id",
    "workplace_instance_id",
    "extension_id",
    "configuration_id",
    "placement_id",
    "fmx_session",
    "protocol_version",
  ])
  const members = asRecords(association.members, "association members")
  const exactMember = members.filter((member) =>
    member.fmx_session === initialize.fmx_session && member.placement_id === initialize.placement_id
  )
  if (exactMember.length !== 1) throw new Error("initialization is not an exact association member")

  const required = asStrings(registration.required_capabilities, "required capabilities")
  const offered = new Set(asStrings(ready.capabilities, "ready capabilities"))
  if (required.some((capability) => !offered.has(capability))) {
    throw new Error("readiness omits a registration-required capability")
  }

  const gets = records(messages, "snapshot_get")
  assertUnique(gets.map((entry) => String(entry.request_id)), "snapshot request id")
  const successfulGet = gets.find((entry) => entry.request_id === result.request_id)
  if (!successfulGet) throw new Error("snapshot result lacks its exact request")
  if (invalidated.fmx_session !== successfulGet.fmx_session || successfulGet.fmx_session !== result.fmx_session) {
    throw new Error("snapshot envelopes name different fmx Sessions")
  }
  if (BigInt(String(result.revision)) < BigInt(String(invalidated.revision))) {
    throw new Error("snapshot result predates the invalidated authoritative revision")
  }
  if (successfulGet.after_revision !== null &&
    BigInt(String(result.revision)) <= BigInt(String(successfulGet.after_revision))) {
    throw new Error("snapshot result does not advance its requested revision")
  }
  const snapshotFailures = responses.filter((entry) => entry.operation === "snapshot_get" && entry.ok === false)
  if (snapshotFailures.length !== 1) throw new Error("Runtime-extension fixture must carry one snapshot failure")
  const snapshotOutcomes = [result, ...snapshotFailures]
  assertUnique(snapshotOutcomes.map((entry) => String(entry.request_id)), "snapshot outcome request id")
  for (const get of gets) {
    const outcomes = snapshotOutcomes.filter((entry) => entry.request_id === get.request_id)
    if (outcomes.length !== 1) throw new Error(`snapshot request ${String(get.request_id)} lacks one exact outcome`)
  }
  for (const outcome of snapshotOutcomes) {
    if (gets.filter((get) => get.request_id === outcome.request_id).length !== 1) {
      throw new Error(`snapshot outcome ${String(outcome.request_id)} lacks one exact request`)
    }
  }
  if (gets.length !== 2) throw new Error("Runtime-extension fixture must cover successful and failed snapshot pulls")

  if (present.fmx_session !== ready.fmx_session ||
    !asRecords(result.agents, "snapshot Agents").some((agent) => agent.agent_id === present.agent_id)) {
    throw new Error("present request does not target an Agent in the exact member snapshot")
  }
  const card = asRecord(publish.card, "recovery card")
  const cardAction = asRecord(card.action, "recovery-card action")
  for (const candidate of [action, clear]) {
    assertCorrelation(publish, candidate, ["fmx_session"])
    assertCorrelation(card, candidate, ["slot_id", "card_revision"])
  }
  if (cardAction.action_id !== action.action_id) throw new Error("recovery-card action id does not match")

  const correlatedRequests = [present, publish, action, clear]
  const operationFor = new Map([
    ["present", "present"],
    ["unavailable_slot_publish", "unavailable_slot_publish"],
    ["unavailable_slot_action", "unavailable_slot_action"],
    ["unavailable_slot_clear", "unavailable_slot_clear"],
  ])
  for (const request of correlatedRequests) {
    const response = responses.filter((candidate) => candidate.request_id === request.request_id)
    if (response.length !== 1) throw new Error(`request ${String(request.request_id)} lacks one correlated response`)
    if (response[0]!.operation !== operationFor.get(String(request.message_type))) {
      throw new Error(`request ${String(request.request_id)} response operation mismatch`)
    }
    if (response[0]!.ok !== true || response[0]!.status !== "accepted") {
      throw new Error(`request ${String(request.request_id)} fixture outcome must be accepted`)
    }
  }
  assertUnique(
    [initialize, ...gets, ...correlatedRequests].map((request) => String(request.request_id)),
    "Runtime-extension request id",
  )
  const accountedResponseIds = new Set([
    ...correlatedRequests.map((request) => String(request.request_id)),
    ...snapshotFailures.map((response) => String(response.request_id)),
  ])
  if (responses.some((response) => !accountedResponseIds.has(String(response.request_id)))) {
    throw new Error("Runtime-extension fixture carries an orphan response")
  }
}

function verifyAgentDefaults(messages: AgentWorkplaceMessage[]): void {
  const table = exactlyOne(messages, "defaults_table")
  const entries = asRecords(table.entries, "Agent-default entries")
  const cases = records(messages, "resolution_case")
  if (cases.length < 4) {
    throw new Error("Agent-default fixtures must cover override, partial, nonmatching, and vanilla cases")
  }
  assertUnique(cases.map((entry) => String(entry.case_id)), "Agent-default case id")
  for (const candidate of cases) {
    const match = entries.find((entry) => entry.fmx_session === candidate.fmx_session) ?? null
    if (!deepEqual(match, candidate.matching_default)) {
      throw new Error(`Agent-default case ${String(candidate.case_id)} does not use the exact Session table entry`)
    }
  }
  if (!cases.some((entry) => entry.case_id === "nonmatching-session-preserves-vanilla-fx")) {
    throw new Error("Agent-default fixtures omit nonmatching-Session behavior")
  }
  if (!cases.some((entry) => entry.case_id === "absent-values-preserve-vanilla-fx")) {
    throw new Error("Agent-default fixtures omit absent-value vanilla behavior")
  }
}

function verifyEnsureLifecycle(messages: AgentWorkplaceMessage[]): void {
  const requests = records(messages, "ensure_request")
  const ensureReceipts = records(messages, "ensure_receipt")
  const endRequests = records(messages, "end_request")
  const endReceipts = records(messages, "end_receipt")
  const cleanupRequests = records(messages, "cleanup_request")
  const cleanupReceipts = records(messages, "cleanup_receipt")
  if (requests.length !== 2) {
    throw new Error("ensure fixtures must cover one completed and one cancelled-before-start launch")
  }
  if (endRequests.length !== requests.length || endReceipts.length !== requests.length ||
    cleanupRequests.length !== requests.length || cleanupReceipts.length !== requests.length) {
    throw new Error("every ensure fixture trace requires exactly one end and cleanup exchange")
  }
  for (const receipt of ensureReceipts) {
    if (!requests.some((request) => request.ensure_id === receipt.ensure_id)) {
      throw new Error(`ensure receipt ${String(receipt.receipt_id)} is orphaned`)
    }
  }
  assertUnique(requests.map((entry) => String(entry.ensure_id)), "ensure id")
  assertUnique(requests.map((entry) => String(entry.worktree_id)), "Worktree id")
  assertUnique(requests.map((entry) => String(entry.agent_id)), "Agent id")
  assertUnique(
    requests.map((entry) => String(asRecord(entry.planned_worktree, "planned Worktree").directory)),
    "planned Worktree directory",
  )
  assertUnique(endRequests.map((entry) => String(entry.end_id)), "end id")
  assertUnique(cleanupRequests.map((entry) => String(entry.cleanup_id)), "cleanup id")
  assertUnique(
    [...requests, ...endRequests, ...cleanupRequests].map((entry) => String(entry.request_id)),
    "lifecycle request id",
  )

  let completedTraces = 0
  let neverStartedTraces = 0
  const plannedCompanionSessions: string[] = []
  const plannedCompanionPanes: string[] = []
  for (const request of requests) {
    verifyRecordedDigest("ensure request", request.ensure_digest, ensureSpecification(request))
    const planned = asRecord(request.planned_worktree, "planned Worktree")
    const correlatedReceipts = ensureReceipts.filter((receipt) => receipt.ensure_id === request.ensure_id)
    const partials = correlatedReceipts.filter((entry) => entry.status === "in_progress")
    const completed = correlatedReceipts.filter((entry) => entry.status === "complete")
    if (partials.length < 1 || completed.length > 1) {
      throw new Error(`ensure ${String(request.ensure_id)} must retain partial effects and at most one completion`)
    }

    let plannedCompanion: Record<string, unknown> | null = null
    for (const receipt of correlatedReceipts) {
      assertCorrelation(request, receipt, [
        "request_id",
        "workplace_instance_id",
        "fmx_session",
        "ensure_id",
        "ensure_digest",
        "launch_id",
        "launch_digest",
        "worktree_id",
        "agent_id",
      ])
      verifyReceiptDigest(receipt)
      const effects = asRecord(receipt.effects, "ensure effects")
      const worktree = asRecord(effects.worktree, "Worktree effect")
      const manifest = asRecord(effects.manifest, "Manifest effect")
      const companion = asRecord(effects.companion, "Companion effect")
      if (worktree.directory !== planned.directory) throw new Error("ensure effect changed the planned Worktree path")
      if (manifest.status === "claimed" && manifest.agent_id !== request.agent_id) {
        throw new Error("ensure effect changed the planned Agent identity")
      }
      if (plannedCompanion === null) {
        plannedCompanion = companion
      } else {
        assertCorrelation(plannedCompanion, companion, ["session_name", "pane_id"])
      }
    }
    if (plannedCompanion === null) {
      throw new Error(`ensure ${String(request.ensure_id)} lacks a planned Companion identity`)
    }
    plannedCompanionSessions.push(String(plannedCompanion.session_name))
    plannedCompanionPanes.push(String(plannedCompanion.pane_id))
    if (partials.some((receipt) => ensureEffectsComplete(receipt))) {
      throw new Error("partial ensure receipt falsely claims a complete effect set")
    }

    const matchingEndRequests = endRequests.filter((candidate) => candidate.ensure_id === request.ensure_id)
    const matchingEndReceipts = endReceipts.filter((candidate) => candidate.ensure_id === request.ensure_id)
    if (matchingEndRequests.length !== 1 || matchingEndReceipts.length !== 1) {
      throw new Error(`ensure ${String(request.ensure_id)} lacks one exact end request and receipt`)
    }
    const endRequest = matchingEndRequests[0]!
    const endReceipt = matchingEndReceipts[0]!
    assertCorrelation(request, endRequest, lifecycleCorrelationFields())
    verifyRecordedDigest("end request", endRequest.end_digest, endSpecification(endRequest))
    assertCorrelation(endRequest, endReceipt, [
      "request_id",
      ...lifecycleCorrelationFields(),
      "conversation_id",
      "end_id",
      "end_digest",
    ])
    verifyReceiptDigest(endReceipt)
    const proof = asRecord(endReceipt.proof, "end proof")
    if (proof.pane_id !== plannedCompanion?.pane_id || proof.companion_session !== plannedCompanion?.session_name) {
      throw new Error("end proof does not identify the exact planned Companion Agent")
    }

    if (completed.length === 1) {
      completedTraces++
      const effects = asRecord(completed[0]!.effects, "complete ensure effects")
      const fx = asRecord(effects.fx, "complete Fx effect")
      if (endRequest.conversation_id !== fx.conversation_id) {
        throw new Error("end request does not name the exact ensured Fx Conversation")
      }
      if (proof.kind !== "ended") throw new Error("completed ensure must carry definitive Companion end proof")
    } else {
      neverStartedTraces++
      if (endRequest.conversation_id !== null || endRequest.reason !== "cancelled_before_start" ||
        proof.kind !== "never_started") {
        throw new Error("cancelled partial ensure must carry definitive never-started proof")
      }
      for (const receipt of correlatedReceipts) {
        const effects = asRecord(receipt.effects, "cancelled ensure effects")
        if (asRecord(effects.companion, "Companion effect").status !== "pending" ||
          asRecord(effects.fx, "Fx effect").status !== "pending") {
          throw new Error("never-started ensure fixture unexpectedly started Companion or Fx")
        }
      }
    }

    const matchingCleanupRequests = cleanupRequests.filter((candidate) => candidate.ensure_id === request.ensure_id)
    const matchingCleanupReceipts = cleanupReceipts.filter((candidate) => candidate.ensure_id === request.ensure_id)
    if (matchingCleanupRequests.length !== 1 || matchingCleanupReceipts.length !== 1) {
      throw new Error(`ensure ${String(request.ensure_id)} lacks one independent cleanup request and receipt`)
    }
    const cleanupRequest = matchingCleanupRequests[0]!
    const cleanupReceipt = matchingCleanupReceipts[0]!
    assertCorrelation(endRequest, cleanupRequest, [
      ...lifecycleCorrelationFields(),
      "conversation_id",
      "end_id",
      "end_digest",
    ])
    if (cleanupRequest.worktree_directory !== planned.directory) {
      throw new Error("cleanup request does not name the immutable planned Worktree")
    }
    verifyRecordedDigest("cleanup request", cleanupRequest.cleanup_digest, cleanupSpecification(cleanupRequest))
    assertCorrelation(cleanupRequest, cleanupReceipt, [
      "request_id",
      ...lifecycleCorrelationFields(),
      "conversation_id",
      "end_id",
      "end_digest",
      "cleanup_id",
      "cleanup_digest",
      "worktree_directory",
    ])
    verifyReceiptDigest(cleanupReceipt)
    const outcome = asRecord(cleanupReceipt.outcome, "cleanup outcome")
    if (completed.length === 1 && outcome.kind !== "refused_dirty") {
      throw new Error("cleanup fixture must prove successful end and dirty Worktree refusal are independent")
    }
    if (completed.length === 0 && outcome.kind !== "removed") {
      throw new Error("cancelled partial launch fixture must prove independent Worktree cleanup")
    }
  }
  assertUnique(plannedCompanionSessions, "Companion session name")
  assertUnique(plannedCompanionPanes, "Companion pane id")
  if (completedTraces !== 1 || neverStartedTraces !== 1) {
    throw new Error("ensure fixtures must contain one completed and one definitively never-started trace")
  }

  const acknowledgedReceipts = [...ensureReceipts, ...endReceipts, ...cleanupReceipts]
  assertUnique(acknowledgedReceipts.map((entry) => String(entry.receipt_id)), "lifecycle receipt id")
  const acknowledgements = records(messages, "receipt_acknowledgement")
  if (acknowledgements.length !== acknowledgedReceipts.length) {
    throw new Error("every ensure/end/cleanup receipt requires one exact acknowledgement fixture")
  }
  assertUnique(acknowledgements.map((entry) => String(entry.acknowledgement_id)), "receipt acknowledgement id")
  for (const receipt of acknowledgedReceipts) {
    const expectedKind = receipt.message_type === "ensure_receipt"
      ? "ensure"
      : receipt.message_type === "end_receipt"
        ? "end"
        : "cleanup"
    const matches = acknowledgements.filter((acknowledgement) =>
      acknowledgement.receipt_id === receipt.receipt_id &&
      acknowledgement.receipt_digest === receipt.receipt_digest &&
      acknowledgement.receipt_kind === expectedKind &&
      acknowledgement.ensure_id === receipt.ensure_id
    )
    if (matches.length !== 1) throw new Error(`receipt ${String(receipt.receipt_id)} lacks its exact acknowledgement`)
  }
  for (const acknowledgement of acknowledgements) {
    const matches = acknowledgedReceipts.filter((receipt) => {
      const expectedKind = receipt.message_type === "ensure_receipt"
        ? "ensure"
        : receipt.message_type === "end_receipt"
          ? "end"
          : "cleanup"
      return acknowledgement.receipt_id === receipt.receipt_id &&
        acknowledgement.receipt_digest === receipt.receipt_digest &&
        acknowledgement.receipt_kind === expectedKind &&
        acknowledgement.ensure_id === receipt.ensure_id
    })
    if (matches.length !== 1) {
      throw new Error(`acknowledgement ${String(acknowledgement.acknowledgement_id)} is orphaned`)
    }
  }
}

function verifyFxLaunchAdmissionFinal(messages: AgentWorkplaceMessage[]): void {
  const launches = records(messages, "launch_request")
  if (launches.length !== 2) throw new Error("Fx boundary fixtures must cover admitted and cancelled launches")
  assertUnique(launches.map((entry) => String(entry.launch_id)), "Fx launch id")
  assertUnique(launches.map((entry) => String(entry.admission_key)), "Fx admission key")
  const launchReceipts = records(messages, "launch_receipt")
  const decisions = records(messages, "admission_decision")
  const cancellations = records(messages, "admission_cancel_request")
  const finals = records(messages, "final_receipt")
  const acknowledgements = records(messages, "final_receipt_acknowledgement")
  assertUnique(
    [...launches, ...cancellations].map((entry) => String(entry.request_id)),
    "Fx boundary request id",
  )
  assertUnique(
    [...launchReceipts, ...decisions, ...finals].map((entry) => String(entry.receipt_id)),
    "Fx boundary receipt id",
  )
  assertUnique(acknowledgements.map((entry) => String(entry.acknowledgement_id)), "Fx final acknowledgement id")
  const launchIds = new Set(launches.map((entry) => String(entry.launch_id)))
  if (messages.some((message) => !launchIds.has(String(asRecord(message, "Fx boundary message").launch_id)))) {
    throw new Error("Fx boundary fixture carries an orphan launch correlation")
  }

  for (const launch of launches) {
    verifyRecordedDigest("Fx launch request", launch.launch_digest, launchSpecification(launch))
    const correlated = messages.filter((candidate) =>
      asRecord(candidate, "Fx boundary message").launch_id === launch.launch_id
    )
    const receipts = records(correlated, "launch_receipt")
    const correlatedDecisions = records(correlated, "admission_decision")
    if (receipts.length !== 1 || correlatedDecisions.length !== 1) {
      throw new Error(`Fx launch ${String(launch.launch_id)} lacks one launch receipt and one decision`)
    }
    for (const candidate of correlated) {
      assertCorrelation(launch, candidate, ["launch_id", "launch_digest", "admission_key"])
    }
    if (receipts[0]!.request_id !== launch.request_id) {
      throw new Error("Fx launch receipt does not match its exact request")
    }

    verifyReceiptDigest(correlatedDecisions[0]!)
    const decision = asRecord(correlatedDecisions[0]!.decision, "admission decision")
    const correlatedCancellations = records(correlated, "admission_cancel_request")
    const correlatedFinals = records(correlated, "final_receipt")
    const correlatedAcknowledgements = records(correlated, "final_receipt_acknowledgement")
    if (decision.kind === "cancelled_before_start") {
      if (correlatedCancellations.length !== 1 ||
        decision.cancellation_request_id !== correlatedCancellations[0]!.request_id) {
        throw new Error("cancelled Fx decision is not keyed to its exact cancellation request")
      }
      if (correlatedFinals.length !== 0 || correlatedAcknowledgements.length !== 0) {
        throw new Error("cancelled-before-start Fx launch unexpectedly has a final Conversation receipt")
      }
    } else if (decision.kind === "admitted") {
      if (correlatedCancellations.length !== 0) throw new Error("admitted fixture unexpectedly carries cancellation")
      if (correlatedFinals.length !== 1 || correlatedAcknowledgements.length !== 1) {
        throw new Error("admitted Fx launch lacks one retained final receipt and acknowledgement")
      }
      const final = correlatedFinals[0]!
      const acknowledgement = correlatedAcknowledgements[0]!
      verifyReceiptDigest(final)
      assertCorrelation(final, acknowledgement, [
        "receipt_id",
        "receipt_digest",
        "launch_id",
        "launch_digest",
        "admission_key",
        "conversation_id",
      ])
    } else {
      throw new Error(`unknown admission decision kind: ${String(decision.kind)}`)
    }
  }
}

function verifyCrossFamilyCorrelation(
  runtimeMessages: AgentWorkplaceMessage[],
  defaultsMessages: AgentWorkplaceMessage[],
  lifecycleMessages: AgentWorkplaceMessage[],
  fxMessages: AgentWorkplaceMessage[],
): void {
  const snapshot = exactlyOne(runtimeMessages, "snapshot_result")
  const ensureRequests = records(lifecycleMessages, "ensure_request")
  const ensureReceipts = records(lifecycleMessages, "ensure_receipt")
  const endRequests = records(lifecycleMessages, "end_request")
  const endReceipts = records(lifecycleMessages, "end_receipt")
  const launches = records(fxMessages, "launch_request")
  const decisions = records(fxMessages, "admission_decision")
  const defaultsTable = exactlyOne(defaultsMessages, "defaults_table")
  const defaults = asRecords(defaultsTable.entries, "Agent-default entries")
  const snapshotAgents = asRecords(snapshot.agents, "snapshot Agents")

  for (const ensureRequest of ensureRequests) {
    const launch = launches.find((candidate) => candidate.launch_id === ensureRequest.launch_id)
    if (!launch) throw new Error("ensure fixture does not reference an exact Fx-owned launch")
    assertCorrelation(launch, ensureRequest, ["launch_id", "launch_digest"])

    const planned = asRecord(ensureRequest.planned_worktree, "planned Worktree")
    const requestedConversation = asRecord(ensureRequest.fx_conversation, "requested Fx Conversation")
    const resume = asRecord(launch.resume, "Fx resume target")
    if (launch.directory !== planned.directory || launch.conversation_name !== requestedConversation.name) {
      throw new Error("ensure fixture changes the Fx-owned launch directory or Conversation name")
    }
    const expectedResume = resume.mode === "exact" ? resume.conversation_id : null
    if (requestedConversation.resume_conversation_id !== expectedResume) {
      throw new Error("ensure fixture changes the Fx-owned exact resume target")
    }

    const matchingDefault = defaults.find((entry) => entry.fmx_session === ensureRequest.fmx_session)
    if (!matchingDefault || matchingDefault.state_dir !== launch.state_root ||
      matchingDefault.model !== launch.model || matchingDefault.effort !== launch.effort) {
      throw new Error("Fx launch controls do not match the fixture fmx Session defaults")
    }

    const correlatedReceipts = ensureReceipts.filter((receipt) => receipt.ensure_id === ensureRequest.ensure_id)
    const complete = correlatedReceipts.find((receipt) => receipt.status === "complete")
    const decisionReceipt = decisions.find((candidate) => candidate.launch_id === launch.launch_id)
    if (!decisionReceipt) throw new Error("ensure fixture lacks its exact Fx admission decision")
    const decision = asRecord(decisionReceipt.decision, "Fx admission decision")
    const endRequest = endRequests.find((candidate) => candidate.ensure_id === ensureRequest.ensure_id)!
    const endReceipt = endReceipts.find((candidate) => candidate.ensure_id === ensureRequest.ensure_id)!
    const proof = asRecord(endReceipt.proof, "cross-family end proof")
    const snapshotAgent = snapshotAgents.find((agent) => agent.agent_id === ensureRequest.agent_id)

    if (decision.kind === "admitted") {
      if (!complete) throw new Error("admitted Fx launch lacks its complete ensure receipt")
      const effects = asRecord(complete.effects, "complete ensure effects")
      const ensuredFx = asRecord(effects.fx, "complete Fx effect")
      const final = records(fxMessages, "final_receipt")
        .find((receipt) => receipt.launch_id === launch.launch_id)
      if (!final || final.conversation_id !== ensuredFx.conversation_id) {
        throw new Error("complete ensure fixture does not correlate the Fx-owned final Conversation")
      }
      if (!snapshotAgent || snapshotAgent.directory !== planned.directory ||
        snapshot.fmx_session !== ensureRequest.fmx_session) {
        throw new Error("Runtime snapshot does not contain the exact ensured Agent and Worktree")
      }
      const correlation = asRecord(snapshotAgent.correlation, "snapshot Agent correlation")
      assertCorrelation(ensureRequest, correlation, ["ensure_id", "ensure_digest", "launch_id", "launch_digest"])
      const snapshotConversation = asRecord(snapshotAgent.fx_conversation, "snapshot Fx Conversation")
      if (snapshotConversation.conversation_id !== final.conversation_id ||
        snapshotConversation.name !== launch.conversation_name) {
        throw new Error("Runtime snapshot does not contain the exact Fx-owned Conversation")
      }
    } else if (decision.kind === "cancelled_before_start") {
      if (complete || endRequest.conversation_id !== null || proof.kind !== "never_started") {
        throw new Error("cancelled Fx launch does not remain a never-started partial ensure")
      }
      if (proof.admission_receipt_id !== decisionReceipt.receipt_id ||
        proof.admission_receipt_digest !== decisionReceipt.receipt_digest ||
        proof.cancellation_request_id !== decision.cancellation_request_id) {
        throw new Error("never-started proof does not cite the exact authoritative Fx cancellation")
      }
      if (snapshotAgent) throw new Error("cancelled-before-start Agent unexpectedly remains in the Runtime snapshot")
    } else {
      throw new Error(`unknown cross-family admission decision: ${String(decision.kind)}`)
    }
  }
}

function lifecycleCorrelationFields(): string[] {
  return [
    "workplace_instance_id",
    "fmx_session",
    "ensure_id",
    "ensure_digest",
    "launch_id",
    "launch_digest",
    "worktree_id",
    "agent_id",
  ]
}

function ensureSpecification(request: Record<string, unknown>): Record<string, unknown> {
  return pick(request, [
    "workplace_instance_id",
    "fmx_session",
    "ensure_id",
    "launch_id",
    "launch_digest",
    "worktree_id",
    "agent_id",
    "planned_worktree",
    "fx_conversation",
  ])
}

function endSpecification(request: Record<string, unknown>): Record<string, unknown> {
  return pick(request, [
    ...lifecycleCorrelationFields(),
    "conversation_id",
    "end_id",
    "reason",
  ])
}

function cleanupSpecification(request: Record<string, unknown>): Record<string, unknown> {
  return pick(request, [
    ...lifecycleCorrelationFields(),
    "conversation_id",
    "end_id",
    "end_digest",
    "cleanup_id",
    "worktree_directory",
  ])
}

function launchSpecification(request: Record<string, unknown>): Record<string, unknown> {
  return pick(request, [
    "launch_id",
    "admission_key",
    "conversation_name",
    "resume",
    "state_root",
    "directory",
    "model",
    "effort",
    "initial_work_digest",
    "remaining_launch_controls_digest",
  ])
}

function verifyReceiptDigest(receipt: Record<string, unknown>): void {
  const content = { ...receipt }
  delete content.receipt_digest
  verifyRecordedDigest(`receipt ${String(receipt.receipt_id)}`, receipt.receipt_digest, content)
}

function verifyRecordedDigest(label: string, recorded: unknown, content: Record<string, unknown>): void {
  const actual = sha256(encodeCanonicalJson(content as JsonValue))
  if (recorded !== actual) throw new Error(`${label} digest is ${String(recorded)}; canonical content is ${actual}`)
}

function ensureEffectsComplete(receipt: Record<string, unknown>): boolean {
  const effects = asRecord(receipt.effects, "ensure effects")
  return asRecord(effects.worktree, "Worktree effect").status === "created" &&
    asRecord(effects.manifest, "Manifest effect").status === "claimed" &&
    asRecord(effects.companion, "Companion effect").status === "started" &&
    asRecord(effects.fx, "Fx effect").status === "started"
}

function records(messages: AgentWorkplaceMessage[], messageType: string): Record<string, unknown>[] {
  return messages.filter((message) => message.message_type === messageType).map((message) => asRecord(message, messageType))
}

function exactlyOne(messages: AgentWorkplaceMessage[], messageType: string): Record<string, unknown> {
  const matches = records(messages, messageType)
  if (matches.length !== 1) throw new Error(`fixture requires exactly one ${messageType}; found ${matches.length}`)
  return matches[0]!
}

function assertCorrelation(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (actual[field] !== expected[field]) throw new Error(`correlation mismatch for ${field}`)
  }
}

function pick(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) =>
    value[field] === undefined ? [] : [[field, value[field]]]
  ))
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`)
  return value as Record<string, unknown>
}

function asRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`)
  return value.map((entry) => asRecord(entry, label))
}

function asStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} is not a string array`)
  }
  return value as string[]
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`)
}

function withoutOneTrailingLf(bytes: Uint8Array, label: string): Uint8Array {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new Error(`${label} must end in exactly one LF`)
  }
  if (bytes.byteLength > 1 && bytes[bytes.byteLength - 2] === 0x0a) {
    throw new Error(`${label} has an empty trailing record`)
  }
  return bytes.subarray(0, -1)
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

if (import.meta.main) {
  try {
    const result = await verifyAgentWorkplaceContracts(process.argv[2])
    process.stdout.write(`${JSON.stringify({
      ...result,
      manifest_path: resolve(dirname(result.manifest_path), basename(result.manifest_path)),
    })}\n`)
  } catch (error) {
    process.stderr.write(`fmx AgentWorkplace contracts: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
