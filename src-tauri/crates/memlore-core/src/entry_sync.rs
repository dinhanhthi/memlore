//! Entry payload framing (platform-independent; no Yjs).
//!
//! - **Payload format on disk:**
//!     ```text
//!     [4 bytes magic "XJS1"] [bincode-serialized SyncEntryPayload]
//!     ```
//!   The magic prefix lets `deserialize_payload` reject obviously-wrong
//!   files in O(1) without allocating from a hostile length-prefix. The
//!   `schema_version` field is the **first** struct field so a version
//!   bump is visible inside the first few bytes of the bincode stream too.
//!
//! - **bincode bounds:** allocations are capped at [`MAX_PAYLOAD_BYTES`] so
//!   a malicious file declaring a multi-exabyte length cannot OOM the
//!   process. The cap is generous (32 MiB) — real entries are far smaller
//!   even with embedded media references.
//!
//! - **bincode 1.x** chosen over `postcard`: simpler API, struct-shaped
//!   schema, no per-field tag overhead. Wire compactness doesn't matter
//!   because each entry lives in its own file.

use bincode::Options;
use serde::{Deserialize, Serialize};

use crate::CodecError;

/// Current on-disk payload version. Bumping requires writing a migration
/// path in [`deserialize_payload`] *before* changing this constant —
/// otherwise existing devices reject every newer file they see (see the
/// "Version Policy" comment on `deserialize_payload`).
pub const PAYLOAD_SCHEMA_VERSION: u16 = 1;

/// Magic header. Four ASCII bytes: "XJS" + format-generation digit. Lets a
/// reader reject obviously-wrong files (a stray `.txt` accidentally placed
/// in the entries directory, a partial download, …) without allocating.
const PAYLOAD_MAGIC: [u8; 4] = *b"XJS1";

/// Hard upper bound for any single entry payload's bincode-encoded size.
/// Generous (32 MiB) — even a long entry with thumbnails fits in well
/// under 1 MiB. The cap exists to defend against a malicious provider
/// (or a corrupted file) declaring an absurd `Vec<u8>` length, which
/// would otherwise trigger a multi-gigabyte allocation inside bincode.
pub const MAX_PAYLOAD_BYTES: u64 = 32 * 1024 * 1024;

/// One entry's encrypted payload as written to disk.
///
/// `yjs_blob_ciphertext` and `metadata_ciphertext` are already AES-256-GCM
/// encrypted by the caller — this layer is encryption-agnostic and never
/// holds plaintext.
///
/// Field order matters: `schema_version` is **first** so the version
/// shows up in the first few bytes of the bincode stream, before any
/// length-prefixed `Vec<u8>`. Combined with the magic header, a
/// version-mismatched file is rejected before the first byte of
/// ciphertext is read.
///
/// `key_fingerprint` is an HMAC-SHA256 of a fixed context with the
/// master encryption key (see [`crate::encryption::key_fingerprint`]).
/// The engine (Chunk 3c) refuses to ingest a payload whose fingerprint
/// does not match the local key — without this check, two devices
/// running on different keys would silently succeed at the outer AES-GCM
/// layer and then write ciphertext into the DB that cannot be decrypted
/// by the pulling device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncEntryPayload {
    pub schema_version: u16,
    pub key_fingerprint: [u8; 32],
    pub yjs_blob_ciphertext: Vec<u8>,
    pub metadata_ciphertext: Vec<u8>,
}

impl SyncEntryPayload {
    /// Convenience constructor that stamps the current schema version and
    /// fingerprints the caller-supplied key.
    pub fn new(
        key_fingerprint: [u8; 32],
        yjs_blob_ciphertext: Vec<u8>,
        metadata_ciphertext: Vec<u8>,
    ) -> Self {
        Self {
            schema_version: PAYLOAD_SCHEMA_VERSION,
            key_fingerprint,
            yjs_blob_ciphertext,
            metadata_ciphertext,
        }
    }
}

/// Build the bincode options used by both serialize and deserialize. Using
/// the same options on both sides is non-negotiable — switching encodings
/// between writer and reader silently produces garbage.
fn bincode_opts() -> impl bincode::Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_PAYLOAD_BYTES)
}

pub fn serialize_payload(payload: &SyncEntryPayload) -> Result<Vec<u8>, CodecError> {
    let body = bincode_opts()
        .serialize(payload)
        .map_err(|e| CodecError::Serialization(e.to_string()))?;
    let mut out = Vec::with_capacity(PAYLOAD_MAGIC.len() + body.len());
    out.extend_from_slice(&PAYLOAD_MAGIC);
    out.extend_from_slice(&body);
    Ok(out)
}

