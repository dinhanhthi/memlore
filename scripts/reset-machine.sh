#!/usr/bin/env bash
#
# scripts/reset-machine.sh — full reset to a brand-new install for testing.
#
# Wipes every local bit of Memlore state on this Mac so the next
# `pnpm tauri dev` lands on onboarding (password / recovery phrase /
# journals / sync all start from zero).
#
# NOTE: the vault is always encrypted — none-mode (no-password / plaintext
# SQLite + plaintext sync) was removed. Onboarding has exactly one path:
# set a password, then save the 24-word recovery phrase.
#
# USAGE:
#   ./scripts/reset-machine.sh            # prompts for confirmation
#   ./scripts/reset-machine.sh --force    # skips confirmation
#
# WHAT IT DOES (on macOS):
#   1. Removes ~/Library/Application Support/app.memlore/
#      (SQLite DB + boot sidecar + media/ + fonts/ + Drive refresh token)
#   2. Deletes the biometric encryption key from the macOS Keychain
#      (service "com.memlore.encryption-key" — Touch ID unlock; the bundle id
#      "app.memlore" is purged too, for older builds)
#   3. Clears the Tauri WebView data store (localStorage / IndexedDB) and
#      HTTP cache (~/Library/WebKit/memlore, ~/Library/Caches/memlore —
#      keyed by app name, not the app.memlore bundle id)
#   4. Stops any leftover Vite/dev process on port 5173
#   5. Prints manual steps to wipe Google Drive hidden app data
#      (scripts cannot call Google OAuth / Drive APIs — see below)
#
# WHAT IT CANNOT DO AUTOMATICALLY:
#   - Delete Google Drive `drive.appdata` for Memlore. That folder is
#     hidden from My Drive and needs either in-app "Wipe cloud" while
#     still connected, or Drive web UI "Disconnect from Drive".
#   - Disconnect other machines. If another Mac still has Drive connected,
#     it may re-upload after you wipe the cloud.
#
# WHEN TO USE:
#   - Testing the full product from a clean slate
#   - Reproducing first-launch / onboarding / sync pairing bugs
#   - Handing the machine to another tester
#
# AFTER RESET (dev):
#   pnpm tauri dev → onboard/unlock → Settings → Data → Import →
#   Seed demo data (debug builds only; not available in release)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/_ui.sh
source "${SCRIPT_DIR}/_ui.sh"

# Two different naming conventions live side by side on macOS, and mixing
# them up is why a "full reset" used to leave stale localStorage behind:
#   - Application Support + Keychain are keyed by the BUNDLE IDENTIFIER
#     (`app.memlore`, from tauri.conf.json `identifier`).
#   - The WKWebView data store (localStorage / IndexedDB) and the HTTP cache
#     are keyed by the app/binary NAME (`memlore`), NOT the identifier.
# Getting WEBKIT_DATA wrong meant the persisted Zustand store (interface
# language, theme, onboarding flag) survived the wipe, so `pnpm tauri dev`
# came back up in the previous language instead of the English default.
APP_ID="app.memlore"
WEBVIEW_NAME="memlore"
APP_DATA="${HOME}/Library/Application Support/${APP_ID}"
WEBKIT_DATA="${HOME}/Library/WebKit/${WEBVIEW_NAME}"
HTTP_CACHE="${HOME}/Library/Caches/${WEBVIEW_NAME}"
# Legacy identifier-keyed paths from older builds — wiped too if present so
# no tester is left with stale WebView state.
WEBKIT_DATA_LEGACY="${HOME}/Library/WebKit/${APP_ID}"
HTTP_CACHE_LEGACY="${HOME}/Library/Caches/${APP_ID}"
# Keychain services to purge. The app does NOT key its Keychain item by the
# bundle id: `src-tauri/src/commands/keychain.rs` writes under
# `com.memlore.encryption-key`. This script used to delete only "${APP_ID}",
# so a "full reset" silently left the biometric key behind and still printed
# "Deleted: 0 Keychain entry/entries" as if it had done its job. Both names are
# purged now — the real one, plus the bundle id in case an older build used it.
KEYCHAIN_SERVICES=("com.memlore.encryption-key" "${APP_ID}")

FORCE=false
for arg in "$@"; do
  [[ "$arg" == "--force" ]] && FORCE=true
done

# ─── Platform guard ───────────────────────────────────────────────────────────

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script currently supports macOS only."
  echo "On Linux/Windows the paths and Keychain command differ — extend as needed."
  exit 1
fi

# ─── Cloud wipe guidance (always printed; not automatic) ──────────────────────

