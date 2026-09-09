//! Embedding sync decision IPC + worker helpers (entry + memory slots).
//!
//! Device-local receipts live in [`crate::ai::embedding_decision`]. This
//! module exposes:
//! - `get_embedding_sync_decisions` / `resolve_embedding_sync_decision`
//! - missing-key stamp helpers used by entry/memory workers
//! - `ai:embedding-decision-needed` emit (debounced by payload fingerprint)

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::ai::embedding_decision::{
    clear_decision_on_slot_identity_change, read_embed_sync_decision, stamp_pending_if_needed,
    write_embed_sync_decision, EmbedSyncDecision, EmbedSyncDecisionReason, EmbedSyncDecisionState,
    EmbedSyncSlot, PeerModelCount,
};
use crate::ai::on_device::download::DownloadManager;
use crate::ai::provider::settings_keys;
use crate::ai::provider_registry::ProviderRegistry;
use crate::commands::ai::BackfillManager;
use crate::commands::ai_provider::{
    configured_embedding_model_id, configured_memory_embedding_model_id, slot_provider_class,
    AIEmbedProviderConfigInput,
};
use crate::commands::ai_settings::{
    embed_slot_has_resolvable_key, memory_embed_slot_has_resolvable_key,
    MemoryEmbedProviderConfigInput,
};
use crate::db;
use crate::AppState;
use std::sync::Arc;

/// Tauri event name when one or more slots need a user decision.
pub const EMBEDDING_DECISION_NEEDED_EVENT: &str = "ai:embedding-decision-needed";

/// Last emitted payload fingerprint — avoids spamming every worker tick
/// when the decision is already pending with unchanged peer_models/counts.
static LAST_DECISION_EMIT_FINGERPRINT: Mutex<Option<String>> = Mutex::new(None);

// ─── Wire types (camelCase for FE) ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerModelCountView {
    pub model_id: String,
    pub count: u64,
}

