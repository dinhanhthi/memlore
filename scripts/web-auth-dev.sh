#!/usr/bin/env bash
# web-auth-dev.sh — run the web companion's OAuth Worker locally (`pnpm web-auth:dev`).
#
# Stops every earlier local run of this Worker first, so a leftover from another
# terminal or session never blocks port 8787 ("Address already in use"). Only this
# repo's wrangler/workerd processes are stopped: if something else holds the port,
# the script refuses and names it instead of killing it.
#
# Extra args go to `wrangler dev`, e.g. `pnpm web-auth:dev --var WEB_WRITES_ENABLED:1`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="workers/web-auth/wrangler.toml"
PORT=8787

cd "$REPO_ROOT"

ours() {
  case "$1" in
    *"$REPO_ROOT/node_modules/"*wrangler* | *"$REPO_ROOT/node_modules/"*workerd*) return 0 ;;
    *) return 1 ;;
  esac
}

# Earlier `wrangler dev` runs of this Worker, whatever port or flags they used.
PIDS=""
for pid in $(pgrep -f "wrangler.* dev .*--config $CONFIG" || true); do
  ours "$(ps -o command= -p "$pid" || true)" && PIDS="$PIDS $pid"
done

# Whatever still listens on the port (a workerd can outlive its wrangler parent).
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  cmd="$(ps -o command= -p "$pid" || true)"
  if ours "$cmd"; then
    PIDS="$PIDS $pid"
  else
    echo "Port $PORT is used by another program (pid $pid):"
    echo "  $cmd"
    echo "It is not this repo's Worker, so it was left alone. Stop it, then retry."
    exit 1
  fi
done

if [[ -n "${PIDS// /}" ]]; then
  echo "Stopping the previous local OAuth Worker (pids:$PIDS)…"
  # shellcheck disable=SC2086 # word splitting is the point: one pid per word
  kill $PIDS 2>/dev/null || true
  for _ in $(seq 1 50); do
    lsof -tiTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1 || break
    sleep 0.1
  done
  # Still holding the port after 5 s: force it (ours only, checked above).
  for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    ours "$(ps -o command= -p "$pid" || true)" && kill -9 "$pid" 2>/dev/null || true
  done
fi

exec "$REPO_ROOT/node_modules/.bin/wrangler" dev --config "$CONFIG" --env dev --port "$PORT" "$@"
