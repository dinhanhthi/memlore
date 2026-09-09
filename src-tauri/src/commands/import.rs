//! E3 Import Backend
//!
//! Ingests a `.memlore.zip` archive (produced by [`commands::export`]) or a
//! folder of Markdown / plain-text files into the local SQLite database.
//!
//! Two modes are supported:
//!
//! - **MergeNewer** — imported entries are de-duplicated by
//!   `(entry_date, sha256(content_text))`; when a match exists locally, the
//!   row with the higher `updated_at` wins (last-writer-wins). Entries with
//!   no local match are inserted as new rows.
//! - **ReplaceAll** — all existing entries, tags, media, and entry-tag rows
//!   are deleted before the import runs. Journals are preserved and will be
//!   upserted from the archive's `journals.json` if present.
//!
//! The frontend wraps Replace-all in a "type DELETE to confirm" modal
//! (see `src/components/settings/data/ImportModal.tsx`); the backend does
//! not re-verify that gate — it trusts the caller.

use std::io::Read as _;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

use crate::db;
use crate::utils::time::now_unix;
use crate::{AppState, EncryptionKeyState};

/// Schema version we accept. Must match `export::SCHEMA_VERSION`.
/// v1 archives (pre-Phase-3) may contain per-field AES-GCM ciphertext in
/// title/preview_text/etc. — importing them into a Phase-3 DB would store
/// ciphertext as plaintext text, corrupting the journal. Reject v1 cleanly.
const SUPPORTED_SCHEMA_VERSION: u32 = 2;

/// Maximum bytes read from a single archive entry before aborting. Prevents
/// OOM on maliciously large JSON files embedded in a ZIP.
const MAX_ARCHIVE_ENTRY_BYTES: u64 = 64 * 1024 * 1024; // 64 MB

/// Progress event emitted on the Tauri event bus while `import_data` runs.
const IMPORT_PROGRESS_EVENT: &str = "import:progress";

// ─── Public enums ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportFormat {
    /// Lossless `.memlore.zip` produced by the Export backend.
    MemloreZip,
    /// A folder of `.md` files, each with optional `---` YAML frontmatter.
    MarkdownFolder,
    /// A folder of `.txt` files — body-only, no frontmatter.
    PlainTextFolder,
    /// Day One 2023+ JSON ZIP export.
    #[serde(rename = "dayone_zip")]
    DayOneZip,
    /// Journey v2 ZIP export (one JSON file per entry).
    JourneyZip,
    /// Local Apple Journal HTML folder export (`index.html` + `Entries/` + `Resources/`).
    AppleJournalFolder,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    /// Keep existing entries; skip duplicates; last-writer-wins on overlap.
    MergeNewer,
    /// Wipe entries/tags/media first, then import fresh.
    ReplaceAll,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: u64,
    pub skipped_duplicates: u64,
    pub errors: Vec<String>,
    /// Additive structured warnings. Empty for existing formats.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ImportWarning>,
    /// Apple Journal accounting. Absent for Day One / Journey / markdown / zip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apple: Option<AppleImportReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWarning {
    pub kind: String,
    pub message: String,
    /// Structured conversion feature when known (e.g. `font-color`, `asset-type:livephoto`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
}

impl ImportWarning {
    fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            feature: None,
        }
    }

    fn with_feature(
        kind: impl Into<String>,
        message: impl Into<String>,
        feature: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            feature: Some(feature.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppleImportReport {
    pub entries_imported: u64,
    pub entries_failed: u64,
    pub resources_referenced: u64,
    pub resources_imported: u64,
    pub resources_missing: u64,
    pub resources_unsupported: u64,
    pub resources_unreferenced: u64,
    /// Exact fingerprint matches skipped in this destination journal.
    #[serde(default)]
    pub entries_skipped_exact: u64,
    /// Same source identity, different fingerprint — new entry created.
    #[serde(default)]
    pub entries_source_changed: u64,
}

/// Additive Apple Journal options. Absent for existing import formats.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppleJournalImportOptions {
    #[serde(default)]
    pub conversion_timezone: Option<String>,
    #[serde(default)]
    pub expected_source_hash: Option<String>,
}

/// Reviewable Apple Journal preflight. Does not mutate the DB or live media dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleJournalImportPreview {
    pub source_hash: String,
    pub conversion_timezone: String,
    pub date_policy: String,
    pub date_precision: String,
    pub clock_is_synthetic: bool,
    pub entries: u64,
    pub resources_referenced: u64,
    pub resources_would_import: u64,
    pub resources_missing: u64,
    pub resources_unsupported: u64,
    pub resources_unreferenced: u64,
    pub warnings: Vec<ImportWarning>,
}

// ─── Progress ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct ImportProgress {
    percent: u8,
    phase: &'static str,
}

fn emit_progress(app: Option<&AppHandle>, percent: u8, phase: &'static str) {
    if let Some(app) = app {
        if let Err(e) = app.emit(IMPORT_PROGRESS_EVENT, ImportProgress { percent, phase }) {
            log::warn!("emit import:progress failed: {e}");
        }
    }
}

// ─── Wire structs (must round-trip with `export::ExportedEntry`) ─────────────

#[derive(Debug, Deserialize)]
struct ImportedManifest {
    schema_version: u32,
    #[allow(dead_code)]
    #[serde(default)]
    exported_at: String,
    #[allow(dead_code)]
    #[serde(default)]
    app_version: String,
}

#[derive(Debug, Deserialize)]
struct ImportedJournal {
    id: String,
    name: String,
    #[serde(default)]
    color: Option<String>,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    sort_order: i64,
}

#[derive(Debug, Deserialize)]
struct ImportedTag {
    #[allow(dead_code)]
    #[serde(default)]
    id: String,
    name: String,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ImportedEntry {
    id: String,
    journal_id: String,
    entry_date: i64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    content_text: Option<String>,
    #[serde(default)]
    yjs_doc_b64: Option<String>,
    #[serde(default)]
    preview_text: Option<String>,
    #[serde(default)]
    emotion: Option<String>,
    #[serde(default)]
    location_label: Option<String>,
    #[serde(default)]
    location_address: Option<String>,
    #[serde(default)]
    weather_summary: Option<String>,
    #[serde(default)]
    weather_icon: Option<String>,
    #[serde(default)]
    latitude: Option<f64>,
    #[serde(default)]
    longitude: Option<f64>,
    #[serde(default)]
    is_favorite: bool,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    media: Vec<ImportedMedia>,
}

#[derive(Debug, Deserialize)]
struct ImportedMedia {
    id: String,
    file_name: String,
    mime_type: String,
    #[serde(default)]
    size_bytes: Option<i64>,
    #[serde(default)]
    sha256: Option<String>,
}

// ─── Day One 2023+ format structs ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct DayOneExport {
    #[serde(default)]
    entries: Vec<DayOneEntry>,
}

#[derive(Debug, Deserialize)]
struct DayOneEntry {
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(rename = "creationDate", default)]
    creation_date: Option<String>,
    #[serde(rename = "modifiedDate", default)]
    modified_date: Option<String>,
    #[serde(rename = "isStarred", default)]
    is_starred: bool,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    location: Option<DayOneLocation>,
    #[serde(default)]
    weather: Option<DayOneWeather>,
    #[serde(default)]
    photos: Vec<DayOnePhoto>,
}

#[derive(Debug, Deserialize)]
struct DayOneLocation {
    #[serde(default)]
    latitude: Option<f64>,
    #[serde(default)]
    longitude: Option<f64>,
    #[serde(rename = "placeName", default)]
    place_name: Option<String>,
    #[serde(rename = "userLabel", default)]
    user_label: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DayOneWeather {
    #[serde(rename = "conditionsDescription", default)]
    conditions_description: Option<String>,
    #[serde(rename = "weatherCode", default)]
    weather_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DayOnePhoto {
    /// Moment id referenced from the entry body as `![](dayone-moment://ID)`.
    #[serde(default)]
    identifier: Option<String>,
    #[serde(default)]
    md5: Option<String>,
    #[serde(rename = "type", default)]
    photo_type: Option<String>,
}

// ─── Journey v2 format structs ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct JourneyEntry {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    date_journal: Option<i64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    lat: f64,
    #[serde(default)]
    lon: f64,
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    photos: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
}

struct JourneyPlannedPhoto {
    photo_filename: String,
    media_id: String,
    dest_file_name: String,
    mime: &'static str,
    mode: &'static str,
}

fn journey_photo_insertion_mode(
    photo_filename: &str,
    inline_names: &[String],
    distinguish_inline: bool,
) -> &'static str {
    if !distinguish_inline {
        return "attached";
    }
    let name = Path::new(photo_filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(photo_filename);
    if inline_names.iter().any(|inline| inline == name) {
        "inline"
    } else {
        "attached"
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Deterministic dedup key for an entry. Normalised `content_text` so that a
/// missing body and an empty body collide (both can never be user content).
fn content_hash(content_text: Option<&str>) -> String {
    let mut h = Sha256::new();
    h.update(content_text.unwrap_or("").as_bytes());
    hex::encode(h.finalize())
}

/// Returns `true` if `s` is safe to use as a zip entry path component. Mirrors
/// the guard in `commands::export::is_safe_zip_component`.
fn is_safe_component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains('\0')
        && !s.contains("..")
}

/// Local cache key/value: dedup key → (existing_id, existing_updated_at, is_deleted).
type DedupMap = std::collections::HashMap<(i64, String), (String, i64, bool)>;

fn build_dedup_map(conn: &rusqlite::Connection) -> Result<DedupMap, String> {
    // Include soft-deleted entries so a re-imported previously-deleted entry
    // resurrects the existing row (via LWW upsert) rather than creating a
    // ghost twin and leaving the soft-deleted original forever.
    let rows = db::list_all_entries_including_deleted(conn).map_err(|e| e.to_string())?;
    let mut map = DedupMap::new();
    for e in rows {
        let key = (e.entry_date, content_hash(e.content_text.as_deref()));
        map.insert(key, (e.id, e.updated_at, e.is_deleted));
    }
    Ok(map)
}

/// MergeNewer skips a live row whose `updated_at` is newer-or-equal. A
/// tombstone is never skipped — journal/entry delete bumps `updated_at` to
/// now, which would otherwise make every re-import report "skipped duplicates".
fn skip_merge_duplicate(
    existing_updated_at: i64,
    imported_updated_at: i64,
    is_deleted: bool,
) -> bool {
    !is_deleted && existing_updated_at >= imported_updated_at
}

// ─── Public entry point ──────────────────────────────────────────────────────

pub fn import_data_inner(
    app: Option<&AppHandle>,
    state: &AppState,
    key_state: &EncryptionKeyState,
    src: String,
    format: ImportFormat,
    mode: ImportMode,
    journal_id: Option<String>,
) -> Result<ImportSummary, String> {
    // Resolve db_key up front — needed to decrypt an automatic recovery
    // backup's full_snapshot.json.enc member (Fix 4). Must happen BEFORE the
    // with_key gate below: EncryptionKeyState's inner mutex is not
    // reentrant, so calling with_db_key from inside the with_key closure
    // (e.g. deep inside import_memlore_zip) would self-deadlock. `.ok()`
    // collapses "locked" / no-such-member into None, which
    // read_optional_encrypted_snapshot only needs when the encrypted member
    // is actually present.
    let backup_db_key = key_state.with_db_key(|k| Ok(*k)).ok();

    // Gate on unlock (key_state keeps the lock/unlock contract even though
    // Phase 3 removed per-field encryption — the key must be loaded to import).
    key_state.with_key(|_key| {
        emit_progress(app, 5, "reading");

        match format {
            ImportFormat::MemloreZip => {
                import_memlore_zip(app, state, backup_db_key.as_ref(), &src, mode)
            }
            ImportFormat::MarkdownFolder => import_text_folder(
                app,
                state,
                &src,
                mode,
                /* markdown */ true,
                journal_id.as_deref(),
            ),
            ImportFormat::PlainTextFolder => import_text_folder(
                app,
                state,
                &src,
                mode,
                /* markdown */ false,
                journal_id.as_deref(),
            ),
            ImportFormat::DayOneZip => {
                import_dayone_zip(app, state, &src, mode, journal_id.as_deref())
            }
            ImportFormat::JourneyZip => {
                import_journey_zip(app, state, &src, mode, journal_id.as_deref())
            }
            ImportFormat::AppleJournalFolder => {
                // TODO(later): accept AppleJournalEntries.zip without a prior
                // extract. See docs/LATER.md.
                import_apple_journal_folder(app, state, &src, mode, journal_id.as_deref(), None)
            }
        }
    })
}

pub fn import_data_inner_with_options(
    app: Option<&AppHandle>,
    state: &AppState,
    key_state: &EncryptionKeyState,
    src: String,
    format: ImportFormat,
    mode: ImportMode,
    journal_id: Option<String>,
    options: Option<AppleJournalImportOptions>,
) -> Result<ImportSummary, String> {
    if format != ImportFormat::AppleJournalFolder {
        return import_data_inner(app, state, key_state, src, format, mode, journal_id);
    }
    key_state.with_key(|_key| {
        emit_progress(app, 5, "reading");
        import_apple_journal_folder(
            app,
            state,
            &src,
            mode,
            journal_id.as_deref(),
            options.as_ref(),
        )
    })
}

// ─── Memlore ZIP importer ───────────────────────────────────────────────────

fn import_memlore_zip(
    app: Option<&AppHandle>,
    state: &AppState,
    backup_db_key: Option<&[u8; 32]>,
    src: &str,
    mode: ImportMode,
) -> Result<ImportSummary, String> {
    let file = std::fs::File::open(src).map_err(|e| format!("Failed to open import file: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid zip: {e}"))?;

    // ── Parse manifest first so we can fail fast on schema mismatch ──────
    let manifest: ImportedManifest = {
        let mut f = archive
            .by_name("manifest.json")
            .map_err(|_| "Archive is missing manifest.json".to_string())?;
        let mut buf = String::new();
        f.read_to_string(&mut buf)
            .map_err(|e| format!("Failed to read manifest.json: {e}"))?;
        serde_json::from_str(&buf).map_err(|e| format!("manifest.json is not valid JSON: {e}"))?
    };
    if manifest.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported schema_version {}: this build supports version {}",
            manifest.schema_version, SUPPORTED_SCHEMA_VERSION
        ));
    }

    if mode == ImportMode::ReplaceAll {
        if let Some(snapshot) = read_optional_json_by_name::<db::FullBackupSnapshot>(
            &mut archive,
            "full_snapshot.json",
        )? {
            return import_full_snapshot_zip(app, state, &mut archive, &snapshot);
        }
        // `full_snapshot.json.enc` — the automatic pre-recovery backup format
        // (`write_complete_memlore_backup` with a db_key; see
        // `sync::recovery`). AES-256-GCM encrypted with this device's
        // db_key; a manual export never writes this member. This is a
        // manual escape hatch — the user points Import at their retained
        // recovery backup after a botched recovery — so it must decrypt
        // with the currently unlocked vault's db_key.
        if let Some(snapshot) =
            read_optional_encrypted_snapshot(&mut archive, backup_db_key, "full_snapshot.json.enc")?
        {
            return import_full_snapshot_zip(app, state, &mut archive, &snapshot);
        }
    }

    // ── Parse journals.json + entries.jsonl (both required) ──────────────
    let journals: Vec<ImportedJournal> = read_json_by_name(&mut archive, "journals.json")?;
    let tags: Vec<ImportedTag> = read_json_by_name(&mut archive, "tags.json").unwrap_or_default();

    let entries: Vec<ImportedEntry> = {
        let mut f = archive
            .by_name("entries.jsonl")
            .map_err(|_| "Archive is missing entries.jsonl".to_string())?;
        let mut buf = String::new();
        f.read_to_string(&mut buf)
            .map_err(|e| format!("Failed to read entries.jsonl: {e}"))?;
        let mut out = Vec::new();
        for (idx, line) in buf.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let e: ImportedEntry = serde_json::from_str(line)
                .map_err(|err| format!("entries.jsonl line {} is invalid: {err}", idx + 1))?;
            out.push(e);
        }
        out
    };

    emit_progress(app, 20, "writing");

    // ── Resolve media dir (outside the zip) ──────────────────────────────
    // Media blobs are stored raw in the zip (never encrypted in the archive).
    // Copy them into the app's media storage directory next to the DB so the
    // existing media-resolve path picks them up.
    let media_root = resolve_media_root(state)?;

    // ── DB transaction ───────────────────────────────────────────────────
    let conn_guard = state.lock()?;
    let tx = conn_guard
        .unchecked_transaction()
        .map_err(|e| format!("begin transaction: {e}"))?;

    if mode == ImportMode::ReplaceAll {
        db::hard_wipe_user_data(&tx).map_err(|e| format!("wipe user data: {e}"))?;
    }

    // Upsert journals.
    for j in &journals {
        db::upsert_journal(
            &tx,
            &j.id,
            &j.name,
            j.color.as_deref(),
            j.created_at,
            j.updated_at,
            j.sort_order,
        )
        .map_err(|e| format!("upsert journal {}: {e}", j.id))?;
    }

    // Upsert tags by name so that the id we pick collides with any existing
    // local tag of the same name. (Tag ids are not referenced across the
    // archive — the entry carries tag *names* — so id drift is safe here.)
    let mut tag_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for tag in &tags {
        let id = upsert_tag_by_name(&tx, &tag.name, tag.color.as_deref())?;
        tag_ids.insert(tag.name.clone(), id);
    }

    // Dedup map for MergeNewer.
    let dedup = if mode == ImportMode::MergeNewer {
        build_dedup_map(&tx)?
    } else {
        DedupMap::new()
    };

    let default_journal_id = fallback_journal_id(&tx)?;

    let total = entries.len().max(1);
    let mut imported = 0u64;
    let mut skipped = 0u64;
    let mut errors: Vec<String> = Vec::new();

    for (idx, imported_entry) in entries.iter().enumerate() {
        // Choose an existing journal id — prefer the imported one if we
        // upserted it, otherwise fall back to the default AND record a
        // warning so the user can see the reassignment in the summary.
        let journal_id = if journals.iter().any(|j| j.id == imported_entry.journal_id) {
            imported_entry.journal_id.clone()
        } else {
            errors.push(format!(
                "entry {}: journal {} not in archive — placed in default journal",
                imported_entry.id, imported_entry.journal_id
            ));
            default_journal_id.clone()
        };

        // Dedup check (Merge mode only).
        let dedup_key = (
            imported_entry.entry_date,
            content_hash(imported_entry.content_text.as_deref()),
        );
        if mode == ImportMode::MergeNewer {
            if let Some((existing_id, existing_updated_at, is_deleted)) =
                dedup.get(&dedup_key).cloned()
            {
                if skip_merge_duplicate(existing_updated_at, imported_entry.updated_at, is_deleted)
                {
                    skipped += 1;
                    continue;
                }
                if let Err(e) = write_entry_row(
                    &tx,
                    &existing_id,
                    &journal_id,
                    imported_entry,
                    /* update */ true,
                ) {
                    errors.push(format!("update entry {}: {e}", imported_entry.id));
                } else {
                    imported += 1;
                }
                continue;
            }
        }

        // Fresh insert — use the imported id when free so that referencing
        // rows (media.entry_id) round-trip; otherwise generate a new uuid.
        let chosen_id = pick_insert_id(&tx, &imported_entry.id)?;
        if let Err(e) = write_entry_row(
            &tx,
            &chosen_id,
            &journal_id,
            imported_entry,
            /* update */ false,
        ) {
            errors.push(format!("insert entry {}: {e}", imported_entry.id));
            continue;
        }
        imported += 1;

        for tag_name in &imported_entry.tags {
            let tag_id = match tag_ids.get(tag_name) {
                Some(id) => id.clone(),
                None => {
                    let id = upsert_tag_by_name(&tx, tag_name, None)?;
                    tag_ids.insert(tag_name.clone(), id.clone());
                    id
                }
            };
            let _ = db::add_tag_to_entry(&tx, &chosen_id, &tag_id);
        }

        // Copy media blobs out of the archive. Blobs are plaintext inside
        // the export zip, so we do not re-encrypt — the app's media
        // pipeline stores plaintext media on disk already.
        for m in &imported_entry.media {
            if let Err(e) = copy_media_from_zip(&mut archive, &media_root, &tx, &chosen_id, m) {
                errors.push(format!(
                    "media {} for entry {}: {e}",
                    m.id, imported_entry.id
                ));
            }
        }

        if idx % 10 == 0 {
            let pct = 20 + (70 * (idx + 1) / total) as u8;
            emit_progress(app, pct.min(95), "writing");
        }
    }

    tx.commit().map_err(|e| format!("commit: {e}"))?;
    drop(conn_guard);

    emit_progress(app, 100, "done");

    Ok(ImportSummary {
        imported,
        skipped_duplicates: skipped,
        errors,
        ..ImportSummary::default()
    })
}

fn import_full_snapshot_zip(
    app: Option<&AppHandle>,
    state: &AppState,
    archive: &mut ZipArchive<std::fs::File>,
    snapshot: &db::FullBackupSnapshot,
) -> Result<ImportSummary, String> {
    emit_progress(app, 20, "writing");

    let media_root = resolve_media_root(state)?;
    let conn_guard = state.lock()?;
    let tx = conn_guard
        .unchecked_transaction()
        .map_err(|e| format!("begin transaction: {e}"))?;

    db::restore_full_snapshot(&tx, snapshot).map_err(|e| format!("restore snapshot: {e}"))?;

    let media_refs = db::list_backup_media_files(&tx).map_err(|e| format!("list media: {e}"))?;
    let mut errors = Vec::new();
    for m in &media_refs {
        if let Err(e) = copy_restored_media_from_zip(archive, &media_root, &tx, m) {
            errors.push(format!("media {}: {e}", m.id));
        }
    }

    let imported = db::list_all_entries(&tx)
        .map_err(|e| format!("count restored entries: {e}"))?
        .len() as u64;
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    drop(conn_guard);

    emit_progress(app, 100, "done");

    Ok(ImportSummary {
        imported,
        skipped_duplicates: 0,
        errors,
        ..ImportSummary::default()
    })
}

fn read_json_by_name<T: serde::de::DeserializeOwned>(
    archive: &mut ZipArchive<std::fs::File>,
    name: &str,
) -> Result<T, String> {
    let mut f = archive
        .by_name(name)
        .map_err(|_| format!("Archive is missing {name}"))?;
    let mut buf = String::new();
    f.read_to_string(&mut buf)
        .map_err(|e| format!("Failed to read {name}: {e}"))?;
    serde_json::from_str(&buf).map_err(|e| format!("{name} is not valid JSON: {e}"))
}

fn read_optional_json_by_name<T: serde::de::DeserializeOwned>(
    archive: &mut ZipArchive<std::fs::File>,
    name: &str,
) -> Result<Option<T>, String> {
    let mut f = match archive.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(format!("Failed to open {name}: {e}")),
    };
    let mut buf = String::new();
    f.read_to_string(&mut buf)
        .map_err(|e| format!("Failed to read {name}: {e}"))?;
    let value = serde_json::from_str(&buf).map_err(|e| format!("{name} is not valid JSON: {e}"))?;
    Ok(Some(value))
}

/// Like `read_optional_json_by_name`, but for a member written by
/// `write_complete_memlore_backup` with a db_key — raw AES-256-GCM
/// ciphertext (`utils::encryption::encrypt_data`'s output), not UTF-8 JSON.
/// Decryption happens entirely before any DB write is attempted by the
/// caller, so a wrong-key failure here never leaves a partial restore.
///
/// Takes an already-resolved `db_key` rather than `&EncryptionKeyState`: the
/// caller (`import_memlore_zip`, called from inside `EncryptionKeyState::
/// with_key`'s closure) cannot call `with_db_key` itself here — that mutex
/// is not reentrant and doing so would self-deadlock.
fn read_optional_encrypted_snapshot(
    archive: &mut ZipArchive<std::fs::File>,
    db_key: Option<&[u8; 32]>,
    name: &str,
) -> Result<Option<db::FullBackupSnapshot>, String> {
    let mut f = match archive.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(format!("Failed to open {name}: {e}")),
    };
    let mut ciphertext = Vec::new();
    f.read_to_end(&mut ciphertext)
        .map_err(|e| format!("Failed to read {name}: {e}"))?;
    drop(f);

    let db_key = db_key.ok_or_else(|| format!("db_key unavailable to decrypt {name}"))?;
    let plaintext = crate::utils::encryption::decrypt_data(db_key, &ciphertext).map_err(|_| {
        format!("{name} could not be decrypted — this backup was encrypted with a different key")
    })?;
    let value = serde_json::from_slice(&plaintext)
        .map_err(|e| format!("{name} did not contain valid snapshot JSON after decryption: {e}"))?;
    Ok(Some(value))
}

fn fallback_journal_id(conn: &rusqlite::Connection) -> Result<String, String> {
    let js = db::list_journals(conn, None).map_err(|e| e.to_string())?;
    js.into_iter()
        .next()
        .map(|j| j.id)
        .ok_or_else(|| "No journals exist — import has nowhere to write".to_string())
}

/// When `requested` is `Some`, the journal must exist and be a visible import
/// target (not soft-deleted, not invisible). `None` uses the first journal by
/// sort order (existing fallback — already filtered the same way).
fn resolve_import_journal_id(
    conn: &rusqlite::Connection,
    requested: Option<&str>,
) -> Result<String, String> {
    match requested {
        None => fallback_journal_id(conn),
        Some(id) => {
            let journal = db::get_journal(conn, id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("Journal not found: {id}"))?;
            if journal.is_deleted || journal.is_invisible {
                return Err(format!("Journal not found: {id}"));
            }
            Ok(journal.id)
        }
    }
}

/// Encode paragraphs as a TipTap `XmlFragment("default")` Yjs blob (STANDARD b64).
fn encode_import_yjs(
    paragraphs: &[String],
    inline_media: &[(&str, &str)],
) -> Result<(Option<String>, String, String), String> {
    let refs: Vec<&str> = paragraphs.iter().map(String::as_str).collect();
    let (bytes, content_text, preview_text) = crate::yjs_doc::build_entry_yjs(&refs, inline_media);
    if bytes.len() > crate::commands::entries::MAX_YJS_DOC_BYTES {
        return Err(format!(
            "Yjs document exceeds {} bytes",
            crate::commands::entries::MAX_YJS_DOC_BYTES
        ));
    }
    Ok((Some(B64.encode(bytes)), content_text, preview_text))
}

/// Markdown body → Yjs blob. Day One and `.md` files store Markdown, so the
/// syntax must become real nodes instead of literal text.
fn encode_import_markdown(
    markdown: &str,
    media_by_moment: &std::collections::HashMap<String, String>,
) -> Result<(Option<String>, String, String), String> {
    let (bytes, content_text, preview_text) =
        crate::import_markdown::build_entry_yjs_from_markdown(markdown, |dest| {
            resolve_import_image(dest, media_by_moment)
        });
    if bytes.len() > crate::commands::entries::MAX_YJS_DOC_BYTES {
        return Err(format!(
            "Yjs document exceeds {} bytes",
            crate::commands::entries::MAX_YJS_DOC_BYTES
        ));
    }
    Ok((Some(B64.encode(bytes)), content_text, preview_text))
}

/// Map a Markdown image destination onto imported media.
///
/// `dayone-moment://ID` resolves through the entry's own photos. Everything
/// else is dropped on purpose: a remote URL kept as an `<img src>` would make
/// the editor fetch a third party the moment the entry opens — an
/// import-authored tracking pixel in an app that must work fully offline.
///
/// TODO(later): the `/video/`, `/audio/` and `/pdfAttachment/` moment variants
/// resolve to nothing and are dropped — see `docs/LATER.md`.
fn resolve_import_image(
    dest: &str,
    media_by_moment: &std::collections::HashMap<String, String>,
) -> Option<String> {
    let rest = dest.strip_prefix("dayone-moment:")?;
    let identifier = rest.trim_start_matches('/').rsplit('/').next()?;
    media_by_moment
        .get(&identifier.to_ascii_uppercase())
        .cloned()
}

/// Stable media id for a Day One photo so a re-import keeps the inline
/// `data-media-id` references pointing at the rows the first import created.
///
/// Scoped to the entry: media is read by id alone, so an id derived only from
/// the import file's own fields would let a crafted export attach itself to an
/// existing media row.
fn dayone_media_id(entry_uuid: &str, photo: &DayOnePhoto) -> String {
    let key = format!(
        "dayone:{}:{}:{}",
        entry_uuid,
        photo.identifier.as_deref().unwrap_or(""),
        photo.md5.as_deref().unwrap_or("")
    );
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, key.as_bytes()).to_string()
}

/// Copy an entry's Day One photos into the media root + `media` table.
///
/// Runs on every write path (insert, same-id overwrite, merge update) so a
/// rebuilt body never points at a `data-media-id` that was never created.
/// Ids are deterministic, so a row that already exists is left alone.
fn copy_dayone_photos(
    archive: &mut ZipArchive<std::fs::File>,
    media_root: &Path,
    conn: &rusqlite::Connection,
    entry_id: &str,
    photos: &[(&DayOnePhoto, String)],
    errors: &mut Vec<String>,
) {
    for (photo, media_id) in photos {
        let Some(md5) = photo.md5.as_deref() else {
            continue;
        };
        if db::media_exists(conn, media_id).unwrap_or(false) {
            continue;
        }
        let ext = photo.photo_type.as_deref().unwrap_or("jpeg");
        let file_name = format!("{}.{}", media_id, ext);
        let zip_path = format!("photos/{}.{}", md5, ext);
        let mime = match ext {
            "png" => "image/png",
            "heic" | "heif" => "image/heic",
            "gif" => "image/gif",
            _ => "image/jpeg",
        };
        if let Err(e) = copy_blob_from_zip(
            archive, media_root, conn, entry_id, media_id, &zip_path, &file_name, mime, "inline",
        ) {
            errors.push(format!("photo {md5} for entry {entry_id}: {e}"));
        }
    }
}

/// Same-id re-import: heal rows that were stored without a Yjs blob (the
/// pre-fix Journey/Day One path), otherwise last-writer-wins on `updated_at`.
fn same_id_import_action(
    conn: &rusqlite::Connection,
    imported: &ImportedEntry,
    mode: ImportMode,
) -> Result<Option<SameIdAction>, String> {
    let existing = match db::get_entry(conn, &imported.id).map_err(|e| e.to_string())? {
        Some(row) => row,
        None => return Ok(None),
    };
    let yjs_missing = db::get_entry_content(conn, &existing.id)
        .map_err(|e| e.to_string())?
        .map(|b| b.is_empty())
        .unwrap_or(true);
    if existing.is_locked || existing.is_invisible {
        return Ok(Some(SameIdAction::Skip));
    }
    if existing.is_deleted || yjs_missing {
        return Ok(Some(SameIdAction::Overwrite));
    }
    if mode == ImportMode::MergeNewer && existing.updated_at >= imported.updated_at {
        return Ok(Some(SameIdAction::Skip));
    }
    Ok(Some(SameIdAction::Overwrite))
}

enum SameIdAction {
    Skip,
    Overwrite,
}

fn pick_insert_id(conn: &rusqlite::Connection, preferred: &str) -> Result<String, String> {
    if !preferred.is_empty() && preferred.len() <= 64 {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE id = ?1",
                [preferred],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Ok(preferred.to_string());
        }
    }
    Ok(uuid::Uuid::new_v4().to_string())
}

fn upsert_tag_by_name(
    conn: &rusqlite::Connection,
    name: &str,
    color: Option<&str>,
) -> Result<String, String> {
    db::upsert_tag_by_name(conn, name, color).map_err(|e| format!("upsert tag {name}: {e}"))
}

fn resolve_media_root(state: &AppState) -> Result<PathBuf, String> {
    // The existing media pipeline stores files under `<app_data>/media/`.
    // We don't have direct access to Tauri's path API here in the test
    // environment, so we fall back to a temp dir when the DB is in-memory
    // (unit tests) and only attempt a real path in production.
    let conn = state.lock()?;
    let raw = db::get_setting(&conn, "media_root_path").map_err(|e| e.to_string())?;
    drop(conn);
    if let Some(p) = raw {
        let path = PathBuf::from(p);
        let _ = std::fs::create_dir_all(&path);
        return Ok(path);
    }
    // Fallback: a temp dir. Import will still succeed — media rows will
    // point into the temp dir, which works for tests but is not ideal in
    // prod. The frontend only calls this command from a real Tauri
    // context where `media_root_path` is set at startup, so this branch is
    // primarily test territory.
    let temp = std::env::temp_dir().join("memlore-import-media");
    let _ = std::fs::create_dir_all(&temp);
    Ok(temp)
}

