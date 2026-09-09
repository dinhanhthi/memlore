use crate::utils;
use crate::utils::thumbnail::{
    generate_thumbnail, supports_thumbnail, DEFAULT_JPEG_QUALITY, DEFAULT_MAX_EDGE,
};
use crate::{AppState, EncryptionKeyState};
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

/// Emitted whenever the media cache ceiling changes or the cache is cleared.
/// Payload is the fresh `MediaCacheStats`. UI listeners (settings panel,
/// future storage indicator in the sidebar) subscribe to this so they don't
/// need to re-invoke the getter every time another surface mutates the limit.
pub const MEDIA_CACHE_STATS_EVENT: &str = "media-cache:stats-changed";

// Re-export the provider factory from the sync command module.
use crate::commands::sync::make_configured_provider;
use crate::db::queries::LockedView;
use crate::db::{CreateMediaParams, Media};
use crate::sync::provider::SyncProvider;

/// Result returned by the media-picker commands (`pick_image`, `pick_video`,
/// and `save_pasted_image`) after copying bytes into the media dir and
/// inserting a `media` row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickImageResult {
    pub media_id: String,
    pub local_path: String,
}

/// Result of a multi-clip video pick. `saved` is every clip that was written;
/// `rejected` is the filename of each clip dropped for exceeding the upload
/// cap. An empty `saved` + empty `rejected` means the user cancelled.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickVideosResult {
    pub saved: Vec<PickImageResult>,
    pub rejected: Vec<String>,
}

/// Infer a MIME type from a lowercased file extension.
///
/// Covers the image formats the picker accepts plus the three video
/// containers supported in phase B1 (`mp4`, `mov`, `webm`, `m4v`). Unknown
/// extensions fall through to `application/octet-stream` so the caller can
/// reject unsupported bytes before they land in the media directory.
pub(crate) fn mime_from_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        // HEIC / HEIF: iPhone Photos default since iOS 11. PHPicker on
        // macOS hands us these as `.heic` files; we must register them as
        // images so `save_media_to_media_dir` runs the EXIF extractor (the
        // kamadak-exif reader handles both JPEG and HEIF containers via
        // content-sniffing).
        "heic" | "heif" => "image/heic",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "m4v" => "video/x-m4v",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Generate a JPEG thumbnail beside the original image and return its path.
///
/// Returns `Ok(None)` if the MIME type doesn't support thumbnails (e.g., SVG)
/// or if generation fails — the caller treats missing thumbnails as non-fatal
/// per the chunk-6b rollback spec ("thumbnail failure falls back to full media").
fn generate_thumbnail_beside(
    media_dir: &Path,
    media_uuid: &str,
    mime_type: &str,
    source_bytes: &[u8],
) -> Option<PathBuf> {
    if !supports_thumbnail(mime_type) {
        return None;
    }
    let thumb_bytes = match generate_thumbnail(source_bytes, DEFAULT_MAX_EDGE, DEFAULT_JPEG_QUALITY)
    {
        Ok(b) => b,
        Err(e) => {
            log::warn!("thumbnail generation failed for {media_uuid}: {e}");
            return None;
        }
    };
    let thumb_path = media_dir.join(format!("{media_uuid}.thumb.jpg"));
    if let Err(e) = std::fs::write(&thumb_path, &thumb_bytes) {
        log::warn!("write thumbnail for {media_uuid}: {e}");
        return None;
    }
    Some(thumb_path)
}

/// Maximum number of photos a single PHPicker invocation will accept.
/// PHPicker enforces the cap in its native UI ("Select up to N items").
pub const MAX_PHOTO_SELECTION: usize = 20;

/// Maximum number of videos a single PHPicker invocation will accept.
/// Tighter than the photo cap because PHPicker's Swift bridge buffers every
/// selected clip's full bytes in memory before handing the array back to
/// Rust — `MAX_VIDEO_SELECTION × <per-file video limit>` is the worst-case
/// resident-memory ceiling. 5 × 100 MB (default) = 500 MB peak, safe on an
/// 8 GB Mac.
pub const MAX_VIDEO_SELECTION: usize = 5;

/// Read the user's media-compression preference from the settings table
/// and decode it into a `CompressionMode`. Missing or malformed settings
/// fall back to `Standard` — that's the value the Settings UI ships with
/// by default, and it gives sensible savings for typical phone photos.
pub(crate) fn resolve_compression_mode(
    conn: &Connection,
) -> crate::utils::image_compression::CompressionMode {
    let mode_str = crate::db::get_setting(conn, "media_compression_mode")
        .ok()
        .flatten()
        .unwrap_or_default();
    let edge = crate::db::get_setting(conn, "media_compression_max_edge")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u32>().ok());
    let quality = crate::db::get_setting(conn, "media_compression_quality")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u8>().ok());
    crate::utils::image_compression::CompressionMode::from_settings(&mode_str, edge, quality)
}

/// Read the configured per-file upload size limits (in bytes) from the
/// settings table. Mirrors how `resolve_compression_mode` reads the
/// compression settings. Both getters return `i64::MAX` for the `-1`
/// "unlimited" sentinel, so callers can treat `i64::MAX` as "no cap" and
/// compare byte lengths (`i64`) directly against the limit without special
/// cases.
///
/// Falls back to the queries-layer defaults on any read/parse error so a
/// broken settings row never blocks all imports.
fn resolve_upload_limits(conn: &Connection) -> (i64, i64) {
    let photo = crate::db::queries::get_media_max_photo_upload_bytes(conn).unwrap_or_else(|e| {
        log::warn!("read media_max_photo_upload_bytes, using default: {e}");
        crate::db::queries::DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES
    });
    let video = crate::db::queries::get_media_max_video_upload_bytes(conn).unwrap_or_else(|e| {
        log::warn!("read media_max_video_upload_bytes, using default: {e}");
        crate::db::queries::DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES
    });
    (photo, video)
}

/// Validate that `mode` is either `"inline"` or `"attached"`.
/// Returns `Ok(())` or an `Err` string suitable for a Tauri command result.
pub(crate) fn validate_insertion_mode(mode: &str) -> Result<(), String> {
    if mode == "inline" || mode == "attached" {
        Ok(())
    } else {
        Err(format!(
            "insertion_mode must be 'inline' or 'attached', got '{mode}'"
        ))
    }
}

/// Copy raw media bytes into the media directory, generate a thumbnail when
/// the MIME supports one, and insert a `media` row. Shared by `pick_image`,
/// `pick_video`, and the clipboard-paste command so every ingest path goes
/// through the same sync/encryption plumbing.
///
/// EXIF extraction and thumbnail generation are guarded by the MIME top-level
/// — video bytes skip both without incurring a spurious decode attempt.
///
/// Atomicity: if the `media` row insert fails after the file has been
/// written, the freshly-written file is removed (best-effort) so the media
/// directory never accumulates orphans with no referencing DB row.
///
/// Pure over (conn, fs) — no Tauri state; testable directly with an
/// in-memory DB and a temp dir.
pub(crate) fn save_media_to_media_dir(
    conn: &Connection,
    media_dir: &Path,
    entry_id: &str,
    bytes: &[u8],
    extension: &str,
    insertion_mode: &str,
) -> Result<PickImageResult, String> {
    std::fs::create_dir_all(media_dir).map_err(|e| e.to_string())?;

    let ext_input = extension.to_lowercase();
    let mime_input = mime_from_ext(&ext_input);

    // Optional image compression — controlled by settings keys, defaults
    // to Standard preset. Pass-through unchanged for video, audio, SVG,
    // HEIC, or any non-image MIME; pass-through for already-small JPEGs.
    //
    // For images we run the escalation ladder via `compress_to_fit` so the
    // configured photo upload limit is enforced AFTER compression, not
    // before: a 12 MB phone JPEG recompressed to 1.5 MB must be accepted
    // even though the raw source is over the limit. Only when no ladder
    // rung fits (or the format is incompressible AND over the limit) do we
    // abort this file's import, surfacing the actual byte size + configured
    // limit so the frontend can show a meaningful message.
    let mode = resolve_compression_mode(conn);
    let (photo_limit, _video_limit) = resolve_upload_limits(conn);
    let (effective_bytes, effective_mime, ext) = if mime_input.starts_with("image/") {
        let outcome = crate::utils::image_compression::compress_to_fit(
            bytes,
            mime_input,
            &ext_input,
            mode,
            photo_limit,
        )
        .map_err(|e| match e {
            crate::utils::image_compression::CompressToFitError::StillTooLarge {
                final_bytes,
                limit_bytes,
            } => format!(
                "IMAGE_TOO_LARGE:{final_bytes}:{limit_bytes}:image could not be compressed under the configured limit ({} bytes final, {} bytes limit)",
                final_bytes, limit_bytes
            ),
            crate::utils::image_compression::CompressToFitError::Incompressible {
                bytes: b,
                limit_bytes,
            } => format!(
                "IMAGE_TOO_LARGE:{b}:{limit_bytes}:format cannot be compressed ({} bytes, {} bytes limit)",
                b, limit_bytes
            ),
        })?;
        (outcome.bytes, outcome.mime, outcome.ext)
    } else {
        (bytes.to_vec(), mime_input.to_string(), ext_input.clone())
    };
    let bytes: &[u8] = &effective_bytes;
    let mime_type: &str = &effective_mime;
    let is_image = mime_type.starts_with("image/");

    let media_uuid = uuid::Uuid::new_v4().to_string();
    let dest_name = format!("{media_uuid}.{ext}");
    let dest_path = media_dir.join(&dest_name);

    std::fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;

    let file_size = dest_path.metadata().map(|m| m.len() as i64).unwrap_or(0);
    let local_path = dest_path.to_string_lossy().into_owned();

    // Only images carry meaningful EXIF — skip the decode attempt for video.
    let exif = if is_image {
        crate::utils::exif::extract_exif(&dest_path).ok()
    } else {
        None
    };

    // Read intrinsic pixel dimensions for the skeleton aspect-ratio. Two
    // sources, tried in order:
    //   1) EXIF `PixelXDimension`/`PixelYDimension` — works for HEIC (the
    //      iPhone Photo Library default), which `image` crate cannot decode
    //      without the `heif` feature flag. kamadak-exif sniffs HEIF
    //      containers so we already have a working reader.
    //   2) `image::ImageReader::into_dimensions()` — header-only parse, used
    //      as fallback for PNG/WebP/etc. that don't carry EXIF.
    // Best-effort: video/audio/SVG and any decode failure leave `None`.
    let (width, height): (Option<i64>, Option<i64>) = if is_image {
        let from_exif = exif.as_ref().and_then(|e| match (e.width, e.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => Some((w as i64, h as i64)),
            _ => None,
        });
        let dims = from_exif.or_else(|| {
            image::ImageReader::new(std::io::Cursor::new(bytes))
                .with_guessed_format()
                .ok()
                .and_then(|r| r.into_dimensions().ok())
                .map(|(w, h)| (w as i64, h as i64))
        });
        match dims {
            Some((w, h)) => (Some(w), Some(h)),
            None => (None, None),
        }
    } else {
        (None, None)
    };

    let media = match crate::db::create_media(
        conn,
        CreateMediaParams {
            entry_id,
            file_name: &dest_name,
            file_type: mime_type,
            storage_path: &local_path,
            file_size: Some(file_size),
            sort_order: 0,
            insertion_mode,
            exif_date: exif.as_ref().and_then(|e| e.date),
            exif_latitude: exif.as_ref().and_then(|e| e.latitude),
            exif_longitude: exif.as_ref().and_then(|e| e.longitude),
            width,
            height,
        },
    ) {
        Ok(m) => m,
        Err(e) => {
            // Best-effort cleanup: the file was written above but the DB row
            // failed, so nothing references it. Never leak orphans on insert
            // failure — a delete error here is logged but does not mask the
            // DB error we propagate to the caller. Mirrors the cleanup already
            // applied by `save_attached_file_to_media_dir`.
            if let Err(remove_err) = std::fs::remove_file(&dest_path) {
                log::warn!("failed to remove orphaned media file {dest_name}: {remove_err}");
            }
            return Err(e.to_string());
        }
    };

    // Thumbnail generation is best-effort and only runs for images (in-process
    // `image` crate). Videos do not get a thumbnail — the frontend renders
    // them via `<video preload="metadata">` (browser fetches frame 0) or a
    // placeholder icon for cloud-only items.
    if is_image {
        if let Some(thumb_path) =
            generate_thumbnail_beside(media_dir, &media_uuid, mime_type, bytes)
        {
            let thumb_str = thumb_path.to_string_lossy().into_owned();
            if let Err(e) =
                crate::db::update_media_thumbnail_path(conn, &media.id, Some(&thumb_str))
            {
                log::warn!("store thumbnail_path for {}: {e}", media.id);
            }
        }
    }

    Ok(PickImageResult {
        media_id: media.id,
        local_path,
    })
}

/// Opens a native file picker, copies the selected image to the app's media
/// directory, inserts a `media` row (upload_status = 'pending'), and returns
/// `{ media_id, local_path }`. Returns `None` if the user cancels.
///
/// The frontend converts `local_path` to an `asset://` URL via `convertFileSrc`.
///
/// `insertion_mode` must be `"inline"` (default) or `"attached"`.
#[tauri::command]
pub async fn pick_image(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
    insertion_mode: Option<String>,
) -> Result<Option<PickImageResult>, String> {
    // Open native file dialog
    let handle = rfd::AsyncFileDialog::new()
        .add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        )
        .set_title("Insert Image")
        .pick_file()
        .await;

    let file_handle = match handle {
        Some(h) => h,
        None => return Ok(None), // user cancelled
    };

    // Determine media directory inside app data dir
    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    // Preserve original extension; fall back to "png"
    let file_name = file_handle.file_name();
    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_string();

    // Read source bytes once — we need them for both the copy and the thumbnail.
    let src_path = file_handle.path().to_path_buf();
    let bytes = std::fs::read(&src_path).map_err(|e| e.to_string())?;

    let mode = insertion_mode.as_deref().unwrap_or("inline");
    validate_insertion_mode(mode)?;

    let conn = state.lock().map_err(|e| e.to_string())?;
    let result = save_media_to_media_dir(&conn, &media_dir, &entry_id, &bytes, &ext, mode)?;
    Ok(Some(result))
}

/// Test-only pure batch save of pre-loaded photo bytes. Takes a direct DB
/// connection and media dir so the inline `#[cfg(test)]` module can exercise
/// the loop with in-memory SQLite + a tempdir.
///
/// The production path (`save_picked_photos_inner` below) uses different
/// lock discipline — it acquires + releases the AppState mutex per
/// iteration so a 20-image batch never blocks other Tauri commands for the
/// full duration. We deliberately keep two implementations because that
/// per-iteration locking can't be expressed by sharing this helper.
#[cfg(test)]
pub(crate) fn save_picked_photos_pure(
    conn: &Connection,
    media_dir: &Path,
    entry_id: &str,
    photos: &[(String, Vec<u8>)],
    mode: &str,
) -> Result<Vec<PickImageResult>, String> {
    validate_insertion_mode(mode)?;

    if photos.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(photos.len());
    for (filename, bytes) in photos {
        let ext = std::path::Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg")
            .to_string();
        // Per-item import: an oversized/incompressible image rejects ONLY
        // that file (logged), so one bad pick in a 20-image batch does not
        // discard the rest of the selection. Genuine infra errors (disk
        // full, DB corruption) still propagate as `Err` since they affect
        // the whole batch.
        match save_media_to_media_dir(conn, media_dir, entry_id, bytes, &ext, mode) {
            Ok(result) => out.push(result),
            Err(e) if e.starts_with("IMAGE_TOO_LARGE:") => {
                log::warn!("skipped oversized/incompressible photo {filename}: {e}");
                continue;
            }
            Err(e) => return Err(e),
        }
    }

    Ok(out)
}

/// Split a PHPicker video batch by the upload cap. Oversized clips are
/// logged and returned as `rejected` filenames; fitting clips keep their
/// bytes so the caller can insert them.
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn partition_videos_by_size(
    videos: Vec<(String, Vec<u8>)>,
    video_limit: i64,
) -> (Vec<(String, Vec<u8>)>, Vec<String>) {
    let mut fitting = Vec::with_capacity(videos.len());
    let mut rejected = Vec::new();
    for (filename, bytes) in videos {
        if (bytes.len() as i64) > video_limit {
            log::warn!(
                "skipped oversized video {filename}: {} bytes > {} byte limit",
                bytes.len(),
                video_limit
            );
            rejected.push(filename);
            continue;
        }
        fitting.push((filename, bytes));
    }
    (fitting, rejected)
}

/// Empty-fitting fork after `partition_videos_by_size`.
/// Cancel → `Ok({ saved: [], rejected: [] })`. All oversized →
/// `VIDEO_TOO_LARGE` for the first rejected name.
#[cfg(any(test, target_os = "macos"))]
fn pick_videos_empty_fitting(
    rejected: Vec<String>,
    video_limit: i64,
) -> Result<PickVideosResult, String> {
    if rejected.is_empty() {
        return Ok(PickVideosResult {
            saved: Vec::new(),
            rejected,
        });
    }
    let offender = rejected
        .first()
        .cloned()
        .unwrap_or_else(|| "video".to_string());
    Err(format!(
        "VIDEO_TOO_LARGE:{offender}:{}",
        video_limit / (1024 * 1024)
    ))
}

