use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Listener, Manager};
use zeroize::Zeroizing;

pub mod ai;
pub mod commands;
pub mod db;
mod import_apple_journal;
mod import_apple_journal_yjs;
mod import_html;
mod import_markdown;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod reminders;
pub mod yjs_doc;
// Demo seed (Wikipedia/catalog/Picsum) — never linked into release binaries.
// Available in debug builds and unit tests only.
#[cfg(any(debug_assertions, test))]
pub mod seed;
pub mod sync;
#[cfg(test)]
mod test_support;
pub mod utils;

// ─── LastEditState ───────────────────────────────────────────────────────────

/// Shared "when did the last entry-write land" timestamp, in unix
/// milliseconds. Used by the Chunk 5 scheduler to implement a debounced
/// on-save sync: after every entry mutation, `mark_now()` is stamped; the
/// scheduler waits until `now - last_edit` exceeds the debounce window
/// (default 30 s) before firing a push. A burst of auto-saves therefore
/// collapses into exactly one sync tick instead of one per keystroke.
///
/// `AtomicI64` + `Ordering::Relaxed` is sufficient — the value is
/// advisory, not a correctness dependency of any data operation.
pub struct LastEditState(AtomicI64);

impl LastEditState {
    pub fn new() -> Self {
        Self(AtomicI64::new(0))
    }

    pub fn mark_now(&self) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.0.store(now_ms, Ordering::Relaxed);
    }

    pub fn get_ms(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }

    /// Test-only: set the timestamp directly. Used to simulate clock
    /// skew (e.g. NTP adjustments) or to make debounce tests
    /// deterministic without sleeping. Not exposed outside `#[cfg(test)]`.
    #[cfg(test)]
    pub fn set_ms_for_test(&self, ms: i64) {
        self.0.store(ms, Ordering::Relaxed);
    }
}

impl Default for LastEditState {
    fn default() -> Self {
        Self::new()
    }
}

// ─── GDriveSessionState ──────────────────────────────────────────────────────

/// Tauri-managed state: the active Google Drive OAuth session.
/// `None` when Google Drive is not connected.
/// Access token stays in memory only; refresh token is `Zeroizing`.
pub struct GDriveSessionState(Mutex<Option<sync::gdrive_provider::GDriveSession>>);

impl GDriveSessionState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn set(&self, session: sync::gdrive_provider::GDriveSession) {
        *self.lock() = Some(session);
    }

    pub fn clear(&self) {
        *self.lock() = None;
    }

    pub fn get_clone(&self) -> Option<sync::gdrive_provider::GDriveSession> {
        self.lock().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<sync::gdrive_provider::GDriveSession>> {
        match self.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }
}

impl Default for GDriveSessionState {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared application state — a single SQLite connection protected by a Mutex.
///
/// Internally holds the connection as `Arc<Mutex<Connection>>` so the same
/// handle can be shared with subsystems that need a write path (e.g. the
/// `SqliteAuditSink` in S2-1). The public API is unchanged.
pub struct AppState(std::sync::Arc<Mutex<rusqlite::Connection>>);

impl AppState {
    pub fn new(conn: rusqlite::Connection) -> Self {
        Self(std::sync::Arc::new(Mutex::new(conn)))
    }

    /// Clone the inner `Arc<Mutex<Connection>>` so other subsystems can share
    /// the same connection handle. Callers must observe the same locking
    /// discipline as `AppState::lock()` (no cross-lock-boundary awaits).
    pub fn db_handle(&self) -> std::sync::Arc<Mutex<rusqlite::Connection>> {
        std::sync::Arc::clone(&self.0)
    }

    /// Acquire the database connection lock.
    ///
    /// Returns a `String` error (compatible with Tauri command
    /// `Result<T, String>`). If the mutex is poisoned (a previous panic held
    /// the lock), we recover by taking the inner guard anyway — the SQLite
    /// connection itself remains safe to use, and the alternative (bubbling
    /// "poison error" forever) would make the app completely unresponsive
    /// after a single panic anywhere in the command pipeline.
    pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
        match self.0.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                log::warn!(
                    "AppState mutex was poisoned; recovering the inner guard. \
                     Investigate the panic that caused this."
                );
                Ok(poisoned.into_inner())
            }
        }
    }

    /// Run a closure with the connection lock, automatically releasing the
    /// guard afterwards.
    ///
    /// **Why this exists:** the sync engine (Chunk 3c) awaits filesystem
    /// I/O between DB calls. If the engine held a `MutexGuard` across
    /// `.await`, every other Tauri command (auto-save, search, list
    /// entries, …) would block for the entire sync duration — minutes on
    /// a slow Dropbox folder. `with_conn` lets the engine acquire the
    /// lock only for the short synchronous DB call, release it, then
    /// await I/O, then re-acquire for the next DB call.
    pub fn with_conn<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&rusqlite::Connection) -> Result<R, String>,
    {
        let guard = self.lock()?;
        f(&guard)
    }

    /// Replace the inner connection.
    ///
    /// Called on unlock to swap the startup placeholder (`:memory:`) for the
    /// real SQLCipher-keyed on-disk connection. The old connection is dropped
    /// (and closed) atomically under the mutex.
    pub fn set_connection(&self, new_conn: rusqlite::Connection) -> Result<(), String> {
        let mut guard = self.lock()?;
        *guard = new_conn;
        Ok(())
    }
}

// ─── EncryptionKeyState ───────────────────────────────────────────────────────

/// The content-key list: an append-only epoch → key map plus the currently
/// active epoch for new encryptions.
///
/// Each entry in `keys` is a raw 32-byte content key (DEK). The sync sub-key
/// for a given epoch is `derive_sync_key(keys[epoch])`, matching the existing
/// `with_sync_key` derivation. `latest` is the epoch whose key is used for
/// all new cloud writes; older epochs are kept for decryption of existing data.
///
/// The local SQLCipher key (`db_key`) is a **per-device** random key, separate
/// from the content list. It is derived into the PRAGMA key via
/// `derive_sqlcipher_key(db_key)`. In Phase 1 `db_key == master` so the DB
/// key derivation is unchanged; Phase 3 introduces an independent random `db_key`.
///
/// `master` is the vault's master key (KEK for the content list and `db_key`).
/// Retained in memory so that biometric unlock can store it in the Keychain
/// and paths that start from master (biometric, recover) can reconstruct
/// everything from it without a second password prompt.
pub struct ContentKeyList {
    /// Epoch → content key map. Keys are `Zeroizing` so they are wiped on drop.
    pub keys: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>>,
    /// The latest (highest) epoch — used for all new encryptions.
    pub latest: u32,
    /// Per-device local SQLCipher key. Derives the PRAGMA key via HKDF.
    pub db_key: Zeroizing<[u8; 32]>,
    /// The vault master key (KEK). Retained in memory for biometric re-store and
    /// any path that needs to re-derive wrapped material without a password prompt.
    pub master: Zeroizing<[u8; 32]>,
}

/// In-memory encryption key state. Keys are never written to disk.
/// All key material is wrapped in `Zeroizing` so it is wiped on drop (on clear,
/// overwrite, or process teardown via normal Rust destructors).
///
/// Always-encrypted: there is no no-encryption sentinel variant. Every key
/// state holds a real `ContentKeyList` or nothing (app is locked).
pub struct EncryptionKeyState {
    key: Mutex<Option<ContentKeyList>>,
}

impl Default for EncryptionKeyState {
    fn default() -> Self {
        Self::new()
    }
}

impl EncryptionKeyState {
    pub fn new() -> Self {
        Self {
            key: Mutex::new(None),
        }
    }

