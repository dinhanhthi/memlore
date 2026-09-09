//! Google Drive sync commands.
//!
//! ## Connect flow (two-phase)
//!
//! Connecting Google Drive is split into two commands so the frontend can
//! open the browser between them:
//!
//! 1. **`gdrive_begin_connect`** — generate PKCE, start loopback server,
//!    return `{ auth_url, session_id }`. The frontend opens `auth_url` in
//!    the user's browser (via `tauri-plugin-opener`). Google redirects to
//!    the loopback server; this command returns immediately without awaiting
//!    the redirect.
//!
//! 2. **`gdrive_complete_connect(session_id, password)`** — awaits the
//!    loopback callback, verifies the password, exchanges the code for
//!    tokens, persists the refresh token, reconciles the keyring with Drive,
//!    creates the Drive folder structure, and returns `GDriveStatus`.
//!
//! `gdrive_connect` remains for tests and legacy callers — it runs both
//! phases back-to-back but requires the frontend to open the URL via an
//! out-of-band mechanism.
//!
//! ## Always encrypted
//!
//! Every vault is password-encrypted; sync envelopes are always AES-GCM
//! (Phase 4's versioned envelope). There is no plaintext sync mode.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::db;
use crate::sync::gdrive_oauth::{
    build_authorization_url, exchange_code, generate_pkce, revoke_token, AuthCallback,
    GoogleOAuthConfig, PkceVerifier,
};
use crate::sync::gdrive_provider::{GDriveProvider, GDriveSession};
use crate::sync::CloudProvider;
use crate::{AppState, EncryptionKeyState, GDriveSessionState};

/// Error code formerly returned when Drive connect was blocked in non-password
/// mode. Kept for API compatibility; no longer emitted by connect commands
/// (Drive is mode-agnostic since Phase 5).
pub const PASSWORD_REQUIRED_FOR_SYNC: &str = "PASSWORD_REQUIRED_FOR_SYNC";

/// Error code when the refresh token has been revoked and the user must
/// reconnect.
pub const AUTH_REVOKED: &str = "AUTH_REVOKED";

/// Error code for transient network issues.
pub const NETWORK_ERROR: &str = "NETWORK_ERROR";

/// Cached Drive storage usage in bytes. Refreshed on connect and via
/// `gdrive_refresh_storage_quota`. Persisted so `gdrive_get_status` can
/// return a stable value across app restarts without an extra API call.
pub(crate) const GDRIVE_STORAGE_USED_KEY: &str = "gdrive_storage_used";
pub(crate) const GDRIVE_STORAGE_TOTAL_KEY: &str = "gdrive_storage_total";
/// Cached sum of bytes this app owns in Drive `appDataFolder` (Memlore-only).
pub(crate) const GDRIVE_STORAGE_APP_USED_KEY: &str = "gdrive_storage_app_used";

// ─── Response types ──────────────────────────────────────────────────────────

/// Payload for the `xj://force-re-pair` event. The frontend `useForceRePair`
/// listener reads `event.payload.reason`.
#[derive(Debug, Clone, Serialize)]
struct ForceRePairPayload {
    reason: String,
}

/// Status snapshot returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GDriveStatus {
    pub connected: bool,
    pub email: Option<String>,
    /// Account-wide Drive usage (all Google services that share the quota).
    pub storage_used: Option<u64>,
    pub storage_total: Option<u64>,
    /// Bytes occupied by this app in Drive `appDataFolder` (Memlore only).
    pub storage_app_used: Option<u64>,
    pub last_sync: Option<i64>,
    /// Persisted `sync_provider`: `"gdrive"` | `"icloud"` | `"local"`.
    pub provider: Option<String>,
    /// Folder-provider root from `sync_config_json`. `None` for Drive.
    pub root_path: Option<String>,
}

/// Tauri event emitted during `gdrive_complete_connect` to surface which
/// post-callback phase is currently running, so the frontend can show a live
/// hint under the "Connecting…" button. Only fires AFTER the OAuth callback
/// resolves — before that the user is still in the browser.
///
/// Payload is [`GdriveConnectProgress`]: a stable machine `phase` key (never
/// English prose) plus the originating `session_id`. The frontend maps the key
/// to a localized label and filters on its own pending session id. Keep the
/// phase key set in sync with the `t('onboarding.drive.progress.*')` i18n keys.
pub const GDRIVE_CONNECT_PROGRESS_EVENT: &str = "gdrive:connect-progress";

/// Payload for [`GDRIVE_CONNECT_PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GdriveConnectProgress {
    /// Session id from `gdrive_begin_connect`; frontend filters stale events on it.
    pub session_id: String,
    /// Stable machine key: `exchanging_token` | `establishing_root` | `finalizing`.
    pub phase: String,
}

/// Best-effort emit of a [`GDRIVE_CONNECT_PROGRESS_EVENT`]. Send failures are
/// ignored — a missing progress hint must never fail the connect itself.
fn emit_connect_progress<R: Runtime>(app: &AppHandle<R>, session_id: &str, phase: &str) {
    let _ = app.emit(
        GDRIVE_CONNECT_PROGRESS_EVENT,
        GdriveConnectProgress {
            session_id: session_id.to_string(),
            phase: phase.to_string(),
        },
    );
}

/// Typed outcome of `gdrive_complete_connect`.
///
/// The `Err` path is reserved for true failures (network, auth, etc.).
/// Routing outcomes that require specific frontend screens are returned as
/// `Ok(variant)` so the frontend can handle them with a type-safe match.
///
/// Frontend re-fetches `gdriveGetStatus()` after a `Ready` outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum GdriveConnectOutcome {
    /// OAuth + keyring reconcile succeeded. Frontend re-fetches status.
    Ready,
    /// Cloud has no V2 keyring yet — this device must run first-time setup
    /// (password mode only, cloud keyring absent).
    NeedsFirstTimeSetup,
    /// Cloud has a V2 vault, local mode is Unset — must run onboarding.
    NeedsOnboarding,
    /// Cloud vault epoch/fingerprint differs from local — force re-pair.
    /// Phase 5 will wire this to a ForceRePairScreen.
    NeedsForceRePair { reason: String, cloud_epoch: u64 },
    /// V1 keyring was present and wiped — must reconnect.
    V1WipedReconnectRequired,
}

/// Output of `gdrive_begin_connect` — frontend opens `auth_url` then calls
/// `gdrive_complete_connect(session_id)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginConnectResponse {
    pub auth_url: String,
    pub session_id: String,
}

// ─── Pending session state (in-memory, between begin + complete) ─────────────

/// Holds PKCE + callback receivers for pending OAuth sessions. Keyed by a
/// short-lived random `session_id` that the frontend passes back to
/// `gdrive_complete_connect`.
pub struct PendingOAuthState {
    inner: Mutex<HashMap<String, PendingOAuth>>,
    /// Separate map of cancel notifiers — survives `take()` of the main
    /// entry, so `gdrive_cancel_connect` can still signal cancellation
    /// after `gdrive_complete_connect` has consumed the `PendingOAuth`
    /// entry (which it does immediately, then awaits the loopback
    /// callback for up to 5 min).
    cancel_notifiers: Mutex<HashMap<String, Arc<Notify>>>,
}

pub struct PendingOAuth {
    pub verifier: PkceVerifier,
    pub redirect_uri: String,
    pub client_id: String,
    pub client_secret: String,
    pub state_param: String,
    /// Receiver resolved when the loopback server receives the callback.
    pub callback_rx: tokio::sync::oneshot::Receiver<Result<AuthCallback, String>>,
    /// Shared cancellation signal. Cloned into `cancel_notifiers` map at
    /// insert time. `gdrive_cancel_connect` calls `notify_one()` to wake
    /// any in-flight `gdrive_complete_connect` that is awaiting the
    /// callback.
    pub cancel_notify: Arc<Notify>,
}

impl PendingOAuthState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            cancel_notifiers: Mutex::new(HashMap::new()),
        }
    }

    fn insert(&self, id: String, pending: PendingOAuth) {
        let notify = pending.cancel_notify.clone();
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.insert(id.clone(), pending);
        drop(guard);
        let mut notifiers = self
            .cancel_notifiers
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        notifiers.insert(id, notify);
    }

    fn take(&self, id: &str) -> Option<PendingOAuth> {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.remove(id)
    }

    /// Look up the cancel notifier for an in-flight session WITHOUT
    /// removing it from either map. Currently only used by tests —
    /// production `gdrive_complete_connect` clones the notifier from
    /// the `PendingOAuth` entry it already consumed via `take()`.
    #[cfg(test)]
    fn cancel_notify(&self, id: &str) -> Option<Arc<Notify>> {
        let guard = self
            .cancel_notifiers
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.get(id).cloned()
    }

    /// Remove the cancel notifier for a session — called by
    /// `gdrive_complete_connect` once it has succeeded, failed, or been
    /// cancelled, so the map does not leak entries across reconnect
    /// attempts.
    fn remove_cancel_notify(&self, id: &str) {
        let mut guard = self
            .cancel_notifiers
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.remove(id);
    }

    /// Fire the cancel signal for `id` and remove both map entries.
    /// Returns `true` when a cancel notifier was present (cancellation
    /// was actually delivered to an in-flight `gdrive_complete_connect`
    /// or removed before it consumed the entry); `false` when the
    /// session was already cleaned up.
    fn cancel(&self, id: &str) -> bool {
        let notify = {
            let mut guard = self
                .cancel_notifiers
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            guard.remove(id)
        };
        // Drop the main entry too, in case complete_connect hasn't taken
        // it yet (user clicked Cancel before the browser callback fired).
        let _ = self.take(id);
        if let Some(n) = notify {
            n.notify_one();
            true
        } else {
            false
        }
    }
}

impl Default for PendingOAuthState {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Helpers (sync, testable) ────────────────────────────────────────────────

/// Clear persisted gdrive session settings (refresh token, folder id, email)
/// and the `sync_connected` flag. Does NOT clear `gdrive_client_id` or
/// `gdrive_client_secret` — those are app-level OAuth credentials that
/// survive a disconnect so the user can reconnect without re-running the
/// dev setup script.
pub(crate) fn clear_gdrive_settings(conn: &rusqlite::Connection) -> Result<(), String> {
    let keys = [
        "gdrive_refresh_token",
        "gdrive_root_folder_id",
        "gdrive_email",
        "sync_connected",
        "sync_provider",
        "sync_config_json",
        GDRIVE_STORAGE_USED_KEY,
        GDRIVE_STORAGE_TOTAL_KEY,
        GDRIVE_STORAGE_APP_USED_KEY,
    ];
    for key in &keys {
        db::delete_setting(conn, key).map_err(|e| e.to_string())?;
    }
    // Flip the scheduler off — there is no provider left to sync against.
    // Mirrors the invariant enforced by `db::clear_sync_provider`.
    db::set_sync_enabled(conn, false).map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist the cached Drive storage quota (account-wide + app-only) in
/// settings rows. `None` values are written as `delete_setting` calls so a
/// previously-cached value never leaks past a fetch failure that returned no
/// quota.
pub(crate) fn persist_storage_quota(
    conn: &rusqlite::Connection,
    used: Option<u64>,
    total: Option<u64>,
    app_used: Option<u64>,
) -> Result<(), String> {
    // `unchecked_transaction` rather than `transaction`: this function may be
    // called from inside an outer transaction (e.g. `gdrive_complete_connect`
    // atomically writes token + quota). `transaction()` would fail with
    // "cannot start a transaction within a transaction". `unchecked_transaction`
    // creates a savepoint when nested, which commits or rolls back with the
    // outer transaction.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    match used {
        Some(v) => db::set_setting(&tx, GDRIVE_STORAGE_USED_KEY, &v.to_string())
            .map_err(|e| e.to_string())?,
        None => db::delete_setting(&tx, GDRIVE_STORAGE_USED_KEY).map_err(|e| e.to_string())?,
    }
    match total {
        Some(v) => db::set_setting(&tx, GDRIVE_STORAGE_TOTAL_KEY, &v.to_string())
            .map_err(|e| e.to_string())?,
        None => db::delete_setting(&tx, GDRIVE_STORAGE_TOTAL_KEY).map_err(|e| e.to_string())?,
    }
    match app_used {
        Some(v) => db::set_setting(&tx, GDRIVE_STORAGE_APP_USED_KEY, &v.to_string())
            .map_err(|e| e.to_string())?,
        None => db::delete_setting(&tx, GDRIVE_STORAGE_APP_USED_KEY).map_err(|e| e.to_string())?,
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Read cached Drive storage values back. Any field may be `None` when the
/// cache has never been populated or a stored value is non-numeric (treated
/// as missing rather than an error — the field is a display nicety, not
/// load-bearing).
pub(crate) fn read_cached_storage_quota(
    conn: &rusqlite::Connection,
) -> Result<(Option<u64>, Option<u64>, Option<u64>), String> {
    let used = db::get_setting(conn, GDRIVE_STORAGE_USED_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse::<u64>().ok());
    let total = db::get_setting(conn, GDRIVE_STORAGE_TOTAL_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse::<u64>().ok());
    let app_used = db::get_setting(conn, GDRIVE_STORAGE_APP_USED_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse::<u64>().ok());
    Ok((used, total, app_used))
}

/// Build the status snapshot from a held connection. Pulled out of
/// `gdrive_get_status` so tests can exercise the read path without going
/// through the Tauri command machinery.
pub(crate) fn read_status_snapshot(conn: &rusqlite::Connection) -> Result<GDriveStatus, String> {
    let connected = db::get_setting(conn, "sync_connected")
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some("true");
    let provider = db::get_sync_provider(conn).map_err(|e| e.to_string())?;
    let root_path = folder_root_path_from_settings(conn, provider.as_deref())?;
    if !connected {
        return Ok(GDriveStatus {
            connected: false,
            email: None,
            storage_used: None,
            storage_total: None,
            storage_app_used: None,
            last_sync: None,
            provider,
            root_path,
        });
    }
    let email = db::get_setting(conn, "gdrive_email").map_err(|e| e.to_string())?;
    let last_sync = db::get_last_sync_at(conn).map_err(|e| e.to_string())?;
    let (storage_used, storage_total, storage_app_used) = read_cached_storage_quota(conn)?;
    Ok(GDriveStatus {
        connected: true,
        email,
        storage_used,
        storage_total,
        storage_app_used,
        last_sync,
        provider,
        root_path,
    })
}

/// `root_path` from `sync_config_json` for folder providers; `None` for Drive.
fn folder_root_path_from_settings(
    conn: &rusqlite::Connection,
    provider: Option<&str>,
) -> Result<Option<String>, String> {
    match provider {
        Some("local") | Some("icloud") => {
            let json = match db::get_sync_config_json(conn).map_err(|e| e.to_string())? {
                Some(j) if !j.is_empty() => j,
                _ => return Ok(None),
            };
            #[derive(Deserialize)]
            struct FolderCfg {
                root_path: String,
            }
            Ok(serde_json::from_str::<FolderCfg>(&json)
                .ok()
                .map(|c| c.root_path)
                .filter(|p| !p.is_empty()))
        }
        _ => Ok(None),
    }
}

/// Atomically persist the settings that mark a successful cloud connect.
///
/// - `GDrive`: encrypted refresh token, `sync_provider=gdrive`, connected
///   flag, and `sync_enabled`. The last one is what the UI reads to decide
///   whether to show "Sync off".
/// - `Folder`: `sync_provider=kind`, `sync_config_json={"root_path"}`
///   (Phase 2 `LocalConfig` shape), connected flag, and `sync_enabled`.
pub(crate) fn persist_connect_settings(
    conn: &rusqlite::Connection,
    pending: &crate::commands::pending_drive_session::PendingCloudSession,
) -> Result<(), String> {
    use crate::commands::pending_drive_session::PendingCloudSession;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    match pending {
        PendingCloudSession::GDrive { session, .. } => {
            db::set_setting(&tx, "gdrive_refresh_token", &*session.refresh_token)
                .map_err(|e| e.to_string())?;
            db::set_setting(&tx, "sync_provider", "gdrive").map_err(|e| e.to_string())?;
        }
        PendingCloudSession::Folder { kind, root_path } => {
            let json = serde_json::to_string(&serde_json::json!({ "root_path": root_path }))
                .map_err(|e| e.to_string())?;
            db::set_setting(&tx, "sync_provider", kind).map_err(|e| e.to_string())?;
            db::set_sync_config_json(&tx, &json).map_err(|e| e.to_string())?;
        }
    }
    db::set_setting(&tx, "sync_connected", "true").map_err(|e| e.to_string())?;
    db::set_sync_enabled(&tx, true).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve the effective client_id: settings override → compile-time env →
/// placeholder.
fn resolve_client_id(conn: &rusqlite::Connection) -> Result<String, String> {
    Ok(db::get_setting(conn, "gdrive_client_id")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| crate::sync::gdrive_oauth::compiled_client_id().to_string()))
}

/// Resolve the effective client_secret: settings override → compile-time env
/// → placeholder. Google's Desktop-app OAuth flow requires this for token
/// exchange; it is NOT a cryptographic secret — see
/// `gdrive_oauth::PLACEHOLDER_CLIENT_SECRET` docs.
fn resolve_client_secret(conn: &rusqlite::Connection) -> Result<String, String> {
    Ok(db::get_setting(conn, "gdrive_client_secret")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| crate::sync::gdrive_oauth::compiled_client_secret().to_string()))
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Begin the OAuth flow. Returns the authorization URL the frontend should
/// open in the user's browser, plus a session_id to pass to
/// `gdrive_complete_connect`.
#[tauri::command]
pub async fn gdrive_begin_connect(
    state: State<'_, AppState>,
    pending: State<'_, PendingOAuthState>,
) -> Result<BeginConnectResponse, String> {
    // No password-mode gate: Google Drive is mode-agnostic. Mode-specific
    // wire format (plaintext for none, AES-GCM for password) is handled
    // inside the sync engine via Phase 4's versioned envelope.
    let (client_id, client_secret) = {
        let conn = state.lock()?;
        (resolve_client_id(&conn)?, resolve_client_secret(&conn)?)
    };

    let config = GoogleOAuthConfig::default();
    let (verifier, challenge) = generate_pkce();

    // 128-bit CSRF state.
    let state_param: String = {
        let mut bytes = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
        hex::encode(bytes)
    };

    // Start loopback server in background and forward callback via oneshot.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<AuthCallback, String>>();
    let expected_state = state_param.clone();

    // Bind + get the port BEFORE spawning, so we can include it in the URL.
    let (listener, port) = crate::sync::gdrive_oauth::bind_loopback().await?;

    tokio::spawn(async move {
        let result = crate::sync::gdrive_oauth::await_callback(listener, &expected_state).await;
        let _ = tx.send(result);
    });

    let redirect_uri = format!("http://127.0.0.1:{port}");
    let auth_url =
        build_authorization_url(&client_id, &redirect_uri, &state_param, &challenge, &config)?
            .to_string();

    let session_id = Uuid::new_v4().to_string();

    pending.insert(
        session_id.clone(),
        PendingOAuth {
            verifier,
            redirect_uri,
            client_id,
            client_secret,
            state_param,
            callback_rx: rx,
            cancel_notify: Arc::new(Notify::new()),
        },
    );

    Ok(BeginConnectResponse {
        auth_url,
        session_id,
    })
}

/// Cancel an in-flight OAuth session whose user has not completed the
/// browser consent screen (e.g. they closed the tab manually).
///
/// Fires a shared `Notify` so a `gdrive_complete_connect` that has
/// already consumed the `PendingOAuth` entry (and is now awaiting the
/// loopback callback for up to 5 min) wakes up and returns an error
/// instead of blocking the frontend's Connecting… UI indefinitely.
///
/// The loopback listener spawned by `gdrive_begin_connect` is NOT
/// actively killed; it self-terminates when `await_callback` returns
/// (timeout or stray callback). The bound ephemeral port stays in use
/// until then; harmless because each `gdrive_begin_connect` allocates a
/// fresh port.
///
/// Returns `true` when the cancel signal was delivered (an in-flight
/// session existed), `false` when the session was already cleaned up
/// (success, error, or repeated cancel).
#[tauri::command]
pub fn gdrive_cancel_connect(
    session_id: String,
    pending: State<'_, PendingOAuthState>,
) -> Result<bool, String> {
    Ok(pending.cancel(&session_id))
}

/// Complete the OAuth flow: await the loopback callback, exchange the code,
/// persist the refresh token, ensure the Drive folder structure, and return
/// Typed outcome of the Drive connect flow returned to the frontend.
///
/// Decide whether `gdrive_complete_connect` must verify the typed password.
///
/// The password is only an *ownership* proof here — it feeds
/// `verify_password_hash` and nothing else; the master key used for all Drive
/// I/O comes from the already-unlocked `key_state`. So the check is redundant
/// exactly when the vault is already unlocked AND the caller supplied no
/// password: the in-memory master is itself proof of ownership. Every other
/// case still verifies:
///   - Unset mode never had a password to check (welcome-screen adopt path).
///   - A non-empty password (Settings' explicit re-auth) is always verified.
///   - A locked vault (`!unlocked`) with an empty password falls through to the
///     check, which then fails as it should.
pub(crate) fn password_check_required(
    mode: &db::EncryptionMode,
    password_empty: bool,
    unlocked: bool,
) -> bool {
    *mode == db::EncryptionMode::Password && !(password_empty && unlocked)
}

/// `password` is verified against the stored hash before any Drive I/O, unless
/// the vault is already unlocked and no password was supplied (see
/// `password_check_required`). The vault is always encrypted, so the keyring
/// reconcile step always runs.
#[tauri::command]
pub async fn gdrive_complete_connect(
    app: AppHandle,
    session_id: String,
    password: String,
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    session_state: State<'_, GDriveSessionState>,
    pending: State<'_, PendingOAuthState>,
) -> Result<GdriveConnectOutcome, String> {
    use tauri::Manager;
    // Zeroize password on drop so the plaintext doesn't linger in heap memory
    // across the full async flow (token exchange, Drive I/O, etc.).
    let password = zeroize::Zeroizing::new(password);
    // Resolve boot file path so swap_local_key can PRAGMA rekey + update boot file.
    let _boot_path = app
        .path()
        .app_data_dir()
        .map(|d| crate::utils::boot_file::boot_path(&d.join("memlore.db")))
        .ok();

    // Consume the pending session FIRST — any early return below must not leak
    // the PendingOAuth entry (and its live oneshot receiver) in the map.
    let pending_oauth = pending
        .take(&session_id)
        .ok_or_else(|| "Unknown or expired session_id".to_string())?;

    // Clone the cancel notifier BEFORE we start awaiting the loopback
    // callback, so a parallel `gdrive_cancel_connect` can wake this
    // future via `notify_one()` even though the main `PendingOAuth`
    // entry has already been consumed by the `take()` above.
    //
    // `cancel_notifiers` retains its entry across `take()` — that is
    // the whole point of the separate map.
    let cancel_notify = pending_oauth.cancel_notify.clone();

    // RAII cleanup for the cancel notifier map. Ensures the entry is
    // removed on EVERY exit path (success, error, panic) — otherwise a
    // future `gdrive_cancel_connect` against this stale session_id
    // would erroneously claim a session was cancelled and the
    // notifier map would grow unbounded across reconnect attempts.
    struct CancelNotifyGuard<'a> {
        pending: &'a PendingOAuthState,
        session_id: &'a str,
    }
    impl<'a> Drop for CancelNotifyGuard<'a> {
        fn drop(&mut self) {
            self.pending.remove_cancel_notify(self.session_id);
        }
    }
    let _cancel_guard = CancelNotifyGuard {
        pending: &pending,
        session_id: &session_id,
    };

    // Acquire the sync slot BEFORE persisting anything. Without this guard,
    // an in-flight `run_sync_now` cycle that started under the legacy
    // `drive.file` token would (a) snapshot its provider before we land here,
    // (b) finish I/O AFTER we persist the new token and clear the
    // `gdrive_scope_upgrade_required` flag, (c) surface ScopeMismatch and
    // call `handle_scope_upgrade_required` which re-wipes the new credentials
    // and re-sets the flag — silently rolling back this reconnect.
    // Returning `sync_in_progress` here lets the frontend prompt the user to
    // retry after the in-flight cycle completes.
    //
    // Held across the OAuth browser-consent window (up to 5 min via
    // `callback_rx.await` below). Scheduler ticks during that window skip with
    // `sync_in_progress` and retry on the next tick — acceptable since the
    // user is actively reconnecting.
    let _sync_guard = crate::commands::sync::SyncInProgressGuard::try_acquire()
        .ok_or_else(|| crate::commands::sync::SYNC_IN_PROGRESS_ERR.to_string())?;

    // No password-mode gate: Google Drive is mode-agnostic. Mode-specific
    // wire format (plaintext for none, AES-GCM for password) is handled
    // inside the sync engine via Phase 4's versioned envelope.
    //
    // In password mode, verify the password before any Drive I/O.
    // In Unset mode (welcome screen), skip password verification — the
    // cloud probe below will route to NeedsOnboarding or NeedsFirstTimeSetup.
    // Read the unlock flag BEFORE taking the `state` lock: it doesn't need
    // `conn`, and keeping the `key_state` mutex acquisition outside the DB
    // critical section avoids any lock-ordering question against paths that
    // hold `key_state` and reach for `state` (see EncryptionKeyState's docs).
    let vault_unlocked = key_state.is_initialized()?;
    let local_mode = {
        let conn = state.lock()?;
        let mode = db::get_encryption_mode(&conn).map_err(|e| e.to_string())?;
        // The typed password is only ever an *ownership* proof here — it feeds
        // `verify_password_hash` and nothing else (the master used for every
        // Drive I/O below comes from `key_state`, already in memory). So when
        // the vault is already unlocked AND the caller supplied no password
        // (onboarding's Drive step, right after first-time setup), the unlocked
        // `key_state` IS the ownership proof and re-typing the password is
        // redundant. Settings' explicit re-auth still sends a real password and
        // is still verified; a locked vault with an empty password still fails.
        if password_check_required(&mode, password.is_empty(), vault_unlocked)
            && !db::verify_password_hash(&conn, &password).map_err(|e| e.to_string())?
        {
            return Err("Invalid password".to_string());
        }
        mode
    };

    let config = GoogleOAuthConfig::default();

    // Await the callback (with the 5-minute timeout inherited from
    // start_loopback_server), racing it against a cancel notification
    // from `gdrive_cancel_connect`. Without this select, a user who
    // closes the browser tab and clicks Cancel in the app is stuck
    // with a disabled "Connecting…" button until the 5-minute timeout.
    let callback = {
        let callback_rx = pending_oauth.callback_rx;
        tokio::select! {
            res = callback_rx => res
                .map_err(|_| "OAuth session cancelled before the loopback server returned".to_string())??,
            _ = cancel_notify.notified() => {
                if let Ok(conn) = state.lock() {
                    let _ = clear_gdrive_settings(&conn);
                }
                return Err("OAUTH_CANCELLED: User cancelled the OAuth flow".to_string());
            }
        }
    };

    // Post-callback progress: from here on the user is back in the app and the
    // slow sequential Drive I/O begins. Best-effort emits (ignore send errors) so
    // the frontend can show which phase is running under the "Connecting…" button.
    emit_connect_progress(&app, &session_id, "exchanging_token");

    // Exchange code → tokens.
    let token_resp = exchange_code(
        &pending_oauth.client_id,
        &pending_oauth.client_secret,
        &callback.code,
        &pending_oauth.verifier,
        &pending_oauth.redirect_uri,
        &config,
    )
    .await?;

    let refresh_token = token_resp
        .refresh_token
        .ok_or_else(|| "Google did not return a refresh token".to_string())?;

    // Build provider + session.
    let expires_at = std::time::Instant::now()
        + std::time::Duration::from_secs(token_resp.expires_in.saturating_sub(60));

    let session = GDriveSession {
        access_token: token_resp.access_token.clone(),
        expires_at,
        refresh_token: zeroize::Zeroizing::new(refresh_token),
        client_id: pending_oauth.client_id,
        client_secret: pending_oauth.client_secret,
    };

    complete_cloud_connect(
        &app,
        &*state,
        &*key_state,
        &*session_state,
        &session_id,
        CloudProvider::GDrive(GDriveProvider::new_live(session.clone())?),
        crate::commands::pending_drive_session::PendingCloudSession::GDrive {
            session,
            root_folder_id: String::new(),
        },
        local_mode,
        vault_unlocked,
        password.as_str(),
    )
    .await
}

/// Provider-agnostic remainder of the cloud connect pipeline.
///
/// Callers finish provider-specific setup (OAuth token exchange, folder
/// validation) then land here with a live [`CloudProvider`] and a
/// [`crate::commands::pending_drive_session::PendingCloudSession`].
pub(crate) async fn complete_cloud_connect<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    key_state: &EncryptionKeyState,
    session_state: &GDriveSessionState,
    session_id: &str,
    provider: CloudProvider,
    pending: crate::commands::pending_drive_session::PendingCloudSession,
    local_mode: db::EncryptionMode,
    _vault_unlocked: bool,
    _password: &str,
) -> Result<GdriveConnectOutcome, String> {
    let is_unset_mode = local_mode == db::EncryptionMode::Unset;

    let local_generation = {
        let conn = state.lock()?;
        db::get_sync_recovery_generation(&conn).map_err(|e| e.to_string())?
    };
    let provider = provider.with_recovery_fence(local_generation, None);

    emit_connect_progress(app, session_id, "establishing_root");

    // Establish the stable root/control authority before creating any device
    // or generation namespace. An existing non-empty root without control is
    // ambiguous and must never be claimed by an unconditional bootstrap.
    let observed_control = crate::sync::recovery::read_sync_control(&provider)
        .await
        .map_err(|error| format!("Failed to read cloud recovery control: {error}"))?;
    let (root_folder_id, root_created) = provider
        .ensure_root_folder_only()
        .await
        .map_err(|error| format!("Failed to establish cloud root: {error}"))?;
    let control = match observed_control {
        Some(control) => control,
        None => {
            if !root_created
                && !provider
                    .root_is_empty(&root_folder_id)
                    .await
                    .map_err(|error| format!("Failed to inspect cloud root: {error}"))?
            {
                return Err("RECOVERY_CONTROL_MISSING_ON_NONEMPTY_CLOUD".to_string());
            }
            crate::sync::recovery::bootstrap_sync_control(&provider, chrono::Utc::now().timestamp())
                .await
                .map_err(|error| format!("Failed to initialize cloud recovery control: {error}"))?
        }
    };
    if control.recovery_lease.is_some() {
        return Err("AUTHORITATIVE_RECOVERY_IN_PROGRESS".to_string());
    }
    if control.recovery_generation < local_generation {
        return Err(format!(
            "RECOVERY_GENERATION_ROLLBACK: cloud={}, local={local_generation}",
            control.recovery_generation
        ));
    }
    let candidate_generation = control.recovery_generation;
    provider.configure_recovery_fence_authority(candidate_generation, None);

    // Versioned snapshot used for mid-flow revalidation (before delayed
    // publish and immediately before Ready). A peer that acquires a lease or
    // bumps generation after this point must fail this connect closed.
    let (control_snapshot, control_revision) =
        crate::sync::recovery::read_versioned_sync_control(&provider)
            .await
            .map_err(|error| format!("Failed to snapshot cloud recovery control: {error}"))?;
    if let Err(error) = assert_connect_control_snapshot_stable(
        candidate_generation,
        &control_revision,
        &control_snapshot,
        &control_revision,
    ) {
        // Snapshot itself inconsistent with the pre-versioned read (lease
        // race between the two reads).
        return Err(error);
    }
    // Prefer the versioned generation if it advanced (rare race); keep
    // candidate aligned with the revision we will revalidate against.
    let candidate_generation = control_snapshot.recovery_generation;
    provider.configure_recovery_fence_authority(candidate_generation, None);

    // Persist refresh token + sync_connected flag FIRST (atomically), so a
    // crash after this point leaves the DB in a valid state and the next
    // launch can lazily re-run ensure_folder_structure.
    //
    // CRASH WINDOW: a hard crash between this write and the key-swap DB
    // commit below leaves sync_connected=true with the pre-swap key. The
    // error-path rollback cannot catch a process kill. Healed by
    // startup_keyring_reconcile_if_needed which runs on each unlock.
    //
    // Unset-mode exception: do NOT persist here. Setup has not completed,
    // so there is no key material to store the token against yet.
    // resolve_unset_outcome_and_stash() stashes the session in
    // PENDING_DRIVE_SESSION; onboard_complete / first-time setup persists it
    // atomically once setup finishes.
    // Stamp the Drive root id discovered above onto the pending session so
    // persist / Unset-mode stash carry the same folder the fence just claimed.
    let pending = match pending {
        crate::commands::pending_drive_session::PendingCloudSession::GDrive { session, .. } => {
            crate::commands::pending_drive_session::PendingCloudSession::GDrive {
                session,
                root_folder_id: root_folder_id.clone(),
            }
        }
        other => other,
    };

    if !is_unset_mode {
        let conn = state.lock()?;
        persist_connect_settings(&conn, &pending).map_err(|e| e.to_string())?;
    }

    // Get device_id for folder layout.
    let device_id = {
        let conn = state.lock()?;
        db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?
    };

    emit_connect_progress(app, session_id, "finalizing");

    // ── V1 keyring wipe (one-shot migration) ─────────────────────────────────
    //
    // If a V1 `.meta/keyring.json` is present on Drive, wipe it and return a
    // typed error so the frontend can prompt the user to reconnect. This is a
    // one-shot migration: once the V1 file is gone, subsequent connects skip
    // this block entirely.
    //
    // Ordering note: a V1 keyring is always wiped here. There is no longer a
    // mode-conflict case to order against — none-mode was removed, so every
    // device is password-mode. The V1 file is gone after the wipe.
    // Intercept V1 wipe: return typed outcome instead of propagating Err.
    match wipe_v1_keyring_if_present(&provider, &state).await {
        Ok(_) => {}
        Err(e) if e.starts_with("V1_WIPE_COMPLETE_RECONNECT_REQUIRED") => {
            return Ok(GdriveConnectOutcome::V1WipedReconnectRequired);
        }
        Err(e) => return Err(e),
    }

    // ── Pre-connect cloud-keyring probe ──────────────────────────────────────
    //
    // Always-encrypted: the cloud folder can only ever hold a `.meta/keyring.json`
    // / `_meta.json` (password-mode marker). The none-mode `.meta/mode.json`
    // marker and its mode-mismatch guard were removed — there is no none-mode
    // device left to conflict with.
    //
    // TODO Phase 3: detect V2 keyring presence via `_meta.json` instead of V1
    // `keyring.json`. For now we probe the V2 meta path as a best-effort check;
    // if `_meta.json` exists, we treat the cloud as password-mode. This replaces
    // the deleted V1 `keyring::download_from_drive` probe.
    //
    // I2: distinguish NotFound (absent) from real errors (auth / network / quota).
    // Previously all errors were treated as "not present", silently bypassing
    // the mode-mismatch guard on auth failures.
    let cloud_keyring_meta = {
        match crate::sync::keyring_v2::read_meta(&provider).await {
            Ok(meta) => meta,
            Err(e) => {
                if let Ok(conn) = state.lock() {
                    let _ = clear_gdrive_settings(&conn);
                }
                return Err(format!("Failed to probe cloud keyring: {e}"));
            }
        }
    };
    let cloud_keyring_present = cloud_keyring_meta.is_some();

    if is_unset_mode {
        // Local mode is Unset (welcome screen / fresh install).
        // Delegate to the extracted helper which stashes continuation outcomes
        // (NeedsOnboarding, NeedsFirstTimeSetup) in PENDING_DRIVE_SESSION and
        // returns terminal outcomes without stashing.
        //
        // No DB cleanup is needed here: persist_connect_settings was skipped for
        // Unset mode above, so the DB is still clean regardless of outcome.
        return Ok(resolve_unset_outcome_and_stash(
            session_id,
            pending,
            cloud_keyring_present,
        ));
    }

    if let Err(error) = validate_connect_generation_alignment(
        local_generation,
        candidate_generation,
        cloud_keyring_meta
            .as_ref()
            .map(|meta| meta.recovery_generation),
    ) {
        if let Ok(conn) = state.lock() {
            let _ = clear_gdrive_settings(&conn);
        }
        return Err(error);
    }

    // Only after mode/account/keyring authority validation may connect create
    // a generation-scoped device namespace.
    if let Err(e) = provider.ensure_folder_structure(&device_id).await {
        let (clear_local, best_effort_device_cleanup) = connect_folder_failure_cleanup_plan();
        if best_effort_device_cleanup {
            // Revalidate authority then delete the partial device namespace so
            // a failed connect does not leave orphan generations/g-N/<device>
            // under a recovery fence. Best-effort: never mask the original error.
            if let Err(cleanup_err) = provider
                .best_effort_delete_device_namespace(&device_id)
                .await
            {
                log::warn!(
                    "gdrive_complete_connect: best-effort device namespace cleanup failed: {cleanup_err}"
                );
            }
        }
        if clear_local {
            if let Ok(conn) = state.lock() {
                let _ = clear_gdrive_settings(&conn);
            }
        }
        return Err(e.to_string());
    }

    // ── V2 keyring publish on delayed connect (password mode only) ────────────
    //
    // When the user completes first-time setup offline (no Drive at that point),
    // `confirm_first_time_setup` skips the Drive upload. The local DB has all
    // key material, but the cloud has no keyring → no other device can onboard.
    //
    // C2 fix: if local is password mode AND the cloud has no `_meta.json` yet,
    // publish the initial V2 keyring now. If publish fails, set `keyring_dirty`
    // so the sync engine retries. Do NOT fail the whole connect on publish error.
    //
    // Recovery generation: pass the connect-time candidate explicitly so we
    // never plant `_meta.json.recovery_generation=0` while control is already N.
    // (Unset mode already returned above, so reaching here means Password mode.)
    if !cloud_keyring_present {
        log::info!(
            "gdrive_complete_connect: password mode, no cloud keyring — publishing V2 keyring"
        );

        // Revalidate before delayed publish — peer may have acquired a lease
        // or bumped generation during mode/keyring probes above.
        if let Err(error) =
            revalidate_connect_control_authority(&provider, candidate_generation, &control_revision)
                .await
        {
            if let Ok(conn) = state.lock() {
                let _ = clear_gdrive_settings(&conn);
            }
            return Err(error);
        }

        // The probe above established the absence of a COMMITTED cloud keyring
        // via a typed NotFound on a live token, so a stale inconclusive flag now
        // guards nothing — clear it before the publish gate reads it, or the
        // vault can never be rebuilt. Must run BEFORE the publish, not on its
        // success: gating it on the publish would leave the flag set, and the
        // `keyring_dirty && re_pair_required` guard in
        // `startup_keyring_reconcile_if_needed` then skips the retry forever.
        // See `clear_stale_flag_for_empty_cloud` for the full safety argument.
        //
        // Deliberately the one hard-fail in this best-effort block: a failed
        // clear is not a failed publish but a failed precondition, and the
        // publish below would be refused by the gate anyway — leaving the user
        // silently deadlocked. Surfacing the error lets them retry the connect.
        {
            let conn = state.lock()?;
            clear_stale_flag_for_empty_cloud(&conn, cloud_keyring_present)?;
        }

        let publish_ctx_result: Result<crate::commands::crypto::V2KeyringPublishContext, String> =
            (|| {
                let conn = state.lock().map_err(|e| e.to_string())?;
                let devices = db::list_devices(&conn).map_err(|e| e.to_string())?;
                let device = devices
                    .into_iter()
                    .find(|d| d.is_current)
                    .ok_or_else(|| "no current device in local DB".to_string())?;
                let recovery_wrapped = db::get_setting(&conn, db::RECOVERY_WRAPPED_MASTER_KEY)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "no recovery_wrapped_master in settings".to_string())?;
                let master_fingerprint = db::get_setting(&conn, db::CLOUD_MASTER_FINGERPRINT)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "no cloud_master_fingerprint in settings".to_string())?;
                let created_at = db::get_setting(&conn, db::RECOVERY_PASSPHRASE_CREATED_AT)
                    .map_err(|e| e.to_string())?
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(0);
                let (wrapped_content_v1, content_fingerprint_v1) =
                    extract_v1_content_for_publish(&conn)?;
                Ok(crate::commands::crypto::V2KeyringPublishContext {
                    recovery_wrapped,
                    device_id: device.device_id,
                    device_name: device.name,
                    master_fingerprint,
                    created_at,
                    device_created_at: device.created_at,
                    last_seen_at: device.last_seen_at,
                    wrapped_content_v1,
                    content_fingerprint_v1,
                })
            })();

