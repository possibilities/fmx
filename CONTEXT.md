# fmx glossary

**Agent** — one fx process together with the embedded terminal fmx renders
it in. Agents are numbered by fmx, keep their number across fmx restarts,
and disappear when their fx exits — never when fmx does: the Companion holds
the fx, and the next fmx for the Home attaches to it.
_Avoid_: pane, tab, window, session, instance.

**Runtime** — the one Companion-held fmx process and PTY for a Home. It owns
the renderer, Multiplexer, sockets, Manifest reconciliation, and shared UI;
it ends when its final Client leaves, while every Agent remains held by the
Companion.
_Avoid_: server, daemon, host, backend.

**Client** — one thin interactive `fmx` invocation and its physical terminal,
attached to the Home's Runtime. It relays terminal bytes and size, and alone
owns Detach; several Clients may watch and interact with the same shared UI.
_Avoid_: viewer, frontend, session, fmx instance.

**Sizing owner** — the Client that most recently connected or interacted by
focus, keyboard, mouse, paste, or resize. The Runtime renders once at its
dimensions; larger Clients have flat, host-theme-relative unused space and
smaller Clients crop the right and bottom until they interact and take
ownership.
_Avoid_: leader, primary, active Client, controller.

**Detach** — disconnecting one Client from the Runtime without ending an
Agent. `keys.detach` is Client-local; closing its terminal has the same result.
The final Detach ends the Runtime, while the Companion continues to hold every
Agent.
_Avoid_: exit or close for an Agent, control command, quit.

**Companion** — the zmx fork fmx bundles as `fmx-zmx`: a daemon that owns a
terminal process and its PTY — an fx Agent or the Runtime. fmx drives one over a
versioned Unix socket instead of owning the PTY itself, and never through the
`zmx` a human may have installed — a Companion keeps its own sessions in its
own directory.
_Avoid_: backend, host, server, zmx for the thing itself — though zmx is
still the right word for the wire protocol it speaks and the environment
variables that protocol defines.

**Companion pin** — `companion.json`: the fork commit an fmx release is built
with and the build string a Companion built from it reports. The pair is the
unit of release; fmx refuses a Companion beside it or on `PATH` that reports
any other build, and runs one named by `FMX_ZMX_PATH` with a word about it,
because that override is how a checkout develops the two together.
_Avoid_: lock file, version file, dependency.

