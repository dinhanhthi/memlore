//! Folder-backed cloud connect commands (iCloud Drive and a local directory).
//!
//! Google Drive keeps its OAuth two-phase flow in [`crate::commands::gdrive`].
//! This module owns the filesystem-provider entry points: a TCC-safe
//! availability probe and `cloud_folder_connect`, which then joins the
//! shared [`crate::commands::gdrive::complete_cloud_connect`] pipeline.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

use crate::commands::gdrive::GdriveConnectOutcome;
use crate::db;
use crate::sync::local_provider::LocalSyncProvider;
use crate::sync::CloudProvider;
use crate::{AppState, EncryptionKeyState, GDriveSessionState};

/// TCC-safe iCloud Drive probe. `path` is the CloudDocs root (not `Memlore`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IcloudAvailability {
    pub available: bool,
    pub path: String,
}

const ICLOUD_GRANT_ACCESS: &str = "Grant Memlore access to iCloud Drive in System Settings › Privacy & Security › Files and Folders, then retry.";
const ICLOUD_DRIVE_UNAVAILABLE: &str =
    "iCloud Drive is not available. Enable iCloud Drive in System Settings, then retry.";
const ALREADY_CONNECTED: &str = "Disconnect the current provider first";

/// `$HOME/Library/Mobile Documents/com~apple~CloudDocs` on macOS.
///
/// Uses `metadata` only — never `read_dir` — so the Files-and-Folders TCC
/// prompt fires on Connect, not when the picker renders.
fn icloud_cloud_docs_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Mobile Documents")
                .join("com~apple~CloudDocs")
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn map_icloud_io(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        ICLOUD_GRANT_ACCESS.to_string()
    } else {
        error.to_string()
    }
}

fn resolve_folder_root(kind: &str, root_path: Option<String>) -> Result<PathBuf, String> {
    match kind {
        "icloud" => {
            let cloud_docs = icloud_cloud_docs_path()
                .ok_or_else(|| "iCloud Drive is not available on this platform".to_string())?;
            Ok(cloud_docs.join("Memlore"))
        }
        "local" => {
            let raw = root_path
                .ok_or_else(|| "root_path is required for the local provider".to_string())?;
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                return Err("Sync folder path must not be empty".to_string());
            }
            Ok(PathBuf::from(trimmed))
        }
        _ => Err(format!("Unsupported folder provider: {kind}")),
    }
}

#[tauri::command]
pub fn icloud_availability() -> IcloudAvailability {
    #[cfg(not(target_os = "macos"))]
    {
        return IcloudAvailability {
            available: false,
            path: String::new(),
        };
    }
    #[cfg(target_os = "macos")]
    {
        let Some(path) = icloud_cloud_docs_path() else {
            return IcloudAvailability {
                available: false,
                path: String::new(),
            };
        };
        let available = std::fs::metadata(&path)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        IcloudAvailability {
            available,
            path: path.to_string_lossy().into_owned(),
        }
    }
}

/// Writability probe. A temp file is used because
/// `metadata().permissions().readonly()` only checks the owner bit on Unix
/// and lies for group-writable dirs.
fn probe_folder_writable(path: &Path) -> std::io::Result<()> {
    let probe = path.join(".memlore-sync-writable-probe");
    match std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn map_folder_access_error(path: &Path, error: std::io::Error, icloud: bool) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => {
            format!("Sync folder does not exist: {}", path.display())
        }
        std::io::ErrorKind::PermissionDenied if icloud => ICLOUD_GRANT_ACCESS.to_string(),
        std::io::ErrorKind::PermissionDenied => {
            format!(
                "Permission denied accessing sync folder: {}",
                path.display()
            )
        }
        _ => format!("Failed to access sync folder: {error}"),
    }
}

/// Exists / is-dir / writability probe for a folder sync root.
///
/// Uses `std::fs::metadata` so PermissionDenied and other IO errors are not
/// collapsed into "does not exist" the way `Path::exists` / `Path::is_dir` do.
pub(crate) fn validate_sync_folder(path: &Path) -> Result<(), String> {
    validate_sync_folder_kind(path, false)
}

