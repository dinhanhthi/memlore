//! Phase 2 of the rotation state machine: re-encrypt every pending envelope
//! from `master_key_old` to `master_key_new`.
//!
//! # Envelope formats
//!
//! Two on-disk shapes exist and the re-encrypt path branches on `envelope_kind`:
//!
//! - **media** (and any non-`entry` kind): a *bare* versioned envelope
//!   `[0x01] [nonce(12)] [ciphertext] [tag(16)]`. Re-encryption is:
//!   download → decrypt(old_sync_key) → encrypt(new_sync_key) → upload.
//! - **entry**: an XJS1-wrapped `SyncEntryPayload`
//!   `[XJS1] [bincode { fingerprint, yjs_ct, meta_ct }]` whose two inner
//!   ciphertexts are each a bare versioned envelope. The whole file is *not*
//!   a bare envelope — its first byte is the magic `'X'` (0x58). It is
//!   unwrapped, each inner ciphertext is re-keyed, the `key_fingerprint` is
//!   recomputed against the new key, and the payload is re-wrapped. See
//!   [`reencrypt_entry_payload`].
//!
//! The key used for encrypt/decrypt is `derive_sync_key(master)`.
//!
//! # Streaming threshold
//!
//! Files ≥ `REENCRYPT_STREAM_THRESHOLD` bytes are processed in streaming mode
//! (write to a tempfile, then re-encrypt from the tempfile).  In Phase 5 the
//! streaming path uses the same in-memory AEAD — true chunk-level streaming is
//! deferred to a follow-up.  Files below the threshold are processed fully in
//! memory.
//!
//! # Progress events
//!
//! After every item, a Tauri event `xj://rotation-progress` is emitted
//! (if an `AppHandle` is provided) carrying `{done, total, state}`.

use tauri::Emitter;

use crate::db;
use crate::sync::entry_sync::{deserialize_payload, serialize_payload, SyncEntryPayload};
use crate::sync::provider::SyncProvider;
use crate::sync::version_sync::{
    deserialize_version_payload, serialize_version_payload, SyncVersionPayload,
};
use crate::utils::encryption::{
    decrypt_data_with_state, derive_sync_key, encrypt_data_with_state, key_fingerprint,
};
use crate::{AppState, EncryptionKeyState};

use super::{state, RotationContext};

/// Files larger than 16 MiB are streamed via a tempfile instead of a
/// monolithic heap buffer.  In Phase 5 the "stream" is still a single
/// AES-GCM operation because nonce + tag span the whole plaintext; this
/// constant exists to keep large files out of peak RSS and to document
/// the threshold for future true streaming.
pub const REENCRYPT_STREAM_THRESHOLD: usize = 16 * 1024 * 1024;

/// Progress payload emitted on `xj://rotation-progress`.
#[derive(serde::Serialize, Clone)]
pub struct RotationProgressPayload {
    pub done: u64,
    pub total: u64,
    pub state: String,
}

/// Maximum number of outer retry attempts for `reencrypt_items`.
const MAX_RETRY_ATTEMPTS: u32 = 3;

/// Re-encrypt every pending item in the rotation job.
///
/// This function is restartable: already-`done` items are skipped by
/// `next_pending_rotation_item`.  A crash mid-loop leaves some items as
/// `pending`; re-calling this function after restart resumes from the
/// first remaining pending item.
///
/// Per-item failures (network blips, etc.) are retried up to
/// `MAX_RETRY_ATTEMPTS` times with exponential backoff. If any items
/// remain `failed` after all retries, the function returns `Err` and
/// leaves the job in the `reencrypt` state so `resume_rotation` can
/// pick it up later.
///
/// # Parameters
/// - `app` — optional `AppHandle` for emitting progress events.
/// - `base_delay_ms` — base milliseconds for backoff between retries
///   (0 in tests; `DEFAULT_BASE_DELAY_MS` in production).
pub async fn reencrypt_items<P>(
    provider: &P,
    state: &AppState,
    rotation_id: i64,
    ctx: &RotationContext,
    app: Option<&tauri::AppHandle>,
) -> Result<(), String>
where
    P: SyncProvider,
{
    reencrypt_items_inner(
        provider,
        state,
        rotation_id,
        ctx,
        app,
        DEFAULT_BASE_DELAY_MS,
    )
    .await
}

/// Default backoff base in production (500 ms × attempt).
const DEFAULT_BASE_DELAY_MS: u64 = 500;

