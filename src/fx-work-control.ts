import { randomBytes, randomUUID } from "node:crypto"
import { lstat, unlink } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"

export const FX_WORK_CONTROL_SOCKET_PATH = "FX_WORK_CONTROL_SOCKET_PATH"
export const FX_WORK_CONTROL_INSTANCE_ID = "FX_WORK_CONTROL_INSTANCE_ID"
export const FX_WORK_CONTROL_TOKEN = "FX_WORK_CONTROL_TOKEN"

const MAX_FRAME_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 5_000
const MAX_UNIX_SOCKET_PATH_BYTES = 100
const TURN_ID = /^[1-9]\d*$/u

export type FxWorkControlBinding = {
  socketPath: string
  instanceId: string
  token: string
}

export type FxQueuedWork = {
  turn_id: string
  kind: "queued" | "steering"
  text: string
  has_images: boolean
  has_skill_bindings: boolean
  has_review_draft: boolean
}

export type FxWorkSnapshot = {
  active_turn_id: string | null
  queue_paused: boolean
  queue: FxQueuedWork[]
}

export type FxWorkControlMethod =
  | "work.snapshot"
  | "work.queue"
  | "work.steer"
  | "work.interrupt"
  | "queue.update"
  | "queue.delete"
  | "queue.resume"

export type FxWorkControlResult = {
  snapshot: FxWorkSnapshot
  turn_id?: string
  disposition?: "queued" | "steering"
}

export type FxWorkControlRequester = {
  request(
    binding: FxWorkControlBinding,
    method: FxWorkControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FxWorkControlResult>
}

export class FxWorkControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "FxWorkControlError"
  }
}

export function mintFxWorkControlBinding(
  runtimeSocketPath: string,
  agentId: string,
  token: string = randomBytes(32).toString("hex"),
): FxWorkControlBinding {
  const socketPath = fxWorkControlSocketPath(runtimeSocketPath, agentId)
  return { socketPath, instanceId: agentId, token }
}

export function fxWorkControlSocketPath(runtimeSocketPath: string, agentId: string): string {
  const stem = runtimeSocketPath.endsWith(".bus") ? runtimeSocketPath.slice(0, -4) : runtimeSocketPath
  const path = `${stem}.${agentId}.fx`
  if (Buffer.byteLength(path) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`Fx work-control socket path is too long: ${path}`)
  }
  return path
}

/** Remove only the exact socket this Runtime assigned to an Agent now proven
 * dead. Fx normally removes its own endpoint; this closes the crash/kill
 * window without letting a persisted path name an arbitrary file. */
