import { afterAll, describe, expect, test } from "bun:test"
import { readFile, realpath, rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  identityFor,
  AgentManifest,
  type ManifestEntry,
} from "../src/agent-manifest.ts"
import {
  fxLaunchAdmissionFinalMessageSchema,
  ensureLifecycleMessageSchema,
} from "../src/agentworkplace-contracts.ts"
import {
  deriveEnsureDigest,
  deriveFxAdmissionDecisionDigest,
  deriveFxFinalReceiptDigest,
  EnsureLifecycleLedger,
  type EnsureRequest,
  type FxAdmissionDecision,
  type FxFinalReceipt,
} from "../src/ensure-lifecycle-ledger.ts"
import { deriveEndDigest, type EndRequest } from "../src/exact-retirement-ledger.ts"
import {
  encodeInlineSourceBytes,
  deriveFrozenLaunchDigest,
  deriveInlineLaunchSourceDigest,
  encodeInlineLaunchControls,
  type FrozenLaunchRequest,
  type InlineLaunchSourceRequest,
} from "../src/inline-launch-source.ts"
import {
  LifecycleRuntime,
  lifecycleRuntimeRoots,
  type LifecycleRuntimeMultiplexer,
  type LifecycleRuntimeOptions,
} from "../src/lifecycle-runtime.ts"
import type { ManagedAgentClaim, ManagedAgentInvocation } from "../src/multiplexer.ts"

