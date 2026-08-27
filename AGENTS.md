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
  fields keep the same spelling and meaning. `keys.toggle_tray` is fmx-owned;
  Herdr calls its own left surface a Sidebar, not a Tray. Herdr ignores fields
  it does not know with a diagnostic. Do not mention Herdr in user-facing text
  (README, `--help`, diagnostics) — only here.
- `project_roots` is deliberately empty by default. Personal roots belong in
  `~/.config/fmx/config.toml`, never in a shipped default: a guess at
  someone's directory layout is wrong everywhere it is not exactly right.
  The first configured root is fmx's working directory. Only roots and children
  inside a git repository are offered: an Agent runs in a repository
  or it does not run, which `performLaunch` enforces for every CLI launch
  with `readGitContext`, while the scan and the control
  socket's parameter checks use the synchronous `isRepositoryDirectory` walk
  because neither can wait for git. A repository with nothing committed yet is
  a project — its unborn HEAD still names the branch the tray draws, which is
  the whole reason it qualifies — it just cannot offer a Worktree, and
  `readHeadCommit` is what answers that: it keeps git's own words for every
  other failure, because `isRepositoryDirectory` can over-offer a directory
  that only looks like a checkout. A HEAD that names neither a ref nor a
  commit names no branch, so `readGitContext` answers null and it is no
  project.
  The empty state is deliberately only `no agents`; Agent creation belongs to
  `fmx control launch`, not to the TUI.
  That first root is commonly a directory of repositories rather than one
  itself, so a launch naming no project and coming from no agent falls back
  to the first project on offer; a
  Home whose roots hold no repository has nowhere to send it and is refused.
  TUI startup refuses an empty resolved list with exit 1 and the exact config
  line to add; control commands, `--help`, `--version`, and `doctor` do not
  need project roots because they never open the TUI.
- fx has no flag for an interactive prompt — `fx ask` is noninteractive and a
  bare positional is an unknown subcommand. A launch prompt is therefore typed
  into the PTY and submitted once that Agent's first ADE record says fx is up.
  Do not look for a flag; there isn't one. It goes in as a bracketed
  paste so newlines survive, and the carriage return that sends it is a
  separate write a beat later — fx discards a paste when anything follows its
  end marker in the same write.
- Fx executable resolution happens once per Runtime: `FMX_FX_PATH`, then
  `fmx-fx` beside an installed fmx, then `fmx-fx` on `PATH`, then the legacy
  `fx` on `PATH`. There is deliberately no `--fx` flag. The resolved executable
  must answer the exact `--fxnk-version` probe with the minimum in `fx.json`;
  every Agent reuses that absolute path without another lookup or probe.
  AgentStart still installs the same fork separately as `fx`; fmx installs its
  pinned private copy as `fmx-fx` and launches it with `FX_AUTO_UPGRADE=0`.
- One Home has one Companion-held Runtime (`fmxr-<home id>`) and any number
  of thin terminal Clients. The Runtime alone owns OpenTUI, `Multiplexer`,
  the Home sockets, and the Manifest. A Client relays bytes and dimensions;
  its Init, keyboard, mouse, paste, or resize makes it sizing owner. The
  Runtime renders once at that size, so larger Clients have blank margins and
  smaller ones crop right/bottom. When the owner leaves, the Companion
  immediately restores the most recently active remaining Client's size.
- A new Runtime waits on its one-use bootstrap marker before constructing
  `CliRenderer`; the creating Client writes it after its attach reaches Ready,
  so the OSC 11 theme query has a real host terminal to answer. The wait is bounded
  so a failed initial attach does not orphan a headless Runtime. A directory
  notification wakes the normal path immediately, with checks on both sides
  of watcher installation closing the race and a slow probe covering a lost
  or unavailable notification; do not put the normal path back behind a
  polling interval.
