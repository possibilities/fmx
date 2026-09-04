# Agent and Tray are a forward-only vocabulary

Superseded by [ADR 0016](0016-sessions-are-arbitrary-commands.md), which
removes the Agent vocabulary entirely, and
[ADR 0018](0018-labels-are-the-record.md), which removes the Manifest.

Agent and Tray are the public names throughout fmx — including code, config, state, environment, the Manifest, Companion labels, CLI, and control wire — with no readers or aliases for the names they replaced. The Manifest therefore lives at `agents.json`, and `keys.toggle_tray` remains the fmx-owned action for its Tray: one canonical domain vocabulary is worth the deliberate clean break.
