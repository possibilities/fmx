import { createHash, randomBytes } from "node:crypto"
import { constants, fstatSync, type BigIntStats, type Stats } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { ensureLifecycleMessageSchema } from "./agentworkplace-contracts.ts"
import { decodeStrictJson, encodeCanonicalJson, type JsonValue } from "./contract-codec.ts"
import { deriveEnsureDigest, type EnsureLifecycleTransition, type EnsureRequest } from "./ensure-lifecycle-ledger.ts"
import { acquireExclusiveLock, type HeldLock } from "./file-lock.ts"

const AUTHORITY_SCHEMA_ID = "fmx.exact-worktree-creation"
const AUTHORITY_SCHEMA_VERSION = 1
const MARKER_SCHEMA_ID = "fmx.exact-worktree-owner"
const MARKER_SCHEMA_VERSION = 1
const LOCK_FILE = ".exact-worktree-creation.lock"
const MARKER_FILE = "fmx-exact-worktree-owner.json"
const GIT_TIMEOUT_MS = 10_000
const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024
const PRIVATE_FILE_MAX_BYTES = 64 * 1024
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const TOKEN = /^fmx-exact-worktree:[0-9a-f]{64}$/u

export type WorktreeCreatedTransition = Extract<
  EnsureLifecycleTransition,
  { kind: "worktree_created" }
>

export type ExactWorktreeCreationFaultPoint =
  | "before_effect"
  | "after_git_accepted"
  | "after_marker_sync"
  | "after_pins_sync"
  | "after_unlock"
  | "response_loss"

export type ExactWorktreeGitCommandResult = {
  exitCode: number
  stdout: Uint8Array
  stderr: string
}

export type ExactWorktreeGitCommandRunner = (
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
) => Promise<ExactWorktreeGitCommandResult>

export type ExactWorktreeCreationOptions = {
  environment?: NodeJS.ProcessEnv
  fault?: (
    point: ExactWorktreeCreationFaultPoint,
    request: Readonly<EnsureRequest>,
  ) => void | Promise<void>
  git?: ExactWorktreeGitCommandRunner
  lockAttempts?: number
  lockDelayMs?: number
  token?: () => string
  uid?: number
}

export type ExactWorktreeCreationErrorCode =
  | "authority_conflict"
  | "corrupt_authority"
  | "git_conflict"
  | "git_transient"
  | "invalid_request"
  | "lock_unavailable"
  | "unsafe_storage"

export class ExactWorktreeCreationError extends Error {
  constructor(
    readonly code: ExactWorktreeCreationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ExactWorktreeCreationError"
  }
}

type PhysicalIdentity = {
  device: string
  inode: string
}

type RepositoryPins = {
  repository_root: string
  repository_root_identity: PhysicalIdentity
  repository_dot_git: string
  repository_dot_git_identity: PhysicalIdentity
  common_git_directory: string
  common_git_directory_identity: PhysicalIdentity
  target_parent: string
  target_parent_identity: PhysicalIdentity
}

type WorktreePins = {
  worktree_root_identity: PhysicalIdentity
  worktree_dot_git: string
  worktree_dot_git_identity: PhysicalIdentity
  git_admin_directory: string
  git_admin_directory_identity: PhysicalIdentity
  marker: string
  marker_identity: PhysicalIdentity
}

type CreationTransaction = {
  schema_id: typeof AUTHORITY_SCHEMA_ID
  schema_version: typeof AUTHORITY_SCHEMA_VERSION
  ensure_id: string
  ensure_digest: string
  worktree_id: string
  repository: string
  base_commit: string
  branch: string
  directory: string
  token: string
  baseline: RepositoryPins & { branch_was_absent: true }
  state: "claimed" | "pinned"
  pins: WorktreePins | null
}

type OwnerMarker = {
  schema_id: typeof MARKER_SCHEMA_ID
  schema_version: typeof MARKER_SCHEMA_VERSION
  ensure_id: string
  ensure_digest: string
  worktree_id: string
  repository: string
  base_commit: string
  branch: string
  directory: string
  token: string
}

type WorktreeListEntry = {
  path: string
  head: string | null
  branch: string | null
  lockedReason: string | null
}

type RepositorySnapshot = RepositoryPins & {
  branchCommit: string | null
  entries: WorktreeListEntry[]
}

type PresentWorktree = {
  kind: "present"
  repository: RepositorySnapshot
  entry: WorktreeListEntry
  worktreeRootIdentity: PhysicalIdentity
  worktreeDotGit: string
  worktreeDotGitIdentity: PhysicalIdentity
  gitAdminDirectory: string
  gitAdminDirectoryIdentity: PhysicalIdentity
}

type AbsentWorktree = {
  kind: "absent"
  repository: RepositorySnapshot
}

type WorktreeInspection = PresentWorktree | AbsentWorktree

type StorageGuard = {
  directory: FileHandle
  lock: HeldLock
  lockIdentity: Stats
  rootIdentity: Stats
}

type StableDirectoryGuard = {
  directory: FileHandle
  path: string
  verify: () => Promise<void>
}

type OpenStableDirectoryGuard = StableDirectoryGuard & {
  identity: BigIntStats
  close: () => Promise<void>
}

type PrivateFileRead = {
  bytes: Uint8Array
  identity: Stats
}

/**
 * Recoverable exact Worktree creation. The caller durably claims the public
 * ensure request first and durably advances the returned transition itself;
 * this class owns only the private Git-effect evidence between those steps.
 */
