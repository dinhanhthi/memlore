//! Tauri commands for on-device **LLM** model download management (Phase 2 Task 3).
//!
//! This is the command surface for the on-device *generation* (chat) feature —
//! the JIT download of GGUF weights + the `llama-server` sidecar binary. It is
//! the LLM counterpart to the embedding-side on-device commands that live in
//! [`crate::commands::ai_provider`] (`list_on_device_models` etc.), but the two
//! are kept in separate modules because:
//!
//! - the **asset classes differ** (raw `.gguf` + an extracted executable vs.
//!   `fastembed` weights under an opaque cache layout),
//! - the **download model differs** (the LLM fetcher is a cancellable streaming
//!   HTTP fetch with real byte progress, so the command is *fire-and-forget*
//!   and reports progress via events; the embedding download *blocks* and is
//!   polled for on-disk byte progress because `fastembed` has no incremental
//!   callback), and
//! - deleting an LLM model **stops** the sidecar if it currently holds that
//!   GGUF (Windows file-lock), **then** removes files, **then** forgets the
//!   generation slot when settings still point at that model — rather than
//!   rejecting with `"model_in_use"`. Stop is keyed off sidecar state, not
//!   settings (a picker swap to another GGUF leaves the sidecar on the old
//!   one until the next chat).
//!
//! # Why the download command is fire-and-forget
//!
//! A GGUF is multi-GB and the fetch streams with a real byte-progress callback,
//! so blocking the Tauri command promise for the whole download would pin a
//! JS-side promise open for minutes. Instead `download_on_device_llm_model`
//! validates the id, spawns a tokio task that does the actual
//! `ensure_server_binary` → `download_model` work, and returns `Ok(())`
//! immediately. The frontend follows `on-device-llm:download-progress` events
//! (`{ id, phase, state, progress?, code? }`) and re-reads state via
//! `list_on_device_llm_models` when it sees a terminal `state`.
//!
//! # No raw SQL
//!
//! Per project rule, commands never run raw SQL. The delete-in-use check reads
//! `ai_gen_provider` + `ai_gen_chat_model` through the shared settings-db
//! accessor ([`crate::db::get_setting`]) — no hand-written queries.

use crate::ai::on_device::download::DownloadState;
use crate::ai::on_device::llm_catalog;
use crate::ai::on_device::llm_download::{HttpLlmFetcher, LlmAssetManager, BINARY_KEY};
use crate::ai::on_device::server::{
    payload_for, LlamaServerManager, ServerState, ServerStatusPayload, ServerStatusSink,
};
use crate::ai::provider::settings_keys;
use crate::ai::provider_registry::ProviderRegistry;
use crate::AppState;

use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

/// Event channel for download progress + terminal state. The frontend listens
/// on this exact string (Phase 3 frontend wiring).
const PROGRESS_EVENT: &str = "on-device-llm:download-progress";

/// Event channel for sidecar lifecycle transitions (Task 3). Emitted on every
/// `LlamaServerManager` state change (Starting / Ready / Failed / Stopped) via
/// the [`TauriServerStatusSink`] wired in the setup closure. The Phase 5
/// frontend hook listens on this exact string.
pub const SERVER_STATUS_EVENT: &str = "on-device-llm:server-status";

// ─── Tauri-side status sink (Task 3) ───────────────────────────────────────
//
// The bridge between the core `server.rs` module and Tauri's event bus. The
// core module depends only on the `ServerStatusSink` trait (no `tauri::*`),
// keeping it unit-testable; this struct is the one concrete impl that calls
// `app.emit`. It lives here (next to the download-progress emitter, which uses
// the same `app.emit` pattern) rather than in `server.rs` so the core module
// stays Tauri-free.

/// `ServerStatusSink` impl that forwards each payload to the frontend as an
/// `on-device-llm:server-status` event. Constructed once in the Tauri setup
/// closure and wired onto the `LlamaServerManager` via `set_sink`. The
/// `AppHandle` is cheap to clone and thread-safe, so a single shared sink
/// serves every transition.
pub struct TauriServerStatusSink {
    app: AppHandle,
}

impl TauriServerStatusSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ServerStatusSink for TauriServerStatusSink {
    fn emit(&self, payload: ServerStatusPayload) {
        // Errors here (e.g. no frontend window during shutdown) are not fatal —
        // a missed status event just means the UI hydrates from the
        // `get_on_device_llm_server_status` command on next mount. Swallow.
        let _ = self.app.emit(SERVER_STATUS_EVENT, payload);
    }
}

/// The `ai_gen_provider` value that selects the on-device LLM backend. Matches
/// the provider id registered in Phase 4 (the OpenAI-compatible provider
/// pointed at the local `llama-server`). Kept as a module constant here (not
/// imported from the provider, which doesn't exist yet) so the in-use guard
/// compiles independently of Phase 4.
const ON_DEVICE_LLM_PROVIDER_ID: &str = "on-device-llm";

/// Device-local Gemma ToU receipt (ISO timestamp). Not in
/// `SYNCABLE_SETTING_KEYS` — consent is per-device, like credentials.
pub const ON_DEVICE_LLM_TERMS_ACCEPTED_AT: &str = "on_device_llm_terms_accepted_at";

// ─── Wire types ────────────────────────────────────────────────────────────

/// One on-device LLM catalog entry joined with its current download state.
/// Serializes to camelCase to match the rest of the AI command surface.
///
/// `download_state` serializes via [`DownloadState`]'s own
/// `#[serde(tag = "status")]` derive, so the frontend reads
/// `{ status: "not_downloaded" | "downloading" | "ready" | "error", progress?, code? }`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnDeviceLlmModelInfo {
    pub id: String,
    pub display_name: String,
    pub download_size_bytes: u64,
    pub context_tokens: u32,
    pub min_ram_gb: u32,
    pub recommended: bool,
    pub multilingual: bool,
    pub when_to_choose: String,
    pub terms_url: String,
    pub requires_acceptance: bool,
    pub download_state: DownloadState,
}

/// Event payload for [`PROGRESS_EVENT`]. `id` is the model id, or
/// [`BINARY_KEY`] (`"_server_binary"`) for the binary-install phase.
/// `phase` disambiguates which asset is downloading (`"binary"` | `"model"`).
/// `state` is one of `"downloading"`, `"ready"`, `"error"`; `progress` is
/// present only while `state == "downloading"`; `code` only when
/// `state == "error"`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressPayload {
    pub id: String,
    pub phase: Option<String>,
    pub state: String,
    pub progress: Option<u8>,
    pub code: Option<String>,
}

impl DownloadProgressPayload {
    /// Mid-flight tick: `{ id, phase, state: "downloading", progress }`.
    fn downloading(id: &str, phase: &str, progress: u8) -> Self {
        Self {
            id: id.to_string(),
            phase: Some(phase.to_string()),
            state: "downloading".to_string(),
            progress: Some(progress),
            code: None,
        }
    }

    /// Terminal success: `{ id, phase, state: "ready" }`.
    fn ready(id: &str, phase: &str) -> Self {
        Self {
            id: id.to_string(),
            phase: Some(phase.to_string()),
            state: "ready".to_string(),
            progress: None,
            code: None,
        }
    }

