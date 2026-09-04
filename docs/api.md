# The smolmux API

Everything past `start`, `stop`, and `attach` is this API. One duplex Unix
socket per Instance, newline-delimited JSON, defined once in
`src/protocol.ts` and printed whole by `smolmux api`. This document is the prose
half; the schemas there are the machine-readable half, and a test fails when
one of them names a method this file does not.

## Connecting

`smolmux start` prints the socket path, and `smolmux status` reports it again. It is
`/tmp/smolmux-<uid>/<instance id>.api`, mode 0600, inside a directory created
0700 and refused when it is not yours.

Frames are one JSON object per line:

```json
{"v":1,"type":"request","id":"1","method":"session.create","params":{"name":"tray","argv":["tray"],"cwd":"/Users/you/code/agentwork"}}
{"v":1,"type":"response","id":"1","ok":true,"result":{"name":"tray","pid":8412,"…":"…"}}
{"v":1,"type":"response","id":"2","ok":false,"error":{"code":"not_found","message":"no Session named docs"}}
{"v":1,"type":"event","event":"session.exited","data":{"name":"tray","code":0,"signal":0,"reason":"natural"}}
```

A connection is long-lived and may carry any number of requests. `id` is the
caller's; a response carries it back. Requests are answered in the order they
arrive. After `events.subscribe`, that same connection also receives event
frames until it hangs up.

## The model

An **Instance** is one running smolmux: a Runtime, its Sessions, and one Layout.
A **Session** is a command in a Companion-held PTY, named by its caller. The
**Layout** is a tree of rows and columns whose leaves are **Panes**, each
showing one Session or one line of text. The **Stage** is the drawn area,
sized by whichever terminal Client interacted most recently.

A Session runs whether or not a Pane shows it, and it outlives the Runtime:
the Companion holds it, labelled with the Instance's id, and the next
Runtime adopts it. smolmux stores nothing of its own.

## Methods

### `instance.status`

The Runtime as it stands: version, pid, Instance name and id, socket path,
stage size, theme, every Session, and the Layout. Takes no params.

### `instance.stop`

Kills every Session, then answers and ends the Runtime. Every Client
detaches, and `instance.stopping` goes out just before teardown. Takes no
params.

The kills come first so the answer can be about what happened. When any
Session cannot be ended, the call is refused with `companion_error` naming
what survived and **the Instance stays running** — nothing is torn down, so
`session.list` still names what is left and a retry goes to the same Instance.
Reporting success there would leave live processes with nothing managing them
and a caller who believes they are gone.

Success therefore means every process is gone. It does not retry on your
behalf; retry the call.

### `events.subscribe`

Marks this connection a subscriber; it then receives every event frame until
it hangs up. Takes no params.

### `session.create`

Starts a command in a Companion-held PTY.

```json
{"name":"tray","argv":["tray"],"cwd":"/Users/you/code/agentwork",
 "env":{"AGENTMUX_SOCKET":"/tmp/…"},"cols":26,"rows":30,"labels":{"role":"list"}}
```

`name` is the caller's, unique per Instance, `[a-z][a-z0-9_-]{0,31}`. `argv`
is the executable first, exec'd directly — there is no shell, so nothing
needs quoting. `cwd` is absolute. `env` is applied over smolmux's own environment
with its private variables (`SMOLMUX_*`, `ZMX_*`, `TMUX*`, `HERDR_*`) removed.

The removal comes first and `env` is applied on top, which is the escape hatch
for the one case that wants those variables back: a Session that hosts the
program *driving* this Instance. Every ordinary Session should not believe it
is inside smolmux, but a controller needs to find its way home, and a hosted
controller that inherits nothing will fall back to the default Instance and
quietly build a second one. Forward what it needs explicitly —
`SMOLMUX_CONFIG_PATH`, `SMOLMUX_ZMX_DIR`, `SMOLMUX_ZMX_PATH` — rather than
relying on inheritance that is designed not to happen.
`cols` and `rows` size the PTY until a Pane sizes it, 80×24 by default.
`labels` are kept on the Companion session and returned on adoption; `owner`,
`instance`, `session`, and `kind` are smolmux's own and refused.