/// Upsert an imported entry via `db::upsert_entry_from_sync`. `update_existing`
/// is retained as a parameter for call-site clarity but the underlying helper
/// is already an idempotent `INSERT … ON CONFLICT DO UPDATE`, so both branches
/// resolve through the same code path.
///
/// Phase 3: all fields are stored as plaintext — no encryption applied.
fn write_entry_row(
    conn: &rusqlite::Connection,
    id: &str,
    journal_id: &str,
    e: &ImportedEntry,
    update_existing: bool,
) -> Result<(), String> {
    let _ = update_existing; // behaviour is upsert regardless

    let yjs_doc = match e.yjs_doc_b64.as_deref() {
        None => None,
        Some(s) => Some(
            B64.decode(s)
                .map_err(|e| format!("decode yjs_doc_b64: {e}"))?,
        ),
    };

    db::upsert_entry_from_sync(
        conn,
        db::SyncEntryRow {
            id,
            journal_id,
            title: e.title.as_deref(),
            preview_text: e.preview_text.as_deref(),
            content_text: e.content_text.as_deref(),
            entry_date: e.entry_date,
            created_at: e.created_at,
            updated_at: e.updated_at,
            latitude: e.latitude,
            longitude: e.longitude,
            location_label: e.location_label.as_deref(),
            location_address: e.location_address.as_deref(),
            weather_summary: e.weather_summary.as_deref(),
            weather_icon: e.weather_icon.as_deref(),
            emotion: e.emotion.as_deref(),
            is_favorite: e.is_favorite,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            vault_id: None,
            yjs_doc: yjs_doc.as_deref(),
            // Import format predates these fields — leave at defaults so
            // the round-trip is lossless against what the export wrote.
            cover_media_id: None,
            entry_date_user_edited: false,
            content_language: None,
        },
    )
    .map_err(|e| format!("upsert entry: {e}"))
}

fn copy_media_from_zip(
    archive: &mut ZipArchive<std::fs::File>,
    media_root: &Path,
    conn: &rusqlite::Connection,
    entry_id: &str,
    m: &ImportedMedia,
) -> Result<(), String> {
    // Determine the zip path used by export: `media/<id>.<ext>`.
    let ext = Path::new(&m.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_string();
    if !is_safe_component(&m.id) || !is_safe_component(&ext) {
        return Err(format!(
            "unsafe media id or extension: {:?}/{:?}",
            m.id, ext
        ));
    }
    let zip_path = format!("media/{}.{}", m.id, ext);
    let mut zf = match archive.by_name(&zip_path) {
        Ok(f) => f,
        Err(_) => {
            // Media blob missing from archive — skip without failing the
            // whole import (matches the export side, which also tolerates
            // missing blobs).
            log::warn!("import: media {zip_path} absent from archive");
            return Ok(());
        }
    };
    // Copy to `<media_root>/<id>.<ext>`.
    let dest = media_root.join(format!("{}.{ext}", m.id));
    // Belt-and-braces: the filename parts are already `is_safe_component`
    // validated, so `dest` cannot escape `media_root`. Re-check anyway so a
    // future refactor that drops the input validation fails loudly.
    if !dest.starts_with(media_root) {
        return Err(format!(
            "media path {} would escape media root {}",
            dest.display(),
            media_root.display()
        ));
    }
    let mut out = std::fs::File::create(&dest)
        .map_err(|e| format!("create media {}: {e}", dest.display()))?;
    std::io::copy(&mut zf, &mut out).map_err(|e| format!("copy media {}: {e}", dest.display()))?;

    // Optionally verify sha256 before we persist the row.
    if let Some(expected) = &m.sha256 {
        let bytes =
            std::fs::read(&dest).map_err(|e| format!("read media {}: {e}", dest.display()))?;
        let actual = {
            let mut h = Sha256::new();
            h.update(&bytes);
            hex::encode(h.finalize())
        };
        if &actual != expected {
            log::warn!(
                "import: media {} sha256 mismatch (expected {}, got {}) — keeping file anyway",
                m.id,
                expected,
                actual
            );
        }
    }

    db::insert_imported_media(
        conn,
        &m.id,
        entry_id,
        &m.file_name,
        &m.mime_type,
        &dest.to_string_lossy(),
        m.size_bytes,
        "inline",
    )
    .map_err(|e| format!("insert media row: {e}"))?;
    Ok(())
}

fn copy_restored_media_from_zip(
    archive: &mut ZipArchive<std::fs::File>,
    media_root: &Path,
    conn: &rusqlite::Connection,
    m: &db::BackupMediaFile,
) -> Result<(), String> {
    let ext = Path::new(&m.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_string();
    if !is_safe_component(&m.id) || !is_safe_component(&ext) {
        return Err(format!(
            "unsafe media id or extension: {:?}/{:?}",
            m.id, ext
        ));
    }

    let zip_path = format!("media/{}.{}", m.id, ext);
    let dest = media_root.join(format!("{}.{ext}", m.id));
    if !dest.starts_with(media_root) {
        return Err(format!(
            "media path {} would escape media root {}",
            dest.display(),
            media_root.display()
        ));
    }
    let mut zf = match archive.by_name(&zip_path) {
        Ok(f) => f,
        Err(_) => {
            db::set_restored_media_storage_path(conn, &m.id, dest.to_string_lossy().as_ref())
                .map_err(|e| format!("update missing media storage path: {e}"))?;
            return Err(format!("{zip_path} absent from archive"));
        }
    };
    let mut out = std::fs::File::create(&dest)
        .map_err(|e| format!("create media {}: {e}", dest.display()))?;
    std::io::copy(&mut zf, &mut out).map_err(|e| format!("copy media {}: {e}", dest.display()))?;
    db::set_restored_media_storage_path(conn, &m.id, dest.to_string_lossy().as_ref())
        .map_err(|e| format!("update media storage path: {e}"))?;
    Ok(())
}

/// Hard ceiling on a single decompressed media blob from a third-party zip
/// export. Not a policy cap (the configured photo/video upload limits stay
/// advisory for imports — an over-limit file is still imported locally); this
/// only stops a crafted export from expanding into gigabytes of RAM now that
/// `copy_blob_from_zip` must buffer the whole blob to compress it.
const MAX_IMPORT_BLOB_BYTES: u64 = 512 * 1024 * 1024;

/// Generic blob-copy helper shared by Day One and Journey importers.
/// Reads `zip_path` from `archive`, runs the bytes through the user's
/// configured image compression (same settings as a normal editor insert),
/// writes to `<media_root>/{media_id}.{ext}`, and inserts a media row.
/// Returns `Ok(())` silently if the path is absent (the blob was missing
/// from the export — we skip rather than abort).
///
/// Compression is opportunistic (`compress_image`, never the aborting
/// `compress_to_fit`): imports keep the original when it cannot be shrunk
/// rather than dropping the file. A PNG re-encoded to JPEG changes both the
/// stored extension and MIME, so both are re-derived from the outcome —
/// inline references use `media_id`, which never changes.
fn copy_blob_from_zip(
    archive: &mut ZipArchive<std::fs::File>,
    media_root: &Path,
    conn: &rusqlite::Connection,
    entry_id: &str,
    media_id: &str,
    zip_path: &str,
    file_name: &str,
    mime_type: &str,
    insertion_mode: &str,
) -> Result<(), String> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    if !is_safe_component(media_id) || !is_safe_component(ext) || !is_safe_component(file_name) {
        return Err(format!(
            "unsafe media id or file name: {media_id}/{file_name}"
        ));
    }

    // Compression needs the whole blob in memory, so the previous streaming
    // `io::copy` is gone — which makes an untrusted zip's declared size a
    // memory-exhaustion lever (deflate reaches ~1000:1). Reject on the declared
    // size AND bound the actual read, because the central-directory size field
    // can be spoofed.
    let mut bytes = Vec::new();
    {
        let mut zf = match archive.by_name(zip_path) {
            Ok(f) => f,
            Err(_) => {
                log::warn!("import: blob {zip_path} absent from archive — skipping");
                return Ok(());
            }
        };
        if zf.size() > MAX_IMPORT_BLOB_BYTES {
            log::warn!(
                "import: blob {zip_path} declares {} bytes (cap {MAX_IMPORT_BLOB_BYTES}) — skipping",
                zf.size()
            );
            return Ok(());
        }
        let mut limited = std::io::Read::take(&mut zf, MAX_IMPORT_BLOB_BYTES.saturating_add(1));
        std::io::Read::read_to_end(&mut limited, &mut bytes)
            .map_err(|e| format!("read blob {zip_path}: {e}"))?;
        if bytes.len() as u64 > MAX_IMPORT_BLOB_BYTES {
            log::warn!(
                "import: blob {zip_path} expands past the {MAX_IMPORT_BLOB_BYTES} byte cap — skipping"
            );
            return Ok(());
        }
    }

    let (bytes, mime_type, ext) = crate::utils::image_compression::compress_image(
        &bytes,
        mime_type,
        ext,
        crate::commands::media::resolve_compression_mode(conn),
    );
    // Re-encoding can change the extension (PNG → JPEG); re-validate the name
    // we are actually about to write.
    let file_name = format!("{media_id}.{ext}");
    if !is_safe_component(&ext) || !is_safe_component(&file_name) {
        return Err(format!(
            "unsafe media id or file name: {media_id}/{file_name}"
        ));
    }

    let dest = media_root.join(&file_name);
    if !dest.starts_with(media_root) {
        return Err(format!(
            "media path {} would escape media root {}",
            dest.display(),
            media_root.display()
        ));
    }

    std::fs::write(&dest, &bytes).map_err(|e| format!("write media {}: {e}", dest.display()))?;

    let size = std::fs::metadata(&dest).map(|m| m.len() as i64).ok();

    db::insert_imported_media(
        conn,
        media_id,
        entry_id,
        &file_name,
        &mime_type,
        &dest.to_string_lossy(),
        size,
        insertion_mode,
    )
    .map_err(|e| format!("insert media row: {e}"))
}

// ─── Markdown / Plain-text folder importer ───────────────────────────────────

fn import_text_folder(
    app: Option<&AppHandle>,
    state: &AppState,
    src: &str,
    mode: ImportMode,
    is_markdown: bool,
    journal_id: Option<&str>,
) -> Result<ImportSummary, String> {
    let dir = PathBuf::from(src);
    if !dir.is_dir() {
        return Err(format!("{src} is not a directory"));
    }
    let ext_filter: &[&str] = if is_markdown {
        &["md", "markdown"]
    } else {
        &["txt"]
    };

    // Collect candidate files.
    let mut paths: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("read_dir {src}: {e}"))? {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ok = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| ext_filter.iter().any(|want| want.eq_ignore_ascii_case(e)))
            .unwrap_or(false);
        if ok {
            paths.push(p);
        }
    }
    paths.sort();

    emit_progress(app, 20, "writing");

    let conn_guard = state.lock()?;
    let tx = conn_guard
        .unchecked_transaction()
        .map_err(|e| format!("begin transaction: {e}"))?;

    if mode == ImportMode::ReplaceAll {
        db::hard_wipe_user_data(&tx).map_err(|e| format!("wipe user data: {e}"))?;
    }

    let dedup = if mode == ImportMode::MergeNewer {
        build_dedup_map(&tx)?
    } else {
        DedupMap::new()
    };
    let default_journal = resolve_import_journal_id(&tx, journal_id)?;

    let total = paths.len().max(1);
    let mut imported = 0u64;
    let mut skipped = 0u64;
    let mut errors: Vec<String> = Vec::new();

    for (idx, path) in paths.iter().enumerate() {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                errors.push(format!("read {}: {e}", path.display()));
                continue;
            }
        };

        let (front, body) = if is_markdown {
            split_frontmatter(&raw)
        } else {
            (None, raw.as_str())
        };

        let filename = path.file_stem().and_then(|s| s.to_str()).unwrap_or("entry");
        let entry_date = front
            .as_ref()
            .and_then(|f| f.date)
            .or_else(|| parse_date_from_filename(filename))
            .or_else(|| file_mtime_seconds(path))
            .unwrap_or_else(|| now_unix());
        let tags: Vec<String> = front.as_ref().map(|f| f.tags.clone()).unwrap_or_default();
        // Frontmatter title wins; otherwise a leading `# heading` becomes the
        // title (and leaves the body). Plain-text files are never Markdown.
        let front_title = front.as_ref().and_then(|f| f.title.clone());
        let (title, body_md) = match front_title {
            Some(t) => (Some(t), body.trim()),
            None if is_markdown => crate::import_markdown::split_leading_heading(body.trim()),
            None => (None, body.trim()),
        };
        let encoded = if is_markdown {
            encode_import_markdown(body_md, &std::collections::HashMap::new())
        } else {
            encode_import_yjs(&crate::import_html::paragraphs_from_plain(body_md), &[])
        };
        let (yjs_doc_b64, content, preview_text) = match encoded {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("{}: {e}", path.display()));
                continue;
            }
        };

        let now = now_unix();
        let imported_entry = ImportedEntry {
            id: uuid::Uuid::new_v4().to_string(),
            journal_id: default_journal.clone(),
            entry_date,
            title,
            content_text: Some(content.clone()),
            yjs_doc_b64,
            preview_text: Some(preview_text),
            emotion: None,
            location_label: None,
            location_address: None,
            weather_summary: None,
            weather_icon: None,
            latitude: None,
            longitude: None,
            is_favorite: false,
            created_at: now,
            updated_at: now,
            tags: tags.clone(),
            media: Vec::new(),
        };

        let key_dedup = (entry_date, content_hash(Some(&content)));
        if mode == ImportMode::MergeNewer {
            if let Some((existing_id, existing_updated_at, is_deleted)) = dedup.get(&key_dedup) {
                if skip_merge_duplicate(
                    *existing_updated_at,
                    imported_entry.updated_at,
                    *is_deleted,
                ) {
                    skipped += 1;
                    continue;
                }
                if let Err(e) = write_entry_row(
                    &tx,
                    existing_id,
                    &default_journal,
                    &imported_entry,
                    /* update */ true,
                ) {
                    errors.push(format!("update {}: {e}", path.display()));
                } else {
                    imported += 1;
                }
                continue;
            }
        }

        let chosen_id = imported_entry.id.clone();
        if let Err(e) = write_entry_row(&tx, &chosen_id, &default_journal, &imported_entry, false) {
            errors.push(format!("insert {}: {e}", path.display()));
            continue;
        }
        imported += 1;

        for tag_name in &tags {
            let tag_id = upsert_tag_by_name(&tx, tag_name, None)?;
            let _ = db::add_tag_to_entry(&tx, &chosen_id, &tag_id);
        }

        if idx % 10 == 0 {
            let pct = 20 + (70 * (idx + 1) / total) as u8;
            emit_progress(app, pct.min(95), "writing");
        }
    }

    tx.commit().map_err(|e| format!("commit: {e}"))?;
    drop(conn_guard);
    emit_progress(app, 100, "done");

    Ok(ImportSummary {
        imported,
        skipped_duplicates: skipped,
        errors,
        ..ImportSummary::default()
    })
}

// ─── Day One importer ─────────────────────────────────────────────────────────

fn import_dayone_zip(
    app: Option<&AppHandle>,
    state: &AppState,
    src: &str,
    mode: ImportMode,
    journal_id: Option<&str>,
) -> Result<ImportSummary, String> {
    let file = std::fs::File::open(src).map_err(|e| format!("Failed to open import file: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid zip: {e}"))?;

    // Version detection: Journal.json must exist. Day One v1 used plist format.
    let export: DayOneExport = {
        let f = archive.by_name("Journal.json").map_err(|_| {
            "Unsupported Day One export version: only JSON exports (2020+) are supported. \
             Please re-export from Day One using JSON format."
                .to_string()
        })?;
        let mut buf = String::new();
        f.take(MAX_ARCHIVE_ENTRY_BYTES + 1)
            .read_to_string(&mut buf)
            .map_err(|e| format!("Failed to read Journal.json: {e}"))?;
        if buf.len() as u64 > MAX_ARCHIVE_ENTRY_BYTES {
            return Err(
                "Journal.json exceeds 64 MB — this does not look like a standard Day One export."
                    .to_string(),
            );
        }
        serde_json::from_str(&buf).map_err(|e| format!("Journal.json is not valid JSON: {e}"))?
    };

    emit_progress(app, 20, "writing");

    let media_root = resolve_media_root(state)?;
    let conn_guard = state.lock()?;
    let tx = conn_guard
        .unchecked_transaction()
        .map_err(|e| format!("begin transaction: {e}"))?;

    if mode == ImportMode::ReplaceAll {
        db::hard_wipe_user_data(&tx).map_err(|e| format!("wipe user data: {e}"))?;
    }

    let dedup = if mode == ImportMode::MergeNewer {
        build_dedup_map(&tx)?
    } else {
        DedupMap::new()
    };

    let default_journal = resolve_import_journal_id(&tx, journal_id)?;
    let mut tag_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let total = export.entries.len().max(1);
    let mut imported = 0u64;
    let mut skipped = 0u64;
    let mut errors: Vec<String> = Vec::new();
    let now = now_unix();

    for (idx, entry) in export.entries.iter().enumerate() {
        let entry_date = entry
            .creation_date
            .as_deref()
            .and_then(parse_iso_date)
            .unwrap_or(now);
        let updated_at = entry
            .modified_date
            .as_deref()
            .and_then(parse_iso_date)
            .unwrap_or(entry_date);
        // Photo ids are needed before the body is built: `![](dayone-moment://ID)`
        // becomes an inline media node pointing at the row copied further down.
        let entry_uuid = entry.uuid.clone().unwrap_or_default();
        let photo_media: Vec<(&DayOnePhoto, String)> = entry
            .photos
            .iter()
            .map(|photo| (photo, dayone_media_id(&entry_uuid, photo)))
            .collect();
        let media_by_moment: std::collections::HashMap<String, String> = photo_media
            .iter()
            .filter(|(photo, _)| photo.md5.is_some())
            .filter_map(|(photo, media_id)| {
                photo
                    .identifier
                    .as_ref()
                    .map(|id| (id.to_ascii_uppercase(), media_id.clone()))
            })
            .collect();

        // Day One has no title field — a leading `# heading` is the title.
        let (entry_title, body_md) =
            crate::import_markdown::split_leading_heading(entry.text.as_deref().unwrap_or(""));
        let (yjs_doc_b64, content, preview_text) =
            match encode_import_markdown(body_md, &media_by_moment) {
                Ok(v) => v,
                Err(e) => {
                    errors.push(format!(
                        "yjs {}: {e}",
                        entry.uuid.as_deref().unwrap_or("entry")
                    ));
                    continue;
                }
            };

        let imported_entry = ImportedEntry {
            id: entry
                .uuid
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            journal_id: default_journal.clone(),
            entry_date,
            title: entry_title,
            content_text: Some(content),
            yjs_doc_b64,
            preview_text: Some(preview_text),
            emotion: None,
            location_label: entry
                .location
                .as_ref()
                .and_then(|l| l.place_name.clone().or_else(|| l.user_label.clone())),
            location_address: None,
            weather_summary: entry
                .weather
                .as_ref()
                .and_then(|w| w.conditions_description.clone()),
            weather_icon: entry.weather.as_ref().and_then(|w| w.weather_code.clone()),
            latitude: entry.location.as_ref().and_then(|l| l.latitude),
            longitude: entry.location.as_ref().and_then(|l| l.longitude),
            is_favorite: entry.is_starred,
            created_at: entry_date,
            updated_at,
            tags: entry.tags.clone(),
            media: Vec::new(),
        };

        match same_id_import_action(&tx, &imported_entry, mode)? {
            Some(SameIdAction::Skip) => {
                skipped += 1;
                continue;
            }
            Some(SameIdAction::Overwrite) => {
                if let Err(e) = write_entry_row(
                    &tx,
                    &imported_entry.id,
                    &default_journal,
                    &imported_entry,
                    true,
                ) {
                    errors.push(format!("update entry {}: {e}", imported_entry.id));
                } else {
                    copy_dayone_photos(
                        &mut archive,
                        &media_root,
                        &tx,
                        &imported_entry.id,
                        &photo_media,
                        &mut errors,
                    );
                    imported += 1;
                }
                continue;
            }
            None => {}
        }

        let dedup_key = (
            entry_date,
            content_hash(imported_entry.content_text.as_deref()),
        );
        // Photo-only entries have no text at all, so an empty body says nothing
        // about whether two same-day entries are the same entry — the Day One
        // uuid check above is the only duplicate signal left.
        let has_content = !imported_entry
            .content_text
            .as_deref()
            .unwrap_or("")
            .is_empty();
        if mode == ImportMode::MergeNewer && has_content {
            if let Some((existing_id, existing_updated_at, is_deleted)) =
                dedup.get(&dedup_key).cloned()
            {
                if skip_merge_duplicate(existing_updated_at, imported_entry.updated_at, is_deleted)
                {
                    skipped += 1;
                    continue;
                }
                if let Err(e) =
                    write_entry_row(&tx, &existing_id, &default_journal, &imported_entry, true)
                {
                    errors.push(format!("update entry {}: {e}", imported_entry.id));
                } else {
                    copy_dayone_photos(
                        &mut archive,
                        &media_root,
                        &tx,
                        &existing_id,
                        &photo_media,
                        &mut errors,
                    );
                    imported += 1;
                }
                continue;
            }
        }

        let chosen_id = pick_insert_id(&tx, &imported_entry.id)?;
        if let Err(e) = write_entry_row(&tx, &chosen_id, &default_journal, &imported_entry, false) {
            errors.push(format!("insert entry {}: {e}", imported_entry.id));
            continue;
        }
        imported += 1;

        for tag_name in &entry.tags {
            let tag_id = match tag_ids.get(tag_name) {
                Some(id) => id.clone(),
                None => match upsert_tag_by_name(&tx, tag_name, None) {
                    Ok(id) => {
                        tag_ids.insert(tag_name.clone(), id.clone());
                        id
                    }
                    Err(e) => {
                        errors.push(format!("tag '{tag_name}': {e}"));
                        continue;
                    }
                },
            };
            let _ = db::add_tag_to_entry(&tx, &chosen_id, &tag_id);
        }

        copy_dayone_photos(
            &mut archive,
            &media_root,
            &tx,
            &chosen_id,
            &photo_media,
            &mut errors,
        );

        if idx % 10 == 0 {
            let pct = 20 + (70 * (idx + 1) / total) as u8;
            emit_progress(app, pct.min(95), "writing");
        }
    }

    tx.commit().map_err(|e| format!("commit: {e}"))?;
    drop(conn_guard);
    emit_progress(app, 100, "done");

    Ok(ImportSummary {
        imported,
        skipped_duplicates: skipped,
        errors,
        ..ImportSummary::default()
    })
}

// ─── Journey importer ─────────────────────────────────────────────────────────

fn import_journey_zip(
    app: Option<&AppHandle>,
    state: &AppState,
    src: &str,
    mode: ImportMode,
    journal_id: Option<&str>,
) -> Result<ImportSummary, String> {
    let file = std::fs::File::open(src).map_err(|e| format!("Failed to open import file: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid zip: {e}"))?;

    // Collect all JSON entry file names (one per entry in Journey v2 format).
    let json_names: Vec<String> = {
        let mut names = Vec::new();
        for i in 0..archive.len() {
            if let Ok(f) = archive.by_index(i) {
                let name = f.name().to_string();
                if name.ends_with(".json") && !name.starts_with("__") && !name.contains("/.") {
                    names.push(name);
                }
            }
        }
        names
    };

    if json_names.is_empty() {
        return Ok(ImportSummary {
            imported: 0,
            skipped_duplicates: 0,
            errors: vec!["No JSON entry files found in Journey ZIP".to_string()],
            ..ImportSummary::default()
        });
    }

    emit_progress(app, 20, "writing");

    let media_root = resolve_media_root(state)?;
    let conn_guard = state.lock()?;
    let tx = conn_guard
        .unchecked_transaction()
        .map_err(|e| format!("begin transaction: {e}"))?;

    if mode == ImportMode::ReplaceAll {
        db::hard_wipe_user_data(&tx).map_err(|e| format!("wipe user data: {e}"))?;
    }

    let dedup = if mode == ImportMode::MergeNewer {
        build_dedup_map(&tx)?
    } else {
        DedupMap::new()
    };

    let default_journal = resolve_import_journal_id(&tx, journal_id)?;
    let mut tag_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let total = json_names.len().max(1);
    let mut imported = 0u64;
    let mut skipped = 0u64;
    let mut errors: Vec<String> = Vec::new();
    let now = now_unix();

    for (idx, json_name) in json_names.iter().enumerate() {
        let entry: JourneyEntry = {
            let f = match archive.by_name(json_name) {
                Ok(f) => f,
                Err(e) => {
                    errors.push(format!("open {json_name}: {e}"));
                    continue;
                }
            };
            let mut buf = String::new();
            if let Err(e) = f.take(MAX_ARCHIVE_ENTRY_BYTES + 1).read_to_string(&mut buf) {
                errors.push(format!("read {json_name}: {e}"));
                continue;
            }
            if buf.len() as u64 > MAX_ARCHIVE_ENTRY_BYTES {
                errors.push(format!("{json_name} exceeds 64 MB size limit — skipping"));
                continue;
            }
            match serde_json::from_str::<JourneyEntry>(&buf) {
                Ok(e) => e,
                Err(e) => {
                    errors.push(format!("parse {json_name}: {e}"));
                    continue;
                }
            }
        };

        // Skip auxiliary JSON files (e.g. metadata.json) that parse successfully
        // but contain no recognisable entry data. All three sentinel fields being
        // absent means this is not a Journey journal entry.
        if entry.date_journal.is_none() && entry.text.is_none() && entry.id.is_none() {
            continue;
        }

        let entry_date = entry.date_journal.map(|ms| ms / 1000).unwrap_or(now);
        let parsed = crate::import_html::parse_journey_text(
            entry.text.as_deref().unwrap_or(""),
            entry.title.as_deref(),
        );
        let inline_names =
            crate::import_html::journey_inline_media_filenames(entry.text.as_deref().unwrap_or(""));
        let distinguish_inline = !inline_names.is_empty();
        let planned_photos: Vec<JourneyPlannedPhoto> = entry
            .photos
            .iter()
            .map(|photo_filename| {
                let media_id = uuid::Uuid::new_v4().to_string();
                let ext = Path::new(photo_filename)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("jpg")
                    .to_string();
                let dest_file_name = format!("{}.{}", media_id, ext);
                let mime = match ext.to_lowercase().as_str() {
                    "png" => "image/png",
                    "gif" => "image/gif",
                    "heic" | "heif" => "image/heic",
                    _ => "image/jpeg",
                };
                let mode =
                    journey_photo_insertion_mode(photo_filename, &inline_names, distinguish_inline);
                JourneyPlannedPhoto {
                    photo_filename: photo_filename.clone(),
                    media_id,
                    dest_file_name,
                    mime,
                    mode,
                }
            })
            .collect();
        let inline_media: Vec<(&str, &str)> = planned_photos
            .iter()
            .filter(|photo| photo.mode == "inline")
            .map(|photo| (photo.media_id.as_str(), "image"))
            .collect();
        let (yjs_doc_b64, content, preview_text) =
            match encode_import_yjs(&parsed.paragraphs, &inline_media) {
                Ok(v) => v,
                Err(e) => {
                    errors.push(format!("{json_name}: {e}"));
                    continue;
                }
            };

        // Journey uses lat=0.0, lon=0.0 as sentinel for "no location".
        let (lat, lon) = if entry.lat == 0.0 && entry.lon == 0.0 {
            (None, None)
        } else {
            (Some(entry.lat), Some(entry.lon))
        };

        let imported_entry = ImportedEntry {
            id: entry
                .id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            journal_id: default_journal.clone(),
            entry_date,
            title: parsed.title,
            content_text: Some(content),
            yjs_doc_b64,
            // Journey's `mood` field is a 1-5 numeric scale we no longer
            // model — drop it. The user can re-tag in the new 3-state UI.
            preview_text: Some(preview_text),
            emotion: None,
            location_label: None,
            location_address: entry.address.clone(),
            weather_summary: None,
            weather_icon: None,
            latitude: lat,
            longitude: lon,
            is_favorite: false,
            created_at: entry_date,
            updated_at: entry_date,
            tags: entry.tags.clone(),
            media: Vec::new(),
        };

        match same_id_import_action(&tx, &imported_entry, mode)? {
            Some(SameIdAction::Skip) => {
                skipped += 1;
                continue;
            }
            Some(SameIdAction::Overwrite) => {
                if let Err(e) = write_entry_row(
                    &tx,
                    &imported_entry.id,
                    &default_journal,
                    &imported_entry,
                    true,
                ) {
                    errors.push(format!("update entry {}: {e}", imported_entry.id));
                } else {
                    imported += 1;
                }
                continue;
            }
            None => {}
        }

        let dedup_key = (
            entry_date,
            content_hash(imported_entry.content_text.as_deref()),
        );
        if mode == ImportMode::MergeNewer {
            if let Some((existing_id, existing_updated_at, is_deleted)) =
                dedup.get(&dedup_key).cloned()
            {
                if skip_merge_duplicate(existing_updated_at, imported_entry.updated_at, is_deleted)
                {
                    skipped += 1;
                    continue;
                }
                if let Err(e) =
                    write_entry_row(&tx, &existing_id, &default_journal, &imported_entry, true)
                {
                    errors.push(format!("update entry {}: {e}", imported_entry.id));
                } else {
                    imported += 1;
                }
                continue;
            }
        }

        let chosen_id = pick_insert_id(&tx, &imported_entry.id)?;
        if let Err(e) = write_entry_row(&tx, &chosen_id, &default_journal, &imported_entry, false) {
            errors.push(format!("insert entry {}: {e}", imported_entry.id));
            continue;
        }
        imported += 1;

        for tag_name in &entry.tags {
            let tag_id = match tag_ids.get(tag_name) {
                Some(id) => id.clone(),
                None => match upsert_tag_by_name(&tx, tag_name, None) {
                    Ok(id) => {
                        tag_ids.insert(tag_name.clone(), id.clone());
                        id
                    }
                    Err(e) => {
                        errors.push(format!("tag '{tag_name}': {e}"));
                        continue;
                    }
                },
            };
            let _ = db::add_tag_to_entry(&tx, &chosen_id, &tag_id);
        }

        for photo in &planned_photos {
            // Try "photos/<filename>" first, then the filename at the root.
            let photos_zip_path = format!("photos/{}", photo.photo_filename);
            let zip_path = if archive.by_name(&photos_zip_path).is_ok() {
                photos_zip_path
            } else {
                photo.photo_filename.clone()
            };
            if let Err(e) = copy_blob_from_zip(
                &mut archive,
                &media_root,
                &tx,
                &chosen_id,
                &photo.media_id,
                &zip_path,
                &photo.dest_file_name,
                photo.mime,
                photo.mode,
            ) {
                errors.push(format!(
                    "photo {} for entry {}: {e}",
                    photo.photo_filename, imported_entry.id
                ));
            }
        }

        if idx % 10 == 0 {
            let pct = 20 + (70 * (idx + 1) / total) as u8;
            emit_progress(app, pct.min(95), "writing");
        }
    }

    tx.commit().map_err(|e| format!("commit: {e}"))?;
    drop(conn_guard);
    emit_progress(app, 100, "done");

    Ok(ImportSummary {
        imported,
        skipped_duplicates: skipped,
        errors,
        ..ImportSummary::default()
    })
}

// ─── Frontmatter + filename date parsers ─────────────────────────────────────

#[derive(Debug, Default)]
struct Frontmatter {
    title: Option<String>,
    date: Option<i64>,
    tags: Vec<String>,
}

