//! Biometric unlock via the macOS Keychain — backed by the `UnlockKek`
//! (os_kek) abstraction.
//!
//! **Phase 3 change:** the Keychain item no longer holds the raw vault
//! master. It holds a random 32-byte `os_kek` — a KEK that *wraps* the
//! master. The wrap itself (`os_kek_wrapped_master`) lives in the plaintext
//! boot file sidecar (`utils::boot_file`), peer to the password wrap
//! (`wrapped_key`). This means the boot file stays useless without either
//! the password or the OS keystore — a stolen powered-off device with only
//! os_kek enabled yields nothing (see docs/how-sync-and-encryption-work.md §1.8 B). Enabling
//! biometric unlock retrieving that item triggers the OS Touch ID prompt and
//! unwraps the master directly into the in-memory `EncryptionKeyState` —
//! skipping the password-entry step.
//!
//! ## Platform gating
//!
//! The full flow is macOS-only. On other targets:
//! * `is_biometric_available` / `is_os_kek_available` return `false` cleanly.
//! * `is_biometric_unlock_enabled` reads the setting but is meaningful only
//!   when combined with a real Keychain.
//! * `enable_biometric_unlock`, `unlock_with_biometric`, and
//!   `disable_biometric_unlock` return an explicit "not supported" error so
//!   the frontend can render the right state without panicking.
//! * `generate_os_kek` / `get_os_kek` return `OsKekError::Unavailable`.
//!
//! TODO(later): Windows Hello (DPAPI / KeyCredentialManager) + Linux Secret
//! Service (libsecret) — see docs/LATER.md.
//!
//! ## Password-change interaction
//!
//! os_kek wraps the *master*, which is unchanged by a password change, so an
//! existing `os_kek_wrapped_master` stays cryptographically valid across one.
//! We invalidate it anyway (drop the wrap, flip the setting off) to match the
//! pre-Phase-3 policy of forcing re-enrollment of convenience unlock after a
//! password change — this is a deliberate conservative choice, not a
//! correctness requirement. Password remains the guaranteed fallback
//! (`wrapped_key` is always rewritten by `change_password`), so this is never
//! a lockout. The caller (see `commands::crypto::change_password`) MUST
//! invalidate the Keychain item + boot-file wrap on password change.
//!
//! The invalidation is exposed as two crate-internal helpers
//! (`clear_biometric_setting`, `wipe_biometric_keychain`) rather than a
//! single combined call — callers that already hold the DB lock can flip the
//! setting under the lock and defer the (potentially slow) Keychain wipe
//! outside the critical section.

use tauri::State;
use zeroize::Zeroizing;

use crate::db;
use crate::utils::boot_file::{self, BootFile, UnlockMethod};
use crate::utils::encryption::{unwrap_content_key, wrap_content_key};
use crate::AppState;
use crate::EncryptionKeyState;

pub const KEYCHAIN_SERVICE: &str = "com.memlore.encryption-key";
/// Account for the biometric-protected convenience Keychain item (Touch ID ACL).
/// Only present in password-locked mode when the user opts in to biometric unlock.
pub const KEYCHAIN_ACCOUNT: &str = "default";
pub const BIOMETRIC_ENABLED_SETTING: &str = "biometric_unlock_enabled";

/// Returns whether biometric unlock is available on this platform at all.
///
/// This is a coarse check: `true` on macOS (actual Touch ID hardware /
/// enrollment is verified lazily by the OS when the Keychain item is accessed),
/// `false` everywhere else. The call must never panic — callers include
/// settings screens that render on every platform.
#[tauri::command]
pub fn is_biometric_available() -> Result<bool, String> {
    Ok(cfg!(target_os = "macos"))
}

/// Distinguishes *why* an os_kek operation failed, so callers can choose the
/// right response: `Unavailable` (never attempt — platform has no backend,
/// fall back to password silently), `NotFound` (was available, item is now
/// gone — self-heal: disable the setting and tell the user to use their
/// password), `Other` (surface the message; may be transient).
#[derive(Debug)]
pub(crate) enum OsKekError {
    // Only constructed on non-macOS builds (`#[cfg(not(target_os = "macos"))]`
    // arms below) — a macOS-only build never reaches those arms, so this
    // variant is legitimately unconstructed there, not dead code.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unavailable,
    NotFound,
    Other(String),
}

impl std::fmt::Display for OsKekError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OsKekError::Unavailable => write!(f, "os_kek is not available on this platform"),
            OsKekError::NotFound => write!(f, "os_kek item not found in the OS keystore"),
            OsKekError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

