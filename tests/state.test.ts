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
    const activeAgentId = "0123456789abcdef0123456789abcdef"
    await saveState({ trayWidth: 31, activeAgentId }, path)
    expect(await loadState(path)).toEqual({ trayWidth: 31, activeAgentId })
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ trayWidth: 31, activeAgentId })
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

    await writeFile(path, JSON.stringify({ trayWidth: -4 }), "utf8")
    expect(await loadState(path)).toEqual({})

    await writeFile(path, JSON.stringify({ trayWidth: 20.5 }), "utf8")
    expect(await loadState(path)).toEqual({})

    await writeFile(path, JSON.stringify({ trayWidth: "26" }), "utf8")
    expect(await loadState(path)).toEqual({})

    await writeFile(path, JSON.stringify({ activeAgentId: "not-an-agent" }), "utf8")
    expect(await loadState(path)).toEqual({})

  })

  test("ignores unknown fields", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "fmx-state-")), "state.json")
    await writeFile(path, JSON.stringify({ trayWidth: 24, future: true }), "utf8")
    expect(await loadState(path)).toEqual({ trayWidth: 24 })
    await writeFile(path, JSON.stringify({ trayHidden: "yes" }), "utf8")
    expect(await loadState(path)).toEqual({})
    await writeFile(path, JSON.stringify({ trayHidden: false }), "utf8")
    expect(await loadState(path)).toEqual({})
    await writeFile(path, JSON.stringify({ trayHidden: true }), "utf8")
    expect(await loadState(path)).toEqual({ trayHidden: true })
  })
})
