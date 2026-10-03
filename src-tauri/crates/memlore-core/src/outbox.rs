//! Outbox format, serialization, sealing, and validation (v1).
//!
//! The outbox model allows the web companion to write sealed intents to
//! `generations/g-<N>/<webId>/outbox/` without touching sync-protocol files.
//! Desktops with the Phase 14 importer read and apply these intents using
//! their own local code.

use bincode::Options;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::encryption::{decrypt_data, encrypt_data, key_fingerprint, NONCE_SIZE, TAG_SIZE};
use crate::envelope::{self, EnvelopeError};
use crate::key_state::ContentKeyList;

/// Magic header for outbox entry files: ASCII "XJO1".
pub const OUTBOX_MAGIC: [u8; 4] = *b"XJO1";

/// Current on-disk outbox schema version.
pub const OUTBOX_SCHEMA_VERSION: u16 = 1;

/// Minimum safe ID byte length.
pub const MIN_SAFE_ID_BYTES: usize = 8;
/// Maximum safe ID byte length.
pub const MAX_SAFE_ID_BYTES: usize = 128;

/// Character class + length bounds for ids that may end up in FK columns,
/// path components, or chat attachment / `source_entry_ids` lists.
pub fn is_safe_id(s: &str) -> bool {
    let len = s.len();
    len >= MIN_SAFE_ID_BYTES
        && len <= MAX_SAFE_ID_BYTES
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Hard upper bound for any single Yjs document update (10 MiB).
pub const MAX_YJS_DOC_BYTES: usize = 10 * 1024 * 1024;

/// Upper bound for outbox payload serialization (32 MiB).
pub const MAX_OUTBOX_PAYLOAD_BYTES: u64 = 32 * 1024 * 1024;

/// Allowed MIME types for outbox media files. Never SVG or HTML.
pub const ALLOWED_MIME_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/quicktime",
];

pub const MAX_TITLE_CHARS: usize = 1000;
pub const MAX_CONTENT_TEXT_CHARS: usize = 10_000_000;
pub const MAX_PREVIEW_TEXT_CHARS: usize = 1000;
pub const MAX_ENTRY_DATE_CHARS: usize = 64;

fn bincode_opts() -> impl bincode::Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_OUTBOX_PAYLOAD_BYTES)
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum OutboxError {
    #[error("outbox buffer too short")]
    ShortBuffer,
    #[error("invalid outbox magic")]
    BadMagic,
    #[error("unsupported schema version: {0}")]
    UnsupportedVersion(u16),
    #[error("key fingerprint mismatch")]
    FingerprintMismatch,
    #[error("wrong decryption key")]
    WrongKey,
    #[error("unsafe id: {0}")]
    InvalidId(String),
    #[error("yjs doc too large: {len} bytes (max {max})")]
    DocTooLarge { len: usize, max: usize },
    #[error("unsupported mime type: {0}")]
    UnsupportedMime(String),
    #[error("text too long: {field} (max {max})")]
    TextTooLong { field: &'static str, max: usize },
    #[error("invalid emotion: {0}")]
    InvalidEmotion(String),
    #[error("envelope error: {0}")]
    Envelope(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("serialization error: {0}")]
    Serialization(String),
}

impl From<EnvelopeError> for OutboxError {
    fn from(e: EnvelopeError) -> Self {
        match e {
            EnvelopeError::ShortBuffer => OutboxError::ShortBuffer,
            EnvelopeError::WrongKey => OutboxError::WrongKey,
            EnvelopeError::FingerprintMismatch => OutboxError::FingerprintMismatch,
            other => OutboxError::Envelope(other.to_string()),
        }
    }
}

/// A recorded field modification from the web companion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldChange<T> {
    pub value: T,
    pub base: T,
    pub base_updated_at: i64,
    pub change_seq: u64,
    pub changed_at_secs: i64,
}

