//! Optional image compression applied before media files land in the media
//! directory. Reduces the on-disk + sync footprint of photos coming in from
//! Photo Library, file picker, or paste — without losing EXIF metadata
//! (date / GPS) that downstream features depend on.
//!
//! Scope (v1): JPEG sources only. HEIC bytes (iPhone Photo Library, when
//! `image` crate has no HEIF feature flag) pass through unchanged. Other
//! formats (PNG, WebP, …) are decoded → resized → re-encoded as JPEG when
//! they exceed `max_edge`, dropping their original metadata; pass through
//! unchanged when already within bounds. SVG and unknown MIMEs always
//! pass through.

use image::ImageReader;
use std::io::Cursor;

/// Compression preset chosen via Settings. The frontend writes one of these
/// strings to the `media_compression_mode` setting; `parse` does the
/// conversion. Default `Standard` matches the most common phone-photo case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionMode {
    /// Pass every image through unchanged. Original bytes go to disk.
    Off,
    /// Max edge 2400 px, JPEG quality 85. Good for typical iPhone shots
    /// (4032 × 3024 → 2400 × 1800, ~6× smaller on average).
    Standard,
    /// Max edge 1600 px, JPEG quality 75. Heavier squeeze for sync-bandwidth
    /// constrained users.
    Aggressive,
    /// User-provided edge + quality from Settings.
    Custom { max_edge: u32, quality: u8 },
}

impl CompressionMode {
    pub fn from_settings(mode: &str, edge: Option<u32>, quality: Option<u8>) -> Self {
        match mode.trim().to_lowercase().as_str() {
            "off" => Self::Off,
            "aggressive" => Self::Aggressive,
            "custom" => Self::Custom {
                max_edge: edge.unwrap_or(2000).clamp(320, 8000),
                quality: quality.unwrap_or(80).clamp(40, 100),
            },
            // Default: "standard" or any unknown / empty value
            _ => Self::Standard,
        }
    }

    /// Effective (max_edge, jpeg_quality) the encoder should target.
    fn params(&self) -> Option<(u32, u8)> {
        match self {
            Self::Off => None,
            Self::Standard => Some((2400, 85)),
            Self::Aggressive => Some((1600, 75)),
            Self::Custom { max_edge, quality } => Some((*max_edge, *quality)),
        }
    }
}

