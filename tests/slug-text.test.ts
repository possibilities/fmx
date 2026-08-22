import { describe, expect, test } from "bun:test"
import {
  buildInstruction,
  truncateExcerpt,
  excerptFrom,
  expandFileMentions,
  slugFromAnswer,
  EXCERPT_BUDGET,
  slugify,
  SLUG_MAX_LENGTH,
  stripSlashCommand,
  stripUnsafeText,
} from "../src/slug-text.ts"

describe("stripSlashCommand", () => {
  test("slugs what a command was given, not the command", () => {
    expect(stripSlashCommand("/collab rename tabs from the prompt")).toBe(
      "rename tabs from the prompt",
    )
  })

  test("drops flag tokens along with the command", () => {
    expect(stripSlashCommand("/review --deep --scope=src the socket frames")).toBe(
      "the socket frames",
    )
  })

  test("keeps a command's own name when it was given nothing", () => {
    expect(stripSlashCommand("/reload-plugins")).toBe("reload-plugins")
    expect(stripSlashCommand("/reload-plugins --force")).toBe("reload-plugins")
  })

  test("leaves ordinary prompts alone", () => {
    expect(stripSlashCommand("  fix the selection threshold  ")).toBe("fix the selection threshold")
  })
})

describe("truncateExcerpt", () => {
  test("keeps short text whole", () => {
    expect(truncateExcerpt("short", 100)).toBe("short")
  })

  test("keeps the opening and drops the rest", () => {
    expect(truncateExcerpt(`${"a".repeat(10)}${"b".repeat(50)}`, 12)).toBe(`${"a".repeat(10)}bb`)
  })
})

describe("slugify", () => {
  test("normalizes free text to a lowercase hyphenated slug", () => {
    expect(slugify("Rename Herdr Tabs, From the Prompt!")).toBe("rename-herdr-tabs-from-the-prompt")
  })

  test("folds accents and drops anything outside ascii", () => {
    expect(slugify("Café déjà vu 日本")).toBe("cafe-deja-vu")
  })

  test("caps length without leaving a trailing hyphen", () => {
    const slug = slugify(`${"word ".repeat(40)}`)
    expect(slug).not.toBeNull()
    expect(slug!.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
    expect(slug!.endsWith("-")).toBe(false)
  })

  test("answers null when nothing sluggable survives", () => {
    expect(slugify("   ")).toBeNull()
    expect(slugify("…")).toBeNull()
  })
})

describe("stripUnsafeText", () => {
  test("removes control characters and bidi overrides before slugging", () => {
    expect(slugFromAnswer("fix the\u202e list")).toBe("fix-the-list")
    expect(stripUnsafeText("a\u200bb")).toBe("ab")
    expect(stripUnsafeText("a\u0007b")).toBe("a b")
  })
})

describe("expandFileMentions", () => {
  const reader = (path: string) => (path === "notes/plan.md" ? "ship the naming work" : null)

  test("reads a mentioned file in where it was named", () => {
    expect(expandFileMentions("do @notes/plan.md today", reader)).toBe(
      "do ship the naming work today",
    )
  })

  test("leaves a mention it cannot read as it was typed", () => {
    expect(expandFileMentions("do @notes/missing.md today", reader)).toBe(
      "do @notes/missing.md today",
    )
    expect(expandFileMentions("mail me@example.com", reader)).toBe("mail me@example.com")
  })
})

describe("excerptFrom and buildInstruction", () => {
  test("the instruction carries the stripped, bounded prompt", () => {
    const instruction = buildInstruction(excerptFrom("/collab name the tabs"))
    expect(instruction).toContain("<prompt>\nname the tabs\n</prompt>")
    expect(instruction).toContain("3-6 words")
  })

  test("strips the command, reads mentions in, then bounds the whole", () => {
    const excerpt = excerptFrom("/collab --deep @plan.md", () => `read-in${"a".repeat(EXCERPT_BUDGET * 2)}`)
    expect(excerpt.length).toBe(EXCERPT_BUDGET)
    expect(excerpt.startsWith("read-in")).toBe(true)
  })
})
