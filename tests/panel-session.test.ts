import { expect, test } from "bun:test"
import type { PanelDefinition } from "../src/panels.ts"
import {
  CompanionPanelSessions,
  panelDefinitionFingerprint,
  panelSessionIdentity,
  parsePanelSessionName,
} from "../src/panel-session.ts"
import type { TransportHandlers } from "../src/agent-transport.ts"
import { CompanionCommand, type SessionEntry, type SpawnResult, type Spawner } from "../src/zmx-command.ts"

const HOME = "0123456789ab"
const AGENT = "0123456789abcdef0123456789abcdef"

const definition = (overrides: Partial<PanelDefinition> = {}): PanelDefinition => ({
  id: "diff",
  label: "Diff",
  command: ["hunk", "diff", "--watch"],
  persistent: true,
  ...overrides,
})

test("persistent Tool panel identity follows Home, Agent, id, and argv but not presentation", () => {
  const panel = definition()
  const identity = panelSessionIdentity(HOME, AGENT, panel)
  expect(identity.name).toBe(`fmxp-${HOME}-${AGENT}-${panelDefinitionFingerprint(panel)}`)
  expect(parsePanelSessionName(identity.name)).toEqual({
    homeId: HOME,
    agentId: AGENT,
    fingerprint: identity.fingerprint,
  })
  expect(identity.labels).toEqual({
    owner: "fmx",
    home: HOME,
    kind: "panel",
    agent: AGENT,
    panel: "diff",
    panel_id: "df087996d45b",
    definition: identity.fingerprint,
  })

  expect(panelDefinitionFingerprint(definition({ label: "Changes" }))).toBe(identity.fingerprint)
  expect(panelDefinitionFingerprint(definition({ command: ["hunk", "diff"] }))).not.toBe(identity.fingerprint)
  expect(panelDefinitionFingerprint(definition({ id: "tests" }))).not.toBe(identity.fingerprint)
  // The theme is why the effective argv differs from `command`, so a tool fmx
  // themes is a different tool from the same tool unthemed.
  expect(panelDefinitionFingerprint(definition({ theme: "fmx" }))).not.toBe(identity.fingerprint)
  expect(parsePanelSessionName("fmxp-not-ours")).toBeNull()
})

test("an fmx-themed tool is created with the theme flags and the Ramp, and neither reaches its identity", async () => {
  const panel = definition({ theme: "fmx" })
  const identity = panelSessionIdentity(HOME, AGENT, panel)
  const sessions = new Map<string, SessionEntry>()
  let created: { command: string[]; env: Record<string, string | undefined> } | null = null
  const base = fakeSpawner(sessions, [])
  const spawner: Spawner = async (args, options) => {
    if (args[0] !== "create") return base(args, options)
    created = { command: args.slice(args.indexOf("--") + 1), env: options?.env ?? {} }
    sessions.set(identity.name, live(identity.name, identity.labels, created.command))
    return result({ ok: true, name: identity.name, socketPath: "/tmp/fmx-panel-themed.sock" })
  }
  const companion = new CompanionCommand("/tmp/fmx-panel-themed", {}, spawner)
  const controller = new CompanionPanelSessions(companion, HOME, null, [panel], {
    parentEnvironment: {},
    theme: { extensionPath: "/tmp/fmx-1/hunk-theme.js", ramp: () => '{"background":"#0d1117"}' },
  })

  await controller.open(panel, { agentId: AGENT, displayId: 3, cwd: "/work" }, { cols: 80, rows: 24 }).catch(() => {})
  expect(created).not.toBeNull()
  expect(created!.command).toEqual([
    "hunk",
    "diff",
    "--watch",
    "--extension",
    "/tmp/fmx-1/hunk-theme.js",
    "--theme",
    "fmx",
    "--transparent-bg",
  ])
  expect(created!.env.FMX_RAMP).toBe('{"background":"#0d1117"}')
  // The session's name carries the theme's name and nothing volatile: neither
  // the extension's path nor the host's colors may move a tool's identity.
  expect(identity.name).not.toContain("hunk-theme")
  expect(panelSessionIdentity(HOME, AGENT, panel).fingerprint).toBe(identity.fingerprint)
  controller.close()
})

