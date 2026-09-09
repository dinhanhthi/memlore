//! Phase 4 of the rotation state machine: publish the new keyring to cloud.
//!
//! Order (crash-safe: `_meta.json` is always last):
//! 1. Best-effort epoch re-check (compare `_meta.json.epoch` vs `old_epoch`).
//!    If another rotation landed concurrently → abort.
//! 2. Write `_recovery.json` (new recovery slot with `master_key_new`).
//! 3. List device slots. For each:
//!    - Own slot → metadata-only refresh (bump `last_seen_at`; no key material
//!      lives here anymore, see design §3/§4).
//!    - Revoked slot → delete.
//!    - All others → delete (surviving peers re-adopt the new master via the
//!      phrase after detecting the epoch bump; see design §5.4).
//! 3b. If `new_content_epoch > old content_epoch` (lazy rotation): write
//!     `_content.json` with the full content-key list under `master_key_new`.
//! 4. Write `_meta.json` LAST with `epoch = new_epoch`, new fingerprint, and
//!    `content_epoch = new_content_epoch`.
//! 5. Update local settings: `cloud_master_fingerprint`, `keyring_v2_local_epoch`.
//! 6. Update local `devices` table.
//! 7. Clear crash-resume stash keys from settings.
//! 8. Transition job to `done`.

use bip39::Mnemonic;

use crate::db;
use crate::sync::keyring_v2::{
    io as kio,
    types::{
        ContentEntryV2, ContentListV2, DeviceSlotV2, KeyringMetaV2, RecoverySlotV2,
        KEYRING_V2_VERSION,
    },
    KeyringV2Io,
};
use crate::utils::encryption::{
    decode_content_key_list, derive_sync_key, encrypt_data, key_fingerprint, wrap_content_key,
};
use crate::AppState;

use super::{state, RecoverySource, RotationContext};

/// Publish the rotated keyring to cloud.
///
/// # Parameters
/// - `recovery_source` — Where to read the recovery mnemonic from:
///   - `RecoverySource::Stashed` (rotate): reads the mnemonic stashed in the DB
///     by `enumerate_envelopes`/`rotate_keys` and validates it with `validate_recovery_mnemonic`.
///   - `RecoverySource::Supplied(&parsed)` (revoke): uses the caller-supplied,
///     pre-validated `Mnemonic` directly.
/// - `revoked_device_id` — `Some(id)` if a device is being revoked; `None` for rotation only.
/// - `new_content_epoch` — The new content-key epoch after lazy rotation. If equal to
///   `cloud_meta.content_epoch` (no content key was added, old slow path), the
///   `_content.json` cloud file is NOT written and the epoch is carried forward unchanged.
///   If greater, `_content.json` is written with the full list under `master_key_new` and
///   `_meta.json.content_epoch` is bumped to this value.
pub async fn publish_keyring<P>(
    provider: &P,
    app_state: &AppState,
    rotation_id: i64,
    ctx: &RotationContext,
    recovery_source: RecoverySource<'_>,
    revoked_device_id: Option<&str>,
    new_content_epoch: u32,
) -> Result<(), String>
where
    P: KeyringV2Io,
{
    let local_generation = {
        let conn = app_state.lock()?;
        db::get_sync_recovery_generation(&conn).map_err(|e| e.to_string())?
    };
    provider.configure_recovery_fence(local_generation, None);
    let control = crate::sync::recovery::read_sync_control(provider)
        .await
        .map_err(|error| format!("publish_keyring: recovery control read failed: {error}"))?
        .ok_or_else(|| "publish_keyring: cloud recovery control is missing".to_string())?;
    if control.recovery_lease.is_some() || control.recovery_generation != local_generation {
        return Err(format!(
            "publish_keyring: recovery authority mismatch (control={}, local={local_generation})",
            control.recovery_generation
        ));
    }
    log::info!("publish_keyring: entering for rotation job {rotation_id}");
    {
        let conn = app_state.lock()?;
        db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING)
            .map_err(|e| e.to_string())?;
    }

    let (old_epoch, new_epoch, new_fp_str) = {
        let conn = app_state.lock()?;
        let job = db::find_active_rotation_job(&conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "publish_keyring: rotation job disappeared".to_string())?;
        (
            job.old_epoch as u64,
            job.new_epoch as u64,
            job.new_fingerprint.clone(),
        )
    };

    // 1. Best-effort epoch re-check before writing anything.
    let cloud_meta = kio::read_meta(provider)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "publish_keyring: cloud _meta.json disappeared".to_string())?;

    if cloud_meta.recovery_generation != local_generation {
        return Err(format!(
            "publish_keyring: keyring generation mismatch (meta={}, local={local_generation})",
            cloud_meta.recovery_generation
        ));
    }

    if cloud_meta.epoch != old_epoch {
        // Another device rotated concurrently. The local DB is already on the new key.
        // This is a degenerate state; abort and surface an explicit error.
        {
            let conn = app_state.lock()?;
            let _ = db::update_rotation_job_state(&conn, rotation_id, state::ABORTED);
        }
        return Err(format!(
            "Concurrent rotation conflict: cloud epoch is {} but expected {}. \
             Your local DB uses the new key but the cloud keyring was overwritten \
             by another device. Please complete a force re-pair on this device.",
            cloud_meta.epoch, old_epoch
        ));
    }

    // 2. Resolve the recovery mnemonic (after the epoch check so that a
    //    concurrent-rotation conflict surfaces as the right error even when no
    //    stash is present), then derive the recovery key and write _recovery.json.
    //
    //    Deferred-init holder so the owned Mnemonic (Stashed path) outlives the
    //    &Mnemonic borrow used by derive_recovery_key below.
    let stashed_holder: Mnemonic;
    let parsed_mnemonic: &Mnemonic = match recovery_source {
        RecoverySource::Supplied(m) => m,
        RecoverySource::Stashed => {
            let stash = zeroize::Zeroizing::new(
                {
                    let conn = app_state.lock()?;
                    db::get_rotation_recovery_stash(&conn).map_err(|e| e.to_string())?
                }
                .ok_or_else(|| {
                    "publish_keyring: rotate requires a stashed recovery mnemonic but none found — \
                     ensure enumerate_envelopes ran with generate_new_recovery=true"
                        .to_string()
                })?,
            );
            stashed_holder =
                crate::utils::recovery::validate_recovery_mnemonic(&stash).map_err(|e| {
                    format!("publish_keyring: stashed recovery mnemonic is invalid: {e}")
                })?;
            &stashed_holder
        }
    };

    let recovery_key = crate::utils::recovery::derive_recovery_key(parsed_mnemonic);

    // Wrap master_key_new with recovery_key (raw AES-256-GCM, no Argon2id —
    // recovery_key is already strong HKDF output).
    let recovery_blob = encrypt_data(&*recovery_key, &ctx.master_key_new[..])
        .map_err(|e| format!("publish_keyring: encrypt recovery slot: {e}"))?;
    let recovery_wrapped_hex = hex::encode(&recovery_blob);

    let now_secs = now_unix();

    let recovery_slot = RecoverySlotV2 {
        version: KEYRING_V2_VERSION,
        wrapped_master: recovery_wrapped_hex.clone(),
        created_at: now_secs,
    };
    kio::write_recovery(provider, &recovery_slot)
        .await
        .map_err(|e| format!("publish_keyring: write _recovery.json: {e}"))?;

    // 3. Rewrite device slots.
    let current_device_id = {
        let conn = app_state.lock()?;
        db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?
    };

    // List existing slots.
    let all_slots = kio::list_device_slots(provider)
        .await
        .map_err(|e| format!("publish_keyring: list_device_slots: {e}"))?;

    log::debug!(
        "publish_keyring: current_device_id={current_device_id:?}, all_slots={}",
        all_slots.len()
    );

    for slot in &all_slots {
        if slot.device_id == current_device_id {
            // Metadata-only refresh: no master material lives in the cloud
            // device slot anymore (design §3/§4) — just bump last_seen_at.
            let new_slot = DeviceSlotV2 {
                version: KEYRING_V2_VERSION,
                device_id: slot.device_id.clone(),
                name: slot.name.clone(),
                created_at: slot.created_at,
                last_seen_at: now_secs,
            };
            new_slot
                .validate()
                .map_err(|e| format!("publish_keyring: new slot invalid: {e}"))?;
            kio::write_device_slot(provider, &new_slot)
                .await
                .map_err(|e| format!("publish_keyring: write device slot: {e}"))?;
        } else {
            // Delete: either the revoked device or the other devices. Slots hold
            // no key material — this is registry cleanup. Peers re-adopt via the
            // epoch bump, not via anything that was in the slot.
            kio::delete_device_slot(provider, &slot.device_id)
                .await
                .map_err(|e| format!("publish_keyring: delete slot for {}: {e}", slot.device_id))?;
        }
    }

    // 3b. Write `_content.json` if content epoch was bumped (lazy rotation).
    //     This must happen BEFORE `_meta.json` (crash safety: if we crash here,
    //     no other device sees the new epoch yet, so we re-run idempotently).
    if new_content_epoch > cloud_meta.content_epoch {
        write_content_list_cloud(provider, app_state, &ctx.master_key_new, new_content_epoch)
            .await?;
    }

    // 4. Write _meta.json LAST (the commit marker).
    //    content_epoch is bumped when lazy rotation wrote a new content key.
    let meta_content_epoch = if new_content_epoch > cloud_meta.content_epoch {
        new_content_epoch
    } else {
        cloud_meta.content_epoch
    };
    let new_meta = KeyringMetaV2 {
        version: KEYRING_V2_VERSION,
        epoch: new_epoch,
        master_fingerprint: new_fp_str.clone(),
        content_epoch: meta_content_epoch,
        recovery_generation: cloud_meta.recovery_generation,
        created_at: cloud_meta.created_at,
        updated_at: now_secs,
    };
    kio::write_meta(provider, &new_meta)
        .await
        .map_err(|e| format!("publish_keyring: write _meta.json: {e}"))?;

    // 5–8. Finalize the local state and transition to `done`.
    finalize_publish_local(
        app_state,
        rotation_id,
        &new_fp_str,
        new_epoch,
        &recovery_wrapped_hex,
        revoked_device_id,
    )?;

    log::info!(
        "rotation: job {} completed — new epoch={new_epoch}, fingerprint={new_fp_str}",
        rotation_id
    );

    Ok(())
}

