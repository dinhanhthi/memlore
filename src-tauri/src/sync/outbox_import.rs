//! Outbox Importer — Desktop Ingest of Web Companion Intents
//!
//! This module documents and implements the desktop-side outbox importer (Phases 13 & 14)
//! for the Memlore Web Companion (`web.memlore.app`).
//!
//! # Architecture & Safety Principles
//!
//! The web companion operates under a strict "outbox" model:
//! 1. The web NEVER writes sync-protocol files (`metadata.json`, `entries/`, `media/`, `journals/`).
//! 2. The web writes sealed intents into `generations/g-<N>/<webId>/outbox/`:
//!    - `outbox/<entryId>.bin`: one intent file per entry, updated in place.
//!    - `outbox/m-<mediaId>` and `outbox/m-<mediaId>.thumb`: flat layout, 3-part logical paths
//!      (`<dev>/outbox/<file>`), compliant with `parse_drive_path` (`gdrive_provider.rs:1729-1742`).
//! 3. Desktop is primary: desktops apply intents through their own local code paths, then
//!    publish the result as normal desktop sync files. Older desktops without this importer
//!    ignore the outbox completely because `<webId>` has no `metadata.json`.
//!
//! ---
//!
//! ## (a) Desktop Consumers & Namespace Isolation
//!
//! Every device-folder consumer in the desktop codebase has been verified:
//! - **Manifest pull:** `engine.rs:5143` and `engine.rs:5213-5218` iterate devices and pull only
//!   when `metadata.json` is present. Because `<webId>` never writes `metadata.json`, all
//!   desktop pull pipelines skip the web device folder.
//! - **Whole-table channels:** settings, tags, templates, streak, locations, and ai channels
//!   ignore missing files (NotFound -> continue). Chats and memory are manifest-gated.
//! - **New desktop-written file `{self}/outbox-acks.bin`:**
//!   - Placed at the root of the desktop's OWN folder.
//!   - **Rotation enumeration (`rotation/enumerate.rs:154-237`):**
//!     Rotation enumerates `FileKind::Entries`, `FileKind::Media`, `FileKind::Journals`,
//!     `FileKind::Versions`, and a fixed list `SINGLETON_BLOB_NAMES` (`enumerate.rs:223-235`).
//!     It does NOT glob or list all root files; `{self}/outbox-acks.bin` is not in
//!     `SINGLETON_BLOB_NAMES` and is therefore ignored during rotation re-encryption.
//!   - **Own-cloud reconcile (`engine.rs:693-730`):**
//!     `FileKind::DeviceRoot` listing compares against `HASH_GATED_SURFACE_NAMES` (`engine.rs:728`).
//!     Extra files like `outbox-acks.bin` do not match any surface name and are ignored without error.
//! - **Destructive flows touching the web namespace:**
//!   - **Cloud cleanup (`gdrive_provider.rs:1358-1396`, `recovery.rs:1457-1486`):**
//!     Deletes all children of the `Memlore` root except `.meta/control.json` and recovery markers
//!     preserved by `preserve_during_cloud_cleanup`. This cleanly purges all device folders,
//!     including web outbox folders and `{self}/outbox-acks.bin`.
//!   - **Key rotation `publish_keyring` (`rotation/publish.rs:198-216`):**
//!     `kio::delete_device_slot(provider, &slot.device_id)` deletes every non-rotator device slot
//!     under `.meta/keyring/devices/`. Web slots are dropped, revoking decryption of new content.
//!   - **Remove device (`commands/crypto.rs:3933-3953`):**
//!     `remove_device_inner` calls `delete_device_slot` on the cloud provider and deletes the
//!     local device record, leaving cloud outbox files untouched until cloud cleanup.
//!
//! ---
//!
//! ## (b) Provider Listing API & Device Slot Discovery
//!
//! - **Subfolder listing:**
//!   In `gdrive_provider.rs:1145-1148`, `list_subfolder_files` checks `find_folder(subfolder, ...)`.
//!   If the subfolder does not exist, it returns `Ok(vec![])`. Listing `outbox` on a device
//!   folder without an outbox cleanly returns empty.
//! - **Device slot discovery:**
//!   `KeyringV2Io::list_device_slots` (`keyring_v2/io.rs:318`) lists `.meta/keyring/devices/*.json`.
//!   In `commands/sync.rs:880` and `commands/crypto.rs:3747`, `refresh_devices_from_cloud_impl`
//!   calls `list_device_slots(&provider)` to discover registered devices.
//!
//! ---
//!
//! ## (c) Building Blocks Reused by the Importer
//!
//! Following the precedent established in `commands/mcp.rs`:
//! - **Write guards (`commands/mcp.rs:357-395`):**
//!   `require_writable_entry` refuses locked, invisible, or deleted entries.
//!   `visible_journal` verifies that the target journal exists and is neither deleted nor invisible.
//! - **Emotion & tag validation:**
//!   `validate_emotion` (`mcp.rs:425`) enforces 3-state emotion values (`good`, `neutral`, `bad`).
//!   Tag IDs require a new ID-based query `existing_tag_ids(conn, ids)` because
//!   `resolve_existing_tag_ids` (`mcp.rs:396-416`) looks up tags by name and errors on unknown tags.
//! - **Yrs Yjs text extraction:**
//!   Yjs text is extracted using yrs transactions. The frontend already computes `contentText`
//!   and `previewText` in the outbox payload (`OutboxEntryV1`), but desktop verification
//!   or fallback can walk the `default` text type of the merged `Y.Doc`.
//! - **Editor live diff bridge (`commands/mcp.rs:306`, `src/hooks/useMcpEntryEvents.ts:24-33`):**
//!   `encode_diff_v1(&sv_before)` emits `mcp:entry-changed` so an open TipTap editor absorbs changes.
//! - **Content persistence:**
//!   `save_entry_content_impl` (`commands/entries.rs:334-346`) persists `yjs_doc`, `content_text`,
//!   and `preview_text` in a transaction.
//! - **Embedding indexing & language detection:**
//!   `maybe_mark_entry_embedding_dirty_after_save` (`commands/entries.rs:38`) queues embedding
//!   dirty jobs and detects language.
//! - **Size limits:**
//!   `MAX_YJS_DOC_BYTES` (`commands/entries.rs:1052`, 10 MiB) guards document size.
//! - **Version snapshots:**
//!   `snapshot_entry_version_impl` (`commands/entries.rs:1322`) records an immutable history snapshot.
//! - **Media handling:**
//!   `get_media_upload_limits` / `get_media_upload_limits_inner` (`commands/media.rs:1993`) checks quotas.
//!   The media file creation pattern (`commands/media.rs:242`) saves media under `media_dir`.
//!
//! ---
//!
//! ## (d) Field Setters & `updated_at` Timestamp Contracts
//!
//! Setters in `db/queries.rs`:
//! - `create_entry` (`queries.rs:1046`): stamps `now_unix()`.
//! - `update_entry_emotion` (`queries.rs:2633`): stamps `now_unix()`.
//! - `update_entry_title` (`queries.rs:2687`): stamps `now_unix()`.
//! - `update_entry_date` (`queries.rs:2705`): stamps `now_unix()`.
//! - `update_entry_journal` (`queries.rs:2733`): stamps `now_unix()`.
//! - `set_entry_language` (`queries.rs:3504-3516`): stamps `now_unix()`.
//! - `mark_entry_date_user_edited` (`queries.rs:2723`): flags `entry_date_user_edited = 1` without bumping `updated_at`.
//! - `touch_entry_updated_at` (`queries.rs:3145`): uses `MAX(?1, updated_at + 1)` to ensure monotonicity.
//! - Tag associations (`commands/tags.rs:115, 129`): call `touch_entry_updated_at`.
//!
//! ---
//!
//! ## (e) `sync_state` Reset Invariants & Reset Hooks
//!
//! The additive table `web_outbox_imports` must be cleared ONLY on true user-data wipe:
//! - **Clear table on:**
//!   1. `hard_wipe_user_data` (`queries.rs:689-701`).
//!   2. `reset_all_sync_state_to_pending` (`queries.rs:7904`).
//! - **Keep table on:**
//!   1. `reset_local_sync_state` (`commands/sync.rs:1390`, callers `sync.rs:810, 1464`, `gdrive.rs:1472, 4374`).
//!   2. `run_repair_from_this_device` (`commands/sync.rs:1497`).
//!   3. `mark_scope_upgrade_required_in_tx` (`commands/sync.rs:1627`).
//!   4. Provider disconnect / reconnect (`gdrive_provider.rs:1285`).
//!   5. Surface push invalidation (`engine.rs:220`).
//!   6. Local-authoritative rebuild (`adopt_all_local_entries`, `queries.rs:7938`).
//!
//! The acks file (`outbox-acks.bin`) on Drive self-heals: every rewrite merges known
//! `created: true` statuses so imported entries are never resurrected as duplicates.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bincode::Options;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::ai::provider::settings_keys;
use crate::commands::entries::{
    maybe_detect_language_after_save, maybe_mark_entry_embedding_dirty_after_save,
    move_entry_to_journal_impl, save_entry_content_impl, snapshot_entry_version_impl,
    toggle_favorite_impl, update_entry_date_impl, update_entry_emotion_impl, update_entry_impl,
};
use crate::commands::mcp::{
    load_yjs_doc, require_writable_entry, validate_emotion, visible_journal,
};
use crate::db;
use crate::db::queries::{
    existing_tag_ids, get_media, outbox_import_get, outbox_import_record, CreateEntryParams,
    CreateMediaWithIdParams, WebOutboxImportRecord,
};
use crate::sync::engine::{ConnAccess, SyncProgressEvent, SyncProgressPhase, SyncSummary};
use crate::sync::keyring_v2::KeyringV2Io;
use crate::sync::metadata::DeviceMetadata;
use crate::sync::provider::{ConditionalRead, FileKind, SyncError, SyncProvider};
use crate::AppState;
use memlore_core::envelope::open_media;
use memlore_core::key_state::ContentKeyList;
use memlore_core::outbox::{
    open_outbox_acks, open_outbox_entry, seal_outbox_acks, FieldChange, OutboxAckEntry,
    OutboxAcksV1, OutboxEntryV1, OutboxError, OutboxFieldDecision, OUTBOX_SCHEMA_VERSION,
};

const PREVIEW_MAX_CHARS: usize = 200;

fn sync_io(e: impl ToString) -> SyncError {
    SyncError::Io(e.to_string())
}

/// Outcome of applying an outbox intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    Refused(String),
    Transient,
    SkippedVersion(u16),
    Corrupt(String),
}

/// Context passed to the pure apply logic.
#[derive(Debug, Clone)]
pub struct ApplyContext {
    /// entry_id -> is_deleted (true if tombstoned in peer/own cloud manifests).
    pub known_ids: HashMap<String, bool>,
    /// Whether the pull leg of this cycle completed with 0 errors.
    pub pull_clean: bool,
    /// Desktop's own historical acknowledgements (`outbox-acks.bin`).
    pub own_acks: HashMap<String, OutboxAckEntry>,
    /// Local media storage directory for saving attached images/videos.
    pub media_dir: PathBuf,
}

impl ApplyContext {
    pub fn new(media_dir: PathBuf) -> Self {
        Self {
            known_ids: HashMap::new(),
            pull_clean: true,
            own_acks: HashMap::new(),
            media_dir,
        }
    }
}

/// Decrypted outbox intent and associated downloaded media.
#[derive(Debug, Clone)]
pub struct OutboxIntent {
    pub path: String,
    pub entry: OutboxEntryV1,
    pub content_hash: String,
    pub revision: Option<String>,
    pub media_payloads: HashMap<String, Option<Vec<u8>>>,
    pub media_thumb_payloads: HashMap<String, Option<Vec<u8>>>,
}

/// Live bridge event emitted to the frontend editor upon successful import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxBridgeEvent {
    pub kind: String, // "created", "appended", "metadata"
    pub entry_id: String,
    pub journal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yjs_update: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<serde_json::Value>,
}

/// Detailed result of applying an intent.
#[derive(Debug, Clone)]
pub struct ApplyResult {
    pub outcome: Outcome,
    pub touched_entry_ids: Vec<String>,
    pub bridge_event: Option<OutboxBridgeEvent>,
}

