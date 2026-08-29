import packageMetadata from "../package.json" with { type: "json" }

export const VERSION = packageMetadata.version

export type CliOptions = {
  help: boolean
  version: boolean
  /** `fmx doctor`: report the installation instead of running the TUI. */
  doctor: boolean
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { help: false, version: false, doctor: false }
  const positional: string[] = []

  for (const arg of args) {
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
  return `Usage: fmx [options]
       fmx doctor

Open or attach a terminal Client for this Home's fmx Runtime.
Agent automation is provided by the separate fmx-mcp server.

Options:
  -h, --help     show this help
  -v, --version  print the version

Commands:
  doctor         verify the Companion, its private directory, and Fx

Configuration:
  ~/.config/fmx/config.toml (or FMX_CONFIG_PATH)
`
}
