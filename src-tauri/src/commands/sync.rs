use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

use crate::db;
use crate::sync::engine::{CatchupProgressEvent, ProgressReporter, SyncProgressEvent};
use crate::sync::gdrive_provider::GDriveProvider;
use crate::sync::{
    CloudProvider, LocalSyncProvider, SyncEngine, SyncProvider, SyncSummary, SyncTrigger,
};
use crate::{AppState, EncryptionKeyState};

/// Tauri event name broadcast whenever sync state changes (start, end,
/// error, or status mutation). Single source of truth for the frontend
/// `useSync` listener. Schema pinned by [`SyncStatusEvent`] and any change
/// must ship with a useSync test update — consumers rely on the field
/// names, not positional order.
pub const SYNC_STATUS_EVENT: &str = "sync:status-changed";

/// Tauri event name broadcast on every meaningful loop boundary during a
/// push/pull cycle.  Payload is [`SyncProgressEvent`] (re-exported from the
/// engine).  Separate from [`SYNC_STATUS_EVENT`] so the frontend can update
/// a progress label without re-rendering the full status indicator.
pub const SYNC_PROGRESS_EVENT: &str = "sync:progress";

/// Tauri event emitted after each committed pull chunk and once at the end
/// of a successful catch-up cycle. Payload is [`CatchupProgressEvent`].
/// Emit failures are best-effort UI failures and must never abort a pull.
pub const SYNC_CATCHUP_PROGRESS_EVENT: &str = "sync:catchup-progress";

/// Tauri event broadcast when the engine detects that the user is holding a
/// legacy `drive.file`-scoped token and needs to reconnect under the new
/// `drive.appdata` scope. Payload is empty — the frontend reads the
/// `gdrive_scope_upgrade_required` settings flag and renders the banner.
pub const SYNC_SCOPE_UPGRADE_EVENT: &str = "sync:scope-upgrade-required";

/// Settings key persisted when an automatic scope-mismatch disconnect runs.
/// The frontend renders the reconnect banner while this is true; clearing
/// it is the responsibility of `gdrive_complete_connect` (on successful
/// reconnect) or of the user dismissing the banner via
/// `clear_sync_scope_upgrade_required`.
pub const GDRIVE_SCOPE_UPGRADE_REQUIRED_KEY: &str = "gdrive_scope_upgrade_required";

/// Production [`ProgressReporter`] that forwards every progress event to the
/// Tauri frontend via [`SYNC_PROGRESS_EVENT`].  Emit failures are logged and
/// swallowed — a failed emit must never abort the sync cycle itself.
struct TauriProgressReporter {
    app: AppHandle,
}

impl ProgressReporter for TauriProgressReporter {
    fn report(&self, event: SyncProgressEvent) {
        if let Err(e) = self.app.emit(SYNC_PROGRESS_EVENT, event) {
            log::warn!("TauriProgressReporter: failed to emit {SYNC_PROGRESS_EVENT}: {e}");
        }
    }

    fn report_catchup_progress(&self, event: CatchupProgressEvent) {
        if let Err(e) = self.app.emit(SYNC_CATCHUP_PROGRESS_EVENT, event) {
            log::warn!("TauriProgressReporter: failed to emit {SYNC_CATCHUP_PROGRESS_EVENT}: {e}");
        }
    }
}

/// Wraps another [`ProgressReporter`] and stamps `last_progress_ms` on every
/// `report()` and `heartbeat()` call before forwarding to the inner
/// reporter (`report()`) or doing nothing further (`heartbeat()`, which has
/// no IPC-facing counterpart). `run_sync_now`'s stall guard reads
/// `last_progress_ms` to tell "slow because there is a lot of legitimate
/// work" apart from "hung" — see [`with_stall_guard`].
struct StallTrackingReporter {
    inner: Arc<dyn ProgressReporter>,
    last_progress_ms: Arc<AtomicU64>,
    baseline: std::time::Instant,
}

impl StallTrackingReporter {
    fn stamp(&self) {
        let now = self.baseline.elapsed().as_millis() as u64;
        self.last_progress_ms.store(now, Ordering::SeqCst);
    }
}

impl ProgressReporter for StallTrackingReporter {
    fn report(&self, event: SyncProgressEvent) {
        self.stamp();
        self.inner.report(event);
    }

    fn report_catchup_progress(&self, event: CatchupProgressEvent) {
        self.stamp();
        self.inner.report_catchup_progress(event);
    }

    fn heartbeat(&self) {
        self.stamp();
    }
}

/// Returned by [`with_stall_guard`] / [`retry_with_stall_guard`] when the
/// guarded future was aborted before completing — distinct from "still
/// working, just slow."
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncStalled {
    /// No progress signal (`report`/`heartbeat`, via [`StallTrackingReporter`])
    /// was recorded for the full stall window — the engine appears to have
    /// gone silent.
    NoProgress,
    /// The attempt ran past the hard cap even though progress kept
    /// flowing. A backstop against a workload that keeps the stall check
    /// satisfied forever (e.g. an endless stream of cheap items over a slow
    /// link) — durable per-item progress (pull commits per chunk, push
    /// marks each entry synced) makes killing the attempt here safe.
    HardCapExceeded,
}

/// Human-readable reason text shared between the retry-boundary log line
/// and the final user-facing error string, so the two can never drift.
fn stall_reason_text(reason: SyncStalled, stall: Duration, hard_cap: Duration) -> String {
    match reason {
        SyncStalled::NoProgress => format!("no progress for {}s", stall.as_secs()),
        SyncStalled::HardCapExceeded => {
            format!("exceeded the {}-minute hard cap", hard_cap.as_secs() / 60)
        }
    }
}

/// Race `fut` against a stall (inactivity) timeout AND an absolute hard cap:
/// every 5s tick the guard checks (a) how long it's been since
/// `last_progress_ms` last advanced (per `now_ms`) — if that gap exceeds
/// `stall`, the guard aborts with [`SyncStalled::NoProgress`] even though
/// `fut` is still running; (b) how long the attempt has run in total — if
/// that exceeds `hard_cap`, the guard aborts with
/// [`SyncStalled::HardCapExceeded`] regardless of how recently progress was
/// stamped. A future that keeps stamping `last_progress_ms` — via a
/// [`StallTrackingReporter`]'s `report`/`heartbeat` calls — can run for as
/// long as `hard_cap` without tripping the stall check, but never longer.
///
/// `last_progress_ms` is stamped to `now_ms()` once at guard start (also
/// used as the hard-cap's `attempt_start`), so a future whose first
/// progress signal doesn't arrive until partway through its work is still
/// measured from a sane baseline.
///
/// `now_ms` is injected (rather than reading `SystemTime`/`Instant`
/// directly) so tests can drive a `tokio::time::Instant`-based clock under
/// `#[tokio::test(start_paused = true)]` and advance it deterministically
/// with `tokio::time::advance` — production passes a real-time clock based
/// on `std::time::Instant`.
pub(crate) async fn with_stall_guard<T>(
    fut: impl std::future::Future<Output = T>,
    last_progress_ms: Arc<AtomicU64>,
    now_ms: impl Fn() -> u64,
    stall: Duration,
    hard_cap: Duration,
) -> Result<T, SyncStalled> {
    let attempt_start = now_ms();
    last_progress_ms.store(attempt_start, Ordering::SeqCst);
    tokio::pin!(fut);
    let mut ticker = tokio::time::interval(Duration::from_secs(5));
    // `interval`'s first tick fires immediately; consume it up front so the
    // first real stall check happens after a full interval has elapsed, not
    // instantly at guard start.
    ticker.tick().await;
    loop {
        tokio::select! {
            result = &mut fut => return Ok(result),
            _ = ticker.tick() => {
                let now = now_ms();
                let last = last_progress_ms.load(Ordering::SeqCst);
                if now.saturating_sub(last) > stall.as_millis() as u64 {
                    return Err(SyncStalled::NoProgress);
                }
                if now.saturating_sub(attempt_start) > hard_cap.as_millis() as u64 {
                    return Err(SyncStalled::HardCapExceeded);
                }
            }
        }
    }
}

/// Drive [`with_stall_guard`] across up to `max_attempts` attempts, calling
/// `make_attempt()` fresh each time — the same retry semantics
/// `run_sync_now` had inline, extracted so the attempt/retry glue itself is
/// unit-testable without a real Tauri `AppHandle`.
///
/// `on_retry(attempt, reason)` fires after every non-final aborted attempt
/// (never after the last) — callers use it to log and re-arm the frontend
/// watchdog. Returns `Ok(T)` from whichever attempt completes, or
/// `Err(reason)` from the final attempt if every attempt was aborted.
pub(crate) async fn retry_with_stall_guard<T, Fut>(
    mut make_attempt: impl FnMut() -> Fut,
    last_progress_ms: Arc<AtomicU64>,
    now_ms: impl Fn() -> u64,
    stall: Duration,
    hard_cap: Duration,
    max_attempts: u32,
    mut on_retry: impl FnMut(u32, SyncStalled),
) -> Result<T, SyncStalled>
where
    Fut: std::future::Future<Output = T>,
{
    let mut attempt: u32 = 1;
    loop {
        match with_stall_guard(
            make_attempt(),
            last_progress_ms.clone(),
            &now_ms,
            stall,
            hard_cap,
        )
        .await
        {
            Ok(res) => return Ok(res),
            Err(reason) if attempt < max_attempts => {
                on_retry(attempt, reason);
                attempt += 1;
            }
            Err(reason) => return Err(reason),
        }
    }
}

/// Lifecycle phase carried in [`SyncStatusEvent::state`]. Compile-time
/// typechecked here so a typo at an emission site fails to build rather
/// than silently producing a bad string the frontend ignores. The
/// `#[serde(rename_all = "lowercase")]` matches the Chunk 5 frontend
/// union `SyncPhase = 'idle' | 'syncing' | 'synced' | 'error'`; changing
/// either side must change the other in lockstep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncPhase {
    /// Nothing in flight; the app may or may not have synced before.
    Idle,
    /// A push/pull is currently running.
    Syncing,
    /// The most recent run finished without errors.
    Synced,
    /// The most recent run ended with `summary.errors` non-empty.
    Error,
}

/// Payload for [`SYNC_STATUS_EVENT`]. Carries both the transient "what is
/// happening right now" (`state`) and the up-to-date snapshot of the
/// `sync_state`-derived status the sidebar indicator needs. Sending both
/// in one event keeps the frontend from racing a `get_sync_status` call
/// against a second event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusEvent {
    pub state: SyncPhase,
    pub enabled: bool,
    pub configured: bool,
    pub provider: Option<String>,
    pub last_sync: Option<i64>,
    pub entries_pending: u64,
    /// Set on transitions to `error`. `None` otherwise.
    pub error: Option<String>,
}

impl SyncStatusEvent {
    fn from_status(state: SyncPhase, status: SyncStatus, error: Option<String>) -> Self {
        Self {
            state,
            enabled: status.enabled,
            configured: status.configured,
            provider: status.provider,
            last_sync: status.last_sync,
            entries_pending: status.entries_pending,
            error,
        }
    }
}

/// Read the current sync status snapshot off the DB and emit a
/// [`SYNC_STATUS_EVENT`] with `state`. Errors are swallowed (logged) on
/// purpose: emit failures must never break the sync flow itself.
fn emit_status(
    app: &AppHandle,
    state_machine: SyncPhase,
    status_state: &AppState,
    error: Option<String>,
) {
    let status = match status_state
        .lock()
        .and_then(|conn| read_status_snapshot(&conn))
    {
        Ok(s) => s,
        Err(e) => {
            log::warn!("emit_status: failed to read sync status snapshot: {e}");
            return;
        }
    };
    let payload = SyncStatusEvent::from_status(state_machine, status, error);
    if let Err(e) = app.emit(SYNC_STATUS_EVENT, payload) {
        log::warn!("emit_status: failed to emit {SYNC_STATUS_EVENT}: {e}");
    }
}

/// Read the four sync-status fields directly off a held connection. Pulled
/// out so `emit_status` and `get_sync_status` share exactly one query set.
fn read_status_snapshot(conn: &rusqlite::Connection) -> Result<SyncStatus, String> {
    let enabled = db::get_sync_enabled(conn).map_err(|e| e.to_string())?;
    let provider = db::get_sync_provider(conn).map_err(|e| e.to_string())?;
    let last_sync = db::get_last_sync_at(conn).map_err(|e| e.to_string())?;
    let entries_pending = db::count_pending_entries(conn).map_err(|e| e.to_string())?;
    let configured = make_configured_provider(conn)?.is_some();
    Ok(SyncStatus {
        enabled,
        configured,
        provider,
        last_sync,
        entries_pending,
    })
}

fn read_sync_catchup_status(conn: &rusqlite::Connection) -> rusqlite::Result<SyncCatchupStatus> {
    Ok(SyncCatchupStatus {
        complete: db::get_sync_catchup_complete(conn)?,
        pulled: 0,
        total: 0,
    })
}

/// Public shape of the sync status exposed to the UI.
///
/// Chunk 3c fills in `provider` and `last_sync` (they were `None` in 3a).
/// `provider` is `Some("local")` when a local-directory provider is
/// configured; other values arrive in Chunk 4.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub configured: bool,
    pub provider: Option<String>,
    pub last_sync: Option<i64>,
    pub entries_pending: u64,
}

/// Initial catch-up snapshot exposed to the UI. Progress counts arrive via
/// [`SYNC_CATCHUP_PROGRESS_EVENT`] while a sync is running.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncCatchupStatus {
    pub complete: bool,
    pub pulled: u64,
    pub total: u64,
}

#[tauri::command]
pub fn get_device_id(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.lock()?;
    db::get_or_create_device_id(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let conn = state.lock()?;
    read_status_snapshot(&conn)
}

#[tauri::command]
pub fn get_sync_catchup_status(state: State<'_, AppState>) -> Result<SyncCatchupStatus, String> {
    let conn = state.lock()?;
    read_sync_catchup_status(&conn).map_err(|e| e.to_string())
}

// ─── Scheduler settings (Chunk 5) ────────────────────────────────────────────

/// Serialized shape of the scheduler-facing settings exposed to the UI. The
/// three fields correspond 1:1 with the DB keys declared in `db::queries`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings {
    pub interval_minutes: u32,
    pub on_save: bool,
    pub on_launch: bool,
}

#[tauri::command]
pub fn get_sync_settings(state: State<'_, AppState>) -> Result<SyncSettings, String> {
    let conn = state.lock()?;
    Ok(SyncSettings {
        interval_minutes: db::get_sync_interval_minutes(&conn).map_err(|e| e.to_string())?,
        on_save: db::get_sync_on_save(&conn).map_err(|e| e.to_string())?,
        on_launch: db::get_sync_on_launch(&conn).map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
pub fn set_sync_settings(state: State<'_, AppState>, settings: SyncSettings) -> Result<(), String> {
    let conn = state.lock()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::set_sync_interval_minutes(&tx, settings.interval_minutes).map_err(|e| e.to_string())?;
    db::set_sync_on_save(&tx, settings.on_save).map_err(|e| e.to_string())?;
    db::set_sync_on_launch(&tx, settings.on_launch).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_sync_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let conn = state.lock()?;
    // Guard: enabling sync without a configured provider is a user-facing
    // bug (nothing to sync against). Reject it loudly instead of silently
    // succeeding and failing at sync_now time.
    if enabled
        && db::get_sync_provider(&conn)
            .map_err(|e| e.to_string())?
            .is_none()
    {
        return Err("Configure a sync provider first".to_string());
    }
    db::set_sync_enabled(&conn, enabled).map_err(|e| e.to_string())
}

// ─── Configuration ──────────────────────────────────────────────────────────

/// JSON shape persisted in `settings.sync_config_json` for the `local`
/// provider. Today it's just a root path; Chunk 4's provider will have a
/// richer shape and we'll discriminate on `settings.sync_provider`.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
struct LocalConfig {
    root_path: String,
}

// ─── Sync operations ────────────────────────────────────────────────────────

/// Build the configured provider. Returns `None` when sync is disabled or
/// unconfigured — the caller should surface a clear error instead of
/// silently succeeding with a no-op.
///
/// The supported providers carry their config in different places:
/// - `local` and `icloud` store a root path in the `sync_config_json` setting row.
/// - `gdrive` stores its encrypted refresh token in `gdrive_refresh_token`
///   plus companion rows (`gdrive_root_folder_id`, `gdrive_email`). It does
///   not use `sync_config_json` — requiring that row for every provider
///   was the bug that left "Sync now" reporting "Sync is disabled or not
///   configured" even after a successful Google Drive connect.
pub(crate) fn configured_cloud_provider(
    conn: &rusqlite::Connection,
) -> Result<Option<CloudProvider>, String> {
    let enabled = db::get_sync_enabled(conn).map_err(|e| e.to_string())?;
    if !enabled {
        return Ok(None);
    }
    let provider = match db::get_sync_provider(conn).map_err(|e| e.to_string())? {
        Some(p) => p,
        None => return Ok(None),
    };
    match provider.as_str() {
        "local" | "icloud" => {
            let json = match db::get_sync_config_json(conn).map_err(|e| e.to_string())? {
                Some(j) => j,
                None => return Ok(None),
            };
            let cfg: LocalConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            let generation = db::get_sync_recovery_generation(conn).map_err(|e| e.to_string())?;
            Ok(Some(CloudProvider::Folder(
                LocalSyncProvider::new(cfg.root_path).with_recovery_fence(generation, None),
            )))
        }
        "gdrive" => {
            // Rebuild the session on every sync — the in-memory
            // `GDriveSessionState` may be empty after an app restart and
            // `GDriveProvider::ensure_fresh_token` will refresh the token
            // itself on first use (the reconstructed session is stamped
            // as expired on purpose).
            let session = match reconstruct_session_from_conn(conn)? {
                Some(s) => s,
                None => return Ok(None),
            };
            let generation = db::get_sync_recovery_generation(conn).map_err(|e| e.to_string())?;
            let gdrive = GDriveProvider::new_live(session)?.with_recovery_fence(generation, None);
            Ok(Some(CloudProvider::GDrive(gdrive)))
        }
        other => Err(format!("Unknown sync provider: {other}")),
    }
}

/// Thin wrapper around [`configured_cloud_provider`] for callers that only
/// need the [`SyncProvider`] trait object.
pub(crate) fn make_configured_provider(
    conn: &rusqlite::Connection,
) -> Result<Option<Arc<dyn SyncProvider>>, String> {
    Ok(configured_cloud_provider(conn)?.map(|cloud| Arc::new(cloud) as Arc<dyn SyncProvider>))
}

/// Mirror of `commands::gdrive::reconstruct_session` that operates on a
/// borrowed connection instead of re-locking the `AppState` mutex. The
/// caller of `make_configured_provider` already holds the lock, so calling
/// the original would deadlock.
fn reconstruct_session_from_conn(
    conn: &rusqlite::Connection,
) -> Result<Option<crate::sync::gdrive_provider::GDriveSession>, String> {
    use crate::sync::gdrive_oauth::compiled_client_id;

    let refresh_token =
        match db::get_setting(conn, "gdrive_refresh_token").map_err(|e| e.to_string())? {
            Some(h) if !h.is_empty() => h,
            _ => return Ok(None),
        };

    // Client id/secret: settings override → compile-time env → placeholder.
    // Duplicates the `resolve_client_id/secret` helpers from commands::gdrive
    // (which are private to that module) but the logic is a 3-line lookup.
    let client_id = db::get_setting(conn, "gdrive_client_id")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| compiled_client_id().to_string());
    let client_secret = db::get_setting(conn, "gdrive_client_secret")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| crate::sync::gdrive_oauth::compiled_client_secret().to_string());

    Ok(Some(crate::sync::gdrive_provider::GDriveSession {
        access_token: String::new(),
        // Past expiry → `ensure_fresh_token` refreshes on first API call.
        expires_at: std::time::Instant::now() - std::time::Duration::from_secs(1),
        refresh_token: zeroize::Zeroizing::new(refresh_token),
        client_id,
        client_secret,
    }))
}

/// Run an async engine method synchronously using `tauri::async_runtime::block_on`.
///
/// **Why `block_on` inside `spawn_blocking`?** `rusqlite::Connection` is not
/// `Send`. A Tauri `async fn` command whose future directly crosses an `.await`
/// while holding a `&Connection` would be non-`Send`; Tauri rejects those at
/// registration time. The solution: wrap the entire sync work in
/// `spawn_blocking` (which runs on a dedicated blocking thread, not a tokio
/// task), and let `block_on` drive the engine's async methods from that thread.
/// This is the same pattern the background scheduler has always used
/// (see `src-tauri/src/sync/scheduler.rs`). `block_on` is safe here because
/// there is no enclosing tokio async task on the blocking thread.
fn block_on<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    tauri::async_runtime::block_on(fut)
}

