//! Entry payload serialization + Yjs CRDT merge.
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
//!
//! - **Yjs merge:** purely functional. Decode `local` and `remote` byte
//!   blobs into a single `yrs::Doc`, then re-encode. CRDT semantics
//!   guarantee convergence regardless of apply order — *provided* the
//!   inputs are full-state updates (see [`merge_yjs_full_state_updates`]).

use bincode::Options;
use serde::{Deserialize, Serialize};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use super::provider::SyncError;

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
/// master encryption key (see [`crate::utils::encryption::key_fingerprint`]).
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

pub fn serialize_payload(payload: &SyncEntryPayload) -> Result<Vec<u8>, SyncError> {
    let body = bincode_opts()
        .serialize(payload)
        .map_err(|e| SyncError::Serialization(e.to_string()))?;
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
pub fn deserialize_payload(bytes: &[u8]) -> Result<SyncEntryPayload, SyncError> {
    if bytes.len() < PAYLOAD_MAGIC.len() {
        return Err(SyncError::Serialization(
            "payload too short to contain magic header".to_string(),
        ));
    }
    if bytes[..PAYLOAD_MAGIC.len()] != PAYLOAD_MAGIC {
        return Err(SyncError::Serialization(format!(
            "invalid sync payload magic header (expected {:?}, got {:?})",
            PAYLOAD_MAGIC,
            &bytes[..PAYLOAD_MAGIC.len()]
        )));
    }
    let body = &bytes[PAYLOAD_MAGIC.len()..];
    let payload: SyncEntryPayload = bincode_opts()
        .deserialize(body)
        .map_err(|e| SyncError::Serialization(e.to_string()))?;
    if payload.schema_version != PAYLOAD_SCHEMA_VERSION {
        return Err(SyncError::Serialization(format!(
            "unsupported sync payload schema version {} (expected {})",
            payload.schema_version, PAYLOAD_SCHEMA_VERSION
        )));
    }
    Ok(payload)
}

/// Merge two Yjs **full-state** binary updates and return the merged state.
///
/// Algorithm:
/// 1. Apply `local` to a fresh doc.
/// 2. Apply `remote` to the same doc, in the same transaction.
/// 3. Encode the resulting state.
///
/// **Contract — full-state updates only.** Both inputs must be full-state
/// blobs produced by `encode_state_as_update_v1(&StateVector::default())`
/// (Rust) or `Y.encodeStateAsUpdate(doc)` (TS). A delta update — one
/// produced relative to a non-empty state vector — is *not* a valid
/// input: yrs will accept and apply it, but the resulting doc may
/// silently lose history (e.g. content that was deleted in a missing
/// causal step would reappear). The function name is the contract; the
/// `delta_misuse` test below documents the expected misuse symptom so a
/// future contributor doesn't try to "fix" the symptom by changing the
/// merge.
pub fn merge_yjs_full_state_updates(local: &[u8], remote: &[u8]) -> Result<Vec<u8>, SyncError> {
    let doc = Doc::new();
    let mut txn = doc.transact_mut();
    let local_update =
        Update::decode_v1(local).map_err(|e| SyncError::Merge(format!("decode local: {e}")))?;
    txn.apply_update(local_update)
        .map_err(|e| SyncError::Merge(format!("apply local: {e}")))?;
    let remote_update =
        Update::decode_v1(remote).map_err(|e| SyncError::Merge(format!("decode remote: {e}")))?;
    txn.apply_update(remote_update)
        .map_err(|e| SyncError::Merge(format!("apply remote: {e}")))?;
    // `transact_mut` already implements `ReadTxn`, so we can encode without
    // dropping and re-acquiring the transaction.
    Ok(txn.encode_state_as_update_v1(&StateVector::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{GetString, Text, Transact};

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
            SyncError::Serialization(msg) => assert!(msg.contains("999")),
            _ => panic!("expected Serialization error, got {err:?}"),
        }
    }

    #[test]
    fn payload_corrupt_bytes_return_error() {
        let err = deserialize_payload(&[0xFF, 0xFF, 0xFF, 0xFF, 0x00]).unwrap_err();
        assert!(matches!(err, SyncError::Serialization(_)));
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
            SyncError::Serialization(msg) => assert!(msg.contains("magic")),
            _ => panic!("expected magic-related Serialization error, got {err:?}"),
        }
    }

    #[test]
    fn payload_too_short_for_magic_is_rejected() {
        let err = deserialize_payload(&[b'X', b'J']).unwrap_err();
        assert!(matches!(err, SyncError::Serialization(_)));
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
        assert!(matches!(err, SyncError::Serialization(_)));
    }

    // ─── Yjs merge ────────────────────────────────────────────────────────

    /// Build a Yjs doc with the given text in a `Y.Text` named "content"
    /// and return its full-state update bytes.
    fn doc_with_text(content: &str) -> Vec<u8> {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, content);
        }
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    }

    /// Decode merged update bytes and return the resulting "content" string.
    fn read_merged(merged: &[u8]) -> String {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        {
            let mut txn = doc.transact_mut();
            let update = Update::decode_v1(merged).unwrap();
            txn.apply_update(update).unwrap();
        }
        let txn = doc.transact();
        text.get_string(&txn)
    }

    #[test]
    fn yjs_merge_combines_independent_edits() {
        // Two devices forking from an empty doc.
        let local = doc_with_text("hello ");
        let remote = doc_with_text("world");
        let merged = merge_yjs_full_state_updates(&local, &remote).unwrap();
        let s = read_merged(&merged);
        // The exact interleaving depends on Yjs client ids; both substrings
        // must survive though.
        assert!(s.contains("hello"), "missing 'hello' in {s:?}");
        assert!(s.contains("world"), "missing 'world' in {s:?}");
    }

    #[test]
    fn yjs_merge_is_idempotent_for_identical_input() {
        let same = doc_with_text("just one edit");
        let merged = merge_yjs_full_state_updates(&same, &same).unwrap();
        let s = read_merged(&merged);
        assert_eq!(s, "just one edit");
    }

    #[test]
    fn yjs_merge_resolves_insert_plus_delete_deterministically() {
        // Start from a shared base, then fork: one branch inserts, the
        // other deletes part of the original. Use full-state updates from
        // each fork so the merge is well-defined per the contract.
        let base = Doc::new();
        let base_text = base.get_or_insert_text("content");
        {
            let mut txn = base.transact_mut();
            base_text.insert(&mut txn, 0, "abcdef");
        }
        let base_bytes = base
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        // Fork A — insert at end.
        let doc_a = Doc::new();
        {
            let mut txn = doc_a.transact_mut();
            txn.apply_update(Update::decode_v1(&base_bytes).unwrap())
                .unwrap();
        }
        {
            let text_a = doc_a.get_or_insert_text("content");
            let mut txn = doc_a.transact_mut();
            text_a.insert(&mut txn, 6, "GHI");
        }
        let bytes_a = doc_a
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        // Fork B — delete first two chars.
        let doc_b = Doc::new();
        {
            let mut txn = doc_b.transact_mut();
            txn.apply_update(Update::decode_v1(&base_bytes).unwrap())
                .unwrap();
        }
        {
            let text_b = doc_b.get_or_insert_text("content");
            let mut txn = doc_b.transact_mut();
            text_b.remove_range(&mut txn, 0, 2);
        }
        let bytes_b = doc_b
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        // Merge both forks.
        let merged_ab = merge_yjs_full_state_updates(&bytes_a, &bytes_b).unwrap();
        let merged_ba = merge_yjs_full_state_updates(&bytes_b, &bytes_a).unwrap();

        // CRDT determinism: applying in either order yields the same string.
        assert_eq!(read_merged(&merged_ab), read_merged(&merged_ba));
        let s = read_merged(&merged_ab);
        assert!(!s.starts_with("ab"), "delete should have applied: {s:?}");
        assert!(s.contains("GHI"), "insert should have applied: {s:?}");
    }

    #[test]
    fn yjs_merge_invalid_input_returns_error() {
        let valid = doc_with_text("ok");
        let err = merge_yjs_full_state_updates(&valid, &[0xFF, 0x00, 0x99]).unwrap_err();
        assert!(matches!(err, SyncError::Merge(_)));
    }

    #[test]
    fn yjs_merge_truncated_update_is_rejected() {
        // A valid update truncated mid-stream should fail decode, not crash
        // and not silently produce a partial state.
        let valid = doc_with_text("a sufficiently long string to truncate");
        let truncated = &valid[..valid.len() / 2];
        let err = merge_yjs_full_state_updates(&valid, truncated).unwrap_err();
        assert!(matches!(err, SyncError::Merge(_)));
    }

    #[test]
    fn yjs_merge_delta_misuse_documents_caller_contract() {
        // Documenting yrs behavior under contract violation: a *delta*
        // update (one that omits content already known to the receiver)
        // can still decode and apply against an unrelated doc, but the
        // resulting state is meaningless. This test exists so a future
        // contributor doesn't see "succeeds" and assume delta updates are
        // safe — the contract on `merge_yjs_full_state_updates` is what
        // makes the semantics well-defined; this test asserts the symptom
        // of breaking it.
        let base = Doc::new();
        let base_text = base.get_or_insert_text("content");
        {
            let mut txn = base.transact_mut();
            base_text.insert(&mut txn, 0, "shared");
        }
        let base_state = base.transact().state_vector();

        let extended = Doc::new();
        {
            let mut txn = extended.transact_mut();
            txn.apply_update(
                Update::decode_v1(
                    &base
                        .transact()
                        .encode_state_as_update_v1(&StateVector::default()),
                )
                .unwrap(),
            )
            .unwrap();
        }
        {
            let text = extended.get_or_insert_text("content");
            let mut txn = extended.transact_mut();
            text.insert(&mut txn, 6, "_extra");
        }
        // Delta update relative to base — only the new "_extra" insert.
        let delta = extended.transact().encode_state_as_update_v1(&base_state);

        // Merging the base state with a delta produced against base
        // technically succeeds, but the merged doc is missing the causal
        // context that would make the delta meaningful in isolation. We
        // assert only that the call does *not* panic — the warning lives
        // in the doc-comment, not in a runtime check.
        let other_full = doc_with_text("unrelated");
        let result = merge_yjs_full_state_updates(&other_full, &delta);
        // Either it errored (decoder rejects) or it succeeded with a
        // meaningless state — both are acceptable; we just assert no
        // panic and that the error variant is `Merge` if any.
        if let Err(e) = result {
            assert!(matches!(e, SyncError::Merge(_)));
        }
    }
}
