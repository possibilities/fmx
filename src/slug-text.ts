/**
 * The pure half of naming an agent: everything between the first prompt fx
 * recorded and the slug that stands in for a session id. No filesystem, no
 * subprocess, no clock — so every branch here is reachable from a test.
 *
 * A slug is `[a-z0-9-]+`, which is what makes it usable as a handle: it can be
 * typed as an argument, compared without normalizing, and drawn in a narrow
 * column without a width surprise.
 */

/** Character budget for the excerpt handed to the completion. What overruns it
 * is dropped from the end: the ask is at the top of a prompt, and a title
 * drawn from the opening is the same title the whole prompt would have earned. */
export const EXCERPT_BUDGET = 1600

/** Longest slug fmx will mint. Long enough for six words, short enough that a
 * tray row still fits a project and a branch above it. */
export const SLUG_MAX_LENGTH = 64

/**
 * A prompt that opens with a slash command names a workflow, not a subject:
 * drop the command token and its flags and slug what the command was given. A
 * command given nothing keeps its own name, because a row reading
 * "reload-plugins" beats an empty one.
 */
export function stripSlashCommand(text: string): string {
  const command = /^\s*\/(\S+)\s*([\s\S]*)$/.exec(text)
  if (!command) return text.trim()
  const rest = stripFlagTokens(command[2] ?? "")
  return rest !== "" ? rest : (command[1] ?? "")
}

function stripFlagTokens(text: string): string {
  return text
    .replace(/(^|\s)--[A-Za-z0-9][\w-]*(=\S*)?(?=\s|$)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim()
}

/** Bound the excerpt by keeping its opening. */
export function truncateExcerpt(text: string, budget: number = EXCERPT_BUDGET): string {
  return text.length <= budget ? text : text.slice(0, budget)
}

/**
 * Replace each @-prefixed path with what the file holds, so a prompt naming a
 * file is named for what the file is about rather than for where it lives — a
 * prompt that is little more than `@notes/plan.md do this` has no other subject
 * matter in it. A mention the reader cannot resolve stays as it was typed.
 */
export function expandFileMentions(
  text: string,
  readMention: (path: string) => string | null,
): string {
  return text.replace(/(^|\s)@([A-Za-z0-9._~/-]+)/g, (whole, lead: string, path: string) => {
    const content = readMention(path)
    return content === null ? whole : `${lead}${content}`
  })
}

/** A recorded prompt as the completion sees it, in that order: the command
 * stripped, its mentions read in, and only then the whole bounded — so the
 * budget is spent on what the prompt is actually about. */
export function excerptFrom(
  prompt: string,
  readMention: (path: string) => string | null = () => null,
): string {
  return truncateExcerpt(expandFileMentions(stripSlashCommand(prompt), readMention))
}

/** What fmx asks for. Only the title text comes back, so the answer needs no
 * parsing beyond slugging — and a model that answers with a sentence anyway
 * still slugs into something serviceable. */
export function buildInstruction(excerpt: string): string {
  return (
    "Generate a short session title (3-6 words) summarizing the work requested " +
    "in the conversation-opening prompt below. Prioritize the user's requests, " +
    "goals, and repeated themes over implementation detail. Respond with ONLY " +
    `the title text: no punctuation, no quotes, no preamble.\n\n<prompt>\n${excerpt}\n</prompt>`
  )
}

/**
 * Strip ASCII control characters and Unicode bidi controls from model output
 * before slugging. `slugify` would drop them too, but a slug travels to a
 * tray row and, later, to a command line: nothing that can move a cursor or
 * reorder text should survive this far in the first place.
 */
export function stripUnsafeText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
}

/** Normalize free text to `[a-z0-9-]+`, or null when nothing survives. */
export function slugify(text: string): string | null {
  let value = String(text).normalize("NFKD")
  value = value.replace(/\p{M}/gu, "")
  value = value.replace(/[^\x00-\x7F]/g, "")
  value = value.toLowerCase()
  value = value.replace(/[^a-z0-9]+/g, "-")
  value = value.replace(/^-+|-+$/g, "")
  if (value.length > SLUG_MAX_LENGTH) {
    value = value.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, "")
  }
  return value === "" ? null : value
}

/** The completion's answer as a slug, or null when it said nothing sluggable. */
export function slugFromAnswer(answer: string): string | null {
  return slugify(stripUnsafeText(answer).trim())
}
