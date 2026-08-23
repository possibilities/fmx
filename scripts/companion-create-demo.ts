#!/usr/bin/env bun
/**
 * Demo: the Companion's supervisor surface -- create-only starts that return
 * on readiness, and discovery that reports without sweeping.
 *
 *   FMX_ZMX_PATH=~/src/zmx/zig-out/bin/zmx bun scripts/companion-create-demo.ts
 *
 * Everything happens in a private ZMX_DIR created under /tmp for this run;
 * your own zmx sessions are never touched. What it creates it kills at the
 * end, and the directory is removed.
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { CompanionConnection } from "../src/companion-client.ts"

const ZMX = process.env.FMX_ZMX_PATH
if (!ZMX) {
  console.error("set FMX_ZMX_PATH to the Companion binary (e.g. ~/src/zmx/zig-out/bin/zmx)")
  process.exit(2)
}

const dir = await mkdtemp("/tmp/fmxz-create-demo-")
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ZMX_DIR: dir, ZMX_NO_DETACH_KEY: "1", TERM: "xterm-256color" }
const step = (text: string) => console.log(`\n[1m▶ ${text}[0m`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const zmx = async (...args: string[]) => {
  const proc = Bun.spawn([ZMX, ...args], { env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return { code: proc.exitCode, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
}
/** Run a command, print it and what came back, return parsed JSON stdout. */
const show = async (...args: string[]) => {
  const result = await zmx(...args)
  console.log(`  $ fmx-zmx ${args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`)
  if (result.stdout) console.log(`  ${result.stdout.split("\n").join("\n  ")}`)
  if (result.stderr) console.log(`  stderr: ${result.stderr}`)
  console.log(`  exit ${result.code}`)
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch {
    return {}
  }
}
const untilExited = async (name: string) => {
  for (let i = 0; i < 60; i++) {
    const { stdout } = await zmx("inspect", "--json", name)
    if ((JSON.parse(stdout) as { state: string }).state === "exited") return
    await sleep(100)
  }
}

const survivors: string[] = []
try {
  step(`create: returns only once the child is running (private ZMX_DIR=${dir})`)
  const created = await show("create", "--json", "--labels", "owner=fmx profile=p1 agent=a1", "fmx-a1", "--", "sh", "-c", 'echo "fx would start here"; while IFS= read -r l; do [ "$l" = quit ] && exit 7; echo "got: $l"; done')
  survivors.push("fmx-a1")
  const pid = created.pid as number
  console.log(`  the reported pid is the child's, and it is alive: kill -0 ${pid} -> ${(() => { try { process.kill(pid, 0); return "ok" } catch { return "gone" } })()}`)

  step("create again with the same name: refused, and the new command never runs")
  await show("create", "--json", "fmx-a1", "--", "sh", "-c", `touch ${join(dir, "never")}; sleep 30`)
  await sleep(200)
  console.log(`  ${join(dir, "never")} exists: ${existsSync(join(dir, "never"))}`)

  step("create with a command that cannot start: the cause, and nothing left behind")
  await show("create", "--json", "fmx-a2", "--", "/nonexistent/fx", "--flag")
  await untilExited("fmx-a2")
  console.log(`  socket ${join(dir, "fmx-a2")} exists: ${existsSync(join(dir, "fmx-a2"))}`)
  await show("inspect", "--json", "fmx-a2")

  step("a second profile's session, and a session nobody owns")
  await show("create", "--json", "--labels", "owner=fmx profile=p2 agent=b1", "fmx-b1", "--", "sleep", "30")
  survivors.push("fmx-b1")
  await show("create", "--json", "unowned", "--", "sleep", "30")
  survivors.push("unowned")

  step("a daemon that died without cleaning up (killed -9): its socket stays, refusing")
  const { stdout: unownedPid } = await zmx("inspect", "--json", "unowned")
  // The daemon is the creator's own process after the double fork; its argv is the create command.
  const daemon = Bun.spawnSync(["pgrep", "-f", `zmx create --json unowned`])
  const daemonPid = Number(daemon.stdout.toString().trim().split("\n")[0])
  process.kill(daemonPid, "SIGKILL")
  process.kill((JSON.parse(unownedPid) as { pid: number }).pid, "SIGKILL")
  survivors.splice(survivors.indexOf("unowned"), 1)
  await sleep(300)

  step("list --json: everything, as found -- live, refused, exited -- and nothing deleted")
  await show("list", "--json")
  console.log(`  refused socket still there afterwards: ${existsSync(join(dir, "unowned"))}`)

  step("list --json --where: only this profile's sessions")
  await show("list", "--json", "--where", "owner=fmx", "--where", "profile=p1")

  step("the child ends while a client is attached: Exit on the wire, then the record on disk agrees")
  const connection = await CompanionConnection.connect(join(dir, "fmx-a1"), { client: "demo" })
  connection.onExit((status) => console.log(`  Exit frame: code ${status.code}, signal ${status.signal}, reason ${status.reason}`))
  connection.attach({ rows: 24, cols: 80 })
  await sleep(200)
  const closed = new Promise<void>((resolve) => connection.onClose(() => resolve()))
  connection.write("quit\r")
  await closed
  survivors.splice(survivors.indexOf("fmx-a1"), 1)
  await untilExited("fmx-a1")
  await show("inspect", "--json", "fmx-a1")

  step("forget: the record is consumed; asking again is absent")
  await show("forget", "fmx-a1")
  await show("inspect", "--json", "fmx-a1")

  step("the plain, interactive list is the one that sweeps a refused socket")
  await show("list")
  console.log(`  refused socket after the plain list: ${existsSync(join(dir, "unowned"))}`)
} finally {
  step("clean up: kill what is still running, remove the private directory")
  for (const name of survivors) console.log(`  ${(await zmx("kill", name)).stdout}`)
  await sleep(300)
  console.log(`  ${(await zmx("list")).stderr}`)
  await rm(dir, { recursive: true, force: true })
}
