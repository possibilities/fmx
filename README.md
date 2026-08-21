# fmx

Tabs for [fx](https://fx.sh/). Each tab runs a real fx in its own PTY, full screen, no chrome — fx can't tell it's not alone.

Requires Bun 1.4+ and `fx` on `PATH`.

```sh
bun install
bun run src/index.ts
```

`Ctrl-B` is the prefix key; `Ctrl-B ?` lists the bindings. Rebind them in `~/.config/fmx/config.toml` — the `[keys]` table is a strict subset of Herdr's schema.

## Development

```sh
bun test
bun run typecheck
bun run test:pty  # requires a host that permits PTY allocation
```
