import type { AgentAttention, DisplayState } from "./agent-registry.ts"

/**
 * The control socket's wire: what `fmx control <command>` sends and what the running
 * fmx answers. Pure — no I/O, no renderer, no process state — so the client
 * and the server encode and decode through the same functions.
 *
 * One request per connection, newline-delimited JSON both ways. A request is
 * `{id, method, params}`; the reply is `{id, ok: true, result}` or
 * `{id, ok: false, error: {code, message, data?}}`. A method that waits for
 * something holds its connection until it resolves, so the client's own
 * timeout, not the server's, decides how long an agent is willing to block.
 */

export const CONTROL_SOCKET_ENV_VAR = "FMX_SOCKET_PATH"

export type ControlRequest = {
  id: string
  method: ControlMethod
  params: Record<string, unknown>
}

export type ControlErrorCode =
  | "invalid_request"
  | "unknown_method"
  | "invalid_params"
  | "not_found"
  | "ambiguous"
  | "busy"
  | "failed"
  | "timeout"
  | "shutting_down"

export type ControlError = {
  code: ControlErrorCode
  message: string
  data?: unknown
}

export type ControlReply =
  | { id: string | null; ok: true; result: unknown }
  | { id: string | null; ok: false; error: ControlError }

export const CONTROL_METHODS = [
  "orient",
  "agent.list",
  "agent.wait",
  "agent.send",
  "launch",
  "focus",
  "draft.open",
  "draft.show",
  "draft.set",
  "draft.submit",
  "draft.cancel",
  "draft.wait",
  "tray",
  "panel",
  "keys",
  "catalog",
] as const

export type ControlMethod = (typeof CONTROL_METHODS)[number]

/** An error a handler raises on purpose, carrying a code the client maps to
 * an exit status. Anything else thrown is reported as `failed`. */
export class ControlFailure extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = "ControlFailure"
  }
}

/* ---------------------------------------------------------------- results */

/** One agent as the CLI sees it: the tray's model, not its drawing. */
export type AgentInfo = {
  id: number
  pane_id: string
  cwd: string
  project: string
  /** null while git has not answered for the directory, and again whenever it
   * cannot: an agent is launched into a repository, so this is never a report
   * that the directory was untracked. */
  branch: string | null
  /** Whether the directory is a linked worktree rather than the main checkout. */
  worktree: boolean | null
  name: string | null
  session_id: string | null
  label: string
  state: DisplayState
  attention: AgentAttention | null
  active: boolean
  /** A prompt has been typed in — by launch or by `agent send` — and fx
   * has not yet reported working on it. `agent wait` holds through it. */
  awaiting_work: boolean
  /** The fx subagents whose control records name this agent's session as
   * their parent, nested as the tray nests them. Not targets: the tray
   * cannot select one either. */
  subagents: SubagentInfo[]
}

export type SubagentInfo = {
  session_id: string
  label: string
  state: DisplayState
  attention: AgentAttention | null
  children: SubagentInfo[]
}

export type TrayRow = {
  kind: "project" | "branch" | "agent" | "subagent"
  depth: number
  text: string
  agent: number | null
  active: boolean
}

export type LaunchFields = {
  prompt: string
  directory: string
  worktree: boolean
  /** null while the check for a commit to branch from is still running. */
  worktree_available: boolean | null
  model: string
  effort: string
}

export type DraftStatus = "open" | "submitted" | "cancelled" | "failed"

/** What the model and effort pickers offer: every model, and the efforts of
 * the one selected, so an agent amending a draft sees what the rows show. */
export type LaunchChoices = {
  models: string[]
  efforts: string[]
}

export type DraftInfo = {
  draft: string
  kind: "launch"
  status: DraftStatus
  opened_by: "keys" | "agent"
  fields: LaunchFields
  /** Added when the draft is read; what the model and effort rows offer. */
  choices?: LaunchChoices
  /** The agent a submitted draft started, or why a failed one did not. */
  outcome: { agent: number } | { error: string } | null
}

export type Surface =
  | { kind: "none" }
  | { kind: "launch"; draft: DraftInfo }
  | { kind: "help" }
  | { kind: "error"; heading: string; message: string }

export type Snapshot = {
  fmx: {
    pid: number
    version: string
    cwd: string
    socket: string
    cols: number
    rows: number
  }
  /** The caller's own agent, when called from inside one. */
  you: AgentInfo | null
  active: number | null
  agents: AgentInfo[]
  tray: { visible: boolean; hidden: boolean; width: number; rows: TrayRow[] }
  panel: PanelInfo
  surface: Surface
}

export type PanelInfo = {
  available: boolean
  visible: boolean
  hidden: boolean
  width: number
  selected: string | null
  focused: "agent" | "panel"
  tabs: { id: string; label: string; persistent: boolean }[]
}