const CONTRACTS = resolve(import.meta.dir, "../contracts/agentworkplace/v1")
const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe("production lifecycle Runtime composition", () => {
  test("opens stable per-Home roots and drives provider-neutral managed launch", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a")
    const harness = await runtimeHarness(fixture)
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.recover()

      expect(harness.errors.map(String)).toEqual([])
      expect(harness.provider.operations).toEqual([
        "prepare", "build", "inspect", "prepare", "build", "inspect",
      ])
      expect(harness.multiplexer.claims).toHaveLength(1)
      expect(harness.multiplexer.starts).toHaveLength(1)
      const invocation = harness.multiplexer.starts[0]!
      expect(invocation.command).toEqual([
        "/resolved/fmx-fx",
        "--state-dir",
        fixture.source.launch_request.state_root,
        "--record",
        "--tool",
        "read",
      ])
      expect(invocation.cwd).toBe(fixture.ensure.planned_worktree.directory)
      expect(invocation.env).toMatchObject({
        KEEP: "yes",
        FMX_SOCKET_PATH: harness.runtimeSocketPath,
        FX_WORK_CONTROL_INSTANCE_ID: fixture.ensure.agent_id,
        FX_ADE_INSTANCE_ID: fixture.ensure.agent_id,
        FX_INTERNAL_LAUNCH_CONVERSATION_ID: "conversation-runtime",
      })
      expect(invocation.env.FX_MODEL).toBeUndefined()
      expect(invocation.env.FX_EFFORT).toBeUndefined()
      expect(harness.workControl.requests).toEqual([{
        method: "work.queue",
        params: { text: "initial λ work" },
        instanceId: fixture.ensure.agent_id,
      }])
      expect(harness.receipts.some((receipt) =>
        receipt.message_type === "ensure_receipt" && receipt.status === "complete"
      )).toBe(true)
      expect(await harness.runtime.correlationSource.snapshot()).toEqual([{
        agent_id: fixture.ensure.agent_id,
        correlation: {
          ensure_id: fixture.ensure.ensure_id,
          ensure_digest: fixture.ensure.ensure_digest,
          launch_id: fixture.ensure.launch_id,
          launch_digest: fixture.ensure.launch_digest,
        },
      }])
    } finally {
      await harness.runtime.close()
    }
  })

  test("fails closed without provider finality, then retains and acknowledges exact Exit", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "final")
    const harness = await runtimeHarness(fixture)
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.recover()
      expect(harness.errors.map(String)).toEqual([])
      const entry = harness.manifest.get(fixture.ensure.agent_id)!

      await expect(harness.runtime.beforeRemove({
        entry,
        reason: "absent",
        session: null,
      })).rejects.toThrow("no definitive Fx final or negative decision")
      expect(harness.manifest.get(fixture.ensure.agent_id)).not.toBeNull()

      await harness.runtime.beforeDefinitiveAgentForget(entry, { code: 7, signal: 0 })
      expect(harness.provider.recordedFinal).toEqual({ kind: "exited", code: 7 })
      expect(harness.provider.acknowledged).toHaveLength(1)
      const durable = await EnsureLifecycleLedger.open(harness.runtime.roots.ensure)
      expect(await durable.get(fixture.ensure.ensure_id)).toMatchObject({
        fx_final: {
          receipt: { outcome: { kind: "exited", code: 7 } },
          acknowledgement_applied: true,
        },
      })
    } finally {
      await harness.runtime.close()
    }
  })

  test("derives never-started proof only from the provider's exact negative winner", async () => {
    const fixture = await lifecycleFixture("ensure-b", "launch-b", "cancel")
    const harness = await runtimeHarness(fixture, { cancellation: true })
    try {
      // Hold the ensure dormant until the cancellation request is durable.
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.acceptLifecycle(fixture.end!)
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.recover()

      expect(harness.errors.map(String)).toEqual([])
      expect(harness.multiplexer.starts).toHaveLength(0)
      expect(harness.provider.cancelled.length).toBeGreaterThanOrEqual(1)
      expect(new Set(harness.provider.cancelled).size).toBe(1)
      const end = harness.receipts.find((receipt) => receipt.message_type === "end_receipt")
      expect(end).toMatchObject({
        message_type: "end_receipt",
        proof: {
          kind: "never_started",
          admission_receipt_id: "runtime-cancelled-decision",
          cancellation_request_id: harness.provider.cancelled[0],
        },
      })
    } finally {
      await harness.runtime.close()
    }
  })

  test("holds cancellation behind the start lease through the durable Companion boundary", async () => {
    const fixture = await lifecycleFixture("ensure-b", "launch-b", "lease")
    const harness = await runtimeHarness(fixture, { cancellation: true, delayedStart: true })
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await waitFor(() => harness.multiplexer.starts.length === 1)

      await harness.runtime.acceptLifecycle(fixture.end!)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      expect(harness.provider.cancelled).toHaveLength(0)

      harness.multiplexer.releaseStart()
      await harness.runtime.recover()
      expect(harness.provider.cancelled).toHaveLength(0)
      expect(harness.multiplexer.starts).toHaveLength(1)
      expect(harness.errors.map(String)).toEqual([])
    } finally {
      harness.multiplexer.releaseStart()
      await harness.runtime.close()
    }
  })

  test("close waits for an in-flight managed start to release its lease", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "close")
    const harness = await runtimeHarness(fixture, { delayedStart: true })
    let closed = false
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await waitFor(() => harness.multiplexer.starts.length === 1)

      const closing = harness.runtime.close().then(() => { closed = true })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      expect(closed).toBe(false)
      harness.multiplexer.releaseStart()
      await closing
      expect(closed).toBe(true)
    } finally {
      harness.multiplexer.releaseStart()
      await harness.runtime.close()
    }
  })
})

