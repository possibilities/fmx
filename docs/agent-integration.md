# Agent integration

`fmx-mcp` is fmx's complete agent automation interface. It is a stdio MCP
server that finds a running fmx Runtime for each tool call, asks that Runtime
to act, and returns typed structured content. It does not own a Runtime, keep
one alive, or provide another socket API for integrations.

## Connect

Start `fmx` in a human terminal first, then configure the MCP host to run the
installed server. For Codex:

```toml
[mcp_servers.fmx]
command = "fmx-mcp"
required = true
```

An MCP server started inside an Agent uses that Agent's Home and knows that
Agent as `current`. A server started outside an Agent connects only when
exactly one Runtime is live on the machine. If none or several are live, the
tool call fails rather than guessing. There is no Home-selection parameter.

The Runtime ends when its final terminal Client detaches. Its Agents continue
under the Companion, but MCP calls cannot reach them until a terminal Client
starts the Runtime again. The MCP server never counts as a terminal Client.

An Agent already running when semantic Work control is installed, or adopted
without an fmx Manifest claim, has no authenticated Fx endpoint to recover.
Orientation and focus still work, but Work tools return `failed`. End that Fx
by hand and create a new Agent when it needs MCP Work control; fmx never invents
authority for a process that was not launched with it.

## Core workflow

1. Call `get_orientation` for one current view of the Runtime, caller, active
   Agent, Agent identities, lifecycle states, subagents, Tray, and open surface.
2. Keep the returned `agent_id` for every Agent you intend to address. It is
   stable across Runtime restarts; display numbers and names are for humans.
3. Call `create_agent` when new work needs its own Agent. Creation is in the
   background unless it creates the first Agent.
4. Before changing an Agent's work, call `get_agent_work`. Its snapshot is Fx's
   authority for the active Turn, pause state, and FIFO.
5. Use `queue_agent_work` for intentionally later work. Use `steer_agent` only
   when the text should guide the active Turn if one still accepts steering.
6. When work must stop, call `interrupt_agent`, inspect the returned paused
   queue, apply `update_queued_work` or `delete_queued_work` as needed, and call
   `resume_agent_queue` to continue from its head.
7. Treat every successful mutation's returned snapshot as the new authority.
   After an error or competing human action, read again instead of assuming
   the previous snapshot still holds.

There is no event stream or wait tool. `get_orientation` and `get_agent_work`
are explicit point-in-time observations; call them when a decision needs fresh
state, not as a promise that an earlier state remains current.

## Targets

`focus_agent` requires `target`. Every work tool accepts it and defaults to
`current`.

| Target | Meaning |
| --- | --- |
| stable 32-hex `agent_id` | Preferred identity; survives Runtime restarts |
| `p_<agent_id>` | Retained opaque Pane id |
| decimal display id such as `3` | Human-facing Agent number |
| `current` | The Agent containing the MCP caller |
| `active` | The Agent currently shown by fmx |
| `next` / `previous` | Relative to the Agent currently shown, wrapping at the ends |
| exact Session name | Fx's native persisted name; duplicates are ambiguous |
| unique Session-id prefix | Fallback after exact-name matching |

Stable Agent id, Pane id, decimal display id, and reserved words are recognized
before name matching. An exact Session name wins over a Session-id prefix.
Ambiguous names or prefixes are refused with candidate display ids.

Outside an Agent, an omitted work Target still means `current` and therefore
fails. Use a stable `agent_id`, or use `active` when following the shared human
surface is intentional. Subagents appear in Orientation but are not Targets.

## Results and errors

Every successful tool call returns its documented object in
`structuredContent`; the text content is the same object as formatted JSON.
Domain refusals return `isError: true` and a machine-readable error object:

```json
{
  "error": {
    "code": "busy",
    "message": "the human queue editor is visible",
    "data": { "fx_code": "queue_editor_visible" }
  }
}
```

Inspect `structuredContent.error.code`, not the message:

| Code | Meaning and recovery |
| --- | --- |
| `invalid_params` | Correct the Target or request. `current` also produces this outside an Agent. |
| `not_found` | The Agent, active work, or queued Turn no longer exists; orient or read work again. |
| `ambiguous` | A name or Session-id prefix matched several Agents; use an `agent_id`. |
| `busy` | A human-visible modal or Fx queue editor owns the operation; preserve it and retry after it closes. |
| `timeout` | The Runtime or Fx did not answer before its bound; reread before deciding whether to retry a mutation. |
| `cancelled` | The MCP call was cancelled; reread before retrying a mutation. Agent creation may have completed once its lifecycle transaction began. |
| `shutting_down` | The Runtime is ending; start or attach fmx again before retrying. |
| `failed` | Transport, lifecycle, or Fx refusal not covered above; inspect `data.fx_code` when present, then reread. |

Fx-specific refusals retain the native code in `error.data.fx_code`. Important
examples are `queued_work_not_text_only`, `queue_not_paused`,
`snapshot_too_large`, `worker_stopped`, and `turn_finalization_failed`.
Argument-shape errors caught by the MCP SDK are protocol-level invalid-params
errors and never reach the Runtime.

## Orientation and Agent creation

### `get_orientation`

Takes no input. Its result contains:

- `fmx`: Runtime pid, version, working directory, and current terminal size;
- `you`: the caller's Agent, or `null` outside an Agent;
- `active`: the active display id, or `null` with no Agents;
- `agents`: creation-ordered Agent records with stable identities, repository
  context, native Session identity and name, lifecycle state, attention, and
  nested subagents;
- `tray`: actual visibility, persisted hidden choice, width, and the rows fmx
  currently draws; and
- `surface`: `none`, `help`, or the current fmx error modal.

