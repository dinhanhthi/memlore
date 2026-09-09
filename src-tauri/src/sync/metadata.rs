//! Sync metadata types — the per-device manifest written to
//! `{device_id}/metadata.json` and the diff routine that drives `to_pull` /
//! `to_delete_locally` decisions.
//!
//! Metadata is JSON (human-readable, debuggable, schema-tolerant). Entry
//! payloads are binary (see `entry_sync.rs`). Keeping the manifest in JSON
//! lets a human inspect a sync directory without any custom tool.

use serde::{Deserialize, Serialize};

/// One row in a device's `metadata.json`. `updated_at` drives last-write-wins
/// merge across devices; `local_version` is a monotonic counter local to the
/// authoring device used to detect "did we already publish this revision?"
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedEntrySummary {
    pub entry_id: String,
    pub updated_at: i64,
    pub local_version: i64,
    pub is_deleted: bool,
}

/// Same shape for journals — journals are simple metadata-only records, no
/// Yjs blob, but they still need cross-device LWW.
///
/// Journals are intentionally **not** consulted by [`compute_diff`] today;
/// the engine in Chunk 3c will diff journals through a separate routine
/// (likely `compute_journal_diff`) so that journal-level LWW can be tuned
/// independently of entry-level CRDT merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedJournalSummary {
    pub journal_id: String,
    pub updated_at: i64,
    pub local_version: i64,
    pub is_deleted: bool,
}

/// One device's full manifest. Round-trips cleanly through `serde_json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceMetadata {
    pub device_id: String,
    /// Recovery generation under which this manifest was published.
    #[serde(default)]
    pub recovery_generation: u64,
    pub entries: Vec<SyncedEntrySummary>,
    pub journals: Vec<SyncedJournalSummary>,
    /// `true` only after this manifest's push cycle successfully published
    /// `{device_id}/chats.bin`. Older manifests omit the field and deserialize
    /// as `false`, so the channel remains optional for backward compatibility.
    #[serde(default)]
    pub chats_present: bool,
    /// `true` only after this manifest's push cycle successfully published
    /// `{device_id}/memory.bin`. Older manifests omit the field and deserialize
    /// as `false`, so the memory channel remains optional — a peer that never
    /// writes memory cannot poison the flag for devices that do.
    #[serde(default)]
    pub memory_present: bool,
    pub generated_at: i64,
}

/// What `compute_diff` reports back to the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncDiff {
    /// Entry ids whose remote `updated_at` is strictly newer than ours
    /// (or which we've never seen).
    pub to_pull: Vec<String>,
    /// Entry ids the remote marks as deleted strictly later than our own
    /// state — the engine should remove them locally. Each element carries
    /// `(entry_id, tombstone_updated_at)` so the consumer can guard the
    /// soft-delete with `AND updated_at < tombstone_updated_at` rather than
    /// applying it unconditionally against a potentially-stale local view.
    pub to_delete_locally: Vec<(String, i64)>,
    /// Count of remote entries that produced no action — same `usize` as the
    /// `Vec` siblings so callers can compare lengths consistently. Note this
    /// is a count of **remote** entries only; entries the local device has
    /// but the remote does not are invisible to this routine (see contract
    /// note on [`compute_diff`]).
    pub unchanged: usize,
}

/// Sort remote entry ids for progressive pull: newest remote update first,
/// then entry id ascending so resumed chunks remain deterministic.
pub(crate) fn sort_to_pull_newest_first(to_pull: &mut [String], remote: &DeviceMetadata) {
    let updated_at_by_id: std::collections::HashMap<&str, i64> = remote
        .entries
        .iter()
        .map(|entry| (entry.entry_id.as_str(), entry.updated_at))
        .collect();
    to_pull.sort_by(|a, b| {
        let a_updated_at = updated_at_by_id
            .get(a.as_str())
            .expect("to_pull entries always come from remote metadata");
        let b_updated_at = updated_at_by_id
            .get(b.as_str())
            .expect("to_pull entries always come from remote metadata");
        b_updated_at.cmp(a_updated_at).then_with(|| a.cmp(b))
    });
}

/// Compare a local manifest to a remote one and report what to pull / delete.
///
/// **Direction:** This is a one-way, **remote → local** diff. It answers
/// "what should I take from this peer?" — never "what should I push to
/// this peer?". The engine in Chunk 3c drives push by walking the
/// `sync_state` table (rows where `status = 'pending'`), not by diffing
/// manifests. Adding a `to_push` field here would be redundant with that
/// schema and would invite the engine to push the same entry once per
/// peer.
///
/// Consequently, an entry that exists locally but not in `remote` is
/// **not surfaced** in any bucket and is **not counted** in `unchanged` —
/// it is simply outside the scope of this function.
///
/// **Tie semantics at equal `updated_at`:** ties favor local (no action).
/// This matches the schema's monotonic `local_version`: a remote
/// announcement at the same wall-clock time that we already wrote
/// represents the very record we authored. `merge_metadata_lww` uses a
/// `device_id` lexicographic tiebreak for the *content* merge, but the
/// *manifest* diff is intentionally simpler — the engine only acts on
/// strictly-newer remote evidence.
///
/// **Pull order:** returned `to_pull` is sorted by remote `updated_at`
/// descending, then `entry_id` ascending for deterministic ties. The engine
/// chunks this list in order, so recent entries arrive first during catch-up.
///
/// Pure function — no I/O, no hidden state — so it is trivial to test.
pub fn compute_diff(local: &DeviceMetadata, remote: &DeviceMetadata) -> SyncDiff {
    let mut to_pull = Vec::new();
    let mut to_delete_locally = Vec::new();
    let mut unchanged: usize = 0;

    for r in &remote.entries {
        match local.entries.iter().find(|l| l.entry_id == r.entry_id) {
            None => {
                if r.is_deleted {
                    // Never seen and already tombstoned — nothing to do.
                    unchanged += 1;
                } else {
                    to_pull.push(r.entry_id.clone());
                }
            }
            Some(l) => {
                if r.updated_at > l.updated_at {
                    if r.is_deleted && !l.is_deleted {
                        to_delete_locally.push((r.entry_id.clone(), r.updated_at));
                    } else if !r.is_deleted {
                        to_pull.push(r.entry_id.clone());
                    } else {
                        // Both deleted, remote newer — already gone locally.
                        unchanged += 1;
                    }
                } else {
                    // Equal or older `updated_at` — local already represents
                    // the authoritative state per the contract above
                    // (ties favor local).
                    unchanged += 1;
                }
            }
        }
    }

    sort_to_pull_newest_first(&mut to_pull, remote);

    SyncDiff {
        to_pull,
        to_delete_locally,
        unchanged,
    }
}