        match publish_ctx_result {
            Ok(ctx) => {
                match publish_v2_keyring_with_provider_for_generation(
                    &provider,
                    &state,
                    &ctx,
                    &key_state,
                    Some(candidate_generation),
                )
                .await
                {
                    Ok(()) => {
                        // Readback: planted meta must match control generation.
                        // Without this, a bug in publish would leave Ready with
                        // a mismatched vault that every joiner rejects.
                        match crate::sync::keyring_v2::read_meta(&provider).await {
                            Ok(Some(meta)) => {
                                if let Err(error) = assert_published_meta_matches_control(
                                    meta.recovery_generation,
                                    candidate_generation,
                                ) {
                                    log::error!(
                                        "gdrive_complete_connect: post-publish meta mismatch: {error}"
                                    );
                                    if let Ok(conn) = state.lock() {
                                        let _ = clear_gdrive_settings(&conn);
                                        let _ = db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1");
                                    }
                                    return Err(error);
                                }
                            }
                            Ok(None) => {
                                log::error!(
                                    "gdrive_complete_connect: publish reported Ok but _meta.json missing"
                                );
                                if let Ok(conn) = state.lock() {
                                    let _ = clear_gdrive_settings(&conn);
                                    let _ = db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1");
                                }
                                return Err(
                                    "RECOVERY_GENERATION_MISMATCH: _meta.json missing after publish"
                                        .to_string(),
                                );
                            }
                            Err(e) => {
                                log::error!(
                                    "gdrive_complete_connect: post-publish meta readback failed: {e}"
                                );
                                if let Ok(conn) = state.lock() {
                                    let _ = clear_gdrive_settings(&conn);
                                    let _ = db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1");
                                }
                                return Err(format!(
                                    "Failed to verify published keyring generation: {e}"
                                ));
                            }
                        }
                        log::info!("gdrive_complete_connect: V2 keyring published");
                        if let Ok(conn) = state.lock() {
                            let _ = db::delete_setting(&conn, db::KEYRING_DIRTY_KEY);
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "gdrive_complete_connect: V2 keyring publish failed ({e}), setting keyring_dirty"
                        );
                        if let Ok(conn) = state.lock() {
                            let _ = db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1");
                        }
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "gdrive_complete_connect: could not build publish context ({e}), setting keyring_dirty"
                );
                if let Ok(conn) = state.lock() {
                    let _ = db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1");
                }
            }
        }
    } else if cloud_keyring_present {
        // Password mode + cloud keyring present → normal reconnect (same device).
        // Phase 5: compare cloud fingerprint vs local to detect vault rotation by peer.
        match resolve_force_re_pair_outcome(detect_force_re_pair(&provider, &state).await) {
            ForceRePairDecision::NeedsRepair(reason) => {
                // Another device rotated the vault since this device last synced.
                // Surface a typed outcome so the frontend routes to ForceRePairScreen.
                // Propagate a flag-write failure: `sync_connected=true` was already
                // persisted above, so returning the typed outcome without the
                // persisted flag would leave push unblocked after a restart.
                {
                    let conn = state.lock()?;
                    set_force_re_pair_flags(&conn, &reason.reason)?;
                }
                // Store the FRESH session before returning: the follow-up
                // `complete_force_re_pair` resolves its provider warm-session
                // first, and a stale (possibly revoked) session left in managed
                // state would shadow the new token just persisted to the DB —
                // making the mnemonic re-pair fail even though the reconnect
                // succeeded.
                if let crate::commands::pending_drive_session::PendingCloudSession::GDrive {
                    session,
                    ..
                } = &pending
                {
                    session_state.set(session.clone());
                }
                return Ok(GdriveConnectOutcome::NeedsForceRePair {
                    reason: reason.reason,
                    cloud_epoch: reason.cloud_epoch,
                });
            }
            ForceRePairDecision::Verified => {
                log::info!("keyring_v2: fingerprint matches — normal reconnect");
            }
            ForceRePairDecision::Skipped => {
                // No comparison was possible — leave any existing flag untouched.
                log::info!("keyring_v2: fingerprint check skipped — nothing to compare");
            }
            ForceRePairDecision::Inconclusive {
                message: e,
                is_auth,
            } => {
                // Dead auth → surface the reconnect error without flagging re-pair.
                // The vault is not implicated, and the flag would outlive the cause.
                if is_auth {
                    log::warn!(
                        "keyring_v2: fingerprint check failed on Drive auth ({e}) — \
                         reconnect required, NOT force-re-pair"
                    );
                    return Err(format!("gdrive_complete_connect: {e}"));
                }
                // Fail-closed: an inconclusive keyring check must not leave the
                // connection in a pushable state. sync_connected=true was already
                // persisted above; set FORCE_RE_PAIR_REQUIRED so ensure_safe_to_push
                // blocks any sync until the user reconnects and the check succeeds.
                log::error!(
                    "keyring_v2: fingerprint check failed ({e}), \
                     blocking push until re-pair succeeds (fail-closed)"
                );
                if let Ok(conn) = state.lock() {
                    // Propagate: a write failure means the push-blocking flag was
                    // NOT set, so we must surface that rather than silently continuing.
                    apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive")?;
                }
                return Err(format!(
                    "gdrive_complete_connect: keyring fingerprint check failed: {e}"
                ));
            }
        }
    }

    // Account email + quota from Drive `about` (best-effort — don't fail
    // the whole connect if the read-only endpoint is momentarily unavailable).
    //
    // Email MUST come from `about.user.emailAddress`, not OAuth2 userinfo:
    // we only request `drive.appdata` and never `openid`/`email`, so userinfo
    // returns nothing useful. The Memlore appDataFolder sum walks every file
    // and is deferred to `gdrive_refresh_storage_quota` when Settings opens.
    let about = match provider.as_gdrive() {
        Some(gdrive) => gdrive.fetch_drive_about().await.ok(),
        None => None,
    };
    let email = about.as_ref().and_then(|a| a.email.clone());
    let storage_used = about
        .as_ref()
        .and_then(|a| a.quota.usage.as_deref())
        .and_then(|u| u.parse::<u64>().ok());
    let storage_total = about
        .as_ref()
        .and_then(|a| a.quota.limit.as_deref())
        .and_then(|l| l.parse::<u64>().ok());

    // Final recovery-authority revalidation immediately before Ready. The
    // candidate_generation / control_revision snapshot is stale after probe
    // + optional publish + force-re-pair detect; a peer that acquired a lease
    // or bumped generation mid-flow must not leave this device Ready with a
    // live session at a superseded generation.
    if let Err(error) =
        revalidate_connect_control_authority(&provider, candidate_generation, &control_revision)
            .await
    {
        if let Ok(conn) = state.lock() {
            let _ = clear_gdrive_settings(&conn);
        }
        // Best-effort: do not leave a connected-looking device namespace if we
        // never committed Ready.
        if let Err(cleanup_err) = provider
            .best_effort_delete_device_namespace(&device_id)
            .await
        {
            log::warn!(
                "gdrive_complete_connect: Ready revalidate failed; device cleanup: {cleanup_err}"
            );
        }
        return Err(error);
    }

    // Second DB write — folder id + email + storage quota cache (best-effort
    // extras). Storage values are cached so `gdrive_get_status` can return
    // them after an app restart without a live API call.
    {
        let conn = state.lock()?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        if candidate_generation > 0 {
            db::set_sync_recovery_generation(&tx, candidate_generation)
                .map_err(|e| e.to_string())?;
        }
        if provider.as_gdrive().is_some() {
            db::set_setting(&tx, "gdrive_root_folder_id", &root_folder_id)
                .map_err(|e| e.to_string())?;
            if let Some(ref email) = email {
                db::set_setting(&tx, "gdrive_email", email).map_err(|e| e.to_string())?;
            }
            if let Some(used) = storage_used {
                db::set_setting(&tx, GDRIVE_STORAGE_USED_KEY, &used.to_string())
                    .map_err(|e| e.to_string())?;
            }
            if let Some(total) = storage_total {
                db::set_setting(&tx, GDRIVE_STORAGE_TOTAL_KEY, &total.to_string())
                    .map_err(|e| e.to_string())?;
            }
        }
        // A fully successful reconnect is the canonical "scope upgrade
        // complete" signal — clear the banner flag in the same tx so the
        // user doesn't have to dismiss the banner manually. Deferred to
        // here (not the earlier persist_connect_settings block) so a
        // mid-flow failure leaves the banner up; the user reconnects again
        // and the flag clears on the eventual success.
        db::delete_setting(
            &tx,
            crate::commands::sync::GDRIVE_SCOPE_UPGRADE_REQUIRED_KEY,
        )
        .map_err(|e| e.to_string())?;
        // Disconnect does not wipe local ledgers (token-only teardown). A
        // reconnect — especially to a different account / empty appdata
        // folder — must not keep hash-gated surfaces "clean" against a
        // cloud that no longer holds those blobs. Clear in the same tx as
        // the connect commit, then re-arm Automatic reconcile.
        db::clear_all_surface_push_hashes(&tx).map_err(|e| e.to_string())?;
        db::clear_all_pull_revisions(&tx).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        crate::sync::engine::reset_session_own_cloud_reconciled();
    }

    // Store Drive session in managed state (folder providers have none).
    if let crate::commands::pending_drive_session::PendingCloudSession::GDrive { session, .. } =
        pending
    {
        session_state.set(session);
    }

    // Ready: frontend re-fetches status via gdriveGetStatus().
    Ok(GdriveConnectOutcome::Ready)
}

// ─── Unset-mode routing helper ────────────────────────────────────────────────

/// Determine the typed outcome for an Unset-mode connect and, for continuation
/// outcomes (`NeedsOnboarding`, `NeedsFirstTimeSetup`), stash the pending
/// cloud session in `PENDING_DRIVE_SESSION` so the follow-on onboard/setup
/// commands can atomically commit provider settings + mode without repeating
/// connect (OAuth exchange or folder pick).
///
///   - keyring present → existing V2 password vault → `NeedsOnboarding`.
///   - keyring absent → empty folder → `NeedsFirstTimeSetup`.
///
/// This function is intentionally state-free (no `AppState`, no DB, no I/O)
/// so it can be called from unit tests without an `AppHandle`.
fn resolve_unset_outcome_and_stash(
    session_id: &str,
    pending: crate::commands::pending_drive_session::PendingCloudSession,
    cloud_keyring_present: bool,
) -> GdriveConnectOutcome {
    use crate::commands::pending_drive_session::{self, PendingDriveSession};

    // Continuation outcomes: stash session for the follow-on setup command.
    let outcome = if cloud_keyring_present {
        // V2 vault present — user must onboard via recovery phrase.
        GdriveConnectOutcome::NeedsOnboarding
    } else {
        // Cloud is empty — this is a new vault; user must do first-time setup.
        GdriveConnectOutcome::NeedsFirstTimeSetup
    };

    pending_drive_session::stash(
        session_id.to_string(),
        PendingDriveSession {
            session: pending,
            created_at: std::time::Instant::now(),
        },
    );

    outcome
}

// Note: the previous single-shot `gdrive_connect` command was removed
// because it could not work end-to-end — there was no way for the frontend
// to open the browser between starting the loopback server and awaiting the
// callback. The two-phase `gdrive_begin_connect` / `gdrive_complete_connect`
// is the sole public API now.

/// Disconnect Google Drive: revoke tokens (falling back to reconstructing the
/// session from the encrypted DB row if the in-memory session is empty),
/// clear all auth settings, clear session state. Removes `sync_connected` so
/// `disable_password_lock` is unblocked again.
#[tauri::command]
pub async fn gdrive_disconnect(
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
) -> Result<(), String> {
    // IMPORTANT: Do NOT delete the keyring directory (.meta/keyring/) from Drive on disconnect.
    // The keyring directory is a shared recovery artifact that survives disconnects
    // indefinitely. Other devices (or this device after reinstall) need it
    // to recover the entry key. Deleting it here would permanently break
    // key recovery for every connected device.
    let provider = acquire_cloud_provider(&state, Some(&session_state)).ok();
    if disconnect_should_revoke_oauth(provider.as_ref()) {
        if let Some(gdrive) = provider.as_ref().and_then(|p| p.as_gdrive()) {
            let session = gdrive.session.read().await;
            let config = GoogleOAuthConfig::default();
            // Best-effort — log but ignore network failures.
            if let Err(e) = revoke_token(&session.refresh_token, &config).await {
                log::warn!("gdrive_disconnect: token revoke failed (best-effort): {e}");
            }
        }
    }

    apply_disconnect_clear(&state, &session_state)
}

/// Wipe every file in the cloud `Memlore` Application Data folder.
///
/// Drive's folder-delete cascades, so this is a single API call that
/// removes every journal/keyring payload while preserving the stable root
/// and `.meta/control.json` recovery authority.
///
/// The `disconnect` flag controls what happens to local state:
///
/// - `disconnect = true` → also runs the standard disconnect path
///   (revoke OAuth token, clear `gdrive_refresh_token` + sync provider
///   settings). The user lands back at the disconnected state and can
///   reconnect fresh from any device. This is the safest option when
///   the user wants to "start completely over".
///
/// - `disconnect = false` → keep Drive connected; instead reset every
///   `sync_state` row + media `upload_status` to `pending`, so the next
///   sync cycle re-uploads the device's local data into the now-empty
///   cloud folder. Use case: the user wants this device to become the
///   new "source of truth" without breaking the OAuth session. Note:
///   peer devices that still hold OAuth credentials will continue to
///   push too — the user must coordinate the wipe across devices.
///
/// Returns Ok(()) on success. Missing payload objects are treated as already
/// cleared while the control authority must remain byte-for-byte unchanged.
#[tauri::command]
pub async fn gdrive_wipe_cloud(
    disconnect: bool,
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
) -> Result<(), String> {
    // Acquire the single-flight slot so the wipe can't race a concurrent
    // sync cycle. The sync engine could be mid-push, in which case payload
    // deletion + the engine's writes would interleave unpredictably.
    let _sync_guard = crate::commands::sync::SyncInProgressGuard::try_acquire()
        .ok_or_else(|| crate::commands::sync::SYNC_IN_PROGRESS_ERR.to_string())?;

    let (local_generation, device_id) = {
        let conn = state.lock()?;
        (
            db::get_sync_recovery_generation(&conn).map_err(|e| e.to_string())?,
            db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?,
        )
    };
    let provider = acquire_cloud_provider(&state, Some(&session_state))?
        .with_recovery_fence(local_generation, None);

    // Exclusive wipe authority: gen+1 recovery-style lease on control.json so
    // peer normal sync (same pre-wipe gen, no permit) cannot write_file /
    // recreate folders while deletes run. Local SyncInProgressGuard alone is
    // not multi-device. Resume adopts a stranded same-device cloud_cleanup lease.
    let wipe_permit =
        crate::sync::recovery::acquire_or_resume_cloud_cleanup_lease(&provider, &device_id)
            .await
            .map_err(|e| format!("Failed to acquire exclusive cloud cleanup lease: {e}"))?;
    provider.configure_recovery_fence_authority(
        wipe_permit.recovery_generation,
        Some(wipe_permit.clone()),
    );

    // For `keep_connection` mode, reset the local sync ledger FIRST so
    // a failure here leaves the cloud intact (recoverable: the user
    // retries the same button). The reverse order (cloud-wipe first)
    // would leave the user with an empty cloud + stale local "synced"
    // markers, requiring them to manually click "Reset sync status"
    // to recover — a confusing half-state.
    //
    // For `disconnect` mode the local writes are pure cleanup; their
    // failure mode is benign (the cloud is gone whether or not the
    // local DB rows update), so we keep them AFTER the cloud-wipe to
    // preserve the existing gdrive_disconnect ordering.
    //
    // Note: if clear fails mid-flight we intentionally leave the lease
    // held (fail-closed) so peers cannot re-upload into a half-wiped vault.
    // Retry resumes the same-device cloud_cleanup lease.
    if should_recreate_namespace_after_wipe(disconnect) {
        let conn = state.lock()?;
        let _: crate::commands::sync::ResetCounts =
            crate::commands::sync::reset_local_sync_state(&conn)
                .map_err(|e| format!("Failed to reset local sync state: {e}"))?;
        // Clear non-current device rows — their cloud slots are gone after the
        // wipe. The current device row is preserved so device-list UI stays intact.
        // Per CF Memory convention: sync destructive actions reset local state
        // atomically in the same flow.
        let _ = db::delete_non_current_devices(&conn);
        // Mark keyring as dirty so the current device's slot is re-uploaded on
        // the next sync tick (the wipe cascade deleted it from Drive).
        let _ = db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1");
        // Adopt the advanced wipe generation before cloud deletes finish so a
        // post-wipe sync on this device is not treated as a stale peer.
        db::set_sync_recovery_generation(&conn, wipe_permit.recovery_generation)
            .map_err(|e| format!("Failed to adopt wipe recovery generation: {e}"))?;
    }

    // Delete journal/keyring payloads while preserving the stable root and
    // control.json generation authority (including our exclusive wipe lease).
    if let Err(e) = provider.clear_cloud_preserving_control().await {
        return Err(format!(
            "Failed to clear cloud data (exclusive cleanup lease left held; retry wipe): {e}"
        ));
    }

    // Release only after successful wipe. Failure to release fails closed —
    // peers stay blocked rather than racing a freshly emptied vault.
    crate::sync::recovery::release_recovery_lease(&provider, &wipe_permit)
        .await
        .map_err(|e| {
            format!(
                "Cloud wiped but failed to release cleanup lease (peers blocked until resolved): {e}"
            )
        })?;
    // Drop local permit after release so subsequent ensure_folder_structure
    // uses normal same-gen push (no lease on control).
    provider.configure_recovery_fence_authority(wipe_permit.recovery_generation, None);

    if !should_recreate_namespace_after_wipe(disconnect) {
        // disconnect path: still record the advanced generation if settings
        // survive… but disconnect clears gdrive settings. Local gen update is
        // still useful if the user reconnects without a full DB wipe.
        let conn = state.lock()?;
        let _ = db::set_sync_recovery_generation(&conn, wipe_permit.recovery_generation);
    }

    if !disconnect {
        provider
            .ensure_folder_structure(&device_id)
            .await
            .map_err(|e| format!("Failed to recreate current sync namespace: {e}"))?;
    }

    if disconnect {
        // Clear in-memory session FIRST — that way, if the DB write
        // below fails (locked, disk full, etc.), the next operation
        // can't accidentally use the now-stale session against a
        // revoked token. Mirrors gdrive_disconnect's pattern but
        // explicitly orders the cleanup for fail-safety.
        session_state.clear();
        if let Some(gdrive) = provider.as_gdrive() {
            let session = gdrive.session.read().await;
            let config = GoogleOAuthConfig::default();
            // Best-effort revoke — log but ignore network failures.
            if let Err(e) = revoke_token(&session.refresh_token, &config).await {
                log::warn!("gdrive_wipe_cloud: token revoke failed (best-effort): {e}");
            }
        }
        {
            let conn = state.lock()?;
            clear_gdrive_settings(&conn)?;
        }
    }

    Ok(())
}

fn should_recreate_namespace_after_wipe(disconnect: bool) -> bool {
    !disconnect
}

/// Single-flight gate for `gdrive_preflight_local_authoritative_recovery`.
///
/// `local_authoritative_preflight` (unlike `cloud_authoritative_begin_staging`
/// and `local_authoritative_rebuild`, which acquire the guard themselves)
/// takes no `SyncInProgressGuard`. If a sync cycle (or any other guard holder:
/// rotation, OAuth connect, cloud wipe) is active, running preflight would
/// race that work and the user can see a misleading "cloud unreadable"
/// blocker. Refuse up-front with the exact `sync_in_progress` string the
/// frontend maps to "A sync is running right now". Hold the returned guard
/// for the whole command so the scheduler cannot start a sync mid-preflight.
fn acquire_recovery_preflight_guard() -> Result<crate::commands::sync::SyncInProgressGuard, String>
{
    crate::commands::sync::SyncInProgressGuard::try_acquire()
        .ok_or_else(|| crate::commands::sync::SYNC_IN_PROGRESS_ERR.to_string())
}

/// Prove local completeness and create a recovery backup before a
/// local-authoritative cloud rebuild. Work dir is under app data; the session
/// provider is reconstructed from the live GDrive session.
#[tauri::command]
pub async fn gdrive_preflight_local_authoritative_recovery(
    app: AppHandle,
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<crate::sync::recovery::LocalAuthoritativePreflightResult, String> {
    use tauri::Manager;

    let provider = acquire_cloud_provider(&state, Some(&session_state))?;
    let _sync_guard = acquire_recovery_preflight_guard()?;

    let work_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("sync_recovery")
        .join("local_to_cloud");
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Failed to create recovery work dir: {e}"))?;
    let opts = crate::sync::recovery::LocalAuthoritativePreflightOpts {
        work_dir,
        free_bytes_override: None,
        existing_job_id: None,
    };

    // ConnAccess short-locks AppState per DB call so cloud/keyring I/O and
    // media staging downloads never hold the mutex. AppState is Sync, so the
    // future stays Send without block_in_place.
    let result = crate::sync::recovery::local_authoritative_preflight(
        state.inner(),
        &provider,
        &provider,
        &key_state,
        opts,
    )
    .await
    .map_err(|e| e.to_string());
    // Always emit after job-mutating work so Settings hydrates without waiting
    // for an explicit get_sync_recovery_status poll (success and failure).
    emit_current_sync_recovery_status(&app, &state);
    result
}

/// Load V2 keyring material for local-authoritative rebuild in password mode.
///
/// Reconstructs multi-epoch `_content.json` entries from `WRAPPED_CONTENT_LIST`
/// (per-slot wrapped blobs) plus fingerprints from `key_state` — mirroring
/// [`publish_v2_keyring_with_provider`]. Never places the raw compact list into
/// `ContentEntryV2.wrapped_content` or leaves fingerprints empty.
fn load_rebuild_keyring_material(
    conn: &rusqlite::Connection,
    device_id: &str,
    key_state: &EncryptionKeyState,
) -> Result<crate::sync::recovery::LocalAuthoritativeKeyringMaterial, String> {
    use crate::utils::encryption::key_fingerprint;

    let recovery_wrapped = db::get_setting(conn, db::RECOVERY_WRAPPED_MASTER_KEY)
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "recovery_wrapped_master missing for rebuild keyring".to_string())?;
    let master_fingerprint = db::get_setting(conn, "cloud_master_fingerprint")
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "cloud_master_fingerprint missing for rebuild keyring".to_string())?;
    let device = db::list_devices(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|d| d.is_current && d.device_id == device_id)
        .ok_or_else(|| "current device row missing for rebuild keyring".to_string())?;
    let created_at = db::get_setting(conn, "recovery_passphrase_created_at")
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(device.created_at);

    const SLOT_HEX: usize = 128;
    const EPOCH_HEX: usize = 8;

    let list_hex = db::get_setting(conn, db::WRAPPED_CONTENT_LIST)
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "WRAPPED_CONTENT_LIST missing for rebuild keyring".to_string())?;
    if list_hex.len() < SLOT_HEX || list_hex.len() % SLOT_HEX != 0 {
        return Err(format!(
            "WRAPPED_CONTENT_LIST has invalid length {} (expected multiple of {SLOT_HEX})",
            list_hex.len()
        ));
    }

    let n_slots = list_hex.len() / SLOT_HEX;
    let mut content_entries = Vec::with_capacity(n_slots);
    for i in 0..n_slots {
        let slot = &list_hex[i * SLOT_HEX..(i + 1) * SLOT_HEX];
        let epoch_bytes = hex::decode(&slot[..EPOCH_HEX])
            .map_err(|e| format!("rebuild keyring: bad epoch hex in slot {i}: {e}"))?;
        if epoch_bytes.len() != 4 {
            return Err(format!(
                "rebuild keyring: epoch bytes wrong length in slot {i}"
            ));
        }
        let epoch = u32::from_be_bytes([
            epoch_bytes[0],
            epoch_bytes[1],
            epoch_bytes[2],
            epoch_bytes[3],
        ]);
        let wrapped_content = slot[EPOCH_HEX..].to_owned();
        let content_fingerprint = key_state
            .with_sync_key_for_epoch(epoch, |k| Ok(hex::encode(key_fingerprint(k))))
            .map_err(|e| {
                format!("rebuild keyring: cannot compute fingerprint for epoch {epoch}: {e}")
            })?;
        content_entries.push(crate::sync::recovery::LocalAuthoritativeContentEntry {
            epoch,
            wrapped_content,
            content_fingerprint,
        });
    }
    content_entries.sort_by_key(|e| e.epoch);
    let content_epoch = content_entries
        .last()
        .map(|e| e.epoch)
        .or_else(|| {
            db::get_setting(conn, db::CONTENT_KEY_EPOCH)
                .ok()
                .flatten()
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or(1);
    let master_epoch = db::get_setting(conn, db::KEYRING_V2_LOCAL_EPOCH)
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(1);

    Ok(crate::sync::recovery::LocalAuthoritativeKeyringMaterial {
        recovery_wrapped,
        device_name: device.name,
        master_fingerprint,
        created_at,
        device_created_at: device.created_at,
        last_seen_at: device.last_seen_at.max(device.created_at),
        content_entries,
        content_epoch,
        master_epoch,
    })
}

/// Rebuild every Google Drive channel from this device after a successful
/// local-authoritative preflight (job phase `backup` or resumable `fenced`).
///
/// This is the single orchestrator that replaces composing
/// `gdrive_wipe_cloud(false)` + `sync_repair_from_this_device`. It acquires
/// the recovery fence (`local_to_cloud`), clears cloud payloads while
/// preserving control authority, adopts all local content, uploads every
/// channel, and advances the job to `transfer` for Task 3 verification.
#[tauri::command]
pub async fn gdrive_rebuild_cloud_from_local(
    app: AppHandle,
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<crate::sync::recovery::LocalAuthoritativeRebuildResult, String> {
    let provider = std::sync::Arc::new(acquire_cloud_provider(&state, Some(&session_state))?);

    let (job_id, device_id, keyring_material, sync_key) = {
        let conn = state.lock()?;
        let job = db::find_active_sync_recovery_job(&conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                "No active local-to-cloud recovery job. Run preflight first.".to_string()
            })?;
        if job.operation != crate::sync::recovery::LOCAL_TO_CLOUD_OPERATION {
            return Err("Active recovery job is not local_to_cloud".to_string());
        }
        let device_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;
        // Material must reconstruct a valid multi-epoch content list.
        let keyring = Some(load_rebuild_keyring_material(
            &conn, &device_id, &key_state,
        )?);
        let sync_key = key_state
            .with_sync_key(|k| Ok(*k))
            .map_err(|e| format!("sync key unavailable: {e}"))?;
        (job.id, device_id, keyring, sync_key)
    };

    let provider_for_clear = provider.clone();

    let result = crate::sync::recovery::local_authoritative_rebuild(
        &*state,
        provider.clone(),
        provider.as_ref(),
        &device_id,
        &sync_key,
        &key_state,
        crate::sync::recovery::LocalAuthoritativeRebuildOpts {
            job_id,
            keyring: keyring_material,
        },
        move || async move { provider_for_clear.clear_cloud_preserving_control().await },
    )
    .await
    .map_err(|e| e.to_string());
    emit_current_sync_recovery_status(&app, &state);
    result
}

/// Verify the rebuilt cloud, release the recovery fence, run one normal sync,
/// and complete the local-to-cloud recovery job. Resumable from `transfer`
/// through `fence_release_pending`.
#[tauri::command]
pub async fn gdrive_finalize_local_authoritative_recovery(
    app: AppHandle,
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<crate::sync::recovery::LocalAuthoritativeVerifyResult, String> {
    let provider = std::sync::Arc::new(acquire_cloud_provider(&state, Some(&session_state))?);

    let (job_id, device_id, expect_keyring, sync_key) = {
        let conn = state.lock()?;
        let job = db::find_active_sync_recovery_job(&conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                "No active local-to-cloud recovery job. Run rebuild first.".to_string()
            })?;
        if job.operation != crate::sync::recovery::LOCAL_TO_CLOUD_OPERATION {
            return Err("Active recovery job is not local_to_cloud".to_string());
        }
        let device_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;
        let expect_keyring = db::get_setting(&conn, db::RECOVERY_WRAPPED_MASTER_KEY)
            .map_err(|e| e.to_string())?
            .is_some();
        let sync_key = key_state
            .with_sync_key(|k| Ok(*k))
            .map_err(|e| format!("sync key unavailable: {e}"))?;
        (job.id, device_id, expect_keyring, sync_key)
    };

    let result = crate::sync::recovery::local_authoritative_verify_and_finalize(
        &*state,
        provider.clone(),
        provider.as_ref(),
        &device_id,
        &sync_key,
        &key_state,
        crate::sync::recovery::LocalAuthoritativeVerifyOpts {
            job_id,
            expect_keyring,
        },
    )
    .await
    .map_err(|e| e.to_string());
    emit_current_sync_recovery_status(&app, &state);
    result
}

/// Begin a cloud-authoritative local restore: acquire the single-flight
/// sync guard, write an automatic recovery backup, open a migrated
/// SQLCipher staging database keyed with the current per-device `db_key`,
/// and preserve device-local settings outside the staged dataset.
///
/// Never writes to Google Drive. Leaves the active vault open until a later
/// atomic commit step. Materialize (Task 2) starts from the resulting
/// job phase `backup`.
#[tauri::command]
pub async fn gdrive_begin_cloud_authoritative_staging(
    app: AppHandle,
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<crate::sync::recovery::CloudAuthoritativeStagingResult, String> {
    use tauri::Manager;

    let provider = acquire_cloud_provider(&state, Some(&session_state))?;
    // `cloud_authoritative_begin_staging` owns the real SyncInProgressGuard
    // (first statement, `sync/recovery.rs`) — acquiring it here too would
    // self-refuse every call. Fast-fail before the cloud inventory estimate
    // so a running sync is reported immediately.
    if crate::commands::sync::is_sync_in_progress() {
        return Err(crate::commands::sync::SYNC_IN_PROGRESS_ERR.to_string());
    }

    let work_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("sync_recovery")
        .join("cloud_to_local");
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Failed to create recovery work dir: {e}"))?;
    // Prefer cloud inventory for disk preflight so empty local vaults do not
    // under-budget a large cloud restore.
    let cloud_media_bytes_estimate =
        crate::sync::recovery::estimate_cloud_media_bytes_for_preflight(&provider)
            .await
            .ok();
    let opts = crate::sync::recovery::CloudAuthoritativeStagingOpts {
        work_dir,
        free_bytes_override: None,
        existing_job_id: None,
        cloud_media_bytes_estimate,
    };

    // ConnAccess short-locks AppState per DB call; keyring/control-plane
    // probes run without the mutex. AppState is Sync, so the future stays
    // Send without block_in_place.
    let result = crate::sync::recovery::cloud_authoritative_begin_staging(
        state.inner(),
        &provider,
        &key_state,
        opts,
    )
    .await
    .map_err(|e| e.to_string());
    emit_current_sync_recovery_status(&app, &state);
    result
}

/// Stream every cloud channel into the staging vault and verify counts.
/// Requires an active `cloud_to_local` job at phase `backup` (or resumable
/// materialize phases). Never writes to Drive; never mutates the active vault.
#[tauri::command]
pub async fn gdrive_materialize_cloud_authoritative_staging(
    app: AppHandle,
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<crate::sync::recovery::CloudAuthoritativeMaterializeResult, String> {
    let provider = std::sync::Arc::new(acquire_cloud_provider(&state, Some(&session_state))?);

    // Short lock: validate job + build opts, then release before long I/O.
    let (staging, device_id, content_key) = {
        let conn = state.lock()?;
        let job = db::find_active_sync_recovery_job(&conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                "No active cloud-to-local recovery job. Run begin staging first.".to_string()
            })?;
        if job.operation != crate::sync::recovery::CLOUD_TO_LOCAL_OPERATION {
            return Err("Active recovery job is not cloud_to_local".to_string());
        }
        // Real cloud generation from verified_counts — never job.recovery_generation
        // alone (that column is max(cloud, 1) for DB CHECK).
        let cloud_gen = crate::sync::recovery::cloud_recovery_generation_from_job(&job);
        let staging = crate::sync::recovery::staging_result_from_job(&job, cloud_gen)?;
        let device_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;
        let content_key = key_state
            .with_sync_key(|k| Ok(*k))
            .map_err(|e| format!("content/sync key unavailable: {e}"))?;
        (staging, device_id, content_key)
    };

    let keyring = provider.clone();

    // ConnAccess short-locks AppState only for job phase updates; pull/media
    // I/O runs without holding the DB mutex. block_in_place is required because
    // the materialize future holds a staging `Connection` across `.await`
    // (rusqlite Connection is !Send).
    let result = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current()
            .block_on(crate::sync::recovery::cloud_authoritative_materialize(
                &*state,
                provider,
                // GDriveProvider implements KeyringV2Io for control-plane reads.
                keyring.as_ref(),
                &key_state,
                crate::sync::recovery::CloudAuthoritativeMaterializeOpts {
                    staging,
                    device_id,
                    content_key,
                },
            ))
            .map_err(|e| e.to_string())
    });
    emit_current_sync_recovery_status(&app, &state);
    result
}

