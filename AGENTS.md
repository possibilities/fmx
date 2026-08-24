# fmx agent notes

- fmx targets our Fx fork in `~/src/fx`, maintained and installed through the
  `~/code/fxnk` workshop; do not assume an upstream Fx checkout describes the
  behavior available here. Read `~/code/fxnk/MAINTAIN.md` section "Features"
  for the fork's authoritative feature inventory. fxnk also owns fmx's style
  guide at `~/code/fxnk/style/STYLE.md`, with machine-readable ground truth in
  `style/tokens.json`: fmx treats Fx itself as the living style guide, and the
  fxnk artifacts translate that source into rules and values fmx can borrow.
- The `[keys]` table in `~/.config/fmx/config.toml` intentionally shares
  Herdr's binding grammar: binding strings, string arrays, `prefix+` trigger
  syntax, and direct modified chords work in both programs. Common action
  fields keep the same spelling and meaning. `keys.launch` and
  `keys.toggle_tray` are fmx-owned: Herdr has no launch counterpart and calls
  its own left surface a Sidebar, not a Tray. Herdr ignores fields it does not
  know with a diagnostic. Do not mention Herdr in user-facing text (README,
  `--help`, diagnostics) — only here.
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
- One Home has one Companion-held Runtime (`fmxr-<home id>`) and any number
  of thin terminal Clients. The Runtime alone owns OpenTUI, `Multiplexer`,
  the Home sockets, and the Manifest. A Client relays bytes and dimensions;
  its Init, keyboard, mouse, paste, or resize makes it sizing owner. The
  Runtime renders once at that size, so larger Clients have blank margins and
  smaller ones crop right/bottom. When the owner leaves, the Companion
  immediately restores the most recently active remaining Client's size.
- A new Runtime waits on its one-use bootstrap marker before constructing
  `CliRenderer`; the creating Client writes it after its attach reaches Ready,
  so palette queries have a real host terminal to answer. The wait is bounded
  so a failed initial attach does not orphan a headless Runtime.
- `keys.detach` (default `prefix+d`) is intercepted by the thin Client and
  disconnects only that Client, never an Agent. There is deliberately no
  `fmx control detach`: agents do not own physical Client connections. The
  Runtime treats a Detach binding that somehow reaches it as inert, so stale
  Client configuration cannot turn local Detach into shared shutdown. The
  Companion ends the Runtime after its final terminal Client leaves; a signal,
  crash, or terminal loss has the same Agent-lifecycle result. Every fx stays
  held for the next Runtime. Do not bring back the Ctrl-C/TERM/KILL escalation
  `stop()` used to do; ending an fx is the human's act, from inside it, or
  `fmx-zmx kill` by hand.
- `FxAgent` renders; it never owns a process. Everything that carries fx
  goes through `AgentTransport` (`src/agent-transport.ts`), and the
  one implementation in `src/` is the Companion's. The Bun PTY behind the
  same seam lives in `tests/fixtures/pty-transport.ts` so the multiplexer
  suites run without a Companion — keep it a fixture; a second production
  transport is what the seam exists to prevent.
