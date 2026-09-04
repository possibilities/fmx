import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  currentRuntimeCommand,
  ensureRuntimeSession,
  findRuntimeSession,
  waitForRuntimeApi,
} from "../src/runtime-session.ts"
import { runtimeLabels, runtimeSessionName } from "../src/session-identity.ts"
import { CompanionCreateError, type CompanionCommand, type CreateRequest, type SessionEntry } from "../src/zmx-command.ts"

const INSTANCE = "0123456789ab"
const NAME = runtimeSessionName(INSTANCE)
const LABELS = runtimeLabels(INSTANCE)

const session = (name: string, state: SessionEntry["state"], labels: Record<string, string>): SessionEntry => ({
  name,
  state,
  socketPath: `/tmp/${name}`,
  pid: 3,
  clients: 0,
  createdAt: 4,
  command: ["smolmux"],
  cwd: "/work",
  labels,
  exit: null,
  detail: null,
})

test("the Runtime is one deterministic Companion session per Instance, and it is headless", async () => {
  expect(NAME).toBe(`smolmuxr-${INSTANCE}`)
  expect(LABELS).toEqual({ owner: "smolmux", instance: INSTANCE, kind: "runtime" })

  let created: CreateRequest | null = null
  const companion = {
    directory: "/tmp/smolmux-runtime-test",
    settle: async () => session(NAME, "absent", {}),
    create: async (request: CreateRequest) => {
      created = request
      return { name: request.name, socketPath: `/tmp/${request.name}`, pid: 4, createdAt: 5 }
    },
  } as unknown as CompanionCommand

  expect(
    await ensureRuntimeSession(companion, {
      instanceId: INSTANCE,
      cwd: "/work",
      command: ["smolmux", "runtime"],
      env: { PATH: "/bin" },
    }),
  ).toEqual({ socketPath: `/tmp/${NAME}`, created: true })
  expect(created).toMatchObject({
    name: NAME,
    cwd: "/work",
    command: ["smolmux", "runtime"],
    labels: LABELS,
    env: { PATH: "/bin", SMOLMUX_RUNTIME_PROCESS: "1" },
  })
  // The Runtime holds its Sessions whether or not a terminal is attached.
  expect(created!).not.toHaveProperty("exitOnLastClient", true)
})

test("a live owned Runtime is joined and a label impostor is refused", async () => {
  const makeCompanion = (labels: Record<string, string>) =>
    ({ directory: "/tmp/x", settle: async () => session(NAME, "live", labels) }) as unknown as CompanionCommand
  const request = { instanceId: INSTANCE, cwd: "/work", command: ["smolmux"], env: {} }

  expect(await ensureRuntimeSession(makeCompanion(LABELS), request)).toEqual({
    socketPath: `/tmp/${NAME}`,
    created: false,
  })
  await expect(
    ensureRuntimeSession(makeCompanion({ ...LABELS, instance: "stranger" }), request),
  ).rejects.toThrow("does not belong")
})

test("an exited Runtime's record is consumed before a new one is created", async () => {
  const forgotten: string[] = []
  let states: SessionEntry["state"][] = ["exited", "absent"]
  const companion = {
    directory: "/tmp/x",
    settle: async () => session(NAME, states.shift() ?? "absent", LABELS),
    forget: async (name: string) => {
      forgotten.push(name)
    },
    create: async (request: CreateRequest) => ({
      name: request.name,
      socketPath: `/tmp/${request.name}`,
      pid: 4,
      createdAt: 5,
    }),
  } as unknown as CompanionCommand

  expect(
    await ensureRuntimeSession(companion, { instanceId: INSTANCE, cwd: "/work", command: ["smolmux"], env: {} }),
  ).toMatchObject({ created: true })
  expect(forgotten).toEqual([NAME])
  states = []
})

test("a racing creator's Runtime is joined rather than fought over", async () => {
  let live = false
  const companion = {
    directory: "/tmp/x",
    settle: async () => session(NAME, live ? "live" : "absent", LABELS),
    create: async () => {
      live = true
      throw new CompanionCreateError("AlreadyExists", "already exists", null)
    },
  } as unknown as CompanionCommand

  expect(
    await ensureRuntimeSession(companion, { instanceId: INSTANCE, cwd: "/work", command: ["smolmux"], env: {} }),
  ).toEqual({ socketPath: `/tmp/${NAME}`, created: false })
})

test("a Runtime that is not live is not one a Client can attach to", async () => {
  const companion = {
    directory: "/tmp/x",
    inspect: async () => session(NAME, "exited", LABELS),
  } as unknown as CompanionCommand
  expect(await findRuntimeSession(companion, INSTANCE)).toBeNull()

  const liveCompanion = {
    directory: "/tmp/x",
    inspect: async () => session(NAME, "live", LABELS),
  } as unknown as CompanionCommand
  expect((await findRuntimeSession(liveCompanion, INSTANCE))?.socketPath).toBe(`/tmp/${NAME}`)
})

test("waiting for the API socket answers only when something listens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smolmux-ready-"))
  try {
    const path = join(directory, "instance.api")
    expect(await waitForRuntimeApi(path, 60, 10)).toBe(false)

    const server = Bun.listen({ unix: path, socket: { data: () => {} } })
    try {
      expect(await waitForRuntimeApi(path, 1_000, 10)).toBe(true)
    } finally {
      server.stop(true)
    }

    // A file that is not a listener is not an answer.
    await writeFile(join(directory, "not-a-socket"), "")
    expect(await waitForRuntimeApi(join(directory, "not-a-socket"), 60, 10)).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the Runtime command distinguishes a source checkout from a compiled binary", () => {
  expect(currentRuntimeCommand({ executable: "/usr/bin/bun", main: "/src/index.ts" })).toEqual([
    "/usr/bin/bun",
    "/src/index.ts",
    "runtime",
  ])
  expect(currentRuntimeCommand({ executable: "/usr/local/bin/smolmux", main: "/$bunfs/root/smolmux" })).toEqual([
    "/usr/local/bin/smolmux",
    "runtime",
  ])
  expect(currentRuntimeCommand({ executable: "/usr/bin/bun", main: "/src/index.ts", name: "review" })).toEqual([
    "/usr/bin/bun",
    "/src/index.ts",
    "runtime",
    "--name",
    "review",
  ])
  // The default Instance's argv carries no name.
  expect(currentRuntimeCommand({ executable: "/usr/bin/bun", main: "/src/index.ts", name: "default" })).toEqual([
    "/usr/bin/bun",
    "/src/index.ts",
    "runtime",
  ])
})
