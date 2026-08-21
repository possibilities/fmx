import { expect, test } from "bun:test"
import { OscTitleParser } from "../src/title-parser.ts"

test("OSC title parsing survives every two-way split", () => {
  const encoded = new TextEncoder().encode("prefix\u001b]2;fx · split title\u001b\\suffix")

  for (let split = 0; split <= encoded.length; split += 1) {
    const titles: string[] = []
    const parser = new OscTitleParser({ onTitle: (title) => titles.push(title) })
    parser.push(encoded.slice(0, split))
    parser.push(encoded.slice(split))
    expect(titles).toEqual(["split title"])
  }
})
