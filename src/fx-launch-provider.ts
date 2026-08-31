import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmod, lstat, mkdtemp, rmdir, unlink } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { join } from "node:path"
import {
  decodeAgentWorkplacePayload,
  encodeAgentWorkplacePayload,
  type FxLaunchAdmissionFinalMessage,
} from "./agentworkplace-contracts.ts"
import { decodeStrictJson, encodeCanonicalJson, type JsonValue } from "./contract-codec.ts"
import { ensurePrivateDirectories } from "./private-directory.ts"
import { privateRootDirectory } from "./zmx-environment.ts"

export const FX_LAUNCH_PROVIDER_SCHEMA_ID = "fx.private-launch-provider"
export const FX_LAUNCH_PROVIDER_SCHEMA_VERSION = 1
export const FX_LAUNCH_PROVIDER_INTERNAL_ARGUMENT = "--internal-launch-provider"
export const FX_LAUNCH_PROVIDER_DIRECTORY = "FX_INTERNAL_LAUNCH_PROVIDER_DIRECTORY"
export const FX_LAUNCH_PROVIDER_INSTANCE_ID = "FX_INTERNAL_LAUNCH_PROVIDER_INSTANCE_ID"
export const FX_LAUNCH_PROVIDER_TOKEN = "FX_INTERNAL_LAUNCH_PROVIDER_TOKEN"
export const FX_LAUNCH_PROVIDER_SOCKET_NAME = "provider.sock"
export const FX_LAUNCH_PROVIDER_MAX_FRAME_BYTES = 1024 * 1024
export const FX_LAUNCH_PROVIDER_MAX_CONTROLS_BYTES = 128 * 1024

const SOCKET_PATH_MAX_BYTES = 100
const DEFAULT_TIMEOUT_MS = 8_000
const VALUE_OPTIONS = new Set([
  "--system-prompt-file",
  "--append-system-prompt-file",
  "--skills-dir",
  "--context-limit",
  "--add-dir",
  "--tool",
  "--permissions-file",
])
const FLAG_OPTIONS = new Set([
  "--record",
  "--no-additional-dirs",
  "--no-native-tools",
  "--no-default-skills",
  "--no-project-instructions",
])
const PROVIDER_OWNED = ["--state-dir", "--name", "--model", "--effort", "--resume", "--resume-id"]

type Operation = "prepare" | "build" | "inspect" | "cancel" | "record_final" | "acknowledge_final"
type Correlation = { stateRoot: string; admissionKey: string; launchDigest: string; launchId: string }
export type FxLaunchRequest = Extract<FxLaunchAdmissionFinalMessage, { initial_work_digest: unknown }>
export type FxLaunchReceipt = Extract<FxLaunchAdmissionFinalMessage, { status: "accepted" }>
export type FxAdmissionCancelRequest = Extract<FxLaunchAdmissionFinalMessage, { cancellation_request_id?: never; request_id: unknown }>
export type FxAdmissionDecision = Extract<FxLaunchAdmissionFinalMessage, { decision: unknown }>
export type FxFinalReceipt = Extract<FxLaunchAdmissionFinalMessage, { observed_at: unknown }>
export type FxFinalReceiptAcknowledgement = Extract<FxLaunchAdmissionFinalMessage, { acknowledgement_id: unknown }>

export type FxLaunchProviderBuild = Correlation & {
  mode: "initial" | "recover_after_definitive_end"
  remainingGlobalArgs: readonly string[]
  remainingLaunchControlsDigest: string
}

export type FxLaunchProviderFinalOutcome =
  | { kind: "exited"; code: number }
  | { kind: "signalled"; signal: number }
  | { kind: "exec_failed"; message: string }

export type FxLaunchProviderFinalAuthority = {
  launchReceipt: FxLaunchReceipt
  decision: FxAdmissionDecision | null
  finalReceipt: FxFinalReceipt | null
  finalAcknowledgementId: string | null
}

/** The provider deliberately returns arguments without an executable. The
 * Companion remains the process owner and combines this with its resolved Fx. */
export type FxLaunchProviderInvocation = {
  command: string[]
  cwd: string
  env: Record<string, string>
  conversationId: string
  mode: "initial" | "recover_after_definitive_end"
}

export type FxLaunchProviderHelper = {
  exited: Promise<number>
  kill(): void
}

export type FxLaunchProviderHelperRequest = {
  executable: string
  arguments: readonly [typeof FX_LAUNCH_PROVIDER_INTERNAL_ARGUMENT]
  environment: NodeJS.ProcessEnv
}