fn validate_sync_folder_kind(path: &Path, icloud: bool) -> Result<(), String> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            if !meta.is_dir() {
                return Err(format!("Sync path is not a directory: {}", path.display()));
            }
        }
        Err(e) => return Err(map_folder_access_error(path, e, icloud)),
    }
    probe_folder_writable(path).map_err(|e| {
        if icloud && e.kind() == std::io::ErrorKind::PermissionDenied {
            ICLOUD_GRANT_ACCESS.to_string()
        } else {
            format!("Sync folder is not writable: {e}")
        }
    })
}

fn require_icloud_cloud_docs(cloud_docs: &Path) -> Result<(), String> {
    match std::fs::metadata(cloud_docs) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(format!(
            "iCloud Drive path is not a directory: {}",
            cloud_docs.display()
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(ICLOUD_DRIVE_UNAVAILABLE.to_string())
        }
        Err(e) => Err(map_icloud_io(e)),
    }
}

fn prepare_sync_folder(kind: &str, path: &Path) -> Result<(), String> {
    if kind == "icloud" {
        let cloud_docs = path
            .parent()
            .ok_or_else(|| "Invalid iCloud sync path".to_string())?;
        require_icloud_cloud_docs(cloud_docs)?;
        std::fs::create_dir_all(path).map_err(map_icloud_io)?;
        return validate_sync_folder_kind(path, true);
    }
    validate_sync_folder(path)
}

