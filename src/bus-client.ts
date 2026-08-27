import {
  BUS_SCHEMA_VERSION,
  encodeBusSubscription,
  type BusSubscription,
} from "./bus-protocol.ts"
import type { BusArgs } from "./cli.ts"
import {
  EXIT_OK,
  EXIT_UNREACHABLE,
  resolveBusPath,
  type ClientEnvironment,
} from "./control-client.ts"
import type { ControlError } from "./control-protocol.ts"

export type BusClientEnvironment = Omit<ClientEnvironment, "readStdin"> & {
  write: (data: Uint8Array) => void | Promise<void>
}

export type BusClientOutcome = {
  exitCode: number
  error?: ControlError
}

/** Subscribe once and relay bus events until the Runtime closes the connection. */
export async function runBus(
  options: BusArgs,
  explicitSocket: string | null,
  environment: BusClientEnvironment,
): Promise<BusClientOutcome> {
  let path: string
  try {
    path = await resolveBusPath(explicitSocket, {
      ...environment,
      readStdin: async () => "",
    })
  } catch (error) {
    return {
      exitCode: EXIT_UNREACHABLE,
      error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
    }
  }
  const subscription: BusSubscription = {
    schemaVersion: BUS_SCHEMA_VERSION,
    topics: options.activity ? ["state", "activity"] : ["state"],
    activityPayload: options.rawPayloads ? "raw" : "summary",
  }

  const completion = Promise.withResolvers<BusClientOutcome>()
  let settled = false
  const finish = (outcome: BusClientOutcome): void => {
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
          const request = encodeBusSubscription(subscription)
          const written = socket.write(request)
          if (written < Buffer.byteLength(request)) {
            finish({
              exitCode: EXIT_UNREACHABLE,
              error: { code: "failed", message: "could not send bus subscription" },
            })
            socket.end()
          }
        },
        data: async (socket, data) => {
          try {
            await environment.write(data)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            finish({
              exitCode: EXIT_UNREACHABLE,
              error: { code: "failed", message: `cannot write fmx bus: ${detail}` },
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
      error: { code: "failed", message: `cannot reach fmx bus at ${path}: ${detail}` },
    }
  }

  try {
    return await completion.promise
  } finally {
    connection?.end()
  }
}
