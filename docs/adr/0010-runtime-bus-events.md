# Runtime Bus events expose complete state and attributed activity

The public surface in this decision is superseded by [ADR 0013](0013-mcp-only-agent-automation.md); the internal event machinery remains pending the phase-three minimality audit.

fmx exposes Runtime state and optional attributed ADE activity as Bus events. Each subscription begins with a complete authoritative state snapshot, subsequent state is complete and deduplicated, and Home-wide activity remains self-attributed, live-only, and gap-aware rather than server-scoped or replayed; per-peer queues are bounded and raw ADE payloads require an explicit subscription. The Bus exists only with the Runtime, starts after restored metadata is ready, and Bus peers neither count as terminal Clients nor keep the Runtime alive.
