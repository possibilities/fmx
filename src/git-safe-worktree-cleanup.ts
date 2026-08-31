import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import { dirname, isAbsolute, normalize, resolve } from "node:path"
import {
  CONTRACT_MAX_FRAME_BYTES,
  encodeCanonicalJson,
  type JsonValue,
} from "./contract-codec.ts"
import type { EnsureLifecycleRecord } from "./ensure-lifecycle-ledger.ts"
import {
  deriveLifecycleReceiptDigest,
  type CleanupReceipt,
  type CleanupRequest,
  type ExactRetirementLedger,
} from "./exact-retirement-ledger.ts"

const GIT_TIMEOUT_MS = 10_000
const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

export type GitWorktreeSnapshot = {
  kind: "present"
  repository: string
  worktreeDirectory: string
  headCommit: string
  statusDigest: string
  trackedChanges: boolean
  untrackedPaths: string[]
}

export type GitWorktreeInspection =
  | GitWorktreeSnapshot
  | { kind: "absent" }
  | { kind: "mismatch"; message: string }

export type GitWorktreeAuthority = {
  inspect: (repository: string, worktreeDirectory: string) => Promise<GitWorktreeInspection>
  remove: (repository: string, worktreeDirectory: string) => Promise<void>
}

export type GitCommandResult = {
  exitCode: number
  stdout: Uint8Array
  stderr: string
}

export type GitCommandRunner = (
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
) => Promise<GitCommandResult>

export type GitSafeWorktreeCleanupOptions = {
  now?: () => Date
  /** Test-only crash boundary after Git returns but before receipt persistence. */
  afterRemove?: () => void | Promise<void>
}

export class GitCleanupTransientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitCleanupTransientError"
  }
}

/** Production Git authority. Every inspection rebuilds authority from raw Git bytes. */
export class GitSafeWorktreeAuthority implements GitWorktreeAuthority {
  private readonly environment: Readonly<Record<string, string>>

  constructor(
    parentEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly run: GitCommandRunner = runGit,
  ) {
    this.environment = scrubGitEnvironment(parentEnvironment)
  }

  async inspect(repository: string, worktreeDirectory: string): Promise<GitWorktreeInspection> {
    if (!exactAbsolutePath(repository) || !exactAbsolutePath(worktreeDirectory) ||
      repository === worktreeDirectory
    ) {
      return mismatch("cleanup paths are not distinct normalized absolute paths")
    }
    const repositoryContext = await this.context(repository)
    if (!repositoryContext.ok) return mismatch(repositoryContext.message)
    if (repositoryContext.root !== repository || repositoryContext.mainRoot !== repository) {
      return mismatch("planned repository is not the exact main Worktree")
    }

    const listed = await this.command(repository, ["worktree", "list", "--porcelain", "-z"])
    if (listed.exitCode !== 0) {
      throw new GitCleanupTransientError(commandFailure("git worktree list", listed))
    }
    let entries: WorktreeListEntry[]
    try {
      entries = parseWorktreeList(listed.stdout)
    } catch (error) {
      return mismatch(`cannot parse exact Git Worktree registration: ${errorMessage(error)}`)
    }
    const registered = entries.filter(({ path }) => path === worktreeDirectory)
    if (registered.length > 1) return mismatch("Git repeats the exact Worktree registration")
    const pathExists = await existsWithoutFollowing(worktreeDirectory)
    if (registered.length === 0) {
      return pathExists
        ? mismatch("planned Worktree path exists without its exact Git registration")
        : { kind: "absent" }
    }
    if (!pathExists) return mismatch("Git registration exists but its exact Worktree path is absent")

    const entry = registered[0]!
    if (!entry.head || !GIT_OBJECT_ID.test(entry.head)) {
      return mismatch("registered Worktree has no exact HEAD object")
    }
    const worktreeContext = await this.context(worktreeDirectory)
    if (!worktreeContext.ok) return mismatch(worktreeContext.message)
    if (worktreeContext.root !== worktreeDirectory || worktreeContext.mainRoot !== repository) {
      return mismatch("Worktree path resolves to a different repository or checkout root")
    }
    const head = await this.command(worktreeDirectory, ["rev-parse", "--verify", "HEAD"])
    if (head.exitCode !== 0) return mismatch(commandFailure("git rev-parse HEAD", head))
    const headCommit = decodeOneLine(head.stdout, "Worktree HEAD")
    if (!GIT_OBJECT_ID.test(headCommit) || headCommit !== entry.head) {
      return mismatch("registered and checked-out Worktree HEAD identities differ")
    }
    const status = await this.command(worktreeDirectory, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ])
    if (status.exitCode !== 0) {
      throw new GitCleanupTransientError(commandFailure("git status", status))
    }
    let parsedStatus: ParsedStatus
    try {
      parsedStatus = parsePorcelainV2Status(status.stdout)
    } catch (error) {
      return mismatch(`cannot represent exact Git status: ${errorMessage(error)}`)
    }
    return {
      kind: "present",
      repository,
      worktreeDirectory,
      headCommit,
      statusDigest: sha256(status.stdout),
      trackedChanges: parsedStatus.trackedChanges,
      untrackedPaths: parsedStatus.untrackedPaths,
    }
  }

  async remove(repository: string, worktreeDirectory: string): Promise<void> {
    if (!exactAbsolutePath(repository) || !exactAbsolutePath(worktreeDirectory)) {
      throw new GitCleanupTransientError("refusing non-exact Git Worktree removal paths")
    }
    const removed = await this.command(repository, ["worktree", "remove", "--", worktreeDirectory])
    if (removed.exitCode !== 0) {
      throw new GitCleanupTransientError(commandFailure("git worktree remove", removed))
    }
  }

  private async context(
    cwd: string,
  ): Promise<{ ok: true; mainRoot: string; root: string } | { ok: false; message: string }> {
    let result: GitCommandResult
    try {
      result = await this.command(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ])
    } catch (error) {
      return { ok: false, message: `cannot inspect exact Git repository identity: ${errorMessage(error)}` }
    }
    if (result.exitCode !== 0) return { ok: false, message: commandFailure("git repository identity", result) }
    let lines: string[]
    try {
      lines = decodeLines(result.stdout)
    } catch (error) {
      return { ok: false, message: `Git repository identity is ambiguous: ${errorMessage(error)}` }
    }
    if (lines.length !== 2 || !exactAbsolutePath(lines[0]!) || !exactAbsolutePath(lines[1]!)) {
      return { ok: false, message: "Git repository identity is not two exact absolute paths" }
    }
    return { ok: true, mainRoot: dirname(lines[0]!), root: lines[1]! }
  }

  private command(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
    return this.run(cwd, args, this.environment)
  }
}

