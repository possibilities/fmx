import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { join } from "node:path"
import { expect, test } from "bun:test"
import {
  encodeAgentWorkplacePayload,
  type FxLaunchAdmissionFinalMessage,
} from "../src/agentworkplace-contracts.ts"
import { decodeStrictJson, encodeCanonicalJson } from "../src/contract-codec.ts"
import {
  encodeLaunchControls,
  FxLaunchProviderClient,
  FxLaunchProviderError,
  type FxAdmissionCancelRequest,
  type FxFinalReceiptAcknowledgement,
  type FxLaunchReceipt,
  type FxLaunchRequest,
  type FxLaunchProviderHelper,
  type FxLaunchProviderHelperRequest,
} from "../src/fx-launch-provider.ts"

const DIGEST = "a".repeat(64)
const CORRELATION = {
  stateRoot: "/tmp/fmx-launch-provider-state",
  admissionKey: "admission-a",
  launchDigest: DIGEST,
  launchId: "launch-a",
}
const launchRequest = {
  schema_id: "fx.launch-admission-final",
  schema_version: 1,
  message_type: "launch_request",
  request_id: "prepare-a",
  launch_id: CORRELATION.launchId,
  launch_digest: CORRELATION.launchDigest,
  admission_key: CORRELATION.admissionKey,
  conversation_name: "Launch provider test",
  resume: { mode: "fresh" as const },
  state_root: CORRELATION.stateRoot,
  directory: "/tmp/fmx-launch-provider-worktree",
  initial_work_digest: "b".repeat(64),
  remaining_launch_controls_digest: "c".repeat(64),
} satisfies FxLaunchRequest

const launchReceipt = {
  schema_id: "fx.launch-admission-final",
  schema_version: 1,
  message_type: "launch_receipt",
  request_id: launchRequest.request_id,
  receipt_id: "receipt-a",
  launch_id: CORRELATION.launchId,
  launch_digest: CORRELATION.launchDigest,
  admission_key: CORRELATION.admissionKey,
  status: "accepted" as const,
} satisfies FxLaunchReceipt

function publicPayload(message: FxLaunchAdmissionFinalMessage): string {
  return Buffer.from(encodeAgentWorkplacePayload(message)).toString("utf8")
}

