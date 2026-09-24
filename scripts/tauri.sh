#!/usr/bin/env bash
# Dispatch the Tauri CLI from the repo root.
# `build` pins CARGO_TARGET_DIR so the bundle stays under src-tauri/target.
# `dev` does not: it follows ~/.cargo/config.toml. An inherited
# CARGO_TARGET_DIR still wins for dev, because the environment outranks config.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tauri="$root/node_modules/.bin/tauri"

if [ ! -x "$tauri" ]; then
  echo "error: run pnpm install at the repo root first" >&2
  exit 1
fi

if [ "${1:-}" = "build" ]; then
  # Leave this pin. Release bundles stay at
  # src-tauri/target/release/bundle/macos/Memlore.app.
  export CARGO_TARGET_DIR="$root/src-tauri/target"
fi

cd "$root"
exec "$tauri" "$@"
