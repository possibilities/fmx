# fmx

**fmx** /fʌks/ — A terminal multiplexer driven over a socket.

Start it, stop it, and attach a terminal to it from the command line.
Everything else — what runs, where it sits on screen, what has the keyboard —
is an API for programs. Each Session lives in a companion daemon, so it keeps
running when fmx is not.

## Install

```sh
git clone https://github.com/possibilities/fmx.git
cd fmx
scripts/install.sh --install
```

This links `fmx` from the checkout and builds its exact pinned Companion
source as `fmx-zmx`. Fmx publishes no binaries. See the
[source installation guide](docs/source-install.md) for requirements and the
tested platform boundary. `fmx doctor` reports what an installation has.

## Use

```sh
fmx start            # start the Instance without attaching; prints its API socket
fmx                  # start it if needed, then attach this terminal
fmx attach           # attach this terminal to a running Instance
fmx status           # the Instance as JSON
fmx stop             # end every Session and the Instance
fmx api              # the API contract as JSON
```

`--name NAME` selects an independent Instance; several run side by side and
share nothing but the config file.

`ctrl-b d` detaches this terminal, leaving every Session running. That is the
only chord fmx claims: the prefix is a latch the attached terminal holds until
the next key proves it is not Detach, and every other key, the prefix
included, reaches the focused Session unchanged.

## Drive it

Everything past start, stop, and attach is the API: one JSON object per line
on the socket that `fmx start` and `fmx status` report.

```
{"v":1,"type":"request","id":"1","method":"session.create","params":{"name":"reviewer","argv":["claude"],"cwd":"/Users/you/code/fmx"}}
{"v":1,"type":"request","id":"2","method":"layout.apply","params":{"root":{"row":[{"session":"tray","size":26},{"session":"reviewer"}]},"focus":"reviewer"}}
{"v":1,"type":"request","id":"3","method":"events.subscribe"}
```

The methods are `instance.status`, `instance.stop`, `events.subscribe`,
`session.create`, `session.kill`, `session.list`, `session.capture`,
`layout.apply`, and `layout.get`. The events are `session.exited`,
`session.changed`, `layout.changed`, `stage.changed`, `theme.changed`, and
`instance.stopping`. The full reference is [docs/api.md](docs/api.md), and
`fmx api` prints the same contract as JSON Schema.

There is deliberately no way to type into a Session over the API, no MCP
surface, and no byte-level observation: `session.changed` tells you a screen
moved and `session.capture` reads it.

## The model

An **Instance** is one running fmx: a Runtime, its Sessions, and one Layout.

A **Session** is a command in a Companion-held PTY, named by its caller. It
runs whether or not a Pane shows it, and it outlives the Runtime — the
Companion holds it, labelled with the Instance's id, and the next Runtime
adopts it. fmx stores nothing of its own.

The **Layout** is a tree of rows and columns whose leaves are **Panes**, each
showing one Session or one line of text. Sizes live in the tree, so resizing
is applying a tree with a different size. Every boundary between siblings is
a divider a human can drag, and a drag moves the Layout's revision on, so a
caller writing from a stale read is refused rather than undoing the gesture.

The **Stage** is the drawn area. Several terminals can attach at once; the
one that interacted most recently sets the size, larger ones have flat unused
space, and smaller ones crop.

## Configure

One shared file, `~/.config/fmx/config.toml` (or `FMX_CONFIG_PATH`), read by
every Instance. It holds the two keys fmx claims and nothing else:

```toml
[keys]
prefix = "ctrl+b"
detach = "prefix+d"
```

`FMX_THEME` fixes the palette to `dark` or `light`; otherwise fmx asks the
attached terminal for its background and follows it.

A Session ends only when its process does. `fmx-zmx list`, `attach`, and
`kill` reach one by hand.

## Development

```sh
bun install --frozen-lockfile
bun link                      # ~/.bun/bin/fmx runs this checkout
bun test && bun run typecheck
scripts/install-companion.sh  # the pinned companion, into ~/.local/bin
scripts/local-gate.sh         # the only merge gate: this Mac architecture
```

`AGENTS.md` is the working contract, `CONTEXT.md` the glossary, and
`docs/adr/` the decisions behind them.

## Design

Built the way Derek Sivers is [building his house](https://sive.rs/fit):
defer the decision, add only what proves necessary, pave where the grass
is worn.