export type FxLaunchProviderOptions = {
  /** Absolute, already probed fmx-fx path. This is never resolved by the client. */
  executable: string
  /** fmx's already-verified private runtime root (normally /tmp/fmx-<uid>). */
  runtimeDirectory?: string
  timeoutMs?: number
  parentEnvironment?: NodeJS.ProcessEnv
  /** Test seam; production always starts the supplied resolved executable. */
  launchHelper?: (request: FxLaunchProviderHelperRequest) => FxLaunchProviderHelper
}

export class FxLaunchProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "FxLaunchProviderError"
  }
}

/**
 * A one-shot client for Fx's private launch adapter. It intentionally has no
 * filesystem knowledge beyond the fresh transport directory; all durable
 * authority remains in Fx's launch-admission-final ledger.
 */
export class FxLaunchProviderClient {
  private readonly runtimeDirectory: string
  private readonly timeoutMs: number
  private readonly parentEnvironment: NodeJS.ProcessEnv

  constructor(private readonly options: FxLaunchProviderOptions) {
    if (!options.executable.startsWith("/")) {
      throw new FxLaunchProviderError("invalid_executable", "resolved fmx-fx executable must be an absolute path")
    }
    this.runtimeDirectory = options.runtimeDirectory ?? privateRootDirectory()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.parentEnvironment = options.parentEnvironment ?? process.env
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new FxLaunchProviderError("invalid_timeout", "launch-provider timeout must be a positive integer")
    }
  }

  async prepare(launchRequest: FxLaunchRequest): Promise<FxLaunchReceipt> {
    const result = await this.request("prepare", { launch_request: publicPayload(launchRequest, "launch_request") })
    assertExactKeys(result, ["launch_receipt"], "prepare result")
    return publicResult(result.launch_receipt, "launch_receipt") as FxLaunchReceipt
  }

  async build(input: FxLaunchProviderBuild): Promise<FxLaunchProviderInvocation> {
    const launchControls = encodeLaunchControls(input.remainingGlobalArgs)
    const computedDigest = createHash("sha256").update(launchControls).digest("hex")
    if (computedDigest !== input.remainingLaunchControlsDigest) {
      throw new FxLaunchProviderError("invalid_controls", "launch controls digest does not match their exact canonical bytes")
    }
    const result = await this.request("build", {
      state_root: input.stateRoot,
      admission_key: input.admissionKey,
      launch_digest: input.launchDigest,
      launch_id: input.launchId,
      mode: input.mode,
      launch_controls: launchControls,
      remaining_launch_controls_digest: input.remainingLaunchControlsDigest,
    })
    assertExactKeys(result, ["arguments", "cwd", "environment", "mode"], "build result")
    if (!Array.isArray(result.arguments) || !result.arguments.every((value) => typeof value === "string") ||
      typeof result.cwd !== "string" || !isRecord(result.environment) ||
      (result.mode !== "initial" && result.mode !== "recover_after_definitive_end")) {
      throw invalidResponse("Fx returned an invalid build result")
    }
    const environment = decodeInvocationEnvironment(result.environment, input)
    return {
      command: [...result.arguments],
      cwd: result.cwd,
      env: environment,
      conversationId: environment.FX_INTERNAL_LAUNCH_CONVERSATION_ID!,
      mode: result.mode,
    }
  }

  inspect(correlation: Correlation): Promise<FxLaunchProviderFinalAuthority> {
    return this.inspection("inspect", correlation)
  }

  async cancel(
    stateRoot: string,
    cancelRequest: FxAdmissionCancelRequest,
  ): Promise<FxLaunchProviderFinalAuthority> {
    return this.decodeInspection(await this.request("cancel", {
      state_root: stateRoot,
      cancel_request: publicPayload(cancelRequest, "admission_cancel_request"),
    }))
  }

  async recordFinal(
    correlation: Correlation,
    observedAt: string,
    outcome: FxLaunchProviderFinalOutcome,
  ): Promise<FxLaunchProviderFinalAuthority> {
    return this.decodeInspection(await this.request("record_final", {
      state_root: correlation.stateRoot,
      admission_key: correlation.admissionKey,
      launch_digest: correlation.launchDigest,
      launch_id: correlation.launchId,
      observed_at: observedAt,
      outcome,
    }))
  }

  async acknowledgeFinal(
    stateRoot: string,
    acknowledgement: FxFinalReceiptAcknowledgement,
  ): Promise<FxLaunchProviderFinalAuthority> {
    return this.decodeInspection(await this.request("acknowledge_final", {
      state_root: stateRoot,
      acknowledgement: publicPayload(acknowledgement, "final_receipt_acknowledgement"),
    }))
  }

  private async inspection(operation: "inspect", correlation: Correlation): Promise<FxLaunchProviderFinalAuthority> {
    return this.decodeInspection(await this.request(operation, {
      state_root: correlation.stateRoot,
      admission_key: correlation.admissionKey,
      launch_digest: correlation.launchDigest,
      launch_id: correlation.launchId,
    }))
  }

  private async decodeInspection(result: Record<string, unknown>): Promise<FxLaunchProviderFinalAuthority> {
    assertExactKeys(result, ["launch_receipt", "decision", "final_receipt", "final_acknowledgement_id"], "inspection result")
    if ((result.decision !== null && typeof result.decision !== "string") ||
      (result.final_receipt !== null && typeof result.final_receipt !== "string") ||
      (result.final_acknowledgement_id !== null && typeof result.final_acknowledgement_id !== "string")) {
      throw invalidResponse("Fx returned an invalid inspection result")
    }
    return {
      launchReceipt: publicResult(result.launch_receipt, "launch_receipt") as FxLaunchReceipt,
      decision: result.decision === null ? null : publicResult(result.decision, "admission_decision") as FxAdmissionDecision,
      finalReceipt: result.final_receipt === null ? null : publicResult(result.final_receipt, "final_receipt") as FxFinalReceipt,
      finalAcknowledgementId: result.final_acknowledgement_id,
    }
  }

  private async request(operation: Operation, fields: Record<string, JsonValue>): Promise<Record<string, unknown>> {
    const requestId = randomUUID()
    const instanceId = randomUUID()
    const token = randomBytes(32).toString("hex")
    const started = Date.now()
    await ensurePrivateDirectories([this.runtimeDirectory], "Fx launch provider")
    const directory = await mkdtemp(join(this.runtimeDirectory, "launch-provider-"))
    const socketPath = join(directory, FX_LAUNCH_PROVIDER_SOCKET_NAME)
    if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX_BYTES) {
      await cleanupEndpoint(directory, socketPath)
      throw new FxLaunchProviderError("unsafe_socket_path", `launch-provider socket path is too long: ${socketPath}`)
    }
    await chmod(directory, 0o700)
    const environment: NodeJS.ProcessEnv = {
      ...this.parentEnvironment,
      [FX_LAUNCH_PROVIDER_DIRECTORY]: directory,
      [FX_LAUNCH_PROVIDER_INSTANCE_ID]: instanceId,
      [FX_LAUNCH_PROVIDER_TOKEN]: token,
    }
    let helper: FxLaunchProviderHelper | null = null
    try {
      helper = this.options.launchHelper?.({
        executable: this.options.executable,
        arguments: [FX_LAUNCH_PROVIDER_INTERNAL_ARGUMENT],
        environment,
      }) ?? spawnProvider(this.options.executable, environment)
      const payload = encodeCanonicalJson({
        schema_id: FX_LAUNCH_PROVIDER_SCHEMA_ID,
        schema_version: FX_LAUNCH_PROVIDER_SCHEMA_VERSION,
        instance_id: instanceId,
        token,
        request_id: requestId,
        operation,
        ...fields,
      })
      const response = await exchange(socketPath, payload, this.remaining(started), helper)
      await awaitHelper(helper, this.remaining(started))
      return decodeResponse(response, instanceId, requestId)
    } catch (error) {
      helper?.kill()
      throw error
    } finally {
      await cleanupEndpoint(directory, socketPath)
    }
  }

  private remaining(started: number): number {
    const remaining = this.timeoutMs - (Date.now() - started)
    if (remaining <= 0) throw new FxLaunchProviderError("timeout", "Fx launch provider did not answer before its deadline")
    return remaining
  }
}

