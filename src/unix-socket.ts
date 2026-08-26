import { unlinkSync } from "node:fs"

/** Whether something accepts connections at `path`. Absent or refused is `false`. */
export async function listenerAnswers(path: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timeout = setTimeout(() => resolve(false), 500)
  try {
    const connection = await Bun.connect({
      unix: path,
      socket: {
        data: () => {},
        open: (socket) => {
          clearTimeout(timeout)
          resolve(true)
          socket.end()
        },
        error: () => resolve(false),
        connectError: () => resolve(false),
        close: () => resolve(false),
      },
    })
    connection.end()
  } catch {
    resolve(false)
  }
  clearTimeout(timeout)
  return promise
}

export function removeSocketFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Missing is normal; a stale file from a crashed Runtime is why callers
    // probe before replacing the path.
  }
}

export function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EADDRINUSE"
}
