//! Unix-socket MCP server lifecycle (`McpServerManager`).
//!
//! Binds `mcp.sock`, accepts connections, serves `McpTools` per client.
//! Started/stopped by `mcp::lifecycle` (toggle + unlock + app exit).
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener as StdUnixListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;

use tokio::net::UnixListener;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::tools::McpTools;
use rmcp::ServiceExt;

/// macOS `sockaddr_un.sun_path` is 104 bytes (including the trailing NUL
/// that `bind(2)` writes). A very long `$HOME` overflows this and must fail
/// with a readable error rather than `EINVAL`.
const DARWIN_SUN_PATH: usize = 104;

/// Production socket: `~/Library/Application Support/app.memlore/mcp.sock`.
/// Tests MUST bind a temp-dir path via [`McpServerManager::with_socket_path`].
pub fn default_socket_path() -> PathBuf {
    let home = std::env::var_os("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Application Support/app.memlore/mcp.sock")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerState {
    Stopped,
    Running,
    Failed { message: String },
}

struct Inner {
    state: ServerState,
    cancel: Option<CancellationToken>,
    accept_task: Option<tokio::task::JoinHandle<()>>,
}

/// Owns the MCP Unix-socket listener. Modelled on `LlamaServerManager`:
/// `Stopped → Running | Failed`, `ensure_running()`, `stop()`.
///
/// Held in Tauri managed state as `Arc<McpServerManager>`. All methods
/// are concurrency-safe; the `std` mutex is never held across `.await`.
pub struct McpServerManager {
    /// Cloned into each accepted connection so the accept loop can call
    /// `handler.serve((read_half, write_half))` — never `()`. `()` is the
    /// rmcp client idiom and would serve an empty tool list.
    handler: McpTools,
    socket_path: PathBuf,
    inner: StdMutex<Inner>,
}

impl McpServerManager {
    /// Production constructor: socket at [`default_socket_path`].
    pub fn new(app: tauri::AppHandle) -> Self {
        Self::with_handler(McpTools::new(app), default_socket_path())
    }

    /// Test constructor. Binds a caller-supplied temp-dir socket so unit
    /// tests never touch the real user path. Uses `mock_app`'s handle.
    #[cfg(test)]
    pub fn with_socket_path(
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        socket_path: PathBuf,
    ) -> Self {
        Self::with_handler(McpTools::new_mock(app), socket_path)
    }

    fn with_handler(handler: McpTools, socket_path: PathBuf) -> Self {
        Self {
            handler,
            socket_path,
            inner: StdMutex::new(Inner {
                state: ServerState::Stopped,
                cancel: None,
                accept_task: None,
            }),
        }
    }

    pub fn state(&self) -> ServerState {
        self.inner.lock().unwrap().state.clone()
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub async fn ensure_running(&self) -> Result<(), String> {
        {
            let inner = self.inner.lock().unwrap();
            if matches!(inner.state, ServerState::Running) {
                return Ok(());
            }
        }

        match self.bind_and_spawn() {
            Ok((cancel, accept_task)) => {
                let mut inner = self.inner.lock().unwrap();
                inner.state = ServerState::Running;
                inner.cancel = Some(cancel);
                inner.accept_task = Some(accept_task);
                Ok(())
            }
            Err(e) => {
                let mut inner = self.inner.lock().unwrap();
                inner.state = ServerState::Failed { message: e.clone() };
                inner.cancel = None;
                inner.accept_task = None;
                Err(e)
            }
        }
    }

    /// Sync teardown for app-exit (`RunEvent::ExitRequested`). Cancels,
    /// aborts connection tasks, and unlinks the socket without awaiting
    /// — same guarantee as [`stop`], safe on the main-thread exit hook.
    pub fn stop_sync(&self) {
        let (cancel, accept_task) = self.take_for_stop();
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        if let Some(accept_task) = accept_task {
            accept_task.abort();
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }

    pub async fn stop(&self) -> Result<(), String> {
        let (cancel, accept_task) = self.take_for_stop();
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        if let Some(accept_task) = accept_task {
            accept_task.abort();
            let _ = accept_task.await;
        }
        let _ = std::fs::remove_file(&self.socket_path);
        Ok(())
    }

    fn take_for_stop(
        &self,
    ) -> (
        Option<CancellationToken>,
        Option<tokio::task::JoinHandle<()>>,
    ) {
        let mut inner = self.inner.lock().unwrap();
        let cancel = inner.cancel.take();
        let accept_task = inner.accept_task.take();
        inner.state = ServerState::Stopped;
        (cancel, accept_task)
    }

    fn bind_and_spawn(&self) -> Result<(CancellationToken, tokio::task::JoinHandle<()>), String> {
        check_socket_path_len(&self.socket_path)?;
        prepare_parent_dir(&self.socket_path)?;
        reclaim_stale_socket(&self.socket_path)?;

        let std_listener = bind_with_umask(&self.socket_path)?;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("MCP socket set_nonblocking failed: {e}"))?;
        let listener = UnixListener::from_std(std_listener)
            .map_err(|e| format!("MCP socket tokio wrap failed: {e}"))?;

        let cancel = CancellationToken::new();
        let child = cancel.clone();
        let handler = self.handler.clone();
        let handle = tokio::spawn(accept_loop(listener, handler, child));
        Ok((cancel, handle))
    }
}

fn check_socket_path_len(path: &Path) -> Result<(), String> {
    let bytes = path.as_os_str().as_encoded_bytes();
    // Need room for the trailing NUL inside `sun_path[104]`.
    if bytes.len() + 1 > DARWIN_SUN_PATH {
        return Err(format!(
            "MCP socket path is too long for macOS ({} bytes; sockaddr_un.sun_path is {DARWIN_SUN_PATH} including NUL): {}",
            bytes.len(),
            path.display()
        ));
    }
    Ok(())
}

fn prepare_parent_dir(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "MCP socket path has no parent directory: {}",
            path.display()
        )
    })?;
    std::fs::create_dir_all(parent).map_err(|e| {
        format!(
            "cannot create MCP socket directory {}: {e}",
            parent.display()
        )
    })?;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(|e| {
        format!(
            "cannot set MCP socket directory {} to 0700: {e}",
            parent.display()
        )
    })?;
    Ok(())
}

