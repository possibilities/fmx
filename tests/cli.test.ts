import { describe, expect, test } from "bun:test"
import packageMetadata from "../package.json" with { type: "json" }
import { parseArgs, UsageError, usage, VERSION } from "../src/cli.ts"

describe("parseArgs", () => {
  test("passes trailing arguments only after the separator", () => {
    expect(parseArgs([]).initialFxArgs).toEqual([])
    expect(parseArgs(["--", "--record"]).initialFxArgs).toEqual(["--record"])
    expect(() => parseArgs(["--record"])).toThrow("unknown option")
  })

  test("parses help and version flags", () => {
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--version"]).version).toBe(true)
  })

  test("uses the package version", () => {
    expect(VERSION).toBe(packageMetadata.version)
  })
})

describe("commands", () => {
  test("a bare invocation is the TUI, a word is a command", () => {
    expect(parseArgs([]).command).toBeNull()
    expect(parseArgs(["orient"]).command).toEqual({ name: "orient" })
    expect(() => parseArgs(["pane"])).toThrow("unknown command: pane")
  })

  test("reads launch fields, with a positional prompt", () => {
    const options = parseArgs(["launch", "fix the tests", "--project", "~/code/fmx", "--worktree", "--focus"])
    expect(options.command).toEqual({
      name: "launch",
      fields: { directory: "~/code/fmx", worktree: true, prompt: { inline: "fix the tests" } },
      focus: true,
      editable: false,
      wait: false,
      fxArgs: [],
    })
    expect(parseArgs(["launch", "--prompt-file", "brief.md"]).command).toMatchObject({
      fields: { prompt: { file: "brief.md" } },
    })
    expect(parseArgs(["launch", "--prompt", "-"]).command).toMatchObject({ fields: { prompt: { stdin: true } } })
  })

  test("passes fx arguments after the separator to launch alone", () => {
    const options = parseArgs(["launch", "--", "--record"])
    expect(options.command).toMatchObject({ name: "launch", fxArgs: ["--record"] })
    expect(options.initialFxArgs).toEqual(["--record"])
    expect(parseArgs(["orient", "--", "--record"]).initialFxArgs).toEqual([])
  })

  test("an editable launch may wait; a plain one may not", () => {
    expect(parseArgs(["launch", "--editable", "--wait", "--timeout", "500"]).command).toMatchObject({
      editable: true,
      wait: true,
      timeoutMs: 500,
    })
    expect(() => parseArgs(["launch", "--wait"])).toThrow("--wait only applies with --editable")
  })

  test("draft verbs take an id where they change something", () => {
    expect(parseArgs(["draft", "show"]).command).toEqual({ name: "draft", verb: "show" })
    expect(parseArgs(["draft", "set", "d1", "--no-worktree", "--prompt", "x"]).command).toEqual({
      name: "draft",
      verb: "set",
      draft: "d1",
      fields: { worktree: false, prompt: { inline: "x" } },
    })
    expect(parseArgs(["draft", "submit", "d1"]).command).toEqual({ name: "draft", verb: "submit", draft: "d1" })
    expect(() => parseArgs(["draft", "submit"])).toThrow("needs a draft id")
    expect(() => parseArgs(["draft", "set", "d1"])).toThrow("needs a field")
    expect(() => parseArgs(["draft", "set", "d1", "--worktree", "--no-worktree"])).toThrow("contradict")
  })

  test("instance wait defaults to the caller and splits states on commas", () => {
    expect(parseArgs(["instance", "wait"]).command).toEqual({ name: "instance", verb: "wait", target: "current" })
    expect(parseArgs(["instance", "wait", "3", "--state", "done,blocked", "--state", "idle"]).command).toMatchObject({
      target: "3",
      states: ["done", "blocked", "idle"],
    })
    expect(parseArgs(["instance", "send", "3", "-"]).command).toEqual({
      name: "instance",
      verb: "send",
      target: "3",
      text: { stdin: true },
    })
    expect(() => parseArgs(["instance", "send", "3"])).toThrow("needs text")
  })

  test("takes the socket anywhere on the line", () => {
    expect(parseArgs(["--socket", "/tmp/x.ctl", "orient"]).socket).toBe("/tmp/x.ctl")
    expect(parseArgs(["focus", "next", "--socket=/tmp/x.ctl"]).socket).toBe("/tmp/x.ctl")
  })

  test("keys, focus, and sidebar", () => {
    expect(parseArgs(["keys", "--show"]).command).toEqual({ name: "keys", show: true })
    expect(parseArgs(["focus", "next"]).command).toEqual({ name: "focus", target: "next" })
    expect(parseArgs(["sidebar", "--width", "30"]).command).toEqual({ name: "sidebar", width: 30 })
    expect(() => parseArgs(["sidebar", "--width", "wide"])).toThrow("whole number")
  })

  test("a usage error names its topic", () => {
    try {
      parseArgs(["draft", "fold"])
      throw new Error("expected a usage error")
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError)
      expect((error as UsageError).topic).toBe("draft")
    }
    expect(usage("draft")).toContain("submit <id>")
    expect(usage()).toContain("orient")
  })
})
