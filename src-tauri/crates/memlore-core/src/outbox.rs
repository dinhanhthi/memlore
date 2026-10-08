//! Outbox format, serialization, sealing, and validation (v1 entries, v2 intents).
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
    #[error("invalid color: {0}")]
    InvalidColor(String),
    #[error("empty text: {field}")]
    EmptyText { field: &'static str },
    #[error("too many items: {field} (max {max})")]
    TooManyItems { field: &'static str, max: usize },
    #[error("invalid outbox intent file name: {0}")]
    InvalidIntentName(String),
    #[error("outbox intent file name does not match its body: {0}")]
    IntentNameMismatch(String),
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
            if !j.base.is_empty() && !is_safe_id(&j.base) {
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
    seal_frame(list, OUTBOX_SCHEMA_VERSION, &plain)
}

/// Encrypt `plain` under the latest key and wrap it in the `XJO1` frame
/// carrying `schema_version`. The frame layout is shared by every version.
fn seal_frame(
    list: &ContentKeyList,
    schema_version: u16,
    plain: &[u8],
) -> Result<Vec<u8>, OutboxError> {
    // Same double HKDF / K2 latest key as entries and media
    let (epoch, _) = list
        .keys
        .iter()
        .next_back()
        .ok_or_else(|| OutboxError::Envelope("no content keys in keyring".to_string()))?;
    let content = list.keys.get(epoch).unwrap();
    let key = crate::encryption::derive_sync_key(&crate::encryption::derive_sync_key(content));
    let fp = key_fingerprint(&key);

    let inner = encrypt_data(&key, plain).map_err(|e| OutboxError::Crypto(e.to_string()))?;
    let mut ct = Vec::with_capacity(1 + inner.len());
    ct.push(0x01); // Envelope V1 byte
    ct.extend_from_slice(&inner);

    let payload = SealedOutboxEntryPayload {
        schema_version,
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
    let (_, plain) = open_frame(list, bytes, &[OUTBOX_SCHEMA_VERSION])?;
    decode_v1_body(&plain)
}

/// Decode a v1 (bincode) body, check its inner schema version and validate it.
fn decode_v1_body(plain: &[u8]) -> Result<OutboxEntryV1, OutboxError> {
    let entry: OutboxEntryV1 = bincode_opts()
        .deserialize(plain)
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;
    if entry.schema_version != OUTBOX_SCHEMA_VERSION {
        return Err(OutboxError::UnsupportedVersion(entry.schema_version));
    }
    entry.validate()?;
    Ok(entry)
}

/// Check magic and frame version (against `supported`), find the key by
/// fingerprint and decrypt. Returns the frame version and the plaintext body.
fn open_frame(
    list: &ContentKeyList,
    bytes: &[u8],
    supported: &[u16],
) -> Result<(u16, Vec<u8>), OutboxError> {
    if bytes.len() < OUTBOX_MAGIC.len() {
        return Err(OutboxError::ShortBuffer);
    }
    if bytes[..OUTBOX_MAGIC.len()] != OUTBOX_MAGIC {
        return Err(OutboxError::BadMagic);
    }

    let payload: SealedOutboxEntryPayload = bincode_opts()
        .deserialize(&bytes[OUTBOX_MAGIC.len()..])
        .map_err(|e| OutboxError::Serialization(e.to_string()))?;

    // Version is checked before any key work so an unreadable newer file is
    // always `UnsupportedVersion` (importer: `skipped_version`), never `corrupt`.
    if !supported.contains(&payload.schema_version) {
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
    Ok((payload.schema_version, plain))
}

/// Outbox frame versions this build can read: v1 = entry intent (bincode),
/// v2 = journal/tag/template/trash intents (JSON). `OUTBOX_SCHEMA_VERSION`
/// stays 1 because v0.2.2 desktops compare the frame version against it.
pub const SUPPORTED_OUTBOX_VERSIONS: &[u16] = &[1, 2];

/// Frame version carrying an `OutboxIntentV2` JSON body.
pub const OUTBOX_INTENT_V2_SCHEMA_VERSION: u16 = 2;

/// Maximum journal / tag / template name length (chars).
pub const MAX_INTENT_NAME_CHARS: usize = 200;
/// Maximum number of `auto_tag_ids` on a journal intent.
pub const MAX_AUTO_TAG_IDS: usize = 100;
/// Decoded template body cap. Mirror of desktop
/// `src-tauri/src/db/queries.rs` `MAX_TEMPLATE_CONTENT_BYTES`; keep identical so
/// a v2 intent never carries a template the desktop refuses to store.
pub const MAX_TEMPLATE_CONTENT_BYTES: usize = 8 * 1024 * 1024;
/// Template description cap in bytes. Mirror of desktop
/// `src-tauri/src/db/queries.rs` `MAX_TEMPLATE_DESCRIPTION_BYTES`; keep identical.
pub const MAX_TEMPLATE_DESCRIPTION_BYTES: usize = 4 * 1024;

/// Decrypted v2 outbox intent. CLOSED schema: any new kind or field is a new
/// frame version, never an edit here, so a body is rejected whole rather than
/// half-applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutboxIntentV2 {
    CreateJournal {
        web_device_id: String,
        web_updated_at_secs: i64,
        journal_id: String,
        name: String,
        color: Option<String>,
        auto_tag_ids: Vec<String>,
    },
    CreateTag {
        web_device_id: String,
        web_updated_at_secs: i64,
        tag_id: String,
        name: String,
        color: Option<String>,
    },
    /// `base_updated_at: None` = create.
    UpsertTemplate {
        web_device_id: String,
        web_updated_at_secs: i64,
        template_id: String,
        name: String,
        description: Option<String>,
        content_b64: Option<String>,
        sort_order: i64,
        base_updated_at: Option<i64>,
    },
    DeleteTemplate {
        web_device_id: String,
        web_updated_at_secs: i64,
        template_id: String,
        base_updated_at: i64,
    },
    TrashEntry {
        web_device_id: String,
        web_updated_at_secs: i64,
        entry_id: String,
        base_updated_at: i64,
    },
}

/// File-name prefix of a v2 intent in `<webId>/outbox/`. Entry intents keep
/// the bare `<uuid>.bin` name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxIntentPrefix {
    Journal,
    Tag,
    Template,
    Trash,
}

impl OutboxIntentPrefix {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Journal => "j-",
            Self::Tag => "t-",
            Self::Template => "p-",
            Self::Trash => "d-",
        }
    }
}

