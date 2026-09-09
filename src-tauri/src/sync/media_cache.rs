//! Bounded LRU cache for cloud-downloaded media.
//!
//! Only full-media files are evictable. Pending-upload originals are the
//! source of truth on this device and are never counted or touched. Thumbnails
//! are small and always kept (the gallery needs them to render fast) — they
//! live beside media files but are not subject to eviction.
//!
//! `last_accessed_at` is bumped by `resolve_media` on every cache hit; this
//! module orders by that column to evict the least-recently-used file first.

use rusqlite::Connection;

use crate::db;

/// Result of a cache-enforcement pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EvictionStats {
    pub evicted_count: u64,
    pub bytes_freed: i64,
}

/// Bring the cache under `max_bytes` by deleting the least-recently-accessed
/// uploaded-media files. For each evicted row:
///   - the file at `storage_path` is removed from disk (best-effort — a stale
///     row with a missing file is still cleared in the DB),
///   - `storage_path` is set to `""` in the DB (the row itself survives because
///     the cloud still holds the ciphertext; `resolve_media` can re-fetch on
///     demand).
///
/// Pending uploads and error rows are never touched — they're the source of
/// truth until the sync engine persists them to cloud.
pub fn enforce_cache_limit(conn: &Connection, max_bytes: i64) -> rusqlite::Result<EvictionStats> {
    let mut stats = EvictionStats::default();
    let mut current = db::sum_evictable_cache_bytes(conn)?;
    if current <= max_bytes {
        return Ok(stats);
    }

    let evictable = db::list_evictable_media(conn)?;
    for media in evictable {
        if current <= max_bytes {
            break;
        }
        let bytes = media.file_size.unwrap_or(0);
        // Best-effort unlink; a missing file still frees the DB-tracked bytes.
        if !media.storage_path.is_empty() {
            if let Err(e) = std::fs::remove_file(&media.storage_path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("media_cache: failed to remove {}: {e}", media.storage_path);
                }
            }
        }
        // Clear storage_path so resolve_media falls through to the cloud
        // fetch path on next access. `sum_evictable_cache_bytes` also filters
        // on non-empty storage_path, so this row no longer counts against
        // the cache total.
        if let Err(e) = db::update_media_storage_path(conn, &media.id, "") {
            log::warn!("media_cache: clear storage_path for {}: {e}", media.id);
            continue;
        }
        stats.evicted_count += 1;
        stats.bytes_freed += bytes;
        current -= bytes;
    }
    Ok(stats)
}

