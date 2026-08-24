import { mkdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

/**
 * Worktrees fmx makes for a launch. A worktree is named `<project>-<ordinal>`
 * — `fmx-1`, `fmx-2` — and the name is the branch and the directory alike, so
 * there is one word to recognize it by wherever it turns up.
 *
 * Ordinals count against the main repository, never the worktree a launch was
 * started from: `fmx-1` is a worktree of `fmx`, and launching again from
 * inside it must produce `fmx-2` rather than `fmx-1-1`.
 */

const GIT_TIMEOUT_MS = 10_000

export type WorktreeContext = {
  /** The main worktree's root — where every `git worktree` call is run. */
  mainRoot: string
  /** The name the ordinals attach to: the main worktree's directory. */
  project: string
  /** Branches and worktree names already spoken for. */
  taken: Set<string>
}

export type WorktreePlan = {
  /** Branch and directory name alike. */
  name: string
  /** Where the checkout lands. */
  checkout: string
}

/** The first `<project>-<ordinal>` nothing has claimed, counting from 1. */
export function nextWorktreeName(project: string, taken: ReadonlySet<string>): string {
  for (let ordinal = 1; ; ordinal += 1) {
    const name = `${project}-${ordinal}`
    if (!taken.has(name)) return name
  }
}

/**
 * The main worktree is the first entry `git worktree list` reports, whether
 * the call was made from it or from a linked worktree — which is what makes
 * the ordinal count against the repository rather than the directory.
 */
export function parseWorktreeList(output: string): { mainRoot: string | null; names: string[] } {
  const paths: string[] = []
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim())
  }
  const [mainRoot = null, ...linked] = paths
  return { mainRoot, names: linked.map((path) => basename(path)) }
}

export async function readWorktreeContext(cwd: string): Promise<WorktreeContext | null> {
  const listed = await runGit(cwd, ["worktree", "list", "--porcelain"])
  if (!listed.ok) return null
  const { mainRoot, names } = parseWorktreeList(listed.stdout)
  if (!mainRoot) return null

  const taken = new Set(names)
  const branches = await runGit(mainRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
  if (branches.ok) {
    for (const branch of branches.stdout.split("\n")) {
      const trimmed = branch.trim()
      if (trimmed) taken.add(trimmed)
    }
  }
  return { mainRoot, project: basename(mainRoot) || "workspace", taken }
}

export function planWorktree(context: WorktreeContext, root: string): WorktreePlan {
  const name = nextWorktreeName(context.project, context.taken)
  return { name, checkout: join(root, name) }
}

/**
 * Branch from what the launch was looking at, not from the main worktree's
 * HEAD: picking a project that is on a feature branch and getting a worktree
 * off `main` would be a silent substitution.
 */
export async function createWorktree(
  context: WorktreeContext,
  plan: WorktreePlan,
  base: string,
): Promise<void> {
  // git will not create the worktree root's own parents.
  await mkdir(dirname(plan.checkout), { recursive: true })
  const added = await runGit(context.mainRoot, [
    "worktree",
    "add",
    "-b",
    plan.name,
    plan.checkout,
    base,
  ])
  if (!added.ok) throw new Error(added.stderr || `git worktree add failed for ${plan.name}`)
}

/** The commit a worktree branches from: whatever `cwd` currently has checked
 * out, by sha, so a later checkout in the source cannot move it. */
export async function readHeadCommit(cwd: string): Promise<string> {
  const head = await runGit(cwd, ["rev-parse", "HEAD"])
  const sha = head.stdout.trim()
  // Every project is a repository, so the one thing left that fails here is
  // an unborn HEAD. Git's own words for that name a revision the human never
  // asked about; the sentence the Worktree row uses says it plainly.
  if (!head.ok || !sha) throw new Error("the project has no commit to branch from")
  return sha
}

type GitResult = { ok: boolean; stdout: string; stderr: string }

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const process = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    const timeout = setTimeout(() => process.kill(), GIT_TIMEOUT_MS)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      return { ok: exitCode === 0, stdout, stderr: stderr.trim() }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}
