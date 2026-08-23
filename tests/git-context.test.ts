import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectNameFor, readGitContext, treeNameFor } from "../src/git-context.ts"

test("reads the worktree root and branch of a repository", async () => {
  const context = await readGitContext(process.cwd())
  expect(context?.branch).toBeTruthy()
  expect(context?.root).toBe(process.cwd())
  // In the main worktree the two roots are the same directory.
  expect(context?.mainRoot).toBe(process.cwd())
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
    expect(context?.mainRoot).toBe(process.cwd())
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
  } finally {
    await rm(directory, { recursive: true, force: true })
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
  expect(treeNameFor(null)).toBe("(untracked)")
})
