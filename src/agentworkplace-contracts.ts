import { isAbsolute, normalize } from "node:path"
import * as z from "zod/v4"
import {
  ContractCodecError,
  decodeContractFrame,
  decodeStrictJson,
  encodeCanonicalJson,
  encodeContractFrame,
  type JsonValue,
} from "./contract-codec.ts"
import { NATIVE_SESSION_NAME_MAX_BYTES } from "./session-names.ts"

export const AGENTWORKPLACE_CONTRACT_VERSION = 1
export const RUNTIME_EXTENSION_SCHEMA_ID = "fmx.runtime-extension"
export const AGENT_DEFAULTS_SCHEMA_ID = "fmx.agent-defaults"
export const ENSURE_LIFECYCLE_SCHEMA_ID = "fmx.ensure-lifecycle"
export const FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID = "fx.launch-admission-final"

export const AGENTWORKPLACE_SCHEMA_IDS = [
  RUNTIME_EXTENSION_SCHEMA_ID,
  AGENT_DEFAULTS_SCHEMA_ID,
  ENSURE_LIFECYCLE_SCHEMA_ID,
  FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID,
] as const

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u
const EXTENSION_FIELD = /^[a-z][a-z0-9_.-]{0,63}$/u
const FMX_SESSION = /^(?:default|[a-z][a-z0-9_-]{0,31})$/u
const AGENT_ID = /^[0-9a-f]{32}$/u
const PANE_ID = /^p_[0-9a-f]{32}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const DECIMAL_ID = /^(?:0|[1-9]\d*)$/u
const POSITIVE_DECIMAL_ID = /^[1-9]\d*$/u
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const U64_MAX = 18_446_744_073_709_551_615n
const MAX_PROTOCOL_VERSION = 65_535

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

const extensionsSchema = z.record(z.string().regex(EXTENSION_FIELD), jsonValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 64) {
      context.addIssue({ code: "custom", message: "extensions exceeds 64 entries" })
    }
  })

function boundedText(label: string, maximumBytes: number): z.ZodString {
  return z.string().min(1).superRefine((value, context) => {
    if (value.trim().length === 0) {
      context.addIssue({ code: "custom", message: `${label} must not be blank` })
    }
    if (CONTROL_CHARACTERS.test(value)) {
      context.addIssue({ code: "custom", message: `${label} contains a control character` })
    }
    if (Buffer.byteLength(value) > maximumBytes) {
      context.addIssue({ code: "custom", message: `${label} exceeds ${maximumBytes} UTF-8 bytes` })
    }
  })
}

function decimalU64(label: string, positive: boolean = false) {
  return z.string().regex(positive ? POSITIVE_DECIMAL_ID : DECIMAL_ID).superRefine((value, context) => {
    if (BigInt(value) > U64_MAX) {
      context.addIssue({ code: "custom", message: `${label} exceeds unsigned 64-bit range` })
    }
  })
}

const safeTokenSchema = boundedText("identity", 128).regex(SAFE_TOKEN)
const requestIdSchema = safeTokenSchema
const fmxSessionSchema = z.string().regex(FMX_SESSION)
const agentIdSchema = z.string().regex(AGENT_ID)
const paneIdSchema = z.string().regex(PANE_ID)
const digestSchema = z.string().regex(SHA256)
const gitObjectIdSchema = z.string().regex(GIT_OBJECT_ID)
const revisionSchema = decimalU64("revision")
const turnIdSchema = decimalU64("Turn id", true)
const timestampSchema = z.string().regex(RFC3339).superRefine((value, context) => {
  const date = new Date(value)
  const withMilliseconds = value.includes(".") ? value : value.replace(/Z$/u, ".000Z")
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== withMilliseconds) {
    context.addIssue({ code: "custom", message: "timestamp must be a real canonical UTC instant" })
  }
})
const conversationNameSchema = boundedText("Fx Conversation name", NATIVE_SESSION_NAME_MAX_BYTES)
const conversationIdSchema = boundedText("Fx Conversation id", 256).regex(SAFE_TOKEN)
const modelSchema = boundedText("model", 160)
const effortSchema = boundedText("effort", 64)
const branchSchema = boundedText("Git branch", 256)

/** Reuse the frozen v1/Fx Conversation identity boundary in private adapters. */
export function isAgentWorkplaceConversationId(value: unknown): value is string {
  return conversationIdSchema.safeParse(value).success
}

