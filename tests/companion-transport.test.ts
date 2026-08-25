import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { CompanionTransportFactory } from "../src/companion-transport.ts"
import { AgentManifest, identityFor, type ManifestEntry } from "../src/agent-manifest.ts"
import { AgentEndedError, type AgentTransport, type TransportHandlers } from "../src/agent-transport.ts"
import { ownershipLabels } from "../src/agent-reconcile.ts"
import { CompanionCommand, type SessionEntry } from "../src/zmx-command.ts"

/**
 * The Companion behind the Agent transport seam, against the real
 * binary: what the multiplexer sees when it starts, attaches to, loses, and
 * outlives an Agent. Needs FMX_ZMX_PATH; sessions live in a private
 * directory under /tmp and every one this file starts is ended by it.
 */
const ZMX = process.env.FMX_ZMX_PATH
const ENABLED = Boolean(ZMX && existsSync(ZMX))
const HOME = "0123456789ab"

const decoder = new TextDecoder()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(50)
  }
  return check()
}

const CHILD_SCRIPT = [
  "echo READY",
  'while IFS= read -r l; do case "$l" in',
  "  quit) exit 7;;",
  '  *) echo "got:$l";;',
  "esac; done",
].join("\n")

let dir = ""
let companion: CompanionCommand
let factory: CompanionTransportFactory
let manifest: AgentManifest

/** A consumer of one transport: everything it was told, in order. */
type Watcher = {
  text: string
  restores: number
  readies: number
  exited: { code: number; signal: number } | null
  lost: Error | null
}

const watch = (transport: AgentTransport): Watcher => {
  const watcher: Watcher = { text: "", restores: 0, readies: 0, exited: null, lost: null }
  const handlers: TransportHandlers = {
    output: (bytes) => {
      watcher.text += decoder.decode(bytes)
    },
    restoreBegin: () => {
      watcher.restores += 1
      // A restore replaces the screen, as the multiplexer's reset does.
      watcher.text = ""
    },
    ready: () => {
      watcher.readies += 1
    },
    exit: (status) => {
      watcher.exited = status
    },
    lost: (error) => {
      watcher.lost = error
    },
  }
  transport.bind(handlers)
  return watcher
}

const inertTransport: AgentTransport = {
  bind() {},
  write() {},
  resize() {},
  detach() {},
}

const restoredEntry = (agentId = "d".repeat(32)): ManifestEntry => ({
  ...identityFor(agentId),
  displayId: 1,
  cwd: "/work",
  fxPath: "/fx",
  fxArgs: [],
  createdAt: 1,
  fxSessionId: null,
  agentStatus: null,
  phase: "running",
})

const liveSession = (entry: ManifestEntry, socketPath: string): SessionEntry => ({
  name: entry.zmxName,
  state: "live",
  socketPath,
  pid: 1,
  clients: 0,
  createdAt: 1,
  command: [entry.fxPath],
  cwd: entry.cwd,
  labels: ownershipLabels(HOME, entry.agentId),
  exit: null,
  detail: null,
})

test("a reconciled live endpoint attaches without another Companion inspection", async () => {
  const entry = restoredEntry()
  const hint = liveSession(entry, "/tmp/reconciled-agent")
  let inspections = 0
  const paths: string[] = []
  const hintedFactory = new CompanionTransportFactory(
    {
      settle: async () => {
        inspections += 1
        return hint
      },
    } as unknown as CompanionCommand,
    HOME,
    {
      attachHints: new Map([[entry.agentId, hint]]),
      connect: async (path) => {
        paths.push(path)
        return inertTransport
      },
    },
  )

  expect(await hintedFactory.attach(entry, { cols: 80, rows: 24 })).toBe(inertTransport)
  expect(paths).toEqual([hint.socketPath!])
  expect(inspections).toBe(0)
})

test("a stale reconciled endpoint falls back to inspection and its current endpoint", async () => {
  const entry = restoredEntry("e".repeat(32))
  const hint = liveSession(entry, "/tmp/stale-agent")
  const current = liveSession(entry, "/tmp/current-agent")
  let inspections = 0
  const paths: string[] = []
  const hintedFactory = new CompanionTransportFactory(
    {
      settle: async () => {
        inspections += 1
        return current
      },
    } as unknown as CompanionCommand,
    HOME,
    {
      attachHints: new Map([[entry.agentId, hint]]),
      connect: async (path) => {
        paths.push(path)
        if (path === hint.socketPath) throw new Error("stale endpoint")
        return inertTransport
      },
    },
  )

  expect(await hintedFactory.attach(entry, { cols: 80, rows: 24 })).toBe(inertTransport)
  expect(paths).toEqual([hint.socketPath!, current.socketPath!])
  expect(inspections).toBe(1)
})