/// Same shape the desktop enforces for tag colors (`#RRGGBB`); journal
/// colors come from the same palette.
fn is_valid_color(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

fn check_id(id: &str) -> Result<(), OutboxError> {
    if is_safe_id(id) {
        Ok(())
    } else {
        Err(OutboxError::InvalidId(id.to_string()))
    }
}

fn check_name(name: &str) -> Result<(), OutboxError> {
    if name.trim().is_empty() {
        return Err(OutboxError::EmptyText { field: "name" });
    }
    if name.chars().count() > MAX_INTENT_NAME_CHARS {
        return Err(OutboxError::TextTooLong {
            field: "name",
            max: MAX_INTENT_NAME_CHARS,
        });
    }
    Ok(())
}

fn check_color(color: &Option<String>) -> Result<(), OutboxError> {
    match color {
        Some(c) if !is_valid_color(c) => Err(OutboxError::InvalidColor(c.clone())),
        _ => Ok(()),
    }
}

fn check_template_content(content_b64: &str) -> Result<(), OutboxError> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    // Reject before decoding: base64 is 4/3 of the decoded size.
    if content_b64.len() > MAX_TEMPLATE_CONTENT_BYTES * 4 / 3 + 16 {
        return Err(OutboxError::DocTooLarge {
            len: content_b64.len() / 4 * 3,
            max: MAX_TEMPLATE_CONTENT_BYTES,
        });
    }
    let decoded = B64
        .decode(content_b64)
        // Fixed message: base64 errors name the offending byte and offset.
        .map_err(|_| OutboxError::Serialization("content_b64: invalid base64".to_string()))?;
    if decoded.len() > MAX_TEMPLATE_CONTENT_BYTES {
        return Err(OutboxError::DocTooLarge {
            len: decoded.len(),
            max: MAX_TEMPLATE_CONTENT_BYTES,
        });
    }
    Ok(())
}

