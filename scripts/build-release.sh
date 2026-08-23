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
    companion_target="x86_64-linux-musl"
    ;;
  linux-aarch64)
    expected_os="Linux"
    expected_arch="aarch64"
    architecture_pattern="ELF 64-bit.*(ARM aarch64|aarch64)"
    native_package="@opentui/core-linux-arm64"
    companion_target="aarch64-linux-musl"
    ;;
  macos-x86_64)
    expected_os="Darwin"
    expected_arch="x86_64"
    architecture_pattern="Mach-O 64-bit executable x86_64"
    native_package="@opentui/core-darwin-x64"
    companion_target="x86_64-macos"
    ;;
  macos-aarch64)
    expected_os="Darwin"
    expected_arch="arm64"
    architecture_pattern="Mach-O 64-bit executable arm64"
    native_package="@opentui/core-darwin-arm64"
    companion_target="aarch64-macos"
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

# zig and git are the Companion's: the fork is fetched at its pinned commit
# and built here, natively, beside fmx.
for command in bun file tar gzip xz git zig; do
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

# The Companion pin: the fork commit this release ships, and the build string
# a Companion built from it reports. companion.json is also compiled into fmx,
# which refuses any other build it finds beside itself.
companion_repository="$(bun -e 'const pin = await Bun.file("companion.json").json(); console.log(pin.repository)')"
companion_commit="$(bun -e 'const pin = await Bun.file("companion.json").json(); console.log(pin.commit)')"
companion_build="$(bun -e 'const pin = await Bun.file("companion.json").json(); console.log(pin.build)')"
if [[ ! "$companion_commit" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'fmx release: companion.json commit is not a full sha: %s\n' "$companion_commit" >&2
  exit 1
fi
if [[ "$companion_build" != *"+fmx.${companion_commit:0:12}" ]]; then
  printf 'fmx release: companion.json build %s does not name commit %s\n' "$companion_build" "${companion_commit:0:12}" >&2
  exit 1
fi

binary="$root_dir/dist/fmx"
companion_binary="$root_dir/dist/fmx-zmx"
release_dir="${FMX_RELEASE_DIR:-$root_dir/dist/release}"
mkdir -p "$(dirname "$binary")" "$release_dir"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/fmx-release.XXXXXX")"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

# --- the Companion -----------------------------------------------------------

# The fork's source at the pinned commit: a checkout the caller names, which
# must sit exactly at the pin with nothing modified, or else a fetch of that
# one commit into the work directory.
companion_source="${FMX_COMPANION_CHECKOUT:-}"
if [[ -n "$companion_source" ]]; then
  if [[ "$(git -C "$companion_source" rev-parse HEAD 2>/dev/null)" != "$companion_commit" ]]; then
    printf 'fmx release: FMX_COMPANION_CHECKOUT %s is not at the pinned commit %s\n' "$companion_source" "$companion_commit" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$companion_source" status --porcelain --untracked-files=no)" ]]; then
    printf 'fmx release: FMX_COMPANION_CHECKOUT %s has uncommitted changes\n' "$companion_source" >&2
    exit 1
  fi
else
  companion_source="$work_dir/companion-src"
  mkdir -p "$companion_source"
  git -C "$companion_source" init -q
  git -C "$companion_source" fetch -q --depth 1 "$companion_repository" "$companion_commit"
  git -C "$companion_source" checkout -q --detach FETCH_HEAD
  if [[ "$(git -C "$companion_source" rev-parse HEAD)" != "$companion_commit" ]]; then
    printf 'fmx release: fetched %s but HEAD is not the pinned commit\n' "$companion_repository" >&2
    exit 1
  fi
fi

# The build string is the fork's own version plus build metadata naming the
# commit; the fork's version comes from its build.zig.zon, so the two are
# checked against each other rather than trusted.
companion_version="$( (grep -m 1 -E '^[[:space:]]*\.version = "' "$companion_source/build.zig.zon" || true) | sed 's/^[[:space:]]*\.version = "\([^"]*\)",.*/\1/')"
if [[ -z "$companion_version" ]]; then
  printf 'fmx release: no .version in %s/build.zig.zon\n' "$companion_source" >&2
  exit 1
fi
if [[ "$companion_build" != "$companion_version+fmx.${companion_commit:0:12}" ]]; then
  printf 'fmx release: companion.json build %s is not %s+fmx.%s (the fork at the pin is version %s)\n' \
    "$companion_build" "$companion_version" "${companion_commit:0:12}" "$companion_version" >&2
  exit 1
fi
minimum_zig="$( (grep -m 1 -E '^[[:space:]]*\.minimum_zig_version = "' "$companion_source/build.zig.zon" || true) | sed 's/^[[:space:]]*\.minimum_zig_version = "\([^"]*\)",.*/\1/')"
if [[ -z "$minimum_zig" ]]; then
  printf 'fmx release: no .minimum_zig_version in %s/build.zig.zon\n' "$companion_source" >&2
  exit 1
fi
zig_series="${minimum_zig%.*}"
if [[ "$(zig version)" != "$zig_series".* ]]; then
  printf 'fmx release: the Companion builds with zig %s.x (found %s)\n' "$zig_series" "$(zig version)" >&2
  exit 1
