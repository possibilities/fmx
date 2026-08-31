import { createHash } from "node:crypto"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  ensureLifecycleMessageSchema,
  type EnsureLifecycleMessage,
} from "../src/agentworkplace-contracts.ts"
import { encodeCanonicalJson, type JsonValue } from "../src/contract-codec.ts"
import {
  buildEnsureLifecycleReceipt,
  EnsureLifecycleReceiptCollisionError,
} from "../src/ensure-lifecycle-receipt.ts"
import {
  EnsureLifecycleLedger,
  type EnsureLifecycleRecord,
  type EnsureRequest,
} from "../src/ensure-lifecycle-ledger.ts"

const FIXTURE = resolve(import.meta.dir, "../contracts/agentworkplace/v1/ensure-lifecycle.jsonl")
const scratchRoots: string[] = []

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("builds deterministic canonical partial and complete receipts, suppressing only an exact retained receipt", async () => {
  const ledger = await EnsureLifecycleLedger.open(await ledgerRoot())
  const request = await fixtureRequest()
  await ledger.claim(request)

  const claimed = (await ledger.get(request.ensure_id))!
  const partial = buildEnsureLifecycleReceipt(claimed)
  expect(partial).not.toBeNull()
  expect(partial).toMatchObject({
    message_type: "ensure_receipt",
    status: "in_progress",
    effects: claimed.effects,
  })
  expect(partial!.receipt_id).toMatch(/^ensure-receipt-[0-9a-f]{64}$/u)
  expect(partial!.receipt_digest).toBe(canonicalReceiptDigest(partial!))
  expect(buildEnsureLifecycleReceipt(claimed)).toEqual(partial)

  await ledger.retainEnsureReceipt(partial!)
  const retainedPartial = (await ledger.get(request.ensure_id))!
  expect(buildEnsureLifecycleReceipt(retainedPartial)).toBeNull()

  const completeRecord: EnsureLifecycleRecord = {
    ...retainedPartial,
    stage: "fx_started",
    effects: {
      worktree: {
        status: "created",
        directory: request.planned_worktree.directory,
        head_commit: request.planned_worktree.base_commit,
      },
      manifest: { status: "claimed", agent_id: request.agent_id },
      companion: {
        status: "started",
        session_name: `fmx-${request.agent_id}`,
        pane_id: `p_${request.agent_id}`,
      },
      fx: { status: "started", conversation_id: "conversation-receipt" },
    },
  }
  const complete = buildEnsureLifecycleReceipt(completeRecord)
  expect(complete).not.toBeNull()
  expect(complete).toMatchObject({ status: "complete" })
  expect(complete!.receipt_id).not.toBe(partial!.receipt_id)
  expect(complete!.receipt_digest).toBe(canonicalReceiptDigest(complete!))
})

test("fails closed if the generated receipt id is occupied by different retained bytes", async () => {
  const ledger = await EnsureLifecycleLedger.open(await ledgerRoot())
  const request = await fixtureRequest()
  await ledger.claim(request)
  const record = (await ledger.get(request.ensure_id))!
  const receipt = buildEnsureLifecycleReceipt(record)!
  const colliding: EnsureLifecycleRecord = {
    ...record,
    receipts: [{ ...receipt, status: "complete" }],
  }

  expect(() => buildEnsureLifecycleReceipt(colliding)).toThrow(EnsureLifecycleReceiptCollisionError)
})

async function fixtureRequest(): Promise<EnsureRequest> {
  const messages = (await readFile(FIXTURE, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => ensureLifecycleMessageSchema.parse(JSON.parse(line)) as EnsureLifecycleMessage)
  const request = messages.find((message): message is EnsureRequest =>
    message.message_type === "ensure_request" && "planned_worktree" in message
  )
  if (!request) throw new Error("frozen ensure fixture is incomplete")
  return structuredClone(request)
}

async function ledgerRoot(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "fmx-ensure-lifecycle-receipt-"))
  scratchRoots.push(root)
  return join(root, "ledger")
}

function canonicalReceiptDigest(receipt: { receipt_digest: string }): string {
  const { receipt_digest: _digest, ...withoutDigest } = receipt
  return createHash("sha256")
    .update(encodeCanonicalJson(withoutDigest as JsonValue))
    .digest("hex")
}