async function runtimeHarness(
  fixture: Awaited<ReturnType<typeof lifecycleFixture>>,
  choices: { cancellation?: boolean; delayedStart?: boolean } = {},
) {
  const home = await temporaryDirectory()
  const manifest = AgentManifest.ephemeral("lifecycle-runtime-test")
  const runtimeSocketPath = `/tmp/fmx-lr-${process.pid}-${temporaryDirectories.length}.bus`
  const multiplexer = new FakeMultiplexer(manifest, choices.delayedStart ?? false)
  const workControl = new FakeWorkControl()
  const provider = new FakeProvider(fixture, workControl, choices.cancellation ?? false)
  const receipts: Array<Record<string, any>> = []
  const errors: unknown[] = []
  const options = {
    home,
    homeId: "lifecycle-runtime-test",
    fmxSession: fixture.ensure.fmx_session,
    fxPath: "/resolved/fmx-fx",
    runtimeSocketPath,
    adeBinding: { socketPath: join(home, "ade.sock"), instanceId: "ignored" },
    manifest,
    companion: { list: async () => [] },
    companionDirectory: join(home, "zmx"),
    environment: {
      KEEP: "yes",
      FX_MODEL: "ambient-model",
      FX_EFFORT: "ambient-effort",
    },
    now: () => new Date("2026-08-31T20:00:00.000Z"),
    onError: (error: unknown) => { errors.push(error) },
    worktreeCreator: {
      create: async (request: EnsureRequest) => ({
        kind: "worktree_created" as const,
        directory: request.planned_worktree.directory,
        head_commit: request.planned_worktree.base_commit,
      }),
    },
    launchProvider: provider,
    workControl,
    companionAuthority: {
      list: async () => [],
      connect: async () => { throw new Error("never-started retirement must not connect") },
    },
  } satisfies LifecycleRuntimeOptions
  const runtime = await LifecycleRuntime.open(options)
  runtime.bindMultiplexer(multiplexer)
  runtime.bindReceiptPublisher((receipt) => { receipts.push(structuredClone(receipt)) })
  expect(runtime.roots).toEqual(lifecycleRuntimeRoots(home))
  return {
    runtime,
    runtimeSocketPath,
    manifest,
    multiplexer,
    workControl,
    provider,
    receipts,
    errors,
  }
}

class FakeMultiplexer implements LifecycleRuntimeMultiplexer {
  readonly claims: ManagedAgentClaim[] = []
  readonly starts: ManagedAgentInvocation[] = []

  private readonly startGate = Promise.withResolvers<void>()

  constructor(
    private readonly manifest: AgentManifest,
    private readonly delayedStart: boolean,
  ) {}

  async projectManagedAgent(claim: ManagedAgentClaim): Promise<ManifestEntry> {
    this.claims.push(structuredClone(claim))
    const { result, saved } = this.manifest.ensureClaim({
      identity: identityFor(claim.agentId),
      cwd: claim.cwd,
      fxPath: claim.fxPath,
      fxArgs: claim.fxArgs,
      workControl: claim.workControl,
      createdAt: claim.createdAt ?? 1,
    })
    await saved
    return result
  }

  async startManagedAgent(agentId: string, invocation: ManagedAgentInvocation) {
    this.starts.push(structuredClone(invocation))
    if (this.delayedStart) await this.startGate.promise
    const entry = await this.manifest.markRunning(agentId)
    return { sessionName: entry.zmxName, paneId: entry.paneId }
  }

  releaseStart(): void {
    this.startGate.resolve()
  }
}

class FakeWorkControl {
  readonly requests: Array<{ method: string; params: unknown; instanceId: string }> = []
  admitted = false

  async request(binding: { instanceId: string }, method: string, params: Record<string, unknown>) {
    this.requests.push({ method, params: structuredClone(params), instanceId: binding.instanceId })
    this.admitted = true
    return {
      turn_id: "41",
      disposition: "queued" as const,
      snapshot: { active_turn_id: "41", queue_paused: false, queue: [] },
    }
  }
}

class FakeProvider {
  readonly operations: string[] = []
  readonly cancelled: string[] = []
  readonly acknowledged: string[] = []
  recordedFinal: unknown = null
  private final: FxFinalReceipt | null = null

  constructor(
    private readonly fixture: Awaited<ReturnType<typeof lifecycleFixture>>,
    private readonly workControl: FakeWorkControl,
    private readonly cancellation: boolean,
  ) {}

  async prepare() {
    this.operations.push("prepare")
    return {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "launch_receipt",
      request_id: this.fixture.source.launch_request.request_id,
      receipt_id: "runtime-launch-receipt",
      launch_id: this.fixture.ensure.launch_id,
      launch_digest: this.fixture.ensure.launch_digest,
      admission_key: this.fixture.source.admission_key,
      status: "accepted",
    } as const
  }

