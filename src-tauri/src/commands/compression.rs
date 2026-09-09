//! Background video-compression worker.
//!
//! Videos are inserted immediately (original copied in, `media` row created with
//! `awaiting_compression = 1` so the ORIGINAL is held out of cloud upload), then
//! this worker transcodes them off the UI path via macOS AVFoundation, swaps the
//! smaller `.mp4` in, clears the hold, and emits `media:compressed` so the editor
//! re-resolves the swapped file. Mirrors `SyncScheduler`'s worker shape (a
//! detached tokio task + a cancel flag); jobs arrive over an unbounded channel.
//!
//! A startup resume sweep re-enqueues any row still `awaiting_compression = 1`
//! (interrupted by a crash / app close mid-transcode), so the hold can never
//! strand a video off both the local player refresh and cloud sync.

use crate::utils::video_compression::VideoCompressionMode;
use crate::AppState;
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

/// Frontend event fired after a successful background compression swap.
pub const MEDIA_COMPRESSED_EVENT: &str = "media:compressed";

/// Payload for [`MEDIA_COMPRESSED_EVENT`]. `new_local_path` is the swapped-in
/// (smaller) file; the frontend invalidates its media-id cache and re-resolves.
#[derive(Debug, Clone, Serialize)]
pub struct MediaCompressed {
    pub media_id: String,
    pub new_local_path: String,
    /// Size of the compressed file that replaced the original.
    pub file_size: i64,
    /// Size of the original before compression (for a "saved X" toast).
    pub original_size: i64,
}

/// A unit of background video-compression work.
#[derive(Debug, Clone)]
pub struct CompressionJob {
    pub media_id: String,
    pub src_path: PathBuf,
    pub mode: VideoCompressionMode,
}

/// Managed handle for enqueuing background video-compression jobs. Held in
/// Tauri managed state; the ingest commands push jobs via [`enqueue`].
pub struct CompressionQueue {
    tx: mpsc::UnboundedSender<CompressionJob>,
    cancel: Arc<AtomicBool>,
}

impl CompressionQueue {
    /// Start the worker task and run the startup resume sweep. Returns
    /// immediately; the loop runs until `stop()` or the channel closes.
    pub fn start(app: AppHandle) -> Arc<Self> {
        let (tx, rx) = mpsc::unbounded_channel::<CompressionJob>();
        let cancel = Arc::new(AtomicBool::new(false));
        let app_for_task = app.clone();
        let cancel_for_task = Arc::clone(&cancel);
        tauri::async_runtime::spawn(async move {
            run_loop(app_for_task, rx, cancel_for_task).await;
        });
        let queue = Arc::new(Self { tx, cancel });
        queue.resume_pending(&app);
        queue
    }

    /// Enqueue a job. Non-blocking; only fails if the worker task has stopped.
    pub fn enqueue(&self, job: CompressionJob) {
        if let Err(e) = self.tx.send(job) {
            log::warn!("compression queue: enqueue failed (worker stopped): {e}");
        }
    }

    /// Signal the worker to stop after its current job. Idempotent.
    pub fn stop(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Re-enqueue every row still `awaiting_compression = 1` — jobs interrupted
    /// by a crash / app close mid-transcode. Best-effort: DB errors are logged,
    /// not fatal to startup.
    fn resume_pending(&self, app: &AppHandle) {
        let state = app.state::<AppState>();
        let jobs: Vec<CompressionJob> = {
            let conn = match state.lock() {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("compression resume: lock failed: {e}");
                    return;
                }
            };
            let ids = match crate::db::queries::list_media_ids_awaiting_compression(&conn) {
                Ok(ids) => ids,
                Err(e) => {
                    log::warn!("compression resume: list failed: {e}");
                    return;
                }
            };
            let mode = crate::commands::media::resolve_video_compression_mode(&conn);
            ids.into_iter()
                .filter_map(|id| match crate::db::get_media(&conn, &id) {
                    Ok(Some(m)) => Some(CompressionJob {
                        media_id: m.id,
                        src_path: PathBuf::from(m.storage_path),
                        mode,
                    }),
                    _ => None,
                })
                .collect()
        };
        if !jobs.is_empty() {
            log::info!(
                "compression resume: re-enqueuing {} interrupted job(s)",
                jobs.len()
            );
        }
        for job in jobs {
            self.enqueue(job);
        }
    }
}

async fn run_loop(
    app: AppHandle,
    mut rx: mpsc::UnboundedReceiver<CompressionJob>,
    cancel: Arc<AtomicBool>,
) {
    while let Some(job) = rx.recv().await {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        process_job(&app, job).await;
    }
}

async fn process_job(app: &AppHandle, job: CompressionJob) {
    let CompressionJob {
        media_id,
        src_path,
        mode,
    } = job;

    // Heavy transcode runs off the lock (its own spawn_blocking inside).
    let transcoded = crate::commands::media::transcode_video_to_temp(&src_path, mode).await;

    let state = app.state::<AppState>();
    let result = {
        let conn = match state.lock() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("compression: lock failed for {media_id}: {e}");
                return;
            }
        };
        commit_compression_swap(&conn, &media_id, &src_path, transcoded)
    };

    match result {
        Ok(Some(payload)) => {
            log::info!(
                "compression: {media_id} compressed -> {} ({} bytes)",
                payload.new_local_path,
                payload.file_size
            );
            let _ = app.emit(MEDIA_COMPRESSED_EVENT, payload);
        }
        Ok(None) => {
            log::info!("compression: {media_id} kept original (no size win / off / unsupported)");
        }
        Err(e) => log::warn!("compression: swap failed for {media_id}: {e}"),
    }
}