/// Compress `bytes` according to `mode`. Returns the (possibly resized)
/// bytes plus the MIME type and extension that should be persisted with
/// them — important when a PNG gets re-encoded as JPEG, since downstream
/// `mime_from_ext` is the source of truth for content-type display.
///
/// On any decode/encode failure, returns the original bytes / mime / ext
/// untouched: compression is opportunistic, never blocking.
pub fn compress_image(
    bytes: &[u8],
    mime: &str,
    ext: &str,
    mode: CompressionMode,
) -> (Vec<u8>, String, String) {
    let Some((max_edge, quality)) = mode.params() else {
        return (bytes.to_vec(), mime.to_string(), ext.to_string());
    };

    // HEIC/HEIF: `image` crate doesn't decode HEIF without the optional
    // `heif` feature (libheif C dep). Pass HEIC bytes through unchanged
    // — EXIF date/GPS still get extracted by `kamadak-exif` (which DOES
    // sniff HEIF containers) and the WKWebView renders HEIC natively on
    // macOS 11+. Until we ship `image` with the `heif` feature, this is
    // the correct graceful-degradation path.
    if mime == "image/heic" || mime == "image/heif" {
        return (bytes.to_vec(), mime.to_string(), ext.to_string());
    }

    // SVG / unknown / non-image: nothing to do.
    if !mime.starts_with("image/") || mime == "image/svg+xml" {
        return (bytes.to_vec(), mime.to_string(), ext.to_string());
    }

    // Try to decode; fall back to original on failure.
    let decoded = match ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .and_then(|r| Ok(r.decode()))
    {
        Ok(Ok(img)) => img,
        _ => return (bytes.to_vec(), mime.to_string(), ext.to_string()),
    };

    // Never upscale. If the source is already within bounds, pass it
    // through verbatim — preserves bytes (and any embedded EXIF APP1
    // segment) exactly. Re-encoding a tiny image to JPEG would also
    // *grow* it for screenshots with flat colour areas, defeating the
    // purpose of compression.
    let longest = decoded.width().max(decoded.height());
    let needs_resize = longest > max_edge;
    if !needs_resize {
        return (bytes.to_vec(), mime.to_string(), ext.to_string());
    }

    let resized = decoded.thumbnail(max_edge, max_edge);

    // JPEG encoder. JPEG doesn't support alpha — convert RGBA → RGB.
    let rgb = resized.to_rgb8();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    if rgb.write_with_encoder(encoder).is_err() {
        return (bytes.to_vec(), mime.to_string(), ext.to_string());
    }

    // Preserve EXIF: if the source was JPEG, splice its APP1 segment into
    // the new JPEG so date/GPS/camera tags survive the re-encode. Other
    // source formats (PNG, WebP, BMP, GIF) don't carry EXIF in a portable
    // way, so we accept the metadata loss.
    let final_bytes = if mime == "image/jpeg" {
        match splice_exif_into_jpeg(bytes, &out) {
            Some(merged) => merged,
            None => out,
        }
    } else {
        out
    };

    // If we re-encoded (i.e. wasn't already a within-bounds JPEG), the new
    // output is always JPEG — adjust mime + ext accordingly.
    (final_bytes, "image/jpeg".to_string(), "jpg".to_string())
}

/// Outcome of a successful `compress_to_fit` run — the bytes that should
/// be persisted, plus the MIME type and extension that describe them
/// (matching `compress_image`'s re-encode-to-JPEG behaviour).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressionOutcome {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub ext: String,
}

/// Reason `compress_to_fit` could not satisfy `limit_bytes`. Distinct
/// variants let the caller produce specific user-facing messages: the
/// "still too large" case (photo recompressed all the way down and still
/// over) is recoverable with a different limit, while "incompressible"
/// (HEIC/SVG/unknown MIME over the limit) cannot be helped by any ladder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompressToFitError {
    /// Even the (320, 40) floor produced bytes larger than `limit_bytes`.
    /// `final_bytes` is what that floor rung emitted, so the caller can
    /// report the achieved size alongside the configured limit.
    StillTooLarge { final_bytes: i64, limit_bytes: i64 },
    /// The input was a format `compress_image` only ever passes through
    /// unchanged (HEIC/HEIF, SVG, unknown/non-image MIME). `bytes` is the
    /// original input length — there is nothing to "achieve" here.
    Incompressible { bytes: i64, limit_bytes: i64 },
}

/// Fixed escalation ladder `compress_to_fit` walks when the user's
/// configured `CompressionMode` does not fit `limit_bytes`. Ordered from
/// least aggressive to most aggressive; the final entry is the floor.
const COMPRESS_FIT_LADDER: [(u32, u8); 5] =
    [(1600, 75), (1200, 65), (800, 55), (480, 45), (320, 40)];