/// Set of field changes in an entry intent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxFields {
    pub title: Option<FieldChange<String>>,
    pub entry_date: Option<FieldChange<String>>,
    pub emotion: Option<FieldChange<Option<String>>>,
    pub is_favorite: Option<FieldChange<bool>>,
    pub journal_id: Option<FieldChange<String>>,
    #[serde(default)]
    pub tags_add: BTreeMap<String, FieldChange<bool>>,
    #[serde(default)]
    pub tags_remove: BTreeMap<String, FieldChange<bool>>,
}

/// Metadata reference for media associated with an outbox entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxMediaRef {
    pub media_id: String,
    pub file_name: String, // display only, never a path
    pub file_type: String,
    pub size: u64,
    pub has_thumb: bool,
}

/// Decrypted outbox entry intent (Version 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxEntryV1 {
    pub schema_version: u16,
    pub entry_id: String,
    pub web_device_id: String,
    pub created_on_web: bool,
    pub web_updated_at_secs: i64,
    pub base_state_vector: Vec<u8>,
    pub yjs_full_state: Vec<u8>,
    pub content_text: Option<String>,
    pub preview_text: Option<String>,
    pub fields: OutboxFields,
    pub media: Vec<OutboxMediaRef>,
}

impl OutboxEntryV1 {
    pub fn validate(&self) -> Result<(), OutboxError> {
        if !is_safe_id(&self.entry_id) {
            return Err(OutboxError::InvalidId(self.entry_id.clone()));
        }
        if !is_safe_id(&self.web_device_id) {
            return Err(OutboxError::InvalidId(self.web_device_id.clone()));
        }
        if self.yjs_full_state.len() > MAX_YJS_DOC_BYTES {
            return Err(OutboxError::DocTooLarge {
                len: self.yjs_full_state.len(),
                max: MAX_YJS_DOC_BYTES,
            });
        }
        if let Some(content) = &self.content_text {
            if content.chars().count() > MAX_CONTENT_TEXT_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "content_text",
                    max: MAX_CONTENT_TEXT_CHARS,
                });
            }
        }
        if let Some(preview) = &self.preview_text {
            if preview.chars().count() > MAX_PREVIEW_TEXT_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "preview_text",
                    max: MAX_PREVIEW_TEXT_CHARS,
                });
            }
        }
        if let Some(t) = &self.fields.title {
            if t.value.chars().count() > MAX_TITLE_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "title",
                    max: MAX_TITLE_CHARS,
                });
            }
            if t.base.chars().count() > MAX_TITLE_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "title.base",
                    max: MAX_TITLE_CHARS,
                });
            }
        }
        if let Some(d) = &self.fields.entry_date {
            if d.value.chars().count() > MAX_ENTRY_DATE_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "entry_date",
                    max: MAX_ENTRY_DATE_CHARS,
                });
            }
            if d.base.chars().count() > MAX_ENTRY_DATE_CHARS {
                return Err(OutboxError::TextTooLong {
                    field: "entry_date.base",
                    max: MAX_ENTRY_DATE_CHARS,
                });
            }
        }
        if let Some(j) = &self.fields.journal_id {
            if !is_safe_id(&j.value) {
                return Err(OutboxError::InvalidId(j.value.clone()));
            }
            if !is_safe_id(&j.base) {
                return Err(OutboxError::InvalidId(j.base.clone()));
            }
        }
        if let Some(e) = &self.fields.emotion {
            if let Some(val) = &e.value {
                if !matches!(val.as_str(), "good" | "neutral" | "bad") {
                    return Err(OutboxError::InvalidEmotion(val.clone()));
                }
            }
            if let Some(base_val) = &e.base {
                if !matches!(base_val.as_str(), "good" | "neutral" | "bad") {
                    return Err(OutboxError::InvalidEmotion(base_val.clone()));
                }
            }
        }
        for tag_id in self
            .fields
            .tags_add
            .keys()
            .chain(self.fields.tags_remove.keys())
        {
            if !is_safe_id(tag_id) {
                return Err(OutboxError::InvalidId(tag_id.clone()));
            }
        }
        for m in &self.media {
            if !is_safe_id(&m.media_id) {
                return Err(OutboxError::InvalidId(m.media_id.clone()));
            }
            if !ALLOWED_MIME_TYPES.contains(&m.file_type.as_str()) {
                return Err(OutboxError::UnsupportedMime(m.file_type.clone()));
            }
        }
        Ok(())
    }
}

