import { expect, test } from "bun:test"
import { companionDirectory, companionEnvironment, homeIdFor, resolveCompanion } from "../src/zmx-environment.ts"

test("the Home id is a stable short digest of the fmx directory", () => {
  expect(homeIdFor("/home/u/.config/fmx")).toMatch(/^[0-9a-f]{12}$/)
  expect(homeIdFor("/home/u/.config/fmx")).toBe(homeIdFor("/home/u/.config/fmx"))
  expect(homeIdFor("/home/u/.config/fmx")).not.toBe(homeIdFor("/other/fmx"))
})

test("the Companion directory is short, per user, and overridable", () => {
  expect(companionDirectory({}, 502)).toBe("/tmp/fmx-502/zmx")
  expect(companionDirectory({ FMX_ZMX_DIR: "/private/d" }, 502)).toBe("/private/d")
})

test("the Companion environment drops every inherited zmx variable and sets its own", () => {
  const env = companionEnvironment(
    { PATH: "/bin", ZMX_DIR: "/theirs", ZMX_SESSION: "s", ZMX_SESSION_PREFIX: "p", ZMX_SCROLLBACK_LINES: "9", UNDEFINED: undefined },
    "/ours",
  )
  expect(env).toEqual({ PATH: "/bin", ZMX_DIR: "/ours", ZMX_NO_DETACH_KEY: "1" })
})

test("the Companion is FMX_ZMX_PATH, else fmx-zmx on PATH, never zmx", async () => {
  await expect(resolveCompanion({ FMX_ZMX_PATH: "/nonexistent/fmx-zmx" })).rejects.toThrow("not executable")
  await expect(resolveCompanion({ PATH: "/nonexistent" })).rejects.toThrow("fmx-zmx")
  expect(await resolveCompanion({ FMX_ZMX_PATH: "/bin/sh" })).toBe("/bin/sh")
})
