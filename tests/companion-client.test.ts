import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  CompanionConnection,
  CompanionOwnershipMismatchError,
  setListenerErrorHandler,
} from "../src/companion-client.ts"
import {
  decodeHello,
  encodeExit,
  encodeFrame,
  encodeWelcome,
  ExitReason,
  HEADER_LEN,
  PROTOCOL_VERSION,
  ProtocolError,
  Tag,
} from "../src/zmx-protocol.ts"

/**
 * The client against a stub daemon: a Unix socket that speaks the frames a
 * Companion would, so the handshake and delivery are testable without a
 * binary, at byte granularity a real daemon would not let us choose.
 */
type Stub = {
  path: string
  /** Frames the client has sent us. */
  received: { tag: number; payload: Uint8Array }[]
  /** Push bytes to the connected client. */
  push: (bytes: Uint8Array) => void
  /** Drop the connection from this side. */
  stop: () => void
}

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const startStub = async (replyToHello: () => Uint8Array | null): Promise<Stub> => {
  const dir = await mkdtemp("/tmp/fmxz-stub-")
  const path = join(dir, "sock")
  const received: Stub["received"] = []
  let client: { write: (bytes: Uint8Array) => number } | null = null
  const server = Bun.listen({
    unix: path,
    socket: {
      open: (socket) => {
        client = socket
      },
      data: (socket, data) => {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        // Frames from the client are small and unfragmented in these tests.
        let offset = 0
        while (offset + HEADER_LEN <= bytes.byteLength) {
          const len = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(1, true)
          const tag = bytes[offset]!
          received.push({ tag, payload: bytes.slice(offset + HEADER_LEN, offset + HEADER_LEN + len) })
          if (tag === Tag.Hello) {
            const reply = replyToHello()
            if (reply) socket.write(reply)
          }
          offset += HEADER_LEN + len
        }
      },
    },
  })
  const stub: Stub = {
    path,
    received,
    push: (bytes) => {
      client?.write(bytes)
    },
    stop: () => server.stop(true),
  }
  cleanups.push(async () => {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  })
  return stub
}

const accept = encodeFrame(
  Tag.Welcome,
  encodeWelcome({ version: PROTOCOL_VERSION, minVersion: 1, maxVersion: PROTOCOL_VERSION, capabilities: 0 }),
)
const refuse = encodeFrame(Tag.Welcome, encodeWelcome({ version: 0, minVersion: 1, maxVersion: PROTOCOL_VERSION, capabilities: 0 }))
const output = (text: string) => encodeFrame(Tag.Output, new TextEncoder().encode(text))
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

test("connect resolves on an accepting Welcome and names the client", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path, { client: "fmx-test" })
  expect(connection.welcome.version).toBe(PROTOCOL_VERSION)
  expect(decodeHello(stub.received[0]!.payload).client).toBe("fmx-test")
  connection.close()
})

test("labels reads and validates the identity on the negotiated connection", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const labels = connection.labels()
  await settle()
  expect(stub.received.at(-1)?.tag).toBe(Tag.LabelGet)
  stub.push(encodeFrame(Tag.LabelData, new TextEncoder().encode("agent=abc home=012 owner=fmx pane=p_abc")))
  expect(await labels).toEqual({ agent: "abc", home: "012", owner: "fmx", pane: "p_abc" })
  connection.close()
})

test("labels rejects malformed identity data", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const labels = connection.labels()
  await settle()
  stub.push(encodeFrame(Tag.LabelData, new TextEncoder().encode("owner=fmx owner=other")))
  await expect(labels).rejects.toThrow("malformed LabelData")
  connection.close()
})

