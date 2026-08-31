import { createHash } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, open, realpath, type FileHandle } from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, isAbsolute, join, normalize, resolve } from "node:path"
import {
  CONTRACT_MAX_FRAME_BYTES,
  decodeStrictJson,
  encodeCanonicalJson,
  type JsonValue,
} from "./contract-codec.ts"
import type { EnsureLifecycleRecord } from "./ensure-lifecycle-ledger.ts"
import {
  deriveLifecycleReceiptDigest,
  type CleanupPhysicalIdentity,
  type CleanupPrepare,
  type CleanupReceipt,
  type CleanupRequest,
  type ExactRetirementLedger,
} from "./exact-retirement-ledger.ts"

const GIT_TIMEOUT_MS = 10_000
const PREPARED_REMOVAL_TIMEOUT_MS = 90_000
const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024
const GIT_MARKER_MAX_BYTES = 4 * 1024
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

export type GitWorktreeSnapshot = {
  kind: "present"
  repository: string
  worktreeDirectory: string
  headCommit: string
  statusDigest: string
  trackedChanges: boolean
  untrackedPaths: string[]
  physicalIdentity: CleanupPhysicalIdentity
}

export type GitRepositoryPhysicalIdentity = Pick<
  CleanupPhysicalIdentity,
  "repository_root" | "common_directory" | "common_directory_identity"
>

export type GitWorktreeInspection =
  | GitWorktreeSnapshot
  | { kind: "absent"; repositoryIdentity: GitRepositoryPhysicalIdentity }
  | { kind: "mismatch"; message: string }

export type GitWorktreeAuthority = {
  inspect: (repository: string, worktreeDirectory: string) => Promise<GitWorktreeInspection>
  compareAndRemove: (prepare: CleanupPrepare) => Promise<GitCompareRemoveResult>
}

export type GitCompareRemoveResult =
  | { kind: "removed" }
  | { kind: "refused"; inspection: Exclude<GitWorktreeInspection, { kind: "absent" }> }

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

