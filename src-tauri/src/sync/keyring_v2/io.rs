//! Cloud I/O helpers for V2 keyring files.
//!
//! Defines the [`KeyringV2Io`] trait (read / write / delete / list) and
//! async helpers that serialize/deserialize the three V2 keyring structs against
//! any provider implementing that trait.
//!
//! # Path layout
//!
//! ```text
//! .meta/keyring/_meta.json          ← KeyringMetaV2
//! .meta/keyring/_recovery.json      ← RecoverySlotV2
//! .meta/keyring/devices/<id>.json   ← DeviceSlotV2 (one per device)
//! ```
//!
//! # Provider note
//!
//! Production impls: [`crate::sync::gdrive_provider::GDriveProvider`] and
//! [`crate::sync::local_provider::LocalSyncProvider`] (`KeyringV2Io` lives in
//! `sync/local_keyring_v2.rs` so concrete `SyncProvider` tests stay
//! unambiguous). Tests also use the in-memory fake below.

use async_trait::async_trait;

use crate::sync::provider::SyncError;

use super::types::{ContentListV2, DeviceSlotV2, KeyringMetaV2, RecoveryMarker, RecoverySlotV2};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionedFile {
    pub bytes: Vec<u8>,
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionalMutationResult {
    Applied,
    Conflict,
    NotFound,
}

// ─── Cloud-path constants ─────────────────────────────────────────────────────

pub const KEYRING_DIR: &str = ".meta/keyring";
pub const META_PATH: &str = ".meta/keyring/_meta.json";
pub const RECOVERY_PATH: &str = ".meta/keyring/_recovery.json";
pub const DEVICES_DIR: &str = ".meta/keyring/devices";
/// Cloud path for the content-key epoch list.
pub const CONTENT_PATH: &str = ".meta/keyring/_content.json";
pub const RECOVERY_MARKER_PATH: &str = ".meta/_recovery_marker.json";

/// Returns the cloud path for a per-device slot JSON file.
pub fn device_slot_path(device_id: &str) -> String {
    format!("{DEVICES_DIR}/{device_id}.json")
}

/// Paths that encode the live recovery-generation / lease authority.
/// Providers must not overwrite or delete these via the generic write/delete
/// path — only the dedicated CAS / create-if-absent helpers may mutate them.
pub(crate) fn is_recovery_authority_path(path: &str) -> bool {
    path == crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH || path == RECOVERY_MARKER_PATH
}

/// Parent/child names that must survive a payload wipe. Walkers pass the
/// listing parent (`"root"` or `".meta"`) plus each child name.
pub(crate) fn preserve_during_cloud_cleanup(parent_name: &str, child_name: &str) -> bool {
    (parent_name == "root" && child_name == ".meta")
        || (parent_name == ".meta" && child_name == "control.json")
        // Live recovery fence marker must survive payload wipe; release is
        // explicit and only runs after post-upload verification.
        || (parent_name == ".meta" && child_name == "_recovery_marker.json")
}

/// Fail closed if `control.json` changed while a wipe was in flight.
pub(crate) fn verify_cleanup_preserved_control(
    before: &crate::sync::sync_control::SyncControlV1,
    after: &crate::sync::sync_control::SyncControlV1,
) -> Result<(), SyncError> {
    if before == after {
        Ok(())
    } else {
        Err(SyncError::Auth(
            "control.json changed during cloud cleanup".to_string(),
        ))
    }
}

// ─── KeyringV2Io trait ───────────────────────────────────────────────────────

/// Minimal I/O abstraction for keyring V2 cloud files.
///
/// Core methods:
/// - `read_file` / `write_file` — upsert a JSON blob at a path.
/// - `delete_file` — remove a device slot (revocation, idempotent).
/// - `list_files(prefix)` — enumerate all `.json` files under a directory
///   prefix (used by `list_device_slots`).
///
/// Conditional-mutation API (recovery authority / lease CAS):
/// `read_versioned_file`, `compare_and_swap_file`,
/// `create_initial_control_if_absent`, `create_recovery_marker_if_absent`,
/// `delete_file_if_revision`.
///
/// Production impls: `GDriveProvider` and `LocalSyncProvider`. Tests use
/// the [`InMemoryKeyringProvider`] below.
#[async_trait]
pub trait KeyringV2Io: Send + Sync {
    /// Configure the mutation fence for providers that enforce recovery
    /// generations. Non-Google/test providers may keep the default no-op.
    fn configure_recovery_fence(
        &self,
        _local_generation: u64,
        _permit: Option<crate::sync::recovery::RecoveryOwnerPermit>,
    ) {
    }

    /// Read the raw bytes at `path`. Returns `Err(SyncError::NotFound)` if absent.
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError>;

    /// Create or overwrite the file at `path`.
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError>;

    /// Delete the file at `path`. Returning `Ok(())` on a missing file is
    /// required — deletion is treated as idempotent throughout the keyring code.
    async fn delete_file(&self, path: &str) -> Result<(), SyncError>;

    /// Return all file paths that start with `prefix`.
    ///
    /// Callers expect relative paths (matching what was passed to
    /// `write_file`). If the prefix directory is absent `Ok(vec![])` is
    /// returned (same idempotency guarantee as `delete_file`).
    async fn list_files(&self, prefix: &str) -> Result<Vec<String>, SyncError>;

    /// Read bytes together with the provider's opaque revision/ETag token.
    /// Recovery lease acquisition requires a real token; providers that do
    /// not support conditional mutation must fail closed.
    async fn read_versioned_file(&self, _path: &str) -> Result<VersionedFile, SyncError> {
        Err(SyncError::Io(
            "provider does not support versioned recovery control reads".to_string(),
        ))
    }

    async fn compare_and_swap_file(
        &self,
        _path: &str,
        _expected_revision: &str,
        _data: &[u8],
    ) -> Result<ConditionalMutationResult, SyncError> {
        Err(SyncError::Io(
            "provider does not support conditional recovery control updates".to_string(),
        ))
    }

    /// Bootstrap the fixed `control.json` authority only when absent.
    async fn create_initial_control_if_absent(
        &self,
        _data: &[u8],
    ) -> Result<ConditionalMutationResult, SyncError> {
        Err(SyncError::Io(
            "provider does not support conditional recovery authority creation".to_string(),
        ))
    }

    /// Create the fixed recovery marker only for the exact active control
    /// lease owner.
    async fn create_recovery_marker_if_absent(
        &self,
        _data: &[u8],
        _permit: &crate::sync::recovery::RecoveryOwnerPermit,
    ) -> Result<ConditionalMutationResult, SyncError> {
        Err(SyncError::Io(
            "provider does not support exact-owner recovery marker creation".to_string(),
        ))
    }

    async fn delete_file_if_revision(
        &self,
        _path: &str,
        _expected_revision: &str,
    ) -> Result<ConditionalMutationResult, SyncError> {
        Err(SyncError::Io(
            "provider does not support conditional recovery marker deletion".to_string(),
        ))
    }
}

// ─── I/O helpers ─────────────────────────────────────────────────────────────

/// Download and parse `_meta.json`. Returns `None` when the file does not exist.
/// Rejects malformed or semantically invalid data from the cloud trust boundary.
pub async fn read_meta<P: KeyringV2Io + ?Sized>(
    provider: &P,
) -> Result<Option<KeyringMetaV2>, SyncError> {
    let Some(meta) = read_json::<KeyringMetaV2, _>(provider, META_PATH).await? else {
        return Ok(None);
    };
    meta.validate()
        .map_err(|e| SyncError::Serialization(format!("keyring_v2: _meta.json invalid: {e}")))?;
    Ok(Some(meta))
}

/// Serialize and upload `_meta.json`.
pub async fn write_meta<P: KeyringV2Io + ?Sized>(
    provider: &P,
    meta: &KeyringMetaV2,
) -> Result<(), SyncError> {
    write_json(provider, META_PATH, meta).await
}

pub async fn read_recovery_marker<P: KeyringV2Io + ?Sized>(
    provider: &P,
) -> Result<Option<RecoveryMarker>, SyncError> {
    let Some(marker) = read_json::<RecoveryMarker, _>(provider, RECOVERY_MARKER_PATH).await? else {
        return Ok(None);
    };
    marker.validate().map_err(|e| {
        SyncError::Serialization(format!("keyring_v2: recovery marker invalid: {e}"))
    })?;
    Ok(Some(marker))
}

/// Download and parse `_recovery.json`. Returns `None` when absent.
/// Rejects malformed or semantically invalid data from the cloud trust boundary.
pub async fn read_recovery<P: KeyringV2Io + ?Sized>(
    provider: &P,
) -> Result<Option<RecoverySlotV2>, SyncError> {
    let Some(slot) = read_json::<RecoverySlotV2, _>(provider, RECOVERY_PATH).await? else {
        return Ok(None);
    };
    slot.validate().map_err(|e| {
        SyncError::Serialization(format!("keyring_v2: _recovery.json invalid: {e}"))
    })?;
    Ok(Some(slot))
}

/// Serialize and upload `_recovery.json`.
pub async fn write_recovery<P: KeyringV2Io + ?Sized>(
    provider: &P,
    slot: &RecoverySlotV2,
) -> Result<(), SyncError> {
    write_json(provider, RECOVERY_PATH, slot).await
}

/// Download and parse `_content.json`. Returns `None` when the file does not exist.
/// Rejects malformed or semantically invalid data from the cloud trust boundary.
pub async fn read_content<P: KeyringV2Io + ?Sized>(
    provider: &P,
) -> Result<Option<ContentListV2>, SyncError> {
    let Some(list) = read_json::<ContentListV2, _>(provider, CONTENT_PATH).await? else {
        return Ok(None);
    };
    list.validate()
        .map_err(|e| SyncError::Serialization(format!("keyring_v2: _content.json invalid: {e}")))?;
    Ok(Some(list))
}

/// Serialize and upload `_content.json`.
///
/// Validates the list before any cloud write so a malformed payload cannot
/// poison `_content.json` after a wipe/rebuild.
pub async fn write_content<P: KeyringV2Io + ?Sized>(
    provider: &P,
    list: &ContentListV2,
) -> Result<(), SyncError> {
    list.validate().map_err(|e| {
        SyncError::Serialization(format!(
            "keyring_v2: _content.json invalid before write: {e}"
        ))
    })?;
    write_json(provider, CONTENT_PATH, list).await
}

/// Download and parse a per-device slot. Returns `None` when absent.
///
/// Performs two trust-boundary checks:
/// 1. Semantic validation via `DeviceSlotV2::validate()`.
/// 2. Cross-check that `slot.device_id` matches the `device_id` path parameter —
///    rejects a tampered file where the payload claims a different identity.
pub async fn read_device_slot<P: KeyringV2Io>(
    provider: &P,
    device_id: &str,
) -> Result<Option<DeviceSlotV2>, SyncError> {
    let path = device_slot_path(device_id);
    let Some(slot) = read_json::<DeviceSlotV2, _>(provider, &path).await? else {
        return Ok(None);
    };
    slot.validate()
        .map_err(|e| SyncError::Serialization(format!("keyring_v2: {path} invalid: {e}")))?;
    if slot.device_id != device_id {
        return Err(SyncError::Serialization(format!(
            "keyring_v2: {path} device_id mismatch: payload claims '{}', path is '{device_id}'",
            slot.device_id
        )));
    }
    Ok(Some(slot))
}

/// Serialize and upload a per-device slot.
pub async fn write_device_slot<P: KeyringV2Io + ?Sized>(
    provider: &P,
    slot: &DeviceSlotV2,
) -> Result<(), SyncError> {
    write_json(provider, &device_slot_path(&slot.device_id), slot).await
}

/// Delete a per-device slot. Idempotent — ok if already absent.
pub async fn delete_device_slot<P: KeyringV2Io>(
    provider: &P,
    device_id: &str,
) -> Result<(), SyncError> {
    provider.delete_file(&device_slot_path(device_id)).await
}

/// List and parse every device slot under `DEVICES_DIR`.
///
/// Files that fail to parse, fail semantic validation, or whose payload
/// `device_id` does not match the filename stem are skipped with a warning
/// rather than aborting, so a single corrupt slot does not prevent the others
/// from loading. Returns an empty `Vec` when the directory is absent.
pub async fn list_device_slots<P: KeyringV2Io>(
    provider: &P,
) -> Result<Vec<DeviceSlotV2>, SyncError> {
    let paths = provider.list_files(DEVICES_DIR).await?;
    let mut slots = Vec::with_capacity(paths.len());
    for path in paths {
        if !path.ends_with(".json") {
            continue;
        }
        // Extract <id> from `.meta/keyring/devices/<id>.json`.
        // Strip the directory prefix (last path component) and the `.json` suffix.
        let file_id = match path
            .rsplit('/')
            .next()
            .and_then(|name| name.strip_suffix(".json"))
        {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => {
                log::warn!("keyring_v2: skipping device slot with unexpected path: {path}");
                continue;
            }
        };
        match provider.read_file(&path).await {
            Ok(bytes) => match serde_json::from_slice::<DeviceSlotV2>(&bytes) {
                Ok(slot) => {
                    if let Err(e) = slot.validate() {
                        log::warn!("keyring_v2: skipping invalid device slot {path}: {e}");
                        continue;
                    }
                    if slot.device_id != file_id {
                        log::warn!(
                            "keyring_v2: skipping device slot {path} — payload device_id {} \
                             does not match filename",
                            slot.device_id
                        );
                        continue;
                    }
                    slots.push(slot);
                }
                Err(e) => {
                    log::warn!("keyring_v2: skipping unparseable device slot {path}: {e}");
                }
            },
            Err(SyncError::NotFound(_)) => {
                // Race: file listed but deleted before we could read it.
            }
            Err(e) => return Err(e),
        }
    }
    Ok(slots)
}

// ─── Private serialization helpers ───────────────────────────────────────────

async fn read_json<T, P>(provider: &P, path: &str) -> Result<Option<T>, SyncError>
where
    T: for<'de> serde::Deserialize<'de>,
    P: KeyringV2Io + ?Sized,
{
    match provider.read_file(path).await {
        Err(SyncError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
        Ok(bytes) => {
            let value = serde_json::from_slice(&bytes).map_err(|e| {
                SyncError::Serialization(format!("keyring_v2: {path} parse error: {e}"))
            })?;
            Ok(Some(value))
        }
    }
}

async fn write_json<T, P>(provider: &P, path: &str, value: &T) -> Result<(), SyncError>
where
    T: serde::Serialize,
    P: KeyringV2Io + ?Sized,
{
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| {
        SyncError::Serialization(format!("keyring_v2: serialize {path} error: {e}"))
    })?;
    provider.write_file(path, &bytes).await
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod test_support {
    //! In-memory [`KeyringV2Io`] implementation for unit tests.
    //!
    //! This lives in `test_support` (not `#[cfg(test)]` inline) so it can be
    //! re-used by integration tests in sibling modules.

    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// Thread-safe in-memory store that tracks files by path.
    #[derive(Clone)]
    pub struct InMemoryKeyringProvider {
        files: Arc<Mutex<HashMap<String, (Vec<u8>, u64)>>>,
        writes: Arc<AtomicUsize>,
        next_revision: Arc<AtomicU64>,
        fail_conditional_deletes: Arc<AtomicUsize>,
    }

    impl InMemoryKeyringProvider {
        pub fn new() -> Self {
            Self {
                files: Arc::new(Mutex::new(HashMap::new())),
                writes: Arc::new(AtomicUsize::new(0)),
                next_revision: Arc::new(AtomicU64::new(1)),
                fail_conditional_deletes: Arc::new(AtomicUsize::new(0)),
            }
        }

        pub fn write_count(&self) -> usize {
            self.writes.load(Ordering::Acquire)
        }

        pub fn fail_next_conditional_delete(&self) {
            self.fail_conditional_deletes.store(1, Ordering::Release);
        }
    }

    #[async_trait]
    impl KeyringV2Io for InMemoryKeyringProvider {
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .map(|(bytes, _)| bytes.clone())
                .ok_or_else(|| SyncError::NotFound(path.to_string()))
        }

        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.writes.fetch_add(1, Ordering::AcqRel);
            let revision = self.next_revision.fetch_add(1, Ordering::AcqRel);
            self.files
                .lock()
                .unwrap()
                .insert(path.to_string(), (data.to_vec(), revision));
            Ok(())
        }

        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.files.lock().unwrap().remove(path);
            Ok(())
        }

        async fn list_files(&self, prefix: &str) -> Result<Vec<String>, SyncError> {
            let files = self.files.lock().unwrap();
            let mut paths: Vec<String> = files
                .keys()
                .filter(|k| k.starts_with(prefix))
                .cloned()
                .collect();
            paths.sort();
            Ok(paths)
        }

        async fn read_versioned_file(&self, path: &str) -> Result<VersionedFile, SyncError> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .map(|(bytes, revision)| VersionedFile {
                    bytes: bytes.clone(),
                    revision: revision.to_string(),
                })
                .ok_or_else(|| SyncError::NotFound(path.to_string()))
        }

        async fn compare_and_swap_file(
            &self,
            path: &str,
            expected_revision: &str,
            data: &[u8],
        ) -> Result<ConditionalMutationResult, SyncError> {
            let mut files = self.files.lock().unwrap();
            let Some((_, current_revision)) = files.get(path) else {
                return Ok(ConditionalMutationResult::NotFound);
            };
            if current_revision.to_string() != expected_revision {
                return Ok(ConditionalMutationResult::Conflict);
            }
            let revision = self.next_revision.fetch_add(1, Ordering::AcqRel);
            files.insert(path.to_string(), (data.to_vec(), revision));
            self.writes.fetch_add(1, Ordering::AcqRel);
            Ok(ConditionalMutationResult::Applied)
        }

        async fn create_initial_control_if_absent(
            &self,
            data: &[u8],
        ) -> Result<ConditionalMutationResult, SyncError> {
            let path = crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH;
            let mut files = self.files.lock().unwrap();
            if files.contains_key(path) {
                return Ok(ConditionalMutationResult::Conflict);
            }
            let revision = self.next_revision.fetch_add(1, Ordering::AcqRel);
            files.insert(path.to_string(), (data.to_vec(), revision));
            self.writes.fetch_add(1, Ordering::AcqRel);
            Ok(ConditionalMutationResult::Applied)
        }

        async fn create_recovery_marker_if_absent(
            &self,
            data: &[u8],
            permit: &crate::sync::recovery::RecoveryOwnerPermit,
        ) -> Result<ConditionalMutationResult, SyncError> {
            let marker: RecoveryMarker = serde_json::from_slice(data)
                .map_err(|error| SyncError::Serialization(error.to_string()))?;
            let control_bytes = self
                .read_file(crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH)
                .await?;
            let control: crate::sync::sync_control::SyncControlV1 =
                serde_json::from_slice(&control_bytes)
                    .map_err(|error| SyncError::Serialization(error.to_string()))?;
            let exact = control.recovery_lease.as_ref() == Some(&marker)
                && marker.job_id == permit.job_id
                && marker.owner_device_id == permit.owner_device_id
                && marker.operation == permit.operation
                && marker.recovery_generation == permit.recovery_generation
                && marker.nonce == permit.nonce;
            if !exact {
                return Err(SyncError::Auth(
                    "recovery marker create requires exact active control owner".to_string(),
                ));
            }
            let path = RECOVERY_MARKER_PATH;
            let mut files = self.files.lock().unwrap();
            if files.contains_key(path) {
                return Ok(ConditionalMutationResult::Conflict);
            }
            let revision = self.next_revision.fetch_add(1, Ordering::AcqRel);
            files.insert(path.to_string(), (data.to_vec(), revision));
            self.writes.fetch_add(1, Ordering::AcqRel);
            Ok(ConditionalMutationResult::Applied)
        }

        async fn delete_file_if_revision(
            &self,
            path: &str,
            expected_revision: &str,
        ) -> Result<ConditionalMutationResult, SyncError> {
            if self
                .fail_conditional_deletes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Err(SyncError::Network(
                    "injected conditional delete failure".to_string(),
                ));
            }
            let mut files = self.files.lock().unwrap();
            let Some((_, current_revision)) = files.get(path) else {
                return Ok(ConditionalMutationResult::NotFound);
            };
            if current_revision.to_string() != expected_revision {
                return Ok(ConditionalMutationResult::Conflict);
            }
            files.remove(path);
            Ok(ConditionalMutationResult::Applied)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::InMemoryKeyringProvider;
    use super::*;
    use crate::sync::keyring_v2::types::KEYRING_V2_VERSION;

    fn make_meta() -> KeyringMetaV2 {
        KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: 1,
            master_fingerprint: "a".repeat(64),
            content_epoch: 0,
            recovery_generation: 0,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_001,
        }
    }

    fn make_marker() -> RecoveryMarker {
        RecoveryMarker {
            version: super::super::types::RECOVERY_MARKER_VERSION,
            job_id: 7,
            owner_device_id: DEV_A.to_string(),
            operation: "local_to_cloud".to_string(),
            recovery_generation: 3,
            nonce: "0123456789abcdef".to_string(),
            created_at: 1_700_000_000,
            updated_at: 1_700_000_001,
        }
    }

    fn make_recovery() -> RecoverySlotV2 {
        RecoverySlotV2 {
            version: KEYRING_V2_VERSION,
            wrapped_master: "b".repeat(120),
            created_at: 1_700_000_000,
        }
    }

    fn make_device(id: &str) -> DeviceSlotV2 {
        DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: id.to_string(),
            name: "Test Device".to_string(),
            created_at: 1_700_000_000,
            last_seen_at: 1_700_000_001,
        }
    }

    // UUID-format IDs used by tests that go through write+read (and therefore validate()).
    const DEV_A: &str = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
    const DEV_B: &str = "cccccccc-4444-5555-6666-dddddddddddd";
    const DEV_KEEP: &str = "11111111-aaaa-bbbb-cccc-222222222222";
    const DEV_GONE: &str = "33333333-dddd-eeee-ffff-444444444444";
    const DEV_RW: &str = "55555555-6666-7777-8888-999999999999";

    #[tokio::test]
    async fn meta_absent_returns_none() {
        let p = InMemoryKeyringProvider::new();
        let result = read_meta(&p).await.unwrap();
        assert!(result.is_none(), "absent _meta.json should yield None");
    }

    #[tokio::test]
    async fn meta_write_then_read_roundtrip() {
        let p = InMemoryKeyringProvider::new();
        let meta = make_meta();
        write_meta(&p, &meta).await.unwrap();
        let got = read_meta(&p)
            .await
            .unwrap()
            .expect("must be Some after write");
        assert_eq!(got.epoch, meta.epoch);
        assert_eq!(got.master_fingerprint, meta.master_fingerprint);
    }

    #[test]
    fn recovery_marker_validation_rejects_invalid_contracts() {
        let valid = make_marker();
        let mut invalid = Vec::new();
        invalid.push(RecoveryMarker {
            job_id: 0,
            ..valid.clone()
        });
        invalid.push(RecoveryMarker {
            owner_device_id: "../bad".to_string(),
            ..valid.clone()
        });
        invalid.push(RecoveryMarker {
            operation: "invalid".to_string(),
            ..valid.clone()
        });
        invalid.push(RecoveryMarker {
            recovery_generation: 0,
            ..valid.clone()
        });
        invalid.push(RecoveryMarker {
            updated_at: valid.created_at - 1,
            ..valid
        });
        assert!(invalid.iter().all(|marker| marker.validate().is_err()));
    }

    #[tokio::test]
    async fn recovery_absent_returns_none() {
        let p = InMemoryKeyringProvider::new();
        let result = read_recovery(&p).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn recovery_write_then_read_roundtrip() {
        let p = InMemoryKeyringProvider::new();
        let slot = make_recovery();
        write_recovery(&p, &slot).await.unwrap();
        let got = read_recovery(&p)
            .await
            .unwrap()
            .expect("must be Some after write");
        assert_eq!(got.wrapped_master, slot.wrapped_master);
    }

    #[tokio::test]
    async fn device_slot_absent_returns_none() {
        let p = InMemoryKeyringProvider::new();
        let result = read_device_slot(&p, "some-device-id").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn device_slot_write_then_read_roundtrip() {
        let p = InMemoryKeyringProvider::new();
        let slot = make_device(DEV_RW);
        write_device_slot(&p, &slot).await.unwrap();
        let got = read_device_slot(&p, DEV_RW)
            .await
            .unwrap()
            .expect("must be Some after write");
        assert_eq!(got.device_id, slot.device_id);
        assert_eq!(got.name, slot.name);
    }

    #[tokio::test]
    async fn delete_device_slot_removes_slot() {
        let p = InMemoryKeyringProvider::new();
        let slot = make_device(DEV_RW);
        write_device_slot(&p, &slot).await.unwrap();
        delete_device_slot(&p, DEV_RW).await.unwrap();
        let result = read_device_slot(&p, DEV_RW).await.unwrap();
        assert!(result.is_none(), "slot should be gone after delete");
    }

    #[tokio::test]
    async fn delete_device_slot_is_idempotent() {
        let p = InMemoryKeyringProvider::new();
        // Delete on an absent slot must not error (path-only operation, no validation).
        delete_device_slot(&p, "never-existed").await.unwrap();
        // Write then delete twice — second delete must also be ok.
        write_device_slot(&p, &make_device(DEV_RW)).await.unwrap();
        delete_device_slot(&p, DEV_RW).await.unwrap();
        delete_device_slot(&p, DEV_RW).await.unwrap();
    }

    #[tokio::test]
    async fn list_device_slots_empty_when_dir_absent() {
        let p = InMemoryKeyringProvider::new();
        let slots = list_device_slots(&p).await.unwrap();
        assert!(
            slots.is_empty(),
            "should return empty vec when no slots written"
        );
    }

    #[tokio::test]
    async fn list_device_slots_returns_all_written() {
        let p = InMemoryKeyringProvider::new();
        let dev_a = make_device(DEV_A);
        let dev_b = make_device(DEV_B);
        write_device_slot(&p, &dev_a).await.unwrap();
        write_device_slot(&p, &dev_b).await.unwrap();
        let mut slots = list_device_slots(&p).await.unwrap();
        slots.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].device_id, DEV_A);
        assert_eq!(slots[1].device_id, DEV_B);
    }

    #[tokio::test]
    async fn list_device_slots_excludes_deleted() {
        let p = InMemoryKeyringProvider::new();
        write_device_slot(&p, &make_device(DEV_KEEP)).await.unwrap();
        write_device_slot(&p, &make_device(DEV_GONE)).await.unwrap();
        delete_device_slot(&p, DEV_GONE).await.unwrap();
        let slots = list_device_slots(&p).await.unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].device_id, DEV_KEEP);
    }

    #[test]
    fn device_slot_path_format() {
        let path = device_slot_path("my-device-uuid");
        assert_eq!(path, ".meta/keyring/devices/my-device-uuid.json");
    }

    // ── Validation wiring tests ───────────────────────────────────────────────

    /// Write a semantically invalid meta (bad version) and verify read_meta rejects it.
    #[tokio::test]
    async fn read_meta_rejects_invalid_version() {
        let p = InMemoryKeyringProvider::new();
        let bad_json = r#"{
            "version": 99,
            "epoch": 1,
            "master_fingerprint": "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
            "content_epoch": 0,
            "created_at": 1700000000,
            "updated_at": 1700000001
        }"#;
        p.write_file(META_PATH, bad_json.as_bytes()).await.unwrap();
        let result = read_meta(&p).await;
        assert!(
            result.is_err(),
            "read_meta must reject meta with wrong version"
        );
    }

    /// Write a semantically invalid recovery slot (negative created_at) and verify rejection.
    #[tokio::test]
    async fn read_recovery_rejects_negative_created_at() {
        let p = InMemoryKeyringProvider::new();
        let bad_json = r#"{
            "version": 2,
            "wrapped_master": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
            "created_at": -1
        }"#;
        p.write_file(RECOVERY_PATH, bad_json.as_bytes())
            .await
            .unwrap();
        let result = read_recovery(&p).await;
        assert!(
            result.is_err(),
            "read_recovery must reject slot with negative created_at"
        );
    }

    /// Write a device slot where payload device_id != path device_id and verify rejection.
    #[tokio::test]
    async fn read_device_slot_rejects_mismatched_device_id() {
        let p = InMemoryKeyringProvider::new();
        // Slot claims to be "11111111-2222-3333-4444-555555555555" but we read it
        // under path for "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".
        let impostor_json = r#"{
            "version": 2,
            "device_id": "11111111-2222-3333-4444-555555555555",
            "name": "Impostor",
            "wrapped_master": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
            "kek_salt": "aabbccddeeff00112233445566778899",
            "created_at": 1700000000,
            "last_seen_at": 1700000001
        }"#;
        let target_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        p.write_file(&device_slot_path(target_id), impostor_json.as_bytes())
            .await
            .unwrap();
        let result = read_device_slot(&p, target_id).await;
        assert!(
            result.is_err(),
            "read_device_slot must reject when payload device_id != path device_id"
        );
    }

    /// list_device_slots must skip slots that fail validation and return only valid ones.
    #[tokio::test]
    async fn list_device_slots_skips_invalid_and_returns_valid() {
        let p = InMemoryKeyringProvider::new();
        // Write one valid slot.
        let valid = make_device("11111111-2222-3333-4444-555555555555");
        write_device_slot(&p, &valid).await.unwrap();

        // Write one slot with a wrong version (invalid).
        let invalid_json = r#"{
            "version": 99,
            "device_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "name": "Bad Device",
            "wrapped_master": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
            "kek_salt": "aabbccddeeff00112233445566778899",
            "created_at": 1700000000,
            "last_seen_at": 1700000001
        }"#;
        p.write_file(
            ".meta/keyring/devices/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json",
            invalid_json.as_bytes(),
        )
        .await
        .unwrap();

        let slots = list_device_slots(&p).await.unwrap();
        // Only the valid slot should be returned; the invalid one is skipped silently.
        assert_eq!(slots.len(), 1, "invalid slot must be skipped");
        assert_eq!(slots[0].device_id, "11111111-2222-3333-4444-555555555555");
    }

    /// A file whose payload `device_id` differs from its filename stem must be
    /// skipped by `list_device_slots`. This guards against phantom-device attacks
    /// where `devices/A.json` carries `{"device_id": "B", ...}`.
    #[tokio::test]
    async fn list_device_slots_skips_filename_payload_mismatch() {
        let p = InMemoryKeyringProvider::new();

        // Slot 1: filename matches payload — must be returned.
        let valid = make_device(DEV_A);
        write_device_slot(&p, &valid).await.unwrap();

        // Slot 2: filename is DEV_B but payload claims DEV_A — must be skipped.
        // We build the JSON manually so device_id in the payload is DEV_A while
        // the file lives under DEV_B's path.
        let mismatch_slot = make_device(DEV_A); // payload device_id = DEV_A
        let mismatch_bytes = serde_json::to_vec_pretty(&mismatch_slot).unwrap();
        // Write to DEV_B's path — filename says DEV_B, payload says DEV_A.
        p.write_file(&format!("{DEVICES_DIR}/{DEV_B}.json"), &mismatch_bytes)
            .await
            .unwrap();

        let slots = list_device_slots(&p).await.unwrap();
        assert_eq!(
            slots.len(),
            1,
            "slot with filename/payload mismatch must be skipped; got {:?}",
            slots.iter().map(|s| &s.device_id).collect::<Vec<_>>()
        );
        assert_eq!(
            slots[0].device_id, DEV_A,
            "only the filename-matching slot must be returned"
        );
    }

    // ── Recovery-authority path predicates (shared by all providers) ─────────

    #[test]
    fn recovery_authority_path_is_only_control_and_marker() {
        assert!(is_recovery_authority_path(
            crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH
        ));
        assert!(is_recovery_authority_path(RECOVERY_MARKER_PATH));
        for other in [
            META_PATH,
            RECOVERY_PATH,
            CONTENT_PATH,
            ".meta/keyring.json",
            "dev-a/entries/e1.bin",
            "",
        ] {
            assert!(
                !is_recovery_authority_path(other),
                "{other} is not a recovery-authority path"
            );
        }
    }

    #[test]
    fn cloud_cleanup_preserves_only_root_meta_and_control_authority() {
        assert!(preserve_during_cloud_cleanup("root", ".meta"));
        assert!(preserve_during_cloud_cleanup(".meta", "control.json"));
        assert!(preserve_during_cloud_cleanup(
            ".meta",
            "_recovery_marker.json"
        ));
        for payload in ["generations", "dev-a", "mode.json", "keyring"] {
            assert!(!preserve_during_cloud_cleanup(".meta", payload));
            assert!(!preserve_during_cloud_cleanup("root", payload));
        }
    }

    #[test]
    fn cloud_cleanup_accepts_identical_control_and_rejects_any_change() {
        let before = crate::sync::sync_control::SyncControlV1 {
            version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
            recovery_generation: 1,
            recovery_lease: None,
            updated_at: 10,
        };
        assert!(verify_cleanup_preserved_control(&before, &before).is_ok());

        let bumped = crate::sync::sync_control::SyncControlV1 {
            recovery_generation: 2,
            updated_at: 11,
            ..before.clone()
        };
        let err = verify_cleanup_preserved_control(&before, &bumped).unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "control change during cleanup must fail closed as Auth, got {err:?}"
        );
    }
}
