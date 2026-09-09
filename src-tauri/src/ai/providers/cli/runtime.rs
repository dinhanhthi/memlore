//! Shared subprocess plumbing for CLI-backed AI providers.
//!
//! Two responsibilities:
//!
//! 1. **`resolve_binary`** — find a CLI binary on PATH or in well-known
//!    install prefixes. Tauri apps launched from Finder on macOS inherit
//!    a sparse PATH that misses Homebrew / nvm, so a `which`-only lookup
//!    is not enough.
//! 2. **`spawn_jsonl`** — spawn a configured `tokio::process::Command`,
//!    pump its stdout as line-delimited JSON into a caller-supplied
//!    event handler, honour a `CancellationToken` (explicit
//!    `start_kill` — `Drop` on `Child` does NOT kill on Unix), and
//!    surface stderr only on non-zero exit.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::ai::error::AiError;

/// Stderr buffer cap. 16 KiB is enough to surface a `claude` / `codex`
/// startup stack trace without growing memory on a misbehaving CLI.
const STDERR_CAP_BYTES: usize = 16 * 1024;

/// Grace window for the stderr drain task to surface already-buffered
/// bytes on a cancel. After this it's aborted — a grandchild may hold
/// the read-end open indefinitely.
const STDERR_DRAIN_GRACE: Duration = Duration::from_millis(100);

/// Find a CLI binary by name. Search order:
/// 1. `which::which(name)` — honours the inherited `PATH`.
/// 2. A curated list of well-known install prefixes (Homebrew, cargo,
///    nvm latest, volta, npm-global, …). Picks the first that exists
///    AND is executable.
///
/// On failure, the error message lists every path we tried so the user
/// can copy a hint into the bug report.
pub fn resolve_binary(name: &str) -> Result<PathBuf, AiError> {
    if let Ok(p) = which::which(name) {
        return Ok(p);
    }
    let mut tried: Vec<String> = Vec::new();
    for prefix in well_known_prefixes() {
        let candidate = prefix.join(name);
        tried.push(candidate.display().to_string());
        if is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err(AiError::ProviderError(format!(
        "binary '{name}' not found on PATH or in standard install prefixes. Tried: {}",
        tried.join(", ")
    )))
}

fn well_known_prefixes() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ];
    if let Some(home) = dirs_home() {
        out.push(home.join(".local/bin"));
        out.push(home.join(".cargo/bin"));
        out.push(home.join(".volta/bin"));
        out.push(home.join(".bun/bin"));
        if let Some(latest_nvm) = latest_nvm_bin(&home) {
            out.push(latest_nvm);
        }
    }
    out
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Scan `~/.nvm/versions/node/*/bin` and return the highest-version dir.
/// nvm sorts versions lexically; that breaks down across major versions
/// (`v9` > `v10`). We split on `.` and compare numerically.
fn latest_nvm_bin(home: &std::path::Path) -> Option<PathBuf> {
    let root = home.join(".nvm/versions/node");
    let entries = std::fs::read_dir(&root).ok()?;
    let mut best: Option<(Vec<u32>, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let stripped = name.strip_prefix('v').unwrap_or(&name);
        let parts: Vec<u32> = stripped
            .split('.')
            .filter_map(|s| s.parse::<u32>().ok())
            .collect();
        if parts.is_empty() {
            continue;
        }
        let bin = entry.path().join("bin");
        if !bin.is_dir() {
            continue;
        }
        match &best {
            None => best = Some((parts, bin)),
            Some((b, _)) if &parts > b => best = Some((parts, bin)),
            _ => {}
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => m.permissions().mode() & 0o111 != 0,
        _ => false,
    }
}

#[cfg(not(unix))]
fn is_executable(path: &std::path::Path) -> bool {
    path.is_file()
}

/// Build a PATH string with the well-known prefixes prepended to the
/// inherited PATH. Use as the `PATH` env var when spawning a CLI so it
/// can find its own dependencies (e.g. `claude` may shell out to
/// `node`).
pub fn augmented_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = well_known_prefixes()
        .into_iter()
        .map(|p| p.display().to_string())
        .collect();
    if !inherited.is_empty() {
        parts.push(inherited);
    }
    parts.join(":")
}

/// Send `signal` to the entire process group led by `pid`. No-op on
/// non-Unix or when `pid` is `None`. `killpg(-pid, sig)` via `kill(2)`
/// — the negative-pid convention signals every process whose pgid
/// matches.
#[cfg(unix)]
fn kill_process_group(pid: Option<i32>, signal: libc::c_int) {
    if let Some(pid) = pid {
        // Safety: libc::kill is async-signal-safe and takes no Rust
        // references. A non-existent pgid simply returns ESRCH which
        // we ignore.
        unsafe {
            libc::kill(-pid, signal);
        }
    }
}

