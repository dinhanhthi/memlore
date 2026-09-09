//! Unified cloud sync provider: Google Drive or a local/iCloud folder.
//!
//! Enum dispatch (not trait objects) so both [`SyncProvider`] and
//! [`KeyringV2Io`] can be forwarded without trait upcasting. Callers that
//! need Drive-only OAuth helpers use [`CloudProvider::as_gdrive`].

use async_trait::async_trait;

use super::gdrive_provider::GDriveProvider;
use super::keyring_v2::{ConditionalMutationResult, KeyringV2Io, VersionedFile};
use super::local_provider::LocalSyncProvider;
use super::provider::{ConditionalRead, FileKind, SyncError, SyncProvider};
use super::recovery::RecoveryOwnerPermit;

/// A concrete cloud backend the rest of the app talks to through one type.
pub enum CloudProvider {
    GDrive(GDriveProvider),
    Folder(LocalSyncProvider),
}

impl CloudProvider {
    /// Stable kind string for the connected backend.
    ///
    /// `"gdrive"` for Drive; `"folder"` for both iCloud and a picked local
    /// directory (the persisted `sync_provider` setting carries `icloud` vs
    /// `local`).
    pub fn kind(&self) -> &'static str {
        match self {
            Self::GDrive(_) => "gdrive",
            Self::Folder(_) => "folder",
        }
    }

    /// Enable the recovery fence on a freshly constructed provider.
    pub fn with_recovery_fence(self, generation: u64, permit: Option<RecoveryOwnerPermit>) -> Self {
        match self {
            Self::GDrive(p) => Self::GDrive(p.with_recovery_fence(generation, permit)),
            Self::Folder(p) => Self::Folder(p.with_recovery_fence(generation, permit)),
        }
    }

    /// Re-stamp the expected generation / owner permit on a live instance.
    pub fn configure_recovery_fence_authority(
        &self,
        generation: u64,
        permit: Option<RecoveryOwnerPermit>,
    ) {
        match self {
            Self::GDrive(p) => p.configure_recovery_fence_authority(generation, permit),
            Self::Folder(p) => p.configure_recovery_fence_authority(generation, permit),
        }
    }

    /// Ensure only the vault root exists (no device / generation namespace).
    pub async fn ensure_root_folder_only(&self) -> Result<(String, bool), SyncError> {
        match self {
            Self::GDrive(p) => p.ensure_root_folder_only().await,
            Self::Folder(p) => p.ensure_root_folder_only().await,
        }
    }

    /// True when the vault root has no payload content.
    pub async fn root_is_empty(&self, root: &str) -> Result<bool, SyncError> {
        match self {
            Self::GDrive(p) => p.root_is_empty(root).await,
            Self::Folder(p) => p.root_is_empty(root).await,
        }
    }

    /// Idempotently create the per-device folder tree.
    pub async fn ensure_folder_structure(&self, device_id: &str) -> Result<String, SyncError> {
        match self {
            Self::GDrive(p) => p.ensure_folder_structure(device_id).await,
            Self::Folder(p) => p.ensure_folder_structure(device_id).await,
        }
    }

    /// Best-effort delete of one device namespace. Missing folders succeed.
    pub async fn best_effort_delete_device_namespace(
        &self,
        device_id: &str,
    ) -> Result<(), SyncError> {
        match self {
            Self::GDrive(p) => p.best_effort_delete_device_namespace(device_id).await,
            Self::Folder(p) => p.best_effort_delete_device_namespace(device_id).await,
        }
    }

    /// Wipe journal payload and keyring artifacts; keep recovery authority.
    pub async fn clear_cloud_preserving_control(&self) -> Result<(), SyncError> {
        match self {
            Self::GDrive(p) => p.clear_cloud_preserving_control().await,
            Self::Folder(p) => p.clear_cloud_preserving_control().await,
        }
    }

    /// Drive-only access for OAuth callers (quota, user info, token refresh).
    pub fn as_gdrive(&self) -> Option<&GDriveProvider> {
        match self {
            Self::GDrive(p) => Some(p),
            Self::Folder(_) => None,
        }
    }
}

#[async_trait]
impl SyncProvider for CloudProvider {
    async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
        match self {
            Self::GDrive(p) => SyncProvider::list_devices(p).await,
            Self::Folder(p) => SyncProvider::list_devices(p).await,
        }
    }

    async fn list_files(&self, device_id: &str, kind: FileKind) -> Result<Vec<String>, SyncError> {
        match self {
            Self::GDrive(p) => SyncProvider::list_files(p, device_id, kind).await,
            Self::Folder(p) => SyncProvider::list_files(p, device_id, kind).await,
        }
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        match self {
            Self::GDrive(p) => SyncProvider::read_file(p, path).await,
            Self::Folder(p) => SyncProvider::read_file(p, path).await,
        }
    }

    async fn read_file_if_changed(
        &self,
        path: &str,
        known_revision: Option<&str>,
    ) -> Result<ConditionalRead, SyncError> {
        match self {
            Self::GDrive(p) => SyncProvider::read_file_if_changed(p, path, known_revision).await,
            Self::Folder(p) => SyncProvider::read_file_if_changed(p, path, known_revision).await,
        }
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        match self {
            Self::GDrive(p) => SyncProvider::write_file(p, path, data).await,
            Self::Folder(p) => SyncProvider::write_file(p, path, data).await,
        }
    }

    async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
        match self {
            Self::GDrive(p) => SyncProvider::delete_file(p, path).await,
            Self::Folder(p) => SyncProvider::delete_file(p, path).await,
        }
    }
}

