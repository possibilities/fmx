import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_FX = resolve(ROOT, "tests/fixtures/fake-fx.ts")

const control = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64

const PTY_TEST_ENABLED = process.env.FMX_RUN_PTY_TESTS === "1" && typeof Bun.Terminal === "function"

test.skipIf(!PTY_TEST_ENABLED)(
  "multiplexer suspends, creates tabs, and gracefully closes every PTY",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-e2e-"))
    const lifecycleLog = join(tempDirectory, "lifecycle.log")

    let output = ""
    const decoder = new TextDecoder()
    const child = Bun.spawn([process.execPath, "src/index.ts", "--fx", FAKE_FX], {
      cwd: ROOT,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FMX_TEST_LOG: lifecycleLog,
        FMX_TEST_HEARTBEAT: "1",
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

      child.terminal?.write(Uint8Array.of(control("b"), control("b")))
      await waitUntil(
        async () => (await readLifecycle(lifecycleLog)).includes("literal-prefix 1"),
        5_000,
        () => output,
      )

      child.terminal?.write(Uint8Array.of(control("b"), control("c")))
      await Bun.sleep(100)
      expect(await readLifecycle(lifecycleLog)).not.toContain("start 2")

      child.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("start 2"), 5_000, () => output)

      if (process.platform !== "win32") {
        await waitUntil(
          async () => {
            const lifecycle = await readLifecycle(lifecycleLog)
            return lifecycle.includes("alive 1") && lifecycle.includes("alive 2")
          },
          5_000,
          () => output,
        )
        child.terminal?.write(Uint8Array.of(control("z")))
        await Bun.sleep(120)
        const lifecycleWhileStopped = await readLifecycle(lifecycleLog)
        const aliveBeforeContinue = [
          countOccurrences(lifecycleWhileStopped, "alive 1"),
          countOccurrences(lifecycleWhileStopped, "alive 2"),
        ]
        await Bun.sleep(100)
        const lifecycleStillStopped = await readLifecycle(lifecycleLog)
        expect(countOccurrences(lifecycleStillStopped, "alive 1")).toBe(aliveBeforeContinue[0])
        expect(countOccurrences(lifecycleStillStopped, "alive 2")).toBe(aliveBeforeContinue[1])
        process.kill(child.pid, "SIGCONT")
        await waitUntil(
          async () => {
            const lifecycle = await readLifecycle(lifecycleLog)
            return (
              countOccurrences(lifecycle, "alive 1") > aliveBeforeContinue[0]! &&
              countOccurrences(lifecycle, "alive 2") > aliveBeforeContinue[1]!
            )
          },
          5_000,
          () => output,
        )
      }

      child.terminal?.write(Uint8Array.of(control("b"), "p".charCodeAt(0)))
      await Bun.sleep(100)
      child.terminal?.write(Uint8Array.of(control("b"), "x".charCodeAt(0)))
      child.terminal?.write(new TextEncoder().encode("u"))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 1"), 5_000, () => output)
      const lifecycleAfterClose = await readLifecycle(lifecycleLog)
      expect(lifecycleAfterClose).toContain("terminal-response 1")
      expect(lifecycleAfterClose).not.toContain("unexpected-input 1")

      child.terminal?.write(Uint8Array.of(control("b"), "R".charCodeAt(0)))
      await waitUntil(
        async () => (await readLifecycle(lifecycleLog)).includes('start 3 ["--resume-last"]'),
        5_000,
        () => output,
      )

      child.terminal?.write(Uint8Array.of(control("b"), "r".charCodeAt(0)))
      await waitUntil(
        async () => (await readLifecycle(lifecycleLog)).includes('start 4 ["-r"]'),
        5_000,
        () => output,
      )

      child.terminal?.write(Uint8Array.of(control("b"), "q".charCodeAt(0)))
      const code = await withTimeout(child.exited, 6_000, "fmx did not exit")
      const lifecycle = await readLifecycle(lifecycleLog)
      expect(code).toBe(0)
      expect(lifecycle).toContain("graceful 2")
      expect(lifecycle).toContain("graceful 3")
      expect(lifecycle).toContain("graceful 4")
      expect(lifecycle).toContain("terminal-response 2")
      expect(lifecycle).toContain("terminal-response 3")
      expect(lifecycle).toContain("terminal-response 4")
      expect(output).toContain("fake session")
    } finally {
      if (child.exitCode === null) {
        if (process.platform !== "win32") {
          try {
            process.kill(child.pid, "SIGCONT")
            await Bun.sleep(20)
          } catch {
            // The child may have exited while the test was unwinding.
          }
        }
        child.kill("SIGKILL")
      }
      child.terminal?.close()
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  25_000,
)

test.skipIf(!PTY_TEST_ENABLED || process.platform === "win32")(
  "SIGQUIT gracefully shuts down every PTY",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const tempDirectory = await mkdtemp(join(tmpdir(), "fmx-signal-e2e-"))
    const lifecycleLog = join(tempDirectory, "lifecycle.log")

    let output = ""
    const decoder = new TextDecoder()
    const child = Bun.spawn([process.execPath, "src/index.ts", "--fx", FAKE_FX], {
      cwd: ROOT,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
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
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("start 1"), 8_000, () => output)
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
