#!/usr/bin/env bun
/**
 * Demo: a Bun process drives a Companion-owned PTY over the socket, with no
 * PTY of its own, and the child survives the client going away.
 *
 *   FMX_ZMX_PATH=~/src/zmx/zig-out/bin/zmx bun scripts/zmx-direct-demo.ts
 *
 * Everything happens in a private ZMX_DIR created under /tmp for this run;
 * your own zmx sessions are never touched. The one session it creates is
 * killed at the end and the directory removed.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { CompanionConnection } from "../src/companion-client.ts"

const ZMX = process.env.FMX_ZMX_PATH
if (!ZMX) {
  console.error("set FMX_ZMX_PATH to the Companion binary (e.g. ~/src/zmx/zig-out/bin/zmx)")
  process.exit(2)
}

const dir = await mkdtemp("/tmp/fmxz-demo-")
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ZMX_DIR: dir, ZMX_NO_DETACH_KEY: "1", TERM: "xterm-256color" }
const name = "demo"
const socket = `${dir}/${name}`
const decoder = new TextDecoder()
const step = (text: string) => console.log(`\n[1m▶ ${text}[0m`)
const show = (label: string, bytes: Uint8Array) => console.log(`  ${label}: ${JSON.stringify(decoder.decode(bytes))}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const zmx = (...args: string[]) => Bun.$`${ZMX} ${args}`.env(env).nothrow().quiet()

try {
  step(`start a child in a Companion session (private ZMX_DIR=${dir})`)
  // Creation goes through `attach` under pipes until tranche 3 adds `create`.
  const starter = Bun.spawn([ZMX, "attach", name, "sh", "-c", 'echo "hello from the child, pid $$"; while IFS= read -r l; do echo "child got: $l"; done'], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  await sleep(400)
  starter.kill("SIGKILL")
  await starter.exited
  console.log(`  the client that started it is gone (killed); session list:`)
  console.log((await zmx("list")).stdout.toString().trimEnd())

  step("Bun connects directly to the socket and negotiates")
  const first = await CompanionConnection.connect(socket, { client: "demo" })
  console.log(`  Welcome: protocol v${first.welcome.version} (daemon speaks ${first.welcome.minVersion}..${first.welcome.maxVersion})`)
  first.onOutput((bytes) => show("output", bytes))

  step("attach at 24x80: the restore replays what the child already printed")
  first.attach({ rows: 24, cols: 80 })
  await sleep(300)

  step("type a line; it reaches the child and its answer comes back")
  first.write("typed from bun\r")
  await sleep(300)

  step("detach: the socket closes, the child keeps running")
  first.detach()
  await sleep(300)
  console.log((await zmx("list")).stdout.toString().trimEnd())

  step("reconnect and attach again: the screen is restored, the session is live")
  const second = await CompanionConnection.connect(socket, { client: "demo-again" })
  second.onOutput((bytes) => show("output", bytes))
  second.attach({ rows: 24, cols: 80 })
  await sleep(300)
  second.write("still here\r")
  await sleep(300)
  second.detach()

  step("a client claiming protocol 99..100 is refused with the daemon's range")
  try {
    await CompanionConnection.connect(socket, { versions: { min: 99, max: 100 } })
  } catch (error) {
    console.log(`  ${(error as Error).message}`)
  }
} finally {
  step("clean up: kill the demo session, remove the private directory")
  console.log((await zmx("kill", name)).stdout.toString().trimEnd())
  console.log((await zmx("list")).stderr.toString().trimEnd())
  await rm(dir, { recursive: true, force: true })
}
