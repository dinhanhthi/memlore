//! Offline world PMTiles basemap — JIT download, status, range-read, delete.
//!
//! Phase 3 Task T11 of the commercial-license remediation. The frontend
//! (T12) range-reads `{app_data}/basemap/world.pmtiles` via a custom
//! pmtiles.js Source. The archive is SHA-256-pinned and fetched with the
//! same verified downloader as on-device LLM assets.

use crate::ai::on_device::fetch;
use crate::AppState;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Default CDN URL (R2). Tried first.
pub const BASEMAP_DEFAULT_URL: &str =
    "https://pub-46e3eeff51414e7a954e0809a6e5edba.r2.dev/world-z8.pmtiles";

/// GitHub Releases fallback, used when the default URL fails with HTTP or IO.
pub const BASEMAP_FALLBACK_URL: &str =
    "https://github.com/dinhanhthi/xjournal-basemap/releases/download/basemap-v1/world-z8.pmtiles";

/// Pinned SHA-256 of the published `world-z8.pmtiles` (basemap-v1).
pub const BASEMAP_SHA256: &str = "bbce16987c1231bc807bd79dcff2635f5ce91347c0b4867f411db8f8d705e46d";

/// Pinned byte size of the published archive.
pub const BASEMAP_SIZE_BYTES: u64 = 552_165_687;

/// On-disk filename under `{app_data}/basemap/`.
pub const BASEMAP_FILENAME: &str = "world.pmtiles";

/// Settings key the frontend writes via `setSetting('map_tile_source', …)`.
const MAP_TILE_SOURCE_KEY: &str = "map_tile_source";

/// Hard cap on a single `read_basemap_range` request (4 MiB).
pub const MAX_RANGE_LEN: u32 = 4 * 1024 * 1024;

const PROGRESS_EVENT: &str = "basemap:download-progress";
/// Terminal success/failure after SHA verify + atomic rename (or on error).
/// Last-byte progress stays `downloading` at 100% — never treat it as ready.
const COMPLETE_EVENT: &str = "basemap:download-complete";

/// Process-wide in-flight guard. One basemap download at a time.
static DOWNLOAD_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Cancel token for the in-flight download. Registered before spawn so a
/// racing `cancel_basemap_download` can interrupt the HTTP stream.
static DOWNLOAD_CANCEL: Mutex<Option<tokio_util::sync::CancellationToken>> = Mutex::new(None);

fn lock_cancel(
    slot: &Mutex<Option<tokio_util::sync::CancellationToken>>,
) -> std::sync::MutexGuard<'_, Option<tokio_util::sync::CancellationToken>> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// Store `token` so [`request_cancel_download`] can signal it.
pub fn register_download_cancel(
    slot: &Mutex<Option<tokio_util::sync::CancellationToken>>,
    token: tokio_util::sync::CancellationToken,
) {
    *lock_cancel(slot) = Some(token);
}

/// Signal and take the registered token. No-op when nothing is in flight.
pub fn request_cancel_download(
    slot: &Mutex<Option<tokio_util::sync::CancellationToken>>,
) -> Result<(), String> {
    if let Some(token) = lock_cancel(slot).take() {
        token.cancel();
    }
    Ok(())
}

/// Drop the registration without signalling (download finished on its own).
pub fn take_download_cancel(slot: &Mutex<Option<tokio_util::sync::CancellationToken>>) {
    *lock_cancel(slot) = None;
}

/// `basemap_status` payload. Field names match the T11 contract
/// (`status` / `path` / `size_bytes`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BasemapStatusPayload {
    pub status: String,
    pub path: Option<String>,
    pub size_bytes: Option<u64>,
}

/// `basemap:download-progress` event payload. Byte ticks only — never
/// a terminal ready/error (those go on [`COMPLETE_EVENT`]).
#[derive(Debug, Clone, Serialize)]
pub struct BasemapProgressPayload {
    pub downloaded: u64,
    pub total: u64,
}

