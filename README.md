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
