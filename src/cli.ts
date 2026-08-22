import packageMetadata from "../package.json" with { type: "json" }

export const VERSION = packageMetadata.version

type CliOptions = {
  help: boolean
  version: boolean
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    version: false,
  }

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
        throw new Error(`unknown option: ${arg}`)
    }
  }

  return options
}

export function usage(): string {
  return `fmx ${VERSION} — run multiple fx sessions in one terminal

Usage:
  fmx [options]

Options:
  -h, --help     show this help
  -v, --version  show the version

Configuration:
  ~/.config/fmx/config.toml (or FMX_CONFIG_PATH)
`
}
