import { VERSION } from "./cli.ts"
import {
  FX_PATH_ENV_VAR,
  HUNK_PATH_ENV_VAR,
  resolveFx,
  resolveHunk,
} from "./executable.ts"
import { fmxDirectory } from "./state.ts"
import { PROTOCOL_VERSION } from "./zmx-protocol.ts"
import {
  COMPANION_PATH_ENV_VAR,
  COMPANION_PIN,
  companionBuild,
  companionDirectories,
  companionDirectory,
  companionMismatch,
  ensureCompanionDirectories,
  homeIdFor,
  installedDirectory,
  resolveCompanion,
  type ResolvedCompanion,
} from "./zmx-environment.ts"

/**
 * `fmx doctor`: what a start would find, reported instead of acted on. The
 * Companion is resolved the way a start resolves it and its build compared
 * to the pin; the directory is made private the way a start makes it; fx is
 * looked up the way a start looks it up. Nothing is bound and nothing is
 * joined — a running fmx is undisturbed, and a second fmx's refusal to run
 * beside it is not this report's to give.
 */
export type DoctorReport = {
  lines: string[]
  /**
   * False when the Companion is missing, unreadable, or not the pinned build,
   * or its directory is not fmx's own — what would stop a start. fx is
   * reported, not judged; so is a build the override named, which a start
   * runs with a word about it.
   */
  ok: boolean
}

export async function doctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const rows: [string, string][] = [["fmx", VERSION]]
  let ok = true
  const fail = (label: string, text: string) => {
    ok = false
    rows.push([label, text])
  }

  let companion: ResolvedCompanion | null = null
  try {
    companion = await resolveCompanion(env)
    rows.push(["companion", `${companion.path} (${describeOrigin(companion)})`])
  } catch (error) {
    fail("companion", errorMessage(error))
  }

  const directories = companionDirectories(env)
  let directoryUsable = false
  try {
    await ensureCompanionDirectories(directories)
    directoryUsable = true
    rows.push(["directory", `${companionDirectory(env)} (private)`])
  } catch (error) {
    fail("directory", errorMessage(error))
  }

  if (companion !== null && directoryUsable) {
    try {
      const build = await companionBuild(companion.path, env)
      if (build === COMPANION_PIN.build) {
        rows.push(["build", `${build} (the build this fmx was released with)`])
      } else if (companion.origin === "override") {
        rows.push(["build", companionMismatch(companion, build, PROTOCOL_VERSION)])
      } else {
        fail("build", companionMismatch(companion, build, PROTOCOL_VERSION))
      }
    } catch (error) {
      fail("build", errorMessage(error))
    }
  } else if (companion !== null) {
    rows.push(["build", `not checked: the directory is unusable (expected ${COMPANION_PIN.build})`])
  } else {
    rows.push(["build", `expected ${COMPANION_PIN.build} (${COMPANION_PIN.repository} ${COMPANION_PIN.commit.slice(0, 12)})`])
  }
  rows.push(["protocol", String(PROTOCOL_VERSION)])

  const home = fmxDirectory(env)
  rows.push(["home", `${homeIdFor(home)} (${home})`])

  try {
    rows.push(["fx", await resolveFx(env[FX_PATH_ENV_VAR] ?? "fx", env)])
  } catch (error) {
    rows.push(["fx", `${errorMessage(error)}; install it from https://fx.sh/`])
  }

  // hunk is reported the way fx is, and judged no more: without it the Tools
  // panel is simply not offered, which stops no start.
  try {
    rows.push(["hunk", await resolveHunk(env[HUNK_PATH_ENV_VAR] ?? "hunk", env)])
  } catch (error) {
    rows.push(["hunk", `${errorMessage(error)}; the Diff panel is not offered without it`])
  }

  const width = Math.max(...rows.map(([label]) => label.length))
  return { lines: rows.map(([label, text]) => `${label.padEnd(width)}  ${text}`), ok }
}

function describeOrigin(companion: ResolvedCompanion): string {
  switch (companion.origin) {
    case "override":
      return COMPANION_PATH_ENV_VAR
    case "sibling":
      return `beside ${installedDirectory() ?? "fmx"}/fmx`
    case "path":
      return "on PATH"
  }
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
