//! Device-local embedding sync decision receipts (entry + memory slots).
//!
//! After a multi-device pull observes peer embedding `model_id` mismatches
//! (or later: missing/invalid key blocking pending work), we stamp a
//! **pending** decision so workers do not blindly re-embed until the user
//! chooses re-embed / switch model / pause. Receipts are **never** on the
//! settings sync allowlist — see `settings_keys::EMBED_SYNC_DECISION` /
//! `MEMORY_EMBED_SYNC_DECISION`.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::ai::provider::settings_keys;
use crate::db;

/// Which embedding pipeline a decision receipt belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EmbedSyncSlot {
    Entry,
    Memory,
}

impl EmbedSyncSlot {
    pub fn settings_key(self) -> &'static str {
        match self {
            Self::Entry => settings_keys::EMBED_SYNC_DECISION,
            Self::Memory => settings_keys::MEMORY_EMBED_SYNC_DECISION,
        }
    }
}

/// User / system decision state for one slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EmbedSyncDecisionState {
    #[default]
    None,
    Pending,
    Reembed,
    Switch,
    Pause,
}

/// Why the slot entered `pending` (or related blocked states).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedSyncDecisionReason {
    ModelMismatch,
    MissingKey,
    InvalidKey,
    Unconfigured,
}

/// Which auto-index enqueue path is asking the decision gate.
///
/// Jobs have no origin column, so scope is applied at the **enqueue**
/// side (`LocalDirty` = save-path / worker claim; `SyncBackfill` =
/// sync adopt / peer-mismatch requeue), not at claim time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoIndexScope {
    LocalDirty,
    SyncBackfill,
}

/// How far **Pause** reaches. Persisted-semantics change (T34, 2026-09-03):
/// optional JSON field — **absent → `all`** (old Pause gated every
/// auto-index path). No migration shim; serde `default` is the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EmbedPauseScope {
    /// Old receipts and explicit "stop everything".
    #[default]
    All,
    /// Modal Pause: block sync-origin re-embed only; new local edits keep indexing.
    SyncBackfill,
}

fn pause_scope_is_all(scope: &EmbedPauseScope) -> bool {
    matches!(scope, EmbedPauseScope::All)
}

/// One peer model observed during a pull, with how many vectors mismatched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerModelCount {
    pub model_id: String,
    pub count: u64,
}

/// JSON stored under `ai_embed_sync_decision` / `ai_memory_embed_sync_decision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbedSyncDecision {
    pub state: EmbedSyncDecisionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<EmbedSyncDecisionReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_model_id: Option<String>,
    #[serde(default)]
    pub peer_models: Vec<PeerModelCount>,
    #[serde(default)]
    pub pending_units: u64,
    #[serde(default)]
    pub decided_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// Absent on disk → [`EmbedPauseScope::All`] (see type docs).
    #[serde(default, skip_serializing_if = "pause_scope_is_all")]
    pub pause_scope: EmbedPauseScope,
}

impl Default for EmbedSyncDecision {
    fn default() -> Self {
        Self {
            state: EmbedSyncDecisionState::None,
            reason: None,
            local_model_id: None,
            peer_models: Vec::new(),
            pending_units: 0,
            decided_at: 0,
            updated_at: 0,
            pause_scope: EmbedPauseScope::All,
        }
    }
}

/// Read the receipt for `slot`. Missing key → default (`none`).
///
/// **Corrupt / unparseable JSON is an error** (fail-closed): callers that
/// gate spend (`entry_embed_auto_allowed` / `memory_embed_auto_allowed`)
/// map `Err` → block. Never silently treat garbage as `none` and burn
/// embed tokens.
pub fn read_embed_sync_decision(
    conn: &Connection,
    slot: EmbedSyncSlot,
) -> Result<EmbedSyncDecision, String> {
    let Some(raw) = db::get_setting(conn, slot.settings_key()).map_err(|e| e.to_string())? else {
        return Ok(EmbedSyncDecision::default());
    };
    serde_json::from_str::<EmbedSyncDecision>(&raw).map_err(|e| {
        format!(
            "corrupt embed sync decision JSON for {}: {e}",
            slot.settings_key()
        )
    })
}

