import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { AdeSocket, adeSocketPathFor, decodeAdeRecord, type AdeRecord } from "../src/ade-events.ts"

function socketPath(name: string): string {
  return `/tmp/fmx-ade-test-${name}-${process.pid}.sock`
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
    },
    payload: { added_later: true },
  })
}

test("decodes schema-1 records without rejecting unknown additive events", () => {
  expect(decodeAdeRecord(line())).toEqual({
    schemaVersion: 1,
    sequence: 7,
    event: "FutureAdditiveEvent",
    instanceId: "0123456789abcdef0123456789abcdef",
    context: {
      agentRole: "main",
      sessionId: "1787362101388-1787362101388156000-2897385323da2683",
      parentSessionId: null,
    },
    payload: { added_later: true },
  })
  expect(decodeAdeRecord("not json")).toBeNull()
  expect(decodeAdeRecord('{"schema_version":2}')).toBeNull()
})

test("derives a stable ADE path beside the Agent socket", () => {
  expect(adeSocketPathFor("/tmp/fmx-501-home.sock")).toBe("/tmp/fmx-501-home.ade.sock")
  expect(adeSocketPathFor("/tmp/custom")).toBe("/tmp/custom.ade.sock")
})

test("receives one-way NDJSON on a private bounded socket", async () => {
  const socket = new AdeSocket({ path: socketPath("receive") })
  const records: AdeRecord[] = []
  socket.addEventListener((record) => records.push(record))
  socket.start()
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
