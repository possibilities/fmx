# Runtime bridge schema 1

The Runtime bridge is fmx's implementation-private path from the stdio
`fmx-mcp` process to a running Runtime. It is not a supported integration
surface: agents and integrations use MCP tools, and Fx work is controlled
through those tools rather than by opening this socket.

## Connection

One Runtime binds one mode-0600 Unix socket for its Home at
`/tmp/fmx-<uid>/<home id>.bus`. Every Agent receives the stable path as
`FMX_SOCKET_PATH`. For each MCP tool call, `fmx-mcp` resolves that path (or the
sole live Runtime when called outside an Agent), opens one connection, sends
one request, receives one response, and closes it.

Both directions contain one JSON object followed by a newline. A connection
accepts exactly one request. A second record, a subscription envelope, trailing
non-whitespace bytes, or a silent peer is rejected or disconnected.

## Request

```json
{"schema_version":1,"type":"request","id":"request-1","method":"work.snapshot","params":{"target":"current"}}
```

`id` is a non-empty caller-chosen correlation string. `params` defaults to
`{}`. Schema 1 methods are the private Runtime counterparts of the eleven MCP
tools:

- `orient`
- `agent.create`
- `focus`
- `tray`
- `work.snapshot`
- `work.queue`
- `work.steer`
- `work.interrupt`
- `queue.update`
- `queue.delete`
- `queue.resume`

## Response

A successful request returns the MCP tool's structured result:

```json
{"schema_version":1,"type":"response","id":"request-1","ok":true,"result":{}}
```

A Runtime refusal keeps the same id and carries
`error: {code, message, data?}` with `ok: false`. An unknown method is such a
correlated refusal. Malformed JSON, an unsupported schema, an invalid envelope,
or invalid framing receives one uncorrelated `type: "error"` record and the
connection closes.

## Bounds and lifetime

The Runtime caps connections, request and response size, and time to the first
record. Closing a connection signals cancellation to its pending Runtime
operation. Agent creation may still finish once its Manifest/Companion
transaction has begun, because stopping midway would strand half a lifecycle;
the caller re-orients before retrying. The bridge starts only after restored
Agent metadata and selection are ready, ends with the Runtime, never affects
terminal sizing, and never keeps the Runtime alive. It carries no events,
observation subscriptions, history, replay, or raw ADE payloads.
