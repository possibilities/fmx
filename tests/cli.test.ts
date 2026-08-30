import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageMetadata from "../package.json" with { type: "json" }
import { parseArgs, usage, VERSION } from "../src/cli.ts"

describe("parseArgs", () => {
  test("keeps the fmx executable to the TUI and installation diagnostics", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      version: false,
      doctor: false,
      name: null,
      agentPicker: false,
      hideSingleAgentPicker: false,
    })
    expect(parseArgs(["doctor"])).toEqual({
      help: false,
      version: false,
      doctor: true,
      name: null,
      agentPicker: false,
      hideSingleAgentPicker: false,
    })
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--version"]).version).toBe(true)
    expect(VERSION).toBe(packageMetadata.version)
    expect(packageMetadata.bin).toEqual({
      fmx: "./src/index.ts",
      "fmx-mcp": "./src/mcp.ts",
    })
  })

  test("selects one independent named fmx", () => {
    expect(parseArgs(["--name", "foo"])).toMatchObject({ name: "foo", agentPicker: false })
    expect(parseArgs(["--name=work_2", "doctor"])).toMatchObject({ doctor: true, name: "work_2" })
    expect(parseArgs(["doctor", "--name", "foo-bar"]).name).toBe("foo-bar")
    expect(parseArgs(["--name", "default"]).name).toBeNull()
    expect(usage()).toContain("--name NAME")
    expect(usage()).toContain("select an independent named fmx")
  })

  test("selects the alternate top Agent picker", () => {
    expect(parseArgs(["--agent-picker"])).toMatchObject({ agentPicker: true, name: null })
    expect(parseArgs(["--name", "review", "--agent-picker"])).toMatchObject({
      agentPicker: true,
      name: "review",
    })
    expect(usage()).toContain("--agent-picker")
    expect(usage()).toContain("use the top Agent picker instead of the Tray")
  })

  test("optionally hides an otherwise redundant single-Agent picker", () => {
    expect(parseArgs(["--hide-single-agent-picker", "--agent-picker"])).toMatchObject({
      agentPicker: true,
      hideSingleAgentPicker: true,
    })
    expect(() => parseArgs(["--hide-single-agent-picker"])).toThrow(
      "--hide-single-agent-picker requires --agent-picker",
    )
    expect(usage()).toContain("--hide-single-agent-picker")
    expect(usage()).toContain("hide the Agent picker while only one Agent runs")
  })

  test("rejects missing, repeated, and unsafe names as usage errors", () => {
    expect(() => parseArgs(["--name"])).toThrow("--name requires a value")
    expect(() => parseArgs(["--name="])).toThrow("--name requires a value")
    expect(() => parseArgs(["--name", "foo", "--name", "bar"])).toThrow("only once")
    for (const invalid of ["A", "2fast", "has.dot", "has/slash", `a${"b".repeat(32)}`]) {
      expect(() => parseArgs(["--name", invalid])).toThrow("invalid fmx name")
    }
  })

  test("has no automation or socket subcommands", () => {
    expect(() => parseArgs(["control", "orient"])).toThrow("unknown command: control")
    expect(() => parseArgs(["bus"])).toThrow("unknown command: bus")
    expect(() => parseArgs(["--socket", "/tmp/fmx.bus"])).toThrow("unknown option: --socket")
    expect(() => parseArgs(["doctor", "now"])).toThrow("unexpected argument: now")
    expect(() => parseArgs(["--record"])).toThrow("unknown option: --record")
    expect(usage()).toContain("fmx-mcp")
    expect(usage()).not.toContain("fmx control")
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
