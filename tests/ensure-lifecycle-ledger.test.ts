import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  ensureLifecycleMessageSchema,
  type EnsureLifecycleMessage,
} from "../src/agentworkplace-contracts.ts"
import { encodeCanonicalJson, type JsonValue } from "../src/contract-codec.ts"
import {
  deriveEnsureDigest,
  EnsureLifecycleLedger,
  recordPathFor,
  type EnsureLifecycleLedgerErrorCode,
  type EnsureLifecycleLedgerFaultPoint,
  type EnsureLifecycleRecord,
  type EnsureLifecycleTransition,
  type EnsureReceipt,
  type EnsureReceiptAcknowledgement,
  type EnsureRequest,
} from "../src/ensure-lifecycle-ledger.ts"

const CONTRACT_DIRECTORY = resolve(import.meta.dir, "../contracts/agentworkplace/v1")
const ENSURE_FIXTURE = resolve(CONTRACT_DIRECTORY, "ensure-lifecycle.jsonl")
const MANIFEST_FIXTURE = resolve(CONTRACT_DIRECTORY, "manifest.json")
const HEAD_COMMIT = "3".repeat(40)
const CONVERSATION_ID = "1788123456789-1788123456789000000-a1b2c3d4"
const scratchRoots: string[] = []

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

async function newLedgerRoot(): Promise<{ root: string; scratch: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "fmx-ensure-ledger-test-"))
  scratchRoots.push(scratch)
  return { root: join(scratch, "ledger"), scratch }
}

async function expectLedgerError(
  operation: Promise<unknown>,
  code: EnsureLifecycleLedgerErrorCode,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: "EnsureLifecycleLedgerError",
    code,
  })
}