/// One row in a device's `settings.bin` — value plus the wall-clock the
/// authoring device stamped when it wrote the row. Per-key LWW uses
/// `updated_at` as the merge key on the receiver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedSetting {
    pub value: String,
    pub updated_at: i64,
    /// When set, the authoring device deleted this key. Receivers apply the
    /// tombstone under the same per-key LWW as value writes.
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

/// The full journal payload pushed to `{device_id}/journals/{journal_id}.bin`.
///
/// Carries everything peers need to reconstruct local state: name, color,
/// sort_order, is_deleted, created/updated timestamps, and the set
/// of `auto_tag_ids` for new-entry auto-apply. Encrypted at rest like
/// entries — the trust boundary is identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalPayload {
    pub journal_id: String,
    pub device_id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub is_deleted: bool,
    #[serde(default)]
    pub is_locked: bool,
    #[serde(default)]
    pub is_invisible: bool,
    /// Owning invisible vault when `is_invisible` is true. `None` when not
    /// invisible (ingest forces NULL) or orphan always-hidden (invisible
    /// without a vault on the wire — README clarification 15).
    #[serde(default)]
    pub vault_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub auto_tag_ids: Vec<String>,
}

/// The streak-cache row on the wire. Single row per device — peers
/// converge via per-row LWW with `longest_streak` ratcheting upward
/// regardless of LWW order (it's a monotonic high-water mark).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreakPayload {
    pub device_id: String,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub last_entry_date: Option<i64>,
    pub updated_at: i64,
}

/// One chat message on the wire. Append-only — same id same content
/// forever. Two devices appending concurrently may pick colliding
/// `seq` values; that's tolerated and the display path sorts by
/// `(seq, created_at, id)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub seq: i64,
    pub created_at: i64,
    /// Per-message AI metadata (assistant rows). Optional for wire
    /// backward-compat with peers that predate this field set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_in: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_out: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<i64>,
    /// Attachment refs pinned to a user turn (entry and/or period picks).
    /// `None`/absent for messages that carry none, and for peers that
    /// predate this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<crate::db::queries::ChatAttachmentRef>>,
    /// Resolved entry ids injected into the prompt for an assistant turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_entry_ids: Option<Vec<String>>,
    /// Memory item ids folded into the prompt for an assistant turn.
    /// `memory_items` themselves sync via `memory.bin` (plan decision 10),
    /// so this rides the wire the same way `source_entry_ids` does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_ids: Option<Vec<String>>,
}

/// One chat session on the wire, with its messages inline. Sessions
/// LWW on `updated_at`; messages union-merge by `id` on the receiver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedChatSession {
    pub id: String,
    pub title: Option<String>,
    pub persona: String,
    pub persona_prompt_snapshot: String,
    pub language: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_deleted: bool,
    #[serde(default)]
    pub title_is_ai_generated: bool,
    /// Sticky flag: this session has used RAG-injected context at least
    /// once. Defaults `false` for peers that predate this field.
    #[serde(default)]
    pub used_rag: bool,
    /// Conversion watermark: the entry id produced from this session, and
    /// the highest assistant `seq` it covered. `None` for sessions that
    /// were never converted, and for peers that predate these fields
    /// (`#[serde(default)]` → `None` so an old device cannot poison the
    /// watermark; the receiver-side ratchet treats `None` as "no info").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub converted_entry_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub converted_through_seq: Option<i64>,
    /// Epoch SECONDS when the user pinned this session to the top of the
    /// list; `None` = unpinned. LWW-governed by `updated_at` like `title`
    /// (pin/unpin bumps it) — deliberately NOT a ratchet like `used_rag`
    /// or the conversion watermark above, because unpin is `None` and a
    /// ratchet could never propagate it.
    ///
    /// Two rules the attribute pair below encodes:
    /// - Never add `deny_unknown_fields` here or to `ChatPayload`: every
    ///   session shares one payload, so one unrecognised key from a newer
    ///   peer would drop the device's entire chat history. Guarded by
    ///   `chat_payload_tolerates_unknown_fields_from_a_newer_peer`.
    /// - `skip_serializing_if` keeps the wire — and therefore the push
    ///   content hash, which is `serde_json::to_vec(&sessions)` —
    ///   byte-identical for unpinned sessions, so upgrading does not force
    ///   a one-time full `chats.bin` re-upload across the fleet. Guarded by
    ///   `synced_chat_session_omits_none_pinned_at_from_wire`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<i64>,
    #[serde(default)]
    pub messages: Vec<SyncedChatMessage>,
}

/// Device-scoped chat history manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatPayload {
    pub device_id: String,
    pub generated_at: i64,
    pub sessions: Vec<SyncedChatSession>,
}

/// One contributing source behind a synced memory item. Mirrors the
/// `memory_item_sources` row shape ([`crate::db::memory::MemorySourceRow`]).
/// Receivers union-merge by `(source_type, source_id)` — a repeated link is
/// a no-op, not a conflict. Struct (not a bare tuple) so the wire is
/// self-describing and the receiver code reads by name, matching how every
/// other ref-shaped payload in this file is structured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySourceRef {
    pub source_type: String,
    pub source_id: String,
}

/// One memory-embedding vector on the wire. The `vec` field reuses the
/// **exact** encoding [`crate::sync::embedding_sync::EmbeddingChunkVector::vec`]
/// established for entry embeddings: little-endian f32 bytes, `len() == dim * 4`,
/// passed through verbatim from/to the `memory_embeddings.vec` BLOB column (see
/// [`crate::db::embeddings::vec_to_blob`] / [`crate::db::embeddings::blob_to_vec`]).
/// Do not invent a new encoding here — T6.2 relies on byte-for-byte
/// compatibility with the existing encrypt/decrypt path.
///
/// `model_id` is the namespaced id of the **writing** device's memory-embed
/// slot (Phase 2 T2.2). That slot is user-configurable within the on-machine
/// classes, so peers can legitimately differ. T6.2 treats a `model_id`
/// mismatch as a normal "adopt-on-match miss" (the item simply arrives
/// vector-less and the Phase 3 backfill pass re-embeds it locally), **not**
/// an exception — so this type just carries the string.
///
/// `Eq` is safe here (no float fields — `vec` is raw bytes, not `f32`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedMemoryVec {
    pub model_id: String,
    pub dim: i64,
    /// Little-endian f32 bytes, `len() == dim * 4`. Mirrors
    /// [`crate::sync::embedding_sync::EmbeddingChunkVector::vec`] and the
    /// `memory_embeddings.vec` BLOB.
    pub vec: Vec<u8>,
    pub content_hash: String,
    pub indexed_at: i64,
}

