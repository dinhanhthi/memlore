//! Platform-independent Memlore logic shared by the desktop app and the web app.

pub mod encryption;
pub mod entry_sync;
pub mod key_state;
pub mod recovery;

/// Failure modes of the payload codec, kept independent of any sync transport.
/// Display strings match the desktop `SyncError` variants of the same names.
#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("serialization: {0}")]
    Serialization(String),
    #[error("merge: {0}")]
    Merge(String),
}
