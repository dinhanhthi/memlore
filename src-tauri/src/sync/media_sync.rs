//! Media upload/download helpers for the sync engine.
//!
//! Wraps `utils::encryption::encrypt_data_with_state_epoch` /
//! `decrypt_data_with_state` and speaks to any `SyncProvider` using the path
//! convention `{device_id}/media/{media_id}`.
//!
//! **Always encrypted.** Every byte written to cloud storage is AES-256-GCM
//! ciphertext with a version-byte prefix — there is no plaintext mode. The
//! regression test `media_file_does_not_leak_plaintext` in engine.rs pins
//! the password-mode invariant.
//!
//! **Wire format (Phase 5):** `[version_byte(1)] [payload]`
//! - `0x01` — AES-256-GCM v1 (nonce 12 || ciphertext || tag 16), legacy
//! - `0x02` — AES-256-GCM v2 epoch-tagged (epoch 4 LE || nonce 12 || ct || tag 16)
//!
//! Always encrypted: there is no `0x00` plaintext envelope. A stray `0x00`
//! byte on the wire is dead data — it falls through to an unknown-version
//! error, never a case to handle.
//!
//! New writes use `0x02` so each envelope carries the content-key epoch that
//! encrypted it.  Decryption handles `0x01` for legacy media that pre-dates
//! epoch tagging, and `0x02` for all new uploads.  After a key rotation, old
//! media stays sealed under its original epoch; legitimate devices hold the
//! full content-key list and can decrypt any epoch.

use crate::sync::provider::{SyncError, SyncProvider};
use crate::utils::encryption::{decrypt_data_with_state, encrypt_data_with_state_epoch};

/// Encrypt raw media bytes for upload.
///
/// The output is always `[0x02] ++ epoch(4 LE) ++ AES-256-GCM(nonce ||
/// ciphertext || tag)`. The epoch is taken from the latest content-key epoch
/// in `key_state`.
///
/// The caller is responsible for passing the correct state — the engine reads
/// it from the snapshot built in `run_sync_now`; `resolve_media` /
/// `resolve_media_thumbnail` read it from a per-call snapshot of the app's
/// `EncryptionKeyState`.
pub fn encrypt_media_bytes(
    key_state: &crate::EncryptionKeyState,
    plaintext: &[u8],
) -> Result<Vec<u8>, SyncError> {
    encrypt_data_with_state_epoch(plaintext, key_state)
        .map_err(|e| SyncError::Io(format!("encrypt_media: {e}")))
}

/// Decrypt media bytes received from cloud.
///
/// Handles all version-byte prefixes:
/// - `0x01` — legacy AES-256-GCM v1 (selects the latest sync key, matching
///   the derivation depth used by the old upload path).
/// - `0x02` — epoch-tagged AES-256-GCM v2 (selects the content key for
///   the epoch stamped in the envelope, enabling multi-epoch key selection
///   after a content-key rotation).
///
/// Never panics on truncated or malformed envelopes — returns `Err`.
pub fn decrypt_media_bytes(
    key_state: &crate::EncryptionKeyState,
    ciphertext: &[u8],
) -> Result<Vec<u8>, SyncError> {
    decrypt_data_with_state(ciphertext, key_state)
        .map_err(|e| SyncError::Io(format!("decrypt_media: {e}")))
}

/// Download a single media file from the provider, decrypt it, write to
/// `cache_path`, and return `cache_path` as a string.
///
/// This is the on-demand fetch path used by `resolve_media` — it does NOT
/// run during the background sync tick (pull_remote stays entry-only for 6a).
pub async fn fetch_media(
    provider: &dyn SyncProvider,
    key_state: &crate::EncryptionKeyState,
    media_id: &str,
    device_id: &str,
    cache_path: &std::path::Path,
) -> Result<String, SyncError> {
    let remote_path = format!("{device_id}/media/{media_id}");
    fetch_to(provider, key_state, &remote_path, cache_path).await
}

/// Download and decrypt a media thumbnail. The thumbnail's remote path is
/// `{device_id}/media/{media_id}.thumb` by convention.
pub async fn fetch_media_thumbnail(
    provider: &dyn SyncProvider,
    key_state: &crate::EncryptionKeyState,
    media_id: &str,
    device_id: &str,
    cache_path: &std::path::Path,
) -> Result<String, SyncError> {
    let remote_path = format!("{device_id}/media/{media_id}.thumb");
    fetch_to(provider, key_state, &remote_path, cache_path).await
}

