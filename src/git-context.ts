import { basename, dirname } from "node:path"

/**
 * Where an fx Agent is working, as far as git is concerned. fmx reads this
 * from the Agent directory it owns rather than treating lifecycle context as
 * repository authority.
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
  if (!lines) return readUnbornContext(cwd)
  const [commonDir, root, branch] = lines
  if (!commonDir || !root || !branch) return null
  const mainRoot = dirname(commonDir)
  if (branch !== "HEAD") return { root, mainRoot, branch }

  const detached = await runGit(cwd, ["rev-parse", "--short", "HEAD"])
  const sha = detached?.[0]
  if (!sha) return null
  return { root, mainRoot, branch: sha }
}

/**
 * A repository whose HEAD has no commit yet: `git init` and nothing since.
 * The combined call fails on it, because `HEAD` names no revision — but the
 * checkout is real and its branch is already written down, and mistaking a
 * new repository for no repository would leave the directory it was made for
 * unusable. The two halves are read separately instead.
 */
async function readUnbornContext(cwd: string): Promise<GitContext | null> {
  const lines = await runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--show-toplevel",
  ])
  if (!lines) return null
  const [commonDir, root] = lines
  if (!commonDir || !root) return null
  const symbolic = await runGit(cwd, ["symbolic-ref", "--short", "HEAD"])
  const branch = symbolic?.[0]
  if (!branch) return null
  return { root, mainRoot: dirname(commonDir), branch }
}

/** The name a project is known by: the repository's own directory, shared by
 * every worktree cut from it. */
export function projectNameFor(context: GitContext | null, cwd: string): string {
  return basename(context?.mainRoot ?? cwd) || "workspace"
}

/**
 * The tree this agent is actually working in: a linked Worktree's own
 * directory name, or the checked-out branch for the repository's main tree.
 * null whenever git has no answer — it has not replied yet, or the checkout
 * went away under a running Agent. An Agent start requires a repository, so this
 * never means the directory was untracked, and nothing invents a name for it.
 */
export function treeNameFor(context: GitContext | null): string | null {
  if (!context) return null
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
    // No git, not a repository, or the directory went away.
    return null
  }
}
