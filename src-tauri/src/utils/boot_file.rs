/// Tiny unencrypted sidecar file that stores the values needed to bootstrap
/// startup before the SQLCipher DB can be opened.
///
/// Without this, opening an encrypted DB would require the user's key, which
/// requires reading kek_salt/wrapped_key from the DB — a circular dependency.
///
/// File is stored at `<db_path>.boot` (e.g., `memlore.db.boot`).
/// Format: `KEY=VALUE` lines, one per entry. Unknown lines are silently
/// ignored so forward-compat additions don't break older builds.
///
/// # Format version
///
/// **v3 (current, Phase 3):** `mode=password|unset` is the authoritative
/// encryption-on/off field. Always-encrypted: there is no `none` mode.
/// Orthogonal to `mode`, `unlock_method=password|os_kek|both` records which
/// KEK(s) can reach the master: the password KEK (`kek_salt` + `wrapped_key`)
/// and/or the OS-keystore KEK (`os_kek_wrapped_master`). At least one of
/// `wrapped_key` / `os_kek_wrapped_master` must be present whenever
/// `mode=password` — `load()` and `save()` both reject a file that would
/// leave zero unlock methods, since that is a permanently bricked vault, not
/// a recoverable state. The legacy `encryption_enabled` line is no longer
/// written or parsed.
///
/// `unlock_method` is a UI hint, not the source of truth: unlock code must
/// key its behavior off which of `wrapped_key` / `os_kek_wrapped_master` is
/// actually present, never off the label alone.
use std::path::Path;

use crate::db::EncryptionMode;

const KEY_MODE: &str = "mode";
const KEY_KEK_SALT: &str = "kek_salt";
const KEY_WRAPPED_KEY: &str = "wrapped_key";
const KEY_UNLOCK_METHOD: &str = "unlock_method";
/// Hex-encoded AES-256-GCM master key wrapped by the OS-keystore key
/// (`os_kek`) — `AES-GCM(os_kek, master_key)`, 120 hex chars (60 raw bytes).
/// `os_kek` itself never touches disk; it lives in the OS keystore (macOS
/// Keychain, Touch-ID-gated) and this blob is useless without it. Present iff
/// os_kek unlock is enabled (`unlock_method` is `os_kek` or `both`).
pub const KEY_OS_KEK_WRAPPED_MASTER: &str = "os_kek_wrapped_master";
const KEY_RECOVERY_WRAPPED: &str = "recovery_wrapped";
/// Hex-encoded compact list of per-epoch content-key wraps:
/// `[(epoch_u32_be, wrapped_blob_120hex)…]` stored as a single hex string.
pub const KEY_WRAPPED_CONTENT_LIST: &str = "wrapped_content_list";
/// Hex-encoded per-device DB key wrapped under the password KEK.
/// Same self-describing AES-GCM format as `wrapped_key` (134 hex chars).
pub const KEY_WRAPPED_DB_KEY: &str = "wrapped_db_key";
/// Hex-encoded per-device DB key wrapped under the vault master key.
/// `AES-GCM(master, db_key)` — 120 hex chars (nonce=12 + ct=32 + tag=16 = 60 bytes).
/// This secondary wrap lets `recover_with_passphrase` (master via mnemonic) and
/// `unlock_with_biometric` (master from Keychain) reach db_key without the password.
/// Always present alongside `wrapped_db_key` when `mode == Password`.
pub const KEY_MASTER_WRAPPED_DB_KEY: &str = "master_wrapped_db_key";
/// Written `true` as `"1"` immediately before the T3 PRAGMA rekey and cleared
/// (written `None`) after the post-rekey boot file is successfully saved.
/// On the next unlock, if this marker is set, the unlock path resumes the
/// interrupted T3 migration idempotently rather than treating the state as a
/// completed T2 unlock (which would try to open the DB under db_key when it
/// may still be master-keyed, causing permanent lockout).
/// Non-secret; omitted when `mode == Unset` along with all other key-material fields.
pub const KEY_MIGRATION_IN_PROGRESS: &str = "migration_in_progress";

/// Which KEK(s) can unwrap the master on this device.
///
/// This is orthogonal to [`EncryptionMode`] — `mode` is on/off for
/// encryption, `UnlockMethod` is which key(s) reach the master once
/// encryption is on. Daily unlock always tries the strongest available
/// method first; see `commands::keychain` / `commands::crypto` for the
/// actual unlock path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockMethod {
    /// Only the typed-password KEK (`kek_salt` + `wrapped_key`) can reach
    /// the master. The only option on platforms without an os_kek backend.
    Password,
    /// Only the OS-keystore KEK (`os_kek_wrapped_master`) can reach the
    /// master. No password-wrapped slot exists in the boot file — losing
    /// the os_kek item means falling back to the 24-word recovery phrase,
    /// not a password prompt. Not produced by this phase's setup/onboard
    /// commands (password is always also collected there); supported by the
    /// format and unlock path for a future "remove password unlock" action.
    OsKek,
    /// Both the password KEK and the OS-keystore KEK independently wrap the
    /// master. What `begin/confirm_first_time_setup` and `onboard_complete`
    /// write when the caller opts into os_kek — password remains the
    /// guaranteed fallback.
    Both,
}

impl UnlockMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            UnlockMethod::Password => "password",
            UnlockMethod::OsKek => "os_kek",
            UnlockMethod::Both => "both",
        }
    }
}