test("uses one private helper endpoint per operation and maps every happy-path result", async () => {
  await withRuntime(async (runtimeDirectory) => {
    const observed: Record<string, unknown>[] = []
    const client = new FxLaunchProviderClient({
      executable: "/resolved/fmx-fx",
      runtimeDirectory,
      launchHelper: fakeProvider((request) => {
        observed.push(request)
        return successFor(request)
      }),
    })
    const controls = [
      "--context-limit", "skill_chunk_bytes=4096", "--tool", "read",
      "--permission-mode", "auto",
    ]
    const digest = createHash("sha256").update(encodeLaunchControls(controls)).digest("hex")
    const launch = { ...launchRequest, remaining_launch_controls_digest: digest }
    expect((await client.prepare(launch)).receipt_id).toBe("receipt-a")
    const built = await client.build({ ...CORRELATION, mode: "initial", remainingGlobalArgs: controls, remainingLaunchControlsDigest: digest })
    expect(built).toEqual({
      command: ["--state-dir", CORRELATION.stateRoot, "--name", "Launch provider test", ...controls],
      cwd: launchRequest.directory,
      env: {
        FX_INTERNAL_LAUNCH_STATE_ROOT: CORRELATION.stateRoot,
        FX_INTERNAL_LAUNCH_ADMISSION_KEY: CORRELATION.admissionKey,
        FX_INTERNAL_LAUNCH_DIGEST: CORRELATION.launchDigest,
        FX_INTERNAL_LAUNCH_ID: CORRELATION.launchId,
        FX_INTERNAL_LAUNCH_CONVERSATION_ID: "conversation-a",
      },
      conversationId: "conversation-a",
      mode: "initial",
    })
    expect((await client.inspect(CORRELATION)).decision).toBeNull()
    expect(await client.resumeStatus(CORRELATION)).toMatchObject({
      status: "unavailable",
      semanticDecision: "exact_resume_unavailable",
      conversationId: "conversation-a",
    })
    const cancellation = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "admission_cancel_request",
      request_id: "cancel-a",
      launch_id: CORRELATION.launchId,
      launch_digest: CORRELATION.launchDigest,
      admission_key: CORRELATION.admissionKey,
    } satisfies FxAdmissionCancelRequest
    expect((await client.cancel(CORRELATION.stateRoot, cancellation)).launchReceipt.receipt_id).toBe("receipt-a")
    const final = await client.recordFinal(CORRELATION, "2026-08-30T20:00:00.000Z", { kind: "exited", code: 0 })
    expect(final.finalReceipt?.conversation_id).toBe("conversation-a")
    const acknowledgement = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "final_receipt_acknowledgement",
      acknowledgement_id: "ack-a",
      receipt_id: "final-a",
      receipt_digest: "d".repeat(64),
      launch_id: CORRELATION.launchId,
      launch_digest: CORRELATION.launchDigest,
      admission_key: CORRELATION.admissionKey,
      conversation_id: "conversation-a",
    } satisfies FxFinalReceiptAcknowledgement
    expect((await client.acknowledgeFinal(CORRELATION.stateRoot, acknowledgement)).finalAcknowledgementId).toBe("ack-a")
    expect(observed.map((request) => request.operation)).toEqual([
      "prepare", "build", "inspect", "resume_status", "cancel", "record_final",
      "acknowledge_final",
    ])
    expect(new Set(observed.map((request) => request.instance_id)).size).toBe(observed.length)
    expect(observed.every((request) => request.schema_id === "fx.private-launch-provider")).toBe(true)
    expect(observed.find((request) => request.operation === "build")?.launch_controls)
      .toBe(encodeLaunchControls(controls))
    expect(observed.find((request) => request.operation === "resume_status")?.schema_version).toBe(2)
    expect(observed.filter((request) => request.operation !== "resume_status").every(
      (request) => request.schema_version === 1,
    )).toBe(true)
  })
})

test("rejects malformed, oversized, trailing, and uncorrelated provider responses", async () => {
  for (const kind of ["malformed", "oversized", "trailing", "uncorrelated"] as const) {
    await withRuntime(async (runtimeDirectory) => {
      const client = new FxLaunchProviderClient({
        executable: "/resolved/fmx-fx",
        runtimeDirectory,
        launchHelper: fakeProvider((request) => invalidResponse(kind, request)),
      })
      const error = await client.prepare(launchRequest).catch((caught) => caught)
      expect(error).toBeInstanceOf(FxLaunchProviderError)
      expect(error).toMatchObject({ code: "invalid_response" })
    })
  }
})

test("keeps incomplete or corrupt exact-resume state as a v2 error, never semantic absence", async () => {
  for (const code of ["SessionStateIncomplete", "SessionStateCorrupt"]) {
    await withRuntime(async (runtimeDirectory) => {
      const client = new FxLaunchProviderClient({
        executable: "/resolved/fmx-fx",
        runtimeDirectory,
        launchHelper: fakeProvider((request) => ({
          kind: "normal",
          value: {
            ...envelope(request),
            ok: false,
            error: { code },
          },
        })),
      })
      const error = await client.resumeStatus(CORRELATION).catch((caught) => caught)
      expect(error).toBeInstanceOf(FxLaunchProviderError)
      expect(error).toMatchObject({ code })
    })
  }
})

