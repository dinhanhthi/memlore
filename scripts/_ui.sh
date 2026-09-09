# Shared terminal helpers for scripts/*.sh
# shellcheck shell=bash

if [[ -t 1 ]]; then
  UI_RED='\033[31m'
  UI_BOLD='\033[1m'
  UI_RESET='\033[0m'
else
  UI_RED=''
  UI_BOLD=''
  UI_RESET=''
fi

ui_red() {
  printf '%b%s%b\n' "$UI_RED" "$*" "$UI_RESET"
}

ui_red_bold() {
  printf '%b%b%s%b\n' "$UI_RED" "$UI_BOLD" "$*" "$UI_RESET"
}

# Stop any process listening on the given port (SIGTERM, then SIGKILL).
stop_port_listeners() {
  local port="$1"
  local label="${2:-port ${port}}"
  local pids
  pids="$(lsof -ti ":${port}" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  echo "Stopping stale ${label}..."
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(lsof -ti ":${port}" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  echo "Stopped: ${label}"
}

# Stop the Memlore Vite dev server if it is still listening on port 5173.
# A leftover `pnpm tauri dev` / `pnpm dev` process blocks the next launch
# because vite.config.ts sets strictPort: true on 5173.
stop_memlore_dev_server() {
  stop_port_listeners 5173 "dev server on port 5173"
}

# Stop the web UI harness if it is still listening on port 5175.
# `pnpm web:dev` uses strictPort: true in web/vite.config.ts.
stop_web_harness_dev_server() {
  stop_port_listeners 5175 "web harness dev server on port 5175"
}