- A terminal Client conceals its physical cursor before asynchronous TUI
  preflight. A Client's Runtime Restore does not reset the physical terminal
  merely because `RestoreBegin` arrived: prepend RIS and concealment to the
  first actual Restore bytes, in the same write, while an empty cold-Runtime
  Restore leaves the shell surface intact. The Runtime begins synchronized
  output before OpenTUI enters the alternate screen, and the first complete
  frame publishes that transition. Every failure path must end synchronized
  output and reveal the cursor.
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
- An Agent Restore resets its embedded terminal with RIS at `RestoreBegin` and
  re-applies the resolved OSC 11 background after: the Companion's replay
  carries the modes, cursor, and keyboard state fx set, but fmx's terminal
  defaults were never fx's and RIS takes them too. The `CursorReportAdapter` is replaced at the
  same moment — a query half-translated when the last transport dropped must
  not pair with a response from the next.
- Each Manifest entry checkpoints the last ADE state, attention, and
  whether that exact state was seen. Seed it synchronously as the restored row
  is added; the first visible Agent becomes seen, inactive `done` remains
  done, and a newer ADE snapshot supersedes it. Subagent state is not duplicated:
  refresh it from fx's control records and session locks on restore, then let
  live ADE snapshots drive it. A subagent exists only under a parent fmx
  tracks: a live feed does not keep a child on screen, because an Agent that
  ended took its children with it, and fx's own control record owns the
  parent — a child's ADE attribution is captured with its work and may name a
  session fx has already rebound it away from. Hold the
  restored Session list unpublished until every Agent has attached and Git,
  display metadata, and subagent records have been queried, then paint the
  whole tree once; do not add a second Session-list snapshot.
- Startup reconciliation hands each surviving Agent's fresh Companion endpoint
  to its first attach, rather than inspecting the same name again. Consume the
  hint once, and query ownership labels in-band on that exact connection before
  sending Init: a failed endpoint may fall back to `settle`, but a label
  mismatch means the old Agent is gone and the foreign session is left alone.
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
  transport when fx reports first: `create` returns with fx already up. A
  transport lost mid-flight leaves the status `running`, so the prompt waits
  for the next transport rather than being consumed by a dead one, and the
  send that follows the paste is retried the same way: the two are one act,
  and a paste without its send sits unsent in fx's composer.
- `state.json` remembers the selected agent by its stable `agentId`, not its
  display number. Startup prepares every survivor synchronously in display-id
  order, selects that saved Agent before its first await, then attaches the
  selected transport first. Once it is attached, inactive transports attach
  with bounded concurrency; their completion order never changes the Agent
  list. Do not restore by adding the selected Agent out of order: the tray
  draws creation order reversed, newest agent first, and only `buildTree`
  reverses it — every list behind it stays creation order.
  State writes are serialized and awaited during Runtime cleanup so a
  selection immediately followed by the final Client's Detach lands.
- Theme selection matches fx exactly: valid case-insensitive `FX_THEME`, one
  bounded 200 ms OSC 11 background query, `COLORFGBG`, then dark. `index.ts`
  constructs `CliRenderer` before `setupTerminal`, starts the one query as
  soon as the ADE-feed singleton is held, and overlaps its fixed deadline with
  the Companion join. It awaits the result before terminal setup and first
  paint, so a timed-out initial reply can never retint visible content later.
  The app theme layer never asks for OSC 4, OSC 10, or a full host palette;
  OpenTUI may still perform its own capability handshake, whose color results
  do not select or alter fmx's tokens. Live CSI 997 notifications are refresh
  triggers, not theme authority: drain stale replies behind a DA1 fence,
  sample OSC 11 behind a second fence, discard a sample superseded by a newer
  notification, then replace the complete fixed token set in one render turn.
  A valid `FX_THEME` owns notification bytes but never queries or changes.
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
  OpenTUI's renderer background must remain the terminal-default canvas: a
  transparent renderer lets the unused clear show through around the empty-state
  text and retains cells from a tray or terminal that just disappeared.
