//! `KeyringV2Io` for [`LocalSyncProvider`].
//!
//! Lives in a sibling module so existing `local_provider` tests that call
//! `read_file` / `write_file` / `delete_file` / `list_files` on a concrete
//! `LocalSyncProvider` stay unambiguous (`SyncProvider` only). Tests here
//! use UFCS (`KeyringV2Io::read_file(&p, …)`).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use async_trait::async_trait;
use tokio::fs;
use tokio::sync::Mutex;

use crate::sync::keyring_v2::io::is_recovery_authority_path;
use crate::sync::keyring_v2::{
    ConditionalMutationResult, KeyringV2Io, RecoveryMarker, VersionedFile, DEVICES_DIR,
    RECOVERY_MARKER_PATH,
};
use crate::sync::local_provider::{
    is_safe_component, local_revision_from_metadata, map_io, LocalSyncProvider,
};
use crate::sync::provider::SyncError;
use crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH;

const EXACT_ALLOW_LIST: &[&str] = &[
    ".meta/keyring.json",
    ".meta/control.json",
    ".meta/_recovery_marker.json",
    ".meta/keyring/_meta.json",
    ".meta/keyring/_recovery.json",
    ".meta/keyring/_content.json",
];

const DEVICE_SLOT_PREFIX: &str = ".meta/keyring/devices/";
const DEVICE_SLOT_SUFFIX: &str = ".json";

/// Process-global CAS lock. `LocalSyncProvider` is rebuilt per sync, so a
/// per-instance mutex would serialise nothing across scheduler vs command.
static CAS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn cas_lock() -> &'static Mutex<()> {
    CAS_LOCK.get_or_init(|| Mutex::new(()))
}

/// Shared-path whitelist mirroring `parse_shared_path` (gdrive_provider.rs).
/// Shared paths always resolve under `root`, never `device_root()`.
pub(crate) fn validate_shared_path(path: &str) -> Result<(), SyncError> {
    if path.split('/').any(|c| c == ".." || c.is_empty()) {
        return Err(SyncError::Io("invalid shared path".to_string()));
    }
    if EXACT_ALLOW_LIST.contains(&path) {
        return Ok(());
    }
    if path.starts_with(DEVICE_SLOT_PREFIX) && path.ends_with(DEVICE_SLOT_SUFFIX) {
        let rest = &path[DEVICE_SLOT_PREFIX.len()..];
        let stem = &rest[..rest.len() - DEVICE_SLOT_SUFFIX.len()];
        if is_safe_component(stem) && !stem.contains('/') {
            return Ok(());
        }
    }
    Err(SyncError::Io("invalid shared path".to_string()))
}

fn join_under_root(root: &Path, relative: &str) -> PathBuf {
    let mut abs = root.to_path_buf();
    for seg in relative.split('/') {
        abs.push(seg);
    }
    abs
}

fn resolve_shared(root: &Path, path: &str) -> Result<PathBuf, SyncError> {
    validate_shared_path(path)?;
    Ok(join_under_root(root, path))
}

fn temp_sibling(dest: &Path) -> Result<PathBuf, SyncError> {
    let parent = dest
        .parent()
        .ok_or_else(|| SyncError::Io("invalid shared path".to_string()))?;
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| SyncError::Io("invalid shared path".to_string()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(parent.join(format!(".{name}.tmp-{nanos}")))
}

async fn write_atomically(dest: &Path, data: &[u8]) -> Result<(), SyncError> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).await.map_err(map_io)?;
    }
    let tmp = temp_sibling(dest)?;
    fs::write(&tmp, data).await.map_err(map_io)?;
    if let Err(e) = fs::rename(&tmp, dest).await {
        let _ = fs::remove_file(&tmp).await;
        return Err(map_io(e));
    }
    Ok(())
}

fn current_revision(path: &Path) -> Result<Option<String>, SyncError> {
    match std::fs::metadata(path) {
        Ok(meta) => local_revision_from_metadata(&meta)
            .ok_or_else(|| SyncError::Io("cannot derive local revision".to_string()))
            .map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(map_io(e)),
    }
}