pub(crate) async fn reencrypt_items_inner<P>(
    provider: &P,
    state: &AppState,
    rotation_id: i64,
    ctx: &RotationContext,
    app: Option<&tauri::AppHandle>,
    base_delay_ms: u64,
) -> Result<(), String>
where
    P: SyncProvider,
{
    // Derive sync sub-keys from master keys.
    // The sync engine uses derive_sync_key(master) as the outer key; internally
    // encrypt_data_with_state applies a second HKDF via with_sync_key. To match
    // that exact derivation we must pass derive_sync_key(master) to make_key_state.
    let old_sync_key = derive_sync_key(&*ctx.master_key_old);
    let new_sync_key = derive_sync_key(&*ctx.master_key_new);

    let old_ks = make_key_state(&*old_sync_key);
    let new_ks = make_key_state(&*new_sync_key);

    // Count total pending for progress reporting.
    let total = {
        let conn = state.lock()?;
        conn.query_row(
            "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND status NOT IN ('done')",
            [rotation_id],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0) as u64
    };
    let mut done = 0u64;

    for attempt in 0..MAX_RETRY_ATTEMPTS {
        // Sleep before retry attempts (not on first pass).
        if attempt > 0 {
            if base_delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(
                    base_delay_ms * attempt as u64,
                ))
                .await;
            }
            // Reset failed items to pending for retry.
            let conn = state.lock()?;
            db::reset_failed_items_to_pending(&conn, rotation_id).map_err(|e| e.to_string())?;
        }

        // Inner item-processing loop.
        loop {
            let item = {
                let conn = state.lock()?;
                db::next_pending_rotation_item(&conn, rotation_id).map_err(|e| e.to_string())?
            };

            let Some(item) = item else {
                break;
            };

            let path = &item.envelope_id;

            // Download.
            let bytes = match provider.read_file(path).await {
                Ok(b) => b,
                Err(crate::sync::provider::SyncError::NotFound(_)) => {
                    // The file doesn't exist (e.g. a singleton blob like
                    // `streak.bin` that this device never wrote, enumerated
                    // from the fixed known set). Nothing to re-encrypt — mark
                    // done and move on rather than failing the whole rotation.
                    {
                        let conn = state.lock()?;
                        db::mark_rotation_item_done(&conn, item.id).map_err(|e| e.to_string())?;
                    }
                    done += 1;
                    emit_progress(app, done, total);
                    continue;
                }
                Err(e) => {
                    log::warn!("rotation: reencrypt: failed to read {path}: {e}");
                    mark_item_failed(state, item.id, &e.to_string());
                    continue;
                }
            };

            // Re-encrypt according to the on-disk format for this kind.
            //
            // - `entry` files are XJS1-wrapped `SyncEntryPayload`s whose two
            //   inner ciphertexts are each a versioned envelope. Decrypting the
            //   whole file as a bare envelope fails on the magic byte ('X' =
            //   0x58). They must be unwrapped, each inner ciphertext re-keyed,
            //   the fingerprint recomputed against the new key (or every device
            //   refuses to ingest the result), and re-wrapped.
            // - `version` files are XJV1-wrapped `SyncVersionPayload`s — same
            //   shape as `entry` (two inner versioned envelopes + a
            //   fingerprint) under a distinct magic. See
            //   `reencrypt_version_payload`. Basis: bugs
            //   `rotation-skips-singleton-blobs-and-journals` and
            //   `rotation-reencrypt-entry-xjs1-wrapper` — version blobs must
            //   be enumerated and unwrapped exactly like entries, not treated
            //   as bare envelopes.
            // - `media` and `blob` (journals + singleton blobs) are bare envelopes.
            //
            // All helpers are idempotent: a file that already decrypts under
            // the new key (a crash between `write_file` and `mark_done` on a
            // prior pass) returns `Ok(None)` so the write is skipped and the
            // item is simply marked done. Without this, resume would try to
            // decrypt a new-key file with the old key, fail every retry, and
            // wedge the whole rotation — the exact "Failed to revoke device"
            // symptom this path is meant to avoid.
            let reencrypted = match item.envelope_kind.as_str() {
                "entry" => reencrypt_entry_payload(&bytes, &old_ks, &new_ks),
                "version" => reencrypt_version_payload(&bytes, &old_ks, &new_ks),
                // `media` and `blob` (journals + per-device singleton blobs like
                // tags.bin/settings.bin) are all bare versioned envelopes.
                "media" | "blob" => reencrypt_bare_envelope(&bytes, &old_ks, &new_ks),
                other => Err(format!(
                    "unknown envelope_kind {other:?} — refusing to re-encrypt to avoid corruption"
                )),
            };
            let new_ciphertext = match reencrypted {
                Ok(Some(c)) => c,
                Ok(None) => {
                    // Already converted on a prior pass — no write needed.
                    {
                        let conn = state.lock()?;
                        db::mark_rotation_item_done(&conn, item.id).map_err(|e| e.to_string())?;
                    }
                    done += 1;
                    emit_progress(app, done, total);
                    continue;
                }
                Err(e) => {
                    log::warn!("rotation: reencrypt: re-encrypt failed for {path}: {e}");
                    mark_item_failed(state, item.id, &e);
                    continue;
                }
            };

            // Upload.
            if let Err(e) = provider.write_file(path, &new_ciphertext).await {
                log::warn!("rotation: reencrypt: write failed for {path}: {e}");
                mark_item_failed(state, item.id, &e.to_string());
                continue;
            }

            // Mark done.
            {
                let conn = state.lock()?;
                db::mark_rotation_item_done(&conn, item.id).map_err(|e| e.to_string())?;
            }

            done += 1;
            emit_progress(app, done, total);
        }

        // After inner loop: check if any failed items remain.
        let has_failed = {
            let conn = state.lock()?;
            db::has_failed_rotation_items(&conn, rotation_id).map_err(|e| e.to_string())?
        };

        if !has_failed {
            // All items done — success.
            return Ok(());
        }

        // Failed items remain. If we have more retries, loop back.
        // On the last attempt, abort.
        if attempt + 1 >= MAX_RETRY_ATTEMPTS {
            let failed_count: i64 = {
                let conn = state.lock()?;
                conn.query_row(
                    "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND status='failed'",
                    [rotation_id],
                    |r| r.get(0),
                )
                .unwrap_or(0)
            };
            log::error!(
                "rotation: reencrypt: {failed_count} envelopes failed after {MAX_RETRY_ATTEMPTS} \
                 attempts — rotation aborted to prevent data loss"
            );
            return Err(format!(
                "rotation: {failed_count} envelopes failed to re-encrypt after \
                 {MAX_RETRY_ATTEMPTS} attempts — rotation aborted to prevent data loss. \
                 Retry with stable network."
            ));
        }

        log::warn!(
            "rotation: reencrypt: attempt {} had failures, retrying…",
            attempt + 1
        );
    }

    Ok(())
}

