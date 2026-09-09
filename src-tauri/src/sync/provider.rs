//! Sync provider abstraction.
//!
//! A `SyncProvider` is a small filesystem-shaped trait that lets the sync
//! engine talk to any backend (local directory, Google Drive, iCloud Drive,
//! …) through the same five operations: list devices, list files for a
//! device/kind, read a file, write a file, delete a file.
//!
//! The provider sees ciphertext only — encryption happens above this layer
//! in the sync engine, not inside the provider. This is the same separation
//! we use between `db` and `utils::encryption`: the I/O layer never touches
//! plaintext.

use async_trait::async_trait;
use thiserror::Error;

/// Which subfolder under `{device_id}/` to list — or the device root itself.
///
/// Using an enum rather than a raw `&str` makes it impossible to accidentally
/// request the wrong subfolder — the compiler enforces the distinction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    /// Journal entry files (`{device_id}/entries/*.bin`).
    Entries,
    /// Media files (`{device_id}/media/*`).
    Media,
    /// Journal metadata files (`{device_id}/journals/*.bin`).
    Journals,
    /// Entry version-snapshot files (`{device_id}/versions/*.bin`).
    Versions,
    /// Encrypted chunk-vector sync batch files
    /// (`{device_id}/embeddings/batch-*.bin`, see `sync::embedding_sync`).
    EmbeddingChunks,
    /// Files directly under `{device_id}/` (no subfolder) — e.g.
    /// `settings.bin`, `tags.bin`, `metadata.json`. Used by own-cloud
    /// reconcile to detect missing whole-table surface blobs.
    DeviceRoot,
}

impl FileKind {
    /// Returns the subfolder name for this kind.
    ///
    /// Returns `None` for [`FileKind::DeviceRoot`] (files live at the device
    /// folder root, not under a named subfolder). Callers that join paths
    /// must branch on `DeviceRoot` before calling this.
    pub fn subfolder_name(self) -> Option<&'static str> {
        match self {
            FileKind::Entries => Some("entries"),
            FileKind::Media => Some("media"),
            FileKind::Journals => Some("journals"),
            FileKind::Versions => Some("versions"),
            FileKind::EmbeddingChunks => Some("embeddings"),
            FileKind::DeviceRoot => None,
        }
    }
}

/// Errors a sync provider can surface to the engine.
///
/// Marked `#[non_exhaustive]` so future chunks can add transport-specific
/// variants (e.g. `RateLimited`, `TokenExpired` for Google Drive) without
/// breaking match arms in the rest of the codebase.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum SyncError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("io: {0}")]
    Io(String),
    #[error("network: {0}")]
    Network(String),
    #[error("auth: {0}")]
    Auth(String),
    /// The granted OAuth scope does not include `drive.appdata`. This means
    /// the user is still holding a refresh token from the legacy `drive.file`
    /// era and must reconnect to receive a new appdata-scoped grant. Distinct
    /// from `Auth` so the engine can trigger the migration UX (auto-disconnect
    /// + reconnect banner) instead of a generic re-auth error.
    #[error("scope mismatch: {0}")]
    ScopeMismatch(String),
    #[error("serialization: {0}")]
    Serialization(String),
    #[error("merge: {0}")]
    Merge(String),
    /// The pulled envelope's version byte is not one this build can decrypt.
    /// Since none-mode was removed there is no cross-mode case left; the
    /// variant now signals a fail-closed rejection of an unknown/unsupported
    /// envelope version. Distinct from `Auth` so callers can surface the right
    /// user-facing action hint. (Name kept for wire compatibility.)
    #[error("cross-mode reject: {0}")]
    CrossModeReject(String),
}

