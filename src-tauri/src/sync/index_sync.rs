//! Month index writer (`{device}/index/<YYYY-MM>.bin` + `index/months.bin`).
//!
//! The web reads these to list entries without opening every entry file.
//! Each file is a `MonthIndexPayload` / `MonthIndexCatalog` JSON sealed with
//! the sync key as a bare envelope, like `tags.bin` (web: `openDeviceBin`).
//!
//! Change tracking reuses `sync_push_state`: one row per month under
//! [`MONTH_HASH_PREFIX`]`<YYYY-MM>`, plus [`CATALOG_HASH_KEY`] and
//! [`FINGERPRINT_KEY`]. Every reset path calls `clear_all_surface_push_hashes`,
//! which wipes these rows too, so a cloud cleanup or re-pair forces a full
//! rewrite. These keys are NOT in `HASH_GATED_SURFACE_NAMES` (that list maps
//! to device-root `.bin` files).
//!
//! Older desktops never list `index/`, and readers only trust it when the
//! manifest says `index_present`. Any failed cycle clears that flag, so a
//! month file that could still hold a newly locked entry is never trusted.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use memlore_core::month_index::{
    is_month_index_file_name, is_month_key, month_key, MonthIndexCatalog, MonthIndexCatalogMonth,
    MonthIndexPayload, MonthIndexRow, MONTH_INDEX_SCHEMA_VERSION,
};
use rusqlite::Connection;

use super::engine::ConnAccess;
use super::provider::{FileKind, SyncError, SyncProvider};
use crate::db;
use crate::utils::encryption::encrypt_data_with_state;
use crate::utils::time::now_unix;
use crate::EncryptionKeyState;

/// `sync_push_state` key prefix for one month: `index:<YYYY-MM>`.
pub(crate) const MONTH_HASH_PREFIX: &str = "index:";
/// `sync_push_state` key of the last catalog written. Its presence is the
/// persisted `index_present` flag (see [`index_present`]).
pub(crate) const CATALOG_HASH_KEY: &str = "index:catalog";
/// `sync_push_state` key of the [`db::month_index_fingerprint`] the last
/// fully successful cycle was built from.
pub(crate) const FINGERPRINT_KEY: &str = "index:fingerprint";
const CATALOG_FILE: &str = "months.bin";

