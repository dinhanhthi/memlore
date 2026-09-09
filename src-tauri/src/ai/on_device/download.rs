//! Opt-in, cached, resumable on-device model download manager (Phase 4 Task 2).
//!
//! Downloads are triggered **only** by the command layer
//! (`commands/ai_provider.rs`) when the user opts into on-device embedding
//! and picks a model — nothing in this module starts a download on its own.
//!
//! The actual byte fetch is behind [`ModelFetcher`] so production code can
//! wrap `fastembed`'s own (resumable, cache-deduping) Hugging Face Hub
//! downloader, while tests inject a fake that never touches the network —
//! a real download is a manual smoke check, not a unit test.
//!
//! **Detecting "already downloaded":** this manager does not reverse-engineer
//! `hf_hub`'s internal `models--<org>--<repo>/snapshots/<commit>/...` cache
//! layout — resolving the current commit hash requires a network round
//! trip even just to check what's cached. Instead the manager owns a small
//! ready-marker file per model under its own `<cache_dir>/<model_id>/`
//! directory, written only after a fetch fully succeeds.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::catalog::{self, OnDeviceModel};

const READY_MARKER: &str = ".on_device_ready";

/// Recursive on-disk byte size of everything under `path`. Used to poll
/// real download progress against a model's known approximate total
/// (`OnDeviceModel::download_size_bytes`) since `fastembed`'s `hf_hub`
/// backend has no incremental byte-progress callback of its own — but it
/// does write files straight into the destination dir as bytes land, so
/// this is a faithful (if approximate, since the final total isn't known
/// until the download manifest is fetched) progress signal. A missing
/// directory (download hasn't started yet) reads as `0`, not an error.
pub fn dir_size_bytes(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            total += dir_size_bytes(&entry_path);
        } else if let Ok(metadata) = entry.metadata() {
            total += metadata.len();
        }
    }
    total
}

/// Percent complete for the dir-size download poller: `on_disk` bytes over
/// a known-approximate `total` (`OnDeviceModel::download_size_bytes`),
/// clamped to 99 — the poller only ever observes an in-flight download, so
/// it must never itself claim 100% (the fetch's own terminal tick owns
/// that, once `fastembed` confirms the model actually loads). `total == 0`
/// (unknown size) reads as 0 rather than dividing by zero.
pub fn download_percent(on_disk: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    on_disk.saturating_mul(100).saturating_div(total).min(99) as u8
}

/// Per-model download state exposed to the UI — mirrors
/// `ModelDownloadStatus` in `src/hooks/useOnDeviceModels.ts` plus a payload.
///
/// `Serialize` (via `#[serde(tag = "status")]`) so the on-device LLM command
/// layer can emit it directly to the frontend without a manual wire-type
/// conversion; the embedding command layer keeps its own
/// `OnDeviceModelStateWire` for backwards-compat with the existing frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DownloadState {
    NotDownloaded,
    Downloading { progress: u8 },
    Ready,
    Error { code: String },
}

/// Injectable byte-fetcher for a model's weights.
pub trait ModelFetcher: Send + Sync {
    /// Fetch `model`'s weights into `dest_dir`, calling `on_progress` with
    /// 0-100 as work completes. `Ok(())` means `dest_dir` holds everything
    /// needed to load the model. `Err(code)` — `code` lands in
    /// `DownloadState::Error` and is shown verbatim in the model card: it
    /// is either a short stable code the UI localizes (e.g. the
    /// `not_supported` branch) or a full human-readable error chain (the
    /// `FastembedFetcher` network path) — do NOT truncate it back to a
    /// bare code, the UI relies on the detail to explain WHY a download
    /// failed.
    fn fetch(
        &self,
        model: &OnDeviceModel,
        dest_dir: &Path,
        on_progress: &dyn Fn(u8),
    ) -> Result<(), String>;
}

/// Blanket impl so ad-hoc closures (mostly tests) can act as a fetcher
/// without a wrapper type.
impl<T> ModelFetcher for T
where
    T: Fn(&OnDeviceModel, &Path, &dyn Fn(u8)) -> Result<(), String> + Send + Sync,
{
    fn fetch(
        &self,
        model: &OnDeviceModel,
        dest_dir: &Path,
        on_progress: &dyn Fn(u8),
    ) -> Result<(), String> {
        self(model, dest_dir, on_progress)
    }
}

