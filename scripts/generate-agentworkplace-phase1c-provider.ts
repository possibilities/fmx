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
import { dirname, isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_SCHEMA_ID,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  runtimeExtensionMessageSchema,
} from "../src/agentworkplace-contracts.ts"
import {
  ContractFrameDecoder,
  decodeStrictJson,
  type JsonValue,
} from "../src/contract-codec.ts"
import {
  FX_LAUNCH_PROVIDER_SCHEMA_ID,
  FX_LAUNCH_PROVIDER_SCHEMA_VERSION,
} from "../src/fx-launch-provider.ts"
import { verifyAgentWorkplaceContracts } from "./check-agentworkplace-contracts.ts"
import {
  assertRepositorySnapshotStable,
  captureCleanRepositorySnapshot,
  environmentWithoutGitOverrides,
  isWithin,
  type RepositorySnapshot,
} from "./provider-repository-snapshot.ts"

const REPOSITORY_ROOT = resolve(import.meta.dir, "..")
export const PHASE1C_IMPLEMENTATION_BASE_COMMIT =
  "e52e6be1685afe77f6ab924001a71fee833751e5" as const
export const PHASE1C_FIXTURE_PATH =
  "artifacts/phase1c-runtime-extension-fixture.js" as const
export const PHASE1C_GATE_INPUT_PATH =
  "evidence-inputs/local-gate.json" as const
export const PHASE1C_REAL_PROCESS_INPUT_PATH =
  "evidence-inputs/real-process.json" as const
export const PHASE1C_FX_CONTRACT_PATH =
  "artifacts/fx-source/src/core/control/launch_provider.md" as const
export const PHASE1C_PROVIDER_MANIFEST_PATH = "phase1c-provider.json" as const
export const PHASE1C_GENERATION_EVIDENCE_PATH =
  "generation-evidence.json" as const

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const EXECUTABLE_MODE = 0o700
const MAX_EVIDENCE_BYTES = 1024 * 1024
const COMMIT = /^[0-9a-f]{40}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SAFE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

const usage = `Usage: scripts/generate-agentworkplace-phase1c-provider.ts \\
  --output <existing-empty-private-directory> \\
  --product-commit <40-hex-commit> \\
  --product-tree <40-hex-tree> \\
  --authority-repository <git-repository> \\
  --authority-commit <40-hex-commit> \\
  --fx-repository <git-repository> \\
  --installed-fx <absolute-installed-fmx-fx> \\
  --gate-evidence <canonical-json-file> \\
  --real-process-evidence <canonical-json-file>

Materializes the exact frozen Phase 1C product without modifying its checkout,
bundles its source-independent fixture and owned contracts, and freezes two
separately produced acceptance inputs. This command does not run, install,
publish, or substitute for either gate. Phase 1B manifests and authority are
not read or reused.
`

const digestSchema = z.string().regex(DIGEST)
const commitSchema = z.string().regex(COMMIT)
const idSchema = z.string().min(1).max(160).regex(SAFE_ID)
const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "must be a safe relative path",
  )
const artifactSchema = z.strictObject({
  bytes: z.number().int().nonnegative().max(16 * 1024 * 1024),
  digest: digestSchema,
  mode: z.enum(["0600", "0700"]),
  path: pathSchema,
})
const repositorySchema = z.strictObject({
  commit: commitSchema,
  tree: commitSchema,
})
const commandSchema = z.strictObject({
  argv: z.array(z.string().min(1).max(4096)).min(1).max(128),
  exit_status: z.literal(0),
})
const assertionSchema = z.strictObject({
  id: idSchema,
  passed: z.literal(true),
})
const fxEvidenceSchema = z.strictObject({
  commit: commitSchema,
  binary_sha256: digestSchema,
  private_provider_contract_sha256: digestSchema,
})
const authorityIdentitySchema = repositorySchema.extend({
  plan_path: z.literal("agentworkplace-implementation-plan.md"),
  plan_sha256: digestSchema,
})
const fxDerivationSchema = z.strictObject({
  binary: z.strictObject({ digest: digestSchema, probe: z.literal("passed") }),
  contract: z.strictObject({
    digest: digestSchema,
    fx_path: z.literal("src/core/control/launch_provider.md"),
    artifact: z.literal(PHASE1C_FX_CONTRACT_PATH),
  }),
  source_repository: repositorySchema,
})

export const PHASE1C_REQUIRED_GATE_SCENARIOS = [
  "phase1c.runtime-extension-fixture",
  "phase1c.lifecycle-restart",
  "phase1c.private-fx-launch-provider",
  "phase1c.ensure-lifecycle-recovery",
  "phase1c.exact-agent-retirement",
  "phase1c.inline-launch-source",
  "phase1c.exact-worktree-cleanup",
  "phase1c.managed-start-replay",
] as const

export const PHASE1C_REQUIRED_REAL_PROCESS_ASSERTIONS = [
  "private-provider-launch",
  "runtime-restart-replay",
  "exact-agent-retirement",
  "foreign-replacement-preserved",
  "cleanup-effect-not-repeated",
] as const

