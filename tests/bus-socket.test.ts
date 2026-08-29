import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import {
  BUS_SCHEMA_VERSION,
  encodeBusRequest,
  encodeBusSubscription,
  type BusServerMessage,
} from "../src/bus-protocol.ts"
import { BusSocket } from "../src/bus-socket.ts"
import {
  afterControlReply,
  ControlFailure,
  type ControlMethod,
  type ControlSurface,
} from "../src/control-protocol.ts"
import { RuntimeBus } from "../src/runtime-bus.ts"
import { RuntimeClient, RuntimeRequestError } from "../src/runtime-client.ts"
import { record } from "./fixtures/ade-feed.ts"

function socketPath(name: string): string {
  return `/tmp/fmx-bus-test-${name}-${process.pid}.bus`
}

function agent() {
  return {
    agent_id: "0123456789abcdef0123456789abcdef",
    id: 1,
    display_id: 1,
    pane_id: "p_0123456789abcdef0123456789abcdef",
    created_at: 1_772_000_000_000,
    cwd: "/workspace/fmx",
    project: "fmx",
    git_root: "/workspace/fmx",
    main_git_root: "/workspace/fmx",
    branch: "main",
    worktree: false,
    name: "runtime-bus",
    session_id: "1772000000000-1772000000000000000-session",
    label: "runtime-bus",
    state: "idle" as const,
    attention: null,
    active: true,
    subagents: [],
  }
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

function runtimeBus() {
  return new RuntimeBus({ homeId: "home", version: "0.3.0", runtimeId: "runtime", pid: 123 })
}

async function peer(path: string, initial: string | null = null) {
  const messages: BusServerMessage[] = []
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
          messages.push(JSON.parse(pending.slice(0, newline)) as BusServerMessage)
          pending = pending.slice(newline + 1)
        }
      },
      close: () => closed.resolve(),
      error: () => closed.resolve(),
      connectError: () => closed.resolve(),
    },
  })
  return {
    connection,
    messages,
    closed: closed.promise,
    send: (message: string) => connection.write(message),
  }
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await Bun.sleep(1)
  if (!condition()) throw new Error(message)
}

