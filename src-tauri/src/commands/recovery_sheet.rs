//! Recovery sheet (Phase 4, Group A of the E2EE rewrite): render the 24-word
//! recovery phrase as a printable PDF sheet (text + QR) and decode a phrase
//! back out of that PDF (its embedded QR image) or a scanned/exported QR image.
//!
//! # Why the mnemonic is always a function argument, never a lookup
//!
//! The app never persists the mnemonic beyond two short-lived windows —
//! `pending_first_time_setup.mnemonic` during onboarding and
//! `ROTATION_NEW_RECOVERY_MNEMONIC_STASH` during a rotation (both cleared on
//! confirmation; see the `pending_first_time_setup` table in `db/schema.rs`). `render_recovery_sheet` therefore
//! takes the mnemonic as a plain argument — the caller (the reveal screen,
//! which already holds it in memory for that one screen) supplies it. There
//! is no command here that reads a mnemonic from the DB or the boot file,
//! and none should ever be added: `recovery_wrapped` is
//! `AES-GCM(recovery_key, master)`, derived FROM the phrase, so the cloud
//! keyring cannot yield it back either. See `docs/how-sync-and-encryption-work.md` §1.9.
//!
//! # QR payload
//!
//! The QR encodes the plain BIP39 mnemonic string, byte-for-byte — no
//! envelope, no version prefix. BIP39's own checksum already rejects a
//! corrupt or foreign scan with a clean error via
//! `crate::utils::recovery::validate_recovery_mnemonic`.
//!
//! # Validation scope
//!
//! `decode_recovery_qr_image` only proves the QR payload is a *syntactically
//! valid* BIP39 phrase. It deliberately does NOT check the phrase against any
//! cloud vault — that would duplicate `onboard_validate_passphrase_inner`.
//! The frontend feeds the decoded string into the existing
//! `onboard_validate_passphrase` command for the cloud fingerprint check.

// `Cursor` is only needed for PNG encoding, which is now test-only (the PDF
// sheet embeds the QR from raw pixels, not a PNG).
#[cfg(test)]
use std::io::Cursor;

use image::{ImageBuffer, Luma};
use printpdf::{
    BuiltinFont, Mm, Op, PdfDocument, PdfFontHandle, PdfPage, PdfSaveOptions, Point, Pt, RawImage,
    RawImageData, RawImageFormat, TextItem, XObjectTransform,
};
use qrcode::QrCode;

