//! Encrypted chunk-vector sync payload + serialization (Phase 5, Task 1).
//!
//! Syncs `entry_embedding_chunks` rows E2E-encrypted across devices, keyed
//! by `model_id` + `content_hash` so a future pull-side adopt-on-match step
//! (Task 3) can decide whether an incoming vector is directly usable
//! without re-embedding (and therefore without spending a provider call).
//!
//! **This module is serialization + crypto only.** There is no push/pull
//! wiring here (that's Tasks 2-3) — just the payload shape, the framing
//! (mirrors `entry_sync.rs` / `version_sync.rs`: `[magic][bincode]`), and
//! encrypt/decrypt helpers built on the existing AES-256-GCM + key-
//! fingerprint primitives in `utils::encryption`. No new crypto scheme.
//!
//! **The `entry_embedding_jobs` dirty queue is device-local and MUST NEVER
//! appear here.** It tracks per-device re-embed work only (attempts,
//! last error, etc.); syncing it would leak one device's backlog into
//! another device's queue, which has nothing to do with it. `sync_chunks_never_include_job_queue_fields`
//! below is a schema guard against a future edit accidentally adding it.
//!
//! **Fingerprint discipline (known past-bug trap).** The content
//! fingerprint carried in `SyncEmbeddingChunkPayload.key_fingerprint` is
//! `key_fingerprint(derive_sync_key(content_key))` — computed exactly like
//! `SyncEntryPayload` / `SyncVersionPayload`. The writer path
//! (`encrypt_embedding_bytes` + `EncryptionKeyState::with_sync_key`) and the
//! reader path (`decrypt_embedding_bytes_by_fingerprint` +
//! `EncryptionKeyState::with_sync_key_for_fingerprint`, mirroring
//! `SyncEngine::ingest_entry` / `ingest_version` in `engine.rs`) must use
//! the same derivation, or two devices sharing a master key would silently
//! fail to decrypt each other's batches. See the `cross_path_*` test below.
//!
//! **Batching / size bound.** A single payload carries many chunk vectors
//! so a large journal's initial sync doesn't require one round-trip per
//! chunk. [`batch_chunks_for_sync`] splits an arbitrary list of chunk
//! vectors into batches whose *plaintext* bincode size stays under
//! [`MAX_BATCH_PLAINTEXT_BYTES`], which keeps the final encrypted+framed
//! payload comfortably under [`MAX_PAYLOAD_BYTES`] (imported from
//! `entry_sync`, the same ceiling every other payload type uses).

use bincode::Options;
use serde::{Deserialize, Serialize};

use super::entry_sync::MAX_PAYLOAD_BYTES;
use super::provider::SyncError;

/// Current on-disk payload version for chunk-vector sync blobs.
pub const EMBEDDING_PAYLOAD_SCHEMA_VERSION: u16 = 1;

/// Magic header for chunk-vector sync blobs. Distinct from entries' `XJS1`
/// and versions' `XJV1` so a misplaced file is identifiable at a glance.
const EMBEDDING_PAYLOAD_MAGIC: [u8; 4] = *b"XJE1";

/// Soft cap on a single batch's **plaintext** (pre-encryption) bincode size.
/// Keeps the resulting `chunks_ciphertext` well under `MAX_PAYLOAD_BYTES`
/// (32 MiB) after the ~28-byte AES-GCM overhead + framing. 4 MiB is
/// generous — even at 3072 bytes/vector (768-dim f32) that's well over a
/// thousand chunks per batch.
pub const MAX_BATCH_PLAINTEXT_BYTES: usize = 4 * 1024 * 1024;

/// One chunk vector's plaintext fields. Batched together (never one struct
/// per network round-trip) and encrypted as a single blob into
/// [`SyncEmbeddingChunkPayload::chunks_ciphertext`].
///
/// Deliberately excludes any `entry_embedding_jobs` state (status, attempt
/// count, last error, ...): this struct is built only from
/// `entry_embedding_chunks` rows, which is the synced, content-addressed
/// vector store. The jobs table is the device-local dirty queue and must
/// never leave the device — see module docs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmbeddingChunkVector {
    pub entry_id: String,
    pub model_id: String,
    pub chunk_index: i64,
    pub content_hash: String,
    pub dim: i64,
    /// Little-endian f32 bytes, `len() == dim * 4`. Passed through verbatim
    /// from/to the `entry_embedding_chunks.vec` BLOB column — see
    /// `db::embeddings::vec_to_blob` / `blob_to_vec`.
    pub vec: Vec<u8>,
}

