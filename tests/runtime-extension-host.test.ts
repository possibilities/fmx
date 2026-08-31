import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import {
  RUNTIME_EXTENSION_CAPABILITIES,
  ensureLifecycleMessageSchema,
  type EnsureLifecycleMessage,
} from "../src/agentworkplace-contracts.ts"
import type { RuntimeExtensionSurface } from "../src/multiplexer.ts"
import { RuntimeExtensionSurfaceError } from "../src/multiplexer.ts"
import {
  runtimeExtensionRequestHandler,
  RuntimeExtensionHost,
  RuntimeExtensionReceiptQueue,
} from "../src/runtime-extension-host.ts"
import type { RuntimeExtensionInboundRequest } from "../src/runtime-extension.ts"
import type {
  RuntimeExtensionLifecycleInbound,
  RuntimeExtensionLifecycleReceipt,
  RuntimeExtensionLifecycleRequest,
} from "../src/runtime-extension.ts"
import type { RecoveryCardSpec } from "../src/recovery-card.ts"
import type { RuntimeExtensionStartup } from "../src/runtime-startup.ts"
import { encodeCanonicalJson } from "../src/contract-codec.ts"
import {
  INLINE_LAUNCH_SOURCE_SCHEMA_ID,
  INLINE_LAUNCH_SOURCE_SCHEMA_VERSION,
  deriveFrozenLaunchDigest,
  deriveInlineLaunchSourceDigest,
  encodeInlineSourceBytes,
  type FrozenLaunchRequest,
  type InlineLaunchSourceRequest,
} from "../src/inline-launch-source.ts"

const FMX_SESSION = "workers"
const NEVER = new AbortController().signal
const AGENT_ID = "a".repeat(32)
const FIXTURE = fileURLToPath(new URL("./fixtures/runtime-extension.ts", import.meta.url))
const PEER = fileURLToPath(new URL("./runtime-extension-supervisor-child.ts", import.meta.url))
const LIFECYCLE_FIXTURE = fileURLToPath(new URL(
  "../contracts/agentworkplace/v1/ensure-lifecycle.jsonl",
  import.meta.url,
))
const CARD: RecoveryCardSpec = {
  slot_id: "slot-a",
  card_revision: "4",
  title: "Member unavailable",
  message: "The exact member could not be restored.",
  action: { action_id: "start-fresh", label: "Start fresh" },
}

const STARTUP: RuntimeExtensionStartup = {
  association: {
    schema_id: "fmx.runtime-extension",
    schema_version: 1,
    message_type: "association",
    workplace_instance_id: "fixture-workplace",
    extension_id: "fixture-extension",
    configuration_id: "fixture-configuration",
    members: [
      { placement_id: "first", fmx_session: "managers" },
      { placement_id: "second", fmx_session: FMX_SESSION },
    ],
  },
  registration: {
    schema_id: "fmx.runtime-extension",
    schema_version: 1,
    message_type: "registration",
    extension_id: "fixture-extension",
    argv: [process.execPath, FIXTURE],
    protocol: { minimum: 1, maximum: 1 },
    required_capabilities: [...RUNTIME_EXTENSION_CAPABILITIES],
  },
  placementId: "second",
}

function request(
  message: Record<string, unknown>,
): RuntimeExtensionInboundRequest {
  return {
    schema_id: "fmx.runtime-extension",
    schema_version: 1,
    ...message,
  } as RuntimeExtensionInboundRequest
}

function surface() {
  const calls: unknown[][] = []
  const value: RuntimeExtensionSurface = {
    subscribeInvalidation: () => () => {},
    snapshot: async () => ({
      revision: "8",
      selected_agent_id: AGENT_ID,
      agents: [{
        agent_id: AGENT_ID,
        pane_id: `p_${AGENT_ID}`,
        display_id: 1,
        created_at_ms: 1,
        lifecycle: "running",
        state: "working",
        attention: null,
        directory: process.cwd(),
        worktree: true,
        fx_conversation: null,
        correlation: null,
      }],
    }),
    present: (...args) => calls.push(["present", ...args]),
    publishRecoveryCard: (...args) => calls.push(["publish", ...args]),
    clearRecoveryCard: (...args) => calls.push(["clear", ...args]),
  }
  return { calls, value }
}

