# A Companion-held Runtime serves every terminal Client

Each Home renders one shared UI inside a Companion-held Runtime PTY, and ordinary `fmx` invocations attach as thin Clients, so the Companion's existing broadcast and resize path provides multi-client display without duplicating the renderer or inventing a UI-diff protocol. Sizing follows the most recently connected or interacting Client, and the Runtime uses the Companion's opt-in final-client lifecycle while Agents remain independently persistent.