test("a tool with no theme is launched exactly as defined, with no Ramp in its environment", async () => {
  const panel = definition()
  const identity = panelSessionIdentity(HOME, AGENT, panel)
  const sessions = new Map<string, SessionEntry>()
  let created: { command: string[]; env: Record<string, string | undefined> } | null = null
  const base = fakeSpawner(sessions, [])
  const spawner: Spawner = async (args, options) => {
    if (args[0] !== "create") return base(args, options)
    created = { command: args.slice(args.indexOf("--") + 1), env: options?.env ?? {} }
    sessions.set(identity.name, live(identity.name, identity.labels, created.command))
    return result({ ok: true, name: identity.name, socketPath: "/tmp/fmx-panel-plain.sock" })
  }
  const companion = new CompanionCommand("/tmp/fmx-panel-plain", {}, spawner)
  const controller = new CompanionPanelSessions(companion, HOME, null, [panel], {
    parentEnvironment: { FMX_RAMP: "an older fmx's colors" },
    theme: { extensionPath: "/tmp/fmx-1/hunk-theme.js", ramp: () => '{"background":"#0d1117"}' },
  })

  await controller.open(panel, { agentId: AGENT, displayId: 3, cwd: "/work" }, { cols: 80, rows: 24 }).catch(() => {})
  expect(created).not.toBeNull()
  expect(created!.command).toEqual(["hunk", "diff", "--watch"])
  expect(created!.env.FMX_RAMP).toBeUndefined()
  controller.close()
})

test("reconciliation keeps exact sessions, removes stale owned ones, and leaves label impostors alone", async () => {
  const current = panelSessionIdentity(HOME, AGENT, definition())
  const stale = panelSessionIdentity(HOME, AGENT, definition({ command: ["old-diff"] }))
  const stranger = panelSessionIdentity(HOME, AGENT, definition({ id: "tests", command: ["tests"] }))
  const exitedStranger = panelSessionIdentity(HOME, AGENT, definition({ id: "logs", command: ["logs"] }))
  const retired = panelSessionIdentity(HOME, AGENT, definition({ id: "retired", command: ["retired"] }))
  const ambiguous = panelSessionIdentity(HOME, AGENT, definition({ id: "status", command: ["status"] }))
  const sessions = new Map<string, SessionEntry>([
    [current.name, live(current.name, current.labels, definition().command)],
    [stale.name, live(stale.name, stale.labels, null)],
    [
      stranger.name,
      live(stranger.name, {
        ...stranger.labels,
        definition: "000000000000",
      }, ["tests"]),
    ],
    [
      exitedStranger.name,
      {
        ...live(exitedStranger.name, { ...exitedStranger.labels, panel: "somebody-else" }, null),
        state: "exited",
      },
    ],
    [retired.name, { ...live(retired.name, retired.labels, null), state: "exited" }],
    [ambiguous.name, { ...live(ambiguous.name, {}), state: "refused" }],
  ])
  const calls: string[] = []
  const companion = new CompanionCommand("/tmp/fmx-panel-test", {}, fakeSpawner(sessions, calls))
  const controller = new CompanionPanelSessions(companion, HOME, null, [definition()])

  const outcome = await controller.reconcile([AGENT])
  expect(outcome.kept).toEqual([current.name])
  expect(outcome.stopped).toEqual([stale.name])
  expect(outcome.ignored).toEqual([stranger.name, exitedStranger.name])
  expect(outcome.forgotten).toEqual([retired.name])
  expect(outcome.unresolved).toEqual([ambiguous.name])
  expect(calls).toContain(`kill ${stale.name}`)
  expect(calls).toContain(`forget ${stale.name}`)
  expect(calls).not.toContain(`kill ${stranger.name}`)
  expect(calls).not.toContain(`forget ${exitedStranger.name}`)
  expect(calls).toContain(`forget ${retired.name}`)
  expect(sessions.has(current.name)).toBe(true)
  expect(sessions.has(stale.name)).toBe(false)
  expect(sessions.has(stranger.name)).toBe(true)
})