/// Parse an `unlock_method=<value>` string.
///
/// Returns an error on any value other than the three known variants — an
/// unrecognized value is corruption or a future-format field, not something
/// to silently default away.
fn parse_unlock_method(value: &str) -> Result<UnlockMethod, String> {
    match value {
        "password" => Ok(UnlockMethod::Password),
        "os_kek" => Ok(UnlockMethod::OsKek),
        "both" => Ok(UnlockMethod::Both),
        other => Err(format!(
            "Unknown boot file unlock_method value: {:?}",
            other
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootFile {
    /// Authoritative encryption mode.
    pub mode: EncryptionMode,
    /// Which KEK(s) can unwrap the master. Meaningful only when
    /// `mode == Password`; ignored (and not written) when `mode == Unset`.
    /// A UI hint — unlock code must check `wrapped_key` /
    /// `os_kek_wrapped_master` presence directly, not this label alone.
    pub unlock_method: UnlockMethod,
    /// Hex-encoded Argon2id salt used to derive the KEK.
    /// Present iff password unlock is enabled; absent when `mode == Unset`.
    pub kek_salt: Option<String>,
    /// Hex-encoded AES-256-GCM wrapped master key (nonce || ct || tag).
    /// Present iff password unlock is enabled; absent when `mode == Unset`.
    pub wrapped_key: Option<String>,
    /// Hex-encoded AES-256-GCM master key wrapped by the OS-keystore key
    /// (`os_kek`). Present iff os_kek unlock is enabled; absent when
    /// `mode == Unset`. See [`KEY_OS_KEK_WRAPPED_MASTER`].
    ///
    /// **Invariant (enforced by `save()` and `load()`):** when
    /// `mode == Password`, at least one of `wrapped_key` /
    /// `os_kek_wrapped_master` must be `Some` — a boot file with neither is
    /// a bricked vault.
    pub os_kek_wrapped_master: Option<String>,
    /// Hex-encoded AES-256-GCM master key wrapped by the BIP39 recovery key
    /// (`recovery_wrapped = AES-GCM(recovery_key, master_key)`). Stored here in
    /// the plaintext sidecar — readable while the DB is still locked — so the
    /// 24-word recovery phrase can reset a forgotten password fully offline.
    /// Present when `mode == Password`; absent when `mode == Unset`.
    pub recovery_wrapped: Option<String>,
    /// Hex-encoded compact content-key list: concatenated per-epoch wraps
    /// `[(epoch_u32_be_4bytes)(wrapped_blob_60bytes)…]` hex-encoded as a single
    /// string. Each wrapped_blob is `AES-GCM(master_key, content_key)` = 60 bytes
    /// (120 hex chars per epoch slot, preceded by 8 hex chars for epoch u32).
    /// Present when `mode == Password`; absent when `mode == Unset`.
    pub wrapped_content_list: Option<String>,
    /// Hex-encoded per-device DB key wrapped under the password KEK.
    /// Same self-describing format as `wrapped_key` (134 hex chars).
    /// Present when `mode == Password`; absent when `mode == Unset`.
    pub wrapped_db_key: Option<String>,
    /// Hex-encoded per-device DB key wrapped under the vault master key.
    /// `AES-GCM(master, db_key)` = 60 raw bytes = 120 hex chars.
    /// Enables `recover_with_passphrase` and `unlock_with_biometric` to reach
    /// db_key via master (mnemonic or Keychain) without the device password.
    /// Present when `mode == Password` and a db_key exists; absent otherwise.
    ///
    /// **This is the only route to db_key for an os_kek-only device** —
    /// `wrapped_db_key` is wrapped under the *password* KEK and therefore
    /// cannot exist when `unlock_method == OsKek` (no password wrap). Always
    /// write this field whenever a db_key exists, regardless of unlock_method.
    pub master_wrapped_db_key: Option<String>,
    /// Set to `true` while the T3 one-time PRAGMA rekey migration is in flight.
    /// Written before the irreversible PRAGMA rekey, cleared after the post-rekey
    /// boot file is saved successfully.  On the next unlock, a set marker means the
    /// migration was interrupted and should be resumed idempotently.
    /// `None` in normal operation; only relevant during T3 migration recovery.
    pub migration_in_progress: Option<bool>,
}

impl Default for BootFile {
    fn default() -> Self {
        Self {
            mode: EncryptionMode::Unset,
            // Meaningless while mode == Unset; Password is an arbitrary but
            // harmless placeholder (never written — save() omits it outside
            // Password mode).
            unlock_method: UnlockMethod::Password,
            kek_salt: None,
            wrapped_key: None,
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        }
    }
}

/// Derive the boot file path from the DB path.
pub fn boot_path(db_path: &Path) -> std::path::PathBuf {
    let mut p = db_path.to_path_buf();
    let new_ext = match p.extension() {
        Some(ext) => format!("{}.boot", ext.to_string_lossy()),
        None => "boot".to_owned(),
    };
    p.set_extension(new_ext);
    p
}

/// Parse a `mode=<value>` string into an `EncryptionMode`.
///
/// Returns an error if the value is not `"password"` or `"unset"`. In
/// particular, a legacy `"none"` value (from a pre-rewrite plaintext vault)
/// is rejected here, not silently accepted — there is no none-mode boot file
/// to read, only to wipe and recreate.
fn parse_mode(value: &str) -> Result<EncryptionMode, String> {
    match value {
        "password" => Ok(EncryptionMode::Password),
        "unset" => Ok(EncryptionMode::Unset),
        other => Err(format!("Unknown boot file mode value: {:?}", other)),
    }
}

/// Load the boot file.
///
/// Returns `Ok(BootFile::default())` (mode=Unset, not encrypted) **only** when
/// the file genuinely does not exist — a fresh install.
///
/// Returns `Err(...)` for every other I/O failure, and for content that cannot
/// be trusted (unrecognized `mode=`/`unlock_method=`, or a `mode=password` file
/// with zero unlock wraps).
///
/// **Why `NotFound` must be discriminated.** This used to be `Err(_) =>
/// Ok(default())`, which conflated "absent" with "present but unreadable"
/// (EACCES, EIO, a transient lock, a failing disk). A read error on a real
/// password-mode vault then yielded `mode=Unset`, which `startup_init` reads as
/// a fresh install: it tries the all-zero `BOOTSTRAP_SQLCIPHER_KEY`, that fails
/// because a completed setup has already `PRAGMA rekey`-ed away from it, and
/// the fallback **wipes the database**. One transient read error destroyed the
/// whole vault. Absence is the only benign case; everything else must be loud.
pub fn load(path: &Path) -> Result<BootFile, String> {
    load_impl(path, true)
}

/// Lenient variant used only by phrase-based recovery
/// (`commands::crypto::recover_with_passphrase`).
///
/// Identical to [`load`] except it does NOT enforce the "at least one unlock
/// method" invariant (`wrapped_key` / `os_kek_wrapped_master` both absent).
/// That exact shape — `mode=password` with zero working unlock methods but
/// `recovery_wrapped` still intact — is precisely the bricked-but-wedge-proof
/// state the 24-word recovery phrase exists to escape. Rejecting it here would
/// make recovery a dead end for the one scenario it is designed for: `load()`
/// (used by `startup_init`) fails on that exact shape, routes to
/// `StartupMode::BootFileCorrupt`, and if `recover_with_passphrase` re-ran the
/// strict `load()` it would fail identically, before ever reaching the
/// `recovery_wrapped` check below.
///
/// Still hard-fails on an unreadable file or an unrecognized `mode=` /
/// `unlock_method=` value — those leave nothing safe to parse, so there is no
/// lenient path for them. `recover_with_passphrase` already reports "No
/// recovery slot stored on this device" when `recovery_wrapped` is absent, so
/// a boot file with zero unlock methods AND no recovery slot still correctly
/// dead-ends there — nothing to recover with either way.
///
/// On the lenient shape, the returned `unlock_method` is a meaningless label:
/// with no `unlock_method=` line and no wraps present, it derives to the
/// `Password` variant even though no password wrap exists (see the derivation
/// in `load_impl` below). Harmless today — `recover_with_passphrase` only
/// checks wrap presence directly, never this label, matching the module's own
/// "unlock code must key off wrap presence, never the label" rule — but a
/// future caller of this function must not trust `unlock_method` on a boot
/// file it loaded this way.
pub fn load_for_recovery(path: &Path) -> Result<BootFile, String> {
    load_impl(path, false)
}

fn load_impl(path: &Path, require_unlock_method: bool) -> Result<BootFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BootFile::default()),
        Err(e) => {
            return Err(format!(
                "boot file exists but could not be read ({}): {e} — refusing to \
                 treat this as a fresh install",
                path.display()
            ))
        }
    };

    let mut mode_line: Option<EncryptionMode> = None;
    let mut unlock_method_line: Option<UnlockMethod> = None;
    let mut kek_salt: Option<String> = None;
    let mut wrapped_key: Option<String> = None;
    let mut os_kek_wrapped_master: Option<String> = None;
    let mut recovery_wrapped: Option<String> = None;
    let mut wrapped_content_list: Option<String> = None;
    let mut wrapped_db_key: Option<String> = None;
    let mut master_wrapped_db_key: Option<String> = None;
    let mut migration_in_progress: Option<bool> = None;

    for line in text.lines() {
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                KEY_MODE => {
                    mode_line = Some(parse_mode(v.trim())?);
                }
                KEY_UNLOCK_METHOD => {
                    unlock_method_line = Some(parse_unlock_method(v.trim())?);
                }
                KEY_KEK_SALT => {
                    kek_salt = Some(v.trim().to_owned());
                }
                KEY_WRAPPED_KEY => {
                    wrapped_key = Some(v.trim().to_owned());
                }
                KEY_OS_KEK_WRAPPED_MASTER => {
                    os_kek_wrapped_master = Some(v.trim().to_owned());
                }
                KEY_RECOVERY_WRAPPED => {
                    recovery_wrapped = Some(v.trim().to_owned());
                }
                KEY_WRAPPED_CONTENT_LIST => {
                    wrapped_content_list = Some(v.trim().to_owned());
                }
                KEY_WRAPPED_DB_KEY => {
                    wrapped_db_key = Some(v.trim().to_owned());
                }
                KEY_MASTER_WRAPPED_DB_KEY => {
                    master_wrapped_db_key = Some(v.trim().to_owned());
                }
                KEY_MIGRATION_IN_PROGRESS => {
                    migration_in_progress = Some(v.trim() == "1");
                }
                _ => {}
            }
        }
    }

    // Resolve mode: explicit `mode=` line wins; otherwise Unset (fresh install).
    let mode = mode_line.unwrap_or(EncryptionMode::Unset);

    // When mode is not Password, all key material is unconditionally discarded
    // even if present in the file on disk. This protects against a corrupted or
    // tampered boot file that mixes an unset mode with attacker-controlled key
    // material — if we kept those fields, a downstream caller might inadvertently
    // use them to key the DB before setup has actually run.
    let (
        unlock_method,
        kek_salt,
        wrapped_key,
        os_kek_wrapped_master,
        recovery_wrapped,
        wrapped_content_list,
        wrapped_db_key,
        master_wrapped_db_key,
        migration_in_progress,
    ) = if mode == EncryptionMode::Password {
        (
            // Derive from which wraps are actually present rather than
            // defaulting the label. `save()` always writes `unlock_method` in
            // Password mode, so an absent line means a hand-edited file — and
            // design doc §0 forbids tolerating a legacy shape. Deriving is
            // also strictly safer than defaulting: the doc comment on this
            // field says unlock code must key off wrap presence, never the
            // label, so a derived label can never disagree with reality.
            // The zero-wraps case is rejected by the invariant check below.
            unlock_method_line.unwrap_or(
                match (wrapped_key.is_some(), os_kek_wrapped_master.is_some()) {
                    (true, true) => UnlockMethod::Both,
                    (false, true) => UnlockMethod::OsKek,
                    _ => UnlockMethod::Password,
                },
            ),
            kek_salt,
            wrapped_key,
            os_kek_wrapped_master,
            recovery_wrapped,
            wrapped_content_list,
            wrapped_db_key,
            master_wrapped_db_key,
            migration_in_progress,
        )
    } else {
        (
            UnlockMethod::Password,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
    };

    // Invariant: a Password-mode boot file must have at least one usable
    // unlock method. Neither wrap present means the master is unreachable —
    // a bricked vault. Reject loudly rather than returning a BootFile the
    // caller might otherwise treat as a normal (if minimal) state.
    //
    // Skipped when `require_unlock_method` is false (`load_for_recovery`) —
    // see that function's doc comment for why.
    if require_unlock_method
        && mode == EncryptionMode::Password
        && wrapped_key.is_none()
        && os_kek_wrapped_master.is_none()
    {
        return Err("Boot file has mode=password but neither wrapped_key nor \
             os_kek_wrapped_master is present — this vault has zero unlock \
             methods and cannot be opened; refusing to load it as valid"
            .to_string());
    }

    Ok(BootFile {
        mode,
        unlock_method,
        kek_salt,
        wrapped_key,
        os_kek_wrapped_master,
        recovery_wrapped,
        wrapped_content_list,
        wrapped_db_key,
        master_wrapped_db_key,
        migration_in_progress,
    })
}

