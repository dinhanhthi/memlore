//! Platform-independent Memlore logic shared by the desktop app and the web app.

pub mod encryption;
pub mod entry_sync;
pub mod envelope;
pub mod key_state;
pub mod keyring_types;
pub mod metadata;
pub mod month_index;
pub mod outbox;
pub mod recovery;
pub mod sync_control;
pub mod version;

pub use outbox::{
    check_intent_name, open_outbox_intent, parse_intent_name, seal_outbox_intent_v2, OutboxIntent,
    OutboxIntentPrefix, OutboxIntentV2, SUPPORTED_OUTBOX_VERSIONS,
};
pub use version::{
    deserialize_version_payload, open_version, seal_version, serialize_version_payload,
    OpenedVersion, SyncVersionPayload, VersionMetadata, VERSION_PAYLOAD_SCHEMA_VERSION,
};

/// Describe a serde_json error by class, line and column only. Never
/// `e.to_string()` on decrypted input: serde_json echoes fragments of it
/// (`invalid type: string "..."`, unknown variant / field names).
pub(crate) fn json_error_summary(e: &serde_json::Error) -> String {
    let class = match e.classify() {
        serde_json::error::Category::Io => "io",
        serde_json::error::Category::Syntax => "syntax",
        serde_json::error::Category::Data => "data",
        serde_json::error::Category::Eof => "unexpected end of input",
    };
    format!("{class} error at line {} column {}", e.line(), e.column())
}

/// Failure modes of the payload codec, kept independent of any sync transport.
/// Display strings match the desktop `SyncError` variants of the same names.
#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("serialization: {0}")]
    Serialization(String),
    #[error("merge: {0}")]
    Merge(String),
}