    /// Terminal failure: `{ id, phase, state: "error", code }`.
    fn error(id: &str, phase: &str, code: &str) -> Self {
        Self {
            id: id.to_string(),
            phase: Some(phase.to_string()),
            state: "error".to_string(),
            progress: None,
            code: Some(code.to_string()),
        }
    }
}

/// Wire payload for [`on_device_llm_binary_status`]. Snake_case keys
/// (`installed`, `size_bytes`) match the TS `OnDeviceLlmBinaryStatusPayload`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct OnDeviceLlmBinaryStatusPayload {
    pub installed: bool,
    pub size_bytes: u64,
}

// ─── Pure helpers (unit-tested; no Tauri State) ────────────────────────────

/// True iff `model_id` is the currently-active on-device LLM generation model.
///
/// Used by [`delete_on_device_llm_model`] to decide whether to forget the
/// generation slot (wipe `ai_gen_provider` + chat model, clear the
/// registry) after files are unlinked. Sidecar stop is independent — see
/// [`sidecar_holds_gguf`]. Separated from the command so the truth table
/// is unit-testable without a DB.
///
/// Matches when the generation provider is the on-device LLM backend AND the
/// configured chat model id equals `model_id` exactly.
pub fn is_model_in_use(provider: &str, chat_model: &str, model_id: &str) -> bool {
    provider == ON_DEVICE_LLM_PROVIDER_ID && chat_model == model_id
}

/// True iff the sidecar is currently mapping `model_id`'s GGUF
/// (`Starting` or `Ready` with that id). Independent of generation settings:
/// a user can chat on GGUF A, switch the picker to B (sidecar stays on A
/// until the next chat), then delete A while settings point at B.
pub fn sidecar_holds_gguf(state: &ServerState, model_id: &str) -> bool {
    match state {
        ServerState::Starting { model_id: loaded }
        | ServerState::Ready {
            model_id: loaded, ..
        } => loaded == model_id,
        ServerState::Stopped | ServerState::Failed { .. } => false,
    }
}

/// True iff the sidecar process is up (`Starting` or `Ready`). Used when
/// deleting the `llama-server` binary: any live sidecar maps the executable,
/// regardless of which GGUF it loaded.
pub fn sidecar_is_live(state: &ServerState) -> bool {
    matches!(
        state,
        ServerState::Starting { .. } | ServerState::Ready { .. }
    )
}

/// Forget the gen slot when `id` is the active on-device LLM model.
/// Returns whether the slot was wiped. Sidecar stop is **not** gated on this
/// — callers stop when [`sidecar_holds_gguf`] is true, then unlink, then
/// forget so a failed unlink leaves settings intact for retry.
pub(crate) fn forget_generation_if_llm_in_use(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    id: &str,
) -> Result<bool, String> {
    let provider = crate::db::get_setting(conn, settings_keys::gen::PROVIDER)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let chat_model = crate::db::get_setting(conn, settings_keys::gen::CHAT_MODEL)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if !is_model_in_use(&provider, &chat_model, id) {
        return Ok(false);
    }
    crate::commands::ai_provider::forget_slot(
        conn,
        &[settings_keys::gen::PROVIDER, settings_keys::gen::CHAT_MODEL],
    )
    .map_err(|e| e.to_string())?;
    registry.clear_generation();
    Ok(true)
}

/// Forget the gen slot when the generation provider is `on-device-llm`
/// (any chat model — broader than [`is_model_in_use`], because deleting
/// the sidecar binary disables every on-device model). Returns whether
/// the slot was wiped. Sidecar stop is **not** gated on this — callers
/// stop when [`sidecar_is_live`] is true, then unlink, then forget.
pub(crate) fn forget_generation_if_on_device_llm(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
) -> Result<bool, String> {
    let provider = crate::db::get_setting(conn, settings_keys::gen::PROVIDER)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if provider != ON_DEVICE_LLM_PROVIDER_ID {
        return Ok(false);
    }
    crate::commands::ai_provider::forget_slot(
        conn,
        &[settings_keys::gen::PROVIDER, settings_keys::gen::CHAT_MODEL],
    )
    .map_err(|e| e.to_string())?;
    registry.clear_generation();
    Ok(true)
}

/// Stop the sidecar when it holds this GGUF, unlink files, then forget the
/// gen slot if settings still point at `id`. Stop errors are logged and
/// never fatal. Test-only: the command sequences the same steps around an
/// async sidecar stop without holding the DB lock.
#[cfg(test)]
pub(crate) fn teardown_and_remove_llm_model(
    conn: &rusqlite::Connection,
    id: &str,
    registry: &ProviderRegistry,
    manager: &LlmAssetManager,
    sidecar_state: &ServerState,
    stop: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if sidecar_holds_gguf(sidecar_state, id) {
        if let Err(e) = stop() {
            log::warn!("delete_on_device_llm_model: stop sidecar failed (non-fatal): {e}");
        }
    }
    manager.remove_model(id)?;
    forget_generation_if_llm_in_use(conn, registry, id)?;
    Ok(())
}

/// Stop the sidecar when it is live, wipe `binary_dir`, then forget the gen
/// slot if provider is `on-device-llm`. Stop errors are logged and never
/// fatal. Test-only: the command sequences the same steps around an async
/// sidecar stop without holding the DB lock.
#[cfg(test)]
pub(crate) fn teardown_and_remove_llm_binary(
    conn: &rusqlite::Connection,
    registry: &ProviderRegistry,
    manager: &LlmAssetManager,
    sidecar_state: &ServerState,
    stop: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if sidecar_is_live(sidecar_state) {
        if let Err(e) = stop() {
            log::warn!("delete_on_device_llm_binary: stop sidecar failed (non-fatal): {e}");
        }
    }
    manager.remove_binary()?;
    forget_generation_if_on_device_llm(conn, registry)?;
    Ok(())
}

/// Build the catalog → info list given a state lookup closure. Pure (no
/// `LlmAssetManager` / no IO) so the assembly logic — right count, ids match
/// catalog, recommended flag propagated — is unit-testable without spinning up
/// Tauri State. The command passes a closure that reads the manager.
pub fn build_model_infos(state_of: impl Fn(&str) -> DownloadState) -> Vec<OnDeviceLlmModelInfo> {
    llm_catalog::catalog()
        .iter()
        .map(|m| OnDeviceLlmModelInfo {
            id: m.id.to_string(),
            display_name: m.display_name.to_string(),
            download_size_bytes: m.download_size_bytes,
            context_tokens: m.context_tokens,
            min_ram_gb: m.min_ram_gb,
            recommended: m.recommended,
            multilingual: m.multilingual,
            when_to_choose: m.when_to_choose.to_string(),
            terms_url: m.terms_url.to_string(),
            requires_acceptance: m.requires_acceptance,
            download_state: state_of(m.id),
        })
        .collect()
}

