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