test("adapts snapshot, present, and bounded Recovery-card requests to the exact surface", async () => {
  const fake = surface()
  const handle = runtimeExtensionRequestHandler(fake.value, FMX_SESSION)

  expect(await handle(request({
    message_type: "snapshot_get",
    request_id: "snapshot-1",
    fmx_session: FMX_SESSION,
    after_revision: null,
  }), NEVER)).toMatchObject({
    message_type: "snapshot_result",
    request_id: "snapshot-1",
    fmx_session: FMX_SESSION,
    revision: "8",
    selected_agent_id: AGENT_ID,
  })
  expect(await handle(request({
    message_type: "present",
    request_id: "present-1",
    fmx_session: FMX_SESSION,
    agent_id: AGENT_ID,
    focus: false,
  }), NEVER)).toMatchObject({
    message_type: "response",
    operation: "present",
    ok: true,
    status: "accepted",
  })
  expect(await handle(request({
    message_type: "unavailable_slot_publish",
    request_id: "publish-1",
    fmx_session: FMX_SESSION,
    card: CARD,
  }), NEVER)).toMatchObject({ operation: "unavailable_slot_publish", ok: true })
  expect(await handle(request({
    message_type: "unavailable_slot_clear",
    request_id: "clear-1",
    fmx_session: FMX_SESSION,
    slot_id: CARD.slot_id,
    card_revision: CARD.card_revision,
  }), NEVER)).toMatchObject({ operation: "unavailable_slot_clear", ok: true })

  expect(fake.calls).toEqual([
    ["present", AGENT_ID, false],
    ["publish", CARD],
    ["clear", CARD.slot_id, CARD.card_revision],
  ])
})

test("returns correlated capability failures without disconnecting the child link", async () => {
  const fake = surface()
  fake.value.present = () => {
    throw new RuntimeExtensionSurfaceError("busy", "something is already open")
  }
  const handle = runtimeExtensionRequestHandler(fake.value, FMX_SESSION)
  const present = request({
    message_type: "present",
    request_id: "present-busy",
    fmx_session: FMX_SESSION,
    agent_id: AGENT_ID,
    focus: true,
  })
  expect(await handle(present, NEVER)).toEqual({
    schema_id: "fmx.runtime-extension",
    schema_version: 1,
    message_type: "response",
    request_id: "present-busy",
    operation: "present",
    ok: false,
    error: { code: "busy", message: "something is already open" },
  })

  const aborted = new AbortController()
  aborted.abort()
  expect(await handle(present, aborted.signal)).toMatchObject({
    ok: false,
    error: { code: "cancelled" },
  })
  expect(await handle({ ...present, fmx_session: "managers" }, NEVER)).toMatchObject({
    ok: false,
    error: { code: "identity_mismatch" },
  })
})

test("bounds and sanitizes an unexpected host error into the v1 response contract", async () => {
  const fake = surface()
  fake.value.snapshot = async () => {
    throw new Error(`bad\n${"é".repeat(900)}`)
  }
  const outcome = await runtimeExtensionRequestHandler(fake.value, FMX_SESSION)(request({
    message_type: "snapshot_get",
    request_id: "snapshot-bad",
    fmx_session: FMX_SESSION,
    after_revision: "7",
  }), NEVER)
  expect(outcome).toMatchObject({
    message_type: "response",
    operation: "snapshot_get",
    ok: false,
    error: { code: "internal_error" },
  })
  if (outcome.message_type !== "response" || outcome.ok !== false) throw new Error("expected a failure response")
  expect(outcome.error.message.includes("\n")).toBe(false)
  expect(Buffer.byteLength(outcome.error.message)).toBeLessThanOrEqual(1024)
})

