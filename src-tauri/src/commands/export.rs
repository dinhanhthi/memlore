//! E1/E2 Export Backend
//!
//! Implements export Tauri commands:
//!
//! - `export_data` — writes a `.memlore.zip` archive (JSON format) or
//!   plain-text zip to a caller-supplied path.
//! - `write_markdown_zip` — receives frontend-rendered Markdown strings and
//!   writes them into a zip at `dest`.
//!
//! The archive contains:
//!
//! - `manifest.json`  — counts and metadata
//! - `full_snapshot.json` — complete SQLite-backed app state for full restore
//! - `entries.jsonl`  — one `ExportedEntry` JSON object per line (plaintext fields)
//! - `journals.json`  — array of all journals
//! - `tags.json`      — array of all tags
//! - `media/<id>.<ext>` — binary media blobs (missing files are skipped)
//!
//! `write_complete_memlore_backup` (used only by the automatic pre-recovery
//! backup in `sync::recovery`, never by `export_data`/`export_data_inner`
//! above) writes the same archive shape but, when a db_key is available,
//! encrypts `full_snapshot.json` into `full_snapshot.json.enc` — see its doc
//! comment for details. The user-facing manual export below is unaffected
//! and always writes plaintext `full_snapshot.json`.

use std::io::Write as _;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::db;
use crate::{AppState, EncryptionKeyState};

// ─── Schema version ──────────────────────────────────────────────────────────

// Version 2: Phase 3 encryption redesign — all entry columns are plaintext at
// the application layer (SQLCipher provides at-rest encryption). Exports produced
// by v1 builds contained per-field AES-GCM ciphertext in title/preview_text/etc.;
// importing those into a Phase-3 DB would store ciphertext as displayable text.
const SCHEMA_VERSION: u32 = 2;

// ─── Export enums ─────────────────────────────────────────────────────────────

/// Which file format to produce.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    /// `.memlore.zip` — JSON + media (default, E1 behavior).
    MemloreJson,
    /// One `.md` file per entry inside a zip.  Markdown is rendered by the
    /// frontend and passed via `write_markdown_zip`.
    Markdown,
    /// Plain-text extraction — `content_text` only, no rich structure.
    PlainText,
}

impl Default for ExportFormat {
    fn default() -> Self {
        Self::MemloreJson
    }
}

/// Which entries to include in the export.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportScope {
    /// All entries across all journals.
    All,
    /// Entries belonging to a specific journal.
    Journal { journal_id: String },
    /// Entries whose `entry_date` falls within `[start, end]` (Unix seconds).
    DateRange { start: i64, end: i64 },
}

impl Default for ExportScope {
    fn default() -> Self {
        Self::All
    }
}

// ─── Progress event ───────────────────────────────────────────────────────────

const EXPORT_PROGRESS_EVENT: &str = "export:progress";
const SYNC_CATCHUP_INCOMPLETE_ERROR: &str = "SYNC_CATCHUP_INCOMPLETE: pulled=0 total=0";

#[derive(Debug, Clone, Serialize)]
struct ExportProgress {
    percent: u8,
    phase: &'static str,
}

fn emit_progress(app: &AppHandle, percent: u8, phase: &'static str) {
    if let Err(e) = app.emit(EXPORT_PROGRESS_EVENT, ExportProgress { percent, phase }) {
        log::warn!("emit export:progress failed: {e}");
    }
}

/// Refuse a user-initiated export until an active sync has finished pulling
/// every peer. Catch-up counts are event-only today, so the stable error shape
/// carries zeroes for callers that need to identify this condition.
fn ensure_export_sync_catchup_complete(conn: &rusqlite::Connection) -> Result<(), String> {
    let sync_is_configured = crate::commands::sync::make_configured_provider(conn)?.is_some();
    let catchup_complete = db::get_sync_catchup_complete(conn).map_err(|e| e.to_string())?;

    if sync_is_configured && !catchup_complete {
        return Err(SYNC_CATCHUP_INCOMPLETE_ERROR.to_string());
    }

    Ok(())
}

fn export_data_after_catchup_guard(
    app: Option<&AppHandle>,
    state: &AppState,
    key_state: &EncryptionKeyState,
    dest: String,
    format: ExportFormat,
    scope: ExportScope,
) -> Result<ExportSummary, String> {
    {
        let conn = state.lock()?;
        ensure_export_sync_catchup_complete(&conn)?;
    }

    export_data_inner(app, state, key_state, dest, format, scope)
}

// ─── Output structs ───────────────────────────────────────────────────────────

/// Written to `manifest.json` inside the ZIP.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportManifest {
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub entry_count: u64,
    pub journal_count: u64,
    pub tag_count: u64,
    pub media_count: u64,
}

/// Per-entry record written to `entries.jsonl`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedEntry {
    pub id: String,
    pub journal_id: String,
    pub entry_date: i64,
    pub title: Option<String>,
    pub content_text: Option<String>,
    pub yjs_doc_b64: Option<String>,
    pub preview_text: Option<String>,
    pub emotion: Option<String>,
    pub location_label: Option<String>,
    pub location_address: Option<String>,
    pub weather_summary: Option<String>,
    pub weather_icon: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub is_favorite: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<String>,
    pub media: Vec<ExportedMedia>,
}

/// Media attachment metadata embedded inside each `ExportedEntry`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedMedia {
    pub id: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: Option<i64>,
    pub sha256: Option<String>,
}

/// Returned to the frontend after a successful export.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportSummary {
    pub entry_count: u64,
    pub journal_count: u64,
    pub tag_count: u64,
    pub media_count: u64,
    pub media_skipped: u64,
}

// ─── ISO 8601 UTC formatter (no chrono dep) ───────────────────────────────────

/// Format a Unix timestamp (seconds) as `YYYY-MM-DDTHH:MM:SSZ`.
/// Uses the proleptic Gregorian calendar algorithm (correct for all dates from
/// the Unix epoch forward).
fn format_iso8601_utc(unix_secs: u64) -> String {
    let secs_in_day = 86400u64;
    let days_since_epoch = unix_secs / secs_in_day;
    let time_of_day = unix_secs % secs_in_day;

    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;

    // Gregorian calendar: days since 1970-01-01 → (year, month, day).
    // Algorithm from https://howardhinnant.github.io/date_algorithms.html#civil_from_days
    let z = days_since_epoch as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}