export type GitPreparedRemovalRunner = (
  prepare: CleanupPrepare,
  environment: Readonly<Record<string, string>>,
) => Promise<GitCompareRemoveResult>

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
    private readonly preparedRemoval: GitPreparedRemovalRunner = spawnPreparedRemovalOperation,
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
    if (repositoryContext.root !== repository ||
      repositoryContext.gitDirectory !== repositoryContext.commonDirectory ||
      dirname(repositoryContext.commonDirectory) !== repository
    ) {
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
      if (pathExists) return mismatch("planned Worktree path exists without its exact Git registration")
      try {
        return {
          kind: "absent",
          repositoryIdentity: await captureRepositoryPhysicalIdentity(
            repository,
            repositoryContext.commonDirectory,
          ),
        }
      } catch (error) {
        return mismatch(`cannot pin repository identity for absent Worktree: ${errorMessage(error)}`)
      }
    }
    if (!pathExists) return mismatch("Git registration exists but its exact Worktree path is absent")

    const entry = registered[0]!
    if (!entry.head || !GIT_OBJECT_ID.test(entry.head)) {
      return mismatch("registered Worktree has no exact HEAD object")
    }
    const worktreeContext = await this.context(worktreeDirectory)
    if (!worktreeContext.ok) return mismatch(worktreeContext.message)
    if (worktreeContext.root !== worktreeDirectory ||
      worktreeContext.commonDirectory !== repositoryContext.commonDirectory ||
      !worktreeContext.gitDirectory.startsWith(
        `${resolve(repositoryContext.commonDirectory, "worktrees")}/`,
      )
    ) {
      return mismatch("Worktree path resolves to a different repository or checkout root")
    }
    let physicalIdentity: CleanupPhysicalIdentity
    try {
      physicalIdentity = await capturePhysicalIdentity(
        repository,
        worktreeDirectory,
        repositoryContext.commonDirectory,
        worktreeContext.gitDirectory,
      )
    } catch (error) {
      return mismatch(`cannot pin exact physical Worktree identity: ${errorMessage(error)}`)
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
      "--ignored=matching",
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
    try {
      const finalIdentity = await capturePhysicalIdentity(
        repository,
        worktreeDirectory,
        repositoryContext.commonDirectory,
        worktreeContext.gitDirectory,
      )
      if (!samePhysicalIdentity(physicalIdentity, finalIdentity)) {
        return mismatch("physical Worktree identity changed during exact inspection")
      }
    } catch (error) {
      return mismatch(`cannot revalidate exact physical Worktree identity: ${errorMessage(error)}`)
    }
    return {
      kind: "present",
      repository,
      worktreeDirectory,
      headCommit,
      statusDigest: sha256(status.stdout),
      trackedChanges: parsedStatus.trackedChanges,
      untrackedPaths: parsedStatus.untrackedPaths,
      physicalIdentity,
    }
  }

  compareAndRemove(prepare: CleanupPrepare): Promise<GitCompareRemoveResult> {
    // One operation-level runner owns the final comparison and effect. The
    // parent never exposes an inspect-then-remove seam that a caller can race.
    return this.preparedRemoval(structuredClone(prepare), this.environment)
  }

  private async context(
    cwd: string,
  ): Promise<{
      ok: true
      commonDirectory: string
      gitDirectory: string
      root: string
    } | { ok: false; message: string }> {
    let result: GitCommandResult
    try {
      result = await this.command(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--git-dir",
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
    if (lines.length !== 3 || lines.some((line) => !exactAbsolutePath(line))) {
      return { ok: false, message: "Git repository identity is not three exact absolute paths" }
    }
    return {
      ok: true,
      commonDirectory: lines[0]!,
      gitDirectory: lines[1]!,
      root: lines[2]!,
    }
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
    const inspection = await this.git.inspect(repository, directory)
    const retainedPrepare = record.cleanup!.prepare

    if (retainedPrepare) {
      if (inspection.kind === "absent") {
        if (!sameRepositoryPhysicalIdentity(
          inspection.repositoryIdentity,
          repositoryPhysicalIdentity(retainedPrepare.physical_identity),
        )) {
          return await this.retain(request, {
            kind: "refused_mismatch",
            message: "repository identity changed before absent Worktree recovery",
          })
        }
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
        physical_identity: structuredClone(inspection.physicalIdentity),
        prepared_at: canonicalNow(this.now),
      })
    }

    const prepare = record.cleanup!.prepare!
    let effect: GitCompareRemoveResult
    try {
      effect = await this.git.compareAndRemove(prepare)
    } catch (error) {
      const recovered = await this.git.inspect(repository, directory)
      if (recovered.kind === "absent") {
        if (!sameRepositoryPhysicalIdentity(
          recovered.repositoryIdentity,
          repositoryPhysicalIdentity(prepare.physical_identity),
        )) {
          return await this.retain(request, {
            kind: "refused_mismatch",
            message: "repository identity changed during prepared removal recovery",
          })
        }
        return await this.retain(request, { kind: "removed", head_commit: prepare.head_commit })
      }
      const postFailure = dispositionForInspection(recovered, prepare)
      if (postFailure) return await this.retain(request, postFailure)
      throw error
    }
    if (effect.kind === "refused") {
      const refused = dispositionForInspection(effect.inspection, prepare)
      if (refused) return await this.retain(request, refused)
      throw new GitCleanupTransientError(
        "prepared removal runner refused an unchanged clean Worktree without a reason",
      )
    }
    // Deliberately outside the Git failure recovery: an injected crash here
    // models process/output loss. The next process uses the durable prepare
    // marker plus absent path/registration and never removes twice.
    await this.afterRemove?.()
    return await this.retain(request, { kind: "removed", head_commit: prepare.head_commit })
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
  prepare: CleanupPrepare | null,
): CleanupReceipt["outcome"] | null {
  if (inspection.kind === "mismatch") {
    return { kind: "refused_mismatch", message: boundedMessage(inspection.message) }
  }
  if (prepare && (
    inspection.repository !== prepare.repository ||
    inspection.worktreeDirectory !== prepare.worktree_directory ||
    inspection.headCommit !== prepare.head_commit ||
    !samePhysicalIdentity(inspection.physicalIdentity, prepare.physical_identity)
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
    } else if (record.startsWith("? ") || record.startsWith("! ")) {
      const path = record.slice(2)
      if (!exactRelativePath(path)) throw new Error("nontracked path cannot be represented exactly")
      untrackedPaths.push(path)
    } else {
      throw new Error(`unknown Git status record type ${JSON.stringify(type)}`)
    }
  }
  const unique = [...new Set(untrackedPaths)].sort()
  if (unique.length !== untrackedPaths.length) throw new Error("Git status repeats an untracked path")
  if (unique.length > 4_096) throw new Error("Git status exceeds 4096 untracked paths")
  return { trackedChanges, untrackedPaths: unique }
}

type PhysicalPathKind = "directory" | "marker"

type PinnedPhysicalPath = {
  path: string
  kind: PhysicalPathKind
  handle: FileHandle
  identity: { device: string; inode: string }
}

type PinnedPhysicalAuthority = {
  identity: CleanupPhysicalIdentity
  paths: PinnedPhysicalPath[]
  close: () => Promise<void>
  revalidate: () => Promise<void>
}

async function captureRepositoryPhysicalIdentity(
  repository: string,
  commonDirectory: string,
): Promise<GitRepositoryPhysicalIdentity> {
  if (!exactAbsolutePath(repository) || !exactAbsolutePath(commonDirectory) ||
    await realpath(repository) !== repository || await realpath(commonDirectory) !== commonDirectory
  ) {
    throw new Error("repository paths are not exact canonical physical paths")
  }
  const root = await openPinnedPhysicalPath(repository, "directory")
  let common: PinnedPhysicalPath | null = null
  try {
    common = await openPinnedPhysicalPath(commonDirectory, "directory")
    return {
      repository_root: structuredClone(root.identity),
      common_directory: commonDirectory,
      common_directory_identity: structuredClone(common.identity),
    }
  } finally {
    await Promise.allSettled([root.handle.close(), ...(common ? [common.handle.close()] : [])])
  }
}

async function capturePhysicalIdentity(
  repository: string,
  worktreeDirectory: string,
  commonDirectory: string,
  gitAdminDirectory: string,
): Promise<CleanupPhysicalIdentity> {
  const pinned = await openPhysicalAuthority(
    repository,
    worktreeDirectory,
    commonDirectory,
    gitAdminDirectory,
  )
  try {
    return structuredClone(pinned.identity)
  } finally {
    await pinned.close()
  }
}

async function openPhysicalAuthority(
  repository: string,
  worktreeDirectory: string,
  commonDirectory: string,
  gitAdminDirectory: string,
): Promise<PinnedPhysicalAuthority> {
  const markerPath = join(worktreeDirectory, ".git")
  const specifications: Array<{ path: string; kind: PhysicalPathKind }> = [
    { path: repository, kind: "directory" },
    { path: commonDirectory, kind: "directory" },
    { path: worktreeDirectory, kind: "directory" },
    { path: markerPath, kind: "marker" },
    { path: gitAdminDirectory, kind: "directory" },
  ]
  for (const specification of specifications) {
    if (!exactAbsolutePath(specification.path) || await realpath(specification.path) !== specification.path) {
      throw new Error(`${specification.path} is not one exact canonical physical path`)
    }
  }

  const paths: PinnedPhysicalPath[] = []
  try {
    for (const specification of specifications) {
      paths.push(await openPinnedPhysicalPath(specification.path, specification.kind))
    }
    const marker = paths[3]!
    const markerBytes = await readPinnedMarker(marker)
    const markerText = new TextDecoder("utf-8", { fatal: true }).decode(markerBytes)
    if (markerText !== `gitdir: ${gitAdminDirectory}\n`) {
      throw new Error("linked Worktree .git marker does not name its exact Git admin directory")
    }
    const identity: CleanupPhysicalIdentity = {
      repository_root: structuredClone(paths[0]!.identity),
      common_directory: commonDirectory,
      common_directory_identity: structuredClone(paths[1]!.identity),
      worktree_root: structuredClone(paths[2]!.identity),
      git_marker: structuredClone(marker.identity),
      git_marker_digest: sha256(markerBytes),
      git_admin_directory: gitAdminDirectory,
      git_admin_directory_identity: structuredClone(paths[4]!.identity),
    }
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      const results = await Promise.allSettled(paths.map(({ handle }) => handle.close()))
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failed) throw failed.reason
    }
    return {
      identity,
      paths,
      close,
      revalidate: async () => {
        for (const path of paths) {
          const stats = await path.handle.stat({ bigint: true })
          assertPhysicalKind(path.path, path.kind, stats)
          if (!sameFileIdentity(path.identity, identityFromStats(stats))) {
            throw new Error(`${path.path} changed through its retained physical pin`)
          }
        }
        const current = await capturePhysicalIdentity(
          repository,
          worktreeDirectory,
          commonDirectory,
          gitAdminDirectory,
        )
        if (!samePhysicalIdentity(identity, current)) {
          throw new Error("physical Worktree paths no longer resolve to the retained pins")
        }
      },
    }
  } catch (error) {
    await Promise.allSettled(paths.map(({ handle }) => handle.close()))
    throw error
  }
}