/// Reject a Gemma (or other ToU-gated) download when the device has no
/// non-empty `on_device_llm_terms_accepted_at` receipt. Pure over a SQLite
/// connection so the gate is unit-testable without Tauri State.
pub fn require_terms_acceptance(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
    let model = llm_catalog::find(id).ok_or_else(|| "model_not_found".to_string())?;
    if !model.requires_acceptance {
        return Ok(());
    }
    let receipt =
        crate::db::get_setting(conn, ON_DEVICE_LLM_TERMS_ACCEPTED_AT).map_err(|e| e.to_string())?;
    match receipt {
        Some(s) if !s.trim().is_empty() => Ok(()),
        _ => Err("terms_not_accepted".into()),
    }
}

/// Decide whether a fresh `download_on_device_llm_model(id)` call should be
/// rejected given the model's **current** state.
///
/// The concurrent-same-id guard ([Fix 3] of the Phase 2 review): two rapid
/// calls for the same `id` race on the same `.part` file (corrupted hash →
/// both fail) and the second call's `register_cancel` supersedes the first
/// task's token (first task becomes un-cancellable). Rejecting an in-flight
/// `Downloading` state before spawning makes the one-token-per-id invariant
/// actually hold. Re-download is still allowed after `Ready` (no-op
/// short-circuit in `download_model`) and after `Error` (retry), so only the
/// `Downloading` arm returns `Some`.
///
/// Returns `Some("already_downloading")` when `state` is `Downloading`, else
/// `None` (caller proceeds). Pure so the truth table is unit-testable without
/// a manager.
pub fn should_reject_download(state: &DownloadState) -> Option<&'static str> {
    match state {
        DownloadState::Downloading { .. } => Some("already_downloading"),
        _ => None,
    }
}

/// Drive a download phase to completion while forwarding live progress as
/// events, reading progress from the manager's in-memory state (set by the
/// fetcher's `report_progress` callback).
///
/// Still used for the binary phase: the archive's total size is unknown at
/// this layer (see `LlmAssetManager::ensure_server_binary`'s `size: 0` — the
/// catalog only pins the archive's SHA-256, not its byte length), so an
/// on-disk-bytes-over-total percent can't be computed for it the way
/// [`run_model_phase`] does for the GGUF. The fetcher's callback is the only
/// progress source available here.
///
/// The poller stops as soon as `drive` resolves, so terminal events are owned
/// by the caller (which emits a `ready`/`error` event after this returns) —
/// this keeps the poller from racing a terminal emit.
///
/// Parameters:
/// - `phase_key` — the manager-side state key (`BINARY_KEY` for the binary).
/// - `phase_label` / `event_id` — the event-payload `phase` and `id` fields
///   (`"binary"`/`"_server_binary"`).
async fn run_phase<Fut>(
    app: AppHandle,
    manager: Arc<LlmAssetManager>,
    phase_key: &str,
    phase_label: &str,
    event_id: &str,
    drive: Fut,
) -> Result<(), String>
where
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let poller = {
        let done = Arc::clone(&done);
        let phase_label = phase_label.to_string();
        let event_id = event_id.to_string();
        let phase_key = phase_key.to_string();
        let manager = Arc::clone(&manager);
        tokio::spawn(async move {
            while !done.load(std::sync::atomic::Ordering::Relaxed) {
                // Read live progress from the manager and forward it.
                if let DownloadState::Downloading { progress } = manager.state(&phase_key) {
                    let _ = app.emit(
                        PROGRESS_EVENT,
                        DownloadProgressPayload::downloading(&event_id, &phase_label, progress),
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        })
    };

    let result = drive.await;

    // Stop the poller BEFORE returning so we never keep emitting progress for
    // a phase that already finished (avoids a stuck-progress UX).
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = poller.await;
    result
}

/// Drive the model-download phase to completion, computing progress from
/// on-disk bytes (`LlmAssetManager::model_on_disk_bytes`) rather than the
/// fetcher's own whole-percent-throttled callback — mirrors the embedding
/// provider's `dir_size_bytes` poller in `commands/ai_provider.rs`, which
/// exists for the exact same reason: a callback-only progress source can get
/// stuck at 0% if the download completes (or a burst of bytes lands) between
/// poller ticks. This on-disk poller is the AUTHORITATIVE progress source the
/// frontend follows; the fetcher's `report_progress` callback keeps running
/// too (it updates the same manager state), but is now a harmless secondary
/// writer rather than the only one.
///
/// `total_bytes` is the model's catalog `download_size_bytes`, used as the
/// poller's percent denominator (via `download::download_percent`, which
/// clamps at 99% — the final 100% tick is the caller's terminal `ready`
/// event, emitted after this returns).
async fn run_model_phase<Fut>(
    app: AppHandle,
    manager: Arc<LlmAssetManager>,
    model_id: &str,
    total_bytes: u64,
    drive: Fut,
) -> Result<(), String>
where
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let poller = {
        let done = Arc::clone(&done);
        let model_id = model_id.to_string();
        let manager = Arc::clone(&manager);
        let app = app.clone();
        tokio::spawn(async move {
            while !done.load(std::sync::atomic::Ordering::Relaxed) {
                let on_disk = manager.model_on_disk_bytes(&model_id);
                let pct = crate::ai::on_device::download::download_percent(on_disk, total_bytes);
                let _ = app.emit(
                    PROGRESS_EVENT,
                    DownloadProgressPayload::downloading(&model_id, "model", pct),
                );
                // Keep the manager's own state in sync too, so
                // `list_on_device_llm_models` / `model_state` reflect the
                // same on-disk-derived progress a caller polling them mid-
                // download would see (mirrors `report_download_progress` in
                // the embedding poller).
                manager.report_progress(&model_id, pct);
                tokio::time::sleep(std::time::Duration::from_millis(750)).await;
            }
        })
    };

    let result = drive.await;

    done.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = poller.await;
    result
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// List the on-device LLM catalog with each entry's current download state.
/// One row per catalog model, joined with its `DownloadState` from the manager
/// (Ready survives an app restart via the on-disk ready marker).
#[tauri::command]
pub async fn list_on_device_llm_models(
    manager: State<'_, Arc<LlmAssetManager>>,
) -> Result<Vec<OnDeviceLlmModelInfo>, String> {
    Ok(build_model_infos(|id| manager.model_state(id)))
}

/// Return the current `llama-server` sidecar lifecycle state as a
/// [`ServerStatusPayload`] (Task 3). Synchronous (no async) — this is the
/// initial-hydration path the frontend calls on mount to learn "what's the
/// current state" before any transition events arrive. Subsequent changes are
/// delivered via the `on-device-llm:server-status` event.
///
/// The command body just delegates to the pure [`payload_for`] mapping (which is
/// unit-tested in `server.rs`), so the wiring here is a thin pass-through.
#[tauri::command]
pub fn get_on_device_llm_server_status(
    manager: State<'_, Arc<LlamaServerManager>>,
) -> ServerStatusPayload {
    payload_for(&manager.state())
}

/// Start (fire-and-forget) a model download: ensures the `llama-server` binary
/// is installed first, then downloads the model's GGUF. Returns `Ok(())`
/// immediately after spawning; the frontend follows progress via
/// [`PROGRESS_EVENT`] events.
///
/// Validation failures (unknown id, or a download for `id` already in flight)
/// reject the promise before spawning. Once the task is running, failures are
/// reported only via an `error` event — the command promise is already
/// resolved. The in-flight check rejects with `"already_downloading"` so two
/// rapid calls for the same id can't race on the same `.part` file or
/// supersede each other's cancel token (see [`should_reject_download`]).
#[tauri::command]
pub async fn download_on_device_llm_model(
    id: String,
    manager: State<'_, Arc<LlmAssetManager>>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if llm_catalog::find(&id).is_none() {
        return Err("model_not_found".to_string());
    }
    // Gemma ToU gate: reject before spawn so a missing receipt never starts
    // a multi-GB download. Device-local setting — not synced.
    {
        let conn = state.lock()?;
        require_terms_acceptance(&conn, &id)?;
    }
    // Concurrent-same-id guard (Phase 2 review Fix 3): if a download for `id`
    // is already in flight, reject immediately WITHOUT spawning or registering
    // a cancel token. This makes the one-token-per-id invariant actually hold
    // (otherwise the second call's register_cancel supersedes the first task's
    // token, leaving it un-cancellable) and prevents two tasks from racing on
    // the same `.part` file (which would corrupt the hash and fail both).
    // Re-download after Ready (no-op) or Error (retry) is still allowed.
    if let Some(code) = should_reject_download(&manager.model_state(&id)) {
        return Err(code.to_string());
    }
    let manager = Arc::clone(&manager);
    let app = app.clone();

    // Fresh per-download cancellation token, registered before spawn so a
    // racing cancel command can interrupt the fetch mid-stream. register_cancel
    // returns the previous token (if a prior download for the same id was
    // somehow still registered) — we drop it; a new download supersedes any
    // stale registration.
    let cancel = CancellationToken::new();
    manager.register_cancel(&id, cancel.clone());

    tokio::spawn(async move {
        // Build a streaming-capable reqwest client. No app-wide shared client
        // exists for asset downloads today, so construct a standard one with a
        // generous connect budget — GGUF fetches are long, low-rate streams,
        // not chatty API calls.
        let client = match reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    DownloadProgressPayload::error(&id, "model", &format!("client_build: {e}")),
                );
                let _ = manager.cancel(&id);
                return;
            }
        };
        let fetcher = HttpLlmFetcher::new(client);

        // ── Phase 1: ensure the server binary. If this can't be installed,
        //    the model is useless, so emit a binary-phase error and stop
        //    (do NOT proceed to download the GGUF against a missing binary).
        let cancel_for_binary = cancel.clone();
        let binary_result = run_phase(
            app.clone(),
            Arc::clone(&manager),
            BINARY_KEY,
            "binary",
            BINARY_KEY,
            manager.ensure_server_binary(&fetcher, &cancel_for_binary),
        )
        .await;
        match &binary_result {
            Ok(()) => {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    DownloadProgressPayload::ready(BINARY_KEY, "binary"),
                );
            }
            Err(code) => {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    DownloadProgressPayload::error(BINARY_KEY, "binary", code),
                );
                // Binary failed — model can't run. Clean up the registration
                // and stop without attempting the model download.
                let _ = manager.take_cancel(&id);
                return;
            }
        }

        // ── Phase 2: download the model GGUF. Progress is computed from
        //    on-disk bytes (`run_model_phase`), not the fetcher's callback —
        //    see that helper's doc comment for why.
        let total_bytes = llm_catalog::find(&id)
            .map(|m| m.download_size_bytes)
            .unwrap_or(0);
        let model_result = run_model_phase(
            app.clone(),
            Arc::clone(&manager),
            &id,
            total_bytes,
            manager.download_model(&id, &fetcher, &cancel),
        )
        .await;
        match &model_result {
            Ok(()) => {
                let _ = app.emit(PROGRESS_EVENT, DownloadProgressPayload::ready(&id, "model"));
            }
            Err(code) => {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    DownloadProgressPayload::error(&id, "model", code),
                );
            }
        }
        // Clean up the registration either way so a stale cancel after success
        // is a no-op (download_model already reset state on cancel/error).
        let _ = manager.take_cancel(&id);
    });

    Ok(())
}

