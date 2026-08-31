import { createHash } from "node:crypto"
import { encodeCanonicalJson, type JsonValue } from "./contract-codec.ts"
import type {
  EnsureLifecycleRecord,
  EnsureReceipt,
} from "./ensure-lifecycle-ledger.ts"

/** A deterministic current-state receipt builder for the frozen v1 lifecycle link. */
export class EnsureLifecycleReceiptCollisionError extends Error {
  constructor(readonly receiptId: string) {
    super(`ensure receipt id ${receiptId} is already retained with different bytes`)
    this.name = "EnsureLifecycleReceiptCollisionError"
  }
}

/**
 * Build the one receipt which describes this exact durable stage. Its identity
 * includes the immutable correlation plus the stage and effects, so recovery
 * redrives the same receipt while a later transition gets another one.
 *
 * Returning null is deliberately narrow: only the same generated receipt
 * already retained by the ledger suppresses another publication attempt.
 */
export function buildEnsureLifecycleReceipt(record: EnsureLifecycleRecord): EnsureReceipt | null {
  const withoutIdentity = receiptWithoutIdentity(record)
  const receiptId = `ensure-receipt-${digest({
    stage: record.stage,
    receipt: withoutIdentity,
  })}`
  const withoutDigest = { ...withoutIdentity, receipt_id: receiptId }
  const receipt: EnsureReceipt = {
    ...withoutDigest,
    receipt_digest: digest(withoutDigest),
  }
  const retained = record.receipts.find((candidate) => candidate.receipt_id === receiptId)
  if (retained === undefined) return receipt
  if (sameCanonical(retained, receipt)) return null
  throw new EnsureLifecycleReceiptCollisionError(receiptId)
}

function receiptWithoutIdentity(record: EnsureLifecycleRecord): Omit<EnsureReceipt, "receipt_id" | "receipt_digest"> {
  return {
    schema_id: "fmx.ensure-lifecycle",
    schema_version: 1,
    message_type: "ensure_receipt",
    request_id: record.request.request_id,
    workplace_instance_id: record.request.workplace_instance_id,
    fmx_session: record.request.fmx_session,
    ensure_id: record.request.ensure_id,
    ensure_digest: record.request.ensure_digest,
    launch_id: record.request.launch_id,
    launch_digest: record.request.launch_digest,
    worktree_id: record.request.worktree_id,
    agent_id: record.request.agent_id,
    status: record.stage === "fx_started" ? "complete" : "in_progress",
    effects: structuredClone(record.effects),
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(encodeCanonicalJson(value as JsonValue))
    .digest("hex")
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalJson(left as JsonValue))
    .equals(Buffer.from(encodeCanonicalJson(right as JsonValue)))
}
