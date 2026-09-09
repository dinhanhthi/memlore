//! Mock `AppHandle` harness for `#[tauri::command]`s that take `AppHandle<R>`.
//!
//! Isolated from the real `app.memlore` data dir via a unique bundle identifier
//! per `mock_app()` call.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Manager;

use crate::db;
use crate::db::schema::migrate;
use crate::{AppState, EncryptionKeyState, GDriveSessionState, StartupMode};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Unique identifier so tests never write into the real `app.memlore` data dir.
fn unique_identifier() -> String {
    format!(
        "app.memlore.mock-app-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn placeholder_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    migrate(&conn).expect("migrate placeholder");
    conn
}

/// Build a mock Tauri app with the states the two T40 commands need.
pub fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    mock_app_with_state(
        AppState::new(placeholder_conn()),
        EncryptionKeyState::new(),
        StartupMode::PasswordLocked,
    )
}

pub fn mock_app_with_state(
    state: AppState,
    key_state: EncryptionKeyState,
    startup: StartupMode,
) -> tauri::App<tauri::test::MockRuntime> {
    let mut ctx = mock_context(noop_assets());
    ctx.config_mut().identifier = unique_identifier();
    mock_builder()
        .manage(state)
        .manage(key_state)
        .manage(Mutex::new(startup))
        .manage(GDriveSessionState::new())
        .build(ctx)
        .expect("mock app")
}

/// Best-effort cleanup of the mock identifier's app-data directory.
pub struct AppDataDirGuard(pub PathBuf);