export function encodeLaunchControls(args: readonly string[]): string {
  if (args.length > 128) throw new FxLaunchProviderError("invalid_controls", "launch controls allow at most 128 arguments")
  for (const arg of args) {
    if (Buffer.byteLength(arg) === 0 || Buffer.byteLength(arg) > 1024 || /[\u0000-\u001f\u007f]/u.test(arg)) {
      throw new FxLaunchProviderError("invalid_controls", "launch controls contain an invalid argument")
    }
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (PROVIDER_OWNED.some((option) => arg === option || arg.startsWith(`${option}=`))) {
      throw new FxLaunchProviderError("invalid_controls", "launch controls may not select provider-owned state")
    }
    if (["--", "--resume-last", "--continue", "-c", "-r", "resume"].includes(arg) || arg.startsWith("--resume-")) {
      throw new FxLaunchProviderError("invalid_controls", "launch controls may not select a resume target")
    }
    if (FLAG_OPTIONS.has(arg)) continue
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[++index]
      if (value === undefined || value.startsWith("-")) {
        throw new FxLaunchProviderError("invalid_controls", `launch control ${arg} requires a non-option value`)
      }
      continue
    }
    const equals = arg.indexOf("=")
    if (equals > 2 && VALUE_OPTIONS.has(arg.slice(0, equals)) && equals + 1 < arg.length) continue
    throw new FxLaunchProviderError("invalid_controls", `launch control is not allowlisted: ${arg}`)
  }
  const bytes = encodeCanonicalJson({ remaining_global_args: [...args] })
  if (bytes.byteLength > FX_LAUNCH_PROVIDER_MAX_CONTROLS_BYTES) {
    throw new FxLaunchProviderError("invalid_controls", "launch controls exceed 128 KiB")
  }
  return Buffer.from(bytes).toString("utf8")
}