/**
 * Retained cleanup effect engine. It is callable only after the same ledger
 * holds exact end proof, and it never force-removes a Worktree.
 */
export class GitSafeWorktreeCleanup {
  private readonly now: () => Date
  private readonly afterRemove: (() => void | Promise<void>) | null

  constructor(
    private readonly ledger: ExactRetirementLedger,
    private readonly git: GitWorktreeAuthority,
    options: GitSafeWorktreeCleanupOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.afterRemove = options.afterRemove ?? null
  }

  async cleanup(
    ensure: EnsureLifecycleRecord,
    request: CleanupRequest,
  ): Promise<CleanupReceipt> {
    let record = await this.ledger.bindEnsure(ensure)
    record = await this.ledger.beginCleanup(request)
    if (record.cleanup!.receipt) return record.cleanup!.receipt

    const worktree = record.ensure.effects.worktree
    if (worktree.status === "planned") {
      return await this.retain(request, { kind: "not_applicable" })
    }
    const repository = record.ensure.request.planned_worktree.repository
    const directory = request.worktree_directory
    let inspection = await this.git.inspect(repository, directory)
    const retainedPrepare = record.cleanup!.prepare

    if (retainedPrepare) {
      if (inspection.kind === "absent") {
        return await this.retain(request, {
          kind: "removed",
          head_commit: retainedPrepare.head_commit,
        })
      }
      const refused = dispositionForInspection(inspection, retainedPrepare)
      if (refused) return await this.retain(request, refused)
    } else {
      if (inspection.kind === "absent") {
        return await this.retain(request, {
          kind: "refused_mismatch",
          message: "planned Worktree disappeared before a durable removal prepare marker",
        })
      }
      const refused = dispositionForInspection(inspection, null)
      if (refused) return await this.retain(request, refused)
      if (inspection.kind !== "present") {
        throw new GitCleanupTransientError("cleanup inspection lost its exact present Worktree")
      }
      record = await this.ledger.prepareCleanup(request.ensure_id, {
        repository,
        worktree_directory: directory,
        head_commit: inspection.headCommit,
        status_digest: inspection.statusDigest,
        prepared_at: canonicalNow(this.now),
      })
    }

    const prepare = record.cleanup!.prepare!
    // Immediate second inspection closes repository/path/registration/HEAD
    // and dirt races before invoking Git's own final non-force guard.
    inspection = await this.git.inspect(repository, directory)
    if (inspection.kind === "absent") {
      return await this.retain(request, { kind: "removed", head_commit: prepare.head_commit })
    }
    const refused = dispositionForInspection(inspection, prepare)
    if (refused) return await this.retain(request, refused)

    try {
      await this.git.remove(repository, directory)
    } catch (error) {
      const recovered = await this.git.inspect(repository, directory)
      if (recovered.kind === "absent") {
        return await this.retain(request, { kind: "removed", head_commit: prepare.head_commit })
      }
      const postFailure = dispositionForInspection(recovered, prepare)
      if (postFailure) return await this.retain(request, postFailure)
      throw error
    }
    // Deliberately outside the Git failure recovery: an injected crash here
    // models process/output loss. The next process uses the durable prepare
    // marker plus absent path/registration and never removes twice.
    await this.afterRemove?.()
    const verified = await this.git.inspect(repository, directory)
    if (verified.kind === "absent") {
      return await this.retain(request, { kind: "removed", head_commit: prepare.head_commit })
    }
    const postSuccess = dispositionForInspection(verified, prepare)
    if (postSuccess) return await this.retain(request, postSuccess)
    throw new GitCleanupTransientError("git worktree remove reported success but the exact Worktree remains")
  }

