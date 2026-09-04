# The Runtime is headless, and its socket is the Instance singleton

Supersedes [ADR 0007](0007-companion-held-shared-runtime.md)'s final-Client
lifecycle.

A Runtime starts without a terminal, renders into its Companion-held PTY,
binds its API socket, and holds its Sessions whether or not anyone is
attached. It ends on `instance.stop`, a signal, or a crash — never because
the last Client detached. `fmx start` is therefore a real verb: it returns
the socket path and nothing is waiting on a human.

That removes the bootstrap marker the old Runtime waited on before
constructing its renderer, which existed so the OSC 11 background query had a
terminal to answer. A headless Runtime asks nothing: it takes `FMX_THEME`,
then `COLORFGBG`, then dark, and the first Client samples its own terminal
before it relays anything and tells the Runtime with the same notification a
terminal would send. The existing live-theme path does the rest, atomically.

The API socket replaces the ADE feed as the Instance singleton. It is claimed
under a lock before anything is adopted, so two Runtimes can never hold the
same Sessions, and a request that arrives during adoption waits for it rather
than being told the Sessions do not exist.

The cost is that an Instance now outlives every terminal, so `fmx stop` is
the way to end one and a forgotten Instance keeps its processes. That is what
a multiplexer a program drives has to do.
