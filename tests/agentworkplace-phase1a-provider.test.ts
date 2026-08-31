import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  PHASE1A_OUTPUT_PATHS,
  PHASE1A_PRODUCT_COMMIT,
  PHASE1A_PRODUCT_TREE,
  PHASE1A_REQUIRED_PASS_SCENARIOS,
  buildPhase1aConsumerFixture,
  buildPhase1aProviderManifest,
  canonicalPhase1aProviderJson,
  parsePhase1aGateLog,
  phase1aGateEnvironment,
  validatePhase1aCommandReceipt,
} from "../scripts/generate-agentworkplace-phase1a-provider.ts"
import { PHASE1B_EXPECTED_SKIPS } from "../scripts/generate-agentworkplace-phase1b-provider.ts"
import { PHASE1A_EXPECTED_FX_IDENTITY } from "./fixtures/agentworkplace-phase1a-fx-consumer.ts"

const REPOSITORY_ROOT = resolve(import.meta.dir, "..")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function acceptedGateLog(): string {
  const skips = PHASE1B_EXPECTED_SKIPS.map(({ description }) => `(skip) ${description}`).join("\n")
  const passes = PHASE1A_REQUIRED_PASS_SCENARIOS
    .map((description) => `(pass) AgentWorkplace Phase 1A Fx consumer fixture > ${description} [1.00ms]`)
    .join("\n")
  return `${skips}\n${passes}\n${skips}\n\n 480 pass\n 20 skip\n 0 fail\n 3009 expect() calls\nRan 500 tests across 66 files.\n\n 4 pass\n 0 fail\n 32 expect() calls\nRan 4 tests across 1 file.\nfmx local gate: PASS macos-aarch64\n`
}

function artifact(path: string, mode: "0600" | "0700" = "0600") {
  return { bytes: 1, digest: `sha256:${"a".repeat(64)}`, mode, path }
}

const commandReceipt = {
  argv: ["/fixture/command", "--exact"],
  exit_status: 0 as const,
  schema_id: "fmx.phase1a-command-receipt" as const,
  schema_version: 1 as const,
  stderr: "" as const,
  stdout: "ok\n",
}