async fn create_exclusive(
    dest: &Path,
    data: &[u8],
) -> Result<ConditionalMutationResult, SyncError> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).await.map_err(map_io)?;
    }
    let tmp = temp_sibling(dest)?;
    if let Err(e) = fs::write(&tmp, data).await {
        let _ = fs::remove_file(&tmp).await;
        return Err(map_io(e));
    }
    let result = match std::fs::hard_link(&tmp, dest) {
        Ok(()) => Ok(ConditionalMutationResult::Applied),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(ConditionalMutationResult::Conflict)
        }
        Err(e) => Err(map_io(e)),
    };
    let _ = fs::remove_file(&tmp).await;
    result
}

#[async_trait]
impl KeyringV2Io for LocalSyncProvider {
    fn configure_recovery_fence(
        &self,
        local_generation: u64,
        permit: Option<crate::sync::recovery::RecoveryOwnerPermit>,
    ) {
        self.configure_recovery_fence_authority(local_generation, permit);
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let dest = resolve_shared(self.root(), path)?;
        fs::read(&dest).await.map_err(map_io)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        if is_recovery_authority_path(path) {
            return Err(SyncError::Auth(
                "reserved recovery authority requires conditional mutation".to_string(),
            ));
        }
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let dest = resolve_shared(self.root(), path)?;
        write_atomically(&dest, data).await
    }