/// Render a self-contained, printable recovery sheet for `mnemonic`.
///
/// Returns PDF bytes (starting with `%PDF-`): the 24 words as text, the
/// plaintext-ownership warning, and a QR code of the same mnemonic string
/// embedded from raw greyscale pixels (no external assets, no bundled font —
/// only built-in PDF fonts are used, so the file opens and prints
/// standalone). The caller is responsible for writing the bytes wherever the
/// user chooses via a save dialog; this function never touches disk.
#[tauri::command]
pub fn render_recovery_sheet(mnemonic: String) -> Result<Vec<u8>, String> {
    // Canonicalize through the same parser used everywhere else in the
    // codebase, so the printed words and the QR payload are guaranteed
    // byte-identical regardless of how the caller formatted the input.
    let parsed = crate::utils::recovery::validate_recovery_mnemonic(&mnemonic)
        .map_err(|e| format!("render_recovery_sheet: invalid mnemonic: {e}"))?;
    let canonical = parsed.words().collect::<Vec<_>>().join(" ");
    let words: Vec<&str> = parsed.words().collect();

    let mut doc = PdfDocument::new("Memlore recovery sheet");

    // QR embedded from raw Luma pixels — R8 maps to DeviceGray, one byte per
    // pixel. Deliberately NOT via printpdf's own image decoder (that feature
    // is off to avoid a second `image` crate version; see Cargo.toml).
    let qr = render_qr_luma(&canonical)?;
    let (qr_w, qr_h) = qr.dimensions();
    let qr_image = RawImage {
        pixels: RawImageData::U8(qr.into_raw()),
        width: qr_w as usize,
        height: qr_h as usize,
        data_format: RawImageFormat::R8,
        tag: Vec::new(),
    };
    let qr_id = doc.add_image(&qr_image);

    // A4 page, origin at the bottom-left (printpdf convention).
    const PAGE_W: f32 = 210.0;
    const PAGE_H: f32 = 297.0;

    let mut ops: Vec<Op> = Vec::new();

    // ── Title ────────────────────────────────────────────────────────────
    push_text_block(
        &mut ops,
        &["Memlore recovery phrase"],
        Mm(20.0),
        Mm(PAGE_H - 22.0),
        BuiltinFont::HelveticaBold,
        Pt(18.0),
        Pt(22.0),
    );

    // ── Plaintext-ownership warning (keep the phrase "owns your journal") ──
    let warning = [
        "Anyone who has these 24 words -- and access to your Google Drive --",
        "owns your journal. Store this sheet like cash: keep it offline, tell",
        "no one, and never let a photo or scan of it land in a synced photo",
        "library or cloud drive. This file is a copy of the one secret you",
        "already have, not a second one; it does not make your journal safer.",
    ];
    push_text_block(
        &mut ops,
        &warning,
        Mm(20.0),
        Mm(PAGE_H - 38.0),
        BuiltinFont::Helvetica,
        Pt(11.0),
        Pt(15.0),
    );

    // ── 24 words in a 4-column grid, one text section per column so the
    //    cursor never accumulates drift across columns (each column's first
    //    SetTextCursor is an absolute position from the page origin). ───────
    const COLS: usize = 4;
    const ROWS: usize = 6;
    let col_x = [20.0f32, 68.0, 116.0, 164.0];
    let grid_top = PAGE_H - 78.0;
    let row_step = 10.0f32;
    for col in 0..COLS {
        let lines: Vec<String> = (0..ROWS)
            .filter_map(|row| {
                let idx = col * ROWS + row;
                words.get(idx).map(|w| format!("{:>2}. {w}", idx + 1))
            })
            .collect();
        let line_refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        push_text_block(
            &mut ops,
            &line_refs,
            Mm(col_x[col]),
            Mm(grid_top),
            BuiltinFont::Courier,
            Pt(12.0),
            Pt(row_step * 2.834_646), // mm → pt for the line height
        );
    }

    // ── Full phrase, no numbering, below the grid ─────────────────────────
    // The numbered grid above is for reading/checking word-by-word; this
    // block prints the same 24 words as one continuous, space-separated
    // string so the whole phrase can be copied or transcribed in one go.
    // Anchored at 150 mm — safely below the grid (~159 mm bottom) and well
    // above the footer (20 mm), clear of the top-right QR.
    push_text_block(
        &mut ops,
        &["Full phrase"],
        Mm(20.0),
        Mm(150.0),
        BuiltinFont::HelveticaBold,
        Pt(11.0),
        Pt(13.0),
    );
    // Split across 3 lines of 8 words: even the longest BIP39 words (8 chars)
    // keep each line well inside the ~170 mm text column at 10 pt Helvetica,
    // so the string never runs off the page edge.
    let phrase_lines: Vec<String> = words.chunks(8).map(|chunk| chunk.join(" ")).collect();
    let phrase_refs: Vec<&str> = phrase_lines.iter().map(String::as_str).collect();
    push_text_block(
        &mut ops,
        &phrase_refs,
        Mm(20.0),
        Mm(143.0),
        BuiltinFont::Helvetica,
        Pt(10.0),
        Pt(14.0),
    );

    // ── QR image, floated in the top-right corner ─────────────────────────
    // At the default 300 DPI, a ~57-module QR at 8px/module renders roughly
    // 40 mm square. Anchored with a 20 mm margin from the top and right edges,
    // it sits beside the title/warning block (which stays left-aligned and
    // narrower than the gap to the QR) and above the word grid.
    let qr_pt_w = Pt(qr_w as f32 / 300.0 * 72.0);
    let qr_side_mm = qr_pt_w.0 / 2.834_646;
    let qr_left = Mm(PAGE_W - 20.0 - qr_side_mm);
    let qr_bottom = Mm(PAGE_H - 20.0 - qr_side_mm);
    ops.push(Op::UseXobject {
        id: qr_id,
        transform: XObjectTransform {
            translate_x: Some(qr_left.into()),
            translate_y: Some(qr_bottom.into()),
            ..Default::default()
        },
    });

    // ── Caption (page footer) ─────────────────────────────────────────────
    push_text_block(
        &mut ops,
        &["The QR code encodes the same 24 words, and nothing else."],
        Mm(20.0),
        Mm(20.0),
        BuiltinFont::Helvetica,
        Pt(10.0),
        Pt(12.0),
    );

    let page = PdfPage::new(Mm(PAGE_W), Mm(PAGE_H), ops);
    let bytes = doc
        .with_pages(vec![page])
        .save(&PdfSaveOptions::default(), &mut Vec::new());
    Ok(bytes)
}

