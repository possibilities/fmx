import { afterEach, describe, expect, test } from "bun:test"
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fxLaunchAdmissionFinalMessageSchema,
  type FxLaunchAdmissionFinalMessage,
} from "../src/agentworkplace-contracts.ts"
import { encodeCanonicalJson, type JsonValue } from "../src/contract-codec.ts"
import {
  deriveFxAdmissionDecisionDigest,
  EnsureLifecycleLedger,
  type FxAdmissionDecision,
} from "../src/ensure-lifecycle-ledger.ts"
import {
  deriveFrozenLaunchDigest,
  encodeInlineSourceBytes,
  InlineLaunchSourceLedger,
  type FrozenLaunchRequest,
} from "../src/inline-launch-source.ts"
import {
  LifecycleCoordinator,
  type AdmittedFxAdmissionDecision,
  type LifecycleCoordinatorPorts,
} from "../src/lifecycle-coordinator.ts"
import {
  decodeManagedLaunchPayload,
  deriveManagedExactResumeDecisionDigest,
  deriveManagedExactResumeDecisionId,
  deriveManagedLaunchEnsureDigest,
  deriveManagedLaunchOutcomeDigest,
  deriveManagedLaunchSourceDigest,
  encodeManagedLaunchPayload,
  parseManagedLaunchOutcome,
  parseManagedLaunchRequest,
  type ManagedLaunchAcknowledgement,
  type ManagedLaunchOutcome,
  type ManagedLaunchRequest,
  type ManagedLaunchRetry,
} from "../src/managed-launch-contract.ts"
import type { FxWorkControlResult } from "../src/fx-work-control.ts"

const CONTRACT_ROOT = join(import.meta.dir, "../contracts/agentworkplace/v1")
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
  temporaryDirectories.clear()
})

describe("managed-launch v1 codec", () => {
  test("accepts only canonical, correlated existing-directory requests", async () => {
    const request = await managedRequest("codec")
    expect(parseManagedLaunchRequest(request)).toEqual(request)
    expect(decodeManagedLaunchPayload(encodeManagedLaunchPayload(request))).toEqual(request)

    const noncanonical = Buffer.from(JSON.stringify(request, null, 2), "utf8")
    expect(() => decodeManagedLaunchPayload(noncanonical)).toThrow("canonical JSON")

    expect(() => parseManagedLaunchRequest({ ...request, unexpected: true })).toThrow()
    expect(() => parseManagedLaunchRequest({
      ...request,
      workspace: { ...request.workspace, directory: "/var/tmp/repository/../escape" },
    })).toThrow()
    expect(() => parseManagedLaunchRequest({ ...request, launch_id: "different-launch" })).toThrow(
      "correlation",
    )
    expect(() => parseManagedLaunchRequest({ ...request, ensure_digest: "0".repeat(64) })).toThrow(
      "ensure digest",
    )
  })

  test("requires exact-resume proof, permanent classification, and certainty together", async () => {
    const request = await managedRequest("proof")
    const proof = exactResumeProof(request)
    const outcome = managedOutcome(request, {
      classification: "permanent",
      stage: "launch_provider",
      cause: "exact_resume_refused",
      process_certainty: "not_started",
      exact_resume_proof: proof,
    })
    expect(parseManagedLaunchOutcome(outcome)).toEqual(outcome)
    expect(() => parseManagedLaunchOutcome({
      ...outcome,
      classification: "retryable",
    })).toThrow("permanent exact-resume refusal")
    expect(() => parseManagedLaunchOutcome({
      ...outcome,
      process_certainty: "may_have_started",
    })).toThrow("must prove that no process started")
    const invalidProofOutcome: ManagedLaunchOutcome = {
      ...outcome,
      exact_resume_proof: { ...proof, decision_digest: "1".repeat(64) },
    }
    invalidProofOutcome.receipt_digest = deriveManagedLaunchOutcomeDigest(invalidProofOutcome)
    expect(() => parseManagedLaunchOutcome(invalidProofOutcome)).toThrow(
      "semantic decision has an invalid digest",
    )
  })
})