    async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
        if is_recovery_authority_path(path) {
            return Err(SyncError::Auth(
                "reserved recovery authority requires exact conditional deletion".to_string(),
            ));
        }
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let dest = resolve_shared(self.root(), path)?;
        match fs::remove_file(&dest).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(map_io(e)),
        }
    }

    async fn list_files(&self, prefix: &str) -> Result<Vec<String>, SyncError> {
        if prefix != DEVICES_DIR {
            return Err(SyncError::Io(format!(
                "list_files prefix not in allow-list: {prefix}"
            )));
        }
        let dir = join_under_root(self.root(), prefix);
        let mut rd = match fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(map_io(e)),
        };
        let mut out = Vec::new();
        while let Some(entry) = rd.next_entry().await.map_err(map_io)? {
            if !entry.file_type().await.map_err(map_io)?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".json") else {
                continue;
            };
            if !is_safe_component(stem) {
                continue;
            }
            out.push(format!("{prefix}/{name}"));
        }
        out.sort();
        Ok(out)
    }

    async fn read_versioned_file(&self, path: &str) -> Result<VersionedFile, SyncError> {
        let dest = resolve_shared(self.root(), path)?;
        let mut file = std::fs::File::open(&dest).map_err(map_io)?;
        let meta = file.metadata().map_err(map_io)?;
        let revision = local_revision_from_metadata(&meta)
            .ok_or_else(|| SyncError::Io("cannot derive local revision".to_string()))?;
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.read_to_end(&mut bytes).map_err(map_io)?;
        Ok(VersionedFile { bytes, revision })
    }

    // TODO(later): folder-provider CAS is per-machine only (iCloud has no If-Match) — docs/LATER.md
    async fn compare_and_swap_file(
        &self,
        path: &str,
        expected_revision: &str,
        data: &[u8],
    ) -> Result<ConditionalMutationResult, SyncError> {
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let dest = resolve_shared(self.root(), path)?;
        let _guard = cas_lock().lock().await;
        let Some(revision) = current_revision(&dest)? else {
            return Ok(ConditionalMutationResult::NotFound);
        };
        if revision != expected_revision {
            return Ok(ConditionalMutationResult::Conflict);
        }
        write_atomically(&dest, data).await?;
        Ok(ConditionalMutationResult::Applied)
    }

    async fn create_initial_control_if_absent(
        &self,
        data: &[u8],
    ) -> Result<ConditionalMutationResult, SyncError> {
        let dest = resolve_shared(self.root(), SYNC_CONTROL_DRIVE_PATH)?;
        create_exclusive(&dest, data).await
    }

    async fn create_recovery_marker_if_absent(
        &self,
        data: &[u8],
        permit: &crate::sync::recovery::RecoveryOwnerPermit,
    ) -> Result<ConditionalMutationResult, SyncError> {
        self.revalidate_recovery_fence_before_mutation(RECOVERY_MARKER_PATH)
            .await?;
        let marker: RecoveryMarker = serde_json::from_slice(data)
            .map_err(|error| SyncError::Serialization(error.to_string()))?;
        let control = crate::sync::recovery::read_sync_control(self)
            .await?
            .ok_or_else(|| SyncError::Auth("recovery control is missing".to_string()))?;
        let exact_owner = control.recovery_lease.as_ref() == Some(&marker)
            && marker.job_id == permit.job_id
            && marker.owner_device_id == permit.owner_device_id
            && marker.operation == permit.operation
            && marker.recovery_generation == permit.recovery_generation
            && marker.nonce == permit.nonce;
        if !exact_owner {
            return Err(SyncError::Auth(
                "recovery marker create requires exact active control owner".to_string(),
            ));
        }
        let dest = resolve_shared(self.root(), RECOVERY_MARKER_PATH)?;
        if dest.exists() {
            return Ok(ConditionalMutationResult::Conflict);
        }
        create_exclusive(&dest, data).await
    }

    async fn delete_file_if_revision(
        &self,
        path: &str,
        expected_revision: &str,
    ) -> Result<ConditionalMutationResult, SyncError> {
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let dest = resolve_shared(self.root(), path)?;
        let _guard = cas_lock().lock().await;
        let Some(revision) = current_revision(&dest)? else {
            return Ok(ConditionalMutationResult::NotFound);
        };
        if revision != expected_revision {
            return Ok(ConditionalMutationResult::Conflict);
        }
        match fs::remove_file(&dest).await {
            Ok(()) => Ok(ConditionalMutationResult::Applied),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(ConditionalMutationResult::NotFound)
            }
            Err(e) => Err(map_io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::keyring_v2::{
        ConditionalMutationResult, KeyringV2Io, RecoveryMarker, RECOVERY_MARKER_VERSION,
    };
    use crate::sync::local_provider::LocalSyncProvider;
    use crate::sync::recovery::RecoveryOwnerPermit;
    use crate::sync::sync_control::{SyncControlV1, SYNC_CONTROL_VERSION};

    fn fixture() -> (tempfile::TempDir, LocalSyncProvider) {
        let dir = tempfile::TempDir::new().unwrap();
        let provider = LocalSyncProvider::new(dir.path());
        (dir, provider)
    }

    fn sample_marker() -> RecoveryMarker {
        RecoveryMarker {
            version: RECOVERY_MARKER_VERSION,
            job_id: 1,
            owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
            operation: "local_to_cloud".to_string(),
            recovery_generation: 1,
            nonce: "0123456789abcdef".to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn permit_for(marker: &RecoveryMarker) -> RecoveryOwnerPermit {
        RecoveryOwnerPermit {
            job_id: marker.job_id,
            owner_device_id: marker.owner_device_id.clone(),
            operation: marker.operation.clone(),
            recovery_generation: marker.recovery_generation,
            nonce: marker.nonce.clone(),
        }
    }

    fn write_control(root: &std::path::Path, generation: u64, lease: Option<RecoveryMarker>) {
        let meta = root.join(".meta");
        std::fs::create_dir_all(&meta).unwrap();
        let control = SyncControlV1 {
            version: SYNC_CONTROL_VERSION,
            recovery_generation: generation,
            recovery_lease: lease,
            updated_at: 1,
        };
        std::fs::write(
            meta.join("control.json"),
            serde_json::to_vec(&control).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn validate_shared_path_accepts_allow_list_and_device_slot() {
        for path in [
            ".meta/keyring.json",
            ".meta/control.json",
            ".meta/_recovery_marker.json",
            ".meta/keyring/_meta.json",
            ".meta/keyring/_recovery.json",
            ".meta/keyring/_content.json",
            ".meta/keyring/devices/dev-a.json",
        ] {
            validate_shared_path(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        }
    }

    #[test]
    fn validate_shared_path_rejects_evil_traversal_and_device_payload() {
        for path in [".meta/evil.json", "../x", "dev-a/entries/x.bin"] {
            let err = validate_shared_path(path).expect_err(path);
            assert!(
                matches!(err, SyncError::Io(_)),
                "{path}: expected Io, got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn write_control_json_is_auth() {
        let (_dir, p) = fixture();
        let err = KeyringV2Io::write_file(&p, ".meta/control.json", b"{}")
            .await
            .expect_err("control.json must not be writable via generic write");
        assert!(
            matches!(err, SyncError::Auth(_)),
            "expected Auth, got {err:?}"
        );
    }

    #[tokio::test]
    async fn create_initial_control_if_absent_applied_then_conflict() {
        let (_dir, p) = fixture();
        let first = KeyringV2Io::create_initial_control_if_absent(&p, b"{\"v\":1}")
            .await
            .unwrap();
        assert_eq!(first, ConditionalMutationResult::Applied);
        let second = KeyringV2Io::create_initial_control_if_absent(&p, b"{\"v\":2}")
            .await
            .unwrap();
        assert_eq!(second, ConditionalMutationResult::Conflict);
    }

    #[tokio::test]
    async fn list_files_missing_dir_is_empty() {
        let (_dir, p) = fixture();
        let listed = KeyringV2Io::list_files(&p, ".meta/keyring/devices")
            .await
            .unwrap();
        assert!(listed.is_empty(), "missing devices dir must be Ok([])");
    }

    #[tokio::test]
    async fn list_files_skips_stray_temp_file() {
        let (dir, p) = fixture();
        let devices = dir.path().join(".meta/keyring/devices");
        std::fs::create_dir_all(&devices).unwrap();
        std::fs::write(devices.join("dev-a.json"), b"{}").unwrap();
        std::fs::write(devices.join(".foo.tmp-1"), b"tmp").unwrap();
        let listed = KeyringV2Io::list_files(&p, ".meta/keyring/devices")
            .await
            .unwrap();
        assert_eq!(listed, vec![".meta/keyring/devices/dev-a.json".to_string()]);
    }

    #[tokio::test]
    async fn list_files_unreadable_dir_is_err() {
        let (dir, p) = fixture();
        let devices = dir.path().join(".meta/keyring/devices");
        std::fs::create_dir_all(&devices).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let original = std::fs::metadata(&devices).unwrap().permissions();
            std::fs::set_permissions(&devices, std::fs::Permissions::from_mode(0o000)).unwrap();
            let result = KeyringV2Io::list_files(&p, ".meta/keyring/devices").await;
            std::fs::set_permissions(&devices, original).unwrap();
            let err = result.expect_err("unreadable devices dir must be Err");
            assert!(
                matches!(err, SyncError::Auth(_)),
                "PermissionDenied must map to Auth via map_io, got {err:?}"
            );
        }

        #[cfg(not(unix))]
        {
            std::fs::remove_dir_all(&devices).unwrap();
            std::fs::write(&devices, b"not-a-dir").unwrap();
            let result = KeyringV2Io::list_files(&p, ".meta/keyring/devices").await;
            assert!(
                result.is_err(),
                "devices path that is not a directory must be Err, got {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn revision_changes_after_identical_rewrite() {
        let (_dir, p) = fixture();
        KeyringV2Io::write_file(&p, ".meta/keyring.json", b"same")
            .await
            .unwrap();
        let first = KeyringV2Io::read_versioned_file(&p, ".meta/keyring.json")
            .await
            .unwrap();
        KeyringV2Io::write_file(&p, ".meta/keyring.json", b"same")
            .await
            .unwrap();
        let second = KeyringV2Io::read_versioned_file(&p, ".meta/keyring.json")
            .await
            .unwrap();
        assert_eq!(first.bytes, second.bytes);
        assert_ne!(
            first.revision, second.revision,
            "rewrite of identical bytes must bump local:<secs>:<nanos>:<size>"
        );
    }

    #[tokio::test]
    async fn cas_two_instances_exactly_one_applied() {
        let dir = tempfile::TempDir::new().unwrap();
        let p1 = LocalSyncProvider::new(dir.path());
        let p2 = LocalSyncProvider::new(dir.path());
        KeyringV2Io::write_file(&p1, ".meta/keyring.json", b"v1")
            .await
            .unwrap();
        let versioned = KeyringV2Io::read_versioned_file(&p1, ".meta/keyring.json")
            .await
            .unwrap();

        let (r1, r2) = tokio::join!(
            KeyringV2Io::compare_and_swap_file(
                &p1,
                ".meta/keyring.json",
                &versioned.revision,
                b"a"
            ),
            KeyringV2Io::compare_and_swap_file(
                &p2,
                ".meta/keyring.json",
                &versioned.revision,
                b"b"
            ),
        );
        let outcomes = [r1.unwrap(), r2.unwrap()];
        let applied = outcomes
            .iter()
            .filter(|o| **o == ConditionalMutationResult::Applied)
            .count();
        let conflict = outcomes
            .iter()
            .filter(|o| **o == ConditionalMutationResult::Conflict)
            .count();
        assert_eq!(
            (applied, conflict),
            (1, 1),
            "two LocalSyncProvider instances racing CAS must yield one Applied and one Conflict, got {outcomes:?}"
        );
    }

    #[tokio::test]
    async fn create_recovery_marker_missing_control_is_auth() {
        let (_dir, p) = fixture();
        let marker = sample_marker();
        let permit = permit_for(&marker);
        let err = KeyringV2Io::create_recovery_marker_if_absent(
            &p,
            &serde_json::to_vec(&marker).unwrap(),
            &permit,
        )
        .await
        .expect_err("missing control must fail closed");
        assert!(
            matches!(err, SyncError::Auth(_)),
            "expected Auth, got {err:?}"
        );
    }

    #[tokio::test]
    async fn create_recovery_marker_owner_mismatch_is_auth() {
        let (dir, p) = fixture();
        let marker = sample_marker();
        write_control(dir.path(), marker.recovery_generation, Some(marker.clone()));
        let foreign = RecoveryOwnerPermit {
            job_id: 999,
            owner_device_id: "zzzzzzzz-9999-9999-9999-zzzzzzzzzzzz".to_string(),
            operation: marker.operation.clone(),
            recovery_generation: marker.recovery_generation,
            nonce: marker.nonce.clone(),
        };
        let err = KeyringV2Io::create_recovery_marker_if_absent(
            &p,
            &serde_json::to_vec(&marker).unwrap(),
            &foreign,
        )
        .await
        .expect_err("exact-owner mismatch must fail closed");
        assert!(
            matches!(err, SyncError::Auth(_)),
            "expected Auth, got {err:?}"
        );
    }

    #[tokio::test]
    async fn create_recovery_marker_exists_is_conflict() {
        let (dir, p) = fixture();
        let marker = sample_marker();
        write_control(dir.path(), marker.recovery_generation, Some(marker.clone()));
        let dest = dir.path().join(".meta/_recovery_marker.json");
        std::fs::write(&dest, b"already").unwrap();
        let result = KeyringV2Io::create_recovery_marker_if_absent(
            &p,
            &serde_json::to_vec(&marker).unwrap(),
            &permit_for(&marker),
        )
        .await
        .unwrap();
        assert_eq!(result, ConditionalMutationResult::Conflict);
    }

    #[tokio::test]
    async fn create_recovery_marker_happy_path_applied() {
        let (dir, p) = fixture();
        let marker = sample_marker();
        write_control(dir.path(), marker.recovery_generation, Some(marker.clone()));
        let created = KeyringV2Io::create_recovery_marker_if_absent(
            &p,
            &serde_json::to_vec(&marker).unwrap(),
            &permit_for(&marker),
        )
        .await
        .unwrap();
        assert_eq!(created, ConditionalMutationResult::Applied);
        assert!(dir.path().join(".meta/_recovery_marker.json").exists());
    }

    #[tokio::test]
    async fn delete_file_if_revision_absent_is_not_found() {
        let (_dir, p) = fixture();
        let result = KeyringV2Io::delete_file_if_revision(&p, ".meta/keyring.json", "local:0:0:0")
            .await
            .unwrap();
        assert_eq!(result, ConditionalMutationResult::NotFound);
    }

    #[tokio::test]
    async fn delete_file_if_revision_mismatch_is_conflict() {
        let (_dir, p) = fixture();
        KeyringV2Io::write_file(&p, ".meta/keyring.json", b"v1")
            .await
            .unwrap();
        let result = KeyringV2Io::delete_file_if_revision(&p, ".meta/keyring.json", "local:0:0:0")
            .await
            .unwrap();
        assert_eq!(result, ConditionalMutationResult::Conflict);
    }

    #[tokio::test]
    async fn delete_file_if_revision_match_is_applied() {
        let (dir, p) = fixture();
        KeyringV2Io::write_file(&p, ".meta/keyring.json", b"v1")
            .await
            .unwrap();
        let versioned = KeyringV2Io::read_versioned_file(&p, ".meta/keyring.json")
            .await
            .unwrap();
        let result =
            KeyringV2Io::delete_file_if_revision(&p, ".meta/keyring.json", &versioned.revision)
                .await
                .unwrap();
        assert_eq!(result, ConditionalMutationResult::Applied);
        assert!(!dir.path().join(".meta/keyring.json").exists());
    }

    #[tokio::test]
    async fn delete_file_of_control_and_recovery_marker_is_auth() {
        let (_dir, p) = fixture();
        for path in [".meta/control.json", ".meta/_recovery_marker.json"] {
            let err = KeyringV2Io::delete_file(&p, path).await.expect_err(path);
            assert!(
                matches!(err, SyncError::Auth(_)),
                "{path}: expected Auth, got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn compare_and_swap_absent_is_not_found() {
        let (_dir, p) = fixture();
        let result =
            KeyringV2Io::compare_and_swap_file(&p, ".meta/keyring.json", "local:0:0:0", b"x")
                .await
                .unwrap();
        assert_eq!(result, ConditionalMutationResult::NotFound);
    }

    #[tokio::test]
    async fn compare_and_swap_stale_revision_is_conflict() {
        let (_dir, p) = fixture();
        KeyringV2Io::write_file(&p, ".meta/keyring.json", b"v1")
            .await
            .unwrap();
        let first = KeyringV2Io::read_versioned_file(&p, ".meta/keyring.json")
            .await
            .unwrap();
        let applied =
            KeyringV2Io::compare_and_swap_file(&p, ".meta/keyring.json", &first.revision, b"v2")
                .await
                .unwrap();
        assert_eq!(applied, ConditionalMutationResult::Applied);
        let stale =
            KeyringV2Io::compare_and_swap_file(&p, ".meta/keyring.json", &first.revision, b"v3")
                .await
                .unwrap();
        assert_eq!(stale, ConditionalMutationResult::Conflict);
    }

    #[tokio::test]
    async fn keyring_writes_stay_at_vault_root_when_fence_on() {
        let dir = tempfile::TempDir::new().unwrap();
        write_control(dir.path(), 3, None);
        let p = LocalSyncProvider::new(dir.path()).with_recovery_fence(3, None);
        KeyringV2Io::write_file(&p, ".meta/keyring/_meta.json", b"{}")
            .await
            .unwrap();
        KeyringV2Io::write_file(&p, ".meta/keyring/devices/dev-a.json", b"{}")
            .await
            .unwrap();
        assert!(
            dir.path().join(".meta/keyring/_meta.json").exists(),
            "shared keyring files must stay at <root>/.meta"
        );
        assert!(dir.path().join(".meta/keyring/devices/dev-a.json").exists());
        assert!(
            !dir.path()
                .join("generations/g-3/.meta/keyring/_meta.json")
                .exists(),
            "KeyringV2Io must not write under generations/g-N"
        );
        assert!(!dir
            .path()
            .join("generations/g-3/.meta/keyring/devices/dev-a.json")
            .exists());
    }

    #[tokio::test]
    async fn keyring_write_file_fence_mismatch_is_auth() {
        let dir = tempfile::TempDir::new().unwrap();
        write_control(dir.path(), 2, None);
        let p = LocalSyncProvider::new(dir.path()).with_recovery_fence(1, None);
        let err = KeyringV2Io::write_file(&p, ".meta/keyring/_meta.json", b"poison")
            .await
            .expect_err("stale generation must not write shared keyring files");
        assert!(
            matches!(err, SyncError::Auth(_)),
            "expected Auth, got {err:?}"
        );
        assert!(
            !dir.path().join(".meta/keyring/_meta.json").exists(),
            "mismatched fence must not poison _meta.json"
        );
    }

    #[tokio::test]
    async fn write_recovery_marker_is_auth() {
        let (_dir, p) = fixture();
        let err = KeyringV2Io::write_file(&p, ".meta/_recovery_marker.json", b"{}")
            .await
            .expect_err("_recovery_marker.json must not be writable via generic write");
        assert!(
            matches!(err, SyncError::Auth(_)),
            "expected Auth, got {err:?}"
        );
    }

    #[tokio::test]
    async fn create_exclusive_publishes_complete_bytes() {
        let (dir, p) = fixture();
        let payload = br#"{"complete":true,"n":1}"#;
        let result = KeyringV2Io::create_initial_control_if_absent(&p, payload)
            .await
            .unwrap();
        assert_eq!(result, ConditionalMutationResult::Applied);
        let dest = dir.path().join(".meta/control.json");
        let bytes = std::fs::read(&dest).unwrap();
        assert_eq!(
            bytes, payload,
            "create_exclusive must publish the complete payload, never a 0-byte placeholder"
        );
        assert!(dest.metadata().unwrap().len() > 0);
    }

    #[tokio::test]
    async fn create_exclusive_conflict_leaves_existing_dest_intact() {
        let (dir, p) = fixture();
        let dest = dir.path().join(".meta/control.json");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, b"already-complete").unwrap();
        let result = KeyringV2Io::create_initial_control_if_absent(&p, b"replacement")
            .await
            .unwrap();
        assert_eq!(result, ConditionalMutationResult::Conflict);
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            b"already-complete",
            "conflict must not truncate or replace the existing authority file"
        );
    }

    #[tokio::test]
    async fn compare_and_swap_fence_mismatch_is_auth() {
        let dir = tempfile::TempDir::new().unwrap();
        write_control(dir.path(), 2, None);
        std::fs::create_dir_all(dir.path().join(".meta")).unwrap();
        std::fs::write(dir.path().join(".meta/keyring.json"), b"v1").unwrap();
        let p = LocalSyncProvider::new(dir.path()).with_recovery_fence(1, None);
        let err =
            KeyringV2Io::compare_and_swap_file(&p, ".meta/keyring.json", "local:0:0:0", b"poison")
                .await
                .expect_err("stale generation must not CAS");
        assert!(
            matches!(err, SyncError::Auth(_)),
            "expected Auth, got {err:?}"
        );
        assert_eq!(
            std::fs::read(dir.path().join(".meta/keyring.json")).unwrap(),
            b"v1",
            "fence mismatch must not rewrite the file"
        );
    }

    #[tokio::test]
    async fn delete_file_if_revision_fence_mismatch_is_auth() {
        let dir = tempfile::TempDir::new().unwrap();
        write_control(dir.path(), 2, None);
        std::fs::create_dir_all(dir.path().join(".meta")).unwrap();
        std::fs::write(dir.path().join(".meta/keyring.json"), b"v1").unwrap();
        let p = LocalSyncProvider::new(dir.path()).with_recovery_fence(1, None);
        let err = KeyringV2Io::delete_file_if_revision(&p, ".meta/keyring.json", "local:0:0:0")
            .await
            .expect_err("stale generation must not conditionally delete");
        assert!(
            matches!(err, SyncError::Auth(_)),
            "expected Auth, got {err:?}"
        );
        assert!(
            dir.path().join(".meta/keyring.json").exists(),
            "fence mismatch must not delete the file"
        );
    }

    #[tokio::test]
    async fn keyring_delete_file_fence_mismatch_is_auth() {
        let dir = tempfile::TempDir::new().unwrap();
        write_control(dir.path(), 2, None);
        std::fs::create_dir_all(dir.path().join(".meta")).unwrap();
        std::fs::write(dir.path().join(".meta/keyring.json"), b"v1").unwrap();
        let p = LocalSyncProvider::new(dir.path()).with_recovery_fence(1, None);
        let err = KeyringV2Io::delete_file(&p, ".meta/keyring.json")
            .await
            .expect_err("stale generation must not delete shared keyring files");
        assert!(
            matches!(err, SyncError::Auth(_)),
            "expected Auth, got {err:?}"
        );
        assert!(
            dir.path().join(".meta/keyring.json").exists(),
            "fence mismatch must not delete the file"
        );
    }
}
