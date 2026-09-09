//! Phase 4 lazy-rotation core: append a new content key, rotate the master key,
//! re-wrap the full content-key list, and skip straight to `publish_keyring`.
//!
//! This is the unified "rotate" primitive used by both `revoke_device` and
//! `rotate_master_key`. No cloud envelopes are re-encrypted (forward-secrecy
//! lazy model). New writes use the new content key; old data stays under old
//! epochs.
//!
//! # Sequence
//!
//! 1. Generate `content_key_v(N+1)`. Read the current list (wrapped under
//!    `master_old`) and append the new key.
//! 2. Generate `master_key_new` (32 random bytes). Re-wrap the full list under
//!    `master_new`.
//! 3. Atomically (single SQLite tx): insert the rotation job row in
//!    `commit_local` state, stash both master wraps, and write the
//!    new `WRAPPED_CONTENT_LIST` (still under `master_old` — `commit_local`
//!    will re-wrap under `master_new`), bump `CONTENT_KEY_EPOCH`.
//! 4. Call `commit_local_inner` (which also re-wraps the list under `master_new`
//!    and atomically transitions the job to `publish_keyring`).
//! 5. Update `key_state` in memory with the new map (epoch N+1, `master_new`).
//!
//! Returns `(rotation_id, RotationContext, new_content_epoch)`.
//!
//! # Security
//!
//! - `master_key` rotates on every call → revoked device's `master_old` cannot
//!   unwrap the new `_content.json` (written by `publish_keyring` under `master_new`).
//! - `db_key` never changes (no PRAGMA rekey).
//! - Old cloud envelopes are NOT re-encrypted (lazy / forward-secrecy trade-off).

use std::collections::BTreeMap;

use rand::RngCore;
use zeroize::Zeroizing;

use crate::db;
use crate::sync::keyring_v2::{io as kio, KeyringV2Io};
use crate::utils::encryption::{
    decode_content_key_list, encode_content_key_list, generate_content_key, key_fingerprint,
};
use crate::{AppState, EncryptionKeyState};

use super::{state, wrap_rotation_stash, RotationContext};

