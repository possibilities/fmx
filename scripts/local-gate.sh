#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

[[ "$(uname -s)" == Darwin ]] || {
  printf 'smolmux local gate: macOS is required (found %s)\n' "$(uname -s)" >&2
  exit 1
}
case "$(uname -m)" in
  arm64) platform=macos-aarch64 ;;
  x86_64) platform=macos-x86_64 ;;
  *) printf 'smolmux local gate: unsupported Mac architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

printf 'smolmux local gate: gating on %s\n' "$platform"
scripts/install.sh --install
bun run typecheck
SMOLMUX_ZMX_PATH="${SMOLMUX_INSTALL_BIN_DIR:-$HOME/.local/bin}/smolmux-zmx" bun test
SMOLMUX_BINARY_PATH="${BUN_INSTALL:-$HOME/.bun}/bin/smolmux" \
SMOLMUX_ZMX_PATH="${SMOLMUX_INSTALL_BIN_DIR:-$HOME/.local/bin}/smolmux-zmx" \
SMOLMUX_RUN_PTY_TESTS=1 \
bun test tests/instance.e2e.test.ts
printf 'smolmux local gate: PASS %s\n' "$platform"
