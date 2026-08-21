import { expect, test } from "bun:test"
import { parseArgs } from "../src/cli.ts"

test("CLI requires values for value-taking options", () => {
  expect(() => parseArgs(["--cwd"])).toThrow("--cwd requires a value")
  expect(() => parseArgs(["--scrollback"])).toThrow("--scrollback requires a value")
})
