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
  The first configured root is fmx's working directory and therefore the cwd
  for a direct `keys.new_tab` launch.
  TUI startup refuses an empty resolved list with exit 1 and the exact config
  line to add; control commands, `--help`, `--version`, and `doctor` do not
  need project roots because they never open the TUI.
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
- `keys.detach` (default `prefix+d`) closes fmx, never an Instance: fx exits
  govern the Instance lifecycle. An Instance disappears when its fx exits;
  the last exit leaves the empty state, where ctrl-c twice also closes fmx.
  An explicit detach, a signal, a crash, or the terminal going away sends
  nothing to fx: the Companion keeps it, and the next fmx for the Home
  attaches to it. Do not bring back the Ctrl-C/TERM/KILL escalation `stop()`
  used to do; ending an fx is the human's act, from inside it, or
  `fmx-zmx kill` by hand.
- `FxInstance` renders; it never owns a process. Everything that carries fx
  goes through `InstanceTransport` (`src/instance-transport.ts`), and the
  one implementation in `src/` is the Companion's. The Bun PTY behind the
  same seam lives in `tests/fixtures/pty-transport.ts` so the multiplexer
  suites run without a Companion — keep it a fixture; a second production
  transport is what the seam exists to prevent.
- Creation order is fixed: `manifest.claim` (the Instance is on screen from
  here, its claim queued to disk), `await saved`, then the transport's
  `start`, then `markRunning`, then `adopt`. The claim must be on disk
  before the Companion hears the name, and the Manifest must say `running`
  before anything can go wrong in fmx, because those two writes are what a
  crash leaves for the join.
- A restore resets the visible terminal with RIS at `RestoreBegin` and
  re-applies the host palette after: the Companion's replay carries the
  modes, cursor, and keyboard state fx set, but the host's colors were never
  fx's and RIS takes them too. The `CursorReportAdapter` is replaced at the
  same moment — a query half-translated when the last transport dropped must
  not pair with a response from the next.
- A lost transport is not an exit. `recoverInstance` asks the Companion: a
  live session is re-attached (and replays onto the reset), an ended one is
  removed exactly as an Exit would remove it, and one that cannot be reached
  after a few tries leaves the screen but stays in the Manifest for the next
  start's join. Only `InstanceEndedError`, an `Exit` frame, or a `start` that
  rejects with fx never started may remove an Instance's Manifest entry; a
  `start` whose fx is running but unreachable (`InstanceUnreachableError`)
  is marked `running` and recovered like a lost transport.
- `adopt` re-sends the terminal's current size. The transport was opened at
  whatever size the terminal had when it was asked for — 80×24 before the
  first layout pass — and the resize the layout pass fires finds no
  transport to tell; without the re-send fx draws at the wrong size until
  the next host resize. The same ordering is why `armPrompt` waits for the
  transport when fx reports first: `create` returns with fx already up.
- Palette detection can take seconds in a terminal that never answers, and a
  renderer destroyed under it never settles the query; `index.ts` races it
  against shutdown so a signal in that window still reaches the socket
  cleanup. Do not await anything renderer-bound in `main` without that race.
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
- fx takes per-process launch overrides from `FX_MODEL` and `FX_EFFORT`; the
  launch dialog passes both to the one instance it starts. fx rejects both
  `effort` and `codex_model` from a workspace's own `.fx.json` as user-only
  settings. Slug naming still keeps its effort in the fmx-owned inference
  workspace through `workspaces["<abs path>"]` in the human's
  `~/.fx/settings.json`. Never widen that write: read, add the one key, and
  abandon the write if the file changed underneath.
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
  `current` as a target is meaningless without the id. The path is the agent
  socket's with `.ctl` for `.sock` — per Home, not per pid — so the
  `FMX_SOCKET_PATH` an fx was given outlives the fmx that gave it; it is bound
  under the agent socket's singleton, which is what makes unlinking a stale
  one safe. `fmx control` from outside any instance finds a live fmx by
  probing the sockets, not by pid.
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
- The agent socket's path is stable per Home (`/tmp/fmx-<uid>-<home id>.sock`)
  so an fx that outlives the fmx that started it reports to the next one.
  `AgentSocket.start` therefore takes a flock on `<path minus .sock>.lock`
  for the life of the process, and only under it probes, unlinks, and binds:
  a path something answers on is another fmx for this Home, refused with
  exit code 2, and never unlinked — only the process that bound the socket
  removes it. Only a path nothing answers on is the residue of a crash and
  replaced. The join runs after the bind, because only the socket's holder
  may write the Manifest.
