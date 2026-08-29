import { randomUUID } from "node:crypto"
import { readdirSync } from "node:fs"
import {
  BUS_SOCKET_ENV_VAR,
  busSocketPathFor,
  decodeBusResponse,
  encodeBusRequest,
} from "./bus-protocol.ts"
import {
  type ControlError,
  type ControlMethod,
  type ControlReply,
  errorReply,
} from "./control-protocol.ts"
import { LineAssembler } from "./line-assembler.ts"
import { listenerAnswers } from "./unix-socket.ts"
import { privateRootDirectory } from "./zmx-environment.ts"

const REPLY_TIMEOUT_MS = 5_000

export type RuntimeClientEnvironment = {
  env: NodeJS.ProcessEnv
  /** Where live Runtime buses are looked for when the caller is outside an Agent. */
  socketDirectory?: string
  /** Whether a Runtime answers at a Bus path; a connect probe unless a test supplies one. */
  isSocketLive?: (path: string) => Promise<boolean>
}

export type RuntimeRequester = {
  request(
    method: ControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>
}

export class RuntimeRequestError extends Error {
  constructor(readonly error: ControlError) {
    super(error.message)
    this.name = "RuntimeRequestError"
  }
}

/**
 * The MCP server's private bridge to the running Runtime. The Runtime may end
 * and return at the same stable Home path while an Fx process keeps this MCP
 * server alive, so every tool call resolves and opens a fresh connection.
 */
export class RuntimeClient implements RuntimeRequester {
  constructor(private readonly environment: RuntimeClientEnvironment = { env: process.env }) {}

  async request(
    method: ControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) {
      throw new RuntimeRequestError({ code: "cancelled", message: "fmx MCP request was cancelled" })
    }
    const path = await resolveRuntimePath(this.environment)
    const caller = callerAgent(this.environment.env)
    const reply = await exchange(
      path,
      method,
      caller === null ? params : { ...params, caller },
      signal,
    )
    if (!reply.ok) throw new RuntimeRequestError(reply.error)
    return reply.result
  }
}

/**
 * Select the Runtime named by the Agent environment, or the sole live Runtime
 * when an MCP host starts fmx-mcp outside an Agent.
 */
export async function resolveRuntimePath(environment: RuntimeClientEnvironment): Promise<string> {
  const fromEnv = environment.env[BUS_SOCKET_ENV_VAR]
  if (fromEnv) return busSocketPathFor(fromEnv)

  const candidates = await liveRuntimeSockets(environment)
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length === 0) {
    throw new RuntimeRequestError({
      code: "failed",
      message: `not running inside fmx (${BUS_SOCKET_ENV_VAR} is unset and no fmx is running)`,
    })
  }
  throw new RuntimeRequestError({
    code: "failed",
    message: `not running inside fmx, and more than one Runtime is running: ${candidates.join(", ")}`,
  })
}

function callerAgent(env: NodeJS.ProcessEnv): number | null {
  const raw = env.FMX_AGENT_ID
  if (raw === undefined || !/^\d+$/u.test(raw)) return null
  return Number(raw)
}

async function liveRuntimeSockets(environment: RuntimeClientEnvironment): Promise<string[]> {
  const directory = environment.socketDirectory ?? privateRootDirectory()
  const alive = environment.isSocketLive ?? listenerAnswers
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }

  const sockets: string[] = []
  for (const name of names.sort()) {
    if (!/^[0-9a-f]+\.bus$/u.test(name)) continue
    const path = `${directory}/${name}`
    if (await alive(path)) sockets.push(path)
  }
  return sockets
}

/** One correlated request over a short-lived Runtime Bus connection. */
async function exchange(
  socketPath: string,
  method: ControlMethod,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ControlReply> {
  const id = randomUUID()
  const assembler = new LineAssembler()
  const decoder = new TextDecoder()
  const completion = Promise.withResolvers<ControlReply>()
  let settled = false
  let connection: Awaited<ReturnType<typeof Bun.connect>> | null = null
  const finish = (reply: ControlReply): void => {
    if (settled) return
    settled = true
    completion.resolve(reply)
  }
  const abort = (): void => {
    finish(errorReply(id, { code: "cancelled", message: "fmx MCP request was cancelled" }))
    connection?.end()
  }
  signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(
    () => finish(errorReply(id, { code: "timeout", message: `fmx did not answer within ${REPLY_TIMEOUT_MS}ms` })),
    REPLY_TIMEOUT_MS,
  )

  try {
    try {
      connection = await Bun.connect({
        unix: socketPath,
        socket: {
          open: (socket) => {
            if (signal.aborted) {
              socket.end()
              return
            }
            const request = encodeBusRequest({ id, method, params })
            if (socket.write(request) < Buffer.byteLength(request)) {
              finish(errorReply(id, { code: "failed", message: "could not send fmx MCP request" }))
              socket.end()
            }
          },
          data: (_socket, data) => {
            for (const line of assembler.push(decoder.decode(data, { stream: true }))) {
              const reply = decodeBusResponse(line)
              if (reply && (reply.id === id || reply.id === null)) finish(reply)
            }
          },
          close: () => {
            const trailing = [...assembler.push(decoder.decode()), ...assembler.flush()]
            for (const line of trailing) {
              const reply = decodeBusResponse(line)
              if (reply && (reply.id === id || reply.id === null)) {
                finish(reply)
                return
              }
            }
            finish(errorReply(id, { code: "failed", message: "fmx closed the connection without answering" }))
          },
          error: (_socket, error) => finish(errorReply(id, { code: "failed", message: error.message })),
          connectError: (_socket, error) => finish(errorReply(id, { code: "failed", message: error.message })),
        },
      })
    } catch (error) {
      throw new RuntimeRequestError({
        code: "failed",
        message: `cannot reach fmx at ${socketPath}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return await completion.promise
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    connection?.end()
  }
}
