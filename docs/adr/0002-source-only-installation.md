# Source-only installation

Status: accepted; supersedes ADR 0001.

Fmx no longer publishes native archives, an installer payload, checksums,
release tags, or a latest-version pointer. Consumers clone the repository and
run `scripts/install.sh`, the same entrypoint used by fleet automation. That
script builds the exact pinned Fx and Companion sources and verifies the
result with `fmx doctor`.

Only `scripts/local-gate.sh` on the maintainer's current Mac architecture is a
merge gate. Full CI still gives a binary pass/fail verdict on macOS and Linux,
each on arm64 and x86_64, but it runs after pushes to `main` and is
nonblocking observability.

This removes release infrastructure from a project with no binary consumers,
while retaining exact inputs, reproducible commands, and explicit tested and
unsupported platform boundaries.