test("an Agent ending during create cannot leave a persistent tool behind", async () => {
  const panel = definition()
  const identity = panelSessionIdentity(HOME, AGENT, panel)
  const sessions = new Map<string, SessionEntry>()
  const calls: string[] = []
  const createStarted = Promise.withResolvers<void>()
  const finishCreate = Promise.withResolvers<void>()
  const base = fakeSpawner(sessions, calls)
  const spawner: Spawner = async (args, options) => {
    if (args[0] !== "create") return base(args, options)
    createStarted.resolve()
    await finishCreate.promise
    sessions.set(identity.name, live(identity.name, identity.labels, panel.command))
    return result({ ok: true, name: identity.name, socketPath: `/tmp/${identity.name}.sock`, pid: 1, createdAt: 1 })
  }
  const companion = new CompanionCommand("/tmp/fmx-panel-race", {}, spawner)
  const controller = new CompanionPanelSessions(companion, HOME, null, [panel])

  const opening = controller.open(panel, { agentId: AGENT, displayId: 7, cwd: "/work" }, { cols: 80, rows: 24 })
  await createStarted.promise
  await controller.stopAgent(AGENT)
  finishCreate.resolve()

  expect(await opening.catch((error) => error)).toBeInstanceOf(Error)
  expect(calls).toContain(`kill ${identity.name}`)
  expect(calls).toContain(`forget ${identity.name}`)
  expect(sessions.has(identity.name)).toBe(false)
})

test("a timed-out create that appears after its Agent ends is retired when it becomes live", async () => {
  const panel = definition()
  const identity = panelSessionIdentity(HOME, AGENT, panel)
  const sessions = new Map<string, SessionEntry>()
  const calls: string[] = []
  const createStarted = Promise.withResolvers<void>()
  const finishCreate = Promise.withResolvers<void>()
  const base = fakeSpawner(sessions, calls)
  const spawner: Spawner = async (args, options) => {
    if (args[0] !== "create") return base(args, options)
    createStarted.resolve()
    await finishCreate.promise
    return result({ ok: false, name: identity.name, error: "Timeout", message: "still starting" }, 1)
  }
  const companion = new CompanionCommand("/tmp/fmx-panel-timeout-race", {}, spawner)
  const controller = new CompanionPanelSessions(companion, HOME, null, [panel])

  const opening = controller.open(panel, { agentId: AGENT, displayId: 7, cwd: "/work" }, { cols: 80, rows: 24 })
  await createStarted.promise
  await controller.stopAgent(AGENT)
  finishCreate.resolve()
  expect(await opening.catch((error) => error)).toBeInstanceOf(Error)

  sessions.set(identity.name, live(identity.name, identity.labels, panel.command))
  const deadline = Date.now() + 2_000
  while (sessions.has(identity.name) && Date.now() < deadline) await Bun.sleep(20)

  expect(calls).toContain(`kill ${identity.name}`)
  expect(calls).toContain(`forget ${identity.name}`)
  expect(sessions.has(identity.name)).toBe(false)
  controller.close()
})

test("a transient inspection failure after a timed-out create still arms retirement", async () => {
  const panel = definition()
  const identity = panelSessionIdentity(HOME, AGENT, panel)
  const sessions = new Map<string, SessionEntry>()
  const calls: string[] = []
  const createStarted = Promise.withResolvers<void>()
  const finishCreate = Promise.withResolvers<void>()
  let inspectionsFail = false
  const base = fakeSpawner(sessions, calls)
  const spawner: Spawner = async (args, options) => {
    if (args[0] === "inspect" && inspectionsFail) return result(null, 1, "temporary inspection failure")
    if (args[0] !== "create") return base(args, options)
    createStarted.resolve()
    await finishCreate.promise
    return result({ ok: false, name: identity.name, error: "Timeout", message: "still starting" }, 1)
  }
  const companion = new CompanionCommand("/tmp/fmx-panel-inspect-race", {}, spawner)
  const controller = new CompanionPanelSessions(companion, HOME, null, [panel])

  const opening = controller.open(panel, { agentId: AGENT, displayId: 7, cwd: "/work" }, { cols: 80, rows: 24 })
  await createStarted.promise
  inspectionsFail = true
  await controller.stopAgent(AGENT)
  finishCreate.resolve()
  expect(await opening.catch((error) => error)).toBeInstanceOf(Error)

  sessions.set(identity.name, live(identity.name, identity.labels, panel.command))
  inspectionsFail = false
  const deadline = Date.now() + 2_000
  while (sessions.has(identity.name) && Date.now() < deadline) await Bun.sleep(20)

  expect(calls).toContain(`kill ${identity.name}`)
  expect(calls).toContain(`forget ${identity.name}`)
  expect(sessions.has(identity.name)).toBe(false)
  controller.close()
})