export const Phase1cGateEvidenceV1Schema = z
  .strictObject({
    schema_id: z.literal("fmx.phase1c-gate-evidence"),
    schema_version: z.literal(1),
    status: z.literal("passed"),
    product_repository: repositorySchema,
    fx: fxEvidenceSchema,
    command: commandSchema,
    receipt: z.strictObject({
      pass: z.number().int().positive(),
      fail: z.literal(0),
      skip: z.number().int().nonnegative(),
      tests: z.number().int().positive(),
      files: z.number().int().positive(),
      expectations: z.number().int().positive(),
    }),
    scenarios: z.array(idSchema).min(1).max(256),
    source_paths: z.array(pathSchema).min(1).max(256),
  })
  .superRefine((value, context) => {
    if (new Set(value.scenarios).size !== value.scenarios.length) {
      context.addIssue({ code: "custom", message: "duplicate gate scenario", path: ["scenarios"] })
    }
    if (new Set(value.source_paths).size !== value.source_paths.length) {
      context.addIssue({ code: "custom", message: "duplicate gate source path", path: ["source_paths"] })
    }
    for (const required of PHASE1C_REQUIRED_GATE_SCENARIOS) {
      if (!value.scenarios.includes(required)) {
        context.addIssue({ code: "custom", message: `missing required gate scenario ${required}`, path: ["scenarios"] })
      }
    }
    if (value.receipt.pass + value.receipt.skip !== value.receipt.tests) {
      context.addIssue({ code: "custom", message: "gate pass and skip counts must account for every test", path: ["receipt"] })
    }
  })

export const Phase1cRealProcessEvidenceV1Schema = z
  .strictObject({
    schema_id: z.literal("fmx.phase1c-real-process-evidence"),
    schema_version: z.literal(1),
    status: z.literal("passed"),
    product_repository: repositorySchema,
    fx: fxEvidenceSchema,
    command: commandSchema,
    assertions: z.array(assertionSchema).min(1).max(128),
    source_paths: z.array(pathSchema).min(1).max(256),
  })
  .superRefine((value, context) => {
    const ids = value.assertions.map(({ id }) => id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "duplicate real-process assertion", path: ["assertions"] })
    }
    if (new Set(value.source_paths).size !== value.source_paths.length) {
      context.addIssue({ code: "custom", message: "duplicate real-process source path", path: ["source_paths"] })
    }
    for (const required of PHASE1C_REQUIRED_REAL_PROCESS_ASSERTIONS) {
      if (!ids.includes(required)) {
        context.addIssue({ code: "custom", message: `missing required real-process assertion ${required}`, path: ["assertions"] })
      }
    }
  })

const featureSchema = z.strictObject({
  id: idSchema,
  contract: z.string().min(1).max(1024),
  tests: z.array(pathSchema).min(1).max(64),
})

export const Phase1cProviderManifestV1Schema = z
  .strictObject({
    schema_id: z.literal("fmx.phase1c-provider"),
    schema_version: z.literal(1),
    package: z.strictObject({ name: z.literal("fmx.phase1c-provider"), version: z.literal("1") }),
    authority: z.strictObject({
      phase: z.literal("1c"),
      plan: z.literal("AgentWorkplace Plan Revision 1"),
      commit: commitSchema,
      tree: commitSchema,
      plan_path: z.literal("agentworkplace-implementation-plan.md"),
      plan_sha256: digestSchema,
      source: z.literal("frozen-phase1c-handoff"),
    }),
    product_repository: repositorySchema.extend({ parents: z.array(commitSchema).min(1).max(8), name: z.literal("fmx") }),
    provider_repository: repositorySchema.extend({ name: z.literal("fmx") }),
    fx_provider: z.strictObject({
      commit: commitSchema,
      binary_sha256: digestSchema,
      private_provider_contract_sha256: digestSchema,
      fmx_client_sha256: digestSchema,
      pin_sha256: digestSchema,
      source_tree: commitSchema,
      contract_artifact: z.literal(PHASE1C_FX_CONTRACT_PATH),
      schema_id: z.literal("fx.private-launch-provider"),
      schema_version: z.literal(1),
    }),
    contracts: z.strictObject({
      owner_manifest_sha256: digestSchema,
      fixtures: z.array(z.strictObject({ path: pathSchema, schema_id: idSchema, sha256: digestSchema })).min(4).max(16),
    }),
    fixture: z.strictObject({
      artifact: z.literal(PHASE1C_FIXTURE_PATH),
      digest: digestSchema,
      protocol_only_stdio: z.literal(true),
      replay_mode: z.literal("deterministic-source-independent"),
    }),
    evidence_inputs: z.strictObject({
      local_gate: artifactSchema.extend({ path: z.literal(PHASE1C_GATE_INPUT_PATH) }),
      real_process: artifactSchema.extend({ path: z.literal(PHASE1C_REAL_PROCESS_INPUT_PATH) }),
    }),
    features: z.array(featureSchema).min(1).max(64),
    source_inventory: z.array(artifactSchema).min(1).max(256),
    provider_source_inventory: z.array(artifactSchema).min(1).max(16),
    fx_source_inventory: z.array(artifactSchema).length(1),
    artifacts: z.array(artifactSchema).min(1).max(512),
  })
  .superRefine((value, context) => {
    for (const [label, paths] of [
      ["feature ids", value.features.map(({ id }) => id)],
      ["source paths", value.source_inventory.map(({ path }) => path)],
      ["provider source paths", value.provider_source_inventory.map(({ path }) => path)],
      ["Fx source paths", value.fx_source_inventory.map(({ path }) => path)],
      ["artifact paths", value.artifacts.map(({ path }) => path)],
    ] as const) {
      if (new Set(paths).size !== paths.length) {
        context.addIssue({ code: "custom", message: `duplicate ${label}` })
      }
    }
  })