/// Sealed payload frame written to disk.
#[derive(Serialize, Deserialize)]
struct SealedOutboxEntryPayload {
    schema_version: u16,
    key_fingerprint: [u8; 32],
    ciphertext: Vec<u8>,
}

/// Seal an `OutboxEntryV1` into wire bytes under the latest key in `ContentKeyList`.
pub fn seal_outbox_entry(
    list: &ContentKeyList,
    entry: &OutboxEntryV1,
) -> Result<Vec<u8>, OutboxError> {
    entry.validate()?;
    let plain = bincode_opts()
        .serialize(entry)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;

    // Same double HKDF / K2 latest key as entries and media
    let (epoch, _) = list
        .keys
        .iter()
        .next_back()
        .ok_or_else(|| OutboxError::Envelope("no content keys in keyring".to_string()))?;
    let content = list.keys.get(epoch).unwrap();
    let key = crate::encryption::derive_sync_key(&crate::encryption::derive_sync_key(content));
    let fp = key_fingerprint(&key);

    let inner = encrypt_data(&key, &plain).map_err(|e| OutboxError::Crypto(e.to_string()))?;
    let mut ct = Vec::with_capacity(1 + inner.len());
    ct.push(0x01); // Envelope V1 byte
    ct.extend_from_slice(&inner);

    let payload = SealedOutboxEntryPayload {
        schema_version: OUTBOX_SCHEMA_VERSION,
        key_fingerprint: fp,
        ciphertext: ct,
    };
    let payload_bytes = bincode_opts()
        .serialize(&payload)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;

    let mut out = Vec::with_capacity(OUTBOX_MAGIC.len() + payload_bytes.len());
    out.extend_from_slice(&OUTBOX_MAGIC);
    out.extend_from_slice(&payload_bytes);
    Ok(out)
}

/// Open an outbox entry file, validating magic, schema version, fingerprint, and payload fields.
pub fn open_outbox_entry(
    list: &ContentKeyList,
    bytes: &[u8],
) -> Result<OutboxEntryV1, OutboxError> {
    if bytes.len() < OUTBOX_MAGIC.len() {
        return Err(OutboxError::ShortBuffer);
    }
    if bytes[..OUTBOX_MAGIC.len()] != OUTBOX_MAGIC {
        return Err(OutboxError::BadMagic);
    }

    let payload: SealedOutboxEntryPayload = bincode_opts()
        .deserialize(&bytes[OUTBOX_MAGIC.len()..])
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;

    if payload.schema_version != OUTBOX_SCHEMA_VERSION {
        return Err(OutboxError::UnsupportedVersion(payload.schema_version));
    }

    // Locate matching key by fingerprint
    let mut matching_key = None;
    for content in list.keys.values() {
        let key = crate::encryption::derive_sync_key(&crate::encryption::derive_sync_key(content));
        if key_fingerprint(&key) == payload.key_fingerprint {
            matching_key = Some(key);
            break;
        }
    }
    let key = matching_key.ok_or(OutboxError::FingerprintMismatch)?;

    let (version, ct) = payload
        .ciphertext
        .split_first()
        .ok_or(OutboxError::ShortBuffer)?;
    if *version != 0x01 {
        return Err(OutboxError::Envelope(format!(
            "unsupported envelope version: {}",
            version
        )));
    }
    if ct.len() < NONCE_SIZE + TAG_SIZE {
        return Err(OutboxError::ShortBuffer);
    }

    let plain = decrypt_data(&key, ct).map_err(|_| OutboxError::WrongKey)?;

    let entry: OutboxEntryV1 = bincode_opts()
        .deserialize(&plain)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;

    match entry.schema_version {
        1 => {
            entry.validate()?;
            Ok(entry)
        }
        other => Err(OutboxError::UnsupportedVersion(other)),
    }
}

/// Individual field decision recorded in desktop acks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxFieldDecision {
    pub field: String,
    pub change_seq: u64,
    pub decision: String,
    pub decided_updated_at: i64,
    pub reason: Option<String>,
}

