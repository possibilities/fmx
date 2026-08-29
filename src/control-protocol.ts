import type { AgentAttention, DisplayState } from "./agent-registry.ts"
import { isAgentId } from "./agent-manifest.ts"

/**
 * The typed Runtime surface behind fmx-mcp. Transport-independent: the Runtime
 * Bus owns framing and delivery while Multiplexer owns what every method means.
 */

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
  | "cancelled"
  | "shutting_down"

export type ControlError = {
  code: ControlErrorCode
  message: string
  data?: unknown
}

export type ControlReply =
  | { id: string | null; ok: true; result: unknown }
  | { id: string | null; ok: false; error: ControlError }

/** What the Runtime Bus drives. */
export type ControlSurface = {
  handle(method: ControlMethod, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

/** A successful result whose action must wait until its response is written
 * or the requesting connection has gone away. */
export class AfterControlReply {
  constructor(
    readonly result: unknown,
    readonly run: () => void,
  ) {}
}

export function afterControlReply(result: unknown, run: () => void): AfterControlReply {
  return new AfterControlReply(result, run)
}

export const CONTROL_METHODS = [
  "orient",
  "focus",
  "tray",
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

/** One Agent as MCP sees it: the Session list's model, not its drawing. */
export type AgentInfo = {
  /** Stable 128-bit Manifest identity; use this across Runtime restarts. */
  agent_id: string
  /** Human-facing number, retained as `id` for Target compatibility. */
  id: number
  display_id: number
  pane_id: string
  created_at: number
  cwd: string
  project: string
  git_root: string | null
  main_git_root: string | null
  /** null while git has not answered for the directory, and again whenever it
   * cannot: an Agent is started in a repository, so this is never a report
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

export type Surface =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "error"; heading: string; message: string }

export type Snapshot = {
  fmx: {
    pid: number
    version: string
    cwd: string
    cols: number
    rows: number
  }
  /** The caller's own agent, when called from inside one. */
  you: AgentInfo | null
  active: number | null
  agents: AgentInfo[]
  tray: { visible: boolean; hidden: boolean; width: number; rows: TrayRow[] }
  surface: Surface
}

/* ---------------------------------------------------------------- targets */

/**
 * How an MCP tool names an Agent. Stable Agent and Pane ids take precedence,
 * numbers are display ids, `current` is the caller's own, and relative words
 * use the Agent currently on screen. Other text is an exact Session name first
 * and a Session-id prefix second.
 */
export type Target =
  | { kind: "agent_id"; agentId: string }
  | { kind: "pane_id"; paneId: string }
  | { kind: "display_id"; displayId: number }
  | { kind: "current" }
  | { kind: "active" }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "name"; name: string }

export function parseTarget(raw: string): Target {
  const trimmed = raw.trim()
  if (validAgentId(trimmed)) return { kind: "agent_id", agentId: trimmed }
  if (trimmed.startsWith("p_") && validAgentId(trimmed.slice(2))) {
    return { kind: "pane_id", paneId: trimmed }
  }
  if (/^\d+$/u.test(trimmed)) return { kind: "display_id", displayId: Number(trimmed) }
  switch (trimmed) {
    case "current":
    case "active":
    case "next":
    case "previous":
      return { kind: trimmed }
  }
  if (trimmed === "") throw new ControlFailure("invalid_params", "target is empty")
  return { kind: "name", name: trimmed }
}

function validAgentId(value: string): boolean {
  return isAgentId(value)
}

/* --------------------------------------------------------------- responses */

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
  "cancelled",
  "shutting_down",
]

export function isControlErrorCode(value: unknown): value is ControlErrorCode {
  return typeof value === "string" && ERROR_CODES.includes(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