/// Persist the boot file atomically (write to temp file, then rename).
///
/// Always writes `mode=<value>`. When `mode != Password`, `kek_salt` and
/// `wrapped_key` (and every other key-material field) are omitted. The legacy
/// `encryption_enabled` line is never written.
///
/// Returns `Err` without writing anything if `mode == Password` and neither
/// `wrapped_key` nor `os_kek_wrapped_master` is set — that combination is a
/// vault with zero unlock methods, and this function refuses to commit a
/// bricked boot file to disk. Callers that hit this should treat it as a bug:
/// every path that constructs a Password-mode `BootFile` must set at least
/// one of the two wraps.
pub fn save(boot: &BootFile, path: &Path) -> Result<(), String> {
    if boot.mode == EncryptionMode::Password
        && boot.wrapped_key.is_none()
        && boot.os_kek_wrapped_master.is_none()
    {
        return Err(
            "boot_file::save refuses to write mode=password with neither wrapped_key nor \
             os_kek_wrapped_master set — this would brick the vault"
                .to_string(),
        );
    }

    let mut content = String::with_capacity(256);
    content.push_str(&format!("{}={}\n", KEY_MODE, boot.mode.as_str()));

    // Key material fields are only meaningful in Password mode.
    if boot.mode == EncryptionMode::Password {
        content.push_str(&format!(
            "{}={}\n",
            KEY_UNLOCK_METHOD,
            boot.unlock_method.as_str()
        ));
        if let Some(ref s) = boot.kek_salt {
            content.push_str(&format!("{}={}\n", KEY_KEK_SALT, s));
        }
        if let Some(ref s) = boot.wrapped_key {
            content.push_str(&format!("{}={}\n", KEY_WRAPPED_KEY, s));
        }
        if let Some(ref s) = boot.os_kek_wrapped_master {
            content.push_str(&format!("{}={}\n", KEY_OS_KEK_WRAPPED_MASTER, s));
        }
        if let Some(ref s) = boot.recovery_wrapped {
            content.push_str(&format!("{}={}\n", KEY_RECOVERY_WRAPPED, s));
        }
        if let Some(ref s) = boot.wrapped_content_list {
            content.push_str(&format!("{}={}\n", KEY_WRAPPED_CONTENT_LIST, s));
        }
        if let Some(ref s) = boot.wrapped_db_key {
            content.push_str(&format!("{}={}\n", KEY_WRAPPED_DB_KEY, s));
        }
        if let Some(ref s) = boot.master_wrapped_db_key {
            content.push_str(&format!("{}={}\n", KEY_MASTER_WRAPPED_DB_KEY, s));
        }
        if boot.migration_in_progress == Some(true) {
            content.push_str(&format!("{}=1\n", KEY_MIGRATION_IN_PROGRESS));
        }
    }

    // Write to a temp file in the same directory so the rename is atomic.
    let tmp = path.with_extension("boot.tmp");
    std::fs::write(&tmp, &content).map_err(|e| format!("Failed to write boot file: {e}"))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("Failed to rename boot file into place: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp_path(dir: &TempDir) -> std::path::PathBuf {
        dir.path().join("memlore.db")
    }

    // ── Existing tests (updated to use mode-based format) ────────────────────

    #[test]
    fn load_returns_default_when_file_missing() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let boot = load(&bp).unwrap();
        assert_eq!(boot.mode, EncryptionMode::Unset);
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let original = BootFile {
            mode: EncryptionMode::Password,
            unlock_method: UnlockMethod::Password,
            kek_salt: Some("aabbccdd".to_owned()),
            wrapped_key: Some("11223344".to_owned()),
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        save(&original, &bp).unwrap();
        let loaded = load(&bp).unwrap();
        assert_eq!(loaded.mode, EncryptionMode::Password);
        assert_eq!(loaded.kek_salt, Some("aabbccdd".to_owned()));
        assert_eq!(loaded.wrapped_key, Some("11223344".to_owned()));
    }

    #[test]
    fn boot_path_derives_from_db_path() {
        let p = std::path::Path::new("/data/memlore.db");
        assert_eq!(boot_path(p), std::path::Path::new("/data/memlore.db.boot"));
    }

    #[test]
    fn load_ignores_unknown_keys() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(
            &bp,
            "mode=password\nunknown_key=foo\nkek_salt=aabb\nwrapped_key=ccdd\n",
        )
        .unwrap();
        let boot = load(&bp).unwrap();
        assert_eq!(boot.mode, EncryptionMode::Password);
        assert_eq!(boot.kek_salt.as_deref(), Some("aabb"));
    }

    #[test]
    fn load_handles_missing_optional_fields() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(&bp, "mode=unset\n").unwrap();
        let boot = load(&bp).unwrap();
        assert_eq!(boot.mode, EncryptionMode::Unset);
        assert!(boot.kek_salt.is_none());
        assert!(boot.wrapped_key.is_none());
    }

    #[test]
    fn save_is_atomic_via_rename() {
        let dir = TempDir::new().unwrap();
        let db = tmp_path(&dir);
        let bp = boot_path(&db);
        let boot = BootFile {
            mode: EncryptionMode::Password,
            unlock_method: UnlockMethod::Password,
            kek_salt: Some("deadbeef".to_owned()),
            // At least one unlock wrap is required (invariant enforced by
            // save()); this test is about atomicity, not wrap contents.
            wrapped_key: Some("aa".repeat(60)),
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        save(&boot, &bp).unwrap();
        assert!(bp.exists());
        assert!(!bp.with_extension("boot.tmp").exists());
    }

    // ── New tests — Task 2 contract ──────────────────────────────────────────

    #[test]
    fn roundtrip_mode_password_with_kek_and_wrapped_key() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let original = BootFile {
            mode: EncryptionMode::Password,
            unlock_method: UnlockMethod::Password,
            kek_salt: Some("deadbeef01020304".to_owned()),
            wrapped_key: Some("cafebabe00112233".to_owned()),
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        save(&original, &bp).unwrap();

        let loaded = load(&bp).unwrap();
        assert_eq!(loaded.mode, EncryptionMode::Password);
        assert_eq!(loaded.kek_salt.as_deref(), Some("deadbeef01020304"));
        assert_eq!(loaded.wrapped_key.as_deref(), Some("cafebabe00112233"));
        // Verify the file does NOT contain encryption_enabled line.
        let content = std::fs::read_to_string(&bp).unwrap();
        assert!(
            !content.contains("encryption_enabled"),
            "save must not write encryption_enabled line; got: {content}"
        );
        assert!(
            content.contains("mode=password"),
            "save must write mode= line; got: {content}"
        );
    }

    #[test]
    fn roundtrip_mode_unset_omits_kek_and_wrapped_key_even_if_set() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let original = BootFile {
            mode: EncryptionMode::Unset,
            // Even if callers accidentally set these, save() must omit them —
            // key material is only ever written for mode=password.
            unlock_method: UnlockMethod::Both,
            kek_salt: Some("should-be-dropped".to_owned()),
            wrapped_key: Some("should-be-dropped".to_owned()),
            os_kek_wrapped_master: Some("should-be-dropped".to_owned()),
            recovery_wrapped: Some("should-be-dropped".to_owned()),
            wrapped_content_list: Some("should-be-dropped".to_owned()),
            wrapped_db_key: Some("should-be-dropped".to_owned()),
            master_wrapped_db_key: Some("should-be-dropped".to_owned()),
            migration_in_progress: None,
        };
        save(&original, &bp).unwrap();

        let content = std::fs::read_to_string(&bp).unwrap();
        assert!(
            content.contains("mode=unset"),
            "must write mode=unset; got: {content}"
        );
        assert!(
            !content.contains("kek_salt"),
            "must NOT write kek_salt in unset mode; got: {content}"
        );
        assert!(
            !content.contains("wrapped_key"),
            "must NOT write wrapped_key in unset mode; got: {content}"
        );
        assert!(
            !content.contains("recovery_wrapped"),
            "must NOT write recovery_wrapped in unset mode; got: {content}"
        );
        assert!(
            !content.contains("unlock_method"),
            "must NOT write unlock_method in unset mode; got: {content}"
        );
        assert!(
            !content.contains(KEY_OS_KEK_WRAPPED_MASTER),
            "must NOT write os_kek_wrapped_master in unset mode; got: {content}"
        );

        let loaded = load(&bp).unwrap();
        assert_eq!(loaded.mode, EncryptionMode::Unset);
        assert!(loaded.kek_salt.is_none());
        assert!(loaded.wrapped_key.is_none());
        assert!(loaded.recovery_wrapped.is_none());
        assert!(loaded.os_kek_wrapped_master.is_none());
    }

    #[test]
    fn roundtrip_mode_unset() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let original = BootFile {
            mode: EncryptionMode::Unset,
            unlock_method: UnlockMethod::Password,
            kek_salt: None,
            wrapped_key: None,
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        save(&original, &bp).unwrap();

        let loaded = load(&bp).unwrap();
        assert_eq!(loaded.mode, EncryptionMode::Unset);
        assert!(loaded.kek_salt.is_none());
        assert!(loaded.wrapped_key.is_none());
        assert!(loaded.recovery_wrapped.is_none());
    }

    #[test]
    fn unknown_mode_value_returns_error() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(&bp, "mode=device\n").unwrap();

        let result = load(&bp);
        assert!(
            result.is_err(),
            "unknown mode value must return an error; got: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("device"),
            "error message should include the unknown value; got: {err}"
        );
    }

    // ── Phase 3 — os_kek unlock method ───────────────────────────────────────

    #[test]
    fn unknown_unlock_method_value_returns_error() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(
            &bp,
            "mode=password\nunlock_method=fingerprint\nwrapped_key=aabb\n",
        )
        .unwrap();

        let result = load(&bp);
        assert!(
            result.is_err(),
            "unknown unlock_method value must return an error; got: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("fingerprint"),
            "error message should include the unknown value; got: {err}"
        );
    }

    #[test]
    fn save_rejects_password_mode_with_neither_wrap() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let boot = BootFile {
            mode: EncryptionMode::Password,
            unlock_method: UnlockMethod::Password,
            kek_salt: Some("aabb".to_owned()),
            wrapped_key: None,
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        let result = save(&boot, &bp);
        assert!(
            result.is_err(),
            "save() must refuse to write a boot file with zero unlock methods; got: {result:?}"
        );
        assert!(
            !bp.exists(),
            "save() must not leave a partial/bricked file on disk after refusing"
        );
    }

    #[test]
    fn save_accepts_password_mode_with_only_os_kek_wrap() {
        // A pure os_kek-only boot file (no password wrap at all) satisfies
        // the invariant — os_kek alone is a valid unlock method.
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let boot = BootFile {
            mode: EncryptionMode::Password,
            unlock_method: UnlockMethod::OsKek,
            kek_salt: None,
            wrapped_key: None,
            os_kek_wrapped_master: Some("aabb".repeat(30)),
            recovery_wrapped: Some("cc".repeat(60)),
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: Some("dd".repeat(60)),
            migration_in_progress: None,
        };
        save(&boot, &bp).expect("os_kek-only boot file must be a valid, writable state");

        let loaded = load(&bp).unwrap();
        assert_eq!(loaded.unlock_method, UnlockMethod::OsKek);
        assert!(loaded.wrapped_key.is_none());
        assert!(loaded.os_kek_wrapped_master.is_some());
        // The bricking scenario this phase must avoid: db_key must still be
        // reachable for an os_kek-only device via master_wrapped_db_key.
        assert!(
            loaded.master_wrapped_db_key.is_some(),
            "os_kek-only device must retain master_wrapped_db_key to reach db_key"
        );
    }

    #[test]
    fn roundtrip_password_mode_with_recovery_wrapped() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let original = BootFile {
            mode: EncryptionMode::Password,
            unlock_method: UnlockMethod::Password,
            kek_salt: Some("aabb".to_owned()),
            wrapped_key: Some("ccdd".to_owned()),
            os_kek_wrapped_master: None,
            recovery_wrapped: Some("eeff0011".to_owned()),
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        save(&original, &bp).unwrap();

        let content = std::fs::read_to_string(&bp).unwrap();
        assert!(
            content.contains("recovery_wrapped=eeff0011"),
            "must write recovery_wrapped line; got: {content}"
        );

        let loaded = load(&bp).unwrap();
        assert_eq!(loaded.recovery_wrapped.as_deref(), Some("eeff0011"));
    }

    #[test]
    fn load_password_mode_without_recovery_wrapped_yields_none() {
        // Pre-recovery-slot boot files (older installs) have no recovery_wrapped
        // line. load() must parse them as recovery_wrapped: None, never error.
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(&bp, "mode=password\nkek_salt=aabb\nwrapped_key=ccdd\n").unwrap();

        let loaded = load(&bp).unwrap();
        assert_eq!(loaded.mode, EncryptionMode::Password);
        assert!(
            loaded.recovery_wrapped.is_none(),
            "missing recovery_wrapped line must parse as None"
        );
    }

    #[test]
    fn legacy_none_mode_boot_file_is_rejected() {
        // A `mode=none` boot file can only come from a pre-rewrite plaintext
        // vault. There is no compat path for it — it is a wipe-and-recreate
        // case, not a value load() should accept.
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(&bp, "mode=none\n").unwrap();

        let result = load(&bp);
        assert!(
            result.is_err(),
            "legacy mode=none boot file must be rejected, not parsed"
        );
    }

    #[test]
    fn minimal_unset_mode_file_with_only_mode_line_parses_successfully() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(&bp, "mode=unset\n").unwrap();

        let boot = load(&bp).expect("mode=unset with only mode line must parse successfully");
        assert_eq!(boot.mode, EncryptionMode::Unset);
        assert!(boot.kek_salt.is_none());
        assert!(boot.wrapped_key.is_none());
    }

    // ── Resilience tests ─────────────────────────────────────────────────────

    #[test]
    fn load_empty_file_returns_unset() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(&bp, "").unwrap();
        let boot = load(&bp).unwrap();
        assert_eq!(boot.mode, EncryptionMode::Unset);
        assert!(boot.kek_salt.is_none());
        assert!(boot.wrapped_key.is_none());
    }

    #[test]
    fn load_unknown_fields_are_silently_ignored() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(&bp, "mode=unset\nfuture_flag=1\nanother_field=abc123\n").unwrap();
        let boot = load(&bp).expect("unknown fields must not cause error");
        assert_eq!(boot.mode, EncryptionMode::Unset);
    }

    #[test]
    fn load_invalid_mode_value_returns_error() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(&bp, "mode=bad_value\n").unwrap();
        let result = load(&bp);
        assert!(result.is_err(), "invalid mode must return Err");
    }

    /// A boot file path that EXISTS but cannot be read as a file must be an
    /// error, never a silent `BootFile::default()`.
    ///
    /// This is the regression guard for a total-data-loss path: `default()`
    /// means `mode=Unset`, which `startup_init` reads as a fresh install and
    /// which ends in `wipe_db_files`. A single transient read error (EACCES,
    /// EIO, a failing disk, a held lock) would have destroyed the vault.
    ///
    /// Uses a **directory** at the boot-file path rather than `chmod 000`:
    /// `read_to_string` then fails deterministically with a non-`NotFound`
    /// error on every platform, with no dependence on permission enforcement
    /// (which a root test runner or some filesystems ignore). Same code path —
    /// the `Err(e) if e.kind() == NotFound` discrimination in `load()`.
    #[test]
    fn load_unreadable_existing_file_errors_instead_of_defaulting() {
        let dir = tempfile::tempdir().unwrap();

        // Sanity: a real readable boot file loads fine, so the assertion below
        // is about the unreadable case and not a path that never worked.
        let good = dir.path().join("good.boot");
        std::fs::write(&good, "mode=password\nkek_salt=aabb\nwrapped_key=ccdd\n").unwrap();
        assert!(load(&good).is_ok());

        // Exists, but is not a readable file.
        let unreadable = dir.path().join("memlore.db.boot");
        std::fs::create_dir(&unreadable).unwrap();

        let err = load(&unreadable)
            .expect_err("an existing-but-unreadable boot file must not fall back to default()");
        assert!(
            err.contains("could not be read"),
            "unexpected error text: {err}"
        );
    }

    #[test]
    fn load_password_mode_missing_wrapped_key_and_os_kek_returns_error() {
        // Boot file with mode=password but neither wrapped_key nor
        // os_kek_wrapped_master: zero unlock methods, a bricked vault.
        // load() must reject this loudly rather than returning a BootFile a
        // caller might treat as usable.
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(
            &bp,
            "mode=password\nkek_salt=aabbccddeeff00112233445566778899\n",
        )
        .unwrap();
        let result = load(&bp);
        assert!(
            result.is_err(),
            "mode=password with no unlock wrap present must be rejected; got: {result:?}"
        );
    }

    /// The bug this guards: `startup_init` routes to `StartupMode::BootFileCorrupt`
    /// exactly when `load()` errors on this shape (zero unlock methods). If
    /// `recover_with_passphrase` re-ran the strict `load()`, recovery would be a
    /// dead end for every user who ever reaches the recovery screen for this
    /// reason — the one case the 24-word phrase is supposed to escape.
    /// `load_for_recovery` must succeed here so the recovery flow can reach
    /// `recovery_wrapped` and actually recover.
    #[test]
    fn load_for_recovery_succeeds_with_zero_unlock_methods_if_recovery_wrapped_present() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(
            &bp,
            "mode=password\nkek_salt=aabbcc\nrecovery_wrapped=eeff0011\n",
        )
        .unwrap();

        // The strict loader must still reject this shape...
        assert!(
            load(&bp).is_err(),
            "load() must still enforce the unlock-method invariant"
        );

        // ...but the recovery loader must not, and must surface recovery_wrapped.
        let boot = load_for_recovery(&bp).expect(
            "load_for_recovery must tolerate zero unlock methods when a recovery slot exists",
        );
        assert_eq!(boot.mode, EncryptionMode::Password);
        assert!(boot.wrapped_key.is_none());
        assert!(boot.os_kek_wrapped_master.is_none());
        assert_eq!(boot.recovery_wrapped.as_deref(), Some("eeff0011"));
    }

    /// `load_for_recovery` must not become a blanket bypass — an unreadable
    /// file (nothing to parse) and an unrecognized `mode=` value (unclear
    /// semantics) are still hard failures, same as the strict loader.
    #[test]
    fn load_for_recovery_still_rejects_unreadable_file_and_unknown_mode() {
        let unreadable_dir = TempDir::new().unwrap();
        let unreadable = unreadable_dir.path().join("memlore.db.boot");
        std::fs::create_dir(&unreadable).unwrap();
        assert!(load_for_recovery(&unreadable).is_err());

        let bad_mode_dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&bad_mode_dir));
        std::fs::write(&bp, "mode=device\n").unwrap();
        assert!(load_for_recovery(&bp).is_err());
    }

    #[test]
    fn load_password_mode_with_only_os_kek_wrapped_master_succeeds() {
        // A pure os_kek-only boot file (no wrapped_key/kek_salt at all) is a
        // valid, supported state — the os_kek wrap alone satisfies the
        // invariant.
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(
            &bp,
            "mode=password\nunlock_method=os_kek\nos_kek_wrapped_master=aabb\n",
        )
        .unwrap();
        let boot = load(&bp).expect("os_kek-only boot file must load successfully");
        assert_eq!(boot.mode, EncryptionMode::Password);
        assert_eq!(boot.unlock_method, UnlockMethod::OsKek);
        assert!(boot.wrapped_key.is_none());
        assert_eq!(boot.os_kek_wrapped_master.as_deref(), Some("aabb"));
    }

    #[test]
    fn load_unset_mode_discards_kek_salt_even_if_present() {
        // Security: mode=unset must discard any key material even if a corrupted
        // or tampered file includes it — only mode=password is trusted to carry
        // key material.
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        std::fs::write(
            &bp,
            "mode=unset\nkek_salt=aabbccddeeff00112233445566778899\nwrapped_key=xxyyzz\n",
        )
        .unwrap();
        let boot = load(&bp).expect("mode=unset with extra fields must parse");
        assert_eq!(boot.mode, EncryptionMode::Unset);
        assert!(
            boot.kek_salt.is_none(),
            "kek_salt must be discarded in unset mode"
        );
        assert!(
            boot.wrapped_key.is_none(),
            "wrapped_key must be discarded in unset mode"
        );
    }

    #[test]
    fn save_uses_atomic_rename_no_partial_file() {
        // Verify the tmp file → rename pattern: after save, the .boot.tmp file
        // must not exist (it was renamed to .boot).
        let dir = TempDir::new().unwrap();
        let db_path = tmp_path(&dir);
        let bp = boot_path(&db_path);
        let tmp_path = bp.with_extension("boot.tmp");

        let boot = BootFile {
            mode: EncryptionMode::Password,
            unlock_method: UnlockMethod::Password,
            kek_salt: Some("aabbccddeeff00112233445566778899".to_owned()),
            wrapped_key: Some("a".repeat(120)),
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        save(&boot, &bp).unwrap();

        assert!(bp.exists(), "boot file must exist after save");
        assert!(
            !tmp_path.exists(),
            "tmp file must be renamed away after save"
        );
    }

    #[test]
    fn save_overwrites_existing_file_correctly() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));

        let boot_v1 = BootFile {
            mode: EncryptionMode::Password,
            unlock_method: UnlockMethod::Password,
            kek_salt: Some("1111111111111111111111111111111a".to_owned()),
            wrapped_key: Some("a".repeat(120)),
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        save(&boot_v1, &bp).unwrap();

        let boot_v2 = BootFile {
            mode: EncryptionMode::Unset,
            unlock_method: UnlockMethod::Password,
            kek_salt: None,
            wrapped_key: None,
            os_kek_wrapped_master: None,
            recovery_wrapped: None,
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        save(&boot_v2, &bp).unwrap();

        let loaded = load(&bp).unwrap();
        assert_eq!(loaded.mode, EncryptionMode::Unset);
        assert!(loaded.kek_salt.is_none());
    }

    // ── T5 — new storage tests ───────────────────────────────────────────────

    #[test]
    fn roundtrip_with_wrapped_content_list_and_db_key() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let original = BootFile {
            mode: EncryptionMode::Password,
            unlock_method: UnlockMethod::Both,
            kek_salt: Some("aabbccddeeff00112233445566778899".to_owned()),
            wrapped_key: Some("a".repeat(134)),
            os_kek_wrapped_master: Some("f".repeat(120)),
            recovery_wrapped: Some("b".repeat(120)),
            wrapped_content_list: Some("c".repeat(256)),
            wrapped_db_key: Some("d".repeat(134)),
            master_wrapped_db_key: Some("e".repeat(120)),
            migration_in_progress: None,
        };
        save(&original, &bp).unwrap();

        let loaded = load(&bp).unwrap();
        assert_eq!(
            loaded, original,
            "full roundtrip with new fields must match"
        );

        // Verify the file contains the new lines.
        let content = std::fs::read_to_string(&bp).unwrap();
        assert!(
            content.contains(KEY_WRAPPED_CONTENT_LIST),
            "file must contain wrapped_content_list key; got: {content}"
        );
        assert!(
            content.contains(KEY_WRAPPED_DB_KEY),
            "file must contain wrapped_db_key key; got: {content}"
        );
        assert!(
            content.contains(KEY_OS_KEK_WRAPPED_MASTER),
            "file must contain os_kek_wrapped_master key; got: {content}"
        );
        assert!(
            content.contains("unlock_method=both"),
            "file must contain unlock_method=both; got: {content}"
        );
    }

    #[test]
    fn mode_unset_omits_content_list_and_db_key() {
        let dir = TempDir::new().unwrap();
        let bp = boot_path(&tmp_path(&dir));
        let original = BootFile {
            mode: EncryptionMode::Unset,
            unlock_method: UnlockMethod::Both,
            kek_salt: Some("should-be-dropped".to_owned()),
            wrapped_key: Some("should-be-dropped".to_owned()),
            os_kek_wrapped_master: Some("should-be-dropped".to_owned()),
            recovery_wrapped: Some("should-be-dropped".to_owned()),
            wrapped_content_list: Some("should-be-dropped".to_owned()),
            wrapped_db_key: Some("should-be-dropped".to_owned()),
            master_wrapped_db_key: Some("should-be-dropped".to_owned()),
            migration_in_progress: None,
        };
        save(&original, &bp).unwrap();

        let content = std::fs::read_to_string(&bp).unwrap();
        assert!(
            !content.contains(KEY_WRAPPED_CONTENT_LIST),
            "mode=unset must NOT write wrapped_content_list; got: {content}"
        );
        assert!(
            !content.contains(KEY_WRAPPED_DB_KEY),
            "mode=unset must NOT write wrapped_db_key; got: {content}"
        );
        assert!(
            !content.contains(KEY_MASTER_WRAPPED_DB_KEY),
            "mode=unset must NOT write master_wrapped_db_key; got: {content}"
        );

        let loaded = load(&bp).unwrap();
        assert_eq!(loaded.mode, EncryptionMode::Unset);
        assert!(loaded.wrapped_content_list.is_none());
        assert!(loaded.wrapped_db_key.is_none());
        assert!(loaded.master_wrapped_db_key.is_none());
    }
}

