#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import { chmod, link, lstat, open, readFile, realpath, unlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import fxPin from "../fx.json" with { type: "json" }

const COMMIT = /^[0-9a-f]{40}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SAFE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const commitSchema = z.string().regex(COMMIT)
const digestSchema = z.string().regex(DIGEST)
const idSchema = z.string().min(1).max(160).regex(SAFE_ID)
const pathSchema = z.string().min(1).max(4096).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
  "must be a safe relative path",
)

export const PHASE1C_REQUIRED_REAL_PROCESS_ASSERTIONS = [
  "private-provider-launch",
  "runtime-restart-replay",
  "exact-agent-retirement",
  "foreign-replacement-preserved",
  "cleanup-effect-not-repeated",
] as const

export const PHASE1C_COMPOSITION_ASSERTIONS = [
  ...PHASE1C_REQUIRED_REAL_PROCESS_ASSERTIONS,
  "one-companion-pid",
  "one-native-turn",
  "ensure-receipt-durable",
  "fx-final-receipt-acknowledged",
  "end-receipt-exact",
  "dirty-cleanup-refused",
  "foreign-replacement-refused-mismatch",
  "work-control-socket-removed",
  "runner-cleanup-complete",
  "final-companion-inventory-empty",
] as const

/** SHA-256 of Fx's src/core/control/launch_provider.md at fx.json's pinned commit. */
export const FX_PRIVATE_PROVIDER_CONTRACT_SHA256 =
  "sha256:58d191ee8628e0863a2451ff2b672f94484ca01aee20b5ab6f21d576a898fa1c" as const

export const Phase1cRealProcessEvidenceV1Schema = z.strictObject({
  schema_id: z.literal("fmx.phase1c-real-process-evidence"),
  schema_version: z.literal(1),
  status: z.literal("passed"),
  product_repository: z.strictObject({ commit: commitSchema, tree: commitSchema }),
  fx: z.strictObject({
    commit: commitSchema,
    binary_sha256: digestSchema,
    private_provider_contract_sha256: digestSchema,
  }),
  command: z.strictObject({
    argv: z.array(z.string().min(1).max(4096)).min(1).max(128),
    exit_status: z.literal(0),
  }),
  assertions: z.array(z.strictObject({ id: idSchema, passed: z.literal(true) })).min(1).max(128),
  source_paths: z.array(pathSchema).min(1).max(256),
}).superRefine((value, context) => {
  const assertionIds = value.assertions.map(({ id }) => id)
  if (new Set(assertionIds).size !== assertionIds.length) {
    context.addIssue({ code: "custom", message: "duplicate real-process assertion", path: ["assertions"] })
  }
  if (new Set(value.source_paths).size !== value.source_paths.length) {
    context.addIssue({ code: "custom", message: "duplicate real-process source path", path: ["source_paths"] })
  }
  for (const required of PHASE1C_REQUIRED_REAL_PROCESS_ASSERTIONS) {
    if (!assertionIds.includes(required)) {
      context.addIssue({
        code: "custom",
        message: `missing required real-process assertion ${required}`,
        path: ["assertions"],
      })
    }
  }
})

