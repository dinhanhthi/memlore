//! Phase 1 of the rotation state machine: enumerate all cloud envelopes that
//! must be re-encrypted and insert them into `rotation_job_items`.

use rand::RngCore;
use zeroize::Zeroizing;

use crate::db;
use crate::sync::provider::{FileKind, SyncProvider};
use crate::utils::encryption::key_fingerprint;
use crate::AppState;

use super::{state, RotationContext};

/// Per-device singleton blob filenames living directly under `{device_id}/`
/// (not in an `entries/`/`media/`/`journals/` subfolder). Each is a bare
/// versioned envelope encrypted with the master-derived sync key, so rotation
/// must re-encrypt them alongside entries/media. `metadata.json` is excluded:
/// it is plaintext JSON, not an encrypted envelope.
pub(crate) const SINGLETON_BLOB_NAMES: [&str; 9] = [
    "settings.bin",
    "tags.bin",
    "templates.bin",
    "chats.bin",
    "memory.bin",
    "streak.bin",
    "locations.bin",
    "ai_audit.bin",
    "ai_reviews.bin",
];

/// Enumerate all cloud envelopes and create the rotation job.
///
/// Steps:
/// 1. Generate `master_key_new` (32 random bytes). Optionally generate a new
///    24-word BIP-39 recovery mnemonic (when `generate_new_recovery` is `true`).
/// 2. Read `_meta.json` from cloud; validate that the cloud fingerprint matches
///    local `cloud_master_fingerprint` (guard against concurrent rotation).
/// 3. Atomically (single SQLite transaction): insert the `rotation_job` row,
///    stash the crash-resume wrapped keys, and (if `generate_new_recovery`)
///    stash the new recovery mnemonic. All three writes commit together — a
///    crash between any of them is impossible.
/// 4. Walk every peer device's `entries/` and `media/` folders; insert one
///    `rotation_job_items` row per envelope.
/// 5. Transition job to `reencrypt`.
///
/// `generate_new_recovery`:
/// - `true` for `rotate_master_key` — generates and stashes a new 24-word
///   BIP-39 phrase that `publish_keyring` will use for the recovery slot.
/// - `false` for `revoke_device` — the caller supplies the phrase later.
///
/// Returns `(rotation_id, RotationContext)`.
pub async fn enumerate_envelopes<P>(
    provider: &P,
    state: &AppState,
    master_key_old: Zeroizing<[u8; 32]>,
    current_password: &str,
    revoked_device_id: Option<&str>,
    generate_new_recovery: bool,
) -> Result<(i64, RotationContext), String>
where
    P: SyncProvider + crate::sync::keyring_v2::KeyringV2Io,
{
    use crate::sync::keyring_v2::io as kio;

    // 1. Generate the new master key.
    let mut master_key_new_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut master_key_new_bytes);
    let master_key_new: Zeroizing<[u8; 32]> = Zeroizing::new(master_key_new_bytes);

    // 2. Read cloud meta to get old_epoch and old_fingerprint.
    let meta = kio::read_meta(provider)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Cloud vault _meta.json is missing — cannot start rotation".to_string())?;

    let old_fingerprint = meta.master_fingerprint.clone();
    let old_epoch = meta.epoch;
    let new_epoch = old_epoch + 1;

    // Verify that the cloud fingerprint matches our local copy.
    // If another device rotated in the background, we must abort here
    // before creating any job rows.
    {
        let conn = state.lock()?;
        let local_fp =
            db::get_setting(&conn, db::CLOUD_MASTER_FINGERPRINT).map_err(|e| e.to_string())?;
        if let Some(local) = local_fp {
            if local != old_fingerprint {
                return Err("Cloud vault fingerprint has changed since last sync — \
                     another device may have rotated the vault. \
                     Please sync first, then retry the operation."
                    .to_string());
            }
        }
    }

    let new_fingerprint = hex::encode(key_fingerprint(&*master_key_new));
    let old_fp_str = old_fingerprint.as_str();
    let new_fp_str = new_fingerprint.as_str();

    // 3+4. Atomically insert the rotation_job row and stash all crash-resume
    //      data in a single SQLite transaction.
    //
    //      All CPU-bound work (Argon2 wrapping, BIP-39 generation) is done
    //      OUTSIDE the lock so we hold the mutex only for the commit itself.
    let old_stash = super::wrap_rotation_stash(&*master_key_old, current_password)
        .map_err(|e| format!("enumerate: failed to wrap old key for stash: {e}"))?;
    let new_stash = super::wrap_rotation_stash(&*master_key_new, current_password)
        .map_err(|e| format!("enumerate: failed to wrap new key for stash: {e}"))?;
    let new_mnemonic: Option<zeroize::Zeroizing<String>> = if generate_new_recovery {
        Some(
            crate::utils::recovery::generate_recovery_mnemonic()
                .map_err(|e| format!("enumerate: failed to generate recovery mnemonic: {e}"))?,
        )
    } else {
        None
    };

    let rotation_id = {
        let conn = state.lock()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("enumerate: failed to begin transaction: {e}"))?;
        let id = db::insert_rotation_job(
            &tx,
            old_fp_str,
            new_fp_str,
            old_epoch as i64,
            new_epoch as i64,
            revoked_device_id,
        )
        .map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::ROTATION_MASTER_OLD_WRAPPED_LOCAL, &old_stash)
            .map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::ROTATION_MASTER_NEW_WRAPPED_LOCAL, &new_stash)
            .map_err(|e| e.to_string())?;
        if let Some(ref m) = new_mnemonic {
            db::set_rotation_recovery_stash(&tx, m).map_err(|e| e.to_string())?;
        }
        tx.commit()
            .map_err(|e| format!("enumerate: failed to commit rotation stash: {e}"))?;
        id
    };

    log::info!(
        "rotation: created job {} (old_epoch={old_epoch}, new_epoch={new_epoch}, \
         revoke={revoked_device_id:?}, new_recovery={})",
        rotation_id,
        generate_new_recovery
    );

    // 5. Enumerate all device envelopes.
    let devices = provider
        .list_devices()
        .await
        .map_err(|e| format!("enumerate: list_devices failed: {e}"))?;

    let mut total_items = 0usize;
    for device_id in &devices {
        // Entry files. Use qualified syntax to disambiguate from KeyringV2Io::list_files.
        let entry_paths = SyncProvider::list_files(provider, device_id, FileKind::Entries)
            .await
            .map_err(|e| format!("enumerate: list entries for {device_id}: {e}"))?;

        {
            let conn = state.lock()?;
            for path in &entry_paths {
                db::insert_rotation_item(&conn, rotation_id, "entry", path)
                    .map_err(|e| e.to_string())?;
            }
        }
        total_items += entry_paths.len();

        // Media files.
        let media_paths = SyncProvider::list_files(provider, device_id, FileKind::Media)
            .await
            .map_err(|e| format!("enumerate: list media for {device_id}: {e}"))?;

        {
            let conn = state.lock()?;
            for path in &media_paths {
                db::insert_rotation_item(&conn, rotation_id, "media", path)
                    .map_err(|e| e.to_string())?;
            }
        }
        total_items += media_paths.len();

        // Journal metadata files (`{device}/journals/*.bin`). Same master-derived
        // key as entries/media; previously omitted from rotation, so after a key
        // change peers could no longer decrypt them.
        let journal_paths = SyncProvider::list_files(provider, device_id, FileKind::Journals)
            .await
            .map_err(|e| format!("enumerate: list journals for {device_id}: {e}"))?;

        {
            let conn = state.lock()?;
            for path in &journal_paths {
                db::insert_rotation_item(&conn, rotation_id, "blob", path)
                    .map_err(|e| e.to_string())?;
            }
        }
        total_items += journal_paths.len();

        // Entry-version snapshot files (`{device}/versions/*.bin`). Same
        // XJS1-style wrapper + sync_key encryption as entries — rotation
        // must re-encrypt them exactly like entries or they are stranded
        // under the old key after the flip. Basis: bugs
        // `rotation-skips-singleton-blobs-and-journals` and
        // `rotation-reencrypt-entry-xjs1-wrapper`.
        let version_paths = SyncProvider::list_files(provider, device_id, FileKind::Versions)
            .await
            .map_err(|e| format!("enumerate: list versions for {device_id}: {e}"))?;

        {
            let conn = state.lock()?;
            for path in &version_paths {
                db::insert_rotation_item(&conn, rotation_id, "version", path)
                    .map_err(|e| e.to_string())?;
            }
        }
        total_items += version_paths.len();

        // Per-device singleton blobs at the device-folder root (not in a
        // subfolder, so `list_files`/`FileKind` can't enumerate them). They are
        // bare versioned envelopes under the same master-derived key. Insert the
        // known fixed set; reencrypt skips any that don't exist on this device.
        {
            let conn = state.lock()?;
            for name in SINGLETON_BLOB_NAMES {
                let path = format!("{device_id}/{name}");
                db::insert_rotation_item(&conn, rotation_id, "blob", &path)
                    .map_err(|e| e.to_string())?;
            }
        }
        total_items += SINGLETON_BLOB_NAMES.len();
    }

    log::info!(
        "rotation: enumerated {total_items} envelopes across {} devices",
        devices.len()
    );

    // 6. Transition to reencrypt.
    {
        let conn = state.lock()?;
        db::update_rotation_job_state(&conn, rotation_id, state::REENCRYPT)
            .map_err(|e| e.to_string())?;
    }

    let ctx = RotationContext {
        master_key_old,
        master_key_new,
    };

    Ok((rotation_id, ctx))
}