/// Lazy-rotation core: generate a new content key epoch, rotate the master key,
/// and set up a rotation job at `commit_local` state (no enumerate/reencrypt).
///
/// # Parameters
/// - `provider` — cloud I/O (for fingerprint check only; no envelope reads/writes).
/// - `app_state` — SQLite state.
/// - `key_state` — live encryption state (read master_old; updated to master_new
///   on success).
/// - `current_password` — device password (for crash-safe stash wrapping).
/// - `revoked_device_id` — `Some(id)` for revoke flows; `None` for key rotate.
/// - `recovery_mnemonic_to_stash` — `Some(mnemonic)` for key-rotate flows (written
///   atomically in the job-insert tx so `publish_keyring(Stashed)` can always find
///   it); `None` for revoke flows (which use `RecoverySource::Supplied` instead).
/// - `boot_path` — production boot file path; `None` in tests.
///
/// Returns `(rotation_id, RotationContext, new_content_epoch)`.
pub async fn rotate_keys<P>(
    provider: &P,
    app_state: &AppState,
    key_state: &EncryptionKeyState,
    current_password: &str,
    revoked_device_id: Option<&str>,
    recovery_mnemonic_to_stash: Option<&str>,
    boot_path: Option<&std::path::Path>,
) -> Result<(i64, RotationContext, u32), String>
where
    P: KeyringV2Io,
{
    // ── Step 1: read the current content-key list ────────────────────────────

    let master_key_old: Zeroizing<[u8; 32]> = key_state
        .with_master(|m| {
            let mut out = Zeroizing::new([0u8; 32]);
            out.copy_from_slice(m);
            Ok(out)
        })
        .map_err(|e| format!("rotate_keys: could not read master key: {e}"))?;

    // Read cloud meta for epoch check and old fingerprint.
    let meta = kio::read_meta(provider)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Cloud vault _meta.json is missing — cannot start rotation".to_string())?;

    let old_fingerprint = meta.master_fingerprint.clone();
    let old_epoch = meta.epoch;
    let new_epoch = old_epoch + 1;
    let old_content_epoch = meta.content_epoch;

    // Verify local fingerprint matches cloud (guard against concurrent rotation).
    {
        let conn = app_state.lock()?;
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

    // ── Step 2: generate master_new and content_key v(N+1) ──────────────────

    let mut master_new_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut master_new_bytes);
    let master_key_new: Zeroizing<[u8; 32]> = Zeroizing::new(master_new_bytes);

    // Read and decode the existing content-key list (wrapped under master_old).
    // If no list exists yet (pre-Phase-2 device), start with an empty map.
    let mut keys_map: BTreeMap<u32, Zeroizing<[u8; 32]>> = {
        let conn = app_state.lock()?;
        let list_hex = db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
            .map_err(|e| format!("rotate_keys: read WRAPPED_CONTENT_LIST: {e}"))?;
        match list_hex {
            Some(hex) => decode_content_key_list(&master_key_old, &hex)
                .map_err(|e| format!("rotate_keys: decode content list: {e}"))?,
            None => BTreeMap::new(),
        }
    };

    // Determine the new content epoch = max existing + 1, or 1 if empty.
    let new_content_epoch = keys_map
        .keys()
        .max()
        .copied()
        .unwrap_or(old_content_epoch)
        .saturating_add(1)
        .max(old_content_epoch + 1);

    // Generate and append content_key v(N+1).
    let new_content_key = generate_content_key();
    keys_map.insert(new_content_epoch, Zeroizing::new(*new_content_key));

    // Encode the extended list under master_old (commit_local_inner will
    // re-wrap under master_new in its atomic settings tx).
    let list_hex_under_old = encode_content_key_list(&master_key_old, &keys_map)
        .map_err(|e| format!("rotate_keys: encode content list under master_old: {e}"))?;

    // ── Step 3: atomic job insert + stash + list update ─────────────────────

    // CPU-bound wrapping done OUTSIDE the DB lock.
    let old_stash = wrap_rotation_stash(&master_key_old, current_password)
        .map_err(|e| format!("rotate_keys: stash old master: {e}"))?;
    let new_stash = wrap_rotation_stash(&master_key_new, current_password)
        .map_err(|e| format!("rotate_keys: stash new master: {e}"))?;

    let old_fp_str = old_fingerprint.as_str();
    let new_fp_str = hex::encode(key_fingerprint(&master_key_new));

    let rotation_id: i64 = {
        let conn = app_state.lock()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("rotate_keys: begin tx: {e}"))?;

        // Insert job row directly at commit_local state (skip enumerate/reencrypt).
        // We manually insert at 'commit_local' instead of using insert_rotation_job
        // (which inserts at 'enumerate') so that:
        // - discard_orphaned_rotation_job_if_any sees it as pre-publication
        // - resume_rotation sees it in commit_local and drives it to publish_keyring
        let now_secs = now_unix();
        tx.execute(
            "INSERT INTO rotation_job
                 (state, old_fingerprint, new_fingerprint, old_epoch, new_epoch,
                  revoked_device_id, started_at, updated_at)
             VALUES ('commit_local', ?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            rusqlite::params![
                old_fp_str,
                new_fp_str,
                old_epoch as i64,
                new_epoch as i64,
                revoked_device_id,
                now_secs,
            ],
        )
        .map_err(|e| format!("rotate_keys: insert rotation_job: {e}"))?;
        let job_id = tx.last_insert_rowid();

        // Stash both master wraps (crash-resume needs these until publish_keyring).
        db::set_setting(&tx, db::ROTATION_MASTER_OLD_WRAPPED_LOCAL, &old_stash)
            .map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::ROTATION_MASTER_NEW_WRAPPED_LOCAL, &new_stash)
            .map_err(|e| e.to_string())?;

        // Write the extended content list (still under master_old).
        // commit_local_inner reads this and re-wraps under master_new atomically.
        db::set_setting(&tx, db::WRAPPED_CONTENT_LIST, &list_hex_under_old)
            .map_err(|e| e.to_string())?;

        // Bump CONTENT_KEY_EPOCH (used by unlock path + future epoch selectors).
        db::set_setting(&tx, db::CONTENT_KEY_EPOCH, &new_content_epoch.to_string())
            .map_err(|e| e.to_string())?;

        // Stash the recovery mnemonic atomically (rotate path only).
        // This guarantees job-row-exists ⇒ stash-exists in the same tx, so
        // publish_keyring(Stashed) can always find it — both on the initial
        // call and on crash-resume. Revoke passes None here (it uses Supplied).
        if let Some(mnemonic) = recovery_mnemonic_to_stash {
            db::set_rotation_recovery_stash(&tx, mnemonic).map_err(|e| e.to_string())?;
        }

        tx.commit()
            .map_err(|e| format!("rotate_keys: tx commit: {e}"))?;

        job_id
    };

    log::info!(
        "rotate_keys: job {rotation_id} created — master epoch {old_epoch}→{new_epoch}, \
         content epoch {old_content_epoch}→{new_content_epoch}, \
         revoked_device={revoked_device_id:?}"
    );

    let ctx = RotationContext {
        master_key_old,
        master_key_new,
    };

    // ── Step 4: commit_local_inner (re-wraps list under master_new, transitions
    //           job to publish_keyring) ────────────────────────────────────────

    // commit_local_inner persists the new wrapped key + kek_salt to the DB settings
    // (via db::WRAPPED_ENCRYPTION_KEY_KEY and db::KEK_SALT_KEY) and the boot file —
    // this is the LOCAL password-unlock wrap, unrelated to the cloud. It is
    // persisted inside the call; the cloud device slot is metadata-only
    // (design §3/§4), so nothing is returned to thread onwards.
    super::commit::commit_local_inner(
        app_state,
        rotation_id,
        &ctx,
        current_password,
        boot_path,
        Some(key_state),
        state::PUBLISH_KEYRING, // lazy path: skip enumerate_stragglers
    )
    .await?;

    // ── Step 5: update key_state in memory ──────────────────────────────────

    // Re-read the map from DB (now under master_new) to get clean Zeroizing copies.
    let keys_map_new: BTreeMap<u32, Zeroizing<[u8; 32]>> = {
        let conn = app_state.lock()?;
        let hex = db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
            .map_err(|e| format!("rotate_keys: read new WRAPPED_CONTENT_LIST: {e}"))?
            .ok_or_else(|| {
                "rotate_keys: WRAPPED_CONTENT_LIST missing after commit_local".to_string()
            })?;
        decode_content_key_list(&ctx.master_key_new, &hex)
            .map_err(|e| format!("rotate_keys: decode new content list: {e}"))?
    };

    let db_key: Zeroizing<[u8; 32]> = key_state
        .with_db_key(|dk| {
            let mut out = Zeroizing::new([0u8; 32]);
            out.copy_from_slice(dk);
            Ok(out)
        })
        .map_err(|e| format!("rotate_keys: read db_key: {e}"))?;

    key_state
        .set_content_state(
            keys_map_new,
            new_content_epoch,
            db_key,
            ctx.master_key_new.clone(),
        )
        .map_err(|e| format!("rotate_keys: set_content_state: {e}"))?;

    log::info!("rotate_keys: key_state updated — latest epoch={new_content_epoch}");

    Ok((rotation_id, ctx, new_content_epoch))
}

