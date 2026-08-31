#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { JsonValue } from "../src/contract-codec.ts"
import {
  PHASE1A_CONSUMER_EVIDENCE_PATHS,
  PHASE1A_CONSUMER_EXECUTION_PATH,
  PHASE1A_EXPECTED_FX_IDENTITY,
  PHASE1A_FX_COMMIT,
  PHASE1A_FX_SHA256,
  PHASE1A_FX_TREE,
  PHASE1A_FX_VERSION,
  PHASE1A_FXNK_VERSION,
  PHASE1A_LAUNCH_FIXTURE_SHA256,
  PHASE1A_OWNER_CANARIES,
  PHASE1A_OWNER_GATE_CONTRACT_DIGEST,
  PHASE1A_OWNER_GATE_RECEIPT_SHA256,
  PHASE1A_OWNER_MANIFEST_SHA256,
  PHASE1A_STRUCTURED_REQUEST_DIGEST,
  verifyPhase1aConsumerEvidence,
} from "../tests/fixtures/agentworkplace-phase1a-fx-consumer.ts"
import { PHASE1B_EXPECTED_SKIPS } from "./generate-agentworkplace-phase1b-provider.ts"
import {
  assertRepositorySnapshotStable,
  captureCleanRepositorySnapshot,
  environmentWithoutGitOverrides,
  isWithin,
  type RepositorySnapshot,
} from "./provider-repository-snapshot.ts"

const REPOSITORY_ROOT = resolve(import.meta.dir, "..")
const AUTHORITY_COMMIT = "8bad6eec880586747bc67eab496ce76c92742c14"
const PRODUCT_BASE_COMMIT = "137d83a53bb0f8a3cd91cd56014ba9850051c649"
export const PHASE1A_PRODUCT_COMMIT = "a874a220e3e6f933a8876588103b017a51aa1e94"
export const PHASE1A_PRODUCT_TREE = "a136c3d9b69a381caba03cc023abad9763b19ec8"
const FX_PARENT = "4cfb7459e249d04e32213a504b6f1709492d6e54"
const FXNK_COMMIT = "2b2f420a82e2e01ed35dba8a176060d03efc496b"
const FXNK_TREE = "f55ae1b2312b699b38de72e6e039a99a669ae1ba"
const FX_UPSTREAM = "ef03b480874a49a9cc508c39b7b98214c34178ee"
const LOCAL_GATE_LOG_SHA256 = "59171345803bda7b048aaf9ce59f6e8071f6716edf06cfe568354c32ff7246f3"
const SHIP_RECEIPT_SHA256 = "77eb6ce5b608b4fee13c429c0b8eea02110c0e927b5e96757caf3cced923c2fa"
const INSTALL_RECEIPT_SHA256 = "d34ed859aa476074eeb8c071e9564904df9d42dea9e0f706531bd25b28409f02"
const BUILT_COMMIT_RECEIPT_SHA256 = "124d00a5721140f606fe4ed717e7591239c11dc1a8f23c289989c30a1138ed88"
const BUILT_DIGEST_RECEIPT_SHA256 = "acf60b79b54b518f5f46d76bd1e957fc7a7dd7004a13aa8d1066c078f7e61548"
const COMMAND_RECEIPT_SCHEMA_ID = "fmx.phase1a-command-receipt"
const PROVIDER_SCHEMA_ID = "fmx.phase1a-provider"
const GENERATION_SCHEMA_ID = "fmx.phase1a-provider-generation-evidence"
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const EXECUTABLE_MODE = 0o700
const COMMIT = /^[0-9a-f]{40}$/u
const TREE = /^[0-9a-f]{40}$/u
const PROVIDER_MANIFEST_PATH = "phase1a-provider.json"
const GENERATION_EVIDENCE_PATH = "generation-evidence.json"
const FMX_GATE_LOG_PATH = "local-gate.log"
const FIXTURE_COMMAND_STDOUT_PATH = "consumer-fixture-command.stdout.log"
const FIXTURE_COMMAND_STDERR_PATH = "consumer-fixture-command.stderr.log"
const FIXTURE_BUNDLE_PATH = "artifacts/consumer-fixture/agentworkplace-phase1a-fx-consumer.js"
const PRODUCT_SOURCE_PATHS = [
  "fx.json",
  "package.json",
  "tests/agentworkplace-phase1a-consumer.test.ts",
  "tests/fixtures/agentworkplace-phase1a-fx-consumer.ts",
] as const
const CONTRACT_PATHS = [
  "contracts/agentworkplace/v1/manifest.json",
  "contracts/agentworkplace/v1/fx-launch-admission-final.jsonl",
] as const
const PROVIDER_CHANGED_PATHS = [
  "package.json",
  "scripts/generate-agentworkplace-phase1a-provider.ts",
  "tests/agentworkplace-phase1a-provider.test.ts",
] as const
const PRODUCT_CHANGED_PATHS = [
  "tests/agentworkplace-phase1a-consumer.test.ts",
  "tests/fixtures/agentworkplace-phase1a-fx-consumer.ts",
] as const
const MATERIALIZED_NAME = "fmx"
const SOURCE_PREFIX = "fmx-phase1a-provider-source-"
const STAGE_PREFIX = ".fmx-phase1a-provider-stage-"
const decoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

const usage = `Usage: scripts/generate-agentworkplace-phase1a-provider.ts \\
  --output <absent-private-path> \\
  --product-commit <40-hex-commit> \\
  --product-tree <40-hex-tree> \\
  --fx-evidence-root <private-manager-evidence-directory>

Materializes the exact Phase 1A fmx consumer commit privately, runs its one
canonical local gate, executes the standalone consumer fixture against the
exact installed fmx-fx, and atomically publishes one source-independent
fmx.phase1a-provider v1 directory. The output path must not already exist.
`

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

export const PHASE1A_REQUIRED_PASS_SCENARIOS = [
  "executes the three fresh-binary scenarios and emits one strict v1 receipt",
] as const