/// Whether this platform can provide an os_kek backend at all. Coarse check
/// like `is_biometric_available` — real hardware/enrollment is verified
/// lazily by the OS when the item is actually accessed.
pub(crate) fn is_os_kek_available() -> bool {
    cfg!(target_os = "macos")
}

/// Generate a fresh random 32-byte os_kek and store it in the OS keystore
/// under the same Touch-ID ACL previously used for the raw master. Returns
/// the generated bytes so the caller can immediately wrap the master under
/// it — persisting that wrap (`os_kek_wrapped_master`) into the boot file is
/// the caller's responsibility, not this function's.
///
/// Overwrites any existing os_kek item (see `platform::store`).
pub(crate) fn generate_os_kek() -> Result<Zeroizing<[u8; 32]>, OsKekError> {
    #[cfg(target_os = "macos")]
    {
        use rand::RngCore;
        let mut bytes = Zeroizing::new([0u8; 32]);
        rand::rngs::OsRng.fill_bytes(bytes.as_mut());
        platform::store(&bytes).map_err(OsKekError::Other)?;
        Ok(bytes)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(OsKekError::Unavailable)
    }
}

/// Retrieve the existing os_kek from the OS keystore. Triggers the OS
/// biometric prompt (Touch ID on macOS).
pub(crate) fn get_os_kek() -> Result<Zeroizing<[u8; 32]>, OsKekError> {
    #[cfg(target_os = "macos")]
    {
        match platform::retrieve() {
            Ok(bytes) => {
                if bytes.len() != 32 {
                    return Err(OsKekError::Other(
                        "os_kek item has unexpected size".to_string(),
                    ));
                }
                let mut arr = Zeroizing::new([0u8; 32]);
                arr.copy_from_slice(&bytes);
                Ok(arr)
            }
            Err(platform::RetrieveError::NotFound) => Err(OsKekError::NotFound),
            Err(platform::RetrieveError::Other(msg)) => Err(OsKekError::Other(msg)),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(OsKekError::Unavailable)
    }
}

/// Remove the os_kek from the OS keystore. Idempotent — a missing item is
/// not an error. No-op on non-macOS.
pub(crate) fn remove_os_kek() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        platform::remove()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Read whether the user has enabled biometric unlock.
/// Returns `false` if the setting is missing or the stored value is anything
/// other than the literal string `"true"`.
#[tauri::command]
pub fn is_biometric_unlock_enabled(state: State<'_, AppState>) -> Result<bool, String> {
    let conn = state.lock()?;
    read_biometric_enabled(&conn)
}

fn read_biometric_enabled(conn: &rusqlite::Connection) -> Result<bool, String> {
    match db::get_setting(conn, BIOMETRIC_ENABLED_SETTING).map_err(|e| e.to_string())? {
        Some(v) => Ok(v == "true"),
        None => Ok(false),
    }
}

fn write_biometric_enabled(conn: &rusqlite::Connection, enabled: bool) -> Result<(), String> {
    db::set_setting(
        conn,
        BIOMETRIC_ENABLED_SETTING,
        if enabled { "true" } else { "false" },
    )
    .map_err(|e| e.to_string())
}

/// Enable biometric unlock: generate an os_kek, wrap the current in-memory
/// master key under it, persist the wrap into the boot file, store the
/// os_kek itself in a Touch-ID-protected Keychain item, and flip the setting.
///
/// Requires:
/// - The app is in **password mode** with a boot file already written (biometric
///   layers on top of the always-present password unlock — Phase 3 setup does
///   not yet offer choosing os_kek at setup time from this command; that is
///   the picker UI, a later phase). This means `wrapped_key` is always present,
///   so enabling os_kek here always yields `unlock_method = Both`, never a
///   pure os_kek-only boot file.
/// - The app is currently unlocked (master must be present in state).
///
/// **Transactional contract:** every step (os_kek generation → wrap → boot
/// file write → setting flip) is rolled back on the first failure, so a
/// partial enable never leaves a stranded Keychain item, a boot file that
/// disagrees with the setting, or a setting that disagrees with the boot
/// file. "Keychain item + os_kek_wrapped_master present" ⇔ "setting is true".
#[tauri::command]
pub fn enable_biometric_unlock(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        // Guard: biometric requires encryption to be set up. In the
        // password-only model this is a first-launch completion check.
        {
            let conn = state.lock()?;
            let mode = db::get_encryption_mode(&conn).map_err(|e| e.to_string())?;
            if mode != db::EncryptionMode::Password {
                return Err("Biometric unlock requires encryption to be enabled. \
                     Complete first-launch password setup first."
                    .to_string());
            }
        }

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("enable_biometric_unlock: failed to resolve app data dir: {e}"))?;
        let boot_path = boot_file::boot_path(&data_dir.join("memlore.db"));
        let existing_boot = boot_file::load(&boot_path)?;
        if existing_boot.mode != db::EncryptionMode::Password {
            return Err("Biometric unlock requires a boot file already written by \
                 first-launch password setup."
                .to_string());
        }

        // Generate a fresh os_kek and wrap the current master under it.
        let os_kek = generate_os_kek().map_err(|e| e.to_string())?;
        let wrap_result =
            key_state.with_master(|master| wrap_content_key(&os_kek, master).map(hex::encode));
        let wrapped_master_hex = match wrap_result {
            Ok(hex) => hex,
            Err(e) => {
                let _ = remove_os_kek();
                return Err(e);
            }
        };

        // Password unlock is always present at this point (guarded above),
        // so enabling os_kek always yields Both, never a pure os_kek-only file.
        let updated_boot = BootFile {
            unlock_method: UnlockMethod::Both,
            os_kek_wrapped_master: Some(wrapped_master_hex),
            ..existing_boot.clone()
        };
        if let Err(e) = boot_file::save(&updated_boot, &boot_path) {
            let _ = remove_os_kek();
            return Err(format!(
                "enable_biometric_unlock: failed to update boot file: {e}"
            ));
        }

        let conn = state.lock()?;
        if let Err(e) = write_biometric_enabled(&conn, true) {
            // Roll back the os_kek AND the boot file — a stranded os_kek with
            // enabled=false would be an invisible secret the user can't
            // manage from Settings; a boot file claiming Both with no
            // matching setting would confuse the next unlock's UI hints.
            let _ = remove_os_kek();
            if let Err(restore_err) = boot_file::save(&existing_boot, &boot_path) {
                log::warn!(
                    "enable_biometric_unlock: setting write failed AND boot file \
                     rollback failed — boot file may be inconsistent. setting_err={e} \
                     rollback_err={restore_err}"
                );
            }
            return Err(e);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, key_state);
        Err("Biometric unlock is only supported on macOS".to_string())
    }
}