  private async retain(
    request: CleanupRequest,
    outcome: CleanupReceipt["outcome"],
  ): Promise<CleanupReceipt> {
    const receipt = buildCleanupReceipt(request, outcome, canonicalNow(this.now))
    const record = await this.ledger.retainCleanupReceipt(receipt)
    return record.cleanup!.receipt!
  }
}

function dispositionForInspection(
  inspection: Exclude<GitWorktreeInspection, { kind: "absent" }>,
  prepare: { repository: string; worktree_directory: string; head_commit: string; status_digest: string } | null,
): CleanupReceipt["outcome"] | null {
  if (inspection.kind === "mismatch") {
    return { kind: "refused_mismatch", message: boundedMessage(inspection.message) }
  }
  if (prepare && (
    inspection.repository !== prepare.repository ||
    inspection.worktreeDirectory !== prepare.worktree_directory ||
    inspection.headCommit !== prepare.head_commit
  )) {
    return { kind: "refused_mismatch", message: "Worktree identity changed after durable cleanup preparation" }
  }
  if (inspection.trackedChanges || inspection.untrackedPaths.length > 0) {
    return {
      kind: "refused_dirty",
      head_commit: inspection.headCommit,
      tracked_changes: inspection.trackedChanges,
      untracked_paths: inspection.untrackedPaths,
    }
  }
  if (prepare && inspection.statusDigest !== prepare.status_digest) {
    return { kind: "refused_mismatch", message: "clean Worktree status bytes changed after preparation" }
  }
  return null
}

function buildCleanupReceipt(
  request: CleanupRequest,
  outcome: CleanupReceipt["outcome"],
  observedAt: string,
): CleanupReceipt {
  const partial = {
    schema_id: request.schema_id,
    schema_version: request.schema_version,
    message_type: "cleanup_receipt" as const,
    request_id: request.request_id,
    receipt_id: deterministicId("cleanup-receipt", request),
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
    cleanup_id: request.cleanup_id,
    cleanup_digest: request.cleanup_digest,
    worktree_directory: request.worktree_directory,
    outcome: structuredClone(outcome),
    observed_at: observedAt,
  } satisfies CleanupReceipt
  partial.receipt_digest = deriveLifecycleReceiptDigest(partial)
  return partial
}

type WorktreeListEntry = { path: string; head: string | null }

export function parseWorktreeList(bytes: Uint8Array): WorktreeListEntry[] {
  const fields = decodeNulFields(bytes, "Git Worktree list")
  const entries: WorktreeListEntry[] = []
  let current: WorktreeListEntry | null = null
  for (const field of fields) {
    if (field === "") {
      if (current) entries.push(current)
      current = null
      continue
    }
    if (field.startsWith("worktree ")) {
      if (current) throw new Error("Worktree registration lacks a record separator")
      const path = field.slice("worktree ".length)
      if (!exactAbsolutePath(path)) throw new Error("Worktree registration path is not exact and absolute")
      current = { path, head: null }
      continue
    }
    if (!current) throw new Error("Worktree registration field precedes its path")
    if (field.startsWith("HEAD ")) {
      if (current.head !== null) throw new Error("Worktree registration repeats HEAD")
      current.head = field.slice("HEAD ".length)
    } else if (!field.startsWith("branch ") && field !== "detached" &&
      field !== "bare" && field !== "locked" && !field.startsWith("locked ") &&
      field !== "prunable" && !field.startsWith("prunable ")
    ) {
      throw new Error(`unknown Worktree registration field ${field.slice(0, 64)}`)
    }
  }
  if (current) throw new Error("Worktree registration lacks a trailing record separator")
  return entries
}