Returns the Session. A duplicate name is `conflict`.

### `session.kill`

Asks the Companion to end a Session's process. Returns as soon as the daemon
accepts; the removal arrives as `session.exited`.

### `session.list`

Every Session in creation order. Each carries its name, pid, cwd, argv (null
when adopted), creation time, title, size, whether a Pane shows it, its state
(`live` or `unreachable`), and its labels.

### `session.capture`

A Session's screen as text, with its cursor and title, shown or not. This is
the screen-reading surface: pair it with `session.changed` and capture only
what moved.

```json
{"name":"tray","lines":["agents","  reviewer"],"screen_start":0,"cols":26,"rows":30,
 "cursor":{"x":0,"y":2,"visible":true},"title":"the tray","state":"live"}
```

Trailing blank lines are trimmed, and the cursor is relative to the visible
screen.

`state` is `live`, or `unreachable` when the Session's transport is gone. A
capture still answers then, because it composes this process's own emulator
rather than asking the Companion — the screen that Session last had is the
only way to see what it was doing when it dropped, which is when you most
want to look. `state` is there so that screen is never mistaken for a current
one. Input to an unreachable Session is refused rather than dropped, so the
two calls differ deliberately: a capture still claims only that these bytes
were received, and that stays true.

`scrollback` asks for that many lines that have scrolled off the top, up to
10,000. They come first in `lines`, and `screen_start` is the index where the
visible screen begins, so `lines.slice(screen_start)` is exactly what a
capture without `scrollback` would have returned.

```json
{"name":"build","scrollback":500}
```

History is read from the Session's own emulator, not fetched from the
Companion, so it costs no round trip and works for a Session whose transport
is currently lost. A visible-only capture is unaffected; asking for the full
10,000 lines costs about 20 ms.

Three things it cannot give you. History older than the emulator kept is gone.
A run of identical blank screens in the middle of history collapses, because
pages are joined where they overlap. And a Session that has reattached, which
happens whenever its transport drops or a Runtime restarts, is missing about
one screenful of history per reattach: the Companion's restore clears the
screen between replaying scrollback and redrawing the viewport, so the lines
just above the viewport are lost. The visible screen always survives intact.

### `session.input`

Delivers input to a Session as a human at its keyboard would: keys, typed
text, a paste, and mouse. Events apply in order, so one call is also the unit
of ordering.

```json
{"name":"reviewer","events":[
  {"text":"git status"},
  {"key":"enter"},
  {"key":"c","ctrl":true},
  {"mouse":{"action":"down","button":"left","x":4,"y":2}}
]}
```

Nothing here is an escape sequence, and nothing should be. The Session's own
emulator encodes every event for the modes that Session turned on — Kitty or
legacy keys, cursor-key mode, bracketed paste, whichever mouse reports it
asked for — because it is the only thing that knows them. The bytes then take
exactly the path a human's keystroke takes, out to the same PTY.

Four kinds of event:

- `{"key":…}` is one press. `key` is a named key — `enter`, `escape`, `tab`,
  `backspace`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`, `up`,
  `down`, `left`, `right`, `space`, `f1`–`f24` — or a single character.
  `ctrl`, `alt`, `shift` and `super` are the modifiers; `action` is `press`
  (the default), `repeat` or `release`.
- `{"text":…}` is delivered one key press per character, which is what typing
  looks like to a program.
- `{"paste":…}` is delivered whole, bracketed when the Session turned
  bracketed paste on, so a program can tell it from typing and decline to act
  on it.
- `{"mouse":…}` is an `action` of `down`, `up`, `move`, `drag` or `scroll`,
  with `button` (`left` by default), the modifiers, and `x`/`y`. A `scroll`
  needs its `direction` and `delta`.

`x` and `y` are cells from the Session's own top-left corner, never the
stage's, so a caller addresses one Session's screen and cannot reach past it
into a neighbour. Mouse therefore needs a Pane: a Session no Pane shows has no
coordinates, and mouse on it is `not_found`. Keys, text and paste do not care,
and reach a Session running off the Layout.

**Input never moves focus.** A left button-down here does not take the
keyboard any more than a human's click does; `layout.apply` remains the only
thing that decides where the keyboard goes. Nor does input depend on focus —
the call names the Session it is for.

At most 256 events per call, 4,096 characters of `text`, and 65,536 of
`paste`. The batch is checked before any of it is applied, so a call that
cannot be delivered whole delivers nothing.

### `layout.apply`

Replaces the Layout and names the Session the keyboard goes to.

Before the first apply, the Layout on screen is the Runtime's own and follows
the roster: the first Session, or the line `no sessions` when there are none.
The first apply takes ownership, and the Runtime composes no Layout after
that however the roster moves.

```json
{"root":{"row":[
   {"column":[{"text":"notes","size":8},{"session":"tray"}],"size":26,"min":24},
   {"session":"main","min":20},
   {"session":"docs","size":40,"min":10}]},
 "focus":"main","revision":7}
```

A node is `{row:[…]}`, `{column:[…]}`, `{session:"name"}`, or
`{text:"one line"}`. Any node may carry `size` (columns in a row, rows in a
column) and `min`, which is measured along that same parent axis. A node
without `size` takes the remainder; several share it equally.

When a container does not fit, sized children are squeezed from the last to
the first down to their `min`, then children are dropped from the last. Every
boundary between siblings is a one-cell divider a human may drag.

`focus` names a Session that must be on the Layout; omitted, the focus stays
if it is still shown. A Pane naming a Session that does not exist draws
nothing and keeps its place, so creating that Session later fills it without
another apply.

`revision` is the one the caller's tree was built from. A human's divider
drag moves the Layout on, so an apply carrying an older revision is refused
with `conflict` rather than silently undoing the gesture. Omit it to write
unconditionally.

Sizes live in the tree, so resizing a Pane is an apply with a changed `size`.
There is no separate resize verb.

### `layout.get`

The Layout as fitted to the stage right now: the tree with sizes as they
stand after drags, the focus, the stage size, the revision, and every Pane's
rectangle in tree order.

## Events

| Event | When | Data |
| --- | --- | --- |
| `session.exited` | a process ended, or adoption found it gone | `name`, `code`, `signal`, `reason` |
| `session.changed` | output or a title reached a screen, debounced ~100 ms | `name`, `title` |
| `layout.changed` | the fitted Layout changed | `layout`, `cause` (`apply`, `drag`, `resize`) |
| `stage.changed` | the stage took a new size | `cols`, `rows` |
| `theme.changed` | the resolved theme changed | `theme` |
| `instance.stopping` | `instance.stop` was accepted | — |

`code` and `signal` on `session.exited` are null when the Companion could not
read them; `reason` always says something.

### `session.state`

A Session's transport was lost, or came back.

```json
{"name":"reviewer","state":"unreachable"}
```

Sent on the transition, so nothing has to poll `session.list` to notice one.
An unreachable Session is not gone: its process is the Companion's and
smolmux keeps reaching for it, `session.exited` is what says it ended.

## Errors

`invalid_request`, `unknown_method`, `invalid_params`, `not_found`,
`conflict`, `companion_error`, `internal`. Each carries a message meant to be
read.

## Deliberately absent

- **No byte-level input.** `session.input` speaks keys, text, paste and
  mouse; it does not take bytes or escape sequences, because encoding belongs
  to the Session's emulator and not to its caller.
- **No MCP.** smolmux is a socket; whoever drives it can be an MCP server.
- **No byte-level observation.** `session.changed` plus `session.capture` is
  the whole reading surface. A pane's bytes never cross the API.
- **No app, wish, or gating for a Pane.** A Pane shows a Session or a line of
  text. What a Session runs and why is the caller's.
- **No session rename, reorder, or move.** Apply a new Layout.