/// Pending plan saved to the DB before mutations begin, ensuring crash safety.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PendingPlan {
    pub is_create: bool,
    pub local_before: i64,
}

/// Deterministic fingerprint of an entry's current metadata state.
pub fn compute_metadata_fingerprint(
    title: Option<&str>,
    entry_date: i64,
    emotion: Option<&str>,
    is_favorite: bool,
    journal_id: &str,
    tag_ids: &[String],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(title.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(entry_date.to_le_bytes());
    hasher.update(b"\0");
    hasher.update(emotion.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(if is_favorite { [1u8] } else { [0u8] });
    hasher.update(b"\0");
    hasher.update(journal_id.as_bytes());
    hasher.update(b"\0");
    let mut sorted_tags = tag_ids.to_vec();
    sorted_tags.sort();
    for tag in &sorted_tags {
        hasher.update(tag.as_bytes());
        hasher.update(b",");
    }
    hex::encode(hasher.finalize())
}

/// Parse an entry date string into Unix epoch seconds.
pub fn parse_entry_date(s: &str) -> Option<i64> {
    if let Ok(ts) = s.parse::<i64>() {
        return Some(ts);
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp());
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).map(|dt| dt.and_utc().timestamp());
    }
    None
}

/// Map allowed MIME types to safe, canonical extensions.
fn ext_from_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/heic" => Some("heic"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "video/mp4" => Some("mp4"),
        "video/quicktime" => Some("mov"),
        _ => None,
    }
}