export const PHASE1A_OUTPUT_PATHS = [
  PROVIDER_MANIFEST_PATH,
  GENERATION_EVIDENCE_PATH,
  FMX_GATE_LOG_PATH,
  FIXTURE_COMMAND_STDOUT_PATH,
  FIXTURE_COMMAND_STDERR_PATH,
  ...PRODUCT_SOURCE_PATHS.map((path) => `artifacts/source/${path}`),
  ...CONTRACT_PATHS.map((path) => `artifacts/${path}`),
  FIXTURE_BUNDLE_PATH,
  "artifacts/fx-evidence/local-gate-receipt.json",
  "artifacts/fx-evidence/local-gate.raw.log",
  "artifacts/fx-evidence/ship-receipt.json",
  "artifacts/fx-evidence/install-receipt.json",
  "artifacts/fx-evidence/fx-built-commit",
  "artifacts/fx-evidence/fx-built-sha256",
  ...PHASE1A_CONSUMER_EVIDENCE_PATHS.map((path) => `artifacts/consumer-execution/${path}`),
] as const

type ParsedArguments = {
  readonly fxEvidenceRoot: string
  readonly output: string
  readonly productCommit: string
  readonly productTree: string
}

export type Phase1aGateReceipt = {
  readonly actualSkips: readonly typeof PHASE1B_EXPECTED_SKIPS[number][]
  readonly general: TestSummary
  readonly pty: TestSummary
}

type TestSummary = {
  readonly expectations: number
  readonly fail: number
  readonly files: number
  readonly pass: number
  readonly skip: number
  readonly tests: number
}

type IntendedFile = {
  readonly bytes: Uint8Array
  readonly mode: typeof FILE_MODE | typeof EXECUTABLE_MODE
  readonly path: string
}

export type FileEvidence = {
  readonly bytes: number
  readonly digest: string
  readonly mode: "0600" | "0700"
  readonly path: string
}

type ManagerFile = IntendedFile & {
  readonly sourceMode: "0600" | "0644"
  readonly sourcePath: string
}

type CommandReceipt = {
  readonly argv: readonly string[]
  readonly exit_status: 0
  readonly schema_id: typeof COMMAND_RECEIPT_SCHEMA_ID
  readonly schema_version: 1
  readonly stderr: ""
  readonly stdout: string
}

type BunLinkEntry = {
  readonly device?: string
  readonly inode?: string
  readonly kind: "absent" | "symlink"
  readonly mode?: string
  readonly modified_ns?: string
  readonly path: string
  readonly size?: string
  readonly target?: string
}

type BunLinkTopology = {
  readonly bin_directory: string
  readonly entries: readonly BunLinkEntry[]
}

const MANAGER_FILE_SPECS = [
  { name: "local-gate-receipt.json", bytes: 1_169, digest: PHASE1A_OWNER_GATE_RECEIPT_SHA256, mode: 0o600 },
  { name: "local-gate.raw.log", bytes: 18_168, digest: LOCAL_GATE_LOG_SHA256, mode: 0o600 },
  { name: "ship-receipt.json", bytes: 366, digest: SHIP_RECEIPT_SHA256, mode: 0o600 },
  { name: "install-receipt.json", bytes: 391, digest: INSTALL_RECEIPT_SHA256, mode: 0o600 },
  { name: "fx-built-commit", bytes: 41, digest: BUILT_COMMIT_RECEIPT_SHA256, mode: 0o644 },
  { name: "fx-built-sha256", bytes: 65, digest: BUILT_DIGEST_RECEIPT_SHA256, mode: 0o644 },
] as const

const EXPECTED_SHIP_RECEIPT: CommandReceipt = {
  argv: [
    "/Users/arthack/code/fxnk/scripts/ship-gate.sh",
    "--worktree",
    "/Users/arthack/.herdr/worktrees/fx/worktree-awp-phase1a-integration",
    "--branch",
    "integration",
    "--sha",
    PHASE1A_FX_COMMIT,
  ],
  exit_status: 0,
  schema_id: COMMAND_RECEIPT_SCHEMA_ID,
  schema_version: 1,
  stderr: "",
  stdout: `SHIP ${PHASE1A_FX_COMMIT}\n`,
}

const EXPECTED_INSTALL_RECEIPT: CommandReceipt = {
  argv: [
    "env",
    "TMPDIR=/Volumes/Scratch",
    "/Users/arthack/code/fxnk/scripts/install.sh",
    "--install",
    "--sha",
    PHASE1A_FX_COMMIT,
  ],
  exit_status: 0,
  schema_id: COMMAND_RECEIPT_SCHEMA_ID,
  schema_version: 1,
  stderr: "",
  stdout: "Installed Fx supervision policy in /Users/arthack/src/fx.\n" +
    `Fx integration ${PHASE1A_FX_COMMIT.slice(0, 8)} is already installed at /Users/arthack/.local/bin/fx.\n`,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key] as JsonValue)]))
}