export class ExactWorktreeCreator {
  private readonly environment: Readonly<Record<string, string>>
  private readonly fault: ExactWorktreeCreationOptions["fault"]
  private readonly git: ExactWorktreeGitCommandRunner
  private readonly lockAttempts: number
  private readonly lockDelayMs: number
  private readonly newToken: () => string
  private readonly uid: number
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly authorityRoot: string,
    options: ExactWorktreeCreationOptions = {},
  ) {
    this.environment = scrubGitEnvironment(options.environment ?? process.env)
    this.fault = options.fault
    this.git = options.git ?? runGit
    this.lockAttempts = options.lockAttempts ?? 1_000
    this.lockDelayMs = options.lockDelayMs ?? 2
    this.newToken = options.token ?? (() => `fmx-exact-worktree:${randomBytes(32).toString("hex")}`)
    this.uid = options.uid ?? currentUid()
  }

  create(requestInput: EnsureRequest): Promise<WorktreeCreatedTransition> {
    return this.serial(() => this.withLock(async (storage) => {
      const request = parseRequest(requestInput)
      const path = transactionPathFor(this.authorityRoot, request.ensure_id)
      const directory = storageDirectoryGuard(this.authorityRoot, storage, this.uid)
      const existing = await readTransactionIfPresent(path, this.uid, directory)
      let transaction = existing?.transaction ?? null
      let transactionIdentity = existing?.identity ?? null

      if (transaction === null) {
        const inspection = await this.inspect(request)
        if (inspection.kind === "present") {
          throw conflict(
            "planned Worktree already exists without private creation authority; preserving it",
          )
        }
        if (inspection.repository.branchCommit !== null) {
          throw conflict(
            "planned branch already exists without a durable pre-effect absence claim; preserving it",
          )
        }
        const token = this.newToken()
        if (!TOKEN.test(token)) {
          throw authorityError("corrupt_authority", "Worktree creation token is not exact")
        }
        transaction = {
          schema_id: AUTHORITY_SCHEMA_ID,
          schema_version: AUTHORITY_SCHEMA_VERSION,
          ensure_id: request.ensure_id,
          ensure_digest: request.ensure_digest,
          worktree_id: request.worktree_id,
          repository: request.planned_worktree.repository,
          base_commit: request.planned_worktree.base_commit,
          branch: request.planned_worktree.branch,
          directory: request.planned_worktree.directory,
          token,
          baseline: {
            ...repositoryPins(inspection.repository),
            branch_was_absent: true,
          },
          state: "claimed",
          pins: null,
        }
        transactionIdentity = await createPrivateFile(path, transaction, this.uid, directory)
      } else {
        assertTransactionMatches(transaction, request)
      }

      if (transactionIdentity === null) {
        throw authorityError("corrupt_authority", "Worktree transaction lacks a stable identity")
      }
      return await this.reconcile(path, transaction, transactionIdentity, request, directory)
    }))
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async withLock<T>(operation: (guard: StorageGuard) => Promise<T>): Promise<T> {
    const expectedRoot = await ensurePrivateRoot(this.authorityRoot, this.uid)
    const lockPath = join(this.authorityRoot, LOCK_FILE)
    const expectedLock = await ensurePrivateLock(lockPath, this.uid)
    for (let attempt = 0; attempt < this.lockAttempts; attempt++) {
      const lock = acquireExclusiveLock(lockPath, { create: false, noFollow: true })
      if (lock === undefined) {
        throw authorityError("lock_unavailable", "native flock is unavailable for Worktree creation")
      }
      if (lock !== null) {
        let directory: FileHandle | null = null
        try {
          const locked = fstatSync(lock.descriptor)
          assertPrivateStats(lockPath, locked, this.uid)
          if (!sameStatsIdentity(expectedLock, locked)) {
            throw authorityError("unsafe_storage", "Worktree creation lock changed before acquisition")
          }
          directory = await open(this.authorityRoot, constants.O_RDONLY | constants.O_NOFOLLOW)
          const rootIdentity = await directory.stat()
          assertPrivateRootStats(this.authorityRoot, rootIdentity, this.uid)
          if (!sameRootIdentity(expectedRoot, rootIdentity)) {
            throw authorityError("unsafe_storage", "Worktree authority root changed before lock acquisition")
          }
          const guard = {
            directory,
            lock,
            lockIdentity: locked,
            rootIdentity,
          }
          await assertStorageGuard(this.authorityRoot, guard, this.uid)
          const result = await operation(guard)
          await assertStorageGuard(this.authorityRoot, guard, this.uid)
          return result
        } finally {
          lock.release()
          await directory?.close().catch(() => undefined)
        }
      }
      await delay(this.lockDelayMs)
    }
    throw authorityError("lock_unavailable", "Worktree creation lock remained held")
  }

  private async reconcile(
    transactionPath: string,
    transaction: CreationTransaction,
    transactionIdentity: Stats,
    request: EnsureRequest,
    storage: StableDirectoryGuard,
  ): Promise<WorktreeCreatedTransition> {
    await storage.verify()
    await assertPrivateTargetSnapshot(transactionPath, transactionIdentity, this.uid)
    let inspection = await this.inspect(request)
    assertRepositoryPins(transaction.baseline, inspection.repository)

    if (transaction.state === "pinned") {
      if (inspection.kind !== "present" || transaction.pins === null) {
        throw conflict("durably pinned Worktree is absent or no longer exact; preserving current state")
      }
      await this.verifyOwnedPresent(transaction, inspection, transaction.pins)
      inspection = await this.unlockIfNeeded(transaction, request, inspection)
      await this.verifyOwnedPresent(transaction, inspection, transaction.pins)
      await assertPrivateTargetSnapshot(transactionPath, transactionIdentity, this.uid)
      return await this.complete(request)
    }

    if (transaction.pins !== null) {
      throw authorityError("corrupt_authority", "claimed Worktree transaction unexpectedly carries pins")
    }
    if (inspection.kind === "present") {
      requireExactLock(transaction, inspection)
      await this.after("after_git_accepted", request)
      return await this.finishAccepted(
        transactionPath,
        transaction,
        transactionIdentity,
        request,
        inspection,
        storage,
      )
    }

    if (
      inspection.repository.branchCommit !== null &&
      inspection.repository.branchCommit !== request.planned_worktree.base_commit
    ) {
      throw conflict("planned branch points at a different commit")
    }
    if (inspection.repository.branchCommit !== null) {
      await this.requireOwnedBranch(transaction, request, inspection.repository)
    }

    await storage.verify()
    await assertPrivateTargetSnapshot(transactionPath, transactionIdentity, this.uid)
    await this.after("before_effect", request)
    await storage.verify()
    await assertPrivateTargetSnapshot(transactionPath, transactionIdentity, this.uid)
    inspection = await this.inspect(request)
    assertRepositoryPins(transaction.baseline, inspection.repository)
    if (inspection.kind === "present") {
      requireExactLock(transaction, inspection)
      await this.after("after_git_accepted", request)
      return await this.finishAccepted(
        transactionPath,
        transaction,
        transactionIdentity,
        request,
        inspection,
        storage,
      )
    }
    if (inspection.repository.branchCommit !== null) {
      await this.requireOwnedBranch(transaction, request, inspection.repository)
    }

    const accepted = await this.addWorktree(transaction, request, inspection)
    await this.after("after_git_accepted", request)
    return await this.finishAccepted(
      transactionPath,
      transaction,
      transactionIdentity,
      request,
      accepted,
      storage,
    )
  }

  private async addWorktree(
    transaction: CreationTransaction,
    request: EnsureRequest,
    initial: AbsentWorktree,
  ): Promise<PresentWorktree> {
    const plan = request.planned_worktree
    let repository = initial.repository
    if (repository.branchCommit === null) {
      const branchResult = await this.command(plan.repository, [
        "update-ref",
        "--no-deref",
        "--create-reflog",
        "-m",
        transaction.token,
        `refs/heads/${plan.branch}`,
        plan.base_commit,
        "0".repeat(plan.base_commit.length),
      ])
      const recovered = await this.inspect(request)
      assertRepositoryPins(transaction.baseline, recovered.repository)
      if (recovered.kind === "present") {
        requireExactLock(transaction, recovered)
        return recovered
      }
      repository = recovered.repository
      if (repository.branchCommit === null) {
        throw transient(commandFailure("git update-ref planned branch", branchResult))
      }
      if (repository.branchCommit !== plan.base_commit) {
        throw conflict("planned branch was created at a different commit")
      }
    }
    await this.requireOwnedBranch(transaction, request, repository)

    const result = await this.command(plan.repository, [
      "worktree",
      "add",
      "--lock",
      "--reason",
      transaction.token,
      "--",
      plan.directory,
      plan.branch,
    ])
    const recovered = await this.inspect(request)
    assertRepositoryPins(transaction.baseline, recovered.repository)
    if (recovered.kind === "present") {
      requireExactLock(transaction, recovered)
      return recovered
    }
    if (recovered.repository.branchCommit === plan.base_commit) {
      await this.requireOwnedBranch(transaction, request, recovered.repository)
    }
    if (result.exitCode !== 0) {
      throw transient(commandFailure("git worktree add", result))
    }
    throw transient("git worktree add reported success without an exact registered Worktree")
  }

  private async requireOwnedBranch(
    transaction: CreationTransaction,
    request: EnsureRequest,
    repository: RepositorySnapshot,
  ): Promise<void> {
    const plan = request.planned_worktree
    if (repository.branchCommit !== plan.base_commit) {
      throw conflict("planned branch does not retain its exact created commit")
    }
    const result = await this.command(plan.repository, [
      "reflog",
      "show",
      "--format=%H%x00%gs",
      "--max-count=2",
      `refs/heads/${plan.branch}`,
    ])
    if (result.exitCode < 0) {
      throw transient(commandFailure("git reflog planned branch", result))
    }
    if (result.exitCode !== 0) {
      throw conflict("planned branch lacks exact private creation provenance")
    }
    let entries: { commit: string; message: string }[]
    try {
      entries = parseBranchReflog(result.stdout)
    } catch (error) {
      throw conflict(`planned branch creation provenance is ambiguous: ${errorMessage(error)}`)
    }
    if (
      entries.length !== 1 ||
      entries[0]!.commit !== plan.base_commit ||
      entries[0]!.message !== transaction.token
    ) {
      throw conflict("planned branch does not carry the exact private creation provenance")
    }
  }

  private async finishAccepted(
    transactionPath: string,
    transaction: CreationTransaction,
    transactionIdentity: Stats,
    request: EnsureRequest,
    accepted: PresentWorktree,
    storage: StableDirectoryGuard,
  ): Promise<WorktreeCreatedTransition> {
    requireExactLock(transaction, accepted)
    const admin = await openStableDirectoryGuard(accepted.gitAdminDirectory)
    if (!samePhysical(accepted.gitAdminDirectoryIdentity, physical(admin.identity))) {
      await admin.close()
      throw conflict("Worktree Git administration directory changed before marker creation")
    }
    try {
      await assertAndSyncLockReason(accepted.gitAdminDirectory, transaction.token, admin)
      const marker = markerFor(transaction)
      const markerPath = join(accepted.gitAdminDirectory, MARKER_FILE)
      await ensureMarker(markerPath, marker, this.uid, admin)
      await this.after("after_marker_sync", request)

      const reinspected = await this.inspect(request)
      assertRepositoryPins(transaction.baseline, reinspected.repository)
      if (reinspected.kind !== "present") {
        throw conflict("Worktree disappeared while private ownership evidence was being committed")
      }
      requireExactLock(transaction, reinspected)
      if (
        reinspected.gitAdminDirectory !== accepted.gitAdminDirectory ||
        reinspected.worktreeDotGit !== accepted.worktreeDotGit ||
        !samePhysical(reinspected.gitAdminDirectoryIdentity, accepted.gitAdminDirectoryIdentity) ||
        !samePhysical(reinspected.worktreeDotGitIdentity, accepted.worktreeDotGitIdentity)
      ) {
        throw conflict("Worktree Git administration identity changed before durable pinning")
      }
      await admin.verify()
      await assertMarker(markerPath, marker, this.uid, admin)
      const pins = await worktreePins(reinspected, markerPath, this.uid)
      await admin.verify()
      const pinned: CreationTransaction = {
        ...transaction,
        state: "pinned",
        pins,
      }
      await replacePrivateFile(
        transactionPath,
        pinned,
        this.uid,
        storage,
        transactionIdentity,
      )
      await this.after("after_pins_sync", request)

      const unlocked = await this.unlockIfNeeded(pinned, request, reinspected)
      await this.verifyOwnedPresent(pinned, unlocked, pins)
      await this.after("after_unlock", request)
      return await this.complete(request)
    } finally {
      await admin.close().catch(() => undefined)
    }
  }

  private async unlockIfNeeded(
    transaction: CreationTransaction,
    request: EnsureRequest,
    present: PresentWorktree,
  ): Promise<PresentWorktree> {
    if (present.entry.lockedReason === null) return present
    requireExactLock(transaction, present)
    const result = await this.command(request.planned_worktree.repository, [
      "worktree",
      "unlock",
      "--",
      request.planned_worktree.directory,
    ])
    const recovered = await this.inspect(request)
    assertRepositoryPins(transaction.baseline, recovered.repository)
    if (recovered.kind !== "present") {
      throw conflict("Worktree changed while its private creation lock was being released")
    }
    if (recovered.entry.lockedReason === null) return recovered
    if (recovered.entry.lockedReason !== transaction.token) {
      throw conflict("Worktree creation lock was replaced by foreign authority")
    }
    throw transient(commandFailure("git worktree unlock", result))
  }

  private async verifyOwnedPresent(
    transaction: CreationTransaction,
    present: PresentWorktree,
    pins: WorktreePins,
  ): Promise<void> {
    if (
      present.entry.lockedReason !== null &&
      present.entry.lockedReason !== transaction.token
    ) {
      throw conflict("Worktree carries a foreign lock reason")
    }
    const admin = await openStableDirectoryGuard(present.gitAdminDirectory)
    try {
      if (!samePhysical(present.gitAdminDirectoryIdentity, physical(admin.identity))) {
        throw conflict("Worktree Git administration directory changed during verification")
      }
      if (present.entry.lockedReason === transaction.token) {
        await assertAndSyncLockReason(present.gitAdminDirectory, transaction.token, admin)
      }
      const markerPath = join(present.gitAdminDirectory, MARKER_FILE)
      await assertMarker(markerPath, markerFor(transaction), this.uid, admin)
      const current = await worktreePins(present, markerPath, this.uid)
      await admin.verify()
      if (!sameCanonical(current, pins)) {
        throw conflict("Worktree physical identity changed after durable creation; preserving replacement")
      }
    } finally {
      await admin.close().catch(() => undefined)
    }
  }

  private async inspect(request: EnsureRequest): Promise<WorktreeInspection> {
    const plan = request.planned_worktree
    if (
      !exactAbsolutePath(plan.repository) ||
      !exactAbsolutePath(plan.directory) ||
      plan.repository === plan.directory
    ) {
      throw conflict("planned repository and Worktree paths are not distinct exact absolute paths")
    }
    const repository = await this.inspectRepository(request)
    const expectedBranch = `refs/heads/${plan.branch}`
    const registrations = repository.entries.filter((entry) => entry.path === plan.directory)
    if (registrations.length > 1) throw conflict("Git repeats the exact planned Worktree path")
    const branchRegistrations = repository.entries.filter((entry) => entry.branch === expectedBranch)
    const pathExists = await pathExistsWithoutFollowing(plan.directory)

    if (registrations.length === 0) {
      if (pathExists) {
        throw conflict("planned Worktree path exists without its exact Git registration")
      }
      if (branchRegistrations.length > 0) {
        throw conflict("planned branch is already checked out by another Worktree")
      }
      return { kind: "absent", repository }
    }
    if (!pathExists) throw conflict("Git registration exists but the planned Worktree path is absent")

    const entry = registrations[0]!
    if (
      entry.branch !== expectedBranch ||
      entry.head !== plan.base_commit ||
      repository.branchCommit !== plan.base_commit
    ) {
      throw conflict("registered Worktree branch or HEAD differs from the exact plan")
    }
    if (branchRegistrations.length !== 1 || branchRegistrations[0] !== entry) {
      throw conflict("planned branch registration is ambiguous")
    }
    let canonicalDirectory: string
    try {
      canonicalDirectory = await realpath(plan.directory)
    } catch (error) {
      throw conflict(`registered Worktree root cannot be resolved exactly: ${errorMessage(error)}`)
    }
    if (canonicalDirectory !== plan.directory) {
      throw conflict("planned Worktree root is not its canonical path")
    }
    const targetContext = await this.gitContext(plan.directory)
    if (
      targetContext.root !== plan.directory ||
      targetContext.commonGitDirectory !== repository.common_git_directory
    ) {
      throw conflict("Worktree resolves to a different checkout root or common Git directory")
    }
    const symbolic = await this.command(plan.directory, ["symbolic-ref", "--quiet", "HEAD"])
    if (symbolic.exitCode < 0) throw transient(commandFailure("git symbolic-ref HEAD", symbolic))
    if (
      symbolic.exitCode !== 0 ||
      decodeOneLine(symbolic.stdout, "Worktree branch") !== expectedBranch
    ) {
      throw conflict("Worktree HEAD is not attached to the exact planned branch")
    }
    const head = await this.command(plan.directory, ["rev-parse", "--verify", "HEAD"])
    if (head.exitCode < 0) throw transient(commandFailure("git rev-parse Worktree HEAD", head))
    if (
      head.exitCode !== 0 ||
      decodeOneLine(head.stdout, "Worktree HEAD") !== plan.base_commit
    ) {
      throw conflict("Worktree HEAD changed from the exact planned commit")
    }
    const worktreeDotGit = join(plan.directory, ".git")
    const gitAdminDirectory = await readLinkedAdminDirectory(
      worktreeDotGit,
      repository.common_git_directory,
    )
    return {
      kind: "present",
      repository,
      entry,
      worktreeRootIdentity: await directoryIdentity(plan.directory),
      worktreeDotGit,
      worktreeDotGitIdentity: await regularFileIdentity(worktreeDotGit),
      gitAdminDirectory,
      gitAdminDirectoryIdentity: await directoryIdentity(gitAdminDirectory),
    }
  }

  private async inspectRepository(request: EnsureRequest): Promise<RepositorySnapshot> {
    const plan = request.planned_worktree
    let canonicalRepository: string
    try {
      canonicalRepository = await realpath(plan.repository)
    } catch (error) {
      throw transient(`cannot resolve planned repository: ${errorMessage(error)}`)
    }
    if (canonicalRepository !== plan.repository) {
      throw conflict("planned repository is not its canonical physical path")
    }
    const context = await this.gitContext(plan.repository)
    if (context.root !== plan.repository) {
      throw conflict("planned repository is not the exact main Worktree root")
    }
    const branchCheck = await this.command(plan.repository, [
      "check-ref-format",
      "--branch",
      plan.branch,
    ])
    if (branchCheck.exitCode < 0) {
      throw transient(commandFailure("git check-ref-format", branchCheck))
    }
    if (branchCheck.exitCode !== 0) throw conflict("planned branch is not a valid Git branch")
    const commit = await this.command(plan.repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${plan.base_commit}^{commit}`,
    ])
    if (commit.exitCode < 0) throw transient(commandFailure("git rev-parse base commit", commit))
    if (
      commit.exitCode !== 0 ||
      decodeOneLine(commit.stdout, "planned base commit") !== plan.base_commit
    ) {
      throw conflict("planned base commit is not an exact commit in the planned repository")
    }
    const branch = await this.command(plan.repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${plan.branch}`,
    ])
    let branchCommit: string | null
    if (branch.exitCode === 0) {
      branchCommit = decodeOneLine(branch.stdout, "planned branch")
      if (!GIT_OBJECT_ID.test(branchCommit)) throw conflict("planned branch has no exact commit")
    } else if (branch.exitCode === 1 && branch.stdout.byteLength === 0) {
      branchCommit = null
    } else {
      throw transient(commandFailure("git rev-parse planned branch", branch))
    }
    const listed = await this.command(plan.repository, ["worktree", "list", "--porcelain", "-z"])
    if (listed.exitCode !== 0) throw transient(commandFailure("git worktree list", listed))
    let entries: WorktreeListEntry[]
    try {
      entries = parseWorktreeList(listed.stdout)
    } catch (error) {
      throw conflict(`cannot parse exact Git Worktree registration: ${errorMessage(error)}`)
    }
    const main = entries.filter((entry) => entry.path === plan.repository)
    if (main.length !== 1 || entries[0] !== main[0]) {
      throw conflict("planned repository is not the exact registered main Worktree")
    }
    const targetParent = dirname(plan.directory)
    if (!exactAbsolutePath(targetParent)) throw conflict("planned Worktree parent is not exact")
    let canonicalParent: string
    try {
      canonicalParent = await realpath(targetParent)
    } catch (error) {
      throw conflict(`planned Worktree parent does not exist: ${errorMessage(error)}`)
    }
    if (canonicalParent !== targetParent) {
      throw conflict("planned Worktree parent is not its canonical physical path")
    }
    const repositoryDotGit = join(plan.repository, ".git")
    const snapshot: RepositorySnapshot = {
      repository_root: plan.repository,
      repository_root_identity: await directoryIdentity(plan.repository),
      repository_dot_git: repositoryDotGit,
      repository_dot_git_identity: await nonSymlinkIdentity(repositoryDotGit),
      common_git_directory: context.commonGitDirectory,
      common_git_directory_identity: await directoryIdentity(context.commonGitDirectory),
      target_parent: targetParent,
      target_parent_identity: await directoryIdentity(targetParent),
      branchCommit,
      entries,
    }
    const repeated = {
      repository_root: plan.repository,
      repository_root_identity: await directoryIdentity(plan.repository),
      repository_dot_git: repositoryDotGit,
      repository_dot_git_identity: await nonSymlinkIdentity(repositoryDotGit),
      common_git_directory: context.commonGitDirectory,
      common_git_directory_identity: await directoryIdentity(context.commonGitDirectory),
      target_parent: targetParent,
      target_parent_identity: await directoryIdentity(targetParent),
    }
    if (
      !sameCanonical(repositoryPins(snapshot), repeated) ||
      await realpath(plan.repository) !== plan.repository ||
      await realpath(context.commonGitDirectory) !== context.commonGitDirectory ||
      await realpath(targetParent) !== targetParent
    ) {
      throw conflict("repository identity changed during exact inspection")
    }
    return snapshot
  }

  private async gitContext(cwd: string): Promise<{ commonGitDirectory: string; root: string }> {
    const result = await this.command(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--show-toplevel",
    ])
    if (result.exitCode !== 0) throw transient(commandFailure("git repository identity", result))
    let lines: string[]
    try {
      lines = decodeLines(result.stdout)
    } catch (error) {
      throw conflict(`Git repository identity is ambiguous: ${errorMessage(error)}`)
    }
    if (
      lines.length !== 2 ||
      !exactAbsolutePath(lines[0]!) ||
      !exactAbsolutePath(lines[1]!)
    ) {
      throw conflict("Git repository identity is not two exact absolute paths")
    }
    let common: string
    try {
      common = await realpath(lines[0]!)
    } catch (error) {
      throw transient(`cannot resolve common Git directory: ${errorMessage(error)}`)
    }
    if (common !== lines[0]) throw conflict("common Git directory is not canonical")
    return { commonGitDirectory: common, root: lines[1]! }
  }

  private async command(
    cwd: string,
    args: readonly string[],
  ): Promise<ExactWorktreeGitCommandResult> {
    try {
      return await this.git(cwd, args, this.environment)
    } catch (error) {
      return { exitCode: -1, stdout: new Uint8Array(), stderr: errorMessage(error) }
    }
  }

  private async after(point: ExactWorktreeCreationFaultPoint, request: EnsureRequest): Promise<void> {
    await this.fault?.(point, request)
  }

  private async complete(request: EnsureRequest): Promise<WorktreeCreatedTransition> {
    const transition: WorktreeCreatedTransition = {
      kind: "worktree_created",
      directory: request.planned_worktree.directory,
      head_commit: request.planned_worktree.base_commit,
    }
    await this.after("response_loss", request)
    return transition
  }
}

