#!/usr/bin/env bash

set -euo pipefail

# Canonical source installation for fmx and both native programs it pins.
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
fx_installed="$install_dir/fmx-fx"
companion_installed="$install_dir/fmx-zmx"

pin_value() {
  local file="$1" key="$2"
  sed -n 's/^[[:space:]]*"'"$key"'":[[:space:]]*"\([^"]*\)".*/\1/p' "$root_dir/$file" | head -n 1
}

fx_repository="$(pin_value fx.json repository)"
fx_commit="$(pin_value fx.json commit)"
fxnk_version="$(pin_value fx.json fxnk)"
[[ "$fx_commit" =~ ^[0-9a-f]{40}$ ]] || fail "fx.json commit is not a full SHA: $fx_commit"
[[ "$fxnk_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "fx.json fxnk is not SemVer: $fxnk_version"

printf '%s\n' \
  "fmx source install:" \
  "  bun install --frozen-lockfile and link fmx plus fmx-mcp in $root_dir" \
  "  build Fx $fx_commit from source as $fx_installed" \
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
bun_bin="$(bun pm bin -g)"
for linked_command in fmx fmx-mcp; do
  [[ -x "$bun_bin/$linked_command" ]] \
    || fail "bun link did not install an executable $bun_bin/$linked_command"
done

mkdir -p "$install_dir"
[[ ! -e "$fx_installed" || -f "$fx_installed" ]] \
  || fail "$fx_installed exists and is not a regular file"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/fmx-source-install.XXXXXX")"
source_repo=""
source_worktree=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$source_worktree" && -d "$source_worktree" ]]; then
    git -C "$source_repo" worktree remove --force "$source_worktree" >/dev/null 2>&1 || true
  fi
  case "$work_dir" in
    "${TMPDIR:-/tmp}"/fmx-source-install.*) rm -rf "$work_dir" ;;
    *) printf 'fmx source install: refusing to clean unexpected path: %s\n' "$work_dir" >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT

candidate="$work_dir/fmx-fx"
if [[ -n "${FMX_FX_BINARY:-}" ]]; then
  [[ "${FMX_FX_COMMIT:-}" == "$fx_commit" ]] \
    || fail "FMX_FX_BINARY requires FMX_FX_COMMIT=$fx_commit"
  [[ -x "$FMX_FX_BINARY" && -f "$FMX_FX_BINARY" ]] \
    || fail "FMX_FX_BINARY is not an executable regular file: $FMX_FX_BINARY"
  cp "$FMX_FX_BINARY" "$candidate"
else
  checkout="${FMX_FX_CHECKOUT:-}"
  if [[ -z "$checkout" && -d "$HOME/src/fx/.git" ]]; then
    checkout="$HOME/src/fx"
  fi
  fx_source="$work_dir/fx"
  if [[ -n "$checkout" ]] && git -C "$checkout" cat-file -e "$fx_commit^{commit}" 2>/dev/null; then
    source_repo="$checkout"
    source_worktree="$fx_source"
    git -C "$source_repo" worktree add --quiet --detach "$source_worktree" "$fx_commit" \
      || fail "could not check out $fx_commit from $checkout"
  else
    mkdir -p "$fx_source"
    git -C "$fx_source" init -q
    git -C "$fx_source" fetch -q --depth 1 "$fx_repository" "$fx_commit" \
      || fail "could not fetch $fx_commit from $fx_repository"
    git -C "$fx_source" checkout -q --detach FETCH_HEAD
  fi
  [[ "$(git -C "$fx_source" rev-parse HEAD)" == "$fx_commit" ]] \
    || fail 'Fx source is not at the pinned commit'
  (cd "$fx_source" && zig build -Doptimize=ReleaseSafe) \
    || fail "Fx build failed at $fx_commit"
  cp "$fx_source/zig-out/bin/fx" "$candidate"
fi

chmod 0755 "$candidate"
fx_probe="$("$candidate" --fxnk-version 2>/dev/null || true)"
case "$fx_probe" in
  "fxnk $fxnk_version (fx "*) ;;
  *) fail "pinned Fx returned an incompatible identity: $fx_probe" ;;
esac
mv -f "$candidate" "$fx_installed"

FMX_COMPANION_INSTALL_DIR="$install_dir" "$root_dir/scripts/install-companion.sh"

PATH="$install_dir:${PATH:-}" \
FMX_FX_PATH="$fx_installed" \
FMX_ZMX_PATH="$companion_installed" \
bun "$root_dir/src/index.ts" doctor \
  || fail 'fmx doctor rejected the source installation'

printf 'fmx source install: installed Fx %s and the pinned Companion from source\n' "${fx_commit:0:12}"