export function canonicalPhase1aProviderJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`
}

function canonicalCompactJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value))}\n`
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function fileEvidence(file: IntendedFile): FileEvidence {
  return {
    bytes: file.bytes.byteLength,
    digest: `sha256:${sha256(file.bytes)}`,
    mode: file.mode === EXECUTABLE_MODE ? "0700" : "0600",
    path: file.path,
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys changed: ${JSON.stringify(actual)}`)
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(usage)
    process.exit(0)
  }
  const allowed = new Set(["--output", "--product-commit", "--product-tree", "--fx-evidence-root"])
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === undefined || !allowed.has(flag)) throw new Error(`unknown argument: ${flag ?? ""}`)
    if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error(`${flag} requires a value`)
    if (values.has(flag)) throw new Error(`${flag} may be provided only once`)
    values.set(flag, value)
  }
  for (const flag of allowed) if (!values.has(flag)) throw new Error(`${flag} is required`)
  const productCommit = values.get("--product-commit")!
  const productTree = values.get("--product-tree")!
  if (!COMMIT.test(productCommit) || productCommit !== PHASE1A_PRODUCT_COMMIT) {
    throw new Error(`--product-commit must be the frozen Phase 1A product commit ${PHASE1A_PRODUCT_COMMIT}`)
  }
  if (!TREE.test(productTree) || productTree !== PHASE1A_PRODUCT_TREE) {
    throw new Error(`--product-tree must be the frozen Phase 1A product tree ${PHASE1A_PRODUCT_TREE}`)
  }
  return {
    fxEvidenceRoot: resolve(values.get("--fx-evidence-root")!),
    output: resolve(values.get("--output")!),
    productCommit,
    productTree,
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

function changedPaths(repository: string, from: string, to: string): readonly string[] {
  return git(repository, ["diff", "--name-only", "--no-renames", `${from}..${to}`])
    .split("\n").filter(Boolean).sort()
}

async function captureBunLinkEntry(path: string): Promise<BunLinkEntry> {
  const before = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") return null
    throw error
  })
  if (before === null) return { kind: "absent", path }
  if (!before.isSymbolicLink()) throw new Error(`Bun fmx topology contains a nonsymlink entry: ${path}`)
  const target = await readlink(path)
  const after = await lstat(path, { bigint: true })
  if (
    !after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
    before.mode !== after.mode || before.size !== after.size || before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error(`Bun fmx topology changed while read: ${path}`)
  }
  return {
    device: before.dev.toString(),
    inode: before.ino.toString(),
    kind: "symlink",
    mode: (before.mode & 0o777n).toString(8).padStart(4, "0"),
    modified_ns: before.mtimeNs.toString(),
    path,
    size: before.size.toString(),
    target,
  }
}

async function captureBunLinkTopology(): Promise<BunLinkTopology> {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "pm", "bin", "-g"],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0 || result.stderr.byteLength !== 0) {
    throw new Error(`could not locate the invoking Bun global bin: ${decoder.decode(result.stderr).trim()}`)
  }
  const binDirectory = decoder.decode(result.stdout).trim()
  if (!isAbsolute(binDirectory) || await realpath(binDirectory) !== binDirectory) {
    throw new Error("invoking Bun global bin must be one canonical absolute directory")
  }
  const packageLink = resolve(binDirectory, "../install/global/node_modules/fmx")
  const paths = [join(binDirectory, "fmx"), join(binDirectory, "fmx-mcp"), packageLink]
  const entries = await Promise.all(paths.map(captureBunLinkEntry))
  const present = entries.filter(({ kind }) => kind === "symlink").length
  if (present !== 0 && present !== entries.length) throw new Error("invoking Bun fmx link topology is incomplete")
  return { bin_directory: binDirectory, entries }
}

async function assertBunLinkTopologyStable(expected: BunLinkTopology): Promise<void> {
  const actual = await captureBunLinkTopology()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`invoking Bun fmx link topology changed: ${JSON.stringify(actual)}`)
  }
}

function requireProductFacts(
  provider: RepositorySnapshot,
  productCommit: string,
  productTree: string,
): { readonly parent: string } {
  if (git(provider.repositoryRoot, ["rev-parse", "--verify", `${productCommit}^{tree}`]) !== productTree) {
    throw new Error("product commit does not name --product-tree")
  }
  const productParents = git(provider.repositoryRoot, ["show", "-s", "--format=%P", productCommit])
  if (productParents !== PRODUCT_BASE_COMMIT) throw new Error("Phase 1A product has the wrong parent")
  const providerParents = git(provider.repositoryRoot, ["show", "-s", "--format=%P", provider.headSha])
  if (providerParents !== productCommit) throw new Error("provider generator must be one direct commit above the product")
  if (JSON.stringify(changedPaths(provider.repositoryRoot, PRODUCT_BASE_COMMIT, productCommit)) !==
    JSON.stringify([...PRODUCT_CHANGED_PATHS].sort())) {
    throw new Error("Phase 1A product changed paths outside its two test-owned files")
  }
  if (JSON.stringify(changedPaths(provider.repositoryRoot, productCommit, provider.headSha)) !==
    JSON.stringify([...PROVIDER_CHANGED_PATHS].sort())) {
    throw new Error("Phase 1A provider changed paths outside its three provider-owned files")
  }
  return { parent: PRODUCT_BASE_COMMIT }
}

function relativeIsSafe(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)
}

async function readStableRegularFile(
  root: string,
  path: string,
  expectedMode: number,
): Promise<Uint8Array> {
  if (!relativeIsSafe(path)) throw new Error(`unsafe evidence path: ${path}`)
  const absolute = resolve(root, path)
  if (!isWithin(root, absolute)) throw new Error(`evidence path escapes its root: ${path}`)
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || Number(before.mode & 0o777n) !== expectedMode) {
      throw new Error(`${path} must be a mode-${expectedMode.toString(8).padStart(4, "0")} single-link regular file`)
    }
    const bytes = new Uint8Array(await handle.readFile())
    const after = await handle.stat({ bigint: true })
    const atPath = await lstat(absolute, { bigint: true })
    if (
      !atPath.isFile() || atPath.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mode !== after.mode || before.nlink !== after.nlink ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      after.dev !== atPath.dev || after.ino !== atPath.ino || after.size !== atPath.size ||
      after.mode !== atPath.mode || after.nlink !== atPath.nlink ||
      after.mtimeNs !== atPath.mtimeNs || after.ctimeNs !== atPath.ctimeNs ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw new Error(`${path} changed while read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

export function validatePhase1aCommandReceipt(
  bytes: Uint8Array,
  expected: CommandReceipt,
): CommandReceipt {
  const text = decoder.decode(bytes)
  const parsed = JSON.parse(text) as unknown
  if (!isRecord(parsed)) throw new Error("command receipt must be an object")
  exactKeys(parsed, ["argv", "exit_status", "schema_id", "schema_version", "stderr", "stdout"], "command receipt")
  if (text !== canonicalCompactJson(parsed as JsonValue)) throw new Error("command receipt is not canonical JSON plus one LF")
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("command receipt facts changed")
  return parsed as unknown as CommandReceipt
}

async function readManagerEvidence(root: string): Promise<{
  readonly files: readonly ManagerFile[]
  readonly install: CommandReceipt
  readonly localGate: Record<string, unknown>
  readonly ship: CommandReceipt
}> {
  if (!isAbsolute(root)) throw new Error("--fx-evidence-root must be absolute")
  const physical = await realpath(root)
  if (physical !== root) throw new Error("--fx-evidence-root must already be canonical")
  const before = await lstat(root, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink() || Number(before.mode & 0o777n) !== DIRECTORY_MODE) {
    throw new Error("--fx-evidence-root must be a mode-0700 real directory")
  }
  const inventory = (await readdir(root)).sort()
  if (JSON.stringify(inventory) !== JSON.stringify(MANAGER_FILE_SPECS.map(({ name }) => name).sort())) {
    throw new Error("manager Fx evidence inventory changed")
  }
  const managerFiles: ManagerFile[] = []
  for (const spec of MANAGER_FILE_SPECS) {
    const bytes = await readStableRegularFile(root, spec.name, spec.mode)
    if (bytes.byteLength !== spec.bytes || sha256(bytes) !== spec.digest) {
      throw new Error(`manager Fx evidence bytes changed: ${spec.name}`)
    }
    managerFiles.push({
      bytes,
      mode: FILE_MODE,
      path: `artifacts/fx-evidence/${spec.name}`,
      sourceMode: spec.mode === 0o600 ? "0600" : "0644",
      sourcePath: spec.name,
    })
  }
  const byName = (name: string) => managerFiles.find(({ sourcePath }) => sourcePath === name)!.bytes
  const ship = validatePhase1aCommandReceipt(byName("ship-receipt.json"), EXPECTED_SHIP_RECEIPT)
  const install = validatePhase1aCommandReceipt(byName("install-receipt.json"), EXPECTED_INSTALL_RECEIPT)
  if (decoder.decode(byName("fx-built-commit")) !== `${PHASE1A_FX_COMMIT}\n`) {
    throw new Error("installed build commit receipt changed")
  }
  if (decoder.decode(byName("fx-built-sha256")) !== `${PHASE1A_FX_SHA256}\n`) {
    throw new Error("installed build digest receipt changed")
  }
  const localGate = JSON.parse(decoder.decode(byName("local-gate-receipt.json"))) as unknown
  if (!isRecord(localGate) || localGate.schema !== 1 || localGate.fx_sha !== PHASE1A_FX_COMMIT ||
    localGate.contract_digest !== PHASE1A_OWNER_GATE_CONTRACT_DIGEST) {
    throw new Error("Fx local-gate receipt facts changed")
  }
  const outcomes = localGate.outcomes
  if (!isRecord(outcomes) || outcomes.fxnk_unit_canaries !== "pass" || outcomes.fresh_binary !== "pass") {
    throw new Error("Fx local-gate receipt does not prove owner canaries and fresh binary")
  }
  const after = await lstat(root, { bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs ||
    JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(inventory)) {
    throw new Error("manager Fx evidence root changed while read")
  }
  return { files: managerFiles, install, localGate, ship }
}

function summaryMatches(log: string): readonly RegExpMatchArray[] {
  return [...log.matchAll(
    /^\s*(\d+) pass\n(?:\s*(\d+) skip\n)?\s*(\d+) fail\n\s*(\d+) expect\(\) calls\nRan (\d+) tests across (\d+) files?\./gmu,
  )]
}

function testSummary(match: RegExpMatchArray): TestSummary {
  return {
    pass: Number(match[1]),
    skip: Number(match[2] ?? "0"),
    fail: Number(match[3]),
    expectations: Number(match[4]),
    tests: Number(match[5]),
    files: Number(match[6]),
  }
}

export function parsePhase1aGateLog(log: string): Phase1aGateReceipt {
  if (!log.endsWith("fmx local gate: PASS macos-aarch64\n")) throw new Error("canonical fmx gate lacks its final PASS")
  const matches = summaryMatches(log)
  if (matches.length !== 2) throw new Error(`expected two Bun summaries, received ${matches.length}`)
  const general = testSummary(matches[0]!)
  const pty = testSummary(matches[1]!)
  const expectedGeneral = { pass: 480, skip: 20, fail: 0, expectations: 3009, tests: 500, files: 66 }
  const expectedPty = { pass: 4, skip: 0, fail: 0, expectations: 32, tests: 4, files: 1 }
  if (JSON.stringify(general) !== JSON.stringify(expectedGeneral)) {
    throw new Error(`canonical general gate counts changed: ${JSON.stringify(general)}`)
  }
  if (JSON.stringify(pty) !== JSON.stringify(expectedPty)) {
    throw new Error(`canonical PTY gate counts changed: ${JSON.stringify(pty)}`)
  }
  const observedSkipCounts = new Map<string, number>()
  for (const match of log.matchAll(/^\(skip\) (.+)$/gmu)) {
    const description = match[1]!.trim()
    observedSkipCounts.set(description, (observedSkipCounts.get(description) ?? 0) + 1)
  }
  const expectedSkips = PHASE1B_EXPECTED_SKIPS.map(({ description }) => description)
  if (
    observedSkipCounts.size !== expectedSkips.length ||
    expectedSkips.some((description) => observedSkipCounts.get(description) !== 2)
  ) {
    throw new Error("canonical fmx gate skip inventory changed")
  }
  const passLines = [...log.matchAll(/^\(pass\) (.+?)(?: \[[^\n]+\])?$/gmu)].map((match) => match[1]!)
  for (const scenario of PHASE1A_REQUIRED_PASS_SCENARIOS) {
    if (!passLines.some((line) => line === scenario || line.endsWith(` > ${scenario}`))) {
      throw new Error(`canonical fmx gate omitted Phase 1A consumer scenario: ${scenario}`)
    }
  }
  return { actualSkips: PHASE1B_EXPECTED_SKIPS.map((entry) => ({ ...entry })), general, pty }
}

async function validateOutputTarget(path: string, provider: RepositorySnapshot): Promise<{
  readonly output: string
  readonly parent: string
}> {
  if (!isAbsolute(path)) throw new Error("--output must be absolute")
  const parent = await realpath(dirname(path))
  const output = join(parent, path.slice(dirname(path).length + 1))
  const parentFacts = await lstat(parent)
  if (parentFacts.isSymbolicLink() || !parentFacts.isDirectory() || (parentFacts.mode & 0o077) !== 0) {
    throw new Error("output parent must be a real private directory")
  }
  if (isWithin(provider.commonGitDirectory, output) || provider.worktrees.some((worktree) => isWithin(worktree, output))) {
    throw new Error("output must be outside fmx Git state and every Worktree")
  }
  const existing = await lstat(output).then(() => true).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  })
  if (existing) throw new Error("output path must not already exist")
  return { output, parent }
}

async function materializeProduct(
  provider: RepositorySnapshot,
  commit: string,
  tree: string,
  destination: string,
): Promise<RepositorySnapshot> {
  await mkdir(destination, { mode: DIRECTORY_MODE })
  git(destination, ["init", "--quiet"])
  git(destination, ["fetch", "--quiet", "--no-tags", "--depth=1", provider.commonGitDirectory, commit])
  git(destination, ["checkout", "--quiet", "--detach", "FETCH_HEAD"])
  const snapshot = await captureCleanRepositorySnapshot(destination)
  if (snapshot.headSha !== commit || snapshot.headTree !== tree) throw new Error("private product materialization changed")
  return snapshot
}

async function runCanonicalGate(
  productRoot: string,
  logPath: string,
  scratchRoot: string,
): Promise<{ readonly bytes: Uint8Array; readonly receipt: Phase1aGateReceipt }> {
  const tmp = join(scratchRoot, "gate-tmp")
  const zigCache = join(scratchRoot, "zig-global-cache")
  const bunInstall = join(scratchRoot, "gate-bun-install")
  const installBin = join(scratchRoot, "gate-native-bin")
  for (const path of [tmp, zigCache, bunInstall, installBin]) await mkdir(path, { mode: DIRECTORY_MODE })
  await writeExclusive(bunInstall, {
    bytes: encoder.encode('{"dependencies": {}}\n'),
    mode: FILE_MODE,
    path: "install/global/package.json",
  })
  const handle = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE)
  let status = -1
  try {
    const child = Bun.spawn(["./scripts/local-gate.sh"], {
      cwd: productRoot,
      env: phase1aGateEnvironment(scratchRoot),
      stdout: handle.fd,
      stderr: handle.fd,
    })
    status = await child.exited
    await handle.sync()
  } finally {
    await handle.close()
  }
  const bytes = await readStableRegularFile(scratchRoot, relative(scratchRoot, logPath), FILE_MODE)
  process.stdout.write(bytes)
  if (status !== 0) throw new Error(`canonical fmx gate exited ${status}`)
  return { bytes, receipt: parsePhase1aGateLog(decoder.decode(bytes)) }
}

