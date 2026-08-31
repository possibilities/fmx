import { describe, expect, test } from "bun:test"
import {
  FX_PRIVATE_PROVIDER_CONTRACT_SHA256,
  PHASE1C_REQUIRED_REAL_PROCESS_ASSERTIONS,
  Phase1cRealProcessEvidenceV1Schema,
  buildPhase1cRealProcessEvidence,
  canonicalPhase1cEvidenceJson,
} from "../scripts/phase1c-real-process-evidence.ts"

describe("Phase 1C composition-level real-process evidence", () => {
  test("matches the strict provider-generator v1 evidence schema", () => {
    const evidence = buildPhase1cRealProcessEvidence({
      productCommit: "1".repeat(40),
      productTree: "2".repeat(40),
      fxBinarySha256: `sha256:${"3".repeat(64)}`,
    })
    expect(Phase1cRealProcessEvidenceV1Schema.parse(evidence)).toEqual(evidence)
    expect(evidence.fx.private_provider_contract_sha256).toBe(FX_PRIVATE_PROVIDER_CONTRACT_SHA256)
    expect(evidence.assertions.map(({ id }) => id)).toEqual(expect.arrayContaining([
      ...PHASE1C_REQUIRED_REAL_PROCESS_ASSERTIONS,
      "one-companion-pid",
      "one-native-turn",
      "ensure-receipt-durable",
      "fx-final-receipt-acknowledged",
      "end-receipt-exact",
      "dirty-cleanup-refused",
      "foreign-replacement-refused-mismatch",
      "work-control-socket-removed",
      "runner-cleanup-complete",
      "final-companion-inventory-empty",
    ]))
    expect(() => Phase1cRealProcessEvidenceV1Schema.parse({ ...evidence, extra: true })).toThrow()
    expect(() => Phase1cRealProcessEvidenceV1Schema.parse({
      ...evidence,
      assertions: evidence.assertions.filter(({ id }) => id !== "private-provider-launch"),
    })).toThrow("missing required real-process assertion private-provider-launch")
  })

  test("writes stable sorted canonical JSON without reordering assertions", () => {
    expect(canonicalPhase1cEvidenceJson({ z: ["two", "one"], a: { z: true, a: 1 } })).toBe(`{
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
