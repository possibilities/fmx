import { resolve } from "node:path"

export const VERSION = "0.1.0"

export type CliOptions = {
  cwd: string
  initialFxArgs: string[]
  maxScrollback: number
  help: boolean
  version: boolean
}

const DEFAULT_SCROLLBACK = 10_000_000
const MAX_SCROLLBACK = 0xffff_ffff

export function parseArgs(args: string[], currentDirectory = process.cwd()): CliOptions {
  const options: CliOptions = {
    cwd: resolve(currentDirectory),
    initialFxArgs: [],
    maxScrollback: DEFAULT_SCROLLBACK,
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
      case "-C":
      case "--cwd":
        options.cwd = resolve(currentDirectory, requiredValue(args, ++index, arg))
        break
      case "--scrollback": {
        const raw = requiredValue(args, ++index, arg)
        const value = Number(raw)
        if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SCROLLBACK) {
          throw new Error(`${arg} must be an integer between 0 and ${MAX_SCROLLBACK}`)
        }
        options.maxScrollback = value
        break
      }
      default:
        throw new Error(`unknown option: ${arg}\nPass fx arguments after --.`)
    }
  }

  return options
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index]
  if (!value) throw new Error(`${option} requires a value`)
  return value
}

export function usage(): string {
  return `fmx ${VERSION} — run multiple fx sessions in one terminal

Usage:
  fmx [options] [-- <fx arguments>]

Options:
  -C, --cwd PATH        workspace for new instances
  --scrollback BYTES    scrollback retained per instance (default: ${DEFAULT_SCROLLBACK})
  -h, --help            show this help
  -v, --version         show the version

Configuration:
  ~/.config/fmx/config.toml (or FMX_CONFIG_PATH)
`
}
