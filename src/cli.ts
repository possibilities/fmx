import packageMetadata from "../package.json" with { type: "json" }

export const VERSION = packageMetadata.version

/** Where a command's text comes from: given inline, read from a file, or
 * piped in. Resolved by the client before anything is sent. */
export type TextSource = { inline: string } | { file: string } | { stdin: true }

export type LaunchFieldArgs = {
  directory?: string
  worktree?: boolean
  prompt?: TextSource
}

export type Command =
  | { name: "orient" }
  | { name: "instance"; verb: "list" }
  | { name: "instance"; verb: "wait"; target: string; states?: string[]; timeoutMs?: number }
  | { name: "instance"; verb: "send"; target: string; text: TextSource }
  | {
      name: "launch"
      fields: LaunchFieldArgs
      focus: boolean
      editable: boolean
      wait: boolean
      timeoutMs?: number
      fxArgs: string[]
    }
  | { name: "draft"; verb: "show"; draft?: string }
  | { name: "draft"; verb: "set"; draft: string; fields: LaunchFieldArgs }
  | { name: "draft"; verb: "submit"; draft: string }
  | { name: "draft"; verb: "cancel"; draft: string }
  | { name: "draft"; verb: "wait"; draft?: string; timeoutMs?: number }
  | { name: "focus"; target: string }
  | { name: "sidebar"; width?: number }
  | { name: "keys"; show: boolean }

export type CliOptions = {
  initialFxArgs: string[]
  help: boolean
  version: boolean
  /** A control command, when the invocation is one rather than the TUI. */
  command: Command | null
  /** `--socket PATH`: which fmx to talk to, for a caller outside any. */
  socket: string | null
}

const COMMAND_NAMES = ["orient", "instance", "launch", "draft", "focus", "sidebar", "keys"] as const
const DRAFT_VERBS = ["show", "set", "submit", "cancel", "wait"] as const
const INSTANCE_VERBS = ["list", "wait", "send"] as const

