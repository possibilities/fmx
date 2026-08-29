# MCP is the only agent automation surface

fmx removes its `control` and `bus` CLI subcommands and makes the separate stdio `fmx-mcp` executable the only supported agent-facing automation surface, superseding the client choices in ADRs 0002, 0010, and 0011. Phase one exposes only orientation, Agent focus, and Tray configuration; it removes launch prompting, send, wait, key/catalog commands, and raw observation while retaining the internal Manifest–Companion creation engine that must exist before Fx has a control socket.

Phase two will inventory the Fx fork's native control socket and propose explicit MCP tools for steering, queueing, interruption, and any other agent-useful operations before implementation. Phase three will audit both fmx and the Fx fork and remove every interface and code path not required by the approved MCP design, the human TUI, or their lifecycle foundations.
