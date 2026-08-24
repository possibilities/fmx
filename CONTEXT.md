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
The final Detach ends the Runtime and its non-persistent Tools, while the
Companion continues to hold every Agent and persistent Tool.
_Avoid_: exit or close for an Agent, control command, quit.

**Companion** — the zmx fork fmx bundles as `fmx-zmx`: a daemon that owns a
terminal process and its PTY — an fx Agent, a persistent Tool, or the Runtime.
fmx drives one over a
versioned Unix socket instead of owning the PTY itself, and never through the
`zmx` a human may have installed — a Companion keeps its own sessions in its
own directory.
_Avoid_: backend, host, server, zmx for the thing itself — though zmx is
still the right word for the wire protocol it speaks and the environment
variables that protocol defines, the way `HERDR_*` names fx's.

**Companion pin** — `companion.json`: the fork commit an fmx release is built
with and the build string a Companion built from it reports. The pair is the
unit of release; fmx refuses a Companion beside it or on `PATH` that reports
any other build, and runs one named by `FMX_ZMX_PATH` with a word about it,
because that override is how a checkout develops the two together.
_Avoid_: lock file, version file, dependency.

**Home** — one fmx configuration directory (`~/.config/fmx`, or
`$XDG_CONFIG_HOME/fmx`) and the identity that follows from it: a short digest
of the directory's path, which labels every Companion session the Home creates
and keys its agent socket. One Home has at most one Runtime, may have several
Clients, and owns the Agents its Companion holds between Runtime lifetimes.
_Avoid_: profile (that is a launch level's rejected synonym, and `fx-profile`
is fx's own settings), installation, workspace.

**Manifest** — `~/.config/fmx/agents.json`, the Home's own record of the
Agents its Companion holds: one entry per Agent carrying its identity,
display number, directory, the fx it runs, and the last Agent-socket status
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
derived again from fx's control records and live locks.
_Avoid_: replay, resync, history.

**Agent socket** — the Unix socket fmx binds and points every agent at, and
over which fx reports its own lifecycle. One socket serves all agents.
_Avoid_: status socket, control socket, IPC socket.

**ADE feed** — the private one-way Unix socket beside the Agent socket over
which fx publishes ordered raw events. Each record carries the stable Manifest
Agent identity and eager session context; gaps trigger recovery from fx's
durable state, while unknown additive schema-1 events remain ignorable.
_Avoid_: Agent socket, control socket, event bus.

**Pane id** — the opaque string that identifies an agent on the agent
socket. It is the wire's word, not fmx's: fx addresses every request to a pane
id, so fmx mints one per agent and never uses the term anywhere else. It is
`p_<agent id>`, the same token as the Companion session name
`fmx-<agent id>`, which is why an fx keeps reporting to the right Agent
across fmx restarts.
_Avoid_: agent id (that is the Manifest's 128-bit token; the number
exported as `FMX_AGENT_ID` is the display id).

**Frame** — one of fx's requests over the agent socket: the raw line plus what
fmx decoded from it. fmx's replies are not frames — they are generated by fmx,
identical every time, and say nothing about fx.
_Avoid_: message, packet, event.

**Tools panel** — the resizable terminal dock to the right of the active
Agent. Its configured terminal tools run in that Agent's directory and
identity, switch context with it, and appear as a rule tab when more than one
is available. The dock starts hidden, remembers its visibility,
width, and selected tool, and does not exist when no configured tool is
available. Persistent tools are owned by the Companion across Runtime
lifetimes; non-persistent tools are recreated naturally with the Runtime.
_Avoid_: tool panel, right-hand panel, utility pane, inspector, global panel.

**Rule tab** — the Tools panel's two-row switcher: tool labels over a hairline,
the selected label bold in the foreground with the hairline drawn heavy beneath
it, every other label dim. State is weight and glyph, never hue or underline.
fx has no tab surface to copy; this is fmx's own, derived from fx's principles
and recorded as a carve-out in fxnk's style guide.
_Avoid_: link rail, tab bar, underlined tab, accent tab.

**Ramp** — the gray steps every surface fmx draws itself is painted in:
foreground, accent, secondary, dim, and divider, plus a surface fill below
the divider, each a fixed fraction of the way from the host terminal's
background to its foreground in fx's own ratios (`hostRamp` in
`src/host-palette.ts`). A host that answers no color query gets fx's dark
grays exactly. Two hues survive it, each with one job: focus, the host's
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
Depth is carried by indentation alone, with no connecting glyphs.
Clicking an agent row switches to that agent; project and branch rows are
not selectable. The switch happens on mouse-down and tray text itself is
not selectable, so pointer navigation never waits for release. Project and
branch labels are the Ramp's foreground (a virtual branch its secondary
step, italic) and agent names its dim step; the status icon carries its
state by shape and weight, never hue — blocked bold in the foreground, done
in the accent step, the rest dim. Before the host
palette answers, names are the terminal's own ANSI gray, and — like the
selected-row fill and the divider — what was drawn at first paint stays
through a late initial answer. The selected agent's stable Agent identity is
machine state, restored before the first frame so detach and reattach do not
move focus back to agent one.
_Avoid_: agent panel, tab bar, session picker.

