import { describe, expect, test } from "bun:test"
import { CursorReportAdapter } from "../src/cursor-report-adapter.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const encode = (value: string) => encoder.encode(value)
const decode = (value: Uint8Array) => decoder.decode(value)

describe("CursorReportAdapter", () => {
  test("translates private cursor queries and restores private responses", () => {
    const adapter = new CursorReportAdapter()

    expect(decode(adapter.toTerminal(encode("before\u001b[1G\u001b[?6nafter")))).toBe(
      "before\u001b[1G\u001b[6nafter",
    )
    expect(decode(adapter.toPty(encode("\u001b[12;1R")))).toBe("\u001b[?12;1R")
  })

  test("recognizes a private query split at every byte boundary", () => {
    const input = encode("left\u001b[?6nright")

    for (let split = 0; split <= input.byteLength; split += 1) {
      const adapter = new CursorReportAdapter()
      const first = adapter.toTerminal(input.subarray(0, split))
      const second = adapter.toTerminal(input.subarray(split))
      expect(decode(concat(first, second, adapter.flushTerminalBytes()))).toBe("left\u001b[6nright")
      expect(decode(adapter.toPty(encode("\u001b[3;9R")))).toBe("\u001b[?3;9R")
    }
  })

  test("translates only as many responses as private queries", () => {
    const adapter = new CursorReportAdapter()
    adapter.toTerminal(encode("\u001b[?6n"))

    expect(decode(adapter.toPty(encode("\u001b[0n\u001b[4;5R\u001b[6;7R")))).toBe(
      "\u001b[0n\u001b[?4;5R\u001b[6;7R",
    )
  })

  test("preserves ordinary output, standard queries, and unmatched responses", () => {
    const adapter = new CursorReportAdapter()

    expect(decode(adapter.toTerminal(encode("text\u001b[6n\u001b]2;title\u0007")))).toBe(
      "text\u001b[6n\u001b]2;title\u0007",
    )
    expect(decode(adapter.toPty(encode("\u001b[8;9R")))).toBe("\u001b[8;9R")
  })

  test("flushes an incomplete request prefix without changing it", () => {
    const adapter = new CursorReportAdapter()

    expect(decode(adapter.toTerminal(encode("text\u001b[?")))).toBe("text")
    expect(decode(adapter.flushTerminalBytes())).toBe("\u001b[?")
  })
})

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}
