import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { ZmxConnection } from "../src/zmx-client.ts"
import { decodeWelcome, encodeFrame, encodeHello, FrameReader, PROTOCOL_VERSION, Tag } from "../src/zmx-protocol.ts"

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
 * Start a session through `attach` under pipes (creation is tranche 3's
 * `create`), then drop that client.
 *
 * Readiness is the session appearing in `list`, not anything the starting
 * client printed: whether that client sees the child's first output at all is
 * a timing race in the daemon today (see the reattach note below), and this
 * harness must not depend on which way it falls.
 */
const startSession = async (name: string) => {
  sessions.push(name)
  const attach = Bun.spawn([ZMX!, "attach", name, "sh", "-c", CHILD_SCRIPT], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await waitFor(async () => (await sessionPid(name)) !== null)).toBe(true)
  // Let the child reach its read loop before the only client goes away.
  await sleep(200)
  attach.kill("SIGKILL")
  await attach.exited
  return join(dir, name)
}

const sessionPid = async (name: string): Promise<number | null> => {
  const { stdout } = await zmx("list")
  const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`name=${name}\t`))
  const pid = line?.match(/\tpid=(\d+)\t/)?.[1]
  return pid ? Number(pid) : null
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
  private waiters: { needle: string; from: number; resolve: () => void }[] = []
  constructor(connection: ZmxConnection) {
    connection.onOutput((bytes) => {
      this.text += decoder.decode(bytes, { stream: true })
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
  // Kill only what this run started, then prove the private directory is empty of sessions.
  for (const name of sessions) await zmx("kill", name)
  const { stdout, stderr } = await zmx("list")
  expect(stdout).toBe("")
  expect(stderr.toLowerCase()).toContain("no sessions found")
  await rm(dir, { recursive: true, force: true })
})

test.skipIf(!ENABLED)("a Bun client attaches, drives, detaches from, and reattaches to a zmx-owned child", async () => {
  const socket = await startSession("s1")
  const pid = await sessionPid("s1")
  expect(pid).not.toBeNull()
  expect(alive(pid!)).toBe(true)

  // Negotiate and attach.
  const first = await ZmxConnection.connect(socket, { client: "fmx-test" })
  expect(first.welcome.version).toBe(PROTOCOL_VERSION)
  const output = new Capture(first)
  first.attach({ rows: 30, cols: 100 })

  // Input goes to the child and its output comes back.
  let mark = output.length
  first.write("hello-from-bun\r")
  await output.until("got:hello-from-bun", mark)

  // Resize reaches the PTY: the child reports the new size.
  first.resize({ rows: 20, cols: 60 })
  mark = output.length
  first.write("size\r")
  await output.until("20 60", mark)

  // Detach: the socket closes, the daemon and child stay.
  const closed = new Promise<void>((resolve) => first.onClose(() => resolve()))
  first.detach()
  await closed
  expect(first.isClosed).toBe(true)
  await sleep(200)
  expect(alive(pid!)).toBe(true)
  expect(await sessionPid("s1")).toBe(pid)

  // Reattach: the restore replays the screen, and the session is live again.
  // (The restore covers everything since a client last attached. Output from
  // before the FIRST attach can be lost — an upstream gap tranche 2 closes.)
  const second = await ZmxConnection.connect(socket, { client: "fmx-test" })
  const replay = new Capture(second)
  second.attach({ rows: 20, cols: 60 })
  await replay.until("got:hello-from-bun")
  mark = replay.length
  second.write("again\r")
  await replay.until("got:again", mark)

  // The child exiting ends the session: the daemon closes the socket and goes away.
  // (`list` reports the child's pid; the daemon reaps it after its SIGHUP grace period.)
  const peerClosed = new Promise<void>((resolve) => second.onClose(() => resolve()))
  second.write("quit\r")
  await peerClosed
  expect(await waitFor(() => !alive(pid!))).toBe(true)
  expect(await sessionPid("s1")).toBeNull()
  sessions = sessions.filter((s) => s !== "s1")
})

test.skipIf(!ENABLED)("a negotiated client sees no live output before its attach", async () => {
  const socket = await startSession("s2")
  const leader = await ZmxConnection.connect(socket)
  const leaderOut = new Capture(leader)
  leader.attach({ rows: 24, cols: 80 })
  let mark = leaderOut.length
  leader.write("awake\r")
  await leaderOut.until("got:awake", mark)

  // A second client negotiates but does not attach while the child prints.
  const watcher = await ZmxConnection.connect(socket, { client: "watcher" })
  const watched = new Capture(watcher)
  mark = leaderOut.length
  leader.write("later\r")
  await leaderOut.until("LATER", mark)
  await sleep(150)
  expect(watched.length).toBe(0)

  // Once attached, what it missed arrives before any live byte does.
  watcher.attach({ rows: 24, cols: 80 })
  await watched.until("LATER")
  mark = watched.length
  leader.write("live\r")
  await watched.until("got:live", mark)

  watcher.detach()
  leader.detach()
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
  const legit = await ZmxConnection.connect(socket, { client: "legit" })
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
  await expect(ZmxConnection.connect(socket, { versions: { min: 99, max: 100 } })).rejects.toThrow(/daemon speaks protocol 1\.\.1; this client speaks 99\.\.100/)

  // Refused clients leave the session untouched.
  expect(await sessionPid("s3")).not.toBeNull()
})
