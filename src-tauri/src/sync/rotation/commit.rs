//! Phase 3 of the rotation state machine: commit the new master key locally.
//!
//! Steps:
//! 1. Generate a new `kek_salt` and wrap `master_key_new` with the device password.
//! 2. Write the boot file with NEW material (db_key re-wrapped under new KEK,
//!    content-key list re-wrapped under master_key_new).
//!    The SQLCipher DB stays keyed under derive_sqlcipher_key(db_key) — db_key
//!    itself never changes on rotation, only the password-KEK-wrap of it changes.
//! 3. Update local settings in a single transaction:
//!    `wrapped_encryption_key`, `kek_salt`, `password_hash`, `cloud_master_fingerprint`,
//!    `keyring_v2_local_epoch`, `recovery_wrapped_master_key`, `last_master_key_rotation_at`,
//!    `wrapped_content_list` (re-wrapped under master_key_new).
//! 4. Transition job to `enumerate_stragglers`.
//!
//! **No PRAGMA rekey** — rotation never re-encrypts the local DB.  The DB key
//! (`db_key`, derived once at onboarding) does not change; only the master key
//! rotates.  The one-time `db_key`-keying happened in the T3 migration at first
//! unlock after Phase 3 was deployed.
//!
//! The new wrap + salt are persisted to settings and the boot file **inside**
//! this module; they are no longer returned for a cloud device slot, because
//! device slots are metadata-only since the Phase 2 de-grind.

use crate::db;
use crate::utils::encryption::{
    decode_content_key_list, encode_content_key_list, generate_encryption_salt, parse_kek_params,
    wrap_content_key, wrap_key_with, KdfParams,
};
use crate::{AppState, EncryptionKeyState};

use super::{state, RotationContext};

/// Commit the new master key to local storage.
///
/// `boot_path` is `None` in tests (skips file I/O).
/// In production the caller resolves it from `app.path().app_data_dir()`.
///
/// Transitions the job to `enumerate_stragglers` (old slow-path). The Phase 4
/// lazy path calls `commit_local_inner` directly with `PUBLISH_KEYRING`.
pub async fn commit_local(
    app_state: &AppState,
    rotation_id: i64,
    ctx: &RotationContext,
    current_password: &str,
    // Not used in logic — kept for API symmetry with onboard_complete_inner.
    _marker: Option<()>,
) -> Result<(), String> {
    commit_local_inner(
        app_state,
        rotation_id,
        ctx,
        current_password,
        None,
        None,
        state::ENUMERATE_STRAGGLERS,
    )
    .await
}