/// Try to fit `bytes` under `limit_bytes` by running the user's configured
/// `mode` first, then walking a fixed `(max_edge, quality)` escalation
/// ladder until a rung fits. Returns the bytes / mime / ext that should
/// be persisted. Never up-scales: any ladder rung whose `max_edge` is not
/// smaller than the previously attempted one is skipped, so a `Custom`
/// mode narrower than a ladder rung is never widened.
///
/// When no rung fits, returns one of:
/// - `StillTooLarge` — the (320, 40) floor was reached and still over,
/// - `Incompressible` — `compress_image` cannot shrink this MIME at all
///   (HEIC/HEIF, SVG, unknown) and the original is over the limit.
///
/// Reuses `compress_image`'s actual encoder path so EXIF splicing and
/// re-encode-to-JPEG behaviour stay identical to the opportunistic path.
pub fn compress_to_fit(
    bytes: &[u8],
    mime: &str,
    ext: &str,
    mode: CompressionMode,
    limit_bytes: i64,
) -> Result<CompressionOutcome, CompressToFitError> {
    let input_len = bytes.len() as i64;

    // Detect formats compress_image only ever passes through unchanged.
    // If such a file is already over the limit, no ladder rung can help.
    let incompressible = mime == "image/heic"
        || mime == "image/heif"
        || !mime.starts_with("image/")
        || mime == "image/svg+xml";
    if incompressible && input_len > limit_bytes {
        return Err(CompressToFitError::Incompressible {
            bytes: input_len,
            limit_bytes,
        });
    }

    // First attempt: the user's configured mode.
    let (first_bytes, first_mime, first_ext) = compress_image(bytes, mime, ext, mode);
    if (first_bytes.len() as i64) <= limit_bytes {
        return Ok(CompressionOutcome {
            bytes: first_bytes,
            mime: first_mime,
            ext: first_ext,
        });
    }

    // Track the smallest max_edge we have already tried so we never
    // up-scale (a Custom { max_edge: 400, .. } must not be widened to
    // the 1600 rung). Start from the configured mode's effective edge.
    let mut last_max_edge = mode.params().map(|(e, _)| e);

    let mut last_bytes = first_bytes;

    for &(max_edge, quality) in COMPRESS_FIT_LADDER.iter() {
        // Skip rungs that would not shrink the image further.
        if let Some(prev) = last_max_edge {
            if max_edge >= prev {
                continue;
            }
        }

        let (out_bytes, out_mime, out_ext) = compress_image(
            bytes,
            mime,
            ext,
            CompressionMode::Custom { max_edge, quality },
        );
        last_max_edge = Some(max_edge);
        last_bytes = out_bytes;

        if (last_bytes.len() as i64) <= limit_bytes {
            return Ok(CompressionOutcome {
                bytes: last_bytes,
                mime: out_mime,
                ext: out_ext,
            });
        }
    }

    // The (320, 40) floor was reached and still over.
    Err(CompressToFitError::StillTooLarge {
        final_bytes: last_bytes.len() as i64,
        limit_bytes,
    })
}

/// Copy the APP1 (EXIF) segment from `source_jpeg` and inject it into
/// `target_jpeg` right after the SOI marker. Returns the merged JPEG on
/// success, `None` if either input doesn't look like a JPEG or no APP1
/// segment is found in the source.
///
/// JPEG layout: `FF D8` (SOI) then a sequence of segments, each `FF Mk
/// Len[2]` where `Mk` is the marker byte (e.g. `E1` for APP1) and `Len`
/// is the segment length INCLUDING those two length bytes. Standard EXIF
/// lives in the first APP1 segment, payload starts with `"Exif\0\0"`.
fn splice_exif_into_jpeg(source_jpeg: &[u8], target_jpeg: &[u8]) -> Option<Vec<u8>> {
    let exif_segment = find_exif_app1_segment(source_jpeg)?;
    // Target must also start with SOI. If anything looks wrong, bail.
    if target_jpeg.len() < 2 || target_jpeg[0] != 0xFF || target_jpeg[1] != 0xD8 {
        return None;
    }
    let mut out = Vec::with_capacity(target_jpeg.len() + exif_segment.len());
    out.extend_from_slice(&target_jpeg[..2]); // SOI
    out.extend_from_slice(exif_segment); // FF E1 .. + payload
    out.extend_from_slice(&target_jpeg[2..]);
    Some(out)
}

