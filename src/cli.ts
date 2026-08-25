import packageMetadata from "../package.json" with { type: "json" }

export const VERSION = packageMetadata.version

/** Where a command's text comes from: given inline, read from a file, or
 * piped in. Resolved by the client before anything is sent. */
export type TextSource = { inline: string } | { file: string } | { stdin: true }

export type LaunchFieldArgs = {
  directory?: string
  worktree?: boolean
  prompt?: TextSource
  model?: string
  effort?: string
}

export type Command =
  | { name: "orient" }
  | { name: "agent"; verb: "list" }
  | { name: "agent"; verb: "wait"; target: string; states?: string[]; timeoutMs?: number }
  | { name: "agent"; verb: "send"; target: string; text: TextSource }
  | {
      name: "launch"
      fields: LaunchFieldArgs
      focus: boolean
      editable: boolean
      wait: boolean
      timeoutMs?: number
    }
  | { name: "draft"; verb: "show"; draft?: string }
  | { name: "draft"; verb: "set"; draft: string; fields: LaunchFieldArgs }
  | { name: "draft"; verb: "submit"; draft: string }
  | { name: "draft"; verb: "cancel"; draft: string }
  | { name: "draft"; verb: "wait"; draft?: string; timeoutMs?: number }
  | { name: "focus"; target: string }
  | { name: "tray"; width?: number; hidden?: boolean; toggle?: boolean }
  | { name: "keys"; show: boolean }
  | { name: "catalog" }

export type CliOptions = {
  help: boolean
  version: boolean
  /** `fmx doctor`: report the installation instead of running. */
  doctor: boolean
  /** A control command, when the invocation is one rather than the TUI. */
  command: Command | null
  /** `--socket PATH`: which fmx to talk to, for a caller outside any. */
  socket: string | null
}

/** Every control command lives under `fmx control`, leaving the top level
 * free for concerns that are not about driving a running fmx. */
const CONTROL_GROUP = "control"
/** The one other top-level command: a report on the installation, never a running fmx. */
const DOCTOR_COMMAND = "doctor"
const COMMAND_NAMES = ["orient", "agent", "launch", "draft", "focus", "tray", "keys", "catalog"] as const
const DRAFT_VERBS = ["show", "set", "submit", "cancel", "wait"] as const
const AGENT_VERBS = ["list", "wait", "send"] as const

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
    help: false,
    version: false,
    doctor: false,
    command: null,
    socket: null,
  }

  const rest: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
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
      if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`)
    }
    rest.push(arg)
  }

  if (rest.length === 0) return options
  if (rest[0] === DOCTOR_COMMAND) {
    rejectExtra(rest.slice(1), DOCTOR_COMMAND)
    options.doctor = true
    return options
  }
  if (rest[0] !== CONTROL_GROUP) {
    throw new UsageError(`unknown command: ${rest[0]}\nCommands: ${CONTROL_GROUP}, ${DOCTOR_COMMAND}.`)
  }
  const name = rest[1]
  if (name === undefined) throw new UsageError("control needs a command", CONTROL_GROUP)
  if (!isCommandName(name)) {
    throw new UsageError(`unknown control command: ${name}\nCommands: ${COMMAND_NAMES.join(", ")}.`, CONTROL_GROUP)
  }
  options.command = parseCommand(name, rest.slice(2))
  return options
}

function parseCommand(name: (typeof COMMAND_NAMES)[number], args: string[]): Command {
  switch (name) {
    case "orient":
      rejectExtra(args, "orient")
      return { name: "orient" }
    case "agent":
      return parseAgent(args)
    case "launch":
      return parseLaunch(args)
    case "draft":
      return parseDraft(args)
    case "focus": {
      const flags = parseFlags(args, {}, "focus")
      const target = flags.positional[0]
      if (target === undefined) throw new UsageError("focus needs a target", "focus")
      rejectExtra(flags.positional.slice(1), "focus")
      return { name: "focus", target }
    }
    case "tray": {
      const flags = parseFlags(args, { width: "value", show: "switch", hide: "switch", toggle: "switch" }, "tray")
      rejectExtra(flags.positional, "tray")
      const visibility = ["show", "hide", "toggle"].filter((flag) => flags.switches.has(flag))
      if (visibility.length > 1) throw new UsageError("--show, --hide, and --toggle contradict", "tray")
      const command: Command = { name: "tray" }
      if (flags.values.width !== undefined) command.width = integerFlag("--width", flags.values.width)
      if (flags.switches.has("show")) command.hidden = false
      if (flags.switches.has("hide")) command.hidden = true
      if (flags.switches.has("toggle")) command.toggle = true
      return command
    }
    case "keys": {
      const flags = parseFlags(args, { show: "switch" }, "keys")
      rejectExtra(flags.positional, "keys")
      return { name: "keys", show: flags.switches.has("show") }
    }
    case "catalog":
      rejectExtra(args, "catalog")
      return { name: "catalog" }
  }
}

function parseAgent(args: string[]): Command {
  const verb = args[0]
  if (verb === undefined || !(AGENT_VERBS as readonly string[]).includes(verb)) {
    throw new UsageError(verb === undefined ? "agent needs a verb" : `unknown agent verb: ${verb}`, "agent")
  }
  const rest = args.slice(1)
  switch (verb as (typeof AGENT_VERBS)[number]) {
    case "list":
      rejectExtra(rest, "agent")
      return { name: "agent", verb: "list" }
    case "wait": {
      const flags = parseFlags(rest, { state: "list", timeout: "value" }, "agent")
      const target = flags.positional[0] ?? "current"
      rejectExtra(flags.positional.slice(1), "agent")
      const command: Command = { name: "agent", verb: "wait", target }
      if (flags.lists.state) command.states = flags.lists.state
      if (flags.values.timeout !== undefined) command.timeoutMs = integerFlag("--timeout", flags.values.timeout)
      return command
    }
    case "send": {
      const flags = parseFlags(rest, { file: "value" }, "agent")
      const target = flags.positional[0]
      if (target === undefined) throw new UsageError("agent send needs a target", "agent")
      const text = textSource(flags.positional[1], flags.values.file, "agent")
      if (!text) throw new UsageError("agent send needs text, --file, or - for stdin", "agent")
      rejectExtra(flags.positional.slice(2), "agent")
      return { name: "agent", verb: "send", target, text }
    }
  }
}

function parseLaunch(args: string[]): Command {
  const flags = parseFlags(
    args,
    {
      project: "value",
      prompt: "value",
      "prompt-file": "value",
      worktree: "switch",
      "no-worktree": "switch",
      model: "value",
      effort: "value",
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
          model: "value",
          effort: "value",
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
  if (flags.values.model !== undefined) fields.model = flags.values.model
  if (flags.values.effort !== undefined) fields.effort = flags.values.effort
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
    case "control":
      return CONTROL_USAGE
    case "launch":
      return LAUNCH_USAGE
    case "draft":
      return DRAFT_USAGE
    case "agent":
      return AGENT_USAGE
    case "focus":
      return "Usage: fmx control focus <target>\n\n  target: agent id, exact session name, session-id prefix, next, previous, current\n"
    case "tray":
      return "Usage: fmx control tray [--width N] [--show | --hide | --toggle]\n"
    case "keys":
      return "Usage: fmx control keys [--show]\n\n  --show  open the keys modal in the running Runtime as well\n"
  }
  return `fmx ${VERSION} — run multiple fx sessions in one terminal