function spawnProvider(executable: string, environment: NodeJS.ProcessEnv): FxLaunchProviderHelper {
  const child = Bun.spawn({
    cmd: [executable, FX_LAUNCH_PROVIDER_INTERNAL_ARGUMENT],
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  return { exited: child.exited, kill: () => child.kill() }
}

async function exchange(
  socketPath: string,
  payload: Uint8Array,
  timeoutMs: number,
  helper: FxLaunchProviderHelper,
): Promise<Uint8Array> {
  if (payload.byteLength === 0 || payload.byteLength > FX_LAUNCH_PROVIDER_MAX_FRAME_BYTES) {
    throw new FxLaunchProviderError("frame_too_large", "launch-provider request exceeds 1 MiB")
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4)
  frame.writeUInt32BE(payload.byteLength, 0)
  Buffer.from(payload).copy(frame, 4)
  return new Promise((resolveResponse, rejectResponse) => {
    let socket: Socket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let settled = false
    let input = Buffer.alloc(0)
    let expected: number | null = null
    let complete: Uint8Array | null = null
    const finish = (error?: unknown, response?: Uint8Array) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (retry) clearTimeout(retry)
      socket?.destroy()
      if (error) rejectResponse(error)
      else resolveResponse(response!)
    }
    const failedHelper = () => finish(new FxLaunchProviderError("helper_exited", "Fx launch provider exited before answering"))
    // A one-shot provider exits only after writing its response. Let already
    // buffered socket bytes run first, then treat an exit without even a
    // complete frame header as a failed operation.
    void helper.exited.then(() => setTimeout(() => {
      if (!settled && complete === null && expected === null) failedHelper()
    }, 0))
    const connect = () => {
      if (settled) return
      const connection = createConnection(socketPath)
      socket = connection
      connection.once("connect", () => connection.write(frame))
      connection.on("data", (chunk: Buffer) => {
        input = Buffer.concat([input, chunk])
        if (expected === null && input.byteLength >= 4) {
          expected = input.readUInt32BE(0)
          if (expected === 0 || expected > FX_LAUNCH_PROVIDER_MAX_FRAME_BYTES) {
            finish(invalidResponse("Fx returned an invalid launch-provider frame"))
            return
          }
        }
        if (expected === null || input.byteLength < expected + 4) return
        if (input.byteLength !== expected + 4) {
          finish(invalidResponse("Fx returned trailing launch-provider bytes"))
          return
        }
        complete = input.subarray(4)
      })
      connection.once("error", (error: NodeJS.ErrnoException) => {
        if (socket === connection) socket = null
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") retry = setTimeout(connect, 10)
        else finish(new FxLaunchProviderError("unavailable", `cannot reach Fx launch provider: ${error.message}`))
      })
      connection.once("close", () => {
        if (settled) return
        // Connection refusal schedules a fresh attempt; its close event is
        // not a provider response EOF.
        if (socket !== connection) return
        if (complete) finish(undefined, complete)
        else finish(invalidResponse("Fx closed launch provider without a complete response"))
      })
    }
    timer = setTimeout(() => finish(new FxLaunchProviderError("timeout", "Fx launch provider did not answer before its deadline")), timeoutMs)
    connect()
  })
}

async function awaitHelper(helper: FxLaunchProviderHelper, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const exit = await Promise.race([
    helper.exited,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FxLaunchProviderError("timeout", "Fx launch provider did not exit")), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
  if (exit !== 0) throw new FxLaunchProviderError("helper_exited", `Fx launch provider exited with status ${exit}`)
}

function decodeResponse(bytes: Uint8Array, instanceId: string, requestId: string): Record<string, unknown> {
  let value: JsonValue
  try {
    value = decodeStrictJson(bytes)
  } catch {
    throw invalidResponse("Fx returned invalid launch-provider JSON")
  }
  if (!Buffer.from(encodeCanonicalJson(value)).equals(Buffer.from(bytes)) || !isRecord(value) ||
    value.schema_id !== FX_LAUNCH_PROVIDER_SCHEMA_ID || value.schema_version !== FX_LAUNCH_PROVIDER_SCHEMA_VERSION ||
    value.instance_id !== instanceId || value.request_id !== requestId || typeof value.ok !== "boolean") {
    throw invalidResponse("Fx returned an uncorrelated launch-provider response")
  }
  if (!value.ok) {
    assertExactKeys(value, ["schema_id", "schema_version", "instance_id", "request_id", "ok", "error"], "error response")
    if (!isRecord(value.error) || Object.keys(value.error).length !== 1 || typeof value.error.code !== "string") {
      throw invalidResponse("Fx returned an invalid launch-provider error")
    }
    throw new FxLaunchProviderError(value.error.code, `Fx launch provider rejected the request: ${value.error.code}`)
  }
  assertExactKeys(value, ["schema_id", "schema_version", "instance_id", "request_id", "ok", "result"], "success response")
  if (!isRecord(value.result)) throw invalidResponse("Fx returned an invalid launch-provider result")
  return value.result
}

function decodeInvocationEnvironment(value: Record<string, unknown>, input: Correlation): Record<string, string> {
  const required = [
    "FX_INTERNAL_LAUNCH_STATE_ROOT",
    "FX_INTERNAL_LAUNCH_ADMISSION_KEY",
    "FX_INTERNAL_LAUNCH_DIGEST",
    "FX_INTERNAL_LAUNCH_ID",
    "FX_INTERNAL_LAUNCH_CONVERSATION_ID",
  ]
  const allowed = new Set([...required, "FX_MODEL", "FX_EFFORT"])
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => typeof value[key] !== "string") ||
    ["FX_MODEL", "FX_EFFORT"].some((key) => value[key] !== undefined && typeof value[key] !== "string")) {
    throw invalidResponse("Fx returned an invalid build environment")
  }
  if (value.FX_INTERNAL_LAUNCH_STATE_ROOT !== input.stateRoot || value.FX_INTERNAL_LAUNCH_ADMISSION_KEY !== input.admissionKey ||
    value.FX_INTERNAL_LAUNCH_DIGEST !== input.launchDigest || value.FX_INTERNAL_LAUNCH_ID !== input.launchId) {
    throw invalidResponse("Fx returned a build for another launch")
  }
  return Object.fromEntries(Object.entries(value) as [string, string][])
}

