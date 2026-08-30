import { VERSION } from "./cli.ts"
import {
  FX_PATH_ENV_VAR,
  probeFxnkVersion,
  resolveFx,
} from "./executable.ts"
import { resolveFmxHome, type FmxHome } from "./home.ts"
import { PROTOCOL_VERSION } from "./zmx-protocol.ts"
import {
  COMPANION_PATH_ENV_VAR,
  COMPANION_PIN,
  companionBuild,
  companionDirectories,
  companionDirectory,
  companionMismatch,
  ensureCompanionDirectories,
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
   * its directory is not fmx's own, or fx lacks the required fxnk ADE
   * contract. An overridden Companion build is still reported rather than
   * judged because a start deliberately runs it with a word about it.
   */
  ok: boolean
}

export async function doctor(
  env: NodeJS.ProcessEnv = process.env,
  home: FmxHome = resolveFmxHome(null, env),
): Promise<DoctorReport> {
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
        rows.push(["build", `${build} (the build pinned by this fmx checkout)`])
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

  if (home.name !== null) rows.push(["name", home.name])
  rows.push(["home", `${home.id} (${home.directory})`])

  try {
    const fxPath = await resolveFx(env[FX_PATH_ENV_VAR], env)
    const fxnkVersion = await probeFxnkVersion(fxPath, env)
    rows.push(["fx", fxnkVersion ? `${fxPath} (fxnk ${fxnkVersion})` : fxPath])
  } catch (error) {
    fail("fx", errorMessage(error))
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
