import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  ensureLifecycleMessageSchema,
  type AgentWorkplaceMessage,
  type EnsureLifecycleMessage,
} from "../src/agentworkplace-contracts.ts"
import { ContractFrameDecoder, encodeCanonicalJson, type JsonValue } from "../src/contract-codec.ts"
import { deriveCleanupDigest, deriveEndDigest } from "../src/exact-retirement-ledger.ts"
import type { CleanupRequest, EndRequest } from "../src/exact-retirement-ledger.ts"
import type { EnsureRequest } from "../src/ensure-lifecycle-ledger.ts"
import { parseInlineLaunchSourceRequest, type InlineLaunchSourceRequest } from "../src/inline-launch-source.ts"

const FIXTURE = fileURLToPath(new URL("./fixtures/phase1c-runtime-extension.ts", import.meta.url))
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("emits canonical private source then ensure intent and logs only protocol correlation", async () => {
  const harness = await start()
  try {
    await harness.initialize()
    expect(await harness.frames.next()).toMatchObject({ message_type: "ready" })
    const source = await harness.frames.nextInline()
    const ensure = await harness.frames.nextLifecycle() as EnsureRequest
    expect(source.message_type).toBe("source_request")
    expect(parseInlineLaunchSourceRequest(source)).toEqual(source)
    expect(ensure.message_type).toBe("ensure_request")
    expect(ensure.ensure_id).toBe(source.ensure_id)
    expect(ensure.ensure_digest).toBe(source.ensure_digest)
    expect(ensure.launch_digest).toBe(source.launch_digest)
    expect(Buffer.from(encodeCanonicalJson(source as unknown as JsonValue))).toEqual(
      Buffer.from(encodeCanonicalJson(parseInlineLaunchSourceRequest(source) as unknown as JsonValue)),
    )
    const log = (await readFile(harness.log, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line))
    expect(log.map((entry) => entry.message_type)).toEqual(["source_request", "ensure_request"])
    expect(JSON.stringify(log)).not.toContain("Phase 1C fixture work")
  } finally {
    await harness.close()
  }
})

test("withholds exact receipt acknowledgement until its marker releases derived end then cleanup intents", async () => {
  const harness = await start()
  try {
    const { ensure } = await initializeAndReadIntents(harness)
    const ensureReceipt = completeEnsureReceipt(ensure)
    harness.write(ensureReceipt)
    await Bun.sleep(40)
    expect(await state(harness)).toMatchObject({
      receipts: [{ kind: "ensure", receipt_id: ensureReceipt.receipt_id, receipt_digest: ensureReceipt.receipt_digest, acknowledgement: null }],
    })

    await writeFile(harness.marker, "release\n", { mode: 0o600 })
    harness.write(releaseProbe())
    const acknowledgement = await harness.frames.nextLifecycle()
    const end = await harness.frames.nextLifecycle() as EndRequest
    expect(acknowledgement).toMatchObject({
      message_type: "receipt_acknowledgement",
      receipt_kind: "ensure",
      receipt_id: ensureReceipt.receipt_id,
      receipt_digest: ensureReceipt.receipt_digest,
    })
    expect(end.message_type).toBe("end_request")
    expect(end.end_digest).toBe(deriveEndDigest(end))
    expect(end.conversation_id).toBe(ensureReceipt.effects.fx.conversation_id)

    const endReceipt = endedReceipt(end)
    harness.write(endReceipt)
    const endAcknowledgement = await harness.frames.nextLifecycle()
    const cleanup = await harness.frames.nextLifecycle() as CleanupRequest
    expect(endAcknowledgement).toMatchObject({ message_type: "receipt_acknowledgement", receipt_id: endReceipt.receipt_id })
    expect(cleanup.message_type).toBe("cleanup_request")
    expect(cleanup.cleanup_digest).toBe(deriveCleanupDigest(cleanup))

    const cleanupReceipt = cleanupResult(cleanup)
    harness.write(cleanupReceipt)
    expect(await harness.frames.nextLifecycle()).toMatchObject({
      message_type: "receipt_acknowledgement",
      receipt_kind: "cleanup",
      receipt_id: cleanupReceipt.receipt_id,
      receipt_digest: cleanupReceipt.receipt_digest,
    })
    expect((await state(harness)).receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ensure", receipt_id: ensureReceipt.receipt_id, receipt_digest: ensureReceipt.receipt_digest }),
      expect.objectContaining({ kind: "end", receipt_id: endReceipt.receipt_id, receipt_digest: endReceipt.receipt_digest }),
      expect.objectContaining({ kind: "cleanup", receipt_id: cleanupReceipt.receipt_id, receipt_digest: cleanupReceipt.receipt_digest }),
    ]))
  } finally {
    await harness.close()
  }
})