/// Result of a revision-aware read ([`SyncProvider::read_file_if_changed`]).
///
/// A provider that can resolve a revision token for a file returns
/// [`ConditionalRead::Unchanged`] when the caller already holds the current
/// revision — letting the engine skip re-downloading (and re-decrypting) a
/// body it already has. When the file has changed (or the caller supplied
/// `known_revision: None`, or the provider could not resolve a revision) the
/// bytes come back inside [`ConditionalRead::Changed`].
///
/// # The `None`-revision invariant
///
/// A `revision: None` in `Changed` means "the provider could not pin a
/// revision for this file" — the caller MUST NOT cache it. `None` is never a
/// cache hit: a caller passing `known_revision: None` ALWAYS receives the
/// bytes back via `Changed` (with whatever revision the provider managed to
/// resolve, or `None` if none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConditionalRead {
    /// The caller's `known_revision` matches the file's current revision.
    /// The body was not downloaded — the caller's cached copy is current.
    Unchanged,
    /// The file changed (or no revision was supplied / resolvable). The bytes
    /// are returned along with the provider's best-effort revision token for
    /// the just-read content, which the caller may cache for a future
    /// conditional read. `revision: None` means the provider could not resolve
    /// a revision and the caller MUST NOT cache the result.
    Changed {
        bytes: Vec<u8>,
        revision: Option<String>,
    },
}

/// A storage backend the sync engine can read and write through.
///
/// Path conventions are owned by the engine, not the provider:
///   - `{device_id}/metadata.json`
///   - `{device_id}/entries/{entry_id}.bin`
///   - `{device_id}/media/{media_id}`
///
/// Providers must accept slash-separated relative paths.
#[async_trait]
pub trait SyncProvider: Send + Sync {
    /// Return the directory names directly under the sync root. Each name is
    /// a `device_id`.
    async fn list_devices(&self) -> Result<Vec<String>, SyncError>;

    /// Return the list of file paths for the given device and kind, relative
    /// to the sync root (e.g. `["abc/entries/e1.bin", ...]` for Entries or
    /// `["abc/media/uuid", ...]` for Media).
    async fn list_files(&self, device_id: &str, kind: FileKind) -> Result<Vec<String>, SyncError>;

    /// Read a file at the given relative path.
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError>;

    /// Read a file only if the caller's `known_revision` is stale.
    ///
    /// Returns [`ConditionalRead::Unchanged`] when `known_revision` matches
    /// the file's current revision (no body download). Otherwise returns
    /// [`ConditionalRead::Changed`] with the bytes and the provider's
    /// best-effort revision token for the just-read content.
    ///
    /// # `known_revision: None`
    ///
    /// A caller with no cached revision ALWAYS receives the bytes back
    /// (`Changed`). Implementations must never return `Unchanged` when
    /// `known_revision` is `None`. Likewise, if the provider cannot resolve
    /// any revision, it returns `Changed { bytes, revision: None }` so the
    /// caller knows not to cache.
    ///
    /// The default implementation ignores `known_revision`, calls
    /// [`read_file`](Self::read_file), and returns the bytes with
    /// `revision: None`. This keeps every existing implementor compiling and
    /// behaviourally identical (no implementor breaks; none gains caching).
    /// Providers that can resolve a revision override this to short-circuit
    /// the body download when the caller is already current.
    async fn read_file_if_changed(
        &self,
        path: &str,
        known_revision: Option<&str>,
    ) -> Result<ConditionalRead, SyncError> {
        // Default: ignore `known_revision`, always read. We do not pretend to
        // know a revision, so the caller's cache stays unpopulated — exactly
        // the pre-conditional-read behaviour.
        let _ = known_revision;
        let bytes = self.read_file(path).await?;
        Ok(ConditionalRead::Changed {
            bytes,
            revision: None,
        })
    }

    /// Create or overwrite a file at the given relative path. Implementations
    /// should create any missing parent directories.
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError>;

    /// Remove a file. Returning `Ok(())` on a missing file is allowed (the
    /// engine treats deletion as idempotent).
    async fn delete_file(&self, path: &str) -> Result<(), SyncError>;
}