test("owned Kill verifies labels and terminates on the same negotiated connection", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const flushed: string[] = []
  const killed = connection.killIfOwned(
    { owner: "fmx", home: "home-a", agent: "agent-a", pane: "p_agent-a" },
    { afterFlush: () => { flushed.push("kill-flushed") } },
  )
  await settle()
  expect(stub.received.at(-1)?.tag).toBe(Tag.LabelGet)
  stub.push(encodeFrame(
    Tag.LabelData,
    new TextEncoder().encode("owner=fmx home=home-a agent=agent-a pane=p_agent-a extra=retained"),
  ))
  await settle()
  expect(stub.received.at(-1)?.tag).toBe(Tag.Kill)
  expect(stub.received.map(({ tag }) => tag)).toEqual([Tag.Hello, Tag.LabelGet, Tag.Kill])
  expect(stub.received.at(-1)?.payload.byteLength).toBe(0)
  expect(stub.received.map(({ tag }) => tag)).not.toContain(Tag.Init)
  expect(flushed).toEqual(["kill-flushed"])
  stub.push(encodeFrame(Tag.Exit, encodeExit({ code: 0, signal: 9, reason: ExitReason.requested })))
  expect(await killed).toEqual({
    kind: "exit",
    status: { code: 0, signal: 9, reason: ExitReason.requested },
  })
  connection.close()
})

test("owned Kill refuses a label mismatch without sending Kill", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const killed = connection.killIfOwned(
    { owner: "fmx", home: "home-a", agent: "agent-a", pane: "p_agent-a" },
  )
  await settle()
  stub.push(encodeFrame(
    Tag.LabelData,
    new TextEncoder().encode("owner=fmx home=home-a agent=foreign pane=p_foreign"),
  ))
  await expect(killed).rejects.toBeInstanceOf(CompanionOwnershipMismatchError)
  expect(stub.received.map(({ tag }) => tag)).not.toContain(Tag.Kill)
  connection.close()
})

test("owned Kill reports close without Exit as indeterminate", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const killed = connection.killIfOwned(
    { owner: "fmx", home: "home-a", agent: "agent-a", pane: "p_agent-a" },
  )
  await settle()
  stub.push(encodeFrame(
    Tag.LabelData,
    new TextEncoder().encode("owner=fmx home=home-a agent=agent-a pane=p_agent-a"),
  ))
  await settle()
  expect(stub.received.at(-1)?.tag).toBe(Tag.Kill)
  stub.stop()
  expect((await killed).kind).toBe("closed")
})

test("owned Kill returns a preobserved Exit without sending Kill", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const killed = connection.killIfOwned(
    { owner: "fmx", home: "home-a", agent: "agent-a", pane: "p_agent-a" },
  )
  await settle()
  stub.push(Buffer.concat([
    encodeFrame(
      Tag.LabelData,
      new TextEncoder().encode("owner=fmx home=home-a agent=agent-a pane=p_agent-a"),
    ),
    encodeFrame(Tag.Exit, encodeExit({ code: 7, signal: 0, reason: ExitReason.natural })),
  ]))
  expect(await killed).toEqual({
    kind: "exit",
    status: { code: 7, signal: 0, reason: ExitReason.natural },
  })
  expect(stub.received.map(({ tag }) => tag)).toEqual([Tag.Hello, Tag.LabelGet])
  connection.close()
})

test("owned Kill prefers an Exit delivered immediately before close", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const killed = connection.killIfOwned(
    { owner: "fmx", home: "home-a", agent: "agent-a", pane: "p_agent-a" },
  )
  await settle()
  stub.push(encodeFrame(
    Tag.LabelData,
    new TextEncoder().encode("owner=fmx home=home-a agent=agent-a pane=p_agent-a"),
  ))
  await settle()
  stub.push(encodeFrame(Tag.Exit, encodeExit({ code: 0, signal: 9, reason: ExitReason.requested })))
  stub.stop()
  expect(await killed).toEqual({
    kind: "exit",
    status: { code: 0, signal: 9, reason: ExitReason.requested },
  })
})

