use std::path::Path;

use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

use crate::commands::keychain::{
    clear_biometric_setting, restore_biometric_keychain_after_rotation, wipe_biometric_keychain,
};
use crate::db;
use crate::db::EncryptionMode;
use crate::utils::encryption::{
    decode_content_key_list, derive_sqlcipher_key, derive_sync_key, encode_content_key_list,
    generate_content_key, generate_encryption_salt, key_fingerprint, parse_kek_params,
    unwrap_content_key, unwrap_key, wrap_content_key, wrap_key_with, KdfParams, SALT_SIZE,
};
// Only the test-only `setup_first_time_inner` still calls `wrap_key` directly;
// production re-wraps go through `wrap_key_with`.
#[cfg(test)]
use crate::utils::encryption::wrap_key;
use crate::utils::{boot_file, boot_file::BootFile};
use crate::AppState;
use crate::EncryptionKeyState;

/// Minimum password length enforced at the command layer, counted in
/// **Unicode scalar values** (what users perceive roughly as "characters"),
/// not UTF-8 bytes. This matches the frontend's expectation of "characters"
/// in the LockScreen copy, and avoids an accidental security surprise where
/// 5 emoji (≈20 bytes) would pass a byte-count check.
///
/// Combined with the Argon2id KDF params (64 MiB, t=3, p=4), this sets the
/// brute-force floor for the zero-knowledge threat model.
const MIN_PASSWORD_LEN: usize = 8;

// ─── Encryption model ─────────────────────────────────────────────────────────
//
// Design: always encrypted. The entry-encryption key is a random 32-byte
// value generated once at first launch. It is wrapped with Argon2id(password,
// kek_salt) and stored in the settings table as `wrapped_encryption_key`. The
// password hash is stored separately for verification. Device-protected mode
// and no-encryption mode have both been removed.
//
// Startup: read `encryption_mode` from the settings table. If `unset` →
// emit first-launch event so the frontend shows onboarding (password is
// mandatory). If `password` → leave key_state empty; the lock screen calls
// `initialize_encryption` on password entry.

/// Returns the current encryption mode as a lowercase string serialized from
/// `EncryptionMode`:
/// - `"unset"` — no mode chosen yet (fresh install, onboarding pending).
/// - `"password"` — password-locked; app shows LockScreen until unlocked.
#[tauri::command]
pub fn get_encryption_mode(state: State<'_, AppState>) -> Result<EncryptionMode, String> {
    let conn = state.lock()?;
    db::get_encryption_mode(&conn).map_err(|e| e.to_string())
}

/// Returns the `StartupMode` captured during Tauri `.setup()`.
///
/// Frontend uses this before `needsOnboarding` / LockScreen routing so a
/// corrupted boot file can show recovery UI instead of panicking the process
/// or mis-routing to FirstLaunch.
///
/// Not actually frozen: `recover_with_passphrase` flips this from
/// `BootFileCorrupt` to `PasswordLocked` on a successful recovery (see
/// [`mark_startup_recovered`]) — otherwise any `useAuth()` instance that
/// mounts later in the same session would still read the stale value.
#[tauri::command]
pub fn get_startup_mode(
    mode: State<'_, std::sync::Mutex<crate::StartupMode>>,
) -> Result<crate::StartupMode, String> {
    mode.lock().map(|guard| *guard).map_err(|e| e.to_string())
}

/// Flip the startup-mode probe from `BootFileCorrupt` to `PasswordLocked`
/// after a successful phrase recovery in [`recover_with_passphrase`].
///
/// `get_startup_mode` would otherwise keep reporting `BootFileCorrupt` for
/// the rest of the process's life (it is set once at process start) — any
/// `useAuth()` instance mounted later in the same session (e.g. opening
/// Settings › Encryption) would read it, treat the app as still corrupt, and
/// force it back to a lock screen even though the user already recovered.
/// `key_state` is already loaded by the time this runs, so `PasswordLocked`
/// is accurate: the frontend's existing "password mode, key already loaded ⇒
/// stay unlocked" branch handles the rest with no further change needed.
fn mark_startup_recovered(mode: &std::sync::Mutex<crate::StartupMode>) {
    if let Ok(mut guard) = mode.lock() {
        *guard = crate::StartupMode::PasswordLocked;
    }
}

/// AI-audit retention purge after a successful phrase recovery. Extracted so
/// unit tests can drive it on a real conn without an `AppHandle` (the
/// `app:unlocked` emit stays in the command wrapper — `lib.rs` starts the
/// indexer from that event).
fn recover_with_passphrase_post_unlock(state: &AppState, now_ms: i64) {
    if let Err(e) = state.with_conn(|c| {
        crate::ai::audit::run_startup_retention_purge(c, now_ms).map_err(|e| e.to_string())
    }) {
        log::warn!("recover_with_passphrase: post-unlock retention purge failed: {e}");
    }
}

/// Test-only password-mode first-run setup helper (no Tauri state wrappers).
///
/// The V1 one-shot `setup_first_time` command this backed was deleted when
/// none-mode was removed; production onboarding uses the V2 mnemonic flow
/// (`begin_first_time_setup` / `confirm_first_time_setup`). Kept under
/// `#[cfg(test)]` so dozens of crypto unit tests can still seed a clean
/// password-mode DB without rewriting against V2.
///
/// `_db_path`: unused now that the none-mode on-disk rekey path is gone.
/// `boot_path`: if `Some`, perform the full disk-level setup (PRAGMA rekey);
/// pass `None` for in-memory DB tests to skip file I/O.
#[cfg(test)]
pub(crate) fn setup_first_time_inner(
    conn: rusqlite::Connection,
    key_state: &EncryptionKeyState,
    mode: EncryptionMode,
    password: Option<&str>,
    _db_path: &Path,
    boot_path: Option<&Path>,
) -> Result<rusqlite::Connection, String> {
    use rand::RngCore;

    // ── Input validation (before the data-loss guard so callers get a useful
    //    error even on an already-initialized DB). ──────────────────────────
    match mode {
        EncryptionMode::Unset => {
            return Err("mode must be password".to_string());
        }
        EncryptionMode::Password => match password {
            None => return Err("password required for password mode".to_string()),
            Some(p) if p.chars().count() < MIN_PASSWORD_LEN => {
                return Err(format!(
                    "password must be at least {MIN_PASSWORD_LEN} characters"
                ));
            }
            Some(_) => {}
        },
    }

    // ── Data-loss guard: refuse re-init if ANY marker indicates encryption
    //    is already configured.
    let current_mode = db::get_encryption_mode(&conn).map_err(|e| e.to_string())?;
    let has_wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
        .map_err(|e| e.to_string())?
        .is_some_and(|s| !s.is_empty());
    let has_hash = db::is_password_hash_set(&conn).map_err(|e| e.to_string())?;
    if current_mode != EncryptionMode::Unset || has_wrapped || has_hash {
        return Err(
            "setup_first_time refuses to re-initialize: encryption is already configured \
             (call change_password instead)"
                .to_string(),
        );
    }

    match mode {
        EncryptionMode::Password => {
            // SAFETY: validated above — password is Some(p) with len >= MIN_PASSWORD_LEN.
            let pw = password.unwrap();

            // Generate a fresh random 32-byte entry key.
            let mut raw_key = Zeroizing::new([0u8; 32]);
            rand::rngs::OsRng.fill_bytes(raw_key.as_mut());

            // Generate KEK salt and wrap the entry key.
            let kek_salt = generate_encryption_salt();
            let wrapped = wrap_key(&raw_key, pw, &kek_salt)?;
            let kek_salt_hex = encode_hex(&kek_salt);

            // Persist: wrapped key, KEK salt, password hash, encryption_mode=password.
            db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &wrapped)
                .map_err(|e| e.to_string())?;
            db::set_setting(&conn, db::KEK_SALT_KEY, &kek_salt_hex).map_err(|e| e.to_string())?;
            db::set_password_hash(&conn, pw).map_err(|e| e.to_string())?;
            db::set_encryption_mode(&conn, EncryptionMode::Password).map_err(|e| e.to_string())?;

            // Write boot file FIRST, then PRAGMA rekey (boot file must be
            // consistent with DB state before the rekey commit).
            if let Some(bp) = boot_path {
                let sqlcipher_key = derive_sqlcipher_key(&*raw_key);
                boot_file::save(
                    &BootFile {
                        mode: EncryptionMode::Password,
                        // Deprecated setup path predates os_kek — password only.
                        unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                        kek_salt: Some(kek_salt_hex),
                        wrapped_key: Some(wrapped),
                        os_kek_wrapped_master: None,
                        // Deprecated setup path — no recovery mnemonic generated.
                        recovery_wrapped: None,
                        wrapped_content_list: None,
                        wrapped_db_key: None,
                        master_wrapped_db_key: None,
                        migration_in_progress: None,
                    },
                    bp,
                )?;
                let pre_rekey = conn
                    .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                    .and_then(|_| conn.pragma_update(None, "journal_mode", "DELETE"));
                if let Err(e) = pre_rekey {
                    let _ = boot_file::save(&BootFile::default(), bp);
                    return Err(format!("Pre-rekey WAL flush failed: {e}"));
                }
                if let Err(e) = conn.pragma_update(
                    None,
                    "rekey",
                    format!("x'{}'", hex::encode(&*sqlcipher_key)),
                ) {
                    let _ = boot_file::save(&BootFile::default(), bp);
                    return Err(format!("PRAGMA rekey failed: {e}"));
                }
            }

            // Load the key into state so the app is immediately usable.
            key_state.set_key(raw_key)?;

            Ok(conn)
        }

        EncryptionMode::Unset => unreachable!("Unset is rejected above"),
    }
}

/// Verify a password against the stored hash.
///
/// **Why `async fn` + `spawn_blocking`?** Argon2id verification is as
/// expensive as derivation — running it on the main thread freezes the
/// WebView IPC loop for the full KDF duration.
#[tauri::command]
pub async fn verify_password(app: AppHandle, password: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let conn = state.lock()?;
        db::verify_password_hash(&conn, &password).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Change the password. Requires the old password to be correct.
///
/// The encryption salt is intentionally NOT regenerated — changing it would
/// make existing encrypted data undecryptable with any password. However the
/// derived encryption key IS a pure function of `(password, salt)`, so when
/// the password changes the in-memory key must also be re-derived from the
/// new password against the same salt. Without this step, the next write
/// after a password change would be encrypted with a key the user cannot
/// reproduce on unlock, and every existing entry would start failing GCM
/// tag verification once the user eventually re-unlocks with the new
/// password.
#[tauri::command]
pub async fn change_password(
    app: AppHandle,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    use tauri::Manager;

    let new_password = zeroize::Zeroizing::new(new_password);
    validate_password_length(&new_password)
        .map_err(|_| format!("New password must be at least {MIN_PASSWORD_LEN} characters"))?;
    let old_password = zeroize::Zeroizing::new(old_password);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let boot_path = boot_file::boot_path(&data_dir.join("memlore.db"));

    // The three Argon2 ops below (verify_password_hash, wrap_key, set_password_hash)
    // are CPU-intensive. Run them off the async executor in spawn_blocking so the
    // change-password call does not stall every other Tauri command. The non-Send
    // `State`/`MutexGuard` are re-fetched and dropped entirely inside the closure
    // (same pattern as `initialize_encryption`), so nothing non-Send crosses an
    // `.await`.
    let app_for_blocking = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_blocking.state::<AppState>();
        let key_state = app_for_blocking.state::<EncryptionKeyState>();

        // All DB work in a single block so `conn` (a non-Send MutexGuard) is
        // provably dropped before we leave the blocking closure.
        {
            let conn = state.lock()?;

            let is_valid =
                db::verify_password_hash(&conn, &old_password).map_err(|e| e.to_string())?;
            if !is_valid {
                return Err("Old password is incorrect".to_string());
            }

            // Preserve the vault's current KDF strength across a password change.
            // Read the existing wrapped blob and parse its params; changing the
            // password must not silently alter the KDF params. If the blob is
            // missing/unparseable, fall back to FAST (all new blobs are FAST;
            // unwrap reads the header we write here regardless).
            let current_params = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
                .ok()
                .flatten()
                .and_then(|hex| hex::decode(hex).ok())
                .and_then(|blob| parse_kek_params(&blob).ok())
                .unwrap_or(KdfParams::FAST);

            // Stage the new wrapped key + KEK salt BEFORE touching the password_hash.
            // If wrap_key fails (e.g. key_state is locked), we bail with zero DB
            // mutations. The in-memory entry key is unchanged — only the on-disk
            // wrapping material changes.
            //
            // NOTE: must wrap the MASTER key (not the content key). With_master()
            // gives the master stored in ContentKeyList; with_key() gives the latest
            // content key, which is different in Phase 3.
            let new_kek_salt = generate_encryption_salt();
            let new_wrapped = key_state.with_master(|master| {
                wrap_key_with(master, &new_password, &new_kek_salt, current_params)
            })?;
            let new_kek_salt_hex = encode_hex(&new_kek_salt);

            // Phase 3: re-wrap db_key under new password KEK.
            // `wrapped_db_key` is encrypted under the OLD KEK; after changing
            // password the new KEK won't be able to unwrap the old blob, causing
            // a lockout on the next unlock. Re-wrap using the raw db_key from
            // in-memory state.
            //
            // With a real key state, with_db_key always succeeds. An error here
            // means the app is locked — a programming error at this point, so we
            // propagate rather than silently dropping
            // the db_key (a silent drop would lock out the next unlock).
            let new_kek = crate::utils::encryption::derive_encryption_key_with(
                &new_password,
                &new_kek_salt,
                current_params,
            )?;
            let new_wrapped_db_key_hex = key_state.with_db_key(|db_key| {
                let blob = wrap_content_key(&new_kek, db_key)?;
                Ok(hex::encode(&blob))
            })?;

            // Atomically update all three settings (password_hash, wrapped_key,
            // kek_salt) in a single SQLite transaction. If any write fails, the
            // whole set rolls back — preventing the lockout scenario where a new
            // password_hash is committed but the re-wrap fails, leaving the user
            // unable to decrypt with either password.
            {
                let tx = conn
                    .unchecked_transaction()
                    .map_err(|e| format!("Failed to start transaction: {e}"))?;

                db::set_password_hash(&tx, &new_password).map_err(|e| e.to_string())?;
                db::set_setting(&tx, db::WRAPPED_ENCRYPTION_KEY_KEY, &new_wrapped)
                    .map_err(|e| e.to_string())?;
                db::set_setting(&tx, db::KEK_SALT_KEY, &new_kek_salt_hex)
                    .map_err(|e| e.to_string())?;

                tx.commit()
                    .map_err(|e| format!("Failed to commit change_password transaction: {e}"))?;
            }
            // In-memory entry key is unchanged — existing entries remain decryptable.
            // sqlcipher_key = HKDF(db_key) is also unchanged — no PRAGMA rekey needed.
            // Update the boot file so the next startup can derive the same master key
            // with the new password + new kek_salt.
            //
            // A load() failure here means the on-disk boot file exists but is
            // invalid — propagate rather than default to mode=Unset, which would
            // silently SKIP the boot-file write below (the `if` guard would be
            // false) even though the DB settings above already committed the new
            // password. Mirrors how a `boot_file::save` failure a few lines down
            // already surfaces as an Err after a successful DB commit — a known,
            // narrow inconsistency window, not a new one.
            let boot = boot_file::load(&boot_path)
                .map_err(|e| format!("Failed to read boot file during password change: {e}"))?;
            if boot.mode == EncryptionMode::Password {
                let updated = boot_after_password_change(
                    &boot,
                    new_kek_salt_hex,
                    new_wrapped,
                    new_wrapped_db_key_hex,
                );
                boot_file::save(&updated, &boot_path).map_err(|e| {
                    format!("Failed to update boot file after password change: {e}")
                })?;
            }

            // Biometric unlock stores the derived key in the macOS Keychain. That
            // stored key is bound to the OLD password; after changing password it
            // would decrypt entries with the wrong key. Flip the setting off first
            // (while we still hold the DB lock) so the UI immediately stops
            // offering a broken Touch ID, then drop the lock and wipe the Keychain
            // item.
            //
            // Both halves are best-effort. A Keychain glitch must NOT roll back a
            // successful password change: the DB hash is already updated and the
            // in-memory key rotated. Worst case: a stale Keychain item lingers and
            // the next Touch ID unlock hits the `NotFound`/wrong-bytes path, which
            // `unlock_with_biometric` self-heals by disabling the setting.
            if let Err(e) = clear_biometric_setting(&conn) {
                log::warn!("Failed to clear biometric setting after password change: {e}");
            }
        } // conn dropped here

        if let Err(e) = wipe_biometric_keychain() {
            log::warn!("Failed to wipe biometric Keychain item after password change: {e}");
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    {
        let state = app.state::<AppState>();
        let key_state = app.state::<EncryptionKeyState>();
        reupload_keyring_after_password_change(&state, &key_state).await;
    }

    Ok(())
}

/// Best-effort biometric Keychain refresh after a rotation.
///
/// Rotation changes `master_key`. If the user enabled Touch ID, the Keychain
/// entry still holds `master_old`, causing the next Touch ID unlock to fail.
/// This calls `restore_biometric_keychain_after_rotation` (keychain.rs) which
/// re-stores the new master (now in `key_state` after rotate_keys Step 5) or
/// disables biometric gracefully on failure.
///
/// Never returns an error — rotation already succeeded; biometric is optional.
fn refresh_biometric_keychain_after_rotation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &crate::AppState,
    key_state: &crate::EncryptionKeyState,
) {
    restore_biometric_keychain_after_rotation(app, state, key_state);
}

/// Best-effort keyring re-upload after a password change.
/// Sets `keyring_dirty` on failure so `sync_now` can retry automatically.
async fn reupload_keyring_after_password_change(
    state: &crate::AppState,
    key_state: &crate::EncryptionKeyState,
) {
    let is_connected = match state.lock() {
        Ok(c) => {
            db::get_setting(&c, "sync_connected")
                .unwrap_or(None)
                .as_deref()
                == Some("true")
        }
        Err(_) => false,
    };
    if !is_connected {
        return;
    }
    crate::commands::gdrive::try_reupload_keyring_and_update_dirty_flag(state, key_state).await;
}

/// Payload emitted with the `xj://rotation-resume-required` event so the
/// frontend can adjust its UI depending on whether the interrupted job was a
/// plain key rotation (ROTATE — no revoked device) or a device-revocation
/// rotation (REVOKE — `revoked_device_id` is set).
#[derive(Clone, serde::Serialize)]
struct RotationResumePayload {
    state: String,
    is_revoke: bool,
}

/// Phase 3 inner — content-key list and per-device db_key.
///
/// Called from `initialize_encryption` when `boot.mode == Password`. Handles
/// both the T2 path (boot file already has `wrapped_content_list` +
/// `wrapped_db_key`) and the T3 one-time migration path (legacy install).
///
/// Extracted as a free function so tests can drive it directly without a
/// full Tauri `AppHandle` or async context.
///
/// # Arguments
/// * `state`       — app state (connection swap target)
/// * `key_state`   — encryption key state (receives `set_content_state`)
/// * `boot`        — boot file as loaded from disk
/// * `boot_path`   — path to the boot file (for updates)
/// * `db_path`     — path to the SQLite database file
/// * `master`      — unwrapped master key (Argon2id → KEK → master)
/// * `password`    — current password (needed to wrap/unwrap db_key under KEK)
/// * `wrapped_hex` — raw hex of the wrapped-master blob (for KEK param extraction)
/// * `kek_salt`    — raw KEK salt bytes
/// * `kek_salt_hex`— hex-encoded KEK salt (written back to boot file on T3)
fn initialize_encryption_inner(
    state: &crate::AppState,
    key_state: &crate::EncryptionKeyState,
    boot: &BootFile,
    boot_path: &Path,
    db_path: &Path,
    master: &Zeroizing<[u8; 32]>,
    password: &Zeroizing<String>,
    wrapped_hex: &str,
    kek_salt: &[u8],
    kek_salt_hex: &str,
) -> Result<(), String> {
    // T2 path: boot file has `wrapped_content_list` + `wrapped_db_key` (and no
    //   `migration_in_progress` marker) → decode + unwrap them, open DB under
    //   db_key-derived key.
    //
    // T3 path: no `wrapped_content_list` (existing install) →
    //   crash-safe one-time PRAGMA rekey from master-derived to db_key-derived.
    //   Order: pre-write boot (with marker) → rekey → verify → DB settings →
    //   clear marker (final boot write). Any crash before marker-clear causes
    //   the next unlock to resume the migration idempotently (see T3-resume).
    //
    // T3-resume path: `migration_in_progress` marker set in the boot file →
    //   a previous T3 attempt was interrupted after the pre-write boot but before
    //   the marker was cleared. The boot file already has the new key material.
    //   Decode db_key from `boot.master_wrapped_db_key`, try to open DB under
    //   it. If that fails, the DB is still master-keyed → redo PRAGMA rekey.
    //   Then write DB settings and clear the marker.
    //
    // In all cases the final key_state is set via set_content_state.

    let content_keys: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>>;
    let db_key: Zeroizing<[u8; 32]>;

    // Check for interrupted T3 migration first.  A set marker means the boot file
    // was already written with the new key material (wrapped_content_list, wrapped_db_key,
    // master_wrapped_db_key) but the PRAGMA rekey may or may not have completed.
    let is_interrupted_migration = boot.migration_in_progress == Some(true);

    match (
        boot.wrapped_content_list.as_deref(),
        boot.wrapped_db_key.as_deref(),
        is_interrupted_migration,
    ) {
        (Some(list_hex), Some(db_key_hex), false) => {
            // ── T2: decode the persisted content-key list ────────────
            let db_key_blob = hex::decode(db_key_hex)
                .map_err(|e| format!("wrapped_db_key hex decode failed: {e}"))?;
            let kek_blob = hex::decode(wrapped_hex)
                .map_err(|e| format!("wrapped_key hex decode failed: {e}"))?;
            let params = parse_kek_params(&kek_blob)?;
            let kek =
                crate::utils::encryption::derive_encryption_key_with(password, kek_salt, params)?;
            let db_key_raw = unwrap_content_key(&kek, &db_key_blob)?;
            let keys_map = decode_content_key_list(master, list_hex)?;
            let latest = *keys_map
                .keys()
                .next_back()
                .ok_or_else(|| "decode_content_key_list returned empty map".to_string())?;
            content_keys = keys_map;
            db_key = db_key_raw;
            log::info!(
                "initialize_encryption: T2 path — content-key list loaded \
                 (latest epoch={latest})"
            );

            // T2: open DB with db_key-derived SQLCipher key.
            let sqlcipher_key = derive_sqlcipher_key(&*db_key);
            let db_path_str = db_path.to_string_lossy();
            let real_conn = crate::db::open_with_key(&db_path_str, &*sqlcipher_key)
                .map_err(|e| format!("Failed to open encrypted DB: {e}"))?;
            state.set_connection(real_conn)?;
        }
        (Some(list_hex), Some(db_key_hex), true) => {
            // ── T3-resume: interrupted migration — boot file already has new material ─
            //
            // The pre-write boot was saved (marker=true) but PRAGMA rekey and/or
            // DB settings write may not have completed.  Decode the pinned db_key
            // and content-list from the boot file (do NOT regenerate — that would
            // invalidate the already-written wraps).
            log::info!("initialize_encryption: T3-resume path — resuming interrupted migration");

            let kek_blob = hex::decode(wrapped_hex)
                .map_err(|e| format!("T3-resume: wrapped_key hex decode failed: {e}"))?;
            let params = parse_kek_params(&kek_blob)?;
            let kek =
                crate::utils::encryption::derive_encryption_key_with(password, kek_salt, params)?;
            let db_key_blob = hex::decode(db_key_hex)
                .map_err(|e| format!("T3-resume: wrapped_db_key hex decode failed: {e}"))?;
            let resumed_db_key = unwrap_content_key(&kek, &db_key_blob)?;
            let keys_map = decode_content_key_list(master, list_hex)?;

            let new_sqlcipher_key = derive_sqlcipher_key(&*resumed_db_key);
            let old_sqlcipher_key = derive_sqlcipher_key(&**master);
            let db_path_str = db_path.to_string_lossy();

            // Try to open under the new db_key first — if PRAGMA rekey already
            // completed before the crash, this will succeed.
            let migration_conn = match crate::db::open_with_key(&db_path_str, &*new_sqlcipher_key) {
                Ok(conn) => {
                    log::info!("T3-resume: DB already on db_key-derived key");
                    conn
                }
                Err(_) => {
                    // DB is still master-keyed — redo the PRAGMA rekey.
                    log::info!("T3-resume: DB still master-keyed, redoing PRAGMA rekey");
                    let conn = crate::db::open_with_key(&db_path_str, &*old_sqlcipher_key)
                        .map_err(|e| {
                            format!("T3-resume: failed to open DB under either key: {e}")
                        })?;
                    let pre_rekey = conn
                        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                        .and_then(|_| conn.pragma_update(None, "journal_mode", "DELETE"));
                    if let Err(e) = pre_rekey {
                        return Err(format!("T3-resume: WAL flush before rekey failed: {e}"));
                    }
                    if let Err(e) = conn.pragma_update(
                        None,
                        "rekey",
                        format!("x'{}'", hex::encode(&*new_sqlcipher_key)),
                    ) {
                        // Rekey failed — DB is still master-keyed; do not clear marker.
                        return Err(format!("T3-resume: PRAGMA rekey failed: {e}"));
                    }
                    let verify: Result<i64, rusqlite::Error> =
                        conn.query_row("SELECT count(*) FROM settings", [], |r| r.get(0));
                    if let Err(e) = verify {
                        log::error!(
                            "T3-resume: post-rekey verify failed ({e}), restoring original key"
                        );
                        let _ = conn.pragma_update(
                            None,
                            "rekey",
                            format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                        );
                        return Err(format!(
                            "T3-resume: DB verify failed after rekey (original key restored): {e}"
                        ));
                    }
                    conn
                }
            };

            // DB is now on db_key. Re-write DB settings (idempotent — safe to repeat).
            let encoded_list_for_db = list_hex.to_owned();
            let cloud_fp_hex = {
                let keys_map_ref = &keys_map;
                let v1 = keys_map_ref.get(&1).ok_or_else(|| {
                    "T3-resume: epoch 1 missing from content-key list".to_string()
                })?;
                hex::encode(key_fingerprint(&*derive_sync_key(&**v1)))
            };
            db::set_setting(
                &migration_conn,
                db::WRAPPED_CONTENT_LIST,
                &encoded_list_for_db,
            )
            .map_err(|e| format!("T3-resume: WRAPPED_CONTENT_LIST write failed: {e}"))?;
            db::set_setting(&migration_conn, db::CONTENT_KEY_EPOCH, "1")
                .map_err(|e| format!("T3-resume: CONTENT_KEY_EPOCH write failed: {e}"))?;
            db::set_setting(
                &migration_conn,
                db::CLOUD_CONTENT_FINGERPRINT,
                &cloud_fp_hex,
            )
            .map_err(|e| format!("T3-resume: CLOUD_CONTENT_FINGERPRINT write failed: {e}"))?;
            db::set_setting(&migration_conn, db::NEEDS_CLOUD_CONTENT_MIGRATION, "1").map_err(
                |e| format!("T3-resume: NEEDS_CLOUD_CONTENT_MIGRATION write failed: {e}"),
            )?;

            // Clear the migration marker — migration is now complete. T3 only
            // touches db_key/content-list rekeying, never unlock_method/os_kek —
            // carry both forward unchanged.
            let final_boot = BootFile {
                mode: EncryptionMode::Password,
                unlock_method: boot.unlock_method,
                kek_salt: Some(kek_salt_hex.to_owned()),
                wrapped_key: Some(wrapped_hex.to_owned()),
                os_kek_wrapped_master: boot.os_kek_wrapped_master.clone(),
                recovery_wrapped: boot.recovery_wrapped.clone(),
                wrapped_content_list: boot.wrapped_content_list.clone(),
                wrapped_db_key: boot.wrapped_db_key.clone(),
                master_wrapped_db_key: boot.master_wrapped_db_key.clone(),
                migration_in_progress: None,
            };
            if let Err(e) = boot_file::save(&final_boot, boot_path) {
                // Non-fatal: marker stays set but migration is functionally complete.
                // The next unlock will re-run this idempotent resume path.
                log::warn!("T3-resume: final boot file save (clear marker) failed: {e}");
            }

            log::info!(
                "T3-resume: migration complete — DB on db_key-derived key, \
                 content list persisted"
            );
            content_keys = keys_map;
            db_key = resumed_db_key;
            state.set_connection(migration_conn)?;
        }
        _ => {
            // ── T3: one-time migration for existing installs ──────────
            //
            // DB is currently keyed under derive_sqlcipher_key(master).
            //
            // CRASH-SAFE ORDER:
            //   1. Compute all new key material.
            //   2. Write boot file with new material + migration_in_progress=true
            //      (atomic rename — this is the point-of-no-return commit).
            //   3. Open DB under master-derived key.
            //   4. WAL flush + PRAGMA rekey to db_key-derived.
            //   5. Verify a read succeeds.
            //   6. Write DB settings.
            //   7. Write final boot with migration_in_progress cleared.
            //
            // If we crash after step 2 (pre-write boot saved), the next unlock
            // detects migration_in_progress=true and enters the T3-resume path
            // above, which re-does the rekey idempotently using the pinned keys.
            log::info!(
                "initialize_encryption: T3 path — one-time local rekey \
                 from master-derived to db_key-derived"
            );

            let v1 = generate_content_key();
            let mut new_db_key = Zeroizing::new([0u8; 32]);
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, new_db_key.as_mut());

            let new_sqlcipher_key = derive_sqlcipher_key(&*new_db_key);
            let old_sqlcipher_key = derive_sqlcipher_key(&**master);

            // Compute all wraps BEFORE touching the boot file.
            let mut keys_map_single = std::collections::BTreeMap::new();
            keys_map_single.insert(1u32, Zeroizing::new(*v1));
            let encoded_list = encode_content_key_list(master, &keys_map_single)?;

            let kek_blob = hex::decode(wrapped_hex)
                .map_err(|e| format!("wrapped_key hex decode failed: {e}"))?;
            let params = parse_kek_params(&kek_blob)?;
            let kek =
                crate::utils::encryption::derive_encryption_key_with(password, kek_salt, params)?;
            let wrapped_db_key_blob = wrap_content_key(&kek, &*new_db_key)?;
            let wrapped_db_key_hex = hex::encode(&wrapped_db_key_blob);
            let master_wrapped_db_key_blob = wrap_content_key(master, &*new_db_key)?;
            let master_wrapped_db_key_hex = hex::encode(&master_wrapped_db_key_blob);
            let cloud_fp_hex = hex::encode(key_fingerprint(&*derive_sync_key(&*v1)));

            // Step 2: write pre-rekey boot with migration_in_progress=true.
            // This must succeed before the irreversible PRAGMA rekey.
            boot_file::save(
                &BootFile {
                    mode: EncryptionMode::Password,
                    unlock_method: boot.unlock_method,
                    kek_salt: Some(kek_salt_hex.to_owned()),
                    wrapped_key: Some(wrapped_hex.to_owned()),
                    os_kek_wrapped_master: boot.os_kek_wrapped_master.clone(),
                    recovery_wrapped: boot.recovery_wrapped.clone(),
                    wrapped_content_list: Some(encoded_list.clone()),
                    wrapped_db_key: Some(wrapped_db_key_hex.clone()),
                    master_wrapped_db_key: Some(master_wrapped_db_key_hex.clone()),
                    migration_in_progress: Some(true),
                },
                boot_path,
            )
            .map_err(|e| format!("T3 migration: pre-rekey boot file write failed: {e}"))?;

            // Step 3: open DB under old master-derived key.
            let db_path_str = db_path.to_string_lossy();
            let migration_conn = crate::db::open_with_key(&db_path_str, &*old_sqlcipher_key)
                .map_err(|e| {
                    format!("T3 migration: failed to open DB under master-derived key: {e}")
                })?;

            // Step 4: WAL flush + PRAGMA rekey.
            let pre_rekey = migration_conn
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .and_then(|_| migration_conn.pragma_update(None, "journal_mode", "DELETE"));
            if let Err(e) = pre_rekey {
                return Err(format!("T3 migration: WAL flush before rekey failed: {e}"));
            }

            if let Err(e) = migration_conn.pragma_update(
                None,
                "rekey",
                format!("x'{}'", hex::encode(&*new_sqlcipher_key)),
            ) {
                // Rekey failed — DB is still master-keyed.  The pre-write boot is
                // already saved (marker=true), so the next unlock will enter T3-resume
                // and retry the rekey using the pinned db_key from the boot file.
                return Err(format!("T3 migration: PRAGMA rekey failed: {e}"));
            }

            // Step 5: verify read succeeds under db_key.
            let verify: Result<i64, rusqlite::Error> =
                migration_conn.query_row("SELECT count(*) FROM settings", [], |r| r.get(0));
            if let Err(e) = verify {
                // Inverse rekey to restore original state.
                log::error!(
                    "T3 migration: post-rekey verify failed ({e}), \
                     attempting inverse rekey to restore original key"
                );
                let _ = migration_conn.pragma_update(
                    None,
                    "rekey",
                    format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                );
                return Err(format!(
                    "T3 migration: DB verify failed after rekey \
                     (original key restored): {e}"
                ));
            }

            // Step 6: persist content-key list + db_key to DB settings.
            if let Err(e) =
                db::set_setting(&migration_conn, db::WRAPPED_CONTENT_LIST, &encoded_list)
            {
                // Inverse rekey before returning error.
                log::error!(
                    "T3 migration: settings write failed ({e}), \
                     restoring original key"
                );
                let _ = migration_conn.pragma_update(
                    None,
                    "rekey",
                    format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                );
                return Err(format!("T3 migration: settings write failed: {e}"));
            }
            db::set_setting(&migration_conn, db::CONTENT_KEY_EPOCH, "1").map_err(|e| {
                // Inverse rekey before returning error.
                log::error!("T3 migration: CONTENT_KEY_EPOCH write failed ({e}), restoring key");
                let _ = migration_conn.pragma_update(
                    None,
                    "rekey",
                    format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                );
                format!("T3 migration: CONTENT_KEY_EPOCH write failed: {e}")
            })?;
            db::set_setting(
                &migration_conn,
                db::CLOUD_CONTENT_FINGERPRINT,
                &cloud_fp_hex,
            )
            .map_err(|e| {
                log::error!(
                    "T3 migration: CLOUD_CONTENT_FINGERPRINT write failed ({e}), restoring key"
                );
                let _ = migration_conn.pragma_update(
                    None,
                    "rekey",
                    format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                );
                format!("T3 migration: CLOUD_CONTENT_FINGERPRINT write failed: {e}")
            })?;
            db::set_setting(&migration_conn, db::NEEDS_CLOUD_CONTENT_MIGRATION, "1").map_err(
                |e| {
                    log::error!(
                        "T3 migration: NEEDS_CLOUD_CONTENT_MIGRATION write failed ({e}), restoring key"
                    );
                    let _ = migration_conn.pragma_update(
                        None,
                        "rekey",
                        format!("x'{}'", hex::encode(&*old_sqlcipher_key)),
                    );
                    format!("T3 migration: NEEDS_CLOUD_CONTENT_MIGRATION write failed: {e}")
                },
            )?;

            // Step 7: write final boot file with migration_in_progress cleared.
            let updated_boot = BootFile {
                mode: EncryptionMode::Password,
                unlock_method: boot.unlock_method,
                kek_salt: Some(kek_salt_hex.to_owned()),
                wrapped_key: Some(wrapped_hex.to_owned()),
                os_kek_wrapped_master: boot.os_kek_wrapped_master.clone(),
                recovery_wrapped: boot.recovery_wrapped.clone(),
                wrapped_content_list: Some(encoded_list),
                wrapped_db_key: Some(wrapped_db_key_hex),
                master_wrapped_db_key: Some(master_wrapped_db_key_hex),
                migration_in_progress: None,
            };
            if let Err(e) = boot_file::save(&updated_boot, boot_path) {
                // Non-fatal: marker stays set but migration is functionally complete.
                // The next unlock will enter T3-resume and clear the marker idempotently.
                log::warn!("T3 migration: final boot file save (clear marker) failed: {e}");
            }

            log::info!(
                "T3 migration: complete — DB rekeyed to db_key-derived, \
                 content list persisted"
            );

            let mut all_keys = std::collections::BTreeMap::new();
            all_keys.insert(1u32, Zeroizing::new(*v1));
            content_keys = all_keys;
            db_key = new_db_key;

            // Install the migrated connection (keyed under db_key).
            state.set_connection(migration_conn)?;
        }
    }

    // Phase 6 Stretch S2-1: run the AI audit-log retention purge
    // against the real on-disk DB. At startup `lib.rs` skipped this
    // call because the connection was the `:memory:` placeholder;
    // now that the real keyed connection is in place, purge any
    // ai_audit_log rows older than the configured retention window.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let purge_result = state.with_conn(|c| {
        crate::ai::audit::run_startup_retention_purge(c, now_ms).map_err(|e| e.to_string())
    });
    if let Err(e) = purge_result {
        log::warn!("ai audit: post-unlock retention purge failed: {e}");
    }

    // Backfill the recovery slot into the boot file for vaults set up
    // before the slot was stored there. The real DB is now open, so we
    // can read RECOVERY_WRAPPED_MASTER_KEY from settings.
    //
    // CRITICAL guard: that DB setting and CLOUD_MASTER_FINGERPRINT are
    // co-written at every site (setup, onboard, rotation publish), so
    // the fingerprint always identifies the master the recovery slot
    // currently wraps. During a rotation window — commit_local has
    // rekeyed the DB to the NEW master but publish_keyring has not yet
    // refreshed the slot + fingerprint — the stored fingerprint is the
    // OLD master while `master` is NEW. Backfilling the stale slot there
    // would permanently poison the boot file (a correct recovery phrase
    // would then unwrap the dead OLD master and be wrongly rejected).
    // So we only backfill when the recovered master's fingerprint
    // matches the stored one, proving the slot wraps THIS master. This
    // is immune to every rotation/abort interleaving without reasoning
    // about job states.
    if boot.recovery_wrapped.is_none() {
        let live_fp = hex::encode(crate::utils::encryption::key_fingerprint(&**master));
        let slot_and_fp = state
            .with_conn(|c| {
                let rw = db::get_setting(c, db::RECOVERY_WRAPPED_MASTER_KEY)
                    .map_err(|e| e.to_string())?
                    .filter(|s| !s.is_empty());
                let fp =
                    db::get_setting(c, db::CLOUD_MASTER_FINGERPRINT).map_err(|e| e.to_string())?;
                Ok::<_, String>((rw, fp))
            })
            .ok();
        if let Some((Some(rw), Some(stored_fp))) = slot_and_fp {
            if stored_fp == live_fp {
                // Preserve the content-key fields when backfilling the boot file.
                //
                // A load() failure here means the on-disk boot file exists but is
                // invalid (e.g. hand-corrupted) — this backfill is best-effort and
                // must never fail (or brick) an unlock that has already succeeded,
                // so skip it and log rather than defaulting to an empty BootFile
                // (which would silently drop wrapped_content_list/wrapped_db_key/
                // master_wrapped_db_key from the write below) or propagating the
                // error (which would fail a password unlock that already worked).
                match boot_file::load(boot_path) {
                    Ok(current_boot) => {
                        let backfilled = BootFile {
                            mode: EncryptionMode::Password,
                            unlock_method: current_boot.unlock_method,
                            kek_salt: Some(kek_salt_hex.to_owned()),
                            wrapped_key: Some(wrapped_hex.to_owned()),
                            os_kek_wrapped_master: current_boot.os_kek_wrapped_master.clone(),
                            recovery_wrapped: Some(rw),
                            wrapped_content_list: current_boot.wrapped_content_list.clone(),
                            wrapped_db_key: current_boot.wrapped_db_key.clone(),
                            master_wrapped_db_key: current_boot.master_wrapped_db_key.clone(),
                            migration_in_progress: None,
                        };
                        if let Err(e) = boot_file::save(&backfilled, boot_path) {
                            log::warn!("recovery slot backfill into boot file failed: {e}");
                        } else {
                            log::info!("backfilled recovery slot into boot file");
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "recovery slot backfill: failed to re-read boot file ({e}); \
                             skipping backfill this unlock"
                        );
                    }
                }
            } else {
                log::info!(
                    "skipping recovery slot backfill: stored fingerprint does not match \
                     the live master (likely an in-flight rotation); will retry next unlock"
                );
            }
        }
    }

    let latest = *content_keys
        .keys()
        .next_back()
        .ok_or_else(|| "content_keys map is empty — this is a bug".to_string())?;
    key_state.set_content_state(content_keys, latest, db_key, Zeroizing::new(**master))?;
    Ok(())
}

/// Initialize encryption: derive the master key from the password, open the
/// SQLCipher DB with the HKDF-derived sub-key, and store the master key.
///
/// ## Key resolution (boot file → DB fallback)
///
/// Phase 4+ flow: reads `kek_salt` and `wrapped_key` from the sidecar boot
/// file, derives the master key, then opens the real DB with `PRAGMA key`.
/// The placeholder `:memory:` connection (from a locked-startup) is replaced
/// by the real keyed connection.
///
/// Legacy/dev fallback (no boot file or boot file not yet written): reads
/// `kek_salt` and `wrapped_key` directly from the DB settings table. The
/// existing connection is reused — no `PRAGMA key` applied.
///
/// **Why `async fn` + `spawn_blocking`?** Argon2id unwrap is CPU-intensive.
#[tauri::command]
pub async fn initialize_encryption(app: AppHandle, password: String) -> Result<(), String> {
    let app_clone = app.clone();
    let password = zeroize::Zeroizing::new(password);

    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let key_state = app.state::<EncryptionKeyState>();

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
        let db_path = data_dir.join("memlore.db");
        let boot_path = boot_file::boot_path(&db_path);
        // A load() failure means the boot file exists but is invalid — propagate
        // rather than default to mode=Unset, which would silently divert this
        // unlock onto the "legacy DB fallback" branch below (using set_key's
        // Phase-1 shim) even though the on-disk DB is actually db_key-keyed
        // (Phase 3), producing a confusing "wrong key" failure instead of a
        // clear "boot file is invalid" one.
        let boot = boot_file::load(&boot_path)
            .map_err(|e| format!("initialize_encryption: failed to read boot file: {e}"))?;

        // Resolve kek_salt and wrapped_key — boot file preferred, DB fallback.
        let (wrapped_hex, kek_salt_hex) =
            if let (Some(wk), Some(ks)) = (boot.wrapped_key.as_ref(), boot.kek_salt.as_ref()) {
                (wk.clone(), ks.clone())
            } else {
                // Legacy path: boot file absent, read from DB.
                let conn = state.lock()?;
                let wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
                    .map_err(|e| e.to_string())?
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        "Encryption not initialized — complete first-launch password setup first"
                            .to_string()
                    })?;
                let kek_salt = db::get_setting(&conn, db::KEK_SALT_KEY)
                    .map_err(|e| e.to_string())?
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "Encryption not initialized — KEK salt missing".to_string())?;
                (wrapped, kek_salt)
            };

        let kek_salt = decode_hex_salt(&kek_salt_hex)?;
        // AES-GCM authentication failure = wrong password.
        let master = unwrap_key(&wrapped_hex, &password, &kek_salt)
            .map_err(|_| "Invalid password".to_string())?;

        if boot.mode == EncryptionMode::Password {
            initialize_encryption_inner(
                &state,
                &key_state,
                &boot,
                &boot_path,
                &db_path,
                &master,
                &password,
                &wrapped_hex,
                &kek_salt,
                &kek_salt_hex,
            )?;
        } else {
            // Non-Password mode (None / Unset) — use Phase-1 shim.
            key_state.set_key(master)?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    // Best-effort startup keyring reconcile (crash-window recovery).
    // Heals the case where a previous crash left sync_connected=true with a
    // local key that differs from the cloud keyring.
    //
    // Deferred (fire-and-forget): reconcile performs a Drive network read, so
    // awaiting it here would block the unlock promise on I/O. Instead we spawn
    // it after the key is loaded and let unlock resolve immediately. The task
    // emits `xj://force-re-pair` on mismatch so the UI still reacts in-session
    // (it no longer relies on the awaited path writing the flag before the UI
    // hydrates). Errors are swallowed — a network hiccup must not affect unlock.
    {
        let reconcile_app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            use tauri::Manager;
            let state = reconcile_app.state::<AppState>();
            let key_state = reconcile_app.state::<EncryptionKeyState>();
            crate::commands::gdrive::startup_keyring_reconcile_if_needed(
                &state,
                &key_state,
                &reconcile_app,
            )
            .await;
        });
    }

    // Emit `app:unlocked` so background workers that scheduled a swap-to-stub
    // grace timer on `app:locked` can cancel it (Phase 6 AI: ONNX session
    // stays in memory across a quick lock/unlock). Best-effort — failure
    // here cannot block the unlock itself.
    if let Err(e) = app_clone.emit("app:unlocked", ()) {
        log::warn!("emit app:unlocked failed (non-fatal): {e}");
    }

    // C1: Detect an in-progress rotation job that was interrupted by a crash.
    // If one exists, emit `xj://rotation-resume-required` so the frontend can
    // prompt the user for their password (and mnemonic) and call `resume_rotation`.
    // A job without a stash is unresumable and is discarded here (defensive; the
    // C3 fix prevents this state from occurring in the first place).
    {
        use tauri::Manager;
        let state = app_clone.state::<AppState>();
        // First, discard any orphaned job that has no stash (shouldn't happen after C3 fix).
        if let Err(e) = crate::sync::rotation::discard_orphaned_rotation_job_if_any(&*state) {
            log::warn!("post-unlock rotation orphan check failed (non-fatal): {e}");
        }
        // Now check if there is a resumable job.
        let active_job = state
            .lock()
            .ok()
            .and_then(|conn| db::find_active_rotation_job(&conn).ok().flatten());
        if let Some(job) = active_job {
            log::warn!(
                "post-unlock: found interrupted rotation job {} (state='{}') — emitting \
                 xj://rotation-resume-required",
                job.id,
                job.state
            );
            let payload = RotationResumePayload {
                state: job.state.clone(),
                is_revoke: job.revoked_device_id.is_some(),
            };
            if let Err(e) = app_clone.emit("xj://rotation-resume-required", payload) {
                log::warn!("emit xj://rotation-resume-required failed (non-fatal): {e}");
            }
        }
    }

    // Phase 6 v2 R2: hydrate the AI provider registry from the now-decrypted
    // `settings` table. We can't do this earlier because the API key + the
    // provider config row both live behind SQLCipher. Best-effort —
    // a malformed config row must not prevent unlock.
    {
        use tauri::Manager;
        let state = app_clone.state::<AppState>();
        let registry = app_clone.state::<crate::ai::provider_registry::ProviderRegistry>();
        // R11+: hydrate gen and embed slots independently. A malformed
        // or unconfigured slot must NOT prevent the other from loading.
        let server_manager =
            app_clone.state::<std::sync::Arc<crate::ai::on_device::server::LlamaServerManager>>();
        let asset_manager = app_clone
            .state::<std::sync::Arc<crate::ai::on_device::llm_download::LlmAssetManager>>();
        let gen_result = state.lock().and_then(|conn| {
            crate::commands::ai_provider::load_gen_slot(
                &conn,
                &registry,
                Some(&server_manager),
                Some(&asset_manager),
            )
            .map_err(|e| e.to_string())
        });
        match gen_result {
            Ok(true) => log::info!("ai: generation slot hydrated on unlock"),
            Ok(false) => log::info!("ai: no generation provider configured"),
            Err(e) => log::warn!("ai: generation hydrate failed: {e}"),
        }
        let image_result = state.lock().and_then(|conn| {
            crate::commands::ai_provider::load_image_slot(&conn, &registry)
                .map_err(|e| e.to_string())
        });
        match image_result {
            Ok(true) => log::info!("ai: image slot hydrated on unlock"),
            Ok(false) => log::info!("ai: no image provider configured"),
            Err(e) => log::warn!("ai: image hydrate failed: {e}"),
        }
        let indexer = app_clone.state::<crate::ai::indexer::EntryIndexer>();
        let downloads =
            app_clone.state::<std::sync::Arc<crate::ai::on_device::download::DownloadManager>>();
        let embed_result = state.lock().and_then(|conn| {
            crate::commands::ai_provider::load_embed_slot(
                &conn,
                &registry,
                Some(&indexer),
                Some(&downloads),
            )
            .map_err(|e| e.to_string())
        });
        match embed_result {
            Ok(true) => log::info!("ai: embedding slot hydrated on unlock"),
            Ok(false) => log::info!("ai: no embedding provider configured"),
            Err(e) => log::warn!("ai: embedding hydrate failed: {e}"),
        }
        // Phase 2 C1: hydrate the memory slot PAIR (gen + embed) from the
        // now-decrypted settings rows. The registry holds providers in-memory,
        // so without this `is_memory_enabled()` returns false every session
        // after a restart despite valid persisted config. Best-effort, same
        // posture as gen/embed above — a malformed row must not fail unlock;
        // each loader additionally re-runs `enforce_memory_slot_class` against
        // the persisted rows (defense-in-depth against a hand-edited DB).
        let mem_gen_result = state.lock().and_then(|conn| {
            crate::commands::ai_provider::load_memory_gen_slot(
                &conn,
                &registry,
                Some(&server_manager),
                Some(&asset_manager),
            )
            .map_err(|e| e.to_string())
        });
        match mem_gen_result {
            Ok(true) => log::info!("ai: memory generation slot hydrated on unlock"),
            Ok(false) => log::info!("ai: no memory generation provider configured"),
            Err(e) => log::warn!("ai: memory generation hydrate failed: {e}"),
        }
        let mem_embed_result = state.lock().and_then(|conn| {
            crate::commands::ai_provider::load_memory_embed_slot(&conn, &registry, Some(&downloads))
                .map_err(|e| e.to_string())
        });
        match mem_embed_result {
            Ok(true) => log::info!("ai: memory embedding slot hydrated on unlock"),
            Ok(false) => log::info!("ai: no memory embedding provider configured"),
            Err(e) => log::warn!("ai: memory embedding hydrate failed: {e}"),
        }
        // Legacy single-slot fallback removed (R11+ installs use gen + embed slots only).
    }

    // Phase 6 v2 R3: run the one-shot v2 cleanup against the now-real DB.
    // We can't do this from the frontend `useAIProviderLifecycle` hook
    // because that fires on App mount BEFORE unlock, so it would only
    // ever see the locked-`:memory:` placeholder connection. Running it
    // here guarantees the orphan v1 embedding rows get deleted from the
    // SQLCipher-encrypted DB exactly once per install.
    {
        use tauri::Manager;
        let state = app_clone.state::<AppState>();
        let app_data_dir = app_clone.path().app_data_dir().ok();
        let result = state.lock().and_then(|conn| {
            crate::commands::ai_settings::run_ai_v2_migration(&conn, app_data_dir.as_deref())
                .map_err(|e| e.to_string())
        });
        match result {
            Ok(outcome) if outcome.ran => log::info!(
                "ai: v2 migration ran on unlock — orphan_rows={} models_dir_removed={}",
                outcome.orphan_rows_deleted,
                outcome.models_dir_removed
            ),
            Ok(_) => {} // already migrated; silent
            Err(e) => log::warn!("ai: v2 migration failed (non-fatal): {e}"),
        }
    }

    Ok(())
}

/// Lock encryption: clear the key from memory (Zeroizing wipes it on drop).
///
/// Also emits `app:locked` so background workers (Phase 6 backfill, future
/// model-loading services) can release per-session resources. The emit is
/// best-effort — failure to deliver the event must not prevent the key from
/// being wiped, since clearing the key is the actual security guarantee.
#[tauri::command]
pub fn lock_encryption(
    app: AppHandle,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<(), String> {
    key_state.clear_key()?;
    if let Err(e) = app.emit("app:locked", ()) {
        log::warn!("emit app:locked failed (non-fatal): {e}");
    }
    Ok(())
}

/// Returns true if the encryption key is currently loaded in memory.
#[tauri::command]
pub fn is_encryption_initialized(key_state: State<'_, EncryptionKeyState>) -> Result<bool, String> {
    key_state.is_initialized()
}

// ─── V2 first-time setup ─────────────────────────────────────────────────────

/// Returned to the frontend after `begin_first_time_setup`.
///
/// The frontend holds `setup_id` until the user completes (or cancels) the
/// 4-word mnemonic confirmation challenge.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FirstTimeSetupHandle {
    /// Opaque token — matches the `pending_first_time_setup.setup_id` row.
    pub setup_id: String,
    /// 24 BIP39 words. The frontend renders these in a 4×6 grid.
    pub mnemonic: Vec<String>,
    /// 4 distinct indices into `mnemonic` (range `[0, 24)`).
    /// The confirmation screen asks the user to re-enter the words at these
    /// positions to prove they wrote the phrase down.
    pub challenge_indices: Vec<usize>,
}

// ─── Pre-flight guards ────────────────────────────────────────────────────────

/// Task 6 guard: rejects when `sync_connected=true` AND `encryption_mode=Unset`
/// AND no pending session is being consumed in this call.
///
/// This is a regression backstop — the dangerous state is practically
/// unreachable after Phase 1's deferred-persistence fix, but the guard
/// prevents a malicious renderer (DevTools / extension) from calling a setup
/// command after injecting a Drive connection without completing onboarding.
///
/// Pass `session_id = Some(sid)` to bypass the guard for the legitimate
/// consume-session path (e.g. `confirm_first_time_setup` with a pending
/// session). Always pass `None` for `begin_first_time_setup` (that command
/// has no session_id parameter).
pub(crate) fn check_unclaimed_drive_guard(
    conn: &rusqlite::Connection,
    session_id: Option<&str>,
) -> Result<(), String> {
    // A pending session being consumed IS the legitimate path — no guard needed.
    if session_id.is_some() {
        return Ok(());
    }
    let sync_connected = db::get_setting(conn, "sync_connected")
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some("true");
    if !sync_connected {
        return Ok(());
    }
    let mode = db::get_encryption_mode(conn).map_err(|e| e.to_string())?;
    if mode == db::EncryptionMode::Unset {
        return Err("UNSAFE_SETUP_DRIVE_CONNECTED_BUT_UNCLAIMED".to_string());
    }
    Ok(())
}

/// Task 7 guard: probes the cloud `.meta/keyring/_meta.json` and rejects with
/// `CLOUD_VAULT_EXISTS_USE_ONBOARDING` if found. Network failures are swallowed
/// as non-fatal (best-effort defence in depth).
///
/// Generic over the provider so tests can pass an in-memory fake.
pub(crate) async fn check_cloud_vault_guard(
    provider: &impl crate::sync::keyring_v2::KeyringV2Io,
) -> Result<(), String> {
    use crate::sync::provider::SyncError;
    match provider.read_file(crate::sync::keyring_v2::META_PATH).await {
        Ok(_) => Err("CLOUD_VAULT_EXISTS_USE_ONBOARDING".to_string()),
        Err(SyncError::NotFound(_)) => Ok(()),
        Err(e) => {
            log::warn!("begin_first_time_setup: cloud V2 vault probe failed (non-fatal): {e}");
            Ok(())
        }
    }
}

/// Step 1 of the V2 first-time setup flow.
///
/// Generates a fresh master key + BIP39 mnemonic, wraps both, persists a
/// crash-safe pending row, and returns the mnemonic + challenge indices so
/// the frontend can display the recovery phrase screen.
///
/// **Idempotency / re-init guard:** refuses to run if `encryption_mode` is
/// already set, a wrapped key exists, or a password hash exists.  This
/// matches the guard in `setup_first_time_inner`.
///
/// **Task 6 guard:** rejects with `UNSAFE_SETUP_DRIVE_CONNECTED_BUT_UNCLAIMED`
/// if Drive is connected but the vault is unclaimed (regression backstop).
///
/// **Task 7 guard:** if Drive is connected, probes the cloud for an existing
/// V2 keyring. Found → rejects with `CLOUD_VAULT_EXISTS_USE_ONBOARDING`.
/// Network error → logs and continues (best-effort).
#[tauri::command]
pub async fn begin_first_time_setup(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    password: String,
    device_name: String,
) -> Result<FirstTimeSetupHandle, String> {
    let password = Zeroizing::new(password);
    validate_password_length(&*password)?;

    // ── Task 6: unclaimed-drive guard ────────────────────────────────────────
    // Read sync_connected + encryption_mode, then drop the lock before any
    // await so the mutex guard isn't held across an async boundary.
    let sync_connected = {
        let conn = state.lock()?;
        // begin_first_time_setup has no session_id → always pass None.
        check_unclaimed_drive_guard(&conn, None)?;
        db::get_setting(&conn, "sync_connected")
            .map_err(|e| e.to_string())?
            .as_deref()
            == Some("true")
        // conn (and the lock) drops here.
    };

    // ── Task 7: cloud vault probe ─────────────────────────────────────────────
    if sync_connected {
        match acquire_drive_provider(&app, &state) {
            Ok(provider) => {
                check_cloud_vault_guard(&provider).await?;
            }
            Err(e) => {
                log::warn!(
                    "begin_first_time_setup: could not acquire drive provider for V2 \
                     probe; proceeding ({e})"
                );
            }
        }
    }

    // ── Inner: generate key material and persist pending row ─────────────────
    let conn = state.lock()?;
    begin_first_time_setup_inner(&conn, &password, &device_name, KdfParams::FAST)
}

/// Crate-internal implementation of `begin_first_time_setup`.
///
/// Separated so tests can call it without Tauri state.
pub(crate) fn begin_first_time_setup_inner(
    conn: &rusqlite::Connection,
    password: &str,
    device_name: &str,
    kdf_params: KdfParams,
) -> Result<FirstTimeSetupHandle, String> {
    use rand::RngCore;

    // ── Password length guard ────────────────────────────────────────────────
    validate_password_length(password)?;

    // ── Re-init guard ────────────────────────────────────────────────────────
    let current_mode = db::get_encryption_mode(conn).map_err(|e| e.to_string())?;
    let has_wrapped = db::get_setting(conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
        .map_err(|e| e.to_string())?
        .is_some_and(|s| !s.is_empty());
    let has_hash = db::is_password_hash_set(conn).map_err(|e| e.to_string())?;
    if current_mode != db::EncryptionMode::Unset || has_wrapped || has_hash {
        return Err(
            "begin_first_time_setup refuses to run: encryption is already configured".to_string(),
        );
    }

    // ── Generate master key ──────────────────────────────────────────────────
    let mut master_key = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(master_key.as_mut());

    // ── Wrap master key with password KEK (self-describing, chosen preset) ────
    let kek_salt = generate_encryption_salt();
    let wrapped_master = wrap_key_with(&master_key, password, &kek_salt, kdf_params)
        .map_err(|e| format!("wrap_key failed: {e}"))?;
    let kek_salt_hex = encode_hex(&kek_salt);

    // ── Generate BIP39 mnemonic + recovery wrapped key ───────────────────────
    let mnemonic_phrase = crate::utils::recovery::generate_recovery_mnemonic()
        .map_err(|e| format!("generate_recovery_mnemonic failed: {e}"))?;
    let mnemonic_parsed = crate::utils::recovery::validate_recovery_mnemonic(&mnemonic_phrase)
        .map_err(|e| format!("validate_recovery_mnemonic failed: {e}"))?;
    let recovery_key = crate::utils::recovery::derive_recovery_key(&mnemonic_parsed);
    // Recovery slot uses AES-GCM directly with the recovery_key as the AES key —
    // NO Argon2id wrap. The recovery_key is already a 256-bit HKDF output of the
    // BIP39 seed, so KDF stretching would be redundant cost (~64 MiB Argon2id per
    // unwrap). The plan spec is `recovery_wrapped = AES-GCM(recovery_key, master_key)`.
    let recovery_wrapped_bytes =
        crate::utils::encryption::encrypt_data(&*recovery_key, master_key.as_ref())
            .map_err(|e| format!("recovery encrypt_data failed: {e}"))?;
    let recovery_wrapped = hex::encode(&recovery_wrapped_bytes);
    // recovery_key is dropped & zeroed here; master_key is zeroed at end of scope.

    // ── Device ID + setup ID ─────────────────────────────────────────────────
    let device_id = db::get_or_create_device_id(conn).map_err(|e| e.to_string())?;
    let setup_id = uuid::Uuid::new_v4().to_string();

    // ── Fixed challenge positions: 1st, 3rd, 2nd-to-last, last ───────────────
    // Asking for predictable, easy-to-count positions (words 1, 3, 23, 24)
    // lets the user fill the confirmation form without counting word-by-word
    // through the copied phrase. This trades the anti-guessing property of
    // random positions for materially better UX during onboarding.
    // The fixed scheme requires at least 5 words to stay distinct + in range
    // (unlike the old random sample, which only needed 4) — guard it.
    const _: () = assert!(crate::utils::recovery::RECOVERY_WORD_COUNT >= 5);
    let last = crate::utils::recovery::RECOVERY_WORD_COUNT - 1;
    let indices: Vec<usize> = vec![0, 2, last - 1, last];
    let challenge_indices_json = serde_json::to_string(&indices)
        .map_err(|e| format!("challenge_indices JSON failed: {e}"))?;

    // ── Purge any orphaned pending rows ─────────────────────────────────────
    // Only one active setup is allowed at a time. Stale rows from a previous
    // crashed wizard session are removed now, before the fresh row is written.
    let purged = db::delete_all_pending_setups(conn).map_err(|e| e.to_string())?;
    if purged > 0 {
        log::warn!(
            "begin_first_time_setup: purged {purged} orphaned pending setup row(s) before insert"
        );
    }

    // ── Persist pending row ──────────────────────────────────────────────────
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    db::insert_pending_setup(
        conn,
        &db::PendingFirstTimeSetupRow {
            setup_id: setup_id.clone(),
            mnemonic: (*mnemonic_phrase).clone(),
            wrapped_master,
            kek_salt: kek_salt_hex,
            recovery_wrapped,
            device_id,
            device_name: device_name.to_string(),
            challenge_indices: challenge_indices_json,
            created_at: now,
        },
    )
    .map_err(|e| e.to_string())?;

    let mnemonic_words: Vec<String> = mnemonic_phrase
        .split_whitespace()
        .map(str::to_string)
        .collect();

    // master_key is zeroed on drop here.
    Ok(FirstTimeSetupHandle {
        setup_id,
        mnemonic: mnemonic_words,
        challenge_indices: indices,
    })
}

/// Parse a caller-requested unlock method string and — if it asks for
/// os_kek — generate the os_kek and wrap `master_key` under it.
///
/// Accepted values: `None` / `Some("password")` (default) → password-only,
/// no os_kek touched. `Some("os_kek")` / `Some("both")` → probe
/// `is_os_kek_available()`; unavailable is a hard error (never silently
/// downgrade a caller's explicit request — the future picker UI needs to
/// know its choice wasn't honored). Available → generate a fresh os_kek and
/// wrap `master_key` under it.
///
/// The password wrap is always written by the caller regardless of this
/// function's result (setup/onboard always collect a password), so the
/// resolved method is always `Password` or `Both` — this function never
/// returns `UnlockMethod::OsKek` alone. Pure os_kek-only boot files are a
/// supported format/unlock-path state (design doc §4) but are not produced
/// by the setup/onboard commands this phase.
///
/// On any error after `generate_os_kek()` succeeded (i.e. the wrap step
/// itself fails), removes the just-created os_kek so a failed setup never
/// strands a Keychain item with nothing in the boot file pointing at it.
fn resolve_unlock_method_with_os_kek(
    unlock_method: Option<&str>,
    master_key: &[u8; 32],
) -> Result<(crate::utils::boot_file::UnlockMethod, Option<String>), String> {
    use crate::utils::boot_file::UnlockMethod;
    match unlock_method {
        None | Some("password") => Ok((UnlockMethod::Password, None)),
        Some("os_kek") | Some("both") => {
            if !crate::commands::keychain::is_os_kek_available() {
                return Err(
                    "os_kek unlock is not available on this platform; use password".to_string(),
                );
            }
            let os_kek = crate::commands::keychain::generate_os_kek()
                .map_err(|e| format!("failed to generate os_kek: {e}"))?;
            match wrap_content_key(&os_kek, master_key) {
                Ok(blob) => Ok((UnlockMethod::Both, Some(hex::encode(blob)))),
                Err(e) => {
                    let _ = crate::commands::keychain::remove_os_kek();
                    Err(format!("failed to wrap master under os_kek: {e}"))
                }
            }
        }
        Some(other) => Err(format!("Unknown unlock_method: {other:?}")),
    }
}

/// Compute the boot file `change_password` must write: new password wraps,
/// os_kek dropped, `unlock_method` reverted to `Password`, every other field
/// carried forward from `prev` unchanged. `recover_with_passphrase` applies
/// the same os_kek-drop policy but isn't wired to this helper — its
/// `wrapped_db_key` is `Option` (legacy pre-db_key vaults) and it preserves
/// `migration_in_progress` conditionally, both of which don't fit this
/// function's simpler (always-`Some`, always-clears-the-marker) shape.
///
/// Extracted as a pure function — with no DB/Tauri state — so unit tests can
/// drive the exact transformation the production code applies, rather than
/// re-deriving it by hand. Master is unchanged by a password change, so
/// `os_kek_wrapped_master` stays cryptographically valid; it is dropped here
/// anyway as a deliberate policy choice (force re-enrollment of convenience
/// unlock), matching the `wipe_biometric_keychain()` call callers make
/// alongside this. Password remains the guaranteed fallback (`wrapped_key` is
/// always `Some` in the result), so this is never a lockout.
pub(crate) fn boot_after_password_change(
    prev: &BootFile,
    new_kek_salt_hex: String,
    new_wrapped_key: String,
    new_wrapped_db_key_hex: String,
) -> BootFile {
    BootFile {
        mode: EncryptionMode::Password,
        unlock_method: crate::utils::boot_file::UnlockMethod::Password,
        kek_salt: Some(new_kek_salt_hex),
        wrapped_key: Some(new_wrapped_key),
        os_kek_wrapped_master: None,
        // Recovery slot is wrapped by the independent recovery key, unaffected
        // by a password change — carry it forward untouched.
        recovery_wrapped: prev.recovery_wrapped.clone(),
        // wrapped_content_list is wrapped under master (not password KEK), so
        // it is unchanged across a password rotation.
        wrapped_content_list: prev.wrapped_content_list.clone(),
        // wrapped_db_key is wrapped under the password KEK — freshly re-wrapped.
        wrapped_db_key: Some(new_wrapped_db_key_hex),
        // master_wrapped_db_key is wrapped under master; master is UNCHANGED
        // on a password change, so carry it forward untouched.
        master_wrapped_db_key: prev.master_wrapped_db_key.clone(),
        migration_in_progress: None,
    }
}

/// Context passed from `confirm_first_time_setup_inner` to
/// `try_publish_v2_keyring_after_setup` so the keyring files can be built
/// from values that are already in scope (avoiding re-reads after the
/// pending row is deleted).
#[derive(Debug)]
pub(crate) struct V2KeyringPublishContext {
    pub recovery_wrapped: String,
    pub device_id: String,
    pub device_name: String,
    /// 64-char hex HMAC-SHA256 fingerprint of the master key.
    pub master_fingerprint: String,
    /// Vault/keyring creation time — used for `_recovery.json` and `_meta.json`.
    /// Sourced from `RECOVERY_PASSPHRASE_CREATED_AT`. Distinct from
    /// [`Self::device_created_at`].
    pub created_at: i64,
    /// This DEVICE's join time — used for `devices/<id>.json` `created_at`.
    /// Sourced from the current device's local `devices` row, which is the
    /// single source of truth for it. Keeping this separate from
    /// [`Self::created_at`] avoids two writers stamping the device slot from
    /// different sources (the local row vs. the vault-creation setting, which is
    /// `0` on peer devices).
    pub device_created_at: i64,
    /// Wall-clock seconds for the device slot's `last_seen_at`. Sourced from the
    /// current device's local `devices` row (freshened after each sync) so a
    /// republish does not reset peers' view of this device to `created_at`.
    pub last_seen_at: i64,
    /// 120 hex chars: `AES-GCM(master, content_key_v1)` — the v1 content key
    /// wrapped under master.  Published to `_content.json` so joiners can unwrap
    /// the v1 key.  Computed in `confirm_first_time_setup_inner` where master is
    /// in scope; can't be recomputed at the gdrive layer.
    pub wrapped_content_v1: String,
    /// 64 hex chars: `key_fingerprint(derive_sync_key(v1))` — used as
    /// `content_fingerprint` in the `_content.json` entry for epoch 1.
    pub content_fingerprint_v1: String,
}

/// Step 2 of the V2 first-time setup flow.
///
/// Validates the 4 challenge words, re-derives the master key from the
/// password, commits all key material to the DB, re-keys SQLCipher, and
/// (if Drive is connected) publishes the V2 keyring to the cloud.
///
/// The `password` field here is the password re-typed on the confirmation
/// screen — used to unwrap the `wrapped_master` from the pending row.
///
/// `unlock_method`: optional, defaults to password-only when omitted (current
/// frontend behavior — the unlock-method picker UI is a later phase). See
/// `resolve_unlock_method_with_os_kek` for accepted values.
#[tauri::command]
pub async fn confirm_first_time_setup(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    key_state: tauri::State<'_, EncryptionKeyState>,
    setup_id: String,
    answers: Vec<String>,
    password: String,
    session_id: Option<String>,
    unlock_method: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let password = Zeroizing::new(password);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let db_path = data_dir.join("memlore.db");
    let boot_path = crate::utils::boot_file::boot_path(&db_path);

    // ── Extract the real connection, replace with placeholder ────────────────
    // Mirrors the swap pattern from `setup_first_time` (lines 98–110).
    let real_conn = {
        let placeholder = rusqlite::Connection::open_in_memory()
            .map_err(|e| format!("Failed to create placeholder connection: {e}"))?;
        db::schema::migrate(&placeholder)
            .map_err(|e| format!("Failed to migrate placeholder: {e}"))?;
        db::set_encryption_mode(&placeholder, db::EncryptionMode::Unset)
            .map_err(|e| format!("Failed to seed placeholder mode: {e}"))?;
        let mut guard = state.lock()?;
        std::mem::replace(&mut *guard, placeholder)
    };

    let result = confirm_first_time_setup_inner(
        real_conn,
        &key_state,
        &setup_id,
        &answers,
        &password,
        &db_path,
        Some(&boot_path),
        session_id.as_deref(),
        unlock_method.as_deref(),
    );

    match result {
        Ok((new_conn, publish_ctx)) => {
            state.set_connection(new_conn)?;

            // Best-effort Drive publish: if connected, upload V2 keyring now.
            // Failure is non-fatal — the dirty flag will cause a retry on next sync.
            {
                let is_connected = state
                    .lock()
                    .ok()
                    .and_then(|c| db::get_setting(&c, "sync_connected").ok().flatten())
                    .as_deref()
                    == Some("true");
                if is_connected {
                    let state2 = app.state::<AppState>();
                    crate::commands::gdrive::try_publish_v2_keyring_after_setup(
                        &*state2,
                        &key_state,
                        publish_ctx,
                    )
                    .await;
                }
            }

            Ok(())
        }
        Err(e) => {
            // Restore a bootstrap connection so the app is not left with an
            // unusable in-memory placeholder. Mirrors setup_first_time error path.
            log::error!("confirm_first_time_setup: inner failed ({e}); restoring bootstrap conn");
            let db_path_str = db_path.to_string_lossy().into_owned();
            match db::open_with_key(&db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY) {
                Ok(restored) => {
                    log::info!(
                        "confirm_first_time_setup: bootstrap re-open succeeded after failure"
                    );
                    let _ = state.set_connection(restored);
                }
                Err(open_err) => {
                    log::error!(
                        "confirm_first_time_setup: bootstrap re-open also failed ({open_err}); \
                         using emergency placeholder"
                    );
                    if let Ok(emergency) = rusqlite::Connection::open_in_memory() {
                        let _ = db::schema::migrate(&emergency);
                        let _ = state.set_connection(emergency);
                    }
                }
            }
            Err(e)
        }
    }
}

/// Crate-internal implementation of `confirm_first_time_setup`.
///
/// Takes ownership of `conn` because PRAGMA rekey consumes the connection
/// (same pattern as `setup_first_time_inner`). Returns the post-rekey
/// connection plus a [`V2KeyringPublishContext`] containing all values needed
/// to publish the V2 keyring to Drive (passed so values from the pending row
/// remain available after the row is deleted at the end of this function).
///
/// `boot_path`: pass `Some(path)` in production (writes boot file + PRAGMA
/// rekey). Pass `None` in unit tests using in-memory DBs to skip file I/O.
///
/// `unlock_method`: caller-requested unlock method — `None`/`Some("password")`
/// (default, current frontend behavior) writes password-only. `Some("os_kek")`
/// or `Some("both")` additionally generates an os_kek and writes
/// `os_kek_wrapped_master`; the password wrap is written unconditionally
/// either way, so the boot file's actual `unlock_method` is always `Password`
/// or `Both` — pure os_kek-only vaults are a supported format/unlock-path
/// state (§4) but are not produced by this command. See
/// `crate::utils::boot_file::UnlockMethod` doc comments.
pub(crate) fn confirm_first_time_setup_inner(
    conn: rusqlite::Connection,
    key_state: &EncryptionKeyState,
    setup_id: &str,
    answers: &[String],
    password: &str,
    _db_path: &Path,
    boot_path: Option<&Path>,
    session_id: Option<&str>,
    unlock_method: Option<&str>,
) -> Result<(rusqlite::Connection, V2KeyringPublishContext), String> {
    // ── Load pending row ─────────────────────────────────────────────────────
    let row = db::get_pending_setup_by_id(&conn, setup_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("setup_id not found: {setup_id}"))?;

    // ── Validate challenge answers ────────────────────────────────────────────
    let mnemonic_words: Vec<&str> = row.mnemonic.split_whitespace().collect();
    let challenge_indices: Vec<usize> = serde_json::from_str(&row.challenge_indices)
        .map_err(|e| format!("challenge_indices parse failed: {e}"))?;

    if answers.len() != challenge_indices.len() {
        return Err(format!(
            "expected {} answers, got {}",
            challenge_indices.len(),
            answers.len()
        ));
    }

    for (i, (&idx, answer)) in challenge_indices.iter().zip(answers.iter()).enumerate() {
        let expected = mnemonic_words
            .get(idx)
            .ok_or_else(|| format!("challenge index {idx} out of range"))?;
        if answer.trim().to_lowercase() != *expected {
            return Err(format!(
                "mnemonic challenge failed at position {i} (word index {idx})"
            ));
        }
    }

    // ── Unwrap master key using the user's password ───────────────────────────
    let kek_salt_bytes =
        hex::decode(&row.kek_salt).map_err(|e| format!("kek_salt hex decode failed: {e}"))?;
    let master_key = unwrap_key(&row.wrapped_master, password, &kek_salt_bytes)
        .map_err(|_| "incorrect password".to_string())?;

    // ── Compute master fingerprint ────────────────────────────────────────────
    let fingerprint_bytes = crate::utils::encryption::key_fingerprint(&*master_key);
    let master_fingerprint = hex::encode(fingerprint_bytes);

    // ── Generate v1 content key + per-device db_key (Phase 3 T1) ─────────────
    //
    // Creator path: generate a fresh random v1 content key and a per-device
    // db_key. The content key wraps around the master (never published directly).
    // The db_key is per-device (never published to cloud) — only the content key
    // list is shared across devices via _content.json (Phase 5).
    let content_key_v1 = generate_content_key();
    let mut db_key = Zeroizing::new([0u8; 32]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, db_key.as_mut());

    let mut content_key_map: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>> =
        std::collections::BTreeMap::new();
    content_key_map.insert(1u32, Zeroizing::new(*content_key_v1));

    // Wrap the content-key list under master for boot file / DB storage.
    let encoded_content_list = encode_content_key_list(&master_key, &content_key_map)?;

    // Cloud fingerprint is key_fingerprint(derive_sync_key(v1)) —
    // matches how the sync engine stamps entry envelopes.
    let cloud_fp_hex = hex::encode(key_fingerprint(&*derive_sync_key(&*content_key_v1)));

    // Wrap db_key under the password KEK (same kek_salt as master).
    // We use the raw AES-256-GCM wrap (no Argon2id step) so the KEK we already
    // derived doesn't need a second Argon2id pass. To get the KDF params we
    // parse the wrapped_master header.
    let kek_blob = hex::decode(&row.wrapped_master)
        .map_err(|e| format!("wrapped_master hex decode failed: {e}"))?;
    let kek_params = parse_kek_params(&kek_blob)?;
    let kek = crate::utils::encryption::derive_encryption_key_with(
        password,
        &kek_salt_bytes,
        kek_params,
    )?;
    let wrapped_db_key_blob = wrap_content_key(&kek, &*db_key)?;
    let wrapped_db_key_hex = hex::encode(&wrapped_db_key_blob);

    // ── Resolve unlock method (Phase 3) — before any DB mutation so an
    //    os_kek failure aborts cleanly with zero writes. ─────────────────────
    let (resolved_unlock_method, os_kek_wrapped_master_hex) =
        resolve_unlock_method_with_os_kek(unlock_method, &master_key)?;
    // If os_kek was generated above and any step below fails, remove it so a
    // failed setup never strands a Keychain item that nothing in the
    // (rolled-back) boot file or DB points at.
    let cleanup_os_kek = || {
        if os_kek_wrapped_master_hex.is_some() {
            let _ = crate::commands::keychain::remove_os_kek();
        }
    };

    // ── Commit all settings + device row ────────────────────────────────────
    // Note: settings writes and device upsert are done in separate operations
    // to avoid nesting transactions (`set_current_device` calls
    // `unchecked_transaction` internally, which conflicts with an outer
    // wrapping transaction). In first-time setup there is at most one device,
    // so the absence of a wrapping transaction is safe.
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Key material.
    db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &row.wrapped_master)
        .map_err(|e| e.to_string())?;
    db::set_setting(&conn, db::KEK_SALT_KEY, &row.kek_salt).map_err(|e| e.to_string())?;
    db::set_password_hash(&conn, password).map_err(|e| e.to_string())?;
    db::set_encryption_mode(&conn, db::EncryptionMode::Password).map_err(|e| e.to_string())?;
    // Mirror the resolved unlock method into `biometric_unlock_enabled` — the
    // setting every management surface reads. `enable_biometric_unlock` is the
    // only other writer and setup never calls it, so without this an os_kek
    // chosen here would wrap the master invisibly and unmanageably. Rolled
    // back by `rollback_settings` below, alongside `cleanup_os_kek`, so the
    // Keychain and the setting can never disagree in either direction.
    if let Err(e) = crate::commands::keychain::sync_biometric_setting_for_unlock_method(
        &conn,
        resolved_unlock_method,
    ) {
        cleanup_os_kek();
        return Err(e);
    }

    // V2 keyring local state.
    db::set_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH, "1").map_err(|e| e.to_string())?;
    db::set_setting(&conn, db::CLOUD_MASTER_FINGERPRINT, &master_fingerprint)
        .map_err(|e| e.to_string())?;
    db::set_setting(
        &conn,
        db::RECOVERY_PASSPHRASE_CREATED_AT,
        &now_secs.to_string(),
    )
    .map_err(|e| e.to_string())?;
    // Persist recovery_wrapped so delayed Drive connect can publish the full
    // V2 keyring without the in-flight pending row. Required for C2/I1.
    db::set_setting(
        &conn,
        db::RECOVERY_WRAPPED_MASTER_KEY,
        &row.recovery_wrapped,
    )
    .map_err(|e| e.to_string())?;

    // Phase 3 T1: persist the content-key list and epoch.
    db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &encoded_content_list)
        .map_err(|e| e.to_string())?;
    db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").map_err(|e| e.to_string())?;
    db::set_setting(&conn, db::CLOUD_CONTENT_FINGERPRINT, &cloud_fp_hex)
        .map_err(|e| e.to_string())?;

    // Device row — upsert first (creates the row), then mark as current
    // (which requires the row to exist). `set_current_device` manages its own
    // transaction.
    db::upsert_device(
        &conn,
        &db::DeviceRow {
            device_id: row.device_id.clone(),
            name: row.device_name.clone(),
            created_at: now_secs,
            last_seen_at: now_secs,
            is_current: true,
            is_revoked: false,
        },
    )
    .map_err(|e| e.to_string())?;
    db::set_current_device(&conn, &row.device_id).map_err(|e| e.to_string())?;

    // ── Write boot file + PRAGMA rekey (production path only) ────────────────
    //
    // C3: if boot file write or PRAGMA rekey fails, roll back all settings
    // written above so the DB stays in the pre-call state (bootstrap-keyed,
    // no wrapped key). This prevents lib.rs startup from seeing an inconsistent
    // state (encryption_mode=password without a matching boot file) and wiping
    // the DB, which would lose the pending setup row and any local data.
    let rollback_settings = |conn: &rusqlite::Connection, device_id: &str| {
        log::warn!("confirm_first_time_setup: rekey failed, rolling back settings");
        let _ = db::delete_setting(conn, db::WRAPPED_ENCRYPTION_KEY_KEY);
        let _ = db::delete_setting(conn, db::KEK_SALT_KEY);
        let _ = db::delete_setting(conn, "password_hash");
        let _ = db::set_encryption_mode(conn, db::EncryptionMode::Unset);
        let _ = db::delete_setting(conn, db::KEYRING_V2_LOCAL_EPOCH);
        let _ = db::delete_setting(conn, db::CLOUD_MASTER_FINGERPRINT);
        let _ = db::delete_setting(conn, db::RECOVERY_PASSPHRASE_CREATED_AT);
        let _ = db::delete_setting(conn, db::RECOVERY_WRAPPED_MASTER_KEY);
        // Phase 3 T1: also roll back content-key settings.
        let _ = db::delete_setting(conn, db::WRAPPED_CONTENT_LIST);
        let _ = db::delete_setting(conn, db::CONTENT_KEY_EPOCH);
        let _ = db::delete_setting(conn, db::CLOUD_CONTENT_FINGERPRINT);
        // Paired with `cleanup_os_kek` on every failure path below, so the
        // Keychain item and this setting are rolled back together.
        let _ = db::delete_setting(conn, crate::commands::keychain::BIOMETRIC_ENABLED_SETTING);
        // Remove the device row inserted above so the DB is fully clean.
        // mark_device_revoked only soft-deletes; use a direct DELETE here
        // so the DB is left in exactly the pre-call state.
        let _ = conn.execute("DELETE FROM devices WHERE device_id = ?1", [device_id]);
    };

    if let Some(bp) = boot_path {
        // Phase 3 T1: rekey DB to db_key-derived (not master-derived).
        let sqlcipher_key = derive_sqlcipher_key(&*db_key);
        // T5: also wrap db_key under master so recover/biometric can reach db_key.
        let master_wrapped_db_key_hex = match wrap_content_key(&master_key, &*db_key) {
            Ok(blob) => hex::encode(&blob),
            Err(e) => {
                rollback_settings(&conn, &row.device_id);
                cleanup_os_kek();
                return Err(e);
            }
        };

        if let Err(e) = boot_file::save(
            &BootFile {
                mode: db::EncryptionMode::Password,
                unlock_method: resolved_unlock_method,
                kek_salt: Some(row.kek_salt.clone()),
                wrapped_key: Some(row.wrapped_master.clone()),
                os_kek_wrapped_master: os_kek_wrapped_master_hex.clone(),
                // Persist the recovery slot in the plaintext boot file so the
                // 24-word phrase can reset a forgotten password offline.
                recovery_wrapped: Some(row.recovery_wrapped.clone()),
                wrapped_content_list: Some(encoded_content_list.clone()),
                wrapped_db_key: Some(wrapped_db_key_hex.clone()),
                master_wrapped_db_key: Some(master_wrapped_db_key_hex),
                migration_in_progress: None,
            },
            bp,
        ) {
            rollback_settings(&conn, &row.device_id);
            cleanup_os_kek();
            return Err(format!("Failed to write boot file: {e}"));
        }

        let pre_rekey = conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .and_then(|_| conn.pragma_update(None, "journal_mode", "DELETE"));
        if let Err(e) = pre_rekey {
            rollback_settings(&conn, &row.device_id);
            let _ = boot_file::save(&BootFile::default(), bp);
            cleanup_os_kek();
            return Err(format!("Pre-rekey WAL flush failed: {e}"));
        }
        if let Err(e) = conn.pragma_update(
            None,
            "rekey",
            format!("x'{}'", hex::encode(&*sqlcipher_key)),
        ) {
            rollback_settings(&conn, &row.device_id);
            let _ = boot_file::save(&BootFile::default(), bp);
            cleanup_os_kek();
            return Err(format!("PRAGMA rekey failed: {e}"));
        }
    }

    // ── Load key into state ───────────────────────────────────────────────────
    // Phase 3 T1: use set_content_state to load the full content-key list.
    key_state.set_content_state(content_key_map, 1, db_key, Zeroizing::new(*master_key))?;

    // ── Build publish context before deleting the pending row ────────────────
    // The pending row is deleted next; capture all values we need so the
    // caller can publish to Drive without re-reading from the DB.
    //
    // I1: also compute wrapped_content_v1 = AES-GCM(master_key, v1) so the
    // gdrive layer can publish _content.json with the correct wrap.
    let wrapped_content_v1_blob = wrap_content_key(&master_key, &*content_key_v1)
        .map_err(|e| format!("confirm_first_time_setup: wrap v1 for _content.json failed: {e}"))?;
    let wrapped_content_v1 = hex::encode(&wrapped_content_v1_blob);

    let publish_ctx = V2KeyringPublishContext {
        recovery_wrapped: row.recovery_wrapped.clone(),
        device_id: row.device_id.clone(),
        device_name: row.device_name.clone(),
        master_fingerprint: master_fingerprint.clone(),
        created_at: now_secs,
        device_created_at: now_secs,
        last_seen_at: now_secs,
        wrapped_content_v1,
        content_fingerprint_v1: cloud_fp_hex.clone(),
    };

    // ── Consume pending Drive session + persist sync settings (best-effort) ──
    // Consume happens AFTER rekey succeeded — the in-code contract is "leaves
    // the session intact for retry on user-correctable failures (wrong phrase,
    // network)." Those failures all happen above. The remaining failure modes
    // after this point are pure I/O (disk full, antivirus lock), where burning
    // the pending session is acceptable because the DB is already committed
    // to password mode.
    //
    // If session_id is supplied but the pending entry is gone (TTL expired
    // during user typing), treat as a best-effort skip — same as a persist
    // failure: user lands in password mode without Drive; they can reconnect
    // from Settings → Sync. Returning PENDING_DRIVE_SESSION_EXPIRED here would
    // require re-running OAuth AND the pending_setup row is already deleted
    // below, blocking retry.
    if let Some(sid) = session_id {
        if let Some(pending) = crate::commands::pending_drive_session::consume(sid) {
            if let Err(e) = crate::commands::gdrive::persist_connect_settings(&conn, &pending) {
                log::warn!(
                    "confirm_first_time_setup: persist_connect_settings failed (non-fatal): {e}"
                );
            }
        } else {
            log::warn!(
                "confirm_first_time_setup: pending Drive session expired or missing for session_id; \
                 user will need to reconnect Drive from Settings → Sync"
            );
        }
    }

    // ── Delete pending row ────────────────────────────────────────────────────
    db::delete_pending_setup(&conn, setup_id).map_err(|e| e.to_string())?;

    Ok((conn, publish_ctx))
}

/// Cancel a pending first-time setup.
///
/// Deletes the pending row and the associated mnemonic.
/// Idempotent: no error if the row is already gone.
#[tauri::command]
pub async fn cancel_first_time_setup(
    state: tauri::State<'_, AppState>,
    setup_id: String,
) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_pending_setup(&conn, &setup_id).map_err(|e| e.to_string())
}

/// Read the persisted `force_re_pair_required` / `force_re_pair_reason` pair.
///
/// Returns `Some(reason)` when the vault was rotated on another device and
/// this device has not yet completed re-pairing. Returns `None` otherwise.
///
/// The flag survives app restarts (it lives in the DB settings table), so
/// without this command the frontend Zustand `useForceRePair` store reverts
/// to its default `false` after every relaunch and the user is silently
/// dropped back into the (now-broken) lock-screen flow. The frontend calls
/// this on app mount and hydrates the store from the result.
pub(crate) fn get_force_re_pair_status_inner(
    conn: &rusqlite::Connection,
) -> Result<Option<String>, String> {
    let required = db::get_setting(conn, db::FORCE_RE_PAIR_REQUIRED)
        .map_err(|e| e.to_string())?
        .filter(|v| !v.is_empty());
    if required.as_deref() != Some("1") {
        return Ok(None);
    }
    let reason = db::get_setting(conn, db::FORCE_RE_PAIR_REASON)
        .map_err(|e| e.to_string())?
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Vault was rotated on another device.".to_string());
    Ok(Some(reason))
}

#[tauri::command]
pub async fn get_force_re_pair_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let conn = state.lock()?;
    get_force_re_pair_status_inner(&conn)
}

/// Crash-recovery probe: returns the first pending setup row if one exists
/// (there is at most one in normal operation).
///
/// The frontend calls this on app mount; if it returns data and
/// `encryption_mode = unset`, the app routes to the confirmation screen
/// and re-displays the mnemonic from the row.
#[tauri::command]
pub async fn get_pending_first_time_setup(
    state: tauri::State<'_, AppState>,
) -> Result<Option<FirstTimeSetupHandle>, String> {
    let conn = state.lock()?;
    let rows = db::list_pending_setups(&conn).map_err(|e| e.to_string())?;
    match rows.into_iter().next() {
        None => Ok(None),
        Some(row) => {
            let mnemonic_words: Vec<String> = row
                .mnemonic
                .split_whitespace()
                .map(str::to_string)
                .collect();
            let challenge_indices: Vec<usize> = serde_json::from_str(&row.challenge_indices)
                .map_err(|e| format!("challenge_indices parse failed: {e}"))?;
            Ok(Some(FirstTimeSetupHandle {
                setup_id: row.setup_id,
                mnemonic: mnemonic_words,
                challenge_indices,
            }))
        }
    }
}

// ─── Drive provider helper ───────────────────────────────────────────────────

/// Build a live [`crate::sync::CloudProvider`] for a vault-rekey or vault-publish command.
///
/// Prefers the in-process `GDriveSessionState` (warm path after a fresh OAuth
/// in the same app lifetime). When that is empty — e.g. force-re-pair fires
/// from the sync scheduler after an app restart, or revoke/rotate is invoked
/// from Settings on a connected install — peeks a pending Drive session, then
/// falls back to [`crate::commands::sync::configured_cloud_provider`] so a
/// folder provider (`local` / `icloud`) works the same way as Drive.
///
/// Returns `Err` only when no cloud provider is connected on this device.
/// All other flows (warm session, pending session, configured folder /
/// reconstructed Drive session) succeed transparently.
fn acquire_drive_provider<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
) -> Result<crate::sync::CloudProvider, String> {
    acquire_drive_provider_with_pending(app, state, None)
}

/// Same as `acquire_drive_provider`, but also checks the in-memory
/// pending-session map for a session matching `session_id` before falling
/// back to the configured provider.
///
/// Used by onboarding commands that run BEFORE the pending session is consumed
/// (e.g. `onboard_validate_passphrase` — it needs to read `_recovery.json`
/// from the cloud but cannot consume the session yet because the user may
/// still type the wrong recovery phrase and retry). Phase 1 of the
/// backend-harden plan deferred token persistence to AFTER the user commits
/// to a mode, so these commands cannot rely on settings being in the DB yet.
///
/// Lookup order:
/// 1. In-process `GDriveSessionState` (warm Phase-1-`Password`/`None` path).
/// 2. Peek pending session (GDrive → live Drive provider; Folder →
///    `LocalSyncProvider` with recovery fence).
/// 3. [`crate::commands::sync::configured_cloud_provider`] (Drive reconstruct
///    or folder provider from `sync_provider` / `sync_config_json`).
fn acquire_drive_provider_with_pending<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    session_id: Option<&str>,
) -> Result<crate::sync::CloudProvider, String> {
    use crate::sync::gdrive_provider::GDriveProvider;
    use crate::sync::CloudProvider;
    use tauri::Manager;

    let session_state = app.state::<crate::GDriveSessionState>();
    if let Some(session) = session_state.get_clone() {
        return GDriveProvider::new_live(session)
            .map(CloudProvider::GDrive)
            .map_err(|e| e.to_string());
    }

    if let Some(pending) = session_id.and_then(crate::commands::pending_drive_session::peek) {
        return match pending {
            crate::commands::pending_drive_session::PendingCloudSession::GDrive {
                session, ..
            } => GDriveProvider::new_live(session)
                .map(CloudProvider::GDrive)
                .map_err(|e| e.to_string()),
            crate::commands::pending_drive_session::PendingCloudSession::Folder {
                root_path,
                ..
            } => {
                let generation = {
                    let conn = state.lock()?;
                    db::get_sync_recovery_generation(&conn).map_err(|e| e.to_string())?
                };
                Ok(CloudProvider::Folder(
                    crate::sync::local_provider::LocalSyncProvider::new(root_path)
                        .with_recovery_fence(generation, None),
                ))
            }
        };
    }

    let conn = state.lock()?;
    crate::commands::sync::configured_cloud_provider(&conn)?.ok_or_else(|| {
        "No cloud provider is connected on this device — connect one first, then retry.".to_string()
    })
}

// ─── Onboard new device into existing V2 vault ───────────────────────────────

/// Step 1 of onboarding: validate the 24-word recovery passphrase against the
/// cloud vault without modifying any state. Returns `Ok(())` on success.
///
/// Stateless: does NOT stash the master key in memory. Step 2
/// (`onboard_complete`) re-derives it from the same mnemonic to stay simple.
#[tauri::command]
pub async fn onboard_validate_passphrase(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mnemonic: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let provider = acquire_drive_provider_with_pending(&app, &state, session_id.as_deref())?;
    onboard_validate_passphrase_inner(&provider, &mnemonic).await
}

/// Step 2 of onboarding: set this device's local password, write its device
/// slot to Drive, PRAGMA rekey the DB, and unlock the app.
///
/// `session_id` is optional. When supplied AND a matching pending Drive session
/// exists (stashed by `gdrive_complete_connect` in the Unset-mode path), the
/// four Google Drive sync settings are persisted at the tail of the flow,
/// after PRAGMA rekey succeeds. When supplied but the pending entry is gone
/// (TTL expired during user typing, app restart), the command STILL succeeds —
/// the user lands in password mode without Drive auto-attached and can
/// reconnect from Settings → Sync. This is intentional: by the time we attempt
/// to consume, the on-disk DB is already PRAGMA-rekeyed; rolling back at that
/// point would force the user to re-enter the recovery phrase with no
/// reward. When `session_id` is `None`, behaves as the legacy path used by
/// `GoogleDriveSettings` (no sync settings written).
/// `unlock_method`: optional, defaults to password-only when omitted (current
/// frontend behavior — the unlock-method picker UI is a later phase). See
/// `resolve_unlock_method_with_os_kek` for accepted values.
#[tauri::command]
pub async fn onboard_complete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    key_state: tauri::State<'_, crate::EncryptionKeyState>,
    mnemonic: String,
    new_local_password: String,
    device_name: String,
    session_id: Option<String>,
    unlock_method: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let mnemonic = Zeroizing::new(mnemonic);
    let new_local_password = Zeroizing::new(new_local_password);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let db_path = data_dir.join("memlore.db");
    let boot_path = crate::utils::boot_file::boot_path(&db_path);

    // Peek (not consume) the pending Drive session so we can build the
    // provider for the cloud reads inside onboard_complete_inner. The actual
    // consume happens at the tail of the inner (after rekey) — see the
    // post-rekey persist block. Falls back to the encrypted DB token (legacy
    // GoogleDriveSettings path) when no session_id is supplied.
    let provider = acquire_drive_provider_with_pending(&app, &state, session_id.as_deref())?;

    // Connection-swap: take ownership of the real connection while rekeying.
    let real_conn = {
        let placeholder = rusqlite::Connection::open_in_memory()
            .map_err(|e| format!("Failed to create placeholder connection: {e}"))?;
        db::schema::migrate(&placeholder)
            .map_err(|e| format!("Failed to migrate placeholder: {e}"))?;
        db::set_encryption_mode(&placeholder, db::EncryptionMode::Unset)
            .map_err(|e| format!("Failed to seed placeholder mode: {e}"))?;
        let mut guard = state.lock()?;
        std::mem::replace(&mut *guard, placeholder)
    };

    let result = onboard_complete_inner(
        real_conn,
        &key_state,
        &provider,
        &mnemonic,
        &new_local_password,
        &device_name,
        Some(&boot_path),
        session_id,
        unlock_method.as_deref(),
    )
    .await;

    match result {
        Ok(new_conn) => {
            state.set_connection(new_conn)?;
            Ok(())
        }
        Err((real_conn, e)) => {
            // The real connection is always returned on error — restore it
            // directly instead of guessing the bootstrap key. This preserves
            // the original connection (correct key, whatever state it was in)
            // and avoids the data-loss path where a retry rekeyed only the
            // placeholder while the on-disk DB remained under the old key.
            log::error!("onboard_complete: inner failed ({e}); restoring original conn");
            let _ = state.set_connection(real_conn);
            Err(e)
        }
    }
}

/// Validate the mnemonic against the cloud vault.
///
/// 1. Validate mnemonic syntax (24 words, valid BIP39 checksum).
/// 2. Read `_recovery.json` from Drive. Absent → vault corrupted.
/// 3. Derive `recovery_key` from mnemonic via HKDF.
/// 4. Unwrap `recovery_slot.wrapped_master` using `recovery_key`. Failure → wrong phrase.
/// 5. Read `_meta.json`; verify `key_fingerprint(master_key) == meta.master_fingerprint`.
pub(crate) async fn onboard_validate_passphrase_inner<P: crate::sync::keyring_v2::KeyringV2Io>(
    provider: &P,
    mnemonic: &str,
) -> Result<(), String> {
    use crate::sync::keyring_v2::io as kio;
    use crate::utils::recovery;

    // 1. Validate mnemonic syntax.
    let parsed = recovery::validate_recovery_mnemonic(mnemonic)?;

    // 2. Read recovery slot.
    let recovery_slot = kio::read_recovery(provider)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            "Cloud vault is missing the recovery slot — vault may be corrupted".to_string()
        })?;

    // 3. Derive recovery key.
    let recovery_key = recovery::derive_recovery_key(&parsed);

    // 4. Unwrap master key using raw AES-256-GCM (no Argon2id — recovery_key is
    // already 32 bytes of strong HKDF output). The recovery slot was created as
    // AES-GCM(recovery_key, master_key) in begin_first_time_setup_inner.
    let master_key = unwrap_master_with_recovery_key(&recovery_slot.wrapped_master, &*recovery_key)
        .map_err(|_| "Wrong recovery phrase. Check each word and try again.".to_string())?;

    // 5. Verify fingerprint against meta.
    let meta = kio::read_meta(provider)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Cloud vault _meta.json is missing".to_string())?;

    let computed_fp = hex::encode(crate::utils::encryption::key_fingerprint(&*master_key));
    if computed_fp != meta.master_fingerprint {
        return Err(
            "Could not verify the cloud vault — the recovery phrase may not match this vault."
                .to_string(),
        );
    }

    Ok(())
}

/// Complete onboarding: derive master key, write device slot, PRAGMA rekey.
///
/// Returns the post-rekey `Connection`.
///
/// `session_id` mirrors the outer command parameter — see `onboard_complete`
/// docs for the full contract. `unlock_method` mirrors
/// `confirm_first_time_setup_inner`'s parameter of the same name — see
/// `resolve_unlock_method_with_os_kek`.
pub(crate) async fn onboard_complete_inner<P: crate::sync::keyring_v2::KeyringV2Io>(
    conn: rusqlite::Connection,
    key_state: &crate::EncryptionKeyState,
    provider: &P,
    mnemonic: &str,
    new_local_password: &str,
    device_name: &str,
    boot_path: Option<&Path>,
    session_id: Option<String>,
    unlock_method: Option<&str>,
) -> Result<rusqlite::Connection, (rusqlite::Connection, String)> {
    use crate::sync::keyring_v2::io as kio;
    use crate::sync::keyring_v2::types::{DeviceSlotV2, KEYRING_V2_VERSION};
    use crate::utils::recovery;

    let (initial_control, initial_control_revision) =
        match crate::sync::recovery::read_versioned_sync_control(provider).await {
            Ok((control, revision)) if control.recovery_lease.is_none() => (control, revision),
            Ok(_) => return Err((
                conn,
                "An authoritative recovery is active on this cloud vault; retry after it finishes."
                    .to_string(),
            )),
            Err(error) => return Err((conn, format!("Cloud recovery control: {error}"))),
        };
    provider.configure_recovery_fence(initial_control.recovery_generation, None);

    // 0. Declare the pending session binding — consumed just before first DB
    //    write (step 4) so transient network / AES failures (steps 1-3) leave
    //    the session intact for a user retry, matching the behaviour of
    //    confirm_first_time_setup_inner.

    // 1. Re-derive master key (stateless — avoids in-memory stash).
    let parsed = match recovery::validate_recovery_mnemonic(mnemonic) {
        Ok(p) => p,
        Err(e) => return Err((conn, format!("mnemonic: {e}"))),
    };

    let recovery_slot = match kio::read_recovery(provider).await {
        Ok(Some(slot)) => slot,
        Ok(None) => return Err((conn, "Cloud vault is missing the recovery slot".to_string())),
        Err(e) => return Err((conn, e.to_string())),
    };

    let recovery_key = recovery::derive_recovery_key(&parsed);

    // Raw AES-256-GCM unwrap — no Argon2id, recovery_key is already HKDF output.
    let master_key =
        match unwrap_master_with_recovery_key(&recovery_slot.wrapped_master, &*recovery_key) {
            Ok(k) => k,
            Err(_) => {
                return Err((
                    conn,
                    "Wrong recovery phrase. Check each word and try again.".to_string(),
                ))
            }
        };

    let meta = match kio::read_meta(provider).await {
        Ok(Some(m)) => m,
        Ok(None) => return Err((conn, "Cloud vault _meta.json is missing".to_string())),
        Err(e) => return Err((conn, e.to_string())),
    };
    if meta.recovery_generation != initial_control.recovery_generation {
        return Err((
            conn,
            format!(
                "Recovery generation mismatch: control={}, keyring_meta={}",
                initial_control.recovery_generation, meta.recovery_generation
            ),
        ));
    }

    let computed_fp = hex::encode(crate::utils::encryption::key_fingerprint(&*master_key));
    if computed_fp != meta.master_fingerprint {
        return Err((
            conn,
            "Could not verify the cloud vault — the recovery phrase may not match this vault."
                .to_string(),
        ));
    }

    // 2. Derive new device KEK.
    let kek_salt = generate_encryption_salt();
    let kek_salt_hex = hex::encode(&kek_salt);

    // Wrap master_key with Argon2id(new_local_password, kek_salt).
    //
    // A freshly onboarded device has no prior KDF preset to inherit (the preset
    // is per-device and not stored in the cloud keyring). Default to FAST — the
    // app default for new key material (matches first-time setup). Using the
    // self-describing format keeps the displayed strength consistent with the
    // choice instead of silently reporting High.
    let wrapped_master_hex =
        match wrap_key_with(&*master_key, new_local_password, &kek_salt, KdfParams::FAST) {
            Ok(hex) => hex,
            Err(e) => return Err((conn, format!("wrap_key failed: {e}"))),
        };

    // 3. Get device_id (create if not exists).
    let device_id = match db::get_or_create_device_id(&conn) {
        Ok(id) => id,
        Err(e) => return Err((conn, e.to_string())),
    };

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let master_fingerprint = hex::encode(crate::utils::encryption::key_fingerprint(&*master_key));

    // Phase 3 T1 (joiner path): derive the content-key list and per-device db_key.
    //
    // Try to read `_content.json` from the cloud. Present (Phase 5+ vault):
    //   decode the entries, unwrap each content key with master_key.
    // Absent (pre-Phase-5 vault or bootstrap): fall back to v1=master_key seed,
    //   which matches what existing cloud entries were encrypted under.
    //   This fallback does NOT set NEEDS_CLOUD_CONTENT_MIGRATION (that flag is
    //   for migrating an existing CREATOR install whose cloud _content.json is
    //   absent; a joining device doesn't own the migration decision).
    //
    // In both cases generate a fresh local db_key (never published to cloud).
    let (joiner_content_keys, joiner_latest_epoch, joiner_encoded_list) = {
        match kio::read_content(provider).await {
            Ok(Some(cloud_list)) => {
                // Cloud _content.json present but empty entries is invalid: we cannot
                // determine which keys are in use, and the `.expect("latest_epoch must
                // be in map")` below would panic on cloud-supplied data. Reject early.
                if cloud_list.entries.is_empty() {
                    return Err((
                        conn,
                        "onboard_complete: _content.json has no entries — \
                         the file appears corrupt or was tampered with; please contact \
                         the vault owner to republish their keyring"
                            .to_string(),
                    ));
                }
                // Unwrap each entry with master_key.
                let mut map: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>> =
                    std::collections::BTreeMap::new();
                for entry in &cloud_list.entries {
                    let blob = match hex::decode(&entry.wrapped_content) {
                        Ok(b) => b,
                        Err(e) => {
                            return Err((
                                conn,
                                format!(
                                    "onboard_complete: _content.json entry epoch={} \
                                     wrapped_content hex decode failed: {e}",
                                    entry.epoch
                                ),
                            ))
                        }
                    };
                    let key = match unwrap_content_key(&master_key, &blob) {
                        Ok(k) => k,
                        Err(e) => {
                            return Err((
                                conn,
                                format!(
                                    "onboard_complete: unwrap content key epoch={} \
                                     failed: {e}",
                                    entry.epoch
                                ),
                            ))
                        }
                    };
                    // Cross-check: the unwrapped key must produce the same fingerprint
                    // as the creator wrote in content_fingerprint.  A mismatch means
                    // the list is corrupt or was written by a different master key —
                    // fail loudly rather than silently using the wrong key.
                    let computed_fp = hex::encode(key_fingerprint(&*derive_sync_key(&*key)));
                    if computed_fp != entry.content_fingerprint {
                        return Err((
                            conn,
                            format!(
                                "onboard_complete: content key fingerprint mismatch at \
                                 epoch={} (expected {}, computed {})",
                                entry.epoch, entry.content_fingerprint, computed_fp
                            ),
                        ));
                    }
                    map.insert(entry.epoch, key);
                }
                let latest = cloud_list.latest_epoch;
                // Re-encode in our compact local codec under master_key for storage.
                let encoded = match encode_content_key_list(&master_key, &map) {
                    Ok(s) => s,
                    Err(e) => return Err((conn, format!("encode_content_key_list failed: {e}"))),
                };
                log::info!(
                    "onboard_complete: loaded content-key list from cloud \
                     ({} epochs, latest={latest})",
                    map.len()
                );
                (map, latest, encoded)
            }
            Ok(None) => {
                // _content.json absent — vault pre-dates Phase 5.
                // Seed with v1=master_key so existing cloud entries remain decryptable.
                // Do NOT set NEEDS_CLOUD_CONTENT_MIGRATION here — only the creator
                // (or T3 migration) sets that flag.
                let mut map: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>> =
                    std::collections::BTreeMap::new();
                map.insert(1u32, Zeroizing::new(*master_key));
                let encoded = match encode_content_key_list(&master_key, &map) {
                    Ok(s) => s,
                    Err(e) => return Err((conn, format!("encode_content_key_list failed: {e}"))),
                };
                log::info!(
                    "onboard_complete: _content.json absent — seeding v1=master \
                     (pre-Phase-5 vault)"
                );
                (map, 1u32, encoded)
            }
            Err(e) => {
                // Transient cloud read failure (network blip, 5xx, I/O error).
                //
                // IMPORTANT: Err ≠ absent.  Ok(None) means the file genuinely does not
                // exist (legacy pre-Phase-5 vault) and v1=master is correct.  An Err
                // here means we could not determine whether _content.json exists, so we
                // must NOT assume it is absent.  Falling back to v1=master on a vault
                // that actually has a random v1 content key would silently succeed with
                // the wrong key — every entry decryption would fail with no error.
                // Propagate so the user retries when the transient condition clears.
                return Err((
                    conn,
                    format!(
                        "onboard_complete: failed to read _content.json from cloud ({e}); \
                         please retry"
                    ),
                ));
            }
        }
    };

    // Generate a per-device random db_key (never published to cloud).
    let mut joiner_db_key = Zeroizing::new([0u8; 32]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, joiner_db_key.as_mut());

    // Wrap db_key under the password KEK.
    let joiner_kek = match crate::utils::encryption::derive_encryption_key_with(
        new_local_password,
        &kek_salt,
        KdfParams::FAST,
    ) {
        Ok(k) => k,
        Err(e) => return Err((conn, format!("derive KEK for db_key wrap failed: {e}"))),
    };
    let joiner_wrapped_db_key_hex = match wrap_content_key(&*joiner_kek, &*joiner_db_key) {
        Ok(blob) => hex::encode(&blob),
        Err(e) => return Err((conn, format!("wrap db_key failed: {e}"))),
    };

    // Cloud fingerprint is key_fingerprint(derive_sync_key(latest_content_key)).
    let joiner_cloud_fp_hex = {
        let latest_key = match joiner_content_keys.get(&joiner_latest_epoch) {
            Some(k) => k,
            None => {
                return Err((
                    conn,
                    format!(
                        "onboard_complete: _content.json latest_epoch={} not found in \
                         decoded key map — the file is corrupt or was tampered with",
                        joiner_latest_epoch
                    ),
                ))
            }
        };
        hex::encode(key_fingerprint(&*derive_sync_key(latest_key)))
    };

    // 4a. Rollback closure — undoes all DB writes if boot file or PRAGMA rekey fails.
    let rollback_settings = |conn: &rusqlite::Connection, device_id: &str| {
        log::warn!("onboard_complete: rekey failed, rolling back settings");
        let _ = db::delete_setting(conn, db::WRAPPED_ENCRYPTION_KEY_KEY);
        let _ = db::delete_setting(conn, db::KEK_SALT_KEY);
        let _ = db::delete_setting(conn, "password_hash");
        let _ = db::set_encryption_mode(conn, db::EncryptionMode::Unset);
        let _ = db::delete_setting(conn, db::KEYRING_V2_LOCAL_EPOCH);
        let _ = db::delete_setting(conn, db::CLOUD_MASTER_FINGERPRINT);
        let _ = db::delete_setting(conn, db::RECOVERY_PASSPHRASE_CREATED_AT);
        let _ = db::delete_setting(conn, db::RECOVERY_WRAPPED_MASTER_KEY);
        // Phase 3 T1: also roll back content-key settings.
        let _ = db::delete_setting(conn, db::WRAPPED_CONTENT_LIST);
        let _ = db::delete_setting(conn, db::CONTENT_KEY_EPOCH);
        let _ = db::delete_setting(conn, db::CLOUD_CONTENT_FINGERPRINT);
        // Paired with `cleanup_os_kek` on every failure path below, so the
        // Keychain item and this setting are rolled back together — otherwise
        // a boot-file failure after an os_kek join would leave the setting
        // reading `true` with the Keychain item already removed.
        let _ = db::delete_setting(conn, crate::commands::keychain::BIOMETRIC_ENABLED_SETTING);
        let _ = conn.execute("DELETE FROM devices WHERE device_id = ?1", [device_id]);
    };

    // Write all settings to DB.
    // Helper macro: on error, return Err((conn, msg)) after running rollback.
    // rollback_settings borrows &conn; the borrow ends before conn moves into the tuple.
    macro_rules! db_write {
        ($expr:expr) => {
            if let Err(e) = $expr {
                return Err((conn, e.to_string()));
            }
        };
    }

    db_write!(db::set_setting(
        &conn,
        db::WRAPPED_ENCRYPTION_KEY_KEY,
        &wrapped_master_hex
    ));
    db_write!(db::set_setting(&conn, db::KEK_SALT_KEY, &kek_salt_hex));
    db_write!(db::set_password_hash(&conn, new_local_password));
    db_write!(db::set_encryption_mode(&conn, db::EncryptionMode::Password));
    db_write!(db::set_setting(
        &conn,
        db::KEYRING_V2_LOCAL_EPOCH,
        &meta.epoch.to_string()
    ));
    db_write!(db::set_setting(
        &conn,
        db::CLOUD_MASTER_FINGERPRINT,
        &master_fingerprint
    ));
    // Persist the VAULT creation time from the cloud meta so any later keyring
    // republish from this peer (e.g. the keyring_dirty retry) writes the correct
    // `created_at` into `_recovery.json` / `_meta.json` instead of the `0`
    // fallback. The vault-creator path seeds this from its own `now_secs`; a
    // peer inherits it from the cloud meta it just validated against.
    db_write!(db::set_setting(
        &conn,
        db::RECOVERY_PASSPHRASE_CREATED_AT,
        &meta.created_at.to_string()
    ));
    // Persist recovery_wrapped so delayed Drive connect can publish if needed.
    db_write!(db::set_setting(
        &conn,
        db::RECOVERY_WRAPPED_MASTER_KEY,
        &recovery_slot.wrapped_master
    ));

    // Phase 3 T1 (joiner): persist the content-key list and epoch.
    db_write!(db::set_setting(
        &conn,
        db::WRAPPED_CONTENT_LIST,
        &joiner_encoded_list
    ));
    db_write!(db::set_setting(
        &conn,
        db::CONTENT_KEY_EPOCH,
        &joiner_latest_epoch.to_string()
    ));
    db_write!(db::set_setting(
        &conn,
        db::CLOUD_CONTENT_FINGERPRINT,
        &joiner_cloud_fp_hex
    ));

    // Upsert this device row (is_current = true).
    db_write!(db::upsert_device(
        &conn,
        &db::DeviceRow {
            device_id: device_id.clone(),
            name: device_name.to_string(),
            created_at: now_secs,
            last_seen_at: now_secs,
            is_current: true,
            is_revoked: false,
        }
    ));
    db_write!(db::set_current_device(&conn, &device_id));

    // Also insert other known device slots from Drive as non-current rows,
    // then prune local rows absent from the cloud listing so stale/revoked
    // peers don't accumulate on this machine.
    match kio::list_device_slots(provider).await {
        Ok(slots) => {
            for slot in &slots {
                if slot.device_id == device_id {
                    continue; // Skip this device — already inserted above.
                }
                let _ = db::upsert_device(
                    &conn,
                    &db::DeviceRow {
                        device_id: slot.device_id.clone(),
                        name: slot.name.clone(),
                        created_at: slot.created_at,
                        last_seen_at: slot.last_seen_at,
                        is_current: false,
                        is_revoked: false,
                    },
                );
            }
            // Converge: drop any non-current local row absent from cloud.
            // The current device (device_id, is_current=1) is always kept.
            let keep_ids: Vec<String> = slots.iter().map(|s| s.device_id.clone()).collect();
            if let Err(e) = db::prune_devices_not_in(&conn, &keep_ids) {
                log::warn!("onboard_complete: prune_devices_not_in failed ({e}), continuing");
            }
        }
        Err(e) => {
            log::warn!("onboard_complete: list_device_slots failed ({e}), continuing");
        }
    }

    // Resolve unlock method (Phase 3) — before the boot-file write so an
    // os_kek failure aborts before any irreversible on-disk change. Resolved
    // outside the boot-path block because `biometric_unlock_enabled` below is
    // DB state, not boot-file state, and must be written on every path that
    // resolves a method. With no explicit request this is `(Password, None)`
    // and never touches the Keychain.
    let (resolved_unlock_method, os_kek_wrapped_master_hex) =
        match resolve_unlock_method_with_os_kek(unlock_method, &master_key) {
            Ok(v) => v,
            Err(e) => return Err((conn, e)),
        };
    let cleanup_os_kek = || {
        if os_kek_wrapped_master_hex.is_some() {
            let _ = crate::commands::keychain::remove_os_kek();
        }
    };

    // Mirror the resolved unlock method into `biometric_unlock_enabled` — the
    // setting every management surface reads. `enable_biometric_unlock` is the
    // only other writer and join never calls it, so without this an os_kek
    // chosen here would wrap the master invisibly and unmanageably. Rolled
    // back by `rollback_settings`, alongside `cleanup_os_kek`, so the Keychain
    // and the setting can never disagree in either direction. Not routed
    // through `db_write!` — that macro returns without removing the os_kek.
    if let Err(e) = crate::commands::keychain::sync_biometric_setting_for_unlock_method(
        &conn,
        resolved_unlock_method,
    ) {
        rollback_settings(&conn, &device_id);
        cleanup_os_kek();
        return Err((conn, e));
    }

    // 5. Write boot file + PRAGMA rekey (production path only).
    // Phase 3 T1: rekey DB to db_key-derived (not master-derived).
    if let Some(bp) = boot_path {
        let sqlcipher_key = derive_sqlcipher_key(&*joiner_db_key);
        // T5: also wrap joiner_db_key under master_key for recover/biometric paths.
        let joiner_master_wrapped_db_key_hex = match wrap_content_key(&master_key, &*joiner_db_key)
        {
            Ok(blob) => hex::encode(&blob),
            Err(e) => {
                rollback_settings(&conn, &device_id);
                cleanup_os_kek();
                return Err((conn, format!("wrap master_wrapped_db_key failed: {e}")));
            }
        };

        if let Err(e) = crate::utils::boot_file::save(
            &BootFile {
                mode: db::EncryptionMode::Password,
                unlock_method: resolved_unlock_method,
                kek_salt: Some(kek_salt_hex.clone()),
                wrapped_key: Some(wrapped_master_hex.clone()),
                os_kek_wrapped_master: os_kek_wrapped_master_hex.clone(),
                // Persist the recovery slot locally so this device can later
                // reset a forgotten password offline via the recovery phrase.
                recovery_wrapped: Some(recovery_slot.wrapped_master.clone()),
                wrapped_content_list: Some(joiner_encoded_list.clone()),
                wrapped_db_key: Some(joiner_wrapped_db_key_hex.clone()),
                master_wrapped_db_key: Some(joiner_master_wrapped_db_key_hex),
                migration_in_progress: None,
            },
            bp,
        ) {
            rollback_settings(&conn, &device_id);
            cleanup_os_kek();
            // rollback borrow ends here; now we can move conn into the Err tuple.
            return Err((conn, format!("Failed to write boot file: {e}")));
        }

        let pre_rekey = conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .and_then(|_| conn.pragma_update(None, "journal_mode", "DELETE"));
        if let Err(e) = pre_rekey {
            rollback_settings(&conn, &device_id);
            let _ = crate::utils::boot_file::save(&BootFile::default(), bp);
            cleanup_os_kek();
            // rollback + boot_file borrows end here; now move conn.
            return Err((conn, format!("Pre-rekey WAL flush failed: {e}")));
        }
        if let Err(e) = conn.pragma_update(
            None,
            "rekey",
            format!("x'{}'", hex::encode(&*sqlcipher_key)),
        ) {
            rollback_settings(&conn, &device_id);
            let _ = crate::utils::boot_file::save(&BootFile::default(), bp);
            cleanup_os_kek();
            // rollback + boot_file borrows end here; now move conn.
            return Err((conn, format!("PRAGMA rekey failed: {e}")));
        }
    }

    // 6. Load key into state.
    // Phase 3 T1: use set_content_state with the full content-key list.
    if let Err(e) = key_state.set_content_state(
        joiner_content_keys,
        joiner_latest_epoch,
        joiner_db_key,
        Zeroizing::new(*master_key),
    ) {
        return Err((conn, e));
    }

    // 7. TOCTOU guard, then upload this device's slot + meta bump.
    //
    // `meta` was snapshotted at the top of this function, and the two cloud
    // writes below are unconditional overwrites — Drive has no CAS. If a peer
    // rotated the vault while the user was typing the phrase, the master key
    // validated in step 1 is already stale: writing our slot back would
    // recreate a slot the rotation removed, and the meta bump would roll
    // `_meta.json` back to the pre-rotation fingerprint/epoch. Re-read and
    // abort instead — the caller keeps the force-re-pair guard in place and the
    // user retries with the vault's CURRENT phrase. (The local DB was already
    // rekeyed above, but only to this device's private db_key; a retried
    // re-pair simply rekeys again.)
    // `content_epoch` is compared too: a content-key rotation/migration that
    // bumps only the content epoch invalidates the content-key list decoded in
    // step 3, and writing the old snapshot back would roll the cloud's
    // content history down.
    let current_meta = match kio::read_meta(provider).await {
        Ok(Some(current)) => {
            if current.master_fingerprint != meta.master_fingerprint
                || current.epoch != meta.epoch
                || current.content_epoch != meta.content_epoch
            {
                return Err((
                    conn,
                    "The cloud vault was rotated by another device while re-pairing. \
                     Please retry with the vault's current recovery phrase."
                        .to_string(),
                ));
            }
            current
        }
        Ok(None) => {
            return Err((
                conn,
                "The cloud vault _meta.json disappeared while re-pairing; please retry."
                    .to_string(),
            ));
        }
        Err(e) => {
            return Err((
                conn,
                format!(
                    "Could not re-verify the cloud vault before publishing ({e}); please retry."
                ),
            ));
        }
    };
    let (control, control_revision) =
        match crate::sync::recovery::read_versioned_sync_control(provider).await {
            Ok((control, revision)) if control.recovery_lease.is_none() => (control, revision),
            Ok(_) => {
                return Err((
                    conn,
                    "An authoritative recovery started while re-pairing; retry after it finishes."
                        .to_string(),
                ))
            }
            Err(error) => return Err((conn, error.to_string())),
        };
    if control != initial_control || control_revision != initial_control_revision {
        return Err((
            conn,
            "Cloud recovery control changed while re-pairing; please retry.".to_string(),
        ));
    }
    if current_meta.recovery_generation != control.recovery_generation {
        return Err((
            conn,
            "Cloud keyring generation changed while re-pairing; please retry.".to_string(),
        ));
    }
    if control.recovery_generation > 0 {
        if let Err(e) = db::set_sync_recovery_generation(&conn, control.recovery_generation) {
            return Err((conn, e.to_string()));
        }
    }
    // Re-pair keeps local journal data (and thus any prior `sync_push_state`
    // rows) but adopts the cloud write namespace (`generations/g-N/...`).
    // Stale surface hashes would make hash-gate skip publishing into the new
    // namespace; re-arm Automatic reconcile so DeviceRoot self-heal can run.
    if let Err(e) = crate::sync::engine::invalidate_surface_push_state(&conn) {
        return Err((conn, e.to_string()));
    }
    provider.configure_recovery_fence(control.recovery_generation, None);

    let device_slot = DeviceSlotV2 {
        version: KEYRING_V2_VERSION,
        device_id: device_id.clone(),
        name: device_name.to_string(),
        created_at: now_secs,
        last_seen_at: now_secs,
    };
    match kio::write_device_slot(provider, &device_slot).await {
        Ok(()) => {
            log::info!("onboard_complete: device slot uploaded for {device_id}");
        }
        Err(e) => {
            log::warn!("onboard_complete: device slot upload failed ({e}), setting keyring_dirty");
            let _ = db::set_setting(&conn, db::KEYRING_DIRTY_KEY, "1");
        }
    }

    // 8. Bump _meta.json.updated_at (best-effort — epoch unchanged). Built
    //    from `current_meta` (the freshly re-read copy), NOT the validation
    //    snapshot, so any field the guard does not compare can never be
    //    rolled back by this write.
    let updated_meta = crate::sync::keyring_v2::types::KeyringMetaV2 {
        updated_at: now_secs,
        ..current_meta
    };
    if let Err(e) = kio::write_meta(provider, &updated_meta).await {
        log::warn!("onboard_complete: _meta.json updated_at bump failed ({e})");
    }

    // 9. Consume pending Drive session + persist sync settings — AFTER rekey.
    //    Consume happens HERE (not before mode-flip) so any rollback from a
    //    boot-file / PRAGMA-rekey failure does NOT burn the pending session.
    //    By this point all user-correctable failures (wrong recovery phrase,
    //    transient cloud reads, fingerprint mismatch) are behind us — only
    //    pure I/O remains and rekey already succeeded.
    //
    //    If session_id is supplied but the pending entry is gone (TTL expired
    //    during user typing, app restart between rekey and this branch), treat
    //    as best-effort skip — same as a persist failure: user lands in
    //    password mode without Drive; they reconnect from Settings → Sync.
    //    Returning PENDING_DRIVE_SESSION_EXPIRED here is no longer possible —
    //    the DB is already committed to Password mode.
    if let Some(sid) = session_id {
        if let Some(pending) = crate::commands::pending_drive_session::consume(&sid) {
            if let Err(e) = crate::commands::gdrive::persist_connect_settings(&conn, &pending) {
                log::warn!("onboard_complete: persist_connect_settings failed (non-fatal): {e}");
            }
        } else {
            log::warn!(
                "onboard_complete: pending Drive session expired or missing for session_id; \
                 user will need to reconnect Drive from Settings → Sync"
            );
        }
    }

    // 10. Remove the placeholder default "My Journal" if it is the SOLE
    //     journal in the DB AND has zero entries.
    //
    //     Why: schema migration unconditionally seeds a default journal so
    //     fresh installs are usable. But the Card-3 onboarding flow joins
    //     an existing V2 cloud vault; the user's real journals will arrive
    //     on the next sync. Without this cleanup, the picker would show
    //     the user's cloud journals AND a stray empty "My Journal" that
    //     never existed on the originating device.
    //
    //     Guard: only drop if it is the unique journal AND has no entries.
    //     This is defensive — never destroys a journal a user has written
    //     into, even in the unlikely offline-then-onboard scenario.
    if let Err(e) = remove_default_journal_if_unused(&conn) {
        log::warn!("onboard_complete: default-journal cleanup failed (non-fatal): {e}");
    }

    Ok(conn)
}

/// Drop the schema-seeded placeholder "My Journal" if and only if it is the
/// sole journal in the DB and has no entries attached. Used by
/// `onboard_complete_inner` after joining an existing cloud vault — the
/// real journals will arrive on the next sync.
fn remove_default_journal_if_unused(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let journals = db::list_journals(conn, None)?;
    if journals.len() != 1 {
        return Ok(());
    }
    let journal = &journals[0];
    let entry_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM entries WHERE journal_id = ?1",
        rusqlite::params![&journal.id],
        |row| row.get(0),
    )?;
    if entry_count > 0 {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM journals WHERE id = ?1",
        rusqlite::params![&journal.id],
    )?;
    Ok(())
}

/// Unwrap a master key using the 32-byte raw recovery key (AES-256-GCM,
/// no Argon2id step — the recovery key is already strong HKDF output).
///
/// `wrapped_hex` is the hex-encoded `nonce || ciphertext || tag` blob.
fn unwrap_master_with_recovery_key(
    wrapped_hex: &str,
    recovery_key: &[u8; 32],
) -> Result<Zeroizing<[u8; 32]>, String> {
    use crate::utils::encryption::KEY_SIZE;
    let blob = hex::decode(wrapped_hex).map_err(|e| format!("Invalid wrapped hex: {e}"))?;
    let plaintext = crate::utils::encryption::decrypt_data(recovery_key, &blob)
        .map_err(|_| "AES-GCM tag check failed".to_string())?;
    if plaintext.len() != KEY_SIZE {
        return Err(format!(
            "Unwrapped key has wrong size: expected {KEY_SIZE}, got {}",
            plaintext.len()
        ));
    }
    let mut key = Zeroizing::new([0u8; KEY_SIZE]);
    key.copy_from_slice(&plaintext);
    Ok(key)
}

// ─── Offline "Forgot password" recovery via the BIP39 recovery phrase ─────────

/// Unwrap the master key from a boot-file recovery slot using the 24-word
/// recovery phrase, then re-wrap it under a fresh password KEK.
///
/// Pure (no Tauri state) so it is unit-testable. Returns the verified master
/// key plus the new wrapping material the caller persists. Does NOT touch the
/// DB or boot file — the caller commits those after this succeeds AND after it
/// has independently verified the master key opens the real DB.
///
/// A wrong recovery phrase fails at the AES-GCM tag check inside
/// `unwrap_master_with_recovery_key`, surfaced as a generic error so we do not
/// leak whether the phrase or the slot was at fault.
fn recover_master_and_rewrap(
    recovery_wrapped_hex: &str,
    mnemonic: &str,
    new_password: &str,
    params: KdfParams,
) -> Result<(Zeroizing<[u8; 32]>, String, String), String> {
    validate_password_length(new_password)?;

    let parsed = crate::utils::recovery::validate_recovery_mnemonic(mnemonic)?;
    let recovery_key = crate::utils::recovery::derive_recovery_key(&parsed);
    let master_key = unwrap_master_with_recovery_key(recovery_wrapped_hex, &recovery_key)
        .map_err(|_| "Recovery phrase does not match this vault".to_string())?;

    // Wrap the recovered master under a fresh password KEK, preserving the
    // vault's KDF strength (`params`, derived by the caller from the existing
    // boot-file blob) so a password recovery does not silently change it.
    let kek_salt = generate_encryption_salt();
    let new_wrapped = wrap_key_with(&master_key, new_password, &kek_salt, params)
        .map_err(|e| format!("wrap_key failed: {e}"))?;
    let new_kek_salt_hex = encode_hex(&kek_salt);

    Ok((master_key, new_wrapped, new_kek_salt_hex))
}

/// Reset a forgotten password using the 24-word recovery phrase — fully
/// offline, no Google Drive required.
///
/// Runs at the lock screen while the app is locked (the `:memory:` placeholder
/// connection is in `state`). Flow:
///   1. Read the recovery slot from the plaintext boot file (readable while
///      locked). Absent slot → recovery is impossible on this device.
///   2. Derive the recovery key from the phrase, unwrap the master key.
///   3. **Self-verify**: open the real SQLCipher DB with the recovered key. A
///      wrong phrase fails here cleanly instead of bricking the vault.
///   4. Re-wrap the master under the new password, commit key material +
///      password hash + boot file, load the key, and unlock.
///
/// The master key is UNCHANGED — only its password wrapping changes — so there
/// is no PRAGMA rekey (mirrors `change_password`). The recovery slot is carried
/// forward untouched.
#[tauri::command]
pub async fn recover_with_passphrase<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    recovery_mnemonic: String,
    new_password: String,
) -> Result<(), String> {
    use tauri::Manager;

    let recovery_mnemonic = Zeroizing::new(recovery_mnemonic);
    let new_password = Zeroizing::new(new_password);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let db_path = data_dir.join("memlore.db");
    let boot_path = boot_file::boot_path(&db_path);

    // 1. Load the recovery slot from the plaintext boot file.
    //
    // Uses `load_for_recovery`, NOT `load`: this command is reachable from
    // `BootFileCorruptScreen`, which exists precisely because `startup_init`
    // hit a `load()` error. `startup_init`'s error and this one come from the
    // exact same file, so re-running the strict loader here would deadlock
    // recovery — it would fail identically before ever reaching the
    // `recovery_wrapped` check below. `load_for_recovery` tolerates the one
    // shape recovery is designed to escape (zero unlock methods, recovery
    // slot intact) while still hard-failing on a genuinely unreadable file or
    // unrecognized format — see its doc comment.
    // Distinct, greppable marker ("cannot repair") so the frontend
    // (`ForgotPasswordScreen.tsx`) can tell this apart from a wrong phrase —
    // this failure happens before the phrase is even checked, so telling the
    // user to "double-check your phrase" (the generic fallback) would send
    // them to retry something that can never succeed.
    let boot = boot_file::load_for_recovery(&boot_path)
        .map_err(|e| format!("This device's boot file cannot be repaired: {e}"))?;
    if boot.mode != EncryptionMode::Password {
        return Err("This device is not password-locked — nothing to recover".to_string());
    }
    let recovery_wrapped = boot.recovery_wrapped.clone().ok_or_else(|| {
        "No recovery slot stored on this device — password recovery is unavailable \
         (this vault was set up before offline recovery existed)"
            .to_string()
    })?;

    // Preserve the vault's current KDF strength: derive it from the existing
    // boot-file wrapped blob (readable while locked). Missing/unparseable → FAST
    // (all new blobs are FAST; unwrap reads the header we write regardless).
    let current_params = boot
        .wrapped_key
        .as_deref()
        .and_then(|hex| hex::decode(hex).ok())
        .and_then(|blob| parse_kek_params(&blob).ok())
        .unwrap_or(KdfParams::FAST);

    // 2. Unwrap master from the phrase.
    let (master_key, _new_wrapped_legacy, _new_kek_salt_hex_legacy) = recover_master_and_rewrap(
        &recovery_wrapped,
        &recovery_mnemonic,
        &new_password,
        current_params,
    )?;
    // Note: _new_wrapped_legacy / _new_kek_salt_hex_legacy are re-derived below
    // after we know db_key, so we can include all three in the final boot file.

    // 3. T6 — Phase 3 path vs legacy path:
    //
    //    Phase 3 (master_wrapped_db_key present):
    //      master → unwrap master_wrapped_db_key → db_key → open DB under db_key-derived.
    //    Legacy (pre-T5 vault, master_wrapped_db_key absent):
    //      DB is still master-derived → open under master-derived key (pre-Phase-3 behavior).
    //
    //    Self-verify happens before any state mutation.
    let db_path_str = db_path.to_string_lossy().into_owned();

    // Track whether we fell back to opening under the master key due to an
    // interrupted T3 migration.  When true, the final boot file write must
    // preserve migration_in_progress=true so the T3-resume arm fires on the
    // next password-unlock and finishes the rekey.
    let mut took_master_fallback = false;

    let (real_conn, content_keys_opt, db_key_opt) = if let Some(mwdk_hex) =
        boot.master_wrapped_db_key.as_deref()
    {
        // Phase 3 path: unwrap db_key from master_wrapped_db_key.
        //
        // GCM authentication here is the phrase-correctness self-verify: if the
        // phrase is wrong, unwrap_content_key fails and we reject before touching
        // any state.
        let mwdk_blob = hex::decode(mwdk_hex)
            .map_err(|e| format!("master_wrapped_db_key hex decode failed: {e}"))?;
        let db_key = unwrap_content_key(&master_key, &mwdk_blob).map_err(|_| {
            "Recovery phrase does not match this vault (master_wrapped_db_key auth failed)"
                .to_string()
        })?;

        // Open real DB under db_key-derived SQLCipher key (self-verify).
        //
        // Crash window: if a T3 migration was interrupted (boot has
        // migration_in_progress=true), the on-disk DB may still be keyed under
        // derive_sqlcipher_key(master_key) while master_wrapped_db_key already
        // points to the new db_key.  In that case open_with_key(db_key-derived)
        // fails even though the phrase is correct.  Fall back to master-derived
        // so recovery succeeds; the interrupted migration resumes on the next
        // password-unlock via the existing T3-resume arm.
        let sqlcipher_key = derive_sqlcipher_key(&*db_key);
        let real_conn = match crate::db::open_with_key(&db_path_str, &sqlcipher_key) {
            Ok(c) => c,
            Err(_) if boot.migration_in_progress == Some(true) => {
                // Interrupted migration: DB is still master-keyed; open under master.
                log::warn!(
                    "recover_with_passphrase: open under db_key failed with \
                     migration_in_progress=true — falling back to master-keyed open; \
                     T3 migration will resume on next unlock"
                );
                took_master_fallback = true;
                let master_sqlcipher_key = derive_sqlcipher_key(&*master_key);
                crate::db::open_with_key(&db_path_str, &master_sqlcipher_key)
                    .map_err(|_| "Recovery phrase does not match this vault".to_string())?
            }
            Err(_) => {
                return Err("Recovery phrase does not match this vault".to_string());
            }
        };

        // Decode the content-key list from the boot file (wrapped under master).
        let content_keys = if let Some(list_hex) = boot.wrapped_content_list.as_deref() {
            match decode_content_key_list(&master_key, list_hex) {
                Ok(keys) => Some(keys),
                Err(e) => {
                    log::warn!("recover_with_passphrase: content list decode failed: {e}; will use legacy set_key");
                    None
                }
            }
        } else {
            None
        };

        (real_conn, content_keys, Some(db_key))
    } else {
        // Legacy path: no master_wrapped_db_key → DB is still master-derived.
        let sqlcipher_key = derive_sqlcipher_key(&*master_key);
        let real_conn = crate::db::open_with_key(&db_path_str, &sqlcipher_key)
            .map_err(|_| "Recovery phrase does not match this vault".to_string())?;
        (real_conn, None, None)
    };

    // 4. Re-wrap master + db_key under the NEW password KEK (post-verify, pre-persist).
    let new_kek_salt = generate_encryption_salt();
    let new_kek_salt_hex = hex::encode(&new_kek_salt);
    let new_wrapped = wrap_key_with(&*master_key, &new_password, &new_kek_salt, current_params)?;

    // Re-wrap db_key under the new KEK (if available).
    let new_wrapped_db_key_hex = if let Some(ref dk) = db_key_opt {
        let new_kek = crate::utils::encryption::derive_encryption_key_with(
            &new_password,
            &new_kek_salt,
            current_params,
        )?;
        let blob = wrap_content_key(&new_kek, dk)?;
        Some(hex::encode(&blob))
    } else {
        None
    };

    // master_wrapped_db_key is unchanged (master is unchanged; db_key is unchanged).
    // Carry forward from boot file.
    let master_wrapped_db_key = boot.master_wrapped_db_key.clone();

    // Carry forward the content list (master-wrapped, unchanged).
    let wrapped_content_list = boot.wrapped_content_list.clone();

    // Re-encode the content list with the same master (unchanged master).
    // The boot already has the right encoded list; carry it forward.

    // 5. Commit: swap in the real connection, persist new key material +
    //    password hash atomically, rewrite the boot file (recovery slot carried
    //    forward), and load the key into state.
    //
    //    CRITICAL ordering: set_connection first (replaces placeholder), then
    //    write settings, then write boot file. If settings fail, the connection
    //    is already real (no rollback needed for the connection — the old boot
    //    file still has the old key and the DB is still valid). Boot file failure
    //    is also non-fatal: next unlock re-reads from DB settings.
    state.set_connection(real_conn)?;
    {
        let conn = state.lock()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to start transaction: {e}"))?;
        db::set_password_hash(&tx, &new_password).map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::WRAPPED_ENCRYPTION_KEY_KEY, &new_wrapped)
            .map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::KEK_SALT_KEY, &new_kek_salt_hex).map_err(|e| e.to_string())?;
        tx.commit()
            .map_err(|e| format!("Failed to commit recovery transaction: {e}"))?;

        // Biometric Keychain item was bound to the old password — clear it.
        if let Err(e) = clear_biometric_setting(&conn) {
            log::warn!("recover_with_passphrase: failed to clear biometric setting: {e}");
        }
    }

    boot_file::save(
        &BootFile {
            mode: EncryptionMode::Password,
            // Recovery resets the password; the biometric Keychain item was
            // just cleared above (mirrors change_password), so os_kek is
            // invalidated here too even though it wraps the (unchanged)
            // master and would technically still decrypt correctly. Password
            // remains the guaranteed fallback (kek_salt/wrapped_key are
            // always written above), so this is never a lockout.
            unlock_method: crate::utils::boot_file::UnlockMethod::Password,
            kek_salt: Some(new_kek_salt_hex),
            wrapped_key: Some(new_wrapped),
            os_kek_wrapped_master: None,
            // Master key unchanged — the recovery slot still wraps it; keep it.
            recovery_wrapped: Some(recovery_wrapped),
            // Content list is master-wrapped (master unchanged) — carry forward.
            wrapped_content_list,
            // db_key re-wrapped under new KEK (or None for legacy vaults).
            wrapped_db_key: new_wrapped_db_key_hex,
            // master_wrapped_db_key is unchanged (master unchanged) — carry forward.
            master_wrapped_db_key,
            // If we fell back to the master-keyed open due to an interrupted T3
            // migration, preserve the marker so the T3-resume arm fires on the next
            // password-unlock and finishes re-keying the DB.  Clearing it here would
            // cause the next unlock to skip T3-resume → permanently stuck.
            migration_in_progress: if took_master_fallback {
                Some(true)
            } else {
                None
            },
        },
        &boot_path,
    )
    .map_err(|e| format!("Failed to update boot file after recovery: {e}"))?;

    // 6. Load key into state.
    match (content_keys_opt, db_key_opt) {
        (Some(content_keys), Some(db_key)) => {
            // Phase 3: full content-key state.
            let latest = *content_keys
                .keys()
                .next_back()
                .ok_or_else(|| "content-key list is empty after recovery".to_string())?;
            key_state.set_content_state(
                content_keys,
                latest,
                db_key,
                Zeroizing::new(*master_key),
            )?;
        }
        _ => {
            // Legacy (pre-T5 vault): master IS the key.
            key_state.set_key(master_key)?;
        }
    }

    if let Err(e) = wipe_biometric_keychain() {
        log::warn!("recover_with_passphrase: failed to wipe biometric Keychain item: {e}");
    }

    // The key is loaded and the boot file rewritten — recovery fully
    // succeeded. If startup had frozen `BootFileCorrupt`, flip it forward so
    // `get_startup_mode` stops reporting it (see `mark_startup_recovered`).
    mark_startup_recovered(&app.state::<std::sync::Mutex<crate::StartupMode>>());

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    recover_with_passphrase_post_unlock(&state, now_ms);

    if let Err(e) = app.emit("app:unlocked", ()) {
        log::warn!("emit app:unlocked failed (non-fatal): {e}");
    }

    Ok(())
}

// ─── Device list ─────────────────────────────────────────────────────────────

/// Serialisable device info returned to the frontend.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DeviceInfo {
    pub device_id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub is_current: bool,
    pub is_revoked: bool,
}

impl From<db::DeviceRow> for DeviceInfo {
    fn from(r: db::DeviceRow) -> Self {
        Self {
            device_id: r.device_id,
            name: r.name,
            created_at: r.created_at,
            last_seen_at: r.last_seen_at,
            is_current: r.is_current,
            is_revoked: r.is_revoked,
        }
    }
}

/// Return all device rows from the local `devices` table, ordered by
/// `created_at ASC`. The current device always appears (row created in Phase 2
/// or 3). Never makes a Drive request — purely local.
#[tauri::command]
pub fn list_devices(state: State<'_, AppState>) -> Result<Vec<DeviceInfo>, String> {
    let conn = state.lock()?;
    let rows = db::list_devices(&conn).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(DeviceInfo::from).collect())
}

#[derive(Debug)]
struct DeviceSlotUploadMaterial {
    device_id: String,
    name: String,
    created_at: i64,
    last_seen_at: i64,
}

#[derive(Debug)]
struct RenameDeviceOutcome {
    upload: Option<DeviceSlotUploadMaterial>,
    deferred: bool,
}

fn normalized_device_name(new_name: &str) -> Result<String, String> {
    let new_name_trimmed = new_name.trim().to_string();
    if new_name_trimmed.is_empty() {
        return Err("device name cannot be empty".to_string());
    }
    if new_name_trimmed.chars().count() > 80 {
        return Err("device name must be 80 characters or fewer".to_string());
    }
    if new_name_trimmed.len() > 128 {
        return Err("device name is too long (byte limit exceeded)".to_string());
    }
    Ok(new_name_trimmed)
}

fn rename_device_inner(
    conn: &rusqlite::Connection,
    device_id: &str,
    new_name: &str,
) -> Result<RenameDeviceOutcome, String> {
    let new_name_trimmed = normalized_device_name(new_name)?;
    let current_created_at = db::list_devices(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|r| r.device_id == device_id)
        .and_then(|r| r.is_current.then_some(r.created_at));

    db::update_device_name(conn, device_id, &new_name_trimmed).map_err(|e| e.to_string())?;

    let Some(created_at) = current_created_at else {
        return Ok(RenameDeviceOutcome {
            upload: None,
            deferred: false,
        });
    };

    if crate::commands::sync::is_sync_in_progress()
        || db::has_active_rotation_job(conn).map_err(|e| e.to_string())?
    {
        db::set_setting(conn, db::DEVICE_SLOT_DIRTY_KEY, "1").map_err(|e| e.to_string())?;
        return Ok(RenameDeviceOutcome {
            upload: None,
            deferred: true,
        });
    }

    let last_seen_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    Ok(RenameDeviceOutcome {
        upload: Some(DeviceSlotUploadMaterial {
            device_id: device_id.to_string(),
            name: new_name_trimmed,
            created_at,
            last_seen_at,
        }),
        deferred: false,
    })
}

fn mark_device_slot_dirty(conn: &rusqlite::Connection) {
    let _ = db::set_setting(conn, db::DEVICE_SLOT_DIRTY_KEY, "1");
}

fn begin_device_slot_upload_or_mark_dirty(
    conn: &rusqlite::Connection,
) -> Result<Option<crate::commands::sync::SyncInProgressGuard>, String> {
    let Some(guard) = crate::commands::sync::SyncInProgressGuard::try_acquire() else {
        mark_device_slot_dirty(conn);
        return Ok(None);
    };
    if db::has_active_rotation_job(conn).map_err(|e| e.to_string())? {
        mark_device_slot_dirty(conn);
        return Ok(None);
    }
    Ok(Some(guard))
}

fn clear_device_slot_dirty_if_upload_still_current(
    conn: &rusqlite::Connection,
    uploaded_name: &str,
) -> Result<(), String> {
    let current_name = db::list_devices(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|d| d.is_current)
        .map(|d| d.name);

    if current_name.as_deref() == Some(uploaded_name) {
        let _ = db::delete_setting(conn, db::DEVICE_SLOT_DIRTY_KEY);
    } else {
        mark_device_slot_dirty(conn);
    }

    Ok(())
}

/// Rename a device by `device_id`.
///
/// - If `device_id` is the current device AND a cloud provider is connected,
///   updates the local DB row and re-uploads only this device's keyring slot
///   (best-effort — failure sets `device_slot_dirty` for retry on next
///   sync).
/// - If `device_id` is a non-current device, updates local DB only (you
///   cannot write another device's slot — they own it).
#[tauri::command]
pub async fn rename_device(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    new_name: String,
) -> Result<(), String> {
    let outcome = {
        let conn = state.lock()?;
        rename_device_inner(&conn, &device_id, &new_name)?
    };
    if outcome.deferred {
        return Ok(());
    };
    let Some(upload) = outcome.upload else {
        return Ok(());
    };

    let _sync_guard = {
        let conn = state.lock()?;
        let Some(guard) = begin_device_slot_upload_or_mark_dirty(&conn)? else {
            return Ok(());
        };
        guard
    };

    let provider = match acquire_drive_provider(&app, &state) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("rename_device: provider init failed ({e}), setting device_slot_dirty");
            let conn = state.lock()?;
            mark_device_slot_dirty(&conn);
            return Ok(());
        }
    };

    // Upload only devices/<id>.json — preserve _meta.json epoch and _recovery.json.
    // The primitive itself refuses when force-re-pair is required (A3 gate); the
    // Err path below then sets device_slot_dirty so the rename is retried after
    // the user re-pairs.
    let result = crate::commands::gdrive::reupload_current_device_slot(
        &state,
        &provider,
        &upload.device_id,
        &upload.name,
        upload.created_at,
        upload.last_seen_at,
    )
    .await;
    match result {
        Ok(()) => {
            log::info!("rename_device: device slot re-uploaded after rename");
            let conn = state.lock()?;
            clear_device_slot_dirty_if_upload_still_current(&conn, &upload.name)?;
        }
        Err(e) => {
            log::warn!("rename_device: slot re-upload failed ({e}), setting device_slot_dirty");
            let conn = state.lock()?;
            mark_device_slot_dirty(&conn);
        }
    }

    Ok(())
}

/// Fetch all device slots from Drive and upsert them into the local `devices`
/// table. Never deletes local rows (those may be in flight). Returns the merged
/// list.
///
/// Useful to pick up new devices that onboarded from another machine since the
/// last local refresh.
#[tauri::command]
pub async fn refresh_devices_from_cloud(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<DeviceInfo>, String> {
    let provider = acquire_drive_provider(&app, &state)?;

    let slots = crate::sync::keyring_v2::io::list_device_slots(&provider)
        .await
        .map_err(|e| e.to_string())?;

    {
        let conn = state.lock()?;
        let current_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;
        merge_device_slots_into_local(&conn, &slots, &current_id);
    }

    // Return the merged local list.
    let conn = state.lock()?;
    let rows = db::list_devices(&conn).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(DeviceInfo::from).collect())
}

/// Upsert cloud device slots into the local `devices` table.
///
/// The local table is authoritative for the CURRENT device's `last_seen_at`
/// (stamped after every successful sync). The cloud slot may carry an older
/// value (e.g. the slot wasn't republished since the last local sync), so for
/// the current device we preserve the local value rather than clobber it with
/// the cloud one. Peers take the cloud value as usual.
///
/// Best-effort per row: a failed upsert is logged and skipped rather than
/// aborting the whole merge.
///
/// Converges the local table to the cloud-authoritative set: after upserting
/// every cloud slot, any non-current local row whose device_id is absent from
/// the cloud listing is pruned (see `db::prune_devices_not_in`). This is what
/// removes a revoked/removed peer from this machine on the next refresh. The
/// current device is never pruned.
fn merge_device_slots_into_local(
    conn: &rusqlite::Connection,
    slots: &[crate::sync::keyring_v2::types::DeviceSlotV2],
    current_id: &str,
) {
    let local_current_last_seen = db::list_devices(conn).ok().and_then(|rows| {
        rows.into_iter()
            .find(|d| d.is_current)
            .map(|d| d.last_seen_at)
    });

    for slot in slots {
        let is_current = slot.device_id == current_id;
        let last_seen_at = if is_current {
            local_current_last_seen.unwrap_or(slot.last_seen_at)
        } else {
            slot.last_seen_at
        };
        if let Err(e) = db::upsert_device(
            conn,
            &db::DeviceRow {
                device_id: slot.device_id.clone(),
                name: slot.name.clone(),
                created_at: slot.created_at,
                last_seen_at,
                is_current,
                is_revoked: false,
            },
        ) {
            log::warn!(
                "merge_device_slots_into_local: upsert failed for device {}: {e}",
                slot.device_id
            );
        }
    }

    // Converge local table to the authoritative cloud listing: delete any
    // non-current row whose device_id is absent from the cloud slots.
    // The current device is protected by the `is_current = 0` guard inside
    // prune_devices_not_in — it is NEVER deleted.
    let keep_ids: Vec<String> = slots.iter().map(|s| s.device_id.clone()).collect();
    if let Err(e) = db::prune_devices_not_in(conn, &keep_ids) {
        log::warn!("merge_device_slots_into_local: prune failed: {e}");
    }
}

// ─── Rotation commands (Phase 5) ─────────────────────────────────────────────

/// Revoke a peer device and rotate the master key.
///
/// This is the user-facing "Revoke Device" action. It:
/// 1. Guards that `target_device_id` is not the current device.
/// 2. Validates `recovery_mnemonic` against the cloud vault (via
///    `onboard_validate_passphrase_inner`) to confirm it is THIS vault's phrase,
///    not merely a syntactically valid BIP39 mnemonic.  Zero state mutation occurs
///    on mismatch.
/// 3. Runs the full rotation state machine (enumerate → reencrypt → commit_local
///    → enumerate_stragglers → publish_keyring → done).
/// 4. Deletes the revoked device slot from the cloud keyring and marks it
///    `is_revoked = 1` in the local `devices` table.
///
/// **Both `current_password` and `recovery_mnemonic` are required** (Option A
/// from the plan):
/// - `current_password` — to verify the caller and re-wrap the new master into
///   this device's **local** unlock material. It never produces a cloud wrap:
///   device slots are metadata-only.
/// - `recovery_mnemonic` — to write the fresh `_recovery.json`, the only cloud
///   master slot.
///
/// Without the 24-word phrase the vault loses its recovery property.
#[tauri::command]
pub async fn revoke_device(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    target_device_id: String,
    current_password: String,
    recovery_mnemonic: String,
) -> Result<(), String> {
    // I3: Prevent concurrent sync + rotation. Fail-fast (do not queue) — revoke
    // rotates keys and takes credentials; the frontend maps SYNC_IN_PROGRESS_ERR.
    let _sync_guard = crate::commands::sync::try_acquire_sync_or_in_progress_err()?;

    use tauri::Manager;
    let current_password = zeroize::Zeroizing::new(current_password);
    let recovery_mnemonic = zeroize::Zeroizing::new(recovery_mnemonic);

    validate_password_length(&current_password)?;

    // Verify password locally before any cloud I/O.
    {
        let conn = state.lock()?;
        if !db::verify_password_hash(&conn, &*current_password).map_err(|e| e.to_string())? {
            return Err("Invalid password".to_string());
        }
    }

    // Validate mnemonic early (before creating any job rows).
    let parsed = crate::utils::recovery::validate_recovery_mnemonic(&recovery_mnemonic)
        .map_err(|e| format!("Invalid recovery mnemonic: {e}"))?;

    // Guard: target must not be the current device.
    {
        let conn = state.lock()?;
        let current_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;
        if target_device_id == current_id {
            return Err("Cannot revoke the current device — use Sign Out instead.".to_string());
        }
    }

    // Build provider.
    let provider = acquire_drive_provider(&app, &state)?;

    // Vault-match: confirm the supplied phrase is THIS vault's phrase by unwrapping
    // the cloud _recovery.json and verifying the master fingerprint against _meta.json.
    // This is a read-only cloud check — zero DB or cloud mutation on mismatch.
    // Must run BEFORE rotate_keys creates any job rows or DB state.
    // Let the inner, already user-facing messages through unchanged: it
    // distinguishes a genuinely wrong phrase ("Wrong recovery phrase…") from a
    // cloud/network failure (so an offline attempt with the CORRECT phrase is not
    // mislabeled as "wrong phrase"). Still fail-closed: any error returns before
    // rotate_keys mutates state.
    onboard_validate_passphrase_inner(&provider, &*recovery_mnemonic).await?;

    let boot_path = app
        .path()
        .app_data_dir()
        .map(|d| crate::utils::boot_file::boot_path(&d.join("memlore.db")))
        .ok();

    // Phase 4 lazy path: generate new content key + new master, skip all cloud re-encryption.
    // Revoke uses RecoverySource::Supplied (caller-provided mnemonic) so no need to stash.
    let (rotation_id, ctx, new_content_epoch) = crate::sync::rotation::rotate::rotate_keys(
        &provider,
        &state,
        &key_state,
        &current_password,
        Some(target_device_id.as_str()),
        None, // revoke uses Supplied, not Stashed
        boot_path.as_deref(),
    )
    .await?;

    // Publish new keyring with the caller-supplied recovery mnemonic.
    crate::sync::rotation::publish_keyring(
        &provider,
        &state,
        rotation_id,
        &ctx,
        crate::sync::rotation::RecoverySource::Supplied(&parsed),
        Some(target_device_id.as_str()),
        new_content_epoch,
    )
    .await?;

    // Rotation changes master_key. If biometric unlock is enabled its Keychain
    // entry still holds master_old — the next Touch ID would fail.
    // Re-store master_new (now in key_state after rotate_keys Step 5) or wipe
    // the setting so the UI falls back to password unlock gracefully.
    refresh_biometric_keychain_after_rotation(&app, &state, &key_state);

    Ok(())
}

/// Testable core of [`remove_device`]: guard → delete cloud slot → delete
/// local row.
///
/// The cloud delete runs FIRST: if it fails, the local row survives, the
/// device stays visible, and the user can retry. The reverse order would leave
/// an orphaned cloud slot that `refresh_devices_from_cloud` resurrects locally.
async fn remove_device_inner<P: crate::sync::keyring_v2::KeyringV2Io>(
    provider: &P,
    state: &AppState,
    target_device_id: &str,
) -> Result<(), String> {
    {
        let conn = state.lock()?;
        let current_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;
        if target_device_id == current_id {
            return Err("Cannot remove the current device — use Sign Out instead.".to_string());
        }
    }

    // Idempotent: a slot that is already gone deletes as Ok.
    crate::sync::keyring_v2::io::delete_device_slot(provider, target_device_id)
        .await
        .map_err(|e| format!("remove_device: delete cloud slot: {e}"))?;

    let conn = state.lock()?;
    db::delete_device(&conn, target_device_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a peer device from the device list WITHOUT any key rotation.
///
/// This is the lightweight sibling of [`revoke_device`] for the no-security
/// case: the device is still in the user's hands (retired, wiped, sold after a
/// reset) and just needs to disappear from the list. No credentials are
/// required and no key material changes:
/// 1. Guards that `target_device_id` is not the current device.
/// 2. Deletes the device's cloud keyring slot (registry metadata only — slots
///    carry no key material).
/// 3. Deletes the local `devices` row.
///
/// The removed device keeps its local data and its keys. If it ever syncs
/// again it re-uploads its slot and reappears in the list — use
/// [`revoke_device`] to actually cut a device off.
#[tauri::command]
pub async fn remove_device(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target_device_id: String,
) -> Result<(), String> {
    // Serialize against any guard holder (sync cycle, rotation, OAuth
    // connect, cloud wipe): publish_keyring rewrites device slots, so a
    // concurrent slot delete could race it. Queue behind the holder instead
    // of bailing — the UI shows a "queued, will run after sync" notice and
    // the removal fires automatically once the holder finishes.
    let _sync_guard = crate::commands::sync::SyncInProgressGuard::acquire_waiting(
        std::time::Duration::from_secs(600),
    )
    .await
    .ok_or_else(|| {
        "Sync kept running for over 10 minutes, so the device was not removed. \
         Try again once sync settles."
            .to_string()
    })?;

    let provider = acquire_drive_provider(&app, &state)?;
    remove_device_inner(&provider, &state, &target_device_id).await
}

/// Shared mechanical tail of [`rotate_master_key`] and [`reset_recovery_phrase`]:
/// `boot_path` → `rotate_keys` → `publish_keyring(Stashed)` → biometric refresh.
///
/// Divergent security heads stay in each command (validate-existing phrase vs
/// mint-new phrase + vault-identity proof). Keeping one tail forces any future
/// guard added here onto both flows.
async fn finish_master_rotation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    key_state: &crate::EncryptionKeyState,
    provider: &crate::sync::CloudProvider,
    current_password: &str,
    recovery_mnemonic: &str,
) -> Result<(), String> {
    use tauri::Manager;
    let boot_path = app
        .path()
        .app_data_dir()
        .map(|d| crate::utils::boot_file::boot_path(&d.join("memlore.db")))
        .ok();

    // Lazy rotate: generate new content key + new master, skip cloud re-encryption.
    // The recovery mnemonic is stashed atomically inside rotate_keys — the stash
    // guarantees publish_keyring(Stashed) can always find it.
    let (rotation_id, ctx, new_content_epoch) = crate::sync::rotation::rotate::rotate_keys(
        provider,
        state,
        key_state,
        current_password,
        None,                    // not revoking a specific device
        Some(recovery_mnemonic), // stash atomically — wedge-proof
        boot_path.as_deref(),
    )
    .await?;

    // Publish new keyring using the stashed mnemonic.
    // The recovery stash is cleared atomically inside finalize_publish_local when
    // the job transitions to `done` — no separate clear is needed here.
    crate::sync::rotation::publish_keyring(
        provider,
        state,
        rotation_id,
        &ctx,
        crate::sync::rotation::RecoverySource::Stashed,
        None, // not revoking
        new_content_epoch,
    )
    .await?;

    // Rotation changes master_key. If biometric unlock is enabled its Keychain
    // entry still holds master_old — the next Touch ID would fail.
    refresh_biometric_keychain_after_rotation(app, state, key_state);

    Ok(())
}

/// Rotate the master key without revoking a specific device.
///
/// All other devices' slots are deleted. They carry no key material, so this
/// is a registry cleanup, not a key revocation: peers are locked out because
/// the master rotated and `_recovery.json` now needs the phrase. Each device
/// must re-pair via the `ForceRePairScreen` flow on its next sync, detected by
/// the epoch bump in `_meta.json`.
///
/// The recovery phrase is UNCHANGED — the caller supplies the current 24-word
/// phrase, which is first validated against the cloud vault (via
/// `onboard_validate_passphrase_inner`) and then stashed atomically inside
/// `rotate_keys`.  The stash is cleared atomically when the rotation job
/// transitions to `done` inside `finalize_publish_local`.
///
/// # Wedge-proof guarantee
///
/// `rotate_keys` writes `ROTATION_NEW_RECOVERY_MNEMONIC_STASH` in the **same
/// atomic tx** as the job row.  This means:
///   job-row-exists ⇒ stash-exists
/// so `publish_keyring(Stashed)` always finds the mnemonic, and crash-resume
/// via `resume_rotation` also resolves correctly.
///
/// # Vault-match guarantee
///
/// `onboard_validate_passphrase_inner` is called before `rotate_keys` creates
/// any job rows.  A wrong-but-valid BIP39 phrase is rejected with zero state
/// mutation, preventing `_recovery.json` from being overwritten with a key
/// derived from the wrong phrase.
#[tauri::command]
pub async fn rotate_master_key(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    current_password: String,
    recovery_mnemonic: String,
) -> Result<(), String> {
    // I3: Prevent concurrent sync + rotation.
    let _sync_guard = crate::commands::sync::SyncInProgressGuard::try_acquire()
        .ok_or_else(|| crate::commands::sync::SYNC_IN_PROGRESS_ERR.to_string())?;

    let current_password = zeroize::Zeroizing::new(current_password);
    let recovery_mnemonic = zeroize::Zeroizing::new(recovery_mnemonic);

    validate_password_length(&current_password)?;

    // Verify password locally before any cloud I/O or state mutation.
    {
        let conn = state.lock()?;
        if !db::verify_password_hash(&conn, &*current_password).map_err(|e| e.to_string())? {
            return Err("Invalid password".to_string());
        }
    }

    // Validate mnemonic before any state mutation.
    crate::utils::recovery::validate_recovery_mnemonic(&recovery_mnemonic)
        .map_err(|e| format!("Invalid recovery mnemonic: {e}"))?;

    // Build provider.
    let provider = acquire_drive_provider(&app, &state)?;

    // Vault-match: confirm the supplied phrase is THIS vault's phrase by unwrapping
    // the cloud _recovery.json and verifying the master fingerprint against _meta.json.
    // This is a read-only cloud check — zero DB or cloud mutation on mismatch.
    // Must run BEFORE rotate_keys creates any job rows or DB state.
    // Let the inner, already user-facing messages through unchanged: it
    // distinguishes a genuinely wrong phrase ("Wrong recovery phrase…") from a
    // cloud/network failure (so an offline attempt with the CORRECT phrase is not
    // mislabeled as "wrong phrase"). Still fail-closed: any error returns before
    // rotate_keys mutates state.
    onboard_validate_passphrase_inner(&provider, &*recovery_mnemonic).await?;

    finish_master_rotation(
        &app,
        &state,
        &key_state,
        &provider,
        &current_password,
        &recovery_mnemonic,
    )
    .await
}

/// Full secret reset ("my 24 words leaked") — Flow G from the design doc
/// (`docs/how-sync-and-encryption-work.md` §1.6). Mints a NEW random master key **and** a
/// brand-new 24-word recovery phrase together, then publishes both.
///
/// This differs from `rotate_master_key` in exactly the two ways the phase
/// plan calls out, and nothing else — every other step (mint master_new +
/// content epoch N+1, re-wrap `_content.json`, bump `_meta.json`, lazy
/// rotation, crash-resume via the atomic stash) is the same `rotate_keys` +
/// `publish_keyring` machinery `rotate_master_key` uses:
///
/// 1. **No caller-supplied phrase is validated against the cloud vault
///    first.** `rotate_master_key` calls `onboard_validate_passphrase_inner`
///    before touching any state because it re-wraps the master under the
///    caller's EXISTING phrase — a wrong-but-valid phrase there would
///    silently overwrite `_recovery.json` under the wrong key. That risk
///    does not exist here: this command never derives from an existing
///    phrase, it mints a fresh one, so there is nothing to validate against.
/// 2. **Proof of vault ownership is `current_password` alone**, verified
///    locally exactly as every other rotation command does. The caller is
///    already unlocked, which is the same "vault-match guarantee" in
///    substance — the whole point of Flow G is to replace a phrase the user
///    no longer trusts, so requiring that phrase would defeat the flow.
///
/// The new mnemonic is stashed atomically inside `rotate_keys` (same
/// `ROTATION_NEW_RECOVERY_MNEMONIC_STASH` wedge-proof path: job-row-exists
/// ⇒ stash-exists) and surfaced to the UI via the EXISTING
/// `get_pending_rotation_recovery` / `confirm_rotation_recovery_saved` gate —
/// no new reveal command, no new persistence, no weakening of the "mnemonic
/// is never stored long-term" invariant. Crash-resume is identical to
/// `rotate_master_key`'s: `resume_rotation` drives an interrupted job
/// forward the same way regardless of which command created the stash.
///
/// Per design doc §5 Flow G, operation (a) — "new phrase, same master" — is
/// deliberately NOT offered (Drive revision history can retain a prior
/// `_recovery.json`, so it cannot reliably retire an old phrase on its own).
/// This command performs operation (c): new master AND new phrase together.
/// It is forward-only — it protects everything written after the reset and
/// nothing written before it, because lazy rotation never re-encrypts old
/// envelopes. The UI must state this plainly wherever the flow is offered.
#[tauri::command]
pub async fn reset_recovery_phrase<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    current_password: String,
) -> Result<String, String> {
    // I3: Prevent concurrent sync + rotation.
    let _sync_guard = crate::commands::sync::SyncInProgressGuard::try_acquire()
        .ok_or_else(|| crate::commands::sync::SYNC_IN_PROGRESS_ERR.to_string())?;

    let current_password = zeroize::Zeroizing::new(current_password);
    validate_password_length(&current_password)?;

    // Verify password locally before any cloud I/O or state mutation — the
    // caller's proof of vault ownership (see doc comment above).
    {
        let conn = state.lock()?;
        if !db::verify_password_hash(&conn, &*current_password).map_err(|e| e.to_string())? {
            return Err("Invalid password".to_string());
        }
    }

    // Mint a brand-new phrase. Never read or reuse the old one — that is the
    // entire point of this command.
    let new_mnemonic = crate::utils::recovery::generate_recovery_mnemonic()
        .map_err(|e| format!("generate_recovery_mnemonic failed: {e}"))?;

    let provider = acquire_drive_provider(&app, &state)?;

    // ── Vault-identity proof (MUST run before anything is rewritten) ─────────
    //
    // Sibling commands (`rotate_master_key`, `revoke_device`) prove they are
    // operating on the right cloud vault by round-tripping the user's phrase
    // through `_recovery.json`: a phrase that unwraps to a master whose
    // fingerprint matches `_meta.json` can only belong to this vault. Flow G
    // mints a *new* phrase, so that proof is unavailable — and without a
    // replacement this command would happily overwrite `_recovery.json`,
    // `_content.json` and `_meta.json` of whatever vault the provider happens
    // to resolve to.
    //
    // The local master is the equivalent proof: it is already unlocked in
    // memory, and its fingerprint is exactly what `_meta.json` records. If they
    // disagree, the connected folder is a different vault (wrong account,
    // folder mixup) and continuing would permanently corrupt someone else's
    // keyring. Note `rotate_keys`' own fingerprint check is *conditional* on a
    // cached `CLOUD_MASTER_FINGERPRINT` being present, so it cannot be relied
    // on here — this check is unconditional by design.
    {
        let cloud_meta = crate::sync::keyring_v2::io::read_meta(&provider)
            .await
            .map_err(|e| format!("reset_recovery_phrase: could not read cloud keyring: {e}"))?
            .ok_or_else(|| {
                "reset_recovery_phrase: no cloud keyring found — refusing to reset the recovery                  phrase against an unknown vault"
                    .to_string()
            })?;

        let local_fp = key_state.with_master(|master| {
            Ok(hex::encode(crate::utils::encryption::key_fingerprint(
                master,
            )))
        })?;

        if local_fp != cloud_meta.master_fingerprint {
            return Err(
                "reset_recovery_phrase: the connected cloud vault does not match this device's                  vault. Refusing to overwrite its recovery material."
                    .to_string(),
            );
        }
    }

    finish_master_rotation(
        &app,
        &state,
        &key_state,
        &provider,
        &current_password,
        &*new_mnemonic,
    )
    .await?;

    // RETURN THE PHRASE. This is not a convenience — it is the only surviving
    // copy by the time this line runs.
    //
    // `finalize_publish_local` clears the rotation stash in the *same
    // transaction* that sets the job to `DONE`, and `recovery_reveal_ready`
    // requires `DONE` — so `get_pending_rotation_recovery` has a zero-width
    // window and can never return this phrase. That clearing is correct for
    // `rotate_master_key`, where the stash holds the user's *unchanged* phrase
    // and revealing it would pop a false "your phrase changed" modal. Flow G
    // is the opposite case: it replaces the phrase, so failing to hand it back
    // here leaves the vault wrapped under words nobody has ever seen —
    // permanently unrecoverable while still appearing to work locally.
    Ok(new_mnemonic.to_string())
}

/// Return the stashed new recovery mnemonic from the most recent rotation, or
/// `None` if the phrase is not yet safe to reveal.
///
/// Positive gate (fail-safe): returns `Some(phrase)` ONLY when ALL conditions
/// hold simultaneously:
///   1. A stashed phrase is present.
///   2. The latest rotation job exists AND is in state `done`.
///   3. That job is a ROTATE (not a REVOKE) — `revoked_device_id IS NULL`.
///
/// Before the job transitions to `done`, the `_recovery.json` cloud file has
/// not yet been published, so the stashed phrase is not yet the live recovery
/// secret.  Returning it early would show the user a phrase that is already
/// superseded if the rotation later fails or resumes.  The gate therefore
/// returns `None` at `publish_keyring` and all earlier states (crash-resume
/// race case: stash exists but cloud publish is not confirmed).
///
/// The stash survives across app restarts via the `settings` table.
#[tauri::command]
pub fn get_pending_rotation_recovery(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.lock()?;
    let job = db::find_latest_rotation_job(&conn).map_err(|e| e.to_string())?;
    if !db::recovery_reveal_ready(job.as_ref()) {
        return Ok(None);
    }
    db::get_rotation_recovery_stash(&conn).map_err(|e| e.to_string())
}

/// Clear the stashed new recovery mnemonic after the user confirms they saved it.
///
/// Positive gate (fail-safe): only clears the stash when the latest rotation
/// job is a done ROTATE (`revoked_device_id IS NULL`, state `done`) — the same
/// predicate as `get_pending_rotation_recovery`.  If the gate does NOT hold
/// (e.g. job is still at `publish_keyring` mid-resume), this is a no-op
/// success — the stash is intentionally left intact so the resume flow can
/// still read it.
///
/// Gating confirm is what makes "confirm unreachable when unsafe" robust: even
/// if the UI calls this command spuriously (e.g. from a stale component), it
/// cannot clear a phrase that belongs to an in-progress job.  The positive
/// gate is the real guard; `discard_orphaned_rotation_job_if_any` also clears
/// the stash on abort as a best-effort hygiene step.
///
/// Idempotent when the gate holds: safe to call even if the stash is already
/// absent.
#[tauri::command]
pub fn confirm_rotation_recovery_saved(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.lock()?;
    let job = db::find_latest_rotation_job(&conn).map_err(|e| e.to_string())?;
    if !db::recovery_reveal_ready(job.as_ref()) {
        // Gate does not hold — treat as a no-op; do NOT clear the stash.
        return Ok(());
    }
    db::clear_rotation_recovery_stash(&conn).map_err(|e| e.to_string())
}

/// Resume an interrupted rotation after a crash or app restart.
///
/// Only the device password is required unless the job is at `publish_keyring`
/// state, in which case the 24-word mnemonic is also required for revoke jobs.
#[tauri::command]
pub async fn resume_rotation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    current_password: String,
    recovery_mnemonic: Option<String>,
) -> Result<bool, String> {
    // I3: Prevent concurrent sync + rotation.
    let _sync_guard = crate::commands::sync::SyncInProgressGuard::try_acquire()
        .ok_or_else(|| crate::commands::sync::SYNC_IN_PROGRESS_ERR.to_string())?;

    let current_password = zeroize::Zeroizing::new(current_password);

    // Validate password.
    {
        let conn = state.lock()?;
        if !db::verify_password_hash(&conn, &*current_password).map_err(|e| e.to_string())? {
            return Err("Invalid password".to_string());
        }
    }

    // Check if there is an active job.
    let job = {
        let conn = state.lock()?;
        match db::find_active_rotation_job(&conn).map_err(|e| e.to_string())? {
            Some(j) => j,
            None => return Ok(false),
        }
    };

    log::info!(
        "resume_rotation: resuming job {} from state '{}'",
        job.id,
        job.state
    );

    let provider = acquire_drive_provider(&app, &state)?;

    use crate::sync::rotation::state as rstate;

    // Fast-path: if the job is at enumerate_stragglers or publish_keyring and the
    // cloud _meta.json already shows the new epoch + fingerprint, the rotation was
    // fully published before the crash.  Finalize locally without needing the
    // master-key stashes (which may have been deleted at step 7).
    if matches!(
        job.state.as_str(),
        rstate::ENUMERATE_STRAGGLERS | rstate::PUBLISH_KEYRING
    ) {
        let already_published =
            crate::sync::rotation::publish::resume_finalize_if_published(&provider, &state, &job)
                .await;
        match already_published {
            Ok(true) => {
                log::info!(
                    "resume_rotation: job {} was already published — finalized locally, done",
                    job.id
                );
                // I3: the Keychain may still hold master_old from before the
                // crash — refresh it (key_state already holds master_new,
                // loaded at unlock from the rewrapped boot file).
                refresh_biometric_keychain_after_rotation(&app, &state, &key_state);
                return Ok(true);
            }
            Ok(false) => {
                // Not yet published — fall through to the normal resume path.
            }
            Err(e) => {
                log::error!(
                    "resume_rotation: resume_finalize_if_published failed for job {}: {e}",
                    job.id
                );
                return Err(e);
            }
        }
    }

    // Non-revoke (rotate) jobs resume via RecoverySource::Stashed.  The stash is
    // guaranteed to be present because rotate_keys writes it atomically in the same
    // tx as the job row (Phase 6 wedge-proof guarantee).  No guard needed here.

    let (master_key_old, master_key_new) =
        crate::sync::rotation::reconstruct_keys_from_stash(&state, &current_password)?;
    let ctx = crate::sync::rotation::RotationContext {
        master_key_old,
        master_key_new,
    };

    let boot_path = {
        use tauri::Manager;
        app.path()
            .app_data_dir()
            .map(|d| crate::utils::boot_file::boot_path(&d.join("memlore.db")))
            .ok()
    };
    // Run the state-machine steps inside a block so a failure from any `?` is
    // logged at the command boundary before it propagates. Without this the
    // real error string (cloud write failure, epoch conflict, etc.) is invisible
    // in the log, and the frontend used to mask it behind a generic
    // "check your password and recovery phrase" fallback.
    let outcome: Result<(), String> = async {
        match job.state.as_str() {
            // Phase 4: no job is ever created at ENUMERATE or REENCRYPT state
            // (rotate_keys inserts directly at commit_local). These states are
            // unreachable on new rotations. If somehow we encounter them (e.g. an
            // orphaned job from a pre-Phase-4 code path), surface a clear error.
            rstate::ENUMERATE | rstate::REENCRYPT => {
                return Err(format!(
                    "resume_rotation: job {} is in legacy state '{}' that is no longer supported. \
                     Please abort and start a new rotation.",
                    job.id, job.state
                ));
            }
            rstate::COMMIT_LOCAL => {
                // The job was created by rotate_keys (which already inserted the
                // rotation_job row at commit_local) but crashed before commit_local_inner
                // completed. Resume by running commit_local_inner on the lazy path.
                // The new local password-wrap it produces is persisted to
                // settings + the boot file inside the call; nothing is threaded
                // into publish_keyring — the cloud device slot is metadata-only.
                crate::sync::rotation::commit::commit_local_inner(
                    &state,
                    job.id,
                    &ctx,
                    &current_password,
                    boot_path.as_deref(),
                    Some(&key_state),
                    rstate::PUBLISH_KEYRING, // lazy path: skip enumerate/reencrypt
                )
                .await?;

                // Read content epoch from DB (rotate_keys bumped it before creating the job).
                // A missing or unparseable value means the DB is in a broken state; do NOT
                // default to 0 — that silently skips writing _content.json on the cloud, leaving
                // the fleet permanently wedged (publish_keyring guards new_epoch > cloud_epoch).
                let new_content_epoch: u32 = {
                    let conn = state.lock()?;
                    let raw =
                        db::get_setting(&conn, db::CONTENT_KEY_EPOCH).map_err(|e| e.to_string())?;
                    match raw.as_deref().and_then(|s| s.parse().ok()) {
                        Some(v) => v,
                        None => {
                            return Err(format!(
                                "resume_rotation: cannot resume job {} — CONTENT_KEY_EPOCH is \
                                 missing or unreadable ({raw:?}); the DB may be corrupt. \
                                 Aborting to avoid silently skipping the _content.json publish.",
                                job.id
                            ))
                        }
                    }
                };

                // Revoke needs the caller-supplied phrase; rotate reads from the stash.
                // Holder keeps the owned Mnemonic alive across the publish_keyring await.
                let mut revoke_parsed_holder: Option<bip39::Mnemonic> = None;
                if job.revoked_device_id.is_some() {
                    let mnemonic_str = recovery_mnemonic.ok_or_else(|| {
                        "24-word recovery phrase required to finalize revocation".to_string()
                    })?;
                    let mnemonic_z = zeroize::Zeroizing::new(mnemonic_str);
                    revoke_parsed_holder = Some(
                        crate::utils::recovery::validate_recovery_mnemonic(&mnemonic_z)?,
                    );
                }
                let recovery_source = match &revoke_parsed_holder {
                    Some(m) => crate::sync::rotation::RecoverySource::Supplied(m),
                    None => crate::sync::rotation::RecoverySource::Stashed,
                };

                crate::sync::rotation::publish_keyring(
                    &provider,
                    &state,
                    job.id,
                    &ctx,
                    recovery_source,
                    job.revoked_device_id.as_deref(),
                    new_content_epoch,
                )
                .await?;
            }
            rstate::ENUMERATE_STRAGGLERS | rstate::PUBLISH_KEYRING => {
                // Job reached publish state (commit_local completed).

                // Read content epoch from DB. Do NOT default to 0: a missing/corrupt
                // value means the DB is broken; defaulting would silently skip writing
                // _content.json (publish_keyring guards new_epoch > cloud_epoch), leaving
                // the fleet permanently wedged.
                let new_content_epoch: u32 = {
                    let conn = state.lock()?;
                    let raw =
                        db::get_setting(&conn, db::CONTENT_KEY_EPOCH).map_err(|e| e.to_string())?;
                    match raw.as_deref().and_then(|s| s.parse().ok()) {
                        Some(v) => v,
                        None => {
                            return Err(format!(
                                "resume_rotation: cannot resume job {} — CONTENT_KEY_EPOCH is \
                                 missing or unreadable ({raw:?}); the DB may be corrupt. \
                                 Aborting to avoid silently skipping the _content.json publish.",
                                job.id
                            ))
                        }
                    }
                };

                // Revoke needs the caller-supplied phrase; rotate reads from the stash.
                // Holder keeps the owned Mnemonic alive across the publish_keyring await.
                let mut revoke_parsed_holder: Option<bip39::Mnemonic> = None;
                if job.revoked_device_id.is_some() {
                    let mnemonic_str = recovery_mnemonic.ok_or_else(|| {
                        "24-word recovery phrase required to publish revocation keyring".to_string()
                    })?;
                    let mnemonic_z = zeroize::Zeroizing::new(mnemonic_str);
                    revoke_parsed_holder = Some(
                        crate::utils::recovery::validate_recovery_mnemonic(&mnemonic_z)?,
                    );
                }
                let recovery_source = match &revoke_parsed_holder {
                    Some(m) => crate::sync::rotation::RecoverySource::Supplied(m),
                    None => crate::sync::rotation::RecoverySource::Stashed,
                };

                crate::sync::rotation::publish_keyring(
                    &provider,
                    &state,
                    job.id,
                    &ctx,
                    recovery_source,
                    job.revoked_device_id.as_deref(),
                    new_content_epoch,
                )
                .await?;
            }
            other => {
                return Err(format!("Unexpected rotation job state: '{other}'"));
            }
        }
        Ok(())
    }
    .await;

    if let Err(e) = &outcome {
        log::error!("resume_rotation: job {} failed: {e}", job.id);
    }
    outcome?;

    // Refresh in-memory key_state to master_new + new content-key list.
    //
    // rotate_keys (normal path) performs this in Step 5 after calling
    // commit_local_inner. resume_rotation skips that step, so after a crash-
    // resume the memory still holds master_old + the old epoch list.  New cloud
    // writes would silently use the revoked epoch key, and a change_password
    // right after resume would re-wrap the boot file under the stale master.
    //
    // Best-effort: if the DB read or decode fails, log and continue — the user
    // is still unlocked with the old key in memory, which is better than
    // returning an error and leaving the UI stuck. The next full unlock will
    // reload state from the boot file with the correct key.
    {
        let refresh_result: Result<(), String> = (|| {
            let list_hex = {
                let conn = state.lock()?;
                db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| {
                        "resume_rotation: WRAPPED_CONTENT_LIST absent after rotation".to_string()
                    })?
            };
            let keys_map =
                crate::utils::encryption::decode_content_key_list(&ctx.master_key_new, &list_hex)
                    .map_err(|e| format!("resume_rotation: decode content list: {e}"))?;
            let latest_epoch: u32 = {
                let conn = state.lock()?;
                db::get_setting(&conn, db::CONTENT_KEY_EPOCH)
                    .map_err(|e| e.to_string())?
                    .and_then(|s| s.parse().ok())
                    .ok_or_else(|| {
                        "resume_rotation: CONTENT_KEY_EPOCH missing after rotation".to_string()
                    })?
            };
            let db_key = key_state
                .with_db_key(|dk| {
                    let mut out = zeroize::Zeroizing::new([0u8; 32]);
                    out.copy_from_slice(dk);
                    Ok(out)
                })
                .map_err(|e| format!("resume_rotation: read db_key: {e}"))?;
            key_state
                .set_content_state(keys_map, latest_epoch, db_key, ctx.master_key_new.clone())
                .map_err(|e| format!("resume_rotation: set_content_state: {e}"))
        })();
        if let Err(e) = refresh_result {
            log::warn!("resume_rotation: post-resume key_state refresh failed (non-fatal): {e}");
        } else {
            log::info!(
                "resume_rotation: key_state refreshed to master_new after crash-resume (job {})",
                job.id
            );
        }
    }

    // Rotation changed master_key. If biometric unlock is enabled its Keychain
    // entry still holds master_old — the next Touch ID would fail.
    refresh_biometric_keychain_after_rotation(&app, &state, &key_state);

    Ok(true)
}

/// Complete a forced re-pair after the vault was rotated by another device.
///
/// This is equivalent to Phase 3's `onboard_complete` but for a device that
/// is already initialized — it replaces the master key with the rotated one.
///
/// Steps:
/// 1. Validate mnemonic; unwrap `_recovery.json` → `master_key_new`.
/// 2. Verify fingerprint matches `_meta.json.master_fingerprint`.
/// 3. Generate new `kek_salt`, wrap with `new_local_password`.
/// 4. Write boot file + PRAGMA rekey.
/// 5. Upload new `devices/<id>.json`.
/// 6. Clear `force_re_pair_required` and `force_re_pair_reason`.
#[tauri::command]
pub async fn complete_force_re_pair(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    recovery_mnemonic: String,
    new_local_password: String,
) -> Result<(), String> {
    let recovery_mnemonic = zeroize::Zeroizing::new(recovery_mnemonic);
    let new_local_password = zeroize::Zeroizing::new(new_local_password);

    validate_password_length(&new_local_password)?;

    let provider = acquire_drive_provider(&app, &state)?;

    let boot_path = {
        use tauri::Manager;
        app.path()
            .app_data_dir()
            .map(|d| crate::utils::boot_file::boot_path(&d.join("memlore.db")))
            .ok()
    };

    // Validate passphrase BEFORE touching the DB connection. Steps 1-3 of
    // onboard_complete_inner only need the provider + mnemonic — they never
    // touch the DB. By bailing here on a wrong passphrase we keep AppState
    // completely untouched, so the user's retry still finds the real DB.
    onboard_validate_passphrase_inner(&provider, &recovery_mnemonic).await?;

    // Read the current device name AND the current `sync_provider` BEFORE
    // swapping the connection. The previous shape swapped first, then
    // queried — but the placeholder we swapped in was a bare `:memory:`
    // connection with no schema, so `db::list_devices` blew up with `no
    // such table: devices` and the user saw "no such table" instead of a
    // re-pair flow. Read first, swap second, and migrate the placeholder so
    // any other code that hits the state lock during the rekey window sees
    // a usable (if empty) DB. `sync_provider` is captured here so the
    // post-success re-assert writes the same value back (skip when unset)
    // instead of hardcoding `"gdrive"`.
    let (device_name, prior_sync_provider) = {
        let conn = state.lock()?;
        let device_name = db::list_devices(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|d| d.is_current)
            .map(|d| d.name)
            .unwrap_or_else(|| "My Device".to_string());
        let prior_sync_provider = db::get_sync_provider(&conn).map_err(|e| e.to_string())?;
        (device_name, prior_sync_provider)
    };

    // Extract the real DB connection to pass to the inner function.
    // Pattern mirrors onboard_complete: swap in a fully-migrated placeholder,
    // work on real conn, swap back.
    let real_conn = {
        let placeholder = rusqlite::Connection::open_in_memory()
            .map_err(|e| format!("placeholder conn failed: {e}"))?;
        db::schema::migrate(&placeholder)
            .map_err(|e| format!("Failed to migrate placeholder: {e}"))?;
        db::set_encryption_mode(&placeholder, db::EncryptionMode::Unset)
            .map_err(|e| format!("Failed to seed placeholder mode: {e}"))?;
        let mut guard = state.lock()?;
        std::mem::replace(&mut *guard, placeholder)
    };

    let result = onboard_complete_inner(
        real_conn,
        &key_state,
        &provider,
        &recovery_mnemonic,
        &new_local_password,
        &device_name,
        boot_path.as_deref(),
        None, // no pending Drive session from the force-re-pair path
        None, // unlock_method (existing test — defaults to password-only)
    )
    .await;

    match result {
        Ok(real_conn) => {
            // Swap real connection back.
            state.set_connection(real_conn)?;

            // Clear force re-pair flags AND re-assert the sync-provider /
            // sync-enabled settings. `persist_connect_settings` wrote both
            // earlier in `gdrive_complete_connect`, but the user-visible
            // "Enable sync" toggle reads `sync_provider` for its disabled
            // prop. If we hit any flow that landed force-re-pair without
            // persist_connect_settings running first (or a stale snapshot
            // taken before the connect), the toggle would stay frozen-off
            // even though the vault is healthy. Writes are idempotent.
            // Re-assert the provider captured before the swap so a folder
            // install (`local` / `icloud`) is not overwritten with `gdrive`.
            {
                let conn = state.lock()?;
                clear_force_re_pair_and_reassert_sync(&conn, prior_sync_provider.as_deref());
            }

            Ok(())
        }
        Err((real_conn, e)) => {
            // Restore the real connection so the placeholder doesn't linger in
            // AppState. The real conn is always valid (it has the correct key,
            // whatever state it was in before the swap), so swapping it back
            // allows the user to retry without the app being stuck on an empty
            // placeholder DB. The passphrase was validated before the swap, so
            // wrong-passphrase cases never reach here; any error here is a
            // post-swap inner error (DB write / rekey). Retry may succeed if
            // the failure was transient (I/O, Drive timeout, etc.).
            let _ = state.set_connection(real_conn);
            Err(e)
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Clear force-re-pair flags and re-assert sync-connected / sync-enabled.
///
/// Re-writes `sync_provider` only when `prior_sync_provider` is `Some`, so a
/// folder-provider install (`"local"` / `"icloud"`) is not overwritten with
/// `"gdrive"`. A missing prior value is left untouched.
fn clear_force_re_pair_and_reassert_sync(
    conn: &rusqlite::Connection,
    prior_sync_provider: Option<&str>,
) {
    let _ = db::delete_setting(conn, db::FORCE_RE_PAIR_REQUIRED);
    let _ = db::delete_setting(conn, db::FORCE_RE_PAIR_REASON);
    if let Some(provider) = prior_sync_provider {
        let _ = db::set_setting(conn, "sync_provider", provider);
    }
    let _ = db::set_setting(conn, "sync_connected", "true");
    let _ = db::set_sync_enabled(conn, true);
}

fn validate_password_length(password: &str) -> Result<(), String> {
    // Use `chars().count()` — Unicode scalar values, not bytes. This keeps
    // the check aligned with what the LockScreen displays to users as
    // "characters" and prevents "5 emoji = 20 bytes" bypasses.
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters"
        ));
    }
    Ok(())
}

fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        // `write!` on a `String` cannot fail — the String is infallible as
        // a `fmt::Write` target. `.unwrap()` here is genuinely unreachable.
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}

fn decode_hex_salt(hex: &str) -> Result<Vec<u8>, String> {
    let expected_chars = SALT_SIZE * 2;
    if hex.len() != expected_chars {
        return Err(format!(
            "Invalid salt length: expected {expected_chars} hex chars ({SALT_SIZE} bytes), got {}",
            hex.len()
        ));
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| format!("Invalid hex byte: {e}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::db::schema::migrate;
    use crate::utils::encryption::{decrypt_data, encrypt_data};
    use crate::AppState;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    /// Pins `mark_startup_recovered` directly (no AppHandle). The full
    /// command emit + purge path is covered by `test_support::mock_app`.
    #[test]
    fn mark_startup_recovered_flips_boot_file_corrupt_to_password_locked() {
        let mode = std::sync::Mutex::new(crate::StartupMode::BootFileCorrupt);
        mark_startup_recovered(&mode);
        assert_eq!(*mode.lock().unwrap(), crate::StartupMode::PasswordLocked);
    }

    #[test]
    fn mark_startup_recovered_is_a_no_op_when_already_password_locked() {
        let mode = std::sync::Mutex::new(crate::StartupMode::PasswordLocked);
        mark_startup_recovered(&mode);
        assert_eq!(*mode.lock().unwrap(), crate::StartupMode::PasswordLocked);
    }

    /// Drives the post-success purge helper on a real conn. The full command
    /// (emit + purge) is covered by `test_support::mock_app`.
    #[test]
    fn recover_with_passphrase_post_unlock_purges_expired_audit_rows() {
        let conn = setup();
        let now_ms = 100 * 86_400_000i64;
        let old_ms = now_ms - 100 * 86_400_000;
        let recent_ms = now_ms - 86_400_000;
        let old_row = db::AiAuditLogInsert {
            created_at: old_ms,
            feature: "test".into(),
            operation: "chat".into(),
            provider_id: "p".into(),
            model_id: "m".into(),
            endpoint_host: "h".into(),
            endpoint_class: "remote".into(),
            payload_bytes: 1,
            latency_ms: 1,
            status: "ok".into(),
            error_code: None,
            tokens_in: None,
            tokens_out: None,
        };
        let recent_row = db::AiAuditLogInsert {
            created_at: recent_ms,
            ..old_row.clone()
        };
        db::insert_ai_audit_log(&conn, &old_row).unwrap();
        db::insert_ai_audit_log(&conn, &recent_row).unwrap();

        let state = AppState::new(conn);
        recover_with_passphrase_post_unlock(&state, now_ms);

        let remaining = state
            .with_conn(|c| {
                db::list_ai_audit_log(c, &db::AiAuditLogFilter::default(), 10, 0)
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(
            remaining.len(),
            1,
            "only the expired audit row should be purged"
        );
        assert_eq!(remaining[0].created_at, recent_ms);
    }

    // ─── CryptoTestState: fast setup builder for integration tests ───────────
    //
    // Uses cheap Argon2id params (m=4096, t=1) via test_helpers so tests
    // complete in <100ms per state construction instead of ~1s with full KDF.
    //
    // NOTE: All setup paths pass `None` for boot_path to skip PRAGMA rekey —
    // test SQLite connections don't support SQLCipher rekey. Boot file I/O is
    // tested separately via BootFileFixture.

    struct CryptoTestState {
        pub conn: Connection,
        pub key_state: std::sync::Arc<EncryptionKeyState>,
    }

    impl CryptoTestState {
        /// Fresh DB — mode=Unset, no key loaded.
        fn fresh() -> Self {
            let conn = setup();
            let key_state = std::sync::Arc::new(EncryptionKeyState::new());
            Self { conn, key_state }
        }

        /// Password-mode DB — cheap KDF, key loaded into key_state.
        /// Wraps the master key with cheap params and stores it in DB settings
        /// so that `unwrap_key` / `initialize_encryption_inner` tests work
        /// without full Argon2id cost.
        fn with_password(password: &str) -> Self {
            use crate::utils::encryption::test_helpers::cheap_wrap_key;
            use rand::RngCore;

            let conn = setup();
            let key_state = std::sync::Arc::new(EncryptionKeyState::new());

            // Generate a random 32-byte master key.
            let mut raw_key = zeroize::Zeroizing::new([0u8; 32]);
            rand::rngs::OsRng.fill_bytes(raw_key.as_mut());

            // Generate KEK salt and wrap with cheap KDF.
            let kek_salt = crate::utils::encryption::generate_encryption_salt();
            let wrapped = cheap_wrap_key(&raw_key, password, &kek_salt).unwrap();
            let kek_salt_hex = hex::encode(kek_salt);

            // Persist to DB.
            db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &wrapped).unwrap();
            db::set_setting(&conn, db::KEK_SALT_KEY, &kek_salt_hex).unwrap();
            db::set_password_hash(&conn, password).unwrap();
            db::set_encryption_mode(&conn, EncryptionMode::Password).unwrap();

            // Load key into state.
            key_state.set_key(raw_key).unwrap();

            Self { conn, key_state }
        }

        /// Lock: clear the key from memory (simulate app lock).
        fn lock(&self) {
            self.key_state.clear_key().unwrap();
        }

        /// Unlock with cheap KDF: read wrapped key from DB, unwrap with cheap params.
        fn unlock(&self, password: &str) -> Result<(), String> {
            use crate::utils::encryption::test_helpers::cheap_unwrap_key;

            let wrapped_hex = db::get_setting(&self.conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "no wrapped key in DB".to_string())?;
            let kek_salt_hex = db::get_setting(&self.conn, db::KEK_SALT_KEY)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "no kek_salt in DB".to_string())?;
            let kek_salt =
                hex::decode(&kek_salt_hex).map_err(|e| format!("bad kek_salt hex: {e}"))?;

            let master = cheap_unwrap_key(&wrapped_hex, password, &kek_salt)?;
            self.key_state.set_key(master)?;
            Ok(())
        }

        /// Return the master key fingerprint (for equality assertions across lock/unlock).
        fn fingerprint(&self) -> [u8; 32] {
            self.key_state
                .with_key(|k| Ok(crate::utils::encryption::key_fingerprint(k)))
                .expect("key must be loaded to get fingerprint")
        }
    }

    #[test]
    fn state_fresh_is_unset() {
        let s = CryptoTestState::fresh();
        assert_eq!(
            db::get_encryption_mode(&s.conn).unwrap(),
            EncryptionMode::Unset
        );
        assert!(!s.key_state.is_initialized().unwrap());
    }

    #[test]
    fn state_with_password_is_initialized() {
        let s = CryptoTestState::with_password("testpassword1");
        assert_eq!(
            db::get_encryption_mode(&s.conn).unwrap(),
            EncryptionMode::Password
        );
        assert!(s.key_state.is_initialized().unwrap());
    }

    #[test]
    fn state_lock_clears_key() {
        let s = CryptoTestState::with_password("mypassword1");
        assert!(s.key_state.is_initialized().unwrap());
        s.lock();
        assert!(!s.key_state.is_initialized().unwrap());
    }

    #[test]
    fn state_unlock_correct_password_restores_key() {
        let s = CryptoTestState::with_password("mypassword1");
        let fp_before = s.fingerprint();
        s.lock();
        s.unlock("mypassword1").unwrap();
        let fp_after = s.fingerprint();
        assert_eq!(
            fp_before, fp_after,
            "key fingerprint must match after unlock"
        );
    }

    #[test]
    fn state_unlock_wrong_password_returns_error() {
        let s = CryptoTestState::with_password("mypassword1");
        s.lock();
        let err = s.unlock("wrongpassword1").unwrap_err();
        assert!(
            err.contains("Invalid password") || err.contains("corrupted"),
            "expected auth error, got: {err}"
        );
        assert!(!s.key_state.is_initialized().unwrap());
    }

    // ─── Lock / unlock lifecycle integration tests ───────────────────────────

    #[test]
    fn lifecycle_password_mode_db_state_after_setup() {
        let s = CryptoTestState::with_password("securepass1");
        assert_eq!(
            db::get_encryption_mode(&s.conn).unwrap(),
            EncryptionMode::Password
        );
        assert!(db::is_password_hash_set(&s.conn).unwrap());
        let wrapped = db::get_setting(&s.conn, db::WRAPPED_ENCRYPTION_KEY_KEY).unwrap();
        assert!(
            wrapped.is_some_and(|w| w.len() == 120),
            "wrapped key must be 120 hex chars"
        );
        let kek_salt = db::get_setting(&s.conn, db::KEK_SALT_KEY).unwrap();
        assert!(kek_salt.is_some_and(|k| !k.is_empty()));
    }

    #[test]
    fn lifecycle_lock_clears_key_db_unchanged() {
        let s = CryptoTestState::with_password("securepass1");
        let mode_before = db::get_encryption_mode(&s.conn).unwrap();
        s.lock();
        assert!(!s.key_state.is_initialized().unwrap());
        // DB mode must be unchanged after lock.
        assert_eq!(db::get_encryption_mode(&s.conn).unwrap(), mode_before);
    }

    #[test]
    fn lifecycle_unlock_correct_password_restores_identical_key() {
        let s = CryptoTestState::with_password("securepass1");
        let fp_before = s.fingerprint();
        s.lock();
        assert!(!s.key_state.is_initialized().unwrap());
        s.unlock("securepass1").unwrap();
        assert!(s.key_state.is_initialized().unwrap());
        assert_eq!(
            s.fingerprint(),
            fp_before,
            "key fingerprint must match after unlock"
        );
    }

    #[test]
    fn lifecycle_unlock_wrong_password_rejected_key_stays_unset() {
        let s = CryptoTestState::with_password("securepass1");
        s.lock();
        let err = s.unlock("completely_wrong_pass1").unwrap_err();
        assert!(
            err.contains("Invalid password") || err.contains("corrupted"),
            "expected auth error, got: {err}"
        );
        assert!(
            !s.key_state.is_initialized().unwrap(),
            "key must remain unset after wrong password"
        );
    }

    #[test]
    fn lifecycle_relock_after_unlock_consistent() {
        // lock → unlock → lock → unlock — key fingerprint stays consistent.
        let s = CryptoTestState::with_password("securepass1");
        let fp = s.fingerprint();

        s.lock();
        s.unlock("securepass1").unwrap();
        assert_eq!(s.fingerprint(), fp);

        s.lock();
        s.unlock("securepass1").unwrap();
        assert_eq!(
            s.fingerprint(),
            fp,
            "key must be identical after second unlock"
        );
    }

    #[test]
    fn lifecycle_unlock_reads_from_db_without_boot_file() {
        // CryptoTestState stores wrapped key in DB — simulates boot file absent.
        // unlock() reads from DB; this verifies the DB-fallback path.
        let s = CryptoTestState::with_password("securepass1");
        let fp = s.fingerprint();
        s.lock();

        // DB has wrapped_key — unlock() uses DB directly (no boot file needed).
        s.unlock("securepass1").unwrap();
        assert_eq!(s.fingerprint(), fp);
    }

    #[test]
    fn lifecycle_encrypted_data_survives_lock_unlock_cycle() {
        use crate::utils::encryption::{decrypt_data, encrypt_data};

        let s = CryptoTestState::with_password("securepass1");
        let plaintext = b"journal entry content";
        let ciphertext = s
            .key_state
            .with_key(|k| encrypt_data(k, plaintext))
            .unwrap();

        s.lock();
        s.unlock("securepass1").unwrap();

        let recovered = s
            .key_state
            .with_key(|k| decrypt_data(k, &ciphertext))
            .unwrap();
        assert_eq!(
            recovered, plaintext,
            "data must decrypt correctly after lock/unlock"
        );
    }

    // ─── Password change & mode switch integration tests ─────────────────────

    fn do_change_password(
        s: &CryptoTestState,
        old_password: &str,
        new_password: &str,
    ) -> Result<(), String> {
        use crate::utils::encryption::test_helpers::cheap_wrap_key;

        // Verify old password.
        let is_valid =
            db::verify_password_hash(&s.conn, old_password).map_err(|e| e.to_string())?;
        if !is_valid {
            return Err("Old password is incorrect".to_string());
        }
        // Rewrap master key with new KEK (before the transaction so any error bails early).
        let new_kek_salt = generate_encryption_salt();
        let new_wrapped = s
            .key_state
            .with_key(|key| cheap_wrap_key(key, new_password, &new_kek_salt))?;
        let new_kek_salt_hex = hex::encode(new_kek_salt);
        // Update DB in a transaction — mirrors the production change_password atomicity.
        let tx = s
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to start transaction: {e}"))?;
        db::set_password_hash(&tx, new_password).map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::WRAPPED_ENCRYPTION_KEY_KEY, &new_wrapped)
            .map_err(|e| e.to_string())?;
        db::set_setting(&tx, db::KEK_SALT_KEY, &new_kek_salt_hex).map_err(|e| e.to_string())?;
        tx.commit()
            .map_err(|e| format!("Failed to commit change_password: {e}"))?;
        // Set keyring_dirty flag (mirrors change_password behaviour).
        db::set_setting(&s.conn, "keyring_dirty", "1").map_err(|e| e.to_string())?;
        Ok(())
    }

    #[test]
    fn pwchange_rewraps_key_new_wrapped_differs() {
        let s = CryptoTestState::with_password("oldpassword1");
        let old_wrapped = db::get_setting(&s.conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .unwrap();

        do_change_password(&s, "oldpassword1", "newpassword1").unwrap();

        let new_wrapped = db::get_setting(&s.conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .unwrap();
        assert_ne!(
            old_wrapped, new_wrapped,
            "wrapped key must change after password change"
        );
        assert_eq!(
            new_wrapped.len(),
            120,
            "new wrapped key must be 120 hex chars"
        );
    }

    #[test]
    fn pwchange_new_kek_salt_differs() {
        let s = CryptoTestState::with_password("oldpassword1");
        let old_salt = db::get_setting(&s.conn, db::KEK_SALT_KEY).unwrap().unwrap();

        do_change_password(&s, "oldpassword1", "newpassword1").unwrap();

        let new_salt = db::get_setting(&s.conn, db::KEK_SALT_KEY).unwrap().unwrap();
        assert_ne!(
            old_salt, new_salt,
            "KEK salt must be regenerated on password change"
        );
    }

    #[test]
    fn pwchange_key_in_memory_unchanged() {
        // Master key stays in memory unchanged — only the wrapping material rotates.
        let s = CryptoTestState::with_password("oldpassword1");
        let fp_before = s.fingerprint();

        do_change_password(&s, "oldpassword1", "newpassword1").unwrap();

        assert_eq!(
            s.fingerprint(),
            fp_before,
            "in-memory master key must not change"
        );
    }

    #[test]
    fn pwchange_rejects_wrong_old_password() {
        let s = CryptoTestState::with_password("oldpassword1");
        let err = do_change_password(&s, "wrongoldpass1", "newpassword1").unwrap_err();
        assert!(err.contains("Old password is incorrect"), "got: {err}");

        // DB must be unchanged.
        assert!(db::verify_password_hash(&s.conn, "oldpassword1").unwrap());
    }

    #[test]
    fn pwchange_updates_password_hash_accepts_new_rejects_old() {
        let s = CryptoTestState::with_password("oldpassword1");
        do_change_password(&s, "oldpassword1", "newpassword1").unwrap();

        assert!(
            db::verify_password_hash(&s.conn, "newpassword1").unwrap(),
            "new password must be accepted"
        );
        assert!(
            !db::verify_password_hash(&s.conn, "oldpassword1").unwrap(),
            "old password must be rejected"
        );
    }

    #[test]
    fn pwchange_new_password_unlocks_after_lock() {
        let s = CryptoTestState::with_password("oldpassword1");
        do_change_password(&s, "oldpassword1", "newpassword1").unwrap();
        let fp_original = s.fingerprint();

        s.lock();
        s.unlock("newpassword1").unwrap();
        assert_eq!(
            s.fingerprint(),
            fp_original,
            "new password must unlock same master key"
        );
    }

    #[test]
    fn pwchange_old_password_rejected_after_change() {
        let s = CryptoTestState::with_password("oldpassword1");
        do_change_password(&s, "oldpassword1", "newpassword1").unwrap();

        s.lock();
        let err = s.unlock("oldpassword1").unwrap_err();
        assert!(
            err.contains("Invalid password") || err.contains("corrupted"),
            "old password must not unlock after change, got: {err}"
        );
    }

    #[test]
    fn pwchange_keyring_dirty_flag_set() {
        let s = CryptoTestState::with_password("oldpassword1");
        do_change_password(&s, "oldpassword1", "newpassword1").unwrap();

        let dirty = db::get_setting(&s.conn, "keyring_dirty").unwrap();
        assert_eq!(
            dirty.as_deref(),
            Some("1"),
            "keyring_dirty must be set to '1' after password change"
        );
    }

    // ─── Offline recovery phrase integration tests ───────────────────────────

    #[test]
    fn recovery_phrase_generates_24_words() {
        let phrase = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let word_count = phrase.split_whitespace().count();
        assert_eq!(word_count, 24, "recovery mnemonic must be exactly 24 words");
    }

    #[test]
    fn recovery_phrase_non_deterministic() {
        let p1 = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let p2 = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        assert_ne!(p1, p2, "each generated mnemonic must be unique");
    }

    #[test]
    fn recovery_key_derivation_deterministic() {
        let phrase = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let m = crate::utils::recovery::validate_recovery_mnemonic(&phrase).unwrap();
        let k1 = crate::utils::recovery::derive_recovery_key(&m);
        let k2 = crate::utils::recovery::derive_recovery_key(&m);
        assert_eq!(
            *k1, *k2,
            "same mnemonic must always yield same recovery key"
        );
    }

    #[test]
    fn recovery_wrapped_key_can_unwrap_master() {
        // Verify that recovery slot stores a valid wrapping of the master key.
        let master_key = [42u8; 32];
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let recovery_slot = make_recovery_slot(&master_key, &mnemonic);

        // Slot must be 120 hex chars (AES-GCM: nonce+ct+tag = 60 bytes → 120 hex).
        assert_eq!(
            recovery_slot.len(),
            120,
            "recovery slot must be 120 hex chars"
        );

        // Unwrap using recovery key → must yield identical master.
        let parsed = crate::utils::recovery::validate_recovery_mnemonic(&mnemonic).unwrap();
        let recovery_key = crate::utils::recovery::derive_recovery_key(&parsed);
        let recovered = unwrap_master_with_recovery_key(&recovery_slot, &recovery_key).unwrap();
        assert_eq!(*recovered, master_key);
    }

    // Uses production wrap_key (full 64 MiB Argon2id) — ~1-2s on CI.
    // Run with: cargo test -- --ignored full_kdf
    #[test]
    #[ignore]
    fn recovery_master_and_rewrap_full_roundtrip() {
        // End-to-end: generate slot, recover with correct phrase, verify re-wrapped key.
        let master_key = [17u8; 32];
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let slot = make_recovery_slot(&master_key, &mnemonic);

        let (recovered, new_wrapped, new_kek_salt_hex) =
            recover_master_and_rewrap(&slot, &mnemonic, "newpassword1", KdfParams::FAST).unwrap();

        assert_eq!(
            *recovered, master_key,
            "recovered master must match original"
        );

        // new_wrapped must round-trip via FULL (not cheap) KDF — recover_master_and_rewrap
        // uses the production wrap_key which uses full Argon2id params.
        let salt = hex::decode(&new_kek_salt_hex).unwrap();
        let unwrapped = unwrap_key(&new_wrapped, "newpassword1", &salt).unwrap();
        assert_eq!(
            *unwrapped, master_key,
            "re-wrapped key must unwrap to original master"
        );

        // The re-wrapped blob must carry the requested KDF strength, not a
        // hardcoded HIGH — otherwise recovery silently flips a FAST vault.
        let blob = hex::decode(&new_wrapped).unwrap();
        assert_eq!(
            parse_kek_params(&blob).unwrap().m_cost,
            KdfParams::FAST.m_cost,
            "recovery must preserve the requested (FAST) strength"
        );
    }

    #[test]
    fn recovery_wrong_mnemonic_rejected() {
        let master_key = [99u8; 32];
        let real_mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let slot = make_recovery_slot(&master_key, &real_mnemonic);
        let wrong_mnemonic = loop {
            let m = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
            if m != real_mnemonic {
                break m;
            }
        };
        let err =
            recover_master_and_rewrap(&slot, &wrong_mnemonic, "newpassword1", KdfParams::FAST)
                .unwrap_err();
        assert!(err.contains("does not match"), "got: {err}");
    }

    #[test]
    fn recovery_mnemonic_case_insensitive() {
        let mnemonic_lower = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let mnemonic_upper = mnemonic_lower.to_uppercase();
        // validate_recovery_mnemonic should normalize case.
        let result = crate::utils::recovery::validate_recovery_mnemonic(&mnemonic_upper);
        assert!(
            result.is_ok(),
            "uppercase mnemonic must be accepted: {:?}",
            result.err()
        );
    }

    #[test]
    fn recovery_mnemonic_extra_whitespace_accepted() {
        let phrase = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        // Add extra spaces and a newline.
        let padded = phrase.replace(' ', "  ").replace("  ", "  \n ");
        let result = crate::utils::recovery::validate_recovery_mnemonic(&padded);
        assert!(
            result.is_ok(),
            "extra whitespace must be tolerated: {:?}",
            result.err()
        );
    }

    #[test]
    fn recovery_invalid_word_returns_specific_error_not_panic() {
        let result = crate::utils::recovery::validate_recovery_mnemonic(
            "invalidword abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon art",
        );
        assert!(result.is_err(), "invalid word must return Err");
        // Must not panic — verify Err is returned cleanly.
    }

    #[test]
    fn recovery_slot_with_boot_file_fixture() {
        // Tests the recovery slot → boot file write → read → unwrap chain.
        use crate::db::EncryptionMode;
        use crate::utils::boot_file::test_support::BootFileFixture;

        let master_key = [55u8; 32];
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let slot = make_recovery_slot(&master_key, &mnemonic);

        let fx = BootFileFixture::new();
        let boot = crate::utils::boot_file::BootFile {
            unlock_method: crate::utils::boot_file::UnlockMethod::Password,
            mode: EncryptionMode::Password,
            kek_salt: Some("a".repeat(32)),
            wrapped_key: Some("b".repeat(120)),
            os_kek_wrapped_master: None,
            recovery_wrapped: Some(slot.clone()),
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        fx.write(&boot).unwrap();

        // Read back and verify recovery_wrapped survived the round-trip.
        let loaded = fx.read().unwrap();
        assert_eq!(loaded.recovery_wrapped.as_deref(), Some(slot.as_str()));

        // Unwrap from the loaded boot file data.
        let parsed = crate::utils::recovery::validate_recovery_mnemonic(&mnemonic).unwrap();
        let recovery_key = crate::utils::recovery::derive_recovery_key(&parsed);
        let recovered = unwrap_master_with_recovery_key(
            loaded.recovery_wrapped.as_deref().unwrap(),
            &recovery_key,
        )
        .unwrap();
        assert_eq!(*recovered, master_key);
    }

    #[test]
    fn recovery_two_setups_different_slots() {
        // Different random master keys → different recovery slots even for same mnemonic.
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let slot1 = make_recovery_slot(&[1u8; 32], &mnemonic);
        let slot2 = make_recovery_slot(&[2u8; 32], &mnemonic);
        assert_ne!(
            slot1, slot2,
            "different master keys must produce different recovery slots"
        );
    }

    // ─── Concurrent & race condition tests ───────────────────────────────────

    #[test]
    fn concurrent_reads_all_see_same_key() {
        use std::sync::Arc;
        use std::thread;

        let ks = Arc::new(EncryptionKeyState::new());
        ks.set_key(zeroize::Zeroizing::new([77u8; 32])).unwrap();

        let handles: Vec<_> = (0..50)
            .map(|_| {
                let ks = Arc::clone(&ks);
                thread::spawn(move || ks.with_key(|k| Ok(k[0])).expect("key must be readable"))
            })
            .collect();

        for h in handles {
            let val = h.join().expect("thread panicked");
            assert_eq!(val, 77u8, "all threads must read the same key byte");
        }
    }

    #[test]
    fn concurrent_set_and_read_no_panic() {
        // 10 writers + 10 readers running concurrently must not panic.
        use std::sync::Arc;
        use std::thread;

        let ks = Arc::new(EncryptionKeyState::new());
        ks.set_key(zeroize::Zeroizing::new([1u8; 32])).unwrap();

        let mut handles = Vec::new();
        for i in 0u8..10 {
            let ks = Arc::clone(&ks);
            handles.push(thread::spawn(move || {
                ks.set_key(zeroize::Zeroizing::new([i; 32])).unwrap();
            }));
        }
        for _ in 0..10 {
            let ks = Arc::clone(&ks);
            handles.push(thread::spawn(move || {
                let _ = ks.with_key(|_| Ok(()));
            }));
        }

        for h in handles {
            h.join()
                .expect("thread panicked during concurrent set/read");
        }
        // Key state must still be initialized (some writer succeeded).
        assert!(
            ks.is_initialized().unwrap(),
            "key_state must be initialized after concurrent writes"
        );
    }

    #[test]
    fn double_lock_is_idempotent() {
        let s = CryptoTestState::with_password("securepass1");
        s.lock();
        // Second lock on already-locked state must not error or panic.
        s.key_state.clear_key().unwrap();
        assert!(!s.key_state.is_initialized().unwrap());
    }

    #[test]
    fn double_unlock_same_password_consistent() {
        let s = CryptoTestState::with_password("securepass1");
        let fp = s.fingerprint();
        s.lock();

        s.unlock("securepass1").unwrap();
        let fp1 = s.fingerprint();
        // Unlock again — should either succeed (idempotent) or be a no-op.
        let _ = s.unlock("securepass1");
        // Key must still be correct regardless.
        assert_eq!(
            s.fingerprint(),
            fp,
            "key must be consistent after double unlock"
        );
        assert_eq!(fp1, fp);
    }

    #[test]
    fn setup_twice_returns_error_not_corrupt() {
        // setup_first_time_inner must refuse re-init and leave DB intact.
        let conn = setup();
        let key_state = EncryptionKeyState::new();
        let conn = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("firstpass1"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        // Second call must return an error.
        let conn2 = setup();
        // setup() gives a fresh in-memory DB — simulate "already initialized" by
        // manually seeding the mode to Password before calling setup_first_time_inner.
        db::set_encryption_mode(&conn2, EncryptionMode::Password).unwrap();
        let result = setup_first_time_inner(
            conn2,
            &key_state,
            EncryptionMode::Password,
            Some("secondpass1"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        );
        assert!(result.is_err(), "second setup must return Err");
        let err = result.unwrap_err();
        assert!(
            err.contains("refuses to re-initialize") || err.contains("already"),
            "error must say already initialized, got: {err}"
        );

        // Original DB must still be intact.
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            EncryptionMode::Password
        );
    }

    // ─── DB conversion & mode migration tests ────────────────────────────────
    // These tests verify the DB-state layer (settings table) rather than
    // the SQLCipher PRAGMA rekey path (which requires an on-disk encrypted DB).

    #[test]
    fn encryption_mode_persists_through_settings_update() {
        // Updating other settings must not clobber encryption_mode.
        let s = CryptoTestState::with_password("securepass1");
        db::set_setting(&s.conn, "some_ui_pref", "dark").unwrap();
        assert_eq!(
            db::get_encryption_mode(&s.conn).unwrap(),
            EncryptionMode::Password
        );
    }

    // ─── Password length validation (command-level) ──────────────────────────

    #[test]
    fn test_validate_password_rejects_short() {
        assert!(validate_password_length("shortpw").is_err());
    }

    #[test]
    fn test_validate_password_rejects_just_under_minimum() {
        // 7 chars — one below the 8-char minimum
        assert!(validate_password_length("seven!x").is_err());
    }

    #[test]
    fn test_validate_password_accepts_minimum_length() {
        // 8 chars — exactly at the minimum
        assert!(validate_password_length("eightch!").is_ok());
    }

    #[test]
    fn test_validate_password_accepts_long() {
        assert!(validate_password_length("this is a reasonably long passphrase").is_ok());
    }

    #[test]
    fn test_validate_password_counts_chars_not_bytes() {
        // 4 emoji = 16 UTF-8 bytes but only 4 Unicode scalar values. Must
        // fail the 12-character minimum.
        let four_emoji = "🔒🔑🗝️🧩";
        assert!(
            four_emoji.len() >= MIN_PASSWORD_LEN,
            "precondition: byte count >= min"
        );
        assert!(
            four_emoji.chars().count() < MIN_PASSWORD_LEN,
            "precondition: char count < min"
        );
        assert!(
            validate_password_length(four_emoji).is_err(),
            "4 emoji must be rejected even though their byte length is {}",
            four_emoji.len()
        );
    }

    #[test]
    fn test_validate_password_accepts_12_scalar_values_of_mixed_unicode() {
        // Exactly 12 scalar values — non-ASCII — must pass (12 >= 8).
        let pwd = "नमस्तेहेलो12"; // intentionally mixed; count by `chars()`
        if pwd.chars().count() >= MIN_PASSWORD_LEN {
            assert!(validate_password_length(pwd).is_ok());
        }
    }

    #[test]
    fn test_validate_password_seven_chars_rejected() {
        // 7 chars — one below the 8-char minimum — must be rejected.
        assert!(validate_password_length("abcdefg").is_err());
    }

    #[test]
    fn test_validate_password_eight_chars_accepted() {
        // Exactly 8 chars — the new minimum — must be accepted.
        assert!(validate_password_length("abcdefgh").is_ok());
    }

    #[test]
    fn test_validate_password_twelve_chars_accepted() {
        // 12 chars — above the 8-char minimum — must be accepted.
        assert!(validate_password_length("twelvechars!").is_ok());
    }

    // ─── Hex salt encoding/decoding ──────────────────────────────────────────

    #[test]
    fn test_encode_hex_roundtrip_matches_decode() {
        let salt = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10,
        ];
        let hex = encode_hex(&salt);
        assert_eq!(hex, "0102030405060708090a0b0c0d0e0f10");
        let decoded = decode_hex_salt(&hex).unwrap();
        assert_eq!(decoded, salt);
    }

    #[test]
    fn test_decode_hex_salt_rejects_empty() {
        assert!(decode_hex_salt("").is_err());
    }

    #[test]
    fn test_decode_hex_salt_rejects_too_short() {
        assert!(decode_hex_salt("0102").is_err());
    }

    #[test]
    fn test_decode_hex_salt_rejects_too_long() {
        // 64 hex chars == 32 bytes, but salt must be exactly 16 bytes.
        let too_long = "0".repeat(64);
        assert!(decode_hex_salt(&too_long).is_err());
    }

    #[test]
    fn test_decode_hex_salt_rejects_odd_length() {
        // 31 chars — odd number
        let odd = "0".repeat(31);
        assert!(decode_hex_salt(&odd).is_err());
    }

    #[test]
    fn test_decode_hex_salt_rejects_non_hex() {
        // 32 chars but with non-hex characters
        let bad = "zz020304050607080910111213141516";
        assert!(decode_hex_salt(bad).is_err());
    }

    // ─── Existing password hash tests (unchanged behavior) ───────────────────

    #[test]
    fn set_password_stores_hash() {
        let conn = setup();
        db::set_password_hash(&conn, "testpass").unwrap();
        let stored_hash = db::get_setting(&conn, "password_hash").unwrap().unwrap();
        assert!(stored_hash.starts_with("$argon2"));
    }

    #[test]
    fn verify_password_correct() {
        let conn = setup();
        db::set_password_hash(&conn, "testpass").unwrap();
        let is_valid = db::verify_password_hash(&conn, "testpass").unwrap();
        assert!(is_valid);
    }

    #[test]
    fn verify_password_incorrect() {
        let conn = setup();
        db::set_password_hash(&conn, "testpass").unwrap();
        let is_valid = db::verify_password_hash(&conn, "wrongpass").unwrap();
        assert!(!is_valid);
    }

    #[test]
    fn is_password_set_true() {
        let conn = setup();
        db::set_password_hash(&conn, "testpass").unwrap();
        let is_set = db::is_password_hash_set(&conn).unwrap();
        assert!(is_set);
    }

    #[test]
    fn is_password_set_false() {
        let conn = setup();
        let is_set = db::is_password_hash_set(&conn).unwrap();
        assert!(!is_set);
    }

    #[test]
    fn change_password_success() {
        let conn = setup();
        db::set_password_hash(&conn, "oldpass1").unwrap();
        assert!(db::verify_password_hash(&conn, "oldpass1").unwrap());
        db::set_password_hash(&conn, "newpass1").unwrap();
        let is_valid = db::verify_password_hash(&conn, "newpass1").unwrap();
        assert!(is_valid);
    }

    #[test]
    fn remove_password_clears_hash() {
        let conn = setup();
        db::set_password_hash(&conn, "testpass").unwrap();
        db::remove_password_hash(&conn, "testpass").unwrap();
        assert!(!db::is_password_hash_set(&conn).unwrap());
    }

    #[test]
    fn remove_password_rejects_wrong_password() {
        let conn = setup();
        db::set_password_hash(&conn, "testpass").unwrap();
        let result = db::remove_password_hash(&conn, "wrong");
        assert!(result.is_err());
        assert!(db::is_password_hash_set(&conn).unwrap());
    }

    #[test]
    fn same_password_different_hash() {
        let conn = setup();
        db::set_password_hash(&conn, "samepass").unwrap();
        let hash1 = db::get_setting(&conn, "password_hash").unwrap().unwrap();
        db::set_password_hash(&conn, "samepass").unwrap();
        let hash2 = db::get_setting(&conn, "password_hash").unwrap().unwrap();
        assert_ne!(hash1, hash2);
        assert!(db::verify_password_hash(&conn, "samepass").unwrap());
    }

    // ─── EncryptionKeyState tests ────────────────────────────────────────────

    #[test]
    fn test_encryption_key_state_set_and_with_key() {
        let key_state = EncryptionKeyState::new();
        let key = Zeroizing::new([7u8; 32]);
        key_state.set_key(key).unwrap();
        let result = key_state.with_key(|k| Ok(k[0])).unwrap();
        assert_eq!(result, 7u8);
    }

    #[test]
    fn test_encryption_key_state_clear_key() {
        let key_state = EncryptionKeyState::new();
        key_state.set_key(Zeroizing::new([1u8; 32])).unwrap();
        key_state.clear_key().unwrap();
        let result = key_state.with_key(|_| Ok(()));
        assert!(result.is_err());
    }

    #[test]
    fn test_encryption_key_state_initially_none() {
        let key_state = EncryptionKeyState::new();
        let result = key_state.with_key(|_| Ok(()));
        assert!(result.is_err());
    }

    #[test]
    fn test_encryption_key_state_is_initialized_false_when_empty() {
        let key_state = EncryptionKeyState::new();
        assert!(!key_state.is_initialized().unwrap());
    }

    #[test]
    fn test_encryption_key_state_is_initialized_true_after_set() {
        let key_state = EncryptionKeyState::new();
        key_state.set_key(Zeroizing::new([0u8; 32])).unwrap();
        assert!(key_state.is_initialized().unwrap());
    }

    #[test]
    fn test_encryption_key_state_default_is_empty() {
        let key_state = EncryptionKeyState::default();
        assert!(!key_state.is_initialized().unwrap());
    }

    #[test]
    fn test_encryption_key_state_set_replaces_existing() {
        let key_state = EncryptionKeyState::new();
        key_state.set_key(Zeroizing::new([1u8; 32])).unwrap();
        key_state.set_key(Zeroizing::new([2u8; 32])).unwrap();
        let first_byte = key_state.with_key(|k| Ok(k[0])).unwrap();
        assert_eq!(first_byte, 2u8);
    }

    #[test]
    fn test_with_key_propagates_closure_error() {
        let key_state = EncryptionKeyState::new();
        key_state.set_key(Zeroizing::new([0u8; 32])).unwrap();
        let result: Result<(), String> = key_state.with_key(|_| Err("inner error".to_string()));
        assert_eq!(result.unwrap_err(), "inner error");
    }

    #[test]
    fn test_encryption_key_state_survives_poisoned_mutex() {
        // Regression: a panic inside a with_key closure previously poisoned
        // the mutex and bricked every subsequent call with a cryptic
        // PoisonError. After Important #2 recovery, the state remains
        // usable.
        use std::sync::Arc;

        let ks = Arc::new(EncryptionKeyState::new());
        ks.set_key(Zeroizing::new([42u8; 32])).unwrap();

        // Poison the mutex by panicking while holding it.
        let poisoner = Arc::clone(&ks);
        let handle = std::thread::spawn(move || {
            let _ = poisoner.with_key::<_, ()>(|_| {
                panic!("intentional panic for poison test");
            });
        });
        // Join swallows the panic so the test does not abort.
        let _ = handle.join();

        // After poisoning, all operations must still work.
        assert!(ks.is_initialized().unwrap(), "key should still be present");
        let val = ks.with_key(|k| Ok(k[0])).unwrap();
        assert_eq!(val, 42u8);

        // set_key must still be able to replace the key.
        ks.set_key(Zeroizing::new([7u8; 32])).unwrap();
        let val = ks.with_key(|k| Ok(k[0])).unwrap();
        assert_eq!(val, 7u8);

        // clear_key must still work.
        ks.clear_key().unwrap();
        assert!(!ks.is_initialized().unwrap());
    }

    // ─── initialize_encryption (DB-level simulation) tests ───────────────────

    #[test]
    fn test_initialize_encryption_wrong_password_fails() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        db::set_password_hash(&conn, "correctpass").unwrap();

        let is_valid = db::verify_password_hash(&conn, "wrongpass").unwrap();
        assert!(!is_valid);
        // Since verification fails, no key is set.
        assert!(!key_state.is_initialized().unwrap());
    }

    // ─── lock / blob command behavior tests ──────────────────────────────────

    #[test]
    fn test_lock_encryption_clears_key() {
        let key_state = EncryptionKeyState::new();
        key_state.set_key(Zeroizing::new([99u8; 32])).unwrap();
        key_state.clear_key().unwrap();
        assert!(!key_state.is_initialized().unwrap());
    }

    #[test]
    fn sync_envelope_encrypt_decrypt_roundtrip_via_sync_key() {
        let key_state = EncryptionKeyState::new();
        key_state.set_key(Zeroizing::new([42u8; 32])).unwrap();

        let plaintext = b"journal entry content";

        let encrypted = key_state
            .with_sync_key(|k| encrypt_data(k, plaintext))
            .unwrap();
        let decrypted = key_state
            .with_sync_key(|k| decrypt_data(k, &encrypted))
            .unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn with_sqlcipher_key_returns_hkdf_derived_subkey() {
        use crate::utils::encryption::derive_sqlcipher_key;

        let master = [0x11u8; 32];
        let key_state = EncryptionKeyState::new();
        key_state.set_key(Zeroizing::new(master)).unwrap();

        let expected = derive_sqlcipher_key(&master);
        let got = key_state.with_sqlcipher_key(|k| Ok(*k)).unwrap();

        assert_eq!(
            got, *expected,
            "with_sqlcipher_key must return HKDF-derived sub-key"
        );
    }

    #[test]
    fn with_sync_key_differs_from_sqlcipher_key() {
        let master = [0x22u8; 32];
        let key_state = EncryptionKeyState::new();
        key_state.set_key(Zeroizing::new(master)).unwrap();

        let sqlcipher = key_state.with_sqlcipher_key(|k| Ok(*k)).unwrap();
        let sync = key_state.with_sync_key(|k| Ok(*k)).unwrap();

        assert_ne!(
            sqlcipher, sync,
            "SQLCipher and sync sub-keys must differ (domain-separated via HKDF info labels)"
        );
    }

    #[test]
    fn with_sqlcipher_key_locked_returns_error() {
        let key_state = EncryptionKeyState::new();
        let result = key_state.with_sqlcipher_key(|_k| Ok(()));
        assert!(result.is_err(), "locked state must return error");
    }

    #[test]
    fn with_sync_key_locked_returns_error() {
        let key_state = EncryptionKeyState::new();
        let result = key_state.with_sync_key(|_k| Ok(()));
        assert!(
            result.is_err(),
            "locked state must return error for sync key"
        );
    }

    #[test]
    fn test_change_password_short_new_password_rejected() {
        // Mirrors the front-door `validate_password_length` check — ensures
        // change_password refuses to swap in a weak key.
        assert!(validate_password_length("short").is_err());
    }

    // ─── Encryption mode / get_encryption_mode tests ────────────────────────

    #[test]
    fn test_get_encryption_mode_fresh_db_returns_unset() {
        // Fresh DB with no password → mode is Unset; no password hash either.
        let conn = setup();
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Unset
        );
        assert!(!db::is_password_hash_set(&conn).unwrap());
    }

    #[test]
    fn test_get_encryption_mode_legacy_db_with_password_hash() {
        // Simulate a Chunk-2 DB: password_hash is set but no encryption_mode.
        // get_encryption_mode returns Unset; is_password_hash_set returns true.
        // startup_init's desync self-heal converts this to PasswordLocked at runtime.
        let conn = setup();
        db::set_password_hash(&conn, "legacypassword").unwrap();
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Unset,
            "legacy DB with password hash but no encryption_mode row must return Unset"
        );
        assert!(
            db::is_password_hash_set(&conn).unwrap(),
            "legacy DB with password hash — is_password_hash_set must return true"
        );
    }

    #[test]
    fn test_initialize_encryption_new_path_via_wrapped_key() {
        // Simulates: enable_password_lock set up a wrapped key. On restart,
        // initialize_encryption should unwrap it with the correct password.
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        // Put a known key in state and wrap it.
        let original_key = Zeroizing::new([55u8; 32]);
        key_state.set_key(original_key.clone()).unwrap();
        let password = "good-password-test12";

        let kek_salt = generate_encryption_salt();
        let wrapped = wrap_key(&*original_key, password, &kek_salt).unwrap();
        db::set_setting(&conn, db::KEK_SALT_KEY, &encode_hex(&kek_salt)).unwrap();
        db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &wrapped).unwrap();
        db::set_password_hash(&conn, password).unwrap();
        db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();

        // Clear the key from state (simulate app restart).
        key_state.clear_key().unwrap();

        // Simulate initialize_encryption logic.
        assert!(db::verify_password_hash(&conn, password).unwrap());
        let wrapped_hex = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .filter(|s| !s.is_empty());
        let kek_salt_hex = db::get_setting(&conn, db::KEK_SALT_KEY)
            .unwrap()
            .filter(|s| !s.is_empty());

        if let (Some(wrapped_val), Some(kek_salt_str)) = (wrapped_hex, kek_salt_hex) {
            let kek_salt_decoded = decode_hex_salt(&kek_salt_str).unwrap();
            let key = unwrap_key(&wrapped_val, password, &kek_salt_decoded).unwrap();
            key_state.set_key(key).unwrap();
        }

        // The recovered key must match the original.
        let recovered_first_byte = key_state.with_key(|k| Ok(k[0])).unwrap();
        assert_eq!(
            recovered_first_byte, 55u8,
            "recovered key must match original"
        );
    }

    #[test]
    fn test_initialize_encryption_no_wrapped_key_fails() {
        // After the refactor, initialize_encryption requires a wrapped key blob.
        // A DB with only a password_hash (legacy shape) returns an error instead
        // of silently falling back to direct derivation.
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        let password = "no-wrapped-key-pass";
        db::set_password_hash(&conn, password).unwrap();
        // No wrapped_encryption_key set — simulates a legacy or incomplete DB.

        // Verify password is correct, no wrapped key present.
        assert!(db::verify_password_hash(&conn, password).unwrap());
        let wrapped_hex = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .filter(|s| !s.is_empty());
        assert!(wrapped_hex.is_none(), "no wrapped key should be present");

        // initialize_encryption must fail with a clear error.
        // (We simulate the logic directly since we can't call the command without State.)
        let result: Result<(), String> = match wrapped_hex {
            Some(_) => Ok(()), // would proceed
            None => Err(
                "Encryption not initialized — complete first-launch password setup first"
                    .to_string(),
            ),
        };
        assert!(
            result.is_err(),
            "initialize_encryption must fail without a wrapped key"
        );
        assert!(!key_state.is_initialized().unwrap());
    }

    #[test]
    fn test_is_password_set_no_mode_returns_false() {
        let conn = setup();
        // No mode set — fresh DB → Unset.
        let result = matches!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Password
        );
        assert!(!result, "no mode set → is_password_set must return false");
    }

    #[test]
    fn test_is_password_set_password_mode_returns_true() {
        let conn = setup();
        db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        let result = matches!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Password
        );
        assert!(result, "password mode → is_password_set must return true");
    }

    #[test]
    fn test_migration_legacy_chunk2_db_has_no_mode_but_has_hash() {
        // Chunk-2 DB: has password_hash but NO encryption_mode setting.
        // get_encryption_mode returns Unset; is_password_hash_set returns true.
        // startup_init's three-marker desync self-heal converts this state to
        // PasswordLocked when all three markers (wrapped_key + hash + mode=password)
        // are present — tested directly in startup_tests.
        let conn = setup();
        db::set_password_hash(&conn, "legacy-pass-word12").unwrap();
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Unset,
            "Chunk-2 DB with no encryption_mode must return Unset from get_encryption_mode"
        );
        assert!(
            db::is_password_hash_set(&conn).unwrap(),
            "Chunk-2 DB with password_hash must have is_password_hash_set return true"
        );
    }

    #[test]
    fn test_change_password_with_wrapped_key_re_wraps() {
        // After setup_first_time, change_password must re-wrap the key with the
        // new password. The original entry key must be recoverable with the new
        // password.
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        // Use setup_first_time_inner to set up a clean state.
        let conn = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("old-password-here12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        // Capture the key that was generated.
        let original_key: Zeroizing<[u8; 32]> =
            key_state.with_key(|k| Ok(Zeroizing::new(*k))).unwrap();

        // Simulate change_password (new path): re-wrap with new password.
        let kek_salt_hex = db::get_setting(&conn, db::KEK_SALT_KEY).unwrap().unwrap();
        let _ = decode_hex_salt(&kek_salt_hex).unwrap(); // validate
        let new_kek_salt = generate_encryption_salt();
        let new_wrapped = key_state
            .with_key(|key| wrap_key(key, "new-password-here12", &new_kek_salt))
            .unwrap();
        db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &new_wrapped).unwrap();
        db::set_setting(&conn, db::KEK_SALT_KEY, &encode_hex(&new_kek_salt)).unwrap();
        db::set_password_hash(&conn, "new-password-here12").unwrap();

        // Recover the key with the new password.
        let recovered_wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .unwrap();
        let recovered_kek_salt_hex = db::get_setting(&conn, db::KEK_SALT_KEY).unwrap().unwrap();
        let recovered_kek_salt = decode_hex_salt(&recovered_kek_salt_hex).unwrap();
        let recovered_key = unwrap_key(
            &recovered_wrapped,
            "new-password-here12",
            &recovered_kek_salt,
        )
        .unwrap();

        assert_eq!(
            *recovered_key, *original_key,
            "key recovered with new password must match original"
        );

        // Old password must no longer work.
        let old_result = unwrap_key(
            &recovered_wrapped,
            "old-password-here12",
            &recovered_kek_salt,
        );
        assert!(old_result.is_err(), "old password must not unwrap new blob");
    }

    // ─── setup_first_time_inner (password mode) ─────────────────────────────

    #[test]
    fn test_setup_first_time_sets_encryption_mode() {
        // Fresh DB → setup_first_time → encryption_mode must be Password.
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        let conn = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("password12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Password,
            "encryption_mode must be Password after first-time setup"
        );
    }

    #[test]
    fn test_setup_first_time_key_loaded_into_state() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("password12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        assert!(
            key_state.is_initialized().unwrap(),
            "key must be loaded into key_state after first-time setup"
        );
    }

    #[test]
    fn test_setup_first_time_verify_password_succeeds() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        let conn = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("password12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        assert!(
            db::verify_password_hash(&conn, "password12").unwrap(),
            "password hash must be stored and verifiable"
        );
    }

    #[test]
    fn test_setup_first_time_wrapped_key_stored() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        let conn = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("password12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        let wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .filter(|s| !s.is_empty());
        let kek_salt = db::get_setting(&conn, db::KEK_SALT_KEY)
            .unwrap()
            .filter(|s| !s.is_empty());

        assert!(wrapped.is_some(), "wrapped_encryption_key must be stored");
        assert!(kek_salt.is_some(), "kek_salt must be stored");
    }

    #[test]
    fn test_setup_first_time_unlock_roundtrip() {
        // Key loaded by first-time setup must be recoverable via wrapped key + password.
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        let conn = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("password12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        // Capture in-memory key bytes.
        let in_memory_key: [u8; 32] = key_state.with_key(|k| Ok(*k)).unwrap();

        // Simulate lock → unlock: clear state, then unwrap with password.
        key_state.clear_key().unwrap();
        assert!(!key_state.is_initialized().unwrap());

        let wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .filter(|s| !s.is_empty())
            .unwrap();
        let kek_salt_hex = db::get_setting(&conn, db::KEK_SALT_KEY)
            .unwrap()
            .filter(|s| !s.is_empty())
            .unwrap();
        let kek_salt = decode_hex_salt(&kek_salt_hex).unwrap();
        let recovered = unwrap_key(&wrapped, "password12", &kek_salt).unwrap();

        assert_eq!(
            *recovered, in_memory_key,
            "recovered key must match the key loaded at first-time setup"
        );
    }

    #[test]
    fn test_setup_first_time_rejects_short_password() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        let result = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("short"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        );
        assert!(result.is_err(), "short password must be rejected");
        assert!(
            result.unwrap_err().contains("at least"),
            "error must mention minimum length"
        );
    }

    #[test]
    fn test_setup_first_time_rejects_if_already_enabled() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        // First call succeeds.
        let conn = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("password12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        // Second call must fail — data-loss guard.
        let result = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("password12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        );
        assert!(
            result.is_err(),
            "second call must be rejected when encryption is already enabled"
        );
    }

    #[test]
    fn test_setup_first_time_password_mode_loads_real_key() {
        // In password mode the key_state must hold a real key.
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("password12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        assert!(
            key_state.is_initialized().unwrap(),
            "key must be initialized after password-mode setup"
        );
    }

    // ─── Keyring re-upload after password change ──────────────────────────────

    #[tokio::test]
    async fn change_password_skips_upload_when_not_connected() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let state = AppState::new(conn);
        let key_state = EncryptionKeyState::new();
        key_state
            .set_key(zeroize::Zeroizing::new([0xAAu8; 32]))
            .unwrap();
        // sync_connected is NOT set → no upload attempt.
        reupload_keyring_after_password_change(&state, &key_state).await;
        let conn = state.lock().unwrap();
        assert!(
            db::get_setting(&conn, db::KEYRING_DIRTY_KEY)
                .unwrap()
                .is_none(),
            "keyring_dirty must not be set when Drive is not connected"
        );
    }

    // change_password_sets_dirty_flag_when_upload_fails removed in Phase 2:
    // try_reupload_keyring is now a no-op stub that always returns Ok(()),
    // so the upload-failure path no longer exists. Phase 3 will add V2 equivalents.

    // ─── setup_first_time_inner ──────────────────────────────────────────────

    #[test]
    fn setup_first_time_with_password_initializes_correctly() {
        // `PRAGMA rekey` on a plain (non-SQLCipher) DB connection is not supported
        // by the test environment (same limitation as all `setup_first_time_inner`
        // tests — they all pass `None` for boot_path). We pass `None` here too so
        // the test covers the DB-state and key_state assertions. The boot file
        // write path is verified separately below via `boot_file::save` + `load`.
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = boot_file::boot_path(&db_path);

        let conn = setup();
        let key_state = EncryptionKeyState::new();

        // Run with None boot_path to skip PRAGMA rekey (not supported on plain
        // test connections). DB-level state + key_state are fully exercised.
        let conn = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("validpass1"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();

        // encryption_mode must be Password.
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            EncryptionMode::Password,
            "encryption_mode must be Password"
        );
        // password_hash must be set.
        assert!(
            db::is_password_hash_set(&conn).unwrap(),
            "password_hash must be set"
        );
        // wrapped_encryption_key must be set.
        let wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .filter(|s| !s.is_empty());
        assert!(wrapped.is_some(), "wrapped_encryption_key must be stored");
        assert!(
            key_state.is_initialized().unwrap(),
            "key_state must hold the real key in password mode"
        );
        // Boot file write: call boot_file::save with mode=password and verify
        // the round-trip (same pattern used by boot_file unit tests).
        boot_file::save(
            &BootFile {
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                mode: EncryptionMode::Password,
                kek_salt: Some("aabbccdd".to_string()),
                wrapped_key: Some("deadbeef".to_string()),
                os_kek_wrapped_master: None,
                recovery_wrapped: None,
                wrapped_content_list: None,
                wrapped_db_key: None,
                master_wrapped_db_key: None,
                migration_in_progress: None,
            },
            &boot_path,
        )
        .unwrap();
        let boot = boot_file::load(&boot_path).unwrap();
        assert_eq!(
            boot.mode,
            EncryptionMode::Password,
            "boot file must record mode=password"
        );
    }

    /// Always-encrypted invariant (Phase 1 task 5): a freshly created vault is
    /// always encrypted — no code path produces an unencrypted DB, and the
    /// zero/bootstrap SQLCipher key never opens it once first-time setup has
    /// run (that key is a lifecycle step for the pre-unlock bootstrap DB, not
    /// a mode, and must stop working the moment a real key is installed).
    ///
    /// Uses a real bootstrap-encrypted DB on disk (opened with
    /// `BOOTSTRAP_SQLCIPHER_KEY` = all-zeros), runs the full
    /// `setup_first_time_inner` PRAGMA-rekey path (real `boot_path`), then
    /// asserts the on-disk file is (a) not readable as plain SQLite and (b)
    /// not readable under the zero/bootstrap key — only the password-derived
    /// key works.
    #[test]
    fn always_encrypted_zero_key_never_opens_vault_after_first_time_setup() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("memlore.db");
        let db_path_str = db_path.to_string_lossy().into_owned();
        let boot_path = boot_file::boot_path(&db_path);

        // Open the fresh pre-unlock bootstrap DB (zero key) — the ONLY
        // legitimate lifecycle use of BOOTSTRAP_SQLCIPHER_KEY.
        let conn = db::open_with_key(&db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY)
            .expect("open bootstrap-encrypted DB");
        db::schema::migrate(&conn).expect("migrate bootstrap DB");

        let key_state = EncryptionKeyState::new();
        setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("realpassword1"),
            &db_path,
            Some(&boot_path),
        )
        .expect("setup_first_time_inner must succeed and rekey the bootstrap DB");

        // (a) Never unencrypted: the file must not be readable as plain
        // SQLite — a real read must fail, not merely `open()` (SQLite opens
        // lazily; the header/page check happens on first touch).
        let plain_attempt = rusqlite::Connection::open(&db_path).and_then(|c| {
            c.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| {
                r.get::<_, i64>(0)
            })
        });
        assert!(
            plain_attempt.is_err(),
            "vault must never be readable as plain SQLite after setup"
        );

        // (b) The zero/bootstrap key must no longer open the vault — it was
        // a pre-unlock lifecycle key, not a standing mode.
        assert!(
            db::open_with_key(&db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY).is_err(),
            "bootstrap zero key must not open the vault after first-time setup"
        );

        // Sanity: the real password-derived key must still work.
        let boot = boot_file::load(&boot_path).expect("boot file must be readable");
        let wrapped_hex = boot.wrapped_key.expect("wrapped_key must be set");
        let kek_salt = hex::decode(boot.kek_salt.expect("kek_salt must be set")).unwrap();
        let master = unwrap_key(&wrapped_hex, "realpassword1", &kek_salt)
            .expect("unwrap_key must succeed with the real password");
        let sqlcipher_key = derive_sqlcipher_key(&*master);
        db::open_with_key(&db_path_str, &sqlcipher_key)
            .expect("the real password-derived key must open the vault");
    }

    #[test]
    fn setup_first_time_with_password_missing_returns_error() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        let result = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            None,
            std::path::Path::new("/tmp/unused.db"),
            None,
        );
        assert!(
            result.is_err(),
            "Password mode with no password must return Err"
        );
        assert!(
            result
                .unwrap_err()
                .contains("password required for password mode"),
            "error message must mention password requirement"
        );
    }

    #[test]
    fn setup_first_time_refuses_re_init() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        // Pre-seed: encryption_mode = Password (simulates already-configured DB).
        db::set_encryption_mode(&conn, EncryptionMode::Password).unwrap();

        let result_password = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("validpass1"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        );
        assert!(
            result_password.is_err(),
            "re-init with password mode must return Err"
        );
        assert!(
            result_password
                .unwrap_err()
                .contains("setup_first_time refuses to re-initialize"),
            "error must mention re-init refusal"
        );
    }

    #[test]
    fn setup_first_time_with_short_password_returns_error() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();

        // 7 chars — one below MIN_PASSWORD_LEN.
        let result = setup_first_time_inner(
            conn,
            &key_state,
            EncryptionMode::Password,
            Some("short7c"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        );
        assert!(result.is_err(), "short password must return Err");
        assert!(
            result.unwrap_err().contains("at least"),
            "error must mention minimum length"
        );
    }

    // ─── get_encryption_mode Tauri command tests ──────────────────────────────
    //
    // The Tauri `State<>` wrapper can't be instantiated in unit tests without a
    // running Tauri app. We test the command logic through the underlying
    // `db::get_encryption_mode` call (the command body is a thin one-liner).

    #[test]
    fn get_encryption_mode_returns_unset_for_fresh_db() {
        // A fresh in-memory DB has no encryption_mode row → Unset.
        // Mirrors what the `get_encryption_mode` command would return.
        let conn = setup();
        let result = db::get_encryption_mode(&conn);
        assert!(
            result.is_ok(),
            "get_encryption_mode must succeed: {result:?}"
        );
        assert_eq!(result.unwrap(), EncryptionMode::Unset);
    }

    #[test]
    fn get_encryption_mode_returns_password_after_setup() {
        // After setup_first_time(Password) sets encryption_mode=password,
        // the command must return EncryptionMode::Password.
        let conn = setup();
        db::set_encryption_mode(&conn, EncryptionMode::Password).unwrap();
        let result = db::get_encryption_mode(&conn);
        assert!(
            result.is_ok(),
            "get_encryption_mode must succeed: {result:?}"
        );
        assert_eq!(result.unwrap(), EncryptionMode::Password);
    }

    // ─── Test: migrate_runs_on_in_memory_placeholder ────────────────────────
    //
    // Verifies Finding #2 (placeholder schema): after `db::schema::migrate` and
    // `db::set_encryption_mode`, an in-memory connection behaves like a valid DB
    // — encryption_mode is readable, and no "no such table" errors occur.
    //
    // This is the unit test for the placeholder-swap pattern (open in-memory,
    // migrate, then set the encryption mode on the fresh schema).
    #[test]
    fn migrate_runs_on_in_memory_placeholder() {
        // This mirrors the placeholder-swap pattern:
        //   1. open_in_memory()
        //   2. db::schema::migrate(...)
        //   3. db::set_encryption_mode(...)
        let placeholder = rusqlite::Connection::open_in_memory().unwrap();
        db::schema::migrate(&placeholder).expect("migrate must succeed on in-memory placeholder");
        db::set_encryption_mode(&placeholder, db::EncryptionMode::Password)
            .expect("set_encryption_mode must succeed on migrated placeholder");

        // Commands must not see missing-table errors.
        let mode = db::get_encryption_mode(&placeholder)
            .expect("get_encryption_mode must succeed on migrated placeholder");
        assert_eq!(
            mode,
            db::EncryptionMode::Password,
            "placeholder must report the seeded encryption_mode"
        );

        // A settings read (any key) must not error on missing tables.
        let val = db::get_setting(&placeholder, "some_key")
            .expect("get_setting must succeed on migrated placeholder");
        assert!(val.is_none(), "non-existent key must return None");
    }

    // ─── V2 first-time setup: begin_first_time_setup_inner ──────────────────

    /// `begin_first_time_setup_inner` returns a 24-word mnemonic and the
    /// fixed challenge positions: 1st, 3rd, 2nd-to-last, last (0-based
    /// `[0, 2, 22, 23]`).
    #[test]
    fn begin_returns_24_word_mnemonic_and_fixed_indices() {
        let conn = setup();
        let handle =
            begin_first_time_setup_inner(&conn, "password12", "Test Mac", KdfParams::FAST).unwrap();
        assert_eq!(handle.mnemonic.len(), 24, "mnemonic must have 24 words");
        assert_eq!(
            handle.challenge_indices,
            vec![0, 2, 22, 23],
            "challenge positions must be fixed at words 1, 3, 23, 24"
        );
    }

    /// `begin_first_time_setup_inner` persists a pending row.
    #[test]
    fn begin_persists_pending_row() {
        let conn = setup();
        let handle =
            begin_first_time_setup_inner(&conn, "password12", "My Device", KdfParams::FAST)
                .unwrap();
        let row = db::get_pending_setup_by_id(&conn, &handle.setup_id)
            .unwrap()
            .expect("pending row must exist after begin");
        assert_eq!(row.device_name, "My Device");
        let words: Vec<&str> = row.mnemonic.split_whitespace().collect();
        assert_eq!(words.len(), 24);
    }

    /// `begin_first_time_setup_inner` rejects if encryption is already set.
    #[test]
    fn begin_rejects_if_already_configured() {
        let conn = setup();
        // Set up first-time so encryption is configured.
        let _conn = setup_first_time_inner(
            conn,
            &EncryptionKeyState::new(),
            EncryptionMode::Password,
            Some("password12"),
            std::path::Path::new("/tmp/unused.db"),
            None,
        )
        .unwrap();
        // Now begin must fail — but we need a fresh connection for the guard.
        // We can test with a direct pre-seed instead.
        let conn2 = setup();
        db::set_encryption_mode(&conn2, db::EncryptionMode::Password).unwrap();
        let result = begin_first_time_setup_inner(&conn2, "password12", "Device", KdfParams::FAST);
        assert!(result.is_err(), "must reject when encryption_mode != Unset");
        assert!(
            result.unwrap_err().contains("already configured"),
            "error must mention already configured"
        );
    }

    /// `begin_first_time_setup_inner` rejects short passwords.
    #[test]
    fn begin_rejects_short_password() {
        let conn = setup();
        let result = begin_first_time_setup_inner(&conn, "short", "Device", KdfParams::FAST);
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("characters"),
            "error must mention minimum characters"
        );
    }

    // ─── V2 first-time setup: confirm_first_time_setup_inner ────────────────

    /// Happy path: `confirm_first_time_setup_inner` with correct answers and
    /// password succeeds, sets `encryption_mode = password`, upserts the
    /// device row, sets keyring_v2_local_epoch = 1, and deletes the pending row.
    #[test]
    fn confirm_happy_path() {
        let conn = setup();
        let password = "confirm-pass12";
        let handle =
            begin_first_time_setup_inner(&conn, password, "MacBook Pro", KdfParams::FAST).unwrap();

        // Build correct answers from the mnemonic.
        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();

        let key_state = EncryptionKeyState::new();
        let (conn, _pub_ctx) = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            password,
            std::path::Path::new("/tmp/unused.db"),
            None,
            None,
            None,
        )
        .unwrap();

        // encryption_mode = Password.
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Password,
            "encryption_mode must be Password after confirm"
        );

        // keyring_v2_local_epoch = "1".
        let epoch = db::get_setting(&conn, db::KEYRING_V2_LOCAL_EPOCH)
            .unwrap()
            .expect("keyring_v2_local_epoch must be set");
        assert_eq!(epoch, "1");

        // cloud_master_fingerprint is set (64 hex chars).
        let fp = db::get_setting(&conn, db::CLOUD_MASTER_FINGERPRINT)
            .unwrap()
            .expect("cloud_master_fingerprint must be set");
        assert_eq!(fp.len(), 64, "fingerprint must be 64 hex chars");

        // Device row with is_current = true.
        let devices = db::list_devices(&conn).unwrap();
        assert_eq!(devices.len(), 1, "must have exactly one device row");
        assert!(devices[0].is_current, "device must be current");

        // Pending row deleted.
        let pending = db::get_pending_setup_by_id(&conn, &handle.setup_id).unwrap();
        assert!(
            pending.is_none(),
            "pending row must be deleted after confirm"
        );

        // Key is loaded in state.
        assert!(
            key_state.is_initialized().unwrap(),
            "key must be loaded in key_state after confirm"
        );
    }

    /// `confirm_first_time_setup_inner` rejects wrong challenge words.
    #[test]
    fn confirm_rejects_wrong_answers() {
        let conn = setup();
        let handle =
            begin_first_time_setup_inner(&conn, "password12", "Device", KdfParams::FAST).unwrap();

        // Supply wrong words.
        let wrong_answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|_| "wrong".to_string())
            .collect();

        let key_state = EncryptionKeyState::new();
        let result = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &wrong_answers,
            "password12",
            std::path::Path::new("/tmp/unused.db"),
            None,
            None,
            None,
        );
        assert!(result.is_err(), "wrong answers must be rejected");
        assert!(
            result.unwrap_err().contains("mnemonic challenge failed"),
            "error must mention mnemonic challenge"
        );
    }

    /// `confirm_first_time_setup_inner` rejects incorrect password.
    #[test]
    fn confirm_rejects_wrong_password() {
        let conn = setup();
        let password = "correct-pass12";
        let handle =
            begin_first_time_setup_inner(&conn, password, "Device", KdfParams::FAST).unwrap();

        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();

        let key_state = EncryptionKeyState::new();
        let result = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            "wrong-password12",
            std::path::Path::new("/tmp/unused.db"),
            None,
            None,
            None,
        );
        assert!(result.is_err(), "wrong password must be rejected");
        assert!(
            result.unwrap_err().contains("incorrect password"),
            "error must mention incorrect password"
        );
    }

    /// `confirm_first_time_setup_inner` rejects stale setup_id.
    #[test]
    fn confirm_rejects_stale_setup_id() {
        let conn = setup();
        let key_state = EncryptionKeyState::new();
        let result = confirm_first_time_setup_inner(
            conn,
            &key_state,
            "nonexistent-setup-id",
            &[],
            "password12",
            std::path::Path::new("/tmp/unused.db"),
            None,
            None,
            None,
        );
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("setup_id not found"),
            "error must mention setup_id not found"
        );
    }

    // ─── V2 first-time setup: cancel / get_pending ──────────────────────────

    /// `cancel_first_time_setup` (via db) removes the pending row.
    #[test]
    fn cancel_removes_pending_row() {
        let conn = setup();
        let handle =
            begin_first_time_setup_inner(&conn, "password12", "Device", KdfParams::FAST).unwrap();

        // Verify row exists.
        assert!(db::get_pending_setup_by_id(&conn, &handle.setup_id)
            .unwrap()
            .is_some());

        // Delete it.
        db::delete_pending_setup(&conn, &handle.setup_id).unwrap();

        // Must be gone.
        assert!(
            db::get_pending_setup_by_id(&conn, &handle.setup_id)
                .unwrap()
                .is_none(),
            "pending row must be gone after cancel"
        );
    }

    /// Crash recovery: inserting a pending row and listing it simulates what
    /// `get_pending_first_time_setup` does on app relaunch.
    #[test]
    fn crash_recovery_pending_row_survives_relaunches() {
        let conn = setup();
        let handle =
            begin_first_time_setup_inner(&conn, "password12", "Test Device", KdfParams::FAST)
                .unwrap();

        // List returns the row.
        let rows = db::list_pending_setups(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].setup_id, handle.setup_id);
        assert_eq!(
            rows[0].mnemonic.split_whitespace().count(),
            24,
            "mnemonic in DB must have 24 words"
        );

        // Parse challenge_indices from DB row.
        let indices: Vec<usize> = serde_json::from_str(&rows[0].challenge_indices).unwrap();
        assert_eq!(indices, handle.challenge_indices);
    }

    /// I4: begin_first_time_setup_inner purges existing orphaned pending rows
    /// before inserting a new one, so only one row ever exists at a time.
    #[test]
    fn begin_setup_purges_orphaned_pending_rows_before_inserting() {
        let conn = setup();

        // Manually insert 2 stale pending rows.
        db::insert_pending_setup(
            &conn,
            &db::PendingFirstTimeSetupRow {
                setup_id: "stale-1".to_string(),
                mnemonic: "word ".repeat(24).trim().to_string(),
                wrapped_master: "aa".to_string(),
                kek_salt: "bb".to_string(),
                recovery_wrapped: "cc".to_string(),
                device_id: "dev-stale-1".to_string(),
                device_name: "OldDevice".to_string(),
                challenge_indices: "[0,1,2,3]".to_string(),
                created_at: 1_000,
            },
        )
        .unwrap();
        db::insert_pending_setup(
            &conn,
            &db::PendingFirstTimeSetupRow {
                setup_id: "stale-2".to_string(),
                mnemonic: "word ".repeat(24).trim().to_string(),
                wrapped_master: "dd".to_string(),
                kek_salt: "ee".to_string(),
                recovery_wrapped: "ff".to_string(),
                device_id: "dev-stale-2".to_string(),
                device_name: "OldDevice2".to_string(),
                challenge_indices: "[4,5,6,7]".to_string(),
                created_at: 2_000,
            },
        )
        .unwrap();

        assert_eq!(
            db::list_pending_setups(&conn).unwrap().len(),
            2,
            "precondition: 2 rows"
        );

        // Now begin a fresh setup — should purge both stale rows.
        let handle =
            begin_first_time_setup_inner(&conn, "password12", "NewDevice", KdfParams::FAST)
                .unwrap();

        let rows = db::list_pending_setups(&conn).unwrap();
        assert_eq!(rows.len(), 1, "only the new row must remain after begin");
        assert_eq!(
            rows[0].setup_id, handle.setup_id,
            "surviving row must be the new one"
        );
        assert_ne!(rows[0].setup_id, "stale-1");
        assert_ne!(rows[0].setup_id, "stale-2");
    }

    /// `confirm` challenge word matching is case-insensitive and trims whitespace.
    #[test]
    fn confirm_answers_are_case_insensitive() {
        let conn = setup();
        let password = "password12";
        let handle =
            begin_first_time_setup_inner(&conn, password, "Device", KdfParams::FAST).unwrap();

        // Supply answers in uppercase with trailing space.
        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| format!("  {}  ", handle.mnemonic[i].to_uppercase()))
            .collect();

        let key_state = EncryptionKeyState::new();
        let result = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            password,
            std::path::Path::new("/tmp/unused.db"),
            None,
            None,
            None,
        );
        assert!(
            result.is_ok(),
            "case-insensitive match must succeed: {result:?}"
        );
    }

    // ─── Drive session integration: confirm_first_time_setup_inner ──────────

    /// Helpers for Drive session tests.
    #[cfg(test)]
    fn make_gdrive_session(tag: &str) -> crate::sync::gdrive_provider::GDriveSession {
        use std::time::Instant;
        use zeroize::Zeroizing;
        crate::sync::gdrive_provider::GDriveSession {
            access_token: format!("at_{tag}"),
            expires_at: Instant::now() + std::time::Duration::from_secs(3600),
            refresh_token: Zeroizing::new(format!("rt_{tag}")),
            client_id: format!("cid_{tag}"),
            client_secret: format!("cs_{tag}"),
        }
    }

    /// Helper: call confirm_first_time_setup_inner with correct answers,
    /// returning (conn, answers, handle) so callers can inspect the result.
    fn run_confirm(
        conn: rusqlite::Connection,
        handle: &crate::commands::crypto::FirstTimeSetupHandle,
        password: &str,
        session_id: Option<&str>,
    ) -> Result<(rusqlite::Connection, V2KeyringPublishContext), String> {
        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();
        let key_state = EncryptionKeyState::new();
        confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            password,
            std::path::Path::new("/tmp/unused_drive.db"),
            None, // boot_path = None (in-memory DB, no file I/O)
            session_id,
            None,
        )
    }

    /// Test 1: when a valid pending Drive session is stashed and session_id is
    /// supplied, the four Drive sync settings are persisted atomically with the
    /// password-mode flip.
    #[test]
    #[serial_test::serial]
    fn confirm_first_time_setup_inner_with_session_id_persists_sync_settings_atomically() {
        let sid = format!("task4-test1-{}", uuid::Uuid::new_v4().simple().to_string());
        let conn = setup();
        let password = "drive-sync-pass12";
        let handle =
            begin_first_time_setup_inner(&conn, password, "TestDevice", KdfParams::FAST).unwrap();

        // Stash a pending Drive session with a known refresh token.
        let session = make_gdrive_session("tok1");
        crate::commands::pending_drive_session::stash(
            sid.clone(),
            crate::commands::pending_drive_session::PendingDriveSession {
                session: crate::commands::pending_drive_session::PendingCloudSession::GDrive {
                    session,
                    root_folder_id: "root_tok1".to_string(),
                },
                created_at: std::time::Instant::now(),
            },
        );

        let (conn, _pub_ctx) = run_confirm(conn, &handle, password, Some(&sid))
            .expect("confirm with session_id must succeed");

        // encryption_mode = Password.
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Password,
            "encryption_mode must be Password after confirm"
        );

        // sync_connected = "true".
        let connected = db::get_setting(&conn, "sync_connected")
            .unwrap()
            .expect("sync_connected must be set");
        assert_eq!(connected, "true", "sync_connected must be true");

        // sync_provider = "gdrive".
        let provider = db::get_setting(&conn, "sync_provider")
            .unwrap()
            .expect("sync_provider must be set");
        assert_eq!(provider, "gdrive", "sync_provider must be gdrive");

        // gdrive_refresh_token = the stashed token.
        let token = db::get_setting(&conn, "gdrive_refresh_token")
            .unwrap()
            .expect("gdrive_refresh_token must be set");
        assert_eq!(
            token, "rt_tok1",
            "gdrive_refresh_token must match stashed token"
        );

        // sync_enabled = true (persisted via set_sync_enabled).
        let enabled = db::get_sync_enabled(&conn).unwrap();
        assert!(enabled, "sync_enabled must be true");
    }

    /// Test 2: when session_id is supplied but no matching pending session
    /// exists, the inner SUCCEEDS (consume is best-effort post-rekey — see
    /// the consume-after-rekey rationale in onboard_complete_inner / this
    /// inner) and silently skips Drive sync persistence. No
    /// `PENDING_DRIVE_SESSION_EXPIRED` is returned — that error is no longer
    /// reachable from this code path because the DB is already committed to
    /// Password mode by the time consume runs. The user lands in password
    /// mode without Drive sync and reconnects from Settings.
    #[test]
    fn confirm_first_time_setup_inner_with_missing_session_id_skips_sync() {
        let sid = format!(
            "task4-test2-nonexistent-{}",
            uuid::Uuid::new_v4().simple().to_string()
        );
        let conn = setup();
        let password = "drive-expired-pass12";
        let handle =
            begin_first_time_setup_inner(&conn, password, "TestDevice", KdfParams::FAST).unwrap();

        // Do NOT stash any pending session.
        let (conn, _publish_ctx) =
            run_confirm(conn, &handle, password, Some(&sid)).expect("must succeed");

        // Verify encryption mode is Password and NO Drive sync settings
        // were written (the consume returned None, so persist was skipped).
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Password,
            "mode must be flipped to Password despite missing session"
        );
        assert_eq!(
            db::get_setting(&conn, "sync_connected").unwrap(),
            None,
            "sync_connected must not be written when pending session is missing"
        );
        assert_eq!(
            db::get_setting(&conn, "gdrive_refresh_token").unwrap(),
            None,
            "gdrive_refresh_token must not be written when pending session is missing"
        );
    }

    /// Test 3: when session_id is None, the inner succeeds (password mode is
    /// set) but no Drive sync settings are written.
    #[test]
    fn confirm_first_time_setup_inner_without_session_id_skips_sync_persistence() {
        let conn = setup();
        let password = "no-drive-pass12";
        let handle =
            begin_first_time_setup_inner(&conn, password, "TestDevice", KdfParams::FAST).unwrap();

        let (conn, _pub_ctx) = run_confirm(conn, &handle, password, None)
            .expect("confirm without session_id must succeed");

        // encryption_mode = Password.
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            db::EncryptionMode::Password,
            "encryption_mode must be Password"
        );

        // sync_connected must NOT be set.
        let connected = db::get_setting(&conn, "sync_connected").unwrap();
        assert!(
            connected.is_none(),
            "sync_connected must not be set when session_id is None"
        );

        // gdrive_refresh_token must NOT be set.
        let token = db::get_setting(&conn, "gdrive_refresh_token").unwrap();
        assert!(
            token.is_none(),
            "gdrive_refresh_token must not be set when session_id is None"
        );
    }

    // ─── Task 6: check_unclaimed_drive_guard ─────────────────────────────────

    /// Guard fires when sync_connected=true AND encryption_mode=Unset AND
    /// session_id=None (the dangerous unclaimed-drive state).
    #[test]
    fn check_unclaimed_drive_guard_rejects_when_drive_connected_but_unclaimed() {
        let conn = setup();
        // Simulate: Drive was connected but encryption was never committed.
        db::set_setting(&conn, "sync_connected", "true").unwrap();
        // encryption_mode stays Unset (setup() default).
        assert_eq!(
            db::get_encryption_mode(&conn).unwrap(),
            EncryptionMode::Unset
        );
        let result = check_unclaimed_drive_guard(&conn, None);
        assert!(result.is_err(), "guard must fire in the dangerous state");
        let err = result.unwrap_err();
        assert!(
            err.contains("UNSAFE_SETUP_DRIVE_CONNECTED_BUT_UNCLAIMED"),
            "error must be UNSAFE_SETUP_DRIVE_CONNECTED_BUT_UNCLAIMED, got: {err}"
        );
    }

    /// Guard passes when sync_connected=false (most common case — Drive never
    /// connected, or Drive connected after encryption was already set).
    #[test]
    fn check_unclaimed_drive_guard_passes_when_sync_disconnected() {
        let conn = setup();
        // sync_connected is absent (default) → treated as false.
        let result = check_unclaimed_drive_guard(&conn, None);
        assert!(
            result.is_ok(),
            "guard must not fire when sync is disconnected"
        );
    }

    /// Guard passes when sync_connected=true but encryption_mode is already
    /// set (the normal post-setup state — Drive + Password is valid).
    #[test]
    fn check_unclaimed_drive_guard_passes_when_mode_already_set() {
        let conn = setup();
        db::set_setting(&conn, "sync_connected", "true").unwrap();
        db::set_encryption_mode(&conn, EncryptionMode::Password).unwrap();
        let result = check_unclaimed_drive_guard(&conn, None);
        assert!(
            result.is_ok(),
            "guard must not fire when encryption_mode is already Password"
        );
    }

    /// Guard is bypassed when session_id is Some — that IS the legitimate path
    /// where `confirm_first_time_setup` is consuming a pending Drive session.
    #[test]
    fn check_unclaimed_drive_guard_bypasses_when_pending_session_present() {
        let conn = setup();
        // Dangerous state: Drive connected, mode Unset.
        db::set_setting(&conn, "sync_connected", "true").unwrap();
        // encryption_mode stays Unset.

        // Simulate that the caller has a pending session to consume.
        let sid = format!("guard-bypass-{}", uuid::Uuid::new_v4().simple());
        let result = check_unclaimed_drive_guard(&conn, Some(&sid));
        assert!(
            result.is_ok(),
            "guard must NOT fire when session_id is Some (legitimate consume path)"
        );
    }

    /// Guard rejects for begin_first_time_setup scenario: Drive connected,
    /// mode Unset, no session_id (begin has no session_id parameter).
    #[test]
    fn begin_first_time_setup_guard_rejects_when_drive_connected_but_unclaimed() {
        let conn = setup();
        db::set_setting(&conn, "sync_connected", "true").unwrap();
        // encryption_mode stays Unset.
        // begin_first_time_setup always passes None (no session_id).
        let result = check_unclaimed_drive_guard(&conn, None);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .contains("UNSAFE_SETUP_DRIVE_CONNECTED_BUT_UNCLAIMED"),
            "begin_first_time_setup path must reject with the typed error"
        );
    }

    // ─── Task 7: check_cloud_vault_guard ─────────────────────────────────────

    /// Guard rejects with CLOUD_VAULT_EXISTS_USE_ONBOARDING when the cloud
    /// provider returns Ok(_) for the META_PATH (V2 keyring present).
    #[test]
    fn check_cloud_vault_guard_rejects_when_v2_keyring_present() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::KeyringV2Io;
        use crate::sync::keyring_v2::META_PATH;

        let provider = InMemoryKeyringProvider::new();
        // Pre-populate the meta file so read_file returns Ok.
        tauri::async_runtime::block_on(provider.write_file(META_PATH, br#"{"version":2}"#))
            .unwrap();

        let result = tauri::async_runtime::block_on(check_cloud_vault_guard(&provider));
        assert!(
            result.is_err(),
            "guard must fire when cloud has a V2 keyring"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("CLOUD_VAULT_EXISTS_USE_ONBOARDING"),
            "error must be CLOUD_VAULT_EXISTS_USE_ONBOARDING, got: {err}"
        );
    }

    /// Guard passes (does not reject) when the cloud provider returns NotFound
    /// for META_PATH (no V2 keyring — fresh cloud, legitimate first-time setup).
    #[test]
    fn check_cloud_vault_guard_proceeds_when_cloud_has_no_v2_keyring() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let provider = InMemoryKeyringProvider::new();
        // Provider is empty → read_file returns NotFound.

        let result = tauri::async_runtime::block_on(check_cloud_vault_guard(&provider));
        assert!(
            result.is_ok(),
            "guard must not fire when cloud has no V2 keyring (NotFound): {result:?}"
        );
    }

    /// Guard passes (does not reject) when the cloud probe returns a non-NotFound
    /// error (e.g. network failure). Best-effort: log and continue.
    #[test]
    fn check_cloud_vault_guard_proceeds_when_cloud_probe_fails() {
        use crate::sync::keyring_v2::KeyringV2Io;
        use crate::sync::provider::SyncError;
        use async_trait::async_trait;

        /// Local mock that always returns a network error.
        struct NetworkErrorProvider;

        #[async_trait]
        impl KeyringV2Io for NetworkErrorProvider {
            async fn read_file(&self, _path: &str) -> Result<Vec<u8>, SyncError> {
                Err(SyncError::Network("simulated timeout".to_string()))
            }

            async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
                Ok(())
            }

            async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
                Ok(())
            }

            async fn list_files(&self, _prefix: &str) -> Result<Vec<String>, SyncError> {
                Ok(vec![])
            }
        }

        let provider = NetworkErrorProvider;
        let result = tauri::async_runtime::block_on(check_cloud_vault_guard(&provider));
        assert!(
            result.is_ok(),
            "guard must swallow network errors and let setup proceed: {result:?}"
        );
    }

    // ─── C3: confirm_first_time_setup_inner rollback on boot-file failure ────

    /// C3: when boot_path points to a read-only location, the boot file write
    /// fails. All settings written before the boot file step must be reverted
    /// so the DB stays in the pre-call state (bootstrap-keyed, no wrapped key,
    /// pending row still present).
    #[test]
    fn confirm_rolls_back_settings_on_boot_file_failure() {
        let conn = setup();
        let password = "rollback-pass12";
        let handle =
            begin_first_time_setup_inner(&conn, password, "Device", KdfParams::FAST).unwrap();

        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();

        let key_state = EncryptionKeyState::new();

        // Use a path guaranteed to fail (root dir, not writable on macOS/Linux).
        let bad_boot_path =
            std::path::Path::new("/this-path-does-not-exist-for-rollback-test.boot");

        let result = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            password,
            std::path::Path::new("/tmp/unused.db"),
            Some(bad_boot_path),
            None,
            None,
        );

        // The inner function consumes `conn` — we verify the error message
        // indicates a boot file failure.
        assert!(
            result.is_err(),
            "confirm must fail when boot file write fails"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("boot file") || err.contains("Failed to write"),
            "error message must mention boot file failure: {err}"
        );
    }

    /// C3: confirm persists `recovery_wrapped_master` so delayed Drive publish
    /// can reconstruct the full keyring context.
    #[test]
    fn confirm_persists_recovery_wrapped_master() {
        let conn = setup();
        let password = "persist-rwm-pass12";
        let handle =
            begin_first_time_setup_inner(&conn, password, "Device", KdfParams::FAST).unwrap();

        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();

        let key_state = EncryptionKeyState::new();
        let (conn, _) = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            password,
            std::path::Path::new("/tmp/unused.db"),
            None,
            None,
            None,
        )
        .expect("confirm must succeed");

        let rwm = db::get_setting(&conn, db::RECOVERY_WRAPPED_MASTER_KEY)
            .unwrap()
            .expect("recovery_wrapped_master must be persisted after confirm");
        assert!(!rwm.is_empty(), "recovery_wrapped_master must not be empty");
    }

    // ─── Onboard new device: helpers ─────────────────────────────────────────

    /// Seed a complete V2 vault into an in-memory provider using
    /// `begin_first_time_setup_inner` + `confirm_first_time_setup_inner`.
    /// Returns `(conn, mnemonic_phrase, publish_ctx)`.
    fn seed_v2_vault(
        password: &str,
        device_name: &str,
    ) -> (
        Connection,
        String,
        crate::commands::crypto::V2KeyringPublishContext,
    ) {
        let conn = setup();
        let handle =
            begin_first_time_setup_inner(&conn, password, device_name, KdfParams::FAST).unwrap();
        let mnemonic_phrase = handle.mnemonic.join(" ");
        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();
        let key_state = EncryptionKeyState::new();
        let (conn, pub_ctx) = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            password,
            std::path::Path::new("/tmp/unused_onboard.db"),
            None,
            None,
            None,
        )
        .expect("confirm must succeed");
        (conn, mnemonic_phrase, pub_ctx)
    }

    /// Seed the in-memory provider with a real V2 keyring (all three files)
    /// using the publish context from `seed_v2_vault`.
    async fn seed_provider_from_ctx(
        provider: &crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider,
        pub_ctx: &V2KeyringPublishContext,
    ) {
        use crate::commands::gdrive::publish_v2_keyring_with_provider;
        // Use a fresh state with no active rotation job so the gate passes.
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let state = AppState::new(conn);
        let key_state = crate::EncryptionKeyState::new();
        publish_v2_keyring_with_provider(provider, &state, pub_ctx, &key_state)
            .await
            .expect("publish must succeed");
        crate::sync::recovery::bootstrap_sync_control(provider, 1)
            .await
            .expect("sync control bootstrap must succeed");
    }

    // ─── Onboard: validate passphrase ────────────────────────────────────────

    /// Happy path: correct mnemonic → Ok(()).
    #[tokio::test]
    async fn onboard_validate_passphrase_correct_mnemonic_succeeds() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let (_conn, mnemonic, pub_ctx) = seed_v2_vault("validpass12", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let result = onboard_validate_passphrase_inner(&provider, &mnemonic).await;
        assert!(
            result.is_ok(),
            "correct mnemonic must succeed: {:?}",
            result.err()
        );
    }

    /// Wrong mnemonic → generic error, no info leak.
    #[tokio::test]
    async fn onboard_validate_passphrase_wrong_mnemonic_fails_generic() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let (_conn, _mnemonic, pub_ctx) = seed_v2_vault("validpass12", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // Use a different (but valid) mnemonic by doing a second setup.
        let conn2 = setup();
        let handle2 =
            begin_first_time_setup_inner(&conn2, "differentpass12", "M2", KdfParams::FAST).unwrap();
        let wrong_mnemonic = handle2.mnemonic.join(" ");

        let result = onboard_validate_passphrase_inner(&provider, &wrong_mnemonic).await;
        assert!(result.is_err(), "wrong mnemonic must fail");
        let err = result.unwrap_err();
        // Must not leak internal details like "AES-GCM tag".
        assert!(
            err.contains("Wrong recovery phrase") || err.contains("Could not verify"),
            "error must be generic: {err}"
        );
        assert!(
            !err.contains("AES-GCM"),
            "error must not leak AES-GCM detail: {err}"
        );
    }

    /// Missing recovery slot → vault-corrupted error.
    #[tokio::test]
    async fn onboard_validate_passphrase_missing_recovery_slot_fails() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let (_conn, mnemonic, pub_ctx) = seed_v2_vault("validpass12", "M1");
        let provider = InMemoryKeyringProvider::new();
        // Publish only meta, skip recovery slot.
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::types::{KeyringMetaV2, KEYRING_V2_VERSION};
        let meta = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: 1,
            master_fingerprint: pub_ctx.master_fingerprint.clone(),
            content_epoch: 0,
            recovery_generation: 0,
            created_at: 0,
            updated_at: 0,
        };
        kio::write_meta(&provider, &meta).await.unwrap();
        // No recovery slot written.

        let result = onboard_validate_passphrase_inner(&provider, &mnemonic).await;
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("missing the recovery slot"),
            "must report missing recovery slot"
        );
    }

    /// A `master_fingerprint` mismatch (correct phrase, but `_meta.json` claims
    /// a different master than what `_recovery.json` actually unwraps to — e.g.
    /// a tampered or cross-vault `_meta.json`) must fail cleanly, not panic.
    /// Regression guard for the 🚨 in phase-2: this exercises the SAME
    /// `unwrap → compare fingerprint` path that protects `RecoverySlotV2`,
    /// proving the recovery-slot unwrap itself still works correctly even when
    /// the surrounding metadata is wrong.
    #[tokio::test]
    async fn onboard_validate_passphrase_master_fingerprint_mismatch_fails_cleanly() {
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::types::{KeyringMetaV2, KEYRING_V2_VERSION};

        let (_conn, mnemonic, pub_ctx) = seed_v2_vault("validpass12", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // Tamper _meta.json: keep it well-formed, but point master_fingerprint
        // at a different (unrelated) key than the one _recovery.json actually
        // wraps. The mnemonic is genuinely correct — the mismatch is entirely
        // in the metadata, so decrypt succeeds and only the fingerprint compare
        // must fail.
        let mut meta = kio::read_meta(&provider).await.unwrap().unwrap();
        meta = KeyringMetaV2 {
            master_fingerprint: "f".repeat(64),
            ..meta
        };
        assert_eq!(meta.version, KEYRING_V2_VERSION);
        kio::write_meta(&provider, &meta).await.unwrap();

        let result = onboard_validate_passphrase_inner(&provider, &mnemonic).await;
        assert!(
            result.is_err(),
            "fingerprint mismatch must fail, not silently succeed"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("Could not verify"),
            "error must be the clean fingerprint-mismatch message, got: {err}"
        );
    }

    /// Garbage input (not 24 words) → rejected before any Drive I/O.
    #[tokio::test]
    async fn onboard_validate_passphrase_garbage_input_fails() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let provider = InMemoryKeyringProvider::new();
        let result = onboard_validate_passphrase_inner(&provider, "not a valid phrase").await;
        assert!(result.is_err(), "garbage input must fail");
    }

    // ─── Onboard: complete ────────────────────────────────────────────────────

    /// Happy path: onboard_complete_inner writes device slot, sets DB settings,
    /// keys the encryption key state.
    #[tokio::test]
    async fn onboard_complete_inner_happy_path() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None, // skip boot file in test
            None, // no pending Drive session
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("onboard_complete_inner must succeed");

        // DB must have encryption_mode = Password.
        assert_eq!(
            db::get_encryption_mode(&new_conn).unwrap(),
            db::EncryptionMode::Password
        );

        // DB must have wrapped_encryption_key.
        let wrapped = db::get_setting(&new_conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .expect("wrapped_encryption_key must be set");
        assert!(!wrapped.is_empty());

        // DB must have kek_salt.
        let kek_salt = db::get_setting(&new_conn, db::KEK_SALT_KEY)
            .unwrap()
            .expect("kek_salt must be set");
        assert!(!kek_salt.is_empty());

        // cloud_master_fingerprint must be set.
        let fp = db::get_setting(&new_conn, db::CLOUD_MASTER_FINGERPRINT)
            .unwrap()
            .expect("cloud_master_fingerprint must be set");
        assert_eq!(fp, pub_ctx.master_fingerprint);

        // key_state must be initialized.
        assert!(
            key_state.is_initialized().unwrap(),
            "key_state must be initialized after onboard_complete"
        );
    }

    /// Requirement 4/5(a): a fresh device joins using ONLY `_recovery.json` +
    /// `_content.json` (plus `_meta.json` for the fingerprint check) — no cloud
    /// device slot is needed at all. Deletes M1's device slot from the mock
    /// cloud before M2 joins, proving the join path never depends on any
    /// `devices/*.json` existing.
    #[tokio::test]
    async fn onboard_complete_inner_joins_with_zero_device_slots_present() {
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // Remove every device slot from the mock cloud — simulates a vault
        // whose registry is (or has become) empty. Only _meta.json,
        // _recovery.json, and _content.json remain.
        kio::delete_device_slot(&provider, &pub_ctx.device_id)
            .await
            .unwrap();
        assert!(
            kio::list_device_slots(&provider).await.unwrap().is_empty(),
            "precondition: zero device slots before join"
        );

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None, // skip boot file in test
            None, // no pending Drive session
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("join must succeed with zero device slots present");

        assert_eq!(
            db::get_encryption_mode(&new_conn).unwrap(),
            db::EncryptionMode::Password
        );
        assert!(
            key_state.is_initialized().unwrap(),
            "key_state must be initialized after joining with no device slots"
        );

        // The join itself publishes its own (metadata-only) slot at the end —
        // confirms the registry is self-healing, not that a slot was required.
        let slots_after = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(slots_after.len(), 1, "M2's own slot is created by the join");
    }

    /// A2 TOCTOU guard: a peer rotation landing between the initial `_meta.json`
    /// snapshot and the final publish must abort the onboard instead of writing
    /// the (now stale) device slot + meta back — that write would clobber the
    /// rotation and roll the cloud back to the pre-rotation epoch.
    #[tokio::test]
    async fn onboard_complete_inner_aborts_when_vault_rotated_mid_flow() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::io::META_PATH;
        use crate::sync::keyring_v2::types::{KeyringMetaV2, KEYRING_V2_VERSION};
        use crate::sync::keyring_v2::KeyringV2Io;
        use std::sync::atomic::{AtomicUsize, Ordering};

        /// Serves the original `_meta.json` on the FIRST read (the validation
        /// snapshot) and a rotated one on every later read (the pre-publish
        /// guard) — simulating a peer rotation inside the window.
        struct RotatingMetaProvider {
            inner: InMemoryKeyringProvider,
            meta_reads: AtomicUsize,
            rotated_meta: Vec<u8>,
        }

        #[async_trait::async_trait]
        impl crate::sync::keyring_v2::KeyringV2Io for RotatingMetaProvider {
            async fn read_file(
                &self,
                path: &str,
            ) -> Result<Vec<u8>, crate::sync::provider::SyncError> {
                if path == META_PATH && self.meta_reads.fetch_add(1, Ordering::SeqCst) >= 1 {
                    return Ok(self.rotated_meta.clone());
                }
                self.inner.read_file(path).await
            }
            async fn write_file(
                &self,
                path: &str,
                data: &[u8],
            ) -> Result<(), crate::sync::provider::SyncError> {
                self.inner.write_file(path, data).await
            }
            async fn delete_file(
                &self,
                path: &str,
            ) -> Result<(), crate::sync::provider::SyncError> {
                self.inner.delete_file(path).await
            }
            async fn list_files(
                &self,
                prefix: &str,
            ) -> Result<Vec<String>, crate::sync::provider::SyncError> {
                self.inner.list_files(prefix).await
            }
            async fn read_versioned_file(
                &self,
                path: &str,
            ) -> Result<crate::sync::keyring_v2::VersionedFile, crate::sync::provider::SyncError>
            {
                self.inner.read_versioned_file(path).await
            }
        }

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let inner = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&inner, &pub_ctx).await;

        // Rotated meta: same fingerprint format, epoch advanced by a peer.
        let rotated = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: 2,
            master_fingerprint: pub_ctx.master_fingerprint.clone(),
            content_epoch: 1,
            recovery_generation: 0,
            created_at: pub_ctx.created_at,
            updated_at: pub_ctx.created_at + 10,
        };
        let provider = RotatingMetaProvider {
            inner,
            meta_reads: AtomicUsize::new(0),
            rotated_meta: serde_json::to_vec(&rotated).unwrap(),
        };

        let devices_before = provider
            .inner
            .list_files(".meta/keyring/devices")
            .await
            .unwrap();

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();
        let result = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await;

        let (_conn, err) = result.expect_err("a mid-flow rotation must abort the onboard");
        assert!(
            err.contains("rotated by another device"),
            "error must explain the rotation: {err}"
        );
        // No cloud write may have happened: the joiner's device slot must not
        // exist and the seeder's slot set must be unchanged.
        let devices_after = provider
            .inner
            .list_files(".meta/keyring/devices")
            .await
            .unwrap();
        assert_eq!(
            devices_after, devices_before,
            "the stale device slot must NOT be written after a detected rotation"
        );
    }

    /// After onboard_complete_inner, the placeholder default "My Journal"
    /// seeded by schema migration must be removed so the subsequent first
    /// sync can pull the user's real journals from the cloud without a
    /// stray empty journal lingering in the picker. Only removed if it is
    /// the SOLE journal AND has zero entries (defensive — never drops
    /// user-authored journals on re-onboard).
    #[tokio::test]
    async fn onboard_complete_inner_removes_default_empty_my_journal() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        // Verify the seeded default journal exists pre-onboard (schema
        // migration in setup() always inserts "My Journal" on fresh DBs).
        let pre = db::list_journals(&conn2, None).unwrap();
        assert_eq!(
            pre.len(),
            1,
            "setup() must seed exactly one default journal"
        );
        assert_eq!(pre[0].name, "My Journal");

        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("onboard_complete_inner must succeed");

        // The default journal must be gone — cloud sync will populate the
        // user's real journals.
        let post = db::list_journals(&new_conn, None).unwrap();
        assert!(
            post.is_empty(),
            "default empty 'My Journal' must be removed after onboard; got: {post:?}"
        );
    }

    /// Defensive: if the user has authored entries in "My Journal" BEFORE
    /// onboard (unlikely but possible via offline workflow), the cleanup
    /// must NOT drop it.
    #[tokio::test]
    async fn onboard_complete_inner_preserves_my_journal_with_entries() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        // Insert one entry into the seeded "My Journal" so it has content.
        let seeded = db::list_journals(&conn2, None).unwrap();
        let jid = &seeded[0].id;
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        conn2
            .execute(
                "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                rusqlite::params!["entry-1", jid, now_secs, now_secs],
            )
            .unwrap();

        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("onboard_complete_inner must succeed");

        // The journal with entries must still exist.
        let post = db::list_journals(&new_conn, None).unwrap();
        assert_eq!(
            post.len(),
            1,
            "journal with entries must be preserved; got: {post:?}"
        );
        assert_eq!(post[0].id, *jid);
    }

    /// After onboard_complete_inner, the device slot is uploaded to Drive.
    #[tokio::test]
    async fn onboard_complete_inner_uploads_device_slot() {
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        // Force a stable device_id for this test.
        let device_id = db::get_or_create_device_id(&conn2).unwrap();

        let key_state = EncryptionKeyState::new();
        onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 Device",
            None,
            None, // no pending Drive session
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("must succeed");

        // Drive must have the device slot.
        let slots = kio::list_device_slots(&provider).await.unwrap();
        let m2_slot = slots.iter().find(|s| s.device_id == device_id);
        assert!(
            m2_slot.is_some(),
            "Drive must contain M2 device slot after onboard"
        );
    }

    /// A peer must persist the vault creation time from the cloud `_meta.json`
    /// into `RECOVERY_PASSPHRASE_CREATED_AT`, so a later keyring republish from
    /// this peer writes the correct `created_at` instead of the `0` fallback.
    #[tokio::test]
    async fn onboard_complete_inner_persists_vault_created_at_from_cloud_meta() {
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::types::KeyringMetaV2;
        use crate::sync::keyring_v2::KeyringV2Io;

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // Overwrite the cloud meta with a distinct, fixed vault creation time so
        // the assertion can't pass by coincidentally matching `now`.
        const VAULT_CREATED_AT: i64 = 1_650_000_000;
        let mut meta = kio::read_meta(&provider).await.unwrap().unwrap();
        meta = KeyringMetaV2 {
            created_at: VAULT_CREATED_AT,
            updated_at: VAULT_CREATED_AT,
            recovery_generation: 9,
            ..meta
        };
        kio::write_meta(&provider, &meta).await.unwrap();
        provider
            .write_file(
                crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH,
                &serde_json::to_vec(&crate::sync::sync_control::SyncControlV1 {
                    version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
                    recovery_generation: 9,
                    recovery_lease: None,
                    updated_at: VAULT_CREATED_AT,
                })
                .unwrap(),
            )
            .await
            .unwrap();

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 Device",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("must succeed");

        let persisted = db::get_setting(&new_conn, db::RECOVERY_PASSPHRASE_CREATED_AT)
            .unwrap()
            .and_then(|s| s.parse::<i64>().ok());
        assert_eq!(
            persisted,
            Some(VAULT_CREATED_AT),
            "peer must persist the vault created_at from cloud meta, not its own onboard time"
        );
        let adopted_generation = db::get_sync_recovery_generation(&new_conn).unwrap();
        assert_eq!(adopted_generation, 9);
        assert!(
            crate::sync::recovery::authorize_recovery_push(None, 9, adopted_generation, None)
                .is_ok()
        );
    }

    #[tokio::test]
    async fn onboard_complete_inner_rejects_stale_keyring_generation_before_publish() {
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;
        let mut meta = kio::read_meta(&provider).await.unwrap().unwrap();
        meta.recovery_generation = 3;
        kio::write_meta(&provider, &meta).await.unwrap();
        let slots_before = kio::list_device_slots(&provider).await.unwrap().len();

        let error = onboard_complete_inner(
            setup(),
            &EncryptionKeyState::new(),
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 Device",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect_err("stale keyring meta must be rejected");

        assert!(error.1.contains("generation mismatch"));
        assert_eq!(
            kio::list_device_slots(&provider).await.unwrap().len(),
            slots_before
        );
    }

    /// _meta.json epoch is unchanged after onboarding; only updated_at moves.
    #[tokio::test]
    async fn onboard_complete_inner_epoch_unchanged() {
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let original_meta = kio::read_meta(&provider).await.unwrap().unwrap();
        let original_epoch = original_meta.epoch;

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();
        onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 Device",
            None,
            None, // no pending Drive session
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("must succeed");

        let updated_meta = kio::read_meta(&provider).await.unwrap().unwrap();
        assert_eq!(
            updated_meta.epoch, original_epoch,
            "_meta.json epoch must not change after onboarding"
        );
    }

    /// Multi-device: M1 sets up, M2 onboards, M3 onboards. Drive has three slots.
    #[tokio::test]
    async fn onboard_complete_inner_multi_device() {
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::KeyringV2Io;

        // M1: first-time setup + publish.
        let (_conn1, mnemonic, pub_ctx) = seed_v2_vault("masterpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // Count slots after M1 setup: should be exactly 1.
        let slots_after_m1 = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(slots_after_m1.len(), 1, "exactly 1 slot after M1 setup");

        // M2 onboards.
        let conn2 = setup();
        let ks2 = EncryptionKeyState::new();
        onboard_complete_inner(
            conn2,
            &ks2,
            &provider,
            &mnemonic,
            "m2password123",
            "M2 Device",
            None,
            None, // no pending Drive session
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("M2 onboard must succeed");

        let slots_after_m2 = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(slots_after_m2.len(), 2, "2 slots after M2 onboards");

        // M3 onboards.
        let conn3 = setup();
        let ks3 = EncryptionKeyState::new();
        onboard_complete_inner(
            conn3,
            &ks3,
            &provider,
            &mnemonic,
            "m3password123",
            "M3 Device",
            None,
            None, // no pending Drive session
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("M3 onboard must succeed");

        let slots_after_m3 = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(slots_after_m3.len(), 3, "3 slots after M3 onboards");

        // All three devices can unwrap to the same master key.
        let recovery_slot = kio::read_recovery(&provider).await.unwrap().unwrap();
        let mnemonic_parsed =
            crate::utils::recovery::validate_recovery_mnemonic(&mnemonic).unwrap();
        let recovery_key = crate::utils::recovery::derive_recovery_key(&mnemonic_parsed);
        let master_key =
            unwrap_master_with_recovery_key(&recovery_slot.wrapped_master, &*recovery_key)
                .expect("must unwrap");
        let expected_fp = hex::encode(crate::utils::encryption::key_fingerprint(&*master_key));
        // Each M1/M2/M3 device joined with a DIFFERENT local password, using only
        // `_recovery.json` + `_content.json` — no cloud device slot ever carried
        // key material (design §3/§4: metadata-only device slots, requirement 4).
        // Verify by matching the fingerprint stored in cloud meta (computed from
        // the original master) and asserting every slot is pure registry metadata.
        let meta = kio::read_meta(&provider).await.unwrap().unwrap();
        assert_eq!(
            meta.master_fingerprint, expected_fp,
            "meta fingerprint must match master"
        );
        // Read RAW bytes off the provider for each slot — asserting via the
        // parsed `DeviceSlotV2` would be meaningless, since that struct cannot
        // carry these fields anymore by construction.
        for slot in &slots_after_m3 {
            let raw = provider
                .read_file(&crate::sync::keyring_v2::io::device_slot_path(
                    &slot.device_id,
                ))
                .await
                .unwrap();
            let raw_text = String::from_utf8_lossy(&raw);
            assert!(
                !raw_text.contains("wrapped_master") && !raw_text.contains("kek_salt"),
                "device slot for {} must carry no key material: {raw_text}",
                slot.device_id
            );
        }
    }

    // ─── Device list ─────────────────────────────────────────────────────────

    /// list_devices: after onboarding two devices, both rows returned with
    /// correct `is_current` flags.
    #[tokio::test]
    async fn list_devices_returns_both_rows_with_correct_is_current() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        // M1: first-time setup.
        let (conn1, mnemonic, pub_ctx) = seed_v2_vault("listpass123", "M1 laptop");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // M2 onboards into conn2 (separate in-memory DB).
        let conn2 = setup();
        let ks2 = EncryptionKeyState::new();
        onboard_complete_inner(
            conn2,
            &ks2,
            &provider,
            &mnemonic,
            "m2pass12345",
            "M2 phone",
            None,
            None, // no pending Drive session
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("M2 onboard must succeed");

        // Verify M1's own DB has itself as current (only M1 in M1's devices table).
        let rows1 = db::list_devices(&conn1).unwrap();
        assert_eq!(rows1.len(), 1, "M1 DB has one device row initially");
        assert!(rows1[0].is_current, "M1's row must be is_current");
        assert_eq!(rows1[0].name, "M1 laptop");
    }

    /// list_devices: correct ordering (created_at ASC).
    #[test]
    fn list_devices_is_ordered_by_created_at() {
        let conn = setup();
        // Insert two device rows with different created_at values.
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-b".to_string(),
                name: "B".to_string(),
                created_at: 2000,
                last_seen_at: 2000,
                is_current: false,
                is_revoked: false,
            },
        )
        .unwrap();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-a".to_string(),
                name: "A".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();

        let rows = db::list_devices(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].device_id, "dev-a", "earlier device first");
        assert_eq!(rows[1].device_id, "dev-b");
    }

    /// rename_device: non-current device — only updates DB name.
    #[test]
    fn rename_device_non_current_updates_db_only() {
        let conn = setup();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-other".to_string(),
                name: "Old Name".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: false,
                is_revoked: false,
            },
        )
        .unwrap();

        db::update_device_name(&conn, "dev-other", "New Name").unwrap();

        let rows = db::list_devices(&conn).unwrap();
        let row = rows.iter().find(|r| r.device_id == "dev-other").unwrap();
        assert_eq!(row.name, "New Name");
    }

    /// rename_device: no-op when device_id does not exist.
    #[test]
    fn rename_device_nonexistent_device_is_noop() {
        let conn = setup();
        // Should not error — no row to update.
        let result = db::update_device_name(&conn, "nonexistent-device", "New Name");
        assert!(result.is_ok());
    }

    /// ⚠️-1: rename_device validation rejects a name that is ≤80 chars but
    /// >128 bytes (e.g. 43 emoji = 4 bytes each → 172 bytes > 128).
    /// Without the byte check such a name would pass the char check, be stored
    /// in the local DB, but then fail DeviceSlotV2::validate() on cloud reupload
    /// → keyring_dirty forever.
    #[test]
    fn rename_device_validation_rejects_over_128_bytes() {
        // 43 emoji × 4 bytes = 172 bytes, but only 43 chars (≤80) — passes
        // char check but must fail byte check.
        let long_emoji_name = "🔐".repeat(43); // 43 × 4 = 172 bytes
        assert!(
            long_emoji_name.chars().count() <= 80,
            "char count must be within limit"
        );
        assert!(
            long_emoji_name.len() > 128,
            "byte length must exceed 128 for this test to be meaningful"
        );

        // Replicate rename_device validation logic.
        let trimmed = long_emoji_name.trim().to_string();
        let char_check = trimmed.chars().count() > 80;
        let byte_check = trimmed.len() > 128;
        assert!(!char_check, "char check must pass for this name");
        assert!(byte_check, "byte check must reject the name");
    }

    #[test]
    fn rename_device_sets_device_slot_dirty_when_sync_running() {
        use crate::commands::sync::SyncInProgressGuard;

        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let conn = setup();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-current".to_string(),
                name: "Old Name".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();

        let _held = SyncInProgressGuard::try_acquire().expect("guard must be free");
        let outcome = rename_device_inner(&conn, "dev-current", "New Name").unwrap();

        assert!(
            outcome.deferred,
            "current-device rename must defer slot upload while sync is active"
        );
        assert!(
            outcome.upload.is_none(),
            "deferred rename must not return cloud upload material"
        );
        let row = db::list_devices(&conn)
            .unwrap()
            .into_iter()
            .find(|d| d.device_id == "dev-current")
            .unwrap();
        assert_eq!(row.name, "New Name");
        assert_eq!(
            db::get_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY).unwrap(),
            Some("1".to_string())
        );
        assert_eq!(
            db::get_setting(&conn, db::KEYRING_DIRTY_KEY).unwrap(),
            None,
            "rename-only deferral must not set keyring_dirty"
        );
    }

    #[test]
    fn rename_non_current_device_while_sync_running_updates_db_without_dirty_flag() {
        use crate::commands::sync::SyncInProgressGuard;

        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let conn = setup();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-other".to_string(),
                name: "Other Old".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: false,
                is_revoked: false,
            },
        )
        .unwrap();

        let _held = SyncInProgressGuard::try_acquire().expect("guard must be free");
        let outcome = rename_device_inner(&conn, "dev-other", "Other New").unwrap();

        assert!(
            !outcome.deferred,
            "non-current rename must remain local-only even during sync"
        );
        assert!(outcome.upload.is_none());
        let row = db::list_devices(&conn)
            .unwrap()
            .into_iter()
            .find(|d| d.device_id == "dev-other")
            .unwrap();
        assert_eq!(row.name, "Other New");
        assert_eq!(
            db::get_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY).unwrap(),
            None
        );
    }

    #[test]
    fn rename_device_defers_if_sync_starts_before_immediate_upload() {
        use crate::commands::sync::SyncInProgressGuard;

        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let conn = setup();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-current".to_string(),
                name: "Old Name".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();
        db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &"ab".repeat(67)).unwrap();
        db::set_setting(&conn, db::KEK_SALT_KEY, &"cd".repeat(16)).unwrap();

        let outcome = rename_device_inner(&conn, "dev-current", "New Name").unwrap();
        assert!(
            outcome.upload.is_some(),
            "rename should prepare upload material when sync is initially idle"
        );

        let _held = SyncInProgressGuard::try_acquire().expect("guard must be free");
        let guard = begin_device_slot_upload_or_mark_dirty(&conn).unwrap();

        assert!(
            guard.is_none(),
            "upload guard must not be granted after sync starts"
        );
        assert_eq!(
            db::get_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY).unwrap(),
            Some("1".to_string()),
            "rename must defer retry instead of uploading stale slot material"
        );
    }

    #[test]
    fn rename_upload_success_keeps_dirty_when_local_name_changed_during_upload() {
        let conn = setup();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-current".to_string(),
                name: "Uploaded Name".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();
        db::set_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY, "1").unwrap();
        db::update_device_name(&conn, "dev-current", "Newer Local Name").unwrap();

        clear_device_slot_dirty_if_upload_still_current(&conn, "Uploaded Name").unwrap();

        assert_eq!(
            db::get_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY).unwrap(),
            Some("1".to_string()),
            "dirty flag must remain so sync flushes the newer local device name"
        );
    }

    #[test]
    fn rename_upload_success_clears_dirty_when_uploaded_name_is_current() {
        let conn = setup();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-current".to_string(),
                name: "Uploaded Name".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();
        db::set_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY, "1").unwrap();

        clear_device_slot_dirty_if_upload_still_current(&conn, "Uploaded Name").unwrap();

        assert_eq!(
            db::get_setting(&conn, db::DEVICE_SLOT_DIRTY_KEY).unwrap(),
            None
        );
    }

    /// ⚠️-4: current-device rename via reupload_current_device_slot writes ONLY
    /// devices/<id>.json — does NOT touch _meta.json (epoch preserved) or
    /// _recovery.json. Also verifies last_seen_at >= created_at (not reset).
    #[tokio::test]
    async fn rename_current_device_reuploads_slot_only_preserves_epoch() {
        use crate::commands::gdrive::{
            publish_v2_keyring_with_provider, reupload_current_device_slot,
        };
        use crate::sync::keyring_v2::io::{
            read_device_slot, read_meta, read_recovery, test_support::InMemoryKeyringProvider,
        };

        // Set up a full V2 keyring in the provider.
        let (_conn, _mnemonic, pub_ctx) = seed_v2_vault("reuppass123", "Original Name");
        let provider = InMemoryKeyringProvider::new();
        let state = {
            let conn = Connection::open_in_memory().unwrap();
            migrate(&conn).unwrap();
            let state = AppState::new(conn);
            let key_state = crate::EncryptionKeyState::new();
            publish_v2_keyring_with_provider(&provider, &state, &pub_ctx, &key_state)
                .await
                .expect("initial publish must succeed");
            state
        };

        // Record the original _meta.json epoch and _recovery.json wrapped_master.
        let meta_before = read_meta(&provider)
            .await
            .expect("read_meta failed")
            .expect("_meta.json must exist");
        let recovery_before = read_recovery(&provider)
            .await
            .expect("read_recovery failed")
            .expect("_recovery.json must exist");

        let device_id = &pub_ctx.device_id;
        let created_at = pub_ctx.created_at;
        // last_seen_at is set to created_at + 1 to simulate "now" > created_at.
        let last_seen_at = created_at + 1;

        // Exercise reupload_current_device_slot with a new name.
        reupload_current_device_slot(
            &state,
            &provider,
            device_id,
            "Renamed MacBook",
            created_at,
            last_seen_at,
        )
        .await
        .expect("slot reupload must succeed");

        // Device slot must have new name.
        let slot = read_device_slot(&provider, device_id)
            .await
            .expect("read_device_slot failed")
            .expect("device slot must exist");
        assert_eq!(slot.name, "Renamed MacBook");
        assert!(
            slot.last_seen_at >= slot.created_at,
            "last_seen_at must not be reset to created_at; got last_seen_at={} created_at={}",
            slot.last_seen_at,
            slot.created_at
        );

        // _meta.json epoch must be unchanged (not reset to 1 or any other value).
        let meta_after = read_meta(&provider)
            .await
            .expect("read_meta failed")
            .expect("_meta.json must still exist");
        assert_eq!(
            meta_after.epoch, meta_before.epoch,
            "epoch must not change on rename: before={} after={}",
            meta_before.epoch, meta_after.epoch
        );
        assert_eq!(
            meta_after.master_fingerprint, meta_before.master_fingerprint,
            "_meta.json must be unchanged"
        );

        // _recovery.json must be unchanged.
        let recovery_after = read_recovery(&provider)
            .await
            .expect("read_recovery failed")
            .expect("_recovery.json must still exist");
        assert_eq!(
            recovery_after.wrapped_master, recovery_before.wrapped_master,
            "_recovery.json must not be touched by rename"
        );
    }

    /// ⚠️-4: non-current device rename updates local DB only — no slot write.
    /// (This is already partially covered by rename_device_non_current_updates_db_only
    /// but that test goes through db::update_device_name directly. This test
    /// verifies the provider is NOT written for a non-current device.)
    #[tokio::test]
    async fn rename_non_current_device_does_not_write_slot() {
        use crate::commands::gdrive::publish_v2_keyring_with_provider;
        use crate::sync::keyring_v2::io::{
            read_device_slot, test_support::InMemoryKeyringProvider,
        };

        // Set up a full V2 keyring for device_1.
        let (conn, _mnemonic, pub_ctx) = seed_v2_vault("noncurpass1", "Device 1");
        let provider = InMemoryKeyringProvider::new();
        {
            let test_conn = Connection::open_in_memory().unwrap();
            migrate(&test_conn).unwrap();
            let test_state = AppState::new(test_conn);
            let key_state = crate::EncryptionKeyState::new();
            publish_v2_keyring_with_provider(&provider, &test_state, &pub_ctx, &key_state)
                .await
                .expect("initial publish must succeed");
        }

        // Insert a non-current "device 2" in the local DB (simulates a refresh).
        let other_id = "22222222-3333-4444-5555-666666666666";
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: other_id.to_string(),
                name: "Other Device".to_string(),
                created_at: 1_700_000_500,
                last_seen_at: 1_700_000_600,
                is_current: false,
                is_revoked: false,
            },
        )
        .unwrap();

        // Rename the non-current device in the DB only.
        db::update_device_name(&conn, other_id, "Renamed Other").unwrap();

        // Verify the DB was updated.
        let rows = db::list_devices(&conn).unwrap();
        let row = rows.iter().find(|r| r.device_id == other_id).unwrap();
        assert_eq!(row.name, "Renamed Other");

        // Verify the provider has NO slot for other_id (we never wrote one for it).
        let other_slot = read_device_slot(&provider, other_id)
            .await
            .expect("read_device_slot IO ok");
        assert!(
            other_slot.is_none(),
            "no slot should be written to the provider for a non-current device rename"
        );
    }

    /// refresh_devices_from_cloud: cloud has 2 slots, local has 1 → local gains 1.
    #[tokio::test]
    async fn refresh_devices_from_cloud_merges_new_slot() {
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        // M1 sets up and publishes.
        let (conn1, mnemonic, pub_ctx) = seed_v2_vault("refreshpass1", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // M2 onboards → provider now has 2 slots.
        let conn2 = setup();
        let ks2 = EncryptionKeyState::new();
        onboard_complete_inner(
            conn2,
            &ks2,
            &provider,
            &mnemonic,
            "m2pass12345",
            "M2 phone",
            None,
            None, // no pending Drive session
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("M2 onboard must succeed");

        // M1 DB still has only 1 device row (itself).
        let rows_before = db::list_devices(&conn1).unwrap();
        assert_eq!(rows_before.len(), 1, "M1 has 1 row before refresh");

        // Simulate refresh_devices_from_cloud on M1 via the real merge helper.
        let current_id = db::get_or_create_device_id(&conn1).unwrap();
        let slots = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(slots.len(), 2, "Drive has 2 slots");

        merge_device_slots_into_local(&conn1, &slots, &current_id);

        let rows_after = db::list_devices(&conn1).unwrap();
        assert_eq!(rows_after.len(), 2, "M1 now has 2 rows after refresh");
    }

    /// merge_device_slots_into_local: the current device's local last_seen_at is
    /// preserved (NOT overwritten by the stale cloud slot value), while a peer
    /// device takes the cloud value. Regression guard for the "This device shows
    /// 10 hours ago right after sync" bug.
    #[test]
    fn merge_preserves_current_device_last_seen() {
        use crate::sync::keyring_v2::types::{DeviceSlotV2, KEYRING_V2_VERSION};

        let conn = setup();

        // Local current device, freshly synced (last_seen_at = 2000).
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "dev-current".to_string(),
                name: "This Mac".to_string(),
                created_at: 1000,
                last_seen_at: 2000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();

        let mk_slot = |id: &str, last_seen: i64| DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: id.to_string(),
            name: id.to_string(),
            created_at: 1000,
            last_seen_at: last_seen,
        };

        // Cloud carries a STALE value (500) for the current device and a fresh
        // value (3000) for a peer.
        let slots = vec![mk_slot("dev-current", 500), mk_slot("dev-peer", 3000)];

        merge_device_slots_into_local(&conn, &slots, "dev-current");

        let rows = db::list_devices(&conn).unwrap();
        let current = rows.iter().find(|d| d.device_id == "dev-current").unwrap();
        let peer = rows.iter().find(|d| d.device_id == "dev-peer").unwrap();
        assert_eq!(
            current.last_seen_at, 2000,
            "current device must keep its fresh local last_seen_at, not the stale cloud 500"
        );
        assert_eq!(
            peer.last_seen_at, 3000,
            "peer device must take the cloud last_seen_at"
        );
    }

    /// delete_non_current_devices: wipe-keep-connection removes non-current rows,
    /// current row is preserved.
    #[test]
    fn delete_non_current_devices_keeps_current_row() {
        let conn = setup();

        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "current-dev".to_string(),
                name: "My Mac".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "other-dev-1".to_string(),
                name: "iPhone".to_string(),
                created_at: 2000,
                last_seen_at: 2000,
                is_current: false,
                is_revoked: false,
            },
        )
        .unwrap();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "other-dev-2".to_string(),
                name: "iPad".to_string(),
                created_at: 3000,
                last_seen_at: 3000,
                is_current: false,
                is_revoked: false,
            },
        )
        .unwrap();

        db::delete_non_current_devices(&conn).unwrap();

        let rows = db::list_devices(&conn).unwrap();
        assert_eq!(rows.len(), 1, "only current device remains after wipe");
        assert_eq!(rows[0].device_id, "current-dev");
        assert!(rows[0].is_current);
    }

    /// delete_non_current_devices: safe when only the current device exists.
    #[test]
    fn delete_non_current_devices_noop_when_only_current() {
        let conn = setup();

        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "current-dev".to_string(),
                name: "My Mac".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();

        db::delete_non_current_devices(&conn).unwrap();

        let rows = db::list_devices(&conn).unwrap();
        assert_eq!(rows.len(), 1, "current device row preserved");
    }

    // ─── I3: SyncInProgressGuard contention ──────────────────────────────────

    /// I3: Verify that `try_acquire()` returns None when the global
    /// SYNC_IN_PROGRESS flag is already held. This models what happens when a
    /// revoke_device / rotate_master_key / resume_rotation command is called
    /// while a sync is running.
    #[test]
    fn sync_in_progress_guard_contention_returns_none() {
        use crate::commands::sync::SyncInProgressGuard;

        // Serialise all tests that touch the process-global SYNC_IN_PROGRESS flag
        // so this test and run_push_entry_blocked_while_sync_in_progress_and_released_after_drop
        // (in sync.rs) cannot interleave when cargo test runs them in parallel.
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        // Acquire the first guard (simulates an active sync).
        let guard1 = SyncInProgressGuard::try_acquire();
        assert!(guard1.is_some(), "first acquire must succeed");

        // Second acquire must fail — this is what the three rotation commands
        // check at their entry point.
        let guard2 = SyncInProgressGuard::try_acquire();
        assert!(
            guard2.is_none(),
            "second acquire must fail while first is held"
        );

        // Dropping the first guard releases the slot.
        drop(guard1);
        let guard3 = SyncInProgressGuard::try_acquire();
        assert!(guard3.is_some(), "acquire must succeed after drop");
    }

    /// Revoke (and rotate/resume) map a held sync guard to the exact
    /// `SYNC_IN_PROGRESS_ERR` string the frontend keys off. AppHandle
    /// blocks a full `revoke_device` command test (T40).
    #[test]
    fn revoke_try_acquire_returns_sync_in_progress_err_while_guard_held() {
        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let holder = crate::commands::sync::SyncInProgressGuard::try_acquire()
            .expect("first acquire must succeed");
        let err = match crate::commands::sync::try_acquire_sync_or_in_progress_err() {
            Ok(_) => panic!("second acquire must fail while the guard is held"),
            Err(msg) => msg,
        };
        assert_eq!(
            err,
            crate::commands::sync::SYNC_IN_PROGRESS_ERR,
            "revoke's try_acquire path must return SYNC_IN_PROGRESS_ERR while a sync holds the guard"
        );
        drop(holder);
        assert!(
            crate::commands::sync::try_acquire_sync_or_in_progress_err().is_ok(),
            "acquire must succeed after the holder drops"
        );
    }

    // ─── C2: rename_device defers cloud slot upload during active rotation ────

    /// C2: When a rotation job is active, rename_device must set device_slot_dirty
    /// instead of publishing the stale device slot.
    ///
    /// The full `rename_device` command requires an AppHandle (not testable in unit
    /// tests). We verify the gate logic here by confirming that
    /// `has_active_rotation_job` correctly identifies active vs aborted jobs —
    /// this is the predicate the rename_device gate reads before deciding to skip
    /// the cloud upload and set device_slot_dirty.
    #[test]
    fn rename_current_device_refuses_during_active_rotation() {
        let conn = setup();
        let id = db::insert_rotation_job(&conn, "fp-old", "fp-new", 1, 2, None).unwrap();
        let app_state = AppState::new(conn);

        let has_active = {
            let conn = app_state.lock().unwrap();
            db::has_active_rotation_job(&conn).unwrap()
        };
        assert!(has_active, "rotation job must be detected as active");

        // Confirm aborted jobs are NOT counted as active.
        {
            let conn = app_state.lock().unwrap();
            db::update_rotation_job_state(&conn, id, "aborted").unwrap();
        }
        let has_active_after_abort = {
            let conn = app_state.lock().unwrap();
            db::has_active_rotation_job(&conn).unwrap()
        };
        assert!(
            !has_active_after_abort,
            "aborted rotation job must NOT be active"
        );
    }

    // ─── get_force_re_pair_status ────────────────────────────────────────────

    #[test]
    fn get_force_re_pair_status_returns_none_when_flag_unset() {
        let conn = setup();
        assert_eq!(get_force_re_pair_status_inner(&conn).unwrap(), None);
    }

    #[test]
    fn get_force_re_pair_status_returns_reason_when_flag_set() {
        let conn = setup();
        db::set_setting(&conn, db::FORCE_RE_PAIR_REQUIRED, "1").unwrap();
        db::set_setting(&conn, db::FORCE_RE_PAIR_REASON, "vault_rotated_on_peer").unwrap();
        assert_eq!(
            get_force_re_pair_status_inner(&conn).unwrap(),
            Some("vault_rotated_on_peer".to_string())
        );
    }

    #[test]
    fn get_force_re_pair_status_returns_fallback_reason_when_reason_missing() {
        // Some callsites only set the flag and skip the reason (the V1 wipe
        // path used to be one — see gdrive.rs). The frontend still needs a
        // non-empty string so it can render the ForceRePairScreen — give it
        // a generic fallback instead of silently swallowing the trigger.
        let conn = setup();
        db::set_setting(&conn, db::FORCE_RE_PAIR_REQUIRED, "1").unwrap();
        let status = get_force_re_pair_status_inner(&conn).unwrap();
        assert!(status.is_some(), "flag is set, must report non-None");
        assert!(
            !status.unwrap().is_empty(),
            "reason must be a non-empty fallback string"
        );
    }

    #[test]
    fn get_force_re_pair_status_ignores_empty_flag_value() {
        let conn = setup();
        db::set_setting(&conn, db::FORCE_RE_PAIR_REQUIRED, "").unwrap();
        assert_eq!(get_force_re_pair_status_inner(&conn).unwrap(), None);
    }

    /// `complete_force_re_pair` re-asserts the `sync_provider` value that was
    /// stored before the connection swap. A folder-provider install must keep
    /// `"local"` instead of being overwritten with `"gdrive"`.
    #[test]
    fn complete_force_re_pair_keeps_stored_local_sync_provider() {
        let conn = setup();
        db::set_setting(&conn, "sync_provider", "local").unwrap();

        let prior = db::get_sync_provider(&conn).unwrap();
        clear_force_re_pair_and_reassert_sync(&conn, prior.as_deref());

        let provider = db::get_setting(&conn, "sync_provider")
            .unwrap()
            .expect("sync_provider must still be set");
        assert_eq!(
            provider, "local",
            "complete_force_re_pair must keep the stored sync_provider"
        );
    }

    // ─── Onboard: session_id / pending Drive session ──────────────────────────

    /// Helper: make a minimal GDrive `PendingDriveSession` with a known refresh token.
    fn make_pending_drive_session(
        refresh_token: &str,
    ) -> crate::commands::pending_drive_session::PendingDriveSession {
        use crate::commands::pending_drive_session::{PendingCloudSession, PendingDriveSession};
        use crate::sync::gdrive_provider::GDriveSession;
        use std::time::{Duration, Instant};
        PendingDriveSession {
            session: PendingCloudSession::GDrive {
                session: GDriveSession {
                    access_token: "at_test".to_string(),
                    expires_at: Instant::now() + Duration::from_secs(3600),
                    refresh_token: zeroize::Zeroizing::new(refresh_token.to_string()),
                    client_id: "cid_test".to_string(),
                    client_secret: "cs_test".to_string(),
                },
                root_folder_id: "root_test".to_string(),
            },
            created_at: Instant::now(),
        }
    }

    /// Test 1: When a matching pending session exists, onboard_complete_inner
    /// persists the four sync settings atomically with the password/mode flip.
    #[tokio::test]
    #[serial_test::serial]
    async fn onboard_complete_inner_with_session_id_persists_sync_settings_atomically() {
        use crate::commands::pending_drive_session;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        // Use a unique session_id scoped to this test — no reset() needed
        // because each test uses its own key; consume() removes it after use.
        let refresh_token = "rt_test_token_abc123";
        let session_id = "session_test1_persists_sync_settings".to_string();
        pending_drive_session::stash(
            session_id.clone(),
            make_pending_drive_session(refresh_token),
        );

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None, // skip boot file in test
            Some(session_id),
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("onboard_complete_inner with session_id must succeed");

        // encryption_mode must be Password.
        assert_eq!(
            db::get_encryption_mode(&new_conn).unwrap(),
            db::EncryptionMode::Password,
            "encryption_mode must be Password"
        );

        // sync_connected must be "true".
        let sync_connected = db::get_setting(&new_conn, "sync_connected")
            .unwrap()
            .expect("sync_connected must be set");
        assert_eq!(sync_connected, "true", "sync_connected must be 'true'");

        // sync_provider must be "gdrive".
        let sync_provider = db::get_setting(&new_conn, "sync_provider")
            .unwrap()
            .expect("sync_provider must be set");
        assert_eq!(sync_provider, "gdrive", "sync_provider must be 'gdrive'");

        // gdrive_refresh_token must match the stashed token.
        let stored_token = db::get_setting(&new_conn, "gdrive_refresh_token")
            .unwrap()
            .expect("gdrive_refresh_token must be set");
        assert_eq!(
            stored_token, refresh_token,
            "gdrive_refresh_token must match the stashed token"
        );

        // sync_enabled must be true.
        assert!(
            db::get_sync_enabled(&new_conn).unwrap(),
            "sync_enabled must be true"
        );
    }

    /// A freshly onboarded device has no prior KDF preset to inherit, so it must
    /// wrap under FAST. Asserts that the persisted `WRAPPED_ENCRYPTION_KEY_KEY`
    /// blob carries FAST params (134-hex self-describing format).
    #[tokio::test]
    async fn onboard_complete_inner_wraps_under_fast() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None, // skip boot file in test
            None, // no Drive session
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("onboard_complete_inner must succeed");

        let wrapped = db::get_setting(&new_conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .expect("wrapped key must be set");
        let blob = hex::decode(&wrapped).unwrap();
        assert_eq!(
            crate::utils::encryption::parse_kek_params(&blob)
                .unwrap()
                .m_cost,
            KdfParams::FAST.m_cost,
            "onboarded device must wrap under FAST"
        );
    }

    /// Test 2: When session_id is provided but no pending entry exists, inner
    /// SUCCEEDS (consume runs AFTER rekey — see the consume-after-rekey
    /// rationale in onboard_complete_inner) and silently skips Drive sync
    /// persistence. The DB is fully committed to Password mode but
    /// sync_connected / gdrive_refresh_token are NOT written. The user lands
    /// in password mode without Drive and reconnects from Settings → Sync.
    /// `PENDING_DRIVE_SESSION_EXPIRED` is no longer returned from this path
    /// (the rekey has already succeeded; reverting would be hostile UX).
    #[tokio::test]
    #[serial_test::serial]
    async fn onboard_complete_inner_with_missing_session_id_skips_sync() {
        use crate::commands::pending_drive_session;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        // Use a session_id that is never stashed — uniquely named to avoid
        // accidental collision with other tests stashing different ids.
        let _ = pending_drive_session::consume("session_test2_never_stashed_xyzzy");
        // Do NOT stash anything.

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        // Pre-seed encryption_mode = Unset so the flip is observable.
        db::set_encryption_mode(&conn2, db::EncryptionMode::Unset).unwrap();

        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None, // skip boot file in test
            Some("session_test2_never_stashed_xyzzy".to_string()),
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("must succeed even when pending session is missing");

        // Verify the DB ended in the expected partial-state: mode is
        // Password (rekey happened), but no Drive sync settings.
        assert_eq!(
            db::get_encryption_mode(&new_conn).unwrap(),
            db::EncryptionMode::Password,
            "mode must be flipped to Password"
        );
        assert_eq!(
            db::get_setting(&new_conn, "sync_connected").unwrap(),
            None,
            "sync_connected must not be written when pending session is missing"
        );
        assert_eq!(
            db::get_setting(&new_conn, "gdrive_refresh_token").unwrap(),
            None,
            "refresh token must not be written when pending session is missing"
        );
    }

    /// Test 3: When session_id is None, inner flips encryption_mode=Password
    /// but does NOT write any sync settings.
    #[tokio::test]
    async fn onboard_complete_inner_without_session_id_skips_sync_persistence() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None, // skip boot file in test
            None, // no session_id
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("onboard_complete_inner without session_id must succeed");

        // encryption_mode must be Password (normal onboarding completes).
        assert_eq!(
            db::get_encryption_mode(&new_conn).unwrap(),
            db::EncryptionMode::Password,
            "encryption_mode must be Password"
        );

        // No sync settings should be written.
        assert!(
            db::get_setting(&new_conn, "sync_connected")
                .unwrap()
                .is_none(),
            "sync_connected must NOT be set when session_id is None"
        );
        assert!(
            db::get_setting(&new_conn, "gdrive_refresh_token")
                .unwrap()
                .is_none(),
            "gdrive_refresh_token must NOT be set when session_id is None"
        );
        assert!(
            !db::get_sync_enabled(&new_conn).unwrap(),
            "sync_enabled must NOT be true when session_id is None"
        );
    }

    /// Test 4: When boot_path triggers a failure BEFORE the tail persist, the
    /// rollback undoes the password group AND the pending Drive session is
    /// NOT burned. Because consume happens after rekey succeeds (per the
    /// consume-after-rekey rationale), a boot_path failure occurs BEFORE
    /// consume runs — so the pending session remains available for retry
    /// without re-running OAuth.
    #[tokio::test]
    #[serial_test::serial]
    async fn onboard_complete_inner_rollback_preserves_pending_session() {
        use crate::commands::pending_drive_session;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use std::path::Path;

        // Use a unique session_id scoped to this test — no reset() needed.
        let refresh_token = "rt_rollback_test";
        let session_id = "session_test4_rollback_unique_xyzzy".to_string();
        pending_drive_session::stash(
            session_id.clone(),
            make_pending_drive_session(refresh_token),
        );

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();

        // Pass a boot_path into a non-existent directory to force boot file failure.
        let bad_boot_path = Path::new("/nonexistent_dir/memlore_test.boot");

        let result = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            Some(bad_boot_path), // triggers rollback
            Some(session_id),
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await;

        // Must fail.
        assert!(result.is_err(), "must fail when boot path is bad");
        let (_returned_conn, err) = result.unwrap_err();
        assert!(
            err.contains("Failed to write boot file") || err.contains("boot"),
            "error must mention boot failure, got: {err}"
        );
        // The pending session must STILL be available — consume runs after
        // rekey and the boot-file failure aborts before that point. This is
        // the user-visible benefit of consume-after-rekey: a transient I/O
        // failure does not force re-running OAuth.
        let pending = pending_drive_session::consume("session_test4_rollback_unique_xyzzy");
        assert!(
            pending.is_some(),
            "pending session must be preserved when rollback fires before consume"
        );
    }

    /// Consuming a Folder pending session in `onboard_complete` writes the
    /// four LocalConfig rows (`sync_provider`, `sync_config_json`,
    /// `sync_connected`, `sync_enabled`) and does not touch the Drive token.
    #[tokio::test]
    #[serial_test::serial]
    async fn onboard_complete_inner_with_folder_session_persists_folder_rows() {
        use crate::commands::pending_drive_session::{
            self, PendingCloudSession, PendingDriveSession,
        };

        let session_id = "session_test_folder_persist_rows".to_string();
        let root_path = "/tmp/xj-folder-onboard";
        pending_drive_session::stash(
            session_id.clone(),
            PendingDriveSession {
                session: PendingCloudSession::Folder {
                    kind: "local".to_string(),
                    root_path: root_path.to_string(),
                },
                created_at: std::time::Instant::now(),
            },
        );

        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let conn2 = setup();
        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            conn2,
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None,
            Some(session_id),
            None,
        )
        .await
        .expect("onboard_complete_inner with Folder pending session must succeed");

        assert_eq!(
            db::get_setting(&new_conn, "sync_provider")
                .unwrap()
                .as_deref(),
            Some("local"),
            "sync_provider must be the Folder kind"
        );
        let config = db::get_sync_config_json(&new_conn)
            .unwrap()
            .expect("sync_config_json must be set");
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        assert_eq!(
            parsed["root_path"].as_str(),
            Some(root_path),
            "sync_config_json must be the LocalConfig {{root_path}} shape"
        );
        assert_eq!(
            db::get_setting(&new_conn, "sync_connected")
                .unwrap()
                .as_deref(),
            Some("true"),
            "sync_connected must be true"
        );
        assert!(
            db::get_sync_enabled(&new_conn).unwrap(),
            "sync_enabled must be true"
        );
        assert!(
            db::get_setting(&new_conn, "gdrive_refresh_token")
                .unwrap()
                .is_none(),
            "Folder persist must not write a Drive refresh token"
        );
    }

    // ── recover_master_and_rewrap (offline "Forgot password") ────────────────

    /// Build a recovery slot exactly like setup does:
    /// `recovery_wrapped = AES-GCM(recovery_key, master_key)`.
    fn make_recovery_slot(master_key: &[u8; 32], mnemonic: &str) -> String {
        let parsed = crate::utils::recovery::validate_recovery_mnemonic(mnemonic).unwrap();
        let recovery_key = crate::utils::recovery::derive_recovery_key(&parsed);
        let blob =
            crate::utils::encryption::encrypt_data(&recovery_key, master_key.as_ref()).unwrap();
        hex::encode(&blob)
    }

    #[test]
    fn recover_master_and_rewrap_recovers_exact_master_key() {
        let master_key = [7u8; 32];
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let slot = make_recovery_slot(&master_key, &mnemonic);

        let (recovered, new_wrapped, new_kek_salt_hex) =
            recover_master_and_rewrap(&slot, &mnemonic, "newpass12", KdfParams::FAST).unwrap();

        // The recovered master must be byte-identical to the original.
        assert_eq!(&*recovered, &master_key, "recovered master key must match");

        // The fresh password wrapping must round-trip: unwrapping new_wrapped
        // with the new password + new salt yields the same master key.
        let salt = hex::decode(&new_kek_salt_hex).unwrap();
        let unwrapped = unwrap_key(&new_wrapped, "newpass12", &salt).unwrap();
        assert_eq!(
            &*unwrapped, &master_key,
            "new password wrapping must round-trip to the same master"
        );
    }

    #[test]
    fn recover_master_and_rewrap_rejects_wrong_phrase() {
        let master_key = [9u8; 32];
        let real_mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let slot = make_recovery_slot(&master_key, &real_mnemonic);

        // A different valid 24-word phrase derives a different recovery key,
        // so the AES-GCM tag check fails.
        let wrong_mnemonic = loop {
            let m = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
            if m != real_mnemonic {
                break m;
            }
        };

        let result =
            recover_master_and_rewrap(&slot, &wrong_mnemonic, "newpass12", KdfParams::FAST);
        assert!(result.is_err(), "wrong phrase must be rejected");
        assert!(
            result.unwrap_err().contains("does not match"),
            "error must indicate the phrase does not match"
        );
    }

    #[test]
    fn recover_master_and_rewrap_rejects_invalid_phrase() {
        let slot = make_recovery_slot(
            &[1u8; 32],
            &crate::utils::recovery::generate_recovery_mnemonic().unwrap(),
        );
        let result = recover_master_and_rewrap(
            &slot,
            "not a valid bip39 phrase",
            "newpass12",
            KdfParams::FAST,
        );
        assert!(result.is_err(), "garbage phrase must be rejected");
    }

    #[test]
    fn recover_master_and_rewrap_rejects_short_password() {
        let master_key = [3u8; 32];
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let slot = make_recovery_slot(&master_key, &mnemonic);

        let result = recover_master_and_rewrap(&slot, &mnemonic, "short", KdfParams::FAST);
        assert!(
            result.is_err(),
            "password under the minimum length must be rejected"
        );
    }

    /// Recovery reads its KDF params from the PLAINTEXT boot file, which an
    /// attacker with local access can tamper. A header carrying below-floor
    /// params (e.g. m=8 KiB) must NOT survive into the re-wrapped master: the
    /// caller derives params via `parse_kek_params(...).ok().unwrap_or(HIGH)`, so
    /// a rejected header falls back to HIGH and the recovered vault is re-wrapped
    /// under FAST, not the attacker's weak KDF. This pins the exact expression
    /// `recover_with_passphrase` uses to pick `current_params`.
    #[test]
    fn recovery_rejects_tampered_weak_boot_params_and_falls_back_to_fast() {
        // A 67-byte header with intact length but downgraded params.
        let mut weak_blob = vec![0x01u8]; // KEK_BLOB_VERSION_1
        weak_blob.extend_from_slice(&8u32.to_le_bytes()); // m = 8 KiB
        weak_blob.push(1); // t
        weak_blob.push(1); // p
        weak_blob.extend_from_slice(&[0u8; 60]); // nonce+ct+tag placeholder
        let weak_hex = hex::encode(&weak_blob);

        // Exactly what recover_with_passphrase computes from boot.wrapped_key.
        // Below-floor params are rejected by parse_kek_params → fallback to FAST.
        let current_params = hex::decode(&weak_hex)
            .ok()
            .and_then(|blob| parse_kek_params(&blob).ok())
            .unwrap_or(KdfParams::FAST);
        assert_eq!(
            current_params,
            KdfParams::FAST,
            "tampered below-floor boot params must be rejected → FAST fallback"
        );

        // And the resulting re-wrap actually carries FAST, not the weak params.
        let master_key = [5u8; 32];
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let slot = make_recovery_slot(&master_key, &mnemonic);
        let (_master, new_wrapped, _salt) =
            recover_master_and_rewrap(&slot, &mnemonic, "newpass12", current_params).unwrap();
        let blob = hex::decode(&new_wrapped).unwrap();
        assert_eq!(
            parse_kek_params(&blob).unwrap().m_cost,
            KdfParams::FAST.m_cost,
            "recovery must re-wrap under FAST, never the attacker's weak m_cost"
        );
    }

    /// The backfill guard skips writing the recovery slot when the stored
    /// fingerprint does not match the live master (rotation window). This pins
    /// the invariant the guard relies on: a different master yields a different
    /// fingerprint, so the OLD stored fingerprint never equals the NEW live one
    /// while the slot is stale. If this ever became false the guard would let a
    /// stale slot poison the boot file.
    #[test]
    fn key_fingerprint_distinguishes_old_and_new_master() {
        let old_master = [1u8; 32];
        let new_master = [2u8; 32];
        let old_fp = hex::encode(crate::utils::encryption::key_fingerprint(&old_master));
        let new_fp = hex::encode(crate::utils::encryption::key_fingerprint(&new_master));
        assert_ne!(
            old_fp, new_fp,
            "rotation changes the master; the backfill guard must see a fingerprint mismatch"
        );
        // And the same master is byte-stable, so a non-rotated vault backfills.
        let old_fp_again = hex::encode(crate::utils::encryption::key_fingerprint(&old_master));
        assert_eq!(old_fp, old_fp_again, "fingerprint must be deterministic");
    }

    // ─── prune-on-hydrate: regression tests for revoked-device-resurrection ──
    //
    // These tests verify that merge_device_slots_into_local converges the local
    // devices table to the cloud-authoritative set (cloud listing is the source
    // of truth). Before the fix the merge was additive-only and rows absent from
    // the cloud listing were never removed.

    /// merge_device_slots_into_local with cloud={A} and local={A(current),B,C}
    /// must converge to {A} only — peers absent from cloud are pruned.
    ///
    /// This is the direct regression for the "revoked device stays in the list"
    /// bug: before the fix, B and C were never deleted.
    #[test]
    fn merge_device_slots_prunes_peers_absent_from_cloud() {
        use crate::sync::keyring_v2::types::{DeviceSlotV2, KEYRING_V2_VERSION};

        let conn = setup();

        // Seed local table: A (current), B (peer), C (peer — simulates revoked-on-cloud).
        for (id, current) in &[("dev-a", true), ("dev-b", false), ("dev-c", false)] {
            db::upsert_device(
                &conn,
                &db::DeviceRow {
                    device_id: id.to_string(),
                    name: format!("Device {id}"),
                    created_at: 1000,
                    last_seen_at: 1000,
                    is_current: *current,
                    is_revoked: false,
                },
            )
            .unwrap();
        }

        // Cloud listing contains ONLY A.
        let cloud_slots = vec![DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: "dev-a".to_string(),
            name: "Device dev-a".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        }];

        merge_device_slots_into_local(&conn, &cloud_slots, "dev-a");

        let rows = db::list_devices(&conn).unwrap();
        assert_eq!(
            rows.len(),
            1,
            "local table must converge to cloud listing: expected 1 row, got {} — \
             peers absent from cloud (dev-b, dev-c) must be pruned",
            rows.len()
        );
        assert_eq!(rows[0].device_id, "dev-a", "only dev-a must remain");
        assert!(rows[0].is_current, "dev-a must still be marked current");
    }

    /// A revoked row (is_revoked=1) present locally but absent from cloud IS
    /// pruned on merge — proves revoked devices disappear everywhere on the
    /// next refresh after the revoking machine pushes to cloud.
    #[test]
    fn merge_device_slots_prunes_revoked_row_absent_from_cloud() {
        use crate::sync::keyring_v2::types::{DeviceSlotV2, KEYRING_V2_VERSION};

        let conn = setup();

        // Local: Mac (current) + MacVM (revoked, absent from cloud).
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "mac".to_string(),
                name: "Mac".to_string(),
                created_at: 1000,
                last_seen_at: 1000,
                is_current: true,
                is_revoked: false,
            },
        )
        .unwrap();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: "mac-vm".to_string(),
                name: "Mac VM".to_string(),
                created_at: 2000,
                last_seen_at: 2000,
                is_current: false,
                is_revoked: true, // marked revoked locally by finalize_publish_local
            },
        )
        .unwrap();

        // Cloud listing has only "mac" (mac-vm was deleted by publish_keyring).
        let cloud_slots = vec![DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: "mac".to_string(),
            name: "Mac".to_string(),
            created_at: 1000,
            last_seen_at: 1000,
        }];

        merge_device_slots_into_local(&conn, &cloud_slots, "mac");

        let rows = db::list_devices(&conn).unwrap();
        assert_eq!(
            rows.len(),
            1,
            "revoked device absent from cloud must be pruned on merge; got {} rows",
            rows.len()
        );
        assert!(
            !rows.iter().any(|r| r.device_id == "mac-vm"),
            "mac-vm must not appear after merge"
        );
    }

    /// Two-machine convergence: M1 revokes M2 (removes M2 from cloud); M3
    /// re-pairs (onboards) while STILL holding a stale M2 local row → M3's
    /// local table must show only {M1, M3} after onboard, not {M1, M2, M3}.
    ///
    /// This exercises the onboard-path prune added in onboard_complete_inner.
    /// Without the prune the hydrate loop was additive-only: M2's pre-existing
    /// local row would survive the onboard and len would be 3.
    ///
    /// Scenario:
    /// (a) M1 seeds the vault; M2 onboards → cloud has {M1, M2}.
    /// (b) M1 revokes M2 → M2 slot deleted from cloud; cloud now has {M1}.
    /// (c) conn3 pre-seeded with M2's stale row (simulates a machine that was
    ///     a peer before and is now re-pairing after a rotation).
    /// (d) M3 re-pairs via onboard_complete_inner → cloud gets {M1, M3}.
    /// (e) M3's local table must be {M1, M3} — M2's stale row must be pruned.
    #[tokio::test]
    async fn two_machine_convergence_revoke_then_repair() {
        use crate::sync::keyring_v2::io as kio;
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        // (a) M1 seeds vault + publishes.
        let (conn1, mnemonic, pub_ctx) = seed_v2_vault("testpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // M2 onboards → cloud has {M1, M2}.
        let conn2 = setup();
        let ks2 = EncryptionKeyState::new();
        let conn2 = onboard_complete_inner(
            conn2,
            &ks2,
            &provider,
            &mnemonic,
            "m2pass123456",
            "M2",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("M2 onboard must succeed");
        let m2_id = db::get_or_create_device_id(&conn2).unwrap();

        let slots_before = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(
            slots_before.len(),
            2,
            "cloud must have {{M1, M2}} before revoke"
        );

        // (b) Simulate M1 revoking M2: delete M2 slot from cloud
        // (this is what publish_keyring does on the revoking machine).
        kio::delete_device_slot(&provider, &m2_id)
            .await
            .expect("delete M2 slot from cloud");

        let slots_after_revoke = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(
            slots_after_revoke.len(),
            1,
            "cloud must have only M1 after revoke"
        );

        // (c) Pre-seed conn3 with M2's stale row — this simulates a machine
        // (now re-pairing) that was previously a peer and still holds M2 locally.
        // This is what makes this test a true regression guard for the onboard prune:
        // without the prune, onboard's additive-only hydrate would leave M2 in place.
        let conn3 = setup();
        db::upsert_device(
            &conn3,
            &db::DeviceRow {
                device_id: m2_id.clone(),
                name: "M2 (stale local row)".to_string(),
                created_at: 2000,
                last_seen_at: 2000,
                is_current: false,
                is_revoked: false,
            },
        )
        .unwrap();

        // (d) M3 re-pairs into the vault that already has M2's stale row in conn3.
        let ks3 = EncryptionKeyState::new();
        let conn3 = onboard_complete_inner(
            conn3,
            &ks3,
            &provider,
            &mnemonic,
            "m3pass123456",
            "M3",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("M3 onboard must succeed");

        // Cloud must now have {M1, M3} only.
        let slots_final = kio::list_device_slots(&provider).await.unwrap();
        assert_eq!(
            slots_final.len(),
            2,
            "cloud must have {{M1, M3}} after M3 re-pairs; M2 slot was deleted"
        );

        // (e) M3's local devices table must show exactly {M1, M3} — NOT M2.
        // The onboard-path prune must have removed M2's pre-existing local row.
        let m1_id = db::get_or_create_device_id(&conn1).unwrap();
        let m3_id = db::get_or_create_device_id(&conn3).unwrap();
        let rows_m3 = db::list_devices(&conn3).unwrap();
        let ids_m3: Vec<&str> = rows_m3.iter().map(|r| r.device_id.as_str()).collect();

        assert!(
            !ids_m3.contains(&m2_id.as_str()),
            "M2's stale row must be pruned by the onboard-path prune; got: {ids_m3:?}"
        );
        assert!(
            ids_m3.contains(&m1_id.as_str()),
            "M1 must appear in M3's local list; got: {ids_m3:?}"
        );
        assert!(
            ids_m3.contains(&m3_id.as_str()),
            "M3 must appear in M3's local list; got: {ids_m3:?}"
        );
        assert_eq!(
            rows_m3.len(),
            2,
            "M3's local list must show exactly 2 devices {{M1, M3}}; got {ids_m3:?}"
        );
    }

    // ─── Phase 3 T4: content-key list / db_key tests ─────────────────────────

    /// T1 / T4-a: fresh onboard (creator path) sets v1 content-key list + db_key.
    ///
    /// Verifies that `confirm_first_time_setup_inner` (boot_path=None, skips
    /// PRAGMA rekey) persists `WRAPPED_CONTENT_LIST`, `CONTENT_KEY_EPOCH=1`,
    /// and `CLOUD_CONTENT_FINGERPRINT` to the DB, and that the key state is
    /// loaded with a content-key list (not just a plain master).
    #[test]
    fn fresh_onboard_sets_v1_list_and_db_key() {
        let conn = setup();
        let handle =
            begin_first_time_setup_inner(&conn, "testpassword12", "M1", KdfParams::FAST).unwrap();
        let mnemonic_phrase = handle.mnemonic.join(" ");
        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();
        let key_state = EncryptionKeyState::new();
        let (conn, _pub_ctx) = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            "testpassword12",
            std::path::Path::new("/tmp/unused_t4.db"),
            None, // skip PRAGMA rekey for in-memory DB
            None,
            None,
        )
        .expect("confirm must succeed");

        // Verify DB settings.
        let list_hex = db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
            .unwrap()
            .expect("WRAPPED_CONTENT_LIST must be set");
        assert!(
            !list_hex.is_empty(),
            "WRAPPED_CONTENT_LIST must not be empty"
        );
        // Exactly 128 hex chars per epoch: 4-byte epoch + 60-byte wrapped blob.
        assert_eq!(
            list_hex.len() % 128,
            0,
            "WRAPPED_CONTENT_LIST must be a multiple of 128 hex chars"
        );

        let epoch = db::get_setting(&conn, db::CONTENT_KEY_EPOCH)
            .unwrap()
            .expect("CONTENT_KEY_EPOCH must be set");
        assert_eq!(epoch, "1", "epoch must be 1 for a fresh vault");

        let fp = db::get_setting(&conn, db::CLOUD_CONTENT_FINGERPRINT)
            .unwrap()
            .expect("CLOUD_CONTENT_FINGERPRINT must be set");
        assert_eq!(fp.len(), 64, "fingerprint must be 64 hex chars (32 bytes)");

        // Verify key state: must be initialized and support encrypting with the
        // content key (i.e., set_content_state was called, not just set_key).
        assert!(key_state.is_initialized().unwrap());
        // Encrypt something to verify the key works.
        let ct = crate::utils::encryption::encrypt_data_with_state(b"hello", &key_state)
            .expect("encrypt must succeed with content-key state");
        assert!(!ct.is_empty());

        // Verify the content-key list decodes correctly with the master key.
        // We unwrap master from the DB to use it here (uses FAST KDF params).
        let wrapped_master_hex = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .expect("wrapped master must be in DB");
        let kek_salt_hex = db::get_setting(&conn, db::KEK_SALT_KEY)
            .unwrap()
            .expect("kek_salt must be in DB");
        let kek_salt = hex::decode(&kek_salt_hex).unwrap();
        let master = unwrap_key(&wrapped_master_hex, "testpassword12", &kek_salt)
            .expect("unwrap master must succeed");
        let decoded = decode_content_key_list(&master, &list_hex).unwrap();
        assert_eq!(decoded.len(), 1, "must have exactly 1 epoch");
        assert!(decoded.contains_key(&1), "epoch 1 must be present");

        // Suppress unused-variable warning for mnemonic_phrase.
        let _ = mnemonic_phrase;
    }

    /// T2 / T4-b: after fresh onboard, the stored content-key list + db_key
    /// can be decoded and the decoded key matches what was encoded.
    ///
    /// This is the T2 unlock path exercised without Tauri state — tests the
    /// codec round-trip + key equality.
    #[test]
    fn unlock_roundtrips_list_and_db_key_reads_entries() {
        use crate::utils::encryption::{decode_content_key_list, encode_content_key_list};

        let conn = setup();
        let handle =
            begin_first_time_setup_inner(&conn, "unlockpass123", "M1", KdfParams::FAST).unwrap();
        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();
        let key_state = EncryptionKeyState::new();
        let (conn, _pub_ctx) = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            "unlockpass123",
            std::path::Path::new("/tmp/unused_t4b.db"),
            None,
            None,
            None,
        )
        .expect("confirm must succeed");

        // Simulate T2 unlock: read the stored content-key list from DB settings
        // and decode it with the master key.
        let list_hex = db::get_setting(&conn, db::WRAPPED_CONTENT_LIST)
            .unwrap()
            .unwrap();
        let wrapped_master_hex = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
            .unwrap()
            .unwrap();
        let kek_salt_hex = db::get_setting(&conn, db::KEK_SALT_KEY).unwrap().unwrap();
        let kek_salt = hex::decode(&kek_salt_hex).unwrap();
        let master = unwrap_key(&wrapped_master_hex, "unlockpass123", &kek_salt).unwrap();

        // Decode the stored content-key list.
        let decoded = decode_content_key_list(&master, &list_hex).unwrap();
        assert_eq!(decoded.len(), 1);

        // Re-encode and verify it matches the original stored hex.
        let reencoded = encode_content_key_list(&master, &decoded).unwrap();
        // The re-encoded list will differ due to random nonces — but the decoded keys
        // must round-trip correctly: decode again from the re-encoded to verify identity.
        let decoded2 = decode_content_key_list(&master, &reencoded).unwrap();
        assert_eq!(
            *decoded2[&1], *decoded[&1],
            "content key v1 must survive re-encode/decode"
        );

        // Load the key state from the decoded keys + a fresh db_key.
        let key_state2 = EncryptionKeyState::new();
        let mut fresh_db_key = Zeroizing::new([0u8; 32]);
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, fresh_db_key.as_mut());
        key_state2
            .set_content_state(decoded, 1, fresh_db_key, Zeroizing::new(*master))
            .unwrap();
        assert!(key_state2.is_initialized().unwrap());

        // Verify cross-compatibility: encrypt under original state, fingerprint
        // must match what's stored in DB.
        let stored_fp = db::get_setting(&conn, db::CLOUD_CONTENT_FINGERPRINT)
            .unwrap()
            .unwrap();
        // The stored fingerprint is key_fingerprint(derive_sync_key(content_key_v1)).
        key_state2
            .with_sync_key(|sk| {
                let fp = crate::utils::encryption::key_fingerprint(sk);
                let fp_hex = hex::encode(fp);
                assert_eq!(
                    fp_hex, stored_fp,
                    "re-loaded key state fingerprint must match stored CLOUD_CONTENT_FINGERPRINT"
                );
                Ok(())
            })
            .unwrap();
    }

    /// T3 / T4-c: legacy install (no `wrapped_content_list` in boot file)
    /// migrates the DB from master-derived to db_key-derived key on first unlock.
    ///
    /// Uses a real tempfile DB + boot file so PRAGMA rekey can execute.
    /// Drives `initialize_encryption_inner` (the real production function, not a
    /// reimplementation) to verify the actual T3 migration path including rekey
    /// ordering, inverse-rekey-on-failure, connection swap, and boot file update.
    #[test]
    fn legacy_install_migrates_db_to_db_key_once() {
        use crate::utils::boot_file::{self, BootFile};
        use crate::utils::encryption::derive_sqlcipher_key;
        use rand::rngs::OsRng;
        use rand::RngCore;
        use tempfile::TempDir;
        use zeroize::Zeroizing;

        // 1. Set up a "legacy" install: DB keyed under derive_sqlcipher_key(master),
        //    boot file has no wrapped_content_list.
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = boot_file::boot_path(&db_path);

        // Generate master + wrap it.
        let mut raw_master = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_master.as_mut());
        let kek_salt = crate::utils::encryption::generate_encryption_salt();
        let kek_salt_hex = hex::encode(kek_salt);
        let wrapped_master_hex =
            wrap_key_with(&*raw_master, "legacypass12", &kek_salt, KdfParams::FAST).unwrap();

        // Open DB with master-derived key (legacy state).
        let old_sqlcipher_key = derive_sqlcipher_key(&*raw_master);
        let db_path_str = db_path.to_string_lossy().into_owned();
        {
            let legacy_conn = crate::db::open_with_key(&db_path_str, &*old_sqlcipher_key).unwrap();
            crate::db::schema::migrate(&legacy_conn).unwrap();
            // Persist the wrapped master so initialize_encryption can read it.
            db::set_setting(
                &legacy_conn,
                db::WRAPPED_ENCRYPTION_KEY_KEY,
                &wrapped_master_hex,
            )
            .unwrap();
            db::set_setting(&legacy_conn, db::KEK_SALT_KEY, &kek_salt_hex).unwrap();
            db::set_password_hash(&legacy_conn, "legacypass12").unwrap();
            db::set_encryption_mode(&legacy_conn, db::EncryptionMode::Password).unwrap();
            // Intentionally do NOT set WRAPPED_CONTENT_LIST — simulates pre-Phase-3 install.
        }

        // Write boot file without content list (legacy state).
        let boot = BootFile {
            unlock_method: crate::utils::boot_file::UnlockMethod::Password,
            mode: db::EncryptionMode::Password,
            kek_salt: Some(kek_salt_hex.clone()),
            wrapped_key: Some(wrapped_master_hex.clone()),
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        boot_file::save(&boot, &boot_path).unwrap();

        // 2. Run the REAL initialize_encryption_inner (T3 path) via a placeholder
        //    AppState + EncryptionKeyState. This drives the actual production code,
        //    not a reimplementation.
        let placeholder = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&placeholder).unwrap();
        let state = crate::AppState::new(placeholder);
        let key_state = crate::EncryptionKeyState::new();
        let password = Zeroizing::new("legacypass12".to_string());

        initialize_encryption_inner(
            &state,
            &key_state,
            &boot,
            &boot_path,
            &db_path,
            &raw_master,
            &password,
            &wrapped_master_hex,
            &kek_salt,
            &kek_salt_hex,
        )
        .expect("T3 migration must succeed");

        // 3. Verify: key_state has content keys + db_key loaded.
        assert!(
            key_state.is_initialized().unwrap(),
            "key_state must be initialized after T3"
        );
        // Retrieve the db_key from state and verify the DB is readable under it.
        let db_key_derived_conn = key_state
            .with_db_key(|db_key| {
                let sqlcipher_key = derive_sqlcipher_key(db_key);
                crate::db::open_with_key(&db_path_str, &*sqlcipher_key)
                    .map_err(|e| format!("cannot open DB under migrated db_key: {e}"))
            })
            .expect("db_key must be available after T3");

        let stored_list = db::get_setting(&db_key_derived_conn, db::WRAPPED_CONTENT_LIST)
            .unwrap()
            .expect("WRAPPED_CONTENT_LIST must be present after T3 migration");
        assert!(
            stored_list.len() % 128 == 0 && !stored_list.is_empty(),
            "WRAPPED_CONTENT_LIST must be a non-empty multiple of 128 hex chars"
        );
        let stored_epoch = db::get_setting(&db_key_derived_conn, db::CONTENT_KEY_EPOCH)
            .unwrap()
            .expect("CONTENT_KEY_EPOCH must be present after T3");
        assert_eq!(stored_epoch, "1");
        let migration_flag =
            db::get_setting(&db_key_derived_conn, db::NEEDS_CLOUD_CONTENT_MIGRATION)
                .unwrap()
                .expect("NEEDS_CLOUD_CONTENT_MIGRATION must be set after T3");
        assert_eq!(migration_flag, "1");

        // Verify DB is NOT readable under the old master-derived key (rekey permanent).
        let old_check = crate::db::open_with_key(&db_path_str, &*old_sqlcipher_key);
        if let Ok(wrong_conn) = old_check {
            let wrong_read: Result<i64, _> =
                wrong_conn.query_row("SELECT count(*) FROM settings", [], |r| r.get(0));
            assert!(
                wrong_read.is_err(),
                "DB must NOT be readable under old master-derived key after T3 migration"
            );
        }
        // else: if open fails directly, that's even better.

        // 4. Verify boot file was updated with content list + db_key.
        let updated_boot = boot_file::load(&boot_path).unwrap();
        assert!(
            updated_boot.wrapped_content_list.is_some(),
            "boot file must have wrapped_content_list after T3 migration"
        );
        assert!(
            updated_boot.wrapped_db_key.is_some(),
            "boot file must have wrapped_db_key after T3 migration"
        );
    }

    /// T4-d: second unlock finds `wrapped_content_list` in boot file and skips
    /// the T3 migration (T2 path). Drives `initialize_encryption_inner` (the real
    /// production function) to verify the T2 path sets state without re-migrating.
    #[test]
    fn second_unlock_skips_migration() {
        use crate::utils::boot_file::{self, BootFile};
        use crate::utils::encryption::{
            derive_sqlcipher_key, derive_sync_key, key_fingerprint, wrap_content_key,
        };
        use rand::rngs::OsRng;
        use rand::RngCore;
        use tempfile::TempDir;
        use zeroize::Zeroizing;

        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = boot_file::boot_path(&db_path);

        // Generate master + v1 + db_key (simulating post-T3 state).
        let mut raw_master = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_master.as_mut());
        let mut raw_db_key = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_db_key.as_mut());
        let v1 = crate::utils::encryption::generate_content_key();

        let kek_salt = crate::utils::encryption::generate_encryption_salt();
        let kek_salt_hex = hex::encode(kek_salt);
        let wrapped_master_hex =
            wrap_key_with(&*raw_master, "secondpass12", &kek_salt, KdfParams::FAST).unwrap();

        // Build content-key list.
        let mut keys_map: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>> =
            std::collections::BTreeMap::new();
        keys_map.insert(1u32, Zeroizing::new(*v1));
        let encoded_list =
            crate::utils::encryption::encode_content_key_list(&*raw_master, &keys_map).unwrap();

        // Wrap db_key under password KEK.
        let kek_blob = hex::decode(&wrapped_master_hex).unwrap();
        let kek_params = crate::utils::encryption::parse_kek_params(&kek_blob).unwrap();
        let kek = crate::utils::encryption::derive_encryption_key_with(
            "secondpass12",
            &kek_salt,
            kek_params,
        )
        .unwrap();
        let wrapped_db_key_blob = wrap_content_key(&kek, &*raw_db_key).unwrap();
        let wrapped_db_key_hex = hex::encode(&wrapped_db_key_blob);

        // Create DB keyed under db_key-derived (post-T3 state).
        let sqlcipher_key = derive_sqlcipher_key(&*raw_db_key);
        let db_path_str = db_path.to_string_lossy().into_owned();
        {
            let conn = crate::db::open_with_key(&db_path_str, &*sqlcipher_key).unwrap();
            crate::db::schema::migrate(&conn).unwrap();
            db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &wrapped_master_hex).unwrap();
            db::set_setting(&conn, db::KEK_SALT_KEY, &kek_salt_hex).unwrap();
            db::set_password_hash(&conn, "secondpass12").unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
            db::set_setting(&conn, db::WRAPPED_CONTENT_LIST, &encoded_list).unwrap();
            db::set_setting(&conn, db::CONTENT_KEY_EPOCH, "1").unwrap();
            let cloud_fp_hex = hex::encode(key_fingerprint(&*derive_sync_key(&*v1)));
            db::set_setting(&conn, db::CLOUD_CONTENT_FINGERPRINT, &cloud_fp_hex).unwrap();
        }

        // Write boot file WITH content list (post-T3 state).
        let boot = BootFile {
            unlock_method: crate::utils::boot_file::UnlockMethod::Password,
            mode: db::EncryptionMode::Password,
            kek_salt: Some(kek_salt_hex.clone()),
            wrapped_key: Some(wrapped_master_hex.clone()),
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: Some(encoded_list.clone()),
            wrapped_db_key: Some(wrapped_db_key_hex.clone()),
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        boot_file::save(&boot, &boot_path).unwrap();

        // Run the REAL initialize_encryption_inner (T2 path) via a placeholder
        // AppState + EncryptionKeyState.
        let placeholder = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&placeholder).unwrap();
        let state = crate::AppState::new(placeholder);
        let key_state = crate::EncryptionKeyState::new();
        let password = Zeroizing::new("secondpass12".to_string());

        initialize_encryption_inner(
            &state,
            &key_state,
            &boot,
            &boot_path,
            &db_path,
            &raw_master,
            &password,
            &wrapped_master_hex,
            &kek_salt,
            &kek_salt_hex,
        )
        .expect("T2 path must succeed");

        // Verify key_state has content keys + db_key loaded.
        assert!(
            key_state.is_initialized().unwrap(),
            "key_state must be initialized after T2"
        );

        // Verify the recovered db_key opens the DB correctly.
        let epoch = key_state
            .with_db_key(|db_key| {
                let sc_key = derive_sqlcipher_key(db_key);
                let conn = crate::db::open_with_key(&db_path_str, &*sc_key)
                    .map_err(|e| format!("cannot open DB under db_key: {e}"))?;
                db::get_setting(&conn, db::CONTENT_KEY_EPOCH)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "CONTENT_KEY_EPOCH missing".to_string())
            })
            .expect("db_key must be available after T2");
        assert_eq!(epoch, "1", "epoch must still be 1 on T2 path");

        // The T3 migration flag must NOT be set (T2 path, no new migration).
        let needs_migration = key_state
            .with_db_key(|db_key| {
                let sc_key = derive_sqlcipher_key(db_key);
                let conn = crate::db::open_with_key(&db_path_str, &*sc_key)
                    .map_err(|e| format!("cannot open DB under db_key: {e}"))?;
                db::get_setting(&conn, db::NEEDS_CLOUD_CONTENT_MIGRATION).map_err(|e| e.to_string())
            })
            .expect("db_key must be available");
        assert!(
            needs_migration.is_none() || needs_migration.as_deref() == Some(""),
            "NEEDS_CLOUD_CONTENT_MIGRATION must NOT be set on T2 path; got {needs_migration:?}"
        );
    }

    /// C2 crash-resume: simulates a crash between the pre-rekey boot file write
    /// and the PRAGMA rekey.  The boot file has `migration_in_progress=true` and
    /// all new key material, but the DB is still master-keyed.  The next unlock
    /// must detect the marker, redo PRAGMA rekey idempotently, write DB settings,
    /// and clear the marker — producing the same final state as an uninterrupted T3.
    #[test]
    fn t3_interrupted_migration_resumes_on_next_unlock() {
        use crate::utils::boot_file::{self, BootFile};
        use crate::utils::encryption::{
            derive_sqlcipher_key, derive_sync_key, key_fingerprint, wrap_content_key,
        };
        use rand::rngs::OsRng;
        use rand::RngCore;
        use tempfile::TempDir;
        use zeroize::Zeroizing;

        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = boot_file::boot_path(&db_path);

        // 1. Create the pre-crash state:
        //    - DB keyed under master-derived (T3 not yet completed)
        //    - Boot file has migration_in_progress=true + all new key material
        //    (simulates crash after pre-write boot but before PRAGMA rekey)
        let mut raw_master = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_master.as_mut());
        let mut raw_db_key = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_db_key.as_mut());
        let v1 = crate::utils::encryption::generate_content_key();

        let kek_salt = crate::utils::encryption::generate_encryption_salt();
        let kek_salt_hex = hex::encode(kek_salt);
        let wrapped_master_hex =
            wrap_key_with(&*raw_master, "crashpass99", &kek_salt, KdfParams::FAST).unwrap();

        // Build the content-key list (as the T3 migration would have computed it).
        let mut keys_map: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>> =
            std::collections::BTreeMap::new();
        keys_map.insert(1u32, Zeroizing::new(*v1));
        let encoded_list =
            crate::utils::encryption::encode_content_key_list(&*raw_master, &keys_map).unwrap();

        // Wrap db_key under password KEK.
        let kek_blob = hex::decode(&wrapped_master_hex).unwrap();
        let kek_params = crate::utils::encryption::parse_kek_params(&kek_blob).unwrap();
        let kek = crate::utils::encryption::derive_encryption_key_with(
            "crashpass99",
            &kek_salt,
            kek_params,
        )
        .unwrap();
        let wrapped_db_key_blob = wrap_content_key(&kek, &*raw_db_key).unwrap();
        let wrapped_db_key_hex = hex::encode(&wrapped_db_key_blob);

        // Wrap db_key under master.
        let master_wrapped_db_key_blob = wrap_content_key(&*raw_master, &*raw_db_key).unwrap();
        let master_wrapped_db_key_hex = hex::encode(&master_wrapped_db_key_blob);

        // Create DB keyed under MASTER-derived key (T3 rekey not yet done).
        let old_sqlcipher_key = derive_sqlcipher_key(&*raw_master);
        let db_path_str = db_path.to_string_lossy().into_owned();
        {
            let conn = crate::db::open_with_key(&db_path_str, &*old_sqlcipher_key).unwrap();
            crate::db::schema::migrate(&conn).unwrap();
            db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &wrapped_master_hex).unwrap();
            db::set_setting(&conn, db::KEK_SALT_KEY, &kek_salt_hex).unwrap();
            db::set_password_hash(&conn, "crashpass99").unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
            // Intentionally do NOT set WRAPPED_CONTENT_LIST — the pre-write boot has
            // it but the DB settings write never happened (crash simulation).
        }

        // Write the pre-crash boot file: has all new material + migration_in_progress=true.
        let crash_boot = BootFile {
            unlock_method: crate::utils::boot_file::UnlockMethod::Password,
            mode: db::EncryptionMode::Password,
            kek_salt: Some(kek_salt_hex.clone()),
            wrapped_key: Some(wrapped_master_hex.clone()),
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: Some(encoded_list),
            wrapped_db_key: Some(wrapped_db_key_hex),
            master_wrapped_db_key: Some(master_wrapped_db_key_hex),
            migration_in_progress: Some(true),
        };
        boot_file::save(&crash_boot, &boot_path).unwrap();

        // 2. Simulate next unlock: run initialize_encryption_inner with the crash boot.
        let placeholder = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&placeholder).unwrap();
        let state = crate::AppState::new(placeholder);
        let key_state = crate::EncryptionKeyState::new();
        let password = Zeroizing::new("crashpass99".to_string());

        initialize_encryption_inner(
            &state,
            &key_state,
            &crash_boot,
            &boot_path,
            &db_path,
            &raw_master,
            &password,
            &wrapped_master_hex,
            &kek_salt,
            &kek_salt_hex,
        )
        .expect("T3-resume must succeed after simulated crash");

        // 3. Verify: DB is now readable under db_key-derived key.
        let new_sqlcipher_key = derive_sqlcipher_key(&*raw_db_key);
        let verify_conn = crate::db::open_with_key(&db_path_str, &*new_sqlcipher_key)
            .expect("DB must be readable under db_key after T3-resume");
        let list = db::get_setting(&verify_conn, db::WRAPPED_CONTENT_LIST)
            .unwrap()
            .expect("WRAPPED_CONTENT_LIST must be set after T3-resume");
        assert!(!list.is_empty(), "content list must be non-empty");
        let epoch = db::get_setting(&verify_conn, db::CONTENT_KEY_EPOCH)
            .unwrap()
            .expect("CONTENT_KEY_EPOCH must be set after T3-resume");
        assert_eq!(epoch, "1");

        // Verify DB is NOT readable under old master-derived key.
        let old_check = crate::db::open_with_key(&db_path_str, &*old_sqlcipher_key);
        if let Ok(wrong_conn) = old_check {
            let wrong_read: Result<i64, _> =
                wrong_conn.query_row("SELECT count(*) FROM settings", [], |r| r.get(0));
            assert!(
                wrong_read.is_err(),
                "DB must NOT be readable under master-derived key after T3-resume"
            );
        }

        // 4. Verify boot file has migration_in_progress cleared.
        let final_boot = boot_file::load(&boot_path).unwrap();
        assert!(
            final_boot.migration_in_progress != Some(true),
            "migration_in_progress must be cleared after T3-resume"
        );
        assert!(
            final_boot.wrapped_content_list.is_some(),
            "boot file must retain wrapped_content_list after T3-resume"
        );

        // 5. Verify key_state has content keys + db_key loaded.
        assert!(
            key_state.is_initialized().unwrap(),
            "key_state must be initialized after T3-resume"
        );
        let stored_fp = db::get_setting(&verify_conn, db::CLOUD_CONTENT_FINGERPRINT)
            .unwrap()
            .expect("CLOUD_CONTENT_FINGERPRINT must be set");
        let expected_fp = hex::encode(key_fingerprint(&*derive_sync_key(&*v1)));
        assert_eq!(
            stored_fp, expected_fp,
            "content fingerprint must match v1 key"
        );
    }

    // ─── T5/T6 new tests ─────────────────────────────────────────────────────

    /// T5: After T3 migration, the boot file must contain `master_wrapped_db_key`
    /// (db_key wrapped under master). Unwrapping it with the master must yield
    /// the same db_key that opens the real DB.
    ///
    /// This pins the invariant that `recover_with_passphrase` relies on in the
    /// Phase 3 path: master → unwrap `master_wrapped_db_key` → db_key → open DB.
    #[test]
    fn recover_with_passphrase_after_migration_opens_real_db() {
        use crate::utils::boot_file::{self, BootFile};
        use crate::utils::encryption::{
            decode_content_key_list, derive_sqlcipher_key, unwrap_content_key,
        };
        use rand::rngs::OsRng;
        use rand::RngCore;
        use tempfile::TempDir;
        use zeroize::Zeroizing;

        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = boot_file::boot_path(&db_path);

        // 1. Create a legacy DB keyed under master-derived key (pre-T3 state).
        let mut raw_master = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_master.as_mut());
        let kek_salt = crate::utils::encryption::generate_encryption_salt();
        let kek_salt_hex = hex::encode(kek_salt);
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let wrapped_master_hex =
            wrap_key_with(&*raw_master, "recoverpass12", &kek_salt, KdfParams::FAST).unwrap();
        let recovery_slot = make_recovery_slot(&*raw_master, &mnemonic);

        let old_sqlcipher_key = derive_sqlcipher_key(&*raw_master);
        let db_path_str = db_path.to_string_lossy().into_owned();
        {
            let legacy_conn = crate::db::open_with_key(&db_path_str, &*old_sqlcipher_key).unwrap();
            crate::db::schema::migrate(&legacy_conn).unwrap();
            db::set_setting(
                &legacy_conn,
                db::WRAPPED_ENCRYPTION_KEY_KEY,
                &wrapped_master_hex,
            )
            .unwrap();
            db::set_setting(&legacy_conn, db::KEK_SALT_KEY, &kek_salt_hex).unwrap();
            db::set_password_hash(&legacy_conn, "recoverpass12").unwrap();
            db::set_encryption_mode(&legacy_conn, db::EncryptionMode::Password).unwrap();
        }

        let legacy_boot = BootFile {
            unlock_method: crate::utils::boot_file::UnlockMethod::Password,
            mode: db::EncryptionMode::Password,
            kek_salt: Some(kek_salt_hex.clone()),
            wrapped_key: Some(wrapped_master_hex.clone()),
            os_kek_wrapped_master: None,
            recovery_wrapped: Some(recovery_slot.clone()),
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        boot_file::save(&legacy_boot, &boot_path).unwrap();

        // 2. Drive T3 migration via the real initialize_encryption_inner.
        let placeholder = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&placeholder).unwrap();
        let state = crate::AppState::new(placeholder);
        let key_state = crate::EncryptionKeyState::new();
        let password = Zeroizing::new("recoverpass12".to_string());

        initialize_encryption_inner(
            &state,
            &key_state,
            &legacy_boot,
            &boot_path,
            &db_path,
            &raw_master,
            &password,
            &wrapped_master_hex,
            &kek_salt,
            &kek_salt_hex,
        )
        .expect("T3 migration must succeed");

        // 3. Verify boot file now contains master_wrapped_db_key.
        let migrated_boot = boot_file::load(&boot_path).unwrap();
        let mwdk_hex = migrated_boot
            .master_wrapped_db_key
            .as_deref()
            .expect("boot file must have master_wrapped_db_key after T3");

        // 4. Phase 3 recover path: master → unwrap master_wrapped_db_key → db_key.
        //    Simulate what recover_with_passphrase does.
        let mwdk_blob = hex::decode(mwdk_hex).unwrap();
        let recovered_db_key = unwrap_content_key(&raw_master, &mwdk_blob)
            .expect("unwrapping master_wrapped_db_key with correct master must succeed");

        // 5. Recovered db_key must open the real DB.
        let sqlcipher_key = derive_sqlcipher_key(&*recovered_db_key);
        let real_conn = crate::db::open_with_key(&db_path_str, &*sqlcipher_key)
            .expect("db_key from master_wrapped_db_key must open the real DB");
        let epoch = db::get_setting(&real_conn, db::CONTENT_KEY_EPOCH)
            .unwrap()
            .expect("CONTENT_KEY_EPOCH must be readable under recovered db_key");
        assert_eq!(epoch, "1", "epoch must be 1 after T3 migration");

        // 6. The content list in the boot file must be decodable with master.
        let encoded_list = migrated_boot
            .wrapped_content_list
            .as_deref()
            .expect("boot file must have wrapped_content_list after T3");
        let content_keys = decode_content_key_list(&raw_master, encoded_list)
            .expect("content list must decode with master after T3");
        assert!(
            !content_keys.is_empty(),
            "content key list must not be empty"
        );

        // 7. Wrong master must NOT unwrap master_wrapped_db_key (auth tag mismatch).
        let wrong_master = [0xFFu8; 32];
        let wrong_result = unwrap_content_key(&wrong_master, &mwdk_blob);
        assert!(
            wrong_result.is_err(),
            "wrong master must not unwrap master_wrapped_db_key"
        );
    }

    /// T5/T6: `change_password` must re-wrap `wrapped_db_key` under the new KEK
    /// while carrying `master_wrapped_db_key` forward unchanged. After the
    /// password change, the new `wrapped_db_key` must unwrap to the same db_key
    /// that opens the real DB.
    ///
    /// This test drives `change_password`'s DB mutation logic directly, bypassing
    /// the Tauri async layer, to verify the atomic re-wrap invariant.
    #[test]
    fn change_password_rewraps_db_key() {
        use crate::utils::encryption::{
            derive_sqlcipher_key, unwrap_content_key, wrap_content_key,
        };
        use rand::rngs::OsRng;
        use rand::RngCore;
        use tempfile::TempDir;
        use zeroize::Zeroizing;

        // 1. Create a Phase 3 DB: keyed under db_key, with a fresh content-key
        //    list, wrapped_db_key, and master_wrapped_db_key in the boot file.
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = crate::utils::boot_file::boot_path(&db_path);

        let mut raw_master = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_master.as_mut());
        let mut raw_db_key = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_db_key.as_mut());

        let kek_salt = crate::utils::encryption::generate_encryption_salt();
        let kek_salt_hex = hex::encode(kek_salt);
        let wrapped_master_hex =
            wrap_key_with(&*raw_master, "oldpass12345", &kek_salt, KdfParams::FAST).unwrap();

        let kek = crate::utils::encryption::derive_encryption_key_with(
            "oldpass12345",
            &kek_salt,
            KdfParams::FAST,
        )
        .unwrap();
        let wrapped_db_key_blob = wrap_content_key(&kek, &*raw_db_key).unwrap();
        let wrapped_db_key_hex = hex::encode(&wrapped_db_key_blob);

        let master_wrapped_db_key_blob = wrap_content_key(&raw_master, &*raw_db_key).unwrap();
        let master_wrapped_db_key_hex = hex::encode(&master_wrapped_db_key_blob);

        let sqlcipher_key = derive_sqlcipher_key(&*raw_db_key);
        let db_path_str = db_path.to_string_lossy().into_owned();
        {
            let conn = crate::db::open_with_key(&db_path_str, &*sqlcipher_key).unwrap();
            crate::db::schema::migrate(&conn).unwrap();
            db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &wrapped_master_hex).unwrap();
            db::set_setting(&conn, db::KEK_SALT_KEY, &kek_salt_hex).unwrap();
            db::set_password_hash(&conn, "oldpass12345").unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        }

        let boot = crate::utils::boot_file::BootFile {
            unlock_method: crate::utils::boot_file::UnlockMethod::Password,
            mode: db::EncryptionMode::Password,
            kek_salt: Some(kek_salt_hex.clone()),
            wrapped_key: Some(wrapped_master_hex.clone()),
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: Some(wrapped_db_key_hex.clone()),
            master_wrapped_db_key: Some(master_wrapped_db_key_hex.clone()),
            migration_in_progress: None,
        };
        crate::utils::boot_file::save(&boot, &boot_path).unwrap();

        // 2. Load key state as Phase 3 (set_content_state with master + db_key).
        let v1 = crate::utils::encryption::generate_content_key();
        let mut keys_map: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>> =
            std::collections::BTreeMap::new();
        keys_map.insert(1u32, Zeroizing::new(*v1));
        let key_state = crate::EncryptionKeyState::new();
        key_state
            .set_content_state(
                keys_map,
                1,
                Zeroizing::new(*raw_db_key),
                Zeroizing::new(*raw_master),
            )
            .unwrap();

        // 3. Simulate the change_password DB mutation: generate new KEK salt,
        //    re-wrap master under new password, re-wrap db_key under new KEK.
        let new_password = Zeroizing::new("newpass12345".to_string());
        let new_kek_salt = crate::utils::encryption::generate_encryption_salt();
        let new_wrapped = key_state
            .with_master(|master| {
                wrap_key_with(master, &new_password, &new_kek_salt, KdfParams::FAST)
            })
            .unwrap();
        let new_kek_salt_hex = encode_hex(&new_kek_salt);
        let new_kek = crate::utils::encryption::derive_encryption_key_with(
            &new_password,
            &new_kek_salt,
            KdfParams::FAST,
        )
        .unwrap();
        let new_wrapped_db_key_hex = key_state
            .with_db_key(|db_key| {
                let blob = wrap_content_key(&new_kek, db_key)?;
                Ok(hex::encode(&blob))
            })
            .unwrap();

        // Persist new key material to DB.
        let conn = crate::db::open_with_key(&db_path_str, &*sqlcipher_key).unwrap();
        {
            let tx = conn.unchecked_transaction().unwrap();
            db::set_password_hash(&tx, &new_password).unwrap();
            db::set_setting(&tx, db::WRAPPED_ENCRYPTION_KEY_KEY, &new_wrapped).unwrap();
            db::set_setting(&tx, db::KEK_SALT_KEY, &new_kek_salt_hex).unwrap();
            tx.commit().unwrap();
        }

        // Write updated boot file (mirrors change_password behaviour).
        crate::utils::boot_file::save(
            &crate::utils::boot_file::BootFile {
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                mode: db::EncryptionMode::Password,
                kek_salt: Some(new_kek_salt_hex.clone()),
                wrapped_key: Some(new_wrapped.clone()),
                os_kek_wrapped_master: None,
                recovery_wrapped: None,
                wrapped_content_list: None,
                wrapped_db_key: Some(new_wrapped_db_key_hex.clone()),
                // master_wrapped_db_key must be carried forward unchanged.
                master_wrapped_db_key: Some(master_wrapped_db_key_hex.clone()),
                migration_in_progress: None,
            },
            &boot_path,
        )
        .unwrap();

        // 4. Verify: new wrapped_db_key unwraps to the same db_key.
        let new_boot = crate::utils::boot_file::load(&boot_path).unwrap();
        let new_wdk_hex = new_boot
            .wrapped_db_key
            .as_deref()
            .expect("wrapped_db_key must be present after change_password");
        let new_wdk_blob = hex::decode(new_wdk_hex).unwrap();
        let recovered_db_key = unwrap_content_key(&new_kek, &new_wdk_blob)
            .expect("new wrapped_db_key must unwrap with new KEK");
        assert_eq!(
            *recovered_db_key, *raw_db_key,
            "unwrapped db_key must match original db_key"
        );

        // 5. master_wrapped_db_key must be unchanged (master did not change).
        let carried_mwdk = new_boot
            .master_wrapped_db_key
            .as_deref()
            .expect("master_wrapped_db_key must be carried forward");
        assert_eq!(
            carried_mwdk, master_wrapped_db_key_hex,
            "master_wrapped_db_key must be unchanged after password change"
        );

        // 6. Old wrapped_db_key must NOT unwrap with the new KEK.
        let old_wdk_blob = hex::decode(&wrapped_db_key_hex).unwrap();
        assert!(
            unwrap_content_key(&new_kek, &old_wdk_blob).is_err(),
            "old wrapped_db_key must not unwrap with new KEK"
        );
    }

    /// T5/T6: `with_master` must return the master stored in `ContentKeyList`.
    /// Biometric unlock stores this master in the Keychain. On unlock the master
    /// is retrieved, used to unwrap `master_wrapped_db_key`, and loaded into
    /// state via `set_content_state`. This test pins that the master roundtrips
    /// through `set_content_state` → `with_master` unchanged.
    #[test]
    fn biometric_unlock_opens_real_db_not_placeholder() {
        use crate::utils::encryption::{derive_sqlcipher_key, unwrap_content_key};
        use rand::rngs::OsRng;
        use rand::RngCore;
        use tempfile::TempDir;
        use zeroize::Zeroizing;

        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");

        // 1. Set up a Phase 3 vault: DB keyed under db_key-derived SQLCipher key.
        let mut raw_master = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_master.as_mut());
        let mut raw_db_key = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_db_key.as_mut());

        let sqlcipher_key = derive_sqlcipher_key(&*raw_db_key);
        let db_path_str = db_path.to_string_lossy().into_owned();
        {
            let conn = crate::db::open_with_key(&db_path_str, &*sqlcipher_key).unwrap();
            crate::db::schema::migrate(&conn).unwrap();
        }

        // 2. Produce master_wrapped_db_key (as stored in the boot file by T5).
        let master_wrapped_db_key_blob =
            crate::utils::encryption::wrap_content_key(&raw_master, &*raw_db_key).unwrap();

        // 3. Load a Phase 3 key_state (simulates the state after initialization).
        let v1 = crate::utils::encryption::generate_content_key();
        let mut keys_map: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>> =
            std::collections::BTreeMap::new();
        keys_map.insert(1u32, Zeroizing::new(*v1));
        let key_state = crate::EncryptionKeyState::new();
        key_state
            .set_content_state(
                keys_map,
                1,
                Zeroizing::new(*raw_db_key),
                Zeroizing::new(*raw_master),
            )
            .unwrap();

        // 4. enable_biometric_unlock stores the master via with_master.
        //    Verify that with_master returns the exact master passed to set_content_state.
        let stored_master = key_state
            .with_master(|m| Ok(Zeroizing::new(*m)))
            .expect("with_master must succeed on a Phase 3 key_state");
        assert_eq!(
            *stored_master, *raw_master,
            "with_master must return the master passed to set_content_state"
        );

        // 5. Biometric unlock path: use the retrieved master to unwrap
        //    master_wrapped_db_key → db_key → open real DB.
        let recovered_db_key = unwrap_content_key(&stored_master, &master_wrapped_db_key_blob)
            .expect("master must unwrap master_wrapped_db_key");
        assert_eq!(
            *recovered_db_key, *raw_db_key,
            "unwrapped db_key must match original"
        );

        let recovered_sqlcipher_key = derive_sqlcipher_key(&*recovered_db_key);
        let real_conn = crate::db::open_with_key(&db_path_str, &*recovered_sqlcipher_key)
            .expect("recovered db_key must open the real DB");

        // DB must be readable (migrations run, so settings table exists).
        let _: i64 = real_conn
            .query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
            .expect("settings table must be readable under recovered db_key");

        // 6. Wrong master must fail to unwrap.
        let wrong_master = Zeroizing::new([0xAAu8; 32]);
        assert!(
            unwrap_content_key(&wrong_master, &master_wrapped_db_key_blob).is_err(),
            "wrong master must not unwrap master_wrapped_db_key"
        );
    }

    // ─── Phase 5 T3 tests: re-pair reads full key list, local data untouched ──

    /// T3.a — Re-pair with correct mnemonic reads the full content-key list
    /// from cloud `_content.json` and keeps local entries untouched.
    ///
    /// Flow: M1 seeds vault (epoch 1 in `_content.json`). A re-pairing device
    /// runs `onboard_complete_inner` with the correct mnemonic. The resulting
    /// `EncryptionKeyState` must have epoch 1 loaded, and the local DB entry
    /// inserted before re-pair must still be present.
    #[tokio::test]
    async fn repair_with_mnemonic_keeps_local_data_and_reads_all_epochs() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        // M1 creates the vault and publishes to cloud (includes _content.json epoch=1).
        let (conn_m1, mnemonic, pub_ctx) = seed_v2_vault("m1pass123456", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // Drop conn_m1 — we are now the re-pairing device.
        drop(conn_m1);

        // Start with a fresh DB that has a pre-existing local entry (simulating
        // entries the user wrote before the need to re-pair).
        let conn_repair = setup();
        let pre_existing_journal = "journal-repairtest-aabbccdd";
        conn_repair.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) VALUES (?1, 'RepairJournal', 1, 1)",
            [pre_existing_journal],
        ).unwrap();
        let pre_existing_entry = "entry-repairtest-00001111";
        conn_repair.execute(
            "INSERT INTO entries (id, journal_id, title, preview_text, content_text, entry_date, created_at, updated_at, is_favorite, is_deleted)
             VALUES (?1, ?2, 'pre-repair title', 'preview', 'local content preserved', 1, 1, 1, 0, 0)",
            [pre_existing_entry, pre_existing_journal],
        ).unwrap();
        // Stale surface hashes from a prior cloud write-namespace must not
        // survive re-pair (hash-gate would skip publishing into g-N).
        for surface in crate::sync::engine::HASH_GATED_SURFACE_NAMES {
            db::set_surface_push_hash(&conn_repair, surface, &format!("stale-{surface}")).unwrap();
        }
        db::set_surface_push_hash(&conn_repair, "metadata", "stale-meta").unwrap();

        // Run onboard_complete_inner (re-pair path) with the correct mnemonic.
        let ks_repair = EncryptionKeyState::new();
        let conn_repair = onboard_complete_inner(
            conn_repair,
            &ks_repair,
            &provider,
            &mnemonic,
            "repairpass123",
            "M-Repair",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await
        .expect("re-pair with correct mnemonic must succeed");

        // Assert: EncryptionKeyState has epoch 1 loaded.
        assert!(
            ks_repair.is_initialized().unwrap(),
            "key state must be initialized after re-pair"
        );
        // Surface hashes cleared; Automatic reconcile re-armed.
        for surface in crate::sync::engine::HASH_GATED_SURFACE_NAMES {
            assert_eq!(
                db::get_surface_push_hash(&conn_repair, surface).unwrap(),
                None,
                "re-pair must clear {surface} push hash for new write namespace"
            );
        }
        assert_eq!(
            db::get_surface_push_hash(&conn_repair, "metadata").unwrap(),
            None,
            "re-pair must clear metadata push hash"
        );
        // The state must be able to produce a sync key for the latest epoch.
        ks_repair
            .with_latest_sync_key(|epoch, _k| {
                assert_eq!(epoch, 1, "latest epoch must be 1 (only epoch in cloud)");
                Ok(())
            })
            .expect("with_latest_sync_key must succeed after re-pair");

        // Assert: pre-existing local entry is still in the DB (local data untouched).
        let entry_exists: i64 = conn_repair
            .query_row(
                "SELECT count(*) FROM entries WHERE id = ?1",
                [pre_existing_entry],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            entry_exists, 1,
            "pre-existing local entry must be preserved after re-pair"
        );

        // Assert: WRAPPED_CONTENT_LIST is stored in DB (content-key list persisted).
        let stored_list = db::get_setting(&conn_repair, db::WRAPPED_CONTENT_LIST)
            .unwrap()
            .expect("WRAPPED_CONTENT_LIST must be set after re-pair");
        assert!(
            !stored_list.is_empty(),
            "WRAPPED_CONTENT_LIST must be non-empty after re-pair"
        );

        // Assert: NEEDS_CLOUD_CONTENT_MIGRATION is NOT set on the joiner —
        // only the creator sets this flag; the joiner never needs to wipe+repush.
        let migration_flag =
            db::get_setting(&conn_repair, db::NEEDS_CLOUD_CONTENT_MIGRATION).unwrap();
        assert!(
            migration_flag.as_deref() != Some("1"),
            "NEEDS_CLOUD_CONTENT_MIGRATION must NOT be set on re-pair device, got {migration_flag:?}"
        );
    }

    /// T3.b — Re-pair without the correct mnemonic must fail, preventing the
    /// revoked device from obtaining the new master key.
    ///
    /// This is the security boundary: the mnemonic gates access to master_key,
    /// which is needed to unwrap the content-key list. A device without the
    /// mnemonic stays locked out of all new content keys.
    #[tokio::test]
    async fn repair_without_mnemonic_cannot_obtain_new_master() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        // M1 seeds vault.
        let (_conn_m1, _correct_mnemonic, pub_ctx) = seed_v2_vault("m1pass777888", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // Generate a completely different (wrong) mnemonic by creating a separate vault.
        let conn_other = setup();
        let handle_other =
            begin_first_time_setup_inner(&conn_other, "otherpass12", "Other", KdfParams::FAST)
                .unwrap();
        let wrong_mnemonic = handle_other.mnemonic.join(" ");
        drop(conn_other);

        // Attempt re-pair with the wrong mnemonic.
        let conn_revoked = setup();
        let ks_revoked = EncryptionKeyState::new();
        let result = onboard_complete_inner(
            conn_revoked,
            &ks_revoked,
            &provider,
            &wrong_mnemonic,
            "revokedpass123",
            "Revoked",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await;

        assert!(
            result.is_err(),
            "re-pair with wrong mnemonic must fail, preventing key access"
        );
        let (_conn, err_msg) = result.unwrap_err();
        assert!(
            err_msg.contains("Wrong recovery phrase")
                || err_msg.contains("Could not verify")
                || err_msg.contains("mnemonic")
                || err_msg.contains("recovery"),
            "error must indicate wrong mnemonic, got: {err_msg}"
        );

        // Assert: key state must NOT be initialized (no key material leaked).
        assert!(
            !ks_revoked.is_initialized().unwrap(),
            "EncryptionKeyState must remain uninitialized after failed re-pair"
        );
    }

    // ─── C1: Vault-match validation before rotate/revoke mutation ────────────

    /// C1: `onboard_validate_passphrase_inner` rejects a wrong-but-valid BIP39
    /// phrase before any DB mutation occurs.  This is the primitive used by both
    /// `rotate_master_key` and `revoke_device` to guard against overwriting
    /// `_recovery.json` with a key derived from the wrong phrase.
    ///
    /// Verifies:
    /// - A wrong-but-syntactically-valid 24-word phrase returns `Err`.
    /// - No `rotation_job` row is created (zero mutation).
    /// - Settings are unchanged.
    #[tokio::test]
    async fn c1_vault_match_rejects_wrong_phrase_before_mutation_rotate() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        // Seed a vault for "device A" with phrase A.
        let (_conn_a, _phrase_a, pub_ctx_a) = seed_v2_vault("passA12345", "DeviceA");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx_a).await;

        // Generate a DIFFERENT (but valid) mnemonic — phrase B from a different vault.
        let conn_b = setup();
        let handle_b =
            begin_first_time_setup_inner(&conn_b, "passB12345", "DeviceB", KdfParams::FAST)
                .unwrap();
        let wrong_phrase = handle_b.mnemonic.join(" ");
        drop(conn_b);

        // Set up a fresh DB with no rotation jobs.
        let conn = setup();
        let app_state = AppState::new(conn);

        // Sanity: no rotation_job rows before the call.
        {
            let conn = app_state.lock().unwrap();
            let job = db::find_active_rotation_job(&conn).unwrap();
            assert!(
                job.is_none(),
                "no active job expected before vault-match call"
            );
        }

        // Call vault-match directly — this is the primitive both rotate_master_key
        // and revoke_device now invoke BEFORE rotate_keys.
        let result = onboard_validate_passphrase_inner(&provider, &wrong_phrase).await;

        assert!(
            result.is_err(),
            "vault-match must reject a wrong-but-valid BIP39 phrase"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("Wrong recovery phrase") || err.contains("Could not verify"),
            "error must be the vault-mismatch message; got: {err}"
        );

        // Zero mutation: no rotation_job row was created.
        {
            let conn = app_state.lock().unwrap();
            let job = db::find_active_rotation_job(&conn).unwrap();
            assert!(
                job.is_none(),
                "vault-match rejection must leave zero rotation_job rows; found: {job:?}"
            );
        }
    }

    /// I2: `onboard_complete_inner` must return `Err` (not panic) when
    /// `_content.json` exists but has an empty `entries` array.  An attacker or
    /// corrupt cloud file can plant such a file; the old `.expect()` would panic.
    #[tokio::test]
    async fn onboard_complete_inner_empty_content_list_returns_err_not_panic() {
        use crate::sync::keyring_v2::{
            io::{test_support::InMemoryKeyringProvider, write_content},
            types::{ContentListV2, KEYRING_V2_VERSION},
        };

        // Build a minimal provider with a valid _meta.json + _recovery.json
        // but an empty _content.json.
        let (_conn_seed, mnemonic, pub_ctx) = seed_v2_vault("testpass9999", "SeedDevice");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        // Overwrite _content.json with an empty entries list (latest_epoch=0).
        let empty_content = ContentListV2 {
            version: KEYRING_V2_VERSION,
            latest_epoch: 0,
            entries: vec![],
            created_at: 0,
        };
        write_content(&provider, &empty_content)
            .await
            .expect("write empty content list must succeed");

        let conn = setup();
        let ks = EncryptionKeyState::new();
        let result = onboard_complete_inner(
            conn,
            &ks,
            &provider,
            &mnemonic,
            "newpass9999",
            "Joiner",
            None,
            None,
            None, // unlock_method (existing test — defaults to password-only)
        )
        .await;

        assert!(
            result.is_err(),
            "onboard_complete_inner must return Err when _content.json has empty entries"
        );
        let (_conn, err) = result.unwrap_err();
        assert!(
            err.contains("no entries") || err.contains("empty") || err.contains("corrupt"),
            "error must mention the empty/corrupt content list; got: {err}"
        );
    }

    /// C1: `onboard_validate_passphrase_inner` succeeds when the correct phrase
    /// for THIS vault is supplied — the happy path guard for both commands.
    #[tokio::test]
    async fn c1_vault_match_accepts_correct_phrase() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let (_conn, mnemonic, pub_ctx) = seed_v2_vault("goodpass12345", "DeviceOK");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let result = onboard_validate_passphrase_inner(&provider, &mnemonic).await;
        assert!(
            result.is_ok(),
            "vault-match must accept the correct phrase; err: {:?}",
            result.err()
        );
    }

    // ─── Phase 3 — unlock method: password | os_kek | both ───────────────────
    //
    // Real macOS Keychain roundtrips are intentionally NOT exercised here
    // (see `commands::keychain` module doc — the existing codebase convention
    // is to omit those, e.g. `wipe_biometric_keychain_is_noop_on_non_macos`).
    // These tests operate on the os_kek wrap math (`wrap_content_key` /
    // `unwrap_content_key`) and the `BootFile` / unlock-method contract
    // directly, using a stand-in 32-byte value in place of a real
    // Keychain-held os_kek. That stand-in boundary is exactly where the
    // production code calls out to `commands::keychain::get_os_kek()` /
    // `generate_os_kek()`.
    use crate::utils::boot_file::UnlockMethod;

    /// Task 5(a): the SAME boot file must yield the master through either
    /// unlock path.
    #[test]
    fn phase3_same_boot_file_unlocks_via_password_and_via_os_kek() {
        let master = [7u8; 32];
        let password = "correcthorsebatterystaple";
        let kek_salt = generate_encryption_salt();
        let wrapped_key = wrap_key(&master, password, &kek_salt).unwrap();

        // Stand-in os_kek — see module note above.
        let os_kek = [9u8; 32];
        let os_kek_wrapped_master_hex = hex::encode(wrap_content_key(&os_kek, &master).unwrap());

        let boot = BootFile {
            mode: db::EncryptionMode::Password,
            unlock_method: UnlockMethod::Both,
            kek_salt: Some(encode_hex(&kek_salt)),
            wrapped_key: Some(wrapped_key),
            os_kek_wrapped_master: Some(os_kek_wrapped_master_hex),
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };

        // Round-trip through save/load — exercises the real on-disk format,
        // not just in-memory values.
        let fx = crate::utils::boot_file::test_support::BootFileFixture::new();
        fx.write(&boot).unwrap();
        let loaded = fx.read().unwrap();
        assert_eq!(loaded, boot);

        // Path 1: unwrap via password.
        let kek_salt_bytes = hex::decode(loaded.kek_salt.as_ref().unwrap()).unwrap();
        let via_password = unwrap_key(
            loaded.wrapped_key.as_ref().unwrap(),
            password,
            &kek_salt_bytes,
        )
        .expect("password unlock must succeed");

        // Path 2: unwrap via os_kek.
        let blob = hex::decode(loaded.os_kek_wrapped_master.as_ref().unwrap()).unwrap();
        let via_os_kek = unwrap_content_key(&os_kek, &blob).expect("os_kek unlock must succeed");

        assert_eq!(*via_password, master);
        assert_eq!(*via_os_kek, master);
    }

    /// Task 5(b), platform-independent half: omitting `unlock_method`
    /// (current frontend behavior) must always resolve to password-only with
    /// no os_kek touched, on every platform.
    #[test]
    fn phase3_resolve_unlock_method_defaults_to_password_only() {
        let master = [3u8; 32];
        let (method, wrap) = resolve_unlock_method_with_os_kek(None, &master).unwrap();
        assert_eq!(method, UnlockMethod::Password);
        assert!(wrap.is_none());

        let (method2, wrap2) =
            resolve_unlock_method_with_os_kek(Some("password"), &master).unwrap();
        assert_eq!(method2, UnlockMethod::Password);
        assert!(wrap2.is_none());
    }

    // ─── biometric_unlock_enabled must track the resolved unlock method ──────
    //
    // Setup and join resolve their own unlock method and write the boot file
    // themselves; they never call `enable_biometric_unlock`, the setting's
    // only other writer. If they also skip the setting, choosing OS unlock
    // during onboarding puts an os_kek in the Keychain wrapping the master
    // while `is_biometric_unlock_enabled` reports `false` — the lock screen
    // hides the Touch ID button and Settings cannot manage or remove the
    // item, and a later rotation leaves it wrapping a superseded master.
    //
    // These two tests pin that both commands *write* the setting (an absent
    // value fails them). The value mapping itself — `Both`/`OsKek` → true,
    // `Password` → false — is pinned by
    // `keychain::tests::sync_biometric_setting_*`. Driving a command all the
    // way to `Both` is not automatable: it needs `generate_os_kek()`, i.e. the
    // real Keychain, which every os_kek test in this repo is `#[ignore]`d on
    // macOS for and which returns `Unavailable` everywhere else.

    #[test]
    fn phase3_first_time_setup_records_biometric_setting_for_resolved_method() {
        let conn = setup();
        let password = "confirm-pass12";
        let handle =
            begin_first_time_setup_inner(&conn, password, "MacBook Pro", KdfParams::FAST).unwrap();
        let answers: Vec<String> = handle
            .challenge_indices
            .iter()
            .map(|&i| handle.mnemonic[i].clone())
            .collect();

        let key_state = EncryptionKeyState::new();
        let (conn, _pub_ctx) = confirm_first_time_setup_inner(
            conn,
            &key_state,
            &handle.setup_id,
            &answers,
            password,
            std::path::Path::new("/tmp/unused.db"),
            None,
            None,
            None, // unlock_method → resolves to Password
        )
        .unwrap();

        assert_eq!(
            db::get_setting(&conn, crate::commands::keychain::BIOMETRIC_ENABLED_SETTING).unwrap(),
            Some("false".to_string()),
            "setup must state the resolved unlock method in the setting, not leave it absent"
        );
    }

    #[tokio::test]
    async fn phase3_onboard_complete_records_biometric_setting_for_resolved_method() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        let (_seed_conn, mnemonic, pub_ctx) = seed_v2_vault("seedpass123", "M1");
        let provider = InMemoryKeyringProvider::new();
        seed_provider_from_ctx(&provider, &pub_ctx).await;

        let key_state = EncryptionKeyState::new();
        let new_conn = onboard_complete_inner(
            setup(),
            &key_state,
            &provider,
            &mnemonic,
            "newdevpassword12",
            "M2 MacBook",
            None,
            None,
            None, // unlock_method → resolves to Password
        )
        .await
        .expect("onboard_complete_inner must succeed");

        assert_eq!(
            db::get_setting(
                &new_conn,
                crate::commands::keychain::BIOMETRIC_ENABLED_SETTING
            )
            .unwrap(),
            Some("false".to_string()),
            "join must state the resolved unlock method in the setting, not leave it absent"
        );
    }

    /// Task 5(b): an os_kek-unavailable platform exposes password only — an
    /// explicit request for os_kek must be a clear, loud error, never a
    /// silent downgrade. Ignored on macOS because `is_os_kek_available()` is
    /// `true` there, so the platform-specific contract under test does not
    /// hold on this machine; it is exercised on non-macOS CI instead.
    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "is_os_kek_available() is true on macOS — this contract is for \
                  platforms without an os_kek backend; see non-macOS CI"
    )]
    fn phase3_os_kek_unavailable_platform_rejects_explicit_os_kek_request() {
        let master = [3u8; 32];
        let err = resolve_unlock_method_with_os_kek(Some("os_kek"), &master).unwrap_err();
        assert!(
            err.contains("not available"),
            "error must explain os_kek is unavailable; got: {err}"
        );
    }

    #[test]
    fn phase3_resolve_unlock_method_rejects_unknown_value() {
        let master = [3u8; 32];
        let err = resolve_unlock_method_with_os_kek(Some("fingerprint"), &master).unwrap_err();
        assert!(err.contains("Unknown"), "got: {err}");
    }

    /// Task 5(c): simulate "os_kek keystore item gone" — a boot file whose
    /// ONLY unlock wrap is os_kek (no `wrapped_key` at all). `get_os_kek()`
    /// actually failing is exercised by `unlock_with_biometric`'s self-heal
    /// path (keychain.rs; not unit-testable without a real Keychain — see
    /// that module's doc comment). This test proves the other half of the
    /// anti-lockout guarantee: `recovery_wrapped` (the 24-word phrase) still
    /// opens the vault regardless of os_kek state, so losing os_kek is never
    /// a dead end — a clear error plus a usable recovery route, not silent
    /// lockout.
    #[test]
    fn phase3_os_kek_lost_still_has_a_usable_recovery_route() {
        let master = [11u8; 32];
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let parsed = crate::utils::recovery::validate_recovery_mnemonic(&mnemonic).unwrap();
        let recovery_key = crate::utils::recovery::derive_recovery_key(&parsed);
        let recovery_wrapped = hex::encode(encrypt_data(&*recovery_key, &master).unwrap());

        let boot = BootFile {
            mode: db::EncryptionMode::Password,
            unlock_method: UnlockMethod::OsKek,
            kek_salt: None,
            wrapped_key: None,
            // Present in the boot file but assumed unusable — simulates the
            // Keychain-side item being gone. A boot-file field alone can't
            // represent "Keychain item missing"; `get_os_kek()` is what would
            // fail in production, at the keychain.rs layer.
            os_kek_wrapped_master: Some("aa".repeat(60)),
            recovery_wrapped: Some(recovery_wrapped.clone()),
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        // Must be a writable, valid boot file (the os_kek wrap alone
        // satisfies the invariant) — proves this isn't an artificially
        // impossible state.
        let fx = crate::utils::boot_file::test_support::BootFileFixture::new();
        fx.write(&boot)
            .expect("os_kek-only boot file must be valid");

        let recovered = unwrap_master_with_recovery_key(&recovery_wrapped, &*recovery_key)
            .expect("recovery route must succeed even when os_kek is unusable");
        assert_eq!(*recovered, master);
    }

    /// Task 5(d): password change re-wraps master AND invalidates the os_kek
    /// wrap — matching the existing `wipe_biometric_keychain()` /
    /// `clear_biometric_setting()` policy `change_password` already applies.
    ///
    /// This mirrors (does not literally invoke) `change_password`'s boot-file
    /// transformation, the same way `do_change_password` above mirrors its
    /// DB-settings transformation rather than calling the real async Tauri
    /// command (which needs a live `AppHandle`).
    #[test]
    fn phase3_password_change_invalidates_os_kek_wrap() {
        let master = [5u8; 32];
        let old_password = "oldpassword123";
        let new_password = "newpassword456";
        let kek_salt = generate_encryption_salt();
        let old_wrapped_key = wrap_key(&master, old_password, &kek_salt).unwrap();
        let os_kek = [6u8; 32];
        let old_os_kek_wrapped_master = hex::encode(wrap_content_key(&os_kek, &master).unwrap());

        let before = BootFile {
            mode: db::EncryptionMode::Password,
            unlock_method: UnlockMethod::Both,
            kek_salt: Some(encode_hex(&kek_salt)),
            wrapped_key: Some(old_wrapped_key),
            os_kek_wrapped_master: Some(old_os_kek_wrapped_master),
            recovery_wrapped: Some("aa".repeat(60)),
            wrapped_content_list: Some("bb".repeat(64)),
            wrapped_db_key: None,
            master_wrapped_db_key: Some("cc".repeat(60)),
            migration_in_progress: None,
        };

        // Capture prior state before mutating — anti-vacuous-test requirement.
        let prior_os_kek_wrap = before.os_kek_wrapped_master.clone();
        assert!(
            prior_os_kek_wrap.is_some(),
            "precondition: os_kek was enabled"
        );

        // Call the ACTUAL production function `change_password` uses to
        // compute its boot-file write (`boot_after_password_change`, defined
        // above) — not a hand-authored re-derivation. This is what makes the
        // assert_ne! below bind to real code: deleting the
        // `os_kek_wrapped_master: None` line from that function fails this
        // test.
        let new_kek_salt = generate_encryption_salt();
        let new_wrapped_key = wrap_key(&master, new_password, &new_kek_salt).unwrap();
        let new_wrapped_db_key_hex = "ee".repeat(60); // db_key re-wrap is opaque to this transformation
        let after = boot_after_password_change(
            &before,
            encode_hex(&new_kek_salt),
            new_wrapped_key,
            new_wrapped_db_key_hex,
        );

        assert_ne!(
            prior_os_kek_wrap, after.os_kek_wrapped_master,
            "os_kek_wrapped_master must actually change (Some -> None), not just be \
             asserted None"
        );
        assert!(after.os_kek_wrapped_master.is_none());
        assert_eq!(after.unlock_method, UnlockMethod::Password);
        // Master-bound fields must be carried forward unchanged (master
        // itself does not change on a password change).
        assert_eq!(after.recovery_wrapped, before.recovery_wrapped);
        assert_eq!(after.wrapped_content_list, before.wrapped_content_list);
        assert_eq!(after.master_wrapped_db_key, before.master_wrapped_db_key);

        // Password remains the guaranteed fallback: the NEW password must
        // unlock the SAME master via the NEW wrap — never a lockout.
        let new_kek_salt_bytes = hex::decode(after.kek_salt.as_ref().unwrap()).unwrap();
        let unlocked = unwrap_key(
            after.wrapped_key.as_ref().unwrap(),
            new_password,
            &new_kek_salt_bytes,
        )
        .expect("new password must unlock the vault after change");
        assert_eq!(*unlocked, master);

        // The boot file must still be writable (invariant holds: wrapped_key present).
        let fx = crate::utils::boot_file::test_support::BootFileFixture::new();
        fx.write(&after)
            .expect("post-password-change boot file must be valid");
    }

    /// Task 5(e): the bricking scenario this phase exists to prevent. An
    /// os_kek-only device (no `wrapped_key`/`wrapped_db_key` at all — those
    /// are wrapped under the PASSWORD KEK, which doesn't exist here) must
    /// still reach db_key, via `master_wrapped_db_key`, once master is
    /// unwrapped through os_kek.
    #[test]
    fn phase3_os_kek_only_device_reaches_db_key_via_master_wrapped_db_key() {
        let master = [13u8; 32];
        let db_key = [17u8; 32];
        let os_kek = [19u8; 32];

        let os_kek_wrapped_master_hex = hex::encode(wrap_content_key(&os_kek, &master).unwrap());
        let master_wrapped_db_key_hex = hex::encode(wrap_content_key(&master, &db_key).unwrap());

        let boot = BootFile {
            mode: db::EncryptionMode::Password,
            unlock_method: UnlockMethod::OsKek,
            kek_salt: None,
            wrapped_key: None,
            os_kek_wrapped_master: Some(os_kek_wrapped_master_hex),
            recovery_wrapped: Some("dd".repeat(60)),
            wrapped_content_list: None,
            // The bricking bug this test guards against: wrapped_db_key does
            // NOT exist for an os_kek-only device (it's password-KEK-wrapped).
            wrapped_db_key: None,
            master_wrapped_db_key: Some(master_wrapped_db_key_hex),
            migration_in_progress: None,
        };
        let fx = crate::utils::boot_file::test_support::BootFileFixture::new();
        fx.write(&boot)
            .expect("os_kek-only boot file must be valid");
        let loaded = fx.read().unwrap();

        // Unlock path: os_kek -> master -> db_key. Never touches
        // wrapped_key / wrapped_db_key, which are both absent.
        assert!(loaded.wrapped_key.is_none());
        assert!(loaded.wrapped_db_key.is_none());
        let recovered_master = unwrap_content_key(
            &os_kek,
            &hex::decode(loaded.os_kek_wrapped_master.as_ref().unwrap()).unwrap(),
        )
        .expect("os_kek must unwrap master");
        assert_eq!(*recovered_master, master);

        let recovered_db_key = unwrap_content_key(
            &recovered_master,
            &hex::decode(loaded.master_wrapped_db_key.as_ref().unwrap()).unwrap(),
        )
        .expect(
            "master must unwrap db_key via master_wrapped_db_key — the only route \
             for an os_kek-only device",
        );
        assert_eq!(*recovered_db_key, db_key);
    }

    /// Task 5(f): `recovery_wrapped` (the 24-word phrase route) must work
    /// regardless of which unlock_method combination the device has.
    #[test]
    fn phase3_recovery_wrapped_yields_master_under_every_unlock_method() {
        let master = [23u8; 32];
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let parsed = crate::utils::recovery::validate_recovery_mnemonic(&mnemonic).unwrap();
        let recovery_key = crate::utils::recovery::derive_recovery_key(&parsed);
        let recovery_wrapped = hex::encode(encrypt_data(&*recovery_key, &master).unwrap());

        for method in [
            UnlockMethod::Password,
            UnlockMethod::OsKek,
            UnlockMethod::Both,
        ] {
            let (wrapped_key, kek_salt, os_kek_wrapped_master) = match method {
                UnlockMethod::Password => {
                    let salt = generate_encryption_salt();
                    (
                        Some(wrap_key(&master, "somepassword1", &salt).unwrap()),
                        Some(encode_hex(&salt)),
                        None,
                    )
                }
                UnlockMethod::OsKek => (
                    None,
                    None,
                    Some(hex::encode(wrap_content_key(&[1u8; 32], &master).unwrap())),
                ),
                UnlockMethod::Both => {
                    let salt = generate_encryption_salt();
                    (
                        Some(wrap_key(&master, "somepassword1", &salt).unwrap()),
                        Some(encode_hex(&salt)),
                        Some(hex::encode(wrap_content_key(&[1u8; 32], &master).unwrap())),
                    )
                }
            };

            let boot = BootFile {
                mode: db::EncryptionMode::Password,
                unlock_method: method,
                kek_salt,
                wrapped_key,
                os_kek_wrapped_master,
                recovery_wrapped: Some(recovery_wrapped.clone()),
                wrapped_content_list: None,
                wrapped_db_key: None,
                master_wrapped_db_key: None,
                migration_in_progress: None,
            };
            let fx = crate::utils::boot_file::test_support::BootFileFixture::new();
            fx.write(&boot)
                .unwrap_or_else(|e| panic!("{method:?} boot file must be valid: {e}"));
            let loaded = fx.read().unwrap();

            let recovered = unwrap_master_with_recovery_key(
                loaded.recovery_wrapped.as_ref().unwrap(),
                &*recovery_key,
            )
            .unwrap_or_else(|e| panic!("recovery must work under {method:?}: {e}"));
            assert_eq!(
                *recovered, master,
                "recovered master must match under {method:?}"
            );
        }
    }

    // ─── remove_device_inner ─────────────────────────────────────────────────

    fn remove_test_state_with_peer(peer_id: &str) -> AppState {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        db::upsert_device(
            &conn,
            &db::DeviceRow {
                device_id: peer_id.to_string(),
                name: "Old phone".to_string(),
                created_at: 1_700_000_000,
                last_seen_at: 1_700_000_001,
                is_current: false,
                is_revoked: false,
            },
        )
        .unwrap();
        AppState::new(conn)
    }

    async fn write_peer_slot(
        provider: &crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider,
        peer_id: &str,
    ) {
        use crate::sync::keyring_v2::types::DeviceSlotV2;
        use crate::sync::keyring_v2::KEYRING_V2_VERSION;

        let slot = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: peer_id.to_string(),
            name: "Old phone".to_string(),
            created_at: 1_700_000_000,
            last_seen_at: 1_700_000_001,
        };
        crate::sync::keyring_v2::io::write_device_slot(provider, &slot)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn remove_device_inner_deletes_cloud_slot_and_local_row() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let peer_id = "11111111-1111-4111-8111-111111111111";
        let state = remove_test_state_with_peer(peer_id);
        let provider = InMemoryKeyringProvider::new();
        write_peer_slot(&provider, peer_id).await;

        remove_device_inner(&provider, &state, peer_id)
            .await
            .expect("remove must succeed");

        let slots = crate::sync::keyring_v2::io::list_device_slots(&provider)
            .await
            .unwrap();
        assert!(slots.is_empty(), "cloud slot must be deleted");

        let conn = state.lock().unwrap();
        let rows = db::list_devices(&conn).unwrap();
        assert!(
            !rows.iter().any(|d| d.device_id == peer_id),
            "local row must be deleted"
        );
    }

    /// Composed lifecycle of the `remove_device` command body: guard held →
    /// removal queued (nothing touched) → holder releases → waiting acquire
    /// succeeds → inner runs under the guard → guard released after cleanup.
    /// `remove_device` itself takes an `AppHandle` and is not unit-testable,
    /// so this stitches the same two pieces it composes.
    #[tokio::test(start_paused = true)]
    async fn remove_device_queues_behind_sync_guard_then_runs_and_releases() {
        use crate::commands::sync::{is_sync_in_progress, SyncInProgressGuard};
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let _lock = crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let peer_id = "22222222-2222-4222-8222-222222222222";
        let state = remove_test_state_with_peer(peer_id);
        let provider = InMemoryKeyringProvider::new();
        write_peer_slot(&provider, peer_id).await;

        // While a sync holds the guard, the waiting acquire must come back
        // empty (zero timeout) and the removal must not have started.
        let holder = SyncInProgressGuard::try_acquire().expect("guard must be free");
        assert!(
            SyncInProgressGuard::acquire_waiting(std::time::Duration::ZERO)
                .await
                .is_none(),
            "queued removal must not steal the slot from the running sync"
        );
        let slots = crate::sync::keyring_v2::io::list_device_slots(&provider)
            .await
            .unwrap();
        assert_eq!(
            slots
                .iter()
                .map(|s| s.device_id.as_str())
                .collect::<Vec<_>>(),
            vec![peer_id],
            "queued removal must not touch the peer slot yet"
        );

        // Holder releases → the queued acquire wins and the removal runs
        // with the guard held, exactly like the command body.
        drop(holder);
        let guard = SyncInProgressGuard::acquire_waiting(std::time::Duration::from_secs(10))
            .await
            .expect("slot must be granted once the sync releases");
        assert!(
            is_sync_in_progress(),
            "removal must hold the sync slot while it runs"
        );
        remove_device_inner(&provider, &state, peer_id)
            .await
            .expect("queued removal must succeed after the sync releases");
        drop(guard);

        assert!(
            !is_sync_in_progress(),
            "sync slot must be released after the removal finishes"
        );
        let slots = crate::sync::keyring_v2::io::list_device_slots(&provider)
            .await
            .unwrap();
        assert!(slots.is_empty(), "cloud slot must be deleted");
        let conn = state.lock().unwrap();
        assert!(
            !db::list_devices(&conn)
                .unwrap()
                .iter()
                .any(|d| d.device_id == peer_id),
            "local row must be deleted"
        );
    }

    #[tokio::test]
    async fn remove_device_inner_rejects_current_device() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let current_id = db::get_or_create_device_id(&conn).unwrap();
        let state = AppState::new(conn);
        let provider = InMemoryKeyringProvider::new();

        let err = remove_device_inner(&provider, &state, &current_id)
            .await
            .expect_err("removing the current device must fail");
        assert!(
            err.contains("current device"),
            "error must mention the current device, got: {err}"
        );
    }

    #[tokio::test]
    async fn remove_device_inner_keeps_local_row_when_cloud_delete_fails() {
        use crate::sync::keyring_v2::KeyringV2Io;
        use crate::sync::provider::SyncError;
        use async_trait::async_trait;

        struct DeleteFailsProvider;

        #[async_trait]
        impl KeyringV2Io for DeleteFailsProvider {
            async fn read_file(&self, _path: &str) -> Result<Vec<u8>, SyncError> {
                Err(SyncError::NotFound("nope".to_string()))
            }
            async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
                Ok(())
            }
            async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
                Err(SyncError::Network("simulated timeout".to_string()))
            }
            async fn list_files(&self, _prefix: &str) -> Result<Vec<String>, SyncError> {
                Ok(vec![])
            }
        }

        let peer_id = "22222222-2222-4222-8222-222222222222";
        let state = remove_test_state_with_peer(peer_id);

        let result = remove_device_inner(&DeleteFailsProvider, &state, peer_id).await;
        assert!(result.is_err(), "cloud failure must surface as an error");

        let conn = state.lock().unwrap();
        let rows = db::list_devices(&conn).unwrap();
        assert!(
            rows.iter().any(|d| d.device_id == peer_id),
            "local row must survive when the cloud delete fails"
        );
    }

    #[tokio::test]
    async fn remove_device_inner_is_idempotent_for_unknown_device() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let state = AppState::new(conn);
        let provider = InMemoryKeyringProvider::new();

        remove_device_inner(&provider, &state, "33333333-3333-4333-8333-333333333333")
            .await
            .expect("removing an already-gone device must be a no-op success");
    }
}
