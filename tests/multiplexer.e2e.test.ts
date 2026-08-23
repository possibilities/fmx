import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadManifest } from "../src/instance-manifest.ts"
import { SIDEBAR_DEFAULT_WIDTH } from "../src/multiplexer.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { COMPANION_BINARY_NAME, homeIdFor } from "../src/zmx-environment.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_FX = resolve(ROOT, "tests/fixtures/fake-fx.ts")
const FMX_COMMAND = process.env.FMX_BINARY_PATH
  ? [resolve(ROOT, process.env.FMX_BINARY_PATH)]
  : [process.execPath, "src/index.ts"]

const control = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64

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
  "multiplexer uses configured bindings and leaves PTY exits to fx",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-e2e-"))
    const lifecycleLog = join(tempDirectory, "lifecycle.log")
    const configFile = join(tempDirectory, "config.toml")
    await writeFile(configFile, '[keys]\nprefix = "ctrl+space"\n')

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
    const configFile = join(tempDirectory, "missing-config.toml")

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
    const configFile = join(tempDirectory, "missing-config.toml")

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

for (const signal of ["SIGQUIT", "SIGKILL"] as const) {
  test.skipIf(!PTY_TEST_ENABLED)(
    `${signal} leaves every fx running, and the next fmx restores them`,
    async () => {
      await chmod(FAKE_FX, 0o755)
      const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-restart-e2e-"))
      const lifecycleLog = join(tempDirectory, "lifecycle.log")
      const configFile = join(tempDirectory, "missing-config.toml")
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
      const decoder = new TextDecoder()
      const spawnFmx = (sink: { output: string }) =>
        Bun.spawn(FMX_COMMAND, {
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
        const code = await withTimeout(one.exited, 6_000, `fmx did not exit after ${signal}`)
        expect(code).toBe(signal === "SIGQUIT" ? 131 : 137)
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
        const second = { output: "" }
        two = spawnFmx(second)
        await waitUntil(() => readyBanners(second.output) >= 1, 10_000, () => second.output)
        await Bun.sleep(300)
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