/// Individual entry ack in desktop acks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxAckEntry {
    pub path: String,
    pub content_hash: String,
    pub applied_updated_at: Option<i64>,
    pub decided: Vec<OutboxFieldDecision>,
    pub created: bool,
    pub refused_reason: Option<String>,
}

/// Desktop-published acknowledgements file (`outbox-acks.bin`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxAcksV1 {
    pub schema_version: u16,
    pub desktop_device_id: String,
    pub acks: Vec<OutboxAckEntry>,
}

/// Seal outbox acknowledgements using the V2 media envelope.
pub fn seal_outbox_acks(
    list: &ContentKeyList,
    acks: &OutboxAcksV1,
) -> Result<Vec<u8>, OutboxError> {
    let plain = bincode_opts()
        .serialize(acks)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;
    envelope::seal_media(list, &plain).map_err(OutboxError::from)
}

/// Open outbox acknowledgements using the V2 envelope.
pub fn open_outbox_acks(list: &ContentKeyList, bytes: &[u8]) -> Result<OutboxAcksV1, OutboxError> {
    let plain = envelope::open_media(list, bytes).map_err(OutboxError::from)?;
    let acks: OutboxAcksV1 = bincode_opts()
        .deserialize(&plain)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;
    match acks.schema_version {
        1 => Ok(acks),
        other => Err(OutboxError::UnsupportedVersion(other)),
    }
}

/// Seal media bytes for `<device>/outbox/m-<mediaId>`.
pub fn seal_outbox_media(list: &ContentKeyList, bytes: &[u8]) -> Result<Vec<u8>, OutboxError> {
    envelope::seal_media(list, bytes).map_err(OutboxError::from)
}