async function fixtureA(): Promise<{
  request: EnsureRequest
  partialReceipt: EnsureReceipt
  partialAcknowledgement: EnsureReceiptAcknowledgement
  completeReceipt: EnsureReceipt
  completeAcknowledgement: EnsureReceiptAcknowledgement
}> {
  const messages = (await readFile(ENSURE_FIXTURE, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => ensureLifecycleMessageSchema.parse(JSON.parse(line)) as EnsureLifecycleMessage)
  const request = messages.find(
    (message): message is EnsureRequest =>
      message.message_type === "ensure_request" && message.ensure_id === "ensure-a",
  )
  const partialReceipt = messages.find(
    (message): message is EnsureReceipt =>
      message.message_type === "ensure_receipt" &&
      "status" in message &&
      "effects" in message &&
      "receipt_id" in message &&
      message.receipt_id === "ensure-receipt-a-partial",
  )
  const partialAcknowledgement = messages.find(
    (message): message is EnsureReceiptAcknowledgement =>
      message.message_type === "receipt_acknowledgement" &&
      "receipt_kind" in message &&
      "acknowledgement_id" in message &&
      message.receipt_kind === "ensure" &&
      message.acknowledgement_id === "ensure-ack-a-partial",
  )
  const completeReceipt = messages.find(
    (message): message is EnsureReceipt =>
      message.message_type === "ensure_receipt" &&
      "status" in message &&
      "effects" in message &&
      "receipt_id" in message &&
      message.receipt_id === "ensure-receipt-a-complete",
  )
  const completeAcknowledgement = messages.find(
    (message): message is EnsureReceiptAcknowledgement =>
      message.message_type === "receipt_acknowledgement" &&
      "receipt_kind" in message &&
      "acknowledgement_id" in message &&
      message.receipt_kind === "ensure" &&
      message.acknowledgement_id === "ensure-ack-a-complete",
  )
  if (
    !request ||
    !partialReceipt ||
    !partialAcknowledgement ||
    !completeReceipt ||
    !completeAcknowledgement
  ) {
    throw new Error("frozen ensure-a fixture is incomplete")
  }
  return {
    request: structuredClone(request),
    partialReceipt: structuredClone(partialReceipt),
    partialAcknowledgement: structuredClone(partialAcknowledgement),
    completeReceipt: structuredClone(completeReceipt),
    completeAcknowledgement: structuredClone(completeAcknowledgement),
  }
}

function distinctRequest(base: EnsureRequest, index: number): EnsureRequest {
  const serial = index.toString(16).padStart(4, "0")
  const request = structuredClone(base)
  request.request_id = `ensure-request-test-${serial}`
  request.ensure_id = `ensure-test-${serial}`
  request.launch_id = `launch-test-${serial}`
  request.worktree_id = `worktree-test-${serial}`
  request.agent_id = index.toString(16).padStart(32, "0")
  request.planned_worktree = {
    base_commit: request.planned_worktree.base_commit,
    branch: `fixture-ledger-${serial}`,
    directory: `/var/tmp/fmx-ensure-ledger-test-${serial}`,
    repository: `/var/tmp/fmx-ensure-ledger-repository-${serial}`,
  }
  request.fx_conversation = {
    name: `fixture-ledger-${serial}`,
    resume_conversation_id: request.fx_conversation.resume_conversation_id,
  }
  request.ensure_digest = deriveEnsureDigest(request)
  return request
}

function transitionsFor(
  request: EnsureRequest,
  headCommit: string = HEAD_COMMIT,
  conversationId: string = CONVERSATION_ID,
): EnsureLifecycleTransition[] {
  return [
    {
      kind: "worktree_created",
      directory: request.planned_worktree.directory,
      head_commit: headCommit,
    },
    { kind: "manifest_claimed", agent_id: request.agent_id },
    {
      kind: "companion_started",
      session_name: `fmx-${request.agent_id}`,
      pane_id: `p_${request.agent_id}`,
    },
    { kind: "fx_started", conversation_id: conversationId },
  ]
}

function receiptFor(record: EnsureLifecycleRecord, receiptId: string): EnsureReceipt {
  const status = record.stage === "fx_started" ? "complete" : "in_progress"
  const withoutDigest = {
    schema_id: "fmx.ensure-lifecycle",
    schema_version: 1,
    message_type: "ensure_receipt",
    request_id: record.request.request_id,
    receipt_id: receiptId,
    workplace_instance_id: record.request.workplace_instance_id,
    fmx_session: record.request.fmx_session,
    ensure_id: record.request.ensure_id,
    ensure_digest: record.request.ensure_digest,
    launch_id: record.request.launch_id,
    launch_digest: record.request.launch_digest,
    worktree_id: record.request.worktree_id,
    agent_id: record.request.agent_id,
    status,
    effects: structuredClone(record.effects),
  } as const
  return {
    ...withoutDigest,
    receipt_digest: createHash("sha256")
      .update(encodeCanonicalJson(withoutDigest as unknown as JsonValue))
      .digest("hex"),
  }
}

function acknowledgementFor(
  receipt: EnsureReceipt,
  acknowledgementId: string,
): EnsureReceiptAcknowledgement {
  return {
    schema_id: "fmx.ensure-lifecycle",
    schema_version: 1,
    message_type: "receipt_acknowledgement",
    acknowledgement_id: acknowledgementId,
    receipt_kind: "ensure",
    receipt_id: receipt.receipt_id,
    receipt_digest: receipt.receipt_digest,
    ensure_id: receipt.ensure_id,
  }
}

async function writeCanonicalRecord(path: string, record: EnsureLifecycleRecord): Promise<void> {
  const canonical = encodeCanonicalJson(record as unknown as JsonValue)
  await writeFile(path, Buffer.concat([Buffer.from(canonical), Buffer.from("\n")]), {
    mode: 0o600,
  })
}

async function populatedLedger(index: number): Promise<{
  ledger: EnsureLifecycleLedger
  request: EnsureRequest
  root: string
  scratch: string
}> {
  const { request: fixtureRequest } = await fixtureA()
  const request = distinctRequest(fixtureRequest, index)
  const { root, scratch } = await newLedgerRoot()
  const ledger = await EnsureLifecycleLedger.open(root)
  await ledger.claim(request)
  return { ledger, request, root, scratch }
}

async function completedFixtureLedger(): Promise<{
  path: string
  record: EnsureLifecycleRecord
  root: string
}> {
  const fixture = await fixtureA()
  const { root } = await newLedgerRoot()
  const ledger = await EnsureLifecycleLedger.open(root)
  await ledger.claim(fixture.request)
  const [worktree, manifest, companion, fx] = transitionsFor(
    fixture.request,
    fixture.request.planned_worktree.base_commit,
  )
  await ledger.advance(fixture.request.ensure_id, worktree!)
  await ledger.advance(fixture.request.ensure_id, manifest!)
  await ledger.retainEnsureReceipt(fixture.partialReceipt)
  await ledger.acknowledgeEnsureReceipt(fixture.partialAcknowledgement)
  await ledger.advance(fixture.request.ensure_id, companion!)
  await ledger.advance(fixture.request.ensure_id, fx!)
  await ledger.retainEnsureReceipt(fixture.completeReceipt)
  const record = await ledger.acknowledgeEnsureReceipt(fixture.completeAcknowledgement)
  return {
    path: recordPathFor(root, fixture.request.ensure_id),
    record,
    root,
  }
}

describe("private recoverable ensure lifecycle ledger", () => {
  test("binds an exact claim idempotently and refuses changed or reused identities", async () => {
    const { request: fixtureRequest } = await fixtureA()
    const request = distinctRequest(fixtureRequest, 1)
    const { root } = await newLedgerRoot()
    const ledger = await EnsureLifecycleLedger.open(root)

    const claimed = await ledger.claim(request)
    expect(claimed).toMatchObject({ revision: 1, stage: "claimed", request })
    expect(await ledger.claim(structuredClone(request))).toEqual(claimed)
    expect(await ledger.list()).toEqual([claimed])

    const changedRequestId = structuredClone(request)
    changedRequestId.request_id = "ensure-request-same-digest-different-call"
    expect(changedRequestId.ensure_digest).toBe(request.ensure_digest)
    expect(await ledger.claim(changedRequestId)).toEqual(claimed)

    const changedClaim = structuredClone(request)
    changedClaim.fx_conversation.name = "same-ensure-different-conversation"
    changedClaim.ensure_digest = deriveEnsureDigest(changedClaim)
    await expectLedgerError(ledger.claim(changedClaim), "conflicting_claim")

    const invalidDigest = structuredClone(request)
    invalidDigest.ensure_digest = "0".repeat(64)
    await expectLedgerError(ledger.claim(invalidDigest), "invalid_request")

    const collisions: Array<{
      label: string
      mutate: (candidate: EnsureRequest) => void
    }> = [
      {
        label: "launch id",
        mutate: (candidate) => {
          candidate.launch_id = request.launch_id
        },
      },
      {
        label: "Worktree id",
        mutate: (candidate) => {
          candidate.worktree_id = request.worktree_id
        },
      },
      {
        label: "Agent id",
        mutate: (candidate) => {
          candidate.agent_id = request.agent_id
        },
      },
      {
        label: "Worktree directory",
        mutate: (candidate) => {
          candidate.planned_worktree.directory = request.planned_worktree.directory
        },
      },
    ]
    for (const [offset, collision] of collisions.entries()) {
      const candidate = distinctRequest(fixtureRequest, 10 + offset)
      collision.mutate(candidate)
      candidate.ensure_digest = deriveEnsureDigest(candidate)
      await expectLedgerError(ledger.claim(candidate), "conflicting_claim")
      expect(await ledger.list(), collision.label).toHaveLength(1)
    }

    const reusedRequestId = distinctRequest(fixtureRequest, 19)
    reusedRequestId.request_id = request.request_id
    reusedRequestId.ensure_digest = deriveEnsureDigest(reusedRequestId)
    await expect(ledger.claim(reusedRequestId)).resolves.toMatchObject({
      request: reusedRequestId,
      stage: "claimed",
    })
    expect(await ledger.list()).toHaveLength(2)
  })

  test("advances exact effects monotonically and makes every completed step replay-safe", async () => {
    const { ledger, request } = await populatedLedger(20)
    const transitions = transitionsFor(request, HEAD_COMMIT, "conversation-alpha")

    await expectLedgerError(ledger.advance(request.ensure_id, transitions[1]!), "invalid_transition")
    for (const [index, transition] of transitions.entries()) {
      if (transition.kind === "fx_started") {
        await expectLedgerError(ledger.advance(request.ensure_id, {
          kind: "fx_started",
          conversation_id: "invalid/conversation",
        }), "invalid_transition")
      }
      const advanced = await ledger.advance(request.ensure_id, transition)
      expect(advanced.revision).toBe(index + 2)
      expect(advanced.stage).toBe(transition.kind)
      expect(await ledger.advance(request.ensure_id, structuredClone(transition))).toEqual(advanced)
    }

    await expectLedgerError(ledger.advance(request.ensure_id, {
      kind: "worktree_created",
      directory: request.planned_worktree.directory,
      head_commit: "4".repeat(40),
    }), "invalid_transition")
    await expectLedgerError(ledger.advance(request.ensure_id, {
      kind: "companion_started",
      session_name: `fmx-${request.agent_id}`,
      pane_id: `p_${"f".repeat(32)}`,
    }), "invalid_transition")
    expect(await ledger.get(request.ensure_id)).toMatchObject({
      revision: 5,
      stage: "fx_started",
      effects: {
        worktree: { status: "created", head_commit: HEAD_COMMIT },
        manifest: { status: "claimed", agent_id: request.agent_id },
        companion: { status: "started" },
        fx: { status: "started", conversation_id: "conversation-alpha" },
      },
    })
  })

  test("retains partial and complete receipts with exact acknowledgements across reopen", async () => {
    const fixture = await fixtureA()
    const { root } = await newLedgerRoot()
    let ledger = await EnsureLifecycleLedger.open(root)
    await ledger.claim(fixture.request)
    const [worktree, manifest, companion, fx] = transitionsFor(
      fixture.request,
      fixture.request.planned_worktree.base_commit,
    )
    await ledger.advance(fixture.request.ensure_id, worktree!)
    await ledger.advance(fixture.request.ensure_id, manifest!)
    await ledger.retainEnsureReceipt(fixture.partialReceipt)
    const partial = await ledger.acknowledgeEnsureReceipt(fixture.partialAcknowledgement)
    expect(partial).toMatchObject({
      revision: 5,
      stage: "manifest_claimed",
      receipts: [fixture.partialReceipt],
      acknowledgements: [fixture.partialAcknowledgement],
    })

    ledger = await EnsureLifecycleLedger.open(root)
    expect(await ledger.get(fixture.request.ensure_id)).toEqual(partial)
    expect(await ledger.retainEnsureReceipt(fixture.partialReceipt)).toEqual(partial)
    expect(await ledger.acknowledgeEnsureReceipt(fixture.partialAcknowledgement)).toEqual(partial)

    await ledger.advance(fixture.request.ensure_id, companion!)
    await ledger.advance(fixture.request.ensure_id, fx!)
    await ledger.retainEnsureReceipt(fixture.completeReceipt)
    const complete = await ledger.acknowledgeEnsureReceipt(fixture.completeAcknowledgement)
    expect(complete).toMatchObject({
      revision: 9,
      stage: "fx_started",
      receipts: [fixture.partialReceipt, fixture.completeReceipt],
      acknowledgements: [fixture.partialAcknowledgement, fixture.completeAcknowledgement],
    })
    expect(await ledger.retainEnsureReceipt(fixture.partialReceipt)).toEqual(complete)
    expect(await ledger.acknowledgeEnsureReceipt(fixture.partialAcknowledgement)).toEqual(complete)

    const duplicateAcknowledgement = structuredClone(fixture.completeAcknowledgement)
    duplicateAcknowledgement.acknowledgement_id = "ensure-ack-a-complete-duplicate"
    await expectLedgerError(
      ledger.acknowledgeEnsureReceipt(duplicateAcknowledgement),
      "acknowledgement_conflict",
    )

    const reopened = await EnsureLifecycleLedger.open(root)
    expect(await reopened.get(fixture.request.ensure_id)).toEqual(complete)
    expect(await reopened.retainEnsureReceipt(fixture.completeReceipt)).toEqual(complete)
    expect(await reopened.acknowledgeEnsureReceipt(fixture.completeAcknowledgement)).toEqual(complete)
  })

  test("recovers every mutation family across every deterministic durability boundary", async () => {
    const { request: fixtureRequest } = await fixtureA()
    const cases: Array<{
      point: EnsureLifecycleLedgerFaultPoint
      committed: boolean
    }> = [
      { point: "before_write", committed: false },
      { point: "after_file_sync", committed: false },
      { point: "before_rename", committed: false },
      { point: "after_rename", committed: true },
      { point: "after_directory_sync", committed: true },
    ]

    const families = ["claim", "advance", "receipt", "acknowledgement"] as const
    for (const [familyIndex, family] of families.entries()) {
      for (const [pointIndex, boundary] of cases.entries()) {
        const request = distinctRequest(fixtureRequest, 30 + familyIndex * 10 + pointIndex)
        const { root } = await newLedgerRoot()
        const clean = await EnsureLifecycleLedger.open(root)
        let beforeRevision: number | null = null
        let beforeStage: EnsureLifecycleRecord["stage"] | null = null
        let finalRevision = 1
        let finalStage: EnsureLifecycleRecord["stage"] = "claimed"
        let apply: (ledger: EnsureLifecycleLedger) => Promise<EnsureLifecycleRecord>

        if (family === "claim") {
          apply = (ledger) => ledger.claim(request)
        } else {
          await clean.claim(request)
          beforeRevision = 1
          beforeStage = "claimed"
          const worktree = transitionsFor(request)[0]!
          if (family === "advance") {
            finalRevision = 2
            finalStage = "worktree_created"
            apply = (ledger) => ledger.advance(request.ensure_id, worktree)
          } else {
            await clean.advance(request.ensure_id, worktree)
            await clean.advance(request.ensure_id, transitionsFor(request)[1]!)
            const current = (await clean.get(request.ensure_id))!
            const receipt = receiptFor(current, `receipt-${familyIndex}-${pointIndex}`)
            beforeRevision = 3
            beforeStage = "manifest_claimed"
            if (family === "receipt") {
              finalRevision = 4
              finalStage = "manifest_claimed"
              apply = (ledger) => ledger.retainEnsureReceipt(receipt)
            } else {
              await clean.retainEnsureReceipt(receipt)
              const acknowledgement = acknowledgementFor(
                receipt,
                `acknowledgement-${familyIndex}-${pointIndex}`,
              )
              beforeRevision = 4
              finalRevision = 5
              finalStage = "manifest_claimed"
              apply = (ledger) => ledger.acknowledgeEnsureReceipt(acknowledgement)
            }
          }
        }

        const marker = `${family} fault at ${boundary.point}`
        const faulted = await EnsureLifecycleLedger.open(root, {
          fault: (point) => {
            if (point === boundary.point) throw new Error(marker)
          },
        })
        await expect(apply(faulted)).rejects.toThrow(marker)

        const recovered = await EnsureLifecycleLedger.open(root)
        const durable = await recovered.get(request.ensure_id)
        if (boundary.committed) {
          expect(durable, marker).toMatchObject({ revision: finalRevision, stage: finalStage })
        } else if (beforeRevision === null) {
          expect(durable, marker).toBeNull()
        } else {
          expect(durable, marker).toMatchObject({ revision: beforeRevision, stage: beforeStage })
        }
        const replayed = await apply(recovered)
        expect(replayed, marker).toMatchObject({ revision: finalRevision, stage: finalStage })
        expect(await apply(recovered), marker).toEqual(replayed)
        expect(await recovered.list()).toHaveLength(1)
      }
    }
  })

  test("binds the locked file, root directory, and record target identities", async () => {
    const { request: fixtureRequest } = await fixtureA()
    {
      const request = distinctRequest(fixtureRequest, 70)
      const { root, scratch } = await newLedgerRoot()
      let swapped = false
      const ledger = await EnsureLifecycleLedger.open(root, {
        fault: async (point) => {
          if (point !== "before_write" || swapped) return
          swapped = true
          await rename(join(root, ".ensure-lifecycle.lock"), join(scratch, "displaced.lock"))
          await writeFile(join(root, ".ensure-lifecycle.lock"), "", { mode: 0o600 })
        },
      })
      await expectLedgerError(ledger.claim(request), "unsafe_storage")
      expect(await (await EnsureLifecycleLedger.open(root)).get(request.ensure_id)).toBeNull()
    }

    {
      const request = distinctRequest(fixtureRequest, 71)
      const { root, scratch } = await newLedgerRoot()
      let swapped = false
      const ledger = await EnsureLifecycleLedger.open(root, {
        fault: async (point) => {
          if (point !== "before_write" || swapped) return
          swapped = true
          await rename(root, join(scratch, "displaced-ledger"))
          await mkdir(root, { mode: 0o700 })
          await writeFile(join(root, ".ensure-lifecycle.lock"), "", { mode: 0o600 })
        },
      })
      await expectLedgerError(ledger.claim(request), "unsafe_storage")
      expect(await (await EnsureLifecycleLedger.open(root)).get(request.ensure_id)).toBeNull()
    }

    {
      const { ledger: initial, request, root, scratch } = await populatedLedger(72)
      const target = recordPathFor(root, request.ensure_id)
      const original = await readFile(target)
      let swapped = false
      const ledger = await EnsureLifecycleLedger.open(root, {
        fault: async (point) => {
          if (point !== "before_rename" || swapped) return
          swapped = true
          await rename(target, join(scratch, "displaced-record.json"))
          await writeFile(target, original, { mode: 0o600 })
        },
      })
      const transition = transitionsFor(request)[0]!
      await expectLedgerError(ledger.advance(request.ensure_id, transition), "unsafe_storage")
      const recovered = await EnsureLifecycleLedger.open(root)
      expect(await recovered.get(request.ensure_id)).toMatchObject({ revision: 1, stage: "claimed" })
      expect(await recovered.advance(request.ensure_id, transition)).toMatchObject({
        revision: 2,
        stage: "worktree_created",
      })
      expect(await initial.get(request.ensure_id)).toMatchObject({
        revision: 2,
        stage: "worktree_created",
      })
    }
  })

  test("rejects receipt histories that live mutations cannot produce", async () => {
    {
      const { path, record, root } = await completedFixtureLedger()
      const duplicate = structuredClone(record.acknowledgements.at(-1)!)
      duplicate.acknowledgement_id = "ensure-ack-a-complete-second"
      record.acknowledgements.push(duplicate)
      record.revision++
      await writeCanonicalRecord(path, record)
      await expectLedgerError(EnsureLifecycleLedger.open(root), "corrupt_record")
    }

    {
      const { path, record, root } = await completedFixtureLedger()
      record.receipts.reverse()
      await writeCanonicalRecord(path, record)
      await expectLedgerError(EnsureLifecycleLedger.open(root), "corrupt_record")
    }
  })

  test("fails closed on weak modes, links, corrupt records, and foreign entries", async () => {
    {
      const { request, root } = await populatedLedger(40)
      await chmod(recordPathFor(root, request.ensure_id), 0o644)
      await expectLedgerError(EnsureLifecycleLedger.open(root), "unsafe_storage")
    }

    {
      const { request, root, scratch } = await populatedLedger(41)
      const record = recordPathFor(root, request.ensure_id)
      const outside = join(scratch, "outside-record.json")
      await writeFile(outside, await readFile(record), { mode: 0o600 })
      await unlink(record)
      await symlink(outside, record)
      await expectLedgerError(EnsureLifecycleLedger.open(root), "corrupt_record")
    }

    {
      const { request, root, scratch } = await populatedLedger(42)
      await link(recordPathFor(root, request.ensure_id), join(scratch, "record-hardlink.json"))
      await expectLedgerError(EnsureLifecycleLedger.open(root), "unsafe_storage")
    }

    {
      const { request, root } = await populatedLedger(43)
      const record = recordPathFor(root, request.ensure_id)
      const persisted = JSON.parse(await readFile(record, "utf8")) as EnsureLifecycleRecord
      persisted.request.ensure_digest = "f".repeat(64)
      const canonical = encodeCanonicalJson(persisted as unknown as JsonValue)
      await writeFile(record, Buffer.concat([Buffer.from(canonical), Buffer.from("\n")]), {
        mode: 0o600,
      })
      await expectLedgerError(EnsureLifecycleLedger.open(root), "corrupt_record")
    }

    {
      const { root } = await newLedgerRoot()
      await EnsureLifecycleLedger.open(root)
      await writeFile(join(root, "foreign.txt"), "foreign\n", { mode: 0o600 })
      await expectLedgerError(EnsureLifecycleLedger.open(root), "corrupt_record")
    }

    {
      const { root, scratch } = await newLedgerRoot()
      const target = join(scratch, "real-ledger")
      await mkdir(target, { mode: 0o700 })
      await symlink(target, root, "dir")
      await expectLedgerError(EnsureLifecycleLedger.open(root), "unsafe_storage")
    }
  })

  test("serializes exact and conflicting claims within and across store instances", async () => {
    const { request: fixtureRequest } = await fixtureA()
    {
      const request = distinctRequest(fixtureRequest, 50)
      const { root } = await newLedgerRoot()
      const ledger = await EnsureLifecycleLedger.open(root)
      const claims = await Promise.all(
        Array.from({ length: 12 }, () => ledger.claim(structuredClone(request))),
      )
      expect(claims.every((claim) => claim.revision === 1 && claim.stage === "claimed")).toBe(true)
      expect(await ledger.list()).toHaveLength(1)
    }

    {
      const request = distinctRequest(fixtureRequest, 51)
      const { root } = await newLedgerRoot()
      const first = await EnsureLifecycleLedger.open(root)
      const second = await EnsureLifecycleLedger.open(root)
      const claims = await Promise.all([first.claim(request), second.claim(structuredClone(request))])
      expect(claims[0]).toEqual(claims[1])
      expect(await first.list()).toHaveLength(1)
    }

    {
      const left = distinctRequest(fixtureRequest, 52)
      const right = distinctRequest(fixtureRequest, 53)
      right.agent_id = left.agent_id
      right.ensure_digest = deriveEnsureDigest(right)
      const { root } = await newLedgerRoot()
      const first = await EnsureLifecycleLedger.open(root)
      const second = await EnsureLifecycleLedger.open(root)
      const outcomes = await Promise.allSettled([first.claim(left), second.claim(right)])
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      )
      expect(failure?.reason).toMatchObject({
        name: "EnsureLifecycleLedgerError",
        code: "conflicting_claim",
      })
      expect(await (await EnsureLifecycleLedger.open(root)).list()).toHaveLength(1)
    }
  })

  test("leaves the frozen public ensure contract and manifest byte-identical", async () => {
    const ensureBytes = await readFile(ENSURE_FIXTURE)
    const manifestBytes = await readFile(MANIFEST_FIXTURE)
    expect(ensureBytes.byteLength).toBe(13_905)
    expect(createHash("sha256").update(ensureBytes).digest("hex")).toBe(
      "97c7bbd64cb81186f2bfc8268be48e6152955d0ed6f2336b4061004df93c93a2",
    )
    expect(manifestBytes.byteLength).toBe(1_008)
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(
      "e02dca149a4b1875eb9dedc1f07fc21cb91d106d0844eacb1806960531e6e17f",
    )
  })
})
