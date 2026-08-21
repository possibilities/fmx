import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configPath, loadConfig } from "../src/config.ts"
import { actionForKey, KEY_CONFIG_FIELDS } from "../src/keybindings.ts"
import type { KeyEvent } from "@opentui/core"

test("resolves the Herdr-style XDG config path and explicit override", () => {
  expect(configPath({ XDG_CONFIG_HOME: "/tmp/config" }, "/home/test")).toBe("/tmp/config/fmx/config.toml")
  expect(configPath({}, "/home/test")).toBe("/home/test/.config/fmx/config.toml")
  expect(configPath({ FMX_CONFIG_PATH: "/tmp/fmx.toml" }, "/home/test")).toBe("/tmp/fmx.toml")
})

test("loads a missing config as the Herdr-compatible defaults", async () => {
  const loaded = await loadConfig("/definitely/missing/fmx-config.toml")
  expect(loaded.diagnostics).toEqual([])
  expect(loaded.keybindings.prefixLabel).toBe("ctrl+b")
})

test("loads a strict Herdr keys subset from TOML", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-"))
  const path = join(directory, "fmx", "config.toml")
  await mkdir(join(directory, "fmx"))
  await writeFile(
    path,
    `[keys]\nprefix = "ctrl+space"\nprevious_tab = ["prefix+p", "alt+1"]\nclose_tab = "prefix+shift+x"\n`,
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

test("falls back on malformed TOML and diagnoses unknown Herdr-external keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-config-errors-"))
  const malformed = join(directory, "malformed.toml")
  const unknown = join(directory, "unknown.toml")
  await writeFile(malformed, "[keys\n")
  await writeFile(unknown, "[keys]\nprefix = \"ctrl+b\"\nresume_last = \"prefix+r\"\n[theme]\nname = \"terminal\"\n")

  try {
    const malformedConfig = await loadConfig(malformed)
    expect(malformedConfig.keybindings.prefixLabel).toBe("ctrl+b")
    expect(malformedConfig.diagnostics.join("\n")).toContain("config parse error")

    const unknownConfig = await loadConfig(unknown)
    expect(unknownConfig.diagnostics).toContain("unknown config key keys.resume_last; ignoring key")
    expect(unknownConfig.diagnostics).toContain("unknown config section [theme]; ignoring section")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the public fmx key schema remains a strict subset of Herdr's", () => {
  const herdrFields = new Set([
    "prefix",
    "help",
    "detach",
    "new_tab",
    "previous_tab",
    "next_tab",
    "switch_tab",
    "close_tab",
  ])
  expect(KEY_CONFIG_FIELDS.every((field) => herdrFields.has(field))).toBe(true)
})
