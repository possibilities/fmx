import { expect, test } from "bun:test"
import { runObservation } from "../src/observation-client.ts"
import { ObservationHub } from "../src/observation-hub.ts"
import { ObservationSocket } from "../src/observation-socket.ts"
import { EXIT_OK, EXIT_UNREACHABLE } from "../src/control-client.ts"
import { record } from "./fixtures/ade-feed.ts"

function controlPath(name: string): string {
  return `/tmp/fmx-observe-client-${name}-${process.pid}.ctl`
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await Bun.sleep(1)
  if (!condition()) throw new Error(message)
}

test("relays the selected Runtime's NDJSON stream with an explicit raw-activity subscription", async () => {
  const explicit = controlPath("relay")
  const hub = new ObservationHub({ homeId: "home", version: "0.3.0", runtimeId: "runtime" })
  const socket = new ObservationSocket(hub, ObservationSocket.pathFor(explicit))
  socket.start()
  let output = ""
  const decoder = new TextDecoder()
  const observing = runObservation(
    { activity: true, rawPayloads: true },
    explicit,
    {
      env: {},
      cwd: "/work",
      write: (data) => {
        output += decoder.decode(data, { stream: true })
      },
    },
  )
  try {
    await waitFor(() => output.split("\n").filter(Boolean).length === 1, "the initial snapshot was not relayed")
    const ade = record("Stop", {
      sequence: 8,
      payload: { assistant_text: "complete raw answer", can_continue: false },
    })
    hub.publishActivity(ade, ade.instanceId, 2, false)
    await waitFor(() => output.split("\n").filter(Boolean).length === 2, "activity was not relayed")
    socket.close()
    expect(await observing).toEqual({ exitCode: EXIT_OK })

    const messages = output.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    expect(messages[0]).toMatchObject({ event: "snapshot", runtime: { id: "runtime" } })
    expect(messages[1]).toMatchObject({
      event: "activity",
      activity: {
        name: "Stop",
        display_id: 2,
        payload_mode: "raw",
        payload: { assistant_text: "complete raw answer", can_continue: false },
      },
    })
  } finally {
    socket.close()
  }
})

test("reports discovery and connection failures as unreachable", async () => {
  const undiscovered = await runObservation(
    { activity: false, rawPayloads: false },
    null,
    { env: {}, cwd: "/work", socketDirectory: "/nonexistent", write: () => {} },
  )
  expect(undiscovered.exitCode).toBe(EXIT_UNREACHABLE)
  expect(undiscovered.error?.message).toContain("not running inside fmx")

  const missing = await runObservation(
    { activity: false, rawPayloads: false },
    controlPath("missing"),
    { env: {}, cwd: "/work", write: () => {} },
  )
  expect(missing.exitCode).toBe(EXIT_UNREACHABLE)
  expect(missing.error?.message).toContain("cannot reach fmx observation stream")
})

test("reports a failed output relay without disturbing the Runtime", async () => {
  const explicit = controlPath("output")
  const hub = new ObservationHub({ homeId: "home", version: "0.3.0" })
  const socket = new ObservationSocket(hub, ObservationSocket.pathFor(explicit))
  socket.start()
  try {
    const outcome = await runObservation(
      { activity: false, rawPayloads: false },
      explicit,
      {
        env: {},
        cwd: "/work",
        write: () => {
          throw new Error("output closed")
        },
      },
    )
    expect(outcome.exitCode).toBe(EXIT_UNREACHABLE)
    expect(outcome.error?.message).toBe("cannot write fmx observation stream: output closed")
  } finally {
    socket.close()
  }
})

test("the fmx binary relays observations without requiring a TTY", async () => {
  const explicit = controlPath("binary")
  const hub = new ObservationHub({ homeId: "home", version: "0.3.0", runtimeId: "binary-runtime" })
  const socket = new ObservationSocket(hub, ObservationSocket.pathFor(explicit))
  socket.start()
  const child = Bun.spawn(
    [process.execPath, "src/index.ts", "observe", "--socket", explicit],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const reader = child.stdout.getReader()
  let output = ""
  try {
    while (!output.includes("\n")) {
      const next = await reader.read()
      if (next.done) throw new Error("fmx observe closed before its initial snapshot")
      output += new TextDecoder().decode(next.value)
    }
    socket.close()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      output += new TextDecoder().decode(next.value)
    }
    expect(await child.exited).toBe(EXIT_OK)
    expect(JSON.parse(output.trim())).toMatchObject({
      event: "snapshot",
      runtime: { id: "binary-runtime" },
    })
    expect(await new Response(child.stderr).text()).toBe("")
  } finally {
    socket.close()
    if (child.exitCode === null) child.kill()
    await child.exited
  }
})