test("a stale endpoint never falls through to a foreign session under the Agent's name", async () => {
  const entry = restoredEntry("f".repeat(32))
  const hint = liveSession(entry, "/tmp/stale-agent")
  const foreign = {
    ...liveSession(entry, "/tmp/foreign-agent"),
    labels: ownershipLabels("stranger", entry.agentId),
  }
  const paths: string[] = []
  const hintedFactory = new CompanionTransportFactory(
    { settle: async () => foreign } as unknown as CompanionCommand,
    HOME,
    {
      attachHints: new Map([[entry.agentId, hint]]),
      connect: async (path) => {
        paths.push(path)
        throw new Error("stale endpoint")
      },
    },
  )

  const error = await hintedFactory.attach(entry, { cols: 80, rows: 24 }).catch((caught) => caught)
  expect(error).toBeInstanceOf(AgentEndedError)
  expect(paths).toEqual([hint.socketPath!])
})

const claim = async (): Promise<ManifestEntry> =>
  manifest.beginCreate({ cwd: dir, fxPath: "/bin/sh", fxArgs: ["-c", CHILD_SCRIPT], createdAt: Date.now() })

const start = async (entry: ManifestEntry): Promise<AgentTransport> =>
  factory.start({
    entry,
    command: [entry.fxPath, ...(entry.fxArgs ?? [])],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm" },
    size: { cols: 80, rows: 24 },
  })