test("rejects uncorrelated or forged v2 semantic resume decisions", async () => {
  for (const field of ["conversation_id", "decision_id", "decision_digest"] as const) {
    await withRuntime(async (runtimeDirectory) => {
      const client = new FxLaunchProviderClient({
        executable: "/resolved/fmx-fx",
        runtimeDirectory,
        launchHelper: fakeProvider((request) => {
          const response = successFor(request)
          if (!("value" in response)) return response
          const result = response.value.result as { resume_status: Record<string, unknown> }
          result.resume_status[field] = field === "conversation_id"
            ? "different-conversation"
            : "0".repeat(64)
          return response
        }),
      })
      await expect(client.resumeStatus(CORRELATION)).rejects.toMatchObject({
        code: "invalid_response",
      })
    })
  }
})

test("fails on a helper timeout or early exit and leaves no endpoint directory", async () => {
  await withRuntime(async (runtimeDirectory) => {
    const timeout = new FxLaunchProviderClient({
      executable: "/resolved/fmx-fx",
      runtimeDirectory,
      timeoutMs: 1_000,
      launchHelper: () => ({ exited: new Promise<number>(() => {}), kill: () => {} }),
    })
    await expect(timeout.prepare(launchRequest)).rejects.toMatchObject({ code: "timeout" })
    const exited = new FxLaunchProviderClient({
      executable: "/resolved/fmx-fx",
      runtimeDirectory,
      launchHelper: () => ({ exited: Promise.resolve(9), kill: () => {} }),
    })
    await expect(exited.prepare(launchRequest)).rejects.toMatchObject({ code: "helper_exited" })
    expect((await (await import("node:fs/promises")).readdir(runtimeDirectory)).filter((name) => name.startsWith("launch-provider-")).length).toBe(0)
  })
})

test("matches Fx's controls bounds and allowlist before starting a helper", () => {
  expect(() => encodeLaunchControls(Array.from({ length: 128 }, () => "--no-default-skills"))).not.toThrow()
  expect(() => encodeLaunchControls(Array.from({ length: 129 }, () => "--no-default-skills"))).toThrow(FxLaunchProviderError)
  expect(() => encodeLaunchControls(["--tool", "x".repeat(1024)])).not.toThrow()
  expect(() => encodeLaunchControls(["--tool", "x".repeat(1025)])).toThrow(FxLaunchProviderError)
  const exactLimit = controlsAtExactLimit()
  expect(Buffer.byteLength(encodeLaunchControls(exactLimit))).toBe(128 * 1024)
  expect(() => encodeLaunchControls([...exactLimit.slice(0, -1), `${exactLimit.at(-1)!}x`])).toThrow(FxLaunchProviderError)
  expect(() => encodeLaunchControls(["--state-dir=/tmp/nope"])).toThrow(FxLaunchProviderError)
  expect(() => encodeLaunchControls(["--resume-last"])).toThrow(FxLaunchProviderError)
  expect(() => encodeLaunchControls(["--tool", "-read"])).toThrow(FxLaunchProviderError)
  expect(() => encodeLaunchControls(["--tool=read", "--no-default-skills"])).not.toThrow()
  expect(encodeLaunchControls(["--tool=read", "--no-default-skills"])).toBe(
    '{"remaining_global_args":["--tool=read","--no-default-skills"]}',
  )
})

test("admits and digests one explicit auto permission mode without ambient inference", () => {
  const previous = process.env.FX_PERMISSION_MODE
  process.env.FX_PERMISSION_MODE = "yolo"
  try {
    expect(encodeLaunchControls([])).toBe('{"remaining_global_args":[]}')
    for (const controls of [
      ["--permission-mode", "auto"],
      ["--permission-mode=auto"],
    ]) {
      const encoded = encodeLaunchControls(controls)
      expect(JSON.parse(encoded)).toEqual({ remaining_global_args: controls })
      expect(createHash("sha256").update(encoded).digest("hex")).toHaveLength(64)
    }
  } finally {
    if (previous === undefined) delete process.env.FX_PERMISSION_MODE
    else process.env.FX_PERMISSION_MODE = previous
  }
})