/// Production fetcher: wraps `fastembed::TextEmbedding::try_new`, whose
/// `hf_hub` backend already resumes partial downloads and skips
/// re-downloading cached files — this is where "resumable" comes from.
/// Real, on-network use only; never invoked from tests.
pub struct FastembedFetcher;

impl ModelFetcher for FastembedFetcher {
    fn fetch(
        &self,
        model: &OnDeviceModel,
        dest_dir: &Path,
        on_progress: &dyn Fn(u8),
    ) -> Result<(), String> {
        let fe_model = model.fastembed_model.clone().ok_or_else(|| {
            format!(
                "model '{}' has no fastembed backend yet (unsupported)",
                model.id
            )
        })?;
        fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
        // fastembed 4.9's blocking API has no incremental byte-progress
        // callback, only a terminal progress-bar toggle — reported as 0%
        // while in flight, jumping straight to `Ready` on success.
        on_progress(0);
        let options = fastembed::TextEmbedding::try_new(
            fastembed::InitOptions::new(fe_model)
                .with_cache_dir(dest_dir.to_path_buf())
                .with_show_download_progress(false),
        );
        // `{e:#}` prints the full anyhow context chain — `e.to_string()`
        // would keep only fastembed's outermost "Failed to retrieve <file>"
        // and drop the underlying hf_hub/network cause the UI needs to show.
        options.map(|_| ()).map_err(|e| format!("{e:#}"))
    }
}

/// Tracks per-model download state in memory, backed by an on-disk ready
/// marker so "ready" survives across app restarts. An in-memory-only
/// `Downloading` left behind by a killed process just falls back to
/// `NotDownloaded` on the next query, since no marker was ever written —
/// there is nothing to resume in-process, but calling `start_download`
/// again re-attempts the fetch (and `hf_hub`'s own cache dedups whatever
/// bytes already landed on disk from the previous attempt).
pub struct DownloadManager {
    cache_dir: PathBuf,
    states: Mutex<HashMap<String, DownloadState>>,
}

