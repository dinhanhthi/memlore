//! Generic verified HTTP downloader for the on-device LLM feature
//! (Phase 2 Task 1).
//!
//! Streaming, SHA-256-verified, resumable, cancellable download of a single
//! HTTP resource into a final path. Used by the on-device LLM asset manager
//! to fetch both the `llama-server` sidecar binary and GGUF model files —
//! both are JIT-downloaded, pinned-version, SHA-256-verified assets that
//! never ship with the installer.
//!
//! The downloader never writes to the final `dest_path` until the SHA-256 of
//! the fully-received bytes matches `expected_sha256`. Until then it works on
//! a `{dest_path}.part` temp file, which also doubles as the resume point for
//! interrupted downloads (HTTP `Range`).

use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// Error from [`download_verified`]. Carries a short stable `code()` for the
/// command layer / UI; the `Display` impl is for logs.
#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    /// Non-2xx HTTP status, or a status the downloader can't resume from.
    #[error("download_http_{status}")]
    Http { status: u16 },

    /// Underlying filesystem / network IO failure.
    #[error("download_io: {0}")]
    Io(String),

    /// Received bytes' SHA-256 did not match the pinned expected digest.
    #[error("download_sha256_mismatch: expected {expected}, actual {actual}")]
    Sha256Mismatch { expected: String, actual: String },

    /// Cancelled via the injected [`CancellationToken`]. The `.part` file has
    /// already been deleted.
    #[error("download_cancelled")]
    Cancelled,

    /// Received byte count did not match the pinned expected size.
    #[error("download_size_mismatch: expected {expected}, actual {actual}")]
    SizeMismatch { expected: u64, actual: u64 },
}

impl DownloadError {
    /// Stable short error code surfaced to the UI / telemetry. Stable across
    /// releases — do NOT change these strings.
    pub fn code(&self) -> &'static str {
        match self {
            DownloadError::Http { .. } => "download_http",
            DownloadError::Io(_) => "download_io",
            DownloadError::Sha256Mismatch { .. } => "download_sha256_mismatch",
            DownloadError::Cancelled => "download_cancelled",
            DownloadError::SizeMismatch { .. } => "download_size_mismatch",
        }
    }
}

/// Download `url` into `dest_path`, streaming to a `.part` file, resuming from
/// any partial `.part`, verifying SHA-256 + exact size, then atomically
/// renaming `.part` → `dest_path`.
///
/// See the module docs for the full contract. `progress(pct)` is called only
/// on whole-percent changes (0..=100). `cancel` aborts the in-flight stream,
/// deletes the `.part` file, and returns [`DownloadError::Cancelled`].
///
/// Short-circuit: if `dest_path` already exists and its size equals
/// `expected_size`, returns `Ok(())` immediately.
///
/// This wrapper keeps the original signature so LLM callers
/// (`llm_download.rs`) do not change. Callers that need `{downloaded, total}`
/// byte ticks (basemap) should use [`download_verified_with_bytes`].
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    dest_path: &Path,
    expected_sha256: &str,
    expected_size: u64,
    progress: &(impl Fn(u8) + Send + Sync),
    cancel: &CancellationToken,
) -> Result<(), DownloadError> {
    download_verified_inner(
        client,
        url,
        dest_path,
        expected_sha256,
        expected_size,
        progress,
        None,
        cancel,
    )
    .await
}

/// Same as [`download_verified`], plus `bytes_progress(downloaded, total)` on
/// every accepted chunk (and the initial 0-byte tick) so callers can emit
/// absolute byte counts rather than whole-percent only.
pub async fn download_verified_with_bytes(
    client: &reqwest::Client,
    url: &str,
    dest_path: &Path,
    expected_sha256: &str,
    expected_size: u64,
    progress: &(impl Fn(u8) + Send + Sync),
    bytes_progress: &(dyn Fn(u64, u64) + Send + Sync),
    cancel: &CancellationToken,
) -> Result<(), DownloadError> {
    download_verified_inner(
        client,
        url,
        dest_path,
        expected_sha256,
        expected_size,
        progress,
        Some(bytes_progress),
        cancel,
    )
    .await
}