const absolutePathSchema = boundedText("path", 4096).superRefine((value, context) => {
  if (!isAbsolute(value)) context.addIssue({ code: "custom", message: "path must be absolute" })
  if (normalize(value) !== value) context.addIssue({ code: "custom", message: "path must be normalized" })
  if (value === "/") context.addIssue({ code: "custom", message: "path must not be the filesystem root" })
})

const relativePathSchema = boundedText("relative path", 1024).superRefine((value, context) => {
  if (isAbsolute(value) || value === "." || normalize(value) !== value || value.startsWith("..")) {
    context.addIssue({ code: "custom", message: "relative path must stay beneath its recorded Worktree" })
  }
})

function envelope<T extends z.ZodRawShape>(schemaId: string, messageType: string, shape: T) {
  return z.strictObject({
    schema_id: z.literal(schemaId),
    schema_version: z.literal(AGENTWORKPLACE_CONTRACT_VERSION),
    message_type: z.literal(messageType),
    ...shape,
  })
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string | number,
  context: { addIssue(issue: { code: "custom"; message: string }): void },
  label: string,
): void {
  const seen = new Set<string | number>()
  for (const value of values) {
    const identity = key(value)
    if (seen.has(identity)) {
      context.addIssue({ code: "custom", message: `duplicate ${label}: ${String(identity)}` })
    }
    seen.add(identity)
  }
}

/* ------------------------------------------------------ Runtime extension */

export const RUNTIME_EXTENSION_CAPABILITIES = [
  "headless_liveness",
  "member_present_focus",
  "member_snapshot_pull",
  "unavailable_slot_recovery_action",
] as const

const knownCapabilitySchema = z.enum(RUNTIME_EXTENSION_CAPABILITIES)
const requiredCapabilitiesSchema = z.array(knownCapabilitySchema)
  .min(1)
  .max(RUNTIME_EXTENSION_CAPABILITIES.length)
  .superRefine((value, context) => uniqueBy(value, (entry) => entry, context, "required capability"))
const advertisedCapabilitiesSchema = z.array(safeTokenSchema).min(1).max(64)
  .superRefine((value, context) => uniqueBy(value, (entry) => entry, context, "advertised capability"))

const associationMemberSchema = z.strictObject({
  placement_id: safeTokenSchema,
  fmx_session: fmxSessionSchema,
})

const runtimeAssociationSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "association", {
  workplace_instance_id: safeTokenSchema,
  extension_id: safeTokenSchema,
  configuration_id: safeTokenSchema,
  members: z.array(associationMemberSchema).min(1).max(32).superRefine((value, context) => {
    uniqueBy(value, (entry) => entry.placement_id, context, "placement identity")
    uniqueBy(value, (entry) => entry.fmx_session, context, "member fmx Session")
  }),
})

const runtimeRegistrationSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "registration", {
  extension_id: safeTokenSchema,
  argv: z.array(boundedText("extension argv entry", 4096)).min(1).max(64)
    .superRefine((value, context) => {
      if (!isAbsolute(value[0]!)) {
        context.addIssue({ code: "custom", message: "extension argv[0] must be an absolute executable path" })
      }
      if (normalize(value[0]!) !== value[0]!) {
        context.addIssue({ code: "custom", message: "extension argv[0] must be normalized" })
      }
      if (value[0] === "/") {
        context.addIssue({ code: "custom", message: "extension argv[0] must not be the filesystem root" })
      }
    }),
  protocol: z.strictObject({
    minimum: z.number().int().min(1).max(MAX_PROTOCOL_VERSION),
    maximum: z.number().int().min(1).max(MAX_PROTOCOL_VERSION),
  }).superRefine((value, context) => {
    if (value.minimum > value.maximum) {
      context.addIssue({ code: "custom", message: "protocol minimum exceeds maximum" })
    }
  }),
  required_capabilities: requiredCapabilitiesSchema,
})

const runtimeInitializeSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "initialize", {
  request_id: requestIdSchema,
  workplace_instance_id: safeTokenSchema,
  extension_id: safeTokenSchema,
  configuration_id: safeTokenSchema,
  placement_id: safeTokenSchema,
  fmx_session: fmxSessionSchema,
  protocol_version: z.literal(AGENTWORKPLACE_CONTRACT_VERSION),
})

const runtimeReadySchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "ready", {
  request_id: requestIdSchema,
  workplace_instance_id: safeTokenSchema,
  extension_id: safeTokenSchema,
  configuration_id: safeTokenSchema,
  placement_id: safeTokenSchema,
  fmx_session: fmxSessionSchema,
  protocol_version: z.literal(AGENTWORKPLACE_CONTRACT_VERSION),
  capabilities: advertisedCapabilitiesSchema,
})

const snapshotInvalidatedSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "snapshot_invalidated", {
  fmx_session: fmxSessionSchema,
  revision: revisionSchema,
})

const snapshotGetSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "snapshot_get", {
  request_id: requestIdSchema,
  fmx_session: fmxSessionSchema,
  after_revision: revisionSchema.nullable(),
})

const correlationSchema = z.strictObject({
  ensure_id: safeTokenSchema,
  ensure_digest: digestSchema,
  launch_id: safeTokenSchema,
  launch_digest: digestSchema,
})

const snapshotAgentSchema = z.strictObject({
  agent_id: agentIdSchema,
  pane_id: paneIdSchema,
  display_id: z.number().int().positive().safe(),
  created_at_ms: z.number().int().nonnegative().safe(),
  lifecycle: z.enum(["creating", "running", "unreachable"]),
  state: z.enum(["unknown", "idle", "working", "blocked", "done"]),
  attention: z.enum(["permission", "question", "route_recovery"]).nullable(),
  directory: absolutePathSchema,
  worktree: z.boolean(),
  fx_conversation: z.strictObject({
    conversation_id: conversationIdSchema,
    name: conversationNameSchema.nullable(),
  }).nullable(),
  correlation: correlationSchema.nullable(),
  extensions: extensionsSchema.optional(),
}).superRefine((value, context) => {
  if ((value.state === "blocked") !== (value.attention !== null)) {
    context.addIssue({ code: "custom", message: "blocked state and attention must appear together" })
  }
})

const snapshotResultSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "snapshot_result", {
  request_id: requestIdSchema,
  fmx_session: fmxSessionSchema,
  revision: revisionSchema,
  selected_agent_id: agentIdSchema.nullable(),
  agents: z.array(snapshotAgentSchema).max(4096),
}).superRefine((value, context) => {
  uniqueBy(value.agents, (entry) => entry.agent_id, context, "Agent id")
  uniqueBy(value.agents, (entry) => entry.pane_id, context, "Pane id")
  uniqueBy(value.agents, (entry) => entry.display_id, context, "Agent display id")
  const conversations = value.agents.flatMap((entry) =>
    entry.fx_conversation === null ? [] : [entry.fx_conversation.conversation_id]
  )
  uniqueBy(conversations, (entry) => entry, context, "active Fx Conversation id")
  if (value.selected_agent_id !== null && !value.agents.some((entry) => entry.agent_id === value.selected_agent_id)) {
    context.addIssue({ code: "custom", message: "selected Agent must exist in the authoritative snapshot" })
  }
})

const presentSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "present", {
  request_id: requestIdSchema,
  fmx_session: fmxSessionSchema,
  agent_id: agentIdSchema,
  focus: z.boolean(),
})

const recoveryCardSchema = z.strictObject({
  slot_id: safeTokenSchema,
  card_revision: revisionSchema,
  title: boundedText("recovery-card title", 96),
  message: boundedText("recovery-card message", 1024),
  action: z.strictObject({
    action_id: safeTokenSchema,
    label: boundedText("recovery-card action label", 96),
  }),
})

const recoveryCardPublishSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "unavailable_slot_publish", {
  request_id: requestIdSchema,
  fmx_session: fmxSessionSchema,
  card: recoveryCardSchema,
})

const recoveryCardClearSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "unavailable_slot_clear", {
  request_id: requestIdSchema,
  fmx_session: fmxSessionSchema,
  slot_id: safeTokenSchema,
  card_revision: revisionSchema,
})

const recoveryCardActionSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "unavailable_slot_action", {
  request_id: requestIdSchema,
  fmx_session: fmxSessionSchema,
  slot_id: safeTokenSchema,
  card_revision: revisionSchema,
  action_id: safeTokenSchema,
})

const runtimeResponseSuccessSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "response", {
  request_id: requestIdSchema,
  operation: z.enum(["present", "unavailable_slot_publish", "unavailable_slot_clear", "unavailable_slot_action"]),
  ok: z.literal(true),
  status: z.literal("accepted"),
})