impl DownloadManager {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            states: Mutex::new(HashMap::new()),
        }
    }

    /// The on-disk directory a given model's files (weights + the ready
    /// marker) live under. Exposed so the `on-device` embedding provider
    /// (`ai::providers::on_device_embed`) can point `fastembed`'s loader
    /// at the exact same directory this manager downloaded into.
    pub fn model_dir(&self, id: &str) -> PathBuf {
        self.cache_dir.join(id)
    }

    pub fn is_downloaded(&self, id: &str) -> bool {
        self.model_dir(id).join(READY_MARKER).exists()
    }

    /// Current state: in-memory if we have a non-default one, else derived
    /// from the on-disk ready marker.
    pub fn download_state(&self, id: &str) -> DownloadState {
        if let Some(state) = self.states.lock().unwrap().get(id) {
            if !matches!(state, DownloadState::NotDownloaded) {
                return state.clone();
            }
        }
        if self.is_downloaded(id) {
            DownloadState::Ready
        } else {
            DownloadState::NotDownloaded
        }
    }

    fn set_state(&self, id: &str, state: DownloadState) {
        self.states.lock().unwrap().insert(id.to_string(), state);
    }

    /// Update the in-memory state to `Downloading { progress }`, but only
    /// while the model is actually `Downloading` — a no-op otherwise (e.g.
    /// after cancel reset it to `NotDownloaded`, or it already reached
    /// `Ready`/`Error`). Called by both the blocking fetcher's own
    /// `on_progress` ticks and — since Bug B's dir-size poller became the
    /// single in-flight `ai:model-download-progress` emitter — the poller
    /// task in `commands/ai_provider.rs`, so `get_on_device_model_state`
    /// stays in sync with the real on-disk progress it emits.
    pub fn report_download_progress(&self, id: &str, progress: u8) {
        let mut states = self.states.lock().unwrap();
        if matches!(states.get(id), Some(DownloadState::Downloading { .. })) {
            states.insert(id.to_string(), DownloadState::Downloading { progress });
        }
    }

    /// Start (or resume) a download. Blocking — the caller decides whether
    /// to run this off the Tauri command thread. No-op success if the
    /// model is already downloaded.
    ///
    /// Cancellation is best-effort: [`Self::cancel_download`] only takes
    /// effect between attempts (it resets a stuck in-memory `Downloading`
    /// state back to `NotDownloaded`), since [`ModelFetcher::fetch`] is a
    /// single blocking call with no injected cancellation flag today.
    pub fn start_download(&self, id: &str, fetcher: &dyn ModelFetcher) -> Result<(), String> {
        let model = catalog::find(id).ok_or_else(|| format!("unknown on-device model id: {id}"))?;
        if self.is_downloaded(id) {
            self.set_state(id, DownloadState::Ready);
            return Ok(());
        }
        self.set_state(id, DownloadState::Downloading { progress: 0 });

        let dest = self.model_dir(id);
        let result = fetcher.fetch(model, &dest, &|p| self.report_download_progress(id, p));
        match result {
            Ok(()) => {
                fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                fs::write(dest.join(READY_MARKER), b"1").map_err(|e| e.to_string())?;
                self.set_state(id, DownloadState::Ready);
                Ok(())
            }
            Err(code) => {
                // A concurrent cancel already reset state to NotDownloaded —
                // don't clobber it with an Error the user didn't ask about.
                let still_downloading = matches!(
                    self.states.lock().unwrap().get(id),
                    Some(DownloadState::Downloading { .. })
                );
                if still_downloading {
                    self.set_state(id, DownloadState::Error { code: code.clone() });
                }
                Err(code)
            }
        }
    }

    /// Reset a `Downloading` model back to `NotDownloaded`. No-op for any
    /// other state — nothing to cancel.
    pub fn cancel_download(&self, id: &str) {
        let mut states = self.states.lock().unwrap();
        if matches!(states.get(id), Some(DownloadState::Downloading { .. })) {
            states.insert(id.to_string(), DownloadState::NotDownloaded);
        }
    }

    /// Delete a downloaded model's files and reset its state.
    pub fn remove_downloaded(&self, id: &str) -> Result<(), String> {
        let dest = self.model_dir(id);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        self.set_state(id, DownloadState::NotDownloaded);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn manager(tmp: &tempfile::TempDir) -> DownloadManager {
        DownloadManager::new(tmp.path().to_path_buf())
    }

    // ─── Bug B: dir-polling download progress ─────────────────────────────

    #[test]
    fn dir_size_bytes_sums_nested_files() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.bin"), vec![0u8; 10]).unwrap();
        let nested = tmp.path().join("blobs");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("b.bin"), vec![0u8; 25]).unwrap();
        fs::write(nested.join("c.bin"), vec![0u8; 7]).unwrap();

        assert_eq!(dir_size_bytes(tmp.path()), 42);
    }

    #[test]
    fn dir_size_bytes_missing_dir_is_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        assert_eq!(dir_size_bytes(&missing), 0);
    }

    #[test]
    fn download_percent_partial_progress() {
        assert_eq!(download_percent(250, 1000), 25);
    }

    #[test]
    fn download_percent_clamps_at_99_when_on_disk_reaches_or_exceeds_total() {
        assert_eq!(download_percent(1000, 1000), 99);
        assert_eq!(download_percent(5000, 1000), 99);
    }

    #[test]
    fn download_percent_zero_total_is_zero() {
        assert_eq!(download_percent(500, 0), 0);
        assert_eq!(download_percent(0, 0), 0);
    }

    #[test]
    fn report_download_progress_updates_only_while_downloading() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = catalog::MULTILINGUAL_E5_SMALL;

        // Not downloading yet (NotDownloaded) — no-op.
        mgr.report_download_progress(id, 50);
        assert_eq!(mgr.download_state(id), DownloadState::NotDownloaded);

        mgr.set_state(id, DownloadState::Downloading { progress: 0 });
        mgr.report_download_progress(id, 63);
        assert_eq!(
            mgr.download_state(id),
            DownloadState::Downloading { progress: 63 }
        );

        // Once Ready, further reports are a no-op.
        mgr.set_state(id, DownloadState::Ready);
        mgr.report_download_progress(id, 99);
        assert_eq!(mgr.download_state(id), DownloadState::Ready);
    }

    #[test]
    fn fresh_model_is_not_downloaded() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = catalog::NOMIC_EMBED_TEXT_V15;
        assert_eq!(mgr.download_state(id), DownloadState::NotDownloaded);
        assert!(!mgr.is_downloaded(id));
    }

    #[test]
    fn successful_fetch_transitions_through_downloading_to_ready() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = catalog::NOMIC_EMBED_TEXT_V15;
        let observed_mid_flight: StdMutex<Option<DownloadState>> = StdMutex::new(None);

        let fetcher = |_: &OnDeviceModel, dest: &Path, on_progress: &dyn Fn(u8)| {
            fs::create_dir_all(dest).unwrap();
            on_progress(42);
            *observed_mid_flight.lock().unwrap() = Some(mgr.download_state(id));
            Ok(())
        };

        assert_eq!(mgr.download_state(id), DownloadState::NotDownloaded);
        mgr.start_download(id, &fetcher).unwrap();

        assert_eq!(
            *observed_mid_flight.lock().unwrap(),
            Some(DownloadState::Downloading { progress: 42 }),
            "state must read Downloading{{progress}} while the fetch is in flight"
        );
        assert_eq!(mgr.download_state(id), DownloadState::Ready);
        assert!(mgr.is_downloaded(id));
    }

    #[test]
    fn already_downloaded_model_short_circuits_to_ready_without_calling_fetcher() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = catalog::MULTILINGUAL_E5_LARGE;
        let dest = tmp.path().join(id);
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join(READY_MARKER), b"1").unwrap();

        let fetcher = |_: &OnDeviceModel, _: &Path, _: &dyn Fn(u8)| {
            panic!("fetcher must not run for an already-downloaded model");
        };
        mgr.start_download(id, &fetcher).unwrap();
        assert_eq!(mgr.download_state(id), DownloadState::Ready);
    }

    #[test]
    fn failed_fetch_transitions_to_error() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = catalog::MULTILINGUAL_E5_LARGE;

        let fetcher =
            |_: &OnDeviceModel, _: &Path, _: &dyn Fn(u8)| Err("network_unreachable".to_string());

        let err = mgr.start_download(id, &fetcher).unwrap_err();
        assert_eq!(err, "network_unreachable");
        assert_eq!(
            mgr.download_state(id),
            DownloadState::Error {
                code: "network_unreachable".to_string()
            }
        );
        assert!(!mgr.is_downloaded(id));
    }

    #[test]
    fn unknown_model_id_is_rejected_before_touching_the_fetcher() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let fetcher = |_: &OnDeviceModel, _: &Path, _: &dyn Fn(u8)| {
            panic!("fetcher must not run for an unknown id");
        };
        let err = mgr
            .start_download("not-a-real-model", &fetcher)
            .unwrap_err();
        assert!(err.contains("unknown on-device model id"));
    }

    #[test]
    fn cancel_resets_a_downloading_model_to_not_downloaded() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = catalog::MULTILINGUAL_E5_SMALL;
        mgr.set_state(id, DownloadState::Downloading { progress: 10 });
        mgr.cancel_download(id);
        assert_eq!(mgr.download_state(id), DownloadState::NotDownloaded);
    }

    #[test]
    fn cancel_is_a_no_op_outside_of_downloading() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = catalog::NOMIC_EMBED_TEXT_V15;
        mgr.set_state(id, DownloadState::Ready);
        mgr.cancel_download(id);
        assert_eq!(mgr.download_state(id), DownloadState::Ready);
    }

    #[test]
    fn remove_downloaded_deletes_files_and_resets_state() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = catalog::NOMIC_EMBED_TEXT_V15;
        let fetcher = |_: &OnDeviceModel, dest: &Path, _: &dyn Fn(u8)| {
            fs::create_dir_all(dest).unwrap();
            Ok(())
        };
        mgr.start_download(id, &fetcher).unwrap();
        assert!(mgr.is_downloaded(id));

        mgr.remove_downloaded(id).unwrap();
        assert!(!mgr.is_downloaded(id));
        assert_eq!(mgr.download_state(id), DownloadState::NotDownloaded);
    }

    #[test]
    fn remove_downloaded_is_a_no_op_when_nothing_was_downloaded() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(&tmp);
        let id = catalog::MULTILINGUAL_E5_SMALL;
        mgr.remove_downloaded(id).unwrap();
        assert_eq!(mgr.download_state(id), DownloadState::NotDownloaded);
    }
}
