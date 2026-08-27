# Observation stream schema 1

The Observation stream is fmx's public, read-only Runtime interface for local
sidecars, alternate views, and notification tools. It is separate from Fx's
inbound ADE feed and fmx's control request/reply socket.

## Connect and subscribe

One Runtime binds one mode-0600 Unix socket for its Home at
`/tmp/fmx-<uid>-<home id>.obs`. `fmx control orient` reports the exact path as
`fmx.observation_socket`; `fmx observe [--socket PATH]` accepts either that
path or its sibling control path and relays the protocol as NDJSON.

A direct Observer writes exactly one newline-terminated subscription object:

```json
{"schema_version":1,"topics":["state","activity"],"activity_payload":"summary"}
```

| Field | Values | Default |
|---|---|---|
| `schema_version` | `1` | required |
| `topics` | non-empty list containing `state`, `activity`, or both | `["state"]` |
| `activity_payload` | `summary` or `raw` | `summary` |

Duplicate topics are harmless. Unknown fields are ignored. Any bytes sent
after the subscription cause the Runtime to close the connection. A malformed
request receives one `error` record and then closes:

```json
{"schema_version":1,"event":"error","error":{"code":"invalid_request","message":"..."}}
```

Error codes are `invalid_request` and `unsupported_schema_version`.
Subscriptions are Home-wide and topic-only; filter by `agent_id` or session
at the Observer after using the initial snapshot to establish identity.

## Common message fields

Every non-error record has these fields:

| Field | Meaning |
|---|---|
| `schema_version` | Observation schema, currently `1` |
| `runtime` | `{id, home_id, pid, version}` for this Runtime process |
| `stream_sequence` | one-based, monotonic on this Observer connection |
| `state_revision` | the authoritative state revision current for this record |
| `event` | `snapshot`, `state_changed`, or `activity` |

`runtime.id` is newly minted for each Runtime. `stream_sequence` restarts for
each connection. `state_revision` begins at zero and advances only when the
complete state projection changes.

## State

Every connection receives one `snapshot` first, even when it subscribed only
to activity. An Observer subscribed to `state` then receives a `state_changed`
record whenever the projection changes. Both carry the entire state:

```json
{
  "schema_version": 1,
  "runtime": {"id":"...","home_id":"...","pid":123,"version":"..."},
  "stream_sequence": 1,
  "state_revision": 7,
  "event": "snapshot",
  "cause": "subscribed",
  "state": {"active_agent_id":null,"agents":[]}
}
```

`active_agent_id` is the selected Agent's stable Manifest identity, or null.
The `agents` array remains in creation order. Each Agent contains:

| Field | Meaning |
|---|---|
| `agent_id` | stable 128-bit Manifest identity; use across Runtime restarts |
| `id`, `display_id` | retained human-facing Agent number; `id` is its control-target spelling |
| `pane_id` | retained opaque `p_<agent_id>` control and Companion identity |
| `created_at` | Unix epoch milliseconds from the Manifest claim |
| `cwd`, `project` | launch directory and display project |
| `git_root`, `main_git_root`, `branch` | fmx's Git context, nullable until or when unavailable |
| `worktree` | whether `git_root` is a linked worktree, or null with no Git answer |
| `session_id`, `name` | mutable Fx session identity and native session name |
| `label` | current embedded terminal title; distinct from `name` |
| `state` | `blocked`, `working`, `done`, `idle`, or `unknown` |
| `attention` | `permission`, `question`, `route_recovery`, or null |
| `active` | whether this is the selected Agent |
| `awaiting_work` | a sent prompt has not yet been observed as admitted by Fx |
| `subagents` | recursively nested `{session_id,label,state,attention,children}` records |

`cause` is a diagnostic hint, not a patch instruction. Values may grow within
schema 1; replace local state with the supplied projection.

## Activity

An Observer subscribed to `activity` receives every ADE record fmx accepts for
a known Agent, after fmx folds that record into state. If the fold changes
state, the corresponding `state_changed` record is emitted first and both
records carry the same `state_revision`.

```json
{
  "schema_version": 1,
  "runtime": {"id":"...","home_id":"...","pid":123,"version":"..."},
  "stream_sequence": 9,
  "state_revision": 11,
  "event": "activity",
  "activity": {
    "name": "AttentionRequired",
    "ade_sequence": 22,
    "gap_before": false,
    "agent_id": "...",
    "display_id": 3,
    "agent_role": "subagent",
    "workspace_root": "/workspace/project",
    "session_id": "...",
    "parent_session_id": "...",
    "subagent_id": 4,
    "turn_id": 17,
    "agent_state": "blocked",
    "attention_kind": "permission",
    "payload_mode": "summary",
    "payload": {"kind":"permission"}
  }
}
```

`ade_sequence` is monotonic per Fx process, not per Runtime. `gap_before` is
true when fmx did not accept the immediately preceding process sequence; a
first observed sequence other than one is also a gap. An accepted
sequence-one `FxStarted` after `FxStopped` begins a new process generation.
Session and parent-session attribution comes from the ADE record itself, so a
subagent's captured parent may intentionally name an older session after the
main Agent changes sessions.

Summary mode uses this scalar-only allowlist:

| ADE event | Payload fields |
|---|---|
| `GitRootDiscovered` | `git_root`, `revision`, `reason` |
| `SessionChanged` | `previous_session_id`, `session_id` |
| `SessionMetadataChanged` | `title` |
| `PreToolUse` | `step_index`, `call_id`, `tool_name` |
| `Stop` | `step_index`, `provider_disposition`, `can_continue` |
| `PostTurnEnd` | `outcome`, `provider_disposition` |
| `AttentionRequired`, `AttentionResolved` | `kind` |
| every other event | no payload fields |

Raw mode returns the complete ADE payload, including tool arguments and
assistant text. It can contain credentials, prompt-derived text, and other
secrets. Summary state and activity can still contain workspace paths,
terminal labels, and prompt-derived native session names. The socket is
private to the local user, but an Observer that stores or forwards records
owns the resulting exposure.

## Delivery and lifetime

Activity is best-effort and live-only. There is no cursor, resume token,
history, or replay. On reconnect, rebuild from the initial state snapshot and
treat later activity as new; do not infer that activity before the connection
was complete.

An Observer is passive: it cannot control an Agent, does not count as a
terminal Client, and does not keep the Runtime alive. Handshakes are bounded,
concurrent Observers are capped, and each Observer has bounded record and byte
queues. A slow Observer is disconnected rather than delaying the Runtime,
another Observer, the control socket, or Fx's ADE delivery.

Within schema 1, consumers should ignore unknown additive object fields,
unknown `cause` values, and unknown ADE activity names. An incompatible wire
change requires another observation schema version.
