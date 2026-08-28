import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import companionPin from "../companion.json" with { type: "json" }
import {
  COMPANION_PIN,
  companionBuild,
  companionDirectory,
  companionEnvironment,
  companionMismatch,
  homeIdFor,
  parseCompanionVersion,
  resolveCompanion,
} from "../src/zmx-environment.ts"

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

test("the Companion is FMX_ZMX_PATH, else fmx-zmx beside fmx, else fmx-zmx on PATH, never zmx", async () => {
  const root = await realpath(await mkdtemp("/tmp/fmx-env-"))
  try {
    const install = join(root, "install")
    const elsewhere = join(root, "elsewhere")
    await mkdir(install)
    await mkdir(elsewhere)
    for (const dir of [install, elsewhere]) {
      await writeFile(join(dir, "fmx-zmx"), "#!/bin/sh\nexit 0\n")
      await chmod(join(dir, "fmx-zmx"), 0o755)
      // A plain zmx beside either is never what fmx wants.
      await writeFile(join(dir, "zmx"), "#!/bin/sh\nexit 0\n")
      await chmod(join(dir, "zmx"), 0o755)
    }

    await expect(resolveCompanion({ FMX_ZMX_PATH: "/nonexistent/fmx-zmx" }, install)).rejects.toThrow("not executable")
    // The override is taken as given (a path that is its own realpath, so the comparison holds on every OS).
    expect(await resolveCompanion({ FMX_ZMX_PATH: join(elsewhere, "zmx"), PATH: "/nonexistent" }, install)).toEqual({ path: join(elsewhere, "zmx"), origin: "override" })
    // A bare name is looked up on the given PATH, and an empty override is none.
    expect(await resolveCompanion({ FMX_ZMX_PATH: "zmx", PATH: elsewhere }, install)).toEqual({ path: join(elsewhere, "zmx"), origin: "override" })
    await expect(resolveCompanion({ FMX_ZMX_PATH: "zmx", PATH: "/nonexistent" }, install)).rejects.toThrow("not found: zmx (FMX_ZMX_PATH)")
    expect(await resolveCompanion({ FMX_ZMX_PATH: "", PATH: elsewhere }, install)).toEqual({ path: join(install, "fmx-zmx"), origin: "sibling" })

    expect(await resolveCompanion({ PATH: elsewhere }, install)).toEqual({ path: join(install, "fmx-zmx"), origin: "sibling" })
    expect(await resolveCompanion({ PATH: elsewhere }, null)).toEqual({ path: join(elsewhere, "fmx-zmx"), origin: "path" })
    expect(await resolveCompanion({ PATH: elsewhere }, join(root, "no-such-install"))).toEqual({ path: join(elsewhere, "fmx-zmx"), origin: "path" })

    // A link beside fmx is named as the link: what is beside fmx is what a message must say.
    const { symlink, unlink } = await import("node:fs/promises")
    await unlink(join(install, "fmx-zmx"))
    await symlink(join(elsewhere, "zmx"), join(install, "fmx-zmx"))
    expect(await resolveCompanion({ PATH: elsewhere }, install)).toEqual({ path: join(install, "fmx-zmx"), origin: "sibling" })
    await unlink(join(install, "fmx-zmx"))
    await writeFile(join(install, "fmx-zmx"), "#!/bin/sh\nexit 0\n")

    // Beside fmx but not executable: passed over, like any other file there.
    await chmod(join(install, "fmx-zmx"), 0o644)
    expect(await resolveCompanion({ PATH: elsewhere }, install)).toEqual({ path: join(elsewhere, "fmx-zmx"), origin: "path" })

    await expect(resolveCompanion({ PATH: "/nonexistent" }, install)).rejects.toThrow(`beside ${install}/fmx or no fmx-zmx on PATH`)
    await expect(resolveCompanion({ PATH: "/nonexistent" }, null)).rejects.toThrow("no fmx-zmx on PATH")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the Companion pin is a fork commit and the build string a Companion built from it reports", () => {
  expect(COMPANION_PIN).toEqual(companionPin)
  expect(COMPANION_PIN.repository).toMatch(/^https:\/\/github\.com\/possibilities\/zmx(\.git)?$/)
  expect(COMPANION_PIN.branch).toBe("integration")
  expect(COMPANION_PIN.commit).toMatch(/^[0-9a-f]{40}$/)
  // `<upstream version>+fmx.<12 hex of the commit>`: the build metadata names the commit, so the two can never disagree.
  expect(COMPANION_PIN.build).toMatch(/^\d+\.\d+\.\d+\+fmx\.[0-9a-f]{12}$/)
  expect(COMPANION_PIN.build.endsWith(`+fmx.${COMPANION_PIN.commit.slice(0, 12)}`)).toBe(true)
})

test("a Companion's build is the first line of its version output", async () => {
  expect(parseCompanionVersion("zmx\t\t0.7.0+fmx.0123456789ab\nghostty_vt\tghostty-1.3.2\nsocket_dir\t/tmp/x\n")).toBe("0.7.0+fmx.0123456789ab")
  expect(parseCompanionVersion("zmx 0.7.0\n")).toBe("0.7.0")
  expect(parseCompanionVersion("zmx 0.7.0")).toBe("0.7.0")
  expect(parseCompanionVersion("fmx 0.1.1\n")).toBeNull()
  // Only the first line: a later line is never the build, whatever it says.
  expect(parseCompanionVersion("something else\nzmx\t\t0.7.0\n")).toBeNull()
  expect(parseCompanionVersion("zmx_extra 1\n")).toBeNull()
  expect(parseCompanionVersion("")).toBeNull()

  const root = await mkdtemp("/tmp/fmx-env-")
  try {
    const fake = join(root, "fmx-zmx")
    await writeFile(fake, `#!/bin/sh\n[ "$1" = version ] || exit 2\nprintf 'zmx\\t\\t%s\\nsocket_dir\\t%s\\n' "$FAKE_BUILD" "$ZMX_DIR"\n`)
    await chmod(fake, 0o755)
    const directory = join(root, "zmx")
    expect(await companionBuild(fake, { FAKE_BUILD: "0.7.0+fmx.abc", ZMX_DIR: "/theirs" }, directory)).toBe("0.7.0+fmx.abc")
    const broken = join(root, "broken")
    await writeFile(broken, "#!/bin/sh\necho 'no such command' >&2\nexit 1\n")
    await chmod(broken, 0o755)
    await expect(companionBuild(broken, {}, directory)).rejects.toThrow("did not report a build from `version`: no such command")
    const silent = join(root, "silent")
    await writeFile(silent, "#!/bin/sh\nexit 0\n")
    await chmod(silent, 0o755)
    await expect(companionBuild(silent, {}, directory)).rejects.toThrow("did not report a build")
    const stuck = join(root, "stuck")
    await writeFile(stuck, "#!/bin/sh\nsleep 30\n")
    await chmod(stuck, 0o755)
    const started = Date.now()
    await expect(companionBuild(stuck, {}, directory, 200)).rejects.toThrow("did not answer `version` within 200 ms")
    expect(Date.now() - started).toBeLessThan(5000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a Companion that is not the pinned build is refused unless the override named it", () => {
  const pinned = COMPANION_PIN.build
  const sibling = companionMismatch({ path: "/opt/fmx/fmx-zmx", origin: "sibling" }, "0.7.0", 1)
  expect(sibling).toContain("/opt/fmx/fmx-zmx (beside fmx) is build 0.7.0")
  expect(sibling).toContain(`pins ${pinned} (protocol 1)`)
  expect(sibling).toContain("Reinstall fmx to restore the pair, or set FMX_ZMX_PATH")
  expect(companionMismatch({ path: "/usr/local/bin/fmx-zmx", origin: "path" }, "0.8.0+fmx.000000000000", 1)).toContain("(on PATH)")
  const override = companionMismatch({ path: "/src/zmx/zig-out/bin/zmx", origin: "override" }, "0.7.0", 1)
  expect(override).toContain("(FMX_ZMX_PATH) is build 0.7.0")
  expect(override).toContain("running under the override")
  expect(override).not.toContain("Reinstall")
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