/// One memory item on the wire: the distilled fact text plus its contributing
/// sources and any embedding vectors authored by this device under its
/// memory-embed slot. Receivers LWW-merge per item id on `updated_at`
/// (tombstone wins when strictly newer), union-merge `sources`, and
/// adopt-on-match each `embeddings` row whose `model_id` equals the local
/// memory-embed `model_id` (T6.2). Tombstones (`is_deleted = true`) ride the
/// same channel so a soft-delete converges via LWW rather than disappearing —
/// physical deletion on one device would lose the "this was deleted" signal
/// on every peer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedMemoryItem {
    pub id: String,
    pub text: String,
    pub source_type: String,
    pub enabled: bool,
    pub is_deleted: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub sources: Vec<MemorySourceRef>,
    #[serde(default)]
    pub embeddings: Vec<SyncedMemoryVec>,
}

/// Device-scoped memory manifest. The full set of memory items authored by
/// `device_id` (including tombstones, so LWW can converge deletions) plus the
/// optional singleton persona document is sent every push as
/// `{device_id}/memory.bin`. Peers LWW-merge per item and for the persona on
/// pull.
///
/// `device_id` and `generated_at` are intentionally absent here — unlike
/// [`ChatPayload`] / [`TagsPayload`], the memory channel derives device
/// ownership from the `{device_id}/memory.bin` cloud path itself (the
/// manifest already carries `device_id` at the directory level), and timing
/// is covered by the parent manifest's `generated_at`. Adding them would be
/// duplicate state with no reader.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryPayload {
    pub items: Vec<SyncedMemoryItem>,
    /// The singleton Build Your Persona document. Older peers did not send
    /// this field, so its absence must remain a harmless no-op on pull.
    #[serde(default)]
    pub persona: Option<SyncedPersona>,
}

/// The sync representation of the singleton Build Your Persona document.
/// This deliberately has no vectors or device identity: its enclosing
/// device-scoped memory snapshot supplies the latter, and persona is just
/// user-authored/generated text resolved as a single LWW document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedPersona {
    pub answers_json: String,
    pub traits_text: String,
    pub style_text: String,
    pub enabled: bool,
    pub user_edited: bool,
    pub generated_at: Option<i64>,
    pub updated_at: i64,
}

/// One location alias on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncedLocationAlias {
    pub id: String,
    pub label: String,
    pub address: String,
    pub latitude: f64,
    pub longitude: f64,
    pub radius_meters: Option<f64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocationAliasesPayload {
    pub device_id: String,
    pub generated_at: i64,
    pub aliases: Vec<SyncedLocationAlias>,
}

/// One row in a peer's AI audit-log snapshot. `local_seq` is the peer's
/// own per-device sequence — the receiver stores it verbatim so a later
/// snapshot from the same peer can overwrite the same row in-place.
///
/// No content fields by construction (mirrors `AiAuditLogInsert`). All
/// fields are metadata-only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedAiAuditRow {
    pub local_seq: i64,
    pub created_at: i64,
    pub feature: String,
    pub operation: String,
    pub provider_id: String,
    pub model_id: String,
    pub endpoint_host: String,
    pub endpoint_class: String,
    pub payload_bytes: i64,
    pub latency_ms: i64,
    pub status: String,
    pub error_code: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    /// Snapshot of the originating machine's display name. Missing on
    /// older peer payloads → empty string (do not fail the whole audit
    /// pull for one new field).
    #[serde(default)]
    pub device_name: String,
}

/// Device-scoped AI audit-log manifest. The full set of rows authored by
/// `device_id` is sent every push — peers snapshot-replace their copy
/// of this device's rows on pull, so a local retention purge propagates
/// to every peer on the next sync tick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiAuditPayload {
    pub device_id: String,
    pub generated_at: i64,
    pub rows: Vec<SyncedAiAuditRow>,
}

/// One cached period review / theme-insights row on the wire.
/// Latest `created_at` wins across models and devices (LWW on pull).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedAiReview {
    pub kind: String,
    pub period_start: i64,
    pub period_end: i64,
    pub model_id: String,
    pub result_json: String,
    pub entry_count: i64,
    pub created_at: i64,
}

/// Device-scoped AI reviews manifest. Full-table hashed bin like
/// templates/locations — empty `reviews` still serializes so a device
/// with no cached reviews publishes a stable hash-gated blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiReviewsPayload {
    pub device_id: String,
    pub generated_at: i64,
    pub reviews: Vec<SyncedAiReview>,
}

/// One user template on the wire. Predefined templates do not sync —
/// each device seeds its own copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedTemplate {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Template content is a binary Yjs document, base64-encoded on the
    /// wire because JSON doesn't carry raw bytes.
    pub content_b64: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_deleted: bool,
}

/// Device-scoped templates manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplatesPayload {
    pub device_id: String,
    pub generated_at: i64,
    pub templates: Vec<SyncedTemplate>,
}

/// One tag on the wire. Includes its soft-delete state — peers materialize
/// tombstones so deletions converge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedTag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub updated_at: i64,
    pub is_deleted: bool,
}

/// One device's tags manifest. Encrypted at rest in `{device_id}/tags.bin`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagsPayload {
    pub device_id: String,
    pub generated_at: i64,
    pub tags: Vec<SyncedTag>,
}

/// One device's settings manifest. Round-trips through JSON inside the
/// encrypted `settings.bin` blob on the sync channel.
///
/// `settings` is a map keyed by setting key. Only keys in
/// [`crate::db::SYNCABLE_SETTING_KEYS`] are serialized — credentials and
/// device-local rows stay on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsPayload {
    pub device_id: String,
    pub generated_at: i64,
    pub settings: std::collections::BTreeMap<String, SyncedSetting>,
}

/// One media row, serialized inside `EntryMetadata.media`. The receiving
/// peer materializes this into the local `media` table with `cloud_path`
/// pointing at the authoring device's `{device_id}/media/{id}` object.
///
/// Field set mirrors `db::Media` minus device-local concerns
/// (`storage_path`, `thumbnail_path`, `upload_status`, etc.) — those are
/// re-derived on the receiver. `id` is the authoring device's media id and
/// the same id used by the cloud filename.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncMediaItem {
    pub id: String,
    pub file_name: String,
    pub file_type: String,
    pub file_size: Option<i64>,
    pub sort_order: i64,
    pub created_at: i64,
    pub insertion_mode: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_seconds: Option<f64>,
    pub exif_date: Option<i64>,
    pub exif_latitude: Option<f64>,
    pub exif_longitude: Option<f64>,
}

/// POINT OF NO RETURN (T38): one deleted media id in the entry manifest.
/// Peers honour it only when `media.created_at <= deleted_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncDeletedMediaItem {
    pub id: String,
    pub deleted_at: i64,
}

/// Journal-channel diff result. Mirrors [`SyncDiff`] but for journals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalSyncDiff {
    /// Journal ids whose remote `updated_at` is strictly newer than ours.
    pub to_pull: Vec<String>,
    /// Journal ids the remote marks deleted strictly later than our own
    /// state — the engine flips them deleted locally without pulling the
    /// full payload (the tombstone summary is sufficient).
    pub to_delete_locally: Vec<String>,
    pub unchanged: usize,
}