/// Deserialize a payload from disk.
///
/// **Version Policy.** The check below is `!=`, not `<`, because there is
/// no migration table yet. Adding a v2 means:
/// 1. Define `SyncEntryPayloadV2`.
/// 2. Replace this single check with a `match payload.schema_version` that
///    dispatches to the right struct + an upgrade step from v1 to the
///    in-memory current shape.
/// 3. Only then bump [`PAYLOAD_SCHEMA_VERSION`].
///
/// Doing those three things in lockstep is what keeps old devices able to
/// read files that newer devices write — the chunk doc tracks this as a
/// known landmine.
pub fn deserialize_payload(bytes: &[u8]) -> Result<SyncEntryPayload, CodecError> {
    if bytes.len() < PAYLOAD_MAGIC.len() {
        return Err(CodecError::Serialization(
            "payload too short to contain magic header".to_string(),
        ));
    }
    if bytes[..PAYLOAD_MAGIC.len()] != PAYLOAD_MAGIC {
        return Err(CodecError::Serialization(format!(
            "invalid sync payload magic header (expected {:?}, got {:?})",
            PAYLOAD_MAGIC,
            &bytes[..PAYLOAD_MAGIC.len()]
        )));
    }
    let body = &bytes[PAYLOAD_MAGIC.len()..];
    let payload: SyncEntryPayload = bincode_opts()
        .deserialize(body)
        .map_err(|e| CodecError::Serialization(e.to_string()))?;
    if payload.schema_version != PAYLOAD_SCHEMA_VERSION {
        return Err(CodecError::Serialization(format!(
            "unsupported sync payload schema version {} (expected {})",
            payload.schema_version, PAYLOAD_SCHEMA_VERSION
        )));
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Payload ──────────────────────────────────────────────────────────

    const TEST_FP: [u8; 32] = [0xAB; 32];

    #[test]
    fn payload_roundtrip_preserves_bytes_and_version() {
        let original = SyncEntryPayload::new(TEST_FP, vec![1, 2, 3, 4, 5], vec![9, 8, 7]);
        let bytes = serialize_payload(&original).unwrap();
        let back = deserialize_payload(&bytes).unwrap();
        assert_eq!(back, original);
        assert_eq!(back.schema_version, PAYLOAD_SCHEMA_VERSION);
        assert_eq!(back.key_fingerprint, TEST_FP);
    }

    #[test]
    fn payload_starts_with_magic_header() {
        let p = SyncEntryPayload::new(TEST_FP, vec![1], vec![2]);
        let bytes = serialize_payload(&p).unwrap();
        assert_eq!(&bytes[..4], &PAYLOAD_MAGIC);
    }

    #[test]
    fn payload_known_schema_version_one_deserializes() {
        // Construct explicitly with version 1 to lock the current contract.
        let p = SyncEntryPayload {
            schema_version: 1,
            key_fingerprint: TEST_FP,
            yjs_blob_ciphertext: vec![10, 20, 30],
            metadata_ciphertext: vec![40, 50],
        };
        let bytes = serialize_payload(&p).unwrap();
        let back = deserialize_payload(&bytes).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn payload_empty_blobs_roundtrip() {
        let p = SyncEntryPayload::new(TEST_FP, vec![], vec![]);
        let bytes = serialize_payload(&p).unwrap();
        let back = deserialize_payload(&bytes).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn payload_unknown_version_returns_error() {
        let bad = SyncEntryPayload {
            schema_version: 999,
            key_fingerprint: TEST_FP,
            yjs_blob_ciphertext: vec![1],
            metadata_ciphertext: vec![2],
        };
        let bytes = serialize_payload(&bad).unwrap();
        let err = deserialize_payload(&bytes).unwrap_err();
        match err {
            CodecError::Serialization(msg) => assert!(msg.contains("999")),
            _ => panic!("expected Serialization error, got {err:?}"),
        }
    }

    #[test]
    fn payload_corrupt_bytes_return_error() {
        let err = deserialize_payload(&[0xFF, 0xFF, 0xFF, 0xFF, 0x00]).unwrap_err();
        assert!(matches!(err, CodecError::Serialization(_)));
    }

    #[test]
    fn payload_missing_magic_is_rejected() {
        // Valid bincode body but no magic prefix — must fail at the magic
        // check, not crash inside bincode.
        let body = bincode_opts()
            .serialize(&SyncEntryPayload::new(TEST_FP, vec![1], vec![2]))
            .unwrap();
        let err = deserialize_payload(&body).unwrap_err();
        match err {
            CodecError::Serialization(msg) => assert!(msg.contains("magic")),
            _ => panic!("expected magic-related Serialization error, got {err:?}"),
        }
    }

    #[test]
    fn payload_too_short_for_magic_is_rejected() {
        let err = deserialize_payload(&[b'X', b'J']).unwrap_err();
        assert!(matches!(err, CodecError::Serialization(_)));
    }

    #[test]
    fn payload_hostile_huge_length_prefix_is_rejected_without_oom() {
        // Hand-craft a payload: magic header + bincode-style start that
        // claims an absurd Vec<u8> length. With `with_limit(32 MiB)`,
        // bincode rejects the length before allocating.
        //
        // bincode fixint format: u16 schema_version (2 bytes LE), then 32
        // bytes of fingerprint ([u8; 32] — fixed-size, no length prefix),
        // then u64 length prefix for the first Vec<u8> (8 bytes).
        let mut hostile = Vec::new();
        hostile.extend_from_slice(&PAYLOAD_MAGIC);
        hostile.extend_from_slice(&1u16.to_le_bytes()); // schema_version = 1
        hostile.extend_from_slice(&[0u8; 32]); // key_fingerprint
        hostile.extend_from_slice(&u64::MAX.to_le_bytes()); // claim ~18 EiB
        let err = deserialize_payload(&hostile).unwrap_err();
        // It must error (not OOM), and the error must come from bincode's
        // limit check rather than our version mismatch.
        assert!(matches!(err, CodecError::Serialization(_)));
    }
}