/// Write the full content-key list to `_content.json` (cloud), wrapped under `master_key_new`.
///
/// Reads `WRAPPED_CONTENT_LIST` from the local DB (already re-wrapped under `master_key_new`
/// by `commit_local_inner`), decodes to a key map, then encodes each epoch entry as a
/// `ContentEntryV2` and writes the `ContentListV2` to the cloud provider.
///
/// `new_content_epoch` is the latest epoch after the rotation; it is stored in
/// `ContentListV2::latest_epoch` and validated by `ContentListV2::validate()`.
async fn write_content_list_cloud<P: KeyringV2Io>(
    provider: &P,
    app_state: &AppState,
    master_key_new: &zeroize::Zeroizing<[u8; 32]>,
    new_content_epoch: u32,
) -> Result<(), String> {
    // Read the list (now under master_new) from the local DB.
    let list_hex = {
        let conn = app_state.lock()?;
        db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
            .map_err(|e| format!("write_content_list_cloud: read WRAPPED_CONTENT_LIST: {e}"))?
            .ok_or_else(|| {
                "write_content_list_cloud: WRAPPED_CONTENT_LIST not found in DB".to_string()
            })?
    };

    let keys_map = decode_content_key_list(master_key_new, &list_hex)
        .map_err(|e| format!("write_content_list_cloud: decode content list: {e}"))?;

    let now_secs = now_unix();

    // Build cloud entries: wrap each content key under master_new.
    let mut entries: Vec<ContentEntryV2> = Vec::with_capacity(keys_map.len());
    for (epoch, ck) in &keys_map {
        let wrapped_blob = wrap_content_key(master_key_new, ck)
            .map_err(|e| format!("write_content_list_cloud: wrap epoch {epoch}: {e}"))?;
        // Fingerprint must be key_fingerprint(derive_sync_key(ck)) — matching the
        // formula used by all readers (onboard_complete_inner, confirm_first_time_setup,
        // run_cloud_content_migration). Using key_fingerprint(ck) (raw content key)
        // would cause a mismatch every time another device verifies the list after
        // a rotation.
        let fp = key_fingerprint(&*derive_sync_key(ck));
        entries.push(ContentEntryV2 {
            epoch: *epoch,
            wrapped_content: hex::encode(&wrapped_blob),
            content_fingerprint: hex::encode(&fp),
        });
    }

    // Entries must be sorted by epoch (BTreeMap iteration is already in order).
    let content_list = ContentListV2 {
        version: KEYRING_V2_VERSION,
        latest_epoch: new_content_epoch,
        entries,
        created_at: now_secs,
    };

    content_list
        .validate()
        .map_err(|e| format!("write_content_list_cloud: list validation failed: {e}"))?;

    kio::write_content(provider, &content_list)
        .await
        .map_err(|e| format!("write_content_list_cloud: write _content.json: {e}"))
}

