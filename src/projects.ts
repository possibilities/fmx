import { readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"

/**
 * Projects fmx can start an instance in: the configured roots and the
 * directories one level under them. Everything here is pure or a plain
 * directory read, so the launch dialog's ordering, cycling, and filtering can
 * be tested without a terminal.
 */

export type ProjectChoice = {
  /** Absolute directory an instance would be started in. */
  directory: string
  /** How the dialog writes it: home-relative, e.g. `~/code/fmx`. */
  display: string
  /** How many instances have been started here. */
  launches: number
}

export function expandTilde(value: string, home: string): string {
  if (value === "~") return home
  if (value.startsWith("~/")) return join(home, value.slice(2))
  return value
}

export function tildeDisplay(directory: string, home: string): string {
  if (directory === home) return "~"
  if (directory.startsWith(`${home}/`)) return `~/${directory.slice(home.length + 1)}`
  return directory
}

/**
 * Each root one level deep, offering the root itself as a choice too — work
 * can live at `~/code` directly. A root that is not there is a config written
 * for another machine, not a fault: it contributes nothing.
 */
export function scanProjectRoots(roots: readonly string[], home: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const offer = (directory: string) => {
    if (seen.has(directory)) return
    seen.add(directory)
    found.push(directory)
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

/**
 * Most-started first, alphabetical on ties — which is also the cold-start
 * order, before anything has been started at all.
 */
export function orderProjects(
  directories: readonly string[],
  launches: ReadonlyMap<string, number>,
  home: string,
): ProjectChoice[] {
  return directories
    .map((directory) => ({
      directory,
      display: tildeDisplay(directory, home),
      launches: launches.get(directory) ?? 0,
    }))
    .sort((left, right) => right.launches - left.launches || compareText(left.display, right.display))
}

/**
 * First-letter jump on the project row: a letter moves to the next choice
 * whose directory name starts with it, cycling past the end. Choices answer by
 * their name alone — every display shares its root's prefix. Returns the
 * current index when no choice answers, so a miss is a no-op rather than a
 * jump to somewhere unrelated.
 */
export function cycleByLetter(
  choices: readonly ProjectChoice[],
  index: number,
  letter: string,
): number {
  const needle = letter.toLowerCase()
  const matches = choices
    .map((choice, at) => ({ at, name: basename(choice.directory).toLowerCase() }))
    .filter((candidate) => candidate.name.startsWith(needle))
  if (matches.length === 0) return index
  return (matches.find((candidate) => candidate.at > index) ?? matches[0]!).at
}

/**
 * The picker's filter: a subsequence match, so `agl` finds `agentlaunch`.
 * Ranked by how directly the name answers — a name that starts with the
 * filter beats one that merely contains it, and both beat a match found only
 * in the parent directories — then by the ordering the list already had.
 */
export function matchProjects(
  choices: readonly ProjectChoice[],
  filter: string,
): ProjectChoice[] {
  const needle = filter.trim().toLowerCase()
  if (needle.length === 0) return [...choices]
  return choices
    .map((choice, at) => ({ choice, at, rank: rankProject(choice, needle) }))
    .filter((scored) => scored.rank !== null)
    .sort((left, right) => left.rank! - right.rank! || left.at - right.at)
    .map((scored) => scored.choice)
}

/** Lower is a better answer; null is no answer at all. */
function rankProject(choice: ProjectChoice, needle: string): number | null {
  const name = basename(choice.directory).toLowerCase()
  const display = choice.display.toLowerCase()
  if (name.startsWith(needle)) return 0
  if (name.includes(needle)) return 1
  if (isSubsequence(name, needle)) return 2
  if (display.includes(needle)) return 3
  if (isSubsequence(display, needle)) return 4
  return null
}

function isSubsequence(haystack: string, needle: string): boolean {
  let at = 0
  for (const character of haystack) {
    if (character === needle[at]) at += 1
    if (at === needle.length) return true
  }
  return needle.length === 0
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
