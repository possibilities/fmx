import {
  CONTROL_METHODS,
  errorReply,
  isControlErrorCode,
  isControlMethod,
  isRecord,
  successReply,
  type ControlError,
  type ControlReply,
  type ControlRequest,
} from "./control-protocol.ts"

/** Version of the implementation-private MCP-to-Runtime request bridge. */
export const RUNTIME_BRIDGE_SCHEMA_VERSION = 1
export const RUNTIME_SOCKET_ENV_VAR = "FMX_SOCKET_PATH"
// Fx accepts an 8 MiB request frame. Keep enough room for a valid 1 MiB work
// string after JSON escaping expands control characters to `\uXXXX`.
export const RUNTIME_BRIDGE_MAX_REQUEST_CHARS = 8 * 1024 * 1024
export const RUNTIME_BRIDGE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export type RuntimeBridgeRequestMessage = {
  schema_version: typeof RUNTIME_BRIDGE_SCHEMA_VERSION
  type: "request"
  id: string
  method: ControlRequest["method"]
  params: Record<string, unknown>
}

export type RuntimeBridgeResponseMessage = {
  schema_version: typeof RUNTIME_BRIDGE_SCHEMA_VERSION
  type: "response"
  id: string | null
} & (
  | { ok: true; result: unknown }
  | { ok: false; error: ControlError }
)

export type RuntimeBridgeProtocolError = {
  code: "invalid_request" | "unsupported_schema_version"
  message: string
}

export type RuntimeBridgeErrorMessage = {
  schema_version: typeof RUNTIME_BRIDGE_SCHEMA_VERSION
  type: "error"
  error: RuntimeBridgeProtocolError
}

export type RuntimeBridgeServerMessage = RuntimeBridgeResponseMessage | RuntimeBridgeErrorMessage

export type DecodedRuntimeBridgeClientMessage =
  | { request: ControlRequest }
  | { reply: ControlReply }
  | { error: RuntimeBridgeProtocolError }

export function encodeRuntimeBridgeRequest(request: ControlRequest): string {
  const message: RuntimeBridgeRequestMessage = {
    schema_version: RUNTIME_BRIDGE_SCHEMA_VERSION,
    type: "request",
    id: request.id,
    method: request.method,
    params: request.params,
  }
  return `${JSON.stringify(message)}\n`
}

export function encodeRuntimeBridgeServerMessage(message: RuntimeBridgeServerMessage): string {
  return `${JSON.stringify(message)}\n`
}

export function decodeRuntimeBridgeClientMessage(line: string): DecodedRuntimeBridgeClientMessage {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { error: { code: "invalid_request", message: "expected one JSON object per line" } }
  }
  if (!isRecord(value)) {
    return { error: { code: "invalid_request", message: "expected a JSON object" } }
  }
  if (value.schema_version !== RUNTIME_BRIDGE_SCHEMA_VERSION) {
    return {
      error: {
        code: "unsupported_schema_version",
        message: `unsupported Runtime bridge schema: ${String(value.schema_version)}`,
      },
    }
  }
  if (value.type !== "request") {
    return { error: { code: "invalid_request", message: `unknown message type: ${String(value.type)}` } }
  }

  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : null
  if (id === null) {
    return { error: { code: "invalid_request", message: "request id must be a non-empty string" } }
  }
  const method = value.method
  if (typeof method !== "string" || !isControlMethod(method)) {
    return {
      reply: errorReply(id, {
        code: "unknown_method",
        message: `unknown method: ${String(method)}`,
        data: { methods: CONTROL_METHODS },
      }),
    }
  }
  const params = value.params === undefined ? {} : value.params
  if (!isRecord(params)) {
    return { reply: errorReply(id, { code: "invalid_params", message: "params must be an object" }) }
  }
  return { request: { id, method, params } }
}

export function decodeRuntimeBridgeResponse(line: string): ControlReply {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return errorReply(null, { code: "invalid_request", message: "fmx answered with something other than JSON" })
  }
  if (!isRecord(value) || value.schema_version !== RUNTIME_BRIDGE_SCHEMA_VERSION) {
    return errorReply(null, { code: "invalid_request", message: "fmx answered with an unexpected bridge message" })
  }
  if (value.type === "error") {
    const error = isRecord(value.error) ? value.error : {}
    return errorReply(null, {
      code: "invalid_request",
      message: typeof error.message === "string" ? error.message : "fmx rejected the bridge request",
    })
  }
  if (value.type !== "response" || typeof value.ok !== "boolean") {
    return errorReply(null, { code: "invalid_request", message: "fmx answered with an unexpected bridge message" })
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    return errorReply(null, { code: "invalid_request", message: "fmx answered without a correlation id" })
  }
  const id = value.id
  if (value.ok) return successReply(id, value.result)
  const error = isRecord(value.error) ? value.error : {}
  return errorReply(id, {
    code: isControlErrorCode(error.code) ? error.code : "failed",
    message: typeof error.message === "string" ? error.message : "unknown error",
    ...(error.data === undefined ? {} : { data: error.data }),
  })
}

export function runtimeBridgeResponse(reply: ControlReply): RuntimeBridgeResponseMessage {
  const base = {
    schema_version: 1 as const,
    type: "response" as const,
    id: reply.id,
  }
  return reply.ok ? { ...base, ok: true, result: reply.result } : { ...base, ok: false, error: reply.error }
}

export function runtimeBridgeError(error: RuntimeBridgeProtocolError): RuntimeBridgeErrorMessage {
  return { schema_version: RUNTIME_BRIDGE_SCHEMA_VERSION, type: "error", error }
}

/** One stable Runtime bridge path from an ADE, retired, or current path. */
export function runtimeSocketPathFor(basePath: string): string {
  return `${basePath.replace(/(?:(?:\.ade)?\.sock|\.ctl|\.obs|\.bus)$/u, "")}.bus`
}

/** Crash residue from the two sockets this bridge replaced. */
export function retiredRuntimeSocketPathsFor(basePath: string): string[] {
  const runtimePath = runtimeSocketPathFor(basePath)
  const stem = runtimePath.slice(0, -".bus".length)
  return [`${stem}.ctl`, `${stem}.obs`]
}
