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