/// Cancel an in-flight download for `id`. No-op (returns `Ok(())`) if the
/// model isn't currently downloading. The fetcher honors the token between
/// byte chunks, so cancel actually interrupts the HTTP stream (unlike the
/// embedding manager's best-effort cancel).
#[tauri::command]
pub async fn cancel_on_device_llm_download(
    id: String,
    manager: State<'_, Arc<LlmAssetManager>>,
) -> Result<(), String> {
    manager.cancel(&id)
}

/// Delete a downloaded model's GGUF + ready marker, freeing disk space.
///
/// Best-effort stops the sidecar **before** unlinking when the sidecar
/// currently holds this GGUF (Windows file-lock) — independent of generation
/// settings, because a picker swap to another on-device model leaves the
/// sidecar on the old GGUF until the next chat. Then removes files. Then
/// forgets the generation slot (same wipe as
/// [`crate::commands::ai_provider::forget_ai_generation_provider`]) only
/// when provider is `on-device-llm` AND chat model == id. Never rejects
/// with `"model_in_use"`. Uses the shared settings-db accessor; no raw SQL.
/// Emits `ai:model-removed` `{ id, kind: "llm" }` after a successful
/// delete so every catalog-hook instance can drop the id.
#[tauri::command]
pub async fn delete_on_device_llm_model(
    app: AppHandle,
    id: String,
    manager: State<'_, Arc<LlmAssetManager>>,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    server_manager: State<'_, Arc<LlamaServerManager>>,
) -> Result<(), String> {
    // Stop when the sidecar maps this GGUF, independent of settings.
    // Idempotent if already stopped. Best-effort — never fatal.
    if sidecar_holds_gguf(&server_manager.inner().state(), &id) {
        if let Err(e) = server_manager.inner().stop().await {
            log::warn!("delete_on_device_llm_model: stop sidecar failed (non-fatal): {e}");
        }
    }
    manager.remove_model(&id)?;
    {
        let conn = state.lock()?;
        forget_generation_if_llm_in_use(&conn, &registry, &id)?;
    }
    let _ = app.emit(
        "ai:model-removed",
        serde_json::json!({ "id": id, "kind": "llm" }),
    );
    Ok(())
}

/// Current `llama-server` binary install snapshot: whether the extracted
/// executable exists, plus the on-disk size of [`LlmAssetManager::binary_dir`]
/// (binary + companion dylibs/DLLs). `size_bytes` is `0` when not installed.
#[tauri::command]
pub fn on_device_llm_binary_status(
    manager: State<'_, Arc<LlmAssetManager>>,
) -> Result<OnDeviceLlmBinaryStatusPayload, String> {
    Ok(OnDeviceLlmBinaryStatusPayload {
        installed: manager.is_binary_installed(),
        size_bytes: manager.binary_dir_size_bytes(),
    })
}