/// Parse a leading `---\n<body>\n---\n` YAML frontmatter block. The parser
/// only understands the three fields we care about (`title`, `date`, `tags`)
/// and ignores everything else, which is enough for hand-authored journals
/// and exports from tools like Bear / Obsidian.
fn split_frontmatter(src: &str) -> (Option<Frontmatter>, &str) {
    // Must start with `---` on its own line.
    let rest = match src
        .strip_prefix("---\n")
        .or_else(|| src.strip_prefix("---\r\n"))
    {
        Some(r) => r,
        None => return (None, src),
    };
    // Find the closing `---`.
    let end_marker = rest.find("\n---").map(|i| i + 1);
    let end = match end_marker {
        Some(e) => e,
        None => return (None, src),
    };
    let yaml = &rest[..end - 1]; // up to the '\n' before the closing ---
                                 // Body starts after the closing `---` line.
    let after_end = &rest[end + 3..]; // skip "---"
    let body = after_end
        .strip_prefix("\n")
        .or_else(|| after_end.strip_prefix("\r\n"))
        .unwrap_or(after_end);

    let mut fm = Frontmatter::default();
    for line in yaml.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let (raw_key, raw_value) = match line.split_once(':') {
            Some(p) => p,
            None => continue,
        };
        let key = raw_key.trim().to_ascii_lowercase();
        let value = raw_value.trim().trim_matches(|c| c == '"' || c == '\'');
        match key.as_str() {
            "title" => fm.title = Some(value.to_string()),
            "date" => fm.date = parse_iso_date(value),
            "tags" => fm.tags = parse_tag_list(value),
            _ => {}
        }
    }
    (Some(fm), body)
}

/// Parse a YAML inline list `[a, b, c]` or `a, b, c` into a Vec of tag names.
fn parse_tag_list(s: &str) -> Vec<String> {
    let inner = s.trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|p| p.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Accepts `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`. Returns Unix seconds UTC.
///
/// Takes a `&str` from attacker-controlled YAML frontmatter, so the parser
/// bails on any non-ASCII input before byte-indexing — a raw `s[0..4]` on a
/// multi-byte codepoint at one of the fixed offsets would panic with
/// "byte index N is not a char boundary" and abort the whole import.
fn parse_iso_date(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 10 || !s.is_ascii() {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    if s.as_bytes().get(4) != Some(&b'-') {
        return None;
    }
    let m: u32 = s[5..7].parse().ok()?;
    if s.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    let d: u32 = s[8..10].parse().ok()?;

    // Optional `THH:MM:SS`.
    let (hh, mm, ss) = if s.len() >= 19 && s.as_bytes().get(10) == Some(&b'T') {
        (
            s[11..13].parse::<u32>().ok()?,
            s[14..16].parse::<u32>().ok()?,
            s[17..19].parse::<u32>().ok()?,
        )
    } else {
        (0, 0, 0)
    };

    ymd_hms_to_unix_utc(y, m, d, hh, mm, ss)
}

fn parse_date_from_filename(name: &str) -> Option<i64> {
    // Match a leading YYYY-MM-DD anywhere in the name.
    if name.len() < 10 {
        return None;
    }
    let head = &name[..10];
    parse_iso_date(head)
}

fn file_mtime_seconds(path: &Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    let secs = mtime.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(secs)
}

/// Gregorian → Unix seconds. UTC, proleptic. Mirrors the algorithm used by
/// `commands::export::format_iso8601_utc` so round-trips are consistent.
fn ymd_hms_to_unix_utc(y: i64, m: u32, d: u32, hh: u32, mm: u32, ss: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // howardhinnant.github.io/date_algorithms.html#days_from_civil
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = m as i64;
    let d = d as i64;
    let doy: i64 = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = (yoe as i64) * 365 + (yoe as i64) / 4 - (yoe as i64) / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + (hh as i64) * 3600 + (mm as i64) * 60 + ss as i64)
}

// ─── Tauri command ───────────────────────────────────────────────────────────

/// **Why `async fn` + `spawn_blocking`?** Tauri 2 runs non-async commands on
/// the main thread. Folder/ZIP import (and Apple Journal staging) can take
/// seconds and would freeze the WebView IPC loop — progress events never
/// paint and the window stops responding. Same pattern as `sync_now` /
/// `uninstall_preview`.
#[tauri::command]
pub async fn import_data(
    app: AppHandle,
    src: String,
    format: ImportFormat,
    mode: ImportMode,
    journal_id: Option<String>,
    options: Option<AppleJournalImportOptions>,
) -> Result<ImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let key_state = app.state::<EncryptionKeyState>();
        import_data_inner_with_options(
            Some(&app),
            &state,
            &key_state,
            src,
            format,
            mode,
            journal_id,
            options,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// **Why `async fn` + `spawn_blocking`?** Preview walks the export and builds
/// Yjs on the same sync path as import. A sync command freezes the window
/// for the whole scan.
#[tauri::command]
pub async fn preview_apple_journal_import(
    app: AppHandle,
    src: String,
    options: Option<AppleJournalImportOptions>,
) -> Result<AppleJournalImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let key_state = app.state::<EncryptionKeyState>();
        preview_apple_journal_import_inner(Some(&app), &state, &key_state, src, options)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn preview_apple_journal_import_inner(
    app: Option<&AppHandle>,
    state: &AppState,
    key_state: &EncryptionKeyState,
    src: String,
    options: Option<AppleJournalImportOptions>,
) -> Result<AppleJournalImportPreview, String> {
    key_state.with_key(|_key| preview_apple_journal_folder(app, state, &src, options.as_ref()))
}

/// Write a user-chosen Apple Journal import report.
///
/// Security boundary: canonicalize dest and refuse when it is inside the
/// export source folder or the live media root. JS prefix checks are UX only.
#[tauri::command]
pub fn write_apple_journal_import_report(
    state: State<'_, AppState>,
    source: String,
    dest: String,
    text: String,
) -> Result<(), String> {
    let media_root = resolve_media_root(&state).ok();
    write_apple_journal_import_report_inner(&source, &dest, text.as_bytes(), media_root.as_deref())
}

pub(crate) fn write_apple_journal_import_report_inner(
    source: &str,
    dest: &str,
    text: &[u8],
    media_root: Option<&Path>,
) -> Result<(), String> {
    let dest_trimmed = dest.trim();
    if dest_trimmed.is_empty() {
        return Err("Report path is empty".to_string());
    }
    let source_trimmed = source.trim();
    if source_trimmed.is_empty() {
        return Err("Source path is empty".to_string());
    }

    let dest_path = Path::new(dest_trimmed);
    let source_path = Path::new(source_trimmed);
    if dest_is_inside_dir(dest_path, source_path)? {
        return Err("Report destination is inside the source folder".to_string());
    }
    if let Some(media) = media_root {
        if dest_is_inside_dir(dest_path, media)? {
            return Err("Report destination is inside the media root".to_string());
        }
    }

    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
        }
    }
    if dest_is_inside_dir(dest_path, source_path)? {
        return Err("Report destination is inside the source folder".to_string());
    }
    if let Some(media) = media_root {
        if dest_is_inside_dir(dest_path, media)? {
            return Err("Report destination is inside the media root".to_string());
        }
    }
    let dest_c = canonicalize_report_dest(dest_path)?;
    std::fs::write(&dest_c, text)
        .map_err(|e| format!("Failed to write {}: {e}", dest_c.display()))?;
    Ok(())
}

fn dest_is_inside_dir(dest: &Path, dir: &Path) -> Result<bool, String> {
    let dir_c = dir
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize {}: {e}", dir.display()))?;
    let dest_c = canonicalize_report_dest(dest)?;
    Ok(dest_c == dir_c || dest_c.starts_with(&dir_c))
}

fn canonicalize_report_dest(dest: &Path) -> Result<PathBuf, String> {
    if dest.exists() {
        return dest
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize {}: {e}", dest.display()));
    }
    let abs = if dest.is_absolute() {
        dest.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("cannot resolve current directory: {e}"))?
            .join(dest)
    };
    let mut rest = Vec::new();
    let mut cursor = abs.clone();
    while !cursor.as_os_str().is_empty() && !cursor.exists() {
        match cursor.file_name() {
            Some(name) => {
                rest.push(name.to_os_string());
                cursor.pop();
            }
            None => break,
        }
    }
    if cursor.exists() {
        let mut canon = cursor
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize {}: {e}", cursor.display()))?;
        for name in rest.into_iter().rev() {
            canon.push(name);
        }
        return Ok(canon);
    }
    Ok(normalize_lexical_path(&abs))
}

fn normalize_lexical_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

// ─── Apple Journal original staging (Phase 2 Task 1) ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppleStagingWarningKind {
    NoThumbnail,
    UnsupportedDecode,
    UnknownReferencedAttachment,
    CaptureDateDisagreement,
    ExceedsPhotoUploadLimit,
    ExceedsVideoUploadLimit,
}

