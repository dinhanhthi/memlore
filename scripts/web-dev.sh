#!/usr/bin/env bash
#
# scripts/web-dev.sh — start the browser UI preview harness (port 5175).
# Kills any stale listener on 5175 first (strictPort in web/vite.config.ts).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/_ui.sh
source "${SCRIPT_DIR}/_ui.sh"

stop_web_harness_dev_server

cd "$REPO_ROOT"

if lsof -ti ":5173" >/dev/null 2>&1; then
  ui_red_bold "Note: port 5173 (pnpm tauri dev) is also running."
  ui_red "      Web preview is ONLY at http://localhost:5175 — not 5173."
  echo ""
fi

if [[ -z "${MEMLORE_WEB_DEV_NO_OPEN:-}" && "$(uname -s)" == "Darwin" && ! -t 0 ]]; then
  # Launch from a GUI terminal — open the correct URL so 5173 is not mistaken for web preview.
  open "http://localhost:5175/" >/dev/null 2>&1 || true
fi

exec vite --config web/vite.config.ts