/// Emit one printpdf text section: a single absolute `SetTextCursor` at
/// (`x`, `y`) followed by each line in `lines`, dropping `line_height` between
/// them. One section per block keeps the relative text-cursor moves from
/// accumulating across independent blocks.
fn push_text_block(
    ops: &mut Vec<Op>,
    lines: &[&str],
    x: Mm,
    y: Mm,
    font: BuiltinFont,
    size: Pt,
    line_height: Pt,
) {
    ops.push(Op::StartTextSection);
    ops.push(Op::SetFont {
        font: PdfFontHandle::Builtin(font),
        size,
    });
    ops.push(Op::SetLineHeight { lh: line_height });
    ops.push(Op::SetTextCursor {
        pos: Point::new(x, y),
    });
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            ops.push(Op::AddLineBreak);
        }
        ops.push(Op::ShowText {
            items: vec![TextItem::Text((*line).to_string())],
        });
    }
    ops.push(Op::EndTextSection);
}

/// Render `mnemonic` (already-canonical, space-separated words) as a QR code
/// into a greyscale pixel buffer. Shared by both the PNG encoder (QR
/// round-trip / decode reuse) and the PDF sheet's raw-pixel image embed.
fn render_qr_luma(mnemonic: &str) -> Result<ImageBuffer<Luma<u8>, Vec<u8>>, String> {
    let code = QrCode::new(mnemonic.as_bytes()).map_err(|e| format!("QR encode failed: {e}"))?;
    Ok(code.render::<Luma<u8>>().module_dimensions(8, 8).build())
}

/// Encode `mnemonic` (already-canonical, space-separated words) as a QR code
/// and return PNG-encoded bytes. Test-only: the PDF sheet embeds the QR from
/// raw pixels (`render_qr_luma`), so the PNG form is exercised solely by the
/// QR round-trip and file-decode tests.
#[cfg(test)]
fn encode_mnemonic_qr_png(mnemonic: &str) -> Result<Vec<u8>, String> {
    let image = render_qr_luma(mnemonic)?;

    let mut png_bytes = Vec::new();
    image::DynamicImage::ImageLuma8(image)
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("QR PNG encode failed: {e}"))?;
    Ok(png_bytes)
}

/// Decode a recovery phrase from a QR code found in `image_bytes` (e.g. a
/// photo or screenshot of an exported recovery sheet).
///
/// Image decode is the only path this phase implements — camera capture is
/// out of scope (see phase plan). Returns a clean error, never a panic, for:
/// an unreadable/garbage image, an image with no QR code in it, or a QR
/// whose payload fails the BIP39 checksum (wrong word count, tampered word,
/// foreign non-recovery-phrase QR).
#[tauri::command]
pub fn decode_recovery_qr_image(image_bytes: Vec<u8>) -> Result<String, String> {
    decode_mnemonic_from_qr_image(&image_bytes)
}