export class UsageError extends Error {
  constructor(
    message: string,
    readonly topic: string | null = null,
  ) {
    super(message)
    this.name = "UsageError"
  }
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    initialFxArgs: [],
    help: false,
    version: false,
    command: null,
    socket: null,
  }

  const rest: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--") {
      options.initialFxArgs = args.slice(index + 1)
      break
    }
    if (arg === "--socket") {
      const value = args[index + 1]
      if (value === undefined) throw new UsageError("--socket needs a path")
      options.socket = value
      index += 1
      continue
    }
    if (arg.startsWith("--socket=")) {
      options.socket = arg.slice("--socket=".length)
      continue
    }
    if (rest.length === 0) {
      switch (arg) {
        case "-h":
        case "--help":
          options.help = true
          continue
        case "-v":
        case "--version":
          options.version = true
          continue
      }
      if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}\nPass fx arguments after --.`)
    }
    rest.push(arg)
  }

  if (rest.length === 0) return options
  const name = rest[0]!
  if (!isCommandName(name)) {
    throw new UsageError(`unknown command: ${name}\nCommands: ${COMMAND_NAMES.join(", ")}. Pass fx arguments after --.`)
  }
  options.command = parseCommand(name, rest.slice(1), options.initialFxArgs)
  if (name !== "launch") options.initialFxArgs = []
  return options
}

function parseCommand(name: (typeof COMMAND_NAMES)[number], args: string[], fxArgs: string[]): Command {
  switch (name) {
    case "orient":
      rejectExtra(args, "orient")
      return { name: "orient" }
    case "instance":
      return parseInstance(args)
    case "launch":
      return parseLaunch(args, fxArgs)
    case "draft":
      return parseDraft(args)
    case "focus": {
      const flags = parseFlags(args, {}, "focus")
      const target = flags.positional[0]
      if (target === undefined) throw new UsageError("focus needs a target", "focus")
      rejectExtra(flags.positional.slice(1), "focus")
      return { name: "focus", target }
    }
    case "sidebar": {
      const flags = parseFlags(args, { width: "value" }, "sidebar")
      rejectExtra(flags.positional, "sidebar")
      const width = flags.values.width
      return width === undefined ? { name: "sidebar" } : { name: "sidebar", width: integerFlag("--width", width) }
    }
    case "keys": {
      const flags = parseFlags(args, { show: "switch" }, "keys")
      rejectExtra(flags.positional, "keys")
      return { name: "keys", show: flags.switches.has("show") }
    }
  }
}

function parseInstance(args: string[]): Command {
  const verb = args[0]
  if (verb === undefined || !(INSTANCE_VERBS as readonly string[]).includes(verb)) {
    throw new UsageError(verb === undefined ? "instance needs a verb" : `unknown instance verb: ${verb}`, "instance")
  }
  const rest = args.slice(1)
  switch (verb as (typeof INSTANCE_VERBS)[number]) {
    case "list":
      rejectExtra(rest, "instance")
      return { name: "instance", verb: "list" }
    case "wait": {
      const flags = parseFlags(rest, { state: "list", timeout: "value" }, "instance")
      const target = flags.positional[0] ?? "current"
      rejectExtra(flags.positional.slice(1), "instance")
      const command: Command = { name: "instance", verb: "wait", target }
      if (flags.lists.state) command.states = flags.lists.state
      if (flags.values.timeout !== undefined) command.timeoutMs = integerFlag("--timeout", flags.values.timeout)
      return command
    }
    case "send": {
      const flags = parseFlags(rest, { file: "value" }, "instance")
      const target = flags.positional[0]
      if (target === undefined) throw new UsageError("instance send needs a target", "instance")
      const text = textSource(flags.positional[1], flags.values.file, "instance")
      if (!text) throw new UsageError("instance send needs text, --file, or - for stdin", "instance")
      rejectExtra(flags.positional.slice(2), "instance")
      return { name: "instance", verb: "send", target, text }
    }
  }
}

function parseLaunch(args: string[], fxArgs: string[]): Command {
  const flags = parseFlags(
    args,
    {
      project: "value",
      prompt: "value",
      "prompt-file": "value",
      worktree: "switch",
      "no-worktree": "switch",
      focus: "switch",
      editable: "switch",
      wait: "switch",
      timeout: "value",
    },
    "launch",
  )
  const fields = launchFields(flags, "launch")
  rejectExtra(flags.positional.slice(fields.prompt && flags.values.prompt === undefined ? 1 : 0), "launch")
  const command: Command = {
    name: "launch",
    fields,
    focus: flags.switches.has("focus"),
    editable: flags.switches.has("editable"),
    wait: flags.switches.has("wait"),
    fxArgs,
  }
  if (command.wait && !command.editable) throw new UsageError("--wait only applies with --editable", "launch")
  if (flags.values.timeout !== undefined) command.timeoutMs = integerFlag("--timeout", flags.values.timeout)
  return command
}

function parseDraft(args: string[]): Command {
  const verb = args[0]
  if (verb === undefined || !(DRAFT_VERBS as readonly string[]).includes(verb)) {
    throw new UsageError(verb === undefined ? "draft needs a verb" : `unknown draft verb: ${verb}`, "draft")
  }
  const rest = args.slice(1)
  const draftVerb = verb as (typeof DRAFT_VERBS)[number]
  switch (draftVerb) {
    case "show": {
      const flags = parseFlags(rest, {}, "draft")
      rejectExtra(flags.positional.slice(1), "draft")
      const draft = flags.positional[0]
      return draft === undefined ? { name: "draft", verb: "show" } : { name: "draft", verb: "show", draft }
    }
    case "set": {
      const flags = parseFlags(
        rest,
        {
          project: "value",
          prompt: "value",
          "prompt-file": "value",
          worktree: "switch",
          "no-worktree": "switch",
        },
        "draft",
      )
      const draft = flags.positional[0]
      if (draft === undefined) throw new UsageError("draft set needs a draft id", "draft")
      rejectExtra(flags.positional.slice(1), "draft")
      const fields = launchFields({ ...flags, positional: [] }, "draft")
      if (Object.keys(fields).length === 0) throw new UsageError("draft set needs a field to change", "draft")
      return { name: "draft", verb: "set", draft, fields }
    }
    case "submit":
    case "cancel": {
      const flags = parseFlags(rest, {}, "draft")
      const draft = flags.positional[0]
      if (draft === undefined) throw new UsageError(`draft ${draftVerb} needs a draft id`, "draft")
      rejectExtra(flags.positional.slice(1), "draft")
      return { name: "draft", verb: draftVerb, draft }
    }
    case "wait": {
      const flags = parseFlags(rest, { timeout: "value" }, "draft")
      rejectExtra(flags.positional.slice(1), "draft")
      const command: Command = { name: "draft", verb: "wait" }
      if (flags.positional[0] !== undefined) command.draft = flags.positional[0]
      if (flags.values.timeout !== undefined) command.timeoutMs = integerFlag("--timeout", flags.values.timeout)
      return command
    }
  }
}

function launchFields(flags: ParsedFlags, topic: string): LaunchFieldArgs {
  const fields: LaunchFieldArgs = {}
  if (flags.values.project !== undefined) fields.directory = flags.values.project
  if (flags.switches.has("worktree") && flags.switches.has("no-worktree")) {
    throw new UsageError("--worktree and --no-worktree contradict", topic)
  }
  if (flags.switches.has("worktree")) fields.worktree = true
  if (flags.switches.has("no-worktree")) fields.worktree = false
  const prompt = textSource(flags.values.prompt ?? flags.positional[0], flags.values["prompt-file"], topic)
  if (prompt) fields.prompt = prompt
  return fields
}

function textSource(inline: string | undefined, file: string | undefined, topic: string): TextSource | null {
  if (inline !== undefined && file !== undefined) throw new UsageError("give text inline or with --prompt-file, not both", topic)
  if (file !== undefined) return { file }
  if (inline === "-") return { stdin: true }
  if (inline !== undefined) return { inline }
  return null
}

type FlagKind = "switch" | "value" | "list"
type ParsedFlags = {
  positional: string[]
  switches: Set<string>
  values: Record<string, string>
  lists: Record<string, string[]>
}

function parseFlags(args: string[], spec: Record<string, FlagKind>, topic: string): ParsedFlags {
  const parsed: ParsedFlags = { positional: [], switches: new Set(), values: {}, lists: {} }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "-" || !arg.startsWith("--")) {
      parsed.positional.push(arg)
      continue
    }
    const equals = arg.indexOf("=")
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
    const kind = spec[name]
    if (!kind) throw new UsageError(`unknown option: ${arg}`, topic)
    if (kind === "switch") {
      if (equals !== -1) throw new UsageError(`--${name} takes no value`, topic)
      parsed.switches.add(name)
      continue
    }
    let value: string | undefined
    if (equals !== -1) value = arg.slice(equals + 1)
    else {
      value = args[index + 1]
      index += 1
    }
    if (value === undefined) throw new UsageError(`--${name} needs a value`, topic)
    if (kind === "value") parsed.values[name] = value
    else {
      const list = parsed.lists[name] ?? []
      list.push(...value.split(",").map((item) => item.trim()).filter(Boolean))
      parsed.lists[name] = list
    }
  }
  return parsed
}

function integerFlag(flag: string, raw: string): number {
  if (!/^\d+$/u.test(raw)) throw new UsageError(`${flag} must be a whole number`)
  return Number(raw)
}

function rejectExtra(args: string[], topic: string): void {
  if (args.length > 0) throw new UsageError(`unexpected argument: ${args[0]}`, topic)
}

function isCommandName(value: string): value is (typeof COMMAND_NAMES)[number] {
  return (COMMAND_NAMES as readonly string[]).includes(value)
}

export function usage(topic: string | null = null): string {
  switch (topic) {
    case "launch":
      return LAUNCH_USAGE
    case "draft":
      return DRAFT_USAGE
    case "instance":
      return INSTANCE_USAGE
    case "focus":
      return "Usage: fmx focus <target>\n\n  target: instance id, slug, session-id prefix, next, previous, current\n"
    case "sidebar":
      return "Usage: fmx sidebar [--width N]\n"
    case "keys":
      return "Usage: fmx keys [--show]\n\n  --show  open the keys modal in the running fmx as well\n"
  }
  return `fmx ${VERSION} — run multiple fx sessions in one terminal