/** The model catalog the launch dialog offers, in picker order. */
export type CatalogInfo = {
  default: { model: string; effort: string }
  models: { id: string; efforts: string[]; default_effort: string }[]
}

export type KeysInfo = {
  prefix: string
  /** Client-local actions deliberately have no agent-callable command. */
  bindings: Record<string, { keys: string[]; command: string | null }>
}

/* ---------------------------------------------------------------- targets */

/**
 * How a command names an agent. Numbers are agent ids; `current` is the
 * caller's own; `next` and `previous` are relative to the active one; a bare
 * word is an exact session name first and a session-id prefix second.
 */
export type Target =
  | { kind: "id"; id: number }
  | { kind: "current" }
  | { kind: "active" }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "name"; name: string }

export function parseTarget(raw: string): Target {
  const trimmed = raw.trim()
  if (/^\d+$/u.test(trimmed)) return { kind: "id", id: Number(trimmed) }
  const paneId = /^p_(\d+)$/u.exec(trimmed)
  if (paneId) return { kind: "id", id: Number(paneId[1]) }
  switch (trimmed) {
    case "current":
    case "active":
    case "next":
    case "previous":
      return { kind: trimmed }
  }
  if (trimmed === "prev") return { kind: "previous" }
  if (trimmed === "") throw new ControlFailure("invalid_params", "target is empty")
  return { kind: "name", name: trimmed }
}

/* ------------------------------------------------------------------ codec */

export function encodeRequest(request: ControlRequest): string {
  return `${JSON.stringify(request)}\n`
}

export function encodeReply(reply: ControlReply): string {
  return `${JSON.stringify(reply)}\n`
}

export function successReply(id: string | null, result: unknown): ControlReply {
  return { id, ok: true, result }
}

export function errorReply(id: string | null, error: ControlError): ControlReply {
  return { id, ok: false, error }
}

export function failureFrom(error: unknown): ControlError {
  if (error instanceof ControlFailure) {
    return error.data === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, data: error.data }
  }
  return { code: "failed", message: error instanceof Error ? error.message : String(error) }
}

/** Decodes one request line; a malformed line is reported as an error reply
 * the server can send back verbatim. */
export function decodeRequest(line: string): { request: ControlRequest } | { reply: ControlReply } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { reply: errorReply(null, { code: "invalid_request", message: "expected one JSON object per line" }) }
  }
  if (!isRecord(parsed)) {
    return { reply: errorReply(null, { code: "invalid_request", message: "expected a JSON object" }) }
  }
  const id = typeof parsed.id === "string" ? parsed.id : null
  const method = parsed.method
  if (typeof method !== "string" || !isControlMethod(method)) {
    return {
      reply: errorReply(id, {
        code: "unknown_method",
        message: `unknown method: ${String(method)}`,
        data: { methods: CONTROL_METHODS },
      }),
    }
  }
  const params = parsed.params === undefined ? {} : parsed.params
  if (!isRecord(params)) {
    return { reply: errorReply(id, { code: "invalid_params", message: "params must be an object" }) }
  }
  return { request: { id: id ?? "", method, params } }
}

export function decodeReply(line: string): ControlReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return errorReply(null, { code: "invalid_request", message: "fmx answered with something other than JSON" })
  }
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
    return errorReply(null, { code: "invalid_request", message: "fmx answered with an unexpected shape" })
  }
  const id = typeof parsed.id === "string" ? parsed.id : null
  if (parsed.ok) return successReply(id, parsed.result)
  const error = isRecord(parsed.error) ? parsed.error : {}
  return errorReply(id, {
    code: isErrorCode(error.code) ? error.code : "failed",
    message: typeof error.message === "string" ? error.message : "unknown error",
    ...(error.data === undefined ? {} : { data: error.data }),
  })
}

/* ------------------------------------------------------- param accessors */

export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new ControlFailure("invalid_params", `${key} must be a string`)
  return value
}

export function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key)
  if (value === undefined) throw new ControlFailure("invalid_params", `${key} is required`)
  return value
}

export function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new ControlFailure("invalid_params", `${key} must be a boolean`)
  return value
}

export function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ControlFailure("invalid_params", `${key} must be an integer`)
  }
  return value
}

export function optionalStringList(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ControlFailure("invalid_params", `${key} must be a list of strings`)
  }
  return value
}

export function isControlMethod(value: string): value is ControlMethod {
  return (CONTROL_METHODS as readonly string[]).includes(value)
}

const ERROR_CODES: readonly string[] = [
  "invalid_request",
  "unknown_method",
  "invalid_params",
  "not_found",
  "ambiguous",
  "busy",
  "failed",
  "timeout",
  "shutting_down",
]

function isErrorCode(value: unknown): value is ControlErrorCode {
  return typeof value === "string" && ERROR_CODES.includes(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
