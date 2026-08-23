# Native session names arrive over ADE

Fx is the sole session-name authority: it performs prompt-submit inference, persists `display.json` through the same path as `/rename`, and publishes committed changes as `SessionMetadataChanged` on its passive ADE feed. fmx keys that feed by the Manifest Agent identity, treats its eager session identity as authoritative, and reads the native sidecar only on attach, identity change, or a sequence gap; this keeps credentials, prompts, inference policy, and duplicate-name semantics out of fmx while still updating the tray as soon as Fx commits a name.
