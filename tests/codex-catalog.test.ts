import { describe, expect, test } from "bun:test"
import {
  CODEX_MODELS,
  codexEffort,
  codexModel,
  DEFAULT_CODEX_MODEL,
} from "../src/codex-catalog.ts"

describe("Codex launch catalog", () => {
  test("keeps its presentation order and default together", () => {
    expect(CODEX_MODELS.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ])
    expect(DEFAULT_CODEX_MODEL).toMatchObject({ id: "gpt-5.6-sol", defaultEffort: "high" })
  })

  test("looks up only catalog-supported model and effort pairs", () => {
    const sol = codexModel("gpt-5.6-sol")
    const luna = codexModel("gpt-5.6-luna")
    expect(sol && codexEffort(sol, "ultra")).toBe("ultra")
    expect(luna && codexEffort(luna, "ultra")).toBeNull()
    expect(codexModel("future-model")).toBeNull()
  })
})
