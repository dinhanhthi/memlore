//! Entry-version snapshot frame (`<device>/versions/<versionId>.bin`).
//!
//! **Wire format (frozen, v0.1.0):**
//! `[4 bytes magic "XJV1"] [bincode-serialized SyncVersionPayload]`, bincode
//! fixint encoding capped at [`MAX_PAYLOAD_BYTES`]. Both inner blobs are `0x01`
//! envelopes under the sync key whose fingerprint the frame carries, exactly
//! like entries (`XJS1`). Version blobs are write-once: there is no merge.
//!
//! Moved from the desktop `src-tauri/src/sync/version_sync.rs`, which
//! re-exports these items unchanged.

use bincode::Options;
use serde::{Deserialize, Serialize};

use crate::encryption::key_fingerprint;
use crate::entry_sync::MAX_PAYLOAD_BYTES;
use crate::envelope::{
    envelope_key, latest_envelope_key, open_v1_with, seal_v1, EnvelopeError, ENVELOPE_V1,
};
use crate::key_state::ContentKeyList;
use crate::outbox::is_safe_id;
use crate::CodecError;

/// Current on-disk payload version for version-snapshot blobs. Same
/// `!=` landmine as `PAYLOAD_SCHEMA_VERSION`: never bump without a V2 struct
/// and an in-memory upgrade path in [`deserialize_version_payload`].
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

fn bincode_opts() -> impl bincode::Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_PAYLOAD_BYTES)
}

pub fn serialize_version_payload(payload: &SyncVersionPayload) -> Result<Vec<u8>, CodecError> {
    let body = bincode_opts()
        .serialize(payload)
        .map_err(|e| CodecError::Serialization(e.to_string()))?;
    let mut out = Vec::with_capacity(VERSION_PAYLOAD_MAGIC.len() + body.len());
    out.extend_from_slice(&VERSION_PAYLOAD_MAGIC);
    out.extend_from_slice(&body);
    Ok(out)
}

pub fn deserialize_version_payload(bytes: &[u8]) -> Result<SyncVersionPayload, CodecError> {
    if bytes.len() < VERSION_PAYLOAD_MAGIC.len() {
        return Err(CodecError::Serialization(
            "version payload too short to contain magic header".to_string(),
        ));
    }
    if bytes[..VERSION_PAYLOAD_MAGIC.len()] != VERSION_PAYLOAD_MAGIC {
        return Err(CodecError::Serialization(format!(
            "invalid version payload magic header (expected {:?}, got {:?})",
            VERSION_PAYLOAD_MAGIC,
            &bytes[..VERSION_PAYLOAD_MAGIC.len()]
        )));
    }
    let body = &bytes[VERSION_PAYLOAD_MAGIC.len()..];
    let payload: SyncVersionPayload = bincode_opts()
        .deserialize(body)
        .map_err(|e| CodecError::Serialization(e.to_string()))?;
    if payload.schema_version != VERSION_PAYLOAD_SCHEMA_VERSION {
        return Err(CodecError::Serialization(format!(
            "unsupported version payload schema version {} (expected {})",
            payload.schema_version, VERSION_PAYLOAD_SCHEMA_VERSION
        )));
    }
    Ok(payload)
}

/// Plaintext of one opened version file.
#[derive(Debug, PartialEq, Eq)]
pub struct OpenedVersion {
    pub metadata: VersionMetadata,
    /// Immutable Yjs full-state snapshot bytes.
    pub yjs: Vec<u8>,
}

/// Seal one version file exactly like desktop `push_single_version`, mirroring
/// `envelope::seal_entry`: both inner blobs `0x01` under `K2[latest]`, frame
/// fingerprint `fingerprint(K2[latest])`. The web never writes versions; this
/// exists for tests and fixtures.
pub fn seal_version(
    list: &ContentKeyList,
    metadata: &VersionMetadata,
    yjs: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let (_, key) = latest_envelope_key(list)?;
    let meta_json =
        serde_json::to_vec(metadata).map_err(|e| EnvelopeError::Malformed(e.to_string()))?;
    let payload = SyncVersionPayload::new(
        key_fingerprint(&key),
        seal_v1(&key, yjs)?,
        seal_v1(&key, &meta_json)?,
    );
    serialize_version_payload(&payload).map_err(|e| EnvelopeError::Malformed(e.to_string()))
}