const runtimeResponseFailureSchema = envelope(RUNTIME_EXTENSION_SCHEMA_ID, "response", {
  request_id: requestIdSchema,
  operation: z.enum([
    "initialize",
    "snapshot_get",
    "present",
    "unavailable_slot_publish",
    "unavailable_slot_clear",
    "unavailable_slot_action",
  ]),
  ok: z.literal(false),
  error: z.strictObject({
    code: safeTokenSchema,
    message: boundedText("Runtime-extension error", 1024),
    details: extensionsSchema.optional(),
  }),
})

export const runtimeExtensionMessageSchema = z.union([
  runtimeAssociationSchema,
  runtimeRegistrationSchema,
  runtimeInitializeSchema,
  runtimeReadySchema,
  snapshotInvalidatedSchema,
  snapshotGetSchema,
  snapshotResultSchema,
  presentSchema,
  recoveryCardPublishSchema,
  recoveryCardClearSchema,
  recoveryCardActionSchema,
  runtimeResponseSuccessSchema,
  runtimeResponseFailureSchema,
])

/* --------------------------------------------------------- Agent defaults */

const launchFieldsShape = {
  state_dir: absolutePathSchema.optional(),
  model: modelSchema.optional(),
  effort: effortSchema.optional(),
}

const launchFieldsSchema = z.strictObject(launchFieldsShape)
const sessionDefaultsEntrySchema = z.strictObject({
  fmx_session: fmxSessionSchema,
  ...launchFieldsShape,
})

const agentDefaultsTableSchema = envelope(AGENT_DEFAULTS_SCHEMA_ID, "defaults_table", {
  entries: z.array(sessionDefaultsEntrySchema).max(128)
    .superRefine((value, context) => uniqueBy(value, (entry) => entry.fmx_session, context, "fmx Session selector")),
})

const fieldSourceSchema = z.enum(["explicit_launch", "session_default", "fx_default"])
const agentDefaultsResolutionSchema = envelope(AGENT_DEFAULTS_SCHEMA_ID, "resolution_case", {
  case_id: safeTokenSchema,
  fmx_session: fmxSessionSchema,
  matching_default: sessionDefaultsEntrySchema.nullable(),
  explicit_launch: launchFieldsSchema,
  resolved_launch: launchFieldsSchema,
  sources: z.strictObject({
    state_dir: fieldSourceSchema,
    model: fieldSourceSchema,
    effort: fieldSourceSchema,
  }),
}).superRefine((value, context) => {
  if (value.matching_default !== null && value.matching_default.fmx_session !== value.fmx_session) {
    context.addIssue({ code: "custom", message: "matching default must use the exact fmx Session selector" })
  }
  for (const field of ["state_dir", "model", "effort"] as const) {
    const expectedSource = value.explicit_launch[field] !== undefined
      ? "explicit_launch"
      : value.matching_default?.[field] !== undefined
        ? "session_default"
        : "fx_default"
    const expected = expectedSource === "explicit_launch"
      ? value.explicit_launch[field]
      : expectedSource === "session_default"
        ? value.matching_default?.[field]
        : undefined
    if (value.sources[field] !== expectedSource) {
      context.addIssue({ code: "custom", message: `${field} does not use explicit/default/Fx precedence` })
    }
    if (value.resolved_launch[field] !== expected) {
      context.addIssue({ code: "custom", message: `${field} does not match its declared precedence source` })
    }
  }
})

export const agentDefaultsMessageSchema = z.union([
  agentDefaultsTableSchema,
  agentDefaultsResolutionSchema,
])

/* --------------------------------------------------- Ensure/end/cleanup */

const lifecycleCorrelationShape = {
  workplace_instance_id: safeTokenSchema,
  fmx_session: fmxSessionSchema,
  ensure_id: safeTokenSchema,
  ensure_digest: digestSchema,
  launch_id: safeTokenSchema,
  launch_digest: digestSchema,
  worktree_id: safeTokenSchema,
  agent_id: agentIdSchema,
}

const activeLifecycleCorrelationShape = {
  ...lifecycleCorrelationShape,
  conversation_id: conversationIdSchema.nullable(),
}

const plannedWorktreeSchema = z.strictObject({
  repository: absolutePathSchema,
  base_commit: gitObjectIdSchema,
  branch: branchSchema,
  directory: absolutePathSchema,
}).superRefine((value, context) => {
  if (value.repository === value.directory) {
    context.addIssue({ code: "custom", message: "planned Worktree must not overwrite its repository" })
  }
})

