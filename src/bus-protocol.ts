import type { AdeRecord } from "./ade-events.ts"
import {
  CONTROL_METHODS,
  errorReply,
  isControlErrorCode,
  isControlMethod,
  isRecord,
  successReply,
  type AgentInfo,
  type ControlError,
  type ControlReply,
  type ControlRequest,
} from "./control-protocol.ts"

/** The public, duplex fmx Runtime Bus contract. Independent of Fx's ADE schema. */
export const BUS_SCHEMA_VERSION = 1
export const BUS_SOCKET_ENV_VAR = "FMX_SOCKET_PATH"

export type BusTopic = "state" | "activity"
export type ActivityPayloadMode = "summary" | "raw"

export type BusSubscription = {
  schemaVersion: typeof BUS_SCHEMA_VERSION
  topics: BusTopic[]
  activityPayload: ActivityPayloadMode
}

export type BusSubscribeMessage = {
  schema_version: typeof BUS_SCHEMA_VERSION
  type: "subscribe"
  topics: BusTopic[]
  activity_payload: ActivityPayloadMode
}

export type BusRequestMessage = {
  schema_version: typeof BUS_SCHEMA_VERSION
  type: "request"
  id: string
  method: ControlRequest["method"]
  params: Record<string, unknown>
}

export type BusClientMessage = BusSubscribeMessage | BusRequestMessage

export type BusRuntime = {
  id: string
  home_id: string
  pid: number
  version: string
}

/** Runtime truth useful outside the TUI. Caller-relative and chrome state do not belong here. */
export type BusState = {
  active_agent_id: string | null
  agents: AgentInfo[]
}

export type BusActivity = {
  name: string
  ade_sequence: number
  gap_before: boolean
  agent_id: string
  display_id: number
  agent_role: "main" | "subagent"
  workspace_root: string | null
  session_id: string | null
  parent_session_id: string | null
  subagent_id: number | null
  turn_id: number | null
  agent_state: "idle" | "working" | "blocked"
  attention_kind: "permission" | "question" | "route_recovery" | null
  payload_mode: ActivityPayloadMode
  payload: Record<string, unknown>
}

type BusEventBase = {
  schema_version: typeof BUS_SCHEMA_VERSION
  type: "event"
  runtime: BusRuntime
  stream_sequence: number
  state_revision: number
}

export type BusStateMessage = BusEventBase & {
  event: "snapshot" | "state_changed"
  cause: string
  state: BusState
}

export type BusActivityMessage = BusEventBase & {
  event: "activity"
  activity: BusActivity
}

export type BusEventMessage = BusStateMessage | BusActivityMessage

type BusResponseBase = {
  schema_version: typeof BUS_SCHEMA_VERSION
  type: "response"
  runtime: BusRuntime
  state_revision: number
  id: string | null
}

export type BusResponseMessage =
  | (BusResponseBase & { ok: true; result: unknown })
  | (BusResponseBase & { ok: false; error: ControlError })

export type BusProtocolError = {
  code: "invalid_request" | "unsupported_schema_version" | "capacity"
  message: string
}

export type BusErrorMessage = {
  schema_version: typeof BUS_SCHEMA_VERSION
  type: "error"
  error: BusProtocolError
}

export type BusServerMessage = BusEventMessage | BusResponseMessage | BusErrorMessage

export type DecodedBusClientMessage =
  | { message: { type: "subscribe"; subscription: BusSubscription } }
  | { message: { type: "request"; request: ControlRequest } }
  | { reply: ControlReply }
  | { error: BusProtocolError }

export function encodeBusSubscription(subscription: BusSubscription): string {
  const message: BusSubscribeMessage = {
    schema_version: subscription.schemaVersion,
    type: "subscribe",
    topics: subscription.topics,
    activity_payload: subscription.activityPayload,
  }
  return `${JSON.stringify(message)}\n`
}

export function encodeBusRequest(request: ControlRequest): string {
  const message: BusRequestMessage = {
    schema_version: BUS_SCHEMA_VERSION,
    type: "request",
    id: request.id,
    method: request.method,
    params: request.params,
  }
  return `${JSON.stringify(message)}\n`
}

export function encodeBusServerMessage(message: BusServerMessage): string {
  return `${JSON.stringify(message)}\n`
}

export function decodeBusClientMessage(line: string): DecodedBusClientMessage {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { error: { code: "invalid_request", message: "expected one JSON object per line" } }
  }
  if (!isRecord(value)) {
    return { error: { code: "invalid_request", message: "expected a JSON object" } }
  }
  if (value.schema_version !== BUS_SCHEMA_VERSION) {
    return {
      error: {
        code: "unsupported_schema_version",
        message: `unsupported bus schema: ${String(value.schema_version)}`,
      },
    }
  }

  switch (value.type) {
    case "subscribe":
      return decodeSubscription(value)
    case "request":
      return decodeControlRequest(value)
    default:
      return { error: { code: "invalid_request", message: `unknown bus message type: ${String(value.type)}` } }
  }
}

