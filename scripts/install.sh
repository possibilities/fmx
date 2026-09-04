#!/usr/bin/env bash

set -euo pipefail

# Canonical source installation for fmx and the one native program it pins.
# Consumers and fleet automation use this same entrypoint.

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-}"

fail() {
  printf 'fmx source install: %s\n' "$*" >&2
  exit 1
}

case "$mode" in
  --install|--check) ;;
  -h|--help)
    printf 'usage: %s --install|--check\n' "$0"
    exit 0
    ;;
  *) fail 'expected --install or --check' ;;
esac

install_dir="${FMX_INSTALL_BIN_DIR:-$HOME/.local/bin}"
companion_installed="$install_dir/fmx-zmx"

printf '%s\n' \
  "fmx source install:" \
  "  bun install --frozen-lockfile and link fmx in $root_dir" \
  "  build the pinned Companion as $companion_installed" \
  "  verify the complete installation with fmx doctor"

if [[ "$mode" == --check ]]; then
  FMX_COMPANION_INSTALL_DIR="$install_dir" "$root_dir/scripts/install-companion.sh" --check
  exit 0
fi

for command in bun git zig; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

bun install --cwd "$root_dir" --frozen-lockfile \
  || fail 'frozen dependency installation failed'
(cd "$root_dir" && bun link) || fail 'bun link failed'
bun_bin="${BUN_INSTALL:-$HOME/.bun}/bin"
[[ -x "$bun_bin/fmx" ]] || fail "bun link did not install an executable $bun_bin/fmx"

mkdir -p "$install_dir"

FMX_COMPANION_INSTALL_DIR="$install_dir" "$root_dir/scripts/install-companion.sh"

PATH="$install_dir:${PATH:-}" \
FMX_ZMX_PATH="$companion_installed" \
bun "$root_dir/src/index.ts" doctor \
  || fail 'fmx doctor rejected the source installation'

printf 'fmx source install: linked fmx and installed the pinned Companion from source\n'