/// Delete the `llama-server` install dir (binary + companions), freeing disk.
///
/// Best-effort stops the sidecar **before** unlinking when it is live
/// (`Starting` / `Ready`) — independent of the generation provider, because
/// the binary is mapped even if settings already switched to openai.
/// Then removes files. Then forgets the generation slot (same wipe as
/// [`crate::commands::ai_provider::forget_ai_generation_provider`]) only
/// when provider is `on-device-llm` (any chat model). Never rejects. Uses
/// the shared settings-db accessor; no raw SQL.
#[tauri::command]
pub async fn delete_on_device_llm_binary(
    manager: State<'_, Arc<LlmAssetManager>>,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    server_manager: State<'_, Arc<LlamaServerManager>>,
) -> Result<(), String> {
    // Stop when the sidecar is live, independent of gen provider.
    // Idempotent if already stopped. Best-effort — never fatal.
    if sidecar_is_live(&server_manager.inner().state()) {
        if let Err(e) = server_manager.inner().stop().await {
            log::warn!("delete_on_device_llm_binary: stop sidecar failed (non-fatal): {e}");
        }
    }
    manager.remove_binary()?;
    {
        let conn = state.lock()?;
        forget_generation_if_on_device_llm(&conn, &registry)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_model_in_use truth table ───────────────────────────────────────

    #[test]
    fn is_model_in_use_true_only_when_provider_and_model_both_match() {
        assert!(
            is_model_in_use("on-device-llm", "gemma-4-e4b-it", "gemma-4-e4b-it"),
            "provider + model both match -> in use"
        );
    }

    #[test]
    fn is_model_in_use_false_when_provider_differs() {
        assert!(
            !is_model_in_use("openai", "gemma-4-e4b-it", "gemma-4-e4b-it"),
            "different provider -> not in use (even if model id matches)"
        );
        assert!(
            !is_model_in_use("on-device", "gemma-4-e4b-it", "gemma-4-e4b-it"),
            "embedding on-device provider id (`on-device`) must NOT count as the LLM one"
        );
    }

    #[test]
    fn is_model_in_use_false_when_model_differs() {
        assert!(
            !is_model_in_use("on-device-llm", "gemma-4-e2b-it", "gemma-4-e4b-it"),
            "provider matches but a different model is active -> not in use"
        );
    }

    #[test]
    fn is_model_in_use_false_when_both_empty() {
        assert!(
            !is_model_in_use("", "", "gemma-4-e4b-it"),
            "unconfigured provider/model -> not in use"
        );
    }

    // ── sidecar_holds_gguf / sidecar_is_live (stop vs settings-forget) ──

    fn sidecar_ready(model_id: &str) -> ServerState {
        ServerState::Ready {
            port: 8080,
            model_id: model_id.to_string(),
        }
    }

    fn sidecar_starting(model_id: &str) -> ServerState {
        ServerState::Starting {
            model_id: model_id.to_string(),
        }
    }

    fn sidecar_failed(model_id: &str) -> ServerState {
        ServerState::Failed {
            model_id: model_id.to_string(),
            code: "start_failed".to_string(),
        }
    }

    #[test]
    fn sidecar_holds_gguf_true_for_starting_or_ready_matching_id() {
        assert!(
            sidecar_holds_gguf(&sidecar_starting("gemma-4-e4b-it"), "gemma-4-e4b-it"),
            "Starting with the same model_id holds that GGUF"
        );
        assert!(
            sidecar_holds_gguf(&sidecar_ready("gemma-4-e4b-it"), "gemma-4-e4b-it"),
            "Ready with the same model_id holds that GGUF"
        );
    }

    #[test]
    fn sidecar_holds_gguf_false_for_stopped_failed_or_other_id() {
        assert!(
            !sidecar_holds_gguf(&ServerState::Stopped, "gemma-4-e4b-it"),
            "Stopped never holds a GGUF"
        );
        assert!(
            !sidecar_holds_gguf(&sidecar_failed("gemma-4-e4b-it"), "gemma-4-e4b-it"),
            "Failed does not hold a mapped GGUF even if model_id matches"
        );
        assert!(
            !sidecar_holds_gguf(&sidecar_ready("gemma-4-e2b-it"), "gemma-4-e4b-it"),
            "Ready for a different model must not count as holding this GGUF"
        );
        assert!(
            !sidecar_holds_gguf(&sidecar_starting("gemma-4-e2b-it"), "gemma-4-e4b-it"),
            "Starting a different model must not count as holding this GGUF"
        );
    }

    #[test]
    fn sidecar_is_live_true_for_starting_or_ready() {
        assert!(
            sidecar_is_live(&sidecar_starting("any")),
            "Starting maps the binary"
        );
        assert!(
            sidecar_is_live(&sidecar_ready("any")),
            "Ready maps the binary"
        );
    }

    #[test]
    fn sidecar_is_live_false_for_stopped_or_failed() {
        assert!(
            !sidecar_is_live(&ServerState::Stopped),
            "Stopped is not live"
        );
        assert!(
            !sidecar_is_live(&sidecar_failed("any")),
            "Failed is not live (process gone)"
        );
    }

    // ── should_reject_download truth table (the concurrent-same-id guard) ──

    #[test]
    fn should_reject_download_returns_none_for_not_downloaded() {
        assert_eq!(
            should_reject_download(&DownloadState::NotDownloaded),
            None,
            "NotDownloaded -> proceed (fresh download allowed)"
        );
    }

    #[test]
    fn should_reject_download_rejects_downloading_with_already_downloading() {
        assert_eq!(
            should_reject_download(&DownloadState::Downloading { progress: 0 }),
            Some("already_downloading"),
            "Downloading{{0}} -> reject (an in-flight download owns the .part file + token)"
        );
        assert_eq!(
            should_reject_download(&DownloadState::Downloading { progress: 73 }),
            Some("already_downloading"),
            "Downloading{{73}} -> reject regardless of progress"
        );
    }

    #[test]
    fn should_reject_download_returns_none_for_ready() {
        assert_eq!(
            should_reject_download(&DownloadState::Ready),
            None,
            "Ready -> proceed (download_model short-circuits to Ready, no re-fetch)"
        );
    }

    #[test]
    fn should_reject_download_returns_none_for_error() {
        assert_eq!(
            should_reject_download(&DownloadState::Error {
                code: "download_http".to_string()
            }),
            None,
            "Error -> proceed (retry after a prior failure is allowed)"
        );
    }

    // ── build_model_infos assembly ────────────────────────────────────────

    #[test]
    fn build_model_infos_has_one_row_per_catalog_entry() {
        let infos = build_model_infos(|_| DownloadState::NotDownloaded);
        assert_eq!(
            infos.len(),
            llm_catalog::catalog().len(),
            "one info row per catalog entry"
        );
    }

    #[test]
    fn build_model_infos_ids_match_catalog() {
        let infos = build_model_infos(|_| DownloadState::NotDownloaded);
        let info_ids: Vec<&str> = infos.iter().map(|i| i.id.as_str()).collect();
        let catalog_ids: Vec<&str> = llm_catalog::catalog().iter().map(|m| m.id).collect();
        assert_eq!(info_ids, catalog_ids, "info ids must match catalog order");
    }

    #[test]
    fn build_model_infos_propagates_recommended_flag() {
        let infos = build_model_infos(|_| DownloadState::NotDownloaded);
        let recommended: Vec<&OnDeviceLlmModelInfo> =
            infos.iter().filter(|i| i.recommended).collect();
        assert_eq!(recommended.len(), 1, "exactly one recommended entry");
        assert_eq!(recommended[0].id, llm_catalog::GEMMA_4_E4B_IT);
    }

    #[test]
    fn build_model_infos_threads_state_per_id() {
        // The closure must be called per-id with the catalog id, and the
        // returned state must land on the right row.
        let infos = build_model_infos(|id| {
            if id == llm_catalog::GEMMA_4_E4B_IT {
                DownloadState::Ready
            } else if id == llm_catalog::GEMMA_4_E2B_IT {
                DownloadState::Downloading { progress: 42 }
            } else {
                DownloadState::NotDownloaded
            }
        });
        let by_id: std::collections::HashMap<&str, &OnDeviceLlmModelInfo> =
            infos.iter().map(|i| (i.id.as_str(), i)).collect();
        assert_eq!(
            by_id[llm_catalog::GEMMA_4_E4B_IT].download_state,
            DownloadState::Ready
        );
        assert_eq!(
            by_id[llm_catalog::GEMMA_4_E2B_IT].download_state,
            DownloadState::Downloading { progress: 42 }
        );
        assert_eq!(
            by_id[llm_catalog::GEMMA_4_12B_IT].download_state,
            DownloadState::NotDownloaded
        );
    }

    #[test]
    fn build_model_infos_carries_terms_fields() {
        let infos = build_model_infos(|_| DownloadState::NotDownloaded);
        assert!(!infos.is_empty(), "catalog must expose at least one model");
        for info in &infos {
            assert_eq!(info.terms_url, "https://ai.google.dev/gemma/terms");
            assert!(
                info.requires_acceptance,
                "{} must require acceptance",
                info.id
            );
        }
    }

    fn terms_test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        crate::db::schema::migrate(&conn).expect("migrate");
        conn
    }

    #[test]
    fn download_rejects_without_terms_receipt() {
        let conn = terms_test_conn();
        let err = require_terms_acceptance(&conn, llm_catalog::GEMMA_4_E4B_IT)
            .expect_err("missing receipt must reject");
        assert_eq!(err, "terms_not_accepted");
    }

    #[test]
    fn download_rejects_empty_terms_receipt() {
        let conn = terms_test_conn();
        crate::db::set_setting(&conn, ON_DEVICE_LLM_TERMS_ACCEPTED_AT, "   ").unwrap();
        let err = require_terms_acceptance(&conn, llm_catalog::GEMMA_4_E4B_IT)
            .expect_err("blank receipt must reject");
        assert_eq!(err, "terms_not_accepted");
    }

    #[test]
    fn download_passes_with_terms_receipt() {
        let conn = terms_test_conn();
        crate::db::set_setting(
            &conn,
            ON_DEVICE_LLM_TERMS_ACCEPTED_AT,
            "2026-08-24T00:00:00Z",
        )
        .unwrap();
        require_terms_acceptance(&conn, llm_catalog::GEMMA_4_E4B_IT)
            .expect("receipt present must allow download");
    }

    #[test]
    fn terms_receipt_setting_is_not_syncable() {
        assert!(
            !crate::db::is_syncable_setting(ON_DEVICE_LLM_TERMS_ACCEPTED_AT),
            "Gemma ToU receipt must stay device-local"
        );
    }

    // ── DownloadProgressPayload serialization shape ───────────────────────

    #[test]
    fn downloading_payload_serializes_with_expected_keys() {
        let p = DownloadProgressPayload::downloading("gemma-4-e4b-it", "model", 73);
        let v = serde_json::to_value(&p).unwrap();
        let obj = v.as_object().unwrap();
        // camelCase keys
        assert_eq!(obj["id"], "gemma-4-e4b-it");
        assert_eq!(obj["phase"], "model");
        assert_eq!(obj["state"], "downloading");
        assert_eq!(obj["progress"], 73);
        assert!(
            obj.get("code").is_none() || obj["code"].is_null(),
            "downloading payload must not carry a code"
        );
    }

    #[test]
    fn ready_payload_has_no_progress_or_code() {
        let p = DownloadProgressPayload::ready("_server_binary", "binary");
        let v = serde_json::to_value(&p).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj["id"], "_server_binary");
        assert_eq!(obj["phase"], "binary");
        assert_eq!(obj["state"], "ready");
        assert!(
            obj.get("progress").is_none() || obj["progress"].is_null(),
            "ready payload must not carry progress"
        );
        assert!(
            obj.get("code").is_none() || obj["code"].is_null(),
            "ready payload must not carry a code"
        );
    }

    #[test]
    fn error_payload_carries_code_and_no_progress() {
        let p = DownloadProgressPayload::error("gemma-4-e4b-it", "model", "download_io");
        let v = serde_json::to_value(&p).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj["state"], "error");
        assert_eq!(obj["code"], "download_io");
        assert!(
            obj.get("progress").is_none() || obj["progress"].is_null(),
            "error payload must not carry progress"
        );
    }

    #[test]
    fn downloading_payload_for_binary_phase_uses_binary_key_id() {
        let p = DownloadProgressPayload::downloading(BINARY_KEY, "binary", 10);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["id"], BINARY_KEY);
        assert_eq!(v["phase"], "binary");
    }

    // ── DownloadState serializes with the tag shape the frontend expects ──

    #[test]
    fn download_state_serializes_with_status_tag() {
        let v = serde_json::to_value(DownloadState::NotDownloaded).unwrap();
        assert_eq!(v["status"], "not_downloaded");

        let v = serde_json::to_value(DownloadState::Ready).unwrap();
        assert_eq!(v["status"], "ready");

        let v = serde_json::to_value(DownloadState::Downloading { progress: 55 }).unwrap();
        assert_eq!(v["status"], "downloading");
        assert_eq!(v["progress"], 55);

        let v = serde_json::to_value(DownloadState::Error {
            code: "download_io".to_string(),
        })
        .unwrap();
        assert_eq!(v["status"], "error");
        assert_eq!(v["code"], "download_io");
    }

    // ── teardown-on-delete (in-use forgets gen slot; not-in-use leaves it) ─

    fn llm_delete_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        crate::db::schema::migrate(&conn).expect("migrate");
        conn
    }

    fn seed_ready_llm_model(manager: &LlmAssetManager, id: &str) {
        let dir = manager.model_dir(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(manager.model_gguf_path(id), b"dummy-gguf").unwrap();
        std::fs::write(dir.join(".llm_ready"), b"1").unwrap();
        assert!(
            manager.is_model_downloaded(id),
            "seed must produce a ready marker"
        );
    }

    #[test]
    fn in_use_delete_clears_gen_settings_and_deletes_files() {
        use crate::ai::provider_registry::ProviderRegistry;
        use crate::ai::providers::testing::MockAIProvider;
        use std::cell::Cell;
        use std::sync::Arc;

        let conn = llm_delete_conn();
        let id = llm_catalog::GEMMA_4_E4B_IT;
        crate::db::set_setting(
            &conn,
            settings_keys::gen::PROVIDER,
            ON_DEVICE_LLM_PROVIDER_ID,
        )
        .unwrap();
        crate::db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, id).unwrap();
        crate::db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
        crate::db::set_setting(
            &conn,
            settings_keys::embed::EMBEDDING_MODEL,
            "text-embedding-3-small",
        )
        .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        seed_ready_llm_model(&manager, id);

        let registry = ProviderRegistry::default();
        let mock: Arc<dyn crate::ai::provider::AIProvider> =
            Arc::new(MockAIProvider::new(ON_DEVICE_LLM_PROVIDER_ID, id));
        registry.swap_generation(mock);
        assert!(registry.is_generation_configured());

        let stopped = Cell::new(false);
        teardown_and_remove_llm_model(&conn, id, &registry, &manager, &sidecar_ready(id), || {
            stopped.set(true);
            Ok(())
        })
        .expect("in-use delete must succeed, not return model_in_use");

        assert!(
            stopped.get(),
            "sidecar must be stopped before remove when it holds this GGUF"
        );
        assert!(
            crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .is_none(),
            "in-use delete must forget ai_gen_provider"
        );
        assert!(
            crate::db::get_setting(&conn, settings_keys::gen::CHAT_MODEL)
                .unwrap()
                .is_none(),
            "in-use delete must forget ai_gen_chat_model"
        );
        assert!(
            !registry.is_generation_configured(),
            "in-use delete must clear the generation registry slot"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::embed::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai"),
            "embed slot must be left alone"
        );
        assert!(
            !manager.is_model_downloaded(id),
            "GGUF + ready marker must be gone"
        );
        assert!(!manager.model_dir(id).exists(), "model dir must be gone");
        assert_eq!(manager.model_state(id), DownloadState::NotDownloaded);
    }

    #[test]
    fn not_in_use_delete_leaves_gen_settings_and_still_deletes_files() {
        use crate::ai::provider_registry::ProviderRegistry;
        use crate::ai::providers::testing::MockAIProvider;
        use std::cell::Cell;
        use std::sync::Arc;

        let conn = llm_delete_conn();
        let id = llm_catalog::GEMMA_4_E2B_IT;
        crate::db::set_setting(&conn, settings_keys::gen::PROVIDER, "openai").unwrap();
        crate::db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, "gpt-4o-mini").unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        seed_ready_llm_model(&manager, id);

        let registry = ProviderRegistry::default();
        let mock: Arc<dyn crate::ai::provider::AIProvider> =
            Arc::new(MockAIProvider::new("openai", "gpt-4o-mini"));
        registry.swap_generation(mock);

        let stopped = Cell::new(false);
        teardown_and_remove_llm_model(
            &conn,
            id,
            &registry,
            &manager,
            &ServerState::Stopped,
            || {
                stopped.set(true);
                Ok(())
            },
        )
        .expect("not-in-use delete must succeed");

        assert!(
            !stopped.get(),
            "sidecar must not be stopped when it is already Stopped (settings not in use is independent)"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai"),
            "not-in-use delete must leave ai_gen_provider"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::gen::CHAT_MODEL)
                .unwrap()
                .as_deref(),
            Some("gpt-4o-mini"),
            "not-in-use delete must leave ai_gen_chat_model"
        );
        assert!(
            registry.is_generation_configured(),
            "not-in-use delete must leave the generation registry slot"
        );
        assert!(
            !manager.is_model_downloaded(id),
            "files must still be deleted when the model is not in use"
        );
        assert!(!manager.model_dir(id).exists());
    }

    #[test]
    fn in_use_stop_failure_is_non_fatal_and_files_still_go() {
        use crate::ai::provider_registry::ProviderRegistry;

        let conn = llm_delete_conn();
        let id = llm_catalog::GEMMA_4_12B_IT;
        crate::db::set_setting(
            &conn,
            settings_keys::gen::PROVIDER,
            ON_DEVICE_LLM_PROVIDER_ID,
        )
        .unwrap();
        crate::db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, id).unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        seed_ready_llm_model(&manager, id);
        let registry = ProviderRegistry::default();

        teardown_and_remove_llm_model(&conn, id, &registry, &manager, &sidecar_ready(id), || {
            Err("sidecar_busy".into())
        })
        .expect("stop failure must not fail the delete");

        assert!(crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
            .unwrap()
            .is_none());
        assert!(!manager.is_model_downloaded(id));
    }

    // ── binary status + teardown-on-delete ────────────────────────────────

    fn seed_dummy_binary(manager: &LlmAssetManager) {
        let dir = manager.binary_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(manager.binary_path(), b"dummy-llama-server").unwrap();
        std::fs::write(dir.join("companion.dll"), b"lib").unwrap();
        assert!(
            manager.is_binary_installed(),
            "seed must produce an installed binary"
        );
    }

    #[test]
    fn binary_status_payload_serializes_snake_case() {
        let p = OnDeviceLlmBinaryStatusPayload {
            installed: true,
            size_bytes: 42,
        };
        let v = serde_json::to_value(&p).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj["installed"], true);
        assert_eq!(obj["size_bytes"], 42);
        assert!(
            !obj.contains_key("sizeBytes"),
            "wire keys must stay snake_case"
        );
    }

    #[test]
    fn on_device_llm_provider_binary_delete_clears_gen_and_files() {
        use crate::ai::provider_registry::ProviderRegistry;
        use crate::ai::providers::testing::MockAIProvider;
        use std::cell::Cell;
        use std::sync::Arc;

        let conn = llm_delete_conn();
        crate::db::set_setting(
            &conn,
            settings_keys::gen::PROVIDER,
            ON_DEVICE_LLM_PROVIDER_ID,
        )
        .unwrap();
        crate::db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, "any-chat-model").unwrap();
        crate::db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        seed_dummy_binary(&manager);

        let registry = ProviderRegistry::default();
        let mock: Arc<dyn crate::ai::provider::AIProvider> = Arc::new(MockAIProvider::new(
            ON_DEVICE_LLM_PROVIDER_ID,
            "any-chat-model",
        ));
        registry.swap_generation(mock);
        assert!(registry.is_generation_configured());

        let stopped = Cell::new(false);
        teardown_and_remove_llm_binary(
            &conn,
            &registry,
            &manager,
            &sidecar_ready("any-chat-model"),
            || {
                stopped.set(true);
                Ok(())
            },
        )
        .expect("in-use binary delete must succeed, never reject");

        assert!(
            stopped.get(),
            "sidecar must be stopped before remove when it is live"
        );
        assert!(
            crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .is_none(),
            "on-device-llm binary delete must forget ai_gen_provider"
        );
        assert!(
            crate::db::get_setting(&conn, settings_keys::gen::CHAT_MODEL)
                .unwrap()
                .is_none(),
            "on-device-llm binary delete must forget ai_gen_chat_model"
        );
        assert!(
            !registry.is_generation_configured(),
            "on-device-llm binary delete must clear the generation registry slot"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::embed::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai"),
            "embed slot must be left alone"
        );
        assert!(!manager.is_binary_installed(), "binary must be gone");
        assert!(
            !manager.binary_dir().exists(),
            "whole binary_dir (companions included) must be gone"
        );
    }

    #[test]
    fn openai_gen_binary_delete_leaves_gen_and_still_deletes_files() {
        use crate::ai::provider_registry::ProviderRegistry;
        use crate::ai::providers::testing::MockAIProvider;
        use std::cell::Cell;
        use std::sync::Arc;

        let conn = llm_delete_conn();
        crate::db::set_setting(&conn, settings_keys::gen::PROVIDER, "openai").unwrap();
        crate::db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, "gpt-4o-mini").unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        seed_dummy_binary(&manager);

        let registry = ProviderRegistry::default();
        let mock: Arc<dyn crate::ai::provider::AIProvider> =
            Arc::new(MockAIProvider::new("openai", "gpt-4o-mini"));
        registry.swap_generation(mock);

        let stopped = Cell::new(false);
        teardown_and_remove_llm_binary(&conn, &registry, &manager, &ServerState::Stopped, || {
            stopped.set(true);
            Ok(())
        })
        .expect("not-in-use binary delete must succeed");

        assert!(
            !stopped.get(),
            "sidecar must not be stopped when it is already Stopped (openai gen is independent)"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai"),
            "openai gen must be left alone"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::gen::CHAT_MODEL)
                .unwrap()
                .as_deref(),
            Some("gpt-4o-mini"),
            "openai chat model must be left alone"
        );
        assert!(
            registry.is_generation_configured(),
            "openai gen registry slot must be left alone"
        );
        assert!(
            !manager.is_binary_installed(),
            "files must still be deleted when gen is not on-device-llm"
        );
        assert!(!manager.binary_dir().exists());
    }

    #[test]
    fn empty_gen_binary_delete_does_not_forget() {
        use crate::ai::provider_registry::ProviderRegistry;
        use std::cell::Cell;

        let conn = llm_delete_conn();
        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        seed_dummy_binary(&manager);
        let registry = ProviderRegistry::default();

        let stopped = Cell::new(false);
        teardown_and_remove_llm_binary(&conn, &registry, &manager, &ServerState::Stopped, || {
            stopped.set(true);
            Ok(())
        })
        .expect("empty gen binary delete must succeed");

        assert!(
            !stopped.get(),
            "sidecar must not be stopped when it is already Stopped (empty gen is independent)"
        );
        assert!(
            crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .is_none(),
            "empty gen stays empty"
        );
        assert!(!manager.is_binary_installed());
    }

    #[test]
    fn missing_binary_dir_delete_is_ok() {
        use crate::ai::provider_registry::ProviderRegistry;

        let conn = llm_delete_conn();
        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        assert!(!manager.binary_dir().exists());
        let registry = ProviderRegistry::default();

        teardown_and_remove_llm_binary(&conn, &registry, &manager, &ServerState::Stopped, || {
            panic!("stop must not run when sidecar is Stopped");
        })
        .expect("missing binary dir must be Ok");
    }

    #[test]
    fn different_on_device_llm_model_remove_leaves_active_slot_but_stops_held_gguf() {
        use crate::ai::provider_registry::ProviderRegistry;
        use crate::ai::providers::testing::MockAIProvider;
        use std::cell::Cell;
        use std::sync::Arc;

        let conn = llm_delete_conn();
        let active = llm_catalog::GEMMA_4_E4B_IT;
        let other = llm_catalog::GEMMA_4_E2B_IT;
        crate::db::set_setting(
            &conn,
            settings_keys::gen::PROVIDER,
            ON_DEVICE_LLM_PROVIDER_ID,
        )
        .unwrap();
        crate::db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, active).unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        seed_ready_llm_model(&manager, other);

        let registry = ProviderRegistry::default();
        let mock: Arc<dyn crate::ai::provider::AIProvider> =
            Arc::new(MockAIProvider::new(ON_DEVICE_LLM_PROVIDER_ID, active));
        registry.swap_generation(mock);

        let stopped = Cell::new(false);
        teardown_and_remove_llm_model(
            &conn,
            other,
            &registry,
            &manager,
            &sidecar_ready(other),
            || {
                stopped.set(true);
                Ok(())
            },
        )
        .expect("removing a non-active on-device model must succeed");

        assert!(
            stopped.get(),
            "sidecar holding GGUF A must be stopped even when settings point at B"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .as_deref(),
            Some(ON_DEVICE_LLM_PROVIDER_ID),
            "gen provider must stay on-device-llm when deleting a different model"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::gen::CHAT_MODEL)
                .unwrap()
                .as_deref(),
            Some(active),
            "active chat model B must be left alone when deleting A"
        );
        assert!(
            registry.is_generation_configured(),
            "generation registry slot must stay configured for B"
        );
        assert!(!manager.is_model_downloaded(other));
    }

    #[test]
    fn openai_gen_binary_delete_still_stops_live_sidecar() {
        use crate::ai::provider_registry::ProviderRegistry;
        use crate::ai::providers::testing::MockAIProvider;
        use std::cell::Cell;
        use std::sync::Arc;

        let conn = llm_delete_conn();
        crate::db::set_setting(&conn, settings_keys::gen::PROVIDER, "openai").unwrap();
        crate::db::set_setting(&conn, settings_keys::gen::CHAT_MODEL, "gpt-4o-mini").unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        seed_dummy_binary(&manager);

        let registry = ProviderRegistry::default();
        let mock: Arc<dyn crate::ai::provider::AIProvider> =
            Arc::new(MockAIProvider::new("openai", "gpt-4o-mini"));
        registry.swap_generation(mock);

        let stopped = Cell::new(false);
        teardown_and_remove_llm_binary(
            &conn,
            &registry,
            &manager,
            &sidecar_ready("gemma-4-e4b-it"),
            || {
                stopped.set(true);
                Ok(())
            },
        )
        .expect("binary delete with openai gen must succeed");

        assert!(
            stopped.get(),
            "live sidecar must be stopped when deleting the binary, even if gen is openai"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .as_deref(),
            Some("openai"),
            "openai gen must be left alone"
        );
        assert_eq!(
            crate::db::get_setting(&conn, settings_keys::gen::CHAT_MODEL)
                .unwrap()
                .as_deref(),
            Some("gpt-4o-mini"),
            "openai chat model must be left alone"
        );
        assert!(
            registry.is_generation_configured(),
            "openai gen registry slot must be left alone"
        );
        assert!(!manager.is_binary_installed());
    }

    #[test]
    fn empty_settings_retry_still_stops_sidecar_holding_gguf() {
        use crate::ai::provider_registry::ProviderRegistry;
        use std::cell::Cell;

        let conn = llm_delete_conn();
        let id = llm_catalog::GEMMA_4_E4B_IT;
        assert!(
            crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .is_none(),
            "retry path: gen slot already empty"
        );

        let tmp = tempfile::tempdir().unwrap();
        let manager = LlmAssetManager::new(tmp.path().to_path_buf());
        seed_ready_llm_model(&manager, id);
        let registry = ProviderRegistry::default();

        let stopped = Cell::new(false);
        teardown_and_remove_llm_model(&conn, id, &registry, &manager, &sidecar_ready(id), || {
            stopped.set(true);
            Ok(())
        })
        .expect("retry delete with empty settings must still succeed");

        assert!(
            stopped.get(),
            "retry must still stop the sidecar that holds GGUF A even when settings are already empty"
        );
        assert!(
            crate::db::get_setting(&conn, settings_keys::gen::PROVIDER)
                .unwrap()
                .is_none(),
            "empty gen stays empty"
        );
        assert!(!manager.is_model_downloaded(id));
        assert!(!manager.model_dir(id).exists());
    }
}