function decodeSubscription(value: Record<string, unknown>): DecodedBusClientMessage {
  const rawTopics = value.topics ?? ["state"]
  if (!Array.isArray(rawTopics) || rawTopics.length === 0) {
    return { error: { code: "invalid_request", message: "topics must be a non-empty list" } }
  }
  const topics: BusTopic[] = []
  for (const topic of rawTopics) {
    if (topic !== "state" && topic !== "activity") {
      return { error: { code: "invalid_request", message: `unknown bus topic: ${String(topic)}` } }
    }
    if (!topics.includes(topic)) topics.push(topic)
  }

  const activityPayload = value.activity_payload ?? "summary"
  if (activityPayload !== "summary" && activityPayload !== "raw") {
    return { error: { code: "invalid_request", message: "activity_payload must be summary or raw" } }
  }
  return {
    message: {
      type: "subscribe",
      subscription: {
        schemaVersion: BUS_SCHEMA_VERSION,
        topics,
        activityPayload,
      },
    },
  }
}

function decodeControlRequest(value: Record<string, unknown>): DecodedBusClientMessage {
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
  return { message: { type: "request", request: { id, method, params } } }
}

/** Decode only the response/error lane; event messages return null. */
export function decodeBusResponse(line: string): ControlReply | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return errorReply(null, { code: "invalid_request", message: "fmx answered with something other than JSON" })
  }
  if (!isRecord(value)) {
    return errorReply(null, { code: "invalid_request", message: "fmx answered with an unexpected shape" })
  }
  if (value.schema_version !== BUS_SCHEMA_VERSION) {
    return errorReply(null, { code: "invalid_request", message: "fmx answered with an unsupported bus schema" })
  }
  if (value.type === "event") return null
  if (value.type === "error") {
    const error = isRecord(value.error) ? value.error : {}
    return errorReply(null, {
      code: "invalid_request",
      message: typeof error.message === "string" ? error.message : "fmx rejected the bus message",
    })
  }
  if (value.type !== "response" || typeof value.ok !== "boolean") {
    return errorReply(null, { code: "invalid_request", message: "fmx answered with an unexpected shape" })
  }
  const id = typeof value.id === "string" ? value.id : null
  if (value.ok) return successReply(id, value.result)
  const error = isRecord(value.error) ? value.error : {}
  return errorReply(id, {
    code: isControlErrorCode(error.code) ? error.code : "failed",
    message: typeof error.message === "string" ? error.message : "unknown error",
    ...(error.data === undefined ? {} : { data: error.data }),
  })
}

export function busResponse(
  reply: ControlReply,
  runtime: BusRuntime,
  stateRevision: number,
): BusResponseMessage {
  const base: BusResponseBase = {
    schema_version: BUS_SCHEMA_VERSION,
    type: "response",
    runtime,
    state_revision: stateRevision,
    id: reply.id,
  }
  return reply.ok ? { ...base, ok: true, result: reply.result } : { ...base, ok: false, error: reply.error }
}

export function busError(error: BusProtocolError): BusErrorMessage {
  return { schema_version: BUS_SCHEMA_VERSION, type: "error", error }
}

/** Attribute one accepted ADE record after Multiplexer has folded it. */
export function busActivity(
  record: AdeRecord,
  agentId: string,
  displayId: number,
  gapBefore: boolean,
  payloadMode: ActivityPayloadMode,
): BusActivity {
  return {
    name: record.event,
    ade_sequence: record.sequence,
    gap_before: gapBefore,
    agent_id: agentId,
    display_id: displayId,
    agent_role: record.context.agentRole,
    workspace_root: record.context.workspaceRoot,
    session_id: record.context.sessionId,
    parent_session_id: record.context.parentSessionId,
    subagent_id: record.context.subagentId,
    turn_id: record.context.turnId,
    agent_state: record.context.agentState,
    attention_kind: record.context.attentionKind,
    payload_mode: payloadMode,
    payload: payloadMode === "raw" ? record.payload : summarizeAdePayload(record),
  }
}

/**
 * The summary is deliberately allowlisted. ADE payloads may contain complete
 * tool arguments and assistant text; those cross the public boundary only
 * when a Bus peer explicitly requests raw payloads.
 */
export function summarizeAdePayload(record: AdeRecord): Record<string, unknown> {
  const payload = record.payload
  switch (record.event) {
    case "GitRootDiscovered":
      return pick(payload, ["git_root", "revision", "reason"])
    case "SessionChanged":
      return pick(payload, ["previous_session_id", "session_id"])
    case "SessionMetadataChanged":
      return pick(payload, ["title"])
    case "PreToolUse":
      return pick(payload, ["step_index", "call_id", "tool_name"])
    case "Stop":
      return pick(payload, ["step_index", "provider_disposition", "can_continue"])
    case "PostTurnEnd":
      return pick(payload, ["outcome", "provider_disposition"])
    case "AttentionRequired":
    case "AttentionResolved":
      return pick(payload, ["kind"])
    default:
      return {}
  }
}

/** One stable Runtime Bus path from an ADE, retired, or Bus path. */
export function busSocketPathFor(basePath: string): string {
  return `${basePath.replace(/(?:(?:\.ade)?\.sock|\.ctl|\.obs|\.bus)$/u, "")}.bus`
}

/** Crash residue from the two sockets the bus replaces, safe to clear only under the ADE singleton. */
export function retiredSocketPathsFor(basePath: string): string[] {
  const busPath = busSocketPathFor(basePath)
  const stem = busPath.slice(0, -".bus".length)
  return [`${stem}.ctl`, `${stem}.obs`]
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    const value = source[key]
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      picked[key] = value
    }
  }
  return picked
}
