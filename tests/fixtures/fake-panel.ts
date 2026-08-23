#!/usr/bin/env bun

import { appendFileSync } from "node:fs"

const [logPath, label = "panel"] = process.argv.slice(2)
if (!logPath) throw new Error("fake-panel needs a log path")

record("start")
process.stdout.write(`${label} ready in ${process.cwd()}\r\n`)
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on("data", (bytes) => process.stdout.write(bytes))
setInterval(() => record("alive"), 25)

function record(event: string): void {
  appendFileSync(
    logPath!,
    `${event} ${label} ${process.pid} ${process.env.FMX_INSTANCE_ID ?? "?"} ${process.env.FMX_PANEL_ID ?? "?"} ${process.cwd()}\n`,
  )
}
