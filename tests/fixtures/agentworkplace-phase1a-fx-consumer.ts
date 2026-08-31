#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import {
  FxWorkControlClient,
  type FxWorkControlBinding,
  type FxWorkControlResult,
} from "../../src/fx-work-control.ts"

export const PHASE1A_CONSUMER_EXECUTION_SCHEMA_ID = "fmx.phase1a-consumer-execution"
export const PHASE1A_CONSUMER_EXECUTION_SCHEMA_VERSION = 1
export const PHASE1A_CONSUMER_EXECUTION_PATH = "phase1a-consumer-execution.json"
export const PHASE1A_CONSUMER_STDOUT_PATH = "phase1a-consumer.stdout.log"
export const PHASE1A_CONSUMER_STDERR_PATH = "phase1a-consumer.stderr.log"
export const PHASE1A_CONSUMER_EVIDENCE_PATHS = [
  PHASE1A_CONSUMER_EXECUTION_PATH,
  PHASE1A_CONSUMER_STDERR_PATH,
  PHASE1A_CONSUMER_STDOUT_PATH,
] as const

export const PHASE1A_FX_COMMIT = "b2f8a38caf52c13ab1eb2e21637481d2eb0e95f8"
export const PHASE1A_FX_TREE = "14e74a7bf610f966234dc3d39fe14f30824d71ef"
export const PHASE1A_FX_SHA256 =
  "f134f708cd5aeea29b18a43d5a2617f78911abd91584056d57a2a6fc1d629772"
export const PHASE1A_FX_BYTES = 11_065_088
export const PHASE1A_FX_VERSION = "0.0.7"
export const PHASE1A_FXNK_VERSION = "0.5.0"
export const PHASE1A_OWNER_GATE_RECEIPT_SHA256 =
  "e655718d7c9d00b9405fc5ef884373d822eae7dbd6025c7fdd7849c9a1bdb38d"
export const PHASE1A_OWNER_GATE_CONTRACT_DIGEST =
  "d12d1bc46217131fa0d0a382a72b81828559383a9d8039d1099c09af0e2336a2"
export const PHASE1A_OWNER_MANIFEST_SHA256 =
  "e02dca149a4b1875eb9dedc1f07fc21cb91d106d0844eacb1806960531e6e17f"
export const PHASE1A_LAUNCH_FIXTURE_SHA256 =
  "b807e31bf8f4de4179b91cca4c9f3a9a40d572f98d8e5467242fc70908eb8161"
export const PHASE1A_STRUCTURED_REQUEST_DIGEST =
  "4b30a49b59bcbd52831b8f28c0739b1f333fbf81686ec7b026728943e467278c"

export const PHASE1A_CONSUMER_SCENARIO_IDS = [
  "native_session_naming_exact_resume",
  "durable_initial_work_control_admission",
  "structured_subscription_inference",
] as const

export const PHASE1A_OWNER_CANARIES = [
  "core.control.launch_admission_final_ledger.test.launch ledger pre-rename failures leave every durable boundary retryable",
  "core.control.launch_admission_final_ledger.test.launch ledger post-rename indeterminate failures recover every durable boundary",
  "core.control.launch_admission_final_ledger.test.launch ledger admission wins before cancellation and replays the original Turn",
  "core.control.launch_admission_final_runtime.test.launch child runtime durably decides the first Work-control prompt and replays its Turn",
  "core.agent.worker_runtime.test.durable initial Work-control admission reserves capacity before decision and publishes exact Turn",
  "core.agent.worker_runtime.test.durable initial Work-control cancellation is permanent and exact admitted retries never enqueue twice",
  "core.agent.worker_runtime.test.durable initial Work-control recovery reuses an already-present Turn",
  "gateway.responses_protocol.test.Responses reducer classifies refusal content as content filter",
  "core.inference.structured_subscription.test.structured subscription inference bounds provider identifiers and terminal persistence",
] as const

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..")
const AUTHORITY_COMMIT = "8bad6eec880586747bc67eab496ce76c92742c14"
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const STRUCTURED_SCHEMA_ID = "fx.structured-subscription-inference"
const LAUNCH_SCHEMA_ID = "fx.launch-admission-final"
const STRUCTURED_REQUEST = {
  schema_id: STRUCTURED_SCHEMA_ID,
  version: 1,
  operation: "infer",
  model: "gpt-5.6-sol",
  effort: "high",
  prompt: "Return one object with answer set to subscription-ok.",
  schema: {
    type: "object",
    properties: { answer: { type: "string", const: "subscription-ok" } },
    required: ["answer"],
    additionalProperties: false,
  },
  caller_key: "opaque-caller-key",
  cancelled: false,
} as const
const decoder = new TextDecoder("utf-8", { fatal: true })

type JsonPrimitive = boolean | null | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type Phase1aFxIdentity = {
  readonly bytes: number
  readonly commit: string
  readonly fxnk: string
  readonly mode: "0755"
  readonly path?: string
  readonly sha256: string
  readonly tree: string
  readonly version: string
}

export const PHASE1A_EXPECTED_FX_IDENTITY: Phase1aFxIdentity = {
  bytes: PHASE1A_FX_BYTES,
  commit: PHASE1A_FX_COMMIT,
  fxnk: PHASE1A_FXNK_VERSION,
  mode: "0755",
  sha256: `sha256:${PHASE1A_FX_SHA256}`,
  tree: PHASE1A_FX_TREE,
  version: PHASE1A_FX_VERSION,
}

type EvidenceFile = {
  readonly bytes: number
  readonly digest: string
  readonly mode: "0600"
  readonly path: string
}

export type Phase1aConsumerEvidence = {
  readonly directory: string
  readonly receipt: Record<string, JsonValue>
  readonly stderr: EvidenceFile
  readonly stdout: EvidenceFile
}

type ScenarioEvent = {
  readonly event: "scenario.passed"
  readonly facts: Record<string, JsonValue>
  readonly scenario_id: (typeof PHASE1A_CONSUMER_SCENARIO_IDS)[number]
}

const usage = `Usage: bun tests/fixtures/agentworkplace-phase1a-fx-consumer.ts \\
  --fx <absolute-fmx-fx> \\
  --evidence <existing-empty-private-directory> \\
  --contracts <exact-agentworkplace-v1-directory> \\
  --owner-gate-receipt <exact-fx-local-gate-receipt>

Executes only the three AgentWorkplace Phase 1A consumer scenarios against
the exact installed Fx Integration binary and writes one strict
fmx.phase1a-consumer-execution v1 receipt plus its secret-free stdout and
empty stderr evidence logs. This fixture adds no production launch transport.
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key] as JsonValue)]),
  )
}

export function canonicalPhase1aConsumerJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`
}