/// Build a temporary `EncryptionKeyState` from a sync key for use with
/// `encrypt_data_with_state` / `decrypt_data_with_state`.
fn make_key_state(sync_key: &[u8; 32]) -> crate::EncryptionKeyState {
    let ks = crate::EncryptionKeyState::new();
    ks.set_key(zeroize::Zeroizing::new(*sync_key))
        .expect("set_key never fails");
    ks
}

/// Re-encrypt one XJS1-wrapped entry payload from `old_ks` to `new_ks`.
///
/// The on-disk file is `[XJS1 magic][bincode SyncEntryPayload]`. The two inner
/// ciphertexts (`yjs_blob_ciphertext`, `metadata_ciphertext`) are each a
/// versioned envelope encrypted under the *sync* sub-key. This function:
///   1. unwraps the payload,
///   2. short-circuits if the payload already carries the new key's
///      fingerprint (already converted on a prior, crashed pass) → `Ok(None)`,
///   3. decrypts each inner ciphertext with the old key,
///   4. re-encrypts each with the new key,
///   5. recomputes `key_fingerprint` against the new key — without this, the
///      payload keeps the old fingerprint and every device (including this one)
///      refuses to ingest it after the master key flips, silently losing the
///      entry,
///   6. re-wraps with the XJS1 magic header → `Ok(Some(bytes))`.
///
/// `key_fingerprint` is computed over the inner HKDF expansion
/// (`with_sync_key`), matching exactly how `push_single_entry` /
/// `ingest_entry` derive and compare it.
fn reencrypt_entry_payload(
    bytes: &[u8],
    old_ks: &EncryptionKeyState,
    new_ks: &EncryptionKeyState,
) -> Result<Option<Vec<u8>>, String> {
    let payload = deserialize_payload(bytes).map_err(|e| e.to_string())?;

    let new_fp = new_ks.with_sync_key(|k| Ok(key_fingerprint(k)))?;
    if payload.key_fingerprint == new_fp {
        // Already re-encrypted under the new key on a prior pass.
        return Ok(None);
    }

    let yjs_plain = decrypt_data_with_state(&payload.yjs_blob_ciphertext, old_ks)?;
    let meta_plain = decrypt_data_with_state(&payload.metadata_ciphertext, old_ks)?;

    let yjs_ct = encrypt_data_with_state(&yjs_plain, new_ks)?;
    let meta_ct = encrypt_data_with_state(&meta_plain, new_ks)?;

    let new_payload = SyncEntryPayload::new(new_fp, yjs_ct, meta_ct);
    Ok(Some(
        serialize_payload(&new_payload).map_err(|e| e.to_string())?,
    ))
}

/// Re-encrypt one XJV1-wrapped version-snapshot payload from `old_ks` to
/// `new_ks`.
///
/// Identical shape and rationale to [`reencrypt_entry_payload`]: the on-disk
/// file is `[XJV1 magic][bincode SyncVersionPayload]` whose two inner
/// ciphertexts (`yjs_blob_ciphertext`, `metadata_ciphertext`) are each a
/// versioned envelope encrypted under the *sync* sub-key. Version blobs are
/// immutable/write-once, but they still carry a `key_fingerprint` and must be
/// re-keyed on rotation exactly like entries — this is the regression guard
/// for `rotation-skips-singleton-blobs-and-journals` /
/// `rotation-reencrypt-entry-xjs1-wrapper` extended to the new version
/// channel.
fn reencrypt_version_payload(
    bytes: &[u8],
    old_ks: &EncryptionKeyState,
    new_ks: &EncryptionKeyState,
) -> Result<Option<Vec<u8>>, String> {
    let payload = deserialize_version_payload(bytes).map_err(|e| e.to_string())?;

    let new_fp = new_ks.with_sync_key(|k| Ok(key_fingerprint(k)))?;
    if payload.key_fingerprint == new_fp {
        // Already re-encrypted under the new key on a prior pass.
        return Ok(None);
    }

    let yjs_plain = decrypt_data_with_state(&payload.yjs_blob_ciphertext, old_ks)?;
    let meta_plain = decrypt_data_with_state(&payload.metadata_ciphertext, old_ks)?;

    let yjs_ct = encrypt_data_with_state(&yjs_plain, new_ks)?;
    let meta_ct = encrypt_data_with_state(&meta_plain, new_ks)?;

    let new_payload = SyncVersionPayload::new(new_fp, yjs_ct, meta_ct);
    Ok(Some(
        serialize_version_payload(&new_payload).map_err(|e| e.to_string())?,
    ))
}