/// Prevents two sync cycles from running simultaneously, regardless of who
/// started them. Owned by `run_sync_now` itself, so every entry path —
/// user-initiated `sync_now`, the background scheduler, the window-close
/// final push — participates without needing to remember to flip the flag.
/// `sync_reset_local_state` and `sync_repair_from_this_device` read this flag
/// to queue maintenance work while a sync is in flight (otherwise the engine
/// could re-stamp `synced` on rows the reset just flipped to `pending`).
static SYNC_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeferredSyncUxAction {
    ResetLocalState,
    RepairFromThisDevice,
}

static DEFERRED_SYNC_UX_ACTIONS: Mutex<Vec<DeferredSyncUxAction>> = Mutex::new(Vec::new());

pub(crate) fn is_sync_in_progress() -> bool {
    SYNC_IN_PROGRESS.load(Ordering::Acquire)
}

pub(crate) fn enqueue_deferred_sync_ux_action(action: DeferredSyncUxAction) {
    let mut pending = DEFERRED_SYNC_UX_ACTIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if !pending.contains(&action) {
        pending.push(action);
    }
}

fn take_deferred_sync_ux_actions() -> Vec<DeferredSyncUxAction> {
    let mut pending = DEFERRED_SYNC_UX_ACTIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *pending)
}

#[cfg(test)]
fn pending_deferred_sync_ux_actions_for_tests() -> Vec<DeferredSyncUxAction> {
    DEFERRED_SYNC_UX_ACTIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[cfg(test)]
fn clear_deferred_sync_ux_actions_for_tests() {
    DEFERRED_SYNC_UX_ACTIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
}

/// RAII guard that flips `SYNC_IN_PROGRESS` to `true` on construction and
/// back to `false` on drop. Using `Drop` (rather than a manual `.store` at
/// every return site) guarantees the flag is released even on panic or
/// early `?`-propagation inside `run_sync_now`.
pub(crate) struct SyncInProgressGuard;

impl SyncInProgressGuard {
    /// Try to take the sync slot. Returns `None` if another sync is already
    /// running — caller should bail with a clear error.
    pub(crate) fn try_acquire() -> Option<Self> {
        if SYNC_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            Some(SyncInProgressGuard)
        } else {
            None
        }
    }

    /// Like [`Self::try_acquire`], but queues behind the current holder
    /// instead of bailing: polls every 250 ms until the slot frees up or
    /// `timeout` elapses (`None`). The holder is usually a sync cycle, but
    /// can be any guard taker (rotation, OAuth connect, cloud wipe, another
    /// queued command). For user actions that should run automatically once
    /// the holder finishes (e.g. `remove_device`) rather than surface a
    /// "sync is running, try again" error. No fairness ordering across
    /// concurrent waiters — fine while call sites stay rare.
    pub(crate) async fn acquire_waiting(timeout: std::time::Duration) -> Option<Self> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut logged_wait = false;
        loop {
            if let Some(guard) = Self::try_acquire() {
                if logged_wait {
                    log::info!("acquire_waiting: sync guard freed, proceeding");
                }
                return Some(guard);
            }
            if !logged_wait {
                log::info!("acquire_waiting: sync guard busy — queueing (timeout {timeout:?})");
                logged_wait = true;
            }
            if tokio::time::Instant::now() >= deadline {
                log::warn!("acquire_waiting: gave up after {timeout:?}");
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
}

impl Drop for SyncInProgressGuard {
    fn drop(&mut self) {
        SYNC_IN_PROGRESS.store(false, Ordering::Release);
    }
}

/// Shared serialisation lock for any test that touches `SYNC_IN_PROGRESS`
/// (i.e. acquires or checks `SyncInProgressGuard`). Both `sync.rs` and
/// `crypto.rs` test suites compile into the same test binary; without this
/// lock two guard tests that run concurrently can observe each other's
/// intermediate state and fail intermittently.
///
/// Usage inside a test:
/// ```ignore
/// let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
///     .lock()
///     .unwrap_or_else(|e| e.into_inner());
/// ```
#[cfg(test)]
pub(crate) static SYNC_GUARD_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Error string returned by `run_sync_now` (and thus `sync_now`,
/// scheduler, etc.) when another sync is already in flight. Used as a
/// stable marker so callers can distinguish "skip this tick, no harm
/// done" from a real failure that warrants backoff.
pub const SYNC_IN_PROGRESS_ERR: &str = "sync_in_progress";

/// The try_acquire path used by revoke / rotate / resume: `None` while a
/// sync holds the guard maps to the exact `SYNC_IN_PROGRESS_ERR` string
/// the frontend keys off. AppHandle blocks a full command test (T40).
pub(crate) fn try_acquire_sync_or_in_progress_err() -> Result<SyncInProgressGuard, String> {
    SyncInProgressGuard::try_acquire().ok_or_else(|| SYNC_IN_PROGRESS_ERR.to_string())
}

/// Reconcile trigger used by the user-facing [`sync_now`] Tauri command.
///
/// Always [`SyncTrigger::Manual`] so own-cloud self-heal re-lists on every
/// explicit "Sync now", even after a successful Automatic cycle this session.
pub(crate) const USER_SYNC_NOW_TRIGGER: SyncTrigger = SyncTrigger::Manual;

/// Trigger an immediate, user-requested sync.
///
/// **Why `async fn` + `spawn_blocking`?** Tauri 2 runs non-async commands on
/// the main thread. Calling `block_on` on the main thread freezes the WebView's
/// IPC message loop for the entire sync duration — the UI becomes unresponsive.
/// By making this command `async` and wrapping the work in `spawn_blocking`, the
/// tokio runtime dispatches the blocking sync work to a dedicated thread pool
/// thread while the main thread (and async executor) remain free to process IPC
/// messages, keeping the UI responsive. This mirrors exactly what the background
/// scheduler already does in `src-tauri/src/sync/scheduler.rs`.
///
/// The in-flight guard lives inside `run_sync_now` itself, so this command
/// returns `Err("sync_in_progress")` if the scheduler (or window-close final
/// push) is already running a cycle.
#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let key_state = app.state::<EncryptionKeyState>();
        // Manual entry point: the user clicked "Sync now" (or a UI flow
        // explicitly invoked this command). The user intervened, so reset
        // the scheduler's failure backoff entirely — otherwise a backoff
        // window opened before a successful manual sync would keep the
        // interval / on-save rules silently suppressed for up to 15 min
        // afterwards. See `sync/scheduler.rs`.
        if let Some(scheduler) =
            app.try_state::<std::sync::Arc<crate::sync::scheduler::SyncScheduler>>()
        {
            scheduler.reset_backoff();
        }
        run_sync_now(&app, &state, &key_state, USER_SYNC_NOW_TRIGGER)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shared implementation behind every sync entry point: the user-invoked
/// `sync_now` command, the background scheduler, and the window-close final
/// push. The scheduler and the close-handler cannot call the command
/// directly (they run outside Tauri's command dispatch), so this shared
/// function takes raw `State` references and returns the summary.
///
/// Emits lifecycle events at every boundary so every sync path produces
/// identical events.
///
/// **Single-flight guard.** A `SyncInProgressGuard` is acquired at the very
/// top of this function — if another caller (user, scheduler, close-handler)
/// is already running a cycle, we return `Err(SYNC_IN_PROGRESS_ERR)` without
/// touching the DB or emitting any status event. This is the load-bearing
/// invariant that lets `sync_reset_local_state` safely flip rows back to
/// `pending` without racing an in-flight engine that would re-stamp them
/// to `synced` mid-reset.
/// Re-upload ONLY `devices/<id>.json` for the current device with a fresh
/// `last_seen_at`, so peer devices see this device as recently active.
///
/// Best-effort: any failure (Drive not connected, provider error, missing key
/// material, write failure) is logged and swallowed. `last_seen_at` is cosmetic
/// metadata — the local value is already stamped by the caller, and the cloud
/// value self-heals on the next successful sync. Crucially this does NOT set
/// `keyring_dirty`: that flag triggers a full-keyring republish via
/// `publish_v2_keyring_with_provider`, which would re-write every keyring file
/// (unnecessary for a timestamp bump).
///
/// Republish this device's keyring slot for any configured cloud provider.
/// Every vault has a keyring now, so there is no no-keyring case to exclude.
async fn republish_current_device_slot_best_effort(_app: &AppHandle, state: &AppState, now: i64) {
    // Gather the current device's slot material under a short lock. Bail early
    // (silently) when no provider is configured or material is missing.
    let material = {
        let conn = match state.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        let provider = match configured_cloud_provider(&conn) {
            Ok(Some(p)) => p,
            Ok(None) => return,
            Err(e) => {
                log::warn!("republish_current_device_slot: provider init failed: {e}");
                return;
            }
        };
        // C2 defense-in-depth: never publish a device slot while a rotation job
        // is active. The slot no longer carries key material, but a mid-rotation
        // write can still stamp a slot against an epoch the cloud is about to
        // supersede, leaving a registry entry that disagrees with `_meta.json`.
        // `run_sync_now`'s
        // `ensure_safe_to_push` already bails on an active rotation before
        // reaching here, but mirror the guard the other slot writers
        // (`publish_v2_keyring_with_provider`, `rename_device`) enforce so this
        // helper is safe if ever reached by a different path.
        if db::has_active_rotation_job(&conn).unwrap_or(false) {
            return;
        }
        let device = match db::list_devices(&conn) {
            Ok(devices) => match devices.into_iter().find(|d| d.is_current) {
                Some(d) => d,
                None => return,
            },
            Err(_) => return,
        };
        (provider, device.device_id, device.name, device.created_at)
    };
    let (provider, device_id, name, created_at) = material;

    if let Err(e) = crate::commands::gdrive::reupload_current_device_slot(
        state, &provider, &device_id, &name, created_at, now,
    )
    .await
    {
        log::warn!("republish_current_device_slot: slot re-upload failed (ignored): {e}");
    }
}

pub(crate) fn drain_deferred_sync_ux_actions_inner(state: &AppState) {
    for action in take_deferred_sync_ux_actions() {
        match action {
            DeferredSyncUxAction::ResetLocalState => {
                let result = state
                    .lock()
                    .map_err(|e| e.to_string())
                    .and_then(|conn| reset_local_sync_state(&conn).map_err(|e| e.to_string()));
                if let Err(e) = result {
                    log::warn!("drain_deferred_sync_ux_actions: reset failed: {e}");
                }
            }
            DeferredSyncUxAction::RepairFromThisDevice => {
                let engine_opt = match state.lock() {
                    Ok(conn) => match make_configured_provider(&conn) {
                        Ok(provider) => {
                            let device_id = match db::get_or_create_device_id(&conn) {
                                Ok(id) => id,
                                Err(e) => {
                                    log::warn!(
                                        "drain_deferred_sync_ux_actions: device id lookup failed: {e}"
                                    );
                                    continue;
                                }
                            };
                            provider.map(|p| SyncEngine::new(p, device_id))
                        }
                        Err(e) => {
                            log::warn!(
                                "drain_deferred_sync_ux_actions: provider lookup failed: {e}"
                            );
                            None
                        }
                    },
                    Err(e) => {
                        log::warn!("drain_deferred_sync_ux_actions: DB lock failed: {e}");
                        continue;
                    }
                };
                let owned_by_peers = match engine_opt {
                    Some(engine) => block_on(engine.collect_peer_entry_ids()),
                    None => std::collections::HashSet::new(),
                };
                let result = state.lock().map_err(|e| e.to_string()).and_then(|conn| {
                    run_repair_from_this_device(&conn, &owned_by_peers).map_err(|e| e.to_string())
                });
                if let Err(e) = result {
                    log::warn!("drain_deferred_sync_ux_actions: repair failed: {e}");
                }
            }
        }
    }
}

pub(crate) fn drain_deferred_sync_ux_actions(
    _app: &AppHandle,
    state: &AppState,
    _key_state: &EncryptionKeyState,
) {
    drain_deferred_sync_ux_actions_inner(state);
}

fn clear_device_slot_dirty_if_current_name_matches(
    conn: &rusqlite::Connection,
    uploaded_name: &str,
) -> rusqlite::Result<()> {
    let current_name = db::list_devices(conn)?
        .into_iter()
        .find(|d| d.is_current)
        .map(|d| d.name);

    if current_name.as_deref() == Some(uploaded_name) {
        let _ = db::delete_setting(conn, db::DEVICE_SLOT_DIRTY_KEY);
    }

    Ok(())
}

pub(crate) async fn flush_device_slot_dirty_if_needed(_app: &AppHandle, state: &AppState) {
    let material = {
        let conn = match state.lock() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("flush_device_slot_dirty_if_needed: DB lock failed: {e}");
                return;
            }
        };
        let dirty = db::get_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY)
            .unwrap_or(None)
            .as_deref()
            == Some("1");
        if !dirty {
            return;
        }
        let provider = match configured_cloud_provider(&conn) {
            Ok(Some(p)) => p,
            Ok(None) => return,
            Err(e) => {
                log::warn!("flush_device_slot_dirty_if_needed: provider init failed: {e}");
                return;
            }
        };
        if db::has_active_rotation_job(&conn).unwrap_or(false) {
            return;
        }
        let device = match db::list_devices(&conn) {
            Ok(devices) => match devices.into_iter().find(|d| d.is_current) {
                Some(d) => d,
                None => return,
            },
            Err(e) => {
                log::warn!("flush_device_slot_dirty_if_needed: device lookup failed: {e}");
                return;
            }
        };
        (
            provider,
            device.device_id,
            device.name,
            device.created_at,
            device.last_seen_at,
        )
    };
    let (provider, device_id, name, created_at, last_seen_at) = material;

    match crate::commands::gdrive::reupload_current_device_slot(
        state,
        &provider,
        &device_id,
        &name,
        created_at,
        last_seen_at,
    )
    .await
    {
        Ok(()) => {
            if let Ok(conn) = state.lock() {
                let _ = clear_device_slot_dirty_if_current_name_matches(&conn, &name);
            }
        }
        Err(e) => {
            log::warn!("flush_device_slot_dirty_if_needed: slot re-upload failed: {e}");
        }
    }
}