/// Mirror of desktop `src-tauri/src/sync/safety.rs` `is_safe_device_id`:
/// ASCII alphanumeric, `-` or `_`, length 4..=64.
fn is_safe_device_id(s: &str) -> bool {
    (4..=64).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Id checks of desktop `ingest_version`. Fixed messages: the ids are
/// decrypted plaintext and are not echoed.
fn check_metadata_ids(metadata: &VersionMetadata) -> Result<(), EnvelopeError> {
    let bad = |field: &str| {
        Err(EnvelopeError::Malformed(format!(
            "version metadata: unsafe {field}"
        )))
    };
    if !is_safe_id(&metadata.version_id) {
        return bad("version_id");
    }
    if !is_safe_id(&metadata.entry_id) {
        return bad("entry_id");
    }
    if !is_safe_device_id(&metadata.device_id) {
        return bad("device_id");
    }
    Ok(())
}

/// Open one version file (`engine.rs` `ingest_version`), mirroring
/// `envelope::open_entry`: `XJV1` magic and schema check, `0x01` on both inner
/// blobs, key selected by the frame fingerprint (`with_sync_key_for_fingerprint`
/// on the engine snapshot = `fingerprint(K2[e])`), no guessing.
///
/// Rejects metadata whose `version_id` / `entry_id` fail `is_safe_id` or whose
/// `device_id` fails the desktop `is_safe_device_id` rule. The caller still
/// checks `metadata.version_id` against the file name, as desktop
/// `ingest_version` does.
pub fn open_version(list: &ContentKeyList, bytes: &[u8]) -> Result<OpenedVersion, EnvelopeError> {
    if bytes.len() < VERSION_PAYLOAD_MAGIC.len() {
        return Err(EnvelopeError::ShortBuffer);
    }
    if bytes[..VERSION_PAYLOAD_MAGIC.len()] != VERSION_PAYLOAD_MAGIC {
        return Err(EnvelopeError::BadMagic);
    }
    // schema_version is the first bincode field, fixed width little endian.
    let Some(version) = bytes[VERSION_PAYLOAD_MAGIC.len()..].get(..2) else {
        return Err(EnvelopeError::ShortBuffer);
    };
    let version = u16::from_le_bytes([version[0], version[1]]);
    if version != VERSION_PAYLOAD_SCHEMA_VERSION {
        return Err(EnvelopeError::UnsupportedSchemaVersion(version));
    }
    let payload =
        deserialize_version_payload(bytes).map_err(|e| EnvelopeError::Malformed(e.to_string()))?;

    let (Some(y), Some(m)) = (
        payload.yjs_blob_ciphertext.first().copied(),
        payload.metadata_ciphertext.first().copied(),
    ) else {
        return Err(EnvelopeError::Empty);
    };
    for b in [y, m] {
        if b != ENVELOPE_V1 {
            return Err(EnvelopeError::UnknownVersion(b));
        }
    }

    for content in list.keys.values() {
        let key = envelope_key(content);
        if key_fingerprint(&key) == payload.key_fingerprint {
            let meta_plain = open_v1_with(&key, &payload.metadata_ciphertext)?;
            let metadata: VersionMetadata = serde_json::from_slice(&meta_plain).map_err(|e| {
                EnvelopeError::Malformed(format!(
                    "version metadata: {}",
                    crate::json_error_summary(&e)
                ))
            })?;
            check_metadata_ids(&metadata)?;
            return Ok(OpenedVersion {
                metadata,
                yjs: open_v1_with(&key, &payload.yjs_blob_ciphertext)?,
            });
        }
    }
    Err(EnvelopeError::FingerprintMismatch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::{encrypt_data_with_state, encrypt_data_with_state_epoch};
    use crate::envelope::tests::{b64_decode, desktop_vault_list, engine_state, list_of};
    use crate::key_state::EncryptionKeyState;

    /// Same frame as desktop `version_sync::tests::golden_frame_bytes_unchanged`,
    /// pinned before the move.
    const GOLDEN_FRAME_HEX: &str = "584a56310100cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0300000000000000010203040000000000000009080706";

    fn meta() -> VersionMetadata {
        VersionMetadata {
            version_id: "11111111-1111-1111-1111-111111111111".to_string(),
            entry_id: "22222222-2222-2222-2222-222222222222".to_string(),
            created_at: 1_700_000_000,
            device_id: "device-a".to_string(),
            preview_text: "hello preview".to_string(),
        }
    }

    /// Seal exactly like desktop `push_single_version`: both blobs through
    /// `encrypt_data_with_state` on the engine key state, frame fingerprint of
    /// its sync key.
    fn desktop_seal(ks: &EncryptionKeyState, yjs: &[u8], meta_json: &[u8]) -> Vec<u8> {
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let payload = SyncVersionPayload::new(
            fp,
            encrypt_data_with_state(yjs, ks).unwrap(),
            encrypt_data_with_state(meta_json, ks).unwrap(),
        );
        serialize_version_payload(&payload).unwrap()
    }

    #[test]
    fn golden_frame_bytes_unchanged_after_move() {
        let p = SyncVersionPayload::new([0xCD; 32], vec![1, 2, 3], vec![9, 8, 7, 6]);
        assert_eq!(
            hex::encode(serialize_version_payload(&p).unwrap()),
            GOLDEN_FRAME_HEX
        );
        assert_eq!(
            deserialize_version_payload(&hex::decode(GOLDEN_FRAME_HEX).unwrap()).unwrap(),
            p
        );
    }

    #[test]
    fn desktop_vault_version_opens_in_core() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/");
        let vault: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{dir}desktop-vault.v1.json")).unwrap(),
        )
        .unwrap();
        let device_id = vault["device_id"].as_str().unwrap();
        let expected = &vault["expected"]["versions"][0];
        let version_id = expected["version_id"].as_str().unwrap();
        let entry_index = expected["entry_index"].as_u64().unwrap() as usize;
        let entry_id = vault["expected"]["entries"][entry_index]["entry_id"]
            .as_str()
            .unwrap();
        let path = format!("generations/g-0/{device_id}/versions/{version_id}.bin");
        let bytes = b64_decode(vault["files"][&path].as_str().unwrap());

        let opened = open_version(&desktop_vault_list(), &bytes).unwrap();
        assert_eq!(opened.metadata.version_id, version_id);
        assert_eq!(opened.metadata.entry_id, entry_id);
        assert_eq!(opened.metadata.device_id, device_id);
        assert_eq!(
            opened.metadata.preview_text,
            expected["preview_text"].as_str().unwrap()
        );
        assert!(opened.metadata.created_at > 0);
        assert!(!opened.yjs.is_empty());
    }

    #[test]
    fn desktop_sealed_version_opens_after_rotation() {
        let old = list_of(&[(1, 1)], 1);
        let json = serde_json::to_vec(&meta()).unwrap();
        let sealed = desktop_seal(&engine_state(&old), b"snapshot", &json);
        let rotated = list_of(&[(1, 1), (2, 2)], 2);
        let opened = open_version(&rotated, &sealed).unwrap();
        assert_eq!(opened.metadata, meta());
        assert_eq!(opened.yjs, b"snapshot");
    }

    #[test]
    fn seal_version_round_trips_and_matches_the_desktop_frame_shape() {
        let rotated = list_of(&[(1, 1), (2, 2)], 2);
        let sealed = seal_version(&rotated, &meta(), b"snapshot").unwrap();
        let opened = open_version(&rotated, &sealed).unwrap();
        assert_eq!(opened.metadata, meta());
        assert_eq!(opened.yjs, b"snapshot");
        // Sealed under the latest epoch, with the desktop engine's fingerprint.
        let ks = engine_state(&rotated);
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        assert_eq!(
            deserialize_version_payload(&sealed)
                .unwrap()
                .key_fingerprint,
            fp
        );
        assert!(open_version(&list_of(&[(1, 1)], 1), &sealed).is_err());
    }

    #[test]
    fn wrong_key_is_fingerprint_mismatch() {
        let l = list_of(&[(1, 1)], 1);
        let json = serde_json::to_vec(&meta()).unwrap();
        let sealed = desktop_seal(&engine_state(&l), b"y", &json);
        assert_eq!(
            open_version(&list_of(&[(1, 7)], 1), &sealed),
            Err(EnvelopeError::FingerprintMismatch)
        );
    }

    #[test]
    fn tampered_ciphertext_is_wrong_key() {
        let l = list_of(&[(1, 1)], 1);
        let json = serde_json::to_vec(&meta()).unwrap();
        let sealed = desktop_seal(&engine_state(&l), b"y", &json);
        let mut p = deserialize_version_payload(&sealed).unwrap();
        *p.yjs_blob_ciphertext.last_mut().unwrap() ^= 1;
        assert_eq!(
            open_version(&l, &serialize_version_payload(&p).unwrap()),
            Err(EnvelopeError::WrongKey)
        );
    }

    #[test]
    fn bad_magic_short_buffer_and_schema() {
        let l = list_of(&[(1, 1)], 1);
        assert_eq!(open_version(&l, b"XJ"), Err(EnvelopeError::ShortBuffer));
        assert_eq!(open_version(&l, b"XJV1"), Err(EnvelopeError::ShortBuffer));
        // An entry frame is not a version frame.
        let entry = crate::envelope::seal_entry(&l, b"{}", b"y").unwrap();
        assert_eq!(open_version(&l, &entry), Err(EnvelopeError::BadMagic));
        let mut p = SyncVersionPayload::new([0; 32], vec![1], vec![1]);
        p.schema_version = 999;
        assert_eq!(
            open_version(&l, &serialize_version_payload(&p).unwrap()),
            Err(EnvelopeError::UnsupportedSchemaVersion(999))
        );
    }

    /// serde_json errors echo input fragments; a version's metadata is
    /// decrypted journal text and must never reach an error string.
    #[test]
    fn bad_metadata_error_never_echoes_plaintext() {
        let l = list_of(&[(1, 1)], 1);
        let ks = engine_state(&l);
        let mut wrong_type = serde_json::to_value(meta()).unwrap();
        wrong_type["preview_text"] = serde_json::json!(["SECRET"]);
        let mut unknown_type = serde_json::to_value(meta()).unwrap();
        unknown_type["created_at"] = serde_json::json!("SECRET");
        for body in [
            wrong_type.to_string(),
            unknown_type.to_string(),
            "{\"preview_text\":\"SECRET".to_string(),
        ] {
            let sealed = desktop_seal(&ks, b"y", body.as_bytes());
            let err = open_version(&l, &sealed).unwrap_err();
            assert!(matches!(err, EnvelopeError::Malformed(_)), "{err:?}");
            assert!(!err.to_string().contains("SECRET"), "{err}");
        }
    }

    #[test]
    fn rejects_unsafe_metadata_ids() {
        let l = list_of(&[(1, 1)], 1);
        let ks = engine_state(&l);
        let cases: [(&str, &str); 6] = [
            ("version_id", "../etc/passwd"),
            ("version_id", "short"),
            ("entry_id", "bad/entry-12345678"),
            ("entry_id", ""),
            ("device_id", "abc"),
            ("device_id", "dev/../a"),
        ];
        for (field, value) in cases {
            let mut m = serde_json::to_value(meta()).unwrap();
            m[field] = serde_json::json!(value);
            let sealed = desktop_seal(&ks, b"y", m.to_string().as_bytes());
            let err = open_version(&l, &sealed).unwrap_err();
            assert!(
                matches!(err, EnvelopeError::Malformed(_)),
                "{field}: {err:?}"
            );
            assert!(err.to_string().contains(field), "{err}");
        }
        // Desktop `is_safe_device_id` accepts short test ids down to 4 chars.
        let mut m = serde_json::to_value(meta()).unwrap();
        m["device_id"] = serde_json::json!("dev-a");
        let sealed = desktop_seal(&ks, b"y", m.to_string().as_bytes());
        assert_eq!(
            open_version(&l, &sealed).unwrap().metadata.device_id,
            "dev-a"
        );
    }

    #[test]
    fn rejects_epoch_envelope_empty_blobs_and_bad_metadata() {
        let l = list_of(&[(1, 1)], 1);
        let ks = engine_state(&l);
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let epoch_blob = encrypt_data_with_state_epoch(b"x", &ks).unwrap();
        let p = SyncVersionPayload::new(fp, epoch_blob.clone(), epoch_blob);
        assert_eq!(
            open_version(&l, &serialize_version_payload(&p).unwrap()),
            Err(EnvelopeError::UnknownVersion(0x02))
        );
        let p = SyncVersionPayload::new(fp, vec![], vec![]);
        assert_eq!(
            open_version(&l, &serialize_version_payload(&p).unwrap()),
            Err(EnvelopeError::Empty)
        );
        let not_meta = desktop_seal(&ks, b"y", b"{\"version_id\":1}");
        assert!(matches!(
            open_version(&l, &not_meta),
            Err(EnvelopeError::Malformed(_))
        ));
    }
}