    /// Acquire the key-state mutex, recovering from poisoning.
    ///
    /// A panic inside a `with_key` closure (or any future `set_key` /
    /// `clear_key` call-site) poisons this mutex. Under the standard
    /// `Mutex::lock` semantics, every subsequent call returns `PoisonError`
    /// forever, effectively bricking encryption until process restart. We
    /// recover the inner guard instead: the wrapped `Option<ContentKeyList>` is
    /// still valid Rust data — the panic said nothing about its integrity —
    /// and keeping the app usable is the less-bad outcome.
    ///
    /// # Post-poison semantics
    ///
    /// After recovering from a poison, the inner value is `Option<ContentKeyList>`.
    /// Callers **must not** assume it carries meaningful semantic state
    /// post-poison — treat it as an opaque "key may or may not be set" value
    /// and let the existing `is_initialized()` guard decide the next action.
    fn lock_key(&self) -> std::sync::MutexGuard<'_, Option<ContentKeyList>> {
        match self.key.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log::warn!(
                    "EncryptionKeyState mutex was poisoned; recovering the \
                     inner guard. Investigate the panic that caused this."
                );
                poisoned.into_inner()
            }
        }
    }

    /// Store the master key as the Phase-1 seed.
    ///
    /// Seeds the content-key list with a single epoch-1 entry where
    /// `content_key_v1 = master`, and sets `db_key = master`. This preserves
    /// all existing behavior:
    ///   - `with_sqlcipher_key` → `derive_sqlcipher_key(master)` (unchanged)
    ///   - `with_sync_key` → `derive_sync_key(master)` (unchanged)
    ///   - `with_latest_sync_key` → (epoch=1, `derive_sync_key(master)`)
    ///
    /// Any previously stored key is zeroized on drop via `Zeroizing`. Phase 3
    /// will introduce an independent random `db_key`; until then this shim
    /// keeps existing call sites unchanged.
    pub fn set_key(&self, master: Zeroizing<[u8; 32]>) -> Result<(), String> {
        let mut guard = self.lock_key();
        let mut keys = std::collections::BTreeMap::new();
        keys.insert(1u32, Zeroizing::new(*master));
        *guard = Some(ContentKeyList {
            keys,
            latest: 1,
            db_key: Zeroizing::new(*master),
            master,
        });
        Ok(())
    }

    /// Set the content-key state explicitly (Phase 2+ / tests).
    ///
    /// Stores an arbitrary epoch map, latest epoch, per-device db_key, and
    /// the vault master key. The master is retained in memory so that biometric
    /// unlock can re-store it in the Keychain and recovery paths can reconstruct
    /// key material without a password prompt.
    pub fn set_content_state(
        &self,
        keys: std::collections::BTreeMap<u32, Zeroizing<[u8; 32]>>,
        latest: u32,
        db_key: Zeroizing<[u8; 32]>,
        master: Zeroizing<[u8; 32]>,
    ) -> Result<(), String> {
        if keys.is_empty() {
            return Err("set_content_state: key list must not be empty".to_string());
        }
        if !keys.contains_key(&latest) {
            return Err(format!(
                "set_content_state: latest epoch {latest} not found in key list"
            ));
        }
        let mut guard = self.lock_key();
        *guard = Some(ContentKeyList {
            keys,
            latest,
            db_key,
            master,
        });
        Ok(())
    }

    /// Remove the encryption key from memory. `Zeroizing` wipes the underlying
    /// bytes when the previous `Some` is dropped.
    pub fn clear_key(&self) -> Result<(), String> {
        let mut guard = self.lock_key();
        *guard = None;
        Ok(())
    }

    /// Execute a closure with a reference to the master (latest content) key bytes.
    ///
    /// Contract: the closure must NOT re-enter `with_key` / `set_key` /
    /// `clear_key` / `is_initialized` on the same `EncryptionKeyState`, and
    /// must NOT acquire any other lock that could be held by a concurrent
    /// call into this state. The key bytes do not escape the closure.
    ///
    /// Returns an error if the key is not set (app is locked).
    pub fn with_key<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&[u8; 32]) -> Result<R, String>,
    {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => {
                let k = list
                    .keys
                    .get(&list.latest)
                    .expect("ContentKeyList invariant: latest epoch must be in keys map");
                f(&**k)
            }
            None => Err("Encryption key not initialized — app is locked".to_string()),
        }
    }

    /// Returns whether a key is currently stored.
    pub fn is_initialized(&self) -> Result<bool, String> {
        let guard = self.lock_key();
        Ok(guard.is_some())
    }

    /// Execute a closure with the raw per-device `db_key` bytes.
    ///
    /// Used by `change_password` to re-wrap `db_key` under a new password KEK
    /// without going through the HKDF-derived SQLCipher sub-key. The raw `db_key`
    /// is never exposed outside the closure.
    ///
    /// Returns an error if the key state is not set (app is locked).
    pub fn with_db_key<R>(
        &self,
        f: impl FnOnce(&[u8; 32]) -> Result<R, String>,
    ) -> Result<R, String> {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => f(&list.db_key),
            None => Err("Encryption key not initialized — app is locked".to_string()),
        }
    }

    /// Execute a closure with the vault master key bytes.
    ///
    /// Used by `enable_biometric_unlock` to store the raw master (not the
    /// content key) in the macOS Keychain, and by unlock paths that reconstruct
    /// all key material from master. The master does not escape the closure.
    ///
    /// Returns an error if the key state is not set (app is locked).
    pub fn with_master<R>(
        &self,
        f: impl FnOnce(&[u8; 32]) -> Result<R, String>,
    ) -> Result<R, String> {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => f(&list.master),
            None => Err("Encryption key not initialized — app is locked".to_string()),
        }
    }

    /// Execute a closure with the HKDF-derived SQLCipher sub-key.
    ///
    /// The sub-key is derived on demand from the **per-device `db_key`** via
    /// `utils::encryption::derive_sqlcipher_key`. In Phase 1 `db_key == master`,
    /// so the derivation is identical to before. Phase 3 introduces an
    /// independent random `db_key` — this accessor remains unchanged.
    pub fn with_sqlcipher_key<R>(
        &self,
        f: impl FnOnce(&[u8; 32]) -> Result<R, String>,
    ) -> Result<R, String> {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => {
                let sub_key = crate::utils::encryption::derive_sqlcipher_key(&list.db_key);
                f(&*sub_key)
            }
            None => Err("Encryption key not initialized — app is locked".to_string()),
        }
    }

    /// Execute a closure with the HKDF-derived sync-envelope sub-key for the
    /// **latest** content key.
    ///
    /// Delegates to `with_latest_sync_key` and discards the epoch, keeping
    /// all existing call sites (engine.rs, rotation/*.rs, commands/*.rs)
    /// byte-identical. In Phase 1 this is `derive_sync_key(master)`.
    pub fn with_sync_key<R>(
        &self,
        f: impl FnOnce(&[u8; 32]) -> Result<R, String>,
    ) -> Result<R, String> {
        self.with_key(|latest_content| {
            let sub_key = crate::utils::encryption::derive_sync_key(latest_content);
            f(&*sub_key)
        })
    }

    /// Execute a closure with the latest content-key epoch and its derived
    /// sync sub-key.
    ///
    /// Used by `encrypt_data_with_state` to stamp the epoch into the V2
    /// envelope. The closure receives `(epoch: u32, sync_key: &[u8; 32])`.
    pub fn with_latest_sync_key<R>(
        &self,
        f: impl FnOnce(u32, &[u8; 32]) -> Result<R, String>,
    ) -> Result<R, String> {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => {
                let k = list
                    .keys
                    .get(&list.latest)
                    .expect("ContentKeyList invariant: latest epoch must be in keys map");
                let sub_key = crate::utils::encryption::derive_sync_key(k);
                f(list.latest, &*sub_key)
            }
            None => Err("Encryption key not initialized — app is locked".to_string()),
        }
    }

    /// Execute a closure with the sync sub-key for a specific content-key epoch.
    ///
    /// Used by `decrypt_data_with_state` to select the key matching the epoch
    /// tag in a V2 envelope. Returns `Err` containing "unknown content-key epoch"
    /// if the epoch is not present in the key list — never silently selects the
    /// wrong key.
    pub fn with_sync_key_for_epoch<R>(
        &self,
        epoch: u32,
        f: impl FnOnce(&[u8; 32]) -> Result<R, String>,
    ) -> Result<R, String> {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => match list.keys.get(&epoch) {
                Some(k) => {
                    let sub_key = crate::utils::encryption::derive_sync_key(k);
                    f(&*sub_key)
                }
                None => Err(format!(
                    "unknown content-key epoch {epoch} — this device does not hold \
                     the content key for epoch {epoch}"
                )),
            },
            None => Err("Encryption key not initialized — app is locked".to_string()),
        }
    }

    /// Execute a closure with the sync sub-key whose fingerprint matches `fp`.
    ///
    /// Used by the entry-sync path: entries carry `key_fingerprint` (HMAC of
    /// the sync sub-key, not the raw content key) so decryption iterates the
    /// key list and selects the entry whose derived sync key has the matching
    /// fingerprint. Returns `Err` if no key matches — never silently selects
    /// the wrong key.
    ///
    /// Fingerprint is computed as `key_fingerprint(derive_sync_key(content_key))`,
    /// matching engine.rs's existing `with_sync_key(|k| key_fingerprint(k))`.
    pub fn with_sync_key_for_fingerprint<R>(
        &self,
        fp: &[u8; 32],
        f: impl FnOnce(&[u8; 32]) -> Result<R, String>,
    ) -> Result<R, String> {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => {
                for (epoch, content_k) in &list.keys {
                    let sync_k = crate::utils::encryption::derive_sync_key(content_k);
                    let candidate_fp = crate::utils::encryption::key_fingerprint(&*sync_k);
                    if &candidate_fp == fp {
                        return f(&*sync_k);
                    }
                    // Log for debugging (epoch only, no key material).
                    let _ = epoch;
                }
                Err(
                    "key fingerprint mismatch — no content key in the list matches the \
                     entry's key_fingerprint; the device may have been revoked or the \
                     key list is out of date"
                        .to_string(),
                )
            }
            None => Err("Encryption key not initialized — app is locked".to_string()),
        }
    }

    /// Try to decrypt a raw AES-GCM blob (no version prefix) by attempting
    /// every epoch's sync sub-key in ascending order.
    ///
    /// Used for legacy `0x01` envelopes whose epoch is not tagged in the wire
    /// format. The data was encrypted under some epoch's sync key — typically
    /// epoch 1 for pre-rotation data, but after rotation we must try all keys
    /// in the list because the "latest" sync key is no longer epoch 1.
    ///
    /// Returns `Ok(plaintext)` on the first successful decrypt, or the last
    /// `Err` if all keys fail.
    pub(crate) fn try_all_sync_keys(&self, inner: &[u8]) -> Result<Vec<u8>, String> {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => {
                let mut epochs: Vec<u32> = list.keys.keys().copied().collect();
                epochs.sort_unstable(); // ascending: try oldest first (epoch 1 most likely)
                let mut last_err = "try_all_sync_keys: key list is empty".to_string();
                for epoch in epochs {
                    let k = list.keys.get(&epoch).expect("epoch from same map");
                    let sub_key = crate::utils::encryption::derive_sync_key(k);
                    match crate::utils::encryption::decrypt_data(&*sub_key, inner) {
                        Ok(plain) => return Ok(plain),
                        Err(e) => last_err = e,
                    }
                }
                Err(last_err)
            }
            None => Err("Encryption key not initialized — app is locked".to_string()),
        }
    }

    /// Return the fingerprint of the **latest** sync sub-key.
    ///
    /// Computes `key_fingerprint(derive_sync_key(latest_content_key))`.
    /// This is the value stamped into `SyncEntryPayload.key_fingerprint`
    /// by the push path (engine.rs). The result is the same as
    /// `with_sync_key(|k| Ok(key_fingerprint(k)))` in Phase 1.
    pub fn with_latest_fingerprint<R>(
        &self,
        f: impl FnOnce(&[u8; 32]) -> Result<R, String>,
    ) -> Result<R, String> {
        self.with_latest_sync_key(|_epoch, sync_k| {
            let fp = crate::utils::encryption::key_fingerprint(sync_k);
            f(&fp)
        })
    }

    /// Create a detached snapshot of the current key list for the sync engine.
    ///
    /// The snapshot is a new `EncryptionKeyState` with the same epoch→content-key
    /// map as `self`, held in its own independent `Mutex`. Passing this snapshot
    /// to `ingest_entry` / `pull_remote` lets those functions call
    /// `with_sync_key_for_fingerprint` without holding the app-wide `key_state`
    /// mutex across async I/O.
    ///
    /// **Derivation depth:** The app-wide key state stores raw *content keys*.
    /// In `run_sync_now`, the engine receives `key_copy = with_sync_key(|k| *k)`
    /// = `derive_sync_key(content_key)` — already one HKDF step. The engine's
    /// `make_key_state(key_copy)` stores that value, then `with_sync_key` applies
    /// a second derive → push uses `derive_sync_key(derive_sync_key(content_key))`
    /// (two derives) for both the fingerprint and the encryption key.
    ///
    /// This snapshot is consumed only by `with_sync_key_for_fingerprint`, which
    /// applies one more `derive_sync_key` internally. To reach the same two-derive
    /// depth, we **pre-derive each content key once** before storing it here.
    ///
    /// Returns `Err` if the app is locked (no key).
    pub fn snapshot_for_engine(&self) -> Result<EncryptionKeyState, String> {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => {
                let mut pre_derived_keys = std::collections::BTreeMap::new();
                for (epoch, k) in &list.keys {
                    // Pre-derive once so that with_sync_key_for_fingerprint's
                    // internal derive_sync_key brings the total to two derives,
                    // matching the push path depth.
                    let sync_k = crate::utils::encryption::derive_sync_key(k);
                    pre_derived_keys.insert(*epoch, Zeroizing::new(*sync_k));
                }
                let snapshot = EncryptionKeyState::new();
                // Use dummy db_key / master — the engine never calls
                // with_sqlcipher_key or with_master on the snapshot.
                let dummy = Zeroizing::new([0u8; 32]);
                snapshot
                    .set_content_state(
                        pre_derived_keys,
                        list.latest,
                        Zeroizing::new(*dummy),
                        Zeroizing::new(*dummy),
                    )
                    .expect("snapshot_for_engine: set_content_state never fails with valid list");
                Ok(snapshot)
            }
            None => Err(
                "snapshot_for_engine: encryption key not initialized — app is locked".to_string(),
            ),
        }
    }
}

// ─── Startup encryption initialization ───────────────────────────────────────

/// The outcome of `startup_init`, describing which branch was taken.
///
/// Serialized to the frontend via `get_startup_mode` (`snake_case` strings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupMode {
    /// Truly fresh DB — no encryption mode set yet (boot file absent or mode=unset).
    /// Frontend routes to onboarding.
    FirstLaunch,
    /// Password mode is active — key_state stays empty, LockScreen handles unlock.
    PasswordLocked,
    /// Boot file exists but is invalid/unreadable. Vault on disk is left untouched;
    /// frontend shows recovery instructions (24-word phrase). Never wipe.
    BootFileCorrupt,
}