async fn download_verified_inner(
    client: &reqwest::Client,
    url: &str,
    dest_path: &Path,
    expected_sha256: &str,
    expected_size: u64,
    progress: &(impl Fn(u8) + Send + Sync),
    bytes_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
    cancel: &CancellationToken,
) -> Result<(), DownloadError> {
    // 0. Cheap short-circuit: final file already present + correct size.
    // The asset manager writes a ready marker alongside, so a correct-size
    // final file is already trusted from a prior verified run — re-hashing
    // a multi-GB GGUF on every startup would defeat the ready-marker design.
    if let Ok(meta) = tokio::fs::metadata(dest_path).await {
        if meta.len() == expected_size {
            return Ok(());
        }
    }

    let part_path = part_path(dest_path);
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| DownloadError::Io(e.to_string()))?;
    }

    // 1. Resume probe: existing `.part` length drives the Range request.
    let existing_len = tokio::fs::metadata(&part_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let mut request = client.get(url);
    if existing_len > 0 {
        request = request.header("Range", format!("bytes={existing_len}-"));
    }
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(DownloadError::Cancelled);
        }
        result = request.send() => {
            result.map_err(|e| DownloadError::Io(e.to_string()))?
        }
    };

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(DownloadError::Http { status });
    }

    // 2. Decide resume-vs-restart from whether the server honoured Range.
    //    206 → append to existing `.part`. 200 (or anything else 2xx) → the
    //    server ignored Range (or there was nothing to resume): truncate and
    //    start over. We do not trust a 206 without a usable Content-Range,
    //    but reqwest already validated the response, so we keep this simple.
    let append_to_existing = status == 206 && existing_len > 0;

    let mut file: tokio::fs::File = if append_to_existing {
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part_path)
            .await
            .map_err(|e| DownloadError::Io(e.to_string()))?
    } else {
        tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&part_path)
            .await
            .map_err(|e| DownloadError::Io(e.to_string()))?
    };

    // 3. Incremental SHA-256. When resuming, the first `existing_len` bytes
    //    are already on disk but NOT in the hasher — re-seed it by reading
    //    the `.part` prefix back. Cheaper than re-downloading; the only
    //    correct option for a streaming hash of the full file.
    let mut hasher = Sha256::new();
    let start_len = if append_to_existing {
        rehash_prefix(&mut hasher, &part_path, existing_len).await?;
        existing_len
    } else {
        0
    };

    // 4. Stream + throttled progress + cancel. `bytes_stream()` yields owned
    //    `Bytes`; we write each, fold into the hasher, and tick progress only
    //    on whole-percent changes.
    let mut total_bytes = start_len;
    let mut last_pct = percent_of(total_bytes, expected_size);
    progress(last_pct);
    if let Some(bp) = bytes_progress {
        bp(total_bytes, expected_size);
    }

    let mut stream = response.bytes_stream();
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                drop(file);
                let _ = tokio::fs::remove_file(&part_path).await;
                return Err(DownloadError::Cancelled);
            }
            chunk = stream.next() => {
                match chunk {
                    None => break,
                    Some(Err(e)) => {
                        drop(file);
                        return Err(DownloadError::Io(e.to_string()));
                    }
                    Some(Ok(bytes)) => {
                        file.write_all(&bytes)
                            .await
                            .map_err(|e| DownloadError::Io(e.to_string()))?;
                        hasher.update(&bytes);
                        total_bytes += bytes.len() as u64;
                        if let Some(bp) = bytes_progress {
                            bp(total_bytes, expected_size);
                        }
                        let pct = percent_of(total_bytes, expected_size);
                        if pct != last_pct {
                            last_pct = pct;
                            progress(pct);
                        }
                    }
                }
            }
        }
    }

    file.flush()
        .await
        .map_err(|e| DownloadError::Io(e.to_string()))?;
    drop(file);

    // 5. Verify size (cheaper than finalizing the hash, and a clean signal).
    //    `expected_size == 0` is the "no pinned size" sentinel: the caller has
    //    only a SHA-256 to verify against (e.g. the server-binary archive,
    //    whose byte size isn't pinned in the catalog). Skip the size check in
    //    that case and let the SHA-256 below be the authoritative guard —
    //    otherwise a real download (actual > 0) would always mismatch 0.
    if expected_size != 0 && total_bytes != expected_size {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(DownloadError::SizeMismatch {
            expected: expected_size,
            actual: total_bytes,
        });
    }

    // 6. Verify SHA-256. On mismatch, drop BOTH the `.part` and any stale
    //    final file so the next attempt isn't short-circuited by a
    //    wrong-size-but-present file.
    let actual_digest = hex::encode(hasher.finalize());
    if actual_digest != expected_sha256 {
        let _ = tokio::fs::remove_file(&part_path).await;
        let _ = tokio::fs::remove_file(dest_path).await;
        return Err(DownloadError::Sha256Mismatch {
            expected: expected_sha256.to_string(),
            actual: actual_digest,
        });
    }

    // 7. Final 100% tick (rounding may never reach it) + atomic rename.
    if last_pct != 100 {
        progress(100);
    }
    if let Some(bp) = bytes_progress {
        bp(total_bytes, expected_size);
    }
    tokio::fs::rename(&part_path, dest_path)
        .await
        .map_err(|e| DownloadError::Io(e.to_string()))?;

    Ok(())
}