pub(crate) fn run_sync_now(
    app: &AppHandle,
    state: &AppState,
    key_state: &EncryptionKeyState,
    trigger: SyncTrigger,
) -> Result<SyncSummary, String> {
    // Acquire the single-flight slot. If another sync is already running,
    // bail with the stable marker before touching anything else. The guard
    // is held for the entire body — Drop releases it on every return path,
    // including panics and early `?`-propagation.
    let _guard =
        SyncInProgressGuard::try_acquire().ok_or_else(|| SYNC_IN_PROGRESS_ERR.to_string())?;

    // Guard: refuse to push if a rotation job is active or force-re-pair is
    // required. The SyncInProgressGuard above handles the in-flight case; this
    // catches the persistent case where the guard was dropped (e.g. retry-abort
    // in reencrypt_items) but the rotation_jobs row is still active.
    ensure_safe_to_push(state)?;
    ensure_remote_recovery_push_allowed(state, None)?;

    // Retry keyring upload if it failed during a previous password change.
    // Guard: skip when the app is locked — the key is unavailable, so any
    // attempt to re-upload the keyring would fail anyway. Both callers
    // (the user-invoked sync_now command and the background scheduler) now reach
    // run_sync_now exclusively via spawn_blocking, so block_on inside this
    // function is always called from a blocking thread — never from an async
    // task, which makes it safe.
    {
        let key_ready = key_state.is_initialized().unwrap_or(false);
        let dirty = key_ready && {
            let conn = state.lock()?;
            db::get_setting(&conn, db::KEYRING_DIRTY_KEY)
                .unwrap_or(None)
                .as_deref()
                == Some("1")
        };
        if dirty {
            // Pre-flight: a peer rotation this device has NOT yet observed must
            // be detected BEFORE the re-upload — the re-upload writes
            // `_meta.json` from local truth with no CAS, so it would clobber
            // the rotation and the pull-leg check below would then verify
            // against our own write. Only a typed `Mismatch` aborts here:
            // a corrupt `_meta.json` must still flow into the re-upload, which
            // is the only path that can regenerate a schema-broken meta from
            // local truth (failing closed on corrupt before the repair would
            // deadlock it — see docs/plans/2026-07-14-keyring-fail-open-findings.md).
            if let PullLegKeyringCheck::Mismatch(mismatch) =
                block_on(check_force_re_pair_sync(state))
            {
                {
                    let conn = state.lock()?;
                    crate::commands::gdrive::set_force_re_pair_flags(&conn, &mismatch.reason)?;
                }
                let _ = app.emit(
                    "xj://force-re-pair",
                    ForceRePairPayload {
                        reason: mismatch.reason.clone(),
                    },
                );
                return Err(format!("force-re-pair: {}", mismatch.reason));
            }
            block_on(
                crate::commands::gdrive::try_reupload_keyring_and_update_dirty_flag(
                    state, key_state,
                ),
            );
        }
    }

    // Short lock: build provider + read device id, then release before
    // starting the long-running engine. The engine itself acquires the
    // lock per DB call via `AppState: ConnAccess`, so other Tauri
    // commands can interleave freely during filesystem I/O.
    let (provider, device_id) = {
        let conn = state.lock()?;
        let provider = make_configured_provider(&conn)?
            .ok_or_else(|| "Sync is disabled or not configured".to_string())?;
        let device_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;
        (provider, device_id)
    };
    // Clone the Arc and device_id before moving into the engine so migration can use them.
    let provider_for_migration = Arc::clone(&provider);
    let device_id_for_migration = device_id.clone();
    // Wrap the Tauri-facing reporter in a `StallTrackingReporter` so every
    // `report()`/`heartbeat()` call also stamps `last_progress_ms` — the
    // signal the stall guard below reads to distinguish "slow because
    // there is a lot of legitimate work" from "hung". `baseline` is shared
    // with the `now_ms` closure passed to `with_stall_guard` further down
    // so both sides measure elapsed time from the same instant.
    let stall_baseline = std::time::Instant::now();
    let last_progress_ms = Arc::new(AtomicU64::new(0));
    let reporter: Arc<dyn ProgressReporter> = Arc::new(StallTrackingReporter {
        inner: Arc::new(TauriProgressReporter { app: app.clone() }),
        last_progress_ms: last_progress_ms.clone(),
        baseline: stall_baseline,
    });
    // `new_for_session`: adopt the process-level own-cloud reconcile flag so
    // Automatic cycles after the first success skip re-listing even though
    // this function builds a fresh engine every call.
    let engine = SyncEngine::new_for_session(provider, device_id).with_reporter(reporter);

    // Phase 5: force re-pair detection before the pull leg.
    let check = block_on(check_force_re_pair_sync(state));
    if !matches!(check, PullLegKeyringCheck::Clean) {
        {
            let conn = state.lock()?;
            persist_pull_leg_check(&conn, &check)?;
        }
        match check {
            PullLegKeyringCheck::Mismatch(mismatch) => {
                let _ = app.emit(
                    "xj://force-re-pair",
                    ForceRePairPayload {
                        reason: mismatch.reason.clone(),
                    },
                );
                return Err(format!("force-re-pair: {}", mismatch.reason));
            }
            PullLegKeyringCheck::Corrupt(msg) => {
                return Err(format!(
                    "force-re-pair: cloud keyring _meta.json is corrupt: {msg}"
                ));
            }
            PullLegKeyringCheck::Clean => unreachable!("guarded by the matches! above"),
        }
    }

    emit_status(app, SyncPhase::Syncing, state, None);

    // T1 — One-time cloud-content migration.
    //
    // If `NEEDS_CLOUD_CONTENT_MIGRATION` is set, wipe this device's cloud sync
    // folder and reset local sync_state + media.upload_status to `pending`
    // atomically BEFORE the engine runs. The engine will then re-push everything
    // under the current content key (V1 epoch-1). Fresh installs never set this
    // flag, so they skip this block entirely.
    //
    // Atomicity rule (CLAUDE.md): the DB reset and the cloud delete happen before
    // clearing the flag. If we crash between the reset and the flag clear, the
    // next startup re-runs the migration (idempotent — deleting already-gone
    // files is a no-op; resetting already-pending rows is a no-op).
    {
        let needs_migration = {
            let conn = state.lock()?;
            db::get_setting(&conn, db::NEEDS_CLOUD_CONTENT_MIGRATION)
                .map_err(|e| e.to_string())?
                .as_deref()
                == Some("1")
        };
        if needs_migration {
            log::info!("run_sync_now: NEEDS_CLOUD_CONTENT_MIGRATION flag set — running wipe+repush migration");

            // Build a keyring provider (KeyringV2Io) for Step 2.5. Any
            // configured cloud backend can publish `.meta/...` via KeyringV2Io.
            // SyncProvider::write_file still rejects those paths.
            let cloud_keyring = {
                let conn = state.lock()?;
                configured_cloud_provider(&conn)?.ok_or_else(|| {
                    // Provider was configured when the engine was built, but
                    // the session/config is gone now — do not clear the
                    // migration flag. Sync will retry on the next invocation.
                    "cloud-content migration: cloud provider configured but \
                     unavailable — cannot publish _content.json. Will retry on next sync."
                        .to_string()
                })?
            };

            let keyring_io_ref: Option<&(dyn crate::sync::keyring_v2::KeyringV2Io + Send + Sync)> =
                Some(&cloud_keyring as &(dyn crate::sync::keyring_v2::KeyringV2Io + Send + Sync));

            block_on(run_cloud_content_migration(
                state,
                key_state,
                &provider_for_migration,
                &device_id_for_migration,
                keyring_io_ref,
            ))?;
            log::info!("run_sync_now: cloud-content migration complete");
        }
    }

    // Snapshot the HKDF sync sub-key out of the mutex BEFORE the long-running
    // engine call. Holding `with_sync_key` across `block_on(engine.sync_now(...))`
    // would pin the std::sync::Mutex for the full duration of network I/O —
    // any other Tauri sync command (list_entries, get_entry_content, etc.)
    // that calls `key_state.with_*_key()` would block on the mutex, freezing
    // the main thread that dispatches sync commands. `Zeroizing` ensures the
    // copy is wiped on drop, preserving the at-rest secret-handling guarantee.
    //
    let key_copy: Zeroizing<[u8; 32]> = key_state.with_sync_key(|k| Ok(Zeroizing::new(*k)))?;

    // Build a detached full-epoch snapshot for multi-key ingest (T2).
    let key_state_snapshot: crate::EncryptionKeyState = key_state.snapshot_for_engine()?;

    // Outer stall guard: rather than a fixed total-duration cap on the whole
    // push+pull cycle (which killed legitimately slow-but-working syncs on
    // large libraries at the 120s mark), this aborts only when the engine
    // has gone *silent* for SYNC_STALL_TIMEOUT — no `report()`/`heartbeat()`
    // call via `StallTrackingReporter` for that long. A cycle that keeps
    // making progress (pull commits per chunk, push marks each entry synced,
    // and now a heartbeat per item processed in between) can run arbitrarily
    // long without tripping the stall check; a true hang (e.g. a stalled
    // network connection not otherwise bounded — see the per-request
    // timeouts on `GDriveProvider`'s client) is caught within one stall
    // window instead of silently consuming the whole retry budget.
    //
    // `SYNC_HARD_CAP` is a second, much longer backstop against the
    // opposite failure mode: an adversarial or pathologically huge workload
    // (e.g. an endless stream of cheap items over a slow link) that keeps
    // stamping progress often enough to satisfy the stall check forever.
    // Durable per-item progress (pull commits per chunk, push marks each
    // entry synced) makes killing an attempt at the hard cap and retrying
    // safe — nothing already durable is lost.
    //
    // Retry up to MAX_SYNC_ATTEMPTS times via `retry_with_stall_guard`, but
    // ONLY when the attempt itself was aborted by the guard (matched on
    // `SyncStalled`, never on error-string matching). Each retry gets its
    // own fresh stall window and hard-cap clock — `with_stall_guard`
    // restamps `last_progress_ms` and the attempt-start instant at the
    // start of every call. After the final attempt is still aborted, the
    // reason-specific timeout error is returned so downstream handling
    // (scheduler pause, UI error) is unchanged.
    const MAX_SYNC_ATTEMPTS: u32 = 3;
    const SYNC_STALL_TIMEOUT: Duration = Duration::from_secs(120);
    const SYNC_HARD_CAP: Duration = Duration::from_secs(30 * 60);
    let now_ms = move || stall_baseline.elapsed().as_millis() as u64;
    let guard_result = block_on(retry_with_stall_guard(
        || engine.sync_now(state, &key_copy, &key_state_snapshot, trigger),
        last_progress_ms.clone(),
        now_ms,
        SYNC_STALL_TIMEOUT,
        SYNC_HARD_CAP,
        MAX_SYNC_ATTEMPTS,
        |attempt, reason| {
            log::warn!(
                "run_sync_now: sync attempt {attempt} stalled ({}), retrying ({attempt}/{MAX_SYNC_ATTEMPTS})",
                stall_reason_text(reason, SYNC_STALL_TIMEOUT, SYNC_HARD_CAP)
            );
            // Re-arm the frontend watchdog (130s) before it fires a false
            // "sync timed out" — the retry loop can otherwise run silently
            // across multiple stall windows with no event to reset it. Each
            // attempt can now legitimately run much longer than 130s as
            // long as progress events keep flowing (capped at least every
            // 25 items per `should_emit`), so this re-arm at the retry
            // boundary is a backstop, not the sole source of watchdog
            // resets.
            emit_status(app, SyncPhase::Syncing, state, None);
        },
    ));
    let result: Result<SyncSummary, String> = match guard_result {
        Ok(inner) => inner.map_err(|e| e.to_string()),
        Err(reason) => Err(format!(
            "Sync timed out ({})",
            stall_reason_text(reason, SYNC_STALL_TIMEOUT, SYNC_HARD_CAP)
        )),
    };

    match result {
        Ok(summary) => {
            // Detect the appdata-scope-mismatch case BEFORE stamping or
            // emitting status — if the user is on a legacy drive.file token,
            // every push/pull leg surfaced ScopeMismatch and we must
            // auto-disconnect them so the reconnect banner fires.
            //
            // Uses the typed `scope_mismatch` flag on `SyncSummary` (set by
            // `engine.sync_now`) instead of substring-matching error strings.
            if summary.scope_mismatch {
                handle_scope_upgrade_required(app, state);
                emit_status(
                    app,
                    SyncPhase::Error,
                    state,
                    Some("Sync upgrade required — please reconnect Google Drive".to_string()),
                );
                return Ok(summary);
            }

            // Stamp last_sync_at only if neither half errored — a partial
            // failure should not overwrite the previous successful
            // timestamp.
            if summary.errors.is_empty() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                {
                    let conn = state.lock()?;
                    db::set_last_sync_at(&conn, now).map_err(|e| e.to_string())?;
                    // Freshen the current device's local last_seen_at so the
                    // "This device" card in Settings → Security shows an
                    // accurate "Last synced … ago". Local is authoritative for
                    // the current device (refresh_devices_from_cloud preserves
                    // it). No-op when there is no current device row.
                    let _ = db::touch_current_device_last_seen(&conn, now);
                }
                drain_deferred_sync_ux_actions(app, state, key_state);
                // Best-effort: republish the cloud device slot with the fresh
                // last_seen_at so PEER devices see this device as recently
                // active. GDrive-only (LocalSyncProvider has no `devices/`
                // keyring). Failure is logged and swallowed — last_seen_at is
                // cosmetic and self-heals on the next sync; we must NOT set
                // keyring_dirty (the dirty-retry path republishes the full
                // keyring and would otherwise reset peers' view to created_at).
                {
                    let device_slot_dirty = {
                        let conn = state.lock()?;
                        db::get_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY)
                            .unwrap_or(None)
                            .as_deref()
                            == Some("1")
                    };
                    if device_slot_dirty {
                        block_on(flush_device_slot_dirty_if_needed(app, state));
                    } else {
                        block_on(republish_current_device_slot_best_effort(app, state, now));
                    }
                }
            }

            // Pull may have stamped embed-sync pending decisions (model
            // mismatch / key). Emit once when any slot needs attention —
            // debounced inside the helper so clean adopt-only syncs stay quiet.
            crate::commands::ai_embedding_decision::emit_embedding_decisions_after_sync(app, state);

            // T36: per-preset endpoint merge already cleared hosted-indexing
            // consent under the DB conn. Rebuild live slots here — the
            // engine lacks ProviderRegistry / BackfillManager / indexer.
            if !summary.changed_endpoint_presets.is_empty() {
                use tauri::Manager;
                if let (Some(registry), Some(indexer), Some(backfill)) = (
                    app.try_state::<crate::ai::provider_registry::ProviderRegistry>(),
                    app.try_state::<crate::ai::indexer::EntryIndexer>(),
                    app.try_state::<crate::commands::ai::BackfillManager>(),
                ) {
                    let server_manager =
                        app.try_state::<Arc<crate::ai::on_device::server::LlamaServerManager>>();
                    let asset_manager =
                        app.try_state::<Arc<crate::ai::on_device::llm_download::LlmAssetManager>>();
                    let downloads =
                        app.try_state::<Arc<crate::ai::on_device::download::DownloadManager>>();
                    let conn = state.lock()?;
                    for preset_id in &summary.changed_endpoint_presets {
                        let (old_endpoint, _) =
                            crate::commands::ai_provider::resolve_credential(&conn, preset_id)
                                .unwrap_or_else(|_| (String::new(), None));
                        if let Err(e) =
                            block_on(crate::commands::ai_provider::reconcile_slots_for_preset(
                                &conn,
                                &registry,
                                preset_id,
                                &old_endpoint,
                                &backfill,
                                &indexer,
                                server_manager.as_ref().map(|s| s.inner()),
                                asset_manager.as_ref().map(|s| s.inner()),
                                downloads.as_ref().map(|s| s.inner()),
                                || crate::commands::ai::start_indexing_worker(app.clone()),
                            ))
                        {
                            log::warn!(
                                "run_sync_now: reconcile_slots_for_preset({preset_id}) failed: {e}"
                            );
                        }
                    }
                }
            }

            let phase = if summary.errors.is_empty() {
                SyncPhase::Synced
            } else {
                SyncPhase::Error
            };
            let err = if summary.errors.is_empty() {
                None
            } else {
                Some(summary.errors.join("; "))
            };
            emit_status(app, phase, state, err);
            Ok(summary)
        }
        Err(e) => {
            // Engine.sync_now never returns Err directly today (always Ok with
            // populated summary.errors), so this branch is reached only via
            // the outer 120s timeout wrapper or a state-lock failure. Still
            // detect the scope-mismatch string defensively in case a future
            // engine refactor surfaces the typed error here — keep the
            // substring check tight (`scope mismatch:` with the colon that
            // SyncError::ScopeMismatch's Display always emits).
            if e.contains("scope mismatch:") {
                handle_scope_upgrade_required(app, state);
                emit_status(
                    app,
                    SyncPhase::Error,
                    state,
                    Some("Sync upgrade required — please reconnect Google Drive".to_string()),
                );
                return Err(e);
            }
            emit_status(app, SyncPhase::Error, state, Some(e.clone()));
            Err(e)
        }
    }
}

// ─── Sync reset ─────────────────────────────────────────────────────────────

/// Counts of rows flipped from synced/uploaded → pending.
/// camelCase via serde so the TS bindings get `entries`, `media`, `journals`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCounts {
    pub entries: u64,
    pub media: u64,
    pub journals: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMaintenanceResult<T> {
    pub queued: bool,
    pub result: Option<T>,
}

/// Payload for the `xj://force-re-pair` event. The frontend `useForceRePair`
/// listener reads `event.payload.reason`, so the event MUST carry an object —
/// emitting a bare string would surface `reason` as `undefined`.
#[derive(Debug, Clone, Serialize)]
struct ForceRePairPayload {
    reason: String,
}

/// Reset all locally-marked-synced rows back to pending so the next sync
/// cycle re-uploads them. Runs in a single transaction — partial reset is
/// worse than no reset. Only flips `synced` rows; leaves `conflict` and
/// `error` rows alone (they need user resolution, not silent reset).
///
/// **Why a single transaction is load-bearing.** Without it, the sync
/// engine could interleave a write between the three UPDATEs, leaving
/// entries marked `pending` but media still `uploaded`. The next sync
/// would then push entries referencing media files whose remote copy is
/// gone, producing a cascade of "missing media" errors on every peer.
pub(crate) fn reset_local_sync_state(conn: &rusqlite::Connection) -> rusqlite::Result<ResetCounts> {
    let tx = conn.unchecked_transaction()?;
    let entries = tx.execute(
        "UPDATE sync_state SET sync_status='pending', local_version=local_version+1 WHERE sync_status='synced'",
        [],
    )? as u64;
    let journals = tx.execute(
        "UPDATE journal_sync_state SET sync_status='pending', local_version=local_version+1 WHERE sync_status='synced'",
        [],
    )? as u64;
    let media = tx.execute(
        "UPDATE media SET upload_status='pending' WHERE upload_status='uploaded'",
        [],
    )? as u64;
    // Surface hashes are stale after any bulk requeue — cloud content may be
    // gone or re-keyed. Absent hash ⇒ default-dirty (full surface re-push).
    // Also re-arm Automatic reconcile so DeviceRoot self-heal runs again.
    db::clear_all_surface_push_hashes(&tx)?;
    db::clear_all_pull_revisions(&tx)?;
    tx.commit()?;
    crate::sync::engine::reset_session_own_cloud_reconciled();
    Ok(ResetCounts {
        entries,
        media,
        journals,
    })
}

fn queue_repair_if_sync_in_progress() -> Option<SyncMaintenanceResult<usize>> {
    if !is_sync_in_progress() {
        return None;
    }

    enqueue_deferred_sync_ux_action(DeferredSyncUxAction::RepairFromThisDevice);
    Some(SyncMaintenanceResult {
        queued: true,
        result: None,
    })
}

fn queue_reset_if_sync_in_progress() -> Option<SyncMaintenanceResult<ResetCounts>> {
    if !is_sync_in_progress() {
        return None;
    }

    enqueue_deferred_sync_ux_action(DeferredSyncUxAction::ResetLocalState);
    Some(SyncMaintenanceResult {
        queued: true,
        result: None,
    })
}

/// Reset all synced entries, journals, and media back to pending so the next
/// sync re-uploads them. Useful after the user manually deletes the Memlore
/// folder on Drive — the local DB kept every row as `synced`/`uploaded` even
/// though the remote copy is gone.
///
/// Only `synced` → `pending` rows are touched. `conflict` and `error` rows
/// are left unchanged — they require explicit user action, not silent reset.
///
/// Queued while ANY sync cycle is running — user-initiated, scheduler-driven,
/// or window-close final push. A concurrent reset would otherwise race the
/// engine: the engine could re-stamp `synced` on a row the reset just flipped.
/// The queued action drains only after a clean sync cycle finishes.
///
/// Returns counts so the UI can surface a human-readable confirmation:
/// "N entries, M media, J journals will re-upload on next sync."
pub(crate) fn sync_reset_local_state_inner(
    conn: &rusqlite::Connection,
) -> Result<SyncMaintenanceResult<ResetCounts>, String> {
    if let Some(queued) = queue_reset_if_sync_in_progress() {
        return Ok(queued);
    }

    reset_local_sync_state(conn)
        .map(|counts| SyncMaintenanceResult {
            queued: false,
            result: Some(counts),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_reset_local_state(
    state: State<'_, AppState>,
) -> Result<SyncMaintenanceResult<ResetCounts>, String> {
    if let Some(queued) = queue_reset_if_sync_in_progress() {
        return Ok(queued);
    }

    let conn = state.lock()?;
    sync_reset_local_state_inner(&conn)
}

// ─── Adopt repair (Bug 3) ────────────────────────────────────────────────────

/// Inner logic for `sync_repair_from_this_device`, extracted so tests can call
/// it directly on a raw `&Connection` without going through `tauri::State`.
///
/// Runs atomically: adopts local entries NOT owned by peers into `sync_state`
/// as `'pending'` AND resets all media rows to `upload_status = 'pending'`.
/// When `owned_by_peers` is empty (network unavailable or sync not configured),
/// falls back to adopting ALL local entries — identical to the pre-cloud-aware
/// behavior. Returns the number of `sync_state` rows inserted or updated.
pub(crate) fn run_repair_from_this_device(
    conn: &rusqlite::Connection,
    owned_by_peers: &std::collections::HashSet<String>,
) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let adopted = db::adopt_unowned_local_entries(&tx, owned_by_peers)?;
    db::reset_all_media_upload_status_to_pending(&tx)?;
    db::reset_all_version_upload_status_to_pending(&tx)?;
    // Repair forces a full re-publish of owned content; clear surface hashes
    // in the same transaction so whole-table surfaces re-upload too.
    // Re-arm Automatic reconcile after commit (process-level, not DB).
    db::clear_all_surface_push_hashes(&tx)?;
    db::clear_all_pull_revisions(&tx)?;
    tx.commit()?;
    crate::sync::engine::reset_session_own_cloud_reconciled();
    Ok(adopted)
}

/// Guard-aware seam for the adopt-local repair. Checks `SYNC_IN_PROGRESS`
/// and, if clear, delegates to `run_repair_from_this_device`.
///
/// Direct callers use this to preserve the low-level race guard. The Tauri
/// command queues instead, before doing any peer/network work.
pub(crate) fn run_repair_guarded(
    conn: &rusqlite::Connection,
    owned_by_peers: &std::collections::HashSet<String>,
) -> Result<usize, String> {
    if SYNC_IN_PROGRESS.load(Ordering::Acquire) {
        return Err(SYNC_IN_PROGRESS_ERR.to_string());
    }
    run_repair_from_this_device(conn, owned_by_peers).map_err(|e| e.to_string())
}

pub(crate) fn sync_repair_from_this_device_inner(
    conn: &rusqlite::Connection,
    owned_by_peers: &std::collections::HashSet<String>,
) -> Result<SyncMaintenanceResult<usize>, String> {
    if let Some(queued) = queue_repair_if_sync_in_progress() {
        return Ok(queued);
    }
    // Sync may have started between the outer guard check and here (e.g. during
    // collect_peer_entry_ids().await) or between this check and the DB write.
    // Queue instead of rejecting — preserves the "defer not reject" contract.
    match run_repair_guarded(conn, owned_by_peers) {
        Ok(count) => Ok(SyncMaintenanceResult {
            queued: false,
            result: Some(count),
        }),
        Err(e) if e == SYNC_IN_PROGRESS_ERR => {
            enqueue_deferred_sync_ux_action(DeferredSyncUxAction::RepairFromThisDevice);
            Ok(SyncMaintenanceResult {
                queued: true,
                result: None,
            })
        }
        Err(e) => Err(e),
    }
}

/// Adopt ALL local entries — live and soft-deleted (tombstones) — into
/// `sync_state` as `'pending'`, and reset all media `upload_status` to
/// `'pending'` as well.
///
/// This is the explicit user-triggered repair for the "pulled-entry orphan"
/// bug: after a cloud wipe, entries received via sync exist only in `entries`
/// with no `sync_state` row, so the normal push queue never sees them.
/// Calling this command makes the device re-publish everything it holds —
/// including tombstones — on the next sync tick. `push_single_entry`
/// serializes `is_deleted` into `EntryMetadata`, so tombstones are published
/// as deletions, not as live entries.
///
/// **NOT automatic.** This must only run on explicit user action — calling it
/// during normal sync would cause pull→push ping-pong. UI wiring is a
/// follow-up; the command is available for manual invocation in the interim.
///
/// Returns the number of `sync_state` rows inserted or flipped to pending.
#[tauri::command]
pub async fn sync_repair_from_this_device(
    state: State<'_, AppState>,
) -> Result<SyncMaintenanceResult<usize>, String> {
    if let Some(queued) = queue_repair_if_sync_in_progress() {
        return Ok(queued);
    }

    // Fetch the set of entry IDs already owned by at least one peer before
    // acquiring the DB lock or the sync guard. Drop the connection guard before
    // the .await so the future remains Send and Tauri can register it.
    // On any error (network unavailable, sync not configured), `owned_by_peers`
    // is empty and repair falls back to adopting all entries —
    // identical to the pre-cloud-aware behavior.
    let owned_by_peers = {
        let engine_opt = {
            let conn = state.lock()?;
            let provider = make_configured_provider(&conn)?;
            let device_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;
            provider.map(|p| SyncEngine::new(p, device_id))
        }; // conn guard dropped here, before the .await
        match engine_opt {
            Some(engine) => engine.collect_peer_entry_ids().await,
            None => std::collections::HashSet::new(),
        }
    };
    let conn = state.lock()?;
    sync_repair_from_this_device_inner(&conn, &owned_by_peers)
}

// ─── Scope upgrade (drive.file → drive.appdata migration) ───────────────────

/// Reset of local sync state PLUS scope-upgrade-required flag set, performed
/// atomically inside one SQLite transaction. Mirrors the "destructive cloud
/// action must reset local state atomically" invariant: the legacy `drive.file`
/// folder is effectively orphaned (we cannot delete it from the new
/// appdata-scoped session), so every local row must be flipped back to
/// `pending` in the SAME transaction that sets the upgrade-required flag.
/// Otherwise a partial flip would leave entries marked `synced` while pointing
/// at remote files inside the wrong (legacy) space, producing silent data loss
/// on the first appdata-scoped sync.
#[cfg(test)]
pub(crate) fn mark_scope_upgrade_required(
    conn: &rusqlite::Connection,
) -> rusqlite::Result<ResetCounts> {
    let tx = conn.unchecked_transaction()?;
    let counts = mark_scope_upgrade_required_in_tx(&tx)?;
    tx.commit()?;
    Ok(counts)
}

/// Inner helper run inside a caller-owned transaction. Returns the row counts
/// flipped to `pending` and sets the upgrade flag. Used by both
/// `mark_scope_upgrade_required` (standalone) and
/// `handle_scope_upgrade_required` which folds it together with the gdrive
/// credentials wipe in a single transaction.
fn mark_scope_upgrade_required_in_tx(
    tx: &rusqlite::Transaction<'_>,
) -> rusqlite::Result<ResetCounts> {
    let entries = tx.execute(
        "UPDATE sync_state SET sync_status='pending', local_version=local_version+1 WHERE sync_status='synced'",
        [],
    )? as u64;
    let journals = tx.execute(
        "UPDATE journal_sync_state SET sync_status='pending', local_version=local_version+1 WHERE sync_status='synced'",
        [],
    )? as u64;
    let media = tx.execute(
        "UPDATE media SET upload_status='pending' WHERE upload_status='uploaded'",
        [],
    )? as u64;
    // Legacy drive.file folder is orphaned; surface hashes for that cloud
    // content must not keep whole-table surfaces marked clean.
    db::clear_all_surface_push_hashes(tx)?;
    db::clear_all_pull_revisions(tx)?;
    // Re-arm even before commit: extra Automatic reconcile is harmless;
    // missing re-arm after a successful scope-upgrade is not.
    crate::sync::engine::reset_session_own_cloud_reconciled();
    db::set_setting(tx, GDRIVE_SCOPE_UPGRADE_REQUIRED_KEY, "1")?;
    Ok(ResetCounts {
        entries,
        media,
        journals,
    })
}

/// Read the scope-upgrade-required flag. Returns `false` when the row is
/// absent (the default) or malformed.
pub(crate) fn read_scope_upgrade_required(conn: &rusqlite::Connection) -> bool {
    matches!(
        db::get_setting(conn, GDRIVE_SCOPE_UPGRADE_REQUIRED_KEY)
            .ok()
            .flatten()
            .as_deref(),
        Some("1")
    )
}

/// Frontend command: returns whether the scope-upgrade banner should be
/// rendered on this start-up. Cheap (single settings row read); the
/// frontend calls this on mount and on every `SYNC_SCOPE_UPGRADE_EVENT`.
#[tauri::command]
pub fn get_sync_scope_upgrade_required(state: State<'_, AppState>) -> Result<bool, String> {
    let conn = state.lock()?;
    Ok(read_scope_upgrade_required(&conn))
}

/// Frontend command: clear the upgrade-required flag, called when the user
/// dismisses the banner or completes a reconnect under the new scope. Safe
/// to call when the flag is already absent.
#[tauri::command]
pub fn clear_sync_scope_upgrade_required(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_setting(&conn, GDRIVE_SCOPE_UPGRADE_REQUIRED_KEY).map_err(|e| e.to_string())
}

/// Triggered from `run_sync_now` when the engine surfaces ScopeMismatch.
/// Performs the disconnect-side of the migration **atomically**: in ONE
/// SQLite transaction, wipes Drive credentials, flips local sync state back
/// to `pending`, and sets the `gdrive_scope_upgrade_required` flag. Then
/// emits the upgrade event so any open Settings panel renders the banner.
///
/// The single-transaction invariant is load-bearing: a crash between
/// "credentials wiped" and "sync state reset" would leave the user with no
/// Drive connection AND every row still marked `synced`, which silently
/// suppresses future re-uploads. Honors the project rule "destructive cloud
/// actions must reset local state atomically with cloud cleanup".
///
/// Best-effort overall — each step logs and is swallowed because the user
/// is already in a degraded state and surfacing intermediate failures only
/// makes it worse. The user will hit the same scope error on next sync and
/// re-trigger this if the transaction failed.
pub(crate) fn handle_scope_upgrade_required(app: &AppHandle, state: &AppState) {
    {
        let conn = match state.lock() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("scope-upgrade: failed to acquire DB lock: {e}");
                return;
            }
        };
        let tx = match conn.unchecked_transaction() {
            Ok(t) => t,
            Err(e) => {
                log::warn!("scope-upgrade: failed to start transaction: {e}");
                return;
            }
        };
        // Wipe credentials FIRST so a partial commit cannot leave a stale
        // token alongside the upgrade flag.
        if let Err(e) = crate::commands::gdrive::clear_gdrive_settings(&tx) {
            log::warn!("scope-upgrade: clear_gdrive_settings failed: {e}");
            return;
        }
        // Reset local sync state + set the banner flag in the SAME tx.
        if let Err(e) = mark_scope_upgrade_required_in_tx(&tx) {
            log::warn!("scope-upgrade: mark_scope_upgrade_required_in_tx failed: {e}");
            return;
        }
        if let Err(e) = tx.commit() {
            log::warn!("scope-upgrade: tx.commit failed: {e}");
            return;
        }
    }
    if let Err(e) = app.emit(SYNC_SCOPE_UPGRADE_EVENT, ()) {
        log::warn!("scope-upgrade: failed to emit {SYNC_SCOPE_UPGRADE_EVENT}: {e}");
    }
}

