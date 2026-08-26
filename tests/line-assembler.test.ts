import { expect, test } from "bun:test"
import { LineAssembler } from "../src/line-assembler.ts"

test("assembles newline records across chunks and flushes a final remainder", () => {
  const lines = new LineAssembler()
  expect(lines.push("one\ntw")).toEqual(["one"])
  expect(lines.push("o\n\nthree")).toEqual(["two"])
  expect(lines.flush()).toEqual(["three"])
  expect(lines.flush()).toEqual([])
})

test("drops an unterminated record beyond the bound", () => {
  const lines = new LineAssembler()
  expect(lines.push("x".repeat(64 * 1024 + 1))).toEqual([])
  expect(lines.flush()).toEqual([])
})
