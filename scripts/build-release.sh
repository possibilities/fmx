#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

platform="${1:-}"
case "$platform" in
  linux-x86_64)
    expected_os="Linux"
    expected_arch="x86_64"
    architecture_pattern="ELF 64-bit.*x86-64"
    native_package="@opentui/core-linux-x64"
    ;;
  linux-aarch64)
    expected_os="Linux"
    expected_arch="aarch64"
    architecture_pattern="ELF 64-bit.*(ARM aarch64|aarch64)"
    native_package="@opentui/core-linux-arm64"
    ;;
  macos-x86_64)
    expected_os="Darwin"
    expected_arch="x86_64"
    architecture_pattern="Mach-O 64-bit executable x86_64"
    native_package="@opentui/core-darwin-x64"
    ;;
  macos-aarch64)
    expected_os="Darwin"
    expected_arch="arm64"
    architecture_pattern="Mach-O 64-bit executable arm64"
    native_package="@opentui/core-darwin-arm64"
    ;;
  *)
    printf 'usage: %s <linux-x86_64|linux-aarch64|macos-x86_64|macos-aarch64>\n' "$0" >&2
    exit 2
    ;;
esac

if [[ "$(uname -s)" != "$expected_os" || "$(uname -m)" != "$expected_arch" ]]; then
  printf 'fmx release: %s must be built natively on %s/%s (this host is %s/%s)\n' \
    "$platform" "$expected_os" "$expected_arch" "$(uname -s)" "$(uname -m)" >&2
  exit 1
fi

for command in bun file tar gzip xz; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'fmx release: required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

version="$(bun -e 'const metadata = await Bun.file("package.json").json(); console.log(metadata.version)')"
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  printf 'fmx release: package.json version is not SemVer: %s\n' "$version" >&2
  exit 1
fi

binary="$root_dir/dist/fmx"
release_dir="${FMX_RELEASE_DIR:-$root_dir/dist/release}"
mkdir -p "$(dirname "$binary")" "$release_dir"

bun build ./src/index.ts --compile --minify --sourcemap=none --outfile "$binary"
chmod 0755 "$binary"

candidate="$(mktemp "${TMPDIR:-/tmp}/fmx-strip.XXXXXX")"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/fmx-release.XXXXXX")"
cleanup() {
  rm -f "$candidate"
  rm -rf "$work_dir"
}
trap cleanup EXIT
cp "$binary" "$candidate"
chmod 0755 "$candidate"

stripped=false
if [[ "$expected_os" == "Darwin" ]]; then
  if strip -x "$candidate" \
    && codesign --force --sign - "$candidate" >/dev/null 2>&1; then
    stripped=true
  fi
elif strip --strip-all "$candidate"; then
  stripped=true
fi

original_size="$(wc -c < "$binary" | tr -d ' ')"
candidate_size="$(wc -c < "$candidate" | tr -d ' ')"
if [[ "$stripped" == true \
  && "$candidate_size" -lt "$original_size" \
  && "$($candidate --version)" == "$version" \
  && "$($candidate --help)" == *"Usage:"* ]]; then
  mv "$candidate" "$binary"
  printf 'fmx release: retained stripped binary (%s -> %s bytes)\n' "$original_size" "$candidate_size"
else
  printf 'fmx release: retained compiler output (%s bytes); stripped candidate was not smaller and healthy\n' \
    "$original_size"
fi

if [[ "$expected_os" == "Darwin" ]]; then
  codesign --force --sign - "$binary" >/dev/null
fi

if [[ "$($binary --version)" != "$version" ]]; then
  printf 'fmx release: compiled binary version does not match package.json\n' >&2
  exit 1
fi
"$binary" --help | grep -q 'Usage:'
file "$binary" | grep -Eq "$architecture_pattern"
if [[ "$expected_os" == "Darwin" ]]; then
  codesign --verify "$binary"
fi