/// Atomically replace the active vault + media with the verified staging pair,
/// restore preserved device-local settings, reopen through `AppState`, emit a
/// refresh event, run one normal sync, and delete rollback files only on success.
#[tauri::command]
pub async fn gdrive_commit_cloud_authoritative_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<crate::sync::recovery::CloudAuthoritativeCommitResult, String> {
    use tauri::Manager;

    let provider = std::sync::Arc::new(acquire_cloud_provider(&state, Some(&session_state))?);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let active_db_path = data_dir.join("memlore.db");
    let active_media_path = data_dir.join("media");

    let (staging, device_id, content_key, active_conn) = {
        // Take the live connection out of AppState so we can checkpoint+close
        // it before the filesystem rename. A temporary in-memory placeholder
        // keeps other commands from racing on a half-closed handle.
        let placeholder =
            rusqlite::Connection::open_in_memory().map_err(|e| format!("placeholder conn: {e}"))?;
        let active_conn = {
            let mut guard = state.lock()?;
            std::mem::replace(&mut *guard, placeholder)
        };

        let restore_on_err = |conn: rusqlite::Connection, msg: String| -> String {
            let _ = state.set_connection(conn);
            msg
        };

        let job = match db::find_active_sync_recovery_job(&active_conn) {
            Ok(Some(j)) => j,
            Ok(None) => {
                return Err(restore_on_err(
                    active_conn,
                    "No active cloud-to-local recovery job. Run materialize first.".to_string(),
                ));
            }
            Err(e) => return Err(restore_on_err(active_conn, e.to_string())),
        };
        if job.operation != crate::sync::recovery::CLOUD_TO_LOCAL_OPERATION {
            return Err(restore_on_err(
                active_conn,
                "Active recovery job is not cloud_to_local".to_string(),
            ));
        }
        if job.phase != "verify" && job.phase != "commit" {
            return Err(restore_on_err(
                active_conn,
                format!(
                    "cloud-authoritative commit requires phase verify|commit (got {})",
                    job.phase
                ),
            ));
        }

        // Real cloud generation from verified_counts — never promote from
        // job.recovery_generation (CHECK forces ≥1 even when cloud is 0).
        let cloud_gen = crate::sync::recovery::cloud_recovery_generation_from_job(&job);
        let staging = match crate::sync::recovery::staging_result_from_job(&job, cloud_gen) {
            Ok(s) => s,
            Err(e) => return Err(restore_on_err(active_conn, e)),
        };
        let device_id = match db::get_or_create_device_id(&active_conn) {
            Ok(id) => id,
            Err(e) => return Err(restore_on_err(active_conn, e.to_string())),
        };
        let content_key = match key_state.with_sync_key(|k| Ok(*k)) {
            Ok(k) => k,
            Err(e) => {
                return Err(restore_on_err(
                    active_conn,
                    format!("content/sync key unavailable: {e}"),
                ));
            }
        };
        (staging, device_id, content_key, active_conn)
    };

    // Swap + reopen only first so AppState is not left on an empty placeholder
    // during the long post-commit normal sync.
    let commit_result = crate::sync::recovery::cloud_authoritative_commit(
        active_conn,
        provider.clone(),
        &key_state,
        crate::sync::recovery::CloudAuthoritativeCommitOpts {
            staging: staging.clone(),
            active_db_path: active_db_path.clone(),
            active_media_path,
            device_id: device_id.clone(),
            content_key,
            run_post_commit_sync: false,
        },
    )
    .await;

    let (new_conn, swap_result) = match commit_result {
        Ok(pair) => pair,
        Err(e) => {
            // Attempt to reopen whatever is on disk (rolled back or not).
            let _ = reopen_active_vault_into_state(&state, &key_state, &active_db_path);
            return Err(e.to_string());
        }
    };

    // Install the promoted vault immediately after swap/reopen so AppState
    // never remains on the empty in-memory placeholder during post-sync.
    state.set_connection(new_conn)?;

    // Re-acquire single-flight while finalize runs (commit guard already dropped).
    let _sync_guard = crate::commands::sync::SyncInProgressGuard::try_acquire()
        .ok_or_else(|| crate::commands::sync::SYNC_IN_PROGRESS_ERR.to_string())?;

    // Post-commit normal sync with the real AppState connection (short locks).
    let finalize_result = crate::sync::recovery::cloud_authoritative_finalize_after_swap(
        &*state,
        provider,
        &key_state,
        crate::sync::recovery::CloudAuthoritativeFinalizeOpts {
            job_id: swap_result.job_id,
            device_id,
            content_key,
            verified_counts: String::new(), // filled from job row inside finalize
            active_db_path: swap_result.active_db_path.clone(),
            active_media_path: swap_result.active_media_path.clone(),
            rollback_db_path: swap_result.rollback_db_path.clone(),
            rollback_media_path: swap_result.rollback_media_path.clone(),
            backup_path: swap_result.backup_path.clone(),
            staging_path: staging.staging_path.clone(),
        },
    )
    .await;

    match finalize_result {
        Ok(result) => {
            let _ = app.emit(
                "xj://cloud-restore-committed",
                serde_json::json!({
                    "jobId": result.job_id,
                    "status": result.status,
                    "phase": result.phase,
                }),
            );
            // Job should be completed — emit null / inactive so FE clears chrome.
            emit_current_sync_recovery_status(&app, &state);
            Ok(result)
        }
        Err(e) => {
            // Vault already swapped and installed; surface Err so FE does not
            // treat a failed post-commit as success. Rollback files retained.
            emit_current_sync_recovery_status(&app, &state);
            Err(e.to_string())
        }
    }
}

fn reopen_active_vault_into_state(
    state: &State<'_, AppState>,
    key_state: &State<'_, EncryptionKeyState>,
    active_db_path: &std::path::Path,
) -> Result<(), String> {
    let db_key = key_state
        .with_db_key(|k| Ok(*k))
        .map_err(|e| format!("db_key unavailable: {e}"))?;
    let conn = crate::sync::recovery::open_cloud_authoritative_staging_db(active_db_path, &db_key)?;
    state.set_connection(conn)
}

// ─── Recovery status / resume / cancel-safe (Phase 4 Task 1) ─────────────────

/// Tauri event for recovery job snapshot changes. Payload is
/// `Option<SyncRecoveryStatus>` (null when no active job).
pub const SYNC_RECOVERY_STATUS_EVENT: &str = "sync:recovery-status-changed";

/// Next invoke step for an interrupted or in-progress recovery job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncRecoveryStep {
    LocalPreflight,
    LocalRebuild,
    LocalFinalize,
    CloudBeginStaging,
    CloudMaterialize,
    CloudCommit,
}

/// Classifies a recovery failure for UI copy and control enablement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncRecoveryErrorClass {
    /// Transient / network / mid-transfer — user can retry resume.
    Retryable,
    /// Hard stop until the user fixes a blocker (force re-pair, competing
    /// recovery, generation mismatch, rotation).
    Terminal,
    /// Preflight gate failed (disk, media completeness, keyring/cloud
    /// readability). User must resolve then re-run preflight.
    PreflightBlocker,
}

/// UI-facing snapshot of the active (or most recent non-completed) recovery job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecoveryStatus {
    pub job_id: i64,
    /// `local_to_cloud` | `cloud_to_local`
    pub operation: String,
    pub phase: String,
    /// `pending` | `running` | `failed` | `completed`
    pub status: String,
    pub recovery_generation: i64,
    pub backup_path: Option<String>,
    pub staging_path: Option<String>,
    /// Parsed `verified_counts` JSON object (channel counts, media totals, …).
    pub verified_counts: serde_json::Value,
    pub last_error: Option<String>,
    /// True while status ≠ completed — keep visible outside collapsed help.
    pub is_active: bool,
    /// Normal Sync Now / push must stay disabled.
    pub blocks_normal_sync: bool,
    pub can_resume: bool,
    /// True only when abandoning leaves cloud + local consistent (no live
    /// fence, no mid-swap).
    pub can_cancel_safely: bool,
    pub next_step: Option<SyncRecoveryStep>,
    pub error_class: Option<SyncRecoveryErrorClass>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn recovery_phase_rank(phase: &str) -> u8 {
    match phase {
        "created" => 0,
        "preflight" => 1,
        "backup" => 2,
        "fenced" => 3,
        "transfer" => 4,
        "verify" => 5,
        "commit" => 6,
        "finalize" => 7,
        "fence_release_pending" => 8,
        _ => 255,
    }
}

fn classify_recovery_error(message: &str) -> SyncRecoveryErrorClass {
    let lower = message.to_ascii_lowercase();
    if lower.contains("force re-pair")
        || lower.contains("force_re_pair")
        || lower.contains("competing recovery")
        || lower.contains("competing")
        || lower.contains("rotation")
        || lower.contains("generation")
        || lower.contains("recovery_generation")
    {
        return SyncRecoveryErrorClass::Terminal;
    }
    if lower.contains("insufficient")
        || lower.contains("media incomplete")
        || lower.contains("missing media")
        || lower.contains("corrupt")
        || lower.contains("unreadable")
        || lower.contains("disk")
    {
        return SyncRecoveryErrorClass::PreflightBlocker;
    }
    SyncRecoveryErrorClass::Retryable
}

fn next_recovery_step(operation: &str, phase: &str) -> Option<SyncRecoveryStep> {
    match operation {
        crate::sync::recovery::LOCAL_TO_CLOUD_OPERATION => match phase {
            "created" | "preflight" => Some(SyncRecoveryStep::LocalPreflight),
            "backup" | "fenced" => Some(SyncRecoveryStep::LocalRebuild),
            // Rebuild is a no-op success once phase ≥ transfer; finalize owns
            // verify → fence_release_pending.
            "transfer" | "verify" | "commit" | "finalize" | "fence_release_pending" => {
                Some(SyncRecoveryStep::LocalFinalize)
            }
            _ => None,
        },
        crate::sync::recovery::CLOUD_TO_LOCAL_OPERATION => match phase {
            "created" | "preflight" => Some(SyncRecoveryStep::CloudBeginStaging),
            "backup" => Some(SyncRecoveryStep::CloudMaterialize),
            "transfer" => Some(SyncRecoveryStep::CloudMaterialize),
            "verify" | "commit" | "finalize" | "fence_release_pending" => {
                Some(SyncRecoveryStep::CloudCommit)
            }
            // local_to_cloud-only phase should not appear for cloud jobs.
            "fenced" => Some(SyncRecoveryStep::CloudMaterialize),
            _ => None,
        },
        _ => None,
    }
}

fn can_cancel_recovery_safely(operation: &str, phase: &str) -> bool {
    let rank = recovery_phase_rank(phase);
    match operation {
        // Fence is acquired at `fenced`; cloud wipe follows. Abandon only
        // before that rank so we never leave a live marker ownerless.
        crate::sync::recovery::LOCAL_TO_CLOUD_OPERATION => rank < recovery_phase_rank("fenced"),
        // Staging discard is safe until atomic local swap (`commit`).
        crate::sync::recovery::CLOUD_TO_LOCAL_OPERATION => rank < recovery_phase_rank("commit"),
        _ => false,
    }
}

pub(crate) fn sync_recovery_status_from_job(job: &db::SyncRecoveryJobRow) -> SyncRecoveryStatus {
    let is_active = job.status != "completed";
    let next_step = if is_active {
        next_recovery_step(&job.operation, &job.phase)
    } else {
        None
    };
    let can_cancel_safely = is_active && can_cancel_recovery_safely(&job.operation, &job.phase);
    let error_class = job
        .last_error
        .as_deref()
        .filter(|e| !e.is_empty() && *e != "cancelled")
        .map(classify_recovery_error);
    // Resume only for in-flight or retryable failures. Terminal / preflight
    // blockers require the user to fix the underlying issue (or re-run a
    // fresh preflight), not hammer Resume.
    let can_resume = is_active
        && next_step.is_some()
        && !matches!(
            error_class,
            Some(SyncRecoveryErrorClass::Terminal | SyncRecoveryErrorClass::PreflightBlocker)
        );
    let verified_counts =
        serde_json::from_str(&job.verified_counts).unwrap_or_else(|_| serde_json::json!({}));

    SyncRecoveryStatus {
        job_id: job.id,
        operation: job.operation.clone(),
        phase: job.phase.clone(),
        status: job.status.clone(),
        recovery_generation: job.recovery_generation,
        backup_path: job.backup_path.clone(),
        staging_path: job.staging_path.clone(),
        verified_counts,
        last_error: job.last_error.clone(),
        is_active,
        blocks_normal_sync: is_active,
        can_resume,
        can_cancel_safely,
        next_step,
        error_class,
        created_at: job.created_at,
        updated_at: job.updated_at,
    }
}

fn read_sync_recovery_status(
    conn: &rusqlite::Connection,
) -> Result<Option<SyncRecoveryStatus>, String> {
    let job = db::find_active_sync_recovery_job(conn).map_err(|e| e.to_string())?;
    Ok(job.map(|j| sync_recovery_status_from_job(&j)))
}

fn emit_sync_recovery_status(app: &AppHandle, status: Option<&SyncRecoveryStatus>) {
    if let Err(e) = app.emit(SYNC_RECOVERY_STATUS_EVENT, status) {
        log::warn!("emit_sync_recovery_status: failed to emit {SYNC_RECOVERY_STATUS_EVENT}: {e}");
    }
}

/// Read the active job (if any) and emit `sync:recovery-status-changed`.
/// Best-effort: lock / read failures are logged and never fail the caller.
fn emit_current_sync_recovery_status(app: &AppHandle, state: &AppState) {
    match state.lock() {
        Ok(conn) => match read_sync_recovery_status(&conn) {
            Ok(status) => emit_sync_recovery_status(app, status.as_ref()),
            Err(e) => log::warn!("emit_current_sync_recovery_status: read failed: {e}"),
        },
        Err(e) => log::warn!("emit_current_sync_recovery_status: lock failed: {e}"),
    }
}

/// Snapshot the active authoritative recovery job (if any). Returns `null`
/// when no non-completed job exists so Settings can hide recovery chrome.
#[tauri::command]
pub fn get_sync_recovery_status(
    state: State<'_, AppState>,
) -> Result<Option<SyncRecoveryStatus>, String> {
    let conn = state.lock()?;
    read_sync_recovery_status(&conn)
}

/// Cancel-safe abandon of an incomplete recovery job.
///
/// Only succeeds when [`SyncRecoveryStatus::can_cancel_safely`] is true —
/// before a live remote fence (local→cloud) or before local vault swap
/// (cloud→local). Discards local staging when present; never mutates Drive.
#[tauri::command]
pub fn gdrive_cancel_sync_recovery(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SyncRecoveryStatus, String> {
    let status = {
        let conn = state.lock()?;
        let job = db::find_active_sync_recovery_job(&conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No active recovery job to cancel".to_string())?;
        let status = sync_recovery_status_from_job(&job);
        if !status.can_cancel_safely {
            return Err(format!(
                "recovery cancel is not safe at phase {} (operation {}); resume instead",
                status.phase, status.operation
            ));
        }
        // Best-effort discard of local staging / incomplete media downloads.
        if let Some(staging) = job.staging_path.as_deref() {
            let path = std::path::Path::new(staging);
            if path.exists() {
                if let Err(e) = std::fs::remove_dir_all(path) {
                    log::warn!(
                        "gdrive_cancel_sync_recovery: failed to remove staging {staging}: {e}"
                    );
                }
            }
        }
        db::cancel_sync_recovery_job(&conn, job.id).map_err(|e| e.to_string())?;
        let cancelled = db::get_sync_recovery_job(&conn, job.id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "cancelled recovery job missing".to_string())?;
        sync_recovery_status_from_job(&cancelled)
    };
    // Active job is gone — emit null so FE clears recovery chrome.
    emit_sync_recovery_status(&app, None);
    Ok(status)
}

/// Resume-level single-flight. Distinct from `SyncInProgressGuard` so a
/// resume that dispatches a preflight step does not double-acquire the sync
/// slot (the preflight gate takes that guard itself).
static RESUME_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
struct ResumeInFlightGuard;

impl ResumeInFlightGuard {
    fn try_acquire() -> Result<Self, String> {
        if RESUME_IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            Ok(Self)
        } else {
            Err("resume already running".into())
        }
    }
}

impl Drop for ResumeInFlightGuard {
    fn drop(&mut self) {
        RESUME_IN_FLIGHT.store(false, Ordering::Release);
    }
}

/// Claim the resume slot then flip the job to `running`. The loser never
/// writes the row.
fn try_begin_resume(
    conn: &rusqlite::Connection,
    job_id: i64,
) -> Result<ResumeInFlightGuard, String> {
    let guard = ResumeInFlightGuard::try_acquire()?;
    db::mark_sync_recovery_job_running(conn, job_id).map_err(|e| e.to_string())?;
    Ok(guard)
}

#[cfg(test)]
static RESUME_GUARD_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Resume an interrupted recovery job by dispatching the next workflow step.
///
/// Re-enters the same phase commands used for start; those paths are
/// idempotent and re-read the persisted job row. Returns the post-step
/// status snapshot (may still be active when more steps remain).
#[tauri::command]
pub async fn gdrive_resume_sync_recovery(
    app: AppHandle,
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<SyncRecoveryStatus, String> {
    let _resume_guard;
    let (job_id, next) = {
        let conn = state.lock()?;
        let job = db::find_active_sync_recovery_job(&conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No active recovery job to resume".to_string())?;
        let status = sync_recovery_status_from_job(&job);
        if !status.can_resume {
            return Err(format!(
                "recovery job {} cannot be resumed (status={}, phase={})",
                status.job_id, status.status, status.phase
            ));
        }
        let next = status
            .next_step
            .ok_or_else(|| "recovery job has no next step".to_string())?;
        // Leave any stuck "failed" snapshot immediately so the UI shows
        // progress while the long step is in flight.
        _resume_guard = try_begin_resume(&conn, job.id)?;
        let running = db::get_sync_recovery_job(&conn, job.id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "recovery job missing after mark running".to_string())?;
        let running_status = sync_recovery_status_from_job(&running);
        emit_sync_recovery_status(&app, Some(&running_status));
        (job.id, next)
    };

    // Dispatch one step — callers may re-invoke until status is no longer active.
    // Nested step commands also emit; final snapshot below is authoritative.
    let step_result: Result<(), String> = match next {
        SyncRecoveryStep::LocalPreflight => gdrive_preflight_local_authoritative_recovery(
            app.clone(),
            state.clone(),
            session_state.clone(),
            key_state.clone(),
        )
        .await
        .map(|_| ()),
        SyncRecoveryStep::LocalRebuild => gdrive_rebuild_cloud_from_local(
            app.clone(),
            state.clone(),
            session_state.clone(),
            key_state.clone(),
        )
        .await
        .map(|_| ()),
        SyncRecoveryStep::LocalFinalize => gdrive_finalize_local_authoritative_recovery(
            app.clone(),
            state.clone(),
            session_state.clone(),
            key_state.clone(),
        )
        .await
        .map(|_| ()),
        SyncRecoveryStep::CloudBeginStaging => gdrive_begin_cloud_authoritative_staging(
            app.clone(),
            state.clone(),
            session_state.clone(),
            key_state.clone(),
        )
        .await
        .map(|_| ()),
        SyncRecoveryStep::CloudMaterialize => gdrive_materialize_cloud_authoritative_staging(
            app.clone(),
            state.clone(),
            session_state.clone(),
            key_state.clone(),
        )
        .await
        .map(|_| ()),
        SyncRecoveryStep::CloudCommit => gdrive_commit_cloud_authoritative_restore(
            app.clone(),
            state.clone(),
            session_state.clone(),
            key_state.clone(),
        )
        .await
        .map(|_| ()),
    };

    if let Err(err) = step_result {
        // Bookkeeping must never mask the step error: log and still return
        // `err` so the caller sees why the step was refused.
        match state.lock() {
            Ok(conn) => {
                if let Err(e) = record_refused_resume_step(&conn, job_id, &err) {
                    log::warn!("gdrive_resume_sync_recovery: could not record refused step: {e}");
                }
            }
            Err(e) => log::warn!("gdrive_resume_sync_recovery: lock failed after refusal: {e}"),
        }
        emit_current_sync_recovery_status(&app, &state);
        return Err(err);
    }

    let status = {
        let conn = state.lock()?;
        // Prefer still-active job; fall back to latest row after completion.
        match db::find_active_sync_recovery_job(&conn).map_err(|e| e.to_string())? {
            Some(job) => sync_recovery_status_from_job(&job),
            None => {
                let latest = db::find_latest_sync_recovery_job(&conn)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "recovery job missing after resume step".to_string())?;
                sync_recovery_status_from_job(&latest)
            }
        }
    };
    emit_sync_recovery_status(
        &app,
        if status.is_active {
            Some(&status)
        } else {
            None
        },
    );
    Ok(status)
}

/// Persist a resume-step refusal on the job when the step never reached the
/// recovery module.
///
/// A step command can bail before the module writes anything to the job
/// (`sync_in_progress` from the preflight gate, "Not connected to Google
/// Drive", …). `gdrive_resume_sync_recovery` marks the row `running` with a
/// cleared `last_error` before dispatch, so without this the UI would show an
/// in-progress recovery nobody is driving. Only a job the module left
/// untouched (`running`, no error) is failed here — a failure the module
/// recorded itself carries the better classification and must win.
fn record_refused_resume_step(
    conn: &rusqlite::Connection,
    job_id: i64,
    err: &str,
) -> Result<(), String> {
    let Some(job) = db::get_sync_recovery_job(conn, job_id).map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let untouched = job.status == "running" && job.last_error.as_deref().is_none_or(str::is_empty);
    if untouched {
        db::fail_sync_recovery_job(conn, job_id, err).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn validate_connect_generation_alignment(
    local_generation: u64,
    control_generation: u64,
    keyring_meta_generation: Option<u64>,
) -> Result<u64, String> {
    if control_generation < local_generation {
        return Err(format!(
            "RECOVERY_GENERATION_ROLLBACK: cloud={control_generation}, local={local_generation}"
        ));
    }
    if let Some(meta_generation) = keyring_meta_generation {
        if meta_generation != control_generation {
            return Err(format!(
                "RECOVERY_GENERATION_MISMATCH: control={control_generation}, keyring_meta={meta_generation}"
            ));
        }
    }
    Ok(control_generation)
}

/// Generation written into keyring `_meta.json` and the mutation fence.
///
/// Connect may observe `control.recovery_generation = N` while the local DB is
/// still `0`. Prefer an explicit connect-time candidate over the stale local
/// value so delayed publish never plants `_meta.json.recovery_generation=0`
/// against a higher control generation.
fn resolve_keyring_publish_generation(
    local_generation: u64,
    override_generation: Option<u64>,
) -> u64 {
    override_generation.unwrap_or(local_generation)
}

/// Fail closed when cloud recovery authority moved mid-connect.
///
/// Compares a snapshot taken after control bootstrap against a fresh
/// versioned read. Any active lease, generation bump, or revision change
/// means a peer raced us — Ready / delayed publish must not proceed.
fn assert_connect_control_snapshot_stable(
    expected_generation: u64,
    expected_revision: &str,
    observed: &crate::sync::sync_control::SyncControlV1,
    observed_revision: &str,
) -> Result<(), String> {
    if observed.recovery_lease.is_some() {
        return Err("AUTHORITATIVE_RECOVERY_IN_PROGRESS".to_string());
    }
    if observed.recovery_generation != expected_generation {
        return Err(format!(
            "RECOVERY_CONTROL_CHANGED: generation expected={expected_generation}, observed={}",
            observed.recovery_generation
        ));
    }
    if observed_revision != expected_revision {
        return Err(format!(
            "RECOVERY_CONTROL_CHANGED: revision expected={expected_revision}, observed={observed_revision}"
        ));
    }
    Ok(())
}

/// Post-publish readback: planted meta must match control generation.
fn assert_published_meta_matches_control(
    meta_generation: u64,
    control_generation: u64,
) -> Result<(), String> {
    if meta_generation != control_generation {
        return Err(format!(
            "RECOVERY_GENERATION_MISMATCH: control={control_generation}, keyring_meta={meta_generation}"
        ));
    }
    Ok(())
}

/// Re-read versioned `control.json` and reject if authority moved vs snapshot.
async fn revalidate_connect_control_authority<P>(
    provider: &P,
    expected_generation: u64,
    expected_revision: &str,
) -> Result<(), String>
where
    P: crate::sync::keyring_v2::KeyringV2Io + ?Sized,
{
    let (control, revision) = crate::sync::recovery::read_versioned_sync_control(provider)
        .await
        .map_err(|error| format!("Failed to revalidate cloud recovery control: {error}"))?;
    assert_connect_control_snapshot_stable(
        expected_generation,
        expected_revision,
        &control,
        &revision,
    )
}

/// Local settings always clear on connect folder failure; device namespace is
/// best-effort cleaned when a partial create may have landed on Drive.
fn connect_folder_failure_cleanup_plan() -> (bool, bool) {
    // (clear_local_settings, best_effort_delete_device_namespace)
    (true, true)
}

/// Return the current Google Drive connection status.
///
/// Storage quota fields are read from the cache (populated by
/// `gdrive_complete_connect` and `gdrive_refresh_storage_quota`) so this
/// command stays synchronous and never makes an outbound API call. The
/// frontend triggers `gdrive_refresh_storage_quota` separately when it
/// wants live values.
#[tauri::command]
pub fn gdrive_get_status(
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
) -> Result<GDriveStatus, String> {
    let conn = state.lock()?;
    let status = read_status_snapshot(&conn)?;
    if !status.connected {
        // Also clear any stale in-memory session.
        drop(conn);
        session_state.clear();
    }
    Ok(status)
}

/// Fetch live storage quota from Drive, persist it as a cache so future
/// `gdrive_get_status` calls return a non-zero value, and return the
/// updated status snapshot. Called by the frontend when the Settings panel
/// mounts (after the cheap `gdrive_get_status`) so users see fresh numbers
/// without paying API latency on every status read.
#[tauri::command]
pub async fn gdrive_refresh_storage_quota(
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
) -> Result<GDriveStatus, String> {
    if let Ok(cloud) = acquire_cloud_provider(&state, Some(&session_state)) {
        if cloud.as_gdrive().is_none() {
            return Err("Storage quota is only available for Google Drive".to_string());
        }
    }
    let session = match session_state.get_clone() {
        Some(s) => s,
        None => {
            let s = reconstruct_session(&state)?
                .ok_or_else(|| "Not connected to Google Drive".to_string())?;
            session_state.set(s.clone());
            s
        }
    };
    let provider = GDriveProvider::new_live(session)?;
    // Account-wide quota + email (`about`) — fail the command if the call
    // errors so the UI keeps the last good cache.
    let about = provider
        .fetch_drive_about()
        .await
        .map_err(|e| e.to_string())?;
    let fetched_used = about
        .quota
        .usage
        .as_deref()
        .and_then(|u| u.parse::<u64>().ok());
    let fetched_total = about
        .quota
        .limit
        .as_deref()
        .and_then(|l| l.parse::<u64>().ok());
    let fetched_email = about.email;
    // App-only sum is best-effort: a list failure leaves the previous
    // `storage_app_used` cache in place rather than clearing it.
    let app_used_result = provider.fetch_appdata_usage_bytes().await;
    let conn = state.lock()?;
    // If the user disconnected while the network calls were in flight, do not
    // re-write storage cache into a cleared settings table.
    let still_connected = db::get_setting(&conn, "gdrive_refresh_token")
        .map_err(|e| e.to_string())?
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !still_connected {
        return read_status_snapshot(&conn);
    }
    let (cached_used, cached_total, cached_app) = read_cached_storage_quota(&conn)?;
    // Preserve prior account numbers when `about` omits usage/limit (e.g.
    // unlimited Workspace accounts return no limit field) instead of wiping.
    let storage_used = fetched_used.or(cached_used);
    let storage_total = fetched_total.or(cached_total);
    let storage_app_used = match app_used_result {
        Ok(n) => Some(n),
        Err(e) => {
            log::warn!("gdrive_refresh_storage_quota: appdata usage sum failed: {e}");
            cached_app
        }
    };
    persist_storage_quota(&conn, storage_used, storage_total, storage_app_used)?;
    // Backfill email for sessions connected before about.user was fetched
    // (userinfo never worked without openid/email scopes).
    if let Some(ref email) = fetched_email {
        db::set_setting(&conn, "gdrive_email", email).map_err(|e| e.to_string())?;
    }
    read_status_snapshot(&conn)
}

/// Ping the Drive API with the current access token. Attempts a refresh if
/// the token is expired. On `AUTH_REVOKED`, clears local settings so the
/// next call to `gdrive_get_status` returns `connected: false`.
#[tauri::command]
pub async fn gdrive_test_connection(
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
) -> Result<bool, String> {
    if let Ok(cloud) = acquire_cloud_provider(&state, Some(&session_state)) {
        if cloud.as_gdrive().is_none() {
            return Err("Connection test is only available for Google Drive".to_string());
        }
    }
    let session = match session_state.get_clone() {
        Some(s) => s,
        None => reconstruct_session(&state)?
            .ok_or_else(|| "Not connected to Google Drive".to_string())?,
    };

    let provider = GDriveProvider::new_live(session)?;
    match provider.fetch_user_info().await {
        Ok(_) => Ok(true),
        Err(crate::sync::provider::SyncError::Auth(_)) => {
            // Token revoked server-side — clear local state.
            {
                let conn = state.lock()?;
                let _ = clear_gdrive_settings(&conn);
            }
            session_state.clear();
            Err(format!(
                "{AUTH_REVOKED}: Google Drive token has been revoked. Please reconnect."
            ))
        }
        Err(e) => Err(format!("{NETWORK_ERROR}: {e}")),
    }
}

/// Dev-only repair for a stale/unparseable cloud keyring (e.g. an `_meta.json`
/// written before a schema field like `content_epoch` was added).
///
/// Clearing the force-re-pair flag alone does NOT fix this: on the next unlock
/// `detect_force_re_pair` re-reads the stale `_meta.json`, fails the same parse,
/// and re-sets the flag. So this command does BOTH halves of the repair:
///
/// 1. `KEYRING_DIRTY_KEY=1` — on the next unlock `startup_keyring_reconcile_if_needed`
///    re-uploads the keyring from local truth (regenerating `_meta.json` with the
///    current schema) BEFORE the fingerprint check runs.
/// 2. Delete `FORCE_RE_PAIR_REQUIRED` / `FORCE_RE_PAIR_REASON` — the `Clean` arm
///    of `detect_force_re_pair` never clears these, so a leftover flag would keep
///    push blocked even after the keyring is valid again.
///
/// The caller must restart the app after invoking this so the unlock-time
/// reconcile runs.
///
/// Only compiled in debug builds (`cfg(debug_assertions)`). Not present in
/// production binaries — frontend callers get an "unknown command" error if
/// they somehow invoke this in a release build.
#[cfg(debug_assertions)]
pub(crate) fn gdrive_dev_repair_keyring_inner(conn: &rusqlite::Connection) -> Result<(), String> {
    db::set_setting(conn, db::KEYRING_DIRTY_KEY, "1").map_err(|e| e.to_string())?;
    db::delete_setting(conn, db::FORCE_RE_PAIR_REQUIRED).map_err(|e| e.to_string())?;
    db::delete_setting(conn, db::FORCE_RE_PAIR_REASON).map_err(|e| e.to_string())?;
    log::info!(
        "gdrive_dev_repair_keyring: keyring_dirty set + force-re-pair flags cleared \
         (debug build only) — restart the app to regenerate _meta.json"
    );
    Ok(())
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn gdrive_dev_repair_keyring(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.lock()?;
    gdrive_dev_repair_keyring_inner(&conn)
}

/// Dev-only: fetch the RAW JSON text of every V2 keyring file on the cloud —
/// `_meta.json`, `_recovery.json`, `_content.json`, and every
/// `devices/<id>.json` — concatenated with a path header per file.
///
/// **Why this exists:** requirement 4 (cloud de-grind) claims the cloud device
/// slot carries no key material. Drive `appdata` is not browsable from the web
/// UI, and no UI surfaces raw slot fields, so without this command that claim
/// is only ever provable by automated tests. This closes that gap for a human.
///
/// **Deliberately reads bytes, not typed structs.** Deserializing through
/// `DeviceSlotV2` would hide exactly the unexpected fields this
/// command exists to expose — a tampered or stale slot that still carried
/// `wrapped_master`/`kek_salt` would look perfectly clean after a
/// `serde(deny_unknown_fields)` round-trip failure or field-drop. Reading raw
/// bytes is the only way the absence of those fields is actually visible.
///
/// Security: debug-only via the same two-layer `cfg(debug_assertions)` gate as
/// `gdrive_dev_repair_keyring` (present on both the function and its `lib.rs`
/// registration, so a release build has no such command at all — an invoke
/// attempt gets "unknown command"). Never invoked automatically. Never written
/// to a log file or to disk — returned to the caller only. Returning the
/// dumped blobs is acceptable precisely because they are wrapped ciphertext
/// (or, for device slots after this phase, pure metadata) — never plaintext
/// key material.
#[cfg(debug_assertions)]
pub(crate) async fn gdrive_dev_dump_keyring_inner<P: crate::sync::keyring_v2::KeyringV2Io>(
    provider: &P,
) -> Result<String, String> {
    use crate::sync::keyring_v2::io::{CONTENT_PATH, DEVICES_DIR, META_PATH, RECOVERY_PATH};

    let mut out = String::new();
    let append = |out: &mut String, path: &str, result: Result<Vec<u8>, crate::sync::SyncError>| {
        out.push_str(&format!("=== {path} ===\n"));
        match result {
            Ok(bytes) => out.push_str(&String::from_utf8_lossy(&bytes)),
            Err(e) => out.push_str(&format!("(absent or unreadable: {e})")),
        }
        out.push_str("\n\n");
    };

    for path in [META_PATH, RECOVERY_PATH, CONTENT_PATH] {
        let result = provider.read_file(path).await;
        append(&mut out, path, result);
    }

    let device_paths = provider
        .list_files(DEVICES_DIR)
        .await
        .map_err(|e| format!("gdrive_dev_dump_keyring: list {DEVICES_DIR} failed: {e}"))?;
    for path in device_paths {
        let result = provider.read_file(&path).await;
        append(&mut out, &path, result);
    }

    Ok(out)
}

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn gdrive_dev_dump_keyring(
    state: State<'_, AppState>,
    session_state: State<'_, GDriveSessionState>,
) -> Result<String, String> {
    let provider = acquire_cloud_provider(&state, Some(&session_state))?;
    gdrive_dev_dump_keyring_inner(&provider).await
}

/// Attempt to reconstruct a `GDriveSession` from the encrypted refresh token
/// stored in settings. Returns `None` if no token is stored.
pub fn reconstruct_session(state: &AppState) -> Result<Option<GDriveSession>, String> {
    let conn = state.lock()?;

    let refresh_token =
        match db::get_setting(&conn, "gdrive_refresh_token").map_err(|e| e.to_string())? {
            Some(h) if !h.is_empty() => h,
            _ => return Ok(None),
        };

    let client_id = resolve_client_id(&conn)?;
    let client_secret = resolve_client_secret(&conn)?;

    Ok(Some(GDriveSession {
        access_token: String::new(),
        // Past expiry → `ensure_fresh_token` refreshes immediately.
        expires_at: std::time::Instant::now() - std::time::Duration::from_secs(1),
        refresh_token: zeroize::Zeroizing::new(refresh_token),
        client_id,
        client_secret,
    }))
}

/// Warm in-memory Drive session, else the configured cloud provider
/// (`gdrive` / `icloud` / `local`).
pub(crate) fn acquire_cloud_provider(
    state: &AppState,
    session_state: Option<&GDriveSessionState>,
) -> Result<CloudProvider, String> {
    if let Some(session) = session_state.and_then(|s| s.get_clone()) {
        return GDriveProvider::new_live(session)
            .map(CloudProvider::GDrive)
            .map_err(|e| e.to_string());
    }
    let conn = state.lock()?;
    crate::commands::sync::configured_cloud_provider(&conn)?
        .ok_or_else(|| "No cloud provider connected".to_string())
}

/// Folder providers never hold a Google OAuth token to revoke.
pub(crate) fn disconnect_should_revoke_oauth(provider: Option<&CloudProvider>) -> bool {
    matches!(provider, Some(p) if p.kind() == "gdrive")
}

/// Clear persisted cloud-connect settings and the in-memory Drive session.
pub(crate) fn apply_disconnect_clear(
    state: &AppState,
    session_state: &GDriveSessionState,
) -> Result<(), String> {
    {
        let conn = state.lock()?;
        clear_gdrive_settings(&conn)?;
    }
    session_state.clear();
    Ok(())
}

// ─── Keyring publish helpers ─────────────────────────────────────────────────

/// Extract the v1 content key's `wrapped_content` and `content_fingerprint`
/// from local DB settings so they can be included in `_content.json`.
///
/// `WRAPPED_CONTENT_LIST` stores the compact epoch-list:
/// `[(epoch_u32_be_4bytes)(aes_gcm_60bytes)…]` hex-encoded as a single string.
/// For epoch 1 the first 128 hex chars are: 8 hex (epoch=1) + 120 hex (blob).
/// The 120-hex blob is exactly `AES-GCM(master, v1)` — what `_content.json`
/// calls `wrapped_content`.
///
/// `CLOUD_CONTENT_FINGERPRINT` already holds `key_fingerprint(derive_sync_key(v1))`
/// which equals `content_fingerprint` for epoch 1.
fn extract_v1_content_for_publish(conn: &rusqlite::Connection) -> Result<(String, String), String> {
    // Each slot in the compact list is 128 hex chars (8 epoch + 120 wrapped).
    const SLOT_HEX: usize = 128;
    const EPOCH_HEX: usize = 8;

    let list_hex = db::get_setting(conn, db::WRAPPED_CONTENT_LIST)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "WRAPPED_CONTENT_LIST absent — cannot publish _content.json".to_string())?;

    if list_hex.len() < SLOT_HEX {
        return Err(format!(
            "WRAPPED_CONTENT_LIST too short ({} hex chars, expected >= {SLOT_HEX})",
            list_hex.len()
        ));
    }

    // The list is ordered by ascending epoch. Slot 0 = epoch 1 for a freshly
    // onboarded vault that has never done a content-key rotation.
    let slot0 = &list_hex[..SLOT_HEX];
    let wrapped_content_v1 = slot0[EPOCH_HEX..].to_owned(); // 120 hex chars

    let content_fingerprint_v1 = db::get_setting(conn, db::CLOUD_CONTENT_FINGERPRINT)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            "CLOUD_CONTENT_FINGERPRINT absent — cannot publish _content.json".to_string()
        })?;

    Ok((wrapped_content_v1, content_fingerprint_v1))
}

// ─── Keyring re-upload stubs (TODO Phase 3) ──────────────────────────────────

/// Attempt to re-upload the V2 keyring to Drive using the stored session.
/// Best-effort — callers handle `Err` by setting `keyring_dirty`.
///
/// Reads all necessary key material from local settings, reconstructs the Drive
/// session, and publishes the V2 keyring (`_recovery.json`, `devices/<id>.json`,
/// `_meta.json`). Returns `Err` when Drive is not connected or key material is
/// absent — callers MUST NOT clear `keyring_dirty` on error.
pub(crate) async fn try_reupload_keyring(
    state: &AppState,
    key_state: &EncryptionKeyState,
) -> Result<(), String> {
    // Read all key material and device info from local settings.
    let ctx = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        let devices = db::list_devices(&conn).map_err(|e| e.to_string())?;
        let device = devices
            .into_iter()
            .find(|d| d.is_current)
            .ok_or_else(|| "no current device".to_string())?;
        let recovery_wrapped = db::get_setting(&conn, db::RECOVERY_WRAPPED_MASTER_KEY)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no recovery_wrapped_master".to_string())?;
        let master_fingerprint = db::get_setting(&conn, db::CLOUD_MASTER_FINGERPRINT)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no cloud_master_fingerprint".to_string())?;
        let created_at = db::get_setting(&conn, db::RECOVERY_PASSPHRASE_CREATED_AT)
            .map_err(|e| e.to_string())?
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let (wrapped_content_v1, content_fingerprint_v1) = extract_v1_content_for_publish(&conn)?;
        crate::commands::crypto::V2KeyringPublishContext {
            recovery_wrapped,
            device_id: device.device_id,
            device_name: device.name,
            master_fingerprint,
            created_at,
            device_created_at: device.created_at,
            last_seen_at: device.last_seen_at,
            wrapped_content_v1,
            content_fingerprint_v1,
        }
    };

    let provider = acquire_cloud_provider(state, None)?;

    publish_v2_keyring_with_provider(&provider, state, &ctx, key_state).await
}

/// Re-upload the V2 keyring using a pre-built provider.
///
/// Reads key material from local settings and calls [`publish_v2_keyring_with_provider`].
/// Uploads all three keyring files (meta, recovery, device slot). Used by Phase 5 rotation;
/// for rename-only use `reupload_current_device_slot` which preserves epoch and recovery.
/// Returns `Err` when key material is absent — callers set `keyring_dirty` on error.
#[allow(dead_code)] // Phase 5 rotation will use this for full keyring republish.
pub(crate) async fn try_reupload_keyring_with_provider<P: crate::sync::keyring_v2::KeyringV2Io>(
    state: &AppState,
    provider: &P,
    key_state: &EncryptionKeyState,
) -> Result<(), String> {
    let ctx = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        let devices = db::list_devices(&conn).map_err(|e| e.to_string())?;
        let device = devices
            .into_iter()
            .find(|d| d.is_current)
            .ok_or_else(|| "no current device".to_string())?;
        let recovery_wrapped = db::get_setting(&conn, db::RECOVERY_WRAPPED_MASTER_KEY)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no recovery_wrapped_master".to_string())?;
        let master_fingerprint = db::get_setting(&conn, db::CLOUD_MASTER_FINGERPRINT)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no cloud_master_fingerprint".to_string())?;
        let created_at = db::get_setting(&conn, db::RECOVERY_PASSPHRASE_CREATED_AT)
            .map_err(|e| e.to_string())?
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let (wrapped_content_v1, content_fingerprint_v1) = extract_v1_content_for_publish(&conn)?;
        crate::commands::crypto::V2KeyringPublishContext {
            recovery_wrapped,
            device_id: device.device_id,
            device_name: device.name,
            master_fingerprint,
            created_at,
            device_created_at: device.created_at,
            last_seen_at: device.last_seen_at,
            wrapped_content_v1,
            content_fingerprint_v1,
        }
    };

    publish_v2_keyring_with_provider(provider, state, &ctx, key_state).await
}

