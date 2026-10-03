#!/usr/bin/env bash
# Build a workspace crate for wasm32-unknown-unknown.
# Usage: scripts/wasm-check.sh <crate>
# Every wasm32 build in the web-app plan goes through here. No getrandom
# backend RUSTFLAGS are needed: the tree only has getrandom 0.2 (feature "js").
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ $# -ne 1 ]; then
  echo "usage: scripts/wasm-check.sh <crate>" >&2
  exit 1
fi

cd "$root/src-tauri"
exec cargo build -p "$1" --target wasm32-unknown-unknown