export function phase1aGateEnvironment(
  scratchRoot: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return environmentWithoutGitOverrides({
    ...source,
    BUN_INSTALL: join(scratchRoot, "gate-bun-install"),
    FMX_INSTALL_BIN_DIR: join(scratchRoot, "gate-native-bin"),
    TMPDIR: join(scratchRoot, "gate-tmp"),
    ZIG_GLOBAL_CACHE_DIR: join(scratchRoot, "zig-global-cache"),
  })
}

export async function buildPhase1aConsumerFixture(productRoot: string, output: string): Promise<Uint8Array> {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      join(productRoot, "tests/fixtures/agentworkplace-phase1a-fx-consumer.ts"),
      "--target=bun",
      "--outfile",
      output,
    ],
    cwd: productRoot,
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`could not bundle Phase 1A fixture: ${decoder.decode(result.stderr).trim()}`)
  await chmod(output, EXECUTABLE_MODE)
  return readStableRegularFile(dirname(output), relative(dirname(output), output), EXECUTABLE_MODE)
}

async function installedFxSourceEvidence(path: string): Promise<JsonValue> {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error("installed fmx-fx path is not canonical")
  const bytes = await readStableRegularFile(dirname(path), relative(dirname(path), path), 0o755)
  const value = {
    bytes: bytes.byteLength,
    commit: PHASE1A_FX_COMMIT,
    fxnk: PHASE1A_FXNK_VERSION,
    mode: "0755",
    path,
    sha256: `sha256:${sha256(bytes)}`,
    tree: PHASE1A_FX_TREE,
    version: PHASE1A_FX_VERSION,
  }
  if (
    value.bytes !== PHASE1A_EXPECTED_FX_IDENTITY.bytes || value.sha256 !== PHASE1A_EXPECTED_FX_IDENTITY.sha256 ||
    value.version !== PHASE1A_FX_VERSION
  ) {
    throw new Error(`installed fmx-fx source identity changed: ${JSON.stringify(value)}`)
  }
  return value as unknown as JsonValue
}

