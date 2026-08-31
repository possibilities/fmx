# Private inline-v2 launch controls

`fmx.inline-launch-source` schema version 2 stores a private, bounded byte
authority beside an immutable Fx `launch_request`. `launch_controls` is not a
public fmx MCP message, Runtime-extension protocol revision, Work-control
message, Manifest field, or Fx `fx.launch-admission-final` revision.

Its decoded UTF-8 bytes must be exactly the canonical JSON encoding of this
strict object:

```json
{"remaining_global_args":["--no-default-skills","--skills-dir","/opt/team-skills"]}
```

There are no optional or additive fields. Object keys use the repository's
canonical JSON codec; the array preserves order and every string's UTF-8 bytes
without normalization.

## Bounds and digest

- The complete canonical object is at most 128 KiB.
- It contains at most 128 argv entries.
- Each entry is nonempty and at most 1,024 UTF-8 bytes.
- The existing inline source still caps initial work plus controls at 640 KiB
  and the complete framed source record at 1 MiB.
- `launch_request.remaining_launch_controls_digest` is SHA-256 of the exact
  complete canonical object bytes above. It is **not** a digest of only the
  inner array.

The source ledger validates the digest before writing durable state. A future
Fx provider receives these exact object bytes, verifies the same digest against
its private launch ledger, then parses this exact mapping before it supplies
the retained argv suffix to `PreparedLaunch.buildFxInvocation`.

## Permitted suffix

The array represents only an Fx global-argument suffix. Its currently allowed
flags are `--record`, `--no-additional-dirs`, `--no-native-tools`,
`--no-default-skills`, and `--no-project-instructions`. The options that take
one value are `--system-prompt-file`, `--append-system-prompt-file`,
`--skills-dir`, `--context-limit`, `--add-dir`, `--tool`, and
`--permissions-file`; they may use either separate or `--option=value` form.
Separate values cannot begin with `-`, preventing an entry from being
reinterpreted as another option.

The mapping rejects empty strings, ASCII control bytes (including NUL and
DEL), `--`, positional commands/executables, unknown flags, and missing or
ambiguous option values. It also rejects provider-owned or duplicate launch
authority: `--state-dir`, `--name`, `--model`, `--effort`, every resume
spelling (`resume`, `--resume*`, `--continue`, `-c`, `-r`), and their
`--option=value` forms. The provider alone supplies the executable, state
root, Conversation name, selected model/effort, and fresh/exact/recovery resume
target from the frozen request and durable receipt.

`src/inline-launch-source.ts` exports the exact bounds, allowed/forbidden
tables, `encodeInlineLaunchControls`, and `parseInlineLaunchControls` so a
provider conformance fixture can mirror this private boundary without changing
any frozen public schema.