test("rejects every non-auto permission value, missing authority, and duplicates across forms", () => {
  expect(() => encodeLaunchControls(["--permission-mode"])).toThrow(FxLaunchProviderError)
  for (const value of ["", "ask", "yolo", "AUTO", " auto", "auto ", "automatic", "auto=extra"]) {
    for (const controls of [
      ["--permission-mode", value],
      [`--permission-mode=${value}`],
    ]) {
      expect(() => encodeLaunchControls(controls)).toThrow(FxLaunchProviderError)
    }
  }
  for (const controls of [
    ["--permission-mode", "auto", "--permission-mode", "auto"],
    ["--permission-mode=auto", "--permission-mode=auto"],
    ["--permission-mode", "auto", "--permission-mode=auto"],
    ["--permission-mode=auto", "--permission-mode", "auto"],
  ]) {
    expect(() => encodeLaunchControls(controls)).toThrow(FxLaunchProviderError)
  }
})

function controlsAtExactLimit(): string[] {
  const args = Array.from({ length: 128 }, () => "--tool=x")
  let remaining = 128 * 1024 - Buffer.byteLength(encodeLaunchControls(args))
  for (let index = 0; index < args.length && remaining > 0; index++) {
    const available = 1024 - Buffer.byteLength(args[index]!)
    const added = Math.min(available, remaining)
    args[index] += "x".repeat(added)
    remaining -= added
  }
  if (remaining !== 0) throw new Error("test could not construct an exact 128 KiB controls payload")
  return args
}

function fakeProvider(responder: (request: Record<string, unknown>) => FakeResponse | null) {
  return (request: FxLaunchProviderHelperRequest): FxLaunchProviderHelper => {
    const directory = request.environment.FX_INTERNAL_LAUNCH_PROVIDER_DIRECTORY!
    expect(existsSync(directory)).toBe(false)
    mkdirSync(directory, { mode: 0o700 })
    const path = join(directory, "provider.sock")
    const server = createServer()
    let peer: Socket | null = null
    let done = false
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>()
    const finish = (status: number = 0) => {
      if (done) return
      done = true
      peer?.destroy()
      resolveExit(status)
      server.close()
    }
    server.on("connection", (socket) => {
      peer = socket
      receive(socket, (requestFrame) => {
        const response = responder(requestFrame)
        if (!response) return
        if (response.kind === "oversized") {
          const header = Buffer.alloc(4)
          header.writeUInt32BE(1024 * 1024 + 1)
          socket.end(header)
          return
        }
        if (response.kind === "malformed") {
          socket.end(Buffer.from([0, 0, 0, 1, 0xff]))
          return
        }
        if (!("value" in response)) return
        // The provider freezes exact fields and strict JSON, not private-envelope
        // key order. Mirror its deliberately non-canonical success ordering.
        const payload = Buffer.from(JSON.stringify(response.value))
        const header = Buffer.alloc(4)
        header.writeUInt32BE(payload.byteLength, 0)
        socket.end(response.kind === "trailing" ? Buffer.concat([header, payload, Buffer.from("x")]) : Buffer.concat([header, payload]))
      })
      socket.once("close", () => finish())
    })
    server.listen(path)
    return { exited, kill: () => finish(9) }
  }
}

type FakeResponse = { kind: "normal" | "trailing"; value: Record<string, unknown> } | { kind: "malformed" | "oversized" }