const cleanupSummarySchema = z.strictObject({
  schema_id: z.literal("fmx.phase1c-real-process-runner-cleanup"),
  schema_version: z.literal(1),
  reaped: z.literal(true),
  final_sessions: z.literal(0),
  observed_pids: z.array(z.number().int().positive()).max(16),
})

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function canonicalPhase1cEvidenceJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`
}

export function buildPhase1cRealProcessEvidence(input: {
  productCommit: string
  productTree: string
  fxBinarySha256: string
}) {
  return Phase1cRealProcessEvidenceV1Schema.parse({
    schema_id: "fmx.phase1c-real-process-evidence",
    schema_version: 1,
    status: "passed",
    product_repository: { commit: input.productCommit, tree: input.productTree },
    fx: {
      commit: fxPin.commit,
      binary_sha256: input.fxBinarySha256,
      private_provider_contract_sha256: FX_PRIVATE_PROVIDER_CONTRACT_SHA256,
    },
    command: {
      argv: ["scripts/phase1c-real-process-composition-acceptance.sh"],
      exit_status: 0,
    },
    assertions: PHASE1C_COMPOSITION_ASSERTIONS.map((id) => ({ id, passed: true as const })),
    source_paths: [
      "fx.json",
      "scripts/phase1c-real-process-cleanup.ts",
      "scripts/phase1c-real-process-composition-acceptance.sh",
      "scripts/phase1c-real-process-evidence.ts",
      "src/companion-transport.ts",
      "src/exact-agent-retirement.ts",
      "src/fx-launch-provider.ts",
      "src/fx-work-control.ts",
      "src/git-safe-worktree-cleanup.ts",
      "src/lifecycle-runtime.ts",
      "tests/phase1c-real-process-composition-acceptance.test.ts",
      "tests/phase1c-real-process-evidence.test.ts",
    ],
  })
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(Bun.argv.slice(2))
  for (const [flag, value] of [
    ["--output", arguments_.output],
    ["--repository", arguments_.repository],
    ["--fx-path", arguments_.fxPath],
    ["--cleanup-summary", arguments_.cleanupSummary],
  ] as const) {
    if (!isAbsolute(value)) throw new Error(`${flag} must be absolute`)
  }
  const repository = await realpath(arguments_.repository)
  const output = resolve(arguments_.output)
  if (output === repository || output.startsWith(`${repository}/`)) {
    throw new Error("evidence output must be outside the fmx checkout")
  }
  if (await pathExists(output)) throw new Error(`evidence output already exists: ${output}`)

  const cleanupFacts = await lstat(arguments_.cleanupSummary)
  if (!cleanupFacts.isFile() || (cleanupFacts.mode & 0o777) !== 0o600) {
    throw new Error("runner cleanup summary must be a mode-0600 regular file")
  }
  const cleanup = cleanupSummarySchema.parse(JSON.parse(await readFile(arguments_.cleanupSummary, "utf8")))
  if (!cleanup.reaped || cleanup.final_sessions !== 0) {
    throw new Error("runner cleanup did not prove an empty final Companion inventory")
  }

  const status = await git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  if (status.length !== 0) {
    throw new Error("fmx checkout must be clean before binding real-process evidence to HEAD")
  }
  const productCommit = text(await git(repository, ["rev-parse", "--verify", "HEAD"]))
  const productTree = text(await git(repository, ["rev-parse", "--verify", "HEAD^{tree}"]))
  if (!COMMIT.test(productCommit) || !COMMIT.test(productTree)) {
    throw new Error("fmx HEAD did not resolve to exact 40-hex commit and tree identities")
  }
  const fxPhysicalPath = await verifyFxIdentity(arguments_.fxPath)
  const fxBinarySha256 = await fileSha256(fxPhysicalPath)
  const evidence = buildPhase1cRealProcessEvidence({ productCommit, productTree, fxBinarySha256 })
  await writeDurablePrivateFile(output, canonicalPhase1cEvidenceJson(evidence as unknown as JsonValue))
  process.stdout.write(`${output}\n`)
}

function parseArguments(argv: readonly string[]): {
  output: string
  repository: string
  fxPath: string
  cleanupSummary: string
} {
  const allowed = new Set(["--output", "--repository", "--fx-path", "--cleanup-summary"])
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === undefined || !allowed.has(flag)) throw new Error(`unknown argument: ${flag ?? ""}`)
    if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`)
    if (values.has(flag)) throw new Error(`${flag} may be provided once`)
    values.set(flag, value)
  }
  const required = (flag: string): string => {
    const value = values.get(flag)
    if (value === undefined) throw new Error(`${flag} is required`)
    return value
  }
  return {
    output: required("--output"),
    repository: required("--repository"),
    fxPath: required("--fx-path"),
    cleanupSummary: required("--cleanup-summary"),
  }
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key]!)]))
}

function scrubGitEnvironment(parent: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && !key.startsWith("GIT_")) environment[key] = value
  }
  environment.GIT_ATTR_NOSYSTEM = "1"
  environment.GIT_CONFIG_COUNT = "2"
  environment.GIT_CONFIG_GLOBAL = "/dev/null"
  environment.GIT_CONFIG_KEY_0 = "core.attributesFile"
  environment.GIT_CONFIG_KEY_1 = "core.excludesFile"
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_CONFIG_SYSTEM = "/dev/null"
  environment.GIT_CONFIG_VALUE_0 = "/dev/null"
  environment.GIT_CONFIG_VALUE_1 = "/dev/null"
  environment.GIT_NO_REPLACE_OBJECTS = "1"
  environment.GIT_TERMINAL_PROMPT = "0"
  environment.GIT_PAGER = "cat"
  environment.LC_ALL = "C"
  return environment
}

async function git(repository: string, args: readonly string[]): Promise<Uint8Array> {
  const child = Bun.spawn(["git", "--no-replace-objects", ...args], {
    cwd: repository,
    env: scrubGitEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
  return stdout
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()
}

async function verifyFxIdentity(path: string): Promise<string> {
  const physical = await realpath(path)
  const facts = await lstat(physical)
  if (!facts.isFile() || (facts.mode & 0o111) === 0) throw new Error("--fx-path must be an executable regular file")
  const child = Bun.spawn([physical, "--fxnk-version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const expected = `fxnk ${fxPin.fxnk} (fx `
  if (exitCode !== 0 || !stdout.startsWith(expected) || !stdout.endsWith(")\n") || stderr !== "") {
    throw new Error(`Fx binary identity mismatch: ${JSON.stringify({ exitCode, stdout, stderr })}`)
  }
  return physical
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return `sha256:${hash.digest("hex")}`
}

async function writeDurablePrivateFile(path: string, contents: string): Promise<void> {
  const parent = await realpath(dirname(path))
  const destination = join(parent, basename(path))
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
  let handle = null
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await chmod(temporary, 0o600)
    // Hard-link publication is atomic and refuses an existing destination;
    // unlike rename, it cannot overwrite evidence from an earlier run.
    await link(temporary, destination)
    await unlink(temporary)
    const directory = await open(parent, constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
    const facts = await lstat(destination)
    if (!facts.isFile() || (facts.mode & 0o777) !== 0o600) {
      throw new Error("durable evidence is not a mode-0600 regular file")
    }
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`fmx Phase 1C composition evidence: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
