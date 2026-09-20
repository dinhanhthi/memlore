//! Headless `--mcp-stdio` byte bridge.
//!
//! Connects stdin/stdout to the GUI process's MCP Unix socket. Does not
//! parse MCP, touch the Keychain, or start Tauri. `rmcp` is not a
//! dependency of this path.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;

/// Printed on stderr (never stdout) when the socket is missing or refuses.
pub const REFUSED_MESSAGE: &str = "Memlore is not running, has not been unlocked since launch, or the MCP server is off (Settings → AI → Features).";

/// Same formula as [`crate::mcp::server::default_socket_path`]:
/// `~/Library/Application Support/app.memlore/mcp.sock`.
pub fn socket_path() -> PathBuf {
    let home = std::env::var_os("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Application Support/app.memlore/mcp.sock")
}

/// Connect / copy failure. Always the refused message + exit code 1 —
/// the bridge cannot tell "app off" from "never unlocked" from "toggle off".
#[derive(Debug)]
pub struct BridgeError;

impl BridgeError {
    pub fn message(&self) -> &'static str {
        REFUSED_MESSAGE
    }

    /// Always 1. Observed by tests; `run()` / `lib.rs` call `process::exit(1)`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn exit_code(&self) -> ExitCode {
        ExitCode::from(1)
    }
}

pub fn connect(path: &Path) -> Result<UnixStream, BridgeError> {
    UnixStream::connect(path).map_err(|_| BridgeError)
}

/// Two blocking threads over a cloned `UnixStream`: stdin→socket and
/// socket→stdout. Returns when the socket hits EOF (GUI stopped or
/// peer closed) so `run()` can return without falling into Tauri.
pub(crate) fn copy_bidirectional(
    stream: UnixStream,
    mut input: impl Read + Send + 'static,
    mut output: impl Write,
) {
    let mut to_socket = stream.try_clone().expect("clone MCP socket for stdin copy");
    thread::spawn(move || {
        let _ = io::copy(&mut input, &mut to_socket);
        let _ = to_socket.shutdown(std::net::Shutdown::Write);
    });
    let mut from_socket = stream;
    let _ = io::copy(&mut from_socket, &mut output);
    let _ = output.flush();
}

/// Thin wrapper: copy on success; refuse on stderr + `exit(1)`.
/// Tests call [`connect`] / [`BridgeError`] so they never kill the harness.
pub fn run() {
    match connect(&socket_path()) {
        Ok(stream) => copy_bidirectional(stream, io::stdin(), io::stdout()),
        Err(err) => {
            eprintln!("{}", err.message());
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::server::default_socket_path;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::process::ExitCode;
    use std::thread;

    #[test]
    fn socket_path_matches_default_socket_path_under_home() {
        let home = std::env::var_os("HOME").unwrap_or_default();
        let expected = PathBuf::from(home).join("Library/Application Support/app.memlore/mcp.sock");
        assert_eq!(
            socket_path(),
            expected,
            "bridge socket must resolve from $HOME the same way production does"
        );
        assert_eq!(
            socket_path(),
            default_socket_path(),
            "bridge and server must share one socket path"
        );
    }

    #[test]
    fn refused_connection_returns_exact_message_and_exit_code_1() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("mcp.sock");
        let stale = UnixListener::bind(&path).expect("bind stale socket");
        drop(stale);

        let err = connect(&path).expect_err("stale socket must be an error path");
        assert_eq!(
            err.message(),
            "Memlore is not running, has not been unlocked since launch, or the MCP server is off (Settings → AI → Features)."
        );
        assert_eq!(err.exit_code(), ExitCode::from(1));
    }

    #[test]
    fn missing_socket_is_the_same_unavailable_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("missing.sock");

        let err = connect(&path).expect_err("missing socket must be an error path");
        assert_eq!(
            err.message(),
            "Memlore is not running, has not been unlocked since launch, or the MCP server is off (Settings → AI → Features)."
        );
        assert_eq!(err.exit_code(), ExitCode::from(1));
    }

    #[test]
    fn copies_bytes_both_ways_until_peer_eof() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("mcp.sock");
        let listener = UnixListener::bind(&path).expect("bind echo socket");

        let server = thread::spawn(move || {
            let (mut peer, _) = listener.accept().expect("accept");
            let mut buf = Vec::new();
            peer.read_to_end(&mut buf).expect("read client");
            peer.write_all(b"pong:").expect("write prefix");
            peer.write_all(&buf).expect("echo");
        });

        let stream = connect(&path).expect("live socket must connect");
        let mut output = Vec::new();
        copy_bidirectional(stream, &b"ping"[..], &mut output);
        server.join().expect("echo thread");
        assert_eq!(output, b"pong:ping");
    }
}
