# fmx agent notes

- fmx is a terminal multiplexer driven over a socket. It starts arbitrary
  commands in Companion-held PTYs, draws them in a Layout a caller applies,
  and reports what changed. It knows nothing about what a Session runs — no
  agent, harness, lifecycle, or model concept lives here, and none may be
  added. A program that needs those reads screens through `session.capture`
  and owns them itself.
- `CONTEXT.md` is the glossary; use its terms in code, docs, and commits.
  `docs/adr/` holds the decisions, and a superseded record keeps the words it
  was written with rather than being rewritten.
- **The API is the product.** Every method, param, result, event, and error
  code is defined once in the contract table in `src/protocol.ts`, validated
  by the Runtime from that definition, printed by `fmx api`, and described in
  `docs/api.md` in the same commit. `tests/vocabulary.test.ts` fails when
  `docs/api.md` omits a method; the rest is judgement, in the same commit.
- The CLI is `start`, `attach`, `stop`, `status`, `api`, `doctor`, and the
  hidden `runtime` verb the Companion execs. Do not add a verb for anything
  the API owns. `fmx` with no verb starts if needed and attaches.
- fmx claims exactly one chord. The prefix (`ctrl+b`) is a latch the thin
  Client holds until the next key proves it is not Detach; every other key,
  the prefix included, reaches the focused Session unchanged. There is no
  help surface, no switching key, no toggle. `config.toml` holds `[keys]`
  with `prefix` and `detach` and nothing else — that grammar is deliberately
  shared with Herdr's, but do not mention Herdr in user-facing text.
- **Focus is the API's alone.** `PaneTerminalRenderable` overrides OpenTUI's
  focus so a left mouse-down forwards its mouse report and moves nothing;
  only `Stage.applyFocus` may grant it, through `takeFocus`. A keyboard that
  follows the pointer is one a program driving the Layout cannot reason
  about.
- Applying a Layout must mutate only what moved. Every Pane is absolutely
  positioned at the rectangle `layout.ts` computed, so one apply is one
  layout pass; a Pane whose rectangle is unchanged is not resized, so its
  emulator neither reflows nor tells its PTY anything and a Session that
  stays on screen never blinks. Keep it that way: the fast, clean transition
  is the feature.
- A Session's size authority is `Session.size`, seeded from the create
  request and updated only by `onTerminalResize`. Never read the
  renderable's own `width`/`height` for it: OpenTUI excludes an invisible
  renderable from the layout pass, so a Pane that has never been drawn
  reports one cell, and a transport opened at that size would tell its PTY
  the screen is 1×1.
- `session.capture` composes the emulator into a buffer of fmx's own
  (`PaneTerminalRenderable.captureScreen`). OpenTUI's `screen()` reads the
  frame buffer a render pass fills, which a hidden Pane never gets, and
  `onScreenChange` fires per rendered frame and only while visible — neither
  is usable. Change detection is byte-driven and debounced instead.
- The Layout carries a revision, moved on by every apply and every divider
  drag. `layout.apply` with an older revision is refused as a conflict so a
  human's drag is never silently undone; omitting it writes unconditionally.
- **The API socket is the Instance singleton.** It is claimed under a lock
  before anything is adopted, so two Runtimes can never hold the same
  Sessions, and requests arriving during adoption wait rather than being told
  the Sessions do not exist. Its path is `/tmp/fmx-<uid>/<instance id>.api`.
- **fmx stores nothing.** The Companion applies a Session's labels before its
  loop accepts any client, so labels are the record: adoption is one
  `list --json` filtered by label and name. There is no Manifest, no claim to
  write before creating, no `markRunning` after, and no crash window between
  them. The Instance id is derived from its name, so nothing fmx could lose
  can cost an Instance its Sessions.
- An adopted Session's `argv` is null. The Companion reports a shell-quoted
  display string cut at 256 bytes; it is for reading, never for re-running.
- The Runtime is headless. It renders into its Companion PTY and holds its
  Sessions with no terminal attached, and ends only on `instance.stop`, a
  signal, or a crash — never because the last Client left. Do not restore the
  `--exit-on-last-client` lifecycle or a bootstrap marker.
- Theme: a headless Runtime asks nothing (`resolveFxnkTheme` with a zero
  timeout takes `FMX_THEME`, then `COLORFGBG`, then dark), and the first
  Client samples its own terminal before relaying anything, then sends the
  same CSI 997 notification a terminal would. The existing live-theme path
  does the rest: drain stale replies behind a DA1 fence, sample OSC 11 behind
  a second fence, discard a sample superseded by a newer notification, then
  replace the complete fixed token set in one render turn.