/// Inner implementation — allows injecting a real `boot_path` and key state for production.
///
/// `key_state` is optional; when `Some`, we use it to re-wrap `wrapped_db_key` under the
/// new password KEK and compute `master_wrapped_db_key = wrap(master_key_new, db_key)`.
/// When `None` (tests), `wrapped_db_key` / `master_wrapped_db_key` are carried forward
/// unchanged from the existing boot file.
///
/// `next_state` controls the job-state transition at the end of the atomic settings tx:
/// - `state::ENUMERATE_STRAGGLERS` for the old slow-rotate path (default via `commit_local`).
/// - `state::PUBLISH_KEYRING` for the Phase 4 lazy-rotate path (called by `rotate_keys`).
pub(crate) async fn commit_local_inner(
    app_state: &AppState,
    rotation_id: i64,
    ctx: &RotationContext,
    current_password: &str,
    boot_path: Option<&std::path::Path>,
    key_state: Option<&EncryptionKeyState>,
    next_state: &str,
) -> Result<(), String> {
    // 1. Generate new KEK salt and wrap the new master key.
    //
    //    Preserve the vault's current KDF strength: the displayed "Encryption
    //    strength" is parsed back from this blob, so re-wrapping under a fixed
    //    preset would silently flip the user's choice. Read the existing blob
    //    (still present — settings are overwritten only in step 5) and reuse its
    //    params. Missing/unparseable → FAST (unwrap reads the header we write
    //    regardless; all new blobs are FAST).
    let current_params = {
        let conn = app_state.lock()?;
        db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .ok()
            .flatten()
            .and_then(|hex| hex::decode(hex).ok())
            .and_then(|blob| parse_kek_params(&blob).ok())
            .unwrap_or(KdfParams::FAST)
    };
    let kek_salt_bytes = generate_encryption_salt();
    let kek_salt_hex = hex::encode(&kek_salt_bytes);
    let wrapped_hex = wrap_key_with(
        &*ctx.master_key_new,
        current_password,
        &kek_salt_bytes,
        current_params,
    )
    .map_err(|e| format!("commit_local: wrap_key failed: {e}"))?;

    let now_secs = now_unix();

    // 2. Boot file update (production only — no-op in tests where boot_path is None).
    //
    // The SQLCipher DB key (db_key) never changes on rotation — only master
    // rotates. Re-wrap db_key under the NEW password KEK (new kek_salt) so the
    // next unlock can reach it with the new password.
    //
    // CRITICAL: also re-wrap the content-key list under master_key_new. The list
    // is AES-GCM(master_key_old, content_key) — it will GCM auth-fail if the next
    // unlock tries to decode it with master_key_new. Re-wrap it here while we have
    // both master_key_old (ctx.master_key_old) and master_key_new (ctx.master_key_new).
    // Write the new-master-wrapped list to BOTH the boot file and DB settings so
    // the next unlock (T2 arm) can read the canonical copy from either source.
    //
    // `wrapped_content_list_new_hex` is computed before the boot file write so that a
    // failure here aborts before any irreversible state change.
    let wrapped_content_list_new_hex: Option<String> = if key_state.is_some() {
        // Production path: read the old list from DB, decode under master_old,
        // re-encode under master_new.
        let list_hex_old = {
            let conn = app_state.lock()?;
            db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
                .map_err(|e| format!("commit_local: read WRAPPED_CONTENT_LIST: {e}"))?
        };
        match list_hex_old {
            Some(hex_old) => {
                // Idempotent decode: if the list was already re-wrapped under
                // master_key_new (crash between step 3 and step 4 left state as
                // COMMIT_LOCAL but the list was already committed), decoding under
                // master_key_old will fail with a GCM auth error.  In that case
                // attempt decode under master_key_new; success means the re-wrap is
                // already done — carry the existing hex forward unchanged so step 3
                // is safe to re-enter after a crash.
                match decode_content_key_list(&ctx.master_key_old, &hex_old) {
                    Ok(keys_map) => {
                        let re_encoded = encode_content_key_list(&ctx.master_key_new, &keys_map)
                            .map_err(|e| format!("commit_local: re-encode content list: {e}"))?;
                        Some(re_encoded)
                    }
                    Err(_) => match decode_content_key_list(&ctx.master_key_new, &hex_old) {
                        Ok(_) => {
                            log::info!(
                                "commit_local: content list already under master_key_new \
                                 (crash resume) — skipping re-wrap"
                            );
                            // Already under master_new; the DB value is already correct.
                            // Return the existing hex so the boot file is also updated
                            // consistently (both sources should agree).
                            Some(hex_old)
                        }
                        Err(e) => {
                            return Err(format!(
                                "commit_local: decode content list under both old and new \
                                 master failed: {e}"
                            ))
                        }
                    },
                }
            }
            // No content list in DB (pre-Phase-3 device that hasn't unlocked yet,
            // or a fresh vault that never set it). Write None — the T3 migration
            // will generate the list on next unlock.
            None => None,
        }
    } else {
        // Test path: no app state I/O; skip re-wrap (tests do not exercise unlock).
        None
    };

    if let Some(bp) = boot_path {
        use crate::utils::boot_file::{load, save, BootFile};

        // T5: Re-wrap db_key under the new password KEK (new kek_salt_hex)
        // and under the new master key (master_key_new).
        //
        // Rotation generates a new kek_salt, so the old wrapped_db_key (which
        // was wrapped under the old kek_salt) cannot be unwrapped with the new
        // one. Re-wrap under the new KEK so the next unlock can unwrap db_key.
        //
        // key_state is Some in production; None in unit tests (which use no boot
        // file and don't exercise unlock, so carrying forward the old value is safe).
        let (new_wrapped_db_key, new_master_wrapped_db_key) = if let Some(ks) = key_state {
            let new_wrapped_db_key = Some(
                ks.with_db_key(|db_key| {
                    let kek = crate::utils::encryption::derive_encryption_key_with(
                        current_password,
                        &kek_salt_bytes,
                        current_params,
                    )?;
                    let blob = wrap_content_key(&kek, db_key)?;
                    Ok(hex::encode(&blob))
                })
                .map_err(|e| {
                    format!("commit_local: failed to re-wrap db_key under new KEK: {e}")
                })?,
            );
            let new_master_wrapped_db_key = Some(
                ks.with_db_key(|db_key| {
                    let blob = wrap_content_key(&ctx.master_key_new, db_key)?;
                    Ok(hex::encode(&blob))
                })
                .map_err(|e| {
                    format!("commit_local: failed to re-wrap db_key under new master: {e}")
                })?,
            );
            (new_wrapped_db_key, new_master_wrapped_db_key)
        } else {
            // Test path: no key_state available; carry forward old values unchanged.
            let old_boot = load(bp).unwrap_or_default();
            (
                old_boot.wrapped_db_key.clone(),
                old_boot.master_wrapped_db_key.clone(),
            )
        };

        // Write the boot file with new key material.
        save(
            &BootFile {
                mode: db::EncryptionMode::Password,
                // Rotation generates a NEW master key. os_kek wraps the OLD
                // master and would decrypt successfully to it (AES-GCM has no
                // way to know the plaintext is "stale") — carrying it forward
                // would silently unlock into a dead master whose db_key wrap
                // no longer matches. Drop it here, same treatment as
                // recovery_wrapped below. `restore_biometric_keychain_after_rotation`
                // (keychain.rs, called by every rotation caller after this
                // commits) re-establishes it against master_key_new using the
                // SAME os_kek — the os_kek itself is untouched by rotation.
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                kek_salt: Some(kek_salt_hex.clone()),
                wrapped_key: Some(wrapped_hex.clone()),
                os_kek_wrapped_master: None,
                // Rotation generates a NEW master key. The old recovery slot
                // would unwrap the dead key, so it must NOT be carried forward.
                // Drop it here; the post-rotation publish_keyring stage refreshes
                // the recovery slot (cloud + DB), and the next unlock backfills
                // it into the boot file. None = offline recovery temporarily
                // absent (safe); stale = lockout (catastrophic).
                recovery_wrapped: None,
                // Re-wrapped under master_key_new (computed above). Provides the
                // canonical source for the next unlock's T2 arm. If None (pre-Phase-3
                // device), the next unlock will run T3 to generate the list.
                wrapped_content_list: wrapped_content_list_new_hex.clone(),
                // `wrapped_db_key` is re-wrapped under the new password KEK
                // (new kek_salt) so the next unlock can unwrap db_key correctly.
                wrapped_db_key: new_wrapped_db_key,
                // `master_wrapped_db_key` is re-wrapped under master_key_new so
                // recover_with_passphrase and biometric paths remain functional.
                master_wrapped_db_key: new_master_wrapped_db_key,
                migration_in_progress: None,
            },
            bp,
        )
        .map_err(|e| format!("commit_local: boot file write failed: {e}"))?;
    }

    // 3+4. Write settings AND transition job state in ONE atomic transaction.
    //
    // Previously step 3 (settings) and step 4 (ENUMERATE_STRAGGLERS) were two
    // separate connection locks.  A crash between them left the content-key list
    // under master_key_new while state was still COMMIT_LOCAL.  On resume,
    // commit_local_inner would re-read WRAPPED_CONTENT_LIST and attempt to decode
    // it under master_key_old → GCM auth failure → rotation wedged.
    //
    // Folding both writes into a single transaction makes steps 3 and 4 atomic:
    // either both commit (normal path) or neither does (crash → resume starts with
    // the list still under master_key_old and state still COMMIT_LOCAL → clean
    // re-entry).  The idempotent-decode guard above provides a second line of
    // defence for any window that existed before this change was deployed.
    {
        let conn = app_state.lock()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("commit_local: begin settings tx: {e}"))?;
        db::set_setting(&tx, db::WRAPPED_ENCRYPTION_KEY_KEY, &wrapped_hex)
            .map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::KEK_SALT_KEY, &kek_salt_hex).map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::LAST_MASTER_KEY_ROTATION_AT, &now_secs.to_string())
            .map_err(|e| e.to_string())?;
        // Refresh password hash (same password; ensures any new hash parameters take effect).
        db::set_password_hash(&tx, current_password).map_err(|e| e.to_string())?;
        // Persist the re-wrapped content-key list under master_key_new so both
        // the boot file and DB agree. This ensures that even if the boot file is
        // lost (corrupt, deleted), the next unlock can reconstruct from DB.
        if let Some(new_list_hex) = &wrapped_content_list_new_hex {
            db::set_setting(&tx, db::WRAPPED_CONTENT_LIST, new_list_hex)
                .map_err(|e| e.to_string())?;
        }
        // Transition job to `next_state` in the same transaction so
        // settings + state commit atomically.
        // - Old path: `ENUMERATE_STRAGGLERS` (via `commit_local`).
        // - Phase 4 lazy path: `PUBLISH_KEYRING` (via `rotate_keys`).
        db::update_rotation_job_state(&tx, rotation_id, next_state).map_err(|e| e.to_string())?;
        tx.commit()
            .map_err(|e| format!("commit_local: settings tx commit: {e}"))?;
    }

    Ok(())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use rusqlite::Connection;
    use zeroize::Zeroizing;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn make_app_state(conn: Connection) -> AppState {
        AppState::new(conn)
    }

    fn make_ctx(new_key: [u8; 32]) -> RotationContext {
        RotationContext {
            master_key_old: Zeroizing::new([1u8; 32]),
            master_key_new: Zeroizing::new(new_key),
        }
    }

    #[tokio::test]
    async fn commit_local_updates_settings_and_transitions_state() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };

        let ctx = make_ctx([2u8; 32]);
        commit_local(&app_state, rotation_id, &ctx, "mypassword!", None)
            .await
            .unwrap();
        let (wrapped_hex, kek_salt_hex) = {
            let conn = app_state.lock().unwrap();
            let w = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
                .unwrap()
                .expect("commit_local must persist wrapped_encryption_key");
            let s = db::get_setting(&conn, db::KEK_SALT_KEY)
                .unwrap()
                .expect("commit_local must persist kek_salt");
            (w, s)
        };

        assert!(!wrapped_hex.is_empty());
        assert!(!kek_salt_hex.is_empty());

        let conn = app_state.lock().unwrap();

        // Settings should be updated.
        let stored_wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .unwrap();
        assert_eq!(stored_wrapped, wrapped_hex);

        let stored_salt = db::get_setting(&conn, db::KEK_SALT_KEY).unwrap().unwrap();
        assert_eq!(stored_salt, kek_salt_hex);

        let rotation_at = db::get_setting(&conn, db::LAST_MASTER_KEY_ROTATION_AT).unwrap();
        assert!(rotation_at.is_some());

        // State should have transitioned to enumerate_stragglers.
        let job = db::find_active_rotation_job(&conn).unwrap().unwrap();
        assert_eq!(job.state, state::ENUMERATE_STRAGGLERS);
    }

    #[tokio::test]
    async fn commit_local_wrapped_key_is_unwrappable() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };

        let new_master = [42u8; 32];
        let ctx = make_ctx(new_master);
        commit_local(
            &app_state,
            rotation_id,
            &ctx,
            "correcthorsebatterystaple",
            None,
        )
        .await
        .unwrap();

        // commit_local persists the new wrap + salt to settings rather than
        // returning them (device slots are metadata-only). Read them back and
        // assert the same property the returned tuple used to prove.
        let (wrapped_hex, kek_salt_hex) = {
            let conn = app_state.lock().unwrap();
            let w = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
                .unwrap()
                .expect("commit_local must persist wrapped_encryption_key");
            let s = db::get_setting(&conn, db::KEK_SALT_KEY)
                .unwrap()
                .expect("commit_local must persist kek_salt");
            (w, s)
        };

        // Verify the wrapped key can be unwrapped to recover new_master.
        let salt_bytes = hex::decode(&kek_salt_hex).expect("kek_salt_hex must be valid hex");
        let recovered = crate::utils::encryption::unwrap_key(
            &wrapped_hex,
            "correcthorsebatterystaple",
            &salt_bytes,
        )
        .expect("unwrap should succeed with correct password");
        assert_eq!(*recovered, new_master);
    }

    /// Rotation must PRESERVE the vault's KDF params. The wrapped-key blob is
    /// self-describing (134-hex), so rotation must re-wrap under the same params.
    /// Seed a FAST blob, rotate, assert the result is still FAST.
    #[tokio::test]
    async fn commit_local_preserves_fast_kdf_params() {
        use crate::utils::encryption::{parse_kek_params, wrap_key_with, KdfParams};

        let conn = setup_db();
        let app_state = make_app_state(conn);

        // Seed an existing FAST-strength wrapped blob. Captured so the
        // assertion below can prove it was actually replaced — reading the
        // setting back would otherwise pass vacuously if `commit_local` wrote
        // nothing at all.
        let seeded_blob: String;
        // Seed an existing FAST-strength wrapped blob.
        {
            let conn = app_state.lock().unwrap();
            let salt = crate::utils::encryption::generate_encryption_salt();
            let fast_blob =
                wrap_key_with(&[7u8; 32], "mypassword!", &salt, KdfParams::FAST).unwrap();
            db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &fast_blob).unwrap();
            seeded_blob = fast_blob.clone();
        }

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };

        let ctx = make_ctx([2u8; 32]);
        commit_local(&app_state, rotation_id, &ctx, "mypassword!", None)
            .await
            .unwrap();

        let wrapped_hex = {
            let conn = app_state.lock().unwrap();
            db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
                .unwrap()
                .expect("commit_local must persist wrapped_encryption_key")
        };

        let blob = hex::decode(&wrapped_hex).unwrap();
        let params = parse_kek_params(&blob).unwrap();
        assert_ne!(
            wrapped_hex, seeded_blob,
            "commit_local must have rewritten the wrap; otherwise this test \
             would be inspecting the seeded blob and proving nothing"
        );
        assert_eq!(
            params.m_cost,
            KdfParams::FAST.m_cost,
            "rotation must preserve FAST strength, not revert to HIGH"
        );
    }

    /// commit_local re-wraps the content-key list under master_key_new and persists
    /// it to the DB settings (WRAPPED_CONTENT_LIST). The T2 unlock path depends on
    /// this so the next unlock after rotation can open the DB and load the list.
    #[tokio::test]
    async fn commit_local_rewraps_content_list_under_new_master() {
        use crate::utils::encryption::{
            decode_content_key_list, encode_content_key_list, generate_content_key,
        };

        let conn = setup_db();

        let master_old = Zeroizing::new([1u8; 32]);
        let master_new = Zeroizing::new([2u8; 32]);

        // Seed a real content-key list wrapped under master_old.
        let v1 = Zeroizing::new(*generate_content_key());
        let mut keys_map_old = std::collections::BTreeMap::new();
        keys_map_old.insert(1u32, v1.clone());
        let encoded_old = encode_content_key_list(&master_old, &keys_map_old).unwrap();
        db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &encoded_old).unwrap();

        let app_state = make_app_state(conn);
        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };

        let ctx = RotationContext {
            master_key_old: master_old,
            master_key_new: master_new.clone(),
        };

        // Build a real EncryptionKeyState with a dummy db_key so that
        // key_state.is_some() = true and the production branch executes.
        let fake_db_key = Zeroizing::new([0xABu8; 32]);
        let key_state = crate::EncryptionKeyState::new();
        {
            let mut keys = std::collections::BTreeMap::new();
            keys.insert(1u32, Zeroizing::new([0u8; 32]));
            key_state
                .set_content_state(keys, 1, fake_db_key, Zeroizing::new([0u8; 32]))
                .unwrap();
        }

        commit_local_inner(
            &app_state,
            rotation_id,
            &ctx,
            "mypassword!",
            None, // boot_path=None: skip boot file I/O
            Some(&key_state),
            state::ENUMERATE_STRAGGLERS,
        )
        .await
        .unwrap();

        // The DB setting must now be re-wrapped under master_new.
        let conn = app_state.lock().unwrap();
        let new_list_hex = db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
            .unwrap()
            .expect("WRAPPED_CONTENT_LIST must be present after commit_local");

        // Decode under master_new — must succeed and yield the same v1 key.
        let decoded_new =
            decode_content_key_list(&master_new, &new_list_hex).expect("decode under master_new");
        assert_eq!(decoded_new.len(), 1, "must have exactly 1 epoch");
        assert_eq!(
            decoded_new[&1].as_ref(),
            v1.as_ref(),
            "v1 content key must round-trip through rotation re-wrap"
        );

        // Decoding under master_old must FAIL (different master, GCM auth failure).
        let old_master_attempt = decode_content_key_list(&Zeroizing::new([1u8; 32]), &new_list_hex);
        assert!(
            old_master_attempt.is_err(),
            "decode under old master must fail after re-wrap"
        );
    }

    /// When boot file write fails, settings must NOT be modified.
    ///
    /// Rotation must DROP the os_kek wrap and revert `unlock_method` to
    /// `Password`.
    ///
    /// Why this matters: the os_kek wrap holds `AES-GCM(os_kek, master_OLD)`.
    /// Rotation mints a new master, so carrying the wrap forward would leave a
    /// blob that decrypts to a **dead** key — the next biometric unlock would
    /// unwrap the old master and then fail GCM auth on `master_wrapped_db_key`.
    /// `restore_biometric_keychain_after_rotation` re-establishes the wrap
    /// against the new master afterwards.
    ///
    /// This also pins the structural reason a vault can never be os_kek-only:
    /// rotation rebuilds `kek_salt` + `wrapped_key` **from the password**, so a
    /// device with no password could not rotate at all.
    #[tokio::test]
    async fn commit_local_drops_stale_os_kek_wrap_and_reverts_unlock_method() {
        use crate::utils::boot_file::{load, save, BootFile, UnlockMethod};

        let dir = tempfile::tempdir().unwrap();
        let boot_path = dir.path().join("memlore.db.boot");

        // Pre-rotation boot file: biometric enabled, so an os_kek wrap exists.
        let stale_os_kek_wrap = "ab".repeat(60);
        save(
            &BootFile {
                mode: db::EncryptionMode::Password,
                unlock_method: UnlockMethod::Both,
                kek_salt: Some("00".repeat(16)),
                wrapped_key: Some("cd".repeat(67)),
                os_kek_wrapped_master: Some(stale_os_kek_wrap.clone()),
                recovery_wrapped: None,
                wrapped_content_list: None,
                wrapped_db_key: None,
                master_wrapped_db_key: None,
                migration_in_progress: None,
            },
            &boot_path,
        )
        .unwrap();

        // Sanity: the fixture really is in the state we claim, otherwise the
        // assertions below would pass without rotation having done anything.
        let before = load(&boot_path).unwrap();
        assert_eq!(before.unlock_method, UnlockMethod::Both);
        assert_eq!(
            before.os_kek_wrapped_master.as_deref(),
            Some(stale_os_kek_wrap.as_str())
        );

        let conn = setup_db();
        let app_state = make_app_state(conn);
        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        let ctx = make_ctx([42u8; 32]);

        commit_local_inner(
            &app_state,
            rotation_id,
            &ctx,
            "mypassword!",
            Some(&boot_path),
            None, // key_state None → unit-test path, no PRAGMA rekey
            state::ENUMERATE_STRAGGLERS,
        )
        .await
        .unwrap();

        let after = load(&boot_path).unwrap();
        assert_eq!(
            after.os_kek_wrapped_master, None,
            "stale os_kek wrap must be dropped — it decrypts to the OLD master"
        );
        assert_eq!(
            after.unlock_method,
            UnlockMethod::Password,
            "unlock_method must revert until restore_biometric_keychain_after_rotation runs"
        );
        // Rotation rebuilt the password wrap from `current_password`; without it
        // the boot file would have no unlock method at all.
        assert!(after.wrapped_key.is_some() && after.kek_salt.is_some());
        assert_ne!(
            after.wrapped_key, before.wrapped_key,
            "the password wrap must be re-derived against the NEW master"
        );
    }

    /// Rotation writes the boot file before the settings transaction. If the
    /// boot file write fails we abort early and the settings remain on the old
    /// values — no lockout risk.
    ///
    /// We simulate the failure by passing a `boot_path` that points to a file
    /// in a non-existent directory so `save()` returns an error immediately.
    #[tokio::test]
    async fn commit_local_rekey_failure_leaves_settings_unchanged() {
        let conn = setup_db();

        // Pre-populate OLD settings values so we can verify they are NOT overwritten.
        let old_wrapped = "old_wrapped_value";
        let old_salt = "old_salt_value";
        db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, old_wrapped).unwrap();
        db::set_setting(&conn, db::KEK_SALT_KEY, old_salt).unwrap();

        let app_state = make_app_state(conn);

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };

        let ctx = make_ctx([99u8; 32]);

        // Use a boot_path inside a non-existent directory — the save will fail
        // which simulates the "boot file write failed" early abort, verifying
        // that settings are NOT touched when we abort before the rekey.
        let non_existent_dir = std::path::PathBuf::from("/does/not/exist/boot.json");
        let result = commit_local_inner(
            &app_state,
            rotation_id,
            &ctx,
            "mypassword!",
            Some(&non_existent_dir),
            None,
            state::ENUMERATE_STRAGGLERS, // next_state (irrelevant — test errors before this)
        )
        .await;

        // Must return an error.
        assert!(result.is_err(), "expected error, got Ok");

        let conn = app_state.lock().unwrap();

        // Settings must NOT have been changed — still point to old key.
        let stored_wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .unwrap();
        assert_eq!(
            stored_wrapped, old_wrapped,
            "settings were modified despite boot file failure — lockout risk"
        );
        let stored_salt = db::get_setting(&conn, db::KEK_SALT_KEY).unwrap().unwrap();
        assert_eq!(
            stored_salt, old_salt,
            "KEK salt was modified despite boot file failure — lockout risk"
        );
    }

    /// Simulates the crash window between step 3 (content-list re-wrap committed)
    /// and step 4 (ENUMERATE_STRAGGLERS transition).
    ///
    /// Before the fix, commit_local_inner re-read WRAPPED_CONTENT_LIST from DB on
    /// resume and tried to decode it under master_key_old → GCM auth failure →
    /// rotation wedged permanently.
    ///
    /// After the fix (idempotent decode + atomic step 3/4 transaction), the list
    /// is already under master_key_new and commit_local_inner must detect that,
    /// skip the re-wrap, and complete successfully.
    #[tokio::test]
    async fn commit_local_crash_resume_with_list_already_under_master_new() {
        use crate::utils::encryption::{
            decode_content_key_list, encode_content_key_list, generate_content_key,
        };

        let conn = setup_db();

        let master_old = Zeroizing::new([1u8; 32]);
        let master_new = Zeroizing::new([2u8; 32]);

        // Simulate crash state: WRAPPED_CONTENT_LIST is already under master_new
        // (step 3 committed) but job state is still COMMIT_LOCAL (step 4 crashed).
        let v1 = Zeroizing::new(*generate_content_key());
        let mut keys_map = std::collections::BTreeMap::new();
        keys_map.insert(1u32, v1.clone());
        // Encode under master_NEW — this is the post-crash state.
        let encoded_new = encode_content_key_list(&master_new, &keys_map).unwrap();
        db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &encoded_new).unwrap();

        let app_state = make_app_state(conn);
        // Insert job and advance it to COMMIT_LOCAL state (simulating a crash that
        // happened after step 3 committed the list but before step 4 transitioned
        // the state — only possible before the atomic fix was in place).
        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let id = db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap();
            db::update_rotation_job_state(&conn, id, state::COMMIT_LOCAL).unwrap();
            id
        };

        let ctx = RotationContext {
            master_key_old: master_old,
            master_key_new: master_new.clone(),
        };

        // Build a real EncryptionKeyState so the production (key_state.is_some()) branch
        // executes and reads WRAPPED_CONTENT_LIST from DB.
        let fake_db_key = Zeroizing::new([0xCDu8; 32]);
        let key_state = crate::EncryptionKeyState::new();
        {
            let mut keys = std::collections::BTreeMap::new();
            keys.insert(1u32, Zeroizing::new([0u8; 32]));
            key_state
                .set_content_state(keys, 1, fake_db_key, Zeroizing::new([0u8; 32]))
                .unwrap();
        }

        // Must succeed even though WRAPPED_CONTENT_LIST is already under master_new.
        let result = commit_local_inner(
            &app_state,
            rotation_id,
            &ctx,
            "mypassword!",
            None, // boot_path=None: skip boot file I/O
            Some(&key_state),
            state::ENUMERATE_STRAGGLERS, // next_state for old-path crash resume
        )
        .await;

        assert!(result.is_ok(), "crash resume must succeed: {:?}", result);

        // Job state must have transitioned to ENUMERATE_STRAGGLERS.
        let conn = app_state.lock().unwrap();
        let job = db::find_active_rotation_job(&conn).unwrap().unwrap();
        assert_eq!(
            job.state,
            state::ENUMERATE_STRAGGLERS,
            "job must transition to ENUMERATE_STRAGGLERS after crash resume"
        );

        // The content list in DB must still decode correctly under master_new.
        let stored_list = db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
            .unwrap()
            .expect("WRAPPED_CONTENT_LIST must be present");
        let decoded = decode_content_key_list(&master_new, &stored_list)
            .expect("decode under master_new must succeed");
        assert_eq!(
            decoded[&1].as_ref(),
            v1.as_ref(),
            "v1 key must be preserved"
        );
    }
}
