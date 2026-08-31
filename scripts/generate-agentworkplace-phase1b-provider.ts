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
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  AGENT_DEFAULTS_SCHEMA_ID,
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_CAPABILITIES,
  RUNTIME_EXTENSION_SCHEMA_ID,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  runtimeExtensionMessageSchema,
} from "../src/agentworkplace-contracts.ts"
import { ContractFrameDecoder, type JsonValue } from "../src/contract-codec.ts"
import { verifyAgentWorkplaceContracts } from "./check-agentworkplace-contracts.ts"
import {
  assertRepositorySnapshotStable,
  captureCleanRepositorySnapshot,
  environmentWithoutGitOverrides,
  isWithin,
  type RepositorySnapshot,
} from "./provider-repository-snapshot.ts"

const REPOSITORY_ROOT = resolve(import.meta.dir, "..")
const PHASE1_AUTHORITY_COMMIT = "8bad6eec880586747bc67eab496ce76c92742c14"
export const PHASE1B_PRODUCT_COMMIT = "7c6f3f7df55c4366ba0d6b70be966973445322ce"
export const PHASE1B_PRODUCT_TREE = "31b471da3550de6506de339864f2537d4c18f0c8"
export const PHASE1B_PRODUCT_PARENTS = [
  "53e5bc20531353325a96dcf3c2f2a2fc3b3ffdb6",
  "10b7c878615814b07ab7ae3955786a501a188a57",
] as const
const PHASE1B_FX_COMMIT = "beadc01a82891ef22bfa6cd3bc88f12edcec9176"
const PHASE1B_FX_SHA256 = "sha256:62eeb7e014153845f474928b84ea03a95a06fd3cc7cd2f7a06096265ce8ea9b0"
const PHASE1B_COMPANION_BUILD = "0.7.0+fmx.2ffb1c1e425f"
const PHASE1B_COMPANION_SHA256 = "sha256:8eee5c7f0f59e0d167a61d4a2c05b67b666548c08536ababf18f3ae448ee13a6"
const COMMIT = /^[0-9a-f]{40}$/u
const TREE = /^[0-9a-f]{40}$/u
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const EXECUTABLE_MODE = 0o700
const PROVIDER_MANIFEST_PATH = "phase1b-provider.json"
const GENERATION_EVIDENCE_PATH = "generation-evidence.json"
const GATE_LOG_PATH = "local-gate.log"
const FIXTURE_BUNDLE_PATH = "artifacts/runtime-extension-fixture.js"
const SOURCE_ROOT_PREFIX = "fmx-phase1b-provider-source-"
export const PHASE1B_MATERIALIZED_REPOSITORY_NAME = "fmx"
const decoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

const usage = `Usage: scripts/generate-agentworkplace-phase1b-provider.ts \\
  --output <existing-empty-directory> \\
  --product-commit <40-hex-commit> \\
  --product-tree <40-hex-tree>

Runs the canonical fmx gate from a private materialization of the exact Phase
1B product commit, bundles a standalone Runtime-extension fixture, and writes
one source-independent fmx.phase1b-provider v1 package. The invoking provider
generator tree and the product tree must both be clean and committed. Phase 0
provider files and claims are not read, changed, parameterized, or reused.
`

type SkipDefinition = {
  readonly description: string
  readonly reason: string
  readonly scenario_id: string
}

const PTY_SKIP_REASON =
  "the general suite skips this PTY scenario; the canonical local gate reruns all four PTY cases against the installed fmx"
const COMPANION_SKIP_REASON =
  "this real-Companion scenario is environment-gated in the canonical general suite"

