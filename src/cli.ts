export const VERSION = "0.1.0"

type CliOptions = {
  initialFxArgs: string[]
  help: boolean
  version: boolean
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    initialFxArgs: [],
    help: false,
    version: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--") {
      options.initialFxArgs = args.slice(index + 1)
      return options
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
        throw new Error(`unknown option: ${arg}\nPass fx arguments after --.`)
    }
  }

  return options
}

export function usage(): string {
  return `fmx ${VERSION} — run multiple fx sessions in one terminal

Usage:
  fmx [options] [-- <fx arguments>]

Options:
  -h, --help     show this help
  -v, --version  show the version

Configuration:
  ~/.config/fmx/config.toml (or FMX_CONFIG_PATH)
`
}
