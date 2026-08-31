#!/usr/bin/env bash

set -euo pipefail

# Post-install composition-level acceptance across the production private Fx
# provider, Companion daemon, PTY, Work-control, retirement, and Git-cleanup
# seams. It does not crash and replace the complete fmx Runtime process.

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${FMX_INSTALL_BIN_DIR:-$HOME/.local/bin}"
fx_path="${FMX_FX_PATH:-$install_dir/fmx-fx}"
zmx_path="${FMX_ZMX_PATH:-$install_dir/fmx-zmx}"
scratch_root="${FMX_PHASE1C_SCRATCH_ROOT:-${TMPDIR:-/tmp}}"
timeout_seconds="${FMX_PHASE1C_TIMEOUT_SECONDS:-75}"

fail() {
  printf 'fmx Phase 1C composition acceptance: %s\n' "$*" >&2
  exit 1
}

[[ -x "$fx_path" && -f "$fx_path" ]] \
  || fail "installed fmx-fx is absent: $fx_path (run scripts/install.sh --install)"
[[ -x "$zmx_path" && -f "$zmx_path" ]] \
  || fail "installed fmx-zmx is absent: $zmx_path (run scripts/install.sh --install)"
[[ -d "$scratch_root" && -w "$scratch_root" ]] \
  || fail "scratch root is not a writable directory: $scratch_root"
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] \
  || fail "FMX_PHASE1C_TIMEOUT_SECONDS must be a positive integer"
provider_probe="$("$fx_path" --internal-launch-provider 2>&1 || true)"
case "$provider_probe" in
  *IncompleteLaunchProviderConfiguration*) ;;
  *) fail "fmx-fx lacks the pinned private launch provider: $fx_path (run scripts/install.sh --install)" ;;
esac

# Keep this basename deliberately short: macOS caps Unix socket paths near
# 104 bytes, and the private provider adds a UUID directory plus provider.sock.
run_root="$(mktemp -d "$scratch_root/p1c.XXXXXX")"
chmod 700 "$run_root"
companion_directory="$run_root/z"
cleanup_summary="$run_root/runner-cleanup.json"
test_log="$run_root/test.log"
evidence_path="${FMX_PHASE1C_EVIDENCE_PATH:-$scratch_root/fmx-phase1c-real-process-evidence.$(date -u +%Y%m%dT%H%M%SZ).$$.json}"
case "$evidence_path" in
  /*) ;;
  *) fail "FMX_PHASE1C_EVIDENCE_PATH must be absolute" ;;
esac

test_pid=""
watchdog_pid=""
cleanup_complete=0
terminate_test() {
  if [[ -n "$test_pid" ]] && kill -0 "$test_pid" 2>/dev/null; then
    kill -TERM "$test_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$test_pid" 2>/dev/null || true
  fi
}
emergency_cleanup() {
  status=$?
  trap - EXIT INT TERM
  terminate_test
  if [[ "$cleanup_complete" -eq 0 ]]; then
    rm -f "$cleanup_summary"
    bun "$root_dir/scripts/phase1c-real-process-cleanup.ts" \
      --companion-directory "$companion_directory" \
      --zmx-path "$zmx_path" \
      --summary "$cleanup_summary" >>"$test_log" 2>&1 || true
  fi
  printf 'fmx Phase 1C composition acceptance: retained failure evidence at %s\n' "$run_root" >&2
  exit "$status"
}
trap emergency_cleanup EXIT
trap 'exit 130' INT TERM

cd "$root_dir"
FMX_RUN_PHASE1C_REAL_PROCESS=1 \
FMX_FX_PATH="$fx_path" \
FMX_ZMX_PATH="$zmx_path" \
FMX_PHASE1C_SCRATCH_ROOT="$scratch_root" \
FMX_PHASE1C_RUN_ROOT="$run_root" \
bun test tests/phase1c-real-process-composition-acceptance.test.ts >"$test_log" 2>&1 &
test_pid=$!
(
  sleep "$timeout_seconds"
  if kill -0 "$test_pid" 2>/dev/null; then
    printf 'fmx Phase 1C composition acceptance: timed out after %ss\n' "$timeout_seconds" >>"$test_log"
    kill -TERM "$test_pid" 2>/dev/null || true
    sleep 2
    kill -KILL "$test_pid" 2>/dev/null || true
  fi
) &
watchdog_pid=$!

set +e
wait "$test_pid"
test_status=$?
set -e
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=""
test_pid=""
cat "$test_log"

rm -f "$cleanup_summary"
set +e
bun "$root_dir/scripts/phase1c-real-process-cleanup.ts" \
  --companion-directory "$companion_directory" \
  --zmx-path "$zmx_path" \
  --summary "$cleanup_summary" 2>&1 | tee -a "$test_log"
cleanup_status=${PIPESTATUS[0]}
set -e
[[ "$cleanup_status" -eq 0 ]] || fail "runner could not prove all Companion/Fx processes reaped"
cleanup_complete=1
[[ "$test_status" -eq 0 ]] || fail "Bun acceptance failed with exit $test_status"

evidence_written="$(bun "$root_dir/scripts/phase1c-real-process-evidence.ts" \
  --output "$evidence_path" \
  --repository "$root_dir" \
  --fx-path "$fx_path" \
  --cleanup-summary "$cleanup_summary")"
[[ "$evidence_written" == "$evidence_path" ]] || fail "evidence writer returned an unexpected path"

rm -rf -- "$run_root"
trap - EXIT INT TERM
printf 'fmx Phase 1C composition acceptance: PASS\n'
printf 'fmx Phase 1C composition evidence: %s\n' "$evidence_path"