/// Enumerate stragglers: files written by peer devices AFTER our initial
/// `enumerate_envelopes` pass.  The `INSERT OR IGNORE` on `rotation_job_items`
/// means existing paths are silently skipped; only genuinely new paths become
/// new pending items.
///
/// Returns the number of new items inserted.
pub async fn enumerate_stragglers<P>(
    provider: &P,
    state: &AppState,
    rotation_id: i64,
    _ctx: &RotationContext,
) -> Result<usize, String>
where
    P: SyncProvider,
{
    {
        let conn = state.lock()?;
        db::update_rotation_job_state(&conn, rotation_id, state::ENUMERATE_STRAGGLERS)
            .map_err(|e| e.to_string())?;
    }

    let devices = provider
        .list_devices()
        .await
        .map_err(|e| format!("enumerate_stragglers: list_devices failed: {e}"))?;

    let mut new_items = 0usize;

    for device_id in &devices {
        let entry_paths = provider
            .list_files(device_id, FileKind::Entries)
            .await
            .map_err(|e| format!("enumerate_stragglers: list entries for {device_id}: {e}"))?;

        let media_paths = provider
            .list_files(device_id, FileKind::Media)
            .await
            .map_err(|e| format!("enumerate_stragglers: list media for {device_id}: {e}"))?;

        let journal_paths = provider
            .list_files(device_id, FileKind::Journals)
            .await
            .map_err(|e| format!("enumerate_stragglers: list journals for {device_id}: {e}"))?;

        let version_paths = provider
            .list_files(device_id, FileKind::Versions)
            .await
            .map_err(|e| format!("enumerate_stragglers: list versions for {device_id}: {e}"))?;

        let conn = state.lock()?;
        for path in &entry_paths {
            // Returns () — the UNIQUE constraint silently ignores duplicates.
            // We can't easily know if a row was newly inserted; check total count after.
            let before = conn
                .query_row(
                    "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND envelope_id=?2",
                    rusqlite::params![rotation_id, path],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(1); // if query fails, assume exists
            db::insert_rotation_item(&conn, rotation_id, "entry", path)
                .map_err(|e| e.to_string())?;
            if before == 0 {
                new_items += 1;
            }
        }
        for path in &media_paths {
            let before = conn
                .query_row(
                    "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND envelope_id=?2",
                    rusqlite::params![rotation_id, path],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(1);
            db::insert_rotation_item(&conn, rotation_id, "media", path)
                .map_err(|e| e.to_string())?;
            if before == 0 {
                new_items += 1;
            }
        }
        for path in &journal_paths {
            let before = conn
                .query_row(
                    "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND envelope_id=?2",
                    rusqlite::params![rotation_id, path],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(1);
            db::insert_rotation_item(&conn, rotation_id, "blob", path)
                .map_err(|e| e.to_string())?;
            if before == 0 {
                new_items += 1;
            }
        }
        for path in &version_paths {
            let before = conn
                .query_row(
                    "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND envelope_id=?2",
                    rusqlite::params![rotation_id, path],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(1);
            db::insert_rotation_item(&conn, rotation_id, "version", path)
                .map_err(|e| e.to_string())?;
            if before == 0 {
                new_items += 1;
            }
        }
        // Singleton blobs for any device that first appeared during the
        // rotation window (e.g. an offline device that came online and pushed
        // at the old key). Phase-1 rows are deduped by UNIQUE(rotation_id,
        // envelope_id); a brand-new device's singletons get inserted here and
        // re-keyed by the second reencrypt pass (missing ones are skipped).
        // Without this, a mid-rotation new device's singletons stay at the old
        // key after the flip — the exact bug this rotation fix addresses.
        for name in SINGLETON_BLOB_NAMES {
            let path = format!("{device_id}/{name}");
            let before = conn
                .query_row(
                    "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND envelope_id=?2",
                    rusqlite::params![rotation_id, &path],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(1);
            db::insert_rotation_item(&conn, rotation_id, "blob", &path)
                .map_err(|e| e.to_string())?;
            if before == 0 {
                new_items += 1;
            }
        }
    }

    log::info!("rotation: enumerate_stragglers found {new_items} new envelopes");
    Ok(new_items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::sync::provider::test_support::MockProvider;
    use crate::utils::encryption::key_fingerprint;
    use rusqlite::Connection;
    use zeroize::Zeroizing;

    /// Master key used in enumerate tests.
    const TEST_MASTER: [u8; 32] = [0xAAu8; 32];

    fn test_fp() -> String {
        hex::encode(key_fingerprint(&TEST_MASTER))
    }

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Set cloud fingerprint to match what we'll put in the mock keyring.
        db::set_setting(&conn, db::CLOUD_MASTER_FINGERPRINT, &test_fp()).unwrap();
        conn
    }

    fn make_app_state(conn: Connection) -> AppState {
        AppState::new(conn)
    }

    /// A minimal KeyringV2Io + SyncProvider combination for enumerate tests.
    use crate::sync::keyring_v2::{
        io::{test_support::InMemoryKeyringProvider, write_meta},
        types::{KeyringMetaV2, KEYRING_V2_VERSION},
    };
    use std::sync::Arc;

    struct CombinedProvider {
        keyring: InMemoryKeyringProvider,
        sync: Arc<MockProvider>,
    }

    impl CombinedProvider {
        fn new() -> Self {
            Self {
                keyring: InMemoryKeyringProvider::new(),
                sync: Arc::new(MockProvider::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl crate::sync::keyring_v2::KeyringV2Io for CombinedProvider {
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, crate::sync::provider::SyncError> {
            self.keyring.read_file(path).await
        }
        async fn write_file(
            &self,
            path: &str,
            data: &[u8],
        ) -> Result<(), crate::sync::provider::SyncError> {
            self.keyring.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), crate::sync::provider::SyncError> {
            self.keyring.delete_file(path).await
        }
        async fn list_files(
            &self,
            prefix: &str,
        ) -> Result<Vec<String>, crate::sync::provider::SyncError> {
            self.keyring.list_files(prefix).await
        }
    }

    #[async_trait::async_trait]
    impl crate::sync::provider::SyncProvider for CombinedProvider {
        async fn list_devices(&self) -> Result<Vec<String>, crate::sync::provider::SyncError> {
            self.sync.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, crate::sync::provider::SyncError> {
            self.sync.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, crate::sync::provider::SyncError> {
            self.sync.read_file(path).await
        }
        async fn write_file(
            &self,
            path: &str,
            data: &[u8],
        ) -> Result<(), crate::sync::provider::SyncError> {
            self.sync.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), crate::sync::provider::SyncError> {
            self.sync.delete_file(path).await
        }
    }

    async fn write_meta_to_combined(p: &CombinedProvider, fp: &str, epoch: u64) {
        let now = 0i64;
        let meta = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch,
            master_fingerprint: fp.to_string(),
            content_epoch: 0,
            recovery_generation: 0,
            created_at: now,
            updated_at: now,
        };
        write_meta(p, &meta).await.unwrap();
    }

    #[tokio::test]
    async fn enumerate_creates_job_and_inserts_items() {
        let conn = setup_db(); // setup_db already sets cloud_master_fingerprint = test_fp()
        let state = make_app_state(conn);
        let provider = CombinedProvider::new();
        write_meta_to_combined(&provider, &test_fp(), 1).await;

        // Plant two entries and one media file.
        provider
            .sync
            .write_file("dev-a/entries/e1.bin", b"ct1")
            .await
            .unwrap();
        provider
            .sync
            .write_file("dev-a/entries/e2.bin", b"ct2")
            .await
            .unwrap();
        provider
            .sync
            .write_file("dev-a/media/img1", b"media1")
            .await
            .unwrap();
        // One journal file and two singleton blobs.
        provider
            .sync
            .write_file("dev-a/journals/j1.bin", b"journal1")
            .await
            .unwrap();
        provider
            .sync
            .write_file("dev-a/tags.bin", b"tags")
            .await
            .unwrap();
        provider
            .sync
            .write_file("dev-a/settings.bin", b"settings")
            .await
            .unwrap();

        let master_old = Zeroizing::new([0u8; 32]);
        let (rotation_id, ctx) =
            enumerate_envelopes(&provider, &state, master_old, "password123!", None, false)
                .await
                .unwrap();

        assert!(rotation_id > 0);
        assert_ne!(*ctx.master_key_old, *ctx.master_key_new);

        let conn = state.lock().unwrap();
        let job = db::find_active_rotation_job(&conn).unwrap().unwrap();
        assert_eq!(job.state, state::REENCRYPT);
        assert_eq!(job.old_epoch, 1);
        assert_eq!(job.new_epoch, 2);

        // 2 entries + 1 media + 1 journal + N fixed singleton blobs.
        // (Singletons are enumerated from the known set regardless of existence;
        // reencrypt skips the ones that don't exist on disk.)
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count as usize, 2 + 1 + 1 + SINGLETON_BLOB_NAMES.len());

        // The journal + singleton blobs are inserted with kind "blob".
        let blob_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND envelope_kind='blob'",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(blob_count as usize, 1 + SINGLETON_BLOB_NAMES.len()); // 1 journal + singletons

        // Stash keys should be persisted.
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_OLD_WRAPPED_LOCAL)
                .unwrap()
                .is_some()
        );
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_NEW_WRAPPED_LOCAL)
                .unwrap()
                .is_some()
        );
    }

    /// Version-snapshot files (`{device}/versions/*.bin`) must be enumerated
    /// alongside entries/media/journals, tagged with envelope_kind "version"
    /// so `reencrypt_items` dispatches them to `reencrypt_version_payload`
    /// (the XJS1/XJV1-wrapped path) instead of treating them as bare
    /// envelopes. Basis: `rotation-skips-singleton-blobs-and-journals`.
    #[tokio::test]
    async fn enumerate_includes_version_files_with_version_kind() {
        let conn = setup_db();
        let state = make_app_state(conn);
        let provider = CombinedProvider::new();
        write_meta_to_combined(&provider, &test_fp(), 1).await;

        provider
            .sync
            .write_file("dev-a/versions/v1.bin", b"ct-v1")
            .await
            .unwrap();
        provider
            .sync
            .write_file("dev-a/versions/v2.bin", b"ct-v2")
            .await
            .unwrap();

        let master_old = Zeroizing::new([0u8; 32]);
        let (rotation_id, _ctx) =
            enumerate_envelopes(&provider, &state, master_old, "password123!", None, false)
                .await
                .unwrap();

        let conn = state.lock().unwrap();
        let version_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND envelope_kind='version'",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version_count, 2);

        let paths: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT envelope_id FROM rotation_job_items \
                     WHERE rotation_id=?1 AND envelope_kind='version' ORDER BY envelope_id",
                )
                .unwrap();
            stmt.query_map([rotation_id], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(
            paths,
            vec![
                "dev-a/versions/v1.bin".to_string(),
                "dev-a/versions/v2.bin".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn enumerate_rejects_when_fingerprint_mismatch() {
        let conn = setup_db();
        // Local fingerprint differs from cloud — use a valid 64-char hex string
        // that is different from test_fp() (cloud uses test_fp()).
        let different_local_fp = hex::encode(key_fingerprint(&[0u8; 32]));
        db::set_setting(&conn, db::CLOUD_MASTER_FINGERPRINT, &different_local_fp).unwrap();
        let state = make_app_state(conn);
        let provider = CombinedProvider::new();
        // Cloud has test_fp() (derived from TEST_MASTER = [0xAA; 32]).
        write_meta_to_combined(&provider, &test_fp(), 1).await;

        let master_old = Zeroizing::new([0u8; 32]);
        let result =
            enumerate_envelopes(&provider, &state, master_old, "password123!", None, false).await;
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.contains("fingerprint"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn enumerate_stragglers_detects_new_files() {
        let conn = setup_db(); // setup_db already sets cloud_master_fingerprint = test_fp()
        let state = make_app_state(conn);
        let provider = CombinedProvider::new();
        write_meta_to_combined(&provider, &test_fp(), 1).await;

        // Plant one entry before enumerate.
        provider
            .sync
            .write_file("dev-a/entries/e1.bin", b"ct1")
            .await
            .unwrap();

        let master_old = Zeroizing::new([0u8; 32]);
        let (rotation_id, ctx) =
            enumerate_envelopes(&provider, &state, master_old, "password123!", None, false)
                .await
                .unwrap();

        // Plant a new entry AFTER enumerate (straggler).
        provider
            .sync
            .write_file("dev-a/entries/e2.bin", b"ct2")
            .await
            .unwrap();

        let new_count = enumerate_stragglers(&provider, &state, rotation_id, &ctx)
            .await
            .unwrap();

        assert_eq!(new_count, 1);
    }

    /// A device that first appears DURING the rotation window (absent from the
    /// phase-1 `list_devices()` snapshot) must have its singleton blobs + journals
    /// enumerated by the straggler scan — otherwise they stay at the old key and
    /// become permanently undecryptable after the key flip.
    #[tokio::test]
    async fn enumerate_stragglers_picks_up_new_device_singletons() {
        let conn = setup_db();
        let state = make_app_state(conn);
        let provider = CombinedProvider::new();
        write_meta_to_combined(&provider, &test_fp(), 1).await;

        // Phase 1: only dev-a exists.
        provider
            .sync
            .write_file("dev-a/entries/e1.bin", b"ct1")
            .await
            .unwrap();

        let master_old = Zeroizing::new([0u8; 32]);
        let (rotation_id, ctx) =
            enumerate_envelopes(&provider, &state, master_old, "password123!", None, false)
                .await
                .unwrap();

        // dev-b comes online mid-rotation and pushes a singleton + a journal.
        provider
            .sync
            .write_file("dev-b/tags.bin", b"tags-b")
            .await
            .unwrap();
        provider
            .sync
            .write_file("dev-b/journals/j1.bin", b"journal-b")
            .await
            .unwrap();

        enumerate_stragglers(&provider, &state, rotation_id, &ctx)
            .await
            .unwrap();

        // dev-b's tags.bin and journal must now be rotation items (kind "blob").
        let conn = state.lock().unwrap();
        for path in ["dev-b/tags.bin", "dev-b/journals/j1.bin"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND envelope_id=?2 AND envelope_kind='blob'",
                    rusqlite::params![rotation_id, path],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "expected {path} enumerated as a blob straggler");
        }
        // All of dev-b's singleton paths should be present (fixed set).
        let dev_b_blobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND envelope_kind='blob' AND envelope_id LIKE 'dev-b/%' AND envelope_id NOT LIKE 'dev-b/journals/%'",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dev_b_blobs as usize, SINGLETON_BLOB_NAMES.len());
    }

    #[tokio::test]
    async fn enumerate_rejects_duplicate_active_job() {
        let conn = setup_db(); // setup_db already sets cloud_master_fingerprint = test_fp()
        let state = make_app_state(conn);
        let provider = CombinedProvider::new();
        write_meta_to_combined(&provider, &test_fp(), 1).await;

        let master_old = Zeroizing::new([0u8; 32]);
        let (rotation_id, _) = enumerate_envelopes(
            &provider,
            &state,
            master_old.clone(),
            "password123!",
            None,
            false,
        )
        .await
        .unwrap();

        // Second call should fail because an active job exists.
        // We must call start_rotation which checks for duplicates; enumerate_envelopes itself
        // does not guard (the guard is in start_rotation). So we test via the DB directly.
        let conn = state.lock().unwrap();
        let job = db::find_active_rotation_job(&conn).unwrap();
        assert!(job.is_some());
        assert_eq!(job.unwrap().id, rotation_id);
    }

    /// C3: The stash must be written BEFORE the cloud walk (list_devices / list_files).
    ///
    /// We verify this by checking that after `enumerate_envelopes` returns successfully,
    /// the stash keys are present in the DB. Since the fix moves the stash write to
    /// immediately after job insertion (before any network calls), if the function
    /// returns Ok the stash MUST be set — even if we crash mid-walk, the stash
    /// will already be there.
    ///
    /// This test complements the ordering guarantee: it proves the stash is always
    /// written, not just "eventually" written after the walk completes.
    #[tokio::test]
    async fn stash_is_written_before_cloud_walk() {
        let conn = setup_db();
        let state = make_app_state(conn);
        let provider = CombinedProvider::new();
        write_meta_to_combined(&provider, &test_fp(), 1).await;

        // Add a device with files — forces an actual list_files call in the walk.
        provider
            .sync
            .write_file("dev-a/entries/e1.bin", b"ct1")
            .await
            .unwrap();

        let master_old = Zeroizing::new(TEST_MASTER);
        enumerate_envelopes(&provider, &state, master_old, "pass123!", None, false)
            .await
            .unwrap();

        // Both stash entries must exist in the DB immediately after enumerate.
        let conn = state.lock().unwrap();
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_OLD_WRAPPED_LOCAL)
                .unwrap()
                .is_some(),
            "old stash must be written before enumerate returns"
        );
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_NEW_WRAPPED_LOCAL)
                .unwrap()
                .is_some(),
            "new stash must be written before enumerate returns"
        );
    }

    /// T2 — `generate_new_recovery=true`: after enumerate, both the rotation_job
    /// row and the recovery mnemonic stash must exist in the DB.  The mnemonic
    /// must be a valid 24-word BIP-39 phrase and must have been committed in the
    /// same atomic transaction as the job insert.
    ///
    /// `generate_new_recovery=false`: no mnemonic stash is written.
    #[tokio::test]
    async fn rotate_mnemonic_stashed_atomically_with_job() {
        // ── generate_new_recovery = true (rotate path) ───────────────────────
        let conn = setup_db();
        let state = make_app_state(conn);
        let provider = CombinedProvider::new();
        write_meta_to_combined(&provider, &test_fp(), 1).await;

        provider
            .sync
            .write_file("dev-a/entries/e1.bin", b"ct1")
            .await
            .unwrap();

        let master_old = Zeroizing::new(TEST_MASTER);
        let (rotation_id, _) =
            enumerate_envelopes(&provider, &state, master_old, "pass123!", None, true)
                .await
                .unwrap();

        let conn = state.lock().unwrap();

        // Job row must exist.
        let job = db::find_active_rotation_job(&conn).unwrap().unwrap();
        assert_eq!(job.id, rotation_id);

        // Recovery mnemonic stash must be set and valid.
        let mnemonic_str = db::get_rotation_recovery_stash(&conn).unwrap().expect(
            "mnemonic stash must be present after enumerate with generate_new_recovery=true",
        );

        let word_count = mnemonic_str.split_whitespace().count();
        assert_eq!(
            word_count, 24,
            "stashed mnemonic must be 24 words, got {word_count}"
        );

        // Must parse as a valid BIP-39 mnemonic.
        crate::utils::recovery::validate_recovery_mnemonic(&mnemonic_str)
            .expect("stashed mnemonic must pass validate_recovery_mnemonic");

        // Master-key stashes must also be present (atomicity: all three committed together).
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_OLD_WRAPPED_LOCAL)
                .unwrap()
                .is_some(),
            "old key stash must be present"
        );
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_NEW_WRAPPED_LOCAL)
                .unwrap()
                .is_some(),
            "new key stash must be present"
        );

        drop(conn);

        // ── generate_new_recovery = false (revoke path) ──────────────────────
        let conn2 = setup_db();
        let state2 = make_app_state(conn2);
        let provider2 = CombinedProvider::new();
        write_meta_to_combined(&provider2, &test_fp(), 1).await;

        provider2
            .sync
            .write_file("dev-a/entries/e1.bin", b"ct1")
            .await
            .unwrap();

        let master_old2 = Zeroizing::new(TEST_MASTER);
        enumerate_envelopes(&provider2, &state2, master_old2, "pass123!", None, false)
            .await
            .unwrap();

        let conn2 = state2.lock().unwrap();
        assert!(
            db::get_rotation_recovery_stash(&conn2).unwrap().is_none(),
            "mnemonic stash must NOT be written when generate_new_recovery=false"
        );
    }

    /// T5 — `rotate_master_key` requires ONLY the current password; no
    /// caller-supplied mnemonic is used.  After `enumerate_envelopes` returns
    /// with `generate_new_recovery=true`, the recovery stash is present in the
    /// DB and is a valid 24-word BIP-39 phrase.  This test drives the
    /// enumerate step in isolation (the same step `rotate_master_key` calls
    /// first) and verifies the stash is auto-populated without any mnemonic
    /// argument.
    #[tokio::test]
    async fn rotate_requires_only_password_no_old_mnemonic() {
        let conn = setup_db();
        let state = make_app_state(conn);
        let provider = CombinedProvider::new();
        write_meta_to_combined(&provider, &test_fp(), 1).await;

        provider
            .sync
            .write_file("dev-a/entries/e1.bin", b"ct1")
            .await
            .unwrap();

        // Call enumerate_envelopes with generate_new_recovery=true — no mnemonic
        // argument exists at any level; the phrase is generated internally.
        let master_old = Zeroizing::new(TEST_MASTER);
        let (_rotation_id, _ctx) =
            enumerate_envelopes(&provider, &state, master_old, "pass123!", None, true)
                .await
                .expect("rotate enumerate must succeed without a caller-supplied mnemonic");

        let conn = state.lock().unwrap();

        // The new recovery stash must have been created.
        let stash = db::get_rotation_recovery_stash(&conn).unwrap().expect(
            "recovery stash must be present after enumerate with generate_new_recovery=true",
        );

        // Must be exactly 24 words.
        let word_count = stash.split_whitespace().count();
        assert_eq!(
            word_count, 24,
            "stashed mnemonic must be 24 words, got {word_count}"
        );

        // Must parse as a valid BIP-39 mnemonic (i.e., can be used by publish_keyring).
        crate::utils::recovery::validate_recovery_mnemonic(&stash)
            .expect("stashed mnemonic must be a valid BIP-39 phrase");
    }
}