export const Phase1cGenerationEvidenceV1Schema = z.strictObject({
  schema_id: z.literal("fmx.phase1c-provider-generation-evidence"),
  schema_version: z.literal(1),
  accepted: z.literal(true),
  authority_commit: commitSchema,
  authority_repository: authorityIdentitySchema,
  product_repository: repositorySchema,
  provider_repository: repositorySchema,
  generator: z.strictObject({ path: pathSchema, digest: digestSchema }),
  source_materialization: z.literal("private detached fetch of the exact product commit"),
  gate_input: artifactSchema,
  real_process_input: artifactSchema,
  fixture: z.strictObject({ digest: digestSchema, smoke: z.literal("passed") }),
  fx_derivation: fxDerivationSchema,
  output_inventory: z.array(artifactSchema).min(1).max(512),
})

export const PHASE1C_EVIDENCE_PATHS = [
  "CONTEXT.md",
  "README.md",
  "docs/inline-launch-controls-v2.md",
  "fx.json",
  "companion.json",
  "package.json",
  "scripts/local-gate.sh",
  "scripts/phase1c-real-process-cleanup.ts",
  "scripts/phase1c-real-process-composition-acceptance.sh",
  "scripts/phase1c-real-process-evidence.ts",
  "src/agent-manifest.ts",
  "src/agent-reconcile.ts",
  "src/agent-transport.ts",
  "src/agentworkplace-contracts.ts",
  "src/companion-client.ts",
  "src/companion-transport.ts",
  "src/contract-codec.ts",
  "src/ensure-lifecycle-ledger.ts",
  "src/ensure-lifecycle-receipt.ts",
  "src/exact-agent-retirement.ts",
  "src/exact-retirement-ledger.ts",
  "src/exact-worktree-creation.ts",
  "src/file-lock.ts",
  "src/fx-launch-provider.ts",
  "src/fx-work-control.ts",
  "src/git-safe-worktree-cleanup-runner.ts",
  "src/git-safe-worktree-cleanup.ts",
  "src/index.ts",
  "src/inline-launch-source.ts",
  "src/lifecycle-coordinator.ts",
  "src/lifecycle-runtime.ts",
  "src/multiplexer.ts",
  "src/private-directory.ts",
  "src/runtime-extension-host.ts",
  "src/runtime-extension.ts",
  "src/runtime-member-correlation.ts",
  "src/zmx-command.ts",
  "src/zmx-environment.ts",
  "tests/agent-manifest.test.ts",
  "tests/agent-reconcile.test.ts",
  "tests/companion-client.test.ts",
  "tests/companion-transport.test.ts",
  "tests/ensure-lifecycle-ledger.test.ts",
  "tests/ensure-lifecycle-receipt.test.ts",
  "tests/exact-agent-retirement.test.ts",
  "tests/exact-retirement-ledger.test.ts",
  "tests/exact-worktree-creation.test.ts",
  "tests/fixtures/exact-retirement.ts",
  "tests/fixtures/phase1c-runtime-extension.ts",
  "tests/fx-launch-provider.test.ts",
  "tests/git-safe-worktree-cleanup.test.ts",
  "tests/inline-launch-source.test.ts",
  "tests/lifecycle-coordinator.test.ts",
  "tests/lifecycle-runtime.test.ts",
  "tests/multiplexer-managed-start.test.ts",
  "tests/phase1c-lifecycle-restart-acceptance.test.ts",
  "tests/phase1c-real-process-composition-acceptance.test.ts",
  "tests/phase1c-real-process-evidence.test.ts",
  "tests/phase1c-runtime-extension-fixture.test.ts",
  "tests/runtime-member-correlation.test.ts",
] as const

