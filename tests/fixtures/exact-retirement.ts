import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  ensureLifecycleMessageSchema,
  type EnsureLifecycleMessage,
} from "../../src/agentworkplace-contracts.ts"
import type { EnsureLifecycleRecord, EnsureRequest } from "../../src/ensure-lifecycle-ledger.ts"
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
  return {
    ensure: {
      schema_id: "fmx.ensure-lifecycle-ledger",
      schema_version: 1,
      revision: 1,
      request: structuredClone(ensureRequest),
      stage: ensureId === "ensure-a" ? "fx_started" : "manifest_claimed",
      effects: structuredClone(ensureReceipt.effects),
      receipts: [],
      acknowledgements: [],
    },
    endRequest: structuredClone(endRequest),
    endReceipt: structuredClone(endReceipt),
    endAcknowledgement: structuredClone(endAcknowledgement),
    cleanupRequest: structuredClone(cleanupRequest),
    cleanupReceipt: structuredClone(cleanupReceipt),
    cleanupAcknowledgement: structuredClone(cleanupAcknowledgement),
  }
}

function required<T extends EnsureLifecycleMessage>(
  messages: EnsureLifecycleMessage[],
  predicate: (message: EnsureLifecycleMessage) => boolean,
): T {
  const result = messages.find(predicate)
  if (!result) throw new Error("frozen retirement fixture is incomplete")
  return result as T
}