/// Persist the receipt for `slot` (device-local settings row).
pub fn write_embed_sync_decision(
    conn: &Connection,
    slot: EmbedSyncSlot,
    decision: &EmbedSyncDecision,
) -> Result<(), String> {
    let json = serde_json::to_string(decision).map_err(|e| e.to_string())?;
    db::set_setting(conn, slot.settings_key(), &json).map_err(|e| e.to_string())
}

/// Priority for pending reasons (higher = more urgent; must not demote).
/// Key/auth issues outrank unconfigured and model mismatch so the modal
/// leads with "fix credentials" when both apply.
fn reason_priority(reason: EmbedSyncDecisionReason) -> u8 {
    match reason {
        EmbedSyncDecisionReason::InvalidKey => 4,
        EmbedSyncDecisionReason::MissingKey => 3,
        EmbedSyncDecisionReason::Unconfigured => 2,
        EmbedSyncDecisionReason::ModelMismatch => 1,
    }
}

fn merge_pending_reason(
    current: Option<EmbedSyncDecisionReason>,
    incoming: EmbedSyncDecisionReason,
) -> EmbedSyncDecisionReason {
    match current {
        None => incoming,
        Some(cur) if reason_priority(incoming) > reason_priority(cur) => incoming,
        Some(cur) => cur,
    }
}

/// Idempotently stamp (or refresh) a `pending` decision.
///
/// - `none` → write `pending` with the supplied fields.
/// - already `pending` → refresh `peer_models`, `pending_units`,
///   `local_model_id`, `updated_at` (keep `decided_at`). Reason only
///   **upgrades** by priority (key > unconfigured > model_mismatch) —
///   never demotes a more urgent reason on a later stamp.
/// - `reembed` / `switch` / `pause` → **no-op** unless `local_model_id`
///   identity changed (then re-enter `pending` for the new model).
pub fn stamp_pending_if_needed(
    conn: &Connection,
    slot: EmbedSyncSlot,
    reason: EmbedSyncDecisionReason,
    local_model_id: Option<&str>,
    peer_models: Vec<PeerModelCount>,
    pending_units: u64,
    now: i64,
) -> Result<(), String> {
    let current = read_embed_sync_decision(conn, slot)?;
    let local = local_model_id.map(|s| s.to_string());

    match current.state {
        EmbedSyncDecisionState::None | EmbedSyncDecisionState::Pending => {
            let decided_at = if current.state == EmbedSyncDecisionState::Pending {
                current.decided_at
            } else {
                0
            };
            let merged_reason = if current.state == EmbedSyncDecisionState::Pending {
                merge_pending_reason(current.reason, reason)
            } else {
                reason
            };
            write_embed_sync_decision(
                conn,
                slot,
                &EmbedSyncDecision {
                    state: EmbedSyncDecisionState::Pending,
                    reason: Some(merged_reason),
                    local_model_id: local,
                    // Latest pull's tally is authoritative for this pass.
                    peer_models,
                    pending_units,
                    decided_at,
                    updated_at: now,
                    pause_scope: EmbedPauseScope::All,
                },
            )
        }
        EmbedSyncDecisionState::Reembed
        | EmbedSyncDecisionState::Switch
        | EmbedSyncDecisionState::Pause => {
            let identity_changed = current.local_model_id.as_deref() != local_model_id;
            if !identity_changed {
                return Ok(());
            }
            write_embed_sync_decision(
                conn,
                slot,
                &EmbedSyncDecision {
                    state: EmbedSyncDecisionState::Pending,
                    reason: Some(reason),
                    local_model_id: local,
                    peer_models,
                    pending_units,
                    decided_at: 0,
                    updated_at: now,
                    pause_scope: EmbedPauseScope::All,
                },
            )
        }
    }
}

