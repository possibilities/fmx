import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Command, LaunchFieldArgs, TextSource } from "./cli.ts"
import {
  CONTROL_SOCKET_ENV_VAR,
  type ControlError,
  type ControlMethod,
  type ControlReply,
  decodeReply,
  encodeRequest,
} from "./control-protocol.ts"
import { LineAssembler } from "./socket-frames.ts"

/**
 * The client side of the control socket: `fmx control <command>` resolved to one or
 * two requests, sent to the fmx the caller is running inside, and answered
 * as one JSON object on stdout.
 *
 * Exit status is the agent's first reading of what happened, so it is fixed:
 * 0 ok · 1 refused · 2 usage · 3 no fmx reachable · 4 timed out.
 */

export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_USAGE = 2
export const EXIT_UNREACHABLE = 3
export const EXIT_TIMEOUT = 4

/** How long an ordinary command waits for its answer. Waiting commands add
 * their own timeout on top, or wait forever when none was given. */
const REPLY_TIMEOUT_MS = 5_000
/** Slack past a wait's own timeout, so the server's `timeout` reply arrives
 * before the client gives up on its own. */
const WAIT_TIMEOUT_SLACK_MS = 1_000

export type ClientOutcome = {
  exitCode: number
  /** Printed to stdout as JSON when the command succeeded. */
  result?: unknown
  /** Printed to stderr as JSON otherwise. */
  error?: ControlError
}

export type ClientEnvironment = {
  env: NodeJS.ProcessEnv
  cwd: string
  readStdin: () => Promise<string>
  /** Where live control sockets are looked for when nothing names one. */
  socketDirectory?: string
  isProcessAlive?: (pid: number) => boolean
}

export class UnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnreachableError"
  }
}

export async function runCommand(
  command: Command,
  explicitSocket: string | null,
  environment: ClientEnvironment,
): Promise<ClientOutcome> {
  let socketPath: string
  try {
    socketPath = resolveSocketPath(explicitSocket, environment)
  } catch (error) {
    return {
      exitCode: EXIT_UNREACHABLE,
      error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
    }
  }

  const caller = callerInstance(environment.env)
  const plan = await planRequests(command, environment, caller)
  let result: unknown = null
  for (const step of plan) {
    const params = typeof step.params === "function" ? step.params(result) : step.params
    const reply = await exchange(socketPath, step.method, params, step.timeoutMs)
    if (!reply.ok) return { exitCode: exitCodeFor(reply.error), error: reply.error }
    result = reply.result
  }
  return { exitCode: EXIT_OK, result }
}

type Step = {
  method: ControlMethod
  /** A function reads the previous step's result, for a step that needs it. */
  params: Record<string, unknown> | ((previous: unknown) => Record<string, unknown>)
  /** null waits as long as the server does. */
  timeoutMs: number | null
}

async function planRequests(command: Command, environment: ClientEnvironment, caller: number | null): Promise<Step[]> {
  const withCaller = (params: Record<string, unknown>): Record<string, unknown> =>
    caller === null ? params : { ...params, caller }
  switch (command.name) {
    case "orient":
      return [{ method: "orient", params: withCaller({}), timeoutMs: REPLY_TIMEOUT_MS }]
    case "instance":
      switch (command.verb) {
        case "list":
          return [{ method: "instance.list", params: {}, timeoutMs: REPLY_TIMEOUT_MS }]
        case "wait":
          return [
            {
              method: "instance.wait",
              params: withCaller({
                target: command.target,
                ...(command.states ? { states: command.states } : {}),
                ...(command.timeoutMs === undefined ? {} : { timeout_ms: command.timeoutMs }),
              }),
              timeoutMs: waitTimeout(command.timeoutMs),
            },
          ]
        case "send":
          return [
            {
              method: "instance.send",
              params: withCaller({ target: command.target, text: await readText(command.text, environment) }),
              timeoutMs: REPLY_TIMEOUT_MS,
            },
          ]
      }
    case "launch": {
      const fields = await launchFieldParams(command.fields, environment)
      if (!command.editable) {
        return [
          {
            method: "launch",
            params: withCaller({
              ...fields,
              focus: command.focus,
              ...(command.fxArgs.length > 0 ? { fx_args: command.fxArgs } : {}),
            }),
            // Cutting a worktree and spawning fx both happen before the answer.
            timeoutMs: 30_000,
          },
        ]
      }
      const steps: Step[] = [
        { method: "draft.open", params: withCaller({ kind: "launch", fields }), timeoutMs: REPLY_TIMEOUT_MS },
      ]
      if (command.wait) {
        // The wait names the draft the open step answered with.
        steps.push({
          method: "draft.wait",
          params: (previous) => ({
            ...(isRecord(previous) && typeof previous.draft === "string" ? { draft: previous.draft } : {}),
            ...(command.timeoutMs === undefined ? {} : { timeout_ms: command.timeoutMs }),
          }),
          timeoutMs: waitTimeout(command.timeoutMs),
        })
      }
      return steps
    }
    case "draft":
      switch (command.verb) {
        case "show":
          return [
            {
              method: "draft.show",
              params: command.draft === undefined ? {} : { draft: command.draft },
              timeoutMs: REPLY_TIMEOUT_MS,
            },
          ]
        case "set":
          return [
            {
              method: "draft.set",
              params: { draft: command.draft, fields: await launchFieldParams(command.fields, environment) },
              timeoutMs: REPLY_TIMEOUT_MS,
            },
          ]
        case "submit":
          return [{ method: "draft.submit", params: { draft: command.draft }, timeoutMs: 30_000 }]
        case "cancel":
          return [{ method: "draft.cancel", params: { draft: command.draft }, timeoutMs: REPLY_TIMEOUT_MS }]
        case "wait":
          return [
            {
              method: "draft.wait",
              params: {
                ...(command.draft === undefined ? {} : { draft: command.draft }),
                ...(command.timeoutMs === undefined ? {} : { timeout_ms: command.timeoutMs }),
              },
              timeoutMs: waitTimeout(command.timeoutMs),
            },
          ]
      }
    case "focus":
      return [{ method: "focus", params: withCaller({ target: command.target }), timeoutMs: REPLY_TIMEOUT_MS }]
    case "sidebar":
      return [
        {
          method: "sidebar",
          params: command.width === undefined ? {} : { width: command.width },
          timeoutMs: REPLY_TIMEOUT_MS,
        },
      ]
    case "keys":
      return [{ method: "keys", params: { show: command.show }, timeoutMs: REPLY_TIMEOUT_MS }]
  }
}

