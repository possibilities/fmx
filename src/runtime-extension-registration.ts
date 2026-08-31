import { readFile } from "node:fs/promises"
import { isAbsolute, join, normalize } from "node:path"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_CAPABILITIES,
  RUNTIME_EXTENSION_SCHEMA_ID,
  type RuntimeExtensionMessage,
} from "./agentworkplace-contracts.ts"

export const RUNTIME_EXTENSION_REGISTRATION_VERSION = 1
export const RUNTIME_EXTENSION_REGISTRATION_MAX_BYTES = 32 * 1024

const EXTENSION_ID = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/u
const CONTROL_DATA = /\p{C}/u

export type RuntimeExtensionRegistration = {
  schemaVersion: typeof RUNTIME_EXTENSION_REGISTRATION_VERSION
  extensionId: string
  argv: readonly string[]
  protocol: Readonly<{ minimum: number; maximum: number }>
  headlessLiveness: true
}

export class RuntimeExtensionRegistrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RuntimeExtensionRegistrationError"
  }
}

/** Exact registration path. Runtime extensions are never scanned or PATH-resolved. */
export function runtimeExtensionManifestPath(configDirectory: string, extensionId: string): string {
  assertExtensionId(extensionId)
  return join(configDirectory, "runtime-extensions", `${extensionId}.toml`)
}

export async function loadRuntimeExtensionRegistration(
  configDirectory: string,
  extensionId: string,
): Promise<RuntimeExtensionRegistration> {
  const path = runtimeExtensionManifestPath(configDirectory, extensionId)
  let content: Uint8Array
  try {
    content = await readFile(path)
  } catch (error) {
    throw new RuntimeExtensionRegistrationError(
      `cannot read Runtime-extension registration ${path}: ${errorMessage(error)}`,
      { cause: error },
    )
  }
  try {
    return parseRuntimeExtensionRegistration(content, extensionId)
  } catch (error) {
    if (error instanceof RuntimeExtensionRegistrationError) {
      throw new RuntimeExtensionRegistrationError(
        `invalid Runtime-extension registration ${path}: ${error.message}`,
        { cause: error },
      )
    }
    throw error
  }
}

export function parseRuntimeExtensionRegistration(
  input: Uint8Array | string,
  expectedExtensionId: string,
): RuntimeExtensionRegistration {
  assertExtensionId(expectedExtensionId)
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  if (bytes.byteLength > RUNTIME_EXTENSION_REGISTRATION_MAX_BYTES) {
    throw new RuntimeExtensionRegistrationError(
      `manifest exceeds ${RUNTIME_EXTENSION_REGISTRATION_MAX_BYTES} bytes`,
    )
  }
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new RuntimeExtensionRegistrationError("manifest is not valid UTF-8", { cause: error })
  }
  for (const character of source) {
    if (CONTROL_DATA.test(character) && character !== "\n" && character !== "\r" && character !== "\t") {
      throw new RuntimeExtensionRegistrationError("manifest contains forbidden control or format data")
    }
  }
  let document: unknown
  try {
    document = Bun.TOML.parse(source)
  } catch (error) {
    throw new RuntimeExtensionRegistrationError("manifest is not valid TOML", { cause: error })
  }
  if (!isRecord(document)) throw new RuntimeExtensionRegistrationError("manifest must be a table")
  assertExactFields(document, ["schema_version", "extension_id", "argv", "protocol", "capabilities"], "manifest")
  if (document.schema_version !== RUNTIME_EXTENSION_REGISTRATION_VERSION) {
    throw new RuntimeExtensionRegistrationError(
      `schema_version must be ${RUNTIME_EXTENSION_REGISTRATION_VERSION}`,
    )
  }
  if (document.extension_id !== expectedExtensionId) {
    throw new RuntimeExtensionRegistrationError(
      `extension_id must match ${JSON.stringify(expectedExtensionId)}`,
    )
  }
  if (
    !Array.isArray(document.argv) ||
    document.argv.length === 0 ||
    document.argv.length > 64 ||
    !document.argv.every((entry) => isVisibleArgvEntry(entry))
  ) {
    throw new RuntimeExtensionRegistrationError("argv must contain 1-64 bounded visible strings")
  }
  const executable = document.argv[0]!
  if (!isAbsolute(executable) || normalize(executable) !== executable || executable === "/") {
    throw new RuntimeExtensionRegistrationError("argv[0] must be an absolute normalized non-root path")
  }

  if (!isRecord(document.protocol)) throw new RuntimeExtensionRegistrationError("protocol must be a table")
  assertExactFields(document.protocol, ["minimum", "maximum"], "protocol")
  const minimum = protocolVersion(document.protocol.minimum, "protocol.minimum")
  const maximum = protocolVersion(document.protocol.maximum, "protocol.maximum")
  if (minimum > maximum) {
    throw new RuntimeExtensionRegistrationError("protocol minimum must not exceed maximum")
  }
  if (minimum > AGENTWORKPLACE_CONTRACT_VERSION || maximum < AGENTWORKPLACE_CONTRACT_VERSION) {
    throw new RuntimeExtensionRegistrationError(
      `protocol range ${minimum}-${maximum} does not include ${AGENTWORKPLACE_CONTRACT_VERSION}`,
    )
  }

  if (!isRecord(document.capabilities)) {
    throw new RuntimeExtensionRegistrationError("capabilities must be a table")
  }
  assertExactFields(document.capabilities, ["headless_liveness"], "capabilities")
  if (document.capabilities.headless_liveness !== true) {
    throw new RuntimeExtensionRegistrationError("capabilities.headless_liveness must be true")
  }

  return {
    schemaVersion: RUNTIME_EXTENSION_REGISTRATION_VERSION,
    extensionId: expectedExtensionId,
    argv: [...document.argv],
    protocol: { minimum, maximum },
    headlessLiveness: true,
  }
}

/** Canonical Phase 0 registration envelope derived from an accepted manifest. */
export function runtimeExtensionRegistrationMessage(
  registration: RuntimeExtensionRegistration,
): RuntimeExtensionMessage {
  return {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "registration",
    extension_id: registration.extensionId,
    argv: [...registration.argv],
    protocol: { ...registration.protocol },
    required_capabilities: [...RUNTIME_EXTENSION_CAPABILITIES],
  }
}

function assertExtensionId(value: string): void {
  if (!EXTENSION_ID.test(value)) {
    throw new RuntimeExtensionRegistrationError(`invalid extension id: ${JSON.stringify(value)}`)
  }
}

function isVisibleArgvEntry(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim() === value &&
    !/[\r\n]/u.test(value) &&
    !CONTROL_DATA.test(value)
}

function protocolVersion(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RuntimeExtensionRegistrationError(`${label} must be an integer from 1 through 65535`)
  }
  return value
}

function assertExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected)
  const unknown = Object.keys(value).find((key) => !expectedSet.has(key))
  if (unknown !== undefined) {
    throw new RuntimeExtensionRegistrationError(`${label} has unknown field ${unknown}`)
  }
  const missing = expected.find((key) => !(key in value))
  if (missing !== undefined) {
    throw new RuntimeExtensionRegistrationError(`${label} is missing field ${missing}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