/// Locate the first APP1 segment whose payload begins with `Exif\0\0`.
/// Returns the segment slice including its `FF E1 Len[2]` header so the
/// caller can splice it verbatim.
fn find_exif_app1_segment(jpeg: &[u8]) -> Option<&[u8]> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xFF {
            return None;
        }
        let marker = jpeg[i + 1];
        // SOS marker — image data starts here; no more application segments.
        if marker == 0xDA {
            return None;
        }
        // Stand-alone markers (no length): SOI, EOI, RSTn. Skip those (unlikely
        // pre-SOS but the spec permits).
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let seg_len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if seg_len < 2 || i + 2 + seg_len > jpeg.len() {
            return None;
        }
        let payload_start = i + 4;
        let payload_end = i + 2 + seg_len;
        // APP1 with the standard EXIF magic bytes: "Exif\0\0"
        if marker == 0xE1 && payload_end - payload_start >= 6 {
            let payload = &jpeg[payload_start..payload_end];
            if payload.starts_with(b"Exif\x00\x00") {
                return Some(&jpeg[i..payload_end]);
            }
        }
        i = payload_end;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageFormat, Rgb};

    fn make_jpeg(w: u32, h: u32) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 200]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Jpeg)
            .unwrap();
        out
    }

    #[test]
    fn off_returns_input_verbatim() {
        let input = make_jpeg(4000, 3000);
        let (out, mime, ext) = compress_image(&input, "image/jpeg", "jpg", CompressionMode::Off);
        assert_eq!(out, input, "Off mode must pass bytes through unchanged");
        assert_eq!(mime, "image/jpeg");
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn standard_resizes_large_jpeg() {
        let input = make_jpeg(4000, 3000);
        let (out, mime, ext) =
            compress_image(&input, "image/jpeg", "jpg", CompressionMode::Standard);
        assert!(out.len() < input.len(), "compressed must be smaller");
        assert_eq!(mime, "image/jpeg");
        assert_eq!(ext, "jpg");
        // Decode and check max edge.
        let decoded = image::load_from_memory(&out).unwrap();
        assert!(decoded.width().max(decoded.height()) <= 2400);
    }

    #[test]
    fn standard_passes_small_jpeg_through() {
        let input = make_jpeg(800, 600);
        let (out, mime, ext) =
            compress_image(&input, "image/jpeg", "jpg", CompressionMode::Standard);
        assert_eq!(
            out, input,
            "below-threshold JPEG must pass through byte-equal"
        );
        assert_eq!(mime, "image/jpeg");
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn aggressive_caps_at_1600_quality_75() {
        let input = make_jpeg(4000, 4000);
        let (out, _, _) = compress_image(&input, "image/jpeg", "jpg", CompressionMode::Aggressive);
        let decoded = image::load_from_memory(&out).unwrap();
        assert!(decoded.width().max(decoded.height()) <= 1600);
    }

    #[test]
    fn custom_uses_user_params() {
        let input = make_jpeg(4000, 3000);
        let (out, _, _) = compress_image(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Custom {
                max_edge: 1024,
                quality: 60,
            },
        );
        let decoded = image::load_from_memory(&out).unwrap();
        assert!(decoded.width().max(decoded.height()) <= 1024);
    }

    #[test]
    fn heic_passes_through_untouched() {
        // Fake "HEIC" bytes — we don't try to decode, just pass through.
        let fake_heic = vec![0xAA, 0xBB, 0xCC, 0xDD];
        let (out, mime, ext) = compress_image(
            &fake_heic,
            "image/heic",
            "heic",
            CompressionMode::Aggressive,
        );
        assert_eq!(out, fake_heic);
        assert_eq!(mime, "image/heic");
        assert_eq!(ext, "heic");
    }

    #[test]
    fn invalid_bytes_pass_through() {
        let garbage = vec![1u8, 2, 3, 4, 5];
        let (out, mime, ext) =
            compress_image(&garbage, "image/jpeg", "jpg", CompressionMode::Standard);
        assert_eq!(out, garbage, "undecodable bytes must round-trip");
        assert_eq!(mime, "image/jpeg");
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn png_resized_becomes_jpeg() {
        // PNG large enough to trigger resize.
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(4000, 3000, |x, _| Rgb([(x % 256) as u8, 100, 50]));
        let mut input = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut input), ImageFormat::Png)
            .unwrap();
        let (out, mime, ext) =
            compress_image(&input, "image/png", "png", CompressionMode::Standard);
        assert_ne!(out, input, "PNG above threshold must be re-encoded");
        assert_eq!(mime, "image/jpeg", "PNG → JPEG on re-encode");
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn svg_passes_through_untouched() {
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'></svg>".to_vec();
        let (out, mime, ext) =
            compress_image(&svg, "image/svg+xml", "svg", CompressionMode::Aggressive);
        assert_eq!(out, svg);
        assert_eq!(mime, "image/svg+xml");
        assert_eq!(ext, "svg");
    }

    // ── EXIF preservation ────────────────────────────────────────────────────

    /// Build a minimal JPEG containing a fake APP1 EXIF segment + an actual
    /// JPEG image body. The APP1 payload is `Exif\0\0` followed by a TIFF
    /// header just long enough to satisfy the spec — the splice path only
    /// cares about the segment bytes, not their EXIF semantics.
    fn make_jpeg_with_exif(w: u32, h: u32) -> Vec<u8> {
        // Body JPEG without EXIF.
        let body = make_jpeg(w, h);
        // Synthesise an APP1 segment: FF E1 LEN[2] "Exif\0\0" + 10 padding bytes.
        let exif_payload = b"Exif\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00";
        // length = 2 (length field itself) + payload length
        let seg_len = (2 + exif_payload.len()) as u16;
        let mut app1 = Vec::with_capacity(4 + exif_payload.len());
        app1.push(0xFF);
        app1.push(0xE1);
        app1.extend_from_slice(&seg_len.to_be_bytes());
        app1.extend_from_slice(exif_payload);

        // Splice: SOI (FF D8) + APP1 + rest of body (skipping body's SOI).
        let mut out = Vec::with_capacity(body.len() + app1.len());
        out.extend_from_slice(&body[..2]); // SOI
        out.extend_from_slice(&app1);
        out.extend_from_slice(&body[2..]);
        out
    }

    #[test]
    fn finds_exif_app1_segment_in_source() {
        let input = make_jpeg_with_exif(800, 600);
        let segment = find_exif_app1_segment(&input).expect("must locate APP1");
        assert!(segment.starts_with(&[0xFF, 0xE1]));
        // Skip FF E1 LEN[2] header → payload begins with "Exif\0\0"
        assert!(&segment[4..10] == b"Exif\x00\x00");
    }

    #[test]
    fn returns_none_when_no_exif_in_jpeg() {
        let plain = make_jpeg(800, 600);
        assert!(find_exif_app1_segment(&plain).is_none());
    }

    #[test]
    fn compressed_jpeg_preserves_exif_segment() {
        let input = make_jpeg_with_exif(4000, 3000);
        let (out, _, _) = compress_image(&input, "image/jpeg", "jpg", CompressionMode::Standard);
        // Compressed output must still carry an APP1 EXIF segment.
        assert!(
            find_exif_app1_segment(&out).is_some(),
            "EXIF must survive the resize+re-encode cycle"
        );
    }

    // ── CompressionMode::from_settings ───────────────────────────────────────

    #[test]
    fn from_settings_defaults_to_standard_for_empty() {
        assert_eq!(
            CompressionMode::from_settings("", None, None),
            CompressionMode::Standard
        );
        assert_eq!(
            CompressionMode::from_settings("standard", None, None),
            CompressionMode::Standard
        );
    }

    #[test]
    fn from_settings_off_aggressive_custom() {
        assert_eq!(
            CompressionMode::from_settings("off", None, None),
            CompressionMode::Off
        );
        assert_eq!(
            CompressionMode::from_settings("aggressive", None, None),
            CompressionMode::Aggressive
        );
        assert_eq!(
            CompressionMode::from_settings("custom", Some(1024), Some(70)),
            CompressionMode::Custom {
                max_edge: 1024,
                quality: 70
            }
        );
    }

    #[test]
    fn from_settings_custom_clamps_out_of_range_values() {
        let mode = CompressionMode::from_settings("custom", Some(10), Some(200));
        let CompressionMode::Custom { max_edge, quality } = mode else {
            panic!("expected Custom variant");
        };
        assert!(max_edge >= 320, "max_edge clamped to lower bound");
        assert!(quality <= 100, "quality clamped to upper bound");
    }

    // ── compress_to_fit ──────────────────────────────────────────────────────

    /// An image already under `limit_bytes` returns on the first attempt
    /// (no ladder rung is exercised). We assert this by making the input
    /// already-fit and checking the output byte length is the same as a
    /// single `compress_image` call would produce — never re-encoded twice.
    #[test]
    fn compress_to_fit_already_under_limit_first_attempt() {
        let input = make_jpeg(4000, 3000);
        // Standard mode produces a comfortably small JPEG (~250 KB for
        // this synthetic input). Use a generous limit so the first
        // attempt fits and no ladder rung runs.
        let standard = compress_image(&input, "image/jpeg", "jpg", CompressionMode::Standard);
        let limit = standard.0.len() as i64;
        let outcome = compress_to_fit(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Standard,
            limit,
        )
        .expect("already-fits must succeed");
        assert_eq!(outcome.bytes, standard.0, "no extra encode expected");
        assert_eq!(outcome.mime, "image/jpeg");
        assert_eq!(outcome.ext, "jpg");
    }

    /// A large image that does not fit under the configured mode but
    /// lands on a middle ladder rung (here: the (800, 55) rung, because
    /// the limit is tight enough to skip (1600,75) and (1200,65) but
    /// loose enough to fit at 800 px).
    #[test]
    fn compress_to_fit_lands_on_middle_rung() {
        let input = make_jpeg(4000, 3000);
        // Tighten the limit until the (800, 55) rung is the first that
        // fits: walk down the ladder and pick a limit strictly between
        // the (1200, 65) and (800, 55) output sizes.
        let r1600 = compress_image(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Custom {
                max_edge: 1600,
                quality: 75,
            },
        )
        .0
        .len() as i64;
        let r1200 = compress_image(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Custom {
                max_edge: 1200,
                quality: 65,
            },
        )
        .0
        .len() as i64;
        let r800 = compress_image(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Custom {
                max_edge: 800,
                quality: 55,
            },
        )
        .0
        .len() as i64;
        // Sanity: ladder ordering holds for this synthetic input.
        assert!(r1200 <= r1600, "ladder must be monotonic for test input");
        assert!(r800 <= r1200, "ladder must be monotonic for test input");
        // Pick a limit strictly between r1200 (too big) and r800 (fits).
        let limit = (r1200 + r800) / 2;
        assert!(r1200 > limit, "limit must reject the 1200 rung");
        assert!(r800 <= limit, "limit must accept the 800 rung");

        let outcome = compress_to_fit(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Standard,
            limit,
        )
        .expect("middle rung must fit");
        assert!(
            (outcome.bytes.len() as i64) <= limit,
            "outcome must satisfy the limit"
        );
        // The winning edge must be 800 (since 1600 and 1200 are skipped
        // only when they fail, and 480/320 are not reached).
        let decoded = image::load_from_memory(&outcome.bytes).expect("must decode");
        assert!(
            decoded.width().max(decoded.height()) <= 800,
            "must have landed at or below the 800 rung"
        );
        assert!(
            decoded.width().max(decoded.height()) > 480,
            "must NOT have dropped to the 480 rung"
        );
    }

    /// Pathological case: limit so tight that even the (320, 40) floor
    /// exceeds it. Must return `StillTooLarge` with the floor's output
    /// length, never panic, and the loop must terminate.
    #[test]
    fn compress_to_fit_hits_floor_and_returns_still_too_large() {
        let input = make_jpeg(4000, 3000);
        let floor = compress_image(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Custom {
                max_edge: 320,
                quality: 40,
            },
        )
        .0
        .len() as i64;
        // Demand 1 byte fewer than the floor produces — impossible.
        let limit = floor - 1;
        let err = compress_to_fit(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Standard,
            limit,
        )
        .expect_err("floor must not fit");
        match err {
            CompressToFitError::StillTooLarge {
                final_bytes,
                limit_bytes,
            } => {
                assert_eq!(limit_bytes, limit);
                assert_eq!(final_bytes, floor, "final_bytes must be the floor output");
            }
            other => panic!("expected StillTooLarge, got {other:?}"),
        }
    }

    /// Incompressible MIME (HEIC) over the limit returns `Incompressible`
    /// rather than running any ladder rung — there is nothing to encode.
    #[test]
    fn compress_to_fit_incompressible_mime_over_limit() {
        let fake_heic = vec![0xAAu8; 1024];
        let limit = 512i64;
        let err = compress_to_fit(
            &fake_heic,
            "image/heic",
            "heic",
            CompressionMode::Aggressive,
            limit,
        )
        .expect_err("HEIC over limit is incompressible");
        match err {
            CompressToFitError::Incompressible { bytes, limit_bytes } => {
                assert_eq!(bytes, 1024, "bytes must be the original input length");
                assert_eq!(limit_bytes, limit);
            }
            other => panic!("expected Incompressible, got {other:?}"),
        }
    }

    /// A `Custom` mode narrower than the first ladder rung (max_edge 400,
    /// below the 1600 first rung) must not be widened: the 1600/1200/800
    /// rungs are all skipped because they would up-scale relative to the
    /// configured 400 px. The first ladder rung actually exercised is
    /// (320, 40), and the function must not panic or grow the image.
    #[test]
    fn compress_to_fit_custom_narrower_than_rung_not_widened() {
        let input = make_jpeg(4000, 3000);
        let custom_edge = 400u32;
        // Force the configured Custom mode to NOT fit (tight limit), so
        // the ladder runs. Then assert that no rung with max_edge > 400
        // was applied — i.e. the smallest produced edge is at most 320.
        let custom_out = compress_image(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Custom {
                max_edge: custom_edge,
                quality: 60,
            },
        )
        .0;
        // Tight limit so we drop all the way to the floor.
        let floor = compress_image(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Custom {
                max_edge: 320,
                quality: 40,
            },
        )
        .0;
        // Limit between the custom output and the floor — exercises at
        // least the (320, 40) rung, never the 1600 rung.
        let limit = custom_out.len().min(floor.len()) as i64 - 1;

        let err = compress_to_fit(
            &input,
            "image/jpeg",
            "jpg",
            CompressionMode::Custom {
                max_edge: custom_edge,
                quality: 60,
            },
            limit,
        );
        // We expect the floor to be hit (StillTooLarge) — the ladder ran,
        // but no rung widened the image. If the function had widened to
        // 1600/1200/800/480, the outcome could have been Ok or a larger
        // final_bytes; the assertions below pin the no-widening contract.
        match err {
            Err(CompressToFitError::StillTooLarge { final_bytes, .. }) => {
                assert_eq!(
                    final_bytes,
                    floor.len() as i64,
                    "floor output must come from the (320, 40) rung, not a wider one"
                );
            }
            Ok(outcome) => {
                // If somehow Ok, the produced edge must be ≤ 320 (never
                // widened above the configured 400).
                let decoded = image::load_from_memory(&outcome.bytes).expect("must decode");
                let edge = decoded.width().max(decoded.height());
                assert!(
                    edge <= 320,
                    "must not up-scale: got edge {edge} > 320 from a Custom(400) start"
                );
            }
            other => panic!("expected StillTooLarge or Ok, got {other:?}"),
        }
    }
}