/// `basemap:download-complete` event payload. Emitted after the in-flight
/// flag is released so a follow-up `basemap_status` sees the real state.
#[derive(Debug, Clone, Serialize)]
pub struct BasemapCompletePayload {
    pub status: String,
    pub path: Option<String>,
    pub size_bytes: Option<u64>,
    pub code: Option<String>,
}

/// Sibling of `world.pmtiles`, written only after SHA-256 success.
/// `basemap_status` treats the archive as ready iff dest exists, size
/// matches, and this marker is present — no 552 MiB re-hash on poll.
fn ready_marker_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".ready");
    s.into()
}

/// Retry the GitHub fallback on network failures only — never on a
/// SHA/size mismatch or a user cancel (those are definitive).
pub fn should_retry_fallback(err: &fetch::DownloadError) -> bool {
    matches!(
        err,
        fetch::DownloadError::Http { .. } | fetch::DownloadError::Io(_)
    )
}

/// Dest exists, size matches the pin, and the SHA-success marker is present.
pub fn dest_is_verified(path: &Path) -> bool {
    if !path.is_file() || !ready_marker_path(path).is_file() {
        return false;
    }
    std::fs::metadata(path)
        .map(|m| m.len() == BASEMAP_SIZE_BYTES)
        .unwrap_or(false)
}

/// Remove dest + marker unless they are a verified archive.
///
/// If dest still exists after the attempt, return `Err` so the caller
/// must not size-short-circuit fetch or mint `.ready`.
pub fn discard_unverified_dest(path: &Path) -> Result<(), String> {
    if dest_is_verified(path) {
        return Ok(());
    }
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("unverified_dest_unlink: {e}"))?;
        if path.exists() {
            return Err("unverified_dest_still_present".into());
        }
    }
    let marker = ready_marker_path(path);
    if marker.exists() {
        std::fs::remove_file(&marker).map_err(|e| format!("unverified_marker_unlink: {e}"))?;
    }
    Ok(())
}

/// Read `[offset, offset+len)` from `path`, capping `len` at [`MAX_RANGE_LEN`].
/// Short reads at EOF are OK. Missing file is `Err`.
pub fn read_basemap_range_at(path: &Path, offset: u64, len: u32) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    if offset >= file_len {
        return Ok(Vec::new());
    }
    let want = (len as u64)
        .min(MAX_RANGE_LEN as u64)
        .min(file_len - offset);
    let mut buf = vec![0u8; want as usize];
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok(buf)
}

/// Range-read only a verified, idle archive. Rejects in-flight downloads
/// and leftovers that never passed SHA.
pub fn read_basemap_range_verified(
    path: &Path,
    in_flight: bool,
    offset: u64,
    len: u32,
) -> Result<Vec<u8>, String> {
    if in_flight {
        return Err("download_in_progress".into());
    }
    if !dest_is_verified(path) {
        return Err("basemap_not_ready".into());
    }
    read_basemap_range_at(path, offset, len)
}

/// Status for an injected dest path + in-flight flag (tests never touch
/// the process-wide guard or the live app-data path).
pub fn basemap_status_at(path: &Path, in_flight: bool) -> BasemapStatusPayload {
    if in_flight {
        return BasemapStatusPayload {
            status: "downloading".to_string(),
            path: None,
            size_bytes: None,
        };
    }
    if path.is_file() && ready_marker_path(path).is_file() {
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() == BASEMAP_SIZE_BYTES {
                return BasemapStatusPayload {
                    status: "ready".to_string(),
                    path: Some(path.to_string_lossy().into_owned()),
                    size_bytes: Some(meta.len()),
                };
            }
        }
    }
    BasemapStatusPayload {
        status: "not_downloaded".to_string(),
        path: None,
        size_bytes: None,
    }
}

/// Claim the download slot. `Err("already_downloading")` if `flag` is set.
pub fn try_claim_download(flag: &AtomicBool) -> Result<(), String> {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map(|_| ())
        .map_err(|_| "already_downloading".to_string())
}

/// Release a previously claimed download slot.
pub fn release_download(flag: &AtomicBool) {
    flag.store(false, Ordering::SeqCst);
}

