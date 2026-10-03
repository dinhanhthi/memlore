use std::sync::Mutex;
use zeroize::Zeroizing;

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
                let sub_key = crate::encryption::derive_sqlcipher_key(&list.db_key);
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
            let sub_key = crate::encryption::derive_sync_key(latest_content);
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
                let sub_key = crate::encryption::derive_sync_key(k);
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
                    let sub_key = crate::encryption::derive_sync_key(k);
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
                    let sync_k = crate::encryption::derive_sync_key(content_k);
                    let candidate_fp = crate::encryption::key_fingerprint(&*sync_k);
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
    #[doc(hidden)]
    pub fn try_all_sync_keys(&self, inner: &[u8]) -> Result<Vec<u8>, String> {
        let guard = self.lock_key();
        match guard.as_ref() {
            Some(list) => {
                let mut epochs: Vec<u32> = list.keys.keys().copied().collect();
                epochs.sort_unstable(); // ascending: try oldest first (epoch 1 most likely)
                let mut last_err = "try_all_sync_keys: key list is empty".to_string();
                for epoch in epochs {
                    let k = list.keys.get(&epoch).expect("epoch from same map");
                    let sub_key = crate::encryption::derive_sync_key(k);
                    match crate::encryption::decrypt_data(&*sub_key, inner) {
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
            let fp = crate::encryption::key_fingerprint(sync_k);
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
                    let sync_k = crate::encryption::derive_sync_key(k);
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
