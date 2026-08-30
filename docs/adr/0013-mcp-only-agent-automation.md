# MCP is the only agent automation surface

fmx removes its automation CLI and makes the separate stdio `fmx-mcp`
executable the only supported agent-facing interface, superseding the client
choices in ADRs 0002, 0010, and 0011. MCP exposes Orientation, Agent creation
and focus, Tray configuration, and Fx-native snapshot, queue, steer, interrupt,
queued-work update/delete, and queue-resume operations.

Prompt paste/send, waiting, observation streams, catalog and key inspection,
permission or question answers, queue reorder/arbitrary-start/clear, and
subagent, Fx Conversation, or Runtime lifecycle control remain absent. The internal
Runtime bridge carries one MCP request per connection, while authenticated
per-Agent Work control mirrors Fx's semantic authority instead of emulating it
through terminal input.
