import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  GitSafeWorktreeAuthority,
  GitSafeWorktreeCleanup,
  parsePorcelainV2Status,
  type GitWorktreeAuthority,
  type GitWorktreeInspection,
  type GitWorktreeSnapshot,
} from "../src/git-safe-worktree-cleanup.ts"
import { ExactRetirementLedger } from "../src/exact-retirement-ledger.ts"
import { retirementFixture, type RetirementFixture } from "./fixtures/exact-retirement.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scratchRoot(prefix = "fmx-cleanup-test-"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

async function ledgerWithEnd(fixture: RetirementFixture): Promise<ExactRetirementLedger> {
  const ledger = await ExactRetirementLedger.open(join(await scratchRoot(), "ledger"))
  await ledger.bindEnsure(fixture.ensure)
  await ledger.beginEnd(fixture.endRequest)
  await ledger.markKillIntent(fixture.endRequest.ensure_id, "2026-08-30T19:59:58.000Z")
  await ledger.retainEndReceipt(fixture.endReceipt)
  return ledger
}

function snapshot(
  fixture: RetirementFixture,
  changes: Partial<GitWorktreeSnapshot> = {},
): GitWorktreeSnapshot {
  return {
    kind: "present",
    repository: fixture.ensure.request.planned_worktree.repository,
    worktreeDirectory: fixture.ensure.request.planned_worktree.directory,
    headCommit: fixture.ensure.effects.worktree.status === "created"
      ? fixture.ensure.effects.worktree.head_commit
      : fixture.ensure.request.planned_worktree.base_commit,
    statusDigest: "0".repeat(64),
    trackedChanges: false,
    untrackedPaths: [],
    ...changes,
  }
}

function fakeGit(
  inspections: GitWorktreeInspection[],
  removeEffect: "success" | "fail" = "success",
): GitWorktreeAuthority & { removeCalls: number; inspectCalls: number; removed: boolean } {
  let index = 0
  const authority = {
    removeCalls: 0,
    inspectCalls: 0,
    removed: false,
    inspect: async () => {
      authority.inspectCalls++
      if (authority.removed) return { kind: "absent" as const }
      return structuredClone(inspections[Math.min(index++, inspections.length - 1)] ?? { kind: "absent" as const })
    },
    remove: async () => {
      authority.removeCalls++
      if (removeEffect === "fail") throw new Error("git remove failed")
      authority.removed = true
    },
  }
  return authority
}

