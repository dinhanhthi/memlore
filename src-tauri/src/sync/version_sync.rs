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

use bincode::Options;
use serde::{Deserialize, Serialize};

use super::entry_sync::MAX_PAYLOAD_BYTES;
use super::provider::SyncError;

/// Current on-disk payload version for version-snapshot blobs.
pub const VERSION_PAYLOAD_SCHEMA_VERSION: u16 = 1;

/// Magic header for version-snapshot blobs. Distinct from entries' `XJS1`
/// so a misplaced file is identifiable at a glance.
const VERSION_PAYLOAD_MAGIC: [u8; 4] = *b"XJV1";

/// One version snapshot's encrypted payload as written to disk.
///
/// `yjs_blob_ciphertext` is AES-256-GCM(sync_key) of the immutable Yjs
/// snapshot bytes (`entry_versions.yjs_doc`). `metadata_ciphertext` is
/// AES-256-GCM(sync_key) of the JSON-encoded [`VersionMetadata`].
///
/// Field order mirrors `SyncEntryPayload`: `schema_version` first so a
/// version mismatch is visible before any ciphertext bytes are read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncVersionPayload {
    pub schema_version: u16,
    pub key_fingerprint: [u8; 32],
    pub yjs_blob_ciphertext: Vec<u8>,
    pub metadata_ciphertext: Vec<u8>,
}

impl SyncVersionPayload {
    pub fn new(
        key_fingerprint: [u8; 32],
        yjs_blob_ciphertext: Vec<u8>,
        metadata_ciphertext: Vec<u8>,
    ) -> Self {
        Self {
            schema_version: VERSION_PAYLOAD_SCHEMA_VERSION,
            key_fingerprint,
            yjs_blob_ciphertext,
            metadata_ciphertext,
        }
    }
}

/// Plaintext metadata bundle encrypted into `SyncVersionPayload.metadata_ciphertext`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionMetadata {
    pub version_id: String,
    pub entry_id: String,
    pub created_at: i64,
    pub device_id: String,
    pub preview_text: String,
}

/// Cloud path for a version blob: flat under the authoring device's own
/// folder, mirroring `{device_id}/media/{media_id}` and
/// `{device_id}/entries/{entry_id}.bin`.
pub fn version_cloud_path(device_id: &str, version_id: &str) -> String {
    format!("{device_id}/versions/{version_id}.bin")
}

fn bincode_opts() -> impl bincode::Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_PAYLOAD_BYTES)
}

pub fn serialize_version_payload(payload: &SyncVersionPayload) -> Result<Vec<u8>, SyncError> {
    let body = bincode_opts()
        .serialize(payload)
        .map_err(|e| SyncError::Serialization(e.to_string()))?;
    let mut out = Vec::with_capacity(VERSION_PAYLOAD_MAGIC.len() + body.len());
    out.extend_from_slice(&VERSION_PAYLOAD_MAGIC);
    out.extend_from_slice(&body);
    Ok(out)
}

pub fn deserialize_version_payload(bytes: &[u8]) -> Result<SyncVersionPayload, SyncError> {
    if bytes.len() < VERSION_PAYLOAD_MAGIC.len() {
        return Err(SyncError::Serialization(
            "version payload too short to contain magic header".to_string(),
        ));
    }
    if bytes[..VERSION_PAYLOAD_MAGIC.len()] != VERSION_PAYLOAD_MAGIC {
        return Err(SyncError::Serialization(format!(
            "invalid version payload magic header (expected {:?}, got {:?})",
            VERSION_PAYLOAD_MAGIC,
            &bytes[..VERSION_PAYLOAD_MAGIC.len()]
        )));
    }
    let body = &bytes[VERSION_PAYLOAD_MAGIC.len()..];
    let payload: SyncVersionPayload = bincode_opts()
        .deserialize(body)
        .map_err(|e| SyncError::Serialization(e.to_string()))?;
    if payload.schema_version != VERSION_PAYLOAD_SCHEMA_VERSION {
        return Err(SyncError::Serialization(format!(
            "unsupported version payload schema version {} (expected {})",
            payload.schema_version, VERSION_PAYLOAD_SCHEMA_VERSION
        )));
    }
    Ok(payload)
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

    #[test]
    fn payload_starts_with_distinct_magic() {
        let p = SyncVersionPayload::new(TEST_FP, vec![1], vec![2]);
        let bytes = serialize_version_payload(&p).unwrap();
        assert_eq!(&bytes[..4], b"XJV1");
    }

    #[test]
    fn payload_missing_magic_is_rejected() {
        let body = bincode_opts()
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
