# fmx

**fmx** /fʌks/ — An orchestration surface for [fx](https://fx.sh/).

Many agents in one terminal: a session list and the active agent. Agents live
in a companion daemon, so they keep running when fmx is not.

## Install

```sh
curl -fsSL https://c1g42cnmuvvspilo.public.blob.vercel-storage.com/setup.sh | bash
```

This installs `fmx`, its companion `fmx-zmx`, and its pinned Fx fork as
`fmx-fx` to `~/.local/bin`. The installer keeps that private copy separate
from any `fx` installed for direct use, and fmx resolves it once when a Runtime
starts. `fmx doctor` reports what an installation has.

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

## Observe

`fmx observe` is the read-only machine interface for sidecars and notification
tools. It prints newline-delimited JSON, beginning with a complete snapshot of
the active Agent and every Agent's stable identity, display number, session
metadata, Git context, lifecycle state, and subagents. Later state records are
also complete, so a consumer can replace its local projection rather than
patching it:

```sh
fmx observe                              # snapshots and state changes
fmx observe --activity                   # plus every accepted ADE event
fmx observe --activity | jq -c 'select(.event == "activity")'
```

Activity is attributed to its stable Agent, main or subagent session, parent
session, turn, and workspace when Fx supplied them. `ade_sequence` is
process-local and `gap_before: true` says fmx did not observe the immediately
preceding sequence. Activity is live-only, never replayed; reconnect for a
fresh state snapshot. Summary mode excludes tool arguments and assistant text.
`--raw-payloads` includes complete ADE payloads, may expose secrets, and
implies `--activity`.

The stream is private to the local user, but even ordinary state includes
workspace paths, terminal labels, and prompt-derived session names. Consumers
that store or forward records own that exposure.

Direct Observers connect to the mode-0600 socket reported as
`fmx.observation_socket` by `fmx control orient` and send one subscription
line before reading:

```json
{"schema_version":1,"topics":["state","activity"],"activity_payload":"summary"}
```

The Runtime then writes schema-1 NDJSON with per-connection
`stream_sequence` and authoritative `state_revision` values. Slow Observers
are disconnected instead of delaying fmx or Fx. An Observer is not a terminal
Client and does not keep the Runtime alive. The complete wire contract is in
[Observation stream schema 1](docs/observation-stream.md).

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