describe("Git-safe exact Worktree cleanup", () => {
  test("tracked and untracked dirt independently retain refused_dirty without removal", async () => {
    const fixture = await retirementFixture("ensure-a")
    const cases: GitWorktreeSnapshot[] = [
      snapshot(fixture, { trackedChanges: true, statusDigest: "1".repeat(64) }),
      snapshot(fixture, { untrackedPaths: ["notes/exact.txt"], statusDigest: "2".repeat(64) }),
    ]
    for (const dirty of cases) {
      const ledger = await ledgerWithEnd(fixture)
      const git = fakeGit([dirty])
      const receipt = await new GitSafeWorktreeCleanup(ledger, git).cleanup(
        fixture.ensure,
        fixture.cleanupRequest,
      )
      expect(receipt.outcome).toEqual({
        kind: "refused_dirty",
        head_commit: dirty.headCommit,
        tracked_changes: dirty.trackedChanges,
        untracked_paths: dirty.untrackedPaths,
      })
      expect(git.removeCalls).toBe(0)
      expect(await new GitSafeWorktreeCleanup(ledger, git).cleanup(
        fixture.ensure,
        fixture.cleanupRequest,
      )).toEqual(receipt)
    }
  })

  test("path, repository, HEAD, and dirt races are retained refusals before removal", async () => {
    const fixture = await retirementFixture("ensure-a")
    const clean = snapshot(fixture)
    const cases: Array<{
      label: string
      raced: GitWorktreeInspection
      kind: "refused_mismatch" | "refused_dirty"
    }> = [
      {
        label: "path registration",
        raced: { kind: "mismatch", message: "registered path changed" },
        kind: "refused_mismatch",
      },
      {
        label: "repository",
        raced: snapshot(fixture, { repository: "/var/tmp/foreign-repository" }),
        kind: "refused_mismatch",
      },
      {
        label: "HEAD",
        raced: snapshot(fixture, { headCommit: "f".repeat(40) }),
        kind: "refused_mismatch",
      },
      {
        label: "dirt",
        raced: snapshot(fixture, { untrackedPaths: ["raced.txt"], statusDigest: "3".repeat(64) }),
        kind: "refused_dirty",
      },
    ]
    for (const candidate of cases) {
      const ledger = await ledgerWithEnd(fixture)
      const git = fakeGit([clean, candidate.raced])
      const receipt = await new GitSafeWorktreeCleanup(ledger, git).cleanup(
        fixture.ensure,
        fixture.cleanupRequest,
      )
      expect(receipt.outcome.kind, candidate.label).toBe(candidate.kind)
      expect(git.inspectCalls, candidate.label).toBe(2)
      expect(git.removeCalls, candidate.label).toBe(0)
    }
  })

  test("remove success followed by response loss is recovered without a second remove", async () => {
    const fixture = await retirementFixture("ensure-a")
    const ledger = await ledgerWithEnd(fixture)
    const git = fakeGit([snapshot(fixture), snapshot(fixture)])
    const crashing = new GitSafeWorktreeCleanup(ledger, git, {
      afterRemove: () => { throw new Error("response-lost") },
    })
    await expect(crashing.cleanup(fixture.ensure, fixture.cleanupRequest)).rejects.toThrow("response-lost")
    expect(git.removeCalls).toBe(1)
    expect((await ledger.get(fixture.cleanupRequest.ensure_id))?.cleanup).toMatchObject({
      prepare: { head_commit: fixture.ensure.effects.worktree.status === "created"
        ? fixture.ensure.effects.worktree.head_commit
        : undefined },
      receipt: null,
    })

    const receipt = await new GitSafeWorktreeCleanup(ledger, git).cleanup(
      fixture.ensure,
      fixture.cleanupRequest,
    )
    expect(receipt.outcome).toMatchObject({ kind: "removed" })
    expect(git.removeCalls).toBe(1)
    expect(await new GitSafeWorktreeCleanup(ledger, git).cleanup(
      fixture.ensure,
      fixture.cleanupRequest,
    )).toEqual(receipt)
  })

  test("absence without a durable prepare marker is mismatch, never invented success", async () => {
    const fixture = await retirementFixture("ensure-a")
    const ledger = await ledgerWithEnd(fixture)
    const git = fakeGit([{ kind: "absent" }])
    const receipt = await new GitSafeWorktreeCleanup(ledger, git).cleanup(
      fixture.ensure,
      fixture.cleanupRequest,
    )
    expect(receipt.outcome).toMatchObject({
      kind: "refused_mismatch",
      message: expect.stringContaining("prepare marker"),
    })
    expect(git.removeCalls).toBe(0)
  })

  test("production authority reads exact dirt and uses non-force Git removal", async () => {
    const root = await scratchRoot("fmx-cleanup-git-")
    const repository = join(root, "repository")
    const worktree = join(root, "worktree")
    await git(root, "init", "--quiet", "--initial-branch=main", repository)
    await git(repository, "config", "user.email", "fmx@example.invalid")
    await git(repository, "config", "user.name", "fmx test")
    await writeFile(join(repository, "tracked.txt"), "original\n")
    await git(repository, "add", "tracked.txt")
    await git(repository, "commit", "--quiet", "-m", "initial")
    await git(repository, "worktree", "add", "--quiet", "-b", "cleanup-test", worktree)

    const authority = new GitSafeWorktreeAuthority()
    const clean = await authority.inspect(repository, worktree)
    expect(clean).toMatchObject({ kind: "present", trackedChanges: false, untrackedPaths: [] })
    await writeFile(join(worktree, "untracked file.txt"), "untracked\n")
    expect(await authority.inspect(repository, worktree)).toMatchObject({
      kind: "present",
      trackedChanges: false,
      untrackedPaths: ["untracked file.txt"],
    })
    await rm(join(worktree, "untracked file.txt"))
    await writeFile(join(worktree, "tracked.txt"), "changed\n")
    expect(await authority.inspect(repository, worktree)).toMatchObject({
      kind: "present",
      trackedChanges: true,
      untrackedPaths: [],
    })
    await writeFile(join(worktree, "tracked.txt"), "original\n")
    await authority.remove(repository, worktree)
    expect(await authority.inspect(repository, worktree)).toEqual({ kind: "absent" })
  })

  test("porcelain parser preserves exact untracked paths and fails closed on ambiguity", () => {
    const encoded = new TextEncoder().encode("1 M. N... 100644 100644 100644 a b tracked name\0? untracked name\0")
    expect(parsePorcelainV2Status(encoded)).toEqual({
      trackedChanges: true,
      untrackedPaths: ["untracked name"],
    })
    expect(() => parsePorcelainV2Status(new Uint8Array([0x3f, 0x20, 0xff, 0x00]))).toThrow()
    expect(() => parsePorcelainV2Status(new TextEncoder().encode("? ../escape\0"))).toThrow()
  })
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
}