/// Decode a recovery phrase from a file the user picked in the native open
/// dialog — either the **recovery-sheet PDF** itself or an image (screenshot /
/// photo) of the QR.
///
/// # Why the PDF is read directly
///
/// The sheet is a PDF, so "screenshot the QR and import the screenshot" would
/// be the only image path — but the QR is a small square on a full A4 page, and
/// `rqrr` reliably detects a QR only when it fills a decent fraction of the
/// image. So when the picked file is a PDF, the QR image XObject is pulled back
/// out at its full embedded resolution and decoded from that, instead of
/// forcing a lossy full-page screenshot. Plain image files still take the
/// direct decode path.
///
/// # Why a path variant exists
///
/// The frontend has no way to turn a picked path into bytes: this app
/// deliberately does not ship `tauri-plugin-fs` (see `stats_export.rs`), and
/// the only other byte-returning commands are scoped to the app's own media
/// rows or the temp dir. Rather than add a generic "read any file" IPC
/// primitive — an arbitrary-file-read capability handed to the webview, for
/// the sake of one import button — the read happens here and only the decoded
/// mnemonic crosses the boundary. Nothing else about the file is observable to
/// the caller.
///
/// Byte-for-byte the same validation as `decode_recovery_qr_image`: BIP39
/// syntax only, no cloud check (see the module docs).
#[tauri::command]
pub fn decode_recovery_qr_file(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Image path is empty".to_string());
    }

    // Enforce the cap *while* reading, not after: `fs::read` would allocate a
    // multi-GB file (or spin forever on `/dev/zero`) before the check below
    // ever ran. `take(MAX + 1)` bounds the allocation and still leaves one
    // byte of headroom to tell "exactly at the cap" from "over it". Reading
    // rather than trusting `metadata().len()` also covers files whose
    // reported size lies (character devices, pipes, files being appended to).
    use std::io::Read;
    let file = std::fs::File::open(trimmed).map_err(|e| format!("Could not open image: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_QR_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not open image: {e}"))?;
    if bytes.len() > MAX_QR_IMAGE_BYTES {
        return Err(format!(
            "Image is too large (over {MAX_QR_IMAGE_BYTES} bytes); a recovery-sheet QR is only a few kilobytes"
        ));
    }

    if bytes.starts_with(b"%PDF-") {
        decode_mnemonic_from_pdf(&bytes)
    } else {
        decode_mnemonic_from_qr_image(&bytes)
    }
}

