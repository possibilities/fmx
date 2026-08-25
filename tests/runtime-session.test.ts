import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  currentRuntimeCommand,
  ensureRuntimeSession,
  runtimeSessionIdentity,
  waitForRuntimeBootstrap,
} from "../src/runtime-session.ts"
import type { CompanionCommand, CreateRequest, SessionEntry } from "../src/zmx-command.ts"

const HOME = "0123456789ab"

test("Runtime identity is stable per Home and creation requests final-Client ownership", async () => {
  const identity = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-test")
  expect(identity).toEqual({
    name: `fmxr-${HOME}`,
    labels: { owner: "fmx", home: HOME, kind: "runtime" },
    bootstrapPath: `/tmp/fmx-runtime-test/.fmxr-${HOME}.bootstrap`,
  })

  let created: CreateRequest | null = null
  const companion = {
    directory: "/tmp/fmx-runtime-test",
    settle: async () => session(identity.name, "absent", {}),
    create: async (request: CreateRequest) => {
      created = request
      return { name: request.name, socketPath: `/tmp/${request.name}`, pid: 4, createdAt: 5 }
    },
  } as unknown as CompanionCommand

  expect(
    await ensureRuntimeSession(companion, {
      homeId: HOME,
      cwd: "/work",
      command: ["fmx"],
      env: { PATH: "/bin" },
    }),
  ).toEqual({ socketPath: `/tmp/fmxr-${HOME}`, bootstrapPath: identity.bootstrapPath })
  expect(created).toMatchObject({
    name: identity.name,
    cwd: "/work",
    command: ["fmx"],
    labels: identity.labels,
    exitOnLastClient: true,
    env: {
      PATH: "/bin",
      FMX_RUNTIME_PROCESS: "1",
      FMX_RUNTIME_BOOTSTRAP_PATH: identity.bootstrapPath,
    },
  })
})

test("a live owned Runtime is joined and a label impostor is refused", async () => {
  const identity = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-test")
  const makeCompanion = (labels: Record<string, string>) =>
    ({
      directory: "/tmp/fmx-runtime-test",
      settle: async () => session(identity.name, "live", labels),
    }) as unknown as CompanionCommand
  const request = { homeId: HOME, cwd: "/work", command: ["fmx"], env: {} }

  expect(await ensureRuntimeSession(makeCompanion(identity.labels), request)).toEqual({
    socketPath: `/tmp/${identity.name}`,
    bootstrapPath: identity.bootstrapPath,
  })
  await expect(ensureRuntimeSession(makeCompanion({ ...identity.labels, home: "stranger" }), request)).rejects.toThrow(
    "does not belong",
  )
})

test("Runtime bootstrap waits for a first Client marker and consumes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-runtime-bootstrap-"))
  const marker = join(directory, "ready")
  try {
    setTimeout(() => void writeFile(marker, ""), 20)
    // The safety probe cannot fire within this deadline: success comes from
    // the directory notification (or the post-watch race check) alone.
    await waitForRuntimeBootstrap(marker, 1_000, 10_000)
    await expect(Bun.file(marker).exists()).resolves.toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the Runtime command distinguishes a source checkout from a compiled binary", () => {
  expect(currentRuntimeCommand("/bin/bun", "/work/src/index.ts")).toEqual(["/bin/bun", "/work/src/index.ts"])
  expect(currentRuntimeCommand("/bin/fmx", "/$bunfs/root/index.js")).toEqual(["/bin/fmx"])
})

function session(name: string, state: SessionEntry["state"], labels: Record<string, string>): SessionEntry {
  return {
    name,
    state,
    socketPath: state === "absent" ? null : `/tmp/${name}`,
    pid: null,
    clients: null,
    createdAt: null,
    command: null,
    cwd: null,
    labels,
    exit: null,
    detail: null,
  }
}
