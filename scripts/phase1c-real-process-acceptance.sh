#!/usr/bin/env bash

set -euo pipefail

# Post-install acceptance for the one lifecycle scenario that intentionally
# crosses the real private Fx provider, Companion daemon, PTY, and semantic
# Work-control endpoint. The ordinary cross-platform suite retains a named
# skip because those installed native prerequisites are not CI fixtures.

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${FMX_INSTALL_BIN_DIR:-$HOME/.local/bin}"
fx_path="${FMX_FX_PATH:-$install_dir/fmx-fx}"
zmx_path="${FMX_ZMX_PATH:-$install_dir/fmx-zmx}"
scratch_root="${FMX_PHASE1C_SCRATCH_ROOT:-${TMPDIR:-/tmp}}"

fail() {
  printf 'fmx Phase 1C real-process acceptance: %s\n' "$*" >&2
  exit 1
}

[[ -x "$fx_path" && -f "$fx_path" ]] \
  || fail "installed fmx-fx is absent: $fx_path (run scripts/install.sh --install)"
[[ -x "$zmx_path" && -f "$zmx_path" ]] \
  || fail "installed fmx-zmx is absent: $zmx_path (run scripts/install.sh --install)"
[[ -d "$scratch_root" && -w "$scratch_root" ]] \
  || fail "scratch root is not a writable directory: $scratch_root"
provider_probe="$("$fx_path" --internal-launch-provider 2>&1 || true)"
case "$provider_probe" in
  *IncompleteLaunchProviderConfiguration*) ;;
  *) fail "fmx-fx lacks the pinned private launch provider: $fx_path (run scripts/install.sh --install)" ;;
esac

cd "$root_dir"
FMX_RUN_PHASE1C_REAL_PROCESS=1 \
FMX_FX_PATH="$fx_path" \
FMX_ZMX_PATH="$zmx_path" \
FMX_PHASE1C_SCRATCH_ROOT="$scratch_root" \
bun test tests/phase1c-real-process-acceptance.test.ts