async function executeConsumerFixture(input: {
  readonly bundle: string
  readonly contracts: string
  readonly evidence: string
  readonly fx: string
  readonly ownerGateReceipt: string
  readonly scratchRoot: string
}): Promise<{
  readonly evidenceFiles: readonly IntendedFile[]
  readonly receipt: Record<string, JsonValue>
  readonly stderr: IntendedFile
  readonly stdout: IntendedFile
}> {
  await mkdir(input.evidence, { mode: DIRECTORY_MODE })
  const child = Bun.spawn([
    process.execPath,
    input.bundle,
    "--fx",
    input.fx,
    "--evidence",
    input.evidence,
    "--contracts",
    input.contracts,
    "--owner-gate-receipt",
    input.ownerGateReceipt,
  ], {
    cwd: input.scratchRoot,
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, stdoutBytes, stderrBytes] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer().then((value) => new Uint8Array(value)),
    new Response(child.stderr).arrayBuffer().then((value) => new Uint8Array(value)),
  ])
  if (status !== 0 || stderrBytes.byteLength !== 0) {
    throw new Error(`Phase 1A consumer fixture exited ${status}: ${decoder.decode(stderrBytes)}`)
  }
  const verified = await verifyPhase1aConsumerEvidence(input.evidence)
  const evidenceFiles: IntendedFile[] = []
  for (const path of PHASE1A_CONSUMER_EVIDENCE_PATHS) {
    evidenceFiles.push({
      bytes: await readStableRegularFile(input.evidence, path, FILE_MODE),
      mode: FILE_MODE,
      path: `artifacts/consumer-execution/${path}`,
    })
  }
  return {
    evidenceFiles,
    receipt: verified.receipt,
    stderr: { bytes: stderrBytes, mode: FILE_MODE, path: FIXTURE_COMMAND_STDERR_PATH },
    stdout: { bytes: stdoutBytes, mode: FILE_MODE, path: FIXTURE_COMMAND_STDOUT_PATH },
  }
}

