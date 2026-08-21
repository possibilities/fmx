# fmx agent notes

- The `[keys]` table in `~/.config/fmx/config.toml` is intentionally a strict
  subset of Herdr's keybinding schema: the same field names, binding strings,
  string arrays, `prefix+` trigger syntax, and direct modified chords work in
  both programs. Keep new fields compatible with Herdr's schema, and don't
  mention Herdr in user-facing text (README, `--help`, diagnostics) — only
  here.
- fx executable resolution: `FMX_FX_PATH` env var, else `fx` on `PATH`. There
  is deliberately no `--fx` flag.
- fmx has no quit/close/detach keys: fx exits govern the lifecycle. A tab
  disappears when its fx exits; the last exit shuts fmx down.
- The agent socket speaks the protocol fx already speaks unprompted, which is
  Herdr's. That is why `src/fx-environment.ts` sets `HERDR_SOCKET_PATH` and
  `HERDR_PANE_ID` literally — fx reads those names and no others, so they are
  protocol constants, not a naming choice. They are also the one place the name
  legitimately appears in code. Inherited `HERDR_*` variables are cleared first:
  running fmx inside a Herdr pane would otherwise have fx report this
  instance's lifecycle against a stranger's pane.
- fx replies-or-blocks: it opens a connection per message and waits up to 250ms
  for one newline-terminated reply. `src/agent-socket.ts` writes the reply
  before it does anything else with the request; keep it that way, because any
  work done first is latency charged directly to the agent.
- fx sends `custom_status` on `pane.report_agent` (`permission`, `question`,
  `recovery`). Herdr has no such field and drops it; fmx keeps it. Do not
  "fix" it to `message` to match Herdr.