export const PHASE1C_FEATURES = [
  { id: "durable-ensure-lifecycle", contract: "ensure intent and authoritative effects replay without duplicating creation or admission", tests: ["tests/ensure-lifecycle-ledger.test.ts", "tests/lifecycle-runtime.test.ts"] },
  { id: "durable-inline-launch-source", contract: "immutable work and launch controls bind once to exact ensure authority", tests: ["tests/inline-launch-source.test.ts", "tests/lifecycle-runtime.test.ts"] },
  { id: "exact-worktree-creation", contract: "one exact repository, base commit, branch, and Worktree survive crash recovery", tests: ["tests/exact-worktree-creation.test.ts", "tests/phase1c-lifecycle-restart-acceptance.test.ts"] },
  { id: "private-fx-launch-provider", contract: "fmx delegates native launch admission and final authority to the pinned private Fx provider", tests: ["tests/fx-launch-provider.test.ts", "tests/lifecycle-runtime.test.ts", "tests/phase1c-real-process-composition-acceptance.test.ts"] },
  { id: "exact-agent-retirement", contract: "end receipts and final Fx authority are retained and acknowledged exactly", tests: ["tests/exact-agent-retirement.test.ts", "tests/exact-retirement-ledger.test.ts"] },
  { id: "compare-and-remove-cleanup", contract: "cleanup removes only the originally proven Worktree and preserves a foreign replacement", tests: ["tests/git-safe-worktree-cleanup.test.ts", "tests/phase1c-lifecycle-restart-acceptance.test.ts"] },
  { id: "runtime-restart-replay", contract: "stable lifecycle intents and acknowledgements replay byte-identically across Runtime generations", tests: ["tests/phase1c-runtime-extension-fixture.test.ts", "tests/phase1c-lifecycle-restart-acceptance.test.ts"] },
  { id: "source-independent-fixture", contract: "the bundled protocol-only fixture drives deterministic ensure, end, cleanup, and restart replay", tests: ["tests/phase1c-runtime-extension-fixture.test.ts"] },
] as const

type Artifact = z.infer<typeof artifactSchema>
type IntendedFile = { readonly bytes: Uint8Array; readonly mode: number; readonly path: string }
type Arguments = {
  readonly output: string
  readonly productCommit: string
  readonly productTree: string
  readonly authorityRepository: string
  readonly authorityCommit: string
  readonly fxRepository: string
  readonly installedFx: string
  readonly gateEvidence: string
  readonly realProcessEvidence: string
}

function parseArguments(argv: readonly string[]): Arguments {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(usage)
    process.exit(0)
  }
  const allowed = new Set([
    "--output",
    "--product-commit",
    "--product-tree",
    "--authority-repository",
    "--authority-commit",
    "--fx-repository",
    "--installed-fx",
    "--gate-evidence",
    "--real-process-evidence",
  ])
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === undefined || !allowed.has(flag)) throw new Error(`unknown argument: ${flag ?? ""}`)
    if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error(`${flag} requires a value`)
    if (values.has(flag)) throw new Error(`${flag} may be provided only once`)
    values.set(flag, value)
  }
  const required = (flag: string): string => {
    const value = values.get(flag)
    if (value === undefined) throw new Error(`${flag} is required`)
    return value
  }
  const productCommit = required("--product-commit")
  const productTree = required("--product-tree")
  const authorityCommit = required("--authority-commit")
  if (!COMMIT.test(productCommit)) throw new Error("--product-commit must be one full lowercase commit")
  if (!COMMIT.test(productTree)) throw new Error("--product-tree must be one full lowercase tree")
  if (!COMMIT.test(authorityCommit)) throw new Error("--authority-commit must be one full lowercase commit")
  return {
    output: resolve(required("--output")),
    productCommit,
    productTree,
    authorityRepository: resolve(required("--authority-repository")),
    authorityCommit,
    fxRepository: resolve(required("--fx-repository")),
    installedFx: required("--installed-fx"),
    gateEvidence: resolve(required("--gate-evidence")),
    realProcessEvidence: resolve(required("--real-process-evidence")),
  }
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key] as JsonValue)]))
}

export function canonicalPhase1cJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function artifact(file: IntendedFile): Artifact {
  return {
    bytes: file.bytes.byteLength,
    digest: sha256(file.bytes),
    mode: file.mode === EXECUTABLE_MODE ? "0700" : "0600",
    path: file.path,
  }
}

function git(repository: string, args: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", ...args],
    cwd: repository,
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${decoder.decode(result.stderr).trim()}`)
  return decoder.decode(result.stdout).trim()
}

function gitBytes(repository: string, args: readonly string[]): Uint8Array {
  const result = Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", ...args],
    cwd: repository,
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${decoder.decode(result.stderr).trim()}`)
  return new Uint8Array(result.stdout)
}

async function requireAuthority(repository: string, commit: string): Promise<z.infer<typeof authorityIdentitySchema>> {
  const root = await realpath(repository)
  const facts = await lstat(root)
  if (!facts.isDirectory()) throw new Error("authority repository must be one real Git repository")
  const resolved = git(root, ["rev-parse", "--verify", `${commit}^{commit}`])
  if (resolved !== commit) throw new Error("authority commit does not exist in the explicit authority repository")
  const tree = git(root, ["rev-parse", "--verify", `${commit}^{tree}`])
  const planPath = "agentworkplace-implementation-plan.md" as const
  const plan = gitBytes(root, ["show", `${commit}:${planPath}`])
  if (plan.byteLength === 0) throw new Error("authority commit has no frozen AgentWorkplace plan")
  return authorityIdentitySchema.parse({
    commit,
    tree,
    plan_path: planPath,
    plan_sha256: sha256(plan),
  })
}