/// Commit the outcome of a transcode attempt (pure over conn + fs, testable):
///
/// * `Some(tmp)` — a strictly-smaller `.mp4` exists: copy it into the media dir
///   as `{media_id}.mp4`, repoint + resize the row and clear the hold, delete
///   the original, and return the swap payload.
/// * `None` — no size win / failure / pass-through: just clear the upload hold
///   so the ORIGINAL becomes uploadable; return `None` (no swap, no event).
pub(crate) fn commit_compression_swap(
    conn: &Connection,
    media_id: &str,
    src_path: &Path,
    transcoded: Option<PathBuf>,
) -> Result<Option<MediaCompressed>, String> {
    match transcoded {
        Some(tmp) => {
            let media_dir = src_path
                .parent()
                .ok_or_else(|| "media file has no parent directory".to_string())?;
            // Original size for the "saved X" toast — read before we delete it.
            let original_size = std::fs::metadata(src_path)
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            let new_name = format!("{media_id}.mp4");
            let new_path = media_dir.join(&new_name);
            std::fs::copy(&tmp, &new_path).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&tmp);
            let file_size = std::fs::metadata(&new_path)
                .map(|m| m.len() as i64)
                .map_err(|e| e.to_string())?;
            crate::db::queries::update_media_after_compression(
                conn,
                media_id,
                &new_path.to_string_lossy(),
                &new_name,
                "video/mp4",
                file_size,
            )
            .map_err(|e| e.to_string())?;
            // Remove the original now that the row points at the compressed file.
            if new_path != src_path {
                let _ = std::fs::remove_file(src_path);
            }
            Ok(Some(MediaCompressed {
                media_id: media_id.to_string(),
                new_local_path: new_path.to_string_lossy().into_owned(),
                file_size,
                original_size,
            }))
        }
        None => {
            crate::db::queries::set_media_awaiting_compression(conn, media_id, false)
                .map_err(|e| e.to_string())?;
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    fn setup() -> (Connection, String, TempDir) {
        let conn = Connection::open_in_memory().unwrap();
        db::schema::migrate(&conn).unwrap();
        let jid = db::create_journal(&conn, "J", None).unwrap().id;
        let eid = db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;
        let dir = TempDir::new().unwrap();
        (conn, eid, dir)
    }

    /// A media row created via the shared ingest path, held awaiting compression.
    fn make_held_video(conn: &Connection, media_dir: &Path, eid: &str) -> (String, PathBuf) {
        let fake = b"original video bytes, larger than the transcode".to_vec();
        let res = crate::commands::media::save_media_to_media_dir(
            conn, media_dir, eid, &fake, "mov", "inline",
        )
        .unwrap();
        db::queries::set_media_awaiting_compression(conn, &res.media_id, true).unwrap();
        (res.media_id, PathBuf::from(res.local_path))
    }

    #[test]
    fn swap_with_smaller_output_repoints_row_and_clears_hold() {
        let (conn, eid, dir) = setup();
        let (media_id, src_path) = make_held_video(&conn, dir.path(), &eid);
        assert!(src_path.exists());

        // Fabricate a "transcoded" temp file that is smaller than the original.
        let tmp = dir.path().join("transcoded-tmp.mp4");
        std::fs::write(&tmp, b"tiny").unwrap();

        let payload = commit_compression_swap(&conn, &media_id, &src_path, Some(tmp.clone()))
            .unwrap()
            .expect("swap emits a payload");

        // Row now points at {media_id}.mp4 with the new size + type, hold cleared.
        let m = db::get_media(&conn, &media_id).unwrap().unwrap();
        assert_eq!(m.file_type, "video/mp4");
        assert_eq!(m.file_name, format!("{media_id}.mp4"));
        assert_eq!(m.file_size, Some(4));
        assert!(m.storage_path.ends_with(&format!("{media_id}.mp4")));
        assert_eq!(payload.media_id, media_id);
        assert_eq!(payload.file_size, 4);
        assert!(
            payload.original_size >= 47,
            "original_size captured before delete"
        );
        assert!(db::queries::is_media_compressed(&conn, &media_id).unwrap());

        // New file exists, temp consumed, original removed, hold cleared.
        assert!(Path::new(&m.storage_path).exists());
        assert!(!tmp.exists());
        assert!(!src_path.exists(), "original removed after swap");
        assert!(db::queries::list_pending_uploads(&conn)
            .unwrap()
            .iter()
            .any(|p| p.id == media_id));
    }

    #[test]
    fn no_win_clears_hold_without_swapping() {
        let (conn, eid, dir) = setup();
        let (media_id, src_path) = make_held_video(&conn, dir.path(), &eid);
        let before = db::get_media(&conn, &media_id)
            .unwrap()
            .unwrap()
            .storage_path;

        let out = commit_compression_swap(&conn, &media_id, &src_path, None).unwrap();
        assert!(out.is_none(), "no swap → no payload");

        let m = db::get_media(&conn, &media_id).unwrap().unwrap();
        assert_eq!(m.storage_path, before, "original path unchanged");
        assert!(src_path.exists(), "original kept");
        // Hold cleared → uploadable again.
        assert!(db::queries::list_pending_uploads(&conn)
            .unwrap()
            .iter()
            .any(|p| p.id == media_id));
    }

    #[test]
    fn media_compressed_payload_serializes() {
        let json = serde_json::to_string(&MediaCompressed {
            media_id: "m1".into(),
            new_local_path: "/media/m1.mp4".into(),
            file_size: 42,
            original_size: 100,
        })
        .unwrap();
        assert!(json.contains("\"media_id\":\"m1\""));
        assert!(json.contains("\"file_size\":42"));
        assert!(json.contains("\"original_size\":100"));
    }
}