- Every color fmx paints comes from `fxnkRamp` (`src/host-palette.ts`):
  fixed indexed roles `255/252/250/245/240` in dark and `235/238/241/247/250`
  in light, plus the surface/unused carve-outs `236/235` and `254/255`. Focus
  and error are direct ANSI slots `4` and `1`, never sampled from the host.
  The canvas stays the terminal default.
- A Runtime resize applies the new physical size to OpenTUI synchronously,
  then clears the whole physical screen before its next frame, inside one
  synchronized-output update. Input can arrive before OpenTUI's debounced
  SIGWINCH handler; applying size first prevents that interaction from
  painting one last frame at the previous owner's size. The clear is what
  leaves genuinely blank unused space on a larger observing Client.
- A terminal Client conceals its physical cursor before asynchronous
  preflight, prepends RIS and concealment to the first actual Restore bytes
  in the same write, and emits nothing at all for an empty cold-Runtime
  Restore so the shell surface stays intact. Every failure path must end
  synchronized output and reveal the cursor.
- `keys.detach` is intercepted by the thin Client and disconnects only that
  Client. There is deliberately no Detach method: a program does not own a
  physical terminal connection. Detaching never ends a Session or the
  Runtime.
- Everything that carries a Session's terminal goes through
  `SessionTransport` (`src/session-transport.ts`), and the one implementation
  in `src/` is the Companion's. The Bun PTY behind the same seam lives in
  `tests/fixtures/pty-transport.ts` so the Runtime suites run without a
  Companion — keep it a fixture; a second production transport is what the
  seam exists to prevent.
- A lost transport is not an exit. `Sessions.recover` re-attaches a live
  session (replaying onto the reset emulator), removes one that ended exactly
  as an Exit would, and leaves one it cannot reach after a few tries in the
  roster as `unreachable`, where the next start's adoption finds it.
- `session.exited` carries `code` and `signal` as nullable with a `reason`
  that always says something. Nothing in fmx acts on the exact status, so a
  Companion that cannot read one (a migrated PTY, say) degrades honestly
  rather than breaking a consumer.
- A child's environment is fmx's own with `FMX_*`, `ZMX_*`, `TMUX*`, and
  `HERDR_*` removed, plus the caller's `env`. A Session must never be able to
  tell it is inside fmx, or report against an outer pane.
- `fmx-mcp` is gone, along with the Runtime bridge, ADE, work control,
  subagents, the Manifest, the Tray, the picker, Projects, and Worktrees. Do
  not reintroduce any of them. The `.ade.sock`, `.bus`, `.ctl`, and `.obs`
  paths are unlinked as residue when the API socket binds.
- Every file fmx owns lives under `/tmp/fmx-<uid>`, created 0700 and refused
  when it is not ours or is open to others — the same check the Companion's
  own directory gets, made before anything is bound into it. A socket in a
  world-writable directory is one another user can take the moment the
  Runtime that held it exits and unlinks it.
- The Companion's directory is under `/tmp/fmx-<uid>/zmx`, not the config
  directory: macOS caps a socket path near 104 bytes, and sessions do not
  survive a reboot, so neither need their exit records. fmx sets `ZMX_DIR` on
  every command it runs.
- The Companion is resolved `FMX_ZMX_PATH`, then `fmx-zmx` beside the
  installed binary, then `fmx-zmx` on PATH, and its build (`fmx-zmx version`,
  first line) is compared to `companion.json`. Beside fmx or on PATH, a
  mismatch is fatal; under the override it is one stderr line, because the
  override is the development loop. `fmx doctor` runs the same resolution and
  check without binding anything.
- Moving the pin is a source-installation act: land the fork change on
  `integration`, push, put the commit and `<fork version>+fmx.<12 hex>` in
  `companion.json`, and re-check. The pinned build is always made by
  `scripts/build-companion.sh`, reached by `scripts/install.sh` and
  `scripts/install-companion.sh`; one build path, one set of flags.
- Fmx publishes no binaries, archives, installer payload, latest pointer, or
  release tag. `scripts/install.sh` is the consumer and operator path. The
  tested systems are macOS and Linux on arm64 and x86_64. Only
  `scripts/local-gate.sh` on the current Mac architecture blocks a merge.
- Bumping `PROTOCOL_VERSION` in `src/zmx-protocol.ts` (mirrored by the fork's
  `src/ipc.zig`) is a pair-wide event with survivors: daemons started by the
  previous Companion keep running the old protocol, and every running Session
  on the machine becomes unreachable at once. Before the first bump, build a
  **drain** (record each Session's Companion build and leave survivors on
  screen as unreachable, keeping the previous `fmx-zmx` beside the new one)
  or a **carry** (speak every protocol version a survivor may hold), and say
  which in an ADR. Drain is the cheaper first answer. Until one exists, the
  protocol version does not move. Note that `src/protocol.ts` is fmx's own
  API version and is unrelated.
