#!/usr/bin/env bash
#
# scripts/build-basemap.sh — extract a world-z8 Protomaps PMTiles file from
# the newest available daily planet (https://build.protomaps.com/YYYYMMDD.pmtiles).
#
# The extract is hundreds of MB. It must never be committed. Host it on
# Cloudflare R2 (default) and/or a GitHub Release on dinhanhthi/xjournal-basemap,
# then pin url + sha256 + size_bytes in
# docs/context/2026-08-24-commercial-license-remediation.json → basemap_asset.
#
# USAGE
#   ./scripts/build-basemap.sh                 # write $REPO_ROOT/tmp/world-z8.pmtiles
#   ./scripts/build-basemap.sh --cwd DIR       # write DIR/world-z8.pmtiles
#   ./scripts/build-basemap.sh --out-dir DIR   # same as --cwd
#
# TRADE-OFFS
#   - Extracts remotely via HTTP range requests (no full-planet download).
#   - maxzoom=8 is the shipping default. If the file exceeds 2 GiB, the
#     script rebuilds once at maxzoom=7 (pre-agreed fallback).
#   - Does not upload. Print size + sha256, then upload by hand.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TWO_GIB=$((2 * 1024 * 1024 * 1024))
PLANET_LOOKBACK_DAYS=90
OUT_DIR="${REPO_ROOT}/tmp"
ZOOM=8

usage() {
  cat <<EOF
Usage: $0 [--cwd DIR | --out-dir DIR]

Extract world-z${ZOOM}.pmtiles from the newest available Protomaps daily planet.
Writes into DIR (default: ${REPO_ROOT}/tmp). Do not git-add the output.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd|--out-dir)
      OUT_DIR="${2:?$1 requires a directory}"
      shift 2
      ;;
    --cwd=*|--out-dir=*)
      OUT_DIR="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ─── pmtiles CLI ──────────────────────────────────────────────────────────────

ensure_pmtiles() {
  if command -v pmtiles >/dev/null 2>&1; then
    return 0
  fi

  if command -v brew >/dev/null 2>&1; then
    echo "pmtiles not on PATH — installing via Homebrew…"
    brew install pmtiles
    if command -v pmtiles >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v go >/dev/null 2>&1; then
    echo "pmtiles not on PATH — installing via go install…"
    go install github.com/protomaps/go-pmtiles/cmd/pmtiles@latest
    gobin="$(go env GOBIN)"
    if [[ -z "$gobin" ]]; then
      gobin="$(go env GOPATH)/bin"
    fi
    export PATH="${gobin}:${PATH}"
    if command -v pmtiles >/dev/null 2>&1; then
      return 0
    fi
  fi

  echo "Could not find or install the pmtiles CLI." >&2
  echo "Install one of: Homebrew (brew install pmtiles) or Go, then re-run." >&2
  exit 1
}

# ─── Newest available daily planet (HEAD, no hardcoded date) ──────────────────

ymd_days_ago() {
  local days="$1"
  if [[ "$(uname)" == "Darwin" ]]; then
    date -v-"${days}"d +%Y%m%d
  else
    date -d "-${days} days" +%Y%m%d
  fi
}

http_head_code() {
  # Follow redirects; treat curl failures as 000 so the walk can continue.
  curl -sI -L -o /dev/null -w "%{http_code}" --max-time 20 "$1" || echo "000"
}

resolve_planet_url() {
  local i=0
  local ymd url code
  while (( i < PLANET_LOOKBACK_DAYS )); do
    ymd="$(ymd_days_ago "$i")"
    url="https://build.protomaps.com/${ymd}.pmtiles"
    echo "Checking ${url}…" >&2
    code="$(http_head_code "$url")"
    if [[ "$code" == "200" ]]; then
      echo "Using planet: ${url}" >&2
      printf '%s' "$url"
      return 0
    fi
    echo "  HTTP ${code} — trying previous day" >&2
    i=$((i + 1))
  done
  echo "No daily planet returned HTTP 200 in the last ${PLANET_LOOKBACK_DAYS} days." >&2
  exit 1
}

# ─── File helpers ─────────────────────────────────────────────────────────────

file_size_bytes() {
  if [[ "$(uname)" == "Darwin" ]]; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

print_checksum() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  else
    sha256sum "$1"
  fi
}

# ─── Extract ──────────────────────────────────────────────────────────────────

ensure_pmtiles
echo "pmtiles: $(command -v pmtiles)"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

PLANET_URL="$(resolve_planet_url)"
echo ""

extract_at_zoom() {
  local zoom="$1"
  local dest="$2"
  rm -f "$dest"
  echo "Extracting ${dest} from ${PLANET_URL} (--maxzoom=${zoom})…"
  (cd "$OUT_DIR" && pmtiles extract "$PLANET_URL" "$(basename "$dest")" --maxzoom="$zoom")
}

OUT_FILE="${OUT_DIR}/world-z${ZOOM}.pmtiles"
extract_at_zoom "$ZOOM" "$OUT_FILE"

SIZE="$(file_size_bytes "$OUT_FILE")"
echo "Extract size: ${SIZE} bytes"

if (( SIZE > TWO_GIB )); then
  echo "Extract exceeds 2 GiB (${TWO_GIB}). Rebuilding at --maxzoom=7…"
  rm -f "$OUT_FILE"
  ZOOM=7
  OUT_FILE="${OUT_DIR}/world-z${ZOOM}.pmtiles"
  extract_at_zoom "$ZOOM" "$OUT_FILE"
  SIZE="$(file_size_bytes "$OUT_FILE")"
  echo "Extract size: ${SIZE} bytes"
fi

echo ""
echo "Output:     ${OUT_FILE}"
echo "maxzoom:    ${ZOOM}"
echo "size_bytes: ${SIZE}"
echo "sha256:"
print_checksum "$OUT_FILE"
echo "source_planet: ${PLANET_URL}"
echo ""
echo "Do not git add the .pmtiles file."
echo "Upload to R2 (default) and/or: gh release on dinhanhthi/xjournal-basemap"
echo "  R2 default:  https://pub-46e3eeff51414e7a954e0809a6e5edba.r2.dev/$(basename "$OUT_FILE")"
echo "  gh release:  https://github.com/dinhanhthi/xjournal-basemap/releases"