export function transactionPathFor(authorityRoot: string, ensureId: string): string {
  return join(authorityRoot, `${createHash("sha256").update(ensureId).digest("hex")}.json`)
}

function parseRequest(input: EnsureRequest): EnsureRequest {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    parsed.data.message_type !== "ensure_request" ||
    !("planned_worktree" in parsed.data)
  ) {
    throw authorityError("invalid_request", "exact Worktree creation requires one valid ensure request")
  }
  const request = { ...parsed.data, message_type: "ensure_request" } as EnsureRequest
  if (deriveEnsureDigest(request) !== request.ensure_digest) {
    throw authorityError("invalid_request", "ensure digest does not bind the exact Worktree plan")
  }
  return structuredClone(request)
}

function assertTransactionMatches(transaction: CreationTransaction, request: EnsureRequest): void {
  const plan = request.planned_worktree
  for (const [label, retained, expected] of [
    ["ensure id", transaction.ensure_id, request.ensure_id],
    ["ensure digest", transaction.ensure_digest, request.ensure_digest],
    ["Worktree id", transaction.worktree_id, request.worktree_id],
    ["repository", transaction.repository, plan.repository],
    ["base commit", transaction.base_commit, plan.base_commit],
    ["branch", transaction.branch, plan.branch],
    ["directory", transaction.directory, plan.directory],
  ] as const) {
    if (retained !== expected) {
      throw authorityError("authority_conflict", `private Worktree authority changed ${label}`)
    }
  }
}