/// One batch of encrypted chunk vectors as written to disk.
///
/// `chunks_ciphertext` is AES-256-GCM(sync_key) of the bincode-serialized
/// `Vec<EmbeddingChunkVector>` — the same "encrypt the whole bundle as one
/// opaque blob" shape `SyncEntryPayload.metadata_ciphertext` and
/// `SyncVersionPayload.metadata_ciphertext` use.
///
/// Field order mirrors `SyncEntryPayload` / `SyncVersionPayload`:
/// `schema_version` first so a version mismatch is visible before any
/// ciphertext bytes are read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncEmbeddingChunkPayload {
    pub schema_version: u16,
    pub key_fingerprint: [u8; 32],
    pub chunks_ciphertext: Vec<u8>,
}

impl SyncEmbeddingChunkPayload {
    /// Convenience constructor that stamps the current schema version.
    pub fn new(key_fingerprint: [u8; 32], chunks_ciphertext: Vec<u8>) -> Self {
        Self {
            schema_version: EMBEDDING_PAYLOAD_SCHEMA_VERSION,
            key_fingerprint,
            chunks_ciphertext,
        }
    }
}

/// Build the bincode options used by both serialize and deserialize (and by
/// the batch size accounting below). Using the same options everywhere is
/// non-negotiable — switching encodings between writer and reader silently
/// produces garbage.
fn bincode_opts() -> impl bincode::Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_PAYLOAD_BYTES)
}

/// Encode a batch of chunk vectors to the plaintext bytes that go inside
/// [`SyncEmbeddingChunkPayload::chunks_ciphertext`] (before encryption).
///
/// This is the **only** sanctioned way to produce those bytes. `bincode_opts`
/// is private, so Tasks 2-3 (push/pull wiring) MUST call this — and
/// [`deserialize_chunk_batch`] on the way back out — rather than hand-rolling
/// `bincode::serialize` with different options. Bincode has no self-describing
/// wire format: a caller that used plain `bincode::serialize` (varint,
/// unbounded) instead of this exact `bincode_opts()` config would silently
/// desync from every other reader/writer in the codebase — the identical
/// "writer and reader must agree" trap the outer payload framing guards
/// against, just one layer further in.
pub fn serialize_chunk_batch(chunks: &[EmbeddingChunkVector]) -> Result<Vec<u8>, SyncError> {
    bincode_opts()
        .serialize(chunks)
        .map_err(|e| SyncError::Serialization(e.to_string()))
}

/// Decode bytes produced by [`serialize_chunk_batch`] back into chunk
/// vectors. Same `bincode_opts()` config as the encoder — see that function's
/// doc comment for why this pairing must never drift.
pub fn deserialize_chunk_batch(bytes: &[u8]) -> Result<Vec<EmbeddingChunkVector>, SyncError> {
    bincode_opts()
        .deserialize(bytes)
        .map_err(|e| SyncError::Serialization(e.to_string()))
}

pub fn serialize_embedding_payload(
    payload: &SyncEmbeddingChunkPayload,
) -> Result<Vec<u8>, SyncError> {
    let body = bincode_opts()
        .serialize(payload)
        .map_err(|e| SyncError::Serialization(e.to_string()))?;
    let mut out = Vec::with_capacity(EMBEDDING_PAYLOAD_MAGIC.len() + body.len());
    out.extend_from_slice(&EMBEDDING_PAYLOAD_MAGIC);
    out.extend_from_slice(&body);
    Ok(out)
}

pub fn deserialize_embedding_payload(bytes: &[u8]) -> Result<SyncEmbeddingChunkPayload, SyncError> {
    if bytes.len() < EMBEDDING_PAYLOAD_MAGIC.len() {
        return Err(SyncError::Serialization(
            "embedding payload too short to contain magic header".to_string(),
        ));
    }
    if bytes[..EMBEDDING_PAYLOAD_MAGIC.len()] != EMBEDDING_PAYLOAD_MAGIC {
        return Err(SyncError::Serialization(format!(
            "invalid embedding sync payload magic header (expected {:?}, got {:?})",
            EMBEDDING_PAYLOAD_MAGIC,
            &bytes[..EMBEDDING_PAYLOAD_MAGIC.len()]
        )));
    }
    let body = &bytes[EMBEDDING_PAYLOAD_MAGIC.len()..];
    let payload: SyncEmbeddingChunkPayload = bincode_opts()
        .deserialize(body)
        .map_err(|e| SyncError::Serialization(e.to_string()))?;
    if payload.schema_version != EMBEDDING_PAYLOAD_SCHEMA_VERSION {
        return Err(SyncError::Serialization(format!(
            "unsupported embedding sync payload schema version {} (expected {})",
            payload.schema_version, EMBEDDING_PAYLOAD_SCHEMA_VERSION
        )));
    }
    Ok(payload)
}

