import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentManifest, identityFor, type ManifestEntry } from "../src/agent-manifest.ts"
import { deriveLifecycleReceiptDigest, ExactRetirementLedger, type EndReceipt, type EndRequest } from "../src/exact-retirement-ledger.ts"
import { GitSafeWorktreeAuthority, GitSafeWorktreeCleanup } from "../src/git-safe-worktree-cleanup.ts"
import {
  LifecycleRuntime,
  lifecycleRuntimeRoots,
  type LifecycleRuntimeMultiplexer,
  type LifecycleRuntimeOptions,
} from "../src/lifecycle-runtime.ts"
import type { ManagedAgentClaim, ManagedAgentInvocation } from "../src/multiplexer.ts"
import { RuntimeExtensionSupervisor } from "../src/runtime-extension.ts"
import { deriveFxAdmissionDecisionDigest, EnsureLifecycleLedger, type FxAdmissionDecision } from "../src/ensure-lifecycle-ledger.ts"
import { InlineLaunchSourceLedger } from "../src/inline-launch-source.ts"
import type { RuntimeExtensionStartup } from "../src/runtime-startup.ts"
import { RUNTIME_EXTENSION_CAPABILITIES } from "../src/agentworkplace-contracts.ts"

const FIXTURE = fileURLToPath(new URL("./fixtures/phase1c-runtime-extension.ts", import.meta.url))
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