/// Disable biometric unlock: remove the Keychain item, clear
/// `os_kek_wrapped_master` from the boot file (reverting `unlock_method` to
/// `Password`, which remains valid since `wrapped_key` is untouched), and
/// clear the setting. Idempotent — a missing Keychain item or boot file field
/// is not an error.
#[tauri::command]
pub fn disable_biometric_unlock(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        // ORDER MATTERS: update the boot file FIRST, remove the Keychain item
        // second. The reverse order is a latent brick — on a device whose only
        // unlock method is os_kek, `save()` correctly refuses to write a boot
        // file with zero unlock methods, but by then the os_kek would already
        // be destroyed, leaving a boot file claiming OsKek with nothing behind
        // it. Doing the refusable step first means a refusal costs nothing.
        // Such devices are not producible today (setup always keeps a password
        // wrap), but this must not depend on that invariant holding forever.
        if let Ok(data_dir) = app.path().app_data_dir() {
            let boot_path = boot_file::boot_path(&data_dir.join("memlore.db"));
            if let Ok(boot) = boot_file::load(&boot_path) {
                if boot.mode == db::EncryptionMode::Password && boot.os_kek_wrapped_master.is_some()
                {
                    let updated = BootFile {
                        unlock_method: UnlockMethod::Password,
                        os_kek_wrapped_master: None,
                        ..boot
                    };
                    // Refusing here means the device would be left with no way
                    // in. Abort without touching the Keychain — the user keeps
                    // working biometric unlock, which beats a bricked vault.
                    boot_file::save(&updated, &boot_path).map_err(|e| {
                        format!(
                            "disable_biometric_unlock: refusing to remove the OS key because                              the boot file could not be updated ({e}); biometric unlock is                              left enabled"
                        )
                    })?;
                }
            }
        }

        remove_os_kek()?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    let conn = state.lock()?;
    write_biometric_enabled(&conn, false)
}

