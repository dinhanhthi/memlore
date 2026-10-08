#!/usr/bin/env bash
# Build memlore-wasm (release) and generate the web bindings into web/src/core/pkg.
# Usage: scripts/web-wasm.sh [--check-only | --test-sealers]
#   --check-only    only verify the wasm-bindgen-cli version, then exit
#   --test-sealers  build with feature test-sealers (exports sealEntry/sealMedia/sealVersion)
#                   into web/src/core/pkg-test (gitignored; tests only, never ship)
#   LOCK_FILE=...  override the Cargo.lock to read (testing)
# The wasm-bindgen-cli version must equal the wasm-bindgen version in Cargo.lock.
# RUSTFLAGS: none, same as scripts/wasm-check.sh (keep them in sync).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="${LOCK_FILE:-$root/src-tauri/Cargo.lock}"
out_dir="$root/web/src/core/pkg"
features=()
mode=""
case "$#:${1:-}" in
  0:) ;;
  1:--test-sealers)
    mode="test-sealers"
    out_dir="$root/web/src/core/pkg-test"
    features=(--features test-sealers)
    ;;
  1:--check-only) mode="check-only" ;;
  *)
    echo "usage: pnpm web:wasm [--check-only | --test-sealers] (no '--' before the flag)" >&2
    exit 2
    ;;
esac

want="$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/[^0-9.]/, "", $0); print; exit }' "$lock")"
if [ -z "$want" ]; then
  echo "could not find wasm-bindgen in $lock" >&2
  exit 1
fi

have="$(wasm-bindgen --version 2>/dev/null | awk '{ print $2 }' || true)"
if [ "$have" != "$want" ]; then
  echo "wasm-bindgen-cli is '${have:-missing}', Cargo.lock needs $want. Run:" >&2
  echo "cargo install wasm-bindgen-cli --version =$want --locked" >&2
  exit 1
fi

if [ "$mode" = "check-only" ]; then
  exit 0
fi

cd "$root/src-tauri"
cargo build --locked -p memlore-wasm --target wasm32-unknown-unknown --release ${features[@]+"${features[@]}"}

target_dir="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"

mkdir -p "$out_dir"
wasm-bindgen --target web --out-dir "$out_dir" \
  "$target_dir/wasm32-unknown-unknown/release/memlore_wasm.wasm"

# The production package must never export the test-only sealers.
if [ -z "$mode" ] && grep -Eq 'sealEntry|sealMedia|sealVersion' "$out_dir"/memlore_wasm.d.ts; then
  echo "production pkg exports test-only sealers (sealEntry/sealMedia/sealVersion)" >&2
  exit 1
fi