test("restarts a durable Phase 1C lifecycle exactly once and preserves dirty and foreign replacements", async () => {
  const root = await temporaryDirectory()
  const repository = join(root, "repository")
  const worktree = join(root, "worktrees", "phase1c")
  const home = join(root, "home")
  const fixtureState = join(root, "fixture-state.json")
  const releaseMarker = join(root, "release.marker")
  const fixtureLog = join(root, "fixture.jsonl")
  const homeId = "phase1c-restart-home"
  const shared = new Counts()
  const baseCommit = await initializeRepository(repository)
  await mkdir(join(root, "worktrees"), { recursive: true, mode: 0o700 })
  await writeFile(releaseMarker, "release\n", { mode: 0o600 })

  const first = await openRuntime({ home, homeId, shared, repository, worktree })
  let firstExtension: RuntimeExtensionSupervisor | null = null
  try {
    firstExtension = await startFixture({
      runtime: first.runtime,
      statePath: fixtureState,
      releaseMarker,
      logPath: fixtureLog,
      repository,
      baseCommit,
      worktree,
      counts: shared,
      crashAfter: "acknowledgement_intent_saved",
    })
    await Bun.sleep(100)
    expect((await first.ensureLedger.list()).length).toBe(1)
    await waitFor(async () => {
      const ensure = await first.ensureLedger.get("phase1c-ensure")
      return ensure !== null && await first.sourceLedger.sourceForEnsure(ensure.request) !== null
    })
    first.runtime.bindReceiptPublisher((receipt) => publishFixtureReceipt(firstExtension!, receipt, true))
    await first.runtime.recover()
    await waitFor(async () => (await first.ensureLedger.get("phase1c-ensure"))?.stage === "fx_started" ||
      shared.errors.length > 0 || firstExtension!.state !== "ready")
    expect(shared.errors.map(String)).toEqual([])
    expect((await first.ensureLedger.get("phase1c-ensure"))?.receipts.some((receipt) =>
      receipt.status === "complete")).toBe(true)
    await waitFor(() => firstExtension!.state === "degraded" || shared.errors.length > 0)
    expect(firstExtension.lastFailure?.exitCode).toBe(86)
    expect(shared.errors.map(String)).toEqual([])
    expect(await fixtureStateFor(fixtureState)).toMatchObject({
      receipts: [expect.objectContaining({ kind: "ensure", acknowledgement: expect.any(Object) })],
    })
    expect(shared.starts).toBe(1)
    expect(shared.turns).toBe(1)
    expect(shared.inlineCallbacks).toBe(1)
    expect(shared.lifecycleCallbacks).toBe(1)
    expect(await exactWorktreeCount(repository, worktree)).toBe(1)
  } finally {
    await first.runtime.close()
    await firstExtension?.close()
  }

  // The first child persisted its acknowledgement intent and then crashed.
  // Withhold release during the next initialize so Runtime recovery must replay
  // the already durable receipt before the child can acknowledge it.
  await unlink(releaseMarker)

  const second = await openRuntime({ home, homeId, shared, repository, worktree })
  let secondExtension: RuntimeExtensionSupervisor | null = null
  try {
    secondExtension = await startFixture({
      runtime: second.runtime,
      statePath: fixtureState,
      releaseMarker,
      logPath: fixtureLog,
      repository,
      baseCommit,
      worktree,
      counts: shared,
    })
    second.runtime.bindReceiptPublisher((receipt) => publishFixtureReceipt(secondExtension!, receipt))
    await waitFor(async () => {
      const ensure = await second.ensureLedger.get("phase1c-ensure")
      return ensure !== null && await second.sourceLedger.sourceForEnsure(ensure.request) !== null
    })
    await second.runtime.recover()
    await waitFor(async () => (await receivedEnsureReceipts(fixtureLog)).length === 2)

    const replayed = await receivedEnsureReceipts(fixtureLog)
    expect([...new Set(replayed.map((receipt) => receipt.receipt_id))]).toHaveLength(1)
    expect([...new Set(replayed.map((receipt) => receipt.receipt_digest))]).toHaveLength(1)
    expect(shared.starts).toBe(1)
    expect(shared.turns).toBe(1)
    expect(await exactWorktreeCount(repository, worktree)).toBe(1)

    // The end is held at the counted Companion seam. Dirty the exact owned
    // Worktree before releasing the proof, so cleanup's durable result is the
    // production refused_dirty path rather than a test-created substitute.
    await writeFile(releaseMarker, "release\n", { mode: 0o600 })
    await waitFor(async () => (await fixtureLogMessages(fixtureLog, "outbound", "end_request")).length === 1)
    await waitFor(() => shared.retirement.calls === 1)
    await writeFile(join(worktree, "dirty-owned.txt"), "must remain\n", { mode: 0o600 })
    shared.retirement.release()
    await waitFor(async () => (await second.retirementLedger.get("phase1c-ensure"))?.end?.receipt !== null ||
      shared.errors.length > 0)
    expect(shared.errors.map(String)).toEqual([])
    await waitFor(async () => (await fixtureLogMessages(fixtureLog, "inbound", "end_receipt")).length === 1)
    await waitFor(async () => (await fixtureLogMessages(fixtureLog, "outbound", "cleanup_request")).length === 1)
    await waitFor(async () => {
      const record = await second.retirementLedger.get("phase1c-ensure")
      return record?.cleanup?.receipt?.outcome.kind === "refused_dirty"
    })

    const retired = await second.retirementLedger.get("phase1c-ensure")
    expect(retired?.end?.receipt?.proof).toMatchObject({ kind: "ended", exit_code: 0, signal: 0 })
    expect(retired?.cleanup?.receipt?.outcome).toMatchObject({ kind: "refused_dirty" })
    expect(shared.retirement.calls).toBe(1)
    expect(shared.cleanup.calls).toBe(1)
    expect(shared.cleanup.removeAttempts).toBe(0)
    expect(shared.inlineCallbacks).toBe(2)
    expect(shared.lifecycleCallbacks).toBe(7)
  } finally {
    await second.runtime.close()
    await secondExtension?.close()
  }

  // A later process must not turn a completed dirty refusal into a broad
  // cleanup. Replace the path with an intentionally foreign directory and
  // recover once more; the retained receipt leaves it completely untouched.
  await git(repository, ["worktree", "remove", "--force", worktree])
  await mkdir(worktree, { recursive: true, mode: 0o700 })
  const foreignSentinel = join(worktree, "foreign-replacement.txt")
  await writeFile(foreignSentinel, "foreign replacement survives\n", { mode: 0o600 })

  const third = await openRuntime({ home, homeId, shared, repository, worktree })
  try {
    await third.runtime.recover()
    expect(await readFile(foreignSentinel, "utf8")).toBe("foreign replacement survives\n")
    expect(shared.starts).toBe(1)
    expect(shared.turns).toBe(1)
    expect(shared.retirement.calls).toBe(1)
    expect(shared.cleanup.calls).toBe(1)
    expect(shared.cleanup.removeAttempts).toBe(0)
    expect(shared.inlineCallbacks).toBe(2)
    expect(shared.lifecycleCallbacks).toBe(7)
  } finally {
    await third.runtime.close()
  }
}, 15_000)

type RuntimeHarness = {
  runtime: LifecycleRuntime
  ensureLedger: EnsureLifecycleLedger
  sourceLedger: InlineLaunchSourceLedger
  retirementLedger: ExactRetirementLedger
}