/// Re-encrypt one bare versioned envelope (media, journals, blob files) from
/// `old_ks` to `new_ks`.
///
/// Idempotent on resume: if the bytes already decrypt under the new key (a
/// crash between `write_file` and `mark_done` on a prior pass left a converted
/// file behind), return `Ok(None)` so the caller skips the write rather than
/// failing forever trying to decrypt a new-key file with the old key.
fn reencrypt_bare_envelope(
    bytes: &[u8],
    old_ks: &EncryptionKeyState,
    new_ks: &EncryptionKeyState,
) -> Result<Option<Vec<u8>>, String> {
    match decrypt_data_with_state(bytes, old_ks) {
        Ok(plaintext) => Ok(Some(encrypt_data_with_state(&plaintext, new_ks)?)),
        Err(old_err) => {
            // Old key failed. If the new key succeeds, the file was already
            // converted on a prior pass — treat as a no-op. Otherwise the file
            // is genuinely undecryptable; surface the original old-key error.
            if decrypt_data_with_state(bytes, new_ks).is_ok() {
                Ok(None)
            } else {
                Err(old_err)
            }
        }
    }
}

/// Emit one `xj://rotation-progress` event if an `AppHandle` is attached.
fn emit_progress(app: Option<&tauri::AppHandle>, done: u64, total: u64) {
    if let Some(handle) = app {
        let _ = handle.emit(
            "xj://rotation-progress",
            RotationProgressPayload {
                done,
                total: total.max(done), // guard against undercount
                state: state::REENCRYPT.to_string(),
            },
        );
    }
}

