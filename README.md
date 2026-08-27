# fmx

**fmx** /fʌks/ — An orchestration surface for [fx](https://fx.sh/).

Many agents in one terminal: a session list and the active agent. Agents live
in a companion daemon, so they keep running when fmx is not.

## Install

```sh
curl -fsSL https://c1g42cnmuvvspilo.public.blob.vercel-storage.com/setup.sh | bash
```

This installs `fmx` and its companion `fmx-zmx` to `~/.local/bin`. The two are
a pair — fmx refuses to start against any other build — so reinstall both
together. `fx` must be on `PATH` as well; install it from [fx.sh](https://fx.sh/).
`fmx doctor` reports what an installation has.

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

## Agents

`fmx control <command>` drives a running Runtime and prints one JSON object.
Run `fmx control launch` from another terminal to create the first Agent;
inside an Agent, the same command defaults to that Agent's Project.

```sh
fmx control orient                      # where you are and what the interface shows
fmx control launch "write the tests"    # start an agent here, in the background
fmx control agent wait 3 --state done,blocked
fmx control agent send 3 "now run them"
fmx control keys                        # every binding and its command
```

`fmx control` with no arguments prints the rest.

## Development

```sh
bun install --frozen-lockfile
bun link                      # ~/.bun/bin/fmx runs this checkout
bun test && bun run typecheck
bun run gallery               # browse UI components and their states
scripts/install-companion.sh  # the pinned companion, into ~/.local/bin
```

`AGENTS.md` is the working contract, `docs/adr/` the decisions behind it.

## Design

Built the way Derek Sivers is [building his house](https://sive.rs/fit):
defer the decision, add only what proves necessary, pave where the grass
is worn.
