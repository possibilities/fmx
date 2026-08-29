import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeBridge } from "../src/runtime-bridge.ts"
import { ControlFailure, type ControlMethod } from "../src/control-protocol.ts"
import {
  resolveRuntimePath,
  RuntimeClient,
  RuntimeRequestError,
} from "../src/runtime-client.ts"

test("resolves the Agent's Runtime or the sole live Runtime outside one", async () => {
  expect(await resolveRuntimePath({ env: { FMX_SOCKET_PATH: "/tmp/home.ctl" } })).toBe("/tmp/home.bus")

  const directory = await mkdtemp(join(tmpdir(), "fmx-runtime-client-"))
  const first = join(directory, "0123456789ab.bus")
  const second = join(directory, "ba9876543210.bus")
  await writeFile(first, "")
  await writeFile(second, "")
  await writeFile(join(directory, "not-a-home.bus"), "")
  const live = new Set([first])
  const environment = {
    env: {},
    socketDirectory: directory,
    isSocketLive: async (path: string) => live.has(path),
  }

  try {
    expect(await resolveRuntimePath(environment)).toBe(first)
    live.add(second)
    await expect(resolveRuntimePath(environment)).rejects.toThrow("more than one Runtime")
    live.clear()
    await expect(resolveRuntimePath(environment)).rejects.toThrow("no fmx is running")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("adds caller context and opens a working short-lived request connection", async () => {
  const calls: { method: ControlMethod; params: Record<string, unknown> }[] = []
  const socket = new RuntimeBridge(
    {
      handle: async (method, params) => {
        calls.push({ method, params })
        return { oriented: true }
      },
    },
    `/tmp/fmx-runtime-client-caller-${process.pid}.bus`,
  )
  socket.start()

  try {
    const result = await new RuntimeClient({
      env: { FMX_SOCKET_PATH: socket.path, FMX_AGENT_ID: "4" },
    }).request("orient", {}, new AbortController().signal)
    expect(result).toEqual({ oriented: true })
    expect(calls).toEqual([{ method: "orient", params: { caller: 4 } }])
  } finally {
    socket.close()
  }
})

test("carries MCP-sized requests and responses beyond the small event-line bound", async () => {
  // The raw work remains beneath Fx's 1 MiB limit while its JSON request is
  // larger than the bridge's retired 2 MiB event-oriented bound.
  const text = "\0".repeat(400 * 1024)
  const returned = "x".repeat(128 * 1024)
  const socket = new RuntimeBridge(
    {
      handle: async (method, params) => ({
        method,
        received_length: typeof params.text === "string" ? params.text.length : null,
        returned,
      }),
    },
    `/tmp/fmx-runtime-client-large-${process.pid}.bus`,
  )
  socket.start()

  try {
    const result = await new RuntimeClient({ env: { FMX_SOCKET_PATH: socket.path } })
      .request("work.queue", { text }, new AbortController().signal)
    expect(result).toEqual({ method: "work.queue", received_length: text.length, returned })
  } finally {
    socket.close()
  }
})

test("cancels both sides of a pending Runtime request", async () => {
  let serverSignal: AbortSignal | null = null
  const started = Promise.withResolvers<void>()
  const socket = new RuntimeBridge(
    {
      handle: (_method, _params, signal) => {
        serverSignal = signal
        started.resolve()
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new ControlFailure("cancelled", "request cancelled")),
            { once: true },
          )
        })
      },
    },
    `/tmp/fmx-runtime-client-cancel-${process.pid}.bus`,
  )
  socket.start()
  const abort = new AbortController()

  try {
    const pending = new RuntimeClient({ env: { FMX_SOCKET_PATH: socket.path } })
      .request("orient", {}, abort.signal)
    await started.promise
    abort.abort()
    const error = await pending.catch((caught) => caught)
    expect(error).toBeInstanceOf(RuntimeRequestError)
    expect((error as RuntimeRequestError).error.code).toBe("cancelled")
    await waitFor(() => serverSignal?.aborted === true)
  } finally {
    socket.close()
  }
})

test("cleans up promptly when connecting fails", async () => {
  const missing = `/tmp/fmx-runtime-client-missing-${process.pid}.bus`
  const error = await new RuntimeClient({ env: { FMX_SOCKET_PATH: missing } })
    .request("orient", {}, new AbortController().signal)
    .catch((caught) => caught)
  expect(error).toBeInstanceOf(RuntimeRequestError)
  expect((error as RuntimeRequestError).error.message).toContain("cannot reach fmx")
})

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(1)
  }
}
