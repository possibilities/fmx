#!/usr/bin/env bash

set -euo pipefail

# Install the exact Zig the Companion builds with, on a CI runner: a pinned
# release tarball from ziglang.org, verified against its published checksum,
# unpacked under ~/.local and put on the job's PATH. Nothing floating.

ZIG_VERSION="0.16.0"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  triple="x86_64-linux";  sha256="70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00" ;;
  Linux-aarch64) triple="aarch64-linux"; sha256="ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17" ;;
  Darwin-x86_64) triple="x86_64-macos";  sha256="0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7" ;;
  Darwin-arm64)  triple="aarch64-macos"; sha256="b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489" ;;
  *)
    printf 'ci-install-zig: unsupported host %s-%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

name="zig-$triple-$ZIG_VERSION"
install_root="${ZIG_INSTALL_ROOT:-$HOME/.local/zig}"
if [[ -x "$install_root/$name/zig" && "$("$install_root/$name/zig" version)" == "$ZIG_VERSION" ]]; then
  printf 'ci-install-zig: %s already installed\n' "$name"
else
  work="$(mktemp -d "${TMPDIR:-/tmp}/zig-install.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  curl --fail --silent --show-error --location --retry 3 \
    -o "$work/$name.tar.xz" "https://ziglang.org/download/$ZIG_VERSION/$name.tar.xz"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$work/$name.tar.xz" | awk '{ print $1 }')"
  else
    actual="$(shasum -a 256 "$work/$name.tar.xz" | awk '{ print $1 }')"
  fi
  if [[ "$actual" != "$sha256" ]]; then
    printf 'ci-install-zig: checksum mismatch for %s\n' "$name" >&2
    exit 1
  fi
  mkdir -p "$install_root"
  tar -xJf "$work/$name.tar.xz" -C "$install_root"
  [[ "$("$install_root/$name/zig" version)" == "$ZIG_VERSION" ]]
  printf 'ci-install-zig: installed %s\n' "$name"
fi

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$install_root/$name" >> "$GITHUB_PATH"
fi
printf 'ci-install-zig: zig at %s/%s/zig\n' "$install_root" "$name"
