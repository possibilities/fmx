import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ExactWorktreeCreationError,
  ExactWorktreeCreator,
  transactionPathFor,
  type ExactWorktreeCreationFaultPoint,
  type ExactWorktreeGitCommandResult,
  type ExactWorktreeGitCommandRunner,
} from "../src/exact-worktree-creation.ts"
import {
  deriveEnsureDigest,
  EnsureLifecycleLedger,
  type EnsureRequest,
} from "../src/ensure-lifecycle-ledger.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type RepositoryFixture = {
  root: string
  repository: string
  worktrees: string
  directory: string
  authority: string
  commit: string
  request: EnsureRequest
}

async function repositoryFixture(serial = "a"): Promise<RepositoryFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fmx-exact-worktree-test-")))
  roots.push(root)
  const repository = join(root, "repository")
  const worktrees = join(root, "worktrees")
  const directory = join(worktrees, `checkout-${serial}`)
  const authority = join(root, "authority")
  await mkdir(worktrees, { mode: 0o700 })
  await git(root, "init", "--quiet", "--initial-branch=main", repository)
  await git(
    repository,
    "-c",
    "user.name=fmx test",
    "-c",
    "user.email=fmx@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "initial",
  )
  const commit = await gitOutput(repository, "rev-parse", "--verify", "HEAD")
  const request = requestFor({ repository, directory, commit, serial })
  return { root, repository, worktrees, directory, authority, commit, request }
}

function requestFor(input: {
  repository: string
  directory: string
  commit: string
  serial: string
}): EnsureRequest {
  const request: EnsureRequest = {
    schema_id: "fmx.ensure-lifecycle",
    schema_version: 1,
    message_type: "ensure_request",
    request_id: `ensure-request-${input.serial}`,
    workplace_instance_id: "fixture-workplace",
    fmx_session: "session-beta",
    ensure_id: `ensure-${input.serial}`,
    ensure_digest: "0".repeat(64),
    launch_id: `launch-${input.serial}`,
    launch_digest: "a".repeat(64),
    worktree_id: `worktree-${input.serial}`,
    agent_id: input.serial.charCodeAt(0).toString(16).padStart(32, "0"),
    planned_worktree: {
      repository: input.repository,
      base_commit: input.commit,
      branch: `exact-worktree-${input.serial}`,
      directory: input.directory,
    },
    fx_conversation: {
      name: `exact-worktree-${input.serial}`,
      resume_conversation_id: null,
    },
  }
  request.ensure_digest = deriveEnsureDigest(request)
  return request
}