/// Encrypt one batch's bincode-serialized `Vec<EmbeddingChunkVector>` bytes.
/// Thin wrapper over `encrypt_data_with_state` — the same versioned
/// envelope every other payload type uses. The caller must
/// build `key_state` via `EncryptionKeyState::set_key` / `set_content_state`
/// (never pass the raw master key directly) so the HKDF-derived `sync_key`
/// is what actually encrypts the bytes.
///
/// This is the **writer** path: it always uses the *latest* content key
/// (`with_sync_key`), matching `push_single_entry` / `push_versions`.
pub fn encrypt_embedding_bytes(
    key_state: &crate::EncryptionKeyState,
    plaintext: &[u8],
) -> Result<Vec<u8>, SyncError> {
    crate::utils::encryption::encrypt_data_with_state(plaintext, key_state)
        .map_err(SyncError::Serialization)
}

/// Decrypt a batch encrypted by [`encrypt_embedding_bytes`]. Only valid when
/// the caller already knows `key_state` holds the correct (single) sync key
/// for this payload — e.g. round-tripping locally. Pulling from a peer must
/// instead select the sync key by fingerprint — see
/// [`decrypt_embedding_bytes_by_fingerprint`], because the payload may have
/// been encrypted under an older content-key epoch this device also holds.
pub fn decrypt_embedding_bytes(
    key_state: &crate::EncryptionKeyState,
    ciphertext: &[u8],
) -> Result<Vec<u8>, SyncError> {
    crate::utils::encryption::decrypt_data_with_state(ciphertext, key_state)
        .map_err(SyncError::Serialization)
}

/// Decrypt a chunk-vector batch using the **reader** ("select-by-fingerprint")
/// idiom used by `SyncEngine::ingest_entry` / `ingest_version` in
/// `engine.rs`, rather than `decrypt_embedding_bytes` (which assumes the
/// caller already knows the single correct key).
///
/// Selects the content-key epoch in `key_state_full` whose derived sync
/// key's fingerprint matches `payload.key_fingerprint`, then strips the
/// leading `0x01` version byte written by `encrypt_data_with_state` and
/// decrypts the inner AES-GCM bytes directly with `decrypt_data` — the exact
/// sequence `ingest_entry` / `ingest_version` use for their
/// `metadata_ciphertext` / `yjs_blob_ciphertext` fields. Mirroring this
/// (rather than inventing a different reader path) is what guarantees a
/// batch this module's writer produces is always decryptable by the real
/// pull path added in Task 3.
///
/// Returns an error — never silently selects the wrong key — if no epoch in
/// `key_state_full` produces a matching fingerprint.
pub fn decrypt_embedding_bytes_by_fingerprint(
    key_state_full: &crate::EncryptionKeyState,
    payload: &SyncEmbeddingChunkPayload,
) -> Result<Vec<u8>, SyncError> {
    key_state_full
        .with_sync_key_for_fingerprint(&payload.key_fingerprint, |sync_k| {
            let inner = payload
                .chunks_ciphertext
                .get(1..)
                .ok_or_else(|| "chunks_ciphertext: empty envelope".to_string())?;
            crate::utils::encryption::decrypt_data(sync_k, inner)
        })
        .map_err(SyncError::Serialization)
}

