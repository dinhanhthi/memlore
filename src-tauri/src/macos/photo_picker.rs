use swift_rs::{swift, Int, SRData, SRObject, SRObjectArray, SRString};

#[repr(C)]
pub struct PickedPhoto {
    pub filename: SRString,
    pub data: SRData,
}

swift!(fn xj_pick_photos(limit: Int) -> SRObjectArray<PickedPhoto>);
swift!(fn xj_pick_videos(limit: Int) -> SRObjectArray<PickedPhoto>);
swift!(fn xj_extract_video_thumbnail(path: &SRString, max_edge: Int) -> SRData);
swift!(fn xj_transcode_video(in_path: &SRString, out_path: &SRString, preset: &SRString) -> Int);

/// Drain a swift-rs `SRObjectArray<PickedPhoto>` into owned tuples.
///
/// `SRObjectArray` is `!Send` (it holds an Objective-C pointer), so the FFI
/// call + this drain step must both run on the same blocking worker thread.
/// The returned `Vec<(String, Vec<u8>)>` IS `Send`, so callers can hand it
/// back across an `.await`.
fn drain_picked_photos(array: SRObjectArray<PickedPhoto>) -> Vec<(String, Vec<u8>)> {
    let slice: &[SRObject<PickedPhoto>] = array.as_slice();
    slice
        .iter()
        .map(|item| {
            let filename = item.filename.as_str().to_string();
            let bytes = item.data.as_slice().to_vec();
            (filename, bytes)
        })
        .collect()
}

/// Open the macOS PHPicker (images filter) and return the user's selection.
///
/// Returns `Ok(vec![])` when the user cancels (empty selection). Returns
/// `Err` when the bridge task fails to join (Swift code aborted before
/// `xj_pick_photos` could return).
///
/// The Swift side presents the picker on the main run loop. We call it from
/// a blocking worker thread via `spawn_blocking` so the calling tokio task
/// can `.await` without freezing.
///
/// # Errors
/// Returns an error immediately if `limit` is 0. In PHPickerConfiguration,
/// `selectionLimit = 0` means *unlimited*, which we never want — callers must
/// pass an explicit positive limit.
pub async fn pick_photos(limit: usize) -> Result<Vec<(String, Vec<u8>)>, String> {
    if limit == 0 {
        return Err("photo picker limit must be >= 1".to_string());
    }
    let limit_int: Int = limit as Int;
    let owned: Vec<(String, Vec<u8>)> = tokio::task::spawn_blocking(move || {
        // SAFETY: swift-rs guarantees the FFI surface; the Swift side never
        // panics outwards and always returns an SRObjectArray (possibly empty).
        let array: SRObjectArray<PickedPhoto> = unsafe { xj_pick_photos(limit_int) };
        drain_picked_photos(array)
    })
    .await
    .map_err(|e| format!("photo picker task join error: {e}"))?;

    Ok(owned)
}

/// Open the macOS PHPicker (videos filter) and return the user's selection.
///
/// Mirrors `pick_photos` for the video case: same semantics, same threading
/// model, same re-entrancy guard on the Swift side. Each returned `(String,
/// Vec<u8>)` is a video file's name + raw container bytes; the caller is
/// responsible for size validation BEFORE writing them to disk.
pub async fn pick_videos(limit: usize) -> Result<Vec<(String, Vec<u8>)>, String> {
    if limit == 0 {
        return Err("video picker limit must be >= 1".to_string());
    }
    let limit_int: Int = limit as Int;
    let owned: Vec<(String, Vec<u8>)> = tokio::task::spawn_blocking(move || {
        // SAFETY: same FFI contract as `pick_photos`; the Swift `xj_pick_videos`
        // dispatches through the same shared session + delegate code.
        let array: SRObjectArray<PickedPhoto> = unsafe { xj_pick_videos(limit_int) };
        drain_picked_photos(array)
    })
    .await
    .map_err(|e| format!("video picker task join error: {e}"))?;

    Ok(owned)
}