Orientation is read-only and does not mark an Agent's state as Seen. Agent
`state` is `blocked`, `working`, `done`, `idle`, or `unknown`; `attention` is
`permission`, `question`, `route_recovery`, or `null`. These are lifecycle
observations from the ADE feed, not a transcript or terminal snapshot.

### `create_agent`

```json
{
  "directory": "/absolute/or/runtime-relative/repository",
  "worktree": true,
  "model": "provider-model-name",
  "effort": "high"
}
```

Every field is optional. `directory` accepts an absolute path, `~/...`, or a
path relative to the Runtime's working directory, and must be inside a Git
repository. With no directory, fmx uses the caller Agent's directory, then the
first repository found at or one level below the configured Project roots.
It refuses when neither exists.

`worktree` defaults to `false`. When true, fmx creates a managed Worktree from
the repository's current commit; an unborn repository cannot supply one.
`model` and `effort` become `FX_MODEL` and `FX_EFFORT` overrides for only the
new Fx process. Fmx does not expose or validate a model catalog.

The result is `{ "agent": Agent }`. Creation is serialized with concurrent
creation calls, persists the Manifest claim before Fx starts, and leaves an
existing active Agent focused. The first created Agent necessarily becomes
active because nothing else is on screen. If the call is cancelled or times out
after that lifecycle transaction begins, creation may still complete; call
`get_orientation` before retrying so a lost response does not become a duplicate
Agent.

### `focus_agent`

```json
{ "target": "0123456789abcdef0123456789abcdef" }
```

Selects the Agent shown on the shared human surface and returns its Agent
record. It refuses with `busy` while an fmx modal is open rather than stealing
terminal focus from that surface.

### `configure_tray`

```json
{ "width": 32, "hidden": false }
```

All fields are optional. `width` must be a positive integer and is clamped to
the current terminal. `hidden` stores an explicit visibility choice;
`toggle: true` reverses it. `hidden` and `toggle: true` cannot be combined.
The result is `{ "visible", "hidden", "width" }`. With no fields, the tool is
a read of that compact Tray state; use `get_orientation` when rows are needed.

## Native Fx work control

Every work result includes both the resolved `agent` and Fx's authoritative
post-operation `work` snapshot:

```json
{
  "agent": { "agent_id": "...", "display_id": 1 },
  "work": {
    "active_turn_id": "41",
    "queue_paused": false,
    "queue": [
      {
        "turn_id": "42",
        "kind": "steering",
        "text": "tighten the tests",
        "has_images": false,
        "has_skill_bindings": false,
        "has_review_draft": false
      }
    ]
  }
}
```

Turn ids are opaque positive decimal strings. Keep them as strings: Fx uses a
native unsigned 64-bit identity that JSON numbers cannot always represent.
Queue array order is admission order and execution order. A `steering` entry
still targets the active Turn; if that Turn finishes first, Fx demotes the
entry in place to ordinary queued work without changing FIFO order.

Snapshots are deliberately bounded to 256 queued entries and 1 MiB of queued
text. External queue, steer, and update text is non-empty UTF-8 and at most
1 MiB. Fx refuses an authoritative snapshot that exceeds its bounds rather
than returning a partial queue.

### `get_agent_work`

```json
{ "target": "current" }
```

Reads the active Turn id, whether queue execution is paused, and the complete
bounded FIFO. It does not read terminal contents, conversation history, model
output, permissions, questions, or subagent work.

### `queue_agent_work`

```json
{ "target": "current", "text": "Run the integration suite next." }
```

Appends plain text through Fx's native prompt-admission path without steering
the active Turn. The result additionally contains the admitted `turn_id` and
`disposition`, which is `queued`.

### `steer_agent`

```json
{ "target": "current", "text": "Preserve the public schema while fixing it." }
```

Uses Fx's native steering path. If a main Turn is active and still accepts
guidance, `disposition` is `steering`; otherwise Fx safely admits the text as
ordinary queued work and reports `queued`. Trust the returned disposition
rather than predicting it from an earlier snapshot.

### `interrupt_agent`

```json
{ "target": "current" }
```

Cooperatively interrupts the main Agent's active stream, permission, or
question operation. Remaining queued work is paused for inspection and is not
discarded. If no main work is interruptible, the tool returns `not_found` with
native code `no_active_work`. It does not interrupt subagent-owned approval.

### `update_queued_work`

```json
{ "target": "current", "turn_id": "42", "text": "Run only the MCP integration suite." }
```

Replaces the text of one queued Turn without changing its identity or place in
the FIFO. Fx refuses a Turn whose snapshot flags show images, skill bindings,
or a native review draft; there is no lossy conversion path. It also refuses
mutations while the human queue editor is visible.

### `delete_queued_work`

```json
{ "target": "current", "turn_id": "42" }
```

Deletes exactly one queued Turn. Turn ids are identities, not queue indexes;
read again after another actor changes the queue.

### `resume_agent_queue`

```json
{ "target": "current" }
```

Resumes a paused queue unchanged from its head. It does not select an arbitrary
Turn. Fx refuses when the queue is not paused.

## Deliberate limits

The MCP surface has exactly eleven tools. It deliberately has no generic
prompt send or terminal paste, wait-for-Agent operation, events or resource
subscriptions, prompt/output transcript, permission or question answer,
queued-work reorder/start/clear-all, subagent control, Session rename/change,
model catalog, key inspection, Client detach, Agent kill, or Runtime lifecycle
operation.

These are contract boundaries, not missing aliases. Semantic prompting goes
through Fx's queue and steering authority. Human-only terminal interactions
remain human-only. Ending an Agent remains an action from inside Fx or a
by-hand `fmx-zmx kill`; integrations do not acquire that destructive power
through another fmx interface.