fn check_template_description(description: &Option<String>) -> Result<(), OutboxError> {
    match description {
        Some(d) if d.len() > MAX_TEMPLATE_DESCRIPTION_BYTES => Err(OutboxError::TextTooLong {
            field: "description",
            max: MAX_TEMPLATE_DESCRIPTION_BYTES,
        }),
        _ => Ok(()),
    }
}

impl OutboxIntentV2 {
    pub fn web_device_id(&self) -> &str {
        match self {
            Self::CreateJournal { web_device_id, .. }
            | Self::CreateTag { web_device_id, .. }
            | Self::UpsertTemplate { web_device_id, .. }
            | Self::DeleteTemplate { web_device_id, .. }
            | Self::TrashEntry { web_device_id, .. } => web_device_id,
        }
    }

    /// Id of the journal / tag / template / entry the intent acts on.
    pub fn target_id(&self) -> &str {
        match self {
            Self::CreateJournal { journal_id, .. } => journal_id,
            Self::CreateTag { tag_id, .. } => tag_id,
            Self::UpsertTemplate { template_id, .. } | Self::DeleteTemplate { template_id, .. } => {
                template_id
            }
            Self::TrashEntry { entry_id, .. } => entry_id,
        }
    }

    pub fn prefix(&self) -> OutboxIntentPrefix {
        match self {
            Self::CreateJournal { .. } => OutboxIntentPrefix::Journal,
            Self::CreateTag { .. } => OutboxIntentPrefix::Tag,
            Self::UpsertTemplate { .. } | Self::DeleteTemplate { .. } => {
                OutboxIntentPrefix::Template
            }
            Self::TrashEntry { .. } => OutboxIntentPrefix::Trash,
        }
    }

    /// Outbox file name: `<prefix><target_id>.bin`.
    pub fn file_name(&self) -> String {
        format!("{}{}.bin", self.prefix().as_str(), self.target_id())
    }

    pub fn validate(&self) -> Result<(), OutboxError> {
        check_id(self.web_device_id())?;
        check_id(self.target_id())?;
        match self {
            Self::CreateJournal {
                name,
                color,
                auto_tag_ids,
                ..
            } => {
                check_name(name)?;
                check_color(color)?;
                if auto_tag_ids.len() > MAX_AUTO_TAG_IDS {
                    return Err(OutboxError::TooManyItems {
                        field: "auto_tag_ids",
                        max: MAX_AUTO_TAG_IDS,
                    });
                }
                auto_tag_ids.iter().try_for_each(|id| check_id(id))
            }
            Self::CreateTag { name, color, .. } => {
                check_name(name)?;
                check_color(color)
            }
            Self::UpsertTemplate {
                name,
                description,
                content_b64,
                ..
            } => {
                check_name(name)?;
                check_template_description(description)?;
                content_b64
                    .as_deref()
                    .map_or(Ok(()), check_template_content)
            }
            Self::DeleteTemplate { .. } | Self::TrashEntry { .. } => Ok(()),
        }
    }
}

