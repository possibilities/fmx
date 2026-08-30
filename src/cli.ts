import packageMetadata from "../package.json" with { type: "json" }
import { normalizeFmxName } from "./home.ts"

export const VERSION = packageMetadata.version

export type CliOptions = {
  help: boolean
  version: boolean
  /** `fmx doctor`: report the installation instead of running the TUI. */
  doctor: boolean
  /** null selects the existing unnamed/default fmx. */
  name: string | null
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { help: false, version: false, doctor: false, name: null }
  const positional: string[] = []
  let nameSpecified = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--name" || arg.startsWith("--name=")) {
      if (nameSpecified) throw new UsageError("--name may be specified only once")
      const value = arg === "--name" ? args[++index] : arg.slice("--name=".length)
      if (value === undefined || value === "") throw new UsageError("--name requires a value")
      try {
        options.name = normalizeFmxName(value)
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error))
      }
      nameSpecified = true
      continue
    }
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true
        break
      case "-v":
      case "--version":
        options.version = true
        break
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`)
        positional.push(arg)
        break
    }
  }

  if (positional.length === 0) return options
  if (positional[0] !== "doctor") {
    throw new UsageError(`unknown command: ${positional[0]}\nCommands: doctor.`)
  }
  if (positional.length > 1) throw new UsageError(`unexpected argument: ${positional[1]}`)
  options.doctor = true
  return options
}

export function usage(): string {
  return `Usage: fmx [--name NAME] [options]
       fmx [--name NAME] doctor

Open or attach a terminal Client for the selected fmx Runtime.
Agent automation is provided by the separate fmx-mcp server.

Options:
      --name NAME  select an independent named fmx
  -h, --help       show this help
  -v, --version    print the version

Commands:
  doctor         verify the Companion, its private directory, and Fx

Configuration:
  ~/.config/fmx/config.toml (or FMX_CONFIG_PATH)
`
}
