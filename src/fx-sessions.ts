import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Reading fx's own session store, which is where an instance's first prompt
 * can be found. fx reports a session id over the agent socket and nothing
 * else about the conversation, so the prompt has to be read from the log fx
 * writes for itself.
 *
 * Two carriers, earliest first. `recovery_checkpoint_set` lands moments after
 * the prompt is submitted, holds the prompt whole, and is what naming waits
 * for. `display.json` is fx's own sidecar, derived at turn commit and capped
 * at 240 bytes — late and abridged, but enough to name a session fmx joined
 * after the fact.
 */

/** Only a prefix of the event log is scanned: the first prompt is within the
 * opening events, while the log itself grows into megabytes of tool traffic. */
const EVENT_PREFIX_BYTES = 1024 * 1024

export function fxHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || homedir()
}

export function fxProfileDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(fxHomeDirectory(env), ".fx")
}

/**
 * fx addresses sessions by an id that reaches fmx over a socket, so it is
 * checked before it is ever joined to a path. Real ids are
 * `<millis>-<nanos>-<hex>`; anything that could climb out of the sessions
 * directory is not one.
 */
export function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..")
}

export function fxSessionDirectory(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isSessionId(sessionId)) return null
  return join(fxProfileDirectory(env), "sessions", sessionId)
}

/**
 * The conversation's first user prompt, or null while fx has not recorded one.
 * Null is the ordinary answer for a session that exists but has not been
 * prompted yet — an instance parked at a trust dialog, or one simply waiting
 * for its human — and naming polls on it rather than treating it as a fault.
 */
export async function readFirstPrompt(sessionDirectory: string): Promise<string | null> {
  return (
    (await readPromptFromEvents(join(sessionDirectory, "events.jsonl"))) ??
    readPromptFromDisplay(await readJsonFile(join(sessionDirectory, "display.json")))
  )
}

async function readPromptFromEvents(path: string): Promise<string | null> {
  let text: string
  try {
    text = await Bun.file(path).slice(0, EVENT_PREFIX_BYTES).text()
  } catch {
    return null
  }

  const lines = text.split("\n")
  // A prefix read almost always ends mid-record; the last line is only whole
  // when the file itself ended there.
  if (text.length >= EVENT_PREFIX_BYTES) lines.pop()
  for (const line of lines) {
    if (line.trim() === "") continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const prompt = promptFromEvent(event)
    if (prompt) return prompt
  }
  return null
}

function promptFromEvent(event: unknown): string | null {
  if (!isRecord(event)) return null
  const payload = event.payload
  if (!isRecord(payload)) return null
  switch (event.kind) {
    case "recovery_checkpoint_set":
      return userText(isRecord(payload.checkpoint) ? payload.checkpoint.user : null)
    case "history_turn_committed":
      return userText(isRecord(payload.turn) ? payload.turn.user : null)
    default:
      return null
  }
}

function userText(user: unknown): string | null {
  if (!isRecord(user)) return null
  return nonEmptyString(user.text)
}

/** fx's sidecar: `preview` is the prompt's opening, `title` its first line. */
function readPromptFromDisplay(display: unknown): string | null {
  if (!isRecord(display)) return null
  return nonEmptyString(display.preview) ?? nonEmptyString(display.title)
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return await Bun.file(path).json()
  } catch {
    return null
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