/// Write ONLY `devices/<device_id>.json` for the current device after a rename.
///
/// Unlike [`try_reupload_keyring_with_provider`] this does NOT touch
/// `_meta.json` (epoch preserved) or `_recovery.json` (unchanged by rename).
/// It preserves `created_at` from the devices table and sets `last_seen_at` to
/// the provided value (caller passes `now`).
pub(crate) async fn reupload_current_device_slot<P: crate::sync::keyring_v2::KeyringV2Io>(
    state: &AppState,
    provider: &P,
    device_id: &str,
    name: &str,
    created_at: i64,
    last_seen_at: i64,
) -> Result<(), String> {
    use crate::sync::keyring_v2::{
        io::write_device_slot,
        types::{DeviceSlotV2, KEYRING_V2_VERSION},
    };

    // Same primitive-level gate as `publish_v2_keyring_with_provider`: a flagged
    // device must not write ANY keyring file from local truth — recreating a
    // device slot that a peer's rotation removed re-opens the clobber hole. The
    // gate lives here rather than at the callers (`rename_device`, the
    // device-slot-dirty flush, the last-seen republish) so a new caller cannot
    // silently bypass it. Callers' error paths set `device_slot_dirty`, so the
    // upload is retried automatically after the user re-pairs.
    let local_generation = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        if force_re_pair_required(&conn) {
            return Err(
                "reupload_current_device_slot: force-re-pair required — refusing to \
                 write a device slot from unverified local state"
                    .to_string(),
            );
        }
        db::get_sync_recovery_generation(&conn).map_err(|e| e.to_string())?
    };
    provider.configure_recovery_fence(local_generation, None);

    let slot = DeviceSlotV2 {
        version: KEYRING_V2_VERSION,
        device_id: device_id.to_string(),
        name: name.to_string(),
        created_at,
        last_seen_at,
    };
    slot.validate()
        .map_err(|e| format!("reupload_current_device_slot: invalid slot: {e}"))?;
    write_device_slot(provider, &slot)
        .await
        .map_err(|e| format!("reupload_current_device_slot: write failed: {e}"))
}

/// Update `keyring_dirty` based on a completed upload attempt.
/// Clears the flag on success; sets it on failure. Best-effort — never panics.
fn apply_dirty_flag_result(result: Result<(), String>, state: &AppState) {
    match result {
        Ok(()) => {
            if let Ok(c) = state.lock() {
                if let Err(e) = db::delete_setting(&c, db::KEYRING_DIRTY_KEY) {
                    log::warn!("keyring: failed to clear dirty flag: {e}");
                }
            }
            log::info!("keyring: re-upload succeeded, dirty flag cleared");
        }
        Err(e) => {
            log::warn!("keyring: re-upload failed ({e}), setting keyring_dirty for retry");
            if let Ok(c) = state.lock() {
                if let Err(e2) = db::set_setting(&c, db::KEYRING_DIRTY_KEY, "1") {
                    log::warn!("keyring: failed to set dirty flag: {e2}");
                }
            }
        }
    }
}

/// Upload keyring via the live Drive session and update `keyring_dirty`.
/// Called by `change_password` and `run_sync_now` — both need the real provider.
pub(crate) async fn try_reupload_keyring_and_update_dirty_flag(
    state: &AppState,
    key_state: &EncryptionKeyState,
) {
    let result = try_reupload_keyring(state, key_state).await;
    apply_dirty_flag_result(result, state);
}

/// Best-effort V2 keyring publish after `confirm_first_time_setup`.
///
/// Called when Drive is already connected at the moment the user completes
/// the recovery-phrase confirmation. Uploads `_recovery.json`,
/// `devices/<id>.json`, and `_meta.json` (in crash-safe order).
///
/// All errors are logged but swallowed — the local encryption state was
/// already committed. If this upload fails, `KEYRING_DIRTY_KEY` is set so
/// a subsequent sync retries automatically. If the session cannot be
/// reconstructed (Drive disconnected since the wizard started), the dirty
/// flag is set and the function returns early — local setup still succeeds.
pub(crate) async fn try_publish_v2_keyring_after_setup(
    state: &AppState,
    key_state: &EncryptionKeyState,
    ctx: crate::commands::crypto::V2KeyringPublishContext,
) {
    let provider = match acquire_cloud_provider(state, None) {
        Ok(p) => p,
        Err(e) => {
            log::warn!(
                "try_publish_v2_keyring_after_setup: no cloud provider ({e}) — \
                 marking keyring_dirty for retry"
            );
            if let Ok(conn) = state.lock() {
                let _ = db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1");
            }
            return;
        }
    };

    let result = publish_v2_keyring_with_provider(&provider, state, &ctx, key_state).await;

    match result {
        Ok(()) => {
            log::info!("try_publish_v2_keyring_after_setup: V2 keyring published successfully");
            if let Ok(conn) = state.lock() {
                let _ = db::delete_setting(&conn, db::KEYRING_DIRTY_KEY);
            }
        }
        Err(e) => {
            log::warn!(
                "try_publish_v2_keyring_after_setup: publish failed ({e}) — \
                 marking keyring_dirty for retry"
            );
            if let Ok(conn) = state.lock() {
                let _ = db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1");
            }
        }
    }
}

/// Build V2 keyring structs from a [`V2KeyringPublishContext`] and publish
/// them via the given provider in crash-safe order
/// (`_recovery.json` → `devices/<id>.json` → `_meta.json`).
///
/// C2: Refuses if an active rotation job is present — between PRAGMA rekey and
/// the settings transaction, settings still point to K_old.  Publishing then
/// would push a stale device slot to the cloud.  When refused, the caller's
/// `keyring_dirty` flag stays set so the publish is automatically retried after
/// the rotation completes.
///
/// F1 fix: When `key_state` is initialized with the full content-key list the
/// function reads `WRAPPED_CONTENT_LIST` and `CONTENT_KEY_EPOCH` from the DB and
/// publishes **all** epochs to `_content.json`.  This prevents a password-change
/// or keyring-dirty re-upload from rolling back the cloud content-key history to
/// epoch 1 after a rotation.  When `key_state` is not yet initialized (initial
/// first-time-setup path, or tests that create a fresh state), it falls back to
/// the epoch-1 data carried in `ctx`.
///
/// Extracted so tests can exercise the full publish path with an
/// [`InMemoryKeyringProvider`] without needing a real GDrive session.
pub(crate) async fn publish_v2_keyring_with_provider<P>(
    provider: &P,
    state: &AppState,
    ctx: &crate::commands::crypto::V2KeyringPublishContext,
    key_state: &EncryptionKeyState,
) -> Result<(), String>
where
    P: crate::sync::keyring_v2::KeyringV2Io,
{
    publish_v2_keyring_with_provider_for_generation(provider, state, ctx, key_state, None).await
}

/// Like [`publish_v2_keyring_with_provider`], but may pin recovery generation.
///
/// Pass `Some(candidate)` during connect delayed-publish when the cloud control
/// generation is already N but the local DB has not adopted N yet. Without
/// this, `_meta.json` would be planted at local `0` and every subsequent
/// joiner / force-re-pair would see `RECOVERY_GENERATION_MISMATCH`.
pub(crate) async fn publish_v2_keyring_with_provider_for_generation<P>(
    provider: &P,
    state: &AppState,
    ctx: &crate::commands::crypto::V2KeyringPublishContext,
    key_state: &EncryptionKeyState,
    recovery_generation_override: Option<u64>,
) -> Result<(), String>
where
    P: crate::sync::keyring_v2::KeyringV2Io,
{
    let local_generation = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        db::get_sync_recovery_generation(&conn).map_err(|e| e.to_string())?
    };
    let publish_generation =
        resolve_keyring_publish_generation(local_generation, recovery_generation_override);
    provider.configure_recovery_fence(publish_generation, None);

    // C2: Do not publish while a rotation is in progress.
    // Also refuse when force-re-pair is required: this device's key material is
    // not known to match the cloud vault, and every write below comes from LOCAL
    // truth with no epoch/CAS precondition — publishing would clobber a peer's
    // rotation and roll `_meta.json` back to this device's stale epoch.
    //
    // The gate lives here, in the primitive, rather than at the callers: the
    // caller set (`change_password`, `rename_device`, the keyring-dirty retry,
    // the "no cloud keyring" reconnect branch) is easy to extend and each new
    // caller would otherwise silently reopen the hole.
    //
    // `complete_force_re_pair` is unaffected — it publishes via
    // `onboard_complete_inner` → `kio::write_meta`, not through this primitive —
    // so the legitimate recovery path is not gated by the flag it clears.
    {
        let conn = state.lock().map_err(|e| e.to_string())?;
        if db::has_active_rotation_job(&conn).map_err(|e| e.to_string())? {
            log::warn!(
                "publish_v2_keyring_with_provider: rotation active, refusing to publish device slot"
            );
            return Err("Cannot publish keyring while a rotation is in progress. \
                 Complete or resume the rotation first."
                .to_string());
        }
        if force_re_pair_required(&conn) {
            log::warn!(
                "publish_v2_keyring_with_provider: force-re-pair required, refusing to publish \
                 — this device must not overwrite the cloud keyring from stale local state"
            );
            return Err("Cannot publish keyring while re-pair is required. \
                 Re-pair this device first."
                .to_string());
        }
    }

    use crate::sync::keyring_v2::{
        builder::publish_initial_v2_keyring,
        io::write_content,
        types::{
            ContentEntryV2, ContentListV2, DeviceSlotV2, KeyringMetaV2, RecoverySlotV2,
            KEYRING_V2_VERSION,
        },
    };
    use crate::utils::encryption::key_fingerprint;

    let recovery_slot = RecoverySlotV2 {
        version: KEYRING_V2_VERSION,
        wrapped_master: ctx.recovery_wrapped.clone(),
        created_at: ctx.created_at,
    };

    let device_slot = DeviceSlotV2 {
        version: KEYRING_V2_VERSION,
        device_id: ctx.device_id.clone(),
        name: ctx.device_name.clone(),
        created_at: ctx.device_created_at,
        last_seen_at: ctx.last_seen_at,
    };

    // Build the content list.  When key_state is fully initialized, read the
    // complete WRAPPED_CONTENT_LIST from the DB so all epochs survive the
    // re-upload.  When not (initial setup / tests with fresh state), fall back
    // to the epoch-1 data in ctx — the DB may not yet hold WRAPPED_CONTENT_LIST.
    const SLOT_HEX: usize = 128;
    const EPOCH_HEX: usize = 8;

    let (content_list, content_epoch) = if key_state.is_initialized().unwrap_or(false) {
        // Full path: read every slot from the DB, compute per-epoch fingerprints.
        let (list_hex, db_content_epoch) = {
            let conn = state.lock().map_err(|e| e.to_string())?;
            let hex = db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
                .map_err(|e| e.to_string())?
                .filter(|s| !s.is_empty());
            let epoch = db::get_setting(&conn, db::CONTENT_KEY_EPOCH)
                .map_err(|e| e.to_string())?
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(1);
            (hex, epoch)
        };

        match list_hex {
            Some(hex) if hex.len() >= SLOT_HEX && hex.len() % SLOT_HEX == 0 => {
                let n_slots = hex.len() / SLOT_HEX;
                let mut entries = Vec::with_capacity(n_slots);
                for i in 0..n_slots {
                    let slot = &hex[i * SLOT_HEX..(i + 1) * SLOT_HEX];
                    let epoch_bytes = hex::decode(&slot[..EPOCH_HEX]).map_err(|e| {
                        format!("publish_v2_keyring: bad epoch hex in slot {i}: {e}")
                    })?;
                    if epoch_bytes.len() != 4 {
                        return Err(format!(
                            "publish_v2_keyring: epoch bytes wrong length in slot {i}"
                        ));
                    }
                    let epoch = u32::from_be_bytes([
                        epoch_bytes[0],
                        epoch_bytes[1],
                        epoch_bytes[2],
                        epoch_bytes[3],
                    ]);
                    let wrapped_hex = slot[EPOCH_HEX..].to_owned();
                    // Fingerprint: key_fingerprint(derive_sync_key(content_key)) —
                    // matching the reader formula used everywhere else.
                    let fp_hex = key_state
                        .with_sync_key_for_epoch(epoch, |k| Ok(hex::encode(key_fingerprint(k))))
                        .map_err(|e| {
                            format!(
                                "publish_v2_keyring: cannot compute fingerprint for epoch {epoch}: {e}"
                            )
                        })?;
                    entries.push(ContentEntryV2 {
                        epoch,
                        wrapped_content: wrapped_hex,
                        content_fingerprint: fp_hex,
                    });
                }
                let latest_epoch = entries.last().map(|e| e.epoch).unwrap_or(db_content_epoch);
                let cl = ContentListV2 {
                    version: KEYRING_V2_VERSION,
                    latest_epoch,
                    entries,
                    created_at: ctx.created_at,
                };
                (cl, db_content_epoch)
            }
            _ => {
                // DB has no list yet — fall back to epoch-1 from ctx.
                log::debug!(
                    "publish_v2_keyring_with_provider: WRAPPED_CONTENT_LIST absent/invalid, \
                     using ctx epoch-1 fallback"
                );
                let cl = ContentListV2 {
                    version: KEYRING_V2_VERSION,
                    latest_epoch: 1,
                    entries: vec![ContentEntryV2 {
                        epoch: 1,
                        wrapped_content: ctx.wrapped_content_v1.clone(),
                        content_fingerprint: ctx.content_fingerprint_v1.clone(),
                    }],
                    created_at: ctx.created_at,
                };
                (cl, 1u32)
            }
        }
    } else {
        // key_state not initialized (initial setup or no-encryption mode): use
        // the epoch-1 data from ctx.
        let cl = ContentListV2 {
            version: KEYRING_V2_VERSION,
            latest_epoch: 1,
            entries: vec![ContentEntryV2 {
                epoch: 1,
                wrapped_content: ctx.wrapped_content_v1.clone(),
                content_fingerprint: ctx.content_fingerprint_v1.clone(),
            }],
            created_at: ctx.created_at,
        };
        (cl, 1u32)
    };

    // Read the master-key epoch (rotation counter) from local settings for
    // _meta.json.  Default to 1 when absent (fresh vault / initial setup).
    // Recovery generation uses `publish_generation` (override or local) so a
    // connect-time candidate is never clobbered by stale local 0.
    let master_epoch: u64 = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        db::get_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH)
            .map_err(|e| e.to_string())?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(1)
    };
    let recovery_generation = publish_generation;

    let meta = KeyringMetaV2 {
        version: KEYRING_V2_VERSION,
        epoch: master_epoch,
        master_fingerprint: ctx.master_fingerprint.clone(),
        content_epoch,
        recovery_generation,
        created_at: ctx.created_at,
        updated_at: ctx.created_at,
    };

    // I1: write _content.json BEFORE _meta.json so that if we crash between
    // content-write and meta-write the joiner still sees a consistent state:
    // no _meta.json → joiner retries later; _content.json present but no
    // _meta.json → content is orphaned until meta is written.  Writing after
    // _meta.json would mean a joiner that reads _meta.json (content_epoch=1) but
    // finds no _content.json would fall back to v1=master → decryption failure.
    write_content(provider, &content_list)
        .await
        .map_err(|e| format!("publish_v2_keyring: write _content.json failed: {e}"))?;

    publish_initial_v2_keyring(provider, &recovery_slot, &device_slot, &meta)
        .await
        .map_err(|e| e.to_string())
}

/// Best-effort startup keyring reconcile (no-op stub — Phase 3).
///
/// In Phase 2, V2 keyring reconcile on startup is not yet implemented.
/// Phase 3 will re-implement this against the V2 keyring layout
/// (`_meta.json` + `devices/<id>.json`).
pub(crate) async fn startup_keyring_reconcile_if_needed(
    state: &AppState,
    key_state: &EncryptionKeyState,
    app: &AppHandle,
) {
    // Reconstruct the configured provider. If unavailable, skip silently —
    // reconcile is best-effort at unlock time.
    let provider = match acquire_cloud_provider(state, None) {
        Ok(p) => p,
        Err(e) => {
            log::info!("startup_keyring_reconcile_if_needed: no cloud provider ({e}), skipping");
            return;
        }
    };

    // Check for pending keyring dirty flag first.
    let (keyring_dirty, re_pair_required) = {
        match state.lock() {
            Ok(conn) => (
                db::get_setting(&conn, db::KEYRING_DIRTY_KEY)
                    .ok()
                    .flatten()
                    .map(|v| v == "1")
                    .unwrap_or(false),
                force_re_pair_required(&conn),
            ),
            // Fail-closed on lock failure: skip the re-upload rather than publish
            // from a device whose flag state we could not read.
            Err(_) => (false, true),
        }
    };
    // A flagged device must not publish its keyring. `try_reupload_keyring_with_provider`
    // writes `_meta.json` from LOCAL truth with no epoch/CAS guard, so re-uploading here
    // would clobber a peer's rotation and make the fingerprint check below (and any later
    // `recheck_force_re_pair`) compare against this device's own write — turning a genuine
    // `vault_rotated` mismatch into a false `Verified`. The flag does not gate unlock in
    // password mode (the pre-unlock DB is an empty placeholder — see `lib.rs`), so this
    // path really does run with the flag set; the gate is load-bearing, not defensive.
    // Pre-detected rotation from the dirty pre-flight below; routed into the
    // main match so the NeedsRepair handling is not duplicated.
    let mut pre_detected: Option<ForceRePairMismatch> = None;

    if keyring_dirty && re_pair_required {
        log::warn!(
            "startup_keyring_reconcile_if_needed: keyring_dirty set but force-re-pair is \
             required — skipping re-upload so this device cannot clobber the cloud keyring"
        );
    } else if keyring_dirty {
        // Pre-flight: a peer rotation this device has NOT yet observed (flag
        // still unset) must be detected BEFORE the re-upload — the re-upload
        // writes `_meta.json` from local truth with no CAS, so it would
        // clobber the rotation and the fingerprint check below would verify
        // against our own write. Only a typed `Mismatch` aborts the re-upload:
        // a corrupt `_meta.json` must still flow into it, because the dirty
        // re-upload is the only path that can regenerate a schema-broken meta
        // from local truth (failing closed on corrupt before the repair would
        // deadlock it).
        match detect_force_re_pair(&provider, state).await {
            Ok(ForceRePairCheck::Mismatch(mismatch)) => {
                log::warn!(
                    "startup_keyring_reconcile_if_needed: rotation detected before dirty \
                     re-upload ({}) — skipping re-upload",
                    mismatch.reason
                );
                pre_detected = Some(mismatch);
            }
            _ => {
                log::info!(
                    "startup_keyring_reconcile_if_needed: keyring_dirty set, attempting re-upload"
                );
                let result = try_reupload_keyring_with_provider(state, &provider, key_state).await;
                apply_dirty_flag_result(result, state);
            }
        }
    }

    // Phase 5: fingerprint check — detect vault rotation by another device.
    let decision = match pre_detected {
        Some(mismatch) => ForceRePairDecision::NeedsRepair(mismatch),
        None => resolve_force_re_pair_outcome(detect_force_re_pair(&provider, state).await),
    };
    match decision {
        ForceRePairDecision::NeedsRepair(mismatch) => {
            log::warn!(
                "startup_keyring_reconcile_if_needed: force re-pair required — {}",
                mismatch.reason
            );
            // This function returns (), so a flag-write failure can only be
            // logged — loudly, since push is NOT blocked if the write failed.
            match state.lock() {
                Ok(conn) => {
                    if let Err(e) = set_force_re_pair_flags(&conn, &mismatch.reason) {
                        log::error!(
                            "CRITICAL: startup_keyring_reconcile_if_needed: failed to persist \
                             force-re-pair flags — push may not be blocked: {e}"
                        );
                    }
                }
                Err(e) => {
                    log::error!(
                        "CRITICAL: startup_keyring_reconcile_if_needed: state lock failed while \
                         persisting force-re-pair flags — push may not be blocked: {e}"
                    );
                }
            }
            // Emit the Tauri event so the frontend reacts immediately. This is
            // load-bearing now that reconcile runs deferred (fire-and-forget)
            // after unlock resolves: the UI may already have mounted and
            // hydrated `force_re_pair_required` before this flag was written,
            // so without the event a mismatch would only surface on next
            // restart. The `useForceRePair` listener handles `xj://force-re-pair`.
            if let Err(e) = app.emit(
                "xj://force-re-pair",
                ForceRePairPayload {
                    reason: mismatch.reason,
                },
            ) {
                log::warn!(
                    "startup_keyring_reconcile_if_needed: emit xj://force-re-pair failed: {e}"
                );
            }
        }
        ForceRePairDecision::Verified => {
            log::info!("startup_keyring_reconcile_if_needed: fingerprint OK");
            // Deliberately does NOT clear a stale force-re-pair flag, even though
            // the fingerprint matched. The `keyring_dirty` re-upload above may have
            // just rewritten cloud `_meta.json` from local truth, so `Verified` here
            // can mean "this device verified against its own write" — clearing on
            // that would erase a legitimate `vault_rotated` flag (fail-open).
            // Stale-flag recovery lives in `recheck_force_re_pair`, which performs a
            // detect-only check with no re-upload ahead of it.
        }
        ForceRePairDecision::Skipped => {
            // Nothing to compare (no cloud keyring, or setup incomplete). Not a
            // verification — absence of a keyring is not proof the vault is healthy.
            log::info!("startup_keyring_reconcile_if_needed: fingerprint check skipped");
        }
        ForceRePairDecision::Inconclusive {
            message: e,
            is_auth,
        } => {
            // Fail-closed: an inconclusive check at startup must not let this
            // device proceed with push on an unverified keyring.  Set the
            // FORCE_RE_PAIR_REQUIRED flag so ensure_safe_to_push blocks until
            // the user re-pairs.  This function returns (), so we rely on the
            // loud log inside apply_inconclusive_force_re_pair for visibility.
            log::error!(
                "startup_keyring_reconcile_if_needed: fingerprint check inconclusive ({e})"
            );
            // Dead Drive auth is not a keyring-integrity signal — sending the user
            // to the mnemonic re-pair screen would be both wrong and inescapable
            // (every retry fails auth identically and re-sets the flag). The
            // existing GDRIVE_TOKEN_REVOKED reconnect prompt is the right recovery.
            // Push is already unreachable without a valid token.
            if is_auth {
                log::warn!(
                    "startup_keyring_reconcile_if_needed: Drive auth is revoked/expired — \
                     reconnect required, NOT force-re-pair; leaving the flag untouched"
                );
                return;
            }
            log::error!(
                "startup_keyring_reconcile_if_needed: blocking push until re-pair succeeds \
                 (fail-closed)"
            );
            if let Ok(conn) = state.lock() {
                if let Err(write_err) =
                    apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive")
                {
                    log::error!(
                        "startup_keyring_reconcile_if_needed: could not write fail-closed flag \
                         — push may NOT be blocked: {write_err}"
                    );
                }
            }
        }
    }
}

/// Result from `detect_force_re_pair` when a mismatch is found.
#[derive(Debug)]
pub(crate) struct ForceRePairMismatch {
    pub reason: String,
    pub cloud_epoch: u64,
}

/// Non-error outcome of [`detect_force_re_pair`].
///
/// `Verified` and `Skipped` are kept apart because only `Verified` is a
/// positive statement about the keyring.  Collapsing both into "clean" is what
/// makes clearing the fail-closed flag unsafe: a missing `_meta.json` would
/// look identical to a fingerprint that actually matched.
#[derive(Debug)]
pub(crate) enum ForceRePairCheck {
    /// Cloud fingerprint matched local truth AND epochs were equal.  This is
    /// the only outcome that proves the vault is in sync.
    Verified,
    /// Nothing to compare — no cloud keyring exists yet, or this device has no
    /// local fingerprint (setup incomplete).  NOT a verification: the keyring
    /// may still be rotated.  Callers must not treat this as proof of health.
    Skipped,
    /// Cloud vault was rotated; user must re-pair.
    Mismatch(ForceRePairMismatch),
}

/// Decision produced by [`resolve_force_re_pair_outcome`].
///
/// Separating this from the async I/O makes the routing logic unit-testable
/// without requiring a real Drive provider.
pub(crate) enum ForceRePairDecision {
    /// `Ok(Verified)` — fingerprints match; normal reconnect may proceed AND a
    /// stale flag may be cleared (see [`clear_force_re_pair`]).
    Verified,
    /// `Ok(Skipped)` — no comparison was possible.  Reconnect may proceed, but
    /// an existing flag MUST be left in place.
    Skipped,
    /// `Ok(Mismatch(_))` — cloud vault was rotated; user must re-pair.
    NeedsRepair(ForceRePairMismatch),
    /// `Err(_)` — keyring check was inconclusive (I/O failure).
    ///
    /// Fail-closed: treated as a hard error so an unverified keyring cannot
    /// reach a pushable connected state.  The caller must set
    /// `FORCE_RE_PAIR_REQUIRED=1` to block push until the user re-pairs.
    ///
    /// `is_auth` carries the TYPED [`SyncError::Auth`] verdict from
    /// [`DetectError`] — dead credentials say nothing about vault integrity, so
    /// that case routes to "reconnect Drive" instead of the mnemonic re-pair.
    /// It must never be re-derived by substring-matching `message`, which
    /// embeds cloud-controlled text.
    Inconclusive { message: String, is_auth: bool },
}