describe("managed-launch durable transaction", () => {
  test("survives a post-rename crash and retains an exact acknowledged outcome", async () => {
    const root = await temporaryDirectory()
    const request = await managedRequest("crash")
    let injected = false
    const crashing = await EnsureLifecycleLedger.open(join(root, "ensure"), {
      managedFault: (point) => {
        if (!injected && point === "after_rename") {
          injected = true
          throw new Error("crash after managed rename")
        }
      },
    })
    await expect(crashing.claimManaged(request)).rejects.toThrow("crash after managed rename")

    const reopened = await EnsureLifecycleLedger.open(join(root, "ensure"))
    expect((await reopened.getManaged(request.ensure_id))?.request).toEqual(request)
    const replayedClaim = await reopened.claimManaged(request)
    const persistedClaim = await reopened.getManaged(request.ensure_id)
    expect(persistedClaim).not.toBeNull()
    expect(encodeCanonicalJson(replayedClaim as unknown as JsonValue)).toEqual(
      encodeCanonicalJson(persistedClaim as unknown as JsonValue),
    )
    await expect(reopened.claimManaged({ ...request, request_id: "conflicting-request" }))
      .rejects.toMatchObject({ code: "conflicting_claim" })

    const outcome = managedOutcome(request)
    const retained = await reopened.retainManagedOutcome(request.ensure_id, outcome)
    expect(retained.outcome.receipt).toEqual(outcome)
    const again = await EnsureLifecycleLedger.open(join(root, "ensure"))
    expect((await again.getManaged(request.ensure_id))?.outcome.receipt).toEqual(outcome)
    const acknowledgement = managedAcknowledgement(outcome)
    const acknowledged = await again.acknowledgeManagedOutcome(acknowledgement)
    expect(acknowledged.outcome.acknowledgement).toEqual(acknowledgement)
    expect(await again.acknowledgeManagedOutcome(acknowledgement)).toEqual(acknowledged)
  })

  test("uses no Worktree or retirement effect and replays an outcome only until acknowledgement", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("replay")
    const published: ManagedLaunchOutcome[] = []
    const forbidden: string[] = []
    const ports = managedPorts(published, forbidden, { failValidation: true })
    const first = new LifecycleCoordinator({ ledger, sources, ports })
    await first.acceptManaged(request)
    await first.settled()
    expect(forbidden.filter((value) => value.startsWith("forbidden-"))).toEqual([])
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      ensure_id: request.ensure_id,
      classification: "retryable",
      stage: "existing_directory",
      cause: "git_identity_changed",
      process_certainty: "not_started",
    })

    const replay = new LifecycleCoordinator({ ledger, sources, ports })
    await replay.recover()
    await replay.settled()
    expect(published).toHaveLength(2)
    await replay.acceptManaged(managedAcknowledgement(published[0]!))
    await replay.recover()
    await replay.settled()
    expect(published).toHaveLength(2)
    expect(forbidden.filter((value) => value.startsWith("forbidden-"))).toEqual([])
  })

  test("advances the existing-directory provider and Companion path without cleanup", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("success")
    const observed: string[] = []
    const published: ManagedLaunchOutcome[] = []
    const ports = managedPorts(published, observed)
    const coordinator = new LifecycleCoordinator({ ledger, sources, ports })
    await coordinator.acceptManaged(request)
    await coordinator.settled()
    expect(observed).toEqual([
      "existing-directory",
      "manifest",
      "prepare",
      "companion",
      "prepare",
      "work-control:managed hello",
      "inspect",
    ])
    expect((await ledger.getManaged(request.ensure_id))?.stage).toBe("fx_started")
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      status: "succeeded",
      classification: null,
      stage: "fx_admission",
      process_certainty: "started",
      success: {
        conversation_id: request.fx_conversation.resume_conversation_id,
        admission_receipt_id: `managed-admission-${request.ensure_id}`,
      },
    })
    expect((await ledger.getManaged(request.ensure_id))?.outcome.receipt).toEqual(published[0])
  })

  test("appends an acknowledged retryable attempt and redrives the exact launch to success", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("retrysuccess")
    const published: ManagedLaunchOutcome[] = []
    const first = new LifecycleCoordinator({
      ledger,
      sources,
      ports: managedPorts(published, [], { failValidation: true }),
    })
    await first.acceptManaged(request)
    await first.settled()
    const failed = published[0]!
    await first.acceptManaged(managedAcknowledgement(failed))

    const second = new LifecycleCoordinator({ ledger, sources, ports: managedPorts(published, []) })
    const retry = managedRetry(failed)
    await second.acceptManaged(retry)
    await second.settled()
    expect(published.map((outcome) => [outcome.attempt, outcome.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ])
    const record = await ledger.getManaged(request.ensure_id)
    expect(record?.attempt).toBe(2)
    expect(record?.outcome_history).toHaveLength(1)
    expect(record?.outcome_history[0]?.receipt).toEqual(failed)
    expect(record?.outcome.receipt).toEqual(published[1])
    expect(record?.outcome_history[0]?.retry).toEqual(retry)

    await second.acceptManaged(retry)
    await expect(second.acceptManaged({
      ...retry,
      request_id: "conflicting-retry-request",
    })).rejects.toMatchObject({ code: "conflicting_claim" })

    const reopened = await EnsureLifecycleLedger.open(join(root, "ensure"))
    expect((await reopened.getManaged(request.ensure_id))?.outcome_history[0]?.receipt).toEqual(failed)
  })

  test("reconciles an uncertain Companion attempt through the same identity before succeeding", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("uncertain")
    const published: ManagedLaunchOutcome[] = []
    const first = new LifecycleCoordinator({
      ledger,
      sources,
      ports: managedPorts(published, [], { failCompanion: true }),
    })
    await first.acceptManaged(request)
    await first.settled()
    expect(published[0]).toMatchObject({
      status: "failed",
      classification: "uncertain",
      stage: "companion_start",
      process_certainty: "may_have_started",
    })
    await first.acceptManaged(managedAcknowledgement(published[0]!))
    const second = new LifecycleCoordinator({ ledger, sources, ports: managedPorts(published, []) })
    await second.acceptManaged(managedRetry(published[0]!))
    await second.settled()
    expect(published[1]).toMatchObject({ attempt: 2, status: "succeeded" })
  })

  test("never regresses process certainty after an uncertain Companion retry", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("certainty")
    const published: ManagedLaunchOutcome[] = []
    const first = new LifecycleCoordinator({
      ledger,
      sources,
      ports: managedPorts(published, [], { failCompanion: true }),
    })
    await first.acceptManaged(request)
    await first.settled()
    await first.acceptManaged(managedAcknowledgement(published[0]!))

    const second = new LifecycleCoordinator({
      ledger,
      sources,
      ports: managedPorts(published, [], { failPrepare: true }),
    })
    await second.acceptManaged(managedRetry(published[0]!))
    await second.settled()
    expect(published[1]).toMatchObject({
      attempt: 2,
      status: "failed",
      classification: "retryable",
      stage: "launch_provider",
      cause: "launch_provider_unavailable",
      process_certainty: "may_have_started",
    })
  })

  test("refuses retry before acknowledgement and after semantic permanent refusal", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const request = await managedRequest("noretry")
    const failed = managedOutcome(request)
    await ledger.claimManaged(request)
    await ledger.retainManagedOutcome(request.ensure_id, failed)
    await expect(ledger.retryManaged(managedRetry(failed))).rejects.toMatchObject({
      code: "invalid_request",
    })

    const semantic = exactResumeProof(request)
    const permanent = managedOutcome(request, {
      classification: "permanent",
      stage: "launch_provider",
      cause: "exact_resume_refused",
      process_certainty: "not_started",
      exact_resume_proof: semantic,
    })
    const otherRoot = await temporaryDirectory()
    const other = await EnsureLifecycleLedger.open(join(otherRoot, "ensure"))
    await other.claimManaged(request)
    await other.retainManagedOutcome(request.ensure_id, permanent)
    await other.acknowledgeManagedOutcome(managedAcknowledgement(permanent))
    await expect(other.retryManaged(managedRetry(permanent))).rejects.toMatchObject({
      code: "invalid_request",
    })
  })
})

