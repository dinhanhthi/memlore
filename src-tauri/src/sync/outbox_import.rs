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
//!    - `outbox/<entryId>.bin`: one entry intent (frame v1) per entry, updated in place.
//!    - Frame v2 intents, one file per target, updated in place: `outbox/j-<journalId>.bin`
//!      (create journal), `outbox/t-<tagId>.bin` (create tag), `outbox/p-<templateId>.bin`
//!      (upsert or delete template), `outbox/d-<entryId>.bin` (move entry to Trash). The
//!      file name must match the body's kind and id, or the file is `corrupt`.
//!    - Apply order in one cycle, across all web devices: `t-` → `j-` → `p-` → entry
//!      intents → `d-`, so a journal finds the auto tags created with it and an entry
//!      finds the journal / tags created with it.
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
//!   `require_writable_entry` refuses locked, invisible, or deleted entries. An entry in
//!   Trash is refused before it, with reason `entry_trashed`.
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
use std::time::Duration;

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
    soft_delete_entry_impl, toggle_favorite_impl, update_entry_date_impl,
    update_entry_emotion_impl, update_entry_impl,
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
    check_intent_name, open_outbox_acks, open_outbox_intent, parse_intent_name, seal_outbox_acks,
    FieldChange, OutboxAckEntry, OutboxAcksV1, OutboxEntryV1, OutboxError, OutboxFieldDecision,
    OutboxIntent as WireIntent, OutboxIntentPrefix, OutboxIntentV2, SUPPORTED_OUTBOX_VERSIONS,
};

const PREVIEW_MAX_CHARS: usize = 200;
/// Refusal reason (ack `refused_reason`) for a v1 edit to an entry in Trash.
const ENTRY_TRASHED: &str = "entry_trashed";
/// Refusal reasons for v2 intents (ack `refused_reason`).
const NAME_TAKEN: &str = "name_taken";
const CHANGED_ON_DESKTOP: &str = "changed_on_desktop";
/// A deterministic validation failure (bad color, name, base64, size, …): final.
const INVALID: &str = "invalid";
/// The target is unknown here and not live on any peer (shared with v1). v2 trash also
/// uses it for every locked, invisible or purged target, so a refusal reveals nothing.
const ABSENT: &str = "absent";

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
/// `own_prior`: every change to the row since the web's `base_updated_at` was an apply of this
/// path (the chain recorded in `applied_from_updated_at`, see `fast_forward_from`), so the local
/// value is the web's own earlier value. The web keeps the base of its first unresolved edit, and
/// a web create has the synthetic base `""` / 0, so `local_val == base` alone would refuse the
/// web's second edit of a field it already set.
fn evaluate_field<T: PartialEq>(
    local_val: &T,
    change: &FieldChange<T>,
    local_before: i64,
    untouched: bool,
    own_prior: bool,
) -> (&'static str, bool) {
    if local_val == &change.value {
        ("reflected", false)
    } else if local_before == change.base_updated_at {
        ("applied", true)
    } else if untouched && (local_val == &change.base || own_prior) {
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
    if !SUPPORTED_OUTBOX_VERSIONS.contains(&intent.entry.schema_version) {
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
            applied_from_updated_at: None,
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
            applied_from_updated_at: None,
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
                applied_from_updated_at: None,
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
                applied_from_updated_at: None,
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
                applied_from_updated_at: None,
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
                    applied_from_updated_at: None,
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
            applied_from_updated_at: None,
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
                applied_from_updated_at: Some(APPLIED_FROM_CREATED),
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
    // A trashed entry (`is_deleted = 1` + `trashed_at`) is read-only until
    // restored. Refuse with its own reason so the web can tell it apart from
    // a purged or missing entry (which stay on `require_writable_entry`).
    if raw_entry
        .as_ref()
        .is_some_and(|e| e.is_deleted && e.trashed_at.is_some())
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
            pending_plan: Some(ENTRY_TRASHED.to_string()),
            created: sticky_created,
            applied_from_updated_at: None,
        };
        let _ = outbox_import_record(conn, &rec);
        return ApplyResult {
            outcome: Outcome::Refused(ENTRY_TRASHED.to_string()),
            touched_entry_ids: vec![],
            bridge_event: None,
        };
    }
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
                applied_from_updated_at: None,
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
            applied_from_updated_at: None,
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
                applied_from_updated_at: None,
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
            applied_from_updated_at: None,
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
        // Kept so a crash-resume still sees this path's chain (`own_prior`).
        applied_from_updated_at: existing_import
            .as_ref()
            .and_then(|r| r.applied_from_updated_at),
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
        // The text is read from the merged doc, so it holds both sides'
        // edits exactly once, as the editor would save it.
        let (content_text, preview_text) = crate::yjs_doc::extract_entry_text(&full_state)
            .unwrap_or_else(|| {
                let text = intent
                    .entry
                    .content_text
                    .clone()
                    .or_else(|| entry.content_text.clone())
                    .unwrap_or_default();
                let preview = text.chars().take(PREVIEW_MAX_CHARS).collect();
                (text, preview)
            });
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
    // The web base this path's chain of applies started from, while nothing else touched the row.
    let chained_from = if untouched {
        existing_import
            .as_ref()
            .and_then(|r| r.applied_from_updated_at)
    } else {
        None
    };
    let own_prior = |base_updated_at: i64| chained_from == Some(base_updated_at);

    let now = chrono::Utc::now().timestamp();
    let mut journal_or_tags_changed = false;

    // Field: title
    if let Some(t) = &intent.entry.fields.title {
        let key = format!("title@{}", t.change_seq);
        if !decided_map.contains_key(&key) {
            let local_title = entry.title.clone().unwrap_or_default();
            let (decision, should_apply) = evaluate_field(
                &local_title,
                t,
                local_before,
                untouched,
                own_prior(t.base_updated_at),
            );
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
                    || (untouched && (Some(local_ts) == base_ts || own_prior(d.base_updated_at)))
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
            let (decision, should_apply) = evaluate_field(
                &entry.emotion,
                em,
                local_before,
                untouched,
                own_prior(em.base_updated_at),
            );
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
            let (decision, should_apply) = evaluate_field(
                &entry.is_favorite,
                f,
                local_before,
                untouched,
                own_prior(f.base_updated_at),
            );
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
            let (decision, should_apply) = evaluate_field(
                &entry.journal_id,
                j,
                local_before,
                untouched,
                own_prior(j.base_updated_at),
            );
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
            let (decision, should_apply) = evaluate_field(
                &is_present,
                change,
                local_before,
                untouched,
                own_prior(change.base_updated_at),
            );
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
            let (decision, should_apply) = evaluate_field(
                &!is_present,
                change,
                local_before,
                untouched,
                own_prior(change.base_updated_at),
            );
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
        // The web base this apply fast-forwarded from (see `fast_forward_from`): the
        // row's stamp before it, or, when only this importer's own applies touched the
        // row since (`untouched`), the base the previous apply recorded.
        applied_from_updated_at: if untouched {
            existing_import
                .as_ref()
                .and_then(|r| r.applied_from_updated_at)
                .or(Some(local_before))
        } else {
            Some(local_before)
        },
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
    /// Called right before an intent is applied, in apply order. Test hook.
    fn on_intent_dispatched(&self, _path: &str) {}
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
            phase: SyncProgressPhase::ImportingWebEdits,
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

/// Whether a recorded row must be re-read even though its file did not change: a
/// crash-interrupted apply, or an intent skipped for a version this build now reads (after
/// a desktop upgrade; v0.2.2 recorded every v2 file as `skipped_version` / "2"). Refused,
/// corrupt and other skipped_version rows also fill `pending_plan` (with their reason), but
/// they are final until the intent file changes.
fn is_pending(r: &WebOutboxImportRecord) -> bool {
    match r.outcome.as_str() {
        "pending" => r.pending_plan.is_some(),
        "skipped_version" => r
            .pending_plan
            .as_deref()
            .and_then(|v| v.parse::<u16>().ok())
            .is_some_and(|v| SUPPORTED_OUTBOX_VERSIONS.contains(&v)),
        _ => false,
    }
}

/// Apply rank of an intent kind. Baked into installed builds: tags run before the
/// journals whose `auto_tag_ids` reference them, creates run before the entry intents
/// that reference them, and trash runs last.
const RANK_TAG: u8 = 0;
const RANK_JOURNAL: u8 = 1;
const RANK_TEMPLATE: u8 = 2;
const RANK_ENTRY: u8 = 3;
const RANK_TRASH: u8 = 4;

fn prefix_rank(prefix: OutboxIntentPrefix) -> u8 {
    match prefix {
        OutboxIntentPrefix::Journal => RANK_JOURNAL,
        OutboxIntentPrefix::Tag => RANK_TAG,
        OutboxIntentPrefix::Template => RANK_TEMPLATE,
        OutboxIntentPrefix::Trash => RANK_TRASH,
    }
}

/// File name (last segment) of an outbox path.
fn outbox_file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Rank guessed from the file name alone, used for the READ order so that a budget cut
/// drops trash and entries, never the creates they depend on.
fn path_rank(path: &str) -> u8 {
    parse_intent_name(outbox_file_name(path)).map_or(RANK_ENTRY, |(p, _)| prefix_rank(p))
}

/// A decoded intent waiting for the apply pass.
enum Decoded {
    V1(Box<OutboxEntryV1>),
    V2(OutboxIntentV2),
}

struct DecodedIntent {
    path: String,
    content_hash: String,
    revision: Option<String>,
    body: Decoded,
}

impl DecodedIntent {
    fn sort_key(&self) -> (u8, i64, &str) {
        match &self.body {
            Decoded::V1(e) => (RANK_ENTRY, e.web_updated_at_secs, &self.path),
            Decoded::V2(i) => (prefix_rank(i.prefix()), v2_updated_at_secs(i), &self.path),
        }
    }
}

fn v2_updated_at_secs(intent: &OutboxIntentV2) -> i64 {
    match intent {
        OutboxIntentV2::CreateJournal {
            web_updated_at_secs,
            ..
        }
        | OutboxIntentV2::CreateTag {
            web_updated_at_secs,
            ..
        }
        | OutboxIntentV2::UpsertTemplate {
            web_updated_at_secs,
            ..
        }
        | OutboxIntentV2::DeleteTemplate {
            web_updated_at_secs,
            ..
        }
        | OutboxIntentV2::TrashEntry {
            web_updated_at_secs,
            ..
        } => *web_updated_at_secs,
    }
}

/// Check the decoded body against its file name: a v2 body needs the `<prefix><id>.bin`
/// name of its kind and id; a v1 body must not carry an intent prefix.
fn decode_named_intent(path: &str, intent: WireIntent) -> Result<Decoded, String> {
    let name = outbox_file_name(path);
    match intent {
        WireIntent::V1(entry) => match parse_intent_name(name) {
            Ok(_) => Err(format!("entry intent under an intent prefix: {name}")),
            Err(_) => Ok(Decoded::V1(Box::new(entry))),
        },
        WireIntent::V2(v2) => check_intent_name(name, &v2)
            .map(|()| Decoded::V2(v2))
            .map_err(|e| e.to_string()),
    }
}

/// `applied_from_updated_at` of an apply that created the row: there was no desktop
/// state for the web to miss, so any base fast-forwards. A legacy template row whose
/// `updated_at` is still the column default 0 records the same value; that only
/// loosens the check while the row is unchanged since the web's own write, which is
/// harmless, so leave it (the v1 crash-resume create path also restores 0).
const APPLIED_FROM_CREATED: i64 = 0;

/// Final decision for one v2 intent, before it is recorded.
enum V2Decision {
    /// Journal / tag created, or already present under this id.
    Created,
    /// Template / trash applied or already reflected. `at`: the row's `updated_at`
    /// after; `from`: the web base this write fast-forwarded from (see
    /// `fast_forward_from`), `None` when nothing was written.
    Applied { at: i64, from: Option<i64> },
    /// Final refusal with its ack reason code.
    Refused(String),
    /// Retry next cycle, nothing recorded.
    Transient,
}

/// Why a v2 decision could not be reached.
#[derive(Debug)]
enum DecideError {
    /// Deterministic: the same bytes fail the same way every cycle. Recorded as a
    /// final `invalid` refusal so a poison intent is read once, not every cycle.
    Invalid(String),
    /// DB / IO failure: retry next cycle, nothing recorded.
    Io(String),
}

impl From<rusqlite::Error> for DecideError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            // The db layer's input-validation error (tag name / color, template caps).
            rusqlite::Error::InvalidParameterName(m) => Self::Invalid(m),
            other => Self::Io(other.to_string()),
        }
    }
}