function markerFor(transaction: CreationTransaction): OwnerMarker {
  return {
    schema_id: MARKER_SCHEMA_ID,
    schema_version: MARKER_SCHEMA_VERSION,
    ensure_id: transaction.ensure_id,
    ensure_digest: transaction.ensure_digest,
    worktree_id: transaction.worktree_id,
    repository: transaction.repository,
    base_commit: transaction.base_commit,
    branch: transaction.branch,
    directory: transaction.directory,
    token: transaction.token,
  }
}

function repositoryPins(snapshot: RepositoryPins | RepositorySnapshot): RepositoryPins {
  return {
    repository_root: snapshot.repository_root,
    repository_root_identity: snapshot.repository_root_identity,
    repository_dot_git: snapshot.repository_dot_git,
    repository_dot_git_identity: snapshot.repository_dot_git_identity,
    common_git_directory: snapshot.common_git_directory,
    common_git_directory_identity: snapshot.common_git_directory_identity,
    target_parent: snapshot.target_parent,
    target_parent_identity: snapshot.target_parent_identity,
  }
}

function assertRepositoryPins(expected: RepositoryPins, current: RepositorySnapshot): void {
  if (!sameCanonical(repositoryPins(expected), repositoryPins(current))) {
    throw conflict("repository, common Git directory, or Worktree parent physical identity changed")
  }
}