#[async_trait]
impl KeyringV2Io for CloudProvider {
    fn configure_recovery_fence(&self, local_generation: u64, permit: Option<RecoveryOwnerPermit>) {
        match self {
            Self::GDrive(p) => KeyringV2Io::configure_recovery_fence(p, local_generation, permit),
            Self::Folder(p) => KeyringV2Io::configure_recovery_fence(p, local_generation, permit),
        }
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        match self {
            Self::GDrive(p) => KeyringV2Io::read_file(p, path).await,
            Self::Folder(p) => KeyringV2Io::read_file(p, path).await,
        }
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        match self {
            Self::GDrive(p) => KeyringV2Io::write_file(p, path, data).await,
            Self::Folder(p) => KeyringV2Io::write_file(p, path, data).await,
        }
    }

    async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
        match self {
            Self::GDrive(p) => KeyringV2Io::delete_file(p, path).await,
            Self::Folder(p) => KeyringV2Io::delete_file(p, path).await,
        }
    }

    async fn list_files(&self, prefix: &str) -> Result<Vec<String>, SyncError> {
        match self {
            Self::GDrive(p) => KeyringV2Io::list_files(p, prefix).await,
            Self::Folder(p) => KeyringV2Io::list_files(p, prefix).await,
        }
    }

    async fn read_versioned_file(&self, path: &str) -> Result<VersionedFile, SyncError> {
        match self {
            Self::GDrive(p) => KeyringV2Io::read_versioned_file(p, path).await,
            Self::Folder(p) => KeyringV2Io::read_versioned_file(p, path).await,
        }
    }

    async fn compare_and_swap_file(
        &self,
        path: &str,
        expected_revision: &str,
        data: &[u8],
    ) -> Result<ConditionalMutationResult, SyncError> {
        match self {
            Self::GDrive(p) => {
                KeyringV2Io::compare_and_swap_file(p, path, expected_revision, data).await
            }
            Self::Folder(p) => {
                KeyringV2Io::compare_and_swap_file(p, path, expected_revision, data).await
            }
        }
    }

    async fn create_initial_control_if_absent(
        &self,
        data: &[u8],
    ) -> Result<ConditionalMutationResult, SyncError> {
        match self {
            Self::GDrive(p) => KeyringV2Io::create_initial_control_if_absent(p, data).await,
            Self::Folder(p) => KeyringV2Io::create_initial_control_if_absent(p, data).await,
        }
    }

    async fn create_recovery_marker_if_absent(
        &self,
        data: &[u8],
        permit: &RecoveryOwnerPermit,
    ) -> Result<ConditionalMutationResult, SyncError> {
        match self {
            Self::GDrive(p) => KeyringV2Io::create_recovery_marker_if_absent(p, data, permit).await,
            Self::Folder(p) => KeyringV2Io::create_recovery_marker_if_absent(p, data, permit).await,
        }
    }

    async fn delete_file_if_revision(
        &self,
        path: &str,
        expected_revision: &str,
    ) -> Result<ConditionalMutationResult, SyncError> {
        match self {
            Self::GDrive(p) => {
                KeyringV2Io::delete_file_if_revision(p, path, expected_revision).await
            }
            Self::Folder(p) => {
                KeyringV2Io::delete_file_if_revision(p, path, expected_revision).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CloudProvider;
    use crate::sync::keyring_v2::KeyringV2Io;
    use crate::sync::local_provider::LocalSyncProvider;
    use crate::sync::provider::SyncProvider;

    #[tokio::test]
    async fn folder_variant_round_trips_sync_and_keyring_io() {
        let dir = tempfile::TempDir::new().unwrap();
        let provider = CloudProvider::Folder(LocalSyncProvider::new(dir.path()));

        assert_eq!(provider.kind(), "folder");

        SyncProvider::write_file(&provider, "dev-a/entries/eid1.bin", b"hello")
            .await
            .unwrap();
        let got = SyncProvider::read_file(&provider, "dev-a/entries/eid1.bin")
            .await
            .unwrap();
        assert_eq!(got, b"hello");

        KeyringV2Io::write_file(&provider, ".meta/keyring/_meta.json", b"{\"ok\":true}")
            .await
            .unwrap();
        let meta = KeyringV2Io::read_file(&provider, ".meta/keyring/_meta.json")
            .await
            .unwrap();
        assert_eq!(meta, b"{\"ok\":true}");
    }
}