  async build() {
    this.operations.push("build")
    return {
      command: [
        "--state-dir",
        this.fixture.source.launch_request.state_root,
        "--record",
        "--tool",
        "read",
      ],
      cwd: this.fixture.ensure.planned_worktree.directory,
      env: {
        FX_INTERNAL_LAUNCH_STATE_ROOT: this.fixture.source.launch_request.state_root,
        FX_INTERNAL_LAUNCH_ADMISSION_KEY: this.fixture.source.admission_key,
        FX_INTERNAL_LAUNCH_DIGEST: this.fixture.ensure.launch_digest,
        FX_INTERNAL_LAUNCH_ID: this.fixture.ensure.launch_id,
        FX_INTERNAL_LAUNCH_CONVERSATION_ID: "conversation-runtime",
      },
      conversationId: "conversation-runtime",
      mode: "initial" as const,
    }
  }

  async inspect() {
    this.operations.push("inspect")
    return this.authority(this.final, this.workControl.admitted ? this.admittedDecision() : null)
  }

  async cancel(_stateRoot: string, request: { request_id: string }) {
    this.operations.push("cancel")
    this.cancelled.push(request.request_id)
    return this.authority(null, this.cancelledDecision(request.request_id))
  }

  async recordFinal(_correlation: unknown, observedAt: string, outcome: any) {
    this.operations.push("record_final")
    this.recordedFinal = structuredClone(outcome)
    const partial = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "final_receipt",
      receipt_id: "runtime-final-receipt",
      receipt_digest: "",
      launch_id: this.fixture.ensure.launch_id,
      launch_digest: this.fixture.ensure.launch_digest,
      admission_key: this.fixture.source.admission_key,
      conversation_id: "conversation-runtime",
      outcome,
      observed_at: observedAt,
      retained_until_acknowledged: true,
    } as FxFinalReceipt
    this.final = { ...partial, receipt_digest: deriveFxFinalReceiptDigest(partial) }
    return this.authority(this.final, this.admittedDecision())
  }

  async acknowledgeFinal(_stateRoot: string, acknowledgement: { acknowledgement_id: string }) {
    this.operations.push("acknowledge_final")
    this.acknowledged.push(acknowledgement.acknowledgement_id)
    return {
      ...this.authority(this.final, this.admittedDecision()),
      finalAcknowledgementId: acknowledgement.acknowledgement_id,
    }
  }

  private authority(finalReceipt: FxFinalReceipt | null, decision: FxAdmissionDecision | null) {
    return {
      launchReceipt: {} as any,
      decision: decision as any,
      finalReceipt: finalReceipt as any,
      finalAcknowledgementId: null,
    }
  }

  private admittedDecision(): FxAdmissionDecision {
    const partial = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "admission_decision",
      receipt_id: "runtime-admitted-decision",
      receipt_digest: "",
      launch_id: this.fixture.ensure.launch_id,
      launch_digest: this.fixture.ensure.launch_digest,
      admission_key: this.fixture.source.admission_key,
      decision: { kind: "admitted", turn_id: "41", disposition: "queued" },
    } as FxAdmissionDecision
    return { ...partial, receipt_digest: deriveFxAdmissionDecisionDigest(partial) }
  }

  private cancelledDecision(requestId: string): FxAdmissionDecision {
    if (!this.cancellation) throw new Error("unexpected provider cancellation")
    const partial = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "admission_decision",
      receipt_id: "runtime-cancelled-decision",
      receipt_digest: "",
      launch_id: this.fixture.ensure.launch_id,
      launch_digest: this.fixture.ensure.launch_digest,
      admission_key: this.fixture.source.admission_key,
      decision: { kind: "cancelled_before_start", cancellation_request_id: requestId },
    } as FxAdmissionDecision
    return { ...partial, receipt_digest: deriveFxAdmissionDecisionDigest(partial) }
  }
}