/// Build the in-memory placeholder connection used while the real SQLCipher DB
/// cannot be opened yet (`PasswordLocked` / `BootFileCorrupt`).
///
/// Seeds `encryption_mode=password` so the frontend probe does not mis-route
/// to FirstLaunch/onboarding.
fn startup_placeholder_conn() -> Result<rusqlite::Connection, String> {
    let placeholder = rusqlite::Connection::open(":memory:")
        .map_err(|e| format!("Failed to create startup placeholder: {e}"))?;
    db::schema::migrate(&placeholder)
        .map_err(|e| format!("Failed to migrate startup placeholder: {e}"))?;
    db::set_encryption_mode(&placeholder, db::EncryptionMode::Password)
        .map_err(|e| format!("Failed to seed startup placeholder: {e}"))?;
    Ok(placeholder)
}

/// Open (or re-open) the SQLite database at `db_path`, detect the encryption
/// state, and return the live connection plus the startup mode.
///
/// ## Branch logic
///
/// 1. **Recovery probe**: inspect the data directory for `.bak` / `.enc`
///    conversion artifacts and restore if needed (handles an interrupted
///    `convert_to_password` call).
///
/// 2. **Boot file exists but is invalid/unreadable** — return an in-memory
///    placeholder and `BootFileCorrupt`. Never wipe the on-disk vault.
///
/// 3. **Boot file `mode == Password`** — the DB is SQLCipher-encrypted.
///    Return an in-memory placeholder connection and `PasswordLocked`.
///    The real keyed connection is opened in `initialize_encryption` after
///    the user unlocks.
///
/// 4. **Boot file absent or `mode == Unset`** — fresh install or legacy DB.
///    Open with the bootstrap SQLCipher key and run the existing self-heal
///    detection. Return `FirstLaunch`.
///
/// The app is always encrypted — there is no plaintext DB branch. `key_state`
/// is left empty for `FirstLaunch`, `PasswordLocked`, and `BootFileCorrupt`.
pub(crate) fn startup_init(
    db_path: &Path,
    _key_state: &EncryptionKeyState,
) -> Result<(rusqlite::Connection, StartupMode), String> {
    // _key_state is not touched here — always-encrypted startup never seeds a
    // key before the user unlocks (or completes first-time setup). Kept as a
    // parameter for signature stability across callers/tests.
    let boot_path = utils::boot_file::boot_path(db_path);

    // ── Step 1: Recovery probe ────────────────────────────────────────────────
    //
    // Must run before any DB open attempt so that a partial conversion does not
    // leave us opening the wrong file.
    match db::conversion::recover_from_interrupted_conversion(db_path, &boot_path) {
        Ok(action) if action != db::conversion::RecoveryAction::None => {
            log::info!("startup recovery: applied {action:?}");
        }
        Ok(_) => {} // RecoveryAction::None — nothing to do
        Err(e) => {
            return Err(format!("startup recovery failed: {e}"));
        }
    }

    // ── Step 2: Read boot file ────────────────────────────────────────────────
    //
    // `load()` returns `Ok(BootFile::default())` when the file is simply
    // absent (fresh install) — safe to treat as FirstLaunch below. It returns
    // `Err` for any other read failure (EACCES/EIO/transient lock — see the
    // `NotFound` discrimination in `boot_file::load`), and when the file EXISTS
    // but is invalid (unknown mode/unlock_method
    // value, or a mode=password file with zero unlock wraps — the exact
    // bricked-vault shape Phase 3's invariant now rejects). Swallowing that
    // Err into `BootFile::default()` would misread a corrupted-but-real vault
    // as FirstLaunch, which falls through to the wipe-and-recreate path below
    // — turning a recoverable "boot file needs manual repair" situation into
    // silent data loss. Instead return `BootFileCorrupt` with an in-memory
    // placeholder so the app window can open and the frontend can guide the
    // user to recover with the 24-word phrase — never wipe.
    let boot = match utils::boot_file::load(&boot_path) {
        Ok(b) => b,
        Err(e) => {
            log::error!(
                "startup: boot file exists but is invalid ({e}) — \
                 entering BootFileCorrupt recovery (vault left intact)"
            );
            let placeholder = startup_placeholder_conn()?;
            return Ok((placeholder, StartupMode::BootFileCorrupt));
        }
    };

    match boot.mode {
        // ── Password mode ─────────────────────────────────────────────────────
        db::EncryptionMode::Password => {
            // DB is SQLCipher-encrypted — return a placeholder until the user
            // unlocks and `initialize_encryption` opens the real keyed connection.
            // The placeholder must have schema so commands like `get_encryption_mode`
            // work correctly while locked (the frontend probe on reconcile must not
            // throw "no such table: settings").
            let placeholder = startup_placeholder_conn()?;
            // Mirror the boot file's os_kek availability into the placeholder's
            // `biometric_unlock_enabled` setting. The real setting lives in the
            // still-encrypted DB, unreadable while locked, so without this the
            // lock screen's `is_biometric_unlock_enabled` probe reads the empty
            // placeholder and returns false — hiding the Touch ID button on a
            // device that genuinely has os_kek set up (and making
            // `unlock_with_biometric` reject its own valid path). The boot file's
            // `os_kek_wrapped_master` is the authoritative, lock-time-readable
            // signal that this device can unlock biometrically.
            if boot.os_kek_wrapped_master.is_some() {
                db::set_setting(
                    &placeholder,
                    crate::commands::keychain::BIOMETRIC_ENABLED_SETTING,
                    "true",
                )
                .map_err(|e| format!("Failed to seed biometric flag in placeholder: {e}"))?;
            }
            return Ok((placeholder, StartupMode::PasswordLocked));
        }

        // ── Unset (fresh install or no boot file) ─────────────────────────────
        db::EncryptionMode::Unset => {
            // Fall through to the existing bootstrap + self-heal path below.
        }
    }

    let db_path_str = db_path.to_string_lossy().into_owned();

    // Open (or create) the DB with the bootstrap SQLCipher key. Every file DB
    // is created encrypted from page 1 so that PRAGMA rekey can later rotate
    // it to the real HKDF-derived user key. A plain-SQLite DB from before this
    // patch is wiped and recreated automatically.
    let conn = open_bootstrap_or_wipe(db_path, &db_path_str)?;

    // Check for a failed encryption setup: encryption_mode=password without a
    // boot file means setup_first_time crashed after writing settings but before
    // writing the boot file. The real PRAGMA rekey never ran — the DB is still
    // bootstrap-encrypted. Wipe and start fresh.
    let early_enc_mode = db::get_encryption_mode(&conn)
        .map_err(|e| format!("Failed to read encryption_mode: {e}"))?;

    if early_enc_mode == db::EncryptionMode::Password {
        log::warn!(
            "Detected encryption_mode=password without boot file — setup_first_time likely \
             crashed mid-flight. Wiping DB and returning FirstLaunch."
        );
        drop(conn);
        wipe_db_files(db_path)?;
        let conn = db::open_with_key(&db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY)
            .map_err(|e| format!("Failed to recreate database after failed-setup wipe: {e}"))?;
        if let Err(e) = commands::keychain::wipe_biometric_keychain() {
            log::warn!("Failed to wipe biometric Keychain on failed-setup wipe: {e}");
        }
        return Ok((conn, StartupMode::FirstLaunch));
    }

    // Detect orphaned crypto-material from a crashed setup. If wrapped_key +
    // password_hash + encryption_mode=password are all present but enc_enabled
    // is absent, the DB is still bootstrap-encrypted with no valid user key.
    // Wipe it so the user can start fresh.
    let has_wrapped = db::get_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY)
        .map_err(|e| format!("Failed to read wrapped_encryption_key: {e}"))?
        .is_some_and(|s| !s.is_empty());
    let has_hash = db::is_password_hash_set(&conn)
        .map_err(|e| format!("Failed to read password hash: {e}"))?;
    let enc_mode = db::get_encryption_mode(&conn)
        .map_err(|e| format!("Failed to read encryption_mode: {e}"))?;
    let is_password_mode = matches!(enc_mode, db::EncryptionMode::Password);
    if has_wrapped && has_hash && is_password_mode {
        log::warn!(
            "Detected orphaned password-mode crypto material (wrapped_key + password_hash + \
             encryption_mode=password set, no boot file). \
             setup_first_time likely crashed. Wiping DB and returning FirstLaunch."
        );
        drop(conn);
        wipe_db_files(db_path)?;
        let conn = db::open_with_key(&db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY)
            .map_err(|e| format!("Failed to recreate database after orphan-wipe: {e}"))?;
        if let Err(e) = commands::keychain::wipe_biometric_keychain() {
            log::warn!("Failed to wipe biometric Keychain on orphan-wipe: {e}");
        }
        return Ok((conn, StartupMode::FirstLaunch));
    }

    // Fresh DB or Some(false) — wipe biometric Keychain to clear any orphaned
    // entry from a prior uninstall or corrupted settings row.
    if let Err(e) = commands::keychain::wipe_biometric_keychain() {
        log::warn!("Failed to wipe biometric Keychain on first-launch probe: {e}");
    }
    Ok((conn, StartupMode::FirstLaunch))
}

