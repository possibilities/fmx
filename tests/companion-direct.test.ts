import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { CompanionConnection } from "../src/companion-client.ts"
import {
  decodeWelcome,
  encodeFrame,
  encodeHello,
  type Exit,
  ExitReason,
  FrameReader,
  PROTOCOL_VERSION,
  Tag,
} from "../src/zmx-protocol.ts"

/**
 * Drives a real Companion daemon over its socket, with no PTY on this side.
 *
 * Needs the fork binary: set FMX_ZMX_PATH to it (the development override the
 * shipped Companion will also honor). Sessions live in a private short ZMX_DIR
 * under /tmp so nothing here can see or touch the user's own zmx sessions.
 * Only sessions this file created are ever killed, and only by name through
 * the Companion in that private directory; the run ends by proving the
 * directory holds no sessions and removing it.
 */
const ZMX = process.env.FMX_ZMX_PATH
const ENABLED = Boolean(ZMX && existsSync(ZMX))

const decoder = new TextDecoder()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(50)
  }
  return check()
}

/** A child that echoes lines, reports its size on demand, and can emit output on a delay. */
const CHILD_SCRIPT = [
  "echo READY",
  'while IFS= read -r l; do case "$l" in',
  "  size) stty size;;",
  "  later) (sleep 0.3; echo LATER) & ;;",
  "  quit) exit 7;;",
  "  crash) kill -9 $$;;",
  '  *) echo "got:$l";;',
  "esac; done",
].join("\n")

let dir = ""
let env: Record<string, string> = {}
let sessions: string[] = []

const zmx = async (...args: string[]) => {
  const proc = Bun.spawn([ZMX!, ...args], { env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return { code: proc.exitCode, stdout, stderr }
}

/**
 * Start a session through `create --json`: it returns once the child has
 * crossed exec, so readiness is the Companion's word, not a poll of `list`.
 * The one-shot creator is gone by the time this returns; nothing holds a
 * client open.
 */
const startSession = async (name: string, script = CHILD_SCRIPT) => {
  sessions.push(name)
  const created = await create(name, ["sh", "-c", script])
  expect(created.ok).toBe(true)
  expect(alive(created.pid as number)).toBe(true)
  // Let the child reach its read loop before anyone types at it.
  await sleep(200)
  return join(dir, name)
}

/** `create --json`, parsed: the shape fmx will consume. */
const create = async (name: string, argv: string[], labels?: string) => {
  const args = ["create", "--json", ...(labels ? ["--labels", labels] : []), name, "--", ...argv]
  const { code, stdout, stderr } = await zmx(...args)
  const report = JSON.parse(stdout) as Record<string, unknown>
  expect(stderr).toBe("")
  expect(code).toBe(report.ok ? 0 : 1)
  return report
}

/** `inspect --json`, parsed. */
const inspect = async (name: string) => {
  const { code, stdout } = await zmx("inspect", "--json", name)
  expect(code).toBe(0)
  return JSON.parse(stdout) as Record<string, unknown>
}

const sessionPid = async (name: string): Promise<number | null> => {
  const { stdout } = await zmx("list")
  const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`name=${name}\t`))
  const pid = line?.match(/\tpid=(\d+)\t/)?.[1]
  return pid ? Number(pid) : null
}