package_dir="$work_dir/package"
mkdir -p "$package_dir"
cp "$binary" "$root_dir/LICENSE" "$package_dir/"
cp "$root_dir/THIRD_PARTY_NOTICES.md" "$package_dir/THIRD_PARTY_NOTICES.md"
chmod 0755 "$package_dir/fmx"

append_notices() {
  local package_path="$1"
  shift
  local notice
  for notice in "$@"; do
    if [[ -f "$package_path/$notice" ]]; then
      {
        printf "\n\n---\n\n## %s — \`%s\`\n\n" "$package_path" "$notice"
        sed 's/[[:space:]]*$//' "$package_path/$notice"
      } >> "$package_dir/THIRD_PARTY_NOTICES.md"
    fi
  done
}

append_notices "node_modules/@opentui/core" LICENSE
append_notices "node_modules/bun-ffi-structs" LICENSE
append_notices "node_modules/diff" LICENSE
append_notices "node_modules/marked" LICENSE.md
append_notices "node_modules/string-width" license
append_notices "node_modules/strip-ansi" license
append_notices "node_modules/ansi-regex" license
append_notices "node_modules/emoji-regex" LICENSE-MIT.txt
append_notices "node_modules/get-east-asian-width" license

native_path="node_modules/$native_package"
if [[ ! -d "$native_path" ]]; then
  printf 'fmx release: native OpenTUI package not installed: %s\n' "$native_package" >&2
  exit 1
fi
for notice in "$native_path"/LICENSE* "$native_path"/AUTHORS* "$native_path"/PATENTS*; do
  [[ -f "$notice" ]] || continue
  {
    printf "\n\n---\n\n## %s — \`%s\`\n\n" "$native_package" "$(basename "$notice")"
    sed 's/[[:space:]]*$//' "$notice"
  } >> "$package_dir/THIRD_PARTY_NOTICES.md"
done

archive_base="fmx-$platform"
raw_archive="$work_dir/$archive_base.tar"
xz_archive="$release_dir/$archive_base.tar.xz"
gz_archive="$release_dir/$archive_base.tar.gz"
rm -f "$xz_archive" "$xz_archive.sha256" "$gz_archive" "$gz_archive.sha256"

COPYFILE_DISABLE=1 tar -cf "$raw_archive" -C "$package_dir" fmx LICENSE THIRD_PARTY_NOTICES.md
xz -9e -T0 -c "$raw_archive" > "$xz_archive"
gzip -9 -n -c "$raw_archive" > "$gz_archive"

write_checksum() {
  local path="$1"
  local digest
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(sha256sum "$path" | awk '{print $1}')"
  else
    digest="$(shasum -a 256 "$path" | awk '{print $1}')"
  fi
  printf '%s  %s\n' "$digest" "$(basename "$path")" > "$path.sha256"
}
write_checksum "$xz_archive"
write_checksum "$gz_archive"

verify_checksum() {
  local path="$1"
  local expected actual
  expected="$(awk 'NR == 1 { print $1 }' "$path.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$path" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$path" | awk '{print $1}')"
  fi
  [[ "$actual" == "$expected" ]]
}
verify_checksum "$xz_archive"
verify_checksum "$gz_archive"

mkdir -p "$work_dir/verify-xz" "$work_dir/verify-gz"
xz -dc "$xz_archive" | tar -xf - -C "$work_dir/verify-xz"
gzip -dc "$gz_archive" | tar -xf - -C "$work_dir/verify-gz"
for extracted in "$work_dir/verify-xz/fmx" "$work_dir/verify-gz/fmx"; do
  [[ -x "$extracted" ]]
  [[ "$($extracted --version)" == "$version" ]]
  file "$extracted" | grep -Eq "$architecture_pattern"
  [[ -f "$(dirname "$extracted")/LICENSE" ]]
  [[ -f "$(dirname "$extracted")/THIRD_PARTY_NOTICES.md" ]]
done

printf 'fmx release: built %s %s\n' "$platform" "$version"
ls -lh "$xz_archive" "$gz_archive"
