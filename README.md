# fmx

[fx](https://fx.sh/) dedicated multiplexer

## Install

Requires Bun 1.4+ and `fx` on `PATH`.

```sh
bun install
bun run src/index.ts
```

## Usage

`ctrl-b` is the prefix key; `ctrl-b ?` lists the bindings. Rebind them in `~/.config/fmx/config.toml` in the `[keys]` table — a strict subset of Herdr's schema.

## Development

```sh
bun test
bun run typecheck
bun run test:pty  # requires a host that permits PTY allocation
```