async function worktreePins(
  present: PresentWorktree,
  markerPath: string,
  uid: number,
): Promise<WorktreePins> {
  const read = async (): Promise<WorktreePins> => ({
    worktree_root_identity: await directoryIdentity(present.entry.path),
    worktree_dot_git: present.worktreeDotGit,
    worktree_dot_git_identity: await regularFileIdentity(present.worktreeDotGit),
    git_admin_directory: present.gitAdminDirectory,
    git_admin_directory_identity: await directoryIdentity(present.gitAdminDirectory),
    marker: markerPath,
    marker_identity: await privateFileIdentity(markerPath, uid),
  })
  const pins = await read()
  const repeated = await read()
  if (
    !sameCanonical(pins, repeated) ||
    !samePhysical(pins.worktree_root_identity, present.worktreeRootIdentity) ||
    !samePhysical(pins.worktree_dot_git_identity, present.worktreeDotGitIdentity) ||
    !samePhysical(pins.git_admin_directory_identity, present.gitAdminDirectoryIdentity)
  ) {
    throw conflict("Worktree physical identity changed during exact pinning")
  }
  return pins
}

function requireExactLock(transaction: CreationTransaction, present: PresentWorktree): void {
  if (present.entry.lockedReason !== transaction.token) {
    throw conflict("existing Worktree does not carry the exact private creation lock")
  }
}

async function readLinkedAdminDirectory(dotGit: string, commonGitDirectory: string): Promise<string> {
  await regularFileIdentity(dotGit)
  const bytes = await readBoundedFile(dotGit, 8 * 1024)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw conflict("linked Worktree .git file is not valid UTF-8")
  }
  const match = /^gitdir: ([^\r\n]+)\n$/u.exec(text)
  if (!match || !exactAbsolutePath(match[1]!)) {
    throw conflict("linked Worktree .git file does not name one exact absolute admin directory")
  }
  const admin = match[1]!
  const worktrees = join(commonGitDirectory, "worktrees")
  let canonical: string
  try {
    canonical = await realpath(admin)
  } catch (error) {
    throw conflict(`linked Worktree admin directory is unavailable: ${errorMessage(error)}`)
  }
  const child = relative(worktrees, canonical)
  if (
    canonical !== admin ||
    child.length === 0 ||
    child.startsWith("..") ||
    child.includes(sep)
  ) {
    throw conflict("linked Worktree admin directory is outside the exact common Git directory")
  }
  await directoryIdentity(admin)
  return admin
}

async function assertAndSyncLockReason(
  adminDirectory: string,
  token: string,
  guard?: StableDirectoryGuard,
): Promise<void> {
  await guard?.verify()
  const path = join(adminDirectory, "locked")
  await regularFileIdentity(path)
  const bytes = await readBoundedFile(path, 8 * 1024)
  let reason: string
  try {
    reason = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw conflict("Worktree creation lock reason is not valid UTF-8")
  }
  if (reason !== `${token}\n`) throw conflict("Worktree creation lock file carries foreign authority")
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (guard) {
    await guard.directory.sync()
    await guard.verify()
  } else {
    await syncDirectory(adminDirectory)
  }
}

function parseWorktreeList(bytes: Uint8Array): WorktreeListEntry[] {
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
      if (!exactAbsolutePath(path)) throw new Error("Worktree registration path is not exact")
      current = { path, head: null, branch: null, lockedReason: null }
      continue
    }
    if (!current) throw new Error("Worktree registration field precedes its path")
    if (field.startsWith("HEAD ")) {
      if (current.head !== null) throw new Error("Worktree registration repeats HEAD")
      const head = field.slice("HEAD ".length)
      if (!GIT_OBJECT_ID.test(head)) throw new Error("Worktree registration HEAD is not exact")
      current.head = head
    } else if (field.startsWith("branch ")) {
      if (current.branch !== null) throw new Error("Worktree registration repeats branch")
      current.branch = field.slice("branch ".length)
    } else if (field === "detached" || field === "bare") {
      // Represented by the absence of a branch.
    } else if (field === "locked" || field.startsWith("locked ")) {
      if (current.lockedReason !== null) throw new Error("Worktree registration repeats lock")
      current.lockedReason = field === "locked" ? "" : field.slice("locked ".length)
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      // A prunable exact target is rejected later because its path is absent.
    } else {
      throw new Error(`unknown Worktree registration field ${field.slice(0, 64)}`)
    }
  }
  if (current) throw new Error("Worktree registration lacks a trailing record separator")
  return entries
}

function parseBranchReflog(bytes: Uint8Array): { commit: string; message: string }[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (text.length === 0) return []
  if (!text.endsWith("\n") || text.includes("\r")) {
    throw new Error("branch reflog is not exact newline-delimited output")
  }
  const lines = text.slice(0, -1).split("\n")
  return lines.map((line) => {
    const fields = line.split("\0")
    if (fields.length !== 2 || !GIT_OBJECT_ID.test(fields[0]!) || fields[1]!.length === 0) {
      throw new Error("branch reflog entry is not one exact commit and message")
    }
    return { commit: fields[0]!, message: fields[1]! }
  })
}

