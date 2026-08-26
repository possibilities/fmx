# Control socket beside the ADE feed

fmx exposes its command surface over a stable, mode-0600 Unix socket (`/tmp/fmx-<uid>/<home id>.ctl`, `FMX_SOCKET_PATH`) beside rather than inside the passive ADE feed: lifecycle observation stays one-way and cannot be delayed by a command that needs a result or waits. The same `fmx` binary is the control client, so an Agent needs nothing installed beyond what started it.