/// Resolve a visible, non-locked journal for creation, falling back safely.
pub(crate) fn resolve_safe_journal(
    conn: &Connection,
    preferred_id: Option<&str>,
) -> Result<(String, String), String> {
    if let Some(id) = preferred_id {
        if let Ok(Some((jid, name))) = visible_journal(conn, id) {
            let is_locked: bool = conn
                .query_row(
                    "SELECT is_locked FROM journals WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if !is_locked {
                return Ok((jid, name));
            }
        }
    }
    if let Ok(Some(default_id)) =
        db::queries::get_setting(conn, settings_keys::MCP_DEFAULT_JOURNAL_ID)
    {
        if let Ok(Some((jid, name))) = visible_journal(conn, &default_id) {
            let is_locked: bool = conn
                .query_row(
                    "SELECT is_locked FROM journals WHERE id = ?1",
                    [&default_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if !is_locked {
                return Ok((jid, name));
            }
        }
    }
    let journals = db::queries::list_journals(conn, None).map_err(|e| e.to_string())?;
    for j in journals {
        if !j.is_deleted && !j.is_invisible && !j.is_locked {
            return Ok((j.id, j.name));
        }
    }
    Err("NO_VALID_JOURNAL".to_string())
}

/// Evaluate a field change according to the decide-once, no-clocks rule:
/// Returns (decision, should_apply).
fn evaluate_field<T: PartialEq>(
    local_val: &T,
    change: &FieldChange<T>,
    local_before: i64,
    untouched: bool,
) -> (&'static str, bool) {
    if local_val == &change.value {
        ("reflected", false)
    } else if local_before == change.base_updated_at {
        ("applied", true)
    } else if untouched && local_val == &change.base {
        ("applied", true)
    } else {
        ("refused", false)
    }
}

/// Apply media attachments from the intent to disk and the database.
fn apply_media_items(
    conn: &Connection,
    media_dir: &Path,
    entry_id: &str,
    media_items: &[memlore_core::outbox::OutboxMediaRef],
    payloads: &HashMap<String, Option<Vec<u8>>>,
    thumb_payloads: &HashMap<String, Option<Vec<u8>>>,
) -> Result<bool, String> {
    let mut any_created = false;
    for m in media_items {
        if let Ok(Some(existing)) = db::queries::get_media(conn, &m.media_id) {
            if existing.entry_id != entry_id {
                return Err("media_entry_mismatch".to_string());
            }
            continue;
        }

        let bytes = payloads
            .get(&m.media_id)
            .and_then(|o| o.as_ref())
            .ok_or_else(|| format!("missing media payload for {}", m.media_id))?;
        let ext = ext_from_mime(&m.file_type)
            .ok_or_else(|| format!("unsupported mime: {}", m.file_type))?;

        std::fs::create_dir_all(media_dir).map_err(|e| e.to_string())?;
        let dest_name = format!("{}.{}", m.media_id, ext);
        let dest_path = media_dir.join(&dest_name);
        std::fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;

        let thumb_path = if m.has_thumb {
            if let Some(Some(thumb_bytes)) = thumb_payloads.get(&m.media_id) {
                let t_name = format!("{}.thumb.jpg", m.media_id);
                let t_path = media_dir.join(&t_name);
                std::fs::write(&t_path, thumb_bytes).map_err(|e| e.to_string())?;
                Some(t_path)
            } else {
                None
            }
        } else {
            None
        };

        let inserted = db::queries::create_media_with_id(
            conn,
            CreateMediaWithIdParams {
                id: &m.media_id,
                entry_id,
                extension: ext,
                file_type: &m.file_type,
                storage_path: dest_path.to_str().ok_or("invalid dest path")?,
                thumbnail_path: thumb_path.as_ref().and_then(|p| p.to_str()),
                file_size: Some(bytes.len() as i64),
                sort_order: 0,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
                insertion_mode: "inline",
                width: None,
                height: None,
                duration_seconds: None,
            },
        )
        .map_err(|e| e.to_string())?;

        if inserted {
            db::queries::mark_entry_pending(conn, entry_id).map_err(|e| e.to_string())?;
            any_created = true;
        }
    }
    Ok(any_created)
}

/// Pure apply logic for ingesting a single outbox intent without network calls.
/// Holds the DB connection only for the duration of this call.
pub fn apply_intent(
    conn: &Connection,
    ctx: &ApplyContext,
    intent: &OutboxIntent,
) -> (Outcome, Vec<String>) {
    let res = apply_intent_full(conn, ctx, intent);
    (res.outcome, res.touched_entry_ids)
}

/// Full implementation of `apply_intent`, producing an `ApplyResult` with bridge events.
pub fn apply_intent_full(
    conn: &Connection,
    ctx: &ApplyContext,
    intent: &OutboxIntent,
) -> ApplyResult {
    // 0. Schema version and payload validation
    if intent.entry.schema_version != OUTBOX_SCHEMA_VERSION {
        let rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: intent.revision.clone(),
            content_hash: intent.content_hash.clone(),
            outcome: "skipped_version".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: None,
            pending_revision: None,
            pending_plan: Some(intent.entry.schema_version.to_string()),
            created: false,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::SkippedVersion(intent.entry.schema_version),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    if let Err(e) = intent.entry.validate() {
        let rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: intent.revision.clone(),
            content_hash: intent.content_hash.clone(),
            outcome: "corrupt".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: None,
            pending_revision: None,
            pending_plan: Some(e.to_string()),
            created: false,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::Corrupt(e.to_string()),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    // 1. Behind-desktop check & missing media check
    if !ctx.pull_clean {
        return ApplyResult {
            outcome: Outcome::Transient,
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    for m in &intent.entry.media {
        match intent.media_payloads.get(&m.media_id) {
            Some(Some(_)) => {}
            _ => {
                return ApplyResult {
                    outcome: Outcome::Transient,
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }
        }
        if m.has_thumb {
            match intent.media_thumb_payloads.get(&m.media_id) {
                Some(Some(_)) => {}
                _ => {
                    return ApplyResult {
                        outcome: Outcome::Transient,
                        touched_entry_ids: vec![],
                        bridge_event: None,
                    };
                }
            }
        }
    }

    // Load existing import record
    let existing_import = outbox_import_get(conn, &intent.path).unwrap_or(None);
    let mut decided_map: BTreeMap<String, OutboxFieldDecision> = existing_import
        .as_ref()
        .and_then(|r| r.decided_fields.as_deref())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let sticky_created = existing_import.as_ref().map(|r| r.created).unwrap_or(false);

    // 2. Presence check
    let raw_entry = db::queries::get_entry_raw(conn, &intent.entry.entry_id).unwrap_or(None);

    if raw_entry.is_none() {
        // (i) Known live in cloud manifests -> Transient
        if let Some(&is_deleted) = ctx.known_ids.get(&intent.entry.entry_id) {
            if !is_deleted {
                return ApplyResult {
                    outcome: Outcome::Transient,
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }
            // (ii) Known deleted in cloud manifests -> Refused("absent")
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some("absent".to_string()),
                created: sticky_created,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("absent".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }

        // Not created on web -> Refused("absent")
        if !intent.entry.created_on_web {
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some("absent".to_string()),
                created: sticky_created,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("absent".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }

        // (iii) Wipe-resurrection guard: own_acks or sticky created reports created
        let own_ack_created = ctx
            .own_acks
            .get(&intent.path)
            .map(|a| a.created)
            .unwrap_or(false);
        if sticky_created || own_ack_created {
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some("absent".to_string()),
                created: true,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("absent".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }

        // (iv) Valid create path
        let target_jid = intent
            .entry
            .fields
            .journal_id
            .as_ref()
            .map(|j| j.value.as_str());
        let (journal_id, _) = match resolve_safe_journal(conn, target_jid) {
            Ok(pair) => pair,
            Err(_) => {
                let rec = WebOutboxImportRecord {
                    path: intent.path.clone(),
                    revision: intent.revision.clone(),
                    content_hash: intent.content_hash.clone(),
                    outcome: "refused".to_string(),
                    imported_at: chrono::Utc::now().timestamp(),
                    last_applied_updated_at: None,
                    post_import_fingerprint: None,
                    decided_fields: serde_json::to_string(&decided_map).ok(),
                    pending_revision: None,
                    pending_plan: Some("no_journal".to_string()),
                    created: sticky_created,
                };
                let _ = outbox_import_record(conn, &rec);
                return ApplyResult {
                    outcome: Outcome::Refused("no_journal".to_string()),
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }
        };

        let entry_date = intent
            .entry
            .fields
            .entry_date
            .as_ref()
            .and_then(|d| parse_entry_date(&d.value))
            .unwrap_or(intent.entry.web_updated_at_secs);
        let title = intent.entry.fields.title.as_ref().map(|t| t.value.as_str());
        let content_text = intent.entry.content_text.as_deref().unwrap_or("");
        let preview_text = intent.entry.preview_text.as_deref().unwrap_or("");

        // Two-phase crash safety: record 'pending' before first mutation in create path
        let pending_rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: existing_import.as_ref().and_then(|r| r.revision.clone()),
            content_hash: intent.content_hash.clone(),
            outcome: "pending".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: existing_import
                .as_ref()
                .and_then(|r| r.last_applied_updated_at),
            post_import_fingerprint: existing_import
                .as_ref()
                .and_then(|r| r.post_import_fingerprint.clone()),
            decided_fields: serde_json::to_string(&decided_map).ok(),
            pending_revision: intent.revision.clone(),
            pending_plan: serde_json::to_string(&PendingPlan {
                is_create: true,
                local_before: 0,
            })
            .ok(),
            created: sticky_created,
        };
        let _ = outbox_import_record(conn, &pending_rec);

        let inserted = match db::queries::create_entry_with_id(
            conn,
            &intent.entry.entry_id,
            CreateEntryParams {
                journal_id: &journal_id,
                title,
                content_text: Some(content_text),
                preview_text: Some(preview_text),
                entry_date,
            },
        ) {
            Ok(b) => b,
            Err(e) => {
                return ApplyResult {
                    outcome: Outcome::Refused(e.to_string()),
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }
        };

        if inserted {
            // Write Yjs document
            let yjs_bytes = if intent.entry.yjs_full_state.is_empty() {
                Doc::new()
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default())
            } else {
                intent.entry.yjs_full_state.clone()
            };
            if let Err(e) = save_entry_content_impl(
                conn,
                &intent.entry.entry_id,
                &yjs_bytes,
                content_text,
                preview_text,
            ) {
                return ApplyResult {
                    outcome: Outcome::Refused(e),
                    touched_entry_ids: vec![],
                    bridge_event: None,
                };
            }

            if intent.entry.fields.entry_date.is_some() {
                let _ = db::queries::mark_entry_date_user_edited(conn, &intent.entry.entry_id);
            }
            if let Some(em) = &intent.entry.fields.emotion {
                let _ =
                    update_entry_emotion_impl(conn, &intent.entry.entry_id, em.value.as_deref());
            }
            if let Some(fav) = &intent.entry.fields.is_favorite {
                if fav.value {
                    let _ = toggle_favorite_impl(conn, &intent.entry.entry_id);
                }
            }
            for (tag_id, change) in &intent.entry.fields.tags_add {
                if change.value {
                    if let Ok(valid) = existing_tag_ids(conn, &[tag_id.as_str()]) {
                        if valid.contains(tag_id) {
                            let _ =
                                db::queries::add_tag_to_entry(conn, &intent.entry.entry_id, tag_id);
                        }
                    }
                }
            }
            for (tag_id, change) in &intent.entry.fields.tags_remove {
                if change.value {
                    let _ =
                        db::queries::remove_tag_from_entry(conn, &intent.entry.entry_id, tag_id);
                }
            }

            // Media
            let _ = apply_media_items(
                conn,
                &ctx.media_dir,
                &intent.entry.entry_id,
                &intent.entry.media,
                &intent.media_payloads,
                &intent.media_thumb_payloads,
            );

            let _ = db::queries::mark_entry_pending(conn, &intent.entry.entry_id);

            // Record all fields as applied
            let now = chrono::Utc::now().timestamp();
            if let Some(t) = &intent.entry.fields.title {
                decided_map.insert(
                    format!("title@{}", t.change_seq),
                    OutboxFieldDecision {
                        field: "title".to_string(),
                        change_seq: t.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            if let Some(d) = &intent.entry.fields.entry_date {
                decided_map.insert(
                    format!("entry_date@{}", d.change_seq),
                    OutboxFieldDecision {
                        field: "entry_date".to_string(),
                        change_seq: d.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            if let Some(e) = &intent.entry.fields.emotion {
                decided_map.insert(
                    format!("emotion@{}", e.change_seq),
                    OutboxFieldDecision {
                        field: "emotion".to_string(),
                        change_seq: e.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            if let Some(f) = &intent.entry.fields.is_favorite {
                decided_map.insert(
                    format!("is_favorite@{}", f.change_seq),
                    OutboxFieldDecision {
                        field: "is_favorite".to_string(),
                        change_seq: f.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            if let Some(j) = &intent.entry.fields.journal_id {
                decided_map.insert(
                    format!("journal_id@{}", j.change_seq),
                    OutboxFieldDecision {
                        field: "journal_id".to_string(),
                        change_seq: j.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            for (tag_id, c) in &intent.entry.fields.tags_add {
                decided_map.insert(
                    format!("tag_add:{}@{}", tag_id, c.change_seq),
                    OutboxFieldDecision {
                        field: format!("tag_add:{}", tag_id),
                        change_seq: c.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }
            for (tag_id, c) in &intent.entry.fields.tags_remove {
                decided_map.insert(
                    format!("tag_remove:{}@{}", tag_id, c.change_seq),
                    OutboxFieldDecision {
                        field: format!("tag_remove:{}", tag_id),
                        change_seq: c.change_seq,
                        decision: "applied".to_string(),
                        decided_updated_at: now,
                        reason: None,
                    },
                );
            }

            maybe_detect_language_after_save(conn, &intent.entry.entry_id);

            // Step 8: read final entry and store record
            let final_entry = db::queries::get_entry(conn, &intent.entry.entry_id)
                .ok()
                .flatten();
            let final_updated_at = final_entry.as_ref().map(|e| e.updated_at).unwrap_or(now);
            let final_tags = db::queries::get_tag_ids_for_entry(conn, &intent.entry.entry_id)
                .unwrap_or_default();
            let final_fp = compute_metadata_fingerprint(
                final_entry.as_ref().and_then(|e| e.title.as_deref()),
                final_entry
                    .as_ref()
                    .map(|e| e.entry_date)
                    .unwrap_or(entry_date),
                final_entry.as_ref().and_then(|e| e.emotion.as_deref()),
                final_entry.as_ref().map(|e| e.is_favorite).unwrap_or(false),
                &journal_id,
                &final_tags,
            );

            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "applied".to_string(),
                imported_at: now,
                last_applied_updated_at: Some(final_updated_at),
                post_import_fingerprint: Some(final_fp),
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: None,
                created: true,
            };
            let _ = outbox_import_record(conn, &rec);

            let bridge_event = OutboxBridgeEvent {
                kind: "created".to_string(),
                entry_id: intent.entry.entry_id.clone(),
                journal_id,
                yjs_update: None,
                patch: None,
            };

            return ApplyResult {
                outcome: Outcome::Applied,
                touched_entry_ids: vec![intent.entry.entry_id.clone()],
                bridge_event: Some(bridge_event),
            };
        }
    }

    // ── Present Entry Path ──────────────────────────────────────────────────
    let entry = match require_writable_entry(conn, &intent.entry.entry_id) {
        Ok(e) => e,
        Err(e) => {
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some(e),
                created: sticky_created,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("target_not_writable".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }
    };

    // Check visible and unlocked journal
    let j_locked: bool = conn
        .query_row(
            "SELECT is_locked FROM journals WHERE id = ?1",
            [&entry.journal_id],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if visible_journal(conn, &entry.journal_id)
        .ok()
        .flatten()
        .is_none()
        || j_locked
    {
        let rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: intent.revision.clone(),
            content_hash: intent.content_hash.clone(),
            outcome: "refused".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: serde_json::to_string(&decided_map).ok(),
            pending_revision: None,
            pending_plan: Some("journal_locked_or_invisible".to_string()),
            created: sticky_created,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::Refused("journal_locked_or_invisible".to_string()),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    if let Some(em) = &intent.entry.fields.emotion {
        if let Err(e) = validate_emotion(em.value.as_deref()) {
            let rec = WebOutboxImportRecord {
                path: intent.path.clone(),
                revision: intent.revision.clone(),
                content_hash: intent.content_hash.clone(),
                outcome: "refused".to_string(),
                imported_at: chrono::Utc::now().timestamp(),
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: serde_json::to_string(&decided_map).ok(),
                pending_revision: None,
                pending_plan: Some(e),
                created: sticky_created,
            };
            let _ = outbox_import_record(conn, &rec);
            return ApplyResult {
                outcome: Outcome::Refused("invalid_emotion".to_string()),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }
    }

    // Step 3: Snapshot local_before once (restoring from pending_plan if resuming after crash)
    let restored_pending_plan: Option<PendingPlan> = existing_import
        .as_ref()
        .and_then(|r| r.pending_plan.as_deref())
        .and_then(|s| serde_json::from_str(s).ok());
    let local_before = restored_pending_plan
        .map(|p| p.local_before)
        .unwrap_or(entry.updated_at);

    // Step 4: Content decision & Empty base guard
    let existing_blob = db::queries::get_entry_content(conn, &entry.id).unwrap_or(None);
    let local_doc = match load_yjs_doc(existing_blob.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            return ApplyResult {
                outcome: Outcome::Refused(e),
                touched_entry_ids: vec![],
                bridge_event: None,
            };
        }
    };
    let sv_before = local_doc.transact().state_vector();
    let local_has_content = !sv_before.is_empty()
        || existing_blob
            .as_ref()
            .map(|b| !b.is_empty())
            .unwrap_or(false)
        || entry
            .content_text
            .as_ref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false);

    if intent.entry.base_state_vector.is_empty()
        && local_has_content
        && !intent.entry.created_on_web
    {
        let rec = WebOutboxImportRecord {
            path: intent.path.clone(),
            revision: intent.revision.clone(),
            content_hash: intent.content_hash.clone(),
            outcome: "refused".to_string(),
            imported_at: chrono::Utc::now().timestamp(),
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: serde_json::to_string(&decided_map).ok(),
            pending_revision: None,
            pending_plan: Some("empty_base".to_string()),
            created: sticky_created,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::Refused("empty_base".to_string()),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }

    // Two-phase crash safety: record 'pending' before first mutation
    let pending_rec = WebOutboxImportRecord {
        path: intent.path.clone(),
        revision: existing_import.as_ref().and_then(|r| r.revision.clone()),
        content_hash: intent.content_hash.clone(),
        outcome: "pending".to_string(),
        imported_at: chrono::Utc::now().timestamp(),
        last_applied_updated_at: existing_import
            .as_ref()
            .and_then(|r| r.last_applied_updated_at),
        post_import_fingerprint: existing_import
            .as_ref()
            .and_then(|r| r.post_import_fingerprint.clone()),
        decided_fields: serde_json::to_string(&decided_map).ok(),
        pending_revision: intent.revision.clone(),
        pending_plan: serde_json::to_string(&PendingPlan {
            is_create: false,
            local_before,
        })
        .ok(),
        created: sticky_created,
    };
    let _ = outbox_import_record(conn, &pending_rec);

    let mut touched_entry_ids = Vec::new();
    let mut content_changed = false;
    let mut yjs_diff_bytes: Option<Vec<u8>> = None;

    if !intent.entry.yjs_full_state.is_empty() {
        if let Ok(update) = Update::decode_v1(&intent.entry.yjs_full_state) {
            let _ = local_doc.transact_mut().apply_update(update);
            let sv_after = local_doc.transact().state_vector();
            let diff = local_doc.transact().encode_diff_v1(&sv_before);
            if sv_before != sv_after || diff != [0, 0] {
                content_changed = true;
                yjs_diff_bytes = Some(diff);
            }
        }
    }

    if content_changed {
        let _ = snapshot_entry_version_impl(
            conn,
            &entry.id,
            existing_blob.as_deref().unwrap_or(&[]),
            entry.preview_text.as_deref().unwrap_or(""),
        );
        let full_state = local_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let intent_text = intent.entry.content_text.as_deref().unwrap_or("");
        let local_text = entry.content_text.as_deref().unwrap_or("");
        let is_clean_edit = if intent.entry.base_state_vector.is_empty() {
            sv_before.is_empty()
        } else {
            StateVector::decode_v1(&intent.entry.base_state_vector)
                .map(|base_sv| sv_before == base_sv)
                .unwrap_or(false)
        };
        let content_text = if !is_clean_edit
            && !local_text.is_empty()
            && !intent_text.is_empty()
            && local_text != intent_text
        {
            format!("{}\n{}", local_text, intent_text)
        } else if !intent_text.is_empty() {
            intent_text.to_string()
        } else {
            local_text.to_string()
        };
        let preview_text: String = content_text.chars().take(PREVIEW_MAX_CHARS).collect();
        let _ = save_entry_content_impl(conn, &entry.id, &full_state, &content_text, &preview_text);
        touched_entry_ids.push(entry.id.clone());
    }

    // Step 5: Fields decision
    let current_tag_ids = db::queries::get_tag_ids_for_entry(conn, &entry.id).unwrap_or_default();
    let current_fp = compute_metadata_fingerprint(
        entry.title.as_deref(),
        entry.entry_date,
        entry.emotion.as_deref(),
        entry.is_favorite,
        &entry.journal_id,
        &current_tag_ids,
    );
    let untouched = match (
        existing_import
            .as_ref()
            .and_then(|r| r.last_applied_updated_at),
        existing_import
            .as_ref()
            .and_then(|r| r.post_import_fingerprint.as_ref()),
    ) {
        (Some(last_applied), Some(last_fp)) => {
            local_before == last_applied && current_fp == *last_fp
        }
        _ => false,
    };

    let now = chrono::Utc::now().timestamp();
    let mut journal_or_tags_changed = false;

    // Field: title
    if let Some(t) = &intent.entry.fields.title {
        let key = format!("title@{}", t.change_seq);
        if !decided_map.contains_key(&key) {
            let local_title = entry.title.clone().unwrap_or_default();
            let (decision, should_apply) = evaluate_field(&local_title, t, local_before, untouched);
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply {
                if let Err(e) = update_entry_impl(conn, &entry.id, Some(&t.value), None, None) {
                    final_decision = "refused".to_string();
                    reason = Some(e);
                } else {
                    touched_entry_ids.push(entry.id.clone());
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "title".to_string(),
                    change_seq: t.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: entry_date
    if let Some(d) = &intent.entry.fields.entry_date {
        let key = format!("entry_date@{}", d.change_seq);
        if !decided_map.contains_key(&key) {
            let local_ts = entry.entry_date;
            let val_ts = parse_entry_date(&d.value);
            let base_ts = parse_entry_date(&d.base);
            let mut final_decision = "refused".to_string();
            let mut reason = None;

            if let Some(v_ts) = val_ts {
                if local_ts == v_ts {
                    final_decision = "reflected".to_string();
                } else if local_before == d.base_updated_at
                    || (untouched && Some(local_ts) == base_ts)
                {
                    if let Err(e) = update_entry_date_impl(conn, &entry.id, v_ts) {
                        final_decision = "refused".to_string();
                        reason = Some(e);
                    } else {
                        let _ = db::queries::mark_entry_date_user_edited(conn, &entry.id);
                        final_decision = "applied".to_string();
                        touched_entry_ids.push(entry.id.clone());
                    }
                }
            } else {
                reason = Some("invalid_date".to_string());
            }

            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "entry_date".to_string(),
                    change_seq: d.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: emotion
    if let Some(em) = &intent.entry.fields.emotion {
        let key = format!("emotion@{}", em.change_seq);
        if !decided_map.contains_key(&key) {
            let (decision, should_apply) =
                evaluate_field(&entry.emotion, em, local_before, untouched);
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply {
                if let Err(e) = update_entry_emotion_impl(conn, &entry.id, em.value.as_deref()) {
                    final_decision = "refused".to_string();
                    reason = Some(e);
                } else {
                    touched_entry_ids.push(entry.id.clone());
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "emotion".to_string(),
                    change_seq: em.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: is_favorite
    if let Some(f) = &intent.entry.fields.is_favorite {
        let key = format!("is_favorite@{}", f.change_seq);
        if !decided_map.contains_key(&key) {
            let (decision, should_apply) =
                evaluate_field(&entry.is_favorite, f, local_before, untouched);
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply {
                if entry.is_favorite != f.value {
                    if let Err(e) = toggle_favorite_impl(conn, &entry.id) {
                        final_decision = "refused".to_string();
                        reason = Some(e);
                    } else {
                        touched_entry_ids.push(entry.id.clone());
                    }
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "is_favorite".to_string(),
                    change_seq: f.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: journal_id
    if let Some(j) = &intent.entry.fields.journal_id {
        let key = format!("journal_id@{}", j.change_seq);
        if !decided_map.contains_key(&key) {
            let (decision, should_apply) =
                evaluate_field(&entry.journal_id, j, local_before, untouched);
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply {
                let target_visible = visible_journal(conn, &j.value).ok().flatten();
                let target_locked: bool = conn
                    .query_row(
                        "SELECT is_locked FROM journals WHERE id = ?1",
                        [&j.value],
                        |row| row.get(0),
                    )
                    .unwrap_or(false);
                if target_visible.is_some() && !target_locked {
                    if let Err(e) = move_entry_to_journal_impl(conn, &entry.id, &j.value) {
                        final_decision = "refused".to_string();
                        reason = Some(e);
                    } else {
                        touched_entry_ids.push(entry.id.clone());
                        journal_or_tags_changed = true;
                    }
                } else {
                    final_decision = "refused".to_string();
                    reason = Some("journal".to_string());
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: "journal_id".to_string(),
                    change_seq: j.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: tags_add
    for (tag_id, change) in &intent.entry.fields.tags_add {
        let key = format!("tag_add:{}@{}", tag_id, change.change_seq);
        if !decided_map.contains_key(&key) {
            let is_present = current_tag_ids.contains(tag_id);
            let (decision, should_apply) =
                evaluate_field(&is_present, change, local_before, untouched);
            let mut final_decision = decision.to_string();
            let mut reason = None;
            if should_apply {
                if let Ok(valid) = existing_tag_ids(conn, &[tag_id.as_str()]) {
                    if valid.contains(tag_id) {
                        let _ = db::queries::add_tag_to_entry(conn, &entry.id, tag_id);
                        let _ = db::queries::mark_entry_pending(conn, &entry.id);
                        touched_entry_ids.push(entry.id.clone());
                        journal_or_tags_changed = true;
                    } else {
                        final_decision = "refused".to_string();
                        reason = Some("tag_not_found".to_string());
                    }
                } else {
                    final_decision = "refused".to_string();
                    reason = Some("error".to_string());
                }
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: format!("tag_add:{}", tag_id),
                    change_seq: change.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Field: tags_remove
    for (tag_id, change) in &intent.entry.fields.tags_remove {
        let key = format!("tag_remove:{}@{}", tag_id, change.change_seq);
        if !decided_map.contains_key(&key) {
            let is_present = current_tag_ids.contains(tag_id);
            let (decision, should_apply) =
                evaluate_field(&!is_present, change, local_before, untouched);
            let final_decision = decision.to_string();
            let reason = None;
            if should_apply {
                let _ = db::queries::remove_tag_from_entry(conn, &entry.id, tag_id);
                let _ = db::queries::mark_entry_pending(conn, &entry.id);
                touched_entry_ids.push(entry.id.clone());
                journal_or_tags_changed = true;
            }
            decided_map.insert(
                key,
                OutboxFieldDecision {
                    field: format!("tag_remove:{}", tag_id),
                    change_seq: change.change_seq,
                    decision: final_decision,
                    decided_updated_at: now,
                    reason,
                },
            );
        }
    }

    // Step 6: Media
    if let Ok(media_created) = apply_media_items(
        conn,
        &ctx.media_dir,
        &entry.id,
        &intent.entry.media,
        &intent.media_payloads,
        &intent.media_thumb_payloads,
    ) {
        if media_created {
            touched_entry_ids.push(entry.id.clone());
        }
    }

    // Step 7: Language detection hook
    if !touched_entry_ids.is_empty() {
        maybe_detect_language_after_save(conn, &entry.id);
    }

    // Step 8: Final record
    let final_entry = db::queries::get_entry(conn, &entry.id)
        .ok()
        .flatten()
        .unwrap_or(entry);
    let final_tags = db::queries::get_tag_ids_for_entry(conn, &final_entry.id).unwrap_or_default();
    let final_fp = compute_metadata_fingerprint(
        final_entry.title.as_deref(),
        final_entry.entry_date,
        final_entry.emotion.as_deref(),
        final_entry.is_favorite,
        &final_entry.journal_id,
        &final_tags,
    );

    let rec = WebOutboxImportRecord {
        path: intent.path.clone(),
        revision: intent.revision.clone(),
        content_hash: intent.content_hash.clone(),
        outcome: "applied".to_string(),
        imported_at: now,
        last_applied_updated_at: Some(final_entry.updated_at),
        post_import_fingerprint: Some(final_fp),
        decided_fields: serde_json::to_string(&decided_map).ok(),
        pending_revision: None,
        pending_plan: None,
        created: sticky_created || intent.entry.created_on_web,
    };
    let _ = outbox_import_record(conn, &rec);

    touched_entry_ids.sort();
    touched_entry_ids.dedup();

    let bridge_event = if journal_or_tags_changed {
        Some(OutboxBridgeEvent {
            kind: "created".to_string(),
            entry_id: final_entry.id.clone(),
            journal_id: final_entry.journal_id.clone(),
            yjs_update: None,
            patch: None,
        })
    } else if content_changed || !touched_entry_ids.is_empty() {
        let mut patch = serde_json::Map::new();
        patch.insert(
            "updated_at".to_string(),
            serde_json::json!(final_entry.updated_at),
        );
        if let Some(t) = &final_entry.title {
            patch.insert("title".to_string(), serde_json::json!(t));
        }
        if let Some(e) = &final_entry.emotion {
            patch.insert("emotion".to_string(), serde_json::json!(e));
        }
        patch.insert(
            "is_favorite".to_string(),
            serde_json::json!(final_entry.is_favorite),
        );
        patch.insert(
            "entry_date".to_string(),
            serde_json::json!(final_entry.entry_date),
        );
        let kind = if content_changed {
            "appended"
        } else {
            "metadata"
        };
        Some(OutboxBridgeEvent {
            kind: kind.to_string(),
            entry_id: final_entry.id.clone(),
            journal_id: final_entry.journal_id.clone(),
            yjs_update: yjs_diff_bytes,
            patch: Some(serde_json::Value::Object(patch)),
        })
    } else {
        None
    };

    ApplyResult {
        outcome: Outcome::Applied,
        touched_entry_ids,
        bridge_event,
    }
}

/// Sink for bridge events, progress reports, and embedding dirty notifications.
pub trait OutboxEventSink: Send + Sync {
    fn emit_bridge_event(&self, event: &OutboxBridgeEvent);
    fn emit_progress(&self, current: u32, total: u32);
    fn mark_embedding_dirty(&self, entry_id: &str);
}

/// Production sink backed by Tauri AppHandle and AppState.
pub struct TauriOutboxSink<'a> {
    pub app: &'a tauri::AppHandle,
    pub state: &'a AppState,
}

impl<'a> OutboxEventSink for TauriOutboxSink<'a> {
    fn emit_bridge_event(&self, event: &OutboxBridgeEvent) {
        use tauri::Emitter;
        match event.kind.as_str() {
            "created" => {
                let payload = serde_json::json!({
                    "kind": "created",
                    "entryId": event.entry_id,
                    "journalId": event.journal_id,
                });
                let _ = self
                    .app
                    .emit(crate::commands::mcp::MCP_ENTRY_CHANGED_EVENT, payload);
            }
            "appended" => {
                let payload = serde_json::json!({
                    "kind": "appended",
                    "entryId": event.entry_id,
                    "journalId": event.journal_id,
                    "yjsUpdate": event.yjs_update,
                    "patch": event.patch,
                });
                let _ = self
                    .app
                    .emit(crate::commands::mcp::MCP_ENTRY_CHANGED_EVENT, payload);
            }
            "metadata" => {
                let payload = serde_json::json!({
                    "kind": "metadata",
                    "entryId": event.entry_id,
                    "journalId": event.journal_id,
                    "patch": event.patch,
                });
                let _ = self
                    .app
                    .emit(crate::commands::mcp::MCP_ENTRY_CHANGED_EVENT, payload);
            }
            _ => {}
        }
    }

    fn emit_progress(&self, current: u32, total: u32) {
        use tauri::Emitter;
        let event = SyncProgressEvent {
            phase: SyncProgressPhase::PullingEntries,
            current,
            total,
        };
        let _ = self
            .app
            .emit(crate::commands::sync::SYNC_PROGRESS_EVENT, event);
    }

    fn mark_embedding_dirty(&self, entry_id: &str) {
        use tauri::Manager;
        if let Some(indexer) = self.app.try_state::<crate::ai::indexer::EntryIndexer>() {
            maybe_mark_entry_embedding_dirty_after_save(self.state, &indexer, entry_id);
        }
    }
}

/// No-op sink for headless or default testing environments.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopOutboxSink;

impl OutboxEventSink for NoopOutboxSink {
    fn emit_bridge_event(&self, _event: &OutboxBridgeEvent) {}
    fn emit_progress(&self, _current: u32, _total: u32) {}
    fn mark_embedding_dirty(&self, _entry_id: &str) {}
}

/// Summary metrics of an outbox import cycle.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct OutboxImportSummary {
    pub candidates_checked: usize,
    pub intents_listed: usize,
    pub intents_applied: usize,
    pub intents_refused: usize,
    pub intents_transient: usize,
    pub intents_skipped_unchanged: usize,
    pub media_downloaded: usize,
    pub media_bytes_downloaded: u64,
    pub acks_written: bool,
}

/// Extract known entry IDs and their deletion status from fetched peer manifests.
pub fn collect_known_ids_from_manifests(
    manifests: &[(String, DeviceMetadata)],
) -> HashMap<String, bool> {
    let mut known = HashMap::new();
    for (_, m) in manifests {
        for e in &m.entries {
            known
                .entry(e.entry_id.clone())
                .and_modify(|d| *d = *d && e.is_deleted)
                .or_insert(e.is_deleted);
        }
    }
    known
}

/// Execute a full outbox import cycle against the given provider.
pub async fn run_outbox_import_cycle<C: ConnAccess, S: OutboxEventSink>(
    provider: &(dyn SyncProvider + Send + Sync),
    keyring_io: &(dyn KeyringV2Io + Send + Sync),
    own_device_id: &str,
    key_list: &ContentKeyList,
    known_ids: HashMap<String, bool>,
    pull_clean: bool,
    summary: &SyncSummary,
    media_dir: &Path,
    access: &C,
    sink: &S,
) -> Result<OutboxImportSummary, SyncError> {
    // 1. Discovery: find candidate web devices from device slots
    let slots = crate::sync::keyring_v2::io::list_device_slots(keyring_io).await?;
    let candidates: Vec<String> = slots
        .into_iter()
        .map(|s| s.device_id)
        .filter(|id| {
            id != own_device_id
                && !summary.fetched_manifests.contains(id)
                && !summary.unchanged_peers.contains(id)
        })
        .collect();

    // 2. Enumerate outbox files for each candidate
    let mut intent_paths = Vec::new();
    for candidate in &candidates {
        match provider.list_files(candidate, FileKind::Outbox).await {
            Ok(files) => {
                for file in files {
                    if file.ends_with(".bin") {
                        intent_paths.push(file);
                    }
                }
            }
            Err(e) => {
                log::warn!("outbox_import: list_files({candidate}, Outbox) failed: {e}");
            }
        }
    }
    intent_paths.sort();

    // 3. Check table rows & Read Own Acks
    let table_has_imports = access.with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT 1 FROM web_outbox_imports WHERE path != '__acks__' LIMIT 1")
            .map_err(sync_io)?;
        let exists = stmt.exists([]).map_err(sync_io)?;
        Ok(exists)
    })?;

    let mut own_acks = OutboxAcksV1 {
        schema_version: 1,
        desktop_device_id: own_device_id.to_string(),
        acks: vec![],
    };
    let mut own_acks_failed = false;
    let mut own_cloud_file_missing = false;

    if table_has_imports || !intent_paths.is_empty() {
        let acks_cloud_path = format!("{own_device_id}/outbox-acks.bin");
        match provider.read_file(&acks_cloud_path).await {
            Ok(bytes) => match open_outbox_acks(key_list, &bytes) {
                Ok(parsed) => {
                    own_acks = parsed;
                }
                Err(e) => {
                    log::error!("outbox_import: web acks unreadable: {e}");
                    own_acks_failed = true;
                }
            },
            Err(SyncError::NotFound(_)) => {
                own_cloud_file_missing = true;
            }
            Err(e) => {
                log::warn!("outbox_import: read own acks failed: {e}");
                own_acks_failed = true;
            }
        }
    }

    // 4. Per-Intent Processing Loop
    let start_time = Instant::now();
    const MAX_WALL_CLOCK: Duration = Duration::from_secs(60);
    const MAX_CHANGED_INTENTS: usize = 20;
    const MAX_MEDIA_BYTES: u64 = 200 * 1024 * 1024;
    const MAX_THUMB_BYTES: u64 = 2 * 1024 * 1024;

    let mut changed_intents_count = 0;
    let mut total_media_bytes: u64 = 0;
    let mut summary_out = OutboxImportSummary {
        candidates_checked: candidates.len(),
        intents_listed: intent_paths.len(),
        ..Default::default()
    };

    let own_acks_map: HashMap<String, OutboxAckEntry> = own_acks
        .acks
        .iter()
        .map(|a| (a.path.clone(), a.clone()))
        .collect();

    let effective_pull_clean = pull_clean && !own_acks_failed;

    for intent_path in intent_paths {
        if start_time.elapsed() >= MAX_WALL_CLOCK || changed_intents_count >= MAX_CHANGED_INTENTS {
            log::info!("outbox_import: budget reached, deferring remaining intents to next cycle");
            break;
        }

        let recorded =
            access.with_conn(|conn| outbox_import_get(conn, &intent_path).map_err(sync_io))?;
        let recorded_revision = recorded.as_ref().and_then(|r| r.revision.as_deref());
        let is_pending = recorded
            .as_ref()
            .and_then(|r| r.pending_plan.as_ref())
            .is_some();

        let (bytes, revision): (Vec<u8>, Option<String>) = if is_pending {
            match provider.read_file(&intent_path).await {
                Ok(b) => {
                    let rev = recorded_revision.map(|s| s.to_string());
                    (b, rev)
                }
                Err(e) => {
                    log::warn!("outbox_import: read_file({intent_path}) failed: {e}");
                    summary_out.intents_transient += 1;
                    continue;
                }
            }
        } else {
            match provider
                .read_file_if_changed(&intent_path, recorded_revision)
                .await
            {
                Ok(ConditionalRead::Unchanged) => {
                    summary_out.intents_skipped_unchanged += 1;
                    continue;
                }
                Ok(ConditionalRead::Changed { bytes, revision }) => (bytes, revision),
                Err(e) => {
                    log::warn!("outbox_import: read_file_if_changed({intent_path}) failed: {e}");
                    summary_out.intents_transient += 1;
                    continue;
                }
            }
        };

        changed_intents_count += 1;
        sink.emit_progress(changed_intents_count as u32, 20);

        let content_hash = hex::encode(sha2::Sha256::digest(&bytes));
        let entry = match open_outbox_entry(key_list, &bytes) {
            Ok(e) => e,
            Err(OutboxError::UnsupportedVersion(v)) => {
                log::warn!("outbox_import: intent {intent_path} unsupported version {v}");
                let rec = WebOutboxImportRecord {
                    path: intent_path.clone(),
                    revision: revision.clone(),
                    content_hash: content_hash.clone(),
                    outcome: "skipped_version".to_string(),
                    imported_at: chrono::Utc::now().timestamp(),
                    last_applied_updated_at: None,
                    post_import_fingerprint: None,
                    decided_fields: None,
                    pending_revision: None,
                    pending_plan: None,
                    created: false,
                };
                let _ = access.with_conn(|conn| outbox_import_record(conn, &rec).map_err(sync_io));
                summary_out.intents_refused += 1;
                continue;
            }
            Err(e) => {
                log::warn!("outbox_import: intent {intent_path} corrupt: {e}");
                let rec = WebOutboxImportRecord {
                    path: intent_path.clone(),
                    revision: revision.clone(),
                    content_hash: content_hash.clone(),
                    outcome: "corrupt".to_string(),
                    imported_at: chrono::Utc::now().timestamp(),
                    last_applied_updated_at: None,
                    post_import_fingerprint: None,
                    decided_fields: None,
                    pending_revision: None,
                    pending_plan: None,
                    created: false,
                };
                let _ = access.with_conn(|conn| outbox_import_record(conn, &rec).map_err(sync_io));
                summary_out.intents_refused += 1;
                continue;
            }
        };

        // Handle media downloads
        let mut media_payloads: HashMap<String, Option<Vec<u8>>> = HashMap::new();
        let mut media_thumb_payloads: HashMap<String, Option<Vec<u8>>> = HashMap::new();

        for m in &entry.media {
            if start_time.elapsed() >= MAX_WALL_CLOCK {
                log::info!("outbox_import: wall-clock budget reached during media download");
                media_payloads.insert(m.media_id.clone(), None);
                break;
            }

            let local_exists = access
                .with_conn(|conn| {
                    get_media(conn, &m.media_id)
                        .map(|row| row.is_some())
                        .map_err(sync_io)
                })
                .unwrap_or(false);

            if local_exists {
                media_payloads.insert(m.media_id.clone(), Some(vec![]));
                if m.has_thumb {
                    media_thumb_payloads.insert(m.media_id.clone(), Some(vec![]));
                }
                continue;
            }

            if total_media_bytes + m.size > MAX_MEDIA_BYTES {
                log::warn!("outbox_import: media budget exceeded, deferring intent {intent_path}");
                media_payloads.insert(m.media_id.clone(), None);
                break;
            }

            let m_path = format!("{}/outbox/m-{}", entry.web_device_id, m.media_id);
            let read_media_fut = provider.read_file(&m_path);
            let media_res =
                match tokio::time::timeout(Duration::from_secs(45), read_media_fut).await {
                    Ok(Ok(enc_bytes)) => {
                        let enc_len = enc_bytes.len() as u64;
                        if total_media_bytes + enc_len > MAX_MEDIA_BYTES {
                            log::warn!(
                                "outbox_import: media download exceeded budget ({enc_len} bytes)"
                            );
                            None
                        } else {
                            match open_media(key_list, &enc_bytes) {
                                Ok(dec) => {
                                    total_media_bytes += enc_len;
                                    summary_out.media_downloaded += 1;
                                    summary_out.media_bytes_downloaded += enc_len;
                                    sink.emit_progress(changed_intents_count as u32, 20);
                                    Some(dec)
                                }
                                Err(_) => None,
                            }
                        }
                    }
                    _ => None,
                };
            media_payloads.insert(m.media_id.clone(), media_res);

            if m.has_thumb {
                if start_time.elapsed() >= MAX_WALL_CLOCK {
                    log::info!("outbox_import: wall-clock budget reached during thumb download");
                    media_thumb_payloads.insert(m.media_id.clone(), None);
                    break;
                }
                let t_path = format!("{}/outbox/m-{}.thumb", entry.web_device_id, m.media_id);
                let read_thumb_fut = provider.read_file(&t_path);
                let thumb_res =
                    match tokio::time::timeout(Duration::from_secs(45), read_thumb_fut).await {
                        Ok(Ok(enc_bytes)) => {
                            let enc_len = enc_bytes.len() as u64;
                            if enc_len > MAX_THUMB_BYTES
                                || total_media_bytes + enc_len > MAX_MEDIA_BYTES
                            {
                                log::warn!(
                                "outbox_import: thumb download exceeded budget ({enc_len} bytes)"
                            );
                                None
                            } else {
                                match open_media(key_list, &enc_bytes) {
                                    Ok(dec) => {
                                        total_media_bytes += enc_len;
                                        Some(dec)
                                    }
                                    Err(_) => None,
                                }
                            }
                        }
                        _ => None,
                    };
                media_thumb_payloads.insert(m.media_id.clone(), thumb_res);
            }
        }

        let intent = OutboxIntent {
            path: intent_path.clone(),
            entry,
            content_hash,
            revision,
            media_payloads,
            media_thumb_payloads,
        };

        let ctx = ApplyContext {
            known_ids: known_ids.clone(),
            pull_clean: effective_pull_clean,
            own_acks: own_acks_map.clone(),
            media_dir: media_dir.to_path_buf(),
        };

        let apply_res = access.with_conn(|conn| Ok(apply_intent_full(conn, &ctx, &intent)))?;

        for entry_id in &apply_res.touched_entry_ids {
            sink.mark_embedding_dirty(entry_id);
        }

        if let Some(ref event) = apply_res.bridge_event {
            sink.emit_bridge_event(event);
        }

        match apply_res.outcome {
            Outcome::Applied => summary_out.intents_applied += 1,
            Outcome::Refused(_) => summary_out.intents_refused += 1,
            Outcome::Transient => summary_out.intents_transient += 1,
            Outcome::SkippedVersion(_) => summary_out.intents_refused += 1,
            Outcome::Corrupt(_) => summary_out.intents_refused += 1,
        }
    }

    // 5. Writing Acks (`outbox-acks.bin`)
    if !own_acks_failed {
        let table_rows = access.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT path, revision, content_hash, outcome, imported_at, last_applied_updated_at, \
                     post_import_fingerprint, decided_fields, pending_revision, pending_plan, created \
                     FROM web_outbox_imports WHERE path != '__acks__'",
                )
                .map_err(sync_io)?;
            let rows: Vec<WebOutboxImportRecord> = stmt
                .query_map([], |row| {
                    Ok(WebOutboxImportRecord {
                        path: row.get(0)?,
                        revision: row.get(1)?,
                        content_hash: row.get(2)?,
                        outcome: row.get(3)?,
                        imported_at: row.get(4)?,
                        last_applied_updated_at: row.get(5)?,
                        post_import_fingerprint: row.get(6)?,
                        decided_fields: row.get(7)?,
                        pending_revision: row.get(8)?,
                        pending_plan: row.get(9)?,
                        created: row.get(10)?,
                    })
                })
                .map_err(sync_io)?
                .filter_map(Result::ok)
                .collect();
            Ok(rows)
        })?;

        let has_cloud_created = own_acks.acks.iter().any(|a| a.created);
        let should_consider_acks = !table_rows.is_empty() || has_cloud_created;

        if should_consider_acks {
            let mut acks_map: BTreeMap<String, OutboxAckEntry> = BTreeMap::new();
            for cloud_ack in &own_acks.acks {
                if cloud_ack.created {
                    acks_map.insert(cloud_ack.path.clone(), cloud_ack.clone());
                }
            }

            for row in &table_rows {
                if row.outcome == "pending" {
                    continue;
                }
                let decided: Vec<OutboxFieldDecision> = row
                    .decided_fields
                    .as_deref()
                    .and_then(|s| {
                        serde_json::from_str::<BTreeMap<String, OutboxFieldDecision>>(s).ok()
                    })
                    .map(|m| m.into_values().collect())
                    .unwrap_or_default();

                let prior_created = acks_map.get(&row.path).map(|a| a.created).unwrap_or(false);
                let entry_created = row.created || prior_created;

                let refused_reason = if row.outcome == "refused" {
                    row.pending_plan.clone()
                } else {
                    None
                };

                acks_map.insert(
                    row.path.clone(),
                    OutboxAckEntry {
                        path: row.path.clone(),
                        content_hash: row.content_hash.clone(),
                        applied_updated_at: row.last_applied_updated_at,
                        decided,
                        created: entry_created,
                        refused_reason,
                    },
                );
            }

            let new_acks = OutboxAcksV1 {
                schema_version: 1,
                desktop_device_id: own_device_id.to_string(),
                acks: acks_map.into_values().collect(),
            };

            let plain_bytes = bincode::DefaultOptions::new()
                .with_fixint_encoding()
                .with_limit(memlore_core::outbox::MAX_OUTBOX_PAYLOAD_BYTES)
                .serialize(&new_acks)
                .map_err(|e| SyncError::Io(e.to_string()))?;

            let plain_hash = format!(
                "{}:{}",
                key_list.latest,
                hex::encode(sha2::Sha256::digest(&plain_bytes))
            );

            let last_written_hash = access
                .with_conn(|conn| outbox_import_get(conn, "__acks__").map_err(sync_io))?
                .map(|r| r.content_hash);

            let hash_changed = last_written_hash.as_deref() != Some(&plain_hash);
            let should_write = hash_changed || own_cloud_file_missing;

            if should_write {
                let sealed = seal_outbox_acks(key_list, &new_acks)
                    .map_err(|e| SyncError::Io(e.to_string()))?;
                let cloud_path = format!("{own_device_id}/outbox-acks.bin");
                provider.write_file(&cloud_path, &sealed).await?;

                let marker = WebOutboxImportRecord {
                    path: "__acks__".to_string(),
                    revision: None,
                    content_hash: plain_hash,
                    outcome: "written".to_string(),
                    imported_at: chrono::Utc::now().timestamp(),
                    last_applied_updated_at: None,
                    post_import_fingerprint: None,
                    decided_fields: None,
                    pending_revision: None,
                    pending_plan: None,
                    created: false,
                };
                access.with_conn(|conn| outbox_import_record(conn, &marker).map_err(sync_io))?;
                summary_out.acks_written = true;
            }
        }
    }

    Ok(summary_out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use memlore_core::outbox::{FieldChange, OutboxFields, OutboxMediaRef};
    use yrs::updates::encoder::Encode;
    use yrs::Text;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    fn default_journal_id(conn: &Connection) -> String {
        db::queries::list_journals(conn, None).unwrap()[0]
            .id
            .clone()
    }

    fn make_test_yjs(text: &str) -> Vec<u8> {
        let doc = Doc::new();
        let txt = doc.get_or_insert_text("default");
        txt.push(&mut doc.transact_mut(), text);
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        bytes
    }

    fn make_base_intent(entry_id: &str, web_device_id: &str) -> OutboxIntent {
        let entry = OutboxEntryV1 {
            schema_version: 1,
            entry_id: entry_id.to_string(),
            web_device_id: web_device_id.to_string(),
            created_on_web: false,
            web_updated_at_secs: 1000,
            base_state_vector: vec![0],
            yjs_full_state: vec![],
            content_text: None,
            preview_text: None,
            fields: OutboxFields::default(),
            media: vec![],
        };
        OutboxIntent {
            path: format!("{}/outbox/{}.bin", web_device_id, entry_id),
            entry,
            content_hash: "hash-1".to_string(),
            revision: Some("rev-1".to_string()),
            media_payloads: HashMap::new(),
            media_thumb_payloads: HashMap::new(),
        }
    }

    #[test]
    fn test_title_emotion_favorite_tags_apply_on_existing_entry() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        // Create local entry
        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Old Title"),
            Some("Content"),
            Some("Preview"),
            1_700_000_000,
        )
        .unwrap();

        // Create a local tag
        let tag = db::queries::create_tag(&conn, "Focus", None).unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "New Title".to_string(),
            base: "Old Title".to_string(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1001,
        });
        intent.entry.fields.emotion = Some(FieldChange {
            value: Some("good".to_string()),
            base: None,
            base_updated_at: local.updated_at,
            change_seq: 2,
            changed_at_secs: 1002,
        });
        intent.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: local.updated_at,
            change_seq: 3,
            changed_at_secs: 1003,
        });
        intent.entry.fields.tags_add.insert(
            tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: local.updated_at,
                change_seq: 4,
                changed_at_secs: 1004,
            },
        );

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let updated = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(updated.title.as_deref(), Some("New Title"));
        assert_eq!(updated.emotion.as_deref(), Some("good"));
        assert!(updated.is_favorite);

        let tags = db::queries::get_tag_ids_for_entry(&conn, &local.id).unwrap();
        assert!(tags.contains(&tag.id));
    }

    #[test]
    fn test_create_applies_every_field_and_auto_tags() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        // Configure auto-tag on default journal
        let auto_tag = db::queries::create_tag(&conn, "AutoTag", None).unwrap();
        db::queries::set_journal_auto_tags(&conn, &jid, &[auto_tag.id.clone()]).unwrap();

        let eid = "created-entry-12345";
        let yjs_bytes = make_test_yjs("Created on web text");

        let mut intent = make_base_intent(eid, "web-dev-1");
        intent.entry.created_on_web = true;
        intent.entry.yjs_full_state = yjs_bytes.clone();
        intent.entry.content_text = Some("Created on web text".to_string());
        intent.entry.preview_text = Some("Created on web text".to_string());
        intent.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent.entry.fields.title = Some(FieldChange {
            value: "Web Created".to_string(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1000,
        });
        intent.entry.fields.emotion = Some(FieldChange {
            value: Some("neutral".to_string()),
            base: None,
            base_updated_at: 0,
            change_seq: 3,
            changed_at_secs: 1000,
        });

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![eid.to_string()]);

        let created = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(created.title.as_deref(), Some("Web Created"));
        assert_eq!(created.content_text.as_deref(), Some("Created on web text"));
        assert_eq!(created.emotion.as_deref(), Some("neutral"));

        let content_blob = db::queries::get_entry_content(&conn, eid).unwrap().unwrap();
        assert_eq!(content_blob, yjs_bytes);

        // Auto-tag was attached
        let tags = db::queries::get_tag_ids_for_entry(&conn, eid).unwrap();
        assert!(tags.contains(&auto_tag.id));
    }

    #[test]
    fn test_absent_entry_live_in_peer_manifest_returns_transient() {
        let conn = setup_test_db();
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "absent-live-entry-1";
        ctx.known_ids.insert(eid.to_string(), false); // live

        let intent = make_base_intent(eid, "web-dev-1");
        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Transient);
        assert!(touched.is_empty());

        let record = outbox_import_get(&conn, &intent.path).unwrap();
        assert!(record.is_none(), "transient outcome must not be recorded");
    }

    #[test]
    fn test_web_creates_e_desktop_imports_web_edits_again_second_applies() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-and-edit";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent1.entry.fields.title = Some(FieldChange {
            value: "Initial Title".to_string(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1000,
        });

        let (outcome1, _) = apply_intent(&conn, &ctx, &intent1);
        assert_eq!(outcome1, Outcome::Applied);

        let entry_after1 = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(entry_after1.title.as_deref(), Some("Initial Title"));

        // Second intent: edits title
        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.title = Some(FieldChange {
            value: "Second Title".to_string(),
            base: "Initial Title".to_string(),
            base_updated_at: entry_after1.updated_at,
            change_seq: 3,
            changed_at_secs: 2000,
        });

        let (outcome2, touched2) = apply_intent(&conn, &ctx, &intent2);
        assert_eq!(outcome2, Outcome::Applied);
        assert_eq!(touched2, vec![eid.to_string()]);

        let entry_after2 = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(entry_after2.title.as_deref(), Some("Second Title"));
    }

    #[test]
    fn test_later_desktop_title_edit_wins() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Desktop First Title"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        // Web saw local at t0
        let t0 = 1000;
        conn.execute(
            "UPDATE entries SET updated_at = 1000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();

        // Desktop edits title at t1 (t1 > t0)
        let desktop_edited =
            update_entry_impl(&conn, &local.id, Some("Desktop Newer Title"), None, None).unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = 2000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();
        assert!(desktop_edited.updated_at >= t0);

        // Web attempts to apply an edit based on t0
        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "Web Stale Title".to_string(),
            base: "Desktop First Title".to_string(),
            base_updated_at: t0,
            change_seq: 1,
            changed_at_secs: 1005,
        });

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert!(touched.is_empty(), "stale title must not touch the entry");

        let entry_after = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(
            entry_after.title.as_deref(),
            Some("Desktop Newer Title"),
            "desktop edit must win"
        );
    }

    #[test]
    fn test_interleaved_desktop_title_and_web_emotion() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Original Title"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();
        let t0 = 1000;
        conn.execute(
            "UPDATE entries SET updated_at = 1000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();

        // Desktop retitles at t1.5 (2000 > 1000)
        update_entry_impl(&conn, &local.id, Some("Desktop Retitled"), None, None).unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = 2000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();

        // Web changes emotion at t2 with base_updated_at = t0
        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "Web Title".to_string(),
            base: "Original Title".to_string(),
            base_updated_at: t0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent.entry.fields.emotion = Some(FieldChange {
            value: Some("good".to_string()),
            base: None,
            base_updated_at: t0,
            change_seq: 2,
            changed_at_secs: 2000,
        });

        let (outcome, _touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        // Note: because desktop updated at t1.5, whole-entry base_updated_at differs,
        // so desktop title stays and web emotion is refused per whole-entry LWW
        let final_entry = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(final_entry.title.as_deref(), Some("Desktop Retitled"));
    }

    #[test]
    fn test_second_import_is_no_op() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Title"),
            Some("Body"),
            Some("Preview"),
            1_700_000_000,
        )
        .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "Title 2".to_string(),
            base: "Title".to_string(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1001,
        });

        let (outcome1, touched1) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome1, Outcome::Applied);
        assert_eq!(touched1, vec![local.id.clone()]);

        let after1 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        let updated_at1 = after1.updated_at;

        // Second import of the exact same intent
        let (outcome2, touched2) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome2, Outcome::Applied);
        assert!(touched2.is_empty(), "second import must touch nothing");

        let after2 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(
            after2.updated_at, updated_at1,
            "updated_at must remain unchanged"
        );
    }

    #[test]
    fn test_locked_invisible_deleted_targets_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        // 1. Deleted target
        let local_deleted = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("To Delete"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();
        crate::commands::entries::soft_delete_entry_impl(&conn, &local_deleted.id).unwrap();

        let intent_del = make_base_intent(&local_deleted.id, "web-dev-1");
        let (outcome_del, _) = apply_intent(&conn, &ctx, &intent_del);
        assert!(matches!(outcome_del, Outcome::Refused(_)));

        // 2. Locked target
        let local_locked = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Locked Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();
        conn.execute(
            "UPDATE entries SET is_locked = 1 WHERE id = ?1",
            [&local_locked.id],
        )
        .unwrap();

        let intent_lock = make_base_intent(&local_locked.id, "web-dev-1");
        let (outcome_lock, _) = apply_intent(&conn, &ctx, &intent_lock);
        assert!(matches!(outcome_lock, Outcome::Refused(_)));

        // 3. Invisible journal target
        let inv_journal = db::queries::create_journal(&conn, "Invisible Journal", None).unwrap();
        conn.execute(
            "UPDATE journals SET is_invisible = 1 WHERE id = ?1",
            [&inv_journal.id],
        )
        .unwrap();
        let local_inv_j = crate::commands::entries::create_entry_impl(
            &conn,
            &inv_journal.id,
            Some("Invis J Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let intent_inv_j = make_base_intent(&local_inv_j.id, "web-dev-1");
        let (outcome_inv_j, _) = apply_intent(&conn, &ctx, &intent_inv_j);
        assert!(matches!(outcome_inv_j, Outcome::Refused(_)));
    }

    #[test]
    fn test_deleted_tag_id_is_dropped_and_rest_applies() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Tag Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        // Valid tag
        let good_tag = db::queries::create_tag(&conn, "GoodTag", None).unwrap();
        // Deleted tag
        let del_tag = db::queries::create_tag(&conn, "DelTag", None).unwrap();
        db::queries::delete_tag(&conn, &del_tag.id).unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "Title Applied".to_string(),
            base: "Tag Entry".to_string(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent.entry.fields.tags_add.insert(
            good_tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: local.updated_at,
                change_seq: 2,
                changed_at_secs: 1000,
            },
        );
        intent.entry.fields.tags_add.insert(
            del_tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: local.updated_at,
                change_seq: 3,
                changed_at_secs: 1000,
            },
        );

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let updated = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(updated.title.as_deref(), Some("Title Applied"));

        let tags = db::queries::get_tag_ids_for_entry(&conn, &local.id).unwrap();
        assert!(tags.contains(&good_tag.id));
        assert!(!tags.contains(&del_tag.id));
    }

    #[test]
    fn test_no_resurrection_when_entry_in_known_ids_or_not_created_on_web_or_dirty_pull() {
        let conn = setup_test_db();
        let dir = tempfile::tempdir().unwrap();
        let eid = "resurrect-candidate-1";

        // 1. In known_ids as deleted -> Refused
        let mut ctx1 = ApplyContext::new(dir.path().to_path_buf());
        ctx1.known_ids.insert(eid.to_string(), true); // deleted

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        let (res1, _) = apply_intent(&conn, &ctx1, &intent1);
        assert_eq!(res1, Outcome::Refused("absent".to_string()));

        // 2. Not created on web and absent -> Refused
        let ctx2 = ApplyContext::new(dir.path().to_path_buf());
        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = false;
        let (res2, _) = apply_intent(&conn, &ctx2, &intent2);
        assert_eq!(res2, Outcome::Refused("absent".to_string()));

        // 3. Dirty pull -> Transient
        let mut ctx3 = ApplyContext::new(dir.path().to_path_buf());
        ctx3.pull_clean = false;
        let mut intent3 = make_base_intent(eid, "web-dev-1");
        intent3.entry.created_on_web = true;
        let (res3, _) = apply_intent(&conn, &ctx3, &intent3);
        assert_eq!(res3, Outcome::Transient);
    }

    #[test]
    fn test_media_keeps_id_and_cloud_path_passes_validation() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Media Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let mid = "media-uuid-12345";
        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.media.push(OutboxMediaRef {
            media_id: mid.to_string(),
            file_name: "photo.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            size: 4,
            has_thumb: true,
        });
        intent
            .media_payloads
            .insert(mid.to_string(), Some(vec![1, 2, 3, 4]));
        intent
            .media_thumb_payloads
            .insert(mid.to_string(), Some(vec![5, 6]));

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let media_row = db::queries::get_media(&conn, mid).unwrap().unwrap();
        assert_eq!(media_row.id, mid);
        assert_eq!(media_row.upload_status, "pending");

        // Construct expected cloud_path when desktop sync uploads it:
        let cloud_path = format!("desktop-dev-1/media/{mid}");
        let validated_dev = crate::commands::media::validate_cloud_path(&cloud_path, mid).unwrap();
        assert_eq!(validated_dev, "desktop-dev-1");
    }

    #[test]
    fn test_empty_base_non_creation_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Has Content"),
            Some("Some content"),
            Some("Some preview"),
            1_700_000_000,
        )
        .unwrap();

        let local_yjs = make_test_yjs("Some content");
        save_entry_content_impl(&conn, &local.id, &local_yjs, "Some content", "Some preview")
            .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.created_on_web = false;
        intent.entry.base_state_vector = vec![]; // empty base
        intent.entry.yjs_full_state = make_test_yjs("New content");

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Refused("empty_base".to_string()));
        assert!(touched.is_empty());
    }

    #[test]
    fn test_version_snapshot_is_taken_on_content_change() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Snapshot Entry"),
            Some("Old content"),
            Some("Old preview"),
            1_700_000_000,
        )
        .unwrap();

        let local_doc = Doc::new();
        let txt = local_doc.get_or_insert_text("default");
        txt.push(&mut local_doc.transact_mut(), "Old content");
        let local_yjs = local_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        save_entry_content_impl(&conn, &local.id, &local_yjs, "Old content", "Old preview")
            .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.base_state_vector = local_doc.transact().state_vector().encode_v1();

        let web_doc = Doc::new();
        let _ = web_doc
            .transact_mut()
            .apply_update(Update::decode_v1(&local_yjs).unwrap());
        let web_txt = web_doc.get_or_insert_text("default");
        web_txt.push(&mut web_doc.transact_mut(), " + web text");
        intent.entry.yjs_full_state = web_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        intent.entry.content_text = Some("Old content + web text".to_string());

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let versions = db::queries::list_entry_versions(&conn, &local.id).unwrap();
        assert_eq!(versions.len(), 1, "version snapshot must be recorded");

        // Second import of same intent: no snapshot
        let (outcome2, touched2) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome2, Outcome::Applied);
        assert!(touched2.is_empty());

        let versions2 = db::queries::list_entry_versions(&conn, &local.id).unwrap();
        assert_eq!(versions2.len(), 1, "no extra snapshot taken");
    }

    #[test]
    fn test_sync_state_pending_on_applied_change() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Sync State Test"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.title = Some(FieldChange {
            value: "New Title".to_string(),
            base: "Sync State Test".to_string(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        apply_intent(&conn, &ctx, &intent);

        let ver1 = db::queries::get_entry_local_version(&conn, &local.id)
            .unwrap()
            .unwrap();
        let sync_status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&local.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sync_status, "pending");

        // Second import: local_version stays unchanged
        apply_intent(&conn, &ctx, &intent);
        let ver2 = db::queries::get_entry_local_version(&conn, &local.id)
            .unwrap()
            .unwrap();
        assert_eq!(ver2, ver1);
    }

    #[test]
    fn test_missing_media_returns_transient_unrecorded() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Missing Media Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let mid = "media-missing-1";
        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.media.push(OutboxMediaRef {
            media_id: mid.to_string(),
            file_name: "photo.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            size: 100,
            has_thumb: false,
        });
        // Media payload is missing (None)
        intent.media_payloads.insert(mid.to_string(), None);

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Transient);
        assert!(touched.is_empty());

        let record = outbox_import_get(&conn, &intent.path).unwrap();
        assert!(record.is_none());
    }

    #[test]
    fn test_journal_id_to_locked_invisible_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Move Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        let locked_j = db::queries::create_journal(&conn, "Locked J", None).unwrap();
        conn.execute(
            "UPDATE journals SET is_locked = 1 WHERE id = ?1",
            [&locked_j.id],
        )
        .unwrap();

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.journal_id = Some(FieldChange {
            value: locked_j.id.clone(),
            base: jid.clone(),
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert!(touched.is_empty(), "entry must not move to locked journal");

        let after = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(after.journal_id, jid);

        let rec = outbox_import_get(&conn, &intent.path).unwrap().unwrap();
        assert_ne!(rec.outcome, "pending", "row must not be left pending");
    }

    #[test]
    fn test_race_content_only_then_title_applies_untouched() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Original Title"),
            Some("Initial body"),
            Some("Initial preview"),
            1_700_000_000,
        )
        .unwrap();
        let t0 = 1000;
        conn.execute(
            "UPDATE entries SET updated_at = 1000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();

        let local_yjs = make_test_yjs("Initial body");
        save_entry_content_impl(
            &conn,
            &local.id,
            &local_yjs,
            "Initial body",
            "Initial preview",
        )
        .unwrap();

        // Revision 1: Content only update
        let mut intent1 = make_base_intent(&local.id, "web-dev-1");
        let updated_yjs = make_test_yjs("Initial body + revision 1");
        let local_doc = load_yjs_doc(Some(&local_yjs)).unwrap();
        intent1.entry.base_state_vector = local_doc.transact().state_vector().encode_v1();
        intent1.entry.yjs_full_state = updated_yjs;
        intent1.entry.content_text = Some("Initial body + revision 1".to_string());
        intent1.entry.fields.title = None;

        let (res1, _) = apply_intent(&conn, &ctx, &intent1);
        assert_eq!(res1, Outcome::Applied);

        // Simulate updated_at bump to 2000
        conn.execute(
            "UPDATE entries SET updated_at = 2000 WHERE id = ?1",
            [&local.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE web_outbox_imports SET last_applied_updated_at = 2000 WHERE path = ?1",
            [&intent1.path],
        )
        .unwrap();

        let after1 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(after1.updated_at >= t0);
        assert_eq!(
            after1.content_text.as_deref(),
            Some("Initial body + revision 1"),
            "content-only edit on clean base vector must not duplicate text"
        );

        // Revision 2: Web carries title change made at t0 (base_updated_at = t0)
        let mut intent2 = make_base_intent(&local.id, "web-dev-1");
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.base_state_vector = Doc::new().transact().state_vector().encode_v1();
        intent2.entry.fields.title = Some(FieldChange {
            value: "Web Renamed Title".to_string(),
            base: "Original Title".to_string(),
            base_updated_at: t0,
            change_seq: 1,
            changed_at_secs: 1005,
        });

        let (res2, touched2) = apply_intent(&conn, &ctx, &intent2);
        assert_eq!(res2, Outcome::Applied);
        assert_eq!(touched2, vec![local.id.clone()]);

        let after2 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(
            after2.title.as_deref(),
            Some("Web Renamed Title"),
            "untouched title must apply"
        );
    }

    #[test]
    fn test_aba_single_desktop_recorded_decision() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("ABA Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        // 1. Web favorites E with change_seq = 1
        let mut intent1 = make_base_intent(&local.id, "web-dev-1");
        intent1.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        apply_intent(&conn, &ctx, &intent1);
        let e1 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(e1.is_favorite);

        // 2. User unfavorites locally on desktop
        toggle_favorite_impl(&conn, &local.id).unwrap();
        let e2 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(!e2.is_favorite);

        // 3. Web re-pushes revision with the same field change (change_seq = 1)
        let mut intent2 = make_base_intent(&local.id, "web-dev-1");
        intent2.revision = Some("rev-2".to_string());
        intent2.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        apply_intent(&conn, &ctx, &intent2);

        // E must stay unfavorited because decision was already recorded
        let e3 = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(
            !e3.is_favorite,
            "ABA decision record must protect local revert"
        );
    }

    #[test]
    fn test_same_second_revert_fingerprint_guard() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Same Second"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();

        // Intent applies
        let mut intent1 = make_base_intent(&local.id, "web-dev-1");
        intent1.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: local.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        apply_intent(&conn, &ctx, &intent1);

        // In same second, user reverts favorite
        toggle_favorite_impl(&conn, &local.id).unwrap();

        // Stale intent retry with different change_seq but same-second updated_at
        let mut intent2 = make_base_intent(&local.id, "web-dev-1");
        intent2.revision = Some("rev-2".to_string());
        intent2.entry.fields.is_favorite = Some(FieldChange {
            value: true,
            base: false,
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1000,
        });

        apply_intent(&conn, &ctx, &intent2);
        let e_final = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert!(
            !e_final.is_favorite,
            "fingerprint mismatch must prevent stale re-apply"
        );
    }

    #[test]
    fn test_emotion_clear_applied() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());

        let local = crate::commands::entries::create_entry_impl(
            &conn,
            &jid,
            Some("Emotion Entry"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap();
        update_entry_emotion_impl(&conn, &local.id, Some("good")).unwrap();
        let entry_with_emotion = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(entry_with_emotion.emotion.as_deref(), Some("good"));

        let mut intent = make_base_intent(&local.id, "web-dev-1");
        intent.entry.fields.emotion = Some(FieldChange {
            value: None,
            base: Some("good".to_string()),
            base_updated_at: entry_with_emotion.updated_at,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Applied);
        assert_eq!(touched, vec![local.id.clone()]);

        let cleared = db::queries::get_entry(&conn, &local.id).unwrap().unwrap();
        assert_eq!(cleared.emotion, None, "emotion must be cleared");
    }

    #[test]
    fn test_created_on_web_text_race_crdt_union() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-race-crdt-entry";

        // 1. Web creates E
        let yjs1 = make_test_yjs("Web Hello");
        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent1.entry.yjs_full_state = yjs1.clone();
        intent1.entry.content_text = Some("Web Hello".to_string());
        apply_intent(&conn, &ctx, &intent1);

        // 2. Desktop edits text locally before web pulls it
        let local_doc = Doc::new();
        let _ = local_doc
            .transact_mut()
            .apply_update(Update::decode_v1(&yjs1).unwrap());
        let txt = local_doc.get_or_insert_text("default");
        txt.push(&mut local_doc.transact_mut(), " + Desktop Local Edit");
        let local_yjs = local_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        save_entry_content_impl(
            &conn,
            eid,
            &local_yjs,
            "Web Hello + Desktop Local Edit",
            "Web Hello + Desktop Local Edit",
        )
        .unwrap();

        // 3. Web edits text again with created_on_web = true
        let web_doc = Doc::new();
        let _ = web_doc
            .transact_mut()
            .apply_update(Update::decode_v1(&yjs1).unwrap());
        let web_txt = web_doc.get_or_insert_text("default");
        web_txt.push(&mut web_doc.transact_mut(), " + Web Second Edit");
        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.revision = Some("rev-2".to_string());
        intent2.entry.created_on_web = true;
        intent2.entry.base_state_vector = vec![];
        let bytes2 = web_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        intent2.entry.yjs_full_state = bytes2;
        intent2.entry.content_text = Some("Web Hello + Web Second Edit".to_string());

        let (outcome2, touched2) = apply_intent(&conn, &ctx, &intent2);
        assert_eq!(outcome2, Outcome::Applied);
        assert_eq!(touched2, vec![eid.to_string()]);

        let final_entry = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        let text = final_entry.content_text.unwrap();
        assert!(text.contains("Desktop Local Edit"));
        assert!(text.contains("Web Second Edit"));
    }

    #[test]
    fn test_wipe_resurrection_guard_with_own_acks() {
        let conn = setup_test_db();
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "wiped-entry-123";

        // Own acks in cloud reports created: true
        ctx.own_acks.insert(
            format!("web-dev-1/outbox/{eid}.bin"),
            OutboxAckEntry {
                path: format!("web-dev-1/outbox/{eid}.bin"),
                content_hash: "hash-0".to_string(),
                applied_updated_at: Some(1000),
                decided: vec![],
                created: true,
                refused_reason: None,
            },
        );

        let mut intent = make_base_intent(eid, "web-dev-1");
        intent.entry.created_on_web = true;

        let (outcome, touched) = apply_intent(&conn, &ctx, &intent);
        assert_eq!(outcome, Outcome::Refused("absent".to_string()));
        assert!(touched.is_empty());

        let rec = outbox_import_get(&conn, &intent.path).unwrap().unwrap();
        assert!(rec.created, "sticky created flag must be set to 1");
    }

    #[derive(Default)]
    struct TestOutboxSink {
        progress_events: std::sync::Mutex<Vec<(u32, u32)>>,
        bridge_events: std::sync::Mutex<Vec<OutboxBridgeEvent>>,
        dirty_entries: std::sync::Mutex<Vec<String>>,
    }

    impl OutboxEventSink for TestOutboxSink {
        fn emit_bridge_event(&self, event: &OutboxBridgeEvent) {
            self.bridge_events.lock().unwrap().push(event.clone());
        }
        fn emit_progress(&self, current: u32, total: u32) {
            self.progress_events.lock().unwrap().push((current, total));
        }
        fn mark_embedding_dirty(&self, entry_id: &str) {
            self.dirty_entries
                .lock()
                .unwrap()
                .push(entry_id.to_string());
        }
    }

    fn test_key_list() -> ContentKeyList {
        ContentKeyList {
            keys: BTreeMap::from([(1, zeroize::Zeroizing::new([42u8; 32]))]),
            latest: 1,
            db_key: zeroize::Zeroizing::new([0u8; 32]),
            master: zeroize::Zeroizing::new([42u8; 32]),
        }
    }

    #[tokio::test]
    async fn test_import_cycle_no_web_devices_only_one_slot_listing() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";

        // Write only own desktop device slot
        let own_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: own_device_id.to_string(),
            name: "Desktop 1".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        crate::sync::keyring_v2::io::write_device_slot(&provider, &own_slot)
            .await
            .unwrap();

        let conn = setup_test_db();
        let key_list = test_key_list();
        let summary = SyncSummary::default();
        let sink = TestOutboxSink::default();

        let res = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(res.candidates_checked, 0);
        assert_eq!(res.intents_listed, 0);
        assert_eq!(res.intents_applied, 0);
    }

    #[tokio::test]
    async fn test_import_cycle_bridge_events_and_progress_emitted() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        use memlore_core::outbox::seal_outbox_entry;

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let sync_p: &(dyn SyncProvider + Send + Sync) = &provider;
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";
        let web_device_id = "22222222-2222-2222-2222-222222222222";

        // Register both slots
        let own_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: own_device_id.to_string(),
            name: "Desktop 1".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        let web_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: web_device_id.to_string(),
            name: "Web Companion".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        crate::sync::keyring_v2::io::write_device_slot(&provider, &own_slot)
            .await
            .unwrap();
        crate::sync::keyring_v2::io::write_device_slot(&provider, &web_slot)
            .await
            .unwrap();

        let key_list = test_key_list();
        let eid = "entry-web-created-1";
        let mut fields = OutboxFields::default();
        fields.title = Some(FieldChange {
            value: "Web Created Title".to_string(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        let entry = OutboxEntryV1 {
            schema_version: 1,
            entry_id: eid.to_string(),
            web_device_id: web_device_id.to_string(),
            created_on_web: true,
            web_updated_at_secs: 1000,
            base_state_vector: vec![],
            yjs_full_state: make_test_yjs("Content from web outbox"),
            content_text: Some("Content from web outbox".to_string()),
            preview_text: Some("Preview".to_string()),
            fields,
            media: vec![],
        };

        let sealed = seal_outbox_entry(&key_list, &entry).unwrap();
        sync_p
            .write_file(&format!("{web_device_id}/outbox/{eid}.bin"), &sealed)
            .await
            .unwrap();

        let conn = setup_test_db();
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        let sink = TestOutboxSink::default();

        let res = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(res.candidates_checked, 1);
        assert_eq!(res.intents_listed, 1);
        assert_eq!(res.intents_applied, 1);
        assert!(res.acks_written);

        // Progress emitted
        let progress = sink.progress_events.lock().unwrap();
        assert!(!progress.is_empty());
        assert_eq!(progress[0], (1, 20));

        // Bridge event emitted
        let bridge = sink.bridge_events.lock().unwrap();
        assert_eq!(bridge.len(), 1);
        assert_eq!(bridge[0].kind, "created");
        assert_eq!(bridge[0].entry_id, eid);

        // Dirty embedding marked
        let dirty = sink.dirty_entries.lock().unwrap();
        assert!(dirty.contains(&eid.to_string()));

        // Entry present in DB
        let db_entry = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(db_entry.title.as_deref(), Some("Web Created Title"));
        assert_eq!(
            db_entry.content_text.as_deref(),
            Some("Content from web outbox")
        );
    }

    #[tokio::test]
    async fn test_import_cycle_budget_limits_intents_to_20() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        use memlore_core::outbox::seal_outbox_entry;

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let sync_p: &(dyn SyncProvider + Send + Sync) = &provider;
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";
        let web_device_id = "33333333-3333-3333-3333-333333333333";

        let web_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: web_device_id.to_string(),
            name: "Web Companion".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        crate::sync::keyring_v2::io::write_device_slot(&provider, &web_slot)
            .await
            .unwrap();

        let key_list = test_key_list();

        // Write 25 intents: e-00 to e-24
        for i in 0..25 {
            let eid = format!("entry-bgt-{:02}", i);
            let mut fields = OutboxFields::default();
            fields.title = Some(FieldChange {
                value: format!("Title {i}"),
                base: "".to_string(),
                base_updated_at: 0,
                change_seq: 1,
                changed_at_secs: 1000,
            });

            let entry = OutboxEntryV1 {
                schema_version: 1,
                entry_id: eid.clone(),
                web_device_id: web_device_id.to_string(),
                created_on_web: true,
                web_updated_at_secs: 1000 + i as i64,
                base_state_vector: vec![],
                yjs_full_state: make_test_yjs(&format!("Content {i}")),
                content_text: Some(format!("Content {i}")),
                preview_text: Some("P".to_string()),
                fields,
                media: vec![],
            };
            let sealed = seal_outbox_entry(&key_list, &entry).unwrap();
            sync_p
                .write_file(&format!("{web_device_id}/outbox/{eid}.bin"), &sealed)
                .await
                .unwrap();
        }

        let conn = setup_test_db();
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        let sink = TestOutboxSink::default();

        let res = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(res.intents_listed, 25);
        assert_eq!(res.intents_applied, 20); // capped at 20!
    }

    #[tokio::test]
    async fn test_import_cycle_acks_written_and_self_heals() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        use memlore_core::outbox::seal_outbox_entry;

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let sync_p: &(dyn SyncProvider + Send + Sync) = &provider;
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";
        let web_device_id = "44444444-4444-4444-4444-444444444444";

        let web_slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: web_device_id.to_string(),
            name: "Web Companion".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        };
        crate::sync::keyring_v2::io::write_device_slot(&provider, &web_slot)
            .await
            .unwrap();

        let key_list = test_key_list();
        let eid = "entry-ack-test-1";
        let mut fields = OutboxFields::default();
        fields.title = Some(FieldChange {
            value: "Ack Test".to_string(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });

        let entry = OutboxEntryV1 {
            schema_version: 1,
            entry_id: eid.to_string(),
            web_device_id: web_device_id.to_string(),
            created_on_web: true,
            web_updated_at_secs: 1000,
            base_state_vector: vec![],
            yjs_full_state: make_test_yjs("Content"),
            content_text: Some("Content".to_string()),
            preview_text: Some("P".to_string()),
            fields,
            media: vec![],
        };
        let sealed = seal_outbox_entry(&key_list, &entry).unwrap();
        sync_p
            .write_file(&format!("{web_device_id}/outbox/{eid}.bin"), &sealed)
            .await
            .unwrap();

        let conn = setup_test_db();
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        let sink = TestOutboxSink::default();

        let res1 = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert!(res1.acks_written);

        // Acks file exists on provider
        let acks_path = format!("{own_device_id}/outbox-acks.bin");
        let acks_bytes = sync_p.read_file(&acks_path).await.unwrap();
        assert!(!acks_bytes.is_empty());

        // Now delete the acks file in the cloud to simulate cloud cleanup
        sync_p.delete_file(&acks_path).await.unwrap();
        assert!(sync_p.read_file(&acks_path).await.is_err());

        // Run cycle again: missing own file causes self-healing re-write!
        let res2 = run_outbox_import_cycle(
            &provider,
            &provider,
            own_device_id,
            &key_list,
            HashMap::new(),
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert!(
            res2.acks_written,
            "acks must self-heal when missing from cloud"
        );
        let healed_bytes = sync_p.read_file(&acks_path).await.unwrap();
        assert!(!healed_bytes.is_empty());
    }
}