describe("recoverable exact Git Worktree creation", () => {
  test("safe first creation returns the ledger's exact transition and exact replay is idempotent", async () => {
    const fixture = await repositoryFixture("safe")
    const ledger = await EnsureLifecycleLedger.open(join(fixture.root, "ledger"))
    const claimed = await ledger.claim(fixture.request)
    expect(claimed.stage).toBe("claimed")

    const points: ExactWorktreeCreationFaultPoint[] = []
    const creator = new ExactWorktreeCreator(fixture.authority, {
      fault: (point) => { points.push(point) },
    })
    const transition = await creator.create(fixture.request)
    expect(transition).toEqual({
      kind: "worktree_created",
      directory: fixture.directory,
      head_commit: fixture.commit,
    })
    expect((await ledger.get(fixture.request.ensure_id))?.stage).toBe("claimed")
    expect((await ledger.advance(fixture.request.ensure_id, transition)).stage).toBe("worktree_created")
    expect(points).toEqual([
      "before_effect",
      "after_git_accepted",
      "after_marker_sync",
      "after_pins_sync",
      "after_unlock",
      "response_loss",
    ])

    const worktreeIdentity = await identity(fixture.directory)
    const admin = await adminDirectory(fixture.directory)
    const marker = join(admin, "fmx-exact-worktree-owner.json")
    expect((await lstat(fixture.authority)).mode & 0o777).toBe(0o700)
    expect((await lstat(transactionPathFor(fixture.authority, fixture.request.ensure_id))).mode & 0o777)
      .toBe(0o600)
    expect((await lstat(marker)).mode & 0o777).toBe(0o600)
    expect(await gitOutput(fixture.directory, "rev-parse", "--verify", "HEAD")).toBe(fixture.commit)
    expect(await gitOutput(fixture.directory, "symbolic-ref", "--quiet", "HEAD"))
      .toBe(`refs/heads/${fixture.request.planned_worktree.branch}`)
    expect(await gitOutput(fixture.repository, "worktree", "list", "--porcelain"))
      .not.toContain("locked ")

    const userFile = join(fixture.directory, "user-notes.txt")
    await writeFile(userFile, "keep this untracked file\n")
    expect(await new ExactWorktreeCreator(fixture.authority).create(fixture.request)).toEqual(transition)
    expect(await identity(fixture.directory)).toEqual(worktreeIdentity)
    expect(await adminDirectory(fixture.directory)).toBe(admin)
    expect(await readFile(userFile, "utf8")).toBe("keep this untracked file\n")
  })

  for (const point of [
    "before_effect",
    "after_git_accepted",
    "after_marker_sync",
    "after_pins_sync",
    "after_unlock",
    "response_loss",
  ] as const) {
    test(`recovers the ${point} crash window without a second Worktree`, async () => {
      const fixture = await repositoryFixture(point.replaceAll("_", "-"))
      let injected = false
      const crashing = new ExactWorktreeCreator(fixture.authority, {
        fault: (candidate) => {
          if (!injected && candidate === point) {
            injected = true
            throw new Error(`fault:${point}`)
          }
        },
      })
      await expect(crashing.create(fixture.request)).rejects.toThrow(`fault:${point}`)
      expect(injected).toBeTrue()
      const transaction = JSON.parse(await readFile(
        transactionPathFor(fixture.authority, fixture.request.ensure_id),
        "utf8",
      )) as { state: string }
      const beforeGit = point === "before_effect"
      expect(transaction.state).toBe(
        point === "after_pins_sync" || point === "after_unlock" || point === "response_loss"
          ? "pinned"
          : "claimed",
      )
      expect(await pathExists(fixture.directory)).toBe(!beforeGit)
      if (!beforeGit) {
        const list = await gitOutput(fixture.repository, "worktree", "list", "--porcelain")
        const unlocked = point === "after_unlock" || point === "response_loss"
        expect(list.includes("locked fmx-exact-worktree:")).toBe(!unlocked)
        const marker = join(await adminDirectory(fixture.directory), "fmx-exact-worktree-owner.json")
        expect(await pathExists(marker)).toBe(
          point !== "after_git_accepted",
        )
      }
      const recovered = await new ExactWorktreeCreator(fixture.authority).create(fixture.request)
      expect(recovered.head_commit).toBe(fixture.commit)
      const registrations = (await gitOutput(fixture.repository, "worktree", "list", "--porcelain"))
        .split("\n")
        .filter((line) => line === `worktree ${fixture.directory}`)
      expect(registrations).toHaveLength(1)
      expect(await gitOutput(fixture.repository, "worktree", "list", "--porcelain"))
        .not.toContain("locked ")
    })
  }

  test("a token-proven branch-only partial effect resumes without creating a second branch", async () => {
    const fixture = await repositoryFixture("branch-partial")
    const token = `fmx-exact-worktree:${"b".repeat(64)}`
    let branchCreated = false
    let blockedAdd = false
    const runner: ExactWorktreeGitCommandRunner = async (cwd, args, environment) => {
      if (
        branchCreated &&
        !blockedAdd &&
        args[0] === "worktree" &&
        args[1] === "add"
      ) {
        blockedAdd = true
        return { exitCode: -1, stdout: new Uint8Array(), stderr: "lost before Worktree add" }
      }
      const result = await rawGit(cwd, args, environment)
      if (args[0] === "update-ref" && result.exitCode === 0) branchCreated = true
      return result
    }
    try {
      await new ExactWorktreeCreator(fixture.authority, { git: runner, token: () => token })
        .create(fixture.request)
      throw new Error("expected branch-only partial effect")
    } catch (error) {
      expect(error).toBeInstanceOf(ExactWorktreeCreationError)
      expect((error as ExactWorktreeCreationError).code).toBe("git_transient")
    }
    expect(branchCreated).toBeTrue()
    expect(blockedAdd).toBeTrue()
    expect(await pathExists(fixture.directory)).toBeFalse()
    expect(await gitOutput(
      fixture.repository,
      "reflog",
      "show",
      "--format=%H%x00%gs",
      "--max-count=2",
      `refs/heads/${fixture.request.planned_worktree.branch}`,
    )).toBe(`${fixture.commit}\0${token}`)

    const transition = await new ExactWorktreeCreator(fixture.authority).create(fixture.request)
    expect(transition.head_commit).toBe(fixture.commit)
    expect(await gitOutput(
      fixture.repository,
      "rev-parse",
      "--verify",
      `refs/heads/${fixture.request.planned_worktree.branch}`,
    )).toBe(fixture.commit)
  })

  test("a foreign exact branch created after the private absence claim is preserved and refused", async () => {
    const fixture = await repositoryFixture("foreign-after-claim")
    await expect(new ExactWorktreeCreator(fixture.authority, {
      fault: (point) => {
        if (point === "before_effect") throw new Error("claimed-before-foreign-branch")
      },
    }).create(fixture.request)).rejects.toThrow("claimed-before-foreign-branch")

    await git(
      fixture.repository,
      "branch",
      fixture.request.planned_worktree.branch,
      fixture.commit,
    )
    await expectConflict(
      new ExactWorktreeCreator(fixture.authority).create(fixture.request),
      "private creation provenance",
    )
    expect(await pathExists(fixture.directory)).toBeFalse()
    expect(await gitOutput(
      fixture.repository,
      "rev-parse",
      `refs/heads/${fixture.request.planned_worktree.branch}`,
    )).toBe(fixture.commit)
  })

  test("an accepted Git effect with a lost subprocess status reconciles by inspection", async () => {
    const fixture = await repositoryFixture("lost-status")
    const environments: Readonly<Record<string, string>>[] = []
    let obscured = false
    const runner: ExactWorktreeGitCommandRunner = async (cwd, args, environment) => {
      environments.push(environment)
      const result = await rawGit(cwd, args, environment)
      if (!obscured && args[0] === "worktree" && args[1] === "add") {
        obscured = true
        if (result.exitCode !== 0) return result
        throw new Error("simulated response loss")
      }
      return result
    }
    const creator = new ExactWorktreeCreator(fixture.authority, {
      environment: {
        ...process.env,
        GIT_DIR: "/foreign/git-dir",
        GIT_WORK_TREE: "/foreign/work-tree",
        GIT_CONFIG_GLOBAL: "/foreign/config",
      },
      git: runner,
    })
    expect((await creator.create(fixture.request)).head_commit).toBe(fixture.commit)
    expect(obscured).toBeTrue()
    for (const environment of environments) {
      expect(environment.GIT_DIR).toBeUndefined()
      expect(environment.GIT_WORK_TREE).toBeUndefined()
      expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null")
      expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1")
      expect(environment.GIT_TERMINAL_PROMPT).toBe("0")
    }
  })

  test("an accepted unlock with a lost subprocess result reconciles from the exact unlocked state", async () => {
    const fixture = await repositoryFixture("lost-unlock-result")
    let obscured = false
    const runner: ExactWorktreeGitCommandRunner = async (cwd, args, environment) => {
      const result = await rawGit(cwd, args, environment)
      if (
        !obscured &&
        args[0] === "worktree" &&
        args[1] === "unlock" &&
        result.exitCode === 0
      ) {
        obscured = true
        throw new Error("simulated unlock response loss")
      }
      return result
    }
    expect((await new ExactWorktreeCreator(fixture.authority, { git: runner })
      .create(fixture.request)).head_commit).toBe(fixture.commit)
    expect(obscured).toBeTrue()
    expect(await gitOutput(fixture.repository, "worktree", "list", "--porcelain"))
      .not.toContain("locked ")
  })

  test("a Worktree whose creation lock reason changes before marker pinning is preserved and refused", async () => {
    const fixture = await repositoryFixture("lock-mismatch")
    let replaced = false
    const runner: ExactWorktreeGitCommandRunner = async (cwd, args, environment) => {
      const result = await rawGit(cwd, args, environment)
      if (
        !replaced &&
        args[0] === "worktree" &&
        args[1] === "add" &&
        result.exitCode === 0
      ) {
        replaced = true
        await writeFile(join(await adminDirectory(fixture.directory), "locked"), "foreign-lock\n")
      }
      return result
    }
    await expectConflict(
      new ExactWorktreeCreator(fixture.authority, { git: runner }).create(fixture.request),
      "exact private creation lock",
    )
    expect(replaced).toBeTrue()
    expect(await pathExists(fixture.directory)).toBeTrue()
    expect(await readFile(
      join(await adminDirectory(fixture.directory), "locked"),
      "utf8",
    )).toBe("foreign-lock\n")
  })

  test("the held private root refuses a rename-to-symlink race before any Git effect", async () => {
    const fixture = await repositoryFixture("authority-root-race")
    const displaced = join(fixture.root, "displaced-authority")
    let raced = false
    try {
      await new ExactWorktreeCreator(fixture.authority, {
        fault: async (point) => {
          if (!raced && point === "before_effect") {
            raced = true
            await rename(fixture.authority, displaced)
            await symlink(displaced, fixture.authority)
          }
        },
      }).create(fixture.request)
      throw new Error("expected private root race refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(ExactWorktreeCreationError)
      expect((error as ExactWorktreeCreationError).code).toBe("unsafe_storage")
    }
    expect(raced).toBeTrue()
    expect((await lstat(fixture.authority)).isSymbolicLink()).toBeTrue()
    expect(await pathExists(fixture.directory)).toBeFalse()
    const branch = await rawGit(
      fixture.repository,
      ["rev-parse", "--verify", `refs/heads/${fixture.request.planned_worktree.branch}`],
      process.env as Record<string, string>,
    )
    expect(branch.exitCode).not.toBe(0)
  })

  test("an exact-byte transaction replacement is detected before any Git effect", async () => {
    const fixture = await repositoryFixture("transaction-replacement")
    let replaced = false
    try {
      await new ExactWorktreeCreator(fixture.authority, {
        fault: async (point) => {
          if (!replaced && point === "before_effect") {
            replaced = true
            const transaction = transactionPathFor(
              fixture.authority,
              fixture.request.ensure_id,
            )
            const replacement = `${transaction}.foreign-replacement`
            await writeFile(replacement, await readFile(transaction), { mode: 0o600 })
            await rename(replacement, transaction)
          }
        },
      }).create(fixture.request)
      throw new Error("expected transaction replacement refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(ExactWorktreeCreationError)
      expect((error as ExactWorktreeCreationError).code).toBe("unsafe_storage")
    }
    expect(replaced).toBeTrue()
    expect(await pathExists(fixture.directory)).toBeFalse()
    const branch = await rawGit(
      fixture.repository,
      ["rev-parse", "--verify", `refs/heads/${fixture.request.planned_worktree.branch}`],
      process.env as Record<string, string>,
    )
    expect(branch.exitCode).not.toBe(0)
  })

  test("a same-path Git admin directory replacement before marker creation is refused", async () => {
    const fixture = await repositoryFixture("admin-replacement")
    let replaced = false
    try {
      await new ExactWorktreeCreator(fixture.authority, {
        fault: async (point) => {
          if (!replaced && point === "after_git_accepted") {
            replaced = true
            const admin = await adminDirectory(fixture.directory)
            const original = join(fixture.root, "original-admin-directory")
            await rename(admin, original)
            await cp(original, admin, { recursive: true, preserveTimestamps: true })
          }
        },
      }).create(fixture.request)
      throw new Error("expected Git admin replacement refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(ExactWorktreeCreationError)
      expect((error as ExactWorktreeCreationError).code).toBe("git_conflict")
      expect((error as Error).message).toContain("changed before marker creation")
    }
    expect(replaced).toBeTrue()
    const marker = join(await adminDirectory(fixture.directory), "fmx-exact-worktree-owner.json")
    expect(await pathExists(marker)).toBeFalse()
  })

  test("a foreign marker symlink raced in after Git acceptance is never overwritten", async () => {
    const fixture = await repositoryFixture("marker-symlink-race")
    const foreign = join(fixture.root, "foreign-marker-content")
    await writeFile(foreign, "foreign marker must survive\n")
    let raced = false
    try {
      await new ExactWorktreeCreator(fixture.authority, {
        fault: async (point) => {
          if (!raced && point === "after_git_accepted") {
            raced = true
            const marker = join(
              await adminDirectory(fixture.directory),
              "fmx-exact-worktree-owner.json",
            )
            await symlink(foreign, marker)
          }
        },
      }).create(fixture.request)
      throw new Error("expected marker race refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(ExactWorktreeCreationError)
      expect((error as ExactWorktreeCreationError).code).toBe("unsafe_storage")
    }
    const marker = join(await adminDirectory(fixture.directory), "fmx-exact-worktree-owner.json")
    expect((await lstat(marker)).isSymbolicLink()).toBeTrue()
    expect(await readFile(foreign, "utf8")).toBe("foreign marker must survive\n")
  })

  test("malformed Git registration output and a linked checkout presented as main are refused", async () => {
    const malformed = await repositoryFixture("malformed-list")
    let injected = false
    const runner: ExactWorktreeGitCommandRunner = async (cwd, args, environment) => {
      if (!injected && args[0] === "worktree" && args[1] === "list") {
        injected = true
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode("not-a-worktree-record\0"),
          stderr: "",
        }
      }
      return await rawGit(cwd, args, environment)
    }
    await expectConflict(
      new ExactWorktreeCreator(malformed.authority, { git: runner }).create(malformed.request),
      "cannot parse exact Git Worktree registration",
    )
    expect(await pathExists(malformed.directory)).toBeFalse()

    const linked = await repositoryFixture("linked-as-main")
    const linkedRoot = join(linked.worktrees, "linked-root")
    await git(
      linked.repository,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked-root-branch",
      linkedRoot,
      linked.commit,
    )
    const linkedRequest = requestFor({
      repository: linkedRoot,
      directory: join(linked.worktrees, "nested-target"),
      commit: linked.commit,
      serial: "linked-repository-input",
    })
    await expectConflict(
      new ExactWorktreeCreator(join(linked.root, "linked-authority")).create(linkedRequest),
      "exact registered main Worktree",
    )
    expect(await pathExists(linkedRequest.planned_worktree.directory)).toBeFalse()
  })

  test("command-scoped Git hardening disables repository hooks and ambient attributes", async () => {
    const fixture = await repositoryFixture("git-hardening")
    const tracked = join(fixture.repository, "tracked.txt")
    await writeFile(tracked, "exact checked-out bytes\n")
    await git(fixture.repository, "add", "tracked.txt")
    await git(
      fixture.repository,
      "-c",
      "user.name=fmx test",
      "-c",
      "user.email=fmx@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "tracked fixture",
    )
    fixture.commit = await gitOutput(fixture.repository, "rev-parse", "HEAD")
    fixture.request.planned_worktree.base_commit = fixture.commit
    fixture.request.ensure_digest = deriveEnsureDigest(fixture.request)

    const hookSentinel = join(fixture.root, "hook-ran")
    const filterSentinel = join(fixture.root, "filter-ran")
    const hooks = join(fixture.root, "hostile-hooks")
    const attributes = join(fixture.root, "hostile-attributes")
    const excludes = join(fixture.root, "hostile-excludes")
    const filter = join(fixture.root, "hostile-filter")
    await mkdir(hooks)
    await writeFile(
      join(hooks, "post-checkout"),
      `#!/bin/sh\nprintf 'hook ran\\n' > "${hookSentinel}"\n`,
    )
    await chmod(join(hooks, "post-checkout"), 0o700)
    await writeFile(attributes, "* filter=hostile\n")
    await writeFile(excludes, "*\n")
    await writeFile(
      filter,
      `#!/bin/sh\nprintf 'filter ran\\n' > "${filterSentinel}"\ncat\n`,
    )
    await chmod(filter, 0o700)
    await git(fixture.repository, "config", "core.hooksPath", hooks)
    await git(fixture.repository, "config", "core.attributesFile", attributes)
    await git(fixture.repository, "config", "core.excludesFile", excludes)
    await git(fixture.repository, "config", "filter.hostile.smudge", filter)
    await git(fixture.repository, "config", "filter.hostile.required", "true")

    expect((await new ExactWorktreeCreator(fixture.authority).create(fixture.request)).head_commit)
      .toBe(fixture.commit)
    expect(await readFile(join(fixture.directory, "tracked.txt"), "utf8"))
      .toBe("exact checked-out bytes\n")
    expect(await pathExists(hookSentinel)).toBeFalse()
    expect(await pathExists(filterSentinel)).toBeFalse()
  })

  test("preexisting exact branch and exact foreign Worktree are ambiguous and preserved", async () => {
    const branchOnly = await repositoryFixture("foreign-branch")
    await git(
      branchOnly.repository,
      "branch",
      branchOnly.request.planned_worktree.branch,
      branchOnly.commit,
    )
    await expectConflict(
      new ExactWorktreeCreator(branchOnly.authority).create(branchOnly.request),
      "branch already exists",
    )
    expect(await pathExists(branchOnly.directory)).toBeFalse()

    const foreign = await repositoryFixture("foreign-worktree")
    await git(
      foreign.repository,
      "worktree",
      "add",
      "--quiet",
      "-b",
      foreign.request.planned_worktree.branch,
      foreign.directory,
      foreign.commit,
    )
    const foreignFile = join(foreign.directory, "foreign-notes.txt")
    await writeFile(foreignFile, "preserve me\n")
    await expectConflict(
      new ExactWorktreeCreator(foreign.authority).create(foreign.request),
      "without private creation authority",
    )
    expect(await readFile(foreignFile, "utf8")).toBe("preserve me\n")
  })

  test("path, branch, HEAD, and registration conflicts never overwrite user state", async () => {
    const occupied = await repositoryFixture("occupied")
    await writeFile(occupied.directory, "not a Worktree\n")
    await expectConflict(
      new ExactWorktreeCreator(occupied.authority).create(occupied.request),
      "exists without its exact Git registration",
    )
    expect(await readFile(occupied.directory, "utf8")).toBe("not a Worktree\n")

    const movedBranch = await repositoryFixture("moved-branch")
    await expect(new ExactWorktreeCreator(movedBranch.authority, {
      fault: (point) => {
        if (point === "before_effect") throw new Error("claim-only")
      },
    }).create(movedBranch.request)).rejects.toThrow("claim-only")
    await git(
      movedBranch.repository,
      "-c",
      "user.name=fmx test",
      "-c",
      "user.email=fmx@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "second",
    )
    const second = await gitOutput(movedBranch.repository, "rev-parse", "HEAD")
    await git(
      movedBranch.repository,
      "branch",
      movedBranch.request.planned_worktree.branch,
      second,
    )
    await expectConflict(
      new ExactWorktreeCreator(movedBranch.authority).create(movedBranch.request),
      "different commit",
    )
    expect(await gitOutput(
      movedBranch.repository,
      "rev-parse",
      `refs/heads/${movedBranch.request.planned_worktree.branch}`,
    )).toBe(second)

    const foreignCheckout = await repositoryFixture("foreign-checkout")
    const elsewhere = join(foreignCheckout.worktrees, "elsewhere")
    await git(
      foreignCheckout.repository,
      "worktree",
      "add",
      "--quiet",
      "-b",
      foreignCheckout.request.planned_worktree.branch,
      elsewhere,
      foreignCheckout.commit,
    )
    await expectConflict(
      new ExactWorktreeCreator(foreignCheckout.authority).create(foreignCheckout.request),
      "already checked out",
    )
    expect(await pathExists(elsewhere)).toBeTrue()

    const linkedPath = await repositoryFixture("linked-path")
    const foreignDirectory = join(linkedPath.root, "foreign-directory")
    await mkdir(foreignDirectory)
    await symlink(foreignDirectory, linkedPath.directory)
    await expectConflict(
      new ExactWorktreeCreator(linkedPath.authority).create(linkedPath.request),
      "exists without its exact Git registration",
    )
    expect((await lstat(linkedPath.directory)).isSymbolicLink()).toBeTrue()
  })

  test("an indistinguishable same-path same-branch same-HEAD replacement lacks the private pins", async () => {
    const fixture = await repositoryFixture("replacement")
    await new ExactWorktreeCreator(fixture.authority).create(fixture.request)
    const originalRoot = await identity(fixture.directory)
    const originalAdmin = await identity(await adminDirectory(fixture.directory))

    await git(fixture.repository, "worktree", "remove", fixture.directory)
    await git(
      fixture.repository,
      "worktree",
      "add",
      "--quiet",
      fixture.directory,
      fixture.request.planned_worktree.branch,
    )
    const replacementFile = join(fixture.directory, "replacement-notes.txt")
    await writeFile(replacementFile, "foreign replacement\n")
    expect(await identity(fixture.directory)).not.toEqual(originalRoot)
    expect(await identity(await adminDirectory(fixture.directory))).not.toEqual(originalAdmin)
    await expectConflict(
      new ExactWorktreeCreator(fixture.authority).create(fixture.request),
      "marker is absent or unsafe",
    )
    expect(await readFile(replacementFile, "utf8")).toBe("foreign replacement\n")
  })

  test("repository replacement after the durable pre-effect claim is refused even at the same path", async () => {
    const fixture = await repositoryFixture("repository-replacement")
    await expect(new ExactWorktreeCreator(fixture.authority, {
      fault: (point) => {
        if (point === "before_effect") throw new Error("claim-only")
      },
    }).create(fixture.request)).rejects.toThrow("claim-only")

    const original = join(fixture.root, "original-repository")
    await rename(fixture.repository, original)
    await cp(original, fixture.repository, { recursive: true, preserveTimestamps: true })
    expect(await gitOutput(fixture.repository, "rev-parse", "HEAD")).toBe(fixture.commit)
    await expectConflict(
      new ExactWorktreeCreator(fixture.authority).create(fixture.request),
      "physical identity changed",
    )
    expect(await pathExists(fixture.directory)).toBeFalse()
  })

  test("a post-creation HEAD advance is never reset and conflicting request reuse is refused", async () => {
    const fixture = await repositoryFixture("head-advance")
    await new ExactWorktreeCreator(fixture.authority).create(fixture.request)
    const committed = join(fixture.directory, "committed-by-user.txt")
    await writeFile(committed, "user commit\n")
    await git(fixture.directory, "add", "committed-by-user.txt")
    await git(
      fixture.directory,
      "-c",
      "user.name=fmx user",
      "-c",
      "user.email=fmx@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "user commit",
    )
    const advanced = await gitOutput(fixture.directory, "rev-parse", "HEAD")
    expect(advanced).not.toBe(fixture.commit)
    await expectConflict(
      new ExactWorktreeCreator(fixture.authority).create(fixture.request),
      "branch or HEAD differs",
    )
    expect(await gitOutput(fixture.directory, "rev-parse", "HEAD")).toBe(advanced)
    expect(await readFile(committed, "utf8")).toBe("user commit\n")

    const altered = structuredClone(fixture.request)
    altered.planned_worktree.branch = "different-authority"
    altered.ensure_digest = deriveEnsureDigest(altered)
    try {
      await new ExactWorktreeCreator(fixture.authority).create(altered)
      throw new Error("expected authority conflict")
    } catch (error) {
      expect(error).toBeInstanceOf(ExactWorktreeCreationError)
      expect((error as ExactWorktreeCreationError).code).toBe("authority_conflict")
    }
  })
})

async function expectConflict(operation: Promise<unknown>, message: string): Promise<void> {
  try {
    await operation
    throw new Error("expected exact Worktree conflict")
  } catch (error) {
    expect(error).toBeInstanceOf(ExactWorktreeCreationError)
    expect((error as ExactWorktreeCreationError).code).toBe("git_conflict")
    expect((error as Error).message).toContain(message)
  }
}

async function rawGit(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<ExactWorktreeGitCommandResult> {
  const child = Bun.spawn([
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
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr: stderr.trim() }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await rawGit(cwd, args, process.env as Record<string, string>)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const result = await rawGit(cwd, args, process.env as Record<string, string>)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return new TextDecoder().decode(result.stdout).trim()
}

async function adminDirectory(worktree: string): Promise<string> {
  const text = await readFile(join(worktree, ".git"), "utf8")
  const match = /^gitdir: (.+)\n$/u.exec(text)
  if (!match) throw new Error("test Worktree lacks exact gitdir")
  return match[1]!
}

async function identity(path: string): Promise<{ device: string; inode: string }> {
  const stats = await lstat(path, { bigint: true })
  return { device: String(stats.dev), inode: String(stats.ino) }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}
