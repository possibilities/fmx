# fmx agent notes

- The `[keys]` table in `~/.config/fmx/config.toml` is intentionally a strict
  subset of Herdr's keybinding schema: the same field names, binding strings,
  string arrays, `prefix+` trigger syntax, and direct modified chords work in
  both programs. Keep new fields compatible with Herdr's schema, and don't
  mention Herdr in user-facing text (README, `--help`, diagnostics) — only
  here. `keys.launch` is the one field Herdr has no counterpart for; a field
  fmx alone needs is fine, but a field both have must keep Herdr's spelling
  and meaning. Herdr ignores what it does not know, with a diagnostic.
- `project_roots` is deliberately empty by default. Personal roots belong in
  `~/.config/fmx/config.toml`, never in a shipped default: a guess at
  someone's directory layout is wrong everywhere it is not exactly right.
- fx has no flag for an interactive prompt — `fx ask` is noninteractive and a
  bare positional is an unknown subcommand. A launch prompt is therefore typed
  into the PTY and submitted, once the pane's first agent-socket frame says fx
  is up. Do not look for a flag; there isn't one. It goes in as a bracketed
  paste so newlines survive, and the carriage return that sends it is a
  separate write a beat later — fx discards a paste when anything follows its
  end marker in the same write.
- The launch dialog's prompt is OpenTUI's textarea, fed by the renderer's own
  dispatch to the focused renderable. That is why `Multiplexer.onKeyPress`
  swallows a key only when `LaunchDialog.handleKey` says it kept it: a
  swallowed key never reaches the widget. fx is blurred while the dialog is
  open, so a key let through can reach nothing else.
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
- Naming a session runs `fx ask --no-save --json`, deliberately, not libfx.
  libfx's native backend requires an `apiKey` and installs an unavailable
  OAuth transport, so a Codex or Grok subscription cannot reach it at all;
  the fx binary fmx already resolved answers on whatever provider the human
  is signed in to and keeps every credential out of fmx.
- fx takes a model override from `FX_MODEL` but has no equivalent for
  reasoning effort, and it rejects both `effort` and `codex_model` from a
  workspace's own `.fx.json` as user-only settings. The one place effort can
  be set per directory is `workspaces["<abs path>"]` in the human's
  `~/.fx/settings.json`, which is why naming runs in its own workspace and
  why fmx writes that single entry. Never widen that write: read, add the one
  key, and abandon the write if the file changed underneath.
- Slug models ship a default for codex alone, for the same reason
  `project_roots` ships empty: a guess at another provider's catalog is a
  model id that does not exist there. A provider with no default names at
  whatever model fx is configured for, which always works.
- Naming is fastest when fmx already holds the prompt: an instance launched
  with one names itself from what fmx typed, without waiting for fx to write
  it down. For a prompt typed by hand there is no such shortcut — fx records
  it 2 to 11 seconds after submit — so the session directory is watched and the
  write itself wakes naming; the sweep behind that watch is a safety net for a
  filesystem that drops events, not the thing that should ever notice.
  `~/.fx/history.jsonl` does hold every prompt at submit time, but it
  carries a workspace and a timestamp and no session id: two instances in one
  directory could take each other's name, and a wrong name is worse than a
  slow one.
- fx never reports a prompt over the agent socket, only a session id. The
  first prompt is read from fx's own session log at
  `~/.fx/sessions/<id>/events.jsonl` (`recovery_checkpoint_set`, then
  `history_turn_committed`), with fx's `display.json` sidecar as a late,
  240-byte fallback. Only a prefix of the log is read: it grows into
  megabytes, and the prompt is in the opening events.
- The control socket (`src/control-socket.ts`) is a second socket, not a
  second protocol on the agent socket. The agent socket must reply before it
  acts (see above), and a command that needs its result cannot. The two share
  nothing but the `LineAssembler`. Keep `FMX_SOCKET_PATH` beside
  `FMX_INSTANCE_ID` in `src/fx-environment.ts`: the client reads both, and
  `current` as a target is meaningless without the id.
- Every `fmx control <command>` goes through `Multiplexer.handleControl`, and every
  write there takes the path the keys take (`showLaunchDialog`, `switchTo`,
  `applySidebarWidth`, the dialog's own `apply`/`submit`/`close`). Do not add a
  command that does something a hand cannot; add the key first.
- A launch from the CLI is background by default: `createInstance` only
  switches when asked or when nothing is on screen. `switchTo` never focuses a
  terminal while the launch dialog or a modal is up — those hand focus back
  when they close — which is what lets a background launch land under an open
  draft without stealing its keys.
- `awaiting_work` is why `instance wait` is trustworthy right after `launch`
  or `send`: fx reports idle at startup before the pasted prompt reaches it.
  The flag is set when a prompt is queued and cleared by the first `working`
  frame; clear it nowhere else.
- The two `tests/git-context.test.ts` cases that read `process.cwd()` assume a
  main checkout and fail in a linked worktree. That is the test's assumption,
  not a regression.