async function openPinnedPhysicalPath(
  path: string,
  kind: PhysicalPathKind,
): Promise<PinnedPhysicalPath> {
  const directoryFlag = kind === "directory" ? constants.O_DIRECTORY : 0
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | directoryFlag)
  try {
    const stats = await handle.stat({ bigint: true })
    assertPhysicalKind(path, kind, stats)
    return { path, kind, handle, identity: identityFromStats(stats) }
  } catch (error) {
    await handle.close()
    throw error
  }
}

function assertPhysicalKind(path: string, kind: PhysicalPathKind, stats: BigIntStats): void {
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(`${path} is not the required physical ${kind}`)
  }
  if (stats.uid !== BigInt(userInfo().uid)) {
    throw new Error(`${path} is not owned by the current user`)
  }
  if (kind === "marker" && stats.nlink !== 1n) {
    throw new Error(`${path} linked Worktree marker has more than one physical name`)
  }
  if (stats.ino <= 0n || stats.dev < 0n) throw new Error(`${path} has no exact physical identity`)
}

async function readPinnedMarker(path: PinnedPhysicalPath): Promise<Uint8Array> {
  const stats = await path.handle.stat({ bigint: true })
  if (stats.size <= 0n || stats.size > BigInt(GIT_MARKER_MAX_BYTES)) {
    throw new Error("linked Worktree .git marker exceeds its exact bound")
  }
  const bytes = new Uint8Array(await path.handle.readFile())
  if (bytes.byteLength !== Number(stats.size)) {
    throw new Error("linked Worktree .git marker changed while being read")
  }
  return bytes
}