function managedPorts(
  published: ManagedLaunchOutcome[],
  observed: string[],
  options: { failValidation?: boolean; failPrepare?: boolean; failCompanion?: boolean } = {},
): LifecycleCoordinatorPorts {
  return {
    worktree: { create: async () => {
      observed.push("forbidden-worktree")
      throw new Error("managed launch must not create a Worktree")
    } },
    manifest: {
      claim: async () => { throw new Error("frozen manifest path is forbidden") },
      workControl: async () => { throw new Error("frozen Work-control path is forbidden") },
    },
    launch: { prepare: async () => { throw new Error("frozen launch path is forbidden") } },
    companion: { start: async () => { throw new Error("frozen Companion path is forbidden") } },
    workControl: { admitInitial: async () => { throw new Error("frozen admission path is forbidden") } },
    admission: { import: async () => ({ kind: "pending" }) },
    cancellation: { beginStart: async () => ({
      kind: "start",
      lease: { release() {} },
    }) },
    retirement: {
      afterFinalReceipt: async () => { observed.push("forbidden-retirement") },
      afterAdmissionCancellation: async () => { observed.push("forbidden-retirement") },
      accept: async () => { observed.push("forbidden-retirement") },
    },
    managed: {
      existingDirectory: { validate: async (request) => {
        observed.push("existing-directory")
        if (options.failValidation) throw new Error("git changed")
        return {
          directory: request.workspace.directory,
          repository: request.workspace.repository,
          checkoutRoot: request.workspace.checkout_root,
          headCommit: request.workspace.head_commit,
        }
      } },
      manifest: {
        claim: async () => { observed.push("manifest") },
        workControl: async () => ({
          socketPath: "/tmp/fmx-managed-test.sock",
          instanceId: "managed-instance",
          token: "a".repeat(64),
        }),
      },
      launch: { prepare: async ({ record }) => {
        observed.push("prepare")
        if (options.failPrepare) throw new Error("launch provider is unavailable")
        return {
          invocation: {},
          conversationId: record.request.fx_conversation.resume_conversation_id!,
          finalReceiptAuthority: {
            admission_key: record.request.source.admission_key,
            state_root: record.request.source.launch_request.state_root,
          },
        }
      } },
      companion: { start: async ({ record }) => {
        observed.push("companion")
        if (options.failCompanion) throw new Error("Companion result is uncertain")
        return {
          sessionName: `fmx-${record.request.agent_id}`,
          paneId: `p_${record.request.agent_id}`,
        }
      } },
      workControl: { admitInitial: async ({ text }) => {
        observed.push(`work-control:${text}`)
        return {
          admission: {
            disposition: "queued",
            turn_id: "1",
            snapshot: {} as FxWorkControlResult["snapshot"],
          },
          conversationId: "1788123456789-1788123456789000000-a1b2c3d4",
        }
      } },
      admission: { import: async ({ record, expectedConversationId }) => {
        observed.push("inspect")
        return {
          kind: "admitted",
          decision: admissionDecision(record.request, expectedConversationId),
          conversationId: expectedConversationId,
        }
      } },
      classify: (_error, record) => ({
        classification: options.failCompanion ? "uncertain" : "retryable",
        stage: options.failCompanion
          ? "companion_start"
          : record.stage === "claimed" ? "existing_directory" : "launch_provider",
        cause: options.failCompanion
          ? "companion_start_uncertain"
          : record.stage === "claimed"
          ? "git_identity_changed"
          : options.failPrepare ? "launch_provider_unavailable" : "internal_failure",
        processCertainty: options.failCompanion ? "may_have_started" : "not_started",
        exactResumeProof: null,
      }),
      outcomes: { publish: async (outcome) => { published.push(outcome) } },
    },
  }
}

