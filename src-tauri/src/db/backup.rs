use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{params_from_iter, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};

const FULL_SNAPSHOT_VERSION: u32 = 1;

// `entry_embedding_jobs` (the device-local dirty queue) is deliberately NOT
// included here — it is transient/per-device state, not user data.
const FULL_SNAPSHOT_TABLES: &[&str] = &[
    "settings",
    "journals",
    "tags",
    "entries",
    "entry_tags",
    "media",
    "journal_auto_tags",
    "sync_state",
    "journal_sync_state",
    "entry_versions",
    "entry_embedding_chunks",
    "location_aliases",
    "templates",
    "streak_cache",
    "reminders",
    "chat_sessions",
    "chat_messages",
    "ai_audit_log",
    "google_fonts_catalog",
    "google_fonts_catalog_meta",
    "devices",
    "rotation_job",
    "rotation_job_items",
    "pending_first_time_setup",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullBackupSnapshot {
    pub snapshot_version: u32,
    pub tables: Vec<BackupTable>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupTable {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<BackupValue>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum BackupValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupMediaFile {
    pub id: String,
    pub file_name: String,
    pub storage_path: String,
}

pub fn export_full_snapshot(conn: &Connection) -> Result<FullBackupSnapshot> {
    let mut tables = Vec::with_capacity(FULL_SNAPSHOT_TABLES.len());
    for table_name in FULL_SNAPSHOT_TABLES {
        if !table_exists(conn, table_name)? {
            continue;
        }
        let columns = table_columns(conn, table_name)?;
        let rows = table_rows(conn, table_name, &columns)?;
        tables.push(BackupTable {
            name: (*table_name).to_string(),
            columns,
            rows,
        });
    }
    Ok(FullBackupSnapshot {
        snapshot_version: FULL_SNAPSHOT_VERSION,
        tables,
    })
}

pub fn restore_full_snapshot(conn: &Connection, snapshot: &FullBackupSnapshot) -> Result<()> {
    if snapshot.snapshot_version != FULL_SNAPSHOT_VERSION {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "unsupported full snapshot version {}",
            snapshot.snapshot_version
        )));
    }

    conn.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    for table_name in FULL_SNAPSHOT_TABLES.iter().rev() {
        if table_exists(conn, table_name)? {
            conn.execute(&format!("DELETE FROM {}", quote_ident(table_name)), [])?;
        }
    }

    for table_name in FULL_SNAPSHOT_TABLES {
        let Some(table) = snapshot.tables.iter().find(|t| t.name == *table_name) else {
            continue;
        };
        if table.columns.is_empty() {
            continue;
        }
        let columns = table_columns(conn, &table.name)?;
        if columns != table.columns {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "snapshot table {} columns do not match current schema",
                table.name
            )));
        }
        insert_table_rows(conn, table)?;
    }

    if table_exists(conn, "entries_fts")? {
        conn.execute("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')", [])?;
    }
    Ok(())
}

pub fn list_backup_media_files(conn: &Connection) -> Result<Vec<BackupMediaFile>> {
    let mut stmt = conn.prepare("SELECT id, file_name, storage_path FROM media ORDER BY id ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(BackupMediaFile {
            id: row.get(0)?,
            file_name: row.get(1)?,
            storage_path: row.get(2)?,
        })
    })?;
    rows.collect()
}

pub fn set_restored_media_storage_path(
    conn: &Connection,
    id: &str,
    storage_path: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE media SET storage_path = ?1, storage_provider = 'local' WHERE id = ?2",
        rusqlite::params![storage_path, id],
    )?;
    Ok(())
}