impl AppleStagingWarningKind {
    pub(crate) fn as_import_kind(self) -> &'static str {
        match self {
            Self::NoThumbnail => "no_thumbnail",
            Self::UnsupportedDecode => "unsupported_decode",
            Self::UnknownReferencedAttachment => "unknown_referenced_attachment",
            Self::CaptureDateDisagreement => "capture_date_disagreement",
            Self::ExceedsPhotoUploadLimit => "exceeds_photo_upload_limit",
            Self::ExceedsVideoUploadLimit => "exceeds_video_upload_limit",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppleStagingWarning {
    pub kind: AppleStagingWarningKind,
    pub media_id: Option<String>,
    pub source_stem: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppleCaptureDateProvenance {
    Sidecar,
    Exif,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppleStagedInsertionMode {
    Attached,
}

impl AppleStagedInsertionMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Attached => "attached",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AppleStagedMedia {
    pub media_id: String,
    pub entry_relative_path: PathBuf,
    /// Original export stem. Persist uses `source_file_name`; tests assert this.
    #[allow(dead_code)]
    pub source_stem: String,
    pub source_file_name: String,
    pub mime: String,
    pub sha256: String,
    pub byte_len: u64,
    pub sort_order: i64,
    pub insertion_mode: AppleStagedInsertionMode,
    pub storage_path: PathBuf,
    pub thumbnail_path: Option<PathBuf>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_seconds: Option<f64>,
    pub capture_unix: Option<i64>,
    /// How `capture_unix` was chosen. Persist stores the timestamp only.
    #[allow(dead_code)]
    pub capture_provenance: AppleCaptureDateProvenance,
    pub exif_latitude: Option<f64>,
    pub exif_longitude: Option<f64>,
    /// Over-cap files are still imported; these flags are asserted in tests.
    #[allow(dead_code)]
    pub exceeds_photo_upload_limit: bool,
    #[allow(dead_code)]
    pub exceeds_video_upload_limit: bool,
    pub warnings: Vec<AppleStagingWarning>,
}

#[derive(Debug, Clone)]
pub(crate) struct AppleStagedResources {
    pub media: Vec<AppleStagedMedia>,
    pub warnings: Vec<AppleStagingWarning>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AppleStagingLimits {
    pub photo_upload_bytes: Option<i64>,
    pub video_upload_bytes: Option<i64>,
    /// The user's configured image-compression preset, applied to staged
    /// photos exactly as a normal editor insert applies it.
    pub compression: crate::utils::image_compression::CompressionMode,
}

impl Default for AppleStagingLimits {
    /// No caps, no compression — the shape unit tests want when they assert
    /// on original bytes.
    fn default() -> Self {
        Self {
            photo_upload_bytes: None,
            video_upload_bytes: None,
            compression: crate::utils::image_compression::CompressionMode::Off,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum AppleStagingError {
    Io { message: String },
}

impl std::fmt::Display for AppleStagingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { message } => write!(f, "{message}"),
        }
    }
}

/// Stream original Apple Journal resource bytes into `media_root`, then apply
/// the user's configured image compression to photos (after the source hash is
/// verified, so integrity is still checked against the original bytes). Never
/// truncates to the upload cap — an over-cap file is imported locally and
/// warned about. Unreferenced non-system files
/// are counted and retained in the source archive; they are not staged or
/// assigned to an entry. On any write/hash failure, only this attempt's
/// files are removed.
pub(crate) fn stage_apple_resources(
    scan: &crate::import_apple_journal::AppleJournalFolder,
    media_root: &Path,
    limits: AppleStagingLimits,
) -> Result<AppleStagedResources, AppleStagingError> {
    std::fs::create_dir_all(media_root).map_err(|e| AppleStagingError::Io {
        message: format!("create media root {}: {e}", media_root.display()),
    })?;

    let mut owned = Vec::new();
    let mut media = Vec::new();
    match stage_apple_resources_inner(scan, media_root, limits, &mut owned, &mut media) {
        Ok(warnings) => Ok(AppleStagedResources { media, warnings }),
        Err(err) => {
            cleanup_owned_staged_files(&owned);
            Err(err)
        }
    }
}

fn stage_apple_resources_inner(
    scan: &crate::import_apple_journal::AppleJournalFolder,
    media_root: &Path,
    limits: AppleStagingLimits,
    owned: &mut Vec<PathBuf>,
    media: &mut Vec<AppleStagedMedia>,
) -> Result<Vec<AppleStagingWarning>, AppleStagingError> {
    let mut warnings = Vec::new();
    for entry in &scan.entries {
        let mut sort_order = 0i64;
        for media_ref in &entry.media_refs {
            let Some(source_path) = media_ref.media_path.as_ref() else {
                continue;
            };
            let resource = scan
                .resources
                .iter()
                .find(|resource| resource.media_path == *source_path);
            let item = stage_one_apple_resource(
                entry.relative_path.clone(),
                media_ref.stem.clone(),
                source_path,
                media_ref.sidecar_path.as_deref(),
                resource,
                sort_order,
                &scan.root,
                media_root,
                limits,
                owned,
            )?;
            warnings.extend(item.warnings.iter().cloned());
            media.push(item);
            sort_order += 1;
        }
    }
    Ok(warnings)
}

#[allow(clippy::too_many_arguments)]
fn stage_one_apple_resource(
    entry_relative_path: PathBuf,
    source_stem: String,
    source_path: &Path,
    sidecar_path: Option<&Path>,
    resource: Option<&crate::import_apple_journal::AppleJournalResource>,
    sort_order: i64,
    export_root: &Path,
    media_root: &Path,
    limits: AppleStagingLimits,
    owned: &mut Vec<PathBuf>,
) -> Result<AppleStagedMedia, AppleStagingError> {
    crate::import_apple_journal::assert_regular_file_for_read(source_path).map_err(|e| {
        AppleStagingError::Io {
            message: format!("source {}: {e}", source_path.display()),
        }
    })?;
    reject_post_scan_source_swap(export_root, source_path)?;

    let source_file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let ext = apple_media_extension(&source_file_name);
    let mime = crate::commands::media::mime_from_ext(&ext).to_string();
    let media_id = uuid::Uuid::new_v4().to_string();
    if !is_safe_component(&media_id) || !is_safe_component(&ext) {
        return Err(AppleStagingError::Io {
            message: format!("unsafe staged media id or extension: {media_id}/{ext}"),
        });
    }

    let dest = media_root.join(format!("{media_id}.{ext}"));
    if !dest.starts_with(media_root) {
        return Err(AppleStagingError::Io {
            message: format!(
                "media path {} would escape media root {}",
                dest.display(),
                media_root.display()
            ),
        });
    }

    let (byte_len, sha256) = stream_copy_original(export_root, source_path, &dest)?;
    owned.push(dest.clone());
    if let Some(resource) = resource {
        if sha256 != resource.sha256 || byte_len != resource.byte_len {
            return Err(AppleStagingError::Io {
                message: format!(
                    "hash mismatch for {}: expected {} ({} bytes), got {sha256} ({byte_len} bytes)",
                    source_path.display(),
                    resource.sha256,
                    resource.byte_len
                ),
            });
        }
    }

    // Apply the user's configured image compression — the same preset a normal
    // editor insert uses. Deliberately AFTER the source-hash verification
    // above, so integrity is still checked against the original bytes:
    // `sha256` stays the source-provenance hash, while `mime` / `dest` /
    // `byte_len` describe what actually landed on disk. Videos are handled
    // separately by the background compression queue after the import commits.
    let mut mime = mime;
    let mut dest = dest;
    let mut byte_len = byte_len;
    if let Some(recompressed) = recompress_staged_image(&dest, &mime, &ext, limits.compression) {
        // The rewrite may have changed the extension (PNG → JPEG), so the path
        // recorded as owned must follow it or cleanup would miss the new file
        // and warn about the deleted one.
        if let Some(slot) = owned.iter_mut().find(|path| **path == dest) {
            *slot = recompressed.path.clone();
        }
        dest = recompressed.path;
        mime = recompressed.mime;
        byte_len = recompressed.byte_len;
    }

    let mut item_warnings = Vec::new();
    let insertion_mode = AppleStagedInsertionMode::Attached;
    if !(mime.starts_with("image/") || mime.starts_with("video/") || mime.starts_with("audio/")) {
        item_warnings.push(apple_staging_warning(
            AppleStagingWarningKind::UnknownReferencedAttachment,
            &media_id,
            &source_stem,
            format!(
                "referenced file '{source_file_name}' has no native editor type; kept as an attachment"
            ),
        ));
    }

    let exif = if mime.starts_with("image/") {
        crate::utils::exif::extract_exif(&dest).ok()
    } else {
        None
    };

    let sidecar_meta = sidecar_path.and_then(|path| {
        read_apple_sidecar_json(export_root, path)
            .ok()
            .and_then(|json| {
                let embedded = exif.as_ref().and_then(|data| {
                    data.date
                        .map(|unix| crate::import_apple_journal::AppleEmbeddedCapture {
                            unix_seconds: unix as f64,
                        })
                });
                crate::import_apple_journal::parse_apple_resource_metadata(&json, embedded).ok()
            })
    });

    if let Some(meta) = sidecar_meta.as_ref() {
        for warning in &meta.warnings {
            if warning.kind
                == crate::import_apple_journal::AppleResourceWarningKind::CaptureDateDisagreement
            {
                item_warnings.push(apple_staging_warning(
                    AppleStagingWarningKind::CaptureDateDisagreement,
                    &media_id,
                    &source_stem,
                    warning.message.clone(),
                ));
            }
        }
    }

    let (capture_unix, capture_provenance) =
        if let Some(unix) = sidecar_meta.as_ref().and_then(|meta| meta.date_unix) {
            (
                Some(unix.round() as i64),
                AppleCaptureDateProvenance::Sidecar,
            )
        } else if let Some(date) = exif.as_ref().and_then(|data| data.date) {
            (Some(date), AppleCaptureDateProvenance::Exif)
        } else {
            (None, AppleCaptureDateProvenance::None)
        };

    let (width, height) = apple_image_dimensions(&dest, &mime, exif.as_ref());
    let (thumbnail_path, thumb_warning) =
        apple_maybe_thumbnail(media_root, &media_id, &mime, &dest, owned);
    if let Some(warning) = thumb_warning {
        item_warnings.push(apple_staging_warning(
            warning,
            &media_id,
            &source_stem,
            match warning {
                AppleStagingWarningKind::NoThumbnail => {
                    format!("no thumbnail generated for {mime}; original bytes were kept")
                }
                AppleStagingWarningKind::UnsupportedDecode => {
                    format!("could not decode {mime} for a thumbnail; original bytes were kept")
                }
                _ => String::from("thumbnail warning"),
            },
        ));
    }

    let exceeds_photo_upload_limit = mime.starts_with("image/")
        && limits
            .photo_upload_bytes
            .is_some_and(|cap| cap >= 0 && byte_len > cap as u64);
    let exceeds_video_upload_limit = mime.starts_with("video/")
        && limits
            .video_upload_bytes
            .is_some_and(|cap| cap >= 0 && byte_len > cap as u64);
    if exceeds_photo_upload_limit {
        item_warnings.push(apple_staging_warning(
            AppleStagingWarningKind::ExceedsPhotoUploadLimit,
            &media_id,
            &source_stem,
            format!(
                "stored file is {byte_len} bytes after compression, above the configured photo upload cap; imported locally with upload still pending"
            ),
        ));
    }
    if exceeds_video_upload_limit {
        item_warnings.push(apple_staging_warning(
            AppleStagingWarningKind::ExceedsVideoUploadLimit,
            &media_id,
            &source_stem,
            format!(
                "stored file is {byte_len} bytes, above the configured video upload cap; imported locally with upload still pending"
            ),
        ));
    }

    Ok(AppleStagedMedia {
        media_id,
        entry_relative_path,
        source_stem,
        source_file_name,
        mime,
        sha256,
        byte_len,
        sort_order,
        insertion_mode,
        storage_path: dest,
        thumbnail_path,
        width,
        height,
        duration_seconds: None,
        capture_unix,
        capture_provenance,
        exif_latitude: exif.as_ref().and_then(|data| data.latitude),
        exif_longitude: exif.as_ref().and_then(|data| data.longitude),
        exceeds_photo_upload_limit,
        exceeds_video_upload_limit,
        warnings: item_warnings,
    })
}

fn apple_staging_warning(
    kind: AppleStagingWarningKind,
    media_id: &str,
    source_stem: &str,
    message: impl Into<String>,
) -> AppleStagingWarning {
    AppleStagingWarning {
        kind,
        media_id: Some(media_id.to_string()),
        source_stem: Some(source_stem.to_string()),
        message: message.into(),
    }
}

fn apple_media_extension(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 16 && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or_else(|| String::from("bin"))
}

fn reject_post_scan_source_swap(export_root: &Path, src: &Path) -> Result<(), AppleStagingError> {
    if crate::import_apple_journal::is_leaf_symlink(src) {
        return Err(AppleStagingError::Io {
            message: format!("leaf symlink rejected at stage time: {}", src.display()),
        });
    }
    if crate::import_apple_journal::path_escapes_export_root(export_root, src) {
        return Err(AppleStagingError::Io {
            message: format!(
                "source escapes the export root at stage time: {}",
                src.display()
            ),
        });
    }
    Ok(())
}

fn open_export_source_for_copy(
    export_root: &Path,
    src: &Path,
) -> Result<std::fs::File, AppleStagingError> {
    reject_post_scan_source_swap(export_root, src)?;
    let file = open_source_nofollow(src)?;
    let fd_meta = file.metadata().map_err(|e| AppleStagingError::Io {
        message: format!("fstat {}: {e}", src.display()),
    })?;
    if !fd_meta.is_file() {
        return Err(AppleStagingError::Io {
            message: format!("opened fd is not a regular file: {}", src.display()),
        });
    }
    Ok(file)
}

fn open_source_nofollow(src: &Path) -> Result<std::fs::File, AppleStagingError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(src)
            .map_err(|e| AppleStagingError::Io {
                message: format!("open {}: {e}", src.display()),
            })
    }
    #[cfg(not(unix))]
    {
        if crate::import_apple_journal::is_leaf_symlink(src) {
            return Err(AppleStagingError::Io {
                message: format!("leaf symlink rejected at stage time: {}", src.display()),
            });
        }
        std::fs::File::open(src).map_err(|e| AppleStagingError::Io {
            message: format!("open {}: {e}", src.display()),
        })
    }
}

fn stream_copy_original(
    export_root: &Path,
    src: &Path,
    dest: &Path,
) -> Result<(u64, String), AppleStagingError> {
    use std::io::{Read, Write};

    let mut input = open_export_source_for_copy(export_root, src)?;
    let mut output = std::fs::File::create(dest).map_err(|e| AppleStagingError::Io {
        message: format!("create {}: {e}", dest.display()),
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = input.read(&mut buf).map_err(|e| AppleStagingError::Io {
            message: format!("read {}: {e}", src.display()),
        })?;
        if n == 0 {
            break;
        }
        output
            .write_all(&buf[..n])
            .map_err(|e| AppleStagingError::Io {
                message: format!("write {}: {e}", dest.display()),
            })?;
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    output.sync_all().map_err(|e| AppleStagingError::Io {
        message: format!("sync {}: {e}", dest.display()),
    })?;
    Ok((total, hex::encode(hasher.finalize())))
}

fn read_apple_sidecar_json(export_root: &Path, path: &Path) -> Result<String, AppleStagingError> {
    use std::io::Read;

    reject_post_scan_source_swap(export_root, path)?;
    let file = open_source_nofollow(path)?;
    let fd_meta = file.metadata().map_err(|e| AppleStagingError::Io {
        message: format!("fstat {}: {e}", path.display()),
    })?;
    if !fd_meta.is_file() {
        return Err(AppleStagingError::Io {
            message: format!(
                "opened sidecar fd is not a regular file: {}",
                path.display()
            ),
        });
    }
    let mut limited =
        file.take(crate::import_apple_journal::MAX_APPLE_JOURNAL_JSON_BYTES.saturating_add(1));
    let mut buf = Vec::new();
    limited
        .read_to_end(&mut buf)
        .map_err(|e| AppleStagingError::Io {
            message: format!("read {}: {e}", path.display()),
        })?;
    if buf.len() as u64 > crate::import_apple_journal::MAX_APPLE_JOURNAL_JSON_BYTES {
        return Err(AppleStagingError::Io {
            message: format!(
                "sidecar exceeds {} bytes: {}",
                crate::import_apple_journal::MAX_APPLE_JOURNAL_JSON_BYTES,
                path.display()
            ),
        });
    }
    String::from_utf8(buf).map_err(|e| AppleStagingError::Io {
        message: format!("read {}: {e}", path.display()),
    })
}

/// What a staged image looked like after recompression.
struct RecompressedStagedImage {
    path: PathBuf,
    mime: String,
    byte_len: u64,
}

/// Recompress an already-staged image file in place per `mode`, returning the
/// new path / MIME / size when the bytes actually changed.
///
/// Opportunistic like the editor insert path: any read/write failure, a
/// pass-through format (HEIC, SVG), or an already-in-bounds image leaves the
/// staged original untouched and returns `None`. A PNG re-encoded as JPEG gets
/// a new `{media_id}.jpg` path and the old file is removed.
///
/// The rewrite always goes to a sibling `.recompress.tmp` and is `rename`d over
/// the final path. The common case is a JPEG resized to JPEG, i.e. `new_path ==
/// dest`: a plain `fs::write` there would truncate the only copy of the
/// original before the new bytes land, so a mid-write failure (disk full, IO
/// error, kill) would leave a corrupt file behind a `None` return. `rename` on
/// the same directory is atomic, so a failure leaves the original intact and
/// the temp file is removed.
fn recompress_staged_image(
    dest: &Path,
    mime: &str,
    ext: &str,
    mode: crate::utils::image_compression::CompressionMode,
) -> Option<RecompressedStagedImage> {
    if !mime.starts_with("image/") {
        return None;
    }
    let original = match std::fs::read(dest) {
        Ok(bytes) => bytes,
        Err(err) => {
            log::warn!(
                "apple staging: recompress read {} failed: {err}",
                dest.display()
            );
            return None;
        }
    };
    let (bytes, new_mime, new_ext) =
        crate::utils::image_compression::compress_image(&original, mime, ext, mode);
    if bytes == original {
        return None;
    }
    let new_path = if new_ext == ext {
        dest.to_path_buf()
    } else {
        if !is_safe_component(&new_ext) {
            return None;
        }
        dest.with_extension(&new_ext)
    };

    let tmp_path = dest.with_extension(format!("{ext}.recompress.tmp"));
    if let Err(err) = std::fs::write(&tmp_path, &bytes) {
        log::warn!(
            "apple staging: recompress write {} failed: {err}",
            tmp_path.display()
        );
        let _ = std::fs::remove_file(&tmp_path);
        return None;
    }
    if let Err(err) = std::fs::rename(&tmp_path, &new_path) {
        log::warn!(
            "apple staging: recompress rename to {} failed: {err}",
            new_path.display()
        );
        let _ = std::fs::remove_file(&tmp_path);
        return None;
    }
    if new_path != dest {
        if let Err(err) = std::fs::remove_file(dest) {
            log::warn!(
                "apple staging: remove pre-compression original {} failed: {err}",
                dest.display()
            );
        }
    }
    Some(RecompressedStagedImage {
        path: new_path,
        mime: new_mime,
        byte_len: bytes.len() as u64,
    })
}

fn apple_image_dimensions(
    dest: &Path,
    mime: &str,
    exif: Option<&crate::utils::exif::ExifData>,
) -> (Option<i64>, Option<i64>) {
    if !mime.starts_with("image/") {
        return (None, None);
    }
    let from_exif = exif.and_then(|data| match (data.width, data.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some((w as i64, h as i64)),
        _ => None,
    });
    if let Some(dims) = from_exif {
        return (Some(dims.0), Some(dims.1));
    }
    if !crate::utils::thumbnail::supports_thumbnail(mime) {
        return (None, None);
    }
    match image::ImageReader::open(dest)
        .ok()
        .and_then(|reader| reader.with_guessed_format().ok())
        .and_then(|reader| reader.into_dimensions().ok())
    {
        Some((w, h)) => (Some(w as i64), Some(h as i64)),
        None => (None, None),
    }
}

fn apple_maybe_thumbnail(
    media_root: &Path,
    media_id: &str,
    mime: &str,
    dest: &Path,
    owned: &mut Vec<PathBuf>,
) -> (Option<PathBuf>, Option<AppleStagingWarningKind>) {
    if !mime.starts_with("image/") {
        return (None, None);
    }
    if !crate::utils::thumbnail::supports_thumbnail(mime) {
        return (None, Some(AppleStagingWarningKind::NoThumbnail));
    }
    let bytes = match std::fs::read(dest) {
        Ok(bytes) => bytes,
        Err(_) => return (None, Some(AppleStagingWarningKind::UnsupportedDecode)),
    };
    match crate::utils::thumbnail::generate_thumbnail(
        &bytes,
        crate::utils::thumbnail::DEFAULT_MAX_EDGE,
        crate::utils::thumbnail::DEFAULT_JPEG_QUALITY,
    ) {
        Ok(thumb) => {
            let thumb_path = media_root.join(format!("{media_id}.thumb.jpg"));
            if std::fs::write(&thumb_path, thumb).is_err() {
                return (None, Some(AppleStagingWarningKind::UnsupportedDecode));
            }
            owned.push(thumb_path.clone());
            (Some(thumb_path), None)
        }
        Err(_) => (None, Some(AppleStagingWarningKind::UnsupportedDecode)),
    }
}

fn cleanup_owned_staged_files(paths: &[PathBuf]) {
    for path in paths.iter().rev() {
        if let Err(err) = std::fs::remove_file(path) {
            log::warn!(
                "failed to remove staged Apple media {}: {err}",
                path.display()
            );
        }
    }
}

// ─── Apple Journal folder import (Phase 2 Task 2a) ───────────────────────────

const APPLE_IMPORT_MANIFEST_PREFIX: &str = ".apple-import-";
const APPLE_IMPORT_MANIFEST_SUFFIX: &str = ".manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppleImportManifestFile {
    operation_id: String,
    files: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ApplePreparedEntry {
    pub id: String,
    pub title: Option<String>,
    pub preview_text: String,
    pub content_text: String,
    pub yjs_doc: Vec<u8>,
    pub entry_date: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub location_label: Option<String>,
    pub location_address: Option<String>,
    pub media: Vec<AppleStagedMedia>,
    pub source_identity: String,
    pub source_fingerprint: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ApplePreparedImport {
    pub owned_files: Vec<PathBuf>,
    pub manifest_path: PathBuf,
    pub entries: Vec<ApplePreparedEntry>,
    pub warnings: Vec<ImportWarning>,
    pub resources_referenced: u64,
    pub resources_missing: u64,
    pub resources_unsupported: u64,
    pub resources_unreferenced: u64,
}

const APPLE_SOURCE_CHANGED_ERR: &str = "Apple Journal source changed since preview";
const APPLE_DATE_POLICY: &str = "html_visible";
const APPLE_DATE_PRECISION: &str = "date_only";

fn apple_conversion_timezone(options: Option<&AppleJournalImportOptions>) -> String {
    options
        .and_then(|opts| opts.conversion_timezone.as_deref())
        .map(str::trim)
        .filter(|tz| !tz.is_empty())
        .unwrap_or("system-local")
        .to_string()
}

fn reject_fatal_apple_scan(
    scan: &crate::import_apple_journal::AppleJournalFolder,
) -> Result<(), String> {
    let fatal = scan.errors.iter().any(|err| {
        !matches!(
            err.kind,
            crate::import_apple_journal::AppleJournalErrorKind::CorruptSidecar
        )
    });
    if !fatal {
        return Ok(());
    }
    let first = scan
        .errors
        .iter()
        .find(|err| {
            !matches!(
                err.kind,
                crate::import_apple_journal::AppleJournalErrorKind::CorruptSidecar
            )
        })
        .map(|err| err.message.clone())
        .unwrap_or_else(|| "invalid Apple Journal export".to_string());
    Err(format!("Apple Journal preflight: {first}"))
}

fn apple_export_source_hash(
    scan: &crate::import_apple_journal::AppleJournalFolder,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"apple-journal-preview-v1\0");
    let mut fingerprints = Vec::with_capacity(scan.entries.len());
    for entry in &scan.entries {
        fingerprints.push(
            crate::import_apple_journal::fingerprint_apple_journal_entry(
                entry,
                &scan.resources,
                &scan.root,
            )?,
        );
    }
    fingerprints.sort();
    for fingerprint in fingerprints {
        hasher.update(fingerprint.as_bytes());
        hasher.update(b"\0");
    }
    let mut resource_hashes: Vec<&str> = scan
        .resources
        .iter()
        .map(|resource| resource.sha256.as_str())
        .collect();
    resource_hashes.sort_unstable();
    for digest in resource_hashes {
        hasher.update(digest.as_bytes());
        hasher.update(b"\0");
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn preview_apple_journal_folder(
    app: Option<&AppHandle>,
    state: &AppState,
    src: &str,
    options: Option<&AppleJournalImportOptions>,
) -> Result<AppleJournalImportPreview, String> {
    emit_progress(app, 8, "reading");
    let scan = crate::import_apple_journal::scan_apple_journal_folder(src)
        .map_err(|e| format!("Apple Journal preflight: {e}"))?;
    reject_fatal_apple_scan(&scan)?;

    emit_progress(app, 45, "reading");
    let limits = apple_staging_limits_from_settings(state);
    let conversion_timezone = apple_conversion_timezone(options);
    let (warnings, counts) = account_apple_preview(&scan, limits, &conversion_timezone)?;
    let source_hash = apple_export_source_hash(&scan)?;

    emit_progress(app, 100, "done");
    Ok(AppleJournalImportPreview {
        source_hash,
        conversion_timezone,
        date_policy: APPLE_DATE_POLICY.to_string(),
        date_precision: APPLE_DATE_PRECISION.to_string(),
        clock_is_synthetic: true,
        entries: counts.entries,
        resources_referenced: counts.resources_referenced,
        resources_would_import: counts.resources_would_import,
        resources_missing: counts.resources_missing,
        resources_unsupported: counts.resources_unsupported,
        resources_unreferenced: counts.resources_unreferenced,
        warnings,
    })
}

#[derive(Debug, Clone, Copy, Default)]
struct ApplePreviewCounts {
    entries: u64,
    resources_referenced: u64,
    resources_would_import: u64,
    resources_missing: u64,
    resources_unsupported: u64,
    resources_unreferenced: u64,
}

// TODO(later): the exceeds-upload-limit warnings below are computed from the
// ORIGINAL resource bytes, but the import now compresses photos first, so the
// review modal can warn about a photo that ends up under the cap. Estimating
// the post-compression size here would mean decoding every image twice. See
// docs/LATER.md.
fn account_apple_preview(
    scan: &crate::import_apple_journal::AppleJournalFolder,
    limits: AppleStagingLimits,
    conversion_timezone: &str,
) -> Result<(Vec<ImportWarning>, ApplePreviewCounts), String> {
    let imported_at = now_unix();
    let mut warnings = Vec::new();
    let mut missing = 0u64;
    let mut would_import = 0u64;
    let mut unsupported = 0u64;

    for entry in &scan.entries {
        let source_name = entry
            .relative_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("entry.html");
        let resolved = crate::import_apple_journal::resolve_apple_entry_date(
            &entry.raw_html,
            source_name,
            &chrono::Local,
            conversion_timezone,
            imported_at,
        );
        for warning in &resolved.warnings {
            warnings.push(ImportWarning::new(
                warning.kind.as_import_kind(),
                warning.message.clone(),
            ));
        }

        for media_ref in &entry.media_refs {
            if media_ref.media_path.is_none() {
                missing += 1;
                warnings.push(ImportWarning::new(
                    "missing_resource",
                    "a referenced resource is missing from the export",
                ));
                continue;
            }
            let Some(source_path) = media_ref.media_path.as_ref() else {
                continue;
            };
            let resource = scan
                .resources
                .iter()
                .find(|item| item.media_path == *source_path);
            let file_name = source_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unnamed");
            let ext = apple_media_extension(file_name);
            let mime = crate::commands::media::mime_from_ext(&ext);
            let byte_len = resource.map(|item| item.byte_len).unwrap_or(0);

            if mime.starts_with("image/")
                || mime.starts_with("video/")
                || mime.starts_with("audio/")
            {
                would_import += 1;
            } else {
                would_import += 1;
                unsupported += 1;
                warnings.push(ImportWarning::new(
                    "unknown_referenced_attachment",
                    "a referenced file has no native editor type; it will be kept as an attachment",
                ));
            }

            if mime == "image/heic" || mime == "image/heif" {
                // TODO(later): non-macOS HEIC decode/thumbnail. macOS WKWebView
                // can display original bytes; other platforms need a decode
                // path. See docs/LATER.md.
                warnings.push(ImportWarning::new(
                    "unsupported_decode",
                    "HEIC/HEIF may not display on every platform; original bytes are kept",
                ));
            }
            if mime.starts_with("image/") && !crate::utils::thumbnail::supports_thumbnail(mime) {
                warnings.push(ImportWarning::new(
                    "no_thumbnail",
                    "no thumbnail can be generated for this image type; original bytes are kept",
                ));
            }

            if mime.starts_with("image/")
                && limits
                    .photo_upload_bytes
                    .is_some_and(|cap| cap >= 0 && byte_len > cap as u64)
            {
                warnings.push(ImportWarning::new(
                    "exceeds_photo_upload_limit",
                    "an original image exceeds the configured photo upload cap; it will import locally",
                ));
            }
            if mime.starts_with("video/")
                && limits
                    .video_upload_bytes
                    .is_some_and(|cap| cap >= 0 && byte_len > cap as u64)
            {
                warnings.push(ImportWarning::new(
                    "exceeds_video_upload_limit",
                    "an original video exceeds the configured video upload cap; it will import locally",
                ));
            }
        }

        let built = crate::import_apple_journal_yjs::build_apple_entry_yjs(
            &entry.raw_html,
            |_, _| None,
        )
        .map_err(|e| match e {
            crate::import_apple_journal_yjs::AppleYjsError::DocumentTooLarge { bytes, max_bytes } => {
                format!(
                    "Apple Journal preflight: Yjs document exceeds maximum allowed size ({max_bytes} bytes), got {bytes}"
                )
            }
        })?;
        for warning in &built.warnings {
            warnings.push(ImportWarning::with_feature(
                warning.kind.as_import_kind(),
                warning.message.clone(),
                warning.feature.clone(),
            ));
        }
    }

    if !scan.unreferenced_resources.is_empty() {
        warnings.push(ImportWarning::new(
            "unreferenced_resource",
            format!(
                "{} unreferenced resource(s) are present and must be reviewed",
                scan.unreferenced_resources.len()
            ),
        ));
    }

    Ok((
        warnings,
        ApplePreviewCounts {
            entries: scan.entries.len() as u64,
            resources_referenced: scan.entries.iter().map(|e| e.media_refs.len() as u64).sum(),
            resources_would_import: would_import,
            resources_missing: missing,
            resources_unsupported: unsupported,
            resources_unreferenced: scan.unreferenced_resources.len() as u64,
        },
    ))
}

fn import_apple_journal_folder(
    app: Option<&AppHandle>,
    state: &AppState,
    src: &str,
    mode: ImportMode,
    journal_id: Option<&str>,
    options: Option<&AppleJournalImportOptions>,
) -> Result<ImportSummary, String> {
    if mode == ImportMode::ReplaceAll {
        return Err("Apple Journal import is merge-only; ReplaceAll is not supported".to_string());
    }

    emit_progress(app, 8, "reading");

    {
        let conn = state.lock()?;
        resolve_import_journal_id(&conn, journal_id)?;
    }

    let media_root = resolve_media_root(state)?;
    // TODO(later): run this reaper at app unlock / media-root init so crash
    // leftovers do not sit on disk until the next Apple import. See docs/LATER.md.
    reap_stale_apple_import_manifests(&media_root);
    let limits = apple_staging_limits_from_settings(state);
    let prepared = prepare_apple_journal_import_checked(
        Path::new(src),
        &media_root,
        limits,
        options.and_then(|opts| opts.expected_source_hash.as_deref()),
        &apple_conversion_timezone(options),
    )?;

    emit_progress(app, 55, "writing");
    let journal = {
        let conn = state.lock()?;
        resolve_import_journal_id(&conn, journal_id)?
    };

    let mut video_jobs = Vec::new();
    let persist_result = {
        let conn = state.lock()?;
        persist_apple_journal_import(&conn, &journal, &prepared, &mut video_jobs)
    };
    match persist_result {
        Ok(summary) => {
            enqueue_import_video_compression(app, video_jobs);
            emit_progress(app, 100, "done");
            Ok(summary)
        }
        Err(err) => {
            cleanup_apple_import_operation(&prepared);
            Err(err)
        }
    }
}

/// Hand collected video-compression jobs to the background worker. Rows were
/// already flagged `awaiting_compression` in the import transaction; if the
/// queue is unavailable (tests, no Tauri context) the startup resume sweep
/// picks them up instead, so the hold is never permanent.
fn enqueue_import_video_compression(
    app: Option<&AppHandle>,
    jobs: Vec<crate::commands::compression::CompressionJob>,
) {
    if jobs.is_empty() {
        return;
    }
    use tauri::Manager;
    let Some(app) = app else {
        return;
    };
    let Some(queue) =
        app.try_state::<std::sync::Arc<crate::commands::compression::CompressionQueue>>()
    else {
        return;
    };
    for job in jobs {
        queue.enqueue(job);
    }
}

fn apple_staging_limits_from_settings(state: &AppState) -> AppleStagingLimits {
    let Ok(conn) = state.lock() else {
        return AppleStagingLimits::default();
    };
    AppleStagingLimits {
        photo_upload_bytes: db::get_media_max_photo_upload_bytes(&conn).ok(),
        video_upload_bytes: db::get_media_max_video_upload_bytes(&conn).ok(),
        compression: crate::commands::media::resolve_compression_mode(&conn),
    }
}

pub(crate) fn is_apple_import_manifest(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with(APPLE_IMPORT_MANIFEST_PREFIX)
                && name.ends_with(APPLE_IMPORT_MANIFEST_SUFFIX)
        })
}

pub(crate) fn cleanup_apple_import_operation(prepared: &ApplePreparedImport) {
    cleanup_owned_staged_files(&prepared.owned_files);
}

fn is_safe_apple_reap_target(media_root: &Path, path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return false;
    }
    !crate::import_apple_journal::path_escapes_export_root(media_root, path)
}

/// Delete leftover `.apple-import-*.manifest.json` files and the staged
/// regular files they list, but only after verifying each path is a regular
/// file inside `media_root`. Never follows or deletes escaping paths.
pub(crate) fn reap_stale_apple_import_manifests(media_root: &Path) {
    let Ok(entries) = std::fs::read_dir(media_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_apple_import_manifest(&path) {
            continue;
        }
        if !is_safe_apple_reap_target(media_root, &path) {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(manifest) = serde_json::from_slice::<AppleImportManifestFile>(&bytes) {
                for file in &manifest.files {
                    let candidate = PathBuf::from(file);
                    if is_safe_apple_reap_target(media_root, &candidate) {
                        if let Err(err) = std::fs::remove_file(&candidate) {
                            log::warn!(
                                "failed to reap leftover Apple media {}: {err}",
                                candidate.display()
                            );
                        }
                    }
                }
            }
        }
        if let Err(err) = std::fs::remove_file(&path) {
            log::warn!(
                "failed to reap Apple import manifest {}: {err}",
                path.display()
            );
        }
    }
}

fn write_apple_import_manifest(
    media_root: &Path,
    owned_files: &[PathBuf],
) -> Result<PathBuf, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let manifest_path = media_root.join(format!(
        "{APPLE_IMPORT_MANIFEST_PREFIX}{operation_id}{APPLE_IMPORT_MANIFEST_SUFFIX}"
    ));
    let payload = AppleImportManifestFile {
        operation_id,
        files: owned_files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    };
    let json = serde_json::to_vec(&payload).map_err(|e| format!("encode apple manifest: {e}"))?;
    std::fs::write(&manifest_path, json)
        .map_err(|e| format!("write apple manifest {}: {e}", manifest_path.display()))?;
    Ok(manifest_path)
}

#[cfg(test)]
pub(crate) fn prepare_apple_journal_import(
    src: &Path,
    media_root: &Path,
    limits: AppleStagingLimits,
) -> Result<ApplePreparedImport, String> {
    prepare_apple_journal_import_checked(src, media_root, limits, None, "system-local")
}

fn prepare_apple_journal_import_checked(
    src: &Path,
    media_root: &Path,
    limits: AppleStagingLimits,
    expected_source_hash: Option<&str>,
    conversion_timezone: &str,
) -> Result<ApplePreparedImport, String> {
    let scan = crate::import_apple_journal::scan_apple_journal_folder(src)
        .map_err(|e| format!("Apple Journal preflight: {e}"))?;
    reject_fatal_apple_scan(&scan)?;

    if let Some(expected) = expected_source_hash {
        let actual = apple_export_source_hash(&scan)?;
        if actual != expected {
            return Err(APPLE_SOURCE_CHANGED_ERR.to_string());
        }
    }

    let staged = stage_apple_resources(&scan, media_root, limits)
        .map_err(|e| format!("Apple Journal staging: {e}"))?;

    let mut owned_files: Vec<PathBuf> = Vec::new();
    for item in &staged.media {
        owned_files.push(item.storage_path.clone());
        if let Some(thumb) = &item.thumbnail_path {
            owned_files.push(thumb.clone());
        }
    }
    let manifest_path = match write_apple_import_manifest(media_root, &owned_files) {
        Ok(path) => path,
        Err(err) => {
            cleanup_owned_staged_files(&owned_files);
            return Err(err);
        }
    };

    match prepare_apple_entries(&scan, &staged, conversion_timezone) {
        Ok((entries, mut warnings, missing)) => {
            if !scan.unreferenced_resources.is_empty() {
                warnings.push(ImportWarning::new(
                    "unreferenced_resource",
                    format!(
                        "{} unreferenced resource(s) are retained in the source archive and were not assigned to an entry",
                        scan.unreferenced_resources.len()
                    ),
                ));
            }
            let unsupported = staged
                .media
                .iter()
                .filter(|m| {
                    !m.mime.starts_with("image/")
                        && !m.mime.starts_with("video/")
                        && !m.mime.starts_with("audio/")
                })
                .count() as u64;
            Ok(ApplePreparedImport {
                owned_files,
                manifest_path,
                entries,
                warnings,
                resources_referenced: scan.entries.iter().map(|e| e.media_refs.len() as u64).sum(),
                resources_missing: missing,
                resources_unsupported: unsupported,
                resources_unreferenced: scan.unreferenced_resources.len() as u64,
            })
        }
        Err(err) => {
            cleanup_owned_staged_files(&owned_files);
            Err(err)
        }
    }
}

fn prepare_apple_entries(
    scan: &crate::import_apple_journal::AppleJournalFolder,
    staged: &AppleStagedResources,
    conversion_timezone: &str,
) -> Result<(Vec<ApplePreparedEntry>, Vec<ImportWarning>, u64), String> {
    use crate::import_apple_journal_yjs::{
        build_apple_entry_yjs_with_provenance, AppleJournalProvenance, AppleJournalResourceRecord,
        AppleMediaResolve, AppleYjsError,
    };

    let imported_at = now_unix();
    let mut warnings = Vec::new();
    let mut missing = 0u64;
    let mut prepared = Vec::with_capacity(scan.entries.len());

    for staging_warning in &staged.warnings {
        warnings.push(ImportWarning::new(
            staging_warning.kind.as_import_kind(),
            staging_warning.message.clone(),
        ));
    }

    for entry in &scan.entries {
        let source_name = entry
            .relative_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("entry.html");
        let resolved = crate::import_apple_journal::resolve_apple_entry_date(
            &entry.raw_html,
            source_name,
            &chrono::Local,
            conversion_timezone,
            imported_at,
        );
        for warning in &resolved.warnings {
            warnings.push(ImportWarning::new(
                warning.kind.as_import_kind(),
                warning.message.clone(),
            ));
        }

        let entry_media: Vec<AppleStagedMedia> = staged
            .media
            .iter()
            .filter(|item| item.entry_relative_path == entry.relative_path)
            .cloned()
            .collect();

        let mut ids_by_src: std::collections::HashMap<String, std::collections::VecDeque<String>> =
            std::collections::HashMap::new();
        let mut staged_iter = entry_media.iter();
        for media_ref in &entry.media_refs {
            if media_ref.media_path.is_none() {
                missing += 1;
                warnings.push(ImportWarning::new(
                    "missing_resource",
                    format!("referenced resource is missing: {}", media_ref.src),
                ));
                continue;
            }
            if let Some(item) = staged_iter.next() {
                ids_by_src
                    .entry(media_ref.src.clone())
                    .or_default()
                    .push_back(item.media_id.clone());
            }
        }

        let (visits, native_location, sidecar_records, source_dates, unknown_fields) =
            collect_apple_entry_provenance(entry, &resolved, scan)?;

        let provenance = AppleJournalProvenance {
            raw_html: entry.raw_html.clone(),
            sidecars: sidecar_records,
            original_relative_names: entry.media_refs.iter().map(|r| r.src.clone()).collect(),
            unknown_fields,
            source_dates,
            resources: entry_media
                .iter()
                .map(|item| AppleJournalResourceRecord {
                    relative_name: item.source_file_name.clone(),
                    sha256: item.sha256.clone(),
                    media_id: Some(item.media_id.clone()),
                })
                .collect(),
            visits,
            native_location: native_location.clone(),
        };

        let built = build_apple_entry_yjs_with_provenance(&entry.raw_html, |_, src| {
            if ids_by_src
                .get_mut(src)
                .and_then(|queue| queue.pop_front())
                .is_some()
            {
                AppleMediaResolve::Attached
            } else {
                AppleMediaResolve::Missing
            }
        }, &provenance)
        .map_err(|e| match e {
            AppleYjsError::DocumentTooLarge { bytes, max_bytes } => {
                format!("Apple Journal preflight: Yjs document exceeds maximum allowed size ({max_bytes} bytes), got {bytes}")
            }
        })?;

        for warning in &built.warnings {
            warnings.push(ImportWarning::with_feature(
                warning.kind.as_import_kind(),
                warning.message.clone(),
                warning.feature.clone(),
            ));
        }

        let entry_date = resolved.entry_date_unix.unwrap_or(resolved.imported_at);
        prepared.push(ApplePreparedEntry {
            id: uuid::Uuid::new_v4().to_string(),
            title: entry.title.clone(),
            preview_text: built.preview_text,
            content_text: built.content_text,
            yjs_doc: built.update,
            entry_date,
            created_at: resolved.created_at,
            updated_at: resolved.updated_at,
            latitude: native_location.as_ref().map(|loc| loc.latitude),
            longitude: native_location.as_ref().map(|loc| loc.longitude),
            location_label: native_location.as_ref().and_then(|loc| loc.label.clone()),
            location_address: native_location.as_ref().and_then(|loc| loc.address.clone()),
            media: entry_media,
            source_identity: crate::import_apple_journal::apple_source_identity(
                &entry.relative_path,
            ),
            source_fingerprint: crate::import_apple_journal::fingerprint_apple_journal_entry(
                entry,
                &scan.resources,
                &scan.root,
            )?,
        });
    }

    Ok((prepared, warnings, missing))
}

fn collect_apple_entry_provenance(
    entry: &crate::import_apple_journal::AppleJournalEntry,
    resolved: &crate::import_apple_journal::AppleResolvedEntryDate,
    scan: &crate::import_apple_journal::AppleJournalFolder,
) -> Result<
    (
        Vec<crate::import_apple_journal_yjs::AppleJournalVisitRecord>,
        Option<crate::import_apple_journal::AppleNativeLocation>,
        Vec<crate::import_apple_journal_yjs::AppleJournalSidecarRecord>,
        Vec<crate::import_apple_journal_yjs::AppleJournalSourceDateRecord>,
        Vec<crate::import_apple_journal_yjs::AppleJournalUnknownFieldRecord>,
    ),
    String,
> {
    use crate::import_apple_journal_yjs::{
        AppleJournalSidecarRecord, AppleJournalSourceDateRecord, AppleJournalUnknownFieldRecord,
        AppleJournalVisitRecord,
    };
    let export_root = &scan.root;

    let mut visits = Vec::new();
    let mut sidecars = Vec::new();
    let mut source_dates = Vec::new();
    let mut map_visits = Vec::new();

    if let Some(raw) = &resolved.header_date_raw {
        source_dates.push(AppleJournalSourceDateRecord {
            kind: "html_header".to_string(),
            relative_name: entry.relative_path.to_string_lossy().into_owned(),
            value: raw.clone(),
        });
    }
    if let Some(raw) = &resolved.filename_date_raw {
        source_dates.push(AppleJournalSourceDateRecord {
            kind: "filename".to_string(),
            relative_name: entry.relative_path.to_string_lossy().into_owned(),
            value: raw.clone(),
        });
    }

    for media_ref in &entry.media_refs {
        let Some(sidecar_path) = media_ref.sidecar_path.as_ref() else {
            continue;
        };
        let json = read_apple_sidecar_json(export_root, sidecar_path).map_err(|e| {
            format!(
                "Apple Journal preflight: sidecar {}: {e}",
                sidecar_path.display()
            )
        })?;
        let relative_name = sidecar_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("sidecar.json")
            .to_string();
        if let Ok(meta) = crate::import_apple_journal::parse_apple_resource_metadata(&json, None) {
            if let Some(raw) = &meta.date_raw {
                source_dates.push(AppleJournalSourceDateRecord {
                    kind: "sidecar".to_string(),
                    relative_name: relative_name.clone(),
                    value: raw.clone(),
                });
            }
            for visit in &meta.visits {
                map_visits.push(visit.clone());
                visits.push(AppleJournalVisitRecord {
                    media_src: media_ref.src.clone(),
                    relative_name: relative_name.clone(),
                    place_name: visit.place_name.clone(),
                    latitude: visit.latitude,
                    longitude: visit.longitude,
                    city: visit.city.clone(),
                    type_of_place: visit.type_of_place.clone(),
                });
            }
        }
        sidecars.push(AppleJournalSidecarRecord {
            relative_name,
            json,
        });
    }

    let native_location =
        crate::import_apple_journal::first_valid_apple_native_location(&map_visits);

    let mut unknown_fields = Vec::new();
    for key in &scan.unknown_sidecar_keys {
        let belongs = entry.media_refs.iter().any(|media| {
            media.sidecar_path.as_ref().is_some_and(|path| {
                path.ends_with(&key.relative_path)
                    || path.file_name() == key.relative_path.file_name()
            })
        });
        if belongs {
            unknown_fields.push(AppleJournalUnknownFieldRecord {
                relative_name: key.relative_path.to_string_lossy().into_owned(),
                key: key.key.clone(),
            });
        }
    }
    for card in &scan.unknown_cards {
        if card.relative_path == entry.relative_path {
            unknown_fields.push(AppleJournalUnknownFieldRecord {
                relative_name: card.relative_path.to_string_lossy().into_owned(),
                key: card.asset_type.clone(),
            });
        }
    }

    Ok((
        visits,
        native_location,
        sidecars,
        source_dates,
        unknown_fields,
    ))
}

/// Commit a prepared Apple Journal import.
///
/// `video_jobs` collects one background-compression job per staged video that
/// actually landed. The rows are flagged `awaiting_compression` inside the
/// transaction (holding the original out of cloud upload) exactly as
/// `pick_video` does, and the caller enqueues the jobs after the commit.
pub(crate) fn persist_apple_journal_import(
    conn: &rusqlite::Connection,
    journal_id: &str,
    prepared: &ApplePreparedImport,
    video_jobs: &mut Vec<crate::commands::compression::CompressionJob>,
) -> Result<ImportSummary, String> {
    let video_mode = crate::commands::media::resolve_video_compression_mode(conn);
    let compress_videos = cfg!(target_os = "macos") && video_mode.preset_name().is_some();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin apple import transaction: {e}"))?;

    let mut imported = 0u64;
    let mut skipped_exact = 0u64;
    let mut source_changed = 0u64;
    let mut resources_imported = 0u64;
    let mut warnings = prepared.warnings.clone();
    let mut leftover_files: Vec<PathBuf> = Vec::new();

    for entry in &prepared.entries {
        if db::find_apple_import_by_fingerprint(&tx, journal_id, &entry.source_fingerprint)
            .map_err(|e| format!("lookup apple fingerprint: {e}"))?
            .is_some()
        {
            // Exact retry: skip. Never replace the committed row (edited or locked).
            skipped_exact += 1;
            leftover_files.extend(apple_entry_owned_files(entry));
            continue;
        }

        let priors =
            db::find_apple_import_by_source_identity(&tx, journal_id, &entry.source_identity)
                .map_err(|e| format!("lookup apple source identity: {e}"))?;
        if !priors.is_empty() {
            // Changed source: always insert a distinct entry. Never merge into
            // or replace the prior row, even when that row is unlocked.
            // TODO(later): reconcile a changed source with the existing local
            // entry instead of always inserting a distinct row. See docs/LATER.md.
            source_changed += 1;
            warnings.push(ImportWarning::new(
                "source_changed",
                format!(
                    "source entry changed; created a distinct entry instead of replacing ({})",
                    entry.source_identity
                ),
            ));
        }

        db::insert_apple_imported_entry(
            &tx,
            db::AppleImportedEntryParams {
                id: &entry.id,
                journal_id,
                title: entry.title.as_deref(),
                preview_text: Some(entry.preview_text.as_str()).filter(|s| !s.is_empty()),
                content_text: Some(entry.content_text.as_str()).filter(|s| !s.is_empty()),
                entry_date: entry.entry_date,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
                latitude: entry.latitude,
                longitude: entry.longitude,
                location_label: entry.location_label.as_deref(),
                location_address: entry.location_address.as_deref(),
                yjs_doc: Some(entry.yjs_doc.as_slice()),
            },
        )
        .map_err(|e| format!("insert apple entry: {e}"))?;

        for media in &entry.media {
            db::insert_apple_imported_media(
                &tx,
                db::AppleImportedMediaParams {
                    id: &media.media_id,
                    entry_id: &entry.id,
                    file_name: &apple_stored_file_name(media),
                    file_type: &media.mime,
                    storage_path: &media.storage_path.to_string_lossy(),
                    thumbnail_path: media.thumbnail_path.as_ref().and_then(|p| p.to_str()),
                    file_size: Some(media.byte_len as i64),
                    sort_order: media.sort_order,
                    insertion_mode: media.insertion_mode.as_str(),
                    width: media.width,
                    height: media.height,
                    duration_seconds: media.duration_seconds,
                    exif_date: media.capture_unix,
                    exif_latitude: media.exif_latitude,
                    exif_longitude: media.exif_longitude,
                },
            )
            .map_err(|e| format!("insert apple media {}: {e}", media.media_id))?;

            if compress_videos && media.mime.starts_with("video/") {
                db::queries::set_media_awaiting_compression(&tx, &media.media_id, true)
                    .map_err(|e| format!("hold apple video {}: {e}", media.media_id))?;
                video_jobs.push(crate::commands::compression::CompressionJob {
                    media_id: media.media_id.clone(),
                    src_path: media.storage_path.clone(),
                    mode: video_mode,
                });
            }
        }

        db::record_apple_import_fingerprint(
            &tx,
            journal_id,
            &entry.source_identity,
            &entry.source_fingerprint,
            &entry.id,
        )
        .map_err(|e| format!("record apple fingerprint: {e}"))?;

        imported += 1;
        resources_imported += entry.media.len() as u64;
    }

    tx.commit()
        .map_err(|e| format!("commit apple import: {e}"))?;

    cleanup_owned_staged_files(&leftover_files);
    if let Err(err) = std::fs::remove_file(&prepared.manifest_path) {
        log::warn!(
            "failed to remove apple import manifest {}: {err}",
            prepared.manifest_path.display()
        );
    }

    Ok(ImportSummary {
        imported,
        skipped_duplicates: skipped_exact,
        errors: Vec::new(),
        warnings,
        apple: Some(AppleImportReport {
            entries_imported: imported,
            entries_failed: 0,
            resources_referenced: prepared.resources_referenced,
            resources_imported,
            resources_missing: prepared.resources_missing,
            resources_unsupported: prepared.resources_unsupported,
            resources_unreferenced: prepared.resources_unreferenced,
            entries_skipped_exact: skipped_exact,
            entries_source_changed: source_changed,
        }),
    })
}

/// Display name for a staged Apple resource, with its extension realigned to
/// the file that actually landed on disk (image compression can re-encode a
/// PNG as JPEG). Export/restore derive the zip member extension from
/// `media.file_name`, so a stale `.png` here would round-trip JPEG bytes under
/// a PNG name. `source_stem` / `source_file_name` keep the original name for
/// provenance.
fn apple_stored_file_name(media: &AppleStagedMedia) -> String {
    let Some(stored_ext) = media.storage_path.extension().and_then(|e| e.to_str()) else {
        return media.source_file_name.clone();
    };
    let source = Path::new(&media.source_file_name);
    if source.extension().and_then(|e| e.to_str()) == Some(stored_ext) {
        return media.source_file_name.clone();
    }
    source
        .with_extension(stored_ext)
        .to_string_lossy()
        .into_owned()
}

fn apple_entry_owned_files(entry: &ApplePreparedEntry) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for media in &entry.media {
        files.push(media.storage_path.clone());
        if let Some(thumb) = &media.thumbnail_path {
            files.push(thumb.clone());
        }
    }
    files
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::export::{export_data_inner, ExportFormat, ExportScope};
    use crate::db::schema::migrate;
    use crate::utils::encryption::{derive_encryption_key, SALT_SIZE};
    use rusqlite::Connection;
    use std::fs;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        AppState::new(conn)
    }

    fn make_key_state() -> EncryptionKeyState {
        let ks = EncryptionKeyState::new();
        ks.set_key(derive_encryption_key("pw", &[7u8; SALT_SIZE]).unwrap())
            .unwrap();
        ks
    }

    fn seed_entry(state: &AppState, ks: &EncryptionKeyState, title: &str, body: &str, date: i64) {
        // Phase 3: plaintext directly — no encryption fixture.
        let conn = state.lock().unwrap();
        let jid = db::list_journals(&conn, None).unwrap()[0].id.clone();
        ks.with_key(|_key| {
            db::create_entry(
                &conn,
                db::CreateEntryParams {
                    journal_id: &jid,
                    title: Some(title),
                    content_text: Some(body),
                    preview_text: None,
                    entry_date: date,
                },
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn round_trip_export_then_import_preserves_entry_counts() {
        let src_state = make_state();
        let ks = make_key_state();
        seed_entry(&src_state, &ks, "hello", "first body", 1_700_000_000);
        seed_entry(&src_state, &ks, "second", "second body", 1_700_000_100);

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("out.memlore.zip");
        export_data_inner(
            None,
            &src_state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ExportFormat::MemloreJson,
            ExportScope::All,
        )
        .unwrap();

        // Import into a fresh DB.
        let dst_state = make_state();
        let dst_ks = make_key_state();
        let summary = import_data_inner(
            None,
            &dst_state,
            &dst_ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 2, "both entries imported");
        assert_eq!(summary.skipped_duplicates, 0);

        let conn = dst_state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn merge_skips_duplicates_by_entry_date_and_content() {
        let src_state = make_state();
        let ks = make_key_state();
        seed_entry(&src_state, &ks, "same", "identical body", 1_700_000_000);

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("out.memlore.zip");
        export_data_inner(
            None,
            &src_state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ExportFormat::MemloreJson,
            ExportScope::All,
        )
        .unwrap();

        // Pre-populate the destination with the same body + date.
        let dst_state = make_state();
        let dst_ks = make_key_state();
        seed_entry(
            &dst_state,
            &dst_ks,
            "local copy",
            "identical body",
            1_700_000_000,
        );

        let summary = import_data_inner(
            None,
            &dst_state,
            &dst_ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(
            summary.skipped_duplicates, 1,
            "duplicate (date, content) should be skipped"
        );

        let conn = dst_state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "no new row inserted");
    }

    #[test]
    fn import_format_wire_names_match_frontend_union() {
        // Keep in sync with `ImportFormat` in src/lib/tauri.ts.
        for (wire, expected) in [
            ("memlore_zip", ImportFormat::MemloreZip),
            ("markdown_folder", ImportFormat::MarkdownFolder),
            ("plain_text_folder", ImportFormat::PlainTextFolder),
            ("dayone_zip", ImportFormat::DayOneZip),
            ("journey_zip", ImportFormat::JourneyZip),
            ("apple_journal_folder", ImportFormat::AppleJournalFolder),
        ] {
            let parsed: ImportFormat =
                serde_json::from_value(serde_json::Value::String(wire.to_string()))
                    .unwrap_or_else(|e| panic!("format `{wire}` must deserialize: {e}"));
            assert_eq!(parsed, expected);
        }
    }

    #[test]
    fn rejects_unsupported_schema_version() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.memlore.zip");
        let f = std::fs::File::create(&bad).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(br#"{"schema_version": 999, "exported_at": "", "app_version": "", "entry_count": 0, "journal_count": 0, "tag_count": 0, "media_count": 0}"#).unwrap();
        zw.start_file("journals.json", opts).unwrap();
        zw.write_all(b"[]").unwrap();
        zw.start_file("entries.jsonl", opts).unwrap();
        zw.write_all(b"").unwrap();
        zw.finish().unwrap();

        let state = make_state();
        let ks = make_key_state();
        let err = import_data_inner(
            None,
            &state,
            &ks,
            bad.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap_err();
        assert!(err.contains("schema_version"), "err: {err}");
    }

    #[test]
    fn markdown_folder_converts_syntax_while_plain_text_keeps_it_literal() {
        use std::io::Write as _;

        let body = "# My day\n\nSome **bold** text.";

        let md_dir = tempfile::tempdir().unwrap();
        writeln!(
            std::fs::File::create(md_dir.path().join("2024-05-15-note.md")).unwrap(),
            "{body}"
        )
        .unwrap();

        let txt_dir = tempfile::tempdir().unwrap();
        writeln!(
            std::fs::File::create(txt_dir.path().join("2024-05-15-note.txt")).unwrap(),
            "{body}"
        )
        .unwrap();

        let state = make_state();
        let ks = make_key_state();
        for (dir, format) in [
            (&md_dir, ImportFormat::MarkdownFolder),
            (&txt_dir, ImportFormat::PlainTextFolder),
        ] {
            let summary = import_data_inner(
                None,
                &state,
                &ks,
                dir.path().to_string_lossy().to_string(),
                format,
                ImportMode::MergeNewer,
                None,
            )
            .unwrap();
            assert_eq!(summary.imported, 1, "errors: {:?}", summary.errors);
        }

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 2);

        let md = rows
            .iter()
            .find(|r| r.title.as_deref() == Some("My day"))
            .expect("markdown heading becomes the title");
        assert_eq!(md.content_text.as_deref(), Some("Some bold text."));
        let md_yjs = db::get_entry_content(&conn, &md.id).unwrap().unwrap();
        assert_eq!(yjs_node_tags(&md_yjs), vec!["paragraph"]);

        let txt = rows
            .iter()
            .find(|r| r.title.is_none())
            .expect("plain text keeps no title");
        assert_eq!(
            txt.content_text.as_deref(),
            Some("# My day\nSome **bold** text."),
            "plain text is never parsed as markdown"
        );
    }

    #[test]
    fn resolve_import_image_only_accepts_known_moment_ids() {
        let mut media = std::collections::HashMap::new();
        media.insert("ABC123".to_string(), "media-1".to_string());

        assert_eq!(
            resolve_import_image("dayone-moment://abc123", &media).as_deref(),
            Some("media-1"),
            "moment ids are matched case-insensitively"
        );
        assert_eq!(resolve_import_image("dayone-moment://NOPE", &media), None);
        // A video/audio moment has no photo row — dropped, see docs/LATER.md.
        assert_eq!(
            resolve_import_image("dayone-moment:/video/ABC123", &media).as_deref(),
            Some("media-1"),
            "path form resolves through the same id"
        );
        // Anything the editor would fetch from the network is dropped.
        assert_eq!(
            resolve_import_image("https://tracker.example/pixel.gif", &media),
            None
        );
        assert_eq!(resolve_import_image("javascript:alert(1)", &media), None);
        assert_eq!(resolve_import_image("../../etc/passwd", &media), None);
    }

    #[test]
    fn dedupes_markdown_folder_on_second_run() {
        use std::io::Write as _;

        let tmp = tempfile::tempdir().unwrap();
        let md_path = tmp.path().join("2024-05-15-hello.md");
        let mut f = std::fs::File::create(&md_path).unwrap();
        writeln!(
            f,
            "---\ntitle: Hello\ndate: 2024-05-15\n---\nFirst body paragraph."
        )
        .unwrap();

        let state = make_state();
        let ks = make_key_state();
        let first = import_data_inner(
            None,
            &state,
            &ks,
            tmp.path().to_string_lossy().to_string(),
            ImportFormat::MarkdownFolder,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(first.imported, 1);

        let second = import_data_inner(
            None,
            &state,
            &ks,
            tmp.path().to_string_lossy().to_string(),
            ImportFormat::MarkdownFolder,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(second.skipped_duplicates, 1, "second import sees dup");
        assert_eq!(second.imported, 0);

        let conn = state.lock().unwrap();
        assert_eq!(db::list_all_entries(&conn).unwrap().len(), 1);
    }

    #[test]
    fn replace_all_wipes_existing_entries() {
        let src = make_state();
        let sks = make_key_state();
        seed_entry(&src, &sks, "kept", "kept body", 1_700_000_000);

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("out.memlore.zip");
        export_data_inner(
            None,
            &src,
            &sks,
            zip_path.to_string_lossy().to_string(),
            ExportFormat::MemloreJson,
            ExportScope::All,
        )
        .unwrap();

        let dst = make_state();
        let dks = make_key_state();
        seed_entry(&dst, &dks, "will be wiped", "ancient body", 1_600_000_000);
        seed_entry(&dst, &dks, "also wiped", "other", 1_600_000_500);

        let summary = import_data_inner(
            None,
            &dst,
            &dks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::ReplaceAll,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 1);

        let conn = dst.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "only imported entry remains");
    }

    #[test]
    fn memlore_zip_replace_all_restores_complete_app_snapshot() {
        let src = make_state();
        let sks = make_key_state();
        let visible_id;
        let hidden_id;
        {
            let conn = src.lock().unwrap();
            let jid = db::list_journals(&conn, None).unwrap()[0].id.clone();
            db::set_setting(&conn, "ui_language", "vi").unwrap();
            db::set_setting(&conn, "default_search_mode", "semantic").unwrap();
            db::create_template(
                &conn,
                "Evening Review",
                Some("User template"),
                Some(b"template body"),
            )
            .unwrap();
            db::create_location_alias(&conn, "Home", "1 Backup Street", 10.25, 20.5, Some(42.0))
                .unwrap();
            db::create_reminder(&conn, "Write", "21:30", 127).unwrap();
            db::create_chat_session(&conn, "chat-1", "coach", "Be concise", "vi", 1_700_000_010)
                .unwrap();
            db::append_chat_message(
                &conn,
                "msg-1",
                "chat-1",
                "user",
                "Remember this thought",
                1_700_000_011,
            )
            .unwrap();

            visible_id = db::create_entry(
                &conn,
                db::CreateEntryParams {
                    journal_id: &jid,
                    title: Some("Visible"),
                    content_text: Some("visible body"),
                    preview_text: Some("visible body"),
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap()
            .id;
            hidden_id = db::create_entry(
                &conn,
                db::CreateEntryParams {
                    journal_id: &jid,
                    title: Some("Hidden"),
                    content_text: Some("hidden body"),
                    preview_text: Some("hidden body"),
                    entry_date: 1_700_000_100,
                },
            )
            .unwrap()
            .id;
            db::set_entry_locked(&conn, &visible_id, true).unwrap();
            db::set_entry_invisible(&conn, &hidden_id, true, Some("test-vault")).unwrap();
            db::set_entry_language(&conn, &visible_id, Some("vi")).unwrap();
            db::mark_entry_date_user_edited(&conn, &visible_id).unwrap();
        }

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("complete.memlore.zip");
        export_data_inner(
            None,
            &src,
            &sks,
            zip_path.to_string_lossy().to_string(),
            ExportFormat::MemloreJson,
            ExportScope::All,
        )
        .unwrap();

        let dst = make_state();
        let dks = make_key_state();
        let summary = import_data_inner(
            None,
            &dst,
            &dks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::ReplaceAll,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 2, "visible and invisible entries restore");

        let conn = dst.lock().unwrap();
        assert_eq!(
            db::get_setting(&conn, "ui_language").unwrap().as_deref(),
            Some("vi")
        );
        assert_eq!(
            db::get_setting(&conn, "default_search_mode")
                .unwrap()
                .as_deref(),
            Some("semantic")
        );

        let entries = db::list_all_entries(&conn).unwrap();
        assert_eq!(entries.len(), 2, "all non-deleted entries restored");
        let visible = entries.iter().find(|e| e.id == visible_id).unwrap();
        let hidden = entries.iter().find(|e| e.id == hidden_id).unwrap();
        assert!(visible.is_locked, "locked entry flag restored");
        assert_eq!(visible.content_language.as_deref(), Some("vi"));
        assert!(visible.entry_date_user_edited);
        assert!(hidden.is_invisible, "invisible entry flag restored");

        assert!(
            db::list_templates(&conn)
                .unwrap()
                .iter()
                .any(|t| t.name == "Evening Review"),
            "user templates restored"
        );
        assert_eq!(db::list_location_aliases(&conn).unwrap().len(), 1);
        assert_eq!(db::list_reminders(&conn).unwrap().len(), 1);
        let chat = db::load_chat_session(&conn, "chat-1").unwrap().unwrap();
        assert_eq!(chat.messages.len(), 1, "daily chat transcript restored");
    }

    /// The automatic pre-recovery backup (`write_complete_memlore_backup`
    /// with a db_key — Fix 4) is a manual escape hatch: if a recovery goes
    /// wrong, the user points Import → Replace All at the retained backup
    /// file. This proves that archive actually imports when the currently
    /// unlocked vault's db_key matches the one that encrypted it.
    #[test]
    fn memlore_zip_replace_all_restores_from_encrypted_recovery_backup() {
        let src = make_state();
        let sks = make_key_state();
        seed_entry(&src, &sks, "Recovered", "recovered body", 1_700_000_000);

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("memlore-recovery-123.memlore.zip");
        let db_key = sks.with_db_key(|k| Ok(*k)).unwrap();
        {
            let conn = src.lock().unwrap();
            crate::commands::export::write_complete_memlore_backup(
                &conn,
                &zip_path,
                &std::collections::HashMap::new(),
                Some(&db_key),
            )
            .unwrap();
        }

        // Sanity: the archive really is the encrypted variant.
        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(archive.by_name("full_snapshot.json").is_err());
        assert!(archive.by_name("full_snapshot.json.enc").is_ok());
        drop(archive);

        let dst = make_state();
        let dks = make_key_state(); // same fixture → same derived db_key as `sks`
        seed_entry(&dst, &dks, "will be wiped", "ancient body", 1_600_000_000);

        let summary = import_data_inner(
            None,
            &dst,
            &dks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::ReplaceAll,
            None,
        )
        .expect("encrypted recovery backup must import with the matching db_key");
        assert_eq!(summary.imported, 1);

        let conn = dst.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title.as_deref(), Some("Recovered"));
    }

    /// Wrong db_key must fail cleanly — no panic, and no partial restore
    /// (decryption happens before `import_full_snapshot_zip` opens its DB
    /// transaction, so a decrypt failure can't have mutated anything yet).
    #[test]
    fn memlore_zip_replace_all_wrong_key_fails_without_partial_restore() {
        let src = make_state();
        let sks = make_key_state();
        seed_entry(&src, &sks, "Recovered", "recovered body", 1_700_000_000);

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("memlore-recovery-456.memlore.zip");
        let db_key = sks.with_db_key(|k| Ok(*k)).unwrap();
        {
            let conn = src.lock().unwrap();
            crate::commands::export::write_complete_memlore_backup(
                &conn,
                &zip_path,
                &std::collections::HashMap::new(),
                Some(&db_key),
            )
            .unwrap();
        }

        let dst = make_state();
        let wrong_ks = EncryptionKeyState::new();
        wrong_ks
            .set_key(
                crate::utils::encryption::derive_encryption_key("different-pw", &[9u8; SALT_SIZE])
                    .unwrap(),
            )
            .unwrap();
        seed_entry(&dst, &wrong_ks, "kept", "must survive", 1_600_000_000);

        let result = import_data_inner(
            None,
            &dst,
            &wrong_ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::ReplaceAll,
            None,
        );
        assert!(result.is_err(), "wrong db_key must not decrypt");

        // No partial restore: the pre-existing local entry is untouched.
        let conn = dst.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title.as_deref(), Some("kept"));
    }

    #[test]
    fn split_frontmatter_parses_title_date_tags() {
        let src = "---\ntitle: My Day\ndate: 2024-01-02\ntags: [work, coffee]\n---\nHello body";
        let (fm, body) = split_frontmatter(src);
        let fm = fm.expect("frontmatter parsed");
        assert_eq!(fm.title.as_deref(), Some("My Day"));
        assert_eq!(fm.date, Some(1_704_153_600)); // 2024-01-02T00:00:00Z
        assert_eq!(fm.tags, vec!["work".to_string(), "coffee".to_string()]);
        assert_eq!(body.trim(), "Hello body");
    }

    #[test]
    fn parse_iso_date_accepts_date_only() {
        // 1970-01-01 → 0
        assert_eq!(parse_iso_date("1970-01-01"), Some(0));
        // 2024-01-15T11:50:45Z → 1_705_319_445
        assert_eq!(parse_iso_date("2024-01-15T11:50:45Z"), Some(1_705_319_445),);
    }

    #[test]
    fn parse_date_from_filename_extracts_leading_date() {
        assert_eq!(
            parse_date_from_filename("2024-05-15-title.md"),
            Some(1_715_731_200) // 2024-05-15T00:00:00Z
        );
        assert_eq!(parse_date_from_filename("no-date.md"), None);
    }

    /// Regression guard — non-ASCII input to `parse_iso_date` used to panic
    /// with "byte index N is not a char boundary" because the parser
    /// indexed a `&str` by raw bytes. The fix is an `is_ascii()` prefilter.
    #[test]
    fn parse_iso_date_rejects_non_ascii_without_panicking() {
        assert_eq!(parse_iso_date("\u{feff}2024-01-02"), None);
        assert_eq!(parse_iso_date("2024-01-02\u{feff}"), None);
        assert_eq!(parse_iso_date("héllo-01-02"), None);
    }

    #[test]
    fn merge_updates_existing_row_when_imported_updated_at_is_newer() {
        // Plan E3.7 calls for an explicit LWW update-path test: overlapping
        // (entry_date, content_text) where the imported row has a newer
        // `updated_at` must WIN (update the existing row in place).
        let src = make_state();
        let sks = make_key_state();
        // Seed source with one entry.
        seed_entry(&src, &sks, "import-title", "shared body", 1_700_000_000);
        // Bump its updated_at to a known-new value via raw SQL.
        {
            let conn = src.lock().unwrap();
            conn.execute("UPDATE entries SET updated_at = 9_999_999_999", [])
                .unwrap();
        }

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("newer.memlore.zip");
        export_data_inner(
            None,
            &src,
            &sks,
            zip_path.to_string_lossy().to_string(),
            ExportFormat::MemloreJson,
            ExportScope::All,
        )
        .unwrap();

        // Pre-populate dst with an older-updated entry sharing the dedup key.
        let dst = make_state();
        let dks = make_key_state();
        seed_entry(&dst, &dks, "local-title", "shared body", 1_700_000_000);
        // Record the existing row's id so we can assert the *same* row was
        // updated (LWW wins in place — no new row inserted).
        let (existing_id_before, existing_updated_before) = {
            let conn = dst.lock().unwrap();
            let rows = db::list_all_entries(&conn).unwrap();
            assert_eq!(rows.len(), 1);
            (rows[0].id.clone(), rows[0].updated_at)
        };
        assert!(existing_updated_before < 9_999_999_999);

        let summary = import_data_inner(
            None,
            &dst,
            &dks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 1, "LWW wins counts as imported");
        assert_eq!(summary.skipped_duplicates, 0);

        let conn = dst.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "no ghost row created");
        assert_eq!(rows[0].id, existing_id_before, "same row id updated");
        assert_eq!(
            rows[0].updated_at, 9_999_999_999,
            "updated_at bumped to imported value"
        );
    }

    #[test]
    fn merge_resurrects_soft_deleted_row_rather_than_creating_ghost() {
        let src = make_state();
        let sks = make_key_state();
        seed_entry(&src, &sks, "resurrect", "body", 1_700_000_000);
        {
            let conn = src.lock().unwrap();
            conn.execute("UPDATE entries SET updated_at = 9_000_000_000", [])
                .unwrap();
        }

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("resurrect.memlore.zip");
        export_data_inner(
            None,
            &src,
            &sks,
            zip_path.to_string_lossy().to_string(),
            ExportFormat::MemloreJson,
            ExportScope::All,
        )
        .unwrap();

        // Dst: seed the same (date, body), then soft-delete it.
        let dst = make_state();
        let dks = make_key_state();
        seed_entry(&dst, &dks, "kept-locally", "body", 1_700_000_000);
        let deleted_id = {
            let conn = dst.lock().unwrap();
            let id = db::list_all_entries(&conn).unwrap()[0].id.clone();
            db::soft_delete_entry(&conn, &id).unwrap();
            id
        };
        // Now `list_all_entries` should return nothing.
        {
            let conn = dst.lock().unwrap();
            assert_eq!(db::list_all_entries(&conn).unwrap().len(), 0);
        }

        let summary = import_data_inner(
            None,
            &dst,
            &dks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 1);

        // The soft-deleted row was resurrected — same id, is_deleted=0.
        let conn = dst.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "only the resurrected row exists");
        assert_eq!(rows[0].id, deleted_id, "same row id, not a ghost twin");
    }

    #[test]
    fn zip_slip_attempt_via_unsafe_media_id_is_rejected() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("slip.memlore.zip");
        let f = std::fs::File::create(&bad).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();

        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(br#"{"schema_version":2,"exported_at":"","app_version":"","entry_count":1,"journal_count":0,"tag_count":0,"media_count":1}"#).unwrap();
        zw.start_file("journals.json", opts).unwrap();
        zw.write_all(b"[]").unwrap();
        zw.start_file("tags.json", opts).unwrap();
        zw.write_all(b"[]").unwrap();

        // Entry references a media id containing a traversal fragment.
        zw.start_file("entries.jsonl", opts).unwrap();
        let line = r#"{"id":"e1","journal_id":"any","entry_date":1700000000,"created_at":1700000000,"updated_at":1700000000,"content_text":"slip","media":[{"id":"../etc/passwd","file_name":"x.png","mime_type":"image/png"}]}"#;
        zw.write_all(line.as_bytes()).unwrap();
        zw.write_all(b"\n").unwrap();
        zw.finish().unwrap();

        let state = make_state();
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            bad.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        // Entry itself imports; the media row surfaces an error.
        assert_eq!(summary.imported, 1);
        assert!(
            summary.errors.iter().any(|e| e.contains("unsafe media id")),
            "errors: {:?}",
            summary.errors
        );
    }

    // ─── Day One importer tests ───────────────────────────────────────────────

    #[test]
    fn dayone_import_parses_sample_fixture() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("dayone-sample.zip");

        let journal_json = r#"{
            "entries": [
                {
                    "uuid": "DAYONEENTRY001",
                    "text": "First Day One entry",
                    "creationDate": "2024-01-15T10:30:00Z",
                    "modifiedDate": "2024-01-15T11:00:00Z",
                    "isStarred": true,
                    "tags": ["work", "morning"],
                    "location": {
                        "latitude": 40.7128,
                        "longitude": -74.0060,
                        "placeName": "New York"
                    },
                    "weather": {
                        "conditionsDescription": "Sunny",
                        "weatherCode": "clear"
                    },
                    "photos": []
                },
                {
                    "uuid": "DAYONEENTRY002",
                    "text": "Second Day One entry",
                    "creationDate": "2024-01-16T09:00:00Z",
                    "isStarred": false,
                    "tags": [],
                    "photos": []
                },
                {
                    "uuid": "DAYONEENTRY003",
                    "text": "Third Day One entry",
                    "creationDate": "2024-01-17T08:00:00Z",
                    "isStarred": false,
                    "tags": [],
                    "photos": []
                }
            ]
        }"#;

        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("Journal.json", opts).unwrap();
        zw.write_all(journal_json.as_bytes()).unwrap();
        zw.finish().unwrap();

        let state = make_state();
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::DayOneZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();

        assert_eq!(
            summary.imported, 3,
            "all 3 entries should be imported; errors: {:?}",
            summary.errors
        );
        assert_eq!(summary.skipped_duplicates, 0);

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 3);

        let first = rows
            .iter()
            .find(|r| r.content_text.as_deref() == Some("First Day One entry"))
            .expect("first entry imported");
        assert!(first.is_favorite, "isStarred → is_favorite");
        assert!(
            (first.latitude.unwrap_or(0.0) - 40.7128).abs() < 1e-4,
            "latitude mapped"
        );
        assert!(
            (first.longitude.unwrap_or(0.0) - (-74.0060)).abs() < 1e-4,
            "longitude mapped"
        );

        let tags = db::get_tags_for_entry(&conn, &first.id).unwrap();
        let tag_names: Vec<&str> = tags.iter().map(|t| t.name.as_str()).collect();
        assert!(tag_names.contains(&"work"), "work tag imported");
        assert!(tag_names.contains(&"morning"), "morning tag imported");

        let yjs = db::get_entry_content(&conn, &first.id)
            .unwrap()
            .expect("Day One import must store a Yjs blob");
        assert!(!yjs.is_empty());
        assert_eq!(
            yjs_paragraph_texts(&yjs),
            vec!["First Day One entry".to_string()]
        );
    }

    #[test]
    fn dayone_import_converts_markdown_and_lifts_the_leading_heading() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("dayone-markdown.zip");

        // Shape of a real Day One export: title heading, escaped punctuation,
        // inline marks, a fenced block and a moment placeholder for the photo.
        let journal_json = r##"{
            "entries": [{
                "uuid": "DAYONEMD001",
                "text": "# Th\u1eed nghi\u1ec7m\n\n\u0110\u00e2y l\u00e0 n\u1ed9i **dung** xem `code` $1\\+1$\n\n![](dayone-moment://2916E16A)\n\n```\nThu nghiem code\n```",
                "creationDate": "2024-02-01T08:00:00Z",
                "isStarred": false,
                "tags": [],
                "photos": [{"identifier": "2916E16A", "md5": "abc123", "type": "jpeg"}]
            }]
        }"##;

        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("Journal.json", opts).unwrap();
        zw.write_all(journal_json.as_bytes()).unwrap();
        zw.start_file("photos/abc123.jpeg", opts).unwrap();
        zw.write_all(b"not-a-real-jpeg").unwrap();
        zw.finish().unwrap();

        let state = make_state();
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::DayOneZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 1, "errors: {:?}", summary.errors);