#[cfg(test)]
pub(crate) mod test_support {
    //! `MockProvider` — an in-memory implementation used only in tests to
    //! prove the trait can be implemented and to drive higher-level engine
    //! tests in later chunks.

    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    pub struct MockProvider {
        files: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl MockProvider {
        pub fn new() -> Self {
            Self {
                files: Mutex::new(HashMap::new()),
            }
        }
    }

    #[async_trait]
    impl SyncProvider for MockProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            // A device id is the leading path segment of a `device/...`
            // shaped key. Keys without `/` (e.g. a stray top-level file) are
            // ignored — they don't represent any device.
            let files = self.files.lock().unwrap();
            let mut devices: Vec<String> = files
                .keys()
                .filter_map(|p| p.split_once('/').map(|(head, _)| head.to_string()))
                .filter(|s| !s.is_empty())
                .collect();
            devices.sort();
            devices.dedup();
            Ok(devices)
        }

        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            let files = self.files.lock().unwrap();
            let mut out: Vec<String> = match kind.subfolder_name() {
                None => {
                    // DeviceRoot: one path segment after device_id (no nested `/`).
                    let prefix = format!("{device_id}/");
                    files
                        .keys()
                        .filter(|k| k.starts_with(&prefix) && !k[prefix.len()..].contains('/'))
                        .cloned()
                        .collect()
                }
                Some(subfolder) => {
                    let prefix = format!("{device_id}/{subfolder}/");
                    files
                        .keys()
                        .filter(|k| k.starts_with(&prefix))
                        .cloned()
                        .collect()
                }
            };
            out.sort();
            Ok(out)
        }

        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            let files = self.files.lock().unwrap();
            files
                .get(path)
                .cloned()
                .ok_or_else(|| SyncError::NotFound(path.to_string()))
        }

        /// Revision-aware read for the mock. The revision is a content sha256
        /// of the stored bytes — so a caller that hands back the revision it
        /// previously received gets `Unchanged` without "re-downloading". This
        /// makes the conditional-read contract observable in trait-level tests
        /// without a real backend.
        async fn read_file_if_changed(
            &self,
            path: &str,
            known_revision: Option<&str>,
        ) -> Result<ConditionalRead, SyncError> {
            let bytes = {
                let files = self.files.lock().unwrap();
                files
                    .get(path)
                    .cloned()
                    .ok_or_else(|| SyncError::NotFound(path.to_string()))?
            };
            let revision = mock_content_revision(&bytes);
            if known_revision == Some(revision.as_str()) {
                return Ok(ConditionalRead::Unchanged);
            }
            Ok(ConditionalRead::Changed {
                bytes,
                revision: Some(revision),
            })
        }

        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            let mut files = self.files.lock().unwrap();
            files.insert(path.to_string(), data.to_vec());
            Ok(())
        }

        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            let mut files = self.files.lock().unwrap();
            files.remove(path);
            Ok(())
        }
    }

    /// Content sha256 revision used by [`MockProvider::read_file_if_changed`].
    /// Reuses the `sha256:` synthetic-prefix convention so the trait-level
    /// "unchanged" test mirrors how the real providers derive revisions.
    pub fn mock_content_revision(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("sha256:{}", hex::encode(hasher.finalize()))
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::MockProvider;
    use super::*;

    #[tokio::test]
    async fn mock_provider_roundtrips_a_file() {
        let p = MockProvider::new();
        p.write_file("dev-a/entries/e1.bin", b"hello")
            .await
            .unwrap();
        let read = p.read_file("dev-a/entries/e1.bin").await.unwrap();
        assert_eq!(read, b"hello");
    }

    #[tokio::test]
    async fn mock_provider_lists_devices() {
        let p = MockProvider::new();
        p.write_file("dev-a/metadata.json", b"{}").await.unwrap();
        p.write_file("dev-b/metadata.json", b"{}").await.unwrap();
        p.write_file("dev-a/entries/e1.bin", b"x").await.unwrap();
        let mut devices = p.list_devices().await.unwrap();
        devices.sort();
        assert_eq!(devices, vec!["dev-a".to_string(), "dev-b".to_string()]);
    }

    #[tokio::test]
    async fn mock_provider_list_files_entries_for_one_device() {
        let p = MockProvider::new();
        p.write_file("dev-a/entries/e1.bin", b"a").await.unwrap();
        p.write_file("dev-a/entries/e2.bin", b"b").await.unwrap();
        p.write_file("dev-b/entries/e3.bin", b"c").await.unwrap();
        let files = p.list_files("dev-a", FileKind::Entries).await.unwrap();
        assert_eq!(
            files,
            vec![
                "dev-a/entries/e1.bin".to_string(),
                "dev-a/entries/e2.bin".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn mock_provider_list_files_media_for_one_device() {
        let p = MockProvider::new();
        p.write_file("dev-a/media/m1", b"img1").await.unwrap();
        p.write_file("dev-a/media/m2", b"img2").await.unwrap();
        p.write_file("dev-b/media/m3", b"img3").await.unwrap();
        // entries should NOT appear in media listing
        p.write_file("dev-a/entries/e1.bin", b"entry")
            .await
            .unwrap();
        let files = p.list_files("dev-a", FileKind::Media).await.unwrap();
        assert_eq!(
            files,
            vec!["dev-a/media/m1".to_string(), "dev-a/media/m2".to_string(),]
        );
    }

    #[tokio::test]
    async fn mock_provider_list_files_no_cross_contamination() {
        let p = MockProvider::new();
        p.write_file("dev-a/entries/e1.bin", b"a").await.unwrap();
        p.write_file("dev-a/media/m1", b"b").await.unwrap();
        let entries = p.list_files("dev-a", FileKind::Entries).await.unwrap();
        let media = p.list_files("dev-a", FileKind::Media).await.unwrap();
        assert!(entries.iter().all(|f| f.contains("/entries/")));
        assert!(media.iter().all(|f| f.contains("/media/")));
        assert_eq!(entries.len(), 1);
        assert_eq!(media.len(), 1);
    }

    #[tokio::test]
    async fn mock_provider_read_missing_returns_not_found() {
        let p = MockProvider::new();
        let err = p.read_file("nope").await.unwrap_err();
        assert!(matches!(err, SyncError::NotFound(_)));
    }

    #[tokio::test]
    async fn mock_provider_delete_is_idempotent() {
        let p = MockProvider::new();
        p.delete_file("nope").await.unwrap();
        p.write_file("a/b", b"x").await.unwrap();
        p.delete_file("a/b").await.unwrap();
        let err = p.read_file("a/b").await.unwrap_err();
        assert!(matches!(err, SyncError::NotFound(_)));
    }

    #[tokio::test]
    async fn mock_provider_ignores_slashless_and_leading_slash_keys() {
        // Top-level files (no `/`) and leading-slash keys both fail the
        // `device/...` shape and must not surface as devices.
        let p = MockProvider::new();
        p.write_file("orphan.txt", b"x").await.unwrap();
        p.write_file("/leading/x", b"x").await.unwrap();
        p.write_file("dev-a/entries/e1.bin", b"y").await.unwrap();
        let devices = p.list_devices().await.unwrap();
        assert_eq!(devices, vec!["dev-a".to_string()]);
    }

    #[test]
    fn sync_error_display_includes_payload() {
        let e = SyncError::NotFound("foo".to_string());
        assert_eq!(format!("{e}"), "not found: foo");
        let e = SyncError::Network("timeout".to_string());
        assert_eq!(format!("{e}"), "network: timeout");
    }

    // ─── ConditionalRead / read_file_if_changed (Phase 2, Task 2) ────────────

    #[tokio::test]
    async fn mock_read_if_changed_returns_unchanged_when_revision_matches() {
        let p = MockProvider::new();
        p.write_file("dev-a/entries/e1.bin", b"hello")
            .await
            .unwrap();
        // First read: caller has no cached revision → must get bytes + revision.
        let first = p
            .read_file_if_changed("dev-a/entries/e1.bin", None)
            .await
            .unwrap();
        let cached_revision = match first {
            ConditionalRead::Changed { bytes, revision } => {
                assert_eq!(bytes, b"hello");
                revision.expect("mock resolves a sha revision")
            }
            ConditionalRead::Unchanged => panic!("None revision must never be Unchanged"),
        };

        // Second read with the just-resolved revision → Unchanged, no body.
        let second = p
            .read_file_if_changed("dev-a/entries/e1.bin", Some(cached_revision.as_str()))
            .await
            .unwrap();
        assert_eq!(second, ConditionalRead::Unchanged);
    }

    #[tokio::test]
    async fn mock_read_if_changed_returns_changed_when_revision_differs() {
        let p = MockProvider::new();
        p.write_file("dev-a/entries/e1.bin", b"first")
            .await
            .unwrap();
        // Caller thinks the file is "stale" → must get fresh bytes + new revision.
        let got = p
            .read_file_if_changed("dev-a/entries/e1.bin", Some("sha256:stale"))
            .await
            .unwrap();
        match got {
            ConditionalRead::Changed { bytes, revision } => {
                assert_eq!(bytes, b"first");
                let rev = revision.expect("mock resolves a sha revision");
                assert_eq!(rev, test_support::mock_content_revision(b"first"));
                assert_ne!(rev, "sha256:stale");
            }
            ConditionalRead::Unchanged => panic!("stale revision must be Changed"),
        }
    }

    #[tokio::test]
    async fn mock_read_if_changed_none_revision_always_returns_changed() {
        let p = MockProvider::new();
        p.write_file("dev-a/entries/e1.bin", b"hello")
            .await
            .unwrap();
        let got = p
            .read_file_if_changed("dev-a/entries/e1.bin", None)
            .await
            .unwrap();
        // The None-invariant: caller with no cached revision ALWAYS gets bytes.
        match got {
            ConditionalRead::Changed { bytes, revision } => {
                assert_eq!(bytes, b"hello");
                assert!(
                    revision.is_some(),
                    "mock resolves a revision even on cold read"
                );
            }
            ConditionalRead::Unchanged => panic!("None revision must never be Unchanged"),
        }
    }

    #[tokio::test]
    async fn mock_read_if_changed_missing_returns_not_found() {
        let p = MockProvider::new();
        let err = p
            .read_file_if_changed("dev-a/entries/nope.bin", None)
            .await
            .unwrap_err();
        assert!(matches!(err, SyncError::NotFound(_)));
    }

    /// A provider whose `read_file_if_changed` is NOT overridden falls through
    /// to the default trait impl: it ignores `known_revision`, always reads,
    /// and reports `revision: None` (cannot cache). This pins that the default
    /// round-trips through any implementor — here via `MockProvider`-as-trait.
    #[tokio::test]
    async fn default_trait_impl_round_trips_through_mock_as_trait_object() {
        // We exercise the default impl indirectly: MockProvider overrides the
        // method, so build a tiny stand-in that does NOT override it and
        // confirm the default returns Changed { revision: None }.
        struct DefaultOnly(MockProvider);
        #[async_trait]
        impl SyncProvider for DefaultOnly {
            async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
                self.0.list_devices().await
            }
            async fn list_files(
                &self,
                device_id: &str,
                kind: FileKind,
            ) -> Result<Vec<String>, SyncError> {
                self.0.list_files(device_id, kind).await
            }
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                self.0.read_file(path).await
            }
            async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
                self.0.write_file(path, data).await
            }
            async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
                self.0.delete_file(path).await
            }
            // read_file_if_changed intentionally NOT overridden → default impl.
        }

        let inner = MockProvider::new();
        inner
            .write_file("dev-a/entries/e1.bin", b"hello")
            .await
            .unwrap();
        let p = DefaultOnly(inner);

        // Even with a (fake) known_revision, the default ignores it and returns
        // the bytes with revision: None — i.e. "cannot cache".
        let got = p
            .read_file_if_changed("dev-a/entries/e1.bin", Some("sha256:whatever"))
            .await
            .unwrap();
        match got {
            ConditionalRead::Changed { bytes, revision } => {
                assert_eq!(bytes, b"hello");
                assert!(revision.is_none(), "default impl never resolves a revision");
            }
            ConditionalRead::Unchanged => {
                panic!("default impl must not return Unchanged — it always reads")
            }
        }
    }
}
