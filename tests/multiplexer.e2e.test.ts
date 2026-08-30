import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultAdeSocketPath } from "../src/ade-events.ts"
import { RuntimeBridge } from "../src/runtime-bridge.ts"
import type { Snapshot } from "../src/control-protocol.ts"
import { RuntimeClient } from "../src/runtime-client.ts"
import { resolveFmxHome } from "../src/home.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { COMPANION_BINARY_NAME } from "../src/zmx-environment.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_FX = resolve(ROOT, "tests/fixtures/fake-fx.ts")
const FMX_COMMAND = process.env.FMX_BINARY_PATH
  ? [resolve(ROOT, process.env.FMX_BINARY_PATH)]
  : [process.execPath, resolve(ROOT, "src/index.ts")]
const COMPANION = process.env.FMX_ZMX_PATH
  ? resolve(ROOT, process.env.FMX_ZMX_PATH)
  : Bun.which(COMPANION_BINARY_NAME)
const PTY_TEST_ENABLED =
  process.env.FMX_RUN_PTY_TESTS === "1" &&
  typeof Bun.Terminal === "function" &&
  Boolean(COMPANION && existsSync(COMPANION))

const control = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64
const homeOf = (temporaryDirectory: string, name: string | null = null) =>
  resolveFmxHome(name, { XDG_CONFIG_HOME: join(temporaryDirectory, "config") }).id
const companionDirectoryFor = (temporaryDirectory: string) =>
  `/tmp/fmxz-${createHash("sha256").update(basename(temporaryDirectory)).digest("hex").slice(0, 12)}`

function privateHome(temporaryDirectory: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
    FMX_ZMX_PATH: COMPANION!,
    FMX_ZMX_DIR: companionDirectoryFor(temporaryDirectory),
    FMX_MANIFEST_PATH: join(temporaryDirectory, "agents.json"),
  }
}