impl From<&PeerModelCount> for PeerModelCountView {
    fn from(p: &PeerModelCount) -> Self {
        Self {
            model_id: p.model_id.clone(),
            count: p.count,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbedSyncDecisionSlotView {
    pub slot: String,
    pub state: EmbedSyncDecisionState,
    pub reason: Option<EmbedSyncDecisionReason>,
    pub local_model_id: Option<String>,
    pub peer_models: Vec<PeerModelCountView>,
    pub pending_units: u64,
    /// `true` when the FE should surface the blocking modal for this slot.
    pub needs_modal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingSyncDecisionsResponse {
    pub slots: Vec<EmbedSyncDecisionSlotView>,
    /// Convenience: any slot has `needs_modal`.
    pub needs_modal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingDecisionNeededEvent {
    pub slots: Vec<EmbedSyncDecisionSlotView>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveEmbeddingSyncDecisionArgs {
    /// `"entry"` | `"memory"`
    pub slot: String,
    /// `"reembed"` | `"switch"` | `"pause"`
    pub action: String,
    /// Required for `switch` — `provider:model` form.
    #[serde(default)]
    pub target_model_id: Option<String>,
    /// Modal Pause sends `sync_backfill` explicitly. Absent / unknown →
    /// `all` (match persist: old Pause gated every auto-index path).
    #[serde(default)]
    pub pause_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveEmbeddingSyncDecisionResult {
    pub ok: bool,
    pub next_state: EmbedSyncDecisionState,
    pub needs_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn slot_from_str(s: &str) -> Result<EmbedSyncSlot, String> {
    match s {
        "entry" => Ok(EmbedSyncSlot::Entry),
        "memory" => Ok(EmbedSyncSlot::Memory),
        other => Err(format!("unknown embed sync slot: {other}")),
    }
}

fn slot_label(slot: EmbedSyncSlot) -> &'static str {
    match slot {
        EmbedSyncSlot::Entry => "entry",
        EmbedSyncSlot::Memory => "memory",
    }
}

fn decision_to_view(slot: EmbedSyncSlot, d: &EmbedSyncDecision) -> EmbedSyncDecisionSlotView {
    // Pending blocks until resolve; Pause keeps the chip so the user can
    // re-open the modal. `switch` is transient (in-flight resolve only).
    let needs_modal = matches!(
        d.state,
        EmbedSyncDecisionState::Pending | EmbedSyncDecisionState::Pause
    );
    EmbedSyncDecisionSlotView {
        slot: slot_label(slot).to_string(),
        state: d.state,
        reason: d.reason,
        local_model_id: d.local_model_id.clone(),
        peer_models: d.peer_models.iter().map(PeerModelCountView::from).collect(),
        pending_units: d.pending_units,
        needs_modal,
    }
}

fn read_slot_view(
    conn: &Connection,
    slot: EmbedSyncSlot,
) -> Result<EmbedSyncDecisionSlotView, String> {
    let d = read_embed_sync_decision(conn, slot)?;
    Ok(decision_to_view(slot, &d))
}

/// Pure-DB snapshot of both slots for IPC / emit.
pub(crate) fn collect_decision_views(
    conn: &Connection,
) -> Result<EmbeddingSyncDecisionsResponse, String> {
    let entry = read_slot_view(conn, EmbedSyncSlot::Entry)?;
    let memory = read_slot_view(conn, EmbedSyncSlot::Memory)?;
    let needs_modal = entry.needs_modal || memory.needs_modal;
    Ok(EmbeddingSyncDecisionsResponse {
        slots: vec![entry, memory],
        needs_modal,
    })
}

/// Slots that currently need user attention (pending or pause).
fn slots_needing_attention(conn: &Connection) -> Result<Vec<EmbedSyncDecisionSlotView>, String> {
    let resp = collect_decision_views(conn)?;
    Ok(resp.slots.into_iter().filter(|s| s.needs_modal).collect())
}

/// Emit `ai:embedding-decision-needed` when at least one slot needs a
/// decision and the payload fingerprint changed since the last emit.
pub fn emit_embedding_decision_needed_if_changed(app: &AppHandle, conn: &Connection) {
    let slots = match slots_needing_attention(conn) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[ai] embed decision emit: read failed: {e}");
            return;
        }
    };
    if slots.is_empty() {
        return;
    }
    let fingerprint = match serde_json::to_string(&slots) {
        Ok(s) => s,
        Err(_) => return,
    };
    {
        let mut last = match LAST_DECISION_EMIT_FINGERPRINT.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if last.as_ref() == Some(&fingerprint) {
            return;
        }
        *last = Some(fingerprint);
    }
    let payload = EmbeddingDecisionNeededEvent { slots };
    if let Err(e) = app.emit(EMBEDDING_DECISION_NEEDED_EVENT, &payload) {
        log::warn!("[ai] failed to emit {EMBEDDING_DECISION_NEEDED_EVENT}: {e}");
    }
}

/// After a sync cycle (or auth stamp), re-read decisions and emit if needed.
pub fn emit_embedding_decisions_after_sync(app: &AppHandle, state: &AppState) {
    let _ = state.with_conn(|conn| {
        emit_embedding_decision_needed_if_changed(app, conn);
        Ok(())
    });
}

/// Stamp `pending` + `missing_key` for the entry slot when Remote has no
/// resolvable key and there is (or will be) index work. Cheap no-op when
/// the slot is not Remote or already has a key.
pub(crate) fn maybe_stamp_entry_missing_key(conn: &Connection) {
    let class = match slot_provider_class(conn, settings_keys::embed::PROVIDER) {
        Ok(c) => c,
        Err(_) => return,
    };
    if class != Some(crate::ai::provider::EndpointClass::Remote) {
        return;
    }
    if embed_slot_has_resolvable_key(conn) {
        return;
    }
    // Only stamp when the master toggle is on (user wants indexing) or
    // unfinished jobs already exist for the active model.
    let master_on = db::get_setting(conn, settings_keys::BACKGROUND_INDEXING_ENABLED)
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    let model_id = match configured_embedding_model_id(conn) {
        Some(m) => m,
        None => return,
    };
    let has_work = db::embeddings::list_entries_needing_index(conn, &model_id, 1, false)
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !master_on && !has_work {
        return;
    }
    let now = chrono::Utc::now().timestamp();
    let _ = stamp_pending_if_needed(
        conn,
        EmbedSyncSlot::Entry,
        EmbedSyncDecisionReason::MissingKey,
        Some(&model_id),
        vec![],
        0,
        now,
    );
}

/// Memory-slot sibling of [`maybe_stamp_entry_missing_key`].
pub(crate) fn maybe_stamp_memory_missing_key(conn: &Connection) {
    let class = match slot_provider_class(conn, settings_keys::memory_embed::PROVIDER) {
        Ok(c) => c,
        Err(_) => return,
    };
    if class != Some(crate::ai::provider::EndpointClass::Remote) {
        return;
    }
    if memory_embed_slot_has_resolvable_key(conn) {
        return;
    }
    let model_id = match configured_memory_embedding_model_id(conn) {
        Some(m) => m,
        None => return,
    };
    let missing = db::memory::list_memory_ids_missing_embedding_for_model(conn, &model_id)
        .map(|v| v.len() as u64)
        .unwrap_or(0);
    if missing == 0 {
        return;
    }
    let now = chrono::Utc::now().timestamp();
    let _ = stamp_pending_if_needed(
        conn,
        EmbedSyncSlot::Memory,
        EmbedSyncDecisionReason::MissingKey,
        Some(&model_id),
        vec![],
        missing,
        now,
    );
}

/// Stamp `invalid_key` after an auth/config pause and emit once if changed.
pub(crate) fn stamp_entry_invalid_key_and_emit(app: &AppHandle, state: &AppState) {
    let _ = state.with_conn(|conn| {
        let model_id = configured_embedding_model_id(conn);
        let now = chrono::Utc::now().timestamp();
        stamp_pending_if_needed(
            conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::InvalidKey,
            model_id.as_deref(),
            vec![],
            0,
            now,
        )?;
        emit_embedding_decision_needed_if_changed(app, conn);
        Ok(())
    });
}

// ─── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_embedding_sync_decisions(
    state: State<'_, AppState>,
) -> Result<EmbeddingSyncDecisionsResponse, String> {
    state.with_conn(|conn| collect_decision_views(conn))
}

#[tauri::command]
pub async fn resolve_embedding_sync_decision(
    args: ResolveEmbeddingSyncDecisionArgs,
    app: AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    indexer: State<'_, crate::ai::indexer::EntryIndexer>,
    backfill: State<'_, BackfillManager>,
    downloads: State<'_, Arc<DownloadManager>>,
) -> Result<ResolveEmbeddingSyncDecisionResult, String> {
    let slot = slot_from_str(&args.slot)?;
    match args.action.as_str() {
        "reembed" => resolve_reembed(slot, &app, &state).await,
        "pause" => resolve_pause(
            slot,
            &state,
            &backfill,
            parse_modal_pause_scope(args.pause_scope.as_deref()),
        ),
        "switch" => {
            let target = args
                .target_model_id
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| "targetModelId required for switch".to_string())?;
            resolve_switch(
                slot, target, app, state, registry, indexer, backfill, downloads,
            )
            .await
        }
        other => Ok(ResolveEmbeddingSyncDecisionResult {
            ok: false,
            next_state: EmbedSyncDecisionState::None,
            needs_key: false,
            error: Some(format!("unknown action: {other}")),
        }),
    }
}

async fn resolve_reembed(
    slot: EmbedSyncSlot,
    app: &AppHandle,
    state: &AppState,
) -> Result<ResolveEmbeddingSyncDecisionResult, String> {
    let now = chrono::Utc::now().timestamp();
    state.with_conn(|conn| {
        let mut d = read_embed_sync_decision(conn, slot)?;
        d.state = EmbedSyncDecisionState::Reembed;
        d.decided_at = now;
        d.updated_at = now;
        write_embed_sync_decision(conn, slot, &d)?;
        // Unstick auth-paused entry jobs so the worker can drain after reembed.
        if slot == EmbedSyncSlot::Entry {
            if let Some(model_id) = configured_embedding_model_id(conn) {
                let _ = db::embeddings::reset_paused_jobs_to_pending(conn, &model_id, now, now);
            }
        }
        Ok(())
    })?;
    match slot {
        EmbedSyncSlot::Entry => {
            crate::commands::ai::start_indexing_worker(app.clone());
        }
        EmbedSyncSlot::Memory => {
            crate::commands::ai_memory::nudge_memory_worker();
        }
    }
    Ok(ResolveEmbeddingSyncDecisionResult {
        ok: true,
        next_state: EmbedSyncDecisionState::Reembed,
        needs_key: false,
        error: None,
    })
}

fn parse_modal_pause_scope(raw: Option<&str>) -> crate::ai::embedding_decision::EmbedPauseScope {
    match raw {
        Some("sync_backfill") => crate::ai::embedding_decision::EmbedPauseScope::SyncBackfill,
        _ => crate::ai::embedding_decision::EmbedPauseScope::All,
    }
}

fn resolve_pause(
    slot: EmbedSyncSlot,
    state: &AppState,
    backfill: &BackfillManager,
    pause_scope: crate::ai::embedding_decision::EmbedPauseScope,
) -> Result<ResolveEmbeddingSyncDecisionResult, String> {
    let now = chrono::Utc::now().timestamp();
    state.with_conn(|conn| {
        let mut d = read_embed_sync_decision(conn, slot)?;
        d.state = EmbedSyncDecisionState::Pause;
        d.pause_scope = pause_scope;
        d.decided_at = now;
        d.updated_at = now;
        write_embed_sync_decision(conn, slot, &d)?;
        Ok(())
    })?;
    if slot == EmbedSyncSlot::Entry
        && pause_scope == crate::ai::embedding_decision::EmbedPauseScope::All
    {
        // Full pause: stop in-flight backfill. Modal Pause is
        // `sync_backfill` and leaves the worker running for local dirty.
        backfill.cancel();
    }
    Ok(ResolveEmbeddingSyncDecisionResult {
        ok: true,
        next_state: EmbedSyncDecisionState::Pause,
        needs_key: false,
        error: None,
    })
}

/// Split `provider:model` on the first colon (provider ids are colon-free
/// sentinels / slugs; model ids may contain colons in theory).
fn parse_provider_model(target_model_id: &str) -> Result<(String, String), String> {
    let (provider, model) = target_model_id
        .split_once(':')
        .ok_or_else(|| "targetModelId must be provider:model".to_string())?;
    let provider = provider.trim();
    let model = model.trim();
    if provider.is_empty() || model.is_empty() {
        return Err("targetModelId must be provider:model".into());
    }
    Ok((provider.to_string(), model.to_string()))
}

/// Whether `target` (`provider:model`) may be used for a **switch** resolve.
///
/// - When the decision already lists `peer_models` (typical model_mismatch
///   modal), the target **must** be one of those peer ids — no freeform
///   catalog diversion from a mismatch choice.
/// - When `peer_models` is empty (e.g. missing_key / invalid_key, or a
///   catalog-driven switch), allow known on-device or a well-formed
///   `preset:model` where `preset` is in [`ALL_PRESET_IDS`] and `model`
///   is non-empty. Reject empty model after the colon and unknown presets.
fn target_allowed_for_switch(
    conn: &Connection,
    slot: EmbedSyncSlot,
    target: &str,
) -> Result<bool, String> {
    let d = read_embed_sync_decision(conn, slot)?;
    if !d.peer_models.is_empty() {
        return Ok(d.peer_models.iter().any(|p| p.model_id == target));
    }
    // Catalog path — peer_models empty.
    let (provider, model) = parse_provider_model(target)?;
    if model.is_empty() {
        return Ok(false);
    }
    if provider == crate::ai::providers::on_device_embed::PROVIDER_ID {
        return Ok(true);
    }
    Ok(crate::commands::ai_provider::ALL_PRESET_IDS
        .iter()
        .any(|id| *id == provider.as_str()))
}

async fn resolve_switch(
    slot: EmbedSyncSlot,
    target_model_id: &str,
    app: AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
    indexer: State<'_, crate::ai::indexer::EntryIndexer>,
    backfill: State<'_, BackfillManager>,
    downloads: State<'_, Arc<DownloadManager>>,
) -> Result<ResolveEmbeddingSyncDecisionResult, String> {
    let (provider, embedding_model) = parse_provider_model(target_model_id)?;
    let target = format!("{provider}:{embedding_model}");

    // Validate against stamped peer_models or a known catalog/preset id.
    let allowed = state.with_conn(|conn| target_allowed_for_switch(conn, slot, &target))?;
    if !allowed {
        return Ok(ResolveEmbeddingSyncDecisionResult {
            ok: false,
            next_state: EmbedSyncDecisionState::Pending,
            needs_key: false,
            error: Some(format!("unknown switch target model: {target}")),
        });
    }

    match slot {
        EmbedSyncSlot::Entry => {
            let input = AIEmbedProviderConfigInput {
                provider: provider.clone(),
                embedding_model: embedding_model.clone(),
            };
            if let Err(e) = crate::commands::ai_provider::set_ai_embedding_provider(
                input,
                app.clone(),
                state.clone(),
                registry,
                indexer,
                backfill,
                downloads,
            )
            .await
            {
                return Ok(ResolveEmbeddingSyncDecisionResult {
                    ok: false,
                    next_state: EmbedSyncDecisionState::Pending,
                    needs_key: false,
                    error: Some(e),
                });
            }
        }
        EmbedSyncSlot::Memory => {
            let input = MemoryEmbedProviderConfigInput {
                provider: provider.clone(),
                embedding_model: embedding_model.clone(),
            };
            if let Err(e) = crate::commands::ai_settings::set_memory_embed_provider(
                input,
                state.clone(),
                registry,
                downloads,
            )
            .await
            {
                return Ok(ResolveEmbeddingSyncDecisionResult {
                    ok: false,
                    next_state: EmbedSyncDecisionState::Pending,
                    needs_key: false,
                    error: Some(e),
                });
            }
        }
    }

    // Clear receipt after successful switch (identity change also clears,
    // but same-identity edge cases and explicit resolve both need none).
    let needs_key = state.with_conn(|conn| {
        clear_decision_on_slot_identity_change(conn, slot)?;
        let needs_key = match slot {
            EmbedSyncSlot::Entry => {
                let remote = matches!(
                    slot_provider_class(conn, settings_keys::embed::PROVIDER)
                        .ok()
                        .flatten(),
                    Some(crate::ai::provider::EndpointClass::Remote)
                );
                remote && !embed_slot_has_resolvable_key(conn)
            }
            EmbedSyncSlot::Memory => {
                let remote = matches!(
                    slot_provider_class(conn, settings_keys::memory_embed::PROVIDER)
                        .ok()
                        .flatten(),
                    Some(crate::ai::provider::EndpointClass::Remote)
                );
                remote && !memory_embed_slot_has_resolvable_key(conn)
            }
        };
        if needs_key {
            let model_id = match slot {
                EmbedSyncSlot::Entry => configured_embedding_model_id(conn),
                EmbedSyncSlot::Memory => configured_memory_embedding_model_id(conn),
            };
            let now = chrono::Utc::now().timestamp();
            stamp_pending_if_needed(
                conn,
                slot,
                EmbedSyncDecisionReason::MissingKey,
                model_id.as_deref(),
                vec![],
                0,
                now,
            )?;
        }
        Ok(needs_key)
    })?;

    let next_state = if needs_key {
        EmbedSyncDecisionState::Pending
    } else {
        EmbedSyncDecisionState::None
    };

    Ok(ResolveEmbeddingSyncDecisionResult {
        ok: true,
        next_state,
        needs_key,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::embedding_decision::auto_index_allowed;
    use crate::ai::embedding_decision::{
        stamp_pending_if_needed, write_embed_sync_decision, AutoIndexScope, EmbedSyncDecision,
        EmbedSyncDecisionReason, EmbedSyncDecisionState, EmbedSyncSlot, PeerModelCount,
    };
    use crate::commands::ai_settings::{entry_embed_auto_allowed, memory_embed_auto_allowed};
    use crate::db::schema;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        schema::migrate(&conn).expect("migrate");
        conn
    }

    fn peer(model_id: &str, count: u64) -> PeerModelCount {
        PeerModelCount {
            model_id: model_id.to_string(),
            count,
        }
    }

    #[test]
    fn entry_embed_auto_blocked_when_pending_or_pause() {
        let conn = open_test_db();
        // Master + local-class path so background_indexing_allowed is true
        // when decision is none (ollama defaults local).
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::embed::EMBEDDING_MODEL, "nomic").unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();

        assert!(
            entry_embed_auto_allowed(&conn),
            "none + allowed background → auto index ok"
        );

        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("ollama:nomic"),
            vec![peer("peer:other", 2)],
            2,
            100,
        )
        .unwrap();
        assert!(
            !entry_embed_auto_allowed(&conn),
            "pending must block entry auto-index"
        );

        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Entry,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Pause,
                reason: Some(EmbedSyncDecisionReason::ModelMismatch),
                local_model_id: Some("ollama:nomic".into()),
                peer_models: vec![peer("peer:other", 2)],
                pending_units: 2,
                decided_at: 100,
                updated_at: 100,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!entry_embed_auto_allowed(&conn), "pause must block");

        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Entry,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Reembed,
                reason: Some(EmbedSyncDecisionReason::ModelMismatch),
                local_model_id: Some("ollama:nomic".into()),
                peer_models: vec![],
                pending_units: 0,
                decided_at: 200,
                updated_at: 200,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            entry_embed_auto_allowed(&conn),
            "reembed + background allowed → work proceeds"
        );
    }

