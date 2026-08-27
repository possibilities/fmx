import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import {
  BUS_SOCKET_ENV_VAR,
  busSocketPathFor,
  decodeBusResponse,
  encodeBusRequest,
} from "./bus-protocol.ts"
import type { Command, LaunchFieldArgs, TextSource } from "./cli.ts"
import {
  type ControlError,
  type ControlMethod,
  type ControlReply,
} from "./control-protocol.ts"
import { LineAssembler } from "./line-assembler.ts"
import { listenerAnswers } from "./unix-socket.ts"

/**
 * The control client over the Runtime Bus: `fmx control <command>` resolves
 * the Home Bus, sends a typed request, and prints the result.
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
  /** Where live Runtime buses are looked for when nothing names one. */
  socketDirectory?: string
  /** Whether an fmx answers at a Bus path; a connect probe unless a test says otherwise. */
  isSocketLive?: (path: string) => Promise<boolean>
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
    socketPath = await resolveBusPath(explicitSocket, environment)
  } catch (error) {
    return {
      exitCode: EXIT_UNREACHABLE,
      error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
    }
  }

  const caller = callerAgent(environment.env)
  const plan = await planRequests(command, environment, caller)
  let result: unknown = null
  for (const step of plan) {
    const reply = await exchange(socketPath, step.method, step.params, step.timeoutMs)
    if (!reply.ok) return { exitCode: exitCodeFor(reply.error), error: reply.error }
    result = reply.result
  }
  return { exitCode: EXIT_OK, result }
}

type Step = {
  method: ControlMethod
  params: Record<string, unknown>
  /** null waits as long as the server does. */
  timeoutMs: number | null
}

async function planRequests(command: Command, environment: ClientEnvironment, caller: number | null): Promise<Step[]> {
  const withCaller = (params: Record<string, unknown>): Record<string, unknown> =>
    caller === null ? params : { ...params, caller }
  switch (command.name) {
    case "orient":
      return [{ method: "orient", params: withCaller({}), timeoutMs: REPLY_TIMEOUT_MS }]
    case "agent":
      switch (command.verb) {
        case "list":
          return [{ method: "agent.list", params: {}, timeoutMs: REPLY_TIMEOUT_MS }]
        case "wait":
          return [
            {
              method: "agent.wait",
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
              method: "agent.send",
              params: withCaller({ target: command.target, text: await readText(command.text, environment) }),
              timeoutMs: REPLY_TIMEOUT_MS,
            },
          ]
      }
    case "launch": {
      const fields = await launchFieldParams(command.fields, environment)
      return [
        {
          method: "launch",
          params: withCaller({ ...fields, focus: command.focus }),
          // Cutting a worktree and spawning fx both happen before the answer.
          timeoutMs: 30_000,
        },
      ]
    }
    case "focus":
      return [{ method: "focus", params: withCaller({ target: command.target }), timeoutMs: REPLY_TIMEOUT_MS }]
    case "tray":
      return [
        {
          method: "tray",
          params: {
            ...(command.width === undefined ? {} : { width: command.width }),
            ...(command.hidden === undefined ? {} : { hidden: command.hidden }),
            ...(command.toggle ? { toggle: true } : {}),
          },
          timeoutMs: REPLY_TIMEOUT_MS,
        },
      ]
    case "keys":
      return [{ method: "keys", params: { show: command.show }, timeoutMs: REPLY_TIMEOUT_MS }]
    case "catalog":
      return [{ method: "catalog", params: {}, timeoutMs: REPLY_TIMEOUT_MS }]
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
  if (fields.model !== undefined) params.model = fields.model
  if (fields.effort !== undefined) params.effort = fields.effort
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

function callerAgent(env: NodeJS.ProcessEnv): number | null {
  const raw = env.FMX_AGENT_ID
  if (raw === undefined || !/^\d+$/u.test(raw)) return null
  return Number(raw)
}

/**
 * Which fmx to talk to: the one named, the one the caller runs inside, or —
 * for a human testing from outside — the only one alive on this machine.
 */
export async function resolveBusPath(explicit: string | null, environment: ClientEnvironment): Promise<string> {
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(environment.cwd, explicit)
    return busSocketPathFor(path)
  }
  const fromEnv = environment.env[BUS_SOCKET_ENV_VAR]
  if (fromEnv) return busSocketPathFor(fromEnv)
  const candidates = await liveBusSockets(environment)
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length === 0) {
    throw new UnreachableError(`not running inside fmx (${BUS_SOCKET_ENV_VAR} is unset and no fmx is running)`)
  }
  throw new UnreachableError(
    `not running inside fmx, and more than one Runtime is running; pass --socket with one of: ${candidates.join(", ")}`,
  )
}

/**
 * Runtime Buses are named for a Home, not a process, so a file proves
 * nothing about whether an fmx is behind it: the ones that answer are the
 * ones that count.
 */
async function liveBusSockets(environment: ClientEnvironment): Promise<string[]> {
  const directory = environment.socketDirectory ?? "/tmp"
  const alive = environment.isSocketLive ?? listenerAnswers
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const sockets: string[] = []
  for (const name of names.sort()) {
    if (!/^fmx-\d+-[0-9a-f]+\.bus$/u.test(name)) continue
    const path = `${directory}/${name}`
    if (await alive(path)) sockets.push(path)
  }
  return sockets
}

/** One request and its correlated response on a bus connection. */
export async function exchange(
  socketPath: string,
  method: ControlMethod,
  params: Record<string, unknown>,
  timeoutMs: number | null,
): Promise<ControlReply> {
  const id = `${process.pid}-${Date.now().toString(36)}`
  const assembler = new LineAssembler()
  const decoder = new TextDecoder()
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
          socket.write(encodeBusRequest({ id, method, params }))
        },
        data: (_socket, data) => {
          for (const line of assembler.push(decoder.decode(data, { stream: true }))) {
            const reply = decodeBusResponse(line)
            if (reply && (reply.id === id || reply.id === null)) settle(reply)
          }
        },
        close: () => {
          const trailing = [...assembler.push(decoder.decode()), ...assembler.flush()]
          for (const line of trailing) {
            const reply = decodeBusResponse(line)
            if (reply && (reply.id === id || reply.id === null)) {
              settle(reply)
              return
            }
          }
          settle({ id, ok: false, error: { code: "failed", message: "fmx closed the connection without answering" } })
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