test.skipIf(!PTY_TEST_ENABLED)(
  "multiple Clients share one Runtime and hand off sizing ownership",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fmx-clients-e2e-"))
    const configFile = join(temporaryDirectory, "config.toml")
    await writeFile(configFile, `project_roots = [${JSON.stringify(ROOT)}]\n`)
    const env = {
      ...process.env,
      FMX_FX_PATH: FAKE_FX,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FMX_CONFIG_PATH: configFile,
      FMX_STATE_PATH: join(temporaryDirectory, "state.json"),
      ...privateHome(temporaryDirectory),
    }
    const spawnClient = (sink: { output: string }, cols: number, rows: number) => {
      const decoder = new TextDecoder()
      return Bun.spawn(FMX_COMMAND, {
        cwd: ROOT,
        env,
        terminal: {
          cols,
          rows,
          data: (_terminal, bytes) => {
            sink.output += decoder.decode(bytes, { stream: true })
          },
        },
      })
    }

    const firstOutput = { output: "" }
    const first = spawnClient(firstOutput, 100, 24)
    let second: ReturnType<typeof spawnClient> | null = null
    try {
      await waitUntil(() => firstOutput.output.includes("no agents"), 8_000, () => firstOutput.output)
      const initial = await orientation(temporaryDirectory, env)
      expect(initial?.fmx).toMatchObject({ cols: 100, rows: 24 })
      const runtimePid = initial!.fmx.pid

      const secondOutput = { output: "" }
      second = spawnClient(secondOutput, 60, 16)
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, env)
          return snapshot?.fmx.pid === runtimePid && snapshot.fmx.cols === 60 && snapshot.fmx.rows === 16
        },
        8_000,
        () => secondOutput.output,
      )

      first.terminal?.write(new TextEncoder().encode("\x1b[I"))
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, env)
          return snapshot?.fmx.cols === 100 && snapshot.fmx.rows === 24
        },
        5_000,
        () => firstOutput.output,
      )

      first.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(first.exited, 6_000, "first Client did not detach")).toBe(0)
      first.terminal?.close()
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, env)
          return snapshot?.fmx.pid === runtimePid && snapshot.fmx.cols === 60 && snapshot.fmx.rows === 16
        },
        5_000,
        () => secondOutput.output,
      )

      second.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(second.exited, 6_000, "final Client did not detach")).toBe(0)
      second.terminal?.close()
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env)) === null,
        8_000,
        () => secondOutput.output,
      )
    } finally {
      if (first.exitCode === null) first.kill("SIGKILL")
      first.terminal?.close()
      if (second && second.exitCode === null) second.kill("SIGKILL")
      second?.terminal?.close()
      await endCompanionSessions(temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  },
  30_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "named fmx Runtimes are independent and same-name Clients join",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fmx-names-e2e-"))
    const configFile = join(temporaryDirectory, "config.toml")
    await writeFile(configFile, `project_roots = [${JSON.stringify(ROOT)}]\n`)
    const env = {
      ...process.env,
      FMX_FX_PATH: FAKE_FX,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FMX_CONFIG_PATH: configFile,
      XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
      FMX_ZMX_PATH: COMPANION!,
      FMX_ZMX_DIR: companionDirectoryFor(temporaryDirectory),
      FMX_MANIFEST_PATH: undefined,
      FMX_STATE_PATH: undefined,
    }
    const spawnClient = (name: string, sink: { output: string }, cols: number, rows: number) => {
      const decoder = new TextDecoder()
      return Bun.spawn([...FMX_COMMAND, "--name", name], {
        cwd: ROOT,
        env,
        terminal: {
          cols,
          rows,
          data: (_terminal, bytes) => {
            sink.output += decoder.decode(bytes, { stream: true })
          },
        },
      })
    }

    const fooOutput = { output: "" }
    const barOutput = { output: "" }
    const foo = spawnClient("foo", fooOutput, 100, 24)
    const bar = spawnClient("bar", barOutput, 80, 20)
    let secondFoo: ReturnType<typeof spawnClient> | null = null
    try {
      await waitUntil(() => fooOutput.output.includes("no agents"), 8_000, () => fooOutput.output)
      await waitUntil(() => barOutput.output.includes("no agents"), 8_000, () => barOutput.output)

      const fooInitial = await orientation(temporaryDirectory, env, "foo")
      const barInitial = await orientation(temporaryDirectory, env, "bar")
      expect(fooInitial?.fmx).toMatchObject({ name: "foo", cols: 100, rows: 24 })
      expect(barInitial?.fmx).toMatchObject({ name: "bar", cols: 80, rows: 20 })
      expect(fooInitial!.fmx.pid).not.toBe(barInitial!.fmx.pid)

      const fooAgent = await runtimeRequest(temporaryDirectory, env, "foo", "agent.create", {
        directory: ROOT,
      }) as { agent: Snapshot["agents"][number] }
      const barAgent = await runtimeRequest(temporaryDirectory, env, "bar", "agent.create", {
        directory: ROOT,
      }) as { agent: Snapshot["agents"][number] }
      expect(fooAgent.agent.display_id).toBe(1)
      expect(barAgent.agent.display_id).toBe(1)
      expect(fooAgent.agent.agent_id).not.toBe(barAgent.agent.agent_id)

      const secondFooOutput = { output: "" }
      secondFoo = spawnClient("foo", secondFooOutput, 60, 16)
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, env, "foo")
          return snapshot?.fmx.pid === fooInitial!.fmx.pid &&
            snapshot.fmx.cols === 60 && snapshot.fmx.rows === 16 &&
            snapshot.agents.length === 1 && snapshot.agents[0]?.agent_id === fooAgent.agent.agent_id
        },
        8_000,
        () => secondFooOutput.output,
      )
      expect((await orientation(temporaryDirectory, env, "bar"))?.agents[0]?.agent_id).toBe(
        barAgent.agent.agent_id,
      )

      foo.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(foo.exited, 6_000, "first foo Client did not detach")).toBe(0)
      foo.terminal?.close()
      expect((await orientation(temporaryDirectory, env, "foo"))?.fmx.pid).toBe(fooInitial!.fmx.pid)

      secondFoo.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(secondFoo.exited, 6_000, "final foo Client did not detach")).toBe(0)
      secondFoo.terminal?.close()
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env, "foo")) === null,
        8_000,
        () => secondFooOutput.output,
      )
      expect(await orientation(temporaryDirectory, env, "bar")).not.toBeNull()

      bar.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(bar.exited, 6_000, "bar Client did not detach")).toBe(0)
      bar.terminal?.close()
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env, "bar")) === null,
        8_000,
        () => barOutput.output,
      )
    } finally {
      if (foo.exitCode === null) foo.kill("SIGKILL")
      foo.terminal?.close()
      if (bar.exitCode === null) bar.kill("SIGKILL")
      bar.terminal?.close()
      if (secondFoo && secondFoo.exitCode === null) secondFoo.kill("SIGKILL")
      secondFoo?.terminal?.close()
      await endCompanionSessions(temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  },
  45_000,
)

async function orientation(
  temporaryDirectory: string,
  env: NodeJS.ProcessEnv,
  name: string | null = null,
): Promise<Snapshot | null> {
  const socketPath = RuntimeBridge.pathFor(defaultAdeSocketPath(homeOf(temporaryDirectory, name)))
  try {
    return await new RuntimeClient({ env: { ...env, FMX_SOCKET_PATH: socketPath } })
      .request("orient", {}, new AbortController().signal) as Snapshot
  } catch {
    return null
  }
}

async function runtimeRequest(
  temporaryDirectory: string,
  env: NodeJS.ProcessEnv,
  name: string,
  method: Parameters<RuntimeClient["request"]>[0],
  params: Record<string, unknown>,
): Promise<unknown> {
  const socketPath = RuntimeBridge.pathFor(defaultAdeSocketPath(homeOf(temporaryDirectory, name)))
  return await new RuntimeClient({ env: { ...env, FMX_SOCKET_PATH: socketPath } })
    .request(method, params, new AbortController().signal)
}

async function endCompanionSessions(temporaryDirectory: string): Promise<void> {
  const companion = new CompanionCommand(companionDirectoryFor(temporaryDirectory), process.env, COMPANION!)
  let sessions = await companion.list().catch(() => [])
  for (const session of sessions) {
    if (session.state === "live") await companion.kill(session.name).catch(() => {})
  }
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    sessions = await companion.list().catch(() => [])
    if (sessions.every((session) => session.state === "exited" || session.state === "absent")) break
    await Bun.sleep(50)
  }
  for (const session of sessions) {
    if (session.state === "exited") await companion.forget(session.name).catch(() => {})
  }
  await rm(companionDirectoryFor(temporaryDirectory), { recursive: true, force: true })
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  diagnostic: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`condition timed out\n${diagnostic()}`)
    await Bun.sleep(20)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
