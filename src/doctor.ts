import { access, constants, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { VERSION } from "./cli.ts"
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
  /** False when the Companion is missing, unreadable, or not the pinned build. fx is reported, not judged. */
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
    rows.push(["fx", await resolveFx(env.FMX_FX_PATH ?? "fx", env)])
  } catch (error) {
    rows.push(["fx", `${errorMessage(error)}; install it from https://fx.sh/`])
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

/**
 * fx: `FMX_FX_PATH`, else `fx` on PATH. A path is taken as given; a bare
 * name is looked up. There is deliberately no flag.
 */
export async function resolveFx(requested: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidate = requested.includes("/")
    ? isAbsolute(requested)
      ? requested
      : resolve(process.cwd(), requested)
    : Bun.which(requested, { PATH: env.PATH ?? "" })
  if (!candidate) throw new Error(`fx executable not found: ${requested} (set FMX_FX_PATH)`)
  try {
    await access(candidate, constants.X_OK)
  } catch {
    throw new Error(`fx executable is not executable: ${candidate}`)
  }
  return realpath(candidate)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