/// Wipe the DB file and its WAL/SHM siblings from disk.
fn wipe_db_files(db_path: &Path) -> Result<(), String> {
    for suffix in &["", "-wal", "-shm"] {
        let mut p = db_path.to_owned();
        p.set_file_name(format!(
            "{}{}",
            db_path.file_name().unwrap_or_default().to_string_lossy(),
            suffix
        ));
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("Failed to wipe {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

/// Open the file DB with the bootstrap SQLCipher key. If the key is rejected
/// (legacy plain-SQLite DB created before the bootstrap-key patch), wipe the
/// file and recreate it as a fresh bootstrap-encrypted DB.
fn open_bootstrap_or_wipe(
    db_path: &Path,
    db_path_str: &str,
) -> Result<rusqlite::Connection, String> {
    match db::open_with_key(db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY) {
        Ok(conn) => Ok(conn),
        Err(e) => {
            if db_path.exists() {
                log::warn!(
                    "Failed to open DB with bootstrap key (legacy plain-SQLite?): {e}. \
                     Wiping and recreating."
                );
                wipe_db_files(db_path)?;
            }
            db::open_with_key(db_path_str, &db::BOOTSTRAP_SQLCIPHER_KEY)
                .map_err(|e| format!("Failed to recreate database after legacy wipe: {e}"))
        }
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    /// Create a temp dir with a fresh DB and return (TempDir, db_path).
    /// TempDir must be held alive for the duration of the test.
    fn temp_db() -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        (dir, db_path)
    }

    /// `#[serde(rename_all = "snake_case")]` on `StartupMode` is the entire
    /// contract with the frontend: `src/hooks/useAuth.ts` and `src/lib/tauri.ts`
    /// match on these exact string literals. Nothing else in the test suite
    /// serializes `StartupMode` — without this, a rename, a variant reorder
    /// around a future addition, or dropping `rename_all` would silently break
    /// the frontend match with no test catching it, sending a `BootFileCorrupt`
    /// user to a normal LockScreen with no working unlock method instead of the
    /// recovery screen.
    #[test]
    fn startup_mode_serializes_to_the_frontend_contract_strings() {
        assert_eq!(
            serde_json::to_string(&StartupMode::FirstLaunch).unwrap(),
            "\"first_launch\""
        );
        assert_eq!(
            serde_json::to_string(&StartupMode::PasswordLocked).unwrap(),
            "\"password_locked\""
        );
        assert_eq!(
            serde_json::to_string(&StartupMode::BootFileCorrupt).unwrap(),
            "\"boot_file_corrupt\""
        );
    }

    // ── Test 1: fresh DB → FirstLaunch ───────────────────────────────────────

    #[test]
    fn startup_fresh_db_returns_first_launch() {
        let (_dir, db_path) = temp_db();
        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks).expect("startup_init failed");
        assert_eq!(mode, StartupMode::FirstLaunch);
        // The connection is usable and mode is Unset.
        let enc_mode = db::get_encryption_mode(&conn).expect("get_encryption_mode failed");
        assert_eq!(enc_mode, db::EncryptionMode::Unset);
    }

    // ── Test 2: encryption_mode=password without boot file → wipe + FirstLaunch ─
    //
    // If setup_first_time crashed after writing settings but before writing the
    // boot file, encryption_mode=password is in the DB but no boot file exists.
    // The real PRAGMA rekey never ran — DB is still bootstrap-encrypted.
    // startup_init must wipe and return FirstLaunch.

    #[test]
    fn startup_failed_setup_without_boot_file_returns_first_launch() {
        let (_dir, db_path) = temp_db();
        // Pre-seed: encryption_mode=password, no boot file, bootstrap-encrypted DB.
        {
            let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
                .expect("open bootstrap for pre-seed");
            db::set_encryption_mode(&conn, db::EncryptionMode::Password)
                .expect("set_encryption_mode");
        }
        let ks = EncryptionKeyState::new();
        let (_conn, mode) = startup_init(&db_path, &ks).expect("startup_init failed");
        assert_eq!(
            mode,
            StartupMode::FirstLaunch,
            "encryption_mode=password without boot file means failed setup — must wipe and return FirstLaunch"
        );
    }

    // ── Test 3: orphaned crypto markers without boot file → wipe + FirstLaunch ──
    //
    // setup_first_time crashed mid-flight: wrapped_key + password_hash +
    // encryption_mode=password are present but no boot file was written. DB is
    // still bootstrap-encrypted. startup_init must wipe and return FirstLaunch.
    #[test]
    fn startup_wipes_orphaned_password_mode_markers_returns_first_launch() {
        let (_dir, db_path) = temp_db();
        // Pre-seed: password_hash + wrapped key + KEK salt + encryption_mode=password.
        {
            let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
                .expect("open bootstrap for pre-seed");
            db::set_password_hash(&conn, "dummy-password").expect("set_password_hash");
            db::set_setting(
                &conn,
                db::WRAPPED_ENCRYPTION_KEY_KEY,
                "deadbeef".repeat(32).as_str(),
            )
            .expect("set wrapped key");
            db::set_setting(&conn, db::KEK_SALT_KEY, &"a".repeat(64)).expect("set kek salt");
            db::set_encryption_mode(&conn, db::EncryptionMode::Password)
                .expect("set encryption_mode");
        }

        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks).expect("startup_init");
        assert_eq!(
            mode,
            StartupMode::FirstLaunch,
            "orphaned crypto markers without boot file must wipe and return FirstLaunch"
        );
        // After wipe the new DB is clean.
        assert_eq!(
            db::get_encryption_mode(&conn).expect("read mode"),
            db::EncryptionMode::Unset,
            "wiped DB must have Unset encryption_mode"
        );
    }

    #[test]
    fn startup_does_not_self_heal_when_encryption_mode_missing() {
        // The orphan-wipe requires ALL three password-mode markers
        // (wrapped_key + hash + encryption_mode=password). A DB with
        // wrapped_key + hash but missing mode is ambiguous — fall through to
        // FirstLaunch rather than silently wiping.
        let (_dir, db_path) = temp_db();
        {
            let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
                .expect("open bootstrap for pre-seed");
            db::set_password_hash(&conn, "dummy-password").expect("set_password_hash");
            db::set_setting(
                &conn,
                db::WRAPPED_ENCRYPTION_KEY_KEY,
                "deadbeef".repeat(32).as_str(),
            )
            .expect("set wrapped key");
            db::set_setting(&conn, db::KEK_SALT_KEY, &"a".repeat(64)).expect("set kek salt");
            // Deliberately DO NOT set encryption_mode.
        }
        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks).expect("startup_init");
        assert_eq!(
            mode,
            StartupMode::FirstLaunch,
            "incomplete marker set (no encryption_mode) must NOT self-heal"
        );
        assert_eq!(
            db::get_encryption_mode(&conn).expect("read mode"),
            db::EncryptionMode::Unset,
            "self-heal must not have changed encryption_mode"
        );
    }

    // ── Test 5: missing DB file — graceful creation ───────────────────────────

    #[test]
    fn startup_handles_missing_db_file_gracefully() {
        let (_dir, db_path) = temp_db();
        // The DB file does NOT exist yet — startup_init must create it.
        assert!(!db_path.exists(), "pre-condition: file must not exist");
        let ks = EncryptionKeyState::new();
        let (_conn, mode) = startup_init(&db_path, &ks).expect("startup_init should succeed");
        assert_eq!(mode, StartupMode::FirstLaunch);
        assert!(db_path.exists(), "DB file should have been created");
    }

    // ── Test 6: boot file with mode=password → PasswordLocked + placeholder ──────

    #[test]
    fn startup_boot_file_encrypted_returns_password_locked_placeholder() {
        let (_dir, db_path) = temp_db();
        // Write a boot file that says the DB is encrypted.
        let boot_path = crate::utils::boot_file::boot_path(&db_path);
        crate::utils::boot_file::save(
            &crate::utils::boot_file::BootFile {
                mode: crate::db::EncryptionMode::Password,
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                kek_salt: Some("aabbccdd".to_owned()),
                wrapped_key: Some("11223344".to_owned()),
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

        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks).expect("startup_init failed");
        assert_eq!(
            mode,
            StartupMode::PasswordLocked,
            "boot file with mode=password must return PasswordLocked"
        );
        // The placeholder must have encryption_mode=password so that the lock
        // screen query works while the real DB is not yet open.
        assert_eq!(
            db::get_encryption_mode(&conn).expect("get_encryption_mode on placeholder"),
            db::EncryptionMode::Password,
            "placeholder must report encryption_mode=password"
        );
        // The real DB file should NOT have been created (we returned placeholder).
        assert!(
            !db_path.exists(),
            "real DB must not be opened when boot says encrypted"
        );
        // A password-only device has no os_kek, so the placeholder must NOT
        // advertise biometric unlock (the lock screen must not offer Touch ID).
        assert_eq!(
            db::get_setting(&conn, crate::commands::keychain::BIOMETRIC_ENABLED_SETTING)
                .expect("get biometric setting on placeholder"),
            None,
            "password-only boot file must leave biometric_unlock_enabled unset in the placeholder"
        );
    }

    // ── Test 6b: os_kek boot file seeds biometric_unlock_enabled in placeholder ──
    //
    // Regression guard: the lock-screen `is_biometric_unlock_enabled` probe reads
    // the in-memory placeholder (the real DB is still encrypted/locked). When the
    // boot file carries an `os_kek_wrapped_master`, the placeholder MUST report
    // the biometric flag as enabled, or the Touch ID button is hidden on a device
    // that genuinely supports it — and `unlock_with_biometric` rejects its own
    // valid path.
    #[test]
    fn startup_os_kek_boot_file_seeds_biometric_enabled_in_placeholder() {
        let (_dir, db_path) = temp_db();
        let boot_path = crate::utils::boot_file::boot_path(&db_path);
        crate::utils::boot_file::save(
            &crate::utils::boot_file::BootFile {
                mode: crate::db::EncryptionMode::Password,
                unlock_method: crate::utils::boot_file::UnlockMethod::Both,
                kek_salt: Some("aabbccdd".to_owned()),
                wrapped_key: Some("11223344".to_owned()),
                os_kek_wrapped_master: Some("55667788".to_owned()),
                recovery_wrapped: None,
                wrapped_content_list: None,
                wrapped_db_key: None,
                master_wrapped_db_key: None,
                migration_in_progress: None,
            },
            &boot_path,
        )
        .unwrap();

        let ks = EncryptionKeyState::new();
        let (conn, mode) = startup_init(&db_path, &ks).expect("startup_init failed");
        assert_eq!(mode, StartupMode::PasswordLocked);
        assert_eq!(
            db::get_setting(&conn, crate::commands::keychain::BIOMETRIC_ENABLED_SETTING)
                .expect("get biometric setting on placeholder"),
            Some("true".to_owned()),
            "an os_kek boot file must make the placeholder report biometric unlock as enabled"
        );
    }

    // ── Test 7: corrupted (not absent) boot file → BootFileCorrupt, never wipe ──
    //
    // Phase 3 regression guard (updated): `utils::boot_file::load()` returns
    // `Err` for a boot file that EXISTS but is invalid — e.g. `mode=password`
    // with neither `wrapped_key` nor `os_kek_wrapped_master` (zero unlock
    // methods, the exact bricked shape `save()` now refuses to write).
    // Swallowing that `Err` into `BootFile::default()` (mode=Unset) used to
    // route into wipe-and-recreate. Propagating `Err` out of `startup_init`
    // then panicked the process before any window opened. Correct behaviour:
    // return `Ok(BootFileCorrupt)` with an in-memory placeholder and leave
    // the on-disk vault untouched so the frontend can show recovery UI.
    #[test]
    fn startup_corrupted_boot_file_fails_loudly_without_wiping() {
        let (_dir, db_path) = temp_db();
        // Pre-seed exactly the orphaned password-mode markers from the
        // sibling wipe test — this is the state that would have been wiped.
        {
            let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
                .expect("open bootstrap for pre-seed");
            db::set_password_hash(&conn, "dummy-password").expect("set_password_hash");
            db::set_setting(
                &conn,
                db::WRAPPED_ENCRYPTION_KEY_KEY,
                "deadbeef".repeat(32).as_str(),
            )
            .expect("set wrapped key");
            db::set_setting(&conn, db::KEK_SALT_KEY, &"a".repeat(64)).expect("set kek salt");
            db::set_encryption_mode(&conn, db::EncryptionMode::Password)
                .expect("set encryption_mode");
        }

        // A boot file that EXISTS but is invalid — written directly (not via
        // `boot_file::save`, which would refuse this exact shape) to simulate
        // real on-disk corruption.
        let boot_path = crate::utils::boot_file::boot_path(&db_path);
        std::fs::write(&boot_path, "mode=password\nkek_salt=aabbcc\n")
            .expect("write corrupted boot file");

        let ks = EncryptionKeyState::new();
        let (placeholder, mode) = startup_init(&db_path, &ks)
            .expect("corrupted boot file must return Ok(BootFileCorrupt), not panic");
        assert_eq!(
            mode,
            StartupMode::BootFileCorrupt,
            "corrupted boot file must surface BootFileCorrupt for recovery UI"
        );
        // Placeholder must report password mode so the frontend does not
        // mis-route into FirstLaunch/onboarding.
        assert_eq!(
            db::get_encryption_mode(&placeholder).expect("get_encryption_mode on placeholder"),
            db::EncryptionMode::Password,
            "BootFileCorrupt placeholder must report encryption_mode=password"
        );

        // The database must be untouched — re-open with the bootstrap key and
        // confirm the pre-seeded markers survived (a wipe would reset
        // encryption_mode to Unset and drop the settings).
        let conn = db::open_with_key(&db_path.to_string_lossy(), &db::BOOTSTRAP_SQLCIPHER_KEY)
            .expect("re-open bootstrap after BootFileCorrupt startup_init");
        assert_eq!(
            db::get_encryption_mode(&conn).expect("read mode"),
            db::EncryptionMode::Password,
            "database must NOT have been wiped — encryption_mode must survive"
        );
        assert!(
            db::is_password_hash_set(&conn).expect("read password hash marker"),
            "pre-seeded password hash marker must survive BootFileCorrupt startup"
        );
    }
}

#[cfg(test)]
mod encryption_key_state_tests {
    use super::*;
    use zeroize::Zeroizing;

    #[test]
    fn fresh_state_is_not_initialized() {
        let ks = EncryptionKeyState::new();
        assert!(
            !ks.is_initialized().unwrap(),
            "fresh state is not initialized"
        );
    }

    #[test]
    fn clear_key_resets_to_uninitialized() {
        let ks = EncryptionKeyState::new();
        ks.set_key(Zeroizing::new([0x11u8; 32])).unwrap();
        assert!(ks.is_initialized().unwrap());
        ks.clear_key().unwrap();
        assert!(
            !ks.is_initialized().unwrap(),
            "after clear_key, not initialized"
        );
    }

    #[test]
    fn with_key_errors_when_uninitialized() {
        let ks = EncryptionKeyState::new();
        let err = ks.with_key(|_| Ok(())).unwrap_err();
        assert!(
            err.contains("not initialized"),
            "error must say 'not initialized', got: {err:?}"
        );
    }

    // ── T5 — Content-key list and accessor tests ─────────────────────────────

    #[test]
    fn keylist_latest_used_for_encrypt() {
        use crate::utils::encryption::{decrypt_data, derive_sync_key, VERSION_AES_GCM_V2_EPOCH};
        use std::collections::BTreeMap;

        let key1 = Zeroizing::new([0x11u8; 32]);
        let key2 = Zeroizing::new([0x22u8; 32]);
        let db_key = Zeroizing::new([0xAAu8; 32]);
        let mut keys: BTreeMap<u32, Zeroizing<[u8; 32]>> = BTreeMap::new();
        keys.insert(1, Zeroizing::new(*key1));
        keys.insert(2, Zeroizing::new(*key2));
        let ks = EncryptionKeyState::new();
        ks.set_content_state(keys, 2, db_key, Zeroizing::new([0u8; 32]))
            .unwrap();

        let plaintext = b"latest key test";
        // Use the epoch-tagged V2 primitive to verify latest-key selection.
        let envelope =
            crate::utils::encryption::encrypt_data_with_state_epoch(plaintext, &ks).unwrap();

        // Version byte must be V2.
        assert_eq!(envelope[0], VERSION_AES_GCM_V2_EPOCH);
        // Epoch must be 2 (latest).
        let epoch = u32::from_le_bytes([envelope[1], envelope[2], envelope[3], envelope[4]]);
        assert_eq!(epoch, 2, "latest epoch must be used for encrypt");

        // The inner payload must decrypt with key2's sync sub-key, not key1's.
        let inner = &envelope[5..];
        let sync_k2 = derive_sync_key(&key2);
        let recovered = decrypt_data(&sync_k2, inner).unwrap();
        assert_eq!(recovered, plaintext);

        // Decrypting with key1's sync sub-key must fail.
        let sync_k1 = derive_sync_key(&key1);
        assert!(decrypt_data(&sync_k1, inner).is_err());
    }

    #[test]
    fn sqlcipher_key_derives_from_db_key_not_content() {
        use crate::utils::encryption::derive_sqlcipher_key;
        use std::collections::BTreeMap;

        // Content key and db_key are different → sqlcipher key must come from db_key.
        let content_key = Zeroizing::new([0x33u8; 32]);
        let db_key_bytes = [0x44u8; 32];
        let db_key = Zeroizing::new(db_key_bytes);
        let mut keys: BTreeMap<u32, Zeroizing<[u8; 32]>> = BTreeMap::new();
        keys.insert(1, Zeroizing::new(*content_key));
        let ks = EncryptionKeyState::new();
        ks.set_content_state(keys, 1, db_key, Zeroizing::new([0u8; 32]))
            .unwrap();

        let got = ks.with_sqlcipher_key(|k| Ok(*k)).unwrap();
        let expected = *derive_sqlcipher_key(&db_key_bytes);
        assert_eq!(got, expected, "sqlcipher key must derive from db_key");

        // Ensure it does NOT derive from the content key.
        let from_content = *derive_sqlcipher_key(&content_key);
        // These are different because db_key ≠ content_key.
        assert_ne!(
            got, from_content,
            "sqlcipher key must NOT derive from the content key"
        );
    }

    #[test]
    fn with_sync_key_for_epoch_errors_on_unknown_epoch() {
        use std::collections::BTreeMap;

        let key1 = Zeroizing::new([0x55u8; 32]);
        let db_key = Zeroizing::new([0x66u8; 32]);
        let mut keys: BTreeMap<u32, Zeroizing<[u8; 32]>> = BTreeMap::new();
        keys.insert(1, Zeroizing::new(*key1));
        let ks = EncryptionKeyState::new();
        ks.set_content_state(keys, 1, db_key, Zeroizing::new([0u8; 32]))
            .unwrap();

        let err = ks.with_sync_key_for_epoch(99, |_k| Ok(())).unwrap_err();
        assert!(
            err.contains("99") || err.contains("epoch"),
            "error must mention the unknown epoch, got: {err:?}"
        );
    }

    #[test]
    fn with_sync_key_for_fingerprint_selects_correct_key() {
        use crate::utils::encryption::{derive_sync_key, key_fingerprint};
        use std::collections::BTreeMap;

        let key1 = Zeroizing::new([0x77u8; 32]);
        let key2 = Zeroizing::new([0x88u8; 32]);
        let db_key = Zeroizing::new([0x99u8; 32]);
        let mut keys: BTreeMap<u32, Zeroizing<[u8; 32]>> = BTreeMap::new();
        keys.insert(1, Zeroizing::new(*key1));
        keys.insert(2, Zeroizing::new(*key2));
        let ks = EncryptionKeyState::new();
        ks.set_content_state(keys, 2, db_key, Zeroizing::new([0u8; 32]))
            .unwrap();

        // Fingerprint of epoch 1's sync key.
        let sync_k1 = derive_sync_key(&key1);
        let fp1 = key_fingerprint(&sync_k1);
        let got = ks.with_sync_key_for_fingerprint(&fp1, |k| Ok(*k)).unwrap();
        assert_eq!(got, *sync_k1, "must select epoch 1's sync key");

        // Unknown fingerprint → Err.
        let bad_fp = [0x00u8; 32];
        let err = ks
            .with_sync_key_for_fingerprint(&bad_fp, |_| Ok(()))
            .unwrap_err();
        assert!(
            err.contains("fingerprint"),
            "error must mention fingerprint mismatch, got: {err:?}"
        );
    }

    #[test]
    fn set_key_shim_seeds_epoch1_and_db_key_equals_master() {
        use crate::utils::encryption::{derive_sqlcipher_key, derive_sync_key};

        let master = Zeroizing::new([0xCCu8; 32]);
        let ks = EncryptionKeyState::new();
        ks.set_key(Zeroizing::new(*master)).unwrap();

        // with_sync_key must return derive_sync_key(master).
        let sync_got = ks.with_sync_key(|k| Ok(*k)).unwrap();
        let expected_sync = *derive_sync_key(&master);
        assert_eq!(
            sync_got, expected_sync,
            "with_sync_key must match derive_sync_key(master)"
        );

        // with_sqlcipher_key must return derive_sqlcipher_key(master)
        // (db_key == master in Phase 1).
        let sqlcipher_got = ks.with_sqlcipher_key(|k| Ok(*k)).unwrap();
        let expected_sqlcipher = *derive_sqlcipher_key(&master);
        assert_eq!(
            sqlcipher_got, expected_sqlcipher,
            "with_sqlcipher_key must match derive_sqlcipher_key(master)"
        );

        // with_latest_sync_key must return epoch=1.
        let epoch = ks.with_latest_sync_key(|ep, _k| Ok(ep)).unwrap();
        assert_eq!(epoch, 1, "set_key must seed epoch 1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let about_metadata = AboutMetadata {
                    name: Some("Memlore".into()),
                    authors: Some(vec!["Anh-Thi DINH".into()]),
                    credits: Some("GitHub: https://github.com/dinhanhthi/memlore".into()),
                    icon: Some(tauri::include_image!("icons/icon.png")),
                    ..Default::default()
                };
                let settings_item =
                    MenuItem::with_id(app, "open-settings", "Settings", true, None::<&str>)?;
                let new_entry_item =
                    MenuItem::with_id(app, "new-entry", "New Entry", true, Some("CmdOrCtrl+N"))?;
                let new_journal_item = MenuItem::with_id(
                    app,
                    "new-journal",
                    "New Journal",
                    true,
                    Some("CmdOrCtrl+Shift+N"),
                )?;
                let new_entry_from_template_item = MenuItem::with_id(
                    app,
                    "new-entry-from-template",
                    "New Entry from Template…",
                    true,
                    None::<&str>,
                )?;
                let sync_now_item =
                    MenuItem::with_id(app, "sync-now", "Sync Now", true, None::<&str>)?;
                let file_submenu = SubmenuBuilder::new(app, "File")
                    .item(&new_entry_item)
                    .item(&new_entry_from_template_item)
                    .item(&new_journal_item)
                    .separator()
                    .item(&sync_now_item)
                    .build()?;
                let app_submenu = SubmenuBuilder::new(app, "Memlore")
                    .item(&PredefinedMenuItem::about(
                        app,
                        Some("About Memlore"),
                        Some(about_metadata),
                    )?)
                    .separator()
                    .item(&settings_item)
                    .separator()
                    .item(&PredefinedMenuItem::services(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, None)?)
                    .item(&PredefinedMenuItem::hide_others(app, None)?)
                    .item(&PredefinedMenuItem::show_all(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(app, None)?)
                    .build()?;
                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .item(&PredefinedMenuItem::undo(app, None)?)
                    .item(&PredefinedMenuItem::redo(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(app, None)?)
                    .item(&PredefinedMenuItem::copy(app, None)?)
                    .item(&PredefinedMenuItem::paste(app, None)?)
                    .item(&PredefinedMenuItem::select_all(app, None)?)
                    .build()?;
                // "Close Tab" (⌘W) instead of the predefined Close Window.
                // PredefinedMenuItem::close_window binds ⌘W at the native menu
                // level and quits the single-window app, racing the webview
                // tab-close handler. Multi-tab apps own ⌘W themselves.
                let close_tab_item =
                    MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
                let window_submenu = SubmenuBuilder::new(app, "Window")
                    .item(&PredefinedMenuItem::minimize(app, None)?)
                    .item(&PredefinedMenuItem::maximize(app, None)?)
                    .item(&close_tab_item)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_submenu)
                    .item(&file_submenu)
                    .item(&edit_submenu)
                    .item(&window_submenu)
                    .build()?;
                app.set_menu(menu)?;
            }
            // Resolve the platform-specific app data directory at runtime.
            let data_dir = app.path().app_data_dir().map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                )) as Box<dyn std::error::Error>
            })?;
            fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("memlore.db");

            // ── Startup encryption detection ──────────────────────────────
            //
            // `startup_init` opens the DB, detects the encryption state, and
            // returns a live connection plus a `StartupMode`:
            //
            // | Mode            | What happened                                          |
            // |-----------------|--------------------------------------------------------|
            // | FirstLaunch     | Fresh DB / unset — frontend shows onboarding screen    |
            // | PasswordLocked  | Password mode — frontend shows LockScreen              |
            // | BootFileCorrupt | Boot file invalid — recovery UI; vault left intact     |
            //
            // The app is always encrypted — there is no plaintext branch. For
            // all three modes `key_state` is left empty: `PasswordLocked`
            // waits for the LockScreen to unlock; `FirstLaunch` waits for
            // first-time setup; `BootFileCorrupt` waits for 24-word recovery.
            // Frontend probes `get_startup_mode` + `get_encryption_mode`.
            let key_state = EncryptionKeyState::new();
            let (conn, startup_mode) = startup_init(&db_path, &key_state).map_err(|e| {
                Box::new(std::io::Error::new(std::io::ErrorKind::Other, e))
                    as Box<dyn std::error::Error>
            })?;

            // Template seeding runs inside `db::schema::migrate` (see
            // `db::seeds::ensure_predefined_templates`).

            // Phase 6 Stretch S2-1: run startup retention purge ONLY if the
            // connection is the real on-disk DB. In `PasswordLocked` /
            // `BootFileCorrupt` modes `conn` is an in-memory placeholder —
            // purging it is a no-op and the real DB would never get pruned.
            // The unlock path in `commands::crypto::unlock_app` re-runs the
            // purge after the real connection is swapped in via
            // `state.set_connection`.
            let using_placeholder = matches!(
                startup_mode,
                StartupMode::PasswordLocked | StartupMode::BootFileCorrupt
            );
            if !using_placeholder {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                if let Err(e) = ai::audit::run_startup_retention_purge(&conn, now_ms) {
                    log::warn!("ai audit: startup retention purge failed: {e}");
                }
            }

            let app_state = AppState::new(conn);
            // Phase 6 Stretch S2-1: share the DB handle with the audit sink so
            // every AI provider call records one row to `ai_audit_log`.
            let audit_sink: std::sync::Arc<dyn ai::audit::AuditSink> =
                std::sync::Arc::new(ai::audit::SqliteAuditSink::new(app_state.db_handle()));
            app.manage(app_state);
            // Set once at process start, but mutable: `get_startup_mode` reads
            // this so BootFileCorrupt can render recovery UI instead of
            // panicking. `commands::crypto::recover_with_passphrase` flips it
            // back to `PasswordLocked` on success — otherwise ANY `useAuth()`
            // instance that mounts later in the same session (e.g. opening
            // Settings › Encryption) would still read the stale
            // `boot_file_corrupt` value and force the app back to a lock
            // screen even though the user already recovered.
            app.manage(std::sync::Mutex::new(startup_mode));
            app.manage(key_state);
            app.manage(GDriveSessionState::new());
            app.manage(commands::gdrive::PendingOAuthState::new());
            app.manage(LastEditState::new());
            app.manage(commands::audio::AudioSamplesState::new());
            app.manage(commands::audio::AudioStreamState::new());
            app.manage(commands::audio::AudioSessionState::new());
            // Phase 6 v2 R11+: two-slot AI provider registry. Holds independent
            // `Arc<dyn AIProvider>` instances for the generation (chat + image)
            // and embedding slots. Empty on app start; populated from the
            // SQLCipher-encrypted `settings` table after unlock via
            // `commands::crypto`, or immediately when the user configures a
            // provider via Settings → AI.
            app.manage(ai::provider_registry::ProviderRegistry::new(audit_sink));
            app.manage(commands::ai::BackfillManager::new());
            // Phase 6 v2 R6: streaming chat cancellation registry.
            // Stored as Arc so Tauri command handlers can clone it
            // into spawned tasks without lifetime gymnastics.
            app.manage(std::sync::Arc::new(
                commands::ai::InFlightChatRegistry::new(),
            ));
            // Prototype-embedding cache for emotion suggestions. Rebuilds
            // on model_id mismatch so swapping provider (or back to stub)
            // refreshes prototypes alongside the runtime swap.
            app.manage(ai::emotion::EmotionSuggesterCache::new());
            // Embedding Cost Guardrails Phase 4 Task 2: on-device model
            // download manager. Cache dir is separate from the legacy
            // `models/` dir the ai_v2 migration best-effort removes (see
            // `commands::ai_settings::run_ai_v2_migration`), so a stray
            // rerun of that one-time migration can never delete a
            // freshly-downloaded on-device model. Nothing downloads until
            // the user opts in via `start_on_device_model_download`.
            app.manage(std::sync::Arc::new(
                ai::on_device::download::DownloadManager::new(data_dir.join("on_device_models")),
            ));
            // On-device LLM chat (Phase 2): asset manager for the JIT-downloaded
            // GGUF weights + `llama-server` sidecar binary. Layout lives under
            // `{app_data}/on-device-llm/` (separate from the embedding
            // `on_device_models/` dir) so the two asset classes never collide.
            // Wrapped in `Arc` to match the embedding manager (commands take
            // `State<Arc<…>>` so a spawned download task can clone the handle).
            let llm_asset_manager = std::sync::Arc::new(
                ai::on_device::llm_download::LlmAssetManager::new(data_dir.join("on-device-llm")),
            );
            // Best-effort sweep of orphaned `.part` files left by a killed
            // process (older than 7 days). Safe to run on every start — only
            // touches stale partials. Logged, never fatal.
            if let Err(e) = llm_asset_manager.sweep_stale_parts() {
                log::warn!("on-device-llm: stale .part sweep failed: {e}");
            }
            app.manage(llm_asset_manager);
            // On-device LLM chat (Phase 3 Task 2 + Task 3): the `llama-server`
            // sidecar lifecycle manager. Held as `Arc<LlamaServerManager>` in
            // managed state (commands take `State<Arc<…>>`); production defaults
            // to a 10-min idle timeout + 60s watcher tick. The background idle
            // watcher is spawned here (fire-and-forget — the runtime keeps the
            // JoinHandle alive) so a forgotten sidecar stops itself after idle.
            // App-exit cleanup is handled in the `RunEvent::ExitRequested` hook
            // below (`kill_sync`), and `Drop` is the defensive last resort.
            //
            // Task 3: wire a `TauriServerStatusSink` so every state transition
            // emits an `on-device-llm:server-status` event to the frontend. The
            // sink is the only Tauri coupling; the core module depends on the
            // trait alone, keeping `server.rs` free of any `tauri::*` import.
            let llama_server_manager =
                std::sync::Arc::new(ai::on_device::server::LlamaServerManager::new());
            llama_server_manager.set_sink(std::sync::Arc::new(
                commands::on_device_llm::TauriServerStatusSink::new(app.handle().clone()),
            ));
            // `spawn_idle_watcher` calls `tokio::spawn` internally (server.rs is
            // deliberately tauri-free), which panics without an active runtime.
            // The Tauri `setup` closure runs on the main thread with no reactor,
            // so hop onto Tauri's async runtime first — inside this task the
            // tokio context exists and the internal spawn succeeds. Matches the
            // `tauri::async_runtime::spawn` convention used for the indexing
            // worker (see `commands::ai::start_indexing_worker`).
            let watcher_manager = llama_server_manager.clone();
            tauri::async_runtime::spawn(async move {
                watcher_manager.spawn_idle_watcher();
            });
            app.manage(llama_server_manager);
            // Stub embedder backs the indexer until the user configures an
            // AI provider. With no provider, all AI commands return
            // `AI_NOT_CONFIGURED`; the stub keeps the trait wiring alive so
            // tests + the unconfigured save-path hook can run.
            log::info!("ai: stub embedder active — provider HTTP client lands in Phase 6 v2 R2.");
            app.manage(ai::indexer::EntryIndexer::with_stub());

            // Phase 2 Task 4: auto-start the continuous background-indexing
            // worker (`commands::ai::run_backfill_loop`) so dirty jobs drain
            // without the user ever clicking "Start indexing". Gated on an
            // embedding provider being configured AND
            // `embedding_features_enabled` — since the feature toggles default
            // on, the provider-configured check is what keeps an install with
            // no AI set up fully idle (no spawned task, no timer) until the
            // user opts in. The worker itself re-checks both gates every tick,
            // so a later in-session toggle is picked up once it's running; see
            // the `app:unlocked` listener below and `start_backfill`'s manual
            // entry point for the other two ways this same worker gets
            // (re)started.
            // Skipped for placeholder modes (`PasswordLocked` /
            // `BootFileCorrupt`) — `conn` is only the in-memory placeholder
            // until unlock/recovery, so there is nothing real to index yet;
            // the `app:unlocked` listener starts the worker once the real
            // connection is swapped in.
            if !using_placeholder {
                let should_autostart = app
                    .state::<AppState>()
                    .with_conn(|conn| {
                        let provider_configured = commands::ai_provider::slot_provider_class(
                            conn,
                            ai::provider::settings_keys::embed::PROVIDER,
                        )
                        .ok()
                        .flatten()
                        .is_some();
                        Ok(provider_configured
                            && commands::ai_settings::embedding_features_enabled(conn))
                    })
                    .unwrap_or(false);
                if should_autostart {
                    commands::ai::start_indexing_worker(app.handle().clone());
                }
            }

            // Cancel any in-flight backfill the moment the app locks. The
            // grace-period embedder swap that previously fired here is
            // gone — Phase 6 v2 has no on-device model session to release.
            let lock_app_handle = app.handle().clone();
            app.handle().listen("app:locked", move |_event| {
                let manager = lock_app_handle.state::<commands::ai::BackfillManager>();
                manager.cancel();
                let indexer = lock_app_handle.state::<ai::indexer::EntryIndexer>();
                indexer
                    .swappable()
                    .swap(ai::embedder::stub_embedder_for_indexer());
            });

            // Resume the background-indexing worker on unlock (mirrors the
            // `app:locked` cancel above). `start_indexing_worker` is a
            // double-spawn-safe no-op if a run is already in flight — the
            // gate re-check happens inside the worker's own tick, so this
            // listener doesn't need to read settings itself.
            let unlock_app_handle = app.handle().clone();
            app.handle().listen("app:unlocked", move |_event| {
                commands::ai::start_indexing_worker(unlock_app_handle.clone());
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Start the background sync scheduler. The scheduler is inert
            // until `sync_enabled` flips on + a provider is configured +
            // the encryption key is unlocked — so spawning it here before
            // the user has done any of those is free (`evaluate()` short-
            // circuits to `None`). Managed as state so a future shutdown
            // path can call `.stop()` on it.
            let scheduler = sync::scheduler::SyncScheduler::start(app.handle().clone());
            app.manage(scheduler);

            // Start the background reminder scheduler. Ticks every 60 s,
            // emits `reminder:fire` events for due reminders. The frontend
            // `useReminderNotifications` hook listens and calls the OS
            // notification API.
            let reminder_scheduler =
                reminders::scheduler::ReminderScheduler::start(app.handle().clone());
            app.manage(reminder_scheduler);

            // Start the background video-compression queue. Videos are
            // inserted immediately and transcoded off the UI path by this
            // worker; its startup sweep re-enqueues any row still held at
            // `awaiting_compression = 1` after a crash. Managed as state so
            // the ingest commands can enqueue jobs and CloseRequested can
            // stop it.
            let compression_queue =
                commands::compression::CompressionQueue::start(app.handle().clone());
            app.manage(compression_queue);

            // Traffic lights: config `trafficLightPosition` is gone (tao would
            // fight runtime moves); place the cluster ourselves and let the
            // frontend re-centre it when the titlebar row height changes.
            // Seed from `{app_data}/titlebar_row_height` (persisted-format
            // change; missing/invalid → 36) so Clay's 44px row is applied
            // before the webview loads.
            let titlebar_data_dir = app.path().app_data_dir().ok();
            app.manage(commands::window_chrome::TitlebarRowHeight::from_persisted(
                titlebar_data_dir.as_deref(),
            ));
            if let Some(main) = app.get_webview_window("main") {
                let _ = commands::window_chrome::apply(&main.as_ref().window());
            }

            // Phase 6 v2: idle-eviction tasks for the on-device embedder
            // and summary LLM are gone. Remote providers don't keep
            // process-resident state to evict; cancellation is per-call
            // via the `CancellationToken` plumbed through `AIProvider`.

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-settings" => {
                if let Err(e) = app.emit("menu:open-settings", ()) {
                    log::warn!("Failed to emit menu:open-settings: {e}");
                }
            }
            "new-entry" => {
                if let Err(e) = app.emit("menu:new-entry", ()) {
                    log::warn!("Failed to emit menu:new-entry: {e}");
                }
            }
            "new-entry-from-template" => {
                if let Err(e) = app.emit("menu:new-entry-from-template", ()) {
                    log::warn!("Failed to emit menu:new-entry-from-template: {e}");
                }
            }
            "new-journal" => {
                if let Err(e) = app.emit("menu:new-journal", ()) {
                    log::warn!("Failed to emit menu:new-journal: {e}");
                }
            }
            "sync-now" => {
                if let Err(e) = app.emit("menu:sync-now", ()) {
                    log::warn!("Failed to emit menu:sync-now: {e}");
                }
            }
            "close-tab" => {
                if let Err(e) = app.emit("menu:close-tab", ()) {
                    log::warn!("Failed to emit menu:close-tab: {e}");
                }
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            // AppKit rebuilds the titlebar on resize / fullscreen exit /
            // appearance or scale change, resetting the traffic lights — re-centre.
            if matches!(
                event,
                tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ThemeChanged(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                let _ = commands::window_chrome::apply(window);
            }
            // Window regained focus: let the scheduler drop any transient
            // sync backoff so a "Couldn't reach the cloud" state retries
            // on its next tick instead of waiting out the window. (Wake-
            // from-sleep is detected separately by the scheduler via the
            // wall-clock gap between ticks — see `slept_between_ticks`.)
            if let tauri::WindowEvent::Focused(true) = event {
                if let Some(scheduler) = window
                    .app_handle()
                    .try_state::<std::sync::Arc<sync::scheduler::SyncScheduler>>()
                {
                    scheduler.request_retry_now();
                }
            }
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app_handle = window.app_handle().clone();
                // Stop the background scheduler FIRST so it can't race
                // the final sync below — without this, a scheduler tick
                // firing between here and process exit would run a
                // second `run_sync_now` concurrently, both contending
                // for the AppState mutex. After `stop()`, the tokio
                // task exits on its next tick; any in-flight sync it
                // already started continues serially on its own thread.
                if let Some(scheduler) =
                    app_handle.try_state::<std::sync::Arc<sync::scheduler::SyncScheduler>>()
                {
                    scheduler.stop();
                }
                // Stop the reminder scheduler.
                if let Some(reminder_scheduler) = app_handle
                    .try_state::<std::sync::Arc<reminders::scheduler::ReminderScheduler>>()
                {
                    reminder_scheduler.stop();
                }
                // Stop the background compression queue.
                if let Some(compression_queue) = app_handle
                    .try_state::<std::sync::Arc<commands::compression::CompressionQueue>>()
                {
                    compression_queue.stop();
                }
                // Best-effort final push. Spawn the sync on a blocking
                // thread so we don't hang the close handler if the
                // provider is slow. The window closes regardless of the
                // sync outcome — local data is source-of-truth, missing
                // one push is recoverable on next launch.
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app_handle.state::<AppState>();
                    let key_state = app_handle.state::<EncryptionKeyState>();
                    let enabled = state
                        .lock()
                        .ok()
                        .and_then(|c| db::get_sync_enabled(&c).ok())
                        .unwrap_or(false);
                    if !enabled {
                        return;
                    }
                    // Only attempt if the key is loaded — a locked app
                    // has nothing useful to encrypt/decrypt anyway.
                    if !key_state.is_initialized().unwrap_or(false) {
                        return;
                    }
                    // Background final flush — not a user "Sync now", so
                    // Automatic: skip own-cloud reconcile if this session
                    // already reconciled successfully.
                    if let Err(e) = commands::sync::run_sync_now(
                        &app_handle,
                        &state,
                        &key_state,
                        sync::SyncTrigger::Automatic,
                    ) {
                        log::warn!("final sync on close failed: {e}");
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Journals
            commands::journals::create_journal,
            commands::journals::list_journals,
            commands::journals::get_journal,
            commands::journals::update_journal,
            commands::journals::delete_journal,
            commands::journals::list_journal_auto_tags,
            // Entries
            commands::entries::create_entry,
            commands::entries::list_entry_dates,
            commands::entries::list_entries_for_date_range,
            commands::entries::list_entries_by_tag_paged,
            commands::entries::list_entries_paged,
            commands::entries::list_all_entries_paged,
            commands::entries::list_favorite_entries_paged,
            commands::entries::list_on_this_day,
            commands::entries::count_entries_in_journal,
            commands::entries::get_entry,
            commands::entries::update_entry,
            commands::entries::soft_delete_entry,
            commands::entries::toggle_favorite,
            commands::entries::update_entry_emotion,
            commands::entries::update_entry_language,
            commands::entries::update_entry_location,
            commands::entries::update_entry_weather,
            commands::entries::update_entry_date,
            commands::entries::move_entry_to_journal,
            commands::entries::mark_entry_date_user_edited,
            commands::entries::list_map_pins,
            commands::entries::fetch_weather,
            commands::entries::save_entry_content,
            commands::entries::get_entry_content,
            commands::entries::get_emotion_by_date,
            // Version History (Phase 1)
            commands::entries::snapshot_entry_version,
            commands::entries::list_entry_versions,
            commands::entries::get_entry_version_content,
            commands::entries::get_version_retention_days,
            commands::entries::set_version_retention_days,
            // Tags
            commands::tags::create_tag,
            commands::tags::list_tags,
            commands::tags::delete_tag,
            commands::tags::update_tag,
            commands::tags::add_tag_to_entry,
            commands::tags::remove_tag_from_entry,
            commands::tags::get_tags_for_entry,
            commands::tags::get_tags_for_entries,
            commands::tags::get_tags_with_counts,
            // Settings
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::delete_setting,
            // Uninstall (Settings → General → Danger zone)
            commands::uninstall::uninstall_preview,
            commands::uninstall::uninstall_app,
            // Second lock
            commands::second_lock::second_lock_status,
            commands::second_lock::set_second_lock_password,
            commands::second_lock::change_second_lock_password,
            commands::second_lock::verify_second_lock_password,
            commands::second_lock::disable_second_lock,
            commands::second_lock::set_entry_locked,
            commands::second_lock::set_journal_locked,
            // Invisible multi-vault
            commands::invisible_lock::open_or_create_invisible_vault,
            commands::invisible_lock::change_invisible_vault_password,
            commands::invisible_lock::remove_empty_invisible_vaults,
            commands::invisible_lock::set_entry_invisible,
            commands::invisible_lock::set_journal_invisible,
            // Custom Google Fonts
            commands::fonts::download_google_font,
            commands::fonts::get_font_cache_stats,
            commands::fonts::clear_font_cache,
            commands::fonts::refresh_google_fonts_catalog,
            commands::fonts::search_google_fonts_catalog,
            commands::fonts::get_google_fonts_catalog_meta,
            // Search
            commands::search::search_entries,
            commands::search::semantic_search,
            // Crypto
            commands::crypto::verify_password,
            commands::crypto::change_password,
            commands::crypto::recover_with_passphrase,
            commands::crypto::initialize_encryption,
            commands::crypto::lock_encryption,
            commands::crypto::is_encryption_initialized,
            // Crypto — Password-only encryption model
            commands::crypto::get_encryption_mode,
            commands::crypto::get_startup_mode,
            // V2 first-time setup (replaces setup_first_time)
            commands::crypto::begin_first_time_setup,
            commands::crypto::confirm_first_time_setup,
            commands::crypto::cancel_first_time_setup,
            commands::crypto::get_pending_first_time_setup,
            // V2 onboarding (new device into existing vault)
            commands::crypto::onboard_validate_passphrase,
            commands::crypto::onboard_complete,
            // V2 device list
            commands::crypto::list_devices,
            commands::crypto::rename_device,
            commands::crypto::refresh_devices_from_cloud,
            // V2 rotation (Phase 5)
            commands::crypto::revoke_device,
            commands::crypto::remove_device,
            commands::crypto::rotate_master_key,
            commands::crypto::resume_rotation,
            commands::crypto::get_pending_rotation_recovery,
            commands::crypto::confirm_rotation_recovery_saved,
            commands::crypto::complete_force_re_pair,
            commands::crypto::get_force_re_pair_status,
            commands::gdrive::recheck_force_re_pair,
            // V2 full secret reset — Flow G (Phase 4)
            commands::crypto::reset_recovery_phrase,
            // Recovery sheet — 24-word export + QR (Phase 4)
            commands::recovery_sheet::render_recovery_sheet,
            commands::recovery_sheet::decode_recovery_qr_image,
            commands::recovery_sheet::decode_recovery_qr_file,
            // Keychain (biometric unlock)
            commands::keychain::is_biometric_available,
            commands::keychain::is_biometric_unlock_enabled,
            commands::keychain::enable_biometric_unlock,
            commands::keychain::disable_biometric_unlock,
            commands::keychain::unlock_with_biometric,
            // Media
            commands::media::pick_image,
            commands::media::pick_images_from_library,
            commands::media::pick_video,
            commands::media::pick_videos_from_library,
            commands::media::ensure_video_thumbnail,
            commands::media::pick_files_to_attach,
            commands::media::read_image_exif,
            commands::media::collect_entry_exif_dates,
            commands::media::collect_entry_exif_locations,
            commands::media::list_all_media_paged,
            commands::media::resolve_media,
            commands::media::resolve_media_thumbnail,
            commands::media::save_pasted_image,
            commands::media::get_media_status,
            commands::media::read_media_bytes,
            commands::media::read_media_thumbnail_bytes,
            commands::media::export_media_to_path,
            commands::media::list_media_for_entry,
            commands::media::delete_media,
            commands::media::update_media_insertion_mode,
            commands::media::get_media_cache_stats,
            commands::media::set_media_cache_limit,
            commands::media::clear_media_cache,
            commands::media::get_media_upload_limits,
            commands::media::set_media_upload_limits,
            commands::media::debug_list_media_status,
            commands::media::debug_retry_failed_uploads,
            // Streaks
            commands::streaks::get_streak,
            commands::streaks::recalculate_streak,
            // Templates
            commands::templates::create_template,
            commands::templates::list_templates,
            commands::templates::get_template,
            commands::templates::update_template,
            commands::templates::delete_template,
            // Sync (Chunks 3a + 3c)
            commands::sync::get_device_id,
            commands::sync::get_sync_status,
            commands::cloud::icloud_availability,
            commands::cloud::cloud_folder_connect,
            commands::sync::get_sync_catchup_status,
            commands::sync::set_sync_enabled,
            commands::sync::sync_now,
            commands::sync::push_entry,
            commands::sync::get_sync_settings,
            commands::sync::set_sync_settings,
            commands::sync::sync_reset_local_state,
            commands::sync::sync_repair_from_this_device,
            commands::sync::get_sync_scope_upgrade_required,
            commands::sync::clear_sync_scope_upgrade_required,
            // Google Drive (Chunk 4)
            commands::gdrive::gdrive_begin_connect,
            commands::gdrive::gdrive_cancel_connect,
            commands::gdrive::gdrive_complete_connect,
            commands::gdrive::gdrive_disconnect,
            commands::gdrive::gdrive_wipe_cloud,
            commands::gdrive::gdrive_preflight_local_authoritative_recovery,
            commands::gdrive::gdrive_rebuild_cloud_from_local,
            commands::gdrive::gdrive_finalize_local_authoritative_recovery,
            commands::gdrive::gdrive_begin_cloud_authoritative_staging,
            commands::gdrive::gdrive_materialize_cloud_authoritative_staging,
            commands::gdrive::gdrive_commit_cloud_authoritative_restore,
            commands::gdrive::get_sync_recovery_status,
            commands::gdrive::gdrive_cancel_sync_recovery,
            commands::gdrive::gdrive_resume_sync_recovery,
            commands::gdrive::gdrive_get_status,
            commands::gdrive::gdrive_refresh_storage_quota,
            commands::gdrive::gdrive_test_connection,
            // Google Drive — debug only (stripped from production binary)
            #[cfg(debug_assertions)]
            commands::gdrive::gdrive_dev_repair_keyring,
            #[cfg(debug_assertions)]
            commands::gdrive::gdrive_dev_dump_keyring,
            // Demo seed — debug only (stripped from production binary)
            #[cfg(debug_assertions)]
            commands::seed_demo::seed_demo_data,
            #[cfg(debug_assertions)]
            commands::seed_demo::seed_demo_status,
            // Window chrome
            commands::window_chrome::set_titlebar_row_height,
            // Location Aliases
            commands::location::create_location_alias,
            commands::location::list_location_aliases,
            commands::location::get_location_alias,
            commands::location::update_location_alias,
            commands::location::delete_location_alias,
            commands::location::find_nearby_aliases,
            // Audio recording (Chunk D1)
            commands::audio::start_recording,
            commands::audio::stop_recording,
            commands::audio::save_audio_memo,
            commands::audio::discard_audio_memo,
            commands::audio::read_audio_memo_bytes,
            commands::audio::get_recording_levels,
            // Export (E1/E2)
            commands::export::export_data,
            commands::export::write_markdown_zip,
            // Import (E3)
            commands::import::import_data,
            commands::import::preview_apple_journal_import,
            commands::import::write_apple_journal_import_report,
            // Geocoding
            commands::geocoding::geocode_search,
            commands::geocoding::geocode_resolve,
            commands::geocoding::geocode_reverse,
            commands::geocoding::geocode_check,
            // Reminders
            commands::reminders::list_reminders,
            commands::reminders::create_reminder,
            commands::reminders::update_reminder,
            commands::reminders::delete_reminder,
            // Stats (S1)
            commands::stats::stats_entries_over_time,
            commands::stats::stats_mood_histogram,
            commands::stats::stats_mood_trend,
            commands::stats::stats_emotion_trend,
            commands::stats::stats_tag_frequency,
            commands::stats::stats_writing_volume,
            commands::stats::stats_streak_calendar,
            commands::stats::stats_location_density,
            // Stats export
            commands::stats_export::export_stats_file,
            // AI (Phase 6 — A1 + A2)
            commands::ai::list_models,
            commands::ai::delete_model,
            commands::ai::is_ai_supported,
            commands::ai::download_model,
            commands::ai::cancel_download,
            commands::ai::start_backfill,
            commands::ai::pause_backfill,
            commands::ai::get_backfill_status,
            commands::ai::get_embedding_index_stats,
            commands::ai::get_embedding_job_stats,
            commands::ai::init_embedding_service,
            commands::ai::dispose_embedding_service,
            commands::ai::suggest_emotion,
            commands::ai::suggest_title,
            commands::ai::cancel_suggestion,
            commands::ai::summarise_entry,
            // Phase 6 v2 R7 — entry highlights
            commands::ai::generate_entry_highlights,
            commands::ai::get_entry_highlights,
            commands::ai::clear_entry_highlights,
            // Phase 6 v2 R8 — Go Deeper prompts
            commands::ai::go_deeper,
            commands::ai::rewrite_selection,
            commands::ai::continue_writing,
            commands::suggest_tags::suggest_tags,
            // Phase 6 v2 R9 — Daily Chat
            commands::ai::daily_chat_send_turn,
            commands::ai::convert_chat_to_entry,
            commands::ai::convert_chat_delta_to_entry,
            commands::ai::daily_chat_mark_converted,
            commands::ai::chat_session_for_entry,
            commands::ai::daily_chat_create_session,
            commands::ai::daily_chat_list_sessions_paged,
            commands::ai::daily_chat_load_session,
            commands::ai::daily_chat_delete_session,
            commands::ai::daily_chat_rename_session,
            commands::ai::daily_chat_set_session_pinned,
            commands::ai::daily_chat_generate_title,
            // RAG in Daily Chat — attachment picker + context preflight (Phase 4 T4.8)
            commands::ai::chat_search_attachable_entries,
            commands::ai::chat_count_entries_in_range,
            commands::ai::chat_rag_preflight,
            // Phase 6 v2 R10 — image gen + multi-entry summary
            commands::ai::generate_inline_image,
            commands::ai::summarise_entries,
            commands::ai::generate_period_review,
            commands::ai::get_period_review,
            commands::ai::generate_theme_insights,
            commands::ai::get_cached_theme_insights,
            // Two-slot AI provider config (R11+) — gen + embed configured independently.
            // Embed-sync decision modal (entry + memory slots) — get/resolve
            // device-local receipts; FE modal wires in a later phase.
            commands::ai_embedding_decision::get_embedding_sync_decisions,
            commands::ai_embedding_decision::resolve_embedding_sync_decision,
            commands::ai_provider::set_ai_generation_provider,
            commands::ai_provider::set_ai_embedding_provider,
            commands::ai_provider::get_ai_providers,
            commands::ai_provider::forget_ai_generation_provider,
            commands::ai_provider::set_ai_image_provider,
            commands::ai_provider::forget_ai_image_provider,
            commands::ai_provider::forget_ai_embedding_provider,
            commands::ai_provider::test_ai_generation_provider,
            commands::ai_provider::test_ai_embedding_provider,
            commands::ai_provider::check_cli_provider_health,
            // Per-preset credential registry (T1.6) — additive; no frontend
            // caller yet (see docs/plans/2026-08-05-ai-settings-providers-tab/).
            commands::ai_provider::get_ai_provider_credentials,
            commands::ai_provider::set_ai_provider_credential,
            commands::ai_provider::forget_ai_provider_credential,
            commands::ai_provider::test_ai_provider_credential,
            // On-device embedding model catalog + download (Phase 4 Task 2)
            commands::ai_provider::list_on_device_models,
            commands::ai_provider::get_on_device_model_state,
            commands::ai_provider::start_on_device_model_download,
            commands::ai_provider::cancel_on_device_model_download,
            commands::ai_provider::remove_on_device_model,
            // On-device LLM chat model catalog + download (Phase 2 Task 3) +
            // sidecar lifecycle status (Phase 3 Task 3)
            commands::on_device_llm::list_on_device_llm_models,
            commands::on_device_llm::download_on_device_llm_model,
            commands::on_device_llm::cancel_on_device_llm_download,
            commands::on_device_llm::delete_on_device_llm_model,
            commands::on_device_llm::get_on_device_llm_server_status,
            commands::on_device_llm::on_device_llm_binary_status,
            commands::on_device_llm::delete_on_device_llm_binary,
            // Offline world PMTiles basemap (Phase 3 T11)
            commands::basemap::download_basemap,
            commands::basemap::cancel_basemap_download,
            commands::basemap::basemap_status,
            commands::basemap::read_basemap_range,
            commands::basemap::delete_basemap,
            commands::basemap::get_mapkit_token,
            // AI feature toggles + privacy receipt + v2 migration (Phase 6 v2 — R3)
            commands::ai_settings::get_ai_settings,
            commands::ai_settings::accept_ai_privacy,
            commands::ai_settings::accept_ai_bulk_context,
            commands::ai_settings::set_ai_feature,
            commands::ai_settings::ai_v2_migrate,
            commands::ai_settings::set_daily_chat_preferences,
            commands::ai_settings::set_daily_chat_ai_title,
            commands::ai_settings::set_emotion_suggestion_language,
            commands::ai_settings::set_ai_response_language,
            commands::ai_settings::set_ai_feature_prompt,
            commands::ai_settings::get_background_indexing_settings,
            commands::ai_settings::set_background_indexing_enabled,
            commands::ai_settings::accept_background_indexing_hosted_consent,
            // AI User Memory model slots (Phase 2 T2.3) — independent, on-machine
            // by default, generation + embedding slot pair, written with write-time
            // enforcement (hosted/CLI allowed only with `ai_memory_allow_hosted` on).
            commands::ai_settings::set_memory_gen_provider,
            commands::ai_settings::set_memory_embed_provider,
            // Atomic write + registry-reconcile for the `ai_memory_allow_hosted`
            // flag (review F4/F8) — persists the setting and either rejects
            // (turn-off) or re-hydrates (turn-on) both memory slots in the
            // same command, so the DB and the in-memory registry can never
            // disagree. Supersedes the old two-call
            // set_setting-then-reject-on-manual-off flow for this key.
            commands::ai_settings::set_memory_allow_hosted,
            // Kept for the standalone re-check path (also exercised directly
            // in Rust tests); `set_memory_allow_hosted` above is the one the
            // frontend calls for the flag itself.
            commands::ai_settings::reject_disallowed_memory_slots,
            // AI User Memory extraction (Phase 3 T3.2) + scan pass (T3.3) —
            // core extraction fn, apply-ops logic, content-hash-diff scan +
            // manual trigger. Background worker loop lands in T3.4.
            commands::ai_memory::extract_memories_for_source_command,
            commands::ai_memory::scan_memories,
            commands::ai_memory::consolidate_memories_command,
            commands::ai_memory::build_persona,
            commands::ai_memory::get_persona,
            commands::ai_memory::write_persona_answers,
            commands::ai_memory::write_persona_user_edit,
            commands::ai_memory::set_persona_enabled,
            // AI User Memory item management (Phase 5 T5.1) — list / edit text
            // / enable-disable / soft-delete the distilled memory rows.
            commands::ai_memory::list_memory_items,
            commands::ai_memory::update_memory_item_text,
            commands::ai_memory::set_memory_enabled,
            commands::ai_memory::delete_memory_item,
            // I11: get_memory_include_protected / set_memory_include_protected
            // removed — the frontend reads/writes
            // settings_keys::MEMORY_INCLUDE_PROTECTED through the generic
            // get_setting/set_setting commands instead (see
            // commands/ai_memory.rs for the backend read path).
            // AI audit log (Phase 6 Stretch S2-2 + S3 usage dashboard)
            commands::ai_audit::list_ai_audit_log,
            commands::ai_audit::clear_ai_audit_log,
            commands::ai_audit::get_ai_audit_retention_days,
            commands::ai_audit::set_ai_audit_retention_days,
            commands::ai_audit::summarize_ai_usage,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Phase 3 Task 2: on app exit, synchronously SIGKILL the
            // `llama-server` sidecar so no orphan process survives the app.
            // `kill_sync` does a no-grace SIGKILL (fast, guaranteed) and is
            // idempotent. It deliberately does NOT need a runtime handle — it
            // signals the process group directly. (`Drop` on the manager is the
            // defensive backup; this hook is the primary app-exit path.)
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(mgr) =
                    app.try_state::<std::sync::Arc<ai::on_device::server::LlamaServerManager>>()
                {
                    mgr.kill_sync();
                }
            }
        });
}