impl std::fmt::Display for DecideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "invalid: {m}"),
            Self::Io(m) => f.write_str(m),
        }
    }
}

/// Desktop-wins guard shared by template and trash intents. Passes when the web's
/// base is the row's current stamp, or when the only change since that base is the
/// web's own edit, which this importer applied from `own_path`: nothing touched the
/// row after that apply (row == recorded stamp) AND the apply fast-forwarded from the
/// same base (or created the row). A refused or merged edit records the row's stamp
/// too, but its `applied_from_updated_at` is the desktop's stamp, not the web's base.
///
/// Returns the web base the write fast-forwards from (record it as the new
/// `applied_from_updated_at`, so a chain of web edits from one base keeps passing),
/// or `None` when the desktop changed the row since the web's base.
///
/// TODO(later): see docs/LATER.md "Phase 14 review notes" — an upgrade/downgrade/re-upgrade
/// can leave a stale `applied_from_updated_at` next to a v0.2.2-written stamp.
fn fast_forward_from(
    conn: &Connection,
    base_updated_at: Option<i64>,
    row_updated_at: i64,
    own_path: &str,
) -> rusqlite::Result<Option<i64>> {
    if base_updated_at == Some(row_updated_at) {
        return Ok(base_updated_at);
    }
    Ok(outbox_import_get(conn, own_path)?.and_then(|r| {
        let from = r.applied_from_updated_at?;
        let chained = r.outcome == "applied"
            && r.last_applied_updated_at == Some(row_updated_at)
            && (from == APPLIED_FROM_CREATED || Some(from) == base_updated_at);
        chained.then_some(from)
    }))
}

fn decode_template_content(content_b64: Option<&str>) -> Result<Option<Vec<u8>>, DecideError> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    content_b64
        .map(|c| {
            B64.decode(c)
                .map_err(|_| DecideError::Invalid("content_b64: invalid base64".to_string()))
        })
        .transpose()
}

fn template_updated_at(conn: &Connection, id: &str) -> Result<i64, DecideError> {
    db::queries::get_template_for_import(conn, id)?
        .map(|r| r.updated_at)
        .ok_or_else(|| DecideError::Io(format!("template {id} vanished")))
}