function successFor(request: Record<string, unknown>): FakeResponse {
  const response = envelope(request)
  switch (request.operation) {
    case "prepare":
      return { kind: "normal", value: { ...response, result: { launch_receipt: publicPayload(launchReceipt) } } }
    case "build":
      return {
        kind: "normal",
        value: {
          ...response,
          result: {
            arguments: [
              "--state-dir", CORRELATION.stateRoot, "--name", "Launch provider test",
              "--context-limit", "skill_chunk_bytes=4096", "--tool", "read",
              "--permission-mode", "auto",
            ],
            cwd: launchRequest.directory,
            environment: {
              FX_INTERNAL_LAUNCH_STATE_ROOT: CORRELATION.stateRoot,
              FX_INTERNAL_LAUNCH_ADMISSION_KEY: CORRELATION.admissionKey,
              FX_INTERNAL_LAUNCH_DIGEST: CORRELATION.launchDigest,
              FX_INTERNAL_LAUNCH_ID: CORRELATION.launchId,
              FX_INTERNAL_LAUNCH_CONVERSATION_ID: "conversation-a",
            },
            mode: "initial",
          },
        },
      }
    case "record_final":
      return { kind: "normal", value: inspection(response, finalReceipt()) }
    case "acknowledge_final":
      return { kind: "normal", value: inspection(response, null, "ack-a") }
    case "resume_status":
      return { kind: "normal", value: { ...response, result: { resume_status: resumeStatus() } } }
    default:
      return { kind: "normal", value: inspection(response) }
  }
}

function invalidResponse(kind: "malformed" | "oversized" | "trailing" | "uncorrelated", request: Record<string, unknown>): FakeResponse {
  if (kind === "malformed" || kind === "oversized") return { kind }
  const value: Record<string, unknown> = { ...envelope(request), result: { launch_receipt: publicPayload(launchReceipt) } }
  if (kind === "uncorrelated") value.request_id = "different-request"
  return { kind: kind === "uncorrelated" ? "normal" : kind, value }
}

function envelope(request: Record<string, unknown>): Record<string, unknown> {
  return {
    instance_id: request.instance_id,
    ok: true,
    request_id: request.request_id,
    schema_id: "fx.private-launch-provider",
    schema_version: request.schema_version,
  }
}

function resumeStatus() {
  const specification = {
    admission_key: CORRELATION.admissionKey,
    authority: "fx.private-launch-provider/resume-status-v2",
    conversation_id: "conversation-a",
    launch_digest: CORRELATION.launchDigest,
    launch_id: CORRELATION.launchId,
    semantic_decision: "exact_resume_unavailable",
    state_root: CORRELATION.stateRoot,
    status: "unavailable",
  }
  const identity = createHash("sha256").update(encodeCanonicalJson(specification)).digest("hex")
  const decisionId = `resume-status-${identity}`
  return {
    ...specification,
    decision_id: decisionId,
    decision_digest: createHash("sha256").update(encodeCanonicalJson({
      ...specification,
      decision_id: decisionId,
    })).digest("hex"),
  }
}

function inspection(response: Record<string, unknown>, final: FxLaunchAdmissionFinalMessage | null = null, acknowledgement: string | null = null) {
  return {
    ...response,
    result: {
      launch_receipt: publicPayload(launchReceipt),
      decision: null,
      final_receipt: final === null ? null : publicPayload(final),
      final_acknowledgement_id: acknowledgement,
    },
  }
}

function finalReceipt(): Extract<FxLaunchAdmissionFinalMessage, { observed_at: unknown }> {
  return {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "final_receipt",
    receipt_id: "final-a",
    receipt_digest: "d".repeat(64),
    launch_id: CORRELATION.launchId,
    launch_digest: CORRELATION.launchDigest,
    admission_key: CORRELATION.admissionKey,
    conversation_id: "conversation-a",
    outcome: { kind: "exited", code: 0 },
    observed_at: "2026-08-30T20:00:00.000Z",
    retained_until_acknowledged: true,
  }
}

function receive(socket: Socket, callback: (request: Record<string, unknown>) => void): void {
  let input = Buffer.alloc(0)
  socket.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk])
    if (input.byteLength < 4) return
    const length = input.readUInt32BE(0)
    if (input.byteLength !== length + 4) return
    callback(decodeStrictJson(input.subarray(4)) as Record<string, unknown>)
  })
}

async function withRuntime(run: (runtimeDirectory: string) => Promise<void>): Promise<void> {
  // Keep the socket pathname below macOS's ~104-byte AF_UNIX ceiling even
  // when the caller's ordinary TMPDIR is the long /var/folders location.
  const directory = await mkdtemp("/tmp/fmx-launch-provider-")
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