/// Reset the receipt to default `none` (e.g. after the slot's configured
/// model identity changes and the previous decision no longer applies).
/// Call sites that wire model switches land in phase 2.
pub fn clear_decision_on_slot_identity_change(
    conn: &Connection,
    slot: EmbedSyncSlot,
) -> Result<(), String> {
    write_embed_sync_decision(conn, slot, &EmbedSyncDecision::default())
}

/// Whether `scope` may enqueue (or the worker may claim local-dirty work)
/// under the current decision.
///
/// `none` / `reembed` allow both scopes. `pending` / `switch` block both.
/// `pause` + [`EmbedPauseScope::All`] (or absent field) blocks both.
/// `pause` + [`EmbedPauseScope::SyncBackfill`] (modal Pause) blocks only
/// [`AutoIndexScope::SyncBackfill`] — local dirty seeding stays allowed.
pub fn auto_index_allowed(decision: &EmbedSyncDecision, scope: AutoIndexScope) -> bool {
    match decision.state {
        EmbedSyncDecisionState::None | EmbedSyncDecisionState::Reembed => true,
        EmbedSyncDecisionState::Pending | EmbedSyncDecisionState::Switch => false,
        EmbedSyncDecisionState::Pause => match decision.pause_scope {
            EmbedPauseScope::All => false,
            EmbedPauseScope::SyncBackfill => matches!(scope, AutoIndexScope::LocalDirty),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
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
    fn read_missing_returns_default_none() {
        let conn = open_test_db();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::None);
        assert!(d.reason.is_none());
        assert!(d.peer_models.is_empty());
        assert_eq!(d.pending_units, 0);
    }

    #[test]
    fn read_corrupt_json_returns_err_not_silent_none() {
        let conn = open_test_db();
        db::set_setting(&conn, settings_keys::EMBED_SYNC_DECISION, "not-json{{{").unwrap();
        let err = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap_err();
        assert!(
            err.contains("corrupt"),
            "corrupt receipt must fail closed, got: {err}"
        );
    }

    #[test]
    fn stamp_pending_from_none_writes_fields() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("local:model-a"),
            vec![peer("peer:model-b", 3)],
            7,
            1000,
        )
        .unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::Pending);
        assert_eq!(d.reason, Some(EmbedSyncDecisionReason::ModelMismatch));
        assert_eq!(d.local_model_id.as_deref(), Some("local:model-a"));
        assert_eq!(d.peer_models, vec![peer("peer:model-b", 3)]);
        assert_eq!(d.pending_units, 7);
        assert_eq!(d.updated_at, 1000);
        assert_eq!(d.decided_at, 0);
    }

    #[test]
    fn stamp_pending_idempotent_refreshes_peer_models() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Memory,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("local:m1"),
            vec![peer("peer:a", 1)],
            2,
            100,
        )
        .unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Memory,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("local:m1"),
            vec![peer("peer:a", 5), peer("peer:b", 2)],
            9,
            200,
        )
        .unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Memory).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::Pending);
        assert_eq!(d.peer_models, vec![peer("peer:a", 5), peer("peer:b", 2)]);
        assert_eq!(d.pending_units, 9);
        assert_eq!(d.updated_at, 200);
        assert_eq!(d.decided_at, 0);
    }

    #[test]
    fn stamp_does_not_clobber_pause_when_local_model_unchanged() {
        let conn = open_test_db();
        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Entry,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Pause,
                reason: Some(EmbedSyncDecisionReason::ModelMismatch),
                local_model_id: Some("local:m1".into()),
                peer_models: vec![peer("peer:x", 1)],
                pending_units: 1,
                decided_at: 50,
                updated_at: 50,
                ..Default::default()
            },
        )
        .unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("local:m1"),
            vec![peer("peer:y", 9)],
            99,
            999,
        )
        .unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::Pause);
        assert_eq!(d.peer_models, vec![peer("peer:x", 1)]);
        assert_eq!(d.pending_units, 1);
        assert_eq!(d.updated_at, 50);
    }

    #[test]
    fn stamp_reenters_pending_when_local_model_identity_changes_under_pause() {
        let conn = open_test_db();
        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Entry,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Pause,
                reason: Some(EmbedSyncDecisionReason::ModelMismatch),
                local_model_id: Some("local:old".into()),
                peer_models: vec![],
                pending_units: 0,
                decided_at: 50,
                updated_at: 50,
                ..Default::default()
            },
        )
        .unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("local:new"),
            vec![peer("peer:z", 1)],
            3,
            300,
        )
        .unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::Pending);
        assert_eq!(d.local_model_id.as_deref(), Some("local:new"));
        assert_eq!(d.pending_units, 3);
        assert_eq!(d.updated_at, 300);
        assert_eq!(d.decided_at, 0);
    }

    #[test]
    fn clear_decision_resets_to_none() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Memory,
            EmbedSyncDecisionReason::MissingKey,
            None,
            vec![],
            1,
            10,
        )
        .unwrap();
        clear_decision_on_slot_identity_change(&conn, EmbedSyncSlot::Memory).unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Memory).unwrap();
        assert_eq!(d, EmbedSyncDecision::default());
    }

    #[test]
    fn auto_index_allowed_for_none_and_reembed_only() {
        let mut d = EmbedSyncDecision::default();
        assert!(auto_index_allowed(&d, AutoIndexScope::LocalDirty));
        assert!(auto_index_allowed(&d, AutoIndexScope::SyncBackfill));
        d.state = EmbedSyncDecisionState::Reembed;
        assert!(auto_index_allowed(&d, AutoIndexScope::LocalDirty));
        assert!(auto_index_allowed(&d, AutoIndexScope::SyncBackfill));
        d.state = EmbedSyncDecisionState::Pending;
        assert!(!auto_index_allowed(&d, AutoIndexScope::LocalDirty));
        assert!(!auto_index_allowed(&d, AutoIndexScope::SyncBackfill));
        d.state = EmbedSyncDecisionState::Pause;
        assert!(!auto_index_allowed(&d, AutoIndexScope::LocalDirty));
        assert!(!auto_index_allowed(&d, AutoIndexScope::SyncBackfill));
        d.state = EmbedSyncDecisionState::Switch;
        assert!(!auto_index_allowed(&d, AutoIndexScope::LocalDirty));
        assert!(!auto_index_allowed(&d, AutoIndexScope::SyncBackfill));
    }

    /// Absent `pause_scope` in persisted JSON → `all` (old Pause gated every
    /// auto-index path). No migration shim — serde default is the contract.
    #[test]
    fn pause_scope_absent_deserializes_to_all_and_blocks_both_scopes() {
        let raw = r#"{
            "state":"pause",
            "reason":"model_mismatch",
            "peer_models":[],
            "pending_units":0,
            "decided_at":1,
            "updated_at":1
        }"#;
        let d: EmbedSyncDecision = serde_json::from_str(raw).unwrap();
        assert_eq!(d.pause_scope, EmbedPauseScope::All);
        assert!(
            !auto_index_allowed(&d, AutoIndexScope::LocalDirty),
            "pause_scope=all (absent) must block local dirty enqueue"
        );
        assert!(
            !auto_index_allowed(&d, AutoIndexScope::SyncBackfill),
            "pause_scope=all (absent) must block sync-backfill adopt/requeue"
        );
    }

    /// Modal Pause writes `sync_backfill`: sync adopt / peer-mismatch
    /// re-embed is skipped; local dirty seeding still queues.
    #[test]
    fn pause_sync_backfill_blocks_adopt_allows_local_dirty() {
        let mut d = EmbedSyncDecision::default();
        d.state = EmbedSyncDecisionState::Pause;
        d.pause_scope = EmbedPauseScope::SyncBackfill;
        assert!(
            auto_index_allowed(&d, AutoIndexScope::LocalDirty),
            "new local edits keep indexing under modal Pause"
        );
        assert!(
            !auto_index_allowed(&d, AutoIndexScope::SyncBackfill),
            "paused-sync must skip adopt / peer-mismatch requeue"
        );
    }

    #[test]
    fn pause_scope_all_blocks_local_dirty_and_sync_backfill() {
        let mut d = EmbedSyncDecision::default();
        d.state = EmbedSyncDecisionState::Pause;
        d.pause_scope = EmbedPauseScope::All;
        assert!(!auto_index_allowed(&d, AutoIndexScope::LocalDirty));
        assert!(!auto_index_allowed(&d, AutoIndexScope::SyncBackfill));
    }

    #[test]
    fn stamp_pending_does_not_demote_missing_key_to_model_mismatch() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::MissingKey,
            Some("local:m1"),
            vec![],
            2,
            100,
        )
        .unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("local:m1"),
            vec![peer("peer:x", 3)],
            5,
            200,
        )
        .unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.reason, Some(EmbedSyncDecisionReason::MissingKey));
        assert_eq!(d.peer_models, vec![peer("peer:x", 3)]);
        assert_eq!(d.pending_units, 5);
        assert_eq!(d.updated_at, 200);
    }

    #[test]
    fn stamp_does_not_clobber_reembed_when_local_model_unchanged() {
        let conn = open_test_db();
        write_embed_sync_decision(
            &conn,
            EmbedSyncSlot::Entry,
            &EmbedSyncDecision {
                state: EmbedSyncDecisionState::Reembed,
                reason: Some(EmbedSyncDecisionReason::ModelMismatch),
                local_model_id: Some("local:m1".into()),
                peer_models: vec![],
                pending_units: 0,
                decided_at: 50,
                updated_at: 50,
                ..Default::default()
            },
        )
        .unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("local:m1"),
            vec![peer("peer:y", 1)],
            1,
            999,
        )
        .unwrap();
        let d = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        assert_eq!(d.state, EmbedSyncDecisionState::Reembed);
        assert_eq!(d.updated_at, 50);
    }

    #[test]
    fn decision_keys_are_device_local_not_syncable() {
        assert!(!db::is_syncable_setting(settings_keys::EMBED_SYNC_DECISION));
        assert!(!db::is_syncable_setting(
            settings_keys::MEMORY_EMBED_SYNC_DECISION
        ));
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("m"),
            vec![],
            1,
            1,
        )
        .unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Memory,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("m"),
            vec![],
            1,
            1,
        )
        .unwrap();
        let listed = db::list_syncable_settings(&conn).unwrap();
        assert!(
            !listed
                .iter()
                .any(|(k, _, _, _)| k == settings_keys::EMBED_SYNC_DECISION
                    || k == settings_keys::MEMORY_EMBED_SYNC_DECISION),
            "decision receipts must never appear in list_syncable_settings"
        );
    }

    #[test]
    fn entry_and_memory_slots_use_independent_keys() {
        let conn = open_test_db();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Entry,
            EmbedSyncDecisionReason::ModelMismatch,
            Some("entry-model"),
            vec![peer("p1", 1)],
            1,
            1,
        )
        .unwrap();
        stamp_pending_if_needed(
            &conn,
            EmbedSyncSlot::Memory,
            EmbedSyncDecisionReason::MissingKey,
            Some("mem-model"),
            vec![peer("p2", 2)],
            4,
            2,
        )
        .unwrap();
        let entry = read_embed_sync_decision(&conn, EmbedSyncSlot::Entry).unwrap();
        let memory = read_embed_sync_decision(&conn, EmbedSyncSlot::Memory).unwrap();
        assert_eq!(entry.local_model_id.as_deref(), Some("entry-model"));
        assert_eq!(memory.local_model_id.as_deref(), Some("mem-model"));
        assert_eq!(entry.reason, Some(EmbedSyncDecisionReason::ModelMismatch));
        assert_eq!(memory.reason, Some(EmbedSyncDecisionReason::MissingKey));
    }
}