**Home** — one fmx configuration directory (`~/.config/fmx`, or
`$XDG_CONFIG_HOME/fmx`) and the identity that follows from it: a short digest
of the directory's path, which labels every Companion session the Home creates
and keys its stable ADE and control sockets. One Home has at most one Runtime,
may have several Clients, and owns the Agents its Companion holds between
Runtime lifetimes.
_Avoid_: profile (that is a launch level's rejected synonym, and `fx-profile`
is fx's own settings), installation, workspace.

**Manifest** — `~/.config/fmx/agents.json`, the Home's own record of the
Agents its Companion holds: one entry per Agent carrying its identity,
display number, directory, the fx it runs, and the last ADE lifecycle
checkpoint, written before the Companion is asked to start anything and
removed when the Agent ends. A claim, not the truth: the Companion's
sessions are the truth, and a start joins the two — attaching what both know,
adopting what only the Companion holds, dropping what only the Manifest
remembers. It keeps no prompt text.
_Avoid_: registry (that is the agent registry), state file (that is
`state.json`), session list.

**Transport** — what carries one Agent's terminal between fmx and the
Companion: bytes out, bytes in, the size, and the two ways it ends — fx
ending, with a status, against the transport itself dropping, which says
nothing about fx. The seam `FxAgent` renders through; the Companion's
socket is the only one fmx ships.
_Avoid_: connection (that is the socket underneath), PTY, backend.

**Restore** — what the Companion sends first on every attach: the Agent's
whole terminal as it stands, between a `RestoreBegin` the visible terminal
resets at and a `Ready` after which bytes are live. A reconnect replays onto
a clean screen for the same reason a first attach does. The Agent's last
reported agent status is seeded before its row can render; subagent status is
derived again from fx's control records and live locks, then driven by live ADE
snapshots.
_Avoid_: replay, resync, history.

**ADE feed** — the private, one-way, stable-per-Home Unix socket over which Fx
publishes ordered lifecycle events for every Agent and subagent. It is fmx's
sole Fx lifecycle source: each record carries the stable Manifest Agent
identity, session context, and a complete state-and-attention snapshot, so an
unknown additive event or the first record after a gap repairs live state;
session-name gaps additionally recover from Fx's durable display record.
_Avoid_: control socket, event bus, request/reply channel.

**Pane id** — the retained opaque control and Companion-label identity for an
Agent, `p_<agent id>`. fmx exposes it as `pane_id`, accepts it as a Target, and
keeps it in the Manifest beside the Companion session `fmx-<agent id>`; it no
longer addresses an Fx lifecycle protocol.
_Avoid_: agent id (that is the Manifest's 128-bit token; the number
exported as `FMX_AGENT_ID` is the display id).

**Ramp** — the gray steps every surface fmx draws itself is painted in:
foreground, accent, secondary, dim, and divider, plus a surface fill below
the divider and an unused-field fill below every surface, each a fixed
fraction of the way from the host terminal's background to its foreground
(`hostRamp` in `src/host-palette.ts`). The unused field is the 6% step and the
surface fill the 12% step, so both remain visible even on a pure-black canvas.
A host that answers no color query gets fx's dark grays and those two derived
fills exactly. Two hues survive it, each with one job: focus, the host's
blue, on the border of a surface that takes keys and on the caret and
cursor; error, the host's red, on the border of a surface that reports a
failure. A state is a glyph and a weight, never a hue.
_Avoid_: theme, palette (that is the host's answer), modal colors.

**Toast** — a transient, bottom-center notice drawn over the active surface:
foreground text on the Ramp's surface fill inside a dim hairline, which only
a notice reporting a failure colors, in the error hue. Toasts appear one at a
time in arrival order and do not take focus.
_Avoid_: status bar, modal, success toast.

**Tray** — the collapsible left column that carries the Session list: hidden
while no agent runs or when toggled away, resizable by its divider, its width
and visibility remembered across runs.
_Avoid_: sidebar, panel.

**Session list** — the tray's tree of running agents: project, then
branch, then one row per agent carrying its status icon and its name — the
native session name once fx reports one, the short session id until then.
An agent whose Git context git has no answer for hangs straight off its
project, one rung shallower, rather than under a stand-in branch.
Depth is carried by indentation alone, with no connecting glyphs.
Clicking an agent row switches to that agent; project and branch rows are
not selectable. The switch happens on mouse-down and tray text itself is
not selectable, so pointer navigation never waits for release. Project and
branch labels are the Ramp's foreground and agent names its dim step; the
status icon carries its state by shape and weight, never hue — blocked bold
in the foreground, done in the accent step, the rest dim. Before the host
palette answers, names are the terminal's own ANSI gray, and — like the
selected-row fill and the divider — what was drawn at first paint stays
through a late initial answer. The selected agent's stable Agent identity is
machine state, restored before the first frame so detach and reattach do not
move focus back to agent one.
_Avoid_: agent panel, tab bar, session picker.

**Subagent row** — a non-selectable Session list row for an fx subagent whose
parent is a session fmx tracks. It uses the agent-row status icon and nests
recursively beneath that parent; its state comes from the subagent's own ADE
snapshots once its feed has spoken, and from the filesystem control record and
session lock until then. Fx's control record owns the parent, and a child
whose parent is no longer tracked is dropped rather than kept alive by its
feed.
_Avoid_: child pane, sub-agent.

**Path** — the active agent and its ancestors. The active row takes the
Ramp's surface fill and its ancestors are set in bold; nothing else marks
them, so two faint backgrounds never have to be told apart.
_Avoid_: selection, breadcrumb.

**Project root** — a directory named by `project_roots` whose children are
offered as Projects, along with the root itself. Roots are scanned one level
deep and never recursively; a root that is not on this machine, or not inside
a repository, contributes nothing. A Home must configure at least one before
its TUI can start; its first root is fmx's working directory and what the
launch dialog opens on when no agent is active.
_Avoid_: workspace root, search path, scan directory.

**Launch dialog** — the modal that gathers what an agent is started with
before fx runs: a prompt, a project, whether to cut a worktree, and the launch
level, one row each. `tab` moves between rows; a chooser row answers a letter
by cycling to the next value starting with it, and space opens its picker.
_Avoid_: new tab modal, launcher, form.

**Launch level** — the Codex model and reasoning effort a new agent starts
with, passed to that fx alone through `FX_MODEL` and `FX_EFFORT`. Its allowed
pairs come from fmx's small local catalog because fx does not expose the effort
metadata from its provider catalog through `fx models --json`.
_Avoid_: profile, preset, provider setting.

**Launch prompt** — the text an agent starts working on. fx takes no prompt
on its command line, so fmx pastes it into the terminal and sends it once fx
has published that Agent's first ADE record. An agent launched with one is
therefore already working when it is first looked at.
_Avoid_: intent, initial message, seed.

**Prompt editor** — the launch dialog's prompt row: OpenTUI's textarea, which
is a real line editor. Everything readline-shaped is the widget's; fmx owns
only the kill ring it yanks from and the handoff to `$EDITOR`. It takes keys
through the renderer's dispatch to the focused renderable, so the dialog lets
its keys through rather than swallowing them, and a blurred field is what
leaves a letter on another row free to cycle.
_Avoid_: input, textarea, prompt field.

**Worktree** — a checkout fmx cuts for a launch, branched from what the chosen
project has checked out. Its branch and its directory share one name,
`<project>-<ordinal>`, and the ordinal counts against the main repository, so
launching from inside `fmx-1` produces `fmx-2` rather than `fmx-1-1`. A
Project with no commit to branch from cannot offer one, which is the only
thing the launch dialog's Worktree row has left to ask.
_Avoid_: branch, checkout, clone.

**Project** — a directory an agent can be started in, which is to say a
directory inside a git repository whose branch can be named. A Project root
and its children qualify or they are not offered, a named directory that does
not is refused, and a repository with nothing committed yet is a Project — its
unborn HEAD still names the branch the Session list draws — that simply cannot
offer a Worktree. A HEAD naming neither a ref nor a commit names no branch,
so it is not a Project at all.
_Avoid_: workspace, folder, tracked directory.

**Project picker** — the filterable list the launch dialog opens on space.
Typing filters by subsequence, so `agl` finds `agentlaunch`; enter applies the
highlighted project to the row rather than starting anything. Dismissing it
changes nothing.
_Avoid_: overlay, palette, fuzzy finder.

**Launch count** — how many agents have been started in a directory, kept
in `state.json` and incremented by every start whichever key opened it. It
orders the project picker and is never drawn in it.
_Avoid_: frecency, history, usage.

**Git context** — the worktree root and branch fmx reads from the launch
directory it owns rather than treating lifecycle context as repository
authority. Every launch is held to one, so an agent without a context is a
checkout that went away under a running one: its Session list row hangs
straight off its project, with no rung standing in for the branch that is not
there.
_Avoid_: repo info, workspace, untracked.

**Agent record** — what Fx's ADE snapshots report about one Agent: state,
attention, and session identity. On Restore it begins at the Manifest's last
ADE checkpoint; any later record replaces that state even when the transition
event itself was dropped. Which Agent a human is looking at is fmx's own
knowledge and lives in the Multiplexer.
_Avoid_: session state, pane state.

**Seen** — whether the human has had an agent in front of them since its
state last changed, tracked as a registry-local state version per agent
rather than a clock. An idle agent that is not seen is **done** — finished and
unacknowledged — which is the only difference between the `✓` and `○` icons.
_Avoid_: read, acknowledged, unread.

**Session name** — the native display name fx persists for a session and
changes through `/rename`. Fx may infer it from the first admitted prompt, in
which case the name is a lowercase hyphenated slug, and reports committed
changes over ADE as `SessionMetadataChanged`; fmx only reads that authority,
shows the name, and uses exact matches as control targets.
Duplicate names remain ambiguous. The Fx storage and event schema call the
field `title`.
_Avoid_: fmx name, label.

**Control socket** — the Unix socket `fmx control <command>` drives a running
Runtime through, bound beside the ADE feed as
`/tmp/fmx-<uid>-<home id>.ctl` — as stable as it, so an Fx that outlives one
fmx still reaches the next — and handed to every Agent as `FMX_SOCKET_PATH`.
It is fmx's request/reply wire, separate from the one-way feed. One request per
connection; a waiting method holds the connection.
_Avoid_: command socket, API socket, RPC.

**Orientation** — what `fmx control orient` answers: the caller's own agent as
`you`, every agent, the tray's rows as drawn, and whatever surface is
open. A read, which never marks anything seen.
_Avoid_: status, state dump, introspection.

**Draft** — one opening of the launch dialog, addressable by id from the
moment it opens until it is submitted or cancelled, and readable after. Every
opening is one, whether a key or an agent opened it, so an agent can finish a
dialog the human started and a human can finish one an agent prefilled. Ids
exist so an agent can never submit a draft it did not mean to.
_Avoid_: pending launch, form state, staged launch.

**Target** — how a command names an agent: its id, `current` for the
caller's own, `active` for the one on screen, `next` or `previous` relative to
it, or an exact session name, with a session-id prefix as the fallback.
_Avoid_: selector, handle, address.

**Awaiting work** — an agent whose prompt has gone in, by launch or by
`agent send`, and for which fmx has not yet observed Fx admit that prompt. A
wait holds through it: the idle snapshot at startup is not the idle that means
finished, and unrelated work already in flight is not the new prompt.
_Avoid_: busy, pending, queued.

**UI gallery** — the developer-only TUI that browses fmx-owned OpenTUI
components and blocks. Each component has executable states that mount the real
renderables under deterministic fakes; the selected theme — a dark host, a
light host, or the fallback tier a host that answered nothing gets — applies
to the whole gallery independently of the selected component and state. Useful
states can accept their real keys and mouse controls inside an isolated
exact-size renderer. `gallery:check` renders and asserts every state under
every theme headlessly.
_Avoid_: Storybook (there is no Storybook runtime), screenshot suite.
