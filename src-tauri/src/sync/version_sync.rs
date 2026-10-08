//! Entry-version snapshot payload serialization + cloud path helpers.
//!
//! Mirrors `entry_sync.rs` closely: versions are wrapped in the same
//! `[magic][bincode payload]` shape and encrypted with the HKDF-derived
//! `sync_key` (never the master key — see `media-on-demand-decrypt-must-use-sync-key`).
//! The one structural difference from entries: version blobs are
//! **write-once / immutable**. There is no CRDT merge on pull — a version id
//! either already exists locally (skip) or it doesn't (insert), see
//! `db::insert_remote_version`.
//!
//! **Wire format:** `[4 bytes magic "XJV1"] [bincode-serialized SyncVersionPayload]`.
//! A distinct magic from entries' `"XJS1"` makes a stray misplaced file
//! immediately identifiable by inspection; the two payload shapes are
//! otherwise structurally identical.

use super::provider::SyncError;

/// Frame types, the `XJV1` codec and the opener live in `memlore_core::version`
/// (shared with the web); this module keeps thin wrappers that map its
/// `CodecError` to `SyncError`, plus the desktop key-state helpers.
pub use memlore_core::version::{
    SyncVersionPayload, VersionMetadata, VERSION_PAYLOAD_SCHEMA_VERSION,
};

/// Cloud path for a version blob: flat under the authoring device's own
/// folder, mirroring `{device_id}/media/{media_id}` and
/// `{device_id}/entries/{entry_id}.bin`.
pub fn version_cloud_path(device_id: &str, version_id: &str) -> String {
    format!("{device_id}/versions/{version_id}.bin")
}

pub fn serialize_version_payload(payload: &SyncVersionPayload) -> Result<Vec<u8>, SyncError> {
    Ok(memlore_core::version::serialize_version_payload(payload)?)
}

pub fn deserialize_version_payload(bytes: &[u8]) -> Result<SyncVersionPayload, SyncError> {
    Ok(memlore_core::version::deserialize_version_payload(bytes)?)
}

/// Encrypt one field (Yjs snapshot bytes or metadata JSON) for a version
/// payload. Thin wrapper over `encrypt_data_with_state` — the caller must
/// build `key_state` via `EncryptionKeyState::set_key` (never the raw
/// master key) so the HKDF-derived `sync_key` is what actually encrypts the
/// bytes. Basis: memory `media-on-demand-decrypt-must-use-sync-key`.
pub fn encrypt_version_bytes(
    key_state: &crate::EncryptionKeyState,
    plaintext: &[u8],
) -> Result<Vec<u8>, SyncError> {
    crate::utils::encryption::encrypt_data_with_state(plaintext, key_state)
        .map_err(SyncError::Serialization)
}