function publicPayload(message: FxLaunchAdmissionFinalMessage, expected: FxLaunchAdmissionFinalMessage["message_type"]): string {
  if (message.message_type !== expected) throw new FxLaunchProviderError("invalid_request", `expected ${expected} public message`)
  return Buffer.from(encodeAgentWorkplacePayload(message)).toString("utf8")
}

function publicResult(value: unknown, expected: string): FxLaunchAdmissionFinalMessage {
  if (typeof value !== "string") throw invalidResponse("Fx returned a non-string public payload")
  let message: FxLaunchAdmissionFinalMessage
  try {
    message = decodeAgentWorkplacePayload(Buffer.from(value)) as FxLaunchAdmissionFinalMessage
  } catch {
    throw invalidResponse("Fx returned an invalid frozen public payload")
  }
  if (message.message_type !== expected) throw invalidResponse(`Fx returned ${message.message_type} where ${expected} was required`)
  return message
}

async function cleanupEndpoint(directory: string, socketPath: string): Promise<void> {
  try {
    const socket = await lstat(socketPath)
    if (socket.isSocket()) await unlink(socketPath)
  } catch {
    // Fx normally removes both; absent or non-socket paths are never unlinked.
  }
  try {
    await rmdir(directory)
  } catch {
    // Never recursively remove a directory after a helper or attacker altered it.
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw invalidResponse(`Fx returned unknown or missing fields in ${label}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidResponse(message: string): FxLaunchProviderError {
  return new FxLaunchProviderError("invalid_response", message)
}
