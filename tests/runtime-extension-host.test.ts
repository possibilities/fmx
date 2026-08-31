import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { RUNTIME_EXTENSION_CAPABILITIES } from "../src/agentworkplace-contracts.ts"
import type { RuntimeExtensionSurface } from "../src/multiplexer.ts"
import { RuntimeExtensionSurfaceError } from "../src/multiplexer.ts"
import { runtimeExtensionRequestHandler } from "../src/runtime-extension-host.ts"
import { RuntimeExtensionHost } from "../src/runtime-extension-host.ts"
import type { RuntimeExtensionInboundRequest } from "../src/runtime-extension.ts"
import type { RecoveryCardSpec } from "../src/recovery-card.ts"
import type { RuntimeExtensionStartup } from "../src/runtime-startup.ts"

const FMX_SESSION = "workers"
const NEVER = new AbortController().signal
const AGENT_ID = "a".repeat(32)
const FIXTURE = fileURLToPath(new URL("./fixtures/runtime-extension.ts", import.meta.url))
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