fn sync_io(e: rusqlite::Error) -> SyncError {
    SyncError::Io(e.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

fn ser_err(e: serde_json::Error) -> SyncError {
    SyncError::Serialization(e.to_string())
}

/// Group rows by UTC month of `entry_date`, keeping the query order.
fn bucket_rows_by_month(rows: Vec<MonthIndexRow>) -> BTreeMap<String, Vec<MonthIndexRow>> {
    let mut months: BTreeMap<String, Vec<MonthIndexRow>> = BTreeMap::new();
    for row in rows {
        months
            .entry(month_key(row.entry_date))
            .or_default()
            .push(row);
    }
    months
}

/// `<YYYY-MM>` of a listed `{device}/index/<YYYY-MM>.bin`, else `None`
/// (the catalog and any unexpected name are never treated as a month).
fn listed_month(path: &str, prefix: &str) -> Option<String> {
    let stem = path.strip_prefix(prefix)?.strip_suffix(".bin")?;
    is_month_key(stem).then(|| stem.to_string())
}

/// True when the last cycle completed and no reset has happened since.
/// Any failed cycle clears it (see [`push_month_index`]).
pub(crate) fn index_present(conn: &Connection) -> Result<bool, SyncError> {
    Ok(db::get_surface_push_hash(conn, CATALOG_HASH_KEY)
        .map_err(sync_io)?
        .is_some())
}

/// One push cycle of the month index.
///
/// `list_cloud` (Manual, or once per session, like the own-cloud reconcile)
/// lists `index/` so missing files are re-uploaded; other cycles trust the
/// stored hashes. When the vault fingerprint is unchanged and (if listed)
/// nothing is missing, the cycle does nothing.
///
/// When the fingerprint moved, the catalog key is cleared before any write
/// and restored only after the catalog is in place, so a cycle cut short
/// (crash, quit) never leaves a stale index trusted. On any failure, including
/// the initial DB read, the catalog and fingerprint keys are cleared, so
/// `index_present` goes false until a later cycle completes, and the error
/// (aggregated across months) is returned. Never fatal to sync.
pub(crate) async fn push_month_index<C: ConnAccess>(
    provider: &dyn SyncProvider,
    access: &C,
    device_id: &str,
    ks: &EncryptionKeyState,
    list_cloud: bool,
) -> Result<(), SyncError> {
    let read = access.with_conn(|conn| {
        let fingerprint = db::month_index_fingerprint(conn).map_err(sync_io)?;
        let stored: BTreeMap<String, String> =
            db::list_surface_push_hashes_with_prefix(conn, MONTH_HASH_PREFIX)
                .map_err(sync_io)?
                .into_iter()
                .collect();
        Ok((fingerprint, stored))
    });
    let (fingerprint, stored) = match read {
        Ok(v) => v,
        Err(e) => {
            clear_index_present(access);
            return Err(e);
        }
    };
    let unchanged =
        stored.get(FINGERPRINT_KEY) == Some(&fingerprint) && stored.contains_key(CATALOG_HASH_KEY);
    if unchanged && !list_cloud {
        return Ok(());
    }
    // A rebuild is needed: stop trusting the old catalog before the first
    // write, so a cycle that dies midway leaves `index_present` false.
    // `rebuild` restores the key only once the catalog is in place.
    if !unchanged {
        if let Err(e) = access
            .with_conn(|conn| db::clear_surface_push_hash(conn, CATALOG_HASH_KEY).map_err(sync_io))
        {
            clear_index_present(access);
            return Err(e);
        }
    }
    let result = rebuild(
        provider, access, device_id, ks, list_cloud, unchanged, &stored,
    )
    .await;
    match result {
        Ok(()) => access.with_conn(|conn| {
            db::set_surface_push_hash(conn, FINGERPRINT_KEY, &fingerprint).map_err(sync_io)
        }),
        Err(e) => {
            clear_index_present(access);
            Err(e)
        }
    }
}

/// Best-effort clear of the catalog and fingerprint keys after a failure.
/// The caller's error wins; a second DB error here has nowhere better to go.
fn clear_index_present<C: ConnAccess>(access: &C) {
    let _ = access.with_conn(|conn| {
        db::clear_surface_push_hash(conn, CATALOG_HASH_KEY).map_err(sync_io)?;
        db::clear_surface_push_hash(conn, FINGERPRINT_KEY).map_err(sync_io)
    });
}

/// The write half of [`push_month_index`].
///
/// 1. List `index/` when asked (a listing failure aborts before any write).
///    With an unchanged fingerprint and nothing missing, stop there.
/// 2. Delete emptied months (stored key or listed file, no rows anymore),
///    clearing each key after its delete.
/// 3. Upload each month whose content hash changed or whose file is missing.
/// 4. Only if steps 2-3 had no failure, write `months.bin` LAST, so it never
///    names a hash not yet uploaded, then store its hash (the persisted
///    `index_present`), even when an identical catalog was already there.
///
/// Steps 2-3 continue past individual failures. Hashes are over the payload
/// JSON with `generated_at = 0` (wall clock must not bust the gate); the
/// catalog's `hash_hex` is that same month hash. Hashes are stored only
/// after a successful write, so failures retry.
async fn rebuild<C: ConnAccess>(
    provider: &dyn SyncProvider,
    access: &C,
    device_id: &str,
    ks: &EncryptionKeyState,
    list_cloud: bool,
    unchanged: bool,
    stored: &BTreeMap<String, String>,
) -> Result<(), SyncError> {
    let prefix = format!("{device_id}/index/");
    let catalog_path = format!("{prefix}{CATALOG_FILE}");
    let stored_months: BTreeSet<&str> = stored
        .keys()
        .filter_map(|k| k.strip_prefix(MONTH_HASH_PREFIX))
        .filter(|m| is_month_key(m))
        .collect();

    let listing: Option<HashSet<String>> = if list_cloud {
        let listed: HashSet<String> = provider
            .list_files(device_id, FileKind::Index)
            .await?
            .into_iter()
            .filter(|p| {
                p.strip_prefix(&prefix)
                    .is_some_and(is_month_index_file_name)
            })
            .collect();
        let complete = listed.contains(&catalog_path)
            && stored_months
                .iter()
                .all(|m| listed.contains(&format!("{prefix}{m}.bin")))
            && listed
                .iter()
                .filter_map(|p| listed_month(p, &prefix))
                .all(|m| stored_months.contains(m.as_str()));
        if unchanged && complete {
            return Ok(());
        }
        Some(listed)
    } else {
        None
    };
    let is_listed = |path: &str| listing.as_ref().is_none_or(|l| l.contains(path));

    let rows = access.with_conn(|conn| db::list_month_index_rows(conn).map_err(sync_io))?;
    let months = bucket_rows_by_month(rows);
    let generated_at = now_unix();
    let mut errors: Vec<String> = Vec::new();

    // Emptied months first: delete the file, clear the key only after, so a
    // failed delete is retried next cycle.
    let mut stale: BTreeSet<String> = stored_months
        .iter()
        .filter(|m| !months.contains_key(**m))
        .map(|m| m.to_string())
        .collect();
    if let Some(listed) = &listing {
        stale.extend(
            listed
                .iter()
                .filter_map(|p| listed_month(p, &prefix))
                .filter(|m| !months.contains_key(m)),
        );
    }
    for month in &stale {
        let path = format!("{prefix}{month}.bin");
        if is_listed(&path) {
            if let Err(e) = provider.delete_file(&path).await {
                errors.push(format!("delete {month}: {e}"));
                continue;
            }
        }
        access.with_conn(|conn| {
            db::clear_surface_push_hash(conn, &format!("{MONTH_HASH_PREFIX}{month}"))
                .map_err(sync_io)
        })?;
    }

    let mut catalog_months = Vec::with_capacity(months.len());
    for (month, rows) in months {
        let mut payload = MonthIndexPayload {
            schema_version: MONTH_INDEX_SCHEMA_VERSION,
            device_id: device_id.to_string(),
            month,
            generated_at: 0,
            rows,
        };
        let hash = sha256_hex(&serde_json::to_vec(&payload).map_err(ser_err)?);
        let key = format!("{MONTH_HASH_PREFIX}{}", payload.month);
        let path = format!("{prefix}{}.bin", payload.month);
        if stored.get(&key) != Some(&hash) || !is_listed(&path) {
            payload.generated_at = generated_at;
            let plain = serde_json::to_vec(&payload).map_err(ser_err)?;
            let ct = encrypt_data_with_state(&plain, ks).map_err(SyncError::Serialization)?;
            match provider.write_file(&path, &ct).await {
                Ok(()) => access.with_conn(|conn| {
                    db::set_surface_push_hash(conn, &key, &hash).map_err(sync_io)
                })?,
                Err(e) => errors.push(format!("write {}: {e}", payload.month)),
            }
        }
        catalog_months.push(MonthIndexCatalogMonth {
            month: payload.month,
            hash_hex: hash,
            row_count: payload.rows.len() as u64,
        });
    }
    if !errors.is_empty() {
        return Err(SyncError::Network(format!(
            "month index: {}",
            errors.join("; ")
        )));
    }

    let mut catalog = MonthIndexCatalog {
        schema_version: MONTH_INDEX_SCHEMA_VERSION,
        device_id: device_id.to_string(),
        generated_at: 0,
        months: catalog_months,
    };
    let catalog_hash = sha256_hex(&serde_json::to_vec(&catalog).map_err(ser_err)?);
    // An identical catalog already in the cloud is not rewritten, but its key
    // (cleared by the caller before a rebuild) is restored below.
    if stored.get(CATALOG_HASH_KEY) != Some(&catalog_hash) || !is_listed(&catalog_path) {
        catalog.generated_at = generated_at;
        let plain = serde_json::to_vec(&catalog).map_err(ser_err)?;
        let ct = encrypt_data_with_state(&plain, ks).map_err(SyncError::Serialization)?;
        provider.write_file(&catalog_path, &ct).await?;
    }
    access.with_conn(|conn| {
        db::set_surface_push_hash(conn, CATALOG_HASH_KEY, &catalog_hash).map_err(sync_io)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::db::CreateEntryParams;
    use crate::sync::provider::test_support::MockProvider;
    use memlore_core::envelope::open_device_bin;
    use std::sync::Mutex;

    const DEV: &str = "dev-a";
    // 2023-11-14 and 2024-01-15 (UTC).
    const NOV: i64 = 1_700_000_000;
    const JAN: i64 = 1_705_300_000;

    /// Records every write/delete, counts listings, and can fail writes
    /// (all of them, or only to given paths).
    struct RecordingProvider {
        inner: MockProvider,
        ops: Mutex<Vec<String>>,
        lists: Mutex<usize>,
        fail_writes: Mutex<bool>,
        fail_paths: Mutex<HashSet<String>>,
        hang_writes: Mutex<bool>,
    }

    impl RecordingProvider {
        fn new() -> Self {
            Self {
                inner: MockProvider::new(),
                ops: Mutex::new(Vec::new()),
                lists: Mutex::new(0),
                fail_writes: Mutex::new(false),
                fail_paths: Mutex::new(HashSet::new()),
                hang_writes: Mutex::new(false),
            }
        }
        fn take_ops(&self) -> Vec<String> {
            std::mem::take(&mut *self.ops.lock().unwrap())
        }
        fn take_lists(&self) -> usize {
            std::mem::take(&mut *self.lists.lock().unwrap())
        }
        fn set_fail_writes(&self, fail: bool) {
            *self.fail_writes.lock().unwrap() = fail;
        }
        fn fail_path(&self, path: String) {
            self.fail_paths.lock().unwrap().insert(path);
        }
        fn clear_fail_paths(&self) {
            self.fail_paths.lock().unwrap().clear();
        }
        /// Writes never complete, so a timed-out cycle is dropped mid-rebuild,
        /// like a crash or quit.
        fn set_hang_writes(&self, hang: bool) {
            *self.hang_writes.lock().unwrap() = hang;
        }
    }

    #[async_trait::async_trait]
    impl SyncProvider for RecordingProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            *self.lists.lock().unwrap() += 1;
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            self.inner.read_file(path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.ops.lock().unwrap().push(format!("write {path}"));
            let hang = *self.hang_writes.lock().unwrap();
            if hang {
                std::future::pending::<()>().await;
            }
            if *self.fail_writes.lock().unwrap() || self.fail_paths.lock().unwrap().contains(path) {
                return Err(SyncError::Network("write failed".into()));
            }
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.ops.lock().unwrap().push(format!("delete {path}"));
            self.inner.delete_file(path).await
        }
    }

    /// Content key K as the web's key list holds it.
    const CONTENT_KEY: [u8; 32] = [7u8; 32];

    /// The engine receives `key` = derive_sync_key(K) and seals through
    /// `make_key_state(key)`, exactly like `push_hashed_surface`.
    fn key_state() -> EncryptionKeyState {
        let ks = EncryptionKeyState::new();
        ks.set_key(crate::utils::encryption::derive_sync_key(&CONTENT_KEY))
            .unwrap();
        ks
    }

    fn setup() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let journal = db::create_journal(&conn, "J", None).unwrap().id;
        (conn, journal)
    }

    fn entry(conn: &Connection, journal: &str, title: &str, date: i64) -> String {
        db::create_entry(
            conn,
            CreateEntryParams {
                journal_id: journal,
                title: Some(title),
                content_text: Some("body text"),
                preview_text: Some("body"),
                entry_date: date,
            },
        )
        .unwrap()
        .id
    }

    /// A listing cycle (Manual, or first of the session).
    async fn push(p: &RecordingProvider, conn: &Connection) -> Result<(), SyncError> {
        push_month_index(p, conn, DEV, &key_state(), true).await
    }

    /// A trust cycle: no listing, stored hashes are believed.
    async fn push_trusted(p: &RecordingProvider, conn: &Connection) -> Result<(), SyncError> {
        push_month_index(p, conn, DEV, &key_state(), false).await
    }

    fn open<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> T {
        let list = crate::ContentKeyList {
            keys: [(1u32, zeroize::Zeroizing::new(CONTENT_KEY))]
                .into_iter()
                .collect(),
            latest: 1,
            db_key: zeroize::Zeroizing::new([0u8; 32]),
            master: zeroize::Zeroizing::new(CONTENT_KEY),
        };
        serde_json::from_slice(&open_device_bin(&list, bytes).unwrap()).unwrap()
    }

    fn path(name: &str) -> String {
        format!("{DEV}/index/{name}")
    }

    #[tokio::test]
    async fn unchanged_months_are_not_reuploaded() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        entry(&conn, &j, "b", JAN);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        assert_eq!(p.take_ops().len(), 3);

        push(&p, &conn).await.unwrap();
        assert!(p.take_ops().is_empty());
        push_trusted(&p, &conn).await.unwrap();
        assert!(p.take_ops().is_empty());
    }

    /// Stored month hashes are not even compared while the fingerprint is
    /// unchanged: a bogus stored hash causes no rewrite.
    #[tokio::test]
    async fn unchanged_fingerprint_skips_the_rebuild() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        p.take_ops();
        assert!(db::get_surface_push_hash(&conn, FINGERPRINT_KEY)
            .unwrap()
            .is_some());

        db::set_surface_push_hash(&conn, "index:2023-11", "bogus").unwrap();
        push_trusted(&p, &conn).await.unwrap();
        push(&p, &conn).await.unwrap();
        assert!(p.take_ops().is_empty());
    }

    /// Only a listing cycle can notice a missing file; a trust cycle neither
    /// lists nor re-uploads.
    #[tokio::test]
    async fn trust_cycle_does_not_list_or_reupload_missing_month() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        assert_eq!(p.take_lists(), 1);
        p.inner.delete_file(&path("2023-11.bin")).await.unwrap();
        p.take_ops();

        // A change forces a rebuild, still without listing.
        entry(&conn, &j, "b", JAN);
        push_trusted(&p, &conn).await.unwrap();
        assert_eq!(p.take_lists(), 0);
        let ops = p.take_ops();
        assert!(!ops.contains(&format!("write {}", path("2023-11.bin"))));
        assert!(ops.contains(&format!("write {}", path("2024-01.bin"))));
    }

    async fn nov_ids(p: &RecordingProvider) -> Vec<String> {
        let month: MonthIndexPayload =
            open(&p.inner.read_file(&path("2023-11.bin")).await.unwrap());
        month.rows.into_iter().map(|r| r.entry_id).collect()
    }

    #[tokio::test]
    async fn locking_an_entry_or_journal_rewrites_its_month_without_it() {
        let (conn, j) = setup();
        let keep = entry(&conn, &j, "keep", NOV);
        let lock_me = entry(&conn, &j, "lock", NOV + 10);
        let other_journal = db::create_journal(&conn, "J2", None).unwrap().id;
        let in_journal = entry(&conn, &other_journal, "jl", NOV + 20);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        p.take_ops();

        db::set_entry_locked(&conn, &lock_me, true).unwrap();
        push_trusted(&p, &conn).await.unwrap();
        assert_eq!(
            p.take_ops(),
            vec![
                format!("write {}", path("2023-11.bin")),
                format!("write {}", path("months.bin")),
            ]
        );
        assert_eq!(nov_ids(&p).await, vec![keep.clone(), in_journal]);

        db::set_journal_locked(&conn, &other_journal, true).unwrap();
        push_trusted(&p, &conn).await.unwrap();
        assert_eq!(nov_ids(&p).await, vec![keep]);
    }

    /// Linking a tag does not bump the entry, yet it changes the row.
    #[tokio::test]
    async fn tag_link_rewrites_its_month() {
        let (conn, j) = setup();
        let e = entry(&conn, &j, "a", NOV);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        p.take_ops();

        let tag = db::create_tag(&conn, "t", None).unwrap();
        db::add_tag_to_entry(&conn, &e, &tag.id).unwrap();
        push_trusted(&p, &conn).await.unwrap();
        assert!(p
            .take_ops()
            .contains(&format!("write {}", path("2023-11.bin"))));
    }

    /// Files in `index/` that are not month files are never deleted or
    /// mistaken for a month.
    #[tokio::test]
    async fn stray_files_in_index_are_ignored() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        let p = RecordingProvider::new();
        for stray in ["junk.bin", "2023-1.bin", "notes.txt"] {
            p.inner.write_file(&path(stray), b"x").await.unwrap();
        }
        push(&p, &conn).await.unwrap();
        let mut ops = p.take_ops();
        ops.sort();
        assert_eq!(
            ops,
            vec![
                format!("write {}", path("2023-11.bin")),
                format!("write {}", path("months.bin")),
            ]
        );
    }

    #[tokio::test]
    async fn missing_month_file_is_reuploaded() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        entry(&conn, &j, "b", JAN);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        p.inner.delete_file(&path("2024-01.bin")).await.unwrap();
        p.take_ops();

        push(&p, &conn).await.unwrap();
        assert_eq!(p.take_ops(), vec![format!("write {}", path("2024-01.bin"))]);
    }

    #[tokio::test]
    async fn emptied_month_is_deleted_with_its_hash_key() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        let jan = entry(&conn, &j, "b", JAN);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        p.take_ops();

        db::soft_delete_entry(&conn, &jan).unwrap();
        // Found from the stored key, without a listing.
        push_trusted(&p, &conn).await.unwrap();
        assert_eq!(
            p.take_ops(),
            vec![
                format!("delete {}", path("2024-01.bin")),
                format!("write {}", path("months.bin")),
            ]
        );
        assert!(db::get_surface_push_hash(&conn, "index:2024-01")
            .unwrap()
            .is_none());
        let catalog: MonthIndexCatalog =
            open(&p.inner.read_file(&path("months.bin")).await.unwrap());
        let months: Vec<&str> = catalog.months.iter().map(|m| m.month.as_str()).collect();
        assert_eq!(months, vec!["2023-11"]);
    }

    #[tokio::test]
    async fn catalog_is_written_last_and_matches_month_hashes() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        entry(&conn, &j, "b", JAN);
        entry(&conn, &j, "c", JAN + 60);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        assert_eq!(
            p.take_ops().last().unwrap(),
            &format!("write {}", path("months.bin"))
        );

        let catalog: MonthIndexCatalog =
            open(&p.inner.read_file(&path("months.bin")).await.unwrap());
        assert_eq!(catalog.device_id, DEV);
        let got: Vec<(String, String, u64)> = catalog
            .months
            .iter()
            .map(|m| (m.month.clone(), m.hash_hex.clone(), m.row_count))
            .collect();
        let hash = |m: &str| {
            db::get_surface_push_hash(&conn, &format!("index:{m}"))
                .unwrap()
                .unwrap()
        };
        assert_eq!(
            got,
            vec![
                ("2023-11".to_string(), hash("2023-11"), 1),
                ("2024-01".to_string(), hash("2024-01"), 2),
            ]
        );
    }

    #[tokio::test]
    async fn failed_first_write_leaves_index_absent() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        let p = RecordingProvider::new();
        p.set_fail_writes(true);
        assert!(push(&p, &conn).await.is_err());
        assert!(!index_present(&conn).unwrap());

        p.set_fail_writes(false);
        push(&p, &conn).await.unwrap();
        assert!(index_present(&conn).unwrap());
    }

    /// One failed month write does not stop the deletes (run first) or the
    /// other writes, but it withdraws `index_present` so readers ignore a
    /// possibly stale index. The next clean cycle restores it.
    #[tokio::test]
    async fn failed_month_write_still_processes_others_and_clears_index_present() {
        // 2024-03-15 (UTC).
        const MAR: i64 = 1_710_500_000;
        let (conn, j) = setup();
        let nov = entry(&conn, &j, "a", NOV);
        entry(&conn, &j, "b", JAN);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        assert!(index_present(&conn).unwrap());
        let jan_hash = db::get_surface_push_hash(&conn, "index:2024-01").unwrap();
        p.take_ops();

        db::soft_delete_entry(&conn, &nov).unwrap();
        entry(&conn, &j, "c", JAN + 60);
        entry(&conn, &j, "d", MAR);
        p.fail_path(path("2024-01.bin"));
        let err = push_trusted(&p, &conn).await.unwrap_err();
        assert!(err.to_string().contains("2024-01"), "{err}");
        assert_eq!(
            p.take_ops(),
            vec![
                format!("delete {}", path("2023-11.bin")),
                format!("write {}", path("2024-01.bin")),
                format!("write {}", path("2024-03.bin")),
            ]
        );
        assert!(!index_present(&conn).unwrap());
        assert!(db::get_surface_push_hash(&conn, "index:2023-11")
            .unwrap()
            .is_none());
        assert_eq!(
            db::get_surface_push_hash(&conn, "index:2024-01").unwrap(),
            jan_hash
        );
        assert!(db::get_surface_push_hash(&conn, "index:2024-03")
            .unwrap()
            .is_some());

        p.clear_fail_paths();
        push_trusted(&p, &conn).await.unwrap();
        assert_eq!(
            p.take_ops(),
            vec![
                format!("write {}", path("2024-01.bin")),
                format!("write {}", path("months.bin")),
            ]
        );
        assert!(index_present(&conn).unwrap());
    }

    /// A DB error while reading the fingerprint or stored hashes must still
    /// withdraw `index_present`.
    #[tokio::test]
    async fn fingerprint_read_error_clears_index_present() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        assert!(index_present(&conn).unwrap());

        conn.execute_batch("DROP TABLE entry_versions").unwrap();
        assert!(push_trusted(&p, &conn).await.is_err());
        assert!(!index_present(&conn).unwrap());
        assert!(db::get_surface_push_hash(&conn, FINGERPRINT_KEY)
            .unwrap()
            .is_none());
    }

    /// When a rebuild is needed, the old catalog stops being trusted before
    /// the first write, so a cycle that dies mid-rebuild never leaves a stale
    /// index marked present. The next clean cycle restores it.
    #[tokio::test]
    async fn crash_mid_rebuild_leaves_index_absent() {
        let (conn, j) = setup();
        let e = entry(&conn, &j, "a", NOV);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        assert!(index_present(&conn).unwrap());

        db::set_entry_locked(&conn, &e, true).unwrap();
        entry(&conn, &j, "b", NOV + 10);
        p.set_hang_writes(true);
        let cycle = push_trusted(&p, &conn);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), cycle)
                .await
                .is_err()
        );
        assert!(!index_present(&conn).unwrap());

        p.set_hang_writes(false);
        push_trusted(&p, &conn).await.unwrap();
        assert!(index_present(&conn).unwrap());
    }

    /// A rebuild whose months and catalog turn out byte-identical (fingerprint
    /// moved, rows did not) skips the catalog write but still restores
    /// `index_present`.
    #[tokio::test]
    async fn rebuild_with_identical_catalog_restores_index_present() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        p.take_ops();

        db::set_surface_push_hash(&conn, FINGERPRINT_KEY, "stale").unwrap();
        push_trusted(&p, &conn).await.unwrap();
        assert!(p.take_ops().is_empty());
        assert!(index_present(&conn).unwrap());
    }

    /// A listed month file with neither a stored key nor rows (left by an
    /// earlier install, say) is deleted.
    #[tokio::test]
    async fn listed_month_without_key_or_rows_is_deleted() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        let p = RecordingProvider::new();
        p.inner
            .write_file(&path("2023-10.bin"), b"old")
            .await
            .unwrap();
        push(&p, &conn).await.unwrap();
        let ops = p.take_ops();
        assert!(
            ops.contains(&format!("delete {}", path("2023-10.bin"))),
            "{ops:?}"
        );
        assert!(p.inner.read_file(&path("2023-10.bin")).await.is_err());
        assert!(index_present(&conn).unwrap());
    }

    #[tokio::test]
    async fn clearing_push_hashes_forces_full_rewrite() {
        let (conn, j) = setup();
        entry(&conn, &j, "a", NOV);
        entry(&conn, &j, "b", JAN);
        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        p.take_ops();

        db::clear_all_surface_push_hashes(&conn).unwrap();
        assert!(!index_present(&conn).unwrap());
        push_trusted(&p, &conn).await.unwrap();
        let mut ops = p.take_ops();
        ops.sort();
        assert_eq!(
            ops,
            vec![
                format!("write {}", path("2023-11.bin")),
                format!("write {}", path("2024-01.bin")),
                format!("write {}", path("months.bin")),
            ]
        );
        assert!(index_present(&conn).unwrap());
    }

    #[tokio::test]
    async fn sealed_month_opens_with_sync_key_and_has_no_locked_or_invisible_rows() {
        let (conn, j) = setup();
        let public = entry(&conn, &j, "public", NOV);
        let locked = entry(&conn, &j, "locked", NOV + 10);
        let invisible = entry(&conn, &j, "invisible", NOV + 20);
        let locked_journal = db::create_journal(&conn, "LJ", None).unwrap().id;
        let in_locked_journal = entry(&conn, &locked_journal, "lj", NOV + 30);
        db::set_entry_locked(&conn, &locked, true).unwrap();
        db::set_entry_invisible(&conn, &invisible, true, Some("vault")).unwrap();
        db::set_journal_locked(&conn, &locked_journal, true).unwrap();

        let p = RecordingProvider::new();
        push(&p, &conn).await.unwrap();
        let month: MonthIndexPayload =
            open(&p.inner.read_file(&path("2023-11.bin")).await.unwrap());
        assert_eq!(month.month, "2023-11");
        assert_eq!(month.device_id, DEV);
        let ids: Vec<&str> = month.rows.iter().map(|r| r.entry_id.as_str()).collect();
        assert_eq!(ids, vec![public.as_str()]);
        for absent in [&locked, &invisible, &in_locked_journal] {
            assert!(!ids.contains(&absent.as_str()));
        }
    }
}
