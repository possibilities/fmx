# fmx

fmx is a lightweight terminal multiplexer for running several interactive [fx](https://fx.sh/) sessions in one terminal. Every instance gets its own real PTY and OpenTUI terminal emulator, so fx keeps ownership of raw mode, Kitty keyboard input, bracketed paste, mouse input, terminal queries, resize signals, alternate screens, and session locking.

## Requirements

- Bun 1.4 or newer
- `fx` on `PATH`, or an explicit `--fx PATH`
- A supported interactive terminal

## Install and run

```sh
bun install
bun run src/index.ts
```

To exercise the local fx checkout directly:

```sh
bun run src/index.ts --fx ~/src/fx/zig-out/bin/fx
```

Pass initial interactive fx arguments after `--`:

```sh
bun run src/index.ts -- --record
```

Resume on startup:

```sh
bun run src/index.ts --resume-last
bun run src/index.ts --resume SESSION_ID
bun run src/index.ts -r
```

## Keys

fmx uses a tmux-style `Ctrl-B` prefix. On Unix, `Ctrl-Z` suspends the whole fmx job. Every other key that is not part of an fmx command is encoded by OpenTUI and sent to the active fx PTY.

| Key | Action |
| --- | --- |
| `Ctrl-B c` | Create a fresh fx instance |
| `Ctrl-B r` | Open fx's saved-session picker in a new instance |
| `Ctrl-B R` | Resume the latest workspace session in a new instance |
| `Ctrl-B n` / `Ctrl-B p` | Select next / previous instance |
| `Ctrl-B 1` … `9` | Select an instance directly |
| `Ctrl-B x` | Gracefully close the active instance |
| `Ctrl-B q` | Gracefully stop all instances and quit |
| `Ctrl-B b` | Send a literal `Ctrl-B` to fx |
| `Ctrl-B ?` | Show key help |
| `Ctrl-Z` | Suspend fmx and all fx instances (Unix) |

`Ctrl-C` is deliberately not owned by fmx. It reaches fx unchanged, preserving fx's native cancel and double-press exit behavior. On Unix, `Ctrl-Z` pauses fmx and all of its fx children; `fg` resumes them together.

Inactive tabs are marked `*` after output and `!` after a terminal bell. fx's OSC-2 session title becomes the tab label and the outer terminal title.

## Shutdown behavior

Closing a tab or quitting sends fx its semantic Ctrl-C exit gesture first. This lets fx finish persistence, release its session lock, restore terminal modes, and create its normal resume handoff. fmx falls back to `SIGTERM` and then `SIGKILL` only when the child does not exit within the grace periods. An fx process that exits on its own remains as an `x`-marked tab until `Ctrl-B x` removes it.

## Development

```sh
bun test
bun run typecheck
bun run test:pty  # requires a host that permits PTY allocation
```

The regular suite reports the PTY end-to-end test as skipped. `test:pty` opts into the real nested-PTY check, which suspends, creates, switches, resumes, closes, and gracefully shuts down fake fx instances.
