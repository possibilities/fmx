# fmx glossary

**Instance** — one fx process together with the embedded terminal fmx renders
it in. Instances are numbered by fmx and disappear when their fx exits.
_Avoid_: pane, tab, window, session.

**Agent socket** — the Unix socket fmx binds and points every instance at, and
over which fx reports its own lifecycle. One socket serves all instances.
_Avoid_: status socket, control socket, IPC socket.

**Pane id** — the opaque string that identifies an instance on the agent
socket. It is the wire's word, not fmx's: fx addresses every request to a pane
id, so fmx mints one per instance and never uses the term anywhere else.
_Avoid_: instance id (that is fmx's own counter, exported as
`FMX_INSTANCE_ID`).

**Frame** — one line of JSON crossing the agent socket in either direction,
plus what fmx decoded from it. A request and its reply are two frames.
_Avoid_: message, packet, event.

**Debug panel** — the scrollable column of frames down the right third of the
screen, present only when `FMX_DEBUG_PANEL` is set. An observation surface: it
reads frames and changes nothing.
_Avoid_: log pane, console, inspector.