/// Internal shortcut to get the current Unix timestamp (mirrors other modules).
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db;
    use crate::db::schema::migrate;
    use crate::sync::keyring_v2::{
        io::test_support::InMemoryKeyringProvider,
        io::{write_meta, CONTENT_PATH},
        types::{KeyringMetaV2, KEYRING_V2_VERSION},
    };
    use crate::utils::encryption::{
        decode_content_key_list, derive_sync_key, encode_content_key_list, generate_content_key,
        key_fingerprint, wrap_content_key,
    };
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn make_app_state(conn: Connection) -> AppState {
        AppState::new(conn)
    }

    /// Build an EncryptionKeyState seeded with the given master key, a fresh
    /// db_key, and a single content key at epoch 1.
    fn make_key_state(master: &[u8; 32]) -> EncryptionKeyState {
        use crate::utils::encryption::generate_content_key;
        let ks = EncryptionKeyState::new();
        let mut keys = BTreeMap::new();
        // Seed with one content key at epoch 1.
        keys.insert(1u32, Zeroizing::new(*generate_content_key()));
        let db_key = Zeroizing::new(*master); // simplification for tests
        ks.set_content_state(keys, 1, db_key, Zeroizing::new(*master))
            .unwrap();
        ks
    }

    /// Write a minimal cloud meta with the given fingerprint and epochs.
    async fn write_cloud_meta(
        provider: &InMemoryKeyringProvider,
        master: &[u8; 32],
        epoch: u64,
        content_epoch: u32,
    ) {
        let meta = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch,
            master_fingerprint: hex::encode(key_fingerprint(master)),
            content_epoch,
            recovery_generation: 0,
            created_at: 0,
            updated_at: 0,
        };
        write_meta(provider, &meta).await.unwrap();
    }

    /// Write a content-key list under `master` to the DB.
    fn write_content_list_to_db(conn: &Connection, master: &[u8; 32], epoch: u32, ck: &[u8; 32]) {
        let mut map = BTreeMap::new();
        map.insert(epoch, Zeroizing::new(*ck));
        let hex = encode_content_key_list(master, &map).unwrap();
        db::set_setting(conn, db::WRAPPED_CONTENT_LIST, &hex).unwrap();
    }

    // ── T5 tests ─────────────────────────────────────────────────────────────

    /// T5-1: rotate appends a new content key and bumps epochs.
    #[tokio::test]
    async fn rotate_appends_content_key_and_bumps_epochs() {
        let master = [1u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master)),
            )
            .unwrap();
            // Seed content list at epoch 1.
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&master);

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master, 1, 1).await;

        let (rotation_id, ctx, new_content_epoch) = rotate_keys(
            &provider, &app_state, &key_state, "password", None, None, None,
        )
        .await
        .unwrap();

        // Content epoch must be 2 (bumped from 1).
        assert_eq!(new_content_epoch, 2, "content epoch must bump from 1 to 2");

        // DB content epoch setting must be updated.
        let conn = app_state.lock().unwrap();
        let stored_epoch = db::get_setting(&conn, db::CONTENT_KEY_EPOCH)
            .unwrap()
            .unwrap();
        assert_eq!(stored_epoch, "2");

        // Content list under master_new must have 2 epochs (original + new).
        let list_hex = db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
            .unwrap()
            .unwrap();
        let decoded = decode_content_key_list(&ctx.master_key_new, &list_hex).unwrap();
        assert_eq!(
            decoded.len(),
            2,
            "list must have 2 content keys after rotation"
        );
        assert!(decoded.contains_key(&1), "epoch 1 must be preserved");
        assert!(decoded.contains_key(&2), "epoch 2 must be added");

        // Key state latest epoch must be 2.
        let latest_epoch = key_state.with_latest_sync_key(|ep, _| Ok(ep)).unwrap();
        assert_eq!(latest_epoch, 2);

        // Job must be done (commit_local → publish_keyring was skipped since no
        // provider has slots, so job stays at publish_keyring — that's ok,
        // the important thing is rotate_keys returned successfully).
        let _ = rotation_id;
        drop(conn);
    }

    /// T5-2: rotate does NOT create any rotation_job_items rows.
    #[tokio::test]
    async fn rotate_does_not_create_reencrypt_items() {
        let master = [2u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master)),
            )
            .unwrap();
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&master);

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master, 1, 1).await;

        let (rotation_id, _ctx, _) = rotate_keys(
            &provider, &app_state, &key_state, "password", None, None, None,
        )
        .await
        .unwrap();

        // No rotation_job_items must be created.
        let conn = app_state.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 0,
            "lazy rotation must not create any rotation_job_items"
        );
    }

    /// T5-3: rotate does NOT change the local db_key or trigger PRAGMA rekey.
    #[tokio::test]
    async fn rotate_does_not_rekey_local_db() {
        let master = [3u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master)),
            )
            .unwrap();
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);

        // Capture db_key BEFORE rotation.
        let key_state = make_key_state(&master);
        let db_key_before = key_state
            .with_db_key(|dk| {
                let mut out = [0u8; 32];
                out.copy_from_slice(dk);
                Ok(out)
            })
            .unwrap();

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master, 1, 1).await;

        rotate_keys(
            &provider, &app_state, &key_state, "password", None, None, None,
        )
        .await
        .unwrap();

        // db_key must be identical after rotation.
        let db_key_after = key_state
            .with_db_key(|dk| {
                let mut out = [0u8; 32];
                out.copy_from_slice(dk);
                Ok(out)
            })
            .unwrap();
        assert_eq!(
            db_key_before, db_key_after,
            "db_key must not change on rotation — no PRAGMA rekey"
        );
    }

    /// T5-6: after rotation, key_state returns the new content key at epoch N+1.
    #[tokio::test]
    async fn new_writes_use_latest_content_key() {
        let master = [6u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master)),
            )
            .unwrap();
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&master);

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master, 1, 1).await;

        let (_rotation_id, _ctx, new_content_epoch) = rotate_keys(
            &provider, &app_state, &key_state, "password", None, None, None,
        )
        .await
        .unwrap();

        // After rotation, with_latest_sync_key must return epoch=N+1.
        let (epoch_after, _) = key_state
            .with_latest_sync_key(|ep, k| Ok((ep, *k)))
            .unwrap();
        assert_eq!(
            epoch_after, new_content_epoch,
            "latest sync key epoch must equal new_content_epoch"
        );
        assert_eq!(new_content_epoch, 2, "new epoch must be 2");
    }

    /// T5-4 (partial): rotate with revoke marks the revoked device id in the job row.
    #[tokio::test]
    async fn revoke_device_id_stored_in_rotation_job() {
        let master = [4u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let target_id = "b1b2b3b4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master)),
            )
            .unwrap();
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&master);

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master, 1, 1).await;

        let (rotation_id, _ctx, _) = rotate_keys(
            &provider,
            &app_state,
            &key_state,
            "password",
            Some(target_id),
            None, // revoke uses Supplied, not Stashed
            None,
        )
        .await
        .unwrap();

        let conn = app_state.lock().unwrap();
        let job = db::find_latest_rotation_job(&conn).unwrap().unwrap();
        assert_eq!(job.id, rotation_id);
        assert_eq!(
            job.revoked_device_id.as_deref(),
            Some(target_id),
            "revoked_device_id must be stored in rotation_job"
        );
    }

    /// T5-7: crash-resume — after rotate_keys completes, a job at
    /// `publish_keyring` can be resumed by calling publish_keyring directly
    /// (idempotent publish). This test verifies the stash is present so resume
    /// can re-derive the keys.
    #[tokio::test]
    async fn rotate_resume_completes_after_crash() {
        use crate::sync::keyring_v2::io::{
            test_support::InMemoryKeyringProvider, write_device_slot,
        };
        use crate::sync::keyring_v2::types::DeviceSlotV2;
        use crate::sync::rotation::{publish::publish_keyring, RecoverySource};
        use crate::utils::recovery::generate_recovery_mnemonic;

        let master = [7u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master)),
            )
            .unwrap();
            db::upsert_device(
                &conn,
                &db::DeviceRow {
                    device_id: device_id.to_string(),
                    name: "Test".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&master);

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master, 1, 1).await;
        crate::sync::recovery::bootstrap_sync_control(&provider, 0)
            .await
            .unwrap();
        // Add a device slot for the current device so publish_keyring can rewrite it.
        let slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: device_id.to_string(),
            name: "Test".to_string(),
            created_at: 0,
            last_seen_at: 0,
        };
        write_device_slot(&provider, &slot).await.unwrap();

        // Generate the recovery mnemonic before calling rotate_keys — it will
        // be stashed atomically inside rotate_keys (the wedge-proof guarantee).
        let mnemonic = generate_recovery_mnemonic().unwrap();

        // Run rotate_keys (simulates the normal path up to commit_local).
        // Pass the mnemonic so it is stashed in the same atomic tx as the job row.
        let (rotation_id, ctx, new_content_epoch) = rotate_keys(
            &provider,
            &app_state,
            &key_state,
            "password",
            None,
            Some(&mnemonic), // stash atomically — wedge-proof
            None,
        )
        .await
        .unwrap();

        // Simulate crash: job is at publish_keyring — verify stash is cleared
        // (commit_local clears ROTATION_MASTER_OLD/NEW stashes on commit_local
        // completion per finalize_publish_local). Actually, stashes are cleared by
        // finalize_publish_local during publish. At this point they should still be
        // present since publish hasn't run yet (job is at publish_keyring, not done).
        {
            let conn = app_state.lock().unwrap();
            let job = db::find_active_rotation_job(&conn).unwrap().unwrap();
            assert_eq!(job.state, crate::sync::rotation::state::PUBLISH_KEYRING);
        }

        // Stash must be present so resume can call publish_keyring.
        {
            let conn = app_state.lock().unwrap();
            assert!(
                db::get_setting(&conn, db::ROTATION_MASTER_OLD_WRAPPED_LOCAL)
                    .unwrap()
                    .is_some(),
                "stash must be present for crash-resume"
            );
            // Recovery mnemonic stash must also be present (set atomically by rotate_keys).
            assert!(
                db::get_rotation_recovery_stash(&conn).unwrap().is_some(),
                "recovery mnemonic stash must be present atomically after rotate_keys"
            );
        }

        publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Stashed,
            None,
            new_content_epoch,
        )
        .await
        .unwrap();

        // Job must be done after resume-publish.
        let conn = app_state.lock().unwrap();
        let active = db::find_active_rotation_job(&conn).unwrap();
        assert!(active.is_none(), "job must be done after resume-publish");

        // _content.json must exist in the provider.
        assert!(
            provider.read_file(CONTENT_PATH).await.is_ok(),
            "_content.json must be written during publish_keyring"
        );
    }

    /// T5-5: a revoked device holding master_old cannot unwrap the new _content.json
    /// (which was written under master_new). Forward-secrecy assertion.
    #[tokio::test]
    async fn revoked_device_old_master_cannot_unwrap_new_content_list() {
        use crate::sync::keyring_v2::io::write_content;
        use crate::sync::keyring_v2::types::{ContentEntryV2, ContentListV2, KEYRING_V2_VERSION};
        use crate::utils::encryption::unwrap_content_key;

        let master_old = [0xAAu8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master_old)),
            )
            .unwrap();
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master_old, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&master_old);

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master_old, 1, 1).await;

        // Run rotation — new master_new is generated internally.
        let (_rotation_id, ctx, new_content_epoch) = rotate_keys(
            &provider, &app_state, &key_state, "password", None, None, None,
        )
        .await
        .unwrap();

        // Simulate writing _content.json under master_new (as publish_keyring does).
        // Read the new list from DB (now under master_new).
        let list_hex = {
            let conn = app_state.lock().unwrap();
            db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
                .unwrap()
                .unwrap()
        };
        let keys_map_new = decode_content_key_list(&ctx.master_key_new, &list_hex).unwrap();

        // Build a ContentListV2 with new entries wrapped under master_new.
        // Fingerprint must use derive_sync_key(ck) to match what publish.rs writes
        // and what onboard_complete_inner verifies.
        let mut entries = Vec::new();
        for (epoch, ck) in &keys_map_new {
            let wrapped = wrap_content_key(&ctx.master_key_new, ck).unwrap();
            entries.push(ContentEntryV2 {
                epoch: *epoch,
                wrapped_content: hex::encode(&wrapped),
                content_fingerprint: hex::encode(key_fingerprint(&*derive_sync_key(ck))),
            });
        }
        let content_list = ContentListV2 {
            version: KEYRING_V2_VERSION,
            latest_epoch: new_content_epoch,
            entries,
            created_at: 0,
        };
        write_content(&provider, &content_list).await.unwrap();

        // Simulate a revoked device that still has master_old: try to unwrap each
        // wrapped_content from the cloud _content.json.
        let cloud_content = crate::sync::keyring_v2::io::read_content(&provider)
            .await
            .unwrap()
            .unwrap();

        let mut any_unwrapped = false;
        for entry in &cloud_content.entries {
            let blob = hex::decode(&entry.wrapped_content).unwrap();
            if unwrap_content_key(&master_old, &blob).is_ok() {
                any_unwrapped = true;
                break;
            }
        }
        assert!(
            !any_unwrapped,
            "revoked device with master_old must NOT be able to unwrap any entry in the new \
             _content.json (which is wrapped under master_new)"
        );

        // But the current device (master_new) CAN unwrap all entries.
        for entry in &cloud_content.entries {
            let blob = hex::decode(&entry.wrapped_content).unwrap();
            assert!(
                unwrap_content_key(&ctx.master_key_new, &blob).is_ok(),
                "current device with master_new must be able to unwrap epoch {} entry",
                entry.epoch
            );
        }
    }

    /// T5: rotate_keys must not read or write any entry/media envelopes on the provider.
    /// Only _meta.json is read (fingerprint check); nothing else is touched.
    #[tokio::test]
    async fn rotate_touches_no_cloud_entry_or_media_envelopes() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let master = [0x99u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master)),
            )
            .unwrap();
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&master);

        // Write some fake "entry" and "media" paths to the provider before rotation.
        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master, 1, 1).await;
        provider
            .write_file("entries/abc123.enc", b"fake-entry-ciphertext")
            .await
            .unwrap();
        provider
            .write_file("media/img001.enc", b"fake-media-ciphertext")
            .await
            .unwrap();

        // Run rotate_keys (lazy path — should only touch .meta/keyring/... paths).
        rotate_keys(
            &provider, &app_state, &key_state, "password", None, None, None,
        )
        .await
        .unwrap();

        // Entry and media files must be completely untouched.
        let entry_bytes = provider.read_file("entries/abc123.enc").await.unwrap();
        assert_eq!(
            entry_bytes, b"fake-entry-ciphertext",
            "entry envelope must not be modified by rotate_keys"
        );
        let media_bytes = provider.read_file("media/img001.enc").await.unwrap();
        assert_eq!(
            media_bytes, b"fake-media-ciphertext",
            "media envelope must not be modified by rotate_keys"
        );
    }

    // ── Phase 6 — rotate_master_key stash guarantee ──────────────────────────

    /// P6-1: when rotate_keys is called with Some(mnemonic), the recovery
    /// mnemonic stash must be present in the DB in the same tx as the job row.
    /// This is the wedge-proof guarantee: job-row-exists ⇒ stash-exists.
    #[tokio::test]
    async fn rotate_keys_with_mnemonic_sets_stash_atomically() {
        use crate::utils::recovery::generate_recovery_mnemonic;

        let master = [0xA1u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master)),
            )
            .unwrap();
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&master);

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master, 1, 1).await;

        let mnemonic = generate_recovery_mnemonic().unwrap();

        rotate_keys(
            &provider,
            &app_state,
            &key_state,
            "password",
            None,
            Some(&mnemonic),
            None,
        )
        .await
        .unwrap();

        // The stash must be present immediately after rotate_keys returns.
        let conn = app_state.lock().unwrap();
        let stash = db::get_rotation_recovery_stash(&conn).unwrap();
        assert!(
            stash.is_some(),
            "recovery stash must be set atomically when Some(mnemonic) is passed"
        );
        assert_eq!(
            stash.unwrap(),
            *mnemonic,
            "stash must contain the exact mnemonic passed"
        );
    }

    // ── Phase 4 — B2: full secret reset (Flow G) ─────────────────────────────

    /// B2: calling `rotate_keys` with a FRESHLY GENERATED mnemonic — distinct
    /// from the vault's existing phrase — is exactly what
    /// `reset_recovery_phrase` does. The resulting `_recovery.json` must:
    ///   - unwrap under the NEW phrase to yield master_new
    ///   - NOT unwrap under the OLD phrase it replaces
    ///   - bump `_meta.json` epoch by exactly one
    ///   - keep the pre-reset content epoch (1) decryptable via master_new
    ///     (a phrase reset must not disturb lazy rotation's guarantees)
    #[tokio::test]
    async fn reset_flow_replaces_recovery_phrase_and_preserves_old_content_epoch() {
        use crate::sync::keyring_v2::io::{
            read_content, read_meta, read_recovery, test_support::InMemoryKeyringProvider,
            write_device_slot, write_recovery,
        };
        use crate::sync::keyring_v2::types::{DeviceSlotV2, RecoverySlotV2};
        use crate::sync::rotation::{publish::publish_keyring, RecoverySource};
        use crate::utils::encryption::{decrypt_data, unwrap_content_key};
        use crate::utils::recovery::{
            derive_recovery_key, generate_recovery_mnemonic, validate_recovery_mnemonic,
        };

        let old_master = [0x55u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let original_content_key = *generate_content_key();
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&old_master)),
            )
            .unwrap();
            db::upsert_device(
                &conn,
                &db::DeviceRow {
                    device_id: device_id.to_string(),
                    name: "Test".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();
            write_content_list_to_db(&conn, &old_master, 1, &original_content_key);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&old_master);

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &old_master, 1, 1).await;
        crate::sync::recovery::bootstrap_sync_control(&provider, 0)
            .await
            .unwrap();
        write_device_slot(
            &provider,
            &DeviceSlotV2 {
                version: KEYRING_V2_VERSION,
                device_id: device_id.to_string(),
                name: "Test".to_string(),
                created_at: 0,
                last_seen_at: 0,
            },
        )
        .await
        .unwrap();

        // Seed the ORIGINAL recovery phrase + _recovery.json — the phrase
        // this reset is supposed to retire.
        let original_mnemonic = generate_recovery_mnemonic().unwrap();
        let original_parsed = validate_recovery_mnemonic(&original_mnemonic).unwrap();
        let original_recovery_key = derive_recovery_key(&original_parsed);
        let original_wrapped_hex = {
            let blob =
                crate::utils::encryption::encrypt_data(&*original_recovery_key, &old_master[..])
                    .unwrap();
            hex::encode(&blob)
        };
        write_recovery(
            &provider,
            &RecoverySlotV2 {
                version: KEYRING_V2_VERSION,
                wrapped_master: original_wrapped_hex.clone(),
                created_at: 0,
            },
        )
        .await
        .unwrap();

        // ── Act: reset — mint a NEW mnemonic, distinct from the original ────
        let new_mnemonic = generate_recovery_mnemonic().unwrap();
        assert_ne!(
            *new_mnemonic, *original_mnemonic,
            "test setup sanity: the new phrase must differ from the original"
        );

        let (rotation_id, ctx, new_content_epoch) = rotate_keys(
            &provider,
            &app_state,
            &key_state,
            "password",
            None,
            Some(&new_mnemonic),
            None,
        )
        .await
        .unwrap();

        publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Stashed,
            None,
            new_content_epoch,
        )
        .await
        .unwrap();

        // ── Assert 1: _recovery.json was actually rewritten ─────────────────
        let recovery_after = read_recovery(&provider).await.unwrap().unwrap();
        assert_ne!(
            recovery_after.wrapped_master, original_wrapped_hex,
            "_recovery.json must be rewritten — the wrapped bytes must change"
        );

        // ── Assert 2: NEW phrase unwraps to master_new ──────────────────────
        let new_parsed = validate_recovery_mnemonic(&new_mnemonic).unwrap();
        let new_recovery_key = derive_recovery_key(&new_parsed);
        let recovered = decrypt_data(
            &*new_recovery_key,
            &hex::decode(&recovery_after.wrapped_master).unwrap(),
        )
        .unwrap();
        assert_eq!(
            recovered,
            &ctx.master_key_new[..],
            "new phrase must unwrap _recovery.json to master_new"
        );

        // ── Assert 3: OLD phrase no longer unwraps _recovery.json ───────────
        let old_unwrap_result = decrypt_data(
            &*original_recovery_key,
            &hex::decode(&recovery_after.wrapped_master).unwrap(),
        );
        assert!(
            old_unwrap_result.is_err(),
            "old phrase must NOT unwrap the post-reset _recovery.json"
        );

        // ── Assert 4: epoch bumped by exactly one ───────────────────────────
        let meta_after = read_meta(&provider).await.unwrap().unwrap();
        assert_eq!(
            meta_after.epoch, 2,
            "master epoch must bump by exactly one (1 -> 2)"
        );

        // ── Assert 5: pre-reset content epoch 1 remains decryptable via
        //    master_new (lazy rotation preserved through a phrase reset) ────
        let content_after = read_content(&provider).await.unwrap().unwrap();
        let epoch1_entry = content_after
            .entries
            .iter()
            .find(|e| e.epoch == 1)
            .expect("epoch 1 entry must still be present in _content.json");
        let blob = hex::decode(&epoch1_entry.wrapped_content).unwrap();
        let unwrapped_ck1 = unwrap_content_key(&ctx.master_key_new, &blob).unwrap();
        assert_eq!(
            *unwrapped_ck1, original_content_key,
            "pre-reset content epoch 1 must still decrypt to the original content key via master_new"
        );
    }

    /// P6-2: when rotate_keys is called with None (revoke path), the recovery
    /// mnemonic stash must NOT be written.
    #[tokio::test]
    async fn rotate_keys_without_mnemonic_does_not_set_stash() {
        let master = [0xA2u8; 32];
        let conn = setup_db();
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::set_setting(
                &conn,
                db::CLOUD_MASTER_FINGERPRINT,
                &hex::encode(key_fingerprint(&master)),
            )
            .unwrap();
            let ck1 = *generate_content_key();
            write_content_list_to_db(&conn, &master, 1, &ck1);
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
        }
        let app_state = make_app_state(conn);
        let key_state = make_key_state(&master);

        let provider = InMemoryKeyringProvider::new();
        write_cloud_meta(&provider, &master, 1, 1).await;

        rotate_keys(
            &provider, &app_state, &key_state, "password", None,
            None, // revoke path: no stash
            None,
        )
        .await
        .unwrap();

        // No stash must be written when None is passed.
        let conn = app_state.lock().unwrap();
        let stash = db::get_rotation_recovery_stash(&conn).unwrap();
        assert!(
            stash.is_none(),
            "recovery stash must NOT be set when rotate_keys is called with None"
        );
    }
}
