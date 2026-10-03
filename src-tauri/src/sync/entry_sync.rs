//! Entry payload serialization + Yjs CRDT merge.
//!
//! The payload framing (magic header, bincode options, schema-version check)
//! lives in `memlore_core::entry_sync`; this module keeps thin wrappers that
//! map its `CodecError` to `SyncError`, plus the yrs-based merge.
//!
//! - **Yjs merge:** purely functional. Decode `local` and `remote` byte
//!   blobs into a single `yrs::Doc`, then re-encode. CRDT semantics
//!   guarantee convergence regardless of apply order — *provided* the
//!   inputs are full-state updates (see [`merge_yjs_full_state_updates`]).

use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use super::provider::SyncError;

pub use memlore_core::entry_sync::{SyncEntryPayload, MAX_PAYLOAD_BYTES, PAYLOAD_SCHEMA_VERSION};

pub fn serialize_payload(payload: &SyncEntryPayload) -> Result<Vec<u8>, SyncError> {
    Ok(memlore_core::entry_sync::serialize_payload(payload)?)
}

pub fn deserialize_payload(bytes: &[u8]) -> Result<SyncEntryPayload, SyncError> {
    Ok(memlore_core::entry_sync::deserialize_payload(bytes)?)
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

    // ─── Payload error mapping ────────────────────────────────────────────

    #[test]
    fn payload_codec_errors_map_to_sync_serialization_errors() {
        let err = deserialize_payload(&[b'X', b'J']).unwrap_err();
        match err {
            SyncError::Serialization(msg) => {
                assert_eq!(msg, "payload too short to contain magic header")
            }
            _ => panic!("expected Serialization error, got {err:?}"),
        }
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
