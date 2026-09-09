#!/usr/bin/env bash
#
# scripts/dev.sh — start the Tauri Vite frontend (port 5173).
# Kills any stale listener on 5173 first (strictPort in vite.config.ts).
# Used by `pnpm dev` and therefore by `pnpm tauri dev` (beforeDevCommand).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/_ui.sh
source "${SCRIPT_DIR}/_ui.sh"

stop_memlore_dev_server

cd "$REPO_ROOT"
exec pnpm exec vite