test("owned Kill outcome timeout remains indeterminate", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const killed = connection.killIfOwned(
    { owner: "fmx", home: "home-a", agent: "agent-a", pane: "p_agent-a" },
    { outcomeTimeoutMs: 25 },
  )
  await settle()
  stub.push(encodeFrame(
    Tag.LabelData,
    new TextEncoder().encode("owner=fmx home=home-a agent=agent-a pane=p_agent-a"),
  ))
  expect(await killed).toEqual({ kind: "timeout" })
  expect(stub.received.at(-1)?.tag).toBe(Tag.Kill)
  connection.close()
})

test("owned Kill sends nothing after malformed LabelData", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const killed = connection.killIfOwned(
    { owner: "fmx", home: "home-a", agent: "agent-a", pane: "p_agent-a" },
  )
  await settle()
  stub.push(encodeFrame(Tag.LabelData, new TextEncoder().encode("owner=fmx owner=other")))
  await expect(killed).rejects.toThrow("malformed LabelData")
  expect(stub.received.map(({ tag }) => tag)).toEqual([Tag.Hello, Tag.LabelGet])
  connection.close()
})

test("owned Kill sends nothing when the exact label query times out", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  await expect(connection.killIfOwned(
    { owner: "fmx", home: "home-a", agent: "agent-a", pane: "p_agent-a" },
    { labelTimeoutMs: 25 },
  )).rejects.toThrow("no LabelData")
  expect(stub.received.map(({ tag }) => tag)).toEqual([Tag.Hello, Tag.LabelGet])
  connection.close()
})

test("a refused Welcome rejects with both version ranges", async () => {
  const stub = await startStub(() => refuse)
  await expect(CompanionConnection.connect(stub.path, { versions: { min: 42, max: 43 } })).rejects.toThrow(
    /daemon speaks protocol 1\.\.1; this client speaks 42\.\.43/,
  )
})

test("a daemon that never answers Hello fails instead of hanging", async () => {
  const stub = await startStub(() => null)
  await expect(CompanionConnection.connect(stub.path, { helloTimeoutMs: 150 })).rejects.toThrow(/no Welcome from daemon within 150ms/)
})

test("output coalesced with the Welcome reaches a listener registered afterwards", async () => {
  // One write carrying the handshake reply and a frame behind it, which is
  // what a busy daemon does. Nothing is listening until connect() returns.
  const stub = await startStub(() => Buffer.concat([accept, output("COALESCED")]))
  const connection = await CompanionConnection.connect(stub.path)
  let seen = ""
  connection.onOutput((bytes) => {
    seen += new TextDecoder().decode(bytes)
  })
  await settle()
  expect(seen).toBe("COALESCED")
  connection.close()
})

test("a restore burst coalesced with the Welcome survives listeners registered one at a time", async () => {
  // The whole boundary in the packet that answers Hello, which is what a busy
  // daemon does — and the caller subscribes in the order the API invites.
  const stub = await startStub(() =>
    Buffer.concat([
      accept,
      encodeFrame(Tag.RestoreBegin),
      output("RESTORED"),
      encodeFrame(Tag.Ready),
      output("LIVE"),
    ]),
  )
  const connection = await CompanionConnection.connect(stub.path)
  const events: string[] = []
  connection.onRestoreBegin(() => events.push("restore-begin"))
  connection.onOutput((bytes) => events.push(`out:${new TextDecoder().decode(bytes)}`))
  connection.onReady(() => events.push("ready"))
  await settle()
  expect(events).toEqual(["restore-begin", "out:RESTORED", "ready", "out:LIVE"])
  connection.close()
})

test("held frames nobody wants are dropped rather than blocking the ones that follow", async () => {
  // A caller that only wants output: the boundary frames it never subscribed
  // to must not dam the stream behind them.
  const stub = await startStub(() =>
    Buffer.concat([accept, encodeFrame(Tag.RestoreBegin), output("RESTORED"), encodeFrame(Tag.Ready)]),
  )
  const connection = await CompanionConnection.connect(stub.path)
  const seen: string[] = []
  connection.onOutput((bytes) => seen.push(new TextDecoder().decode(bytes)))
  await settle()
  expect(seen).toEqual(["RESTORED"])
  connection.close()
})

