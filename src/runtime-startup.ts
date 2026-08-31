import { isAbsolute, normalize } from "node:path"
import {
  agentDefaultsFor,
  workplaceMembershipFor,
  type AgentDefaults,
  type LoadedConfig,
} from "./config.ts"
import { DEFAULT_FMX_NAME, type FmxHome } from "./home.ts"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_CAPABILITIES,
  RUNTIME_EXTENSION_SCHEMA_ID,
  runtimeExtensionMessageSchema,
} from "./agentworkplace-contracts.ts"
import { decodeStrictJson, encodeCanonicalJson, type JsonValue } from "./contract-codec.ts"
import {
  loadRuntimeExtensionRegistration,
  runtimeExtensionRegistrationMessage,
} from "./runtime-extension-registration.ts"

export const RUNTIME_STARTUP_SNAPSHOT_ENV_VAR = "FMX_RUNTIME_STARTUP_SNAPSHOT"
export const RUNTIME_STARTUP_SNAPSHOT_VERSION = 1
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

export type RuntimeAssociationMessage = {
  schema_id: typeof RUNTIME_EXTENSION_SCHEMA_ID
  schema_version: typeof AGENTWORKPLACE_CONTRACT_VERSION
  message_type: "association"
  workplace_instance_id: string
  extension_id: string
  configuration_id: string
  members: Array<{ placement_id: string; fmx_session: string }>
}

export type RuntimeRegistrationMessage = {
  schema_id: typeof RUNTIME_EXTENSION_SCHEMA_ID
  schema_version: typeof AGENTWORKPLACE_CONTRACT_VERSION
  message_type: "registration"
  extension_id: string
  argv: string[]
  protocol: { minimum: number; maximum: number }
  required_capabilities: string[]
}

export type RuntimeExtensionStartup = {
  association: RuntimeAssociationMessage
  registration: RuntimeRegistrationMessage
  placementId: string
}

export type RuntimeStartupSnapshot = {
  schemaVersion: typeof RUNTIME_STARTUP_SNAPSHOT_VERSION
  fmxSession: string
  agentDefaults: AgentDefaults
  runtimeExtension: RuntimeExtensionStartup | null
}

/** Resolve only for a cold Runtime creator; a live join never consults this again. */
export async function resolveRuntimeStartupSnapshot(
  config: LoadedConfig,
  home: FmxHome,
): Promise<RuntimeStartupSnapshot> {
  const fmxSession = home.name ?? DEFAULT_FMX_NAME
  const defaults = agentDefaultsFor(config, fmxSession)
  const membership = workplaceMembershipFor(config, fmxSession)
  if (membership === null) {
    return {
      schemaVersion: RUNTIME_STARTUP_SNAPSHOT_VERSION,
      fmxSession,
      agentDefaults: defaults,
      runtimeExtension: null,
    }
  }

  const registration = await loadRuntimeExtensionRegistration(
    home.configDirectory,
    membership.extensionId,
  )
  const association: RuntimeAssociationMessage = {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "association",
    workplace_instance_id: membership.workplaceInstanceId,
    extension_id: membership.extensionId,
    configuration_id: membership.configurationId,
    members: membership.members.map((member) => ({
      placement_id: member.placementId,
      fmx_session: member.fmxSession,
    })),
  }
  const registrationMessage = runtimeExtensionRegistrationMessage(registration) as unknown as RuntimeRegistrationMessage
  return {
    schemaVersion: RUNTIME_STARTUP_SNAPSHOT_VERSION,
    fmxSession,
    agentDefaults: defaults,
    runtimeExtension: {
      association,
      registration: registrationMessage,
      placementId: membership.placementId,
    },
  }
}

export function encodeRuntimeStartupSnapshot(snapshot: RuntimeStartupSnapshot): string {
  const value = snapshotJson(snapshot)
  // Decode through the same strict path before it becomes a child authority.
  validateRuntimeStartupSnapshot(value)
  return new TextDecoder().decode(encodeCanonicalJson(value))
}

export function decodeRuntimeStartupSnapshot(
  encoded: string,
  expectedFmxSession?: string,
): RuntimeStartupSnapshot {
  const bytes = new TextEncoder().encode(encoded)
  const value = decodeStrictJson(bytes)
  const canonical = encodeCanonicalJson(value)
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) {
    throw new Error("Runtime startup snapshot is not canonical JSON")
  }
  const snapshot = validateRuntimeStartupSnapshot(value)
  if (expectedFmxSession !== undefined && snapshot.fmxSession !== expectedFmxSession) {
    throw new Error(
      `Runtime startup snapshot names fmx Session ${snapshot.fmxSession}; expected ${expectedFmxSession}`,
    )
  }
  return snapshot
}

export function runtimeStartupEnvironment(snapshot: RuntimeStartupSnapshot): Record<string, string> {
  return { [RUNTIME_STARTUP_SNAPSHOT_ENV_VAR]: encodeRuntimeStartupSnapshot(snapshot) }
}

function snapshotJson(snapshot: RuntimeStartupSnapshot): JsonValue {
  const defaults: Record<string, JsonValue> = {}
  if (snapshot.agentDefaults.stateDir !== undefined) defaults.state_dir = snapshot.agentDefaults.stateDir
  if (snapshot.agentDefaults.model !== undefined) defaults.model = snapshot.agentDefaults.model
  if (snapshot.agentDefaults.effort !== undefined) defaults.effort = snapshot.agentDefaults.effort
  return {
    agent_defaults: defaults,
    fmx_session: snapshot.fmxSession,
    runtime_extension: snapshot.runtimeExtension === null
      ? null
      : {
          association: snapshot.runtimeExtension.association as unknown as JsonValue,
          placement_id: snapshot.runtimeExtension.placementId,
          registration: snapshot.runtimeExtension.registration as unknown as JsonValue,
        },
    schema_version: snapshot.schemaVersion,
  }
}