function canonicalEvent(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value))}\n`
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0
}

function fileEvidence(path: string, bytes: Uint8Array): EvidenceFile {
  return { bytes: bytes.byteLength, digest: `sha256:${sha256(bytes)}`, mode: "0600", path }
}

type StableFile = {
  readonly bytes: Uint8Array
  readonly facts: { readonly device: number; readonly inode: number; readonly mode: number; readonly size: number }
}

type VerifiedFxFile = StableFile & { readonly path: string }

async function readStableRegularFile(
  path: string,
  expectedMode: number | readonly number[],
): Promise<StableFile> {
  const acceptedModes: readonly number[] = typeof expectedMode === "number" ? [expectedMode] : expectedMode
  const before = await lstat(path)
  if (
    before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 ||
    !acceptedModes.includes(before.mode & 0o777)
  ) {
    throw new Error(
      `${path} must be one regular file with one link and mode ${acceptedModes.map((mode) => `0${mode.toString(8)}`).join(" or ")}`,
    )
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size || opened.mode !== before.mode
    ) {
      throw new Error(`${path} changed while it was opened`)
    }
    const bytes = new Uint8Array(await handle.readFile())
    const after = await lstat(path)
    if (
      after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 ||
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mode !== opened.mode || bytes.byteLength !== opened.size
    ) {
      throw new Error(`${path} changed while it was read`)
    }
    return {
      bytes,
      facts: {
        device: opened.dev,
        inode: opened.ino,
        mode: opened.mode & 0o777,
        size: opened.size,
      },
    }
  } finally {
    await handle.close()
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], description: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${description} keys changed: ${JSON.stringify(actual)}`)
  }
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${description} must be an object`)
  return value
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${description} must be a string`)
  return value
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${description} changed`)
  }
}

function childEnvironment(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "PATH", "SHELL", "TERM", "TMPDIR", "TZ"]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

async function runCommand(
  command: readonly string[],
  options: {
    readonly cwd?: string
    readonly env?: Record<string, string | undefined>
    readonly stdin?: string
    readonly timeoutMs?: number
  } = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: childEnvironment(options.env ?? {}),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (options.stdin !== undefined) {
    const stdin = child.stdin
    if (stdin === undefined) throw new Error("fixture command has no piped stdin")
    stdin.write(options.stdin)
    stdin.end()
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill("SIGKILL")
    } catch {
      // It exited while the timeout callback was queued.
    }
  }, options.timeoutMs ?? 20_000)
  try {
    const [code, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    if (timedOut) throw new Error(`${command[0]} timed out`)
    return { code, stderr, stdout }
  } finally {
    clearTimeout(timer)
  }
}

class FixturePty {
  private output = ""
  private readonly child: ReturnType<typeof Bun.spawn>
  private closed = false

  constructor(command: readonly string[], cwd: string, env: Record<string, string | undefined>) {
    const streamDecoder = new TextDecoder()
    this.child = Bun.spawn([...command], {
      cwd,
      env: childEnvironment(env),
      terminal: {
        cols: 100,
        rows: 30,
        data: (_terminal, data) => {
          this.output += streamDecoder.decode(data, { stream: true })
          if (this.output.length > 2 * 1024 * 1024) this.output = this.output.slice(-1024 * 1024)
        },
      },
    })
  }

  async waitFor(text: string, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.output.includes(text)) return this.output
      const outcome = await Promise.race([
        this.child.exited.then((code) => ({ code })),
        Bun.sleep(50).then(() => null),
      ])
      if (outcome !== null) {
        throw new Error(
          `Fx exited ${outcome.code} before displaying ${text}; PTY tail: ${JSON.stringify(this.output.slice(-1000))}`,
        )
      }
    }
    throw new Error(`Fx did not display ${text} within ${timeoutMs}ms; PTY tail: ${JSON.stringify(this.output.slice(-1000))}`)
  }

  sendLine(text: string): void {
    if (this.closed) throw new Error("cannot write to a closed Fx PTY")
    this.child.terminal?.write(`${text}\r`)
  }

  async gracefulExit(): Promise<number> {
    this.sendLine("/quit")
    return this.waitForExit(10_000)
  }

  async result(timeoutMs = 10_000): Promise<{ code: number; output: string }> {
    return { code: await this.waitForExit(timeoutMs), output: this.output }
  }

  async stop(): Promise<void> {
    if (this.closed) return
    try {
      this.child.kill("SIGTERM")
    } catch {
      // It already exited.
    }
    try {
      await this.waitForExit(3_000)
    } catch {
      try {
        this.child.kill("SIGKILL")
      } catch {
        // It exited between the waits.
      }
      await this.child.exited
    }
  }

  private async waitForExit(timeoutMs: number): Promise<number> {
    const outcome = await Promise.race([
      this.child.exited.then((code) => ({ code })),
      Bun.sleep(timeoutMs).then(() => null),
    ])
    if (outcome === null) throw new Error(`Fx did not exit within ${timeoutMs}ms`)
    this.closed = true
    try {
      this.child.terminal?.close()
    } catch {
      // The PTY closes with the process on some Bun versions.
    }
    return outcome.code
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${description}`)
}

function gatewaySse(text: string): Response {
  const events = [
    { type: "text-delta", id: "answer_1", delta: text },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 3 }, outputTokens: { total: 5 } },
    },
  ]
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function gatewayToolCall(): Response {
  const events = [
    {
      type: "tool-call",
      toolCallId: "fixture-permission-decision",
      toolName: "permission_decision",
      input: { risk: "low", decision: "clear", rationale: "Phase 1A fixture" },
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
  ]
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function sessionIds(stateRoot: string): Promise<string[]> {
  const directory = join(stateRoot, ".fx", "sessions")
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name !== "latest" && entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function runNamingScenario(fxPath: string, root: string): Promise<ScenarioEvent> {
  const ambientHome = join(root, "naming-ambient-home")
  const selectedStateRoot = join(root, "naming-selected-state")
  const isolatedStateRoot = join(root, "naming-isolated-state")
  const initialWorkspace = join(root, "naming-initial-workspace")
  const reboundWorkspace = join(root, "naming-rebound-workspace")
  for (const path of [ambientHome, selectedStateRoot, isolatedStateRoot, initialWorkspace, reboundWorkspace]) {
    await mkdir(path, { mode: DIRECTORY_MODE })
  }
  await mkdir(join(selectedStateRoot, ".fx"), { mode: DIRECTORY_MODE })
  await mkdir(join(isolatedStateRoot, ".fx"), { mode: DIRECTORY_MODE })
  await writeFile(join(selectedStateRoot, ".fx", "settings.json"), JSON.stringify({
    sandbox: "none",
    permission_mode: "auto",
    permission: {},
    session_naming: {
      gateway: { model: "openai/gpt-5", effort: "low" },
      timeout_ms: 10_000,
    },
  }), { mode: FILE_MODE })

  let namingRequests = 0
  const completionBodies: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/coding-agent/v1/models") {
        return Response.json({ data: [{ id: "openai/gpt-5", type: "language", tags: ["tool-use"] }] })
      }
      if (request.method !== "POST") return new Response("not found", { status: 404 })
      const body = await request.text()
      if (body.includes("\"permission_decision\"")) return gatewayToolCall()
      completionBodies.push(body)
      if (body.includes("Generate a short session title")) {
        namingRequests += 1
        return gatewaySse("Automatic new conversation title")
      }
      if (body.includes("PHASE1A_NAMING_RESUME")) return gatewaySse("PHASE1A_NAMING_RESUME_DONE")
      if (body.includes("PHASE1A_NAMING_NEW")) return gatewaySse("PHASE1A_NAMING_NEW_DONE")
      if (body.includes("PHASE1A_NAMING_INITIAL")) return gatewaySse("PHASE1A_NAMING_INITIAL_DONE")
      return new Response("unexpected fixture request", { status: 500 })
    },
  })
  const env = {
    HOME: ambientHome,
    AI_GATEWAY_API_KEY: "phase1a-fake-gateway-key",
    VERCEL_OIDC_TOKEN: undefined,
    FX_GATEWAY_BASE_URL: `http://127.0.0.1:${server.port}`,
    FX_GATEWAY_CHAT_URL: `http://127.0.0.1:${server.port}/v3/ai/language-model`,
    FX_MODEL: "openai/gpt-5",
    FX_AUTO_UPGRADE: "0",
    FX_DISABLE_KEYCHAIN: "1",
    FX_E2E_DISABLE_DOTENV: "1",
    NO_COLOR: "1",
  } as const
  let pty: FixturePty | null = null
  try {
    pty = new FixturePty(
      [fxPath, "--state-dir", selectedStateRoot, "--name", "Initial launch title"],
      initialWorkspace,
      env,
    )
    await pty.waitFor("Run /help for commands")
    await waitFor(async () => (await sessionIds(selectedStateRoot)).length === 1, "initial Conversation")
    const originalId = (await sessionIds(selectedStateRoot))[0]!
    pty.sendLine("PHASE1A_NAMING_INITIAL")
    await pty.waitFor("PHASE1A_NAMING_INITIAL_DONE")
    const originalDisplay = join(selectedStateRoot, ".fx", "sessions", originalId, "display.json")
    await waitFor(async () => {
      try {
        return JSON.parse(await readFile(originalDisplay, "utf8")).title === "Initial launch title"
      } catch {
        return false
      }
    }, "explicit initial title")

    pty.sendLine("/new")
    await waitFor(async () => (await sessionIds(selectedStateRoot)).length === 2, "fresh /new Conversation")
    const newId = (await sessionIds(selectedStateRoot)).find((id) => id !== originalId)!
    pty.sendLine("PHASE1A_NAMING_NEW")
    await pty.waitFor("PHASE1A_NAMING_NEW_DONE")
    const newDisplay = join(selectedStateRoot, ".fx", "sessions", newId, "display.json")
    await waitFor(async () => {
      try {
        return JSON.parse(await readFile(newDisplay, "utf8")).title === "automatic-new-conversation-title"
      } catch {
        return false
      }
    }, "automatic title for /new Conversation")
    if (namingRequests !== 1) throw new Error(`expected one naming request, received ${namingRequests}`)
    if (await pty.gracefulExit() !== 0) throw new Error("initial naming Fx did not exit cleanly")
    pty = null

    pty = new FixturePty(
      [fxPath, "--state-dir", selectedStateRoot, "--name", "Resumed launch title", "resume", originalId],
      reboundWorkspace,
      env,
    )
    const resumedScreen = await pty.waitFor("PHASE1A_NAMING_INITIAL_DONE")
    if (resumedScreen.includes("PHASE1A_NAMING_NEW_DONE")) {
      throw new Error("exact resume imported the /new Conversation")
    }
    pty.sendLine("PHASE1A_NAMING_RESUME")
    await pty.waitFor("PHASE1A_NAMING_RESUME_DONE")
    if (namingRequests !== 1) throw new Error("exact resume started another naming request")
    const sessionState = JSON.parse(
      await readFile(join(selectedStateRoot, ".fx", "sessions", originalId, "session.json"), "utf8"),
    ) as Record<string, unknown>
    if (sessionState.workspace_root !== await realpath(reboundWorkspace)) {
      throw new Error("exact resume did not rebind the workspace")
    }
    if (JSON.parse(await readFile(originalDisplay, "utf8")).title !== "Resumed launch title") {
      throw new Error("exact resume did not reapply the launch name")
    }
    if (await pty.gracefulExit() !== 0) throw new Error("resumed naming Fx did not exit cleanly")
    pty = null

    pty = new FixturePty(
      [fxPath, "--state-dir", isolatedStateRoot, "--name", "Wrong state root", "resume", originalId],
      reboundWorkspace,
      env,
    )
    const isolated = await pty.result()
    pty = null
    if (isolated.code !== 1 || !isolated.output.includes("fx: saved session not found")) {
      throw new Error(`isolated state root did not reject the foreign Conversation: ${JSON.stringify({
        code: isolated.code,
        output: isolated.output.slice(-512),
      })}`)
    }
    if ((await sessionIds(isolatedStateRoot)).includes(originalId)) {
      throw new Error("isolated state root acquired the foreign Conversation")
    }
    if ((await sessionIds(ambientHome)).includes(originalId)) {
      throw new Error("ambient HOME acquired the selected-root Conversation")
    }

    return {
      event: "scenario.passed",
      scenario_id: "native_session_naming_exact_resume",
      facts: {
        automatic_name_requests: namingRequests,
        completion_requests: completionBodies.length,
        conversation_count: 2,
        exact_resume_isolated: true,
        launch_name_non_leakage: true,
        selected_state_root_separate_from_home: true,
        workspace_rebound: true,
      },
    }
  } finally {
    if (pty) await pty.stop()
    server.stop(true)
  }
}

