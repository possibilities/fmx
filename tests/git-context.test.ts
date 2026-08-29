import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isRepositoryDirectory,
  projectNameFor,
  readGitContext,
  treeNameFor,
} from "../src/git-context.ts"

const worktreeList = Bun.spawn(["git", "-C", process.cwd(), "worktree", "list", "--porcelain"], {
  stdout: "pipe",
  stderr: "ignore",
})
const mainRoot = (await new Response(worktreeList.stdout).text())
  .match(/^worktree (.+)$/mu)?.[1]
expect(mainRoot).toBeTruthy()

test("reads the worktree root and branch of a repository", async () => {
  const context = await readGitContext(process.cwd())
  expect(context?.branch).toBeTruthy()
  expect(context?.root).toBe(process.cwd())
  expect(context?.mainRoot).toBe(mainRoot)
})

test("reports a linked worktree's own root and the repository behind it", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fmx-git-worktree-"))
  const checkout = join(scratch, "probe")
  const git = (...args: string[]) =>
    Bun.spawn(["git", "-C", process.cwd(), ...args], { stdout: "ignore", stderr: "ignore" }).exited
  await git("worktree", "add", "--quiet", "--detach", checkout)

  try {
    const context = await readGitContext(checkout)
    expect(context?.root).toBe(await realpath(checkout))
    expect(context?.mainRoot).toBe(mainRoot)
    // Detached, so the branch falls back to the sha rather than "HEAD".
    expect(context?.branch).toMatch(/^[0-9a-f]{4,}$/u)
    expect(projectNameFor(context ?? null, checkout)).toBe("fmx")
  } finally {
    await git("worktree", "remove", "--force", checkout)
    await rm(scratch, { recursive: true, force: true })
  }
})

test("answers null outside a repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-git-"))
  try {
    expect(await readGitContext(directory)).toBeNull()
    expect(isRepositoryDirectory(directory)).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("answers for a repository with nothing committed yet", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fmx-git-unborn-")))
  try {
    await Bun.spawn(["git", "-C", directory, "init", "--quiet", "--initial-branch=trunk"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited
    // The branch is what the tray draws for it, so an unborn repository is a
    // project exactly because this comes back with a name.
    const context = await readGitContext(directory)
    expect(isRepositoryDirectory(directory)).toBe(true)
    expect(context?.root).toBe(directory)
    expect(context?.mainRoot).toBe(directory)
    expect(context?.branch).toBe("trunk")
    expect(treeNameFor(context)).toBe("trunk")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("answers null for a repository whose HEAD names no branch", async () => {
  // A project has to be able to show a branch, so a HEAD that names neither a
  // ref nor a commit is not one — the unborn fallback answers only when
  // `symbolic-ref` gives it a name to draw.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "fmx-git-nameless-")))
  try {
    for (const [name, head] of [["empty", ""], ["garbage", "not a ref\n"], ["dangling", "ref: refs/heads/\n"]]) {
      const directory = join(scratch, name!)
      await mkdir(directory, { recursive: true })
      await Bun.spawn(["git", "-C", directory, "init", "--quiet"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited
      await Bun.write(join(directory, ".git", "HEAD"), head!)
      expect(await readGitContext(directory)).toBeNull()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("answers null for a directory that is not there", async () => {
  expect(await readGitContext(join(tmpdir(), "fmx-absent-directory"))).toBeNull()
})

test("names a project by its repository, falling back to the directory", () => {
  expect(
    projectNameFor(
      { root: "/work/agentbrain", mainRoot: "/work/agentbrain", branch: "main" },
      "/work/agentbrain/src",
    ),
  ).toBe("agentbrain")
  // A worktree is named for the repository it was cut from, not for itself.
  expect(
    projectNameFor(
      { root: "/trees/agentbrain-1", mainRoot: "/work/agentbrain", branch: "agentbrain-1" },
      "/trees/agentbrain-1",
    ),
  ).toBe("agentbrain")
  expect(projectNameFor(null, "/work/loose-files")).toBe("loose-files")
  expect(projectNameFor(null, "/")).toBe("workspace")
})

test("names a linked Worktree by its own root and the main tree by its branch", () => {
  expect(
    treeNameFor({
      root: "/trees/agentbrain-1",
      mainRoot: "/work/agentbrain",
      branch: "agentbrain-1",
    }),
  ).toBe("agentbrain-1")
  expect(
    treeNameFor({ root: "/work/agentbrain", mainRoot: "/work/agentbrain", branch: "main" }),
  ).toBe("main")
  // Nothing stands in for a branch git could not answer for.
  expect(treeNameFor(null)).toBeNull()
})
