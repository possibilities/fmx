import { expect, test } from "bun:test"
import { createServer, type Socket } from "node:net"
import { lstat, rm } from "node:fs/promises"
import {
  FxWorkControlClient,
  FxWorkControlError,
  fxWorkControlSocketPath,
  mintFxWorkControlBinding,
  removeFxWorkControlResidue,
  type FxWorkControlBinding,
} from "../src/fx-work-control.ts"

const SNAPSHOT = {
  active_turn_id: "41",
  queue_paused: false,
  queue: [{
    turn_id: "42",
    kind: "steering" as const,
    text: "next work",
    has_images: false,
    has_skill_bindings: false,
    has_review_draft: false,
  }],
}

test("mints one private authority and a short per-Agent socket path", () => {
  const agentId = "0123456789abcdef0123456789abcdef"
  expect(fxWorkControlSocketPath("/tmp/fmx-user/home.bus", agentId))
    .toBe(`/tmp/fmx-user/home.${agentId}.fx`)
  const binding = mintFxWorkControlBinding("/tmp/fmx-user/home.bus", agentId)
  expect(binding).toMatchObject({ socketPath: `/tmp/fmx-user/home.${agentId}.fx`, instanceId: agentId })
  expect(binding.token).toMatch(/^[0-9a-f]{64}$/u)
})

test("removes only the exact socket of an Agent proven dead", async () => {
  const runtimePath = `/tmp/fmx-fx-work-control-residue-${process.pid}.bus`
  const binding = mintFxWorkControlBinding(runtimePath, "0123456789abcdef0123456789abcdef")
  await rm(binding.socketPath, { force: true })
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(binding.socketPath, resolve)
  })
  try {
    expect(await removeFxWorkControlResidue(binding, runtimePath)).toBe(true)
    expect(await unixSocketExists(binding.socketPath)).toBe(false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  await Bun.write(binding.socketPath, "not an Fx socket")
  try {
    expect(await removeFxWorkControlResidue(binding, runtimePath)).toBe(false)
    expect(await Bun.file(binding.socketPath).exists()).toBe(true)
    expect(await removeFxWorkControlResidue(
      { ...binding, socketPath: `${binding.socketPath}.other` },
      runtimePath,
    )).toBe(false)
  } finally {
    await rm(binding.socketPath, { force: true })
  }
})

test("sends one authenticated framed request and decodes a partial admission response", async () => {
  const binding = testBinding("success")
  let request: Record<string, unknown> = {}
  await withServer(binding, (socket, received) => {
    request = received
    const payload = Buffer.from(JSON.stringify({
      schema: 1,
      request_id: received.request_id,
      instance_id: binding.instanceId,
      ok: true,
      result: { turn_id: "42", disposition: "steering", snapshot: SNAPSHOT },
    }))
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.byteLength)
    socket.write(header.subarray(0, 2))
    socket.write(Buffer.concat([header.subarray(2), payload.subarray(0, 11)]))
    socket.write(payload.subarray(11))
  }, async () => {
    const result = await new FxWorkControlClient().request(
      binding,
      "work.steer",
      { text: "change course" },
      new AbortController().signal,
    )
    expect(result).toEqual({ turn_id: "42", disposition: "steering", snapshot: SNAPSHOT })
  })
  expect(request).toMatchObject({
    schema: 1,
    instance_id: binding.instanceId,
    token: binding.token,
    method: "work.steer",
    params: { text: "change course" },
  })
  expect(typeof request.request_id).toBe("string")
})

test("preserves Fx semantic errors and rejects uncorrelated responses", async () => {
  const rejected = testBinding("rejected")
  await withServer(rejected, (socket, request) => {
    respond(socket, {
      schema: 1,
      request_id: request.request_id,
      instance_id: rejected.instanceId,
      ok: false,
      error: { code: "queue_editor_visible", message: "the human queue editor is visible" },
    })
  }, async () => {
    const error = await new FxWorkControlClient().request(
      rejected,
      "work.interrupt",
      {},
      new AbortController().signal,
    ).catch((caught) => caught)
    expect(error).toBeInstanceOf(FxWorkControlError)
    expect(error).toMatchObject({ code: "queue_editor_visible", message: "the human queue editor is visible" })
  })

  const mismatched = testBinding("mismatch")
  await withServer(mismatched, (socket) => {
    respond(socket, {
      schema: 1,
      request_id: "someone-else",
      instance_id: mismatched.instanceId,
      ok: true,
      result: { snapshot: SNAPSHOT },
    })
  }, async () => {
    const error = await new FxWorkControlClient().request(
      mismatched,
      "work.snapshot",
      {},
      new AbortController().signal,
    ).catch((caught) => caught)
    expect(error).toMatchObject({ code: "invalid_response" })
  })
})

test("honors cancellation before opening a socket", async () => {
  const abort = new AbortController()
  abort.abort()
  const error = await new FxWorkControlClient().request(
    testBinding("cancelled"),
    "work.snapshot",
    {},
    abort.signal,
  ).catch((caught) => caught)
  expect(error).toMatchObject({ code: "cancelled" })
})

function testBinding(name: string): FxWorkControlBinding {
  return {
    socketPath: `/tmp/fmx-fx-work-control-test-${name}-${process.pid}.sock`,
    instanceId: "0123456789abcdef0123456789abcdef",
    token: "ab".repeat(32),
  }
}

async function withServer(
  binding: FxWorkControlBinding,
  answer: (socket: Socket, request: Record<string, unknown>) => void,
  run: () => Promise<void>,
): Promise<void> {
  await rm(binding.socketPath, { force: true })
  const server = createServer((socket) => {
    let input = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      input = Buffer.concat([input, bytes])
      if (input.byteLength < 4) return
      const expected = input.readUInt32BE(0)
      if (input.byteLength < expected + 4) return
      answer(socket, JSON.parse(input.subarray(4, expected + 4).toString("utf8")) as Record<string, unknown>)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(binding.socketPath, resolve)
  })
  try {
    await run()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(binding.socketPath, { force: true })
  }
}

function respond(socket: Socket, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.byteLength)
  socket.write(Buffer.concat([header, payload]))
}

async function unixSocketExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSocket()
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}
