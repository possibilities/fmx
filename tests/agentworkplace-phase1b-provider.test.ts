import { describe, expect, test } from "bun:test"
import {
  PHASE1B_EVIDENCE_PATHS,
  PHASE1B_EXPECTED_SKIPS,
  PHASE1B_FEATURE_INVENTORY,
  PHASE1B_PRODUCT_COMMIT,
  PHASE1B_PRODUCT_PARENTS,
  PHASE1B_PRODUCT_TREE,
  PHASE1B_PTY_SCENARIOS,
  PHASE1B_REQUIRED_PASS_SCENARIOS,
  PHASE1B_TEST_PATHS,
  buildPhase1bProviderManifest,
  canonicalPhase1bProviderJson,
  parsePhase1bGateLog,
} from "../scripts/generate-agentworkplace-phase1b-provider.ts"

const PRODUCT_CHANGED_PATHS = [
  "CONTEXT.md",
  "fx.json",
  "src/agent-picker.ts",
  "src/config.ts",
  "src/fx-environment.ts",
  "src/index.ts",
  "src/multiplexer.ts",
  "src/recovery-card.ts",
  "src/runtime-extension-host.ts",
  "src/runtime-extension-registration.ts",
  "src/runtime-extension.ts",
  "src/runtime-session.ts",
  "src/runtime-startup.ts",
  "src/session-list.ts",
  "tests/config.test.ts",
  "tests/fixtures/fake-fx.ts",
  "tests/fixtures/runtime-extension.ts",
  "tests/fx-environment.test.ts",
  "tests/multiplexer-control.test.ts",
  "tests/multiplexer-recovery-card.test.ts",
  "tests/multiplexer-transport.test.ts",
  "tests/multiplexer.e2e.test.ts",
  "tests/recovery-card.test.ts",
  "tests/runtime-extension-fixture.test.ts",
  "tests/runtime-extension-host.test.ts",
  "tests/runtime-extension-registration.test.ts",
  "tests/runtime-extension-supervisor-child.ts",
  "tests/runtime-extension-supervisor.test.ts",
  "tests/runtime-session.test.ts",
  "tests/runtime-startup.test.ts",
] as const

function acceptedGateLog(): string {
  const skips = PHASE1B_EXPECTED_SKIPS.map(({ description }) => `(skip) ${description}`).join("\n")
  const passes = PHASE1B_REQUIRED_PASS_SCENARIOS.map((description) =>
    `(pass) Phase 1B provider evidence > ${description} [1.00ms]`
  ).join("\n")
  return `${skips}\n${passes}\n\n 473 pass\n 20 skip\n 0 fail\n 2954 expect() calls\nRan 493 tests across 64 files.\n${PHASE1B_PTY_SCENARIOS.map((description) => `(pass) ${description} [1.00ms]`).join("\n")}\n\n 4 pass\n 0 fail\n 32 expect() calls\nRan 4 tests across 1 files.\n`
}

