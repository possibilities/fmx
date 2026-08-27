import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultAdeSocketPath } from "../src/ade-events.ts"
import { BusSocket } from "../src/bus-socket.ts"
import { runCommand } from "../src/control-client.ts"
import type { Snapshot } from "../src/control-protocol.ts"
import { loadManifest } from "../src/agent-manifest.ts"
import { TRAY_DEFAULT_WIDTH } from "../src/multiplexer.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { COMPANION_BINARY_NAME, homeIdFor } from "../src/zmx-environment.ts"
import { initRepository } from "./fixtures/git-workspace.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_FX = resolve(ROOT, "tests/fixtures/fake-fx.ts")
const FMX_COMMAND = process.env.FMX_BINARY_PATH
  ? [resolve(ROOT, process.env.FMX_BINARY_PATH)]
  : [process.execPath, resolve(ROOT, "src/index.ts")]

const configWithRoot = (extra = "") => `project_roots = [${JSON.stringify(ROOT)}]\n${extra}`

const control = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64

/** Start an Agent through the Bus, as `fmx control launch` does. */
async function launchAgent(tempDirectory: string): Promise<void> {
  await waitUntil(() => orientation(tempDirectory, process.env).then(Boolean), 8_000, () => "")
  const socket = BusSocket.pathFor(defaultAdeSocketPath(homeOf(tempDirectory)))
  const outcome = await runCommand(
    { name: "launch", fields: {}, focus: true },
    socket,
    { env: process.env, cwd: ROOT, readStdin: async () => "" },
  )
  if (outcome.exitCode !== 0) throw new Error(outcome.error?.message ?? "launch failed")
}

const RESTORED_SESSION_A = "1787368596567-1787368596567934000-ba9a9f7e16e5ef8c"
const RESTORED_SESSION_B = "1787368597000-1787368597000000000-cccccccccccccccc"
const RESTORED_CHILD = "1787368609310-1787368609310138000-3e38dc7a8d7c16c2"

// The embedded terminal starts past the tray and its one-column divider, so
// a drag aimed at fx must be addressed there rather than at the screen origin.
const TERMINAL_ORIGIN_COLUMN = TRAY_DEFAULT_WIDTH + 2

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
const companionDirectoryFor = (tempDirectory: string) =>
  `/tmp/fmxz-${createHash("sha256").update(basename(tempDirectory)).digest("hex").slice(0, 12)}`