function identityFromStats(stats: BigIntStats): { device: string; inode: string } {
  return { device: stats.dev.toString(10), inode: stats.ino.toString(10) }
}

function sameFileIdentity(
  left: { device: string; inode: string },
  right: { device: string; inode: string },
): boolean {
  return left.device === right.device && left.inode === right.inode
}

function samePhysicalIdentity(
  left: CleanupPhysicalIdentity,
  right: CleanupPhysicalIdentity,
): boolean {
  const leftBytes = encodeCanonicalJson(left as unknown as JsonValue)
  const rightBytes = encodeCanonicalJson(right as unknown as JsonValue)
  return leftBytes.byteLength === rightBytes.byteLength &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
}

function sameRepositoryPhysicalIdentity(
  left: GitRepositoryPhysicalIdentity,
  right: GitRepositoryPhysicalIdentity,
): boolean {
  return sameFileIdentity(left.repository_root, right.repository_root) &&
    left.common_directory === right.common_directory &&
    sameFileIdentity(left.common_directory_identity, right.common_directory_identity)
}

function repositoryPhysicalIdentity(
  physical: CleanupPhysicalIdentity,
): GitRepositoryPhysicalIdentity {
  return {
    repository_root: structuredClone(physical.repository_root),
    common_directory: physical.common_directory,
    common_directory_identity: structuredClone(physical.common_directory_identity),
  }
}