test("a listener that throws neither skips the others nor stalls the stream", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const failures: string[] = []
  setListenerErrorHandler((error) => failures.push(String(error)))
  cleanups.push(() => setListenerErrorHandler((error) => console.error("companion listener failed:", error)))
  const seen: string[] = []
  connection.onOutput(() => {
    throw new Error("listener blew up")
  })
  connection.onOutput((bytes) => seen.push(new TextDecoder().decode(bytes)))
  // Two frames in one packet: the second must still arrive, and so must a
  // frame sent after the throwing listener has already thrown once.
  stub.push(Buffer.concat([output("one"), output("two")]))
  await settle()
  stub.push(output("three"))
  await settle()
  expect(seen).toEqual(["one", "two", "three"])
  // Reported, not swallowed: once per frame the throwing listener saw.
  expect(failures).toEqual(["Error: listener blew up", "Error: listener blew up", "Error: listener blew up"])
  connection.close()
})

test("the restore boundary and exit reach their listeners in order", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const events: string[] = []
  connection.onRestoreBegin(() => events.push("restore-begin"))
  connection.onOutput((bytes) => events.push(`out:${new TextDecoder().decode(bytes)}`))
  connection.onReady(() => events.push("ready"))
  connection.onExit((status) => events.push(`exit:${status.code}/${status.signal}/${status.reason}`))

  stub.push(
    Buffer.concat([
      encodeFrame(Tag.RestoreBegin),
      output("replayed"),
      encodeFrame(Tag.Ready),
      output("live"),
      encodeFrame(Tag.Exit, encodeExit({ code: 7, signal: 0, reason: ExitReason.natural })),
    ]),
  )
  await settle()
  expect(events).toEqual(["restore-begin", "out:replayed", "ready", "out:live", "exit:7/0/0"])
  expect(connection.exit).toEqual({ code: 7, signal: 0, reason: ExitReason.natural })
  connection.close()
})

test("an exit already reported reaches a listener that subscribes after it", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  // Something must be listening, or the frame is backlogged rather than dispatched.
  connection.onOutput(() => {})
  stub.push(encodeFrame(Tag.Exit, encodeExit({ code: 0, signal: 9, reason: ExitReason.requested })))
  await settle()
  const late: string[] = []
  connection.onExit((status) => late.push(`${status.signal}/${status.reason}`))
  expect(late).toEqual([`9/${ExitReason.requested}`])
  connection.close()
})

test("flushed rejects when the connection dies with bytes still queued", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  // More than the socket takes at once, so the queue is non-empty when it dies.
  connection.write(new Uint8Array(16 * 1024 * 1024))
  const settled = connection.flushed().then(
    () => "resolved",
    (error) => (error instanceof ProtocolError ? "rejected" : `other: ${error}`),
  )
  stub.stop()
  expect(await settled).toBe("rejected")
})

test("an oversized frame from the daemon fails the connection", async () => {
  const stub = await startStub(() => accept)
  const connection = await CompanionConnection.connect(stub.path)
  const reason = new Promise<string>((resolve) =>
    connection.onClose((r) => resolve(r.kind === "error" ? r.error.message : r.kind)),
  )
  // A valid frame followed by a header announcing far too much: the reader
  // must fail on this packet, not wait for one that may never come.
  const bad = new Uint8Array(HEADER_LEN)
  bad[0] = Tag.Output
  new DataView(bad.buffer).setUint32(1, 0xffffffff, true)
  stub.push(Buffer.concat([output("fine"), bad]))
  expect(await reason).toMatch(/announced a 4294967295-byte payload/)
})
