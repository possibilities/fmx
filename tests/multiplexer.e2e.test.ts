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
import { CompanionCommand } from "../src/zmx-command.ts"
import { COMPANION_BINARY_NAME, homeIdFor } from "../src/zmx-environment.ts"

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
const homeOf = (temporaryDirectory: string) => homeIdFor(join(temporaryDirectory, "config", "fmx"))
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

async function orientation(
  temporaryDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<Snapshot | null> {
  const socketPath = RuntimeBridge.pathFor(defaultAdeSocketPath(homeOf(temporaryDirectory)))
  try {
    return await new RuntimeClient({ env: { ...env, FMX_SOCKET_PATH: socketPath } })
      .request("orient", {}, new AbortController().signal) as Snapshot
  } catch {
    return null
  }
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
