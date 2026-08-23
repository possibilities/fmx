import { expect, test } from "bun:test"
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { doctor } from "../src/doctor.ts"
import { VERSION } from "../src/cli.ts"
import { PROTOCOL_VERSION } from "../src/zmx-protocol.ts"
import { COMPANION_PIN, homeIdFor } from "../src/zmx-environment.ts"

/** A Companion that answers `version` with whatever build it is told to claim. */
async function fakeCompanion(directory: string, build: string): Promise<string> {
  const path = join(directory, "fmx-zmx")
  await writeFile(path, `#!/bin/sh\n[ "$1" = version ] || exit 2\nprintf 'zmx\\t\\t%s\\nsocket_dir\\t%s\\n' '${build}' "$ZMX_DIR"\n`)
  await chmod(path, 0o755)
  return path
}

test("doctor reports a paired installation and judges only the Companion", async () => {
  const root = await realpath(await mkdtemp("/tmp/fmx-doctor-"))
  try {
    const companion = await fakeCompanion(root, COMPANION_PIN.build)
    const directory = join(root, "zmx")
    const env = {
      PATH: root,
      FMX_ZMX_DIR: directory,
      XDG_CONFIG_HOME: join(root, "config"),
      FMX_FX_PATH: "/bin/sh",
    }
    const report = await doctor(env)
    expect(report.ok).toBe(true)
    expect(report.lines[0]).toBe(`fmx        ${VERSION}`)
    expect(report.lines).toContain(`companion  ${companion} (on PATH)`)
    expect(report.lines).toContain(`directory  ${directory} (private)`)
    expect(report.lines).toContain(`build      ${COMPANION_PIN.build} (the build this fmx was released with)`)
    expect(report.lines).toContain(`protocol   ${PROTOCOL_VERSION}`)
    expect(report.lines).toContain(`home       ${homeIdFor(join(root, "config", "fmx"))} (${join(root, "config", "fmx")})`)
    expect(report.lines).toContain("fx         /bin/sh")

    // fx missing is said, not judged: it is a separate install.
    const withoutFx = await doctor({ ...env, FMX_FX_PATH: undefined, PATH: root })
    expect(withoutFx.ok).toBe(true)
    expect(withoutFx.lines.find((line) => line.startsWith("fx "))).toContain("fx executable not found: fx (set FMX_FX_PATH); install it from https://fx.sh/")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("doctor fails on a missing Companion or one that is not the pinned build, except under the override", async () => {
  const root = await realpath(await mkdtemp("/tmp/fmx-doctor-"))
  try {
    const env = { PATH: "/nonexistent", FMX_ZMX_DIR: join(root, "zmx"), XDG_CONFIG_HOME: join(root, "config"), FMX_FX_PATH: "/bin/sh" }
    const missing = await doctor(env)
    expect(missing.ok).toBe(false)
    expect(missing.lines.find((line) => line.startsWith("companion "))).toContain("Companion executable not found")
    expect(missing.lines.find((line) => line.startsWith("build "))).toContain(`expected ${COMPANION_PIN.build}`)

    const companion = await fakeCompanion(root, "0.7.0")
    const mismatched = await doctor({ ...env, PATH: root })
    expect(mismatched.ok).toBe(false)
    expect(mismatched.lines.find((line) => line.startsWith("build "))).toContain(
      `${companion} (on PATH) is build 0.7.0; this fmx was released with ${COMPANION_PIN.build} (protocol ${PROTOCOL_VERSION}). Reinstall fmx`,
    )

    const overridden = await doctor({ ...env, FMX_ZMX_PATH: companion })
    expect(overridden.ok).toBe(true)
    expect(overridden.lines.find((line) => line.startsWith("companion "))).toContain("(FMX_ZMX_PATH)")
    expect(overridden.lines.find((line) => line.startsWith("build "))).toContain("running under the override")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("doctor fails on a Companion directory that is not ours, and does not run the Companion in it", async () => {
  const root = await realpath(await mkdtemp("/tmp/fmx-doctor-"))
  try {
    const companion = await fakeCompanion(root, COMPANION_PIN.build)
    const directory = join(root, "zmx")
    await Bun.write(join(directory, ".keep"), "")
    await chmod(directory, 0o755)
    const report = await doctor({ PATH: root, FMX_ZMX_DIR: directory, XDG_CONFIG_HOME: join(root, "config"), FMX_FX_PATH: "/bin/sh" })
    expect(report.ok).toBe(false)
    expect(report.lines.find((line) => line.startsWith("directory "))).toContain("readable or writable by others")
    expect(report.lines.find((line) => line.startsWith("build "))).toBe(`build      not checked: the directory is unusable (expected ${COMPANION_PIN.build})`)
    expect(report.lines).toContain(`companion  ${companion} (on PATH)`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