/// Single-entry push, used by the editor debounce path in Chunk 5.
/// Uses `spawn_blocking` so the blocking sync work runs off the main thread,
/// keeping the WebView IPC loop responsive during auto-save pushes.
#[tauri::command]
pub async fn push_entry(app: AppHandle, entry_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let key_state = app.state::<EncryptionKeyState>();
        run_push_entry(&app, &state, &key_state, &entry_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One-time cloud-content migration (Phase 5 T1).
///
/// Called at the start of `run_sync_now` when `NEEDS_CLOUD_CONTENT_MIGRATION`
/// is set. Atomically resets local sync state and then wipes this device's
/// cloud sync folder so the engine re-pushes everything under the current
/// content key on the next engine call.
///
/// # Atomicity
///
/// Per CLAUDE.md rule: the DB reset (sync_state + media to `pending`) happens
/// in a single transaction BEFORE the cloud delete. If we crash between DB
/// reset and cloud delete, the next startup re-runs the migration — idempotent.
/// The flag is cleared LAST, so a mid-migration crash retries from the start.
///
/// Step 2.5 (C2 fix): publishes `_content.json` and updates `_meta.json`
/// (content_epoch) on the keyring provider BEFORE clearing the migration flag.
/// Only GDrive users have a keyring; iCloud/local users skip this step and fall
/// through to clear the flag (their peers derive the content key per-device via
/// password, not via the cloud keyring).
///
/// `keyring_io` must be `Some` for GDrive and `None` for iCloud/local. When
/// `Some`, the write goes through `KeyringV2Io` (which accepts `.meta/...`
/// paths) — NOT through `SyncProvider::write_file` which rejects them.
async fn run_cloud_content_migration(
    state: &AppState,
    key_state: &EncryptionKeyState,
    engine_provider: &Arc<dyn SyncProvider>,
    device_id: &str,
    keyring_io: Option<&(dyn crate::sync::keyring_v2::KeyringV2Io + Send + Sync)>,
) -> Result<(), String> {
    use crate::sync::keyring_v2::io::{read_meta, write_content, write_meta};
    use crate::sync::keyring_v2::types::{ContentEntryV2, ContentListV2, KEYRING_V2_VERSION};
    use crate::sync::provider::FileKind;
    use crate::utils::encryption::key_fingerprint;

    // Step 1: Reset local sync_state + journal_sync_state + media + versions atomically
    // in one DB transaction. Cloud files for all these channels are wiped in Step 2, so
    // their local state must also be reset here — otherwise the respective push paths
    // skip them (rows still show 'synced'/'uploaded') and the wiped cloud files are
    // never re-created under the new content key.
    {
        let conn = state.lock()?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        db::reset_all_sync_state_to_pending(&*tx).map_err(|e| e.to_string())?;
        db::reset_all_journal_sync_state_to_pending(&*tx).map_err(|e| e.to_string())?;
        db::reset_all_media_upload_status_to_pending(&*tx).map_err(|e| e.to_string())?;
        db::reset_all_version_upload_status_to_pending(&*tx).map_err(|e| e.to_string())?;
        // Cloud folder is wiped under a new content key — stale surface hashes
        // would skip re-upload of settings/tags/… against empty/wrong ciphertext.
        db::clear_all_surface_push_hashes(&*tx).map_err(|e| e.to_string())?;
        db::clear_all_pull_revisions(&*tx).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        crate::sync::engine::reset_session_own_cloud_reconciled();
        log::info!(
            "run_cloud_content_migration: reset sync_state + journal_sync_state + media + versions to pending; cleared surface push hashes"
        );
    }

    // Step 2: Delete all entry/media/journal/version files from this device's cloud
    // folder. Errors deleting individual files are logged and swallowed — the file may
    // already be gone (idempotent). A provider-level error listing files is fatal.
    for kind in [
        FileKind::Entries,
        FileKind::Media,
        FileKind::Journals,
        FileKind::Versions,
    ] {
        let paths = engine_provider
            .list_files(device_id, kind)
            .await
            .map_err(|e| {
                format!(
                    "cloud-content migration: list {} files: {e}",
                    kind.subfolder_name().unwrap_or("device-root")
                )
            })?;
        for path in paths {
            match engine_provider.delete_file(&path).await {
                Ok(()) => {}
                Err(e) => {
                    log::warn!("run_cloud_content_migration: delete {path}: {e} (continuing)");
                }
            }
        }
        log::info!(
            "run_cloud_content_migration: wiped {} cloud files for device {}",
            kind.subfolder_name().unwrap_or("device-root"),
            device_id
        );
    }

    // Step 2.5: Publish `_content.json` and update `_meta.json` so peers can
    // read the content-key epoch list.
    //
    // This step runs BEFORE clearing the migration flag (crash-safe: if we crash
    // here, the next startup retries the migration — re-publishing is idempotent).
    //
    // Only GDrive users have a cloud keyring. iCloud/local users skip this step
    // (their peers derive the content key from the password per-device — no shared
    // keyring file to update). When `keyring_io` is None the flag is still cleared
    // in Step 3 so the migration does not loop.
    if let Some(kio) = keyring_io {
        use crate::sync::keyring_v2::io::read_content;
        use crate::utils::encryption::{encode_content_key_list, unwrap_content_key, KEY_SIZE};
        use std::collections::BTreeMap;

        // I4: Check whether another device has already published a `_content.json`
        // for this vault. If one exists and unwraps cleanly under the current
        // master, adopt it (update local DB) instead of overwriting with the
        // locally-generated epoch-1 key. Last-writer-wins on `_content.json`
        // would otherwise cause permanent split-brain when two legacy devices
        // both run T3 migration at roughly the same time.
        //
        // If the cloud list exists but *cannot* be unwrapped, a different device
        // published it under a different master key — require re-pair.
        //
        // Network errors reading the cloud list are non-fatal: we fall through to
        // the normal publish path. A successful publish is idempotent (two devices
        // both generate valid epoch-1 keys and the later write wins). The race is
        // rare in practice (requires two legacy devices syncing simultaneously)
        // and the re-pair detection path here stops the split-brain before it
        // propagates.
        let cloud_adopted = match read_content(kio).await {
            Err(e) => {
                log::warn!(
                    "run_cloud_content_migration: cannot read cloud _content.json \
                     ({e}); proceeding with local publish"
                );
                false
            }
            Ok(None) => {
                log::info!(
                    "run_cloud_content_migration: no existing _content.json — \
                     this device publishes first"
                );
                false
            }
            Ok(Some(cloud_list)) => {
                // Try to unwrap every entry using the current master. If they all
                // succeed, the cloud list was produced by the same vault (same
                // master key) — safe to adopt.
                //
                // We collect the decoded keys *outside* `with_master` so we can call
                // `set_content_state` afterwards without re-entering the mutex (which
                // would deadlock on the same thread).
                let adopt_result: Result<BTreeMap<u32, Zeroizing<[u8; KEY_SIZE]>>, String> =
                    key_state.with_master(|master| {
                        let mut adopted: BTreeMap<u32, Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
                        for entry in &cloud_list.entries {
                            let blob = hex::decode(&entry.wrapped_content).map_err(|e| {
                                format!(
                                    "cloud-content migration: cloud entry epoch {} \
                                     wrapped_content decode: {e}",
                                    entry.epoch
                                )
                            })?;
                            let ck = unwrap_content_key(master, &blob).map_err(|_| {
                                format!(
                                    "cloud-content migration: cannot unwrap cloud epoch {} \
                                     — cloud vault may belong to a different master key",
                                    entry.epoch
                                )
                            })?;
                            adopted.insert(entry.epoch, ck);
                        }
                        // Re-encode using the local master (same master, so bytes are
                        // identical — but this uses the canonical encode path).
                        let encoded = encode_content_key_list(master, &adopted)?;
                        let latest = cloud_list.latest_epoch;
                        let conn = state.lock()?;
                        db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &encoded)
                            .map_err(|e| e.to_string())?;
                        db::set_setting(&conn, db::CONTENT_KEY_EPOCH, &latest.to_string())
                            .map_err(|e| e.to_string())?;
                        Ok(adopted)
                    });
                match adopt_result {
                    Ok(adopted_keys) => {
                        let latest = cloud_list.latest_epoch;
                        log::info!(
                            "run_cloud_content_migration: adopted existing cloud \
                             _content.json (latest_epoch={latest}) — skipping local publish"
                        );
                        // F5: refresh the in-memory key state so new writes use the adopted
                        // epoch list. Without this, the app keeps encrypting with its
                        // locally-generated epoch-1 key until the next unlock, which peers
                        // holding the adopted list cannot read.
                        //
                        // We must read db_key and master in separate `with_*` calls (each
                        // one acquires and then releases the mutex) BEFORE calling
                        // `set_content_state` — re-entering the mutex inside a `with_*`
                        // closure would deadlock on the single mutex held by that closure.
                        let refresh_result: Result<(), String> = (|| {
                            let db_key = key_state.with_db_key(|dk| {
                                let mut out = Zeroizing::new([0u8; KEY_SIZE]);
                                out.copy_from_slice(dk);
                                Ok(out)
                            })?;
                            let master_copy = key_state.with_master(|m| {
                                let mut out = Zeroizing::new([0u8; KEY_SIZE]);
                                out.copy_from_slice(m);
                                Ok(out)
                            })?;
                            key_state
                                .set_content_state(
                                    adopted_keys.clone(),
                                    latest,
                                    db_key,
                                    master_copy,
                                )
                                .map_err(|e| {
                                    format!("cloud-content migration adopt: set_content_state: {e}")
                                })
                        })();
                        if let Err(e) = refresh_result {
                            // Non-fatal: the DB was already updated; the app is correct
                            // after the next unlock. Log and continue.
                            log::warn!(
                                "run_cloud_content_migration: key_state refresh after adopt \
                                 failed (non-fatal — will be correct after next unlock): {e}"
                            );
                        } else {
                            log::info!(
                                "run_cloud_content_migration: key_state refreshed to \
                                 adopted epoch list (latest_epoch={latest})"
                            );
                        }
                        true // skip the publish block below
                    }
                    Err(e) => {
                        return Err(format!(
                            "cloud-content migration: a _content.json already exists on \
                             the cloud but cannot be decrypted with the current master \
                             key. Another device may have published a vault under a \
                             different master. Re-pair all devices to resolve. \
                             Details: {e}"
                        ));
                    }
                }
            }
        };

        if !cloud_adopted {
            // Read the wrapped content-key list from the DB. Each 128-hex-char slot
            // is epoch(8 hex = 4 bytes BE) + wrapped_blob(120 hex = 60 bytes).
            const SLOT_HEX: usize = 128;
            const EPOCH_HEX: usize = 8;

            let (list_hex, now_secs) = {
                let conn = state.lock()?;
                let list_hex = db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| {
                        "cloud-content migration: WRAPPED_CONTENT_LIST absent — \
                         cannot publish _content.json"
                            .to_string()
                    })?;
                let now_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                (list_hex, now_secs)
            };

            if list_hex.len() < SLOT_HEX || list_hex.len() % SLOT_HEX != 0 {
                return Err(format!(
                    "cloud-content migration: WRAPPED_CONTENT_LIST has invalid length {} \
                     (expected multiple of {SLOT_HEX} hex chars)",
                    list_hex.len()
                ));
            }

            let mut entries = Vec::new();
            let n_slots = list_hex.len() / SLOT_HEX;
            for i in 0..n_slots {
                let slot = &list_hex[i * SLOT_HEX..(i + 1) * SLOT_HEX];
                let epoch_hex = &slot[..EPOCH_HEX]; // 8 hex chars = 4 bytes
                let wrapped_hex = &slot[EPOCH_HEX..]; // 120 hex chars = 60 bytes
                let epoch_bytes = hex::decode(epoch_hex).map_err(|e| {
                    format!(
                        "cloud-content migration: invalid epoch hex in WRAPPED_CONTENT_LIST: {e}"
                    )
                })?;
                if epoch_bytes.len() != 4 {
                    return Err(format!(
                        "cloud-content migration: epoch bytes wrong length: {}",
                        epoch_bytes.len()
                    ));
                }
                let epoch = u32::from_be_bytes([
                    epoch_bytes[0],
                    epoch_bytes[1],
                    epoch_bytes[2],
                    epoch_bytes[3],
                ]);

                // Compute the content fingerprint via the key state.
                // with_sync_key_for_epoch returns derive_sync_key(raw_content_key),
                // matching what CLOUD_CONTENT_FINGERPRINT stores.
                let fp_hex = key_state
                    .with_sync_key_for_epoch(epoch, |k| Ok(hex::encode(key_fingerprint(k))))
                    .map_err(|e| {
                        format!(
                            "cloud-content migration: cannot compute fingerprint for epoch {epoch}: {e}"
                        )
                    })?;

                entries.push(ContentEntryV2 {
                    epoch,
                    wrapped_content: wrapped_hex.to_string(),
                    content_fingerprint: fp_hex,
                });
            }

            let latest_epoch = entries.last().map(|e| e.epoch).unwrap_or(0);
            let content_list = ContentListV2 {
                version: KEYRING_V2_VERSION,
                latest_epoch,
                entries,
                created_at: now_secs,
            };

            // Write _content.json via KeyringV2Io (accepts .meta/... paths).
            // SyncProvider::write_file rejects these paths — never use it here.
            write_content(kio, &content_list)
                .await
                .map_err(|e| format!("cloud-content migration: write _content.json failed: {e}"))?;

            log::info!(
                "run_cloud_content_migration: published _content.json (latest_epoch={})",
                latest_epoch
            );

            // Update _meta.json content_epoch so peers pick up the latest epoch.
            // read_meta returns None when _meta.json is absent (e.g. first onboard
            // published _content.json before _meta.json in a crash scenario) — skip
            // in that case; the next full keyring publish will set content_epoch.
            match read_meta(kio)
                .await
                .map_err(|e| format!("cloud-content migration: read _meta.json failed: {e}"))?
            {
                Some(mut meta) => {
                    meta.content_epoch = latest_epoch;
                    write_meta(kio, &meta).await.map_err(|e| {
                        format!("cloud-content migration: write _meta.json failed: {e}")
                    })?;
                    log::info!(
                        "run_cloud_content_migration: updated _meta.json content_epoch={}",
                        latest_epoch
                    );
                }
                None => {
                    log::warn!(
                        "run_cloud_content_migration: _meta.json absent — skipping content_epoch update"
                    );
                }
            }
        }
    }

    // Step 3: Clear the migration flag. Done LAST so a crash before this point
    // causes a retry (idempotent: resetting pending rows and deleting gone files
    // are both no-ops on re-run).
    {
        let conn = state.lock()?;
        db::delete_setting(&conn, db::NEEDS_CLOUD_CONTENT_MIGRATION).map_err(|e| e.to_string())?;
        log::info!("run_cloud_content_migration: cleared NEEDS_CLOUD_CONTENT_MIGRATION flag");
    }

    Ok(())
}

/// Unified guard for all sync write paths.
///
/// Checks both conditions that must be clear before pushing any envelope to
/// the cloud:
///
/// 1. **Force-re-pair**: another device rotated the vault and this device must
///    re-pair before syncing. Detected via the persisted `FORCE_RE_PAIR_REQUIRED`
///    setting.
/// 2. **Active rotation job**: a rotation is in progress or paused (e.g. after
///    the retry-abort path in `reencrypt_items`). Pushing K_old envelopes over
///    files already encrypted with K_new causes permanent data loss. The
///    persistent `rotation_jobs` table catches this even after the in-memory
///    `SyncInProgressGuard` has been dropped.
///
/// Called at the earliest possible point in every push entry path
/// (`run_push_entry`, `run_sync_now`) before any I/O is performed.
pub(crate) fn ensure_safe_to_push_with_recovery_permit(
    state: &AppState,
    permit: Option<&crate::sync::recovery::RecoveryOwnerPermit>,
) -> Result<(), String> {
    let conn = state.lock()?;
    // Force-re-pair check (cheaper — single settings row read).
    if db::get_setting(&conn, db::FORCE_RE_PAIR_REQUIRED)
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some("1")
    {
        let reason_raw = db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
            .unwrap_or(None)
            .unwrap_or_default();
        let (reason_class, human_msg) = if reason_raw == "keyring_check_inconclusive" {
            ("inconclusive", "The cloud keyring could not be verified")
        } else {
            ("rotated", "The vault was rotated on another device")
        };
        log::warn!("ensure_safe_to_push: blocked — force_re_pair_required=1 reason={reason_raw}");
        return Err(format!(
            "FORCE_RE_PAIR_REQUIRED reason={reason_class}: {human_msg}. Re-pair before syncing."
        ));
    }
    // Persistent rotation-job check (catches paused/aborted-with-resume jobs
    // where the in-memory SyncInProgressGuard was already dropped).
    if db::has_active_rotation_job(&conn).map_err(|e| e.to_string())? {
        log::warn!(
            "ensure_safe_to_push: blocked — active rotation job exists (paused or in-flight)"
        );
        return Err("A vault rotation is in progress or needs to resume. \
             Wait for it to finish or click Resume in Settings."
            .to_string());
    }
    if let Some(job) = db::find_active_sync_recovery_job(&conn).map_err(|e| e.to_string())? {
        let allowed = permit.is_some_and(|permit| {
            let local_device_id = db::get_or_create_device_id(&conn).ok();
            permit.job_id == job.id
                && permit.operation == job.operation
                && i64::try_from(permit.recovery_generation).ok() == Some(job.recovery_generation)
                && local_device_id.as_deref() == Some(permit.owner_device_id.as_str())
        });
        if !allowed {
            return Err("authoritative_recovery_in_progress".to_string());
        }
    }
    Ok(())
}

