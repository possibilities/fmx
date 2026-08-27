import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { isRepositoryDirectory } from "./git-context.ts"

/**
 * Projects fmx can start an agent in: the git repositories among the
 * configured roots and the directories one level under them. Everything here
 * is pure or a plain directory read, so default CLI Launch selection can be
 * tested without a terminal.
 */

export function expandTilde(value: string, home: string): string {
  if (value === "~") return home
  if (value.startsWith("~/")) return join(home, value.slice(2))
  return value
}

/**
 * Each root one level deep, offering the root itself as a choice too — work
 * can live at `~/code` directly. A root that is not there is a config written
 * for another machine, not a fault: it contributes nothing. Only directories
 * inside a repository are offered, because only those can carry an agent.
 */
export function scanProjectRoots(roots: readonly string[], home: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const offer = (directory: string) => {
    if (seen.has(directory)) return
    seen.add(directory)
    if (isRepositoryDirectory(directory)) found.push(directory)
  }

  for (const root of roots) {
    const base = expandTilde(root, home)
    let entries
    try {
      entries = readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    offer(base)
    entries.sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const directory = join(base, entry.name)
      let isDirectory = entry.isDirectory()
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(directory).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      if (isDirectory) offer(directory)
    }
  }
  return found
}
