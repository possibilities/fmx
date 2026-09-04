import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configPath, loadConfig } from "../src/config.ts"
import { keyMatchesCombo } from "../src/keybindings.ts"

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
  await writeFile(path, `[keys]\nprefix = "ctrl+space"\ndetach = ["prefix+d", "alt+1"]\n`)

  try {
    const loaded = await loadConfig(path)
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.keybindings.prefixLabel).toBe("ctrl+space")
    expect(loaded.keybindings.detach.map((binding) => binding.label)).toEqual(["prefix+d", "alt+1"])
    const space = { name: "space", sequence: "\0", raw: "\0", ctrl: true, shift: false, meta: false, option: false }
    expect(keyMatchesCombo(space as never, loaded.keybindings.prefix)).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("diagnoses a section it does not know and keeps the defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-sections-"))
  const path = join(directory, "config.toml")
  await writeFile(path, `project_roots = ["~/code"]\n\n[panels]\nleft = 26\n`)

  try {
    const loaded = await loadConfig(path)
    expect(loaded.keybindings.prefixLabel).toBe("ctrl+b")
    expect(loaded.diagnostics.sort()).toEqual([
      "unknown config section [panels]; ignoring section",
      "unknown config section [project_roots]; ignoring section",
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("falls back to the defaults on unreadable or malformed TOML", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-bad-"))
  const path = join(directory, "config.toml")
  await writeFile(path, "[keys\n")

  try {
    const loaded = await loadConfig(path)
    expect(loaded.keybindings.prefixLabel).toBe("ctrl+b")
    expect(loaded.diagnostics.join("\n")).toContain("config parse error")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