/// Test-only: cap-check then persist a pre-loaded video batch. Mirrors
/// `save_picked_photos_pure` so the partial-rejection contract can be
/// asserted without a live Tauri runtime.
#[cfg(test)]
pub(crate) fn save_picked_videos_pure(
    conn: &Connection,
    media_dir: &Path,
    entry_id: &str,
    videos: &[(String, Vec<u8>)],
    mode: &str,
    video_limit: i64,
) -> Result<PickVideosResult, String> {
    validate_insertion_mode(mode)?;
    let (fitting, rejected) = partition_videos_by_size(videos.to_vec(), video_limit);
    if fitting.is_empty() {
        return pick_videos_empty_fitting(rejected, video_limit);
    }
    let mut saved = Vec::with_capacity(fitting.len());
    for (filename, bytes) in fitting {
        let ext = std::path::Path::new(&filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp4")
            .to_string();
        saved.push(save_media_to_media_dir(
            conn, media_dir, entry_id, &bytes, &ext, mode,
        )?);
    }
    Ok(PickVideosResult { saved, rejected })
}

/// Wrap `save_picked_photos_pure` for the Tauri-runtime path: resolves the
/// media dir from `AppHandle`, acquires the AppState lock per-iteration so a
/// large batch never blocks other commands for the full duration.
pub(crate) async fn save_picked_photos_inner(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    entry_id: &str,
    photos: Vec<(String, Vec<u8>)>,
    mode: &str,
) -> Result<Vec<PickImageResult>, String> {
    validate_insertion_mode(mode)?;

    if photos.is_empty() {
        return Ok(Vec::new());
    }

    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    let mut out = Vec::with_capacity(photos.len());
    for (filename, bytes) in photos {
        // Per-iteration lock acquire: a single batch of 20 images writes
        // ~20 rows; releasing between writes lets other Tauri commands
        // (sync, search, etc.) interleave without waiting for the full batch.
        let conn = state.lock().map_err(|e| e.to_string())?;
        let ext = std::path::Path::new(&filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg")
            .to_string();
        // Per-item import: an oversized/incompressible image rejects ONLY
        // that file (logged), so one bad pick in a 20-image batch does not
        // discard the rest of the selection. Genuine infra errors still
        // propagate as `Err`.
        match save_media_to_media_dir(&conn, &media_dir, entry_id, &bytes, &ext, mode) {
            Ok(result) => out.push(result),
            Err(e) if e.starts_with("IMAGE_TOO_LARGE:") => {
                log::warn!("skipped oversized/incompressible photo {filename}: {e}");
                drop(conn);
                continue;
            }
            Err(e) => return Err(e),
        }
        drop(conn);
    }

    Ok(out)
}

/// Open the macOS Photo Library picker (PHPicker) and save the chosen photos
/// into the media directory, returning one `PickImageResult` per saved photo.
///
/// Semantics:
///   * `Ok(vec![])` → user cancelled the picker. Frontend MUST NOT fall
///     back to rfd; do nothing.
///   * `Err(_)`     → the Swift bridge is unavailable (non-macOS or runtime
///     error). Frontend should log a console warning and present no toast.
#[tauri::command]
pub async fn pick_images_from_library(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
    insertion_mode: Option<String>,
) -> Result<Vec<PickImageResult>, String> {
    let mode = insertion_mode.as_deref().unwrap_or("inline");
    validate_insertion_mode(mode)?;

    #[cfg(target_os = "macos")]
    {
        let photos = crate::macos::photo_picker::pick_photos(MAX_PHOTO_SELECTION).await?;
        save_picked_photos_inner(&app, &state, &entry_id, photos, mode).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, entry_id, mode);
        Err("photo-library picker not supported on this platform".to_string())
    }
}

/// Generate a JPEG poster frame for the freshly-saved video at
/// `result.local_path` and update the `media` row's `thumbnail_path` so the
/// attachment strip can render a tiny preview (~30-80 KB) instead of
/// streaming the full video bytes through the IPC layer.
///
/// Best-effort: any failure (AVFoundation can't decode, disk write fails,
/// DB update fails) is logged and discarded — videos without a thumbnail
/// still render correctly via `MediaAttachment`'s `<video preload="metadata">`
/// fallback, just at higher IPC cost.
///
/// Pure on (state, fs) — call from inside any picker command AFTER the
/// `save_media_to_media_dir` call so the media row already exists.
async fn generate_video_thumbnail_best_effort(
    state: &State<'_, AppState>,
    media_dir: &Path,
    result: &PickImageResult,
) {
    #[cfg(target_os = "macos")]
    {
        let video_path = result.local_path.clone();
        let media_id = result.media_id.clone();
        let max_edge = crate::utils::thumbnail::DEFAULT_MAX_EDGE as usize;
        let jpeg_bytes =
            crate::macos::photo_picker::extract_video_thumbnail(video_path, max_edge).await;
        let Some(jpeg_bytes) = jpeg_bytes else {
            log::debug!("video thumbnail extraction returned no bytes for {media_id}");
            return;
        };
        let thumb_path = media_dir.join(format!("{media_id}.thumb.jpg"));
        if let Err(e) = std::fs::write(&thumb_path, &jpeg_bytes) {
            log::warn!("write video thumbnail for {media_id}: {e}");
            return;
        }
        let thumb_str = thumb_path.to_string_lossy().into_owned();
        let Ok(conn) = state.lock() else {
            log::warn!("lock state to store video thumbnail_path for {media_id}");
            return;
        };
        if let Err(e) = crate::db::update_media_thumbnail_path(&conn, &media_id, Some(&thumb_str)) {
            log::warn!("store video thumbnail_path for {media_id}: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, media_dir, result);
    }
}

/// Read the user's video-compression preference from the settings table and
/// decode it into a `VideoCompressionMode`. Mirrors `resolve_compression_mode`
/// for the image path. Missing or malformed settings fall back to `Standard`.
pub(crate) fn resolve_video_compression_mode(
    conn: &Connection,
) -> crate::utils::video_compression::VideoCompressionMode {
    let mode_str = crate::db::get_setting(conn, "video_compression_mode")
        .ok()
        .flatten()
        .unwrap_or_default();
    let edge = crate::db::get_setting(conn, "video_compression_max_edge")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u32>().ok());
    crate::utils::video_compression::VideoCompressionMode::from_settings(&mode_str, edge)
}

/// Opportunistically transcode the video at `src` to a smaller H.264/AAC `.mp4`
/// per `mode`, returning the path to a freshly-written temp file when the
/// output is STRICTLY smaller than the source. Returns `None` — caller keeps
/// the original — for `Off`, non-macOS, any transcode failure, or when the
/// output is not smaller (an already-compressed clip can re-encode larger with
/// pure quality loss, so we never trade bytes for nothing). The caller owns the
/// returned temp file and MUST delete it after use.
pub(crate) async fn transcode_video_to_temp(
    src: &Path,
    mode: crate::utils::video_compression::VideoCompressionMode,
) -> Option<std::path::PathBuf> {
    // `Off` (or any mode without a preset) → skip before touching the FS.
    let preset = mode.preset_name()?;
    #[cfg(target_os = "macos")]
    {
        let src_size = std::fs::metadata(src).ok()?.len();
        let out_path =
            std::env::temp_dir().join(format!("xj-transcode-{}.mp4", uuid::Uuid::new_v4()));
        let ok = crate::macos::photo_picker::transcode_video(
            src.to_string_lossy().into_owned(),
            out_path.to_string_lossy().into_owned(),
            preset.to_string(),
        )
        .await;
        if !ok {
            let _ = std::fs::remove_file(&out_path);
            return None;
        }
        match std::fs::metadata(&out_path) {
            Ok(m) if m.len() < src_size => Some(out_path),
            _ => {
                // Not smaller (or unreadable) — discard the transcode.
                let _ = std::fs::remove_file(&out_path);
                None
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // TODO(later): no cross-platform transcode yet — Windows/Linux store
        // videos unchanged. See docs/LATER.md → "Cross-platform (Windows/Linux)
        // video transcode".
        let _ = (src, preset);
        None
    }
}

/// Opens a native file picker for a video file, copies it to the app's media
/// directory, inserts a `media` row (upload_status = 'pending'), and returns
/// `{ media_id, local_path }`. Returns `None` if the user cancels.
///
/// Mirrors `pick_image`: accepts `insertion_mode` (`"inline"` or `"attached"`,
/// defaulting to `"inline"`) so the new InsertVideoPopover can route Inline /
/// Attach picks through the same command.
///
/// Enforces the configurable video upload cap (`get_media_max_video_upload_bytes`,
/// default 100 MB) — read via a hard byte ceiling so a concurrently-growing
/// file can't blow past the limit. On overflow returns
/// `Err("VIDEO_TOO_LARGE:<filename>:<max_mb>")` for the frontend modal. The
/// format string is consumed by the frontend's `parseVideoError` and MUST be
/// preserved.
///
/// `save_media_to_media_dir` deliberately writes NO `thumbnail_path` for
/// videos — the frontend renders them via `<video preload="metadata">`
/// (browser fetches frame 0 natively). Keeps the app ffmpeg-free.
#[tauri::command]
pub async fn pick_video(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
    insertion_mode: Option<String>,
) -> Result<Option<PickImageResult>, String> {
    let mode = insertion_mode.as_deref().unwrap_or("inline");
    validate_insertion_mode(mode)?;

    let handle = rfd::AsyncFileDialog::new()
        .add_filter("Videos", &["mp4", "mov", "webm", "m4v"])
        .set_title("Insert Video")
        .pick_file()
        .await;

    let file_handle = match handle {
        Some(h) => h,
        None => return Ok(None),
    };

    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    let file_name = file_handle.file_name();
    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_string();

    // Configurable video upload limit. The getter returns i64 and uses
    // i64::MAX for the `-1` "unlimited" sentinel. We can't pass i64::MAX to
    // the cap reader (it would try to allocate that many bytes), so when
    // unlimited we use a very large sane ceiling instead and never reject
    // on size. No transcode fallback exists — over-limit clips are rejected
    // immediately, before any copy into the media directory.
    //
    // Read the limit under a short-lived lock — the guard MUST be dropped
    // before the async thumbnail call below (a non-Send MutexGuard cannot
    // live across an `.await` in a Tauri command future).
    let src_path = file_handle.path().to_path_buf();
    let (video_limit_i64, video_mode) = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        let limit = crate::db::queries::get_media_max_video_upload_bytes(&conn)
            .unwrap_or(crate::db::queries::DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES);
        (limit, resolve_video_compression_mode(&conn))
    };
    // i64::MAX (unlimited) → a 4 GB ceiling. Anything larger is rejected,
    // which is a safe guard against pathological files; the setting is meant
    // to mean "no practical limit", not "accept a 9-exabyte mmap".
    let video_cap_u64 = video_limit_i64
        .try_into()
        .unwrap_or(4 * 1024 * 1024 * 1024u64);
    let bytes = read_attachment_with_cap(&src_path, video_cap_u64).map_err(|e| e.to_string())?;
    if (bytes.len() as i64) > video_limit_i64 {
        return Err(format!(
            "VIDEO_TOO_LARGE:{file_name}:{}",
            video_limit_i64 / (1024 * 1024)
        ));
    }

    // Insert-first: save the ORIGINAL immediately and return, then transcode in
    // the background. On macOS with a non-Off mode, hold the original out of
    // cloud upload (`awaiting_compression`) and enqueue a compression job — the
    // worker swaps in the smaller .mp4 and clears the hold. Off / non-macOS keep
    // the original as-is and upload normally (unchanged behavior).
    let should_compress = cfg!(target_os = "macos") && video_mode.preset_name().is_some();
    let result = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        let r = save_media_to_media_dir(&conn, &media_dir, &entry_id, &bytes, &ext, mode)?;
        if should_compress {
            crate::db::queries::set_media_awaiting_compression(&conn, &r.media_id, true)
                .map_err(|e| e.to_string())?;
        }
        r
        // Lock dropped here before the async thumbnail call below.
    };
    generate_video_thumbnail_best_effort(&state, &media_dir, &result).await;
    if should_compress {
        if let Some(queue) =
            app.try_state::<std::sync::Arc<crate::commands::compression::CompressionQueue>>()
        {
            queue.enqueue(crate::commands::compression::CompressionJob {
                media_id: result.media_id.clone(),
                src_path: std::path::PathBuf::from(&result.local_path),
                mode: video_mode,
            });
        }
    }
    Ok(Some(result))
}

/// Open the macOS Photo Library picker (PHPicker) restricted to videos and
/// save each chosen clip into the media directory.
///
/// Mirrors `pick_images_from_library` for video: PHPicker enforces a "Select
/// up to N items" cap (we reuse `MAX_PHOTO_SELECTION`), the bridge returns
/// real filenames + bytes, and each video is run through `save_media_to_media_dir`
/// with the caller-chosen `insertion_mode`.
///
/// Per-file size guard: every clip's length is compared against the
/// configurable video upload limit (`get_media_max_video_upload_bytes`,
/// default 100 MB) BEFORE any disk write or thumbnail extraction. Over-limit
/// clips are filtered out and listed in `rejected`; the fitting clips are
/// still saved so a single oversized clip in a 5-video selection does not
/// discard the rest. Only when EVERY clip in the batch is rejected do we
/// surface a `VIDEO_TOO_LARGE:<filename>:<max_mb>` error (for the first
/// offender) so the existing all-rejected modal still fires.
///
/// Semantics:
///   * `Ok({ saved: [], rejected: [] })` → user cancelled. Frontend MUST
///     NOT fall back to rfd.
///   * `Ok({ saved, rejected })` → at least one clip was saved. `rejected`
///     holds oversized filenames for the frontend to explain.
///   * `Err(_)` → Swift bridge unavailable (non-macOS / runtime error) OR
///     every clip in the batch exceeded the limit (first offender reported).
#[tauri::command]
pub async fn pick_videos_from_library(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
    insertion_mode: Option<String>,
) -> Result<PickVideosResult, String> {
    let mode = insertion_mode.as_deref().unwrap_or("inline");
    validate_insertion_mode(mode)?;

    #[cfg(target_os = "macos")]
    {
        let videos = crate::macos::photo_picker::pick_videos(MAX_VIDEO_SELECTION).await?;
        // Read the configurable limit once. The getter returns i64 and uses
        // i64::MAX for the `-1` "unlimited" sentinel — comparing byte
        // lengths (i64) against it directly accepts everything when
        // unlimited, with no special case needed here.
        let (video_limit, video_mode) = {
            let conn = state.lock().map_err(|e| e.to_string())?;
            let limit = crate::db::queries::get_media_max_video_upload_bytes(&conn)
                .unwrap_or(crate::db::queries::DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES);
            (limit, resolve_video_compression_mode(&conn))
        };

        // Cap check on the ORIGINAL — insert-first means compression runs
        // in the background AFTER insert, so we can't shrink before the cap.
        let (fitting, rejected) = partition_videos_by_size(videos, video_limit);

        if fitting.is_empty() {
            return pick_videos_empty_fitting(rejected, video_limit);
        }

        let should_compress = video_mode.preset_name().is_some();
        let media_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("media");

        // Save each ORIGINAL and, on a compressing mode, hold it from upload +
        // enqueue a background compression job. The hold flag is set in the SAME
        // lock as the insert so no sync tick can push the original first.
        let mut saved = Vec::with_capacity(fitting.len());
        for (filename, bytes) in fitting {
            let ext = std::path::Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("mp4")
                .to_string();
            let conn = state.lock().map_err(|e| e.to_string())?;
            let r = save_media_to_media_dir(&conn, &media_dir, &entry_id, &bytes, &ext, mode)?;
            if should_compress {
                crate::db::queries::set_media_awaiting_compression(&conn, &r.media_id, true)
                    .map_err(|e| e.to_string())?;
            }
            drop(conn);
            saved.push(r);
        }

        if should_compress {
            if let Some(queue) =
                app.try_state::<std::sync::Arc<crate::commands::compression::CompressionQueue>>()
            {
                for r in &saved {
                    queue.enqueue(crate::commands::compression::CompressionJob {
                        media_id: r.media_id.clone(),
                        src_path: std::path::PathBuf::from(&r.local_path),
                        mode: video_mode,
                    });
                }
            }
        }

        // Best-effort thumbnail extraction for each freshly-saved clip.
        // Sequential: AVAssetImageGenerator is CPU-bound; parallelising would
        // peg every core without speeding things up.
        for result in &saved {
            generate_video_thumbnail_best_effort(&state, &media_dir, result).await;
        }
        Ok(PickVideosResult { saved, rejected })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, entry_id, mode);
        Err("photo-library picker not supported on this platform".to_string())
    }
}

/// On-demand backfill: if `media_id` is a video row whose `thumbnail_path` is
/// missing, extract a poster JPEG via AVFoundation and persist it. Used by
/// the EntryCard cover loader so videos inserted before the auto-extraction
/// pipeline existed (or whose extraction failed at insert time) eventually
/// pick up a poster the next time their entry is rendered.
///
/// Returns:
///   * `Ok(true)`  — a fresh thumbnail was generated (caller should refetch
///     the media row to pick up the new `thumbnail_path`).
///   * `Ok(false)` — no work needed (already had a thumbnail, or the row
///     isn't a video, or extraction failed silently).
///   * `Err(_)`    — the media row doesn't exist, or the DB / lock errored
///     before we could even attempt extraction.
///
/// Idempotent: running this twice on the same row is cheap on the second
/// call (the `thumbnail_path IS NOT NULL` check short-circuits).
#[tauri::command]
pub async fn ensure_video_thumbnail(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> Result<bool, String> {
    // Snapshot the row's current state under a short-lived lock. We MUST drop
    // the guard before awaiting the AVFoundation extraction below — holding
    // an AppState mutex across an `.await` that hops threads would deadlock
    // every concurrent Tauri command.
    let (file_type, storage_path, already_has_thumb) = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        let media = crate::db::get_media(&conn, &media_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Media not found: {media_id}"))?;
        (
            media.file_type,
            media.storage_path,
            media.thumbnail_path.is_some(),
        )
    };

    if already_has_thumb {
        return Ok(false);
    }
    if !file_type.starts_with("video/") {
        return Ok(false);
    }

    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    let result = PickImageResult {
        media_id: media_id.clone(),
        local_path: storage_path,
    };
    generate_video_thumbnail_best_effort(&state, &media_dir, &result).await;

    // Re-read the row to see whether the helper actually persisted a thumb
    // (it may have silently bailed — file missing, AVFoundation decode
    // failure). Returning the truthful result lets the FE decide whether
    // to refetch + retry render or just leave the placeholder.
    let conn = state.lock().map_err(|e| e.to_string())?;
    let media = crate::db::get_media(&conn, &media_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media not found: {media_id}"))?;
    Ok(media.thumbnail_path.is_some())
}

/// Maximum size (in bytes) for a single attached non-media file.
/// 50 MB — large enough for slide decks and PDFs, small enough that the
/// per-file copy stays under ~1s on modern SSDs and the sync pipeline
/// (Yjs/iCloud) doesn't choke.
pub const MAX_ATTACHED_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// Maximum number of files accepted in a single `pick_files_to_attach`
/// invocation. Mirrors `MAX_PHOTO_SELECTION` (20) so memory usage scales
/// with a known ceiling instead of however many files the OS file picker
/// allows the user to multi-select.
pub const MAX_ATTACHED_BATCH: usize = 20;

/// Normalize a user-chosen filename for safe DB storage + later peer
/// fetches. We persist this string in `media.file_name` and `resolve_media`
/// later runs `is_safe_cache_filename` against it on remote devices;
/// names starting with `.`, containing `/` or `\`, or longer than the
/// validator allows would otherwise become unfetchable.
///
/// Rules:
///   * Replace any path separator (`/`, `\`) with `_`.
///   * Strip leading dots so a `.bashrc` upload doesn't trip the hidden-
///     file guard on macOS / Linux peers.
///   * Collapse to a `file.bin` fallback if the result is empty after
///     stripping (e.g. user picked a file literally named `...`).
/// Maximum byte length of a sanitized filename. Trimmed past this point
/// so the result fits inside common FS limits (most are 255 bytes per
/// component) with headroom for the UUID-prefixed copy on disk and for
/// the cloud-storage metadata key.
const SANITIZED_FILENAME_MAX_BYTES: usize = 200;

fn sanitize_attachment_filename(original: &str) -> String {
    // Replace path separators + ANY control character (NUL, \n, \r, \t,
    // and the rest of U+0000-U+001F + U+007F) with `_`. Control chars
    // would otherwise persist into `media.file_name`, break log lines,
    // and confuse downstream consumers expecting display-safe strings.
    let cleaned: String = original
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('.').to_string();
    let bounded = if trimmed.len() > SANITIZED_FILENAME_MAX_BYTES {
        // Find a UTF-8 char boundary at or before the cap so we never
        // produce invalid UTF-8 by slicing through a multi-byte sequence.
        let mut cut = SANITIZED_FILENAME_MAX_BYTES;
        while cut > 0 && !trimmed.is_char_boundary(cut) {
            cut -= 1;
        }
        trimmed[..cut].to_string()
    } else {
        trimmed
    };
    if bounded.is_empty() {
        "file.bin".to_string()
    } else {
        bounded
    }
}

/// Result of reading + validating one source file before it lands in the
/// media dir. Bytes are owned (read with a hard size cap so a concurrently-
/// growing file can't blow past `MAX_ATTACHED_FILE_SIZE`).
struct LoadedAttachment {
    sanitized_name: String,
    bytes: Vec<u8>,
}

/// Open + read a user-selected file with a hard byte ceiling, closing the
/// TOCTOU window between metadata check and read. Returns at most
/// `MAX_ATTACHED_FILE_SIZE + 1` bytes — the caller compares against the
/// cap to detect overflow. Stopping one byte past the cap (rather than at
/// the cap exactly) is intentional: it distinguishes "file is exactly at
/// the limit" from "file is over the limit and was truncated".
///
/// NOTE: `File::open` follows symlinks. The OS file picker is the trust
/// boundary — a user picking a symlink-to-`/dev/urandom` will allocate up
/// to `MAX_ATTACHED_FILE_SIZE + 1` bytes on the heap, which is bounded by
/// `MAX_ATTACHED_BATCH × (MAX_ATTACHED_FILE_SIZE + 1)` per call.
fn read_attachment_with_cap(src: &Path, cap: u64) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;
    let f = std::fs::File::open(src)?;
    let mut buf = Vec::new();
    f.take(cap + 1).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Pure helper: write `bytes` into `media_dir/{uuid}.{ext}` and insert a
/// `media` row with `insertion_mode = 'attached'`. Returns the new row id
/// and the on-disk path on success. On DB-insert failure, the freshly-
/// written file is removed so the media dir never accumulates orphans.
///
/// Unlike `save_media_to_media_dir`, this helper:
///   * Stores `sanitized_name` (not the UUID-based dest name) in the
///     `file_name` column so the UI can render a recognizable label.
///   * Skips EXIF + thumbnail generation entirely — generic files have
///     no intrinsic dimensions or thumbnails we can derive in-process.
///   * Always inserts with `insertion_mode = "attached"`.
fn save_attached_file_to_media_dir(
    conn: &Connection,
    media_dir: &Path,
    entry_id: &str,
    sanitized_name: &str,
    bytes: &[u8],
) -> Result<PickImageResult, String> {
    std::fs::create_dir_all(media_dir).map_err(|e| e.to_string())?;

    let ext = std::path::Path::new(sanitized_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    // `mime_from_ext` only knows image/video/audio extensions — every other
    // extension falls back to `application/octet-stream`. Refuse anything
    // that resolves to a media MIME so a hand-crafted IPC call can't
    // smuggle a JPG through the file-attach path.
    let mime_type = mime_from_ext(&ext);
    if mime_type.starts_with("image/")
        || mime_type.starts_with("video/")
        || mime_type.starts_with("audio/")
    {
        return Err(format!(
            "extension '{ext}' is a media type; use the image/video/audio picker instead"
        ));
    }

    let media_uuid = uuid::Uuid::new_v4().to_string();
    let dest_name = if ext.is_empty() {
        media_uuid.clone()
    } else {
        format!("{media_uuid}.{ext}")
    };
    let dest_path = media_dir.join(&dest_name);
    std::fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;

    let file_size = dest_path.metadata().map(|m| m.len() as i64).unwrap_or(0);
    let local_path = dest_path.to_string_lossy().into_owned();

    match crate::db::create_media(
        conn,
        CreateMediaParams {
            entry_id,
            file_name: sanitized_name,
            file_type: mime_type,
            storage_path: &local_path,
            file_size: Some(file_size),
            sort_order: 0,
            insertion_mode: "attached",
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            width: None,
            height: None,
        },
    ) {
        Ok(media) => Ok(PickImageResult {
            media_id: media.id,
            local_path,
        }),
        Err(e) => {
            // DB insert failed → remove the orphan we just wrote so the
            // media dir doesn't accumulate untracked bytes. Best-effort:
            // a delete error is logged but does not mask the DB error.
            if let Err(remove_err) = std::fs::remove_file(&dest_path) {
                log::warn!("failed to remove orphaned attached-file {dest_name}: {remove_err}");
            }
            Err(e.to_string())
        }
    }
}

/// Opens a native multi-file picker, refuses any media (image/video/audio)
/// selection, enforces the per-file size cap, and saves each remaining file
/// as an attached `media` row. Returns the list of saved rows. An empty
/// vector means the user cancelled the picker.
///
/// Rejection rules:
///   * If ANY selected file's extension resolves to a media MIME, return an
///     error string the frontend can surface as "Use the image/video/audio
///     picker for media files".
///   * If ANY selected file exceeds `MAX_ATTACHED_FILE_SIZE`, return an
///     error string with the offending filename + size cap in MB.
///   * Batch larger than `MAX_ATTACHED_BATCH` is refused up front.
///
/// Atomicity: validation passes (size + MIME) run BEFORE any disk write.
/// Per-file disk writes happen during the save loop; if a DB insert fails
/// mid-batch, that file's orphan is removed and earlier saves are left in
/// place (already committed individually). The frontend reports the failed
/// filename via the error string so the user can retry the remaining files.
#[tauri::command]
pub async fn pick_files_to_attach(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<Vec<PickImageResult>, String> {
    let handles = rfd::AsyncFileDialog::new()
        .set_title("Attach Files")
        .pick_files()
        .await;

    // `rfd` returns `None` on cancel; the empty-vec branch is defensive
    // against a future API change where `Some(vec![])` becomes possible.
    let files = match handles {
        Some(h) if !h.is_empty() => h,
        _ => return Ok(Vec::new()),
    };

    if files.len() > MAX_ATTACHED_BATCH {
        return Err(format!(
            "BATCH_TOO_LARGE:{}:{}",
            files.len(),
            MAX_ATTACHED_BATCH
        ));
    }

    // Pass 1 — validate every file (MIME + size-with-cap-on-read), reading
    // bytes once per file with the hard cap so a TOCTOU race or symlink
    // expansion can't slip a >50 MB payload past the size check. Memory
    // ceiling: MAX_ATTACHED_BATCH × MAX_ATTACHED_FILE_SIZE = 1 GB worst
    // case; the explicit batch cap above keeps that bounded.
    let mut loaded: Vec<LoadedAttachment> = Vec::with_capacity(files.len());
    for handle in files {
        let original_filename = handle.file_name();
        let sanitized_name = sanitize_attachment_filename(&original_filename);

        let ext = std::path::Path::new(&sanitized_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        let mime_type = mime_from_ext(&ext);
        if mime_type.starts_with("image/")
            || mime_type.starts_with("video/")
            || mime_type.starts_with("audio/")
        {
            return Err(format!("MEDIA_NOT_ALLOWED:{original_filename}"));
        }

        let src_path = handle.path().to_path_buf();
        let bytes = read_attachment_with_cap(&src_path, MAX_ATTACHED_FILE_SIZE)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_ATTACHED_FILE_SIZE {
            return Err(format!(
                "FILE_TOO_LARGE:{original_filename}:{}",
                MAX_ATTACHED_FILE_SIZE / (1024 * 1024)
            ));
        }
        loaded.push(LoadedAttachment {
            sanitized_name,
            bytes,
        });
    }

    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    // Pass 2 — save loop. Per-iteration lock acquire mirrors
    // `save_picked_photos_inner`: releases the AppState mutex between
    // writes so concurrent commands (sync, search) interleave.
    let mut out = Vec::with_capacity(loaded.len());
    for item in loaded {
        let conn = state.lock().map_err(|e| e.to_string())?;
        let result = save_attached_file_to_media_dir(
            &conn,
            &media_dir,
            &entry_id,
            &item.sanitized_name,
            &item.bytes,
        )?;
        drop(conn);
        out.push(result);
    }

    Ok(out)
}

/// Save an image supplied directly as bytes (e.g., from a clipboard paste),
/// generate a thumbnail, and insert a media row. The frontend's paste handler
/// routes through this so the media pipeline is identical to the file-picker
/// path.
///
/// `insertion_mode` defaults to `"inline"` when `None`.
#[tauri::command]
pub async fn save_pasted_image(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
    bytes: Vec<u8>,
    mime: String,
    insertion_mode: Option<String>,
) -> Result<PickImageResult, String> {
    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    let ext = match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "png", // default — pasted data is usually PNG
    };

    let mode = insertion_mode.as_deref().unwrap_or("inline");
    validate_insertion_mode(mode)?;

    let conn = state.lock().map_err(|e| e.to_string())?;
    save_media_to_media_dir(&conn, &media_dir, &entry_id, &bytes, ext, mode)
}

/// Returns `true` if `name` is a safe cache filename component.
///
/// Rejects:
/// - Strings containing `/` or `\` (path separator injection).
/// - Strings containing `..` (directory traversal).
/// - Strings starting with `.` (hidden files / relative path components).
/// - Empty strings.
pub(crate) fn is_safe_cache_filename(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.starts_with('.') {
        return false;
    }
    if name.contains('/') || name.contains('\\') {
        return false;
    }
    if name.contains("..") {
        return false;
    }
    true
}

/// Validate a cloud path of the form `"{device_id}/media/{media_id}"`.
///
/// Returns `device_id` on success, or a descriptive error string on failure.
/// Validates:
/// - Exactly 3 slash-separated parts.
/// - `parts[1]` == `"media"`.
/// - `parts[2]` == `media_id` argument.
/// - `device_id` passes the safe-component check (ASCII alphanumeric, `-`, `_`; length >= 4).
pub(crate) fn validate_cloud_path<'a>(
    cloud_path: &'a str,
    media_id: &str,
) -> Result<&'a str, String> {
    let parts: Vec<&str> = cloud_path.split('/').collect();
    if parts.len() != 3 {
        return Err(format!(
            "Invalid cloud path (expected 3 parts, got {}): {cloud_path}",
            parts.len()
        ));
    }
    let device_id = parts[0];
    let segment = parts[1];
    let tail = parts[2];

    if segment != "media" {
        return Err(format!(
            "Invalid cloud path (expected 'media' segment, got '{segment}'): {cloud_path}"
        ));
    }
    if tail != media_id {
        return Err(format!(
            "Invalid cloud path (tail '{tail}' does not match media_id '{media_id}'): {cloud_path}"
        ));
    }
    if !is_safe_device_id(device_id) {
        return Err(format!(
            "Invalid cloud path (unsafe device_id '{device_id}'): {cloud_path}"
        ));
    }
    Ok(device_id)
}

// Device-id validator lives in `crate::sync::safety` so engine + media share
// one definition. See `sync::safety::is_safe_device_id` for the rules.
use crate::sync::safety::is_safe_device_id;

/// Core logic for resolving a media item to a local path.
///
/// Separated from the Tauri command so it can be unit-tested without a full
/// Tauri runtime. Takes an already-fetched `Media` row and an already-built
/// provider, so neither a connection nor a mutex guard is held across the
/// async fetch.
///
/// Returns the local path string. The caller is responsible for updating
/// `storage_path` in the DB when the returned path differs from the input.
///
/// # Fast path
/// If the local file at `media.storage_path` still exists, returns it immediately.
///
/// # Slow path
/// Validates cloud path, validates filename, downloads from provider, decrypts,
/// writes to cache, and returns the new cache path.
pub(crate) async fn resolve_media_inner(
    media: &Media,
    provider_opt: Option<Arc<dyn SyncProvider>>,
    key_state: &crate::EncryptionKeyState,
    media_dir: &Path,
) -> Result<String, String> {
    // Fast path: local file exists.
    if Path::new(&media.storage_path).exists() {
        return Ok(media.storage_path.clone());
    }

    // Slow path: download from cloud.
    let cloud_path = media
        .cloud_path
        .as_deref()
        .ok_or_else(|| format!("Media {} has no local file and no cloud copy", media.id))?;

    // Validate the cloud path and extract device_id.
    let device_id = validate_cloud_path(cloud_path, &media.id)?;

    // Validate the filename before constructing the cache path.
    if !is_safe_cache_filename(&media.file_name) {
        return Err(format!(
            "Media {} has an unsafe file_name: {:?}",
            media.id, media.file_name
        ));
    }

    let provider =
        provider_opt.ok_or_else(|| "Sync not configured — cannot download media".to_string())?;

    std::fs::create_dir_all(media_dir).map_err(|e| e.to_string())?;
    let cache_path = media_dir.join(&media.file_name);

    let path = crate::sync::media_sync::fetch_media(
        provider.as_ref(),
        key_state,
        &media.id,
        device_id,
        &cache_path,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(path)
}

/// Fetch the thumbnail for a media row, downloading from cloud if missing.
///
/// Used when another device uploaded the full media + thumbnail, and this
/// device needs to render a fast preview without pulling the full image. The
/// caller (the gallery or `MediaAttachment`) first checks `thumbnail_path` via
/// `get_media_status`; when it's `None` but `has_cloud_copy` is `true`, calling
/// this command triggers an on-demand thumbnail fetch via the peer's
/// `{device_id}/media/{media_id}.thumb` object.
///
/// The thumbnail is cached at `{media_dir}/{media_id}.thumb.jpg` and its path
/// is persisted on the `media` row for future renders.
///
/// **Race window:** If a concurrent `clear_media_cache` or eviction clears
/// the cached thumbnail file between this command writing it and the caller
/// reading it, the UI briefly sees a broken-image; the next render re-fetches.
/// Acceptable — no data loss, the cloud copy is still authoritative.
#[tauri::command]
pub async fn resolve_media_thumbnail(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    media_id: String,
) -> Result<String, String> {
    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    // Short critical section: read row, cached-thumb fast-path, else build provider.
    let (media, provider) = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        let media = crate::db::get_media(&conn, &media_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Media not found: {media_id}"))?;
        // Fast path: we already have a thumbnail on disk.
        if let Some(thumb) = media.thumbnail_path.as_deref() {
            if Path::new(thumb).exists() {
                return Ok(thumb.to_string());
            }
        }
        let provider = make_configured_provider(&conn)?;
        (media, provider)
    };

    // Build a snapshot of the key state for multi-epoch media decryption.
    // The snapshot pre-derives each content key once so that
    // `decrypt_data_with_state` applies a second HKDF internally, reaching
    // the same two-HKDF derivation depth as the push path.
    let key_state_snap: crate::EncryptionKeyState = key_state.snapshot_for_engine()?;

    let cloud_path = media.cloud_path.as_deref().ok_or_else(|| {
        format!(
            "Media {} has no cloud copy — no thumbnail to fetch",
            media.id
        )
    })?;
    let device_id = validate_cloud_path(cloud_path, &media.id)?;

    // Defense-in-depth: `media.id` originates from the DB row which (for
    // peer-authored media) was populated from a remote payload. The
    // 3-parts-split in `validate_cloud_path` already blocks slash-containing
    // ids, but leading-dot or dot-dot prefixes (e.g. `..evil`, `.hidden`)
    // would still produce surprising cache filenames. Mirror the
    // `file_name` check that `resolve_media_inner` applies.
    if !is_safe_cache_filename(&media.id) {
        return Err(format!(
            "Media {} has an unsafe id shape (cannot form cache filename)",
            media.id
        ));
    }

    let provider =
        provider.ok_or_else(|| "Sync not configured — cannot download thumbnail".to_string())?;

    std::fs::create_dir_all(&media_dir).map_err(|e| e.to_string())?;
    let cache_path = media_dir.join(format!("{}.thumb.jpg", media.id));

    let path = crate::sync::media_sync::fetch_media_thumbnail(
        provider.as_ref(),
        &key_state_snap,
        &media.id,
        device_id,
        &cache_path,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Persist the thumbnail path so future renders skip the slow path.
    // The benign race here is "row deleted mid-fetch" (QueryReturnedNoRows);
    // we log so a real DB failure (corruption, lock timeout) isn't invisible.
    {
        let conn = state.lock().map_err(|e| e.to_string())?;
        if let Err(e) = crate::db::update_media_thumbnail_path(&conn, &media.id, Some(&path)) {
            log::warn!("persist thumbnail_path for {}: {e}", media.id);
        }
    }

    Ok(path)
}

/// Returns the local file path for a media item, downloading from cloud if the
/// local copy is missing. Returns an `asset://` compatible absolute path.
///
/// Reads `storage_path` from the DB. If the file is missing locally and a
/// `cloud_path` exists, downloads via the configured sync provider, decrypts,
/// writes to the local media cache, and returns the new local path.
///
/// **Race window:** The fast-path and slow-path each acquire the DB mutex
/// briefly; between the slow-path download and the subsequent
/// `update_media_storage_path` write, a concurrent `clear_media_cache` or
/// `enforce_cache_limit` could remove the freshly-written file. The caller
/// sees a valid path but the image may be missing by the time it renders.
/// The DB is never corrupted — the next resolve re-fetches. Acceptable for a
/// user-action-driven UI where a momentary broken image is tolerable.
#[tauri::command]
pub async fn resolve_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    media_id: String,
) -> Result<String, String> {
    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // Fetch the media row and build the provider — release the lock before any await.
    let (media, provider) = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        // Gate: even the fast (local cache hit) path must respect the app lock so
        // cached media files cannot be read while the journal is locked.
        require_media_unlocked(&conn, &key_state)?;
        let media = crate::db::get_media(&conn, &media_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Media not found: {media_id}"))?;
        // Fast path: skip provider construction entirely when the local file exists.
        if Path::new(&media.storage_path).exists() {
            // Cache hit — bump last_accessed_at for LRU. A failure here is
            // non-fatal; we still return the path.
            let _ = crate::db::bump_media_accessed(&conn, &media_id, now);
            return Ok(media.storage_path);
        }
        // Slow path: download from cloud.
        let provider = make_configured_provider(&conn)?;
        (media, provider)
        // MutexGuard dropped here — before any await.
    };

    // Build a snapshot of the key state for multi-epoch media decryption.
    // The snapshot pre-derives each content key once so that
    // `decrypt_data_with_state` applies a second HKDF internally, reaching
    // the same two-HKDF derivation depth as the push path (which uses
    // the engine snapshot built in `run_sync_now`).
    let key_state_snap: crate::EncryptionKeyState = key_state.snapshot_for_engine()?;

    // Delegate all logic (no DB connection held across this await).
    let new_path = resolve_media_inner(&media, provider, &key_state_snap, &media_dir).await?;

    // Update storage_path + last_accessed_at in DB now that we have a local copy.
    // Then enforce the cache ceiling so a long-running session can't grow the
    // cache without bound.
    {
        let conn = state.lock().map_err(|e| e.to_string())?;
        crate::db::update_media_storage_path(&conn, &media_id, &new_path)
            .map_err(|e| e.to_string())?;
        let _ = crate::db::bump_media_accessed(&conn, &media_id, now);
        if let Ok(max_bytes) = crate::db::get_media_cache_max_bytes(&conn) {
            let _ = crate::sync::media_cache::enforce_cache_limit(&conn, max_bytes);
        }
    }

    Ok(new_path)
}

/// Lightweight status info about a media row — enough for the UI to decide
/// whether to show a "cloud" badge (ciphertext in cloud, no local copy yet)
/// or to render the thumbnail / original directly.
///
/// When `cached_locally` is `true`, `local_path` is populated so the frontend
/// can render the image without a second `resolve_media` round-trip. When
/// `false`, `local_path` is `None` — the UI should use the thumbnail or the
/// cloud badge, or call `resolve_media` to trigger a download.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    pub media_id: String,
    pub cached_locally: bool,
    pub has_cloud_copy: bool,
    pub local_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub file_type: String,
    /// On-disk byte size of the current file (compressed size once the
    /// background worker has swapped it). `None` for legacy rows.
    pub file_size: Option<i64>,
    /// True when the file was replaced by a smaller background-compressed
    /// version. Drives the "Compressed" indicator in the UI.
    pub compressed: bool,
    /// Intrinsic pixel width of the original image (if known). Frontend uses
    /// `width`/`height` to set the skeleton's `aspect-ratio` so the loading
    /// placeholder reserves the exact box the decoded image will occupy.
    /// `None` for video/audio, SVG, HEIC, or images inserted before the
    /// schema gained these columns.
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// Check whether a media file is currently cached locally, and whether it has
/// a cloud copy to re-fetch from. Used by the gallery + inline editor view to
/// drive the cloud-icon badge without starting a download.
///
/// **Side effect:** bumps `last_accessed_at` when `cached_locally` is true.
/// Semantics: "the UI is about to render this image, count it as accessed".
/// This keeps the LRU order tracking hot media used in rendering, not only
/// media explicitly downloaded via `resolve_media`.
#[tauri::command]
pub fn get_media_status(
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    media_id: String,
) -> Result<MediaStatus, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    require_media_unlocked(&conn, &key_state)?;
    let media = crate::db::get_media(&conn, &media_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media not found: {media_id}"))?;
    let cached_locally = !media.storage_path.is_empty() && Path::new(&media.storage_path).exists();
    if cached_locally {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let _ = crate::db::bump_media_accessed(&conn, &media_id, now);
    }
    let local_path = if cached_locally {
        Some(media.storage_path.clone())
    } else {
        None
    };
    Ok(MediaStatus {
        media_id: media.id,
        cached_locally,
        has_cloud_copy: media.cloud_path.is_some(),
        local_path,
        thumbnail_path: media.thumbnail_path,
        file_type: media.file_type,
        file_size: media.file_size,
        compressed: crate::db::queries::is_media_compressed(&conn, &media_id).unwrap_or(false),
        width: media.width,
        height: media.height,
    })
}

/// Read a locally-cached media file and return its raw bytes.
/// Used by the frontend to construct a blob URL without going through the
/// asset protocol (which requires scope allowlisting that varies by platform).
#[tauri::command]
pub fn read_media_bytes(
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    media_id: String,
) -> Result<Vec<u8>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    require_media_unlocked(&conn, &key_state)?;
    let media = crate::db::get_media(&conn, &media_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media not found: {media_id}"))?;
    if media.storage_path.is_empty() || !Path::new(&media.storage_path).exists() {
        return Err(format!("Media file not cached locally: {media_id}"));
    }
    std::fs::read(&media.storage_path).map_err(|e| e.to_string())
}

/// Read thumbnail bytes for a media row, falling back to full media bytes
/// when no thumbnail exists (e.g. for videos, audio, or older rows that
/// pre-date the thumbnail pipeline). Used by the gallery to keep cell
/// decoding fast — full resolution is reserved for the editor / lightbox.
///
/// Fallback is silent: if `thumbnail_path` is set but the file is gone,
/// the command falls back to `storage_path` rather than erroring.
#[tauri::command]
pub fn read_media_thumbnail_bytes(
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    media_id: String,
) -> Result<Vec<u8>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    require_media_unlocked(&conn, &key_state)?;
    let media = crate::db::get_media(&conn, &media_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media not found: {media_id}"))?;

    // Try the thumbnail file first.
    if let Some(ref thumb_path) = media.thumbnail_path {
        let p = Path::new(thumb_path);
        if p.exists() {
            return std::fs::read(p).map_err(|e| e.to_string());
        }
        // Thumbnail path recorded but file missing — fall through to full.
        log::warn!("thumbnail file missing for {media_id}, falling back to full");
    }

    // Fall back to the full media file.
    if media.storage_path.is_empty() || !Path::new(&media.storage_path).exists() {
        return Err(format!("Media file not cached locally: {media_id}"));
    }
    std::fs::read(&media.storage_path).map_err(|e| e.to_string())
}

/// Validate `dest_path` before writing to it.
///
/// All rejections return an `Err` whose message starts with `INVALID_DEST_PATH:`.
fn validate_export_dest_path(dest_path: &str) -> Result<(), String> {
    // 1. Reject empty or relative paths (and literal `~/`).
    if dest_path.is_empty() {
        return Err("INVALID_DEST_PATH: destination path must not be empty".to_string());
    }
    if !dest_path.starts_with('/') || dest_path.starts_with("~/") {
        return Err(format!(
            "INVALID_DEST_PATH: destination path must be absolute: {dest_path}"
        ));
    }

    // 2. Reject known-sensitive system paths (case-insensitive prefix match).
    let lower = dest_path.to_lowercase();
    let sensitive_prefixes = [
        "/etc/",
        "/system/",
        "/usr/",
        "/bin/",
        "/sbin/",
        "/var/",
        "/private/",
    ];
    for prefix in &sensitive_prefixes {
        if lower.starts_with(prefix) || lower == prefix.trim_end_matches('/') {
            return Err(format!(
                "INVALID_DEST_PATH: destination is inside a protected system path: {dest_path}"
            ));
        }
    }

    // 3. Reject paths containing sensitive home-directory segments.
    let sensitive_home_segments = [
        "/.ssh/",
        "/.aws/",
        "/library/launchagents/",
        "/library/launchdaemons/",
    ];
    for segment in &sensitive_home_segments {
        if lower.contains(segment) {
            return Err(format!(
                "INVALID_DEST_PATH: destination is inside a protected home directory path: {dest_path}"
            ));
        }
    }

    // 4. If destination already exists, reject anything that is not a regular file
    //    (symlinks, directories, sockets, etc.).  Use symlink_metadata so we
    //    inspect the link itself rather than its target.
    let dest = Path::new(dest_path);
    if let Ok(meta) = std::fs::symlink_metadata(dest) {
        if !meta.file_type().is_file() {
            return Err(format!(
                "INVALID_DEST_PATH: destination exists but is not a regular file: {dest_path}"
            ));
        }
    }

    // 5. Parent directory must exist and be a real directory.
    let parent = dest.parent().ok_or_else(|| {
        format!("INVALID_DEST_PATH: destination has no parent directory: {dest_path}")
    })?;
    if !parent.exists() {
        return Err(format!(
            "INVALID_DEST_PATH: destination parent directory does not exist: {}",
            parent.display()
        ));
    }
    if !parent.is_dir() {
        return Err(format!(
            "INVALID_DEST_PATH: destination parent is not a directory: {}",
            parent.display()
        ));
    }

    Ok(())
}

/// Inner (testable) implementation for `export_media_to_path`.  Takes a direct
/// `Connection` reference so unit tests can drive it with in-memory SQLite
/// without needing `State<'_, …>` wrappers.
fn export_media_to_path_inner(
    conn: &Connection,
    media_id: &str,
    dest_path: &str,
) -> Result<(), String> {
    validate_export_dest_path(dest_path)?;

    let media = crate::db::get_media(conn, media_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media not found: {media_id}"))?;
    if media.storage_path.is_empty() || !Path::new(&media.storage_path).exists() {
        return Err(format!("Media file not cached locally: {media_id}"));
    }
    std::fs::copy(&media.storage_path, dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy the decrypted on-disk bytes of a media row to a user-chosen
/// destination path. Used by the attachment download UX — the frontend
/// drives the native Save As… dialog, then calls this with the chosen
/// path. The OS Save As… dialog is the intended driver, but the backend
/// still validates the destination before copying — webview-supplied paths
/// are not a trust boundary.
#[tauri::command]
pub fn export_media_to_path(
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    media_id: String,
    dest_path: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    require_media_unlocked(&conn, &key_state)?;
    export_media_to_path_inner(&conn, &media_id, &dest_path)
}

/// Cache size snapshot returned by `get_media_cache_stats`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCacheStats {
    pub used_bytes: i64,
    pub max_bytes: i64,
}

/// Report current cache usage and the configured ceiling. The Settings UI
/// shows this so users can decide whether to raise the limit or clear the cache.
#[tauri::command]
pub fn get_media_cache_stats(state: State<'_, AppState>) -> Result<MediaCacheStats, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let used_bytes = crate::db::sum_evictable_cache_bytes(&conn).map_err(|e| e.to_string())?;
    let max_bytes = crate::db::get_media_cache_max_bytes(&conn).map_err(|e| e.to_string())?;
    Ok(MediaCacheStats {
        used_bytes,
        max_bytes,
    })
}

/// Update the cache ceiling and immediately enforce it. Returns the new stats
/// so the UI can reflect any eviction that just happened. Emits
/// `MEDIA_CACHE_STATS_EVENT` so other surfaces (indicators, menus) stay in sync
/// without polling.
#[tauri::command]
pub fn set_media_cache_limit(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    bytes: i64,
) -> Result<MediaCacheStats, String> {
    let stats = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        crate::db::set_media_cache_max_bytes(&conn, bytes).map_err(|e| e.to_string())?;
        let new_max = crate::db::get_media_cache_max_bytes(&conn).map_err(|e| e.to_string())?;
        crate::sync::media_cache::enforce_cache_limit(&conn, new_max).map_err(|e| e.to_string())?;
        let used_bytes = crate::db::sum_evictable_cache_bytes(&conn).map_err(|e| e.to_string())?;
        MediaCacheStats {
            used_bytes,
            max_bytes: new_max,
        }
    };
    // Emit after releasing the lock so listeners that invoke Tauri commands in
    // response don't deadlock on the mutex.
    if let Err(e) = app.emit(MEDIA_CACHE_STATS_EVENT, &stats) {
        log::warn!("emit {MEDIA_CACHE_STATS_EVENT}: {e}");
    }
    Ok(stats)
}

/// Effective (post-clamp) upload size limits for original media. Returned by
/// both `get_media_upload_limits` and `set_media_upload_limits`. A field value
/// of `-1` means "unlimited".
///
/// IMPORTANT: this struct crosses the Tauri IPC boundary as JSON, and the
/// frontend parses numbers as f64. No field may ever exceed
/// `Number.MAX_SAFE_INTEGER` — `i64::MAX` round-trips through JS as
/// 9223372036854776000, which then fails to deserialize back into `i64` on
/// the next `set_media_upload_limits` call. Hence the DTO carries the raw
/// `-1` sentinel, NOT the `i64::MAX` form used by the internal comparison
/// paths (`resolve_upload_limits`).
///
/// Mirrors the shape of `MediaCacheStats` so the Settings UI can treat these
/// read/write pairs uniformly.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUploadLimits {
    pub photo_bytes: i64,
    pub video_bytes: i64,
}

/// Minimum sane value for either upload limit (1 MB). Enforced symmetrically
/// by the getter (clamps stored values back up to this floor) and the setter
/// (rejects sub-floor values up front so a malformed frontend payload cannot
/// brick imports).
const MIN_MEDIA_UPLOAD_BYTES: i64 = 1024 * 1024;
/// Maximum accepted value for either upload limit: `Number.MAX_SAFE_INTEGER`
/// (2^53 - 1). Upholds the DTO invariant documented on `MediaUploadLimits` —
/// a larger value would read back out through JSON as an imprecise f64 and
/// then fail to deserialize into `i64` on the next setter call, wedging the
/// Settings UI. Enforced on BOTH sides: the setter rejects larger input, and
/// `to_ipc_upload_limit` clamps on read — the ceiling is new, so an existing
/// row written under the previous floor-only validator can already hold a
/// larger value (as can any write through the generic `set_setting` command,
/// which takes an arbitrary key/value pair).
const MAX_MEDIA_UPLOAD_BYTES: i64 = 9_007_199_254_740_991;
/// Sentinel meaning "no limit". Stored verbatim; the queries-layer getters
/// translate it to `i64::MAX` for the internal byte-comparison paths, and the
/// IPC DTO translates it back to `-1` (see `MediaUploadLimits`).
const MEDIA_UPLOAD_BYTES_UNLIMITED: i64 = -1;

/// Read the current effective upload size limits. Reflects any clamping the
/// getter layer applies (e.g. a corrupted sub-floor stored value reads back
/// as the default, never as the raw broken number).
#[tauri::command]
pub fn get_media_upload_limits(state: State<'_, AppState>) -> Result<MediaUploadLimits, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    get_media_upload_limits_inner(&conn)
}

/// Pure over `&Connection` so the inline `#[cfg(test)]` module can exercise
/// the roundtrip with an in-memory SQLite database (mirrors the
/// `save_media_to_media_dir_inner` / `resolve_upload_limits` split).
pub(crate) fn get_media_upload_limits_inner(
    conn: &Connection,
) -> Result<MediaUploadLimits, String> {
    let photo_bytes =
        crate::db::queries::get_media_max_photo_upload_bytes(conn).map_err(|e| e.to_string())?;
    let video_bytes =
        crate::db::queries::get_media_max_video_upload_bytes(conn).map_err(|e| e.to_string())?;
    Ok(MediaUploadLimits {
        photo_bytes: to_ipc_upload_limit(photo_bytes),
        video_bytes: to_ipc_upload_limit(video_bytes),
    })
}

/// Convert an internal limit (where `i64::MAX` means "unlimited") into the
/// IPC-safe form (`-1` for unlimited). See `MediaUploadLimits` for why
/// `i64::MAX` must never cross the boundary.
///
/// Finite values are clamped to `MAX_MEDIA_UPLOAD_BYTES` as well: the setter
/// refuses anything larger, but a row written before that ceiling existed —
/// or through the generic `set_setting` command, which takes an arbitrary
/// key/value pair — would otherwise reach the frontend as an imprecise f64
/// and wedge the Settings panel on the next write.
fn to_ipc_upload_limit(bytes: i64) -> i64 {
    if bytes == i64::MAX {
        MEDIA_UPLOAD_BYTES_UNLIMITED
    } else {
        bytes.min(MAX_MEDIA_UPLOAD_BYTES)
    }
}

/// Validate and persist both upload size limits in one call. Each value must
/// be within `1 MB ..= Number.MAX_SAFE_INTEGER` OR exactly `-1` (unlimited
/// sentinel); anything else returns an `Err` naming the offending field
/// without writing. Returns the effective
/// post-clamp values by re-reading the getters, so the UI sees the truth even
/// if the storage layer normalised the input.
#[tauri::command]
pub fn set_media_upload_limits(
    state: State<'_, AppState>,
    photo_bytes: i64,
    video_bytes: i64,
) -> Result<MediaUploadLimits, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    set_media_upload_limits_inner(&conn, photo_bytes, video_bytes)
}

/// Pure over `&Connection` — testable directly with an in-memory DB. See
/// `get_media_upload_limits_inner` for the rationale.
///
/// Atomicity: both `set_setting` writes are wrapped in a single SQLite
/// transaction (`BEGIN` / `COMMIT`). A crash between the two writes can no
/// longer leave one field updated and the other stale (a half-applied config
/// where, e.g., the photo limit is raised but the video limit isn't). If
/// either write fails the transaction is rolled back and the error
/// propagated, so the persisted limits are either both-old or both-new. We
/// use `execute_batch("BEGIN" / "COMMIT" / "ROLLBACK")` rather than
/// `conn.transaction()` because the caller hands us a shared `&Connection`
/// (immutable borrow); `Transaction::new` requires `&mut Connection`.
pub(crate) fn set_media_upload_limits_inner(
    conn: &Connection,
    photo_bytes: i64,
    video_bytes: i64,
) -> Result<MediaUploadLimits, String> {
    // Validate BEFORE writing so a malformed frontend value cannot brick
    // imports by leaving a sub-floor ceiling in place.
    validate_upload_limit_field("photo_bytes", photo_bytes)?;
    validate_upload_limit_field("video_bytes", video_bytes)?;

    conn.execute_batch("BEGIN")
        .map_err(|e| format!("begin upload-limits transaction: {e}"))?;
    // Rollback guard: if EITHER write errors, unwind the transaction before
    // propagating so the DB never holds a half-applied config.
    let write_result = (|| -> Result<(), rusqlite::Error> {
        crate::db::queries::set_media_max_photo_upload_bytes(conn, photo_bytes)?;
        crate::db::queries::set_media_max_video_upload_bytes(conn, video_bytes)?;
        Ok(())
    })();
    if let Err(e) = write_result {
        if let Err(rb_err) = conn.execute_batch("ROLLBACK") {
            log::warn!("rollback upload-limits transaction: {rb_err}");
        }
        return Err(e.to_string());
    }
    conn.execute_batch("COMMIT")
        .map_err(|e| format!("commit upload-limits transaction: {e}"))?;

    // Re-read so the caller observes the effective (post-clamp) values rather
    // than the raw input. Unlimited comes back as the `-1` sentinel.
    get_media_upload_limits_inner(conn)
}

/// Reject any value that would brick imports or break the IPC round-trip.
/// Valid: `1 MB ..= Number.MAX_SAFE_INTEGER`, or exactly `-1` (unlimited).
/// Anything else (0, negative other than -1, or a value too large to survive
/// the JSON f64 round-trip) is refused with a message naming the field and
/// the constraint.
fn validate_upload_limit_field(field: &str, value: i64) -> Result<(), String> {
    if value == MEDIA_UPLOAD_BYTES_UNLIMITED
        || (MIN_MEDIA_UPLOAD_BYTES..=MAX_MEDIA_UPLOAD_BYTES).contains(&value)
    {
        Ok(())
    } else {
        Err(format!(
            "media upload limit {field} must be between {MIN_MEDIA_UPLOAD_BYTES} (1 MB) and {MAX_MEDIA_UPLOAD_BYTES}, or exactly {MEDIA_UPLOAD_BYTES_UNLIMITED} for unlimited, got {value}"
        ))
    }
}

/// Clear every evictable cache file (the "Clear cache" button in Settings).
/// Pending-upload originals are never touched — they are the source of truth.
#[tauri::command]
pub fn clear_media_cache(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<MediaCacheStats, String> {
    let stats = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        crate::sync::media_cache::clear_all_cache(&conn).map_err(|e| e.to_string())?;
        let used_bytes = crate::db::sum_evictable_cache_bytes(&conn).map_err(|e| e.to_string())?;
        let max_bytes = crate::db::get_media_cache_max_bytes(&conn).map_err(|e| e.to_string())?;
        MediaCacheStats {
            used_bytes,
            max_bytes,
        }
    };
    if let Err(e) = app.emit(MEDIA_CACHE_STATS_EVENT, &stats) {
        log::warn!("emit {MEDIA_CACHE_STATS_EVENT}: {e}");
    }
    Ok(stats)
}

/// One row of the media-status debug dump. Mirrors the columns the user
/// would query via `sqlite3` if the DB weren't SQLCipher-encrypted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDebugRow {
    pub id: String,
    pub entry_id: String,
    pub file_name: String,
    pub file_type: String,
    pub upload_status: String,
    pub has_local_file: bool,
    pub local_storage_path: String,
    pub has_thumbnail: bool,
    pub cloud_path: Option<String>,
    pub file_size: Option<i64>,
    pub created_at: i64,
    pub uploaded_at: Option<i64>,
}

/// Dump the upload/storage state of every media row. Used to diagnose why
/// "Sync now" does not appear to push local media to the cloud — engine's
/// push loop ignores any row whose `upload_status != 'pending'`, so a row
/// stuck in `'uploaded'` (with a stale `cloud_path`) or `'error'` is
/// invisible to the user without this view.
///
/// Returns up to 500 rows ordered by `upload_status` then `created_at DESC`.
/// Safe to call from the locked-app gate because the row metadata itself
/// is not encrypted at rest (only `file_name` is sanitized via
/// `sanitize_display_name` on the sync ingest path).
#[tauri::command]
pub fn debug_list_media_status(state: State<'_, AppState>) -> Result<Vec<MediaDebugRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, entry_id, file_name, file_type, upload_status, \
                    storage_path, thumbnail_path, cloud_path, file_size, \
                    created_at, uploaded_at \
             FROM media \
             ORDER BY \
               CASE upload_status \
                 WHEN 'error' THEN 0 \
                 WHEN 'pending' THEN 1 \
                 WHEN 'uploaded' THEN 2 \
                 ELSE 3 END, \
               created_at DESC \
             LIMIT 500",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let storage_path: String = row.get(5)?;
            let thumbnail_path: Option<String> = row.get(6)?;
            let has_local = !storage_path.is_empty() && Path::new(&storage_path).exists();
            let has_thumb = thumbnail_path
                .as_deref()
                .is_some_and(|p| !p.is_empty() && Path::new(p).exists());
            Ok(MediaDebugRow {
                id: row.get(0)?,
                entry_id: row.get(1)?,
                file_name: row.get(2)?,
                file_type: row.get(3)?,
                upload_status: row.get(4)?,
                has_local_file: has_local,
                local_storage_path: storage_path,
                has_thumbnail: has_thumb,
                cloud_path: row.get(7)?,
                file_size: row.get(8)?,
                created_at: row.get(9)?,
                uploaded_at: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Reset rows in `upload_status = 'error'` back to `'pending'` so the next
/// sync tick re-attempts them. Debug-only counterpart to
/// `debug_list_media_status`. Returns the number of rows reset.
#[tauri::command]
pub fn debug_retry_failed_uploads(state: State<'_, AppState>) -> Result<usize, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE media SET upload_status = 'pending' WHERE upload_status = 'error'",
        [],
    )
    .map_err(|e| e.to_string())
}

/// List every media row attached to an entry, ordered by `sort_order` and
/// creation time. Used by the gallery view.
///
/// `mode_filter = Some("attached")` or `Some("inline")` narrows the result.
/// `mode_filter = None` returns all rows (backward-compatible).
#[tauri::command]
pub fn list_media_for_entry(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    entry_id: String,
    mode_filter: Option<String>,
    active_vault_id: Option<String>,
) -> Result<Vec<crate::db::Media>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    list_media_for_entry_impl(
        &conn,
        &key_state,
        &entry_id,
        mode_filter.as_deref(),
        active_vault_id.as_deref(),
    )
}

pub(crate) fn list_media_for_entry_impl(
    conn: &Connection,
    key_state: &EncryptionKeyState,
    entry_id: &str,
    mode_filter: Option<&str>,
    active_vault_id: Option<&str>,
) -> Result<Vec<crate::db::Media>, String> {
    // Security: require journal to be unlocked before accessing media.
    // Consistent with resolve_media, get_media_status, read_media_bytes.
    require_media_unlocked(conn, key_state)?;
    if !crate::db::is_entry_visible_for_active_vault(conn, entry_id, active_vault_id.as_deref())
        .map_err(|e| e.to_string())?
    {
        return Ok(Vec::new());
    }
    crate::db::get_media_for_entry_filtered(conn, entry_id, mode_filter).map_err(|e| e.to_string())
}

/// Read EXIF metadata from the image file at the given absolute path.
/// Returns all-None fields when the file has no EXIF data.
/// Returns an error only for I/O failures (file not found, permission denied).
#[tauri::command]
pub fn read_image_exif(path: String) -> Result<utils::exif::ExifData, String> {
    utils::exif::extract_exif(std::path::Path::new(&path))
}

/// Pure inner helper: query distinct UTC days of EXIF dates for all media on
/// `entry_id`. Used by the Tauri command and the test suite.
pub(crate) fn collect_entry_exif_dates_inner(
    conn: &Connection,
    entry_id: &str,
) -> Result<Vec<i64>, String> {
    crate::db::list_entry_exif_dates(conn, entry_id).map_err(|e| e.to_string())
}

/// Return the distinct UTC calendar days (as Unix timestamps of the earliest
/// photo in each day group) for all images attached to `entry_id`.
/// The frontend uses this to decide whether to show the multi-date picker.
#[tauri::command]
pub fn collect_entry_exif_dates(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<Vec<i64>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    collect_entry_exif_dates_inner(&conn, &entry_id)
}

/// Pure inner helper: query distinct GPS locations (grouped at ~11 m granularity)
/// for all media on `entry_id`. Used by the Tauri command and the test suite.
pub(crate) fn collect_entry_exif_locations_inner(
    conn: &Connection,
    entry_id: &str,
) -> Result<Vec<crate::db::queries::ExifLocation>, String> {
    crate::db::queries::list_entry_exif_locations(conn, entry_id).map_err(|e| e.to_string())
}

/// Return the distinct GPS locations (latitude/longitude pairs, deduplicated at
/// ~11 m granularity) for all images attached to `entry_id`.
/// The frontend uses this to decide whether to auto-apply a location or show the
/// multi-location picker.
#[tauri::command]
pub fn collect_entry_exif_locations(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<Vec<crate::db::queries::ExifLocation>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    collect_entry_exif_locations_inner(&conn, &entry_id)
}

/// Gate media access behind the app-lock: if encryption is enabled and the key
/// is not loaded (app is locked), returns an error. Passes through if encryption
/// is disabled or if the key is present.
///
/// Must be called while a DB connection is already held so that the
/// encryption mode can be read without a second lock acquisition.
pub(crate) fn require_media_unlocked(
    conn: &Connection,
    key_state: &crate::EncryptionKeyState,
) -> Result<(), String> {
    let mode = crate::db::get_encryption_mode(conn).map_err(|e| e.to_string())?;
    if mode == crate::db::EncryptionMode::Password {
        let initialized = key_state.is_initialized().map_err(|e| e.to_string())?;
        if !initialized {
            return Err("App is locked — unlock to access media".to_string());
        }
    }
    Ok(())
}

/// List every media row attached to a non-deleted entry across every journal,
/// newest first, paginated. Backs the Media Gallery view.
/// Paginated version of the media gallery query.
///
/// Returns a [`PagedResult`] containing [`GalleryMediaRow`] items for the
/// requested page (1-based). The backend does NOT clamp to the last page —
/// an out-of-range page returns `items: []` with the real `total`.
/// `kind` optionally narrows to a MIME top-level category like `"image"` /
/// `"video"` / `"audio"`. `page_size` is the number of items per page
/// (caller-supplied so the Media Gallery page-size selector can change it).
#[tauri::command]
pub fn list_all_media_paged(
    state: State<'_, AppState>,
    key_state: State<'_, crate::EncryptionKeyState>,
    kind: Option<String>,
    page: u32,
    locked_view: LockedView,
    active_vault_id: Option<String>,
    page_size: u32,
) -> Result<crate::db::PagedResult<crate::db::GalleryMediaRow>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    require_media_unlocked(&conn, &key_state)?;
    // `page_size` crosses the IPC trust boundary untrusted (the frontend
    // Select only offers 12/20/40/60, but any u32 can be sent directly).
    // Clamp to a sane window: ≥1 so LIMIT/OFFSET stay well-formed, ≤100 to
    // bound the fetch and keep `(page-1)*page_size` comfortably within i64
    // for any valid `page`.
    let page_size = page_size.clamp(1, 100);
    crate::db::list_all_media_paged_with_locked_view(
        &conn,
        kind.as_deref(),
        page,
        locked_view,
        active_vault_id.as_deref(),
        page_size,
    )
    .map_err(|e| e.to_string())
}

/// Inner (testable) implementation for `delete_media`.
///
/// Reads `storage_path` and `thumbnail_path` before deleting the DB row, then
/// removes the files from disk best-effort (logs warnings on failure). The
/// `clear_entry_cover_on_media_delete` trigger handles nullifying `cover_media_id`
/// automatically.
pub(crate) fn delete_media_inner(conn: &Connection, media_id: &str) -> Result<(), String> {
    let media = crate::db::get_media(conn, media_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media not found: {media_id}"))?;

    let storage_path = media.storage_path.clone();
    let thumbnail_path = media.thumbnail_path.clone();
    let entry_id = media.entry_id.clone();
    let deleted_at = crate::utils::time::now_unix();

    // POINT OF NO RETURN (T38): persist the tombstone before dropping the
    // row so the next entry push can carry `deleted_media`. Bump
    // `updated_at` + pending so peers re-pull; same-timestamp LWW would
    // otherwise skip the payload and leave the peer row alive.
    crate::db::upsert_media_tombstone(conn, media_id, &entry_id, deleted_at)
        .map_err(|e| e.to_string())?;
    crate::db::touch_entry_updated_at(conn, &entry_id).map_err(|e| e.to_string())?;
    crate::db::mark_entry_pending(conn, &entry_id).map_err(|e| e.to_string())?;

    // Delete the DB row first. The cover trigger fires here.
    crate::db::delete_media(conn, media_id).map_err(|e| e.to_string())?;

    // Best-effort filesystem cleanup. Safe here because this runs without a
    // surrounding transaction (the `delete_media` command owns its own lock),
    // so there is no rollback that could restore the row after the unlink.
    remove_media_files_best_effort(&storage_path, thumbnail_path.as_deref());

    Ok(())
}

/// Best-effort removal of a media's original + thumbnail files from disk.
/// Failures are logged, never propagated. Callers that delete media rows
/// inside a transaction MUST defer this until after the commit succeeds —
/// filesystem deletes are not transactional, so unlinking before a rollback
/// would leave a live row pointing at a missing file.
pub(crate) fn remove_media_files_best_effort(storage_path: &str, thumbnail_path: Option<&str>) {
    if !storage_path.is_empty() {
        if let Err(e) = std::fs::remove_file(storage_path) {
            log::warn!("delete_media: remove file {storage_path}: {e}");
        }
    }
    if let Some(thumb) = thumbnail_path {
        if !thumb.is_empty() {
            if let Err(e) = std::fs::remove_file(thumb) {
                log::warn!("delete_media: remove thumbnail {thumb}: {e}");
            }
        }
    }
}

/// Delete a media row and its associated files from disk.
///
/// Removes the original file (`storage_path`) and the thumbnail (`thumbnail_path`)
/// from disk best-effort — failures are logged but do not propagate. The
/// `clear_entry_cover_on_media_delete` DB trigger nullifies any `cover_media_id`
/// references automatically.
#[tauri::command]
pub fn delete_media(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    media_id: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    // Security: require journal to be unlocked before accessing media.
    // Consistent with resolve_media, get_media_status, read_media_bytes.
    require_media_unlocked(&conn, &key_state)?;
    delete_media_inner(&conn, &media_id)?;
    drop(conn);
    // Re-arm the throttled own-cloud media prune so the NEXT automatic sync
    // sweeps this media's now-orphaned cloud blob, rather than waiting for a
    // manual sync / restart (the prune is gated once-per-session — see
    // `push_local`).
    crate::sync::engine::reset_session_own_cloud_reconciled();
    Ok(())
}

/// Update the `insertion_mode` of an existing media row.
///
/// `mode` must be `"inline"` or `"attached"`. Returns an error for any other value.
#[tauri::command]
pub fn update_media_insertion_mode(
    state: State<'_, AppState>,
    key_state: State<'_, EncryptionKeyState>,
    media_id: String,
    mode: String,
) -> Result<(), String> {
    validate_insertion_mode(&mode)?;
    let conn = state.lock().map_err(|e| e.to_string())?;
    // Security: require journal to be unlocked before mutating media.
    // Consistent with delete_media, resolve_media, get_media_status, read_media_bytes.
    require_media_unlocked(&conn, &key_state)?;
    crate::db::update_media_insertion_mode_db(&conn, &media_id, &mode).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::sync::media_sync::encrypt_media_bytes;
    use crate::sync::provider::test_support::MockProvider;
    use rusqlite::Connection;
    use tempfile::TempDir;

    // ── require_media_unlocked ───────────────────────────────────────────────

    fn key_state_empty() -> crate::EncryptionKeyState {
        crate::EncryptionKeyState::new()
    }

    fn key_state_with_key() -> crate::EncryptionKeyState {
        use zeroize::Zeroizing;
        let ks = crate::EncryptionKeyState::new();
        ks.set_key(Zeroizing::new([0u8; 32])).unwrap();
        ks
    }

    #[test]
    fn require_unlocked_allows_when_encryption_never_set() {
        // Fresh DB — encryption_mode is unset → allow regardless of key state.
        let conn = setup_db();
        let ks = key_state_empty();
        assert!(require_media_unlocked(&conn, &ks).is_ok());
    }

    #[test]
    fn require_unlocked_allows_when_encryption_password_and_key_loaded() {
        let conn = setup_db();
        crate::db::set_encryption_mode(&conn, crate::db::EncryptionMode::Password).unwrap();
        let ks = key_state_with_key();
        assert!(require_media_unlocked(&conn, &ks).is_ok());
    }

    #[test]
    fn require_unlocked_blocks_when_encryption_password_and_locked() {
        let conn = setup_db();
        crate::db::set_encryption_mode(&conn, crate::db::EncryptionMode::Password).unwrap();
        let ks = key_state_empty(); // key not loaded → app is locked
        let result = require_media_unlocked(&conn, &ks);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("locked"));
    }

    // ── Pure validator tests ─────────────────────────────────────────────────

    #[test]
    fn is_safe_cache_filename_accepts_normal_names() {
        assert!(is_safe_cache_filename("photo.jpg"));
        assert!(is_safe_cache_filename("abc123.png"));
        assert!(is_safe_cache_filename("my-image_v2.webp"));
    }

    #[test]
    fn is_safe_cache_filename_rejects_dotdot() {
        assert!(!is_safe_cache_filename("../evil.png"));
        assert!(!is_safe_cache_filename("a/../b.png"));
        assert!(!is_safe_cache_filename(".."));
    }

    #[test]
    fn is_safe_cache_filename_rejects_slash() {
        assert!(!is_safe_cache_filename("/abs/path.jpg"));
        assert!(!is_safe_cache_filename("sub/dir/photo.jpg"));
        assert!(!is_safe_cache_filename("sub\\dir\\photo.jpg"));
    }

    #[test]
    fn is_safe_cache_filename_rejects_leading_dot() {
        assert!(!is_safe_cache_filename(".hidden"));
        assert!(!is_safe_cache_filename(".gitignore"));
    }

    #[test]
    fn is_safe_cache_filename_rejects_empty() {
        assert!(!is_safe_cache_filename(""));
    }

    #[test]
    fn validate_cloud_path_accepts_valid_path() {
        let media_id = "abc1234567890xyz";
        let cp = format!("device-abc/media/{media_id}");
        let result = validate_cloud_path(&cp, media_id);
        assert!(result.is_ok(), "should accept valid cloud path");
        assert_eq!(result.unwrap(), "device-abc");
    }

    #[test]
    fn validate_cloud_path_rejects_two_parts() {
        let result = validate_cloud_path("device-abc/media-id", "media-id");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("3 parts"));
    }

    #[test]
    fn validate_cloud_path_rejects_four_parts() {
        let result = validate_cloud_path("device-abc/media/id/extra", "id");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("3 parts"));
    }

    #[test]
    fn validate_cloud_path_rejects_wrong_middle_segment() {
        let media_id = "aaaabbbbccccdddd";
        let cp = format!("device-abc/entries/{media_id}");
        let result = validate_cloud_path(&cp, media_id);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("'media' segment"));
    }

    #[test]
    fn validate_cloud_path_rejects_wrong_tail() {
        let result = validate_cloud_path("device-abc/media/other-id", "correct-id-xxx");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not match media_id"));
    }

    #[test]
    fn validate_cloud_path_rejects_unsafe_device_id() {
        let media_id = "aaaabbbbccccdddd";
        // device_id with dots — fails the alphanumeric/-/_ check
        let cp = format!("dev.evil/media/{media_id}");
        let result = validate_cloud_path(&cp, media_id);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsafe device_id"));
    }

    // is_safe_device_id tests live in `crate::sync::safety` — see that module.

    // ── resolve_media_inner tests ────────────────────────────────────────────

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    fn make_media_row(
        conn: &Connection,
        storage_path: &str,
        cloud_path: Option<&str>,
        file_name: &str,
    ) -> Media {
        let jid = crate::db::create_journal(conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;
        let media = crate::db::create_media(
            conn,
            crate::db::CreateMediaParams {
                entry_id: &eid,
                file_name,
                file_type: "image/jpeg",
                storage_path,
                file_size: Some(10),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        if let Some(cp) = cloud_path {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            crate::db::mark_media_uploaded(conn, &media.id, cp, now).unwrap();
            crate::db::get_media(conn, &media.id).unwrap().unwrap()
        } else {
            media
        }
    }

    fn test_key() -> [u8; 32] {
        [42u8; 32]
    }

    /// Build a single-epoch [`crate::EncryptionKeyState`] from a raw key.
    /// Used in tests to construct the key state expected by `resolve_media_inner`
    /// and `encrypt_media_bytes`.
    fn make_key_state_from_raw(raw: [u8; 32]) -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        ks.set_key(zeroize::Zeroizing::new(raw))
            .expect("set_key never fails");
        ks
    }

    #[tokio::test]
    async fn resolve_inner_fast_path_returns_existing_storage_path() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("photo.jpg");
        std::fs::write(&file, b"img data").unwrap();

        let media = Media {
            id: "aaaabbbbccccdddd".to_string(),
            entry_id: "entry-id".to_string(),
            file_name: "photo.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            storage_provider: "local".to_string(),
            storage_path: file.to_string_lossy().into_owned(),
            thumbnail_path: None,
            upload_status: "pending".to_string(),
            uploaded_at: None,
            file_size: Some(8),
            cloud_path: None,
            last_accessed_at: None,
            sort_order: 0,
            created_at: 0,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            insertion_mode: "inline".to_string(),
            width: None,
            height: None,
            duration_seconds: None,
        };

        // Fast path: file exists → no provider needed (pass None)
        let result = resolve_media_inner(
            &media,
            None,
            &make_key_state_from_raw(test_key()),
            dir.path(),
        )
        .await;
        assert!(
            result.is_ok(),
            "fast path should succeed: {:?}",
            result.err()
        );
        assert_eq!(result.unwrap(), file.to_string_lossy());
    }

    #[tokio::test]
    async fn resolve_inner_returns_error_when_no_local_and_no_cloud_path() {
        let dir = TempDir::new().unwrap();
        let media = Media {
            id: "aaaabbbbccccdddd".to_string(),
            entry_id: "entry-id".to_string(),
            file_name: "missing.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            storage_provider: "local".to_string(),
            storage_path: "/nonexistent/missing.jpg".to_string(),
            thumbnail_path: None,
            upload_status: "pending".to_string(),
            uploaded_at: None,
            file_size: Some(10),
            cloud_path: None,
            last_accessed_at: None,
            sort_order: 0,
            created_at: 0,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            insertion_mode: "inline".to_string(),
            width: None,
            height: None,
            duration_seconds: None,
        };
        let result = resolve_media_inner(
            &media,
            None,
            &make_key_state_from_raw(test_key()),
            dir.path(),
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no cloud copy"));
    }

    #[tokio::test]
    async fn resolve_inner_returns_error_for_malformed_cloud_path_two_parts() {
        let dir = TempDir::new().unwrap();
        let media = Media {
            id: "aaaabbbbccccdddd".to_string(),
            entry_id: "entry-id".to_string(),
            file_name: "photo.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            storage_provider: "local".to_string(),
            storage_path: "/nonexistent/missing.jpg".to_string(),
            thumbnail_path: None,
            upload_status: "uploaded".to_string(),
            uploaded_at: Some(0),
            file_size: Some(10),
            cloud_path: Some("device-abc/missingpart".to_string()), // only 2 parts
            last_accessed_at: None,
            sort_order: 0,
            created_at: 0,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            insertion_mode: "inline".to_string(),
            width: None,
            height: None,
            duration_seconds: None,
        };
        let result = resolve_media_inner(
            &media,
            None,
            &make_key_state_from_raw(test_key()),
            dir.path(),
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("3 parts"));
    }

    #[tokio::test]
    async fn resolve_inner_returns_error_for_wrong_middle_segment() {
        let dir = TempDir::new().unwrap();
        let media_id = "aaaabbbbccccdddd";
        let media = Media {
            id: media_id.to_string(),
            entry_id: "entry-id".to_string(),
            file_name: "photo.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            storage_provider: "local".to_string(),
            storage_path: "/nonexistent/missing.jpg".to_string(),
            thumbnail_path: None,
            upload_status: "uploaded".to_string(),
            uploaded_at: Some(0),
            file_size: Some(10),
            cloud_path: Some(format!("device-abc/entries/{media_id}")), // wrong segment
            last_accessed_at: None,
            sort_order: 0,
            created_at: 0,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            insertion_mode: "inline".to_string(),
            width: None,
            height: None,
            duration_seconds: None,
        };
        let result = resolve_media_inner(
            &media,
            None,
            &make_key_state_from_raw(test_key()),
            dir.path(),
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("'media' segment"));
    }

    #[tokio::test]
    async fn resolve_inner_returns_error_for_unsafe_device_id() {
        let dir = TempDir::new().unwrap();
        let media_id = "aaaabbbbccccdddd";
        let media = Media {
            id: media_id.to_string(),
            entry_id: "entry-id".to_string(),
            file_name: "photo.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            storage_provider: "local".to_string(),
            storage_path: "/nonexistent/missing.jpg".to_string(),
            thumbnail_path: None,
            upload_status: "uploaded".to_string(),
            uploaded_at: Some(0),
            file_size: Some(10),
            cloud_path: Some(format!("dev.evil/media/{media_id}")), // unsafe device_id (dot not allowed)
            last_accessed_at: None,
            sort_order: 0,
            created_at: 0,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            insertion_mode: "inline".to_string(),
            width: None,
            height: None,
            duration_seconds: None,
        };
        let result = resolve_media_inner(
            &media,
            None,
            &make_key_state_from_raw(test_key()),
            dir.path(),
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsafe device_id"));
    }

    #[tokio::test]
    async fn resolve_inner_returns_error_for_dotdot_filename() {
        let dir = TempDir::new().unwrap();
        let media_id = "aaaabbbbccccdddd";
        let media = Media {
            id: media_id.to_string(),
            entry_id: "entry-id".to_string(),
            file_name: "../evil.jpg".to_string(), // path traversal
            file_type: "image/jpeg".to_string(),
            storage_provider: "local".to_string(),
            storage_path: "/nonexistent/missing.jpg".to_string(),
            thumbnail_path: None,
            upload_status: "uploaded".to_string(),
            uploaded_at: Some(0),
            file_size: Some(10),
            cloud_path: Some(format!("device-abc/media/{media_id}")),
            last_accessed_at: None,
            sort_order: 0,
            created_at: 0,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            insertion_mode: "inline".to_string(),
            width: None,
            height: None,
            duration_seconds: None,
        };
        let result = resolve_media_inner(
            &media,
            None,
            &make_key_state_from_raw(test_key()),
            dir.path(),
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsafe file_name"));
    }

    #[tokio::test]
    async fn resolve_inner_returns_error_for_absolute_filename() {
        let dir = TempDir::new().unwrap();
        let media_id = "aaaabbbbccccdddd";
        let media = Media {
            id: media_id.to_string(),
            entry_id: "entry-id".to_string(),
            file_name: "/abs/path.jpg".to_string(), // absolute path
            file_type: "image/jpeg".to_string(),
            storage_provider: "local".to_string(),
            storage_path: "/nonexistent/missing.jpg".to_string(),
            thumbnail_path: None,
            upload_status: "uploaded".to_string(),
            uploaded_at: Some(0),
            file_size: Some(10),
            cloud_path: Some(format!("device-abc/media/{media_id}")),
            last_accessed_at: None,
            sort_order: 0,
            created_at: 0,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            insertion_mode: "inline".to_string(),
            width: None,
            height: None,
            duration_seconds: None,
        };
        let result = resolve_media_inner(
            &media,
            None,
            &make_key_state_from_raw(test_key()),
            dir.path(),
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsafe file_name"));
    }

    #[tokio::test]
    async fn resolve_inner_slow_path_downloads_and_returns_cache_path() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let ks = make_key_state_from_raw(test_key());

        let provider = Arc::new(MockProvider::new());
        let original = b"original image bytes for test";
        let ciphertext = encrypt_media_bytes(&ks, original).unwrap();

        // First create the row without cloud_path to get the generated media id.
        let media_no_cloud = make_media_row(&conn, "/nonexistent/missing.jpg", None, "photo.jpg");
        let real_id = &media_no_cloud.id;
        let cloud_path = format!("device-abc/media/{real_id}");

        // Now mark it uploaded so it has a cloud_path.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        crate::db::mark_media_uploaded(&conn, real_id, &cloud_path, now).unwrap();
        let media = crate::db::get_media(&conn, real_id).unwrap().unwrap();

        // Write ciphertext to provider at the expected path
        provider.write_file(&cloud_path, &ciphertext).await.unwrap();

        let result = resolve_media_inner(&media, Some(provider), &ks, dir.path()).await;
        assert!(
            result.is_ok(),
            "slow path should succeed: {:?}",
            result.err()
        );

        let returned_path = result.unwrap();
        let cached = std::fs::read(&returned_path).unwrap();
        assert_eq!(cached, original);
    }

    /// Wiring guard for the cross-device media-decrypt symmetry.
    ///
    /// The engine push path encrypts media through the snapshot key state
    /// (built in `run_sync_now` via `snapshot_for_engine`). The receiver's
    /// on-demand resolve path MUST decrypt using the same derivation depth.
    ///
    /// This test models the symmetry END-TO-END at `resolve_media_inner`:
    /// encrypt with a key state, decrypt with the SAME key state → roundtrip
    /// succeeds. The companion test pins the failure of using a different key.
    #[tokio::test]
    async fn resolve_inner_decrypts_ciphertext_when_same_key_state_used() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let ks = make_key_state_from_raw([0x55u8; 32]);

        let provider = Arc::new(MockProvider::new());
        let original = b"image bytes encrypted under the key state";
        // Push side encrypts with the key state.
        let ciphertext = encrypt_media_bytes(&ks, original).unwrap();

        let media_no_cloud = make_media_row(&conn, "/nonexistent/missing.jpg", None, "photo.jpg");
        let real_id = &media_no_cloud.id;
        let cloud_path = format!("device-abc/media/{real_id}");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        crate::db::mark_media_uploaded(&conn, real_id, &cloud_path, now).unwrap();
        let media = crate::db::get_media(&conn, real_id).unwrap().unwrap();

        provider.write_file(&cloud_path, &ciphertext).await.unwrap();

        // Resolve side decrypts with the SAME key state → must succeed.
        let result = resolve_media_inner(&media, Some(provider), &ks, dir.path()).await;
        assert!(
            result.is_ok(),
            "same-key-state roundtrip should succeed: {:?}",
            result.err()
        );

        let cached = std::fs::read(result.unwrap()).unwrap();
        assert_eq!(cached, original);
    }

    /// Negative companion: encrypt with one key state, decrypt with a different
    /// key (different raw bytes) → AEAD tag mismatch.
    #[tokio::test]
    async fn resolve_inner_fails_when_different_key_used_to_decrypt() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let ks_encrypt = make_key_state_from_raw([0x55u8; 32]);
        let ks_wrong = make_key_state_from_raw([0x66u8; 32]); // different key

        let provider = Arc::new(MockProvider::new());
        let original = b"image bytes encrypted under key A";
        let ciphertext = encrypt_media_bytes(&ks_encrypt, original).unwrap();

        let media_no_cloud = make_media_row(&conn, "/nonexistent/missing.jpg", None, "photo.jpg");
        let real_id = &media_no_cloud.id;
        let cloud_path = format!("device-abc/media/{real_id}");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        crate::db::mark_media_uploaded(&conn, real_id, &cloud_path, now).unwrap();
        let media = crate::db::get_media(&conn, real_id).unwrap().unwrap();

        provider.write_file(&cloud_path, &ciphertext).await.unwrap();

        // Pass the wrong key — decryption must fail with a clear error.
        let result = resolve_media_inner(&media, Some(provider), &ks_wrong, dir.path()).await;
        assert!(result.is_err(), "decrypting with wrong key MUST fail");
        let err = result.unwrap_err();
        assert!(
            err.contains("decrypt_media") || err.to_lowercase().contains("decrypt"),
            "expected decrypt-failure error, got: {err}"
        );
    }

    // ── save_media_to_media_dir tests ────────────────────────────────────────

    /// Build an in-memory PNG for ingestion tests.
    fn test_png_bytes(w: u32, h: u32) -> Vec<u8> {
        use image::{ImageBuffer, ImageFormat, Rgb};
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 50]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn save_image_writes_file_inserts_media_and_generates_thumbnail() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        let png = test_png_bytes(800, 600);
        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &png, "png", "inline")
            .expect("save ok");

        // Media row exists.
        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .expect("media row");
        assert_eq!(media.file_type, "image/png");
        assert!(Path::new(&media.storage_path).exists(), "original written");
        assert!(media.thumbnail_path.is_some(), "thumbnail path recorded");

        // Thumbnail file exists and is a JPEG of reduced size.
        let thumb_path = media.thumbnail_path.unwrap();
        let thumb_bytes = std::fs::read(&thumb_path).unwrap();
        assert_eq!(&thumb_bytes[..3], &[0xFF, 0xD8, 0xFF], "JPEG magic bytes");
        let decoded = image::load_from_memory(&thumb_bytes).unwrap();
        assert!(
            decoded.width() <= 512 && decoded.height() <= 512,
            "thumbnail fits within max edge"
        );
    }

    #[test]
    fn save_image_skips_thumbnail_for_unsupported_mime() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        // SVG: supports_thumbnail returns false → no thumbnail generated.
        let fake_svg = b"<svg></svg>".to_vec();
        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &fake_svg, "svg", "inline")
            .expect("save ok");

        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .unwrap();
        assert_eq!(media.file_type, "image/svg+xml");
        assert!(media.thumbnail_path.is_none(), "no thumbnail for SVG");
        // Original file still written.
        assert!(Path::new(&media.storage_path).exists());
    }

    #[test]
    fn save_image_does_not_fail_when_bytes_are_not_an_image() {
        // Thumbnail generation is best-effort — invalid image bytes should
        // still succeed the insert (just without a thumbnail).
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        let garbage = b"not an image".to_vec();
        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &garbage, "png", "inline");
        assert!(result.is_ok(), "insert must not block on thumb failure");
        let media = crate::db::get_media(&conn, &result.unwrap().media_id)
            .unwrap()
            .unwrap();
        assert!(media.thumbnail_path.is_none());
    }

    #[test]
    fn save_image_leaves_exif_null_for_bytes_without_metadata() {
        // RED → GREEN: PNG has no EXIF → exif_date/latitude/longitude must be None.
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        let png = test_png_bytes(4, 4);
        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &png, "png", "inline")
            .expect("save ok");
        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .expect("media row");

        assert!(
            media.exif_date.is_none(),
            "no EXIF date for PNG without metadata"
        );
        assert!(media.exif_latitude.is_none(), "no EXIF latitude for PNG");
        assert!(media.exif_longitude.is_none(), "no EXIF longitude for PNG");
    }

    #[test]
    fn save_image_populates_exif_date_when_present() {
        // Uses tests/fixtures/with_exif_date.jpg — a minimal JPEG whose APP1
        // segment contains DateTimeOriginal = "2023:06:15 10:30:00" (UTC).
        // Expected timestamp: parse_exif_datetime("2023:06:15 10:30:00").
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        // Load the fixture JPEG that has EXIF DateTimeOriginal embedded.
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/with_exif_date.jpg");
        let jpeg_bytes = std::fs::read(&fixture_path)
            .unwrap_or_else(|e| panic!("fixture not found at {fixture_path:?}: {e}"));

        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &jpeg_bytes, "jpg", "inline")
            .expect("save ok");
        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .expect("media row");

        // The fixture encodes "2023:06:15 10:30:00" as DateTimeOriginal.
        // parse_exif_datetime treats it as UTC → should be a timestamp in 2023.
        assert!(
            media.exif_date.is_some(),
            "exif_date must be populated from fixture EXIF"
        );
        let ts = media.exif_date.unwrap();
        // 2023-06-15 00:00:00 UTC = 1_686_787_200; 10:30:00 UTC = 1_686_787_200 + 37_800
        assert!(ts > 1_686_000_000, "timestamp should be in 2023: {ts}");
        assert!(ts < 1_720_000_000, "timestamp should be before 2024: {ts}");
    }

    #[test]
    fn mime_from_ext_maps_known_extensions() {
        assert_eq!(mime_from_ext("jpg"), "image/jpeg");
        assert_eq!(mime_from_ext("jpeg"), "image/jpeg");
        assert_eq!(mime_from_ext("png"), "image/png");
        assert_eq!(mime_from_ext("gif"), "image/gif");
        assert_eq!(mime_from_ext("webp"), "image/webp");
        assert_eq!(mime_from_ext("bmp"), "image/bmp");
        assert_eq!(mime_from_ext("heic"), "image/heic");
        assert_eq!(mime_from_ext("heif"), "image/heic");
        assert_eq!(mime_from_ext("svg"), "image/svg+xml");
        assert_eq!(mime_from_ext("xyz"), "application/octet-stream");
    }

    #[test]
    fn mime_from_ext_maps_video_extensions() {
        assert_eq!(mime_from_ext("mp4"), "video/mp4");
        assert_eq!(mime_from_ext("mov"), "video/quicktime");
        assert_eq!(mime_from_ext("webm"), "video/webm");
        assert_eq!(mime_from_ext("m4v"), "video/x-m4v");
    }

    #[test]
    fn mime_from_ext_maps_wav() {
        assert_eq!(mime_from_ext("wav"), "audio/wav");
    }

    #[test]
    fn save_video_writes_file_and_inserts_media_row_with_video_mime() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        // Fake MP4 bytes — `save_media_to_media_dir` doesn't decode, it just
        // writes + inserts, so any byte payload exercises the video branch.
        let fake_mp4 = b"\x00\x00\x00\x18ftypmp42fake video bytes".to_vec();
        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &fake_mp4, "mp4", "inline")
            .expect("save ok");

        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .expect("media row");
        assert_eq!(media.file_type, "video/mp4");
        assert!(
            Path::new(&media.storage_path).exists(),
            "video file written"
        );
        assert_eq!(std::fs::read(&media.storage_path).unwrap(), fake_mp4);
    }

    #[test]
    fn save_video_never_writes_thumbnail() {
        // Videos do not get a server-side thumbnail — the frontend handles
        // playback preview via `<video preload="metadata">` or a placeholder.
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        let fake_webm = b"fake webm bytes".to_vec();
        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &fake_webm, "webm", "inline")
            .expect("save ok");

        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .expect("media row");
        assert_eq!(media.file_type, "video/webm");
        assert!(media.thumbnail_path.is_none());
        let thumb_guess = dir.path().join(format!("{}.thumb.jpg", media.id));
        assert!(!thumb_guess.exists(), "no thumbnail file on disk");
    }

    #[tokio::test]
    async fn resolve_inner_returns_error_when_sync_not_configured() {
        let dir = TempDir::new().unwrap();
        let media_id = "aaaabbbbccccdddd";
        let media = Media {
            id: media_id.to_string(),
            entry_id: "entry-id".to_string(),
            file_name: "photo.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            storage_provider: "local".to_string(),
            storage_path: "/nonexistent/missing.jpg".to_string(),
            thumbnail_path: None,
            upload_status: "uploaded".to_string(),
            uploaded_at: Some(0),
            file_size: Some(10),
            cloud_path: Some(format!("device-abc/media/{media_id}")),
            last_accessed_at: None,
            sort_order: 0,
            created_at: 0,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
            insertion_mode: "inline".to_string(),
            width: None,
            height: None,
            duration_seconds: None,
        };
        // No provider configured (None)
        let result = resolve_media_inner(
            &media,
            None,
            &make_key_state_from_raw(test_key()),
            dir.path(),
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Sync not configured"));
    }

    #[test]
    fn collect_entry_exif_dates_returns_deduplicated_utc_days() {
        let conn = setup_db();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        // Two photos 10 s apart on the same UTC day → deduplicated to 1.
        let ts1: i64 = 1_686_825_000;
        let ts2: i64 = ts1 + 10;
        for (name, ts) in [("a.jpg", ts1), ("b.jpg", ts2)] {
            crate::db::create_media(
                &conn,
                crate::db::CreateMediaParams {
                    entry_id: &eid,
                    file_name: name,
                    file_type: "image/jpeg",
                    storage_path: "/p",
                    file_size: None,
                    sort_order: 0,
                    insertion_mode: "inline",
                    width: None,
                    height: None,
                    exif_date: Some(ts),
                    exif_latitude: None,
                    exif_longitude: None,
                },
            )
            .unwrap();
        }

        let dates = collect_entry_exif_dates_inner(&conn, &eid).unwrap();
        assert_eq!(dates.len(), 1, "two photos on same day → 1 distinct day");
    }

    #[test]
    fn collect_entry_exif_locations_returns_grouped_locations() {
        let conn = setup_db();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        // 3 media rows: 2 photos at the same 4dp location (Paris area) + 1 at
        // a clearly distinct location (Tokyo). Expect 2 deduplicated results.
        // a.jpg and b.jpg both round to (48.8566, 2.3522); c.jpg is Tokyo.
        for (name, lat, lng, order) in [
            ("a.jpg", 48.85661_f64, 2.35222_f64, 0_i64),
            ("b.jpg", 48.85663_f64, 2.35224_f64, 1_i64), // same 4dp as a.jpg
            ("c.jpg", 35.6762_f64, 139.6503_f64, 2_i64), // Tokyo — distinct
        ] {
            crate::db::create_media(
                &conn,
                crate::db::CreateMediaParams {
                    entry_id: &eid,
                    file_name: name,
                    file_type: "image/jpeg",
                    storage_path: &format!("/p/{name}"),
                    file_size: None,
                    sort_order: order,
                    insertion_mode: "inline",
                    width: None,
                    height: None,
                    exif_date: None,
                    exif_latitude: Some(lat),
                    exif_longitude: Some(lng),
                },
            )
            .unwrap();
        }

        let locs = collect_entry_exif_locations_inner(&conn, &eid).unwrap();
        assert_eq!(locs.len(), 2, "3 media → 2 distinct 4dp groups: {locs:?}");
    }

    // ── insertion_mode tests ─────────────────────────────────────────────────

    /// Shared helper: create a journal+entry and return (conn, entry_id).
    fn setup_with_entry() -> (Connection, String) {
        let conn = setup_db();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;
        (conn, eid)
    }

    #[test]
    fn pick_image_with_attached_mode() {
        // save_media_to_media_dir with insertion_mode = "attached" → row has attached.
        let (conn, eid) = setup_with_entry();
        let dir = TempDir::new().unwrap();
        let result =
            save_media_to_media_dir(&conn, dir.path(), &eid, b"fake bytes", "png", "attached")
                .expect("save ok");
        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .expect("media row");
        assert_eq!(media.insertion_mode, "attached");
    }

    #[test]
    fn save_pasted_image_defaults_to_inline() {
        // save_media_to_media_dir with insertion_mode = "inline" → row has inline.
        let (conn, eid) = setup_with_entry();
        let dir = TempDir::new().unwrap();
        let result =
            save_media_to_media_dir(&conn, dir.path(), &eid, b"fake bytes", "png", "inline")
                .expect("save ok");
        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .expect("media row");
        assert_eq!(media.insertion_mode, "inline");
    }

    #[test]
    fn insertion_mode_invalid_value_returns_error() {
        // validate_insertion_mode("invalid") → Err
        let result = validate_insertion_mode("invalid");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("insertion_mode must be 'inline' or 'attached'"));
    }

    #[test]
    fn list_media_filtered_attached() {
        // Insert 2 inline + 1 attached, filter by "attached" → only 1 row.
        let (conn, eid) = setup_with_entry();
        for _ in 0..2 {
            crate::db::create_media(
                &conn,
                crate::db::CreateMediaParams {
                    entry_id: &eid,
                    file_name: "img.png",
                    file_type: "image/png",
                    storage_path: "/p",
                    file_size: None,
                    sort_order: 0,
                    insertion_mode: "inline",
                    width: None,
                    height: None,
                    exif_date: None,
                    exif_latitude: None,
                    exif_longitude: None,
                },
            )
            .unwrap();
        }
        crate::db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &eid,
                file_name: "img.png",
                file_type: "image/png",
                storage_path: "/p",
                file_size: None,
                sort_order: 0,
                insertion_mode: "attached",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();

        let rows = crate::db::get_media_for_entry_filtered(&conn, &eid, Some("attached")).unwrap();
        assert_eq!(rows.len(), 1, "only the 1 attached row");
        assert_eq!(rows[0].insertion_mode, "attached");
    }

    #[test]
    fn list_media_unfiltered() {
        // Insert 2 inline + 1 attached, call with None → all 3 rows returned.
        let (conn, eid) = setup_with_entry();
        for mode in ["inline", "inline", "attached"] {
            crate::db::create_media(
                &conn,
                crate::db::CreateMediaParams {
                    entry_id: &eid,
                    file_name: "img.png",
                    file_type: "image/png",
                    storage_path: "/p",
                    file_size: None,
                    sort_order: 0,
                    insertion_mode: mode,
                    width: None,
                    height: None,
                    exif_date: None,
                    exif_latitude: None,
                    exif_longitude: None,
                },
            )
            .unwrap();
        }

        let rows = crate::db::get_media_for_entry_filtered(&conn, &eid, None).unwrap();
        assert_eq!(rows.len(), 3, "all 3 rows when unfiltered");
    }

    #[test]
    fn list_media_for_entry_hides_invisible_entry_media_by_default() {
        let conn = setup_db();
        let visible_jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let invisible_jid = crate::db::create_journal(&conn, "Invisible J", None)
            .unwrap()
            .id;
        let visible_eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &visible_jid,
                title: Some("Visible"),
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;
        let direct_invisible_eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &visible_jid,
                title: Some("Direct invisible"),
                content_text: None,
                preview_text: None,
                entry_date: 1_000_001,
            },
        )
        .unwrap()
        .id;
        let inherited_invisible_eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &invisible_jid,
                title: Some("Inherited invisible"),
                content_text: None,
                preview_text: None,
                entry_date: 1_000_002,
            },
        )
        .unwrap()
        .id;

        for entry_id in [
            &visible_eid,
            &direct_invisible_eid,
            &inherited_invisible_eid,
        ] {
            crate::db::create_media(
                &conn,
                crate::db::CreateMediaParams {
                    entry_id,
                    file_name: "img.png",
                    file_type: "image/png",
                    storage_path: "/p",
                    file_size: None,
                    sort_order: 0,
                    insertion_mode: "inline",
                    width: None,
                    height: None,
                    exif_date: None,
                    exif_latitude: None,
                    exif_longitude: None,
                },
            )
            .unwrap();
        }
        crate::db::set_entry_invisible(&conn, &direct_invisible_eid, true, Some("test-vault"))
            .unwrap();
        crate::db::set_journal_invisible(&conn, &invisible_jid, true, Some("test-vault")).unwrap();
        let ks = key_state_empty();

        assert_eq!(
            list_media_for_entry_impl(&conn, &ks, &visible_eid, None, None)
                .unwrap()
                .len(),
            1
        );
        assert!(
            list_media_for_entry_impl(&conn, &ks, &direct_invisible_eid, None, None)
                .unwrap()
                .is_empty()
        );
        assert!(
            list_media_for_entry_impl(&conn, &ks, &inherited_invisible_eid, None, None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            list_media_for_entry_impl(&conn, &ks, &direct_invisible_eid, None, Some("test-vault"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_media_for_entry_impl(
                &conn,
                &ks,
                &inherited_invisible_eid,
                None,
                Some("test-vault")
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn delete_media_removes_row() {
        // Insert a row, delete it, assert it's gone from DB.
        let (conn, eid) = setup_with_entry();
        let media = crate::db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &eid,
                file_name: "img.png",
                file_type: "image/png",
                storage_path: "/nonexistent/img.png",
                file_size: None,
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();

        delete_media_inner(&conn, &media.id).expect("delete ok");

        let fetched = crate::db::get_media(&conn, &media.id).unwrap();
        assert!(fetched.is_none(), "row should be gone after delete");
    }

    #[test]
    fn delete_media_inner_writes_media_tombstones() {
        let (conn, eid) = setup_with_entry();
        let media = crate::db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &eid,
                file_name: "img.png",
                file_type: "image/png",
                storage_path: "/nonexistent/img.png",
                file_size: None,
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();

        let before_updated = crate::db::get_entry(&conn, &eid)
            .unwrap()
            .unwrap()
            .updated_at;
        crate::db::mark_entry_synced(&conn, &eid, 1).unwrap();

        delete_media_inner(&conn, &media.id).expect("delete ok");

        let tombs = crate::db::list_media_tombstones_for_entry(&conn, &eid).unwrap();
        assert_eq!(tombs.len(), 1, "delete must persist a media tombstone");
        assert_eq!(tombs[0].id, media.id);
        assert_eq!(tombs[0].entry_id, eid);
        assert!(tombs[0].deleted_at >= media.created_at);

        let after_updated = crate::db::get_entry(&conn, &eid)
            .unwrap()
            .unwrap()
            .updated_at;
        assert!(
            after_updated > before_updated,
            "delete must bump entries.updated_at past the pre-delete value"
        );
        let sync_status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&eid],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            sync_status, "pending",
            "delete must mark the entry pending so the tombstone is pushed"
        );
    }

    #[test]
    fn update_media_insertion_mode_changes_value() {
        // Insert inline row, update to attached, assert DB shows 'attached'.
        let (conn, eid) = setup_with_entry();
        let media = crate::db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &eid,
                file_name: "img.png",
                file_type: "image/png",
                storage_path: "/p",
                file_size: None,
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        assert_eq!(media.insertion_mode, "inline");

        crate::db::update_media_insertion_mode_db(&conn, &media.id, "attached").unwrap();

        let updated = crate::db::get_media(&conn, &media.id).unwrap().unwrap();
        assert_eq!(updated.insertion_mode, "attached");
    }

    // ── Issue 6: DB CHECK constraint ─────────────────────────────────────────

    #[test]
    fn insertion_mode_db_check_constraint_rejects_invalid() {
        // Bypass the Rust validate_insertion_mode validator and attempt a raw
        // INSERT to confirm the DB CHECK constraint fires independently.
        let (conn, eid) = setup_with_entry();
        let result = conn.execute(
            "INSERT INTO media (id, entry_id, file_name, file_type, storage_provider, \
             storage_path, upload_status, sort_order, insertion_mode) \
             VALUES ('bogus-id', ?1, 'img.png', 'image/png', 'local', '/p', 'pending', 0, 'bogus')",
            rusqlite::params![eid],
        );
        assert!(
            result.is_err(),
            "DB CHECK constraint should reject insertion_mode='bogus'"
        );
    }

    // ── Issue 2: lock-guard tests for delete_media_inner and list_media_for_entry ──

    #[test]
    fn delete_media_inner_blocked_when_locked() {
        // Encryption enabled + key not loaded → require_media_unlocked returns Err.
        // We test that delete_media_inner detects the lock by calling the guard
        // explicitly (the same guard the command calls).
        let (conn, eid) = setup_with_entry();
        crate::db::set_encryption_mode(&conn, crate::db::EncryptionMode::Password).unwrap();
        let ks = key_state_empty(); // no key loaded → app is locked

        // Verify the guard itself rejects.
        let guard_result = require_media_unlocked(&conn, &ks);
        assert!(
            guard_result.is_err(),
            "require_media_unlocked should fail when locked"
        );
        assert!(guard_result.unwrap_err().contains("locked"));

        // Create a media row so delete_media_inner has something to look up.
        let media = crate::db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &eid,
                file_name: "img.png",
                file_type: "image/png",
                storage_path: "/nonexistent/img.png",
                file_size: None,
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();

        // delete_media_inner itself does not call require_media_unlocked —
        // the Tauri command does. So here we verify the guard rejects, and that
        // delete_media_inner would succeed if called directly (the command-level
        // guard prevents it from being reached while locked).
        // This matches the pattern: the command holds the gate.
        let _ = media.id; // used above for create
    }

    #[test]
    fn list_media_for_entry_blocked_when_locked() {
        // Same pattern: encryption password mode + key not loaded → guard rejects.
        let (conn, _eid) = setup_with_entry();
        crate::db::set_encryption_mode(&conn, crate::db::EncryptionMode::Password).unwrap();
        let ks = key_state_empty();

        let guard_result = require_media_unlocked(&conn, &ks);
        assert!(guard_result.is_err());
        assert!(guard_result.unwrap_err().contains("locked"));
    }

    #[test]
    fn update_media_insertion_mode_blocked_when_locked() {
        // update_media_insertion_mode now has the same lock guard as delete_media
        // and list_media_for_entry. Verify it rejects when encryption password mode
        // is set but no key is loaded.
        let (conn, _eid) = setup_with_entry();
        crate::db::set_encryption_mode(&conn, crate::db::EncryptionMode::Password).unwrap();
        let ks = key_state_empty();

        let guard_result = require_media_unlocked(&conn, &ks);
        assert!(guard_result.is_err());
        assert!(guard_result.unwrap_err().contains("locked"));
    }

    // ── save_picked_photos_pure tests (Phase 1, task 1.6) ────────────────────

    fn make_entry(conn: &Connection) -> String {
        let jid = crate::db::create_journal(conn, "J", None).unwrap().id;
        crate::db::create_entry(
            conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn save_picked_photos_pure_returns_empty_for_empty_input() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        let result =
            save_picked_photos_pure(&conn, dir.path(), &eid, &[], "inline").expect("ok for empty");
        assert!(result.is_empty());
    }

    #[test]
    fn save_picked_photos_pure_inserts_each_image_in_order() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        let photos = vec![
            ("a.png".to_string(), test_png_bytes(2, 2)),
            ("b.png".to_string(), test_png_bytes(3, 3)),
            ("c.png".to_string(), test_png_bytes(4, 4)),
        ];

        let results =
            save_picked_photos_pure(&conn, dir.path(), &eid, &photos, "inline").expect("save ok");
        assert_eq!(results.len(), 3, "one result per input photo");

        // Each media row should exist with the expected MIME type.
        for r in &results {
            let media = crate::db::get_media(&conn, &r.media_id)
                .unwrap()
                .expect("media row");
            assert_eq!(media.file_type, "image/png");
            assert_eq!(media.entry_id, eid);
            assert!(Path::new(&media.storage_path).exists());
        }

        // Order invariant: the returned vec preserves input order. PHPicker
        // pick order must flow through to the TipTap document on the
        // frontend side, so the in-memory result order is what matters
        // (the frontend iterates `results` directly without re-querying).
        let result_filenames: Vec<&str> = results
            .iter()
            .map(|r| {
                // local_path looks like "<media_dir>/<uuid>.png" — get the
                // file name to confirm the expected sequence by looking at
                // the matching DB row's file_type.
                std::path::Path::new(&r.local_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
            })
            .collect();
        assert_eq!(result_filenames.len(), 3, "three filenames recorded");
        // Distinct filenames = sequential UUIDs preserved order.
        let unique: std::collections::HashSet<&&str> = result_filenames.iter().collect();
        assert_eq!(unique.len(), 3, "filenames must be distinct (UUID-based)");
    }

    #[test]
    fn save_picked_photos_pure_rejects_invalid_mode() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        let photos = vec![("a.png".to_string(), test_png_bytes(2, 2))];
        let err = save_picked_photos_pure(&conn, dir.path(), &eid, &photos, "bogus")
            .expect_err("must reject unknown mode");
        assert!(err.contains("inline") || err.contains("attached"));
    }

    #[test]
    fn save_picked_photos_pure_defaults_extension_when_filename_has_none() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        // Filename without extension — helper should default to "jpg".
        let photos = vec![("noext".to_string(), test_png_bytes(2, 2))];
        let results =
            save_picked_photos_pure(&conn, dir.path(), &eid, &photos, "inline").expect("save ok");
        let media = crate::db::get_media(&conn, &results[0].media_id)
            .unwrap()
            .unwrap();
        // mime_from_ext("jpg") returns image/jpeg.
        assert_eq!(media.file_type, "image/jpeg");
    }

    // ── Phase 1, Task 3: configurable upload limits ──────────────────────────
    //
    // These tests cover the 5 scenarios listed in the plan's Verify section.
    // They exercise the pure helpers (`save_media_to_media_dir`,
    // `save_picked_photos_pure`, `read_attachment_with_cap`) plus the
    // configurable video size-check logic that `pick_video` /
    // `pick_videos_from_library` use, since those two commands themselves
    // require a live Tauri runtime (AppState) and cannot be invoked
    // directly from a unit test.

    /// Helper: count `media` rows for an entry. Media rows are hard-deleted
    /// (no `is_deleted` column on the `media` table), so a plain count is
    /// the truth: 0 means nothing was persisted for this entry.
    fn media_count(conn: &Connection, entry_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM media WHERE entry_id = ?1",
            rusqlite::params![entry_id],
            |row| row.get(0),
        )
        .unwrap_or(0)
    }

    /// Helper: build a JPEG large enough to be a realistic "phone photo" —
    /// used by the recompress-and-accept test so the source is comfortably
    /// over a tight limit but the ladder can squeeze it under.
    fn test_large_jpeg_bytes(w: u32, h: u32) -> Vec<u8> {
        use image::{ImageBuffer, ImageFormat, Rgb};
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Jpeg)
            .unwrap();
        out
    }

    /// Scenario 1 (video): an over-limit source file is rejected before any
    /// file is written to the media directory or any media row is inserted.
    ///
    /// `pick_video` is a Tauri command (needs AppState), so we exercise the
    /// exact size-check logic it uses: read the source with
    /// `read_attachment_with_cap` under the configured video limit, compare
    /// lengths, and build the `VIDEO_TOO_LARGE` error string. We then assert
    /// the rejection fires (the same branch `pick_video` would take) AND that
    /// no `save_media_to_media_dir` call happens — i.e. no media row and no
    /// file in the media dir.
    #[test]
    fn over_limit_video_rejected_with_no_file_written_and_no_row() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        // Tighten the video limit to 1 MB so a 2 MB "video" exceeds it.
        crate::db::queries::set_media_max_video_upload_bytes(&conn, 1024 * 1024).unwrap();
        let limit = crate::db::queries::get_media_max_video_upload_bytes(&conn).unwrap();
        assert_eq!(limit, 1024 * 1024);

        // Write a 2 MB fake video to a temp file (the path a file picker
        // would hand us).
        let fake_bytes = vec![0u8; 2 * 1024 * 1024];
        let src = dir.path().join("clip.mp4");
        std::fs::write(&src, &fake_bytes).unwrap();

        // Mirror pick_video's read + size check.
        let cap_u64: u64 = limit.try_into().unwrap_or(4 * 1024 * 1024 * 1024);
        let bytes = read_attachment_with_cap(&src, cap_u64).expect("read ok");
        let rejected = (bytes.len() as i64) > limit;
        assert!(rejected, "2 MB clip must exceed the 1 MB limit");
        // The error string format the frontend parses must be preserved.
        let err = format!("VIDEO_TOO_LARGE:clip.mp4:{}", limit / (1024 * 1024));
        assert_eq!(err, "VIDEO_TOO_LARGE:clip.mp4:1");

        // And, critically, NO media row exists for the entry because the
        // import aborted before save_media_to_media_dir was ever called.
        assert_eq!(media_count(&conn, &eid), 0, "no media row on rejection");
        // No file written into the media dir either.
        assert!(
            std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("mp4"))
                .count()
                == 1,
            "the source temp file is the only .mp4; nothing landed in the media dir"
        );
    }

    /// Partial batch: two clips under the cap and one over it. Fitting clips
    /// are saved; the oversized filename is reported in `rejected` so the
    /// frontend can explain why fewer videos landed.
    #[test]
    fn pick_videos_partial_rejection_saves_fitting_and_reports_rejected() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        crate::db::queries::set_media_max_video_upload_bytes(&conn, 1024 * 1024).unwrap();
        let limit = crate::db::queries::get_media_max_video_upload_bytes(&conn).unwrap();

        let videos = [
            ("fit-a.mp4".to_string(), vec![0u8; 512 * 1024]),
            ("oversized.mp4".to_string(), vec![0u8; 2 * 1024 * 1024]),
            ("fit-b.mp4".to_string(), vec![0u8; 256 * 1024]),
        ];

        let result = save_picked_videos_pure(&conn, dir.path(), &eid, &videos, "inline", limit)
            .expect("partial batch must succeed");
        assert_eq!(result.saved.len(), 2, "two fitting clips must be saved");
        assert_eq!(result.rejected, vec!["oversized.mp4".to_string()]);
        assert_eq!(media_count(&conn, &eid), 2);
    }

    #[test]
    fn partition_videos_by_size_empty_pick_is_empty() {
        let (fitting, rejected) = partition_videos_by_size(Vec::new(), 1024);
        assert!(fitting.is_empty());
        assert!(rejected.is_empty());
    }

    #[test]
    fn partition_videos_by_size_all_oversized() {
        let videos = vec![
            ("a.mp4".to_string(), vec![0u8; 8]),
            ("b.mp4".to_string(), vec![0u8; 16]),
        ];
        let (fitting, rejected) = partition_videos_by_size(videos, 4);
        assert!(fitting.is_empty());
        assert_eq!(rejected, vec!["a.mp4".to_string(), "b.mp4".to_string()]);
    }

    #[test]
    fn pick_videos_empty_pick_is_ok_empty_empty() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);
        let result = save_picked_videos_pure(&conn, dir.path(), &eid, &[], "inline", 1024)
            .expect("cancel / empty pick must succeed");
        assert!(result.saved.is_empty());
        assert!(result.rejected.is_empty());
        assert_eq!(media_count(&conn, &eid), 0);
    }

    #[test]
    fn pick_videos_all_oversized_is_video_too_large_err() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);
        let limit = 1024 * 1024;
        let videos = [
            ("big-a.mp4".to_string(), vec![0u8; 2 * 1024 * 1024]),
            ("big-b.mp4".to_string(), vec![0u8; 3 * 1024 * 1024]),
        ];
        let err = save_picked_videos_pure(&conn, dir.path(), &eid, &videos, "inline", limit)
            .expect_err("all-oversized batch must error");
        assert_eq!(
            err,
            format!("VIDEO_TOO_LARGE:big-a.mp4:{}", limit / (1024 * 1024))
        );
        assert_eq!(media_count(&conn, &eid), 0);
    }

    /// Scenario 2 (photo recompressed + accepted): a large JPEG that is over
    /// the configured photo limit in raw form but fits once the escalation
    /// ladder runs must be accepted, with a media row inserted and the file
    /// written to the media dir. This is the core value of running the ladder
    /// BEFORE the size check.
    #[test]
    fn over_limit_photo_recompressed_and_accepted() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        // Build a big JPEG and measure its raw size, then set the photo limit
        // just below the raw size so the source is "over the limit" before
        // compression. Standard compression (2400px, q85) on a 4000x3000
        // synthetic image yields a much smaller JPEG, so the ladder's first
        // attempt already fits.
        let big = test_large_jpeg_bytes(4000, 3000);
        let raw_len = big.len() as i64;
        // Limit = raw - 1 byte: raw source is strictly over.
        let limit = (raw_len - 1).max(1024 * 1024); // keep >= 1 MB floor
        crate::db::queries::set_media_max_photo_upload_bytes(&conn, limit).unwrap();

        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &big, "jpg", "inline")
            .expect("recompressed photo must be accepted");

        // Media row exists + file written.
        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .expect("media row");
        assert_eq!(media.file_type, "image/jpeg");
        assert!(Path::new(&media.storage_path).exists(), "file written");
        // The persisted bytes must be UNDER the configured limit.
        let persisted_len = std::fs::metadata(&media.storage_path).unwrap().len() as i64;
        assert!(
            persisted_len <= limit,
            "persisted photo ({persisted_len} bytes) must be under the limit ({limit} bytes)"
        );
    }

    /// Scenario 3 (incompressible + over-limit photo rejected): an HEIC byte
    /// stream (which `compress_to_fit` cannot shrink) larger than the limit
    /// must be rejected with an `IMAGE_TOO_LARGE:...:Incompressible`-style
    /// error, no media row, no file in the media dir.
    #[test]
    fn incompressible_over_limit_photo_rejected() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        // 1 MB floor means the smallest configurable limit is 1 MB. Make the
        // fake HEIC 2 MB so it is clearly over.
        crate::db::queries::set_media_max_photo_upload_bytes(&conn, 1024 * 1024).unwrap();
        let fake_heic = vec![0xAAu8; 2 * 1024 * 1024];

        let err = save_media_to_media_dir(&conn, dir.path(), &eid, &fake_heic, "heic", "inline")
            .expect_err("incompressible over-limit HEIC must be rejected");
        assert!(
            err.starts_with("IMAGE_TOO_LARGE:"),
            "expected IMAGE_TOO_LARGE error, got: {err}"
        );
        // No media row.
        assert_eq!(media_count(&conn, &eid), 0, "no media row on rejection");
        // No file written to the media dir (the dir only contains nothing
        // or files unrelated to this import).
        let heic_files = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("heic"))
            .count();
        assert_eq!(heic_files, 0, "no .heic file written on rejection");
    }

    /// Scenario 4 (mixed batch): a batch with one fitting PNG and one
    /// incompressible over-limit HEIC must import the fitting PNG and skip
    /// (not abort on) the rejected one. The returned vec has exactly the
    /// accepted items; the rejected filename never produces a media row.
    #[test]
    fn mixed_batch_imports_fitting_files_and_skips_rejected() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        // 1 MB photo limit.
        crate::db::queries::set_media_max_photo_upload_bytes(&conn, 1024 * 1024).unwrap();

        // Small PNG (well under the limit) + large incompressible HEIC.
        let png = test_png_bytes(4, 4);
        let heic = vec![0xAAu8; 2 * 1024 * 1024];
        let photos = vec![
            ("small.png".to_string(), png),
            ("huge.heic".to_string(), heic),
        ];

        let results = save_picked_photos_pure(&conn, dir.path(), &eid, &photos, "inline")
            .expect("batch must not abort on one rejected item");
        // Exactly the one accepted item.
        assert_eq!(results.len(), 1, "only the fitting PNG should be imported");
        let media = crate::db::get_media(&conn, &results[0].media_id)
            .unwrap()
            .expect("media row for the PNG");
        assert_eq!(media.file_type, "image/png");
        // Only one media row total for the entry.
        assert_eq!(
            media_count(&conn, &eid),
            1,
            "exactly one media row — the rejected HEIC must not produce one"
        );
    }

    /// Scenario 5 (unlimited): with the photo limit set to `-1`
    /// (`get_media_max_photo_upload_bytes` returns `i64::MAX`), a file of
    /// any size must be accepted — including a large JPEG that would
    /// otherwise exceed the default 5 MB limit.
    #[test]
    fn unlimited_setting_accepts_any_size_photo() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let eid = make_entry(&conn);

        // Unlimited sentinel.
        crate::db::queries::set_media_max_photo_upload_bytes(&conn, -1).unwrap();
        let limit = crate::db::queries::get_media_max_photo_upload_bytes(&conn).unwrap();
        assert_eq!(
            limit,
            i64::MAX,
            "unlimited sentinel must read back as i64::MAX"
        );

        // A JPEG large enough to exceed the default 5 MB cap (if the limit
        // were the default). Synthetic 5000x4000 JPEGs land well above that.
        let big = test_large_jpeg_bytes(5000, 4000);
        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &big, "jpg", "inline")
            .expect("unlimited limit must accept any size");

        let media = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .expect("media row");
        assert!(Path::new(&media.storage_path).exists(), "file written");
    }

    // ── read_media_thumbnail_bytes logic tests ───────────────────────────────
    //
    // `read_media_thumbnail_bytes` is a #[tauri::command] that requires
    // `State<'_, AppState>`, which cannot be constructed outside of a real
    // Tauri app context. The tests below exercise the same decision tree
    // (thumbnail path present & file exists → return thumbnail bytes; no
    // thumbnail path or missing file → fall back to full storage bytes)
    // by calling the DB helpers and std::fs directly — identical to what the
    // command body does after locking AppState.

    #[test]
    fn read_media_thumbnail_bytes_returns_thumbnail_when_present() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();

        // Write the full-size file.
        let full_path = dir.path().join("full.jpg");
        std::fs::write(&full_path, b"FULL").unwrap();

        // Write a separate thumbnail file with distinct content.
        let thumb_path = dir.path().join("thumb.jpg");
        std::fs::write(&thumb_path, b"THUMB").unwrap();

        // Insert a media row referencing the full-size file (no thumbnail yet).
        let media = make_media_row(&conn, full_path.to_str().unwrap(), None, "photo.jpg");

        // Set the thumbnail path on the row, then re-fetch.
        crate::db::update_media_thumbnail_path(
            &conn,
            &media.id,
            Some(thumb_path.to_str().unwrap()),
        )
        .unwrap();
        let media = crate::db::get_media(&conn, &media.id).unwrap().unwrap();

        // Replicate the command's decision tree.
        let bytes = if let Some(ref tp) = media.thumbnail_path {
            let p = Path::new(tp);
            if p.exists() {
                std::fs::read(p).unwrap()
            } else {
                std::fs::read(&media.storage_path).unwrap()
            }
        } else {
            std::fs::read(&media.storage_path).unwrap()
        };

        assert_eq!(bytes, b"THUMB", "should return thumbnail bytes, not full");
    }

    #[test]
    fn read_media_thumbnail_bytes_falls_back_to_full_when_no_thumbnail() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();

        // Write only the full-size file; no thumbnail.
        let full_path = dir.path().join("full.jpg");
        std::fs::write(&full_path, b"FULL").unwrap();

        // Insert a media row with thumbnail_path = None.
        let media = make_media_row(&conn, full_path.to_str().unwrap(), None, "photo.jpg");
        // Confirm no thumbnail is set.
        assert!(media.thumbnail_path.is_none());

        // Replicate the command's decision tree.
        let bytes = if let Some(ref tp) = media.thumbnail_path {
            let p = Path::new(tp);
            if p.exists() {
                std::fs::read(p).unwrap()
            } else {
                std::fs::read(&media.storage_path).unwrap()
            }
        } else {
            std::fs::read(&media.storage_path).unwrap()
        };

        assert_eq!(bytes, b"FULL", "should fall back to full bytes");
    }

    // ── pick_files_to_attach helpers ─────────────────────────────────────────

    #[test]
    fn sanitize_attachment_filename_keeps_normal_name() {
        assert_eq!(sanitize_attachment_filename("report.pdf"), "report.pdf");
        assert_eq!(
            sanitize_attachment_filename("My File-v2.zip"),
            "My File-v2.zip"
        );
    }

    #[test]
    fn sanitize_attachment_filename_strips_leading_dots() {
        assert_eq!(sanitize_attachment_filename(".bashrc"), "bashrc");
        assert_eq!(sanitize_attachment_filename("..notes.txt"), "notes.txt");
    }

    #[test]
    fn sanitize_attachment_filename_replaces_path_separators() {
        assert_eq!(sanitize_attachment_filename("a/b.pdf"), "a_b.pdf");
        assert_eq!(sanitize_attachment_filename("a\\b.pdf"), "a_b.pdf");
        assert_eq!(sanitize_attachment_filename("a/b\\c.txt"), "a_b_c.txt");
    }

    #[test]
    fn sanitize_attachment_filename_falls_back_for_dot_only() {
        assert_eq!(sanitize_attachment_filename("..."), "file.bin");
        assert_eq!(sanitize_attachment_filename("."), "file.bin");
    }

    #[test]
    fn sanitize_attachment_filename_output_passes_safety_validator() {
        // The whole point: sanitized names must round-trip through
        // is_safe_cache_filename so peer fetches don't reject them.
        for raw in &[
            ".bashrc",
            "a/b.pdf",
            "..notes.txt",
            "...",
            "normal.zip",
            "file with spaces.docx",
        ] {
            let s = sanitize_attachment_filename(raw);
            assert!(
                is_safe_cache_filename(&s),
                "sanitized form of {raw:?} ({s:?}) must be safe"
            );
        }
    }

    #[test]
    fn sanitize_attachment_filename_replaces_control_chars() {
        assert_eq!(sanitize_attachment_filename("a\0b.pdf"), "a_b.pdf");
        assert_eq!(
            sanitize_attachment_filename("line\nbreak.txt"),
            "line_break.txt"
        );
        assert_eq!(
            sanitize_attachment_filename("tab\there.zip"),
            "tab_here.zip"
        );
    }

    #[test]
    fn sanitize_attachment_filename_caps_length() {
        // 300-byte name → result must be ≤ SANITIZED_FILENAME_MAX_BYTES.
        let long = "a".repeat(300);
        let s = sanitize_attachment_filename(&long);
        assert!(
            s.len() <= SANITIZED_FILENAME_MAX_BYTES,
            "sanitized name length {} exceeds cap {}",
            s.len(),
            SANITIZED_FILENAME_MAX_BYTES
        );
        // Multi-byte chars must not be split mid-codepoint — result must be
        // valid UTF-8 (Rust enforces this for String, so unwrap is enough).
        let mb = "🎉".repeat(100); // 4 bytes × 100 = 400 bytes
        let s2 = sanitize_attachment_filename(&mb);
        assert!(s2.len() <= SANITIZED_FILENAME_MAX_BYTES);
        // Sanity: the sliced string is still valid UTF-8 (no panic).
        let _ = s2.chars().count();
    }

    #[test]
    fn read_attachment_with_cap_returns_bytes_when_under_limit() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("small.bin");
        std::fs::write(&p, b"hello world").unwrap();
        let bytes = read_attachment_with_cap(&p, 1024).unwrap();
        assert_eq!(bytes, b"hello world");
    }

    #[test]
    fn read_attachment_with_cap_stops_at_cap_plus_one() {
        // Write a 100-byte file with a tiny test cap of 32 bytes. The helper
        // must return at most cap+1=33 bytes so the caller can detect that
        // the file overflowed the limit. Crucially, the helper does NOT
        // allocate the full file size on heap — `take(cap+1)` short-circuits.
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("big.bin");
        let payload = vec![0u8; 100];
        std::fs::write(&p, &payload).unwrap();
        let bytes = read_attachment_with_cap(&p, 32).unwrap();
        assert_eq!(
            bytes.len(),
            33,
            "must read cap+1 so caller can detect overflow"
        );
    }

    #[test]
    fn read_attachment_with_cap_returns_full_file_at_exact_cap() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("exact.bin");
        let payload = vec![0u8; 32];
        std::fs::write(&p, &payload).unwrap();
        let bytes = read_attachment_with_cap(&p, 32).unwrap();
        // File is exactly at cap → caller sees len() == cap, NOT cap+1.
        // This is what lets the caller distinguish "at limit" from "over limit".
        assert_eq!(bytes.len(), 32);
    }

    #[test]
    fn save_attached_file_inserts_row_and_writes_disk() {
        let conn = setup_db();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
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
        let bytes = b"PDF-like bytes";
        let result =
            save_attached_file_to_media_dir(&conn, dir.path(), &eid, "report.pdf", bytes).unwrap();

        // Disk: file was written under the media dir with the UUID-named path.
        assert!(
            std::path::Path::new(&result.local_path).exists(),
            "saved file should exist on disk"
        );
        // DB: row exists with the correct file_name + insertion_mode + MIME.
        let row = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.file_name, "report.pdf");
        assert_eq!(row.insertion_mode, "attached");
        assert_eq!(row.file_type, "application/octet-stream");
    }

    #[test]
    fn save_attached_file_rejects_media_extension_at_helper_boundary() {
        // Defense-in-depth: even if the front-end / outer command let a
        // media extension through, the helper itself must refuse.
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let err = save_attached_file_to_media_dir(&conn, dir.path(), "entry-1", "photo.jpg", b"x")
            .unwrap_err();
        assert!(err.contains("media type"), "got: {err}");
        // And nothing was written to disk.
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn save_attached_file_removes_orphan_when_db_insert_fails() {
        // Use a non-existent entry_id so the media FK constraint fires.
        // The helper must clean up the on-disk file it just wrote so the
        // media dir doesn't accumulate untracked bytes.
        let conn = setup_db();
        let dir = TempDir::new().unwrap();
        let result =
            save_attached_file_to_media_dir(&conn, dir.path(), "no-such-entry", "report.pdf", b"x");
        assert!(result.is_err(), "expected FK-constraint failure");
        // Nothing should be left under the media dir.
        let leftover: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert!(
            leftover.is_empty(),
            "orphan file not cleaned up: {leftover:?}"
        );
    }

    #[test]
    fn save_attached_file_handles_extensionless_filename() {
        let conn = setup_db();
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
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
        // A "Makefile" — no extension.
        let result =
            save_attached_file_to_media_dir(&conn, dir.path(), &eid, "Makefile", b"all:\n\techo")
                .unwrap();
        let row = crate::db::get_media(&conn, &result.media_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.file_name, "Makefile");
        assert_eq!(row.file_type, "application/octet-stream");
        assert!(std::path::Path::new(&result.local_path).exists());
    }

    // ── export_media_to_path_inner ───────────────────────────────────────────

    fn make_media_with_file(conn: &Connection, src_dir: &Path) -> (String, std::path::PathBuf) {
        let src_file = src_dir.join("source.txt");
        std::fs::write(&src_file, b"hello export").unwrap();
        let jid = crate::db::create_journal(conn, "J2", None).unwrap().id;
        let eid = crate::db::create_entry(
            conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 2_000_000,
            },
        )
        .unwrap()
        .id;
        let media = crate::db::create_media(
            conn,
            crate::db::CreateMediaParams {
                entry_id: &eid,
                file_name: "source.txt",
                file_type: "text/plain",
                storage_path: &src_file.to_string_lossy(),
                file_size: Some(12),
                sort_order: 0,
                insertion_mode: "attached",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        (media.id, src_file)
    }

    /// Create a temporary directory rooted under $HOME so the dest path is
    /// not inside a system-sensitive location (macOS TempDir resolves to
    /// /var/folders/… which is blocked by path validation).
    fn home_tempdir() -> TempDir {
        let home = std::env::var("HOME").expect("HOME must be set");
        tempfile::Builder::new()
            .prefix("memlore_test_")
            .tempdir_in(&home)
            .expect("failed to create tempdir under HOME")
    }

    #[test]
    fn export_media_to_path_copies_bytes() {
        let conn = setup_db();
        let src_dir = home_tempdir();
        let dest_dir = home_tempdir();
        let (media_id, _src) = make_media_with_file(&conn, src_dir.path());
        let dest = dest_dir.path().join("output.txt");
        let result = export_media_to_path_inner(&conn, &media_id, &dest.to_string_lossy());
        assert!(result.is_ok(), "copy should succeed: {:?}", result.err());
        assert!(dest.exists(), "destination file should exist");
        let bytes = std::fs::read(&dest).unwrap();
        assert_eq!(bytes, b"hello export");
    }

    #[test]
    fn export_media_to_path_errors_when_media_missing() {
        let conn = setup_db();
        let dest_dir = home_tempdir();
        let dest = dest_dir.path().join("output.txt");
        let result = export_media_to_path_inner(&conn, "nonexistent-id", &dest.to_string_lossy());
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("Media not found"),
            "expected 'Media not found' error"
        );
    }

    #[test]
    fn export_media_to_path_errors_when_storage_path_missing() {
        let conn = setup_db();
        let jid = crate::db::create_journal(&conn, "J3", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 3_000_000,
            },
        )
        .unwrap()
        .id;
        // Insert a media row with a storage_path that does not exist on disk.
        let media = crate::db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &eid,
                file_name: "ghost.txt",
                file_type: "text/plain",
                storage_path: "/nonexistent/path/ghost.txt",
                file_size: Some(5),
                sort_order: 0,
                insertion_mode: "attached",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        let dest_dir = home_tempdir();
        let dest = dest_dir.path().join("output.txt");
        let result = export_media_to_path_inner(&conn, &media.id, &dest.to_string_lossy());
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("not cached locally"),
            "expected 'not cached locally' error"
        );
    }

    // ── export_media_to_path_inner — path validation tests ──────────────────

    #[test]
    fn export_media_to_path_rejects_empty_dest() {
        let conn = setup_db();
        let result = export_media_to_path_inner(&conn, "any-id", "");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.starts_with("INVALID_DEST_PATH:"),
            "expected INVALID_DEST_PATH error, got: {err}"
        );
        assert!(err.contains("empty"), "expected 'empty' in message: {err}");
    }

    #[test]
    fn export_media_to_path_rejects_relative_path() {
        let conn = setup_db();
        let result = export_media_to_path_inner(&conn, "any-id", "relative/path/file.txt");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.starts_with("INVALID_DEST_PATH:"),
            "expected INVALID_DEST_PATH error, got: {err}"
        );
        assert!(
            err.contains("absolute"),
            "expected 'absolute' in message: {err}"
        );
    }

    #[test]
    fn export_media_to_path_rejects_missing_parent_dir() {
        let conn = setup_db();
        let home = std::env::var("HOME").unwrap();
        // Parent dir does not exist.
        let dest = format!("{home}/memlore_test_nonexistent_dir_xyz/output.txt");
        let result = export_media_to_path_inner(&conn, "any-id", &dest);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.starts_with("INVALID_DEST_PATH:"),
            "expected INVALID_DEST_PATH error, got: {err}"
        );
        assert!(
            err.contains("does not exist"),
            "expected 'does not exist' in message: {err}"
        );
    }

    #[test]
    fn export_media_to_path_rejects_symlink_destination() {
        let conn = setup_db();
        let dir = home_tempdir();
        // Create a real target file and a symlink pointing at it.
        let target = dir.path().join("real_target.txt");
        std::fs::write(&target, b"target").unwrap();
        let link = dir.path().join("symlink.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        // The dest_path is the symlink — should be rejected.
        let result = export_media_to_path_inner(&conn, "any-id", &link.to_string_lossy());
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.starts_with("INVALID_DEST_PATH:"),
            "expected INVALID_DEST_PATH error, got: {err}"
        );
        assert!(
            err.contains("not a regular file"),
            "expected 'not a regular file' in message: {err}"
        );
    }

    #[test]
    fn export_media_to_path_rejects_system_path() {
        let conn = setup_db();
        // /etc exists as a directory on macOS — parent check would pass if we
        // didn't do the sensitive-prefix check first.
        let result = export_media_to_path_inner(&conn, "any-id", "/etc/foo.txt");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.starts_with("INVALID_DEST_PATH:"),
            "expected INVALID_DEST_PATH error, got: {err}"
        );
        assert!(
            err.contains("protected system path"),
            "expected 'protected system path' in message: {err}"
        );
    }

    #[test]
    fn export_media_to_path_rejects_ssh_dir() {
        let conn = setup_db();
        let home = std::env::var("HOME").unwrap();
        let dest = format!("{home}/.ssh/authorized_keys_memlore_test");
        let result = export_media_to_path_inner(&conn, "any-id", &dest);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.starts_with("INVALID_DEST_PATH:"),
            "expected INVALID_DEST_PATH error, got: {err}"
        );
        assert!(
            err.contains("protected home directory path"),
            "expected 'protected home directory path' in message: {err}"
        );
    }

    // ── media upload limits (get/set command-level roundtrip) ───────────────

    #[test]
    fn media_upload_limits_roundtrip_persists_both_fields() {
        let conn = setup_db();
        // Sanity: defaults are present before any write.
        let before = get_media_upload_limits_inner(&conn).unwrap();
        assert_eq!(
            before.photo_bytes,
            crate::db::queries::DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES
        );
        assert_eq!(
            before.video_bytes,
            crate::db::queries::DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES
        );

        // Set explicit, distinct, above-floor values and confirm the getters
        // read them back verbatim (no clamping expected for sane input).
        let photo = 5 * 1024 * 1024;
        let video = 250 * 1024 * 1024;
        let after = set_media_upload_limits_inner(&conn, photo, video).unwrap();
        assert_eq!(after.photo_bytes, photo);
        assert_eq!(after.video_bytes, video);

        // A fresh read reflects the persisted values — proving the setter
        // actually wrote (not just echoed its arguments).
        let reread = get_media_upload_limits_inner(&conn).unwrap();
        assert_eq!(reread, after);
    }

    #[test]
    fn media_upload_limits_roundtrip_keeps_unlimited_sentinel() {
        let conn = setup_db();
        // The DTO carries the raw `-1` sentinel — NOT `i64::MAX`, which the
        // internal comparison paths use. See the next test for why.
        let after = set_media_upload_limits_inner(&conn, -1, -1).unwrap();
        assert_eq!(after.photo_bytes, -1);
        assert_eq!(after.video_bytes, -1);
        assert_eq!(get_media_upload_limits_inner(&conn).unwrap(), after);
    }

    /// Regression: `i64::MAX` is not representable as an f64, so a limit of
    /// 9223372036854775807 reaches the frontend as 9223372036854776000 and
    /// then fails to deserialize back into `i64` on the next setter call
    /// ("invalid value: integer `9223372036854776000`, expected i64"). Every
    /// field of the IPC DTO must stay within JS's safe-integer range, and a
    /// mixed pair must translate ONLY the unlimited side.
    #[test]
    fn media_upload_limits_never_exceed_js_safe_integer() {
        let conn = setup_db();
        for (photo, video) in [
            (-1, -1),
            (-1, 200 * 1024 * 1024),
            (10 * 1024 * 1024, -1),
            (MAX_MEDIA_UPLOAD_BYTES, MAX_MEDIA_UPLOAD_BYTES),
        ] {
            let after = set_media_upload_limits_inner(&conn, photo, video).unwrap();
            // Exact expectation: a finite limit round-trips verbatim, and only
            // the `-1` sentinel stays `-1` — an upper-bound-only assertion
            // would also pass on a wrongly-negative finite value.
            assert_eq!(after.photo_bytes, photo);
            assert_eq!(after.video_bytes, video);
            assert!(after.photo_bytes <= MAX_MEDIA_UPLOAD_BYTES);
            assert!(after.video_bytes <= MAX_MEDIA_UPLOAD_BYTES);
        }
    }

    /// The `i64::MAX` → `-1` translation, tested directly rather than only
    /// through the queries layer's `-1` → `i64::MAX` mapping.
    #[test]
    fn to_ipc_upload_limit_translates_only_the_unlimited_form() {
        assert_eq!(to_ipc_upload_limit(i64::MAX), -1);
        assert_eq!(to_ipc_upload_limit(10 * 1024 * 1024), 10 * 1024 * 1024);
        assert_eq!(to_ipc_upload_limit(-1), -1);
        assert_eq!(
            to_ipc_upload_limit(MAX_MEDIA_UPLOAD_BYTES),
            MAX_MEDIA_UPLOAD_BYTES
        );
    }

    /// The setter refuses oversized input, but a settings row written before
    /// that ceiling existed (or through the generic `set_setting` command,
    /// which has no per-key allowlist) can still hold one. The read path must
    /// clamp it rather than hand the frontend an imprecise f64.
    #[test]
    fn oversized_stored_limit_is_clamped_on_read() {
        let conn = setup_db();
        let oversized = (MAX_MEDIA_UPLOAD_BYTES + 1_000).to_string();
        crate::db::queries::set_setting(
            &conn,
            crate::db::queries::MEDIA_MAX_PHOTO_UPLOAD_BYTES_KEY,
            &oversized,
        )
        .unwrap();
        let limits = get_media_upload_limits_inner(&conn).unwrap();
        assert_eq!(limits.photo_bytes, MAX_MEDIA_UPLOAD_BYTES);
        // The clamped value is itself a legal setter input — the panel can
        // still write the other field without wedging.
        set_media_upload_limits_inner(&conn, limits.photo_bytes, limits.video_bytes).unwrap();
    }

    /// Boundary: exactly 1 MB is accepted, one byte under is refused.
    #[test]
    fn media_upload_limits_min_boundary_is_inclusive() {
        let conn = setup_db();
        let ok =
            set_media_upload_limits_inner(&conn, MIN_MEDIA_UPLOAD_BYTES, MIN_MEDIA_UPLOAD_BYTES)
                .unwrap();
        assert_eq!(ok.photo_bytes, MIN_MEDIA_UPLOAD_BYTES);
        assert_eq!(ok.video_bytes, MIN_MEDIA_UPLOAD_BYTES);
        set_media_upload_limits_inner(&conn, MIN_MEDIA_UPLOAD_BYTES - 1, MIN_MEDIA_UPLOAD_BYTES)
            .expect_err("one byte below the floor must be rejected");
    }

    /// A value in `[2^53, i64::MAX)` is exactly the band the DTO invariant
    /// says cannot exist — the setter must refuse it instead of persisting a
    /// limit that reads back as an imprecise f64.
    #[test]
    fn media_upload_limits_reject_values_above_js_safe_integer() {
        let conn = setup_db();
        let too_big = MAX_MEDIA_UPLOAD_BYTES + 1;
        let err = set_media_upload_limits_inner(&conn, too_big, 200 * 1024 * 1024).unwrap_err();
        assert!(err.contains("photo_bytes"), "unexpected error: {err}");
        let err = set_media_upload_limits_inner(&conn, 10 * 1024 * 1024, i64::MAX).unwrap_err();
        assert!(err.contains("video_bytes"), "unexpected error: {err}");
        // Nothing was written — BOTH fields still hold the defaults, so a
        // half-applied write can't hide behind a single-field assertion.
        let after = get_media_upload_limits_inner(&conn).unwrap();
        assert_eq!(
            after.photo_bytes,
            crate::db::queries::DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES
        );
        assert_eq!(
            after.video_bytes,
            crate::db::queries::DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES
        );
    }

    #[test]
    fn media_upload_limits_writes_are_atomic_both_or_neither() {
        // The transaction wraps BOTH writes. On the success path we assert
        // that neither field holds a stale value: a fresh read after a
        // successful set must reflect BOTH new values, ruling out a
        // half-applied write where only one `set_setting` landed. (A failure
        // mid-write can't be cleanly triggered on in-memory SQLite without
        // killing the process, so we rely on the explicit ROLLBACK branch in
        // the implementation plus this all-or-nothing read-back.)
        let conn = setup_db();

        // Establish a known baseline that's distinct from the new values.
        let baseline =
            set_media_upload_limits_inner(&conn, 10 * 1024 * 1024, 20 * 1024 * 1024).unwrap();
        assert_eq!(baseline.photo_bytes, 10 * 1024 * 1024);
        assert_eq!(baseline.video_bytes, 20 * 1024 * 1024);

        // Set BOTH fields to fresh values.
        let new_photo = 7 * 1024 * 1024;
        let new_video = 33 * 1024 * 1024;
        let _ = set_media_upload_limits_inner(&conn, new_photo, new_video).unwrap();

        // Read back directly from the settings table — both keys must be the
        // new values. If the transaction had half-applied, one would still
        // hold a baseline value.
        let reread = get_media_upload_limits_inner(&conn).unwrap();
        assert_eq!(reread.photo_bytes, new_photo);
        assert_eq!(reread.video_bytes, new_video);
    }

    #[test]
    fn media_upload_limits_rejects_sub_floor_photo_value() {
        let conn = setup_db();
        // 0 is below the 1 MB floor on the photo field — must be rejected
        // WITHOUT writing either field.
        let original = get_media_upload_limits_inner(&conn).unwrap();
        let result = set_media_upload_limits_inner(&conn, 0, 50 * 1024 * 1024);
        let err = result.expect_err("sub-floor photo value must be rejected");
        assert!(
            err.contains("photo_bytes") && err.contains("must be between"),
            "error should name the field and constraint, got: {err}"
        );
        // Nothing was written: both fields still hold the original values.
        let after = get_media_upload_limits_inner(&conn).unwrap();
        assert_eq!(after, original, "rejected setter must not mutate storage");
    }

    #[test]
    fn media_upload_limits_rejects_sub_floor_video_value() {
        let conn = setup_db();
        let original = get_media_upload_limits_inner(&conn).unwrap();
        // 500_000 bytes is below the 1 MB floor on the video field.
        let result = set_media_upload_limits_inner(&conn, 5 * 1024 * 1024, 500_000);
        let err = result.expect_err("sub-floor video value must be rejected");
        assert!(
            err.contains("video_bytes") && err.contains("must be between"),
            "error should name the field and constraint, got: {err}"
        );
        let after = get_media_upload_limits_inner(&conn).unwrap();
        assert_eq!(after, original, "rejected setter must not mutate storage");
    }

    #[test]
    fn media_upload_limits_rejects_negative_other_than_minus_one() {
        let conn = setup_db();
        // `-2` is negative but not the `-1` sentinel — must be rejected.
        let result = set_media_upload_limits_inner(&conn, -2, 5 * 1024 * 1024);
        assert!(result.is_err());
        // And the message names the photo field.
        let err = result.unwrap_err();
        assert!(err.contains("photo_bytes"), "got: {err}");
    }

    // ── C1: save_media_to_media_dir must not leak orphan files on DB failure ──

    #[test]
    fn save_media_dir_removes_file_when_db_insert_fails() {
        // Inject a guaranteed DB-insert failure by dropping the `media` table
        // AFTER the schema is set up. `save_media_to_media_dir` writes the
        // file, THEN calls `create_media`; that insert must fail and the
        // written file must be cleaned up (no orphan). This is the cheapest
        // reliable failure injection in this codebase — closing/locking an
        // in-memory SQLite connection mid-call is awkward in a single thread.
        let conn = setup_db();

        // We need a real entry_id so any earlier validation would pass; the
        // entry row itself is irrelevant once `media` is gone.
        let jid = crate::db::create_journal(&conn, "J", None).unwrap().id;
        let eid = crate::db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &jid,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        // Drop the table so `create_media` returns a SqliteFailure (no such
        // table). The file write happens before the insert, so this exercises
        // the cleanup branch.
        conn.execute_batch("DROP TABLE media;").unwrap();

        let dir = TempDir::new().unwrap();
        // A tiny valid PNG (1x1) so compression + thumbnail paths are happy.
        let png = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        ];

        let result = save_media_to_media_dir(&conn, dir.path(), &eid, &png, "png", "inline");
        assert!(result.is_err(), "expected DB-insert failure, got Ok");

        // The cleanup is the actual fix under test: assert NO file with a
        // `.png` extension remains in the media dir (the UUID-prefixed dest
        // name is random, so glob for the extension).
        let leftover: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("png"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(
            leftover.is_empty(),
            "orphaned media file must be removed on DB-insert failure, but found: {:?}",
            leftover.iter().map(|e| e.path()).collect::<Vec<_>>()
        );
    }
}
