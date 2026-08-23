import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { AgentSocket, AgentSocketActiveError, defaultSocketPath, listenerAnswers } from "../src/agent-socket.ts"
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
  await socket.start()
  try {
    await run(socket, frames)
  } finally {
    socket.close()
  }
}

test("answers every fx startup message and records each request", async () => {
  await withSocket("startup", async (socket, frames) => {
    for (const payload of FX_STARTUP_PAYLOADS) {
      const reply = await exchange(socket.path, payload)
      expect(JSON.parse(reply)).toEqual({ id: JSON.parse(payload).id, result: {} })
    }

    // One frame per request: the replies are fmx's own and are not reported.
    expect(frames).toHaveLength(FX_STARTUP_PAYLOADS.length)
    expect(frames.map((frame) => frame.method)).toEqual([
      "pane.report_agent_session",
      "pane.report_agent",
      "pane.rename",
      "agent.rename",
    ])
    // agent.rename addresses the pane through `target`, not `pane_id`.
    for (const frame of frames) expect(frame.paneId).toBe("p_1")
    expect(frames.every((frame) => !frame.malformed)).toBe(true)
  })
})

test("keeps the attention label fx sends but herdr discards", async () => {
  await withSocket("blocked", async (socket, frames) => {
    await exchange(socket.path, FX_BLOCKED_PAYLOAD)
    const request = frames[0]
    expect(request?.method).toBe("pane.report_agent")
    expect(JSON.parse(request!.payload).params.custom_status).toBe("permission")
  })
})

test("answers the three-message release fx sends on exit", async () => {
  await withSocket("release", async (socket, frames) => {
    for (const payload of FX_RELEASE_PAYLOADS) await exchange(socket.path, payload)
    expect(frames.map((frame) => frame.method)).toEqual([
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
  await socket.start()
  expect(existsSync(path)).toBe(true)
  socket.close()
  expect(existsSync(path)).toBe(false)
})

test("the default path is stable per Home and user, not per process", () => {
  expect(defaultSocketPath("abc123", 502)).toBe("/tmp/fmx-502-abc123.sock")
  expect(new AgentSocket({ homeId: "abc123" }).path).toBe(defaultSocketPath("abc123"))
})

test("two fmx starting in the same instant: one binds, the other is refused, the socket survives the loser", async () => {
  const path = socketPath("race")
  const a = new AgentSocket({ path })
  const b = new AgentSocket({ path })
  const results = await Promise.allSettled([a.start(), b.start()])
  const refused = results.filter((result) => result.status === "rejected")
  expect(refused).toHaveLength(1)
  expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(AgentSocketActiveError)
  expect(await listenerAnswers(path)).toBe(true)
  // The loser's close must not take the winner's file.
  a.close()
  b.close()
  expect(await listenerAnswers(path)).toBe(false)
  expect(existsSync(path)).toBe(false)
})

test("the lock is held by the process, so a second process is refused without probing", async () => {
  const path = socketPath("lock")
  const first = new AgentSocket({ path })
  await first.start()
  try {
    const probe = Bun.spawnSync([
      "bun",
      "-e",
      `import { AgentSocket } from ${JSON.stringify(new URL("../src/agent-socket.ts", import.meta.url).pathname)}; const s = new AgentSocket({ path: ${JSON.stringify(path)} }); s.start().then(() => { console.log("bound"); s.close() }, (e) => console.log(e.constructor.name))`,
    ])
    expect(probe.stdout.toString().trim()).toBe("AgentSocketActiveError")
    expect(await listenerAnswers(path)).toBe(true)
  } finally {
    first.close()
  }
})

test("a stale socket file is replaced; a live listener is refused and left alone", async () => {
  const path = socketPath("singleton")
  const first = new AgentSocket({ path })
  await first.start()
  try {
    const second = new AgentSocket({ path })
    const refusal = await second.start().catch((error) => error)
    expect(refusal).toBeInstanceOf(AgentSocketActiveError)
    expect(refusal.path).toBe(path)
    // The first is still answering.
    expect(await listenerAnswers(path)).toBe(true)
    second.close()
    expect(existsSync(path)).toBe(true)
    expect(await listenerAnswers(path)).toBe(true)
  } finally {
    first.close()
  }
  expect(await listenerAnswers(path)).toBe(false)

  // What a crashed fmx leaves: a path nothing listens on. Bun unlinks on
  // stop, so the residue is made by a process killed without one.
  const crashed = Bun.spawn(["bun", "-e", `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); setTimeout(() => {}, 10_000)`])
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 10))
  crashed.kill("SIGKILL")
  await crashed.exited
  expect(existsSync(path)).toBe(true)
  expect(await listenerAnswers(path)).toBe(false)
  const third = new AgentSocket({ path })
  await third.start()
  try {
    expect(await listenerAnswers(path)).toBe(true)
  } finally {
    third.close()
  }
})