export const PHASE1B_EXPECTED_SKIPS: readonly SkipDefinition[] = [
  {
    description: "multiple Clients share one Runtime and hand off sizing ownership",
    reason: PTY_SKIP_REASON,
    scenario_id: "tests.multiplexer-e2e.multiple-clients",
  },
  {
    description: "named fmx Runtimes are independent and same-name Clients join",
    reason: PTY_SKIP_REASON,
    scenario_id: "tests.multiplexer-e2e.named-sessions",
  },
  {
    description: "associated Runtime extension survives zero Clients, stale config, and one Runtime restart",
    reason: PTY_SKIP_REASON,
    scenario_id: "tests.multiplexer-e2e.associated-runtime-liveness",
  },
  {
    description: "either uniform association member can cold-start before its absent peer",
    reason: PTY_SKIP_REASON,
    scenario_id: "tests.multiplexer-e2e.uniform-member-start-order",
  },
  {
    description: "start creates a labelled session, attaches with a restore, and writes through",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.start",
  },
  {
    description: "a hinted socket revalidates its live daemon's ownership before attach",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.hinted-ownership",
  },
  {
    description: "attach replays the screen onto a reset, and the child survives every detach",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.restore-survives-detach",
  },
  {
    description: "an exit is exact, final output comes first, and the record is consumed",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.exact-exit",
  },
  {
    description: "attaching to an ended Agent says so, with its status",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.ended-agent",
  },
  {
    description: "a daemon that vanishes is a lost transport, never an exit",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.vanished-daemon",
  },
  {
    description: "the child's environment is the one given, with nothing of the Companion's",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.child-environment",
  },
  {
    description: "live: create, list with labels, inspect, kill, settle, forget",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.zmx-command.lifecycle",
  },
  {
    description: "live: a command that cannot start reports ExecFailed and leaves an exit record, not a socket",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.zmx-command.exec-failure",
  },
  {
    description: "a Bun client attaches, drives, detaches from, and reattaches to a zmx-owned child",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.attach-drive-reattach",
  },
  {
    description: "a child killed by a signal reports that signal, not an exit code",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.signal-exit",
  },
  {
    description: "a negotiated client sees no live output before its attach",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.attach-boundary",
  },
  {
    description: "the last connected or interacting terminal owns size, with failover on disconnect",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.sizing-owner",
  },
  {
    description: "exit-on-last-client arms on Init and ignores non-terminal probes",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.exit-on-last-client",
  },
  {
    description: "a client the daemon cannot serve is told the daemon's range and closed",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.protocol-refusal",
  },
  {
    description: "create answers on readiness, with labels the session is born with; exit records agree with Exit",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.create-readiness-exit",
  },
]

export const PHASE1B_PTY_SCENARIOS = [
  "multiple Clients share one Runtime and hand off sizing ownership",
  "named fmx Runtimes are independent and same-name Clients join",
  "associated Runtime extension survives zero Clients, stale config, and one Runtime restart",
  "either uniform association member can cold-start before its absent peer",
] as const

export const PHASE1B_REQUIRED_PASS_SCENARIOS = [
  "resolves exact two-member Workplace association and independent Session defaults",
  "rejects invalid association and Agent-default contracts instead of falling back to plain fmx",
  "cold-start resolution freezes exact association, registration, placement, and defaults",
  "resolves only the explicitly named manifest below the fmx configuration root",
  "completes exact readiness and serves every extension-to-Runtime request direction",
  "coalesces one pending level and reasserts once after a stale racing snapshot",
  "restarts one post-readiness child generation, then degrades without a crash loop",
  "publishes authoritative member snapshots and presents through modal-safe selection",
  "keeps one recovery card selectable in the Tray without inventing an Agent or MCP action",
  "publishes the complete approved MCP surface and returns structured results",
  ...PHASE1B_PTY_SCENARIOS,
] as const

export const PHASE1B_EVIDENCE_PATHS = [
  "CONTEXT.md",
  "fx.json",
  "companion.json",
  "package.json",
  "src/agent-picker.ts",
  "src/agentworkplace-contracts.ts",
  "src/config.ts",
  "src/contract-codec.ts",
  "src/fx-environment.ts",
  "src/index.ts",
  "src/multiplexer.ts",
  "src/recovery-card.ts",
  "src/runtime-extension-host.ts",
  "src/runtime-extension-registration.ts",
  "src/runtime-extension.ts",
  "src/runtime-session.ts",
  "src/runtime-startup.ts",
  "src/session-list.ts",
  "tests/agentworkplace-contract-adversarial.test.ts",
  "tests/agentworkplace-contracts.test.ts",
  "tests/config.test.ts",
  "tests/fixtures/fake-fx.ts",
  "tests/fixtures/runtime-extension.ts",
  "tests/fx-environment.test.ts",
  "tests/mcp-server.test.ts",
  "tests/multiplexer-control.test.ts",
  "tests/multiplexer-recovery-card.test.ts",
  "tests/multiplexer-transport.test.ts",
  "tests/multiplexer.e2e.test.ts",
  "tests/recovery-card.test.ts",
  "tests/runtime-extension-fixture.test.ts",
  "tests/runtime-extension-host.test.ts",
  "tests/runtime-extension-registration.test.ts",
  "tests/runtime-extension-supervisor-child.ts",
  "tests/runtime-extension-supervisor.test.ts",
  "tests/runtime-session.test.ts",
  "tests/runtime-startup.test.ts",
] as const