async function openRuntime(input: {
  home: string
  homeId: string
  shared: Counts
  repository: string
  worktree: string
}): Promise<RuntimeHarness> {
  const roots = lifecycleRuntimeRoots(input.home)
  const ensureLedger = await EnsureLifecycleLedger.open(roots.ensure)
  const sourceLedger = await InlineLaunchSourceLedger.open(roots.inlineSource)
  const retirementLedger = await ExactRetirementLedger.open(roots.retirement)
  const manifest = await AgentManifest.open(join(input.home, "manifest.json"), input.homeId)
  const multiplexer = new CountingMultiplexer(manifest, input.shared)
  const cleanupAuthority = new GitSafeWorktreeAuthority()
  const cleanup = new CountingCleanup(
    new GitSafeWorktreeCleanup(retirementLedger, {
      inspect: cleanupAuthority.inspect.bind(cleanupAuthority),
      compareAndRemove: async (prepare) => {
        input.shared.cleanup.removeAttempts++
        return cleanupAuthority.compareAndRemove(prepare)
      },
    }, { now: fixedNow }),
    input.shared,
  )
  const options = {
    home: input.home,
    homeId: input.homeId,
    fmxSession: "session-beta",
    fxPath: "/resolved/fmx-fx",
    runtimeSocketPath: join(input.home, "runtime.bus"),
    adeBinding: null,
    manifest,
    companion: { list: async () => [] },
    companionDirectory: join(input.home, "zmx"),
    environment: {},
    now: fixedNow,
    onError: (error: unknown) => { input.shared.errors.push(error) },
    ensureLedger,
    inlineSourceLedger: sourceLedger,
    retirementLedger,
    launchProvider: new CountingProvider(input.shared),
    workControl: new CountingWorkControl(input.shared),
    retirement: input.shared.retirement.for(retirementLedger),
    cleanup,
  } satisfies LifecycleRuntimeOptions
  const runtime = await LifecycleRuntime.open(options)
  runtime.bindMultiplexer(multiplexer)
  return { runtime, ensureLedger, sourceLedger, retirementLedger }
}

async function startFixture(input: {
  runtime: LifecycleRuntime
  statePath: string
  releaseMarker: string
  logPath: string
  repository: string
  baseCommit: string
  worktree: string
  counts: Counts
  crashAfter?: string
}): Promise<RuntimeExtensionSupervisor> {
  let inbound = Promise.resolve()
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = inbound.then(operation, operation)
    inbound = current.then(() => undefined, () => undefined)
    return current
  }
  return RuntimeExtensionSupervisor.start(startup(), {
    onRequest: (request) => {
      if (request.message_type !== "snapshot_get") throw new Error(`unexpected fixture request ${request.message_type}`)
      return {
        schema_id: "fmx.runtime-extension",
        schema_version: 1,
        message_type: "snapshot_result",
        request_id: request.request_id,
        fmx_session: request.fmx_session,
        revision: "1",
        selected_agent_id: null,
        agents: [],
      }
    },
    onLifecycleMessage: (message, signal) => {
      input.counts.lifecycleCallbacks++
      return serialize(() => input.runtime.acceptLifecycle(message, signal))
    },
    onInlineLaunchSourceRequest: (source, signal) => {
      input.counts.inlineCallbacks++
      return serialize(() => input.runtime.acceptInlineSource(source, signal))
    },
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownGraceMs: 40,
    terminateGraceMs: 40,
    env: {
      ...process.env,
      FMX_PHASE1C_FIXTURE_STATE: input.statePath,
      FMX_PHASE1C_FIXTURE_RELEASE_MARKER: input.releaseMarker,
      FMX_PHASE1C_FIXTURE_LOG: input.logPath,
      FMX_PHASE1C_FIXTURE_REPOSITORY: input.repository,
      FMX_PHASE1C_FIXTURE_BASE_COMMIT: input.baseCommit,
      FMX_PHASE1C_FIXTURE_WORKTREE_DIRECTORY: input.worktree,
      FMX_PHASE1C_FIXTURE_CRASH_AFTER: input.crashAfter,
    },
  })
}

function startup(): RuntimeExtensionStartup {
  return {
    association: {
      schema_id: "fmx.runtime-extension",
      schema_version: 1,
      message_type: "association",
      workplace_instance_id: "phase1c-workplace",
      extension_id: "phase1c-extension",
      configuration_id: "phase1c-configuration",
      members: [
        { placement_id: "phase1c-unused-placement", fmx_session: "session-alpha" },
        { placement_id: "phase1c-placement", fmx_session: "session-beta" },
      ],
    },
    registration: {
      schema_id: "fmx.runtime-extension",
      schema_version: 1,
      message_type: "registration",
      extension_id: "phase1c-extension",
      argv: [process.execPath, FIXTURE],
      protocol: { minimum: 1, maximum: 1 },
      required_capabilities: [...RUNTIME_EXTENSION_CAPABILITIES],
    },
    placementId: "phase1c-placement",
  }
}