async function requireInstalledFx(path: string): Promise<{ bytes: Uint8Array; path: string }> {
  if (!isAbsolute(path)) throw new Error("--installed-fx must be an absolute path")
  const physical = await realpath(path)
  if (physical !== path) throw new Error("--installed-fx must name its canonical path")
  const facts = await lstat(physical)
  if (!facts.isFile() || facts.isSymbolicLink() || (facts.mode & 0o111) === 0) {
    throw new Error("--installed-fx must be one executable regular file")
  }
  await Bun.file(physical).exists()
  return { bytes: new Uint8Array(await readFile(physical)), path: physical }
}

function probeInstalledFx(path: string, fxnk: string): void {
  const version = Bun.spawnSync({
    cmd: [path, "--fxnk-version"],
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = decoder.decode(version.stdout)
  if (version.exitCode !== 0 || version.stderr.byteLength !== 0 || !stdout.startsWith(`fxnk ${fxnk} (fx `) || !stdout.endsWith(")\n")) {
    throw new Error("installed fmx-fx failed the exact pinned fxnk version probe")
  }
  const provider = Bun.spawnSync({
    cmd: [path, "--internal-launch-provider"],
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (provider.exitCode === 0 || provider.stdout.byteLength !== 0 || !decoder.decode(provider.stderr).includes("IncompleteLaunchProviderConfiguration")) {
    throw new Error("installed fmx-fx failed the private launch-provider probe")
  }
}

async function deriveFxAuthority(productRoot: string, fxRepository: string, installedFx: string): Promise<{
  readonly evidence: z.infer<typeof fxEvidenceSchema>
  readonly derivation: z.infer<typeof fxDerivationSchema>
  readonly contractBytes: Uint8Array
}> {
  const fxPinBytes = new Uint8Array(await readFile(join(productRoot, "fx.json")))
  const fxPin = z.strictObject({
    repository: z.string().url(),
    branch: z.string().min(1),
    commit: commitSchema,
    fxnk: z.string().min(1),
  }).parse(JSON.parse(decoder.decode(fxPinBytes)))
  const repository = await realpath(fxRepository)
  const commit = git(repository, ["rev-parse", "--verify", `${fxPin.commit}^{commit}`])
  if (commit !== fxPin.commit) throw new Error("frozen fmx Fx pin is absent from the explicit Fx repository")
  const tree = git(repository, ["rev-parse", "--verify", `${commit}^{tree}`])
  const fxContractPath = "src/core/control/launch_provider.md" as const
  const fxContract = gitBytes(repository, ["show", `${commit}:${fxContractPath}`])
  const binary = await requireInstalledFx(installedFx)
  probeInstalledFx(binary.path, fxPin.fxnk)
  const contractDigest = sha256(fxContract)
  const binaryDigest = sha256(binary.bytes)
  return {
    evidence: {
      commit,
      binary_sha256: binaryDigest,
      private_provider_contract_sha256: contractDigest,
    },
    derivation: {
      binary: { digest: binaryDigest, probe: "passed" },
      contract: { digest: contractDigest, fx_path: fxContractPath, artifact: PHASE1C_FX_CONTRACT_PATH },
      source_repository: { commit, tree },
    },
    contractBytes: fxContract,
  }
}

function requireProduct(provider: RepositorySnapshot, productCommit: string, productTree: string): readonly string[] {
  if (git(provider.repositoryRoot, ["rev-parse", "--verify", `${productCommit}^{tree}`]) !== productTree) {
    throw new Error("Phase 1C product commit does not name the frozen tree")
  }
  const parents = git(provider.repositoryRoot, ["show", "-s", "--format=%P", productCommit]).split(" ").filter(Boolean)
  if (parents.length === 0 || parents.length > 8 || parents.some((parent) => !COMMIT.test(parent))) throw new Error("Phase 1C product has an invalid parent inventory")
  const ancestor = Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", "merge-base", "--is-ancestor", productCommit, provider.headSha],
    cwd: provider.repositoryRoot,
    env: environmentWithoutGitOverrides(),
    stdout: "ignore",
    stderr: "pipe",
  })
  if (ancestor.exitCode !== 0) throw new Error("frozen Phase 1C product is not an ancestor of the provider generator")
  const base = Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", "merge-base", "--is-ancestor", PHASE1C_IMPLEMENTATION_BASE_COMMIT, productCommit],
    cwd: provider.repositoryRoot,
    env: environmentWithoutGitOverrides(),
    stdout: "ignore",
    stderr: "pipe",
  })
  if (base.exitCode !== 0) throw new Error("Phase 1C product does not descend from the approved implementation base")
  return parents
}