/// Parse a v2 intent file name (`j-`/`t-`/`p-`/`d-` + safe id + `.bin`).
/// Entry intents (`<uuid>.bin`) and media files (`m-…`) are rejected.
pub fn parse_intent_name(name: &str) -> Result<(OutboxIntentPrefix, &str), OutboxError> {
    let invalid = || OutboxError::InvalidIntentName(name.to_string());
    let stem = name.strip_suffix(".bin").ok_or_else(invalid)?;
    let prefix = [
        OutboxIntentPrefix::Journal,
        OutboxIntentPrefix::Tag,
        OutboxIntentPrefix::Template,
        OutboxIntentPrefix::Trash,
    ]
    .into_iter()
    .find(|p| stem.starts_with(p.as_str()))
    .ok_or_else(invalid)?;
    let id = &stem[prefix.as_str().len()..];
    if !is_safe_id(id) {
        return Err(invalid());
    }
    Ok((prefix, id))
}

/// Check that a file's name agrees with its decrypted body: prefix ↔ kind
/// and id ↔ target id.
pub fn check_intent_name(name: &str, intent: &OutboxIntentV2) -> Result<(), OutboxError> {
    let (prefix, id) = parse_intent_name(name)?;
    if prefix != intent.prefix() || id != intent.target_id() {
        return Err(OutboxError::IntentNameMismatch(name.to_string()));
    }
    Ok(())
}

/// Any outbox intent this build can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutboxIntent {
    V1(OutboxEntryV1),
    V2(OutboxIntentV2),
}

/// Seal a v2 intent: JSON body, same key/AEAD as v1, frame version 2.
pub fn seal_outbox_intent_v2(
    list: &ContentKeyList,
    intent: &OutboxIntentV2,
) -> Result<Vec<u8>, OutboxError> {
    intent.validate()?;
    let plain =
        serde_json::to_vec(intent).map_err(|e| OutboxError::Serialization(e.to_string()))?;
    seal_frame(list, OUTBOX_INTENT_V2_SCHEMA_VERSION, &plain)
}

