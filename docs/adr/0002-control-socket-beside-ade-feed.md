# Control socket beside the ADE feed

Superseded by [ADR 0011](0011-one-duplex-runtime-bus.md); its automation CLI
was removed by [ADR 0013](0013-mcp-only-agent-automation.md).

smolmux exposes its command surface over a stable, mode-0600 Unix socket (`/tmp/smolmux-<uid>-<home id>.ctl`, `SMOLMUX_SOCKET_PATH`) beside rather than inside the passive ADE feed: lifecycle observation stays one-way and cannot be delayed by a command that needs a result or waits. The same `smolmux` binary is the control client, so an Agent needs nothing installed beyond what started it.