/// Persist `biometric_unlock_enabled` so the DB setting matches a boot file's
/// `unlock_method`.
///
/// Setup (`confirm_first_time_setup`) and join (`onboard_complete`) resolve
/// their unlock method themselves — they generate the os_kek and write the
/// wrap into the boot file without ever going through
/// `enable_biometric_unlock`, which is the setting's only other writer. Without
/// this call the os_kek item exists in the Keychain wrapping the master while
/// every management surface (`is_biometric_unlock_enabled`, the lock screen's
/// Touch ID button, Settings) reports it absent — an invisible, unmanageable
/// secret, and a durable one: `restore_biometric_keychain_after_rotation`
/// early-returns when the setting is false, so a later rotation leaves the
/// orphan wrapping a superseded master.
///
/// Any method carrying an os_kek wrap (`Both`, `OsKek`) means enabled;
/// `Password` means disabled — written explicitly rather than left absent so
/// the setting always states the resolved outcome.
pub(crate) fn sync_biometric_setting_for_unlock_method(
    conn: &rusqlite::Connection,
    method: UnlockMethod,
) -> Result<(), String> {
    write_biometric_enabled(
        conn,
        matches!(method, UnlockMethod::Both | UnlockMethod::OsKek),
    )
}

/// Flip the `biometric_unlock_enabled` setting to `false`. Crate-internal:
/// only `commands::crypto::change_password` / `remove_password` should call
/// this, to mirror the Keychain wipe. Pair with `wipe_biometric_keychain`.
pub(crate) fn clear_biometric_setting(conn: &rusqlite::Connection) -> Result<(), String> {
    write_biometric_enabled(conn, false)
}

/// Re-wrap the NEW master key under the existing os_kek after a key rotation,
/// updating the boot file's `os_kek_wrapped_master` in place.
///
/// Rotation mints a brand-new random master; `commit_local_inner`
/// (`sync/rotation/commit.rs`) already drops the (now-stale) os_kek wrap from
/// the boot file it writes and downgrades `unlock_method` to `Password`, so
/// there is never a window where the boot file's os_kek wrap points at a
/// dead master. This function re-establishes convenience unlock on top of
/// that safe baseline: the os_kek itself is untouched (it is independent of
/// the master), only its wrap of the master needs updating.
///
/// On failure it wipes the os_kek Keychain entry and clears the biometric
/// setting so the UI falls back to password unlock gracefully (password is
/// unaffected by rotation's master change, so this is never a lockout).
///
/// No-op on non-macOS or when biometric is not enabled.
pub(crate) fn restore_biometric_keychain_after_rotation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &crate::AppState,
    key_state: &crate::EncryptionKeyState,
) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        // Read the setting without holding the lock during the (slow) Keychain call.
        let enabled = match state.lock() {
            Ok(conn) => read_biometric_enabled(&conn).unwrap_or(false),
            Err(_) => return,
        };
        if !enabled {
            return;
        }

        let result: Result<(), String> = (|| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
            let boot_path = boot_file::boot_path(&data_dir.join("memlore.db"));
            let boot = boot_file::load(&boot_path)?;
            if boot.mode != db::EncryptionMode::Password {
                return Err("boot file is not in password mode".to_string());
            }

            // Reuse the existing os_kek — it wraps the master, not the other
            // way around, so rotation does not invalidate the os_kek itself.
            // Retrieving it triggers Touch ID.
            let os_kek = get_os_kek().map_err(|e| e.to_string())?;
            let wrapped_master_hex = key_state
                .with_master(|master| wrap_content_key(&os_kek, master).map(hex::encode))?;

            let updated_boot = BootFile {
                unlock_method: if boot.wrapped_key.is_some() {
                    UnlockMethod::Both
                } else {
                    UnlockMethod::OsKek
                },
                os_kek_wrapped_master: Some(wrapped_master_hex),
                ..boot
            };
            boot_file::save(&updated_boot, &boot_path)
        })();

        match result {
            Ok(()) => {
                log::info!(
                    "restore_biometric_keychain_after_rotation: os_kek wrap of new master updated"
                );
            }
            Err(e) => {
                // Fallback: wipe stale entry + disable setting so Touch ID doesn't
                // silently use the wrong key. The user will need to re-enable it.
                log::warn!(
                    "restore_biometric_keychain_after_rotation: re-wrap failed ({e}); \
                     wiping stale entry and disabling biometric"
                );
                // Also clear the boot file's os_kek wrap. It is the plaintext,
                // lock-time-readable signal `startup_init` uses to seed the
                // locked placeholder's `biometric_unlock_enabled`. Leaving a
                // stale `os_kek_wrapped_master` here would resurface a dead
                // Touch ID button on every launch (the button shows, the press
                // fails `get_os_kek`, and the only self-heal writes to the
                // discarded placeholder). Mirrors `disable_biometric_unlock`.
                // Best-effort: this whole branch is already a degraded path, and
                // `wrapped_key` is always present on these devices, so dropping
                // the os_kek wrap can never produce a zero-unlock-method file.
                if let Ok(data_dir) = app.path().app_data_dir() {
                    let boot_path = boot_file::boot_path(&data_dir.join("memlore.db"));
                    if let Ok(boot) = boot_file::load(&boot_path) {
                        if boot.mode == db::EncryptionMode::Password
                            && boot.os_kek_wrapped_master.is_some()
                        {
                            let updated = BootFile {
                                unlock_method: UnlockMethod::Password,
                                os_kek_wrapped_master: None,
                                ..boot
                            };
                            let _ = boot_file::save(&updated, &boot_path);
                        }
                    }
                }
                let _ = wipe_biometric_keychain();
                if let Ok(conn) = state.lock() {
                    let _ = clear_biometric_setting(&conn);
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, key_state);
    }
}