/// Forcibly clear every evictable cache file, regardless of the size ceiling.
/// Called from the Settings UI "Clear cache" button.
pub fn clear_all_cache(conn: &Connection) -> rusqlite::Result<EvictionStats> {
    // Pass 0 as the ceiling — every evictable row fails the <= check and
    // gets evicted.
    enforce_cache_limit(conn, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::db::{
        create_entry, create_journal, create_media, CreateEntryParams, CreateMediaParams,
    };
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn setup() -> (Connection, TempDir, String) {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let jid = create_journal(&conn, "J", None).unwrap().id;
        let entry_id = create_entry(
            &conn,
            CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap()
        .id;
        let dir = TempDir::new().unwrap();
        (conn, dir, entry_id)
    }

    /// Create an uploaded media row with a real file on disk of `size` bytes.
    fn add_uploaded(
        conn: &Connection,
        dir: &TempDir,
        entry_id: &str,
        tag: &str,
        size: usize,
        accessed: Option<i64>,
    ) -> String {
        let file_path = dir.path().join(format!("{tag}.bin"));
        std::fs::write(&file_path, vec![0u8; size]).unwrap();
        let media = create_media(
            conn,
            CreateMediaParams {
                entry_id,
                file_name: &format!("{tag}.bin"),
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(size as i64),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        let cloud_path = format!("dev-a/media/{}", media.id);
        db::mark_media_uploaded(conn, &media.id, &cloud_path, 1_700_000_000).unwrap();
        if let Some(ts) = accessed {
            db::bump_media_accessed(conn, &media.id, ts).unwrap();
        }
        media.id
    }

    #[test]
    fn noop_when_under_limit() {
        let (conn, dir, eid) = setup();
        add_uploaded(&conn, &dir, &eid, "a", 100, Some(1));
        add_uploaded(&conn, &dir, &eid, "b", 100, Some(2));

        let stats = enforce_cache_limit(&conn, 1000).unwrap();
        assert_eq!(stats.evicted_count, 0);
        assert_eq!(stats.bytes_freed, 0);
    }

    #[test]
    fn evicts_oldest_access_first_until_under_limit() {
        let (conn, dir, eid) = setup();
        let id_old = add_uploaded(&conn, &dir, &eid, "old", 400, Some(1000));
        let id_mid = add_uploaded(&conn, &dir, &eid, "mid", 400, Some(2000));
        let id_new = add_uploaded(&conn, &dir, &eid, "new", 400, Some(3000));

        // 1200 bytes total; ceiling 500 → need to evict enough to drop below 500.
        let stats = enforce_cache_limit(&conn, 500).unwrap();
        assert_eq!(stats.evicted_count, 2, "two files evicted");
        assert_eq!(stats.bytes_freed, 800);

        // Oldest + middle evicted, newest kept.
        let old = db::get_media(&conn, &id_old).unwrap().unwrap();
        let mid = db::get_media(&conn, &id_mid).unwrap().unwrap();
        let new = db::get_media(&conn, &id_new).unwrap().unwrap();
        assert_eq!(old.storage_path, "", "oldest cleared");
        assert_eq!(mid.storage_path, "", "middle cleared");
        assert_ne!(new.storage_path, "", "newest retained");
    }

    #[test]
    fn never_evicts_pending_uploads() {
        let (conn, dir, eid) = setup();

        // Pending upload — the local original, source of truth.
        let pending_path = dir.path().join("pending.bin");
        std::fs::write(&pending_path, vec![0u8; 10_000]).unwrap();
        let pending = create_media(
            &conn,
            CreateMediaParams {
                entry_id: &eid,
                file_name: "pending.bin",
                file_type: "image/jpeg",
                storage_path: &pending_path.to_string_lossy(),
                file_size: Some(10_000),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();

        // A tiny uploaded file that alone already exceeds the ceiling.
        let id_cached = add_uploaded(&conn, &dir, &eid, "cached", 500, Some(1));

        // Ceiling 0 — everything evictable should go, but pending must stay.
        let stats = enforce_cache_limit(&conn, 0).unwrap();
        assert_eq!(stats.evicted_count, 1);
        assert_eq!(stats.bytes_freed, 500);

        let still_pending = db::get_media(&conn, &pending.id).unwrap().unwrap();
        assert_ne!(
            still_pending.storage_path, "",
            "pending original must not be evicted"
        );
        assert!(
            pending_path.exists(),
            "pending file must remain on disk — it is the source of truth"
        );

        let evicted = db::get_media(&conn, &id_cached).unwrap().unwrap();
        assert_eq!(evicted.storage_path, "");
    }

    #[test]
    fn never_accessed_files_evict_first() {
        let (conn, dir, eid) = setup();
        // `never` has no last_accessed_at; `recent` has a recent timestamp.
        let id_never = add_uploaded(&conn, &dir, &eid, "never", 400, None);
        let id_recent = add_uploaded(&conn, &dir, &eid, "recent", 400, Some(5000));

        // Ceiling forces exactly one eviction.
        let stats = enforce_cache_limit(&conn, 500).unwrap();
        assert_eq!(stats.evicted_count, 1);

        let never = db::get_media(&conn, &id_never).unwrap().unwrap();
        let recent = db::get_media(&conn, &id_recent).unwrap().unwrap();
        assert_eq!(never.storage_path, "");
        assert_ne!(recent.storage_path, "");
    }

    #[test]
    fn eviction_removes_file_from_disk() {
        let (conn, dir, eid) = setup();
        let id = add_uploaded(&conn, &dir, &eid, "deleteme", 1000, Some(1));
        let media = db::get_media(&conn, &id).unwrap().unwrap();
        let path_on_disk = media.storage_path.clone();
        assert!(std::path::Path::new(&path_on_disk).exists());

        enforce_cache_limit(&conn, 0).unwrap();
        assert!(
            !std::path::Path::new(&path_on_disk).exists(),
            "cache eviction must delete the file"
        );
    }

    #[test]
    fn eviction_tolerates_already_missing_file() {
        let (conn, dir, eid) = setup();
        let id = add_uploaded(&conn, &dir, &eid, "ghost", 1000, Some(1));
        let media = db::get_media(&conn, &id).unwrap().unwrap();
        std::fs::remove_file(&media.storage_path).unwrap(); // simulate user-side rm

        // Should not error even though the file is already gone.
        let stats = enforce_cache_limit(&conn, 0).unwrap();
        assert_eq!(stats.evicted_count, 1);

        // DB is still cleared.
        let cleared = db::get_media(&conn, &id).unwrap().unwrap();
        assert_eq!(cleared.storage_path, "");
    }

    #[test]
    fn clear_all_cache_evicts_everything_evictable() {
        let (conn, dir, eid) = setup();
        add_uploaded(&conn, &dir, &eid, "a", 100, Some(1));
        add_uploaded(&conn, &dir, &eid, "b", 100, Some(2));
        add_uploaded(&conn, &dir, &eid, "c", 100, Some(3));

        let stats = clear_all_cache(&conn).unwrap();
        assert_eq!(stats.evicted_count, 3);
        assert_eq!(stats.bytes_freed, 300);
    }
}
