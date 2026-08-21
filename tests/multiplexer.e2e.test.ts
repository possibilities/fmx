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
  "multiplexer creates tabs and gracefully closes every PTY",
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

      child.terminal?.write(Uint8Array.of(control("b"), "c".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("start 2"), 5_000, () => output)

      child.terminal?.write(Uint8Array.of(control("b"), "p".charCodeAt(0)))
      await Bun.sleep(100)
      child.terminal?.write(Uint8Array.of(control("b"), "x".charCodeAt(0)))
      await waitUntil(async () => (await readLifecycle(lifecycleLog)).includes("graceful 1"), 5_000, () => output)

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
      expect(output).toContain("fake session")
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      child.terminal?.close()
      await rm(tempDirectory, { recursive: true, force: true })
    }
  },
  25_000,
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

async function readLifecycle(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}