async function lifecycleFixture(
  ensureId: "ensure-a" | "ensure-b",
  launchId: "launch-a" | "launch-b",
  suffix = "launch",
) {
  const ensures = await messages("ensure-lifecycle.jsonl", ensureLifecycleMessageSchema)
  const launches = await messages("fx-launch-admission-final.jsonl", fxLaunchAdmissionFinalMessageSchema)
  const ensure = structuredClone(ensures.find((message): message is EnsureRequest =>
    message.message_type === "ensure_request" && message.ensure_id === ensureId
  )!)
  const launch = structuredClone(launches.find((message): message is FrozenLaunchRequest =>
    message.message_type === "launch_request" && message.launch_id === launchId
  )!)
  ensure.request_id = `${ensure.request_id}-${suffix}`
  ensure.ensure_id = `${ensure.ensure_id}-${suffix}`
  ensure.launch_id = `${ensure.launch_id}-${suffix}`
  ensure.worktree_id = `${ensure.worktree_id}-${suffix}`
  ensure.agent_id = ensureId === "ensure-a" ? "a".repeat(32) : "b".repeat(32)
  ensure.planned_worktree = {
    ...ensure.planned_worktree,
    directory: `/var/tmp/fmx-lifecycle-runtime-${ensureId}-${suffix}`,
    branch: `runtime-${ensureId}-${suffix}`,
  }
  const controls = encodeInlineLaunchControls(["--record", "--tool", "read"])
  const initial = Buffer.from("initial λ work", "utf8")
  launch.request_id = `${launch.request_id}-${suffix}`
  launch.launch_id = ensure.launch_id
  launch.admission_key = `runtime-admission-${ensureId}-${suffix}`
  launch.directory = ensure.planned_worktree.directory
  launch.state_root = `/var/tmp/fmx-lifecycle-provider-${ensureId}-${suffix}`
  launch.initial_work_digest = encodeInlineSourceBytes(initial).sha256
  launch.remaining_launch_controls_digest = encodeInlineSourceBytes(controls).sha256
  launch.launch_digest = deriveFrozenLaunchDigest(launch)
  ensure.launch_digest = launch.launch_digest
  ensure.ensure_digest = deriveEnsureDigest(ensure)
  const sourceWithoutDigest = {
    schema_id: "fmx.inline-launch-source",
    schema_version: 2,
    message_type: "source_request",
    request_id: `runtime-source-request-${ensureId}-${suffix}`,
    workplace_instance_id: ensure.workplace_instance_id,
    fmx_session: ensure.fmx_session,
    ensure_id: ensure.ensure_id,
    ensure_digest: ensure.ensure_digest,
    worktree_id: ensure.worktree_id,
    agent_id: ensure.agent_id,
    launch_id: ensure.launch_id,
    launch_digest: ensure.launch_digest,
    admission_key: launch.admission_key,
    source_id: `runtime-source-${ensureId}-${suffix}`,
    launch_request: launch,
    initial_work: encodeInlineSourceBytes(initial),
    launch_controls: encodeInlineSourceBytes(controls),
  } satisfies Omit<InlineLaunchSourceRequest, "source_digest">
  const source = {
    ...sourceWithoutDigest,
    source_digest: deriveInlineLaunchSourceDigest(sourceWithoutDigest as InlineLaunchSourceRequest),
  }
  let end: EndRequest | null = null
  if (ensureId === "ensure-b") {
    end = structuredClone(ensures.find((message): message is EndRequest =>
      message.message_type === "end_request" && message.ensure_id === "ensure-b"
    )!)
    end.request_id = `${end.request_id}-${suffix}`
    end.ensure_id = ensure.ensure_id
    end.ensure_digest = ensure.ensure_digest
    end.launch_id = ensure.launch_id
    end.launch_digest = ensure.launch_digest
    end.worktree_id = ensure.worktree_id
    end.agent_id = ensure.agent_id
    end.end_id = `${end.end_id}-${suffix}`
    end.end_digest = deriveEndDigest(end)
  }
  return { ensure, source, end }
}

async function messages<T>(file: string, schema: { parse(value: unknown): T }): Promise<T[]> {
  return (await readFile(join(CONTRACTS, file), "utf8")).trimEnd().split("\n")
    .map((line) => schema.parse(JSON.parse(line)))
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fmx-lifecycle-runtime-")))
  temporaryDirectories.push(directory)
  return directory
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (await condition()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
  }
  throw new Error("timed out waiting for lifecycle Runtime condition")
}
