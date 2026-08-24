import { mkdir } from "node:fs/promises"
import { join } from "node:path"

/**
 * Repositories for tests to launch into. An agent runs in a repository or it
 * does not run, so a directory standing in for a project has to be a real
 * checkout — `readGitContext` is what every launch is held to, and an empty
 * `.git` would not survive it.
 */

/**
 * A checkout with nothing committed yet: enough to be a project, and named so
 * the branch the Session list draws is the test's to choose. No commit means
 * no worktree can be cut from it.
 */
export async function initRepository(directory: string, branch = "main"): Promise<string> {
  await mkdir(directory, { recursive: true })
  await git(directory, "init", "--quiet", `--initial-branch=${branch}`)
  return directory
}

/** The same with something to branch from, for anything a Worktree is cut in. */
export async function initRepositoryWithCommit(directory: string, branch = "main"): Promise<string> {
  await initRepository(directory, branch)
  await git(directory, "config", "user.email", "fmx@example.invalid")
  await git(directory, "config", "user.name", "fmx test")
  await Bun.write(join(directory, "README.md"), "test\n")
  await git(directory, "add", "README.md")
  await git(directory, "commit", "--quiet", "-m", "initial")
  return directory
}

function git(directory: string, ...args: string[]): Promise<number> {
  return Bun.spawn(["git", "-C", directory, ...args], { stdout: "ignore", stderr: "ignore" }).exited
}
