/**
 * The Codex models fmx offers before starting fx. fx has the real provider
 * catalog internally but does not expose its per-model effort sets through a
 * machine-readable command, so this small local catalog is intentionally
 * explicit. Keep it in the order the launch picker should present it.
 */

export type CodexModel = {
  id: string
  efforts: readonly string[]
  defaultEffort: string
}

const FULL_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const
const NO_ULTRA = ["low", "medium", "high", "xhigh", "max"] as const
const STANDARD_EFFORTS = ["low", "medium", "high", "xhigh"] as const

export const CODEX_MODELS: readonly CodexModel[] = [
  { id: "gpt-5.6-sol", efforts: FULL_EFFORTS, defaultEffort: "high" },
  { id: "gpt-5.6-terra", efforts: FULL_EFFORTS, defaultEffort: "high" },
  { id: "gpt-5.6-luna", efforts: NO_ULTRA, defaultEffort: "high" },
  { id: "gpt-5.5", efforts: STANDARD_EFFORTS, defaultEffort: "high" },
  { id: "gpt-5.4", efforts: STANDARD_EFFORTS, defaultEffort: "high" },
  { id: "gpt-5.4-mini", efforts: STANDARD_EFFORTS, defaultEffort: "high" },
]

export const DEFAULT_CODEX_MODEL = CODEX_MODELS[0]!

export function codexModel(id: string): CodexModel | null {
  return CODEX_MODELS.find((model) => model.id === id) ?? null
}

export function codexEffort(model: CodexModel, effort: string): string | null {
  return model.efforts.includes(effort) ? effort : null
}