/// Map the raw `detect_force_re_pair` result to a [`ForceRePairDecision`].
///
/// This is a pure function with no side effects.  Callers are responsible for
/// acting on the decision (setting DB flags, emitting events, returning errors).
pub(crate) fn resolve_force_re_pair_outcome(
    result: Result<ForceRePairCheck, DetectError>,
) -> ForceRePairDecision {
    match result {
        Ok(ForceRePairCheck::Verified) => ForceRePairDecision::Verified,
        Ok(ForceRePairCheck::Skipped) => ForceRePairDecision::Skipped,
        Ok(ForceRePairCheck::Mismatch(mismatch)) => ForceRePairDecision::NeedsRepair(mismatch),
        Err(e) => ForceRePairDecision::Inconclusive {
            message: e.message,
            is_auth: e.is_auth,
        },
    }
}

/// Persist the `FORCE_RE_PAIR_REQUIRED=1` flag and reason that block push
/// after an `Inconclusive` keyring check.
///
/// This is the load-bearing fail-closed side-effect shared by every call site
/// that handles [`ForceRePairDecision::Inconclusive`].  Extracting it means:
/// - Both call sites inherit loud-error-on-write-failure for free.
/// - A test can call this directly: deleting the production writes breaks the
///   test, proving the flag is actually set (not just replicated in the test).
///
/// Returns `Err` when either `set_setting` write fails so callers that CAN
/// propagate (e.g. Tauri commands returning `Result<_, String>`) do so, making
/// the failure visible in the command error path as well as the log.
pub(crate) fn apply_inconclusive_force_re_pair(
    conn: &rusqlite::Connection,
    reason: &str,
) -> Result<(), String> {
    // Never downgrade a `vault_rotated` reason. The reason is provenance, not a
    // status line: `recheck_force_re_pair` clears an auth-failed flag only when
    // the reason is `keyring_check_inconclusive`, so overwriting a rotation
    // reason here would let the sequence
    //   vault_rotated → one inconclusive check → auth failure → clear
    // erase protection for a vault that really did move.
    if reason == "keyring_check_inconclusive" {
        let existing = db::get_setting(conn, db::FORCE_RE_PAIR_REASON)
            .map_err(|e| format!("apply_inconclusive_force_re_pair: read reason: {e}"))?;
        if existing.as_deref() == Some("vault_rotated") {
            log::warn!(
                "apply_inconclusive_force_re_pair: keeping existing vault_rotated reason \
                 (an inconclusive check must not downgrade a known rotation)"
            );
            return db::set_setting(conn, db::FORCE_RE_PAIR_REQUIRED, "1").map_err(|e| {
                let msg = format!("CRITICAL: failed to set FORCE_RE_PAIR_REQUIRED: {e}");
                log::error!("{msg}");
                msg
            });
        }
    }
    set_force_re_pair_flags(conn, reason).map_err(|e| {
        let msg = format!(
            "CRITICAL: failed to write fail-closed force-re-pair flags — \
             push may not be blocked: {e}"
        );
        log::error!("{msg}");
        msg
    })
}

/// Persist `FORCE_RE_PAIR_REQUIRED=1` and `FORCE_RE_PAIR_REASON` in ONE
/// transaction.
///
/// Every mismatch writer used to issue the two `set_setting` calls as separate
/// autocommit writes; a failure between them left the flag set with a stale
/// reason (or a fresh reason without the flag). Both rows move together or not
/// at all — the write-side mirror of [`clear_force_re_pair`].
pub(crate) fn set_force_re_pair_flags(
    conn: &rusqlite::Connection,
    reason: &str,
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("set_force_re_pair_flags: begin: {e}"))?;
    let result = db::set_setting(conn, db::FORCE_RE_PAIR_REQUIRED, "1")
        .map_err(|e| format!("set_force_re_pair_flags: set FORCE_RE_PAIR_REQUIRED: {e}"))
        .and_then(|_| {
            db::set_setting(conn, db::FORCE_RE_PAIR_REASON, reason)
                .map_err(|e| format!("set_force_re_pair_flags: set FORCE_RE_PAIR_REASON: {e}"))
        });
    match result {
        // Same COMMIT-failure discipline as `clear_force_re_pair`: a failed
        // COMMIT leaves the transaction open on this shared connection, so roll
        // back rather than let later reads see half-applied writes.
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| {
            if let Err(rb) = conn.execute_batch("ROLLBACK") {
                log::error!("set_force_re_pair_flags: rollback after failed commit failed: {rb}");
            }
            format!("set_force_re_pair_flags: commit: {e}")
        }),
        Err(e) => {
            if let Err(rb) = conn.execute_batch("ROLLBACK") {
                log::error!("set_force_re_pair_flags: rollback failed: {rb}");
            }
            Err(e)
        }
    }
}

/// Why a keyring check could not reach a verdict.
///
/// `is_auth` is derived from the TYPED [`SyncError::Auth`] variant, never from
/// substring-matching the rendered message.  That distinction is load-bearing:
/// the message embeds cloud-controlled data (`KeyringMetaV2` uses
/// `deny_unknown_fields`, so serde echoes an attacker-chosen field name into the
/// error), and a `_meta.json` carrying a field named `GDRIVE_TOKEN_REVOKED` would
/// otherwise be misread as "auth is dead" and skip the fail-closed flag while the
/// token was still valid — letting push proceed on an unverified keyring.
#[derive(Debug)]
pub(crate) struct DetectError {
    pub message: String,
    /// True only for [`SyncError::Auth`] — Drive rejected our credentials.
    pub is_auth: bool,
    /// True only for [`SyncError::Serialization`] on the `_meta.json` read —
    /// the file EXISTS but is unparseable or semantically invalid. Unlike a
    /// network blip this is a positive integrity signal, so the best-effort
    /// sync pull leg treats it as fail-closed instead of swallowing it.
    pub is_corrupt: bool,
}

impl DetectError {
    /// Non-auth failure (I/O, serialization, state lock). Fail-closed.
    fn other(message: String) -> Self {
        Self {
            message,
            is_auth: false,
            is_corrupt: false,
        }
    }
}

impl From<String> for DetectError {
    fn from(message: String) -> Self {
        Self::other(message)
    }
}

/// Whether `FORCE_RE_PAIR_REQUIRED` is currently set.
///
/// Read errors are reported as `true` (fail-closed): callers use this to decide
/// whether to withhold a cloud write, and "we could not tell" must not authorize
/// the write.
pub(crate) fn force_re_pair_required(conn: &rusqlite::Connection) -> bool {
    match db::get_setting(conn, db::FORCE_RE_PAIR_REQUIRED) {
        Ok(v) => v.as_deref() == Some("1"),
        Err(e) => {
            log::error!("force_re_pair_required: read failed ({e}) — assuming required");
            true
        }
    }
}

/// Clear the force-re-pair flags after a *positively verified* keyring check.
///
/// Only call this from a [`ForceRePairDecision::Verified`] arm reached WITHOUT a
/// preceding keyring re-upload — see [`recheck_force_re_pair`].  Two ways to get
/// this wrong, both fail-open:
///
/// - Clearing on [`ForceRePairDecision::Skipped`]: "no cloud `_meta.json`" and
///   "no local fingerprint" are not proof the vault is in sync, so a legitimate
///   `vault_rotated` flag could be wiped by a transient absence.
/// - Clearing on a `Verified` that follows a `keyring_dirty` re-upload: the
///   re-upload rewrites cloud `_meta.json` from local truth, so the device would
///   be verifying against its own write.  That is why the reconcile arms in
///   `startup_keyring_reconcile_if_needed` deliberately do NOT clear.
///
/// Given those two rules, clearing is safe regardless of which reason originally
/// set the flag: a real mismatch cannot reach `Verified` against uncorrupted
/// cloud state, because a differing fingerprint or newer cloud epoch routes to
/// `Mismatch` in `detect_force_re_pair`.
///
/// Without this, the fail-closed flag set by an `Inconclusive` check (e.g. a
/// transient Drive I/O error) would be sticky forever — the user would be stuck
/// on the re-pair screen even after connectivity recovered.
/// Both deletes run in one transaction. Two autocommit deletes could drop
/// `FORCE_RE_PAIR_REQUIRED` (the push guard) and then fail on the reason, leaving
/// push unblocked while the command reports an error — the flags must move
/// together or not at all.
pub(crate) fn clear_force_re_pair(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("clear_force_re_pair: begin: {e}"))?;
    let result = db::delete_setting(conn, db::FORCE_RE_PAIR_REQUIRED)
        .map_err(|e| format!("clear_force_re_pair: delete FORCE_RE_PAIR_REQUIRED: {e}"))
        .and_then(|_| {
            db::delete_setting(conn, db::FORCE_RE_PAIR_REASON)
                .map_err(|e| format!("clear_force_re_pair: delete FORCE_RE_PAIR_REASON: {e}"))
        });
    match result {
        // A failed COMMIT leaves the transaction open, and this same connection
        // would then read the deletes as applied — push unblocked while the caller
        // was told the clear failed. Roll back so the guard is restored.
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| {
            if let Err(rb) = conn.execute_batch("ROLLBACK") {
                log::error!("clear_force_re_pair: rollback after failed commit failed: {rb}");
            }
            format!("clear_force_re_pair: commit: {e}")
        }),
        Err(e) => {
            if let Err(rb) = conn.execute_batch("ROLLBACK") {
                log::error!("clear_force_re_pair: rollback failed: {rb}");
            }
            Err(e)
        }
    }
}

/// Clear a stale `keyring_check_inconclusive` flag when the cloud holds no
/// COMMITTED keyring.  Returns `true` when a flag was cleared.
///
/// `cloud_keyring_present` must come from a typed `NotFound` on `_meta.json` read
/// with a live token — `gdrive_complete_connect` establishes exactly that at its
/// probe, where auth/network/quota failures return `Err` and abort the connect
/// instead. "Couldn't read the keyring" must never arrive here as `false`. The
/// flag is taken as a parameter rather than re-probed so that a caller holding a
/// present keyring cannot reach the clear at all.
///
/// Precise about what absence proves: `builder::publish_initial_v2_keyring` writes
/// `_meta.json` LAST, as the commit marker, so its absence means "no committed
/// keyring" — not "the folder is empty". A peer mid-initial-publish may already
/// have written `_recovery.json` and a device slot. That race exists today for
/// every unflagged device (which takes this same publish branch with no gate at
/// all) and is tracked as the missing-CAS root cause in
/// `docs/plans/2026-07-14-keyring-fail-open-findings.md`. This function does not
/// widen the race window or its mechanism; it does let one more class of device
/// (inconclusive-flagged ones, previously deadlocked) into a race unflagged
/// devices already run.
///
/// Not fail-open. The publish gate in `publish_v2_keyring_with_provider` exists to
/// stop a stale device from clobbering a peer's rotation — and a COMMITTED peer
/// rotation always lands `_meta.json`, so it routes to the reconcile branch and is
/// still caught there as `vault_rotated`. What is left here has no committed peer
/// state to clobber, so the gate protects nothing while blocking the only path
/// that rebuilds the vault. Without this, a device whose flag was written by a dead
/// OAuth token can never recover once the cloud keyring is gone: publish is gated,
/// the recheck reads no `_meta.json` and returns `Skipped`, and the mnemonic
/// re-pair needs a `_recovery.json` that no longer exists.
///
/// Allowlist, not denylist: only the exact reason `keyring_check_inconclusive` is
/// cleared, so an unknown or misspelled reason fails closed. `vault_rotated` in
/// particular stays put — a peer really did move the vault, and this device's key
/// material is known-stale whatever the cloud currently holds.
pub(crate) fn clear_stale_flag_for_empty_cloud(
    conn: &rusqlite::Connection,
    cloud_keyring_present: bool,
) -> Result<bool, String> {
    if cloud_keyring_present {
        return Ok(false);
    }
    if !force_re_pair_required(conn) {
        return Ok(false);
    }
    let reason = db::get_setting(conn, db::FORCE_RE_PAIR_REASON)
        .map_err(|e| format!("clear_stale_flag_for_empty_cloud: read reason: {e}"))?;
    if reason.as_deref() != Some("keyring_check_inconclusive") {
        log::warn!(
            "clear_stale_flag_for_empty_cloud: cloud keyring absent but flag reason is {reason:?} \
             — leaving the flag in place"
        );
        return Ok(false);
    }
    clear_force_re_pair(conn)?;
    log::warn!(
        "clear_stale_flag_for_empty_cloud: cloud keyring is absent and the flag came from an \
         inconclusive check — clearing it so this device can republish the vault"
    );
    Ok(true)
}

/// Re-check the cloud keyring and clear a stale force-re-pair flag if — and only
/// if — the fingerprint positively verifies.
///
/// This is the recovery path for a flag written by an `Inconclusive` check (a
/// transient Drive I/O error).  Such a flag is otherwise permanent: the reconcile
/// arms deliberately never clear it, and only `complete_force_re_pair` (which
/// demands the 24-word mnemonic) does — a heavy price for what may be one dropped
/// network read.  `ForceRePairScreen` calls this on mount so a stale flag
/// self-dismisses.
///
/// Detect-only by design: unlike `startup_keyring_reconcile_if_needed`, this does
/// NOT re-upload the keyring first.  A re-upload rewrites cloud `_meta.json` from
/// local truth, so the comparison would verify against this device's own write and
/// clear a legitimate `vault_rotated` flag.
///
/// That protects this call, but not the session: `startup_keyring_reconcile_if_needed`
/// runs at unlock and could re-upload before this ever executes.  The re-upload is
/// therefore gated on the flag there — both halves are needed for the clear to be
/// sound.  Nothing may write to the cloud keyring while the flag stands.
///
/// Returns `true` when the flag was cleared (vault verified in sync), `false` when
/// the flag stands (genuine rotation, or nothing to compare).  `Err` on I/O
/// failure — fail-closed: the caller keeps showing the re-pair screen.
#[tauri::command]
pub async fn recheck_force_re_pair(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    use tauri::Manager;
    // Prefer the warm in-process session, then the configured provider —
    // the same lookup order as `acquire_cloud_provider`.
    // Reading only the DB row would return "flag stands" on a device whose
    // token row is gone but whose in-memory session could still run the check.
    let session_state = app.state::<crate::GDriveSessionState>();
    let provider = match acquire_cloud_provider(&state, Some(&session_state)) {
        Ok(p) => p,
        // No cloud provider anywhere — nothing to verify against; the flag stands.
        Err(_) => return Ok(false),
    };

    // Hold the sync single-flight slot across the whole detect→clear→re-verify
    // sequence. `run_sync_now` / `run_push_entry` read the persisted flag only
    // at entry, so without the guard a push could START inside the window where
    // the flag is cleared but the re-verify has not yet re-armed it. With the
    // guard held no push can begin; if a sync is already in flight, the flag
    // simply stands for now and the screen retries later.
    let Some(_guard) = crate::commands::sync::SyncInProgressGuard::try_acquire() else {
        log::info!("recheck_force_re_pair: a sync is in flight — flag stands for now");
        return Ok(false);
    };

    let decision = resolve_force_re_pair_outcome(detect_force_re_pair(&provider, &state).await);
    let was_verified = matches!(decision, ForceRePairDecision::Verified);
    let cleared = {
        let conn = state.lock()?;
        apply_recheck_decision(&conn, decision)?
    };

    // Remote TOCTOU guard: the detect above ran BEFORE the clear, so a peer
    // rotation landing between the cloud read and `clear_force_re_pair` would be
    // erased by a stale `Verified`. Re-read the cloud once more now that the
    // flag is gone and re-arm it if the vault moved. Skipped for the auth-clear
    // path (`was_verified == false`): dead credentials cannot re-read anything,
    // and that path never observed a healthy vault to race against.
    if cleared && was_verified {
        let second = detect_force_re_pair(&provider, &state).await;
        let conn = state.lock()?;
        return confirm_post_clear_verification(&conn, second);
    }
    Ok(cleared)
}

/// Act on the SECOND detect taken after a `Verified` clear (remote TOCTOU
/// guard). Takes the RAW detect result (not the resolved decision) so the
/// typed `is_corrupt` verdict is not lost:
///
/// - `Mismatch` re-arms the flag — the rotation landed inside the detect→clear
///   window.
/// - A corrupt `_meta.json` re-arms it too (same fail-closed policy as the
///   pull leg): the cloud turned unverifiable inside the window.
/// - Everything else leaves the clear in place: a transient failure here must
///   not re-block push (the reconcile paths re-detect on their own), and
///   `Skipped`/`Verified` carry no rotation evidence.
pub(crate) fn confirm_post_clear_verification(
    conn: &rusqlite::Connection,
    second: Result<ForceRePairCheck, DetectError>,
) -> Result<bool, String> {
    match second {
        Ok(ForceRePairCheck::Mismatch(mismatch)) => {
            set_force_re_pair_flags(conn, &mismatch.reason)?;
            log::warn!(
                "recheck_force_re_pair: vault rotated during the recheck window ({}) — \
                 flag re-armed",
                mismatch.reason
            );
            Ok(false)
        }
        Err(e) if e.is_corrupt => {
            apply_inconclusive_force_re_pair(conn, "keyring_check_inconclusive")?;
            log::warn!(
                "recheck_force_re_pair: _meta.json turned corrupt during the recheck window \
                 ({}) — flag re-armed",
                e.message
            );
            Ok(false)
        }
        _ => Ok(true),
    }
}

/// Act on a recheck [`ForceRePairDecision`]: clear the flag on `Verified`, leave
/// it standing otherwise.
///
/// Split out from [`recheck_force_re_pair`] so the dispatch that actually carries
/// the safety property is unit-testable without a live Drive provider.  Moving the
/// `clear_force_re_pair` call into any arm other than `Verified` must break a test.
pub(crate) fn apply_recheck_decision(
    conn: &rusqlite::Connection,
    decision: ForceRePairDecision,
) -> Result<bool, String> {
    match decision {
        ForceRePairDecision::Verified => {
            clear_force_re_pair(conn)?;
            log::info!("recheck_force_re_pair: fingerprint verified — stale flag cleared");
            Ok(true)
        }
        ForceRePairDecision::NeedsRepair(mismatch) => {
            // Upgrade the reason to the rotation we just observed. Without this, a
            // flag first written as `keyring_check_inconclusive` would keep that
            // reason even after a real rotation is detected here — and a later auth
            // failure would then clear it as if it had only ever been inconclusive.
            // `apply_inconclusive_force_re_pair` refuses the reverse downgrade, so
            // once upgraded the reason stays put. The transactional write also
            // re-asserts `FORCE_RE_PAIR_REQUIRED=1` so both rows stay consistent.
            set_force_re_pair_flags(conn, &mismatch.reason)
                .map_err(|e| format!("recheck_force_re_pair: upgrade reason: {e}"))?;
            log::info!(
                "recheck_force_re_pair: mismatch stands ({}) — re-pair still required",
                mismatch.reason
            );
            Ok(false)
        }
        ForceRePairDecision::Skipped => {
            // Nothing to compare — not a verification, so the flag stands.
            log::info!("recheck_force_re_pair: nothing to compare — flag stands");
            Ok(false)
        }
        ForceRePairDecision::Inconclusive {
            message: e,
            is_auth,
        } => {
            // Dead Drive auth cannot verify the keyring — but a flag whose reason is
            // `keyring_check_inconclusive` was itself written by a check that failed
            // this same way, and such a flag is otherwise inescapable: every retry
            // fails auth identically. Clear it and let the user reconnect Drive.
            //
            // Not fail-open: a genuine rotation carries reason `vault_rotated`, and
            // `apply_inconclusive_force_re_pair` refuses to downgrade that reason, so
            // a real rotation cannot masquerade as an inconclusive one. Push stays
            // blocked meanwhile (no valid token), and `gdrive_complete_connect`
            // re-runs the fingerprint check on reconnect — re-setting the flag if the
            // vault really did move.
            let reason = db::get_setting(conn, db::FORCE_RE_PAIR_REASON)
                .map_err(|err| format!("recheck_force_re_pair: read reason: {err}"))?;
            if is_auth && reason.as_deref() == Some("keyring_check_inconclusive") {
                clear_force_re_pair(conn)?;
                log::warn!(
                    "recheck_force_re_pair: Drive auth revoked and the flag came from an \
                     inconclusive check — clearing it; reconnect Drive to resume syncing"
                );
                return Ok(true);
            }
            log::warn!("recheck_force_re_pair: check inconclusive ({e}) — flag stands");
            Err(format!("recheck_force_re_pair: keyring check failed: {e}"))
        }
    }
}

/// Compare the cloud `_meta.json` fingerprint + epoch against local settings.
///
/// Returns `Mismatch` when:
/// - The cloud fingerprint does not match local `cloud_master_fingerprint`, OR
/// - The cloud epoch is strictly greater than the local epoch.
///
/// The fingerprint is the integrity signal — a mismatch means another device
/// rotated the vault even if the epoch hasn't advanced (e.g. a same-epoch
/// rotation). The epoch is the freshness signal — a newer epoch also requires
/// re-pair to pick up the new master key.  Using `||` ensures neither signal
/// is silently ignored.
///
/// Returns `Verified` only when a real comparison ran and both signals agreed.
/// Returns `Skipped` when there was nothing to compare — this is deliberately
/// distinct from `Verified` so callers cannot mistake "couldn't check" for
/// "checked and healthy" when deciding to clear the fail-closed flag.
/// Returns `Err` on I/O failure.
///
/// This helper has no side effects — callers decide whether to set settings
/// and emit events.
pub(crate) async fn detect_force_re_pair<P>(
    provider: &P,
    state: &AppState,
) -> Result<ForceRePairCheck, DetectError>
where
    P: crate::sync::keyring_v2::KeyringV2Io,
{
    use crate::sync::keyring_v2::io as kio;

    let meta = match kio::read_meta(provider).await {
        Ok(Some(m)) => m,
        // No keyring yet — nothing to compare. Not a verification.
        Ok(None) => return Ok(ForceRePairCheck::Skipped),
        Err(e) => {
            // Two conditions, and BOTH are needed — see `DetectError`:
            //
            // 1. The typed `SyncError::Auth` variant. Cloud file content surfaces as
            //    `Serialization`/`Io`, never `Auth`, so an attacker-authored
            //    `_meta.json` cannot reach this arm however it is worded.
            // 2. The `GDRIVE_TOKEN_REVOKED` marker. `SyncError::Auth` alone is far too
            //    broad: `gdrive_provider.rs` maps EVERY non-scope refresh failure —
            //    network drop, 5xx, parse error — to `Auth`, so trusting the variant
            //    alone would let a transient blip pose as a revoked token and clear the
            //    fail-closed flag. The marker is hardcoded in `gdrive_oauth.rs` on 401 /
            //    invalid_grant only, and never echoes server-supplied text.
            //
            // Anything else stays `is_auth = false` → fail-closed.
            let is_auth = matches!(&e, crate::sync::provider::SyncError::Auth(msg)
                if msg.contains("GDRIVE_TOKEN_REVOKED"));
            // Corrupt-vs-transient: `Serialization` means the bytes were read
            // but do not form a valid `KeyringMetaV2` — the pull leg's
            // best-effort path must not swallow that (see
            // `check_force_re_pair_sync`).
            let is_corrupt = matches!(&e, crate::sync::provider::SyncError::Serialization(_));
            return Err(DetectError {
                message: format!("detect_force_re_pair: read _meta.json: {e}"),
                is_auth,
                is_corrupt,
            });
        }
    };

    let (local_fp, local_epoch) = {
        let conn = state.lock()?;
        let fp = db::get_setting(&conn, db::CLOUD_MASTER_FINGERPRINT).map_err(|e| e.to_string())?;
        let epoch = db::get_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH)
            .map_err(|e| e.to_string())?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        (fp, epoch)
    };

    // No local fingerprint means this device hasn't completed setup yet — skip.
    // Not a verification: we have no local truth to compare against.
    let Some(local_fp_str) = local_fp else {
        return Ok(ForceRePairCheck::Skipped);
    };

    // Mismatch: fingerprint differs OR epochs disagree → another device rotated,
    // or the cloud was rolled back to an older `_meta.json`.
    // Using || ensures a fingerprint change without an epoch advance is still detected.
    // `!=` (not `>`) so a REPLAYED older epoch is also a mismatch: `Verified` is a
    // positive claim that cloud and local agree, and it authorizes clearing the
    // fail-closed flag — a rollback must never be able to buy that.
    if meta.master_fingerprint != local_fp_str || meta.epoch != local_epoch {
        return Ok(ForceRePairCheck::Mismatch(ForceRePairMismatch {
            reason: "vault_rotated".to_string(),
            cloud_epoch: meta.epoch,
        }));
    }

    Ok(ForceRePairCheck::Verified)
}

// ─── V1 keyring wipe ─────────────────────────────────────────────────────────