async function validateOutput(path: string, provider: RepositorySnapshot): Promise<string> {
  const facts = await lstat(path)
  if (facts.isSymbolicLink() || !facts.isDirectory()) throw new Error("output must be an existing real directory")
  if ((facts.mode & 0o077) !== 0) throw new Error("output directory must be private")
  if ((await readdir(path)).length !== 0) throw new Error("output directory must be empty")
  const physical = await realpath(path)
  if (isWithin(provider.commonGitDirectory, physical) || provider.worktrees.some((worktree) => isWithin(worktree, physical))) {
    throw new Error("output must be outside fmx Git storage and every registered Worktree")
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
  const snapshot = await captureCleanRepositorySnapshot(destination)
  if (snapshot.headSha !== productCommit || snapshot.headTree !== productTree) {
    throw new Error("private product materialization has the wrong identity")
  }
  return snapshot
}

async function readCanonicalEvidence<T>(path: string, schema: z.ZodType<T>, label: string): Promise<{ bytes: Uint8Array; value: T }> {
  const facts = await lstat(path)
  if (facts.isSymbolicLink() || !facts.isFile() || facts.size > MAX_EVIDENCE_BYTES) throw new Error(`${label} must be one bounded real file`)
  const bytes = new Uint8Array(await readFile(path))
  const parsed = schema.parse(decodeStrictJson(bytes))
  const canonical = encoder.encode(canonicalPhase1cJson(parsed as unknown as JsonValue))
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) throw new Error(`${label} is not canonical Phase 1C JSON`)
  return { bytes, value: parsed }
}

async function materializeProductDependencies(productRoot: string): Promise<void> {
  const result = Bun.spawnSync({
    cmd: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    cwd: productRoot,
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `could not materialize the frozen product dependencies: ${decoder.decode(result.stderr).trim()}`,
    )
  }
}

