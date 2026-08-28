#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

[[ "$(uname -s)" == Darwin ]] || {
  printf 'fmx local gate: macOS is required (found %s)\n' "$(uname -s)" >&2
  exit 1
}
case "$(uname -m)" in
  arm64) platform=macos-aarch64 ;;
  x86_64) platform=macos-x86_64 ;;
  *) printf 'fmx local gate: unsupported Mac architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

printf 'fmx local gate: gating on %s\n' "$platform"
scripts/install.sh --install
bun run typecheck
bun test
FMX_BINARY_PATH="${BUN_INSTALL:-$HOME/.bun}/bin/fmx" \
FMX_ZMX_PATH="${FMX_INSTALL_BIN_DIR:-$HOME/.local/bin}/fmx-zmx" \
FMX_RUN_PTY_TESTS=1 \
bun test tests/multiplexer.e2e.test.ts
printf 'fmx local gate: PASS %s\n' "$platform"