test("fails closed for foreign receipt authority and a restarted foreign association", async () => {
  const harness = await start()
  try {
    const { ensure } = await initializeAndReadIntents(harness)
    const foreign = { ...completeEnsureReceipt(ensure), fmx_session: "session-foreign" }
    harness.write(foreign)
    expect(await harness.child.exited).toBe(1)
    expect((await state(harness)).receipts).toEqual([])
  } finally {
    await harness.close(1)
  }

  const foreignRestart = await start(harness.root, {
    initialize: { ...initializeMessage(), workplace_instance_id: "foreign-workplace" },
  })
  await foreignRestart.initialize()
  expect(await foreignRestart.child.exited).toBe(1)
  expect(await new Response(foreignRestart.child.stderr as ReadableStream<Uint8Array>).text())
    .toContain("another Workplace")
})

test.each(["acknowledgement_intent_saved", "end_intent_saved"])(
  "replays exact acknowledgement and end intent after %s crash window",
  async (crashAfter) => {
    const harness = await start(undefined, { env: { FMX_PHASE1C_FIXTURE_CRASH_AFTER: crashAfter } })
    let ensure: EnsureRequest
    let receipt: CompleteEnsureReceipt
    try {
      ({ ensure } = await initializeAndReadIntents(harness))
      receipt = completeEnsureReceipt(ensure)
      await writeFile(harness.marker, "release\n", { mode: 0o600 })
      harness.write(receipt)
      expect(await harness.child.exited).toBe(86)
      const persisted = await state(harness)
      expect(persisted.receipts[0]).toMatchObject({
        receipt_id: receipt.receipt_id,
        receipt_digest: receipt.receipt_digest,
        acknowledgement: expect.objectContaining({ receipt_id: receipt.receipt_id, receipt_digest: receipt.receipt_digest }),
      })
      if (crashAfter === "end_intent_saved") expect(persisted.end).toMatchObject({ end_id: "phase1c-end" })
    } finally {
      await harness.close(86)
    }

    const restarted = await start(harness.root)
    try {
      await restarted.initialize()
      expect(await restarted.frames.next()).toMatchObject({ message_type: "ready" })
      await restarted.frames.nextInline()
      expect(await restarted.frames.nextLifecycle()).toMatchObject({ message_type: "ensure_request", ensure_id: ensure!.ensure_id })
      expect(await restarted.frames.nextLifecycle()).toMatchObject({
        message_type: "receipt_acknowledgement",
        receipt_id: receipt!.receipt_id,
        receipt_digest: receipt!.receipt_digest,
      })
      expect(await restarted.frames.nextLifecycle()).toMatchObject({
        message_type: "end_request",
        end_id: "phase1c-end",
        end_digest: expect.any(String),
      })
    } finally {
      await restarted.close()
    }
  },
)

test("restarts from persisted receipt evidence, replays only stable intents, then releases the withheld acknowledgement", async () => {
  const harness = await start()
  let ensure: EnsureRequest
  let receipt: CompleteEnsureReceipt
  try {
    ({ ensure } = await initializeAndReadIntents(harness))
    receipt = completeEnsureReceipt(ensure)
    harness.write(receipt)
    await Bun.sleep(40)
  } finally {
    await harness.close()
  }

  const restarted = await start(harness.root)
  try {
    await restarted.initialize()
    expect(await restarted.frames.next()).toMatchObject({ message_type: "ready" })
    expect(await restarted.frames.nextInline()).toMatchObject({ source_id: "phase1c-source" })
    expect(await restarted.frames.nextLifecycle()).toMatchObject({ message_type: "ensure_request", ensure_id: ensure!.ensure_id })
    await Bun.sleep(40)
    await writeFile(restarted.marker, "release\n", { mode: 0o600 })
    restarted.write(releaseProbe())
    expect(await restarted.frames.nextLifecycle()).toMatchObject({
      message_type: "receipt_acknowledgement",
      receipt_id: receipt!.receipt_id,
      receipt_digest: receipt!.receipt_digest,
    })
    expect(await restarted.frames.nextLifecycle()).toMatchObject({ message_type: "end_request", end_id: "phase1c-end" })
  } finally {
    await restarted.close()
  }
})

