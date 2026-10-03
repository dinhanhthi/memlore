#!/usr/bin/env bash
# Desktop dependency guard for the web-app plan.
# Fails (exit 1) when the desktop build's dependency surface changed:
#   (a) a [[package]] from the pre-workspace Cargo.lock baseline changed
#       version/checksum or was removed (only additions are allowed);
#   (b) `cargo tree -e features -p memlore` differs from the baseline, ignoring
#       memlore-core lines and the " (*)" dedup marker (cargo prints it on the
#       first sight of a repeated node, so it moves when memlore-core becomes
#       a second parent of a crate; it carries no dependency information).
# Baselines are local, gitignored context files: when missing, warn and exit 0.
# Overrides for testing: LOCK_BASELINE, DEPS_BASELINE.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_baseline="${LOCK_BASELINE:-$root/docs/context/2026-10-02-web-app.Cargo.lock.baseline}"
deps_baseline="${DEPS_BASELINE:-$root/docs/context/2026-10-02-web-app.deps-baseline.txt}"
lock="$root/src-tauri/Cargo.lock"

if [ ! -f "$lock_baseline" ] || [ ! -f "$deps_baseline" ]; then
  echo "warning: desktop dependency baselines missing under docs/context, skipping" >&2
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# One "name version checksum" line per package, sorted.
packages() {
  awk '
    function flush() { if (name != "") print name, version, checksum; name = version = checksum = "" }
    /^\[\[package\]\]/ { flush(); next }
    /^name = /     { gsub(/"/, "", $3); name = $3 }
    /^version = /  { gsub(/"/, "", $3); version = $3 }
    /^checksum = / { gsub(/"/, "", $3); checksum = $3 }
    END { flush() }
  ' "$1" | sort -u
}

fail=0

packages "$lock_baseline" > "$tmp/lock.base"
packages "$lock" > "$tmp/lock.cur"
missing="$(comm -23 "$tmp/lock.base" "$tmp/lock.cur")"
if [ -n "$missing" ]; then
  echo "FAIL: Cargo.lock packages changed or removed since baseline (name version checksum):" >&2
  echo "$missing" | sed 's/^/  /' >&2
  fail=1
fi

norm() { sed 's/ (\*)$//' | grep -v 'memlore-core' | sort -u || true; }

norm < "$deps_baseline" > "$tmp/deps.base"
(cd "$root/src-tauri" && cargo tree --locked -e features -p memlore --prefix none) | norm > "$tmp/deps.cur"
if ! diff_out="$(diff "$tmp/deps.base" "$tmp/deps.cur")"; then
  echo "FAIL: memlore feature tree differs from baseline ('<' baseline, '>' current):" >&2
  echo "$diff_out" | grep '^[<>]' | sed 's/^/  /' >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "desktop dependency guard: ok"
