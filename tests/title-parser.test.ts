import { describe, expect, test } from "bun:test"
import { OscTitleParser, sanitizeFxTitle, sanitizeTitle } from "../src/title-parser.ts"

describe("OscTitleParser", () => {
  test("parses BEL-terminated OSC 2 across arbitrary chunks", () => {
    const titles: string[] = []
    const parser = new OscTitleParser({ onTitle: (title) => titles.push(title) })

    parser.push(new TextEncoder().encode("before\u001b]2;fx · release"))
    parser.push(new TextEncoder().encode(" notes\u0007after"))

    expect(titles).toEqual(["release notes"])
  })

  test("parses ST-terminated OSC 0 and reports only real bells", () => {
    const titles: string[] = []
    let bells = 0
    const parser = new OscTitleParser({
      onTitle: (title) => titles.push(title),
      onBell: () => (bells += 1),
    })

    parser.push(new TextEncoder().encode("\u001b]0;workspace · model\u001b\\\u0007"))

    expect(titles).toEqual(["workspace · model"])
    expect(bells).toBe(1)
  })

  test("ignores unrelated OSC commands", () => {
    const titles: string[] = []
    const parser = new OscTitleParser({ onTitle: (title) => titles.push(title) })

    parser.push(new TextEncoder().encode("\u001b]11;rgb:0000/0000/0000\u0007"))

    expect(titles).toEqual([])
  })

  test("bounds malformed unterminated payloads and recovers", () => {
    const titles: string[] = []
    const parser = new OscTitleParser({ onTitle: (title) => titles.push(title) })

    parser.push(new TextEncoder().encode(`\u001b]2;${"x".repeat(1100)}`))
    parser.push(new TextEncoder().encode("\u001b]2;fx · recovered\u0007"))

    expect(titles).toEqual(["recovered"])
  })
})

test("sanitizeTitle removes control bytes without rewriting ordinary labels", () => {
  expect(sanitizeTitle("\u0000fx: safe\u001btitle\u007f")).toBe("fx: safetitle")
})

test("sanitizeFxTitle removes only fx's exact display prefix", () => {
  expect(sanitizeFxTitle("\u0000fx · safe\u001btitle\u007f")).toBe("safetitle")
  expect(sanitizeFxTitle("fx: user title")).toBe("fx: user title")
})