/// Split an arbitrary list of chunk vectors into batches whose bincode-
/// serialized plaintext size stays under [`MAX_BATCH_PLAINTEXT_BYTES`]. A
/// single chunk vector larger than the bound is placed alone in its own
/// batch rather than dropped — data is never silently lost, even though
/// this should not happen in practice for realistic embedding dimensions.
///
/// Empty input returns an empty `Vec` (no batches, nothing to sync).
pub fn batch_chunks_for_sync(chunks: Vec<EmbeddingChunkVector>) -> Vec<Vec<EmbeddingChunkVector>> {
    let mut batches: Vec<Vec<EmbeddingChunkVector>> = Vec::new();
    let mut current: Vec<EmbeddingChunkVector> = Vec::new();
    let mut current_size: u64 = 0;

    for chunk in chunks {
        let chunk_size = bincode_opts().serialized_size(&chunk).unwrap_or(0);
        if !current.is_empty() && current_size + chunk_size > MAX_BATCH_PLAINTEXT_BYTES as u64 {
            batches.push(std::mem::take(&mut current));
            current_size = 0;
        }
        current_size += chunk_size;
        current.push(chunk);
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::encryption::{key_fingerprint, KEY_SIZE};
    use std::collections::BTreeMap;
    use zeroize::Zeroizing;

    fn make_real_key_state(raw_key: &[u8; KEY_SIZE]) -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        ks.set_key(Zeroizing::new(*raw_key))
            .expect("set_key never fails");
        ks
    }

    fn sample_chunk(entry_id: &str, model_id: &str, chunk_index: i64) -> EmbeddingChunkVector {
        let vec_f32 = vec![0.1_f32, -2.5, 3.75, 1e-6];
        EmbeddingChunkVector {
            entry_id: entry_id.to_string(),
            model_id: model_id.to_string(),
            chunk_index,
            content_hash: format!("hash-{entry_id}-{chunk_index}"),
            dim: vec_f32.len() as i64,
            vec: crate::db::embeddings::vec_to_blob(&vec_f32),
        }
    }

    // ─── Payload framing ────────────────────────────────────────────────────

    #[test]
    fn payload_roundtrip_preserves_bytes_and_version() {
        let original = SyncEmbeddingChunkPayload::new([0xAB; 32], vec![1, 2, 3, 4]);
        let bytes = serialize_embedding_payload(&original).unwrap();
        let back = deserialize_embedding_payload(&bytes).unwrap();
        assert_eq!(back, original);
        assert_eq!(back.schema_version, EMBEDDING_PAYLOAD_SCHEMA_VERSION);
    }

    #[test]
    fn payload_starts_with_distinct_magic() {
        let p = SyncEmbeddingChunkPayload::new([0; 32], vec![1]);
        let bytes = serialize_embedding_payload(&p).unwrap();
        assert_eq!(&bytes[..4], b"XJE1");
    }

    #[test]
    fn payload_missing_magic_is_rejected() {
        let body = bincode_opts()
            .serialize(&SyncEmbeddingChunkPayload::new([0; 32], vec![1]))
            .unwrap();
        let err = deserialize_embedding_payload(&body).unwrap_err();
        match err {
            SyncError::Serialization(msg) => assert!(msg.contains("magic")),
            _ => panic!("expected Serialization error, got {err:?}"),
        }
    }

    #[test]
    fn payload_unknown_version_returns_error() {
        let bad = SyncEmbeddingChunkPayload {
            schema_version: 999,
            key_fingerprint: [0; 32],
            chunks_ciphertext: vec![1, 2],
        };
        let bytes = serialize_embedding_payload(&bad).unwrap();
        let err = deserialize_embedding_payload(&bytes).unwrap_err();
        match err {
            SyncError::Serialization(msg) => assert!(msg.contains("999")),
            _ => panic!("expected Serialization error, got {err:?}"),
        }
    }

    /// Schema guard: the synced chunk-vector struct must never grow a job-
    /// queue field (status/attempts/last_error/...). If this test starts
    /// failing because someone added such a field, that is the bug — the
    /// `entry_embedding_jobs` dirty queue is device-local only.
    #[test]
    fn sync_chunks_never_include_job_queue_fields() {
        let v = sample_chunk("e1", "m1", 0);
        let json = serde_json::to_value(&v).unwrap();
        let actual: std::collections::BTreeSet<String> =
            json.as_object().unwrap().keys().cloned().collect();
        let expected: std::collections::BTreeSet<String> = [
            "entry_id",
            "model_id",
            "chunk_index",
            "content_hash",
            "dim",
            "vec",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(actual, expected);
    }

    // ─── Encrypt/decrypt round-trip (bit-exact) ────────────────────────────

    #[test]
    fn encrypt_decrypt_roundtrip_preserves_chunk_vectors_bit_exactly() {
        let key = [7u8; KEY_SIZE];
        let ks = make_real_key_state(&key);

        let chunks = vec![
            sample_chunk("entry-1", "bge-small-en-v1.5", 0),
            sample_chunk("entry-1", "bge-small-en-v1.5", 1),
            sample_chunk("entry-2", "bge-small-en-v1.5", 0),
        ];
        let plain = serialize_chunk_batch(&chunks).unwrap();

        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let ct = encrypt_embedding_bytes(&ks, &plain).unwrap();
        let payload = SyncEmbeddingChunkPayload::new(fp, ct);
        let wire = serialize_embedding_payload(&payload).unwrap();

        let back = deserialize_embedding_payload(&wire).unwrap();
        let decrypted = decrypt_embedding_bytes(&ks, &back.chunks_ciphertext).unwrap();
        let decoded = deserialize_chunk_batch(&decrypted).unwrap();

        assert_eq!(decoded, chunks, "chunk vectors must survive bit-exactly");
        for (original, roundtripped) in chunks.iter().zip(decoded.iter()) {
            assert_eq!(
                original.vec, roundtripped.vec,
                "vec LE f32 bytes must match exactly"
            );
            assert_eq!(original.dim, roundtripped.dim);
            assert_eq!(original.content_hash, roundtripped.content_hash);
            assert_eq!(original.model_id, roundtripped.model_id);
            assert_eq!(original.entry_id, roundtripped.entry_id);
            assert_eq!(original.chunk_index, roundtripped.chunk_index);
        }
        assert_eq!(back.key_fingerprint, fp);
    }

    // ─── Cross-path (writer → reader) fingerprint discipline guard ────────

    /// The fingerprint-trap guard: encrypt with the writer path
    /// (single-key `EncryptionKeyState`, `with_sync_key`), then decrypt with
    /// the READER path (`decrypt_embedding_bytes_by_fingerprint`, mirroring
    /// `ingest_entry` / `ingest_version`) using a *different*
    /// `EncryptionKeyState` instance that holds several content-key epochs —
    /// simulating a device that has been through a key rotation. The reader
    /// must find and use the matching epoch by fingerprint, and a reader
    /// whose key list has no matching key (or a tampered ciphertext) must be
    /// rejected, never silently mis-decrypt.
    #[test]
    fn cross_path_writer_bytes_decrypt_via_reader_fingerprint_lookup() {
        let matching_key = [9u8; KEY_SIZE];

        // Writer: single-key state, exactly like `push_single_entry`.
        let writer_ks = make_real_key_state(&matching_key);
        let fp = writer_ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();

        let chunks = vec![sample_chunk("entry-1", "bge-small-en-v1.5", 0)];
        let plain = serialize_chunk_batch(&chunks).unwrap();
        let ct = encrypt_embedding_bytes(&writer_ks, &plain).unwrap();
        let payload = SyncEmbeddingChunkPayload::new(fp, ct);
        let wire = serialize_embedding_payload(&payload).unwrap();
        let back = deserialize_embedding_payload(&wire).unwrap();

        // Reader: a DIFFERENT EncryptionKeyState instance holding multiple
        // content-key epochs, with the matching key stashed under a
        // non-trivial epoch number (2) alongside an unrelated epoch (1).
        let mut keys: BTreeMap<u32, Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
        keys.insert(1u32, Zeroizing::new([1u8; KEY_SIZE]));
        keys.insert(2u32, Zeroizing::new(matching_key));
        let reader_ks = crate::EncryptionKeyState::new();
        reader_ks
            .set_content_state(
                keys,
                2,
                Zeroizing::new(matching_key),
                Zeroizing::new(matching_key),
            )
            .unwrap();

        let decrypted = decrypt_embedding_bytes_by_fingerprint(&reader_ks, &back).unwrap();
        let decoded = deserialize_chunk_batch(&decrypted).unwrap();
        assert_eq!(
            decoded, chunks,
            "writer bytes must decrypt via reader path bit-exactly"
        );

        // Wrong key: a reader whose key list contains no matching epoch
        // must reject, not silently decrypt garbage.
        let mut wrong_keys: BTreeMap<u32, Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
        wrong_keys.insert(1u32, Zeroizing::new([3u8; KEY_SIZE]));
        let wrong_ks = crate::EncryptionKeyState::new();
        wrong_ks
            .set_content_state(
                wrong_keys,
                1,
                Zeroizing::new([3u8; KEY_SIZE]),
                Zeroizing::new([3u8; KEY_SIZE]),
            )
            .unwrap();
        assert!(
            decrypt_embedding_bytes_by_fingerprint(&wrong_ks, &back).is_err(),
            "reader with no matching key epoch must reject the payload"
        );

        // Tampered ciphertext: flip a byte inside the AEAD-protected region
        // and confirm the (correct-key) reader still rejects it.
        let mut tampered = back.clone();
        let last = tampered.chunks_ciphertext.len() - 1;
        tampered.chunks_ciphertext[last] ^= 0xFF;
        assert!(
            decrypt_embedding_bytes_by_fingerprint(&reader_ks, &tampered).is_err(),
            "tampered ciphertext must fail AEAD authentication"
        );
    }

    #[test]
    fn decrypt_with_wrong_key_fails_via_simple_path() {
        let key1 = [1u8; KEY_SIZE];
        let key2 = [2u8; KEY_SIZE];
        let ks1 = make_real_key_state(&key1);
        let ks2 = make_real_key_state(&key2);
        let ct = encrypt_embedding_bytes(&ks1, b"secret chunk vectors").unwrap();
        assert!(decrypt_embedding_bytes(&ks2, &ct).is_err());
    }

    // ─── Batching / size bound ──────────────────────────────────────────────

    #[test]
    fn batch_chunks_for_sync_empty_input_returns_no_batches() {
        assert!(batch_chunks_for_sync(vec![]).is_empty());
    }

    #[test]
    fn empty_batch_payload_serializes_and_roundtrips_within_bound() {
        let key = [5u8; KEY_SIZE];
        let ks = make_real_key_state(&key);
        let chunks: Vec<EmbeddingChunkVector> = vec![];
        let plain = serialize_chunk_batch(&chunks).unwrap();
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let ct = encrypt_embedding_bytes(&ks, &plain).unwrap();
        let payload = SyncEmbeddingChunkPayload::new(fp, ct);
        let wire = serialize_embedding_payload(&payload).unwrap();

        assert!((wire.len() as u64) < MAX_BATCH_PLAINTEXT_BYTES as u64);

        let back = deserialize_embedding_payload(&wire).unwrap();
        let decrypted = decrypt_embedding_bytes(&ks, &back.chunks_ciphertext).unwrap();
        let decoded = deserialize_chunk_batch(&decrypted).unwrap();
        assert!(decoded.is_empty());
    }

    #[test]
    fn batch_chunks_for_sync_splits_large_input_within_bound() {
        // 768-dim f32 vectors -> 3072-byte blobs, a realistic embedding size.
        let vec_bytes = crate::db::embeddings::vec_to_blob(&vec![0.5_f32; 768]);
        let chunks: Vec<EmbeddingChunkVector> = (0..5000)
            .map(|i| EmbeddingChunkVector {
                entry_id: format!("entry-{i}"),
                model_id: "bge-small-en-v1.5".to_string(),
                chunk_index: 0,
                content_hash: format!("hash-{i}"),
                dim: 768,
                vec: vec_bytes.clone(),
            })
            .collect();
        let total = chunks.len();

        let batches = batch_chunks_for_sync(chunks);
        assert!(!batches.is_empty());

        let mut seen = 0usize;
        for batch in &batches {
            assert!(!batch.is_empty(), "batching must not produce empty batches");
            seen += batch.len();
            let size = bincode_opts().serialized_size(batch).unwrap();
            assert!(
                size <= MAX_BATCH_PLAINTEXT_BYTES as u64,
                "batch of {} chunks serialized to {size} bytes, exceeding the {} byte bound",
                batch.len(),
                MAX_BATCH_PLAINTEXT_BYTES
            );
        }
        assert_eq!(seen, total, "batching must not drop or duplicate chunks");
    }

    #[test]
    fn batch_chunks_for_sync_keeps_oversized_single_chunk_alone() {
        // A single chunk whose vec bytes alone exceed the batch bound must
        // still be carried (in its own batch), never silently dropped.
        let huge_vec = vec![0u8; MAX_BATCH_PLAINTEXT_BYTES + 1024];
        let chunks = vec![EmbeddingChunkVector {
            entry_id: "entry-huge".to_string(),
            model_id: "bge-small-en-v1.5".to_string(),
            chunk_index: 0,
            content_hash: "hash-huge".to_string(),
            dim: (huge_vec.len() / 4) as i64,
            vec: huge_vec,
        }];
        let batches = batch_chunks_for_sync(chunks.clone());
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0], chunks);
    }
}