- The Manifest is written before the Companion is asked to create (`creating`),
  and marked `running` on the acknowledgement, so a crash anywhere in between
  leaves something for the next start's join to resolve. The join
  (`src/instance-reconcile.ts`) is a pure function over the Manifest and
  `list --json`; keep the I/O out of it so every crash-window combination
  stays a table test.
- A Companion `create` that times out has not failed: the session may be
  running. `CompanionCreateError.sessionMayExist` is the only error that says
  so; `inspect` it, never assume. And `kill` returns when the daemon accepts,
  not when it is gone — the name reads `refused` until then, which the join
  holds as unresolved and `settle` waits out. A socket still `refused` after
  the settle window has no daemon behind it and never will: the join removes
  its entry and unlinks the file. `unreachable` (a connect that hung) is the
  one state left for the next start.
- `list --json` returning anything but a JSON array is a `CompanionError`,
  never an empty Companion: a join that believed an empty answer would drop
  every Instance. `reconcileAtStartup` reports the failure and changes
  nothing.
- The Companion reports a session's `cwd` in OSC 7 form (`file://<host><path>`)
  as the daemon's realpath, and its `cmd` shell-quoted and cut at 256 bytes;
  `zmx-command.ts` decodes both, but `cmd` is for display — an adopted
  Instance takes its executable from it and records `fxArgs: null`. A session that is not `live` has no readable labels, so
  `list --where` never shows it — enumerate unfiltered when deciding
  ownership.
- The Companion's directory is under `/tmp/fmx-<uid>/zmx`, not the config
  directory: macOS caps a socket path near 104 bytes, and sessions do not
  survive a reboot, so neither need their exit records. A `-Dcompanion`
  build of the fork defaults to the same directory, created 0700 and
  refused when it is not ours or is open to others — the check
  `ensureCompanionDirectories` makes, made by the by-hand path too — so a
  human's `fmx-zmx list` needs no `ZMX_DIR` and a stock-built fork's 0750
  directory never appears from a by-hand command. The fork refuses to
  build a `+fmx.` version without `-Dcompanion`, so a build that passes
  the pin is always one that keeps this directory. fmx still sets
  `ZMX_DIR` on every command it runs.
- The Companion is resolved `FMX_ZMX_PATH`, then `fmx-zmx` beside the
  installed binary (`installedDirectory()`: only a compiled fmx has one),
  then `fmx-zmx` on PATH, and its build (`fmx-zmx version`, first line) is
  compared to `companion.json` after `ensureCompanionDirectories` — the
  command creates the directory if it must. Beside fmx or on PATH, a
  mismatch is fatal; under the override it is one stderr line, because the
  override is the development loop and a debug build prints a plain
  version. `fmx doctor` runs the same resolution and check without binding
  anything; its exit code says whether a start would get past the
  Companion (found, pinned build, private directory) and nothing else —
  fx is a separate install, and an override's build is the developer's. Keep `--version` one line — the installer and the release script
  compare it whole.
- Moving the pin is a release act: land the fork change on `integration`,
  push, put the commit and `<fork version>+fmx.<12 hex>` in
  `companion.json`, re-check the Companion notices, release the pair. The
  pinned build is always made by `scripts/build-companion.sh` — the release
  script, `scripts/install-companion.sh` (the editable checkout's
  `~/.local/bin/fmx-zmx`, which agentstart installs and zmax's pin step
  refreshes), and nothing else; one build path, one set of flags. 
- Bumping `PROTOCOL_VERSION` (`src/zmx-protocol.ts`, mirrored by the fork's
  `src/ipc.zig`) is a pair-wide event with survivors: daemons started by the
  previous Companion keep running the old protocol, the new fmx's `Hello`
  is refused by them, and the new `fmx-zmx` CLI cannot reach them either —
  every running agent on the machine becomes unreachable at once. Before
  the first bump, build one of these and say which in an ADR: **drain** —
  the Manifest records each Instance's Companion build, a start that finds
  survivors on an older build leaves them on screen as unreachable with a
  message naming the build, and the installer keeps the previous
  `fmx-zmx` beside the new one as `fmx-zmx-<build>` so the human can attach
  to or end them by hand; or **carry** — fmx keeps speaking every protocol
  version a survivor may hold, negotiating down on `Welcome` (the refusal
  already names both ranges), and the old one is retired only when no
  Manifest on the machine records it. Drain is the cheaper first answer;
  carry is what a long-lived deployment wants. Until one exists, the
  protocol version does not move, whatever else the stack changes.
- The two `tests/git-context.test.ts` cases that read `process.cwd()` assume a
  main checkout and fail in a linked worktree. That is the test's assumption,
  not a regression.