async function productArtifacts(productRoot: string): Promise<IntendedFile[]> {
  const files: IntendedFile[] = []
  for (const path of PRODUCT_SOURCE_PATHS) {
    files.push({
      bytes: await readStableRegularFile(productRoot, path, 0o644),
      mode: FILE_MODE,
      path: `artifacts/source/${path}`,
    })
  }
  for (const path of CONTRACT_PATHS) {
    files.push({
      bytes: await readStableRegularFile(productRoot, path, 0o644),
      mode: FILE_MODE,
      path: `artifacts/${path}`,
    })
  }
  const manifest = files.find(({ path }) => path.endsWith("/manifest.json"))!
  const fixture = files.find(({ path }) => path.endsWith("/fx-launch-admission-final.jsonl"))!
  if (sha256(manifest.bytes) !== PHASE1A_OWNER_MANIFEST_SHA256 || sha256(fixture.bytes) !== PHASE1A_LAUNCH_FIXTURE_SHA256 || fixture.bytes.byteLength !== 4_262) {
    throw new Error("frozen Phase 0 owner contracts changed")
  }
  return files
}

function sortedEvidence(files: readonly IntendedFile[]): readonly FileEvidence[] {
  return files.map(fileEvidence).sort((left, right) => left.path.localeCompare(right.path))
}

export function buildPhase1aProviderManifest(input: {
  readonly artifacts: readonly FileEvidence[]
  readonly consumerReceipt: Record<string, JsonValue>
  readonly fixtureCommandStderr: FileEvidence
  readonly fixtureCommandStdout: FileEvidence
  readonly gate: Phase1aGateReceipt
  readonly gateLog: FileEvidence
  readonly installedFx: JsonValue
  readonly manager: { readonly files: readonly ManagerFile[]; readonly install: CommandReceipt; readonly ship: CommandReceipt }
  readonly product: { readonly commit: string; readonly parent: string; readonly tree: string }
  readonly provider: { readonly commit: string; readonly tree: string }
}): JsonValue {
  const artifact = (suffix: string) => input.artifacts.find(({ path }) => path.endsWith(suffix))!
  return {
    artifacts: input.artifacts as unknown as JsonValue,
    authority: { plan: "AgentWorkplace Plan Revision 1", phase: "1a", wiki_commit: AUTHORITY_COMMIT },
    consumer_fixture: {
      artifact: artifact(FIXTURE_BUNDLE_PATH),
      command: ["<absolute-bun>", `<provider-root>/${FIXTURE_BUNDLE_PATH}`, "--fx", "<installed-fmx-fx>", "--evidence", "<private-empty-directory>", "--contracts", "<provider-root>/artifacts/contracts/agentworkplace/v1", "--owner-gate-receipt", "<provider-root>/artifacts/fx-evidence/local-gate-receipt.json"],
      execution_receipt: artifact(`artifacts/consumer-execution/${PHASE1A_CONSUMER_EXECUTION_PATH}`),
      exit_status: 0,
      receipt: input.consumerReceipt,
      scenarios: ["native_session_naming_exact_resume", "durable_initial_work_control_admission", "structured_subscription_inference"],
      stderr: input.fixtureCommandStderr,
      stdout: input.fixtureCommandStdout,
    },
    contracts: {
      launch_admission_final: {
        bytes: 4_262,
        fixture: artifact("artifacts/contracts/agentworkplace/v1/fx-launch-admission-final.jsonl"),
        final_receipt_ack_interpretation: "frozen_fixture_consumption_plus_canonical_owner_canaries",
        schema_id: "fx.launch-admission-final",
        schema_version: 1,
      },
      owner_manifest: { digest: `sha256:${PHASE1A_OWNER_MANIFEST_SHA256}`, schema_version: 1 },
      structured_inference: {
        captured_output_max_bytes: 960 * 1_024,
        frame_max_bytes: 1_048_576,
        request_digest: PHASE1A_STRUCTURED_REQUEST_DIGEST,
        schema_id: "fx.structured-subscription-inference",
        wire_version: 1,
      },
      work_control: { schema_version: 1, status: "unchanged" },
    },
    fx: {
      binary: input.installedFx,
      branch: "integration",
      commit: PHASE1A_FX_COMMIT,
      parent: FX_PARENT,
      repository: "https://github.com/possibilities/fx.git",
      tree: PHASE1A_FX_TREE,
      upstream: FX_UPSTREAM,
      version: PHASE1A_FX_VERSION,
    },
    fxnk: {
      build_receipts: [artifact("artifacts/fx-evidence/fx-built-commit"), artifact("artifacts/fx-evidence/fx-built-sha256")],
      commit: FXNK_COMMIT,
      contract_digest: PHASE1A_OWNER_GATE_CONTRACT_DIGEST,
      install: { ...input.manager.install, receipt: artifact("artifacts/fx-evidence/install-receipt.json") },
      local_gate: {
        raw_log: artifact("artifacts/fx-evidence/local-gate.raw.log"),
        receipt: artifact("artifacts/fx-evidence/local-gate-receipt.json"),
      },
      ship: { ...input.manager.ship, receipt: artifact("artifacts/fx-evidence/ship-receipt.json") },
      tree: FXNK_TREE,
      version: PHASE1A_FXNK_VERSION,
    },
    local_gate: {
      command: ["./scripts/local-gate.sh"],
      exit_status: 0,
      general: input.gate.general,
      log: input.gateLog,
      pty: input.gate.pty,
      required_pass_scenarios: [...PHASE1A_REQUIRED_PASS_SCENARIOS],
      skips: { actual: input.gate.actualSkips, expected: PHASE1B_EXPECTED_SKIPS },
    },
    non_goals: {
      binary_archived: false,
      phase1c_lifecycle: false,
      production_launch_transport: false,
      public_cli: false,
      workplace_policy_in_fx: false,
    },
    owner_gate: {
      canary_count: 116,
      classification: "canonical_owner_gate_only_not_fresh_consumer_execution",
      exact_canaries: [...PHASE1A_OWNER_CANARIES],
      receipt_digest: `sha256:${PHASE1A_OWNER_GATE_RECEIPT_SHA256}`,
      status: "pass",
    },
    package: { name: PROVIDER_SCHEMA_ID, version: "1" },
    product_repository: { name: "fmx", ...input.product },
    provider_repository: { name: "fmx", ...input.provider },
    public_mcp: { status: "unchanged", tool_count: PUBLIC_MCP_TOOLS.length, tools: [...PUBLIC_MCP_TOOLS] },
    review: { rounds: 1, verdict: "all concrete findings corrected; no blocking finding remains" },
    schema_id: PROVIDER_SCHEMA_ID,
    schema_version: 1,
  } as unknown as JsonValue
}

