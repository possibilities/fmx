import { basename } from "node:path"

/**
 * Where an fx instance is working, as far as git is concerned. fx never
 * reports its own directory over the agent socket, so fmx reads this itself
 * from the directory it spawned the instance in.
 */
export type GitContext = {
  /** Worktree root — the linked worktree's own path, not the main repo's. */
  root: string
  /** Branch name, or a short sha when the worktree is on a detached head. */
  branch: string
}

const CONTEXT_TIMEOUT_MS = 2000

/**
 * `rev-parse` answers all three in one call, in order: the worktree root, the
 * branch, and the short sha. A detached head reports its branch as the literal
 * "HEAD", in which case the sha is the only name the worktree has.
 */
export async function readGitContext(cwd: string): Promise<GitContext | null> {
  const lines = await runGit(cwd, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD", "--short", "HEAD"])
  if (!lines) return null
  const [root, branch, sha] = lines
  if (!root || !branch) return null
  const resolved = branch === "HEAD" ? sha : branch
  if (!resolved) return null
  return { root, branch: resolved }
}

/** The name a project is known by: its worktree directory. */
export function projectNameFor(context: GitContext | null, cwd: string): string {
  return basename(context?.root ?? cwd) || "workspace"
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
    // No git, not a repository, or the directory went away. The list falls
    // back to nesting agents directly under their project.
    return null
  }
}