/// Open any supported outbox intent, dispatching on the frame version.
/// Versions outside `SUPPORTED_OUTBOX_VERSIONS` → `UnsupportedVersion`.
pub fn open_outbox_intent(
    list: &ContentKeyList,
    bytes: &[u8],
) -> Result<OutboxIntent, OutboxError> {
    let (version, plain) = open_frame(list, bytes, SUPPORTED_OUTBOX_VERSIONS)?;
    match version {
        OUTBOX_SCHEMA_VERSION => decode_v1_body(&plain).map(OutboxIntent::V1),
        OUTBOX_INTENT_V2_SCHEMA_VERSION => {
            let intent: OutboxIntentV2 = serde_json::from_slice(&plain).map_err(|e| {
                OutboxError::Serialization(format!("v2 body: {}", crate::json_error_summary(&e)))
            })?;
            intent.validate()?;
            Ok(OutboxIntent::V2(intent))
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

    /// v1 file sealed by the pre-v2 code (`sample_keyring(0x42)`, `sample_entry()`).
    /// Wire bytes on users' Drives must keep opening unchanged.
    const V1_FIXTURE_HEX: &str = "584a4f3101006df7030e6b183f45789d6b97a2f8a97060b03f65e1cf091a018b0df6dd5ab7bf4101000000000000011e0abde7092075c8d85e7c2967538730e6814a954d12ba69005ddf4cc5ed6be0efe587db2708a804dcba2684995e53c3b733dbd55b0cc22a17ae64f03d63504fb2a0cbb6e457dcab69a697025f03c30866c894ae5721fd5a06e4319eb6a99845ee5f6b9a96581bed7fd5b2589e0d522ed1805f703bae27a41c443b6cab29aa6f8bd7db5dbeea5550a16f9da3e8446a8860f8375ebb4d92f39dc9fd7130ec6633183682fe9af17f6f2360ca7111a562d0061a450487454317c5bb68ee27ea14d5f5050121ffd8bdec543821c5f0e141749eb88e46a3c954258e6a9286c00775d5dcb6b371c22fc12e6dc6529e22e4afb86cd2d04922950b426be50dfe19feccf73315075d41496a573182d6044939b4c8951b871454866e547341cd5d555ee9f810d1a26c8870764b50dac26e5f1fe17caf9bf3e734d593b46f8fe8d4128f17e5";

    fn ring_fingerprint(ring: &ContentKeyList) -> [u8; 32] {
        let content = ring.keys.values().next_back().unwrap();
        key_fingerprint(&crate::encryption::derive_sync_key(
            &crate::encryption::derive_sync_key(content),
        ))
    }

    #[test]
    fn v1_fixture_sealed_before_v2_still_opens() {
        let ring = sample_keyring(0x42);
        let bytes = hex::decode(V1_FIXTURE_HEX).unwrap();
        assert_eq!(open_outbox_entry(&ring, &bytes).unwrap(), sample_entry());
        assert_eq!(
            open_outbox_intent(&ring, &bytes).unwrap(),
            OutboxIntent::V1(sample_entry())
        );
    }

    #[test]
    fn v1_seal_frame_layout_unchanged() {
        let ring = sample_keyring(0x42);
        let sealed = seal_outbox_entry(&ring, &sample_entry()).unwrap();
        let fixture = hex::decode(V1_FIXTURE_HEX).unwrap();
        assert_eq!(sealed.len(), fixture.len());
        assert_eq!(&sealed[..4], b"XJO1");
        assert_eq!(&sealed[4..6], &[1, 0]);
        assert_eq!(&sealed[6..38], &ring_fingerprint(&ring));
        // ciphertext length prefix (u64 LE) and envelope byte
        assert_eq!(&sealed[..47], &fixture[..47]);
    }

    #[test]
    fn v1_audio_mime_still_rejected() {
        let ring = sample_keyring(0x42);
        let mut entry = sample_entry();
        entry.media[0].file_type = "audio/mpeg".to_string();
        assert_eq!(
            seal_outbox_entry(&ring, &entry).unwrap_err(),
            OutboxError::UnsupportedMime("audio/mpeg".to_string())
        );
    }

    const WEB: &str = "web-dev-12345678";

    fn all_v2_kinds() -> Vec<OutboxIntentV2> {
        vec![
            OutboxIntentV2::CreateJournal {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000000,
                journal_id: "journal-12345678".to_string(),
                name: "Travel".to_string(),
                color: Some("#7C3AED".to_string()),
                auto_tag_ids: vec!["tag-aaaaaaaa".to_string()],
            },
            OutboxIntentV2::CreateTag {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000001,
                tag_id: "tag-12345678".to_string(),
                name: "work".to_string(),
                color: None,
            },
            OutboxIntentV2::UpsertTemplate {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000002,
                template_id: "template-12345678".to_string(),
                name: "Gratitude".to_string(),
                description: Some("three things".to_string()),
                content_b64: Some("AQID".to_string()),
                sort_order: 3,
                base_updated_at: None,
            },
            OutboxIntentV2::DeleteTemplate {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000003,
                template_id: "template-12345678".to_string(),
                base_updated_at: 1690000000,
            },
            OutboxIntentV2::TrashEntry {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1700000004,
                entry_id: "entry-12345678".to_string(),
                base_updated_at: 1690000001,
            },
        ]
    }

    fn sample_journal() -> OutboxIntentV2 {
        all_v2_kinds().remove(0)
    }

    /// Seal an arbitrary JSON body in a v2 frame, bypassing typed validation.
    fn seal_raw_v2(ring: &ContentKeyList, json: &str) -> Vec<u8> {
        seal_frame(ring, OUTBOX_INTENT_V2_SCHEMA_VERSION, json.as_bytes()).unwrap()
    }

    #[test]
    fn v2_roundtrips_every_kind() {
        let ring = sample_keyring(0x42);
        for intent in all_v2_kinds() {
            let sealed = seal_outbox_intent_v2(&ring, &intent).unwrap();
            assert_eq!(&sealed[..4], b"XJO1");
            assert_eq!(&sealed[4..6], &[2, 0]);
            assert_eq!(
                open_outbox_intent(&ring, &sealed).unwrap(),
                OutboxIntent::V2(intent)
            );
        }
    }

    #[test]
    fn v2_kind_tags_are_snake_case() {
        let kinds: Vec<String> = all_v2_kinds()
            .iter()
            .map(|i| {
                serde_json::to_value(i).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "create_journal",
                "create_tag",
                "upsert_template",
                "delete_template",
                "trash_entry"
            ]
        );
    }

    /// A v0.2.2 desktop only calls `open_outbox_entry`; a v2 file must land
    /// as `skipped_version`, never `corrupt` — even under a key it lacks.
    #[test]
    fn v2_frame_is_unsupported_version_for_v1_opener() {
        let ring = sample_keyring(0x42);
        let sealed = seal_outbox_intent_v2(&ring, &sample_journal()).unwrap();
        assert_eq!(
            open_outbox_entry(&ring, &sealed).unwrap_err(),
            OutboxError::UnsupportedVersion(2)
        );
        assert_eq!(
            open_outbox_entry(&sample_keyring(0x99), &sealed).unwrap_err(),
            OutboxError::UnsupportedVersion(2)
        );
    }

    #[test]
    fn open_intent_rejects_unknown_frame_version() {
        let ring = sample_keyring(0x42);
        let bytes = seal_frame(&ring, 3, b"{}").unwrap();
        assert_eq!(
            open_outbox_intent(&ring, &bytes).unwrap_err(),
            OutboxError::UnsupportedVersion(3)
        );
    }

    #[test]
    fn v2_unknown_field_rejected() {
        let ring = sample_keyring(0x42);
        let mut v = serde_json::to_value(sample_journal()).unwrap();
        v["icon"] = serde_json::json!("book");
        let bytes = seal_raw_v2(&ring, &v.to_string());
        assert!(matches!(
            open_outbox_intent(&ring, &bytes).unwrap_err(),
            OutboxError::Serialization(_)
        ));
    }

    #[test]
    fn v2_unknown_kind_rejected() {
        let ring = sample_keyring(0x42);
        let bytes = seal_raw_v2(
            &ring,
            r#"{"kind":"rename_journal","web_device_id":"web-dev-12345678","web_updated_at_secs":1,"journal_id":"journal-12345678"}"#,
        );
        assert!(matches!(
            open_outbox_intent(&ring, &bytes).unwrap_err(),
            OutboxError::Serialization(_)
        ));
    }

    #[test]
    fn v2_open_validates_body() {
        let ring = sample_keyring(0x42);
        let mut v = serde_json::to_value(sample_journal()).unwrap();
        v["journal_id"] = serde_json::json!("../etc/passwd");
        let bytes = seal_raw_v2(&ring, &v.to_string());
        assert_eq!(
            open_outbox_intent(&ring, &bytes).unwrap_err(),
            OutboxError::InvalidId("../etc/passwd".to_string())
        );
    }

    #[test]
    fn v2_rejects_invalid_fields() {
        let ring = sample_keyring(0x42);
        let journal = |f: &dyn Fn(&mut OutboxIntentV2)| {
            let mut i = sample_journal();
            f(&mut i);
            seal_outbox_intent_v2(&ring, &i).unwrap_err()
        };
        assert_eq!(
            journal(&|i| if let OutboxIntentV2::CreateJournal { name, .. } = i {
                *name = "x".repeat(MAX_INTENT_NAME_CHARS + 1)
            }),
            OutboxError::TextTooLong {
                field: "name",
                max: MAX_INTENT_NAME_CHARS
            }
        );
        assert_eq!(
            journal(
                &|i| if let OutboxIntentV2::CreateJournal { color, .. } = i {
                    *color = Some("red".to_string())
                }
            ),
            OutboxError::InvalidColor("red".to_string())
        );
        assert_eq!(
            journal(
                &|i| if let OutboxIntentV2::CreateJournal { auto_tag_ids, .. } = i {
                    *auto_tag_ids = (0..=MAX_AUTO_TAG_IDS)
                        .map(|n| format!("tag-{n:08}"))
                        .collect()
                }
            ),
            OutboxError::TooManyItems {
                field: "auto_tag_ids",
                max: MAX_AUTO_TAG_IDS
            }
        );
        assert_eq!(
            journal(
                &|i| if let OutboxIntentV2::CreateJournal { auto_tag_ids, .. } = i {
                    *auto_tag_ids = vec!["bad/tag".to_string()]
                }
            ),
            OutboxError::InvalidId("bad/tag".to_string())
        );
        assert_eq!(
            journal(
                &|i| if let OutboxIntentV2::CreateJournal { web_device_id, .. } = i {
                    *web_device_id = "short".to_string()
                }
            ),
            OutboxError::InvalidId("short".to_string())
        );

        let template = |content: String| OutboxIntentV2::UpsertTemplate {
            web_device_id: WEB.to_string(),
            web_updated_at_secs: 1,
            template_id: "template-12345678".to_string(),
            name: "T".to_string(),
            description: None,
            content_b64: Some(content),
            sort_order: 0,
            base_updated_at: None,
        };
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let at_cap = B64.encode(vec![0u8; MAX_TEMPLATE_CONTENT_BYTES]);
        assert!(template(at_cap).validate().is_ok());
        let over = B64.encode(vec![0u8; MAX_TEMPLATE_CONTENT_BYTES + 1]);
        assert!(matches!(
            seal_outbox_intent_v2(&ring, &template(over)).unwrap_err(),
            OutboxError::DocTooLarge { .. }
        ));
        assert!(matches!(
            seal_outbox_intent_v2(&ring, &template("not base64!".to_string())).unwrap_err(),
            OutboxError::Serialization(_)
        ));
    }

    /// Desktop refuses templates over its caps (`db::queries`
    /// `check_template_size`); the closed schema must never accept them.
    #[test]
    fn v2_template_caps_match_desktop() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        assert_eq!(MAX_TEMPLATE_CONTENT_BYTES, 8 * 1024 * 1024);
        assert_eq!(MAX_TEMPLATE_DESCRIPTION_BYTES, 4 * 1024);
        let template =
            |description: Option<String>, content: Option<String>| OutboxIntentV2::UpsertTemplate {
                web_device_id: WEB.to_string(),
                web_updated_at_secs: 1,
                template_id: "template-12345678".to_string(),
                name: "T".to_string(),
                description,
                content_b64: content,
                sort_order: 0,
                base_updated_at: None,
            };
        // Between the template cap and the Yjs cap: desktop would refuse it.
        let over = B64.encode(vec![0u8; MAX_TEMPLATE_CONTENT_BYTES + 1]);
        assert_eq!(
            template(None, Some(over)).validate().unwrap_err(),
            OutboxError::DocTooLarge {
                len: MAX_TEMPLATE_CONTENT_BYTES + 1,
                max: MAX_TEMPLATE_CONTENT_BYTES
            }
        );
        // Description is measured in bytes, like desktop.
        let at_cap = "\u{e9}".repeat(MAX_TEMPLATE_DESCRIPTION_BYTES / 2);
        assert!(template(Some(at_cap.clone()), None).validate().is_ok());
        assert_eq!(
            template(Some(format!("{at_cap}x")), None)
                .validate()
                .unwrap_err(),
            OutboxError::TextTooLong {
                field: "description",
                max: MAX_TEMPLATE_DESCRIPTION_BYTES
            }
        );
    }

    #[test]
    fn v2_rejects_empty_or_blank_names() {
        let ring = sample_keyring(0x42);
        for intent in all_v2_kinds() {
            for blank in ["", "   ", "\t\n"] {
                let mut v = serde_json::to_value(&intent).unwrap();
                if v.get("name").is_none() {
                    continue;
                }
                v["name"] = serde_json::json!(blank);
                let typed: OutboxIntentV2 = serde_json::from_value(v.clone()).unwrap();
                assert_eq!(
                    typed.validate().unwrap_err(),
                    OutboxError::EmptyText { field: "name" },
                    "{v}"
                );
                // The opener applies the same rule to a raw body.
                assert_eq!(
                    open_outbox_intent(&ring, &seal_raw_v2(&ring, &v.to_string())).unwrap_err(),
                    OutboxError::EmptyText { field: "name" }
                );
            }
        }
    }

    #[test]
    fn intent_file_names_match_kind_and_id() {
        let names: Vec<String> = all_v2_kinds().iter().map(|i| i.file_name()).collect();
        assert_eq!(
            names,
            [
                "j-journal-12345678.bin",
                "t-tag-12345678.bin",
                "p-template-12345678.bin",
                "p-template-12345678.bin",
                "d-entry-12345678.bin"
            ]
        );
        for intent in all_v2_kinds() {
            assert_eq!(
                parse_intent_name(&intent.file_name()).unwrap(),
                (intent.prefix(), intent.target_id())
            );
            check_intent_name(&intent.file_name(), &intent).unwrap();
        }
    }

    #[test]
    fn parse_intent_name_rejects_non_intent_files() {
        for name in [
            "11111111-2222-3333-4444-555555555555.bin",
            "m-media-12345678",
            "m-media-12345678.thumb",
            "x-journal-12345678.bin",
            "j-journal-12345678",
            "j-short.bin",
            "j-bad/id-12345678.bin",
            "j-",
        ] {
            assert!(
                matches!(
                    parse_intent_name(name),
                    Err(OutboxError::InvalidIntentName(_))
                ),
                "{name}"
            );
        }
    }

    /// serde_json errors echo input fragments ("invalid type: string
    /// \"SECRET\"", "unknown variant `SECRET`"); the opener must not.
    #[test]
    fn v2_open_errors_never_echo_the_decrypted_body() {
        let ring = sample_keyring(0x42);
        let journal = serde_json::to_value(sample_journal()).unwrap();
        let mut wrong_type = journal.clone();
        wrong_type["name"] = serde_json::json!({"SECRET": "SECRET"});
        let mut wrong_type_str = journal.clone();
        wrong_type_str["auto_tag_ids"] = serde_json::json!("SECRET");
        let mut unknown_kind = journal.clone();
        unknown_kind["kind"] = serde_json::json!("SECRET_kind");
        let mut unknown_field = journal.clone();
        unknown_field["SECRET_field"] = serde_json::json!(1);
        for body in [
            wrong_type.to_string(),
            wrong_type_str.to_string(),
            unknown_kind.to_string(),
            unknown_field.to_string(),
            "{\"kind\":\"SECRET".to_string(),
        ] {
            let err = open_outbox_intent(&ring, &seal_raw_v2(&ring, &body)).unwrap_err();
            assert!(matches!(err, OutboxError::Serialization(_)), "{err:?}");
            assert!(!err.to_string().contains("SECRET"), "{err}");
        }
    }

    #[test]
    fn template_base64_error_has_no_input_fragment() {
        let err = check_template_content("AQID#SECRET").unwrap_err();
        assert!(matches!(err, OutboxError::Serialization(_)), "{err:?}");
        // Fixed text: no offending symbol, no offset.
        assert_eq!(
            err.to_string(),
            "serialization error: content_b64: invalid base64"
        );
    }

    #[test]
    fn check_intent_name_rejects_prefix_or_id_mismatch() {
        let journal = sample_journal();
        for name in ["t-journal-12345678.bin", "j-journal-87654321.bin"] {
            assert_eq!(
                check_intent_name(name, &journal).unwrap_err(),
                OutboxError::IntentNameMismatch(name.to_string())
            );
        }
    }
}
