//! Platform-independent Memlore logic shared by the desktop app and the web app.

pub mod encryption;
pub mod entry_sync;
pub mod envelope;
pub mod key_state;
pub mod keyring_types;
pub mod metadata;
pub mod outbox;
pub mod recovery;
pub mod sync_control;

/// Failure modes of the payload codec, kept independent of any sync transport.
/// Display strings match the desktop `SyncError` variants of the same names.
#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("serialization: {0}")]
    Serialization(String),
    #[error("merge: {0}")]
    Merge(String),
}