async function start(
  root?: string,
  options: { env?: Record<string, string>; initialize?: InitializeMessage } = {},
): Promise<Harness> {
  const directory = root ?? await mkdtemp(join(tmpdir(), "fmx-phase1c-runtime-extension-"))
  if (root === undefined) temporaryDirectories.push(directory)
  const statePath = join(directory, "fixture-state.json")
  const marker = join(directory, "release.marker")
  const log = join(directory, "protocol.jsonl")
  const child = Bun.spawn([process.execPath, FIXTURE], {
    env: {
      ...process.env,
      FMX_PHASE1C_FIXTURE_STATE: statePath,
      FMX_PHASE1C_FIXTURE_RELEASE_MARKER: marker,
      FMX_PHASE1C_FIXTURE_LOG: log,
      ...options.env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    root: directory,
    statePath,
    marker,
    log,
    child,
    frames: new FrameReader(child.stdout),
    initialize: async () => {
      child.stdin.write(encodeAgentWorkplaceFrame(options.initialize ?? initializeMessage()))
      await child.stdin.flush()
    },
    write: (message: AgentWorkplaceMessage) => child.stdin.write(encodeAgentWorkplaceFrame(message)),
    close: async (expectedExitCode = 0) => {
      child.stdin.end()
      const code = await child.exited
      const stderr = await new Response(child.stderr).text()
      if (code !== expectedExitCode) throw new Error(`fixture exit ${code}; stderr: ${stderr}`)
      if (expectedExitCode === 0) expect(stderr).toBe("")
    },
  }
}

type Harness = {
  root: string
  statePath: string
  marker: string
  log: string
  child: ReturnType<typeof Bun.spawn>
  frames: FrameReader
  initialize(): Promise<void>
  write(message: AgentWorkplaceMessage): void
  close(expectedExitCode?: number): Promise<void>
}

async function initializeAndReadIntents(harness: Harness) {
  await harness.initialize()
  expect(await harness.frames.next()).toMatchObject({ message_type: "ready" })
  const source = await harness.frames.nextInline()
  const ensure = await harness.frames.nextLifecycle()
  if (!("planned_worktree" in ensure)) throw new Error("fixture did not emit ensure request")
  return { source, ensure: ensure as EnsureRequest }
}

type InitializeMessage = {
  schema_id: "fmx.runtime-extension"
  schema_version: 1
  message_type: "initialize"
  request_id: string
  workplace_instance_id: string
  extension_id: string
  configuration_id: string
  placement_id: string
  fmx_session: string
  protocol_version: 1
}

function initializeMessage(): InitializeMessage {
  return {
    schema_id: "fmx.runtime-extension",
    schema_version: 1,
    message_type: "initialize",
    request_id: "phase1c-initialize",
    workplace_instance_id: "phase1c-workplace",
    extension_id: "phase1c-extension",
    configuration_id: "phase1c-configuration",
    placement_id: "phase1c-placement",
    fmx_session: "session-beta",
    protocol_version: 1,
  }
}

function releaseProbe() {
  return {
    schema_id: "fmx.runtime-extension",
    schema_version: 1,
    message_type: "snapshot_invalidated",
    fmx_session: "session-beta",
    revision: "1",
  } as const
}

type CompleteEnsureReceipt = AgentWorkplaceMessage & {
  receipt_id: string
  receipt_digest: string
  ensure_digest: string
  launch_digest: string
  effects: { fx: { status: "started"; conversation_id: string } }
}

type AssertableReceipt = AgentWorkplaceMessage & { receipt_id: string; receipt_digest: string }

function completeEnsureReceipt(ensure: EnsureRequest): CompleteEnsureReceipt {
  return ensureLifecycleMessageSchema.parse({
    schema_id: "fmx.ensure-lifecycle",
    schema_version: 1,
    message_type: "ensure_receipt",
    request_id: ensure.request_id,
    receipt_id: "phase1c-ensure-receipt",
    receipt_digest: "1".repeat(64),
    workplace_instance_id: ensure.workplace_instance_id,
    fmx_session: ensure.fmx_session,
    ensure_id: ensure.ensure_id,
    ensure_digest: ensure.ensure_digest,
    launch_id: ensure.launch_id,
    launch_digest: ensure.launch_digest,
    worktree_id: ensure.worktree_id,
    agent_id: ensure.agent_id,
    status: "complete",
    effects: {
      worktree: { status: "created", directory: ensure.planned_worktree.directory, head_commit: "b".repeat(40) },
      manifest: { status: "claimed", agent_id: ensure.agent_id },
      companion: { status: "started", session_name: `fmx-${ensure.agent_id}`, pane_id: `p_${ensure.agent_id}` },
      fx: { status: "started", conversation_id: "1788123456789-1788123456789000000-a1b2c3d4" },
    },
  }) as unknown as CompleteEnsureReceipt
}

function endedReceipt(end: EndRequest): AssertableReceipt {
  return ensureLifecycleMessageSchema.parse({
    schema_id: "fmx.ensure-lifecycle",
    schema_version: 1,
    message_type: "end_receipt",
    request_id: end.request_id,
    receipt_id: "phase1c-end-receipt",
    receipt_digest: "2".repeat(64),
    workplace_instance_id: end.workplace_instance_id,
    fmx_session: end.fmx_session,
    ensure_id: end.ensure_id,
    ensure_digest: end.ensure_digest,
    launch_id: end.launch_id,
    launch_digest: end.launch_digest,
    worktree_id: end.worktree_id,
    agent_id: end.agent_id,
    end_id: end.end_id,
    end_digest: end.end_digest,
    conversation_id: end.conversation_id,
    proof: {
      kind: "ended",
      companion_session: `fmx-${end.agent_id}`,
      pane_id: `p_${end.agent_id}`,
      exit_code: 0,
      signal: 0,
      reason: "requested",
      observed_at: "2026-08-30T20:00:00.000Z",
    },
  }) as AssertableReceipt
}

function cleanupResult(cleanup: CleanupRequest): AssertableReceipt {
  return ensureLifecycleMessageSchema.parse({
    schema_id: "fmx.ensure-lifecycle",
    schema_version: 1,
    message_type: "cleanup_receipt",
    request_id: cleanup.request_id,
    receipt_id: "phase1c-cleanup-receipt",
    receipt_digest: "3".repeat(64),
    workplace_instance_id: cleanup.workplace_instance_id,
    fmx_session: cleanup.fmx_session,
    ensure_id: cleanup.ensure_id,
    ensure_digest: cleanup.ensure_digest,
    launch_id: cleanup.launch_id,
    launch_digest: cleanup.launch_digest,
    worktree_id: cleanup.worktree_id,
    agent_id: cleanup.agent_id,
    end_id: cleanup.end_id,
    end_digest: cleanup.end_digest,
    cleanup_id: cleanup.cleanup_id,
    cleanup_digest: cleanup.cleanup_digest,
    conversation_id: cleanup.conversation_id,
    worktree_directory: cleanup.worktree_directory,
    outcome: { kind: "not_applicable" },
    observed_at: "2026-08-30T20:00:01.000Z",
  }) as AssertableReceipt
}

async function state(harness: Harness) {
  return JSON.parse(await readFile(harness.statePath, "utf8"))
}

class FrameReader {
  private readonly decoder = new ContractFrameDecoder()
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly queued: Array<{ payload: Uint8Array; message: AgentWorkplaceMessage | InlineLaunchSourceRequest }> = []

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  async next(): Promise<AgentWorkplaceMessage> {
    return (await this.nextRaw()).message as AgentWorkplaceMessage
  }

  async nextInline(): Promise<InlineLaunchSourceRequest> {
    const next = await this.nextRaw()
    return parseInlineLaunchSourceRequest(JSON.parse(Buffer.from(next.payload).toString("utf8")))
  }

  async nextLifecycle(): Promise<EnsureLifecycleMessage> {
    return ensureLifecycleMessageSchema.parse(await this.next())
  }

  private async nextRaw() {
    const queued = this.queued.shift()
    if (queued) return queued
    for (;;) {
      const next = await this.reader.read()
      if (next.done) throw new Error("fixture stdout ended before a frame")
      for (const payload of this.decoder.push(next.value)) {
        let message: AgentWorkplaceMessage | InlineLaunchSourceRequest
        try {
          message = decodeAgentWorkplacePayload(payload)
        } catch {
          message = parseInlineLaunchSourceRequest(JSON.parse(Buffer.from(payload).toString("utf8")))
        }
        this.queued.push({ payload, message })
      }
      const available = this.queued.shift()
      if (available) return available
    }
  }
}