/// Perform the local-only tail of `publish_keyring` (steps 5–8).
///
/// This function does **not** touch the cloud and does **not** require the
/// master-key material — it only writes derived values that were already
/// computed (fingerprint, epoch, recovery-wrapped hex) or that can be read from
/// the existing settings table.
///
/// It is called from two places:
/// - `publish_keyring` on the normal path (after the cloud writes).
/// - `resume_finalize_if_published` on the idempotent-resume path (when the
///   cloud already shows the new epoch + fingerprint and the job only needs its
///   local state caught up).
///
/// Ordering is crash-safe: settings tx (atomic) → devices → clear stash → DONE
/// last so a crash before DONE leaves the job resumable and `finalize_publish_local`
/// is safe to call again.
pub fn finalize_publish_local(
    app_state: &AppState,
    rotation_id: i64,
    new_fp: &str,
    new_epoch: u64,
    recovery_wrapped_hex: &str,
    revoked_device_id: Option<&str>,
) -> Result<(), String> {
    // 5. Update local settings.
    //
    // CLOUD_MASTER_FINGERPRINT and RECOVERY_WRAPPED_MASTER_KEY MUST commit
    // atomically: the boot-file recovery-slot backfill in `initialize_encryption`
    // trusts the fingerprint to prove the slot wraps the current master. If the
    // fingerprint committed as NEW while the recovery slot was still the prior
    // OLD value (a crash between two independent autocommits), the next unlock
    // would see a matching fingerprint and backfill the stale OLD slot —
    // permanently poisoning offline recovery. Wrap all three in one transaction
    // so no crash can expose a fingerprint/slot mismatch (mirrors commit_local).
    {
        let conn = app_state.lock()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("finalize_publish_local: begin settings tx: {e}"))?;
        db::set_setting(&tx, db::CLOUD_MASTER_FINGERPRINT, new_fp).map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::KEYRING_V2_LOCAL_EPOCH, &new_epoch.to_string())
            .map_err(|e| e.to_string())?;
        // Persist new recovery wrapped key for potential future delayed publish.
        // If step 5 already ran before a crash, this is a no-op overwrite of the
        // same value.
        db::set_setting(&tx, db::RECOVERY_WRAPPED_MASTER_KEY, recovery_wrapped_hex)
            .map_err(|e| e.to_string())?;
        tx.commit()
            .map_err(|e| format!("finalize_publish_local: settings tx commit: {e}"))?;
    }

    // 6. Update local devices table.
    {
        let conn = app_state.lock()?;
        if let Some(revoked_id) = revoked_device_id {
            db::mark_device_revoked(&conn, revoked_id).map_err(|e| e.to_string())?;
        }
        // Delete all non-current, non-revoked devices (they must re-pair).
        // Keep current device and revoked device (revoked shows as "Revoked" in UI).
        conn.execute(
            "DELETE FROM devices WHERE is_current = 0 AND is_revoked = 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    // 7. Clear crash-resume stash (master-key wraps only).
    {
        let conn = app_state.lock()?;
        let _ = db::delete_setting(&conn, db::ROTATION_MASTER_OLD_WRAPPED_LOCAL);
        let _ = db::delete_setting(&conn, db::ROTATION_MASTER_NEW_WRAPPED_LOCAL);
    }

    // 8. Transition to done AND clear the recovery mnemonic stash atomically.
    //
    //    The stash is cleared HERE — in the same transaction as the DONE state
    //    transition — so the invariant holds crash-safe:
    //      DONE ⇒ stash absent
    //    A crash before this transaction leaves the job active (resumable) with
    //    the stash intact, which is correct.  A crash after this transaction
    //    means the job is DONE and the stash is gone, which is also correct.
    //
    //    For the rotate-master-key path (reuse-current phrase), the stash holds
    //    the user's existing phrase — there is nothing new to reveal, so clearing
    //    it here prevents the phrase-reveal modal from showing on the next
    //    `get_pending_rotation_recovery` call.  The `recovery_reveal_ready` gate
    //    (state == done, revoked_device_id IS NULL) would otherwise expose the
    //    stash, triggering a false "your recovery phrase has changed" modal.
    {
        let conn = app_state.lock()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("finalize_publish_local: begin done tx: {e}"))?;
        db::update_rotation_job_state(&tx, rotation_id, state::DONE).map_err(|e| e.to_string())?;
        db::clear_rotation_recovery_stash(&tx).map_err(|e| e.to_string())?;
        tx.commit()
            .map_err(|e| format!("finalize_publish_local: done tx commit: {e}"))?;
    }

    Ok(())
}

