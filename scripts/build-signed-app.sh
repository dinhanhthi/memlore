#!/usr/bin/env bash
#
# scripts/build-signed-app.sh — build a .app bundle signed well enough that
# biometric (Touch ID) unlock actually works, for manual QA.
#
# WHY A BUNDLE, NOT A BARE BINARY
#   `commands/keychain.rs` stores the os_kek under a SecAccessControl with
#   BIOMETRY_CURRENT_SET. macOS rejects that with errSecMissingEntitlement
#   ("A required entitlement isn't present") unless the binary declares
#   `keychain-access-groups`. But that entitlement is provisioning-profile
#   restricted: declare it without an embedded profile and the kernel SIGKILLs
#   the process at launch (exit 137, no output).
#
#   A provisioning profile can only be embedded in a .app bundle
#   (Contents/embedded.provisionprofile) — never in a bare Mach-O. That is why
#   `pnpm tauri dev` can never test Touch ID, and why signing the raw
#   target/debug binary is a dead end. Four experiments confirmed this:
#     ad-hoc                              -> errSecMissingEntitlement
#     Apple Development, no entitlement   -> errSecMissingEntitlement
#     Apple Development + entitlement     -> SIGKILL at launch
#     Developer ID + entitlement          -> SIGKILL at launch
#
# USAGE
#   ./scripts/build-signed-app.sh          # build, sign, and open
#   ./scripts/build-signed-app.sh --no-open
#   MEMLORE_TEAM_ID=XXXXXXXXXX ./scripts/build-signed-app.sh
#
# TRADE-OFFS
#   - No Vite hot reload: the bundle ships its own built frontend. Use
#     `pnpm tauri dev` for normal development; use this only for Touch ID QA.
#   - Same app data dir as the dev build (app.memlore), so it reuses the
#     existing vault — no re-onboarding.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP="${REPO_ROOT}/src-tauri/target/debug/bundle/macos/Memlore.app"
ENTITLEMENTS_TEMPLATE="${REPO_ROOT}/src-tauri/Entitlements.plist"
BUNDLE_ID="app.memlore"

DO_OPEN=true
for arg in "$@"; do
  [[ "$arg" == "--no-open" ]] && DO_OPEN=false
done

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only — biometric unlock is macOS-only this round."
  exit 1
fi

# ─── Signing identity ─────────────────────────────────────────────────────────
#
# No `... | head -1` pipelines: under `set -euo pipefail`, head closing the pipe
# early kills the upstream command with SIGPIPE, which pipefail turns into a
# silent script exit. awk consumes all input instead.

ALL_IDENTITIES="$(security find-identity -v -p codesigning || true)"
IDENTITY="$(awk -F'"' '/Apple Development/ {print $2; exit}' <<<"$ALL_IDENTITIES")"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(awk -F'"' '/Developer ID Application/ {print $2; exit}' <<<"$ALL_IDENTITIES")"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "No code-signing identity found — biometric unlock cannot be tested."
  exit 1
fi

TEAM_ID="${MEMLORE_TEAM_ID:-}"
if [[ -z "$TEAM_ID" ]] && command -v openssl >/dev/null 2>&1; then
  CERT_NAME="${IDENTITY%% (*}"
  CERT_SUBJECT="$(security find-certificate -c "$CERT_NAME" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null || true)"
  TEAM_ID="$(awk -F'OU=' 'NF>1 {split($2, a, /[,\/]/); gsub(/[^A-Z0-9]/, "", a[1]); print a[1]; exit}' <<<"$CERT_SUBJECT")"
fi
if [[ -z "$TEAM_ID" ]]; then
  # The list prefix ("  1) ") contains a ')', so match the 10-char code directly
  # rather than splitting on parentheses.
  TEAM_ID="$(sed -nE 's/.*Developer ID Application:.*\(([A-Z0-9]{10})\).*/\1/p' <<<"$ALL_IDENTITIES" | awk 'NR==1')"
fi

# Validate the shape, not just non-emptiness. A malformed Team ID once got past
# an `-z` check, signed the app with a nonsense access group, and macOS killed
# it at launch with no usable diagnostic.
if [[ ! "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "Team ID is missing or malformed: '${TEAM_ID}'"
  echo "Expected exactly 10 uppercase letters/digits. Override explicitly:"
  echo "  MEMLORE_TEAM_ID=XXXXXXXXXX $0"
  exit 1
fi

echo "Identity: $IDENTITY"
echo "Team ID:  $TEAM_ID"

# ─── Provisioning profile ─────────────────────────────────────────────────────
#
# Any profile whose application-identifier covers <TEAM>.<BUNDLE_ID> works,
# including a team wildcard (<TEAM>.*).

PROFILE_DIR="${HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles"
PROFILE=""
if [[ -d "$PROFILE_DIR" ]]; then
  for f in "$PROFILE_DIR"/*.provisionprofile; do
    [[ -e "$f" ]] || continue
    app_id="$(security cms -D -i "$f" 2>/dev/null \
      | grep -A1 'application-identifier' \
      | sed -nE 's@.*<string>(.*)</string>.*@\1@p' || true)"
    [[ -z "$app_id" ]] && continue
    if [[ "$app_id" == "${TEAM_ID}.${BUNDLE_ID}" || "$app_id" == "${TEAM_ID}.*" ]]; then
      PROFILE="$f"
      echo "Profile:  $(basename "$f")  ($app_id)"
      break
    fi
  done
fi

if [[ -z "$PROFILE" ]]; then
  echo ""
  echo "No provisioning profile covering ${TEAM_ID}.${BUNDLE_ID} was found in:"
  echo "  $PROFILE_DIR"
  echo ""
  echo "Without one, macOS kills the app at launch as soon as it declares the"
  echo "keychain-access-groups entitlement. Create a Mac development profile"
  echo "for ${TEAM_ID}.${BUNDLE_ID} (or a ${TEAM_ID}.* wildcard) in Xcode or at"
  echo "developer.apple.com, then re-run."
  exit 1
fi

# ─── Build ────────────────────────────────────────────────────────────────────

echo "Building the app bundle (this takes a few minutes)…"
(cd "$REPO_ROOT" && pnpm tauri build --debug --bundles app)

if [[ ! -d "$APP" ]]; then
  echo "Expected bundle not found at: $APP"
  exit 1
fi

# ─── Embed profile + sign ─────────────────────────────────────────────────────

cp "$PROFILE" "${APP}/Contents/embedded.provisionprofile"

RESOLVED="$(mktemp -t memlore-entitlements).plist"
trap 'rm -f "$RESOLVED"' EXIT
# $(AppIdentifierPrefix) is expanded by Xcode, not codesign — resolve it here.
sed "s/\$(AppIdentifierPrefix)/${TEAM_ID}./" "$ENTITLEMENTS_TEMPLATE" > "$RESOLVED"

codesign --force --deep --sign "$IDENTITY" \
  --entitlements "$RESOLVED" \
  --options runtime \
  "$APP"

codesign --verify --verbose=1 "$APP"
echo "Entitlements on the signed bundle:"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -A1 keychain-access-groups || true

# ─── Launch ───────────────────────────────────────────────────────────────────
#
# `open` launches it in the GUI session. Running Contents/MacOS/Memlore
# straight from a terminal starts the process but it exits without a proper
# session, which looks like a crash and is not one.

if [[ "$DO_OPEN" == true ]]; then
  echo ""
  echo "Opening ${APP}…"
  open "$APP"
else
  echo ""
  echo "Built and signed. Launch with:  open \"$APP\""
fi
