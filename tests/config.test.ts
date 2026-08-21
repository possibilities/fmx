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