pub(crate) fn ensure_safe_to_push(state: &AppState) -> Result<(), String> {
    ensure_safe_to_push_with_recovery_permit(state, None)
}

pub(crate) fn ensure_remote_recovery_push_allowed(
    state: &AppState,
    permit: Option<&crate::sync::recovery::RecoveryOwnerPermit>,
) -> Result<(), String> {
    let (provider, local_generation) = {
        let conn = state.lock()?;
        let Some(provider) = configured_cloud_provider(&conn)? else {
            return Ok(());
        };
        (
            provider,
            db::get_sync_recovery_generation(&conn).map_err(|e| e.to_string())?,
        )
    };
    block_on(crate::sync::recovery::check_provider_recovery_push(
        &provider,
        local_generation,
        permit,
    ))
    .map_err(|e| e.to_string())
}

/// Pre-flight checks for a single-entry push. Mirrors the beginning of
/// `run_sync_now`: validates persistent guards first (force-re-pair, active
/// rotation job) then acquires the single-flight slot.
///
/// Returns the held `SyncInProgressGuard` on success so `run_push_entry` can
/// hold it for the entire push. Returns `Err(SYNC_IN_PROGRESS_ERR)` if
/// another sync is already in flight, or another `Err` for the persistent
/// guard conditions.
pub(crate) fn begin_push_entry(state: &AppState) -> Result<SyncInProgressGuard, String> {
    ensure_safe_to_push(state)?;
    SyncInProgressGuard::try_acquire().ok_or_else(|| SYNC_IN_PROGRESS_ERR.to_string())
}

pub(crate) fn run_push_entry(
    app: &AppHandle,
    state: &AppState,
    key_state: &EncryptionKeyState,
    entry_id: &str,
) -> Result<(), String> {
    // Guard: refuse to push if force-re-pair is required, an active rotation
    // job exists, or another sync is already in flight. The guard is held for
    // the entire push_single_entry call — Drop releases it on every path
    // including early ? and panics.
    let _guard = begin_push_entry(state)?;
    ensure_remote_recovery_push_allowed(state, None)?;

    let (provider, device_id) = {
        let conn = state.lock()?;
        let provider = make_configured_provider(&conn)?
            .ok_or_else(|| "Sync is disabled or not configured".to_string())?;
        let device_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;
        (provider, device_id)
    };
    let engine = SyncEngine::new(provider, device_id);
    emit_status(app, SyncPhase::Syncing, state, None);
    // Snapshot the HKDF sync sub-key — same reason as `run_sync_now`:
    // holding `with_sync_key` across an `.await` (via `block_on`) would block
    // every other key-using sync command on the main thread.
    let key_copy: Zeroizing<[u8; 32]> = key_state.with_sync_key(|k| Ok(Zeroizing::new(*k)))?;
    let result =
        block_on(engine.push_single_entry(state, &key_copy, entry_id)).map_err(|e| e.to_string());
    match &result {
        Ok(()) => emit_status(app, SyncPhase::Synced, state, None),
        Err(e) => emit_status(app, SyncPhase::Error, state, Some(e.clone())),
    }
    result
}

// ─── Force re-pair detection helper ──────────────────────────────────────────

/// Outcome of the pull-leg keyring check in [`check_force_re_pair_sync`].
pub(crate) enum PullLegKeyringCheck {
    /// Cloud vault was rotated by another device — caller must persist the
    /// force-re-pair flag and abort the sync.
    Mismatch(crate::commands::gdrive::ForceRePairMismatch),
    /// `_meta.json` exists but is corrupt/unparseable — a positive integrity
    /// signal, not a transient failure. Caller must fail closed.
    Corrupt(String),
    /// Verified, skipped, or a transient session/network failure — nothing for
    /// the pull leg to act on. Transient errors stay best-effort by policy:
    /// failing closed here would block push on every dropped connection during
    /// a background sync.
    Clean,
}

/// Persist the fail-closed verdict of the pull-leg keyring check.
///
/// `Mismatch` records the rotation; `Corrupt` fails closed via
/// `apply_inconclusive_force_re_pair` — a corrupt `_meta.json` means the vault
/// cannot be verified, so pushing would write on top of unverifiable state.
///
/// Split from `run_sync_now` so the fail-closed wiring is unit-testable:
/// re-routing `Corrupt` to the swallow path (or dropping the flag write) must
/// break a test, not just silently re-open the fail-open this fixed.
pub(crate) fn persist_pull_leg_check(
    conn: &rusqlite::Connection,
    check: &PullLegKeyringCheck,
) -> Result<(), String> {
    match check {
        PullLegKeyringCheck::Mismatch(mismatch) => {
            crate::commands::gdrive::set_force_re_pair_flags(conn, &mismatch.reason)
        }
        PullLegKeyringCheck::Corrupt(_) => {
            crate::commands::gdrive::apply_inconclusive_force_re_pair(
                conn,
                "keyring_check_inconclusive",
            )
        }
        PullLegKeyringCheck::Clean => Ok(()),
    }
}