describe("AgentWorkplace Phase 1A fmx provider", () => {
  test("freezes two commits and one exact private output inventory", () => {
    expect(PHASE1A_PRODUCT_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    expect(PHASE1A_PRODUCT_TREE).toMatch(/^[0-9a-f]{40}$/)
    expect(PHASE1A_PRODUCT_COMMIT).not.toBe("0".repeat(40))
    expect(PHASE1A_PRODUCT_TREE).not.toBe("0".repeat(40))
    expect(PHASE1A_OUTPUT_PATHS).toHaveLength(21)
    expect(new Set(PHASE1A_OUTPUT_PATHS).size).toBe(PHASE1A_OUTPUT_PATHS.length)
    expect(PHASE1A_OUTPUT_PATHS).toContain(
      "artifacts/consumer-fixture/agentworkplace-phase1a-fx-consumer.js",
    )
    expect(PHASE1A_OUTPUT_PATHS).toContain("artifacts/fx-evidence/install-receipt.json")
  })

  test("parses only exact canonical general, skip, scenario, and PTY receipts", () => {
    expect(parsePhase1aGateLog(acceptedGateLog())).toEqual({
      actualSkips: PHASE1B_EXPECTED_SKIPS,
      general: { pass: 480, skip: 20, fail: 0, expectations: 3009, tests: 500, files: 66 },
      pty: { pass: 4, skip: 0, fail: 0, expectations: 32, tests: 4, files: 1 },
    })
    expect(() => parsePhase1aGateLog(acceptedGateLog().replace("480 pass", "481 pass")))
      .toThrow("canonical general gate counts changed")
    const firstSkip = `(skip) ${PHASE1B_EXPECTED_SKIPS[0]!.description}`
    const secondSkip = `(skip) ${PHASE1B_EXPECTED_SKIPS[1]!.description}`
    expect(() => parsePhase1aGateLog(acceptedGateLog().replaceAll(`${firstSkip}\n`, "")))
      .toThrow("canonical fmx gate skip inventory changed")
    expect(() => parsePhase1aGateLog(acceptedGateLog().replace(firstSkip, `${firstSkip}\n(skip) another scenario`)))
      .toThrow("canonical fmx gate skip inventory changed")
    expect(() => parsePhase1aGateLog(acceptedGateLog().replace(firstSkip, secondSkip)))
      .toThrow("canonical fmx gate skip inventory changed")
    expect(() => parsePhase1aGateLog(acceptedGateLog().replace(
      PHASE1A_REQUIRED_PASS_SCENARIOS[0],
      "unrelated passing scenario",
    ))).toThrow("omitted Phase 1A consumer scenario")
  })

  test("requires compact canonical command receipts and exact facts", () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(commandReceipt)}\n`)
    expect(validatePhase1aCommandReceipt(bytes, commandReceipt)).toEqual(commandReceipt)
    const additive = new TextEncoder().encode(`${JSON.stringify({ ...commandReceipt, timestamp: "invented" })}\n`)
    expect(() => validatePhase1aCommandReceipt(additive, commandReceipt)).toThrow("keys changed")
    const failed = new TextEncoder().encode(`${JSON.stringify({ ...commandReceipt, exit_status: 1 })}\n`)
    expect(() => validatePhase1aCommandReceipt(failed, commandReceipt)).toThrow("facts changed")
  })

  test("isolates every gate-owned install surface inside the private source root", () => {
    const scratch = "/private/tmp/fmx-phase1a-provider-source-fixture"
    const environment = phase1aGateEnvironment(scratch, {
      BUN_INSTALL: "/live/bun",
      FMX_INSTALL_BIN_DIR: "/live/native",
      GIT_DIR: "/untrusted/git",
      PATH: "/fixture/bin",
    })
    expect(environment.BUN_INSTALL).toBe(join(scratch, "gate-bun-install"))
    expect(environment.FMX_INSTALL_BIN_DIR).toBe(join(scratch, "gate-native-bin"))
    expect(environment.TMPDIR).toBe(join(scratch, "gate-tmp"))
    expect(environment.ZIG_GLOBAL_CACHE_DIR).toBe(join(scratch, "zig-global-cache"))
    expect(environment.GIT_DIR).toBeUndefined()
    expect(environment.PATH).toBe("/fixture/bin")
  })

  test("builds the strict provider schema without broadening fmx", () => {
    const requiredArtifacts = [
      artifact("artifacts/consumer-fixture/agentworkplace-phase1a-fx-consumer.js", "0700"),
      artifact("artifacts/consumer-execution/phase1a-consumer-execution.json"),
      artifact("artifacts/contracts/agentworkplace/v1/fx-launch-admission-final.jsonl"),
      artifact("artifacts/fx-evidence/fx-built-commit"),
      artifact("artifacts/fx-evidence/fx-built-sha256"),
      artifact("artifacts/fx-evidence/install-receipt.json"),
      artifact("artifacts/fx-evidence/local-gate-receipt.json"),
      artifact("artifacts/fx-evidence/local-gate.raw.log"),
      artifact("artifacts/fx-evidence/ship-receipt.json"),
    ]
    const manifest = buildPhase1aProviderManifest({
      artifacts: requiredArtifacts,
      consumerReceipt: { accepted: true },
      fixtureCommandStderr: artifact("consumer-fixture-command.stderr.log"),
      fixtureCommandStdout: artifact("consumer-fixture-command.stdout.log"),
      gate: parsePhase1aGateLog(acceptedGateLog()),
      gateLog: artifact("local-gate.log"),
      installedFx: { ...PHASE1A_EXPECTED_FX_IDENTITY, path: "/fixture/fmx-fx" },
      manager: { files: [], install: commandReceipt, ship: commandReceipt },
      product: { commit: "1".repeat(40), parent: "2".repeat(40), tree: "3".repeat(40) },
      provider: { commit: "4".repeat(40), tree: "5".repeat(40) },
    }) as Record<string, any>
    expect(manifest).toMatchObject({
      schema_id: "fmx.phase1a-provider",
      schema_version: 1,
      authority: { phase: "1a", wiki_commit: "8bad6eec880586747bc67eab496ce76c92742c14" },
      product_repository: { commit: "1".repeat(40), parent: "2".repeat(40), tree: "3".repeat(40) },
      provider_repository: { commit: "4".repeat(40), tree: "5".repeat(40) },
      public_mcp: { status: "unchanged", tool_count: 11 },
      owner_gate: {
        canary_count: 116,
        classification: "canonical_owner_gate_only_not_fresh_consumer_execution",
      },
      non_goals: { production_launch_transport: false, phase1c_lifecycle: false },
    })
    expect(manifest.contracts.launch_admission_final.final_receipt_ack_interpretation)
      .toBe("frozen_fixture_consumption_plus_canonical_owner_canaries")
  })

  test("renders canonical JSON and bundles one source-independent executable fixture", async () => {
    expect(canonicalPhase1aProviderJson({ z: [2, 1], a: { z: true, a: 1 } })).toBe(`{
  "a": {
    "a": 1,
    "z": true
  },
  "z": [
    2,
    1
  ]
}
`)
    const root = await mkdtemp(join(tmpdir(), "fmx-phase1a-provider-test-"))
    roots.push(root)
    await chmod(root, 0o700)
    const bundle = join(root, "consumer.js")
    const bytes = await buildPhase1aConsumerFixture(REPOSITORY_ROOT, bundle)
    expect(bytes.byteLength).toBeGreaterThan(0)
    const help = Bun.spawnSync({ cmd: [process.execPath, bundle, "--help"], stdout: "pipe", stderr: "pipe" })
    expect(help.exitCode).toBe(0)
    expect(help.stderr.byteLength).toBe(0)
    const text = new TextDecoder().decode(help.stdout)
    for (const flag of ["--fx", "--evidence", "--contracts", "--owner-gate-receipt"]) {
      expect(text).toContain(flag)
    }
  })
})