async function writeExclusive(root: string, file: IntendedFile): Promise<void> {
  const path = resolve(root, file.path)
  if (!isWithin(root, path) || path === root) throw new Error(`output path escapes provider root: ${file.path}`)
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

async function outputInventory(root: string, at = ""): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(join(root, at), { withFileTypes: true })) {
    const path = at.length === 0 ? entry.name : join(at, entry.name)
    if (entry.isDirectory()) paths.push(...(await outputInventory(root, path)))
    else if (entry.isFile()) paths.push(path)
    else throw new Error(`provider output contains a nonregular entry: ${path}`)
  }
  return paths.sort()
}

async function publishAtomic(
  target: { readonly output: string; readonly parent: string },
  files: readonly IntendedFile[],
): Promise<void> {
  const stage = await mkdtemp(join(target.parent, STAGE_PREFIX))
  await chmod(stage, DIRECTORY_MODE)
  const facts = await lstat(stage, { bigint: true })
  let published = false
  try {
    for (const file of files) await writeExclusive(stage, file)
    const inventory = await outputInventory(stage)
    if (JSON.stringify(inventory) !== JSON.stringify([...PHASE1A_OUTPUT_PATHS].sort())) {
      throw new Error(`provider staging inventory changed: ${JSON.stringify(inventory)}`)
    }
    for (const file of files) {
      const bytes = await readStableRegularFile(stage, file.path, file.mode)
      if (sha256(bytes) !== sha256(file.bytes)) throw new Error(`provider staging bytes changed: ${file.path}`)
    }
    const collision = await lstat(target.output).then(() => true).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") return false
      throw error
    })
    if (collision) throw new Error("provider output appeared before atomic publication")
    await rename(stage, target.output)
    published = true
    const finalInventory = await outputInventory(target.output)
    if (JSON.stringify(finalInventory) !== JSON.stringify(inventory)) throw new Error("published provider inventory changed")
  } finally {
    if (!published) {
      const current = await lstat(stage, { bigint: true }).catch(() => null)
      if (current !== null && current.dev === facts.dev && current.ino === facts.ino && current.isDirectory()) {
        await rm(stage, { recursive: true })
      }
    }
  }
}

async function removePrivateRoot(path: string, device: bigint, inode: bigint): Promise<void> {
  const facts = await lstat(path, { bigint: true })
  if (!facts.isDirectory() || facts.isSymbolicLink() || facts.dev !== device || facts.ino !== inode) {
    throw new Error("refusing to remove replaced provider source root")
  }
  await rm(path, { recursive: true })
}