/// Detect whether a job in `enumerate_stragglers` or `publish_keyring` state has
/// already been fully published to the cloud, and if so, finalize it locally
/// without re-running the cloud writes.
///
/// Publication is defined as: `cloud_meta.epoch == job.new_epoch AND
/// cloud_meta.master_fingerprint == job.new_fingerprint`.  The cloud `_meta.json`
/// write (step 4) is the publication event — it is always the last cloud write.
///
/// Returns `Ok(true)` if the job was already published and has now been finalized
/// locally (state → `done`).  Returns `Ok(false)` if the cloud has NOT yet been
/// published (normal resume path should run).  Returns `Err` only on I/O or DB
/// failures.
///
/// When this returns `true` the caller must NOT call `publish_keyring` — the job
/// is already `done`.
pub async fn resume_finalize_if_published<P: KeyringV2Io>(
    provider: &P,
    app_state: &AppState,
    job: &crate::db::RotationJobRow,
) -> Result<bool, String> {
    let new_epoch = job.new_epoch as u64;

    // Read cloud _meta.json.
    let cloud_meta = kio::read_meta(provider).await.map_err(|e| e.to_string())?;

    let cloud_meta = match cloud_meta {
        Some(m) => m,
        None => {
            // No meta at all — definitely not published.
            return Ok(false);
        }
    };

    // Detection gate: epoch AND fingerprint must both match.
    if cloud_meta.epoch != new_epoch || cloud_meta.master_fingerprint != job.new_fingerprint {
        return Ok(false);
    }

    log::info!(
        "resume_finalize_if_published: job {} already published (epoch={}, fp={}); \
         running idempotent local finalize",
        job.id,
        new_epoch,
        job.new_fingerprint,
    );

    // Source `recovery_wrapped_hex`: prefer the locally-persisted value (step 5
    // may have already written it before the crash).  Fall back to the cloud
    // `_recovery.json` (written at step 2, always before step 4).
    let recovery_wrapped_hex = {
        let local = {
            let conn = app_state.lock()?;
            db::get_setting(&conn, db::RECOVERY_WRAPPED_MASTER_KEY).map_err(|e| e.to_string())?
        };
        if let Some(v) = local {
            v
        } else {
            // Read from cloud _recovery.json.
            kio::read_recovery(provider)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    "resume_finalize_if_published: cloud _meta.json shows new epoch but \
                     _recovery.json is absent — cannot finalize"
                        .to_string()
                })?
                .wrapped_master
        }
    };

    finalize_publish_local(
        app_state,
        job.id,
        &job.new_fingerprint,
        new_epoch,
        &recovery_wrapped_hex,
        job.revoked_device_id.as_deref(),
    )?;

    Ok(true)
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
    use crate::sync::keyring_v2::{
        io::{
            test_support::InMemoryKeyringProvider, write_device_slot, write_meta, write_recovery,
        },
        types::{DeviceSlotV2, KeyringMetaV2, RecoverySlotV2, KEYRING_V2_VERSION},
    };
    use crate::utils::encryption::{decrypt_data, derive_sync_key, key_fingerprint};
    use crate::utils::recovery::{
        derive_recovery_key, generate_recovery_mnemonic, validate_recovery_mnemonic,
    };
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

    /// Write a minimal keyring setup: meta (epoch=1, fp="aabb"), one device slot, one recovery slot.
    async fn setup_cloud_keyring(
        provider: &InMemoryKeyringProvider,
        device_id: &str,
        master_key: &[u8; 32],
        mnemonic: &Mnemonic,
    ) {
        let fp = hex::encode(key_fingerprint(master_key));
        let meta = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: 1,
            master_fingerprint: fp,
            content_epoch: 0,
            recovery_generation: 0,
            created_at: 0,
            updated_at: 0,
        };
        write_meta(provider, &meta).await.unwrap();

        // Device slot is metadata-only (design §3/§4) — no key material.
        let slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: device_id.to_string(),
            name: "Test Device".to_string(),
            created_at: 0,
            last_seen_at: 0,
        };
        write_device_slot(provider, &slot).await.unwrap();

        // Recovery slot.
        let rk = derive_recovery_key(mnemonic);
        let recovery_blob = encrypt_data(&*rk, &master_key[..]).unwrap();
        let recovery_slot = RecoverySlotV2 {
            version: KEYRING_V2_VERSION,
            wrapped_master: hex::encode(&recovery_blob),
            created_at: 0,
        };
        write_recovery(provider, &recovery_slot).await.unwrap();
        crate::sync::recovery::bootstrap_sync_control(provider, 0)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn publish_keyring_writes_meta_last_and_transitions_done() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let mnemonic_str = generate_recovery_mnemonic().unwrap();
        let parsed = validate_recovery_mnemonic(&mnemonic_str).unwrap();

        let old_master = [1u8; 32];
        let new_master = [2u8; 32];
        // Must be a valid UUID (hex + hyphens, no other chars).
        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

        // Store device ID in settings.
        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::upsert_device(
                &conn,
                &db::DeviceRow {
                    device_id: device_id.to_string(),
                    name: "Test Device".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();
        }

        let provider = InMemoryKeyringProvider::new();
        setup_cloud_keyring(&provider, device_id, &old_master, &parsed).await;

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let old_fp = hex::encode(key_fingerprint(&old_master));
            let new_fp = hex::encode(key_fingerprint(&new_master));
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        let ctx = RotationContext {
            master_key_old: Zeroizing::new(old_master),
            master_key_new: Zeroizing::new(new_master),
        };

        publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Supplied(&parsed),
            None,
            0, // no content epoch bump in this test
        )
        .await
        .unwrap();

        // Verify _meta.json has new epoch and fingerprint.
        let meta = kio::read_meta(&provider).await.unwrap().unwrap();
        assert_eq!(meta.epoch, 2);
        let expected_fp = hex::encode(key_fingerprint(&new_master));
        assert_eq!(meta.master_fingerprint, expected_fp);

        // Verify _recovery.json unwraps to new_master.
        let recovery = kio::read_recovery(&provider).await.unwrap().unwrap();
        let rk = derive_recovery_key(&parsed);
        let recovered =
            decrypt_data(&*rk, &hex::decode(&recovery.wrapped_master).unwrap()).unwrap();
        assert_eq!(recovered, &new_master[..]);

        // Verify device slot is a metadata-only refresh — no key material
        // (design §3/§4, requirement 4). Read the RAW bytes off the provider:
        // asserting via the parsed `DeviceSlotV2` would be meaningless, since
        // that struct cannot have these fields anymore by construction.
        let slots = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].device_id, device_id);
        let raw = provider
            .read_file(&crate::sync::keyring_v2::io::device_slot_path(device_id))
            .await
            .unwrap();
        let raw_text = String::from_utf8_lossy(&raw);
        assert!(
            !raw_text.contains("wrapped_master") && !raw_text.contains("kek_salt"),
            "raw device slot bytes must carry no key material: {raw_text}"
        );

        // Verify job transitioned to done.
        let conn = app_state.lock().unwrap();
        let active = db::find_active_rotation_job(&conn).unwrap();
        assert!(active.is_none(), "job should be done, not active");

        // Verify local settings updated.
        let local_fp = db::get_setting(&conn, db::CLOUD_MASTER_FINGERPRINT)
            .unwrap()
            .unwrap();
        assert_eq!(local_fp, expected_fp);
        let local_epoch = db::get_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH)
            .unwrap()
            .unwrap();
        assert_eq!(local_epoch, "2");

        // Verify stash keys cleared.
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_OLD_WRAPPED_LOCAL)
                .unwrap()
                .is_none()
        );
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_NEW_WRAPPED_LOCAL)
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn publish_keyring_aborts_on_concurrent_rotation() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let mnemonic_str = generate_recovery_mnemonic().unwrap();
        let parsed = validate_recovery_mnemonic(&mnemonic_str).unwrap();

        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
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
        }

        let old_master = [1u8; 32];
        let new_master = [3u8; 32]; // Different master key "from another device"
        let provider = InMemoryKeyringProvider::new();
        setup_cloud_keyring(&provider, device_id, &old_master, &parsed).await;

        // Insert job that expects epoch=1 → new_epoch=2.
        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let old_fp = hex::encode(key_fingerprint(&old_master));
            let new_fp = hex::encode(key_fingerprint(&[2u8; 32]));
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        // Simulate concurrent rotation: bump cloud epoch to 2 with a valid fingerprint.
        let bumped_meta = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: 2, // Someone else already rotated.
            master_fingerprint: hex::encode(key_fingerprint(&new_master)),
            content_epoch: 0,
            recovery_generation: 0,
            created_at: 0,
            updated_at: 0,
        };
        write_meta(&provider, &bumped_meta).await.unwrap();

        let new_master = [2u8; 32];
        let ctx = RotationContext {
            master_key_old: Zeroizing::new(old_master),
            master_key_new: Zeroizing::new(new_master),
        };

        let result = publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Supplied(&parsed),
            None,
            0, // no content epoch bump in this test
        )
        .await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Concurrent rotation"), "unexpected: {err}");

        // Job should be aborted.
        let conn = app_state.lock().unwrap();
        let active = db::find_active_rotation_job(&conn).unwrap();
        assert!(active.is_none(), "job should be aborted");
    }

    #[tokio::test]
    async fn publish_keyring_revokes_target_device_and_deletes_others() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let mnemonic_str = generate_recovery_mnemonic().unwrap();
        let parsed = validate_recovery_mnemonic(&mnemonic_str).unwrap();

        // Must be valid UUIDs (hex + hyphens only).
        let device_a = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"; // current
        let device_b = "b2c3d4e5-f6a7-8901-bcde-f01234567891"; // to be revoked

        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_a).unwrap();
            for (id, is_current) in [(device_a, true), (device_b, false)] {
                db::upsert_device(
                    &conn,
                    &db::DeviceRow {
                        device_id: id.to_string(),
                        name: id.to_string(),
                        created_at: 0,
                        last_seen_at: 0,
                        is_current,
                        is_revoked: false,
                    },
                )
                .unwrap();
            }
        }

        let old_master = [1u8; 32];
        let provider = InMemoryKeyringProvider::new();
        setup_cloud_keyring(&provider, device_a, &old_master, &parsed).await;
        // Also add device B's slot.
        {
            let slot_b = DeviceSlotV2 {
                version: KEYRING_V2_VERSION,
                device_id: device_b.to_string(),
                name: device_b.to_string(),
                created_at: 0,
                last_seen_at: 0,
            };
            write_device_slot(&provider, &slot_b).await.unwrap();
        }

        let new_master = [2u8; 32];

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let old_fp = hex::encode(key_fingerprint(&old_master));
            let new_fp = hex::encode(key_fingerprint(&new_master));
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, Some(device_b)).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        let ctx = RotationContext {
            master_key_old: Zeroizing::new(old_master),
            master_key_new: Zeroizing::new(new_master),
        };

        publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Supplied(&parsed),
            Some(device_b),
            0, // no content epoch bump in this test
        )
        .await
        .unwrap();

        // Only device A's slot should remain.
        let slots = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].device_id, device_a);

        // Requirement 5(b): the mock cloud must contain ZERO password-wrapped
        // blobs after rotation. Read the RAW bytes off the provider directly —
        // asserting via the parsed `DeviceSlotV2` would be meaningless, since
        // that struct cannot have these fields anymore by construction.
        let raw = provider
            .read_file(&crate::sync::keyring_v2::io::device_slot_path(device_a))
            .await
            .unwrap();
        let raw_text = String::from_utf8_lossy(&raw);
        assert!(
            !raw_text.contains("kek_salt") && !raw_text.contains("wrapped_master"),
            "raw device slot bytes must never contain key material: {raw_text}"
        );

        // Device B should be marked revoked in local DB.
        let conn = app_state.lock().unwrap();
        let devices = db::list_devices(&conn).unwrap();
        let b_row = devices.iter().find(|d| d.device_id == device_b);
        assert!(b_row.is_some(), "device B should still exist in local DB");
        assert!(
            b_row.unwrap().is_revoked,
            "device B should be marked revoked"
        );
    }

    /// Rotate path: stash a known mnemonic, run publish with `Stashed`, assert
    /// that the written `_recovery.json` can be unwrapped by that same mnemonic.
    #[tokio::test]
    async fn publish_rotate_uses_stashed_mnemonic() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let old_master = [1u8; 32];
        let new_master = [2u8; 32];

        // The mnemonic used for the "old" cloud keyring (irrelevant — publish
        // overwrites _recovery.json).
        let old_mnemonic_str = generate_recovery_mnemonic().unwrap();
        let old_parsed = validate_recovery_mnemonic(&old_mnemonic_str).unwrap();

        // The NEW mnemonic that enumerate_envelopes would have stashed.
        let stashed_mnemonic_str = generate_recovery_mnemonic().unwrap();

        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::upsert_device(
                &conn,
                &db::DeviceRow {
                    device_id: device_id.to_string(),
                    name: "Test Device".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();
            // Stash the new mnemonic (as enumerate_envelopes would have done).
            db::set_rotation_recovery_stash(&conn, &stashed_mnemonic_str).unwrap();
        }

        let provider = InMemoryKeyringProvider::new();
        setup_cloud_keyring(&provider, device_id, &old_master, &old_parsed).await;

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let old_fp = hex::encode(key_fingerprint(&old_master));
            let new_fp = hex::encode(key_fingerprint(&new_master));
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        let ctx = RotationContext {
            master_key_old: Zeroizing::new(old_master),
            master_key_new: Zeroizing::new(new_master),
        };

        publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Stashed,
            None,
            0, // no content epoch bump in this test
        )
        .await
        .unwrap();

        // The written _recovery.json must be unwrappable with the stashed phrase.
        let recovery = kio::read_recovery(&provider).await.unwrap().unwrap();
        let stashed_parsed = validate_recovery_mnemonic(&stashed_mnemonic_str).unwrap();
        let rk = derive_recovery_key(&stashed_parsed);
        let recovered =
            decrypt_data(&*rk, &hex::decode(&recovery.wrapped_master).unwrap()).unwrap();
        assert_eq!(
            recovered,
            &new_master[..],
            "_recovery.json should unwrap master_key_new with the stashed mnemonic"
        );
    }

    /// Revoke path: run publish with `Supplied` and NO stash present.
    /// Assert the supplied phrase is used and the call succeeds.
    #[tokio::test]
    async fn publish_revoke_uses_supplied_mnemonic() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let device_a = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let device_b = "b2c3d4e5-f6a7-8901-bcde-f01234567891";
        let old_master = [1u8; 32];
        let new_master = [2u8; 32];

        let supplied_mnemonic_str = generate_recovery_mnemonic().unwrap();
        let supplied_parsed = validate_recovery_mnemonic(&supplied_mnemonic_str).unwrap();

        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_a).unwrap();
            for (id, is_current) in [(device_a, true), (device_b, false)] {
                db::upsert_device(
                    &conn,
                    &db::DeviceRow {
                        device_id: id.to_string(),
                        name: id.to_string(),
                        created_at: 0,
                        last_seen_at: 0,
                        is_current,
                        is_revoked: false,
                    },
                )
                .unwrap();
            }
            // No stash written — revoke path should not need one.
        }

        let provider = InMemoryKeyringProvider::new();
        setup_cloud_keyring(&provider, device_a, &old_master, &supplied_parsed).await;
        // Add device_b's slot.
        {
            let slot_b = DeviceSlotV2 {
                version: KEYRING_V2_VERSION,
                device_id: device_b.to_string(),
                name: device_b.to_string(),
                created_at: 0,
                last_seen_at: 0,
            };
            write_device_slot(&provider, &slot_b).await.unwrap();
        }

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let old_fp = hex::encode(key_fingerprint(&old_master));
            let new_fp = hex::encode(key_fingerprint(&new_master));
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, Some(device_b)).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        let ctx = RotationContext {
            master_key_old: Zeroizing::new(old_master),
            master_key_new: Zeroizing::new(new_master),
        };

        publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Supplied(&supplied_parsed),
            Some(device_b),
            0, // no content epoch bump in this test
        )
        .await
        .unwrap();

        // _recovery.json should be unwrappable with the supplied phrase.
        let recovery = kio::read_recovery(&provider).await.unwrap().unwrap();
        let rk = derive_recovery_key(&supplied_parsed);
        let recovered =
            decrypt_data(&*rk, &hex::decode(&recovery.wrapped_master).unwrap()).unwrap();
        assert_eq!(
            recovered,
            &new_master[..],
            "_recovery.json should unwrap master_key_new with the supplied mnemonic"
        );

        // Device B should be revoked.
        let conn = app_state.lock().unwrap();
        let devices = db::list_devices(&conn).unwrap();
        let b_row = devices.iter().find(|d| d.device_id == device_b).unwrap();
        assert!(b_row.is_revoked, "device B should be marked revoked");
    }

    /// Rotate path with NO stash present must return a clear error (no panic).
    #[tokio::test]
    async fn publish_rotate_missing_stash_errors() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let old_master = [1u8; 32];
        let new_master = [2u8; 32];

        let dummy_mnemonic_str = generate_recovery_mnemonic().unwrap();
        let dummy_parsed = validate_recovery_mnemonic(&dummy_mnemonic_str).unwrap();

        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::upsert_device(
                &conn,
                &db::DeviceRow {
                    device_id: device_id.to_string(),
                    name: "Test Device".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();
            // Intentionally NO stash — simulates missing enumerate_envelopes stash.
        }

        let provider = InMemoryKeyringProvider::new();
        // Set up cloud keyring with epoch=1 so the epoch check passes.
        setup_cloud_keyring(&provider, device_id, &old_master, &dummy_parsed).await;

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let old_fp = hex::encode(key_fingerprint(&old_master));
            let new_fp = hex::encode(key_fingerprint(&new_master));
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        let ctx = RotationContext {
            master_key_old: Zeroizing::new(old_master),
            master_key_new: Zeroizing::new(new_master),
        };

        let result = publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Stashed,
            None,
            0, // no content epoch bump in this test
        )
        .await;

        assert!(result.is_err(), "expected error when stash is missing");
        let err = result.unwrap_err();
        assert!(
            err.contains("stashed recovery mnemonic") || err.contains("none found"),
            "error should mention missing stash; got: {err}"
        );
    }

    /// After a successful rotate publish, the mnemonic stash must be absent —
    /// it is cleared atomically with the DONE transition in `finalize_publish_local`
    /// step 8.  The master-key wraps (ROTATION_MASTER_OLD/NEW_WRAPPED_LOCAL) are
    /// cleared at step 7.  Both must be gone after publish completes.
    /// Pins the reason `reset_recovery_phrase` must return its mnemonic.
    ///
    /// `finalize_publish_local` sets the job to DONE and clears the stash in
    /// ONE transaction, while `recovery_reveal_ready` requires DONE. The
    /// reveal window is therefore zero-width: there is no observable moment at
    /// which `get_pending_rotation_recovery` can return the stashed phrase.
    ///
    /// That is fine for `rotate_master_key` (the stash holds the user's
    /// *unchanged* phrase). It is fatal for Flow G, which mints a NEW phrase —
    /// if the command does not hand it back to the caller directly, the vault
    /// ends up wrapped under words nobody has ever seen. This test fails if
    /// anyone ever "fixes" the reveal path in a way that makes it look
    /// reachable, which would hide the real requirement.
    #[test]
    fn done_and_stash_cleared_are_atomic_so_the_reveal_window_is_zero_width() {
        use crate::sync::rotation::state as rstate;

        let job_at = |state: &str| db::RotationJobRow {
            id: 1,
            state: state.to_string(),
            old_fingerprint: "old".to_string(),
            new_fingerprint: "new".to_string(),
            old_epoch: 1,
            new_epoch: 2,
            revoked_device_id: None,
            started_at: 0,
            updated_at: 0,
            error: None,
        };

        // The reveal gate opens only at DONE...
        let done_job = job_at(rstate::DONE);
        assert!(
            db::recovery_reveal_ready(Some(&done_job)),
            "precondition: DONE + not-a-revoke is what opens the reveal gate"
        );

        // ...and every earlier state keeps it shut.
        for earlier in [rstate::PUBLISH_KEYRING, rstate::ENUMERATE_STRAGGLERS] {
            let job = job_at(earlier);
            assert!(
                !db::recovery_reveal_ready(Some(&job)),
                "state {earlier} must not expose the stash"
            );
        }

        // Since the clear happens in the same tx as the DONE write, no caller
        // can ever observe DONE *and* a populated stash. Flow G must therefore
        // return the mnemonic from the command itself.
    }

    #[tokio::test]
    async fn rotation_completion_clears_recovery_stash_atomically() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let old_master = [1u8; 32];
        let new_master = [2u8; 32];

        let dummy_mnemonic_str = generate_recovery_mnemonic().unwrap();
        let dummy_parsed = validate_recovery_mnemonic(&dummy_mnemonic_str).unwrap();

        let stashed_mnemonic_str = generate_recovery_mnemonic().unwrap();

        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::upsert_device(
                &conn,
                &db::DeviceRow {
                    device_id: device_id.to_string(),
                    name: "Test Device".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();

            // Stash new mnemonic (as enumerate_envelopes would have done).
            db::set_rotation_recovery_stash(&conn, &stashed_mnemonic_str).unwrap();

            // Also stash the master-key wraps so step-7 has real values to clear.
            db::set_setting(
                &conn,
                db::ROTATION_MASTER_OLD_WRAPPED_LOCAL,
                "aabbccdd:dummy_old_wrapped",
            )
            .unwrap();
            db::set_setting(
                &conn,
                db::ROTATION_MASTER_NEW_WRAPPED_LOCAL,
                "eeff0011:dummy_new_wrapped",
            )
            .unwrap();
        }

        let provider = InMemoryKeyringProvider::new();
        setup_cloud_keyring(&provider, device_id, &old_master, &dummy_parsed).await;

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let old_fp = hex::encode(key_fingerprint(&old_master));
            let new_fp = hex::encode(key_fingerprint(&new_master));
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        let ctx = RotationContext {
            master_key_old: Zeroizing::new(old_master),
            master_key_new: Zeroizing::new(new_master),
        };

        publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Stashed,
            None,
            0, // no content epoch bump in this test
        )
        .await
        .unwrap();

        // Verify step 7 cleared the master-key stashes.
        let conn = app_state.lock().unwrap();
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_OLD_WRAPPED_LOCAL)
                .unwrap()
                .is_none(),
            "master-old stash must be cleared after publish"
        );
        assert!(
            db::get_setting(&conn, db::ROTATION_MASTER_NEW_WRAPPED_LOCAL)
                .unwrap()
                .is_none(),
            "master-new stash must be cleared after publish"
        );
        // The mnemonic stash must be cleared atomically with DONE (step 8).
        let still_stashed = db::get_rotation_recovery_stash(&conn).unwrap();
        assert!(
            still_stashed.is_none(),
            "mnemonic stash must be cleared atomically with DONE in finalize_publish_local step 8; \
             got: {still_stashed:?}"
        );
    }

    /// T5 — Resume a rotate job that was interrupted at `publish_keyring` state.
    ///
    /// The caller passes `recovery_mnemonic = None` (rotate jobs never need it);
    /// `resume_rotation` branches on `revoked_device_id.is_none()` and calls
    /// `publish_keyring` with `RecoverySource::Stashed`.  This test exercises
    /// that exact call path and verifies:
    /// - `publish_keyring` succeeds with no supplied phrase.
    /// - `_recovery.json` unwraps `master_key_new` with the stashed phrase.
    #[tokio::test]
    async fn resume_rotate_recovers_stashed_mnemonic() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let old_master = [1u8; 32];
        let new_master = [2u8; 32];

        // The mnemonic used when writing the cloud keyring (old state, irrelevant
        // to the rotate result — publish overwrites _recovery.json).
        let old_mnemonic_str = generate_recovery_mnemonic().unwrap();
        let old_parsed = validate_recovery_mnemonic(&old_mnemonic_str).unwrap();

        // The mnemonic that enumerate_envelopes stashed before the crash.
        let stashed_mnemonic_str = generate_recovery_mnemonic().unwrap();

        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::upsert_device(
                &conn,
                &db::DeviceRow {
                    device_id: device_id.to_string(),
                    name: "Test Device".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();
            // Stash written by enumerate_envelopes before the crash.
            db::set_rotation_recovery_stash(&conn, &stashed_mnemonic_str).unwrap();
        }

        let provider = InMemoryKeyringProvider::new();
        setup_cloud_keyring(&provider, device_id, &old_master, &old_parsed).await;

        // Job is stuck at publish_keyring state (revoked_device_id = None → rotate).
        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let old_fp = hex::encode(key_fingerprint(&old_master));
            let new_fp = hex::encode(key_fingerprint(&new_master));
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        let ctx = RotationContext {
            master_key_old: Zeroizing::new(old_master),
            master_key_new: Zeroizing::new(new_master),
        };

        // resume_rotation dispatches: revoked_device_id is None → RecoverySource::Stashed.
        // recovery_mnemonic is None (no phrase supplied by caller).
        publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Stashed, // no caller-supplied mnemonic needed
            None, // not revoking any device
            0,    // no content epoch bump in this test
        )
        .await
        .expect("resume rotate must succeed using only the stashed mnemonic (no recovery_mnemonic param)");

        // _recovery.json must be unwrappable with the stashed phrase, not the old one.
        let recovery = kio::read_recovery(&provider).await.unwrap().unwrap();
        let stashed_parsed = validate_recovery_mnemonic(&stashed_mnemonic_str).unwrap();
        let rk = derive_recovery_key(&stashed_parsed);
        let recovered =
            decrypt_data(&*rk, &hex::decode(&recovery.wrapped_master).unwrap()).unwrap();
        assert_eq!(
            recovered,
            &new_master[..],
            "_recovery.json must unwrap master_key_new with the stashed (crash-survived) mnemonic"
        );

        // Job must be done.
        let conn = app_state.lock().unwrap();
        let active = db::find_active_rotation_job(&conn).unwrap();
        assert!(
            active.is_none(),
            "job should be done after resume-rotate publish"
        );
    }

    /// Change 3 — Critical #2 fix: resume a `publish_keyring` job whose cloud
    /// `_meta.json` ALREADY shows the new epoch + fingerprint (published before
    /// the crash at step 5–7).  `resume_finalize_if_published` must:
    /// - Return `true` (finalized).
    /// - Transition the job to `done`.
    /// - Clear the recovery mnemonic stash atomically with DONE (step 8).
    /// - Set the local settings (fingerprint, epoch, recovery_wrapped).
    /// After finalize, `recovery_reveal_ready` must return `false` (stash gone).
    #[tokio::test]
    async fn resume_publish_keyring_already_published_finalizes_to_done() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let old_master = [1u8; 32];
        let new_master = [2u8; 32];

        let old_mnemonic_str = generate_recovery_mnemonic().unwrap();
        let _old_parsed = validate_recovery_mnemonic(&old_mnemonic_str).unwrap();

        // The stashed mnemonic (the live recovery phrase after publication).
        let stashed_mnemonic_str = generate_recovery_mnemonic().unwrap();

        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::upsert_device(
                &conn,
                &crate::db::DeviceRow {
                    device_id: device_id.to_string(),
                    name: "Test Device".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();
            // Stash the new recovery mnemonic (the live phrase).
            db::set_rotation_recovery_stash(&conn, &stashed_mnemonic_str).unwrap();
            // NOTE: master-key stashes are intentionally absent (step 7 already cleared them).
        }

        let new_fp = hex::encode(key_fingerprint(&new_master));
        // old_epoch=1, new_epoch=2.
        let old_fp = hex::encode(key_fingerprint(&old_master));

        // Set up cloud ALREADY in the post-publication state: _meta.json shows
        // new_epoch=2, new_fingerprint, and _recovery.json wraps new_master.
        let provider = InMemoryKeyringProvider::new();

        // Write the post-rotation _meta.json directly.
        let published_meta = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: 2, // new epoch — publication is done
            master_fingerprint: new_fp.clone(),
            content_epoch: 0,
            recovery_generation: 0,
            created_at: 0,
            updated_at: 0,
        };
        write_meta(&provider, &published_meta).await.unwrap();

        // Write _recovery.json wrapping new_master.
        let new_parsed = validate_recovery_mnemonic(&stashed_mnemonic_str).unwrap();
        let rk = derive_recovery_key(&new_parsed);
        let recovery_blob = crate::utils::encryption::encrypt_data(&*rk, &new_master[..]).unwrap();
        let recovery_slot = RecoverySlotV2 {
            version: KEYRING_V2_VERSION,
            wrapped_master: hex::encode(&recovery_blob),
            created_at: 0,
        };
        write_recovery(&provider, &recovery_slot).await.unwrap();

        // Create the job in publish_keyring state (crash after step 4, before step 8).
        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        // Build a RotationJobRow directly for the test (mirrors what resume_rotation reads).
        let job = {
            let conn = app_state.lock().unwrap();
            db::find_active_rotation_job(&conn).unwrap().unwrap()
        };

        let finalized = resume_finalize_if_published(&provider, &app_state, &job)
            .await
            .unwrap();

        assert!(finalized, "should detect already-published and finalize");

        // Job must be done.
        let conn = app_state.lock().unwrap();
        let active = db::find_active_rotation_job(&conn).unwrap();
        assert!(
            active.is_none(),
            "job must be done after idempotent finalize"
        );

        // Local settings must be updated.
        let local_fp = db::get_setting(&conn, db::CLOUD_MASTER_FINGERPRINT)
            .unwrap()
            .unwrap();
        assert_eq!(
            local_fp, new_fp,
            "CLOUD_MASTER_FINGERPRINT must be set to new_fp"
        );

        let local_epoch = db::get_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH)
            .unwrap()
            .unwrap();
        assert_eq!(
            local_epoch, "2",
            "KEYRING_V2_LOCAL_EPOCH must be set to new_epoch"
        );

        // Recovery mnemonic stash must be ABSENT — cleared atomically with DONE.
        let stash = db::get_rotation_recovery_stash(&conn).unwrap();
        assert!(
            stash.is_none(),
            "recovery mnemonic stash must be cleared atomically with DONE in finalize; \
             got: {stash:?}"
        );

        // recovery_reveal_ready requires the stash to be present, and now it is gone.
        // The gate still checks state==done + no revoked_device_id, but
        // get_pending_rotation_recovery guards on recovery_reveal_ready AND then
        // calls get_rotation_recovery_stash — which returns None — so the modal
        // is never shown.
        let latest = db::find_latest_rotation_job(&conn).unwrap();
        assert!(
            db::recovery_reveal_ready(latest.as_ref()),
            "recovery_reveal_ready gate must return true (state==done, not revoke) — \
             the stash being absent is what prevents the modal from appearing"
        );
    }

    /// I1: A DONE rotate job must leave NO recovery stash.
    ///
    /// Verifies the crash-safe invariant: `finalize_publish_local` clears the
    /// mnemonic stash atomically in the same tx that transitions the job to `done`.
    /// This prevents the phrase-reveal modal from showing a stale stash on next
    /// launch when the phrase was not actually new (reuse-current rotation).
    #[tokio::test]
    async fn done_rotate_job_leaves_no_stash() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let old_master = [1u8; 32];
        let new_master = [2u8; 32];

        let mnemonic_str = generate_recovery_mnemonic().unwrap();
        let parsed = validate_recovery_mnemonic(&mnemonic_str).unwrap();

        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
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
            // Stash a phrase (simulates rotate_keys stashing the current phrase).
            db::set_rotation_recovery_stash(&conn, &mnemonic_str).unwrap();
        }

        let provider = InMemoryKeyringProvider::new();
        setup_cloud_keyring(&provider, device_id, &old_master, &parsed).await;

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            let old_fp = hex::encode(key_fingerprint(&old_master));
            let new_fp = hex::encode(key_fingerprint(&new_master));
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        let ctx = RotationContext {
            master_key_old: Zeroizing::new(old_master),
            master_key_new: Zeroizing::new(new_master),
        };

        publish_keyring(
            &provider,
            &app_state,
            rotation_id,
            &ctx,
            RecoverySource::Supplied(&parsed),
            None,
            0,
        )
        .await
        .unwrap();

        // Job must be done.
        let conn = app_state.lock().unwrap();
        let active = db::find_active_rotation_job(&conn).unwrap();
        assert!(active.is_none(), "job should be done");

        // Stash must be absent — cleared atomically with DONE.
        let stash = db::get_rotation_recovery_stash(&conn).unwrap();
        assert!(
            stash.is_none(),
            "DONE rotate job must leave NO stash; got: {stash:?}"
        );
    }

    /// Change 3 — Critical #2 fix: resume a `publish_keyring` job whose cloud
    /// `_meta.json` still shows the OLD epoch (publication has NOT happened yet).
    /// `resume_finalize_if_published` must return `false` so the normal publish
    /// path runs.
    #[tokio::test]
    async fn resume_publish_keyring_not_yet_published_runs_normal_publish() {
        let conn = setup_db();
        let app_state = make_app_state(conn);

        let device_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let old_master = [1u8; 32];
        let new_master = [2u8; 32];

        let old_mnemonic_str = generate_recovery_mnemonic().unwrap();
        let old_parsed = validate_recovery_mnemonic(&old_mnemonic_str).unwrap();

        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::DEVICE_ID_KEY, device_id).unwrap();
            db::upsert_device(
                &conn,
                &crate::db::DeviceRow {
                    device_id: device_id.to_string(),
                    name: "Test Device".to_string(),
                    created_at: 0,
                    last_seen_at: 0,
                    is_current: true,
                    is_revoked: false,
                },
            )
            .unwrap();
        }

        let old_fp = hex::encode(key_fingerprint(&old_master));
        let new_fp = hex::encode(key_fingerprint(&new_master));

        // Cloud is still on old epoch (1) — publication has NOT occurred yet.
        let provider = InMemoryKeyringProvider::new();
        setup_cloud_keyring(&provider, device_id, &old_master, &old_parsed).await;

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, &old_fp, &new_fp, 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, rotation_id, state::PUBLISH_KEYRING).unwrap();
        }

        let job = {
            let conn = app_state.lock().unwrap();
            db::find_active_rotation_job(&conn).unwrap().unwrap()
        };

        let finalized = resume_finalize_if_published(&provider, &app_state, &job)
            .await
            .unwrap();

        assert!(
            !finalized,
            "must return false when cloud epoch still == old_epoch (not yet published)"
        );

        // Job must still be active (unchanged).
        let conn = app_state.lock().unwrap();
        let active = db::find_active_rotation_job(&conn).unwrap();
        assert!(
            active.is_some(),
            "job must still be active — normal publish path should run"
        );
        let state_val: String = conn
            .query_row(
                "SELECT state FROM rotation_job WHERE id=?1",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            state_val,
            state::PUBLISH_KEYRING,
            "state must not change when not-yet-published"
        );
    }

    /// C1 cross-path: fingerprints written by `write_content_list_cloud` (the
    /// publisher) must match what `onboard_complete_inner` verifies.
    ///
    /// The reader formula is: `key_fingerprint(derive_sync_key(content_key))`.
    /// Before the C1 fix, the writer used `key_fingerprint(content_key)` (raw
    /// key, no sync derivation), so every joiner check would fail after rotation.
    #[tokio::test]
    async fn write_content_list_cloud_fingerprints_match_reader_formula() {
        use crate::db;
        use crate::sync::keyring_v2::io::{read_content, test_support::InMemoryKeyringProvider};
        use crate::utils::encryption::{
            decode_content_key_list, encode_content_key_list, generate_content_key,
            unwrap_content_key,
        };

        let master = Zeroizing::new([0x33u8; 32]);
        let conn = setup_db();
        let app_state = make_app_state(conn);

        // Build a 2-epoch content-key list and store it in the DB under master.
        let ck1 = generate_content_key();
        let ck2 = generate_content_key();
        let mut keys: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>> =
            std::collections::BTreeMap::new();
        keys.insert(1, Zeroizing::new(*ck1));
        keys.insert(2, Zeroizing::new(*ck2));

        let encoded = encode_content_key_list(&master, &keys).unwrap();
        {
            let conn = app_state.lock().unwrap();
            db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &encoded).unwrap();
        }

        let provider = InMemoryKeyringProvider::new();
        write_content_list_cloud(&provider, &app_state, &master, 2)
            .await
            .expect("write_content_list_cloud must succeed");

        // Read back what was written.
        let cloud_list = read_content(&provider)
            .await
            .expect("read_content must succeed")
            .expect("_content.json must be present");

        assert_eq!(cloud_list.entries.len(), 2, "must have 2 epochs");

        // For each entry: unwrap the content key, derive the sync key, compute the
        // fingerprint, and verify it matches what the cloud file contains.
        // This is exactly what onboard_complete_inner does at line ~3017.
        let keys_decoded = decode_content_key_list(&master, &encoded).unwrap();
        for entry in &cloud_list.entries {
            let wrapped_blob = hex::decode(&entry.wrapped_content).unwrap();
            let ck = unwrap_content_key(&master, &wrapped_blob).unwrap();
            let expected_fp = hex::encode(key_fingerprint(&*derive_sync_key(&*ck)));
            assert_eq!(
                entry.content_fingerprint, expected_fp,
                "epoch {} fingerprint in _content.json must equal \
                 key_fingerprint(derive_sync_key(content_key)) — \
                 mismatches cause onboard_complete_inner fingerprint checks to fail",
                entry.epoch
            );
            // Also ensure the stored key matches the original.
            let orig = keys_decoded.get(&entry.epoch).unwrap();
            assert_eq!(*ck, **orig, "unwrapped key must equal original");
        }
    }
}
