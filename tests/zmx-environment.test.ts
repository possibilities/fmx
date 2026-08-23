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
  expect(env).toEqual({ PATH: "/bin", ZMX_DIR: "/ours" })
})

test("the Companion is FMX_ZMX_PATH, else fmx-zmx on PATH, never zmx", async () => {
  await expect(resolveCompanion({ FMX_ZMX_PATH: "/nonexistent/fmx-zmx" })).rejects.toThrow("not executable")
  await expect(resolveCompanion({ PATH: "/nonexistent" })).rejects.toThrow("fmx-zmx")
  expect(await resolveCompanion({ FMX_ZMX_PATH: "/bin/sh" })).toBe("/bin/sh")
})

test("the Companion directory is made private and refused when it is not ours", async () => {
  const { mkdtemp, chmod, rm, stat } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { companionDirectories, ensureCompanionDirectories } = await import("../src/zmx-environment.ts")
  expect(companionDirectories({}, 7)).toEqual(["/tmp/fmx-7", "/tmp/fmx-7/zmx"])
  expect(companionDirectories({ FMX_ZMX_DIR: "/elsewhere/zmx" }, 7)).toEqual(["/elsewhere/zmx"])
  const root = await mkdtemp("/tmp/fmx-env-")
  try {
    const directory = join(root, "fmx-1", "zmx")
    const chain = [join(root, "fmx-1"), directory]
    await ensureCompanionDirectories(chain)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, "fmx-1"))).mode & 0o777).toBe(0o700)
    // Idempotent, and a second start finds it acceptable.
    await ensureCompanionDirectories(chain)
    // Someone else could write into it: refused.
    await chmod(join(root, "fmx-1"), 0o777)
    await expect(ensureCompanionDirectories(chain)).rejects.toThrow("writable by others")
    await chmod(join(root, "fmx-1"), 0o700)
    // Not ours at all: refused.
    await expect(ensureCompanionDirectories(chain, 0)).rejects.toThrow("owned by uid")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