class Counts {
  starts = 0
  turns = 0
  inlineCallbacks = 0
  lifecycleCallbacks = 0
  readonly errors: unknown[] = []
  readonly cleanup = { calls: 0, removeAttempts: 0 }
  readonly retirement = new HeldRetirement()
}

class CountingMultiplexer implements LifecycleRuntimeMultiplexer {
  constructor(private readonly manifest: AgentManifest, private readonly counts: Counts) {}

  async projectManagedAgent(claim: ManagedAgentClaim): Promise<ManifestEntry> {
    const { result, saved } = this.manifest.ensureClaim({
      identity: identityFor(claim.agentId),
      cwd: claim.cwd,
      fxPath: claim.fxPath,
      fxArgs: claim.fxArgs,
      workControl: claim.workControl,
      createdAt: claim.createdAt ?? 1,
    })
    await saved
    return result
  }

  async startManagedAgent(agentId: string, _invocation: ManagedAgentInvocation) {
    this.counts.starts++
    const entry = await this.manifest.markRunning(agentId)
    return { sessionName: entry.zmxName, paneId: entry.paneId }
  }

  async removeManagedAgentProjection(agentId: string): Promise<void> {
    await this.manifest.remove(agentId)
  }

  refreshManagedAgentProjection(_agentId: string): void {}
}

class CountingWorkControl {
  constructor(private readonly counts: Counts) {}

  async request() {
    this.counts.turns++
    return {
      turn_id: "7001",
      disposition: "queued" as const,
      snapshot: { active_turn_id: "7001", queue_paused: false, queue: [] },
    }
  }
}

class CountingProvider {
  private source: { launch_id: string; launch_digest: string; admission_key: string; request_id: string; directory: string } | null = null

  constructor(private readonly counts: Counts) {}

  async prepare(request: { launch_id: string; launch_digest: string; admission_key: string; request_id: string; directory: string }) {
    this.source = request
    return {
      schema_id: "fx.launch-admission-final" as const,
      schema_version: 1 as const,
      message_type: "launch_receipt" as const,
      request_id: request.request_id,
      receipt_id: "phase1c-provider-receipt",
      launch_id: request.launch_id,
      launch_digest: request.launch_digest,
      admission_key: request.admission_key,
      status: "accepted" as const,
    }
  }

  async build() {
    if (this.source === null) throw new Error("provider build without launch source")
    return {
      command: ["--context-limit", "128000"],
      cwd: this.source.directory,
      env: {
        FX_INTERNAL_LAUNCH_STATE_ROOT: "/Volumes/Scratch/phase1c-state",
        FX_INTERNAL_LAUNCH_ADMISSION_KEY: this.source.admission_key,
        FX_INTERNAL_LAUNCH_DIGEST: this.source.launch_digest,
        FX_INTERNAL_LAUNCH_ID: this.source.launch_id,
        FX_INTERNAL_LAUNCH_CONVERSATION_ID: "phase1c-conversation",
      },
      conversationId: "phase1c-conversation",
      mode: "initial" as const,
    }
  }

  async inspect() {
    return {
      launchReceipt: {} as never,
      decision: this.counts.turns === 0 ? null : admissionDecision(this.source!),
      finalReceipt: null,
      finalAcknowledgementId: null,
    }
  }

  async cancel(): Promise<never> { throw new Error("unexpected cancellation") }
  async recordFinal(): Promise<never> { throw new Error("final authority is not needed by the end request") }
  async acknowledgeFinal(): Promise<never> { throw new Error("final authority is not needed by the end request") }
}

class HeldRetirement {
  calls = 0
  private gate = Promise.withResolvers<void>()

