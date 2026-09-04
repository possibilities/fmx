# The Companion's labels are the record; fmx stores nothing

Supersedes the Manifest of [ADR 0005](0005-agent-tray-vocabulary.md) and the
persisted UI state of [ADR 0014](0014-independent-named-fmx.md). ADR 0014's
own subject, the `--name` flag and the independence it gives an Instance,
remains in force.

Fmx writes no file. A Session's identity is its name, its Companion session
is `fmx-<instance id>-<name>`, and its labels carry `owner`, `instance`, and
`session`. The fork applies labels at creation, before the loop accepts any
client, so no client can ever see a session unlabelled — which is exactly the
property the Manifest existed to provide across a crash.

Adoption is therefore one `list --json` filtered by label and name. There is
no claim to write before creating, no `markRunning` to land after, and no
crash window between them to reconcile: the Companion either holds a labelled
session or it does not. An exited session's record is consumed; one whose
labels cannot be read is left for the next start.

The Instance id follows: derived from the name rather than from a directory
digest, so nothing fmx could lose can cost an Instance its Sessions.

Two things are given up. An adopted Session's argv is not recoverable — the
Companion reports a shell-quoted display string cut at 256 bytes — so it is
reported as null rather than guessed at. And the Layout does not survive a
Runtime restart: the caller owns its own arrangement and re-applies it, which
is where that state belongs.
