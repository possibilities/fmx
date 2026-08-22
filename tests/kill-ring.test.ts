import { describe, expect, test } from "bun:test"
import {
  createKillRing,
  KILL_RING_CAPACITY,
  killDirectionFor,
  pushKill,
  removedText,
  ringEntry,
} from "../src/kill-ring.ts"
import { bracketedPaste, normalizeEditedPrompt } from "../src/prompt-editor.ts"

describe("killDirectionFor", () => {
  test("names the merge direction of each kill chord", () => {
    expect(killDirectionFor({ name: "k", ctrl: true })).toBe("append")
    expect(killDirectionFor({ name: "u", ctrl: true })).toBe("prepend")
    expect(killDirectionFor({ name: "w", ctrl: true })).toBe("prepend")
    expect(killDirectionFor({ name: "d", meta: true })).toBe("append")
    expect(killDirectionFor({ name: "d", ctrl: true, shift: true })).toBe("append")
  })

  test("leaves single-character deletions out of the ring, as readline does", () => {
    expect(killDirectionFor({ name: "backspace" })).toBeNull()
    expect(killDirectionFor({ name: "delete" })).toBeNull()
    expect(killDirectionFor({ name: "a" })).toBeNull()
  })
})

describe("pushKill", () => {
  test("chains consecutive kills into one entry, in the direction they ran", () => {
    const ring = createKillRing()
    pushKill(ring, "world", "append", false)
    pushKill(ring, "!", "append", true)
    expect(ring.entries).toEqual(["world!"])

    pushKill(ring, "hello ", "prepend", true)
    expect(ring.entries).toEqual(["hello world!"])
  })

  test("starts a new entry when the chain breaks, newest first", () => {
    const ring = createKillRing()
    pushKill(ring, "first", "append", false)
    pushKill(ring, "second", "append", false)
    expect(ring.entries).toEqual(["second", "first"])
  })

  test("keeps nothing for an empty kill and forgets past capacity", () => {
    const ring = createKillRing()
    pushKill(ring, "", "append", false)
    expect(ring.entries).toEqual([])

    for (let index = 0; index <= KILL_RING_CAPACITY; index += 1) {
      pushKill(ring, `kill-${index}`, "append", false)
    }
    expect(ring.entries.length).toBe(KILL_RING_CAPACITY)
    expect(ring.entries[0]).toBe(`kill-${KILL_RING_CAPACITY}`)
  })
})

describe("ringEntry", () => {
  test("walks the ring in both directions and answers nothing when empty", () => {
    expect(ringEntry(createKillRing(), 0)).toBeNull()
    const ring = createKillRing()
    pushKill(ring, "older", "append", false)
    pushKill(ring, "newer", "append", false)
    expect(ringEntry(ring, 0)).toBe("newer")
    expect(ringEntry(ring, 1)).toBe("older")
    expect(ringEntry(ring, 2)).toBe("newer")
    expect(ringEntry(ring, -1)).toBe("older")
  })
})

describe("removedText", () => {
  test("reads what one contiguous deletion took out", () => {
    expect(removedText("hello world", "hello ")).toBe("world")
    expect(removedText("hello world", "world")).toBe("hello ")
    expect(removedText("hello world", "held world")).toBe("lo")
  })

  test("answers nothing when the text did not shrink", () => {
    expect(removedText("hello", "hello")).toBe("")
    expect(removedText("hello", "hello there")).toBe("")
  })
})

const START = "\u001b[200~"
const END = "\u001b[201~"

describe("bracketedPaste", () => {
  test("wraps a prompt in the paste markers and adds no send of its own", () => {
    expect(bracketedPaste("hello")).toBe(`${START}hello${END}`)
    // The newline survives, which is the whole reason for pasting rather than
    // typing; the carriage return that sends it is a separate write, because
    // fx discards a paste with anything after its end marker.
    expect(bracketedPaste("one\ntwo")).toBe(`${START}one\ntwo${END}`)
    expect(bracketedPaste("hello")).not.toContain("\r")
  })
})

describe("normalizeEditedPrompt", () => {
  test("takes the editor's punctuation off the end and normalizes newlines", () => {
    expect(normalizeEditedPrompt("a brief\n")).toBe("a brief")
    expect(normalizeEditedPrompt("a brief\n\n\n")).toBe("a brief")
    expect(normalizeEditedPrompt("one\r\ntwo\n")).toBe("one\ntwo")
    expect(normalizeEditedPrompt("")).toBe("")
  })
})