export const PHASE1B_TEST_PATHS = PHASE1B_EVIDENCE_PATHS.filter(
  (path) => path.startsWith("tests/") && path.endsWith(".test.ts"),
)

export const PHASE1B_FEATURE_INVENTORY = [
  {
    id: "uniform_session_association",
    contract: "exactly two uniform named fmx Sessions; either starts first and neither starts its peer",
    tests: ["tests/config.test.ts", "tests/runtime-startup.test.ts", "tests/multiplexer.e2e.test.ts"],
  },
  {
    id: "independent_agent_defaults",
    contract: "exact Session selector with optional state_dir, model, and effort beneath explicit values",
    tests: ["tests/config.test.ts", "tests/multiplexer-control.test.ts", "tests/multiplexer.e2e.test.ts"],
  },
  {
    id: "manifest_readiness_supervision",
    contract: "explicit manifest, exact readiness, bounded framed stdio, diagnostics, restart, and reap",
    tests: ["tests/runtime-extension-registration.test.ts", "tests/runtime-extension-supervisor.test.ts"],
  },
  {
    id: "member_snapshot_invalidation",
    contract: "level-triggered revision invalidation followed by authoritative snapshot pull",
    tests: ["tests/runtime-extension-supervisor.test.ts", "tests/multiplexer-control.test.ts"],
  },
  {
    id: "modal_safe_present_focus",
    contract: "role-neutral presentation through existing modal and selection safety",
    tests: ["tests/runtime-extension-host.test.ts", "tests/multiplexer-control.test.ts", "tests/multiplexer.e2e.test.ts"],
  },
  {
    id: "bounded_recovery_card",
    contract: "one role-neutral card and one opaque human action with no MCP equivalent",
    tests: ["tests/recovery-card.test.ts", "tests/multiplexer-recovery-card.test.ts", "tests/multiplexer.e2e.test.ts"],
  },
  {
    id: "associated_zero_client_liveness",
    contract: "associated Runtime survives zero Clients; a crashed Runtime waits for an ordinary next start",
    tests: ["tests/runtime-session.test.ts", "tests/multiplexer.e2e.test.ts"],
  },
  {
    id: "unassociated_regression",
    contract: "plain fmx still ends its Runtime at final Client departure and exposes exactly eleven MCP tools",
    tests: ["tests/runtime-session.test.ts", "tests/mcp-server.test.ts", "tests/multiplexer.e2e.test.ts"],
  },
] as const

const PUBLIC_MCP_TOOLS = [
  "get_orientation",
  "create_agent",
  "focus_agent",
  "configure_tray",
  "get_agent_work",
  "queue_agent_work",
  "steer_agent",
  "interrupt_agent",
  "update_queued_work",
  "delete_queued_work",
  "resume_agent_queue",
] as const

type ParsedArguments = {
  readonly output: string
  readonly productCommit: string
  readonly productTree: string
}

export type Phase1bGateReceipt = {
  readonly general: {
    readonly expectations: number
    readonly fail: number
    readonly files: number
    readonly pass: number
    readonly skip: number
    readonly tests: number
  }
  readonly pty: {
    readonly expectations: number
    readonly fail: number
    readonly files: number
    readonly pass: number
    readonly skip: number
    readonly tests: number
  }
  readonly actualSkips: readonly SkipDefinition[]
}

type IntendedFile = {
  readonly bytes: Uint8Array
  readonly mode: typeof FILE_MODE | typeof EXECUTABLE_MODE
  readonly path: string
}

