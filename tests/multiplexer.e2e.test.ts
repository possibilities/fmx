import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_FX = resolve(ROOT, "tests/fixtures/fake-fx.ts")
const FMX_COMMAND = process.env.FMX_BINARY_PATH
  ? [resolve(ROOT, process.env.FMX_BINARY_PATH)]
  : [process.execPath, "src/index.ts"]

const control = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64

const PTY_TEST_ENABLED = process.env.FMX_RUN_PTY_TESTS === "1" && typeof Bun.Terminal === "function"

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

      child.terminal?.write(new TextEncoder().encode("\u001b[<0;1;1M\u001b[<32;4;1M\u001b[<0;4;1m"))
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
      const copiedFakeCount = countOccurrences(output, "ZmFrZQ==")
      child.terminal?.write(new TextEncoder().encode("\u001b[<0;1;1M\u001b[<32;4;1M\u001b[<0;4;1m"))
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
      const code = await withTimeout(child.exited, 6_000, "fmx did not exit after the final fx process exited")
      const lifecycle = await readLifecycle(lifecycleLog)
      expect(code).toBe(0)
      expect(lifecycle).toContain("graceful 2")
      expect(lifecycle).toContain("terminal-response 2")
      expect(output).toContain("fake session")
      expect(output).not.toContain("invalid device status report command")
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  25_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "removes fx processes that exit normally and exits after the final one",
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
      const code = await withTimeout(child.exited, 6_000, "fmx did not exit after the final fx process exited")
      expect(code).toBe(0)
      const lifecycle = await readLifecycle(lifecycleLog)
      expect(lifecycle).toContain("graceful 1")
      expect(lifecycle).toContain("graceful 2")
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
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
      expect(await withTimeout(child.exited, 6_000, "fmx did not exit after fx exited")).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  15_000,
)

test.skipIf(!PTY_TEST_ENABLED || process.platform === "win32")(
  "SIGQUIT gracefully shuts down every PTY",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-signal-e2e-"))
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
        FMX_TEST_LOG: lifecycleLog,
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
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("ready 1"), 8_000, () => output)
      process.kill(child.pid, "SIGQUIT")
      const code = await withTimeout(child.exited, 6_000, "fmx did not exit after SIGQUIT")
      const lifecycle = await readLifecycle(lifecycleLog)
      expect(code).toBe(131)
      expect(lifecycle).toContain("terminal-response 1")
      expect(lifecycle).toContain("graceful 1")
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  15_000,
)

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

async function readLifecycle(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}
