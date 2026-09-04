# Source installation

Fmx publishes no binaries and has no release channel. A consumer installs a
checkout with the same repository-owned script used by its maintainers:

```sh
git clone https://github.com/possibilities/fmx.git
cd fmx
scripts/install.sh --check
scripts/install.sh --install
```

The installer runs a frozen Bun dependency install, links `fmx` from the
checkout, builds the exact Companion commit in `companion.json` as `fmx-zmx`,
and runs `fmx doctor`. By default the native command goes to `~/.local/bin`
and Bun's editable link goes to `${BUN_INSTALL:-$HOME/.bun}/bin`.

The tested systems are macOS and Linux on arm64 and x86_64. Other operating
systems and architectures are unsupported. CI records a binary pass/fail
result for all four tested systems after every push to `main`; those hosted
results do not gate merging. Before merging, maintainers run
`scripts/local-gate.sh`, and only the result for the architecture of that Mac
is blocking.

Set `FMX_COMPANION_CHECKOUT` to reuse a local clone that contains the pinned
commit. Otherwise the installer fetches that exact commit.

fmx installs no program to run inside a Session. What a Session runs is the
caller's, named by its `argv` and found on the environment's own `PATH`.
