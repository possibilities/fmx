import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import {
  encodeRuntimeBridgeRequest,
  type RuntimeBridgeServerMessage,
} from "../src/runtime-bridge-protocol.ts"
import { RuntimeBridge } from "../src/runtime-bridge.ts"
import {
  ControlFailure,
  type ControlMethod,
  type ControlSurface,
} from "../src/control-protocol.ts"
import { RuntimeClient, RuntimeRequestError } from "../src/runtime-client.ts"

function socketPath(name: string): string {
  return `/tmp/fmx-bridge-test-${name}-${process.pid}.bus`
}

type Call = { method: ControlMethod; params: Record<string, unknown>; signal: AbortSignal }

function surface(answer: (call: Call) => Promise<unknown>): ControlSurface & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    handle: (method, params, signal) => {
      const call = { method, params, signal }
      calls.push(call)
      return answer(call)
    },
  }
}

async function peer(path: string, initial: string | null = null) {
  const messages: RuntimeBridgeServerMessage[] = []
  const decoder = new TextDecoder()
  let pending = ""
  const closed = Promise.withResolvers<void>()
  const connection = await Bun.connect({
    unix: path,
    socket: {
      open: (socket) => {
        if (initial !== null) socket.write(initial)
      },
      data: (_socket, data) => {
        pending += decoder.decode(data, { stream: true })
        for (;;) {
          const newline = pending.indexOf("\n")
          if (newline === -1) break
          messages.push(JSON.parse(pending.slice(0, newline)) as RuntimeBridgeServerMessage)
          pending = pending.slice(newline + 1)
        }
      },
      close: () => closed.resolve(),
      error: () => closed.resolve(),
      connectError: () => closed.resolve(),
    },
  })
  return { connection, messages, closed: closed.promise }
}

test("serves one private correlated request and then closes", async () => {
  const fake = surface(async ({ method, params }) => ({ method, params }))
  const socket = new RuntimeBridge(fake, socketPath("request"))
  socket.start()
  const connection = await peer(
    socket.path,
    encodeRuntimeBridgeRequest({ id: "one", method: "work.snapshot", params: { target: "current" } }),
  )
  try {
    expect(statSync(socket.path).mode & 0o777).toBe(0o600)
    await waitFor(() => connection.messages.length === 1)
    await connection.closed
    expect(connection.messages[0]).toEqual({
      schema_version: 1,
      type: "response",
      id: "one",
      ok: true,
      result: { method: "work.snapshot", params: { target: "current" } },
    })
    expect(fake.calls.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "work.snapshot", params: { target: "current" } },
    ])
  } finally {
    connection.connection.end()
    socket.close()
  }
  expect(existsSync(socket.path)).toBe(false)
})

test("carries control failures through RuntimeClient", async () => {
  const socket = new RuntimeBridge(
    surface(async () => {
      throw new ControlFailure("busy", "the queue editor is visible", { fx_code: "queue_editor_visible" })
    }),
    socketPath("failure"),
  )
  socket.start()
  try {
    const error = await new RuntimeClient({ env: { FMX_SOCKET_PATH: socket.path } })
      .request("work.interrupt", { target: "current" }, new AbortController().signal)
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(RuntimeRequestError)
    expect((error as RuntimeRequestError).error).toEqual({
      code: "busy",
      message: "the queue editor is visible",
      data: { fx_code: "queue_editor_visible" },
    })
  } finally {
    socket.close()
  }
})

test("rejects observation subscriptions and multiple requests", async () => {
  const fake = surface(async () => ({ unreachable: true }))
  const socket = new RuntimeBridge(fake, socketPath("protocol"))
  socket.start()
  const subscription = await peer(socket.path, '{"schema_version":1,"type":"subscribe"}\n')
  const doubled = await peer(
    socket.path,
    encodeRuntimeBridgeRequest({ id: "one", method: "orient", params: {} }) +
      encodeRuntimeBridgeRequest({ id: "two", method: "orient", params: {} }),
  )
  try {
    await waitFor(() => subscription.messages.length === 1 && doubled.messages.length === 1)
    expect(subscription.messages[0]).toMatchObject({ type: "error", error: { code: "invalid_request" } })
    expect(doubled.messages[0]).toMatchObject({
      type: "error",
      error: { code: "invalid_request", message: "one request is allowed per connection" },
    })
    expect(fake.calls).toEqual([])
  } finally {
    subscription.connection.end()
    doubled.connection.end()
    socket.close()
  }
})

test("aborts a pending Runtime request when its peer leaves", async () => {
  let serverSignal: AbortSignal | null = null
  const started = Promise.withResolvers<void>()
  const fake = surface(
    ({ signal }) => new Promise((_resolve, reject) => {
      serverSignal = signal
      started.resolve()
      signal.addEventListener(
        "abort",
        () => reject(new ControlFailure("cancelled", "cancelled")),
        { once: true },
      )
    }),
  )
  const socket = new RuntimeBridge(fake, socketPath("abort"))
  socket.start()
  const connection = await peer(
    socket.path,
    encodeRuntimeBridgeRequest({ id: "held", method: "orient", params: {} }),
  )
  try {
    await started.promise
    connection.connection.end()
    await waitFor(() => serverSignal?.aborted === true)
  } finally {
    socket.close()
  }
})

test("bounds silent connections, message size, and total connections", async () => {
  const socket = new RuntimeBridge(surface(async () => ({ ok: true })), socketPath("bounds"), {
    firstMessageTimeoutMs: 20,
    maxConnections: 1,
    maxMessageChars: 64,
  })
  socket.start()
  const silent = await peer(socket.path)
  const refused = await peer(socket.path, encodeRuntimeBridgeRequest({ id: "refused", method: "orient", params: {} }))
  try {
    await Promise.all([silent.closed, refused.closed])
    expect(refused.messages).toEqual([])

    const oversized = await peer(socket.path, `${"x".repeat(65)}\n`)
    await waitFor(() => oversized.messages.length === 1)
    expect(oversized.messages[0]).toMatchObject({
      type: "error",
      error: { code: "invalid_request", message: "Runtime bridge request is too large" },
    })
    oversized.connection.end()
  } finally {
    silent.connection.end()
    refused.connection.end()
    socket.close()
  }
})

test("clears retired socket residue only when the bridge starts", async () => {
  const path = socketPath("residue")
  const stem = path.slice(0, -4)
  await writeFile(`${stem}.ctl`, "stale")
  await writeFile(`${stem}.obs`, "stale")
  const socket = new RuntimeBridge(surface(async () => null), path)
  try {
    socket.start()
    expect(existsSync(`${stem}.ctl`)).toBe(false)
    expect(existsSync(`${stem}.obs`)).toBe(false)
  } finally {
    socket.close()
  }
})

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(1)
  }
}
