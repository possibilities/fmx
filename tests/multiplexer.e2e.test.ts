import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultSocketPath } from "../src/agent-socket.ts"
import { runCommand } from "../src/control-client.ts"
import type { Snapshot } from "../src/control-protocol.ts"
import { ControlSocket } from "../src/control-socket.ts"
import { loadManifest } from "../src/instance-manifest.ts"
import { SIDEBAR_DEFAULT_WIDTH } from "../src/multiplexer.ts"
import { LineAssembler } from "../src/socket-frames.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { COMPANION_BINARY_NAME, homeIdFor } from "../src/zmx-environment.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_FX = resolve(ROOT, "tests/fixtures/fake-fx.ts")
const FMX_COMMAND = process.env.FMX_BINARY_PATH
  ? [resolve(ROOT, process.env.FMX_BINARY_PATH)]
  : [process.execPath, resolve(ROOT, "src/index.ts")]

const configWithRoot = (extra = "") => `project_roots = [${JSON.stringify(ROOT)}]\n${extra}`

const control = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64

const RESTORED_SESSION_A = "1787368596567-1787368596567934000-ba9a9f7e16e5ef8c"
const RESTORED_SESSION_B = "1787368597000-1787368597000000000-cccccccccccccccc"
const RESTORED_CHILD = "1787368609310-1787368609310138000-3e38dc7a8d7c16c2"

// The embedded terminal starts past the sidebar and its one-column divider, so
// a drag aimed at fx must be addressed there rather than at the screen origin.
const TERMINAL_ORIGIN_COLUMN = SIDEBAR_DEFAULT_WIDTH + 2

/** An SGR press, drag, and release across one row, as a human's swipe. */
const dragAcross = (columns: number, row = 1) => {
  const from = TERMINAL_ORIGIN_COLUMN
  const to = TERMINAL_ORIGIN_COLUMN + columns
  return `\u001b[<0;${from};${row}M\u001b[<32;${to};${row}M\u001b[<0;${to};${row}m`
}

/**
 * The real app needs a real Companion: FMX_ZMX_PATH, or `fmx-zmx` on PATH.
 * Everything an fmx here touches — Home, Manifest, Companion directory — is
 * under the test's temp directory, so nothing can meet a human's fmx.
 */
const COMPANION = process.env.FMX_ZMX_PATH ? resolve(ROOT, process.env.FMX_ZMX_PATH) : Bun.which(COMPANION_BINARY_NAME)
const PTY_TEST_ENABLED =
  process.env.FMX_RUN_PTY_TESTS === "1" && typeof Bun.Terminal === "function" && Boolean(COMPANION && existsSync(COMPANION))

/**
 * The Companion's directory for one test: under /tmp itself, not the
 * system temp directory, because a socket path is capped near 104 bytes and
 * a session name alone is 36 of them.
 */
const companionDirectoryFor = (tempDirectory: string) => `/tmp/fmxz-e2e-${basename(tempDirectory)}`

/** The environment that keeps one fmx run private to its temp directory. */
function privateHome(tempDirectory: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(tempDirectory, "config"),
    FMX_ZMX_PATH: COMPANION!,
    FMX_ZMX_DIR: companionDirectoryFor(tempDirectory),
    FMX_MANIFEST_PATH: join(tempDirectory, "instances.json"),
  }
}

/** The Home id an fmx under `privateHome` derives for itself. */
const homeOf = (tempDirectory: string) => homeIdFor(join(tempDirectory, "config", "fmx"))

/** End every fx the Companion still holds for a test, and consume what they leave. */
async function endSurvivors(tempDirectory: string): Promise<void> {
  const companion = new CompanionCommand(companionDirectoryFor(tempDirectory), process.env, COMPANION!)
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
  await rm(companionDirectoryFor(tempDirectory), { recursive: true, force: true })
}