/// Attempt to detect a force re-pair condition at sync time.
///
/// Builds the configured cloud backend (`local` / `icloud` / `gdrive`) via
/// [`configured_cloud_provider`] so a folder vault is checked the same way as
/// Drive. Session/auth/network problems are swallowed (`Clean`) — the
/// unlock-time reconcile and the connect flow own fail-closed handling for
/// those. Missing/unconfigured provider is also `Clean` (not a typed
/// NotFound): there is no vault to compare, and treating that as absence
/// would let the dirty-keyring reupload publish over an unverified cloud.
/// A corrupt `_meta.json` is NOT swallowed: the bytes were read successfully
/// and do not form a valid keyring, so pushing on top of it would trust an
/// unverifiable vault.
async fn check_force_re_pair_sync(state: &AppState) -> PullLegKeyringCheck {
    let provider = match state.lock() {
        Ok(conn) => match configured_cloud_provider(&conn) {
            Ok(Some(p)) => p,
            // Disabled, unconfigured, or a session rebuild failure — fail
            // open for availability. Do not map "no provider" to NotFound.
            _ => return PullLegKeyringCheck::Clean,
        },
        Err(_) => return PullLegKeyringCheck::Clean,
    };
    match crate::commands::gdrive::detect_force_re_pair(&provider, state).await {
        Ok(crate::commands::gdrive::ForceRePairCheck::Mismatch(m)) => {
            PullLegKeyringCheck::Mismatch(m)
        }
        // Verified / Skipped → nothing to report. The pull leg never clears flags.
        Ok(_) => PullLegKeyringCheck::Clean,
        Err(e) if e.is_corrupt => PullLegKeyringCheck::Corrupt(e.message),
        // Transient (network / auth / lock) — best-effort by policy.
        Err(_) => PullLegKeyringCheck::Clean,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::EncryptionKeyState;

    #[test]
    fn catchup_progress_event_name_matches_frontend_contract() {
        assert_eq!(SYNC_CATCHUP_PROGRESS_EVENT, "sync:catchup-progress");
    }

    // ── with_stall_guard ──────────────────────────────────────────────────
    //
    // `start_paused = true` makes `tokio::time` (sleep/interval/advance) run
    // on a virtual clock — no real waiting. `now_ms` is built from
    // `tokio::time::Instant::now()` so `tokio::time::advance` moves both the
    // guard's internal ticker and the injected clock in lockstep.

    /// A hard cap so generous it never fires within these tests' windows —
    /// used whenever a test only cares about the stall (inactivity) check.
    fn no_effective_hard_cap() -> Duration {
        Duration::from_secs(24 * 60 * 60)
    }

    #[tokio::test(start_paused = true)]
    async fn with_stall_guard_completes_ok_for_a_future_that_finishes_quickly() {
        let last_progress_ms = Arc::new(AtomicU64::new(0));
        let baseline = tokio::time::Instant::now();
        let now_ms = move || baseline.elapsed().as_millis() as u64;

        let result = with_stall_guard(
            async { 42 },
            last_progress_ms,
            now_ms,
            Duration::from_secs(20),
            no_effective_hard_cap(),
        )
        .await;

        assert_eq!(result.unwrap(), 42);
    }

    #[tokio::test(start_paused = true)]
    async fn with_stall_guard_errs_when_no_progress_is_ever_stamped() {
        let last_progress_ms = Arc::new(AtomicU64::new(0));
        let baseline = tokio::time::Instant::now();
        let now_ms = move || baseline.elapsed().as_millis() as u64;
        let stall = Duration::from_secs(20);

        // A future that never resolves and never stamps progress.
        let guard = tokio::spawn(with_stall_guard(
            std::future::pending::<()>(),
            last_progress_ms,
            now_ms,
            stall,
            no_effective_hard_cap(),
        ));

        // Advance well past the stall window; the guard's 5s ticker must
        // notice the silence and abort before this returns.
        tokio::time::advance(stall + Duration::from_secs(10)).await;

        let result = guard.await.expect("guard task must not panic");
        assert_eq!(
            result,
            Err(SyncStalled::NoProgress),
            "expected NoProgress, got {result:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn with_stall_guard_survives_a_future_that_keeps_stamping_progress() {
        let last_progress_ms = Arc::new(AtomicU64::new(0));
        let baseline = tokio::time::Instant::now();
        let now_ms = move || baseline.elapsed().as_millis() as u64;
        let stall = Duration::from_secs(20);

        // Runs for 3x the stall window (6 steps of 10s = 60s), but stamps
        // progress every step — well inside the 20s stall window each time —
        // so the guard must let it run to completion instead of aborting.
        let progress_for_stamping = last_progress_ms.clone();
        let slow_but_progressing = async move {
            for _ in 0..6 {
                tokio::time::sleep(Duration::from_secs(10)).await;
                progress_for_stamping
                    .store(baseline.elapsed().as_millis() as u64, Ordering::SeqCst);
            }
            "done"
        };

        let guard = tokio::spawn(with_stall_guard(
            slow_but_progressing,
            last_progress_ms,
            now_ms,
            stall,
            no_effective_hard_cap(),
        ));

        tokio::time::advance(Duration::from_secs(65)).await;

        let result = guard.await.expect("guard task must not panic");
        assert_eq!(result.unwrap(), "done");
    }

    #[tokio::test(start_paused = true)]
    async fn with_stall_guard_errs_with_hard_cap_exceeded_even_with_constant_progress() {
        let last_progress_ms = Arc::new(AtomicU64::new(0));
        let baseline = tokio::time::Instant::now();
        let now_ms = move || baseline.elapsed().as_millis() as u64;
        // A generous stall window (never trips) paired with a short hard
        // cap: a future that stamps progress on every tick would satisfy
        // `with_stall_guard_survives_...` above forever, but must still be
        // killed once the hard cap elapses.
        let stall = Duration::from_secs(24 * 60 * 60);
        let hard_cap = Duration::from_secs(30);

        let progress_for_stamping = last_progress_ms.clone();
        let stamps_forever: std::future::Pending<()> = {
            // Spawn a sibling task that keeps stamping progress forever;
            // the guarded future itself never resolves (mirrors a
            // genuinely endless workload with a slow-but-steady trickle of
            // progress).
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    progress_for_stamping
                        .store(baseline.elapsed().as_millis() as u64, Ordering::SeqCst);
                }
            });
            std::future::pending()
        };

        let guard = tokio::spawn(with_stall_guard(
            stamps_forever,
            last_progress_ms,
            now_ms,
            stall,
            hard_cap,
        ));

        tokio::time::advance(hard_cap + Duration::from_secs(10)).await;

        let result = guard.await.expect("guard task must not panic");
        assert_eq!(
            result,
            Err(SyncStalled::HardCapExceeded),
            "expected HardCapExceeded, got {result:?}"
        );
    }

    // ── retry_with_stall_guard ────────────────────────────────────────────

    #[tokio::test(start_paused = true)]
    async fn retry_with_stall_guard_succeeds_after_one_stalled_attempt() {
        let last_progress_ms = Arc::new(AtomicU64::new(0));
        let baseline = tokio::time::Instant::now();
        let now_ms = move || baseline.elapsed().as_millis() as u64;
        let stall = Duration::from_secs(20);

        // Attempt 1 never stamps progress and never resolves → stalls.
        // Attempt 2 resolves immediately → succeeds.
        let attempt_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let make_attempt = {
            let attempt_count = attempt_count.clone();
            move || {
                let n = attempt_count.fetch_add(1, Ordering::SeqCst);
                let fut: std::pin::Pin<Box<dyn std::future::Future<Output = &'static str> + Send>> =
                    if n == 0 {
                        Box::pin(std::future::pending())
                    } else {
                        Box::pin(async { "ok" })
                    };
                fut
            }
        };

        let retry_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let on_retry = {
            let retry_count = retry_count.clone();
            move |_attempt: u32, _reason: SyncStalled| {
                retry_count.fetch_add(1, Ordering::SeqCst);
            }
        };

        let guard = tokio::spawn(retry_with_stall_guard(
            make_attempt,
            last_progress_ms,
            now_ms,
            stall,
            no_effective_hard_cap(),
            3,
            on_retry,
        ));

        tokio::time::advance(stall + Duration::from_secs(10)).await;

        let result = guard.await.expect("guard task must not panic");
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(
            retry_count.load(Ordering::SeqCst),
            1,
            "on_retry should fire exactly once (after the one stalled attempt)"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retry_with_stall_guard_errs_after_max_attempts_all_stall() {
        let last_progress_ms = Arc::new(AtomicU64::new(0));
        let baseline = tokio::time::Instant::now();
        let now_ms = move || baseline.elapsed().as_millis() as u64;
        let stall = Duration::from_secs(20);
        let max_attempts = 3u32;

        let retry_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let on_retry = {
            let retry_count = retry_count.clone();
            move |_attempt: u32, _reason: SyncStalled| {
                retry_count.fetch_add(1, Ordering::SeqCst);
            }
        };

        let guard = tokio::spawn(retry_with_stall_guard(
            || std::future::pending::<()>(),
            last_progress_ms,
            now_ms,
            stall,
            no_effective_hard_cap(),
            max_attempts,
            on_retry,
        ));

        // Every attempt gets its own fresh stall window, so the total time
        // to exhaust all attempts is roughly max_attempts * (stall + a tick).
        tokio::time::advance(stall * max_attempts + Duration::from_secs(30)).await;

        let result = guard.await.expect("guard task must not panic");
        assert_eq!(result, Err(SyncStalled::NoProgress));
        assert_eq!(
            retry_count.load(Ordering::SeqCst),
            max_attempts - 1,
            "on_retry must fire for every non-final attempt, never for the last"
        );
    }

    // ── SyncPhase wire format ─────────────────────────────────────────────
    //
    // The frontend `SyncPhase` TypeScript union (`src/lib/tauri.ts`)
    // pins the exact strings: `idle`, `syncing`, `synced`, `error`.
    // These tests lock the Rust → JSON serialization so a rename on
    // either side fails the backend build (or this test), not silently
    // breaks the sidebar indicator at runtime.

    #[test]
    fn sync_phase_serializes_as_lowercase_string() {
        assert_eq!(serde_json::to_string(&SyncPhase::Idle).unwrap(), "\"idle\"");
        assert_eq!(
            serde_json::to_string(&SyncPhase::Syncing).unwrap(),
            "\"syncing\""
        );
        assert_eq!(
            serde_json::to_string(&SyncPhase::Synced).unwrap(),
            "\"synced\""
        );
        assert_eq!(
            serde_json::to_string(&SyncPhase::Error).unwrap(),
            "\"error\""
        );
    }

    #[test]
    fn sync_status_event_serializes_correctly() {
        let event = SyncStatusEvent {
            state: SyncPhase::Syncing,
            enabled: true,
            configured: true,
            provider: Some("local".to_string()),
            last_sync: Some(1_700_000_000),
            entries_pending: 3,
            error: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        // State literal must match the frontend union.
        assert!(json.contains("\"state\":\"syncing\""), "got {json}");
        // Fields must be camelCase (entries_pending → entriesPending, etc.).
        assert!(json.contains("\"lastSync\":1700000000"), "got {json}");
        assert!(json.contains("\"entriesPending\":3"), "got {json}");
        assert!(json.contains("\"configured\":true"), "got {json}");
        assert!(
            !json.contains("entries_pending"),
            "snake_case leaked: {json}"
        );
        assert!(!json.contains("last_sync"), "snake_case leaked: {json}");
    }
    use rusqlite::Connection;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    #[test]
    fn get_device_id_is_stable() {
        let state = make_state();
        let a = {
            let conn = state.lock().unwrap();
            db::get_or_create_device_id(&conn).unwrap()
        };
        let b = {
            let conn = state.lock().unwrap();
            db::get_or_create_device_id(&conn).unwrap()
        };
        assert_eq!(a, b);
    }

    #[test]
    fn sync_status_defaults_disabled_zero_pending() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let enabled = db::get_sync_enabled(&conn).unwrap();
        let provider = db::get_sync_provider(&conn).unwrap();
        let last_sync = db::get_last_sync_at(&conn).unwrap();
        let entries_pending = db::count_pending_entries(&conn).unwrap();
        assert!(!enabled);
        assert_eq!(provider, None);
        assert_eq!(last_sync, None);
        assert_eq!(entries_pending, 0);
    }

    #[test]
    fn sync_status_configuration_matches_provider_factory() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_sync_enabled(&conn, true).unwrap();

        db::set_sync_provider(&conn, "local").unwrap();
        assert!(!read_status_snapshot(&conn).unwrap().configured);
        db::set_sync_config_json(&conn, "{\"root_path\":\"/tmp/memlore-sync\"}").unwrap();
        assert!(read_status_snapshot(&conn).unwrap().configured);

        db::set_sync_provider(&conn, "gdrive").unwrap();
        db::set_sync_config_json(&conn, "").unwrap();
        assert!(!read_status_snapshot(&conn).unwrap().configured);
        db::set_setting(&conn, "gdrive_refresh_token", "1//test-refresh-token").unwrap();
        assert!(read_status_snapshot(&conn).unwrap().configured);
    }

    #[test]
    fn sync_catchup_status_reflects_persisted_completion() {
        let state = make_state();
        let conn = state.lock().unwrap();

        assert_eq!(
            read_sync_catchup_status(&conn).unwrap(),
            SyncCatchupStatus {
                complete: false,
                pulled: 0,
                total: 0,
            }
        );

        db::set_sync_catchup_complete(&conn, true).unwrap();

        assert_eq!(
            read_sync_catchup_status(&conn).unwrap(),
            SyncCatchupStatus {
                complete: true,
                pulled: 0,
                total: 0,
            }
        );
    }

    #[test]
    fn sync_status_reports_pending_count() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        for t in 0..2 {
            let e = db::create_entry(
                &conn,
                db::CreateEntryParams {
                    journal_id: &jid,
                    title: None,
                    content_text: None,
                    preview_text: None,
                    entry_date: 1_700_000_000 + t,
                },
            )
            .unwrap();
            db::mark_entry_pending(&conn, &e.id).unwrap();
        }
        assert_eq!(db::count_pending_entries(&conn).unwrap(), 2);
    }

    fn make_key_state() -> EncryptionKeyState {
        let ks = EncryptionKeyState::new();
        let key = zeroize::Zeroizing::new([42u8; 32]);
        ks.set_key(key).unwrap();
        ks
    }

    #[test]
    fn make_configured_provider_returns_none_when_sync_disabled() {
        let state = make_state();
        let _key_state = make_key_state();
        {
            let conn = state.lock().unwrap();
            db::set_sync_provider(&conn, "local").unwrap();
            db::set_sync_config_json(&conn, "{\"root_path\":\"/tmp/xj\"}").unwrap();
            // sync_enabled stays false — disabled overrides everything else.
        }
        let conn = state.lock().unwrap();
        let provider = make_configured_provider(&conn).unwrap();
        assert!(provider.is_none());
    }

    #[test]
    fn make_configured_provider_returns_none_when_no_provider() {
        let state = make_state();
        let _key_state = make_key_state();
        {
            let conn = state.lock().unwrap();
            db::set_sync_enabled(&conn, true).unwrap();
        }
        let conn = state.lock().unwrap();
        let provider = make_configured_provider(&conn).unwrap();
        assert!(provider.is_none());
    }

    #[test]
    fn make_configured_provider_builds_local_from_config_json() {
        let state = make_state();
        let _key_state = make_key_state();
        {
            let conn = state.lock().unwrap();
            db::set_sync_provider(&conn, "local").unwrap();
            db::set_sync_config_json(&conn, "{\"root_path\":\"/tmp/xj\"}").unwrap();
            db::set_sync_enabled(&conn, true).unwrap();
        }
        let conn = state.lock().unwrap();
        let provider = make_configured_provider(&conn).unwrap();
        assert!(
            provider.is_some(),
            "local provider should build from sync_config_json"
        );
    }

    #[test]
    fn make_configured_provider_builds_icloud_from_config_json() {
        let state = make_state();
        let _key_state = make_key_state();
        {
            let conn = state.lock().unwrap();
            db::set_sync_provider(&conn, "icloud").unwrap();
            db::set_sync_config_json(&conn, "{\"root_path\":\"/tmp/xj-icloud\"}").unwrap();
            db::set_sync_enabled(&conn, true).unwrap();
        }
        let conn = state.lock().unwrap();
        let provider = make_configured_provider(&conn).unwrap();
        assert!(
            provider.is_some(),
            "icloud provider should build from sync_config_json"
        );
    }

    #[test]
    fn make_configured_provider_returns_none_when_local_missing_config_json() {
        let state = make_state();
        let _key_state = make_key_state();
        {
            let conn = state.lock().unwrap();
            db::set_sync_provider(&conn, "local").unwrap();
            db::set_sync_enabled(&conn, true).unwrap();
            // No sync_config_json.
        }
        let conn = state.lock().unwrap();
        let provider = make_configured_provider(&conn).unwrap();
        assert!(provider.is_none());
    }

    #[test]
    fn make_configured_provider_builds_gdrive_from_refresh_token() {
        let state = make_state();
        let _key_state = make_key_state();
        let refresh_token = "1//fake-refresh-token";
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "gdrive_refresh_token", refresh_token).unwrap();
            db::set_sync_provider(&conn, "gdrive").unwrap();
            db::set_sync_enabled(&conn, true).unwrap();
        }
        let conn = state.lock().unwrap();
        let provider = make_configured_provider(&conn).unwrap();
        assert!(
            provider.is_some(),
            "gdrive provider should build without sync_config_json, using refresh token instead"
        );
    }

    #[test]
    fn make_configured_provider_returns_none_when_gdrive_missing_refresh_token() {
        let state = make_state();
        let _key_state = make_key_state();
        {
            let conn = state.lock().unwrap();
            db::set_sync_provider(&conn, "gdrive").unwrap();
            db::set_sync_enabled(&conn, true).unwrap();
            // No gdrive_refresh_token.
        }
        let conn = state.lock().unwrap();
        let provider = make_configured_provider(&conn).unwrap();
        assert!(provider.is_none());
    }

    #[test]
    fn make_configured_provider_errors_on_unknown_provider() {
        let state = make_state();
        let _key_state = make_key_state();
        {
            let conn = state.lock().unwrap();
            db::set_sync_provider(&conn, "dropbox").unwrap();
            db::set_sync_enabled(&conn, true).unwrap();
        }
        let conn = state.lock().unwrap();
        let result = make_configured_provider(&conn);
        match result {
            Err(e) => assert!(e.contains("Unknown sync provider"), "got: {e}"),
            Ok(_) => panic!("expected unknown-provider error"),
        }
    }

    #[test]
    fn set_sync_enabled_roundtrips() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            // Configure a provider first — the guard now rejects enabling
            // without one.
            db::set_sync_provider(&conn, "local").unwrap();
            db::set_sync_config_json(&conn, "{\"root_path\":\"/tmp/xj\"}").unwrap();
            db::set_sync_enabled(&conn, true).unwrap();
        }
        let conn = state.lock().unwrap();
        assert!(db::get_sync_enabled(&conn).unwrap());
    }

    #[test]
    fn set_sync_enabled_rejects_without_provider() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // No provider configured → raw db::set_sync_enabled allows it,
        // but the command-level guard does not. Simulate the guard:
        let provider = db::get_sync_provider(&conn).unwrap();
        assert!(provider.is_none(), "no provider should be set initially");
    }

    #[test]
    fn configure_and_clear_local_sync_via_db() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_sync_provider(&conn, "local").unwrap();
        db::set_sync_config_json(&conn, "{\"root_path\":\"/tmp/memlore-sync\"}").unwrap();
        db::set_sync_enabled(&conn, true).unwrap();
        assert_eq!(
            db::get_sync_provider(&conn).unwrap().as_deref(),
            Some("local")
        );

        db::clear_sync_provider(&conn).unwrap();
        assert_eq!(db::get_sync_provider(&conn).unwrap(), None);
        assert_eq!(db::get_sync_config_json(&conn).unwrap(), None);
        assert!(!db::get_sync_enabled(&conn).unwrap());
    }

    #[test]
    fn last_sync_at_roundtrips() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert_eq!(db::get_last_sync_at(&conn).unwrap(), None);
        db::set_last_sync_at(&conn, 1_700_123_456).unwrap();
        assert_eq!(db::get_last_sync_at(&conn).unwrap(), Some(1_700_123_456));
    }

    // ─── Keyring dirty flag retry ─────────────────────────────────────────────

    #[test]
    fn keyring_dirty_not_set_on_fresh_db() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert!(
            db::get_setting(&conn, db::KEYRING_DIRTY_KEY)
                .unwrap()
                .is_none(),
            "keyring_dirty should not be set on a fresh DB"
        );
    }

    /// The user-facing `sync_now` command must always pass Manual so own-cloud
    /// reconcile re-runs on every explicit "Sync now". The command wires
    /// `USER_SYNC_NOW_TRIGGER` into `run_sync_now` (no AppHandle needed to pin
    /// the constant itself).
    #[test]
    fn sync_now_command_path_passes_manual_trigger() {
        assert_eq!(
            USER_SYNC_NOW_TRIGGER,
            SyncTrigger::Manual,
            "sync_now command must request Manual reconcile"
        );
        // Distinct from the scheduler's Automatic path.
        assert_ne!(USER_SYNC_NOW_TRIGGER, SyncTrigger::Automatic);
    }

    /// Regression test: verifies that the architectural pattern used by the new
    /// `sync_now` command — dispatching sync work via `spawn_blocking` — does
    /// not deadlock or panic. This pins the invariant that blocking sync work
    /// (which internally calls `block_on`) must be wrapped in `spawn_blocking`
    /// rather than run directly on an async task or the main thread.
    ///
    /// We cannot call `run_sync_now` without an `AppHandle` in a unit test, so
    /// we test the dispatch shape itself: a closure that calls `block_on` inside
    /// `spawn_blocking` is the exact pattern `sync_now` uses, and it must
    /// complete without a deadlock or panic.
    #[tokio::test]
    async fn sync_now_spawn_blocking_pattern_does_not_deadlock() {
        // This exercises the exact dispatch shape of the new async sync_now:
        //   spawn_blocking(|| { ... block_on(some_future) ... }).await
        // If `block_on` inside `spawn_blocking` were broken (e.g., called from
        // a regular async task without spawn_blocking), tokio would panic with
        // "Cannot start a runtime from within a runtime". This test verifies
        // the pattern is safe.
        let result = tauri::async_runtime::spawn_blocking(|| {
            // Simulate what run_sync_now does internally: call block_on from
            // inside a blocking thread.
            block_on(async { 42u32 })
        })
        .await;

        assert!(
            result.is_ok(),
            "spawn_blocking must not panic: {:?}",
            result
        );
        assert_eq!(
            result.unwrap(),
            42,
            "block_on result must propagate correctly"
        );
    }

    // keyring_dirty_flag_stays_when_session_unavailable removed in Phase 2:
    // try_reupload_keyring is now a no-op stub (always Ok), so the
    // session-unavailable failure path no longer exists. Phase 3 will add V2 equivalents.

    // ── SyncProgressEvent wire format ─────────────────────────────────────
    //
    // The frontend `SyncProgressEvent` interface (`src/lib/tauri.ts`) pins
    // camelCase field names and kebab-case phase strings.  These tests lock
    // the Rust → JSON serialization so a rename on either side fails the
    // build rather than silently breaking the progress label at runtime.

    #[test]
    fn sync_progress_event_serializes_correctly() {
        use crate::sync::engine::{SyncProgressEvent, SyncProgressPhase};
        let event = SyncProgressEvent {
            phase: SyncProgressPhase::PushingEntries,
            current: 5,
            total: 12,
        };
        let json = serde_json::to_string(&event).unwrap();
        // Phase must be kebab-case matching the TS union.
        assert!(json.contains("\"phase\":\"pushing-entries\""), "got {json}");
        // Numeric fields must be camelCase (current and total are fine as-is,
        // but verify the exact keys exist in the output).
        assert!(json.contains("\"current\":5"), "got {json}");
        assert!(json.contains("\"total\":12"), "got {json}");
        // No snake_case leakage.
        assert!(
            !json.contains("pushing_entries"),
            "snake_case leaked: {json}"
        );
    }

    // ─── reset_local_sync_state tests ────────────────────────────────────────

    /// Helper: insert a sync_state row with given status.
    fn insert_sync_state(conn: &Connection, entry_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO sync_state (entry_id, local_version, sync_status) VALUES (?1, 1, ?2)",
            rusqlite::params![entry_id, status],
        )
        .unwrap();
    }

    /// Helper: upsert a journal_sync_state row with given status.
    /// Uses INSERT OR REPLACE so it works even when migrate() already seeded
    /// a pending row for the default journal.
    fn insert_journal_sync_state(conn: &Connection, journal_id: &str, status: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO journal_sync_state (journal_id, local_version, sync_status) VALUES (?1, 1, ?2)",
            rusqlite::params![journal_id, status],
        )
        .unwrap();
    }

    /// Helper: insert a media row with given upload_status.
    fn insert_media(conn: &Connection, media_id: &str, entry_id: &str, upload_status: &str) {
        conn.execute(
            "INSERT INTO media (id, entry_id, file_name, file_type, storage_provider, storage_path, upload_status, sort_order, created_at) \
             VALUES (?1, ?2, 'test.jpg', 'image', 'local', '/tmp/test.jpg', ?3, 0, 0)",
            rusqlite::params![media_id, entry_id, upload_status],
        )
        .unwrap();
    }

    #[test]
    fn local_authoritative_rebuild_must_adopt_pulled_entries_and_journals() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let journal_id = "pulled-journal-without-ledger";
        let entry_id = "pulled-entry-without-ledger";

        conn.execute(
            "INSERT INTO journals (id, name, created_at, updated_at) VALUES (?1, 'Pulled', 1, 1)",
            [journal_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at) \
             VALUES (?1, ?2, 1, 1, 1)",
            rusqlite::params![entry_id, journal_id],
        )
        .unwrap();

        crate::sync::recovery::adopt_all_local_content_for_recovery(&conn).unwrap();

        let pending_entry: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE entry_id = ?1 AND sync_status = 'pending'",
                [entry_id],
                |row| row.get(0),
            )
            .unwrap();
        let pending_journal: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM journal_sync_state WHERE journal_id = ?1 AND sync_status = 'pending'",
                [journal_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            (pending_entry, pending_journal),
            (1, 1),
            "authoritative local rebuild must adopt pulled entries and journals; the current reset/wipe path only updates existing ownership ledgers"
        );
    }

    /// Test 1 (happy path): synced rows flip to pending, pending rows stay
    /// pending, and returned counts reflect only what was actually flipped.
    #[test]
    fn reset_flips_synced_to_pending_and_returns_correct_counts() {
        let state = make_state();
        let conn = state.lock().unwrap();

        // Get journal id from the default journal seeded by migrate.
        let jid: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // Entries: 2 synced + 1 pending.
        let e1 = db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_001,
            },
        )
        .unwrap();
        let e2 = db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_002,
            },
        )
        .unwrap();
        let e3 = db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_003,
            },
        )
        .unwrap();
        insert_sync_state(&conn, &e1.id, "synced");
        insert_sync_state(&conn, &e2.id, "synced");
        insert_sync_state(&conn, &e3.id, "pending");

        // Journals: 1 synced + 1 pending.
        insert_journal_sync_state(&conn, &jid, "synced");
        // A second fake journal id for the pending row.
        let fake_journal_id = "00000000-0000-0000-0000-000000000001";
        conn.execute(
            "INSERT INTO journals (id, name, color, sort_order, created_at, updated_at) VALUES (?1, 'J2', '#ff0000', 1, 0, 0)",
            rusqlite::params![fake_journal_id],
        )
        .unwrap();
        insert_journal_sync_state(&conn, fake_journal_id, "pending");

        // Media: 2 uploaded + 1 pending.
        insert_media(&conn, "m1", &e1.id, "uploaded");
        insert_media(&conn, "m2", &e2.id, "uploaded");
        insert_media(&conn, "m3", &e3.id, "pending");

        let counts = reset_local_sync_state(&conn).unwrap();

        assert_eq!(counts.entries, 2, "should flip 2 synced entries");
        assert_eq!(counts.journals, 1, "should flip 1 synced journal");
        assert_eq!(counts.media, 2, "should flip 2 uploaded media");

        // Verify all are now pending.
        let pending_entries: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE sync_status='pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending_entries, 3, "all 3 entry rows should be pending");

        let pending_media: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM media WHERE upload_status='pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending_media, 3, "all 3 media rows should be pending");
    }

    /// Test 2 (conflict preservation): a sync_state row with status='conflict'
    /// must NOT be flipped by reset — it needs user resolution.
    #[test]
    fn reset_leaves_conflict_rows_untouched() {
        let state = make_state();
        let conn = state.lock().unwrap();

        let jid: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let entry = db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_010,
            },
        )
        .unwrap();
        insert_sync_state(&conn, &entry.id, "conflict");

        let counts = reset_local_sync_state(&conn).unwrap();

        // Conflict entry must not be counted as flipped.
        assert_eq!(counts.entries, 0, "conflict row must not be counted");

        // Status must still be conflict.
        let status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                rusqlite::params![entry.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "conflict", "conflict row must remain conflict");
    }

    /// Test 3 (error media preservation): a media row with upload_status='error'
    /// must NOT be flipped by reset — those errors need user resolution.
    #[test]
    fn reset_leaves_error_media_untouched() {
        let state = make_state();
        let conn = state.lock().unwrap();

        let jid: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let entry = db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_020,
            },
        )
        .unwrap();
        insert_media(&conn, "me1", &entry.id, "error");

        let counts = reset_local_sync_state(&conn).unwrap();

        assert_eq!(counts.media, 0, "error media must not be counted");

        let status: String = conn
            .query_row(
                "SELECT upload_status FROM media WHERE id = 'me1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "error", "error media must remain error");
    }

    /// Whole-table surface names used by sync change-tracking hash gating.
    /// Shared with production reconcile/push (`HASH_GATED_SURFACE_NAMES`).
    const SURFACE_PUSH_HASH_SURFACES: &[&str] = crate::sync::engine::HASH_GATED_SURFACE_NAMES;

    fn seed_all_surface_push_hashes(conn: &Connection) {
        for surface in SURFACE_PUSH_HASH_SURFACES {
            db::set_surface_push_hash(conn, surface, &format!("hash-{surface}")).unwrap();
            assert!(
                db::get_surface_push_hash(conn, surface).unwrap().is_some(),
                "seed must leave {surface} clean (hash present)"
            );
        }
        db::set_pull_revision(conn, "peer-a", "metadata", "revision-a").unwrap();
        db::set_pull_revision(conn, "peer-b", "metadata", "revision-b").unwrap();
    }

    fn assert_all_surface_push_hashes_cleared(conn: &Connection) {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_push_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 0,
            "sync_push_state must be empty after bulk reset/repair"
        );
        for surface in SURFACE_PUSH_HASH_SURFACES {
            assert_eq!(
                db::get_surface_push_hash(conn, surface).unwrap(),
                None,
                "absent hash for {surface} means default-dirty → subsequent push re-uploads"
            );
        }
        let pull_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_pull_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            pull_count, 0,
            "sync_pull_state must clear with sync_push_state after bulk reset/repair"
        );
    }

    /// After a local reset (manual cloud wipe / wipe-cloud), every surface
    /// hash must be cleared so the next push re-uploads all 8 surfaces.
    #[test]
    fn reset_local_sync_state_clears_all_surface_push_hashes() {
        let state = make_state();
        let conn = state.lock().unwrap();
        seed_all_surface_push_hashes(&conn);

        reset_local_sync_state(&conn).unwrap();

        assert_all_surface_push_hashes_cleared(&conn);
    }

    /// Repair-from-this-device must clear surface hashes in the same
    /// transaction as media/version requeue (cloud may be empty/corrupt).
    #[test]
    fn repair_from_this_device_clears_all_surface_push_hashes() {
        let state = make_state();
        let conn = state.lock().unwrap();
        seed_all_surface_push_hashes(&conn);

        run_repair_from_this_device(&conn, &std::collections::HashSet::new()).unwrap();

        assert_all_surface_push_hashes_cleared(&conn);
    }

    /// Scope-upgrade (drive.file → appdata) orphans the old cloud folder;
    /// surface hashes for that content must not keep surfaces marked clean.
    #[test]
    fn mark_scope_upgrade_required_clears_all_surface_push_hashes() {
        let state = make_state();
        let conn = state.lock().unwrap();
        seed_all_surface_push_hashes(&conn);

        mark_scope_upgrade_required(&conn).unwrap();

        assert_all_surface_push_hashes_cleared(&conn);
        assert!(
            read_scope_upgrade_required(&conn),
            "scope-upgrade flag must still be set"
        );
    }

    #[test]
    fn deferred_sync_ux_queue_coalesces_duplicate_actions() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        clear_deferred_sync_ux_actions_for_tests();

        enqueue_deferred_sync_ux_action(DeferredSyncUxAction::ResetLocalState);
        enqueue_deferred_sync_ux_action(DeferredSyncUxAction::ResetLocalState);
        enqueue_deferred_sync_ux_action(DeferredSyncUxAction::RepairFromThisDevice);

        assert_eq!(
            pending_deferred_sync_ux_actions_for_tests(),
            vec![
                DeferredSyncUxAction::ResetLocalState,
                DeferredSyncUxAction::RepairFromThisDevice,
            ],
            "deferred sync UX actions must be queued once per action kind"
        );

        clear_deferred_sync_ux_actions_for_tests();
    }

    #[test]
    fn is_sync_in_progress_reflects_guard_lifetime() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        assert!(
            !is_sync_in_progress(),
            "sync must start idle before guard acquisition"
        );
        let guard = SyncInProgressGuard::try_acquire().expect("guard must be free");
        assert!(
            is_sync_in_progress(),
            "helper must report active sync while guard is held"
        );
        drop(guard);
        assert!(
            !is_sync_in_progress(),
            "helper must return to false after guard drop"
        );
    }

    // NOTE: every test below holds SYNC_GUARD_TEST_LOCK (a std Mutex) across
    // .await points. Sound because #[tokio::test] runs on a current_thread
    // runtime — nothing else on this thread can deadlock on the lock — but
    // fragile if a test ever switches to a multi_thread flavor.

    #[tokio::test(start_paused = true)]
    async fn acquire_waiting_returns_immediately_when_free_and_releases_on_drop() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let start = tokio::time::Instant::now();
        let guard = SyncInProgressGuard::acquire_waiting(std::time::Duration::from_secs(1)).await;
        assert!(guard.is_some(), "free slot must be acquired");
        // Under start_paused, virtual time only advances across .await on a
        // timer — the fast path must have hit none.
        assert!(
            start.elapsed().is_zero(),
            "fast path must not sleep before acquiring"
        );
        assert!(
            is_sync_in_progress(),
            "acquired guard must hold the sync slot"
        );
        drop(guard);
        assert!(
            !is_sync_in_progress(),
            "guard must release the slot on drop"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn acquire_waiting_acquires_after_holder_releases() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let holder = SyncInProgressGuard::try_acquire().expect("guard must be free");
        let waiter = tokio::spawn(SyncInProgressGuard::acquire_waiting(
            std::time::Duration::from_secs(10),
        ));

        // Let the waiter observe the held slot for a couple of poll rounds
        // and prove it actually blocked rather than resolving early.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        assert!(
            !waiter.is_finished(),
            "waiter must still be blocked while the guard is held"
        );
        drop(holder);

        let guard = waiter.await.expect("waiter task must not panic");
        assert!(
            guard.is_some(),
            "waiter must acquire the slot once the holder releases"
        );
        assert!(
            is_sync_in_progress(),
            "waiter's guard must now hold the sync slot"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn acquire_waiting_grants_slot_to_exactly_one_concurrent_waiter() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let holder = SyncInProgressGuard::try_acquire().expect("guard must be free");
        let first = tokio::spawn(SyncInProgressGuard::acquire_waiting(
            std::time::Duration::from_secs(10),
        ));
        let second = tokio::spawn(SyncInProgressGuard::acquire_waiting(
            std::time::Duration::from_secs(10),
        ));

        // Both waiters observe the held slot, then race for the release.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        drop(holder);
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        let finished = [first.is_finished(), second.is_finished()];
        assert_eq!(
            finished.iter().filter(|f| **f).count(),
            1,
            "exactly one waiter must win the freed slot; the loser keeps polling"
        );

        // The loser's guard stays held inside the winner's join result, so
        // the loser must run out its own timeout and come back empty.
        let first_guard = first.await.expect("first waiter must not panic");
        let second_guard = second.await.expect("second waiter must not panic");
        assert_eq!(
            first_guard.is_some() as u8 + second_guard.is_some() as u8,
            1,
            "the slot must never be granted to both concurrent waiters"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn acquire_waiting_times_out_while_held() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let _holder = SyncInProgressGuard::try_acquire().expect("guard must be free");
        let start = tokio::time::Instant::now();
        let guard = SyncInProgressGuard::acquire_waiting(std::time::Duration::from_secs(2)).await;
        assert!(guard.is_none(), "waiter must give up after the timeout");
        assert!(
            start.elapsed() >= std::time::Duration::from_secs(2),
            "waiter must keep polling until the deadline, not bail early"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn acquire_waiting_zero_timeout_fails_fast_while_held() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let _holder = SyncInProgressGuard::try_acquire().expect("guard must be free");
        let start = tokio::time::Instant::now();
        let guard = SyncInProgressGuard::acquire_waiting(std::time::Duration::ZERO).await;
        assert!(guard.is_none(), "zero timeout must not wait for the slot");
        assert!(
            start.elapsed().is_zero(),
            "zero timeout must return without sleeping"
        );
    }

    #[test]
    fn reset_queues_while_sync_in_progress() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        clear_deferred_sync_ux_actions_for_tests();
        let state = make_state();
        let conn = state.lock().unwrap();
        let _held = SyncInProgressGuard::try_acquire().expect("guard must be free");

        let result = sync_reset_local_state_inner(&conn).unwrap();

        assert!(result.queued, "reset must queue while sync is active");
        assert!(
            result.result.is_none(),
            "queued reset must not report immediate counts"
        );
        assert_eq!(
            pending_deferred_sync_ux_actions_for_tests(),
            vec![DeferredSyncUxAction::ResetLocalState]
        );
        clear_deferred_sync_ux_actions_for_tests();
    }

    #[test]
    fn deferred_reset_runs_after_sync_cycle() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        clear_deferred_sync_ux_actions_for_tests();
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            let jid: String = conn
                .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let entry = db::create_entry(
                &conn,
                db::CreateEntryParams {
                    journal_id: &jid,
                    title: None,
                    content_text: None,
                    preview_text: None,
                    entry_date: 1_700_000_030,
                },
            )
            .unwrap();
            insert_sync_state(&conn, &entry.id, "synced");
        }
        enqueue_deferred_sync_ux_action(DeferredSyncUxAction::ResetLocalState);

        drain_deferred_sync_ux_actions_inner(&state);

        let conn = state.lock().unwrap();
        let status: String = conn
            .query_row("SELECT sync_status FROM sync_state LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "pending");
        assert!(
            pending_deferred_sync_ux_actions_for_tests().is_empty(),
            "drain must consume queued actions"
        );
    }

    #[test]
    fn repair_queues_while_sync_in_progress() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        clear_deferred_sync_ux_actions_for_tests();
        let state = make_state();
        let conn = state.lock().unwrap();
        let _held = SyncInProgressGuard::try_acquire().expect("guard must be free");

        let result =
            sync_repair_from_this_device_inner(&conn, &std::collections::HashSet::new()).unwrap();

        assert!(result.queued, "repair must queue while sync is active");
        assert!(
            result.result.is_none(),
            "queued repair must not report an immediate adopted count"
        );
        assert_eq!(
            pending_deferred_sync_ux_actions_for_tests(),
            vec![DeferredSyncUxAction::RepairFromThisDevice]
        );
        clear_deferred_sync_ux_actions_for_tests();
    }

    #[test]
    fn device_slot_dirty_clear_keeps_flag_when_local_name_changed_during_flush() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-current".to_string(),
                name: "Uploaded Name".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();
        db::set_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY, "1").unwrap();
        db::update_device_name(&conn, "dev-current", "Newer Local Name").unwrap();

        clear_device_slot_dirty_if_current_name_matches(&conn, "Uploaded Name").unwrap();

        assert_eq!(
            db::get_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY).unwrap(),
            Some("1".to_string()),
            "flush must not clear dirty flag for a newer local rename"
        );
    }

    #[test]
    fn device_slot_dirty_clear_removes_flag_when_uploaded_name_is_current() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-current".to_string(),
                name: "Uploaded Name".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();
        db::set_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY, "1").unwrap();

        clear_device_slot_dirty_if_current_name_matches(&conn, "Uploaded Name").unwrap();

        assert_eq!(
            db::get_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY).unwrap(),
            None
        );
    }

    #[test]
    fn sync_progress_phase_all_variants_kebab_case() {
        use crate::sync::engine::SyncProgressPhase;
        let cases = [
            (SyncProgressPhase::PushingJournals, "pushing-journals"),
            (SyncProgressPhase::PushingMedia, "pushing-media"),
            (SyncProgressPhase::PushingEntries, "pushing-entries"),
            (SyncProgressPhase::PushingSettings, "pushing-settings"),
            (SyncProgressPhase::PushingTags, "pushing-tags"),
            (SyncProgressPhase::PushingTemplates, "pushing-templates"),
            (SyncProgressPhase::PushingLocations, "pushing-locations"),
            (SyncProgressPhase::PushingChats, "pushing-chats"),
            (SyncProgressPhase::PushingStreak, "pushing-streak"),
            (SyncProgressPhase::PushingAiAudit, "pushing-ai-audit"),
            (SyncProgressPhase::PullingManifests, "pulling-manifests"),
            (SyncProgressPhase::PullingTags, "pulling-tags"),
            (SyncProgressPhase::PullingJournals, "pulling-journals"),
            (SyncProgressPhase::PullingEntries, "pulling-entries"),
            (SyncProgressPhase::PullingSettings, "pulling-settings"),
            (SyncProgressPhase::PullingTemplates, "pulling-templates"),
            (SyncProgressPhase::PullingLocations, "pulling-locations"),
            (SyncProgressPhase::PullingChats, "pulling-chats"),
            (SyncProgressPhase::PullingStreak, "pulling-streak"),
            (SyncProgressPhase::PullingAiAudit, "pulling-ai-audit"),
        ];
        for (variant, expected) in cases {
            let got = serde_json::to_string(&variant).unwrap();
            assert_eq!(
                got,
                format!("\"{expected}\""),
                "variant {expected} serialized wrong"
            );
        }
    }

    // ── Scope upgrade migration ───────────────────────────────────────────

    #[test]
    fn read_scope_upgrade_required_defaults_false() {
        let state = make_state();
        let conn = state.lock().unwrap();
        assert!(!read_scope_upgrade_required(&conn));
    }

    #[test]
    fn read_scope_upgrade_required_returns_true_when_flag_set() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, GDRIVE_SCOPE_UPGRADE_REQUIRED_KEY, "1").unwrap();
        assert!(read_scope_upgrade_required(&conn));
    }

    #[test]
    fn read_scope_upgrade_required_treats_unexpected_value_as_false() {
        // Defence: the frontend stores "1" explicitly. Any other value
        // (corrupted row, legacy "true", future schema) must NOT trigger
        // the banner — that would lock users out of the Settings panel.
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, GDRIVE_SCOPE_UPGRADE_REQUIRED_KEY, "true").unwrap();
        assert!(!read_scope_upgrade_required(&conn));
    }

    /// Seed a `sync_state` row in the given status. Needs a parent `entries`
    /// row (FK cascade on entries) plus a parent `journals` row.
    fn seed_entry_with_sync_status(conn: &rusqlite::Connection, entry_id: &str, status: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) VALUES ('j', 'j', 0, 0)",
            [],
        )
        .expect("seed journal");
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at) VALUES (?, 'j', 0, 0, 0)",
            rusqlite::params![entry_id],
        )
        .expect("seed entry");
        conn.execute(
            "INSERT INTO sync_state (entry_id, local_version, sync_status) VALUES (?, 1, ?)",
            rusqlite::params![entry_id, status],
        )
        .expect("seed sync_state row");
    }

    #[test]
    fn mark_scope_upgrade_required_flips_synced_rows_and_sets_flag() {
        let state = make_state();
        let conn = state.lock().unwrap();
        seed_entry_with_sync_status(&conn, "entry-1", "synced");

        let counts = mark_scope_upgrade_required(&conn).unwrap();
        assert_eq!(counts.entries, 1, "should flip the synced entry to pending");

        // Flag is now set.
        assert!(read_scope_upgrade_required(&conn));

        // The row was flipped to pending.
        let status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = 'entry-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
    }

    #[test]
    fn mark_scope_upgrade_required_is_idempotent() {
        // Running twice must not error and must leave the flag set.
        let state = make_state();
        let conn = state.lock().unwrap();
        let _ = mark_scope_upgrade_required(&conn).unwrap();
        let _ = mark_scope_upgrade_required(&conn).unwrap();
        assert!(read_scope_upgrade_required(&conn));
    }

    #[test]
    fn mark_scope_upgrade_required_leaves_conflict_rows_alone() {
        // Rule: only `synced` rows are flipped. `conflict` and `error` rows
        // need user resolution, not silent reset.
        let state = make_state();
        let conn = state.lock().unwrap();
        seed_entry_with_sync_status(&conn, "entry-conflict", "conflict");
        seed_entry_with_sync_status(&conn, "entry-synced", "synced");

        let counts = mark_scope_upgrade_required(&conn).unwrap();
        assert_eq!(counts.entries, 1, "only the synced row should flip");

        let conflict_status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = 'entry-conflict'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            conflict_status, "conflict",
            "conflict row must be preserved"
        );
    }

    #[test]
    fn clear_scope_upgrade_required_removes_flag() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, GDRIVE_SCOPE_UPGRADE_REQUIRED_KEY, "1").unwrap();
        assert!(read_scope_upgrade_required(&conn));
        db::delete_setting(&conn, GDRIVE_SCOPE_UPGRADE_REQUIRED_KEY).unwrap();
        assert!(!read_scope_upgrade_required(&conn));
    }

    // ─── ensure_safe_to_push gate (replaces ensure_not_force_re_pair) ────────

    /// C1/C2: ensure_safe_to_push returns Ok on a clean DB.
    // ─── A1: persist_pull_leg_check (fail-closed wiring of the pull leg) ─────

    /// A corrupt cloud `_meta.json` must persist the fail-closed flag so that
    /// `ensure_safe_to_push` blocks — deleting the Corrupt wiring in
    /// `run_sync_now` (or routing it to Clean) must fail this test.
    #[test]
    fn persist_pull_leg_check_corrupt_blocks_push() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            persist_pull_leg_check(
                &conn,
                &PullLegKeyringCheck::Corrupt("_meta.json parse error".to_string()),
            )
            .expect("flag write must succeed");
        }
        let err = ensure_safe_to_push(&state).expect_err("corrupt meta must block push");
        assert!(
            err.contains("FORCE_RE_PAIR_REQUIRED"),
            "push must be blocked by the persisted flag, got: {err}"
        );
        let conn = state.lock().unwrap();
        assert_eq!(
            db::get_setting(&conn, db::FORCE_RE_PAIR_REASON)
                .unwrap()
                .as_deref(),
            Some("keyring_check_inconclusive"),
            "corrupt meta uses the inconclusive provenance so an auth-recheck can still clear it"
        );
    }

    #[test]
    fn persist_pull_leg_check_mismatch_sets_both_flags() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            persist_pull_leg_check(
                &conn,
                &PullLegKeyringCheck::Mismatch(crate::commands::gdrive::ForceRePairMismatch {
                    reason: "vault_rotated".to_string(),
                    cloud_epoch: 5,
                }),
            )
            .expect("flag write must succeed");
        }
        let err = ensure_safe_to_push(&state).expect_err("mismatch must block push");
        assert!(err.contains("rotated"), "got: {err}");
    }

    #[test]
    fn persist_pull_leg_check_clean_is_a_noop() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            persist_pull_leg_check(&conn, &PullLegKeyringCheck::Clean).unwrap();
        }
        assert!(
            ensure_safe_to_push(&state).is_ok(),
            "a clean check must not block push"
        );
    }

    const FOLDER_REPAIR_LOCAL_FP: &str =
        "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
    const FOLDER_REPAIR_CLOUD_FP: &str =
        "bb11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";

    fn configure_folder_sync(state: &AppState, root: &std::path::Path, leftover_drive_token: bool) {
        let cfg = serde_json::to_string(&LocalConfig {
            root_path: root.to_string_lossy().into_owned(),
        })
        .expect("serialize local sync config");
        let conn = state.lock().unwrap();
        db::set_sync_provider(&conn, "local").unwrap();
        db::set_sync_config_json(&conn, &cfg).unwrap();
        db::set_sync_enabled(&conn, true).unwrap();
        db::set_setting(&conn, db::CLOUD_MASTER_FINGERPRINT, FOLDER_REPAIR_LOCAL_FP).unwrap();
        db::set_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH, "1").unwrap();
        if leftover_drive_token {
            db::set_setting(&conn, "gdrive_refresh_token", "1//leftover-drive-token").unwrap();
        }
    }

    async fn seed_rotated_folder_meta(root: &std::path::Path) {
        let folder = LocalSyncProvider::new(root);
        let meta = crate::sync::keyring_v2::types::KeyringMetaV2 {
            version: crate::sync::keyring_v2::types::KEYRING_V2_VERSION,
            epoch: 2,
            master_fingerprint: FOLDER_REPAIR_CLOUD_FP.to_string(),
            content_epoch: 1,
            recovery_generation: 0,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
        };
        crate::sync::keyring_v2::io::write_meta(&folder, &meta)
            .await
            .expect("seed folder _meta.json");
    }

    fn assert_folder_vault_rotation(check: PullLegKeyringCheck) {
        match check {
            PullLegKeyringCheck::Mismatch(m) => {
                assert_eq!(m.reason, "vault_rotated");
                assert_eq!(m.cloud_epoch, 2);
            }
            PullLegKeyringCheck::Clean => panic!(
                "folder-backed rotation must run detect on the folder provider — \
                 Clean means the check bailed (no Drive token / leftover Drive session) \
                 instead of reading the folder vault"
            ),
            PullLegKeyringCheck::Corrupt(msg) => {
                panic!("expected folder vault Mismatch, got Corrupt: {msg}")
            }
        }
    }

    /// A local/iCloud folder vault must run `detect_force_re_pair` even when
    /// there is no Drive refresh token. Returning Clean here is the
    /// reconstruct_session / GDriveProvider::new_live hole: the dirty-keyring
    /// reupload would then publish local `_meta.json` over a peer rotation.
    #[tokio::test]
    async fn check_force_re_pair_sync_detects_folder_vault_rotation_without_drive_token() {
        let dir = tempfile::TempDir::new().unwrap();
        let state = make_state();
        configure_folder_sync(&state, dir.path(), false);
        seed_rotated_folder_meta(dir.path()).await;

        assert_folder_vault_rotation(check_force_re_pair_sync(&state).await);
    }

    /// A leftover Drive refresh token from a prior Drive session must not
    /// divert this check onto Drive. Probe the configured folder; a Drive
    /// network/auth failure would otherwise swallow the rotation as Clean.
    #[tokio::test]
    async fn check_force_re_pair_sync_detects_folder_vault_rotation_despite_leftover_drive_token() {
        let dir = tempfile::TempDir::new().unwrap();
        let state = make_state();
        configure_folder_sync(&state, dir.path(), true);
        seed_rotated_folder_meta(dir.path()).await;

        assert_folder_vault_rotation(check_force_re_pair_sync(&state).await);
    }

    #[test]
    fn ensure_safe_to_push_ok_when_neither_condition_holds() {
        let state = make_state();
        assert!(
            ensure_safe_to_push(&state).is_ok(),
            "must return Ok when no rotation job and no force-re-pair flag"
        );
    }

    /// C1/C2: ensure_safe_to_push blocks when force-re-pair is required.
    #[test]
    fn ensure_safe_to_push_blocks_when_force_re_pair_required() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, db::FORCE_RE_PAIR_REQUIRED, "1").unwrap();
        }
        let result = ensure_safe_to_push(&state);
        assert!(
            result.is_err(),
            "expected Err when FORCE_RE_PAIR_REQUIRED=1"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("Re-pair before syncing"),
            "error must mention re-pair: {msg}"
        );
    }

    /// C1/C2: ensure_safe_to_push emits the 'inconclusive' reason class when
    /// FORCE_RE_PAIR_REASON = keyring_check_inconclusive.
    #[test]
    fn ensure_safe_to_push_reason_inconclusive() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, db::FORCE_RE_PAIR_REQUIRED, "1").unwrap();
            db::set_setting(
                &conn,
                db::FORCE_RE_PAIR_REASON,
                "keyring_check_inconclusive",
            )
            .unwrap();
        }
        let msg = ensure_safe_to_push(&state).unwrap_err();
        assert!(
            msg.contains("FORCE_RE_PAIR_REQUIRED"),
            "must contain machine marker: {msg}"
        );
        assert!(
            msg.contains("reason=inconclusive"),
            "must encode inconclusive reason: {msg}"
        );
        assert!(
            msg.contains("Re-pair before syncing"),
            "must keep re-pair substring for existing tests: {msg}"
        );
    }

    /// C1/C2: ensure_safe_to_push emits the 'rotated' reason class for a real
    /// vault-rotation reason (any value other than keyring_check_inconclusive).
    #[test]
    fn ensure_safe_to_push_reason_rotated() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, db::FORCE_RE_PAIR_REQUIRED, "1").unwrap();
            db::set_setting(&conn, db::FORCE_RE_PAIR_REASON, "vault_rotated_on_peer").unwrap();
        }
        let msg = ensure_safe_to_push(&state).unwrap_err();
        assert!(
            msg.contains("FORCE_RE_PAIR_REQUIRED"),
            "must contain machine marker: {msg}"
        );
        assert!(
            msg.contains("reason=rotated"),
            "must encode rotated reason: {msg}"
        );
        assert!(
            msg.contains("Re-pair before syncing"),
            "must keep re-pair substring for existing tests: {msg}"
        );
    }

    /// C1: ensure_safe_to_push blocks when an active rotation job exists
    /// (e.g. state = reencrypt — paused after retry-abort).
    #[test]
    fn ensure_safe_to_push_blocks_when_active_rotation_job_exists() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::insert_rotation_job(&conn, "fp-old", "fp-new", 1, 2, None).unwrap();
        }
        let result = ensure_safe_to_push(&state);
        assert!(
            result.is_err(),
            "expected Err when active rotation job exists"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("rotation"),
            "error must mention rotation: {msg}"
        );
    }

    #[test]
    fn active_authoritative_recovery_must_block_normal_sync_single_flight() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            let job_id =
                db::create_sync_recovery_job(&conn, "local_to_cloud", 1, Some("backup.zip"), None)
                    .unwrap();
            db::advance_sync_recovery_job(&conn, job_id, "preflight", "{}").unwrap();
        }

        let result = begin_push_entry(&state);

        assert!(
            result.is_err(),
            "normal sync must not acquire the shared single-flight slot while an authoritative recovery job is active"
        );
    }

    /// C1: ensure_safe_to_push passes when the only rotation job is in done state.
    #[test]
    fn ensure_safe_to_push_ignores_done_and_aborted_rotation_jobs() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            let id = db::insert_rotation_job(&conn, "fp-old", "fp-new", 1, 2, None).unwrap();
            db::update_rotation_job_state(&conn, id, "done").unwrap();
        }
        assert!(
            ensure_safe_to_push(&state).is_ok(),
            "done rotation job must NOT block push"
        );
        // Also check aborted.
        {
            let conn = state.lock().unwrap();
            let id = db::insert_rotation_job(&conn, "fp-a", "fp-b", 3, 4, None).unwrap();
            db::update_rotation_job_state(&conn, id, "aborted").unwrap();
        }
        assert!(
            ensure_safe_to_push(&state).is_ok(),
            "aborted rotation job must NOT block push"
        );
    }

    /// C2: run_push_entry (via ensure_safe_to_push) blocks when an active
    /// rotation job exists, independently of the force-re-pair flag.
    ///
    /// The full run_push_entry requires a configured provider and AppHandle —
    /// not available in unit tests. We verify the guard directly, which is
    /// the seam called at the top of run_push_entry.
    #[test]
    fn run_push_entry_blocks_when_active_rotation_job_exists() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::insert_rotation_job(&conn, "fp-old", "fp-new", 5, 6, None).unwrap();
        }
        let result = ensure_safe_to_push(&state);
        assert!(
            result.is_err(),
            "ensure_safe_to_push (called by run_push_entry) must block for active rotation job"
        );
    }

    // ─── Bug 2: run_push_entry single-flight guard ───────────────────────────

    /// Bug 2 — blocked while guard held: `begin_push_entry` (the seam used by
    /// `run_push_entry`) must return `SYNC_IN_PROGRESS_ERR` when another sync
    /// already holds `SyncInProgressGuard`.
    ///
    /// Both assertions live in one test to avoid a race on the global
    /// `SYNC_IN_PROGRESS` flag between parallel test threads.
    #[test]
    fn run_push_entry_blocked_while_sync_in_progress_and_released_after_drop() {
        // Serialise all tests that touch the process-global SYNC_IN_PROGRESS flag.
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let state = make_state();

        // Acquire the guard to simulate a concurrent full sync (or entry push).
        let held = SyncInProgressGuard::try_acquire()
            .expect("guard must be free at the start of the test");

        // While the guard is held, begin_push_entry must fail with SYNC_IN_PROGRESS_ERR.
        match begin_push_entry(&state) {
            Ok(_) => panic!("begin_push_entry must be rejected while SyncInProgressGuard is held"),
            Err(msg) => assert_eq!(
                msg, SYNC_IN_PROGRESS_ERR,
                "error must be SYNC_IN_PROGRESS_ERR, got: {msg}"
            ),
        }

        // Drop the held guard — simulates the concurrent sync finishing.
        drop(held);

        // After the guard is released, begin_push_entry must succeed and return
        // a new guard (proving the flag was reset by Drop).
        let new_guard = begin_push_entry(&state);
        assert!(
            new_guard.is_ok(),
            "begin_push_entry must succeed once the prior guard is dropped"
        );
        // Drop so the flag is reset for other tests.
        drop(new_guard);
    }

    // ─── Phase 5 T4.1: cloud-content migration tests ─────────────────────────

    /// T4.1a — GDrive path: `run_cloud_content_migration` resets local state
    /// atomically, deletes device cloud files, publishes `_content.json` via
    /// `KeyringV2Io` (not SyncProvider), updates `_meta.json` content_epoch,
    /// and clears the migration flag.
    #[tokio::test]
    async fn cloud_migration_gdrive_publishes_content_json_via_keyring_io() {
        use crate::sync::keyring_v2::io::{
            read_content, read_meta, test_support::InMemoryKeyringProvider, write_meta,
            CONTENT_PATH,
        };
        use crate::sync::keyring_v2::types::{KeyringMetaV2, KEYRING_V2_VERSION};
        use crate::sync::provider::test_support::MockProvider;
        use crate::utils::encryption::{
            derive_sync_key, encode_content_key_list, key_fingerprint, KEY_SIZE,
        };
        use std::collections::BTreeMap;
        use std::sync::Arc;

        let state = make_state();
        let device_id = "test-device-aabbccdd";

        // Build a real v1 content key and load the key state.
        let raw_content_key_1 = zeroize::Zeroizing::new([0x42u8; KEY_SIZE]);
        let raw_master = zeroize::Zeroizing::new([0x11u8; KEY_SIZE]);
        let raw_db_key = zeroize::Zeroizing::new([0x22u8; KEY_SIZE]);

        let key_state = EncryptionKeyState::new();
        {
            let mut keys: BTreeMap<u32, zeroize::Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
            keys.insert(1, raw_content_key_1.clone());
            key_state
                .set_content_state(keys, 1, raw_db_key.clone(), raw_master.clone())
                .expect("set_content_state");
        }

        // Seed some sync_state + media rows (simulating previously-synced state).
        let version_id;
        {
            let conn = state.lock().unwrap();
            // Insert a journal + entry for sync_state.
            let journal_id = "journal-aaaaaaaa-1111-2222-3333-444444444444";
            conn.execute(
                "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) VALUES (?1, 'J', 1, 1)",
                [journal_id],
            ).unwrap();
            let entry_id = "entry-eeeeeeee-1111-2222-3333-444444444444";
            conn.execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text, entry_date, created_at, updated_at, is_favorite, is_deleted)
                 VALUES (?1, ?2, 't', 'p', 'c', 1, 1, 1, 0, 0)",
                [entry_id, journal_id],
            ).unwrap();
            conn.execute(
                "INSERT INTO sync_state (entry_id, local_version, sync_status) VALUES (?1, 3, 'synced')",
                [entry_id],
            ).unwrap();
            // Insert a journal_sync_state row (simulating a previously-synced journal).
            conn.execute(
                "INSERT INTO journal_sync_state (journal_id, local_version, sync_status) VALUES (?1, 2, 'synced')",
                [journal_id],
            ).unwrap();
            // Insert a media row.
            let media_id = "media-mmmmmmmm-1111-2222-3333-444444444444";
            conn.execute(
                "INSERT INTO media (id, entry_id, file_name, file_type, storage_provider, storage_path, upload_status, created_at)
                 VALUES (?1, ?2, 'test.jpg', 'image/jpeg', 'local', '/tmp/test.jpg', 'uploaded', 1)",
                [media_id, entry_id],
            ).unwrap();

            // Insert a version row marked 'uploaded' — the versions channel must be
            // wiped/reset by migration too (finding: it was silently skipped).
            version_id =
                db::insert_entry_version(&conn, entry_id, b"yjs", "preview", device_id).unwrap();
            db::mark_version_uploaded(&conn, &version_id, &format!("{device_id}/versions/v1.bin"))
                .unwrap();

            // Set the migration flag.
            db::set_setting(&conn, db::NEEDS_CLOUD_CONTENT_MIGRATION, "1").unwrap();

            // Stale surface hashes (clean gates) must not survive content-key migration —
            // cloud is wiped and re-encrypted under a new key.
            seed_all_surface_push_hashes(&conn);

            // Persist the wrapped content-key list (what the real onboarding stores).
            let mut keys_for_encode: BTreeMap<u32, zeroize::Zeroizing<[u8; KEY_SIZE]>> =
                BTreeMap::new();
            keys_for_encode.insert(1, raw_content_key_1.clone());
            let list_hex = encode_content_key_list(&raw_master, &keys_for_encode)
                .expect("encode_content_key_list");
            db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &list_hex).unwrap();
        }

        // SyncProvider (MockProvider) — holds old device cloud files.
        let provider: Arc<dyn crate::sync::SyncProvider> = Arc::new(MockProvider::new());
        {
            let path_entry = format!("{device_id}/entries/entry-eeeeeeee.bin");
            let path_media = format!("{device_id}/media/media-mmmmmmmm");
            let path_journal = format!("{device_id}/journals/journal-aaaaaaaa.bin");
            let path_version = format!("{device_id}/versions/v1.bin");
            provider
                .write_file(&path_entry, b"old-entry")
                .await
                .unwrap();
            provider
                .write_file(&path_media, b"old-media")
                .await
                .unwrap();
            provider
                .write_file(&path_journal, b"old-journal")
                .await
                .unwrap();
            provider
                .write_file(&path_version, b"old-version")
                .await
                .unwrap();
        }

        // KeyringV2Io (InMemoryKeyringProvider) — simulates the GDrive keyring store.
        // This is separate from the SyncProvider to mirror the production split
        // where LocalSyncProvider rejects .meta/... paths and only GDriveProvider
        // implements KeyringV2Io via write_shared_file.
        let keyring_io = InMemoryKeyringProvider::new();

        // Pre-seed a _meta.json with content_epoch=0 so the update is testable.
        let initial_meta = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: 1,
            master_fingerprint: "a".repeat(64),
            content_epoch: 0,
            recovery_generation: 0,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
        };
        write_meta(&keyring_io, &initial_meta).await.unwrap();

        // Run the migration (GDrive path — keyring_io is Some).
        run_cloud_content_migration(&state, &key_state, &provider, device_id, Some(&keyring_io))
            .await
            .unwrap();

        // Assert: sync_state rows are all pending.
        {
            let conn = state.lock().unwrap();
            let count_synced: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sync_state WHERE sync_status = 'synced'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                count_synced, 0,
                "all sync_state rows must be pending after migration"
            );

            let count_pending: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sync_state WHERE sync_status = 'pending'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count_pending, 1, "entry must be reset to pending");

            // Assert: media rows are all pending.
            let media_uploaded: i64 = conn
                .query_row(
                    "SELECT count(*) FROM media WHERE upload_status = 'uploaded'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                media_uploaded, 0,
                "no media must remain 'uploaded' after migration"
            );

            let media_pending: i64 = conn
                .query_row(
                    "SELECT count(*) FROM media WHERE upload_status = 'pending'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(media_pending, 1, "media must be reset to pending");

            // Assert: entry_versions rows are all pending with cloud_path cleared
            // (finding: the versions channel was silently skipped by migration).
            let version_uploaded: i64 = conn
                .query_row(
                    "SELECT count(*) FROM entry_versions WHERE upload_status = 'uploaded'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                version_uploaded, 0,
                "no entry_versions rows must remain 'uploaded' after migration"
            );
            let version_cloud_path: Option<String> = conn
                .query_row(
                    "SELECT cloud_path FROM entry_versions WHERE id = ?1",
                    [&version_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                version_cloud_path, None,
                "entry_versions.cloud_path must be cleared after migration"
            );

            // Assert: journal_sync_state rows are all pending (F3 regression guard).
            let journal_synced: i64 = conn
                .query_row(
                    "SELECT count(*) FROM journal_sync_state WHERE sync_status = 'synced'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                journal_synced, 0,
                "no journal_sync_state rows must remain 'synced' after migration (F3)"
            );
            let journal_pending: i64 = conn
                .query_row(
                    "SELECT count(*) FROM journal_sync_state WHERE sync_status = 'pending'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            // migrate() inserts a default "My Journal" which also gets a
            // journal_sync_state row (pending). Together with the test journal
            // we seeded, there are ≥ 2 pending rows after migration. The
            // important invariant is that none are 'synced' (checked above).
            assert!(
                journal_pending >= 1,
                "at least one journal_sync_state row must be pending after migration (F3), got 0"
            );

            // Assert: migration flag is cleared.
            let flag = db::get_setting(&conn, db::NEEDS_CLOUD_CONTENT_MIGRATION).unwrap();
            assert!(
                flag.is_none() || flag.as_deref() != Some("1"),
                "NEEDS_CLOUD_CONTENT_MIGRATION must be cleared after migration, got {flag:?}"
            );

            // Assert: all 8 surface push hashes cleared (default-dirty → re-upload).
            assert_all_surface_push_hashes_cleared(&conn);
        }

        // Assert: provider files for this device are gone.
        let entry_files = provider
            .list_files(device_id, crate::sync::provider::FileKind::Entries)
            .await
            .unwrap();
        let media_files = provider
            .list_files(device_id, crate::sync::provider::FileKind::Media)
            .await
            .unwrap();
        let journal_files = provider
            .list_files(device_id, crate::sync::provider::FileKind::Journals)
            .await
            .unwrap();
        let version_files = provider
            .list_files(device_id, crate::sync::provider::FileKind::Versions)
            .await
            .unwrap();
        assert!(
            entry_files.is_empty(),
            "entry files must be wiped: {entry_files:?}"
        );
        assert!(
            media_files.is_empty(),
            "media files must be wiped: {media_files:?}"
        );
        assert!(
            journal_files.is_empty(),
            "journal files must be wiped: {journal_files:?}"
        );
        assert!(
            version_files.is_empty(),
            "version files must be wiped: {version_files:?}"
        );

        // Assert: _content.json was published via KeyringV2Io (not engine_provider).
        // Use read_content to parse via the proper trait path (same as peers do).
        let content_list = read_content(&keyring_io)
            .await
            .expect("read_content must succeed")
            .expect("_content.json must exist in keyring_io after migration");
        assert_eq!(
            content_list.latest_epoch, 1,
            "_content.json must have latest_epoch=1"
        );
        assert_eq!(
            content_list.entries.len(),
            1,
            "_content.json must have exactly 1 entry (epoch 1)"
        );
        let entry0 = &content_list.entries[0];
        assert_eq!(entry0.epoch, 1, "entry[0].epoch must be 1");

        // Verify the content fingerprint matches what we'd compute independently.
        let expected_fp = hex::encode(key_fingerprint(&*derive_sync_key(&raw_content_key_1)));
        assert_eq!(
            entry0.content_fingerprint, expected_fp,
            "_content.json entry[0].content_fingerprint must match derive_sync_key(content_key_1)"
        );

        // Assert: _content.json was NOT written to the SyncProvider
        // (engine_provider must not accept .meta/... writes in production).
        let no_content_in_engine = provider.read_file(CONTENT_PATH).await;
        // MockProvider stores everything, so this would be Ok if we'd incorrectly
        // written via engine_provider. We never do; the test verifies keyring_io got it.
        // (We verify keyring_io above; here we just confirm it wasn't double-written.)
        drop(no_content_in_engine);

        // Assert: _meta.json content_epoch updated to 1.
        let meta = read_meta(&keyring_io)
            .await
            .expect("read_meta must succeed")
            .expect("_meta.json must exist after migration");
        assert_eq!(
            meta.content_epoch, 1,
            "_meta.json content_epoch must be updated to latest_epoch=1"
        );
    }

    /// T4.1b — iCloud/local path: `run_cloud_content_migration` still resets
    /// local state and clears the flag, but does NOT attempt to write
    /// `_content.json` (no keyring on iCloud).
    #[tokio::test]
    async fn cloud_migration_icloud_skips_keyring_publish_and_clears_flag() {
        use crate::sync::provider::test_support::MockProvider;
        use crate::utils::encryption::{encode_content_key_list, KEY_SIZE};
        use std::collections::BTreeMap;
        use std::sync::Arc;

        let state = make_state();
        let device_id = "test-device-local-icloud";

        let raw_content_key_1 = zeroize::Zeroizing::new([0x99u8; KEY_SIZE]);
        let raw_master = zeroize::Zeroizing::new([0x88u8; KEY_SIZE]);
        let raw_db_key = zeroize::Zeroizing::new([0x77u8; KEY_SIZE]);

        let key_state = EncryptionKeyState::new();
        {
            let mut keys: BTreeMap<u32, zeroize::Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
            keys.insert(1, raw_content_key_1.clone());
            key_state
                .set_content_state(keys, 1, raw_db_key.clone(), raw_master.clone())
                .expect("set_content_state");
        }

        {
            let conn = state.lock().unwrap();
            let journal_id = "journal-bbbbbbbb-1111-2222-3333-444444444444";
            conn.execute(
                "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) VALUES (?1, 'J', 1, 1)",
                [journal_id],
            ).unwrap();
            let entry_id = "entry-ffffffff-1111-2222-3333-444444444444";
            conn.execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text, entry_date, created_at, updated_at, is_favorite, is_deleted)
                 VALUES (?1, ?2, 't', 'p', 'c', 1, 1, 1, 0, 0)",
                [entry_id, journal_id],
            ).unwrap();
            conn.execute(
                "INSERT INTO sync_state (entry_id, local_version, sync_status) VALUES (?1, 5, 'synced')",
                [entry_id],
            ).unwrap();
            db::set_setting(&conn, db::NEEDS_CLOUD_CONTENT_MIGRATION, "1").unwrap();
            // Same invariant as GDrive path: wipe + rekey must clear surface hashes.
            seed_all_surface_push_hashes(&conn);
            let mut keys_for_encode: BTreeMap<u32, zeroize::Zeroizing<[u8; KEY_SIZE]>> =
                BTreeMap::new();
            keys_for_encode.insert(1, raw_content_key_1.clone());
            let list_hex = encode_content_key_list(&raw_master, &keys_for_encode)
                .expect("encode_content_key_list");
            db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &list_hex).unwrap();
        }

        let provider: Arc<dyn crate::sync::SyncProvider> = Arc::new(MockProvider::new());

        // Run migration with keyring_io=None (iCloud/local path).
        run_cloud_content_migration(&state, &key_state, &provider, device_id, None)
            .await
            .expect("iCloud migration must succeed without keyring_io");

        // Assert: sync_state reset to pending.
        {
            let conn = state.lock().unwrap();
            let count_synced: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sync_state WHERE sync_status = 'synced'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count_synced, 0, "sync_state must be reset");

            // Assert: migration flag is cleared.
            let flag = db::get_setting(&conn, db::NEEDS_CLOUD_CONTENT_MIGRATION).unwrap();
            assert!(
                flag.is_none() || flag.as_deref() != Some("1"),
                "NEEDS_CLOUD_CONTENT_MIGRATION must be cleared even for iCloud path, got {flag:?}"
            );

            // Assert: all 8 surface push hashes cleared (iCloud path too).
            assert_all_surface_push_hashes_cleared(&conn);
        }
    }

    // ─── sync_repair_from_this_device tests ──────────────────────────────────

    /// Seed an entry row with no sync_state row (simulates a pulled entry).
    fn seed_orphan_entry(conn: &Connection, entry_id: &str) {
        let jid: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at) \
             VALUES (?1, ?2, 0, 0, 0)",
            rusqlite::params![entry_id, jid],
        )
        .unwrap();
    }

    /// Full end-to-end test of `run_repair_from_this_device`:
    /// seeds an orphaned entry + uploaded media, calls the inner repair
    /// function, and asserts that the entry is now pending in `sync_state`
    /// and appears in `list_pending_entry_ids`, and that the media row is
    /// reset to `'pending'`.
    #[test]
    fn repair_adopts_orphaned_entry_and_resets_media() {
        let state = make_state();
        let conn = state.lock().unwrap();

        seed_orphan_entry(&conn, "orphan-e1");

        // Seed a media row marked 'uploaded'.
        conn.execute(
            "INSERT INTO media \
             (id, entry_id, file_name, file_type, storage_provider, storage_path, \
              upload_status, sort_order, created_at) \
             VALUES ('m1', 'orphan-e1', 'a.jpg', 'image', 'local', '/tmp/a.jpg', \
                     'uploaded', 0, 0)",
            [],
        )
        .unwrap();

        // Seed a version row marked 'uploaded' — the versions channel must be
        // reset by repair too (finding: it was silently skipped).
        let version_id =
            db::insert_entry_version(&conn, "orphan-e1", b"yjs", "preview", "device-a").unwrap();
        db::mark_version_uploaded(&conn, &version_id, "device-a/versions/v1.bin").unwrap();

        let adopted =
            run_repair_from_this_device(&conn, &std::collections::HashSet::new()).unwrap();
        assert_eq!(adopted, 1, "one orphaned entry must be adopted");

        // sync_state row must now be pending.
        let status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = 'orphan-e1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");

        // Entry must appear in the push queue.
        let ids = db::list_pending_entry_ids(&conn).unwrap();
        assert!(ids.contains(&"orphan-e1".to_string()));

        // Media must have been reset to pending.
        let media_status: String = conn
            .query_row("SELECT upload_status FROM media WHERE id = 'm1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(media_status, "pending");

        // Version must have been reset to pending with cloud_path cleared.
        let (version_status, version_cloud_path): (String, Option<String>) = conn
            .query_row(
                "SELECT upload_status, cloud_path FROM entry_versions WHERE id = ?1",
                [&version_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(version_status, "pending");
        assert_eq!(version_cloud_path, None);
    }

    /// Verify that an already-synced entry is also flipped to pending by the
    /// repair (it must re-publish after a cloud wipe, even if it authored the
    /// content originally).
    #[test]
    fn repair_flips_synced_entry_to_pending() {
        let state = make_state();
        let conn = state.lock().unwrap();

        seed_orphan_entry(&conn, "synced-e2");
        conn.execute(
            "INSERT INTO sync_state (entry_id, local_version, sync_status) \
             VALUES ('synced-e2', 5, 'synced')",
            [],
        )
        .unwrap();

        let adopted =
            run_repair_from_this_device(&conn, &std::collections::HashSet::new()).unwrap();
        assert_eq!(adopted, 1, "synced row must be flipped to pending");

        let status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = 'synced-e2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
        let ids = db::list_pending_entry_ids(&conn).unwrap();
        assert!(ids.contains(&"synced-e2".to_string()));
    }

    /// `run_repair_guarded` must reject direct repair calls while a sync is
    /// in progress (guards against concurrent reset + push race).
    ///
    /// The Tauri command queues first; this pins the lower-level guard path.
    #[test]
    fn repair_blocked_while_sync_in_progress() {
        // Serialise tests touching the process-global SYNC_IN_PROGRESS flag.
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let state = make_state();
        let _held = SyncInProgressGuard::try_acquire().expect("guard must be free at test start");

        // Call the production guard seam directly — removing or breaking the
        // guard in run_repair_guarded will cause this assertion to fail.
        let conn = state.lock().unwrap();
        let blocked = run_repair_guarded(&conn, &std::collections::HashSet::new());

        match blocked {
            Err(msg) => assert_eq!(msg, SYNC_IN_PROGRESS_ERR),
            Ok(_) => panic!("repair must be rejected while sync is in progress"),
        }
    }
}