// ─── Core export logic ────────────────────────────────────────────────────────

/// Returns `true` if `s` is safe to use as a zip entry path component:
/// no path separators, no null bytes, non-empty, length ≤ 255.
fn is_safe_zip_component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains('\0')
        && !s.contains("..")
}

/// Write a complete recovery-compatible `.memlore.zip` containing
/// `full_snapshot.json` plus every media original. Media IDs present in
/// `path_overrides` are read from the override path (used for cloud-only
/// originals staged during local-authoritative preflight). Missing override
/// and empty/missing `storage_path` rows are hard errors — recovery backup
/// must be complete, unlike the user-facing export which skips gaps.
///
/// `db_key`: when `Some`, `full_snapshot.json` — the only member containing
/// decrypted entry text/titles/tags/locations, i.e. the same content
/// SQLCipher protects in the live DB — is AES-256-GCM encrypted (via
/// `utils::encryption::encrypt_data`, the same primitive used elsewhere in
/// the app) and stored as `full_snapshot.json.enc` instead.
///
/// **Always-encrypted note:** every vault now has a `db_key`, so production
/// callers always pass `Some`. The `None` arm (plaintext `full_snapshot.json`)
/// is unreachable in production — every caller resolves the key via
/// `EncryptionKeyState::with_db_key` and returns early on `Err`. It is kept
/// only so tests can exercise the member-name dispatch.
/// This mirrors `write_preserved_device_local_state`'s
/// `db_key: Option<&[u8; 32]>` pattern, except member-name dispatch is used
/// instead of a 1-byte envelope so the plaintext path can keep using
/// `read_optional_json_by_name` unchanged on the import side.
///
/// `manifest.json` and `media/*` are NOT encrypted: `manifest.json` is only
/// counts/schema metadata, and media originals are copied verbatim from
/// `storage_path` (or `path_overrides`), so they carry exactly the same
/// at-rest exposure in the backup as the live media directory already has —
/// no new exposure is introduced there.
pub fn write_complete_memlore_backup(
    conn: &rusqlite::Connection,
    dest: &std::path::Path,
    path_overrides: &std::collections::HashMap<String, PathBuf>,
    db_key: Option<&[u8; 32]>,
) -> Result<ExportSummary, String> {
    let dest_path = dest.to_path_buf();
    let tmp_path = {
        let mut p = dest_path.clone();
        let mut name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("recovery")
            .to_string();
        name.push_str(".tmp");
        p.set_file_name(name);
        p
    };

    let result = (|| -> Result<ExportSummary, String> {
        if let Some(parent) = tmp_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create backup directory: {e}"))?;
        }
        let file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create recovery backup file: {e}"))?;
        let mut zip = ZipWriter::new(file);
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let snapshot =
            db::export_full_snapshot(conn).map_err(|e| format!("snapshot export: {e}"))?;
        let snapshot_json =
            serde_json::to_vec(&snapshot).map_err(|e| format!("full_snapshot serialize: {e}"))?;
        let (snapshot_member, snapshot_bytes) = match db_key {
            Some(key) => {
                let encrypted = crate::utils::encryption::encrypt_data(key, &snapshot_json)
                    .map_err(|e| format!("encrypt full_snapshot.json: {e}"))?;
                ("full_snapshot.json.enc", encrypted)
            }
            None => ("full_snapshot.json", snapshot_json),
        };
        zip.start_file(snapshot_member, opts)
            .map_err(|e| format!("zip start {snapshot_member}: {e}"))?;
        zip.write_all(&snapshot_bytes)
            .map_err(|e| format!("zip write {snapshot_member}: {e}"))?;

        let media_rows =
            db::list_backup_media_files(conn).map_err(|e| format!("list media: {e}"))?;
        let mut media_count = 0u64;
        for m in &media_rows {
            let ext = std::path::Path::new(&m.file_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin")
                .to_string();
            if !is_safe_zip_component(&m.id) || !is_safe_zip_component(&ext) {
                return Err(format!(
                    "recovery backup cannot include media {} — unsafe id or extension",
                    m.id
                ));
            }
            let source = path_overrides
                .get(&m.id)
                .map(|p| p.as_path())
                .unwrap_or_else(|| std::path::Path::new(&m.storage_path));
            let file_bytes = std::fs::read(source).map_err(|e| {
                format!(
                    "recovery backup missing media {} at {}: {e}",
                    m.id,
                    source.display()
                )
            })?;
            let zip_path = format!("media/{}.{}", m.id, ext);
            zip.start_file(&zip_path, opts)
                .map_err(|e| format!("zip start {zip_path}: {e}"))?;
            zip.write_all(&file_bytes)
                .map_err(|e| format!("zip write {zip_path}: {e}"))?;
            media_count += 1;
        }

        let journals = db::list_journals(conn, None).map_err(|e| e.to_string())?;
        let tags = db::list_tags(conn, None).map_err(|e| e.to_string())?;
        let entries = db::list_all_entries(conn).map_err(|e| e.to_string())?;
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("System clock error: {e}"))?
            .as_secs();
        let manifest = ExportManifest {
            schema_version: SCHEMA_VERSION,
            exported_at: format_iso8601_utc(now_secs),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            entry_count: entries.len() as u64,
            journal_count: journals.len() as u64,
            tag_count: tags.len() as u64,
            media_count,
        };
        let manifest_json =
            serde_json::to_vec_pretty(&manifest).map_err(|e| format!("manifest serialize: {e}"))?;
        zip.start_file("manifest.json", opts)
            .map_err(|e| format!("zip start manifest.json: {e}"))?;
        zip.write_all(&manifest_json)
            .map_err(|e| format!("zip write manifest.json: {e}"))?;
        zip.finish().map_err(|e| format!("zip finish: {e}"))?;

        Ok(ExportSummary {
            entry_count: entries.len() as u64,
            journal_count: journals.len() as u64,
            tag_count: tags.len() as u64,
            media_count,
            media_skipped: 0,
        })
    })();

    match result {
        Ok(summary) => {
            std::fs::rename(&tmp_path, &dest_path)
                .map_err(|e| format!("Failed to finalize recovery backup: {e}"))?;
            Ok(summary)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

pub fn export_data_inner(
    app: Option<&AppHandle>,
    state: &AppState,
    key_state: &EncryptionKeyState,
    dest: String,
    format: ExportFormat,
    scope: ExportScope,
) -> Result<ExportSummary, String> {
    let dest_path = PathBuf::from(&dest);

    // Write to a sibling `.tmp` file; rename atomically on success so a
    // mid-export failure never leaves a corrupt archive at the user's path.
    let tmp_path = {
        let mut p = dest_path.clone();
        let mut name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("export")
            .to_string();
        name.push_str(".tmp");
        p.set_file_name(name);
        p
    };

    let result = export_data_to_path(app, state, key_state, &tmp_path, format, scope);

    match result {
        Ok(summary) => {
            std::fs::rename(&tmp_path, &dest_path)
                .map_err(|e| format!("Failed to finalize export file: {e}"))?;
            Ok(summary)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

fn export_data_to_path(
    app: Option<&AppHandle>,
    state: &AppState,
    key_state: &EncryptionKeyState,
    dest_path: &PathBuf,
    format: ExportFormat,
    scope: ExportScope,
) -> Result<ExportSummary, String> {
    // Gate on unlock (key_state keeps the lock/unlock contract even though
    // Phase 3 removed per-field encryption — the key must be loaded to export).
    key_state.with_key(|_key| {
        let conn = state.lock()?;

        if let Some(app) = app {
            emit_progress(app, 5, "collecting");
        }

        // ── Collect all data ────────────────────────────────────────────────

        // Unfiltered list so we can drop invisible journals (and their entries)
        // from the export — always-exclude all vaults (decision 10).
        let all_journals = db::list_journals_unfiltered(&conn).map_err(|e| e.to_string())?;
        let all_tags = db::list_tags(&conn, None).map_err(|e| e.to_string())?;

        let invisible_journal_ids: std::collections::HashSet<String> = all_journals
            .iter()
            .filter(|journal| journal.is_invisible)
            .map(|journal| journal.id.clone())
            .collect();
        // journals.json / journal_count must not leak invisible journals.
        let journals: Vec<_> = all_journals
            .into_iter()
            .filter(|journal| !journal.is_invisible)
            .collect();
        let visible_entries: Vec<_> = db::list_all_entries(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|entry| {
                !entry.is_invisible && !invisible_journal_ids.contains(&entry.journal_id)
            })
            .collect();

        // Filter entries by scope.
        // TODO(perf): Journal and DateRange variants fetch all entries then filter in Rust.
        // Add db::list_entries_by_journal() and db::list_entries_by_date_range() queries to
        // push filtering down to SQLite for large journals (follow-up, post-Phase 5 MVP).
        let raw_entries = match &scope {
            ExportScope::All => visible_entries,
            ExportScope::Journal { journal_id } => visible_entries
                .into_iter()
                .filter(|e| &e.journal_id == journal_id)
                .collect(),
            ExportScope::DateRange { start, end } => visible_entries
                .into_iter()
                .filter(|e| e.entry_date >= *start && e.entry_date <= *end)
                .collect(),
        };

        let journal_count = journals.len() as u64;
        let tag_count = all_tags.len() as u64;
        let entry_count = raw_entries.len() as u64;

        if let Some(app) = app {
            emit_progress(app, 15, "writing");
        }

        // ── Build the ZIP ───────────────────────────────────────────────────

        let file = std::fs::File::create(dest_path)
            .map_err(|e| format!("Failed to create export file: {e}"))?;
        let mut zip = ZipWriter::new(file);

        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // Markdown export is a two-step frontend-driven flow: the frontend renders
        // Markdown and calls write_markdown_zip directly. Calling export_data with
        // Markdown format is a caller error — return early before writing any file.
        if format == ExportFormat::Markdown {
            return Err(
                "Markdown export requires write_markdown_zip — call that command instead"
                    .to_string(),
            );
        }

        // Plain-text format: one .txt file per entry, no media.
        if format == ExportFormat::PlainText {
            for (idx, entry) in raw_entries.iter().enumerate() {
                let title = entry.title.clone();
                let safe_id = if is_safe_zip_component(&entry.id) {
                    entry.id.clone()
                } else {
                    format!("entry-{idx}")
                };
                let filename = format!("{safe_id}.txt");
                let content = title.unwrap_or_default()
                    + "\n\n"
                    + entry.content_text.as_deref().unwrap_or("");
                zip.start_file(&filename, opts)
                    .map_err(|e| format!("zip start {filename}: {e}"))?;
                zip.write_all(content.as_bytes())
                    .map_err(|e| format!("zip write {filename}: {e}"))?;

                if let Some(app) = app {
                    let pct = 15 + (80 * (idx + 1) / entry_count.max(1) as usize) as u8;
                    emit_progress(app, pct, "writing");
                }
            }
            zip.finish().map_err(|e| format!("zip finish: {e}"))?;
            if let Some(app) = app {
                emit_progress(app, 100, "done");
            }
            return Ok(ExportSummary {
                entry_count,
                journal_count,
                tag_count,
                media_count: 0,
                media_skipped: 0,
            });
        }

        // ── JSON format (MemloreJson) ───────────────────────────────────────

        let include_full_snapshot = matches!(scope, ExportScope::All);

        // journals.json
        let journals_json =
            serde_json::to_vec(&journals).map_err(|e| format!("journals serialize: {e}"))?;
        zip.start_file("journals.json", opts)
            .map_err(|e| format!("zip start journals.json: {e}"))?;
        zip.write_all(&journals_json)
            .map_err(|e| format!("zip write journals.json: {e}"))?;

        // tags.json
        let tags_json =
            serde_json::to_vec(&all_tags).map_err(|e| format!("tags serialize: {e}"))?;
        zip.start_file("tags.json", opts)
            .map_err(|e| format!("zip start tags.json: {e}"))?;
        zip.write_all(&tags_json)
            .map_err(|e| format!("zip write tags.json: {e}"))?;

        // entries.jsonl + media files
        zip.start_file("entries.jsonl", opts)
            .map_err(|e| format!("zip start entries.jsonl: {e}"))?;

        let mut total_media_count = 0u64;
        let mut media_skipped = 0u64;

        // Collect media to write after entries.jsonl closes.
        // Tuple: (storage_path, zip_path) — bytes are read lazily in the copy pass
        // to avoid holding all media in RAM simultaneously.
        let mut media_to_copy: Vec<(String, String)> = Vec::new();
        let mut media_zip_paths: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for (idx, entry) in raw_entries.iter().enumerate() {
            // Phase 3: all fields are plaintext — no decryption needed.
            let title = entry.title.clone();
            let preview_text = entry.preview_text.clone();
            let location_label = entry.location_label.clone();
            let location_address = entry.location_address.clone();
            let weather_summary = entry.weather_summary.clone();

            // Fetch the Yjs document blob (plaintext bytes).
            let yjs_raw = db::get_entry_content(&conn, &entry.id)
                .map_err(|e| format!("get_entry_content {}: {e}", entry.id))?;
            let yjs_doc_b64 = yjs_raw.map(|bytes| B64.encode(&bytes));

            // Fetch tags for this entry.
            let entry_tags = db::get_tags_for_entry(&conn, &entry.id)
                .map_err(|e| format!("get_tags_for_entry {}: {e}", entry.id))?;
            let tag_names: Vec<String> = entry_tags.into_iter().map(|t| t.name).collect();

            // Fetch media for this entry.
            let media_rows = db::get_media_for_entry(&conn, &entry.id)
                .map_err(|e| format!("get_media_for_entry {}: {e}", entry.id))?;

            let mut exported_media: Vec<ExportedMedia> = Vec::new();

            for m in &media_rows {
                total_media_count += 1;

                let ext = std::path::Path::new(&m.file_name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("bin")
                    .to_string();

                // Guard against zip-slip: both the media ID and extension must
                // be safe path components (no '/', '..', null bytes, etc.).
                if !is_safe_zip_component(&m.id) || !is_safe_zip_component(&ext) {
                    log::warn!("export: skipping media {} — unsafe id or extension", m.id);
                    media_skipped += 1;
                    exported_media.push(ExportedMedia {
                        id: m.id.clone(),
                        file_name: m.file_name.clone(),
                        mime_type: m.file_type.clone(),
                        size_bytes: m.file_size,
                        sha256: None,
                    });
                    continue;
                }

                let zip_path = format!("media/{}.{}", m.id, ext);

                // Read the file once to compute sha256 for the entry metadata.
                let file_bytes = match std::fs::read(&m.storage_path) {
                    Ok(b) => b,
                    Err(e) => {
                        log::warn!(
                            "export: skipping missing media {} at {}: {e}",
                            m.id,
                            m.storage_path
                        );
                        media_skipped += 1;
                        exported_media.push(ExportedMedia {
                            id: m.id.clone(),
                            file_name: m.file_name.clone(),
                            mime_type: m.file_type.clone(),
                            size_bytes: m.file_size,
                            sha256: None,
                        });
                        continue;
                    }
                };

                let mut hasher = Sha256::new();
                hasher.update(&file_bytes);
                let sha256 = hex::encode(hasher.finalize());

                exported_media.push(ExportedMedia {
                    id: m.id.clone(),
                    file_name: m.file_name.clone(),
                    mime_type: m.file_type.clone(),
                    size_bytes: m.file_size,
                    sha256: Some(sha256),
                });

                // Store only the paths — bytes are re-read during the zip-copy
                // pass to avoid holding all media in RAM simultaneously.
                media_zip_paths.insert(zip_path.clone());
                media_to_copy.push((m.storage_path.clone(), zip_path));
            }

            let exported_entry = ExportedEntry {
                id: entry.id.clone(),
                journal_id: entry.journal_id.clone(),
                entry_date: entry.entry_date,
                title,
                content_text: entry.content_text.clone(),
                yjs_doc_b64,
                preview_text,
                emotion: entry.emotion.clone(),
                location_label,
                location_address,
                weather_summary,
                weather_icon: entry.weather_icon.clone(),
                latitude: entry.latitude,
                longitude: entry.longitude,
                is_favorite: entry.is_favorite,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
                tags: tag_names,
                media: exported_media,
            };

            let mut line = serde_json::to_string(&exported_entry)
                .map_err(|e| format!("entry serialize: {e}"))?;
            line.push('\n');
            zip.write_all(line.as_bytes())
                .map_err(|e| format!("zip write entry line: {e}"))?;

            if let Some(app) = app {
                let pct = 15 + (60 * (idx + 1) / entry_count.max(1) as usize) as u8;
                emit_progress(app, pct, "writing");
            }
        }

        if include_full_snapshot {
            let snapshot =
                db::export_full_snapshot(&conn).map_err(|e| format!("snapshot export: {e}"))?;
            let snapshot_json = serde_json::to_vec(&snapshot)
                .map_err(|e| format!("full_snapshot serialize: {e}"))?;
            zip.start_file("full_snapshot.json", opts)
                .map_err(|e| format!("zip start full_snapshot.json: {e}"))?;
            zip.write_all(&snapshot_json)
                .map_err(|e| format!("zip write full_snapshot.json: {e}"))?;

            let snapshot_media =
                db::list_backup_media_files(&conn).map_err(|e| format!("list media: {e}"))?;
            for m in snapshot_media {
                let ext = std::path::Path::new(&m.file_name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("bin")
                    .to_string();
                if !is_safe_zip_component(&m.id) || !is_safe_zip_component(&ext) {
                    log::warn!(
                        "export: skipping snapshot media {} — unsafe id or extension",
                        m.id
                    );
                    media_skipped += 1;
                    continue;
                }
                if std::fs::metadata(&m.storage_path).is_err() {
                    log::warn!(
                        "export: skipping snapshot media {} at {} — file missing",
                        m.id,
                        m.storage_path
                    );
                    media_skipped += 1;
                    continue;
                }
                let zip_path = format!("media/{}.{}", m.id, ext);
                if media_zip_paths.insert(zip_path.clone()) {
                    media_to_copy.push((m.storage_path, zip_path));
                }
            }
        }

        // ── media files ─────────────────────────────────────────────────────
        for (storage_path, zip_path) in &media_to_copy {
            let file_bytes = std::fs::read(storage_path)
                .map_err(|e| format!("Failed to read media {storage_path}: {e}"))?;
            zip.start_file(zip_path.as_str(), opts)
                .map_err(|e| format!("zip start {zip_path}: {e}"))?;
            zip.write_all(&file_bytes)
                .map_err(|e| format!("zip write {zip_path}: {e}"))?;
        }

        // ── manifest.json ───────────────────────────────────────────────────
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("System clock error: {e}"))?
            .as_secs();

        let manifest = ExportManifest {
            schema_version: SCHEMA_VERSION,
            exported_at: format_iso8601_utc(now_secs),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            entry_count,
            journal_count,
            tag_count,
            media_count: total_media_count,
        };
        let manifest_json =
            serde_json::to_vec_pretty(&manifest).map_err(|e| format!("manifest serialize: {e}"))?;
        zip.start_file("manifest.json", opts)
            .map_err(|e| format!("zip start manifest.json: {e}"))?;
        zip.write_all(&manifest_json)
            .map_err(|e| format!("zip write manifest.json: {e}"))?;

        zip.finish().map_err(|e| format!("zip finish: {e}"))?;

        if let Some(app) = app {
            emit_progress(app, 100, "done");
        }

        Ok(ExportSummary {
            entry_count,
            journal_count,
            tag_count,
            media_count: total_media_count,
            media_skipped,
        })
    })
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Export journal data to a file at `dest`.
///
/// - `format`: `"memlore_json"` (default), `"plain_text"`.
/// - `scope`: `{"kind":"all"}`, `{"kind":"journal","journal_id":"…"}`,
///   `{"kind":"date_range","start":…,"end":…}`.
///
/// Returns an error if the encryption key is not set (app is locked).
#[tauri::command]
pub fn export_data(
    app: AppHandle,
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    dest: String,
    format: Option<ExportFormat>,
    scope: Option<ExportScope>,
) -> Result<ExportSummary, String> {
    export_data_after_catchup_guard(
        Some(&app),
        &state,
        &key_state,
        dest,
        format.unwrap_or_default(),
        scope.unwrap_or_default(),
    )
}

/// Receives frontend-rendered Markdown content and packages it into a zip.
///
/// `entries` is an array of `[filename, markdown_content]` pairs.
/// Progress events (`export:progress`) are emitted as files are written.
///
/// # Known limitation
/// The entire rendered Markdown payload is serialised through Tauri IPC in a
/// single call.  For very large journals (1000+ entries, ~10 MB+) this can
/// cause a visible UI freeze during `JSON.stringify` on the frontend.
/// TODO: stream entries in batches or move Markdown rendering to Rust to
/// eliminate the IPC bottleneck (follow-up, post-Phase 5 MVP).
#[tauri::command]
pub fn write_markdown_zip(
    app: AppHandle,
    dest: String,
    entries: Vec<(String, String)>,
) -> Result<u64, String> {
    let dest_path = PathBuf::from(&dest);
    let tmp_path = {
        let mut p = dest_path.clone();
        let mut name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("export")
            .to_string();
        name.push_str(".tmp");
        p.set_file_name(name);
        p
    };

    let result = write_markdown_zip_to_path(&app, &tmp_path, &entries);

    match result {
        Ok(count) => {
            std::fs::rename(&tmp_path, &dest_path)
                .map_err(|e| format!("Failed to finalize markdown zip: {e}"))?;
            Ok(count)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

fn write_markdown_zip_to_path(
    app: &AppHandle,
    dest_path: &PathBuf,
    entries: &[(String, String)],
) -> Result<u64, String> {
    emit_progress(app, 5, "writing");
    let count = write_markdown_zip_inner(dest_path, entries)?;
    emit_progress(app, 100, "done");
    Ok(count)
}

/// Core zip writer — no AppHandle dependency, safe to call from tests.
pub(crate) fn write_markdown_zip_inner(
    dest_path: &PathBuf,
    entries: &[(String, String)],
) -> Result<u64, String> {
    let file = std::fs::File::create(dest_path)
        .map_err(|e| format!("Failed to create markdown zip: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut written = 0u64;
    for (filename, content) in entries.iter() {
        // Sanitize the filename — replace any path separators.
        let safe_name = filename.replace(['/', '\\'], "-");
        if safe_name.is_empty() || safe_name.contains('\0') {
            log::warn!("write_markdown_zip: skipping unsafe filename: {filename}");
            continue;
        }
        zip.start_file(&safe_name, opts)
            .map_err(|e| format!("zip start {safe_name}: {e}"))?;
        zip.write_all(content.as_bytes())
            .map_err(|e| format!("zip write {safe_name}: {e}"))?;
        written += 1;
    }

    zip.finish().map_err(|e| format!("zip finish: {e}"))?;

    Ok(written)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::db::schema::migrate;
    use crate::utils::encryption::{derive_encryption_key, SALT_SIZE};
    use crate::{AppState, EncryptionKeyState};
    use rusqlite::Connection;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    fn make_key_state() -> EncryptionKeyState {
        let ks = EncryptionKeyState::new();
        let key = derive_encryption_key("test-password-1234", &[9u8; SALT_SIZE]).unwrap();
        ks.set_key(key).unwrap();
        ks
    }

    fn journal_id(state: &AppState) -> String {
        let conn = state.lock().unwrap();
        crate::db::list_journals(&conn, None).unwrap()[0].id.clone()
    }

    #[test]
    fn configured_sync_with_incomplete_catchup_refuses_export_before_writing() {
        let state = make_state();
        let key_state = make_key_state();
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("blocked.memlore.zip");
        let conn = state.lock().unwrap();
        crate::db::set_sync_provider(&conn, "local").unwrap();
        crate::db::set_sync_config_json(&conn, "{\"root_path\":\"/tmp/memlore-sync\"}").unwrap();
        crate::db::set_sync_enabled(&conn, true).unwrap();
        crate::db::set_sync_catchup_complete(&conn, false).unwrap();
        drop(conn);

        let error = super::export_data_after_catchup_guard(
            None,
            &state,
            &key_state,
            output.to_string_lossy().into_owned(),
            super::ExportFormat::MemloreJson,
            super::ExportScope::All,
        )
        .unwrap_err();

        assert_eq!(error, "SYNC_CATCHUP_INCOMPLETE: pulled=0 total=0");
        assert!(
            !output.exists(),
            "the entry guard must refuse before an export path is written"
        );
    }

    #[test]
    fn configured_sync_with_complete_catchup_allows_export() {
        let state = make_state();
        let key_state = make_key_state();
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("complete.memlore.zip");
        let conn = state.lock().unwrap();
        crate::db::set_sync_provider(&conn, "local").unwrap();
        crate::db::set_sync_config_json(&conn, "{\"root_path\":\"/tmp/memlore-sync\"}").unwrap();
        crate::db::set_sync_enabled(&conn, true).unwrap();
        crate::db::set_sync_catchup_complete(&conn, true).unwrap();
        drop(conn);

        super::export_data_after_catchup_guard(
            None,
            &state,
            &key_state,
            output.to_string_lossy().into_owned(),
            super::ExportFormat::MemloreJson,
            super::ExportScope::All,
        )
        .unwrap();

        assert!(output.exists());
    }

    #[test]
    fn local_only_export_is_allowed_when_catchup_is_incomplete() {
        let state = make_state();
        let key_state = make_key_state();
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("local-only.memlore.zip");
        let conn = state.lock().unwrap();
        crate::db::set_sync_catchup_complete(&conn, false).unwrap();
        drop(conn);

        super::export_data_after_catchup_guard(
            None,
            &state,
            &key_state,
            output.to_string_lossy().into_owned(),
            super::ExportFormat::MemloreJson,
            super::ExportScope::All,
        )
        .unwrap();

        assert!(output.exists());
    }

    #[test]
    fn partial_local_sync_config_does_not_block_export_while_catchup_is_incomplete() {
        let state = make_state();
        let key_state = make_key_state();
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("partial-local.memlore.zip");
        let conn = state.lock().unwrap();
        crate::db::set_sync_provider(&conn, "local").unwrap();
        crate::db::set_sync_enabled(&conn, true).unwrap();
        crate::db::set_sync_catchup_complete(&conn, false).unwrap();
        drop(conn);

        super::export_data_after_catchup_guard(
            None,
            &state,
            &key_state,
            output.to_string_lossy().into_owned(),
            super::ExportFormat::MemloreJson,
            super::ExportScope::All,
        )
        .unwrap();

        assert!(output.exists());
    }

    #[test]
    fn partial_gdrive_sync_config_does_not_block_export_while_catchup_is_incomplete() {
        let state = make_state();
        let key_state = make_key_state();
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("partial-gdrive.memlore.zip");
        let conn = state.lock().unwrap();
        crate::db::set_sync_provider(&conn, "gdrive").unwrap();
        crate::db::set_sync_enabled(&conn, true).unwrap();
        crate::db::set_sync_catchup_complete(&conn, false).unwrap();
        drop(conn);

        super::export_data_after_catchup_guard(
            None,
            &state,
            &key_state,
            output.to_string_lossy().into_owned(),
            super::ExportFormat::MemloreJson,
            super::ExportScope::All,
        )
        .unwrap();

        assert!(output.exists());
    }

    #[test]
    fn configured_gdrive_sync_with_refresh_token_refuses_export_while_catchup_is_incomplete() {
        let state = make_state();
        let key_state = make_key_state();
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("configured-gdrive.memlore.zip");
        let conn = state.lock().unwrap();
        crate::db::set_setting(&conn, "gdrive_refresh_token", "1//test-refresh-token").unwrap();
        crate::db::set_sync_provider(&conn, "gdrive").unwrap();
        crate::db::set_sync_enabled(&conn, true).unwrap();
        crate::db::set_sync_catchup_complete(&conn, false).unwrap();
        drop(conn);

        let error = super::export_data_after_catchup_guard(
            None,
            &state,
            &key_state,
            output.to_string_lossy().into_owned(),
            super::ExportFormat::MemloreJson,
            super::ExportScope::All,
        )
        .unwrap_err();

        assert_eq!(error, "SYNC_CATCHUP_INCOMPLETE: pulled=0 total=0");
    }

    // ── Test 1: export writes a valid zip with manifest + entries ────────────
    #[test]
    fn export_data_round_trips_one_entry() {
        use std::io::Read as _;

        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        // Insert one entry (Phase 3: plaintext directly — no encryption fixture).
        {
            let conn = state.lock().unwrap();
            crate::db::create_entry(
                &conn,
                crate::db::CreateEntryParams {
                    journal_id: &jid,
                    title: Some("Test Entry"),
                    content_text: Some("body text"),
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap();
        }

        // Insert a tag.
        {
            let conn = state.lock().unwrap();
            crate::db::create_tag(&conn, "work", None).unwrap();
        }

        let dest_dir = tempfile::tempdir().expect("tempdir");
        let dest = dest_dir.path().join("export.memlore.zip");
        let dest_str = dest.to_string_lossy().to_string();

        let summary = super::export_data_inner(
            None,
            &state,
            &ks,
            dest_str,
            super::ExportFormat::MemloreJson,
            super::ExportScope::All,
        )
        .expect("export should succeed");

        assert_eq!(summary.entry_count, 1, "one entry exported");
        assert_eq!(summary.journal_count, 1, "one journal exported");
        assert_eq!(summary.tag_count, 1, "one tag exported");
        assert_eq!(summary.media_count, 0, "no media");
        assert_eq!(summary.media_skipped, 0, "nothing skipped");

        // Open the zip and verify contents.
        let file = std::fs::File::open(&dest).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("parse zip");

        // manifest.json must exist and parse.
        let mut manifest_bytes = Vec::new();
        archive
            .by_name("manifest.json")
            .expect("manifest.json in zip")
            .read_to_end(&mut manifest_bytes)
            .expect("read manifest");
        let manifest: serde_json::Value =
            serde_json::from_slice(&manifest_bytes).expect("parse manifest json");
        assert_eq!(manifest["schema_version"], 2u64);
        assert_eq!(manifest["entry_count"], 1u64);
        assert_eq!(manifest["journal_count"], 1u64);
        assert_eq!(manifest["tag_count"], 1u64);

        // entries.jsonl must exist and contain one JSON line.
        let mut entries_bytes = Vec::new();
        archive
            .by_name("entries.jsonl")
            .expect("entries.jsonl in zip")
            .read_to_end(&mut entries_bytes)
            .expect("read entries");
        let entries_text = String::from_utf8(entries_bytes).expect("utf8");
        let lines: Vec<&str> = entries_text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .collect();
        assert_eq!(lines.len(), 1, "one JSONL line");
        let entry_obj: serde_json::Value = serde_json::from_str(lines[0]).expect("valid json line");
        assert_eq!(entry_obj["title"], "Test Entry");
    }

    #[test]
    fn export_data_excludes_invisible_entries() {
        use std::io::Read as _;

        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);
        let invisible_jid = {
            let conn = state.lock().unwrap();
            crate::db::create_journal(&conn, "Invisible Journal", None)
                .unwrap()
                .id
        };

        {
            let conn = state.lock().unwrap();
            crate::db::create_entry(
                &conn,
                crate::db::CreateEntryParams {
                    journal_id: &jid,
                    title: Some("Visible Entry"),
                    content_text: Some("visible body"),
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap();
            let direct_invisible = crate::db::create_entry(
                &conn,
                crate::db::CreateEntryParams {
                    journal_id: &jid,
                    title: Some("Direct Invisible Entry"),
                    content_text: Some("hidden body"),
                    preview_text: None,
                    entry_date: 1_700_000_001,
                },
            )
            .unwrap();
            crate::db::create_entry(
                &conn,
                crate::db::CreateEntryParams {
                    journal_id: &invisible_jid,
                    title: Some("Journal Invisible Entry"),
                    content_text: Some("journal hidden body"),
                    preview_text: None,
                    entry_date: 1_700_000_002,
                },
            )
            .unwrap();
            crate::db::set_entry_invisible(&conn, &direct_invisible.id, true, Some("test-vault"))
                .unwrap();
            crate::db::set_journal_invisible(&conn, &invisible_jid, true, Some("test-vault"))
                .unwrap();
        }

        let dest_dir = tempfile::tempdir().expect("tempdir");
        let dest = dest_dir.path().join("export.memlore.zip");
        let summary = super::export_data_inner(
            None,
            &state,
            &ks,
            dest.to_string_lossy().to_string(),
            super::ExportFormat::MemloreJson,
            super::ExportScope::All,
        )
        .expect("export should succeed");

        assert_eq!(
            summary.entry_count, 1,
            "manifest/summary entry_count matches visible entries.jsonl lines"
        );
        assert_eq!(
            summary.journal_count, 1,
            "manifest/summary journal_count must exclude invisible journals"
        );

        let file = std::fs::File::open(&dest).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("parse zip");
        let mut entries_bytes = Vec::new();
        archive
            .by_name("entries.jsonl")
            .expect("entries.jsonl in zip")
            .read_to_end(&mut entries_bytes)
            .expect("read entries");
        let entries_text = String::from_utf8(entries_bytes).expect("utf8");
        assert!(entries_text.contains("Visible Entry"));
        assert!(!entries_text.contains("Direct Invisible Entry"));
        assert!(!entries_text.contains("Journal Invisible Entry"));

        let mut journals_bytes = Vec::new();
        archive
            .by_name("journals.json")
            .expect("journals.json in zip")
            .read_to_end(&mut journals_bytes)
            .expect("read journals");
        let journals_text = String::from_utf8(journals_bytes).expect("utf8");
        assert!(
            !journals_text.contains("Invisible Journal"),
            "journals.json must not leak invisible journals"
        );
        assert!(
            !journals_text.contains(&invisible_jid),
            "journals.json must not include invisible journal id"
        );
    }

    // ── Test 2: export returns Err when app is locked ────────────────────────
    #[test]
    fn export_data_errors_when_app_locked() {
        let state = make_state();
        let ks = EncryptionKeyState::new(); // key NOT set → locked

        let dest_dir = tempfile::tempdir().expect("tempdir");
        let dest = dest_dir.path().join("export.memlore.zip");
        let dest_str = dest.to_string_lossy().to_string();

        let result = super::export_data_inner(
            None,
            &state,
            &ks,
            dest_str,
            super::ExportFormat::default(),
            super::ExportScope::default(),
        );
        assert!(result.is_err(), "should return Err when locked");
        let msg = result.unwrap_err();
        assert!(
            msg.to_lowercase().contains("locked"),
            "error message should mention 'locked', got: {msg}"
        );
    }

    // ── Test 3: export handles empty journal ─────────────────────────────────
    #[test]
    fn export_data_handles_empty_journal() {
        use std::io::Read as _;

        let state = make_state();
        let ks = make_key_state();

        let dest_dir = tempfile::tempdir().expect("tempdir");
        let dest = dest_dir.path().join("export.memlore.zip");
        let dest_str = dest.to_string_lossy().to_string();

        let summary = super::export_data_inner(
            None,
            &state,
            &ks,
            dest_str,
            super::ExportFormat::default(),
            super::ExportScope::default(),
        )
        .expect("export should succeed");
        assert_eq!(summary.entry_count, 0);

        let file = std::fs::File::open(&dest).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("parse zip");

        let mut manifest_bytes = Vec::new();
        archive
            .by_name("manifest.json")
            .expect("manifest.json")
            .read_to_end(&mut manifest_bytes)
            .unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(manifest["entry_count"], 0u64);

        let mut entries_bytes = Vec::new();
        archive
            .by_name("entries.jsonl")
            .expect("entries.jsonl")
            .read_to_end(&mut entries_bytes)
            .unwrap();
        let text = String::from_utf8(entries_bytes).unwrap();
        let non_empty_lines = text.lines().filter(|l| !l.trim().is_empty()).count();
        assert_eq!(non_empty_lines, 0, "no entry lines");
    }

    // ── Test 4: schema_version is always 2 (Phase 3 plaintext schema) ─────────
    #[test]
    fn export_writes_stable_schema_version() {
        use std::io::Read as _;

        let state = make_state();
        let ks = make_key_state();

        let dest_dir = tempfile::tempdir().expect("tempdir");
        let dest = dest_dir.path().join("export.memlore.zip");
        let dest_str = dest.to_string_lossy().to_string();

        super::export_data_inner(
            None,
            &state,
            &ks,
            dest_str,
            super::ExportFormat::default(),
            super::ExportScope::default(),
        )
        .expect("export should succeed");

        let file = std::fs::File::open(&dest).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("parse zip");
        let mut bytes = Vec::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            manifest["schema_version"], 2u64,
            "schema_version must be 2 (Phase 3 plaintext fields)"
        );
    }

    // ── Test 5: scope filtering — journal scope ───────────────────────────────
    #[test]
    fn export_data_scope_filters_by_journal() {
        use std::io::Read as _;

        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        // Create a second journal and add an entry to it.
        let second_jid = {
            let conn = state.lock().unwrap();
            crate::db::create_journal(&conn, "Second Journal", None)
                .map_err(|e| e.to_string())
                .unwrap()
                .id
        };

        // Insert entry in first journal (Phase 3: plaintext).
        {
            let conn = state.lock().unwrap();
            crate::db::create_entry(
                &conn,
                crate::db::CreateEntryParams {
                    journal_id: &jid,
                    title: Some("J1 Entry"),
                    content_text: None,
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap();
        }

        // Insert entry in second journal (Phase 3: plaintext).
        {
            let conn = state.lock().unwrap();
            crate::db::create_entry(
                &conn,
                crate::db::CreateEntryParams {
                    journal_id: &second_jid,
                    title: Some("J2 Entry"),
                    content_text: None,
                    preview_text: None,
                    entry_date: 1_700_000_001,
                },
            )
            .unwrap();
        }

        let dest_dir = tempfile::tempdir().expect("tempdir");
        let dest = dest_dir.path().join("export.memlore.zip");
        let dest_str = dest.to_string_lossy().to_string();

        // Export only second journal.
        let summary = super::export_data_inner(
            None,
            &state,
            &ks,
            dest_str,
            super::ExportFormat::MemloreJson,
            super::ExportScope::Journal {
                journal_id: second_jid.clone(),
            },
        )
        .expect("export should succeed");

        assert_eq!(summary.entry_count, 1, "only second journal entry exported");

        let file = std::fs::File::open(&dest).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("parse zip");
        let mut entries_bytes = Vec::new();
        archive
            .by_name("entries.jsonl")
            .unwrap()
            .read_to_end(&mut entries_bytes)
            .unwrap();
        let text = String::from_utf8(entries_bytes).unwrap();
        assert!(text.contains("J2 Entry"), "J2 entry in output");
        assert!(!text.contains("J1 Entry"), "J1 entry not in output");
    }

    // ── Test 6: plain text export ────────────────────────────────────────────
    #[test]
    fn export_plain_text_creates_txt_files() {
        use std::io::Read as _;

        let state = make_state();
        let ks = make_key_state();
        let jid = journal_id(&state);

        // Phase 3: plaintext directly — no encryption fixture.
        {
            let conn = state.lock().unwrap();
            crate::db::create_entry(
                &conn,
                crate::db::CreateEntryParams {
                    journal_id: &jid,
                    title: Some("Plain Title"),
                    content_text: Some("body"),
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap();
        }

        let dest_dir = tempfile::tempdir().expect("tempdir");
        let dest = dest_dir.path().join("export.zip");
        let dest_path = dest.to_string_lossy().to_string();

        let summary = super::export_data_inner(
            None,
            &state,
            &ks,
            dest_path,
            super::ExportFormat::PlainText,
            super::ExportScope::All,
        )
        .expect("export should succeed");
        assert_eq!(summary.entry_count, 1);

        let file = std::fs::File::open(&dest).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("parse zip");
        assert_eq!(archive.len(), 1, "one .txt file in zip");
        let mut buf = Vec::new();
        archive.by_index(0).unwrap().read_to_end(&mut buf).unwrap();
        let content = String::from_utf8(buf).unwrap();
        assert!(content.contains("Plain Title"), "title in txt");
    }

    // ── Test 7: write_markdown_zip creates zip from entries ──────────────────
    #[test]
    fn write_markdown_zip_creates_valid_zip() {
        use std::io::Read as _;

        let dest_dir = tempfile::tempdir().expect("tempdir");
        let dest = dest_dir.path().join("md-export.zip");

        let entries = vec![
            (
                "2024-01-01-entry.md".to_string(),
                "# Hello\n\nWorld".to_string(),
            ),
            (
                "2024-01-02-entry.md".to_string(),
                "# Second\n\nEntry".to_string(),
            ),
        ];

        let count = super::write_markdown_zip_inner(&dest, &entries).expect("write should succeed");
        assert_eq!(count, 2, "two files written");

        let file = std::fs::File::open(&dest).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("parse zip");
        assert_eq!(archive.len(), 2, "two files in zip");

        let mut buf = Vec::new();
        archive
            .by_name("2024-01-01-entry.md")
            .expect("first md file")
            .read_to_end(&mut buf)
            .unwrap();
        assert_eq!(String::from_utf8(buf).unwrap(), "# Hello\n\nWorld");
    }

    // ── Test 8: write_markdown_zip skips unsafe names, returns written count ─
    #[test]
    fn write_markdown_zip_skips_unsafe_filenames() {
        let dest_dir = tempfile::tempdir().expect("tempdir");
        let dest = dest_dir.path().join("md-safe.zip");

        let entries = vec![
            ("good.md".to_string(), "content".to_string()),
            ("".to_string(), "empty-name-skipped".to_string()),
            ("also-good.md".to_string(), "more".to_string()),
        ];

        let written =
            super::write_markdown_zip_inner(&dest, &entries).expect("write should succeed");
        assert_eq!(written, 2, "only two valid filenames written");

        let file = std::fs::File::open(&dest).expect("open zip");
        let archive = zip::ZipArchive::new(file).expect("parse zip");
        assert_eq!(archive.len(), 2, "zip contains exactly two files");
    }

    // ── format_iso8601_utc spot checks ───────────────────────────────────────
    #[test]
    fn format_iso8601_epoch_is_correct() {
        assert_eq!(super::format_iso8601_utc(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn format_iso8601_known_timestamp() {
        // 2024-01-15T11:50:45Z = 1705319445 (verified with Python datetime.utcfromtimestamp)
        assert_eq!(
            super::format_iso8601_utc(1_705_319_445),
            "2024-01-15T11:50:45Z"
        );
    }
}