test("publishes a private initial snapshot and deduplicated state changes", async () => {
  const bus = runtimeBus()
  bus.updateState({ active_agent_id: agent().agent_id, agents: [agent()] }, "agent_added")
  const socket = new BusSocket(bus, surface(async () => null), socketPath("state"))
  socket.start()
  const subscriber = await peer(
    socket.path,
    encodeBusSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  try {
    expect(statSync(socket.path).mode & 0o777).toBe(0o600)
    await waitFor(() => subscriber.messages.length === 1, "initial Bus snapshot did not arrive")
    expect(subscriber.messages[0]).toMatchObject({
      schema_version: 1,
      type: "event",
      runtime: { id: "runtime", home_id: "home", pid: 123, version: "0.3.0" },
      stream_sequence: 1,
      state_revision: 1,
      event: "snapshot",
      cause: "subscribed",
      state: { active_agent_id: agent().agent_id, agents: [{ agent_id: agent().agent_id }] },
    })

    bus.updateState(
      { active_agent_id: agent().agent_id, agents: [{ ...agent(), state: "working" }] },
      "lifecycle",
    )
    await waitFor(() => subscriber.messages.length === 2, "state change did not arrive")
    expect(subscriber.messages[1]).toMatchObject({
      type: "event",
      stream_sequence: 2,
      state_revision: 2,
      event: "state_changed",
      cause: "lifecycle",
      state: { agents: [{ state: "working" }] },
    })

    bus.updateState(
      { active_agent_id: agent().agent_id, agents: [{ ...agent(), state: "working" }] },
      "duplicate",
    )
    bus.publishActivity(record("PreToolUse"), agent().agent_id, 1, false)
    await Bun.sleep(10)
    expect(subscriber.messages).toHaveLength(2)
  } finally {
    subscriber.connection.end()
    socket.close()
  }
  expect(existsSync(socket.path)).toBe(false)
})

test("filters topics per subscription and redacts activity unless raw payloads were requested", async () => {
  const bus = runtimeBus()
  const socket = new BusSocket(bus, surface(async () => null), socketPath("topics"))
  socket.start()
  const stateOnly = await peer(
    socket.path,
    encodeBusSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  const summarized = await peer(
    socket.path,
    encodeBusSubscription({ schemaVersion: 1, topics: ["activity"], activityPayload: "summary" }),
  )
  const raw = await peer(
    socket.path,
    encodeBusSubscription({ schemaVersion: 1, topics: ["activity"], activityPayload: "raw" }),
  )
  try {
    await waitFor(
      () => [stateOnly, summarized, raw].every((subscriber) => subscriber.messages.length === 1),
      "not every subscription received its initial snapshot",
    )
    const ade = record("PreToolUse", {
      sequence: 4,
      turnId: 9,
      workspaceRoot: "/workspace/fmx",
      payload: {
        step_index: 2,
        call_id: "call-2",
        tool_name: "terminal",
        arguments: { command: "echo secret" },
      },
    })
    bus.publishActivity(ade, ade.instanceId, 3, true)
    await waitFor(
      () => summarized.messages.length === 2 && raw.messages.length === 2,
      "activity did not reach subscriptions",
    )

    expect(stateOnly.messages).toHaveLength(1)
    expect(summarized.messages[1]).toMatchObject({
      type: "event",
      stream_sequence: 2,
      event: "activity",
      activity: {
        name: "PreToolUse",
        display_id: 3,
        gap_before: true,
        payload_mode: "summary",
        payload: { step_index: 2, call_id: "call-2", tool_name: "terminal" },
      },
    })
    expect(raw.messages[1]).toMatchObject({
      type: "event",
      stream_sequence: 2,
      event: "activity",
      activity: {
        payload_mode: "raw",
        payload: { arguments: { command: "echo secret" } },
      },
    })
  } finally {
    stateOnly.connection.end()
    summarized.connection.end()
    raw.connection.end()
    socket.close()
  }
})

test("multiplexes subscriptions and multiple correlated control requests on one connection", async () => {
  const bus = runtimeBus()
  bus.updateState({ active_agent_id: null, agents: [] }, "unchanged")
  const fake = surface(async ({ method }) => {
    if (method === "focus") {
      bus.updateState({ active_agent_id: agent().agent_id, agents: [agent()] }, "active_agent_changed")
      return { focused: true }
    }
    return { method }
  })
  const socket = new BusSocket(bus, fake, socketPath("mixed"))
  socket.start()
  const connection = await peer(
    socket.path,
    encodeBusSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  try {
    await waitFor(() => connection.messages.length === 1, "snapshot did not arrive")
    connection.send(encodeBusRequest({ id: "first", method: "orient", params: { caller: 2 } }))
    connection.send(encodeBusRequest({ id: "second", method: "focus", params: { target: "next" } }))
    await waitFor(
      () => connection.messages.filter((message) => message.type === "response").length === 2,
      "both control responses did not arrive",
    )

    const responses = connection.messages.filter((message) => message.type === "response")
    expect(responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "first", ok: true, result: { method: "orient" } }),
      expect.objectContaining({ id: "second", ok: true, result: { focused: true }, state_revision: 1 }),
    ]))
    expect(connection.messages).toContainEqual(expect.objectContaining({
      type: "event",
      event: "state_changed",
      state_revision: 1,
    }))
    expect(fake.calls.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "orient", params: { caller: 2 } },
      { method: "focus", params: { target: "next" } },
    ])
  } finally {
    connection.connection.end()
    socket.close()
  }
})

test("carries command failures, rejects unknown methods, and keeps the connection usable", async () => {
  const fake = surface(async ({ method }) => {
    if (method === "focus") throw new ControlFailure("busy", "something is open", { surface: { kind: "help" } })
    return { ok: true }
  })
  const socket = new BusSocket(runtimeBus(), fake, socketPath("errors"))
  socket.start()
  const connection = await peer(socket.path)
  try {
    connection.send(encodeBusRequest({ id: "busy", method: "focus", params: { target: "next" } }))
    connection.send(encodeBusRequest({ id: "unknown", method: "pane.kill" as ControlMethod, params: {} }))
    connection.send(encodeBusRequest({ id: "still-open", method: "orient", params: {} }))
    await waitFor(() => connection.messages.length === 3, "control errors did not arrive")
    expect(connection.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "response",
        id: "busy",
        ok: false,
        error: { code: "busy", message: "something is open", data: { surface: { kind: "help" } } },
      }),
      expect.objectContaining({ type: "response", id: "unknown", ok: false, error: expect.objectContaining({ code: "unknown_method" }) }),
      expect.objectContaining({ type: "response", id: "still-open", ok: true }),
    ]))
    expect(fake.calls.map((call) => call.method)).toEqual(["focus", "orient"])
  } finally {
    connection.connection.end()
    socket.close()
  }
})

