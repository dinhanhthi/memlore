//! MCP socket lifecycle hooks (task 3.3).
//!
//! Start on toggle-ON and on first unlock. **Never** stop on lock — a
//! locked vault must still answer on the socket so a client (and the
//! Phase 4 `--mcp-stdio` bridge) sees "Memlore is locked" rather than
//! ECONNREFUSED / "Memlore is not running".
//!
//! Stop happens on toggle-OFF and on app exit only.

use rusqlite::Connection;

use crate::ai::provider::settings_keys;
use crate::db;
use crate::mcp::server::McpServerManager;

/// `true` only when the settings row is exactly `"true"`. Missing or any
/// other value is off — the toggle defaults off.
pub fn mcp_server_enabled(conn: &Connection) -> bool {
    db::get_setting(conn, settings_keys::MCP_SERVER_ENABLED)
        .ok()
        .flatten()
        .as_deref()
        == Some("true")
}

/// Unlock hook: if the setting is on, bind the socket. Returns whether
/// `ensure_running` was invoked. Does nothing when the setting is off.
///
/// Production unlock commands call [`spawn_maybe_start_mcp_on_unlock`]
/// (cannot hold a `Connection` across `.await`); this helper is the
/// testable form used by lifecycle tests.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn maybe_start_mcp_on_unlock(
    conn: &Connection,
    manager: &McpServerManager,
) -> Result<bool, String> {
    start_mcp_if_enabled(mcp_server_enabled(conn), manager).await
}

/// Shared start gate used by the unlock helper and the production spawn.
async fn start_mcp_if_enabled(enabled: bool, manager: &McpServerManager) -> Result<bool, String> {
    if enabled {
        manager.ensure_running().await?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Settings toggle hook. ON → `ensure_running`; OFF → `stop` (unlink +
/// abort live connections).
pub async fn on_mcp_feature_toggled(
    enabled: bool,
    manager: &McpServerManager,
) -> Result<(), String> {
    if enabled {
        manager.ensure_running().await
    } else {
        manager.stop().await
    }
}

/// Production toggle entry used by `set_ai_feature`. Awaits start/stop so
/// a bind failure surfaces on the Settings invoke.
pub async fn apply_mcp_feature_toggled<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    use tauri::Manager;
    let Some(manager) = app.try_state::<std::sync::Arc<McpServerManager>>() else {
        return Err("MCP server manager is not initialized".into());
    };
    on_mcp_feature_toggled(enabled, &manager).await
}

/// Production unlock entry. Reads `MCP_SERVER_ENABLED` from the already-
/// swapped vault and starts the manager when the setting is `"true"`.
/// Fire-and-forget so unlock is not blocked on bind.
pub fn spawn_maybe_start_mcp_on_unlock<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(manager) = app.try_state::<std::sync::Arc<McpServerManager>>() else {
        return;
    };
    let manager = std::sync::Arc::clone(&manager);
    let enabled = match app
        .state::<crate::AppState>()
        .with_conn(|conn| Ok(mcp_server_enabled(conn)))
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("mcp: could not read toggle on unlock: {e}");
            return;
        }
    };
    if !enabled {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = start_mcp_if_enabled(true, &manager).await {
            log::warn!("mcp: ensure_running on unlock failed: {e}");
        }
    });
}

/// Snapshot for the `mcp_status` command. `binary_path` is always
/// `std::env::current_exe()` — never a hardcoded `/Applications/…` path.
pub fn mcp_status_snapshot(manager: &McpServerManager) -> McpStatus {
    McpStatus {
        running: matches!(manager.state(), crate::mcp::server::ServerState::Running),
        socket_path: manager.socket_path().display().to_string(),
        binary_path: std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    }
}