  for(ledger: ExactRetirementLedger) {
    return {
      end: async (_ensure: unknown, request: EndRequest): Promise<EndReceipt> => {
        this.calls++
        await ledger.markKillIntent(request.ensure_id, fixedNow().toISOString())
        await this.gate.promise
        const partial = {
          schema_id: request.schema_id,
          schema_version: request.schema_version,
          message_type: "end_receipt" as const,
          request_id: request.request_id,
          receipt_id: "phase1c-counted-end-receipt",
          receipt_digest: "0".repeat(64),
          workplace_instance_id: request.workplace_instance_id,
          fmx_session: request.fmx_session,
          ensure_id: request.ensure_id,
          ensure_digest: request.ensure_digest,
          launch_id: request.launch_id,
          launch_digest: request.launch_digest,
          worktree_id: request.worktree_id,
          agent_id: request.agent_id,
          conversation_id: request.conversation_id,
          end_id: request.end_id,
          end_digest: request.end_digest,
          proof: {
            kind: "ended" as const,
            companion_session: identityFor(request.agent_id).zmxName,
            pane_id: identityFor(request.agent_id).paneId,
            exit_code: 0,
            signal: 0,
            reason: "requested" as const,
            observed_at: fixedNow().toISOString(),
          },
        }
        const receipt = { ...partial, receipt_digest: deriveLifecycleReceiptDigest(partial) }
        return (await ledger.retainEndReceipt(receipt)).end!.receipt!
      },
      acknowledge: (acknowledgement: Parameters<ExactRetirementLedger["acknowledge"]>[0]) =>
        ledger.acknowledge(acknowledgement),
    }
  }

  release(): void { this.gate.resolve() }
}

class CountingCleanup {
  constructor(
    private readonly inner: GitSafeWorktreeCleanup,
    private readonly counts: Counts,
  ) {}

  async cleanup(...args: Parameters<GitSafeWorktreeCleanup["cleanup"]>) {
    this.counts.cleanup.calls++
    return this.inner.cleanup(...args)
  }
}

function admissionDecision(source: NonNullable<CountingProvider["source"]>): FxAdmissionDecision {
  const partial = {
    schema_id: "fx.launch-admission-final" as const,
    schema_version: 1 as const,
    message_type: "admission_decision" as const,
    receipt_id: "phase1c-provider-admission",
    receipt_digest: "",
    launch_id: source.launch_id,
    launch_digest: source.launch_digest,
    admission_key: source.admission_key,
    decision: { kind: "admitted" as const, turn_id: "7001", disposition: "queued" as const },
  }
  return { ...partial, receipt_digest: deriveFxAdmissionDecisionDigest(partial) }
}

async function initializeRepository(repository: string): Promise<string> {
  await mkdir(repository, { recursive: true, mode: 0o700 })
  await git(repository, ["init", "--initial-branch=main"])
  await git(repository, ["config", "user.name", "Phase 1C Test"])
  await git(repository, ["config", "user.email", "phase1c@example.test"])
  await writeFile(join(repository, "README.md"), "phase1c\n", { mode: 0o600 })
  await git(repository, ["add", "README.md"])
  await git(repository, ["commit", "-m", "initial"])
  return (await git(repository, ["rev-parse", "HEAD"])).trim()
}

async function exactWorktreeCount(repository: string, directory: string): Promise<number> {
  const output = await git(repository, ["worktree", "list", "--porcelain"])
  return output.split("\n").filter((line) => line === `worktree ${directory}`).length
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}

async function receivedEnsureReceipts(logPath: string): Promise<Array<{ receipt_id: string; receipt_digest: string }>> {
  return (await fixtureLogMessages(logPath, "inbound", "ensure_receipt"))
    .map(({ receipt_id, receipt_digest }) => ({ receipt_id, receipt_digest })) as Array<{
      receipt_id: string
      receipt_digest: string
    }>
}

async function fixtureLogMessages(
  logPath: string,
  direction: "inbound" | "outbound",
  messageType: string,
): Promise<Array<Record<string, string>>> {
  let text: string
  try {
    text = await readFile(logPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>)
    .filter((entry) => entry.direction === direction && entry.message_type === messageType)
}

async function fixtureStateFor(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"))
}

async function publishFixtureReceipt(
  extension: RuntimeExtensionSupervisor,
  receipt: Parameters<RuntimeExtensionSupervisor["publishLifecycleReceipt"]>[0],
  tolerateCrash = false,
): Promise<void> {
  // The fixture's frozen link accepts only the terminal authoritative ensure
  // receipt. Runtime still retains and replays every earlier progress receipt.
  if (receipt.message_type === "ensure_receipt" && receipt.status !== "complete") return
  try {
    await extension.publishLifecycleReceipt(receipt)
  } catch (error) {
    if (!tolerateCrash || extension.state !== "degraded") throw error
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp("/Volumes/Scratch/fmx-phase1c-restart-")
  temporaryDirectories.push(directory)
  return directory
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Phase 1C acceptance state")
    await Bun.sleep(10)
  }
}

function fixedNow(): Date {
  return new Date("2026-08-31T20:00:00.000Z")
}