- Every color fmx paints on a surface of its own comes from `fxnkRamp`
  (`src/host-palette.ts`): fixed indexed roles `255/252/250/245/240` in dark
  and `235/238/241/247/250` in light, plus fmx's surface/unused carve-outs
  `236/235` and `254/255`. Focus and error are direct ANSI slots `4` and `1`,
  never colors sampled from the host. A new surface takes its colors from the
  Ramp; a state gets a glyph and a weight, never a hue; a surface fx never
  draws is recorded as a carve-out in fxnk's `style/STYLE.md` before it ships.
- Agent rows activate on mouse-down, not mouse-up. Their text is deliberately
  non-selectable: rebuilding the list to switch while OpenTUI holds a tray
  selection is unsafe, and pointer navigation must be as immediate as a key.
- fmx deliberately does not enable Fx's upstream Herdr integration. Clear every
  inherited `HERDR_*` variable before launching an Agent and do not set a new
  binding: an fmx started inside Herdr must not let its child Fx report against
  the outer pane. Fx keeps that integration independently for hosts that opt in;
  fmx's lifecycle source is ADE alone.
- fx takes per-process launch overrides from `FX_MODEL` and `FX_EFFORT`; the
  CLI launch passes both to the one agent it starts. fx rejects both
  `effort` and `codex_model` from a workspace's own `.fx.json` as user-only
  settings. Native session naming is also fx profile configuration; fmx does
  not manage it or write `~/.fx/settings.json`.
- The ADE feed is fmx's sole fx→fmx lifecycle channel: a one-way, mode-0600
  NDJSON socket stable per Home at `/tmp/fmx-<uid>/<home id>.ade.sock`. Every Fx
  receives its path plus the stable Manifest Agent identity as
  `FX_ADE_SOCKET_PATH` and `FX_ADE_INSTANCE_ID`; fmx never replies. Every schema
  1 record carries the emitting main Agent's or subagent's current
  `agent_state` and `attention_kind`, so any later record repairs a dropped
  transition. `AttentionResolved` returns that actor to working,
  `route_recovery` is the recovery attention spelling, and `FxStopped` removes
  lifecycle authority. Sequence is monotonic per Fx process; a gap also
  re-reads the active session's `display.json`, and a sequence-one `FxStarted`
  after an accepted `FxStopped` begins a new process generation. Fx never
  rewinds, so a short run of records beneath the stored mark means the mark is
  wrong rather than the records: the newest becomes the new baseline and
  recovery runs, because one bad record must not be able to silence an
  Agent's real feed for the life of the Runtime. Unknown
  additive events still apply their context and advance the sequence. Only a
  main record may replace the active main session: a child record's parent is
  captured attribution and may legitimately lag after `/new`. The socket keeps
  a bounded startup backlog until survivor identities exist and the Multiplexer
  subscribes.
- The Bus is fmx's duplex Runtime contract, on one mode-0600 Home socket at
  `/tmp/fmx-<uid>/<home id>.bus`, independent of the one-way ADE feed. Bind it
  under the ADE singleton only after restored Agents and metadata are ready;
  only that holder may remove crash residue, including the retired `.ctl` and
  `.obs` paths. Every subscription gets a complete state snapshot first, later
  state is complete and deduplicated, and accepted ADE activity is attributed
  and published live-only after its state fold, with sequence gaps explicit.
  Summary payloads are allowlisted; raw ADE payloads require an explicit
  subscription. A connection may subscribe, issue multiple correlated control
  requests, or do both; responses carry the current state revision, take
  priority over queued events, and may evict whole events not yet written.
  Bound silent peers, total connections, subscriptions, pending requests, and
  each outbound queue, and disconnect a slow Bus peer: it must never delay the
  Runtime, another peer, a command, or Fx. Bus peers are not terminal Clients,
  do not affect sizing, and do not keep the Runtime alive.
- Session names belong to fx. fmx applies `SessionMetadataChanged` only to the
  session named by its ADE context and reads
  `~/.fx/sessions/<id>/display.json` on attach, identity change, or recovery.
  It never reads prompt logs, starts a naming completion, stores another name,
  normalizes the title, or makes names unique. An exact duplicate is an
  ambiguous control target; `/rename` and generated names follow the same
  path because fx is the sole persistence authority.
