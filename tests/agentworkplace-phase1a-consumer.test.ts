import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PHASE1A_CONSUMER_EVIDENCE_PATHS,
  PHASE1A_CONSUMER_EXECUTION_SCHEMA_ID,
  PHASE1A_CONSUMER_SCENARIO_IDS,
  PHASE1A_EXPECTED_FX_IDENTITY,
  PHASE1A_FX_COMMIT,
  PHASE1A_FX_SHA256,
  PHASE1A_LAUNCH_FIXTURE_SHA256,
  PHASE1A_OWNER_CANARIES,
  runPhase1aConsumerFixture,
  verifyPhase1aConsumerEvidence,
} from "./fixtures/agentworkplace-phase1a-fx-consumer.ts"

const roots: string[] = []
const INSTALLED_FX = join(process.env.HOME ?? "", ".local", "bin", "fmx-fx")

setDefaultTimeout(120_000)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("AgentWorkplace Phase 1A Fx consumer fixture", () => {
  test("executes the three fresh-binary scenarios and emits one strict v1 receipt", async () => {
    const evidence = await privateEvidenceDirectory()
    const result = await runPhase1aConsumerFixture({ evidence, fx: INSTALLED_FX })
    expect(result.receipt).toMatchObject({
      accepted: true,
      schema_id: PHASE1A_CONSUMER_EXECUTION_SCHEMA_ID,
      schema_version: 1,
      execution: {
        identity_probes: "exclusive_private_snapshot",
        installed_source_executed: false,
        scenarios: "exclusive_private_snapshot",
        snapshot_bytes: 11_065_088,
        snapshot_retained: false,
        snapshot_revalidated_after_execution: true,
        snapshot_sha256: `sha256:${PHASE1A_FX_SHA256}`,
        source_revalidated_after_execution: true,
      },
      fx: {
        commit: PHASE1A_FX_COMMIT,
        sha256: `sha256:${PHASE1A_FX_SHA256}`,
      },
      contracts: {
        launch_admission_final: {
          digest: `sha256:${PHASE1A_LAUNCH_FIXTURE_SHA256}`,
          message_count: 9,
        },
        work_control: { schema_version: 1, status: "unchanged" },
      },
      owner_canary_evidence: {
        classification: "canonical_owner_gate_only_not_fresh_consumer_execution",
        exact_names: [...PHASE1A_OWNER_CANARIES],
      },
    })
    expect((result.receipt.scenarios as Array<Record<string, unknown>>)
      .map(({ scenario_id }) => scenario_id)).toEqual([...PHASE1A_CONSUMER_SCENARIO_IDS])
    expect(result.stderr.bytes).toBe(0)
    expect((await readdir(evidence)).length).toBe(PHASE1A_CONSUMER_EVIDENCE_PATHS.length)

    await writeFile(join(evidence, "unexpected.txt"), "unexpected", { mode: 0o600 })
    await expect(verifyPhase1aConsumerEvidence(evidence, PHASE1A_EXPECTED_FX_IDENTITY))
      .rejects.toThrow("consumer evidence inventory changed")
    await rm(join(evidence, "unexpected.txt"))

    const receiptPath = join(evidence, "phase1a-consumer-execution.json")
    const originalReceipt = await readFile(receiptPath, "utf8")
    const overclaim = JSON.parse(originalReceipt) as Record<string, unknown>
    const execution = overclaim.execution as Record<string, unknown>
    execution.scenarios = "direct_installed_source"
    await writeFile(receiptPath, `${JSON.stringify(overclaim, null, 2)}\n`, { mode: 0o600 })
    await chmod(receiptPath, 0o600)
    await expect(verifyPhase1aConsumerEvidence(evidence, PHASE1A_EXPECTED_FX_IDENTITY))
      .rejects.toThrow("consumer execution evidence changed")

    const receipt = JSON.parse(originalReceipt) as Record<string, unknown>
    receipt.schema_version = 2
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    await chmod(receiptPath, 0o600)
    await expect(verifyPhase1aConsumerEvidence(evidence, PHASE1A_EXPECTED_FX_IDENTITY))
      .rejects.toThrow()
  })
})

async function privateEvidenceDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fmx-phase1a-consumer-test-"))
  roots.push(root)
  await chmod(root, 0o700)
  return root
}