- Creation order is fixed: `manifest.claim` (the Agent is on screen from
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
- Each Manifest entry checkpoints the last Agent-socket state, attention, and
  whether that exact state was seen. Seed it synchronously as the restored row
  is added; the first visible Agent becomes seen, inactive `done` remains
  done, and a newer fx frame supersedes it. Subagent state is not duplicated:
  refresh it from fx's control records and session locks on restore.
- A lost transport is not an exit. `recoverAgent` asks the Companion: a
  live session is re-attached (and replays onto the reset), an ended one is
  removed exactly as an Exit would remove it, and one that cannot be reached
  after a few tries leaves the screen but stays in the Manifest for the next
  start's join. Only `AgentEndedError`, an `Exit` frame, or a `start` that
  rejects with fx never started may remove an Agent's Manifest entry; a
  `start` whose fx is running but unreachable (`AgentUnreachableError`)
  is marked `running` and recovered like a lost transport.
- `adopt` re-sends the terminal's current size. The transport was opened at
  whatever size the terminal had when it was asked for — 80×24 before the
  first layout pass — and the resize the layout pass fires finds no
  transport to tell; without the re-send fx draws at the wrong size until
  the next host resize. The same ordering is why `armPrompt` waits for the
  transport when fx reports first: `create` returns with fx already up.
- `state.json` remembers the selected agent by its stable `agentId`, not its
  display number. Startup prepares every survivor synchronously in display-id
  order, selects that saved Agent before its first await, then attaches the
  selected transport first. Do not restore by adding the selected Agent out
  of order: the tray draws creation order reversed, newest agent first, and
  only `buildTree` reverses it — every list behind it stays creation order.
  State writes are serialized and awaited during Runtime cleanup so a
  selection immediately followed by the final Client's Detach lands.
- Palette detection can take seconds in a terminal that never answers, and a
  renderer destroyed under it never settles the query; `index.ts` races it
  against shutdown so a signal in that window still reaches the socket
  cleanup. Do not await anything renderer-bound in `main` without that race.
  `index.ts` deliberately constructs `CliRenderer` before calling
  `setupTerminal`: its input parser can collect palette replies while no
  alternate-screen frame exists. Before first paint it gives a responsive host
  one 60 Hz frame to answer, then locks the chosen selected-row background and
  divider until that initial query settles; a late answer may theme everything
  else but must not repaint those two startup surfaces. Unlock afterward so a
  real later theme change still applies.
  Session names are indexed ANSI gray (slot 8, dim on any theme) until both
  host defaults have answered and the Ramp's dim step after; under that lock
  a late answer leaves them, like the fill and the divider, as they were
  first drawn. The fill is kept together with the ramp it came from, and the
  active row's glyph is painted from that ramp: a fallback-dark fill under a
  late light answer must not carry the light host's near-black foreground.
- A Runtime resize applies the new physical size to OpenTUI synchronously,
  then clears the whole physical screen before its next frame. Input can arrive
  before OpenTUI's debounced SIGWINCH handler; applying size first prevents
  that interaction from painting one last frame at the previous owner's size.
  The clear is what leaves genuinely blank unused space on a larger observing
  Client when a smaller Client becomes sizing owner; do not replace it with a
  rectangle sized to the owner. Conceal the cursor in that clear before it is
  homed; OpenTUI's next frame restores the cursor only after the new layout is
  drawn, so the corner cannot flash between them. Begin synchronized output
  before that clear; the next frame's normal end marker publishes the clear and
  resized UI together instead of exposing the unused field alone. Once the
  startup palette choice has settled, OpenTUI's renderer background must remain
  the Ramp's opaque host-background step: a transparent renderer lets the unused
  clear show through around the empty-state text and retains cells from a tray
  or terminal that just disappeared. The one exception is a first frame whose
  palette query is still pending: `index.ts` paints exactly the owner rectangle
  with the terminal's native default background (SGR 49 plus row-bounded ECH),
  then the detected color becomes the opaque renderer base without an
  intervening unused-field clear. Do not use EL there; it would consume a larger
  Client's right margin.
- Every color fmx paints on a surface of its own comes from `hostRamp`
  (`src/host-palette.ts`): fx's five gray steps as blends of the host's
  background toward its foreground, fx's dark column as the fallback tier.
  Focus (host blue) and error (host red) are the only hues, each with one
  job. A new surface takes its colors from the Ramp; a state gets a glyph
  and a weight, never a hue; a surface fx never draws is recorded as a
  carve-out in fxnk's `style/STYLE.md` before it ships.
- Agent rows activate on mouse-down, not mouse-up. Their text is deliberately
  non-selectable: rebuilding the list to switch while OpenTUI holds a tray
  selection is unsafe, and pointer navigation must be as immediate as a key.
- The agent socket speaks the protocol fx already speaks unprompted, which is
  Herdr's. That is why `src/fx-environment.ts` sets `HERDR_SOCKET_PATH` and
  `HERDR_PANE_ID` literally — fx reads those names and no others, so they are
  protocol constants, not a naming choice. They are also the one place the name
  legitimately appears in code. Inherited `HERDR_*` variables are cleared first:
  running fmx inside a Herdr pane would otherwise have fx report this
  agent's lifecycle against a stranger's pane.
- fx replies-or-blocks: it opens a connection per message and waits up to 250ms
  for one newline-terminated reply. `src/agent-socket.ts` writes the reply
  before it does anything else with the request; keep it that way, because any
  work done first is latency charged directly to the agent.
- fx sends `custom_status` on `pane.report_agent` (`permission`, `question`,
  `recovery`). Herdr has no such field and drops it; fmx keeps it. Do not
  "fix" it to `message` to match Herdr.
- fx takes per-process launch overrides from `FX_MODEL` and `FX_EFFORT`; the
  launch dialog passes both to the one agent it starts. fx rejects both
  `effort` and `codex_model` from a workspace's own `.fx.json` as user-only
  settings. Native session naming is also fx profile configuration; fmx does
  not manage it or write `~/.fx/settings.json`.
- The ADE socket is a one-way, mode-0600 NDJSON feed beside the Agent socket,
  under the same Home singleton. Every fx receives its path plus the stable
  Manifest Agent identity as `FX_ADE_SOCKET_PATH` and `FX_ADE_INSTANCE_ID`.
  ADE session identity is eager and wins over a later legacy Agent-socket
  frame. Sequence is monotonic per fx process; after a gap, re-read the active
  session's `display.json`. Unknown additive schema-1 events still advance the
  sequence and are otherwise ignored.
- Session names belong to fx. fmx applies `SessionMetadataChanged` only to the
  session named by its ADE context and reads
  `~/.fx/sessions/<id>/display.json` on attach, identity change, or recovery.
  It never reads prompt logs, starts a naming completion, stores another name,
  normalizes the title, or makes names unique. An exact duplicate is an
  ambiguous control target; `/rename` and generated names follow the same
  path because fx is the sole persistence authority.
- The control socket (`src/control-socket.ts`) is a second socket, not a
  second protocol on the agent socket. The agent socket must reply before it
  acts (see above), and a command that needs its result cannot. The two share
  nothing but the `LineAssembler`. Keep `FMX_SOCKET_PATH` beside
  `FMX_AGENT_ID` in `src/fx-environment.ts`: the client reads both, and
  `current` as a target is meaningless without the id. The path is the agent
  socket's with `.ctl` for `.sock` — per Home, not per pid — so the
  `FMX_SOCKET_PATH` an fx was given outlives the fmx that gave it; it is bound
  under the agent socket's singleton, which is what makes unlinking a stale
  one safe. `fmx control` from outside any agent finds a live fmx by
  probing the sockets, not by pid.
- Every `fmx control <command>` goes through `Multiplexer.handleControl`, and every
  write there takes the path the keys take (`showLaunchDialog`, `switchTo`,
  `applyTrayWidth`, the dialog's own `apply`/`submit`/`close`). Do not add a
  command that does something a hand cannot; add the key first. Detach is the
  intentional exception in the other direction: it is Client-local and must
  never acquire a control method.
- A launch from the CLI is background by default: `createAgent` only
  switches when asked or when nothing is on screen. `switchTo` never focuses a
  terminal while the launch dialog or a modal is up — those hand focus back
  when they close — which is what lets a background launch land under an open
  draft without stealing its keys.
- `awaiting_work` is why `agent wait` is trustworthy right after `launch`
  or `send`: fx reports idle at startup before the pasted prompt reaches it.
  The flag is set when a prompt is queued and cleared by the first `working`
  frame; clear it nowhere else.
- The agent socket's path is stable per Home (`/tmp/fmx-<uid>-<home id>.sock`)
  so an fx that outlives the fmx that started it reports to the next one.
  `AgentSocket.start` therefore takes a flock on `<path minus .sock>.lock`
  for the life of the process, and only under it probes, unlinks, and binds:
  when the flock is held it waits one bounded handoff window for a predecessor
  finishing terminal teardown, then refuses a holder that remains. It never
  touches the socket without first acquiring the flock. Once acquired,
  a path something answers on is another fmx for this Home, refused with
  exit code 2, and never unlinked — only the process that bound the socket
  removes it. Only a path nothing answers on is the residue of a crash and
  replaced. The join runs after the bind, because only the socket's holder
  may write the Manifest.
- The Manifest is written before the Companion is asked to create (`creating`),
  and marked `running` on the acknowledgement, so a crash anywhere in between
  leaves something for the next start's join to resolve. The join
  (`src/agent-reconcile.ts`) is a pure function over the Manifest and
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
  every Agent. `reconcileAtStartup` reports the failure and changes
  nothing.
- The Companion reports a session's `cwd` in OSC 7 form (`file://<host><path>`)
  as the daemon's realpath, and its `cmd` shell-quoted and cut at 256 bytes;
  `zmx-command.ts` decodes both, but `cmd` is for display — an adopted
  Agent takes its executable from it and records `fxArgs: null`. A session that is not `live` has no readable labels, so
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
  the Manifest records each Agent's Companion build, a start that finds
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
