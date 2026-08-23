import { basename, dirname } from "node:path"

export const UNTRACKED_TREE_NAME = "(untracked)"

/**
 * Where an fx instance is working, as far as git is concerned. fx never
 * reports its own directory over the agent socket, so fmx reads this itself
 * from the directory it spawned the instance in.
 */
export type GitContext = {
  /** Worktree root — the linked worktree's own path, not the main repo's. */
  root: string
  /** The main worktree's root: the repository this checkout belongs to, which
   * is the same for every worktree of it and is what names the project. */
  mainRoot: string
  /** Branch name, or a short sha when the worktree is on a detached head. */
  branch: string
}

const CONTEXT_TIMEOUT_MS = 2000

/**
 * `rev-parse` answers in one call, in this order: the common git directory,
 * the worktree root, and the branch. The common directory is the main
 * worktree's `.git`, so its parent names the repository every worktree of it
 * shares — which is what keeps a worktree nested under the project it was cut
 * from rather than standing beside it as a project of its own.
 *
 * A detached head reports its branch as the literal "HEAD" and, in this
 * combined form, swallows the sha with it; the sha is then worth a second
 * call, because it is the only name such a worktree has.
 */
export async function readGitContext(cwd: string): Promise<GitContext | null> {
  const lines = await runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--show-toplevel",
    "--abbrev-ref",
    "HEAD",
  ])
  if (!lines) return null
  const [commonDir, root, branch] = lines
  if (!commonDir || !root || !branch) return null
  const mainRoot = dirname(commonDir)
  if (branch !== "HEAD") return { root, mainRoot, branch }

  const detached = await runGit(cwd, ["rev-parse", "--short", "HEAD"])
  const sha = detached?.[0]
  if (!sha) return null
  return { root, mainRoot, branch: sha }
}

/** The name a project is known by: the repository's own directory, shared by
 * every worktree cut from it. */
export function projectNameFor(context: GitContext | null, cwd: string): string {
  return basename(context?.mainRoot ?? cwd) || "workspace"
}

/** The tree this instance is actually working in: a linked Worktree's own
 * directory name, or the checked-out branch for the repository's main tree. */
export function treeNameFor(context: GitContext | null): string {
  if (!context) return UNTRACKED_TREE_NAME
  if (context.root === context.mainRoot) return context.branch
  return basename(context.root) || context.branch
}

async function runGit(cwd: string, args: string[]): Promise<string[] | null> {
  try {
    const process = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    })
    const timeout = setTimeout(() => process.kill(), CONTEXT_TIMEOUT_MS)
    try {
      const [output, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited])
      if (exitCode !== 0) return null
      return output.split("\n").map((line) => line.trim())
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    // No git, not a repository, or the directory went away. The session list
    // presents the missing branch as its virtual `(untracked)` rung.
    return null
  }
}