function canonicalLaunchDigest(input: {
  admissionKey: string
  conversationName: string
  directory: string
  initialWorkDigest: string
  launchId: string
  remainingControlsDigest: string
  stateRoot: string
}): string {
  return sha256(JSON.stringify({
    admission_key: input.admissionKey,
    conversation_name: input.conversationName,
    directory: input.directory,
    initial_work_digest: input.initialWorkDigest,
    launch_id: input.launchId,
    remaining_launch_controls_digest: input.remainingControlsDigest,
    resume: { mode: "fresh" },
    state_root: input.stateRoot,
  }))
}

async function seedLaunchLedger(input: {
  admissionKey: string
  conversationId: string
  directory: string
  initialPrompt: string
  launchId: string
  stateRoot: string
}): Promise<{ launchDigest: string; recordPath: string }> {
  const initialWorkDigest = sha256(input.initialPrompt)
  const remainingControlsDigest = "a".repeat(64)
  const launchDigest = canonicalLaunchDigest({
    admissionKey: input.admissionKey,
    conversationName: "Phase 1A admission fixture",
    directory: input.directory,
    initialWorkDigest,
    launchId: input.launchId,
    remainingControlsDigest,
    stateRoot: input.stateRoot,
  })
  const records = join(input.stateRoot, ".fx", "launch-admission-final", "records")
  await mkdir(records, { recursive: true, mode: DIRECTORY_MODE })
  for (const directory of [join(input.stateRoot, ".fx"), join(input.stateRoot, ".fx", "launch-admission-final"), records]) {
    await chmod(directory, DIRECTORY_MODE)
  }
  const record = {
    active_conversation_id: input.conversationId,
    admission_key: input.admissionKey,
    conversation_name: "Phase 1A admission fixture",
    directory: input.directory,
    initial_conversation_id: input.conversationId,
    initial_work_digest: initialWorkDigest,
    launch_digest: launchDigest,
    launch_id: input.launchId,
    launch_receipt_id: `launch-receipt-${launchDigest.slice(0, 24)}`,
    remaining_launch_controls_digest: remainingControlsDigest,
    request_id: "phase1a-launch-request",
    resume: { mode: "fresh" },
    schema_id: "fx.launch-admission-final-ledger",
    schema_version: 1,
    state_root: input.stateRoot,
  }
  const recordPath = join(records, `${sha256(input.admissionKey)}.json`)
  await writeFile(recordPath, JSON.stringify(record), { mode: FILE_MODE })
  await chmod(recordPath, FILE_MODE)
  return { launchDigest, recordPath }
}

async function runAdmissionScenario(fxPath: string, root: string): Promise<ScenarioEvent> {
  const stateRoot = join(root, "admission-state")
  const home = join(root, "admission-home")
  const workspace = join(root, "admission-workspace")
  for (const path of [stateRoot, home, workspace]) await mkdir(path, { mode: DIRECTORY_MODE })
  await mkdir(join(stateRoot, ".fx"), { mode: DIRECTORY_MODE })
  await writeFile(join(stateRoot, ".fx", "settings.json"), JSON.stringify({
    sandbox: "none",
    permission_mode: "auto",
    permission: {},
    session_naming: { gateway: null, codex: null, grok: null },
  }), { mode: FILE_MODE })

  const initialPrompt = "PHASE1A_DURABLE_INITIAL_WORK"
  const admissionKey = "phase1a-admission-attempt"
  const launchId = "phase1a-launch"
  const conversationId = "1788000000000-1788000000000000000-abcd1234"
  const seeded = await seedLaunchLedger({
    admissionKey,
    conversationId,
    directory: await realpath(workspace),
    initialPrompt,
    launchId,
    stateRoot: await realpath(stateRoot),
  })
  let heldCancelled = false
  const responseState: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/coding-agent/v1/models") {
        return Response.json({ data: [{ id: "openai/gpt-5", type: "language", tags: ["tool-use"] }] })
      }
      if (request.method !== "POST") return new Response("not found", { status: 404 })
      await request.text()
      const encoder = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          responseState.controller = controller
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: "text-delta", id: "held", delta: "PHASE1A_ADMISSION_ACTIVE" })}\n\n`,
          ))
        },
        cancel() {
          heldCancelled = true
          responseState.controller = null
        },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  let pty: FixturePty | null = null
  let socketRoot: { device: bigint; inode: bigint; path: string } | null = null
  try {
    const createdSocketRoot = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "fmx-p1a-wc-"))
    await chmod(createdSocketRoot, DIRECTORY_MODE)
    const socketRootFacts = await lstat(createdSocketRoot, { bigint: true })
    socketRoot = { device: socketRootFacts.dev, inode: socketRootFacts.ino, path: createdSocketRoot }
    const binding: FxWorkControlBinding = {
      socketPath: join(createdSocketRoot, "control.sock"),
      instanceId: "phase1a-fmx-agent",
      token: "ab".repeat(32),
    }
    pty = new FixturePty([fxPath, "--state-dir", stateRoot, "--name", "Phase 1A admission fixture"], workspace, {
      HOME: home,
      AI_GATEWAY_API_KEY: "phase1a-fake-admission-key",
      VERCEL_OIDC_TOKEN: undefined,
      FX_GATEWAY_BASE_URL: `http://127.0.0.1:${server.port}`,
      FX_GATEWAY_CHAT_URL: `http://127.0.0.1:${server.port}/v3/ai/language-model`,
      FX_MODEL: "openai/gpt-5",
      FX_AUTO_UPGRADE: "0",
      FX_DISABLE_KEYCHAIN: "1",
      FX_E2E_DISABLE_DOTENV: "1",
      NO_COLOR: "1",
      FX_WORK_CONTROL_SOCKET_PATH: binding.socketPath,
      FX_WORK_CONTROL_INSTANCE_ID: binding.instanceId,
      FX_WORK_CONTROL_TOKEN: binding.token,
      FX_INTERNAL_LAUNCH_STATE_ROOT: stateRoot,
      FX_INTERNAL_LAUNCH_ADMISSION_KEY: admissionKey,
      FX_INTERNAL_LAUNCH_DIGEST: seeded.launchDigest,
      FX_INTERNAL_LAUNCH_ID: launchId,
      FX_INTERNAL_LAUNCH_CONVERSATION_ID: conversationId,
    })
    await pty.waitFor("Run /help for commands")
    await waitFor(async () => {
      try {
        return (await lstat(binding.socketPath)).isSocket()
      } catch {
        return false
      }
    }, "authenticated Work-control socket")

    const client = new FxWorkControlClient()
    const request = () => client.request(binding, "work.queue", { text: initialPrompt }, new AbortController().signal)
    const first = await request()
    const replay = await request()
    const snapshot = await client.request(binding, "work.snapshot", {}, new AbortController().signal)
    assertAdmissionResult(first, replay, snapshot)

    await waitFor(async () => {
      const record = JSON.parse(await readFile(seeded.recordPath, "utf8")) as Record<string, unknown>
      return isRecord(record.decision) && record.decision.kind === "admitted"
    }, "durable admitted ledger decision")
    const record = JSON.parse(await readFile(seeded.recordPath, "utf8")) as Record<string, unknown>
    const decision = requireRecord(record.decision, "durable admission decision")
    if (decision.turn_id !== first.turn_id || decision.disposition !== first.disposition) {
      throw new Error("durable ledger decision did not match Work-control")
    }
    if (record.active_conversation_id !== conversationId || record.initial_conversation_id !== conversationId) {
      throw new Error("durable ledger lost the reserved Conversation")
    }
    if (record.final_receipt !== undefined) {
      throw new Error("consumer fixture invented a parent-owned final receipt")
    }

    const recordStem = join(stateRoot, ".fx", "launch-admission-final", "records", sha256(admissionKey))
    const deliveryMarkers = {
      authority: await exists(`${recordStem}.admission`),
      consumed: await exists(`${recordStem}.admission-consumed`),
      visible: await exists(`${recordStem}.admission-visible`),
    }
    if (!deliveryMarkers.authority || (!deliveryMarkers.visible && !deliveryMarkers.consumed)) {
      throw new Error("durable admission delivery markers did not advance")
    }

    return {
      event: "scenario.passed",
      scenario_id: "durable_initial_work_control_admission",
      facts: {
        active_turn_id: snapshot.snapshot.active_turn_id,
        admission_key_persisted: true,
        decision_disposition: first.disposition!,
        delivery_markers: deliveryMarkers,
        duplicate_queue_entries: 0,
        exact_replay: true,
        final_receipt_claim: "frozen_fixture_and_owner_gate_only",
        queue_length: snapshot.snapshot.queue.length,
        turn_id: first.turn_id!,
        work_control_schema: 1,
      },
    }
  } finally {
    if (pty) await pty.stop()
    try {
      responseState.controller?.close()
    } catch {
      // Fx may have already cancelled the held response during shutdown.
    }
    server.stop(true)
    if (!heldCancelled) await Bun.sleep(10)
    if (socketRoot) {
      await removeExactTemporaryRoot(socketRoot.path, socketRoot.device, socketRoot.inode)
    }
  }
}