/** The environment that keeps one fmx run private to its temp directory. */
function privateHome(tempDirectory: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(tempDirectory, "config"),
    FMX_ZMX_PATH: COMPANION!,
    FMX_ZMX_DIR: companionDirectoryFor(tempDirectory),
    FMX_MANIFEST_PATH: join(tempDirectory, "agents.json"),
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
  "prefix+d detaches the Client and leaves its fx running",
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
      await waitUntil(() => output.includes("no agents"), 8_000, () => output)
      expect(output.startsWith("\x1b[?25l")).toBe(true)
      expect(output).not.toContain("\x1bc")
      const synchronizedSetup = output.indexOf("\x1b[?2026h\x1b[?25l")
      const alternateScreen = output.indexOf("\x1b[?1049h")
      const firstContent = output.indexOf("no agents")
      expect(synchronizedSetup).toBeGreaterThanOrEqual(0)
      expect(alternateScreen).toBeGreaterThan(synchronizedSetup)
      expect(firstContent).toBeGreaterThan(alternateScreen)
      expect(output.indexOf("\x1b[?2026l", firstContent)).toBeGreaterThan(firstContent)
      await launchAgent(tempDirectory)
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => output)
      await waitUntil(
        async () => (await loadManifest(join(tempDirectory, "agents.json"), homeOf(tempDirectory))).agents[0]?.phase === "running",
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
      expect((await loadManifest(join(tempDirectory, "agents.json"), homeOf(tempDirectory))).agents).toMatchObject([
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
  "multiple Clients share one Runtime and hand off sizing ownership",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-multi-client-e2e-"))
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
    const companion = new CompanionCommand(companionDirectoryFor(tempDirectory), process.env, COMPANION!)
    const runtimeSession = async () =>
      (await companion.list()).find(
        (session) => session.labels.kind === "runtime" && session.labels.home === homeOf(tempDirectory),
      )
    const clear = "\u001b[2J\u001b[H"
    const unusedClear = `\u001b[48;5;235m${clear}\u001b[0m`
    const atomicResizeStart = `\u001b[?2026h\u001b[?25l${unusedClear}\u001b[?2026h`

    const firstOutput = { output: "" }
    const first = spawnClient(firstOutput, 100, 24)
    let second: ReturnType<typeof spawnClient> | null = null
    try {
      await waitUntil(() => firstOutput.output.includes("no agents"), 8_000, () => firstOutput.output)
      expect(firstOutput.output.startsWith("\x1b[?25l")).toBe(true)
      expect(firstOutput.output).not.toContain("\x1bc")
      const initial = await orientation(tempDirectory, env)
      expect(initial?.fmx).toMatchObject({ cols: 100, rows: 24 })
      const runtimePid = initial!.fmx.pid
      await waitUntil(async () => (await runtimeSession())?.clients === 1, 5_000, () => firstOutput.output)

      // Attach is ownership. The 60x16 Client makes the shared Runtime 60x16;
      // the 100x24 Client gets a tinted full clear followed by only that
      // smaller frame, which leaves its right and bottom margins visibly unused.
      const firstClears = countOccurrences(firstOutput.output, clear)
      const secondOutput = { output: "" }
      second = spawnClient(secondOutput, 60, 16)
      await waitUntil(
        async () => {
          const snapshot = await orientation(tempDirectory, env)
          return snapshot?.fmx.pid === runtimePid && snapshot.fmx.cols === 60 && snapshot.fmx.rows === 16
        },
        8_000,
        () => `${firstOutput.output}\n--- second ---\n${secondOutput.output}`,
      )
      await waitUntil(() => countOccurrences(firstOutput.output, clear) > firstClears, 5_000, () => firstOutput.output)
      expect(firstOutput.output).toContain(unusedClear)
      expect(secondOutput.output.startsWith("\x1b[?25l")).toBe(true)
      expect(secondOutput.output).toContain("\x1bc\x1b[?25l")
      expect((await runtimeSession())?.clients).toBe(2)

      // A key from the larger Client takes sizing before it reaches fmx. The
      // confirmation must therefore render at 100x24 immediately: an old-size
      // frame after the clear would flash as a small dark island in the unused
      // field before OpenTUI's debounced resize catches up.
      const smallFrameOffset = firstOutput.output.lastIndexOf(unusedClear)
      await waitUntil(
        () => firstOutput.output.slice(smallFrameOffset).includes("no agents"),
        5_000,
        () => firstOutput.output.slice(smallFrameOffset),
      )
      await Bun.sleep(50)
      const secondClears = countOccurrences(secondOutput.output, clear)
      const takeoverOffset = firstOutput.output.length
      first.terminal?.write(new TextEncoder().encode("\x1b[99;5u"))
      await waitUntil(
        async () => {
          const snapshot = await orientation(tempDirectory, env)
          return snapshot?.fmx.cols === 100 && snapshot.fmx.rows === 24
        },
        5_000,
        () => secondOutput.output,
      )
      await waitUntil(() => countOccurrences(secondOutput.output, clear) > secondClears, 5_000, () => secondOutput.output)
      await waitUntil(
        () => firstOutput.output.slice(takeoverOffset).includes("press ctrl+c again to exit"),
        5_000,
        () => firstOutput.output.slice(takeoverOffset),
      )
      const takeoverOutput = firstOutput.output.slice(takeoverOffset)
      expect(takeoverOutput).toContain("\x1b[12;38H")
      expect(takeoverOutput).not.toContain("\x1b[8;18H")

      // Resizing a non-owner is interaction and immediately takes ownership.
      second.terminal?.resize(70, 18)
      await waitUntil(
        async () => {
          const snapshot = await orientation(tempDirectory, env)
          return snapshot?.fmx.cols === 70 && snapshot.fmx.rows === 18
        },
        5_000,
        () => secondOutput.output,
      )

      // Passive mouse motion returns ownership to the remembered 100x24 size.
      // OpenTUI asks for all-motion SGR tracking, so merely moving over an
      // observing Client behaves like tmux: the 70x18 Client receives the same
      // larger frame and crops its unreachable right and bottom. The clear
      // homes the cursor, so it must conceal it until the resized frame has
      // restored the cursor at its real UI position.
      const mouseTakeoverOffset = firstOutput.output.length
      first.terminal?.write(new TextEncoder().encode("\x1b[<35;10;5M"))
      await waitUntil(
        async () => {
          const snapshot = await orientation(tempDirectory, env)
          return snapshot?.fmx.cols === 100 && snapshot.fmx.rows === 24
        },
        5_000,
        () => firstOutput.output,
      )
      await waitUntil(
        () => firstOutput.output.slice(mouseTakeoverOffset).includes(atomicResizeStart),
        5_000,
        () => firstOutput.output.slice(mouseTakeoverOffset),
      )

      // Put the second Client back in ownership so focus gain can prove it
      // takes sizing too, and so it remains the failover size after Detach.
      second.terminal?.write(new TextEncoder().encode("\x1b[<35;10;5M"))
      await waitUntil(
        async () => {
          const snapshot = await orientation(tempDirectory, env)
          return snapshot?.fmx.cols === 70 && snapshot.fmx.rows === 18
        },
        5_000,
        () => secondOutput.output,
      )

      // Focus gain also takes ownership; focus loss deliberately does not.
      // Detaching that owner locally leaves the surviving Client connected and
      // immediately restores its remembered dimensions.
      first.terminal?.write(new TextEncoder().encode("\x1b[I"))
      await waitUntil(
        async () => {
          const snapshot = await orientation(tempDirectory, env)
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
          const snapshot = await orientation(tempDirectory, env)
          return snapshot?.fmx.pid === runtimePid && snapshot.fmx.cols === 70 && snapshot.fmx.rows === 18
        },
        5_000,
        () => secondOutput.output,
      )
      expect(second.exitCode).toBeNull()
      expect((await runtimeSession())?.clients).toBe(1)

      // The final local Detach ends only the Runtime. Its Client exits cleanly
      // and the opted-in Companion session stops once no terminal remains.
      second.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(second.exited, 6_000, "final Client did not detach")).toBe(0)
      second.terminal?.close()
      await waitUntil(
        async () => (await runtimeSession())?.state !== "live",
        8_000,
        () => secondOutput.output,
      )
      expect(await orientation(tempDirectory, env)).toBeNull()
    } finally {
      if (first.exitCode === null) first.kill("SIGKILL")
      first.terminal?.close()
      if (second && second.exitCode === null) second.kill("SIGKILL")
      second?.terminal?.close()
      await endSurvivors(tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  30_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "a CLI launch defaults to the first configured project root",
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
      // Only a repository is offered, and only a repository can be launched
      // into; the directory fmx is invoked from is neither.
      initRepository(firstRoot),
      initRepository(secondRoot),
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
      await waitUntil(() => output.includes("no agents"), 8_000, () => output)
      await launchAgent(tempDirectory)
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => output)
      await waitUntil(
        async () =>
          (await loadManifest(join(tempDirectory, "agents.json"), homeOf(tempDirectory))).agents.length === 1,
        5_000,
        () => output,
      )
      expect(
        (await loadManifest(join(tempDirectory, "agents.json"), homeOf(tempDirectory))).agents[0]?.cwd,
      ).toBe(await realpath(firstRoot))

      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 1"), 5_000, () => output)
      await waitUntil(() => output.includes("no agents"), 5_000, () => output)
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
  "restores agent state and tray chrome without startup flashes",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-status-restore-e2e-"))
    const projectRoot = join(tempDirectory, "root")
    const lifecycleLog = join(tempDirectory, "lifecycle.log")
    const configFile = join(tempDirectory, "config.toml")
    await initRepository(projectRoot)
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
    const spawnFmx = (sink: { output: string }, answerPalette = false) => {
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      const pendingReplies: string[] = []
      let sendHostReply: (reply: string) => void = (reply) => {
        pendingReplies.push(reply)
      }
      const respondToPaletteQueries = answerPalette
        ? createHostPaletteResponder((reply) => sendHostReply(reply))
        : null
      const child = Bun.spawn(FMX_COMMAND, {
        cwd: projectRoot,
        env,
        terminal: {
          cols: 100,
          rows: 24,
          data: (_terminal, bytes) => {
            const text = decoder.decode(bytes, { stream: true })
            sink.output += text
            respondToPaletteQueries?.(text)
          },
        },
      })
      sendHostReply = (reply) => child.terminal?.write(encoder.encode(reply))
      for (const reply of pendingReplies) sendHostReply(reply)
      return child
    }
    const manifest = () => loadManifest(join(tempDirectory, "agents.json"), homeOf(tempDirectory))
    const adeSocketPath = defaultAdeSocketPath(homeOf(tempDirectory))

    const firstOutput = { output: "" }
    const first = spawnFmx(firstOutput)
    let replacement: ReturnType<typeof spawnFmx> | null = null
    try {
      await waitUntil(() => firstOutput.output.includes("no agents"), 8_000, () => firstOutput.output)
      await launchAgent(tempDirectory)
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => firstOutput.output)
      const firstEntry = (await manifest()).agents[0]!
      await sendAdeRecord(
        adeSocketPath,
        mainAdeRecord(1, firstEntry.paneId, "FxStarted", RESTORED_SESSION_A, "idle"),
      )
      await sendAdeRecord(
        adeSocketPath,
        mainAdeRecord(2, firstEntry.paneId, "AttentionRequired", RESTORED_SESSION_A, "blocked", "question"),
      )

      await launchAgent(tempDirectory)
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 2"), 8_000, () => firstOutput.output)
      const secondEntry = (await manifest()).agents[1]!
      await sendAdeRecord(
        adeSocketPath,
        mainAdeRecord(1, secondEntry.paneId, "FxStarted", RESTORED_SESSION_B, "idle"),
      )
      await sendAdeRecord(
        adeSocketPath,
        mainAdeRecord(2, secondEntry.paneId, "TurnStarted", RESTORED_SESSION_B, "working"),
      )

      // Leave agent 2 inactive, then let its turn finish there: it must revive
      // as `done`, not collapse to either idle or unknown.
      first.terminal?.write(Uint8Array.of(control("b"), "p".charCodeAt(0)))
      await waitUntil(
        async () => (await orientation(tempDirectory, env))?.active === 1,
        5_000,
        () => firstOutput.output,
      )
      await sendAdeRecord(
        adeSocketPath,
        mainAdeRecord(3, secondEntry.paneId, "PostTurnEnd", RESTORED_SESSION_B, "idle"),
      )
      await waitUntil(
        async () => {
          const entries = (await manifest()).agents
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
        async () => (await orientation(tempDirectory, env))?.agents[1]?.subagents[0]?.state === "blocked",
        5_000,
        () => firstOutput.output,
      )

      first.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(first.exited, 6_000, "first fmx did not detach")).toBe(0)
      first.terminal?.close()

      const restoredOutput = { output: "" }
      replacement = spawnFmx(restoredOutput, true)
      let restored: Snapshot | null = null
      await waitUntil(
        async () => {
          restored = await orientation(tempDirectory, env)
          return restored?.agents.length === 2 && restored.agents[1]?.subagents.length === 1
        },
        10_000,
        () => restoredOutput.output,
      )

      expect(restored!.agents.map((agent) => [agent.state, agent.attention])).toEqual([
        ["blocked", "question"],
        ["done", null],
      ])
      expect(restored!.agents[1]!.subagents).toMatchObject([
        { session_id: RESTORED_CHILD, state: "blocked", attention: "permission" },
      ])
      await waitUntil(
        () =>
          synchronizedFrames(restoredOutput.output).some((frame) =>
            frame.includes(RESTORED_SESSION_A.split("-").at(-1)!),
          ),
        5_000,
        () => restoredOutput.output,
      )
      const firstSessionListFrame = synchronizedFrames(restoredOutput.output).find((frame) =>
        frame.includes(RESTORED_SESSION_A.split("-").at(-1)!),
      )
      expect(firstSessionListFrame).toBeDefined()
      expect(firstSessionListFrame).toContain(RESTORED_SESSION_B.split("-").at(-1)!)
      expect(firstSessionListFrame).toContain("restored-worker")
      expect(firstSessionListFrame).toContain("main")
      // Both status checkpoints are seeded in the same synchronous turn that
      // adds their rows, before OpenTUI can expose an unknown-state frame.
      expect(restoredOutput.output).not.toContain(`· ${RESTORED_SESSION_A.split("-").at(-1)}`)
      expect(restoredOutput.output).not.toContain(`· ${RESTORED_SESSION_B.split("-").at(-1)}`)

      // The host answers during the pre-display frame budget. Its OSC 11
      // luminance chooses the dark fxnk ramp, so the selected row and divider
      // must appear in their fixed indexed roles in the first restored frame.
      await waitUntil(
        () =>
          hasIndexedSgr(restoredOutput.output, "background", 236) &&
          hasIndexedSgr(restoredOutput.output, "foreground", 240),
        5_000,
        () => restoredOutput.output,
      )
      expect(hasIndexedSgr(restoredOutput.output, "background", 254)).toBe(false)
      expect(hasIndexedSgr(restoredOutput.output, "foreground", 250)).toBe(false)

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
  "reattaches with the last focused agent still selected",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-focus-restore-e2e-"))
    const lifecycleLog = join(tempDirectory, "lifecycle.log")
    const configFile = join(tempDirectory, "config.toml")
    const stateFile = join(tempDirectory, "state.json")
    await writeFile(configFile, configWithRoot())
    const env = {
      ...process.env,
      HOME: tempDirectory,
      FMX_FX_PATH: FAKE_FX,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FMX_CONFIG_PATH: configFile,
      FMX_STATE_PATH: stateFile,
      ...privateHome(tempDirectory),
      FMX_TEST_LOG: lifecycleLog,
      FMX_TEST_PASSTHROUGH_KEYS: "1",
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
    const manifest = () => loadManifest(join(tempDirectory, "agents.json"), homeOf(tempDirectory))

    const firstOutput = { output: "" }
    const first = spawnFmx(firstOutput)
    let replacement: ReturnType<typeof spawnFmx> | null = null
    try {
      await waitUntil(() => firstOutput.output.includes("no agents"), 8_000, () => firstOutput.output)
      await launchAgent(tempDirectory)
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => firstOutput.output)
      await launchAgent(tempDirectory)
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 2"), 8_000, () => firstOutput.output)

      // Exercise an actual selection change, ending on agent 2.
      first.terminal?.write(Uint8Array.of(control("b"), "p".charCodeAt(0)))
      await waitUntil(
        async () => (await orientation(tempDirectory, env))?.active === 1,
        5_000,
        () => firstOutput.output,
      )
      first.terminal?.write(Uint8Array.of(control("b"), "n".charCodeAt(0)))
      await waitUntil(
        async () => (await orientation(tempDirectory, env))?.active === 2,
        5_000,
        () => firstOutput.output,
      )
      const second = (await manifest()).agents.find((entry) => entry.displayId === 2)!

      first.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(first.exited, 6_000, "first fmx did not detach")).toBe(0)
      first.terminal?.close()
      expect(JSON.parse(await readFile(stateFile, "utf8")).activeAgentId).toBe(second.agentId)

      const restoredOutput = { output: "" }
      replacement = spawnFmx(restoredOutput)
      let restored: Snapshot | null = null
      await waitUntil(
        async () => {
          restored = await orientation(tempDirectory, env)
          return restored?.agents.length === 2 && restored.active === 2
        },
        10_000,
        () => restoredOutput.output,
      )
      expect(restored!.agents.map((agent) => [agent.id, agent.active])).toEqual([
        [1, false],
        [2, true],
      ])
      expect(
        restored!.tray.rows
          .filter((row) => row.kind === "agent")
          .map((row) => [row.agent, row.active]),
      ).toEqual([
        [2, true],
        [1, false],
      ])

      // Focus is functional, not only painted: unprefixed input goes straight
      // to the restored selection.
      replacement.terminal?.write(Uint8Array.of(control("u")))
      await waitUntil(
        async () => (await readLifecycle(lifecycleLog)).includes("ctrl-u 2"),
        5_000,
        () => restoredOutput.output,
      )
      expect(await readLifecycle(lifecycleLog)).not.toContain("ctrl-u 1")

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
        // Machine state stays in the temp directory: a tray width persisted
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
      await waitUntil(() => output.includes("no agents"), 8_000, () => output)
      await launchAgent(tempDirectory)
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
      await launchAgent(tempDirectory)
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

      const emptyStateBeforeExit = countOccurrences(output, "no agents")
      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(
        async () => (await readLifecycle(lifecycleLog)).includes("terminal-response 2"),
        5_000,
        () => output,
      )
      await waitUntil(
        () => countOccurrences(output, "no agents") > emptyStateBeforeExit,
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
        // Machine state stays in the temp directory: a tray width persisted
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
      await waitUntil(() => output.includes("no agents"), 8_000, () => output)
      await launchAgent(tempDirectory)
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => output)
      await launchAgent(tempDirectory)
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

      const emptyStateBeforeExit = countOccurrences(output, "no agents")
      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 1"), 5_000, () => output)
      await waitUntil(
        () => countOccurrences(output, "no agents") > emptyStateBeforeExit,
        5_000,
        () => output,
      )
      expect(child.exitCode).toBeNull()

      // The empty state is rendered synchronously with agent removal; give
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
  "resolves fxnk from OSC 11 before first paint and keeps embedded fx synchronized",
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
    let delayedFirstReply = true
    let outputBeforePaletteReply = ""
    const firstThemeReply = Promise.withResolvers<void>()
    const respondToPaletteQueries = createHostPaletteResponder(
      (reply) => {
        if (!delayedFirstReply) {
          sendHostReply(reply)
          return
        }
        delayedFirstReply = false
        setTimeout(() => {
          outputBeforePaletteReply = output
          sendHostReply(reply)
          firstThemeReply.resolve()
        }, 80)
      },
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
        // Machine state stays in the temp directory: a tray width persisted
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
          for (let index = 0; index < countOccurrences(text, "\x1b[c"); index += 1) {
            sendHostReply("\x1b[?1;2c")
          }
        },
      },
    })
    sendHostReply = (reply) => child.terminal?.write(encoder.encode(reply))
    for (const reply of pendingReplies) sendHostReply(reply)

    try {
      await withTimeout(firstThemeReply.promise, 2_000, "fmx did not query OSC 11")
      // The theme is resolved before OpenTUI exposes a frame, so there is no
      // fallback-dark frame for a late answer to retint.
      expect(outputBeforePaletteReply).not.toContain("no agents")

      await waitUntil(() => output.includes("no agents"), 8_000, () => output)
      expect(output).toContain("\x1b[38;5;245m")
      expect(output).not.toContain("\x1b]4;")
      await launchAgent(tempDirectory)
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
      expect(output).toContain("\x1b[38;5;247m")

      const emptyStateBeforeExit = countOccurrences(output, "no agents")
      child.terminal?.write(Uint8Array.of(control("c"), control("c")))
      await waitUntil(
        () => countOccurrences(output, "no agents") > emptyStateBeforeExit,
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
      const stateFile = join(tempDirectory, "state.json")
      await writeFile(configFile, configWithRoot())
      const env = {
        ...process.env,
        FMX_FX_PATH: FAKE_FX,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FMX_CONFIG_PATH: configFile,
        FMX_STATE_PATH: stateFile,
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
      const manifest = () => loadManifest(join(tempDirectory, "agents.json"), homeOf(tempDirectory))
      const heartbeats = async (id: number) => countOccurrences(await readLifecycle(lifecycleLog), `alive ${id} `)

      const first = { output: "" }
      const one = spawnFmx(first)
      let two: ReturnType<typeof spawnFmx> | null = null
      try {
        await waitUntil(() => first.output.includes("no agents"), 8_000, () => first.output)
        await launchAgent(tempDirectory)
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => first.output)
        await launchAgent(tempDirectory)
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 2"), 8_000, () => first.output)
        // Both claims are acknowledged before fmx is taken down.
        await waitUntil(
          async () => {
            const entries = (await manifest()).agents
            return entries.length === 2 && entries.every((entry) => entry.phase === "running")
          },
          5_000,
          () => first.output,
        )

        // Make agent 1 the last selection and wait for its stable identity to
        // land before SIGKILL gets a chance to bypass normal cleanup.
        one.terminal?.write(Uint8Array.of(control("b"), "p".charCodeAt(0)))
        await waitUntil(
          async () => (await orientation(tempDirectory, env))?.active === 1,
          5_000,
          () => first.output,
        )
        const firstAgent = (await manifest()).agents.find((entry) => entry.displayId === 1)!
        await waitUntil(
          async () => {
            try {
              return JSON.parse(await readFile(stateFile, "utf8")).activeAgentId === firstAgent.agentId
            } catch {
              return false
            }
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
        expect((await manifest()).agents.map((entry) => entry.displayId).sort()).toEqual([1, 2])

        // The next fmx for this Home finds both, numbered as they were, and
        // shows what was on their screens; nothing is started.
        await waitUntil(() => readyBanners(second.output) >= 1, 10_000, () => second.output)
        await Bun.sleep(300)
        // The restored Agent is the first surface the renderer exposes:
        // the empty state belongs only to a Home the join found empty.
        expect(second.output).not.toContain("no agents")
        expect(await readLifecycle(lifecycleLog)).not.toContain("start 3")
        expect(countOccurrences(await readLifecycle(lifecycleLog), "start ")).toBe(2)

        // Input reaches the restored fx; its own exit still removes it.
        two.terminal?.write(Uint8Array.of(control("u")))
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ctrl-u 1"), 5_000, () => second.output)
        two.terminal?.write(Uint8Array.of(control("c"), control("c")))
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 1"), 5_000, () => second.output)
        expect(await readLifecycle(lifecycleLog)).toContain("terminal-response 1")
        await waitUntil(async () => (await manifest()).agents.length === 1, 5_000, () => second.output)
        expect((await manifest()).agents[0]?.displayId).toBe(2)

        two.terminal?.write(Uint8Array.of(control("c"), control("c")))
        await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 2"), 5_000, () => second.output)
        await waitUntil(() => second.output.includes("no agents"), 5_000, () => second.output)
        expect(two.exitCode).toBeNull()
        await Bun.sleep(250)
        two.terminal?.write(Uint8Array.of(control("c")))
        await waitUntil(() => second.output.includes("press ctrl+c again to exit"), 5_000, () => second.output)
        two.terminal?.write(Uint8Array.of(control("c")))
        expect(await withTimeout(two.exited, 6_000, "fmx did not exit after confirmed ctrl+c")).toBe(0)
        expect((await manifest()).agents).toEqual([])
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
        send(`\u001b]4;${index};${oscRgb(ansi[index] ?? "#000000")}\u0007`)
      } else {
        const index = Number(match[2])
        const color = index === 11 ? defaultBackground() : (special.get(index) ?? "#000000")
        send(`\u001b]${index};${oscRgb(color)}\u0007`)
      }
    }
    if (buffer.length > 4_096) buffer = buffer.slice(-4_096)
  }
}

function oscRgb(hex: string): string {
  const color = hex.startsWith("#") ? hex.slice(1) : hex
  const [red = "00", green = "00", blue = "00"] = color.match(/.{1,2}/gu) ?? []
  return `rgb:${red}${red}/${green}${green}/${blue}${blue}`
}

async function orientation(
  tempDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<Snapshot | null> {
  const socket = BusSocket.pathFor(defaultAdeSocketPath(homeOf(tempDirectory)))
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

/** One-way lifecycle publication, exactly as Fx writes the ADE feed. */
async function sendAdeRecord(path: string, record: Record<string, unknown>): Promise<void> {
  const connection = await Bun.connect({ unix: path, socket: { data: () => {} } })
  connection.write(`${JSON.stringify(record)}\n`)
  connection.end()
}

function mainAdeRecord(
  sequence: number,
  paneId: string,
  event: string,
  sessionId: string,
  state: "idle" | "working" | "blocked",
  attention: "permission" | "question" | "route_recovery" | null = null,
): Record<string, unknown> {
  return {
    schema_version: 1,
    sequence,
    event,
    instance_id: paneId.slice(2),
    context: {
      agent_role: "main",
      workspace_root: ROOT,
      session_id: sessionId,
      parent_session_id: null,
      agent_state: state,
      attention_kind: attention,
    },
    payload: {},
  }
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

/** Frames OpenTUI keeps hidden until each synchronized-output end marker. */
function synchronizedFrames(output: string): string[] {
  const start = "\u001b[?2026h"
  const end = "\u001b[?2026l"
  const frames: string[] = []
  let offset = 0
  for (;;) {
    const frameStart = output.indexOf(start, offset)
    if (frameStart === -1) return frames
    const frameEnd = output.indexOf(end, frameStart + start.length)
    if (frameEnd === -1) return frames
    const nextOffset = frameEnd + end.length
    frames.push(output.slice(frameStart, nextOffset))
    offset = nextOffset
  }
}

function hasIndexedSgr(
  output: string,
  layer: "foreground" | "background",
  index: number,
): boolean {
  const selector = layer === "foreground" ? 38 : 48
  return new RegExp(`\\u001b\\[[0-9;]*${selector};5;${index}(?:;|m)`, "u").test(output)
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