/// Wipe the os_kek Keychain item — no DB access, safe to call without
/// holding the app mutex. On non-macOS this is a no-op. Idempotent: a
/// missing item is not an error. Thin alias over `remove_os_kek` kept under
/// its historical name because `commands::crypto` (change_password,
/// recover_with_passphrase) already calls it paired with
/// `clear_biometric_setting`.
pub(crate) fn wipe_biometric_keychain() -> Result<(), String> {
    remove_os_kek()
}

/// Retrieve the os_kek via the Keychain (which triggers Touch ID), unwrap the
/// master from the boot file's `os_kek_wrapped_master`, and load it into the
/// in-memory state. On success the app is unlocked.
///
/// **Self-healing:** if the setting says "enabled" but the os_kek Keychain
/// item is missing (OS reinstall, manual deletion, or biometry-set
/// invalidation after a fingerprint enroll change) — or the boot file has no
/// `os_kek_wrapped_master` at all (e.g. a device that never actually wrote
/// one, or one that was cleared by a password change) — we flip the setting
/// to `false` so the UI stops offering a broken Touch ID button. Every
/// self-heal path here leaves password unlock untouched (`wrapped_key` is
/// never modified by this function), so this can never be the failure mode
/// that dead-ends a user: it always degrades to "use your password."
///
/// Errors surface as user-friendly strings so the frontend can fall back to
/// password entry without leaking low-level OSStatus codes.
#[tauri::command]
pub fn unlock_with_biometric(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Emitter;
        use tauri::Manager;

        // Read the flag inside a short-lived scope so the DB lock is dropped
        // before the (potentially long, blocking) Touch ID prompt.
        let enabled = {
            let conn = state.lock()?;
            read_biometric_enabled(&conn)?
        };
        if !enabled {
            return Err("Biometric unlock is not enabled".to_string());
        }

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("biometric: failed to resolve app data dir: {e}"))?;
        let db_path = data_dir.join("memlore.db");
        let boot_path = boot_file::boot_path(&db_path);
        // A load() failure means the boot file exists but is invalid. This is
        // still safe to self-heal the same way as a missing os_kek wrap below
        // (password unlock is a separate code path, untouched here), but the
        // error message should say what actually happened rather than the
        // misleading "no wrapped key" — the file is corrupt, not merely bare.
        let boot = match boot_file::load(&boot_path) {
            Ok(b) => b,
            Err(e) => {
                if let Ok(conn) = state.lock() {
                    let _ = write_biometric_enabled(&conn, false);
                }
                return Err(format!(
                    "Boot file is invalid ({e}) — biometric unlock has been disabled. \
                     Unlock with your password and re-enable it in Settings."
                ));
            }
        };

        let os_kek_wrapped_master_hex = match boot.os_kek_wrapped_master.as_deref() {
            Some(hex) => hex,
            None => {
                // Setting says enabled but the boot file has no wrap to unlock
                // with — self-heal so the UI stops offering a broken button.
                if let Ok(conn) = state.lock() {
                    let _ = write_biometric_enabled(&conn, false);
                }
                return Err(
                    "Biometric unlock has no wrapped key on this device — it has been \
                     disabled. Unlock with your password and re-enable it in Settings."
                        .to_string(),
                );
            }
        };

        let os_kek = match get_os_kek() {
            Ok(k) => k,
            Err(OsKekError::NotFound) => {
                // Self-heal: setting said enabled but the os_kek item is gone.
                // Best-effort flip; a failure here doesn't escalate — the
                // user sees the error and can still unlock via password.
                if let Ok(conn) = state.lock() {
                    let _ = write_biometric_enabled(&conn, false);
                }
                return Err(
                    "Biometric key is missing — biometric unlock has been disabled. \
                     Unlock with your password and re-enable it in Settings."
                        .to_string(),
                );
            }
            Err(e) => return Err(e.to_string()),
        };

        let mwm_blob = hex::decode(os_kek_wrapped_master_hex)
            .map_err(|e| format!("biometric: os_kek_wrapped_master hex decode: {e}"))?;
        let master = match unwrap_content_key(&os_kek, &mwm_blob) {
            Ok(m) => m,
            Err(e) => {
                // The os_kek retrieved successfully but doesn't unwrap this
                // boot file's wrap — an inconsistent state (should not
                // normally happen). Self-heal the same way as a missing item:
                // password unlock is untouched, so the user is never stuck.
                if let Ok(conn) = state.lock() {
                    let _ = write_biometric_enabled(&conn, false);
                }
                return Err(format!(
                    "biometric: os_kek could not unwrap the stored master ({e}) — \
                     biometric unlock has been disabled. Unlock with your password \
                     and re-enable it in Settings."
                ));
            }
        };

        // T6: full unlock path from master.
        //
        // Read the boot file to get master_wrapped_db_key + wrapped_content_list.
        // If both are present (Phase 3+ vault): unwrap db_key, open real DB,
        // decode content list, set_content_state, swap real connection.
        // If absent (pre-Phase-3 vault): fall back to set_key(master) — legacy
        // behavior. The DB placeholder swap is not needed in this case because
        // the pre-Phase-3 path opens the DB in `initialize_encryption`.
        {
            let did_full_unlock = if let (Some(mwdk_hex), Some(list_hex)) = (
                boot.master_wrapped_db_key.as_deref(),
                boot.wrapped_content_list.as_deref(),
            ) {
                // Phase 3 path: unwrap db_key via master.
                let mwdk_blob = hex::decode(mwdk_hex)
                    .map_err(|e| format!("biometric: master_wrapped_db_key hex decode: {e}"))?;
                let db_key = crate::utils::encryption::unwrap_content_key(&master, &mwdk_blob)
                    .map_err(|e| format!("biometric: master_wrapped_db_key unwrap failed: {e}"))?;

                // Open the real DB under db_key-derived SQLCipher key.
                let sqlcipher_key = crate::utils::encryption::derive_sqlcipher_key(&*db_key);
                let db_path_str = db_path.to_string_lossy().into_owned();
                let real_conn = crate::db::open_with_key(&db_path_str, &*sqlcipher_key)
                    .map_err(|e| format!("biometric: failed to open encrypted DB: {e}"))?;

                // Decode the content-key list from boot (master-wrapped).
                let content_keys =
                    crate::utils::encryption::decode_content_key_list(&master, list_hex)
                        .map_err(|e| format!("biometric: content-key list decode failed: {e}"))?;
                let latest = *content_keys
                    .keys()
                    .next_back()
                    .ok_or_else(|| "biometric: content-key list is empty".to_string())?;

                // Swap in the real DB connection (replaces :memory: placeholder).
                state.set_connection(real_conn)?;

                // Run AI audit retention purge now that real DB is open.
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                if let Err(e) = state.with_conn(|c| {
                    crate::ai::audit::run_startup_retention_purge(c, now_ms)
                        .map_err(|e| e.to_string())
                }) {
                    log::warn!("biometric: post-unlock retention purge failed: {e}");
                }

                key_state.set_content_state(
                    content_keys,
                    latest,
                    db_key,
                    Zeroizing::new(*master),
                )?;
                true
            } else {
                false
            };

            if !did_full_unlock {
                // Legacy vault (pre-Phase-3): no master_wrapped_db_key.
                // Use the Phase-1 shim: master IS the key. The real DB was
                // already swapped in by initialize_encryption (legacy path),
                // so no connection swap is needed here.
                log::info!("biometric: pre-Phase-3 vault — using set_key shim (no db_key in boot)");
                key_state.set_key(master)?;
            }
        }

        // TODO(crash-window): biometric unlock does not trigger
        // `startup_keyring_reconcile_if_needed` because the plaintext password
        // is not available on this path (the Keychain holds `os_kek`, a wrapping
        // key — never the password, and since Phase 3 never the raw master
        // either). A crash-window mismatch will persist until the user
        // unlocks with their password. Full recovery here would require either
        // storing the password separately — which is a worse security trade-off
        // than the gap itself — or a password re-prompt after biometric unlock,
        // which would destroy the UX benefit of biometrics. Acceptable risk.

        // Emit `app:unlocked` so the AI lock-grace listener cancels its
        // pending swap-to-stub timer (Phase 6 A3b-1a). Best-effort.
        if let Err(e) = app.emit("app:unlocked", ()) {
            log::warn!("emit app:unlocked failed (non-fatal): {e}");
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, key_state);
        Err("Biometric unlock is only supported on macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        AccessControlOptions, PasswordOptions,
    };
    use zeroize::Zeroizing;

    // OSStatus for "item not found" — documented constant from
    // `security_framework_sys::base::errSecItemNotFound`. We avoid adding the
    // sys crate as a direct dependency by hard-coding the stable value.
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    /// Structured retrieve error so callers can distinguish "not found"
    /// (recoverable, self-heal) from everything else (show to user).
    pub enum RetrieveError {
        NotFound,
        Other(String),
    }

    fn access_control() -> Result<SecAccessControl, String> {
        SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            AccessControlOptions::BIOMETRY_CURRENT_SET.bits(),
        )
        .map_err(|e| format!("Failed to create access control: {e}"))
    }

    pub fn store(key: &[u8; 32]) -> Result<(), String> {
        // Drop any existing item first: set_generic_password_options falls
        // back to SecItemUpdate on duplicate, which strips custom attributes
        // like access control. Delete-then-add preserves the biometric
        // binding on re-enable after a password change.
        let _ = remove();

        let mut options =
            PasswordOptions::new_generic_password(super::KEYCHAIN_SERVICE, super::KEYCHAIN_ACCOUNT);
        options.set_access_control(access_control()?);
        options.set_label("Memlore encryption key");
        set_generic_password_options(key, options)
            .map_err(|e| format!("Failed to store key in Keychain: {e}"))
    }

    /// Retrieve the Keychain item. Returns a `Zeroizing<Vec<u8>>` so the
    /// intermediate plaintext buffer is wiped on drop — leaving only the
    /// caller's copy in the final `EncryptionKeyState`.
    pub fn retrieve() -> Result<Zeroizing<Vec<u8>>, RetrieveError> {
        let options =
            PasswordOptions::new_generic_password(super::KEYCHAIN_SERVICE, super::KEYCHAIN_ACCOUNT);
        match generic_password(options) {
            Ok(bytes) => Ok(Zeroizing::new(bytes)),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Err(RetrieveError::NotFound),
            Err(e) => Err(RetrieveError::Other(format!(
                "Biometric unlock failed: {e}"
            ))),
        }
    }

    pub fn remove() -> Result<(), String> {
        let options =
            PasswordOptions::new_generic_password(super::KEYCHAIN_SERVICE, super::KEYCHAIN_ACCOUNT);
        match delete_generic_password_options(options) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(format!("Failed to remove key from Keychain: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use rusqlite::Connection;

    // Real biometric roundtrip tests are intentionally omitted — they'd
    // require a machine with Touch ID enrolled, and fake-keychain shortcuts
    // (tests that skip the biometric access-control flag) would assert
    // nothing the feature actually depends on. We keep only the checks that
    // run meaningfully in CI.

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    // ─── is_biometric_available ──────────────────────────────────────────────

    #[test]
    fn is_biometric_available_does_not_panic() {
        // Contract: the function must be safe to call on any platform.
        let result = is_biometric_available();
        assert!(result.is_ok());
    }

    #[test]
    fn is_biometric_available_matches_target_os() {
        let expected = cfg!(target_os = "macos");
        assert_eq!(is_biometric_available().unwrap(), expected);
    }

    // ─── is_os_kek_available ──────────────────────────────────────────────────

    #[test]
    fn is_os_kek_available_matches_target_os() {
        let expected = cfg!(target_os = "macos");
        assert_eq!(is_os_kek_available(), expected);
    }

    // ─── os_kek CRUD — non-macOS contract only ───────────────────────────────
    //
    // On macOS these functions touch the real Keychain (generate/store,
    // retrieve with a Touch ID prompt, delete) — exactly the class of test
    // the module already omits from CI (see `wipe_biometric_keychain_is_noop_on_non_macos`
    // above). Ignored on macOS for the same reason; the non-macOS contract
    // (always `Unavailable`, never touches anything) is what's under test.

    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "Touches the real Keychain via generate/retrieve/delete — \
                  covered by manual QA on macOS"
    )]
    fn os_kek_crud_is_unavailable_on_non_macos() {
        assert!(matches!(generate_os_kek(), Err(OsKekError::Unavailable)));
        assert!(matches!(get_os_kek(), Err(OsKekError::Unavailable)));
        assert!(
            remove_os_kek().is_ok(),
            "remove_os_kek must be a no-op, not an error, on non-macOS"
        );
    }

    // ─── Biometric-enabled setting (pure helpers) ────────────────────────────

    #[test]
    fn read_biometric_enabled_is_false_by_default() {
        let conn = setup();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    #[test]
    fn write_true_then_read_returns_true() {
        let conn = setup();
        write_biometric_enabled(&conn, true).unwrap();
        assert!(read_biometric_enabled(&conn).unwrap());
    }

    #[test]
    fn write_false_then_read_returns_false() {
        let conn = setup();
        write_biometric_enabled(&conn, true).unwrap();
        write_biometric_enabled(&conn, false).unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    #[test]
    fn unrecognized_setting_value_is_treated_as_false() {
        // Guards against a storage-corruption or external-write that
        // puts something unexpected in the cell. "false" / "0" / garbage
        // must all be safe defaults (biometric OFF).
        let conn = setup();
        db::set_setting(&conn, BIOMETRIC_ENABLED_SETTING, "yes").unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    // ─── sync_biometric_setting_for_unlock_method ────────────────────────────
    //
    // Setup/join resolve their own unlock method and write the boot file
    // directly, never going through `enable_biometric_unlock`. These pin the
    // mapping that keeps the DB setting in step with that resolved method —
    // if it were wrong, a user who chose OS unlock would end up with an
    // os_kek in the Keychain that no management surface can see.

    #[test]
    fn sync_biometric_setting_enables_for_both() {
        let conn = setup();
        sync_biometric_setting_for_unlock_method(&conn, UnlockMethod::Both).unwrap();
        assert!(
            read_biometric_enabled(&conn).unwrap(),
            "a boot file carrying an os_kek wrap must report biometric enabled"
        );
    }

    #[test]
    fn sync_biometric_setting_enables_for_os_kek_only() {
        let conn = setup();
        sync_biometric_setting_for_unlock_method(&conn, UnlockMethod::OsKek).unwrap();
        assert!(read_biometric_enabled(&conn).unwrap());
    }

    #[test]
    fn sync_biometric_setting_writes_explicit_false_for_password() {
        let conn = setup();
        sync_biometric_setting_for_unlock_method(&conn, UnlockMethod::Password).unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
        // Explicit "false", not absent — the setting states the outcome.
        assert_eq!(
            db::get_setting(&conn, BIOMETRIC_ENABLED_SETTING).unwrap(),
            Some("false".to_string())
        );
    }

    #[test]
    fn sync_biometric_setting_downgrades_a_previously_true_setting() {
        let conn = setup();
        write_biometric_enabled(&conn, true).unwrap();
        sync_biometric_setting_for_unlock_method(&conn, UnlockMethod::Password).unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    // ─── clear_biometric_setting ─────────────────────────────────────────────

    #[test]
    fn clear_biometric_setting_flips_true_to_false() {
        let conn = setup();
        write_biometric_enabled(&conn, true).unwrap();
        clear_biometric_setting(&conn).unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    #[test]
    fn clear_biometric_setting_is_idempotent_when_already_off() {
        let conn = setup();
        clear_biometric_setting(&conn).unwrap();
        clear_biometric_setting(&conn).unwrap();
        assert!(!read_biometric_enabled(&conn).unwrap());
    }

    // ─── wipe_biometric_keychain (non-macOS contract) ────────────────────────

    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "Touches the real Keychain via delete — covered by manual QA on macOS"
    )]
    fn wipe_biometric_keychain_is_noop_on_non_macos() {
        // On non-macOS we just want the call to succeed without DB or
        // network side effects. On macOS the test is ignored because it
        // would touch the real user Keychain.
        assert!(wipe_biometric_keychain().is_ok());
    }

    // macOS keychain roundtrip tests are intentionally omitted in the test
    // suite — real Keychain access requires a machine with the Keychain
    // accessible, which varies by CI environment. Manual QA covers the
    // store/retrieve/remove roundtrip on macOS. The non-macOS contracts
    // above verify the error-path behavior.
}
