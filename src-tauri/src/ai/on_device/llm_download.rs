//! On-device LLM asset download manager (Phase 2 Task 2).
//!
//! Manages JIT download of the two asset classes the on-device LLM chat
//! feature needs: GGUF model weights (one per catalog entry) and the
//! `llama-server` sidecar binary (one per host). Mirrors the embedding
//! [`super::download::DownloadManager`] state-machine pattern —
//! `NotDownloaded → Downloading{progress} → Ready | Error{code}` — but for
//! raw GGUF files + an extracted executable instead of `fastembed` weights.
//!
//! # Asset layout
//!
//! Under `{base_dir}` (configured by the caller as `{app_data}/on-device-llm`):
//! - `models/{model_id}/model.gguf` — verified GGUF weights
//! - `models/{model_id}/.llm_ready` — ready marker (only written after a
//!   verified fetch, so "ready" survives app restarts without re-hashing GBs)
//! - `bin/{SERVER_VERSION_TAG}/llama-server` (or `.exe` on Windows)
//!
//! # No network in tests
//!
//! The real byte-fetch ([`crate::ai::on_device::fetch::download_verified`])
//! is wrapped behind the injectable [`LlmFetcher`] trait, exactly like the
//! embedding side's `ModelFetcher`. Tests pass a fake fetcher + a fake
//! archive, so they never touch the network — a real download is a manual
//! smoke check, not a unit test.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::download::DownloadState;
use super::llm_catalog;
use super::server_binary::{self, ServerBinaryAsset, SERVER_VERSION_TAG};

/// Ready-marker filename written into a model's dir only after a verified
/// GGUF fetch. Distinct from the embedding manager's `.on_device_ready` so a
/// future shared walker can't confuse the two asset classes.
const READY_MARKER: &str = ".llm_ready";

/// In-memory state key for the single server-binary asset (models are keyed
/// by their catalog id). Leading underscore keeps it out of the model-id
/// namespace. Public so the command layer can reuse it as the `id` of the
/// binary-phase progress event (keeping the binary and model phases
/// distinguishable on the frontend).
pub const BINARY_KEY: &str = "_server_binary";

/// `.part` files older than this are swept on startup as orphaned partial
/// downloads. 7 days per the spec.
const STALE_PART_AGE: Duration = Duration::from_secs(7 * 86400);

