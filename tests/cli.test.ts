import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageMetadata from "../package.json" with { type: "json" }
import { parseArgs, UsageError, usage, VERSION } from "../src/cli.ts"

describe("parseArgs", () => {
  test("rejects anything other than fmx options", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      version: false,
      doctor: false,
      bus: null,
      command: null,
      socket: null,
    })
    expect(() => parseArgs(["--record"])).toThrow("unknown option")
    expect(() => parseArgs(["--", "--record"])).toThrow("unknown option: --")
  })

  test("parses help and version flags", () => {
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--version"]).version).toBe(true)
  })

  test("uses the package version", () => {
    expect(VERSION).toBe(packageMetadata.version)
  })
})

test.skipIf(typeof Bun.Terminal !== "function")("the TUI exits 1 with the config line when no project roots are configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-no-roots-"))
  const path = join(directory, "config.toml")
  let output = ""
  const decoder = new TextDecoder()
  const child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      FMX_CONFIG_PATH: path,
      FMX_FX_PATH: join(directory, "missing-fx"),
    },
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, bytes) => {
        output += decoder.decode(bytes, { stream: true })
      },
    },
  })

  try {
    expect(await child.exited).toBe(1)
    expect(output).toContain(`fmx: no project roots configured; add project_roots = ["~/code"] to ${path}`)
    expect(output).not.toContain("missing-fx")
    expect(output.startsWith("\x1b[?25l")).toBe(true)
    expect(output.indexOf("\x1b[?25h")).toBeGreaterThan(output.indexOf("\x1b[?25l"))
  } finally {
    child.terminal?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test.skipIf(typeof Bun.Terminal !== "function")("a signal during concealed Client preflight restores the cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-preflight-signal-"))
  const path = join(directory, "config.toml")
  expect(await Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0)
  let output = ""
  const decoder = new TextDecoder()
  const concealed = Promise.withResolvers<void>()
  const child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, FMX_CONFIG_PATH: path },
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, bytes) => {
        output += decoder.decode(bytes, { stream: true })
        if (output.includes("\x1b[?25l")) concealed.resolve()
      },
    },
  })

  try {
    await withTimeout(concealed.promise, 2_000, "Client did not conceal during preflight")
    child.kill("SIGTERM")
    expect(await withTimeout(child.exited, 2_000, "Client did not terminate after SIGTERM")).toBe(143)
    const conceal = output.indexOf("\x1b[?25l")
    expect(conceal).toBeGreaterThanOrEqual(0)
    expect(output.indexOf("\x1b[?25h", conceal)).toBeGreaterThan(conceal)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    child.terminal?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

describe("commands", () => {
  test("a bare invocation is the TUI, a word is a command", () => {
    expect(parseArgs([]).command).toBeNull()
    expect(parseArgs(["doctor"])).toMatchObject({ doctor: true, command: null })
    expect(() => parseArgs(["doctor", "now"])).toThrow("unexpected argument: now")
    expect(() => parseArgs(["orient"])).toThrow("Commands: control, bus, doctor.")
    expect(parseArgs(["control", "orient"]).command).toEqual({ name: "orient" })
    expect(() => parseArgs(["control", "detach"])).toThrow("unknown control command: detach")
    expect(() => parseArgs(["orient"])).toThrow("unknown command: orient")
    expect(() => parseArgs(["control"])).toThrow("control needs a command")
    expect(() => parseArgs(["control", "pane"])).toThrow("unknown control command: pane")
  })

  test("reads launch fields, with a positional prompt", () => {
    const options = parseArgs([
      "control",
      "launch",
      "fix the tests",
      "--project",
      "~/code/fmx",
      "--worktree",
      "--model",
      "gpt-5.6-luna",
      "--effort",
      "max",
      "--focus",
    ])
    expect(options.command).toEqual({
      name: "launch",
      fields: {
        directory: "~/code/fmx",
        worktree: true,
        prompt: { inline: "fix the tests" },
        model: "gpt-5.6-luna",
        effort: "max",
      },
      focus: true,
    })
    expect(parseArgs(["control", "launch", "--prompt-file", "brief.md"]).command).toMatchObject({
      fields: { prompt: { file: "brief.md" } },
    })
    expect(parseArgs(["control", "launch", "--prompt", "-"]).command).toMatchObject({ fields: { prompt: { stdin: true } } })
  })

  test("rejects fx arguments after the separator", () => {
    expect(() => parseArgs(["control", "launch", "--", "--record"])).toThrow("unknown option: --")
    expect(() => parseArgs(["control", "orient", "--", "--record"])).toThrow("unexpected argument: --")
  })

  test("has no editable or draft launch surface", () => {
    expect(() => parseArgs(["control", "launch", "--editable"])).toThrow("unknown option: --editable")
    expect(() => parseArgs(["control", "draft"])).toThrow("unknown control command: draft")
  })

  test("agent wait defaults to the caller and splits states on commas", () => {
    expect(parseArgs(["control", "agent", "wait"]).command).toEqual({ name: "agent", verb: "wait", target: "current" })
    expect(parseArgs(["control", "agent", "wait", "3", "--state", "done,blocked", "--state", "idle"]).command).toMatchObject({
      target: "3",
      states: ["done", "blocked", "idle"],
    })
    expect(parseArgs(["control", "agent", "send", "3", "-"]).command).toEqual({
      name: "agent",
      verb: "send",
      target: "3",
      text: { stdin: true },
    })
    expect(() => parseArgs(["control", "agent", "send", "3"])).toThrow("needs text")
  })

  test("takes the socket anywhere on the line", () => {
    expect(parseArgs(["--socket", "/tmp/x.bus", "control", "orient"]).socket).toBe("/tmp/x.bus")
    expect(parseArgs(["control", "focus", "next", "--socket=/tmp/x.bus"]).socket).toBe("/tmp/x.bus")
  })

  test("subscribes to Bus state by default and opts into safe or raw activity", () => {
    expect(parseArgs(["bus"]).bus).toEqual({ activity: false, rawPayloads: false })
    expect(parseArgs(["bus", "--activity"]).bus).toEqual({ activity: true, rawPayloads: false })
    expect(parseArgs(["bus", "--raw-payloads"]).bus).toEqual({ activity: true, rawPayloads: true })
    expect(parseArgs(["bus", "--socket", "/tmp/fmx.bus"]).socket).toBe("/tmp/fmx.bus")
    expect(() => parseArgs(["bus", "later"])).toThrow("unexpected argument: later")
    expect(() => parseArgs(["observe"])).toThrow("unknown command: observe")
  })

  test("keys, focus, and tray", () => {
    expect(parseArgs(["control", "keys", "--show"]).command).toEqual({ name: "keys", show: true })
    expect(parseArgs(["control", "catalog"]).command).toEqual({ name: "catalog" })
    expect(parseArgs(["control", "focus", "next"]).command).toEqual({ name: "focus", target: "next" })
    expect(parseArgs(["control", "tray", "--width", "30"]).command).toEqual({ name: "tray", width: 30 })
    expect(parseArgs(["control", "tray", "--hide"]).command).toEqual({ name: "tray", hidden: true })
    expect(parseArgs(["control", "tray", "--toggle"]).command).toEqual({ name: "tray", toggle: true })
    expect(() => parseArgs(["control", "tray", "--show", "--hide"])).toThrow("contradict")
    expect(() => parseArgs(["control", "tray", "--width", "wide"])).toThrow("whole number")
  })

  test("a usage error names its topic", () => {
    try {
      parseArgs(["control", "focus"])
      throw new Error("expected a usage error")
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError)
      expect((error as UsageError).topic).toBe("focus")
    }
    expect(usage("control")).toContain("orient")
    expect(usage()).toContain("fmx control")
  })
})

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
