import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageMetadata from "../package.json" with { type: "json" }
import { parseArgs, UsageError, usage, VERSION } from "../src/cli.ts"

describe("parseArgs", () => {
  test("rejects anything other than fmx options", () => {
    expect(parseArgs([])).toEqual({ help: false, version: false, doctor: false, command: null, socket: null })
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
  } finally {
    child.terminal?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

describe("commands", () => {
  test("a bare invocation is the TUI, a word is a command", () => {
    expect(parseArgs([]).command).toBeNull()
    expect(parseArgs(["doctor"])).toMatchObject({ doctor: true, command: null })
    expect(() => parseArgs(["doctor", "now"])).toThrow("unexpected argument: now")
    expect(() => parseArgs(["orient"])).toThrow("Commands: control, doctor.")
    expect(parseArgs(["control", "orient"]).command).toEqual({ name: "orient" })
    expect(parseArgs(["control", "detach"]).command).toEqual({ name: "detach" })
    expect(() => parseArgs(["control", "detach", "now"])).toThrow("unexpected argument: now")
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
      editable: false,
      wait: false,
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

  test("an editable launch may wait; a plain one may not", () => {
    expect(parseArgs(["control", "launch", "--editable", "--wait", "--timeout", "500"]).command).toMatchObject({
      editable: true,
      wait: true,
      timeoutMs: 500,
    })
    expect(() => parseArgs(["control", "launch", "--wait"])).toThrow("--wait only applies with --editable")
  })

  test("draft verbs take an id where they change something", () => {
    expect(parseArgs(["control", "draft", "show"]).command).toEqual({ name: "draft", verb: "show" })
    expect(parseArgs([
      "control",
      "draft",
      "set",
      "d1",
      "--no-worktree",
      "--prompt",
      "x",
      "--model",
      "gpt-5.5",
      "--effort",
      "xhigh",
    ]).command).toEqual({
      name: "draft",
      verb: "set",
      draft: "d1",
      fields: { worktree: false, prompt: { inline: "x" }, model: "gpt-5.5", effort: "xhigh" },
    })
    expect(parseArgs(["control", "draft", "submit", "d1"]).command).toEqual({ name: "draft", verb: "submit", draft: "d1" })
    expect(() => parseArgs(["control", "draft", "submit"])).toThrow("needs a draft id")
    expect(() => parseArgs(["control", "draft", "set", "d1"])).toThrow("needs a field")
    expect(() => parseArgs(["control", "draft", "set", "d1", "--worktree", "--no-worktree"])).toThrow("contradict")
  })

  test("instance wait defaults to the caller and splits states on commas", () => {
    expect(parseArgs(["control", "instance", "wait"]).command).toEqual({ name: "instance", verb: "wait", target: "current" })
    expect(parseArgs(["control", "instance", "wait", "3", "--state", "done,blocked", "--state", "idle"]).command).toMatchObject({
      target: "3",
      states: ["done", "blocked", "idle"],
    })
    expect(parseArgs(["control", "instance", "send", "3", "-"]).command).toEqual({
      name: "instance",
      verb: "send",
      target: "3",
      text: { stdin: true },
    })
    expect(() => parseArgs(["control", "instance", "send", "3"])).toThrow("needs text")
  })

  test("takes the socket anywhere on the line", () => {
    expect(parseArgs(["--socket", "/tmp/x.ctl", "control", "orient"]).socket).toBe("/tmp/x.ctl")
    expect(parseArgs(["control", "focus", "next", "--socket=/tmp/x.ctl"]).socket).toBe("/tmp/x.ctl")
  })

  test("keys, focus, and sidebar", () => {
    expect(parseArgs(["control", "keys", "--show"]).command).toEqual({ name: "keys", show: true })
    expect(parseArgs(["control", "catalog"]).command).toEqual({ name: "catalog" })
    expect(parseArgs(["control", "focus", "next"]).command).toEqual({ name: "focus", target: "next" })
    expect(parseArgs(["control", "sidebar", "--width", "30"]).command).toEqual({ name: "sidebar", width: 30 })
    expect(parseArgs(["control", "sidebar", "--hide"]).command).toEqual({ name: "sidebar", hidden: true })
    expect(parseArgs(["control", "sidebar", "--toggle"]).command).toEqual({ name: "sidebar", toggle: true })
    expect(() => parseArgs(["control", "sidebar", "--show", "--hide"])).toThrow("contradict")
    expect(() => parseArgs(["control", "sidebar", "--width", "wide"])).toThrow("whole number")
  })

  test("a usage error names its topic", () => {
    try {
      parseArgs(["control", "draft", "fold"])
      throw new Error("expected a usage error")
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError)
      expect((error as UsageError).topic).toBe("draft")
    }
    expect(usage("draft")).toContain("submit <id>")
    expect(usage("control")).toContain("orient")
    expect(usage()).toContain("fmx control")
  })
})