/// Injectable byte-fetcher wrapping [`super::fetch::download_verified`].
///
/// `Ok(())` means `dest_path` holds the fully-verified asset bytes. `Err(code)`
/// — `code` lands in [`DownloadState::Error`] verbatim (it's a short stable
/// code from [`super::fetch::DownloadError::code`] in production, or any
/// `String` the fake returns in tests).
#[async_trait]
pub trait LlmFetcher: Send + Sync {
    /// Stream `url` into `dest_path`, SHA-256-verified against `sha256` +
    /// exact `size`, calling `progress(pct)` on whole-percent changes.
    /// Cancellable via `cancel`.
    async fn fetch(
        &self,
        url: &str,
        dest_path: &Path,
        sha256: &str,
        size: u64,
        progress: &(dyn Fn(u8) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<(), String>;
}

/// Production fetcher: thin async wrapper around
/// [`super::fetch::download_verified`], translating [`super::fetch::DownloadError`]
/// to its stable `code()`.
pub struct HttpLlmFetcher {
    client: reqwest::Client,
}

impl HttpLlmFetcher {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl LlmFetcher for HttpLlmFetcher {
    async fn fetch(
        &self,
        url: &str,
        dest_path: &Path,
        sha256: &str,
        size: u64,
        progress: &(dyn Fn(u8) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        // `download_verified` takes `&(impl Fn(u8) + Send + Sync + Sized)`;
        // bridge the `&dyn Fn` to a concrete closure so the impl-Fn bound is
        // satisfied without forcing a `?Sized` relaxation on `download_verified`.
        let cb = |p: u8| progress(p);
        super::fetch::download_verified(&self.client, url, dest_path, sha256, size, &cb, cancel)
            .await
            .map_err(|e| e.code().to_string())
    }
}

/// Manages LLM asset download state (models + the server binary) in memory,
/// backed by on-disk ready markers so "ready" survives app restarts. An
/// in-memory `Downloading` left behind by a killed process just falls back to
/// `NotDownloaded` on the next query, since no marker was written — there is
/// nothing to resume in-process, but re-calling `download_model` / `ensure_server_binary`
/// re-attempts the fetch (and `download_verified`'s own `.part` cache dedups
/// whatever bytes already landed on disk).
pub struct LlmAssetManager {
    base_dir: PathBuf,
    states: Mutex<HashMap<String, DownloadState>>,
    /// Per-asset cancellation tokens, keyed the same way as `states` (model
    /// id or [`BINARY_KEY`]). The command layer registers a fresh token
    /// before spawning a download task and calls [`Self::cancel`] from the
    /// cancel command. Kept inside `LlmAssetManager` (rather than a separate
    /// registry in the command module) so cancel works regardless of which
    /// command path kicked off the download.
    cancels: Mutex<HashMap<String, CancellationToken>>,
}

impl LlmAssetManager {
    /// New manager rooted at `base_dir` (caller passes `{app_data}/on-device-llm`).
    /// Tests pass a tempdir.
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            states: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    /// `{base_dir}/models/{model_id}` — the dir holding the GGUF + ready marker.
    pub fn model_dir(&self, model_id: &str) -> PathBuf {
        self.base_dir.join("models").join(model_id)
    }

    /// `{model_dir}/model.gguf` — the final verified GGUF path.
    pub fn model_gguf_path(&self, model_id: &str) -> PathBuf {
        self.model_dir(model_id).join("model.gguf")
    }

    /// `{base_dir}/bin/{SERVER_VERSION_TAG}` — versioned so a tag bump
    /// downloads into a fresh dir instead of overwriting a live binary.
    pub fn binary_dir(&self) -> PathBuf {
        self.base_dir.join("bin").join(SERVER_VERSION_TAG)
    }

    /// `{binary_dir}/llama-server` (unix) or `llama-server.exe` (windows).
    pub fn binary_path(&self) -> PathBuf {
        let name = if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        };
        self.binary_dir().join(name)
    }

    fn ready_marker_path(&self, model_id: &str) -> PathBuf {
        self.model_dir(model_id).join(READY_MARKER)
    }

    /// Current on-disk progress evidence for `model_id`'s GGUF download —
    /// mirrors the embedding side's `dir_size_bytes` on-disk poller
    /// (`super::download::dir_size_bytes`), giving the command layer an
    /// authoritative progress source that doesn't depend on the fetcher's own
    /// whole-percent-throttled callback:
    /// - final `model.gguf` already present (fetch finished and renamed) →
    ///   the catalog's pinned `download_size_bytes` (100% by definition —
    ///   `download_verified` only renames after the exact-size check passes).
    /// - otherwise, the in-flight `model.gguf.part` file's current length
    ///   (0 if it doesn't exist yet — download hasn't started).
    pub fn model_on_disk_bytes(&self, model_id: &str) -> u64 {
        let final_path = self.model_gguf_path(model_id);
        if final_path.is_file() {
            return llm_catalog::find(model_id)
                .map(|m| m.download_size_bytes)
                .unwrap_or_else(|| fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0));
        }
        let part_path = super::fetch::part_path(&final_path);
        fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0)
    }

    /// Current model state: in-memory if non-default, else derived from the
    /// on-disk ready marker (so a fresh process sees `Ready` for a previously-
    /// downloaded model without re-running the fetch).
    pub fn model_state(&self, model_id: &str) -> DownloadState {
        if let Some(state) = self.states.lock().unwrap().get(model_id) {
            if !matches!(state, DownloadState::NotDownloaded) {
                return state.clone();
            }
        }
        if self.is_model_downloaded(model_id) {
            DownloadState::Ready
        } else {
            DownloadState::NotDownloaded
        }
    }

    /// Ready marker exists on disk.
    pub fn is_model_downloaded(&self, model_id: &str) -> bool {
        self.ready_marker_path(model_id).exists()
    }

    /// Binary exists at [`Self::binary_path`] and is a regular file. On unix
    /// we do NOT additionally require the exec bit here — a freshly extracted
    /// binary always gets `0o755` set by [`Self::ensure_server_binary`], and
    /// requiring it would produce false negatives if some external tool
    /// dropped the bit. Existence is the trusted signal post-extract.
    pub fn is_binary_installed(&self) -> bool {
        let p = self.binary_path();
        p.is_file()
    }

    /// Recursive on-disk size of [`Self::binary_dir`] (binary + companion
    /// dylibs/DLLs). Missing dir is `0` — [`super::download::dir_size_bytes`]
    /// already treats a missing path that way.
    pub fn binary_dir_size_bytes(&self) -> u64 {
        super::download::dir_size_bytes(&self.binary_dir())
    }

    fn set_state(&self, key: &str, state: DownloadState) {
        self.states.lock().unwrap().insert(key.to_string(), state);
    }

    /// Generic state accessor (models keyed by id, binary keyed by
    /// [`BINARY_KEY`]). Mirrors the embedding manager's `download_state`.
    pub fn state(&self, key: &str) -> DownloadState {
        if let Some(state) = self.states.lock().unwrap().get(key) {
            if !matches!(state, DownloadState::NotDownloaded) {
                return state.clone();
            }
        }
        if key == BINARY_KEY && self.is_binary_installed() {
            DownloadState::Ready
        } else if key != BINARY_KEY && self.is_model_downloaded(key) {
            DownloadState::Ready
        } else {
            DownloadState::NotDownloaded
        }
    }

    /// Update the in-memory state to `Downloading { progress }`, but only
    /// while the asset is actually `Downloading` — a no-op otherwise (e.g.
    /// after cancel reset it to `NotDownloaded`, or it already reached
    /// `Ready`/`Error`). Mirrors `DownloadManager::report_download_progress`.
    pub fn report_progress(&self, key: &str, progress: u8) {
        let mut states = self.states.lock().unwrap();
        if matches!(states.get(key), Some(DownloadState::Downloading { .. })) {
            states.insert(key.to_string(), DownloadState::Downloading { progress });
        }
    }

    /// Download (or resume) a catalog model's GGUF into
    /// [`Self::model_gguf_path`], writing the ready marker on success.
    ///
    /// Short-circuits to `Ready` if the marker already exists. Cancellation
    /// is the fetcher's concern (it honors the injected `CancellationToken`).
    pub async fn download_model(
        &self,
        model_id: &str,
        fetcher: &dyn LlmFetcher,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let model = llm_catalog::find(model_id)
            .ok_or_else(|| format!("unknown on-device LLM model id: {model_id}"))?;
        if self.is_model_downloaded(model_id) {
            self.set_state(model_id, DownloadState::Ready);
            return Ok(());
        }
        self.set_state(model_id, DownloadState::Downloading { progress: 0 });

        let dest = self.model_gguf_path(model_id);
        let result = fetcher
            .fetch(
                model.gguf_url,
                &dest,
                model.sha256,
                model.download_size_bytes,
                &|p| self.report_progress(model_id, p),
                cancel,
            )
            .await;
        match result {
            Ok(()) => {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(self.ready_marker_path(model_id), b"1").map_err(|e| e.to_string())?;
                self.set_state(model_id, DownloadState::Ready);
                Ok(())
            }
            Err(code) => {
                // A concurrent cancel already reset state to NotDownloaded —
                // don't clobber it with an Error the user didn't ask about.
                let still_downloading = matches!(
                    self.states.lock().unwrap().get(model_id),
                    Some(DownloadState::Downloading { .. })
                );
                if still_downloading {
                    self.set_state(model_id, DownloadState::Error { code: code.clone() });
                }
                Err(code)
            }
        }
    }

    /// Ensure the `llama-server` sidecar binary is installed at
    /// [`Self::binary_path`]. Downloads the per-host release archive via
    /// `fetcher`, verifies its SHA-256, then extracts the **entire** archive
    /// into [`Self::binary_dir`] (every platform's `archive_member` is `None`
    /// — see [`ServerBinaryAsset::archive_member`]): the `.exe`/`llama-server`
    /// binary is dynamically linked against companion DLLs/`.dylib`/`.so`
    /// files shipped alongside it in the same archive, so extracting only the
    /// binary would leave it unable to load them at launch. macOS/Linux
    /// `.tar.gz` archives additionally have their leading `llama-<tag>/` dir
    /// stripped so everything lands flat, same as the already-flat Windows
    /// `.zip`.
    ///
    /// On unix the exec bit (`0o755`) is set on the extracted binary.
    ///
    /// Idempotent: short-circuits to `Ok(())` if the binary is already
    /// present. Rejects unsupported hosts via
    /// [`super::server_binary::current_platform_asset`].
    pub async fn ensure_server_binary(
        &self,
        fetcher: &dyn LlmFetcher,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if self.is_binary_installed() {
            self.set_state(BINARY_KEY, DownloadState::Ready);
            return Ok(());
        }
        let asset =
            server_binary::current_platform_asset().map_err(|_e| "unsupported_host".to_string())?;

        self.set_state(BINARY_KEY, DownloadState::Downloading { progress: 0 });

        let bin_dir = self.binary_dir();
        fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

        // Download the archive to `{bin_dir}/{archive_filename}.part`. The
        // fetcher verifies the archive's SHA-256 before returning, so once it
        // succeeds the `.part` suffix is dropped by renaming to the final
        // archive path (keeping the original archive filename so the format
        // is self-describing for the extractor).
        let archive_name = archive_filename(asset);
        let archive_part = bin_dir.join(format!("{archive_name}.part"));
        let archive_final = bin_dir.join(&archive_name);

        let result = fetcher
            .fetch(
                asset.asset_url,
                &archive_part,
                asset.sha256,
                // Size unknown at this layer (the catalog pins sha only); pass
                // 0 so download_verified's size check is skipped — the SHA-256
                // is the authoritative verification for the archive.
                0,
                &|p| self.report_progress(BINARY_KEY, p),
                cancel,
            )
            .await;
        match result {
            Ok(()) => {
                // Rename `.part` → final archive path before extracting.
                if archive_part.exists() {
                    let _ = fs::remove_file(&archive_final);
                    fs::rename(&archive_part, &archive_final).map_err(|e| e.to_string())?;
                }
                // Extract only the member we care about.
                extract_member(&archive_final, asset, &self.binary_path())
                    .map_err(|e| format!("extract_failed: {e}"))?;
                set_exec_perm(&self.binary_path())?;
                self.set_state(BINARY_KEY, DownloadState::Ready);
                Ok(())
            }
            Err(code) => {
                let still_downloading = matches!(
                    self.states.lock().unwrap().get(BINARY_KEY),
                    Some(DownloadState::Downloading { .. })
                );
                if still_downloading {
                    self.set_state(BINARY_KEY, DownloadState::Error { code: code.clone() });
                }
                Err(code)
            }
        }
    }

    /// Delete a model's dir + ready marker and reset its state. No-op if
    /// nothing was downloaded. Reject-if-in-use is the command layer's job.
    pub fn remove_model(&self, model_id: &str) -> Result<(), String> {
        let dir = self.model_dir(model_id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        self.set_state(model_id, DownloadState::NotDownloaded);
        Ok(())
    }

    /// Wipe the entire [`Self::binary_dir`] (the `llama-server` binary plus
    /// companion dylibs/DLLs that live next to it) and reset [`BINARY_KEY`]
    /// to [`DownloadState::NotDownloaded`]. Missing dir is Ok. Stopping the
    /// sidecar is the command layer's job — this method only unlinks files.
    pub fn remove_binary(&self) -> Result<(), String> {
        let dir = self.binary_dir();
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        self.set_state(BINARY_KEY, DownloadState::NotDownloaded);
        Ok(())
    }

    // ─── Per-asset cancellation registry ──────────────────────────────────
    //
    // A download task registers its `CancellationToken` (keyed by model id)
    // before it starts fetching; the cancel command calls [`Self::cancel`],
    // which triggers the token. The fetcher ([`super::fetch::download_verified`])
    // honors the token between byte chunks, so cancel actually interrupts an
    // in-flight HTTP stream — unlike the embedding manager's best-effort
    // cancel, which can't break a blocking `fastembed` fetch.

    /// Register (or replace) the cancellation token for `key` and return the
    /// previously-registered token if any. The download task should pass the
    /// SAME token it will poll to `download_model`/`ensure_server_binary`.
    pub fn register_cancel(
        &self,
        key: &str,
        token: CancellationToken,
    ) -> Option<CancellationToken> {
        self.cancels.lock().unwrap().insert(key.to_string(), token)
    }

    /// Trigger the cancellation token for `key` (if registered) and drop the
    /// registration. No-op for an unknown key — calling cancel on a model that
    /// isn't downloading just returns `Ok(())`. Also resets the in-memory
    /// state to `NotDownloaded` so a subsequent `model_state`/`state` poll
    /// doesn't keep reporting `Downloading`.
    pub fn cancel(&self, key: &str) -> Result<(), String> {
        if let Some(token) = self.cancels.lock().unwrap().remove(key) {
            token.cancel();
        }
        let mut states = self.states.lock().unwrap();
        if let Some(state) = states.get(key) {
            if matches!(state, DownloadState::Downloading { .. }) {
                states.insert(key.to_string(), DownloadState::NotDownloaded);
            }
        }
        Ok(())
    }

    /// Remove and return the cancellation token for `key` without triggering
    /// it. Used by a download task on completion to clean up its own
    /// registration so a stale cancel after success is a no-op.
    pub fn take_cancel(&self, key: &str) -> Option<CancellationToken> {
        self.cancels.lock().unwrap().remove(key)
    }

    /// Walk `base_dir` and delete any `*.part` file older than
    /// [`STALE_PART_AGE`]. Safe to call on app start — only touches stale
    /// partial downloads left behind by a killed process.
    pub fn sweep_stale_parts(&self) -> Result<(), String> {
        let cutoff = SystemTime::now()
            .checked_sub(STALE_PART_AGE)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        sweep_dir(&self.base_dir, cutoff);
        Ok(())
    }
}

/// The original archive filename from the asset URL (e.g.
/// `llama-b10107-bin-macos-arm64.tar.gz` or `...win-cpu-x64.zip`). Used as
/// both the download target name and the format discriminator for extraction.
fn archive_filename(asset: &ServerBinaryAsset) -> String {
    asset
        .asset_url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("archive")
        .to_string()
}

/// Extract the server binary from the downloaded archive, per the asset's
/// `archive_member` directive:
/// - `None` (every current platform) — extract the **entire** archive into
///   the binary's install dir (`dest_binary.parent()`). Both the Windows
///   `.zip` (`llama-server.exe`) and the macOS/Linux `.tar.gz`
///   (`llama-server`) ship a thin binary that's dynamically linked against
///   companion libraries (DLLs / `.dylib` / `.so`) shipped alongside it in
///   the same archive — extracting only the binary would leave it unable to
///   load them at launch. The `.tar.gz` variant additionally has its
///   `llama-<tag>/` top-level dir stripped so entries land flat, matching the
///   already-flat `.zip` layout. After extraction `dest_binary` exists (e.g.
///   `{binary_dir}/llama-server` or `{binary_dir}/llama-server.exe`).
/// - `Some(member)` — extract only that one member into `dest_binary`. Not
///   used by any current catalog entry (kept for a future standalone-binary
///   asset).
///
/// `.zip` → `zip` crate; `.tar.gz` → `flate2` + `tar`.
fn extract_member(
    archive_path: &Path,
    asset: &ServerBinaryAsset,
    dest_binary: &Path,
) -> Result<(), String> {
    let install_dir = dest_binary
        .parent()
        .ok_or_else(|| format!("dest_binary {dest_binary:?} has no parent dir to extract into"))?;
    fs::create_dir_all(install_dir).map_err(|e| e.to_string())?;

    let name = archive_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    match asset.archive_member {
        None => {
            // Whole-archive extraction. Every current catalog asset uses this
            // (the binary + its companion DLL/.dylib/.so libs all need to
            // land together). The flat Windows `.zip` is unpacked as-is, no
            // top-level dir prefix; the macOS/Linux `.tar.gz` has its
            // `llama-<tag>/` top-level dir stripped so entries land flat too.
            if name.ends_with(".zip") {
                extract_zip_whole(archive_path, install_dir)
            } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
                extract_targz_whole(archive_path, install_dir)
            } else {
                Err(format!(
                    "unknown archive format for whole-archive extraction: {name}"
                ))
            }
        }
        Some(member) => {
            // Single-member extraction. The member is pulled out and written
            // to dest_binary regardless of its in-archive path.
            if name.ends_with(".zip") {
                extract_zip_member(archive_path, member, dest_binary)
            } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
                extract_targz_member(archive_path, member, dest_binary)
            } else {
                Err(format!("unknown archive format: {name}"))
            }
        }
    }
}