type ParsedStatus = { trackedChanges: boolean; untrackedPaths: string[] }

export function parsePorcelainV2Status(bytes: Uint8Array): ParsedStatus {
  if (bytes.byteLength > CONTRACT_MAX_FRAME_BYTES) {
    throw new Error("Git status exceeds the bounded receipt source")
  }
  const records = decodeNulFields(bytes, "Git status")
  let trackedChanges = false
  const untrackedPaths: string[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    if (record === "") {
      if (index !== records.length - 1) throw new Error("Git status contains an empty record")
      continue
    }
    const type = record[0]
    if (type === "1" || type === "u") {
      trackedChanges = true
    } else if (type === "2") {
      trackedChanges = true
      index++
      if (index >= records.length || records[index] === "") {
        throw new Error("renamed Git status record lacks its original path")
      }
    } else if (record.startsWith("? ")) {
      const path = record.slice(2)
      if (!exactRelativePath(path)) throw new Error("untracked path cannot be represented exactly")
      untrackedPaths.push(path)
    } else if (record.startsWith("! ")) {
      continue
    } else {
      throw new Error(`unknown Git status record type ${JSON.stringify(type)}`)
    }
  }
  const unique = [...new Set(untrackedPaths)].sort()
  if (unique.length !== untrackedPaths.length) throw new Error("Git status repeats an untracked path")
  if (unique.length > 4_096) throw new Error("Git status exceeds 4096 untracked paths")
  return { trackedChanges, untrackedPaths: unique }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<GitCommandResult> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    child = Bun.spawn(["git", "--no-optional-locks", ...args], {
      cwd,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    return { exitCode: -1, stdout: new Uint8Array(), stderr: errorMessage(error) }
  }
  const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS)
  try {
    const [stdout, stderrBytes, exitCode] = await Promise.all([
      readBounded(child.stdout, GIT_OUTPUT_MAX_BYTES, () => child.kill()),
      readBounded(child.stderr, 64 * 1024, () => child.kill()),
      child.exited,
    ])
    return { exitCode, stdout, stderr: new TextDecoder().decode(stderrBytes).trim() }
  } finally {
    clearTimeout(timer)
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  overflow: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        overflow()
        throw new GitCleanupTransientError(`Git stream exceeds its ${maximumBytes}-byte safety bound`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function scrubGitEnvironment(parent: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && !key.startsWith("GIT_")) environment[key] = value
  }
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_CONFIG_GLOBAL = "/dev/null"
  environment.GIT_TERMINAL_PROMPT = "0"
  return environment
}

function decodeNulFields(bytes: Uint8Array, label: string): string[] {
  if (bytes.byteLength === 0) return []
  if (bytes.at(-1) !== 0) throw new Error(`${label} lacks a final NUL`)
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  return text.split("\0")
}

function decodeLines(bytes: Uint8Array): string[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (text.includes("\0")) throw new Error("unexpected NUL")
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
  if (lines.some((line) => line.length === 0)) throw new Error("empty identity line")
  return lines
}

function decodeOneLine(bytes: Uint8Array, label: string): string {
  const lines = decodeLines(bytes)
  if (lines.length !== 1) throw new Error(`${label} is not one exact line`)
  return lines[0]!
}

function exactAbsolutePath(path: string): boolean {
  return isAbsolute(path) && path !== "/" && normalize(path) === path && resolve(path) === path &&
    !path.includes("\0")
}

function exactRelativePath(path: string): boolean {
  return path.length > 0 && Buffer.byteLength(path) <= 1_024 && !isAbsolute(path) &&
    path !== "." && normalize(path) === path && !path.startsWith("..") &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(path)
}

async function existsWithoutFollowing(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

function mismatch(message: string): Extract<GitWorktreeInspection, { kind: "mismatch" }> {
  return { kind: "mismatch", message: boundedMessage(message) }
}

function boundedMessage(message: string): string {
  const sanitized = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim() || "Git identity mismatch"
  const bytes = Buffer.from(sanitized)
  return bytes.byteLength <= 1_024
    ? sanitized
    : new TextDecoder().decode(bytes.subarray(0, 1_024)).replace(/\ufffd$/u, "")
}

function commandFailure(label: string, result: GitCommandResult): string {
  return boundedMessage(`${label} failed (exit ${result.exitCode})${result.stderr ? `: ${result.stderr}` : ""}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function deterministicId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256")
    .update(encodeCanonicalJson(value as JsonValue))
    .digest("hex")
    .slice(0, 32)}`
}

function canonicalNow(now: () => Date): string {
  const value = now()
  if (Number.isNaN(value.valueOf())) throw new Error("cleanup clock returned an invalid date")
  return value.toISOString()
}