**Subagent row** — a non-selectable Session list row for an fx subagent whose
filesystem control record names a visible Agent's session as its parent.
It uses the agent-row status icon and nests recursively beneath that parent;
its state comes from the control record and the subagent's own session lock.
_Avoid_: child pane, sub-agent.

**Path** — the active agent and its ancestors. The active row takes the
Ramp's surface fill and its ancestors are set in bold; nothing else marks
them, so two faint backgrounds never have to be told apart.
_Avoid_: selection, breadcrumb.

**Project root** — a directory named by `project_roots` whose children are
offered as projects, along with the root itself. Roots are scanned one level
deep and never recursively; a root that is not on this machine contributes
nothing. A Home must configure at least one before its TUI can start; its first
root is fmx's working directory and the default for a direct new Agent.
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
has reported itself over the agent socket. An agent launched with one is
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
project with no commit to branch from cannot offer one.
_Avoid_: branch, checkout, clone.

**Project picker** — the filterable list the launch dialog opens on space.
Typing filters by subsequence, so `agl` finds `agentlaunch`; enter applies the
highlighted project to the row rather than starting anything. Dismissing it
changes nothing.
_Avoid_: overlay, palette, fuzzy finder.

**Launch count** — how many agents have been started in a directory, kept
in `state.json` and incremented by every start whichever key opened it. It
orders the project picker and is never drawn in it.
_Avoid_: frecency, history, usage.

**Git context** — the worktree root and branch fmx reads for an agent's
directory, because fx never reports where it is working. An agent outside a
repository has none and nests under a virtual `(untracked)` branch in the
session list.
_Avoid_: repo info, workspace.

**Agent record** — what fx has reported about one pane: state, attention, and
label folded from Agent-socket frames, plus the eager ADE session identity when
available and the legacy frame identity otherwise. On restore it begins at the
Manifest's last socket-truth checkpoint. Which pane a human is looking at is
fmx's own knowledge and lives in the multiplexer.
_Avoid_: session state, pane state.

**Seen** — whether the human has had an agent in front of them since its
state last changed, tracked as a registry-local state version per agent
rather than a clock. An idle agent that is not seen is **done** — finished and
unacknowledged — which is the only difference between the `✓` and `○` icons.
_Avoid_: read, acknowledged, unread.

**Session name** — the native display name fx persists for a session and
changes through `/rename`. Fx may infer it from the first admitted prompt and
reports committed changes over ADE as `SessionMetadataChanged`; fmx only reads
that authority, shows the name, and uses exact matches as control targets.
Duplicate names remain ambiguous. The Fx storage and event schema call the
field `title`.
_Avoid_: fmx name, label.

**Control socket** — the Unix socket `fmx control <command>` drives a running Runtime
through, bound beside the agent socket as `/tmp/fmx-<uid>-<home id>.ctl` — as
stable as it, so an fx that outlives one fmx still reaches the next — and
handed to every agent as `FMX_SOCKET_PATH`. Its own wire, not the agent socket's: that
one speaks fx's protocol and answers before it acts, where a command needs its
result. One request per connection; a waiting method holds the connection.
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
`agent send`, and which fx has not yet reported working on. A wait holds
through it: the idle fx reports at startup is not the idle that means finished.
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