/// Extract every entry of a `.zip` into `dest_dir`. Creates `dest_dir` if
/// missing. Each entry's stored path is interpreted relative to `dest_dir`
/// (the Windows archive is flat, so entries land at `dest_dir/<name>`).
fn extract_zip_whole(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for idx in 0..archive.len() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| format!("zip entry {idx} unreadable: {e}"))?;
        // The Windows archive is flat (no leading dir). Normalize the path so
        // a stray absolute entry or `..` segment can't escape dest_dir, and a
        // directory entry just creates the dir.
        let entry_path = match entry.enclosed_name() {
            Some(p) => p,
            None => continue,
        };
        let out_path = dest_dir.join(entry_path);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Extract every entry of a `.tar.gz` into `dest_dir`, **stripping the
/// leading path component** (the archive's top-level `llama-<tag>/` dir) from
/// every entry so everything lands flat: `llama-b10107/llama-server` ->
/// `dest_dir/llama-server`, `llama-b10107/libggml.dylib` ->
/// `dest_dir/libggml.dylib`. This is the macOS/Linux path: `llama-server` is
/// dynamically linked against companion `.dylib`/`.so` files shipped
/// alongside it under that same top-level dir, so both the binary and its
/// libs need to land next to each other (flat, no nested subdir) for dyld /
/// ld.so's `@rpath`/`RPATH` lookup to find them. Creates `dest_dir` if
/// missing. Preserves each entry's mode bits (so llama.cpp's executable bit
/// on `llama-server` survives extraction) via `preserve_permissions`.
fn extract_targz_whole(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    archive.set_overwrite(true);
    archive.set_preserve_permissions(true);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();

        // Drop the top-level `llama-<tag>/` dir component so every entry
        // lands flat in dest_dir.
        let mut components = entry_path.components();
        components.next();
        let rel: PathBuf = components.collect();
        if rel.as_os_str().is_empty() {
            // The bare top-level dir entry itself — nothing left to extract.
            continue;
        }
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("unsafe archive entry path: {entry_path:?}"));
        }

        let out_path = dest_dir.join(&rel);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        entry.unpack(&out_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Pull `member` out of a `.zip` into `dest_binary`. Creates the parent dir
/// of `dest_binary` if missing (the binary install path always sits under a
/// versioned dir that may not exist on a fresh install).
fn extract_zip_member(archive_path: &Path, member: &str, dest_binary: &Path) -> Result<(), String> {
    if let Some(parent) = dest_binary.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut entry = archive
        .by_name(member)
        .map_err(|e| format!("member {member:?} not in archive: {e}"))?;
    let mut out = fs::File::create(dest_binary).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    Ok(())
}

/// Pull `member` out of a `.tar.gz` into `dest_binary`. Creates the parent
/// dir of `dest_binary` if missing.
fn extract_targz_member(
    archive_path: &Path,
    member: &str,
    dest_binary: &Path,
) -> Result<(), String> {
    if let Some(parent) = dest_binary.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?;
        if path.to_string_lossy() == member {
            let mut out = fs::File::create(dest_binary).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err(format!("member {member:?} not in archive"))
}

/// On unix, set the executable bit (`0o755`) on the freshly-extracted binary.
/// No-op on windows (the `.exe` extension + archive bit suffice).
#[cfg(unix)]
fn set_exec_perm(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_exec_perm(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Recursively walk `dir` deleting `*.part` files with mtime older than
/// `cutoff`. Symlinks are not followed; missing dirs are silently skipped
/// (nothing to sweep).
fn sweep_dir(dir: &Path, cutoff: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.is_dir() {
            sweep_dir(&path, cutoff);
        } else if metadata.is_file() {
            if path.extension().and_then(|e| e.to_str()) == Some("part") {
                if let Ok(mtime) = metadata.modified() {
                    if mtime < cutoff {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    /// A fake fetcher that writes a caller-supplied byte blob to `dest_path`
    /// (mirroring production: the fetcher is responsible for the verified
    /// write), ticks progress, and records its call count. `Err` variant
    /// returns the supplied error string to exercise the Error-state path.
    struct FakeFetcher {
        body: Vec<u8>,
        err: Option<String>,
        calls: StdMutex<u32>,
    }

    impl FakeFetcher {
        fn ok(body: Vec<u8>) -> Self {
            Self {
                body,
                err: None,
                calls: StdMutex::new(0),
            }
        }
        fn err(code: &str) -> Self {
            Self {
                body: Vec::new(),
                err: Some(code.to_string()),
                calls: StdMutex::new(0),
            }
        }
        fn call_count(&self) -> u32 {
            *self.calls.lock().unwrap()
        }
    }

    #[async_trait]
    impl LlmFetcher for FakeFetcher {
        async fn fetch(
            &self,
            _url: &str,
            dest_path: &Path,
            _sha256: &str,
            _size: u64,
            progress: &(dyn Fn(u8) + Send + Sync),
            _cancel: &CancellationToken,
        ) -> Result<(), String> {
            *self.calls.lock().unwrap() += 1;
            progress(0);
            if let Some(code) = &self.err {
                return Err(code.clone());
            }
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(dest_path, &self.body).unwrap();
            progress(100);
            Ok(())
        }
    }

    fn manager(tmp: &tempfile::TempDir) -> LlmAssetManager {
        LlmAssetManager::new(tmp.path().to_path_buf())
    }

    // ─── 1. model state transitions: NotDownloaded → Downloading → Ready ──

    #[tokio::test]
    async fn model_download_transitions_to_ready_and_writes_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = Arc::new(manager(&tmp));
        let id = llm_catalog::GEMMA_4_E4B_IT;

        // Mid-flight snapshot captured inside the progress callback — proves
        // state was Downloading{progress} while the fetch was in flight.
        let mid_flight: Arc<StdMutex<Option<DownloadState>>> = Arc::new(StdMutex::new(None));
        let body = vec![0xABu8; 1024];

        // Fetcher that captures model_state(id) at the 50% tick. Holds an
        // Arc<LlmAssetManager> so the closure can read live state.
        let mgr_for_fetch = mgr.clone();
        let mid_for_fetch = mid_flight.clone();
        let fetcher = StateCapturingFetcher {
            body: body.clone(),
            on_mid: Box::new(move || {
                *mid_for_fetch.lock().unwrap() = Some(mgr_for_fetch.model_state(id));
            }),
        };

        assert_eq!(
            mgr.model_state(id),
            DownloadState::NotDownloaded,
            "fresh model must read NotDownloaded"
        );

        mgr.download_model(id, &fetcher, &CancellationToken::new())
            .await
            .expect("happy-path download must succeed");

        assert_eq!(
            *mid_flight.lock().unwrap(),
            Some(DownloadState::Downloading { progress: 50 }),
            "state must read Downloading{{progress}} mid-fetch"
        );
        assert_eq!(mgr.model_state(id), DownloadState::Ready);
        assert!(mgr.is_model_downloaded(id), "ready marker must exist");
        assert!(
            mgr.model_gguf_path(id).exists(),
            "gguf file must exist at the canonical path"
        );
        assert_eq!(
            fs::read(mgr.model_gguf_path(id)).unwrap(),
            body,
            "gguf bytes must match the fetched body"
        );
    }

    /// Fetcher that writes `body` and invokes `on_mid` between progress ticks
    /// — used to snapshot in-memory state mid-flight.
    struct StateCapturingFetcher {
        body: Vec<u8>,
        on_mid: Box<dyn Fn() + Send + Sync>,
    }

    #[async_trait]
    impl LlmFetcher for StateCapturingFetcher {
        async fn fetch(
            &self,
            _url: &str,
            dest_path: &Path,
            _sha256: &str,
            _size: u64,
            progress: &(dyn Fn(u8) + Send + Sync),
            _cancel: &CancellationToken,
        ) -> Result<(), String> {
            progress(0);
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(dest_path, &self.body).unwrap();
            progress(50);
            (self.on_mid)();
            progress(100);
            Ok(())
        }
    }

    // ─── 2. fetch error → Error{code}, marker NOT written, gguf absent ─────

    #[tokio::test]
    async fn model_download_error_state_and_no_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = llm_catalog::GEMMA_4_E2B_IT;
        let fetcher = FakeFetcher::err("download_http");

        let err = mgr
            .download_model(id, &fetcher, &CancellationToken::new())
            .await
            .expect_err("fetcher error must propagate");
        assert_eq!(err, "download_http");
        assert_eq!(
            mgr.model_state(id),
            DownloadState::Error {
                code: "download_http".to_string()
            }
        );
        assert!(!mgr.is_model_downloaded(id), "marker must NOT be written");
        assert!(
            !mgr.model_gguf_path(id).exists(),
            "gguf file must be absent on error"
        );
    }

    // ─── 3. remove_model deletes the dir and resets state ─────────────────

    #[tokio::test]
    async fn remove_model_deletes_dir_and_resets_state() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = llm_catalog::GEMMA_4_12B_IT;
        let fetcher = FakeFetcher::ok(vec![1, 2, 3, 4]);
        mgr.download_model(id, &fetcher, &CancellationToken::new())
            .await
            .unwrap();
        assert!(mgr.is_model_downloaded(id));
        assert!(mgr.model_dir(id).exists());

        mgr.remove_model(id).unwrap();

        assert!(!mgr.is_model_downloaded(id));
        assert!(!mgr.model_dir(id).exists(), "model dir must be gone");
        assert_eq!(mgr.model_state(id), DownloadState::NotDownloaded);
    }

    // ─── 4. ensure_server_binary: install, exec perms, idempotent ─────────

    #[tokio::test]
    async fn ensure_server_binary_extracts_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);

        let asset = server_binary::current_platform_asset().expect("test host must be supported");
        let payload = b"#!/bin/sh\necho i am llama-server\n".to_vec();

        // Build a real in-memory archive matching the asset's actual format
        // (all current catalog entries are whole-archive: flat .zip on
        // Windows, top-dir .tar.gz on macOS/Linux).
        let archive_bytes = build_archive_bytes(asset, &payload);

        let fetcher = FakeFetcher::ok(archive_bytes);
        assert!(!mgr.is_binary_installed(), "binary must not exist yet");

        mgr.ensure_server_binary(&fetcher, &CancellationToken::new())
            .await
            .expect("ensure must succeed on supported host");

        let bin = mgr.binary_path();
        assert!(bin.is_file(), "extracted binary must exist");
        assert_eq!(
            fs::read(&bin).unwrap(),
            payload,
            "extracted bytes must match the archive member"
        );
        // Whole-archive extraction must also land the companion libs flat in
        // binary_dir, next to the binary — that's the whole point of the fix
        // (dyld/ld.so and the Windows loader both need them there).
        let bin_dir = mgr.binary_dir();
        let (companion_a, companion_b) = if asset.asset_url.ends_with(".zip") {
            ("ggml-base.dll", "llama.dll")
        } else {
            ("libggml-base.dylib", "libllama.dylib")
        };
        assert!(
            bin_dir.join(companion_a).is_file(),
            "whole-archive extraction must land companion libs flat in binary_dir"
        );
        assert!(
            bin_dir.join(companion_b).is_file(),
            "whole-archive extraction must land companion libs flat in binary_dir"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&bin).unwrap().permissions().mode();
            assert!(
                mode & 0o111 != 0,
                "exec bit must be set on unix, got mode {:o}",
                mode
            );
        }
        assert_eq!(mgr.state(BINARY_KEY), DownloadState::Ready);

        let calls_after_first = fetcher.call_count();
        assert_eq!(
            calls_after_first, 1,
            "fetcher must run exactly once on install"
        );

        // Second call short-circuits — binary already present.
        mgr.ensure_server_binary(&fetcher, &CancellationToken::new())
            .await
            .expect("idempotent second call must succeed");
        assert_eq!(
            fetcher.call_count(),
            calls_after_first,
            "fetcher must NOT run again when binary is already installed"
        );
    }

    // ─── 5. ensure_server_binary fetcher error → Error, no binary ─────────

    #[tokio::test]
    async fn ensure_server_binary_error_state_and_no_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let fetcher = FakeFetcher::err("download_io");

        let err = mgr
            .ensure_server_binary(&fetcher, &CancellationToken::new())
            .await
            .expect_err("fetcher error must propagate");
        assert_eq!(err, "download_io");
        assert_eq!(
            mgr.state(BINARY_KEY),
            DownloadState::Error {
                code: "download_io".to_string()
            }
        );
        assert!(
            !mgr.is_binary_installed(),
            "binary must not exist after a failed fetch"
        );
    }

    // ─── 5b. model_on_disk_bytes: .part / final-gguf / neither ────────────

    #[test]
    fn model_on_disk_bytes_is_zero_when_nothing_downloaded() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        assert_eq!(mgr.model_on_disk_bytes(llm_catalog::GEMMA_4_E4B_IT), 0);
    }

    #[test]
    fn model_on_disk_bytes_reads_the_in_flight_part_file_length() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = llm_catalog::GEMMA_4_E4B_IT;

        let final_path = mgr.model_gguf_path(id);
        fs::create_dir_all(final_path.parent().unwrap()).unwrap();
        let part_path = super::super::fetch::part_path(&final_path);
        fs::write(&part_path, vec![0u8; 12345]).unwrap();

        assert_eq!(
            mgr.model_on_disk_bytes(id),
            12345,
            "must read the .part file's current byte length while streaming"
        );
    }

    #[test]
    fn model_on_disk_bytes_reports_catalog_size_once_final_gguf_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = llm_catalog::GEMMA_4_E4B_IT;
        let expected_total = llm_catalog::find(id).unwrap().download_size_bytes;

        // The final file's real length is irrelevant here — `download_verified`
        // only ever renames `.part` -> final after its own exact-size check
        // passed, so the catalog's pinned size is the trusted "100%" value,
        // not whatever tiny stub this test writes.
        let final_path = mgr.model_gguf_path(id);
        fs::create_dir_all(final_path.parent().unwrap()).unwrap();
        fs::write(&final_path, b"stub").unwrap();

        assert_eq!(mgr.model_on_disk_bytes(id), expected_total);
    }

    // ─── 5c. binary_dir_size_bytes + remove_binary ────────────────────────

    fn seed_dummy_binary(mgr: &LlmAssetManager) {
        let dir = mgr.binary_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(mgr.binary_path(), b"dummy-llama-server").unwrap();
        fs::write(dir.join("companion.dll"), b"lib").unwrap();
    }

    #[test]
    fn binary_dir_size_bytes_is_zero_when_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        assert_eq!(mgr.binary_dir_size_bytes(), 0);
    }

    #[test]
    fn binary_dir_size_bytes_sums_binary_and_companion_files() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        seed_dummy_binary(&mgr);
        let expected = b"dummy-llama-server".len() as u64 + b"lib".len() as u64;
        assert_eq!(mgr.binary_dir_size_bytes(), expected);
    }

    #[test]
    fn remove_binary_deletes_dir_and_resets_state() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        seed_dummy_binary(&mgr);
        assert!(mgr.is_binary_installed());
        assert_eq!(mgr.state(BINARY_KEY), DownloadState::Ready);

        mgr.remove_binary().unwrap();

        assert!(
            !mgr.is_binary_installed(),
            "llama-server must be gone after remove_binary"
        );
        assert!(
            !mgr.binary_dir().exists(),
            "whole binary_dir (companions included) must be gone"
        );
        assert_eq!(mgr.state(BINARY_KEY), DownloadState::NotDownloaded);
        assert_eq!(mgr.binary_dir_size_bytes(), 0);
    }

    #[test]
    fn remove_binary_missing_dir_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        assert!(!mgr.binary_dir().exists());
        mgr.remove_binary()
            .expect("missing binary dir must be Ok, not an error");
        assert_eq!(mgr.state(BINARY_KEY), DownloadState::NotDownloaded);
    }

    // ─── 6. model_state for unknown id returns NotDownloaded (no panic) ────

    #[tokio::test]
    async fn unknown_model_id_returns_not_downloaded() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        assert_eq!(
            mgr.model_state("not-a-real-model-id"),
            DownloadState::NotDownloaded,
            "unknown id must read NotDownloaded, not panic"
        );
        assert!(!mgr.is_model_downloaded("not-a-real-model-id"));
    }

    // ─── 7. sweep_stale_parts: 8 days old → removed, 1 day old → kept ─────
    //
    // mtime backdating is unix-only here (no std API on windows, and the
    // CI/test host is unix). The sweep logic itself is platform-agnostic.

    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_removes_old_parts_keeps_recent() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);

        let models = tmp.path().join("models").join("some-model");
        fs::create_dir_all(&models).unwrap();
        let old_part = models.join("model.gguf.part");
        let fresh_part = models.join("other.part");
        fs::write(&old_part, b"old").unwrap();
        fs::write(&fresh_part, b"fresh").unwrap();

        // 8 days ago → past the 7-day cutoff; 1 day ago → within it.
        set_mtime_secs_ago(&old_part, 8 * 86400);
        set_mtime_secs_ago(&fresh_part, 1 * 86400);

        mgr.sweep_stale_parts().unwrap();

        assert!(!old_part.exists(), "8-day-old .part must be swept");
        assert!(fresh_part.exists(), "1-day-old .part must be kept");
    }

    /// Backdate a file's mtime by `secs` (unix only, via `libc::utimes` —
    /// `libc` is already a dep on unix, so no new crate needed for the test).
    #[cfg(unix)]
    fn set_mtime_secs_ago(path: &Path, secs: u64) {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        // tv_sec is absolute seconds since epoch. Negative values would be
        // pre-epoch; we only ever pass positive offsets back from now.
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let target = now - secs as i64;
        let times = libc::timeval {
            tv_sec: target,
            tv_usec: 0,
        };
        let times_arr = [times, times];
        let rc = unsafe { libc::utimes(c_path.as_ptr(), times_arr.as_ptr()) };
        assert_eq!(rc, 0, "libc::utimes must succeed for {:?}", path);
    }

    // ─── 7b. cancel-registry: register -> cancel triggers the token ───────

    #[tokio::test]
    async fn register_then_cancel_triggers_the_token() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let token = CancellationToken::new();
        let cloned = token.clone();

        // First registration for a fresh key returns None.
        assert!(mgr.register_cancel("gemma-4-e4b-it", token).is_none());

        mgr.cancel("gemma-4-e4b-it").unwrap();
        assert!(
            cloned.is_cancelled(),
            "cancel must trigger the currently-registered token"
        );

        // After cancel the registration is consumed — a second cancel is a no-op.
        mgr.cancel("gemma-4-e4b-it").unwrap();
        assert!(
            mgr.take_cancel("gemma-4-e4b-it").is_none(),
            "registration must be consumed by the first cancel"
        );
    }

    #[tokio::test]
    async fn reregister_returns_the_previous_token() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let first = CancellationToken::new();
        mgr.register_cancel("gemma-4-e2b-it", first.clone());
        let second = CancellationToken::new();
        let prev = mgr.register_cancel("gemma-4-e2b-it", second.clone());
        assert!(
            prev.is_some(),
            "re-registering must return the previous token"
        );
        // The old token is handed back uncancelled — only cancel() triggers it.
        assert!(
            !first.is_cancelled(),
            "returned token must not be pre-cancelled"
        );

        // cancel fires the CURRENT (second) token, not the superseded first.
        mgr.cancel("gemma-4-e2b-it").unwrap();
        assert!(
            second.is_cancelled(),
            "cancel must trigger the current token"
        );
        assert!(
            !first.is_cancelled(),
            "superseded token must remain untriggered"
        );
    }

    #[tokio::test]
    async fn cancel_of_unknown_id_is_a_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        // Unknown id — must NOT panic, must NOT error.
        mgr.cancel("never-registered").unwrap();
        assert!(mgr.take_cancel("never-registered").is_none());
    }

    // ─── 8. zip extraction (Windows format) — independent of host OS ──────
    //
    // Builds a real `.zip` in-test with the `zip` crate containing the
    // `archive_member` path → dummy `llama-server.exe` bytes, then drives the
    // extractor directly. Tests the extraction logic without a network and on
    // any host (not gated to windows).

    #[test]
    fn extract_zip_member_pulls_the_named_entry() {
        // Exercises the single-member zip path (archive_member = Some(member)).
        // The Windows catalog asset is whole-archive (None), so use a concrete
        // member path here to test the Some-path extractor directly.
        let tmp = tempfile::tempdir().unwrap();
        let member = "llama-server.exe";
        let payload = b"MZ\x90\x00 fake llama-server.exe payload".to_vec();

        let archive_path = tmp.path().join("win.zip");
        write_zip_with_member(&archive_path, member, &payload);

        let dest = tmp.path().join("out").join("llama-server.exe");
        extract_zip_member(&archive_path, member, &dest).expect("zip extraction must succeed");
        assert_eq!(fs::read(&dest).unwrap(), payload);
    }

    #[test]
    fn extract_zip_member_missing_entry_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let archive_path = tmp.path().join("win.zip");
        write_zip_with_member(&archive_path, "other.bin", b"x");

        let dest = tmp.path().join("out.bin");
        let err = extract_zip_member(&archive_path, "llama-server.exe", &dest)
            .expect_err("missing member must error");
        assert!(err.contains("not in archive"));
    }

    // ─── 8a. whole-archive zip extraction (Windows None path) ──────────────
    //
    // The Windows `llama-server.exe` is a thin launcher shim (~9 KB) that
    // depends on a DLL bundle shipped in the same flat zip. archive_member =
    // None tells the extractor to unpack the ENTIRE archive into binary_dir so
    // the .exe finds its DLLs. This test builds a flat multi-entry zip and
    // asserts every entry lands in the install dir.

    #[test]
    fn extract_member_whole_archive_lands_every_entry_in_binary_dir() {
        let tmp = tempfile::tempdir().unwrap();

        // A Windows-shaped asset: .zip URL + archive_member = None.
        let asset = ServerBinaryAsset {
            os: "windows",
            arch: "x86_64",
            asset_url:
                "https://github.com/ggml-org/llama.cpp/releases/download/b10107/fake-win-cpu-x64.zip",
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            archive_member: None,
            display_name: "Fake Windows (x64)",
        };
        let exe_bytes = b"MZ\x90\x00 fake llama-server.exe payload".to_vec();

        // Build a flat zip with the .exe + two companion DLLs, exactly like the
        // real Windows archive layout (no top-level dir prefix).
        let archive_path = tmp.path().join("win.zip");
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        zip_multiple_flat_into(
            &mut buf,
            &[
                ("llama-server.exe", &exe_bytes),
                ("ggml-base.dll", b"Zfake ggml-base.dll"),
                ("llama.dll", b"Zfake llama.dll"),
            ],
        );
        fs::write(&archive_path, buf.into_inner()).unwrap();

        // dest_binary = binary_dir/llama-server.exe — its parent is the install
        // dir the whole archive is unpacked into.
        let binary_dir = tmp
            .path()
            .join("bin")
            .join(server_binary::SERVER_VERSION_TAG);
        let dest_binary = binary_dir.join("llama-server.exe");

        extract_member(&archive_path, &asset, &dest_binary)
            .expect("whole-archive extraction must succeed");

        // All three entries must land in binary_dir.
        assert!(
            dest_binary.is_file(),
            "llama-server.exe must land in binary_dir"
        );
        assert_eq!(
            fs::read(&dest_binary).unwrap(),
            exe_bytes,
            "the .exe entry's bytes must be preserved verbatim"
        );
        assert!(
            binary_dir.join("ggml-base.dll").is_file(),
            "companion ggml-base.dll must land in binary_dir"
        );
        assert!(
            binary_dir.join("llama.dll").is_file(),
            "companion llama.dll must land in binary_dir"
        );
    }

    #[test]
    fn extract_zip_whole_is_a_noop_on_an_empty_archive() {
        // An empty zip (zero entries) must not error — every entry loop body
        // is skipped. The dest_dir is still created.
        let tmp = tempfile::tempdir().unwrap();
        let archive_path = tmp.path().join("empty.zip");
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        let zw = zip::ZipWriter::new(&mut buf);
        zw.finish().unwrap();
        fs::write(&archive_path, buf.into_inner()).unwrap();

        let dest_dir = tmp.path().join("out");
        extract_zip_whole(&archive_path, &dest_dir).expect("empty zip must not error");
        assert!(
            dest_dir.is_dir(),
            "dest_dir must be created even for an empty archive"
        );
    }

    // ─── 8b. whole-archive tar.gz extraction with top-dir strip (macOS/Linux
    //         None path) — this is the actual bug fix under test ───────────
    //
    // The real macOS/Linux `llama-server` is dynamically linked against
    // companion `.dylib`/`.so` libraries shipped alongside it under a single
    // top-level `llama-<tag>/` dir in the release `.tar.gz`. archive_member =
    // None tells the extractor to unpack the ENTIRE archive — stripping that
    // top-level dir so the binary + its libs land FLAT in binary_dir, right
    // next to each other (mirroring the Windows whole-archive zip test
    // above). Before this fix, only `llama-server` itself was pulled out
    // (single-member extraction) and the companion libs were left behind,
    // so dyld couldn't resolve them and the sidecar died before /health ever
    // answered — the root cause of the reported `start_timeout`.

    #[test]
    fn extract_member_whole_archive_targz_strips_top_dir_and_lands_everything_flat() {
        let tmp = tempfile::tempdir().unwrap();

        // A macOS-shaped asset: .tar.gz URL + archive_member = None.
        let asset = ServerBinaryAsset {
            os: "macos",
            arch: "aarch64",
            asset_url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/fake-macos-arm64.tar.gz",
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            archive_member: None,
            display_name: "Fake macOS (Apple Silicon)",
        };
        let server_bytes = b"#!/bin/sh\necho i am llama-server\n".to_vec();

        // Build a tar.gz with llama-server + two companion .dylib files, all
        // nested under a top-level `llama-b10107/` dir — exactly like the
        // real release archive layout.
        let top_dir = format!("llama-{}", server_binary::SERVER_VERSION_TAG);
        let archive_bytes = targz_multiple_under_dir_into(
            &top_dir,
            &[
                ("llama-server", &server_bytes, 0o755),
                ("libggml-base.dylib", b"Zfake libggml-base.dylib", 0o644),
                ("libllama.dylib", b"Zfake libllama.dylib", 0o644),
            ],
        );
        let archive_path = tmp.path().join("mac.tar.gz");
        fs::write(&archive_path, &archive_bytes).unwrap();

        let binary_dir = tmp
            .path()
            .join("bin")
            .join(server_binary::SERVER_VERSION_TAG);
        let dest_binary = binary_dir.join("llama-server");

        extract_member(&archive_path, &asset, &dest_binary)
            .expect("whole-archive tar.gz extraction must succeed");

        // Every entry lands FLAT in binary_dir — no nested llama-b10107/ dir.
        assert!(
            dest_binary.is_file(),
            "llama-server must land directly in binary_dir"
        );
        assert_eq!(
            fs::read(&dest_binary).unwrap(),
            server_bytes,
            "llama-server bytes must be preserved verbatim"
        );
        assert!(
            binary_dir.join("libggml-base.dylib").is_file(),
            "companion libggml-base.dylib must land flat in binary_dir"
        );
        assert!(
            binary_dir.join("libllama.dylib").is_file(),
            "companion libllama.dylib must land flat in binary_dir"
        );
        assert!(
            !binary_dir.join(&top_dir).exists(),
            "no nested llama-<tag>/ subdir must remain after stripping"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&dest_binary).unwrap().permissions().mode();
            assert!(
                mode & 0o111 != 0,
                "llama-server exec bit must survive extraction, got mode {:o}",
                mode
            );
        }

        // Drive it through the manager end-to-end too: binary_path()
        // resolves and is_binary_installed() is true.
        let mgr = LlmAssetManager::new(tmp.path().to_path_buf());
        assert_eq!(mgr.binary_path(), dest_binary);
        assert!(
            mgr.is_binary_installed(),
            "is_binary_installed() must be true once llama-server exists at binary_path()"
        );
    }

    // ─── 8c. tar.gz single-member extraction (kept for a future standalone
    //         binary asset — not used by any current catalog entry) ───────

    #[test]
    fn extract_targz_member_pulls_the_named_entry() {
        // No current catalog asset uses single-member extraction anymore (all
        // are whole-archive — see server_binary::ServerBinaryAsset::archive_member),
        // so this exercises extract_targz_member() directly with a literal
        // member path rather than via the catalog.
        let tmp = tempfile::tempdir().unwrap();
        let member = "llama-b10107/llama-server";
        let payload = b"#!/bin/sh\necho llama\n".to_vec();

        let archive_path = tmp.path().join("mac.tar.gz");
        write_targz_with_member(&archive_path, member, &payload);

        let dest = tmp.path().join("out").join("llama-server");
        extract_targz_member(&archive_path, member, &dest).expect("tar.gz extraction must succeed");
        assert_eq!(fs::read(&dest).unwrap(), payload);
    }

    #[test]
    fn extract_targz_member_missing_entry_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let archive_path = tmp.path().join("mac.tar.gz");
        write_targz_with_member(&archive_path, "some/other.bin", b"x");

        let dest = tmp.path().join("out.bin");
        let err = extract_targz_member(&archive_path, "llama-b10107/llama-server", &dest)
            .expect_err("missing member must error");
        assert!(err.contains("not in archive"));
    }

    // ─── archive_filename derivation ──────────────────────────────────────

    #[test]
    fn archive_filename_uses_url_basename() {
        let asset = server_binary::find_asset("macos", "aarch64").unwrap();
        assert_eq!(
            archive_filename(asset),
            "llama-b10107-bin-macos-arm64.tar.gz"
        );
        let win = server_binary::find_asset("windows", "x86_64").unwrap();
        assert_eq!(archive_filename(win), "llama-b10107-bin-win-cpu-x64.zip");
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    /// Build whole-archive bytes matching the asset's real format (every
    /// current catalog entry is whole-archive — `archive_member: None`):
    /// - `.zip` (Windows) — a flat multi-entry zip mirroring the real
    ///   archive: `llama-server.exe` at the root plus a couple of dummy
    ///   companion DLLs, no top-level dir.
    /// - `.tar.gz` (macOS/Linux) — a multi-entry tar.gz mirroring the real
    ///   archive layout: `llama-server` plus a couple of dummy companion
    ///   `.dylib` files, all nested under a top-level `llama-<tag>/` dir that
    ///   the extractor must strip.
    fn build_archive_bytes(asset: &ServerBinaryAsset, payload: &[u8]) -> Vec<u8> {
        if asset.asset_url.ends_with(".zip") {
            let mut buf = std::io::Cursor::new(Vec::<u8>::new());
            zip_multiple_flat_into(
                &mut buf,
                &[
                    ("llama-server.exe", payload),
                    ("ggml-base.dll", b"Zfake ggml-base.dll"),
                    ("llama.dll", b"Zfake llama.dll"),
                ],
            );
            buf.into_inner()
        } else {
            let top_dir = format!("llama-{}", server_binary::SERVER_VERSION_TAG);
            targz_multiple_under_dir_into(
                &top_dir,
                &[
                    ("llama-server", payload, 0o755),
                    ("libggml-base.dylib", b"Zfake libggml-base.dylib", 0o755),
                    ("libllama.dylib", b"Zfake libllama.dylib", 0o755),
                ],
            )
        }
    }

    fn zip_multiple_flat_into<W: std::io::Write + std::io::Seek>(
        buf: &mut W,
        members: &[(&str, &[u8])],
    ) {
        let mut zw = zip::ZipWriter::new(buf);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, payload) in members {
            zw.start_file(name, opts).unwrap();
            std::io::Write::write_all(&mut zw, payload).unwrap();
        }
        zw.finish().unwrap();
    }

    fn write_zip_with_member(path: &Path, member: &str, payload: &[u8]) {
        let file = fs::File::create(path).unwrap();
        let mut buf = std::io::BufWriter::new(file);
        zip_member_into(&mut buf, member, payload);
    }

    fn zip_member_into<W: std::io::Write + std::io::Seek>(
        buf: &mut W,
        member: &str,
        payload: &[u8],
    ) {
        let mut zw = zip::ZipWriter::new(buf);
        let opts = zip::write::SimpleFileOptions::default();
        zw.start_file(member, opts).unwrap();
        std::io::Write::write_all(&mut zw, payload).unwrap();
        zw.finish().unwrap();
    }

    fn write_targz_with_member(path: &Path, member: &str, payload: &[u8]) {
        let file = fs::File::create(path).unwrap();
        let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut builder = tar::Builder::new(gz);
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, member, std::io::Cursor::new(payload))
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }

    /// Build a `.tar.gz` in memory with every `(name, payload, mode)` nested
    /// under a single top-level `{top_dir}/` dir — mirroring the real
    /// llama.cpp macOS/Linux release layout (`llama-b10107/llama-server`,
    /// `llama-b10107/libggml-base.dylib`, ...) that the whole-archive
    /// extractor must strip.
    fn targz_multiple_under_dir_into(top_dir: &str, members: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let buf = Vec::new();
        let gz = flate2::write::GzEncoder::new(buf, flate2::Compression::default());
        let mut builder = tar::Builder::new(gz);
        for (name, payload, mode) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(*mode);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    format!("{top_dir}/{name}"),
                    std::io::Cursor::new(*payload),
                )
                .unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }
}