/** One private helper process owns every final comparison and the exact effect. */
export async function spawnPreparedRemovalOperation(
  prepare: CleanupPrepare,
  environment: Readonly<Record<string, string>>,
): Promise<GitCompareRemoveResult> {
  const helper = resolve(import.meta.dir, "git-safe-worktree-cleanup-runner.ts")
  const child = Bun.spawn([process.execPath, helper], {
    env: scrubGitEnvironment(environment),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  child.stdin.write(encodeCanonicalJson(prepare as unknown as JsonValue))
  child.stdin.end()
  const timer = setTimeout(() => child.kill(), PREPARED_REMOVAL_TIMEOUT_MS)
  try {
    const [stdout, stderrBytes, exitCode] = await Promise.all([
      readBounded(child.stdout, CONTRACT_MAX_FRAME_BYTES, () => child.kill()),
      readBounded(child.stderr, 64 * 1024, () => child.kill()),
      child.exited,
    ])
    const stderr = new TextDecoder().decode(stderrBytes).trim()
    if (exitCode !== 0) {
      throw new GitCleanupTransientError(
        boundedMessage(`prepared Git removal helper failed (exit ${exitCode})${stderr ? `: ${stderr}` : ""}`),
      )
    }
    return parseCompareRemoveResult(decodeStrictJson(stdout))
  } finally {
    clearTimeout(timer)
  }
}

/** Entry used only by the one-shot helper; it defensively re-scrubs Git state. */
export async function executePreparedRemovalOperation(
  prepareInput: unknown,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<GitCompareRemoveResult> {
  const prepare = parseCleanupPrepareDocument(prepareInput)
  const environment = scrubGitEnvironment(parentEnvironment)
  const authority = new GitSafeWorktreeAuthority(
    { ...environment },
    runGit,
    async () => { throw new Error("nested prepared removal is unavailable") },
  )
  const initial = await authority.inspect(prepare.repository, prepare.worktree_directory)
  if (initial.kind === "absent") {
    return sameRepositoryPhysicalIdentity(
      initial.repositoryIdentity,
      repositoryPhysicalIdentity(prepare.physical_identity),
    )
      ? { kind: "removed" }
      : {
          kind: "refused",
          inspection: mismatch("repository identity changed before absent Worktree recovery"),
        }
  }
  const initialRefusal = dispositionForInspection(initial, prepare)
  if (initialRefusal) return { kind: "refused", inspection: initial }

  let pinned: PinnedPhysicalAuthority
  try {
    pinned = await openPhysicalAuthority(
      prepare.repository,
      prepare.worktree_directory,
      prepare.physical_identity.common_directory,
      prepare.physical_identity.git_admin_directory,
    )
    if (!samePhysicalIdentity(pinned.identity, prepare.physical_identity)) {
      await pinned.close()
      return { kind: "refused", inspection: mismatch("physical Worktree authority changed after prepare") }
    }
  } catch (error) {
    return {
      kind: "refused",
      inspection: mismatch(`cannot reopen prepared physical Worktree authority: ${errorMessage(error)}`),
    }
  }

  let closed = false
  const closePins = async () => {
    if (closed) return
    closed = true
    await pinned.close()
  }
  try {
    const finalInspection = await authority.inspect(prepare.repository, prepare.worktree_directory)
    if (finalInspection.kind === "absent") {
      return sameRepositoryPhysicalIdentity(
        finalInspection.repositoryIdentity,
        repositoryPhysicalIdentity(prepare.physical_identity),
      )
        ? { kind: "removed" }
        : {
            kind: "refused",
            inspection: mismatch("repository identity changed before absent Worktree recovery"),
          }
    }
    const finalRefusal = dispositionForInspection(finalInspection, prepare)
    if (finalRefusal) return { kind: "refused", inspection: finalInspection }
    try {
      await pinned.revalidate()
    } catch (error) {
      return {
        kind: "refused",
        inspection: mismatch(`prepared physical Worktree pin changed before removal: ${errorMessage(error)}`),
      }
    }

    const removed = await runGit(
      prepare.repository,
      ["worktree", "remove", "--", prepare.worktree_directory],
      environment,
    )
    await closePins()
    const verified = await authority.inspect(prepare.repository, prepare.worktree_directory)
    if (verified.kind === "absent") {
      return sameRepositoryPhysicalIdentity(
        verified.repositoryIdentity,
        repositoryPhysicalIdentity(prepare.physical_identity),
      )
        ? { kind: "removed" }
        : {
            kind: "refused",
            inspection: mismatch("repository identity changed after prepared Worktree removal"),
          }
    }
    const postEffectRefusal = dispositionForInspection(verified, prepare)
    if (postEffectRefusal) return { kind: "refused", inspection: verified }
    if (removed.exitCode !== 0) {
      throw new GitCleanupTransientError(commandFailure("git worktree remove", removed))
    }
    throw new GitCleanupTransientError(
      "git worktree remove reported success but the exact prepared Worktree remains",
    )
  } finally {
    await closePins()
  }
}

function parseCleanupPrepareDocument(input: unknown): CleanupPrepare {
  if (!isPlainRecord(input) || !hasExactKeys(input, [
    "head_commit",
    "physical_identity",
    "prepared_at",
    "repository",
    "status_digest",
    "worktree_directory",
  ]) || typeof input.repository !== "string" || !exactAbsolutePath(input.repository) ||
    typeof input.worktree_directory !== "string" || !exactAbsolutePath(input.worktree_directory) ||
    typeof input.head_commit !== "string" || !GIT_OBJECT_ID.test(input.head_commit) ||
    typeof input.status_digest !== "string" || !/^[0-9a-f]{64}$/u.test(input.status_digest) ||
    typeof input.prepared_at !== "string" || Number.isNaN(Date.parse(input.prepared_at)) ||
    new Date(input.prepared_at).toISOString() !== input.prepared_at ||
    !isCleanupPhysicalIdentity(input.physical_identity)
  ) {
    throw new GitCleanupTransientError("prepared Git removal input is not one exact private snapshot")
  }
  const prepare = structuredClone(input) as CleanupPrepare
  if (prepare.repository === prepare.worktree_directory ||
    dirname(prepare.physical_identity.common_directory) !== prepare.repository ||
    !prepare.physical_identity.git_admin_directory.startsWith(
      `${resolve(prepare.physical_identity.common_directory, "worktrees")}/`,
    )
  ) {
    throw new GitCleanupTransientError("prepared Git removal paths do not form one exact linked Worktree")
  }
  return prepare
}

function isCleanupPhysicalIdentity(input: unknown): input is CleanupPhysicalIdentity {
  if (!isPlainRecord(input) || !hasExactKeys(input, [
    "common_directory",
    "common_directory_identity",
    "git_admin_directory",
    "git_admin_directory_identity",
    "git_marker",
    "git_marker_digest",
    "repository_root",
    "worktree_root",
  ]) || typeof input.common_directory !== "string" || !exactAbsolutePath(input.common_directory) ||
    typeof input.git_admin_directory !== "string" || !exactAbsolutePath(input.git_admin_directory) ||
    typeof input.git_marker_digest !== "string" || !/^[0-9a-f]{64}$/u.test(input.git_marker_digest)
  ) return false
  return [
    input.repository_root,
    input.common_directory_identity,
    input.worktree_root,
    input.git_marker,
    input.git_admin_directory_identity,
  ].every(isCleanupFileIdentity)
}

function isCleanupFileIdentity(input: unknown): boolean {
  return isPlainRecord(input) && hasExactKeys(input, ["device", "inode"]) &&
    typeof input.device === "string" && /^(?:0|[1-9][0-9]{0,31})$/u.test(input.device) &&
    typeof input.inode === "string" && /^[1-9][0-9]{0,31}$/u.test(input.inode)
}

function parseCompareRemoveResult(input: JsonValue): GitCompareRemoveResult {
  if (!isPlainRecord(input) || typeof input.kind !== "string") {
    throw new GitCleanupTransientError("prepared Git removal helper returned no exact outcome")
  }
  if (input.kind === "removed" && hasExactKeys(input, ["kind"])) return { kind: "removed" }
  if (input.kind !== "refused" || !hasExactKeys(input, ["inspection", "kind"]) ||
    !isPlainRecord(input.inspection)
  ) {
    throw new GitCleanupTransientError("prepared Git removal helper returned an invalid outcome")
  }
  const inspection = input.inspection
  if (inspection.kind === "mismatch" && hasExactKeys(inspection, ["kind", "message"]) &&
    typeof inspection.message === "string"
  ) {
    return { kind: "refused", inspection: mismatch(inspection.message) }
  }
  if (inspection.kind !== "present" || !hasExactKeys(inspection, [
    "headCommit",
    "kind",
    "physicalIdentity",
    "repository",
    "statusDigest",
    "trackedChanges",
    "untrackedPaths",
    "worktreeDirectory",
  ]) || typeof inspection.repository !== "string" ||
    !exactAbsolutePath(inspection.repository) ||
    typeof inspection.worktreeDirectory !== "string" ||
    !exactAbsolutePath(inspection.worktreeDirectory) ||
    typeof inspection.headCommit !== "string" || !GIT_OBJECT_ID.test(inspection.headCommit) ||
    typeof inspection.statusDigest !== "string" || !/^[0-9a-f]{64}$/u.test(inspection.statusDigest) ||
    typeof inspection.trackedChanges !== "boolean" ||
    !Array.isArray(inspection.untrackedPaths) ||
    !inspection.untrackedPaths.every((path) => typeof path === "string" && exactRelativePath(path)) ||
    new Set(inspection.untrackedPaths).size !== inspection.untrackedPaths.length ||
    !isCleanupPhysicalIdentity(inspection.physicalIdentity)
  ) {
    throw new GitCleanupTransientError("prepared Git removal helper returned an invalid refusal")
  }
  return { kind: "refused", inspection: structuredClone(inspection) as GitWorktreeSnapshot }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(input: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(input).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
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
