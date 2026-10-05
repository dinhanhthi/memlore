#!/usr/bin/env bash
# web-local.sh — run the web companion locally in ONE terminal (`pnpm web:local`):
# the OAuth Worker (`pnpm web-auth:dev`, :8787) and the web app on :5176, each
# with its own coloured prefix. Ctrl+C stops both; if one exits, the other stops.
#
#   pnpm web:local           hot-reload dev server (`pnpm web:dev`), for coding
#   pnpm web:local --prod    production bundle (`pnpm web:build && pnpm web:preview`), for testing
#
# Any other arguments go to the Worker, e.g. `pnpm web:local --var WEB_WRITES_ENABLED:1`.
# First time: create workers/web-auth/.dev.vars (CONTRIBUTING.md → "Run it locally").
#
# Written for the bash 3.2 macOS ships (no `wait -n`).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="dev"
WORKER_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --prod) MODE="prod" ;;
    *) WORKER_ARGS+=("$arg") ;;
  esac
done

WEB_PORT=5176
WORKER_COLOR="35" # magenta
WEB_COLOR="36"    # cyan

if [[ ! -f workers/web-auth/.dev.vars ]]; then
  echo "workers/web-auth/.dev.vars is missing: sign-in will fail with 500."
  echo "Create it first (CONTRIBUTING.md → \"Run it locally\")."
  exit 1
fi

# A leftover web dev server or preview of THIS repo on :5176 is stopped; anything
# else on the port is reported and left alone. (The Worker script does the same
# for :8787.)
for pid in $(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true); do
  cmd="$(ps -o command= -p "$pid" || true)"
  case "$cmd" in
    *"$REPO_ROOT/node_modules/"*vite*)
      echo "Stopping the previous local web server on :$WEB_PORT (pid $pid)…"
      kill "$pid" 2>/dev/null || true
      ;;
    *)
      echo "Port $WEB_PORT is used by another program (pid $pid):"
      echo "  $cmd"
      echo "It is not this repo's web server, so it was left alone. Stop it, then retry."
      exit 1
      ;;
  esac
done
for _ in $(seq 1 50); do
  lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN > /dev/null 2>&1 || break
  sleep 0.1
done

# Children keep their colours although their output goes through a pipe.
export FORCE_COLOR=1

# Prefix every line of a stream with a coloured tag.
tag() {
  local name="$1" color="$2" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '\033[%sm%-8s\033[0m %s\n' "$color" "[$name]" "$line"
  done
}

if [[ "$MODE" == "prod" ]]; then
  # Build first, in the foreground, so a build error stops everything before any server starts.
  pnpm web:build 2>&1 | tag web "$WEB_COLOR" || {
    echo "Build failed; nothing was started."
    exit 1
  }
  WEB_CMD=(pnpm web:preview)
else
  WEB_CMD=(pnpm web:dev)
fi

# Each server runs in its own process group (job control on), so stopping it
# stops pnpm, node, wrangler and workerd under it, not just the top process. Each
# side is ONE background subshell, so `$!` is its pid and the id of that group.
# stdin is /dev/null: a background group that reads the terminal (wrangler's and
# vite's keyboard shortcuts) would be suspended by SIGTTIN and hang silently.
set -m
(pnpm web-auth:dev ${WORKER_ARGS[@]+"${WORKER_ARGS[@]}"} < /dev/null 2>&1 | tag worker "$WORKER_COLOR") &
WORKER_PGID=$!
("${WEB_CMD[@]}" < /dev/null 2>&1 | tag web "$WEB_COLOR") &
WEB_PGID=$!
set +m

stopping=0
cleanup() {
  [[ "$stopping" -eq 1 ]] && return
  stopping=1
  echo ""
  echo "Stopping the web app and the Worker…"
  kill -TERM -- "-$WEB_PGID" "-$WORKER_PGID" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$WEB_PGID" "-$WORKER_PGID" 2>/dev/null || true
}
trap 'cleanup; exit 130' INT TERM
trap cleanup EXIT

echo "Web app: http://localhost:$WEB_PORT  (mode: $MODE)   Worker: http://localhost:8787   Ctrl+C stops both."

# Poll instead of `wait -n` (bash 3.2): as soon as either side exits, stop the other.
while kill -0 "$WORKER_PGID" 2>/dev/null && kill -0 "$WEB_PGID" 2>/dev/null; do
  sleep 1
done
if ! kill -0 "$WORKER_PGID" 2>/dev/null; then
  echo "The Worker stopped, so the web app is stopped too."
else
  echo "The web app stopped, so the Worker is stopped too."
fi
exit 1