async function runGit(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<ExactWorktreeGitCommandResult> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    child = Bun.spawn([
      "git",
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.excludesFile=/dev/null",
      ...args,
    ], {
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
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, GIT_OUTPUT_MAX_BYTES, () => child.kill()),
      readBounded(child.stderr, 64 * 1024, () => child.kill()),
      child.exited,
    ])
    return {
      exitCode,
      stdout,
      stderr: new TextDecoder().decode(stderr).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim(),
    }
  } catch (error) {
    child.kill()
    await child.exited.catch(() => undefined)
    return { exitCode: -1, stdout: new Uint8Array(), stderr: errorMessage(error) }
  } finally {
    clearTimeout(timer)
  }
}

function scrubGitEnvironment(parent: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && !key.startsWith("GIT_")) environment[key] = value
  }
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_CONFIG_GLOBAL = "/dev/null"
  environment.GIT_TERMINAL_PROMPT = "0"
  environment.GIT_PAGER = "cat"
  environment.LC_ALL = "C"
  return environment
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
        throw new Error(`Git stream exceeds ${maximumBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function ensurePrivateRoot(root: string, uid: number): Promise<Stats> {
  if (!exactAbsolutePath(root)) {
    throw authorityError("unsafe_storage", "Worktree authority root is not an exact absolute path")
  }
  let created = false
  try {
    await lstat(root)
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error
    const parent = dirname(root)
    let canonicalParent: string
    try {
      canonicalParent = await realpath(parent)
    } catch (parentError) {
      throw authorityError(
        "unsafe_storage",
        `Worktree authority parent is unavailable: ${errorMessage(parentError)}`,
      )
    }
    if (canonicalParent !== parent) {
      throw authorityError("unsafe_storage", "Worktree authority parent is not canonical")
    }
    await mkdir(root, { mode: 0o700 })
    created = true
  }
  const stats = await lstat(root)
  assertPrivateRootStats(root, stats, uid)
  if (await realpath(root) !== root) {
    throw authorityError("unsafe_storage", `Worktree authority root crosses a symbolic link: ${root}`)
  }
  if (created) await syncDirectory(dirname(root))
  return stats
}

function assertPrivateRootStats(root: string, stats: Stats, uid: number): void {
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== uid || (stats.mode & 0o777) !== 0o700) {
    throw authorityError("unsafe_storage", `unsafe Worktree authority root ${root}`)
  }
}

async function ensurePrivateLock(path: string, uid: number): Promise<Stats> {
  let handle: FileHandle | null = null
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.chmod(0o600)
    await handle.sync()
    await syncDirectory(dirname(path))
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw authorityError("unsafe_storage", `cannot create Worktree authority lock: ${errorMessage(error)}`)
    }
  } finally {
    await handle?.close()
  }
  return await assertPrivateFile(path, uid)
}

function assertPrivateStats(path: string, stats: Stats, uid: number): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== uid ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw authorityError("unsafe_storage", `unsafe private Worktree authority file ${path}`)
  }
}

function storageDirectoryGuard(
  root: string,
  storage: StorageGuard,
  uid: number,
): StableDirectoryGuard {
  return {
    directory: storage.directory,
    path: root,
    verify: () => assertStorageGuard(root, storage, uid),
  }
}

async function assertStorageGuard(
  root: string,
  guard: StorageGuard,
  uid: number,
): Promise<void> {
  const descriptorIdentity = await guard.directory.stat()
  assertPrivateRootStats(root, descriptorIdentity, uid)
  if (!sameRootIdentity(guard.rootIdentity, descriptorIdentity)) {
    throw authorityError("unsafe_storage", `Worktree authority root descriptor changed: ${root}`)
  }
  const pathIdentity = await lstat(root)
  assertPrivateRootStats(root, pathIdentity, uid)
  if (
    !sameRootIdentity(guard.rootIdentity, pathIdentity) ||
    await realpath(root) !== root
  ) {
    throw authorityError("unsafe_storage", `Worktree authority root path changed while locked: ${root}`)
  }

  const lockPath = join(root, LOCK_FILE)
  const descriptorLock = fstatSync(guard.lock.descriptor)
  assertPrivateStats(lockPath, descriptorLock, uid)
  if (!sameFileIdentity(guard.lockIdentity, descriptorLock)) {
    throw authorityError("unsafe_storage", "Worktree creation lock descriptor changed while held")
  }
  const pathLock = await assertPrivateFile(lockPath, uid)
  if (!sameFileIdentity(guard.lockIdentity, pathLock)) {
    throw authorityError("unsafe_storage", "Worktree creation lock path changed while held")
  }
}

async function readTransactionIfPresent(
  path: string,
  uid: number,
  guard: StableDirectoryGuard,
): Promise<{ transaction: CreationTransaction; identity: Stats } | null> {
  await guard.verify()
  let read: PrivateFileRead
  try {
    read = await readPrivateFile(path, uid)
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null
    if (error instanceof ExactWorktreeCreationError) throw error
    throw authorityError("corrupt_authority", `cannot read Worktree authority: ${errorMessage(error)}`)
  }
  try {
    const transaction = parseTransaction(read.bytes)
    await guard.directory.sync()
    await guard.verify()
    return { transaction, identity: read.identity }
  } catch (error) {
    if (error instanceof ExactWorktreeCreationError) throw error
    throw authorityError("corrupt_authority", `cannot read Worktree authority: ${errorMessage(error)}`)
  }
}

async function writeNewPrivateFile(path: string, value: unknown, uid: number): Promise<Stats> {
  const bytes = privateBytes(value)
  let handle: FileHandle | null = null
  let identity: Stats | null = null
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.chmod(0o600)
    await writeAll(handle, bytes)
    await handle.sync()
    identity = await handle.stat()
    assertPrivateStats(path, identity, uid)
    const pathnameIdentity = await assertPrivateFile(path, uid)
    if (!sameFileIdentity(identity, pathnameIdentity)) {
      throw authorityError("unsafe_storage", `private Worktree temporary changed after write: ${path}`)
    }
  } catch (error) {
    if (error instanceof ExactWorktreeCreationError) throw error
    throw authorityError("unsafe_storage", `cannot create private Worktree authority: ${errorMessage(error)}`)
  } finally {
    await handle?.close()
  }
  if (identity === null) {
    throw authorityError("unsafe_storage", `private Worktree temporary lacks an identity: ${path}`)
  }
  return identity
}

async function createPrivateFile(
  path: string,
  value: unknown,
  uid: number,
  guard: StableDirectoryGuard,
): Promise<Stats> {
  if (dirname(path) !== guard.path) {
    throw authorityError("unsafe_storage", `private Worktree target escapes its held directory: ${path}`)
  }
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    await guard.verify()
    await assertPrivateTargetSnapshot(path, null, uid)
    const temporaryIdentity = await writeNewPrivateFile(temporary, value, uid)
    await guard.verify()
    await assertPrivateTargetSnapshot(path, null, uid)
    await assertPrivateTargetSnapshot(temporary, temporaryIdentity, uid)
    await rename(temporary, path)
    const renamedIdentity = await assertPrivateFile(path, uid)
    if (!sameFileIdentity(temporaryIdentity, renamedIdentity)) {
      throw authorityError("unsafe_storage", `private Worktree authority changed during rename: ${path}`)
    }
    await guard.directory.sync()
    await guard.verify()
    return renamedIdentity
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function replacePrivateFile(
  path: string,
  value: unknown,
  uid: number,
  guard: StableDirectoryGuard,
  expectedTarget: Stats,
): Promise<Stats> {
  if (dirname(path) !== guard.path) {
    throw authorityError("unsafe_storage", `private Worktree target escapes its held directory: ${path}`)
  }
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    await guard.verify()
    await assertPrivateTargetSnapshot(path, expectedTarget, uid)
    const temporaryIdentity = await writeNewPrivateFile(temporary, value, uid)
    await guard.verify()
    await assertPrivateTargetSnapshot(path, expectedTarget, uid)
    await assertPrivateTargetSnapshot(temporary, temporaryIdentity, uid)
    await rename(temporary, path)
    const renamedIdentity = await assertPrivateFile(path, uid)
    if (!sameFileIdentity(temporaryIdentity, renamedIdentity)) {
      throw authorityError("unsafe_storage", `private Worktree authority changed during rename: ${path}`)
    }
    await guard.directory.sync()
    await guard.verify()
    return renamedIdentity
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function ensureMarker(
  path: string,
  marker: OwnerMarker,
  uid: number,
  guard: StableDirectoryGuard,
): Promise<void> {
  try {
    await createPrivateFile(path, marker, uid, guard)
  } catch (error) {
    try {
      await guard.verify()
      await assertMarker(path, marker, uid, guard)
      await guard.directory.sync()
      await guard.verify()
    } catch {
      throw error
    }
  }
}

async function assertMarker(
  path: string,
  marker: OwnerMarker,
  uid: number,
  guard?: StableDirectoryGuard,
): Promise<void> {
  let value: JsonValue
  try {
    await guard?.verify()
    value = decodePrivateBytes((await readPrivateFile(path, uid)).bytes)
    await guard?.verify()
  } catch (error) {
    throw conflict(`private Worktree marker is absent or unsafe: ${errorMessage(error)}`)
  }
  if (!sameCanonical(value, marker)) {
    throw conflict("private Worktree marker belongs to different creation authority")
  }
}

async function readPrivateFile(path: string, uid: number): Promise<PrivateFileRead> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await handle.stat()
    assertPrivateStats(path, stats, uid)
    const pathnameIdentity = await assertPrivateFile(path, uid)
    if (!sameFileIdentity(stats, pathnameIdentity)) {
      throw authorityError("unsafe_storage", `private Worktree file changed before read: ${path}`)
    }
    if (stats.size < 2 || stats.size > PRIVATE_FILE_MAX_BYTES) {
      throw authorityError("corrupt_authority", `private Worktree file has unsafe size: ${path}`)
    }
    const bytes = new Uint8Array(stats.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (
      offset !== bytes.byteLength ||
      !sameStatsIdentity(stats, after) ||
      after.size !== stats.size ||
      after.mtimeMs !== stats.mtimeMs ||
      after.ctimeMs !== stats.ctimeMs
    ) {
      throw authorityError("unsafe_storage", `private Worktree file changed during read: ${path}`)
    }
    const finalPathIdentity = await assertPrivateFile(path, uid)
    if (!sameFileSnapshot(stats, finalPathIdentity)) {
      throw authorityError("unsafe_storage", `private Worktree file path changed during read: ${path}`)
    }
    return { bytes, identity: stats }
  } finally {
    await handle.close()
  }
}

function privateBytes(value: unknown): Uint8Array {
  const payload = encodeCanonicalJson(value as JsonValue)
  const bytes = new Uint8Array(payload.byteLength + 1)
  bytes.set(payload)
  bytes[payload.byteLength] = 0x0a
  if (bytes.byteLength > PRIVATE_FILE_MAX_BYTES) {
    throw authorityError("corrupt_authority", "private Worktree authority exceeds its byte bound")
  }
  return bytes
}

function decodePrivateBytes(bytes: Uint8Array): JsonValue {
  if (bytes.at(-1) !== 0x0a) throw new Error("private authority lacks final newline")
  const payload = bytes.subarray(0, bytes.byteLength - 1)
  const value = decodeStrictJson(payload)
  if (!Buffer.from(encodeCanonicalJson(value)).equals(Buffer.from(payload))) {
    throw new Error("private authority is not canonical JSON")
  }
  return value
}

function parseTransaction(bytes: Uint8Array): CreationTransaction {
  const value = decodePrivateBytes(bytes)
  if (!isRecord(value)) throw authorityError("corrupt_authority", "Worktree transaction is not an object")
  assertExactKeys(value, [
    "schema_id",
    "schema_version",
    "ensure_id",
    "ensure_digest",
    "worktree_id",
    "repository",
    "base_commit",
    "branch",
    "directory",
    "token",
    "baseline",
    "state",
    "pins",
  ], "Worktree transaction")
  const transaction = value as unknown as CreationTransaction
  if (
    transaction.schema_id !== AUTHORITY_SCHEMA_ID ||
    transaction.schema_version !== AUTHORITY_SCHEMA_VERSION ||
    !TOKEN.test(transaction.token) ||
    (transaction.state !== "claimed" && transaction.state !== "pinned") ||
    !isRecord(transaction.baseline) ||
    transaction.baseline.branch_was_absent !== true ||
    (transaction.state === "claimed" ? transaction.pins !== null : !isRecord(transaction.pins))
  ) {
    throw authorityError("corrupt_authority", "Worktree transaction has an invalid private shape")
  }
  assertRepositoryPinsShape(transaction.baseline)
  if (transaction.pins !== null) assertWorktreePinsShape(transaction.pins)
  return transaction
}

function assertRepositoryPinsShape(value: RepositoryPins): void {
  assertExactKeys(value as unknown as Record<string, unknown>, [
    "repository_root",
    "repository_root_identity",
    "repository_dot_git",
    "repository_dot_git_identity",
    "common_git_directory",
    "common_git_directory_identity",
    "target_parent",
    "target_parent_identity",
    ...("branch_was_absent" in value ? ["branch_was_absent"] : []),
  ], "repository pins")
  for (const path of [
    value.repository_root,
    value.repository_dot_git,
    value.common_git_directory,
    value.target_parent,
  ]) {
    if (!exactAbsolutePath(path)) {
      throw authorityError("corrupt_authority", "Worktree transaction contains an unsafe repository path")
    }
  }
  for (const identity of [
    value.repository_root_identity,
    value.repository_dot_git_identity,
    value.common_git_directory_identity,
    value.target_parent_identity,
  ]) assertIdentityShape(identity)
}

function assertWorktreePinsShape(value: WorktreePins): void {
  assertExactKeys(value as unknown as Record<string, unknown>, [
    "worktree_root_identity",
    "worktree_dot_git",
    "worktree_dot_git_identity",
    "git_admin_directory",
    "git_admin_directory_identity",
    "marker",
    "marker_identity",
  ], "Worktree pins")
  for (const path of [value.worktree_dot_git, value.git_admin_directory, value.marker]) {
    if (!exactAbsolutePath(path)) {
      throw authorityError("corrupt_authority", "Worktree transaction contains an unsafe effect path")
    }
  }
  for (const identity of [
    value.worktree_root_identity,
    value.worktree_dot_git_identity,
    value.git_admin_directory_identity,
    value.marker_identity,
  ]) assertIdentityShape(identity)
}

function assertIdentityShape(value: PhysicalIdentity): void {
  if (!isRecord(value)) {
    throw authorityError("corrupt_authority", "Worktree transaction contains an invalid physical identity")
  }
  assertExactKeys(value, ["device", "inode"], "physical identity")
  if (!/^(?:0|[1-9]\d*)$/u.test(String(value.device)) ||
    !/^(?:0|[1-9]\d*)$/u.test(String(value.inode))) {
    throw authorityError("corrupt_authority", "Worktree transaction contains an invalid physical identity")
  }
}

async function directoryIdentity(path: string): Promise<PhysicalIdentity> {
  const stats = await lstat(path, { bigint: true })
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw conflict(`expected exact directory ${path}`)
  return physical(stats)
}

async function regularFileIdentity(path: string): Promise<PhysicalIdentity> {
  const stats = await lstat(path, { bigint: true })
  if (!stats.isFile() || stats.isSymbolicLink()) throw conflict(`expected exact regular file ${path}`)
  return physical(stats)
}

async function nonSymlinkIdentity(path: string): Promise<PhysicalIdentity> {
  const stats = await lstat(path, { bigint: true })
  if (stats.isSymbolicLink()) throw conflict(`identity path crosses a symbolic link: ${path}`)
  return physical(stats)
}

async function privateFileIdentity(path: string, uid: number): Promise<PhysicalIdentity> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const descriptorIdentity = await handle.stat({ bigint: true })
    assertPrivateBigIntStats(path, descriptorIdentity, uid)
    const pathIdentity = await lstat(path, { bigint: true })
    assertPrivateBigIntStats(path, pathIdentity, uid)
    if (
      descriptorIdentity.dev !== pathIdentity.dev ||
      descriptorIdentity.ino !== pathIdentity.ino ||
      descriptorIdentity.mode !== pathIdentity.mode ||
      descriptorIdentity.uid !== pathIdentity.uid ||
      descriptorIdentity.nlink !== pathIdentity.nlink
    ) {
      throw authorityError("unsafe_storage", `private Worktree file identity changed: ${path}`)
    }
    return physical(descriptorIdentity)
  } finally {
    await handle.close()
  }
}

function assertPrivateBigIntStats(path: string, stats: BigIntStats, uid: number): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== BigInt(uid) ||
    stats.nlink !== 1n ||
    (stats.mode & 0o777n) !== 0o600n
  ) {
    throw authorityError("unsafe_storage", `unsafe private Worktree authority file ${path}`)
  }
}

async function assertPrivateFile(path: string, uid: number): Promise<Stats> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw error
    throw authorityError(
      "unsafe_storage",
      `private Worktree file cannot be opened without following links: ${path}`,
    )
  }
  try {
    const descriptorIdentity = await handle.stat()
    assertPrivateStats(path, descriptorIdentity, uid)
    const pathIdentity = await lstat(path)
    assertPrivateStats(path, pathIdentity, uid)
    if (!sameFileIdentity(descriptorIdentity, pathIdentity)) {
      throw authorityError("unsafe_storage", `private Worktree file path changed: ${path}`)
    }
    return descriptorIdentity
  } finally {
    await handle.close()
  }
}

async function assertPrivateTargetSnapshot(
  path: string,
  expected: Stats | null,
  uid: number,
): Promise<void> {
  if (expected === null) {
    try {
      await lstat(path)
    } catch (error) {
      if (isErrno(error, "ENOENT")) return
      throw authorityError("unsafe_storage", `cannot inspect private Worktree target: ${path}`)
    }
    throw authorityError("unsafe_storage", `private Worktree authority already exists: ${path}`)
  }
  const current = await assertPrivateFile(path, uid)
  if (!sameFileSnapshot(expected, current)) {
    throw authorityError("unsafe_storage", `private Worktree authority changed during transaction: ${path}`)
  }
}

async function openStableDirectoryGuard(path: string): Promise<OpenStableDirectoryGuard> {
  let directory: FileHandle
  try {
    directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw conflict(`cannot hold exact directory ${path}: ${errorMessage(error)}`)
  }
  try {
    const identity = await directory.stat({ bigint: true })
    if (!identity.isDirectory()) throw conflict(`expected exact directory ${path}`)
    const verify = async (): Promise<void> => {
      const descriptorIdentity = await directory.stat({ bigint: true })
      if (!descriptorIdentity.isDirectory() || !sameBigIntRootIdentity(identity, descriptorIdentity)) {
        throw conflict(`directory descriptor changed while held: ${path}`)
      }
      const pathIdentity = await lstat(path, { bigint: true })
      if (
        !pathIdentity.isDirectory() ||
        pathIdentity.isSymbolicLink() ||
        !sameBigIntRootIdentity(identity, pathIdentity) ||
        await realpath(path) !== path
      ) {
        throw conflict(`directory path changed while held: ${path}`)
      }
    }
    await verify()
    return {
      directory,
      path,
      identity,
      verify,
      close: () => directory.close(),
    }
  } catch (error) {
    await directory.close().catch(() => undefined)
    throw error
  }
}

function physical(stats: Stats | BigIntStats): PhysicalIdentity {
  return { device: String(stats.dev), inode: String(stats.ino) }
}

function samePhysical(left: PhysicalIdentity, right: PhysicalIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function sameStatsIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return sameStatsIdentity(left, right) && left.mode === right.mode && left.uid === right.uid &&
    left.nlink === right.nlink
}

function sameRootIdentity(left: Stats, right: Stats): boolean {
  return sameStatsIdentity(left, right) && left.mode === right.mode && left.uid === right.uid
}

function sameBigIntRootIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function pathExistsWithoutFollowing(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false
    throw transient(`cannot inspect planned Worktree path: ${errorMessage(error)}`)
  }
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const before = await regularFileIdentity(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await handle.stat()
    if (
      !stats.isFile() ||
      !samePhysical(before, physical(stats)) ||
      stats.size > maximumBytes
    ) {
      throw new Error(`${path} is not one stable bounded regular file`)
    }
    const bytes = new Uint8Array(stats.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (
      offset !== bytes.byteLength ||
      !sameStatsIdentity(stats, after) ||
      after.size !== stats.size ||
      after.mtimeMs !== stats.mtimeMs ||
      after.ctimeMs !== stats.ctimeMs ||
      !samePhysical(before, await regularFileIdentity(path))
    ) {
      throw new Error(`${path} changed during exact read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    if (written.bytesWritten === 0) throw new Error("private authority write made no progress")
    offset += written.bytesWritten
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
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
  let lines: string[]
  try {
    lines = decodeLines(bytes)
  } catch (error) {
    throw conflict(`${label} is ambiguous: ${errorMessage(error)}`)
  }
  if (lines.length !== 1) throw conflict(`${label} is not one exact line`)
  return lines[0]!
}

