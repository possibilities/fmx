import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  PHASE1C_EVIDENCE_PATHS,
  PHASE1C_FIXTURE_PATH,
  PHASE1C_FX_CONTRACT_PATH,
  PHASE1C_GATE_INPUT_PATH,
  PHASE1C_IMPLEMENTATION_BASE_COMMIT,
  PHASE1C_REAL_PROCESS_INPUT_PATH,
  PHASE1C_REQUIRED_GATE_SCENARIOS,
  PHASE1C_REQUIRED_REAL_PROCESS_ASSERTIONS,
  Phase1cGateEvidenceV1Schema,
  Phase1cProviderManifestV1Schema,
  Phase1cRealProcessEvidenceV1Schema,
  buildPhase1cFixture,
  buildPhase1cProviderManifest,
  canonicalPhase1cJson,
  verifyPhase1cFixture,
} from "../scripts/generate-agentworkplace-phase1c-provider.ts"

const commit = (character: string) => character.repeat(40)
const digest = (character: string) => `sha256:${character.repeat(64)}`
const artifact = (path: string, character = "a", mode: "0600" | "0700" = "0600") => ({
  bytes: 1,
  digest: digest(character),
  mode,
  path,
})

describe("AgentWorkplace Phase 1C fmx provider", () => {
  test("keeps the implementation base distinct from parameterized final identities", () => {
    expect(PHASE1C_IMPLEMENTATION_BASE_COMMIT).toBe("e52e6be1685afe77f6ab924001a71fee833751e5")
    expect(PHASE1C_EVIDENCE_PATHS).toContain("tests/phase1c-lifecycle-restart-acceptance.test.ts")
    expect(PHASE1C_EVIDENCE_PATHS).toContain("tests/phase1c-real-process-composition-acceptance.test.ts")
    expect(PHASE1C_EVIDENCE_PATHS).toContain("tests/phase1c-real-process-evidence.test.ts")
    expect(PHASE1C_EVIDENCE_PATHS).toContain("scripts/phase1c-real-process-composition-acceptance.sh")
    expect(PHASE1C_EVIDENCE_PATHS).toContain("scripts/phase1c-real-process-evidence.ts")
    expect(PHASE1C_EVIDENCE_PATHS).toContain("src/fx-launch-provider.ts")
    expect(PHASE1C_EVIDENCE_PATHS).toContain("src/git-safe-worktree-cleanup.ts")
    expect(PHASE1C_GATE_INPUT_PATH).not.toContain("phase1b")
    expect(PHASE1C_REAL_PROCESS_INPUT_PATH).not.toContain("phase1b")
  })

  test("accepts only complete gate and real-process evidence inputs", () => {
    const product = { commit: commit("1"), tree: commit("2") }
    const gate = {
      schema_id: "fmx.phase1c-gate-evidence",
      schema_version: 1,
      status: "passed",
      product_repository: product,
      fx: {
        commit: commit("3"),
        binary_sha256: digest("4"),
        private_provider_contract_sha256: digest("5"),
      },
      command: { argv: ["./scripts/local-gate.sh"], exit_status: 0 },
      receipt: { pass: 600, fail: 0, skip: 20, tests: 620, files: 80, expectations: 4000 },
      scenarios: [...PHASE1C_REQUIRED_GATE_SCENARIOS],
      source_paths: ["tests/final-phase1c-gate.test.ts"],
    }
    expect(Phase1cGateEvidenceV1Schema.parse(gate).product_repository).toEqual(product)
    expect(() => Phase1cGateEvidenceV1Schema.parse({
      ...gate,
      scenarios: gate.scenarios.slice(1),
    })).toThrow("missing required gate scenario")
    expect(() => Phase1cGateEvidenceV1Schema.parse({
      ...gate,
      schema_id: "fmx.phase1b-provider",
    })).toThrow()

    const realProcess = {
      schema_id: "fmx.phase1c-real-process-evidence",
      schema_version: 1,
      status: "passed",
      product_repository: product,
      fx: {
        commit: commit("3"),
        binary_sha256: digest("4"),
        private_provider_contract_sha256: digest("5"),
      },
      command: { argv: ["bun", "test", "tests/phase1c-real-process.test.ts"], exit_status: 0 },
      assertions: PHASE1C_REQUIRED_REAL_PROCESS_ASSERTIONS.map((id) => ({ id, passed: true as const })),
      source_paths: ["tests/phase1c-real-process.test.ts"],
    }
    expect(Phase1cRealProcessEvidenceV1Schema.parse(realProcess).fx.commit).toBe(commit("3"))
    expect(() => Phase1cRealProcessEvidenceV1Schema.parse({
      ...realProcess,
      assertions: realProcess.assertions.slice(0, -1),
    })).toThrow("missing required real-process assertion")
    expect(() => Phase1cRealProcessEvidenceV1Schema.parse({
      ...realProcess,
      extra: true,
    })).toThrow()
  })

  test("builds a strict Phase 1C manifest without Phase 1B authority", () => {
    const gate = artifact(PHASE1C_GATE_INPUT_PATH, "6")
    const realProcess = artifact(PHASE1C_REAL_PROCESS_INPUT_PATH, "7")
    const sources = [artifact("artifacts/source/src/lifecycle-runtime.ts", "8")]
    const providerSources = [artifact("artifacts/provider-source/scripts/generate-agentworkplace-phase1c-provider.ts", "9")]
    const fxSources = [artifact(PHASE1C_FX_CONTRACT_PATH, "5")]
    const bundledFixture = artifact(PHASE1C_FIXTURE_PATH, "a", "0700")
    const manifest = buildPhase1cProviderManifest({
      authority: {
        commit: commit("b"),
        tree: commit("a"),
        plan_path: "agentworkplace-implementation-plan.md",
        plan_sha256: digest("b"),
      },
      product: { commit: commit("c"), tree: commit("d"), parents: [commit("e"), commit("f")] },
      provider: { commit: commit("1"), tree: commit("2") },
      fx: {
        commit: commit("3"),
        binarySha256: digest("4"),
        privateProviderContractSha256: digest("5"),
        clientSha256: digest("6"),
        pinSha256: digest("7"),
        sourceTree: commit("8"),
      },
      contracts: {
        manifestSha256: digest("8"),
        fixtures: [
          { path: "artifacts/contracts/agentworkplace/v1/agent-defaults.jsonl", schema_id: "fmx.agent-defaults", sha256: digest("1") },
          { path: "artifacts/contracts/agentworkplace/v1/ensure-lifecycle.jsonl", schema_id: "fmx.ensure-lifecycle", sha256: digest("2") },
          { path: "artifacts/contracts/agentworkplace/v1/fx-launch-admission-final.jsonl", schema_id: "fx.launch-admission-final", sha256: digest("3") },
          { path: "artifacts/contracts/agentworkplace/v1/runtime-extension.jsonl", schema_id: "fmx.runtime-extension", sha256: digest("4") },
        ],
      },
      fixtureDigest: bundledFixture.digest,
      gateInput: gate,
      realProcessInput: realProcess,
      sources,
      providerSources,
      fxSources,
      artifacts: [...sources, ...providerSources, ...fxSources, bundledFixture, gate, realProcess],
    })
    const parsed = Phase1cProviderManifestV1Schema.parse(manifest)
    expect(parsed.schema_id).toBe("fmx.phase1c-provider")
    expect(parsed.authority).toEqual({
      phase: "1c",
      plan: "AgentWorkplace Plan Revision 1",
      commit: commit("b"),
      tree: commit("a"),
      plan_path: "agentworkplace-implementation-plan.md",
      plan_sha256: digest("b"),
      source: "frozen-phase1c-handoff",
    })
    expect(parsed.product_repository.parents).toEqual([commit("e"), commit("f")])
    expect(parsed.provider_source_inventory).toEqual(providerSources)
    expect(JSON.stringify(parsed)).not.toContain("phase1b")
    expect(() => Phase1cProviderManifestV1Schema.parse({ ...parsed, unknown: true })).toThrow()
  })

  test("uses stable sorted canonical JSON while retaining array order", () => {
    expect(canonicalPhase1cJson({ z: ["two", "one"], a: { z: true, a: 1 } })).toBe(`{
  "a": {
    "a": 1,
    "z": true
  },
  "z": [
    "two",
    "one"
  ]
}
`)
  })

  test("bundles and smokes the Phase 1C fixture independently of fmx source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fmx-phase1c-provider-test-"))
    try {
      const output = join(directory, "fixture.js")
      const bytes = await buildPhase1cFixture(resolve(import.meta.dir, ".."), output)
      expect(bytes.byteLength).toBeGreaterThan(0)
      await verifyPhase1cFixture(output)
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