/// Connect-probe first. `ECONNREFUSED` means a leftover file from a dead
/// process — unlink and continue. A successful connect means another
/// instance owns the socket; refusing to start is correct.
///
/// Same-user socket squatting between this unlink and the subsequent
/// `bind` is out of the threat model (README Risk 6): any process running
/// as the user can already read the journal through the socket.
fn reclaim_stale_socket(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    match std::os::unix::net::UnixStream::connect(path) {
        Ok(_) => Err(format!(
            "MCP socket already in use by another instance: {}",
            path.display()
        )),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
            std::fs::remove_file(path)
                .map_err(|e| format!("cannot unlink stale MCP socket {}: {e}", path.display()))?;
            Ok(())
        }
        Err(e) => Err(format!("cannot probe MCP socket {}: {e}", path.display())),
    }
}

/// Serializes the process-global `umask` dance. Two concurrent binds
/// that each save+restore would otherwise leave the process mask stuck
/// at 0177 (the second save captures 0177 as "previous").
static BIND_UMASK_LOCK: StdMutex<()> = StdMutex::new(());

/// Bind with `umask(0177)` so the socket inode is created at `0600`.
/// AF_UNIX `bind` uses mode `0777 & ~umask` (not `0666` like a regular
/// file), so `umask(077)` would land on `0700`. Do **not** chmod after
/// bind — that leaves a window at the umask-derived mode (typically
/// `srwxr-xr-x`).
fn bind_with_umask(path: &Path) -> Result<StdUnixListener, String> {
    let _guard = BIND_UMASK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: `umask` is process-global. The mutex makes save+bind+
    // restore atomic w.r.t. other MCP binds so the process mask cannot
    // get stuck at 0177. Other threads may still observe 0177 for one
    // syscall; same-user squatting in that window is out of the threat
    // model (README Risk 6).
    let prev = unsafe { libc::umask(0o177) };
    let result = StdUnixListener::bind(path);
    unsafe { libc::umask(prev) };
    result.map_err(|e| format!("cannot bind MCP socket {}: {e}", path.display()))
}

