import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm, mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureLifecycleMessageSchema,
  fxLaunchAdmissionFinalMessageSchema,
  type EnsureLifecycleMessage,
  type FxLaunchAdmissionFinalMessage,
} from "../src/agentworkplace-contracts.ts"
import { encodeCanonicalJson } from "../src/contract-codec.ts"
import {
  EnsureLifecycleLedger,
  deriveEnsureDigest,
  deriveFxFinalReceiptDigest,
  type EnsureRequest,
  type FxFinalReceipt,
} from "../src/ensure-lifecycle-ledger.ts"
import {
  InlineLaunchSourceLedger,
  deriveFrozenLaunchDigest,
  deriveInlineLaunchSourceDigest,
  encodeInlineSourceBytes,
  type FrozenLaunchRequest,
  type InlineLaunchSourceRequest,
} from "../src/inline-launch-source.ts"
import { LifecycleCoordinator, type LifecycleCoordinatorPorts } from "../src/lifecycle-coordinator.ts"

const ROOT = join(import.meta.dir, "../contracts/agentworkplace/v1")
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe("durable lifecycle coordinator", () => {
  test("only admits intent in-band, then advances the exact durable order and imports Fx authority", async () => {
    const fixture = await sourceFixture("main")
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const observed: string[] = []
    const ports = fakePorts(observed)
    const coordinator = new LifecycleCoordinator({ ledger, sources, ports })

    await coordinator.acceptInlineSource(fixture.source)
    await coordinator.accept(fixture.ensure)
    expect(observed).toEqual([])
    await coordinator.settled()

    expect(observed).toEqual([
      "worktree",
      "manifest",
      "prepare",
      "start-gate",
      "companion",
      "prepare",
      "work-control:hello λ",
      "import-admission:conversation-main",
    ])
    const record = await ledger.get(fixture.ensure.ensure_id)
    expect(record).toMatchObject({
      stage: "fx_started",
      effects: {
        worktree: { status: "created", directory: fixture.ensure.planned_worktree.directory },
        manifest: { status: "claimed", agent_id: fixture.ensure.agent_id },
        companion: { status: "started", session_name: `fmx-${fixture.ensure.agent_id}` },
        fx: { status: "started", conversation_id: "conversation-main" },
      },
      fx_final: { binding: { admission_key: fixture.source.admission_key } },
    })
  })

  test("recovery resumes each persisted boundary and protects managed Manifest entries", async () => {
    for (const stage of ["claimed", "worktree_created", "manifest_claimed", "companion_started"] as const) {
      const fixture = await sourceFixture(stage)
      const root = await temporaryDirectory()
      const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
      const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
      await sources.claim(fixture.source)
      await ledger.claim(fixture.ensure)
      await sources.bindEnsureRequestForEnsure(fixture.ensure)
      if (stage !== "claimed") {
        await ledger.advance(fixture.ensure.ensure_id, {
          kind: "worktree_created",
          directory: fixture.ensure.planned_worktree.directory,
          head_commit: fixture.ensure.planned_worktree.base_commit,
        })
      }
      if (stage === "manifest_claimed" || stage === "companion_started") {
        await ledger.advance(fixture.ensure.ensure_id, {
          kind: "manifest_claimed",
          agent_id: fixture.ensure.agent_id,
        })
      }
      if (stage === "companion_started") {
        await ledger.bindFxFinalReceiptAuthority(fixture.ensure.ensure_id, {
          admission_key: fixture.source.admission_key,
          state_root: fixture.source.launch_request.state_root,
        })
        await ledger.advance(fixture.ensure.ensure_id, {
          kind: "companion_started",
          session_name: `fmx-${fixture.ensure.agent_id}`,
          pane_id: `p_${fixture.ensure.agent_id}`,
        })
      }
      const observed: string[] = []
      const coordinator = new LifecycleCoordinator({ ledger, sources, ports: fakePorts(observed) })
      await coordinator.recover()
      await coordinator.settled()
      expect((await ledger.get(fixture.ensure.ensure_id))?.stage, stage).toBe("fx_started")
      if (stage === "manifest_claimed" || stage === "companion_started") {
        expect(observed).toContain(`protect:${fixture.ensure.agent_id}`)
      }
    }
  })

  test("a durable pre-start cancellation never starts or marks Fx started", async () => {
    const fixture = await sourceFixture("cancel")
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    await sources.claim(fixture.source)
    await ledger.claim(fixture.ensure)
    await sources.bindEnsureRequestForEnsure(fixture.ensure)
    await ledger.advance(fixture.ensure.ensure_id, {
      kind: "worktree_created",
      directory: fixture.ensure.planned_worktree.directory,
      head_commit: fixture.ensure.planned_worktree.base_commit,
    })
    await ledger.advance(fixture.ensure.ensure_id, { kind: "manifest_claimed", agent_id: fixture.ensure.agent_id })
    const observed: string[] = []
    const ports = fakePorts(observed, "cancelled_before_start")
    const coordinator = new LifecycleCoordinator({ ledger, sources, ports })

    await coordinator.recover()
    await coordinator.settled()

    expect(observed).toEqual(["protect:" + fixture.ensure.agent_id, "prepare", "start-gate"])
    expect((await ledger.get(fixture.ensure.ensure_id))?.stage).toBe("manifest_claimed")
  })

  test("a failed effect leaves its last durable boundary for a later recovery drain", async () => {
    const fixture = await sourceFixture("fault")
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const observed: string[] = []
    let fail = true
    const ports = fakePorts(observed)
    ports.worktree.create = async () => {
      observed.push("worktree-failed")
      if (fail) throw new Error("injected worktree crash")
      return { directory: fixture.ensure.planned_worktree.directory, headCommit: fixture.ensure.planned_worktree.base_commit }
    }
    const errors: unknown[] = []
    const coordinator = new LifecycleCoordinator({
      ledger,
      sources,
      ports: { ...ports, onError: (error) => errors.push(error) },
    })
    await coordinator.acceptInlineSource(fixture.source)
    await coordinator.accept(fixture.ensure)
    await coordinator.settled()
    expect((await ledger.get(fixture.ensure.ensure_id))?.stage).toBe("claimed")
    expect(errors).toHaveLength(1)

    fail = false
    await coordinator.recover()
    await coordinator.settled()
    expect((await ledger.get(fixture.ensure.ensure_id))?.stage).toBe("fx_started")
  })

  test("a source arriving after a durable ensure claim resumes that exact intent", async () => {
    const fixture = await sourceFixture("source-late")
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const observed: string[] = []
    const coordinator = new LifecycleCoordinator({ ledger, sources, ports: fakePorts(observed) })

    await coordinator.accept(fixture.ensure)
    expect((await ledger.get(fixture.ensure.ensure_id))?.stage).toBe("claimed")

    await coordinator.acceptInlineSource(fixture.source)
    await coordinator.settled()
    expect((await ledger.get(fixture.ensure.ensure_id))?.stage).toBe("fx_started")
    expect(observed).toContain("work-control:hello λ")
  })

  test("recovery bounds concurrent external effects without dropping durable work", async () => {
    const fixtures = await Promise.all(
      ["bound-a", "bound-b", "bound-c", "bound-d", "bound-e"].map(sourceFixture),
    )
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const observed: string[] = []
    const ports = fakePorts(observed)
    let active = 0
    let maximum = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    ports.worktree.create = async ({ request }) => {
      active++
      maximum = Math.max(maximum, active)
      await blocked
      active--
      return {
        directory: request.planned_worktree.directory,
        headCommit: request.planned_worktree.base_commit,
      }
    }
    const coordinator = new LifecycleCoordinator({
      ledger,
      sources,
      ports,
      maxConcurrentEffects: 2,
    })
    for (const fixture of fixtures) {
      await coordinator.acceptInlineSource(fixture.source)
      await coordinator.accept(fixture.ensure)
    }
    for (let attempt = 0; attempt < 100 && maximum < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(maximum).toBe(2)
    release()
    await coordinator.settled()
    expect(maximum).toBe(2)
    expect((await ledger.list()).every(({ stage }) => stage === "fx_started")).toBe(true)
  })

  test("an exact completed retry republishes current authority without repeating an effect", async () => {
    const fixture = await sourceFixture("receipt-retry")
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const observed: string[] = []
    const ports = fakePorts(observed)
    ports.receipts = {
      ensure: async (record) => {
        observed.push(`receipt:${record.stage}`)
        return null
      },
      publish: async () => {
        throw new Error("a null receipt must not be published")
      },
    }
    const coordinator = new LifecycleCoordinator({ ledger, sources, ports })

    await coordinator.acceptInlineSource(fixture.source)
    await coordinator.accept(fixture.ensure)
    await coordinator.settled()
    expect((await ledger.get(fixture.ensure.ensure_id))?.stage).toBe("fx_started")

    observed.length = 0
    await coordinator.accept(fixture.ensure)
    await coordinator.settled()
    expect(observed).toEqual(["receipt:fx_started"])
  })

  test("retains correlated Fx final receipts before handing manifest retirement to its owner", async () => {
    const fixture = await sourceFixture("final")
    const finalReceipt = await finalFixture(fixture)
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    await sources.claim(fixture.source)
    await ledger.claim(fixture.ensure)
    await sources.bindEnsureRequestForEnsure(fixture.ensure)
    await ledger.advance(fixture.ensure.ensure_id, {
      kind: "worktree_created", directory: fixture.ensure.planned_worktree.directory,
      head_commit: fixture.ensure.planned_worktree.base_commit,
    })
    await ledger.advance(fixture.ensure.ensure_id, { kind: "manifest_claimed", agent_id: fixture.ensure.agent_id })
    await ledger.bindFxFinalReceiptAuthority(fixture.ensure.ensure_id, {
      admission_key: fixture.source.admission_key,
      state_root: fixture.source.launch_request.state_root,
    })
    await ledger.advance(fixture.ensure.ensure_id, {
      kind: "companion_started", session_name: `fmx-${fixture.ensure.agent_id}`,
      pane_id: `p_${fixture.ensure.agent_id}`,
    })
    await ledger.advance(fixture.ensure.ensure_id, { kind: "fx_started", conversation_id: finalReceipt.conversation_id })
    let retained = false
    const ports = fakePorts([], "start", {
      afterFinalReceipt: async (ensureId) => {
        retained = (await ledger.get(ensureId))?.fx_final.receipt?.receipt_id === finalReceipt.receipt_id
      },
    })
    const coordinator = new LifecycleCoordinator({ ledger, sources, ports })

    await coordinator.retainFinalReceipt(fixture.ensure.ensure_id, finalReceipt)
    expect(retained).toBe(true)
  })
})

function fakePorts(
  observed: string[],
  cancellation: "start" | "cancelled_before_start" = "start",
  retirement?: NonNullable<LifecycleCoordinatorPorts["retirement"]>,
): LifecycleCoordinatorPorts {
  const binding = { socketPath: "/tmp/fmx.test.fx", instanceId: "a".repeat(32), token: "token" }
  return {
    worktree: { create: async ({ request }) => {
      observed.push("worktree")
      return { directory: request.planned_worktree.directory, headCommit: request.planned_worktree.base_commit }
    } },
    manifest: {
      claim: async () => { observed.push("manifest") },
      workControl: async () => binding,
      protect: async (ids) => { for (const id of ids) observed.push(`protect:${id}`) },
    },
    launch: { prepare: async ({ source }) => {
      observed.push("prepare")
      return {
        invocation: { source: source.source_id },
        finalReceiptAuthority: { admission_key: source.admission_key, state_root: source.launch_request.state_root },
      }
    } },
    companion: { start: async ({ record }) => {
      observed.push("companion")
      return { sessionName: `fmx-${record.request.agent_id}`, paneId: `p_${record.request.agent_id}` }
    } },
    workControl: { admitInitial: async ({ text }) => {
      observed.push(`work-control:${text}`)
      return {
        admission: { disposition: "queued", turn_id: "1", snapshot: { active_turn_id: "1", queue_paused: false, queue: [] } },
        conversationId: "conversation-main",
      }
    } },
    admission: { import: async ({ conversationId }) => { observed.push(`import-admission:${conversationId}`) } },
    cancellation: { beginStart: async () => { observed.push("start-gate"); return cancellation } },
    retirement,
  }
}

async function sourceFixture(suffix: string): Promise<{ ensure: EnsureRequest; source: InlineLaunchSourceRequest }> {
  const ensureMessages: EnsureLifecycleMessage[] = await messages("ensure-lifecycle.jsonl", ensureLifecycleMessageSchema)
  const launchMessages: FxLaunchAdmissionFinalMessage[] = await messages("fx-launch-admission-final.jsonl", fxLaunchAdmissionFinalMessageSchema)
  const baseEnsure = ensureMessages.find((message): message is EnsureRequest =>
    message.message_type === "ensure_request" && message.ensure_id === "ensure-a")!
  const launch = launchMessages.find((message): message is FrozenLaunchRequest =>
    message.message_type === "launch_request" && message.launch_id === "launch-a")!
  const serial = suffix.replace(/[^a-z0-9]/gu, "").slice(0, 12) || "x"
  const ensure = structuredClone(baseEnsure)
  ensure.request_id = `ensure-request-${serial}`
  ensure.ensure_id = `ensure-${serial}`
  ensure.launch_id = `launch-${serial}`
  ensure.worktree_id = `worktree-${serial}`
  ensure.agent_id = (serial.padEnd(32, "0")).slice(0, 32).replace(/[^0-9a-f]/gu, "a")
  ensure.planned_worktree = {
    ...ensure.planned_worktree,
    branch: `fixture-${serial}`,
    directory: `/var/tmp/fmx-coordinator-${serial}`,
  }
  const launchRequest = structuredClone(launch)
  launchRequest.request_id = `launch-request-${serial}`
  launchRequest.launch_id = ensure.launch_id
  launchRequest.admission_key = `admission-${serial}`
  launchRequest.directory = ensure.planned_worktree.directory
  launchRequest.initial_work_digest = encodeInlineSourceBytes(Buffer.from("hello λ", "utf8")).sha256
  launchRequest.remaining_launch_controls_digest = encodeInlineSourceBytes(
    encodeCanonicalJson({ remaining_global_args: [] }),
  ).sha256
  launchRequest.launch_digest = deriveFrozenLaunchDigest(launchRequest)
  ensure.launch_digest = launchRequest.launch_digest
  ensure.ensure_digest = deriveEnsureDigest(ensure)
  const source = {
    schema_id: "fmx.inline-launch-source",
    schema_version: 2,
    message_type: "source_request",
    request_id: `source-request-${serial}`,
    workplace_instance_id: ensure.workplace_instance_id,
    fmx_session: ensure.fmx_session,
    ensure_id: ensure.ensure_id,
    ensure_digest: ensure.ensure_digest,
    worktree_id: ensure.worktree_id,
    agent_id: ensure.agent_id,
    launch_id: ensure.launch_id,
    launch_digest: ensure.launch_digest,
    admission_key: launchRequest.admission_key,
    source_id: `source-${serial}`,
    launch_request: launchRequest,
    initial_work: encodeInlineSourceBytes(Buffer.from("hello λ", "utf8")),
    launch_controls: encodeInlineSourceBytes(encodeCanonicalJson({ remaining_global_args: [] })),
  } satisfies Omit<InlineLaunchSourceRequest, "source_digest">
  return { ensure, source: { ...source, source_digest: deriveInlineLaunchSourceDigest(source as InlineLaunchSourceRequest) } }
}

async function finalFixture(fixture: { ensure: EnsureRequest; source: InlineLaunchSourceRequest }) {
  const values: FxLaunchAdmissionFinalMessage[] = await messages("fx-launch-admission-final.jsonl", fxLaunchAdmissionFinalMessageSchema)
  const base = values.find((message): message is FxFinalReceipt =>
    message.message_type === "final_receipt" && "outcome" in message)!
  const receipt = structuredClone(base)
  if (receipt.message_type !== "final_receipt") throw new Error("missing final receipt")
  receipt.receipt_id = `final-${fixture.ensure.ensure_id}`
  receipt.admission_key = fixture.source.admission_key
  receipt.launch_id = fixture.ensure.launch_id
  receipt.launch_digest = fixture.ensure.launch_digest
  receipt.conversation_id = "conversation-final"
  receipt.receipt_digest = deriveFxFinalReceiptDigest(receipt)
  return receipt
}

async function messages<T>(file: string, schema: { parse(value: unknown): T }): Promise<T[]> {
  return (await readFile(join(ROOT, file), "utf8")).trimEnd().split("\n")
    .map((line) => schema.parse(JSON.parse(line)))
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "fmx-lifecycle-coordinator-"))
  temporaryDirectories.add(directory)
  return directory
}