print_cloud_wipe_guide() {
  echo ""
  ui_red_bold "════════════════════════════════════════════════════════════════"
  ui_red_bold "  Google Drive is NOT wiped by this script"
  ui_red_bold "════════════════════════════════════════════════════════════════"
  echo ""
  echo "Hidden appdata (drive.appdata) is invisible in My Drive."
  echo "For a true brand-new test (no connection, no cloud vault):"
  echo ""
  echo "  A) Preferred — while the app is still connected (BEFORE this wipe):"
  echo "     Settings → Sync / Google Drive → Wipe cloud (and disconnect)."
  echo ""
  echo "  B) Manual — any time, from the browser:"
  echo "     1. Open https://drive.google.com"
  echo "     2. Settings (gear) → Manage apps → Memlore"
  echo "     3. Options → Disconnect from Drive"
  echo "        (or Delete hidden app data if shown)"
  echo "     4. Disconnect Drive on EVERY other machine first, or they"
  echo "        may re-upload the moment they see an empty cloud."
  echo ""
  echo "  C) iCloud (only if you used it): remove the Memlore sync folder"
  echo "     from iCloud Drive on this Mac and any other devices."
  echo ""
  ui_red_bold "════════════════════════════════════════════════════════════════"
  echo ""
}

# ─── Preflight ────────────────────────────────────────────────────────────────

targets=()
[[ -d "$APP_DATA"          ]] && targets+=("$APP_DATA")
[[ -d "$WEBKIT_DATA"       ]] && targets+=("$WEBKIT_DATA")
[[ -d "$HTTP_CACHE"        ]] && targets+=("$HTTP_CACHE")
[[ -d "$WEBKIT_DATA_LEGACY" ]] && targets+=("$WEBKIT_DATA_LEGACY")
[[ -d "$HTTP_CACHE_LEGACY"  ]] && targets+=("$HTTP_CACHE_LEGACY")

keychain_present=false
for svc in "${KEYCHAIN_SERVICES[@]}"; do
  if security find-generic-password -s "$svc" >/dev/null 2>&1; then
    keychain_present=true
    break
  fi
done

print_cloud_wipe_guide

if [[ ${#targets[@]} -eq 0 && "$keychain_present" == false ]]; then
  echo "Nothing to reset locally — no app data, caches, or Keychain entries found."
  echo "If Drive still has old vault data, finish step B above, then run:"
  echo "  pnpm tauri dev"
  echo "After unlock (dev), optional demo data:"
  echo "  Settings → Data → Import → Seed demo data"
  exit 0
fi

# ─── Confirm ──────────────────────────────────────────────────────────────────

echo "Memlore — full reset (brand-new install)"
echo ""
echo "This will permanently delete LOCAL data:"
for t in "${targets[@]}"; do echo "  $t"; done
if [[ "$keychain_present" == true ]]; then
  echo "  Keychain entries for: ${KEYCHAIN_SERVICES[*]} (biometric unlock key)"
fi
echo ""
stop_memlore_dev_server
echo ""

if [[ "$FORCE" == true ]]; then
  ui_red_bold "--force: skipping confirmation."
  ui_red "         Proceeding with full local wipe immediately."
  echo ""
else
  ui_red_bold "WARNING: This permanently deletes ALL local Memlore data on this Mac."
  ui_red "         This cannot be undone."
  ui_red "         Pass --force to skip this confirmation."
  echo ""
  read -r -p "Have you wiped (or will wipe) Google Drive appdata? [y/N] " cloud_ok
  if [[ "$cloud_ok" != "y" && "$cloud_ok" != "Y" ]]; then
    echo ""
    echo "Aborted. Wipe Drive first (step A or B above), then re-run this script."
    exit 0
  fi
  echo ""
  read -r -p "Proceed with LOCAL wipe? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ─── Wipe directories ─────────────────────────────────────────────────────────

for t in "${targets[@]}"; do
  rm -rf "$t"
  echo "Deleted: $t"
done

# ─── Wipe Keychain entries ────────────────────────────────────────────────────
#
# A single service may have multiple accounts (e.g. one per device_id or
# entry). `security delete-generic-password` deletes one entry per call and
# returns non-zero when none remain — loop until that happens.

if [[ "$keychain_present" == true ]]; then
  for svc in "${KEYCHAIN_SERVICES[@]}"; do
    count=0
    while security delete-generic-password -s "$svc" >/dev/null 2>&1; do
      ((count++))
      # Safety stop in case something pathological keeps recreating entries.
      if [[ $count -ge 100 ]]; then
        echo "Stopped after deleting 100 Keychain entries — investigate manually."
        break
      fi
    done
    echo "Deleted: $count Keychain entry/entries under service '$svc'"
  done
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
ui_red_bold "Local reset complete."
echo ""
echo "Next steps:"
echo "  1. Finish Google Drive wipe if you have not already (step B above)."
echo "  2. Run:  pnpm tauri dev"
echo "  3. Complete onboarding from scratch:"
echo "       - set a password (dev: 12345678) — the vault is ALWAYS encrypted;"
echo "         there is no no-password / plaintext mode"
echo "       - new 24-word recovery phrase (shown once, confirm it)"
echo "       - no Drive connection until you explicitly Connect"
echo "  4. Optional — seed demo data (debug builds only, after unlock):"
echo "       Settings → Data → Import → Seed demo data"
echo "       Adds ~3 [Demo] journals + mixed EN/VI entries, tags, media."
echo "       Additive on re-run. If Drive is connected, uploads may queue."
echo ""
echo "You should land on onboarding like a brand-new user."