        let conn = state.lock().unwrap();
        let row = db::get_entry(&conn, "DAYONEMD001")
            .unwrap()
            .expect("entry imported");
        assert_eq!(
            row.title.as_deref(),
            Some("Thử nghiệm"),
            "leading heading becomes the title"
        );

        let content = row.content_text.unwrap_or_default();
        assert!(
            !content.contains('#') && !content.contains("**") && !content.contains("```"),
            "markdown syntax must not survive as text: {content}"
        );
        assert!(
            !content.contains("dayone-moment"),
            "moment placeholder must not survive as text: {content}"
        );
        assert!(content.contains("Đây là nội dung xem code"), "{content}");
        assert!(content.contains("$1+1$"), "escaped punctuation: {content}");
        assert!(content.contains("Thu nghiem code"), "{content}");

        let yjs = db::get_entry_content(&conn, "DAYONEMD001")
            .unwrap()
            .expect("Yjs blob stored");
        assert_eq!(
            yjs_node_tags(&yjs),
            vec!["paragraph", "image", "codeBlock"],
            "markdown blocks become editor nodes"
        );

        // The inline image must point at the media row the photo copy created.
        let media = db::get_media_for_entry(&conn, "DAYONEMD001").unwrap();
        assert_eq!(media.len(), 1, "photo copied");
        assert_eq!(
            media[0].id,
            dayone_media_id(
                "DAYONEMD001",
                &DayOnePhoto {
                    identifier: Some("2916E16A".to_string()),
                    md5: Some("abc123".to_string()),
                    photo_type: Some("jpeg".to_string()),
                }
            )
        );
    }

    #[test]
    fn dayone_import_rejects_unsupported_version() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        // Build a ZIP that mimics a Day One v1 plist export (no Journal.json).
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("dayone-v1.zip");
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("Journal.plist", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><plist></plist>")
            .unwrap();
        zw.finish().unwrap();

        let state = make_state();
        let ks = make_key_state();
        let err = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::DayOneZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap_err();
        assert!(
            err.contains("Unsupported Day One export version"),
            "expected unsupported-version error, got: {err}"
        );
    }

    // ─── Journey importer tests ───────────────────────────────────────────────

    #[test]
    fn journey_import_parses_sample_fixture() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-sample.zip");

        // Journey v2: one JSON file per entry. date_journal is in milliseconds.
        let entry1 = r#"{"id":"JE001","date_journal":1705320000000,"text":"Journey entry one","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        let entry2 = r#"{"id":"JE002","date_journal":1705406400000,"text":"Journey entry two","lat":51.5074,"lon":-0.1278,"photos":[],"tags":["london"]}"#;
        let entry3 = r#"{"id":"JE003","date_journal":1705492800000,"text":"Journey entry three","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;

        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("entry1.json", opts).unwrap();
        zw.write_all(entry1.as_bytes()).unwrap();
        zw.start_file("entry2.json", opts).unwrap();
        zw.write_all(entry2.as_bytes()).unwrap();
        zw.start_file("entry3.json", opts).unwrap();
        zw.write_all(entry3.as_bytes()).unwrap();
        zw.finish().unwrap();

        let state = make_state();
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();

        assert_eq!(
            summary.imported, 3,
            "all 3 entries should be imported; errors: {:?}",
            summary.errors
        );
        assert_eq!(summary.skipped_duplicates, 0);

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 3);

        // Verify date_journal ms → entry_date seconds conversion.
        let e1 = rows
            .iter()
            .find(|r| r.content_text.as_deref() == Some("Journey entry one"))
            .expect("entry one imported");
        assert_eq!(e1.entry_date, 1_705_320_000, "ms/1000 date mapping");

        // Verify lat/lon mapped; (0,0) means no location.
        let e2 = rows
            .iter()
            .find(|r| r.content_text.as_deref() == Some("Journey entry two"))
            .expect("entry two imported");
        assert!(e2.latitude.is_some(), "non-zero lat should be set");
        assert!(
            (e2.latitude.unwrap() - 51.5074).abs() < 1e-4,
            "latitude mapped"
        );
        assert!(e1.latitude.is_none(), "0,0 lat should be None");
    }

    #[test]
    fn journey_import_handles_no_photos() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-no-photos.zip");

        let entry = r#"{"id":"JEA","date_journal":1705320000000,"text":"Entry without photos","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;

        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("a.json", opts).unwrap();
        zw.write_all(entry.as_bytes()).unwrap();
        zw.finish().unwrap();

        let state = make_state();
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();

        assert_eq!(summary.imported, 1);
        assert!(summary.errors.is_empty(), "no errors: {:?}", summary.errors);
    }

    #[test]
    fn journey_photos_without_img_tags_are_attached() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-attach.zip");
        let entry = r#"{"id":"JEATT","date_journal":1705320000000,"text":"Plain photo entry","lat":0.0,"lon":0.0,"photos":["shot.jpg"],"tags":[]}"#;
        write_journey_zip_with_photos(&zip_path, &[entry], &[("photos/shot.jpg", b"jpeg-bytes")]);

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 1);
        assert!(summary.errors.is_empty(), "{:?}", summary.errors);

        let conn = state.lock().unwrap();
        let row = db::list_all_entries(&conn).unwrap().pop().expect("entry");
        let media = db::get_media_for_entry(&conn, &row.id).unwrap();
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].insertion_mode, "attached");
        let yjs = db::get_entry_content(&conn, &row.id).unwrap().expect("yjs");
        let tags = yjs_node_tags(&yjs);
        assert!(
            !tags.iter().any(|tag| tag == "image"),
            "photos with no <img> must not become inline nodes: {tags:?}"
        );
    }

    #[test]
    fn journey_img_photo_is_inline_and_extra_photo_is_attached() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-mixed.zip");
        let entry = r#"{"id":"JEMIX","date_journal":1705320000000,"text":"<p>hello</p><img src=\"photos/in.jpg\"><p>after</p>","lat":0.0,"lon":0.0,"photos":["in.jpg","extra.jpg"],"tags":[]}"#;
        write_journey_zip_with_photos(
            &zip_path,
            &[entry],
            &[
                ("photos/in.jpg", b"inline-jpeg"),
                ("photos/extra.jpg", b"attach-jpeg"),
            ],
        );

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 1);
        assert!(summary.errors.is_empty(), "{:?}", summary.errors);

        let conn = state.lock().unwrap();
        let row = db::list_all_entries(&conn).unwrap().pop().expect("entry");
        let media = db::get_media_for_entry(&conn, &row.id).unwrap();
        assert_eq!(media.len(), 2, "{media:?}");
        let modes: Vec<&str> = media.iter().map(|m| m.insertion_mode.as_str()).collect();
        assert!(
            modes.contains(&"inline") && modes.contains(&"attached"),
            "HTML <img> is inline; leftover photos array item is attached: {modes:?}"
        );
        let yjs = db::get_entry_content(&conn, &row.id).unwrap().expect("yjs");
        let tags = yjs_node_tags(&yjs);
        assert!(
            tags.iter().any(|tag| tag == "image"),
            "inline Journey photo must become an editor image node: {tags:?}"
        );
        let inline_id = media
            .iter()
            .find(|m| m.insertion_mode == "inline")
            .map(|m| m.id.as_str())
            .expect("inline row");
        assert!(
            tags.iter().any(|tag| tag == "image"),
            "inline id {inline_id} should be bound in yjs: {tags:?}"
        );
    }

    #[test]
    fn journey_import_skips_auxiliary_json_without_entry_fields() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-aux.zip");

        // A real entry plus an auxiliary JSON file with no entry fields.
        let real_entry = r#"{"id":"JE001","date_journal":1705320000000,"text":"Real entry","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        let aux_json = r#"{"version":"2.0","app":"Journey","schema":"metadata"}"#;

        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("entry1.json", opts).unwrap();
        zw.write_all(real_entry.as_bytes()).unwrap();
        zw.start_file("metadata.json", opts).unwrap();
        zw.write_all(aux_json.as_bytes()).unwrap();
        zw.finish().unwrap();

        let state = make_state();
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();

        assert_eq!(
            summary.imported, 1,
            "auxiliary JSON must not produce phantom entry; errors: {:?}",
            summary.errors
        );
    }

    #[test]
    fn dayone_import_rejects_unsafe_photo_extension() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("dayone-unsafe-photo.zip");

        // Entry with a photo whose photo_type contains path traversal.
        let journal_json = r#"{
            "entries": [{
                "uuid": "UNSAFE001",
                "text": "Entry with unsafe photo",
                "creationDate": "2024-01-15T10:30:00Z",
                "isStarred": false,
                "tags": [],
                "photos": [{"md5": "abc123", "type": "../evil"}]
            }]
        }"#;

        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("Journal.json", opts).unwrap();
        zw.write_all(journal_json.as_bytes()).unwrap();
        // No actual photo blob — copy_blob_from_zip silently skips absent blobs.
        zw.finish().unwrap();

        let state = make_state();
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::DayOneZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();

        // Entry itself should import; the photo should not produce a path-traversal file.
        assert_eq!(
            summary.imported, 1,
            "entry must import despite unsafe photo"
        );
        let conn = state.lock().unwrap();
        let media = db::get_media_for_entry(&conn, "UNSAFE001").unwrap();
        assert!(
            media.is_empty(),
            "no media row must be inserted for absent/unsafe photo blob"
        );
    }

    #[test]
    fn dayone_import_mergenewer_skips_duplicate_on_second_run() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let journal_json = r#"{
            "entries": [{
                "uuid": "DEDUP001",
                "text": "Dedup test entry",
                "creationDate": "2024-01-15T10:30:00Z",
                "isStarred": false,
                "tags": [],
                "photos": []
            }]
        }"#;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("dayone-dedup.zip");

        let make_zip = |path: &std::path::Path| {
            let f = std::fs::File::create(path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            zw.start_file("Journal.json", opts).unwrap();
            zw.write_all(journal_json.as_bytes()).unwrap();
            zw.finish().unwrap();
        };
        make_zip(&zip_path);

        let state = make_state();
        let ks = make_key_state();

        // First import.
        let s1 = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::DayOneZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(s1.imported, 1);
        assert_eq!(s1.skipped_duplicates, 0);

        // Second import of the same ZIP — must skip the duplicate.
        let s2 = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::DayOneZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(s2.imported, 0, "duplicate must be skipped on second run");
        assert_eq!(s2.skipped_duplicates, 1, "duplicate counter must increment");

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "exactly one entry in DB after two imports");
    }

    fn write_journey_zip(path: &std::path::Path, json_entries: &[&str]) {
        write_journey_zip_with_photos(path, json_entries, &[]);
    }

    fn write_journey_zip_with_photos(
        path: &std::path::Path,
        json_entries: &[&str],
        photos: &[(&str, &[u8])],
    ) {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let f = std::fs::File::create(path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        for (i, json) in json_entries.iter().enumerate() {
            zw.start_file(format!("entry{i}.json"), opts).unwrap();
            zw.write_all(json.as_bytes()).unwrap();
        }
        for (name, bytes) in photos {
            zw.start_file(*name, opts).unwrap();
            zw.write_all(bytes).unwrap();
        }
        zw.finish().unwrap();
    }

    /// Top-level node tags of an imported Yjs blob, in document order.
    fn yjs_node_tags(bytes: &[u8]) -> Vec<String> {
        use yrs::types::xml::XmlOut;
        use yrs::updates::decoder::Decode;
        use yrs::{Doc, Transact, Update, XmlFragment};

        let update = Update::decode_v1(bytes).expect("decode yjs update v1");
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update).expect("apply yjs update");
        }
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        fragment
            .children(&txn)
            .map(|child| match child {
                XmlOut::Element(el) => el.tag().to_string(),
                XmlOut::Text(_) => String::from("#text"),
                XmlOut::Fragment(_) => String::from("#fragment"),
            })
            .collect()
    }

    fn yjs_paragraph_texts(bytes: &[u8]) -> Vec<String> {
        use yrs::types::xml::XmlOut;
        use yrs::updates::decoder::Decode;
        use yrs::{Doc, GetString, Transact, Update, XmlFragment};

        let update = Update::decode_v1(bytes).expect("decode yjs update v1");
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update).expect("apply yjs update");
        }
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        fragment
            .children(&txn)
            .filter_map(|child| match child {
                XmlOut::Element(el) if el.tag().as_ref() == "paragraph" => {
                    let mut text = String::new();
                    for node in el.children(&txn) {
                        if let XmlOut::Text(t) = node {
                            text.push_str(&t.get_string(&txn));
                        }
                    }
                    Some(text)
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn journey_import_html_extracts_title_strips_tags_and_builds_yjs() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-html.zip");
        let entry = r#"{"id":"JEHTML","date_journal":1705320000000,"text":"<h1>Đám giỗ ngoại</h1><p dir=\"auto\">Hôm nay là tròn 3 năm.</p>","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        write_journey_zip(&zip_path, &[entry]);

        let state = make_state();
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 1, "errors: {:?}", summary.errors);

        let conn = state.lock().unwrap();
        let row = db::get_entry(&conn, "JEHTML")
            .unwrap()
            .expect("HTML Journey entry imported");
        assert_eq!(row.title.as_deref(), Some("Đám giỗ ngoại"));
        assert_eq!(row.content_text.as_deref(), Some("Hôm nay là tròn 3 năm."));
        assert_eq!(row.preview_text.as_deref(), Some("Hôm nay là tròn 3 năm."));

        let yjs = db::get_entry_content(&conn, "JEHTML")
            .unwrap()
            .expect("yjs_doc must be stored");
        assert!(!yjs.is_empty(), "yjs_doc must be non-empty");
        assert_eq!(
            yjs_paragraph_texts(&yjs),
            vec!["Hôm nay là tròn 3 năm.".to_string()]
        );
    }

    #[test]
    fn journey_import_plaintext_keeps_content_and_builds_yjs() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-plain.zip");
        let entry = r#"{"id":"JEPLAIN","date_journal":1705320000000,"text":"Journey entry one","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        write_journey_zip(&zip_path, &[entry]);

        let state = make_state();
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 1, "errors: {:?}", summary.errors);

        let conn = state.lock().unwrap();
        let row = db::get_entry(&conn, "JEPLAIN")
            .unwrap()
            .expect("plaintext Journey entry imported");
        assert_eq!(row.content_text.as_deref(), Some("Journey entry one"));
        let yjs = db::get_entry_content(&conn, "JEPLAIN")
            .unwrap()
            .expect("yjs_doc must be stored for plaintext Journey entries");
        assert!(!yjs.is_empty());
        let paras = yjs_paragraph_texts(&yjs);
        assert_eq!(paras, vec!["Journey entry one".to_string()]);
    }

    #[test]
    fn journey_import_html_decodes_amp_and_nbsp() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-entities.zip");
        let entry = r#"{"id":"JEENT","date_journal":1705320000000,"text":"<p>Tom &amp; Jerry&nbsp;ok</p>","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        write_journey_zip(&zip_path, &[entry]);

        let state = make_state();
        let ks = make_key_state();
        import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();

        let conn = state.lock().unwrap();
        let row = db::get_entry(&conn, "JEENT")
            .unwrap()
            .expect("entity Journey entry imported");
        let content = row.content_text.as_deref().unwrap_or("");
        assert!(
            content.contains("Tom & Jerry"),
            "must decode &amp; to &, got {content:?}"
        );
        assert!(
            content.contains("Jerry ok") || content.contains("Jerry\u{00a0}ok"),
            "must decode &nbsp; to a space (or nbsp), got {content:?}"
        );
        assert!(
            !content.contains("&amp;") && !content.contains("&nbsp;"),
            "raw entities must not remain, got {content:?}"
        );
    }

    #[test]
    fn journey_import_uses_requested_journal_id() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-journal.zip");
        let entry = r#"{"id":"JEJID","date_journal":1705320000000,"text":"Filed elsewhere","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        write_journey_zip(&zip_path, &[entry]);

        let state = make_state();
        let target_id = {
            let conn = state.lock().unwrap();
            db::create_journal(&conn, "Travel", None).unwrap().id
        };
        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            Some(target_id.clone()),
        )
        .unwrap();
        assert_eq!(summary.imported, 1, "errors: {:?}", summary.errors);

        let conn = state.lock().unwrap();
        let row = db::get_entry(&conn, "JEJID")
            .unwrap()
            .expect("entry imported into requested journal");
        assert_eq!(row.journal_id, target_id);
    }

    #[test]
    fn journey_import_unknown_journal_id_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-bad-journal.zip");
        let entry = r#"{"id":"JEBAD","date_journal":1705320000000,"text":"Should not import","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        write_journey_zip(&zip_path, &[entry]);

        let state = make_state();
        let ks = make_key_state();
        let err = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            Some("no-such-journal".to_string()),
        )
        .unwrap_err();
        assert!(
            err.contains("Journal not found"),
            "expected unknown-journal error, got: {err}"
        );
    }

    #[test]
    fn journey_import_rejects_deleted_journal_id() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-deleted-journal.zip");
        let entry = r#"{"id":"JEDEL","date_journal":1705320000000,"text":"Should not import","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        write_journey_zip(&zip_path, &[entry]);

        let state = make_state();
        let deleted_id = {
            let conn = state.lock().unwrap();
            let journal = db::create_journal(&conn, "Gone", None).unwrap();
            db::delete_journal(&conn, &journal.id).unwrap();
            journal.id
        };
        let ks = make_key_state();
        let err = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            Some(deleted_id),
        )
        .unwrap_err();
        assert!(
            err.contains("Journal not found"),
            "expected deleted-journal error, got: {err}"
        );
    }

    #[test]
    fn journey_import_heals_same_id_row_missing_yjs() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-heal.zip");
        let html = "<h1>Đám giỗ ngoại</h1><p dir=\"auto\">Hôm nay là tròn 3 năm.</p>";
        let entry = r#"{"id":"JEHEAL","date_journal":1705320000000,"text":"<h1>Đám giỗ ngoại</h1><p dir=\"auto\">Hôm nay là tròn 3 năm.</p>","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        write_journey_zip(&zip_path, &[entry]);

        let state = make_state();
        {
            let conn = state.lock().unwrap();
            let jid = db::list_journals(&conn, None).unwrap()[0].id.clone();
            let broken = ImportedEntry {
                id: "JEHEAL".into(),
                journal_id: jid.clone(),
                entry_date: 1_705_320_000,
                title: None,
                content_text: Some(html.to_string()),
                yjs_doc_b64: None,
                preview_text: Some(html.chars().take(160).collect()),
                emotion: None,
                location_label: None,
                location_address: None,
                weather_summary: None,
                weather_icon: None,
                latitude: None,
                longitude: None,
                is_favorite: false,
                created_at: 1_705_320_000,
                updated_at: 1_705_320_000,
                tags: Vec::new(),
                media: Vec::new(),
            };
            write_entry_row(&conn, "JEHEAL", &jid, &broken, false).unwrap();
        }

        let ks = make_key_state();
        let summary = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap();
        assert_eq!(summary.imported, 1, "errors: {:?}", summary.errors);

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "heal must overwrite, not twin");
        let row = db::get_entry(&conn, "JEHEAL")
            .unwrap()
            .expect("same Journey id reused");
        assert_eq!(row.title.as_deref(), Some("Đám giỗ ngoại"));
        assert_eq!(row.content_text.as_deref(), Some("Hôm nay là tròn 3 năm."));
        let yjs = db::get_entry_content(&conn, "JEHEAL")
            .unwrap()
            .expect("healed row must have yjs_doc");
        assert_eq!(
            yjs_paragraph_texts(&yjs),
            vec!["Hôm nay là tròn 3 năm.".to_string()]
        );
    }

    #[test]
    fn journey_reimport_resurrects_after_journal_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("journey-resurrect.zip");
        let entry = r#"{"id":"JERES","date_journal":1705320000000,"text":"Resurrect me","lat":0.0,"lon":0.0,"photos":[],"tags":[]}"#;
        write_journey_zip(&zip_path, &[entry]);

        let state = make_state();
        let dump_id = {
            let conn = state.lock().unwrap();
            db::create_journal(&conn, "Dump", None).unwrap().id
        };
        let ks = make_key_state();
        let first = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            Some(dump_id.clone()),
        )
        .unwrap();
        assert_eq!(first.imported, 1, "errors: {:?}", first.errors);

        let live_id = {
            let conn = state.lock().unwrap();
            db::delete_journal(&conn, &dump_id).unwrap();
            assert_eq!(
                db::list_all_entries(&conn).unwrap().len(),
                0,
                "deleted journal must hide its entries"
            );
            let tombstone = db::get_entry(&conn, "JERES")
                .unwrap()
                .expect("soft-deleted row must remain");
            assert!(tombstone.is_deleted);
            db::list_journals(&conn, None).unwrap()[0].id.clone()
        };

        let second = import_data_inner(
            None,
            &state,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::JourneyZip,
            ImportMode::MergeNewer,
            Some(live_id.clone()),
        )
        .unwrap();
        assert_eq!(
            second.imported, 1,
            "re-import after journal delete must resurrect, not skip; skipped={} errors={:?}",
            second.skipped_duplicates, second.errors
        );
        assert_eq!(second.skipped_duplicates, 0);

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "no twin; the tombstone must come back");
        assert_eq!(rows[0].id, "JERES");
        assert!(!rows[0].is_deleted);
        assert_eq!(rows[0].journal_id, live_id);
        assert_eq!(rows[0].content_text.as_deref(), Some("Resurrect me"));
    }

    #[test]
    fn zip_import_compresses_oversized_photo_with_configured_settings() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let tmp = tempfile::tempdir().unwrap();
        let png = test_png_bytes(3000, 1200);
        let zip_path = tmp.path().join("blobs.zip");
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            zw.start_file("photos/big.png", SimpleFileOptions::default())
                .unwrap();
            zw.write_all(&png).unwrap();
            zw.finish().unwrap();
        }
        let mut archive = ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();

        let state = make_state();
        let ks = make_key_state();
        seed_entry(&state, &ks, "host", "host", 1_700_000_000);
        let media_root = tempfile::tempdir().unwrap();
        let conn = state.lock().unwrap();
        // Aggressive, NOT the Standard fallback — so this asserts the DB
        // setting is actually read, not just that some preset ran.
        db::set_setting(&conn, "media_compression_mode", "aggressive").unwrap();
        let entry_id = db::list_all_entries(&conn).unwrap()[0].id.clone();
        let media_id = uuid::Uuid::new_v4().to_string();

        copy_blob_from_zip(
            &mut archive,
            media_root.path(),
            &conn,
            &entry_id,
            &media_id,
            "photos/big.png",
            &format!("{media_id}.png"),
            "image/png",
            "inline",
        )
        .expect("blob import must succeed");

        let row = db::get_media(&conn, &media_id).unwrap().unwrap();
        assert_eq!(
            row.file_type, "image/jpeg",
            "re-encode must update the mime"
        );
        assert_eq!(row.file_name, format!("{media_id}.jpg"));
        assert!(row.storage_path.ends_with(".jpg"));
        assert!(
            !media_root.path().join(format!("{media_id}.png")).exists(),
            "the uncompressed source must never be written"
        );
        let on_disk = std::fs::metadata(&row.storage_path).unwrap().len();
        assert_eq!(row.file_size, Some(on_disk as i64));
        // The stored file is resized to the CONFIGURED preset's long edge
        // (Aggressive = 1600, not the Standard fallback's 2400). Absolute byte
        // size is not asserted — a synthetic gradient PNG deflates better than
        // any JPEG re-encode of it.
        let stored = image::ImageReader::open(&row.storage_path)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap();
        assert_eq!(stored, (1600, 640));
    }

    #[test]
    fn stage_apple_resources_applies_configured_image_compression() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01_big.html"]);
        write_apple_entry(
            export.path(),
            "2024-03-01_big.html",
            "Big",
            &photo_card("Resources/big.png"),
        );
        fs::write(
            export.path().join("Resources/big.png"),
            test_png_bytes(3000, 1200),
        )
        .unwrap();

        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let expected_source_hash = scan.resources[0].sha256.clone();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(
            &scan,
            media_root.path(),
            AppleStagingLimits {
                compression: crate::utils::image_compression::CompressionMode::Aggressive,
                ..Default::default()
            },
        )
        .expect("staging must succeed");

        assert_eq!(staged.media.len(), 1);
        let item = &staged.media[0];
        assert_eq!(item.mime, "image/jpeg", "re-encode must update the mime");
        assert_eq!(item.storage_path.extension().unwrap(), "jpg");
        assert!(
            !media_root
                .path()
                .join(format!("{}.png", item.media_id))
                .exists(),
            "the pre-compression original must be removed"
        );
        assert_eq!(
            item.byte_len,
            fs::metadata(&item.storage_path).unwrap().len(),
            "byte_len feeds media.file_size — it must describe the stored file"
        );
        assert_eq!(
            item.sha256, expected_source_hash,
            "sha256 stays the source-provenance hash, not the stored bytes"
        );
        // Dimensions and thumbnail are read from the stored bytes, matching a
        // normal editor insert (Aggressive caps the long edge at 1600 px).
        assert_eq!(item.width, Some(1600));
        assert_eq!(item.height, Some(640));
        assert!(item.thumbnail_path.is_some());
    }

    /// A PNG whose pixels are pseudo-random, so deflate cannot shrink it and a
    /// JPEG re-encode genuinely wins. `test_png_bytes`' smooth gradient is the
    /// opposite case — it deflates smaller than any JPEG of it.
    fn noisy_png_bytes(width: u32, height: u32) -> Vec<u8> {
        use image::{ImageBuffer, ImageFormat, Rgb};
        use std::io::Cursor;
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, |_, _| {
            // xorshift64 — deterministic, no rng dependency.
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            Rgb([seed as u8, (seed >> 8) as u8, (seed >> 16) as u8])
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    fn test_png_bytes(width: u32, height: u32) -> Vec<u8> {
        use image::{ImageBuffer, ImageFormat, Rgb};
        use std::io::Cursor;
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    fn jpeg_with_exif_datetime(datetime: &str) -> Vec<u8> {
        use image::{ImageBuffer, ImageFormat, Rgb};
        use std::io::Cursor;
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(8, 6, |_, _| Rgb([20, 40, 60]));
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut jpeg), ImageFormat::Jpeg)
            .unwrap();

        let field = exif::Field {
            tag: exif::Tag::DateTimeOriginal,
            ifd_num: exif::In::PRIMARY,
            value: exif::Value::Ascii(vec![datetime.as_bytes().to_vec()]),
        };
        let mut writer = exif::experimental::Writer::new();
        writer.push_field(&field);
        let mut tiff = Cursor::new(Vec::new());
        writer.write(&mut tiff, false).expect("write EXIF TIFF");
        let tiff = tiff.into_inner();

        let mut app1 = Vec::new();
        app1.extend_from_slice(&[0xFF, 0xE1]);
        let payload_len = 2 + 6 + tiff.len();
        app1.extend_from_slice(&(payload_len as u16).to_be_bytes());
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&tiff);

        let mut out = Vec::with_capacity(2 + app1.len() + jpeg.len().saturating_sub(2));
        out.extend_from_slice(&[0xFF, 0xD8]);
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    fn write_apple_index(root: &Path, entry_files: &[&str]) {
        fs::create_dir_all(root.join("Entries")).unwrap();
        fs::create_dir_all(root.join("Resources")).unwrap();
        let links: String = entry_files
            .iter()
            .map(|name| format!(r#"<p><a href="Entries/{name}">{name}</a></p>"#))
            .collect();
        fs::write(
            root.join("index.html"),
            format!("<!DOCTYPE html><html><body>{links}</body></html>"),
        )
        .unwrap();
    }

    fn write_apple_entry(root: &Path, file_name: &str, title: &str, grid: &str) {
        fs::write(
            root.join("Entries").join(file_name),
            format!(
                r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title></head>
<body>
<div class="pageHeader">Monday, March 1, 2024</div>
<div class="assetGrid">{grid}</div>
<div class="title">{title}</div>
<div class="bodyText">synthetic body</div>
</body></html>
"#
            ),
        )
        .unwrap();
    }

    fn photo_card(src: &str) -> String {
        format!(
            r#"<div class="gridItem assetType_photo "><img class="asset_image" src="{src}"></div>"#
        )
    }

    fn video_card(src: &str) -> String {
        format!(
            r#"<div class="gridItem assetType_video "><video class="asset_video"><source src="{src}" type="video/mp4"></video></div>"#
        )
    }

    fn audio_card(src: &str) -> String {
        format!(
            r#"<div class="gridItem assetType_audio "><audio><source src="{src}" type="audio/wav"></audio></div>"#
        )
    }

    fn map_card(src: &str) -> String {
        format!(
            r#"<div class="gridItem assetType_map "><img class="asset_image" src="{src}"></div>"#
        )
    }

    fn live_card(src: &str) -> String {
        format!(
            r#"<div class="gridItem assetType_livephoto "><img class="asset_image" src="{src}"></div>"#
        )
    }

    fn sha256_file(path: &Path) -> String {
        let bytes = fs::read(path).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        hex::encode(hasher.finalize())
    }

    fn persist_staged(conn: &rusqlite::Connection, entry_id: &str, staged: &AppleStagedMedia) {
        db::insert_apple_imported_media(
            conn,
            db::AppleImportedMediaParams {
                id: &staged.media_id,
                entry_id,
                file_name: &staged.source_file_name,
                file_type: &staged.mime,
                storage_path: &staged.storage_path.to_string_lossy(),
                thumbnail_path: staged.thumbnail_path.as_ref().map(|p| p.to_str().unwrap()),
                file_size: Some(staged.byte_len as i64),
                sort_order: staged.sort_order,
                insertion_mode: staged.insertion_mode.as_str(),
                width: staged.width,
                height: staged.height,
                duration_seconds: staged.duration_seconds,
                exif_date: staged.capture_unix,
                exif_latitude: staged.exif_latitude,
                exif_longitude: staged.exif_longitude,
            },
        )
        .unwrap();
    }

    #[test]
    fn stage_apple_resources_image_video_audio_and_generic_attachment() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        let png = test_png_bytes(32, 24);
        fs::write(export.path().join("Resources/photo.png"), &png).unwrap();
        fs::write(export.path().join("Resources/clip.mov"), b"synthetic-mov").unwrap();
        fs::write(export.path().join("Resources/voice.wav"), b"synthetic-wav").unwrap();
        fs::write(export.path().join("Resources/notes.pdf"), b"%PDF-synthetic").unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Mixed",
            &format!(
                "{}{}{}{}",
                photo_card("../Resources/photo.png"),
                video_card("../Resources/clip.mov"),
                audio_card("../Resources/voice.wav"),
                photo_card("../Resources/notes.pdf"),
            ),
        );

        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect("stage");
        assert_eq!(staged.media.len(), 4);
        assert_eq!(staged.media[0].mime, "image/png");
        assert_eq!(
            staged.media[0].insertion_mode,
            AppleStagedInsertionMode::Attached
        );
        assert_eq!(staged.media[0].sort_order, 0);
        assert_eq!(staged.media[0].width, Some(32));
        assert_eq!(staged.media[0].height, Some(24));
        assert!(
            staged.media[0].thumbnail_path.is_some(),
            "PNG should get a thumbnail"
        );
        assert_eq!(staged.media[1].mime, "video/quicktime");
        assert_eq!(
            staged.media[1].insertion_mode,
            AppleStagedInsertionMode::Attached
        );
        assert_eq!(staged.media[1].sort_order, 1);
        assert_eq!(staged.media[2].mime, "audio/wav");
        assert_eq!(staged.media[2].sort_order, 2);
        assert_eq!(staged.media[3].mime, "application/octet-stream");
        assert_eq!(
            staged.media[3].insertion_mode,
            AppleStagedInsertionMode::Attached
        );
        assert!(
            staged.media[3]
                .warnings
                .iter()
                .any(|w| { w.kind == AppleStagingWarningKind::UnknownReferencedAttachment }),
            "unknown referenced file is an attachment warning: {:?}",
            staged.media[3].warnings
        );
        assert!(
            staged
                .warnings
                .iter()
                .any(|w| { w.kind == AppleStagingWarningKind::UnknownReferencedAttachment }),
            "top-level staging warnings include attachment accounting: {:?}",
            staged.warnings
        );

        let state = make_state();
        let locked = state.lock().unwrap();
        let jid = db::list_journals(&locked, None).unwrap()[0].id.clone();
        let eid = db::create_entry(
            &locked,
            db::CreateEntryParams {
                journal_id: &jid,
                title: Some("Mixed"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap()
        .id;
        for item in &staged.media {
            persist_staged(&locked, &eid, item);
        }
        let rows = db::get_media_for_entry(&locked, &eid).unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].file_type, "image/png");
        assert_eq!(rows[1].file_type, "video/quicktime");
        assert_eq!(rows[2].file_type, "audio/wav");
        assert!(
            rows.iter().all(|m| m.insertion_mode == "attached"),
            "Apple Journal media is always attached: {rows:?}"
        );
        assert!(rows.iter().all(|m| m.upload_status == "pending"));
    }

    #[test]
    fn stage_apple_resources_heic_keeps_original_without_thumbnail() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        let heic = b"ftypheic-synthetic-original";
        fs::write(export.path().join("Resources/still.heic"), heic).unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "HEIC",
            &live_card("../Resources/still.heic"),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect("stage");
        assert_eq!(staged.media.len(), 1);
        assert_eq!(staged.media[0].mime, "image/heic");
        assert!(staged.media[0].thumbnail_path.is_none());
        assert!(
            staged.media[0]
                .warnings
                .iter()
                .any(|w| w.kind == AppleStagingWarningKind::NoThumbnail),
            "HEIC must take the no-thumbnail warning path: {:?}",
            staged.media[0].warnings
        );
        let dest = &staged.media[0].storage_path;
        assert_eq!(fs::read(dest).unwrap(), heic);
        assert_eq!(staged.media[0].sha256, scan.resources[0].sha256);
    }

    #[test]
    fn stage_apple_resources_video_over_upload_cap_still_imports_locally() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        let video = vec![0xABu8; 4096];
        fs::write(export.path().join("Resources/clip.mov"), &video).unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Big video",
            &video_card("../Resources/clip.mov"),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(
            &scan,
            media_root.path(),
            AppleStagingLimits {
                photo_upload_bytes: Some(1024),
                video_upload_bytes: Some(1024),
                ..Default::default()
            },
        )
        .expect("local import must succeed over the upload cap");
        assert_eq!(staged.media.len(), 1);
        assert!(staged.media[0].exceeds_video_upload_limit);
        assert!(!staged.media[0].exceeds_photo_upload_limit);
        assert_eq!(fs::read(&staged.media[0].storage_path).unwrap(), video);
        assert!(
            staged.media[0]
                .warnings
                .iter()
                .any(|w| { w.kind == AppleStagingWarningKind::ExceedsVideoUploadLimit }),
            "upload-size constraint is reported separately: {:?}",
            staged.media[0].warnings
        );
    }

    #[test]
    fn stage_apple_resources_byte_hash_matches_scan_and_source_order() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        fs::write(
            export.path().join("Resources/a.png"),
            test_png_bytes(16, 16),
        )
        .unwrap();
        fs::write(export.path().join("Resources/b.mov"), b"second-bytes").unwrap();
        fs::write(export.path().join("Resources/c.wav"), b"third-bytes").unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Order",
            &format!(
                "{}{}{}",
                photo_card("../Resources/a.png"),
                video_card("../Resources/b.mov"),
                audio_card("../Resources/c.wav"),
            ),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect("stage");
        assert_eq!(
            staged
                .media
                .iter()
                .map(|m| (m.source_stem.as_str(), m.sort_order))
                .collect::<Vec<_>>(),
            vec![("a", 0), ("b", 1), ("c", 2)]
        );
        for item in &staged.media {
            let expected = scan
                .resources
                .iter()
                .find(|r| r.stem == item.source_stem)
                .expect("resource")
                .sha256
                .clone();
            assert_eq!(item.sha256, expected);
            assert_eq!(sha256_file(&item.storage_path), expected);
        }
    }

    #[test]
    fn stage_apple_resources_sidecar_wins_over_exif_and_records_disagreement() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        let jpeg = jpeg_with_exif_datetime("2023:06:15 14:30:00");
        fs::write(export.path().join("Resources/photo.jpg"), &jpeg).unwrap();
        // Sidecar Apple date far from EXIF: unix 1_700_000_000 → apple seconds.
        let apple_seconds =
            1_700_000_000.0 - crate::import_apple_journal::APPLE_REFERENCE_DATE_UNIX_SECONDS;
        fs::write(
            export.path().join("Resources/photo.json"),
            format!(r#"{{"date":{apple_seconds}}}"#),
        )
        .unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Dates",
            &photo_card("../Resources/photo.jpg"),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect("stage");
        assert_eq!(staged.media.len(), 1);
        assert_eq!(
            staged.media[0].capture_provenance,
            AppleCaptureDateProvenance::Sidecar
        );
        assert_eq!(staged.media[0].capture_unix, Some(1_700_000_000));
        assert!(
            staged.media[0]
                .warnings
                .iter()
                .any(|w| { w.kind == AppleStagingWarningKind::CaptureDateDisagreement }),
            "sidecar vs EXIF must be a warning: {:?}",
            staged.media[0].warnings
        );
    }

    #[test]
    fn stage_apple_resources_unsupported_decode_keeps_original() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        let garbage = b"not-a-real-png-payload";
        fs::write(export.path().join("Resources/broken.png"), garbage).unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Broken",
            &photo_card("../Resources/broken.png"),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect("stage");
        assert_eq!(fs::read(&staged.media[0].storage_path).unwrap(), garbage);
        assert!(staged.media[0].thumbnail_path.is_none());
        assert!(
            staged.media[0]
                .warnings
                .iter()
                .any(|w| w.kind == AppleStagingWarningKind::UnsupportedDecode),
            "decode failure is a warning: {:?}",
            staged.media[0].warnings
        );
    }

    #[test]
    fn stage_apple_resources_shared_file_gets_entry_scoped_ids() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html", "2024-03-02.html"]);
        fs::write(
            export.path().join("Resources/shared.png"),
            test_png_bytes(12, 12),
        )
        .unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "First",
            &photo_card("../Resources/shared.png"),
        );
        write_apple_entry(
            export.path(),
            "2024-03-02.html",
            "Second",
            &photo_card("../Resources/shared.png"),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect("stage");
        assert_eq!(staged.media.len(), 2);
        assert_ne!(staged.media[0].media_id, staged.media[1].media_id);
        assert_ne!(staged.media[0].storage_path, staged.media[1].storage_path);
        assert_eq!(staged.media[0].sha256, staged.media[1].sha256);
        assert_ne!(
            staged.media[0].entry_relative_path,
            staged.media[1].entry_relative_path
        );
    }

    #[test]
    fn stage_apple_resources_orphans_are_retained_not_assigned() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        fs::write(
            export.path().join("Resources/used.png"),
            test_png_bytes(8, 8),
        )
        .unwrap();
        fs::write(export.path().join("Resources/orphan.bin"), b"left-behind").unwrap();
        fs::write(export.path().join("Resources/.DS_Store"), b"system").unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Used",
            &photo_card("../Resources/used.png"),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        assert!(
            scan.unreferenced_resources
                .iter()
                .all(|r| r.stem != ".DS_Store"),
            "scanner must exclude filesystem metadata"
        );
        assert_eq!(scan.unreferenced_resources.len(), 1);
        assert_eq!(scan.unreferenced_resources[0].stem, "orphan");
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect("unreferenced binaries must not block staging");
        assert_eq!(staged.media.len(), 1, "only referenced media is staged");
        assert_eq!(staged.media[0].source_stem, "used");
        assert!(
            export.path().join("Resources/orphan.bin").is_file(),
            "unreferenced binary stays in the source archive"
        );
        assert!(
            !staged.media.iter().any(|item| item.source_stem == "orphan"),
            "orphan must not be assigned to an entry"
        );
    }

    #[test]
    fn stage_apple_resources_disk_failure_cleans_owned_files() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        fs::write(
            export.path().join("Resources/first.png"),
            test_png_bytes(10, 10),
        )
        .unwrap();
        fs::write(
            export.path().join("Resources/second.png"),
            test_png_bytes(11, 11),
        )
        .unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Two",
            &format!(
                "{}{}",
                photo_card("../Resources/first.png"),
                photo_card("../Resources/second.png"),
            ),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        fs::remove_file(export.path().join("Resources/second.png")).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let err = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect_err("missing source after scan must fail");
        assert!(
            matches!(err, AppleStagingError::Io { .. }),
            "disk/source failure: {err}"
        );
        let leftover: Vec<_> = walkdir_files(media_root.path());
        assert!(
            leftover.is_empty(),
            "owned staged files must be cleaned up: {leftover:?}"
        );
    }

    #[test]
    fn stage_apple_resources_originals_survive_source_folder_removal() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        let png = test_png_bytes(20, 14);
        fs::write(export.path().join("Resources/keep.png"), &png).unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Keep",
            &photo_card("../Resources/keep.png"),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let expected = scan.resources[0].sha256.clone();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect("stage");
        drop(export);
        assert_eq!(fs::read(&staged.media[0].storage_path).unwrap(), png);
        assert_eq!(sha256_file(&staged.media[0].storage_path), expected);
    }

    #[test]
    fn stage_apple_resources_keeps_map_snapshot_and_does_not_pair_a_movie() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        fs::write(
            export.path().join("Resources/map.png"),
            test_png_bytes(18, 18),
        )
        .unwrap();
        fs::write(
            export.path().join("Resources/map.json"),
            r#"{"date":1,"placeName":"Park","visits":[{"placeName":"Park","latitude":10.0,"longitude":106.0,"city":"Saigon"}]}"#,
        )
        .unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Map",
            &map_card("../Resources/map.png"),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect("stage");
        assert_eq!(staged.media.len(), 1);
        assert_eq!(staged.media[0].source_stem, "map");
        assert_eq!(staged.media[0].mime, "image/png");
        assert_eq!(
            staged.media[0].insertion_mode,
            AppleStagedInsertionMode::Attached
        );
        assert!(
            !media_root.path().read_dir().unwrap().any(|e| e
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "mov" || ext == "mp4")),
            "must not invent a companion movie"
        );
    }

    fn walkdir_files(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    out.extend(walkdir_files(&path));
                } else {
                    out.push(path);
                }
            }
        }
        out
    }

    fn set_media_root(state: &AppState, path: &Path) {
        let conn = state.lock().unwrap();
        db::set_setting(&conn, "media_root_path", path.to_str().unwrap()).unwrap();
    }

    fn default_journal_id(state: &AppState) -> String {
        let conn = state.lock().unwrap();
        db::list_journals(&conn, None).unwrap()[0].id.clone()
    }

    fn write_minimal_apple_export(root: &Path, title: &str) {
        write_apple_index(root, &["2024-03-01.html"]);
        fs::write(root.join("Resources/photo.png"), test_png_bytes(16, 12)).unwrap();
        fs::write(
            root.join("Resources/photo.json"),
            r#"{"date":1,"placeName":"Park","visits":[{"placeName":"Park","latitude":10.5,"longitude":106.7,"city":"Saigon"}]}"#,
        )
        .unwrap();
        write_apple_entry(
            root,
            "2024-03-01.html",
            title,
            &format!(
                "{}{}",
                photo_card("../Resources/photo.png"),
                map_card("../Resources/photo.png"),
            ),
        );
    }

    #[test]
    fn apple_journal_import_requires_unlock() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Locked");
        let state = make_state();
        let ks = EncryptionKeyState::new();
        let err = import_data_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            ImportFormat::AppleJournalFolder,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap_err();
        assert!(
            err.contains("locked") || err.contains("Encryption key"),
            "unlock gate must reject Apple import: {err}"
        );
    }

    #[test]
    fn apple_journal_import_rejects_replace_all() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Replace");
        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        seed_entry(&state, &ks, "keep me", "existing body", 1_700_000_000);

        let err = import_data_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            ImportFormat::AppleJournalFolder,
            ImportMode::ReplaceAll,
            None,
        )
        .unwrap_err();
        assert!(
            err.to_lowercase().contains("replace"),
            "ReplaceAll must be rejected for Apple Journal: {err}"
        );

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(
            rows.len(),
            1,
            "existing entry must survive rejected ReplaceAll"
        );
        assert_eq!(rows[0].title.as_deref(), Some("keep me"));
    }

    #[test]
    fn apple_journal_preflight_failure_leaves_existing_data() {
        let export = tempfile::tempdir().unwrap();
        fs::write(export.path().join("not-an-export.txt"), b"nope").unwrap();

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        seed_entry(&state, &ks, "keep me", "existing body", 1_700_000_000);
        let before = {
            let conn = state.lock().unwrap();
            (
                db::list_all_entries(&conn).unwrap().len(),
                db::count_media(&conn).unwrap(),
            )
        };

        let err = import_data_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            ImportFormat::AppleJournalFolder,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap_err();
        assert!(
            err.to_lowercase().contains("entries") || err.to_lowercase().contains("preflight"),
            "missing Entries must fail preflight: {err}"
        );

        let conn = state.lock().unwrap();
        assert_eq!(db::list_all_entries(&conn).unwrap().len(), before.0);
        assert_eq!(db::count_media(&conn).unwrap(), before.1);
        assert!(
            walkdir_files(media_root.path()).is_empty(),
            "failed preflight must not leave staged media"
        );
    }

    #[test]
    fn apple_journal_persist_failure_rolls_back_and_cleans_files() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Rollback");

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        seed_entry(&state, &ks, "keep me", "existing body", 1_700_000_000);

        let prepared = prepare_apple_journal_import(
            export.path(),
            media_root.path(),
            AppleStagingLimits::default(),
        )
        .expect("preflight/stage must succeed");
        assert!(
            prepared
                .owned_files
                .iter()
                .any(|p| p.exists() && !is_apple_import_manifest(p)),
            "staging must create media files before persist"
        );
        assert!(
            prepared.manifest_path.exists(),
            "staged manifest must be written for cleanup"
        );

        let persist_err = {
            let conn = state.lock().unwrap();
            persist_apple_journal_import(&conn, "missing-journal-id", &prepared, &mut Vec::new())
                .unwrap_err()
        };
        cleanup_apple_import_operation(&prepared);

        assert!(
            !persist_err.is_empty(),
            "persist into a missing journal must fail"
        );
        let remaining: Vec<_> = walkdir_files(media_root.path())
            .into_iter()
            .filter(|p| !is_apple_import_manifest(p))
            .collect();
        assert!(
            remaining.is_empty(),
            "this operation's staged files must be removed: {remaining:?}"
        );
        assert!(
            prepared.manifest_path.exists(),
            "manifest must be retained after interrupted/failed persist"
        );

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "rolled-back import must not add entries");
        assert_eq!(rows[0].title.as_deref(), Some("keep me"));
        assert_eq!(db::count_media(&conn).unwrap(), 0);
    }

    #[test]
    fn apple_journal_import_writes_entry_media_location_and_report() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Imported day");

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let journal_id = default_journal_id(&state);

        let summary = import_data_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            ImportFormat::AppleJournalFolder,
            ImportMode::MergeNewer,
            Some(journal_id),
        )
        .expect("apple import");
        assert_eq!(summary.imported, 1);
        assert_eq!(summary.skipped_duplicates, 0);
        let apple = summary.apple.expect("additive apple report");
        assert_eq!(apple.entries_imported, 1);
        assert!(apple.resources_imported >= 1);
        assert!(
            apple.resources_referenced >= apple.resources_imported,
            "referenced must cover imported"
        );

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title.as_deref(), Some("Imported day"));
        assert!(
            rows[0].entry_date_user_edited,
            "imported Apple date must be marked user-edited"
        );
        assert_eq!(rows[0].latitude, Some(10.5));
        assert_eq!(rows[0].longitude, Some(106.7));
        assert_eq!(rows[0].location_label.as_deref(), Some("Park"));
        let media = db::get_media_for_entry(&conn, &rows[0].id).unwrap();
        assert!(!media.is_empty(), "staged originals must be persisted");
        assert!(media.iter().all(|m| m.upload_status == "pending"));
        assert!(
            media.iter().all(|m| m.insertion_mode == "attached"),
            "Apple Journal media must be attachments: {:?}",
            media.iter().map(|m| &m.insertion_mode).collect::<Vec<_>>()
        );
        let yjs = db::get_entry_content(&conn, &rows[0].id)
            .unwrap()
            .expect("imported entry must have a yjs_doc");
        let tags = yjs_node_tags(&yjs);
        assert!(
            !tags
                .iter()
                .any(|tag| matches!(tag.as_str(), "image" | "video" | "audio")),
            "found Apple Journal media must not become inline editor nodes: {tags:?}"
        );
    }

    #[test]
    fn apple_journal_second_identical_import_adds_zero_entries_and_zero_media() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Retry day");

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let journal_id = default_journal_id(&state);

        let first = import_apple(&state, &ks, export.path(), Some(journal_id.clone()));
        assert_eq!(first.imported, 1);
        assert_eq!(first.skipped_duplicates, 0);
        let first_media = {
            let conn = state.lock().unwrap();
            db::count_media(&conn).unwrap()
        };
        assert!(first_media >= 1, "first import must persist media");

        let second = import_apple(&state, &ks, export.path(), Some(journal_id));
        assert_eq!(second.imported, 0, "exact retry must not add entries");
        assert_eq!(
            second.skipped_duplicates, 1,
            "exact retry must count the committed entry as skipped"
        );
        let apple = second.apple.expect("apple report");
        assert_eq!(apple.entries_imported, 0);
        assert_eq!(apple.resources_imported, 0);

        let conn = state.lock().unwrap();
        assert_eq!(db::list_all_entries(&conn).unwrap().len(), 1);
        assert_eq!(
            db::count_media(&conn).unwrap(),
            first_media,
            "exact retry must not add extra media rows"
        );
    }

    #[test]
    fn apple_journal_distinct_photo_only_entries_stay_distinct() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01-a.html", "2024-03-01-b.html"]);
        fs::write(
            export.path().join("Resources/photo-a.png"),
            test_png_bytes(16, 12),
        )
        .unwrap();
        fs::write(
            export.path().join("Resources/photo-b.png"),
            test_png_bytes(20, 14),
        )
        .unwrap();
        write_apple_photo_only_entry(
            export.path(),
            "2024-03-01-a.html",
            "../Resources/photo-a.png",
        );
        write_apple_photo_only_entry(
            export.path(),
            "2024-03-01-b.html",
            "../Resources/photo-b.png",
        );

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());

        let summary = import_apple(&state, &ks, export.path(), None);
        assert_eq!(
            summary.imported, 2,
            "same-day empty-text photo entries must stay distinct"
        );
        assert_eq!(summary.skipped_duplicates, 0);

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(db::count_media(&conn).unwrap(), 2);
        assert!(
            rows.iter().all(|row| {
                row.content_text.as_deref().unwrap_or("").trim().is_empty()
                    || db::get_media_for_entry(&conn, &row.id)
                        .unwrap()
                        .iter()
                        .any(|m| m.file_type.starts_with("image/"))
            }),
            "both rows must be photo-only (empty text and/or image media)"
        );
    }

    #[test]
    fn apple_journal_fingerprint_is_scoped_to_destination_journal() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Scoped");

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let journal_a = default_journal_id(&state);
        let journal_b = {
            let conn = state.lock().unwrap();
            db::create_journal(&conn, "Other journal", None).unwrap().id
        };

        let first = import_apple(&state, &ks, export.path(), Some(journal_a.clone()));
        assert_eq!(first.imported, 1);

        let second = import_apple(&state, &ks, export.path(), Some(journal_b.clone()));
        assert_eq!(
            second.imported, 1,
            "the same source must import into a different journal"
        );
        assert_eq!(second.skipped_duplicates, 0);

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        let in_a = rows.iter().filter(|r| r.journal_id == journal_a).count();
        let in_b = rows.iter().filter(|r| r.journal_id == journal_b).count();
        assert_eq!(in_a, 1);
        assert_eq!(in_b, 1);
    }

    #[test]
    fn apple_journal_exact_retry_does_not_replace_edited_or_locked_entry() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Keep me");

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let journal_id = default_journal_id(&state);

        import_apple(&state, &ks, export.path(), Some(journal_id.clone()));
        let (entry_id, original_media) = {
            let conn = state.lock().unwrap();
            let row = db::list_all_entries(&conn).unwrap().remove(0);
            let media = db::count_media(&conn).unwrap();
            db::update_entry(
                &conn,
                &row.id,
                Some("Edited title"),
                Some("user edited body"),
                Some("user edited body"),
            )
            .unwrap();
            db::set_entry_locked(&conn, &row.id, true).unwrap();
            (row.id, media)
        };

        let retry = import_apple(&state, &ks, export.path(), Some(journal_id));
        assert_eq!(retry.imported, 0);
        assert_eq!(retry.skipped_duplicates, 1);

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "must not add a replacement row");
        assert_eq!(rows[0].id, entry_id);
        assert_eq!(rows[0].title.as_deref(), Some("Edited title"));
        assert_eq!(rows[0].content_text.as_deref(), Some("user edited body"));
        assert!(rows[0].is_locked, "lock must survive exact retry");
        assert_eq!(db::count_media(&conn).unwrap(), original_media);
    }

    #[test]
    fn apple_journal_changed_source_creates_reported_entry_without_replacing() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Original");

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let journal_id = default_journal_id(&state);

        import_apple(&state, &ks, export.path(), Some(journal_id.clone()));
        let (original_id, original_title) = {
            let conn = state.lock().unwrap();
            let row = db::list_all_entries(&conn).unwrap().remove(0);
            db::update_entry(
                &conn,
                &row.id,
                Some("User rewrite"),
                Some("keep this local edit"),
                Some("keep this local edit"),
            )
            .unwrap();
            db::set_entry_locked(&conn, &row.id, true).unwrap();
            (row.id, row.title.clone())
        };
        assert_eq!(original_title.as_deref(), Some("Original"));

        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Changed source",
            &format!(
                "{}{}",
                photo_card("../Resources/photo.png"),
                map_card("../Resources/photo.png"),
            ),
        );

        let changed = import_apple(&state, &ks, export.path(), Some(journal_id));
        assert_eq!(
            changed.imported, 1,
            "changed source must create a new entry"
        );
        assert_eq!(changed.skipped_duplicates, 0);
        let apple = changed.apple.expect("apple report");
        assert_eq!(apple.entries_imported, 1);
        assert!(
            changed.warnings.iter().any(|w| w.kind == "source_changed"),
            "changed source must be reported: {:?}",
            changed.warnings
        );

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        let original = rows.iter().find(|r| r.id == original_id).expect("original");
        assert_eq!(original.title.as_deref(), Some("User rewrite"));
        assert_eq!(
            original.content_text.as_deref(),
            Some("keep this local edit")
        );
        assert!(original.is_locked);
        assert!(
            rows.iter()
                .any(|r| r.id != original_id && r.title.as_deref() == Some("Changed source")),
            "new row must carry the changed source"
        );
    }

    #[test]
    fn apple_import_warning_kinds_serialize_as_snake_case() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-06-15.html"]);
        fs::write(
            export.path().join("Resources/still.heic"),
            b"ftypheic-synthetic-original",
        )
        .unwrap();
        fs::write(
            export.path().join("Entries/2024-06-15.html"),
            format!(
                r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title>
<style>
span.sPaint {{color: #c41e3a}}
</style>
</head>
<body>
<div class="pageHeader">Saturday, June 14, 2024</div>
<div class="assetGrid">{}</div>
<div class="title">Kinds</div>
<div class="bodyText"><span class="sPaint">painted</span></div>
</body></html>
"#,
                live_card("../Resources/still.heic")
            ),
        )
        .unwrap();

        let media_root = tempfile::tempdir().unwrap();
        let prepared = prepare_apple_journal_import(
            export.path(),
            media_root.path(),
            AppleStagingLimits::default(),
        )
        .expect("prepare");
        let summary = ImportSummary {
            imported: 0,
            skipped_duplicates: 0,
            errors: Vec::new(),
            warnings: prepared.warnings.clone(),
            apple: Some(AppleImportReport {
                entries_imported: 0,
                entries_failed: 0,
                resources_referenced: prepared.resources_referenced,
                resources_imported: 0,
                resources_missing: prepared.resources_missing,
                resources_unsupported: prepared.resources_unsupported,
                resources_unreferenced: prepared.resources_unreferenced,
                entries_skipped_exact: 0,
                entries_source_changed: 0,
            }),
        };
        let json = serde_json::to_string(&summary).expect("serialize ImportSummary");
        for kind in ["no_thumbnail", "header_filename_conflict", "preserved_only"] {
            assert!(
                json.contains(&format!("\"kind\":\"{kind}\"")),
                "ImportSummary must emit snake_case {kind}: {json}"
            );
        }
        for forbidden in [
            "NoThumbnail",
            "HeaderFilenameConflict",
            "PreservedOnly",
            "UnsupportedDecode",
        ] {
            assert!(
                !json.contains(forbidden),
                "ImportSummary must not emit PascalCase {forbidden}: {json}"
            );
        }

        let mapped = [
            AppleStagingWarningKind::NoThumbnail.as_import_kind(),
            AppleStagingWarningKind::UnsupportedDecode.as_import_kind(),
            AppleStagingWarningKind::ExceedsVideoUploadLimit.as_import_kind(),
            crate::import_apple_journal::AppleDateWarningKind::HeaderFilenameConflict
                .as_import_kind(),
            crate::import_apple_journal::AppleConversionKind::PreservedOnly.as_import_kind(),
            "missing_resource",
            "source_changed",
        ];
        assert_eq!(
            mapped,
            [
                "no_thumbnail",
                "unsupported_decode",
                "exceeds_video_upload_limit",
                "header_filename_conflict",
                "preserved_only",
                "missing_resource",
                "source_changed",
            ]
        );
    }

    #[test]
    fn apple_import_reaper_deletes_safe_leftovers_and_skips_escapes() {
        let media_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let safe = media_root.path().join("stale-owned.bin");
        fs::write(&safe, b"stale-inside").unwrap();
        let escaped = outside.path().join("secret.bin");
        fs::write(&escaped, b"must-survive").unwrap();
        let symlink_target = outside.path().join("target.bin");
        fs::write(&symlink_target, b"symlink-target").unwrap();
        let leaf_link = media_root.path().join("leaf-link.bin");
        std::os::unix::fs::symlink(&symlink_target, &leaf_link).unwrap();

        let manifest = media_root
            .path()
            .join(".apple-import-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.manifest.json");
        let payload = AppleImportManifestFile {
            operation_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            files: vec![
                safe.to_string_lossy().into_owned(),
                escaped.to_string_lossy().into_owned(),
                leaf_link.to_string_lossy().into_owned(),
                media_root
                    .path()
                    .join("..")
                    .join(outside.path().file_name().unwrap())
                    .join("secret.bin")
                    .to_string_lossy()
                    .into_owned(),
            ],
        };
        fs::write(&manifest, serde_json::to_vec(&payload).unwrap()).unwrap();

        reap_stale_apple_import_manifests(media_root.path());

        assert!(
            !safe.exists(),
            "regular leftover inside media_root must be deleted"
        );
        assert!(
            escaped.exists(),
            "paths that escape media_root must not be deleted"
        );
        assert!(
            symlink_target.exists(),
            "symlink targets outside media_root must survive"
        );
        assert!(
            leaf_link.exists(),
            "leaf symlinks must not be followed or deleted"
        );
        assert!(!manifest.exists(), "stale manifest must be reaped");
    }

    #[test]
    fn apple_journal_successful_import_deletes_its_manifest() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Manifest cleanup");
        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let journal_id = default_journal_id(&state);

        import_apple(&state, &ks, export.path(), Some(journal_id));

        let leftover_manifests: Vec<_> = walkdir_files(media_root.path())
            .into_iter()
            .filter(|p| is_apple_import_manifest(p))
            .collect();
        assert!(
            leftover_manifests.is_empty(),
            "successful import must delete its own manifest: {leftover_manifests:?}"
        );
    }

    #[test]
    fn apple_journal_import_reaps_prior_crash_leftovers() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "After crash");
        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let journal_id = default_journal_id(&state);

        let stale = media_root.path().join("crash-leftover.bin");
        fs::write(&stale, b"from-crashed-import").unwrap();
        let stale_manifest = media_root
            .path()
            .join(".apple-import-11111111-1111-1111-1111-111111111111.manifest.json");
        fs::write(
            &stale_manifest,
            serde_json::to_vec(&AppleImportManifestFile {
                operation_id: "11111111-1111-1111-1111-111111111111".into(),
                files: vec![stale.to_string_lossy().into_owned()],
            })
            .unwrap(),
        )
        .unwrap();

        import_apple(&state, &ks, export.path(), Some(journal_id));

        assert!(
            !stale.exists(),
            "import-time reaper must delete leftover staged files listed in a stale manifest"
        );
        assert!(
            !stale_manifest.exists(),
            "import-time reaper must delete the stale manifest"
        );
    }

    #[test]
    fn stage_apple_resources_rejects_post_scan_leaf_symlink_to_outside() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        let photo = export.path().join("Resources/photo.png");
        fs::write(&photo, test_png_bytes(8, 8)).unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Swap",
            &photo_card("../Resources/photo.png"),
        );
        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();

        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.png");
        let secret_bytes = test_png_bytes(64, 64);
        fs::write(&secret, &secret_bytes).unwrap();
        fs::remove_file(&photo).unwrap();
        std::os::unix::fs::symlink(&secret, &photo).unwrap();

        let media_root = tempfile::tempdir().unwrap();
        let err = stage_apple_resources(&scan, media_root.path(), AppleStagingLimits::default())
            .expect_err("post-scan leaf symlink to an outside regular file must fail closed");
        let AppleStagingError::Io { message } = err;
        let lower = message.to_lowercase();
        assert!(
            lower.contains("symlink") || lower.contains("escape") || lower.contains("leaf"),
            "staging error must mention the symlink/escape: {message}"
        );
        let staged = walkdir_files(media_root.path());
        assert!(
            staged.is_empty(),
            "must not copy the outside target into media_root: {staged:?}"
        );
        assert_eq!(
            fs::read(&secret).unwrap(),
            secret_bytes,
            "outside target must be left untouched"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn persist_apple_journal_import_holds_and_queues_staged_videos() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01_clip.html"]);
        write_apple_entry(
            export.path(),
            "2024-03-01_clip.html",
            "Clip",
            &format!(
                "{}{}",
                photo_card("Resources/still.png"),
                video_card("Resources/clip.mov")
            ),
        );
        fs::write(
            export.path().join("Resources/still.png"),
            test_png_bytes(8, 8),
        )
        .unwrap();
        fs::write(export.path().join("Resources/clip.mov"), b"synthetic-mov").unwrap();

        let state = make_state();
        let media_root = tempfile::tempdir().unwrap();
        let journal_id = default_journal_id(&state);
        let prepared = prepare_apple_journal_import(
            export.path(),
            media_root.path(),
            AppleStagingLimits::default(),
        )
        .expect("staging");
        let video_media_id = prepared.entries[0]
            .media
            .iter()
            .find(|m| m.mime.starts_with("video/"))
            .expect("staged video")
            .media_id
            .clone();

        let mut jobs = Vec::new();
        let conn = state.lock().unwrap();
        persist_apple_journal_import(&conn, &journal_id, &prepared, &mut jobs).expect("persist");

        // Default video-compression setting is unset → Standard preset, so the
        // clip is enqueued exactly as `pick_video` enqueues a normal insert.
        assert_eq!(jobs.len(), 1, "only the video gets a compression job");
        assert_eq!(jobs[0].media_id, video_media_id);
        assert_eq!(
            db::queries::list_media_ids_awaiting_compression(&conn).unwrap(),
            vec![video_media_id],
            "the original must be held out of cloud upload until the swap"
        );
    }

    #[test]
    fn apple_staging_limits_from_settings_reads_the_configured_compression_mode() {
        let state = make_state();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "media_compression_mode", "aggressive").unwrap();
        }
        assert_eq!(
            apple_staging_limits_from_settings(&state).compression,
            crate::utils::image_compression::CompressionMode::Aggressive,
            "the only wiring between the settings table and the real Apple import flow"
        );
    }

    #[test]
    fn persist_apple_journal_import_names_the_row_after_the_recompressed_file() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01_big.html"]);
        write_apple_entry(
            export.path(),
            "2024-03-01_big.html",
            "Big",
            &photo_card("Resources/big.png"),
        );
        fs::write(
            export.path().join("Resources/big.png"),
            test_png_bytes(3000, 1200),
        )
        .unwrap();

        let state = make_state();
        let media_root = tempfile::tempdir().unwrap();
        let journal_id = default_journal_id(&state);
        let prepared = prepare_apple_journal_import(
            export.path(),
            media_root.path(),
            AppleStagingLimits {
                compression: crate::utils::image_compression::CompressionMode::Aggressive,
                ..Default::default()
            },
        )
        .expect("staging");
        let media_id = prepared.entries[0].media[0].media_id.clone();

        let conn = state.lock().unwrap();
        persist_apple_journal_import(&conn, &journal_id, &prepared, &mut Vec::new())
            .expect("persist");

        // Export derives the zip member extension from `file_name`, so a stale
        // `.png` here would round-trip JPEG bytes under a PNG name.
        let row = db::get_media(&conn, &media_id).unwrap().unwrap();
        assert_eq!(row.file_name, "big.jpg");
        assert_eq!(row.file_type, "image/jpeg");
        assert!(row.storage_path.ends_with(".jpg"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn persist_apple_journal_import_rolls_back_the_video_hold_on_failure() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01_clip.html"]);
        write_apple_entry(
            export.path(),
            "2024-03-01_clip.html",
            "Clip",
            &video_card("Resources/clip.mov"),
        );
        fs::write(export.path().join("Resources/clip.mov"), b"synthetic-mov").unwrap();

        let state = make_state();
        let media_root = tempfile::tempdir().unwrap();
        let prepared = prepare_apple_journal_import(
            export.path(),
            media_root.path(),
            AppleStagingLimits::default(),
        )
        .expect("staging");

        let mut jobs = Vec::new();
        let conn = state.lock().unwrap();
        persist_apple_journal_import(&conn, "missing-journal-id", &prepared, &mut jobs)
            .expect_err("persist into a missing journal must fail");

        // `awaiting_compression` is set inside the transaction, so a rollback
        // must take the hold with it — otherwise nothing would ever upload.
        assert!(
            db::queries::list_media_ids_awaiting_compression(&conn)
                .unwrap()
                .is_empty(),
            "a rolled-back import must leave no upload hold behind"
        );
    }

    #[test]
    fn persist_apple_journal_import_leaves_videos_unheld_when_compression_is_off() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01_clip.html"]);
        write_apple_entry(
            export.path(),
            "2024-03-01_clip.html",
            "Clip",
            &video_card("Resources/clip.mov"),
        );
        fs::write(export.path().join("Resources/clip.mov"), b"synthetic-mov").unwrap();

        let state = make_state();
        let media_root = tempfile::tempdir().unwrap();
        let journal_id = default_journal_id(&state);
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "video_compression_mode", "off").unwrap();
        }
        let prepared = prepare_apple_journal_import(
            export.path(),
            media_root.path(),
            AppleStagingLimits::default(),
        )
        .expect("staging");

        let mut jobs = Vec::new();
        let conn = state.lock().unwrap();
        persist_apple_journal_import(&conn, &journal_id, &prepared, &mut jobs).expect("persist");

        assert!(jobs.is_empty(), "compression off must enqueue nothing");
        assert!(
            db::queries::list_media_ids_awaiting_compression(&conn)
                .unwrap()
                .is_empty(),
            "a video must never be held out of cloud upload with no worker coming for it"
        );
    }

    #[test]
    fn stage_apple_resources_cleans_recompressed_files_on_a_later_disk_failure() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01_two.html"]);
        write_apple_entry(
            export.path(),
            "2024-03-01_two.html",
            "Two",
            &format!(
                "{}{}",
                photo_card("Resources/big.png"),
                photo_card("Resources/second.png")
            ),
        );
        fs::write(
            export.path().join("Resources/big.png"),
            test_png_bytes(3000, 1200),
        )
        .unwrap();
        let second = export.path().join("Resources/second.png");
        fs::write(&second, test_png_bytes(16, 16)).unwrap();

        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        // Make the SECOND resource unreadable after the scan so staging fails
        // only once the first has already been recompressed to a new `.jpg`.
        fs::remove_file(&second).unwrap();

        let media_root = tempfile::tempdir().unwrap();
        stage_apple_resources(
            &scan,
            media_root.path(),
            AppleStagingLimits {
                compression: crate::utils::image_compression::CompressionMode::Aggressive,
                ..Default::default()
            },
        )
        .expect_err("a missing source must fail the staging attempt");

        let leftovers = walkdir_files(media_root.path());
        assert!(
            leftovers.is_empty(),
            "cleanup must follow the recompressed path, not the deleted pre-compression one: {leftovers:?}"
        );
    }

    #[test]
    fn stage_apple_resources_skips_the_upload_warning_when_compression_fits_the_cap() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01_big.html"]);
        write_apple_entry(
            export.path(),
            "2024-03-01_big.html",
            "Big",
            &photo_card("Resources/big.png"),
        );
        let source = noisy_png_bytes(3000, 1200);
        fs::write(export.path().join("Resources/big.png"), &source).unwrap();

        let scan = crate::import_apple_journal::scan_apple_journal_folder(export.path()).unwrap();
        let media_root = tempfile::tempdir().unwrap();
        let probe = stage_apple_resources(
            &scan,
            media_root.path(),
            AppleStagingLimits {
                compression: crate::utils::image_compression::CompressionMode::Aggressive,
                ..Default::default()
            },
        )
        .expect("probe staging");
        let compressed_len = probe.media[0].byte_len;
        assert!(
            compressed_len < source.len() as u64,
            "this fixture must actually shrink for the cap to sit between the two sizes"
        );

        // Cap between the compressed and the original size: the check must read
        // the POST-compression `byte_len`, so no warning may fire.
        let cap = (compressed_len + source.len() as u64) / 2;
        let media_root = tempfile::tempdir().unwrap();
        let staged = stage_apple_resources(
            &scan,
            media_root.path(),
            AppleStagingLimits {
                photo_upload_bytes: Some(cap as i64),
                compression: crate::utils::image_compression::CompressionMode::Aggressive,
                ..Default::default()
            },
        )
        .expect("staging must succeed");
        assert!(!staged.media[0].exceeds_photo_upload_limit);
        assert!(
            staged
                .warnings
                .iter()
                .all(|w| w.kind != AppleStagingWarningKind::ExceedsPhotoUploadLimit),
            "the cap is checked after compression, so a fitting photo must not warn"
        );
    }

    #[test]
    fn apple_journal_exact_retry_removes_second_staging_keeps_first_originals() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Retry leftovers");
        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let journal_id = default_journal_id(&state);

        import_apple(&state, &ks, export.path(), Some(journal_id.clone()));
        let first_files: Vec<_> = walkdir_files(media_root.path())
            .into_iter()
            .filter(|p| !is_apple_import_manifest(p))
            .collect();
        assert!(
            !first_files.is_empty(),
            "first import must persist original media"
        );
        for path in &first_files {
            assert!(
                path.exists(),
                "first-import original missing: {}",
                path.display()
            );
        }

        let prepared = prepare_apple_journal_import(
            export.path(),
            media_root.path(),
            AppleStagingLimits::default(),
        )
        .expect("second staging");
        let second_files = prepared.owned_files.clone();
        assert!(
            !second_files.is_empty(),
            "exact retry must stage files before persist skips them"
        );
        for path in &second_files {
            assert!(
                path.exists(),
                "second staging file missing before persist: {}",
                path.display()
            );
            assert!(
                !first_files.contains(path),
                "second staging must not reuse first-import paths: {}",
                path.display()
            );
        }

        {
            let conn = state.lock().unwrap();
            persist_apple_journal_import(&conn, &journal_id, &prepared, &mut Vec::new())
                .expect("persist retry");
        }

        for path in &second_files {
            assert!(
                !path.exists(),
                "second staging leftovers must be deleted after exact-retry commit: {}",
                path.display()
            );
        }
        for path in &first_files {
            assert!(
                path.exists(),
                "first import originals must survive exact retry: {}",
                path.display()
            );
        }
    }

    #[test]
    fn apple_journal_shared_file_persist_scopes_media_to_each_entry() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html", "2024-03-02.html"]);
        fs::write(
            export.path().join("Resources/shared.png"),
            test_png_bytes(12, 12),
        )
        .unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "First",
            &photo_card("../Resources/shared.png"),
        );
        write_apple_entry(
            export.path(),
            "2024-03-02.html",
            "Second",
            &photo_card("../Resources/shared.png"),
        );

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let journal_id = default_journal_id(&state);

        let summary = import_data_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            ImportFormat::AppleJournalFolder,
            ImportMode::MergeNewer,
            Some(journal_id),
        )
        .expect("shared-file persist");
        assert_eq!(summary.imported, 2);

        let conn = state.lock().unwrap();
        let mut rows = db::list_all_entries(&conn).unwrap();
        rows.sort_by(|a, b| a.title.cmp(&b.title));
        assert_eq!(rows.len(), 2);
        let first = rows
            .iter()
            .find(|r| r.title.as_deref() == Some("First"))
            .unwrap();
        let second = rows
            .iter()
            .find(|r| r.title.as_deref() == Some("Second"))
            .unwrap();

        let media_first = db::get_media_for_entry(&conn, &first.id).unwrap();
        let media_second = db::get_media_for_entry(&conn, &second.id).unwrap();
        assert_eq!(media_first.len(), 1);
        assert_eq!(media_second.len(), 1);
        assert_eq!(media_first[0].entry_id, first.id);
        assert_eq!(media_second[0].entry_id, second.id);
        assert_ne!(
            media_first[0].id, media_second[0].id,
            "shared source must still mint per-entry media ids"
        );

        let yjs_first = db::get_entry_content(&conn, &first.id)
            .unwrap()
            .expect("first yjs");
        let yjs_second = db::get_entry_content(&conn, &second.id)
            .unwrap()
            .expect("second yjs");
        let first_id = media_first[0].id.as_bytes();
        let second_id = media_second[0].id.as_bytes();
        assert!(
            yjs_contains_bytes(&yjs_first, first_id),
            "first Yjs id map must reference only that entry's media id"
        );
        assert!(
            !yjs_contains_bytes(&yjs_first, second_id),
            "first Yjs must not contain the other entry's media id"
        );
        assert!(
            yjs_contains_bytes(&yjs_second, second_id),
            "second Yjs id map must reference only that entry's media id"
        );
        assert!(
            !yjs_contains_bytes(&yjs_second, first_id),
            "second Yjs must not contain the other entry's media id"
        );
    }

    fn yjs_contains_bytes(doc: &[u8], needle: &[u8]) -> bool {
        doc.windows(needle.len()).any(|window| window == needle)
    }

    fn import_apple(
        state: &AppState,
        ks: &EncryptionKeyState,
        src: &Path,
        journal_id: Option<String>,
    ) -> ImportSummary {
        import_data_inner(
            None,
            state,
            ks,
            src.to_string_lossy().to_string(),
            ImportFormat::AppleJournalFolder,
            ImportMode::MergeNewer,
            journal_id,
        )
        .expect("apple import")
    }

    #[test]
    fn apple_import_runs_on_blocking_worker_without_deadlock() {
        let summary = tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn_blocking(|| {
                let export = tempfile::tempdir().unwrap();
                write_minimal_apple_export(export.path(), "Worker");
                let state = make_state();
                let ks = make_key_state();
                let media_root = tempfile::tempdir().unwrap();
                set_media_root(&state, media_root.path());
                let journal = default_journal_id(&state);
                import_data_inner(
                    None,
                    &state,
                    &ks,
                    export.path().to_string_lossy().to_string(),
                    ImportFormat::AppleJournalFolder,
                    ImportMode::MergeNewer,
                    Some(journal),
                )
            })
            .await
            .map_err(|e| e.to_string())?
        })
        .expect("worker import");
        assert_eq!(summary.imported, 1);
    }

    #[test]
    fn preview_apple_journal_import_requires_unlock() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Locked preview");
        let state = make_state();
        let ks = EncryptionKeyState::new();
        let err = preview_apple_journal_import_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();
        assert!(
            err.contains("locked") || err.contains("Encryption key"),
            "unlock gate must reject Apple preview: {err}"
        );
    }

    #[test]
    fn preview_apple_journal_import_does_not_write_media_or_entries() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Preview only");
        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());

        let preview = preview_apple_journal_import_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            Some(AppleJournalImportOptions {
                conversion_timezone: Some("Europe/Berlin".into()),
                expected_source_hash: None,
            }),
        )
        .expect("preview");

        assert_eq!(preview.entries, 1);
        assert!(preview.resources_referenced >= 1);
        assert!(preview.clock_is_synthetic);
        assert_eq!(preview.date_policy, "html_visible");
        assert_eq!(preview.date_precision, "date_only");
        assert_eq!(preview.conversion_timezone, "Europe/Berlin");
        assert!(!preview.source_hash.is_empty());

        assert!(
            walkdir_files(media_root.path()).is_empty(),
            "preview must not stage into the live media dir: {:?}",
            walkdir_files(media_root.path())
        );
        let conn = state.lock().unwrap();
        assert!(
            db::list_all_entries(&conn).unwrap().is_empty(),
            "preview must not insert entries"
        );
    }

    #[test]
    fn preview_apple_journal_import_hash_changes_when_source_changes() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Hash");
        let state = make_state();
        let ks = make_key_state();

        let first = preview_apple_journal_import_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            None,
        )
        .expect("first preview");
        fs::write(
            export.path().join("Resources/photo.png"),
            test_png_bytes(20, 18),
        )
        .unwrap();
        let second = preview_apple_journal_import_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            None,
        )
        .expect("second preview");
        assert_ne!(
            first.source_hash, second.source_hash,
            "changed resource bytes must invalidate the preview hash"
        );
    }

    #[test]
    fn import_rejects_stale_preview_hash_without_mutation() {
        let export = tempfile::tempdir().unwrap();
        write_minimal_apple_export(export.path(), "Stale hash");
        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());

        let preview = preview_apple_journal_import_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            None,
        )
        .expect("preview");
        fs::write(
            export.path().join("Resources/photo.png"),
            test_png_bytes(24, 20),
        )
        .unwrap();

        let err = import_data_inner_with_options(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            ImportFormat::AppleJournalFolder,
            ImportMode::MergeNewer,
            Some(default_journal_id(&state)),
            Some(AppleJournalImportOptions {
                conversion_timezone: None,
                expected_source_hash: Some(preview.source_hash),
            }),
        )
        .unwrap_err();
        assert!(
            err.contains("source changed"),
            "stale preview hash must reject import: {err}"
        );

        let conn = state.lock().unwrap();
        assert!(
            db::list_all_entries(&conn).unwrap().is_empty(),
            "stale-hash reject must not insert entries"
        );
        drop(conn);
        assert!(
            walkdir_files(media_root.path()).is_empty(),
            "stale-hash reject must not leave staged media: {:?}",
            walkdir_files(media_root.path())
        );
    }

    #[test]
    fn preview_apple_journal_import_reports_heic_and_missing() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-06-15.html"]);
        fs::write(
            export.path().join("Resources/still.heic"),
            b"ftypheic-synthetic-original",
        )
        .unwrap();
        write_apple_entry(
            export.path(),
            "2024-06-15.html",
            "HEIC preview",
            &format!(
                "{}{}",
                live_card("../Resources/still.heic"),
                photo_card("../Resources/missing.png")
            ),
        );
        let state = make_state();
        let ks = make_key_state();
        let preview = preview_apple_journal_import_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            None,
        )
        .expect("preview");
        assert_eq!(preview.resources_missing, 1);
        let kinds: Vec<&str> = preview.warnings.iter().map(|w| w.kind.as_str()).collect();
        assert!(
            kinds.contains(&"unsupported_decode"),
            "HEIC must be flagged: {kinds:?}"
        );
        assert!(
            kinds.contains(&"missing_resource"),
            "missing ref must be flagged: {kinds:?}"
        );
    }

    #[test]
    fn preview_apple_journal_import_emits_yjs_conversion_kinds_without_writes() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-06-15.html"]);
        fs::write(
            export.path().join("Resources/still.heic"),
            b"ftypheic-synthetic-original",
        )
        .unwrap();
        fs::write(
            export.path().join("Resources/drawing.png"),
            test_png_bytes(8, 8),
        )
        .unwrap();
        fs::write(
            export.path().join("Entries/2024-06-15.html"),
            format!(
                r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title>
<style>
span.sPaint {{color: #c41e3a}}
</style>
</head>
<body>
<div class="pageHeader">Saturday, June 14, 2024</div>
<div class="assetGrid">{}{}{}</div>
<div class="title">Kinds</div>
<div class="bodyText"><span class="sPaint">painted</span></div>
</body></html>
"#,
                live_card("../Resources/still.heic"),
                format!(
                    r#"<div class="gridItem assetType_drawing "><img class="asset_image" src="../Resources/drawing.png"></div>"#
                ),
                r#"<div class="gridItem assetType_reflection "><span>synthetic card</span></div>"#,
            ),
        )
        .unwrap();

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());

        let preview = preview_apple_journal_import_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            None,
        )
        .expect("preview");

        let kinds: Vec<&str> = preview.warnings.iter().map(|w| w.kind.as_str()).collect();
        let features: Vec<Option<&str>> = preview
            .warnings
            .iter()
            .map(|w| w.feature.as_deref())
            .collect();
        assert!(
            kinds.contains(&"preserved_only"),
            "preview must emit font-color preserved_only: {kinds:?}"
        );
        assert!(
            features.contains(&Some("font-color")),
            "preview must pass structured font-color feature: {features:?}"
        );
        assert!(
            features.contains(&Some("asset-type:livephoto")),
            "preview must pass structured Live Photo feature: {features:?}"
        );
        assert!(
            features.contains(&Some("asset-type:drawing")),
            "preview must pass structured drawing feature: {features:?}"
        );
        assert!(
            features
                .iter()
                .any(|f| f.is_some_and(|v| v.starts_with("unknown-card:"))),
            "preview must pass structured unknown-card feature: {features:?}"
        );
        assert!(
            walkdir_files(media_root.path()).is_empty(),
            "conversion preview must not stage media: {:?}",
            walkdir_files(media_root.path())
        );
        let conn = state.lock().unwrap();
        assert!(
            db::list_all_entries(&conn).unwrap().is_empty(),
            "conversion preview must not insert entries"
        );
    }

    #[test]
    fn write_apple_journal_import_report_refuses_dest_inside_source() {
        let source = tempfile::tempdir().unwrap();
        let dest = source.path().join("report.txt");
        let err = write_apple_journal_import_report_inner(
            &source.path().to_string_lossy(),
            &dest.to_string_lossy(),
            b"report",
            None,
        )
        .unwrap_err();
        assert!(
            err.to_lowercase().contains("source"),
            "dest inside source must be refused: {err}"
        );
        assert!(!dest.exists(), "refused dest must not be written");
    }

    #[test]
    fn write_apple_journal_import_report_refuses_dest_inside_media_root() {
        let source = tempfile::tempdir().unwrap();
        let media = tempfile::tempdir().unwrap();
        let dest = media.path().join("report.txt");
        let err = write_apple_journal_import_report_inner(
            &source.path().to_string_lossy(),
            &dest.to_string_lossy(),
            b"report",
            Some(media.path()),
        )
        .unwrap_err();
        assert!(
            err.to_lowercase().contains("media"),
            "dest inside media root must be refused: {err}"
        );
        assert!(!dest.exists(), "refused dest must not be written");
    }

    #[test]
    fn write_apple_journal_import_report_refuses_dest_under_source_symlink_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("export");
        fs::create_dir_all(&source).unwrap();
        let alias = tmp.path().join("alias");
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        let dest = alias.join("nested").join("report.txt");
        let err = write_apple_journal_import_report_inner(
            &source.to_string_lossy(),
            &dest.to_string_lossy(),
            b"report",
            None,
        )
        .unwrap_err();
        assert!(
            err.to_lowercase().contains("source"),
            "dest under a symlink into source must be refused: {err}"
        );
        assert!(!dest.exists(), "refused dest must not be written");
        assert!(
            !source.join("nested").join("report.txt").exists(),
            "write must not follow the alias into the source folder"
        );
    }

    #[test]
    fn write_apple_journal_import_report_writes_outside_forbidden_roots() {
        let source = tempfile::tempdir().unwrap();
        let media = tempfile::tempdir().unwrap();
        let dest_dir = tempfile::tempdir().unwrap();
        let dest = dest_dir.path().join("report.txt");
        write_apple_journal_import_report_inner(
            &source.path().to_string_lossy(),
            &dest.to_string_lossy(),
            b"honest report",
            Some(media.path()),
        )
        .expect("write outside source and media root");
        assert_eq!(fs::read(&dest).unwrap(), b"honest report");
    }

    fn write_apple_photo_only_entry(root: &Path, file_name: &str, photo_src: &str) {
        fs::write(
            root.join("Entries").join(file_name),
            format!(
                r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title></head>
<body>
<div class="pageHeader">Monday, March 1, 2024</div>
<div class="assetGrid">{}</div>
<div class="title"></div>
<div class="bodyText"></div>
</body></html>
"#,
                photo_card(photo_src)
            ),
        )
        .unwrap();
    }

    const INTEROP_VISIBLE: &str = "visiblealpha";
    const INTEROP_HIDDEN: &str = "hiddenscript";

    fn write_interop_apple_export(root: &Path, title: &str) -> Vec<u8> {
        write_apple_index(root, &["2024-03-01.html"]);
        let png = test_png_bytes(16, 12);
        fs::write(root.join("Resources/photo.png"), &png).unwrap();
        fs::write(
            root.join("Resources/photo.json"),
            r#"{"date":1,"placeName":"Park","visits":[{"placeName":"Park","latitude":10.5,"longitude":106.7,"city":"Saigon"}]}"#,
        )
        .unwrap();
        fs::write(
            root.join("Entries/2024-03-01.html"),
            format!(
                r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title>
<script>{INTEROP_HIDDEN}()</script>
</head>
<body>
<div class="pageHeader">Monday, March 1, 2024</div>
<div class="assetGrid">{}{}</div>
<div class="title">{title}</div>
<div class="bodyText"><p>{INTEROP_VISIBLE} body</p></div>
</body></html>
"#,
                photo_card("../Resources/photo.png"),
                map_card("../Resources/photo.png"),
            ),
        )
        .unwrap();
        png
    }

    fn decode_yjs(bytes: &[u8]) -> yrs::Doc {
        use yrs::updates::decoder::Decode;
        use yrs::{Doc, Transact, Update};
        let update = Update::decode_v1(bytes).expect("decode yjs");
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update).expect("apply yjs");
        }
        doc
    }

    fn encode_yjs(doc: &yrs::Doc) -> Vec<u8> {
        use yrs::{ReadTxn, StateVector, Transact};
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    fn apple_map_json(bytes: &[u8]) -> yrs::Any {
        use yrs::types::ToJson;
        use yrs::Transact;
        let doc = decode_yjs(bytes);
        let map = doc.get_or_insert_map(crate::import_apple_journal_yjs::APPLE_JOURNAL_IMPORT_ROOT);
        let txn = doc.transact();
        map.to_json(&txn)
    }

    fn any_map(value: &yrs::Any) -> &std::collections::HashMap<String, yrs::Any> {
        match value {
            yrs::Any::Map(map) => map,
            other => panic!("expected map, got {other:?}"),
        }
    }

    fn any_str(value: &yrs::Any) -> &str {
        match value {
            yrs::Any::String(s) => s,
            other => panic!("expected string, got {other:?}"),
        }
    }

    fn any_array(value: &yrs::Any) -> &[yrs::Any] {
        match value {
            yrs::Any::Array(items) => items,
            other => panic!("expected array, got {other:?}"),
        }
    }

    fn default_fragment_text(bytes: &[u8]) -> String {
        use yrs::{GetString, Transact};
        let doc = decode_yjs(bytes);
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        fragment.get_string(&txn)
    }

    fn append_paragraph(doc: &yrs::Doc, text: &str) {
        use yrs::{Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};
        let fragment = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::new("paragraph", []));
        paragraph.push_back(&mut txn, XmlTextPrelim::new(text));
    }

    fn imported_apple_row(state: &AppState) -> db::Entry {
        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "expected one imported apple entry");
        rows.into_iter().next().unwrap()
    }

    fn import_interop_apple(
        title: &str,
    ) -> (
        AppState,
        EncryptionKeyState,
        tempfile::TempDir,
        Vec<u8>,
        db::Entry,
    ) {
        let export = tempfile::tempdir().unwrap();
        let png = write_interop_apple_export(export.path(), title);
        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let summary = import_apple(&state, &ks, export.path(), None);
        assert_eq!(summary.imported, 1, "interop apple import");
        let row = imported_apple_row(&state);
        (state, ks, media_root, png, row)
    }

    #[test]
    fn apple_journal_raw_html_is_not_searchable_and_location_feeds_map() {
        let (state, _ks, _media, _png, row) = import_interop_apple("Interop search");
        assert_eq!(row.latitude, Some(10.5));
        assert_eq!(row.longitude, Some(106.7));
        assert_eq!(row.location_label.as_deref(), Some("Park"));
        assert!(
            row.content_text
                .as_deref()
                .is_some_and(|text| text.contains(INTEROP_VISIBLE)),
            "visible body must feed content_text: {:?}",
            row.content_text
        );
        assert!(
            row.content_text
                .as_deref()
                .is_none_or(|text| !text.contains(INTEROP_HIDDEN) && !text.contains("<script")),
            "raw HTML must not become search content: {:?}",
            row.content_text
        );

        let conn = state.lock().unwrap();
        let hits = db::search_entries(&conn, INTEROP_VISIBLE, None).unwrap();
        assert_eq!(hits.len(), 1, "imported body must be searchable");
        assert_eq!(hits[0].id, row.id);
        let hidden = db::search_entries(&conn, INTEROP_HIDDEN, None).unwrap();
        assert!(
            hidden.is_empty(),
            "script provenance must not be visible to FTS: {hidden:?}"
        );
        let pins = db::list_entries_with_location(&conn).unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].id, row.id);
        assert_eq!(pins[0].latitude, 10.5);
        assert_eq!(pins[0].longitude, 106.7);
    }

    #[test]
    fn apple_journal_provenance_survives_editor_save_and_yjs_merge() {
        let (state, _ks, _media, _png, row) = import_interop_apple("Interop edit");
        let original = {
            let conn = state.lock().unwrap();
            db::get_entry_content(&conn, &row.id)
                .unwrap()
                .expect("imported yjs")
        };
        let original_html = any_str(
            any_map(&apple_map_json(&original))
                .get("rawHtml")
                .expect("rawHtml"),
        )
        .to_string();
        assert!(
            original_html.contains(INTEROP_HIDDEN),
            "imported provenance must keep raw script"
        );

        let edited_doc = decode_yjs(&original);
        append_paragraph(&edited_doc, "editor-save-token");
        let after_edit = encode_yjs(&edited_doc);
        {
            let conn = state.lock().unwrap();
            crate::commands::entries::save_entry_content_impl(
                &conn,
                &row.id,
                &after_edit,
                &format!("{} body\neditor-save-token", INTEROP_VISIBLE),
                "editor-save-token",
            )
            .expect("editor save");
        }
        let reopened = {
            let conn = state.lock().unwrap();
            db::get_entry_content(&conn, &row.id)
                .unwrap()
                .expect("reopened yjs")
        };
        assert_eq!(
            any_str(
                any_map(&apple_map_json(&reopened))
                    .get("rawHtml")
                    .expect("rawHtml after save")
            ),
            original_html,
            "save/reopen must keep appleJournalImport"
        );
        assert!(
            default_fragment_text(&reopened).contains("editor-save-token"),
            "editor save/reopen must keep the token in fragment default, not only rawHtml: {}",
            default_fragment_text(&reopened)
        );

        let merged = crate::sync::entry_sync::merge_yjs_full_state_updates(&original, &after_edit)
            .expect("yjs merge");
        let merged_root = apple_map_json(&merged);
        let merged_map = any_map(&merged_root);
        assert_eq!(
            any_str(merged_map.get("rawHtml").expect("merged rawHtml")),
            original_html
        );
        let resources = any_map(merged_map.get("resources").expect("resources"));
        assert!(
            resources.values().any(|value| match value {
                yrs::Any::Map(map) => map.get("mediaId").is_some(),
                _ => false,
            }),
            "merged resources must keep media links: {resources:?}"
        );
    }

    #[test]
    fn apple_journal_native_zip_roundtrip_preserves_yjs_and_media_bytes() {
        let (src, ks, src_media, png, row) = import_interop_apple("Interop backup");
        let original_yjs = {
            let conn = src.lock().unwrap();
            db::get_entry_content(&conn, &row.id)
                .unwrap()
                .expect("src yjs")
        };
        let original_html = any_str(
            any_map(&apple_map_json(&original_yjs))
                .get("rawHtml")
                .expect("rawHtml"),
        )
        .to_string();
        let original_media = {
            let conn = src.lock().unwrap();
            db::get_media_for_entry(&conn, &row.id).unwrap()
        };
        assert!(!original_media.is_empty(), "imported media");
        let source_hashes: Vec<String> = original_media
            .iter()
            .map(|m| sha256_file(Path::new(&m.storage_path)))
            .collect();
        assert!(
            source_hashes.iter().any(|hash| {
                let mut hasher = Sha256::new();
                hasher.update(&png);
                hex::encode(hasher.finalize()) == *hash
            }),
            "imported media must be the original PNG bytes"
        );

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("interop.memlore.zip");
        export_data_inner(
            None,
            &src,
            &ks,
            zip_path.to_string_lossy().to_string(),
            ExportFormat::MemloreJson,
            ExportScope::All,
        )
        .expect("native export");

        let dst = make_state();
        let dst_ks = make_key_state();
        let dst_media = tempfile::tempdir().unwrap();
        set_media_root(&dst, dst_media.path());
        let summary = import_data_inner(
            None,
            &dst,
            &dst_ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::MergeNewer,
            None,
        )
        .expect("native reimport");
        assert_eq!(summary.imported, 1);

        let restored = imported_apple_row(&dst);
        assert_eq!(restored.latitude, Some(10.5));
        assert_eq!(restored.longitude, Some(106.7));
        assert_eq!(restored.location_label.as_deref(), Some("Park"));
        let restored_yjs = {
            let conn = dst.lock().unwrap();
            db::get_entry_content(&conn, &restored.id)
                .unwrap()
                .expect("restored yjs")
        };
        assert_eq!(
            any_str(
                any_map(&apple_map_json(&restored_yjs))
                    .get("rawHtml")
                    .expect("restored rawHtml")
            ),
            original_html
        );
        assert!(
            default_fragment_text(&restored_yjs).contains(INTEROP_VISIBLE),
            "native zip must restore editor fragment default, not only the provenance map: {}",
            default_fragment_text(&restored_yjs)
        );
        let restored_media = {
            let conn = dst.lock().unwrap();
            db::get_media_for_entry(&conn, &restored.id).unwrap()
        };
        let restored_hashes: Vec<String> = restored_media
            .iter()
            .map(|m| sha256_file(Path::new(&m.storage_path)))
            .collect();
        assert_eq!(
            restored_hashes, source_hashes,
            "native zip must restore byte-identical media"
        );
        let _ = src_media;
    }

    #[test]
    fn apple_journal_recovery_backup_restores_provenance_and_media() {
        let (src, ks, _src_media, png, row) = import_interop_apple("Interop recovery");
        let original_yjs = {
            let conn = src.lock().unwrap();
            db::get_entry_content(&conn, &row.id)
                .unwrap()
                .expect("src yjs")
        };
        let original_html = any_str(
            any_map(&apple_map_json(&original_yjs))
                .get("rawHtml")
                .expect("rawHtml"),
        )
        .to_string();
        let source_hashes = {
            let conn = src.lock().unwrap();
            db::get_media_for_entry(&conn, &row.id)
                .unwrap()
                .into_iter()
                .map(|m| sha256_file(Path::new(&m.storage_path)))
                .collect::<Vec<_>>()
        };

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("recovery.memlore.zip");
        let db_key = ks.with_db_key(|k| Ok(*k)).unwrap();
        {
            let conn = src.lock().unwrap();
            crate::commands::export::write_complete_memlore_backup(
                &conn,
                &zip_path,
                &std::collections::HashMap::new(),
                Some(&db_key),
            )
            .expect("recovery backup");
        }

        let dst = make_state();
        let dst_ks = make_key_state();
        let dst_media = tempfile::tempdir().unwrap();
        set_media_root(&dst, dst_media.path());
        seed_entry(&dst, &dst_ks, "wipe me", "ancient", 1_600_000_000);
        let summary = import_data_inner(
            None,
            &dst,
            &dst_ks,
            zip_path.to_string_lossy().to_string(),
            ImportFormat::MemloreZip,
            ImportMode::ReplaceAll,
            None,
        )
        .expect("recovery restore");
        assert_eq!(summary.imported, 1);

        let restored = imported_apple_row(&dst);
        assert_eq!(restored.latitude, Some(10.5));
        assert_eq!(restored.longitude, Some(106.7));
        assert_eq!(restored.location_label.as_deref(), Some("Park"));
        let restored_yjs = {
            let conn = dst.lock().unwrap();
            db::get_entry_content(&conn, &restored.id)
                .unwrap()
                .expect("restored yjs")
        };
        assert_eq!(
            any_str(
                any_map(&apple_map_json(&restored_yjs))
                    .get("rawHtml")
                    .expect("restored rawHtml")
            ),
            original_html
        );
        assert!(
            default_fragment_text(&restored_yjs).contains(INTEROP_VISIBLE),
            "recovery must restore editor fragment default, not only the provenance map: {}",
            default_fragment_text(&restored_yjs)
        );
        let restored_hashes = {
            let conn = dst.lock().unwrap();
            db::get_media_for_entry(&conn, &restored.id)
                .unwrap()
                .into_iter()
                .map(|m| sha256_file(Path::new(&m.storage_path)))
                .collect::<Vec<_>>()
        };
        assert_eq!(restored_hashes, source_hashes);
        let mut hasher = Sha256::new();
        hasher.update(&png);
        let png_hash = hex::encode(hasher.finalize());
        assert!(
            restored_hashes.contains(&png_hash),
            "recovery backup must keep original PNG bytes"
        );
    }

    #[test]
    fn apple_journal_import_rejects_oversized_source_html_before_writes() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        let over = "x".repeat(crate::commands::entries::MAX_YJS_DOC_BYTES + 1);
        fs::write(
            export.path().join("Entries/2024-03-01.html"),
            format!(
                r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title></head>
<body>
<div class="pageHeader">Monday, March 1, 2024</div>
<div class="title">Too big</div>
<div class="bodyText"><p>{over}</p></div>
</body></html>
"#
            ),
        )
        .unwrap();

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        seed_entry(&state, &ks, "keep me", "existing body", 1_700_000_000);

        let err = import_data_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            ImportFormat::AppleJournalFolder,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap_err();
        assert!(
            err.contains("exceeds maximum allowed size"),
            "oversized source metadata must fail before persist: {err}"
        );

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "existing data must survive size rejection");
        assert_eq!(rows[0].title.as_deref(), Some("keep me"));
        assert_eq!(db::count_media(&conn).unwrap(), 0);
    }

    #[test]
    fn apple_journal_import_rejects_oversized_encoded_yjs_with_provenance() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        fs::write(
            export.path().join("Resources/photo.png"),
            test_png_bytes(8, 8),
        )
        .unwrap();
        let padding = "x".repeat(crate::commands::entries::MAX_YJS_DOC_BYTES + 1);
        fs::write(
            export.path().join("Resources/photo.json"),
            format!(r#"{{"date":1,"mysteryField":"{padding}"}}"#),
        )
        .unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Provenance too big",
            &photo_card("../Resources/photo.png"),
        );

        let html_len = fs::read(export.path().join("Entries/2024-03-01.html"))
            .unwrap()
            .len();
        assert!(
            html_len <= crate::commands::entries::MAX_YJS_DOC_BYTES,
            "this case must pass the source-length gate and fail on encoded Yjs+provenance"
        );

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        seed_entry(&state, &ks, "keep me", "existing body", 1_700_000_000);

        let err = import_data_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            ImportFormat::AppleJournalFolder,
            ImportMode::MergeNewer,
            None,
        )
        .unwrap_err();
        assert!(
            err.contains("exceeds maximum allowed size"),
            "encoded Yjs+provenance over MAX_YJS_DOC_BYTES must fail persist: {err}"
        );

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1, "existing data must survive size rejection");
        assert_eq!(rows[0].title.as_deref(), Some("keep me"));
        assert_eq!(db::count_media(&conn).unwrap(), 0);
    }

    #[test]
    fn apple_journal_preview_and_persist_succeed_with_unreferenced_binary() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        fs::write(
            export.path().join("Resources/used.png"),
            test_png_bytes(8, 8),
        )
        .unwrap();
        fs::write(export.path().join("Resources/orphan.bin"), b"left-behind").unwrap();
        write_apple_entry(
            export.path(),
            "2024-03-01.html",
            "Used",
            &photo_card("../Resources/used.png"),
        );

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());

        let preview = preview_apple_journal_import_inner(
            None,
            &state,
            &ks,
            export.path().to_string_lossy().to_string(),
            None,
        )
        .expect("preview of a folder with an unreferenced binary must succeed");
        assert_eq!(preview.entries, 1);
        assert_eq!(preview.resources_unreferenced, 1);
        assert!(
            preview
                .warnings
                .iter()
                .any(|w| w.kind == "unreferenced_resource"),
            "preview must count/warn unreferenced binaries: {:?}",
            preview.warnings
        );

        let summary = import_apple(&state, &ks, export.path(), None);
        assert_eq!(
            summary.imported, 1,
            "persist must import referenced entries"
        );
        let apple = summary.apple.as_ref().expect("apple report");
        assert_eq!(apple.resources_unreferenced, 1);
        assert_eq!(apple.resources_imported, 1);
        assert!(
            summary
                .warnings
                .iter()
                .any(|w| w.kind == "unreferenced_resource"),
            "persist must warn about unreferenced binaries: {:?}",
            summary.warnings
        );
        assert!(
            export.path().join("Resources/orphan.bin").is_file(),
            "unreferenced binary must stay in the source archive"
        );

        let conn = state.lock().unwrap();
        let rows = db::list_all_entries(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        let media = db::get_media_for_entry(&conn, &rows[0].id).unwrap();
        assert_eq!(media.len(), 1, "orphan must not be assigned to the entry");
        assert!(
            !media.iter().any(|item| {
                Path::new(&item.storage_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.contains("orphan"))
            }),
            "unreferenced binary must not become entry media: {media:?}"
        );
    }

    #[test]
    fn apple_journal_persist_copies_scan_unknown_fields_into_yjs() {
        let export = tempfile::tempdir().unwrap();
        write_apple_index(export.path(), &["2024-03-01.html"]);
        fs::write(
            export.path().join("Resources/known-photo.png"),
            test_png_bytes(8, 8),
        )
        .unwrap();
        fs::write(
            export.path().join("Resources/known-photo.json"),
            r#"{"date":1,"mysteryField":true}"#,
        )
        .unwrap();
        fs::write(
            export.path().join("Entries/2024-03-01.html"),
            format!(
                r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title></title></head>
<body>
<div class="pageHeader">Monday, March 1, 2024</div>
<div class="assetGrid">{}
<div class="gridItem assetType_drawing "><span>drawing caption</span></div>
</div>
<div class="title">Unknown fields</div>
<div class="bodyText"><p>keep the card</p></div>
</body></html>
"#,
                photo_card("../Resources/known-photo.png")
            ),
        )
        .unwrap();

        let state = make_state();
        let ks = make_key_state();
        let media_root = tempfile::tempdir().unwrap();
        set_media_root(&state, media_root.path());
        let summary = import_apple(&state, &ks, export.path(), None);
        assert_eq!(summary.imported, 1);

        let row = imported_apple_row(&state);
        let yjs = {
            let conn = state.lock().unwrap();
            db::get_entry_content(&conn, &row.id)
                .unwrap()
                .expect("imported yjs")
        };
        let root = apple_map_json(&yjs);
        let unknown = any_array(
            any_map(&root)
                .get("unknownFields")
                .expect("unknownFields must be written"),
        );
        let keys: Vec<&str> = unknown
            .iter()
            .map(|value| any_str(any_map(value).get("key").expect("unknown key")))
            .collect();
        assert!(
            keys.iter().any(|key| *key == "mysteryField"),
            "persist must copy unknown sidecar keys into Yjs: {keys:?}"
        );
        assert!(
            keys.iter().any(|key| *key == "drawing"),
            "persist must copy unknown cards into Yjs: {keys:?}"
        );
    }
}