#[tauri::command]
pub async fn cloud_folder_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    session_state: State<'_, GDriveSessionState>,
    session_id: String,
    provider: String,
    root_path: Option<String>,
    password: String,
) -> Result<GdriveConnectOutcome, String> {
    let password = zeroize::Zeroizing::new(password);

    let kind = match provider.as_str() {
        "icloud" | "local" => provider,
        other => return Err(format!("Unsupported folder provider: {other}")),
    };

    let root = resolve_folder_root(&kind, root_path)?;

    {
        let conn = state.lock()?;
        if db::get_setting(&conn, "sync_connected")
            .map_err(|e| e.to_string())?
            .as_deref()
            == Some("true")
        {
            return Err(ALREADY_CONNECTED.to_string());
        }
    }

    prepare_sync_folder(&kind, &root)?;

    let _sync_guard = crate::commands::sync::SyncInProgressGuard::try_acquire()
        .ok_or_else(|| crate::commands::sync::SYNC_IN_PROGRESS_ERR.to_string())?;

    let vault_unlocked = key_state.is_initialized()?;
    let local_mode = {
        let conn = state.lock()?;
        let mode = db::get_encryption_mode(&conn).map_err(|e| e.to_string())?;
        if crate::commands::gdrive::password_check_required(
            &mode,
            password.is_empty(),
            vault_unlocked,
        ) && !db::verify_password_hash(&conn, &password).map_err(|e| e.to_string())?
        {
            return Err("Invalid password".to_string());
        }
        mode
    };

    let local_generation = {
        let conn = state.lock()?;
        db::get_sync_recovery_generation(&conn).map_err(|e| e.to_string())?
    };

    let pending = crate::commands::pending_drive_session::PendingCloudSession::Folder {
        kind,
        root_path: root.to_string_lossy().into_owned(),
    };

    crate::commands::gdrive::complete_cloud_connect(
        &app,
        &*state,
        &*key_state,
        &*session_state,
        &session_id,
        CloudProvider::Folder(
            LocalSyncProvider::new(root).with_recovery_fence(local_generation, None),
        ),
        pending,
        local_mode,
        vault_unlocked,
        password.as_str(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::pending_drive_session::{self, PendingCloudSession};
    use crate::commands::sync::SYNC_GUARD_TEST_LOCK;
    use crate::db::schema::migrate;
    use crate::test_support::mock_app::{guard_app_data_dir, mock_app, mock_app_with_state};
    use crate::{AppState, EncryptionKeyState, StartupMode};
    use rusqlite::Connection;
    use serial_test::serial;
    use tauri::Manager;
    use tempfile::TempDir;
    use zeroize::Zeroizing;

    fn password_app() -> tauri::App<tauri::test::MockRuntime> {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        migrate(&conn).expect("migrate");
        db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
        db::set_password_hash(&conn, "12345678").unwrap();
        let key_state = EncryptionKeyState::new();
        key_state
            .set_key(Zeroizing::new([7u8; 32]))
            .expect("unlock key_state");
        mock_app_with_state(AppState::new(conn), key_state, StartupMode::PasswordLocked)
    }

    fn unset_app() -> tauri::App<tauri::test::MockRuntime> {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        migrate(&conn).expect("migrate");
        db::set_encryption_mode(&conn, db::EncryptionMode::Unset).unwrap();
        mock_app_with_state(
            AppState::new(conn),
            EncryptionKeyState::new(),
            StartupMode::FirstLaunch,
        )
    }

    fn write_published_keyring(root: &Path) {
        let meta_dir = root.join(".meta");
        let keyring_dir = meta_dir.join("keyring");
        std::fs::create_dir_all(&keyring_dir).unwrap();
        std::fs::write(
            meta_dir.join("control.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "recovery_generation": 0,
                "recovery_lease": null,
                "updated_at": 1
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            keyring_dir.join("_meta.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 2,
                "epoch": 1,
                "master_fingerprint": "a1".repeat(32),
                "content_epoch": 1,
                "recovery_generation": 0,
                "created_at": 1,
                "updated_at": 1
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            keyring_dir.join("_recovery.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 2,
                "wrapped_master": "ab".repeat(60),
                "created_at": 1
            }))
            .unwrap(),
        )
        .unwrap();
    }

    async fn connect_local(
        app: &tauri::App<tauri::test::MockRuntime>,
        session_id: &str,
        root: &Path,
        password: &str,
    ) -> Result<GdriveConnectOutcome, String> {
        cloud_folder_connect(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            session_id.to_string(),
            "local".to_string(),
            Some(root.to_string_lossy().into_owned()),
            password.to_string(),
        )
        .await
    }

    #[tokio::test]
    #[serial]
    async fn empty_dir_password_mode_returns_ready() {
        let _lock = SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending_drive_session::reset();
        let app = password_app();
        let _guard = guard_app_data_dir(&app);
        let dir = TempDir::new().unwrap();

        let outcome = connect_local(&app, "sess-ready", dir.path(), "12345678")
            .await
            .expect("connect must succeed");
        assert!(
            matches!(outcome, GdriveConnectOutcome::Ready),
            "expected Ready, got {outcome:?}"
        );
    }

    #[tokio::test]
    #[serial]
    async fn empty_dir_unset_mode_stashes_folder_session() {
        let _lock = SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending_drive_session::reset();
        let app = unset_app();
        let _guard = guard_app_data_dir(&app);
        let dir = TempDir::new().unwrap();
        let session_id = "sess-first-time";

        let outcome = connect_local(&app, session_id, dir.path(), "")
            .await
            .expect("unset empty connect must succeed");
        assert!(
            matches!(outcome, GdriveConnectOutcome::NeedsFirstTimeSetup),
            "expected NeedsFirstTimeSetup, got {outcome:?}"
        );

        match pending_drive_session::peek(session_id) {
            Some(PendingCloudSession::Folder { kind, root_path }) => {
                assert_eq!(kind, "local");
                assert_eq!(root_path, dir.path().to_string_lossy());
            }
            other => panic!("expected Folder pending session, got {other:?}"),
        }
    }

    #[tokio::test]
    #[serial]
    async fn published_keyring_unset_mode_needs_onboarding() {
        let _lock = SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending_drive_session::reset();
        let app = unset_app();
        let _guard = guard_app_data_dir(&app);
        let dir = TempDir::new().unwrap();
        write_published_keyring(dir.path());

        let outcome = connect_local(&app, "sess-onboard", dir.path(), "")
            .await
            .expect("unset keyring connect must succeed");
        assert!(
            matches!(outcome, GdriveConnectOutcome::NeedsOnboarding),
            "expected NeedsOnboarding, got {outcome:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial]
    async fn unwritable_dir_errors_with_writable() {
        let _lock = SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending_drive_session::reset();
        let app = password_app();
        let _guard = guard_app_data_dir(&app);
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        let _restore = ModeRestore::chmod(&path, 0o555);

        let err = connect_local(&app, "sess-unwritable", &path, "12345678")
            .await
            .expect_err("unwritable dir must fail");
        assert!(
            err.to_lowercase().contains("writable"),
            "error must mention writable, got {err}"
        );
    }

    #[tokio::test]
    #[serial]
    async fn unknown_provider_is_rejected() {
        let _lock = SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending_drive_session::reset();
        let app = mock_app();
        let err = cloud_folder_connect(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            "sess-dropbox".to_string(),
            "dropbox".to_string(),
            None,
            String::new(),
        )
        .await
        .expect_err("dropbox must be rejected");
        assert!(
            !err.is_empty(),
            "unknown provider must return a non-empty error"
        );
    }

    #[tokio::test]
    #[serial]
    async fn already_connected_refuses() {
        let _lock = SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending_drive_session::reset();
        let app = password_app();
        let _guard = guard_app_data_dir(&app);
        let dir = TempDir::new().unwrap();
        {
            let state = app.state::<AppState>();
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "sync_connected", "true").unwrap();
        }

        let err = connect_local(&app, "sess-already", dir.path(), "12345678")
            .await
            .expect_err("already connected must fail");
        assert_eq!(err, ALREADY_CONNECTED);
    }

    struct HomeGuard(Option<std::ffi::OsString>);
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(home) => std::env::set_var("HOME", home),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[cfg(unix)]
    struct ModeRestore {
        path: PathBuf,
        mode: u32,
    }
    #[cfg(unix)]
    impl ModeRestore {
        fn chmod(path: impl AsRef<Path>, mode: u32) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let path = path.as_ref().to_path_buf();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            Self { path, mode: 0o755 }
        }
    }
    #[cfg(unix)]
    impl Drop for ModeRestore {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(self.mode));
        }
    }

    #[test]
    #[serial]
    fn icloud_availability_false_when_home_lacks_clouddocs() {
        let tmp = TempDir::new().unwrap();
        let _restore = HomeGuard(std::env::var_os("HOME"));
        std::env::set_var("HOME", tmp.path());

        let result = icloud_availability();
        assert!(
            !result.available,
            "TempDir without CloudDocs must report available=false, got {result:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_metadata_permission_denied_is_not_absence() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("parent");
        let target = parent.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let _restore = ModeRestore::chmod(&parent, 0o000);

        let err =
            validate_sync_folder(&target).expect_err("metadata PermissionDenied must fail closed");
        assert!(
            !err.to_lowercase().contains("does not exist"),
            "PermissionDenied must not be reported as absence, got {err}"
        );
    }

    #[test]
    fn prepare_icloud_without_clouddocs_does_not_create_parents() {
        let tmp = TempDir::new().unwrap();
        let cloud_docs = tmp.path().join("com~apple~CloudDocs");
        let memlore = cloud_docs.join("Memlore");

        let err =
            prepare_sync_folder("icloud", &memlore).expect_err("missing CloudDocs must refuse");
        assert!(
            !cloud_docs.exists(),
            "must not create a fake CloudDocs tree (err was {err})"
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[serial]
    async fn icloud_connect_without_clouddocs_refuses_and_does_not_create_tree() {
        let _lock = SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending_drive_session::reset();
        let app = password_app();
        let _guard = guard_app_data_dir(&app);

        let tmp = TempDir::new().unwrap();
        let _restore = HomeGuard(std::env::var_os("HOME"));
        std::env::set_var("HOME", tmp.path());

        let err = cloud_folder_connect(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            "sess-no-clouddocs".to_string(),
            "icloud".to_string(),
            None,
            "12345678".to_string(),
        )
        .await
        .expect_err("icloud connect without CloudDocs must refuse");

        let cloud_docs = tmp
            .path()
            .join("Library")
            .join("Mobile Documents")
            .join("com~apple~CloudDocs");
        assert!(
            !cloud_docs.exists(),
            "must not create a fake CloudDocs tree (err was {err})"
        );
    }

    #[cfg(unix)]
    #[test]
    fn icloud_create_permission_denied_is_grant_access() {
        let tmp = TempDir::new().unwrap();
        let cloud_docs = tmp.path().join("com~apple~CloudDocs");
        std::fs::create_dir(&cloud_docs).unwrap();
        let _restore = ModeRestore::chmod(&cloud_docs, 0o555);

        let err = prepare_sync_folder("icloud", &cloud_docs.join("Memlore"))
            .expect_err("unwritable CloudDocs must fail");
        assert_eq!(err, ICLOUD_GRANT_ACCESS);
    }
}
