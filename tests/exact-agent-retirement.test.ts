import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CompanionOwnershipMismatchError,
  type CompanionOwnership,
  type OwnedKillObservation,
  type OwnedKillOptions,
} from "../src/companion-client.ts"
import {
  ExactAgentRetirement,
  ExactAgentRetirementError,
  type RetirementCompanionAuthority,
  type RetirementCompanionConnection,
} from "../src/exact-agent-retirement.ts"
import {
  ExactRetirementLedger,
  type ExactRetirementLedgerFaultPoint,
} from "../src/exact-retirement-ledger.ts"
import type { SessionEntry } from "../src/zmx-command.ts"
import { ExitReason } from "../src/zmx-protocol.ts"
import { retirementFixture } from "./fixtures/exact-retirement.ts"

const HOME_ID = "home-phase1c"
const COMPANION_DIRECTORY = "/private/tmp/fmx-phase1c-zmx"
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function ledgerRoot(): Promise<string> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "fmx-exact-retirement-test-")))
  roots.push(scratch)
  return join(scratch, "ledger")
}

function session(
  agentId: string,
  state: SessionEntry["state"],
  changes: Partial<SessionEntry> = {},
): SessionEntry {
  const name = `fmx-${agentId}`
  return {
    name,
    state,
    socketPath: state === "live" ? join(COMPANION_DIRECTORY, name) : null,
    pid: state === "live" ? 123 : null,
    clients: 0,
    createdAt: 1,
    command: ["fx"],
    cwd: "/var/tmp/worktree",
    labels: { owner: "fmx", home: HOME_ID, agent: agentId, pane: `p_${agentId}` },
    exit: state === "exited"
      ? { code: 0, signal: 9, reason: "requested", endedAt: Date.parse("2026-08-30T20:00:00.000Z") / 1_000 }
      : null,
    detail: null,
    ...changes,
  }
}

function fakeAuthority(
  inventories: SessionEntry[][],
  outcome: OwnedKillObservation | Error,
): RetirementCompanionAuthority & {
  connections: number
  kills: CompanionOwnership[]
  closes: number
} {
  let index = 0
  const authority = {
    connections: 0,
    kills: [] as CompanionOwnership[],
    closes: 0,
    list: async () => structuredClone(inventories[Math.min(index++, inventories.length - 1)] ?? []),
    connect: async (_socketPath: string): Promise<RetirementCompanionConnection> => {
      authority.connections++
      return {
        killIfOwned: async (expected: CompanionOwnership, options: OwnedKillOptions = {}) => {
          authority.kills.push(structuredClone(expected))
          await options.afterFlush?.()
          if (outcome instanceof Error) throw outcome
          return structuredClone(outcome)
        },
        close: () => { authority.closes++ },
      }
    },
  }
  return authority
}

