import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createWorktree,
  nextWorktreeName,
  parseWorktreeList,
  planWorktree,
  readHeadCommit,
  readWorktreeContext,
} from "../src/worktree.ts"

async function repository(name: string): Promise<string> {
  const directory = join(await mkdtemp(join(tmpdir(), "fmx-worktree-")), name)
  const git = (...args: string[]) =>
    Bun.spawn(["git", "-C", directory, ...args], { stdout: "ignore", stderr: "ignore" }).exited
  await Bun.write(join(directory, "README.md"), "test\n")
  await git("init", "--quiet")
  await git("config", "user.email", "fmx@example.invalid")
  await git("config", "user.name", "fmx test")
  await git("add", "README.md")
  await git("commit", "--quiet", "-m", "initial")
  // git reports real paths, and macOS keeps its temp directory behind a symlink.
  return realpath(directory)
}

describe("nextWorktreeName", () => {
  test("counts from one and skips every name already spoken for", () => {
    expect(nextWorktreeName("fmx", new Set())).toBe("fmx-1")
    expect(nextWorktreeName("fmx", new Set(["fmx-1"]))).toBe("fmx-2")
    expect(nextWorktreeName("fmx", new Set(["fmx-1", "fmx-2", "fmx-4"]))).toBe("fmx-3")
    // A branch of that name counts as taken even with no checkout for it.
    expect(nextWorktreeName("fmx", new Set(["main", "fmx-1"]))).toBe("fmx-2")
  })
})

describe("parseWorktreeList", () => {
  test("reads the main worktree first and names the linked ones", () => {
    expect(
      parseWorktreeList(
        [
          "worktree /home/me/code/fmx",
          "HEAD abc",
          "branch refs/heads/main",
          "",
          "worktree /home/me/.fmx/worktrees/fmx-1",
          "HEAD def",
          "branch refs/heads/fmx-1",
          "",
        ].join("\n"),
      ),
    ).toEqual({ mainRoot: "/home/me/code/fmx", names: ["fmx-1"] })
  })

  test("reports nothing for output that names no worktree", () => {
    expect(parseWorktreeList("")).toEqual({ mainRoot: null, names: [] })
  })
})

describe("readWorktreeContext", () => {
  test("answers nothing outside a repository", async () => {
    expect(await readWorktreeContext(await mkdtemp(join(tmpdir(), "fmx-plain-")))).toBeNull()
  })

  test("counts ordinals against the main repository, from inside a worktree", async () => {
    const project = await repository("fmx")
    const root = join(await mkdtemp(join(tmpdir(), "fmx-worktrees-")), "nested", "worktrees")

    const context = await readWorktreeContext(project)
    expect(context).not.toBeNull()
    if (!context) return
    expect(context.mainRoot).toBe(project)
    expect(context.project).toBe("fmx")

    const first = planWorktree(context, root)
    expect(first).toEqual({ name: "fmx-1", checkout: join(root, "fmx-1") })
    await createWorktree(context, first, await readHeadCommit(project))
    expect(await readdir(first.checkout)).toContain("README.md")

    // Asking again from inside fmx-1 must not produce fmx-1-1.
    const second = await readWorktreeContext(first.checkout)
    expect(second).not.toBeNull()
    if (!second) return
    expect(second.mainRoot).toBe(project)
    expect(second.project).toBe("fmx")
    expect(planWorktree(second, root).name).toBe("fmx-2")
  })

  test("refuses a repository with no commit to branch from", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fmx-empty-"))
    await Bun.spawn(["git", "-C", directory, "init", "--quiet"], { stdout: "ignore" }).exited
    expect(readHeadCommit(directory)).rejects.toThrow()
  })
})
