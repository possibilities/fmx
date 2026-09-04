import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { resolveInstance } from "./instance.ts"
import { resolveKeybindings, type Keybindings } from "./keybindings.ts"

type LoadedConfig = {
  keybindings: Keybindings
  diagnostics: string[]
}

const KNOWN_SECTIONS = new Set(["keys"])

export function configPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return resolveInstance(null, env, homeDirectory).configPath
}

/**
 * One shared file, read by every Instance. It holds the two keys fmx claims
 * and nothing else: what runs in a Session and where its Pane goes are the
 * API's, never a file's.
 */
export async function loadConfig(path = configPath()): Promise<LoadedConfig> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return defaultConfig()
    return defaultConfig(`config read error: ${errorMessage(error)}; using defaults`)
  }

  let document: unknown
  try {
    document = Bun.TOML.parse(content)
  } catch (error) {
    return defaultConfig(`config parse error: ${errorMessage(error)}; using defaults`)
  }

  if (!isRecord(document)) {
    return defaultConfig("config parse error: top-level config must be a table; using defaults")
  }

  const diagnostics: string[] = []
  for (const section of Object.keys(document)) {
    if (!KNOWN_SECTIONS.has(section)) {
      diagnostics.push(`unknown config section [${section}]; ignoring section`)
    }
  }
  const resolved = resolveKeybindings(document.keys)
  diagnostics.push(...resolved.diagnostics)
  return { keybindings: resolved.keybindings, diagnostics }
}

function defaultConfig(...diagnostics: string[]): LoadedConfig {
  return { keybindings: resolveKeybindings().keybindings, diagnostics }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