    #[test]
    fn memory_embed_auto_blocked_when_pending() {
        let conn = open_test_db();
        assert!(memory_embed_auto_allowed(&conn));
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Memory,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("local:m"),
            vec![peer("peer:x", 1)],
            1,
            1,
        )
        .unwrap();
        assert!(!memory_embed_auto_allowed(&conn));
    }

    #[test]
    fn memory_embed_auto_blocked_remote_without_key_even_if_none() {
        let conn = open_test_db();
        // Remote memory embed without a resolvable key must not spend even
        // when decision is none/reembed.
        db::set_setting(&conn, settings_keys::memory_embed::PROVIDER, "openai").unwrap();
        db::set_setting(
            &conn,
            settings_keys::memory_embed::EMBEDDING_MODEL,
            "text-embedding-3-small",
        )
        .unwrap();
        assert!(
            !memory_embed_auto_allowed(&conn),
            "Remote without key → false even when decision is none"
        );
        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Memory,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Reembed,
                reason: Some(EmbedSyncDecisionReason::MissingKey),
                local_model_id: Some("openai:text-embedding-3-small".into()),
                peer_models: vec![],
                pending_units: 0,
                decided_at: 1,
                updated_at: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            !memory_embed_auto_allowed(&conn),
            "Remote without key → false even on reembed"
        );
    }

    #[test]
    fn auto_allowed_fail_closed_on_corrupt_decision_json() {
        let conn = open_test_db();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::embed::EMBEDDING_MODEL, "nomic").unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();
        db::set_setting(&conn, settings_keys::EMBED_SYNC_DECISION, "{not valid json").unwrap();
        assert!(
            !entry_embed_auto_allowed(&conn),
            "corrupt entry decision must block spend"
        );
        db::set_setting(
            &conn,
            settings_keys::MEMORY_EMBED_SYNC_DECISION,
            "{not valid json",
        )
        .unwrap();
        assert!(
            !memory_embed_auto_allowed(&conn),
            "corrupt memory decision must block spend"
        );
    }

    #[test]
    fn resolve_reembed_sets_state_and_unblocks_gate() {
        let conn = open_test_db();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::embed::EMBEDDING_MODEL, "nomic").unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("ollama:nomic"),
            vec![peer("p:m", 1)],
            1,
            10,
        )
        .unwrap();
        assert!(!entry_embed_auto_allowed(&conn));

        let now = 999i64;
        let mut d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        d.state = EmbedSyncDecisionState::Reembed;
        d.decided_at = now;
        d.updated_at = now;
        write_embed_sync_decision(&conn, EmbedSyncSlot::Entry, &d).unwrap();

        assert!(entry_embed_auto_allowed(&conn));
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::Reembed);
        assert_eq!(d.decided_at, now);
    }

    #[test]
    fn resolve_pause_blocks_gate() {
        let conn = open_test_db();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();
        let now = 50i64;
        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Entry,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Pause,
                reason: Some(EmbedSyncDecisionReason::ModelMismatch),
                local_model_id: Some("ollama:nomic".into()),
                peer_models: vec![],
                pending_units: 0,
                decided_at: now,
                updated_at: now,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!entry_embed_auto_allowed(&conn));
        assert!(!auto_index_allowed(
            &read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap(),
            AutoIndexScope::LocalDirty,
        ));
        assert!(!auto_index_allowed(
            &read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap(),
            AutoIndexScope::SyncBackfill,
        ));
    }

    #[test]
    fn switch_target_rejects_unknown_model() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("local:a"),
            vec![peer("peer:allowed", 3)],
            3,
            1,
        )
        .unwrap();
        // With peer_models present, only those ids are allowed — even a
        // known catalog preset is rejected if it was not a peer.
        assert!(
            !target_allowed_for_switch(&conn, EmbedSyncSlot::Entry, "totally-fake:model").unwrap()
        );
        assert!(
            !target_allowed_for_switch(
                &conn,
                EmbedSyncSlot::Entry,
                "openai:text-embedding-3-small"
            )
            .unwrap(),
            "catalog model must not bypass non-empty peer_models list"
        );
        assert!(target_allowed_for_switch(&conn, EmbedSyncSlot::Entry, "peer:allowed").unwrap());
    }

    #[test]
    fn switch_target_catalog_when_peer_models_empty() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::MissingKey,
            Some("openai:text-embedding-3-small"),
            vec![],
            1,
            1,
        )
        .unwrap();
        assert!(
            target_allowed_for_switch(&conn, EmbedSyncSlot::Entry, "openai:text-embedding-3-large")
                .unwrap(),
            "known preset + non-empty model ok when peer_models empty"
        );
        assert!(
            !target_allowed_for_switch(&conn, EmbedSyncSlot::Entry, "totally-fake:model").unwrap()
        );
        assert!(target_allowed_for_switch(
            &conn,
            EmbedSyncSlot::Entry,
            &format!(
                "{}:bge-small-en-v1.5",
                crate::ai::providers::on_device_embed::PROVIDER_ID
            )
        )
        .unwrap());
    }

    #[test]
    fn parse_provider_model_splits_first_colon() {
        let (p, m) = parse_provider_model("openai:text-embedding-3-small").unwrap();
        assert_eq!(p, "openai");
        assert_eq!(m, "text-embedding-3-small");
        assert!(parse_provider_model("nocolon").is_err());
        assert!(parse_provider_model(":onlymodel").is_err());
    }

    #[test]
    fn collect_decision_views_marks_pending_needs_modal() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("a:b"),
            vec![peer("c:d", 1)],
            1,
            1,
        )
        .unwrap();
        let resp = collect_decision_views(&conn).unwrap();
        assert!(resp.needs_modal);
        let entry = resp.slots.iter().find(|s| s.slot == "entry").unwrap();
        assert!(entry.needs_modal);
        assert_eq!(entry.state, EmbedSyncDecisionState::Pending);
        let memory = resp.slots.iter().find(|s| s.slot == "memory").unwrap();
        assert!(!memory.needs_modal);
    }

    #[test]
    fn slots_needing_attention_empty_when_none() {
        let conn = open_test_db();
        let slots = slots_needing_attention(&conn).unwrap();
        assert!(slots.is_empty());
    }

    #[test]
    fn stamp_invalid_key_upgrades_reason() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("m"),
            vec![peer("p", 1)],
            1,
            10,
        )
        .unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::InvalidKey,
            Some("m"),
            vec![peer("p", 1)],
            1,
            20,
        )
        .unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.reason, Some(EmbedSyncDecisionReason::InvalidKey));
    }

    // ── Scenario matrix gaps (phase 4) ────────────────────────────────────

    /// #1: peer model mismatch → pending blocks workers → reembed unblocks.
    #[test]
    fn scenario_entry_mismatch_pending_blocks_until_reembed() {
        let conn = open_test_db();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::embed::EMBEDDING_MODEL, "nomic").unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();

        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("ollama:nomic"),
            vec![peer("peer:other", 2)],
            2,
            10,
        )
        .unwrap();
        assert!(
            !entry_embed_auto_allowed(&conn),
            "pending model_mismatch must block entry_embed_auto_allowed"
        );

        let now = 50i64;
        let mut d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        d.state = EmbedSyncDecisionState::Reembed;
        d.decided_at = now;
        d.updated_at = now;
        write_embed_sync_decision(&conn, EmbedSyncSlot::Entry, &d).unwrap();

        assert!(
            entry_embed_auto_allowed(&conn),
            "reembed resolve must unblock entry auto-index"
        );
    }

    /// #3: switch target must be a stamped peer; identity clear drops receipt
    /// so the next pull can adopt under the new model.
    #[test]
    fn scenario_switch_to_peer_model_clears_decision_for_adopt() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("ollama:nomic"),
            vec![peer("prov-a:model-a", 3)],
            3,
            1,
        )
        .unwrap();
        assert!(
            target_allowed_for_switch(&conn, EmbedSyncSlot::Entry, "prov-a:model-a").unwrap(),
            "peer model from stamp must be a valid switch target"
        );
        assert!(
            !target_allowed_for_switch(&conn, EmbedSyncSlot::Entry, "prov-b:other").unwrap(),
            "non-peer model must be rejected when peer_models is non-empty"
        );

        // resolve_switch clears the receipt after a successful provider set.
        clear_decision_on_slot_identity_change(&conn, EmbedSyncSlot::Entry).unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::None);
        assert!(auto_index_allowed(&d, AutoIndexScope::LocalDirty));
        assert!(auto_index_allowed(&d, AutoIndexScope::SyncBackfill));
    }

    /// #4: pause keeps the gate blocked until a new resolve (reembed).
    #[test]
    fn scenario_pause_blocks_until_re_resolve() {
        let conn = open_test_db();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::embed::EMBEDDING_MODEL, "nomic").unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();

        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Entry,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Pause,
                reason: Some(EmbedSyncDecisionReason::ModelMismatch),
                local_model_id: Some("ollama:nomic".into()),
                peer_models: vec![peer("peer:x", 1)],
                pending_units: 1,
                decided_at: 10,
                updated_at: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!entry_embed_auto_allowed(&conn));

        // A later pull must not silently re-open work under the same model.
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("ollama:nomic"),
            vec![peer("peer:x", 9)],
            9,
            99,
        )
        .unwrap();
        let still = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(still.state, EmbedSyncDecisionState::Pause);
        assert!(!entry_embed_auto_allowed(&conn));

        let mut d = still;
        d.state = EmbedSyncDecisionState::Reembed;
        d.decided_at = 200;
        d.updated_at = 200;
        write_embed_sync_decision(&conn, EmbedSyncSlot::Entry, &d).unwrap();
        assert!(entry_embed_auto_allowed(&conn));
    }

    /// #5: Remote + missing key + pending work → stamp missing_key.
    #[test]
    fn scenario_missing_key_remote_with_work_stamps_pending() {
        let conn = open_test_db();
        // Entry: master toggle on is enough for the stamp helper even with
        // no rows — mirrors "user wants indexing" path.
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
        db::set_setting(
            &conn,
            settings_keys::embed::EMBEDDING_MODEL,
            "text-embedding-3-small",
        )
        .unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();

        maybe_stamp_entry_missing_key(&conn);
        let entry = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(entry.state, EmbedSyncDecisionState::Pending);
        assert_eq!(entry.reason, Some(EmbedSyncDecisionReason::MissingKey));
        assert!(
            !entry_embed_auto_allowed(&conn),
            "missing_key pending must block entry spend"
        );

        // Memory: needs at least one item missing a vector for the active model.
        db::set_setting(&conn, settings_keys::memory_embed::PROVIDER, "openai").unwrap();
        db::set_setting(
            &conn,
            settings_keys::memory_embed::EMBEDDING_MODEL,
            "text-embedding-3-small",
        )
        .unwrap();
        db::memory::insert_memory_item(&conn, "mem-1", "Likes tea", "daily_chat", 100).unwrap();

        maybe_stamp_memory_missing_key(&conn);
        let memory = read_embed_sync_decision(&conn, EmbedSyncSlot::Memory).unwrap();
        assert_eq!(memory.state, EmbedSyncDecisionState::Pending);
        assert_eq!(memory.reason, Some(EmbedSyncDecisionReason::MissingKey));
        assert!(memory.pending_units >= 1);
        assert!(
            !memory_embed_auto_allowed(&conn),
            "missing_key pending must block memory spend"
        );
    }

    /// #5 edge: local-class provider never stamps missing_key.
    #[test]
    fn scenario_missing_key_not_stamped_for_local_provider() {
        let conn = open_test_db();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::embed::EMBEDDING_MODEL, "nomic").unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();

        maybe_stamp_entry_missing_key(&conn);
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(
            d.state,
            EmbedSyncDecisionState::None,
            "Local provider has no API key concept — must not stamp missing_key"
        );
    }

    /// #5 edge: Remote without key and no pending work + master off → no stamp.
    #[test]
    fn scenario_missing_key_not_stamped_without_work_or_master() {
        let conn = open_test_db();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "openai").unwrap();
        db::set_setting(
            &conn,
            settings_keys::embed::EMBEDDING_MODEL,
            "text-embedding-3-small",
        )
        .unwrap();
        // Master off, no entries → maybe_stamp must no-op.
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "false").unwrap();

        maybe_stamp_entry_missing_key(&conn);
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::None);
    }

    /// #6: AuthFailed path stamps invalid_key from a clean `none` decision.
    #[test]
    fn scenario_auth_pause_stamps_invalid_key() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::InvalidKey,
            Some("openai:text-embedding-3-small"),
            vec![],
            0,
            42,
        )
        .unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::Pending);
        assert_eq!(d.reason, Some(EmbedSyncDecisionReason::InvalidKey));
        assert!(!auto_index_allowed(&d, AutoIndexScope::LocalDirty));
        assert!(!auto_index_allowed(&d, AutoIndexScope::SyncBackfill));
    }

    /// #10: dual-slot independent resolve — pause entry, reembed memory.
    #[test]
    fn scenario_dual_slot_independent_resolve() {
        let conn = open_test_db();
        db::set_setting(&conn, settings_keys::embed::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::embed::EMBEDDING_MODEL, "nomic").unwrap();
        db::set_setting(&conn, settings_keys::BACKGROUND_INDEXING_ENABLED, "true").unwrap();
        // Memory local path (no remote key gate) so reembed alone unblocks.
        db::set_setting(&conn, settings_keys::memory_embed::PROVIDER, "ollama").unwrap();
        db::set_setting(&conn, settings_keys::memory_embed::EMBEDDING_MODEL, "nomic").unwrap();

        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("ollama:nomic"),
            vec![peer("peer:e", 1)],
            1,
            10,
        )
        .unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Memory,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("ollama:nomic"),
            vec![peer("peer:m", 2)],
            2,
            10,
        )
        .unwrap();
        assert!(!entry_embed_auto_allowed(&conn));
        assert!(!memory_embed_auto_allowed(&conn));

        // Pause entry only.
        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Entry,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Pause,
                reason: Some(EmbedSyncDecisionReason::ModelMismatch),
                local_model_id: Some("ollama:nomic".into()),
                peer_models: vec![peer("peer:e", 1)],
                pending_units: 1,
                decided_at: 20,
                updated_at: 20,
                ..Default::default()
            },
        )
        .unwrap();
        // Reembed memory only.
        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Memory,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Reembed,
                reason: Some(EmbedSyncDecisionReason::ModelMismatch),
                local_model_id: Some("ollama:nomic".into()),
                peer_models: vec![],
                pending_units: 0,
                decided_at: 20,
                updated_at: 20,
                ..Default::default()
            },
        )
        .unwrap();

        assert!(
            !entry_embed_auto_allowed(&conn),
            "entry pause must stay blocked after independent memory resolve"
        );
        assert!(
            memory_embed_auto_allowed(&conn),
            "memory reembed must unblock without touching entry"
        );

        let views = collect_decision_views(&conn).unwrap();
        let entry = views.slots.iter().find(|s| s.slot == "entry").unwrap();
        let memory = views.slots.iter().find(|s| s.slot == "memory").unwrap();
        assert_eq!(entry.state, EmbedSyncDecisionState::Pause);
        assert!(entry.needs_modal);
        assert_eq!(memory.state, EmbedSyncDecisionState::Reembed);
        assert!(!memory.needs_modal);
        assert!(views.needs_modal, "entry pause keeps needs_modal true");
    }

    #[test]
    fn parse_modal_pause_scope_absent_and_unknown_are_all() {
        assert_eq!(
            parse_modal_pause_scope(None),
            crate::ai::embedding_decision::EmbedPauseScope::All,
            "absent pause_scope must match persist default (all)"
        );
        assert_eq!(
            parse_modal_pause_scope(Some("bogus")),
            crate::ai::embedding_decision::EmbedPauseScope::All,
            "unknown pause_scope must fail closed to all"
        );
        assert_eq!(
            parse_modal_pause_scope(Some("")),
            crate::ai::embedding_decision::EmbedPauseScope::All
        );
    }

    #[test]
    fn parse_modal_pause_scope_explicit_tokens() {
        assert_eq!(
            parse_modal_pause_scope(Some("all")),
            crate::ai::embedding_decision::EmbedPauseScope::All
        );
        assert_eq!(
            parse_modal_pause_scope(Some("sync_backfill")),
            crate::ai::embedding_decision::EmbedPauseScope::SyncBackfill,
            "modal Pause must still be able to write sync_backfill explicitly"
        );
    }
}