export async function buildPhase1cFixture(productRoot: string, output: string): Promise<Uint8Array> {
  const result = Bun.spawnSync({
    cmd: ["bun", "build", "tests/fixtures/phase1c-runtime-extension.ts", "--target=bun", "--outfile", output],
    cwd: productRoot,
    env: environmentWithoutGitOverrides(),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`could not bundle Phase 1C fixture: ${decoder.decode(result.stderr).trim()}`)
  await chmod(output, EXECUTABLE_MODE)
  return new Uint8Array(await readFile(output))
}

export async function verifyPhase1cFixture(path: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "fmx-phase1c-fixture-smoke-"))
  try {
    const child = Bun.spawn([process.execPath, path], {
      env: {
        ...environmentWithoutGitOverrides(),
        FMX_PHASE1C_FIXTURE_STATE: join(scratch, "state.json"),
        FMX_PHASE1C_FIXTURE_EMISSION: "replay_only",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const initialize = {
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "initialize",
      request_id: "phase1c-provider-smoke",
      workplace_instance_id: "phase1c-provider-workplace",
      extension_id: "phase1c-provider-extension",
      configuration_id: "phase1c-provider-configuration",
      placement_id: "phase1c-provider-placement",
      fmx_session: "phase1c-provider-session",
      protocol_version: AGENTWORKPLACE_CONTRACT_VERSION,
    } as const
    child.stdin.write(encodeAgentWorkplaceFrame(initialize))
    child.stdin.end()
    const [output, diagnostic, status] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (status !== 0 || diagnostic.length !== 0) throw new Error(`Phase 1C fixture smoke exited ${status}: ${diagnostic}`)
    const frames = new ContractFrameDecoder()
    const payloads = frames.push(new Uint8Array(output))
    frames.finish()
    if (payloads.length !== 1) throw new Error("Phase 1C fixture smoke did not return exactly one readiness frame")
    const ready = runtimeExtensionMessageSchema.parse(decodeAgentWorkplacePayload(payloads[0]!))
    if (ready.message_type !== "ready" || !("request_id" in ready) || ready.request_id !== initialize.request_id) {
      throw new Error("Phase 1C fixture smoke returned uncorrelated readiness")
    }
  } finally {
    await rm(scratch, { recursive: true })
  }
}

async function productFiles(
  productRoot: string,
  additionalPaths: readonly string[],
  contractPaths: readonly string[],
): Promise<IntendedFile[]> {
  const files: IntendedFile[] = []
  const sourcePaths = [...new Set([...PHASE1C_EVIDENCE_PATHS, ...additionalPaths])].sort()
  for (const sourcePath of sourcePaths) {
    files.push({
      bytes: new Uint8Array(await readFile(join(productRoot, sourcePath))),
      mode: FILE_MODE,
      path: join("artifacts/source", sourcePath),
    })
  }
  for (const fixture of [...new Set(["manifest.json", ...contractPaths])].sort()) {
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

export function buildPhase1cProviderManifest(input: {
  readonly authority: z.infer<typeof authorityIdentitySchema>
  readonly product: { readonly commit: string; readonly tree: string; readonly parents: readonly string[] }
  readonly provider: { readonly commit: string; readonly tree: string }
  readonly fx: {
    readonly commit: string
    readonly binarySha256: string
    readonly privateProviderContractSha256: string
    readonly clientSha256: string
    readonly pinSha256: string
    readonly sourceTree: string
  }
  readonly contracts: { readonly manifestSha256: string; readonly fixtures: readonly { path: string; schema_id: string; sha256: string }[] }
  readonly fixtureDigest: string
  readonly gateInput: Artifact
  readonly realProcessInput: Artifact
  readonly sources: readonly Artifact[]
  readonly providerSources: readonly Artifact[]
  readonly fxSources: readonly Artifact[]
  readonly artifacts: readonly Artifact[]
}): JsonValue {
  return Phase1cProviderManifestV1Schema.parse({
    schema_id: "fmx.phase1c-provider",
    schema_version: 1,
    package: { name: "fmx.phase1c-provider", version: "1" },
    authority: {
      phase: "1c",
      plan: "AgentWorkplace Plan Revision 1",
      ...input.authority,
      source: "frozen-phase1c-handoff",
    },
    product_repository: { name: "fmx", ...input.product },
    provider_repository: { name: "fmx", ...input.provider },
    fx_provider: {
      commit: input.fx.commit,
      binary_sha256: input.fx.binarySha256,
      private_provider_contract_sha256: input.fx.privateProviderContractSha256,
      fmx_client_sha256: input.fx.clientSha256,
      pin_sha256: input.fx.pinSha256,
      source_tree: input.fx.sourceTree,
      contract_artifact: PHASE1C_FX_CONTRACT_PATH,
      schema_id: FX_LAUNCH_PROVIDER_SCHEMA_ID,
      schema_version: FX_LAUNCH_PROVIDER_SCHEMA_VERSION,
    },
    contracts: { owner_manifest_sha256: input.contracts.manifestSha256, fixtures: input.contracts.fixtures },
    fixture: { artifact: PHASE1C_FIXTURE_PATH, digest: input.fixtureDigest, protocol_only_stdio: true, replay_mode: "deterministic-source-independent" },
    evidence_inputs: { local_gate: input.gateInput, real_process: input.realProcessInput },
    features: PHASE1C_FEATURES,
    source_inventory: input.sources,
    provider_source_inventory: input.providerSources,
    fx_source_inventory: input.fxSources,
    artifacts: input.artifacts,
  }) as unknown as JsonValue
}

async function main(): Promise<void> {
  const args = parseArguments(Bun.argv.slice(2))
  const provider = await captureCleanRepositorySnapshot(REPOSITORY_ROOT)
  const productParents = requireProduct(provider, args.productCommit, args.productTree)
  const output = await validateOutput(args.output, provider)
  const authority = await requireAuthority(args.authorityRepository, args.authorityCommit)
  const gate = await readCanonicalEvidence(args.gateEvidence, Phase1cGateEvidenceV1Schema, "Phase 1C gate evidence")
  const realProcess = await readCanonicalEvidence(args.realProcessEvidence, Phase1cRealProcessEvidenceV1Schema, "Phase 1C real-process evidence")
  for (const [label, identity] of [["gate", gate.value.product_repository], ["real-process", realProcess.value.product_repository]] as const) {
    if (identity.commit !== args.productCommit || identity.tree !== args.productTree) throw new Error(`${label} evidence names another product`)
  }

  const sourceRoot = await mkdtemp(join(tmpdir(), "fmx-phase1c-provider-source-"))
  await chmod(sourceRoot, DIRECTORY_MODE)
  try {
    const productRoot = join(sourceRoot, "fmx")
    const productSnapshot = await materializeProduct(provider, args.productCommit, args.productTree, productRoot)
    await materializeProductDependencies(productRoot)
    const fxPinBytes = new Uint8Array(await readFile(join(productRoot, "fx.json")))
    const fxAuthority = await deriveFxAuthority(productRoot, args.fxRepository, args.installedFx)
    for (const [label, identity] of [["gate", gate.value.fx], ["real-process", realProcess.value.fx]] as const) {
      if (JSON.stringify(identity) !== JSON.stringify(fxAuthority.evidence)) {
        throw new Error(`${label} evidence Fx identity does not match the independently derived installed provider`)
      }
    }

    const contractVerification = await verifyAgentWorkplaceContracts(join(productRoot, "contracts/agentworkplace/v1"))
    const fixtureOutput = join(sourceRoot, "phase1c-runtime-extension-fixture.js")
    const fixtureBytes = await buildPhase1cFixture(productRoot, fixtureOutput)
    await verifyPhase1cFixture(fixtureOutput)

    const artifacts = await productFiles(productRoot, [
      ...gate.value.source_paths,
      ...realProcess.value.source_paths,
    ], contractVerification.fixtures.map(({ path }) => path))
    const generatorBytes = new Uint8Array(await readFile(join(REPOSITORY_ROOT, "scripts/generate-agentworkplace-phase1c-provider.ts")))
    artifacts.push({
      bytes: generatorBytes,
      mode: FILE_MODE,
      path: "artifacts/provider-source/scripts/generate-agentworkplace-phase1c-provider.ts",
    })
    artifacts.push({
      bytes: fxAuthority.contractBytes,
      mode: FILE_MODE,
      path: PHASE1C_FX_CONTRACT_PATH,
    })
    artifacts.push({ bytes: fixtureBytes, mode: EXECUTABLE_MODE, path: PHASE1C_FIXTURE_PATH })
    artifacts.push({ bytes: gate.bytes, mode: FILE_MODE, path: PHASE1C_GATE_INPUT_PATH })
    artifacts.push({ bytes: realProcess.bytes, mode: FILE_MODE, path: PHASE1C_REAL_PROCESS_INPUT_PATH })
    const artifactRecords = artifacts.map(artifact).sort((left, right) => left.path.localeCompare(right.path))
    const sourceRecords = artifactRecords.filter(({ path }) => path.startsWith("artifacts/source/"))
    const providerSourceRecords = artifactRecords.filter(({ path }) => path.startsWith("artifacts/provider-source/"))
    const fxSourceRecords = artifactRecords.filter(({ path }) => path.startsWith("artifacts/fx-source/"))
    const gateInput = artifactRecords.find(({ path }) => path === PHASE1C_GATE_INPUT_PATH)!
    const realProcessInput = artifactRecords.find(({ path }) => path === PHASE1C_REAL_PROCESS_INPUT_PATH)!
    const fixtureRecords = contractVerification.fixtures.map((entry) => ({
      path: `artifacts/contracts/agentworkplace/v1/${entry.path}`,
      schema_id: entry.schema_id,
      sha256: `sha256:${entry.sha256}`,
    }))
    const manifestValue = buildPhase1cProviderManifest({
      authority,
      product: { commit: args.productCommit, tree: args.productTree, parents: productParents },
      provider: { commit: provider.headSha, tree: provider.headTree },
      fx: {
        commit: fxAuthority.evidence.commit,
        binarySha256: fxAuthority.evidence.binary_sha256,
        privateProviderContractSha256: fxAuthority.evidence.private_provider_contract_sha256,
        clientSha256: sha256(await readFile(join(productRoot, "src/fx-launch-provider.ts"))),
        pinSha256: sha256(fxPinBytes),
        sourceTree: fxAuthority.derivation.source_repository.tree,
      },
      contracts: { manifestSha256: `sha256:${contractVerification.manifest_sha256}`, fixtures: fixtureRecords },
      fixtureDigest: sha256(fixtureBytes),
      gateInput,
      realProcessInput,
      sources: sourceRecords,
      providerSources: providerSourceRecords,
      fxSources: fxSourceRecords,
      artifacts: artifactRecords,
    })
    const manifest: IntendedFile = {
      bytes: encoder.encode(canonicalPhase1cJson(manifestValue)),
      mode: FILE_MODE,
      path: PHASE1C_PROVIDER_MANIFEST_PATH,
    }
    const generationValue = Phase1cGenerationEvidenceV1Schema.parse({
      schema_id: "fmx.phase1c-provider-generation-evidence",
      schema_version: 1,
      accepted: true,
      authority_commit: args.authorityCommit,
      authority_repository: authority,
      product_repository: { commit: args.productCommit, tree: args.productTree },
      provider_repository: { commit: provider.headSha, tree: provider.headTree },
      generator: { path: "scripts/generate-agentworkplace-phase1c-provider.ts", digest: sha256(generatorBytes) },
      source_materialization: "private detached fetch of the exact product commit",
      gate_input: gateInput,
      real_process_input: realProcessInput,
      fixture: { digest: sha256(fixtureBytes), smoke: "passed" },
      fx_derivation: fxAuthority.derivation,
      output_inventory: [...artifactRecords, artifact(manifest)].sort((left, right) => left.path.localeCompare(right.path)),
    })
    const generation: IntendedFile = {
      bytes: encoder.encode(canonicalPhase1cJson(generationValue as unknown as JsonValue)),
      mode: FILE_MODE,
      path: PHASE1C_GENERATION_EVIDENCE_PATH,
    }
    for (const file of [...artifacts, manifest, generation]) await writeExclusive(output, file)
    await assertRepositorySnapshotStable(productRoot, productSnapshot)
    await assertRepositorySnapshotStable(REPOSITORY_ROOT, provider)
    process.stdout.write(`${JSON.stringify({
      accepted: true,
      bundle: output,
      manifest: join(output, PHASE1C_PROVIDER_MANIFEST_PATH),
      manifest_digest: artifact(manifest).digest,
      generation_evidence: join(output, PHASE1C_GENERATION_EVIDENCE_PATH),
      generation_evidence_digest: artifact(generation).digest,
      product_commit: args.productCommit,
      product_tree: args.productTree,
      provider_commit: provider.headSha,
      provider_tree: provider.headTree,
      fx_commit: fxAuthority.evidence.commit,
      real_process_evidence_digest: realProcessInput.digest,
    })}\n`)
  } finally {
    await rm(sourceRoot, { recursive: true })
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`fmx Phase 1C provider: ${error instanceof Error ? error.message : String(error)}\n${usage}`)
    process.exitCode = 1
  }
}
