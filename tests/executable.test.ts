import { expect, test } from "bun:test"
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { probeFxnkVersion, resolveFx } from "../src/executable.ts"

type Probe = {
  stdout: string
  stderr?: string
  exitCode?: number
}

async function probeExecutable(directory: string, name: string, probe: Probe): Promise<string> {
  const path = join(directory, name)
  await writeFile(
    path,
    [
      "#!/bin/sh",
      '[ "$1" = --fxnk-version ] || exit 0',
      `printf %s ${shellWord(probe.stdout)}`,
      probe.stderr ? `printf %s ${shellWord(probe.stderr)} >&2` : "",
      `exit ${probe.exitCode ?? 0}`,
      "",
    ].join("\n"),
  )
  await chmod(path, 0o755)
  return path
}

test("accepts the minimum Fx lifecycle contract", async () => {
  const root = await mkdtemp("/tmp/fmx-executable-")
  try {
    const path = await probeExecutable(root, "fx-current", { stdout: "fxnk 0.5.0 (fx 0.0.6)\n" })
    expect(await probeFxnkVersion(path)).toBe("0.5.0")
    expect(await resolveFx(path)).toBe(await realpath(path))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses an older fxnk contract", async () => {
  const root = await mkdtemp("/tmp/fmx-executable-")
  try {
    const path = await probeExecutable(root, "fx-old", { stdout: "fxnk 0.4.99 (fx 0.0.6)\n" })
    expect(resolveFx(path)).rejects.toThrow("fmx requires fxnk >= 0.5.0")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses a prerelease of the minimum fxnk contract", async () => {
  const root = await mkdtemp("/tmp/fmx-executable-")
  try {
    const path = await probeExecutable(root, "fx-prerelease", { stdout: "fxnk 0.5.0-rc.1 (fx 0.0.6)\n" })
    expect(await probeFxnkVersion(path)).toBe("0.5.0-rc.1")
    expect(resolveFx(path)).rejects.toThrow("fmx requires fxnk >= 0.5.0")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects malformed or noisy version probes", async () => {
  const root = await mkdtemp("/tmp/fmx-executable-")
  try {
    const malformed = await probeExecutable(root, "fx-malformed", { stdout: "fxnk version 0.5.0\n" })
    const noisy = await probeExecutable(root, "fx-noisy", {
      stdout: "fxnk 0.5.0 (fx 0.0.6)\n",
      stderr: "warning\n",
    })
    expect(await probeFxnkVersion(malformed)).toBeNull()
    expect(await probeFxnkVersion(noisy)).toBeNull()
    expect(resolveFx(malformed)).rejects.toThrow("has no compatible --fxnk-version probe")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