describe("AgentWorkplace Phase 1B fmx provider", () => {
  test("pins the exact composed product and inventories every changed path", () => {
    expect(PHASE1B_PRODUCT_COMMIT).toBe("7c6f3f7df55c4366ba0d6b70be966973445322ce")
    expect(PHASE1B_PRODUCT_TREE).toBe("31b471da3550de6506de339864f2537d4c18f0c8")
    expect(PHASE1B_PRODUCT_PARENTS).toEqual([
      "53e5bc20531353325a96dcf3c2f2a2fc3b3ffdb6",
      "10b7c878615814b07ab7ae3955786a501a188a57",
    ])
    expect(new Set(PHASE1B_EVIDENCE_PATHS).size).toBe(PHASE1B_EVIDENCE_PATHS.length)
    for (const path of PRODUCT_CHANGED_PATHS) expect(PHASE1B_EVIDENCE_PATHS).toContain(path)
    expect(PHASE1B_TEST_PATHS).toContain("tests/runtime-startup.test.ts")
    expect(PHASE1B_TEST_PATHS).toContain("tests/agentworkplace-contract-adversarial.test.ts")
    expect(PHASE1B_TEST_PATHS).toContain("tests/mcp-server.test.ts")
  })

  test("parses only the exact accepted general, skip, scenario, and PTY receipts", () => {
    expect(parsePhase1bGateLog(acceptedGateLog())).toEqual({
      general: { pass: 473, skip: 20, fail: 0, expectations: 2954, tests: 493, files: 64 },
      pty: { pass: 4, skip: 0, fail: 0, expectations: 32, tests: 4, files: 1 },
      actualSkips: PHASE1B_EXPECTED_SKIPS,
    })
    expect(() => parsePhase1bGateLog(acceptedGateLog().replace("473 pass", "474 pass"))).toThrow(
      "canonical general gate counts changed",
    )
    expect(() => parsePhase1bGateLog(acceptedGateLog().replace("20 skip", "19 skip"))).toThrow(
      "canonical general gate counts changed",
    )
    expect(() => parsePhase1bGateLog(acceptedGateLog().replace("4 pass", "3 pass"))).toThrow(
      "canonical PTY gate counts changed",
    )
  })

  test("refuses semantic skip or required-scenario drift even when counts agree", () => {
    const changedSkip = acceptedGateLog().replace(
      `(skip) ${PHASE1B_EXPECTED_SKIPS[0]!.description}`,
      "(skip) a different skipped behavior",
    )
    expect(() => parsePhase1bGateLog(changedSkip)).toThrow("canonical general gate skip inventory changed")
    const missingScenario = acceptedGateLog().replace(
      `(pass) Phase 1B provider evidence > ${PHASE1B_REQUIRED_PASS_SCENARIOS[0]} [1.00ms]`,
      "(pass) Phase 1B provider evidence > an unrelated behavior [1.00ms]",
    )
    expect(() => parsePhase1bGateLog(missingScenario)).toThrow("canonical gate omitted required Phase 1B scenario")
  })

  test("builds the distinct v1 package with exact protocol and test inventories", () => {
    const manifest = buildPhase1bProviderManifest({
      artifacts: [
        { bytes: 1, digest: "sha256:owner", mode: "0600", path: "artifacts/contracts/agentworkplace/v1/manifest.json" },
        { bytes: 2, digest: "sha256:runtime", mode: "0600", path: "artifacts/contracts/agentworkplace/v1/runtime-extension.jsonl" },
        { bytes: 3, digest: "sha256:defaults", mode: "0600", path: "artifacts/contracts/agentworkplace/v1/agent-defaults.jsonl" },
      ],
      fixtureDigest: "sha256:bundle",
      gateLog: { bytes: 4, digest: "sha256:gate", mode: "0600", path: "local-gate.log" },
      gate: parsePhase1bGateLog(acceptedGateLog()),
      native: {
        companionBuild: "0.7.0+fmx.2ffb1c1e425f",
        companionSha256: "sha256:companion",
        fmxVersion: "0.3.1",
        fxCommit: "beadc01a82891ef22bfa6cd3bc88f12edcec9176",
        fxSha256: "sha256:fx",
        fxnk: "0.5.0",
      },
      product: { commit: PHASE1B_PRODUCT_COMMIT, parents: PHASE1B_PRODUCT_PARENTS, tree: PHASE1B_PRODUCT_TREE },
      provider: { commit: "a".repeat(40), tree: "b".repeat(40) },
    }) as Record<string, any>

    expect(manifest).toMatchObject({
      schema_id: "fmx.phase1b-provider",
      schema_version: 1,
      package: { name: "fmx.phase1b-provider", version: "1" },
      authority: { phase: "1b", wiki_commit: "8bad6eec880586747bc67eab496ce76c92742c14" },
      product_repository: {
        commit: PHASE1B_PRODUCT_COMMIT,
        parents: [...PHASE1B_PRODUCT_PARENTS],
        tree: PHASE1B_PRODUCT_TREE,
      },
      protocol: {
        version: "1",
        capabilities: [
          "headless_liveness",
          "member_present_focus",
          "member_snapshot_pull",
          "unavailable_slot_recovery_action",
        ],
        owner_manifest_digest: "sha256:owner",
        runtime_extension_fixture_digest: "sha256:runtime",
        agent_defaults_fixture_digest: "sha256:defaults",
      },
      public_mcp: { tool_count: 11 },
      tests: {
        general: { pass: 473, skip: 20, fail: 0, expectations: 2954 },
        pty: { pass: 4, skip: 0, fail: 0, expectations: 32 },
        files: [...PHASE1B_TEST_PATHS],
      },
    })
    expect(manifest.features).toEqual(PHASE1B_FEATURE_INVENTORY)
  })

  test("renders canonical package JSON with sorted object keys and stable array order", () => {
    expect(canonicalPhase1bProviderJson({ z: ["two", "one"], a: { z: true, a: 1 } })).toBe(`{
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
})
