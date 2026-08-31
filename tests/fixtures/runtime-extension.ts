#!/usr/bin/env bun

import { appendFile } from "node:fs/promises"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_CAPABILITIES,
  RUNTIME_EXTENSION_SCHEMA_ID,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  runtimeExtensionMessageSchema,
  type AgentWorkplaceMessage,
  type RuntimeExtensionMessage,
} from "../../src/agentworkplace-contracts.ts"
import { ContractFrameDecoder } from "../../src/contract-codec.ts"

type FixtureMode =
  | "ready"
  | "refuse"
  | "timeout"
  | "exit_before_ready"
  | "identity_mismatch"
  | "missing_capability"
  | "malformed"
  | "exit_after_ready"

const mode = (process.env.FMX_FIXTURE_EXTENSION_MODE ?? "ready") as FixtureMode
const logPath = process.env.FMX_FIXTURE_EXTENSION_LOG
const scripted = readScript(process.env.FMX_FIXTURE_EXTENSION_SCRIPT)
const autoSnapshot = process.env.FMX_FIXTURE_EXTENSION_AUTO_SNAPSHOT === "1"
const presentFocus = readOptionalBoolean(process.env.FMX_FIXTURE_EXTENSION_PRESENT_FOCUS)
const presentDelayMs = readBoundedDelay(process.env.FMX_FIXTURE_EXTENSION_PRESENT_DELAY_MS)
const clearAfterAction = process.env.FMX_FIXTURE_EXTENSION_CLEAR_AFTER_ACTION === "1"
const stderrText = process.env.FMX_FIXTURE_EXTENSION_STDERR
if (stderrText) process.stderr.write(stderrText)

const decoder = new ContractFrameDecoder()
let initialized = false
let requestSequence = 0
let snapshotRequestPending = false
let lastSnapshotRevision: string | null = null
let presentSent = false

type InitializeMessage = {
  request_id: string
  workplace_instance_id: string
  extension_id: string
  configuration_id: string
  placement_id: string
  fmx_session: string
  protocol_version: 1
}

type SnapshotInvalidatedMessage = Extract<RuntimeExtensionMessage, { revision: unknown }>
type SnapshotResultMessage = Extract<RuntimeExtensionMessage, { agents: unknown }>
type RecoveryCardActionMessage = Extract<RuntimeExtensionMessage, { action_id: unknown }>

for await (const chunk of Bun.stdin.stream()) {
  for (const payload of decoder.push(chunk)) {
    const decoded = decodeAgentWorkplacePayload(payload)
    const parsed = runtimeExtensionMessageSchema.safeParse(decoded)
    if (!parsed.success) throw new Error(`fixture received non-Runtime-extension schema ${decoded.schema_id}`)
    const message = parsed.data
    await record(message)
    if (!initialized) {
      if (message.message_type !== "initialize") {
        throw new Error(`fixture expected initialize, received ${message.message_type}`)
      }
      initialized = true
      await initialize(message as unknown as InitializeMessage)
      continue
    }
    await handleRuntimeMessage(message)
  }
}
decoder.finish()

async function initialize(
  message: InitializeMessage,
): Promise<void> {
  if (mode === "exit_before_ready") {
    process.exit(17)
  }
  if (mode === "timeout") return
  if (mode === "malformed") {
    process.stdout.write(Buffer.from([0, 0, 0, 2, 0xff, 0xff]))
    return
  }
  if (mode === "refuse") {
    write({
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "response",
      request_id: message.request_id,
      operation: "initialize",
      ok: false,
      error: { code: "fixture_refusal", message: "The fixture refused readiness." },
    })
    return
  }

  const capabilities = mode === "missing_capability"
    ? RUNTIME_EXTENSION_CAPABILITIES.filter((capability) => capability !== "member_snapshot_pull")
    : [...RUNTIME_EXTENSION_CAPABILITIES, "fixture_observability"]
  write({
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "ready",
    request_id: message.request_id,
    workplace_instance_id: message.workplace_instance_id,
    extension_id: message.extension_id,
    configuration_id: mode === "identity_mismatch"
      ? `${message.configuration_id}-foreign`
      : message.configuration_id,
    placement_id: message.placement_id,
    fmx_session: message.fmx_session,
    protocol_version: message.protocol_version,
    capabilities,
  })
  for (const command of scripted) write(command)
  if (mode === "exit_after_ready") {
    await Bun.sleep(10)
    process.exit(19)
  }
}