async function launchFieldParams(
  fields: LaunchFieldArgs,
  environment: ClientEnvironment,
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {}
  if (fields.directory !== undefined) {
    params.directory = isAbsolute(fields.directory) ? fields.directory : resolve(environment.cwd, fields.directory)
  }
  if (fields.worktree !== undefined) params.worktree = fields.worktree
  if (fields.prompt !== undefined) params.prompt = await readText(fields.prompt, environment)
  return params
}

async function readText(source: TextSource, environment: ClientEnvironment): Promise<string> {
  if ("inline" in source) return source.inline
  if ("stdin" in source) return await environment.readStdin()
  const path = isAbsolute(source.file) ? source.file : resolve(environment.cwd, source.file)
  return await readFile(path, "utf8")
}

function waitTimeout(requested: number | undefined): number | null {
  return requested === undefined ? null : requested + WAIT_TIMEOUT_SLACK_MS
}

function callerInstance(env: NodeJS.ProcessEnv): number | null {
  const raw = env.FMX_INSTANCE_ID
  if (raw === undefined || !/^\d+$/u.test(raw)) return null
  return Number(raw)
}

/**
 * Which fmx to talk to: the one named, the one the caller runs inside, or —
 * for a human testing from outside — the only one alive on this machine.
 */
export function resolveSocketPath(explicit: string | null, environment: ClientEnvironment): string {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(environment.cwd, explicit)
  const fromEnv = environment.env[CONTROL_SOCKET_ENV_VAR]
  if (fromEnv) return fromEnv
  const candidates = liveControlSockets(environment)
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length === 0) {
    throw new UnreachableError(`not running inside fmx (${CONTROL_SOCKET_ENV_VAR} is unset and no fmx is running)`)
  }
  throw new UnreachableError(
    `not running inside fmx, and more than one is running; pass --socket with one of: ${candidates.join(", ")}`,
  )
}

function liveControlSockets(environment: ClientEnvironment): string[] {
  const directory = environment.socketDirectory ?? "/tmp"
  const alive = environment.isProcessAlive ?? processAlive
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const sockets: string[] = []
  for (const name of names) {
    const match = /^fmx-(\d+)\.ctl$/u.exec(name)
    if (!match) continue
    if (alive(Number(match[1]))) sockets.push(`${directory}/${name}`)
  }
  return sockets.sort()
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** One request, one reply, one connection. */
export async function exchange(
  socketPath: string,
  method: ControlMethod,
  params: Record<string, unknown>,
  timeoutMs: number | null,
): Promise<ControlReply> {
  const id = `${process.pid}-${Date.now().toString(36)}`
  const assembler = new LineAssembler()
  const { promise, resolve: settle, reject } = Promise.withResolvers<ControlReply>()
  let timer: ReturnType<typeof setTimeout> | null = null
  if (timeoutMs !== null) {
    timer = setTimeout(
      () => settle({ id, ok: false, error: { code: "timeout", message: `fmx did not answer within ${timeoutMs}ms` } }),
      timeoutMs,
    )
  }

  let connection: Awaited<ReturnType<typeof Bun.connect>> | null = null
  try {
    connection = await Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => {
          socket.write(encodeRequest({ id, method, params }))
        },
        data: (_socket, data) => {
          const [line] = assembler.push(new TextDecoder().decode(data))
          if (line !== undefined) settle(decodeReply(line))
        },
        close: () => {
          const [line] = assembler.flush()
          if (line !== undefined) settle(decodeReply(line))
          else settle({ id, ok: false, error: { code: "failed", message: "fmx closed the connection without answering" } })
        },
        error: (_socket, error) => reject(error),
      },
    })
  } catch (error) {
    if (timer) clearTimeout(timer)
    throw new UnreachableError(`cannot reach fmx at ${socketPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    return await promise
  } finally {
    if (timer) clearTimeout(timer)
    connection.end()
  }
}

export function exitCodeFor(error: ControlError): number {
  switch (error.code) {
    case "timeout":
      return EXIT_TIMEOUT
    case "invalid_params":
    case "invalid_request":
    case "unknown_method":
      return EXIT_USAGE
    default:
      return EXIT_REFUSED
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
