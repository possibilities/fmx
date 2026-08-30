# fmx

**fmx** /fʌks/ — An orchestration surface for [fx](https://fx.sh/).

Many agents in one terminal: a session list and the active agent. Agents live
in a companion daemon, so they keep running when fmx is not.

## Install

```sh
git clone https://github.com/possibilities/fmx.git
cd fmx
scripts/install.sh --install
```

This links `fmx` and `fmx-mcp` from the checkout and builds its exact pinned
Companion and Fx fork sources as `fmx-zmx` and `fmx-fx`. Fmx publishes no binaries. See the
[source installation guide](docs/source-install.md) for requirements,
automation inputs, and the tested platform boundary. `fmx doctor` reports
what an installation has.

## Usage

`ctrl-b` is the prefix key. `ctrl-b ?` lists every binding.

| | |
|---|---|
| `ctrl-b d` | detach this terminal, leaving every agent running |
| `ctrl-b p` / `ctrl-b n` | switch to the previous / next agent |
| `ctrl-b b` | toggle the tray, or the Agent picker when that view is active |

Configuration is `~/.config/fmx/config.toml`. At least one project root is
required; everything else has a default:

```toml
project_roots = ["~/code", "~/src"]
worktree_root = "~/.fmx/worktrees"
```

Run `fmx` again to attach another terminal to the same UI. The last one to
interact sets the layout size.

Use `--agent-picker` for a full-width Agent selector above the terminal instead
of the Tray:

```sh
fmx --agent-picker
```

The picker lists the switchable Agents newest first, with their Session name,
Project context, and current state. `ctrl-b b` opens it; use the arrow keys and
Enter to select, or Escape to close it.

Add `--hide-single-agent-picker` when one Agent should receive the whole
terminal and the picker should appear only after a second Agent starts:

```sh
fmx --agent-picker --hide-single-agent-picker
```

If the roster returns to one Agent, the picker closes and gives its three rows
back to that Agent.

The view belongs to the shared Runtime for that Home. Plain `fmx` attaches to
whichever view is already running and starts the Tray view when there is no
Runtime. An explicit `fmx --agent-picker` refuses to attach when that Home
already has a Tray Runtime, so it never silently gives a different view than
the one requested. An explicit `--hide-single-agent-picker` likewise refuses a
live picker Runtime that was started without that behavior.

Use `--name` to select an independent named fmx:

```sh
fmx --name review
fmx --name implementation
```

Each name has its own Agents and display numbering, saved UI state, Runtime,
Clients, and private sockets. Running the same name again attaches to that
name's existing Runtime. Every name shares `config.toml`, Fx's profile,
credentials and saved sessions, project roots, repositories, and binaries.
Plain `fmx` and `fmx --name default` select the original default unchanged.

An agent disappears only when it exits — end it from inside, the way you would
at a terminal. `fmx-zmx list`, `attach`, and `kill` reach one by hand.

## MCP

`fmx-mcp` is the stdio MCP server for agent automation. Configure an MCP host
to run that executable; when started inside an Agent it uses that Agent as the
`current` Target, and outside one it connects only when exactly one Runtime is
live.

| Tool | Purpose |
|---|---|
| `get_orientation` | Read the selected named fmx, caller, active Agent, all Agents and subagents, Tray tree, terminal size, and open fmx surface |
| `create_agent` | Create an Agent in a repository, optionally in a new Worktree and with per-process model or effort overrides |
| `focus_agent` | Focus an Agent by stable `agent_id`, `pane_id`, display id, relative Target, Session name, or Session-id prefix |
| `configure_tray` | Read or change the Tray's width and visibility |
| `get_agent_work` | Read Fx's authoritative active turn, paused state, and queued work |
| `queue_agent_work` | Append plain-text work to Fx's native queue |
| `steer_agent` | Steer the active Fx turn, or queue the work when no turn is active |
| `interrupt_agent` | Interrupt active work and pause remaining queued work for inspection |
| `update_queued_work` | Replace the plain text of one queued Turn |
| `delete_queued_work` | Delete one queued Turn |
| `resume_agent_queue` | Resume Fx's paused queue unchanged |

Creation with no directory uses the caller's repository, then the first
configured Project. Work tools default to the caller's Agent and use Fx's
native semantic queue, steer, and interrupt operations—never terminal paste.
There is deliberately no prompt-send, wait, event-stream, permission-answer,
or Runtime-lifecycle surface. See the [agent integration guide](docs/agent-integration.md)
for exact targeting, queue semantics, results, errors, and integration advice.

The mode-0600 [Runtime bridge](docs/runtime-bridge.md) between `fmx-mcp` and a
running Runtime is an implementation detail, not a supported automation API.

## Development

```sh
bun install --frozen-lockfile
bun link                      # ~/.bun/bin/fmx runs this checkout
bun test && bun run typecheck
bun run gallery               # browse UI components and their states
scripts/install-companion.sh  # the pinned companion, into ~/.local/bin
scripts/local-gate.sh         # the only merge gate: this Mac architecture
```

`AGENTS.md` is the working contract, `docs/adr/` the decisions behind it.

## Design

Built the way Derek Sivers is [building his house](https://sive.rs/fit):
defer the decision, add only what proves necessary, pave where the grass
is worn.