async function handleRuntimeMessage(message: RuntimeExtensionMessage): Promise<void> {
  switch (message.message_type) {
    case "snapshot_invalidated": {
      const invalidation = message as SnapshotInvalidatedMessage
      if (!autoSnapshot || snapshotRequestPending) return
      snapshotRequestPending = true
      write({
        schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
        schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
        message_type: "snapshot_get",
        request_id: requestId("snapshot"),
        fmx_session: invalidation.fmx_session,
        after_revision: lastSnapshotRevision,
      })
      return
    }
    case "snapshot_result": {
      const snapshot = message as SnapshotResultMessage
      snapshotRequestPending = false
      lastSnapshotRevision = snapshot.revision
      if (presentFocus === null || presentSent || snapshot.agents.length === 0) return
      presentSent = true
      if (presentDelayMs > 0) await Bun.sleep(presentDelayMs)
      write({
        schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
        schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
        message_type: "present",
        request_id: requestId("present"),
        fmx_session: snapshot.fmx_session,
        agent_id: snapshot.agents[0]!.agent_id,
        focus: presentFocus,
      })
      return
    }
    case "unavailable_slot_action": {
      const action = message as RecoveryCardActionMessage
      write({
        schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
        schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
        message_type: "response",
        request_id: action.request_id,
        operation: "unavailable_slot_action",
        ok: true,
        status: "accepted",
      })
      if (clearAfterAction) {
        write({
          schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
          schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
          message_type: "unavailable_slot_clear",
          request_id: requestId("clear"),
          fmx_session: action.fmx_session,
          slot_id: action.slot_id,
          card_revision: action.card_revision,
        })
      }
      return
    }
    default:
      return
  }
}

function write(message: AgentWorkplaceMessage): void {
  process.stdout.write(Buffer.from(encodeAgentWorkplaceFrame(message)))
}

function requestId(kind: string): string {
  requestSequence += 1
  return `fixture-${kind}-${requestSequence}`
}

async function record(message: RuntimeExtensionMessage): Promise<void> {
  if (!logPath) return
  await appendFile(logPath, `${JSON.stringify(message)}\n`, { encoding: "utf8", mode: 0o600 })
}

function readScript(value: string | undefined): AgentWorkplaceMessage[] {
  if (value === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error("fixture script is not JSON", { cause: error })
  }
  if (!Array.isArray(parsed)) throw new Error("fixture script must be an array")
  return parsed.map((entry) => {
    const message = runtimeExtensionMessageSchema.parse(entry)
    if (
      message.message_type !== "snapshot_get" &&
      message.message_type !== "present" &&
      message.message_type !== "unavailable_slot_publish" &&
      message.message_type !== "unavailable_slot_clear"
    ) {
      throw new Error(`fixture cannot script ${message.message_type} in the extension-to-fmx direction`)
    }
    return message
  })
}

function readOptionalBoolean(value: string | undefined): boolean | null {
  if (value === undefined) return null
  if (value === "true") return true
  if (value === "false") return false
  throw new Error("FMX_FIXTURE_EXTENSION_PRESENT_FOCUS must be true or false")
}

function readBoundedDelay(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error("FMX_FIXTURE_EXTENSION_PRESENT_DELAY_MS must be a nonnegative integer")
  }
  const delay = Number(value)
  if (!Number.isSafeInteger(delay) || delay > 5_000) {
    throw new Error("FMX_FIXTURE_EXTENSION_PRESENT_DELAY_MS must not exceed 5000")
  }
  return delay
}
