# Runtime Bus schema 1

The Bus is fmx's public local interface to a running Runtime. One duplex NDJSON
connection may subscribe to state and activity events, send control requests,
or do both. It is independent of Fx's inbound ADE feed.

## Connect

One Runtime binds one mode-0600 Unix socket for its Home at
`/tmp/fmx-<uid>-<home id>.bus`. `fmx control orient` reports the exact path as
`fmx.socket`; every Agent receives it as `FMX_SOCKET_PATH`. `fmx bus
[--socket PATH]` connects and subscribes, while `fmx control ...` uses the same
socket for request/reply traffic.

Both directions contain one JSON object per newline. Every object carries
`schema_version: 1` and a `type` that selects its envelope. Unknown additive
object fields must be ignored. An incompatible wire change requires another
Bus schema version.

## Client messages

### Subscribe

```json
{"schema_version":1,"type":"subscribe","topics":["state","activity"],"activity_payload":"summary"}
```

| Field | Values | Default |
|---|---|---|
| `schema_version` | `1` | required |
| `type` | `subscribe` | required |
| `topics` | non-empty list containing `state`, `activity`, or both | `["state"]` |
| `activity_payload` | `summary` or `raw` | `summary` |

Duplicate topics are harmless. A subscription always produces a fresh complete
snapshot, including when it requests only activity. Sending another valid
subscription replaces the connection's topics and produces another snapshot.
Subscriptions are Home-wide; filter by `agent_id` or session after using the
snapshot to establish identity.

### Request

```json
{"schema_version":1,"type":"request","id":"focus-1","method":"focus","params":{"target":"next"}}
```

`id` is a non-empty caller-chosen string used to correlate the response.
Pending ids must be unique on a connection. `params` defaults to `{}`. A peer
may have up to 32 requests pending on one connection; extra requests receive a
`busy` response. The methods and parameter semantics are the same ones exposed
by `fmx control`; run `fmx control` for the command catalog.

Requests may complete out of order. A peer may send them before or after a
subscription and does not need a dedicated command connection. Closing the
connection cancels its unfinished requests, including an `agent.wait`; there
is no separate schema-1 cancellation message.

## Server messages

### Events

Every event has these common fields:

| Field | Meaning |
|---|---|
| `schema_version` | Bus schema, currently `1` |
| `type` | `event` |
| `runtime` | `{id, home_id, pid, version}` for this Runtime process |
| `stream_sequence` | one-based, monotonic for events on this connection |
| `state_revision` | authoritative state revision current for this event |
| `event` | `snapshot`, `state_changed`, or `activity` |

`runtime.id` is newly minted for each Runtime. `stream_sequence` restarts on
each connection. It can have gaps when queued events are evicted to make room
for a response; resubscribe for a complete snapshot when continuity matters.
`state_revision` begins at zero and advances only when the complete state
projection changes.

#### State

A `snapshot` follows every subscription. A peer subscribed to `state` then
receives `state_changed` whenever the projection changes. Both carry the entire
state:

```json
{
  "schema_version": 1,
  "type": "event",
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
| `awaiting_work` | a sent prompt has not yet been admitted by Fx |
| `subagents` | recursively nested `{session_id,label,state,attention,children}` records |

`cause` is a diagnostic hint, not a patch instruction. Values may grow within
schema 1; replace local state with the supplied projection.

#### Activity

A peer subscribed to `activity` receives every ADE record fmx accepts for a
known Agent, after fmx folds that record into state. If the fold changes state,
the corresponding `state_changed` event is published first and both carry the
same `state_revision`.

```json
{
  "schema_version": 1,
  "type": "event",
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
first accepted sequence other than one is also a gap. An accepted sequence-one
`FxStarted` after `FxStopped` begins a new process generation. Session and
parent-session attribution comes from the ADE record itself, so a subagent's
captured parent may intentionally name an older session after the main Agent
changes sessions.

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
terminal labels, and prompt-derived native session names. A peer that stores or
forwards records owns the resulting exposure.

### Responses

Every request receives one response with the same `id`:

```json
{"schema_version":1,"type":"response","runtime":{"id":"...","home_id":"...","pid":123,"version":"..."},"state_revision":12,"id":"focus-1","ok":true,"result":{"agent":{}}}
```

A refused request has `ok: false` and
`error: {code, message, data?}` instead of `result`. Command failures do not
close the connection. `state_revision` is the authoritative revision when the
response was built; a mixed subscribe/request peer can compare it with the last
event it received and resubscribe if it needs the complete current projection.

Responses have priority over queued events. They may evict whole events that
have not begun writing, which creates a visible `stream_sequence` gap. NDJSON
records are never interleaved, so a partially written event finishes first. If
a bounded queue still cannot hold a response, the Runtime closes that peer.

### Protocol errors

Malformed JSON, an unsupported schema, an unknown envelope type, or invalid
subscription fields receive one uncorrelated error and close the connection:

```json
{"schema_version":1,"type":"error","error":{"code":"invalid_request","message":"..."}}
```

Protocol error codes are `invalid_request`, `unsupported_schema_version`, and
`capacity`. An unknown control method is instead a correlated `response` with
`ok: false`, so the connection remains usable.

## Delivery and lifetime

Activity is best-effort and live-only. There is no cursor, resume token,
history, or replay. Reconnect or resubscribe to rebuild from a complete state
snapshot, then treat later activity as new.

The Runtime caps total Bus connections, subscribed peers, pending requests,
and every connection's record and byte queues. A slow or silent peer is
disconnected rather than delaying the Runtime, another peer, a command, or
Fx's ADE delivery. A Bus peer is not a terminal Client, does not affect sizing,
and does not keep the Runtime alive. Within schema 1, peers should also ignore
unknown `cause` values and unknown ADE activity names.
