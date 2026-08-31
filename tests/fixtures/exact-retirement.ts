import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  ensureLifecycleMessageSchema,
  type EnsureLifecycleMessage,
} from "../../src/agentworkplace-contracts.ts"
import type { EnsureLifecycleRecord, EnsureRequest } from "../../src/ensure-lifecycle-ledger.ts"
import { deriveFxAdmissionDecisionDigest, type FxAdmissionDecision } from "../../src/ensure-lifecycle-ledger.ts"
import type {
  CleanupReceipt,
  CleanupRequest,
  EndReceipt,
  EndRequest,
  RetirementReceiptAcknowledgement,
} from "../../src/exact-retirement-ledger.ts"

const FIXTURE = resolve(import.meta.dir, "../../contracts/agentworkplace/v1/ensure-lifecycle.jsonl")

export type RetirementFixture = {
  ensure: EnsureLifecycleRecord
  endRequest: EndRequest
  endReceipt: EndReceipt
  endAcknowledgement: RetirementReceiptAcknowledgement
  cleanupRequest: CleanupRequest
  cleanupReceipt: CleanupReceipt
  cleanupAcknowledgement: RetirementReceiptAcknowledgement
}

export async function retirementFixture(
  ensureId: "ensure-a" | "ensure-b" = "ensure-a",
): Promise<RetirementFixture> {
  const messages = (await readFile(FIXTURE, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => ensureLifecycleMessageSchema.parse(JSON.parse(line)) as EnsureLifecycleMessage)
    .filter((message) => "ensure_id" in message && message.ensure_id === ensureId)
  const ensureRequest = required<EnsureRequest>(messages, (message) =>
    message.message_type === "ensure_request" && "planned_worktree" in message)
  const ensureReceipt = required<Extract<EnsureLifecycleMessage, { effects: unknown }>>(messages, (message) =>
    message.message_type === "ensure_receipt" && "effects" in message &&
    (ensureId === "ensure-a" ? message.status === "complete" : message.status === "in_progress"))
  const endRequest = required<EndRequest>(messages, (message) =>
    message.message_type === "end_request" && "reason" in message)
  const endReceipt = required<EndReceipt>(messages, (message) =>
    message.message_type === "end_receipt" && "proof" in message)
  const endAcknowledgement = required<RetirementReceiptAcknowledgement>(messages, (message) =>
    message.message_type === "receipt_acknowledgement" && "receipt_kind" in message &&
    message.receipt_kind === "end")
  const cleanupRequest = required<CleanupRequest>(messages, (message) =>
    message.message_type === "cleanup_request" && "cleanup_id" in message && !("outcome" in message))
  const cleanupReceipt = required<CleanupReceipt>(messages, (message) =>
    message.message_type === "cleanup_receipt" && "outcome" in message)
  const cleanupAcknowledgement = required<RetirementReceiptAcknowledgement>(messages, (message) =>
    message.message_type === "receipt_acknowledgement" && "receipt_kind" in message &&
    message.receipt_kind === "cleanup")
  const fxStarted = ensureId === "ensure-a"
  const admissionBinding = { admission_key: "retirement-admission", state_root: "/var/tmp/fmx-retirement-state" }
  const admissionDecision = fxStarted
    ? admissionDecisionFor(ensureRequest, admissionBinding)
    : null
  return {
    ensure: {
      schema_id: "fmx.ensure-lifecycle-ledger",
      schema_version: 3,
      revision: fxStarted ? 7 : 1,
      request: structuredClone(ensureRequest),
      stage: ensureId === "ensure-a" ? "fx_started" : "manifest_claimed",
      effects: structuredClone(ensureReceipt.effects),
      receipts: [],
      acknowledgements: [],
      fx_admission_decision: admissionDecision,
      fx_final: {
        binding: fxStarted ? admissionBinding : null,
        receipt: null,
        acknowledgement: null,
        acknowledgement_applied: false,
      },
    },
    endRequest: structuredClone(endRequest),
    endReceipt: structuredClone(endReceipt),
    endAcknowledgement: structuredClone(endAcknowledgement),
    cleanupRequest: structuredClone(cleanupRequest),
    cleanupReceipt: structuredClone(cleanupReceipt),
    cleanupAcknowledgement: structuredClone(cleanupAcknowledgement),
  }
}

function admissionDecisionFor(
  request: EnsureRequest,
  binding: { admission_key: string; state_root: string },
): FxAdmissionDecision {
  const decision = {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "admission_decision",
    receipt_id: "retirement-admission-receipt",
    receipt_digest: "",
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    admission_key: binding.admission_key,
    decision: { kind: "admitted", turn_id: "1", disposition: "queued" },
  } as const
  return { ...decision, receipt_digest: deriveFxAdmissionDecisionDigest(decision) }
}

function required<T extends EnsureLifecycleMessage>(
  messages: EnsureLifecycleMessage[],
  predicate: (message: EnsureLifecycleMessage) => boolean,
): T {
  const result = messages.find(predicate)
  if (!result) throw new Error("frozen retirement fixture is incomplete")
  return result as T
}