test("threads the injected lifecycle handler and asynchronous receipt publisher through the host", async () => {
  const lifecycle = await frozenLifecycleMessages()
  const request = lifecycle.find((message): message is RuntimeExtensionLifecycleRequest =>
    message.message_type === "ensure_request" && "planned_worktree" in message)!
  const receipt = lifecycle.find((message): message is RuntimeExtensionLifecycleReceipt =>
    message.message_type === "ensure_receipt" && "status" in message && message.status === "complete")!
  const startup = structuredClone(STARTUP)
  startup.association.members[1]!.fmx_session = request.fmx_session
  startup.registration.argv = [process.execPath, PEER]
  const observed: RuntimeExtensionLifecycleInbound[] = []
  const host = await RuntimeExtensionHost.start(startup, surface().value, {
    env: {
      ...process.env,
      FMX_SUPERVISOR_CHILD_MODE: "ready",
      FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([request]),
      FMX_SUPERVISOR_CHILD_ACK_LIFECYCLE: "1",
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 50,
    terminateGraceMs: 50,
    onLifecycleMessage: (message) => {
      observed.push(message)
    },
  })
  try {
    await waitFor(() => observed.some((message) => message.message_type === "ensure_request"))
    await host.publishLifecycleReceipt(receipt)
    await waitFor(() => observed.some((message) => message.message_type === "receipt_acknowledgement"))
    expect(observed.map((message) => message.message_type)).toEqual([
      "ensure_request",
      "receipt_acknowledgement",
    ])
    expect(host.state).toBe("ready")
  } finally {
    await host.close()
  }
})

test("queues same-chunk readiness receipts without blocking and flushes them in order", async () => {
  const lifecycle = await frozenLifecycleMessages()
  const request = lifecycle.find((message): message is RuntimeExtensionLifecycleRequest =>
    message.message_type === "ensure_request" && "planned_worktree" in message)!
  const receipts = lifecycle.filter((message) =>
    message.message_type === "ensure_receipt" && message.ensure_id === request.ensure_id
  ) as RuntimeExtensionLifecycleReceipt[]
  const startup = structuredClone(STARTUP)
  startup.association.members[1]!.fmx_session = request.fmx_session
  startup.registration.argv = [process.execPath, PEER]
  const publisher = new RuntimeExtensionReceiptQueue()
  const acknowledgements: string[] = []
  let lifecycleRequestObserved = false
  await Promise.all(receipts.map((receipt) => publisher.publish(receipt)))
  const host = await RuntimeExtensionHost.start(startup, surface().value, {
    env: {
      ...process.env,
      FMX_SUPERVISOR_CHILD_MODE: "ready",
      FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([request]),
      FMX_SUPERVISOR_CHILD_ACK_LIFECYCLE: "1",
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 50,
    terminateGraceMs: 50,
    onLifecycleMessage: (message) => {
      if (message.message_type === "ensure_request") {
        lifecycleRequestObserved = true
      } else if (message.message_type === "receipt_acknowledgement") {
        acknowledgements.push(message.receipt_id)
      }
    },
  })
  try {
    await waitFor(() => lifecycleRequestObserved)
    await publisher.bind(host)
    await waitFor(() => acknowledgements.length === receipts.length)
    expect(acknowledgements).toEqual(receipts.map(({ receipt_id }) => receipt_id))
  } finally {
    await host.close()
  }
})

test("forwards lifecycle and inline-source callbacks in either child arrival order", async () => {
  const lifecycle = await frozenLifecycleMessages()
  const lifecycleRequest = lifecycle.find((message): message is RuntimeExtensionLifecycleRequest =>
    message.message_type === "ensure_request" && "planned_worktree" in message)!
  const inline = inlineSourceRequest(lifecycleRequest.fmx_session)

  for (const [label, script] of [
    ["lifecycle-first", [lifecycleRequest, inline]],
    ["inline-first", [inline, lifecycleRequest]],
  ] as const) {
    const startup = structuredClone(STARTUP)
    startup.association.members[1]!.fmx_session = lifecycleRequest.fmx_session
    startup.registration.argv = [process.execPath, PEER]
    const observed: string[] = []
    const host = await RuntimeExtensionHost.start(startup, surface().value, {
      env: {
        ...process.env,
        FMX_SUPERVISOR_CHILD_MODE: "ready",
        FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify(script),
      },
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      shutdownGraceMs: 50,
      terminateGraceMs: 50,
      onLifecycleMessage: (message) => {
        observed.push(`${label}:${message.message_type}`)
      },
      onInlineLaunchSourceRequest: (request) => {
        observed.push(`${label}:${request.message_type}`)
      },
    })
    try {
      await waitFor(() => observed.length === 2)
      expect(observed).toEqual([
        `${label}:${script[0]!.message_type}`,
        `${label}:${script[1]!.message_type}`,
      ])
      expect(host.state).toBe("ready")
    } finally {
      await host.close()
    }
  }
})

test("recovers unrelated host operations after a callback failure using supervisor restart semantics", async () => {
  const lifecycle = await frozenLifecycleMessages()
  const lifecycleRequest = lifecycle.find((message): message is RuntimeExtensionLifecycleRequest =>
    message.message_type === "ensure_request" && "planned_worktree" in message)!
  const diagnostics: string[] = []
  let callbackAttempts = 0
  const startup = structuredClone(STARTUP)
  startup.association.members[1]!.fmx_session = lifecycleRequest.fmx_session
  startup.registration.argv = [process.execPath, PEER]
  const host = await RuntimeExtensionHost.start(startup, surface().value, {
    env: {
      ...process.env,
      FMX_SUPERVISOR_CHILD_MODE: "reply",
      FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([lifecycleRequest]),
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 50,
    terminateGraceMs: 50,
    onDiagnostic: (error) => diagnostics.push(error.code),
    onLifecycleMessage: () => {
      if (callbackAttempts++ === 0) throw new Error("first callback failed")
    },
  })
  try {
    await waitFor(() => host.generation === 2 && host.state === "ready" && diagnostics.length > 0)
    expect(diagnostics).toContain("handler_failed")
    expect(await host.forwardRecoveryAction({
      slot_id: CARD.slot_id,
      card_revision: CARD.card_revision,
      action_id: CARD.action.action_id,
    })).toMatchObject({ ok: true, operation: "unavailable_slot_action" })
    expect(host.state).toBe("ready")
  } finally {
    await host.close()
  }
})

test("announces exact post-restart readiness once the replacement generation is usable", async () => {
  const lifecycle = await frozenLifecycleMessages()
  const lifecycleRequest = lifecycle.find((message): message is RuntimeExtensionLifecycleRequest =>
    message.message_type === "ensure_request" && "planned_worktree" in message)!
  const startup = structuredClone(STARTUP)
  startup.association.members[1]!.fmx_session = lifecycleRequest.fmx_session
  startup.registration.argv = [process.execPath, PEER]
  let callbackAttempts = 0
  const readyGenerations: number[] = []
  let host: RuntimeExtensionHost | null = null
  host = await RuntimeExtensionHost.start(startup, surface().value, {
    env: {
      ...process.env,
      FMX_SUPERVISOR_CHILD_MODE: "reply",
      FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([lifecycleRequest]),
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 50,
    terminateGraceMs: 50,
    onLifecycleMessage: () => {
      if (callbackAttempts++ === 0) throw new Error("restart for callback test")
    },
    onRestartReady: () => {
      readyGenerations.push(host!.generation)
      expect(host!.state).toBe("ready")
    },
  })
  try {
    await waitFor(() => readyGenerations.length === 1)
    expect(readyGenerations).toEqual([2])
    expect(host.generation).toBe(2)
    expect(host.state).toBe("ready")
  } finally {
    await host.close()
  }
})

test("restarts one post-readiness child generation, then degrades without a crash loop", async () => {
  const fake = surface()
  const diagnostics: Array<{ code: string; generation: number | null }> = []
  const host = await RuntimeExtensionHost.start(STARTUP, fake.value, {
    env: {
      ...process.env,
      FMX_FIXTURE_EXTENSION_MODE: "exit_after_ready",
    },
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 50,
    terminateGraceMs: 50,
    onDiagnostic: (error) => diagnostics.push({ code: error.code, generation: error.generation }),
  })
  try {
    await waitFor(() => host.state === "degraded" && host.generation === 2 && diagnostics.length >= 2)
    expect(diagnostics.map(({ code }) => code).every((code) =>
      code === "child_exit" || code === "stdout_closed"
    )).toBe(true)
    expect(diagnostics.map(({ generation }) => generation)).toEqual([1, 2])
    await Bun.sleep(50)
    expect(host.generation).toBe(2)
    expect(host.processId).toBeNull()
  } finally {
    await host.close()
  }
})

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
}

async function frozenLifecycleMessages(): Promise<EnsureLifecycleMessage[]> {
  return (await readFile(LIFECYCLE_FIXTURE, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => ensureLifecycleMessageSchema.parse(JSON.parse(line)) as EnsureLifecycleMessage)
}

function inlineSourceRequest(fmxSession: string): InlineLaunchSourceRequest {
  const initialWork = encodeInlineSourceBytes(Buffer.from("private host source\n", "utf8"))
  const launchControls = encodeInlineSourceBytes(encodeCanonicalJson({ remaining_global_args: [] }))
  const launch = {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "launch_request",
    request_id: "host-fx-launch-request",
    launch_id: "host-launch",
    launch_digest: "0".repeat(64),
    admission_key: "host-admission",
    conversation_name: "Host fixture",
    resume: { mode: "fresh" },
    state_root: "/var/tmp/fmx-host-state",
    directory: "/var/tmp/fmx-host-worktree",
    initial_work_digest: initialWork.sha256,
    remaining_launch_controls_digest: launchControls.sha256,
  } satisfies FrozenLaunchRequest
  launch.launch_digest = deriveFrozenLaunchDigest(launch)
  const request = {
    schema_id: INLINE_LAUNCH_SOURCE_SCHEMA_ID,
    schema_version: INLINE_LAUNCH_SOURCE_SCHEMA_VERSION,
    message_type: "source_request",
    request_id: "host-source-request",
    workplace_instance_id: "fixture-workplace",
    fmx_session: fmxSession,
    ensure_id: "host-ensure",
    ensure_digest: "e".repeat(64),
    worktree_id: "host-worktree",
    agent_id: AGENT_ID,
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    admission_key: launch.admission_key,
    source_id: "host-source",
    source_digest: "0".repeat(64),
    launch_request: launch,
    initial_work: initialWork,
    launch_controls: launchControls,
  } satisfies InlineLaunchSourceRequest
  request.source_digest = deriveInlineLaunchSourceDigest(request)
  return request
}