/// IPC shape of `mcp_status`. Camel-cased for the frontend wrapper.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub socket_path: String,
    pub binary_path: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::mcp::server::ServerState;
    use crate::test_support::mock_app::mock_app;
    use crate::utils::encryption::{derive_encryption_key, SALT_SIZE};
    use crate::EncryptionKeyState;
    use std::path::PathBuf;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    fn temp_socket() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("mcp.sock");
        (dir, path)
    }

    fn manager_at(app: &tauri::App<tauri::test::MockRuntime>, path: PathBuf) -> McpServerManager {
        McpServerManager::with_socket_path(app.handle().clone(), path)
    }

    #[tokio::test]
    async fn enabling_mcp_server_starts_the_manager() {
        let app = mock_app();
        let (_dir, path) = temp_socket();
        let manager = manager_at(&app, path.clone());
        assert_eq!(manager.state(), ServerState::Stopped);

        on_mcp_feature_toggled(true, &manager)
            .await
            .expect("toggle ON must start");

        assert_eq!(manager.state(), ServerState::Running);
        assert!(
            path.exists(),
            "toggle ON must bind the socket at {}",
            path.display()
        );
        manager.stop().await.unwrap();
    }

    #[tokio::test]
    async fn disabling_mcp_server_stops_the_manager() {
        let app = mock_app();
        let (_dir, path) = temp_socket();
        let manager = manager_at(&app, path.clone());
        on_mcp_feature_toggled(true, &manager).await.unwrap();
        assert_eq!(manager.state(), ServerState::Running);

        on_mcp_feature_toggled(false, &manager)
            .await
            .expect("toggle OFF must stop");

        assert_eq!(manager.state(), ServerState::Stopped);
        assert!(
            !path.exists(),
            "toggle OFF must unlink the socket, {} still exists",
            path.display()
        );
    }

    #[tokio::test]
    async fn unlock_with_setting_true_calls_ensure_running() {
        let app = mock_app();
        let (_dir, path) = temp_socket();
        let manager = manager_at(&app, path.clone());
        let conn = setup_conn();
        db::set_setting(&conn, settings_keys::MCP_SERVER_ENABLED, "true").unwrap();

        let started = maybe_start_mcp_on_unlock(&conn, &manager)
            .await
            .expect("unlock start");

        assert!(started, "setting true must invoke ensure_running");
        assert_eq!(manager.state(), ServerState::Running);
        manager.stop().await.unwrap();
    }

    #[tokio::test]
    async fn unlock_with_setting_unset_or_false_does_not_start() {
        let app = mock_app();
        let (_dir, path) = temp_socket();
        let manager = manager_at(&app, path);
        let conn = setup_conn();

        let started = maybe_start_mcp_on_unlock(&conn, &manager).await.unwrap();
        assert!(!started, "unset toggle must not start");
        assert_eq!(manager.state(), ServerState::Stopped);

        db::set_setting(&conn, settings_keys::MCP_SERVER_ENABLED, "false").unwrap();
        let started = maybe_start_mcp_on_unlock(&conn, &manager).await.unwrap();
        assert!(!started, "false toggle must not start");
        assert_eq!(manager.state(), ServerState::Stopped);
    }

    #[tokio::test]
    async fn lock_does_not_stop_the_running_manager() {
        // Production lock_encryption only clear_key + emit app:locked.
        // There is no MCP stop on that path (Decision 3). This test is the
        // regression: after a start, simulating lock leaves the socket up.
        let app = mock_app();
        let (_dir, path) = temp_socket();
        let manager = manager_at(&app, path.clone());
        let conn = setup_conn();
        db::set_setting(&conn, settings_keys::MCP_SERVER_ENABLED, "true").unwrap();
        maybe_start_mcp_on_unlock(&conn, &manager).await.unwrap();
        assert_eq!(manager.state(), ServerState::Running);

        let ks = EncryptionKeyState::new();
        let key = derive_encryption_key("test-password-1234", &[9u8; SALT_SIZE]).unwrap();
        ks.set_key(key).unwrap();
        ks.clear_key().unwrap();

        assert_eq!(
            manager.state(),
            ServerState::Running,
            "lock (clear_key) must leave the MCP socket up"
        );
        assert!(
            path.exists(),
            "lock must not unlink the socket, {} missing",
            path.display()
        );
        manager.stop().await.unwrap();
    }

    #[tokio::test]
    async fn mcp_status_snapshot_uses_current_exe_and_manager_path() {
        let app = mock_app();
        let (_dir, path) = temp_socket();
        let manager = manager_at(&app, path.clone());

        let status = mcp_status_snapshot(&manager);
        assert!(!status.running, "fresh manager is stopped");
        assert_eq!(status.socket_path, path.display().to_string());
        let exe = std::env::current_exe().unwrap();
        assert_eq!(
            status.binary_path,
            exe.display().to_string(),
            "binaryPath must be current_exe, never a hardcoded /Applications path"
        );
        assert!(
            !status.binary_path.starts_with("/Applications/Memlore"),
            "must not hardcode the release .app path, got {}",
            status.binary_path
        );

        on_mcp_feature_toggled(true, &manager).await.unwrap();
        let running = mcp_status_snapshot(&manager);
        assert!(running.running);
        assert_eq!(running.socket_path, status.socket_path);
        assert_eq!(running.binary_path, status.binary_path);
        manager.stop().await.unwrap();
    }
}
