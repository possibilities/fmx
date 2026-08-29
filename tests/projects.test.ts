import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandTilde, scanProjectRoots } from "../src/projects.ts"

const HOME = "/home/me"

describe("expandTilde", () => {
  test("expands home-relative directories and leaves others alone", () => {
    expect(expandTilde("~", HOME)).toBe(HOME)
    expect(expandTilde("~/code", HOME)).toBe("/home/me/code")
    expect(expandTilde("/opt/work", HOME)).toBe("/opt/work")
    expect(expandTilde("~notme/code", HOME)).toBe("~notme/code")
  })
})

test("discovers configured repositories one level down in stable order", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fmx-projects-"))
  const code = join(scratch, "code")
  const direct = join(scratch, "direct")
  try {
    await mkdir(join(code, "beta", ".git"), { recursive: true })
    await mkdir(join(code, "alpha", ".git"), { recursive: true })
    await mkdir(join(code, ".hidden", ".git"), { recursive: true })
    await mkdir(join(code, "loose"), { recursive: true })
    await mkdir(join(direct, ".git"), { recursive: true })
    await symlink(join(code, "beta"), join(code, "linked-beta"))

    expect(scanProjectRoots([code, direct, code, join(scratch, "missing")], scratch)).toEqual([
      join(code, "alpha"),
      join(code, "beta"),
      join(code, "linked-beta"),
      direct,
    ])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
