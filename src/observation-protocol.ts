import type { AdeRecord } from "./ade-events.ts"
import type { AgentInfo } from "./control-protocol.ts"

/** The public, outbound fmx observation contract. Independent of Fx's ADE schema. */
export const OBSERVATION_SCHEMA_VERSION = 1

export type ObservationTopic = "state" | "activity"
export type ActivityPayloadMode = "summary" | "raw"

export type ObservationSubscription = {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION
  topics: ObservationTopic[]
  activityPayload: ActivityPayloadMode
}

export type ObservationRuntime = {
  id: string
  home_id: string
  pid: number
  version: string
}

/** Runtime truth useful outside the TUI. Caller-relative and chrome state do not belong here. */
export type ObservationState = {
  active_agent_id: string | null
  agents: AgentInfo[]
}

export type ObservationActivity = {
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

export type ObservationStateMessage = {
  schema_version: typeof OBSERVATION_SCHEMA_VERSION
  runtime: ObservationRuntime
  stream_sequence: number
  state_revision: number
  event: "snapshot" | "state_changed"
  cause: string
  state: ObservationState
}

export type ObservationActivityMessage = {
  schema_version: typeof OBSERVATION_SCHEMA_VERSION
  runtime: ObservationRuntime
  stream_sequence: number
  state_revision: number
  event: "activity"
  activity: ObservationActivity
}

export type ObservationMessage = ObservationStateMessage | ObservationActivityMessage

export type ObservationProtocolError = {
  code: "invalid_request" | "unsupported_schema_version"
  message: string
}

export type ObservationErrorMessage = {
  schema_version: typeof OBSERVATION_SCHEMA_VERSION
  event: "error"
  error: ObservationProtocolError
}

export function encodeObservationSubscription(subscription: ObservationSubscription): string {
  return `${JSON.stringify({
    schema_version: subscription.schemaVersion,
    topics: subscription.topics,
    activity_payload: subscription.activityPayload,
  })}\n`
}

export function decodeObservationSubscription(
  line: string,
): { subscription: ObservationSubscription } | { error: ObservationProtocolError } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { error: { code: "invalid_request", message: "expected one JSON subscription object" } }
  }
  if (!isRecord(value)) {
    return { error: { code: "invalid_request", message: "expected one JSON subscription object" } }
  }
  if (value.schema_version !== OBSERVATION_SCHEMA_VERSION) {
    return {
      error: {
        code: "unsupported_schema_version",
        message: `unsupported observation schema: ${String(value.schema_version)}`,
      },
    }
  }

  const rawTopics = value.topics ?? ["state"]
  if (!Array.isArray(rawTopics) || rawTopics.length === 0) {
    return { error: { code: "invalid_request", message: "topics must be a non-empty list" } }
  }
  const topics: ObservationTopic[] = []
  for (const topic of rawTopics) {
    if (topic !== "state" && topic !== "activity") {
      return { error: { code: "invalid_request", message: `unknown observation topic: ${String(topic)}` } }
    }
    if (!topics.includes(topic)) topics.push(topic)
  }

  const activityPayload = value.activity_payload ?? "summary"
  if (activityPayload !== "summary" && activityPayload !== "raw") {
    return {
      error: {
        code: "invalid_request",
        message: "activity_payload must be summary or raw",
      },
    }
  }
  return {
    subscription: {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      topics,
      activityPayload,
    },
  }
}

export function encodeObservationMessage(message: ObservationMessage | ObservationErrorMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** Attribute one accepted ADE observation after Multiplexer has folded it. */
export function observationActivity(
  record: AdeRecord,
  agentId: string,
  displayId: number,
  gapBefore: boolean,
  payloadMode: ActivityPayloadMode,
): ObservationActivity {
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
 * when an Observer explicitly requests raw payloads.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