/// Seal a thumbnail for `<device>/outbox/m-<mediaId>.thumb`.
pub fn seal_outbox_thumb(list: &ContentKeyList, jpeg: &[u8]) -> Result<Vec<u8>, OutboxError> {
    envelope::seal_thumb(list, jpeg).map_err(OutboxError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::KEY_SIZE;
    use zeroize::Zeroizing;

    fn sample_keyring(master_byte: u8) -> ContentKeyList {
        let mut keys = BTreeMap::new();
        keys.insert(1, Zeroizing::new([master_byte; KEY_SIZE]));
        ContentKeyList {
            keys,
            latest: 1,
            db_key: Zeroizing::new([0u8; KEY_SIZE]),
            master: Zeroizing::new([master_byte; KEY_SIZE]),
        }
    }

    fn sample_entry() -> OutboxEntryV1 {
        OutboxEntryV1 {
            schema_version: 1,
            entry_id: "entry-12345678".to_string(),
            web_device_id: "web-dev-12345678".to_string(),
            created_on_web: true,
            web_updated_at_secs: 1700000000,
            base_state_vector: vec![1, 2, 3],
            yjs_full_state: vec![4, 5, 6],
            content_text: Some("hello web".to_string()),
            preview_text: Some("hello".to_string()),
            fields: OutboxFields {
                title: Some(FieldChange {
                    value: "My Title".to_string(),
                    base: "".to_string(),
                    base_updated_at: 0,
                    change_seq: 1,
                    changed_at_secs: 1700000000,
                }),
                emotion: Some(FieldChange {
                    value: Some("good".to_string()),
                    base: None,
                    base_updated_at: 0,
                    change_seq: 2,
                    changed_at_secs: 1700000000,
                }),
                ..Default::default()
            },
            media: vec![OutboxMediaRef {
                media_id: "media-12345678".to_string(),
                file_name: "photo.jpg".to_string(),
                file_type: "image/jpeg".to_string(),
                size: 1024,
                has_thumb: true,
            }],
        }
    }

    #[test]
    fn test_roundtrip_outbox_entry() {
        let ring = sample_keyring(0x42);
        let entry = sample_entry();
        let sealed = seal_outbox_entry(&ring, &entry).expect("seal");
        let opened = open_outbox_entry(&ring, &sealed).expect("open");
        assert_eq!(opened, entry);
    }

    #[test]
    fn test_wrong_key() {
        let ring1 = sample_keyring(0x42);
        let ring2 = sample_keyring(0x99);
        let entry = sample_entry();
        let sealed = seal_outbox_entry(&ring1, &entry).expect("seal");
        let err = open_outbox_entry(&ring2, &sealed).unwrap_err();
        assert_eq!(err, OutboxError::FingerprintMismatch);
    }

    #[test]
    fn test_truncation() {
        let ring = sample_keyring(0x42);
        let entry = sample_entry();
        let sealed = seal_outbox_entry(&ring, &entry).expect("seal");
        let err = open_outbox_entry(&ring, &sealed[..10]).unwrap_err();
        assert!(matches!(err, OutboxError::Serialization(_)));
    }

    #[test]
    fn test_bad_magic() {
        let ring = sample_keyring(0x42);
        let entry = sample_entry();
        let mut sealed = seal_outbox_entry(&ring, &entry).expect("seal");
        sealed[0] = b'Z';
        assert_eq!(
            open_outbox_entry(&ring, &sealed).unwrap_err(),
            OutboxError::BadMagic
        );
    }

    #[test]
    fn test_unsupported_version() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.schema_version = 2;
        // Sealing validates or serializes version 2
        let plain = bincode_opts().serialize(&entry).unwrap();
        let (epoch, _) = ring.keys.iter().next_back().unwrap();
        let content = ring.keys.get(epoch).unwrap();
        let key = crate::encryption::derive_sync_key(&crate::encryption::derive_sync_key(content));
        let fp = key_fingerprint(&key);
        let inner = encrypt_data(&key, &plain).unwrap();
        let mut ct = vec![0x01];
        ct.extend_from_slice(&inner);
        let payload = SealedOutboxEntryPayload {
            schema_version: 2,
            key_fingerprint: fp,
            ciphertext: ct,
        };
        let mut bytes = OUTBOX_MAGIC.to_vec();
        bytes.extend_from_slice(&bincode_opts().serialize(&payload).unwrap());

        let err = open_outbox_entry(&ring, &bytes).unwrap_err();
        assert_eq!(err, OutboxError::UnsupportedVersion(2));
    }

    #[test]
    fn test_unsafe_id() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.entry_id = "bad/id".to_string();
        let err = seal_outbox_entry(&ring, &entry).unwrap_err();
        assert_eq!(err, OutboxError::InvalidId("bad/id".to_string()));
    }

    #[test]
    fn test_oversized_doc() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.yjs_full_state = vec![0u8; MAX_YJS_DOC_BYTES + 1];
        let err = seal_outbox_entry(&ring, &entry).unwrap_err();
        assert_eq!(
            err,
            OutboxError::DocTooLarge {
                len: MAX_YJS_DOC_BYTES + 1,
                max: MAX_YJS_DOC_BYTES
            }
        );
    }

    #[test]
    fn test_svg_mime_rejected() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.media[0].file_type = "image/svg+xml".to_string();
        let err = seal_outbox_entry(&ring, &entry).unwrap_err();
        assert_eq!(
            err,
            OutboxError::UnsupportedMime("image/svg+xml".to_string())
        );
    }

    #[test]
    fn test_roundtrip_acks() {
        let ring = sample_keyring(0x42);
        let acks = OutboxAcksV1 {
            schema_version: 1,
            desktop_device_id: "desktop-dev-12345678".to_string(),
            acks: vec![OutboxAckEntry {
                path: "web-dev-12345678/outbox/entry-12345678.bin".to_string(),
                content_hash: "hash1234".to_string(),
                applied_updated_at: Some(1700000010),
                decided: vec![OutboxFieldDecision {
                    field: "title".to_string(),
                    change_seq: 1,
                    decision: "applied".to_string(),
                    decided_updated_at: 1700000010,
                    reason: None,
                }],
                created: true,
                refused_reason: None,
            }],
        };
        let sealed = seal_outbox_acks(&ring, &acks).expect("seal acks");
        let opened = open_outbox_acks(&ring, &sealed).expect("open acks");
        assert_eq!(opened, acks);
    }
}
