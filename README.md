# fmx

**fmx** /fʌks/ — An orchestration surface for [fx](https://fx.sh/).

## Install

Install the native binary from the public Vercel Blob store:

```sh
curl -fsSL https://c1g42cnmuvvspilo.public.blob.vercel-storage.com/setup.sh | bash
```

The installer selects Linux or macOS and x86_64 or arm64, verifies the
archive's SHA-256 checksum, and installs to `~/.local/bin/fmx`. Set
`FMX_INSTALL_DIR` to use another directory, or `FMX_VERSION` to install a
specific release.

`fx` must also be on `PATH`; install it from [fx.sh](https://fx.sh/).

## Usage

`ctrl-b` is the prefix key; `ctrl-b ?` lists the bindings. Rebind them in `~/.config/fmx/config.toml` in the `[keys]` table.

fmx opens without an agent. `ctrl-b c` starts one where fmx is running, and
`ctrl-b l` opens the launch
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
one level under it:

```toml
project_roots = ["~/code", "~/src"]
```

With no roots configured it offers the directory fmx itself was started in.

### Session names

An agent is listed by its session id until it is given something to do. As
soon as its first prompt is submitted, fmx asks a small model for a three-to-
six-word title, turns it into a slug, and lists the agent under that name
instead. The name is kept in `~/.config/fmx/slugs`, so a resumed session is
recognised without asking again, and it is unique — a name that is already
taken picks up a `-2`.

The completion runs through `fx ask`, so it uses whatever provider fx is
already signed in to and needs no credentials of its own. Defaults suit codex;
name a model for any other provider, or turn naming off entirely:

```toml
[slug]
enabled = true      # set false to keep listing agents by session id
effort = "low"      # reasoning effort the naming completion runs at
timeout_ms = 60000

[slug.models]
codex = "gpt-5.4-mini"
gateway = "openai/gpt-5-mini"
```

A provider with no model named here is asked at whatever model fx is
configured for. Slug naming keeps its effort isolated in
`~/.config/fmx/inference` by adding one entry for that path to `workspaces` in
`~/.fx/settings.json` — nothing else in that file is touched. Set
`manage_effort = false` to leave it alone, and naming inherits your own
configured effort.

## Agents

Every key and click has a command, so an agent running inside fmx can do what
a hand can — and read what a hand can see. `fmx control <command>` talks to
the fmx it is running in (over `FMX_SOCKET_PATH`, which every instance is started with)
and prints one JSON object; from outside, `--socket PATH` names one, or the
only fmx running is used. Exit status: `0` ok, `1` refused, `2` usage, `3` no
fmx reachable, `4` timed out.

```sh
fmx control orient                      # where you are and what the interface shows
fmx control launch "write the tests"    # start an agent here, in the background
fmx control launch --project ~/code/x --worktree --model gpt-5.6-luna --effort max --focus
fmx control launch --editable --project ~/code/x --worktree   # open the dialog, prefilled
fmx control draft show|set|submit|cancel|wait [id]
fmx control focus next|previous|3|<slug>
fmx control instance list
fmx control instance wait 3 --state done,blocked --timeout 600000
fmx control instance send 3 "now run them"
fmx control sidebar --width 30 --hide       # or --show, --toggle
fmx control keys                        # every binding and the command it stands for
fmx control catalog                     # the models and efforts the dialog offers
```

`orient` answers with `you` — the caller's own instance: directory, project,
branch, slug, state, its subagents, and whether it is the one on screen — alongside every
instance, the sidebar's rows as they are drawn, and whatever surface is open.
Reading never marks an instance seen; `focus` does, as clicking its row does.
Subagents recorded by fx appear as non-selectable status rows nested beneath
their parent instance, in both the sidebar and `orient`.

`launch` without `--editable` starts the agent and answers with its instance.
It does not take the screen unless `--focus` is given: an agent starting
workers should not keep stealing the human's view. With `--editable` it opens
the launch dialog instead, prefilled with whatever was given — a project but no
prompt, say — and answers with a **draft** id. Fields left out keep the
dialog's defaults. The human finishes it as usual, or the agent reads it back
with `draft show`, amends it with `draft set`, and closes it with `draft
submit` or `draft cancel`; `draft wait` (or `launch --editable --wait`) blocks
until either has happened and says what came of it. A dialog the human opened
is a draft too, so an agent can finish one as well as start one.

`instance wait` blocks until an instance reaches a state — by default any that
needs someone: `idle`, `done`, or `blocked`. A prompt that has gone in but not
yet been picked up holds the wait, so waiting right after `launch` or `send`
means waiting for the work, not for the startup idle. `done` is `idle` that
nobody has looked at since; an instance on screen is always seen.

## Development

Development and machine provisioning should use an editable checkout, never
the platform release above:

```sh
bun install --frozen-lockfile
bun link  # ~/.bun/bin/fmx runs this checkout's src/index.ts
bun test
bun run typecheck
bun run test:pty  # requires a host that permits PTY allocation
```
