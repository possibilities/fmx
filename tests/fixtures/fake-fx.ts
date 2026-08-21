#!/usr/bin/env bun

import { appendFileSync } from "node:fs"

recordLifecycle("start", process.argv.slice(2))
process.stdout.write("\u001b]2;fx · fake session\u0007")
if (process.env.FMX_TEST_KEYBOARD_MODE === "1") process.stdout.write("\u001b[>4;2m\u001b[>1u")
process.stdout.write("fake fx ready\r\n")
process.stdin.setRawMode?.(true)
process.stdin.resume()
if (process.env.FMX_TEST_HEARTBEAT === "1") setInterval(() => recordLifecycle("alive"), 20)

const PASSTHROUGH_KEYS = [
  { sequence: "\u0015", event: "ctrl-u" },
  { sequence: "\u001b\u007f", event: "legacy-alt-backspace" },
  { sequence: "\u001b[127;3u", event: "kitty-alt-backspace" },
  { sequence: "\u001b[127;9u", event: "kitty-super-backspace" },
] as const
const passthroughTailLength = Math.max(...PASSTHROUGH_KEYS.map(({ sequence }) => sequence.length))

let ctrlCCount = 0
let waitingForExitCursorReport = false
let waitingForPrivateCursorReport = process.env.FMX_TEST_PRIVATE_CURSOR_QUERY === "1"
let waitingForBackgroundReport = process.env.FMX_TEST_BACKGROUND_QUERY === "1"
let terminalResponse = ""
let themeReport = ""
let inputTail = ""
process.stdin.on("data", (chunk: Buffer) => {
  for (const byte of chunk) {
    inputTail = `${inputTail}${String.fromCharCode(byte)}`.slice(-passthroughTailLength)
    const passthroughKey = PASSTHROUGH_KEYS.find(({ sequence }) => inputTail.endsWith(sequence))
    if (process.env.FMX_TEST_PASSTHROUGH_KEYS === "1" && passthroughKey) recordLifecycle(passthroughKey.event)
    if (waitingForBackgroundReport) {
      terminalResponse = `${terminalResponse}${String.fromCharCode(byte)}`.slice(-128)
      if (/\u001b\]11;rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+(?:\u0007|\u001b\\)$/iu.test(terminalResponse)) {
        waitingForBackgroundReport = false
        recordLifecycle("background-response", [terminalResponse])
        terminalResponse = ""
      }
      continue
    }
    if (process.env.FMX_TEST_THEME_UPDATES === "1" && (themeReport.length > 0 || byte === 0x1b)) {
      themeReport += String.fromCharCode(byte)
      const expected = ["\u001b[?997;1n", "\u001b[?997;2n"]
      if (expected.includes(themeReport)) {
        recordLifecycle("theme-notification", [themeReport])
        themeReport = ""
        terminalResponse = ""
        waitingForBackgroundReport = true
        process.stdout.write("\u001b]11;?\u001b\\")
      } else if (!expected.some((response) => response.startsWith(themeReport))) {
        themeReport = ""
      }
      continue
    }
    if (waitingForPrivateCursorReport) {
      terminalResponse = `${terminalResponse}${String.fromCharCode(byte)}`.slice(-64)
      if (/\u001b\[\?\d+;\d+R$/u.test(terminalResponse)) {
        waitingForPrivateCursorReport = false
        terminalResponse = ""
        recordLifecycle("private-terminal-response")
      }
      continue
    }

    if (waitingForExitCursorReport) {
      if (byte === 3) continue
      terminalResponse = `${terminalResponse}${String.fromCharCode(byte)}`.slice(-64)
      if (/\u001b\[\d+;\d+R$/u.test(terminalResponse)) {
        recordLifecycle("terminal-response")
        finishGracefulExit()
      }
      continue
    }

    if (byte === 3) {
      recordLifecycle("ctrl-c")
      ctrlCCount += 1
      if (ctrlCCount >= 2) {
        if (process.env.FMX_TEST_QUERY_ON_EXIT === "1") {
          waitingForExitCursorReport = true
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
      if (byte === "u".charCodeAt(0) && !passthroughKey) recordLifecycle("unexpected-input")
      process.stdout.write(Uint8Array.of(byte))
    }
  }
})

if (waitingForBackgroundReport) process.stdout.write("\u001b]11;?\u001b\\")
if (waitingForPrivateCursorReport) process.stdout.write("\u001b[?6n")
recordLifecycle("ready")

function finishGracefulExit(): never {
  recordLifecycle("graceful")
  process.stdout.write("fake fx graceful exit\r\n")
  process.exit(0)
}

function recordLifecycle(event: string, argv: string[] = []): void {
  const path = process.env.FMX_TEST_LOG
  if (path) appendFileSync(path, `${event} ${process.env.FMX_INSTANCE_ID ?? "?"} ${JSON.stringify(argv)}\n`)
}
