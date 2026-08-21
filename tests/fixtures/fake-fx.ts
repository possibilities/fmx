#!/usr/bin/env bun

import { appendFileSync } from "node:fs"

recordLifecycle("start", process.argv.slice(2))
process.stdout.write("\u001b]2;fx · fake session\u0007")
process.stdout.write("fake fx ready\r\n")
process.stdin.setRawMode?.(true)
process.stdin.resume()
let ctrlCCount = 0
process.stdin.on("data", (chunk: Buffer) => {
  for (const byte of chunk) {
    if (byte === 3) {
      ctrlCCount += 1
      if (ctrlCCount >= 2) {
        recordLifecycle("graceful")
        process.stdout.write("fake fx graceful exit\r\n")
        process.exit(0)
      }
    } else {
      ctrlCCount = 0
      process.stdout.write(Uint8Array.of(byte))
    }
  }
})

function recordLifecycle(event: string, argv: string[] = []): void {
  const path = process.env.FMX_TEST_LOG
  if (path) appendFileSync(path, `${event} ${process.env.FMX_INSTANCE_ID ?? "?"} ${JSON.stringify(argv)}\n`)
}