/// Whole-percent of `bytes` over `total`, clamped to 100. `total == 0` reads
/// as 100 (a zero-byte asset is trivially complete).
fn percent_of(bytes: u64, total: u64) -> u8 {
    if total == 0 {
        return 100;
    }
    ((bytes * 100 / total).min(100)) as u8
}

/// Read the first `len` bytes of `path` back through `hasher` so the resumed
/// download's hash covers the whole file, not just the freshly-downloaded
/// tail. Used only on the 206-resume path.
async fn rehash_prefix(hasher: &mut Sha256, path: &Path, len: u64) -> Result<(), DownloadError> {
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| DownloadError::Io(e.to_string()))?;
    let mut remaining = len;
    let mut buf = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = f
            .read_exact(&mut buf[..want])
            .await
            .map_err(|e| DownloadError::Io(e.to_string()))?;
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(())
}

/// `{dest}.part` — the temp/resume file. Kept here so callers never hand-
/// construct the suffix inconsistently. `pub(crate)` so the LLM asset
/// manager's on-disk progress poller (`llm_download::model_on_disk_bytes`)
/// can read the same `.part` path this module streams into, without
/// duplicating the suffix convention.
pub(crate) fn part_path(dest_path: &Path) -> PathBuf {
    let mut s = dest_path.as_os_str().to_owned();
    s.push(".part");
    s.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_util::sync::CancellationToken;

    /// Shared buffer of observed whole-percent progress ticks.
    type ProgressBuf = std::sync::Arc<Mutex<Vec<u8>>>;

    /// Build a fresh reqwest client with no redirect following (so the 3xx
    /// `Http` test exercises the literal status, not a redirect chase).
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        hex::encode(h.finalize())
    }

    /// Collect progress ticks into a Vec behind a Mutex (the closure must be
    /// `Fn`, captured by reference — Mutex gives us interior mutability).
    /// Returns the buffer and an `Arc<{closure}>` (concrete, `Sized`) so the
    /// `download_verified` `impl Fn` param accepts `&*pf`. The tuple return
    /// trips `type_complexity` (the closure type is unnamed); the lint is
    /// local to this test helper, hence the allow.
    #[allow(clippy::type_complexity)]
    fn progress_sink() -> (ProgressBuf, std::sync::Arc<impl Fn(u8) + Send + Sync>) {
        let v: ProgressBuf = std::sync::Arc::new(Mutex::new(Vec::new()));
        let cb = {
            let v = v.clone();
            move |p: u8| v.lock().unwrap().push(p)
        };
        (v, std::sync::Arc::new(cb))
    }

    // ─── Hand-rolled HTTP/1.1 server for streaming tests ──────────────────
    // wiremock's ResponseTemplate only supports a single whole-body delay, so
    // for the cancel-mid-stream and progress-throttle tests (which need a
    // drip of multiple chunks with delays between them) we serve raw HTTP/1.1
    // from a tiny TcpListener. This is the spec's zero-extra-dep fallback.

    /// Read the request line + headers from `rx` until an empty line, so the
    /// connection is positioned at the request body (we don't send one).
    async fn drain_request(rx: &mut tokio::net::TcpStream) -> std::io::Result<()> {
        let mut buf = [0u8; 1024];
        // Read until we see "\r\n\r\n".
        let mut seen = Vec::new();
        loop {
            let n = rx.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            seen.extend_from_slice(&buf[..n]);
            if seen.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            if seen.len() > 8192 {
                break;
            }
        }
        Ok(())
    }

    /// Spawn a hand-rolled HTTP/1.1 server that serves `body` as a single
    /// chunked-transfer response, with `chunk_delay` between each `chunk_size`
    /// slice of bytes. Honours an inbound `Range` request header by replying
    /// 206 (slicing the body) when `honour_range` is true, else ignores Range
    /// and replies 200 with the full body. Returns the server's base URL.
    async fn chunked_server(
        body: Vec<u8>,
        chunk_size: usize,
        chunk_delay: std::time::Duration,
        honour_range: bool,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let body = body.clone();
                tokio::spawn(async move {
                    let _ = drain_request(&mut sock).await;
                    // We don't parse the Range header precisely here — the
                    // honour_range flag is the test knob. For 206 we just
                    // pretend the range started at 0 (the cancel/progress
                    // tests don't depend on a real byte offset).
                    let (status_line, extra_hdr) = if honour_range {
                        (
                            "HTTP/1.1 206 Partial Content\r\n",
                            format!(
                                "Content-Range: bytes 0-{}/{}\r\n",
                                body.len().saturating_sub(1),
                                body.len()
                            ),
                        )
                    } else {
                        ("HTTP/1.1 200 OK\r\n", String::new())
                    };
                    let head = format!(
                        "{status_line}\
                         Server: test-stream\r\n\
                         {extra_hdr}\
                         Transfer-Encoding: chunked\r\n\
                         Connection: close\r\n\
                         \r\n",
                    );
                    if sock.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    let mut off = 0;
                    while off < body.len() {
                        let end = (off + chunk_size).min(body.len());
                        let chunk = &body[off..end];
                        let hdr = format!("{:X}\r\n", chunk.len());
                        if sock.write_all(hdr.as_bytes()).await.is_err() {
                            return;
                        }
                        if sock.write_all(chunk).await.is_err() {
                            return;
                        }
                        if sock.write_all(b"\r\n").await.is_err() {
                            return;
                        }
                        off = end;
                        tokio::time::sleep(chunk_delay).await;
                    }
                    let _ = sock.write_all(b"0\r\n\r\n").await;
                });
            }
        });
        format!("http://{addr}/")
    }

    // ─── 1. happy path ────────────────────────────────────────────────────

    #[tokio::test]
    async fn happy_path_downloads_writes_and_verifies() {
        let body = b"the quick brown fox jumps over the lazy dog 0123456789".to_vec();
        let expected_sha = sha256_hex(&body);
        let expected_size = body.len() as u64;
        let url = chunked_server(body.clone(), 16, std::time::Duration::ZERO, false).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("model.gguf");
        let (pv, pf) = progress_sink();
        let cancel = CancellationToken::new();

        download_verified(
            &client(),
            &(url + "model.gguf"),
            &dest,
            &expected_sha,
            expected_size,
            &*pf,
            &cancel,
        )
        .await
        .expect("happy path must succeed");

        assert!(dest.exists(), "final file must exist at dest_path");
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            body,
            "final bytes must match served body",
        );
        assert!(
            !tmp.path().join("model.gguf.part").exists(),
            ".part must be gone after rename",
        );
        let ticks = pv.lock().unwrap().clone();
        assert!(!ticks.is_empty(), "progress must tick at least once");
        assert!(ticks.contains(&100), "progress must reach 100: {ticks:?}");
    }

    #[tokio::test]
    async fn expected_size_zero_skips_size_check_and_verifies_by_sha_only() {
        // The server-binary archive pins only a SHA-256 (no byte size), so
        // `ensure_server_binary` passes `expected_size = 0` as the "no pinned
        // size" sentinel. A real download has actual bytes > 0, so the size
        // check must be SKIPPED for 0 (else `actual != 0` would always fail
        // with download_size_mismatch) and the SHA-256 becomes authoritative.
        let body = b"llama-server archive bytes with no pinned size".to_vec();
        let expected_sha = sha256_hex(&body);
        let url = chunked_server(body.clone(), 16, std::time::Duration::ZERO, false).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("llama-server.tar.gz");
        let (_pv, pf) = progress_sink();
        let cancel = CancellationToken::new();

        download_verified(
            &client(),
            &(url + "llama-server.tar.gz"),
            &dest,
            &expected_sha,
            0, // no pinned size → size check skipped
            &*pf,
            &cancel,
        )
        .await
        .expect("expected_size == 0 must skip the size check and succeed on SHA match");

        assert_eq!(
            std::fs::read(&dest).unwrap(),
            body,
            "bytes must match served body"
        );
    }

    #[tokio::test]
    async fn expected_size_zero_still_rejects_a_sha_mismatch() {
        // The 0-sentinel skips the SIZE check only — the SHA-256 guard must
        // still reject corrupted/wrong bytes.
        let body = b"some archive bytes".to_vec();
        let wrong_sha = sha256_hex(b"different content entirely");
        let url = chunked_server(body.clone(), 16, std::time::Duration::ZERO, false).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("llama-server.tar.gz");
        let (_pv, pf) = progress_sink();
        let cancel = CancellationToken::new();

        let err = download_verified(
            &client(),
            &(url + "llama-server.tar.gz"),
            &dest,
            &wrong_sha,
            0,
            &*pf,
            &cancel,
        )
        .await
        .expect_err("a SHA mismatch must still fail even when the size check is skipped");
        assert_eq!(
            err.code(),
            "download_sha256_mismatch",
            "SHA guard must fire, got {err:?}"
        );
    }

    // ─── 2. sha mismatch ─────────────────────────────────────────────────

    #[tokio::test]
    async fn sha_mismatch_deletes_part_and_final() {
        let body = vec![0u8; 64];
        let expected_size = body.len() as u64;
        // Wrong digest on purpose.
        let wrong_sha = "0".repeat(64);
        let url = chunked_server(body.clone(), 16, std::time::Duration::ZERO, false).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("bin");
        // Stale final file from a prior wrong run — must also be cleaned.
        std::fs::write(&dest, b"stale").unwrap();
        let (_, pf) = progress_sink();
        let cancel = CancellationToken::new();

        let err = download_verified(
            &client(),
            &(url + "bin"),
            &dest,
            &wrong_sha,
            expected_size,
            &*pf,
            &cancel,
        )
        .await
        .expect_err("must fail on sha mismatch");

        assert!(matches!(err, DownloadError::Sha256Mismatch { .. }));
        assert_eq!(err.code(), "download_sha256_mismatch");
        assert!(
            !tmp.path().join("bin.part").exists(),
            ".part must be deleted on mismatch",
        );
        assert!(
            !dest.exists(),
            "stale final file must also be deleted on mismatch",
        );
    }

    // ─── 3. resume from partial (206 honoured) ───────────────────────────

    #[tokio::test]
    async fn resume_appends_to_partial_when_server_honours_range() {
        // wiremock gives us precise Range-header matching for the resume
        // semantics that the hand-rolled chunked_server fakes. Build a body
        // where the first 10 bytes are pre-seeded in the .part file.
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let body = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJ".to_vec();
        let prefix_len = 10usize;
        let expected_sha = sha256_hex(&body);
        let expected_size = body.len() as u64;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("resumable.bin");
        let part = tmp.path().join("resumable.bin.part");
        let prefix = &body[..prefix_len];
        std::fs::write(&part, prefix).unwrap();

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/resumable.bin"))
            .and(header("range", "bytes=10-"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header(
                        "Content-Range",
                        format!("bytes 10-{}/{}", body.len() - 1, body.len()),
                    )
                    .set_body_bytes(&body[prefix_len..]),
            )
            .mount(&server)
            .await;

        let (_, pf) = progress_sink();
        let cancel = CancellationToken::new();
        download_verified(
            &client(),
            &format!("{}/resumable.bin", server.uri()),
            &dest,
            &expected_sha,
            expected_size,
            &*pf,
            &cancel,
        )
        .await
        .expect("resume must succeed");

        assert_eq!(
            std::fs::read(&dest).unwrap(),
            body,
            "final must be prefix + appended tail",
        );
        assert!(!part.exists(), ".part renamed away");
    }

    // ─── 4. server ignores Range (200 full body) ─────────────────────────

    #[tokio::test]
    async fn server_ignores_range_restarts_cleanly() {
        let body = vec![42u8; 50];
        let expected_sha = sha256_hex(&body);
        let expected_size = body.len() as u64;
        // honour_range=false → server replies 200 with the full body even
        // though a .part exists.
        let url = chunked_server(body.clone(), 10, std::time::Duration::ZERO, false).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("restart.bin");
        let part = tmp.path().join("restart.bin.part");
        // Pre-existing partial that must be truncated away.
        std::fs::write(&part, b"GARBAGE_FROM_PRIOR_RUN").unwrap();

        let (_, pf) = progress_sink();
        let cancel = CancellationToken::new();
        download_verified(
            &client(),
            &(url + "restart.bin"),
            &dest,
            &expected_sha,
            expected_size,
            &*pf,
            &cancel,
        )
        .await
        .expect("restart must succeed");

        assert_eq!(
            std::fs::read(&dest).unwrap(),
            body,
            "final must be the full re-downloaded body, not prefix+garbage",
        );
    }

    // ─── 5. cancel mid-stream ────────────────────────────────────────────

    #[tokio::test]
    async fn cancel_mid_stream_deletes_part_and_returns_cancelled() {
        // 1 KiB body, 256-byte chunks, 300ms between chunks → cancel fires
        // after the first chunk lands, mid-download.
        let body = vec![7u8; 1024];
        let expected_sha = sha256_hex(&body);
        let expected_size = body.len() as u64;
        let url = chunked_server(
            body.clone(),
            256,
            std::time::Duration::from_millis(300),
            false,
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("cancellable.bin");
        let part = tmp.path().join("cancellable.bin.part");
        let (_, pf) = progress_sink();
        let cancel = CancellationToken::new();

        // Cancel shortly after start — the first 256-byte chunk should land,
        // then the cancel branch wins the select before chunk 2.
        let cancel2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            cancel2.cancel();
        });

        let err = download_verified(
            &client(),
            &(url + "cancellable.bin"),
            &dest,
            &expected_sha,
            expected_size,
            &*pf,
            &cancel,
        )
        .await
        .expect_err("must be cancelled");

        assert!(matches!(err, DownloadError::Cancelled));
        assert_eq!(err.code(), "download_cancelled");
        assert!(!part.exists(), ".part must be deleted on cancel");
        assert!(!dest.exists(), "final must never have been written");
    }

    // ─── 6. non-2xx HTTP ─────────────────────────────────────────────────

    #[tokio::test]
    async fn non_2xx_returns_http_error() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/missing"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("missing.bin");
        let (_, pf) = progress_sink();
        let cancel = CancellationToken::new();

        let err = download_verified(
            &client(),
            &format!("{}/missing", server.uri()),
            &dest,
            &"0".repeat(64),
            1,
            &*pf,
            &cancel,
        )
        .await
        .expect_err("404 must be an error");

        match err {
            DownloadError::Http { status } => assert_eq!(status, 404),
            other => panic!("expected Http, got {other:?}"),
        }
        assert_eq!(err.code(), "download_http");
    }

    // ─── 7. progress throttle ────────────────────────────────────────────

    #[tokio::test]
    async fn progress_is_monotonic_no_duplicate_consecutive_values() {
        // 400 bytes in 100-byte chunks → exactly 0,25,50,75,100 if reported
        // per chunk. We assert no two consecutive ticks are equal and the
        // sequence is non-decreasing, ending at 100.
        let body = vec![1u8; 400];
        let expected_sha = sha256_hex(&body);
        let expected_size = body.len() as u64;
        // Tiny delay so chunks land as distinct stream events.
        let url = chunked_server(
            body.clone(),
            100,
            std::time::Duration::from_millis(5),
            false,
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("progress.bin");
        let (pv, pf) = progress_sink();
        let cancel = CancellationToken::new();
        download_verified(
            &client(),
            &(url + "progress.bin"),
            &dest,
            &expected_sha,
            expected_size,
            &*pf,
            &cancel,
        )
        .await
        .unwrap();

        let ticks = pv.lock().unwrap().clone();
        assert!(!ticks.is_empty(), "must have progress ticks: {ticks:?}");
        for w in ticks.windows(2) {
            assert!(w[0] <= w[1], "progress must be non-decreasing: {ticks:?}",);
            assert!(
                w[0] != w[1],
                "no duplicate consecutive whole-percent ticks: {ticks:?}",
            );
        }
        assert_eq!(*ticks.last().unwrap(), 100, "must end at 100: {ticks:?}");
    }

    // ─── bonus: short-circuit when final already present + correct size ──

    #[tokio::test]
    async fn short_circuits_when_final_exists_with_correct_size() {
        let body = vec![9u8; 32];
        let expected_size = body.len() as u64;
        // Server that would panic if hit — proving we never call it.
        let url =
            chunked_server(body.clone(), 8, std::time::Duration::ZERO, false).await + "never-hit";

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("cached.bin");
        std::fs::write(&dest, &body).unwrap();
        let (_, pf) = progress_sink();
        let cancel = CancellationToken::new();

        download_verified(
            &client(),
            &url,
            &dest,
            &"deadbeef".repeat(8), // wrong sha — must NOT matter for the short-circuit
            expected_size,
            &*pf,
            &cancel,
        )
        .await
        .expect("correct-size final file must short-circuit without re-verifying");

        assert_eq!(std::fs::read(&dest).unwrap(), body);
    }

    // ─── bytes_progress branch (basemap uses this) ────────────────────────

    #[tokio::test]
    async fn bytes_progress_fires_and_last_chunk_is_not_verified_ready() {
        let body = b"byte-tick body for download_verified_with_bytes".to_vec();
        let expected_sha = sha256_hex(&body);
        let expected_size = body.len() as u64;
        let url = chunked_server(body.clone(), 8, std::time::Duration::from_millis(5), false).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("basemap.pmtiles");
        let part = tmp.path().join("basemap.pmtiles.part");
        let (_pv, pf) = progress_sink();
        let cancel = CancellationToken::new();

        type BytesBuf = std::sync::Arc<Mutex<Vec<(u64, u64)>>>;
        let ticks: BytesBuf = std::sync::Arc::new(Mutex::new(Vec::new()));
        let dest_for_cb = dest.clone();
        let part_for_cb = part.clone();
        let bytes_cb = {
            let ticks = ticks.clone();
            move |downloaded: u64, total: u64| {
                ticks.lock().unwrap().push((downloaded, total));
                if downloaded >= total && total > 0 {
                    assert!(
                        !dest_for_cb.exists(),
                        "last-chunk bytes tick must fire before rename; dest is not verified ready"
                    );
                    assert!(
                        part_for_cb.exists(),
                        "last-chunk bytes tick still has the .part, not the final dest"
                    );
                }
            }
        };

        download_verified_with_bytes(
            &client(),
            &(url + "basemap.pmtiles"),
            &dest,
            &expected_sha,
            expected_size,
            &*pf,
            &bytes_cb,
            &cancel,
        )
        .await
        .expect("bytes-progress download must succeed");

        let observed = ticks.lock().unwrap().clone();
        assert!(
            !observed.is_empty(),
            "bytes_progress must fire at least once"
        );
        assert!(
            observed
                .iter()
                .any(|(d, t)| *d == expected_size && *t == expected_size),
            "bytes_progress must report the final byte count: {observed:?}"
        );
        assert!(
            dest.exists(),
            "dest exists only after the function returns Ok"
        );
        assert!(!part.exists(), ".part must be renamed away after verify");
    }
}
