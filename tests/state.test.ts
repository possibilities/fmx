import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadState, saveState, statePath } from "../src/state.ts"

describe("statePath", () => {
  test("prefers FMX_STATE_PATH, then XDG_CONFIG_HOME, then the home directory", () => {
    expect(statePath({ FMX_STATE_PATH: "/elsewhere/state.json" }, "/home/me")).toBe(
      "/elsewhere/state.json",
    )
    expect(statePath({ XDG_CONFIG_HOME: "/xdg" }, "/home/me")).toBe("/xdg/fmx/state.json")
    expect(statePath({}, "/home/me")).toBe("/home/me/.config/fmx/state.json")
  })
})

describe("loadState", () => {
  test("round-trips through saveState, creating missing directories", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "fmx-state-")), "nested", "state.json")
    await saveState({ sidebarWidth: 31 }, path)
    expect(await loadState(path)).toEqual({ sidebarWidth: 31 })
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ sidebarWidth: 31 })
  })

  test("returns empty state for a missing file", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "fmx-state-")), "state.json")
    expect(await loadState(path)).toEqual({})
  })

  test("tolerates corrupt or invalid content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fmx-state-"))
    const path = join(directory, "state.json")

    await writeFile(path, "not json", "utf8")
    expect(await loadState(path)).toEqual({})

    await writeFile(path, "[1, 2]", "utf8")
    expect(await loadState(path)).toEqual({})

    await writeFile(path, JSON.stringify({ sidebarWidth: -4 }), "utf8")
    expect(await loadState(path)).toEqual({})

    await writeFile(path, JSON.stringify({ sidebarWidth: 20.5 }), "utf8")
    expect(await loadState(path)).toEqual({})

    await writeFile(path, JSON.stringify({ sidebarWidth: "26" }), "utf8")
    expect(await loadState(path)).toEqual({})
  })

  test("ignores unknown fields", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "fmx-state-")), "state.json")
    await writeFile(path, JSON.stringify({ sidebarWidth: 24, future: true }), "utf8")
    expect(await loadState(path)).toEqual({ sidebarWidth: 24 })
  })
})