type FileEvidence = {
  readonly bytes: number
  readonly digest: string
  readonly mode: "0600" | "0700"
  readonly path: string
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(usage)
    process.exit(0)
  }
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!["--output", "--product-commit", "--product-tree"].includes(flag ?? "")) {
      throw new Error(`unknown argument: ${flag ?? ""}`)
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`)
    }
    if (values.has(flag!)) throw new Error(`${flag} may be provided only once`)
    values.set(flag!, value)
  }
  const output = values.get("--output")
  const productCommit = values.get("--product-commit")
  const productTree = values.get("--product-tree")
  if (output === undefined) throw new Error("--output is required")
  if (productCommit === undefined) throw new Error("--product-commit is required")
  if (productTree === undefined) throw new Error("--product-tree is required")
  if (!COMMIT.test(productCommit)) throw new Error("--product-commit must be one full lowercase commit")
  if (!TREE.test(productTree)) throw new Error("--product-tree must be one full lowercase tree")
  if (productCommit !== PHASE1B_PRODUCT_COMMIT) {
    throw new Error(`--product-commit must be the frozen Phase 1B product commit ${PHASE1B_PRODUCT_COMMIT}`)
  }
  if (productTree !== PHASE1B_PRODUCT_TREE) {
    throw new Error(`--product-tree must be the frozen Phase 1B product tree ${PHASE1B_PRODUCT_TREE}`)
  }
  return { output: resolve(output), productCommit, productTree }
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key] as JsonValue)]))
}

export function canonicalPhase1bProviderJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function evidence(file: IntendedFile): FileEvidence {
  return {
    bytes: file.bytes.byteLength,
    digest: sha256(file.bytes),
    mode: file.mode === EXECUTABLE_MODE ? "0700" : "0600",
    path: file.path,
  }
}

function summaryMatches(log: string): readonly RegExpMatchArray[] {
  return [...log.matchAll(
    /^\s*(\d+) pass\n(?:\s*(\d+) skip\n)?\s*(\d+) fail\n\s*(\d+) expect\(\) calls\nRan (\d+) tests across (\d+) files?\./gmu,
  )]
}

function summary(match: RegExpMatchArray) {
  return {
    pass: Number(match[1]),
    skip: Number(match[2] ?? "0"),
    fail: Number(match[3]),
    expectations: Number(match[4]),
    tests: Number(match[5]),
    files: Number(match[6]),
  }
}

export function parsePhase1bGateLog(log: string): Phase1bGateReceipt {
  const matches = summaryMatches(log)
  if (matches.length !== 2) throw new Error(`expected two Bun summaries, received ${matches.length}`)
  const general = summary(matches[0]!)
  const pty = summary(matches[1]!)
  if (JSON.stringify(general) !== JSON.stringify({
    pass: 473,
    skip: 20,
    fail: 0,
    expectations: 2954,
    tests: 493,
    files: 64,
  })) {
    throw new Error(`canonical general gate counts changed: ${JSON.stringify(general)}`)
  }
  if (JSON.stringify(pty) !== JSON.stringify({
    pass: 4,
    skip: 0,
    fail: 0,
    expectations: 32,
    tests: 4,
    files: 1,
  })) {
    throw new Error(`canonical PTY gate counts changed: ${JSON.stringify(pty)}`)
  }
  const observedDescriptions = new Set(
    [...log.matchAll(/^\(skip\) (.+)$/gmu)].map((match) => match[1]!.trim()),
  )
  const expectedDescriptions = new Set(PHASE1B_EXPECTED_SKIPS.map(({ description }) => description))
  if (
    observedDescriptions.size !== expectedDescriptions.size ||
    [...observedDescriptions].some((description) => !expectedDescriptions.has(description))
  ) {
    throw new Error("canonical general gate skip inventory changed")
  }
  const passLines = [...log.matchAll(/^\(pass\) (.+?)(?: \[[^\n]+\])?$/gmu)].map((match) => match[1]!)
  for (const required of PHASE1B_REQUIRED_PASS_SCENARIOS) {
    if (!passLines.some((line) => line === required || line.endsWith(` > ${required}`))) {
      throw new Error(`canonical gate omitted required Phase 1B scenario: ${required}`)
    }
  }
  return {
    general,
    pty,
    actualSkips: PHASE1B_EXPECTED_SKIPS.map((entry) => ({ ...entry })),
  }
}

function git(repository: string, args: readonly string[], accepted = [0]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", ...args],
    cwd: repository,
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!accepted.includes(result.exitCode)) {
    throw new Error(`git ${args.join(" ")} failed: ${decoder.decode(result.stderr).trim()}`)
  }
  return decoder.decode(result.stdout).trim()
}

function requireProductFacts(
  provider: RepositorySnapshot,
  productCommit: string,
  productTree: string,
): readonly string[] {
  const actualTree = git(provider.repositoryRoot, ["rev-parse", "--verify", `${productCommit}^{tree}`])
  if (actualTree !== productTree) throw new Error("product commit does not name --product-tree")
  const ancestor = Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", "merge-base", "--is-ancestor", productCommit, provider.headSha],
    cwd: provider.repositoryRoot,
    env: environmentWithoutGitOverrides(),
    stdout: "ignore",
    stderr: "pipe",
  })
  if (ancestor.exitCode !== 0) throw new Error("product commit is not an ancestor of the provider generator")
  const parents = git(provider.repositoryRoot, ["show", "-s", "--format=%P", productCommit]).split(" ")
    .filter(Boolean)
  if (JSON.stringify(parents) !== JSON.stringify(PHASE1B_PRODUCT_PARENTS)) {
    throw new Error("Phase 1B product commit does not retain its two exact integration parents")
  }
  return parents
}

async function validateOutput(path: string, provider: RepositorySnapshot): Promise<string> {
  const facts = await lstat(path)
  if (facts.isSymbolicLink() || !facts.isDirectory()) throw new Error("output must be an existing real directory")
  if ((facts.mode & 0o077) !== 0) throw new Error("output directory must not be accessible to group or other")
  if ((await readdir(path)).length !== 0) throw new Error("output directory must be empty")
  const physical = await realpath(path)
  if (isWithin(provider.commonGitDirectory, physical)) {
    throw new Error("output must be outside fmx's common Git directory")
  }
  if (provider.worktrees.some((worktree) => isWithin(worktree, physical))) {
    throw new Error("output must be outside every registered fmx Worktree")
  }
  await chmod(physical, DIRECTORY_MODE)
  return physical
}

async function materializeProduct(
  provider: RepositorySnapshot,
  productCommit: string,
  productTree: string,
  destination: string,
): Promise<RepositorySnapshot> {
  await mkdir(destination, { mode: DIRECTORY_MODE })
  git(destination, ["init", "--quiet"])
  git(destination, ["fetch", "--quiet", "--no-tags", "--depth=1", provider.commonGitDirectory, productCommit])
  git(destination, ["checkout", "--quiet", "--detach", "FETCH_HEAD"])
  const product = await captureCleanRepositorySnapshot(destination)
  if (product.headSha !== productCommit || product.headTree !== productTree) {
    throw new Error("private product materialization has the wrong commit or tree")
  }
  return product
}

async function runCanonicalGate(productRoot: string, logPath: string) {
  const log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE)
  let exitStatus: number
  try {
    const child = Bun.spawn(["./scripts/local-gate.sh"], {
      cwd: productRoot,
      env: environmentWithoutGitOverrides(),
      stdout: log.fd,
      stderr: log.fd,
    })
    exitStatus = await child.exited
    await log.sync()
  } finally {
    await log.close()
  }
  await chmod(logPath, FILE_MODE)
  const bytes = new Uint8Array(await readFile(logPath))
  const text = decoder.decode(bytes)
  process.stdout.write(bytes)
  if (exitStatus !== 0) throw new Error(`canonical Phase 1B gate exited ${exitStatus}`)
  return { bytes, receipt: parsePhase1bGateLog(text) }
}

export async function buildFixture(productRoot: string, output: string): Promise<Uint8Array> {
  const source = join(productRoot, "tests/fixtures/runtime-extension.ts")
  const result = Bun.spawnSync({
    cmd: ["bun", "build", source, "--target=bun", "--outfile", output],
    cwd: productRoot,
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(`could not bundle the Runtime-extension fixture: ${decoder.decode(result.stderr).trim()}`)
  }
  await chmod(output, EXECUTABLE_MODE)
  return new Uint8Array(await readFile(output))
}

export async function verifyBundledFixture(path: string): Promise<void> {
  const child = Bun.spawn([process.execPath, path], {
    env: environmentWithoutGitOverrides(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const initialize = {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "initialize",
    request_id: "phase1b-provider-initialize",
    workplace_instance_id: "fixture-workplace",
    extension_id: "fixture-extension",
    configuration_id: "fixture-configuration",
    placement_id: "placement-beta",
    fmx_session: "session-beta",
    protocol_version: AGENTWORKPLACE_CONTRACT_VERSION,
  } as const
  const stdout = new Response(child.stdout).arrayBuffer()
  const stderr = new Response(child.stderr).text()
  child.stdin.write(encodeAgentWorkplaceFrame(initialize))
  child.stdin.end()
  const [output, diagnostic, status] = await Promise.all([stdout, stderr, child.exited])
  if (status !== 0 || diagnostic.length !== 0) {
    throw new Error(`bundled fixture smoke failed with status ${status}: ${diagnostic}`)
  }
  const frameDecoder = new ContractFrameDecoder()
  const payloads = frameDecoder.push(new Uint8Array(output))
  frameDecoder.finish()
  if (payloads.length !== 1) throw new Error("bundled fixture did not return one readiness frame")
  const parsed = runtimeExtensionMessageSchema.safeParse(decodeAgentWorkplacePayload(payloads[0]!))
  if (
    !parsed.success ||
    parsed.data.message_type !== "ready" ||
    !("request_id" in parsed.data) ||
    !("fmx_session" in parsed.data) ||
    parsed.data.request_id !== initialize.request_id ||
    parsed.data.fmx_session !== initialize.fmx_session
  ) {
    throw new Error("bundled fixture did not return exact readiness")
  }
}

async function restoreInvokingBunLink(provider: RepositorySnapshot): Promise<void> {
  const linked = Bun.spawnSync({
    cmd: ["bun", "link"],
    cwd: provider.repositoryRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (linked.exitCode !== 0) {
    throw new Error(`could not restore the invoking fmx link: ${decoder.decode(linked.stderr).trim()}`)
  }
  const binResult = Bun.spawnSync({ cmd: ["bun", "pm", "bin", "-g"], stdout: "pipe", stderr: "pipe" })
  if (binResult.exitCode !== 0) throw new Error("could not locate Bun's global bin after provider gate")
  const bin = decoder.decode(binResult.stdout).trim()
  const packageRoot = resolve(bin, "../install/global/node_modules/fmx")
  const physical = await realpath(packageRoot)
  if (physical !== provider.repositoryRoot) {
    throw new Error(`restored Bun package link points at ${physical}, not the invoking provider Worktree`)
  }
}

async function readProductFiles(productRoot: string): Promise<IntendedFile[]> {
  const files: IntendedFile[] = []
  for (const sourcePath of PHASE1B_EVIDENCE_PATHS) {
    files.push({
      bytes: new Uint8Array(await readFile(join(productRoot, sourcePath))),
      mode: FILE_MODE,
      path: join("artifacts/source", sourcePath),
    })
  }
  for (const fixture of ["manifest.json", "runtime-extension.jsonl", "agent-defaults.jsonl"] as const) {
    files.push({
      bytes: new Uint8Array(await readFile(join(productRoot, "contracts/agentworkplace/v1", fixture))),
      mode: FILE_MODE,
      path: join("artifacts/contracts/agentworkplace/v1", fixture),
    })
  }
  return files
}

async function writeExclusive(root: string, file: IntendedFile): Promise<void> {
  const path = resolve(root, file.path)
  if (!isWithin(root, path) || path === root) throw new Error(`provider output escapes root: ${file.path}`)
  await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE })
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, file.mode)
  try {
    await handle.writeFile(file.bytes)
    await handle.chmod(file.mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function sourceEvidence(files: readonly IntendedFile[]): readonly FileEvidence[] {
  return files.map(evidence).sort((left, right) => left.path.localeCompare(right.path))
}

export function buildPhase1bProviderManifest(input: {
  readonly artifacts: readonly FileEvidence[]
  readonly fixtureDigest: string
  readonly gateLog: FileEvidence
  readonly gate: Phase1bGateReceipt
  readonly native: {
    readonly companionBuild: string
    readonly companionSha256: string
    readonly fmxVersion: string
    readonly fxCommit: string
    readonly fxSha256: string
    readonly fxnk: string
  }
  readonly product: { readonly commit: string; readonly parents: readonly string[]; readonly tree: string }
  readonly provider: { readonly commit: string; readonly tree: string }
}): JsonValue {
  return {
    schema_id: "fmx.phase1b-provider",
    schema_version: 1,
    package: { name: "fmx.phase1b-provider", version: "1" },
    authority: {
      plan: "AgentWorkplace Plan Revision 1",
      phase: "1b",
      wiki_commit: PHASE1_AUTHORITY_COMMIT,
    },
    product_repository: { name: "fmx", ...input.product, parents: [...input.product.parents] },
    provider_repository: { name: "fmx", ...input.provider },
    protocol: {
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      version: "1",
      capabilities: [...RUNTIME_EXTENSION_CAPABILITIES],
      owner_manifest_digest: input.artifacts.find(({ path }) => path.endsWith("/manifest.json"))!.digest,
      runtime_extension_fixture_digest: input.artifacts.find(({ path }) => path.endsWith("/runtime-extension.jsonl"))!.digest,
      agent_defaults_fixture_digest: input.artifacts.find(({ path }) => path.endsWith("/agent-defaults.jsonl"))!.digest,
    },
    fixture_extension: {
      artifact: FIXTURE_BUNDLE_PATH,
      digest: input.fixtureDigest,
      invocation: ["<absolute-bun>", "<absolute-provider-root>/artifacts/runtime-extension-fixture.js"],
      protocol_only_stdio: true,
      smoke: "exact initialize/ready passed",
    },
    features: PHASE1B_FEATURE_INVENTORY as unknown as JsonValue,
    public_mcp: { tool_count: PUBLIC_MCP_TOOLS.length, tools: [...PUBLIC_MCP_TOOLS] },
    tests: {
      command: ["./scripts/local-gate.sh"],
      exit_status: 0,
      general: input.gate.general,
      pty: input.gate.pty,
      required_pass_scenarios: [...PHASE1B_REQUIRED_PASS_SCENARIOS],
      pty_scenarios: [...PHASE1B_PTY_SCENARIOS],
      files: [...PHASE1B_TEST_PATHS],
      gate_log: input.gateLog,
      skips: {
        expected: PHASE1B_EXPECTED_SKIPS,
        actual: input.gate.actualSkips,
      },
    },
    installation: input.native,
    artifacts: input.artifacts as unknown as JsonValue,
    review: {
      rounds: 1,
      verdict: "all concrete findings corrected; no blocking finding remains",
    },
  } as unknown as JsonValue
}

async function installedNativeEvidence(productRoot: string) {
  const packageJson = JSON.parse(await readFile(join(productRoot, "package.json"), "utf8")) as { version: string }
  const fx = JSON.parse(await readFile(join(productRoot, "fx.json"), "utf8")) as { commit: string; fxnk: string }
  const companion = JSON.parse(await readFile(join(productRoot, "companion.json"), "utf8")) as { build: string }
  const installDirectory = process.env.FMX_INSTALL_BIN_DIR ?? join(process.env.HOME ?? "", ".local/bin")
  const fxBytes = new Uint8Array(await readFile(join(installDirectory, "fmx-fx")))
  const companionBytes = new Uint8Array(await readFile(join(installDirectory, "fmx-zmx")))
  const evidence = {
    companionBuild: companion.build,
    companionSha256: sha256(companionBytes),
    fmxVersion: packageJson.version,
    fxCommit: fx.commit,
    fxSha256: sha256(fxBytes),
    fxnk: fx.fxnk,
  }
  if (
    evidence.fmxVersion !== "0.3.1" ||
    evidence.fxCommit !== PHASE1B_FX_COMMIT ||
    evidence.fxnk !== "0.5.0" ||
    evidence.fxSha256 !== PHASE1B_FX_SHA256 ||
    evidence.companionBuild !== PHASE1B_COMPANION_BUILD ||
    evidence.companionSha256 !== PHASE1B_COMPANION_SHA256
  ) {
    throw new Error(`installed native identity changed: ${JSON.stringify(evidence)}`)
  }
  return evidence
}

async function removePrivateRoot(path: string, device: bigint, inode: bigint): Promise<void> {
  const facts = await lstat(path, { bigint: true })
  if (facts.isSymbolicLink() || !facts.isDirectory() || facts.dev !== device || facts.ino !== inode) {
    throw new Error("refusing to remove a replaced provider source root")
  }
  await rm(path, { recursive: true })
}

async function main(): Promise<void> {
  const args = parseArguments(Bun.argv.slice(2))
  const provider = await captureCleanRepositorySnapshot(REPOSITORY_ROOT)
  const productParents = requireProductFacts(provider, args.productCommit, args.productTree)
  const output = await validateOutput(args.output, provider)
  const sourceRoot = await mkdtemp(join(tmpdir(), SOURCE_ROOT_PREFIX))
  await chmod(sourceRoot, DIRECTORY_MODE)
  const sourceFacts = await lstat(sourceRoot, { bigint: true })
  const productRoot = join(sourceRoot, PHASE1B_MATERIALIZED_REPOSITORY_NAME)
  let primaryError: unknown
  try {
    const product = await materializeProduct(provider, args.productCommit, args.productTree, productRoot)
    process.stdout.write(`fmx Phase 1B provider: gating exact product ${args.productCommit}\n`)
    const gate = await runCanonicalGate(productRoot, join(sourceRoot, GATE_LOG_PATH))
    await assertRepositorySnapshotStable(productRoot, product)
    const verification = await verifyAgentWorkplaceContracts(join(productRoot, "contracts/agentworkplace/v1"))
    const fixture = verification.fixtures.find(({ schema_id }) => schema_id === RUNTIME_EXTENSION_SCHEMA_ID)
    const agentDefaults = verification.fixtures.find(({ schema_id }) => schema_id === AGENT_DEFAULTS_SCHEMA_ID)
    if (verification.manifest_sha256 !== "e02dca149a4b1875eb9dedc1f07fc21cb91d106d0844eacb1806960531e6e17f") {
      throw new Error("canonical owner manifest digest changed")
    }
    if (fixture?.sha256 !== "0ae7816c752eadf31dfa47651f0e37d64d72d272624046903b9f3519d982b88d") {
      throw new Error("canonical Runtime-extension fixture digest changed")
    }
    if (agentDefaults?.sha256 !== "d9f9858ad5a8593bdb7f8833d23da043b7b364673baaed32d2f24f1db6910265") {
      throw new Error("canonical Agent-defaults fixture digest changed")
    }
    const fixturePath = join(sourceRoot, "runtime-extension-fixture.js")
    const fixtureBytes = await buildFixture(productRoot, fixturePath)
    await verifyBundledFixture(fixturePath)
    const artifacts = await readProductFiles(productRoot)
    artifacts.push({ bytes: fixtureBytes, mode: EXECUTABLE_MODE, path: FIXTURE_BUNDLE_PATH })
    const gateLog: IntendedFile = { bytes: gate.bytes, mode: FILE_MODE, path: GATE_LOG_PATH }
    const native = await installedNativeEvidence(productRoot)
    await restoreInvokingBunLink(provider)
    await assertRepositorySnapshotStable(REPOSITORY_ROOT, provider)
    const artifactEvidence = sourceEvidence(artifacts)
    const manifestValue = buildPhase1bProviderManifest({
      artifacts: artifactEvidence,
      fixtureDigest: sha256(fixtureBytes),
      gateLog: evidence(gateLog),
      gate: gate.receipt,
      native,
      product: { commit: args.productCommit, parents: productParents, tree: args.productTree },
      provider: { commit: provider.headSha, tree: provider.headTree },
    })
    const manifest: IntendedFile = {
      bytes: encoder.encode(canonicalPhase1bProviderJson(manifestValue)),
      mode: FILE_MODE,
      path: PROVIDER_MANIFEST_PATH,
    }
    const generatorBytes = new Uint8Array(await readFile(join(REPOSITORY_ROOT, "scripts/generate-agentworkplace-phase1b-provider.ts")))
    const preEvidence = [...artifacts, gateLog, manifest]
    const generationEvidence = {
      schema_id: "fmx.phase1b-provider-generation-evidence",
      schema_version: 1,
      accepted: true,
      package: { name: "fmx.phase1b-provider", version: "1" },
      authority_commit: PHASE1_AUTHORITY_COMMIT,
      product_repository: { commit: args.productCommit, tree: args.productTree },
      provider_repository: { commit: provider.headSha, tree: provider.headTree },
      generator: {
        path: "scripts/generate-agentworkplace-phase1b-provider.ts",
        digest: sha256(generatorBytes),
      },
      source_materialization: "private detached fetch of the exact product commit",
      canonical_gate: { exit_status: 0, log: evidence(gateLog), ...gate.receipt },
      bundled_fixture: { digest: sha256(fixtureBytes), smoke: "passed" },
      output_inventory: sourceEvidence(preEvidence),
    }
    const evidenceFile: IntendedFile = {
      bytes: encoder.encode(canonicalPhase1bProviderJson(generationEvidence as unknown as JsonValue)),
      mode: FILE_MODE,
      path: GENERATION_EVIDENCE_PATH,
    }
    for (const file of [...artifacts, gateLog, manifest, evidenceFile]) await writeExclusive(output, file)
    const allEvidence = sourceEvidence([...artifacts, gateLog, manifest, evidenceFile])
    process.stdout.write(`${JSON.stringify({
      accepted: true,
      bundle: output,
      file_count: allEvidence.length,
      generation_evidence: join(output, GENERATION_EVIDENCE_PATH),
      generation_evidence_digest: evidence(evidenceFile).digest,
      manifest: join(output, PROVIDER_MANIFEST_PATH),
      manifest_digest: evidence(manifest).digest,
      product_commit: args.productCommit,
      product_tree: args.productTree,
      provider_commit: provider.headSha,
      provider_tree: provider.headTree,
      runtime_extension_fixture_digest: `sha256:${fixture.sha256}`,
    })}\n`)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    try {
      await restoreInvokingBunLink(provider)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await removePrivateRoot(sourceRoot, sourceFacts.dev, sourceFacts.ino)
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      if (primaryError !== undefined) throw new AggregateError([primaryError, ...cleanupErrors], "provider generation and cleanup failed")
      throw new AggregateError(cleanupErrors, "provider cleanup failed")
    }
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`fmx Phase 1B provider: ${error instanceof Error ? error.message : String(error)}\n${usage}`)
    process.exitCode = 1
  }
}