test("runs an after-response action once the response is delivered", async () => {
  let deliveries = 0
  const socket = new BusSocket(
    runtimeBus(),
    surface(async () => afterControlReply({ delivered: true }, () => deliveries += 1)),
    socketPath("after-response"),
  )
  socket.start()
  try {
    const result = await new RuntimeClient({ env: { FMX_SOCKET_PATH: socket.path } })
      .request("orient", {}, new AbortController().signal)
    expect(result).toEqual({ delivered: true })
    await waitFor(() => deliveries === 1, "after-response action did not run")
  } finally {
    socket.close()
  }
})

test("aborts every pending request when its connection closes", async () => {
  const aborted: string[] = []
  const fake = surface(
    ({ params, signal }) => new Promise(() => {
      signal.addEventListener("abort", () => aborted.push(String(params.name)), { once: true })
    }),
  )
  const socket = new BusSocket(runtimeBus(), fake, socketPath("abort"))
  socket.start()
  const connection = await peer(socket.path)
  connection.send(encodeBusRequest({ id: "one", method: "orient", params: { name: "one" } }))
  connection.send(encodeBusRequest({ id: "two", method: "orient", params: { name: "two" } }))
  await waitFor(() => fake.calls.length === 2, "requests did not start")
  connection.connection.end()
  await waitFor(() => aborted.length === 2, "requests were not aborted")
  expect(aborted.sort()).toEqual(["one", "two"])
  socket.close()
})

test("bounds pending requests per connection without blocking the accepted one", async () => {
  const fake = surface(
    ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new ControlFailure("cancelled", "cancelled")), { once: true })
    }),
  )
  const socket = new BusSocket(runtimeBus(), fake, socketPath("pending-capacity"), {
    maxPendingRequests: 1,
  })
  socket.start()
  const connection = await peer(socket.path)
  try {
    connection.send(encodeBusRequest({ id: "held", method: "orient", params: {} }))
    await waitFor(() => fake.calls.length === 1, "first request did not start")
    connection.send(encodeBusRequest({ id: "extra", method: "orient", params: {} }))
    await waitFor(() => connection.messages.length === 1, "pending-request refusal did not arrive")
    expect(connection.messages[0]).toMatchObject({
      type: "response",
      id: "extra",
      ok: false,
      error: { code: "busy", message: "too many requests are pending on this connection" },
    })
    expect(fake.calls).toHaveLength(1)
  } finally {
    connection.connection.end()
    socket.close()
  }
})