- Keep the Bus's `FMX_SOCKET_PATH` beside `FMX_AGENT_ID` in
  `src/fx-environment.ts`: control reads both, and `current` as a target is
  meaningless without the id. The Bus path is per Home, not per pid, so the
  value an Fx received outlives the fmx that gave it. An Fx surviving the
  cutover may retain a `.ctl` value; client resolution normalizes `.ctl`,
  `.obs`, and `.sock` suffixes to `.bus` rather than keeping a retired listener.
  `fmx control` from outside any Agent finds a live Runtime by probing Bus
  sockets, not by pid.
- Every `fmx control <command>` goes through `Multiplexer.handleControl`, and
  UI writes there take the paths the keys take (`switchTo`, `applyTrayWidth`).
  Launch is the intentional CLI-only exception: the TUI has no creation action.
  Detach is the intentional exception in the other direction: it is Client-local
  and must never acquire a control method.
- A launch from the CLI is background by default: `createAgent` only
  switches when asked or when nothing is on screen. `switchTo` never focuses a
  terminal while a modal is up; the modal hands focus back when it closes.
- `awaiting_work` is why `agent wait` is trustworthy right after `launch`
  or `send`: fx reports idle at startup before the pasted prompt reaches it.
  The flag is set when a prompt is queued and cleared by `PromptQueued`. If
  that record drops, an idle boundary observed after the latch was set followed
  by the next working or blocked snapshot also proves new work; an untyped
  sequence gap or ordinary current-turn event does not.
- The ADE socket's path is stable per Home, so an Fx that outlives the fmx that
  started it reports to the next Runtime. `AdeSocket.start` takes a flock on
  `/tmp/fmx-<uid>/<home id>.lock`. It holds that lock for the life of the
  process and only under it probes, unlinks, and binds:
  when the flock is held it waits one bounded handoff window for a predecessor
  finishing terminal teardown, then refuses a holder that remains. It never
  touches the socket without first acquiring the flock. Once acquired,
  a path something answers on is another fmx for this Home, refused with
  exit code 2, and never unlinked — only the process that bound the socket
  removes it. Only a path nothing answers on is the residue of a crash and
  replaced. The join runs after the ADE bind, because only its singleton holder
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
- Every file fmx owns lives under `/tmp/fmx-<uid>`, created 0700 and refused
  when it is not ours or is open to others — the same check the Companion's
  own directory gets, made before anything is bound into it. A socket in a
  world-writable directory is one another user can take the moment the
  Runtime that held it exits and unlinks it, and the Fx processes that
  outlive it would report to whoever took it. `fmx control` finds a live fmx
  by scanning that directory, so a name inside it is a Home id and nothing
  else.
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
  anything; its exit code says whether a start would get past both the
  Companion checks (found, pinned build, private directory) and Fx's fxnk
  compatibility probe. An overridden Companion build remains the developer's
  and is reported rather than judged. Keep `--version` one line — the
  installer and the release script compare it whole.
- Moving the pin is a release act: land the fork change on `integration`,
  push, put the commit and `<fork version>+fmx.<12 hex>` in
  `companion.json`, re-check the Companion notices, release the pair. The
  pinned build is always made by `scripts/build-companion.sh` — the release
  script, `scripts/install-companion.sh` (the editable checkout's
  `~/.local/bin/fmx-zmx`, which agentstart installs and zmax's pin step
  refreshes), and nothing else; one build path, one set of flags. 
- Blob retains only the current fmx version. The release workflow uploads and
  publicly byte-verifies the complete replacement plus `setup.sh` and
  `latest.txt` before it deletes any older `releases/v<version>/` path. Never
  prune the current release to make room for its replacement; prune older
  releases first when capacity is needed, then remove the former current
  release only after the new one is public.
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