test.skipIf(typeof Bun.Terminal !== "function")("a non-persistent tool starts locally in the active Agent environment", async () => {
  const companion = new CompanionCommand("/tmp/fmx-panel-unused", {}, async () => {
    throw new Error("a local tool must not call the Companion")
  })
  const panel = definition({
    id: "local",
    command: [
      process.execPath,
      "-e",
      'process.stdout.write(`${process.cwd()}|${process.env.FMX_AGENT_ID}|${process.env.FMX_PANEL_ID}|${process.env.FMX_SOCKET_PATH}\\n`); setInterval(() => {}, 1000)',
    ],
    persistent: false,
  })
  const controller = new CompanionPanelSessions(companion, HOME, "/tmp/fmx.ctl", [panel], {
    parentEnvironment: { PATH: process.env.PATH },
  })
  const transport = await controller.open(
    panel,
    { agentId: AGENT, displayId: 7, cwd: process.cwd() },
    { cols: 80, rows: 24 },
  )
  const output = Promise.withResolvers<string>()
  let text = ""
  const handlers: TransportHandlers = {
    output: (bytes) => {
      text += new TextDecoder().decode(bytes)
      if (text.includes("\n")) output.resolve(text)
    },
    restoreBegin: () => {},
    ready: () => {},
    exit: () => {},
    lost: (error) => output.reject(error),
  }
  transport.bind(handlers)
  try {
    expect(await Promise.race([output.promise, Bun.sleep(2_000).then(() => "timeout")])).toContain(
      `${process.cwd()}|7|local|/tmp/fmx.ctl`,
    )
  } finally {
    transport.detach()
    controller.close()
  }
})

function live(name: string, labels: Record<string, string>, command: string[] | null = ["tool"]): SessionEntry {
  return {
    name,
    state: "live",
    socketPath: `/tmp/${name}.sock`,
    pid: 1,
    clients: 0,
    createdAt: 1,
    command,
    cwd: "/work",
    labels,
    exit: null,
    detail: null,
  }
}

function fakeSpawner(sessions: Map<string, SessionEntry>, calls: string[]): Spawner {
  return async (args): Promise<SpawnResult> => {
    const verb = args[0]
    if (verb === "list") return result([...sessions.values()].map(wireEntry))
    if (verb === "inspect" && args[2]) return result(wireEntry(sessions.get(args[2]) ?? absent(args[2])))
    const name = args[1]
    if (verb === "kill" && name) {
      calls.push(`kill ${name}`)
      const entry = sessions.get(name)
      if (entry) sessions.set(name, { ...entry, state: "exited", socketPath: null })
      return result(null, 0, "")
    }
    if (verb === "forget" && name) {
      calls.push(`forget ${name}`)
      sessions.delete(name)
      return result(null, 0, "")
    }
    throw new Error(`unexpected Companion call: ${args.join(" ")}`)
  }
}

function wireEntry(entry: SessionEntry): SessionEntry & { cmd?: string } {
  return entry.command === null ? entry : { ...entry, cmd: entry.command.join(" ") }
}

function absent(name: string): SessionEntry {
  return {
    name,
    state: "absent",
    socketPath: null,
    pid: null,
    clients: null,
    createdAt: null,
    command: null,
    cwd: null,
    labels: {},
    exit: null,
    detail: null,
  }
}

function result(value: unknown, exitCode = 0, stderr = ""): SpawnResult {
  return { exitCode, stdout: value === null ? "" : JSON.stringify(value), stderr }
}
