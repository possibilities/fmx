import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deriveLifecycleReceiptDigest,
  ExactRetirementLedger,
  retirementRecordPathFor,
  type ExactRetirementLedgerErrorCode,
  type ExactRetirementLedgerFaultPoint,
} from "../src/exact-retirement-ledger.ts"
import { retirementFixture } from "./fixtures/exact-retirement.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

async function ledgerRoot(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "fmx-retirement-ledger-test-"))
  const canonical = await realpath(scratch)
  roots.push(canonical)
  return join(canonical, "ledger")
}

async function expectLedgerError(
  operation: Promise<unknown>,
  code: ExactRetirementLedgerErrorCode,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: "ExactRetirementLedgerError",
    code,
  })
}

describe("private exact retirement ledger", () => {
  test("retains exact end, cleanup, and one acknowledgement each across reopen", async () => {
    const fixture = await retirementFixture("ensure-a")
    const root = await ledgerRoot()
    let ledger = await ExactRetirementLedger.open(root)
    const bound = await ledger.bindEnsure(fixture.ensure)
    expect(bound).toMatchObject({ revision: 1, ensure: { stage: "fx_started" }, end: null, cleanup: null })
    expect(await ledger.bindEnsure(structuredClone(fixture.ensure))).toEqual(bound)

    await ledger.beginEnd(fixture.endRequest)
    await ledger.markKillIntent(fixture.endRequest.ensure_id, "2026-08-30T19:59:58.000Z")
    await ledger.markKillWriteFlushed(fixture.endRequest.ensure_id, "2026-08-30T19:59:59.000Z")
    await ledger.retainEndReceipt(fixture.endReceipt)
    const ended = await ledger.acknowledge(fixture.endAcknowledgement)
    expect(ended).toMatchObject({
      revision: 6,
      end: {
        request: fixture.endRequest,
        receipt: fixture.endReceipt,
        acknowledgement: fixture.endAcknowledgement,
      },
    })

    await ledger.beginCleanup(fixture.cleanupRequest)
    await ledger.retainCleanupReceipt(fixture.cleanupReceipt)
    const completed = await ledger.acknowledge(fixture.cleanupAcknowledgement)
    expect(completed).toMatchObject({
      revision: 9,
      cleanup: {
        request: fixture.cleanupRequest,
        receipt: fixture.cleanupReceipt,
        acknowledgement: fixture.cleanupAcknowledgement,
      },
    })
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(retirementRecordPathFor(root, fixture.endRequest.ensure_id))).mode & 0o777).toBe(0o600)

    ledger = await ExactRetirementLedger.open(root)
    expect(await ledger.get(fixture.endRequest.ensure_id)).toEqual(completed)
    expect(await ledger.beginEnd(fixture.endRequest)).toEqual(completed)
    expect(await ledger.retainEndReceipt(fixture.endReceipt)).toEqual(completed)
    expect(await ledger.acknowledge(fixture.endAcknowledgement)).toEqual(completed)
    expect(await ledger.beginCleanup(fixture.cleanupRequest)).toEqual(completed)
    expect(await ledger.retainCleanupReceipt(fixture.cleanupReceipt)).toEqual(completed)
    expect(await ledger.acknowledge(fixture.cleanupAcknowledgement)).toEqual(completed)
  })

  test("receipt and acknowledgement ids are immutable and acknowledge a receipt once", async () => {
    const fixture = await retirementFixture("ensure-a")
    const root = await ledgerRoot()
    const ledger = await ExactRetirementLedger.open(root)
    await ledger.bindEnsure(fixture.ensure)
    await ledger.beginEnd(fixture.endRequest)
    await ledger.markKillIntent(fixture.endRequest.ensure_id, "2026-08-30T19:59:58.000Z")
    await ledger.retainEndReceipt(fixture.endReceipt)
    await ledger.acknowledge(fixture.endAcknowledgement)

    const changedReceipt = structuredClone(fixture.endReceipt)
    changedReceipt.proof.observed_at = "2026-08-30T20:00:02.000Z"
    changedReceipt.receipt_digest = deriveLifecycleReceiptDigest(changedReceipt)
    await expectLedgerError(ledger.retainEndReceipt(changedReceipt), "receipt_conflict")

    const secondAcknowledgement = structuredClone(fixture.endAcknowledgement)
    secondAcknowledgement.acknowledgement_id = "end-ack-a-second"
    await expectLedgerError(ledger.acknowledge(secondAcknowledgement), "acknowledgement_conflict")

    await ledger.beginCleanup(fixture.cleanupRequest)
    const reusedReceiptId = structuredClone(fixture.cleanupReceipt)
    reusedReceiptId.receipt_id = fixture.endReceipt.receipt_id
    reusedReceiptId.receipt_digest = deriveLifecycleReceiptDigest(reusedReceiptId)
    await expectLedgerError(ledger.retainCleanupReceipt(reusedReceiptId), "receipt_conflict")
    expect((await ledger.get(fixture.endRequest.ensure_id))?.end?.receipt).toEqual(fixture.endReceipt)
  })

  test("never-started proof remains an injected retained source and sends no Kill", async () => {
    const fixture = await retirementFixture("ensure-b")
    const root = await ledgerRoot()
    const ledger = await ExactRetirementLedger.open(root)
    await ledger.bindEnsure(fixture.ensure)
    await ledger.beginEnd(fixture.endRequest)
    await expectLedgerError(
      ledger.markKillIntent(fixture.endRequest.ensure_id, "2026-08-30T20:00:00.000Z"),
      "invalid_transition",
    )
    const retained = await ledger.retainEndReceipt(fixture.endReceipt)
    expect(retained).toMatchObject({
      revision: 3,
      end: { kill: null, receipt: { proof: { kind: "never_started" } } },
    })
  })

  test("every durable rename boundary leaves end intent wholly before or after", async () => {
    const fixture = await retirementFixture("ensure-a")
    const cases: Array<{ point: ExactRetirementLedgerFaultPoint; committed: boolean }> = [
      { point: "before_write", committed: false },
      { point: "after_file_sync", committed: false },
      { point: "before_rename", committed: false },
      { point: "after_rename", committed: true },
      { point: "after_directory_sync", committed: true },
    ]
    for (const { point, committed } of cases) {
      const root = await ledgerRoot()
      let armed = false
      const ledger = await ExactRetirementLedger.open(root, {
        fault: (candidate, record) => {
          if (armed && candidate === point && record.revision === 2) throw new Error(`crash:${point}`)
        },
      })
      await ledger.bindEnsure(fixture.ensure)
      armed = true
      await expect(ledger.beginEnd(fixture.endRequest)).rejects.toThrow(`crash:${point}`)
      const reopened = await ExactRetirementLedger.open(root)
      expect((await reopened.get(fixture.endRequest.ensure_id))?.end !== null, point).toBe(committed)
    }
  })

  test("refuses a permissive ledger root rather than changing its authority", async () => {
    const root = await ledgerRoot()
    await ExactRetirementLedger.open(root)
    await chmod(root, 0o755)
    await expectLedgerError(ExactRetirementLedger.open(root), "unsafe_storage")
  })
})