impl Drop for AppDataDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn guard_app_data_dir(app: &tauri::App<tauri::test::MockRuntime>) -> AppDataDirGuard {
    let dir = app.path().app_data_dir().expect("mock app_data_dir");
    std::fs::create_dir_all(&dir).expect("create mock app_data_dir");
    AppDataDirGuard(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::crypto::{recover_with_passphrase, reset_recovery_phrase};
    use crate::commands::sync::{SyncInProgressGuard, SYNC_GUARD_TEST_LOCK, SYNC_IN_PROGRESS_ERR};
    use crate::utils::boot_file::{self, BootFile};
    use crate::utils::encryption::{
        derive_sqlcipher_key, encrypt_data, generate_encryption_salt, wrap_key_with, KdfParams,
    };
    use rand::rngs::OsRng;
    use rand::RngCore;
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::Listener;
    use zeroize::Zeroizing;

    fn make_recovery_slot(master_key: &[u8; 32], mnemonic: &str) -> String {
        let parsed = crate::utils::recovery::validate_recovery_mnemonic(mnemonic).unwrap();
        let recovery_key = crate::utils::recovery::derive_recovery_key(&parsed);
        let blob = encrypt_data(&recovery_key, master_key.as_ref()).unwrap();
        hex::encode(&blob)
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn audit_row(created_at: i64) -> db::AiAuditLogInsert {
        db::AiAuditLogInsert {
            created_at,
            feature: "test".into(),
            operation: "chat".into(),
            provider_id: "p".into(),
            model_id: "m".into(),
            endpoint_host: "h".into(),
            endpoint_class: "remote".into(),
            payload_bytes: 1,
            latency_ms: 1,
            status: "ok".into(),
            error_code: None,
            tokens_in: None,
            tokens_out: None,
        }
    }

    #[test]
    fn mock_app_manages_required_state() {
        let app = mock_app();
        let _ = app.state::<AppState>();
        let _ = app.state::<EncryptionKeyState>();
        let _ = app.state::<Mutex<StartupMode>>();
        let _ = app.state::<GDriveSessionState>();
        let dir = app.path().app_data_dir().expect("app_data_dir");
        assert!(
            dir.to_string_lossy().contains("app.memlore.mock-app-"),
            "mock identifier must isolate from the real app data dir, got {dir:?}"
        );
    }

    /// Full-command T11 + emit: recovery must fire `app:unlocked` and purge
    /// expired AI-audit rows on the swapped-in real connection.
    #[tokio::test]
    async fn recover_with_passphrase_emits_app_unlocked_and_purges_expired_audit_rows() {
        let app = mock_app();
        let _guard = guard_app_data_dir(&app);
        let data_dir = _guard.0.clone();
        let db_path = data_dir.join("memlore.db");
        let boot_path = boot_file::boot_path(&db_path);

        let mut raw_master = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(raw_master.as_mut());
        let kek_salt = generate_encryption_salt();
        let kek_salt_hex = hex::encode(kek_salt);
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let wrapped_master_hex =
            wrap_key_with(&*raw_master, "oldpass12", &kek_salt, KdfParams::FAST).unwrap();
        let recovery_slot = make_recovery_slot(&*raw_master, &mnemonic);

        let now = now_ms();
        let old_ms = now - 100 * 86_400_000;
        let recent_ms = now - 86_400_000;
        {
            let sqlcipher_key = derive_sqlcipher_key(&*raw_master);
            let conn = crate::db::open_with_key(&db_path.to_string_lossy(), &*sqlcipher_key)
                .expect("open seeded vault");
            migrate(&conn).unwrap();
            db::set_password_hash(&conn, "oldpass12").unwrap();
            db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, &wrapped_master_hex).unwrap();
            db::set_setting(&conn, db::KEK_SALT_KEY, &kek_salt_hex).unwrap();
            db::set_encryption_mode(&conn, db::EncryptionMode::Password).unwrap();
            db::insert_ai_audit_log(&conn, &audit_row(old_ms)).unwrap();
            db::insert_ai_audit_log(&conn, &audit_row(recent_ms)).unwrap();
        }

        boot_file::save(
            &BootFile {
                unlock_method: crate::utils::boot_file::UnlockMethod::Password,
                mode: db::EncryptionMode::Password,
                kek_salt: Some(kek_salt_hex),
                wrapped_key: Some(wrapped_master_hex),
                os_kek_wrapped_master: None,
                recovery_wrapped: Some(recovery_slot),
                wrapped_content_list: None,
                wrapped_db_key: None,
                master_wrapped_db_key: None,
                migration_in_progress: None,
            },
            &boot_path,
        )
        .unwrap();

        let (tx, rx) = mpsc::channel();
        let _unlisten = app.listen("app:unlocked", move |_| {
            let _ = tx.send(());
        });

        recover_with_passphrase(
            app.handle().clone(),
            app.state(),
            app.state(),
            mnemonic.to_string(),
            "newpass12".into(),
        )
        .await
        .expect("recover_with_passphrase");

        rx.recv_timeout(Duration::from_secs(2))
            .expect("recover_with_passphrase must emit app:unlocked");

        let remaining = app
            .state::<AppState>()
            .with_conn(|c| {
                db::list_ai_audit_log(c, &db::AiAuditLogFilter::default(), 10, 0)
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(remaining.len(), 1, "expired audit row must be purged (T11)");
        assert_eq!(remaining[0].created_at, recent_ms);
    }

    /// Guard is checked before the password is read — a too-short password
    /// must not surface the length error while a sync holds the slot.
    #[tokio::test]
    async fn reset_recovery_phrase_refuses_while_sync_in_progress_before_reading_password() {
        let _lock = SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let holder = SyncInProgressGuard::try_acquire().expect("first acquire");
        let app = mock_app();
        let err = reset_recovery_phrase(
            app.handle().clone(),
            app.state(),
            app.state(),
            String::new(),
        )
        .await
        .expect_err("must refuse while sync holds the guard");
        assert_eq!(
            err, SYNC_IN_PROGRESS_ERR,
            "must fail on the guard before validate_password_length, got {err}"
        );
        drop(holder);
    }

    /// Wrong password is rejected locally — before Drive is acquired.
    #[tokio::test]
    async fn reset_recovery_phrase_wrong_password_errors_before_acquire_drive_provider() {
        let conn = placeholder_conn();
        db::set_password_hash(&conn, "correct-password-123").unwrap();
        let app = mock_app_with_state(
            AppState::new(conn),
            EncryptionKeyState::new(),
            StartupMode::PasswordLocked,
        );
        let err = reset_recovery_phrase(
            app.handle().clone(),
            app.state(),
            app.state(),
            "wrong-password-xxx".into(),
        )
        .await
        .expect_err("wrong password must fail");
        assert_eq!(err, "Invalid password");
        assert!(
            !err.contains("Google Drive") && !err.contains("connect Drive"),
            "must not reach acquire_drive_provider, got {err}"
        );
    }
}