/// Pull the recovery phrase out of a recovery-sheet PDF by extracting its
/// embedded QR image XObject and decoding that. The sheet embeds the QR as a
/// raw 8-bit DeviceGray image (`printpdf` `RawImage`/R8), so the samples come
/// back out as one grey byte per pixel at full resolution.
///
/// Iterates every image XObject and returns on the first one that decodes to a
/// valid BIP39 phrase, so a future sheet with more than one image still works.
/// Never panics: a malformed PDF, a missing/oddly-encoded image, or a
/// size-mismatched sample buffer all fall through to a clean error.
fn decode_mnemonic_from_pdf(pdf_bytes: &[u8]) -> Result<String, String> {
    let doc =
        lopdf::Document::load_mem(pdf_bytes).map_err(|e| format!("Could not read PDF: {e}"))?;

    let mut last_err = "No QR code found in the recovery-sheet PDF".to_string();
    for (_id, object) in doc.objects.iter() {
        let Ok(stream) = object.as_stream() else {
            continue;
        };
        let is_image = stream
            .dict
            .get(b"Subtype")
            .ok()
            .and_then(|o| o.as_name().ok())
            .map(|n| n == b"Image")
            .unwrap_or(false);
        if !is_image {
            continue;
        }
        let width = stream.dict.get(b"Width").ok().and_then(|o| o.as_i64().ok());
        let height = stream
            .dict
            .get(b"Height")
            .ok()
            .and_then(|o| o.as_i64().ok());
        let (Some(width), Some(height)) = (width, height) else {
            continue;
        };
        if width <= 0 || height <= 0 {
            continue;
        }
        // The picked PDF is an untrusted file: an image XObject could carry a
        // FlateDecode "zip bomb" (a few KB inflating to gigabytes). A raw
        // DeviceGray QR is exactly W×H bytes, so bound BOTH the declared size
        // and the actual inflate to that budget. Checking `/Width`×`/Height`
        // alone is not enough — the decompressed length is independent of the
        // declared dimensions, so a 1×1 image with a huge stream would still
        // OOM `decompressed_content`. `decode_image_stream_bounded` inflates
        // through a `.take(expected + 1)` reader instead, so nothing larger
        // than one sane image is ever materialised.
        let pixels = (width as u64).saturating_mul(height as u64);
        if pixels == 0 || pixels > MAX_PDF_IMAGE_PIXELS {
            continue;
        }
        let expected = pixels as usize;
        let Some(data) = decode_image_stream_bounded(stream, expected) else {
            continue;
        };
        let Some(img) = image::GrayImage::from_raw(width as u32, height as u32, data) else {
            // Sample count doesn't match W×H — not a raw DeviceGray image we
            // can interpret (e.g. an RGB or JPEG-encoded XObject). Skip it.
            continue;
        };
        match decode_mnemonic_from_luma(img) {
            Ok(mnemonic) => return Ok(mnemonic),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// Return the raw sample bytes of a PDF image `stream`, inflating **at most**
/// `expected + 1` bytes so a hostile FlateDecode stream cannot balloon memory
/// (lopdf's own `decompressed_content` has no output cap). Returns `None` — so
/// the caller skips the image — for any filter we don't handle, a decode error,
/// or a byte count that isn't exactly `expected` (the size `from_raw` needs).
///
/// Only the two encodings a recovery-sheet QR can actually use are handled:
/// `FlateDecode` (what `printpdf` writes) and no filter (uncompressed inline
/// samples). LZW/DCT/etc. are treated as "not our QR" and skipped.
fn decode_image_stream_bounded(stream: &lopdf::Stream, expected: usize) -> Option<Vec<u8>> {
    use std::io::Read;

    // `/Filter` may be a bare name or a one-element array of names.
    let filter = stream.dict.get(b"Filter").ok().and_then(|o| {
        o.as_name()
            .ok()
            .or_else(|| o.as_array().ok()?.first()?.as_name().ok())
    });

    let data = match filter {
        Some(name) if name == b"FlateDecode" => {
            let mut out = Vec::new();
            flate2::read::ZlibDecoder::new(stream.content.as_slice())
                .take(expected as u64 + 1)
                .read_to_end(&mut out)
                .ok()?;
            out
        }
        None => stream.content.clone(),
        _ => return None,
    };

    (data.len() == expected).then_some(data)
}

/// A QR of a 24-word phrase is a few KB. `image`'s default cap is 512 MB,
/// which is far more than this input ever needs and still lets a thin
/// adversarial image force a large transient allocation. Reject early —
/// cheap defence in depth on the paths that accept arbitrary user input.
const MAX_QR_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// Upper bound on the pixel count of an image XObject we will decompress out of
/// an imported PDF. A recovery-sheet QR is ~0.2 MP; 16 MP is a generous ceiling
/// that still refuses to inflate a crafted zip-bomb image stream. Checked from
/// the declared `/Width`×`/Height` *before* `decompressed_content` allocates.
const MAX_PDF_IMAGE_PIXELS: u64 = 16 * 1024 * 1024;

fn decode_mnemonic_from_qr_image(image_bytes: &[u8]) -> Result<String, String> {
    if image_bytes.len() > MAX_QR_IMAGE_BYTES {
        return Err(format!(
            "Image is too large ({} bytes); a recovery-sheet QR is only a few kilobytes",
            image_bytes.len()
        ));
    }

    let img = image::load_from_memory(image_bytes)
        .map_err(|e| format!("Could not read image: {e}"))?
        .to_luma8();

    decode_mnemonic_from_luma(img)
}

/// Detect and decode a QR from an already-decoded greyscale image, then
/// validate its payload as a BIP39 recovery phrase. Shared by the image-file
/// path (`decode_mnemonic_from_qr_image`) and the PDF path
/// (`decode_mnemonic_from_pdf`).
fn decode_mnemonic_from_luma(img: image::GrayImage) -> Result<String, String> {
    let mut prepared = rqrr::PreparedImage::prepare(img);
    let grids = prepared.detect_grids();
    let grid = grids
        .first()
        .ok_or_else(|| "No QR code found in image".to_string())?;
    let (_meta, content) = grid
        .decode()
        .map_err(|e| format!("Could not decode QR code: {e}"))?;

    let parsed = crate::utils::recovery::validate_recovery_mnemonic(&content)
        .map_err(|e| format!("QR code does not contain a valid recovery phrase: {e}"))?;

    Ok(parsed.words().collect::<Vec<_>>().join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── The sheet renders as a real, non-trivial PDF ─────────────────────────
    //
    // The sheet is a flate-compressed PDF, so its text is NOT byte-greppable —
    // asserting the words / warning phrase against the raw bytes would always
    // fail. The security-relevant assertion (the QR carries the exact phrase)
    // lives in the decoupled `qr_png_round_trips_to_the_exact_mnemonic` test
    // below, which does not depend on the sheet's format at all.
    #[test]
    fn render_produces_a_non_trivial_pdf() {
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let sheet = render_recovery_sheet((*mnemonic).clone()).unwrap();

        assert!(
            sheet.starts_with(b"%PDF-"),
            "recovery sheet must be a PDF (start with the %PDF- header)"
        );
        // A one-page A4 sheet with a QR image and 30-odd text lines is several
        // KB minimum; anything under 1 KB means the render silently produced an
        // empty document.
        assert!(
            sheet.len() > 1024,
            "recovery sheet PDF is implausibly small ({} bytes)",
            sheet.len()
        );
    }

    // ── QR round-trip, decoupled from the sheet format ───────────────────────
    //
    // Proves the security-relevant property directly: the QR encoder and the
    // QR decoder are exact inverses over a real mnemonic. Independent of
    // whether the sheet is HTML, PDF, or anything else.
    #[test]
    fn qr_png_round_trips_to_the_exact_mnemonic() {
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let qr_png = encode_mnemonic_qr_png(&mnemonic).unwrap();
        let decoded = decode_mnemonic_from_qr_image(&qr_png).unwrap();

        assert_eq!(
            decoded, *mnemonic,
            "the QR PNG must decode back to the exact mnemonic"
        );
    }

    #[test]
    fn render_rejects_invalid_mnemonic() {
        let result = render_recovery_sheet("not a valid bip39 phrase at all".to_string());
        assert!(result.is_err(), "invalid mnemonic must be rejected");
    }

    // ── A3: tampered QR fails the BIP39 checksum ─────────────────────────────

    #[test]
    fn qr_of_tampered_mnemonic_fails_checksum_with_clean_error() {
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let mut words: Vec<&str> = mnemonic.split_whitespace().collect();
        // The final word carries 3 entropy bits + 8 checksum bits, so swapping
        // it for one other word leaves a ~1-in-256 chance the phrase is STILL
        // valid — a test that fails a few times per thousand CI runs. Search
        // for a replacement that is definitely rejected, then assert the
        // precondition, so the real assertion below can never pass by luck.
        let original_last = words[23];
        let tampered = ["abandon", "zoo", "ability", "zone", "able"]
            .iter()
            .filter(|w| **w != original_last)
            .map(|w| {
                words[23] = w;
                words.join(" ")
            })
            .find(|candidate| {
                crate::utils::recovery::validate_recovery_mnemonic(candidate).is_err()
            })
            .expect("at least one single-word swap must break the BIP39 checksum");
        assert!(
            crate::utils::recovery::validate_recovery_mnemonic(&tampered).is_err(),
            "precondition: the tampered phrase must be checksum-invalid, or this test proves nothing"
        );

        // Build the QR directly (bypassing render_recovery_sheet's own
        // validation, which would correctly refuse to render this) to
        // simulate an attacker-supplied or corrupted sheet.
        let qr_png = encode_mnemonic_qr_png(&tampered).unwrap();

        let result = decode_mnemonic_from_qr_image(&qr_png);
        assert!(
            result.is_err(),
            "a QR encoding a checksum-invalid mnemonic must be rejected"
        );
        let err = result.unwrap_err();
        assert!(
            !err.to_lowercase().contains("panic"),
            "error must be clean, not a panic message: {err}"
        );
    }

    // ── A3: garbage / non-QR image yields a clean error, not a panic ────────

    #[test]
    fn garbage_bytes_yield_clean_error_not_panic() {
        let result = decode_mnemonic_from_qr_image(b"this is not an image at all");
        assert!(result.is_err(), "garbage bytes must yield a clean error");
    }

    #[test]
    fn valid_image_with_no_qr_code_yields_clean_error_not_panic() {
        // A plain white 64x64 PNG — a valid image, but no QR code in it.
        let blank = image::GrayImage::from_pixel(64, 64, image::Luma([255u8]));
        let mut png_bytes = Vec::new();
        image::DynamicImage::ImageLuma8(blank)
            .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .unwrap();

        let result = decode_mnemonic_from_qr_image(&png_bytes);
        assert!(
            result.is_err(),
            "a valid image with no QR code must yield a clean error, not panic"
        );
    }

    // ── Path variant: read-then-decode for the join flow's file import ──────

    /// Write `bytes` to a fresh temp path and return it.
    fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("memlore-qr-import-{}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p.push(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn decode_from_file_reads_a_qr_png_back() {
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        // Build the QR PNG directly (not by extracting it from the sheet), so
        // the file-decode path no longer depends on the sheet's format.
        let qr_png = encode_mnemonic_qr_png(&mnemonic).unwrap();
        let path = write_tmp("sheet-qr.png", &qr_png);

        let decoded = decode_recovery_qr_file(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(decoded, *mnemonic);
    }

    #[test]
    fn decode_from_pdf_sheet_reads_the_embedded_qr_back() {
        // The end-to-end join path: render the real recovery-sheet PDF, then
        // import it straight back — the embedded QR image must decode to the
        // exact 24 words, with no screenshotting/cropping in between.
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let pdf = render_recovery_sheet((*mnemonic).clone()).unwrap();
        assert!(pdf.starts_with(b"%PDF-"), "sheet must be a PDF");
        let path = write_tmp("sheet.pdf", &pdf);

        let decoded = decode_recovery_qr_file(path.to_string_lossy().into_owned()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            decoded, *mnemonic,
            "importing the recovery-sheet PDF must yield the exact mnemonic"
        );
    }

    #[test]
    fn decode_from_pdf_without_a_qr_yields_clean_error_not_panic() {
        use lopdf::dictionary;
        // A minimal valid PDF that carries no image XObject. Must report a
        // clean "no QR" error, never panic.
        let mut doc = lopdf::Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        doc.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        let mut pdf = Vec::new();
        doc.save_to(&mut pdf).unwrap();

        let path = write_tmp("no-qr.pdf", &pdf);
        let err = decode_recovery_qr_file(path.to_string_lossy().into_owned()).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(
            !err.to_lowercase().contains("panic"),
            "error must be clean: {err}"
        );
        assert!(
            err.to_lowercase().contains("no qr code"),
            "a PDF with no QR must say so: {err}"
        );
    }

    #[test]
    fn decode_from_pdf_bounds_a_flate_bomb_image_and_yields_clean_error() {
        use lopdf::dictionary;
        use std::io::Write;
        // A 1x1-declared image whose FlateDecode stream inflates to 50 MB of
        // zeros — a miniature zip bomb. The pixel-count guard passes (1 px), so
        // this is the case that proves the *decompression* itself is bounded:
        // `decode_image_stream_bounded` must stop after ~2 bytes and skip the
        // image, never materialising the 50 MB, and the overall result is a
        // clean "no QR" error rather than an OOM.
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&vec![0u8; 50 * 1024 * 1024]).unwrap();
        let compressed = encoder.finish().unwrap();
        assert!(
            compressed.len() < MAX_QR_IMAGE_BYTES,
            "compressed bomb must fit under the read cap to be a realistic input"
        );

        let mut doc = lopdf::Document::with_version("1.5");
        let img_id = doc.add_object(lopdf::Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
                "Filter" => "FlateDecode",
            },
            compressed,
        ));
        let page_id = doc.add_object(dictionary! { "Type" => "Page" });
        // Reference the image so it survives any prune-on-save.
        doc.objects.insert(
            page_id,
            lopdf::Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => img_id } },
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog" });
        doc.trailer.set("Root", catalog_id);
        let mut pdf = Vec::new();
        doc.save_to(&mut pdf).unwrap();

        let path = write_tmp("flate-bomb.pdf", &pdf);
        let err = decode_recovery_qr_file(path.to_string_lossy().into_owned()).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(
            err.to_lowercase().contains("no qr code"),
            "a bomb image must be skipped and reported as no-QR: {err}"
        );
    }

    #[test]
    fn decode_from_file_rejects_a_missing_path() {
        let mut missing = std::env::temp_dir();
        missing.push("memlore-qr-import-does-not-exist.png");
        let _ = std::fs::remove_file(&missing);

        let err = decode_recovery_qr_file(missing.to_string_lossy().into_owned()).unwrap_err();
        assert!(
            err.contains("Could not open image"),
            "missing file must be reported as an open failure: {err}"
        );
    }

    #[test]
    fn decode_from_file_rejects_an_empty_path() {
        let err = decode_recovery_qr_file("   ".to_string()).unwrap_err();
        assert!(err.to_lowercase().contains("empty"), "{err}");
    }

    /// The size cap must bite before the file is materialised in memory —
    /// `fs::read` would have allocated the whole thing first. Uses a real
    /// oversized file (cap + 1 byte) and asserts the "too large" rejection,
    /// which only the pre-read guard in `decode_recovery_qr_file` can produce:
    /// the bytes never reach `decode_mnemonic_from_qr_image`.
    #[test]
    fn decode_from_file_rejects_a_file_over_the_size_cap_without_reading_it_all() {
        let oversized = vec![0u8; MAX_QR_IMAGE_BYTES + 1];
        let path = write_tmp("oversized-qr.png", &oversized);

        let err = decode_recovery_qr_file(path.to_string_lossy().into_owned()).unwrap_err();
        let _ = std::fs::remove_file(&path);

        // Assert the *pre-read* guard's wording ("over N bytes"), not just
        // "too large": reading the whole file first and letting
        // `decode_mnemonic_from_qr_image` reject it also says "too large", so
        // only this exact shape proves the cap ran before the allocation.
        assert!(
            err.contains("too large (over "),
            "an oversized file must be rejected before it is read into memory: {err}"
        );
    }

    /// A file exactly at the cap is not rejected by the size guard — it gets
    /// as far as image decoding (and fails there, as garbage bytes should).
    /// Guards the boundary against an off-by-one in the `take(MAX + 1)` read.
    #[test]
    fn decode_from_file_accepts_a_file_exactly_at_the_size_cap() {
        let at_cap = vec![0u8; MAX_QR_IMAGE_BYTES];
        let path = write_tmp("at-cap-qr.png", &at_cap);

        let err = decode_recovery_qr_file(path.to_string_lossy().into_owned()).unwrap_err();
        let _ = std::fs::remove_file(&path);

        assert!(
            !err.contains("too large"),
            "a file exactly at the cap must not trip the size guard: {err}"
        );
    }

    #[test]
    fn decode_from_file_rejects_a_file_that_is_not_an_image() {
        let path = write_tmp("not-an-image.png", b"definitely not a PNG");
        let err = decode_recovery_qr_file(path.to_string_lossy().into_owned()).unwrap_err();
        assert!(
            !err.to_lowercase().contains("panic"),
            "error must be clean: {err}"
        );
    }

    // ── A3: a different vault's valid phrase fails fingerprint verification ─
    // (same outcome as a typed wrong phrase — proves the QR path does not
    // bypass onboard_validate_passphrase_inner's cloud check)

    #[tokio::test]
    async fn qr_of_different_vaults_valid_phrase_fails_fingerprint_verification() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::io::{write_meta, write_recovery};
        use crate::sync::keyring_v2::types::{KeyringMetaV2, RecoverySlotV2, KEYRING_V2_VERSION};
        use crate::utils::encryption::{encrypt_data, key_fingerprint};
        use crate::utils::recovery::{derive_recovery_key, validate_recovery_mnemonic};

        // Vault A: the real vault, wrapped under mnemonic_a.
        let master_a = [0xABu8; 32];
        let mnemonic_a = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let parsed_a = validate_recovery_mnemonic(&mnemonic_a).unwrap();
        let recovery_key_a = derive_recovery_key(&parsed_a);
        let wrapped_a = encrypt_data(&*recovery_key_a, &master_a[..]).unwrap();

        let provider = InMemoryKeyringProvider::new();
        write_recovery(
            &provider,
            &RecoverySlotV2 {
                version: KEYRING_V2_VERSION,
                wrapped_master: hex::encode(&wrapped_a),
                created_at: 0,
            },
        )
        .await
        .unwrap();
        write_meta(
            &provider,
            &KeyringMetaV2 {
                version: KEYRING_V2_VERSION,
                epoch: 1,
                master_fingerprint: hex::encode(key_fingerprint(&master_a)),
                content_epoch: 0,
                recovery_generation: 0,
                created_at: 0,
                updated_at: 0,
            },
        )
        .await
        .unwrap();

        // Vault B: a completely different, unrelated vault's valid phrase.
        let mnemonic_b = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let qr_png = encode_mnemonic_qr_png(&mnemonic_b).unwrap();

        // Decode succeeds (it IS a syntactically valid BIP39 phrase)...
        let decoded = decode_mnemonic_from_qr_image(&qr_png).unwrap();

        // ...but feeding it into the EXISTING cloud validation path must fail
        // the same way a typed wrong phrase does — no second, weaker route.
        let result =
            crate::commands::crypto::onboard_validate_passphrase_inner(&provider, &decoded).await;
        assert!(
            result.is_err(),
            "a different vault's valid phrase must fail fingerprint verification"
        );
    }
}