async fn accept_loop(listener: UnixListener, handler: McpTools, cancel: CancellationToken) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let (read_half, write_half) = stream.into_split();
                        let handler = handler.clone();
                        let child = cancel.child_token();
                        connections.spawn(async move {
                            tokio::select! {
                                _ = child.cancelled() => {}
                                _result = async {
                                    // Per-connection handler. Do not pass `()` —
                                    // that is the rmcp *client* idiom and serves
                                    // zero tools.
                                    match handler.serve((read_half, write_half)).await {
                                        Ok(running) => {
                                            let _ = running.waiting().await;
                                        }
                                        Err(e) => {
                                            log::warn!("mcp connection ended: {e}");
                                        }
                                    }
                                } => {}
                            }
                        });
                    }
                    Err(e) => {
                        if cancel.is_cancelled() {
                            break;
                        }
                        log::warn!("mcp accept error: {e}");
                    }
                }
            }
        }
    }
    connections.abort_all();
}

impl Drop for McpServerManager {
    fn drop(&mut self) {
        self.stop_sync();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::mock_app::mock_app;
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    const EXPECTED_TOOLS: [&str; 6] = [
        "append_to_entry",
        "create_entry",
        "get_entry",
        "list_journals",
        "search_entries",
        "set_entry_metadata",
    ];

    fn temp_socket() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("mcp.sock");
        (dir, path)
    }

    async fn start_manager(
        app: &tauri::App<tauri::test::MockRuntime>,
        path: PathBuf,
    ) -> McpServerManager {
        let manager = McpServerManager::with_socket_path(app.handle().clone(), path);
        manager
            .ensure_running()
            .await
            .expect("ensure_running should bind the temp socket");
        assert_eq!(manager.state(), ServerState::Running);
        manager
    }

    async fn write_rpc(writer: &mut (impl AsyncWriteExt + Unpin), value: &serde_json::Value) {
        let mut line = serde_json::to_string(value).expect("serialize rpc");
        line.push('\n');
        writer.write_all(line.as_bytes()).await.expect("write rpc");
        writer.flush().await.expect("flush rpc");
    }

    async fn read_rpc_line(
        reader: &mut BufReader<impl tokio::io::AsyncRead + Unpin>,
    ) -> serde_json::Value {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.expect("read rpc line");
        assert!(n > 0, "server closed the connection before a response");
        serde_json::from_str(line.trim()).unwrap_or_else(|e| {
            panic!("rpc response is not JSON ({e}): {line:?}");
        })
    }