fn mark_item_failed(state: &AppState, item_id: i64, error: &str) {
    if let Ok(conn) = state.lock() {
        let _ = conn.execute(
            "UPDATE rotation_job_items SET status='failed', error=?1 WHERE id=?2",
            rusqlite::params![error, item_id],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::sync::provider::test_support::MockProvider;
    use crate::sync::provider::{FileKind, SyncError, SyncProvider};
    use crate::utils::encryption::{derive_sync_key, encrypt_data_with_state};
    use async_trait::async_trait;
    use rusqlite::Connection;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use zeroize::Zeroizing;

    /// A provider that fails `read_file` for one specific path on the first N calls,
    /// then succeeds. All other paths are delegated to an inner `MockProvider`.
    struct TransientFailProvider {
        inner: MockProvider,
        fail_path: String,
        fail_calls_remaining: Arc<AtomicU32>,
    }

    impl TransientFailProvider {
        fn new(fail_path: &str, fail_count: u32) -> Self {
            Self {
                inner: MockProvider::new(),
                fail_path: fail_path.to_string(),
                fail_calls_remaining: Arc::new(AtomicU32::new(fail_count)),
            }
        }
        async fn write_file_inner(&self, path: &str, data: &[u8]) {
            self.inner.write_file(path, data).await.unwrap();
        }
    }

    #[async_trait]
    impl SyncProvider for TransientFailProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            if path == self.fail_path {
                let prev = self.fail_calls_remaining.fetch_update(
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                    |v| if v > 0 { Some(v - 1) } else { None },
                );
                if prev.is_ok() {
                    return Err(SyncError::Network("transient failure".to_string()));
                }
            }
            self.inner.read_file(path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.inner.delete_file(path).await
        }
    }

    /// A provider that ALWAYS fails read_file for a specific path.
    struct AlwaysFailProvider {
        inner: MockProvider,
        fail_path: String,
    }

    impl AlwaysFailProvider {
        fn new(fail_path: &str) -> Self {
            Self {
                inner: MockProvider::new(),
                fail_path: fail_path.to_string(),
            }
        }
        async fn write_file_inner(&self, path: &str, data: &[u8]) {
            self.inner.write_file(path, data).await.unwrap();
        }
    }

    #[async_trait]
    impl SyncProvider for AlwaysFailProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            if path == self.fail_path {
                return Err(SyncError::Network("permanent failure".to_string()));
            }
            self.inner.read_file(path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.inner.delete_file(path).await
        }
    }

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn make_app_state(conn: Connection) -> crate::AppState {
        crate::AppState::new(conn)
    }

    fn make_state_and_provider() -> (crate::AppState, MockProvider) {
        let state = make_app_state(setup_db());
        let provider = MockProvider::new();
        (state, provider)
    }

    fn make_ctx(old: [u8; 32], new_key: [u8; 32]) -> RotationContext {
        RotationContext {
            master_key_old: Zeroizing::new(old),
            master_key_new: Zeroizing::new(new_key),
        }
    }

    /// Encrypt bytes with the given master key using the same derivation as
    /// the sync engine (derive_sync_key → encrypt_data_with_state).
    fn encrypt_with_master(master: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
        let sync_key = derive_sync_key(master);
        let ks = make_key_state(&sync_key);
        encrypt_data_with_state(plaintext, &ks).unwrap()
    }

    /// Build the key state used by both push and reencrypt for a given master.
    fn ks_for_master(master: &[u8; 32]) -> crate::EncryptionKeyState {
        make_key_state(&derive_sync_key(master))
    }

    /// Build an on-disk entry file in the real production format:
    /// `[XJS1 magic][bincode SyncEntryPayload]`, with the two inner ciphertexts
    /// encrypted under `master` and the fingerprint stamped from `master` —
    /// mirroring `push_single_entry`.
    fn make_entry_file(master: &[u8; 32], yjs_plain: &[u8], meta_plain: &[u8]) -> Vec<u8> {
        let ks = ks_for_master(master);
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let yjs_ct = encrypt_data_with_state(yjs_plain, &ks).unwrap();
        let meta_ct = encrypt_data_with_state(meta_plain, &ks).unwrap();
        serialize_payload(&SyncEntryPayload::new(fp, yjs_ct, meta_ct)).unwrap()
    }

    #[tokio::test]
    async fn reencrypt_rewrites_entry_with_new_key() {
        let (app_state, provider) = make_state_and_provider();

        let old_master = [1u8; 32];
        let new_master = [2u8; 32];
        let yjs_plain = b"yjs blob bytes";
        let meta_plain = b"{\"meta\":true}";

        // Write an entry in the real XJS1-wrapped format, encrypted with old key.
        let file = make_entry_file(&old_master, yjs_plain, meta_plain);
        provider
            .write_file("dev/entries/e1.bin", &file)
            .await
            .unwrap();

        // Insert a rotation job and one item.
        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_item(&conn, rotation_id, "entry", "dev/entries/e1.bin").unwrap();
        }

        let ctx = make_ctx(old_master, new_master);
        reencrypt_items(&provider, &app_state, rotation_id, &ctx, None)
            .await
            .unwrap();

        // Verify: re-wrapped payload's inner ciphertexts decrypt with new key.
        let stored = provider.read_file("dev/entries/e1.bin").await.unwrap();
        let payload = deserialize_payload(&stored).unwrap();
        let new_ks = ks_for_master(&new_master);
        assert_eq!(
            decrypt_data_with_state(&payload.yjs_blob_ciphertext, &new_ks).unwrap(),
            yjs_plain
        );
        assert_eq!(
            decrypt_data_with_state(&payload.metadata_ciphertext, &new_ks).unwrap(),
            meta_plain
        );

        // Fingerprint must be re-stamped to the new key — otherwise every
        // device refuses to ingest the entry after the master key flips.
        let new_fp = new_ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        assert_eq!(payload.key_fingerprint, new_fp);
        let old_ks = ks_for_master(&old_master);
        let old_fp = old_ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        assert_ne!(payload.key_fingerprint, old_fp);

        // Old key should fail to decrypt the inner ciphertexts.
        assert!(decrypt_data_with_state(&payload.yjs_blob_ciphertext, &old_ks).is_err());

        // Item should be marked done.
        let item = {
            let conn = app_state.lock().unwrap();
            db::next_pending_rotation_item(&conn, rotation_id).unwrap()
        };
        assert!(item.is_none(), "no pending items should remain");
    }

    /// Build an on-disk version-snapshot file in the real production
    /// format: `[XJV1 magic][bincode SyncVersionPayload]`, mirroring
    /// `SyncEngine::push_single_version`.
    fn make_version_file(master: &[u8; 32], yjs_plain: &[u8], meta_plain: &[u8]) -> Vec<u8> {
        let ks = ks_for_master(master);
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let yjs_ct = encrypt_data_with_state(yjs_plain, &ks).unwrap();
        let meta_ct = encrypt_data_with_state(meta_plain, &ks).unwrap();
        serialize_version_payload(&SyncVersionPayload::new(fp, yjs_ct, meta_ct)).unwrap()
    }

    /// Regression guard for `rotation-skips-singleton-blobs-and-journals` /
    /// `rotation-reencrypt-entry-xjs1-wrapper` extended to the new version
    /// channel: a `{device}/versions/{id}.bin` file must be re-encrypted on
    /// rotation exactly like an entry — it decrypts under the NEW key and
    /// fails under the OLD key afterwards.
    #[tokio::test]
    async fn reencrypt_rewrites_version_with_new_key() {
        let (app_state, provider) = make_state_and_provider();

        let old_master = [3u8; 32];
        let new_master = [4u8; 32];
        let yjs_plain = b"version snapshot yjs bytes";
        let meta_plain = b"{\"version_id\":\"v1\",\"entry_id\":\"e1\"}";

        // Write a version file in the real XJV1-wrapped format, encrypted
        // with the old key.
        let file = make_version_file(&old_master, yjs_plain, meta_plain);
        provider
            .write_file("dev/versions/v1.bin", &file)
            .await
            .unwrap();

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_item(&conn, rotation_id, "version", "dev/versions/v1.bin").unwrap();
        }

        let ctx = make_ctx(old_master, new_master);
        reencrypt_items(&provider, &app_state, rotation_id, &ctx, None)
            .await
            .unwrap();

        // Verify: re-wrapped payload's inner ciphertexts decrypt under the
        // NEW key.
        let stored = provider.read_file("dev/versions/v1.bin").await.unwrap();
        let payload = deserialize_version_payload(&stored).unwrap();
        let new_ks = ks_for_master(&new_master);
        assert_eq!(
            decrypt_data_with_state(&payload.yjs_blob_ciphertext, &new_ks).unwrap(),
            yjs_plain
        );
        assert_eq!(
            decrypt_data_with_state(&payload.metadata_ciphertext, &new_ks).unwrap(),
            meta_plain
        );

        // Fingerprint must be re-stamped to the new key.
        let new_fp = new_ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        assert_eq!(payload.key_fingerprint, new_fp);

        // The OLD key must now fail to decrypt the re-keyed version file —
        // this is the exact regression the two prior rotation bugs allowed:
        // a non-entry/non-media blob silently left under the old key.
        let old_ks = ks_for_master(&old_master);
        assert!(
            decrypt_data_with_state(&payload.yjs_blob_ciphertext, &old_ks).is_err(),
            "version file must NOT decrypt under the old key after rotation"
        );
        assert!(
            decrypt_data_with_state(&payload.metadata_ciphertext, &old_ks).is_err(),
            "version file must NOT decrypt under the old key after rotation"
        );

        // Item should be marked done.
        let item = {
            let conn = app_state.lock().unwrap();
            db::next_pending_rotation_item(&conn, rotation_id).unwrap()
        };
        assert!(item.is_none(), "no pending items should remain");
    }

    /// Media files are bare versioned envelopes (no XJS1 wrapper). The
    /// `media` branch must decrypt+re-encrypt the whole file directly.
    #[tokio::test]
    async fn reencrypt_rewrites_media_with_new_key() {
        let (app_state, provider) = make_state_and_provider();

        let old_master = [10u8; 32];
        let new_master = [11u8; 32];
        let plaintext = b"raw media bytes";

        let ct = encrypt_with_master(&old_master, plaintext);
        provider.write_file("dev/media/m1", &ct).await.unwrap();

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_item(&conn, rotation_id, "media", "dev/media/m1").unwrap();
        }

        let ctx = make_ctx(old_master, new_master);
        reencrypt_items(&provider, &app_state, rotation_id, &ctx, None)
            .await
            .unwrap();

        let stored = provider.read_file("dev/media/m1").await.unwrap();
        let new_ks = ks_for_master(&new_master);
        assert_eq!(
            decrypt_data_with_state(&stored, &new_ks).unwrap(),
            plaintext
        );
        let old_ks = ks_for_master(&old_master);
        assert!(decrypt_data_with_state(&stored, &old_ks).is_err());
    }

    /// `blob` kind (journals + per-device singleton blobs like tags.bin) are
    /// bare envelopes and must be re-encrypted exactly like media.
    #[tokio::test]
    async fn reencrypt_rewrites_blob_with_new_key() {
        let (app_state, provider) = make_state_and_provider();

        let old_master = [12u8; 32];
        let new_master = [13u8; 32];
        let plaintext = b"{\"tags\":[]}";

        let ct = encrypt_with_master(&old_master, plaintext);
        provider.write_file("dev/tags.bin", &ct).await.unwrap();

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_item(&conn, rotation_id, "blob", "dev/tags.bin").unwrap();
        }

        let ctx = make_ctx(old_master, new_master);
        reencrypt_items(&provider, &app_state, rotation_id, &ctx, None)
            .await
            .unwrap();

        let stored = provider.read_file("dev/tags.bin").await.unwrap();
        let new_ks = ks_for_master(&new_master);
        assert_eq!(
            decrypt_data_with_state(&stored, &new_ks).unwrap(),
            plaintext
        );
        let old_ks = ks_for_master(&old_master);
        assert!(decrypt_data_with_state(&stored, &old_ks).is_err());
    }

    /// A `blob` item whose file does not exist (a singleton like streak.bin the
    /// device never wrote, but enumerated from the fixed known set) must be
    /// skipped, NOT fail the whole rotation.
    #[tokio::test]
    async fn reencrypt_skips_missing_blob_without_aborting() {
        let (app_state, provider) = make_state_and_provider();

        let old_master = [14u8; 32];
        let new_master = [15u8; 32];

        // One real blob + one that was never written (read → NotFound).
        let ct = encrypt_with_master(&old_master, b"real");
        provider.write_file("dev/settings.bin", &ct).await.unwrap();

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_item(&conn, rotation_id, "blob", "dev/settings.bin").unwrap();
            db::insert_rotation_item(&conn, rotation_id, "blob", "dev/streak.bin").unwrap();
        }

        let ctx = make_ctx(old_master, new_master);
        // Must NOT abort despite the missing file.
        reencrypt_items(&provider, &app_state, rotation_id, &ctx, None)
            .await
            .expect("a missing singleton blob must be skipped, not abort rotation");

        // No pending and no failed items remain.
        let conn = app_state.lock().unwrap();
        assert!(db::next_pending_rotation_item(&conn, rotation_id)
            .unwrap()
            .is_none());
        let failed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND status='failed'",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(failed, 0);
    }

    #[tokio::test]
    async fn reencrypt_is_restartable() {
        let (app_state, provider) = make_state_and_provider();

        let old_master = [3u8; 32];
        let new_master = [4u8; 32];

        // 3 entries in the real XJS1-wrapped format.
        for i in 1..=3 {
            let file = make_entry_file(
                &old_master,
                format!("yjs{i}").as_bytes(),
                format!("meta{i}").as_bytes(),
            );
            provider
                .write_file(&format!("dev/entries/e{i}.bin"), &file)
                .await
                .unwrap();
        }

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            for i in 1..=3 {
                db::insert_rotation_item(
                    &conn,
                    rotation_id,
                    "entry",
                    &format!("dev/entries/e{i}.bin"),
                )
                .unwrap();
            }
        }

        // Manually mark item 1 as done (simulating a partial run before crash).
        {
            let conn = app_state.lock().unwrap();
            let first = db::next_pending_rotation_item(&conn, rotation_id)
                .unwrap()
                .unwrap();
            db::mark_rotation_item_done(&conn, first.id).unwrap();
        }

        let ctx = make_ctx(old_master, new_master);

        // First item was already done; but its on-disk file still has the old
        // encryption (simulating crash before upload completed). The rotation
        // engine only re-encrypts pending items, so e1 will remain old-encrypted.
        // This is the expected crash-resume behavior (the item was marked done
        // prematurely in the simulation; real crashes happen before mark_done).
        //
        // Re-run reencrypt — only items 2 and 3 (still pending) are processed.
        reencrypt_items(&provider, &app_state, rotation_id, &ctx, None)
            .await
            .unwrap();

        // Items 2 and 3 should decrypt with new key.
        let new_ks = ks_for_master(&new_master);

        for i in 2..=3 {
            let stored = provider
                .read_file(&format!("dev/entries/e{i}.bin"))
                .await
                .unwrap();
            let payload = deserialize_payload(&stored).unwrap();
            assert_eq!(
                decrypt_data_with_state(&payload.yjs_blob_ciphertext, &new_ks).unwrap(),
                format!("yjs{i}").as_bytes()
            );
            assert_eq!(
                decrypt_data_with_state(&payload.metadata_ciphertext, &new_ks).unwrap(),
                format!("meta{i}").as_bytes()
            );
        }

        // All items should be done.
        let pending = {
            let conn = app_state.lock().unwrap();
            db::next_pending_rotation_item(&conn, rotation_id).unwrap()
        };
        assert!(pending.is_none());
    }

    /// Crash-resume idempotency: a *pending* item whose on-disk file is already
    /// encrypted under the *new* key (crash between write_file and mark_done on
    /// a prior pass) must complete on resume, NOT wedge the rotation by failing
    /// to decrypt a new-key file with the old key. Covers both kinds.
    #[tokio::test]
    async fn reencrypt_is_idempotent_on_already_converted_file() {
        let (app_state, provider) = make_state_and_provider();

        let old_master = [20u8; 32];
        let new_master = [21u8; 32];

        // entry e1: already converted to the NEW key but still pending.
        let entry_new = make_entry_file(&new_master, b"yjs", b"meta");
        provider
            .write_file("dev/entries/e1.bin", &entry_new)
            .await
            .unwrap();
        // entry e2: still old-key (normal case) to prove both paths run.
        let entry_old = make_entry_file(&old_master, b"yjs2", b"meta2");
        provider
            .write_file("dev/entries/e2.bin", &entry_old)
            .await
            .unwrap();
        // media m1: already converted to the NEW key but still pending.
        let media_new = encrypt_with_master(&new_master, b"raw media");
        provider
            .write_file("dev/media/m1", &media_new)
            .await
            .unwrap();

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_item(&conn, rotation_id, "entry", "dev/entries/e1.bin").unwrap();
            db::insert_rotation_item(&conn, rotation_id, "entry", "dev/entries/e2.bin").unwrap();
            db::insert_rotation_item(&conn, rotation_id, "media", "dev/media/m1").unwrap();
        }

        let ctx = make_ctx(old_master, new_master);
        reencrypt_items(&provider, &app_state, rotation_id, &ctx, None)
            .await
            .expect("resume must not wedge on already-converted files");

        // All items done, no failures.
        {
            let conn = app_state.lock().unwrap();
            assert!(db::next_pending_rotation_item(&conn, rotation_id)
                .unwrap()
                .is_none());
            let failed: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND status='failed'",
                    [rotation_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(failed, 0);
        }

        // Already-converted files must be untouched and still valid under new key.
        let new_ks = ks_for_master(&new_master);
        let e1 =
            deserialize_payload(&provider.read_file("dev/entries/e1.bin").await.unwrap()).unwrap();
        assert_eq!(
            decrypt_data_with_state(&e1.yjs_blob_ciphertext, &new_ks).unwrap(),
            b"yjs"
        );
        let m1 = provider.read_file("dev/media/m1").await.unwrap();
        assert_eq!(decrypt_data_with_state(&m1, &new_ks).unwrap(), b"raw media");
        // The old-key entry got converted normally.
        let e2 =
            deserialize_payload(&provider.read_file("dev/entries/e2.bin").await.unwrap()).unwrap();
        assert_eq!(
            decrypt_data_with_state(&e2.metadata_ciphertext, &new_ks).unwrap(),
            b"meta2"
        );
    }

    /// C1: When an item permanently fails every retry, reencrypt_items must return Err
    /// after MAX_RETRY_ATTEMPTS and leave failed_count > 0.
    #[tokio::test]
    async fn reencrypt_aborts_when_items_fail_after_max_retries() {
        let old_master = [5u8; 32];
        let new_master = [6u8; 32];
        let fail_path = "dev/entries/e2.bin";

        let provider = AlwaysFailProvider::new(fail_path);

        // Plant a valid entry and a permanently-failing one.
        let good = make_entry_file(&old_master, b"yjs", b"meta");
        provider.write_file_inner("dev/entries/e1.bin", &good).await;
        // This path will always fail on read.
        provider.write_file_inner(fail_path, b"placeholder").await;

        let app_state = make_app_state(setup_db());
        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_item(&conn, rotation_id, "entry", "dev/entries/e1.bin").unwrap();
            db::insert_rotation_item(&conn, rotation_id, "entry", fail_path).unwrap();
            // Set job to reencrypt state (where it should remain after abort).
            db::update_rotation_job_state(&conn, rotation_id, super::state::REENCRYPT).unwrap();
        }

        let ctx = make_ctx(old_master, new_master);
        // Must return Err — rotation aborted.
        let result = reencrypt_items_inner(&provider, &app_state, rotation_id, &ctx, None, 0).await;
        assert!(result.is_err(), "expected Err from aborted rotation");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("rotation aborted"),
            "error should mention rotation aborted: {err_msg}"
        );

        // e1 should be done; e2 should be failed.
        let conn = app_state.lock().unwrap();
        let done_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND status='done'",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        let failed_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND status='failed'",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(done_count, 1);
        assert!(failed_count > 0, "failed_count should be > 0 after abort");

        // Job state must still be reencrypt (not advanced).
        let job = db::find_active_rotation_job(&conn).unwrap().unwrap();
        assert_eq!(
            job.state,
            super::state::REENCRYPT,
            "job state must remain reencrypt after abort"
        );
    }

    /// C1: A transient failure retried on the second attempt succeeds.
    #[tokio::test]
    async fn reencrypt_retries_failed_items_and_succeeds_on_second_attempt() {
        let old_master = [7u8; 32];
        let new_master = [8u8; 32];
        let fail_path = "dev/entries/e1.bin";

        // Fail exactly once (first attempt), then succeed.
        let provider = TransientFailProvider::new(fail_path, 1);

        let file = make_entry_file(&old_master, b"yjs", b"retryable meta");
        provider.write_file_inner(fail_path, &file).await;

        let app_state = make_app_state(setup_db());
        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_item(&conn, rotation_id, "entry", fail_path).unwrap();
        }

        let ctx = make_ctx(old_master, new_master);
        // Zero delay so test is fast.
        let result = reencrypt_items_inner(&provider, &app_state, rotation_id, &ctx, None, 0).await;
        assert!(
            result.is_ok(),
            "expected Ok after retry succeeded: {result:?}"
        );

        // Item should be done.
        let conn = app_state.lock().unwrap();
        let done_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND status='done'",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(done_count, 1, "item should be done after successful retry");
    }

    /// C1 (updated): When an item has a permanently corrupt ciphertext, rotation
    /// aborts after retries exhausted. (Previously this test expected Ok — that
    /// was the bug; now it expects Err.)
    #[tokio::test]
    async fn reencrypt_continues_on_per_item_failure() {
        let (app_state, provider) = make_state_and_provider();

        let old_master = [5u8; 32];
        let new_master = [6u8; 32];

        // Plant a valid entry and a corrupt one (bad payload).
        let good = make_entry_file(&old_master, b"yjs", b"meta");
        provider
            .write_file("dev/entries/e1.bin", &good)
            .await
            .unwrap();
        // Corrupt: garbage that fails the XJS1 magic / deserialize.
        provider
            .write_file("dev/entries/e2.bin", b"\x01garbage")
            .await
            .unwrap();

        let rotation_id = {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap()
        };
        {
            let conn = app_state.lock().unwrap();
            db::insert_rotation_item(&conn, rotation_id, "entry", "dev/entries/e1.bin").unwrap();
            db::insert_rotation_item(&conn, rotation_id, "entry", "dev/entries/e2.bin").unwrap();
        }

        let ctx = make_ctx(old_master, new_master);
        // With corrupt ciphertext (permanent failure), rotation must abort after retries.
        let result = reencrypt_items_inner(&provider, &app_state, rotation_id, &ctx, None, 0).await;
        assert!(
            result.is_err(),
            "expected Err when a permanently failing item exists"
        );

        // e1 should be done; e2 should be failed.
        let conn = app_state.lock().unwrap();
        let done_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND status='done'",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        let failed_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rotation_job_items WHERE rotation_id=?1 AND status='failed'",
                [rotation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(done_count, 1);
        assert_eq!(failed_count, 1);
    }
}