/// Decrypt one field encrypted by [`encrypt_version_bytes`]. Only valid when
/// the caller already knows `key_state` holds the correct (single) sync key
/// for this payload — e.g. round-tripping locally. Pulling from a peer must
/// instead select the sync key by fingerprint (see
/// `SyncEngine::ingest_version` in `engine.rs`), because the payload may have
/// been encrypted under an older content-key epoch.
pub fn decrypt_version_bytes(
    key_state: &crate::EncryptionKeyState,
    ciphertext: &[u8],
) -> Result<Vec<u8>, SyncError> {
    crate::utils::encryption::decrypt_data_with_state(ciphertext, key_state)
        .map_err(SyncError::Serialization)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::encryption::KEY_SIZE;

    fn make_real_key_state(raw_key: &[u8; KEY_SIZE]) -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        ks.set_key(zeroize::Zeroizing::new(*raw_key))
            .expect("set_key never fails");
        ks
    }

    const TEST_FP: [u8; 32] = [0xCD; 32];

    #[test]
    fn payload_roundtrip_preserves_bytes_and_version() {
        let original = SyncVersionPayload::new(TEST_FP, vec![1, 2, 3], vec![9, 8, 7, 6]);
        let bytes = serialize_version_payload(&original).unwrap();
        let back = deserialize_version_payload(&bytes).unwrap();
        assert_eq!(back, original);
        assert_eq!(back.schema_version, VERSION_PAYLOAD_SCHEMA_VERSION);
    }

    /// XJV1 frame bytes pinned before the codec moved to `memlore_core::version`.
    /// bincode fixint is deterministic, so any drift in magic, field order or
    /// integer width shows up here.
    const GOLDEN_FRAME_HEX: &str = "584a56310100cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0300000000000000010203040000000000000009080706";

    #[test]
    fn golden_frame_bytes_unchanged() {
        let p = SyncVersionPayload::new(TEST_FP, vec![1, 2, 3], vec![9, 8, 7, 6]);
        let bytes = serialize_version_payload(&p).unwrap();
        assert_eq!(hex::encode(&bytes), GOLDEN_FRAME_HEX);
        assert_eq!(
            deserialize_version_payload(&hex::decode(GOLDEN_FRAME_HEX).unwrap()).unwrap(),
            p
        );
    }

    #[test]
    fn payload_starts_with_distinct_magic() {
        let p = SyncVersionPayload::new(TEST_FP, vec![1], vec![2]);
        let bytes = serialize_version_payload(&p).unwrap();
        assert_eq!(&bytes[..4], b"XJV1");
    }

    #[test]
    fn payload_missing_magic_is_rejected() {
        use bincode::Options;
        let body = bincode::DefaultOptions::new()
            .with_fixint_encoding()
            .serialize(&SyncVersionPayload::new(TEST_FP, vec![1], vec![2]))
            .unwrap();
        let err = deserialize_version_payload(&body).unwrap_err();
        match err {
            SyncError::Serialization(msg) => assert!(msg.contains("magic")),
            _ => panic!("expected Serialization error, got {err:?}"),
        }
    }

    #[test]
    fn payload_unknown_version_returns_error() {
        let bad = SyncVersionPayload {
            schema_version: 999,
            key_fingerprint: TEST_FP,
            yjs_blob_ciphertext: vec![1],
            metadata_ciphertext: vec![2],
        };
        let bytes = serialize_version_payload(&bad).unwrap();
        let err = deserialize_version_payload(&bytes).unwrap_err();
        match err {
            SyncError::Serialization(msg) => assert!(msg.contains("999")),
            _ => panic!("expected Serialization error, got {err:?}"),
        }
    }

    #[test]
    fn version_cloud_path_is_flat_under_device_versions_folder() {
        assert_eq!(
            version_cloud_path("device-a", "version-1"),
            "device-a/versions/version-1.bin"
        );
    }

    /// End-to-end: encrypt the snapshot bytes + metadata JSON, wrap into a
    /// payload, serialize, deserialize, decrypt — must reproduce the
    /// original snapshot bytes and metadata exactly (task 1's required test).
    #[test]
    fn encrypt_decrypt_roundtrip_reproduces_snapshot_and_metadata() {
        let key = [7u8; KEY_SIZE];
        let ks = make_real_key_state(&key);

        let snapshot_bytes = b"yjs full-state update bytes".to_vec();
        let metadata = VersionMetadata {
            version_id: "11111111-1111-1111-1111-111111111111".to_string(),
            entry_id: "22222222-2222-2222-2222-222222222222".to_string(),
            created_at: 1_700_000_000,
            device_id: "device-a".to_string(),
            preview_text: "hello preview".to_string(),
        };
        let meta_plain = serde_json::to_vec(&metadata).unwrap();

        let fp = ks
            .with_sync_key(|k| Ok(crate::utils::encryption::key_fingerprint(k)))
            .unwrap();
        let yjs_ct = encrypt_version_bytes(&ks, &snapshot_bytes).unwrap();
        let meta_ct = encrypt_version_bytes(&ks, &meta_plain).unwrap();

        let payload = SyncVersionPayload::new(fp, yjs_ct, meta_ct);
        let bytes = serialize_version_payload(&payload).unwrap();

        let back = deserialize_version_payload(&bytes).unwrap();
        let decrypted_yjs = decrypt_version_bytes(&ks, &back.yjs_blob_ciphertext).unwrap();
        let decrypted_meta = decrypt_version_bytes(&ks, &back.metadata_ciphertext).unwrap();
        let decoded_metadata: VersionMetadata = serde_json::from_slice(&decrypted_meta).unwrap();

        assert_eq!(decrypted_yjs, snapshot_bytes);
        assert_eq!(decoded_metadata, metadata);
        assert_eq!(back.key_fingerprint, fp);
    }

    #[test]
    fn decrypt_with_wrong_key_fails() {
        let key1 = [1u8; KEY_SIZE];
        let key2 = [2u8; KEY_SIZE];
        let ks1 = make_real_key_state(&key1);
        let ks2 = make_real_key_state(&key2);
        let ct = encrypt_version_bytes(&ks1, b"secret snapshot").unwrap();
        assert!(decrypt_version_bytes(&ks2, &ct).is_err());
    }
}