    async fn initialize_and_list_tools(
        path: &Path,
    ) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        let stream = tokio::net::UnixStream::connect(path).await?;
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);

        write_rpc(
            &mut writer,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "memlore-test", "version": "0.0.1" }
                }
            }),
        )
        .await;
        let init = read_rpc_line(&mut reader).await;
        assert_eq!(init["jsonrpc"], "2.0", "initialize must be JSON-RPC");
        assert!(
            init.get("result").is_some(),
            "initialize must succeed, got {init}"
        );

        write_rpc(
            &mut writer,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            }),
        )
        .await;

        write_rpc(
            &mut writer,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            }),
        )
        .await;
        let listed = read_rpc_line(&mut reader).await;
        let tools = listed["result"]["tools"]
            .as_array()
            .ok_or_else(|| format!("tools/list missing result.tools: {listed}"))?;
        Ok(tools
            .iter()
            .map(|t| t["name"].as_str().unwrap_or("").to_string())
            .collect())
    }

    #[tokio::test]
    async fn initialize_and_tools_list_returns_exactly_the_six_named_tools() {
        let app = mock_app();
        let (_dir, path) = temp_socket();
        let manager = start_manager(&app, path.clone()).await;

        let names = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            initialize_and_list_tools(&path),
        )
        .await
        .expect("round-trip timed out")
        .expect("initialize + tools/list");

        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(
            sorted, EXPECTED_TOOLS,
            "tools/list must return exactly the 6 named tools, got {names:?}"
        );

        manager.stop().await.unwrap();
    }

    #[tokio::test]
    async fn dead_socket_file_is_reclaimed() {
        let app = mock_app();
        let (_dir, path) = temp_socket();

        // Leftover inode with no listener — connect must get ECONNREFUSED.
        let stale = StdUnixListener::bind(&path).expect("bind stale");
        drop(stale);
        assert!(path.exists(), "dropped listener must leave the socket file");
        let probe = std::os::unix::net::UnixStream::connect(&path);
        assert!(
            matches!(
                probe.as_ref().map_err(|e| e.kind()),
                Err(std::io::ErrorKind::ConnectionRefused)
            ),
            "stale socket must refuse connect, got {probe:?}"
        );

        let manager = start_manager(&app, path.clone()).await;
        assert!(path.exists(), "reclaimed bind must recreate the socket");
        manager.stop().await.unwrap();
    }

    #[tokio::test]
    async fn live_socket_is_refused() {
        let app = mock_app();
        let (_dir, path) = temp_socket();

        let _live = StdUnixListener::bind(&path).expect("bind live owner");
        // The live listener accepts the connect-probe so the file is owned.
        let manager = McpServerManager::with_socket_path(app.handle().clone(), path);
        let err = manager
            .ensure_running()
            .await
            .expect_err("must refuse a live socket");
        assert!(
            err.contains("already in use") || err.contains("another instance"),
            "refuse-live error should name the conflict, got {err}"
        );
        assert!(
            matches!(manager.state(), ServerState::Failed { .. }),
            "state should be Failed, got {:?}",
            manager.state()
        );
    }

    #[tokio::test]
    async fn bound_socket_mode_is_0600() {
        let app = mock_app();
        let (_dir, path) = temp_socket();
        let manager = start_manager(&app, path.clone()).await;

        let mode = std::fs::metadata(&path)
            .expect("socket metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "bound socket must be 0600, got {mode:o}");

        manager.stop().await.unwrap();
    }

    #[tokio::test]
    async fn stop_unlinks_socket_and_tears_down_accepted_connection() {
        let app = mock_app();
        let (_dir, path) = temp_socket();
        let manager = start_manager(&app, path.clone()).await;

        let mut stream = tokio::net::UnixStream::connect(&path)
            .await
            .expect("connect before stop");
        write_rpc(
            &mut stream,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "memlore-test", "version": "0.0.1" }
                }
            }),
        )
        .await;
        let mut reader = BufReader::new(&mut stream);
        let init = read_rpc_line(&mut reader).await;
        assert!(
            init.get("result").is_some(),
            "connection must be accepted before stop, got {init}"
        );
        drop(reader);

        manager.stop().await.unwrap();
        assert!(
            !path.exists(),
            "stop() must unlink the socket, {} still exists",
            path.display()
        );
        assert_eq!(manager.state(), ServerState::Stopped);

        let mut buf = [0u8; 8];
        let read = tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buf))
            .await
            .expect("orphaned connection would hang; stop() must tear it down");
        assert!(
            matches!(read, Ok(0) | Err(_)),
            "accepted connection must be closed, got {read:?}"
        );
    }

    #[test]
    fn default_socket_path_is_app_support_mcp_sock() {
        let path = default_socket_path();
        let home = std::env::var_os("HOME").unwrap_or_default();
        let expected = PathBuf::from(home).join("Library/Application Support/app.memlore/mcp.sock");
        assert_eq!(path, expected);
    }

    #[test]
    fn rejects_socket_path_longer_than_darwin_sun_path() {
        let too_long = PathBuf::from(format!("/{}", "a".repeat(DARWIN_SUN_PATH)));
        let err = check_socket_path_len(&too_long).expect_err("must reject overflow");
        assert!(
            err.contains("too long"),
            "error must be readable, got {err}"
        );
    }
}