#[allow(clippy::too_many_arguments)]
fn decide_upsert_template(
    conn: &Connection,
    path: &str,
    id: &str,
    name: &str,
    description: Option<&str>,
    content_b64: Option<&str>,
    sort_order: i64,
    base_updated_at: Option<i64>,
) -> Result<V2Decision, DecideError> {
    let content = decode_template_content(content_b64)?;
    let Some(row) = db::queries::get_template_for_import(conn, id)? else {
        if base_updated_at.is_some() {
            return Ok(V2Decision::Refused(ABSENT.to_string()));
        }
        db::queries::create_template_with_id(
            conn,
            id,
            name,
            description,
            content.as_deref(),
            sort_order,
        )?;
        return Ok(V2Decision::Applied {
            at: template_updated_at(conn, id)?,
            from: Some(APPLIED_FROM_CREATED),
        });
    };
    if row.is_predefined || row.is_deleted {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    }
    if row.name == name
        && row.description.as_deref() == description
        && row.content == content
        && row.sort_order == sort_order
    {
        return Ok(V2Decision::Applied {
            at: row.updated_at,
            from: None,
        });
    }
    let Some(from) = fast_forward_from(conn, base_updated_at, row.updated_at, path)? else {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    db::queries::update_template_with_sort_order(
        conn,
        id,
        name,
        description,
        content.as_deref(),
        sort_order,
    )?;
    Ok(V2Decision::Applied {
        at: template_updated_at(conn, id)?,
        from: Some(from),
    })
}

fn decide_delete_template(
    conn: &Connection,
    path: &str,
    id: &str,
    base_updated_at: i64,
) -> Result<V2Decision, DecideError> {
    let Some(row) = db::queries::get_template_for_import(conn, id)? else {
        // Upsert and delete share `p-<id>.bin`: a template created and deleted on the
        // web before any import arrives as a delete of a row that never existed here.
        return Ok(V2Decision::Applied {
            at: base_updated_at,
            from: None,
        });
    };
    if row.is_deleted {
        return Ok(V2Decision::Applied {
            at: row.updated_at,
            from: None,
        });
    }
    if row.is_predefined {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    }
    let Some(from) = fast_forward_from(conn, Some(base_updated_at), row.updated_at, path)? else {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    db::queries::delete_template(conn, id)?;
    Ok(V2Decision::Applied {
        at: template_updated_at(conn, id)?,
        from: Some(from),
    })
}

fn decide_trash_entry(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    entry_id: &str,
    base_updated_at: i64,
) -> Result<V2Decision, DecideError> {
    let Some(raw) = db::queries::get_entry_raw(conn, entry_id)? else {
        // Same presence rules as a v1 intent: live on a peer but not pulled yet → wait.
        return Ok(match ctx.known_ids.get(entry_id) {
            Some(false) => V2Decision::Transient,
            _ => V2Decision::Refused(ABSENT.to_string()),
        });
    };
    // Visibility first, and one reason for every hidden or gone target, so a refusal
    // (or the already-trashed shortcut below) never reveals that a locked or invisible
    // entry exists, nor its stamp.
    let journal_ok = db::queries::get_journal(conn, &raw.journal_id)?
        .is_some_and(|j| !j.is_deleted && !j.is_invisible && !j.is_locked);
    if raw.is_locked || raw.is_invisible || !journal_ok {
        return Ok(V2Decision::Refused(ABSENT.to_string()));
    }
    if raw.is_deleted {
        return Ok(match raw.trashed_at {
            // Already trashed, e.g. pulled from another desktop that applied this intent.
            Some(_) => V2Decision::Applied {
                at: raw.updated_at,
                from: None,
            },
            // Purged.
            None => V2Decision::Refused(ABSENT.to_string()),
        });
    }
    let entry = raw;
    // The same web device's `<entryId>.bin`, next to this `d-<entryId>.bin`.
    let dir = path.rsplit_once('/').map_or("", |(d, _)| d);
    let own_edit_path = format!("{dir}/{entry_id}.bin");
    let Some(from) = fast_forward_from(
        conn,
        Some(base_updated_at),
        entry.updated_at,
        &own_edit_path,
    )?
    else {
        return Ok(V2Decision::Refused(CHANGED_ON_DESKTOP.to_string()));
    };
    soft_delete_entry_impl(conn, entry_id).map_err(DecideError::Io)?;
    let stamp =
        db::queries::get_entry_raw(conn, entry_id)?.map_or(entry.updated_at, |e| e.updated_at);
    Ok(V2Decision::Applied {
        at: stamp,
        from: Some(from),
    })
}

fn decide_intent_v2(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    intent: &OutboxIntentV2,
) -> Result<V2Decision, DecideError> {
    let created = |o: db::queries::CreateWithIdOutcome| match o {
        db::queries::CreateWithIdOutcome::Created | db::queries::CreateWithIdOutcome::Exists => {
            V2Decision::Created
        }
        db::queries::CreateWithIdOutcome::NameTaken => V2Decision::Refused(NAME_TAKEN.to_string()),
    };
    // Already checked when the file was opened; repeated here so this entry point
    // never writes an intent the wire contract rejects.
    intent
        .validate()
        .map_err(|e| DecideError::Invalid(e.to_string()))?;
    match intent {
        OutboxIntentV2::CreateJournal {
            journal_id,
            name,
            color,
            auto_tag_ids,
            ..
        } => db::queries::create_journal_with_id(
            conn,
            journal_id,
            name,
            color.as_deref(),
            auto_tag_ids,
        )
        .map(created)
        .map_err(DecideError::from),
        OutboxIntentV2::CreateTag {
            tag_id,
            name,
            color,
            ..
        } => db::queries::create_tag_with_id(conn, tag_id, name, color.as_deref())
            .map(created)
            .map_err(DecideError::from),
        OutboxIntentV2::UpsertTemplate {
            template_id,
            name,
            description,
            content_b64,
            sort_order,
            base_updated_at,
            ..
        } => decide_upsert_template(
            conn,
            path,
            template_id,
            name,
            description.as_deref(),
            content_b64.as_deref(),
            *sort_order,
            *base_updated_at,
        ),
        OutboxIntentV2::DeleteTemplate {
            template_id,
            base_updated_at,
            ..
        } => decide_delete_template(conn, path, template_id, *base_updated_at),
        OutboxIntentV2::TrashEntry {
            entry_id,
            base_updated_at,
            ..
        } => decide_trash_entry(conn, ctx, path, entry_id, *base_updated_at),
    }
}

/// Apply one decoded v2 intent and record its outcome in `web_outbox_imports` the
/// way v1 does, so applied / refused are final until the file changes and the ack
/// carries `created` (creates), `applied_updated_at` (template / trash) or
/// `refused_reason`. Every apply is idempotent, so a crash between the write and
/// the record replays to the same result. A validation failure is a final `invalid`
/// refusal; transient and DB / IO errors record nothing and retry next cycle.
pub(crate) fn apply_intent_v2(
    conn: &Connection,
    ctx: &ApplyContext,
    path: &str,
    content_hash: &str,
    revision: Option<String>,
    intent: &OutboxIntentV2,
) -> Outcome {
    // Desktop behind its peers: a base comparison could refuse on stale rows.
    if !ctx.pull_clean {
        return Outcome::Transient;
    }
    let decision = match decide_intent_v2(conn, ctx, path, intent) {
        Ok(d) => d,
        Err(e @ DecideError::Invalid(_)) => {
            log::warn!("outbox_import: v2 intent {path} refused: {e}");
            V2Decision::Refused(INVALID.to_string())
        }
        Err(DecideError::Io(e)) => {
            log::warn!("outbox_import: v2 intent {path} failed: {e}");
            return Outcome::Transient;
        }
    };
    let (outcome, applied_at, applied_from, created, reason) = match decision {
        V2Decision::Transient => return Outcome::Transient,
        V2Decision::Created => (Outcome::Applied, None, None, true, None),
        V2Decision::Applied { at, from } => (Outcome::Applied, Some(at), from, false, None),
        V2Decision::Refused(code) => (
            Outcome::Refused(code.clone()),
            None,
            None,
            false,
            Some(code),
        ),
    };
    let rec = WebOutboxImportRecord {
        path: path.to_string(),
        revision,
        content_hash: content_hash.to_string(),
        outcome: if reason.is_some() {
            "refused"
        } else {
            "applied"
        }
        .to_string(),
        imported_at: chrono::Utc::now().timestamp(),
        last_applied_updated_at: applied_at,
        post_import_fingerprint: None,
        decided_fields: None,
        pending_revision: None,
        pending_plan: reason,
        created,
        applied_from_updated_at: applied_from,
    };
    let _ = outbox_import_record(conn, &rec);
    outcome
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
    // Read in apply-rank order (see `path_rank`).
    intent_paths.sort_by(|a, b| path_rank(a).cmp(&path_rank(b)).then_with(|| a.cmp(b)));

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
    let start_time = tokio::time::Instant::now();
    const MAX_WALL_CLOCK: Duration = Duration::from_secs(60);
    // The read pass stops here, so the apply pass always has time to record what was
    // read; otherwise slow reads could fill the budget and every cycle would re-read
    // the same files without applying any.
    const MAX_READ_WALL_CLOCK: Duration = Duration::from_secs(30);
    // Sealed bytes held for the apply pass (one intent is at most
    // MAX_OUTBOX_PAYLOAD_BYTES = 32 MiB, so 20 of them alone could reach 640 MiB).
    const MAX_DECODED_BYTES: usize = 64 * 1024 * 1024;
    const MAX_CHANGED_INTENTS: usize = 20;
    const MAX_MEDIA_BYTES: u64 = 200 * 1024 * 1024;
    const MAX_THUMB_BYTES: u64 = 2 * 1024 * 1024;

    let mut changed_intents_count = 0;
    let mut decoded_bytes: usize = 0;
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

    // 4a. Read + decode pass. Corrupt and unknown-version files are recorded here (final,
    // order-irrelevant); readable intents wait for the apply pass. Reading stops at
    // MAX_CHANGED_INTENTS files, MAX_READ_WALL_CLOCK, or once the held intents reach
    // MAX_DECODED_BYTES (checked before each read, so one intent may overshoot it by at
    // most MAX_OUTBOX_PAYLOAD_BYTES), so memory stays bounded.
    let mut decoded: Vec<DecodedIntent> = Vec::new();
    let checked_total = intent_paths.len() as u32;
    let mut checked_count: u32 = 0;
    for (checked, intent_path) in intent_paths.into_iter().enumerate() {
        if start_time.elapsed() >= MAX_READ_WALL_CLOCK
            || changed_intents_count >= MAX_CHANGED_INTENTS
            || decoded_bytes >= MAX_DECODED_BYTES
        {
            log::info!("outbox_import: budget reached, deferring remaining intents to next cycle");
            break;
        }
        checked_count = checked as u32 + 1;
        sink.emit_progress(checked_count, checked_total);

        let recorded =
            access.with_conn(|conn| outbox_import_get(conn, &intent_path).map_err(sync_io))?;
        let recorded_revision = recorded.as_ref().and_then(|r| r.revision.as_deref());
        let is_pending = recorded.as_ref().is_some_and(is_pending);

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

        let content_hash = hex::encode(sha2::Sha256::digest(&bytes));
        let opened = open_outbox_intent(key_list, &bytes)
            .map_err(|e| match e {
                // A supported frame version whose body disagrees is malformed, not newer.
                OutboxError::UnsupportedVersion(v) if SUPPORTED_OUTBOX_VERSIONS.contains(&v) => {
                    Err(format!("body version {v} does not match its frame"))
                }
                OutboxError::UnsupportedVersion(v) => Ok(v),
                other => Err(other.to_string()),
            })
            .and_then(|intent| decode_named_intent(&intent_path, intent).map_err(Err));

        changed_intents_count += 1;

        let body = match opened {
            Ok(body) => body,
            Err(Ok(v)) => {
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
                    pending_plan: Some(v.to_string()),
                    created: false,
                    applied_from_updated_at: None,
                };
                let _ = access.with_conn(|conn| outbox_import_record(conn, &rec).map_err(sync_io));
                summary_out.intents_refused += 1;
                continue;
            }
            Err(Err(e)) => {
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
                    applied_from_updated_at: None,
                };
                let _ = access.with_conn(|conn| outbox_import_record(conn, &rec).map_err(sync_io));
                summary_out.intents_refused += 1;
                continue;
            }
        };

        decoded_bytes += bytes.len();
        decoded.push(DecodedIntent {
            path: intent_path,
            content_hash,
            revision,
            body,
        });
    }

    // 4b. Apply pass, across all web devices: create_tag → create_journal → templates →
    // v1 entry intents → trash_entry; within a kind by `web_updated_at_secs`, then path.
    // Baked into installed builds: a journal must find its auto tags, and an entry the
    // journal / tags created with it.
    decoded.sort_by(|a, b| a.sort_key().cmp(&b.sort_key()));
    let ctx = ApplyContext {
        known_ids,
        pull_clean: effective_pull_clean,
        own_acks: own_acks_map,
        media_dir: media_dir.to_path_buf(),
    };
    for DecodedIntent {
        path: intent_path,
        content_hash,
        revision,
        body,
    } in decoded
    {
        // No wall-clock cut here: v2 and media-less v1 applies are local and cheap, and
        // the media download below defers its own intent (unrecorded) past the budget.
        let entry = match body {
            Decoded::V1(entry) => *entry,
            Decoded::V2(v2) => {
                sink.on_intent_dispatched(&intent_path);
                let outcome = access.with_conn(|conn| {
                    Ok(apply_intent_v2(
                        conn,
                        &ctx,
                        &intent_path,
                        &content_hash,
                        revision,
                        &v2,
                    ))
                })?;
                match outcome {
                    Outcome::Applied => summary_out.intents_applied += 1,
                    Outcome::Transient => summary_out.intents_transient += 1,
                    _ => summary_out.intents_refused += 1,
                }
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
                                    // Same count again: keeps the UI watchdog alive during
                                    // long media downloads.
                                    sink.emit_progress(checked_count, checked_total);
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

        sink.on_intent_dispatched(&intent.path);
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
                        applied_from_updated_at: None,
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
                    applied_from_updated_at: None,
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

    /// The web moves its own new entry to another journal before it has seen the desktop's
    /// copy: the second revision still carries the create's synthetic base (`""`, 0). The
    /// desktop has not touched the row since it imported the create, so the move applies.
    #[test]
    fn test_web_created_entry_moved_before_web_saw_desktop_copy_applies() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let web_journal = db::queries::create_journal(&conn, "Web Journal", None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-then-move";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        let (outcome1, _) = apply_intent(&conn, &ctx, &intent1);
        assert_eq!(outcome1, Outcome::Applied);

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.journal_id = Some(FieldChange {
            value: web_journal.id.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1001,
        });
        let (outcome2, _) = apply_intent(&conn, &ctx, &intent2);
        assert_eq!(outcome2, Outcome::Applied);

        let after = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(
            after.journal_id, web_journal.id,
            "the web's move must apply"
        );
        let rec = outbox_import_get(&conn, &intent2.path).unwrap().unwrap();
        let decided: BTreeMap<String, OutboxFieldDecision> =
            serde_json::from_str(rec.decided_fields.as_deref().unwrap()).unwrap();
        assert_eq!(decided["journal_id@2"].decision, "applied");
    }

    /// Resume from the update path's pending marker (a crash before the final record): the
    /// marker keeps `applied_from_updated_at`, so the resumed apply still sees the chain.
    #[test]
    fn test_web_created_entry_move_applies_after_crash_resume() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let web_journal = db::queries::create_journal(&conn, "Web Journal", None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-move-crash";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        assert_eq!(apply_intent(&conn, &ctx, &intent1).0, Outcome::Applied);

        // The pending marker as the update path writes it (chain kept), then a crash.
        let mut rec = outbox_import_get(&conn, &intent1.path).unwrap().unwrap();
        let local_before = db::queries::get_entry(&conn, eid)
            .unwrap()
            .unwrap()
            .updated_at;
        rec.outcome = "pending".to_string();
        rec.pending_revision = Some("rev-2".to_string());
        rec.pending_plan = serde_json::to_string(&PendingPlan {
            is_create: false,
            local_before,
        })
        .ok();
        outbox_import_record(&conn, &rec).unwrap();

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.journal_id = Some(FieldChange {
            value: web_journal.id.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1001,
        });
        apply_intent(&conn, &ctx, &intent2);

        let after = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(
            after.journal_id, web_journal.id,
            "the resumed move must apply"
        );
    }

    /// Same move, but the desktop moved the entry itself after importing the create: the
    /// desktop wins, and a later web edit of the field stays refused.
    #[test]
    fn test_web_created_entry_moved_after_desktop_moved_it_is_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let web_journal = db::queries::create_journal(&conn, "Web Journal", None).unwrap();
        let desk_journal = db::queries::create_journal(&conn, "Desk Journal", None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-desktop-moves";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        assert_eq!(apply_intent(&conn, &ctx, &intent1).0, Outcome::Applied);

        move_entry_to_journal_impl(&conn, eid, &desk_journal.id).unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = updated_at + 5 WHERE id = ?1",
            [eid],
        )
        .unwrap();

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.journal_id = Some(FieldChange {
            value: web_journal.id.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1001,
        });
        apply_intent(&conn, &ctx, &intent2);

        let after = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(
            after.journal_id, desk_journal.id,
            "the desktop's move must win"
        );
        let rec = outbox_import_get(&conn, &intent2.path).unwrap().unwrap();
        let decided: BTreeMap<String, OutboxFieldDecision> =
            serde_json::from_str(rec.decided_fields.as_deref().unwrap()).unwrap();
        assert_eq!(decided["journal_id@2"].decision, "refused");

        // The row is untouched since that import, but that import ran after the desktop's move,
        // so its chain starts at the desktop's stamp, not the web's base 0.
        let mut intent3 = make_base_intent(eid, "web-dev-1");
        intent3.entry.created_on_web = true;
        intent3.revision = Some("rev-3".to_string());
        intent3.content_hash = "hash-3".to_string();
        intent3.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 3,
            changed_at_secs: 1002,
        });
        apply_intent(&conn, &ctx, &intent3);
        let after3 = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(after3.journal_id, desk_journal.id, "the desktop still wins");
    }

    /// A desktop rename, then a web revision that does not decide the title (it re-baselines
    /// `untouched`), then a web rename on the create's synthetic base: the desktop still wins.
    #[test]
    fn test_web_rename_after_desktop_rename_and_unrelated_revision_is_refused() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-desktop-renames";
        let title = |value: &str, seq: u64| {
            Some(FieldChange {
                value: value.to_string(),
                base: "".to_string(),
                base_updated_at: 0,
                change_seq: seq,
                changed_at_secs: 1000,
            })
        };

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent1.entry.fields.title = title("A", 2);
        assert_eq!(apply_intent(&conn, &ctx, &intent1).0, Outcome::Applied);

        conn.execute(
            "UPDATE entries SET title = 'B', updated_at = updated_at + 5 WHERE id = ?1",
            [eid],
        )
        .unwrap();

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.emotion = Some(FieldChange {
            value: Some("good".to_string()),
            base: None,
            base_updated_at: 0,
            change_seq: 3,
            changed_at_secs: 1001,
        });
        apply_intent(&conn, &ctx, &intent2);
        // The desktop rename broke the chain: the unrelated web edit is refused too.
        let after2 = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(after2.emotion, None);

        let mut intent3 = make_base_intent(eid, "web-dev-1");
        intent3.entry.created_on_web = true;
        intent3.revision = Some("rev-3".to_string());
        intent3.content_hash = "hash-3".to_string();
        intent3.entry.fields.title = title("C", 4);
        apply_intent(&conn, &ctx, &intent3);

        let after = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        assert_eq!(
            after.title.as_deref(),
            Some("B"),
            "the desktop's rename must win"
        );
    }

    /// The web tags its new entry, then untags it before seeing the desktop copy.
    #[test]
    fn test_web_created_entry_tag_removed_before_web_saw_desktop_copy_applies() {
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let tag = db::queries::create_tag(&conn, "Focus", None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-create-then-untag";

        let mut intent1 = make_base_intent(eid, "web-dev-1");
        intent1.entry.created_on_web = true;
        intent1.entry.fields.journal_id = Some(FieldChange {
            value: jid.clone(),
            base: "".to_string(),
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 1000,
        });
        intent1.entry.fields.tags_add.insert(
            tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: 0,
                change_seq: 2,
                changed_at_secs: 1000,
            },
        );
        assert_eq!(apply_intent(&conn, &ctx, &intent1).0, Outcome::Applied);
        assert!(db::queries::get_tag_ids_for_entry(&conn, eid)
            .unwrap()
            .contains(&tag.id));

        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.entry.created_on_web = true;
        intent2.revision = Some("rev-2".to_string());
        intent2.content_hash = "hash-2".to_string();
        intent2.entry.fields.tags_remove.insert(
            tag.id.clone(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: 0,
                change_seq: 3,
                changed_at_secs: 1001,
            },
        );
        apply_intent(&conn, &ctx, &intent2);
        assert!(!db::queries::get_tag_ids_for_entry(&conn, eid)
            .unwrap()
            .contains(&tag.id));
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
        // A trashed target is refused with its own reason, which is what the
        // ack carries (`refused_reason` comes from `pending_plan`).
        assert_eq!(outcome_del, Outcome::Refused("entry_trashed".to_string()));
        let rec = outbox_import_get(&conn, &intent_del.path).unwrap().unwrap();
        assert_eq!(rec.outcome, "refused");
        assert_eq!(rec.pending_plan.as_deref(), Some("entry_trashed"));

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
        use yrs::types::xml::XmlIn;
        use yrs::{XmlElementPrelim, XmlFragment, XmlTextPrelim};

        fn add_paragraph(base: &[u8], text: &str) -> Vec<u8> {
            let doc = Doc::new();
            let _ = doc
                .transact_mut()
                .apply_update(Update::decode_v1(base).unwrap());
            let fragment = doc.get_or_insert_xml_fragment("default");
            fragment.push_back(
                &mut doc.transact_mut(),
                XmlElementPrelim::new("paragraph", [XmlIn::from(XmlTextPrelim::new(text))]),
            );
            let bytes = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            bytes
        }

        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        let eid = "web-race-crdt-entry";

        // 1. Web creates E
        let (yjs1, _, _) = crate::yjs_doc::build_entry_yjs(&["Web Hello"], &[]);
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
        let local_yjs = add_paragraph(&yjs1, "Desktop Local Edit");
        save_entry_content_impl(
            &conn,
            eid,
            &local_yjs,
            "Web Hello\nDesktop Local Edit",
            "Web Hello\nDesktop Local Edit",
        )
        .unwrap();

        // 3. Web edits text again with created_on_web = true
        let mut intent2 = make_base_intent(eid, "web-dev-1");
        intent2.revision = Some("rev-2".to_string());
        intent2.entry.created_on_web = true;
        intent2.entry.base_state_vector = vec![];
        intent2.entry.yjs_full_state = add_paragraph(&yjs1, "Web Second Edit");
        intent2.entry.content_text = Some("Web Hello\nWeb Second Edit".to_string());

        let (outcome2, touched2) = apply_intent(&conn, &ctx, &intent2);
        assert_eq!(outcome2, Outcome::Applied);
        assert_eq!(touched2, vec![eid.to_string()]);

        // The text is the merged doc's, not either side's copy: both edits
        // once, the shared base once, and the excerpt matches it.
        let final_entry = db::queries::get_entry(&conn, eid).unwrap().unwrap();
        let blob = db::queries::get_entry_content(&conn, eid).unwrap().unwrap();
        let (want_text, want_preview) = crate::yjs_doc::extract_entry_text(&blob).unwrap();
        let text = final_entry.content_text.unwrap();
        assert_eq!(text, want_text);
        assert_eq!(final_entry.preview_text.unwrap(), want_preview);
        assert_eq!(text.matches("Web Hello").count(), 1);
        assert_eq!(text.matches("Desktop Local Edit").count(), 1);
        assert_eq!(text.matches("Web Second Edit").count(), 1);
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
        dispatched: std::sync::Mutex<Vec<String>>,
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
        fn on_intent_dispatched(&self, path: &str) {
            self.dispatched.lock().unwrap().push(path.to_string());
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
        assert_eq!(progress[0], (1, 1)); // files checked / files listed
        assert!(progress.iter().all(|&(_, total)| total == 1));

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

    /// A refused intent stores its reason in `pending_plan`; that must not mark it as a
    /// crash-pending intent, or it is re-downloaded every cycle and starves the budget.
    #[tokio::test]
    async fn test_import_cycle_refused_intents_are_not_reprocessed() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        use memlore_core::outbox::seal_outbox_entry;

        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let sync_p: &(dyn SyncProvider + Send + Sync) = &provider;
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();

        let own_device_id = "11111111-1111-1111-1111-111111111111";
        let web_device_id = "55555555-5555-5555-5555-555555555555";

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

        // 25 edits of entries this desktop has never seen and that were not created on the
        // web: each one is refused ("absent") and recorded.
        for i in 0..25 {
            let eid = format!("entry-ref-{:02}", i);
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
                created_on_web: false,
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
        let mut results = Vec::new();
        for _ in 0..3 {
            results.push(
                run_outbox_import_cycle(
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
                .unwrap(),
            );
        }

        assert_eq!(results[0].intents_refused, 20);
        // Cycle 2 skips the 20 already-refused intents and reaches the last 5.
        assert_eq!(results[1].intents_skipped_unchanged, 20);
        assert_eq!(results[1].intents_refused, 5);
        // Cycle 3 downloads nothing: every refusal is final until the intent file changes.
        assert_eq!(results[2].intents_skipped_unchanged, 25);
        assert_eq!(results[2].intents_refused, 0);

        // A version skip stays skipped while the version is unknown, and is re-read once this
        // build understands it (a desktop upgrade), even though the file did not change.
        let first = format!("{web_device_id}/outbox/entry-ref-00.bin");
        let cycle_with_skipped_version = async |version: &str| {
            conn.execute(
                "UPDATE web_outbox_imports SET outcome = 'skipped_version', pending_plan = ?1 \
                 WHERE path = ?2",
                rusqlite::params![version, first],
            )
            .unwrap();
            run_outbox_import_cycle(
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
            .unwrap()
        };
        let unknown = cycle_with_skipped_version("999").await;
        assert_eq!(unknown.intents_skipped_unchanged, 25);
        let now_known =
            cycle_with_skipped_version(&memlore_core::outbox::OUTBOX_SCHEMA_VERSION.to_string())
                .await;
        assert_eq!(now_known.intents_skipped_unchanged, 24);
        assert_eq!(now_known.intents_refused, 1);
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

    // ---- Phase 14.1: version dispatch + apply order ----

    const V2_OWN: &str = "11111111-1111-1111-1111-111111111111";
    const V2_WEB_A: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const V2_WEB_B: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    /// Provider with a device slot for every given web device.
    async fn v2_fixture(
        web_ids: &[&str],
    ) -> (
        tempfile::TempDir,
        crate::sync::local_provider::LocalSyncProvider,
        PathBuf,
    ) {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        let temp_dir = tempfile::tempdir().unwrap();
        let provider = crate::sync::golden_fixtures::fenced_provider(temp_dir.path(), 0);
        let media_dir = temp_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();
        for id in web_ids {
            let slot = DeviceSlotV2 {
                version: KEYRING_V2_VERSION,
                device_id: id.to_string(),
                name: "Web Companion".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
            };
            crate::sync::keyring_v2::io::write_device_slot(&provider, &slot)
                .await
                .unwrap();
        }
        (temp_dir, provider, media_dir)
    }

    async fn v2_cycle(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        media_dir: &Path,
        conn: &Connection,
        sink: &TestOutboxSink,
    ) -> OutboxImportSummary {
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        run_outbox_import_cycle(
            provider,
            provider,
            V2_OWN,
            &test_key_list(),
            HashMap::new(),
            true,
            &summary,
            media_dir,
            conn,
            sink,
        )
        .await
        .unwrap()
    }

    async fn write_v2(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        path: &str,
        intent: &memlore_core::outbox::OutboxIntentV2,
    ) {
        let sealed = memlore_core::outbox::seal_outbox_intent_v2(&test_key_list(), intent).unwrap();
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        p.write_file(path, &sealed).await.unwrap();
    }

    async fn write_v1(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        path: &str,
        entry: &OutboxEntryV1,
    ) {
        let sealed = memlore_core::outbox::seal_outbox_entry(&test_key_list(), entry).unwrap();
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        p.write_file(path, &sealed).await.unwrap();
    }

    fn v2_journal(web: &str, id: &str, ts: i64) -> memlore_core::outbox::OutboxIntentV2 {
        memlore_core::outbox::OutboxIntentV2::CreateJournal {
            web_device_id: web.to_string(),
            web_updated_at_secs: ts,
            journal_id: id.to_string(),
            name: format!("Journal {id}"),
            color: None,
            auto_tag_ids: vec![],
        }
    }

    fn v2_tag(web: &str, id: &str, ts: i64) -> memlore_core::outbox::OutboxIntentV2 {
        memlore_core::outbox::OutboxIntentV2::CreateTag {
            web_device_id: web.to_string(),
            web_updated_at_secs: ts,
            tag_id: id.to_string(),
            name: format!("Tag {id}"),
            color: None,
        }
    }

    fn v1_edit(web: &str, entry_id: &str, ts: i64) -> OutboxEntryV1 {
        let fields = OutboxFields {
            title: Some(FieldChange {
                value: "Edited".to_string(),
                base: "".to_string(),
                base_updated_at: 0,
                change_seq: 1,
                changed_at_secs: ts,
            }),
            ..Default::default()
        };
        OutboxEntryV1 {
            schema_version: 1,
            entry_id: entry_id.to_string(),
            web_device_id: web.to_string(),
            created_on_web: false,
            web_updated_at_secs: ts,
            base_state_vector: vec![],
            yjs_full_state: make_test_yjs("Body"),
            content_text: Some("Body".to_string()),
            preview_text: Some("Body".to_string()),
            fields,
            media: vec![],
        }
    }

    fn import_row(conn: &Connection, path: &str) -> Option<WebOutboxImportRecord> {
        outbox_import_get(conn, path).unwrap()
    }

    #[test]
    fn test_is_pending_skipped_version_rows_follow_supported_versions() {
        let row = |outcome: &str, plan: Option<&str>| WebOutboxImportRecord {
            path: "p".to_string(),
            revision: None,
            content_hash: "h".to_string(),
            outcome: outcome.to_string(),
            imported_at: 0,
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: None,
            pending_revision: None,
            pending_plan: plan.map(str::to_string),
            created: false,
            applied_from_updated_at: None,
        };
        assert!(is_pending(&row("skipped_version", Some("1"))));
        assert!(is_pending(&row("skipped_version", Some("2"))));
        assert!(!is_pending(&row("skipped_version", Some("3"))));
        assert!(!is_pending(&row("skipped_version", Some("999"))));
        assert!(!is_pending(&row("skipped_version", Some("abc"))));
        assert!(!is_pending(&row("skipped_version", None)));
        assert!(is_pending(&row("pending", Some("{}"))));
        assert!(!is_pending(&row("pending", None)));
        assert!(!is_pending(&row("corrupt", Some("2"))));
        assert!(!is_pending(&row("refused", Some("2"))));
    }

    /// v1 files go through the v1 apply path, v2 files through the v2 one; both are
    /// recorded, so neither is re-read next cycle.
    #[tokio::test]
    async fn test_cycle_dispatches_per_version() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let eid = "entry-dispatch-0001";
        let jid = "journal-dispatch-01";
        let v1_path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        let v2_path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v1(&provider, &v1_path, &v1_edit(V2_WEB_A, eid, 1000)).await;
        write_v2(&provider, &v2_path, &v2_journal(V2_WEB_A, jid, 1000)).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;

        assert_eq!(res.intents_listed, 2);
        assert_eq!(res.intents_refused, 1, "v1 edit of an unknown entry");
        assert_eq!(res.intents_applied, 1, "v2 journal create");
        assert_eq!(import_row(&conn, &v1_path).unwrap().outcome, "refused");
        assert_eq!(import_row(&conn, &v2_path).unwrap().outcome, "applied");
        assert_eq!(
            *sink.dispatched.lock().unwrap(),
            vec![v2_path.clone(), v1_path.clone()]
        );

        let sink2 = TestOutboxSink::default();
        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink2).await;
        assert_eq!(res2.intents_skipped_unchanged, 2);
        assert!(sink2.dispatched.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_cycle_name_kind_mismatch_is_corrupt() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let tid = "tag-mismatch-00001";
        // Tag body under a journal prefix.
        let wrong_prefix = format!("{V2_WEB_A}/outbox/j-{tid}.bin");
        write_v2(&provider, &wrong_prefix, &v2_tag(V2_WEB_A, tid, 1)).await;
        // Right prefix, other id.
        let wrong_id = format!("{V2_WEB_A}/outbox/t-tag-other-000001.bin");
        write_v2(&provider, &wrong_id, &v2_tag(V2_WEB_A, tid, 1)).await;
        // v2 body in a bare entry name.
        let bare = format!("{V2_WEB_A}/outbox/{tid}.bin");
        write_v2(&provider, &bare, &v2_tag(V2_WEB_A, tid, 1)).await;
        // v1 body under an intent prefix.
        let eid = "entry-mismatch-0001";
        let v1_prefixed = format!("{V2_WEB_A}/outbox/d-{eid}.bin");
        write_v1(&provider, &v1_prefixed, &v1_edit(V2_WEB_A, eid, 1)).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;

        assert_eq!(res.intents_refused, 4);
        for path in [&wrong_prefix, &wrong_id, &bare, &v1_prefixed] {
            assert_eq!(
                import_row(&conn, path).unwrap().outcome,
                "corrupt",
                "{path}"
            );
        }
        assert!(sink.dispatched.lock().unwrap().is_empty());

        // Corrupt is final until the file changes.
        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res2.intents_skipped_unchanged, 4);
    }

    #[tokio::test]
    async fn test_cycle_unknown_version_3_is_skipped_version() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let jid = "journal-version-03";
        let path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        let mut sealed = memlore_core::outbox::seal_outbox_intent_v2(
            &test_key_list(),
            &v2_journal(V2_WEB_A, jid, 1),
        )
        .unwrap();
        // Frame version is the u16 right after the 4-byte magic (bincode fixint, LE).
        sealed[4..6].copy_from_slice(&3u16.to_le_bytes());
        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        p.write_file(&path, &sealed).await.unwrap();

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        v2_cycle(&provider, &media_dir, &conn, &sink).await;

        let row = import_row(&conn, &path).unwrap();
        assert_eq!(row.outcome, "skipped_version");
        assert_eq!(row.pending_plan.as_deref(), Some("3"));

        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(
            res2.intents_skipped_unchanged, 1,
            "unknown version stays skipped"
        );
    }

    /// A v1 frame whose inner body claims version 2 is malformed, not "newer": it must be
    /// final `corrupt`, or the now-supported "2" would re-read it every cycle forever.
    #[tokio::test]
    async fn test_cycle_v1_frame_with_inner_version_2_is_corrupt() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let eid = "entry-inner-v2-0001";
        let path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        let mut entry = v1_edit(V2_WEB_A, eid, 1);
        entry.schema_version = 2;
        write_v1(&provider, &path, &entry).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(import_row(&conn, &path).unwrap().outcome, "corrupt");

        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res2.intents_skipped_unchanged, 1);
    }

    /// v0.2.2 recorded v2 files as `skipped_version` / "2" with the file's revision. After
    /// the upgrade that row is pending again: re-read and dispatched although unchanged.
    #[tokio::test]
    async fn test_cycle_rereads_skipped_version_2_row() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let jid = "journal-old-skip-1";
        let path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v2(&provider, &path, &v2_journal(V2_WEB_A, jid, 1)).await;
        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        let revision = match p.read_file_if_changed(&path, None).await.unwrap() {
            ConditionalRead::Changed { revision, .. } => revision,
            ConditionalRead::Unchanged => unreachable!(),
        };
        assert!(revision.is_some());

        let conn = setup_test_db();
        let old_row = WebOutboxImportRecord {
            path: path.clone(),
            revision: revision.clone(),
            content_hash: "old-hash".to_string(),
            outcome: "skipped_version".to_string(),
            imported_at: 1,
            last_applied_updated_at: None,
            post_import_fingerprint: None,
            decided_fields: None,
            pending_revision: None,
            pending_plan: Some("2".to_string()),
            created: false,
            applied_from_updated_at: None,
        };
        outbox_import_record(&conn, &old_row).unwrap();

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_skipped_unchanged, 0);
        assert_eq!(*sink.dispatched.lock().unwrap(), vec![path.clone()]);
        let row = import_row(&conn, &path).unwrap();
        assert_eq!(row.outcome, "applied");
        assert!(row.created);
        assert_eq!(row.revision, revision);
        assert!(db::queries::get_journal(&conn, jid).unwrap().is_some());

        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res2.intents_skipped_unchanged, 1, "applied is final");
    }

    /// Across all web devices: tags → journals → templates → v1 entries → trash; within a
    /// kind by `web_updated_at_secs`, then path.
    #[tokio::test]
    async fn test_cycle_applies_in_kind_order_across_web_devices() {
        use memlore_core::outbox::OutboxIntentV2;
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A, V2_WEB_B]).await;
        let path = |web: &str, name: &str| format!("{web}/outbox/{name}.bin");

        let trash_a = path(V2_WEB_A, "d-entry-order-00001");
        write_v2(
            &provider,
            &trash_a,
            &OutboxIntentV2::TrashEntry {
                web_device_id: V2_WEB_A.to_string(),
                web_updated_at_secs: 1,
                entry_id: "entry-order-00001".to_string(),
                base_updated_at: 1,
            },
        )
        .await;
        let entry_a = path(V2_WEB_A, "entry-order-00001");
        write_v1(
            &provider,
            &entry_a,
            &v1_edit(V2_WEB_A, "entry-order-00001", 2),
        )
        .await;
        let entry_b = path(V2_WEB_B, "entry-order-00002");
        write_v1(
            &provider,
            &entry_b,
            &v1_edit(V2_WEB_B, "entry-order-00002", 1),
        )
        .await;
        let tpl_a = path(V2_WEB_A, "p-template-order-1");
        write_v2(
            &provider,
            &tpl_a,
            &OutboxIntentV2::DeleteTemplate {
                web_device_id: V2_WEB_A.to_string(),
                web_updated_at_secs: 3,
                template_id: "template-order-1".to_string(),
                base_updated_at: 1,
            },
        )
        .await;
        let tag_a = path(V2_WEB_A, "t-tag-order-0001");
        write_v2(&provider, &tag_a, &v2_tag(V2_WEB_A, "tag-order-0001", 400)).await;
        let tag_b = path(V2_WEB_B, "t-tag-order-0002");
        write_v2(&provider, &tag_b, &v2_tag(V2_WEB_B, "tag-order-0002", 300)).await;
        let journal_a = path(V2_WEB_A, "j-journal-order-1");
        write_v2(
            &provider,
            &journal_a,
            &v2_journal(V2_WEB_A, "journal-order-1", 500),
        )
        .await;
        let journal_b = path(V2_WEB_B, "j-journal-order-2");
        write_v2(
            &provider,
            &journal_b,
            &v2_journal(V2_WEB_B, "journal-order-2", 10),
        )
        .await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        v2_cycle(&provider, &media_dir, &conn, &sink).await;

        assert_eq!(
            *sink.dispatched.lock().unwrap(),
            vec![tag_b, tag_a, journal_b, journal_a, tpl_a, entry_b, entry_a, trash_a]
        );
    }

    /// Tags apply before journals: a journal's `auto_tag_ids` may name a tag created
    /// in the same cycle, and `create_journal_with_id` drops unknown tag ids.
    #[tokio::test]
    async fn test_cycle_journal_auto_tag_created_same_cycle() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let tid = "tag-autotag-order-1";
        let jid = "journal-autotag-ord1";
        let tag = v2_tag(V2_WEB_A, tid, 900);
        let mut journal = v2_journal(V2_WEB_A, jid, 1);
        if let OutboxIntentV2::CreateJournal { auto_tag_ids, .. } = &mut journal {
            auto_tag_ids.push(tid.to_string());
        }
        write_v2(&provider, &v2_path(&tag), &tag).await;
        write_v2(&provider, &v2_path(&journal), &journal).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 2, "{res:?}");
        let auto: Vec<String> = db::queries::list_journal_auto_tags(&conn, jid)
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(auto, vec![tid.to_string()]);
    }

    // ---- Phase 14.2 / 14.3: apply each v2 kind, acks ----

    const V2_HASH: &str = "hash-v2";
    const V2_REV: &str = "rev-v2";

    fn v2_path(intent: &OutboxIntentV2) -> String {
        format!("{}/outbox/{}", intent.web_device_id(), intent.file_name())
    }

    fn v2_apply(conn: &Connection, ctx: &ApplyContext, intent: &OutboxIntentV2) -> Outcome {
        apply_intent_v2(
            conn,
            ctx,
            &v2_path(intent),
            V2_HASH,
            Some(V2_REV.to_string()),
            intent,
        )
    }

    fn v2_ctx() -> (tempfile::TempDir, ApplyContext) {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ApplyContext::new(dir.path().to_path_buf());
        (dir, ctx)
    }

    fn v2_template(
        id: &str,
        name: &str,
        content: &[u8],
        base_updated_at: Option<i64>,
    ) -> OutboxIntentV2 {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        OutboxIntentV2::UpsertTemplate {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 10,
            template_id: id.to_string(),
            name: name.to_string(),
            description: Some("desc".to_string()),
            content_b64: Some(B64.encode(content)),
            sort_order: 2,
            base_updated_at,
        }
    }

    fn v2_delete_template(id: &str, base_updated_at: i64) -> OutboxIntentV2 {
        OutboxIntentV2::DeleteTemplate {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 11,
            template_id: id.to_string(),
            base_updated_at,
        }
    }

    fn v2_trash(entry_id: &str, base_updated_at: i64) -> OutboxIntentV2 {
        OutboxIntentV2::TrashEntry {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 12,
            entry_id: entry_id.to_string(),
            base_updated_at,
        }
    }

    fn live_entry(conn: &Connection, journal_id: &str) -> db::Entry {
        crate::commands::entries::create_entry_impl(
            conn,
            journal_id,
            Some("Desk"),
            None,
            None,
            1_700_000_000,
        )
        .unwrap()
    }

    fn raw_entry(conn: &Connection, id: &str) -> db::Entry {
        db::queries::get_entry_raw(conn, id).unwrap().unwrap()
    }

    fn assert_refused(conn: &Connection, intent: &OutboxIntentV2, outcome: Outcome, code: &str) {
        assert_eq!(outcome, Outcome::Refused(code.to_string()));
        let row = import_row(conn, &v2_path(intent)).unwrap();
        assert_eq!(row.outcome, "refused");
        assert_eq!(row.pending_plan.as_deref(), Some(code));
        assert_eq!(row.revision.as_deref(), Some(V2_REV));
        assert!(!row.created);
    }

    #[test]
    fn test_v2_create_journal_happy_idempotent_and_name_taken() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let intent = v2_journal(V2_WEB_A, "journal-v2-happy-1", 5);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        let j = db::queries::get_journal(&conn, "journal-v2-happy-1")
            .unwrap()
            .unwrap();
        assert_eq!(j.name, "Journal journal-v2-happy-1");
        let row = import_row(&conn, &v2_path(&intent)).unwrap();
        assert_eq!(row.outcome, "applied");
        assert!(row.created);
        assert_eq!(row.revision.as_deref(), Some(V2_REV));
        assert_eq!(row.content_hash, V2_HASH);

        // Replay (crash before the record, or a second desktop) → applied, created.
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        assert!(import_row(&conn, &v2_path(&intent)).unwrap().created);

        // Same name, other id → name_taken.
        let clash = OutboxIntentV2::CreateJournal {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 6,
            journal_id: "journal-v2-happy-2".to_string(),
            name: "Journal journal-v2-happy-1".to_string(),
            color: None,
            auto_tag_ids: vec![],
        };
        let out = v2_apply(&conn, &ctx, &clash);
        assert_refused(&conn, &clash, out, "name_taken");
        assert!(db::queries::get_journal(&conn, "journal-v2-happy-2")
            .unwrap()
            .is_none());
    }

    #[test]
    fn test_v2_create_tag_happy_idempotent_and_name_taken() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let intent = v2_tag(V2_WEB_A, "tag-v2-happy-0001", 5);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        assert_eq!(
            existing_tag_ids(&conn, &["tag-v2-happy-0001"]).unwrap(),
            vec!["tag-v2-happy-0001".to_string()]
        );
        assert!(import_row(&conn, &v2_path(&intent)).unwrap().created);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);

        db::queries::create_tag(&conn, "taken", None).unwrap();
        let clash = OutboxIntentV2::CreateTag {
            web_device_id: V2_WEB_A.to_string(),
            web_updated_at_secs: 6,
            tag_id: "tag-v2-happy-0002".to_string(),
            name: "taken".to_string(),
            color: None,
        };
        let out = v2_apply(&conn, &ctx, &clash);
        assert_refused(&conn, &clash, out, "name_taken");
    }

    #[test]
    fn test_v2_template_create_reflected_update_and_refused() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let id = "template-v2-0001";
        let create = v2_template(id, "Daily", b"one", None);
        assert_eq!(v2_apply(&conn, &ctx, &create), Outcome::Applied);
        let row = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();
        assert_eq!(row.name, "Daily");
        assert_eq!(row.description.as_deref(), Some("desc"));
        assert_eq!(row.content.as_deref(), Some(&b"one"[..]));
        assert_eq!(row.sort_order, 2);
        let rec = import_row(&conn, &v2_path(&create)).unwrap();
        assert_eq!(rec.outcome, "applied");
        assert_eq!(rec.last_applied_updated_at, Some(row.updated_at));

        // Already reflected → applied without a write.
        assert_eq!(v2_apply(&conn, &ctx, &create), Outcome::Applied);
        let same = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();
        assert_eq!(same.updated_at, row.updated_at);

        // Update on the current base → applied.
        let update = v2_template(id, "Weekly", b"two", Some(row.updated_at));
        assert_eq!(v2_apply(&conn, &ctx, &update), Outcome::Applied);
        let updated = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();
        assert_eq!(updated.name, "Weekly");
        assert_eq!(
            import_row(&conn, &v2_path(&update))
                .unwrap()
                .last_applied_updated_at,
            Some(updated.updated_at)
        );

        // Desktop edits it, then a web edit on the old base → desktop wins.
        conn.execute(
            "UPDATE templates SET name = 'Desk', updated_at = updated_at + 100 WHERE id = ?1",
            [id],
        )
        .unwrap();
        let stale = v2_template(id, "Monthly", b"three", Some(row.updated_at));
        let out = v2_apply(&conn, &ctx, &stale);
        assert_refused(&conn, &stale, out, "changed_on_desktop");
        assert_eq!(
            db::queries::get_template_for_import(&conn, id)
                .unwrap()
                .unwrap()
                .name,
            "Desk"
        );
    }

    #[test]
    fn test_v2_template_in_place_edit_of_own_create_applies() {
        // The web edits its own not-yet-reflected template in place: still base None.
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let id = "template-v2-0002";
        assert_eq!(
            v2_apply(&conn, &ctx, &v2_template(id, "Draft", b"a", None)),
            Outcome::Applied
        );
        let edited = v2_template(id, "Draft 2", b"b", None);
        assert_eq!(v2_apply(&conn, &ctx, &edited), Outcome::Applied);
        // A second in-place edit, still base None: the chain carries the web's base.
        let edited = v2_template(id, "Draft 2b", b"bb", None);
        assert_eq!(v2_apply(&conn, &ctx, &edited), Outcome::Applied);
        assert_eq!(
            db::queries::get_template_for_import(&conn, id)
                .unwrap()
                .unwrap()
                .name,
            "Draft 2b"
        );

        // ...but not after a desktop edit.
        conn.execute(
            "UPDATE templates SET name = 'Desk', updated_at = updated_at + 100 WHERE id = ?1",
            [id],
        )
        .unwrap();
        let again = v2_template(id, "Draft 3", b"c", None);
        let out = v2_apply(&conn, &ctx, &again);
        assert_refused(&conn, &again, out, "changed_on_desktop");
    }

    #[test]
    fn test_v2_template_upsert_of_unknown_or_predefined_row_refused() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let missing = v2_template("template-v2-0003", "X", b"x", Some(5));
        let out = v2_apply(&conn, &ctx, &missing);
        assert_refused(&conn, &missing, out, "absent");

        let pre = db::queries::create_predefined_template(&conn, "Seeded", None, None, 0).unwrap();
        let row = db::queries::get_template_for_import(&conn, &pre.id)
            .unwrap()
            .unwrap();
        let edit = v2_template(&pre.id, "Mine", b"m", Some(row.updated_at));
        let out = v2_apply(&conn, &ctx, &edit);
        assert_refused(&conn, &edit, out, "changed_on_desktop");
    }

    #[test]
    fn test_v2_template_delete_happy_idempotent_and_refused() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let id = "template-v2-0004";
        db::queries::create_template_with_id(&conn, id, "T", None, None, 0).unwrap();
        let row = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();

        // Stale base → refused, row kept.
        let stale = v2_delete_template(id, row.updated_at - 1);
        let out = v2_apply(&conn, &ctx, &stale);
        assert_refused(&conn, &stale, out, "changed_on_desktop");
        assert!(
            !db::queries::get_template_for_import(&conn, id)
                .unwrap()
                .unwrap()
                .is_deleted
        );

        let del = v2_delete_template(id, row.updated_at);
        assert_eq!(v2_apply(&conn, &ctx, &del), Outcome::Applied);
        let gone = db::queries::get_template_for_import(&conn, id)
            .unwrap()
            .unwrap();
        assert!(gone.is_deleted);
        assert_eq!(
            import_row(&conn, &v2_path(&del))
                .unwrap()
                .last_applied_updated_at,
            Some(gone.updated_at)
        );

        // Already deleted → applied, even with a stale base.
        let again = v2_delete_template(id, 1);
        assert_eq!(v2_apply(&conn, &ctx, &again), Outcome::Applied);

        // Created then deleted on the web before any import: nothing to delete.
        let never = v2_delete_template("template-v2-0005", 42);
        assert_eq!(v2_apply(&conn, &ctx, &never), Outcome::Applied);
        let rec = import_row(&conn, &v2_path(&never)).unwrap();
        assert_eq!(rec.outcome, "applied");
        assert_eq!(rec.last_applied_updated_at, Some(42));
    }

    /// A deterministic validation failure is a final `invalid` refusal, recorded once,
    /// never a transient that re-reads (and spends budget on) the file every cycle.
    #[test]
    fn test_v2_invalid_intent_is_final_refused_invalid() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let mut bad_color = v2_tag(V2_WEB_A, "tag-poison-color-1", 1);
        if let OutboxIntentV2::CreateTag { color, .. } = &mut bad_color {
            *color = Some("red".to_string());
        }
        let mut blank_journal = v2_journal(V2_WEB_A, "journal-poison-blank", 1);
        if let OutboxIntentV2::CreateJournal { name, .. } = &mut blank_journal {
            *name = "   ".to_string();
        }
        let mut bad_b64 = v2_template("template-poison-b64", "T", b"t", None);
        if let OutboxIntentV2::UpsertTemplate { content_b64, .. } = &mut bad_b64 {
            *content_b64 = Some("!!not base64!!".to_string());
        }
        let mut huge = v2_template("template-poison-big", "T", b"t", None);
        if let OutboxIntentV2::UpsertTemplate { content_b64, .. } = &mut huge {
            *content_b64 = Some(B64.encode(vec![
                0u8;
                memlore_core::outbox::MAX_TEMPLATE_CONTENT_BYTES
                    + 1
            ]));
        }
        for i in [&bad_color, &blank_journal, &bad_b64, &huge] {
            let out = v2_apply(&conn, &ctx, i);
            assert_refused(&conn, i, out, "invalid");
            assert!(!is_pending(&import_row(&conn, &v2_path(i)).unwrap()));
        }
        assert!(db::queries::get_journal(&conn, "journal-poison-blank")
            .unwrap()
            .is_none());
        assert!(
            db::queries::get_template_for_import(&conn, "template-poison-b64")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn test_v2_trash_happy_marks_pending_and_records_stamp() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        db::queries::mark_entry_synced(&conn, &e.id, 1).ok();
        let intent = v2_trash(&e.id, e.updated_at);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        let after = raw_entry(&conn, &e.id);
        assert!(after.is_deleted && after.trashed_at.is_some());
        assert!(after.updated_at > e.updated_at);
        let status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&e.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
        let rec = import_row(&conn, &v2_path(&intent)).unwrap();
        assert_eq!(rec.outcome, "applied");
        assert_eq!(rec.last_applied_updated_at, Some(after.updated_at));
        assert!(!rec.created);
    }

    #[test]
    fn test_v2_trash_stale_base_refused_changed_on_desktop() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let intent = v2_trash(&e.id, e.updated_at - 10);
        let out = v2_apply(&conn, &ctx, &intent);
        assert_refused(&conn, &intent, out, "changed_on_desktop");
        assert!(!raw_entry(&conn, &e.id).is_deleted);
    }

    #[test]
    fn test_v2_trash_already_trashed_is_applied() {
        // A second v0.3.0 desktop already pulled the first one's trash.
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        crate::commands::entries::soft_delete_entry_impl(&conn, &e.id).unwrap();
        let trashed = raw_entry(&conn, &e.id);
        let intent = v2_trash(&e.id, e.updated_at - 10);
        assert_eq!(v2_apply(&conn, &ctx, &intent), Outcome::Applied);
        let rec = import_row(&conn, &v2_path(&intent)).unwrap();
        assert_eq!(rec.outcome, "applied");
        assert_eq!(rec.last_applied_updated_at, Some(trashed.updated_at));
        assert_eq!(raw_entry(&conn, &e.id).updated_at, trashed.updated_at);
    }

    /// Every hidden or gone target refuses with the one reason `absent`, checked before
    /// the already-trashed shortcut, so the ack never reveals that a locked or
    /// invisible entry exists, nor its stamp.
    #[test]
    fn test_v2_trash_hidden_or_gone_targets_refused_absent() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let refuse = |id: &str| {
            let e = raw_entry(&conn, id);
            let i = v2_trash(id, e.updated_at);
            let out = v2_apply(&conn, &ctx, &i);
            assert_refused(&conn, &i, out, "absent");
            let row = import_row(&conn, &v2_path(&i)).unwrap();
            assert_eq!(row.last_applied_updated_at, None);
            assert_eq!(raw_entry(&conn, id).updated_at, e.updated_at);
        };

        let locked = live_entry(&conn, &jid);
        conn.execute(
            "UPDATE entries SET is_locked = 1 WHERE id = ?1",
            [&locked.id],
        )
        .unwrap();
        refuse(&locked.id);
        assert!(!raw_entry(&conn, &locked.id).is_deleted);

        let invisible = live_entry(&conn, &jid);
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = ?1",
            [&invisible.id],
        )
        .unwrap();
        refuse(&invisible.id);

        let inv_j = db::queries::create_journal(&conn, "Hidden", None).unwrap();
        conn.execute(
            "UPDATE journals SET is_invisible = 1 WHERE id = ?1",
            [&inv_j.id],
        )
        .unwrap();
        let in_inv_j = live_entry(&conn, &inv_j.id);
        refuse(&in_inv_j.id);
        assert!(!raw_entry(&conn, &in_inv_j.id).is_deleted);

        let locked_j = db::queries::create_journal(&conn, "Locked", None).unwrap();
        let in_locked_j = live_entry(&conn, &locked_j.id);
        conn.execute(
            "UPDATE journals SET is_locked = 1 WHERE id = ?1",
            [&locked_j.id],
        )
        .unwrap();
        refuse(&in_locked_j.id);
        assert!(!raw_entry(&conn, &in_locked_j.id).is_deleted);

        // Already trashed, but hidden: still `absent`, not the applied shortcut.
        let trashed_locked = live_entry(&conn, &jid);
        crate::commands::entries::soft_delete_entry_impl(&conn, &trashed_locked.id).unwrap();
        conn.execute(
            "UPDATE entries SET is_locked = 1 WHERE id = ?1",
            [&trashed_locked.id],
        )
        .unwrap();
        refuse(&trashed_locked.id);
        let trashed_in_inv_j = live_entry(&conn, &inv_j.id);
        crate::commands::entries::soft_delete_entry_impl(&conn, &trashed_in_inv_j.id).unwrap();
        refuse(&trashed_in_inv_j.id);

        let purged = live_entry(&conn, &jid);
        crate::commands::entries::soft_delete_entry_impl(&conn, &purged.id).unwrap();
        db::queries::purge_entry_mark(&conn, &purged.id).unwrap();
        refuse(&purged.id);

        let i = v2_trash("entry-v2-missing-01", 5);
        let out = v2_apply(&conn, &ctx, &i);
        assert_refused(&conn, &i, out, "absent");
    }

    #[test]
    fn test_v2_trash_waits_when_target_not_pulled_or_pull_dirty() {
        let conn = setup_test_db();
        let (_d, mut ctx) = v2_ctx();
        ctx.known_ids
            .insert("entry-v2-unpulled-1".to_string(), false);
        let i = v2_trash("entry-v2-unpulled-1", 5);
        assert_eq!(v2_apply(&conn, &ctx, &i), Outcome::Transient);
        assert!(import_row(&conn, &v2_path(&i)).is_none());

        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        ctx.pull_clean = false;
        let i = v2_trash(&e.id, e.updated_at);
        assert_eq!(v2_apply(&conn, &ctx, &i), Outcome::Transient);
        assert!(import_row(&conn, &v2_path(&i)).is_none());
        assert!(!raw_entry(&conn, &e.id).is_deleted);
    }

    /// Edit then delete on one web device: the edit applies first and bumps
    /// `updated_at`, so the trash's base (the pre-edit stamp the web saw) no longer
    /// matches. The trash still applies, because the only change since that base is
    /// the web's own edit, recorded for its `<entryId>.bin`.
    #[tokio::test]
    async fn test_cycle_edit_then_delete_from_one_web_device_applies() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        // An old stamp, so the web edit's `now` stamp always differs from the base.
        let base = 1_000;
        conn.execute(
            "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![base, e.id],
        )
        .unwrap();

        let mut edit = v1_edit(V2_WEB_A, &e.id, 2000);
        if let Some(t) = edit.fields.title.as_mut() {
            t.base = "Desk".to_string();
            t.base_updated_at = base;
        }
        edit.base_state_vector = vec![0];
        edit.yjs_full_state = vec![];
        edit.content_text = None;
        edit.preview_text = None;
        let edit_path = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
        write_v1(&provider, &edit_path, &edit).await;
        let trash = v2_trash(&e.id, base);
        write_v2(&provider, &v2_path(&trash), &trash).await;

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 2, "{res:?}");
        let after = raw_entry(&conn, &e.id);
        assert_eq!(after.title.as_deref(), Some("Edited"));
        assert!(after.is_deleted && after.trashed_at.is_some());
        assert_eq!(
            import_row(&conn, &v2_path(&trash)).unwrap().outcome,
            "applied"
        );
    }

    /// Two web edits from one base without a pull in between, then a trash from that
    /// base: each edit chains on the web's own previous apply, so the trash applies.
    #[tokio::test]
    async fn test_cycle_two_edits_then_trash_from_one_base_applies() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let base = 1_000;
        conn.execute(
            "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![base, e.id],
        )
        .unwrap();
        let mut edit = v1_edit(V2_WEB_A, &e.id, 2000);
        if let Some(t) = edit.fields.title.as_mut() {
            t.base = "Desk".to_string();
            t.base_updated_at = base;
        }
        edit.base_state_vector = vec![0];
        edit.yjs_full_state = vec![];
        edit.content_text = None;
        edit.preview_text = None;
        let edit_path = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
        write_v1(&provider, &edit_path, &edit).await;
        let sink = TestOutboxSink::default();
        assert_eq!(
            v2_cycle(&provider, &media_dir, &conn, &sink)
                .await
                .intents_applied,
            1
        );

        edit.fields.emotion = Some(FieldChange {
            value: Some("good".to_string()),
            base: None,
            base_updated_at: base,
            change_seq: 2,
            changed_at_secs: 2001,
        });
        write_v1(&provider, &edit_path, &edit).await;
        let trash = v2_trash(&e.id, base);
        write_v2(&provider, &v2_path(&trash), &trash).await;
        v2_cycle(&provider, &media_dir, &conn, &sink).await;

        let after = raw_entry(&conn, &e.id);
        assert_eq!(after.emotion.as_deref(), Some("good"));
        assert!(after.is_deleted && after.trashed_at.is_some());
        assert_eq!(
            import_row(&conn, &v2_path(&trash)).unwrap().outcome,
            "applied"
        );
    }

    /// Desktop edits first, then the web edits and trashes from the same stale base in
    /// one cycle. The edit is refused field by field, yet its record still carries the
    /// row's stamp; that stamp must not let the trash through, desktop wins.
    #[tokio::test]
    async fn test_cycle_refused_edit_does_not_unlock_stale_trash() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let base = 1_000;
        conn.execute(
            "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![base, e.id],
        )
        .unwrap();
        crate::commands::entries::update_entry_impl(&conn, &e.id, Some("Desk 2"), None, None)
            .unwrap();

        let mut edit = v1_edit(V2_WEB_A, &e.id, 2000);
        if let Some(t) = edit.fields.title.as_mut() {
            t.base = "Desk".to_string();
            t.base_updated_at = base;
        }
        edit.base_state_vector = vec![0];
        edit.yjs_full_state = vec![];
        edit.content_text = None;
        edit.preview_text = None;
        let edit_path = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
        write_v1(&provider, &edit_path, &edit).await;
        let trash = v2_trash(&e.id, base);
        write_v2(&provider, &v2_path(&trash), &trash).await;

        let sink = TestOutboxSink::default();
        v2_cycle(&provider, &media_dir, &conn, &sink).await;
        let after = raw_entry(&conn, &e.id);
        assert_eq!(after.title.as_deref(), Some("Desk 2"));
        assert!(!after.is_deleted, "desktop edit wins over the stale trash");
        let row = import_row(&conn, &v2_path(&trash)).unwrap();
        assert_eq!(row.outcome, "refused");
        assert_eq!(row.pending_plan.as_deref(), Some("changed_on_desktop"));
    }

    /// A desktop edit after the web's own applied edit still wins over the trash.
    #[test]
    fn test_v2_trash_after_own_edit_refused_when_desktop_edited_since() {
        let conn = setup_test_db();
        let (_d, ctx) = v2_ctx();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        let sibling = format!("{V2_WEB_A}/outbox/{}.bin", e.id);
        outbox_import_record(
            &conn,
            &WebOutboxImportRecord {
                path: sibling,
                revision: None,
                content_hash: "h".to_string(),
                outcome: "applied".to_string(),
                imported_at: 1,
                last_applied_updated_at: Some(e.updated_at),
                post_import_fingerprint: None,
                decided_fields: None,
                pending_revision: None,
                pending_plan: None,
                created: false,
                applied_from_updated_at: None,
            },
        )
        .unwrap();
        db::queries::touch_entry_updated_at(&conn, &e.id).unwrap();
        let i = v2_trash(&e.id, e.updated_at - 50);
        let out = v2_apply(&conn, &ctx, &i);
        assert_refused(&conn, &i, out, "changed_on_desktop");
    }

    /// Creates run before entry intents in the same cycle: an entry created on the web
    /// into a web-created journal with a web-created tag lands there with that tag.
    #[tokio::test]
    async fn test_cycle_entry_lands_in_journal_and_tag_created_same_cycle() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let new_jid = "journal-e2e-order-1";
        let new_tid = "tag-e2e-order-0001";
        let journal = v2_journal(V2_WEB_A, new_jid, 1);
        let tag = v2_tag(V2_WEB_A, new_tid, 1);
        write_v2(&provider, &v2_path(&journal), &journal).await;
        write_v2(&provider, &v2_path(&tag), &tag).await;

        let eid = "entry-e2e-order-001";
        let mut entry = v1_edit(V2_WEB_A, eid, 1);
        entry.created_on_web = true;
        entry.fields.journal_id = Some(FieldChange {
            value: new_jid.to_string(),
            base: String::new(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 1,
        });
        entry.fields.tags_add.insert(
            new_tid.to_string(),
            FieldChange {
                value: true,
                base: false,
                base_updated_at: 0,
                change_seq: 3,
                changed_at_secs: 1,
            },
        );
        let entry_path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        write_v1(&provider, &entry_path, &entry).await;

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 3, "{res:?}");
        assert_eq!(res.intents_refused, 0);

        let created = raw_entry(&conn, eid);
        assert_eq!(created.journal_id, new_jid);
        assert_ne!(created.journal_id, default_journal_id(&conn));
        assert_eq!(
            db::queries::get_tag_ids_for_entry(&conn, eid).unwrap(),
            vec![new_tid.to_string()]
        );
        let rec = import_row(&conn, &entry_path).unwrap();
        assert_eq!(rec.outcome, "applied");
        let decided = rec.decided_fields.unwrap_or_default();
        assert!(!decided.contains("tag_not_found"), "{decided}");
        assert!(!decided.contains("\"journal\""), "{decided}");
    }

    /// Ack shape per outcome: created for creates, applied_updated_at for template and
    /// trash applies, refused_reason for refusals.
    #[tokio::test]
    async fn test_cycle_v2_ack_shapes_per_outcome() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let conn = setup_test_db();
        let jid = default_journal_id(&conn);
        let e = live_entry(&conn, &jid);
        db::queries::create_tag(&conn, "Tag tag-ack-taken-001", None).unwrap();

        let journal = v2_journal(V2_WEB_A, "journal-ack-00001", 1);
        let taken = v2_tag(V2_WEB_A, "tag-ack-taken-001", 1);
        let tpl = v2_template("template-ack-0001", "T", b"t", None);
        let trash = v2_trash(&e.id, e.updated_at);
        let stale = v2_delete_template("template-ack-0002", 1);
        db::queries::create_template_with_id(&conn, "template-ack-0002", "K", None, None, 0)
            .unwrap();
        for i in [&journal, &taken, &tpl, &trash, &stale] {
            write_v2(&provider, &v2_path(i), i).await;
        }

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert!(res.acks_written);
        assert_eq!(res.intents_applied, 3, "{res:?}");
        assert_eq!(res.intents_refused, 2, "{res:?}");

        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        let bytes = p
            .read_file(&format!("{V2_OWN}/outbox-acks.bin"))
            .await
            .unwrap();
        let acks = open_outbox_acks(&test_key_list(), &bytes).unwrap();
        let ack = |i: &OutboxIntentV2| {
            acks.acks
                .iter()
                .find(|a| a.path == v2_path(i))
                .unwrap_or_else(|| panic!("no ack for {}", v2_path(i)))
                .clone()
        };

        let a = ack(&journal);
        assert!(a.created);
        assert_eq!(a.refused_reason, None);

        let a = ack(&taken);
        assert!(!a.created);
        assert_eq!(a.refused_reason.as_deref(), Some("name_taken"));

        let a = ack(&tpl);
        let tpl_row = db::queries::get_template_for_import(&conn, "template-ack-0001")
            .unwrap()
            .unwrap();
        assert_eq!(a.applied_updated_at, Some(tpl_row.updated_at));
        assert_eq!(a.refused_reason, None);

        let a = ack(&trash);
        assert_eq!(
            a.applied_updated_at,
            Some(raw_entry(&conn, &e.id).updated_at)
        );
        assert_eq!(a.refused_reason, None);

        let a = ack(&stale);
        assert_eq!(a.applied_updated_at, None);
        assert_eq!(a.refused_reason.as_deref(), Some("changed_on_desktop"));
    }

    /// v2 reads count against the changed-intent budget again; because they are now
    /// recorded (final), the backlog drains and the v1 intent is reached next cycle.
    #[tokio::test]
    async fn test_cycle_v2_budget_drains_then_reaches_v1() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        for i in 0..25 {
            let id = format!("tag-budget-{i:04}");
            let p = format!("{V2_WEB_A}/outbox/t-{id}.bin");
            write_v2(&provider, &p, &v2_tag(V2_WEB_A, &id, i)).await;
        }
        let eid = "entry-budget-00001";
        let v1_path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        write_v1(&provider, &v1_path, &v1_edit(V2_WEB_A, eid, 1)).await;

        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_applied, 20);
        assert!(
            import_row(&conn, &v1_path).is_none(),
            "deferred by the budget"
        );

        let res2 = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res2.intents_applied, 5);
        assert_eq!(res2.intents_skipped_unchanged, 20);
        assert_eq!(import_row(&conn, &v1_path).unwrap().outcome, "refused");
    }

    /// Provider whose outbox intent reads take `delay` of (paused) tokio time. Only
    /// reads that return bytes are slow; an unchanged-revision check stays cheap.
    struct SlowOutboxProvider<'a> {
        inner: &'a crate::sync::local_provider::LocalSyncProvider,
        delay: Duration,
    }

    #[async_trait::async_trait]
    impl SyncProvider for SlowOutboxProvider<'_> {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            SyncProvider::list_devices(self.inner).await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            SyncProvider::list_files(self.inner, device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            if path.contains("/outbox/") {
                tokio::time::sleep(self.delay).await;
            }
            SyncProvider::read_file(self.inner, path).await
        }
        async fn read_file_if_changed(
            &self,
            path: &str,
            known_revision: Option<&str>,
        ) -> Result<ConditionalRead, SyncError> {
            let res = SyncProvider::read_file_if_changed(self.inner, path, known_revision).await;
            if matches!(res, Ok(ConditionalRead::Changed { .. })) {
                tokio::time::sleep(self.delay).await;
            }
            res
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            SyncProvider::write_file(self.inner, path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            SyncProvider::delete_file(self.inner, path).await
        }
    }

    /// Slow reads must not let the read pass eat the whole wall-clock budget: the
    /// apply pass still records what was read, so every cycle makes progress instead
    /// of re-reading the same files forever.
    #[tokio::test(start_paused = true)]
    async fn test_cycle_slow_reads_still_apply_each_cycle() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        for i in 0..5 {
            let tag = v2_tag(V2_WEB_A, &format!("tag-slow-read-{i:04}"), i);
            write_v2(&provider, &v2_path(&tag), &tag).await;
        }
        let slow = SlowOutboxProvider {
            inner: &provider,
            delay: Duration::from_secs(20),
        };
        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let summary = SyncSummary {
            pull_clean: true,
            ..Default::default()
        };
        let mut applied = 0;
        for _ in 0..3 {
            let res = run_outbox_import_cycle(
                &slow,
                &provider,
                V2_OWN,
                &test_key_list(),
                HashMap::new(),
                true,
                &summary,
                &media_dir,
                &conn,
                &sink,
            )
            .await
            .unwrap();
            assert!(res.intents_applied > 0, "no progress: {res:?}");
            applied += res.intents_applied;
            if applied == 5 {
                break;
            }
        }
        assert_eq!(applied, 5);
    }

    // ---- Phase 14.5: old-state and mixed-fleet ----

    /// A second desktop still on v0.2.2 (no `outbox_versions` in its manifest).
    const V022_DESKTOP: &str = "22222222-2222-2222-2222-222222222222";

    /// Revision and sha256 hex of an outbox file, as v0.2.2 recorded them.
    async fn file_revision_and_hash(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        path: &str,
    ) -> (Option<String>, String) {
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        match p.read_file_if_changed(path, None).await.unwrap() {
            ConditionalRead::Changed { bytes, revision } => {
                assert!(revision.is_some());
                (revision, hex::encode(sha2::Sha256::digest(&bytes)))
            }
            ConditionalRead::Unchanged => unreachable!(),
        }
    }

    /// The ack v0.2.2 emitted for a `skipped_version` row: no refusal, nothing created.
    fn v022_skipped_ack(path: &str, content_hash: &str) -> OutboxAckEntry {
        OutboxAckEntry {
            path: path.to_string(),
            content_hash: content_hash.to_string(),
            applied_updated_at: None,
            decided: vec![],
            created: false,
            refused_reason: None,
        }
    }

    /// Write `{desktop}/outbox-acks.bin` as v0.2.2 did; returns the `__acks__` marker hash.
    async fn write_v022_acks(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        desktop: &str,
        acks: Vec<OutboxAckEntry>,
    ) -> String {
        let file = OutboxAcksV1 {
            schema_version: 1,
            desktop_device_id: desktop.to_string(),
            acks,
        };
        let plain = bincode::DefaultOptions::new()
            .with_fixint_encoding()
            .serialize(&file)
            .unwrap();
        let sealed = seal_outbox_acks(&test_key_list(), &file).unwrap();
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        p.write_file(&format!("{desktop}/outbox-acks.bin"), &sealed)
            .await
            .unwrap();
        format!("1:{}", hex::encode(sha2::Sha256::digest(&plain)))
    }

    async fn own_ack(
        provider: &crate::sync::local_provider::LocalSyncProvider,
        path: &str,
    ) -> OutboxAckEntry {
        let p: &(dyn SyncProvider + Send + Sync) = provider;
        let bytes = p
            .read_file(&format!("{V2_OWN}/outbox-acks.bin"))
            .await
            .unwrap();
        open_outbox_acks(&test_key_list(), &bytes)
            .unwrap()
            .acks
            .into_iter()
            .find(|a| a.path == path)
            .unwrap_or_else(|| panic!("no ack for {path}"))
    }

    /// Upgrade from v0.2.2: its `skipped_version` row (real revision and hash,
    /// `pending_plan = "2"`), its own ack and `__acks__` marker are all present. The
    /// file is unchanged, yet it is re-read, applied, and the ack becomes `created`.
    #[tokio::test]
    async fn test_cycle_upgrades_v022_skipped_row_and_ack_to_applied() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let jid = "journal-v022-skip-1";
        let path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v2(&provider, &path, &v2_journal(V2_WEB_A, jid, 1)).await;
        let (revision, content_hash) = file_revision_and_hash(&provider, &path).await;

        let conn = setup_test_db();
        outbox_import_record(
            &conn,
            &WebOutboxImportRecord {
                path: path.clone(),
                revision: revision.clone(),
                content_hash: content_hash.clone(),
                outcome: "skipped_version".to_string(),
                imported_at: 1,
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: None,
                pending_revision: None,
                pending_plan: Some("2".to_string()),
                created: false,
                applied_from_updated_at: None,
            },
        )
        .unwrap();
        let marker_hash = write_v022_acks(
            &provider,
            V2_OWN,
            vec![v022_skipped_ack(&path, &content_hash)],
        )
        .await;
        outbox_import_record(
            &conn,
            &WebOutboxImportRecord {
                path: "__acks__".to_string(),
                revision: None,
                content_hash: marker_hash,
                outcome: "written".to_string(),
                imported_at: 1,
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: None,
                pending_revision: None,
                pending_plan: None,
                created: false,
                applied_from_updated_at: None,
            },
        )
        .unwrap();

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_skipped_unchanged, 0);
        assert_eq!(res.intents_applied, 1);
        assert!(res.acks_written);
        let row = import_row(&conn, &path).unwrap();
        assert_eq!(row.outcome, "applied");
        assert_eq!(row.revision, revision);
        assert!(db::queries::get_journal(&conn, jid).unwrap().is_some());

        let ack = own_ack(&provider, &path).await;
        assert!(ack.created);
        assert_eq!(ack.refused_reason, None);
        assert_eq!(ack.content_hash, content_hash);
    }

    /// A `corrupt` row stays final across the upgrade even for a now-valid v2 file
    /// (`pending_plan` only revives `skipped_version` rows).
    #[tokio::test]
    async fn test_cycle_v022_corrupt_row_stays_final() {
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        let jid = "journal-v022-corrupt";
        let path = format!("{V2_WEB_A}/outbox/j-{jid}.bin");
        write_v2(&provider, &path, &v2_journal(V2_WEB_A, jid, 1)).await;
        let (revision, content_hash) = file_revision_and_hash(&provider, &path).await;

        let conn = setup_test_db();
        outbox_import_record(
            &conn,
            &WebOutboxImportRecord {
                path: path.clone(),
                revision,
                content_hash,
                outcome: "corrupt".to_string(),
                imported_at: 1,
                last_applied_updated_at: None,
                post_import_fingerprint: None,
                decided_fields: None,
                pending_revision: None,
                pending_plan: Some("2".to_string()),
                created: false,
                applied_from_updated_at: None,
            },
        )
        .unwrap();

        let sink = TestOutboxSink::default();
        let res = v2_cycle(&provider, &media_dir, &conn, &sink).await;
        assert_eq!(res.intents_skipped_unchanged, 1);
        assert_eq!(res.intents_applied, 0);
        assert!(sink.dispatched.lock().unwrap().is_empty());
        assert_eq!(import_row(&conn, &path).unwrap().outcome, "corrupt");
        assert!(db::queries::get_journal(&conn, jid).unwrap().is_none());
    }

    /// Mixed fleet: this v0.3.0 desktop plus a v0.2.2 desktop whose folder holds a
    /// pre-Phase-1 `metadata.json` and acks that skipped the web's v2 journal file.
    /// The old desktop is not mistaken for a web device, its acks are ignored, and an
    /// entry the web placed in a new journal lands in that journal here.
    #[tokio::test]
    async fn test_cycle_mixed_fleet_entry_lands_in_new_web_journal() {
        use memlore_core::keyring_types::{DeviceSlotV2, KEYRING_V2_VERSION};
        let (_tmp, provider, media_dir) = v2_fixture(&[V2_WEB_A]).await;
        for (id, name) in [(V2_OWN, "Desktop 0.3.0"), (V022_DESKTOP, "Desktop 0.2.2")] {
            let slot = DeviceSlotV2 {
                version: KEYRING_V2_VERSION,
                device_id: id.to_string(),
                name: name.to_string(),
                created_at: 1000,
                last_seen_at: 1000,
            };
            crate::sync::keyring_v2::io::write_device_slot(&provider, &slot)
                .await
                .unwrap();
        }

        // Web: a v2 journal create and a v1 entry created into that journal.
        let jid = "journal-mixed-fleet1";
        let journal = v2_journal(V2_WEB_A, jid, 1);
        let journal_path = v2_path(&journal);
        write_v2(&provider, &journal_path, &journal).await;
        let eid = "entry-mixed-fleet-01";
        let mut entry = v1_edit(V2_WEB_A, eid, 2);
        entry.created_on_web = true;
        entry.fields.journal_id = Some(FieldChange {
            value: jid.to_string(),
            base: String::new(),
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 2,
        });
        let entry_path = format!("{V2_WEB_A}/outbox/{eid}.bin");
        write_v1(&provider, &entry_path, &entry).await;

        // v0.2.2 desktop: pre-Phase-1 manifest (no index_present / outbox_versions /
        // trashed_at), one unrelated entry, and acks that skipped the journal file.
        let old_manifest_json = format!(
            r#"{{"device_id":"{V022_DESKTOP}","recovery_generation":0,"entries":[{{"entry_id":"entry-v022-own-0001","updated_at":5,"local_version":1,"is_deleted":false}}],"journals":[],"chats_present":false,"memory_present":false,"generated_at":5}}"#
        );
        let p: &(dyn SyncProvider + Send + Sync) = &provider;
        p.write_file(
            &format!("{V022_DESKTOP}/metadata.json"),
            old_manifest_json.as_bytes(),
        )
        .await
        .unwrap();
        let (_, journal_hash) = file_revision_and_hash(&provider, &journal_path).await;
        write_v022_acks(
            &provider,
            V022_DESKTOP,
            vec![v022_skipped_ack(&journal_path, &journal_hash)],
        )
        .await;
        let old_manifest: DeviceMetadata = serde_json::from_str(&old_manifest_json).unwrap();
        assert_eq!(old_manifest.outbox_versions, None);

        // What the engine hands the importer after pulling the old desktop's manifest.
        let known_ids =
            collect_known_ids_from_manifests(&[(V022_DESKTOP.to_string(), old_manifest)]);
        let summary = SyncSummary {
            pull_clean: true,
            fetched_manifests: vec![V022_DESKTOP.to_string()],
            ..Default::default()
        };
        let conn = setup_test_db();
        let sink = TestOutboxSink::default();
        let res = run_outbox_import_cycle(
            &provider,
            &provider,
            V2_OWN,
            &test_key_list(),
            known_ids,
            true,
            &summary,
            &media_dir,
            &conn,
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(res.candidates_checked, 1, "only the web device: {res:?}");
        assert_eq!(res.intents_applied, 2, "{res:?}");
        assert_eq!(res.intents_refused, 0);
        let created = raw_entry(&conn, eid);
        assert_eq!(created.journal_id, jid);
        assert_ne!(created.journal_id, default_journal_id(&conn));
        assert_eq!(import_row(&conn, &journal_path).unwrap().outcome, "applied");
        assert_eq!(import_row(&conn, &entry_path).unwrap().outcome, "applied");
        assert!(own_ack(&provider, &journal_path).await.created);
        assert!(own_ack(&provider, &entry_path).await.created);
    }
}
