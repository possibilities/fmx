# fmx

**fmx** /fʌks/ — A TUI surface for [fx](https://fx.sh/).

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

`ctrl-b c` starts an agent where fmx is running. `ctrl-b l` opens the launch
dialog instead, which asks where to start it: a letter cycles the project row
to the next project whose name begins with it, space opens a picker that
filters as you type, and enter starts the agent there. Projects are listed
most-recently-worked-in first.

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
configured for. Reasoning effort cannot be set per command, so fmx runs these
completions in `~/.config/fmx/inference` and adds one entry for that path to
`workspaces` in `~/.fx/settings.json` — nothing else in that file is touched.
Set `manage_effort = false` to leave it alone, and naming inherits your own
configured effort.

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