Usage:
  fmx [options]
  fmx control <command> [args]           drive a running fmx Runtime from inside it
  fmx doctor                             report the installation

Options:
  -h, --help     show this help
  -v, --version  show the version

Commands:
  control        shared UI actions for agents; see fmx control
  doctor         versions, the companion and whether it is the one this fmx
                 was released with, its directory, and fx; exits 1 when the
                 companion is missing, not that build, or its directory is
                 not fmx's own; fx, and a build FMX_ZMX_PATH named, are
                 reported, never judged

Configuration:
  ~/.config/fmx/config.toml (or FMX_CONFIG_PATH)
`
}

const CONTROL_USAGE = `Usage: fmx control <command> [args]

Each command prints one JSON object.

  orient                       where you are and what the interface shows
  launch [prompt] [flags]      start an agent; --editable opens the dialog instead
  draft show|set|submit|cancel|wait [id]
                               an open dialog an agent can finish or hand over
  focus <target>               switch to an agent (next, previous, id, session name)
  agent list|wait|send      read, wait on, or type into agents
  tray [--width N] [--show|--hide|--toggle]
                               the session list's width and visibility
  keys [--show]                the keybindings and their command equivalents
  catalog                      the models and efforts the launch dialog offers

  --socket PATH                talk to a specific fmx (default: FMX_SOCKET_PATH)
  fmx control <command> with no arguments prints that command's usage.

Exit status: 0 ok · 1 refused · 2 usage · 3 no fmx reachable · 4 timed out
`

const LAUNCH_USAGE = `Usage: fmx control launch [prompt] [flags]

  --project DIR        repository to start in (default: your own, else the
                       first project on offer)
  --worktree           cut a fresh worktree of the project first
  --model ID           Codex model for this agent
  --effort LEVEL       reasoning effort for this agent
  --prompt TEXT        the prompt to start on; a bare positional works too
  --prompt-file PATH   read the prompt from a file; --prompt - reads stdin
  --focus              switch the screen to the new agent
  --editable           open the launch dialog prefilled instead of starting;
                       prints the draft id. Omitted fields keep their defaults.
  --wait               with --editable, block until the draft resolves
  --timeout MS         with --wait, give up after MS (exit 4)
`

const DRAFT_USAGE = `Usage: fmx control draft <verb> [id] [flags]

  show [id]            fields and status (default: the open draft)
  set <id> [flags]     change fields: --prompt, --prompt-file, --project,
                       --worktree, --no-worktree, --model, --effort
  submit <id>          launch it; prints the agent started
  cancel <id>          close it without launching
  wait [id] [--timeout MS]
                       block until a human or agent resolves it
`

const AGENT_USAGE = `Usage: fmx control agent <verb> [args]

  list                             every agent, as the tray knows it
  wait [target] [--state S,...] [--timeout MS]
                                   block until the agent reaches a state
                                   (default target: current;
                                    default states: idle,done,blocked)
  send <target> <text|-> [--file PATH]
                                   paste text into the agent and send it
`
