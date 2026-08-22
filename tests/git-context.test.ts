import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectNameFor, readGitContext } from "../src/git-context.ts"

test("reads the worktree root and branch of a repository", async () => {
  const context = await readGitContext(process.cwd())
  expect(context?.branch).toBeTruthy()
  expect(context?.root).toBe(process.cwd())
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

test("names a project by its worktree, falling back to the directory", () => {
  expect(projectNameFor({ root: "/work/agentbrain", branch: "main" }, "/work/agentbrain/src")).toBe(
    "agentbrain",
  )
  expect(projectNameFor(null, "/work/loose-files")).toBe("loose-files")
  expect(projectNameFor(null, "/")).toBe("workspace")
})
