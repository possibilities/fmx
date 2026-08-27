import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import type { AgentInfo } from "../src/control-protocol.ts"
import { ObservationHub } from "../src/observation-hub.ts"
import {
  encodeObservationSubscription,
  type ObservationMessage,
  OBSERVATION_SCHEMA_VERSION,
} from "../src/observation-protocol.ts"
import { ObservationSocket } from "../src/observation-socket.ts"
import { record } from "./fixtures/ade-feed.ts"

type WireMessage = ObservationMessage | {
  schema_version: 1
  event: "error"
  error: { code: string; message: string }
}

function path(name: string): string {
  return `/tmp/fmx-obs-${name}-${process.pid}.obs`
}

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
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
    name: "observation-stream",
    session_id: "1772000000000-1772000000000000000-session",
    label: "observation-stream",
    state: "idle",
    attention: null,
    active: true,
    awaiting_work: false,
    subagents: [],
    ...overrides,
  }
}

async function client(socketPath: string, request: string | null) {
  const messages: WireMessage[] = []
  const decoder = new TextDecoder()
  let pending = ""
  const closed = Promise.withResolvers<void>()
  const connection = await Bun.connect({
    unix: socketPath,
    socket: {
      open: (socket) => {
        if (request !== null) socket.write(request)
      },
      data: (_socket, data) => {
        pending += decoder.decode(data, { stream: true })
        for (;;) {
          const newline = pending.indexOf("\n")
          if (newline === -1) break
          messages.push(JSON.parse(pending.slice(0, newline)) as WireMessage)
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

async function waitFor(condition: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await Bun.sleep(1)
  if (!condition()) throw new Error(message)
}

test("publishes a private initial snapshot and deduplicated state changes", async () => {
  const hub = new ObservationHub({ homeId: "home", version: "0.3.0", runtimeId: "runtime", pid: 123 })
  hub.updateState({ active_agent_id: agent().agent_id, agents: [agent()] }, "agent_added")
  const socket = new ObservationSocket(hub, path("state"))
  socket.start()
  const observer = await client(
    socket.path,
    encodeObservationSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  try {
    expect(statSync(socket.path).mode & 0o777).toBe(0o600)
    await waitFor(() => observer.messages.length === 1, "initial observation snapshot did not arrive")
    expect(observer.messages[0]).toMatchObject({
      schema_version: 1,
      runtime: { id: "runtime", home_id: "home", pid: 123, version: "0.3.0" },
      stream_sequence: 1,
      state_revision: 1,
      event: "snapshot",
      cause: "subscribed",
      state: { active_agent_id: agent().agent_id, agents: [{ agent_id: agent().agent_id }] },
    })

    hub.updateState(
      { active_agent_id: agent().agent_id, agents: [agent({ state: "working" })] },
      "lifecycle",
    )
    await waitFor(() => observer.messages.length === 2, "state change did not arrive")
    expect(observer.messages[1]).toMatchObject({
      stream_sequence: 2,
      state_revision: 2,
      event: "state_changed",
      cause: "lifecycle",
      state: { agents: [{ state: "working" }] },
    })

    hub.updateState(
      { active_agent_id: agent().agent_id, agents: [agent({ state: "working" })] },
      "duplicate",
    )
    hub.publishActivity(record("PreToolUse"), agent().agent_id, 1, false)
    await Bun.sleep(10)
    expect(observer.messages).toHaveLength(2)
  } finally {
    observer.connection.end()
    socket.close()
  }
  expect(existsSync(socket.path)).toBe(false)
})

test("filters topics per Observer and redacts activity unless raw payloads were requested", async () => {
  const hub = new ObservationHub({ homeId: "home", version: "0.3.0", runtimeId: "runtime" })
  const socket = new ObservationSocket(hub, path("topics"))
  socket.start()
  const stateOnly = await client(
    socket.path,
    encodeObservationSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  const summarized = await client(
    socket.path,
    encodeObservationSubscription({ schemaVersion: 1, topics: ["activity"], activityPayload: "summary" }),
  )
  const raw = await client(
    socket.path,
    encodeObservationSubscription({ schemaVersion: 1, topics: ["activity"], activityPayload: "raw" }),
  )
  try {
    await waitFor(
      () => [stateOnly, summarized, raw].every((observer) => observer.messages.length === 1),
      "not every Observer received its initial snapshot",
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
    hub.publishActivity(ade, ade.instanceId, 3, true)
    await waitFor(
      () => summarized.messages.length === 2 && raw.messages.length === 2,
      "activity did not reach subscribed Observers",
    )

    expect(stateOnly.messages).toHaveLength(1)
    expect(summarized.messages[1]).toMatchObject({
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

test("answers an invalid subscription once and closes the connection", async () => {
  const hub = new ObservationHub({ homeId: "home", version: "0.3.0" })
  const socket = new ObservationSocket(hub, path("invalid"))
  socket.start()
  const observer = await client(socket.path, '{"schema_version":99}\n')
  try {
    await observer.closed
    expect(observer.messages).toEqual([
      {
        schema_version: OBSERVATION_SCHEMA_VERSION,
        event: "error",
        error: {
          code: "unsupported_schema_version",
          message: "unsupported observation schema: 99",
        },
      },
    ])
  } finally {
    observer.connection.end()
    socket.close()
  }
})

test("drops silent handshakes and subscribers whose bounded queue cannot hold a record", async () => {
  const quietHub = new ObservationHub({ homeId: "home", version: "0.3.0" })
  const quietSocket = new ObservationSocket(quietHub, path("timeout"), { handshakeTimeoutMs: 20 })
  quietSocket.start()
  const quiet = await client(quietSocket.path, null)
  try {
    await quiet.closed
    expect(quiet.messages).toEqual([])
  } finally {
    quiet.connection.end()
    quietSocket.close()
  }

  const boundedHub = new ObservationHub({ homeId: "home", version: "0.3.0" })
  const boundedSocket = new ObservationSocket(boundedHub, path("bounded"), { maxQueueBytes: 16 })
  boundedSocket.start()
  const bounded = await client(
    boundedSocket.path,
    encodeObservationSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  try {
    await bounded.closed
    expect(bounded.messages).toEqual([])
  } finally {
    bounded.connection.end()
    boundedSocket.close()
  }
})

test("bounds concurrent Observers, including connections still in their handshake", async () => {
  const hub = new ObservationHub({ homeId: "home", version: "0.3.0" })
  const socket = new ObservationSocket(hub, path("capacity"), {
    handshakeTimeoutMs: 1_000,
    maxObservers: 1,
  })
  socket.start()
  const first = await client(socket.path, null)
  const refused = await client(
    socket.path,
    encodeObservationSubscription({ schemaVersion: 1, topics: ["state"], activityPayload: "summary" }),
  )
  try {
    await refused.closed
    expect(refused.messages).toEqual([])
  } finally {
    first.connection.end()
    refused.connection.end()
    socket.close()
  }
})

test("derives one stable observation path from ADE, control, or observation paths", () => {
  expect(ObservationSocket.pathFor("/tmp/fmx-501-home.ade.sock")).toBe("/tmp/fmx-501-home.obs")
  expect(ObservationSocket.pathFor("/tmp/custom.sock")).toBe("/tmp/custom.obs")
  expect(ObservationSocket.pathFor("/tmp/fmx-501-home.ctl")).toBe("/tmp/fmx-501-home.obs")
  expect(ObservationSocket.pathFor("/tmp/fmx-501-home.obs")).toBe("/tmp/fmx-501-home.obs")
})
