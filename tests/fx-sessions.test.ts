import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fxProfileDirectory,
  fxSessionDirectory,
  isSessionId,
  readFirstPrompt,
} from "../src/fx-sessions.ts"

const SESSION_ID = "1787362101388-1787362101388156000-2897385323da2683"

function event(kind: string, payload: unknown): string {
  return `${JSON.stringify({ schema_version: 1, seq: 1, kind, payload })}\n`
}

async function sessionDirectory(events: string, display?: unknown): Promise<string> {
  const directory = join(await mkdtemp(join(tmpdir(), "fmx-fx-session-")), SESSION_ID)
  await mkdir(directory, { recursive: true })
  if (events !== "") await writeFile(join(directory, "events.jsonl"), events, "utf8")
  if (display !== undefined) {
    await writeFile(join(directory, "display.json"), JSON.stringify(display), "utf8")
  }
  return directory
}

describe("isSessionId", () => {
  test("accepts fx's own ids and rejects anything that could climb a path", () => {
    expect(isSessionId(SESSION_ID)).toBe(true)
    expect(isSessionId("../../etc/passwd")).toBe(false)
    expect(isSessionId("..")).toBe(false)
    expect(isSessionId("a/b")).toBe(false)
    expect(isSessionId("")).toBe(false)
  })
})

describe("fxSessionDirectory", () => {
  test("resolves under the fx profile of the given home", () => {
    const env = { HOME: "/home/me" }
    expect(fxProfileDirectory(env)).toBe("/home/me/.fx")
    expect(fxSessionDirectory(SESSION_ID, env)).toBe(`/home/me/.fx/sessions/${SESSION_ID}`)
  })

  test("answers null for an id it will not join to a path", () => {
    expect(fxSessionDirectory("../elsewhere", { HOME: "/home/me" })).toBeNull()
  })
})

describe("readFirstPrompt", () => {
  test("reads the prompt from the first recovery checkpoint", async () => {
    const directory = await sessionDirectory(
      event("session_started", { id: SESSION_ID }) +
        event("usage_checkpointed", { usage: {} }) +
        event("recovery_checkpoint_set", {
          checkpoint: { turn_id: 1, user: { text: "name every instance", images: [] } },
        }) +
        event("recovery_checkpoint_set", { checkpoint: { user: { text: "a later turn" } } }),
    )
    expect(await readFirstPrompt(directory)).toBe("name every instance")
  })

  test("falls back to a committed history turn", async () => {
    const directory = await sessionDirectory(
      event("session_started", { id: SESSION_ID }) +
        event("history_turn_committed", { turn: { kind: "assistant", user: { text: "the ask" } } }),
    )
    expect(await readFirstPrompt(directory)).toBe("the ask")
  })

  test("falls back to fx's display sidecar when the log holds no prompt yet", async () => {
    const directory = await sessionDirectory(event("session_started", { id: SESSION_ID }), {
      title: "In our integration with fx",
      preview: "In our integration with fx + fmx we have special mouse handling",
    })
    expect(await readFirstPrompt(directory)).toBe(
      "In our integration with fx + fmx we have special mouse handling",
    )
  })

  test("answers null for a session that has not been prompted", async () => {
    expect(await readFirstPrompt(await sessionDirectory(event("session_started", {})))).toBeNull()
  })

  test("answers null for a session directory that is not there", async () => {
    expect(await readFirstPrompt(join(tmpdir(), "fmx-absent-session"))).toBeNull()
  })

  test("survives a truncated or malformed log", async () => {
    const directory = await sessionDirectory(
      "not json\n" +
        event("recovery_checkpoint_set", { checkpoint: {} }) +
        event("recovery_checkpoint_set", { checkpoint: { user: { text: "the real ask" } } }) +
        '{"kind":"recovery_checkpoint_set","payload":{"checkpoint"',
    )
    expect(await readFirstPrompt(directory)).toBe("the real ask")
  })
})
