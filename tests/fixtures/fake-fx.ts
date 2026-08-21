#!/usr/bin/env bun

import { appendFileSync } from "node:fs"

recordLifecycle("start", process.argv.slice(2))
process.stdout.write("\u001b]2;fx · fake session\u0007")
process.stdout.write("fake fx ready\r\n")
process.stdin.setRawMode?.(true)
process.stdin.resume()
if (process.env.FMX_TEST_HEARTBEAT === "1") setInterval(() => recordLifecycle("alive"), 20)

let ctrlCCount = 0
let waitingForCursorReport = false
let terminalResponse = ""
process.stdin.on("data", (chunk: Buffer) => {
  for (const byte of chunk) {
    if (waitingForCursorReport) {
      if (byte === 3) continue
      terminalResponse = `${terminalResponse}${String.fromCharCode(byte)}`.slice(-64)
      if (/\u001b\[\d+;\d+R$/u.test(terminalResponse)) {
        recordLifecycle("terminal-response")
        finishGracefulExit()
      }
      continue
    }

    if (byte === 3) {
      ctrlCCount += 1
      if (ctrlCCount >= 2) {
        if (process.env.FMX_TEST_QUERY_ON_EXIT === "1") {
          waitingForCursorReport = true
          process.stdout.write("\u001b[6n")
        } else {
          finishGracefulExit()
        }
      }
    } else if (byte === 2) {
      ctrlCCount = 0
      recordLifecycle("literal-prefix")
      process.stdout.write(Uint8Array.of(byte))
    } else {
      ctrlCCount = 0
      if (byte === "u".charCodeAt(0)) recordLifecycle("unexpected-input")
      process.stdout.write(Uint8Array.of(byte))
    }
  }
})

function finishGracefulExit(): never {
  recordLifecycle("graceful")
  process.stdout.write("fake fx graceful exit\r\n")
  process.exit(0)
}

function recordLifecycle(event: string, argv: string[] = []): void {
  const path = process.env.FMX_TEST_LOG
  if (path) appendFileSync(path, `${event} ${process.env.FMX_INSTANCE_ID ?? "?"} ${JSON.stringify(argv)}\n`)
}
