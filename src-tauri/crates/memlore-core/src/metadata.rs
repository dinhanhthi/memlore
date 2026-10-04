//! Sync metadata types: the per-device manifest written to
//! `{device_id}/metadata.json`, the diff routine that drives `to_pull` /
//! `to_delete_locally` decisions, and the device-bin payload structs.
//!
//! Moved verbatim from the desktop `sync/metadata.rs`; the serde attributes,
//! field order and names are a frozen sync format.

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
#[doc(hidden)]
pub fn sort_to_pull_newest_first(to_pull: &mut [String], remote: &DeviceMetadata) {
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
/// `crate::db::SYNCABLE_SETTING_KEYS` are serialized — credentials and
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

    // Vectors copied from the desktop `sync/metadata.rs` tests.

    #[test]
    fn legacy_device_metadata_defaults_channel_presence_to_false() {
        let json = r#"{"device_id":"legacy","entries":[],"journals":[],"generated_at":1}"#;
        let metadata: DeviceMetadata = serde_json::from_str(json).unwrap();
        assert!(!metadata.chats_present);
        assert!(!metadata.memory_present);
        assert_eq!(metadata.recovery_generation, 0);
    }

    #[test]
    fn device_metadata_json_roundtrip() {
        let m = DeviceMetadata {
            device_id: "dev-a".to_string(),
            recovery_generation: 3,
            entries: vec![SyncedEntrySummary {
                entry_id: "e1".to_string(),
                updated_at: 50,
                local_version: 1,
                is_deleted: false,
            }],
            journals: vec![],
            chats_present: true,
            memory_present: true,
            generated_at: 1_700_000_000,
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: DeviceMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn entry_metadata_parses_legacy_json_without_new_fields() {
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
        assert!(parsed.media.is_empty());
        assert!(parsed.deleted_media.is_empty());
        assert!(!parsed.is_locked);
        assert!(parsed.vault_id.is_none());
        let back: EntryMetadata =
            serde_json::from_str(&serde_json::to_string(&parsed).unwrap()).unwrap();
        assert_eq!(back, parsed);
    }

    #[test]
    fn diff_pulls_newest_first_and_tombstones() {
        let s = |id: &str, updated_at, is_deleted| SyncedEntrySummary {
            entry_id: id.to_string(),
            updated_at,
            local_version: 1,
            is_deleted,
        };
        let meta = |entries| DeviceMetadata {
            device_id: "d".to_string(),
            recovery_generation: 0,
            entries,
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 0,
        };
        let local = meta(vec![s("old", 10, false)]);
        let remote = meta(vec![s("a", 5, false), s("b", 9, false), s("old", 20, true)]);
        let d = compute_diff(&local, &remote);
        assert_eq!(d.to_pull, vec!["b".to_string(), "a".to_string()]);
        assert_eq!(d.to_delete_locally, vec![("old".to_string(), 20)]);
    }

    #[test]
    fn tags_payload_json_roundtrip() {
        let p = TagsPayload {
            device_id: "d".to_string(),
            generated_at: 1,
            tags: vec![SyncedTag {
                id: "t".to_string(),
                name: "n".to_string(),
                color: None,
                updated_at: 2,
                is_deleted: false,
            }],
        };
        let back: TagsPayload = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }
}
