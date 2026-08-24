# fmx

**fmx** /fʌks/ — An orchestration surface for [fx](https://fx.sh/).

## Install

Install the native binary from the public Vercel Blob store:

```sh
curl -fsSL https://c1g42cnmuvvspilo.public.blob.vercel-storage.com/setup.sh | bash
```

The installer selects Linux or macOS and x86_64 or arm64, verifies the
archive's SHA-256 checksum, and installs `fmx` and its companion `fmx-zmx`
to `~/.local/bin`. Set `FMX_INSTALL_DIR` to use another directory, or
`FMX_VERSION` to install a specific release. `fmx doctor` reports what an
installation has: the versions, the companion and whether it is the build
this fmx was released with, its directory, and `fx`.

`fx` must also be on `PATH`; install it from [fx.sh](https://fx.sh/).

The two executables are a pair: each fmx release is built with one exact
companion, and fmx refuses to start against any other it finds beside itself
or on `PATH` — reinstalling restores the pair. Agents running through a
companion keep running through an update; start a new fmx afterwards.

## Usage

`ctrl-b` is the prefix key; `ctrl-b ?` lists the bindings and `ctrl-b d`
detaches this terminal Client, leaving every agent running. Rebind them in
`~/.config/fmx/config.toml` in the `[keys]` table.

fmx opens without an agent. `ctrl-b c` starts one in the first configured
project root, and `ctrl-b l` opens the launch
dialog instead, which asks what to start it with: a prompt, a project, and
whether to cut a fresh worktree for it, plus a Codex model and reasoning
effort. `tab` moves between the rows and enter starts the agent.

On the project, model, and effort rows a letter cycles to the next value that
begins with it, and space opens a picker that filters as you type. Projects
are listed most-recently-worked-in first. On the worktree row space toggles,
and `y` and `n` say it outright. The model picker uses fmx's local Codex
catalog; changing models keeps the selected effort when the new model supports
it and otherwise returns to that model's default.

The prompt is a real editor: multiline, with readline keys (word motions,
kills, selection, undo), a kill ring on `ctrl-y` and `alt-y`, and `ctrl-g` to
write it in `$EDITOR`. Enter moves to the next row; `shift-enter` and `ctrl-j`
make a newline. It is pasted into the agent once it is up, so the session
starts already working on it. A worktree is branched from whatever the project has checked
out, named `<project>-<ordinal>` — `fmx-1`, `fmx-2` — and checked out under
`worktree_root`:

```toml
worktree_root = "~/.fmx/worktrees"
```

The dialog offers each directory named by `project_roots` and the directories
one level under it. At least one root is required:

```toml
project_roots = ["~/code", "~/src"]
```

With no roots configured fmx exits 1 and names this setting and the config
file that needs it. The first root is fmx's default working directory, including
for agents started with `ctrl-b c`.

### Multiple Clients

Running `fmx` again for the same configuration Home attaches another terminal
to the same shared UI. The last Client to connect, type, click, paste, or
resize is the **sizing owner**, and fmx lays out naturally at that terminal's
dimensions. A larger observing terminal shows blank unused space to the right
and below that area; a smaller one sees the right or bottom cropped until it
interacts and becomes the sizing owner. There is no separate scroll or viewport for the
cropped area.

The renderer and Multiplexer live once in a Companion-held Runtime, so every
Client sees the same active Agent, dialogs, Tools, and input. `ctrl-b d` is
local to the Client that pressed it, as is closing that terminal. The Runtime
ends after its final Client leaves; Agents and persistent Tools remain in the
Companion for the next Runtime.

### tools panel

The tools panel is a resizable dock on the right for terminal tools that belong
to the Agent in the center. It starts hidden; `ctrl-b r` toggles it and
`ctrl-b o` hands keyboard focus between the Agent and its selected tool.
When several tools are configured, a one-line link rail switches between them;
`ctrl-b [` and `ctrl-b ]` select the previous and next link. Switching Agents
switches the tools to that Agent's directory and identity too.

Configure tools as argv arrays — no shell evaluates them:

```toml
[[panels]]
id = "diff"
label = "Diff"
command = ["hunk", "diff", "--watch"]
# persistent = true  # the default

[[panels]]
id = "tests"
label = "Tests"
command = ["bun", "test", "--watch"]
persistent = false
```

The panel exists only when at least one tool is configured. Its visibility,
width, and selected link are kept in `state.json`, just like the Session list's
visibility and width.
Persistent tools run in Companion-owned terminals: the final Detach leaves
them running, and the next Runtime attaches to the same terminal. A
non-persistent tool belongs to the current Runtime; its final Client leaving
ends it, and the next Runtime starts it naturally when its link is shown
again. Hiding the dock or switching links does not end a tool during the
current Runtime.

### Agents outlive fmx

An agent is not the Runtime's process. fmx hands each one to a bundled
companion daemon that owns the agent and its terminal, so the final Client
closing — or the Runtime being lost to a crash or signal — leaves every agent
running exactly where it was. The next Runtime for the same configuration
directory finds them, numbered as they were, with their screens restored,
their last reported status intact, and the last focused agent still selected.
It picks up where the last one left off.
Subagent status is re-read from fx's own records. An agent disappears only
when it exits; with the last one gone fmx shows its empty state, and `ctrl-c`
twice there closes the Runtime. `ctrl-b d` detaches one Client at any time. There is no key
to close an agent: end it from inside, the way you would at a terminal.

One Runtime runs per configuration directory at a time; any number of fmx
Clients may attach to it.

#### Recovering agents by hand

The companion is a terminal session daemon in its own right, and its command
line reaches the agents directly when fmx cannot — to look at one from a
plain terminal, or to end one fmx no longer shows:

```sh
fmx-zmx list                     # every Runtime, Agent, or persistent tool
fmx-zmx attach fmx-<id>          # the agent's terminal, as it stands (ctrl-\ detaches)
fmx-zmx kill fmx-<id>            # end an agent
```

Names are `fmx-` followed by the agent's id, as `fmx-zmx list` shows them.
Persistent tools panel terminals have opaque `fmxp-...` names in the same list;
the Runtime has an `fmxr-...` name. Use the exact name shown to attach to or
end one by hand.
The companion keeps its sessions in its own directory, `/tmp/fmx-<uid>/zmx`,
private to the user and separate from any zmx of your own, so these commands
need no configuration and never touch your own sessions. A `zmx` you have
installed does not see them either.

### Session names

An agent is listed by its session id until fx gives the session a native name.
Fx starts its small naming request alongside the first submitted prompt,
persists the result through the same path as `/rename`, and publishes the
committed change over its ADE event feed. fmx updates the tray immediately and
re-reads `~/.fx/sessions/<id>/display.json` when it attaches or detects an
event-sequence gap. fmx never reads prompt logs, runs a naming agent, stores a
second name, or handles the provider credential.

Naming models, effort, timeout, and provider opt-in belong to fx's profile
settings in `~/.fx/settings.json`. Codex defaults to `gpt-5.4-mini` at low
effort; other providers require an explicit fx setting. A manual `/rename`
uses the same native authority and supersedes work still in flight. Names are
not made unique: two exact matches make a control target ambiguous, just as
two matching session-id prefixes do.

## Agents

Shared UI actions have commands, so an agent running inside fmx can drive the
Runtime and read what a hand can see. Detach is deliberately Client-local and
has no control command. `fmx control <command>` talks to
the fmx it is running in (over `FMX_SOCKET_PATH`, which every agent is started with)
and prints one JSON object; from outside, `--socket PATH` names one, or the
only Runtime running is used. Exit status: `0` ok, `1` refused, `2` usage, `3` no
fmx reachable, `4` timed out.

```sh
fmx control orient                      # where you are and what the interface shows
fmx control launch "write the tests"    # start an agent here, in the background
fmx control launch --project ~/code/x --worktree --model gpt-5.6-luna --effort max --focus
fmx control launch --editable --project ~/code/x --worktree   # open the dialog, prefilled
fmx control draft show|set|submit|cancel|wait [id]
fmx control focus next|previous|3|"<session name>"
fmx control agent list
fmx control agent wait 3 --state done,blocked --timeout 600000
fmx control agent send 3 "now run them"
fmx control tray --width 30 --hide       # or --show, --toggle
fmx control panel --show --select diff --focus panel
fmx control panel --width 40 --next         # also --previous, --hide, --toggle
fmx control keys                        # every binding and the command it stands for
fmx control catalog                     # the models and efforts the dialog offers
```

`orient` answers with `you` — the caller's own agent: directory, project,
branch, native session name, state, its subagents, and whether it is the one on screen — alongside every
agent, the tray's rows as they are drawn, the tools panel's availability,
links, selection, size, visibility, and focus owner, and whatever surface is open.
Reading never marks an agent seen; `focus` does, as clicking its row does.
Subagents recorded by fx appear as non-selectable status rows nested beneath
their parent agent, in both the tray and `orient`.

`launch` without `--editable` starts the agent and answers with its agent.
It does not take the screen unless `--focus` is given: an agent starting
workers should not keep stealing the human's view. With `--editable` it opens
the launch dialog instead, prefilled with whatever was given — a project but no
prompt, say — and answers with a **draft** id. Fields left out keep the
dialog's defaults. The human finishes it as usual, or the agent reads it back
with `draft show`, amends it with `draft set`, and closes it with `draft
submit` or `draft cancel`; `draft wait` (or `launch --editable --wait`) blocks
until either has happened and says what came of it. A dialog the human opened
is a draft too, so an agent can finish one as well as start one.

`agent wait` blocks until an agent reaches a state — by default any that
needs someone: `idle`, `done`, or `blocked`. A prompt that has gone in but not
yet been picked up holds the wait, so waiting right after `launch` or `send`
means waiting for the work, not for the startup idle. `done` is `idle` that
nobody has looked at since; an agent on screen is always seen.

## Development

Development and machine provisioning should use an editable checkout, never
the platform release above:

```sh
bun install --frozen-lockfile
bun link  # ~/.bun/bin/fmx runs this checkout's src/index.ts
bun test
bun run typecheck
bun run gallery        # browse UI components and their states in a TUI
bun run gallery:check  # render and assert the same catalog headlessly
bun run test:pty  # requires a host that permits PTY allocation, and the companion
```

The UI gallery is an executable catalog of fmx's interesting OpenTUI
components and blocks. Up/down chooses a component, while left/right follows
the catalog in order, crossing into the previous or next component rather than
wrapping inside one group. `t` toggles the entire gallery between dark and
light without changing either selection. On a state that benefits from live
input, Enter hands its real keys and mouse controls to the component and Escape
returns to gallery navigation. Press `s` for a looping slideshow of all states
in catalog order; Space pauses or resumes, left/right steps across component boundaries,
and Escape returns to browsing. The theme remains independently toggleable
throughout. Page up/page down scrolls a large frame, `[`/`]` pans it
horizontally, and `q` closes the gallery. States use deterministic transports
and palettes, so the interactive gallery and the headless check exercise the
same states under both themes.

Running fmx from a checkout needs the companion daemon, which a release
bundles as `fmx-zmx`. A linked checkout finds it on `PATH`:

```sh
scripts/install-companion.sh  # builds the pinned companion into ~/.local/bin/fmx-zmx
```

It builds exactly the commit `companion.json` pins — from `~/src/zmx` when
that checkout has the commit, else fetched — and is a no-op while the
installed one already reports the pinned build; rerun it after the pin moves
(`FMX_COMPANION_INSTALL_DIR` chooses another directory). Developing the fork
itself is the other way round: point `FMX_ZMX_PATH` at your own build
(`zig build` in the fork, then `zig-out/bin/zmx`). A build named that way
may be any build — fmx says so at start when it is not the pinned one —
where a companion found beside fmx or on `PATH` must be the pinned build
exactly. `test:pty` and the Companion tests read `FMX_ZMX_PATH`, else
`fmx-zmx` on `PATH`, and skip without either.

### The companion pin

`companion.json` names the fork commit a release is built from and the build
string a companion built from it reports (`fmx-zmx version`, first line:
`<fork version>+fmx.<12 hex of the commit>`). `scripts/build-companion.sh`
builds exactly that commit — through a detached worktree of
`FMX_COMPANION_CHECKOUT` (default `~/src/zmx`) when that repository has it,
else a shallow fetch from the pin's repository — with `zig build -Dcompanion
-Doptimize=ReleaseFast -Dversion=<build>`, and proves the binary reports the
build. `scripts/build-release.sh <platform>` uses it for the platform's
baseline target and ships the result beside fmx in both archives; releases
are built by the GitHub workflow on four native runners, each given the
pinned Zig by `scripts/ci-install-zig.sh`. To move the pin: land the fork
change on `integration` and push it, put the new commit and build string in
`companion.json` (zmax's `scripts/pin-companion.sh` does this, proven), re-check
the companion's notices in `THIRD_PARTY_NOTICES.md` against the fork's
dependencies, and release both together.