const ensureRequestSchema = envelope(ENSURE_LIFECYCLE_SCHEMA_ID, "ensure_request", {
  request_id: requestIdSchema,
  ...lifecycleCorrelationShape,
  planned_worktree: plannedWorktreeSchema,
  fx_conversation: z.strictObject({
    name: conversationNameSchema,
    resume_conversation_id: conversationIdSchema.nullable(),
  }),
})

const worktreeEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("planned"), directory: absolutePathSchema }),
  z.strictObject({
    status: z.literal("created"),
    directory: absolutePathSchema,
    head_commit: gitObjectIdSchema,
  }),
])
const manifestEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("claimed"), agent_id: agentIdSchema }),
])
const companionEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    session_name: safeTokenSchema,
    pane_id: paneIdSchema,
  }),
  z.strictObject({
    status: z.literal("started"),
    session_name: safeTokenSchema,
    pane_id: paneIdSchema,
  }),
])
const fxEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("started"), conversation_id: conversationIdSchema }),
])

const ensureReceiptSchema = envelope(ENSURE_LIFECYCLE_SCHEMA_ID, "ensure_receipt", {
  request_id: requestIdSchema,
  receipt_id: safeTokenSchema,
  receipt_digest: digestSchema,
  ...lifecycleCorrelationShape,
  status: z.enum(["in_progress", "complete"]),
  effects: z.strictObject({
    worktree: worktreeEffectSchema,
    manifest: manifestEffectSchema,
    companion: companionEffectSchema,
    fx: fxEffectSchema,
  }),
}).superRefine((value, context) => {
  if (value.effects.manifest.status === "claimed" && value.effects.manifest.agent_id !== value.agent_id) {
    context.addIssue({ code: "custom", message: "Manifest effect does not match the correlated Agent" })
  }
  if (value.status === "complete" && (
    value.effects.worktree.status !== "created" ||
    value.effects.manifest.status !== "claimed" ||
    value.effects.companion.status !== "started" ||
    value.effects.fx.status !== "started"
  )) {
    context.addIssue({ code: "custom", message: "complete ensure receipt contains an incomplete effect" })
  }
})

const endRequestSchema = envelope(ENSURE_LIFECYCLE_SCHEMA_ID, "end_request", {
  request_id: requestIdSchema,
  end_id: safeTokenSchema,
  end_digest: digestSchema,
  ...activeLifecycleCorrelationShape,
  reason: z.enum(["retire", "cancelled_before_start", "stop"]),
}).superRefine((value, context) => {
  if (value.conversation_id === null && value.reason !== "cancelled_before_start") {
    context.addIssue({
      code: "custom",
      message: "only cancelled-before-start retirement may omit an Fx Conversation",
    })
  }
})

const endedProofSchema = z.strictObject({
  kind: z.literal("ended"),
  companion_session: safeTokenSchema,
  pane_id: paneIdSchema,
  exit_code: z.number().int().min(0).max(255),
  signal: z.number().int().min(0).max(255),
  reason: z.enum(["natural", "requested", "daemon_failure", "exec_failure"]),
  observed_at: timestampSchema,
}).superRefine((value, context) => {
  if (value.exit_code !== 0 && value.signal !== 0) {
    context.addIssue({ code: "custom", message: "end proof cannot carry both an exit code and a signal" })
  }
})

const neverStartedProofSchema = z.strictObject({
  kind: z.literal("never_started"),
  authority: z.literal("companion_reconciliation"),
  companion_session: safeTokenSchema,
  pane_id: paneIdSchema,
  admission_receipt_id: safeTokenSchema,
  admission_receipt_digest: digestSchema,
  cancellation_request_id: requestIdSchema,
  observed_at: timestampSchema,
})

const endReceiptSchema = envelope(ENSURE_LIFECYCLE_SCHEMA_ID, "end_receipt", {
  request_id: requestIdSchema,
  receipt_id: safeTokenSchema,
  receipt_digest: digestSchema,
  end_id: safeTokenSchema,
  end_digest: digestSchema,
  ...activeLifecycleCorrelationShape,
  proof: z.discriminatedUnion("kind", [endedProofSchema, neverStartedProofSchema]),
}).superRefine((value, context) => {
  if ((value.proof.kind === "never_started") !== (value.conversation_id === null)) {
    context.addIssue({
      code: "custom",
      message: "never-started proof and a missing Fx Conversation must appear together",
    })
  }
})

const cleanupOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("removed"), head_commit: gitObjectIdSchema }),
  z.strictObject({
    kind: z.literal("refused_dirty"),
    head_commit: gitObjectIdSchema,
    tracked_changes: z.boolean(),
    untracked_paths: z.array(relativePathSchema).max(4096)
      .superRefine((value, context) => uniqueBy(value, (entry) => entry, context, "untracked path")),
  }).superRefine((value, context) => {
    if (!value.tracked_changes && value.untracked_paths.length === 0) {
      context.addIssue({ code: "custom", message: "dirty refusal must identify tracked or untracked state" })
    }
  }),
  z.strictObject({ kind: z.literal("refused_mismatch"), message: boundedText("cleanup mismatch", 1024) }),
  z.strictObject({ kind: z.literal("not_applicable") }),
])

const cleanupRequestSchema = envelope(ENSURE_LIFECYCLE_SCHEMA_ID, "cleanup_request", {
  request_id: requestIdSchema,
  cleanup_id: safeTokenSchema,
  cleanup_digest: digestSchema,
  end_id: safeTokenSchema,
  end_digest: digestSchema,
  ...activeLifecycleCorrelationShape,
  worktree_directory: absolutePathSchema,
})

const cleanupReceiptSchema = envelope(ENSURE_LIFECYCLE_SCHEMA_ID, "cleanup_receipt", {
  request_id: requestIdSchema,
  receipt_id: safeTokenSchema,
  receipt_digest: digestSchema,
  cleanup_id: safeTokenSchema,
  cleanup_digest: digestSchema,
  end_id: safeTokenSchema,
  end_digest: digestSchema,
  ...activeLifecycleCorrelationShape,
  worktree_directory: absolutePathSchema,
  outcome: cleanupOutcomeSchema,
  observed_at: timestampSchema,
})

const lifecycleReceiptAcknowledgementSchema = envelope(
  ENSURE_LIFECYCLE_SCHEMA_ID,
  "receipt_acknowledgement",
  {
    acknowledgement_id: safeTokenSchema,
    receipt_kind: z.enum(["ensure", "end", "cleanup"]),
    receipt_id: safeTokenSchema,
    receipt_digest: digestSchema,
    ensure_id: safeTokenSchema,
  },
)

export const ensureLifecycleMessageSchema = z.union([
  ensureRequestSchema,
  ensureReceiptSchema,
  endRequestSchema,
  endReceiptSchema,
  cleanupRequestSchema,
  cleanupReceiptSchema,
  lifecycleReceiptAcknowledgementSchema,
])

/* ---------------------------- Fx/fxnk launch/admission/final owner boundary */

const fxLaunchCorrelationShape = {
  launch_id: safeTokenSchema,
  launch_digest: digestSchema,
  admission_key: safeTokenSchema,
}

const launchRequestSchema = envelope(FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID, "launch_request", {
  request_id: requestIdSchema,
  ...fxLaunchCorrelationShape,
  conversation_name: conversationNameSchema,
  resume: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("fresh") }),
    z.strictObject({ mode: z.literal("exact"), conversation_id: conversationIdSchema }),
  ]),
  state_root: absolutePathSchema,
  directory: absolutePathSchema,
  model: modelSchema.optional(),
  effort: effortSchema.optional(),
  initial_work_digest: digestSchema,
  remaining_launch_controls_digest: digestSchema,
})

const launchReceiptSchema = envelope(FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID, "launch_receipt", {
  request_id: requestIdSchema,
  receipt_id: safeTokenSchema,
  ...fxLaunchCorrelationShape,
  status: z.literal("accepted"),
})

const admissionCancelRequestSchema = envelope(
  FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID,
  "admission_cancel_request",
  {
    request_id: requestIdSchema,
    ...fxLaunchCorrelationShape,
  },
)

const admissionDecisionSchema = envelope(FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID, "admission_decision", {
  receipt_id: safeTokenSchema,
  receipt_digest: digestSchema,
  ...fxLaunchCorrelationShape,
  decision: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("admitted"),
      turn_id: turnIdSchema,
      disposition: z.enum(["queued", "steering"]),
    }),
    z.strictObject({
      kind: z.literal("cancelled_before_start"),
      cancellation_request_id: requestIdSchema,
    }),
  ]),
})

