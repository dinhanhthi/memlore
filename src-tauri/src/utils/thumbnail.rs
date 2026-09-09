//! Thumbnail generation for image media.
//!
//! Pure in-memory function: raw image bytes (any format `image` crate supports)
//! → resized JPEG bytes. Used by `pick_image` to generate a preview thumbnail
//! stored beside the original, and synced eagerly to the cloud (path suffix
//! `.thumb`) so the gallery renders fast without downloading full media.

use image::ImageReader;
use std::io::Cursor;

/// Default thumbnail options. 512 px on the longest edge, JPEG quality 80 —
/// matches the Chunk 6b plan.
pub const DEFAULT_MAX_EDGE: u32 = 512;
pub const DEFAULT_JPEG_QUALITY: u8 = 80;

/// MIME types we generate thumbnails for. Other types (SVG, unknown) fall
/// back to the original file (no thumbnail).
///
/// HEIC/HEIF (common iPhone paste) is intentionally excluded — the `image`
/// crate has no default-features decoder for it. When iPhone → Memlore
/// paste becomes a hot path, add `image` feature `heif` (non-trivial C deps
/// required) and append `"image/heic" | "image/heif"` here.
pub fn supports_thumbnail(mime: &str) -> bool {
    matches!(
        mime,
        "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp"
    )
}

/// Generate a JPEG thumbnail from raw image bytes.
///
/// - `max_edge`: the longer dimension of the output. The shorter edge is
///   scaled proportionally to preserve aspect ratio.
/// - Returns encoded JPEG bytes.
///
/// Fails only when the input cannot be decoded as an image.
pub fn generate_thumbnail(
    bytes: &[u8],
    max_edge: u32,
    jpeg_quality: u8,
) -> Result<Vec<u8>, String> {
    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("thumbnail: guess format: {e}"))?
        .decode()
        .map_err(|e| format!("thumbnail: decode: {e}"))?;

    // Never upscale: if both dimensions already fit, use the original size.
    // `DynamicImage::thumbnail` upscales small images, so clamp max_edge to
    // the longer source edge before calling it.
    let longest = img.width().max(img.height());
    let target = max_edge.min(longest);
    let thumb = img.thumbnail(target, target);

    // Encode as JPEG. JPEG doesn't support alpha, so convert RGBA → RGB.
    let rgb = thumb.to_rgb8();

    let mut out = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, jpeg_quality);
    rgb.write_with_encoder(encoder)
        .map_err(|e| format!("thumbnail: encode: {e}"))?;

    // Expected upper bound: 512 px at q=80 for an adversarial flat image stays
    // well under 1 MB. A larger output means someone bumped the defaults (e.g.
    // q=95 or max_edge=2048) without revisiting the LRU cache assumptions that
    // treat thumbnails as "tiny and always keepable". Debug-only so releases
    // never panic on a surprise input.
    debug_assert!(
        out.len() < 1_048_576,
        "thumbnail exceeded 1 MB ({} bytes) — revisit DEFAULT_MAX_EDGE / DEFAULT_JPEG_QUALITY",
        out.len()
    );

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageFormat, Rgb};

    /// Build a test PNG of the given dimensions.
    fn test_png(w: u32, h: u32) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn generates_jpeg_under_max_edge_for_landscape() {
        let input = test_png(2000, 1000);
        let thumb = generate_thumbnail(&input, 512, 80).unwrap();

        // Decode the result and verify dimensions.
        let decoded = image::load_from_memory(&thumb).expect("thumb decodes");
        assert!(
            decoded.width() <= 512 && decoded.height() <= 512,
            "thumb must fit within max_edge: got {}x{}",
            decoded.width(),
            decoded.height()
        );
        // Long edge should be exactly max_edge.
        assert_eq!(decoded.width(), 512);
    }

    #[test]
    fn generates_jpeg_under_max_edge_for_portrait() {
        let input = test_png(1000, 2000);
        let thumb = generate_thumbnail(&input, 512, 80).unwrap();
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert!(decoded.width() <= 512 && decoded.height() <= 512);
        assert_eq!(decoded.height(), 512);
    }

    #[test]
    fn preserves_aspect_ratio() {
        let input = test_png(2000, 1000); // 2:1
        let thumb = generate_thumbnail(&input, 512, 80).unwrap();
        let decoded = image::load_from_memory(&thumb).unwrap();
        // 2:1 → 512:256 (±1 pixel rounding).
        let ratio = decoded.width() as f32 / decoded.height() as f32;
        assert!(
            (ratio - 2.0).abs() < 0.05,
            "aspect ratio should be preserved (~2.0), got {ratio}"
        );
    }

    #[test]
    fn small_image_is_not_upscaled() {
        let input = test_png(100, 50);
        let thumb = generate_thumbnail(&input, 512, 80).unwrap();
        let decoded = image::load_from_memory(&thumb).unwrap();
        // `thumbnail()` never upscales — output must be <= input.
        assert!(decoded.width() <= 100);
        assert!(decoded.height() <= 50);
    }

    #[test]
    fn output_is_jpeg_format() {
        let input = test_png(200, 200);
        let thumb = generate_thumbnail(&input, 128, 80).unwrap();
        // JPEG files start with FF D8 FF magic bytes.
        assert_eq!(&thumb[..3], &[0xFF, 0xD8, 0xFF]);
    }

    #[test]
    fn rejects_invalid_image_bytes() {
        let result = generate_thumbnail(b"not an image", 512, 80);
        assert!(result.is_err());
    }

    #[test]
    fn supports_thumbnail_recognises_image_mimes() {
        assert!(supports_thumbnail("image/jpeg"));
        assert!(supports_thumbnail("image/png"));
        assert!(supports_thumbnail("image/gif"));
        assert!(supports_thumbnail("image/webp"));
        assert!(supports_thumbnail("image/bmp"));
    }

    #[test]
    fn supports_thumbnail_rejects_non_image_mimes() {
        assert!(!supports_thumbnail("image/svg+xml"));
        assert!(!supports_thumbnail("application/octet-stream"));
        assert!(!supports_thumbnail("video/mp4"));
        assert!(!supports_thumbnail(""));
    }

    #[test]
    fn different_quality_produces_different_output_size() {
        let input = test_png(500, 500);
        let hi = generate_thumbnail(&input, 256, 95).unwrap();
        let lo = generate_thumbnail(&input, 256, 30).unwrap();
        // Lower quality → smaller file.
        assert!(
            lo.len() < hi.len(),
            "lower JPEG quality should produce smaller output: hi={} lo={}",
            hi.len(),
            lo.len()
        );
    }
}