/// Extract a JPEG poster frame from `video_path`, downscaled so its longest
/// edge is at most `max_edge` px. Returns `Some(jpeg_bytes)` on success, or
/// `None` when AVFoundation can't decode the file (corrupted, unsupported
/// codec, missing). An empty `Vec<u8>` from the Swift side is normalized to
/// `None` so callers don't have to special-case it.
///
/// Runs inside `spawn_blocking` because `SRString` / `SRData` are `!Send`
/// and the AVFoundation generator does synchronous decode work.
pub async fn extract_video_thumbnail(video_path: String, max_edge: usize) -> Option<Vec<u8>> {
    let max_edge_int: Int = max_edge as Int;
    let bytes: Vec<u8> = tokio::task::spawn_blocking(move || {
        let sr_path = SRString::from(video_path.as_str());
        // SAFETY: swift-rs guarantees the FFI surface; the Swift side
        // returns an empty SRData on failure rather than panicking, so any
        // non-empty result is a valid JPEG byte slice we can clone before
        // crossing the Send boundary.
        let data = unsafe { xj_extract_video_thumbnail(&sr_path, max_edge_int) };
        data.as_slice().to_vec()
    })
    .await
    .ok()?;
    if bytes.is_empty() {
        None
    } else {
        Some(bytes)
    }
}

/// Transcode/downscale the video at `src_path` into an H.264 + AAC `.mp4` at
/// `dst_path` using the AVFoundation `AVAssetExportSession` preset named
/// `preset` (e.g. `AVAssetExportPreset960x540`). Returns `true` only when the
/// Swift side reports a completed export; `false` on any failure (missing
/// input, incompatible/invalid preset, export error). The caller treats
/// `false` as "keep the original bytes" — transcode is opportunistic and never
/// blocks an insert.
///
/// Runs inside `spawn_blocking` because `SRString` is `!Send` and the export
/// blocks the worker thread on a semaphore until AVFoundation finishes.
pub async fn transcode_video(src_path: String, dst_path: String, preset: String) -> bool {
    tokio::task::spawn_blocking(move || {
        let sr_in = SRString::from(src_path.as_str());
        let sr_out = SRString::from(dst_path.as_str());
        let sr_preset = SRString::from(preset.as_str());
        // SAFETY: swift-rs guarantees the FFI surface; the Swift side returns
        // 1/0 and never panics outward.
        let ok: Int = unsafe { xj_transcode_video(&sr_in, &sr_out, &sr_preset) };
        ok == 1
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `pick_photos(0)` must be rejected without invoking the FFI.
    /// The FFI call would block forever in a unit-test context (no
    /// NSApplication run loop, no window), so the early-return guard
    /// is load-bearing for testability as well as correctness.
    #[tokio::test]
    async fn pick_photos_rejects_zero_limit() {
        let result = pick_photos(0).await;
        assert!(result.is_err(), "expected Err for limit=0, got Ok");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("limit"),
            "error message should mention 'limit', got: {msg}"
        );
    }

    /// Mirror of `pick_photos_rejects_zero_limit` for the video bridge —
    /// same FFI-blocks-forever concern applies.
    #[tokio::test]
    async fn pick_videos_rejects_zero_limit() {
        let result = pick_videos(0).await;
        assert!(result.is_err(), "expected Err for limit=0, got Ok");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("limit"),
            "error message should mention 'limit', got: {msg}"
        );
    }

    /// Calling `extract_video_thumbnail` on a non-existent path returns
    /// `None` (Swift bridge returns empty `SRData`, Rust normalizes). This
    /// test exercises only the empty-bytes branch — it does NOT invoke
    /// AVFoundation in a meaningful way (the Swift side bails out at the
    /// `FileManager.default.fileExists` guard), so it's safe to run in CI
    /// without a real video fixture.
    #[tokio::test]
    async fn extract_video_thumbnail_missing_path_returns_none() {
        let result =
            extract_video_thumbnail("/tmp/xj-missing-video-fixture.mp4".to_string(), 512).await;
        assert!(
            result.is_none(),
            "missing file must produce None, got {:?}",
            result.as_ref().map(|v| v.len())
        );
    }

    /// `transcode_video` on a non-existent input returns `false` (Swift bails
    /// at the `fileExists` guard before touching AVFoundation), so it is safe
    /// to run in CI without a real video fixture. Mirrors the thumbnail
    /// missing-path test.
    #[tokio::test]
    async fn transcode_video_missing_input_returns_false() {
        let ok = transcode_video(
            "/tmp/xj-missing-video-fixture.mp4".to_string(),
            "/tmp/xj-missing-video-out.mp4".to_string(),
            "AVAssetExportPreset960x540".to_string(),
        )
        .await;
        assert!(!ok, "missing input must produce false");
    }
}