/// Rewrite `media.storage_path` / `thumbnail_path` entries that still live under
/// `from_dir` so they resolve under `to_dir` after an atomic directory rename
/// (cloud-authoritative commit). File basenames are preserved.
pub fn rebind_media_paths_after_dir_swap(
    conn: &Connection,
    from_dir: &std::path::Path,
    to_dir: &std::path::Path,
) -> Result<u64> {
    let rows = list_backup_media_files(conn)?;
    let from_prefix = from_dir.to_string_lossy();
    let mut remapped = 0u64;
    for row in rows {
        let mut changed = false;
        if !row.storage_path.is_empty() {
            let path = std::path::Path::new(&row.storage_path);
            if path.starts_with(from_dir) || row.storage_path.starts_with(from_prefix.as_ref()) {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| row.id.clone());
                let new_path = to_dir.join(name);
                set_restored_media_storage_path(conn, &row.id, &new_path.to_string_lossy())?;
                changed = true;
            }
        }
        let thumb: Option<String> = conn
            .query_row(
                "SELECT thumbnail_path FROM media WHERE id = ?1",
                [&row.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(thumb_path) = thumb {
            let path = std::path::Path::new(&thumb_path);
            if path.starts_with(from_dir) || thumb_path.starts_with(from_prefix.as_ref()) {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| format!("{}.thumb.jpg", row.id));
                let new_thumb = to_dir.join(name);
                conn.execute(
                    "UPDATE media SET thumbnail_path = ?1 WHERE id = ?2",
                    rusqlite::params![new_thumb.to_string_lossy().as_ref(), row.id],
                )?;
                changed = true;
            }
        }
        if changed {
            remapped += 1;
        }
    }
    Ok(remapped)
}

fn table_exists(conn: &Connection, table_name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [table_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn table_columns(conn: &Connection, table_name: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote_ident(table_name)))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

fn table_rows(
    conn: &Connection,
    table_name: &str,
    columns: &[String],
) -> Result<Vec<Vec<BackupValue>>> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }

    let select_list = columns
        .iter()
        .map(|col| quote_ident(col))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!(
        "SELECT {select_list} FROM {}",
        quote_ident(table_name)
    ))?;
    let column_count = columns.len();
    let rows = stmt.query_map([], |row| {
        let mut values = Vec::with_capacity(column_count);
        for idx in 0..column_count {
            values.push(backup_value_from_ref(row.get_ref(idx)?));
        }
        Ok(values)
    })?;
    rows.collect()
}

fn insert_table_rows(conn: &Connection, table: &BackupTable) -> Result<()> {
    if table.rows.is_empty() {
        return Ok(());
    }
    let columns = table
        .columns
        .iter()
        .map(|col| quote_ident(col))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=table.columns.len())
        .map(|idx| format!("?{idx}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {} ({columns}) VALUES ({placeholders})",
        quote_ident(&table.name)
    );
    let mut stmt = conn.prepare(&sql)?;
    for row in &table.rows {
        let values = row
            .iter()
            .map(sql_value_from_backup)
            .collect::<Result<Vec<_>>>()?;
        stmt.execute(params_from_iter(values))?;
    }
    Ok(())
}

fn backup_value_from_ref(value: ValueRef<'_>) -> BackupValue {
    match value {
        ValueRef::Null => BackupValue::Null,
        ValueRef::Integer(v) => BackupValue::Integer(v),
        ValueRef::Real(v) => BackupValue::Real(v),
        ValueRef::Text(v) => BackupValue::Text(String::from_utf8_lossy(v).into_owned()),
        ValueRef::Blob(v) => BackupValue::Blob(B64.encode(v)),
    }
}