fi

companion_prefix="$work_dir/companion"
(cd "$companion_source" && zig build -Dcompanion -Doptimize=ReleaseFast -Dversion="$companion_build" -Dtarget="$companion_target" --prefix "$companion_prefix")
cp "$companion_prefix/bin/zmx" "$companion_binary"
chmod 0755 "$companion_binary"

# --- fmx ---------------------------------------------------------------------

bun build ./src/index.ts --compile --minify --sourcemap=none --outfile "$binary"
chmod 0755 "$binary"

# What each executable must still do after stripping: fmx answers --version
# and --help, the Companion reports its build. The Companion's `version`
# creates the directory it is given, so it is given one here, never the
# build host's own or one an inherited ZMX_DIR names.
fmx_healthy() {
  [[ "$("$1" --version)" == "$version" && "$("$1" --help)" == *"Usage:"* ]]
}
companion_healthy() {
  local output
  output="$(ZMX_DIR="$work_dir/version-check" "$1" version 2>&1 || true)"
  [[ "$(printf '%s\n' "$output" | awk 'NR == 1 && $1 == "zmx" { print $2 }')" == "$companion_build" ]]
}

# Strip an executable in place when the stripped copy is smaller and still
# healthy; otherwise keep the compiler's output. On macOS the result is
# ad-hoc signed either way.
slim() {
  local path="$1" healthy="$2" candidate stripped=false original_size candidate_size
  candidate="$(mktemp "$work_dir/strip.XXXXXX")"
  cp "$path" "$candidate"
  chmod 0755 "$candidate"
  if [[ "$expected_os" == "Darwin" ]]; then
    if strip -x "$candidate" \
      && codesign --force --sign - "$candidate" >/dev/null 2>&1; then
      stripped=true
    fi
  elif strip --strip-all "$candidate"; then
    stripped=true
  fi
  original_size="$(wc -c < "$path" | tr -d ' ')"
  candidate_size="$(wc -c < "$candidate" | tr -d ' ')"
  if [[ "$stripped" == true && "$candidate_size" -lt "$original_size" ]] && "$healthy" "$candidate"; then
    mv "$candidate" "$path"
    printf 'fmx release: retained stripped %s (%s -> %s bytes)\n' "$(basename "$path")" "$original_size" "$candidate_size"
  else
    rm -f "$candidate"
    printf 'fmx release: retained compiler output for %s (%s bytes); stripped candidate was not smaller and healthy\n' \
      "$(basename "$path")" "$original_size"
  fi
  if [[ "$expected_os" == "Darwin" ]]; then
    codesign --force --sign - "$path" >/dev/null
    codesign --verify "$path"
  fi
  file "$path" | grep -Eq "$architecture_pattern"
}

slim "$binary" fmx_healthy
slim "$companion_binary" companion_healthy

if [[ "$($binary --version)" != "$version" ]]; then
  printf 'fmx release: compiled binary version does not match package.json\n' >&2
  exit 1
fi
"$binary" --help | grep -q 'Usage:'
if ! companion_healthy "$companion_binary"; then
  printf 'fmx release: the Companion does not report the pinned build %s\n' "$companion_build" >&2
  "$companion_binary" version >&2 || true
  exit 1
fi

package_dir="$work_dir/package"
mkdir -p "$package_dir"
cp "$binary" "$root_dir/LICENSE" "$package_dir/"
cp "$companion_binary" "$package_dir/fmx-zmx"
cp "$root_dir/THIRD_PARTY_NOTICES.md" "$package_dir/THIRD_PARTY_NOTICES.md"
chmod 0755 "$package_dir/fmx" "$package_dir/fmx-zmx"

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

COPYFILE_DISABLE=1 tar -cf "$raw_archive" -C "$package_dir" fmx fmx-zmx LICENSE THIRD_PARTY_NOTICES.md
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
  [[ -x "$(dirname "$extracted")/fmx-zmx" ]]
  companion_healthy "$(dirname "$extracted")/fmx-zmx"
  file "$(dirname "$extracted")/fmx-zmx" | grep -Eq "$architecture_pattern"
  [[ -f "$(dirname "$extracted")/LICENSE" ]]
  [[ -f "$(dirname "$extracted")/THIRD_PARTY_NOTICES.md" ]]
  # The pair, as installed: fmx finds the Companion beside itself and
  # accepts it as the pinned build. The build host's own override, if it
  # has one for its checkout, must not stand in for the sibling.
  if ! env -u FMX_ZMX_PATH FMX_ZMX_DIR="$work_dir/doctor-zmx" XDG_CONFIG_HOME="$work_dir/doctor-config" "$extracted" doctor > "$work_dir/doctor.txt" \
    || ! grep -q "^build  *$companion_build (the build this fmx was released with)" "$work_dir/doctor.txt" \
    || ! grep -q "^companion  *.*/fmx-zmx (beside " "$work_dir/doctor.txt"; then
    printf 'fmx release: the extracted pair did not pass fmx doctor:\n' >&2
    cat "$work_dir/doctor.txt" >&2
    exit 1
  fi
done

printf 'fmx release: built %s %s with companion %s\n' "$platform" "$version" "$companion_build"
ls -lh "$xz_archive" "$gz_archive"