function exactAbsolutePath(path: string): boolean {
  return isAbsolute(path) && path !== "/" && normalize(path) === path && resolve(path) === path &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(path)
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalJson(left as JsonValue)).equals(
    Buffer.from(encodeCanonicalJson(right as JsonValue)),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw authorityError("corrupt_authority", `${label} has unknown or missing fields`)
  }
}

function commandFailure(label: string, result: ExactWorktreeGitCommandResult): string {
  return `${label} failed (exit ${result.exitCode})${result.stderr ? `: ${result.stderr}` : ""}`
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw authorityError("unsafe_storage", "exact Worktree authority requires a POSIX uid")
  }
  return process.getuid()
}

function conflict(message: string): ExactWorktreeCreationError {
  return authorityError("git_conflict", message)
}

function transient(message: string): ExactWorktreeCreationError {
  return authorityError("git_transient", message)
}

function authorityError(
  code: ExactWorktreeCreationErrorCode,
  message: string,
): ExactWorktreeCreationError {
  return new ExactWorktreeCreationError(code, boundedMessage(message))
}

function boundedMessage(message: string): string {
  const clean = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim() || "Worktree error"
  const bytes = Buffer.from(clean)
  return bytes.byteLength <= 2_048
    ? clean
    : new TextDecoder().decode(bytes.subarray(0, 2_048)).replace(/\ufffd$/u, "")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
