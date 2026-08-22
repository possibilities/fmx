import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configPath, loadConfig } from "../src/config.ts"
import { actionForKey } from "../src/keybindings.ts"
import type { KeyEvent } from "@opentui/core"

test("resolves the XDG config path and explicit override", () => {
  expect(configPath({ XDG_CONFIG_HOME: "/tmp/config" }, "/home/test")).toBe("/tmp/config/fmx/config.toml")
  expect(configPath({}, "/home/test")).toBe("/home/test/.config/fmx/config.toml")
  expect(configPath({ FMX_CONFIG_PATH: "/tmp/fmx.toml" }, "/home/test")).toBe("/tmp/fmx.toml")
})

test("loads a missing config as the default bindings", async () => {
  const loaded = await loadConfig("/definitely/missing/fmx-config.toml")
  expect(loaded.diagnostics).toEqual([])
  expect(loaded.keybindings.prefixLabel).toBe("ctrl+b")
})

test("loads keys from TOML", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-"))
  const path = join(directory, "fmx", "config.toml")
  await mkdir(join(directory, "fmx"))
  await writeFile(
    path,
    `[keys]\nprefix = "ctrl+space"\nprevious_tab = ["prefix+p", "alt+1"]\n`,
  )

  try {
    const loaded = await loadConfig(path)
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.keybindings.prefixLabel).toBe("ctrl+space")
    expect(
      actionForKey(
        loaded.keybindings,
        {
          name: "1",
          sequence: "\u001b1",
          raw: "\u001b1",
          ctrl: false,
          shift: false,
          meta: true,
          option: false,
        } as KeyEvent,
        "direct",
      ),
    ).toEqual({ name: "previous_tab" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("loads project roots and diagnoses entries it cannot use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-roots-"))
  const good = join(directory, "roots.toml")
  const bad = join(directory, "bad-roots.toml")
  await writeFile(good, `project_roots = ["~/code", "~/src", "~/code"]\n`)
  await writeFile(bad, `project_roots = ["~/code", 7, ""]\n`)

  try {
    const loaded = await loadConfig(good)
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.projectRoots).toEqual(["~/code", "~/src"])

    const rejected = await loadConfig(bad)
    expect(rejected.projectRoots).toEqual(["~/code"])
    expect(rejected.diagnostics).toEqual([
      "invalid project root: 7; ignoring entry",
      'invalid project root: ""; ignoring entry',
    ])

    expect((await loadConfig("/definitely/missing/fmx-config.toml")).projectRoots).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("loads a worktree root and falls back on one it cannot use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-worktree-"))
  const good = join(directory, "worktree.toml")
  const bad = join(directory, "bad-worktree.toml")
  await writeFile(good, `worktree_root = "~/trees"\n`)
  await writeFile(bad, `worktree_root = 7\n`)

  try {
    expect((await loadConfig(good)).worktreeRoot).toBe("~/trees")
    const rejected = await loadConfig(bad)
    expect(rejected.worktreeRoot).toBe("~/.fmx/worktrees")
    expect(rejected.diagnostics).toEqual([
      "invalid worktree_root: must be a directory; using the default",
    ])
    expect((await loadConfig("/definitely/missing/fmx-config.toml")).worktreeRoot).toBe(
      "~/.fmx/worktrees",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("falls back on malformed TOML and diagnoses unknown keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-errors-"))
  const malformed = join(directory, "malformed.toml")
  const unknown = join(directory, "unknown.toml")
  await writeFile(malformed, "[keys\n")
  await writeFile(
    unknown,
    "[keys]\ndetach = \"prefix+q\"\n[theme]\nname = \"terminal\"\n",
  )

  try {
    const malformedConfig = await loadConfig(malformed)
    expect(malformedConfig.keybindings.prefixLabel).toBe("ctrl+b")
    expect(malformedConfig.diagnostics.join("\n")).toContain("config parse error")

    const unknownConfig = await loadConfig(unknown)
    expect(unknownConfig.diagnostics).toContain("unknown config key keys.detach; ignoring key")
    expect(unknownConfig.diagnostics).toContain("unknown config section [theme]; ignoring section")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("defaults naming to a small model at a cheap effort", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "fmx-config-slug-")), "empty.toml")
  await writeFile(path, "")

  const config = await loadConfig(path)
  expect(config.slug).toEqual({
    enabled: true,
    effort: "low",
    manageEffort: true,
    timeoutMs: 60_000,
    models: { codex: "gpt-5.4-mini" },
  })
})

test("loads a [slug] table and diagnoses values it cannot use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-slug-"))
  const good = join(directory, "slug.toml")
  const bad = join(directory, "bad-slug.toml")
  await writeFile(
    good,
    [
      "[slug]",
      "enabled = false",
      'effort = "medium"',
      "manage_effort = false",
      "timeout_ms = 15000",
      "[slug.models]",
      'codex = "gpt-5.4"',
      'gateway = "openai/gpt-5-mini"',
      "",
    ].join("\n"),
  )
  await writeFile(
    bad,
    ["[slug]", "enabled = 1", 'timeout_ms = "soon"', "effort = 3", "[slug.models]", "codex = 7", ""].join("\n"),
  )

  try {
    const config = await loadConfig(good)
    expect(config.slug).toEqual({
      enabled: false,
      effort: "medium",
      manageEffort: false,
      timeoutMs: 15_000,
      models: { codex: "gpt-5.4", gateway: "openai/gpt-5-mini" },
    })

    const fallback = await loadConfig(bad)
    expect(fallback.slug.enabled).toBe(true)
    expect(fallback.slug.effort).toBe("low")
    expect(fallback.slug.timeoutMs).toBe(60_000)
    expect(fallback.slug.models.codex).toBe("gpt-5.4-mini")
    expect(fallback.diagnostics).toContain("invalid slug.enabled: must be true or false; using the default")
    expect(fallback.diagnostics).toContain(
      "invalid slug.timeout_ms: must be a positive whole number; using the default",
    )
    expect(fallback.diagnostics).toContain("invalid slug.effort: must be a non-empty string; using the default")
    expect(fallback.diagnostics).toContain("invalid slug model for codex: must be a model id; ignoring entry")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