/** What the daemon wrote about this session, for asserting on its side of an exchange. */
const daemonLog = async (name: string): Promise<string> => {
  const file = Bun.file(join(dir, "logs", `${name}.log`))
  return (await file.exists()) ? file.text() : ""
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Collects Output bytes and resolves when a needle shows up in what arrived after `from`. */
class Capture {
  text = ""
  /** Every lifecycle event, in the order it arrived, with output as "out". */
  readonly events: string[] = []
  exit: Exit | null = null
  private waiters: { needle: string; from: number; resolve: () => void }[] = []
  constructor(connection: CompanionConnection) {
    connection.onRestoreBegin(() => this.events.push("restore-begin"))
    connection.onReady(() => this.events.push("ready"))
    connection.onExit((status) => {
      this.exit = status
      this.events.push("exit")
    })
    connection.onOutput((bytes) => {
      this.events.push(`out:${decoder.decode(bytes, { stream: true })}`)
      this.text += this.events[this.events.length - 1]!.slice(4)
      this.waiters = this.waiters.filter((w) => {
        if (!this.text.slice(w.from).includes(w.needle)) return true
        w.resolve()
        return false
      })
    })
  }
  get length() {
    return this.text.length
  }
  until(needle: string, from = 0, timeoutMs = 5000): Promise<void> {
    if (this.text.slice(from).includes(needle)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${JSON.stringify(needle)} in ${JSON.stringify(this.text.slice(from))}`)), timeoutMs)
      this.waiters.push({ needle, from, resolve: () => (clearTimeout(timer), resolve()) })
    })
  }
}

beforeAll(async () => {
  if (!ENABLED) return
  dir = await mkdtemp("/tmp/fmxz-")
  env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ZMX_DIR: dir, ZMX_NO_DETACH_KEY: "1", TERM: "xterm-256color" }
})

afterAll(async () => {
  if (!ENABLED) return
  // Kill only what this run started, and clean up BEFORE asserting: a failed
  // check must not be what leaves a daemon and a socket directory behind.
  // `kill` returns when the daemon accepts it, not when it has finished:
  // the socket stays, refusing connections, until the teardown removes it.
  for (const name of sessions) await zmx("kill", name)
  await waitFor(async () => (await zmx("list")).stdout === "", 10_000)
  const { stdout, stderr } = await zmx("list")
  await rm(dir, { recursive: true, force: true })
  expect(stdout).toBe("")
  expect(stderr.toLowerCase()).toContain("no sessions found")
})

test.skipIf(!ENABLED)("a Bun client attaches, drives, detaches from, and reattaches to a zmx-owned child", async () => {
  const socket = await startSession("s1")
  const pid = await sessionPid("s1")
  expect(pid).not.toBeNull()
  expect(alive(pid!)).toBe(true)

  // Negotiate and attach.
  const first = await CompanionConnection.connect(socket, { client: "fmx-test" })
  expect(first.welcome.version).toBe(PROTOCOL_VERSION)
  const output = new Capture(first)
  first.attach({ rows: 30, cols: 100 })

  // The attach is bracketed: everything between the two is restored state.
  expect(await waitFor(() => output.events.includes("ready"))).toBe(true)
  expect(output.events[0]).toBe("restore-begin")
  expect(output.events.indexOf("ready")).toBeGreaterThan(0)

  // Input goes to the child and its output comes back.
  let mark = output.length
  first.write("hello-from-bun\r")
  await output.until("got:hello-from-bun", mark)

  // Resize reaches the PTY: the child reports the new size.
  first.resize({ rows: 20, cols: 60 })
  mark = output.length
  first.write("size\r")
  await output.until("20 60", mark)

  // Detach: the socket closes, the daemon and child stay. The daemon logging
  // the detach is the proof the frame arrived — isClosed alone is set locally.
  first.detach()
  expect(first.isClosed).toBe(true)
  expect(await waitFor(async () => (await daemonLog("s1")).includes("client detach"))).toBe(true)
  expect(alive(pid!)).toBe(true)
  expect(await sessionPid("s1")).toBe(pid)

  // Reattach: the restore replays the screen, and the session is live again.
  // (The restore covers everything since a client last attached. Output from
  // before the FIRST attach can be lost — an upstream gap tranche 2 closes.)
  const second = await CompanionConnection.connect(socket, { client: "fmx-test" })
  const replay = new Capture(second)
  second.attach({ rows: 20, cols: 60 })
  await replay.until("got:hello-from-bun")
  // Reconnect is bracketed too, and every restored byte falls inside it.
  expect(replay.events[0]).toBe("restore-begin")
  expect(await waitFor(() => replay.events.includes("ready"))).toBe(true)
  expect(replay.events.findIndex((e) => e.startsWith("out:"))).toBeLessThan(replay.events.indexOf("ready"))
  mark = replay.length
  second.write("again\r")
  await replay.until("got:again", mark)

  // The child exiting ends the session, and the client is told exactly how:
  // the script exits 7, and Exit is the last frame before the socket closes.
  const peerClosed = new Promise<void>((resolve) => second.onClose(() => resolve()))
  second.write("quit\r")
  await peerClosed
  expect(replay.exit).toEqual({ code: 7, signal: 0, reason: ExitReason.natural })
  expect(replay.events.at(-1)).toBe("exit")
  expect(await waitFor(() => !alive(pid!))).toBe(true)
  sessions = sessions.filter((s) => s !== "s1")
  expect(await sessionPid("s1")).toBeNull()
})

test.skipIf(!ENABLED)("a child killed by a signal reports that signal, not an exit code", async () => {
  const socket = await startSession("s4")
  const connection = await CompanionConnection.connect(socket)
  const seen = new Capture(connection)
  connection.attach({ rows: 24, cols: 80 })
  const mark = seen.length
  connection.write("awake\r")
  await seen.until("got:awake", mark)

  const closed = new Promise<void>((resolve) => connection.onClose(() => resolve()))
  connection.write("crash\r")
  await closed
  sessions = sessions.filter((s) => s !== "s4")
  expect(seen.exit).toEqual({ code: 0, signal: 9, reason: ExitReason.natural })
})

test.skipIf(!ENABLED)("a negotiated client sees no live output before its attach", async () => {
  const socket = await startSession("s2")
  const leader = await CompanionConnection.connect(socket)
  const leaderOut = new Capture(leader)
  leader.attach({ rows: 24, cols: 80 })
  let mark = leaderOut.length
  leader.write("awake\r")
  await leaderOut.until("got:awake", mark)

  // A second client negotiates but does not attach while the child prints.
  const watcher = await CompanionConnection.connect(socket, { client: "watcher" })
  const watched = new Capture(watcher)
  mark = leaderOut.length
  leader.write("later\r")
  await leaderOut.until("LATER", mark)
  await sleep(150)
  expect(watched.length).toBe(0)

  // Once attached, what it missed arrives before any live byte does, and
  // every one of those bytes is inside the restore boundary.
  watcher.attach({ rows: 24, cols: 80 })
  await watched.until("LATER")
  expect(await waitFor(() => watched.events.includes("ready"))).toBe(true)
  const readyAt = watched.events.indexOf("ready")
  expect(watched.events[0]).toBe("restore-begin")
  // What arrived before Ready is the replay, and it contains what was missed.
  const restored = watched.events.slice(0, readyAt).filter((e) => e.startsWith("out:"))
  expect(restored.length).toBeGreaterThan(0)
  expect(restored.join("")).toContain("LATER")
  mark = watched.length
  leader.write("live\r")
  await watched.until("got:live", mark)
  // And this byte is live: it appears only after Ready, in no restored frame.
  expect(restored.join("")).not.toContain("got:live")
  expect(watched.events.slice(readyAt).some((e) => e.includes("got:live"))).toBe(true)

  watcher.detach()
  leader.detach()
})

test.skipIf(!ENABLED)("the last connected or interacting terminal owns size, with failover on disconnect", async () => {
  const socket = await startSession("s7")
  const first = await CompanionConnection.connect(socket, { client: "first" })
  const firstOutput = new Capture(first)
  first.attach({ rows: 30, cols: 100 })
  expect(await waitFor(() => firstOutput.events.includes("ready"))).toBe(true)

  let mark = firstOutput.length
  first.write("size\r")
  await firstOutput.until("30 100", mark)

  const second = await CompanionConnection.connect(socket, { client: "second" })
  const secondOutput = new Capture(second)
  second.attach({ rows: 20, cols: 60 })
  expect(await waitFor(() => secondOutput.events.includes("ready"))).toBe(true)
  mark = firstOutput.length
  second.write("size\r")
  await firstOutput.until("20 60", mark)

  // Interaction returns ownership to the first terminal and applies its
  // remembered dimensions before the command reaches the child.
  mark = firstOutput.length
  first.write("size\r")
  await firstOutput.until("30 100", mark)

  // A resize is interaction too, even from a non-owner.
  second.resize({ rows: 18, cols: 50 })
  mark = firstOutput.length
  second.write("size\r")
  await firstOutput.until("18 50", mark)

  // Disconnecting the owner restores the most recently active survivor's
  // dimensions. `zmx send` does not claim ownership, so this observes the
  // failover rather than causing it.
  second.detach()
  mark = firstOutput.length
  expect((await zmx("send", "s7", "size\r")).code).toBe(0)
  await firstOutput.until("30 100", mark)
  first.detach()
})

test.skipIf(!ENABLED)("exit-on-last-client arms on Init and ignores non-terminal probes", async () => {
  const name = "s8"
  sessions.push(name)
  const { code, stdout, stderr } = await zmx(
    "create",
    "--json",
    "--exit-on-last-client",
    name,
    "--",
    "sh",
    "-c",
    CHILD_SCRIPT,
  )
  expect(code).toBe(0)
  expect(stderr).toBe("")
  const report = JSON.parse(stdout) as Record<string, unknown>
  const pid = report.pid as number
  await sleep(200)
  expect(alive(pid)).toBe(true)

  const terminal = await CompanionConnection.connect(join(dir, name), { client: "terminal" })
  const output = new Capture(terminal)
  terminal.attach({ rows: 24, cols: 80 })
  expect(await waitFor(() => output.events.includes("ready"))).toBe(true)
  const probe = await CompanionConnection.connect(join(dir, name), { client: "probe" })
  const probeClosed = new Promise<void>((resolve) => probe.onClose(() => resolve()))

  terminal.detach()
  expect(await waitFor(async () => (await inspect(name)).state === "exited", 10_000)).toBe(true)
  await probeClosed
  expect(alive(pid)).toBe(false)
  expect(await inspect(name)).toMatchObject({ state: "exited", exit: { reason: "requested" } })
  await zmx("forget", name)
  sessions = sessions.filter((session) => session !== name)
})

test.skipIf(!ENABLED)("a client the daemon cannot serve is told the daemon's range and closed", async () => {
  const socket = await startSession("s3")

  // On the wire: one Welcome with version 0 and the daemon's range, then EOF.
  const reader = new FrameReader()
  const frames: { tag: number; payload: Uint8Array }[] = []
  const closed = new Promise<void>((resolve) => {
    Bun.connect({
      unix: socket,
      socket: {
        open: (s) => {
          s.write(encodeFrame(Tag.Hello, encodeHello({ minVersion: 99, maxVersion: 100, client: "future" })))
        },
        data: (_s, data) => {
          reader.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
          for (let f = reader.next(); f; f = reader.next()) frames.push(f)
        },
        close: () => resolve(),
        error: () => resolve(),
      },
    })
  })
  await closed
  expect(frames).toHaveLength(1)
  expect(frames[0]!.tag).toBe(Tag.Welcome)
  expect(decodeWelcome(frames[0]!.payload)).toEqual({ version: 0, minVersion: 1, maxVersion: PROTOCOL_VERSION, capabilities: 0 })

  // Nothing a refused client sends is acted on, even bundled with its Hello.
  const legit = await CompanionConnection.connect(socket, { client: "legit" })
  const seen = new Capture(legit)
  legit.attach({ rows: 24, cols: 80 })
  let mark = seen.length
  legit.write("before\r")
  await seen.until("got:before", mark)

  const injected = new Promise<void>((resolve) => {
    Bun.connect({
      unix: socket,
      socket: {
        open: (s) => {
          s.write(encodeFrame(Tag.Hello, encodeHello({ minVersion: 99, maxVersion: 100, client: "future" })))
          s.write(encodeFrame(Tag.Input, new TextEncoder().encode("INJECTED\r")))
        },
        data: () => {},
        close: () => resolve(),
        error: () => resolve(),
      },
    })
  })
  await injected

  // A round trip after the attempt: had the input landed, it would precede this.
  mark = seen.length
  legit.write("after\r")
  await seen.until("got:after", mark)
  expect(seen.text).not.toContain("INJECTED")
  legit.detach()

  // The typed client turns that refusal into an error naming both ranges.
  await expect(CompanionConnection.connect(socket, { versions: { min: 99, max: 100 } })).rejects.toThrow(/daemon speaks protocol 1\.\.1; this client speaks 99\.\.100/)

  // Refused clients leave the session untouched.
  expect(await sessionPid("s3")).not.toBeNull()
})

test.skipIf(!ENABLED)("create answers on readiness, with labels the session is born with; exit records agree with Exit", async () => {
  const report = await create("s5", ["sh", "-c", CHILD_SCRIPT], "owner=fmx agent=s5")
  sessions.push("s5")
  expect(report).toMatchObject({ ok: true, name: "s5", socketPath: join(dir, "s5") })
  expect(typeof report.pid).toBe("number")
  expect(typeof report.createdAt).toBe("number")

  // Discovery sees it live, labelled, speaking our protocol, and touches nothing.
  const live = await inspect("s5")
  expect(live).toMatchObject({
    name: "s5",
    state: "live",
    pid: report.pid,
    labels: { owner: "fmx", agent: "s5" },
    lifecycle: "running",
    protocol: { minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION },
  })
  const { stdout: filtered } = await zmx("list", "--json", "--where", "agent=s5")
  expect((JSON.parse(filtered) as { name: string }[]).map((e) => e.name)).toEqual(["s5"])
  const { stdout: none } = await zmx("list", "--json", "--where", "agent=other")
  expect(JSON.parse(none)).toEqual([])

  // A taken name is refused; the command it carried never runs.
  const dup = await create("s5", ["sh", "-c", `touch ${join(dir, "never")}; sleep 30`])
  expect(dup).toMatchObject({ ok: false, name: "s5", error: "AlreadyExists" })
  await sleep(200)
  expect(existsSync(join(dir, "never"))).toBe(false)

  // A command that cannot start is reported exactly, and leaves an exit
  // record saying so, not a socket.
  const bad = await create("s6", ["/nonexistent/fx", "--flag"])
  expect(bad).toMatchObject({ ok: false, name: "s6", error: "ExecFailed", detail: "FileNotFound" })
  expect(await waitFor(async () => (await inspect("s6")).state === "exited")).toBe(true)
  expect(await inspect("s6")).toMatchObject({ state: "exited", exit: { reason: "exec_failure" } })
  expect(existsSync(join(dir, "s6"))).toBe(false)

  // The child ends while a client watches: the Exit frame and the record
  // that outlives the socket say the same thing.
  const connection = await CompanionConnection.connect(join(dir, "s5"))
  const seen = new Capture(connection)
  connection.attach({ rows: 24, cols: 80 })
  const closed = new Promise<void>((resolve) => connection.onClose(() => resolve()))
  connection.write("quit\r")
  await closed
  sessions = sessions.filter((s) => s !== "s5")
  expect(seen.exit).toEqual({ code: 7, signal: 0, reason: ExitReason.natural })
  expect(await waitFor(async () => (await inspect("s5")).state === "exited")).toBe(true)
  expect(await inspect("s5")).toMatchObject({
    state: "exited",
    pid: report.pid,
    labels: { owner: "fmx", agent: "s5" },
    exit: { code: 7, signal: 0, reason: "natural" },
  })

  // Consumed, it is absent; forgetting twice is not an error.
  for (const name of ["s5", "s6"]) {
    expect((await zmx("forget", name)).code).toBe(0)
    expect((await zmx("forget", name)).code).toBe(0)
    expect(await inspect(name)).toEqual({ name, state: "absent" })
  }
})
