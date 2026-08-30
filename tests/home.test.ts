import { describe, expect, test } from "bun:test"
import {
  DEFAULT_FMX_NAME,
  fmxConfigDirectory,
  homeIdFor,
  normalizeFmxName,
  resolveFmxHome,
} from "../src/home.ts"

describe("fmx Home selection", () => {
  test("preserves the unnamed/default paths and identity exactly", () => {
    const directory = "/home/me/.config/fmx"
    const expected = {
      name: null,
      configDirectory: directory,
      configPath: `${directory}/config.toml`,
      directory,
      manifestPath: `${directory}/agents.json`,
      statePath: `${directory}/state.json`,
      id: homeIdFor(directory),
    }
    expect(resolveFmxHome(null, {}, "/home/me")).toEqual(expected)
    expect(resolveFmxHome(DEFAULT_FMX_NAME, {}, "/home/me")).toEqual(expected)
    expect(fmxConfigDirectory({}, "/home/me")).toBe(directory)
  })

  test("gives each name independent fmx-owned paths while sharing config", () => {
    const env = { XDG_CONFIG_HOME: "/xdg" }
    const foo = resolveFmxHome("foo", env, "/unused")
    const bar = resolveFmxHome("bar", env, "/unused")

    expect(foo).toMatchObject({
      name: "foo",
      configDirectory: "/xdg/fmx",
      configPath: "/xdg/fmx/config.toml",
      directory: "/xdg/fmx/homes/foo",
      manifestPath: "/xdg/fmx/homes/foo/agents.json",
      statePath: "/xdg/fmx/homes/foo/state.json",
    })
    expect(bar.configPath).toBe(foo.configPath)
    expect(bar.directory).toBe("/xdg/fmx/homes/bar")
    expect(bar.id).not.toBe(foo.id)
    expect(foo.id).toBe(homeIdFor(foo.directory))
  })

  test("keeps explicit file overrides authoritative", () => {
    const home = resolveFmxHome("foo", {
      XDG_CONFIG_HOME: "/xdg",
      FMX_CONFIG_PATH: "/overrides/config.toml",
      FMX_MANIFEST_PATH: "/overrides/agents.json",
      FMX_STATE_PATH: "/overrides/state.json",
    })
    expect(home).toMatchObject({
      directory: "/xdg/fmx/homes/foo",
      configPath: "/overrides/config.toml",
      manifestPath: "/overrides/agents.json",
      statePath: "/overrides/state.json",
    })
    // File overrides do not change Companion ownership identity.
    expect(home.id).toBe(homeIdFor("/xdg/fmx/homes/foo"))
  })

  test("accepts only bounded filesystem-safe names", () => {
    expect(normalizeFmxName("a")).toBe("a")
    expect(normalizeFmxName("work_2-fast")).toBe("work_2-fast")
    expect(normalizeFmxName("default")).toBeNull()
    for (const invalid of ["", "A", "2fast", "has.dot", "has/slash", `a${"b".repeat(32)}`]) {
      expect(() => normalizeFmxName(invalid)).toThrow("invalid fmx Session name")
    }
  })
})

test("the Home id is a stable short digest of its selected directory", () => {
  expect(homeIdFor("/home/u/.config/fmx")).toMatch(/^[0-9a-f]{12}$/)
  expect(homeIdFor("/home/u/.config/fmx")).toBe(homeIdFor("/home/u/.config/fmx"))
  expect(homeIdFor("/home/u/.config/fmx")).not.toBe(homeIdFor("/other/fmx"))
})
