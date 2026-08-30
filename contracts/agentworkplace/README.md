# AgentWorkplace-facing fmx contracts

This directory is the canonical fmx owner for the Phase 0 contract fixtures.
They freeze data and wire behavior for later implementation; loading them does
not start fmx, Fx, a Runtime extension, an Agent, or a Worktree.

All four families are schema version 1:

| Canonical fixture | Schema identity | Boundary |
| --- | --- | --- |
| `v1/runtime-extension.jsonl` | `fmx.runtime-extension` | fmx Session association, correlated initialization/readiness, authoritative Agent snapshot success/failure, present/focus, and publish/action/clear for the single-action unavailable-slot card |
| `v1/agent-defaults.jsonl` | `fmx.agent-defaults` | exact fmx Session selectors and field-by-field state-directory/model/effort precedence |
| `v1/ensure-lifecycle.jsonl` | `fmx.ensure-lifecycle` | immutable ensure/end/cleanup identities and digests, partial effects, exact ended-or-never-started Agent proof, independent Git cleanup, and exact receipt acknowledgements |
| `v1/fx-launch-admission-final.jsonl` | `fx.launch-admission-final` | Fx/fxnk-owned Fx Conversation launch, resolved role-neutral model/effort plus an opaque digest for remaining existing launch controls, keyed admission or cancellation, and retained final receipt; fmx is a consumer of these exact bytes |

`v1/manifest.json` is the digest and byte-count authority. Verify or print the
complete receipt with:

```sh
bun scripts/check-agentworkplace-contracts.ts
```

Each JSONL line is one envelope: UTF-8 without a BOM,
UTF-16-code-unit-sorted object keys, canonical number and string spellings, no
insignificant whitespace, and one LF terminator. The future extension wire
adds a four-byte big-endian payload length and rejects empty payloads or any
payload over 1 MiB; stream finalization rejects a partial header or payload at
EOF. The decoder rejects invalid UTF-8/JSON, duplicate keys,
unsupported identities or versions, precision-collapsing number spellings,
missing/incompatible fields, and unknown fields. Additive data is deliberate and narrow: readiness may advertise
additional safe-token capabilities, snapshot Agents may carry a bounded
`extensions` object, and bounded error details may do the same. Unknown fields
elsewhere turn a typo into policy and are errors.

Paths are normalized, bounded absolute paths and never the filesystem root;
the planned Worktree must differ from its repository. Filesystem existence,
realpath, Git ownership, and symlink revalidation remain Phase 1C behavior.

The checker recomputes immutable ensure, end, cleanup, and Fx launch digests
from each canonical request's immutable fields, excluding its transport
request id and its own digest field. Every receipt digest is SHA-256 over
the canonical envelope with only its `receipt_digest` field omitted; its
acknowledgement must repeat both the exact receipt id and digest. Manifest file
digests cover the complete committed JSONL bytes, including each record's LF.
The command above prints a machine-readable verification receipt containing
all fixture paths, byte counts, digests, and the manifest digest.

The lifecycle golden traces cover both an admitted Agent with exact Companion
exit proof and a durably cancelled partial launch with no Fx Conversation,
authoritative never-started proof, and independent Worktree cleanup. Absence,
timeout, refusal, or unreachable state is never end proof.

The product vocabulary in these fixtures is **fmx Session**, **Agent list**,
and **Fx Conversation**. Compatibility fields elsewhere in fmx may remain
`session_id`, and internal source names such as `FmxHome` and `SessionList`
remain deliberately unchanged.

Fixture identities, fmx Session names, placements, and slots are intentionally
opaque and role-neutral. These contracts contain no Workplace roles or
permissions, personal topology, live configuration, Runtime-extension process,
Agent-default resolution, ensure/end/cleanup effects, or Fx admission behavior.
Those belong to their later implementation phases and owning repositories.
