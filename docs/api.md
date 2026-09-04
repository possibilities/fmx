# The fmx API

Everything past `start`, `stop`, and `attach` is this API. One duplex Unix
socket per Instance, newline-delimited JSON, defined once in
`src/protocol.ts` and printed whole by `fmx api`. This document is the prose
half; the schemas there are the machine-readable half, and a test fails when
one of them names a method this file does not.

## Connecting

`fmx start` prints the socket path, and `fmx status` reports it again. It is
`/tmp/fmx-<uid>/<instance id>.api`, mode 0600, inside a directory created
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

An **Instance** is one running fmx: a Runtime, its Sessions, and one Layout.
A **Session** is a command in a Companion-held PTY, named by its caller. The
**Layout** is a tree of rows and columns whose leaves are **Panes**, each
showing one Session or one line of text. The **Stage** is the drawn area,
sized by whichever terminal Client interacted most recently.

A Session runs whether or not a Pane shows it, and it outlives the Runtime:
the Companion holds it, labelled with the Instance's id, and the next
Runtime adopts it. fmx stores nothing of its own.

## Methods

### `instance.status`

The Runtime as it stands: version, pid, Instance name and id, socket path,
stage size, theme, every Session, and the Layout. Takes no params.

### `instance.stop`

Answers, then kills every Session and ends the Runtime. Every Client
detaches. `instance.stopping` goes out first. Takes no params.

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
needs quoting. `cwd` is absolute. `env` is applied over fmx's own environment
with its private variables (`FMX_*`, `ZMX_*`, `TMUX*`, `HERDR_*`) removed.
`cols` and `rows` size the PTY until a Pane sizes it, 80×24 by default.
`labels` are kept on the Companion session and returned on adoption; `owner`,
`instance`, `session`, and `kind` are fmx's own and refused.

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
{"name":"tray","lines":["agents","  reviewer"],"cols":26,"rows":30,
 "cursor":{"x":0,"y":2,"visible":true},"title":"the tray"}
```

Trailing blank lines are trimmed. Scrollback is not included.

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
column) and `min`. A node without `size` takes the remainder; several share
it equally.

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

## Errors

`invalid_request`, `unknown_method`, `invalid_params`, `not_found`,
`conflict`, `companion_error`, `internal`. Each carries a message meant to be
read.

## Deliberately absent

- **No way to type into a Session.** No send, write, or keys method. Whatever
  runs in a Session gets its input from the human at the keyboard, or from
  its own channels.
- **No MCP.** fmx is a socket; whoever drives it can be an MCP server.
- **No byte-level observation.** `session.changed` plus `session.capture` is
  the whole reading surface. A pane's bytes never cross the API.
- **No app, wish, or gating for a Pane.** A Pane shows a Session or a line of
  text. What a Session runs and why is the caller's.
- **No session rename, reorder, or move.** Apply a new Layout.
- **No scrollback.** `session.capture` returns the visible screen.