function admissionDecision(
  request: ManagedLaunchRequest,
  conversationId: string,
): AdmittedFxAdmissionDecision {
  void conversationId
  const decision = {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "admission_decision",
    receipt_id: `managed-admission-${request.ensure_id}`,
    receipt_digest: "",
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    admission_key: request.source.admission_key,
    decision: { kind: "admitted", turn_id: "1", disposition: "queued" },
  } as FxAdmissionDecision
  return {
    ...decision,
    receipt_digest: deriveFxAdmissionDecisionDigest(decision),
  } as AdmittedFxAdmissionDecision
}

async function managedRequest(suffix: string): Promise<ManagedLaunchRequest> {
  const values = (await readFile(join(CONTRACT_ROOT, "fx-launch-admission-final.jsonl"), "utf8"))
    .trimEnd().split("\n")
    .map((line) => fxLaunchAdmissionFinalMessageSchema.parse(JSON.parse(line)) as FxLaunchAdmissionFinalMessage)
  const base = values.find((message): message is FrozenLaunchRequest =>
    message.message_type === "launch_request" && message.launch_id === "launch-a")!
  const serial = suffix.replace(/[^a-z0-9]/gu, "").slice(0, 12) || "x"
  const directory = `/var/tmp/fmx-managed-${serial}`
  const conversationId = "1788123456789-1788123456789000000-a1b2c3d4"
  const initialWork = encodeInlineSourceBytes(Buffer.from("managed hello", "utf8"))
  const launchControls = encodeInlineSourceBytes(
    encodeCanonicalJson({ remaining_global_args: [] }),
  )
  const launch = structuredClone(base)
  launch.request_id = `launch-request-${serial}`
  launch.launch_id = `launch-${serial}`
  launch.admission_key = `admission-${serial}`
  launch.directory = directory
  launch.conversation_name = `managed-${serial}`
  launch.resume = { mode: "exact", conversation_id: conversationId }
  launch.initial_work_digest = initialWork.sha256
  launch.remaining_launch_controls_digest = launchControls.sha256
  launch.launch_digest = deriveFrozenLaunchDigest(launch)
  const request = {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "launch_request",
    request_id: `managed-request-${serial}`,
    workplace_instance_id: "workplace-managed-test",
    fmx_session: "default",
    ensure_id: `managed-ensure-${serial}`,
    ensure_digest: "0".repeat(64),
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    agent_id: serial.padEnd(32, "a").slice(0, 32).replace(/[^0-9a-f]/gu, "a"),
    workspace: {
      kind: "existing_directory",
      directory,
      repository: "/var/tmp/fmx-managed-repository",
      checkout_root: directory,
      head_commit: "b".repeat(40),
    },
    fx_conversation: {
      name: launch.conversation_name,
      resume_conversation_id: conversationId,
    },
    source: {
      source_id: `managed-source-${serial}`,
      source_digest: "0".repeat(64),
      admission_key: launch.admission_key,
      launch_request: launch,
      initial_work: initialWork,
      launch_controls: launchControls,
    },
  } as ManagedLaunchRequest
  request.source.source_digest = deriveManagedLaunchSourceDigest(request)
  request.ensure_digest = deriveManagedLaunchEnsureDigest(request)
  return parseManagedLaunchRequest(request)
}

