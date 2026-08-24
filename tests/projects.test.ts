import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cycleByLetter,
  expandTilde,
  matchProjects,
  orderProjects,
  type ProjectChoice,
  scanProjectRoots,
  tildeDisplay,
} from "../src/projects.ts"

const HOME = "/home/me"

function choices(...displays: string[]): ProjectChoice[] {
  return displays.map((display) => ({
    directory: display.replace("~", HOME),
    display,
    launches: 0,
  }))
}

describe("expandTilde and tildeDisplay", () => {
  test("round-trip home-relative directories and leave others alone", () => {
    expect(expandTilde("~", HOME)).toBe(HOME)
    expect(expandTilde("~/code", HOME)).toBe("/home/me/code")
    expect(expandTilde("/opt/work", HOME)).toBe("/opt/work")
    expect(expandTilde("~notme/code", HOME)).toBe("~notme/code")

    expect(tildeDisplay(HOME, HOME)).toBe("~")
    expect(tildeDisplay("/home/me/code/fmx", HOME)).toBe("~/code/fmx")
    expect(tildeDisplay("/opt/work", HOME)).toBe("/opt/work")
    expect(tildeDisplay("/home/menace", HOME)).toBe("/home/menace")
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

describe("orderProjects", () => {
  test("puts the most-started first and falls back to alphabetical", () => {
    const ordered = orderProjects(
      ["/home/me/code/zulu", "/home/me/code/alpha", "/home/me/src/herdr"],
      new Map([["/home/me/code/zulu", 4]]),
      HOME,
    )
    expect(ordered.map((project) => project.display)).toEqual([
      "~/code/zulu",
      "~/code/alpha",
      "~/src/herdr",
    ])
    expect(ordered[0]!.launches).toBe(4)
    expect(ordered[1]!.launches).toBe(0)
  })
})

describe("cycleByLetter", () => {
  test("steps to the next name starting with the letter, then wraps", () => {
    const projects = choices("~/code/alpha", "~/code/fmx", "~/src/fable", "~/code/zulu")
    expect(cycleByLetter(projects, 0, "f")).toBe(1)
    expect(cycleByLetter(projects, 1, "f")).toBe(2)
    expect(cycleByLetter(projects, 2, "f")).toBe(1)
    expect(cycleByLetter(projects, 0, "F")).toBe(1)
  })

  test("answers a letter no name starts with by staying put", () => {
    const projects = choices("~/code/alpha", "~/code/fmx")
    expect(cycleByLetter(projects, 1, "q")).toBe(1)
  })
})

describe("matchProjects", () => {
  test("keeps the given order when there is no filter", () => {
    const projects = choices("~/code/zulu", "~/code/alpha")
    expect(matchProjects(projects, "  ").map((project) => project.display)).toEqual([
      "~/code/zulu",
      "~/code/alpha",
    ])
  })

  test("matches a subsequence of the name", () => {
    const projects = choices("~/code/agentlaunch", "~/code/fmx")
    expect(matchProjects(projects, "agl").map((project) => project.display)).toEqual([
      "~/code/agentlaunch",
    ])
  })

  test("ranks a name that starts with the filter over one that only contains it", () => {
    const projects = choices("~/code/my-fmx-tools", "~/code/fmx", "~/src/hmx")
    expect(matchProjects(projects, "fmx").map((project) => project.display)).toEqual([
      "~/code/fmx",
      "~/code/my-fmx-tools",
    ])
  })

  test("finds a project by the root it sits under, ranked below name matches", () => {
    const projects = choices("~/src/herdr", "~/code/source")
    expect(matchProjects(projects, "src").map((project) => project.display)).toEqual([
      "~/code/source",
      "~/src/herdr",
    ])
  })

  test("drops what does not match at all", () => {
    expect(matchProjects(choices("~/code/fmx"), "zzz")).toEqual([])
  })
})
