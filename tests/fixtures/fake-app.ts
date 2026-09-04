#!/usr/bin/env bun

/**
 * A stand-in for whatever a Session runs: it names itself with an OSC 2
 * title, echoes what it is typed, and ends when told. Driven by environment
 * variables so a test can shape it without arguments.
 *
 *   FMX_TEST_TITLE     the OSC 2 title it sets at start (default "fake app")
 *   FMX_TEST_BANNER    the line it prints at start (default "ready")
 *   FMX_TEST_LOG       a file each lifecycle event is appended to
 */

import { appendFileSync } from "node:fs"

const title = process.env.FMX_TEST_TITLE ?? "fake app"
const banner = process.env.FMX_TEST_BANNER ?? "ready"

record("start", process.argv.slice(2))
process.stdout.write(`\u001b]2;${title}\u0007`)
process.stdout.write(`${banner}\r\n`)
process.stdin.setRawMode?.(true)
process.stdin.resume()

let line = ""
process.stdin.on("data", (chunk: Buffer) => {
  for (const byte of chunk) {
    if (byte === 3) {
      record("ctrl-c")
      process.stdout.write("bye\r\n")
      process.exit(0)
    }
    const character = String.fromCharCode(byte)
    if (character === "\r" || character === "\n") {
      if (line === "quit") {
        record("quit")
        process.exit(7)
      }
      if (line.startsWith("title ")) {
        process.stdout.write(`\u001b]2;${line.slice(6)}\u0007`)
      } else {
        process.stdout.write(`got:${line}\r\n`)
      }
      line = ""
      continue
    }
    line += character
    process.stdout.write(character)
  }
})

record("ready")

function record(event: string, argv: string[] = []): void {
  const path = process.env.FMX_TEST_LOG
  if (path) appendFileSync(path, `${event} ${JSON.stringify(argv)}\n`)
}