Usage:
  fmx [options] [-- <fx arguments>]      start fmx
  fmx <command> [args]                   drive a running fmx from inside it

Options:
  -h, --help     show this help
  -v, --version  show the version

Commands (each prints one JSON object):
  orient                       where you are and what the interface shows
  launch [prompt] [flags]      start an agent; --editable opens the dialog instead
  draft show|set|submit|cancel|wait [id]
                               an open dialog an agent can finish or hand over
  focus <target>               switch to an instance (next, previous, id, slug)
  instance list|wait|send      read, wait on, or type into instances
  sidebar [--width N]          the session list's width
  keys [--show]                the keybindings and their command equivalents

  --socket PATH                talk to a specific fmx (default: FMX_SOCKET_PATH)
  fmx <command> with no args prints that command's usage.

Exit status: 0 ok · 1 refused · 2 usage · 3 no fmx reachable · 4 timed out

Configuration:
  ~/.config/fmx/config.toml (or FMX_CONFIG_PATH)
`
}

const LAUNCH_USAGE = `Usage: fmx launch [prompt] [flags] [-- <fx arguments>]

  --project DIR        directory to start in (default: your own)
  --worktree           cut a fresh worktree of the project first
  --prompt TEXT        the prompt to start on; a bare positional works too
  --prompt-file PATH   read the prompt from a file; --prompt - reads stdin
  --focus              switch the screen to the new instance
  --editable           open the launch dialog prefilled instead of starting;
                       prints the draft id. Omitted fields keep their defaults.
  --wait               with --editable, block until the draft resolves
  --timeout MS         with --wait, give up after MS (exit 4)
`

const DRAFT_USAGE = `Usage: fmx draft <verb> [id] [flags]

  show [id]            fields and status (default: the open draft)
  set <id> [flags]     change fields: --prompt, --prompt-file, --project,
                       --worktree, --no-worktree
  submit <id>          launch it; prints the instance started
  cancel <id>          close it without launching
  wait [id] [--timeout MS]
                       block until a human or agent resolves it
`

const INSTANCE_USAGE = `Usage: fmx instance <verb> [args]

  list                             every instance, as the sidebar knows it
  wait [target] [--state S,...] [--timeout MS]
                                   block until the instance reaches a state
                                   (default target: current;
                                    default states: idle,done,blocked)
  send <target> <text|-> [--file PATH]
                                   paste text into the instance and send it
`
