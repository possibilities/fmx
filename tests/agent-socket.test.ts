import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { AgentSocket } from "../src/agent-socket.ts"
import { LineAssembler, type SocketFrame } from "../src/socket-frames.ts"

/**
 * The exact payloads fx writes, in the order it writes them: a session
 * identity and an idle state at startup, the announce pair, a working state
 * when a prompt is queued, a blocked state with an attention label, and the
 * three-message release on exit.
 */
const FX_STARTUP_PAYLOADS = [
  '{"id":"1","method":"pane.report_agent_session","params":{"pane_id":"p_1","source":"custom:fx","agent":"fx","agent_session_id":"sess_abc"}}',
  '{"id":"2","method":"pane.report_agent","params":{"pane_id":"p_1","source":"custom:fx","agent":"fx","state":"idle"}}',
  '{"id":"3","method":"pane.rename","params":{"pane_id":"p_1","label":"fx"}}',
  '{"id":"4","method":"agent.rename","params":{"target":"p_1","name":"fx"}}',
]

const FX_BLOCKED_PAYLOAD =
  '{"id":"9","method":"pane.report_agent","params":{"pane_id":"p_1","source":"custom:fx","agent":"fx","state":"blocked","custom_status":"permission"}}'

const FX_RELEASE_PAYLOADS = [
  '{"id":"10","method":"agent.rename","params":{"target":"p_1","name":null}}',
  '{"id":"11","method":"pane.clear_agent_authority","params":{"pane_id":"p_1","source":"custom:fx"}}',
  '{"id":"12","method":"pane.rename","params":{"pane_id":"p_1","label":null}}',
]

function socketPath(name: string): string {
  return `/tmp/fmx-test-${name}-${process.pid}.sock`
}

/** One request per connection, exactly as fx does it: write, read one line, close. */
async function exchange(path: string, payload: string): Promise<string> {
  const assembler = new LineAssembler()
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const timeout = setTimeout(() => reject(new Error("no reply within 250ms")), 250)

  const connection = await Bun.connect({
    unix: path,
    socket: {
      open: (socket) => {
        socket.write(`${payload}\n`)
      },
      data: (_socket, data) => {
        const [line] = assembler.push(new TextDecoder().decode(data))
        if (line !== undefined) {
          clearTimeout(timeout)
          resolve(line)
        }
      },
      error: (_socket, error) => {
        clearTimeout(timeout)
        reject(error)
      },
    },
  })

  try {
    return await promise
  } finally {
    connection.end()
  }
}

async function withSocket(
  name: string,
  run: (socket: AgentSocket, frames: SocketFrame[]) => Promise<void>,
): Promise<void> {
  const frames: SocketFrame[] = []
  const socket = new AgentSocket({ path: socketPath(name) })
  socket.addFrameListener((frame) => frames.push(frame))
  socket.start()
  try {
    await run(socket, frames)
  } finally {
    socket.close()
  }
}

test("answers every fx startup message and records both directions", async () => {
  await withSocket("startup", async (socket, frames) => {
    for (const payload of FX_STARTUP_PAYLOADS) {
      const reply = await exchange(socket.path, payload)
      expect(JSON.parse(reply)).toEqual({ id: JSON.parse(payload).id, result: {} })
    }

    expect(frames).toHaveLength(FX_STARTUP_PAYLOADS.length * 2)
    expect(frames.map((frame) => frame.direction)).toEqual(["in", "out", "in", "out", "in", "out", "in", "out"])
    expect(frames.filter((frame) => frame.direction === "in").map((frame) => frame.method)).toEqual([
      "pane.report_agent_session",
      "pane.report_agent",
      "pane.rename",
      "agent.rename",
    ])
    // agent.rename addresses the pane through `target`, not `pane_id`.
    for (const frame of frames.filter((frame) => frame.direction === "in")) {
      expect(frame.paneId).toBe("p_1")
    }
    expect(frames.every((frame) => !frame.malformed)).toBe(true)
  })
})

test("keeps the attention label fx sends but herdr discards", async () => {
  await withSocket("blocked", async (socket, frames) => {
    await exchange(socket.path, FX_BLOCKED_PAYLOAD)
    const request = frames.find((frame) => frame.direction === "in")
    expect(request?.method).toBe("pane.report_agent")
    expect(JSON.parse(request!.payload).params.custom_status).toBe("permission")
  })
})

test("answers the three-message release fx sends on exit", async () => {
  await withSocket("release", async (socket, frames) => {
    for (const payload of FX_RELEASE_PAYLOADS) await exchange(socket.path, payload)
    expect(frames.filter((frame) => frame.direction === "in").map((frame) => frame.method)).toEqual([
      "agent.rename",
      "pane.clear_agent_authority",
      "pane.rename",
    ])
  })
})

test("answers a malformed line instead of leaving fx waiting out its timeout", async () => {
  await withSocket("malformed", async (socket, frames) => {
    const reply = await exchange(socket.path, "not json at all")
    expect(JSON.parse(reply).error.code).toBe("invalid_request")
    expect(frames[0]?.malformed).toBe(true)
    expect(frames[0]?.method).toBeNull()
  })
})

test("removes its socket file on close", async () => {
  const path = socketPath("cleanup")
  const socket = new AgentSocket({ path })
  socket.start()
  expect(existsSync(path)).toBe(true)
  socket.close()
  expect(existsSync(path)).toBe(false)
})

test("mints an opaque pane id per instance", () => {
  const socket = new AgentSocket({ path: socketPath("pane-ids") })
  expect(socket.paneIdFor(1)).toBe("p_1")
  expect(socket.paneIdFor(12)).toBe("p_12")
})