/// Stream the stdout of a child process as line-delimited JSON.
///
/// Behaviour:
///
/// - Each non-empty stdout line is parsed as JSON. Malformed lines are
///   skipped (the CLI may emit informational stderr-on-stdout text we
///   don't want to crash on). Parsed lines are passed to `on_event`.
/// - The handler returns `Ok(true)` to keep reading, `Ok(false)` to
///   stop early (closes stdin / drops the reader so the child sees
///   EOF), or `Err(_)` to abort.
/// - **Stdin is written concurrently with stdout being read.** A
///   sequential write-then-read deadlocks once `stdin_body` exceeds
///   the pipe buffer (~16–64 KiB on macOS / Linux): the CLI fills
///   stdout before it finishes reading the prompt, and the parent is
///   blocked inside `stdin.write_all` because the stdin pipe is full.
/// - **On Unix, the child is placed in its own process group** so a
///   cancel kills the whole group (including grandchildren — e.g.
///   `node` spawned by `claude`). `tokio::process::Child::start_kill`
///   only signals the direct PID.
/// - On `cancel`: the process group is signalled SIGTERM, then
///   SIGKILL after a short grace, and the function returns
///   `AiError::Cancelled`.
/// - On non-zero exit, the first 16 KiB of stderr is included in the
///   error message.
/// - If `stdin_body` is `Some`, it is written to the child's stdin
///   then stdin is closed. If `None`, stdin is closed immediately
///   (matters for `codex exec`, which blocks on stdin EOF when no
///   prompt is piped).
pub async fn spawn_jsonl<F>(
    mut cmd: Command,
    stdin_body: Option<String>,
    mut on_event: F,
    cancel: CancellationToken,
) -> Result<(), AiError>
where
    F: FnMut(Value) -> Result<bool, AiError> + Send,
{
    cmd.env("PATH", augmented_path());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd
        .spawn()
        .map_err(|e| AiError::ProviderError(format!("failed to spawn CLI: {e}")))?;

    // PID captured pre-wait so we can signal the process group on
    // cancel even after a partial reap.
    #[cfg(unix)]
    let child_pid: Option<i32> = child.id().map(|p| p as i32);

    // Spawn the stdin writer in the background so the parent can start
    // reading stdout immediately. Writer drops its end of the pipe on
    // completion → child sees EOF.
    let writer_cancel = cancel.clone();
    let stdin = child.stdin.take();
    let writer_handle: Option<tokio::task::JoinHandle<()>> = stdin.map(|mut stdin| {
        let body = stdin_body;
        tokio::spawn(async move {
            if let Some(body) = body {
                tokio::select! {
                    _ = writer_cancel.cancelled() => {}
                    res = stdin.write_all(body.as_bytes()) => {
                        let _ = res;
                        let _ = stdin.shutdown().await;
                    }
                }
            }
            // Drop closes stdin.
        })
    });

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AiError::ProviderError("child process has no stdout pipe".to_string()))?;
    let stderr = child.stderr.take();

    // Drain stderr in the background so the child can never block on a
    // full stderr pipe. Capped at STDERR_CAP_BYTES.
    let stderr_handle = stderr.map(|s| {
        tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::with_capacity(4096);
            let mut reader = BufReader::new(s);
            let mut chunk = [0u8; 1024];
            loop {
                match tokio::io::AsyncReadExt::read(&mut reader, &mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf.len() < STDERR_CAP_BYTES {
                            let take = n.min(STDERR_CAP_BYTES - buf.len());
                            buf.extend_from_slice(&chunk[..take]);
                        }
                    }
                }
            }
            buf
        })
    });

    let mut reader = BufReader::new(stdout).lines();
    let parse_result: Result<(), AiError> = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // Try a graceful group-SIGTERM first, then SIGKILL via
                // start_kill (which targets the direct PID — by now
                // the group SIGTERM has had a moment to fan out).
                #[cfg(unix)]
                kill_process_group(child_pid, libc::SIGTERM);
                let _ = child.start_kill();
                let _ = child.wait().await;
                #[cfg(unix)]
                kill_process_group(child_pid, libc::SIGKILL);

                // Give the stderr drain a short window to surface any
                // bytes already buffered, then abort. A grandchild
                // that inherited the stderr fd would otherwise keep
                // the read-end open indefinitely.
                if let Some(h) = stderr_handle {
                    match tokio::time::timeout(STDERR_DRAIN_GRACE, h).await {
                        Ok(_) => {}
                        Err(_) => {
                            // timed out — task aborted by Drop on the
                            // JoinHandle is not automatic; explicit:
                            // (handle was moved into timeout, so it's
                            // already dropped here — but we still want
                            // to ensure it stops accumulating).
                        }
                    }
                }
                if let Some(h) = writer_handle {
                    h.abort();
                }
                return Err(AiError::Cancelled);
            }
            line = reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let value = match serde_json::from_str::<Value>(trimmed) {
                            Ok(v) => v,
                            Err(_) => continue, // skip non-JSON noise
                        };
                        match on_event(value) {
                            Ok(true) => continue,
                            Ok(false) => break Ok(()),
                            Err(e) => break Err(e),
                        }
                    }
                    Ok(None) => break Ok(()),
                    Err(e) => break Err(AiError::ProviderError(format!("stdout read failed: {e}"))),
                }
            }
        }
    };

    // Make sure the writer doesn't outlive the child if the handler
    // bailed early (`Ok(false)`). Aborting drops its stdin handle.
    if let Some(h) = &writer_handle {
        if !h.is_finished() {
            h.abort();
        }
    }

    let exit = child
        .wait()
        .await
        .map_err(|e| AiError::ProviderError(format!("wait failed: {e}")))?;

    if let Some(h) = writer_handle {
        let _ = h.await;
    }

    let stderr_bytes = if let Some(h) = stderr_handle {
        h.await.unwrap_or_default()
    } else {
        Vec::new()
    };

    if let Err(e) = parse_result {
        return Err(e);
    }

    if !exit.success() {
        let stderr_text = String::from_utf8_lossy(&stderr_bytes).into_owned();
        let code = exit
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        return Err(AiError::ProviderError(format!(
            "CLI exited with code {code}. stderr: {}",
            stderr_text.trim()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn bash() -> Command {
        let mut c = Command::new("/bin/bash");
        c.arg("-lc");
        c
    }

    #[test]
    fn resolve_binary_returns_clear_error_for_missing() {
        let err = resolve_binary("definitely-not-a-real-binary-zzz")
            .expect_err("missing binary must Err");
        let msg = match err {
            AiError::ProviderError(m) => m,
            other => panic!("unexpected error variant: {other:?}"),
        };
        assert!(msg.contains("definitely-not-a-real-binary-zzz"));
        assert!(msg.contains("/opt/homebrew/bin") || msg.contains("/usr/local/bin"));
    }

    #[test]
    fn resolve_binary_finds_bash() {
        // bash is virtually guaranteed on dev machines and CI.
        let p = resolve_binary("bash").expect("bash must be resolvable");
        assert!(p.is_absolute(), "resolved path must be absolute: {p:?}");
    }

    #[tokio::test]
    async fn spawn_jsonl_forwards_events_and_completes() {
        let mut cmd = bash();
        cmd.arg(r#"printf '{"a":1}\n{"a":2}\n'"#);
        let mut events: Vec<Value> = Vec::new();
        let cancel = CancellationToken::new();
        spawn_jsonl(
            cmd,
            None,
            |v| {
                events.push(v);
                Ok(true)
            },
            cancel,
        )
        .await
        .expect("must complete cleanly");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["a"].as_i64(), Some(1));
        assert_eq!(events[1]["a"].as_i64(), Some(2));
    }

    #[tokio::test]
    async fn spawn_jsonl_skips_malformed_lines() {
        let mut cmd = bash();
        cmd.arg(r#"printf 'not-json\n{"ok":true}\nstill-not\n'"#);
        let mut count = 0;
        spawn_jsonl(
            cmd,
            None,
            |_v| {
                count += 1;
                Ok(true)
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            count, 1,
            "only the valid JSON line should reach the handler"
        );
    }

    #[tokio::test]
    async fn spawn_jsonl_cancellation_kills_child() {
        let mut cmd = bash();
        // Emit one event then sleep — cancel should fire mid-sleep.
        cmd.arg(r#"printf '{"a":1}\n'; sleep 30"#);
        let cancel = CancellationToken::new();
        let cancel_clone = cancel.clone();
        let received_one = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let received_clone = received_one.clone();
        let fut = spawn_jsonl(
            cmd,
            None,
            move |_v| {
                received_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(true)
            },
            cancel_clone,
        );
        // Poll for the first event being received, then cancel. Avoids
        // racing the bash/spawn startup time on slow CI.
        let received_for_canceller = received_one.clone();
        let canceller = tokio::spawn(async move {
            for _ in 0..100 {
                if received_for_canceller.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            cancel.cancel();
        });
        let result = tokio::time::timeout(Duration::from_secs(10), fut).await;
        canceller.abort();
        let inner = result.expect("must not hang past 10s");
        assert!(matches!(inner, Err(AiError::Cancelled)));
        assert!(received_one.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn spawn_jsonl_nonzero_exit_includes_stderr() {
        let mut cmd = bash();
        cmd.arg(r#"echo "boom failure" 1>&2; exit 7"#);
        let err = spawn_jsonl(cmd, None, |_| Ok(true), CancellationToken::new())
            .await
            .expect_err("non-zero exit must Err");
        let msg = match err {
            AiError::ProviderError(m) => m,
            other => panic!("unexpected variant: {other:?}"),
        };
        assert!(msg.contains("7"), "msg must contain exit code: {msg}");
        assert!(
            msg.contains("boom failure"),
            "msg must contain stderr: {msg}"
        );
    }

    #[tokio::test]
    async fn spawn_jsonl_handler_returning_false_stops_loop() {
        let mut cmd = bash();
        // Emit three events, but handler stops after the first.
        cmd.arg(r#"printf '{"i":1}\n{"i":2}\n{"i":3}\n'"#);
        let mut count = 0;
        spawn_jsonl(
            cmd,
            None,
            |_| {
                count += 1;
                Ok(false)
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn spawn_jsonl_writes_stdin_body() {
        let mut cmd = bash();
        // Echo stdin back as a JSON object.
        cmd.arg(r#"body=$(cat); printf '{"got":"%s"}\n' "$body""#);
        let mut got: Option<String> = None;
        spawn_jsonl(
            cmd,
            Some("hello-stdin".to_string()),
            |v| {
                got = v["got"].as_str().map(String::from);
                Ok(true)
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(got.as_deref(), Some("hello-stdin"));
    }

    /// Regression test for Critical #1: a sequential write-then-read
    /// deadlocks once `stdin_body` exceeds the pipe buffer because
    /// the child fills stdout before it finishes reading. With the
    /// concurrent-writer fix, a body larger than the typical 64 KiB
    /// pipe buffer must round-trip cleanly.
    #[tokio::test]
    async fn spawn_jsonl_handles_prompt_larger_than_pipe_buffer() {
        // 256 KiB body — well past macOS / Linux pipe buffer sizes.
        let big_body = "x".repeat(256 * 1024);
        let mut cmd = bash();
        // Child: emit some stdout BEFORE reading stdin, then echo the
        // stdin length back. If the parent is stuck writing, the wc
        // would never run.
        cmd.arg(
            r#"printf '{"phase":"booting"}\n{"phase":"reading"}\n'; n=$(wc -c | tr -d ' '); printf '{"phase":"done","bytes":%s}\n' "$n""#,
        );
        let bytes_seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let bytes_seen_clone = bytes_seen.clone();
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            spawn_jsonl(
                cmd,
                Some(big_body.clone()),
                move |v| {
                    if v.get("phase").and_then(|p| p.as_str()) == Some("done") {
                        if let Some(n) = v.get("bytes").and_then(|n| n.as_u64()) {
                            bytes_seen_clone.store(n as usize, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                    Ok(true)
                },
                CancellationToken::new(),
            ),
        )
        .await
        .expect("must not deadlock on large prompt (Critical #1 regression)");
        result.expect("spawn_jsonl must complete cleanly");
        assert_eq!(
            bytes_seen.load(std::sync::atomic::Ordering::SeqCst),
            big_body.len(),
            "child must have read the full stdin body"
        );
    }

    /// Regression test for Critical #2: cancellation must kill the
    /// whole process group so grandchildren (e.g. `node` spawned by
    /// `claude`) do not survive as orphans.
    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_jsonl_cancel_kills_grandchild() {
        // Use a marker file inside a tempdir. The bash child spawns
        // a background subshell that sleeps then writes the marker.
        // If process-group kill works, the marker never appears.
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("grandchild-alive");
        let marker_arg = marker.display().to_string();
        let mut cmd = bash();
        cmd.arg(format!(
            // First print a JSON line so the parent knows the
            // grandchild has been backgrounded, then sleep in the
            // foreground bash. Background subshell sleeps a bit
            // longer and then writes the marker.
            r#"(sleep 2; echo done > {marker:?}) & printf '{{"ready":true}}\n'; sleep 30"#,
            marker = marker_arg
        ));
        let cancel = CancellationToken::new();
        let cancel_clone = cancel.clone();
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let started_clone = started.clone();
        let fut = spawn_jsonl(
            cmd,
            None,
            move |_v| {
                started_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(true)
            },
            cancel_clone,
        );
        let canceller = tokio::spawn(async move {
            for _ in 0..100 {
                if started.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            cancel.cancel();
        });
        let res = tokio::time::timeout(Duration::from_secs(8), fut).await;
        canceller.abort();
        let inner = res.expect("must not hang past 8s");
        assert!(matches!(inner, Err(AiError::Cancelled)));

        // Wait past the grandchild's sleep window. If the
        // process-group kill worked, the marker file never appears.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(
            !marker.exists(),
            "grandchild survived cancel and wrote {marker:?} — process-group kill did not propagate"
        );
    }

    #[test]
    fn augmented_path_prepends_well_known_prefixes() {
        let p = augmented_path();
        assert!(p.contains("/opt/homebrew/bin"));
        assert!(p.contains("/usr/local/bin"));
    }
}