describe("exact started-Agent retirement", () => {
  test("persists Kill intent, verifies the exact Agent, and retains in-band Exit", async () => {
    const fixture = await retirementFixture("ensure-a")
    const ledger = await ExactRetirementLedger.open(await ledgerRoot())
    const authority = fakeAuthority(
      [[session(fixture.ensure.request.agent_id, "live")]],
      { kind: "exit", status: { code: 0, signal: 9, reason: ExitReason.requested } },
    )
    const retirement = new ExactAgentRetirement(
      ledger,
      HOME_ID,
      COMPANION_DIRECTORY,
      authority,
      { now: () => new Date("2026-08-30T20:00:00.000Z") },
    )
    const receipt = await retirement.end(fixture.ensure, fixture.endRequest)
    expect(receipt).toMatchObject({
      message_type: "end_receipt",
      proof: {
        kind: "ended",
        companion_session: `fmx-${fixture.ensure.request.agent_id}`,
        pane_id: `p_${fixture.ensure.request.agent_id}`,
        exit_code: 0,
        signal: 9,
        reason: "requested",
      },
    })
    expect(authority.kills).toEqual([{
      owner: "fmx",
      home: HOME_ID,
      agent: fixture.ensure.request.agent_id,
      pane: `p_${fixture.ensure.request.agent_id}`,
    }])
    expect((await ledger.get(fixture.endRequest.ensure_id))?.end?.kill).toEqual({
      intent_at: "2026-08-30T20:00:00.000Z",
      write_flushed_at: "2026-08-30T20:00:00.000Z",
    })
    expect(await retirement.end(fixture.ensure, fixture.endRequest)).toEqual(receipt)
    expect(authority.connections).toBe(1)
  })

  test("close after Kill is indeterminate until exact labelled exit-record recovery", async () => {
    const fixture = await retirementFixture("ensure-a")
    const agentId = fixture.ensure.request.agent_id
    const ledger = await ExactRetirementLedger.open(await ledgerRoot())
    const authority = fakeAuthority(
      [
        [session(agentId, "live")],
        [session(agentId, "exited")],
      ],
      { kind: "closed", reason: { kind: "peer-closed" } },
    )
    const retirement = new ExactAgentRetirement(
      ledger,
      HOME_ID,
      COMPANION_DIRECTORY,
      authority,
      { refusedReinspectionAttempts: 1 },
    )
    expect(await retirement.end(fixture.ensure, fixture.endRequest)).toMatchObject({
      proof: { kind: "ended", signal: 9, reason: "requested", observed_at: "2026-08-30T20:00:00.000Z" },
    })
    expect(authority.connections).toBe(1)
    expect(authority.closes).toBe(1)
  })

  test("lost Kill response with only unreachable recovery remains pending", async () => {
    const fixture = await retirementFixture("ensure-a")
    const agentId = fixture.ensure.request.agent_id
    const ledger = await ExactRetirementLedger.open(await ledgerRoot())
    const authority = fakeAuthority(
      [
        [session(agentId, "live")],
        [session(agentId, "unreachable")],
      ],
      new Error("socket response lost"),
    )
    expect(await new ExactAgentRetirement(
      ledger,
      HOME_ID,
      COMPANION_DIRECTORY,
      authority,
      { refusedReinspectionAttempts: 1 },
    ).end(fixture.ensure, fixture.endRequest)).toBeNull()
    expect((await ledger.get(fixture.endRequest.ensure_id))?.end).toMatchObject({
      kill: { write_flushed_at: expect.any(String) },
      receipt: null,
    })
  })

  test("an Exit followed by receipt-persistence crash recovers from the retained exit record", async () => {
    const fixture = await retirementFixture("ensure-a")
    const agentId = fixture.ensure.request.agent_id
    const root = await ledgerRoot()
    let armed = false
    let ledger = await ExactRetirementLedger.open(root, {
      fault: (point: ExactRetirementLedgerFaultPoint, record) => {
        if (armed && point === "before_write" && record.revision === 5) throw new Error("receipt-crash")
      },
    })
    const firstAuthority = fakeAuthority(
      [[session(agentId, "live")]],
      { kind: "exit", status: { code: 0, signal: 9, reason: ExitReason.requested } },
    )
    armed = true
    await expect(new ExactAgentRetirement(
      ledger,
      HOME_ID,
      COMPANION_DIRECTORY,
      firstAuthority,
    ).end(fixture.ensure, fixture.endRequest)).rejects.toThrow("receipt-crash")

    ledger = await ExactRetirementLedger.open(root)
    const recoveryAuthority = fakeAuthority(
      [[session(agentId, "exited")]],
      { kind: "timeout" },
    )
    const receipt = await new ExactAgentRetirement(
      ledger,
      HOME_ID,
      COMPANION_DIRECTORY,
      recoveryAuthority,
    ).end(fixture.ensure, fixture.endRequest)
    expect(receipt?.proof).toMatchObject({ kind: "ended", reason: "requested" })
    expect(recoveryAuthority.connections).toBe(0)
  })

  test("foreign labels, reused paths, unreachable, and absent sessions never fabricate proof", async () => {
    const fixture = await retirementFixture("ensure-a")
    const agentId = fixture.ensure.request.agent_id
    const cases: Array<{
      label: string
      entry: SessionEntry[]
      error?: ExactAgentRetirementError["code"]
    }> = [
      {
        label: "foreign labels",
        entry: [session(agentId, "live", { labels: { owner: "fmx", home: HOME_ID, agent: "f".repeat(32), pane: `p_${"f".repeat(32)}` } })],
        error: "ownership_mismatch",
      },
      {
        label: "reused path",
        entry: [session(agentId, "live", { socketPath: join(COMPANION_DIRECTORY, "foreign") })],
        error: "session_mismatch",
      },
      { label: "unreachable", entry: [session(agentId, "unreachable")] },
      { label: "absent", entry: [] },
    ]
    for (const candidate of cases) {
      const ledger = await ExactRetirementLedger.open(await ledgerRoot())
      const authority = fakeAuthority([candidate.entry], { kind: "timeout" })
      const operation = new ExactAgentRetirement(
        ledger,
        HOME_ID,
        COMPANION_DIRECTORY,
        authority,
      ).end(fixture.ensure, fixture.endRequest)
      if (candidate.error) {
        await expect(operation, candidate.label).rejects.toMatchObject({
          name: "ExactAgentRetirementError",
          code: candidate.error,
        } satisfies Partial<ExactAgentRetirementError>)
      } else {
        expect(await operation, candidate.label).toBeNull()
      }
      expect(authority.connections, candidate.label).toBe(0)
      expect((await ledger.get(fixture.endRequest.ensure_id))?.end?.receipt, candidate.label).toBeNull()
    }
  })

  test("same-connection label mismatch refuses before exact Kill can be trusted", async () => {
    const fixture = await retirementFixture("ensure-a")
    const agentId = fixture.ensure.request.agent_id
    const ledger = await ExactRetirementLedger.open(await ledgerRoot())
    const authority = fakeAuthority(
      [[session(agentId, "live")]],
      new CompanionOwnershipMismatchError(
        { owner: "fmx", home: HOME_ID, agent: agentId, pane: `p_${agentId}` },
        { owner: "foreign" },
      ),
    )
    await expect(new ExactAgentRetirement(
      ledger,
      HOME_ID,
      COMPANION_DIRECTORY,
      authority,
    ).end(fixture.ensure, fixture.endRequest)).rejects.toMatchObject({
      code: "ownership_mismatch",
    })
    expect((await ledger.get(fixture.endRequest.ensure_id))?.end?.receipt).toBeNull()
  })

  test("cancelled-before-start remains an explicitly injected proof source", async () => {
    const fixture = await retirementFixture("ensure-b")
    const ledger = await ExactRetirementLedger.open(await ledgerRoot())
    const authority = fakeAuthority([[]], { kind: "timeout" })
    const retirement = new ExactAgentRetirement(ledger, HOME_ID, COMPANION_DIRECTORY, authority)
    expect(await retirement.end(fixture.ensure, fixture.endRequest)).toBeNull()
    const receipt = await retirement.end(fixture.ensure, fixture.endRequest, {
      prove: async () => structuredClone(fixture.endReceipt.proof) as Extract<
        typeof fixture.endReceipt.proof,
        { kind: "never_started" }
      >,
    })
    expect(receipt?.proof).toEqual(fixture.endReceipt.proof)
    expect(authority.connections).toBe(0)
    expect(authority.kills).toEqual([])
  })
})