export async function removeFxWorkControlResidue(
  binding: FxWorkControlBinding | null,
  runtimeSocketPath: string | null,
  options: { beforeUnlink?: () => void | Promise<void> } = {},
): Promise<boolean> {
  if (!binding || !runtimeSocketPath) return false
  const expected = fxWorkControlSocketPath(runtimeSocketPath, binding.instanceId)
  if (binding.socketPath !== expected) return false
  let metadata
  try {
    metadata = await lstat(expected)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  if (!metadata.isSocket()) return false
  await options.beforeUnlink?.()
  let current
  try {
    current = await lstat(expected)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  if (
    !current.isSocket() || current.dev !== metadata.dev || current.ino !== metadata.ino ||
    current.uid !== metadata.uid || current.mode !== metadata.mode
  ) {
    throw new FxWorkControlError(
      "unsafe_residue",
      `Fx work-control endpoint changed before removal: ${expected}`,
    )
  }
  await unlink(expected)
  return true
}

export class FxWorkControlClient implements FxWorkControlRequester {
  request(
    binding: FxWorkControlBinding,
    method: FxWorkControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FxWorkControlResult> {
    if (signal.aborted) return Promise.reject(cancelled())
    const requestId = randomUUID()
    const payload = Buffer.from(JSON.stringify({
      schema: 1,
      request_id: requestId,
      instance_id: binding.instanceId,
      token: binding.token,
      method,
      params,
    }))
    if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME_BYTES) {
      return Promise.reject(new FxWorkControlError("frame_too_large", "Fx work-control request is too large"))
    }
    const frame = Buffer.allocUnsafe(payload.byteLength + 4)
    frame.writeUInt32BE(payload.byteLength, 0)
    payload.copy(frame, 4)

    return new Promise((resolve, reject) => {
      let socket: Socket | null = null
      let settled = false
      let input = Buffer.alloc(0)
      let expected: number | null = null
      const finish = (error: unknown, result?: FxWorkControlResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        socket?.destroy()
        if (error) reject(error)
        else resolve(result!)
      }
      const abort = () => finish(cancelled())
      const timer = setTimeout(
        () => finish(new FxWorkControlError("timeout", `Fx did not answer within ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      )
      signal.addEventListener("abort", abort, { once: true })

      try {
        socket = createConnection(binding.socketPath)
      } catch (error) {
        finish(unreachable(binding.socketPath, error))
        return
      }
      socket.once("connect", () => socket?.write(frame))
      socket.on("data", (chunk: Buffer) => {
        input = Buffer.concat([input, chunk])
        if (expected === null && input.byteLength >= 4) {
          expected = input.readUInt32BE(0)
          if (expected === 0 || expected > MAX_FRAME_BYTES) {
            finish(new FxWorkControlError("invalid_response", "Fx returned an invalid work-control frame"))
            return
          }
        }
        if (expected === null || input.byteLength < expected + 4) return
        if (input.byteLength !== expected + 4) {
          finish(new FxWorkControlError("invalid_response", "Fx returned trailing work-control bytes"))
          return
        }
        try {
          finish(null, decodeResponse(input.subarray(4), binding, requestId, method))
        } catch (error) {
          finish(error)
        }
      })
      socket.once("error", (error) => finish(unreachable(binding.socketPath, error)))
      socket.once("close", () => {
        if (!settled) finish(new FxWorkControlError("unavailable", "Fx closed work control without answering"))
      })
      if (signal.aborted) abort()
    })
  }
}

function decodeResponse(
  bytes: Uint8Array,
  binding: FxWorkControlBinding,
  requestId: string,
  method: FxWorkControlMethod,
): FxWorkControlResult {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    throw new FxWorkControlError("invalid_response", "Fx returned invalid work-control JSON")
  }
  if (!isRecord(value) || value.schema !== 1 || value.request_id !== requestId ||
    value.instance_id !== binding.instanceId || typeof value.ok !== "boolean") {
    throw new FxWorkControlError("invalid_response", "Fx returned an uncorrelated work-control response")
  }
  if (!value.ok) {
    const error = isRecord(value.error) ? value.error : {}
    throw new FxWorkControlError(
      typeof error.code === "string" ? error.code : "failed",
      typeof error.message === "string" ? error.message : "Fx rejected work control",
    )
  }
  if (!isRecord(value.result)) {
    throw new FxWorkControlError("invalid_response", "Fx returned an invalid work-control result")
  }
  const snapshot = decodeSnapshot(value.result.snapshot)
  if (method !== "work.queue" && method !== "work.steer") return { snapshot }
  const turnId = value.result.turn_id
  const disposition = value.result.disposition
  if (!validTurnId(turnId) || (disposition !== "queued" && disposition !== "steering")) {
    throw new FxWorkControlError("invalid_response", "Fx returned an invalid work admission result")
  }
  return { turn_id: turnId, disposition, snapshot }
}

function decodeSnapshot(value: unknown): FxWorkSnapshot {
  if (!isRecord(value) ||
    (value.active_turn_id !== null && !validTurnId(value.active_turn_id)) ||
    typeof value.queue_paused !== "boolean" || !Array.isArray(value.queue)) {
    throw new FxWorkControlError("invalid_response", "Fx returned an invalid work snapshot")
  }
  const queue = value.queue.map((raw): FxQueuedWork => {
    if (!isRecord(raw) || !validTurnId(raw.turn_id) ||
      (raw.kind !== "queued" && raw.kind !== "steering") || typeof raw.text !== "string" ||
      typeof raw.has_images !== "boolean" || typeof raw.has_skill_bindings !== "boolean" ||
      typeof raw.has_review_draft !== "boolean") {
      throw new FxWorkControlError("invalid_response", "Fx returned an invalid queued-work entry")
    }
    return {
      turn_id: raw.turn_id,
      kind: raw.kind,
      text: raw.text,
      has_images: raw.has_images,
      has_skill_bindings: raw.has_skill_bindings,
      has_review_draft: raw.has_review_draft,
    }
  })
  return {
    active_turn_id: value.active_turn_id,
    queue_paused: value.queue_paused,
    queue,
  }
}

function validTurnId(value: unknown): value is string {
  return typeof value === "string" && TURN_ID.test(value)
}

function cancelled(): FxWorkControlError {
  return new FxWorkControlError("cancelled", "Fx work control was cancelled")
}

function unreachable(path: string, error: unknown): FxWorkControlError {
  return new FxWorkControlError(
    "unavailable",
    `cannot reach Fx work control at ${path}: ${error instanceof Error ? error.message : String(error)}`,
  )
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