async function main(): Promise<void> {
  const args = parseArguments(Bun.argv.slice(2))
  const provider = await captureCleanRepositorySnapshot(REPOSITORY_ROOT)
  const product = requireProductFacts(provider, args.productCommit, args.productTree)
  const outputTarget = await validateOutputTarget(args.output, provider)
  const manager = await readManagerEvidence(args.fxEvidenceRoot)
  const bunLinkTopology = await captureBunLinkTopology()
  const scratchParent = resolve(process.env.TMPDIR ?? tmpdir())
  const sourceRoot = await mkdtemp(join(scratchParent, SOURCE_PREFIX))
  await chmod(sourceRoot, DIRECTORY_MODE)
  const sourceFacts = await lstat(sourceRoot, { bigint: true })
  const productRoot = join(sourceRoot, MATERIALIZED_NAME)
  let primaryError: unknown
  let collected: {
    artifacts: IntendedFile[]
    consumer: Awaited<ReturnType<typeof executeConsumerFixture>>
    fixtureBytes: Uint8Array
    gate: Awaited<ReturnType<typeof runCanonicalGate>>
    installedFx: JsonValue
  } | null = null
  try {
    const productSnapshot = await materializeProduct(provider, args.productCommit, args.productTree, productRoot)
    process.stdout.write(`fmx Phase 1A provider: gating exact product ${args.productCommit}\n`)
    const gate = await runCanonicalGate(productRoot, join(sourceRoot, FMX_GATE_LOG_PATH), sourceRoot)
    await assertRepositorySnapshotStable(productRoot, productSnapshot)
    const installedPath = resolve(process.env.FMX_INSTALL_BIN_DIR ?? join(process.env.HOME ?? "", ".local/bin"), "fmx-fx")
    const installedBefore = await installedFxSourceEvidence(installedPath)
    const bundle = join(sourceRoot, "agentworkplace-phase1a-fx-consumer.js")
    const fixtureBytes = await buildPhase1aConsumerFixture(productRoot, bundle)
    const consumer = await executeConsumerFixture({
      bundle,
      contracts: join(productRoot, "contracts/agentworkplace/v1"),
      evidence: join(sourceRoot, "consumer-execution"),
      fx: installedPath,
      ownerGateReceipt: join(args.fxEvidenceRoot, "local-gate-receipt.json"),
      scratchRoot: sourceRoot,
    })
    const installedAfter = await installedFxSourceEvidence(installedPath)
    if (JSON.stringify(installedBefore) !== JSON.stringify(installedAfter)) throw new Error("installed fmx-fx changed during consumer execution")
    const consumerFx = consumer.receipt.fx
    if (!isRecord(consumerFx) ||
      JSON.stringify(sortJson(consumerFx as JsonValue)) !== JSON.stringify(sortJson(installedAfter))) {
      throw new Error("consumer snapshot identity does not match the installed fmx-fx source")
    }
    await assertRepositorySnapshotStable(productRoot, productSnapshot)
    const artifacts = await productArtifacts(productRoot)
    artifacts.push(...manager.files, ...consumer.evidenceFiles)
    artifacts.push({ bytes: fixtureBytes, mode: EXECUTABLE_MODE, path: FIXTURE_BUNDLE_PATH })
    artifacts.push({ bytes: gate.bytes, mode: FILE_MODE, path: FMX_GATE_LOG_PATH })
    artifacts.push(consumer.stdout, consumer.stderr)
    collected = { artifacts, consumer, fixtureBytes, gate, installedFx: installedAfter }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    try {
      await assertBunLinkTopologyStable(bunLinkTopology)
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
  if (collected === null) throw new Error("provider generation collected no evidence")
  await assertRepositorySnapshotStable(REPOSITORY_ROOT, provider)
  await readManagerEvidence(args.fxEvidenceRoot)
  const artifactEvidence = sortedEvidence(collected.artifacts)
  const manifestValue = buildPhase1aProviderManifest({
    artifacts: artifactEvidence,
    consumerReceipt: collected.consumer.receipt,
    fixtureCommandStderr: fileEvidence(collected.consumer.stderr),
    fixtureCommandStdout: fileEvidence(collected.consumer.stdout),
    gate: collected.gate.receipt,
    gateLog: fileEvidence(collected.artifacts.find(({ path }) => path === FMX_GATE_LOG_PATH)!),
    installedFx: collected.installedFx,
    manager,
    product: { commit: args.productCommit, parent: product.parent, tree: args.productTree },
    provider: { commit: provider.headSha, tree: provider.headTree },
  })
  const manifest: IntendedFile = {
    bytes: encoder.encode(canonicalPhase1aProviderJson(manifestValue)),
    mode: FILE_MODE,
    path: PROVIDER_MANIFEST_PATH,
  }
  const generatorBytes = await readStableRegularFile(REPOSITORY_ROOT, "scripts/generate-agentworkplace-phase1a-provider.ts", 0o644)
  const preGenerationFiles = [...collected.artifacts, manifest]
  const generationValue = {
    accepted: true,
    authority_commit: AUTHORITY_COMMIT,
    canonical_fmx_gate: { command: ["./scripts/local-gate.sh"], exit_status: 0, log: fileEvidence(collected.artifacts.find(({ path }) => path === FMX_GATE_LOG_PATH)!), ...collected.gate.receipt },
    cleanup: { bun_global_topology_preserved: true, consumer_resources_reaped: true, gate_process_exited: true, private_source_removed: true },
    consumer_fixture: {
      artifact: fileEvidence(collected.artifacts.find(({ path }) => path === FIXTURE_BUNDLE_PATH)!),
      execution_receipt: fileEvidence(collected.artifacts.find(({ path }) => path.endsWith(`/${PHASE1A_CONSUMER_EXECUTION_PATH}`))!),
      exit_status: 0,
      stderr: fileEvidence(collected.consumer.stderr),
      stdout: fileEvidence(collected.consumer.stdout),
    },
    generator: { digest: `sha256:${sha256(generatorBytes)}`, path: "scripts/generate-agentworkplace-phase1a-provider.ts" },
    installed_fx: collected.installedFx,
    manager_fx_evidence: manager.files.map((file) => ({ ...fileEvidence(file), source_mode: file.sourceMode, source_path: file.sourcePath })),
    output_inventory: sortedEvidence(preGenerationFiles),
    package: { name: PROVIDER_SCHEMA_ID, version: "1" },
    product_repository: { commit: args.productCommit, parent: product.parent, tree: args.productTree },
    provider_repository: { commit: provider.headSha, tree: provider.headTree },
    schema_id: GENERATION_SCHEMA_ID,
    schema_version: 1,
    source_materialization: "private detached fetch of the exact product commit",
  } as unknown as JsonValue
  const generation: IntendedFile = {
    bytes: encoder.encode(canonicalPhase1aProviderJson(generationValue)),
    mode: FILE_MODE,
    path: GENERATION_EVIDENCE_PATH,
  }
  const allFiles = [...collected.artifacts, manifest, generation]
  if (allFiles.length !== PHASE1A_OUTPUT_PATHS.length || new Set(allFiles.map(({ path }) => path)).size !== allFiles.length) {
    throw new Error("provider output file count or path uniqueness changed")
  }
  await publishAtomic(outputTarget, allFiles)
  process.stdout.write(`${JSON.stringify({
    accepted: true,
    bundle: outputTarget.output,
    file_count: allFiles.length,
    generation_evidence: join(outputTarget.output, GENERATION_EVIDENCE_PATH),
    generation_evidence_digest: fileEvidence(generation).digest,
    manifest: join(outputTarget.output, PROVIDER_MANIFEST_PATH),
    manifest_digest: fileEvidence(manifest).digest,
    product_commit: args.productCommit,
    product_tree: args.productTree,
    provider_commit: provider.headSha,
    provider_tree: provider.headTree,
  })}\n`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`fmx Phase 1A provider: ${error instanceof Error ? error.message : String(error)}\n${usage}`)
    process.exitCode = 1
  }
}