fn sql_value_from_backup(value: &BackupValue) -> Result<Value> {
    let value = match value {
        BackupValue::Null => Value::Null,
        BackupValue::Integer(v) => Value::Integer(*v),
        BackupValue::Real(v) => Value::Real(*v),
        BackupValue::Text(v) => Value::Text(v.clone()),
        BackupValue::Blob(v) => Value::Blob(B64.decode(v).map_err(|e| {
            rusqlite::Error::InvalidParameterName(format!("invalid snapshot blob: {e}"))
        })?),
    };
    Ok(value)
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::db::{
        create_entry, create_journal, get_entry_content, save_entry_content, search_entries,
        set_setting, CreateEntryParams,
    };

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    #[test]
    fn export_full_snapshot_roundtrips_settings_and_entries() {
        let conn = setup();
        set_setting(&conn, "ui_language", "vi").expect("set setting");
        let jid = create_journal(&conn, "Backup Journal", None)
            .expect("journal")
            .id;
        let entry = create_entry(
            &conn,
            CreateEntryParams {
                journal_id: &jid,
                title: Some("Roundtrip"),
                content_text: Some("backup body"),
                preview_text: Some("backup body"),
                entry_date: 1_700_000_000,
            },
        )
        .expect("entry");

        let snapshot = export_full_snapshot(&conn).expect("export");
        assert_eq!(snapshot.snapshot_version, FULL_SNAPSHOT_VERSION);

        set_setting(&conn, "ui_language", "en").expect("overwrite setting");
        conn.execute("DELETE FROM entries", [])
            .expect("wipe entries");

        restore_full_snapshot(&conn, &snapshot).expect("restore");

        assert_eq!(
            crate::db::get_setting(&conn, "ui_language")
                .expect("read setting")
                .as_deref(),
            Some("vi")
        );
        let rows = crate::db::list_all_entries(&conn).expect("list entries");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, entry.id);
    }

    #[test]
    fn restore_full_snapshot_rejects_unsupported_version() {
        let conn = setup();
        let snapshot = FullBackupSnapshot {
            snapshot_version: FULL_SNAPSHOT_VERSION + 1,
            tables: Vec::new(),
        };
        let err = restore_full_snapshot(&conn, &snapshot).unwrap_err();
        assert!(
            err.to_string()
                .contains("unsupported full snapshot version"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn restore_full_snapshot_rejects_column_mismatch() {
        let conn = setup();
        set_setting(&conn, "ui_language", "vi").expect("seed setting");
        let mut snapshot = export_full_snapshot(&conn).expect("export");
        let settings = snapshot
            .tables
            .iter_mut()
            .find(|t| t.name == "settings")
            .expect("settings table in snapshot");
        settings.columns.push("phantom_column".to_string());

        let err = restore_full_snapshot(&conn, &snapshot).unwrap_err();
        assert!(
            err.to_string()
                .contains("columns do not match current schema"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn export_full_snapshot_encodes_blob_roundtrip() {
        let conn = setup();
        let jid = create_journal(&conn, "Blob Journal", None)
            .expect("journal")
            .id;
        let entry = create_entry(
            &conn,
            CreateEntryParams {
                journal_id: &jid,
                title: Some("Blob entry"),
                content_text: Some("body"),
                preview_text: Some("body"),
                entry_date: 1_700_000_001,
            },
        )
        .expect("entry");
        let yjs_bytes = b"\x00\x01\xffyjs-payload";
        save_entry_content(&conn, &entry.id, yjs_bytes, "body", "body").expect("save content");

        let snapshot = export_full_snapshot(&conn).expect("export");
        conn.execute("DELETE FROM entries", [])
            .expect("wipe entries");

        restore_full_snapshot(&conn, &snapshot).expect("restore");

        let restored = get_entry_content(&conn, &entry.id)
            .expect("read yjs")
            .expect("yjs present");
        assert_eq!(restored, yjs_bytes);
    }

    #[test]
    fn restore_full_snapshot_rebuilds_fts_index() {
        let conn = setup();
        let jid = create_journal(&conn, "Search Journal", None)
            .expect("journal")
            .id;
        create_entry(
            &conn,
            CreateEntryParams {
                journal_id: &jid,
                title: Some("Find me"),
                content_text: Some("unique-backup-fts-token"),
                preview_text: Some("unique-backup-fts-token"),
                entry_date: 1_700_000_002,
            },
        )
        .expect("entry");

        let snapshot = export_full_snapshot(&conn).expect("export");
        conn.execute_batch(
            "DELETE FROM entry_tags;
             DELETE FROM media;
             DELETE FROM entries;
             INSERT INTO entries_fts(entries_fts) VALUES('rebuild');",
        )
        .expect("wipe entries");

        restore_full_snapshot(&conn, &snapshot).expect("restore");

        let hits = search_entries(&conn, "unique-backup-fts-token", None).expect("search");
        assert_eq!(hits.len(), 1, "FTS index usable after snapshot restore");
    }
}
