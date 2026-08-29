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
| `ctrl-b b` | toggle the tray |

Configuration is `~/.config/fmx/config.toml`. At least one project root is
required; everything else has a default:

```toml
project_roots = ["~/code", "~/src"]
worktree_root = "~/.fmx/worktrees"
```

Run `fmx` again for the same configuration to attach another terminal to the
same UI. The last one to interact sets the layout size.

An agent disappears only when it exits — end it from inside, the way you would
at a terminal. `fmx-zmx list`, `attach`, and `kill` reach one by hand.

## MCP

`fmx-mcp` is the stdio MCP server for agent automation. Configure an MCP host
to run that executable; when started inside an Agent it uses that Agent as the
`current` Target, and outside one it connects only when exactly one Runtime is
live.

| Tool | Purpose |
|---|---|
| `get_orientation` | Read the caller, active Agent, all Agents and subagents, Tray tree, terminal size, and open fmx surface |
| `focus_agent` | Focus an Agent by stable `agent_id`, `pane_id`, display id, relative Target, Session name, or Session-id prefix |
| `configure_tray` | Read or change the Tray's width and visibility |

The phase-one server deliberately has no Agent creation, prompt injection,
wait, event-stream, or model-catalog surface. Work control will mirror Fx's
native control-socket operations instead of typing into its terminal. The
mode-0600 Runtime Bus remains an implementation bridge between `fmx-mcp` and
the Runtime, not a supported automation interface; its engineering contract is
documented in [Runtime Bus schema 1](docs/runtime-bus.md).

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
