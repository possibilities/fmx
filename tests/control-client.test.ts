import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "../src/cli.ts"
import { BusSocket } from "../src/bus-socket.ts"
import {
  type ClientEnvironment,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_TIMEOUT,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  resolveBusPath,
  runCommand,
} from "../src/control-client.ts"
import { ControlFailure, type ControlMethod } from "../src/control-protocol.ts"
import { RuntimeBus } from "../src/runtime-bus.ts"

type Call = { method: ControlMethod; params: Record<string, unknown> }

function environment(overrides: Partial<ClientEnvironment> = {}): ClientEnvironment {
  return {
    env: {},
    cwd: "/work",
    readStdin: async () => "",
    socketDirectory: "/nonexistent",
    ...overrides,
  }
}

async function server(answer: (call: Call) => Promise<unknown>, name: string) {
  const calls: Call[] = []
  const socket = new BusSocket(
    new RuntimeBus({ homeId: "home", version: "test" }),
    {
      handle: (method, params) => {
        calls.push({ method, params })
        return answer({ method, params })
      },
    },
    `/tmp/fmx-client-test-${name}-${process.pid}.bus`,
  )
  socket.start()
  return { socket, calls }
}

test("names the socket from the flag, then the environment, then a lone live fmx", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-sockets-"))
  const first = join(directory, "0123456789ab.bus")
  const second = join(directory, "ba9876543210.bus")
  await writeFile(first, "")
  await writeFile(second, "")
  await writeFile(join(directory, "zmx.bus"), "")
  const alive = new Set([first])
  const discover = environment({ socketDirectory: directory, isSocketLive: async (path) => alive.has(path) })

  expect(await resolveBusPath("/tmp/given.bus", discover)).toBe("/tmp/given.bus")
  expect(await resolveBusPath("rel.bus", discover)).toBe("/work/rel.bus")
  expect(await resolveBusPath(null, { ...discover, env: { FMX_SOCKET_PATH: "/tmp/env.bus" } })).toBe("/tmp/env.bus")
  expect(await resolveBusPath(null, { ...discover, env: { FMX_SOCKET_PATH: "/tmp/survivor.ctl" } })).toBe("/tmp/survivor.bus")
  expect(await resolveBusPath(null, discover)).toBe(first)

  alive.add(second)
  expect(resolveBusPath(null, discover)).rejects.toThrow("more than one")
  alive.clear()
  expect(resolveBusPath(null, discover)).rejects.toThrow("not running inside fmx")
})

test("reports an unreachable fmx as exit 3", async () => {
  const outcome = await runCommand({ name: "orient" }, null, environment())
  expect(outcome.exitCode).toBe(EXIT_UNREACHABLE)
  expect(outcome.error?.message).toContain("not running inside fmx")
})

test("sends the caller's agent with commands that have one", async () => {
  const { socket, calls } = await server(async () => ({ ok: true }), "caller")
  try {
    const outcome = await runCommand(
      { name: "orient" },
      socket.path,
      environment({ env: { FMX_AGENT_ID: "4" } }),
    )
    expect(outcome.exitCode).toBe(EXIT_OK)
    expect(calls).toEqual([{ method: "orient", params: { caller: 4 } }])
  } finally {
    socket.close()
  }
})


test("resolves prompt text from a file or stdin before sending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-prompt-"))
  await writeFile(join(directory, "brief.md"), "do the thing\n")
  const { socket, calls } = await server(async () => ({ agent: { id: 2 } }), "text")
  try {
    await runCommand(
      parseArgs([
        "control",
        "launch",
        "--prompt-file",
        "brief.md",
        "--project",
        "proj",
        "--model",
        "gpt-5.6-luna",
        "--effort",
        "max",
      ]).command!,
      socket.path,
      environment({ cwd: directory }),
    )
    await runCommand(
      parseArgs(["control", "agent", "send", "2", "-"]).command!,
      socket.path,
      environment({ readStdin: async () => "from stdin" }),
    )
    expect(calls).toEqual([
      {
        method: "launch",
        params: {
          prompt: "do the thing\n",
          directory: join(directory, "proj"),
          model: "gpt-5.6-luna",
          effort: "max",
          focus: false,
        },
      },
      { method: "agent.send", params: { target: "2", text: "from stdin" } },
    ])
  } finally {
    socket.close()
  }
})

test("maps error codes to exit statuses", async () => {
  let code: "busy" | "invalid_params" | "timeout" = "busy"
  const { socket } = await server(async () => {
    throw new ControlFailure(code, "nope")
  }, "codes")
  try {
    expect((await runCommand({ name: "orient" }, socket.path, environment())).exitCode).toBe(EXIT_REFUSED)
    code = "invalid_params"
    expect((await runCommand({ name: "orient" }, socket.path, environment())).exitCode).toBe(EXIT_USAGE)
    code = "timeout"
    expect((await runCommand({ name: "orient" }, socket.path, environment())).exitCode).toBe(EXIT_TIMEOUT)
  } finally {
    socket.close()
  }
})

test("the fmx binary itself is the client: JSON out, exit status in", async () => {
  const { socket } = await server(async ({ method }) => {
    if (method === "focus") throw new ControlFailure("not_found", "no agent 9")
    return { you: null }
  }, "binary")
  const cli = (...args: string[]) =>
    Bun.spawn([process.execPath, "src/index.ts", ...args], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, FMX_SOCKET_PATH: socket.path },
      stdout: "pipe",
      stderr: "pipe",
    })
  try {
    const orient = cli("control", "orient")
    expect(await orient.exited).toBe(EXIT_OK)
    expect(JSON.parse(await new Response(orient.stdout).text())).toEqual({ you: null })

    const focus = cli("control", "focus", "9")
    expect(await focus.exited).toBe(EXIT_REFUSED)
    expect(JSON.parse(await new Response(focus.stderr).text())).toEqual({
      error: { code: "not_found", message: "no agent 9" },
    })

    const usage = cli("control", "draft")
    expect(await usage.exited).toBe(EXIT_USAGE)
    expect(await new Response(usage.stderr).text()).toContain("unknown control command: draft")
    const group = cli("control")
    expect(await group.exited).toBe(EXIT_USAGE)
    expect(await new Response(group.stderr).text()).toContain("Usage: fmx control <command>")
  } finally {
    socket.close()
  }
})