/// Re-usable fixture for tests that need to read/write boot files in a temp directory.
/// The temp directory is automatically deleted when the fixture is dropped.
#[cfg(test)]
pub mod test_support {
    use super::*;
    use tempfile::TempDir;

    pub struct BootFileFixture {
        _dir: TempDir,
        pub path: std::path::PathBuf,
    }

    impl BootFileFixture {
        pub fn new() -> Self {
            let dir = TempDir::new().expect("tempdir");
            let path = boot_path(&dir.path().join("memlore.db"));
            Self { _dir: dir, path }
        }

        pub fn write(&self, boot: &BootFile) -> Result<(), String> {
            save(boot, &self.path)
        }

        pub fn read(&self) -> Result<BootFile, String> {
            load(&self.path)
        }
    }

    #[test]
    fn fixture_write_and_read_roundtrip() {
        let fx = BootFileFixture::new();
        let original = BootFile {
            mode: crate::db::EncryptionMode::Password,
            unlock_method: UnlockMethod::Password,
            kek_salt: Some("aabbccddeeff00112233445566778899".to_owned()),
            wrapped_key: Some("a".repeat(120)),
            os_kek_wrapped_master: None,
            recovery_wrapped: Some("b".repeat(120)),
            wrapped_content_list: None,
            wrapped_db_key: None,
            master_wrapped_db_key: None,
            migration_in_progress: None,
        };
        fx.write(&original).unwrap();
        let loaded = fx.read().unwrap();
        assert_eq!(loaded, original);
    }

    #[test]
    fn fixture_read_missing_returns_unset() {
        let fx = BootFileFixture::new();
        // No write — file doesn't exist yet.
        let loaded = fx.read().unwrap();
        assert_eq!(loaded.mode, crate::db::EncryptionMode::Unset);
        assert!(loaded.kek_salt.is_none());
        assert!(loaded.wrapped_key.is_none());
        assert!(loaded.recovery_wrapped.is_none());
    }
}
