import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureInferenceEffort,
  fxSettingsPath,
  inferenceWorkspace,
  readFxProvider,
} from "../src/fx-profile.ts"

const WORKSPACE = "/home/me/.config/fmx/inference"

async function settingsFile(contents: string, mode = 0o600): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fmx-fx-settings-")), "settings.json")
  await writeFile(path, contents, { encoding: "utf8", mode })
  return path
}

async function documentAt(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8"))
}

describe("paths", () => {
  test("name fx's settings and fmx's own inference workspace", () => {
    expect(fxSettingsPath({ HOME: "/home/me" })).toBe("/home/me/.fx/settings.json")
    expect(inferenceWorkspace({ XDG_CONFIG_HOME: "/xdg" }, "/home/me")).toBe("/xdg/fmx/inference")
  })
})

describe("readFxProvider", () => {
  test("reads the configured provider, defaulting to fx's own", async () => {
    expect(readFxProvider(await settingsFile('{"provider":"codex"}'))).toBe("codex")
    expect(readFxProvider(await settingsFile('{"provider":"grok"}'))).toBe("grok")
    expect(readFxProvider(await settingsFile("{}"))).toBe("gateway")
    expect(readFxProvider(await settingsFile('{"provider":"invented"}'))).toBe("gateway")
    expect(readFxProvider(await settingsFile("not json"))).toBe("gateway")
    expect(readFxProvider("/nowhere/settings.json")).toBe("gateway")
  })
})

describe("ensureInferenceEffort", () => {
  test("adds one workspace entry and leaves every other setting alone", async () => {
    const path = await settingsFile(
      JSON.stringify({ provider: "codex", codex_model: "gpt-5.6-sol", effort: "max" }),
    )
    expect(ensureInferenceEffort(path, WORKSPACE, "low")).toBe("written")

    const document = await documentAt(path)
    expect(document.effort).toBe("max")
    expect(document.codex_model).toBe("gpt-5.6-sol")
    expect(document.workspaces).toEqual({ [WORKSPACE]: { effort: "low" } })
  })

  test("is a no-op once the entry says what fmx wants", async () => {
    const path = await settingsFile(
      JSON.stringify({ workspaces: { [WORKSPACE]: { effort: "low" } } }),
    )
    expect(ensureInferenceEffort(path, WORKSPACE, "low")).toBe("current")
  })

  test("keeps anything a human put beside the effort", async () => {
    const path = await settingsFile(
      JSON.stringify({
        workspaces: {
          "/other/workspace": { model: "openai/gpt-5" },
          [WORKSPACE]: { effort: "high", permission_mode: "ask" },
        },
      }),
    )
    expect(ensureInferenceEffort(path, WORKSPACE, "low")).toBe("written")

    const workspaces = (await documentAt(path)).workspaces as Record<string, unknown>
    expect(workspaces[WORKSPACE]).toEqual({ effort: "low", permission_mode: "ask" })
    expect(workspaces["/other/workspace"]).toEqual({ model: "openai/gpt-5" })
  })

  test("preserves the file's own permissions", async () => {
    const path = await settingsFile(JSON.stringify({ provider: "codex" }))
    expect(ensureInferenceEffort(path, WORKSPACE, "low")).toBe("written")
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("writes nothing when there is no settings file to add to", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "fmx-fx-settings-")), "settings.json")
    expect(ensureInferenceEffort(path, WORKSPACE, "low")).toBe("skipped")
    expect(await Bun.file(path).exists()).toBe(false)
  })

  test("leaves settings it cannot parse untouched", async () => {
    const path = await settingsFile("{ this is not json")
    expect(ensureInferenceEffort(path, WORKSPACE, "low")).toBe("skipped")
    expect(await readFile(path, "utf8")).toBe("{ this is not json")
  })

  test("refuses an effort that is not a plain name", async () => {
    const path = await settingsFile(JSON.stringify({ provider: "codex" }))
    expect(ensureInferenceEffort(path, WORKSPACE, "low; rm -rf /")).toBe("skipped")
    expect(await documentAt(path)).toEqual({ provider: "codex" })
  })
})
