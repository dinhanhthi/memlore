/// Database conversion helpers — rekey a plain SQLite DB to encrypted SQLCipher.
///
/// `convert_to_password` (and its recovery-aware variant) implement the
/// load-bearing file-swap primitive used by the "Lock Journal" flow (enabling
/// password protection on an existing vault). They are pure `db`-layer
/// helpers. The always-encrypted rewrite removed the inverse direction
/// (encrypted → plain) entirely — every vault is encrypted from creation, so
/// there is no plain DB to convert to.
///
/// # Safety contract
///
/// Every destructive operation (step 7: atomic rename) is preceded by a `.bak`
/// copy. On any failure the original file is restored from `.bak`. The caller
/// receives an `Err` and the database is in its pre-conversion state.
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;

use crate::db::EncryptionMode;
use crate::utils::boot_file::{self, BootFile};

/// Remove a file if it exists; ignore all errors (best-effort cleanup).
fn remove_if_exists(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Return the `.boot.bak` path corresponding to `boot_path`.
fn boot_bak_path(boot_path: &Path) -> PathBuf {
    boot_path.with_extension("boot.bak")
}

/// Persist the boot file snapshot to `.boot.bak` before any destructive
/// operation so that crash-recovery can restore it even if the process dies
/// after the DB rename succeeds.
///
/// - `snapshot.is_some()`: writes the bytes to `boot_bak_path(boot_path)`.
/// - `snapshot.is_none()`: no-op (the boot file was absent; nothing to persist).
///
/// Returns `Err` if the write fails.
fn persist_boot_bak(boot_path: &Path, snapshot: &Option<Vec<u8>>) -> Result<(), String> {
    if let Some(ref bytes) = snapshot {
        let bak = boot_bak_path(boot_path);
        std::fs::write(&bak, bytes)
            .map_err(|e| format!("failed to write .boot.bak before conversion: {e}"))?;
    }
    Ok(())
}

/// Write all four password-mode settings (`encryption_mode`, `password_hash`,
/// `wrapped_encryption_key`, `kek_salt`) into an attached database alias.
///
/// `alias` MUST be a code-controlled constant (e.g. `"encrypted"`), never user
/// input — the format string is intentionally unparameterized for the identifier.
fn write_password_mode_settings_into_attached(
    conn: &rusqlite::Connection,
    alias: &str,
    password_hash: &str,
    wrapped_key_hex: &str,
    kek_salt_hex: &str,
) -> Result<(), String> {
    let upserts: [(&str, &str); 4] = [
        ("encryption_mode", "password"),
        ("password_hash", password_hash),
        ("wrapped_encryption_key", wrapped_key_hex),
        ("kek_salt", kek_salt_hex),
    ];
    for (key, value) in upserts.iter() {
        let sql = format!("INSERT OR REPLACE INTO {alias}.settings (key, value) VALUES (?1, ?2)");
        conn.execute(&sql, rusqlite::params![key, value])
            .map_err(|e| {
                format!("write_password_mode_settings_into_attached: upsert {key} failed: {e}")
            })?;
    }
    Ok(())
}

/// Write the recovery-slot settings (`recovery_wrapped_master`,
/// `cloud_master_fingerprint`) into an attached database alias, alongside the
/// four password-mode rows. Used by the recovery-aware Lock Journal conversion
/// so vaults created from Settings carry the same offline-recovery material as
/// first-time setup.
///
/// `recovery_wrapped_hex` and `master_fingerprint` MUST identify the same
/// master key (co-written invariant the boot-file backfill guard depends on).
/// `alias` MUST be a code-controlled constant, never user input.
fn write_recovery_settings_into_attached(
    conn: &rusqlite::Connection,
    alias: &str,
    recovery_wrapped_hex: &str,
    master_fingerprint: &str,
) -> Result<(), String> {
    let upserts: [(&str, &str); 2] = [
        ("recovery_wrapped_master", recovery_wrapped_hex),
        ("cloud_master_fingerprint", master_fingerprint),
    ];
    for (key, value) in upserts.iter() {
        let sql = format!("INSERT OR REPLACE INTO {alias}.settings (key, value) VALUES (?1, ?2)");
        conn.execute(&sql, rusqlite::params![key, value])
            .map_err(|e| {
                format!("write_recovery_settings_into_attached: upsert {key} failed: {e}")
            })?;
    }
    Ok(())
}

/// Clean up after a failed conversion attempt.
///
/// - `rename_done`: whether the atomic rename (step 7/8) completed before the
///   failure. If `true`, `db_path` now contains the new (incomplete) file and
///   must be overwritten from `.bak`.
/// - `temp_path`: the intermediate file (`.plain` or `.enc`) to delete.
/// - `boot_snapshot`: the original boot file bytes captured before any
///   conversion started (`None` if the boot file was absent). When
///   `rename_done` is `true` and the boot file save failed, this snapshot is
///   used to restore (or delete) the boot file so it matches the pre-conversion
///   state.
fn cleanup_failed_conversion(
    db_path: &Path,
    bak_path: &Path,
    temp_path: &Path,
    boot_path: &Path,
    boot_snapshot: &Option<Vec<u8>>,
    rename_done: bool,
) {
    if rename_done {
        // The rename succeeded — db_path is now the (potentially partial)
        // converted file. Restore the original from .bak.
        let _ = std::fs::rename(bak_path, db_path);
        // Also restore or delete the boot file to match pre-conversion state.
        match boot_snapshot {
            Some(original_bytes) => {
                // Restore original boot file content.
                let _ = std::fs::write(boot_path, original_bytes);
            }
            None => {
                // Boot file did not exist before conversion — remove it.
                remove_if_exists(boot_path);
            }
        }
        // The in-memory snapshot was used to restore the boot file above;
        // the on-disk .boot.bak is now stale — remove it.
        remove_if_exists(&boot_bak_path(boot_path));
    } else {
        // The original db_path is untouched; clean up any temp files and the
        // .boot.bak snapshot (it was written before the destructive ops started
        // but the conversion never completed, so it's no longer needed).
        remove_if_exists(temp_path);
        remove_if_exists(bak_path);
        remove_if_exists(&boot_bak_path(boot_path));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// convert_to_password
// ─────────────────────────────────────────────────────────────────────────────

/// Convert a plain (unencrypted) SQLite database to an encrypted SQLCipher
/// database in place.
///
/// # Steps (matches README → Rekey strategy → Plain → encrypted)
///
/// 1. WAL flush + journal_mode = DELETE on the plain connection.
/// 2. Generate fresh master key (32 random bytes) + KEK salt.
/// 3. Argon2id derive KEK from `new_password` + `kek_salt`.
/// 4. HKDF derive SQLCipher sub-key from master.
/// 5. Wrap master with KEK → `wrapped_hex`.
/// 6. Backup `db_path` → `db_path.bak`.
/// 7. Delete any stale `db_path.enc` from a previous interrupted run.
/// 8. `ATTACH DATABASE 'memlore.db.enc' AS encrypted KEY "x'<sqlcipher_key_hex>'"`.
/// 9. `SELECT sqlcipher_export('encrypted')`.
/// 10. `DETACH DATABASE encrypted`.
/// 11. Close (drop) the plain connection.
/// 12. Atomic rename `db_path.enc` → `db_path` (POSIX-atomic on macOS).
/// 13. Write boot file with `mode=password`, `kek_salt`, `wrapped_key`.
/// 14. Delete `.bak` on success.
///
/// # Error handling
///
/// - Failure before step 12: original `db_path` is untouched; `.enc` and
///   `.bak` are cleaned up; `Err` is returned.
/// - Failure at or after step 12: `.bak` is renamed back to `db_path`;
///   `.enc` is removed; `Err` is returned.
pub fn convert_to_password(
    conn: rusqlite::Connection,
    db_path: &Path,
    boot_path: &Path,
    new_password: &str,
) -> Result<(), String> {
    use crate::utils::encryption::KEY_SIZE;
    use rand::RngCore;

    // Generate a fresh random 32-byte master key. No recovery slot in this
    // legacy path — callers that want offline recovery use
    // `convert_to_password_with_recovery`.
    let mut raw_key = zeroize::Zeroizing::new([0u8; KEY_SIZE]);
    rand::rngs::OsRng.fill_bytes(raw_key.as_mut());
    convert_to_password_impl(conn, db_path, boot_path, new_password, raw_key, None)
}

/// Recovery-aware variant of [`convert_to_password`]. Encrypts the plain DB
/// under `new_password` using the CALLER-SUPPLIED `master_key` (so it matches
/// the recovery slot the caller already wrapped), and persists the recovery
/// slot + master fingerprint atomically into the encrypted target DB and the
/// boot file. This is what the two-step "Lock Journal" flow uses so vaults
/// created from Settings support offline "Forgot password".
///
/// `recovery_wrapped_hex` and `master_fingerprint` MUST identify `master_key`.
pub fn convert_to_password_with_recovery(
    conn: rusqlite::Connection,
    db_path: &Path,
    boot_path: &Path,
    new_password: &str,
    master_key: zeroize::Zeroizing<[u8; 32]>,
    recovery_wrapped_hex: String,
    master_fingerprint: String,
) -> Result<(), String> {
    convert_to_password_impl(
        conn,
        db_path,
        boot_path,
        new_password,
        master_key,
        Some((recovery_wrapped_hex, master_fingerprint)),
    )
}

/// Core conversion: encrypt the plain DB under `new_password` keyed by the
/// given `raw_key`. When `recovery` is `Some((recovery_wrapped_hex,
/// master_fingerprint))`, the recovery slot + fingerprint are written into the
/// encrypted target settings AND the boot file in the same atomic conversion.
fn convert_to_password_impl(
    conn: rusqlite::Connection,
    db_path: &Path,
    boot_path: &Path,
    new_password: &str,
    raw_key: zeroize::Zeroizing<[u8; 32]>,
    recovery: Option<(String, String)>,
) -> Result<(), String> {
    use argon2::{
        password_hash::{PasswordHasher, SaltString},
        Argon2,
    };
    use zeroize::Zeroize;

    use crate::utils::encryption::{
        derive_sqlcipher_key, generate_encryption_salt, wrap_key_with, KdfParams,
    };

    let bak_path: PathBuf = db_path.with_extension("db.bak");
    let enc_path: PathBuf = db_path.with_extension("db.enc");

    // Snapshot the boot file before touching anything. If conversion fails
    // after the rename we can restore the boot file to its pre-conversion
    // state (or delete it if it was absent). This prevents the app from
    // starting up with an inconsistent boot file after a partial failure.
    let boot_snapshot: Option<Vec<u8>> = std::fs::read(boot_path).ok();

    // Persist the snapshot to .boot.bak BEFORE any destructive operation so
    // that crash-recovery (recover_from_interrupted_conversion) can restore the
    // boot file even if the process dies after the DB rename succeeds.
    persist_boot_bak(boot_path, &boot_snapshot)?;

    // ── Key wrapping (before touching disk) ─────────────────────────────────

    // Wrap the caller-supplied master key with the password KEK.
    //
    // Enabling encryption establishes brand-new key material with no prior KDF
    // preset to inherit, so default to FAST (the app default for new vaults).
    // The self-describing format makes the stored strength match the default
    // instead of silently reporting High in Settings.
    let kek_salt: [u8; crate::utils::encryption::SALT_SIZE] = generate_encryption_salt();
    let kek_salt_hex = hex::encode(kek_salt);
    let wrapped_hex = wrap_key_with(&raw_key, new_password, &kek_salt, KdfParams::FAST)?;

    // Derive the SQLCipher sub-key via HKDF.
    let sqlcipher_key = derive_sqlcipher_key(&*raw_key);
    // raw_key is no longer needed; sqlcipher_key is Zeroizing and dropped at
    // end of scope. raw_key is dropped here.
    drop(raw_key);

    // Wrap the hex representation in Zeroizing so the key material is wiped
    // when dropped, even if it is also embedded in attach_sql below.
    let mut key_hex = zeroize::Zeroizing::new(hex::encode(&*sqlcipher_key));
    // sqlcipher_key is Zeroizing — wiped when dropped.
    drop(sqlcipher_key);

    // Compute the Argon2id password hash (PHC string format) that will be
    // written atomically into the target DB's settings table. This mirrors
    // what `db::set_password_hash` does for the live connection.
    let password_hash_str = {
        let salt = SaltString::generate(rand::rngs::OsRng);
        Argon2::default()
            .hash_password(new_password.as_bytes(), &salt)
            .map_err(|e| format!("convert_to_password: hash password failed: {e}"))?
            .to_string()
    };

    // ── Phase A: all operations that need the plain connection ───────────────

    let phase_a: Result<(), String> = (|| {
        // Step 1 — flush WAL and switch to DELETE journal mode.
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")
            .map_err(|e| format!("flush WAL: {e}"))?;

        // Step 6 — backup the plain DB.
        std::fs::copy(db_path, &bak_path).map_err(|e| format!("backup db: {e}"))?;

        // Step 7 — remove any stale .enc from a previous interrupted run.
        remove_if_exists(&enc_path);

        // Step 8 — attach a new encrypted database.
        // NOTE: The KEY clause cannot be parameterized in SQLCipher. Only the
        // path is parameterized; the key is formatted as a literal hex string.
        // Hex-only content makes this safe (no SQL injection surface).
        // Both key_hex and attach_sql carry key material and are zeroized on drop.
        let mut attach_sql = zeroize::Zeroizing::new(format!(
            "ATTACH DATABASE ?1 AS encrypted KEY \"x'{}'\"",
            *key_hex
        ));
        let result = conn
            .execute(
                &*attach_sql,
                rusqlite::params![enc_path.to_string_lossy().as_ref()],
            )
            .map_err(|e| format!("ATTACH encrypted: {e}"));
        attach_sql.zeroize();
        result?;

        // Step 9 — export all tables/indexes into the encrypted DB.
        let export_result = conn
            .query_row("SELECT sqlcipher_export('encrypted')", [], |_row| Ok(()))
            .map_err(|e| format!("sqlcipher_export: {e}"));

        // Step 9a — if export succeeded, write correct password-mode settings
        // into the target DB so it is internally consistent before the rename.
        // sqlcipher_export copies the source settings rows verbatim (mode=unset,
        // no key material); we must overwrite all four password-mode rows.
        if export_result.is_ok() {
            let settings_result = write_password_mode_settings_into_attached(
                &conn,
                "encrypted",
                &password_hash_str,
                &wrapped_hex,
                &kek_salt_hex,
            )
            .and_then(|()| {
                // Recovery-aware path: persist the recovery slot + fingerprint
                // into the SAME encrypted target, atomically with the password
                // rows above. Both must land before the rename so the vault is
                // internally consistent.
                if let Some((ref recovery_wrapped_hex, ref master_fingerprint)) = recovery {
                    write_recovery_settings_into_attached(
                        &conn,
                        "encrypted",
                        recovery_wrapped_hex,
                        master_fingerprint,
                    )?;
                }
                // sqlcipher_export copies ALL tables verbatim. The two-step Lock
                // Journal flow keeps its key material in memory (not the DB), so
                // there is normally nothing to purge — but defensively clear any
                // `pending_first_time_setup` rows that an interrupted setup may
                // have left behind, so no setup leftovers persist in the vault.
                // The table may be absent in older source DBs (sqlcipher_export
                // only copies tables that exist), so guard on its presence.
                let pending_exists: bool = conn
                    .query_row(
                        "SELECT COUNT(*) > 0 FROM encrypted.sqlite_master \
                         WHERE type = 'table' AND name = 'pending_first_time_setup'",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(|e| {
                        format!("convert_to_password: probe pending table in target: {e}")
                    })?;
                if pending_exists {
                    conn.execute("DELETE FROM encrypted.pending_first_time_setup", [])
                        .map_err(|e| {
                            format!("convert_to_password: purge pending setup in target: {e}")
                        })?;
                }
                Ok(())
            })
            .and_then(|()| {
                // Verify the write landed — surface any silent failure.
                let verified: Option<String> = conn
                    .query_row(
                        "SELECT value FROM encrypted.settings \
                         WHERE key = 'encryption_mode'",
                        [],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| {
                        format!("convert_to_password: verify encryption_mode in target: {e}")
                    })?;
                if verified.as_deref() != Some("password") {
                    return Err(format!(
                        "convert_to_password: encryption_mode in target is {:?}, \
                         expected 'password'",
                        verified
                    ));
                }
                Ok(())
            });

            // Step 10 — detach unconditionally (best-effort) then propagate any
            // settings error.
            let _ = conn.execute("DETACH DATABASE encrypted", []);
            settings_result?;
        } else {
            // Step 10 — export failed; detach best-effort and propagate export error.
            let _ = conn.execute("DETACH DATABASE encrypted", []);
            export_result?;
        }

        Ok(())
    })();

    // Zeroize key_hex now — all DB calls are done.
    key_hex.zeroize();

    // Step 11 — drop the plain connection regardless of phase_a result.
    // This releases the file handle so we can rename over it.
    drop(conn);

    if let Err(e) = phase_a {
        cleanup_failed_conversion(
            db_path,
            &bak_path,
            &enc_path,
            boot_path,
            &boot_snapshot,
            false,
        );
        return Err(e);
    }

    // ── Phase B: file-system operations (post-close) ─────────────────────

    // Step 12 — atomic rename: enc → db (point of no return).
    if let Err(e) = std::fs::rename(&enc_path, db_path) {
        cleanup_failed_conversion(
            db_path,
            &bak_path,
            &enc_path,
            boot_path,
            &boot_snapshot,
            false,
        );
        return Err(format!("rename enc to db: {e}"));
    }

    // Step 13 — write the boot file with mode=password, kek_salt, wrapped_key,
    // and (recovery-aware path only) the recovery slot so offline "Forgot
    // password" works for vaults created via Lock Journal too. The slot is
    // co-stored with CLOUD_MASTER_FINGERPRINT in the encrypted settings above,
    // upholding the backfill guard's fingerprint/slot invariant.
    let password_boot = BootFile {
        mode: EncryptionMode::Password,
        // Lock Journal always sets up password unlock; os_kek is not offered
        // by this flow (out of scope for Phase 3 — the picker UI is Phase 6/7).
        unlock_method: crate::utils::boot_file::UnlockMethod::Password,
        kek_salt: Some(kek_salt_hex),
        wrapped_key: Some(wrapped_hex),
        os_kek_wrapped_master: None,
        recovery_wrapped: recovery.as_ref().map(|(rw, _)| rw.clone()),
        wrapped_content_list: None,
        wrapped_db_key: None,
        master_wrapped_db_key: None,
        migration_in_progress: None,
    };
    if let Err(e) = boot_file::save(&password_boot, boot_path) {
        // Rename succeeded but boot save failed — restore from .bak and
        // restore the boot file to its pre-conversion state.
        cleanup_failed_conversion(
            db_path,
            &bak_path,
            &enc_path,
            boot_path,
            &boot_snapshot,
            true,
        );
        return Err(format!("save boot file: {e}"));
    }

    // Step 14 — delete .bak on full success (ignore failure, rare disk error).
    let _ = std::fs::remove_file(&bak_path);
    // Also delete .boot.bak — the conversion completed successfully so the
    // snapshot is no longer needed for crash recovery.
    remove_if_exists(&boot_bak_path(boot_path));

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery probe
// ─────────────────────────────────────────────────────────────────────────────

/// The outcome of [`recover_from_interrupted_conversion`].
///
/// Variants are non-exhaustive to allow future additions without breaking callers.
#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryAction {
    /// No conversion artifacts found; nothing was done.
    None,
    /// `.bak` was found alongside `.db`; `.db` was overwritten with `.bak`.
    RestoredFromBak,
    /// Only a `.enc` file was found (no `.db`, no `.bak`); promoted to `.db`.
    PromotedEnc,
}

/// Inspect the directory for conversion artifacts and recover from any
/// interrupted conversion.
///
/// # Parameters
///
/// - `db_path`: path to the main database file (e.g. `memlore.db`).
/// - `boot_path`: path to the companion boot file (e.g. `memlore.db.boot`).
///
/// # Logic
///
/// - `bak.exists()` → previous conversion interrupted; restore DB from `.bak`,
///   and restore boot file from `<boot>.bak` if one exists.
/// - `!db_path.exists()`:
///   - Any `.plain` present → unrecoverable. `.plain` was only produced by
///     the removed `convert_to_no_password` path; with or without a sibling
///     `.enc` this is wipe-and-recreate debris, not a state to promote.
///   - Only `.enc` exists → promote to `.db`; only if the boot file already
///     contains `kek_salt` + `wrapped_key` (the keys were written before the
///     rename — safe to promote). If those fields are absent the orphan cannot
///     be used — returns `Err`.
///   - Neither exists → nothing to do.
/// - `db_path.exists()`, no `.bak` → clean up any straggler `.plain` / `.enc`.
///
/// # Error semantics
///
/// Returns `Err` for I/O failures AND for unrecoverable states (any `.plain`
/// orphan; `.enc` orphan without boot key material). Returns
/// `Ok(RecoveryAction::None)` when no artifacts are found.
pub fn recover_from_interrupted_conversion(
    db_path: &Path,
    boot_path: &Path,
) -> Result<RecoveryAction, String> {
    let bak_path = db_path.with_extension("db.bak");
    let plain_path = db_path.with_extension("db.plain");
    let enc_path = db_path.with_extension("db.enc");
    let boot_bak_path = boot_bak_path(boot_path);

    if bak_path.exists() {
        // A previous conversion was interrupted before the .bak could be
        // deleted. Restore the original DB from .bak (overwrites any partial
        // file at db_path).
        std::fs::rename(&bak_path, db_path)
            .map_err(|e| format!("recovery: rename .bak to .db failed: {e}"))?;
        // Also restore the boot file from its .bak if one exists.
        // If no .boot.bak exists, the pre-conversion boot was absent — delete
        // any stale boot file so the restored state matches pre-conversion.
        if boot_bak_path.exists() {
            std::fs::rename(&boot_bak_path, boot_path)
                .map_err(|e| format!("recovery: rename .boot.bak to .boot failed: {e}"))?;
        } else {
            remove_if_exists(boot_path);
        }
        // Clean up any straggler intermediate files.
        remove_if_exists(&plain_path);
        remove_if_exists(&enc_path);
        return Ok(RecoveryAction::RestoredFromBak);
    }

    if !db_path.exists() {
        // `.plain` is always unrecoverable (removed none-mode conversion).
        // Distinguish "plain alone" vs "plain + enc" only in the error text
        // so operators can still see the ambiguous dual-orphan case.
        if plain_path.exists() {
            return Err(if enc_path.exists() {
                "ambiguous: both .plain and .enc exist with no .db".to_string()
            } else {
                "recovery: found a .plain orphan file, which no encryption \
                 mode can produce anymore (none-mode was removed) — this \
                 database is in a state from before the always-encrypted \
                 rewrite and cannot be recovered; wipe and recreate"
                    .to_string()
            });
        }

        if enc_path.exists() {
            // The to-encrypted rename succeeded but .bak cleanup was interrupted.
            // The boot file must already contain kek_salt + wrapped_key —
            // without them the DB cannot be opened and recovery is impossible.
            let current_boot = boot_file::load(boot_path)?;
            if current_boot.kek_salt.is_none() || current_boot.wrapped_key.is_none() {
                return Err(
                    "recovery: .enc orphan found but boot file has no kek_salt/wrapped_key \
                     — cannot recover encrypted DB without key material"
                        .to_string(),
                );
            }
            std::fs::rename(&enc_path, db_path)
                .map_err(|e| format!("recovery: rename .enc to .db failed: {e}"))?;
            // Ensure the boot file reflects mode=password.
            if current_boot.mode != EncryptionMode::Password {
                let password_boot = BootFile {
                    mode: EncryptionMode::Password,
                    // Master key is unchanged by this crash-recovery rename;
                    // carry unlock method + every wrap forward unchanged.
                    unlock_method: current_boot.unlock_method,
                    kek_salt: current_boot.kek_salt,
                    wrapped_key: current_boot.wrapped_key,
                    os_kek_wrapped_master: current_boot.os_kek_wrapped_master,
                    recovery_wrapped: current_boot.recovery_wrapped,
                    wrapped_content_list: current_boot.wrapped_content_list,
                    wrapped_db_key: current_boot.wrapped_db_key,
                    master_wrapped_db_key: current_boot.master_wrapped_db_key,
                    migration_in_progress: None,
                };
                boot_file::save(&password_boot, boot_path)
                    .map_err(|e| format!("recovery: rewrite boot to mode=password failed: {e}"))?;
            }
            return Ok(RecoveryAction::PromotedEnc);
        }

        // No .db and no artifacts at all — nothing to recover.
        return Ok(RecoveryAction::None);
    }

    // db_path exists and no .bak — normal state. Clean up any straggler files
    // that might have been left by a very early-stage interrupted conversion
    // (before .bak was created, .enc/.plain might still be present from an
    // even earlier run).
    remove_if_exists(&plain_path);
    remove_if_exists(&enc_path);
    Ok(RecoveryAction::None)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ─── Task 5 Tests ─────────────────────────────────────────────────────────

    /// Build a plain (unencrypted) SQLite DB with 2 rows, an index, and a
    /// settings table pre-seeded with `encryption_mode=unset` (the
    /// always-encrypted rewrite's "not yet encrypted" state — the pre-onboarding
    /// lifecycle step, not a mode a user can pick).
    fn make_plain_db_with_sample_data(dir: &TempDir) -> (PathBuf, PathBuf) {
        let db_path = dir.path().join("memlore.db");
        let boot_path = dir.path().join("memlore.db.boot");

        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE entries(id INTEGER PRIMARY KEY, body TEXT);\
             CREATE INDEX idx_entries_id ON entries(id);\
             CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');\
             INSERT INTO entries(body) VALUES('hello'),('world');\
             INSERT INTO settings(key, value) VALUES('encryption_mode', 'unset');",
        )
        .unwrap();
        drop(conn);

        (db_path, boot_path)
    }

    // ─── Test 4 ───────────────────────────────────────────────────────────────

    #[test]
    fn convert_plain_db_to_encrypted_roundtrips_data() {
        use crate::utils::encryption::{derive_sqlcipher_key, unwrap_key, KEY_SIZE};

        let dir = TempDir::new().unwrap();
        let (db_path, boot_path) = make_plain_db_with_sample_data(&dir);

        // Open plain DB and convert.
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        convert_to_password(conn, &db_path, &boot_path, "p@ssw0rd1234")
            .expect("conversion must succeed");

        // .bak and .enc must be cleaned up on success.
        assert!(
            !db_path.with_extension("db.bak").exists(),
            ".bak must be removed on success"
        );
        assert!(
            !db_path.with_extension("db.enc").exists(),
            ".enc must be removed on success"
        );

        // .db must still exist.
        assert!(db_path.exists(), ".db must exist after conversion");

        // Boot file must reflect mode=password with kek_salt and wrapped_key.
        let boot = boot_file::load(&boot_path).expect("boot file must be readable");
        assert_eq!(boot.mode, EncryptionMode::Password);
        let kek_salt_hex = boot.kek_salt.expect("kek_salt must be set");
        let wrapped_hex = boot.wrapped_key.expect("wrapped_key must be set");

        // Enabling encryption must use the app-default FAST strength, not a
        // hardcoded HIGH — otherwise the Settings screen shows "High" right
        // after the user turns encryption on.
        let blob = hex::decode(&wrapped_hex).unwrap();
        assert_eq!(
            crate::utils::encryption::parse_kek_params(&blob)
                .unwrap()
                .m_cost,
            crate::utils::encryption::KdfParams::FAST.m_cost,
            "convert_to_password must wrap under FAST, not HIGH"
        );

        // Re-derive the SQLCipher key from the stored credentials, same as
        // what startup would do.
        let kek_salt_bytes = hex::decode(&kek_salt_hex).expect("kek_salt must be valid hex");
        let master: zeroize::Zeroizing<[u8; KEY_SIZE]> =
            unwrap_key(&wrapped_hex, "p@ssw0rd1234", &kek_salt_bytes)
                .expect("unwrap_key must succeed with correct password");
        let sqlcipher_key = derive_sqlcipher_key(&*master);
        let key_hex = hex::encode(&*sqlcipher_key);

        // Open the encrypted DB with the derived key.
        let enc_conn = rusqlite::Connection::open(&db_path).unwrap();
        enc_conn
            .execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))
            .expect("PRAGMA key must succeed");

        let count: i64 = enc_conn
            .query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))
            .expect("SELECT COUNT must work after encryption");
        assert_eq!(count, 2, "all rows must survive conversion");

        let mut stmt = enc_conn
            .prepare("SELECT body FROM entries ORDER BY id")
            .unwrap();
        let bodies: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(bodies, vec!["hello", "world"]);

        // Index must survive.
        let index_exists: bool = enc_conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='index' AND name='idx_entries_id'",
                [],
                |r| r.get(0),
            )
            .expect("sqlite_master query must work");
        assert!(index_exists, "index must survive conversion");

        // Settings table in the converted DB must have all four password-mode
        // rows written atomically before the rename swap.
        let enc_mode: Option<String> = enc_conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'encryption_mode'",
                [],
                |r| r.get(0),
            )
            .optional()
            .expect("settings query must not fail");
        assert_eq!(
            enc_mode.as_deref(),
            Some("password"),
            "encryption_mode must be 'password' in converted encrypted DB"
        );

        for present_key in &["password_hash", "wrapped_encryption_key", "kek_salt"] {
            let value: Option<String> = enc_conn
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    rusqlite::params![present_key],
                    |r| r.get(0),
                )
                .optional()
                .expect("settings query must not fail");
            assert!(
                value.is_some() && !value.as_deref().unwrap_or("").is_empty(),
                "settings key '{present_key}' must be present and non-empty after conversion"
            );
        }

        // The wrapped_encryption_key and kek_salt in settings must match the boot
        // file (they are the same values written by convert_to_password).
        let db_wrapped: String = enc_conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'wrapped_encryption_key'",
                [],
                |r| r.get(0),
            )
            .expect("wrapped_encryption_key must exist");
        assert_eq!(
            db_wrapped, wrapped_hex,
            "wrapped_key in settings must match boot file"
        );

        let db_kek_salt: String = enc_conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'kek_salt'",
                [],
                |r| r.get(0),
            )
            .expect("kek_salt must exist");
        assert_eq!(
            db_kek_salt, kek_salt_hex,
            "kek_salt in settings must match boot file"
        );
    }

    // ─── Test 5 ───────────────────────────────────────────────────────────────

    #[test]
    fn convert_to_password_fails_cleanly_if_attach_fails() {
        let dir = TempDir::new().unwrap();
        let (db_path, boot_path) = make_plain_db_with_sample_data(&dir);

        // Pre-create <dir>/memlore.db.enc as a DIRECTORY so ATTACH cannot
        // open it as a SQLite file.
        let enc_path = db_path.with_extension("db.enc");
        std::fs::create_dir_all(&enc_path).unwrap();

        let conn = rusqlite::Connection::open(&db_path).unwrap();
        let result = convert_to_password(conn, &db_path, &boot_path, "p@ssw0rd1234");

        assert!(result.is_err(), "conversion must fail when ATTACH fails");

        // Original plain DB must still be readable (no PRAGMA key needed).
        let plain = rusqlite::Connection::open(&db_path).unwrap();
        let count: i64 = plain
            .query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))
            .expect("original DB must still be readable after failed conversion");
        assert_eq!(
            count, 2,
            "original data must be intact after failed conversion"
        );

        // Boot file must not exist (we never wrote one).
        assert!(
            !boot_path.exists(),
            "boot file must not be created after failed conversion"
        );
    }

    // ─── Test 6 ───────────────────────────────────────────────────────────────

    #[test]
    fn recover_restores_from_bak_when_conversion_was_interrupted_mid_rename() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = dir.path().join("memlore.db.boot");
        let bak_path = db_path.with_extension("db.bak");

        // Good original DB written to .bak location.
        let conn = rusqlite::Connection::open(&bak_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE items(id INTEGER PRIMARY KEY, v TEXT);\
             INSERT INTO items(v) VALUES('original');",
        )
        .unwrap();
        drop(conn);

        // Write a pre-conversion boot file and its .bak snapshot.
        let boot_bak_path = boot_path.with_extension("boot.bak");
        std::fs::write(
            &boot_bak_path,
            "mode=password\nkek_salt=aabb\nwrapped_key=ccdd\n",
        )
        .unwrap();
        // Simulate a partial/corrupt .db and a partially-written new boot file.
        // The exact content of the crashed-process boot file doesn't matter —
        // it gets discarded (overwritten from .boot.bak) by the recovery path
        // under test, so any placeholder bytes work here.
        std::fs::write(&db_path, b"corrupted").unwrap();
        std::fs::write(&boot_path, "mode=password\npartial-write-in-progress\n").unwrap();

        let action = recover_from_interrupted_conversion(&db_path, &boot_path)
            .expect("recover must not return Err");
        assert_eq!(action, RecoveryAction::RestoredFromBak);

        // .bak must be gone.
        assert!(!bak_path.exists(), ".bak must be removed after recovery");

        // Boot file must be restored from .boot.bak.
        assert!(
            !boot_bak_path.exists(),
            ".boot.bak must be removed after recovery"
        );
        let restored_boot = boot_file::load(&boot_path).expect("boot file must be readable");
        assert_eq!(
            restored_boot.mode,
            EncryptionMode::Password,
            "boot file must be restored to pre-conversion state"
        );

        // .db must contain the good content.
        let restored = rusqlite::Connection::open(&db_path).unwrap();
        let count: i64 = restored
            .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
            .expect("restored DB must be readable");
        assert_eq!(count, 1, "restored DB must contain original data");
    }

    // ─── Test 7 ───────────────────────────────────────────────────────────────
    //
    // A `.plain` orphan can only be produced by the removed
    // `convert_to_no_password` conversion. Since no code path can create one
    // anymore, `recover_from_interrupted_conversion` now treats a `.plain`
    // orphan as an unrecoverable stale-debris state (`Err`) instead of
    // promoting it — see the function's doc comment.
    #[test]
    fn recover_rejects_orphan_plain_file_as_stale_debris() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = dir.path().join("memlore.db.boot");
        let plain_path = db_path.with_extension("db.plain");

        // A `.plain` file somehow present (e.g. left over from a pre-rewrite
        // install) with no `.db` and no `.bak`.
        std::fs::write(&plain_path, b"stale-plain-contents").unwrap();

        assert!(!db_path.exists());
        assert!(plain_path.exists());

        let result = recover_from_interrupted_conversion(&db_path, &boot_path);
        assert!(
            result.is_err(),
            "a .plain orphan must be rejected, not promoted"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains(".plain"),
            "error must mention the .plain orphan, got: {err}"
        );

        // Nothing must be touched — the orphan is left in place for a human /
        // wipe-and-recreate to deal with, not silently promoted or deleted.
        assert!(!db_path.exists(), ".db must not be created");
        assert!(plain_path.exists(), ".plain must be left untouched");
    }

    // ─── Test 8 ───────────────────────────────────────────────────────────────

    #[test]
    fn recover_handles_orphan_enc_file_with_boot_keys() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = dir.path().join("memlore.db.boot");
        let enc_path = db_path.with_extension("db.enc");

        // Write a placeholder .enc file (rename logic only, not decryptable).
        std::fs::write(&enc_path, b"encrypted-content").unwrap();

        // Boot file already has kek_salt + wrapped_key from the convert_to_password step.
        boot_file::save(
            &BootFile {
                mode: EncryptionMode::Password,
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                kek_salt: Some("aabbcc".to_owned()),
                wrapped_key: Some("ddeeff".to_owned()),
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

        assert!(!db_path.exists());
        assert!(enc_path.exists());

        let action = recover_from_interrupted_conversion(&db_path, &boot_path)
            .expect("recover must not return Err");
        assert_eq!(action, RecoveryAction::PromotedEnc);

        assert!(db_path.exists(), ".db must exist after promotion");
        assert!(!enc_path.exists(), ".enc must be removed after promotion");

        // Boot file must retain mode=password.
        let boot = boot_file::load(&boot_path).expect("boot file must be readable");
        assert_eq!(boot.mode, EncryptionMode::Password);
    }

    // ─── Test 8b ──────────────────────────────────────────────────────────────

    #[test]
    fn recover_enc_orphan_without_boot_keys_returns_err() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = dir.path().join("memlore.db.boot");
        let enc_path = db_path.with_extension("db.enc");

        // .enc exists but boot file has no key material (crash before boot write).
        std::fs::write(&enc_path, b"encrypted-content").unwrap();
        // No boot file — load() returns default (Unset, no keys).

        assert!(!db_path.exists());
        assert!(enc_path.exists());

        let result = recover_from_interrupted_conversion(&db_path, &boot_path);
        assert!(
            result.is_err(),
            "enc orphan without boot key material must return Err"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("kek_salt") || err.contains("wrapped_key"),
            "error must mention missing key fields, got: {err}"
        );
    }

    // ─── Test 9 ───────────────────────────────────────────────────────────────

    #[test]
    fn recover_is_noop_when_no_conversion_artifacts_exist() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = dir.path().join("memlore.db.boot");

        // Clean DB, no artifacts.
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY);")
            .unwrap();
        drop(conn);

        let before_meta = std::fs::metadata(&db_path).expect("db must exist before recovery");

        let action = recover_from_interrupted_conversion(&db_path, &boot_path)
            .expect("recover must not return Err");
        assert_eq!(action, RecoveryAction::None);

        // File must still exist and be unchanged (same size).
        let after_meta = std::fs::metadata(&db_path).expect("db must still exist");
        assert_eq!(
            before_meta.len(),
            after_meta.len(),
            "file must be untouched"
        );
    }

    // ─── Test 10 ──────────────────────────────────────────────────────────────

    #[test]
    fn recover_returns_err_when_both_plain_and_enc_orphan_exist() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = dir.path().join("memlore.db.boot");
        let plain_path = db_path.with_extension("db.plain");
        let enc_path = db_path.with_extension("db.enc");

        // Leave both .plain and .enc with no .db and no .bak.
        std::fs::write(&plain_path, b"plain").unwrap();
        std::fs::write(&enc_path, b"encrypted").unwrap();

        assert!(!db_path.exists());

        let result = recover_from_interrupted_conversion(&db_path, &boot_path);
        assert!(
            result.is_err(),
            "ambiguous state (both orphans) must return Err"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("ambiguous"),
            "error must mention 'ambiguous', got: {err}"
        );
    }

    // ─── Test 12 — boot save failure restores boot file (convert_to_password) ──

    #[test]
    fn convert_to_password_restores_boot_file_on_save_failure() {
        let dir = TempDir::new().unwrap();
        let (db_path, boot_path) = make_plain_db_with_sample_data(&dir);

        // No pre-existing boot file — absence is also a valid pre-conversion state.
        assert!(
            !boot_path.exists(),
            "boot file must not exist before conversion"
        );

        // Force boot_file::save to fail by pre-creating the .tmp file target as
        // a directory — std::fs::write will fail on a directory path.
        let boot_tmp = boot_path.with_extension("boot.tmp");
        std::fs::create_dir_all(&boot_tmp).unwrap();

        let conn = rusqlite::Connection::open(&db_path).unwrap();
        let result = convert_to_password(conn, &db_path, &boot_path, "p@ssw0rd1234");

        assert!(result.is_err(), "conversion must fail when boot save fails");

        // Data file must be restored from .bak.
        let plain = rusqlite::Connection::open(&db_path).unwrap();
        let count: i64 = plain
            .query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))
            .expect("original DB must be readable after failed conversion");
        assert_eq!(count, 2, "original data must be intact");

        // Boot file must still be absent (pre-conversion state was absent).
        assert!(
            !boot_path.exists(),
            "boot file must remain absent after failed conversion (pre-conversion state)"
        );
    }

    // ─── Test 14 — .boot.bak lifecycle: convert_to_password ─────────────────
    //
    // Failpoint: directory at .enc path so ATTACH DATABASE fails in Phase A.
    //
    // Post-cleanup invariants:
    //   - .boot.bak removed
    //   - original boot file (mode=unset) unchanged
    //   - original plain DB still readable
    //   - .db.bak removed
    //
    // Note: this test asserts post-cleanup state. The pre-flight `.boot.bak`
    // write itself is covered by `persist_boot_bak_writes_when_snapshot_some`
    // (the helper unit tests).
    #[test]
    fn convert_to_password_writes_boot_bak_before_conversion() {
        let dir = TempDir::new().unwrap();
        let (db_path, boot_path) = make_plain_db_with_sample_data(&dir);

        // Pre-write a boot file with mode=unset so boot_snapshot.is_some() and
        // .boot.bak gets written.
        boot_file::save(
            &BootFile {
                mode: EncryptionMode::Unset,
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                kek_salt: None,
                wrapped_key: None,
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
        let original_boot_bytes = std::fs::read(&boot_path).unwrap();

        // Failpoint: pre-create .enc as a directory so ATTACH DATABASE fails.
        let enc_path = db_path.with_extension("db.enc");
        std::fs::create_dir_all(&enc_path).unwrap();

        let conn = rusqlite::Connection::open(&db_path).unwrap();
        let result = convert_to_password(conn, &db_path, &boot_path, "test-password-123");

        assert!(
            result.is_err(),
            "conversion must fail when ATTACH fails (directory at .enc path)"
        );

        // Post-cleanup assertions:

        // .boot.bak must be removed by cleanup (rename_done=false path).
        let boot_bak = boot_path.with_extension("boot.bak");
        assert!(
            !boot_bak.exists(),
            ".boot.bak must be cleaned up after failed conversion (pre-rename failure)"
        );

        // .db.bak must also be removed by cleanup.
        let db_bak = db_path.with_extension("db.bak");
        assert!(
            !db_bak.exists(),
            ".db.bak must be cleaned up after failed conversion"
        );

        // Original boot file must be unchanged.
        let current_boot_bytes = std::fs::read(&boot_path).unwrap();
        assert_eq!(
            current_boot_bytes, original_boot_bytes,
            "boot file must be unchanged after failed conversion (pre-rename failure)"
        );

        // Original plain DB must still be readable.
        let plain = rusqlite::Connection::open(&db_path).unwrap();
        let count: i64 = plain
            .query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))
            .expect("original DB must still be readable after failed conversion");
        assert_eq!(count, 2, "original data must be intact");
    }

    // ─── Test 15 — recover_from_interrupted_conversion uses persisted .boot.bak
    //
    // Validates the end-to-end repair flow for the critical bug scenario:
    // crash AFTER boot_file::save succeeded (new boot written) but BEFORE
    // .db.bak was cleaned up. At that moment the on-disk state is:
    //   memlore.db     — new state (SQLCipher-encrypted, conversion succeeded)
    //   memlore.db.bak — old state (plain bytes, not yet deleted)
    //   memlore.db.boot — NEW boot (mode=password, just saved)
    //   memlore.db.boot.bak — OLD boot snapshot (mode=unset, pre-conversion)
    //
    // recover_from_interrupted_conversion must detect the .bak, restore both
    // the DB and the boot file from their respective .bak files, and leave no
    // artifacts behind.
    #[test]
    fn recover_actually_uses_persisted_boot_bak() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = dir.path().join("memlore.db.boot");

        // ── Set up the 4-file crash state ────────────────────────────────────

        // The "new" DB (post-conversion encrypted bytes) — distinguishable bytes.
        std::fs::write(&db_path, b"NEW_ENCRYPTED_DB_CONTENTS").unwrap();

        // The "old" DB backup (pre-conversion plain) — distinguishable bytes.
        let bak_path = db_path.with_extension("db.bak");
        std::fs::write(&bak_path, b"OLD_PLAIN_DB_CONTENTS").unwrap();

        // The "new" boot file (mode=password, written by the now-crashed process).
        boot_file::save(
            &BootFile {
                mode: EncryptionMode::Password,
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                kek_salt: Some("aabbccddeeff0011".to_owned()),
                wrapped_key: Some("00112233445566778899aabbccddeeff".to_owned()),
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

        // The "old" boot snapshot (mode=unset, pre-conversion — no key material).
        let boot_bak_path = boot_path.with_extension("boot.bak");
        boot_file::save(
            &BootFile {
                mode: EncryptionMode::Unset,
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                kek_salt: None,
                wrapped_key: None,
                os_kek_wrapped_master: None,
                recovery_wrapped: None,
                wrapped_content_list: None,
                wrapped_db_key: None,
                master_wrapped_db_key: None,
                migration_in_progress: None,
            },
            &boot_bak_path,
        )
        .unwrap();

        // ── Run recovery ─────────────────────────────────────────────────────

        let action = recover_from_interrupted_conversion(&db_path, &boot_path)
            .expect("recover must not return Err");

        assert_eq!(
            action,
            RecoveryAction::RestoredFromBak,
            "recovery must choose RestoredFromBak when .db.bak exists"
        );

        // ── Post-recovery assertions ──────────────────────────────────────────

        // .db must contain the old (pre-conversion) content restored from .bak.
        let db_contents = std::fs::read(&db_path).unwrap();
        assert_eq!(
            db_contents, b"OLD_PLAIN_DB_CONTENTS",
            ".db must be restored from .db.bak"
        );

        // .db.bak must no longer exist (consumed by rename).
        assert!(!bak_path.exists(), ".db.bak must be removed after recovery");

        // .boot must contain the old boot (mode=unset, no key material).
        let restored_boot = boot_file::load(&boot_path).expect("boot file must be readable");
        assert_eq!(
            restored_boot.mode,
            EncryptionMode::Unset,
            "boot file must be restored to pre-conversion mode=unset"
        );
        assert!(
            restored_boot.kek_salt.is_none(),
            "restored boot file must have no kek_salt"
        );
        assert!(
            restored_boot.wrapped_key.is_none(),
            "restored boot file must have no wrapped_key"
        );

        // .boot.bak must no longer exist (consumed by rename).
        assert!(
            !boot_bak_path.exists(),
            ".boot.bak must be removed after recovery"
        );
    }

    // ─── Helper tests: persist_boot_bak ──────────────────────────────────────

    // Test 16 — persist_boot_bak writes the snapshot when Some.
    #[test]
    fn persist_boot_bak_writes_when_snapshot_some() {
        let dir = TempDir::new().unwrap();
        let boot_path = dir.path().join("memlore.db.boot");
        let expected_bak = boot_bak_path(&boot_path);

        let snapshot = Some(b"abc".to_vec());
        persist_boot_bak(&boot_path, &snapshot).expect("persist_boot_bak must succeed");

        assert!(expected_bak.exists(), ".boot.bak must exist after write");
        let written = std::fs::read(&expected_bak).unwrap();
        assert_eq!(written, b"abc", ".boot.bak must contain the snapshot bytes");
    }

    // Test 17 — persist_boot_bak is a no-op when None.
    #[test]
    fn persist_boot_bak_noop_when_snapshot_none() {
        let dir = TempDir::new().unwrap();
        let boot_path = dir.path().join("memlore.db.boot");
        let expected_bak = boot_bak_path(&boot_path);

        persist_boot_bak(&boot_path, &None).expect("persist_boot_bak must succeed for None");

        assert!(
            !expected_bak.exists(),
            ".boot.bak must NOT be created when snapshot is None"
        );
    }

    // Test 18 — persist_boot_bak returns Err when the write target is a directory.
    #[test]
    fn persist_boot_bak_returns_err_when_write_fails() {
        let dir = TempDir::new().unwrap();
        let boot_path = dir.path().join("memlore.db.boot");
        // Pre-create the .boot.bak path as a directory so std::fs::write fails.
        let bak_path = boot_bak_path(&boot_path);
        std::fs::create_dir_all(&bak_path).unwrap();

        let snapshot = Some(b"should fail".to_vec());
        let result = persist_boot_bak(&boot_path, &snapshot);

        assert!(
            result.is_err(),
            "persist_boot_bak must return Err when write fails"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains(".boot.bak"),
            "error must mention .boot.bak, got: {err}"
        );
    }

    // ─── Test 19 — I1 fix: recovery deletes stale boot when no .boot.bak ─────
    //
    // Simulates the crash scenario described in finding I1:
    //   - convert_to_* ran with NO pre-existing boot file (boot_snapshot=None)
    //   - Process crashed between boot_file::save(new_boot) and .db.bak cleanup
    //   On-disk state:
    //     .db     — new (converted)
    //     .db.bak — old bytes (not yet deleted)
    //     .boot   — new mode (just saved)
    //     .boot.bak — ABSENT (was never created because snapshot was None)
    //
    // Recovery must: restore .db from .bak AND delete the stale .boot file.
    #[test]
    fn recover_deletes_stale_boot_when_no_boot_bak_exists() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("memlore.db");
        let boot_path = dir.path().join("memlore.db.boot");
        let bak_path = db_path.with_extension("db.bak");

        // .db contains new (converted) bytes.
        std::fs::write(&db_path, b"NEW_CONVERTED_CONTENTS").unwrap();
        // .db.bak contains old (pre-conversion) bytes.
        std::fs::write(&bak_path, b"OLD_ORIGINAL_CONTENTS").unwrap();
        // .boot contains the new mode (written by the crashed process). The
        // exact mode/wrap contents don't matter for this test — it's discarded
        // wholesale (the file is deleted, not parsed) since .boot.bak is
        // absent. A wrapped_key value is still required to satisfy save()'s
        // "at least one unlock method" invariant.
        boot_file::save(
            &BootFile {
                mode: EncryptionMode::Password,
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                kek_salt: None,
                wrapped_key: Some("stale-crashed-process-boot".to_owned()),
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
        // .boot.bak is ABSENT (boot_snapshot was None — no pre-conversion boot).
        assert!(
            !boot_bak_path(&boot_path).exists(),
            ".boot.bak must not exist before recovery"
        );

        let action = recover_from_interrupted_conversion(&db_path, &boot_path)
            .expect("recover must not return Err");
        assert_eq!(
            action,
            RecoveryAction::RestoredFromBak,
            "recovery must choose RestoredFromBak when .db.bak exists"
        );

        // .db must contain the old (pre-conversion) content restored from .bak.
        let db_contents = std::fs::read(&db_path).unwrap();
        assert_eq!(
            db_contents, b"OLD_ORIGINAL_CONTENTS",
            ".db must be restored from .db.bak"
        );

        // .db.bak must no longer exist (consumed by rename).
        assert!(!bak_path.exists(), ".db.bak must be removed after recovery");

        // Boot file must be ABSENT — restored to the pre-conversion state where
        // no boot file existed.
        assert!(
            !boot_path.exists(),
            "boot file must be deleted when .boot.bak was absent (pre-conversion had no boot)"
        );

        // .boot.bak must not exist (it never did).
        assert!(
            !boot_bak_path(&boot_path).exists(),
            ".boot.bak must not exist after recovery"
        );
    }

    // ─── Test 21 — convert_to_password writes password settings in target ──────
    //
    // Verify that after conversion, the resulting encrypted DB has:
    //   - encryption_mode = 'password'
    //   - password_hash, wrapped_encryption_key, kek_salt all present and non-empty
    //   - wrapped_encryption_key and kek_salt match the boot file
    //
    // The source DB has only encryption_mode=unset (seeded by helper). After
    // sqlcipher_export + atomic settings write, the encrypted file must have
    // all four password-mode settings before the rename swap.
    #[test]
    fn convert_to_password_writes_password_settings_in_target() {
        use crate::utils::encryption::{derive_sqlcipher_key, unwrap_key, KEY_SIZE};

        let dir = TempDir::new().unwrap();
        let (db_path, boot_path) = make_plain_db_with_sample_data(&dir);

        let conn = rusqlite::Connection::open(&db_path).unwrap();
        convert_to_password(conn, &db_path, &boot_path, "t3st-p@ssw0rd99!")
            .expect("conversion must succeed");

        // Derive the SQLCipher key to open the result.
        let boot = boot_file::load(&boot_path).expect("boot file must be readable");
        let kek_salt_hex = boot.kek_salt.expect("boot must have kek_salt");
        let wrapped_hex = boot.wrapped_key.expect("boot must have wrapped_key");
        let kek_salt_bytes = hex::decode(&kek_salt_hex).expect("kek_salt must be valid hex");
        let master: zeroize::Zeroizing<[u8; KEY_SIZE]> =
            unwrap_key(&wrapped_hex, "t3st-p@ssw0rd99!", &kek_salt_bytes)
                .expect("unwrap_key must succeed");
        let sqlcipher_key = derive_sqlcipher_key(&*master);
        let key_hex = hex::encode(&*sqlcipher_key);

        let enc_conn = rusqlite::Connection::open(&db_path).unwrap();
        enc_conn
            .execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))
            .expect("PRAGMA key must succeed");

        // encryption_mode must be 'password'.
        let enc_mode: Option<String> = enc_conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'encryption_mode'",
                [],
                |r| r.get(0),
            )
            .optional()
            .expect("settings query must not fail");
        assert_eq!(
            enc_mode.as_deref(),
            Some("password"),
            "encryption_mode must be 'password' in converted encrypted DB"
        );

        // All four key-material rows must be present and non-empty.
        for present_key in &["password_hash", "wrapped_encryption_key", "kek_salt"] {
            let value: Option<String> = enc_conn
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    rusqlite::params![present_key],
                    |r| r.get(0),
                )
                .optional()
                .expect("settings query must not fail");
            assert!(
                value.is_some() && !value.as_deref().unwrap_or("").is_empty(),
                "settings key '{present_key}' must be present and non-empty"
            );
        }

        // wrapped_encryption_key and kek_salt must match the boot file values.
        let db_wrapped: String = enc_conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'wrapped_encryption_key'",
                [],
                |r| r.get(0),
            )
            .expect("wrapped_encryption_key must exist");
        assert_eq!(
            db_wrapped, wrapped_hex,
            "settings wrapped_key must match boot file"
        );

        let db_kek_salt: String = enc_conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'kek_salt'",
                [],
                |r| r.get(0),
            )
            .expect("kek_salt must exist");
        assert_eq!(
            db_kek_salt, kek_salt_hex,
            "settings kek_salt must match boot file"
        );
    }

    // ─── Test 22 — convert_to_password_with_recovery persists recovery slot ────
    //
    // The recovery-aware Lock Journal conversion must:
    //   - use the CALLER-SUPPLIED master key (so the recovery slot still wraps it)
    //   - write recovery_wrapped_master + cloud_master_fingerprint into the
    //     encrypted target DB
    //   - write recovery_wrapped into the boot file
    //   - purge any leftover pending_first_time_setup rows from the target
    #[test]
    fn convert_to_password_with_recovery_persists_recovery_slot_and_fingerprint() {
        use crate::utils::encryption::{
            decrypt_data, derive_sqlcipher_key, encrypt_data, key_fingerprint, unwrap_key, KEY_SIZE,
        };
        use crate::utils::recovery::{
            derive_recovery_key, generate_recovery_mnemonic, validate_recovery_mnemonic,
        };

        let dir = TempDir::new().unwrap();
        let (db_path, boot_path) = make_plain_db_with_sample_data(&dir);

        // Build the caller-supplied tuple of key material for the conversion.
        let master_key: zeroize::Zeroizing<[u8; KEY_SIZE]> = zeroize::Zeroizing::new([42u8; 32]);
        let mnemonic = generate_recovery_mnemonic().unwrap();
        let parsed = validate_recovery_mnemonic(&mnemonic).unwrap();
        let recovery_key = derive_recovery_key(&parsed);
        let recovery_wrapped_hex =
            hex::encode(encrypt_data(&recovery_key, master_key.as_ref()).unwrap());
        let master_fingerprint = hex::encode(key_fingerprint(&master_key));

        let conn = rusqlite::Connection::open(&db_path).unwrap();
        convert_to_password_with_recovery(
            conn,
            &db_path,
            &boot_path,
            "t3st-p@ssw0rd99!",
            master_key.clone(),
            recovery_wrapped_hex.clone(),
            master_fingerprint.clone(),
        )
        .expect("recovery-aware conversion must succeed");

        // Boot file must carry the recovery slot.
        let boot = boot_file::load(&boot_path).unwrap();
        assert_eq!(
            boot.recovery_wrapped.as_deref(),
            Some(recovery_wrapped_hex.as_str()),
            "boot file must store the recovery slot"
        );

        // Open the encrypted DB with the SUPPLIED master key — proves the
        // conversion used it (not a freshly generated one).
        let kek_salt_bytes = hex::decode(boot.kek_salt.unwrap()).unwrap();
        let unwrapped = unwrap_key(
            boot.wrapped_key.as_deref().unwrap(),
            "t3st-p@ssw0rd99!",
            &kek_salt_bytes,
        )
        .expect("wrapped_key must unwrap with the password");
        assert_eq!(
            &*unwrapped, &*master_key,
            "conversion must encrypt under the caller-supplied master key"
        );
        let key_hex = hex::encode(&*derive_sqlcipher_key(&*master_key));
        let enc = rusqlite::Connection::open(&db_path).unwrap();
        enc.execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))
            .expect("opening with the supplied master key must succeed");

        // DB must hold recovery_wrapped_master + cloud_master_fingerprint.
        let db_recovery: String = enc
            .query_row(
                "SELECT value FROM settings WHERE key = 'recovery_wrapped_master'",
                [],
                |r| r.get(0),
            )
            .expect("recovery_wrapped_master must be in the encrypted DB");
        assert_eq!(db_recovery, recovery_wrapped_hex);
        let db_fp: String = enc
            .query_row(
                "SELECT value FROM settings WHERE key = 'cloud_master_fingerprint'",
                [],
                |r| r.get(0),
            )
            .expect("cloud_master_fingerprint must be in the encrypted DB");
        assert_eq!(db_fp, master_fingerprint);

        // The recovery slot must actually unwrap to the master key.
        let recovered = decrypt_data(&recovery_key, &hex::decode(&db_recovery).unwrap()).unwrap();
        assert_eq!(recovered.as_slice(), &*master_key);
    }
}