beforeAll(async () => {
  if (!ENABLED) return
  dir = await mkdtemp("/tmp/fmxz-tr-")
  companion = new CompanionCommand(dir, { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, ZMX!)
  factory = new CompanionTransportFactory(companion, HOME, { scrollbackLines: 200 })
  manifest = AgentManifest.ephemeral(HOME)
})

afterAll(async () => {
  if (!ENABLED) return
  for (const session of await companion.list()) {
    if (session.state === "live") await companion.kill(session.name).catch(() => {})
  }
  // A kill is accepted before it is done: the name reads `refused` until the
  // daemon has reaped, recorded, and unlinked.
  await waitFor(
    async () => (await companion.list()).every((session) => session.state === "exited" || session.state === "absent"),
    8000,
  )
  for (const session of await companion.list()) {
    if (session.state === "exited") await companion.forget(session.name).catch(() => {})
  }
  expect(await companion.list()).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test.skipIf(!ENABLED)("start creates a labelled session, attaches with a restore, and writes through", async () => {
  const entry = await claim()
  const transport = await start(entry)
  const watcher = watch(transport)
  await waitFor(() => watcher.readies === 1 && watcher.text.includes("READY"))
  expect(watcher.restores).toBe(1)
  const session = await companion.inspect(entry.zmxName)
  expect(session.state).toBe("live")
  expect(session.labels).toEqual({ owner: "fmx", home: HOME, agent: entry.agentId, pane: entry.paneId })
  expect(session.clients).toBe(1)

  transport.write(new TextEncoder().encode("hello\n"))
  await waitFor(() => watcher.text.includes("got:hello"))
  transport.detach()
  await waitFor(async () => (await companion.inspect(entry.zmxName)).clients === 0)
  expect((await companion.inspect(entry.zmxName)).state).toBe("live")
})

test.skipIf(!ENABLED)("a hinted socket revalidates its live daemon's ownership before attach", async () => {
  const entry = restoredEntry("c".repeat(32))
  const created = await companion.create({
    name: entry.zmxName,
    command: ["/bin/sh", "-c", CHILD_SCRIPT],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm" },
    labels: ownershipLabels("stranger", entry.agentId),
    scrollbackLines: 200,
  })
  const hintedFactory = new CompanionTransportFactory(companion, HOME, {
    attachHints: new Map([[entry.agentId, liveSession(entry, created.socketPath)]]),
  })

  const error = await hintedFactory.attach(entry, { cols: 80, rows: 24 }).catch((caught) => caught)
  expect(error).toBeInstanceOf(AgentEndedError)
  expect(await companion.inspect(entry.zmxName)).toMatchObject({
    state: "live",
    labels: ownershipLabels("stranger", entry.agentId),
    clients: 0,
  })
})

test.skipIf(!ENABLED)("attach replays the screen onto a reset, and the child survives every detach", async () => {
  const entry = await claim()
  const first = await start(entry)
  const before = watch(first)
  await waitFor(() => before.text.includes("READY"))
  first.write(new TextEncoder().encode("one\n"))
  await waitFor(() => before.text.includes("got:one"))
  first.detach()

  const second = await factory.attach(entry, { cols: 80, rows: 24 })
  const after = watch(second)
  await waitFor(() => after.readies === 1)
  expect(after.restores).toBe(1)
  expect(after.text).toContain("got:one")
  second.write(new TextEncoder().encode("two\n"))
  await waitFor(() => after.text.includes("got:two"))
  expect(after.exited).toBeNull()
  expect(after.lost).toBeNull()
  second.detach()
})

test.skipIf(!ENABLED)("an exit is exact, final output comes first, and the record is consumed", async () => {
  const entry = await claim()
  const transport = await start(entry)
  const watcher = watch(transport)
  await waitFor(() => watcher.text.includes("READY"))
  transport.write(new TextEncoder().encode("last\nquit\n"))
  await waitFor(() => watcher.exited !== null)
  expect(watcher.text).toContain("got:last")
  expect(watcher.exited).toEqual({ code: 7, signal: 0 })
  expect(watcher.lost).toBeNull()
  // The daemon records the exit after it has sent it; the factory waits and forgets.
  await waitFor(async () => (await companion.inspect(entry.zmxName)).state === "absent", 8000)
  expect((await companion.inspect(entry.zmxName)).state).toBe("absent")
})

test.skipIf(!ENABLED)("attaching to an ended Agent says so, with its status", async () => {
  const entry = await claim()
  const transport = await start(entry)
  const watcher = watch(transport)
  await waitFor(() => watcher.text.includes("READY"))
  transport.detach()
  // End it while nobody is watching, the way an exit while fmx is down happens.
  await companion.kill(entry.zmxName)
  await waitFor(async () => (await companion.inspect(entry.zmxName)).state === "exited")

  const error = await factory.attach(entry, { cols: 80, rows: 24 }).catch((caught) => caught)
  expect(error).toBeInstanceOf(AgentEndedError)
  expect((error as AgentEndedError).exit?.signal).toBeGreaterThan(0)
  expect((await companion.inspect(entry.zmxName)).state).toBe("absent")
})

test.skipIf(!ENABLED)("a daemon that vanishes is a lost transport, never an exit", async () => {
  const entry = await claim()
  const transport = await start(entry)
  const watcher = watch(transport)
  await waitFor(() => watcher.text.includes("READY"))
  const session = await companion.inspect(entry.zmxName)
  // The daemon's pid is not reported; the child's is, and its parent is the daemon.
  const parent = await Bun.$`ps -o ppid= -p ${session.pid!}`.text()
  process.kill(Number(parent.trim()), "SIGKILL")
  await waitFor(() => watcher.lost !== null)
  expect(watcher.exited).toBeNull()
  // The child goes with its controlling terminal.
  await waitFor(() => {
    try {
      process.kill(session.pid!, 0)
      return false
    } catch {
      return true
    }
  })
  // The socket file is what a SIGKILLed daemon leaves: still refused after
  // the settle window, which an attach reads as ended and clears.
  expect((await companion.inspect(entry.zmxName)).state).toBe("refused")
  const error = await factory.attach(entry, { cols: 80, rows: 24 }).catch((caught) => caught)
  expect(error).toBeInstanceOf(AgentEndedError)
  expect((await companion.inspect(entry.zmxName)).state).toBe("absent")
})

test.skipIf(!ENABLED)("the child's environment is the one given, with nothing of the Companion's", async () => {
  const entry = await manifest.beginCreate({ cwd: dir, fxPath: "/bin/sh", fxArgs: ["-c", "env; sleep 30"], createdAt: Date.now() })
  const transport = await factory.start({
    entry,
    command: [entry.fxPath, ...(entry.fxArgs ?? [])],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm", MARK: "given" },
    size: { cols: 120, rows: 24 },
  })
  const watcher = watch(transport)
  await waitFor(() => watcher.readies === 1 && watcher.text.includes("MARK=given"))
  expect(watcher.text).not.toContain("ZMX_SESSION=")
  expect(watcher.text).not.toContain("ZMX_DIR=")
  expect(watcher.text).not.toContain("ZMX_NO_DETACH_KEY=")
  transport.detach()
})
