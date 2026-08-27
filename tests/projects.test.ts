import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
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

describe("scanProjectRoots", () => {
  /** A directory is a project only if it is inside a repository. */
  async function repository(directory: string): Promise<string> {
    await mkdir(join(directory, ".git"), { recursive: true })
    return directory
  }

  test("offers each root and its directories, skipping files and dotfiles", async () => {
    const home = await mkdtemp(join(tmpdir(), "fmx-projects-"))
    const code = await repository(join(home, "code"))
    await repository(join(code, "fmx"))
    await repository(join(code, "alpha"))
    await mkdir(join(code, ".hidden"), { recursive: true })
    await writeFile(join(code, "notes.md"), "", "utf8")
    await symlink(join(code, "alpha"), join(code, "linked"))

    expect(scanProjectRoots(["~/code"], home)).toEqual([
      code,
      join(code, "alpha"),
      join(code, "fmx"),
      join(code, "linked"),
    ])
  })

  test("offers a directory inside a repository that is not its root", async () => {
    const home = await mkdtemp(join(tmpdir(), "fmx-projects-"))
    const monorepo = await repository(join(home, "monorepo"))
    const packages = join(monorepo, "packages")
    await mkdir(join(packages, "api"), { recursive: true })

    expect(scanProjectRoots(["~/monorepo/packages"], home)).toEqual([
      packages,
      join(packages, "api"),
    ])
  })

  test("offers nothing from a root that is outside a repository", async () => {
    const home = await mkdtemp(join(tmpdir(), "fmx-projects-"))
    const code = join(home, "code")
    await mkdir(join(code, "notes"), { recursive: true })
    const tracked = await repository(join(code, "fmx"))

    expect(scanProjectRoots(["~/code"], home)).toEqual([tracked])
  })

  test("ignores a root that is not there and never repeats a directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "fmx-projects-"))
    await repository(join(home, "code"))
    await repository(join(home, "code", "fmx"))

    expect(scanProjectRoots(["~/code", "~/gone", "~/code"], home)).toEqual([
      join(home, "code"),
      join(home, "code", "fmx"),
    ])
    expect(scanProjectRoots(["~/gone"], home)).toEqual([])
  })
})