function validateRuntimeStartupSnapshot(value: JsonValue): RuntimeStartupSnapshot {
  if (!isJsonObject(value)) throw new Error("Runtime startup snapshot must be an object")
  assertExactFields(value, ["agent_defaults", "fmx_session", "runtime_extension", "schema_version"], "snapshot")
  if (value.schema_version !== RUNTIME_STARTUP_SNAPSHOT_VERSION) {
    throw new Error(`Runtime startup snapshot schema_version must be ${RUNTIME_STARTUP_SNAPSHOT_VERSION}`)
  }
  if (typeof value.fmx_session !== "string" || !/^(?:default|[a-z][a-z0-9_-]{0,31})$/u.test(value.fmx_session)) {
    throw new Error("Runtime startup snapshot has an invalid fmx Session selector")
  }
  const agentDefaults = readAgentDefaults(value.agent_defaults)
  let runtimeExtension: RuntimeExtensionStartup | null = null
  if (value.runtime_extension !== null) {
    if (!isJsonObject(value.runtime_extension)) {
      throw new Error("Runtime startup snapshot runtime_extension must be an object or null")
    }
    assertExactFields(
      value.runtime_extension,
      ["association", "placement_id", "registration"],
      "runtime_extension",
    )
    const association = readRuntimeMessage(value.runtime_extension.association, "association")
    const registration = readRuntimeMessage(value.runtime_extension.registration, "registration")
    const placementId = value.runtime_extension.placement_id
    if (typeof placementId !== "string") {
      throw new Error("Runtime startup snapshot placement_id must be a string")
    }
    if (association.extension_id !== registration.extension_id) {
      throw new Error("Runtime startup snapshot association and registration extension ids differ")
    }
    if (association.members.length !== 2) {
      throw new Error("Runtime startup snapshot association must contain exactly two members")
    }
    const member = association.members.find((candidate) => candidate.placement_id === placementId)
    if (member === undefined || member.fmx_session !== value.fmx_session) {
      throw new Error("Runtime startup snapshot placement does not name its exact fmx Session")
    }
    const required = new Set(registration.required_capabilities)
    if (RUNTIME_EXTENSION_CAPABILITIES.some((capability) => !required.has(capability))) {
      throw new Error("Runtime startup snapshot registration lacks a required capability")
    }
    runtimeExtension = { association, registration, placementId }
  }
  return {
    schemaVersion: RUNTIME_STARTUP_SNAPSHOT_VERSION,
    fmxSession: value.fmx_session,
    agentDefaults,
    runtimeExtension,
  }
}

function readAgentDefaults(value: JsonValue | undefined): AgentDefaults {
  if (!isJsonObject(value)) throw new Error("Runtime startup snapshot agent_defaults must be an object")
  assertExactFields(value, ["state_dir", "model", "effort"], "agent_defaults", true)
  const defaults: AgentDefaults = {}
  for (const [wireName, property] of [
    ["state_dir", "stateDir"],
    ["model", "model"],
    ["effort", "effort"],
  ] as const) {
    const setting = value[wireName]
    if (setting === undefined) continue
    const maximumBytes = wireName === "state_dir" ? 4096 : wireName === "model" ? 160 : 64
    if (
      typeof setting !== "string" ||
      setting.length === 0 ||
      setting.trim() !== setting ||
      CONTROL_CHARACTERS.test(setting) ||
      Buffer.byteLength(setting) > maximumBytes
    ) {
      throw new Error(`Runtime startup snapshot ${wireName} is invalid`)
    }
    if (wireName === "state_dir" && (
      !isAbsolute(setting) ||
      normalize(setting) !== setting ||
      setting === "/"
    )) {
      throw new Error("Runtime startup snapshot state_dir must be an absolute normalized non-root path")
    }
    defaults[property] = setting
  }
  return defaults
}

function readRuntimeMessage(
  value: JsonValue | undefined,
  messageType: "association",
): RuntimeAssociationMessage
function readRuntimeMessage(
  value: JsonValue | undefined,
  messageType: "registration",
): RuntimeRegistrationMessage
function readRuntimeMessage(
  value: JsonValue | undefined,
  messageType: "association" | "registration",
): RuntimeAssociationMessage | RuntimeRegistrationMessage {
  const parsed = runtimeExtensionMessageSchema.safeParse(value)
  if (!parsed.success || parsed.data.message_type !== messageType) {
    throw new Error(`Runtime startup snapshot has an invalid ${messageType} envelope`)
  }
  return parsed.data as unknown as RuntimeAssociationMessage | RuntimeRegistrationMessage
}

function assertExactFields(
  value: Record<string, JsonValue>,
  expected: readonly string[],
  label: string,
  optional = false,
): void {
  const expectedSet = new Set(expected)
  const unknown = Object.keys(value).find((key) => !expectedSet.has(key))
  if (unknown !== undefined) throw new Error(`Runtime startup snapshot ${label} has unknown field ${unknown}`)
  if (optional) return
  const missing = expected.find((key) => !(key in value))
  if (missing !== undefined) throw new Error(`Runtime startup snapshot ${label} is missing field ${missing}`)
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
