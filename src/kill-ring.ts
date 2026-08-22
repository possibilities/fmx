/**
 * The readline kill ring, observed rather than re-implemented: the textarea
 * performs its own kills, and the prompt editor diffs the field around each
 * one to learn what died. Consecutive kills merge into one entry — forward
 * kills append, backward kills prepend — exactly as emacs accumulates a
 * region killed in pieces. ctrl+y yanks the freshest entry; alt+y,
 * immediately after a yank, replaces it with the next-older entry.
 */

export const KILL_RING_CAPACITY = 10

export type KillRing = {
  entries: string[]
}

export function createKillRing(): KillRing {
  return { entries: [] }
}

export type KillDirection = "append" | "prepend"

/** The kill chords the widget's default map performs, by merge direction.
 * Single-character deletions stay out of the ring, as in readline. */
export function killDirectionFor(key: {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}): KillDirection | null {
  if (key.ctrl === true) {
    if (key.name === "k") return "append" // delete-to-line-end
    if (key.name === "u") return "prepend" // delete-to-line-start
    if (key.name === "w") return "prepend" // delete-word-backward
    if (key.name === "backspace") return "prepend"
    if (key.name === "delete") return "append"
    if (key.name === "d" && key.shift === true) return "append" // delete-line
  }
  if (key.meta === true) {
    if (key.name === "d") return "append" // delete-word-forward
    if (key.name === "backspace") return "prepend"
    if (key.name === "delete") return "append"
  }
  return null
}

/** A chained kill grows the freshest entry; an unchained one starts a new
 * entry at the front, and the ring forgets its oldest past capacity. */
export function pushKill(
  ring: KillRing,
  killed: string,
  direction: KillDirection,
  chained: boolean,
): void {
  if (killed === "") return
  if (chained && ring.entries.length > 0) {
    ring.entries[0] =
      direction === "append" ? `${ring.entries[0]}${killed}` : `${killed}${ring.entries[0]}`
    return
  }
  ring.entries.unshift(killed)
  if (ring.entries.length > KILL_RING_CAPACITY) ring.entries.length = KILL_RING_CAPACITY
}

export function ringEntry(ring: KillRing, index: number): string | null {
  if (ring.entries.length === 0) return null
  return ring.entries[((index % ring.entries.length) + ring.entries.length) % ring.entries.length]!
}

/** What one contiguous deletion removed: the text between the common prefix
 * and common suffix of the before and after states. */
export function removedText(before: string, after: string): string {
  if (after.length >= before.length) return ""
  let prefix = 0
  const limit = Math.min(before.length, after.length)
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < limit - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return before.slice(prefix, before.length - suffix)
}