/// One-shot V1 keyring wipe.
///
/// Probes `.meta/keyring.json` via `KeyringV2Io::read_file`. If not found,
/// returns `Ok(false)` (caller continues normally). If found:
///
/// 1. Deletes `.meta/keyring.json` from Drive (best-effort — errors logged).
/// 2. Clears all local encryption state (`wrapped_encryption_key`, `kek_salt`,
///    `password_hash`, `keyring_dirty`, `encryption_mode → Unset`).
/// 3. Calls `clear_gdrive_settings` to also clear OAuth tokens and
///    `sync_connected` — the cloud folder was just wiped so the user must
///    re-authorize (I1: prevents half-state with `sync_connected=true`).
/// 4. Calls `reset_local_sync_state` so entries are marked pending for upload
///    after reconnect (project rule: destructive cloud actions must reset local
///    sync state atomically).
/// 5. Returns `Err("V1_WIPE_COMPLETE_RECONNECT_REQUIRED: ...")` so
///    `gdrive_complete_connect` can return the typed error to the frontend —
///    that typed outcome (`v1_wiped_reconnect_required`) is what drives the
///    "reconnect required" banner in `GoogleDriveSettings.tsx`.
///
/// Also CLEARS any standing force-re-pair flag: the wipe resets the entire
/// local encryption state and disconnects Drive, so a leftover flag would
/// strand the user on `ForceRePairScreen` with no Drive session to re-pair
/// against (and no vault left to re-pair to).
pub(crate) async fn wipe_v1_keyring_if_present(
    provider: &(impl crate::sync::keyring_v2::KeyringV2Io + Send + Sync),
    state: &AppState,
) -> Result<bool, String> {
    const V1_PATH: &str = ".meta/keyring.json";

    // Probe V1 path. Ok(_) → present; Err(NotFound) → absent; other Err → skip wipe.
    let is_present = match provider.read_file(V1_PATH).await {
        Ok(_) => true,
        Err(crate::sync::provider::SyncError::NotFound(_)) => false,
        Err(e) => {
            log::warn!("v1_wipe: probe failed ({e}), skipping wipe");
            return Ok(false);
        }
    };
    if !is_present {
        return Ok(false);
    }

    log::warn!("v1_wipe: found legacy .meta/keyring.json — wiping for V2 schema migration");

    // C4: fail-loud on delete error — a partial wipe (local cleared, cloud not)
    // would leave the V1 file in place and repeat the wipe loop on every connect.
    provider
        .delete_file(V1_PATH)
        .await
        .map_err(|e| format!("v1_wipe: failed to delete .meta/keyring.json: {e}"))?;

    // Clear local encryption state so the user is prompted to re-setup.
    // C4: propagate all errors instead of swallowing with `let _ = ...`.
    let conn = state
        .lock()
        .map_err(|e| format!("v1_wipe: state lock failed: {e}"))?;
    db::delete_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
        .map_err(|e| format!("v1_wipe: clear wrapped_key: {e}"))?;
    db::delete_setting(&conn, db::KEK_SALT_KEY)
        .map_err(|e| format!("v1_wipe: clear kek_salt: {e}"))?;
    db::delete_setting(&conn, "password_hash")
        .map_err(|e| format!("v1_wipe: clear password_hash: {e}"))?;
    db::delete_setting(&conn, db::KEYRING_DIRTY_KEY)
        .map_err(|e| format!("v1_wipe: clear keyring_dirty: {e}"))?;
    db::set_encryption_mode(&conn, db::EncryptionMode::Unset)
        .map_err(|e| format!("v1_wipe: set encryption_mode unset: {e}"))?;
    // The vault this flag referred to no longer exists — clear it so the user
    // is routed to first-time setup, not a dead-end ForceRePairScreen.
    clear_force_re_pair(&conn).map_err(|e| format!("v1_wipe: clear force_re_pair: {e}"))?;
    // I1: also clear OAuth tokens so `sync_connected` / `gdrive_refresh_token`
    // are not left in a half-connected state. The cloud folder was just wiped;
    // the user must re-authorize to proceed.
    clear_gdrive_settings(&conn).map_err(|e| format!("v1_wipe: clear gdrive: {e}"))?;
    // Reset sync_state rows so entries are marked pending upload after reconnect
    // (project rule: destructive cloud actions must atomically reset local sync state).
    crate::commands::sync::reset_local_sync_state(&conn)
        .map_err(|e| format!("v1_wipe: reset sync state: {e}"))?;

    Err("V1_WIPE_COMPLETE_RECONNECT_REQUIRED: \
         legacy keyring was wiped. Drive has been disconnected; \
         please reconnect and complete first-time setup."
        .to_string())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipe_keep_connection_recreates_namespace_but_disconnect_does_not() {
        assert!(should_recreate_namespace_after_wipe(false));
        assert!(!should_recreate_namespace_after_wipe(true));
    }

    // ─── Recovery preflight single-flight gate ───────────────────────────────
    //
    // Both preflight commands (local_to_cloud preflight, cloud_to_local
    // staging) hold the AppState mutex across network I/O. Running them
    // while a sync cycle is active stalls the sync and freezes every other
    // command, so they must refuse with the exact `sync_in_progress` string
    // the frontend maps to "A sync is running right now".
    #[test]
    fn recovery_preflight_guard_refuses_while_sync_runs_and_frees_after() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let held = crate::commands::sync::SyncInProgressGuard::try_acquire()
            .expect("guard must be free at test start");
        let err = acquire_recovery_preflight_guard()
            .err()
            .expect("preflight must be refused while a sync holds the slot");
        assert_eq!(err, crate::commands::sync::SYNC_IN_PROGRESS_ERR);
        drop(held);

        let guard = acquire_recovery_preflight_guard()
            .expect("preflight must acquire the slot once sync is idle");
        assert!(
            crate::commands::sync::SyncInProgressGuard::try_acquire().is_none(),
            "preflight guard must hold the sync slot while alive"
        );
        drop(guard);
        assert!(
            crate::commands::sync::SyncInProgressGuard::try_acquire().is_some(),
            "slot must be released when the preflight guard drops"
        );
    }

    // ─── Resume-level single-flight ──────────────────────────────────────────
    //
    // Two overlapping `gdrive_resume_sync_recovery` calls must not both mark
    // the job running. The loser is refused before any row write.

    #[test]
    fn resume_in_flight_second_acquire_leaves_job_status_unchanged() {
        let _lock = RESUME_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        let job_id = db::create_sync_recovery_job(&conn, "local_to_cloud", 1, None, None).unwrap();
        let before = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();

        let _winner = ResumeInFlightGuard::try_acquire().expect("first acquire must win");
        let err = try_begin_resume(&conn, job_id).expect_err("second acquire must refuse");
        assert_eq!(err, "resume already running");

        let after = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        assert_eq!(
            after.status, before.status,
            "loser must not touch the job row"
        );
        assert_eq!(after.last_error, before.last_error);
    }

    #[test]
    fn try_begin_resume_winner_marks_job_running() {
        let _lock = RESUME_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        let job_id = db::create_sync_recovery_job(&conn, "local_to_cloud", 1, None, None).unwrap();
        let before = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        assert_eq!(before.status, "pending");

        let winner = try_begin_resume(&conn, job_id).expect("winner must acquire");
        let running = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        assert_eq!(running.status, "running");
        drop(winner);

        let again = try_begin_resume(&conn, job_id).expect("slot free after drop");
        let still_running = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        assert_eq!(still_running.status, "running");
        drop(again);
    }

    #[test]
    fn try_begin_resume_mark_failure_releases_slot() {
        let _lock = RESUME_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        let missing_id = 9_999_i64;

        let err = try_begin_resume(&conn, missing_id).expect_err("unknown job must fail mark");
        assert!(!err.is_empty(), "mark failure must return a non-empty Err");

        let winner = try_begin_resume(
            &conn,
            db::create_sync_recovery_job(&conn, "local_to_cloud", 1, None, None).unwrap(),
        )
        .expect("slot must be free after mark-failure Drop");
        drop(winner);
    }

    // ─── Resume-step refusal bookkeeping ─────────────────────────────────────

    #[test]
    fn refused_resume_step_fails_untouched_running_job() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        let job_id = db::create_sync_recovery_job(&conn, "local_to_cloud", 1, None, None).unwrap();
        db::mark_sync_recovery_job_running(&conn, job_id).unwrap();

        record_refused_resume_step(&conn, job_id, "sync_in_progress").unwrap();

        let job = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        assert_eq!(job.status, "failed");
        assert_eq!(job.last_error.as_deref(), Some("sync_in_progress"));
    }

    #[test]
    fn refused_resume_step_keeps_failure_recorded_by_the_module() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        let job_id = db::create_sync_recovery_job(&conn, "cloud_to_local", 1, None, None).unwrap();
        db::fail_sync_recovery_job(&conn, job_id, "insufficient free disk").unwrap();

        record_refused_resume_step(&conn, job_id, "outer command error").unwrap();

        let job = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        assert_eq!(job.status, "failed");
        assert_eq!(
            job.last_error.as_deref(),
            Some("insufficient free disk"),
            "module-recorded failure must not be overwritten"
        );
    }

    #[test]
    fn refused_resume_step_keeps_error_on_running_job() {
        // A step that failed mid-flight but was re-marked running by a
        // concurrent phase advance still carries its own error — the outer
        // refusal must not overwrite it (second conjunct of `untouched`).
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        let job_id = db::create_sync_recovery_job(&conn, "local_to_cloud", 1, None, None).unwrap();
        db::mark_sync_recovery_job_running(&conn, job_id).unwrap();
        // Test-only fixture: no db helper sets last_error while running.
        conn.execute(
            "UPDATE sync_recovery_jobs SET last_error = 'insufficient free disk' WHERE id = ?1",
            [job_id],
        )
        .unwrap();

        record_refused_resume_step(&conn, job_id, "sync_in_progress").unwrap();

        let job = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        assert_eq!(job.status, "running");
        assert_eq!(job.last_error.as_deref(), Some("insufficient free disk"));
    }

    #[test]
    fn refused_resume_step_yields_retryable_resumable_status() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        let job_id = db::create_sync_recovery_job(&conn, "local_to_cloud", 1, None, None).unwrap();
        db::mark_sync_recovery_job_running(&conn, job_id).unwrap();

        record_refused_resume_step(&conn, job_id, "sync_in_progress").unwrap();

        let job = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        let status = sync_recovery_status_from_job(&job);
        assert_eq!(status.error_class, Some(SyncRecoveryErrorClass::Retryable));
        assert!(status.can_resume, "a refused step must stay resumable");
    }

    #[test]
    fn refused_resume_step_ignores_missing_job() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        record_refused_resume_step(&conn, 4242, "sync_in_progress").unwrap();
    }

    // ─── Password-check gate for gdrive_complete_connect ─────────────────────
    //
    // The typed password is only an ownership proof; it is redundant exactly
    // when the vault is already unlocked AND no password was supplied.
    #[test]
    fn password_check_skipped_only_when_unlocked_and_no_password() {
        use db::EncryptionMode::{Password, Unset};

        // Onboarding: unlocked, no password typed → skip the redundant check.
        assert!(!password_check_required(&Password, true, true));

        // Settings re-auth: a real password is always verified.
        assert!(password_check_required(&Password, false, true));

        // Locked vault with an empty password → still verify (and fail).
        assert!(password_check_required(&Password, true, false));

        // Locked vault with a password → verify.
        assert!(password_check_required(&Password, false, false));

        // Unset mode never has a password to check (welcome-screen adopt path).
        assert!(!password_check_required(&Unset, true, true));
        assert!(!password_check_required(&Unset, false, false));
    }

    // ─── Recovery status serialization / cancel-safe / error classes ─────

    fn make_job_row(
        operation: &str,
        phase: &str,
        status: &str,
        last_error: Option<&str>,
    ) -> db::SyncRecoveryJobRow {
        db::SyncRecoveryJobRow {
            id: 42,
            operation: operation.to_string(),
            phase: phase.to_string(),
            status: status.to_string(),
            recovery_generation: 3,
            backup_path: Some("/tmp/recovery.memlore.zip".into()),
            staging_path: Some("/tmp/staging".into()),
            verification_binding: "{}".into(),
            verified_counts: r#"{"media_total":4,"media_local":3}"#.into(),
            last_error: last_error.map(|s| s.to_string()),
            created_at: 100,
            updated_at: 200,
        }
    }

    #[test]
    fn recovery_status_serializes_camel_case_and_active_flags() {
        let status = sync_recovery_status_from_job(&make_job_row(
            "local_to_cloud",
            "backup",
            "failed",
            Some("network: error sending request for url"),
        ));
        assert!(status.is_active);
        assert!(status.blocks_normal_sync);
        assert!(status.can_resume);
        assert!(status.can_cancel_safely);
        assert_eq!(status.next_step, Some(SyncRecoveryStep::LocalRebuild));
        assert_eq!(status.error_class, Some(SyncRecoveryErrorClass::Retryable));
        assert_eq!(status.verified_counts["media_total"], 4);

        let json = serde_json::to_value(&status).expect("serialize");
        assert_eq!(json["jobId"], 42);
        assert_eq!(json["backupPath"], "/tmp/recovery.memlore.zip");
        assert_eq!(json["blocksNormalSync"], true);
        assert_eq!(json["canCancelSafely"], true);
        assert_eq!(json["nextStep"], "local_rebuild");
        assert_eq!(json["errorClass"], "retryable");
        // Keys inside verified_counts stay as stored on the job row (snake_case).
        assert_eq!(json["verifiedCounts"]["media_local"], 3);
    }

    #[test]
    fn recovery_status_local_to_cloud_cancel_unsafe_after_fence() {
        let status = sync_recovery_status_from_job(&make_job_row(
            "local_to_cloud",
            "fenced",
            "failed",
            Some("upload failed: timeout"),
        ));
        assert!(!status.can_cancel_safely);
        assert!(status.can_resume);
        assert_eq!(status.next_step, Some(SyncRecoveryStep::LocalRebuild));
        assert_eq!(status.error_class, Some(SyncRecoveryErrorClass::Retryable));

        let finalize_phase = sync_recovery_status_from_job(&make_job_row(
            "local_to_cloud",
            "fence_release_pending",
            "failed",
            Some("fence release failed: network"),
        ));
        assert!(!finalize_phase.can_cancel_safely);
        assert_eq!(
            finalize_phase.next_step,
            Some(SyncRecoveryStep::LocalFinalize)
        );
    }

    #[test]
    fn recovery_status_cloud_to_local_cancel_safe_before_commit() {
        let staged = sync_recovery_status_from_job(&make_job_row(
            "cloud_to_local",
            "verify",
            "running",
            None,
        ));
        assert!(staged.can_cancel_safely);
        assert_eq!(staged.next_step, Some(SyncRecoveryStep::CloudCommit));
        assert!(staged.error_class.is_none());

        let committing = sync_recovery_status_from_job(&make_job_row(
            "cloud_to_local",
            "commit",
            "failed",
            Some("swap failed"),
        ));
        assert!(!committing.can_cancel_safely);
        assert_eq!(committing.next_step, Some(SyncRecoveryStep::CloudCommit));
    }

    #[test]
    fn recovery_error_class_distinguishes_retryable_terminal_preflight() {
        assert_eq!(
            classify_recovery_error("network: error sending request for url"),
            SyncRecoveryErrorClass::Retryable
        );
        assert_eq!(
            classify_recovery_error("force re-pair is required; finish re-pair"),
            SyncRecoveryErrorClass::Terminal
        );
        assert_eq!(
            classify_recovery_error("competing recovery lease held by peer"),
            SyncRecoveryErrorClass::Terminal
        );
        assert_eq!(
            classify_recovery_error("insufficient free disk: need at least 100"),
            SyncRecoveryErrorClass::PreflightBlocker
        );
        assert_eq!(
            classify_recovery_error("media incomplete: 2 missing originals"),
            SyncRecoveryErrorClass::PreflightBlocker
        );
        assert_eq!(
            classify_recovery_error("cloud unreadable: 401"),
            SyncRecoveryErrorClass::PreflightBlocker
        );
    }

    #[test]
    fn recovery_status_completed_job_does_not_block_sync() {
        let status = sync_recovery_status_from_job(&make_job_row(
            "local_to_cloud",
            "fence_release_pending",
            "completed",
            None,
        ));
        assert!(!status.is_active);
        assert!(!status.blocks_normal_sync);
        assert!(!status.can_resume);
        assert!(!status.can_cancel_safely);
        assert!(status.next_step.is_none());
    }

    #[test]
    fn recovery_status_event_name_is_stable() {
        assert_eq!(SYNC_RECOVERY_STATUS_EVENT, "sync:recovery-status-changed");
    }

    #[test]
    fn get_sync_recovery_status_reads_active_job_from_db() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        assert!(read_sync_recovery_status(&conn).unwrap().is_none());

        let id = db::create_sync_recovery_job(
            &conn,
            "cloud_to_local",
            2,
            Some("/b.zip"),
            Some("/staging"),
        )
        .unwrap();
        db::advance_sync_recovery_job(&conn, id, "preflight", "{}").unwrap();
        db::fail_sync_recovery_job(&conn, id, "insufficient free disk: need 1").unwrap();

        let status = read_sync_recovery_status(&conn)
            .unwrap()
            .expect("active job");
        assert_eq!(status.job_id, id);
        assert_eq!(status.operation, "cloud_to_local");
        assert_eq!(status.phase, "preflight");
        assert_eq!(status.status, "failed");
        assert!(status.blocks_normal_sync);
        assert!(status.can_cancel_safely);
        // Preflight blockers must not offer Resume.
        assert!(!status.can_resume);
        assert_eq!(status.next_step, Some(SyncRecoveryStep::CloudBeginStaging));
        assert_eq!(
            status.error_class,
            Some(SyncRecoveryErrorClass::PreflightBlocker)
        );
    }

    #[test]
    fn recovery_status_terminal_and_preflight_block_resume() {
        let terminal = sync_recovery_status_from_job(&make_job_row(
            "local_to_cloud",
            "backup",
            "failed",
            Some("force re-pair is required; finish re-pair"),
        ));
        assert!(!terminal.can_resume);
        assert_eq!(terminal.error_class, Some(SyncRecoveryErrorClass::Terminal));
        assert!(terminal.next_step.is_some());

        let preflight = sync_recovery_status_from_job(&make_job_row(
            "cloud_to_local",
            "preflight",
            "failed",
            Some("media incomplete: 2 missing originals"),
        ));
        assert!(!preflight.can_resume);
        assert_eq!(
            preflight.error_class,
            Some(SyncRecoveryErrorClass::PreflightBlocker)
        );

        let retryable = sync_recovery_status_from_job(&make_job_row(
            "local_to_cloud",
            "transfer",
            "failed",
            Some("network: error sending request for url"),
        ));
        assert!(retryable.can_resume);
        assert_eq!(
            retryable.error_class,
            Some(SyncRecoveryErrorClass::Retryable)
        );
        // local_to_cloud past fence is never cancel-safe.
        assert!(!retryable.can_cancel_safely);
    }

    #[test]
    fn connect_stages_higher_generation_until_identity_validation() {
        assert_eq!(
            validate_connect_generation_alignment(2, 5, Some(5)).unwrap(),
            5
        );
        assert!(validate_connect_generation_alignment(2, 5, Some(4)).is_err());
        assert_eq!(
            validate_connect_generation_alignment(2, 5, None).unwrap(),
            5
        );
        assert!(validate_connect_generation_alignment(5, 4, Some(4)).is_err());
    }

    #[test]
    fn delayed_publish_generation_prefers_candidate_over_stale_local_zero() {
        // control=N, local still 0, no meta yet — must plant meta at N, not 0.
        assert_eq!(resolve_keyring_publish_generation(0, Some(5)), 5);
        assert_eq!(resolve_keyring_publish_generation(3, Some(3)), 3);
        // No override → local DB wins (normal publish paths).
        assert_eq!(resolve_keyring_publish_generation(0, None), 0);
        assert_eq!(resolve_keyring_publish_generation(7, None), 7);
    }

    #[test]
    fn connect_ready_rejects_when_control_generation_or_revision_or_lease_changes() {
        use crate::sync::keyring_v2::{RecoveryMarker, RECOVERY_MARKER_VERSION};
        use crate::sync::sync_control::{SyncControlV1, SYNC_CONTROL_VERSION};

        let base = SyncControlV1 {
            version: SYNC_CONTROL_VERSION,
            recovery_generation: 3,
            recovery_lease: None,
            updated_at: 10,
        };
        assert!(assert_connect_control_snapshot_stable(3, "rev-a", &base, "rev-a").is_ok());

        // Generation bumped mid-connect.
        let gen_bumped = SyncControlV1 {
            recovery_generation: 4,
            ..base.clone()
        };
        let err =
            assert_connect_control_snapshot_stable(3, "rev-a", &gen_bumped, "rev-a").unwrap_err();
        assert!(
            err.contains("RECOVERY_CONTROL_CHANGED"),
            "expected generation change error, got {err}"
        );

        // Revision changed (lease acquire CAS even if gen same is rare; still fail closed).
        let err = assert_connect_control_snapshot_stable(3, "rev-a", &base, "rev-b").unwrap_err();
        assert!(
            err.contains("RECOVERY_CONTROL_CHANGED"),
            "expected revision change error, got {err}"
        );

        // Lease appears mid-connect.
        let with_lease = SyncControlV1 {
            recovery_lease: Some(RecoveryMarker {
                version: RECOVERY_MARKER_VERSION,
                job_id: 1,
                owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
                operation: "local_to_cloud".to_string(),
                recovery_generation: 3,
                nonce: "0123456789abcdef".to_string(),
                created_at: 1,
                updated_at: 1,
            }),
            ..base
        };
        let err =
            assert_connect_control_snapshot_stable(3, "rev-a", &with_lease, "rev-a").unwrap_err();
        assert_eq!(err, "AUTHORITATIVE_RECOVERY_IN_PROGRESS");
    }

    #[test]
    fn published_meta_must_match_control_generation() {
        assert!(assert_published_meta_matches_control(5, 5).is_ok());
        let err = assert_published_meta_matches_control(0, 5).unwrap_err();
        assert!(
            err.contains("RECOVERY_GENERATION_MISMATCH"),
            "expected mismatch error, got {err}"
        );
    }

    #[test]
    fn connect_folder_failure_always_clears_local_and_attempts_device_cleanup() {
        let (clear_local, cleanup_device) = connect_folder_failure_cleanup_plan();
        assert!(clear_local, "must not leave Ready/sync_connected state");
        assert!(
            cleanup_device,
            "must best-effort delete partial device namespace"
        );
    }
    use crate::db::schema::migrate;
    use rusqlite::Connection;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    fn gdrive_pending_token(
        refresh_token: &str,
    ) -> crate::commands::pending_drive_session::PendingCloudSession {
        crate::commands::pending_drive_session::PendingCloudSession::GDrive {
            session: GDriveSession {
                access_token: "at_test".to_string(),
                expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
                refresh_token: zeroize::Zeroizing::new(refresh_token.to_string()),
                client_id: "cid_test".to_string(),
                client_secret: "cs_test".to_string(),
            },
            root_folder_id: "root_test".to_string(),
        }
    }

    // ─── clear_gdrive_settings ───────────────────────────────────────────────

    #[test]
    fn clear_gdrive_settings_removes_every_known_key() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "gdrive_refresh_token", "abc123").unwrap();
            db::set_setting(&conn, "gdrive_root_folder_id", "folder-id").unwrap();
            db::set_setting(&conn, "gdrive_email", "x@y.com").unwrap();
            db::set_setting(&conn, "sync_connected", "true").unwrap();
            db::set_setting(&conn, "sync_provider", "gdrive").unwrap();
            db::set_setting(&conn, GDRIVE_STORAGE_USED_KEY, "12345").unwrap();
            db::set_setting(&conn, GDRIVE_STORAGE_TOTAL_KEY, "67890").unwrap();
            db::set_setting(&conn, GDRIVE_STORAGE_APP_USED_KEY, "999").unwrap();
        }
        {
            let conn = state.lock().unwrap();
            clear_gdrive_settings(&conn).unwrap();
        }
        let conn = state.lock().unwrap();
        for key in [
            "gdrive_refresh_token",
            "gdrive_root_folder_id",
            "gdrive_email",
            "sync_connected",
            "sync_provider",
            "sync_config_json",
            GDRIVE_STORAGE_USED_KEY,
            GDRIVE_STORAGE_TOTAL_KEY,
            GDRIVE_STORAGE_APP_USED_KEY,
        ] {
            assert!(
                db::get_setting(&conn, key).unwrap().is_none(),
                "{key} should be cleared"
            );
        }
    }

    // ─── storage quota cache ─────────────────────────────────────────────────

    #[test]
    fn persist_and_read_storage_quota_roundtrips() {
        let state = make_state();
        let conn = state.lock().unwrap();
        persist_storage_quota(
            &conn,
            Some(1_073_741_824),
            Some(16_106_127_360),
            Some(42_000_000),
        )
        .unwrap();
        let (used, total, app_used) = read_cached_storage_quota(&conn).unwrap();
        assert_eq!(used, Some(1_073_741_824));
        assert_eq!(total, Some(16_106_127_360));
        assert_eq!(app_used, Some(42_000_000));
    }

    #[test]
    fn read_cached_storage_quota_returns_none_when_unset() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let (used, total, app_used) = read_cached_storage_quota(&conn).unwrap();
        assert_eq!(used, None);
        assert_eq!(total, None);
        assert_eq!(app_used, None);
    }

    #[test]
    fn persist_storage_quota_with_none_clears_previous_values() {
        let state = make_state();
        let conn = state.lock().unwrap();
        persist_storage_quota(&conn, Some(100), Some(200), Some(50)).unwrap();
        // A subsequent fetch failure should not leave stale numbers behind.
        persist_storage_quota(&conn, None, None, None).unwrap();
        let (used, total, app_used) = read_cached_storage_quota(&conn).unwrap();
        assert_eq!(used, None);
        assert_eq!(total, None);
        assert_eq!(app_used, None);
    }

    #[test]
    fn read_cached_storage_quota_treats_garbage_as_missing() {
        // A future schema bug or manual DB edit shouldn't tank the status read.
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, GDRIVE_STORAGE_USED_KEY, "not-a-number").unwrap();
        let (used, _total, _app) = read_cached_storage_quota(&conn).unwrap();
        assert_eq!(used, None);
    }

    // ─── gdrive_get_status ───────────────────────────────────────────────────

    #[test]
    fn gdrive_get_status_returns_disconnected_when_no_token() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let snap = read_status_snapshot(&conn).unwrap();
        assert!(!snap.connected);
        assert!(snap.email.is_none());
        assert!(snap.storage_used.is_none());
        assert!(snap.storage_total.is_none());
        assert!(snap.storage_app_used.is_none());
    }

    #[test]
    fn gdrive_get_status_returns_cached_storage_when_connected() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // Simulate post-connect state: token + cached storage.
        persist_connect_settings(&conn, &gdrive_pending_token("fake-encrypted-hex")).unwrap();
        persist_storage_quota(
            &conn,
            Some(2_500_000_000),
            Some(16_000_000_000),
            Some(128_000_000),
        )
        .unwrap();
        let snap = read_status_snapshot(&conn).unwrap();
        assert!(snap.connected);
        assert_eq!(snap.storage_used, Some(2_500_000_000));
        assert_eq!(snap.storage_total, Some(16_000_000_000));
        assert_eq!(snap.storage_app_used, Some(128_000_000));
    }

    #[test]
    fn gdrive_get_status_returns_none_storage_when_cache_empty() {
        // The bug: pre-fix `gdrive_get_status` always returned (None, None),
        // and the frontend rendered it as "0.0 MB / 0.0 MB". After the fix,
        // a connected session with no cached quota still surfaces None — the
        // frontend guard must hide the line in that case.
        let state = make_state();
        let conn = state.lock().unwrap();
        persist_connect_settings(&conn, &gdrive_pending_token("fake-encrypted-hex")).unwrap();
        let snap = read_status_snapshot(&conn).unwrap();
        assert!(snap.connected);
        assert_eq!(snap.storage_used, None);
        assert_eq!(snap.storage_total, None);
        assert_eq!(snap.storage_app_used, None);
    }

    #[test]
    fn gdrive_get_status_reports_local_provider_and_root_path() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, "sync_connected", "true").unwrap();
        db::set_setting(&conn, "sync_provider", "local").unwrap();
        db::set_sync_config_json(&conn, r#"{"root_path":"/tmp/xj-local-status"}"#).unwrap();
        db::set_sync_enabled(&conn, true).unwrap();

        let snap = read_status_snapshot(&conn).unwrap();
        assert!(snap.connected, "sync_connected=true must report connected");
        assert_eq!(snap.provider.as_deref(), Some("local"));
        assert_eq!(snap.root_path.as_deref(), Some("/tmp/xj-local-status"));
        assert!(snap.email.is_none());
        assert!(snap.storage_used.is_none());
    }

    #[test]
    fn gdrive_disconnect_on_local_provider_clears_rows_without_oauth() {
        let state = make_state();
        let session_state = GDriveSessionState::new();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "sync_connected", "true").unwrap();
            db::set_setting(&conn, "sync_provider", "local").unwrap();
            db::set_sync_config_json(&conn, r#"{"root_path":"/tmp/xj-local-disconnect"}"#).unwrap();
            db::set_sync_enabled(&conn, true).unwrap();
        }

        let provider = acquire_cloud_provider(&state, Some(&session_state)).ok();
        assert!(
            !disconnect_should_revoke_oauth(provider.as_ref()),
            "folder provider must not touch OAuth revoke"
        );
        apply_disconnect_clear(&state, &session_state).unwrap();

        let conn = state.lock().unwrap();
        assert!(
            db::get_setting(&conn, "sync_provider").unwrap().is_none(),
            "sync_provider must be cleared"
        );
        assert!(
            db::get_setting(&conn, "sync_connected").unwrap().is_none(),
            "sync_connected must be cleared"
        );
        assert!(
            db::get_sync_config_json(&conn).unwrap().is_none(),
            "sync_config_json must be cleared"
        );
        assert!(
            db::get_setting(&conn, "gdrive_refresh_token")
                .unwrap()
                .is_none(),
            "OAuth token row must stay absent"
        );
        assert!(session_state.get_clone().is_none());
    }

    // ─── reconstruct_session ─────────────────────────────────────────────────

    #[test]
    fn reconstruct_session_returns_none_when_no_token() {
        let state = make_state();
        assert!(reconstruct_session(&state).unwrap().is_none());
    }

    #[test]
    fn reconstruct_session_reads_stored_token() {
        let state = make_state();

        let refresh_token = "1//fake-refresh-token";
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "gdrive_refresh_token", refresh_token).unwrap();
        }
        let session = reconstruct_session(&state).unwrap().expect("session");
        assert_eq!(*session.refresh_token, refresh_token);
        assert!(!session.client_id.is_empty());
    }

    // ─── GDriveSessionState ──────────────────────────────────────────────────

    #[test]
    fn session_state_set_clear_roundtrips() {
        let ss = GDriveSessionState::new();
        assert!(ss.get_clone().is_none());

        let session = GDriveSession {
            access_token: "tok".to_string(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
            refresh_token: zeroize::Zeroizing::new("refresh".to_string()),
            client_secret: "sec".to_string(),
            client_id: "cid".to_string(),
        };
        ss.set(session);
        assert!(ss.get_clone().is_some());

        ss.clear();
        assert!(ss.get_clone().is_none());
    }

    // ─── PendingOAuthState ───────────────────────────────────────────────────

    // ─── persist_connect_settings ────────────────────────────────────────────

    #[test]
    fn persist_connect_settings_enables_sync() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            persist_connect_settings(&conn, &gdrive_pending_token("encrypted-hex")).unwrap();
        }
        let conn = state.lock().unwrap();
        assert_eq!(
            db::get_setting(&conn, "gdrive_refresh_token")
                .unwrap()
                .as_deref(),
            Some("encrypted-hex")
        );
        assert_eq!(
            db::get_sync_provider(&conn).unwrap().as_deref(),
            Some("gdrive")
        );
        assert_eq!(
            db::get_setting(&conn, "sync_connected").unwrap().as_deref(),
            Some("true")
        );
        assert!(
            db::get_sync_enabled(&conn).unwrap(),
            "sync_enabled must be true after a successful connect so the UI does not show \"Sync off\""
        );
    }

    #[test]
    fn persist_connect_settings_folder_writes_local_config_rows() {
        use crate::commands::pending_drive_session::PendingCloudSession;

        let state = make_state();
        {
            let conn = state.lock().unwrap();
            persist_connect_settings(
                &conn,
                &PendingCloudSession::Folder {
                    kind: "icloud".to_string(),
                    root_path: "/tmp/xj-icloud-persist".to_string(),
                },
            )
            .unwrap();
        }
        let conn = state.lock().unwrap();
        assert_eq!(
            db::get_sync_provider(&conn).unwrap().as_deref(),
            Some("icloud")
        );
        let json = db::get_sync_config_json(&conn)
            .unwrap()
            .expect("sync_config_json must be set");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["root_path"].as_str(), Some("/tmp/xj-icloud-persist"));
        assert_eq!(
            db::get_setting(&conn, "sync_connected").unwrap().as_deref(),
            Some("true")
        );
        assert!(db::get_sync_enabled(&conn).unwrap());
        assert!(
            db::get_setting(&conn, "gdrive_refresh_token")
                .unwrap()
                .is_none(),
            "Folder persist must not write gdrive_refresh_token"
        );
    }

    // ─── V1 keyring tests removed (Phase 2) ─────────────────────────────────
    //
    // The following test groups were deleted when `sync/keyring.rs` (V1) was
    // removed. Phase 3 will add V2 equivalents:
    //
    // - FakeSharedIO / NeverCalledIO fakes
    // - connect_rolls_back_when_upload_fails
    // - connect_keeps_settings_when_upload_succeeds
    // - reconcile_rejects_wrong_password_before_drive_io
    // - Task 4.2 tests (reconcile_and_maybe_rollback, connect_adopts_cloud_key,
    //   connect_rolls_back_when_swap_fails_wrong_password)
    // - try_reupload_keyring_with_io_uploads_ok
    // - try_reupload_keyring_with_io_returns_err_on_write_failure
    // - reupload_and_update_dirty_flag_clears_flag_on_success
    // - reupload_and_update_dirty_flag_sets_flag_on_failure
    // - build_keyring_for_reupload_{fails_when_wrapped_key_missing,fails_when_kek_salt_missing,succeeds_with_full_setup}
    // - startup_reconcile_* (6 tests)

    #[test]
    fn pending_oauth_state_take_consumes_entry() {
        let ps = PendingOAuthState::new();
        let (_tx, rx) = tokio::sync::oneshot::channel::<Result<AuthCallback, String>>();
        ps.insert(
            "sid".to_string(),
            PendingOAuth {
                verifier: PkceVerifier("v".to_string()),
                redirect_uri: "http://127.0.0.1:1".to_string(),
                client_id: "cid".to_string(),
                client_secret: "sec".to_string(),
                state_param: "s".to_string(),
                callback_rx: rx,
                cancel_notify: Arc::new(Notify::new()),
            },
        );
        assert!(ps.take("sid").is_some());
        assert!(
            ps.take("sid").is_none(),
            "second take must find nothing (session consumed)"
        );
    }

    #[test]
    fn cancel_after_take_still_notifies_complete_connect() {
        // Regression: cancel_connect must reach an in-flight
        // complete_connect that has already consumed the main entry.
        let ps = PendingOAuthState::new();
        let (_tx, rx) = tokio::sync::oneshot::channel::<Result<AuthCallback, String>>();
        let notify = Arc::new(Notify::new());
        ps.insert(
            "sid".to_string(),
            PendingOAuth {
                verifier: PkceVerifier("v".to_string()),
                redirect_uri: "http://127.0.0.1:1".to_string(),
                client_id: "cid".to_string(),
                client_secret: "sec".to_string(),
                state_param: "s".to_string(),
                callback_rx: rx,
                cancel_notify: notify.clone(),
            },
        );

        // Simulate complete_connect consuming the entry first.
        let _consumed = ps.take("sid").expect("take consumes the entry");

        // cancel_connect must STILL be able to fire the notifier — that
        // is the whole point of the separate cancel_notifiers map.
        assert!(
            ps.cancel("sid"),
            "cancel must return true even after take()"
        );

        // And the future cloned from PendingOAuth.cancel_notify must
        // now be notified — completing the `notified()` await without
        // hanging.
        let already_signalled = futures_util::FutureExt::now_or_never(notify.notified());
        assert!(
            already_signalled.is_some(),
            "cancel_notify must have been signalled"
        );
    }

    #[test]
    fn cancel_before_take_clears_both_maps() {
        let ps = PendingOAuthState::new();
        let (_tx, rx) = tokio::sync::oneshot::channel::<Result<AuthCallback, String>>();
        ps.insert(
            "sid".to_string(),
            PendingOAuth {
                verifier: PkceVerifier("v".to_string()),
                redirect_uri: "http://127.0.0.1:1".to_string(),
                client_id: "cid".to_string(),
                client_secret: "sec".to_string(),
                state_param: "s".to_string(),
                callback_rx: rx,
                cancel_notify: Arc::new(Notify::new()),
            },
        );
        assert!(ps.cancel("sid"));
        // Both maps must be empty so a stale cancel returns false.
        assert!(!ps.cancel("sid"));
        assert!(ps.take("sid").is_none());
    }

    #[test]
    fn cancel_notify_helper_removes_entry_from_notifier_map() {
        let ps = PendingOAuthState::new();
        let (_tx, rx) = tokio::sync::oneshot::channel::<Result<AuthCallback, String>>();
        ps.insert(
            "sid".to_string(),
            PendingOAuth {
                verifier: PkceVerifier("v".to_string()),
                redirect_uri: "http://127.0.0.1:1".to_string(),
                client_id: "cid".to_string(),
                client_secret: "sec".to_string(),
                state_param: "s".to_string(),
                callback_rx: rx,
                cancel_notify: Arc::new(Notify::new()),
            },
        );
        assert!(ps.cancel_notify("sid").is_some());
        ps.remove_cancel_notify("sid");
        assert!(ps.cancel_notify("sid").is_none());
    }

    // ─── V1 keyring tests removed (Phase 2) ─────────────────────────────────
    //
    // The following tests were removed because their V1 functions are now stubs:
    //   - make_fake_io_with_cloud_keyring (helper)
    //   - connect_adopts_cloud_key_when_fingerprint_differs
    //   - connect_rolls_back_when_swap_fails_wrong_password
    //   - try_reupload_keyring_with_io_uploads_ok
    //   - try_reupload_keyring_with_io_returns_err_on_write_failure
    //   - reupload_and_update_dirty_flag_clears_flag_on_success
    //   - reupload_and_update_dirty_flag_sets_flag_on_failure
    //   - build_keyring_for_reupload_fails_when_wrapped_key_missing
    //   - build_keyring_for_reupload_fails_when_kek_salt_missing
    //   - build_keyring_for_reupload_succeeds_with_full_setup
    //   - disconnect_does_not_delete_keyring
    //   - startup_reconcile_noop_when_no_keyring_on_drive
    //   - startup_reconcile_noop_when_fingerprints_match
    //   - startup_reconcile_swaps_key_on_fingerprint_mismatch
    //   - startup_reconcile_swallows_download_error
    //   - startup_reconcile_outer_skips_when_not_connected
    //   - startup_reconcile_swallows_wrong_password_swap_failure
    //   - startup_reconcile_outer_skips_for_non_gdrive_provider
    // Phase 3 will add V2 equivalents.

    // ─── wipe_v1_keyring_if_present ─────────────────────────────────────────

    struct FakeV1KeyringIo {
        /// When `Some`, return these bytes as the keyring.json content.
        /// When `None`, return NotFound.
        keyring_bytes: Option<Vec<u8>>,
        /// Track whether delete_file was called.
        delete_called: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl FakeV1KeyringIo {
        fn present(bytes: Vec<u8>) -> Self {
            Self {
                keyring_bytes: Some(bytes),
                delete_called: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }
        }

        fn absent() -> Self {
            Self {
                keyring_bytes: None,
                delete_called: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }
        }
    }

    #[async_trait::async_trait]
    impl crate::sync::keyring_v2::KeyringV2Io for FakeV1KeyringIo {
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, crate::sync::provider::SyncError> {
            match &self.keyring_bytes {
                Some(b) => Ok(b.clone()),
                None => Err(crate::sync::provider::SyncError::NotFound(path.to_string())),
            }
        }

        async fn write_file(
            &self,
            _path: &str,
            _data: &[u8],
        ) -> Result<(), crate::sync::provider::SyncError> {
            Ok(())
        }

        async fn delete_file(&self, _path: &str) -> Result<(), crate::sync::provider::SyncError> {
            self.delete_called
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }

        async fn list_files(
            &self,
            _prefix: &str,
        ) -> Result<Vec<String>, crate::sync::provider::SyncError> {
            Ok(vec![])
        }
    }

    #[tokio::test]
    async fn v1_wipe_returns_ok_false_when_absent() {
        let state = make_state();
        let io = FakeV1KeyringIo::absent();
        let result = wipe_v1_keyring_if_present(&io, &state).await;
        assert!(
            matches!(result, Ok(false)),
            "expected Ok(false) when no V1 keyring, got {result:?}"
        );
        assert!(
            !io.delete_called.load(std::sync::atomic::Ordering::SeqCst),
            "delete must not be called when no V1 keyring"
        );
    }

    #[tokio::test]
    async fn v1_wipe_deletes_file_and_resets_local_state_when_present() {
        let state = make_state();
        // Pre-load some encryption state to verify it gets cleared.
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, "deadbeef").unwrap();
            db::set_setting(&conn, db::KEK_SALT_KEY, "cafebabe").unwrap();
            db::set_setting(&conn, "password_hash", "hash123").unwrap();
            db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1").unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
            // Seed a STANDING force-re-pair flag: the wipe must clear it, or
            // the user is stranded on ForceRePairScreen with no Drive session.
            set_force_re_pair_flags(&conn, "vault_rotated").unwrap();
        }

        let io = FakeV1KeyringIo::present(b"old-keyring-bytes".to_vec());
        let result = wipe_v1_keyring_if_present(&io, &state).await;

        // Must return Err with V1_WIPE_COMPLETE_RECONNECT_REQUIRED.
        assert!(
            matches!(&result, Err(e) if e.starts_with("V1_WIPE_COMPLETE_RECONNECT_REQUIRED")),
            "expected V1_WIPE_COMPLETE_RECONNECT_REQUIRED error, got {result:?}"
        );

        // delete_file must have been called.
        assert!(
            io.delete_called.load(std::sync::atomic::Ordering::SeqCst),
            "delete_file must be called on V1 keyring"
        );

        // Local encryption state must be reset.
        let conn = state.lock().unwrap();
        assert!(
            db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
                .unwrap()
                .is_none(),
            "wrapped_encryption_key must be cleared"
        );
        assert!(
            db::get_setting(&conn, db::KEK_SALT_KEY).unwrap().is_none(),
            "kek_salt must be cleared"
        );
        assert!(
            db::get_setting(&conn, "password_hash").unwrap().is_none(),
            "password_hash must be cleared"
        );
        assert!(
            db::get_setting(&conn, db::KEYRING_DIRTY_KEY)
                .unwrap()
                .is_none(),
            "keyring_dirty must be cleared"
        );
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Unset,
            "encryption_mode must be reset to Unset"
        );
        // B3/B5 invariant: the wipe just cleared the OAuth token, so it must
        // NEVER leave the force-re-pair flag set — a set flag with no Drive
        // session would strand the user on ForceRePairScreen with no way out.
        assert_eq!(
            crate::commands::crypto::get_force_re_pair_status_inner(&conn).unwrap(),
            None,
            "v1_wipe must not leave force-re-pair required"
        );
        assert!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
                .unwrap()
                .is_none(),
            "v1_wipe must not write a force_re_pair_reason breadcrumb (nothing reads it)"
        );
    }

    // ─── publish_v2_keyring_with_provider (I2) ──────────────────────────────

    fn make_publish_ctx() -> crate::commands::crypto::V2KeyringPublishContext {
        crate::commands::crypto::V2KeyringPublishContext {
            // recovery_wrapped: 120 hex chars (nonce=24 + ct=64 + tag=32)
            recovery_wrapped: "ab".repeat(60),
            device_id: "11111111-2222-3333-4444-555555555555".to_string(),
            device_name: "Test Mac".to_string(),
            // master_fingerprint: 64 hex chars (HMAC-SHA256)
            master_fingerprint: "a1".repeat(32),
            // Three distinct values so the test can prove each landed in the
            // right place: vault created_at (recovery/meta), device join time
            // (device slot created_at), and last_seen_at (device slot).
            created_at: 1_700_000_000,
            device_created_at: 1_700_005_555,
            last_seen_at: 1_700_009_999,
            // wrapped_content_v1: 120 hex chars (AES-GCM(master, v1))
            wrapped_content_v1: "cc".repeat(60),
            // content_fingerprint_v1: 64 hex chars (HMAC-SHA256)
            content_fingerprint_v1: "dd".repeat(32),
        }
    }

    /// I2: publish_v2_keyring_with_provider writes _meta.json, _recovery.json,
    /// and devices/<id>.json to the provider.
    #[tokio::test]
    async fn publish_v2_keyring_with_provider_writes_all_three_files() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::io::{read_device_slot, read_meta, read_recovery};

        let provider = InMemoryKeyringProvider::new();
        let state = make_state(); // no active rotation job — publish should succeed
        {
            let conn = state.lock().unwrap();
            db::set_sync_recovery_generation(&conn, 7).unwrap();
        }
        let ctx = make_publish_ctx();
        let key_state = EncryptionKeyState::new();

        publish_v2_keyring_with_provider(&provider, &state, &ctx, &key_state)
            .await
            .expect("publish must succeed");

        // Recovery slot must exist and match.
        let recovery = read_recovery(&provider)
            .await
            .expect("read_recovery failed")
            .expect("_recovery.json must exist");
        assert_eq!(recovery.wrapped_master, ctx.recovery_wrapped);

        // Device slot must exist and match.
        let device = read_device_slot(&provider, &ctx.device_id)
            .await
            .expect("read_device_slot failed")
            .expect("device slot must exist");
        assert_eq!(device.name, ctx.device_name);
        {
            // Read RAW bytes off the provider — asserting via the parsed
            // `DeviceSlotV2` would be meaningless, since that struct cannot
            // carry these fields anymore by construction.
            use crate::sync::keyring_v2::KeyringV2Io;
            let raw = provider
                .read_file(&crate::sync::keyring_v2::io::device_slot_path(
                    &ctx.device_id,
                ))
                .await
                .unwrap();
            let raw_text = String::from_utf8_lossy(&raw);
            assert!(
                !raw_text.contains("wrapped_master") && !raw_text.contains("kek_salt"),
                "device slot must carry no key material: {raw_text}"
            );
        }
        // Device slot created_at must come from device_created_at (the local
        // devices row), NOT the vault created_at — they are distinct concepts.
        assert_eq!(device.created_at, ctx.device_created_at);
        // last_seen_at must come from ctx.last_seen_at, not created_at.
        assert_eq!(device.last_seen_at, ctx.last_seen_at);

        // Recovery slot created_at must be the VAULT created_at.
        assert_eq!(recovery.created_at, ctx.created_at);

        // Meta must exist and match. created_at/updated_at are the vault time.
        let meta = read_meta(&provider)
            .await
            .expect("read_meta failed")
            .expect("_meta.json must exist");
        assert_eq!(meta.epoch, 1);
        assert_eq!(meta.master_fingerprint, ctx.master_fingerprint);
        assert_eq!(meta.recovery_generation, 7);
        assert_eq!(meta.created_at, ctx.created_at);
    }

    /// Delayed connect publish: local DB still at generation 0 while control is
    /// already N. Explicit override must plant `_meta.json.recovery_generation=N`
    /// (not stale local 0).
    #[tokio::test]
    async fn delayed_publish_uses_candidate_generation_not_stale_local_zero() {
        use crate::sync::keyring_v2::io::read_meta;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let provider = InMemoryKeyringProvider::new();
        let state = make_state();
        // Local deliberately left at 0 — the pre-Ready connect state.
        {
            let conn = state.lock().unwrap();
            assert_eq!(db::get_sync_recovery_generation(&conn).unwrap(), 0);
        }
        let ctx = make_publish_ctx();
        let key_state = EncryptionKeyState::new();

        publish_v2_keyring_with_provider_for_generation(
            &provider,
            &state,
            &ctx,
            &key_state,
            Some(5),
        )
        .await
        .expect("publish with candidate generation must succeed");

        let meta = read_meta(&provider)
            .await
            .expect("read_meta failed")
            .expect("_meta.json must exist");
        assert_eq!(
            meta.recovery_generation, 5,
            "delayed publish must use control candidate, not local 0"
        );
        // Local DB must remain unadopted until Ready commits generation.
        {
            let conn = state.lock().unwrap();
            assert_eq!(db::get_sync_recovery_generation(&conn).unwrap(), 0);
        }
    }

    /// Without override, publish still reads generation from local DB.
    #[tokio::test]
    async fn publish_without_override_uses_local_generation() {
        use crate::sync::keyring_v2::io::read_meta;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let provider = InMemoryKeyringProvider::new();
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_sync_recovery_generation(&conn, 2).unwrap();
        }
        let ctx = make_publish_ctx();
        let key_state = EncryptionKeyState::new();

        publish_v2_keyring_with_provider(&provider, &state, &ctx, &key_state)
            .await
            .expect("publish must succeed");

        let meta = read_meta(&provider)
            .await
            .expect("read_meta")
            .expect("meta");
        assert_eq!(meta.recovery_generation, 2);
    }

    #[tokio::test]
    async fn revalidate_connect_control_authority_rejects_mid_flow_lease() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::{RecoveryMarker, RECOVERY_MARKER_VERSION};
        use crate::sync::recovery::{
            acquire_recovery_lease, bootstrap_sync_control, read_versioned_sync_control,
        };
        use crate::sync::sync_control::{SyncControlV1, SYNC_CONTROL_VERSION};

        let provider = InMemoryKeyringProvider::new();
        bootstrap_sync_control(&provider, 1).await.unwrap();
        // Bump control generation to 1 with no lease so a later acquire is gen+1.
        {
            use crate::sync::keyring_v2::KeyringV2Io;
            let bumped = SyncControlV1 {
                version: SYNC_CONTROL_VERSION,
                recovery_generation: 1,
                recovery_lease: None,
                updated_at: 2,
            };
            provider
                .write_file(
                    crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH,
                    &serde_json::to_vec(&bumped).unwrap(),
                )
                .await
                .unwrap();
        }
        let (control, revision) = read_versioned_sync_control(&provider).await.unwrap();
        assert_eq!(control.recovery_generation, 1);
        assert!(
            revalidate_connect_control_authority(&provider, 1, &revision)
                .await
                .is_ok()
        );

        let mut marker = RecoveryMarker {
            version: RECOVERY_MARKER_VERSION,
            job_id: 1,
            owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
            operation: "local_to_cloud".to_string(),
            recovery_generation: 2,
            nonce: "0123456789abcdef".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        // acquire_recovery_lease requires gen = control+1
        marker.recovery_generation = 2;
        acquire_recovery_lease(&provider, &marker).await.unwrap();

        let err = revalidate_connect_control_authority(&provider, 1, &revision)
            .await
            .unwrap_err();
        assert!(
            err.contains("AUTHORITATIVE_RECOVERY_IN_PROGRESS")
                || err.contains("RECOVERY_CONTROL_CHANGED"),
            "expected lease/control change rejection, got {err}"
        );
    }

    /// F1: after a key rotation (epoch 1 → 2), a keyring re-upload must publish
    /// BOTH epochs to `_content.json` and set `_meta.json.content_epoch = 2`.
    ///
    /// This is the regression test for F1: when key_state is initialized with the
    /// full content-key list, publish_v2_keyring_with_provider must read
    /// WRAPPED_CONTENT_LIST from the DB (which holds all epochs) rather than
    /// only writing the epoch-1 data from ctx.
    #[tokio::test]
    async fn publish_keyring_after_rotation_writes_all_epochs_to_content_list() {
        use crate::sync::keyring_v2::io::{
            read_content, read_meta, test_support::InMemoryKeyringProvider,
        };
        use crate::utils::encryption::{
            derive_sync_key, encode_content_key_list, key_fingerprint, wrap_content_key,
        };
        use rand::{rngs::OsRng, RngCore};
        use std::collections::BTreeMap;
        use zeroize::Zeroizing;

        // Generate master key + two independent content keys.
        let mut master_raw = [0u8; 32];
        OsRng.fill_bytes(&mut master_raw);
        let master = Zeroizing::new(master_raw);

        let mut ck1_raw = [0u8; 32];
        OsRng.fill_bytes(&mut ck1_raw);
        let ck1 = Zeroizing::new(ck1_raw);

        let mut ck2_raw = [0u8; 32];
        OsRng.fill_bytes(&mut ck2_raw);
        let ck2 = Zeroizing::new(ck2_raw);

        // Build WRAPPED_CONTENT_LIST (compact hex: epoch(8 hex) + wrapped(120 hex) per slot).
        let mut key_map: BTreeMap<u32, Zeroizing<[u8; 32]>> = BTreeMap::new();
        key_map.insert(1, ck1.clone());
        key_map.insert(2, ck2.clone());
        let list_hex = encode_content_key_list(&master, &key_map).expect("encode_content_key_list");

        // Compute expected fingerprints: key_fingerprint(derive_sync_key(ck)).
        let fp1 = hex::encode(key_fingerprint(&*derive_sync_key(&*ck1)));
        let fp2 = hex::encode(key_fingerprint(&*derive_sync_key(&*ck2)));

        // Wrap ck1 for the ctx (epoch-1 fallback path — should NOT be used).
        let wrapped_v1 = hex::encode(wrap_content_key(&master, &ck1).expect("wrap_content_key"));

        // Build ctx (epoch-1 values only — these should be ignored when key_state is set).
        let ctx = crate::commands::crypto::V2KeyringPublishContext {
            recovery_wrapped: "ab".repeat(60),
            device_id: "11111111-2222-3333-4444-555555555555".to_string(),
            device_name: "Test Mac".to_string(),
            master_fingerprint: "a1".repeat(32),
            created_at: 1_700_000_000,
            device_created_at: 1_700_005_555,
            last_seen_at: 1_700_009_999,
            wrapped_content_v1: wrapped_v1,
            content_fingerprint_v1: fp1.clone(),
        };

        // Set up state with WRAPPED_CONTENT_LIST (epoch 1+2) in DB.
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &list_hex).unwrap();
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "2").unwrap();
            db::upsert_device(
                &conn,
                &crate::db::DeviceRow {
                    device_id: ctx.device_id.clone(),
                    name: ctx.device_name.clone(),
                    created_at: ctx.created_at,
                    last_seen_at: ctx.created_at,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();
            db::set_current_device(&conn, &ctx.device_id).unwrap();
        }

        // Initialize key_state with both epochs.
        let key_state = EncryptionKeyState::new();
        key_state
            .set_content_state(key_map, 2, ck2.clone(), master.clone())
            .expect("set_content_state");

        let provider = InMemoryKeyringProvider::new();
        publish_v2_keyring_with_provider(&provider, &state, &ctx, &key_state)
            .await
            .expect("publish must succeed");

        // _content.json must have 2 entries.
        let content = read_content(&provider)
            .await
            .expect("read_content failed")
            .expect("_content.json must exist");
        assert_eq!(
            content.entries.len(),
            2,
            "_content.json must contain both epochs after rotation"
        );
        assert_eq!(content.latest_epoch, 2, "latest_epoch must be 2");
        assert_eq!(content.entries[0].epoch, 1, "first entry epoch must be 1");
        assert_eq!(content.entries[1].epoch, 2, "second entry epoch must be 2");
        assert_eq!(
            content.entries[0].content_fingerprint, fp1,
            "epoch-1 fingerprint mismatch"
        );
        assert_eq!(
            content.entries[1].content_fingerprint, fp2,
            "epoch-2 fingerprint mismatch"
        );

        // _meta.json must have content_epoch = 2.
        let meta = read_meta(&provider)
            .await
            .expect("read_meta failed")
            .expect("_meta.json must exist");
        assert_eq!(
            meta.content_epoch, 2,
            "_meta.json.content_epoch must be 2 after rotation"
        );
    }

    /// I2: when no Drive session is available, try_publish_v2_keyring_after_setup
    /// sets keyring_dirty = "1" and returns without error.
    #[tokio::test]
    async fn try_publish_sets_dirty_when_no_session() {
        let state = make_state();
        // No gdrive_refresh_token → reconstruct_session returns None.
        let ctx = make_publish_ctx();
        let key_state = EncryptionKeyState::new();

        try_publish_v2_keyring_after_setup(&state, &key_state, ctx).await;

        let conn = state.lock().unwrap();
        assert_eq!(
            db::get_setting(&conn, db::KEYRING_DIRTY_KEY)
                .unwrap()
                .as_deref(),
            Some("1"),
            "keyring_dirty must be set to '1' when no session is available"
        );
    }

    /// I1: after V1 wipe, OAuth tokens and sync_connected must also be cleared
    /// (not just encryption state), so the app is not left in a half-state.
    #[tokio::test]
    async fn v1_wipe_clears_oauth_tokens_and_sync_connected() {
        let state = make_state();
        // Pre-load OAuth tokens as if Drive was connected.
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "gdrive_refresh_token", "tok-abc123").unwrap();
            db::set_setting(&conn, "gdrive_root_folder_id", "folder-xyz").unwrap();
            db::set_setting(&conn, "sync_connected", "true").unwrap();
            db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, "deadbeef").unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        }

        let io = FakeV1KeyringIo::present(b"old-keyring".to_vec());
        let result = wipe_v1_keyring_if_present(&io, &state).await;

        assert!(
            matches!(&result, Err(e) if e.starts_with("V1_WIPE_COMPLETE_RECONNECT_REQUIRED")),
            "expected V1_WIPE_COMPLETE_RECONNECT_REQUIRED error, got {result:?}"
        );

        let conn = state.lock().unwrap();
        // OAuth tokens must be gone.
        assert!(
            db::get_setting(&conn, "gdrive_refresh_token")
                .unwrap()
                .is_none(),
            "gdrive_refresh_token must be cleared"
        );
        assert!(
            db::get_setting(&conn, "gdrive_root_folder_id")
                .unwrap()
                .is_none(),
            "gdrive_root_folder_id must be cleared"
        );
        // sync_connected must be gone.
        let sync_connected = db::get_setting(&conn, "sync_connected").unwrap();
        assert!(
            sync_connected.is_none() || sync_connected.as_deref() == Some("false"),
            "sync_connected must be cleared or false after wipe, got {sync_connected:?}"
        );
        // Encryption mode must be unset.
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Unset,
            "encryption_mode must be Unset after wipe"
        );
        // B3/B5 invariant: token cleared ⇒ force-re-pair flag must NOT be set,
        // otherwise the user lands on ForceRePairScreen with no Drive session
        // to re-pair against (no route out from a cold start).
        assert_eq!(
            crate::commands::crypto::get_force_re_pair_status_inner(&conn).unwrap(),
            None,
            "v1_wipe must never clear the Drive token while leaving force-re-pair set"
        );
    }

    // ─── C4: wipe_v1_keyring_if_present — fail-loud on delete error ──────────

    struct FailingDeleteIo;

    #[async_trait::async_trait]
    impl crate::sync::keyring_v2::KeyringV2Io for FailingDeleteIo {
        async fn read_file(
            &self,
            _path: &str,
        ) -> Result<Vec<u8>, crate::sync::provider::SyncError> {
            // Always returns content — V1 keyring is "present".
            Ok(b"keyring-bytes".to_vec())
        }

        async fn write_file(
            &self,
            _path: &str,
            _data: &[u8],
        ) -> Result<(), crate::sync::provider::SyncError> {
            Ok(())
        }

        async fn delete_file(&self, path: &str) -> Result<(), crate::sync::provider::SyncError> {
            Err(crate::sync::provider::SyncError::Io(format!(
                "forced delete error for {path}"
            )))
        }

        async fn list_files(
            &self,
            _prefix: &str,
        ) -> Result<Vec<String>, crate::sync::provider::SyncError> {
            Ok(vec![])
        }
    }

    /// C4: wipe_v1_keyring_if_present must return Err when the cloud delete
    /// fails — previously it swallowed delete errors and returned Ok(false),
    /// leaving the V1 file in place and repeating the loop on every connect.
    #[tokio::test]
    async fn v1_wipe_returns_err_when_delete_fails() {
        let state = make_state();
        let io = FailingDeleteIo;
        let result = wipe_v1_keyring_if_present(&io, &state).await;
        assert!(
            matches!(&result, Err(e) if e.contains("v1_wipe: failed to delete")),
            "expected a v1_wipe delete error, got {result:?}"
        );
    }

    // ─── I1: try_reupload_keyring — full implementation tests ────────────────

    fn seed_password_mode_state(
        state: &AppState,
        ctx: &crate::commands::crypto::V2KeyringPublishContext,
    ) {
        let conn = state.lock().unwrap();
        db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        // Local password-wrap material — unrelated to the (metadata-only) cloud
        // device slot, so it is seeded directly rather than sourced from ctx.
        db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &"cd".repeat(67)).unwrap();
        db::set_setting(&conn, db::KEK_SALT_KEY, &"ef".repeat(16)).unwrap();
        db::set_setting(
            &conn,
            db::RECOVERY_WRAPPED_MASTER_KEY,
            &ctx.recovery_wrapped,
        )
        .unwrap();
        db::set_setting(&conn, db::CLOUD_MASTER_FINGERPRINT, &ctx.master_fingerprint).unwrap();
        db::set_setting(
            &conn,
            db::RECOVERY_PASSPHRASE_CREATED_AT,
            &ctx.created_at.to_string(),
        )
        .unwrap();
        // Seed content-key material needed by extract_v1_content_for_publish.
        // Build a minimal compact list: epoch=1 (8 hex) + wrapped_content (120 hex) = 128 hex.
        let fake_slot = format!("{:08x}{}", 1u32, &ctx.wrapped_content_v1);
        db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &fake_slot).unwrap();
        db::set_setting(
            &conn,
            db::CLOUD_CONTENT_FINGERPRINT,
            &ctx.content_fingerprint_v1,
        )
        .unwrap();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: ctx.device_id.clone(),
                name: ctx.device_name.clone(),
                created_at: ctx.created_at,
                last_seen_at: ctx.created_at,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();
        db::set_current_device(&conn, &ctx.device_id).unwrap();
    }

    /// I1: try_reupload_keyring returns Err (no session) when no cloud
    /// provider is connected, so keyring_dirty is NOT cleared by
    /// apply_dirty_flag_result.
    #[tokio::test]
    async fn try_reupload_keyring_returns_err_when_not_connected() {
        let state = make_state();
        let key_state = EncryptionKeyState::new();
        let ctx = make_publish_ctx();
        seed_password_mode_state(&state, &ctx);
        // No configured provider → acquire_cloud_provider returns Err.

        let result = try_reupload_keyring(&state, &key_state).await;
        assert!(
            result.is_err(),
            "expected Err when no cloud provider is connected, got Ok"
        );
        assert!(
            result.unwrap_err().contains("No cloud provider connected"),
            "error should mention that no cloud provider is connected"
        );
    }

    /// I1: try_reupload_keyring returns Err when recovery_wrapped_master is
    /// absent from settings (incomplete local state).
    #[tokio::test]
    async fn try_reupload_keyring_returns_err_when_key_material_missing() {
        let state = make_state();
        let key_state = EncryptionKeyState::new();
        // Do NOT seed RECOVERY_WRAPPED_MASTER_KEY.
        {
            let conn = state.lock().unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        }

        let result = try_reupload_keyring(&state, &key_state).await;
        assert!(result.is_err(), "expected Err when key material is missing");
    }

    // ─── I4: detect_force_re_pair || semantics ───────────────────────────────

    /// I4: detect_force_re_pair fires when fingerprint differs even without epoch advance.
    #[tokio::test]
    async fn detect_force_re_pair_triggers_on_fingerprint_change_without_epoch_advance() {
        use crate::sync::keyring_v2::io::{test_support::InMemoryKeyringProvider, write_meta};
        use crate::sync::keyring_v2::types::{KeyringMetaV2, KEYRING_V2_VERSION};

        let provider = InMemoryKeyringProvider::new();
        let state = make_state();

        let local_fp = "aa".repeat(32); // 64 hex chars
        let cloud_fp = "bb".repeat(32); // different fingerprint
        let shared_epoch = 5u64;

        // Store local epoch + fingerprint.
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, db::CLOUD_MASTER_FINGERPRINT, &local_fp).unwrap();
            db::set_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH, &shared_epoch.to_string()).unwrap();
        }

        // Cloud has SAME epoch but DIFFERENT fingerprint.
        let meta = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: shared_epoch, // same epoch — bug was && instead of ||
            master_fingerprint: cloud_fp,
            content_epoch: 0,
            recovery_generation: 0,
            created_at: 0,
            updated_at: 0,
        };
        write_meta(&provider, &meta).await.unwrap();

        let result = detect_force_re_pair(&provider, &state).await.unwrap();
        assert!(
            matches!(result, ForceRePairCheck::Mismatch(_)),
            "detect_force_re_pair must fire on fingerprint mismatch even without epoch advance \
             — and must never report Verified, which would clear the fail-closed flag"
        );
    }

    // ─── C2: publish gate during active rotation ─────────────────────────────

    fn insert_active_rotation_job(state: &AppState) {
        let conn = state.lock().unwrap();
        db::insert_rotation_job(&conn, "fp-old", "fp-new", 1, 2, None).unwrap();
        // Default state is "enumerate" — that's an active job.
    }

    /// C2: publish_v2_keyring_with_provider refuses when a rotation is active.
    /// This is the central gate — all external publish paths route through it.
    #[tokio::test]
    async fn publish_v2_keyring_refuses_during_active_rotation() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let state = make_state();
        let ctx = make_publish_ctx();
        insert_active_rotation_job(&state);

        let provider = InMemoryKeyringProvider::new();
        let key_state = EncryptionKeyState::new();
        let result = publish_v2_keyring_with_provider(&provider, &state, &ctx, &key_state).await;
        assert!(result.is_err(), "expected Err during active rotation");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("rotation is in progress"),
            "error must mention rotation: {msg}"
        );
    }

    /// C2: try_reupload_keyring_with_provider also refuses when a rotation is active
    /// (via the publish_v2_keyring_with_provider gate).
    #[tokio::test]
    async fn try_reupload_keyring_refuses_during_active_rotation() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let state = make_state();
        let ctx = make_publish_ctx();
        seed_password_mode_state(&state, &ctx);
        insert_active_rotation_job(&state);

        let provider = InMemoryKeyringProvider::new();
        let key_state = EncryptionKeyState::new();
        let result = try_reupload_keyring_with_provider(&state, &provider, &key_state).await;
        assert!(result.is_err(), "expected Err during active rotation");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("rotation is in progress"),
            "error must mention rotation: {msg}"
        );
    }

    // ─── resolve_unset_outcome_and_stash ────────────────────────────────────

    /// Helper: build a minimal GDriveSession for tests.
    fn make_gdrive_session(tag: &str) -> GDriveSession {
        GDriveSession {
            access_token: format!("at_{tag}"),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
            refresh_token: zeroize::Zeroizing::new(format!("rt_{tag}")),
            client_id: format!("cid_{tag}"),
            client_secret: format!("cs_{tag}"),
        }
    }

    /// Test 1: NeedsOnboarding for Unset — session is stashed, DB untouched.
    ///
    /// Simulates: cloud keyring present (V2 vault exists).
    /// The Unset path must NOT call persist_connect_settings, so the DB
    /// remains clean. The pending map must hold the stashed session.
    #[test]
    #[serial_test::serial]
    fn needs_onboarding_for_unset_stashes_session_and_does_not_persist() {
        use crate::commands::pending_drive_session;
        pending_drive_session::reset();

        let state = make_state();
        // Ensure encryption_mode is Unset (default after migration, but explicit).
        {
            let conn = state.lock().unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Unset).unwrap();
        }

        let session = make_gdrive_session("onboard");
        let session_id = "test-onboard-sid";

        let outcome = resolve_unset_outcome_and_stash(
            session_id,
            crate::commands::pending_drive_session::PendingCloudSession::GDrive {
                session,
                root_folder_id: "root-folder-id".to_string(),
            },
            true, // cloud keyring present → NeedsOnboarding
        );

        // Outcome must be NeedsOnboarding.
        assert!(
            matches!(outcome, GdriveConnectOutcome::NeedsOnboarding),
            "expected NeedsOnboarding, got {outcome:?}"
        );

        // DB must have no sync_connected or gdrive_refresh_token.
        let conn = state.lock().unwrap();
        let sync_connected = db::get_setting(&conn, "sync_connected").unwrap();
        assert!(
            sync_connected.is_none() || sync_connected.as_deref() == Some("false"),
            "sync_connected must not be set, got {sync_connected:?}"
        );
        let token = db::get_setting(&conn, "gdrive_refresh_token").unwrap();
        assert!(token.is_none(), "gdrive_refresh_token must not be set");

        // Pending map must hold the stashed session.
        let pending = pending_drive_session::consume(session_id);
        assert!(pending.is_some(), "pending session must be stashed");
        let pending = pending.unwrap();
        match pending {
            crate::commands::pending_drive_session::PendingCloudSession::GDrive {
                session,
                root_folder_id,
            } => {
                assert_eq!(root_folder_id, "root-folder-id");
                assert_eq!(session.access_token, "at_onboard");
            }
            crate::commands::pending_drive_session::PendingCloudSession::Folder { .. } => {
                panic!("expected GDrive pending session")
            }
        }
    }

    /// Test 2: NeedsFirstTimeSetup for Unset — session is stashed, DB untouched.
    ///
    /// Simulates: cloud is empty (no keyring).
    #[test]
    #[serial_test::serial]
    fn needs_first_time_setup_for_unset_stashes_session_and_does_not_persist() {
        use crate::commands::pending_drive_session;
        pending_drive_session::reset();

        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Unset).unwrap();
        }

        let session = make_gdrive_session("setup");
        let session_id = "test-setup-sid";

        let outcome = resolve_unset_outcome_and_stash(
            session_id,
            crate::commands::pending_drive_session::PendingCloudSession::GDrive {
                session,
                root_folder_id: "root-folder-setup".to_string(),
            },
            false, // no cloud keyring → NeedsFirstTimeSetup
        );

        assert!(
            matches!(outcome, GdriveConnectOutcome::NeedsFirstTimeSetup),
            "expected NeedsFirstTimeSetup, got {outcome:?}"
        );

        // DB must remain clean.
        let conn = state.lock().unwrap();
        let sync_connected = db::get_setting(&conn, "sync_connected").unwrap();
        assert!(
            sync_connected.is_none() || sync_connected.as_deref() == Some("false"),
            "sync_connected must not be set"
        );
        assert!(
            db::get_setting(&conn, "gdrive_refresh_token")
                .unwrap()
                .is_none(),
            "gdrive_refresh_token must not be set"
        );

        // Pending map must hold the session.
        let pending = pending_drive_session::consume(session_id);
        assert!(
            pending.is_some(),
            "pending session must be stashed for NeedsFirstTimeSetup"
        );
        match pending.unwrap() {
            crate::commands::pending_drive_session::PendingCloudSession::GDrive {
                root_folder_id,
                ..
            } => assert_eq!(root_folder_id, "root-folder-setup"),
            crate::commands::pending_drive_session::PendingCloudSession::Folder { .. } => {
                panic!("expected GDrive pending session")
            }
        }
    }

    /// Test 4: V1WipedReconnectRequired for Unset — nothing stashed, DB untouched.
    ///
    /// The V1 wipe path in `gdrive_complete_connect` returns early before the
    /// Unset branch — wipe_v1_keyring_if_present already covers this. This
    /// test confirms the pending map stays empty for that outcome by calling
    /// the wipe helper directly and asserting `consume` returns None.
    #[tokio::test]
    #[serial_test::serial]
    async fn v1_wiped_for_unset_does_not_stash_or_persist() {
        use crate::commands::pending_drive_session;
        pending_drive_session::reset();

        let state = make_state();
        {
            let conn = state.lock().unwrap();
            // Start in Unset mode (welcome screen).
            db::set_encryption_mode(&conn, db::EncryptionMode::Unset).unwrap();
        }

        let session_id = "test-v1wipe-sid";

        // Simulate a V1 keyring being present — wipe returns the terminal error.
        let io = FakeV1KeyringIo::present(b"v1-keyring".to_vec());
        let result = wipe_v1_keyring_if_present(&io, &state).await;
        assert!(
            matches!(&result, Err(e) if e.starts_with("V1_WIPE_COMPLETE_RECONNECT_REQUIRED")),
            "expected V1_WIPE_COMPLETE_RECONNECT_REQUIRED, got {result:?}"
        );

        // The wipe path never calls resolve_unset_outcome_and_stash, so the
        // pending map must remain empty.
        assert!(
            pending_drive_session::consume(session_id).is_none(),
            "pending map must be empty after V1 wipe"
        );

        // DB must not have sync_connected or gdrive_refresh_token
        // (persist_connect_settings was gated on !is_unset_mode).
        let conn = state.lock().unwrap();
        assert!(
            db::get_setting(&conn, "sync_connected").unwrap().is_none(),
            "sync_connected must not be set after V1 wipe in Unset mode"
        );
        assert!(
            db::get_setting(&conn, "gdrive_refresh_token")
                .unwrap()
                .is_none(),
            "gdrive_refresh_token must not be set after V1 wipe in Unset mode"
        );
    }

    /// Test 5 (regression): Password mode persist_connect_settings is unchanged.
    ///
    /// This existing test (`persist_connect_settings_enables_sync`) already
    /// covers the password-mode path. This test is added as an explicit
    /// regression marker to confirm the DB is written for Password mode.
    #[test]
    fn password_mode_connect_still_persists_immediately() {
        // This test mirrors `persist_connect_settings_enables_sync` to
        // explicitly document the regression expectation for the gated block.
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        }

        // Simulate the persist block (is_unset_mode = false → block runs).
        {
            let conn = state.lock().unwrap();
            persist_connect_settings(&conn, &gdrive_pending_token("fake-token-password")).unwrap();
        }

        let conn = state.lock().unwrap();
        assert_eq!(
            db::get_setting(&conn, "sync_connected").unwrap().as_deref(),
            Some("true"),
            "sync_connected must be true after password-mode connect"
        );
        assert_eq!(
            db::get_setting(&conn, "gdrive_refresh_token")
                .unwrap()
                .as_deref(),
            Some("fake-token-password"),
            "gdrive_refresh_token must be persisted for password mode"
        );
    }

    // ─── I5: resolve_force_re_pair_outcome (fail-closed) ────────────────────

    /// I5-a (RED→GREEN): Ok(Verified) maps to Verified — normal reconnect is allowed.
    #[test]
    fn resolve_force_re_pair_outcome_verified_on_ok_verified() {
        let decision = resolve_force_re_pair_outcome(Ok(ForceRePairCheck::Verified));
        assert!(
            matches!(decision, ForceRePairDecision::Verified),
            "Ok(Verified) must map to Verified"
        );
    }

    /// Ok(Skipped) must map to Skipped, NOT Verified.
    ///
    /// Regression guard for fail-open: `Skipped` means "nothing to compare"
    /// (no cloud `_meta.json`, or no local fingerprint). If it collapsed into
    /// `Verified`, the Verified arm would clear the fail-closed flag on the
    /// strength of a check that never actually ran.
    #[test]
    fn resolve_force_re_pair_outcome_skipped_is_not_verified() {
        let decision = resolve_force_re_pair_outcome(Ok(ForceRePairCheck::Skipped));
        assert!(
            matches!(decision, ForceRePairDecision::Skipped),
            "Ok(Skipped) must map to Skipped — collapsing it into Verified is fail-open"
        );
    }

    /// I5-b (RED→GREEN): Ok(Mismatch(_)) maps to NeedsRepair — vault was rotated.
    #[test]
    fn resolve_force_re_pair_outcome_needs_repair_on_ok_mismatch() {
        let mismatch = ForceRePairMismatch {
            reason: "vault rotated".to_string(),
            cloud_epoch: 7,
        };
        let decision = resolve_force_re_pair_outcome(Ok(ForceRePairCheck::Mismatch(mismatch)));
        match decision {
            ForceRePairDecision::NeedsRepair(m) => {
                assert_eq!(m.reason, "vault rotated");
                assert_eq!(m.cloud_epoch, 7);
            }
            other => panic!(
                "Ok(Mismatch) must map to NeedsRepair, got {:?}",
                match other {
                    ForceRePairDecision::Verified => "Verified",
                    ForceRePairDecision::Skipped => "Skipped",
                    ForceRePairDecision::Inconclusive { .. } => "Inconclusive",
                    ForceRePairDecision::NeedsRepair(_) => unreachable!(),
                }
            ),
        }
    }

    /// I5-c (RED→GREEN): Err(_) maps to Inconclusive — fail-closed, not Clean.
    ///
    /// This is the regression test for the bug: previously Err was treated as
    /// "log and continue" (same as Clean). After the fix it must NOT be Clean.
    #[test]
    fn resolve_force_re_pair_outcome_inconclusive_on_err() {
        let decision = resolve_force_re_pair_outcome(Err(DetectError::other(
            "read _meta.json: network error".to_string(),
        )));
        match decision {
            ForceRePairDecision::Inconclusive { message, is_auth } => {
                assert!(
                    message.contains("network error"),
                    "Inconclusive must preserve the error message: {message}"
                );
                assert!(!is_auth, "a plain I/O error must not be typed as auth");
            }
            ForceRePairDecision::Verified | ForceRePairDecision::Skipped => {
                panic!("Err must NOT map to a clean outcome — that is the fail-open bug we fixed");
            }
            ForceRePairDecision::NeedsRepair(_) => {
                panic!("Err must not map to NeedsRepair (no mismatch data available)");
            }
        }
    }

    /// I5-d: Inconclusive sets FORCE_RE_PAIR_REQUIRED so ensure_safe_to_push blocks.
    ///
    /// Calls `apply_inconclusive_force_re_pair` directly (the production helper)
    /// so that stubbing out or deleting the helper body would break this test —
    /// replicating the `set_setting` calls in the test body would NOT achieve that.
    #[test]
    fn inconclusive_force_re_pair_sets_db_flag_blocking_push() {
        use crate::commands::sync::ensure_safe_to_push;

        let state = make_state();

        // Simulate sync_connected=true being persisted before detect_force_re_pair
        // runs (as persist_connect_settings does in gdrive_complete_connect).
        {
            let conn = state.lock().unwrap();
            persist_connect_settings(&conn, &gdrive_pending_token("fake-token")).unwrap();
        }

        // Call the production helper — this is the exact code both Inconclusive
        // arms delegate to. If the helper body is removed, this test breaks.
        {
            let conn = state.lock().unwrap();
            apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive")
                .expect("apply_inconclusive_force_re_pair must succeed on a healthy in-memory db");
        }

        // Push must be blocked.
        let result = ensure_safe_to_push(&state);
        assert!(
            result.is_err(),
            "ensure_safe_to_push must be blocked after Inconclusive keyring check"
        );
        let msg = result.unwrap_err();
        // ensure_safe_to_push returns "Vault was rotated on another device. Re-pair before syncing."
        assert!(
            msg.to_lowercase().contains("re-pair") || msg.contains("force_re_pair"),
            "error must mention force-re-pair: {msg}"
        );

        // Verify the reason was stored by the helper.
        let conn = state.lock().unwrap();
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
                .unwrap()
                .as_deref(),
            Some("keyring_check_inconclusive"),
            "FORCE_RE_PAIR_REASON must be set to keyring_check_inconclusive"
        );
    }

    // ─── Stale-flag self-heal: detect_force_re_pair 3-state + clear ─────────

    const TEST_FP: &str = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";

    async fn seed_cloud_meta(
        provider: &crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider,
        fingerprint: &str,
        epoch: u64,
    ) {
        let meta = crate::sync::keyring_v2::types::KeyringMetaV2 {
            version: crate::sync::keyring_v2::types::KEYRING_V2_VERSION,
            epoch,
            master_fingerprint: fingerprint.to_string(),
            content_epoch: 1,
            recovery_generation: 0,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
        };
        crate::sync::keyring_v2::io::write_meta(provider, &meta)
            .await
            .expect("seed cloud _meta.json");
    }

    fn seed_local_keyring(state: &AppState, fingerprint: &str, epoch: u64) {
        let conn = state.lock().unwrap();
        db::set_setting(&conn, db::CLOUD_MASTER_FINGERPRINT, fingerprint).unwrap();
        db::set_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH, &epoch.to_string()).unwrap();
    }

    /// Matching fingerprint + equal epoch → Verified (a real comparison ran).
    #[tokio::test]
    async fn detect_force_re_pair_verified_when_fingerprint_matches() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let state = make_state();
        seed_local_keyring(&state, TEST_FP, 3);
        let provider = InMemoryKeyringProvider::new();
        seed_cloud_meta(&provider, TEST_FP, 3).await;

        let check = detect_force_re_pair(&provider, &state).await.unwrap();
        assert!(
            matches!(check, ForceRePairCheck::Verified),
            "matching fingerprint + equal epoch must be Verified"
        );
    }

    /// No cloud `_meta.json` → Skipped, NOT Verified.
    ///
    /// This is the fail-open guard: if this returned Verified, the caller would
    /// clear a legitimate force-re-pair flag purely because the keyring was
    /// momentarily absent.
    #[tokio::test]
    async fn detect_force_re_pair_skipped_when_no_cloud_meta() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let state = make_state();
        seed_local_keyring(&state, TEST_FP, 3);
        let provider = InMemoryKeyringProvider::new(); // no _meta.json

        let check = detect_force_re_pair(&provider, &state).await.unwrap();
        assert!(
            matches!(check, ForceRePairCheck::Skipped),
            "absent _meta.json must be Skipped — treating it as Verified is fail-open"
        );
    }

    /// No local fingerprint (setup incomplete) → Skipped, NOT Verified.
    #[tokio::test]
    async fn detect_force_re_pair_skipped_when_no_local_fingerprint() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let state = make_state();
        let provider = InMemoryKeyringProvider::new();
        seed_cloud_meta(&provider, TEST_FP, 3).await;

        let check = detect_force_re_pair(&provider, &state).await.unwrap();
        assert!(
            matches!(check, ForceRePairCheck::Skipped),
            "missing local fingerprint must be Skipped — nothing to compare against"
        );
    }

    /// Same fingerprint but a NEWER cloud epoch → Mismatch, never Verified.
    ///
    /// Guards the epoch half of the `||` in `detect_force_re_pair`: without this,
    /// weakening `>` to `>=` or dropping the clause would leave the suite green
    /// while letting a rotated-but-same-fingerprint vault clear the flag.
    #[tokio::test]
    async fn detect_force_re_pair_mismatch_when_cloud_epoch_is_newer() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let state = make_state();
        seed_local_keyring(&state, TEST_FP, 3);
        let provider = InMemoryKeyringProvider::new();
        seed_cloud_meta(&provider, TEST_FP, 4).await; // same fp, cloud ahead

        let check = detect_force_re_pair(&provider, &state).await.unwrap();
        match check {
            ForceRePairCheck::Mismatch(m) => assert_eq!(m.cloud_epoch, 4),
            _ => panic!("newer cloud epoch must be Mismatch, never Verified"),
        }
    }

    /// `clear_force_re_pair` unblocks push after a stale Inconclusive flag.
    ///
    /// Calls the production helper directly so deleting its body breaks this
    /// test (same rationale as `inconclusive_force_re_pair_sets_db_flag_blocking_push`).
    #[test]
    fn clear_force_re_pair_unblocks_push_after_stale_inconclusive_flag() {
        use crate::commands::sync::ensure_safe_to_push;

        let state = make_state();
        {
            let conn = state.lock().unwrap();
            persist_connect_settings(&conn, &gdrive_pending_token("fake-token")).unwrap();
            // A transient Drive I/O error set the fail-closed flag earlier.
            apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive")
                .expect("seed the stale flag");
        }
        assert!(
            ensure_safe_to_push(&state).is_err(),
            "precondition: push must be blocked while the flag is set"
        );

        {
            let conn = state.lock().unwrap();
            clear_force_re_pair(&conn).expect("clear_force_re_pair must succeed on a healthy db");
        }

        assert!(
            ensure_safe_to_push(&state).is_ok(),
            "push must be unblocked once the verified check clears the stale flag"
        );
        let conn = state.lock().unwrap();
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON).unwrap(),
            None,
            "FORCE_RE_PAIR_REASON must be cleared alongside the required flag"
        );
    }

    // ─── force_re_pair_required: gates the keyring re-upload ─────────────────

    /// Flag set → the re-upload gate must report "required" and withhold the push.
    #[test]
    fn force_re_pair_required_true_when_flag_set() {
        let state = make_state();
        let conn = state.lock().unwrap();
        apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive").unwrap();
        assert!(
            force_re_pair_required(&conn),
            "a flagged device must be reported as needing re-pair so the re-upload is skipped"
        );
    }

    /// No flag → the re-upload may proceed as before.
    #[test]
    fn force_re_pair_required_false_when_flag_absent() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert!(
            !force_re_pair_required(&conn),
            "an unflagged device must not be blocked from re-uploading its keyring"
        );
    }

    // ─── apply_recheck_decision: only Verified may clear ─────────────────────

    /// Seed a set force-re-pair flag, then run the decision dispatch.
    /// Returns (cleared_result, flag_still_set).
    fn run_recheck(decision: ForceRePairDecision) -> (Result<bool, String>, bool) {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive")
                .expect("seed the flag");
        }
        let conn = state.lock().unwrap();
        let result = apply_recheck_decision(&conn, decision);
        let still_set = db::get_setting(&conn, db::FORCE_RE_PAIR_REQUIRED)
            .unwrap()
            .as_deref()
            == Some("1");
        (result, still_set)
    }

    /// Verified → clears the flag and reports true.
    #[test]
    fn apply_recheck_decision_clears_flag_on_verified() {
        let (result, still_set) = run_recheck(ForceRePairDecision::Verified);
        assert_eq!(result, Ok(true), "Verified must report the flag as cleared");
        assert!(!still_set, "Verified must clear FORCE_RE_PAIR_REQUIRED");
    }

    /// Skipped → must NOT clear. This is the fail-open guard for the dispatch:
    /// "nothing to compare" is not proof the vault is healthy.
    #[test]
    fn apply_recheck_decision_keeps_flag_on_skipped() {
        let (result, still_set) = run_recheck(ForceRePairDecision::Skipped);
        assert_eq!(result, Ok(false), "Skipped must not report a clear");
        assert!(
            still_set,
            "Skipped must leave FORCE_RE_PAIR_REQUIRED set — clearing it is fail-open"
        );
    }

    /// NeedsRepair → must NOT clear; a genuine rotation still requires re-pair.
    #[test]
    fn apply_recheck_decision_keeps_flag_on_needs_repair() {
        let (result, still_set) =
            run_recheck(ForceRePairDecision::NeedsRepair(ForceRePairMismatch {
                reason: "vault_rotated".to_string(),
                cloud_epoch: 9,
            }));
        assert_eq!(result, Ok(false), "NeedsRepair must not report a clear");
        assert!(still_set, "NeedsRepair must leave the flag set");
    }

    /// NeedsRepair must UPGRADE an inconclusive reason to the observed rotation.
    ///
    /// Otherwise the flag keeps its `keyring_check_inconclusive` provenance after a
    /// real rotation is detected, and a later auth failure clears it as if it had
    /// only ever been inconclusive.
    #[test]
    fn apply_recheck_decision_upgrades_reason_on_needs_repair() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive").unwrap();
        }
        let conn = state.lock().unwrap();
        apply_recheck_decision(
            &conn,
            ForceRePairDecision::NeedsRepair(ForceRePairMismatch {
                reason: "vault_rotated".to_string(),
                cloud_epoch: 9,
            }),
        )
        .unwrap();

        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
                .unwrap()
                .as_deref(),
            Some("vault_rotated"),
            "a detected rotation must overwrite the inconclusive provenance, else a later \
             auth failure would clear a flag that now protects a real rotation"
        );

        // And the upgraded reason must now resist the auth-clear.
        let result = apply_recheck_decision(
            &conn,
            ForceRePairDecision::Inconclusive {
                message: "GDRIVE_TOKEN_REVOKED: revoked".to_string(),
                is_auth: true,
            },
        );
        assert!(
            result.is_err(),
            "after the upgrade, an auth failure must not clear the flag"
        );
    }

    /// Inconclusive → must NOT clear, and must surface an error (fail-closed).
    #[test]
    fn apply_recheck_decision_keeps_flag_and_errors_on_inconclusive() {
        let (result, still_set) = run_recheck(ForceRePairDecision::Inconclusive {
            message: "network error".to_string(),
            is_auth: false,
        });
        assert!(
            result.is_err(),
            "Inconclusive must surface an error, not a silent clear"
        );
        assert!(
            still_set,
            "a non-auth Inconclusive must leave the flag set (fail-closed)"
        );
    }

    /// Inconclusive from revoked auth + an inconclusive-origin flag → clear it.
    ///
    /// This is the escape from the misclassification: the flag was written by a
    /// check that failed on auth, and every retry fails the same way, so it can
    /// never lift on its own. The user must reconnect Drive, not re-pair.
    #[test]
    fn apply_recheck_decision_clears_inconclusive_flag_when_auth_revoked() {
        let (result, still_set) = run_recheck(ForceRePairDecision::Inconclusive {
            message: "detect_force_re_pair: read _meta.json: auth: GDRIVE_TOKEN_REVOKED: \
                      Refresh token expired or revoked."
                .to_string(),
            is_auth: true,
        });
        assert_eq!(
            result,
            Ok(true),
            "an auth-revoked inconclusive flag must be cleared, not reported as an error"
        );
        assert!(
            !still_set,
            "the flag must be cleared so the user can reconnect Drive instead of re-pairing"
        );
    }

    /// A `vault_rotated` flag must survive an auth failure — it is a real rotation,
    /// not the misclassification, so only a mnemonic re-pair may lift it.
    #[test]
    fn apply_recheck_decision_keeps_vault_rotated_flag_when_auth_revoked() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, db::FORCE_RE_PAIR_REQUIRED, "1").unwrap();
            db::set_setting(&conn, db::FORCE_RE_PAIR_REASON, "vault_rotated").unwrap();
        }
        let conn = state.lock().unwrap();
        let result = apply_recheck_decision(
            &conn,
            ForceRePairDecision::Inconclusive {
                message: "GDRIVE_TOKEN_REVOKED: revoked".to_string(),
                is_auth: true,
            },
        );
        assert!(
            result.is_err(),
            "a vault_rotated flag must not be cleared by an auth failure"
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REQUIRED)
                .unwrap()
                .as_deref(),
            Some("1"),
            "vault_rotated must survive — clearing it would be fail-open"
        );
    }

    // ─── A4: set_force_re_pair_flags (transactional mismatch write) ─────────

    /// Both rows must land together — the flag without the reason (or vice
    /// versa) is exactly the half-state the transactional writer exists to
    /// prevent.
    #[test]
    fn set_force_re_pair_flags_writes_both_rows() {
        let state = make_state();
        let conn = state.lock().unwrap();
        set_force_re_pair_flags(&conn, "vault_rotated").unwrap();
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REQUIRED)
                .unwrap()
                .as_deref(),
            Some("1")
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
                .unwrap()
                .as_deref(),
            Some("vault_rotated")
        );
    }

    /// The transactional writer must FAIL LOUDLY when the write cannot land.
    /// `gdrive_complete_connect` relies on this: it propagates the error
    /// instead of returning the typed `NeedsForceRePair` outcome with no
    /// persisted guard (which would leave push unblocked after a restart).
    #[test]
    fn set_force_re_pair_flags_errors_when_settings_table_is_gone() {
        let state = make_state();
        let conn = state.lock().unwrap();
        conn.execute_batch("DROP TABLE settings").unwrap();
        assert!(
            set_force_re_pair_flags(&conn, "vault_rotated").is_err(),
            "a failed flag write must surface as Err, never silent success"
        );
    }

    // ─── B4: confirm_post_clear_verification (remote TOCTOU guard) ──────────

    /// A rotation observed by the post-clear detect must re-arm the flag —
    /// otherwise the stale `Verified` that raced the rotation has erased it.
    #[test]
    fn confirm_post_clear_verification_rearms_flag_on_needs_repair() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let result = confirm_post_clear_verification(
            &conn,
            Ok(ForceRePairCheck::Mismatch(ForceRePairMismatch {
                reason: "vault_rotated".to_string(),
                cloud_epoch: 7,
            })),
        );
        assert_eq!(
            result,
            Ok(false),
            "a re-armed flag must report 'not cleared'"
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REQUIRED)
                .unwrap()
                .as_deref(),
            Some("1"),
            "the rotation landed inside the detect→clear window — flag must be re-armed"
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
                .unwrap()
                .as_deref(),
            Some("vault_rotated")
        );
    }

    /// Non-rotation outcomes on the second detect must leave the clear in
    /// place: re-arming on a transient failure would make the recovery path
    /// self-defeating (the flag it just cleared came from such a failure).
    #[test]
    fn confirm_post_clear_verification_keeps_clear_on_non_rotation_outcomes() {
        for second in [
            Ok(ForceRePairCheck::Verified),
            Ok(ForceRePairCheck::Skipped),
            Err(DetectError::other("network blip".to_string())),
        ] {
            let state = make_state();
            let conn = state.lock().unwrap();
            let result = confirm_post_clear_verification(&conn, second);
            assert_eq!(result, Ok(true));
            assert!(
                db::get_setting(&conn, db::FORCE_RE_PAIR_REQUIRED)
                    .unwrap()
                    .is_none(),
                "only a rotation or corrupt meta may re-arm the flag"
            );
        }
    }

    /// A `_meta.json` that turned corrupt inside the detect→clear window must
    /// re-arm the flag — same fail-closed policy as the pull leg (A1). The
    /// typed `is_corrupt` verdict must not be lost between detect and confirm.
    #[test]
    fn confirm_post_clear_verification_rearms_flag_on_corrupt_meta() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let result = confirm_post_clear_verification(
            &conn,
            Err(DetectError {
                message: "detect_force_re_pair: read _meta.json: serialization: parse error"
                    .to_string(),
                is_auth: false,
                is_corrupt: true,
            }),
        );
        assert_eq!(result, Ok(false), "corrupt meta must report 'not cleared'");
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REQUIRED)
                .unwrap()
                .as_deref(),
            Some("1"),
            "the flag must be re-armed when the cloud turns unverifiable mid-recheck"
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
                .unwrap()
                .as_deref(),
            Some("keyring_check_inconclusive")
        );
    }

    // ─── A3: reupload_current_device_slot gate ───────────────────────────────

    /// A flagged device must not recreate a device slot that a peer's rotation
    /// removed — the gate lives in the primitive so no caller can bypass it.
    #[tokio::test]
    async fn reupload_current_device_slot_refuses_when_force_re_pair_required() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::KeyringV2Io;

        let state = make_state();
        {
            let conn = state.lock().unwrap();
            set_force_re_pair_flags(&conn, "vault_rotated").unwrap();
        }
        let provider = InMemoryKeyringProvider::new();
        let err = reupload_current_device_slot(
            &state,
            &provider,
            "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
            "Stale Device",
            1_700_000_000,
            1_700_000_001,
        )
        .await
        .expect_err("a flagged device must not write its device slot");
        assert!(err.contains("force-re-pair"), "got: {err}");
        assert!(
            provider
                .list_files(".meta/keyring")
                .await
                .unwrap()
                .is_empty(),
            "nothing may reach the cloud while the flag stands"
        );
    }

    // ─── A1: corrupt-vs-transient classification in DetectError ─────────────

    /// A `_meta.json` that exists but cannot parse is an integrity signal, not
    /// a transient failure — `check_force_re_pair_sync` fails closed on it.
    #[tokio::test]
    async fn detect_force_re_pair_marks_unparseable_meta_as_corrupt() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::KeyringV2Io;

        let state = make_state();
        seed_local_keyring(&state, TEST_FP, 3);
        let provider = InMemoryKeyringProvider::new();
        provider
            .write_file(".meta/keyring/_meta.json", b"{ not json at all")
            .await
            .expect("seed corrupt meta");

        let err = detect_force_re_pair(&provider, &state)
            .await
            .expect_err("corrupt meta must not verify");
        assert!(
            err.is_corrupt,
            "a Serialization failure on _meta.json must be flagged corrupt: {}",
            err.message
        );
    }

    /// A transient provider failure must NOT be classified as corrupt — the
    /// best-effort sync pull leg would otherwise block push on every dropped
    /// connection.
    #[tokio::test]
    async fn detect_force_re_pair_transient_failure_is_not_corrupt() {
        struct NetworkFailingIo;

        #[async_trait::async_trait]
        impl crate::sync::keyring_v2::KeyringV2Io for NetworkFailingIo {
            async fn read_file(
                &self,
                _path: &str,
            ) -> Result<Vec<u8>, crate::sync::provider::SyncError> {
                Err(crate::sync::provider::SyncError::Network(
                    "connection reset".to_string(),
                ))
            }
            async fn write_file(
                &self,
                _path: &str,
                _data: &[u8],
            ) -> Result<(), crate::sync::provider::SyncError> {
                Ok(())
            }
            async fn delete_file(
                &self,
                _path: &str,
            ) -> Result<(), crate::sync::provider::SyncError> {
                Ok(())
            }
            async fn list_files(
                &self,
                _prefix: &str,
            ) -> Result<Vec<String>, crate::sync::provider::SyncError> {
                Ok(vec![])
            }
        }

        let state = make_state();
        seed_local_keyring(&state, TEST_FP, 3);
        let err = detect_force_re_pair(&NetworkFailingIo, &state)
            .await
            .expect_err("network failure is inconclusive");
        assert!(!err.is_corrupt, "transient failures must stay best-effort");
        assert!(!err.is_auth);
    }

    /// A malicious `_meta.json` must NOT be able to forge an auth verdict.
    ///
    /// `KeyringMetaV2` uses `deny_unknown_fields`, so serde echoes an unknown
    /// field NAME — fully cloud-controlled — into the error message. When the
    /// classifier substring-matched that message, a field named
    /// `GDRIVE_TOKEN_REVOKED` made a corrupt keyring look like dead auth, and the
    /// fail-closed flag was skipped while the token was still valid: push would
    /// proceed on an unverified keyring. Classification now reads the typed
    /// `SyncError` variant, so the injected marker is inert.
    #[tokio::test]
    async fn detect_force_re_pair_rejects_auth_marker_injected_via_cloud_meta() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::KeyringV2Io;

        let state = make_state();
        seed_local_keyring(&state, TEST_FP, 3);
        let provider = InMemoryKeyringProvider::new();
        // Attacker-authored _meta.json: the unknown field name is the marker.
        provider
            .write_file(
                ".meta/keyring/_meta.json",
                br#"{"GDRIVE_TOKEN_REVOKED":"x","version":2,"epoch":3,"master_fingerprint":"aa","content_epoch":1,"created_at":0,"updated_at":0}"#,
            )
            .await
            .expect("seed malicious meta");

        let err = detect_force_re_pair(&provider, &state)
            .await
            .expect_err("a corrupt _meta.json must not parse");
        assert!(
            err.message.contains("GDRIVE_TOKEN_REVOKED"),
            "precondition: the cloud-controlled marker really does reach the message: {}",
            err.message
        );
        assert!(
            !err.is_auth,
            "a serialization failure must never be classified as auth just because the \
             cloud injected the marker — that skips the fail-closed flag (fail-open)"
        );
    }

    /// A real `SyncError::Auth` from the provider IS classified as auth.
    #[tokio::test]
    async fn detect_force_re_pair_classifies_typed_auth_error() {
        struct AuthFailingIo;

        #[async_trait::async_trait]
        impl crate::sync::keyring_v2::KeyringV2Io for AuthFailingIo {
            async fn read_file(
                &self,
                _path: &str,
            ) -> Result<Vec<u8>, crate::sync::provider::SyncError> {
                Err(crate::sync::provider::SyncError::Auth(
                    "GDRIVE_TOKEN_REVOKED: Refresh token expired or revoked.".to_string(),
                ))
            }
            async fn write_file(
                &self,
                _path: &str,
                _data: &[u8],
            ) -> Result<(), crate::sync::provider::SyncError> {
                Ok(())
            }
            async fn delete_file(
                &self,
                _path: &str,
            ) -> Result<(), crate::sync::provider::SyncError> {
                Ok(())
            }
            async fn list_files(
                &self,
                _prefix: &str,
            ) -> Result<Vec<String>, crate::sync::provider::SyncError> {
                Ok(vec![])
            }
        }

        let state = make_state();
        seed_local_keyring(&state, TEST_FP, 3);

        let err = detect_force_re_pair(&AuthFailingIo, &state)
            .await
            .expect_err("auth failure must surface as an error");
        assert!(
            err.is_auth,
            "a typed SyncError::Auth must be classified as auth so the user is sent to \
             reconnect Drive rather than the mnemonic re-pair screen"
        );
    }

    /// A `SyncError::Auth` WITHOUT the revoked marker must stay fail-closed.
    ///
    /// `gdrive_provider.rs` maps every non-scope refresh failure — network drop,
    /// 5xx, parse error — to `SyncError::Auth`. Trusting the variant alone would
    /// let a transient blip pose as a revoked token and clear the flag.
    #[tokio::test]
    async fn detect_force_re_pair_does_not_classify_generic_auth_as_revoked() {
        struct GenericAuthFailingIo;

        #[async_trait::async_trait]
        impl crate::sync::keyring_v2::KeyringV2Io for GenericAuthFailingIo {
            async fn read_file(
                &self,
                _path: &str,
            ) -> Result<Vec<u8>, crate::sync::provider::SyncError> {
                // What a network drop during token refresh actually produces.
                Err(crate::sync::provider::SyncError::Auth(
                    "refresh failed: connection reset by peer".to_string(),
                ))
            }
            async fn write_file(
                &self,
                _path: &str,
                _data: &[u8],
            ) -> Result<(), crate::sync::provider::SyncError> {
                Ok(())
            }
            async fn delete_file(
                &self,
                _path: &str,
            ) -> Result<(), crate::sync::provider::SyncError> {
                Ok(())
            }
            async fn list_files(
                &self,
                _prefix: &str,
            ) -> Result<Vec<String>, crate::sync::provider::SyncError> {
                Ok(vec![])
            }
        }

        let state = make_state();
        seed_local_keyring(&state, TEST_FP, 3);

        let err = detect_force_re_pair(&GenericAuthFailingIo, &state)
            .await
            .expect_err("the read failed, so this must be an error");
        assert!(
            !err.is_auth,
            "a generic Auth error carries no revoked marker — treating it as a revoked \
             token would clear the fail-closed flag on a transient network blip"
        );
    }

    /// A replayed OLDER cloud epoch must be a Mismatch, not Verified.
    ///
    /// `Verified` authorizes clearing the fail-closed flag, so accepting a
    /// rollback would let a stale `_meta.json` erase a real `vault_rotated` flag.
    #[tokio::test]
    async fn detect_force_re_pair_mismatch_when_cloud_epoch_is_older() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let state = make_state();
        seed_local_keyring(&state, TEST_FP, 5);
        let provider = InMemoryKeyringProvider::new();
        seed_cloud_meta(&provider, TEST_FP, 2).await; // cloud rolled BACK

        let check = detect_force_re_pair(&provider, &state).await.unwrap();
        assert!(
            matches!(check, ForceRePairCheck::Mismatch(_)),
            "an older cloud epoch is a rollback — it must never read as Verified"
        );
    }

    /// An inconclusive check must NOT downgrade an existing `vault_rotated` reason.
    ///
    /// Reason is provenance: `apply_recheck_decision` clears an auth-failed flag
    /// only when the reason is `keyring_check_inconclusive`. If a later
    /// inconclusive check could overwrite `vault_rotated`, the sequence
    /// rotation → inconclusive → auth failure would erase real protection.
    #[test]
    fn apply_inconclusive_force_re_pair_never_downgrades_vault_rotated() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, db::FORCE_RE_PAIR_REQUIRED, "1").unwrap();
        db::set_setting(&conn, db::FORCE_RE_PAIR_REASON, "vault_rotated").unwrap();

        apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive").unwrap();

        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
                .unwrap()
                .as_deref(),
            Some("vault_rotated"),
            "vault_rotated must survive an inconclusive check — downgrading it opens the \
             rotation → inconclusive → auth-clear fail-open"
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REQUIRED)
                .unwrap()
                .as_deref(),
            Some("1"),
            "the flag itself must stay set"
        );
    }

    /// A flagged device must refuse to publish its keyring at the primitive.
    #[tokio::test]
    async fn publish_v2_keyring_refuses_when_force_re_pair_required() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let state = make_state();
        let key_state = EncryptionKeyState::default();
        let provider = InMemoryKeyringProvider::new();
        {
            let conn = state.lock().unwrap();
            apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive").unwrap();
        }

        let ctx = make_publish_ctx();
        let result = publish_v2_keyring_with_provider(&provider, &state, &ctx, &key_state).await;
        assert!(
            result.is_err(),
            "a flagged device must not publish — doing so clobbers a peer's rotation \
             and lets the next check verify against its own write"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.to_lowercase().contains("re-pair"),
            "the refusal must name the cause: {msg}"
        );
    }

    /// An empty cloud + a flag written by an inconclusive check is a deadlock:
    /// publish is gated by the flag, the recheck has no `_meta.json` to compare,
    /// and the mnemonic re-pair needs a `_recovery.json` that is gone. Clearing
    /// the flag is what breaks it — the empty cloud has no peer state to clobber.
    #[test]
    fn clear_stale_flag_for_empty_cloud_clears_an_inconclusive_flag() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive")
                .expect("seed force-re-pair flags");
        }

        let conn = state.lock().unwrap();
        let cleared = clear_stale_flag_for_empty_cloud(&conn, false)
            .expect("clearing must succeed on a healthy db");

        assert!(cleared, "an inconclusive flag must be reported as cleared");
        assert!(
            !force_re_pair_required(&conn),
            "the flag must be gone so publish_v2_keyring_with_provider can rebuild the vault"
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON).unwrap(),
            None,
            "the reason must be cleared alongside the flag"
        );
    }

    /// The empty-cloud escape hatch must not become a way around a real rotation:
    /// a peer moved the vault, so this device's key material is stale whatever the
    /// cloud currently holds. Only the mnemonic re-pair may clear `vault_rotated`.
    #[test]
    fn clear_stale_flag_for_empty_cloud_leaves_vault_rotated_standing() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            set_force_re_pair_flags(&conn, "vault_rotated").expect("seed force-re-pair flags");
        }

        let conn = state.lock().unwrap();
        let cleared =
            clear_stale_flag_for_empty_cloud(&conn, false).expect("the call must not error");

        assert!(!cleared, "a vault_rotated flag must never be cleared here");
        assert!(
            force_re_pair_required(&conn),
            "push must stay blocked after a genuine peer rotation"
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
                .unwrap()
                .as_deref(),
            Some("vault_rotated"),
            "the reason must survive so a later check cannot downgrade it"
        );
    }

    /// No flag set → nothing to clear, and the call must stay side-effect free.
    #[test]
    fn clear_stale_flag_for_empty_cloud_is_a_noop_without_a_flag() {
        let state = make_state();
        let conn = state.lock().unwrap();

        let cleared =
            clear_stale_flag_for_empty_cloud(&conn, false).expect("the call must not error");

        assert!(!cleared, "there was no flag to clear");
        assert!(
            !force_re_pair_required(&conn),
            "no flag must have been added"
        );
    }

    /// The whole safety argument is that a keyring is PRESENT in the cloud → the
    /// flag may be guarding a peer's committed rotation → never clear. Passing the
    /// probe result in (rather than re-reading it) is what makes this testable:
    /// misplacing the call into a keyring-present branch must not clear anything.
    #[test]
    fn clear_stale_flag_for_empty_cloud_never_clears_when_a_keyring_is_present() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive")
                .expect("seed force-re-pair flags");
        }

        let conn = state.lock().unwrap();
        let cleared =
            clear_stale_flag_for_empty_cloud(&conn, true).expect("the call must not error");

        assert!(
            !cleared,
            "a present cloud keyring may be a peer's committed rotation — even an \
             inconclusive flag must stand"
        );
        assert!(
            force_re_pair_required(&conn),
            "push must stay blocked while the cloud holds a keyring this device has not verified"
        );
    }

    /// A read failure must propagate, not be swallowed into a silent "nothing
    /// cleared" — the caller hard-fails the connect on `Err` so the user can retry.
    #[test]
    fn clear_stale_flag_for_empty_cloud_errors_when_settings_table_is_gone() {
        let state = make_state();
        let conn = state.lock().unwrap();
        apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive")
            .expect("seed force-re-pair flags");
        conn.execute_batch("DROP TABLE settings")
            .expect("drop settings");

        let result = clear_stale_flag_for_empty_cloud(&conn, false);

        assert!(
            result.is_err(),
            "a broken settings table must surface as Err"
        );
    }

    /// End-to-end link: the flag this helper clears must be the SAME flag the
    /// publish gate reads. Without this, the helper could clear a different row
    /// and every unit test above would still pass while the deadlock survived.
    #[tokio::test]
    async fn clearing_the_stale_flag_lets_the_publish_gate_rebuild_the_vault() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let state = make_state();
        let key_state = EncryptionKeyState::default();
        let provider = InMemoryKeyringProvider::new();
        {
            let conn = state.lock().unwrap();
            apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive").unwrap();
            clear_stale_flag_for_empty_cloud(&conn, false).expect("clear the stale flag");
        }

        let ctx = make_publish_ctx();
        let result = publish_v2_keyring_with_provider(&provider, &state, &ctx, &key_state).await;

        assert!(
            result.is_ok(),
            "once the stale flag is cleared the gate must let this device republish \
             the vault into the empty cloud: {result:?}"
        );
    }

    /// The mirror of the test above: `vault_rotated` survives the helper, so the
    /// publish gate must still refuse. This is the property that keeps the
    /// empty-cloud escape hatch from becoming a way around a real rotation.
    #[tokio::test]
    async fn a_vault_rotated_flag_still_blocks_publish_after_the_helper_runs() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let state = make_state();
        let key_state = EncryptionKeyState::default();
        let provider = InMemoryKeyringProvider::new();
        {
            let conn = state.lock().unwrap();
            set_force_re_pair_flags(&conn, "vault_rotated").unwrap();
            clear_stale_flag_for_empty_cloud(&conn, false).expect("the helper must not error");
        }

        let ctx = make_publish_ctx();
        let result = publish_v2_keyring_with_provider(&provider, &state, &ctx, &key_state).await;

        assert!(
            result.is_err(),
            "a genuinely rotated vault must keep this device from publishing stale key material"
        );
    }

    /// gdrive_dev_repair_keyring (debug-only): sets keyring_dirty=1 AND clears
    /// both force-re-pair flags, so the next unlock regenerates _meta.json and
    /// push is no longer blocked.
    #[cfg(debug_assertions)]
    #[test]
    fn gdrive_dev_repair_keyring_sets_dirty_and_clears_force_re_pair() {
        let state = make_state();

        // Seed the stuck state: force-re-pair flags set, keyring not dirty.
        {
            let conn = state.lock().unwrap();
            apply_inconclusive_force_re_pair(&conn, "keyring_check_inconclusive")
                .expect("seed force-re-pair flags");
            db::delete_setting(&conn, db::KEYRING_DIRTY_KEY).unwrap();
        }

        {
            let conn = state.lock().unwrap();
            gdrive_dev_repair_keyring_inner(&conn)
                .expect("gdrive_dev_repair_keyring_inner must succeed on a healthy in-memory db");
        }

        let conn = state.lock().unwrap();
        assert_eq!(
            db::get_setting(&conn, db::KEYRING_DIRTY_KEY)
                .unwrap()
                .as_deref(),
            Some("1"),
            "keyring_dirty must be set so the next unlock regenerates _meta.json"
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REQUIRED).unwrap(),
            None,
            "FORCE_RE_PAIR_REQUIRED must be cleared"
        );
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON).unwrap(),
            None,
            "FORCE_RE_PAIR_REASON must be cleared"
        );
    }

    // ─── gdrive_dev_dump_keyring (debug-only) ────────────────────────────────

    /// The dump must return every keyring file present on the provider,
    /// including EVERY `devices/*.json` entry — guards against it silently
    /// skipping the directory that matters most for requirement 4 (the cloud
    /// device slot must carry no key material, and a human can only see that
    /// by reading the raw bytes this command returns).
    #[tokio::test]
    async fn gdrive_dev_dump_keyring_inner_returns_every_keyring_file() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::io::{
            write_content, write_device_slot, write_meta, write_recovery,
        };
        use crate::sync::keyring_v2::types::{
            ContentListV2, DeviceSlotV2, KeyringMetaV2, RecoverySlotV2, KEYRING_V2_VERSION,
        };

        let provider = InMemoryKeyringProvider::new();

        write_meta(
            &provider,
            &KeyringMetaV2 {
                version: KEYRING_V2_VERSION,
                epoch: 1,
                master_fingerprint: "a".repeat(64),
                content_epoch: 0,
                recovery_generation: 0,
                created_at: 0,
                updated_at: 0,
            },
        )
        .await
        .unwrap();
        write_recovery(
            &provider,
            &RecoverySlotV2 {
                version: KEYRING_V2_VERSION,
                wrapped_master: "b".repeat(120),
                created_at: 0,
            },
        )
        .await
        .unwrap();
        write_content(
            &provider,
            &ContentListV2 {
                version: KEYRING_V2_VERSION,
                latest_epoch: 0,
                entries: vec![],
                created_at: 0,
            },
        )
        .await
        .unwrap();
        // Two device slots — the dump must include BOTH, not just the first.
        for id in [
            "11111111-2222-3333-4444-555555555555",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        ] {
            write_device_slot(
                &provider,
                &DeviceSlotV2 {
                    version: KEYRING_V2_VERSION,
                    device_id: id.to_string(),
                    name: "Test Device".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                },
            )
            .await
            .unwrap();
        }

        let dump = gdrive_dev_dump_keyring_inner(&provider)
            .await
            .expect("dump must succeed");

        assert!(dump.contains("_meta.json"), "dump must include _meta.json");
        assert!(
            dump.contains("_recovery.json"),
            "dump must include _recovery.json"
        );
        assert!(
            dump.contains("_content.json"),
            "dump must include _content.json"
        );
        assert!(
            dump.contains("devices/11111111-2222-3333-4444-555555555555.json"),
            "dump must include the first device slot"
        );
        assert!(
            dump.contains("devices/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json"),
            "dump must include the second device slot"
        );
        // The raw bytes of the DEVICE SLOT sections must carry no key
        // material. Scoped to the devices/ section only — `_recovery.json`
        // legitimately has a field literally named `wrapped_master` (the
        // 🚨 of this whole phase: two different structs share that field
        // name, and only one of them is supposed to die).
        let devices_section = dump
            .split_once("=== .meta/keyring/devices/")
            .map(|(_, rest)| rest)
            .expect("dump must contain a devices/ section");
        assert!(
            !devices_section.contains("wrapped_master") && !devices_section.contains("kek_salt"),
            "dumped device slots must carry no key material: {devices_section}"
        );
    }

    /// Absent files (fresh/empty cloud) must not panic — the dump reports them
    /// as absent rather than erroring out entirely.
    #[tokio::test]
    async fn gdrive_dev_dump_keyring_inner_handles_empty_cloud() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let provider = InMemoryKeyringProvider::new();
        let dump = gdrive_dev_dump_keyring_inner(&provider)
            .await
            .expect("dump must succeed even on an empty cloud");
        assert!(dump.contains("_meta.json"));
        assert!(dump.contains("absent"));
    }
}
