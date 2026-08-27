import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import {
  AdeSocket,
  adeSocketPathFor,
  decodeAdeRecord,
  defaultAdeSocketPath,
  HomeActiveError,
  lockPathFor,
  type AdeRecord,
} from "../src/ade-events.ts"
import { listenerAnswers } from "../src/unix-socket.ts"

function socketPath(name: string): string {
  return `/tmp/fmx-ade-test-${name}-${process.pid}.ade.sock`
}

function line(event = "FutureAdditiveEvent"): string {
  return JSON.stringify({
    schema_version: 1,
    sequence: 7,
    event,
    instance_id: "0123456789abcdef0123456789abcdef",
    context: {
      agent_role: "main",
      workspace_root: "/work/fmx",
      session_id: "1787362101388-1787362101388156000-2897385323da2683",
      parent_session_id: null,
      subagent_id: null,
      turn_id: 42,
      agent_state: "blocked",
      attention_kind: "route_recovery",
    },
    payload: { added_later: true },
  })
}

test("decodes every lifecycle snapshot without rejecting unknown additive events", () => {
  expect(decodeAdeRecord(line())).toEqual({
    schemaVersion: 1,
    sequence: 7,
    event: "FutureAdditiveEvent",
    instanceId: "0123456789abcdef0123456789abcdef",
    context: {
      agentRole: "main",
      workspaceRoot: "/work/fmx",
      sessionId: "1787362101388-1787362101388156000-2897385323da2683",
      parentSessionId: null,
      subagentId: null,
      turnId: 42,
      agentState: "blocked",
      attentionKind: "route_recovery",
    },
    payload: { added_later: true },
  })
  expect(decodeAdeRecord("not json")).toBeNull()
  expect(decodeAdeRecord('{"schema_version":2}')).toBeNull()
  expect(decodeAdeRecord(line().replace('"agent_state":"blocked"', '"agent_state":"sleeping"'))).toBeNull()
  expect(decodeAdeRecord(line().replace('"attention_kind":"route_recovery"', '"attention_kind":"recovery"'))).toBeNull()
  expect(decodeAdeRecord(line().replace('"agent_state":"blocked"', '"agent_state":"working"'))).toBeNull()
})

test("derives stable Home paths without an Agent socket", () => {
  expect(defaultAdeSocketPath("abc123", 502)).toBe("/tmp/fmx-502-abc123.ade.sock")
  expect(adeSocketPathFor("/tmp/fmx-501-home.sock")).toBe("/tmp/fmx-501-home.ade.sock")
  expect(adeSocketPathFor("/tmp/fmx-501-home.ade.sock")).toBe("/tmp/fmx-501-home.ade.sock")
  expect(lockPathFor("/tmp/fmx-501-home.ade.sock")).toBe("/tmp/fmx-501-home.lock")
  expect(new AdeSocket({ homeId: "abc123" }).path).toBe(defaultAdeSocketPath("abc123"))
})

test("receives one-way NDJSON on a private bounded socket", async () => {
  const socket = new AdeSocket({ path: socketPath("receive") })
  const records: AdeRecord[] = []
  socket.addEventListener((record) => records.push(record))
  await socket.start()
  try {
    expect(statSync(socket.path).mode & 0o777).toBe(0o600)
    const connection = await Bun.connect({ unix: socket.path, socket: { data: () => {} } })
    const payload = `${line("SessionMetadataChanged")}\n`
    connection.write(payload.slice(0, 19))
    connection.write(payload.slice(19))
    connection.end()

    const deadline = Date.now() + 1_000
    while (records.length === 0 && Date.now() < deadline) await Bun.sleep(1)
    expect(records).toHaveLength(1)
    expect(records[0]?.event).toBe("SessionMetadataChanged")
  } finally {
    socket.close()
  }
  expect(existsSync(socket.path)).toBe(false)
})

test("replays records accepted before the first lifecycle listener subscribes", async () => {
  const socket = new AdeSocket({ path: socketPath("startup-backlog") })
  await socket.start()
  try {
    const connection = await Bun.connect({ unix: socket.path, socket: { data: () => {} } })
    connection.write(`${line("FxStarted")}\n`)
    connection.end()
    // Let the server consume the closed one-way publication while it still
    // has no Multiplexer listener.
    await Bun.sleep(20)

    const records: AdeRecord[] = []
    socket.addEventListener((record) => records.push(record))
    expect(records.map((record) => record.event)).toEqual(["FxStarted"])
  } finally {
    socket.close()
  }
})

test("two Runtimes racing for one Home leave one private feed alive", async () => {
  const path = socketPath("race")
  const a = new AdeSocket({ path })
  const b = new AdeSocket({ path })
  const results = await Promise.allSettled([a.start(), b.start()])
  const refused = results.filter((result) => result.status === "rejected")
  expect(refused).toHaveLength(1)
  expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(HomeActiveError)
  expect(await listenerAnswers(path)).toBe(true)
  a.close()
  b.close()
  expect(await listenerAnswers(path)).toBe(false)
  expect(existsSync(path)).toBe(false)
})

test("a replacement waits for a closing holder and takes over", async () => {
  const path = socketPath("handoff")
  const first = new AdeSocket({ path })
  const replacement = new AdeSocket({ path })
  await first.start()
  const starting = replacement.start()
  setTimeout(() => first.close(), 50)
  await starting
  try {
    expect(await listenerAnswers(path)).toBe(true)
  } finally {
    replacement.close()
  }
})

test("the Home lock refuses another process without disturbing the holder", async () => {
  const path = socketPath("lock")
  const first = new AdeSocket({ path })
  await first.start()
  try {
    const modulePath = new URL("../src/ade-events.ts", import.meta.url).pathname
    const probe = Bun.spawnSync([
      "bun",
      "-e",
      `import { AdeSocket } from ${JSON.stringify(modulePath)}; const s = new AdeSocket({ path: ${JSON.stringify(path)} }); s.start().then(() => { console.log("bound"); s.close() }, (e) => console.log(e.constructor.name))`,
    ])
    expect(probe.stdout.toString().trim()).toBe("HomeActiveError")
    expect(await listenerAnswers(path)).toBe(true)
  } finally {
    first.close()
  }
})

test("a live feed is refused and crash residue is replaced", async () => {
  const path = socketPath("singleton")
  const first = new AdeSocket({ path })
  await first.start()
  try {
    const second = new AdeSocket({ path })
    const refusal = await second.start().catch((error) => error)
    expect(refusal).toBeInstanceOf(HomeActiveError)
    expect(refusal.path).toBe(path)
    second.close()
    expect(await listenerAnswers(path)).toBe(true)
  } finally {
    first.close()
  }

  const crashed = Bun.spawn(["bun", "-e", `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); setTimeout(() => {}, 10_000)`])
  while (!existsSync(path)) await Bun.sleep(10)
  crashed.kill("SIGKILL")
  await crashed.exited
  expect(existsSync(path)).toBe(true)
  expect(await listenerAnswers(path)).toBe(false)

  const replacement = new AdeSocket({ path })
  await replacement.start()
  try {
    expect(await listenerAnswers(path)).toBe(true)
  } finally {
    replacement.close()
  }
})