/// Compare a local journal summary against a remote one and report
/// which journals to pull or tombstone. Same semantics as
/// [`compute_diff`] for entries — remote→local only, ties favor local.
pub fn compute_journal_diff(
    local: &[SyncedJournalSummary],
    remote: &[SyncedJournalSummary],
) -> JournalSyncDiff {
    let mut to_pull = Vec::new();
    let mut to_delete_locally = Vec::new();
    let mut unchanged: usize = 0;
    for r in remote {
        match local.iter().find(|l| l.journal_id == r.journal_id) {
            None => {
                if r.is_deleted {
                    unchanged += 1;
                } else {
                    to_pull.push(r.journal_id.clone());
                }
            }
            Some(l) => {
                if r.updated_at > l.updated_at {
                    if r.is_deleted && !l.is_deleted {
                        to_delete_locally.push(r.journal_id.clone());
                    } else if !r.is_deleted {
                        to_pull.push(r.journal_id.clone());
                    } else {
                        unchanged += 1;
                    }
                } else {
                    unchanged += 1;
                }
            }
        }
    }
    JournalSyncDiff {
        to_pull,
        to_delete_locally,
        unchanged,
    }
}

/// Per-entry LWW-tracked metadata fields. Yjs handles content merge; this
/// struct handles everything else (title, location, weather, …) via
/// last-write-wins on `updated_at`, with `device_id` + `entry_id` as the
/// tiebreak when two devices wrote at the same millisecond.
///
/// This struct is serialized, encrypted, and placed inside
/// `SyncEntryPayload.metadata_ciphertext` — so **every** field here rides
/// inside ciphertext on disk. That is why `content_text` lives here
/// (plaintext in the local DB for FTS5, but ciphertext on the sync
/// channel) and why `journal_name` can ride without a separate materialized
/// journal manifest.
///
/// `journal_color` and `journal_updated_at` carry the
/// authoring device's view of the journal's visual identity. The receiver
/// uses `journal_updated_at` as LWW key against the local journal row so
/// an older entry pulled from a peer cannot rewind a newer journal edit.
///
/// `media` carries the full set of media rows attached to this entry so
/// the receiver can materialize them in its own `media` table and point
/// each row's `cloud_path` at the authoring device. Without this, the
/// peer has no DB row to drive `resolve_media` and the editor renders
/// broken-image placeholders for every inline / attached image.
///
/// All new optional fields and the `media` list default sensibly on
/// deserialization so payloads written by older devices (pre-fields)
/// still parse without error.
// `Eq` is not derived because `Option<f64>` does not implement `Eq`
// (NaN violates the contract). `PartialEq` is enough for tests and LWW
// tiebreaks don't compare float fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntryMetadata {
    pub entry_id: String,
    pub device_id: String,
    pub updated_at: i64,
    pub entry_date: i64,
    pub created_at: i64,
    pub journal_id: String,
    pub journal_name: Option<String>,
    #[serde(default)]
    pub journal_color: Option<String>,
    #[serde(default)]
    pub journal_updated_at: Option<i64>,
    pub title: Option<String>,
    pub preview_text: Option<String>,
    pub content_text: Option<String>,
    pub location_label: Option<String>,
    pub location_address: Option<String>,
    pub weather_summary: Option<String>,
    pub weather_icon: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub emotion: Option<String>,
    pub is_favorite: bool,
    pub is_deleted: bool,
    /// Lock flags are LWW-tracked as part of the whole metadata object.
    /// A newer content edit carries that device's current lock flags.
    #[serde(default)]
    pub is_locked: bool,
    #[serde(default)]
    pub is_invisible: bool,
    /// Owning invisible vault when `is_invisible` is true. `None` when not
    /// invisible (ingest forces NULL) or orphan always-hidden (invisible
    /// without a vault on the wire — README clarification 15).
    /// Keep without `skip_serializing_if` so content-hash stays stable.
    #[serde(default)]
    pub vault_id: Option<String>,
    #[serde(default)]
    pub cover_media_id: Option<String>,
    #[serde(default)]
    pub entry_date_user_edited: bool,
    #[serde(default)]
    pub content_language: Option<String>,
    /// Tag ids attached to this entry. Authoritative on the wire: the
    /// receiver replaces the entry's tag set with exactly these ids
    /// during ingest. Tag *content* (name, color) rides via a separate
    /// tags channel — see Stage 2 of the full-state sync rollout.
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub media: Vec<SyncMediaItem>,
    /// POINT OF NO RETURN (T38): explicit media deletions. Older devices
    /// omit this field (`#[serde(default)]` → empty). Honouring a tombstone
    /// deletes the peer's row and cached file; the own-cloud blob is swept
    /// by `reconcile_own_media_files` on the uploader.
    #[serde(default)]
    pub deleted_media: Vec<SyncDeletedMediaItem>,
}