function managedOutcome(
  request: ManagedLaunchRequest,
  values: Pick<
    Extract<ManagedLaunchOutcome, { status: "failed" }>,
    "classification" | "stage" | "cause" | "process_certainty" | "exact_resume_proof"
  > = {
    classification: "retryable",
    stage: "existing_directory",
    cause: "git_identity_changed",
    process_certainty: "not_started",
    exact_resume_proof: null,
  },
): Extract<ManagedLaunchOutcome, { status: "failed" }> {
  const outcome: Extract<ManagedLaunchOutcome, { status: "failed" }> = {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "launch_outcome",
    request_id: request.request_id,
    receipt_id: `managed-outcome-${request.ensure_id}`,
    receipt_digest: "0".repeat(64),
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    ensure_digest: request.ensure_digest,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    agent_id: request.agent_id,
    attempt: 1,
    status: "failed",
    ...values,
    success: null,
    retained_until_acknowledged: true,
  }
  outcome.receipt_digest = deriveManagedLaunchOutcomeDigest(outcome)
  return outcome
}

function exactResumeProof(request: ManagedLaunchRequest) {
  const proof = {
    kind: "exact_resume_refused" as const,
    authority: "fx.private-launch-provider/resume-status-v2" as const,
    semantic_decision: "exact_resume_unavailable" as const,
    status: "unavailable" as const,
    decision_id: "",
    decision_digest: "0".repeat(64),
    admission_key: request.source.admission_key,
    conversation_id: request.fx_conversation.resume_conversation_id!,
    launch_digest: request.launch_digest,
    launch_id: request.launch_id,
    state_root: request.source.launch_request.state_root,
  }
  proof.decision_id = deriveManagedExactResumeDecisionId(proof)
  proof.decision_digest = deriveManagedExactResumeDecisionDigest(proof)
  return proof
}

function managedAcknowledgement(outcome: ManagedLaunchOutcome): ManagedLaunchAcknowledgement {
  return {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "outcome_acknowledgement",
    acknowledgement_id: `managed-ack-${outcome.ensure_id}`,
    workplace_instance_id: outcome.workplace_instance_id,
    fmx_session: outcome.fmx_session,
    receipt_id: outcome.receipt_id,
    receipt_digest: outcome.receipt_digest,
    attempt: outcome.attempt,
    ensure_id: outcome.ensure_id,
    ensure_digest: outcome.ensure_digest,
    launch_id: outcome.launch_id,
    launch_digest: outcome.launch_digest,
    agent_id: outcome.agent_id,
  }
}

function managedRetry(outcome: ManagedLaunchOutcome): ManagedLaunchRetry {
  return {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "retry_request",
    request_id: `managed-retry-${outcome.ensure_id}-${outcome.attempt + 1}`,
    workplace_instance_id: outcome.workplace_instance_id,
    fmx_session: outcome.fmx_session,
    ensure_id: outcome.ensure_id,
    ensure_digest: outcome.ensure_digest,
    launch_id: outcome.launch_id,
    launch_digest: outcome.launch_digest,
    agent_id: outcome.agent_id,
    prior_attempt: outcome.attempt,
    prior_receipt_id: outcome.receipt_id,
    prior_receipt_digest: outcome.receipt_digest,
    next_attempt: outcome.attempt + 1,
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "fmx-managed-launch-test-"))
  temporaryDirectories.add(directory)
  return directory
}
