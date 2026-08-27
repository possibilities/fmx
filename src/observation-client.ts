import type { ObserveArgs } from "./cli.ts"
import {
  EXIT_OK,
  EXIT_UNREACHABLE,
  resolveSocketPath,
  type ClientEnvironment,
} from "./control-client.ts"
import type { ControlError } from "./control-protocol.ts"
import {
  encodeObservationSubscription,
  OBSERVATION_SCHEMA_VERSION,
  type ObservationSubscription,
} from "./observation-protocol.ts"
import { ObservationSocket } from "./observation-socket.ts"

export type ObservationClientEnvironment = Omit<ClientEnvironment, "readStdin"> & {
  write: (data: Uint8Array) => void | Promise<void>
}

export type ObservationClientOutcome = {
  exitCode: number
  error?: ControlError
}

/** Connect once and relay the passive stream until the Runtime closes it. */
export async function runObservation(
  options: ObserveArgs,
  explicitSocket: string | null,
  environment: ObservationClientEnvironment,
): Promise<ObservationClientOutcome> {
  let controlPath: string
  try {
    controlPath = await resolveSocketPath(explicitSocket, {
      ...environment,
      readStdin: async () => "",
    })
  } catch (error) {
    return {
      exitCode: EXIT_UNREACHABLE,
      error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
    }
  }
  const path = ObservationSocket.pathFor(controlPath)
  const subscription: ObservationSubscription = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    topics: options.activity ? ["state", "activity"] : ["state"],
    activityPayload: options.rawPayloads ? "raw" : "summary",
  }

  const completion = Promise.withResolvers<ObservationClientOutcome>()
  let settled = false
  const finish = (outcome: ObservationClientOutcome): void => {
    if (settled) return
    settled = true
    completion.resolve(outcome)
  }

  let connection: Awaited<ReturnType<typeof Bun.connect>> | null = null
  try {
    connection = await Bun.connect({
      unix: path,
      socket: {
        open: (socket) => {
          const request = encodeObservationSubscription(subscription)
          const written = socket.write(request)
          if (written < Buffer.byteLength(request)) {
            finish({
              exitCode: EXIT_UNREACHABLE,
              error: { code: "failed", message: "could not send observation subscription" },
            })
          }
        },
        data: async (socket, data) => {
          try {
            await environment.write(data)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            finish({
              exitCode: EXIT_UNREACHABLE,
              error: {
                code: "failed",
                message: `cannot write fmx observation stream: ${detail}`,
              },
            })
            socket.end()
          }
        },
        close: () => finish({ exitCode: EXIT_OK }),
        error: (_socket, error) => {
          finish({ exitCode: EXIT_UNREACHABLE, error: { code: "failed", message: error.message } })
        },
        connectError: (_socket, error) => {
          finish({ exitCode: EXIT_UNREACHABLE, error: { code: "failed", message: error.message } })
        },
      },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      exitCode: EXIT_UNREACHABLE,
      error: {
        code: "failed",
        message: `cannot reach fmx observation stream at ${path}: ${detail}`,
      },
    }
  }

  try {
    return await completion.promise
  } finally {
    connection?.end()
  }
}