/// After a successful archive delete: drop `map_tile_source` only when it
/// is `offline`, so the radio does not stay stuck on a missing archive.
/// Missing key is ok (`db::delete_setting` already treats that as success).
pub(crate) fn clear_offline_map_source(conn: &rusqlite::Connection) -> Result<(), String> {
    let current = crate::db::get_setting(conn, MAP_TILE_SOURCE_KEY).map_err(|e| e.to_string())?;
    if current.as_deref() == Some("offline") {
        crate::db::delete_setting(conn, MAP_TILE_SOURCE_KEY).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Delete `world.pmtiles` and any sibling `.part`. Rejects while a download
/// is running so we never yank the file out from under the fetcher.
pub fn delete_basemap_at(path: &Path, in_flight: bool) -> Result<(), String> {
    if in_flight {
        return Err("download_in_progress".to_string());
    }
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    let part = fetch::part_path(path);
    if part.exists() {
        std::fs::remove_file(&part).map_err(|e| e.to_string())?;
    }
    let marker = ready_marker_path(path);
    if marker.exists() {
        std::fs::remove_file(&marker).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn resolve_basemap_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("basemap").join(BASEMAP_FILENAME))
}

/// Fire-and-forget download. Returns immediately after spawn. Rejects if
/// another download is already running.
#[tauri::command]
pub async fn download_basemap(app: AppHandle) -> Result<(), String> {
    try_claim_download(&DOWNLOAD_IN_FLIGHT)?;
    let dest = match resolve_basemap_path(&app) {
        Ok(p) => p,
        Err(e) => {
            release_download(&DOWNLOAD_IN_FLIGHT);
            return Err(e);
        }
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    register_download_cancel(&DOWNLOAD_CANCEL, cancel.clone());
    tokio::spawn(async move {
        let result = run_basemap_download(&app, &dest, &cancel).await;
        take_download_cancel(&DOWNLOAD_CANCEL);
        release_download(&DOWNLOAD_IN_FLIGHT);
        emit_basemap_complete(&app, &dest, result);
    });
    Ok(())
}

/// Best-effort cancel of the in-flight world-basemap download. No-op when
/// nothing is running. The fetcher honours the token between chunks (and
/// during the HTTP handshake), deletes `.part`, and emits `download_cancelled`.
#[tauri::command]
pub fn cancel_basemap_download() -> Result<(), String> {
    request_cancel_download(&DOWNLOAD_CANCEL)
}

fn emit_basemap_complete(app: &AppHandle, dest: &Path, result: Result<(), String>) {
    let payload = match result {
        Ok(()) => BasemapCompletePayload {
            status: "ready".to_string(),
            path: Some(dest.to_string_lossy().into_owned()),
            size_bytes: Some(BASEMAP_SIZE_BYTES),
            code: None,
        },
        Err(e) => BasemapCompletePayload {
            status: "error".to_string(),
            path: None,
            size_bytes: None,
            code: Some(e),
        },
    };
    let _ = app.emit(COMPLETE_EVENT, payload);
}

#[tauri::command]
pub fn basemap_status(app: AppHandle) -> Result<BasemapStatusPayload, String> {
    let path = resolve_basemap_path(&app)?;
    Ok(basemap_status_at(
        &path,
        DOWNLOAD_IN_FLIGHT.load(Ordering::SeqCst),
    ))
}

#[tauri::command]
pub fn read_basemap_range(
    app: AppHandle,
    offset: u64,
    len: u32,
) -> Result<tauri::ipc::Response, String> {
    let path = resolve_basemap_path(&app)?;
    let bytes = read_basemap_range_verified(
        &path,
        DOWNLOAD_IN_FLIGHT.load(Ordering::SeqCst),
        offset,
        len,
    )?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn delete_basemap(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let path = resolve_basemap_path(&app)?;
    delete_basemap_at(&path, DOWNLOAD_IN_FLIGHT.load(Ordering::SeqCst))?;
    let conn = state.lock()?;
    clear_offline_map_source(&conn)
}

/// Sentinel returned when `MEMLORE_MAPKIT_TOKEN` is unset or blank at compile time.
const MAPKIT_TOKEN_MISSING: &str = "MAPKIT_TOKEN_MISSING";

/// Compile-time MapKit JS JWT. Same `option_env!` + `build.rs` pattern as
/// `GOOGLE_FONTS_API_KEY` in `fonts.rs`.
fn mapkit_token() -> Option<&'static str> {
    option_env!("MEMLORE_MAPKIT_TOKEN")
        .map(str::trim)
        .filter(|k| !k.is_empty())
}

/// Maps a compile-time token `Option` to the IPC `Result`. Extracted so tests
/// can exercise the sentinel path without depending on `option_env!`.
fn mapkit_token_result(token: Option<&str>) -> Result<String, String> {
    match token {
        Some(t) => Ok(t.to_string()),
        None => Err(MAPKIT_TOKEN_MISSING.to_string()),
    }
}

/// MapKit JS JWT baked in at compile time via `MEMLORE_MAPKIT_TOKEN`.
///
/// MapKit JS loads from `https://cdn.apple-mapkit.com` (script) and
/// `https://*.apple-mapkit.com` (tiles / XHR). `tauri.conf.json` CSP
/// allowlists those hosts on `script-src` plus `ipc:` / `asset:` and
/// Vite HMR localhost. `connect-src` / `img-src` also keep scheme-wide
/// `https:` / `wss:` because the webview talks to user-configured AI
/// endpoints (any OpenAI-compatible URL), MapTiler, geocoders, Drive,
/// and Fonts — those hosts cannot be a closed allowlist. `script-src`
/// has no `'unsafe-inline'`; the scheme wildcards are not an HTML XSS
/// vector.
#[tauri::command]
pub fn get_mapkit_token() -> Result<String, String> {
    mapkit_token_result(mapkit_token())
}

/// Throttle progress events so a 552 MiB stream does not flood the webview.
const PROGRESS_EMIT_STEP: u64 = 256 * 1024;

async fn run_basemap_download(
    app: &AppHandle,
    dest: &Path,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    // Already verified on a prior run — skip the network.
    if dest_is_verified(dest) {
        return Ok(());
    }
    // Leftover dest (any size, with or without a stale marker) would trip
    // `download_verified`'s size-only short-circuit or block Windows rename.
    // Abort if unlink fails so we never mint `.ready` without a SHA this run.
    discard_unverified_dest(dest)?;

    // Emit 0 / pinned size before the HTTP handshake so Settings + footer
    // share a known denominator while TLS/connect is still in flight.
    let _ = app.emit(
        PROGRESS_EVENT,
        BasemapProgressPayload {
            downloaded: 0,
            total: BASEMAP_SIZE_BYTES,
        },
    );

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let percent_cb = |_pct: u8| {};
    let last_emitted = std::sync::atomic::AtomicU64::new(u64::MAX);
    let bytes_cb = |downloaded: u64, total: u64| {
        let prev = last_emitted.load(Ordering::Relaxed);
        if prev == u64::MAX
            || downloaded == total
            || downloaded.saturating_sub(prev) >= PROGRESS_EMIT_STEP
        {
            last_emitted.store(downloaded, Ordering::Relaxed);
            let _ = app.emit(PROGRESS_EVENT, BasemapProgressPayload { downloaded, total });
        }
    };

    fetch_basemap_with_fallback(&client, dest, &percent_cb, &bytes_cb, cancel).await?;
    tokio::fs::write(ready_marker_path(dest), b"1")
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn fetch_basemap_with_fallback(
    client: &reqwest::Client,
    dest: &Path,
    percent_cb: &(impl Fn(u8) + Send + Sync),
    bytes_cb: &(dyn Fn(u64, u64) + Send + Sync),
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    let mut last_http: Option<String> = None;
    for url in [BASEMAP_DEFAULT_URL, BASEMAP_FALLBACK_URL] {
        match fetch::download_verified_with_bytes(
            client,
            url,
            dest,
            BASEMAP_SHA256,
            BASEMAP_SIZE_BYTES,
            percent_cb,
            bytes_cb,
            cancel,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(e) if should_retry_fallback(&e) => {
                last_http = Some(e.to_string());
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(last_http.unwrap_or_else(|| "download_http".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_pmtiles() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(BASEMAP_FILENAME);
        (tmp, path)
    }

    #[test]
    fn range_read_happy_path() {
        let (_tmp, path) = temp_pmtiles();
        std::fs::write(&path, b"abcdefghij").unwrap();
        let got = read_basemap_range_at(&path, 2, 4).expect("range read must succeed");
        assert_eq!(got, b"cdef", "must return the requested slice");
    }

    #[test]
    fn range_read_eof_truncated() {
        let (_tmp, path) = temp_pmtiles();
        std::fs::write(&path, b"abcdefghij").unwrap();
        let got = read_basemap_range_at(&path, 8, 16).expect("short EOF read must succeed");
        assert_eq!(got, b"ij", "must return only the remaining bytes");
    }

    #[test]
    fn range_read_oversized_len_is_capped_at_4_mib() {
        let (_tmp, path) = temp_pmtiles();
        let size = MAX_RANGE_LEN as u64 + 1024;
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(size).unwrap();
        drop(f);
        let got = read_basemap_range_at(&path, 0, u32::MAX).expect("capped read must succeed");
        assert_eq!(
            got.len(),
            MAX_RANGE_LEN as usize,
            "oversized len must be capped at 4 MiB"
        );
    }

    #[test]
    fn range_read_missing_file_is_err() {
        let (_tmp, path) = temp_pmtiles();
        let err = read_basemap_range_at(&path, 0, 16).expect_err("missing file must error");
        assert!(!err.is_empty(), "error message must not be empty");
    }

    #[test]
    fn status_missing_file_is_not_downloaded() {
        let (_tmp, path) = temp_pmtiles();
        let status = basemap_status_at(&path, false);
        assert_eq!(status.status, "not_downloaded");
        assert_eq!(status.path, None);
        assert_eq!(status.size_bytes, None);
    }

    #[test]
    fn status_correct_size_file_is_ready() {
        let (_tmp, path) = temp_pmtiles();
        // Sparse file — do not write 552 MiB of zeros.
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(BASEMAP_SIZE_BYTES).unwrap();
        drop(f);
        std::fs::write(ready_marker_path(&path), b"1").unwrap();
        let status = basemap_status_at(&path, false);
        assert_eq!(status.status, "ready");
        assert_eq!(status.size_bytes, Some(BASEMAP_SIZE_BYTES));
        assert_eq!(status.path.as_deref(), Some(path.to_str().unwrap()));
    }

    #[test]
    fn status_in_flight_is_downloading() {
        let (_tmp, path) = temp_pmtiles();
        let status = basemap_status_at(&path, true);
        assert_eq!(status.status, "downloading");
        assert_eq!(status.path, None);
        assert_eq!(status.size_bytes, None);
    }

    #[test]
    fn status_wrong_size_file_is_not_ready() {
        let (_tmp, path) = temp_pmtiles();
        std::fs::write(&path, b"too-small").unwrap();
        std::fs::write(ready_marker_path(&path), b"1").unwrap();
        let status = basemap_status_at(&path, false);
        assert_eq!(status.status, "not_downloaded");
        assert_eq!(status.path, None);
    }

    #[test]
    fn status_correct_size_without_marker_is_not_ready() {
        let (_tmp, path) = temp_pmtiles();
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(BASEMAP_SIZE_BYTES).unwrap();
        drop(f);
        let status = basemap_status_at(&path, false);
        assert_eq!(
            status.status, "not_downloaded",
            "size-only leftover must not count as ready"
        );
    }

    #[test]
    fn delete_removes_dest_part_and_ready_marker() {
        let (_tmp, path) = temp_pmtiles();
        std::fs::write(&path, b"archive").unwrap();
        std::fs::write(fetch::part_path(&path), b"partial").unwrap();
        std::fs::write(ready_marker_path(&path), b"1").unwrap();
        delete_basemap_at(&path, false).expect("delete must succeed");
        assert!(!path.exists(), "world.pmtiles must be removed");
        assert!(!fetch::part_path(&path).exists(), ".part must be removed");
        assert!(
            !ready_marker_path(&path).exists(),
            ".ready marker must be removed"
        );
    }

    #[test]
    fn fallback_retries_http_and_io_not_sha_or_cancel() {
        assert!(should_retry_fallback(&fetch::DownloadError::Http {
            status: 503
        }));
        assert!(should_retry_fallback(&fetch::DownloadError::Io(
            "connection reset".into()
        )));
        assert!(!should_retry_fallback(
            &fetch::DownloadError::Sha256Mismatch {
                expected: "aa".into(),
                actual: "bb".into(),
            }
        ));
        assert!(!should_retry_fallback(&fetch::DownloadError::Cancelled));
        assert!(!should_retry_fallback(
            &fetch::DownloadError::SizeMismatch {
                expected: 1,
                actual: 2,
            }
        ));
    }

    #[test]
    fn download_rejected_while_already_running() {
        let flag = AtomicBool::new(true);
        let err = try_claim_download(&flag).expect_err("in-flight download must reject");
        assert_eq!(err, "already_downloading");
    }

    #[test]
    fn delete_rejected_while_download_running() {
        let (_tmp, path) = temp_pmtiles();
        std::fs::write(&path, b"keep-me").unwrap();
        let err = delete_basemap_at(&path, true).expect_err("delete must reject while downloading");
        assert_eq!(err, "download_in_progress");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"keep-me",
            "file must be left intact when delete is rejected"
        );
    }

    #[test]
    fn discard_unverified_removes_leftover_without_marker() {
        let (_tmp, path) = temp_pmtiles();
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(BASEMAP_SIZE_BYTES).unwrap();
        drop(f);
        discard_unverified_dest(&path).expect("leftover dest must unlink");
        assert!(!path.exists(), "unverified dest must be gone");
        assert!(
            !ready_marker_path(&path).exists(),
            "must not mint a ready marker"
        );
    }

    #[test]
    fn discard_unverified_leaves_verified_archive() {
        let (_tmp, path) = temp_pmtiles();
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(BASEMAP_SIZE_BYTES).unwrap();
        drop(f);
        std::fs::write(ready_marker_path(&path), b"1").unwrap();
        discard_unverified_dest(&path).expect("verified dest is a no-op");
        assert!(path.exists(), "verified dest must stay");
        assert!(ready_marker_path(&path).exists(), "marker must stay");
    }

    #[test]
    fn discard_unverified_removes_wrong_size_with_marker() {
        let (_tmp, path) = temp_pmtiles();
        std::fs::write(&path, b"too-small").unwrap();
        std::fs::write(ready_marker_path(&path), b"1").unwrap();
        discard_unverified_dest(&path).expect("wrong-size dest must unlink");
        assert!(!path.exists(), "wrong-size dest must be gone");
        assert!(
            !ready_marker_path(&path).exists(),
            "stale marker must be gone"
        );
    }

    #[test]
    fn discard_unverified_fails_if_dest_cannot_be_removed() {
        let (_tmp, path) = temp_pmtiles();
        std::fs::create_dir(&path).unwrap();
        let err = discard_unverified_dest(&path)
            .expect_err("directory dest cannot be unlinked as a file");
        assert!(
            err.contains("unverified_dest"),
            "error must name the unlink failure, got {err}"
        );
        assert!(
            path.exists(),
            "dest must still be present after failed unlink"
        );
    }

    #[test]
    fn read_verified_rejects_unready() {
        let (_tmp, path) = temp_pmtiles();
        std::fs::write(&path, b"abcdefghij").unwrap();
        let err = read_basemap_range_verified(&path, false, 0, 4)
            .expect_err("unverified dest must not be readable");
        assert_eq!(err, "basemap_not_ready");
    }

    #[test]
    fn read_verified_rejects_in_flight() {
        let (_tmp, path) = temp_pmtiles();
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(BASEMAP_SIZE_BYTES).unwrap();
        drop(f);
        std::fs::write(ready_marker_path(&path), b"1").unwrap();
        let err = read_basemap_range_verified(&path, true, 0, 4)
            .expect_err("in-flight download must block range reads");
        assert_eq!(err, "download_in_progress");
    }

    #[test]
    fn cancel_without_registration_is_ok() {
        let slot = Mutex::new(None);
        request_cancel_download(&slot).expect("idle cancel must be a no-op");
    }

    #[test]
    fn cancel_signals_registered_token() {
        let slot = Mutex::new(None);
        let token = tokio_util::sync::CancellationToken::new();
        register_download_cancel(&slot, token.clone());
        request_cancel_download(&slot).expect("registered cancel must succeed");
        assert!(token.is_cancelled(), "fetcher token must be signalled");
        assert!(
            slot.lock().unwrap().is_none(),
            "slot must be empty after cancel so a stale click is a no-op"
        );
    }

    #[test]
    fn take_clears_slot_without_signalling() {
        let slot = Mutex::new(None);
        let token = tokio_util::sync::CancellationToken::new();
        register_download_cancel(&slot, token.clone());
        take_download_cancel(&slot);
        assert!(!token.is_cancelled(), "complete path must not cancel");
        request_cancel_download(&slot).expect("stale cancel after take is ok");
        assert!(!token.is_cancelled(), "taken token must stay unsignalled");
    }

    #[test]
    fn mapkit_token_none_returns_missing_sentinel() {
        let err = mapkit_token_result(None).expect_err("unset token must error");
        assert_eq!(err, "MAPKIT_TOKEN_MISSING");
    }

    #[test]
    fn mapkit_token_some_returns_token() {
        let got = mapkit_token_result(Some("jwt.example")).expect("present token must succeed");
        assert_eq!(got, "jwt.example");
    }

    #[test]
    fn read_verified_ok_when_ready() {
        let (_tmp, path) = temp_pmtiles();
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(BASEMAP_SIZE_BYTES).unwrap();
        drop(f);
        std::fs::write(ready_marker_path(&path), b"1").unwrap();
        let got = read_basemap_range_verified(&path, false, 0, 4)
            .expect("verified dest must be readable");
        assert_eq!(
            got.len(),
            4,
            "sparse archive still yields the requested len"
        );
    }

    fn settings_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        crate::db::schema::migrate(&conn).expect("migrate");
        conn
    }

    #[test]
    fn clear_offline_map_source_deletes_only_when_value_is_offline() {
        let conn = settings_conn();
        crate::db::set_setting(&conn, MAP_TILE_SOURCE_KEY, "offline").unwrap();
        clear_offline_map_source(&conn).expect("offline source must clear");
        assert!(
            crate::db::get_setting(&conn, MAP_TILE_SOURCE_KEY)
                .unwrap()
                .is_none(),
            "offline map_tile_source must be deleted"
        );
    }

    #[test]
    fn clear_offline_map_source_leaves_maptiler() {
        let conn = settings_conn();
        crate::db::set_setting(&conn, MAP_TILE_SOURCE_KEY, "maptiler").unwrap();
        clear_offline_map_source(&conn).expect("maptiler must be a no-op");
        assert_eq!(
            crate::db::get_setting(&conn, MAP_TILE_SOURCE_KEY)
                .unwrap()
                .as_deref(),
            Some("maptiler")
        );
    }

    #[test]
    fn clear_offline_map_source_leaves_mapkit() {
        let conn = settings_conn();
        crate::db::set_setting(&conn, MAP_TILE_SOURCE_KEY, "mapkit").unwrap();
        clear_offline_map_source(&conn).expect("mapkit must be a no-op");
        assert_eq!(
            crate::db::get_setting(&conn, MAP_TILE_SOURCE_KEY)
                .unwrap()
                .as_deref(),
            Some("mapkit")
        );
    }

    #[test]
    fn clear_offline_map_source_missing_key_is_ok() {
        let conn = settings_conn();
        clear_offline_map_source(&conn).expect("missing key must not error");
        assert!(crate::db::get_setting(&conn, MAP_TILE_SOURCE_KEY)
            .unwrap()
            .is_none());
    }
}