test.skipIf(!PTY_TEST_ENABLED)(
  "prefix+d detaches fmx and leaves its fx running",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-detach-e2e-"))
    const lifecycleLog = join(tempDirectory, "lifecycle.log")
    const configFile = join(tempDirectory, "config.toml")
    await writeFile(configFile, configWithRoot())
    let output = ""
    const decoder = new TextDecoder()
    const child = Bun.spawn(FMX_COMMAND, {
      cwd: ROOT,
      env: {
        ...process.env,
        FMX_FX_PATH: FAKE_FX,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FMX_CONFIG_PATH: configFile,
        FMX_STATE_PATH: join(tempDirectory, "state.json"),
        ...privateHome(tempDirectory),
        FMX_TEST_LOG: lifecycleLog,
        FMX_TEST_HEARTBEAT: "1",
      },
      terminal: {
        cols: 100,
        rows: 24,
        data: (_terminal, bytes) => {
          output += decoder.decode(bytes, { stream: true })
        },
      },
    })

    try {
      await waitUntil(() => output.includes("prefix+c"), 8_000, () => output)
      child.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => output)
      await waitUntil(
        async () => (await loadManifest(join(tempDirectory, "instances.json"), homeOf(tempDirectory))).instances[0]?.phase === "running",
        5_000,
        () => output,
      )

      const before = countOccurrences(await readLifecycle(lifecycleLog), "alive 1 ")
      child.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(child.exited, 6_000, "fmx did not detach after prefix+d")).toBe(0)
      child.terminal?.close()

      await Bun.sleep(200)
      const lifecycle = await readLifecycle(lifecycleLog)
      expect(countOccurrences(lifecycle, "alive 1 ")).toBeGreaterThan(before)
      expect(lifecycle).not.toContain("graceful 1")
      expect((await loadManifest(join(tempDirectory, "instances.json"), homeOf(tempDirectory))).instances).toMatchObject([
        { displayId: 1, phase: "running" },
      ])
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
      await endSurvivors(tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  15_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "prefix+c starts fx in the first configured project root",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-first-root-e2e-"))
    const firstRoot = join(tempDirectory, "first-root")
    const secondRoot = join(tempDirectory, "second-root")
    const launchDirectory = join(tempDirectory, "somewhere-else")
    const lifecycleLog = join(tempDirectory, "lifecycle.log")
    const configFile = join(tempDirectory, "config.toml")
    await Promise.all([
      writeFile(configFile, `project_roots = [${JSON.stringify(firstRoot)}, ${JSON.stringify(secondRoot)}]\n`),
      mkdir(firstRoot),
      mkdir(secondRoot),
      mkdir(launchDirectory),
    ])

    let output = ""
    const decoder = new TextDecoder()
    const child = Bun.spawn(FMX_COMMAND, {
      cwd: launchDirectory,
      env: {
        ...process.env,
        FMX_FX_PATH: FAKE_FX,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FMX_CONFIG_PATH: configFile,
        FMX_STATE_PATH: join(tempDirectory, "state.json"),
        ...privateHome(tempDirectory),
        FMX_TEST_LOG: lifecycleLog,
      },
      terminal: {
        cols: 100,
        rows: 24,
        data: (_terminal, bytes) => {
          output += decoder.decode(bytes, { stream: true })
        },
      },
    })

    try {
      await waitUntil(() => output.includes("prefix+c"), 8_000, () => output)
      child.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => output)
      await waitUntil(
        async () =>
          (await loadManifest(join(tempDirectory, "instances.json"), homeOf(tempDirectory))).instances.length === 1,
        5_000,
        () => output,
      )
      expect(
        (await loadManifest(join(tempDirectory, "instances.json"), homeOf(tempDirectory))).instances[0]?.cwd,
      ).toBe(await realpath(firstRoot))

      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 1"), 5_000, () => output)
      await waitUntil(() => output.includes("prefix+c to create agent"), 5_000, () => output)
      await Bun.sleep(250)
      child.terminal?.write(Uint8Array.of(control("c")))
      await waitUntil(() => output.includes("press ctrl+c again to exit"), 5_000, () => output)
      child.terminal?.write(Uint8Array.of(control("c")))
      expect(await withTimeout(child.exited, 6_000, "fmx did not exit after first-root test")).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
      await endSurvivors(tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  20_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "restores agent and subagent status without unknown flashes",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-status-restore-e2e-"))
    const projectRoot = join(tempDirectory, "root")
    const lifecycleLog = join(tempDirectory, "lifecycle.log")
    const configFile = join(tempDirectory, "config.toml")
    await mkdir(projectRoot)
    await writeFile(configFile, `project_roots = [${JSON.stringify(projectRoot)}]\n`)
    await writeSubagentControl(tempDirectory, RESTORED_CHILD, RESTORED_SESSION_B, "awaiting_approval")

    const env = {
      ...process.env,
      HOME: tempDirectory,
      FMX_FX_PATH: FAKE_FX,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FMX_CONFIG_PATH: configFile,
      FMX_STATE_PATH: join(tempDirectory, "state.json"),
      ...privateHome(tempDirectory),
      FMX_TEST_LOG: lifecycleLog,
    }
    const spawnFmx = (sink: { output: string }) => {
      const decoder = new TextDecoder()
      return Bun.spawn(FMX_COMMAND, {
        cwd: projectRoot,
        env,
        terminal: {
          cols: 100,
          rows: 24,
          data: (_terminal, bytes) => {
            sink.output += decoder.decode(bytes, { stream: true })
          },
        },
      })
    }
    const manifest = () => loadManifest(join(tempDirectory, "instances.json"), homeOf(tempDirectory))
    const agentSocketPath = defaultSocketPath(homeOf(tempDirectory))

    const firstOutput = { output: "" }
    const first = spawnFmx(firstOutput)
    let replacement: ReturnType<typeof spawnFmx> | null = null
    try {
      await waitUntil(() => firstOutput.output.includes("prefix+c"), 8_000, () => firstOutput.output)
      first.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => firstOutput.output)
      const firstEntry = (await manifest()).instances[0]!
      await sendAgentFrame(agentSocketPath, sessionFrame(firstEntry.paneId, RESTORED_SESSION_A))
      await sendAgentFrame(agentSocketPath, stateFrame(firstEntry.paneId, "blocked", "question"))

      first.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 2"), 8_000, () => firstOutput.output)
      const secondEntry = (await manifest()).instances[1]!
      await sendAgentFrame(agentSocketPath, sessionFrame(secondEntry.paneId, RESTORED_SESSION_B))
      await sendAgentFrame(agentSocketPath, stateFrame(secondEntry.paneId, "working"))

      // Leave agent 2 inactive, then let its turn finish there: it must revive
      // as `done`, not collapse to either idle or unknown.
      first.terminal?.write(Uint8Array.of(control("b"), "p".charCodeAt(0)))
      await waitUntil(
        async () => (await orientation(tempDirectory, env))?.active === 1,
        5_000,
        () => firstOutput.output,
      )
      await sendAgentFrame(agentSocketPath, stateFrame(secondEntry.paneId, "idle"))
      await waitUntil(
        async () => {
          const entries = (await manifest()).instances
          return (
            entries[0]?.agentStatus?.state === "blocked" &&
            entries[0]?.agentStatus?.attention === "question" &&
            entries[1]?.agentStatus?.state === "idle" &&
            entries[1]?.agentStatus?.seen === false
          )
        },
        5_000,
        () => firstOutput.output,
      )
      await waitUntil(
        async () => (await orientation(tempDirectory, env))?.instances[1]?.subagents[0]?.state === "blocked",
        5_000,
        () => firstOutput.output,
      )

      first.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(first.exited, 6_000, "first fmx did not detach")).toBe(0)
      first.terminal?.close()

      const restoredOutput = { output: "" }
      replacement = spawnFmx(restoredOutput)
      let restored: Snapshot | null = null
      await waitUntil(
        async () => {
          restored = await orientation(tempDirectory, env)
          return restored?.instances.length === 2 && restored.instances[1]?.subagents.length === 1
        },
        10_000,
        () => restoredOutput.output,
      )

      expect(restored!.instances.map((instance) => [instance.state, instance.attention])).toEqual([
        ["blocked", "question"],
        ["done", null],
      ])
      expect(restored!.instances[1]!.subagents).toMatchObject([
        { session_id: RESTORED_CHILD, state: "blocked", attention: "permission" },
      ])
      // Both status checkpoints are seeded in the same synchronous turn that
      // adds their rows, before OpenTUI can expose an unknown-state frame.
      expect(restoredOutput.output).not.toContain(`· ${RESTORED_SESSION_A.split("-").at(-1)}`)
      expect(restoredOutput.output).not.toContain(`· ${RESTORED_SESSION_B.split("-").at(-1)}`)

      replacement.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(replacement.exited, 6_000, "replacement fmx did not detach")).toBe(0)
      replacement.terminal?.close()
    } finally {
      if (first.exitCode === null) first.kill("SIGKILL")
      first.terminal?.close()
      if (replacement && replacement.exitCode === null) replacement.kill("SIGKILL")
      replacement?.terminal?.close()
      await endSurvivors(tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  25_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "multiplexer uses configured bindings and leaves PTY exits to fx",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-e2e-"))
    const lifecycleLog = join(tempDirectory, "lifecycle.log")
    const configFile = join(tempDirectory, "config.toml")
    await writeFile(configFile, configWithRoot('[keys]\nprefix = "ctrl+space"\n'))

    let output = ""
    const decoder = new TextDecoder()
    const child = Bun.spawn(FMX_COMMAND, {
      cwd: ROOT,
      env: {
        ...process.env,
        FMX_FX_PATH: FAKE_FX,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FMX_CONFIG_PATH: configFile,
        // Machine state stays in the temp directory: a sidebar width persisted
        // by a real session would move the layout out from under these tests.
        FMX_STATE_PATH: join(tempDirectory, "state.json"),
        ...privateHome(tempDirectory),
        FMX_TEST_LOG: lifecycleLog,
        FMX_TEST_HEARTBEAT: "1",
        FMX_TEST_KEYBOARD_MODE: "1",
        FMX_TEST_PASSTHROUGH_KEYS: "1",
        FMX_TEST_FORBIDDEN_PREFIX_BYTE: "0",
        FMX_TEST_PRIVATE_CURSOR_QUERY: "1",
        FMX_TEST_QUERY_ON_EXIT: "1",
      },
      terminal: {
        cols: 100,
        rows: 24,
        data: (_terminal, bytes) => {
          output += decoder.decode(bytes, { stream: true })
        },
      },
    })

    try {
      await waitUntil(() => output.includes("prefix+c"), 8_000, () => output)
      const initialEmptyStateCount = countOccurrences(output, "prefix+c")
      child.terminal?.write(Uint8Array.of(0, "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("start 1"), 8_000, () => output)
      await waitUntil(
        async () => (await readLifecycle(lifecycleLog)).includes("private-terminal-response 1"),
        5_000,
        () => output,
      )

      child.terminal?.write(new TextEncoder().encode("\u0015\u001b\u007f\u001b[127;3u\u001b[127;9u"))
      await waitUntil(
        async () => {
          const lifecycle = await readLifecycle(lifecycleLog)
          return (
            lifecycle.includes("ctrl-u 1") &&
            lifecycle.includes("legacy-alt-backspace 1") &&
            lifecycle.includes("kitty-alt-backspace 1") &&
            lifecycle.includes("kitty-super-backspace 1")
          )
        },
        5_000,
        () => output,
      )

      child.terminal?.write(new TextEncoder().encode(dragAcross(3)))
      await waitUntil(() => output.includes("ZmFrZQ=="), 5_000, () => output)

      child.terminal?.write(Uint8Array.of(control("c")))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ctrl-c 1"), 5_000, () => output)
      expect(child.exitCode).toBeNull()

      child.terminal?.write(Uint8Array.of(0, 0))
      await Bun.sleep(100)
      expect(await readLifecycle(lifecycleLog)).not.toContain("forbidden-prefix-byte 1")

      child.terminal?.write(Uint8Array.of(0, control("c")))
      await Bun.sleep(100)
      expect(await readLifecycle(lifecycleLog)).not.toContain("start 2")

      const activeFakeTitleCount = countOccurrences(output, "\u001b]0;fmx · fake session\u0007")
      child.terminal?.write(Uint8Array.of(0, "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 2"), 5_000, () => output)
      await waitUntil(
        () => countOccurrences(output, "\u001b]0;fmx · fake session\u0007") > activeFakeTitleCount,
        5_000,
        () => output,
      )
      // Let the newly focused terminal finish its first frame before simulating
      // a human drag. Arm64 Actions runners can deliver the title and selection
      // readiness in adjacent event-loop turns.
      await Bun.sleep(250)
      const copiedFakeCount = countOccurrences(output, "ZmFrZQ==")
      child.terminal?.write(new TextEncoder().encode(dragAcross(3)))
      await waitUntil(() => countOccurrences(output, "ZmFrZQ==") > copiedFakeCount, 5_000, () => output)

      child.terminal?.write(Uint8Array.of(control("z")))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ctrl-z 2"), 5_000, () => output)

      child.terminal?.write(Uint8Array.of(0, "p".charCodeAt(0)))
      await Bun.sleep(100)
      child.terminal?.write(Uint8Array.of(0, "X".charCodeAt(0)))
      await Bun.sleep(100)
      expect(await readLifecycle(lifecycleLog)).not.toContain("graceful 1")

      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 1"), 5_000, () => output)
      const lifecycleAfterClose = await readLifecycle(lifecycleLog)
      expect(lifecycleAfterClose).toContain("terminal-response 1")
      expect(lifecycleAfterClose).not.toContain("unexpected-input 1")

      child.terminal?.write(Uint8Array.of(0, "q".charCodeAt(0)))
      await Bun.sleep(100)
      expect(child.exitCode).toBeNull()
      expect(await readLifecycle(lifecycleLog)).not.toContain("graceful 2")

      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(
        async () => (await readLifecycle(lifecycleLog)).includes("terminal-response 2"),
        5_000,
        () => output,
      )
      await waitUntil(
        () => countOccurrences(output, "prefix+c") > initialEmptyStateCount,
        5_000,
        () => output,
      )
      expect(child.exitCode).toBeNull()

      child.terminal?.write(Uint8Array.of(control("c")))
      await waitUntil(() => output.includes("press ctrl+c again to exit"), 5_000, () => output)
      child.terminal?.write(Uint8Array.of(control("c")))
      const code = await withTimeout(child.exited, 6_000, "fmx did not exit after confirmed ctrl+c")
      const lifecycle = await readLifecycle(lifecycleLog)
      expect(code).toBe(0)
      expect(lifecycle).toContain("graceful 2")
      expect(lifecycle).toContain("terminal-response 2")
      expect(output).toContain("fake session")
      expect(output).not.toContain("invalid device status report command")
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
      await endSurvivors(tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  25_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "removes fx processes that exit normally and confirms exit after the final one",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-natural-exit-e2e-"))
    const lifecycleLog = join(tempDirectory, "lifecycle.log")
    const configFile = join(tempDirectory, "config.toml")
    await writeFile(configFile, configWithRoot())

    let output = ""
    const decoder = new TextDecoder()
    const child = Bun.spawn(FMX_COMMAND, {
      cwd: ROOT,
      env: {
        ...process.env,
        FMX_FX_PATH: FAKE_FX,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FMX_CONFIG_PATH: configFile,
        // Machine state stays in the temp directory: a sidebar width persisted
        // by a real session would move the layout out from under these tests.
        FMX_STATE_PATH: join(tempDirectory, "state.json"),
        ...privateHome(tempDirectory),
        FMX_TEST_LOG: lifecycleLog,
        FMX_TEST_PASSTHROUGH_KEYS: "1",
      },
      terminal: {
        cols: 100,
        rows: 24,
        data: (_terminal, bytes) => {
          output += decoder.decode(bytes, { stream: true })
        },
      },
    })

    try {
      await waitUntil(() => output.includes("prefix+c"), 8_000, () => output)
      const initialEmptyStateCount = countOccurrences(output, "prefix+c")
      child.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => output)
      child.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 2"), 5_000, () => output)

      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 2"), 5_000, () => output)
      await waitUntil(
        async () => {
          child.terminal?.write(Uint8Array.of(control("u")))
          return (await readLifecycle(lifecycleLog)).includes("ctrl-u 1")
        },
        5_000,
        () => output,
      )
      expect(child.exitCode).toBeNull()

      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 1"), 5_000, () => output)
      await waitUntil(
        () => countOccurrences(output, "prefix+c") > initialEmptyStateCount,
        5_000,
        () => output,
      )
      expect(child.exitCode).toBeNull()

      // The empty state is rendered synchronously with instance removal; give
      // Bun a brief settle to release the exited child PTYs before fmx exits.
      await Bun.sleep(250)
      child.terminal?.write(Uint8Array.of(control("c")))
      await waitUntil(() => output.includes("press ctrl+c again to exit"), 5_000, () => output)
      child.terminal?.write(Uint8Array.of(control("c")))
      const code = await withTimeout(child.exited, 6_000, "fmx did not exit after confirmed ctrl+c")
      expect(code).toBe(0)
      const lifecycle = await readLifecycle(lifecycleLog)
      expect(lifecycle).toContain("start 1 []")
      expect(lifecycle).toContain("graceful 1")
      expect(lifecycle).toContain("graceful 2")
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
      await endSurvivors(tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  15_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "mirrors the outer terminal background before fx starts",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-palette-e2e-"))
    const lifecycleLog = join(tempDirectory, "lifecycle.log")
    const configFile = join(tempDirectory, "config.toml")
    await writeFile(configFile, configWithRoot())

    let output = ""
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const pendingReplies: string[] = []
    let hostBackground = "#123456"
    let sendHostReply: (reply: string) => void = (reply) => {
      pendingReplies.push(reply)
    }
    const respondToPaletteQueries = createHostPaletteResponder(
      (reply) => sendHostReply(reply),
      () => hostBackground,
    )
    const child = Bun.spawn(FMX_COMMAND, {
      cwd: ROOT,
      env: {
        ...process.env,
        FMX_FX_PATH: FAKE_FX,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FMX_CONFIG_PATH: configFile,
        // Machine state stays in the temp directory: a sidebar width persisted
        // by a real session would move the layout out from under these tests.
        FMX_STATE_PATH: join(tempDirectory, "state.json"),
        ...privateHome(tempDirectory),
        FMX_TEST_LOG: lifecycleLog,
        FMX_TEST_BACKGROUND_QUERY: "1",
        FMX_TEST_THEME_UPDATES: "1",
      },
      terminal: {
        cols: 100,
        rows: 24,
        data: (_terminal, bytes) => {
          const text = decoder.decode(bytes, { stream: true })
          output += text
          respondToPaletteQueries(text)
        },
      },
    })
    sendHostReply = (reply) => child.terminal?.write(encoder.encode(reply))
    for (const reply of pendingReplies) sendHostReply(reply)

    try {
      await waitUntil(() => output.includes("prefix+c"), 8_000, () => output)
      const initialEmptyStateCount = countOccurrences(output, "prefix+c")
      child.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
      await waitUntil(
        async () => (await readLifecycle(lifecycleLog)).includes("background-response 1"),
        8_000,
        () => output,
      )
      const lifecycle = await readLifecycle(lifecycleLog)
      expect(lifecycle).toContain("rgb:1212/3434/5656")

      hostBackground = "#eeeeee"
      child.terminal?.write(encoder.encode("\u001b[?997;2n"))
      await waitUntil(
        async () => countOccurrences(await readLifecycle(lifecycleLog), "background-response 1") >= 2,
        8_000,
        () => output,
      )
      const updatedLifecycle = await readLifecycle(lifecycleLog)
      expect(updatedLifecycle).toContain("theme-notification 1")
      expect(updatedLifecycle).toContain("rgb:eeee/eeee/eeee")

      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(
        () => countOccurrences(output, "prefix+c") > initialEmptyStateCount,
        5_000,
        () => output,
      )
      expect(child.exitCode).toBeNull()
      child.terminal?.write(Uint8Array.of(control("c")))
      await waitUntil(() => output.includes("press ctrl+c again to exit"), 5_000, () => output)
      child.terminal?.write(Uint8Array.of(control("c")))
      expect(await withTimeout(child.exited, 6_000, "fmx did not exit after confirmed ctrl+c")).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
      await endSurvivors(tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  15_000,
)

for (const signal of ["SIGHUP", "SIGQUIT", "SIGKILL"] as const) {
  test.skipIf(!PTY_TEST_ENABLED)(
    `${signal} leaves every fx running, and the next fmx restores them`,
    async () => {
      await chmod(FAKE_FX, 0o755)
      const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-restart-e2e-"))
      const lifecycleLog = join(tempDirectory, "lifecycle.log")
      const configFile = join(tempDirectory, "config.toml")
      await writeFile(configFile, configWithRoot())
      const env = {
        ...process.env,
        FMX_FX_PATH: FAKE_FX,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FMX_CONFIG_PATH: configFile,
        FMX_STATE_PATH: join(tempDirectory, "state.json"),
        ...privateHome(tempDirectory),
        FMX_TEST_LOG: lifecycleLog,
        FMX_TEST_HEARTBEAT: "1",
        FMX_TEST_PASSTHROUGH_KEYS: "1",
        FMX_TEST_QUERY_ON_EXIT: "1",
      }
      const spawnFmx = (sink: { output: string }) => {
        const decoder = new TextDecoder()
        return Bun.spawn(FMX_COMMAND, {
          cwd: ROOT,
          env,
          terminal: {
            cols: 100,
            rows: 24,
            data: (_terminal, bytes) => {
              sink.output += decoder.decode(bytes, { stream: true })
            },
          },
        })
      }
      const manifest = () => loadManifest(join(tempDirectory, "instances.json"), homeOf(tempDirectory))
      const heartbeats = async (id: number) => countOccurrences(await readLifecycle(lifecycleLog), `alive ${id} `)

      const first = { output: "" }
      const one = spawnFmx(first)
      let two: ReturnType<typeof spawnFmx> | null = null
      try {
        await waitUntil(() => first.output.includes("prefix+c"), 8_000, () => first.output)
        one.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => first.output)
        one.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 2"), 8_000, () => first.output)
        // Both claims are acknowledged before fmx is taken down.
        await waitUntil(
          async () => {
            const entries = (await manifest()).instances
            return entries.length === 2 && entries.every((entry) => entry.phase === "running")
          },
          5_000,
          () => first.output,
        )

        process.kill(one.pid, signal)
        // Start the replacement before waiting for the old fmx to finish,
        // exactly as a new terminal can race the SIGHUP teardown.
        const second = { output: "" }
        two = spawnFmx(second)
        const code = await withTimeout(one.exited, 6_000, `fmx did not exit after ${signal}`)
        expect(code).toBe(signal === "SIGHUP" ? 129 : signal === "SIGQUIT" ? 131 : 137)
        one.terminal?.close()

        // Nothing was sent to fx: it is still running, and still its own process.
        const beforeOne = await heartbeats(1)
        const beforeTwo = await heartbeats(2)
        await Bun.sleep(200)
        expect(await heartbeats(1)).toBeGreaterThan(beforeOne)
        expect(await heartbeats(2)).toBeGreaterThan(beforeTwo)
        expect(await readLifecycle(lifecycleLog)).not.toContain("ctrl-c")
        expect(await readLifecycle(lifecycleLog)).not.toContain("graceful")
        expect((await manifest()).instances.map((entry) => entry.displayId).sort()).toEqual([1, 2])

        // The next fmx for this Home finds both, numbered as they were, and
        // shows what was on their screens; nothing is started.
        await waitUntil(() => readyBanners(second.output) >= 1, 10_000, () => second.output)
        await Bun.sleep(300)
        // The restored Instance is the first surface the renderer exposes:
        // the empty state belongs only to a Home the join found empty.
        expect(second.output).not.toContain("prefix+c to create agent")
        expect(await readLifecycle(lifecycleLog)).not.toContain("start 3")
        expect(countOccurrences(await readLifecycle(lifecycleLog), "start ")).toBe(2)

        // Input reaches the restored fx; its own exit still removes it.
        two.terminal?.write(Uint8Array.of(control("u")))
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ctrl-u 1"), 5_000, () => second.output)
        two.terminal?.write(Uint8Array.of(control("c"), control("c")))
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 1"), 5_000, () => second.output)
        expect(await readLifecycle(lifecycleLog)).toContain("terminal-response 1")
        await waitUntil(async () => (await manifest()).instances.length === 1, 5_000, () => second.output)
        expect((await manifest()).instances[0]?.displayId).toBe(2)

        two.terminal?.write(Uint8Array.of(control("c"), control("c")))
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 2"), 5_000, () => second.output)
        await waitUntil(() => second.output.includes("prefix+c to create agent"), 5_000, () => second.output)
        expect(two.exitCode).toBeNull()
        await Bun.sleep(250)
        two.terminal?.write(Uint8Array.of(control("c")))
        await waitUntil(() => second.output.includes("press ctrl+c again to exit"), 5_000, () => second.output)
        two.terminal?.write(Uint8Array.of(control("c")))
        expect(await withTimeout(two.exited, 6_000, "fmx did not exit after confirmed ctrl+c")).toBe(0)
        expect((await manifest()).instances).toEqual([])
      } finally {
        if (one.exitCode === null) one.kill("SIGKILL")
        one.terminal?.close()
        if (two && two.exitCode === null) two.kill("SIGKILL")
        two?.terminal?.close()
        await endSurvivors(tempDirectory)
        await rm(tempDirectory, { recursive: true, force: true })
      }
    },
    40_000,
  )
}

function createHostPaletteResponder(
  send: (reply: string) => void,
  defaultBackground: () => string = () => "#123456",
): (output: string) => void {
  const ansi = [
    "#010203",
    "#cc241d",
    "#98971a",
    "#d79921",
    "#458588",
    "#b16286",
    "#689d6a",
    "#a89984",
    "#928374",
    "#fb4934",
    "#b8bb26",
    "#fabd2f",
    "#83a598",
    "#d3869b",
    "#8ec07c",
    "#ebdbb2",
  ]
  const special = new Map<number, string>([
    [10, "#102030"],
    [11, "#123456"],
    [12, "#abcdef"],
    [13, "#102030"],
    [14, "#123456"],
    [15, "#102030"],
    [16, "#123456"],
    [17, "#345678"],
    [19, "#f0f1f2"],
  ])
  let buffer = ""

  return (output) => {
    buffer += output
    let match: RegExpExecArray | null
    const query = /\u001b\](?:4;(\d+)|(\d+));\?(?:\u0007|\u001b\\)/u
    while ((match = query.exec(buffer))) {
      buffer = buffer.slice(match.index + match[0].length)
      if (match[1] !== undefined) {
        const index = Number(match[1])
        send(`\u001b]4;${index};${ansi[index] ?? "#000000"}\u0007`)
      } else {
        const index = Number(match[2])
        const color = index === 11 ? defaultBackground() : (special.get(index) ?? "#000000")
        send(`\u001b]${index};${color}\u0007`)
      }
    }
    if (buffer.length > 4_096) buffer = buffer.slice(-4_096)
  }
}

async function orientation(
  tempDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<Snapshot | null> {
  const socket = ControlSocket.pathFor(defaultSocketPath(homeOf(tempDirectory)))
  try {
    const outcome = await runCommand({ name: "orient" }, socket, {
      env,
      cwd: ROOT,
      readStdin: async () => "",
    })
    return outcome.exitCode === 0 ? (outcome.result as Snapshot) : null
  } catch {
    return null
  }
}

/** One request and one reply, as fx speaks to the Agent socket. */
async function sendAgentFrame(path: string, payload: string): Promise<void> {
  const assembler = new LineAssembler()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const timeout = setTimeout(() => reject(new Error("Agent socket did not reply")), 1_000)
  let connection: Awaited<ReturnType<typeof Bun.connect>> | null = null
  try {
    connection = await Bun.connect({
      unix: path,
      socket: {
        open: (socket) => void socket.write(`${payload}\n`),
        data: (_socket, data) => {
          if (assembler.push(new TextDecoder().decode(data)).length > 0) resolve()
        },
        error: (_socket, error) => reject(error),
      },
    })
    await promise
  } finally {
    clearTimeout(timeout)
    connection?.end()
  }
}

function sessionFrame(paneId: string, sessionId: string): string {
  return JSON.stringify({
    id: `session-${paneId}`,
    method: "pane.report_agent_session",
    params: { pane_id: paneId, source: "custom:fx", agent: "fx", agent_session_id: sessionId },
  })
}

function stateFrame(
  paneId: string,
  state: "idle" | "working" | "blocked",
  attention?: "permission" | "question" | "recovery",
): string {
  return JSON.stringify({
    id: `state-${paneId}-${state}`,
    method: "pane.report_agent",
    params: {
      pane_id: paneId,
      source: "custom:fx",
      agent: "fx",
      state,
      ...(attention ? { custom_status: attention } : {}),
    },
  })
}

async function writeSubagentControl(
  home: string,
  childId: string,
  parentId: string,
  state: string,
): Promise<void> {
  const directory = join(home, ".fx", "sessions", childId, "subagent")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "control.json"),
    JSON.stringify({
      schema_version: 7,
      child_id: childId,
      parent_id: parentId,
      generation: 1,
      mode: "persistent",
      configuration: { name: "restored-worker" },
      state,
      created_at_ms: 1,
      updated_at_ms: 1,
    }),
  )
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  captured: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`condition timed out; captured ${JSON.stringify(captured().slice(-4_000))}`)
    }
    await Bun.sleep(20)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

/**
 * How many times the fake fx's banner was drawn. The renderer positions
 * the cursor between words, so the banner is found in the text the escape
 * sequences leave behind rather than as one string.
 */
function readyBanners(output: string): number {
  const text = output
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-9;?<>=]*[A-Za-z]/g, " ")
  return text.match(/fake\s+fx\s+ready/g)?.length ?? 0
}

async function readLifecycle(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}
