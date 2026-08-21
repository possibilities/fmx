#!/usr/bin/env bash

set -euo pipefail

release_base_url="${FMX_RELEASE_BASE_URL:-__FMX_RELEASE_BASE_URL__}"
unconfigured_release_base_url='__FMX_'"RELEASE_BASE_URL__"
install_dir="${FMX_INSTALL_DIR:-$HOME/.local/bin}"
requested_version="${FMX_VERSION:-}"

fail() {
  printf 'fmx setup: %s\n' "$*" >&2
  exit 1
}

if [[ "$release_base_url" == "$unconfigured_release_base_url" ]]; then
  fail 'this installer has not been configured with a public release URL'
fi
release_base_url="${release_base_url%/}"

for command in curl tar gzip; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="macos" ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac
platform="$os-$arch"

curl_get() {
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 10 "$@"
}

if [[ -z "$requested_version" ]]; then
  requested_version="$(curl_get "$release_base_url/latest.txt")"
fi
requested_version="${requested_version//$'\r'/}"
requested_version="${requested_version//$'\n'/}"
if [[ ! "$requested_version" =~ ^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  fail "invalid release version: $requested_version"
fi
version="${requested_version#v}"
release="v$version"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/fmx-setup.XXXXXX")"
install_temp=""
cleanup() {
  rm -rf "$temp_dir"
  if [[ -n "$install_temp" ]]; then rm -f "$install_temp"; fi
}
trap cleanup EXIT

archive_stem="fmx-$platform.tar"
archive=""
if command -v xz >/dev/null 2>&1; then
  archive="$archive_stem.xz"
  if ! curl_get "$release_base_url/releases/$release/$archive" -o "$temp_dir/$archive" \
    || ! curl_get "$release_base_url/releases/$release/$archive.sha256" -o "$temp_dir/$archive.sha256"; then
    printf 'fmx setup: xz artifact unavailable; trying gzip\n' >&2
    archive=""
  fi
fi
if [[ -z "$archive" ]]; then
  archive="$archive_stem.gz"
  curl_get "$release_base_url/releases/$release/$archive" -o "$temp_dir/$archive"
  curl_get "$release_base_url/releases/$release/$archive.sha256" -o "$temp_dir/$archive.sha256"
fi

expected_checksum="$(awk 'NR == 1 { print $1 }' "$temp_dir/$archive.sha256")"
if [[ ! "$expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]]; then
  fail "invalid SHA-256 file for $archive"
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$temp_dir/$archive" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$temp_dir/$archive" | awk '{ print $1 }')"
else
  fail 'SHA-256 verification requires sha256sum or shasum'
fi
if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  fail "SHA-256 mismatch for $archive"
fi

extract_dir="$temp_dir/extract"
mkdir -p "$extract_dir"
case "$archive" in
  *.tar.xz) xz -dc "$temp_dir/$archive" | tar -xf - -C "$extract_dir" ;;
  *.tar.gz) gzip -dc "$temp_dir/$archive" | tar -xf - -C "$extract_dir" ;;
esac
[[ -x "$extract_dir/fmx" ]] || fail 'archive does not contain an executable fmx binary'
if [[ "$("$extract_dir/fmx" --version)" != "$version" ]]; then
  fail 'downloaded binary version does not match the requested release'
fi

mkdir -p "$install_dir"
install_temp="$(mktemp "$install_dir/.fmx.XXXXXX")"
cp "$extract_dir/fmx" "$install_temp"
chmod 0755 "$install_temp"
mv -f "$install_temp" "$install_dir/fmx"
install_temp=""

if [[ "$("$install_dir/fmx" --version)" != "$version" ]]; then
  fail 'installed binary did not pass its version check'
fi

printf 'Installed fmx %s at %s/fmx\n' "$version" "$install_dir"
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *)
    printf '%s\n' "Add $install_dir to PATH, for example:" \
      "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac
if ! command -v fx >/dev/null 2>&1; then
  printf 'fmx setup: fx is not on PATH; install it from https://fx.sh/ before running fmx\n' >&2
fi
