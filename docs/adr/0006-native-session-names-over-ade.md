# Native Fx Conversation names arrive over ADE

Superseded by [ADR 0016](0016-sessions-are-arbitrary-commands.md): smolmux no
longer reads any lifecycle or naming channel, and a Session's title is
whatever OSC 0/2 it sets.

Fx is the sole Fx Conversation-name authority: it performs prompt-submit inference, persists `display.json` through the same path as `/rename`, and publishes committed changes as `SessionMetadataChanged` on its passive ADE feed. smolmux keys that feed by the Manifest Agent identity, treats its eager Fx Conversation identity as authoritative, and reads the native sidecar only on attach, identity change, or a sequence gap; this keeps credentials, prompts, inference policy, and duplicate-name semantics out of smolmux while still updating the Tray as soon as Fx commits a name. The event and storage names remain compatibility wire terms.
