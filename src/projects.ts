import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { isRepositoryDirectory } from "./git-context.ts"

export function expandTilde(value: string, home: string): string {
  if (value === "~") return home
  if (value.startsWith("~/")) return join(home, value.slice(2))
  return value
}

/** The repositories at each configured root and one directory below it, in a
 * stable order. Roots that do not exist on this machine contribute nothing. */
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
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const directory = join(base, entry.name)
      let directoryEntry = entry.isDirectory()
      if (!directoryEntry && entry.isSymbolicLink()) {
        try {
          directoryEntry = statSync(directory).isDirectory()
        } catch {
          directoryEntry = false
        }
      }
      if (directoryEntry) offer(directory)
    }
  }
  return found
}