test("subscriber capacity does not consume command-only capacity", async () => {
  const fake = surface(async () => ({ accepted: true }))
  const socket = new BusSocket(runtimeBus(), fake, socketPath("capacity"), {
    maxConnections: 3,
    maxSubscribers: 1,
  })
  socket.start()
  const first = await peer(
    socket.path,
    encodeBusSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  const command = await peer(socket.path, encodeBusRequest({ id: "command", method: "orient", params: {} }))
  const refused = await peer(
    socket.path,
    encodeBusSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  try {
    await waitFor(() => command.messages.length === 1, "command-only peer was blocked")
    expect(command.messages[0]).toMatchObject({ type: "response", id: "command", ok: true })
    await refused.closed
    expect(refused.messages).toEqual([
      {
        schema_version: BUS_SCHEMA_VERSION,
        type: "error",
        error: { code: "capacity", message: "too many bus subscriptions" },
      },
    ])
  } finally {
    first.connection.end()
    command.connection.end()
    refused.connection.end()
    socket.close()
  }
})

test("bounds all Bus connections, including silent peers", async () => {
  const socket = new BusSocket(runtimeBus(), surface(async () => null), socketPath("connection-capacity"), {
    maxConnections: 1,
    firstMessageTimeoutMs: 1_000,
  })
  socket.start()
  const first = await peer(socket.path)
  const refused = await peer(socket.path, encodeBusRequest({ id: "refused", method: "orient", params: {} }))
  try {
    await refused.closed
    expect(refused.messages).toEqual([])
  } finally {
    first.connection.end()
    refused.connection.end()
    socket.close()
  }
})

test("drops silent peers and peers whose bounded queue cannot hold a record", async () => {
  const quietSocket = new BusSocket(runtimeBus(), surface(async () => null), socketPath("timeout"), {
    firstMessageTimeoutMs: 20,
  })
  quietSocket.start()
  const quiet = await peer(quietSocket.path)
  try {
    await quiet.closed
    expect(quiet.messages).toEqual([])
  } finally {
    quiet.connection.end()
    quietSocket.close()
  }

  const boundedSocket = new BusSocket(runtimeBus(), surface(async () => null), socketPath("bounded"), {
    maxQueueBytes: 16,
  })
  boundedSocket.start()
  const bounded = await peer(
    boundedSocket.path,
    encodeBusSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  try {
    await bounded.closed
    expect(bounded.messages).toEqual([])
  } finally {
    bounded.connection.end()
    boundedSocket.close()
  }
})

test("prioritizes a response by evicting queued events under backpressure", async () => {
  const fakeSurface = surface(async () => ({ answered: true }))
  const socket = new BusSocket(runtimeBus(), fakeSurface, socketPath("priority"), {
    maxQueueRecords: 2,
    firstMessageTimeoutMs: 1_000,
  })
  const written: Uint8Array[] = []
  let writable = false
  const fakeConnection = {
    write(data: Uint8Array | string) {
      if (!writable) return 0
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
      written.push(bytes.slice())
      return bytes.byteLength
    },
    end() {},
  }
  const internals = socket as unknown as {
    acceptOpen(connection: typeof fakeConnection): void
    acceptData(connection: typeof fakeConnection, data: Uint8Array): void
    flushFor(connection: typeof fakeConnection): void
  }
  const bytes = (line: string) => new TextEncoder().encode(line)

  internals.acceptOpen(fakeConnection)
  internals.acceptData(
    fakeConnection,
    bytes(encodeBusSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" })),
  )
  internals.acceptData(
    fakeConnection,
    bytes(encodeBusSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" })),
  )
  internals.acceptData(fakeConnection, bytes(encodeBusRequest({ id: "priority", method: "orient", params: {} })))
  await waitFor(() => fakeSurface.calls.length === 1, "control request was not handled")
  await Bun.sleep(0)
  writable = true
  internals.flushFor(fakeConnection)
  const messages = new TextDecoder().decode(Buffer.concat(written)).trim().split("\n").map((line) => JSON.parse(line))
  expect(messages).toEqual([
    expect.objectContaining({ type: "response", id: "priority", ok: true, result: { answered: true } }),
    expect.objectContaining({ type: "event", event: "snapshot", stream_sequence: 2 }),
  ])
  socket.close()
})

test("answers malformed protocol input once and closes the connection", async () => {
  const socket = new BusSocket(runtimeBus(), surface(async () => null), socketPath("invalid"))
  socket.start()
  const connection = await peer(socket.path, '{"schema_version":99,"type":"subscribe"}\n')
  try {
    await connection.closed
    expect(connection.messages).toEqual([
      {
        schema_version: BUS_SCHEMA_VERSION,
        type: "error",
        error: { code: "unsupported_schema_version", message: "unsupported bus schema: 99" },
      },
    ])
  } finally {
    connection.connection.end()
    socket.close()
  }
})

test("a protocol error aborts pending requests and sends no later responses", async () => {
  let aborted = false
  const fake = surface(
    ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true
        reject(new ControlFailure("cancelled", "request cancelled"))
      }, { once: true })
    }),
  )
  const socket = new BusSocket(runtimeBus(), fake, socketPath("invalid-pending"))
  socket.start()
  const connection = await peer(
    socket.path,
    encodeBusRequest({ id: "pending", method: "orient", params: {} }),
  )
  try {
    await waitFor(() => fake.calls.length === 1, "pending request did not start")
    connection.send('{"schema_version":99,"type":"subscribe"}\n')
    await connection.closed
    expect(aborted).toBe(true)
    expect(connection.messages).toEqual([
      {
        schema_version: BUS_SCHEMA_VERSION,
        type: "error",
        error: { code: "unsupported_schema_version", message: "unsupported bus schema: 99" },
      },
    ])
  } finally {
    connection.connection.end()
    socket.close()
  }
})

test("removes retired socket residue when binding and is unreachable after close", async () => {
  const path = socketPath("retired")
  const stem = path.slice(0, -".bus".length)
  await writeFile(`${stem}.ctl`, "")
  await writeFile(`${stem}.obs`, "")
  const socket = new BusSocket(runtimeBus(), surface(async () => null), path)
  socket.start()
  expect(existsSync(`${stem}.ctl`)).toBe(false)
  expect(existsSync(`${stem}.obs`)).toBe(false)
  socket.close()
  await expect(
    new RuntimeClient({ env: { FMX_SOCKET_PATH: path } })
      .request("orient", {}, new AbortController().signal),
  ).rejects.toBeInstanceOf(RuntimeRequestError)
})
