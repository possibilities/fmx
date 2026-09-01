# Managed launch v1

`fmx.managed-launch` schema version 1 is fmx's additive, implementation-private
contract for starting one managed Agent in an existing Git checkout. It does
not extend or reinterpret the frozen `fmx.ensure-lifecycle` schema version 1.
Plain fmx and Runtime extensions that do not use this link retain their current
behavior and bytes.

## Direction and framing

The link uses the Runtime-extension child's existing length-prefixed stdout and
stdin transport. Each frame is a four-byte big-endian payload length followed
by canonical UTF-8 JSON. The one-mebibyte contract frame limit applies.
Duplicate keys, noncanonical JSON, unknown fields, unsupported versions, and
wrong-direction messages are protocol errors.

The Runtime extension sends `launch_request`, `retry_request`, and
`outcome_acknowledgement` to fmx. Fmx sends only `launch_outcome`. A request
handler never sends a synthetic response: fmx first retains the request and
later publishes its retained outcome independently.

## Existing-directory request

`launch_request` binds these identities together:

- the Workplace instance, fmx Session, ensure, launch, and 32-hex Agent ID;
- `workspace.kind = existing_directory`, the normalized absolute directory,
  main repository root, checkout root, and exact 40- or 64-hex HEAD commit;
- the requested Fx Conversation name and optional exact-resume Conversation;
- one strict frozen Fx `launch_request` plus its exact initial-work and launch-
  control bytes, encoded as canonical base64 with byte length and SHA-256.

The source, launch, and ensure digests cover their exact semantic payloads.
Fmx resolves the directory to its real path and re-reads Git context and HEAD;
any drift is an outcome, never permission to create a replacement Worktree.
The inline bytes are held in the existing lifecycle transaction and are passed
through the existing Fx launch provider and authenticated Work-control paths.
There is no second source ledger and no private copy of Fx's launch ledger.

## Durable outcome

Every terminal launch attempt produces one `launch_outcome`, retained in the
existing ensure-lifecycle ledger until its exact receipt ID and digest are
acknowledged. Recovery republishes an unacknowledged outcome. An acknowledgement
is idempotent only for the exact ensure, launch, Agent, receipt ID, and digest.
A Runtime-extension snapshot may arrive before or after the outcome; the
outcome, rather than snapshot order or absence of failure, closes the launch.

A succeeded outcome has:

- `status = succeeded`, `stage = fx_admission`, and process certainty
  `started`;
- the exact active Conversation ID;
- the exact retained Fx admission receipt ID and digest.

Fmx retains Fx's positive admission decision and the `fx_started` transition
before retaining this outcome. A crash between those writes reconstructs the
same success receipt from those durable authorities without resubmitting work.

A failed outcome has `status = failed`, a classification of `retryable`,
`uncertain`, or `permanent`, one bounded stage and cause, and process certainty
`not_started`, `may_have_started`, or `started`. The stages are:

- `existing_directory`
- `manifest_claim`
- `launch_provider`
- `companion_start`
- `fx_admission`

The causes are the closed schema enum in `src/managed-launch-contract.ts`.
Companion start ambiguity is `uncertain` with `may_have_started`; failures after
the durable Companion boundary say `started`.

`permanent` is reserved for an exact-resume refusal carrying
`exact_resume_proof`. That proof is the strict
`fx.private-launch-provider/resume-status-v2` semantic result: it names and
digest-binds the state root, admission key, launch, exact Conversation,
`unavailable` status, and semantic decision. Fmx calls this read-only authority
after the retained launch receipt and before any Companion effect. It verifies
the provider-computed deterministic decision ID and digest independently.
Private provider v1 error names remain diagnostics and never become policy.
Malformed, unsupported, or uncorrelated v2 responses are retryable; even a
valid unavailable result is not permanent if an earlier attempt may have
started a process. Process certainty is monotonic across attempts, so a later
pre-start failure cannot erase an earlier `may_have_started` or `started`
observation.

## Exact retry

Acknowledgement alone does not erase or redrive a failed attempt. A
`retry_request` must name the same immutable Workplace, Session, ensure digest,
launch digest, Agent, and the exact acknowledged prior attempt receipt. It must
advance the attempt number by one. Permanent and successful outcomes cannot be
retried.

The ledger appends the exact prior outcome, acknowledgement, and retry request
bytes to history before opening the next attempt. It does not clear or replace
history and it does not mint another logical launch. Redrive resumes at the
last durable effect boundary. A retry after uncertain Companion start uses the
same stable Manifest/Companion identity so `startManagedAgent` reconciles or
reattaches instead of choosing another process identity.

## Effects and recovery

Managed stages are persisted beside frozen lifecycle records as a separate
private ledger-record version. The effect order is directory validation,
Manifest claim, provider preparation, Companion start, and Fx admission.
Creation reuses `Multiplexer.projectManagedAgent`,
`Multiplexer.startManagedAgent`, the Fx launch provider, and Work-control.
Exact replay joins those authorities and does not repeat a completed effect.

This transaction never invokes Worktree creation, Worktree cleanup, or the
frozen retirement path. A retained failed outcome remains an audit record; fmx
does not infer that a possibly started process is safe to remove.