const finalReceiptSchema = envelope(FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID, "final_receipt", {
  receipt_id: safeTokenSchema,
  receipt_digest: digestSchema,
  ...fxLaunchCorrelationShape,
  conversation_id: conversationIdSchema,
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("exited"), code: z.number().int().min(0).max(255) }),
    z.strictObject({ kind: z.literal("signalled"), signal: z.number().int().min(1).max(255) }),
    z.strictObject({ kind: z.literal("exec_failed"), message: boundedText("Fx exec failure", 1024) }),
  ]),
  observed_at: timestampSchema,
  retained_until_acknowledged: z.literal(true),
})

const finalReceiptAcknowledgementSchema = envelope(
  FX_LAUNCH_ADMISSION_FINAL_SCHEMA_ID,
  "final_receipt_acknowledgement",
  {
    acknowledgement_id: safeTokenSchema,
    receipt_id: safeTokenSchema,
    receipt_digest: digestSchema,
    ...fxLaunchCorrelationShape,
    conversation_id: conversationIdSchema,
  },
)

export const fxLaunchAdmissionFinalMessageSchema = z.union([
  launchRequestSchema,
  launchReceiptSchema,
  admissionCancelRequestSchema,
  admissionDecisionSchema,
  finalReceiptSchema,
  finalReceiptAcknowledgementSchema,
])

export const agentWorkplaceMessageSchema = z.union([
  runtimeExtensionMessageSchema,
  agentDefaultsMessageSchema,
  ensureLifecycleMessageSchema,
  fxLaunchAdmissionFinalMessageSchema,
])

export type RuntimeExtensionMessage = z.infer<typeof runtimeExtensionMessageSchema>
export type AgentDefaultsMessage = z.infer<typeof agentDefaultsMessageSchema>
export type EnsureLifecycleMessage = z.infer<typeof ensureLifecycleMessageSchema>
export type FxLaunchAdmissionFinalMessage = z.infer<typeof fxLaunchAdmissionFinalMessageSchema>
export type AgentWorkplaceMessage = z.infer<typeof agentWorkplaceMessageSchema>

export function decodeAgentWorkplacePayload(payload: Uint8Array): AgentWorkplaceMessage {
  const value = decodeStrictJson(payload)
  const canonical = encodeCanonicalJson(value)
  if (!Buffer.from(canonical).equals(Buffer.from(payload))) {
    throw new ContractCodecError("invalid_message", "contract payload is not canonical JSON")
  }
  if (!isJsonObject(value)) {
    throw new ContractCodecError("invalid_message", "contract envelope must be a JSON object")
  }
  if (typeof value.schema_id !== "string") {
    throw new ContractCodecError("invalid_message", "contract envelope is missing schema_id")
  }
  if (!(AGENTWORKPLACE_SCHEMA_IDS as readonly string[]).includes(value.schema_id)) {
    throw new ContractCodecError("unsupported_schema", `unsupported contract schema: ${value.schema_id}`)
  }
  if (!("schema_version" in value)) {
    throw new ContractCodecError("invalid_message", "contract envelope is missing schema_version")
  }
  if (value.schema_version !== AGENTWORKPLACE_CONTRACT_VERSION) {
    throw new ContractCodecError(
      "unsupported_schema_version",
      `unsupported ${value.schema_id} schema version: ${String(value.schema_version)}`,
    )
  }

  const parsed = agentWorkplaceMessageSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new ContractCodecError("invalid_message", `${issue?.message ?? "invalid contract envelope"}${at}`)
  }
  return parsed.data
}

export function encodeAgentWorkplacePayload(message: AgentWorkplaceMessage): Uint8Array {
  const parsed = agentWorkplaceMessageSchema.safeParse(message)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new ContractCodecError("invalid_message", `${issue?.message ?? "invalid contract envelope"}${at}`)
  }
  return encodeCanonicalJson(parsed.data as JsonValue)
}

export function encodeAgentWorkplaceFrame(message: AgentWorkplaceMessage): Uint8Array {
  return encodeContractFrame(encodeAgentWorkplacePayload(message))
}

export function decodeAgentWorkplaceFrame(frame: Uint8Array): AgentWorkplaceMessage {
  return decodeAgentWorkplacePayload(decodeContractFrame(frame))
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
