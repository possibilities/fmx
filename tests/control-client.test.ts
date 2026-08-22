import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "../src/cli.ts"
import {
  type ClientEnvironment,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_TIMEOUT,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  resolveSocketPath,
  runCommand,
} from "../src/control-client.ts"
import { ControlFailure, type ControlMethod } from "../src/control-protocol.ts"
import { ControlSocket } from "../src/control-socket.ts"

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
  const socket = new ControlSocket(
    {
      handle: (method, params) => {
        calls.push({ method, params })
        return answer({ method, params })
      },
    },
    `/tmp/fmx-client-test-${name}-${process.pid}.sock`,
  )
  socket.start()
  return { socket, calls }
}

test("names the socket from the flag, then the environment, then a lone live fmx", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-sockets-"))
  await writeFile(join(directory, "fmx-100.ctl"), "")
  await writeFile(join(directory, "fmx-200.ctl"), "")
  const alive = new Set([100])
  const discover = environment({ socketDirectory: directory, isProcessAlive: (pid) => alive.has(pid) })

  expect(resolveSocketPath("/tmp/given.ctl", discover)).toBe("/tmp/given.ctl")
  expect(resolveSocketPath("rel.ctl", discover)).toBe("/work/rel.ctl")
  expect(resolveSocketPath(null, { ...discover, env: { FMX_SOCKET_PATH: "/tmp/env.ctl" } })).toBe("/tmp/env.ctl")
  expect(resolveSocketPath(null, discover)).toBe(join(directory, "fmx-100.ctl"))

  alive.add(200)
  expect(() => resolveSocketPath(null, discover)).toThrow("more than one")
  alive.clear()
  expect(() => resolveSocketPath(null, discover)).toThrow("not running inside fmx")
})

test("reports an unreachable fmx as exit 3", async () => {
  const outcome = await runCommand({ name: "orient" }, null, environment())
  expect(outcome.exitCode).toBe(EXIT_UNREACHABLE)
  expect(outcome.error?.message).toContain("not running inside fmx")
})

test("sends the caller's instance with commands that have one", async () => {
  const { socket, calls } = await server(async () => ({ ok: true }), "caller")
  try {
    const outcome = await runCommand(
      { name: "orient" },
      socket.path,
      environment({ env: { FMX_INSTANCE_ID: "4" } }),
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
  const { socket, calls } = await server(async () => ({ instance: { id: 2 } }), "text")
  try {
    await runCommand(
      parseArgs(["control", "launch", "--prompt-file", "brief.md", "--project", "proj"]).command!,
      socket.path,
      environment({ cwd: directory }),
    )
    await runCommand(
      parseArgs(["control", "instance", "send", "2", "-"]).command!,
      socket.path,
      environment({ readStdin: async () => "from stdin" }),
    )
    expect(calls).toEqual([
      {
        method: "launch",
        params: { prompt: "do the thing\n", directory: join(directory, "proj"), focus: false },
      },
      { method: "instance.send", params: { target: "2", text: "from stdin" } },
    ])
  } finally {
    socket.close()
  }
})

test("an editable launch that waits opens the draft, then waits on the id it was given", async () => {
  const { socket, calls } = await server(
    async ({ method }) =>
      method === "draft.open" ? { draft: "d3", status: "open" } : { draft: "d3", status: "submitted" },
    "editable",
  )
  try {
    const outcome = await runCommand(
      parseArgs(["control", "launch", "--editable", "--wait", "--timeout", "900", "--worktree"]).command!,
      socket.path,
      environment(),
    )
    expect(outcome.result).toEqual({ draft: "d3", status: "submitted" })
    expect(calls).toEqual([
      { method: "draft.open", params: { kind: "launch", fields: { worktree: true } } },
      { method: "draft.wait", params: { draft: "d3", timeout_ms: 900 } },
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
    if (method === "focus") throw new ControlFailure("not_found", "no instance 9")
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
      error: { code: "not_found", message: "no instance 9" },
    })

    const usage = cli("control", "draft")
    expect(await usage.exited).toBe(EXIT_USAGE)
    expect(await new Response(usage.stderr).text()).toContain("Usage: fmx control draft")
    const group = cli("control")
    expect(await group.exited).toBe(EXIT_USAGE)
    expect(await new Response(group.stderr).text()).toContain("Usage: fmx control <command>")
  } finally {
    socket.close()
  }
})