function assertAdmissionResult(
  first: FxWorkControlResult,
  replay: FxWorkControlResult,
  snapshot: FxWorkControlResult,
): void {
  if (first.turn_id === undefined || first.disposition === undefined) {
    throw new Error("first Work-control request returned no admission")
  }
  if (replay.turn_id !== first.turn_id || replay.disposition !== first.disposition) {
    throw new Error("lost-response retry returned another admission")
  }
  const allWork = [
    ...(snapshot.snapshot.active_turn_id === null ? [] : [snapshot.snapshot.active_turn_id]),
    ...snapshot.snapshot.queue.map(({ turn_id }) => turn_id),
  ]
  if (allWork.filter((turnId) => turnId === first.turn_id).length !== 1) {
    throw new Error("admitted Turn did not appear exactly once")
  }
  if (snapshot.snapshot.queue.some(({ turn_id }) => turn_id !== first.turn_id)) {
    throw new Error("fixture observed unrelated queued work")
  }
}

function accessToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url")
  return `header.${payload}.fixture-signature`
}

function structuredSse(content: string): string {
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: content })}\n\n` +
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_phase1a_consumer",
        status: "completed",
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    })}\n\n`
}

async function runStructuredScenario(fxPath: string, root: string): Promise<ScenarioEvent> {
  const home = join(root, "structured-home")
  const workspace = join(root, "structured-workspace")
  const stateRoot = join(root, "structured-receipts")
  await mkdir(join(home, ".fx"), { recursive: true, mode: DIRECTORY_MODE })
  await mkdir(workspace, { mode: DIRECTORY_MODE })
  const token = accessToken("acct_phase1a_consumer")
  await writeFile(join(home, ".fx", "chatgpt-auth.json"), `${JSON.stringify({
    version: 1,
    access_token: token,
    refresh_token: "fixture-refresh-token",
    expires_at_ms: Date.now() + 60 * 60 * 1000,
    account_id: "acct_phase1a_consumer",
  })}\n`, { mode: FILE_MODE })

  const requests: Array<{
    account: string | null
    authorization: string | null
    body: string
    method: string
    path: string
    session: string | null
  }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.text() : ""
      requests.push({
        account: request.headers.get("chatgpt-account-id"),
        authorization: request.headers.get("authorization"),
        body,
        method: request.method,
        path: url.pathname,
        session: request.headers.get("session-id"),
      })
      if (url.pathname === "/models") {
        return Response.json({ models: [
          {
            slug: "gpt-5.6-sol",
            visibility: "list",
            supported_in_api: true,
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
            additional_speed_tiers: [],
            input_modalities: ["text"],
            context_window: 272000,
          },
          {
            slug: "gpt-5.4-mini",
            visibility: "list",
            supported_in_api: true,
            supported_reasoning_levels: [{ effort: "low" }],
            additional_speed_tiers: [],
            input_modalities: ["text"],
            context_window: 128000,
          },
        ] })
      }
      if (url.pathname !== "/responses") return new Response("not found", { status: 404 })
      return new Response(structuredSse('{"answer":"subscription-ok"}'), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const environment = {
    HOME: home,
    FX_AUTO_UPGRADE: "0",
    FX_DISABLE_KEYCHAIN: "1",
    FX_E2E_DISABLE_DOTENV: "1",
    FX_E2E_OPENAI_CODEX_MODELS_URL: `http://127.0.0.1:${server.port}/models`,
    FX_E2E_OPENAI_CODEX_RESPONSES_URL: `http://127.0.0.1:${server.port}/responses`,
    AI_GATEWAY_API_KEY: undefined,
    VERCEL_OIDC_TOKEN: undefined,
  }
  const invoke = (frame: Record<string, unknown>) => runCommand(
    [fxPath, "structured-inference", "--state-root", stateRoot],
    { cwd: workspace, env: environment, stdin: `${JSON.stringify(frame)}\n`, timeoutMs: 20_000 },
  )
  try {
    const first = await invoke(STRUCTURED_REQUEST)
    if (first.code !== 0 || first.stderr !== "") throw new Error("structured inference failed")
    const terminal = requireRecord(JSON.parse(first.stdout), "structured terminal")
    if (
      terminal.schema_id !== STRUCTURED_SCHEMA_ID || terminal.version !== 1 ||
      terminal.status !== "succeeded" || terminal.request_digest !== PHASE1A_STRUCTURED_REQUEST_DIGEST ||
      JSON.stringify(terminal.output) !== JSON.stringify({ answer: "subscription-ok" })
    ) {
      throw new Error(`structured inference returned an unexpected terminal: ${JSON.stringify({
        requests: requests.map(({ method, path }) => `${method} ${path}`),
        terminal,
      }).slice(0, 1200)}`)
    }
    const receipt = requireRecord(terminal.receipt, "structured receipt")
    const receiptId = requireString(receipt.id, "structured receipt id")
    const provenance = requireRecord(terminal.provenance, "structured provenance")
    expectEqual(
      {
        catalog_provider: provenance.catalog_provider,
        credential_source: provenance.credential_source,
        effort: provenance.effort,
        effort_index: provenance.effort_index,
        model: provenance.model,
        provider: provenance.provider,
        provider_response_id: provenance.provider_response_id,
      },
      {
        catalog_provider: "codex",
        credential_source: "chatgpt_subscription",
        effort: "high",
        effort_index: 1,
        model: "gpt-5.6-sol",
        provider: "codex",
        provider_response_id: "resp_phase1a_consumer",
      },
      "structured provenance",
    )
    expectEqual(requests.map(({ method, path }) => `${method} ${path}`), ["GET /models", "POST /responses"], "provider order")
    const providerRequest = requests[1]!
    if (
      providerRequest.authorization !== `Bearer ${token}` ||
      providerRequest.account !== "acct_phase1a_consumer" || providerRequest.session !== null
    ) {
      throw new Error("structured request did not use the exact profile authority without a session")
    }
    const providerBody = JSON.parse(providerRequest.body) as Record<string, unknown>
    if ("tools" in providerBody || providerBody.tool_choice !== "none") {
      throw new Error("structured provider request advertised a tool")
    }

    const requestCount = requests.length
    const replay = await invoke(STRUCTURED_REQUEST)
    if (replay.code !== 0 || replay.stderr !== "" || replay.stdout !== first.stdout || requests.length !== requestCount) {
      throw new Error("structured terminal replay was not byte-identical and provider-free")
    }
    const conflict = await invoke({ ...STRUCTURED_REQUEST, prompt: "conflicting prompt" })
    if (conflict.code !== 2 || requireRecord(JSON.parse(conflict.stdout), "structured conflict").code !== "StructuredInferenceCallerKeyConflict") {
      throw new Error("structured caller-key conflict was not rejected")
    }
    const ack = {
      schema_id: STRUCTURED_SCHEMA_ID,
      version: 1,
      operation: "ack",
      caller_key: STRUCTURED_REQUEST.caller_key,
      receipt_id: receiptId,
    }
    const firstAck = await invoke(ack)
    const secondAck = await invoke(ack)
    if (
      firstAck.code !== 0 || secondAck.code !== 0 || firstAck.stderr !== "" || secondAck.stderr !== "" ||
      firstAck.stdout !== secondAck.stdout || requireRecord(JSON.parse(firstAck.stdout), "structured ack").acknowledged !== true
    ) {
      throw new Error("structured acknowledgement was not idempotent")
    }

    const beforeCancellation = requests.length
    const cancelled = await invoke({ ...STRUCTURED_REQUEST, caller_key: "phase1a-cancelled", cancelled: true })
    if (
      cancelled.code !== 0 || cancelled.stderr !== "" ||
      requireRecord(JSON.parse(cancelled.stdout), "structured cancellation").status !== "cancelled" ||
      requests.length !== beforeCancellation
    ) {
      throw new Error("pre-admission structured cancellation performed provider work")
    }
    if (await exists(join(home, ".fx", "sessions"))) {
      throw new Error("structured inference created an interactive session")
    }
    const stateMode = (await stat(stateRoot)).mode & 0o777
    if (stateMode !== DIRECTORY_MODE) throw new Error("structured receipt root is not private")

    return {
      event: "scenario.passed",
      scenario_id: "structured_subscription_inference",
      facts: {
        acknowledgement_idempotent: true,
        catalog_preceded_provider: true,
        conflict_rejected: true,
        interactive_session_created: false,
        pre_admission_cancellation_provider_requests: 0,
        provider_requests: 1,
        replay_provider_requests: 0,
        request_digest: PHASE1A_STRUCTURED_REQUEST_DIGEST,
        tool_count: 0,
      },
    }
  } finally {
    server.stop(true)
  }
}

async function verifyInstalledFxSource(path: string): Promise<VerifiedFxFile> {
  if (!isAbsolute(path)) throw new Error("--fx must be absolute")
  const physical = await realpath(path)
  if (physical !== path) throw new Error("--fx must already be canonical")
  const source = await readStableRegularFile(path, 0o755)
  expectEqual({
    bytes: source.facts.size,
    mode: "0755",
    sha256: `sha256:${sha256(source.bytes)}`,
  }, {
    bytes: PHASE1A_FX_BYTES,
    mode: PHASE1A_EXPECTED_FX_IDENTITY.mode,
    sha256: PHASE1A_EXPECTED_FX_IDENTITY.sha256,
  }, "installed Fx source bytes")
  return { ...source, path }
}

async function createExecutableFxSnapshot(root: string, source: VerifiedFxFile): Promise<VerifiedFxFile> {
  const path = join(root, "phase1a-fmx-fx-execution-snapshot")
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o755,
  )
  try {
    await handle.writeFile(source.bytes)
    await handle.chmod(0o755)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const snapshot = await readStableRegularFile(path, 0o755)
  if (!bytesEqual(snapshot.bytes, source.bytes)) {
    throw new Error("private Fx execution snapshot differs from the verified installed bytes")
  }
  return { ...snapshot, path }
}

async function identifyFxSnapshot(
  snapshot: VerifiedFxFile,
  sourcePath: string,
): Promise<Phase1aFxIdentity & { path: string }> {
  if (
    snapshot.facts.size !== PHASE1A_FX_BYTES ||
    sha256(snapshot.bytes) !== PHASE1A_FX_SHA256
  ) {
    throw new Error("private Fx execution snapshot identity changed before execution")
  }
  const version = await runCommand([snapshot.path, "--version"], { timeoutMs: 5_000 })
  const fxnk = await runCommand([snapshot.path, "--fxnk-version"], { timeoutMs: 5_000 })
  if (version.code !== 0 || version.stderr !== "" || fxnk.code !== 0 || fxnk.stderr !== "") {
    throw new Error("private Fx execution snapshot identity probes were not clean")
  }
  const actual: Phase1aFxIdentity & { path: string } = {
    bytes: snapshot.facts.size,
    commit: PHASE1A_FX_COMMIT,
    fxnk: fxnk.stdout.trim() === `fxnk ${PHASE1A_FXNK_VERSION} (fx ${PHASE1A_FX_VERSION})`
      ? PHASE1A_FXNK_VERSION
      : fxnk.stdout.trim(),
    mode: "0755",
    path: sourcePath,
    sha256: `sha256:${sha256(snapshot.bytes)}`,
    tree: PHASE1A_FX_TREE,
    version: version.stdout.trim(),
  }
  expectEqual(
    { ...actual, path: undefined },
    { ...PHASE1A_EXPECTED_FX_IDENTITY, path: undefined },
    "private Fx execution snapshot identity",
  )
  return actual
}

async function revalidateFxExecution(
  source: VerifiedFxFile,
  snapshot: VerifiedFxFile,
  expectedIdentity?: Phase1aFxIdentity & { path: string },
): Promise<void> {
  const beforeProbe = await readStableRegularFile(snapshot.path, 0o755)
  expectEqual(beforeProbe.facts, snapshot.facts, "private Fx snapshot path stability before final probes")
  if (!bytesEqual(beforeProbe.bytes, snapshot.bytes) || !bytesEqual(beforeProbe.bytes, source.bytes)) {
    throw new Error("private Fx snapshot bytes changed during scenario execution")
  }
  const finalIdentity = await identifyFxSnapshot({ ...beforeProbe, path: snapshot.path }, source.path)
  if (expectedIdentity !== undefined) {
    expectEqual(finalIdentity, expectedIdentity, "private Fx snapshot final identity")
  }
  const afterProbe = await readStableRegularFile(snapshot.path, 0o755)
  expectEqual(afterProbe.facts, snapshot.facts, "private Fx snapshot path stability after final probes")
  if (!bytesEqual(afterProbe.bytes, snapshot.bytes) || !bytesEqual(afterProbe.bytes, source.bytes)) {
    throw new Error("private Fx snapshot bytes changed during final identity probes")
  }
  await revalidateInstalledFxSource(source)
}

async function revalidateInstalledFxSource(source: VerifiedFxFile): Promise<void> {
  const sourceAfter = await readStableRegularFile(source.path, 0o755)
  expectEqual(sourceAfter.facts, source.facts, "installed Fx source path stability after execution")
  if (!bytesEqual(sourceAfter.bytes, source.bytes)) {
    throw new Error("installed Fx source bytes changed during snapshot execution")
  }
}

async function consumeFrozenContracts(directory: string): Promise<Record<string, JsonValue>> {
  const physical = await realpath(directory)
  const directoryFacts = await lstat(directory)
  if (physical !== directory || directoryFacts.isSymbolicLink() || !directoryFacts.isDirectory()) {
    throw new Error("contracts must name one canonical real directory")
  }
  const contractModes = [0o600, 0o644] as const
  const beforeManifest = await readStableRegularFile(join(directory, "manifest.json"), contractModes)
  const beforeFixture = await readStableRegularFile(
    join(directory, "fx-launch-admission-final.jsonl"),
    contractModes,
  )
  const manifestText = decoder.decode(beforeManifest.bytes)
  const manifest = requireRecord(JSON.parse(manifestText), "AgentWorkplace contract manifest")
  if (manifestText !== canonicalEvent(manifest as JsonValue)) {
    throw new Error("AgentWorkplace contract manifest is not canonical")
  }
  if (sha256(beforeManifest.bytes) !== PHASE1A_OWNER_MANIFEST_SHA256) {
    throw new Error("AgentWorkplace owner manifest digest changed")
  }
  const files = manifest.files
  if (!Array.isArray(files) || files.length !== 4) {
    throw new Error("AgentWorkplace owner manifest inventory changed")
  }
  const fixtureEntry = files
    .map((value) => requireRecord(value, "AgentWorkplace manifest fixture"))
    .find(({ schema_id }) => schema_id === LAUNCH_SCHEMA_ID)
  expectEqual(fixtureEntry, {
    bytes: 4_262,
    messages: 9,
    path: "fx-launch-admission-final.jsonl",
    schema_id: LAUNCH_SCHEMA_ID,
    sha256: PHASE1A_LAUNCH_FIXTURE_SHA256,
  }, "launch fixture manifest entry")
  validateFrozenLaunchFixture(beforeFixture.bytes)
  const afterManifest = await readStableRegularFile(join(directory, "manifest.json"), contractModes)
  const afterFixture = await readStableRegularFile(
    join(directory, "fx-launch-admission-final.jsonl"),
    contractModes,
  )
  expectEqual(afterManifest.facts, beforeManifest.facts, "contract manifest path stability")
  expectEqual(afterFixture.facts, beforeFixture.facts, "launch fixture path stability")
  if (
    sha256(afterManifest.bytes) !== sha256(beforeManifest.bytes) ||
    sha256(afterFixture.bytes) !== sha256(beforeFixture.bytes)
  ) {
    throw new Error("contract bytes changed during verification")
  }
  return {
    bytes: 4_262,
    consumer_action: "decoded_and_cross-correlated_without_mutation",
    digest: `sha256:${PHASE1A_LAUNCH_FIXTURE_SHA256}`,
    message_count: 9,
    schema_id: LAUNCH_SCHEMA_ID,
    schema_version: 1,
  }
}

function validateFrozenLaunchFixture(bytes: Uint8Array): void {
  if (bytes.byteLength !== 4_262 || sha256(bytes) !== PHASE1A_LAUNCH_FIXTURE_SHA256) {
    throw new Error("frozen launch/admission/final fixture changed")
  }
  const text = decoder.decode(bytes)
  if (!text.endsWith("\n") || text.includes("\r")) {
    throw new Error("frozen launch fixture has noncanonical line endings")
  }
  const lines = text.slice(0, -1).split("\n")
  if (lines.length !== 9 || lines.some((line) => line.length === 0)) {
    throw new Error("frozen launch fixture message inventory changed")
  }
  const messages = lines.map((line) => {
    const value = requireRecord(JSON.parse(line), "frozen launch message")
    if (line !== JSON.stringify(sortJson(value as JsonValue))) {
      throw new Error("frozen launch message is not canonical")
    }
    if (value.schema_id !== LAUNCH_SCHEMA_ID || value.schema_version !== 1) {
      throw new Error("frozen launch message envelope changed")
    }
    return value
  })
  const byType = (type: string) => messages.filter(({ message_type }) => message_type === type)
  expectEqual(
    [
      byType("launch_request").length,
      byType("launch_receipt").length,
      byType("admission_cancel_request").length,
      byType("admission_decision").length,
      byType("final_receipt").length,
      byType("final_receipt_acknowledgement").length,
    ],
    [2, 2, 1, 2, 1, 1],
    "frozen launch message types",
  )
  for (const launch of byType("launch_request")) {
    const specification: Record<string, unknown> = {
      admission_key: launch.admission_key,
      conversation_name: launch.conversation_name,
      directory: launch.directory,
    }
    if (launch.effort !== undefined) specification.effort = launch.effort
    specification.initial_work_digest = launch.initial_work_digest
    specification.launch_id = launch.launch_id
    if (launch.model !== undefined) specification.model = launch.model
    specification.remaining_launch_controls_digest = launch.remaining_launch_controls_digest
    specification.resume = launch.resume
    specification.state_root = launch.state_root
    if (sha256(JSON.stringify(sortJson(specification as JsonValue))) !== launch.launch_digest) {
      throw new Error("frozen launch digest changed")
    }
    const correlated = messages.filter(({ launch_id }) => launch_id === launch.launch_id)
    for (const message of correlated) {
      if (
        message.admission_key !== launch.admission_key ||
        message.launch_digest !== launch.launch_digest
      ) {
        throw new Error("frozen launch correlation changed")
      }
    }
    const receipt = correlated.find(({ message_type }) => message_type === "launch_receipt")
    const decision = correlated.find(({ message_type }) => message_type === "admission_decision")
    if (receipt?.request_id !== launch.request_id || decision === undefined) {
      throw new Error("frozen launch lacks its exact receipt and decision")
    }
    validateFrozenReceiptDigest(decision)
    const decisionValue = requireRecord(decision.decision, "frozen admission decision")
    const final = correlated.find(({ message_type }) => message_type === "final_receipt")
    const acknowledgement = correlated.find(({ message_type }) => message_type === "final_receipt_acknowledgement")
    if (decisionValue.kind === "admitted") {
      if (final === undefined || acknowledgement === undefined) {
        throw new Error("frozen admitted launch lacks final receipt acknowledgement")
      }
      validateFrozenReceiptDigest(final)
      for (const key of ["admission_key", "conversation_id", "launch_digest", "launch_id", "receipt_digest", "receipt_id"] as const) {
        if (acknowledgement[key] !== final[key]) throw new Error(`frozen final ${key} correlation changed`)
      }
    } else if (decisionValue.kind === "cancelled_before_start") {
      if (final !== undefined || acknowledgement !== undefined) {
        throw new Error("frozen cancelled launch carries a final receipt")
      }
    } else {
      throw new Error("frozen admission decision kind changed")
    }
  }
}

function validateFrozenReceiptDigest(receipt: Record<string, unknown>): void {
  const content = { ...receipt }
  delete content.receipt_digest
  if (sha256(JSON.stringify(sortJson(content as JsonValue))) !== receipt.receipt_digest) {
    throw new Error("frozen receipt digest changed")
  }
}

async function readOwnerGateReceipt(path: string): Promise<Record<string, JsonValue>> {
  if (!isAbsolute(path) || await realpath(path) !== path) {
    throw new Error("owner gate receipt must be one canonical absolute path")
  }
  const { bytes } = await readStableRegularFile(path, FILE_MODE)
  if (sha256(bytes) !== PHASE1A_OWNER_GATE_RECEIPT_SHA256) {
    throw new Error("canonical Fx owner-gate receipt identity changed")
  }
  const receipt = requireRecord(JSON.parse(decoder.decode(bytes)), "Fx owner-gate receipt")
  const outcomes = requireRecord(receipt.outcomes, "Fx owner-gate outcomes")
  if (
    receipt.schema !== 1 || receipt.fx_sha !== PHASE1A_FX_COMMIT ||
    receipt.contract_digest !== PHASE1A_OWNER_GATE_CONTRACT_DIGEST ||
    outcomes.fxnk_unit_canaries !== "pass"
  ) {
    throw new Error("canonical Fx owner gate did not prove the pinned canaries")
  }
  return {
    canary_count: 116,
    classification: "canonical_owner_gate_only_not_fresh_consumer_execution",
    contract_digest: PHASE1A_OWNER_GATE_CONTRACT_DIGEST,
    exact_names: [...PHASE1A_OWNER_CANARIES],
    receipt_digest: `sha256:${PHASE1A_OWNER_GATE_RECEIPT_SHA256}`,
    receipt_mode: "0600",
    status: "pass",
  }
}

async function validateEvidenceDirectory(path: string, mustBeEmpty: boolean): Promise<string> {
  const facts = await lstat(path)
  if (facts.isSymbolicLink() || !facts.isDirectory()) {
    throw new Error("evidence must be an existing real directory")
  }
  if ((facts.mode & 0o077) !== 0) throw new Error("evidence directory must be private")
  if (mustBeEmpty && (await readdir(path)).length !== 0) throw new Error("evidence directory must be empty")
  const physical = await realpath(path)
  await chmod(physical, DIRECTORY_MODE)
  return physical
}

async function writeExclusive(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const destination = join(root, path)
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE)
  try {
    await handle.writeFile(bytes)
    await handle.chmod(FILE_MODE)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function parseArguments(argv: readonly string[]): {
  contracts: string
  evidence: string
  fx: string
  ownerGateReceipt: string
} {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(usage)
    process.exit(0)
  }
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!["--contracts", "--evidence", "--fx", "--owner-gate-receipt"].includes(flag ?? "")) {
      throw new Error(`unknown argument: ${flag ?? ""}`)
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`)
    }
    if (values.has(flag)) throw new Error(`${flag} may be provided only once`)
    values.set(flag, value)
  }
  const fx = values.get("--fx")
  const evidence = values.get("--evidence")
  const contracts = values.get("--contracts")
  const ownerGateReceipt = values.get("--owner-gate-receipt")
  if (fx === undefined) throw new Error("--fx is required")
  if (evidence === undefined) throw new Error("--evidence is required")
  if (contracts === undefined) throw new Error("--contracts is required")
  if (ownerGateReceipt === undefined) throw new Error("--owner-gate-receipt is required")
  return {
    contracts: resolve(contracts),
    evidence: resolve(evidence),
    fx: resolve(fx),
    ownerGateReceipt: resolve(ownerGateReceipt),
  }
}

export async function runPhase1aConsumerFixture(input: {
  readonly contracts?: string
  readonly evidence: string
  readonly fx: string
  readonly ownerGateReceipt?: string
}): Promise<Phase1aConsumerEvidence> {
  const evidenceRoot = await validateEvidenceDirectory(input.evidence, true)
  const fxSource = await verifyInstalledFxSource(input.fx)
  const contracts = input.contracts ?? join(REPOSITORY_ROOT, "contracts", "agentworkplace", "v1")
  const ownerGateReceipt = input.ownerGateReceipt ?? join(
    process.env.HOME ?? "",
    ".local",
    "state",
    "fxnk",
    "local-gates",
    `${PHASE1A_FX_COMMIT}.json`,
  )
  const frozenFixture = await consumeFrozenContracts(contracts)
  const ownerGate = await readOwnerGateReceipt(ownerGateReceipt)
  const createdScratch = await mkdtemp(join(tmpdir(), "fmx-phase1a-consumer-"))
  const scratch = await realpath(createdScratch)
  await chmod(scratch, DIRECTORY_MODE)
  const scratchFacts = await lstat(scratch, { bigint: true })
  const failures: unknown[] = []
  let fx: (Phase1aFxIdentity & { path: string }) | undefined
  let scenarioEvents: readonly ScenarioEvent[] | undefined
  let snapshot: VerifiedFxFile | undefined
  try {
    snapshot = await createExecutableFxSnapshot(scratch, fxSource)
    fx = await identifyFxSnapshot(snapshot, fxSource.path)
    scenarioEvents = [
      await runNamingScenario(snapshot.path, scratch),
      await runAdmissionScenario(snapshot.path, scratch),
      await runStructuredScenario(snapshot.path, scratch),
    ]
  } catch (error) {
    failures.push(error)
  }
  try {
    if (snapshot === undefined) await revalidateInstalledFxSource(fxSource)
    else await revalidateFxExecution(fxSource, snapshot, fx)
  } catch (error) {
    failures.push(error)
  }
  try {
    await removeExactTemporaryRoot(scratch, scratchFacts.dev, scratchFacts.ino)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, "consumer fixture execution, revalidation, or cleanup failed")
  }
  if (fx === undefined || scenarioEvents === undefined) {
    throw new Error("consumer fixture completed without execution identity or scenarios")
  }

  const logEvents: JsonValue[] = [
      {
        bytes: frozenFixture.bytes!,
        digest: frozenFixture.digest!,
        event: "contract.consumed",
        message_count: frozenFixture.message_count!,
        schema_id: LAUNCH_SCHEMA_ID,
      },
      ...scenarioEvents!,
      {
        event: "cleanup.confirmed",
        mock_servers: 0,
        owned_processes: 0,
        pty_sessions: 0,
        temporary_roots: 0,
      },
  ]
  const stdoutBytes = new TextEncoder().encode(logEvents.map(canonicalEvent).join(""))
  const stderrBytes = new Uint8Array()
  const stdoutEvidence = fileEvidence(PHASE1A_CONSUMER_STDOUT_PATH, stdoutBytes)
  const stderrEvidence = fileEvidence(PHASE1A_CONSUMER_STDERR_PATH, stderrBytes)
  const receiptValue = {
      accepted: true,
      artifacts: { stderr: stderrEvidence, stdout: stdoutEvidence },
      authority: {
        phase: "1a",
        plan: "AgentWorkplace Plan Revision 1",
        wiki_commit: AUTHORITY_COMMIT,
      },
      cleanup: {
        mock_servers_reaped: true,
        owned_processes_reaped: true,
        pty_sessions_reaped: true,
        temporary_root_removed_before_receipt: true,
      },
      contracts: {
        launch_admission_final: frozenFixture,
        owner_manifest_digest: `sha256:${PHASE1A_OWNER_MANIFEST_SHA256}`,
        structured_inference: {
          request_digest: PHASE1A_STRUCTURED_REQUEST_DIGEST,
          schema_id: STRUCTURED_SCHEMA_ID,
          schema_version: 1,
        },
        work_control: { schema_version: 1, status: "unchanged" },
      },
      execution: {
        identity_probes: "exclusive_private_snapshot",
        installed_source_executed: false,
        installed_source_path: fx.path,
        scenarios: "exclusive_private_snapshot",
        snapshot_bytes: fx.bytes,
        snapshot_mode: "0755",
        snapshot_retained: false,
        snapshot_revalidated_after_execution: true,
        snapshot_sha256: fx.sha256,
        source_revalidated_after_execution: true,
      },
      fx,
      non_goals: {
        binary_archived: false,
        phase1c_lifecycle_implemented: false,
        production_launch_transport_added: false,
        public_cli_added: false,
        public_mcp_changed: false,
      },
      owner_canary_evidence: ownerGate,
      scenarios: scenarioEvents!.map(({ facts, scenario_id }) => ({
        evidence_scope: "fresh_verified_installed_binary_snapshot",
        facts,
        scenario_id,
        status: "passed",
      })),
      schema_id: PHASE1A_CONSUMER_EXECUTION_SCHEMA_ID,
      schema_version: PHASE1A_CONSUMER_EXECUTION_SCHEMA_VERSION,
  } as unknown as JsonValue
  const receiptBytes = new TextEncoder().encode(canonicalPhase1aConsumerJson(receiptValue))
  await writeExclusive(evidenceRoot, PHASE1A_CONSUMER_STDOUT_PATH, stdoutBytes)
  await writeExclusive(evidenceRoot, PHASE1A_CONSUMER_STDERR_PATH, stderrBytes)
  await writeExclusive(evidenceRoot, PHASE1A_CONSUMER_EXECUTION_PATH, receiptBytes)
  return verifyPhase1aConsumerEvidence(evidenceRoot, fx)
}

async function removeExactTemporaryRoot(path: string, device: bigint, inode: bigint): Promise<void> {
  const facts = await lstat(path, { bigint: true })
  if (facts.isSymbolicLink() || !facts.isDirectory() || facts.dev !== device || facts.ino !== inode) {
    throw new Error("refusing to remove a replaced consumer fixture root")
  }
  await rm(path, { recursive: true })
}

async function evidenceFile(root: string, path: string): Promise<{ bytes: Uint8Array; record: EvidenceFile }> {
  const { bytes } = await readStableRegularFile(join(root, path), FILE_MODE)
  return { bytes, record: fileEvidence(path, bytes) }
}

export async function verifyPhase1aConsumerEvidence(
  root: string,
  expectedFxIdentity: Phase1aFxIdentity = PHASE1A_EXPECTED_FX_IDENTITY,
): Promise<Phase1aConsumerEvidence> {
  const directory = await validateEvidenceDirectory(root, false)
  const inventory = (await readdir(directory)).sort()
  expectEqual(inventory, [...PHASE1A_CONSUMER_EVIDENCE_PATHS].sort(), "consumer evidence inventory")
  const receiptFile = await evidenceFile(directory, PHASE1A_CONSUMER_EXECUTION_PATH)
  const stdout = await evidenceFile(directory, PHASE1A_CONSUMER_STDOUT_PATH)
  const stderr = await evidenceFile(directory, PHASE1A_CONSUMER_STDERR_PATH)
  if (stderr.bytes.byteLength !== 0) throw new Error("consumer stderr evidence must be empty")

  const receiptText = decoder.decode(receiptFile.bytes)
  const receipt = requireRecord(JSON.parse(receiptText), "consumer receipt") as Record<string, JsonValue>
  if (receiptText !== canonicalPhase1aConsumerJson(receipt)) {
    throw new Error("consumer receipt is not canonical JSON")
  }
  exactKeys(receipt, [
    "accepted",
    "artifacts",
    "authority",
    "cleanup",
    "contracts",
    "execution",
    "fx",
    "non_goals",
    "owner_canary_evidence",
    "scenarios",
    "schema_id",
    "schema_version",
  ], "consumer receipt")
  if (
    receipt.schema_id !== PHASE1A_CONSUMER_EXECUTION_SCHEMA_ID ||
    receipt.schema_version !== PHASE1A_CONSUMER_EXECUTION_SCHEMA_VERSION || receipt.accepted !== true
  ) {
    throw new Error("consumer receipt envelope changed")
  }
  const authority = requireRecord(receipt.authority, "consumer authority")
  expectEqual(authority, {
    phase: "1a",
    plan: "AgentWorkplace Plan Revision 1",
    wiki_commit: AUTHORITY_COMMIT,
  }, "consumer authority")
  const fx = requireRecord(receipt.fx, "consumer Fx identity")
  exactKeys(fx, ["bytes", "commit", "fxnk", "mode", "path", "sha256", "tree", "version"], "consumer Fx identity")
  for (const [key, value] of Object.entries(expectedFxIdentity)) {
    if (value !== undefined && fx[key] !== value) throw new Error(`consumer Fx ${key} changed`)
  }
  if (typeof fx.path !== "string" || !isAbsolute(fx.path)) throw new Error("consumer Fx path is not absolute")
  const execution = requireRecord(receipt.execution, "consumer execution evidence")
  expectEqual(execution, {
    identity_probes: "exclusive_private_snapshot",
    installed_source_executed: false,
    installed_source_path: fx.path,
    scenarios: "exclusive_private_snapshot",
    snapshot_bytes: fx.bytes,
    snapshot_mode: "0755",
    snapshot_retained: false,
    snapshot_revalidated_after_execution: true,
    snapshot_sha256: fx.sha256,
    source_revalidated_after_execution: true,
  }, "consumer execution evidence")

  const artifacts = requireRecord(receipt.artifacts, "consumer artifacts")
  exactKeys(artifacts, ["stderr", "stdout"], "consumer artifacts")
  expectEqual(artifacts.stdout, stdout.record, "consumer stdout evidence")
  expectEqual(artifacts.stderr, stderr.record, "consumer stderr evidence")
  expectEqual(receipt.cleanup, {
    mock_servers_reaped: true,
    owned_processes_reaped: true,
    pty_sessions_reaped: true,
    temporary_root_removed_before_receipt: true,
  }, "consumer cleanup evidence")
  expectEqual(receipt.non_goals, {
    binary_archived: false,
    phase1c_lifecycle_implemented: false,
    production_launch_transport_added: false,
    public_cli_added: false,
    public_mcp_changed: false,
  }, "consumer non-goals")
  const contracts = requireRecord(receipt.contracts, "consumer contracts")
  exactKeys(
    contracts,
    ["launch_admission_final", "owner_manifest_digest", "structured_inference", "work_control"],
    "consumer contracts",
  )
  const launch = requireRecord(contracts.launch_admission_final, "launch contract evidence")
  expectEqual(launch, {
    bytes: 4_262,
    consumer_action: "decoded_and_cross-correlated_without_mutation",
    digest: `sha256:${PHASE1A_LAUNCH_FIXTURE_SHA256}`,
    message_count: 9,
    schema_id: LAUNCH_SCHEMA_ID,
    schema_version: 1,
  }, "launch contract evidence")
  if (contracts.owner_manifest_digest !== `sha256:${PHASE1A_OWNER_MANIFEST_SHA256}`) {
    throw new Error("consumer owner manifest digest changed")
  }
  expectEqual(contracts.structured_inference, {
    request_digest: PHASE1A_STRUCTURED_REQUEST_DIGEST,
    schema_id: STRUCTURED_SCHEMA_ID,
    schema_version: 1,
  }, "structured inference contract evidence")
  expectEqual(contracts.work_control, { schema_version: 1, status: "unchanged" }, "Work-control evidence")

  if (!Array.isArray(receipt.scenarios)) throw new Error("consumer scenarios must be an array")
  const scenarios = receipt.scenarios.map((value) => requireRecord(value, "consumer scenario"))
  expectEqual(scenarios.map(({ scenario_id }) => scenario_id), PHASE1A_CONSUMER_SCENARIO_IDS, "consumer scenario inventory")
  for (const scenario of scenarios) {
    exactKeys(scenario, ["evidence_scope", "facts", "scenario_id", "status"], "consumer scenario")
    if (scenario.evidence_scope !== "fresh_verified_installed_binary_snapshot" || scenario.status !== "passed") {
      throw new Error(`consumer scenario ${String(scenario.scenario_id)} is not a fresh snapshot-binary pass`)
    }
  }
  const namingFacts = requireRecord(scenarios[0]!.facts, "naming scenario facts")
  exactKeys(namingFacts, [
    "automatic_name_requests",
    "completion_requests",
    "conversation_count",
    "exact_resume_isolated",
    "launch_name_non_leakage",
    "selected_state_root_separate_from_home",
    "workspace_rebound",
  ], "naming scenario facts")
  expectEqual({
    automatic_name_requests: namingFacts.automatic_name_requests,
    completion_requests: namingFacts.completion_requests,
    conversation_count: namingFacts.conversation_count,
    exact_resume_isolated: namingFacts.exact_resume_isolated,
    launch_name_non_leakage: namingFacts.launch_name_non_leakage,
    selected_state_root_separate_from_home: namingFacts.selected_state_root_separate_from_home,
    workspace_rebound: namingFacts.workspace_rebound,
  }, {
    automatic_name_requests: 1,
    completion_requests: 4,
    conversation_count: 2,
    exact_resume_isolated: true,
    launch_name_non_leakage: true,
    selected_state_root_separate_from_home: true,
    workspace_rebound: true,
  }, "naming scenario claims")
  const admissionFacts = requireRecord(scenarios[1]!.facts, "admission scenario facts")
  exactKeys(admissionFacts, [
    "active_turn_id",
    "admission_key_persisted",
    "decision_disposition",
    "delivery_markers",
    "duplicate_queue_entries",
    "exact_replay",
    "final_receipt_claim",
    "queue_length",
    "turn_id",
    "work_control_schema",
  ], "admission scenario facts")
  if (
    admissionFacts.active_turn_id !== admissionFacts.turn_id ||
    admissionFacts.admission_key_persisted !== true || admissionFacts.decision_disposition !== "queued" ||
    admissionFacts.duplicate_queue_entries !== 0 || admissionFacts.exact_replay !== true ||
    admissionFacts.final_receipt_claim !== "frozen_fixture_and_owner_gate_only" ||
    admissionFacts.queue_length !== 0 ||
    admissionFacts.work_control_schema !== 1 ||
    typeof admissionFacts.turn_id !== "string" || !/^[1-9]\d*$/u.test(admissionFacts.turn_id)
  ) {
    throw new Error("admission scenario claims changed")
  }
  const deliveryMarkers = requireRecord(admissionFacts.delivery_markers, "admission delivery markers")
  exactKeys(deliveryMarkers, ["authority", "consumed", "visible"], "admission delivery markers")
  expectEqual(deliveryMarkers, { authority: true, consumed: true, visible: true }, "admission delivery markers")
  const structuredFacts = requireRecord(scenarios[2]!.facts, "structured scenario facts")
  expectEqual(structuredFacts, {
    acknowledgement_idempotent: true,
    catalog_preceded_provider: true,
    conflict_rejected: true,
    interactive_session_created: false,
    pre_admission_cancellation_provider_requests: 0,
    provider_requests: 1,
    replay_provider_requests: 0,
    request_digest: PHASE1A_STRUCTURED_REQUEST_DIGEST,
    tool_count: 0,
  }, "structured scenario claims")
  const ownerCanaries = requireRecord(receipt.owner_canary_evidence, "owner canary evidence")
  exactKeys(ownerCanaries, [
    "canary_count",
    "classification",
    "contract_digest",
    "exact_names",
    "receipt_digest",
    "receipt_mode",
    "status",
  ], "owner canary evidence")
  if (
    ownerCanaries.canary_count !== 116 ||
    ownerCanaries.classification !== "canonical_owner_gate_only_not_fresh_consumer_execution" ||
    ownerCanaries.contract_digest !== PHASE1A_OWNER_GATE_CONTRACT_DIGEST ||
    ownerCanaries.receipt_digest !== `sha256:${PHASE1A_OWNER_GATE_RECEIPT_SHA256}` ||
    ownerCanaries.receipt_mode !== "0600" ||
    ownerCanaries.status !== "pass"
  ) {
    throw new Error("owner-canary evidence was overstated or changed")
  }
  expectEqual(ownerCanaries.exact_names, PHASE1A_OWNER_CANARIES, "owner canary inventory")

  const lines = decoder.decode(stdout.bytes).split("\n")
  if (lines.at(-1) !== "") throw new Error("consumer stdout log lacks its final newline")
  lines.pop()
  const events = lines.map((line) => {
    const value = requireRecord(JSON.parse(line), "consumer stdout event") as Record<string, JsonValue>
    if (line !== JSON.stringify(sortJson(value))) throw new Error("consumer stdout event is not canonical")
    return value
  })
  expectEqual(
    events.filter(({ event }) => event === "scenario.passed").map(({ scenario_id }) => scenario_id),
    PHASE1A_CONSUMER_SCENARIO_IDS,
    "consumer stdout scenario inventory",
  )
  if (
    events.length !== 5 || events[0]?.event !== "contract.consumed" ||
    events.at(-1)?.event !== "cleanup.confirmed"
  ) {
    throw new Error("consumer stdout event inventory changed")
  }
  expectEqual(events[0], {
    bytes: 4_262,
    digest: `sha256:${PHASE1A_LAUNCH_FIXTURE_SHA256}`,
    event: "contract.consumed",
    message_count: 9,
    schema_id: LAUNCH_SCHEMA_ID,
  }, "consumer contract event")
  for (const [index, scenario] of scenarios.entries()) {
    const event = events[index + 1]!
    expectEqual(event.facts, scenario.facts, `consumer scenario ${index + 1} log facts`)
  }
  expectEqual(events[4], {
    event: "cleanup.confirmed",
    mock_servers: 0,
    owned_processes: 0,
    pty_sessions: 0,
    temporary_roots: 0,
  }, "consumer cleanup event")
  return { directory, receipt, stderr: stderr.record, stdout: stdout.record }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

async function main(): Promise<void> {
  const args = parseArguments(Bun.argv.slice(2))
  const evidence = await runPhase1aConsumerFixture(args)
  const summary = {
    accepted: true,
    evidence: evidence.directory,
    receipt: join(evidence.directory, PHASE1A_CONSUMER_EXECUTION_PATH),
    stderr: join(evidence.directory, PHASE1A_CONSUMER_STDERR_PATH),
    stdout: join(evidence.directory, PHASE1A_CONSUMER_STDOUT_PATH),
  }
  process.stdout.write(canonicalEvent(summary))
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`fmx Phase 1A consumer fixture: ${error instanceof Error ? error.message : String(error)}\n${usage}`)
    process.exitCode = 1
  }
}