/// Last-write-wins merge: newer `updated_at` wins; on tie, the lexicographic
/// `device_id` breaks the tie deterministically. Pure and side-effect-free
/// so two devices given the same inputs always converge on the same output.
///
/// **Invariant:** both inputs must describe the same entry — caller is
/// responsible for not crossing entries. Enforced via `debug_assert_eq!`
/// in debug builds; in release builds a mismatched call would silently
/// merge two unrelated entries, which is a much louder bug to hit in
/// integration tests than a panic in production.
pub fn merge_metadata_lww(local: &EntryMetadata, remote: &EntryMetadata) -> EntryMetadata {
    debug_assert_eq!(
        local.entry_id, remote.entry_id,
        "merge_metadata_lww called with mismatched entry ids ({} vs {})",
        local.entry_id, remote.entry_id
    );
    if remote.updated_at > local.updated_at {
        return remote.clone();
    }
    if local.updated_at > remote.updated_at {
        return local.clone();
    }
    // Tiebreak on `device_id` alone — `entry_id` is invariant by the
    // contract above, so including it in the key would be dead code.
    if remote.device_id > local.device_id {
        remote.clone()
    } else {
        local.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, updated_at: i64, is_deleted: bool) -> SyncedEntrySummary {
        SyncedEntrySummary {
            entry_id: id.to_string(),
            updated_at,
            local_version: 1,
            is_deleted,
        }
    }

    fn meta(device: &str, entries: Vec<SyncedEntrySummary>) -> DeviceMetadata {
        DeviceMetadata {
            device_id: device.to_string(),
            recovery_generation: 0,
            entries,
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 1_700_000_000,
        }
    }

    fn entry_meta(entry_id: &str, device_id: &str, updated_at: i64) -> EntryMetadata {
        EntryMetadata {
            entry_id: entry_id.to_string(),
            device_id: device_id.to_string(),
            updated_at,
            entry_date: updated_at,
            created_at: updated_at,
            journal_id: "default-journal".to_string(),
            journal_name: Some("My Journal".to_string()),
            journal_color: None,
            journal_updated_at: None,
            title: Some(format!("title from {device_id}")),
            preview_text: None,
            content_text: None,
            location_label: None,
            location_address: None,
            weather_summary: None,
            weather_icon: None,
            latitude: None,
            longitude: None,
            emotion: None,
            is_favorite: false,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            vault_id: None,
            cover_media_id: None,
            entry_date_user_edited: false,
            content_language: None,
            tag_ids: vec![],
            media: vec![],
            deleted_media: vec![],
        }
    }

    // ─── DeviceMetadata JSON round-trip ──────────────────────────────────

    #[test]
    fn device_metadata_json_roundtrip() {
        let m = DeviceMetadata {
            device_id: "dev-a".to_string(),
            recovery_generation: 0,
            entries: vec![entry("e1", 100, false), entry("e2", 200, true)],
            journals: vec![SyncedJournalSummary {
                journal_id: "j1".to_string(),
                updated_at: 50,
                local_version: 1,
                is_deleted: false,
            }],
            chats_present: true,
            memory_present: true,
            generated_at: 1_700_000_000,
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: DeviceMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
        assert!(back.memory_present);
    }

    #[test]
    fn empty_device_metadata_roundtrips() {
        let m = DeviceMetadata {
            device_id: "dev-b".to_string(),
            recovery_generation: 0,
            entries: vec![],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 0,
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: DeviceMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }

    // ─── compute_diff ────────────────────────────────────────────────────

    #[test]
    fn legacy_device_metadata_defaults_channel_presence_to_false() {
        let json = r#"{"device_id":"legacy","entries":[],"journals":[],"generated_at":1}"#;
        let metadata: DeviceMetadata = serde_json::from_str(json).unwrap();
        assert!(!metadata.chats_present);
    }

    #[test]
    fn diff_pulls_new_remote_entry_not_in_local() {
        let local = meta("a", vec![]);
        let remote = meta("b", vec![entry("e1", 100, false)]);
        let d = compute_diff(&local, &remote);
        assert_eq!(d.to_pull, vec!["e1".to_string()]);
        assert!(d.to_delete_locally.is_empty());
        assert_eq!(d.unchanged, 0);
    }

    #[test]
    fn diff_pulls_newest_remote_entries_first_with_deterministic_ties() {
        let local = meta("a", vec![]);
        let remote = meta(
            "b",
            vec![
                entry("z-tie", 200, false),
                entry("old", 100, false),
                entry("a-tie", 200, false),
                entry("newest", 300, false),
            ],
        );

        let d = compute_diff(&local, &remote);

        assert_eq!(
            d.to_pull,
            vec!["newest", "a-tie", "z-tie", "old"],
            "pulls must be remote-updated newest-first, then entry id ascending"
        );
    }

    #[test]
    fn diff_skips_entry_when_local_is_newer() {
        let local = meta("a", vec![entry("e1", 200, false)]);
        let remote = meta("b", vec![entry("e1", 100, false)]);
        let d = compute_diff(&local, &remote);
        assert!(d.to_pull.is_empty());
        assert!(d.to_delete_locally.is_empty());
        assert_eq!(d.unchanged, 1);
    }

    #[test]
    fn diff_pulls_entry_when_remote_is_newer() {
        let local = meta("a", vec![entry("e1", 100, false)]);
        let remote = meta("b", vec![entry("e1", 200, false)]);
        let d = compute_diff(&local, &remote);
        assert_eq!(d.to_pull, vec!["e1".to_string()]);
        assert_eq!(d.unchanged, 0);
    }

    #[test]
    fn diff_marks_remote_tombstone_for_local_delete() {
        let local = meta("a", vec![entry("e1", 100, false)]);
        let remote = meta("b", vec![entry("e1", 200, true)]);
        let d = compute_diff(&local, &remote);
        // Tombstone carries (entry_id, tombstone_updated_at) so the engine
        // can guard the soft-delete with AND updated_at < tombstone_updated_at.
        assert_eq!(d.to_delete_locally, vec![("e1".to_string(), 200)]);
        assert!(d.to_pull.is_empty());
    }

    #[test]
    fn diff_ignores_remote_tombstone_for_unknown_entry() {
        let local = meta("a", vec![]);
        let remote = meta("b", vec![entry("e1", 100, true)]);
        let d = compute_diff(&local, &remote);
        assert!(d.to_pull.is_empty());
        assert!(d.to_delete_locally.is_empty());
        assert_eq!(d.unchanged, 1);
    }

    #[test]
    fn diff_equal_state_reports_unchanged() {
        let local = meta("a", vec![entry("e1", 100, false), entry("e2", 200, false)]);
        let remote = meta("b", vec![entry("e1", 100, false), entry("e2", 200, false)]);
        let d = compute_diff(&local, &remote);
        assert!(d.to_pull.is_empty());
        assert!(d.to_delete_locally.is_empty());
        assert_eq!(d.unchanged, 2);
    }

    #[test]
    fn diff_ignores_entries_only_present_locally() {
        // Contract: compute_diff is remote→local only. A local-only entry
        // is invisible — not in any bucket, not counted as `unchanged`.
        let local = meta("a", vec![entry("e-local-only", 100, false)]);
        let remote = meta("b", vec![]);
        let d = compute_diff(&local, &remote);
        assert!(d.to_pull.is_empty());
        assert!(d.to_delete_locally.is_empty());
        assert_eq!(d.unchanged, 0);
    }

    #[test]
    fn diff_equal_timestamp_tombstone_favors_local() {
        // Equal `updated_at` ties favor local per the documented contract,
        // even when the remote claims tombstone and local is alive.
        let local = meta("a", vec![entry("e1", 100, false)]);
        let remote = meta("b", vec![entry("e1", 100, true)]);
        let d = compute_diff(&local, &remote);
        assert!(d.to_pull.is_empty());
        assert!(d.to_delete_locally.is_empty());
        assert_eq!(d.unchanged, 1);
    }

    #[test]
    fn diff_handles_multi_entry_mixed_state() {
        // Realistic shape: many entries, every bucket exercised in one call.
        let local = meta(
            "a",
            vec![
                entry("e1", 100, false),           // remote newer → to_pull
                entry("e2", 200, false),           // remote tombstoned newer → to_delete_locally
                entry("e3", 300, false),           // remote equal → unchanged
                entry("e-local-only", 400, false), // remote absent → invisible
            ],
        );
        let remote = meta(
            "b",
            vec![
                entry("e1", 150, false),
                entry("e2", 250, true),
                entry("e3", 300, false),
                entry("e-new", 50, false),  // not in local → to_pull
                entry("e-ghost", 50, true), // unknown tombstone → unchanged
            ],
        );
        let d = compute_diff(&local, &remote);
        let mut to_pull = d.to_pull.clone();
        to_pull.sort();
        assert_eq!(to_pull, vec!["e-new".to_string(), "e1".to_string()]);
        // e2 tombstoned at 250, carrying the tombstone timestamp.
        assert_eq!(d.to_delete_locally, vec![("e2".to_string(), 250)]);
        // remote-only `unchanged`: e3 (equal) + e-ghost (unknown tombstone) = 2
        assert_eq!(d.unchanged, 2);
    }

    #[test]
    fn diff_handles_remote_already_deleted_locally() {
        let local = meta("a", vec![entry("e1", 100, true)]);
        let remote = meta("b", vec![entry("e1", 200, true)]);
        let d = compute_diff(&local, &remote);
        assert!(d.to_pull.is_empty());
        assert!(d.to_delete_locally.is_empty());
        assert_eq!(d.unchanged, 1);
    }

    // ─── merge_metadata_lww ─────────────────────────────────────────────

    #[test]
    fn lww_newer_updated_at_wins() {
        let l = entry_meta("e1", "dev-a", 100);
        let r = entry_meta("e1", "dev-b", 200);
        let m = merge_metadata_lww(&l, &r);
        assert_eq!(m.device_id, "dev-b");
        assert_eq!(m.updated_at, 200);
    }

    #[test]
    fn lww_older_remote_loses() {
        let l = entry_meta("e1", "dev-a", 200);
        let r = entry_meta("e1", "dev-b", 100);
        let m = merge_metadata_lww(&l, &r);
        assert_eq!(m.device_id, "dev-a");
    }

    #[test]
    fn lww_equal_timestamps_tiebreak_is_deterministic() {
        let l = entry_meta("e1", "dev-a", 100);
        let r = entry_meta("e1", "dev-b", 100);
        // Same input → same output, every time.
        let a = merge_metadata_lww(&l, &r);
        let b = merge_metadata_lww(&l, &r);
        assert_eq!(a, b);
        // Tiebreak: lexicographically larger (device_id, entry_id) wins → "dev-b".
        assert_eq!(a.device_id, "dev-b");
    }

    #[test]
    fn entry_metadata_json_roundtrip() {
        // EntryMetadata crosses the wire to other devices via the encrypted
        // metadata blob, so JSON faithfulness is load-bearing.
        let m = EntryMetadata {
            entry_id: "e-roundtrip".to_string(),
            device_id: "dev-x".to_string(),
            updated_at: 1_700_000_000,
            entry_date: 1_700_000_000,
            created_at: 1_699_000_000,
            journal_id: "j-1".to_string(),
            journal_name: Some("Travel log ✈️".to_string()),
            journal_color: Some("#ff6688".to_string()),
            journal_updated_at: Some(1_700_000_000),
            title: Some("nhật ký 日記".to_string()),
            preview_text: Some("preview".to_string()),
            content_text: Some("full body — encrypted before it hits disk".to_string()),
            location_label: None,
            location_address: Some("Hà Nội".to_string()),
            weather_summary: Some("sunny".to_string()),
            weather_icon: Some("01d".to_string()),
            latitude: Some(21.028511),
            longitude: Some(105.804817),
            emotion: Some("good".to_string()),
            is_favorite: true,
            is_deleted: false,
            is_locked: true,
            is_invisible: false,
            vault_id: None,
            cover_media_id: Some("media-abc".to_string()),
            entry_date_user_edited: true,
            content_language: Some("vi".to_string()),
            tag_ids: vec!["tag-1".to_string(), "tag-2".to_string()],
            media: vec![SyncMediaItem {
                id: "media-abc".to_string(),
                file_name: "photo.jpg".to_string(),
                file_type: "image/jpeg".to_string(),
                file_size: Some(2048),
                sort_order: 0,
                created_at: 1_700_000_000,
                insertion_mode: "inline".to_string(),
                width: Some(1024),
                height: Some(768),
                duration_seconds: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            }],
            deleted_media: vec![SyncDeletedMediaItem {
                id: "media-gone".to_string(),
                deleted_at: 1_700_000_100,
            }],
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: EntryMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
        assert!(back.is_locked);
        assert!(!back.is_invisible);
        assert!(back.vault_id.is_none());
    }

    #[test]
    fn entry_metadata_parses_legacy_json_without_new_fields() {
        // A peer running the pre-fix code wrote a payload without the new
        // journal_color/updated_at fields and without the media list.
        // The deserializer must accept it via #[serde(default)] so a single
        // out-of-date device cannot poison every sync tick.
        let legacy = serde_json::json!({
            "entry_id": "e-legacy",
            "device_id": "dev-old",
            "updated_at": 1_700_000_000_i64,
            "entry_date": 1_700_000_000_i64,
            "created_at": 1_699_000_000_i64,
            "journal_id": "j-1",
            "journal_name": "Legacy Journal",
            "title": null,
            "preview_text": null,
            "content_text": null,
            "location_label": null,
            "location_address": null,
            "weather_summary": null,
            "weather_icon": null,
            "latitude": null,
            "longitude": null,
            "emotion": null,
            "is_favorite": false,
            "is_deleted": false,
        });
        let parsed: EntryMetadata = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.journal_color, None);
        assert_eq!(parsed.journal_updated_at, None);
        assert!(parsed.media.is_empty());
        assert!(parsed.deleted_media.is_empty());
        assert!(!parsed.is_locked);
        assert!(!parsed.is_invisible);
        assert!(parsed.vault_id.is_none());
    }

    #[test]
    fn journal_payload_json_roundtrip_preserves_lock_flags() {
        let payload = JournalPayload {
            journal_id: "journal-1".to_string(),
            device_id: "device-a".to_string(),
            name: "Private".to_string(),
            color: Some("violet".to_string()),
            sort_order: 7,
            is_deleted: false,
            is_locked: true,
            is_invisible: false,
            vault_id: None,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_001,
            auto_tag_ids: vec!["tag-1".to_string()],
        };

        let json = serde_json::to_string(&payload).unwrap();
        let back: JournalPayload = serde_json::from_str(&json).unwrap();

        assert_eq!(back, payload);
        assert!(back.is_locked);
        assert!(!back.is_invisible);
        assert!(back.vault_id.is_none());
    }

    #[test]
    fn entry_and_journal_metadata_roundtrip_vault_id() {
        let mut entry = entry_meta("e-vault", "dev-a", 1_700_000_000);
        entry.is_invisible = true;
        entry.vault_id = Some("vault-xyz".to_string());
        let entry_back: EntryMetadata =
            serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
        assert_eq!(entry_back.vault_id.as_deref(), Some("vault-xyz"));
        assert!(entry_back.is_invisible);

        let journal = JournalPayload {
            journal_id: "j-vault".to_string(),
            device_id: "dev-a".to_string(),
            name: "Hidden".to_string(),
            color: None,
            sort_order: 0,
            is_deleted: false,
            is_locked: false,
            is_invisible: true,
            vault_id: Some("vault-xyz".to_string()),
            created_at: 1,
            updated_at: 2,
            auto_tag_ids: vec![],
        };
        let journal_back: JournalPayload =
            serde_json::from_str(&serde_json::to_string(&journal).unwrap()).unwrap();
        assert_eq!(journal_back.vault_id.as_deref(), Some("vault-xyz"));
    }

    #[test]
    fn lww_tiebreak_is_symmetric() {
        // Swapping local/remote at equal timestamps must yield the same winner.
        let x = entry_meta("e1", "dev-a", 100);
        let y = entry_meta("e1", "dev-b", 100);
        let from_xy = merge_metadata_lww(&x, &y);
        let from_yx = merge_metadata_lww(&y, &x);
        assert_eq!(from_xy, from_yx);
    }

    // ─── SyncedChatSession forward-compat for conversion watermark ──────
    //
    // `converted_entry_id` / `converted_through_seq` are `#[serde(default)]`,
    // so an old-peer payload (never heard of these keys) deserializes to
    // `None`. The receiver-side ratchet then treats `None` as "no info" and
    // must not overwrite a known watermark. This test pins the wire shape —
    // a single outdated peer must remain a no-op for the watermark.

    #[test]
    fn chat_payload_legacy_without_conversion_keys_parses_to_none() {
        // Old-peer shape: a full ChatPayload JSON without the two new keys
        // on any session. Round-trip must succeed and yield `None` for both
        // fields on every session.
        let legacy = serde_json::json!({
            "device_id": "dev-old",
            "generated_at": 1_700_000_000_i64,
            "sessions": [{
                "id": "s1",
                "title": null,
                "persona": "empathetic",
                "persona_prompt_snapshot": "p",
                "language": "auto",
                "created_at": 100_i64,
                "updated_at": 100_i64,
                "is_deleted": false,
                "messages": []
            }],
        });
        let parsed: ChatPayload = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(parsed.sessions[0].converted_entry_id, None);
        assert_eq!(parsed.sessions[0].converted_through_seq, None);
    }

    #[test]
    fn chat_payload_with_conversion_keys_roundtrips() {
        // New-peer shape: both keys present and non-None. Round-trip must
        // preserve them exactly, and `skip_serializing_if = Option::is_none`
        // must not strip non-`None` values.
        let payload = ChatPayload {
            device_id: "dev-new".to_string(),
            generated_at: 1_700_000_000,
            sessions: vec![SyncedChatSession {
                id: "s1".to_string(),
                title: None,
                persona: "empathetic".to_string(),
                persona_prompt_snapshot: "p".to_string(),
                language: "auto".to_string(),
                created_at: 100,
                updated_at: 100,
                is_deleted: false,
                title_is_ai_generated: false,
                used_rag: false,
                converted_entry_id: Some("entry-aaaa".to_string()),
                converted_through_seq: Some(4),
                pinned_at: None,
                messages: vec![],
            }],
        };
        let json = serde_json::to_string(&payload).unwrap();
        let back: ChatPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back, payload);
        assert_eq!(
            back.sessions[0].converted_entry_id.as_deref(),
            Some("entry-aaaa")
        );
        assert_eq!(back.sessions[0].converted_through_seq, Some(4));
    }

    #[test]
    fn synced_chat_session_omits_none_conversion_keys_from_wire() {
        // `skip_serializing_if = Option::is_none` keeps the wire compact for
        // never-converted sessions. A never-converted session serializes
        // without either key, and an explicit `null` on the wire still
        // deserializes back to `None` (no "missing field" error).
        let s = SyncedChatSession {
            id: "s1".to_string(),
            title: None,
            persona: "empathetic".to_string(),
            persona_prompt_snapshot: "p".to_string(),
            language: "auto".to_string(),
            created_at: 100,
            updated_at: 100,
            is_deleted: false,
            title_is_ai_generated: false,
            used_rag: false,
            converted_entry_id: None,
            converted_through_seq: None,
            pinned_at: None,
            messages: vec![],
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(
            !json.contains("converted_entry_id"),
            "wire must omit None conversion keys, got: {json}"
        );
        assert!(
            !json.contains("converted_through_seq"),
            "wire must omit None conversion keys, got: {json}"
        );
        // Explicit nulls on the wire must also deserialize cleanly.
        let with_nulls = serde_json::json!({
            "id": "s1",
            "title": null,
            "persona": "empathetic",
            "persona_prompt_snapshot": "p",
            "language": "auto",
            "created_at": 100_i64,
            "updated_at": 100_i64,
            "is_deleted": false,
            "converted_entry_id": null,
            "converted_through_seq": null,
            "messages": []
        });
        let parsed: SyncedChatSession = serde_json::from_value(with_nulls).unwrap();
        assert_eq!(parsed.converted_entry_id, None);
        assert_eq!(parsed.converted_through_seq, None);
    }

    // ─── SyncedChatSession backward-compat for `pinned_at` ──────────────
    //
    // The catastrophic case: `pinned_at` without `#[serde(default)]` would
    // make a payload written by a NEW peer fail to deserialize on an OLD
    // one — and because sessions live inside one `ChatPayload`, a single
    // missing field drops the user's ENTIRE chat history on that device.
    // These two tests pin both directions of the compatibility window.

    #[test]
    fn synced_chat_session_deserializes_without_pinned_at() {
        // Old-peer shape: the key is simply absent. Must deserialize
        // cleanly to `None` rather than erroring the whole payload.
        let legacy = r#"{
            "id": "s1",
            "title": null,
            "persona": "empathetic",
            "persona_prompt_snapshot": "p",
            "language": "auto",
            "created_at": 1700000000,
            "updated_at": 1700000000,
            "is_deleted": false,
            "messages": []
        }"#;
        let parsed: SyncedChatSession = serde_json::from_str(legacy).unwrap();
        assert_eq!(
            parsed.pinned_at, None,
            "a payload without `pinned_at` must default to None, not error"
        );
    }

    /// The direction that actually matters for an older peer, and the one
    /// no other test covers: a NEWER peer's payload carries keys the older
    /// binary has never heard of. Serde ignores unknown fields by default,
    /// so this passes today — the test exists to fail loudly if anyone ever
    /// adds `deny_unknown_fields` to `SyncedChatSession` or `ChatPayload`.
    /// Because every session rides inside one `ChatPayload`, a single
    /// unrecognised key would abort the whole parse and drop that device's
    /// entire chat history, not just the one field.
    #[test]
    fn chat_payload_tolerates_unknown_fields_from_a_newer_peer() {
        let from_the_future = serde_json::json!({
            "device_id": "dev-new",
            "generated_at": 1_700_000_000_i64,
            "sessions": [{
                "id": "s1",
                "title": null,
                "persona": "empathetic",
                "persona_prompt_snapshot": "p",
                "language": "auto",
                "created_at": 1_700_000_000_i64,
                "updated_at": 1_700_000_000_i64,
                "is_deleted": false,
                "pinned_at": 1_700_000_500_i64,
                "some_future_field": {"nested": [1, 2, 3]},
                "messages": []
            }],
            "another_future_key": "ignored",
        });
        let parsed: ChatPayload = serde_json::from_value(from_the_future).unwrap();
        assert_eq!(parsed.sessions.len(), 1, "chat history must not be dropped");
        assert_eq!(parsed.sessions[0].pinned_at, Some(1_700_000_500));
    }

    #[test]
    fn synced_chat_session_omits_none_pinned_at_from_wire() {
        // `skip_serializing_if = Option::is_none` is not cosmetic: the push
        // content hash is `serde_json::to_vec(&sessions)`, so emitting
        // `"pinned_at": null` for every unpinned session would change the
        // hash of every device's chats.bin and force a one-time full
        // re-upload across the fleet on upgrade. Unpinned must stay
        // byte-identical to the pre-pin wire shape.
        let s = SyncedChatSession {
            id: "s1".to_string(),
            title: None,
            persona: "empathetic".to_string(),
            persona_prompt_snapshot: "p".to_string(),
            language: "auto".to_string(),
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
            is_deleted: false,
            title_is_ai_generated: false,
            used_rag: false,
            converted_entry_id: None,
            converted_through_seq: None,
            pinned_at: None,
            messages: vec![],
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(
            !json.contains("pinned_at"),
            "wire must omit a None pinned_at, got: {json}"
        );

        // A pinned session round-trips the value verbatim (epoch SECONDS).
        let pinned = SyncedChatSession {
            pinned_at: Some(1_700_000_500),
            ..s
        };
        let json = serde_json::to_string(&pinned).unwrap();
        let back: SyncedChatSession = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pinned_at, Some(1_700_000_500));
        assert_eq!(back, pinned);
    }

    // ─── memory channel: MemoryPayload round-trip + memory_present default ──

    #[test]
    fn memory_payload_roundtrips_with_items_sources_and_embeddings() {
        // `vec` is opaque little-endian f32 bytes on the wire (mirrors
        // `EmbeddingChunkVector::vec`); for this serde-fidelity test the exact
        // f32 values don't matter, only that the bytes survive unchanged.
        let vec_bytes: Vec<u8> = vec![0u8, 0, 0x80, 0x3f, 0u8, 0, 0x00, 0x40]; // 1.0, 2.0 LE f32
        let payload = MemoryPayload {
            items: vec![
                SyncedMemoryItem {
                    id: "m1".to_string(),
                    text: "prefers dark mode".to_string(),
                    source_type: "journal_entry".to_string(),
                    enabled: true,
                    is_deleted: false,
                    created_at: 100,
                    updated_at: 150,
                    sources: vec![
                        MemorySourceRef {
                            source_type: "journal_entry".to_string(),
                            source_id: "e1".to_string(),
                        },
                        MemorySourceRef {
                            source_type: "daily_chat".to_string(),
                            source_id: "sess-7".to_string(),
                        },
                    ],
                    embeddings: vec![SyncedMemoryVec {
                        model_id: "ondevice::memory::bge-small".to_string(),
                        dim: 2,
                        vec: vec_bytes.clone(),
                        content_hash: "sha256:abc".to_string(),
                        indexed_at: 160,
                    }],
                },
                // Tombstone — rides the same channel so LWW can converge the
                // deletion on peers.
                SyncedMemoryItem {
                    id: "m2".to_string(),
                    text: String::new(),
                    source_type: "journal_entry".to_string(),
                    enabled: false,
                    is_deleted: true,
                    created_at: 100,
                    updated_at: 500,
                    sources: vec![],
                    embeddings: vec![],
                },
            ],
            persona: Some(SyncedPersona {
                answers_json: r#"{\"tone\":\"warm\"}"#.to_string(),
                traits_text: "thoughtful".to_string(),
                style_text: "concise".to_string(),
                enabled: true,
                user_edited: false,
                generated_at: Some(123),
                updated_at: 200,
            }),
        };

        let json = serde_json::to_string(&payload).unwrap();
        let back: MemoryPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back, payload);
        assert_eq!(back.items.len(), 2);
        assert_eq!(back.persona, payload.persona);
        assert_eq!(back.items[0].embeddings[0].vec, vec_bytes);
        assert!(back.items[1].is_deleted);
    }

    #[test]
    fn memory_payload_legacy_without_persona_defaults_to_none() {
        let legacy = serde_json::json!({ "items": [] });

        let parsed: MemoryPayload = serde_json::from_value(legacy).unwrap();

        assert_eq!(parsed.persona, None);
    }

    #[test]
    fn memory_payload_legacy_item_without_sources_or_embeddings_defaults_empty() {
        // `sources` and `embeddings` are `#[serde(default)]`, so a peer that
        // predates these fields (or an item that simply has none) deserializes
        // cleanly to empty vecs — a single outdated peer cannot break the pull.
        let legacy = serde_json::json!({
            "items": [{
                "id": "m1",
                "text": "t",
                "source_type": "journal_entry",
                "enabled": true,
                "is_deleted": false,
                "created_at": 1_i64,
                "updated_at": 1_i64
            }]
        });
        let parsed: MemoryPayload = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.items.len(), 1);
        assert!(parsed.items[0].sources.is_empty());
        assert!(parsed.items[0].embeddings.is_empty());
    }

    #[test]
    fn device_metadata_legacy_without_memory_present_defaults_false() {
        // Old-peer manifest written before the memory channel existed. It must
        // deserialize with memory_present = false so a peer that never
        // publishes memory.bin is treated as "no memory to pull" — the same
        // forward-compat contract chats_present established.
        let legacy = r#"{"device_id":"legacy","entries":[],"journals":[],
                         "chats_present":true,"generated_at":1}"#;
        let metadata: DeviceMetadata = serde_json::from_str(legacy).unwrap();
        assert!(metadata.chats_present);
        assert!(
            !metadata.memory_present,
            "missing memory_present must default to false"
        );
    }

    #[test]
    fn ai_reviews_payload_json_roundtrip() {
        let payload = AiReviewsPayload {
            device_id: "dev-a".to_string(),
            generated_at: 1_700_000_000,
            reviews: vec![SyncedAiReview {
                kind: "weekly".to_string(),
                period_start: 100,
                period_end: 200,
                model_id: "m".to_string(),
                result_json: "{}".to_string(),
                entry_count: 1,
                created_at: 10,
            }],
        };
        let json = serde_json::to_string(&payload).unwrap();
        let back: AiReviewsPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back, payload);
    }
}