/// Shared fetch helper — read + decrypt + write to a cache path.
async fn fetch_to(
    provider: &dyn SyncProvider,
    key_state: &crate::EncryptionKeyState,
    remote_path: &str,
    cache_path: &std::path::Path,
) -> Result<String, SyncError> {
    let ciphertext = provider.read_file(remote_path).await?;
    let plaintext = decrypt_media_bytes(key_state, &ciphertext)?;
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| SyncError::Io(e.to_string()))?;
    }
    std::fs::write(cache_path, &plaintext).map_err(|e| SyncError::Io(e.to_string()))?;
    cache_path
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| SyncError::Io("non-UTF-8 cache path".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::provider::test_support::MockProvider;
    use crate::sync::provider::FileKind;
    use crate::utils::encryption::KEY_SIZE;
    use std::sync::Arc;
    use tempfile::TempDir;

    /// Build a single-epoch [`crate::EncryptionKeyState`] from a raw key.
    /// Mirrors what `SyncEngine::make_key_state` does internally.
    fn make_real_key_state(raw_key: &[u8; KEY_SIZE]) -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        ks.set_key(zeroize::Zeroizing::new(*raw_key))
            .expect("set_key never fails");
        ks
    }

    fn test_key() -> [u8; KEY_SIZE] {
        [42u8; KEY_SIZE]
    }

    // ── Encrypt / Decrypt roundtrip ──────────────────────────────────────────

    #[test]
    fn encrypt_decrypt_roundtrip_preserves_bytes() {
        let key = test_key();
        let ks = make_real_key_state(&key);
        let plaintext = b"hello media bytes";
        let ct = encrypt_media_bytes(&ks, plaintext).unwrap();
        let pt = decrypt_media_bytes(&ks, &ct).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn password_mode_envelope_starts_with_0x02() {
        let key = test_key();
        let ks = make_real_key_state(&key);
        let ct = encrypt_media_bytes(&ks, b"data").unwrap();
        assert_eq!(
            ct[0], 0x02,
            "password-mode media envelope must start with 0x02 (AES-GCM v2 epoch-tagged)"
        );
    }

    #[test]
    fn epoch_is_stamped_in_v2_envelope() {
        let key = test_key();
        let ks = make_real_key_state(&key);
        let ct = encrypt_media_bytes(&ks, b"epoch test").unwrap();
        // 0x02 envelope layout: [0x02][epoch u32 LE 4 bytes][nonce 12][ct][tag 16]
        assert_eq!(ct[0], 0x02);
        let epoch = u32::from_le_bytes([ct[1], ct[2], ct[3], ct[4]]);
        // Single-epoch state built from set_key always has epoch=1.
        assert_eq!(
            epoch, 1,
            "epoch must be stamped as 1 for a single-epoch key state"
        );
    }

    #[test]
    fn decrypt_with_wrong_key_returns_decrypt_error() {
        let key1 = [1u8; KEY_SIZE];
        let key2 = [2u8; KEY_SIZE];
        let ks1 = make_real_key_state(&key1);
        let ks2 = make_real_key_state(&key2);
        let ct = encrypt_media_bytes(&ks1, b"secret").unwrap();
        let err = decrypt_media_bytes(&ks2, &ct).unwrap_err().to_string();
        assert!(
            err.contains("decrypt_media"),
            "error must come from decrypt_media path, got: {err:?}"
        );
    }

    /// Regression: the engine's push path encrypts media with the HKDF-derived
    /// `sync_key`, so the on-demand resolve path on a peer MUST decrypt with the
    /// same key derivation depth.  Both push (via snapshot) and resolve (via
    /// snapshot) must use the same two-HKDF depth.  This test pins symmetry.
    #[test]
    fn snapshot_based_encrypt_decrypt_are_symmetric() {
        use crate::utils::encryption::derive_sync_key;
        let raw_content_key = [0x77u8; KEY_SIZE];

        // Simulate what snapshot_for_engine does: pre-derive once.
        let pre_derived = derive_sync_key(&raw_content_key);
        let snapshot = crate::EncryptionKeyState::new();
        snapshot
            .set_key(zeroize::Zeroizing::new(*pre_derived))
            .expect("set_key never fails");

        let plaintext = b"voice memo bytes";
        let ct = encrypt_media_bytes(&snapshot, plaintext).unwrap();

        // Roundtrip MUST work when both sides use the same snapshot depth.
        let pt = decrypt_media_bytes(&snapshot, &ct).unwrap();
        assert_eq!(pt, plaintext);

        // Decrypting with the raw (un-pre-derived) state MUST fail —
        // this is the exact failure that the C1 fix prevents.
        let raw_state = make_real_key_state(&raw_content_key);
        assert!(
            decrypt_media_bytes(&raw_state, &ct).is_err(),
            "snapshot-encrypted ciphertext must fail to decrypt with un-pre-derived state"
        );
    }

    #[test]
    fn ciphertext_does_not_contain_plaintext_marker() {
        let key = test_key();
        let ks = make_real_key_state(&key);
        let marker = b"PLAINTEXT_MARKER_DO_NOT_UPLOAD";
        let ct = encrypt_media_bytes(&ks, marker).unwrap();
        // Check that no contiguous 8-byte window of marker appears in ct
        let window = &marker[..8];
        let ct_str = &ct[..];
        for i in 0..ct_str.len().saturating_sub(8) {
            assert_ne!(
                &ct_str[i..i + 8],
                window,
                "plaintext marker found in ciphertext at offset {i}"
            );
        }
    }

    // ── Multi-epoch roundtrip (C1 regression guard) ──────────────────────────

    /// Encrypt under epoch 1, rotate to epoch 2, verify epoch-1 media can still
    /// be decrypted (epoch-tagged selection picks the right key).
    #[test]
    fn media_epoch_tagged_roundtrip_two_epochs() {
        use crate::utils::encryption::derive_sync_key;
        use std::collections::BTreeMap;

        let content_key_1 = zeroize::Zeroizing::new([0x11u8; KEY_SIZE]);
        let content_key_2 = zeroize::Zeroizing::new([0x22u8; KEY_SIZE]);

        // Build epoch-1-only state (the "push at epoch 1" snapshot).
        let mut keys_1: BTreeMap<u32, zeroize::Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
        keys_1.insert(
            1,
            zeroize::Zeroizing::new(*derive_sync_key(&*content_key_1)),
        );
        let snap_1 = crate::EncryptionKeyState::new();
        snap_1
            .set_content_state(
                keys_1,
                1,
                zeroize::Zeroizing::new([0u8; KEY_SIZE]),
                zeroize::Zeroizing::new([0u8; KEY_SIZE]),
            )
            .expect("set_content_state");

        // Encrypt media under epoch 1.
        let plaintext = b"old media from epoch 1";
        let ct_epoch1 = encrypt_media_bytes(&snap_1, plaintext).unwrap();
        // V2 envelope must exist and stamp epoch=1.
        assert_eq!(ct_epoch1[0], 0x02, "must be V2 epoch-tagged");
        let stamped_epoch =
            u32::from_le_bytes([ct_epoch1[1], ct_epoch1[2], ct_epoch1[3], ct_epoch1[4]]);
        assert_eq!(stamped_epoch, 1, "epoch 1 must be stamped");

        // Simulate rotation: build a 2-epoch snapshot (what the device holds after rotation).
        let mut keys_12: BTreeMap<u32, zeroize::Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
        keys_12.insert(
            1,
            zeroize::Zeroizing::new(*derive_sync_key(&*content_key_1)),
        );
        keys_12.insert(
            2,
            zeroize::Zeroizing::new(*derive_sync_key(&*content_key_2)),
        );
        let snap_12 = crate::EncryptionKeyState::new();
        snap_12
            .set_content_state(
                keys_12,
                2, // latest is epoch 2
                zeroize::Zeroizing::new([0u8; KEY_SIZE]),
                zeroize::Zeroizing::new([0u8; KEY_SIZE]),
            )
            .expect("set_content_state");

        // Decrypt epoch-1 media using the 2-epoch snapshot — must succeed.
        let decrypted = decrypt_media_bytes(&snap_12, &ct_epoch1).unwrap();
        assert_eq!(
            decrypted, plaintext,
            "epoch-1 media must decrypt with 2-epoch snapshot"
        );

        // Encrypt new media under epoch 2 (latest).
        let new_plaintext = b"new media from epoch 2";
        let ct_epoch2 = encrypt_media_bytes(&snap_12, new_plaintext).unwrap();
        let stamped_epoch2 =
            u32::from_le_bytes([ct_epoch2[1], ct_epoch2[2], ct_epoch2[3], ct_epoch2[4]]);
        assert_eq!(stamped_epoch2, 2, "new media must be stamped with epoch 2");

        // Epoch-2 media must decrypt with the 2-epoch snapshot.
        let decrypted2 = decrypt_media_bytes(&snap_12, &ct_epoch2).unwrap();
        assert_eq!(decrypted2, new_plaintext);

        // Epoch-2 media must NOT decrypt with epoch-1-only snapshot.
        assert!(
            decrypt_media_bytes(&snap_1, &ct_epoch2).is_err(),
            "epoch-2 media must fail with epoch-1-only snapshot (key not in list)"
        );
    }

    // ── fetch_media ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn fetch_media_downloads_decrypts_and_caches() {
        let key = test_key();
        let ks = make_real_key_state(&key);
        let plaintext = b"original media content";
        let ciphertext = encrypt_media_bytes(&ks, plaintext).unwrap();

        let provider = Arc::new(MockProvider::new());
        let media_id = "aaaabbbbccccdddd"; // 16 chars — safe component
        let device_id = "device-xyz";
        let remote_path = format!("{device_id}/media/{media_id}");
        provider
            .write_file(&remote_path, &ciphertext)
            .await
            .unwrap();

        let dir = TempDir::new().unwrap();
        let cache_path = dir.path().join("cached_media");

        let result = fetch_media(provider.as_ref(), &ks, media_id, device_id, &cache_path).await;
        assert!(result.is_ok(), "fetch_media failed: {:?}", result.err());

        let cached = std::fs::read(&cache_path).unwrap();
        assert_eq!(cached, plaintext, "decrypted bytes must match original");
    }

    #[tokio::test]
    async fn fetch_media_returns_error_when_not_found() {
        let key = test_key();
        let ks = make_real_key_state(&key);
        let provider = Arc::new(MockProvider::new());
        let dir = TempDir::new().unwrap();
        let cache_path = dir.path().join("missing");
        let result = fetch_media(
            provider.as_ref(),
            &ks,
            "nonexistent-id",
            "dev-x",
            &cache_path,
        )
        .await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), SyncError::NotFound(_)));
    }

    /// Roundtrip test: simulate what the engine does (encrypt + write_file)
    /// then verify fetch_media recovers the original plaintext.
    #[tokio::test]
    async fn push_then_fetch_roundtrip_recovers_original_bytes() {
        let key = test_key();
        let ks = make_real_key_state(&key);
        let original = b"roundtrip image data 1234567890";
        let media_id = "aaaabbbbccccdddd";
        let device_id = "device-1";

        let provider = Arc::new(MockProvider::new());

        // Simulate the engine's upload: encrypt then write_file directly.
        let ciphertext = encrypt_media_bytes(&ks, original).unwrap();
        let remote_path = format!("{device_id}/media/{media_id}");
        provider
            .write_file(&remote_path, &ciphertext)
            .await
            .unwrap();

        // Fetch to a cache path — should recover the original plaintext.
        let dir = TempDir::new().unwrap();
        let cache_path = dir.path().join("fetched");
        let result = fetch_media(provider.as_ref(), &ks, media_id, device_id, &cache_path).await;
        assert!(result.is_ok(), "fetch_media failed: {:?}", result.err());

        let fetched = std::fs::read(&cache_path).unwrap();
        assert_eq!(fetched, original, "decrypted bytes must match the original");
    }

    #[tokio::test]
    async fn fetch_media_thumbnail_uses_thumb_suffix() {
        let key = test_key();
        let ks = make_real_key_state(&key);
        let media_id = "aaaabbbbccccdddd";
        let device_id = "dev-t";
        let plaintext = b"mock-thumbnail-jpeg-bytes";
        let ciphertext = encrypt_media_bytes(&ks, plaintext).unwrap();

        let provider = Arc::new(MockProvider::new());
        let remote_path = format!("{device_id}/media/{media_id}.thumb");
        provider
            .write_file(&remote_path, &ciphertext)
            .await
            .unwrap();

        let dir = TempDir::new().unwrap();
        let cache_path = dir.path().join("thumb.jpg");
        let result =
            fetch_media_thumbnail(provider.as_ref(), &ks, media_id, device_id, &cache_path).await;
        assert!(
            result.is_ok(),
            "fetch_media_thumbnail failed: {:?}",
            result.err()
        );

        let cached = std::fs::read(&cache_path).unwrap();
        assert_eq!(cached, plaintext);
    }

    // ── list_files — no cross-contamination from media_sync angle ───────────
    #[tokio::test]
    async fn list_files_media_returns_only_media_paths() {
        let provider = Arc::new(MockProvider::new());
        // Write one entry and one media file
        provider
            .write_file("dev-a/entries/e1.bin", b"entry")
            .await
            .unwrap();
        provider
            .write_file("dev-a/media/mediauuid", b"media")
            .await
            .unwrap();
        let media = provider.list_files("dev-a", FileKind::Media).await.unwrap();
        let entries = provider
            .list_files("dev-a", FileKind::Entries)
            .await
            .unwrap();
        assert_eq!(media, vec!["dev-a/media/mediauuid".to_string()]);
        assert_eq!(entries, vec!["dev-a/entries/e1.bin".to_string()]);
    }
}
