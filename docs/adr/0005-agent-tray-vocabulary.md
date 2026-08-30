# Agent and Tray are a forward-only vocabulary

Agent and Tray are the public names throughout fmx — including code, config, state, environment, the Manifest, Companion labels, CLI, and control wire — with no readers or aliases for the names they replaced. The Manifest therefore lives at `agents.json`, and `keys.toggle_tray` remains the fmx-owned action for its Tray: one canonical domain vocabulary is worth the deliberate clean break.
