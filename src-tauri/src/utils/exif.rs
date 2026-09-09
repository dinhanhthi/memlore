use serde::{Deserialize, Serialize};

/// Metadata extracted from an image's EXIF data.
/// All fields are optional — not every image has EXIF, and not every EXIF
/// tag is present in every image.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExifData {
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    /// Unix timestamp extracted from EXIF DateTimeOriginal (seconds since epoch).
    pub date: Option<i64>,
    /// Camera model string from EXIF Model tag.
    pub camera: Option<String>,
    /// Intrinsic pixel width — read from EXIF `PixelXDimension` (preferred) or
    /// `ImageWidth` (TIFF/IFD0). Works for HEIC where `image` crate cannot
    /// decode the container. Falls back to `None` when neither tag is set.
    pub width: Option<u32>,
    /// Intrinsic pixel height — read from EXIF `PixelYDimension` or
    /// `ImageLength`. See `width` for rationale.
    pub height: Option<u32>,
}

/// Convert GPS degrees/minutes/seconds rational values to decimal degrees.
/// Returns None if any rational component is zero-denominator (invalid).
fn dms_to_decimal(rationals: &[exif::Rational]) -> Option<f64> {
    if rationals.len() < 3 {
        return None;
    }
    let degrees = rational_to_f64(rationals[0])?;
    let minutes = rational_to_f64(rationals[1])?;
    let seconds = rational_to_f64(rationals[2])?;
    Some(degrees + minutes / 60.0 + seconds / 3600.0)
}

fn rational_to_f64(r: exif::Rational) -> Option<f64> {
    if r.denom == 0 {
        return None;
    }
    Some(r.num as f64 / r.denom as f64)
}

/// Parse an EXIF datetime string of the form "YYYY:MM:DD HH:MM:SS" into a
/// Unix timestamp (seconds since epoch). Returns None on parse failure.
///
/// **Note:** EXIF DateTimeOriginal does not include timezone information.
/// This function treats the time as UTC, which may be off by several hours
/// from the actual local time the photo was taken. For more precise timestamps,
/// consider using GPSDateStamp/GPSTimeStamp tags when available (always UTC).
fn parse_exif_datetime(s: &str) -> Option<i64> {
    // Format: "YYYY:MM:DD HH:MM:SS"
    let s = s.trim();
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s[0..4].parse().ok()?;
    let month: i64 = s[5..7].parse().ok()?;
    let day: i64 = s[8..10].parse().ok()?;
    let hour: i64 = s[11..13].parse().ok()?;
    let min: i64 = s[14..16].parse().ok()?;
    let sec: i64 = s[17..19].parse().ok()?;

    // Simplified Julian Day calculation then convert to unix time.
    // Using the standard Julian Day Number formula.
    let a = (14 - month) / 12;
    let y = year + 4800 - a;
    let m = month + 12 * a - 3;
    let jdn = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    // Unix epoch is Julian Day 2440588
    let days_since_epoch = jdn - 2_440_588;
    let secs = days_since_epoch * 86400 + hour * 3600 + min * 60 + sec;
    Some(secs)
}

/// Extract EXIF metadata from the image at `path`.
///
/// This function never returns an `Err` for files that simply lack EXIF data —
/// in that case it returns `Ok(ExifData { .. all None .. })`.
/// Errors are only returned for I/O failures (file not found, permission denied,
/// etc.).
pub fn extract_exif(path: &std::path::Path) -> Result<ExifData, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bufreader = std::io::BufReader::new(file);

    let exif_reader = exif::Reader::new();
    let exif = match exif_reader.read_from_container(&mut bufreader) {
        Ok(e) => e,
        // No EXIF at all — return all-None result (not an error)
        Err(_) => {
            return Ok(ExifData {
                latitude: None,
                longitude: None,
                date: None,
                camera: None,
                width: None,
                height: None,
            })
        }
    };

    // ── GPS latitude ─────────────────────────────────────────────────────────
    let latitude =
        {
            let lat_val = exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY);
            let lat_ref = exif.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY);
            match (lat_val, lat_ref) {
                (Some(lat_field), Some(ref_field)) => {
                    let rationals = match &lat_field.value {
                        exif::Value::Rational(v) => Some(v.as_slice()),
                        _ => None,
                    };
                    let ref_str = ref_field.value.display_as(ref_field.tag).to_string();
                    rationals.and_then(dms_to_decimal).map(|d| {
                        if ref_str.contains('S') {
                            -d
                        } else {
                            d
                        }
                    })
                }
                _ => None,
            }
        };

    // ── GPS longitude ────────────────────────────────────────────────────────
    let longitude =
        {
            let lon_val = exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY);
            let lon_ref = exif.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY);
            match (lon_val, lon_ref) {
                (Some(lon_field), Some(ref_field)) => {
                    let rationals = match &lon_field.value {
                        exif::Value::Rational(v) => Some(v.as_slice()),
                        _ => None,
                    };
                    let ref_str = ref_field.value.display_as(ref_field.tag).to_string();
                    rationals.and_then(dms_to_decimal).map(|d| {
                        if ref_str.contains('W') {
                            -d
                        } else {
                            d
                        }
                    })
                }
                _ => None,
            }
        };

    // ── DateTimeOriginal ─────────────────────────────────────────────────────
    let date = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .and_then(|f| match &f.value {
            exif::Value::Ascii(v) => v.first().and_then(|bytes| {
                std::str::from_utf8(bytes)
                    .ok()
                    .and_then(parse_exif_datetime)
            }),
            _ => None,
        });

    // ── Camera model ─────────────────────────────────────────────────────────
    let camera = exif
        .get_field(exif::Tag::Model, exif::In::PRIMARY)
        .and_then(|f| match &f.value {
            exif::Value::Ascii(v) => v.first().and_then(|bytes| {
                std::str::from_utf8(bytes)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            }),
            _ => None,
        });

    // ── Pixel dimensions ─────────────────────────────────────────────────────
    // Prefer EXIF/IFD `PixelXDimension`/`PixelYDimension` (set by Camera apps,
    // present in JPEG/HEIC). Fall back to TIFF `ImageWidth`/`ImageLength`
    // (set on raw and some scanner output). Both are reported as integer Long
    // or Short values per spec; tolerate either.
    let width = read_u32_tag(&exif, exif::Tag::PixelXDimension)
        .or_else(|| read_u32_tag(&exif, exif::Tag::ImageWidth));
    let height = read_u32_tag(&exif, exif::Tag::PixelYDimension)
        .or_else(|| read_u32_tag(&exif, exif::Tag::ImageLength));

    Ok(ExifData {
        latitude,
        longitude,
        date,
        camera,
        width,
        height,
    })
}

/// Read an integer-valued EXIF tag (Short or Long) and return it as `u32`.
/// Returns `None` if the tag is absent or has a non-integer value type.
fn read_u32_tag(exif: &exif::Exif, tag: exif::Tag) -> Option<u32> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    match &field.value {
        exif::Value::Long(v) => v.first().copied(),
        exif::Value::Short(v) => v.first().copied().map(|n| n as u32),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extract_exif_returns_all_none_for_plain_jpeg() {
        // Create a minimal JPEG-like file with no EXIF data
        let dir = std::env::temp_dir();
        let path = dir.join("test_no_exif.jpg");
        let mut f = std::fs::File::create(&path).unwrap();
        // Minimal JPEG header (SOI marker)
        f.write_all(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]).unwrap();
        drop(f);

        let result = extract_exif(&path).unwrap();
        assert!(result.latitude.is_none());
        assert!(result.longitude.is_none());
        assert!(result.date.is_none());
        assert!(result.camera.is_none());
        assert!(result.width.is_none());
        assert!(result.height.is_none());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn extract_exif_returns_error_for_nonexistent_file() {
        let path = std::path::Path::new("/tmp/memlore_nonexistent_12345.jpg");
        let result = extract_exif(path);
        assert!(result.is_err(), "should error on missing file");
    }

    #[test]
    fn parse_exif_datetime_parses_valid_string() {
        // "2023:06:15 14:30:00" → should be some unix timestamp
        let ts = parse_exif_datetime("2023:06:15 14:30:00");
        assert!(ts.is_some());
        // Rough sanity check: should be in 2023 range
        let val = ts.unwrap();
        assert!(val > 1_680_000_000, "should be after 2023-03-28");
        assert!(val < 1_710_000_000, "should be before 2024-03-10");
    }

    #[test]
    fn parse_exif_datetime_returns_none_for_invalid_string() {
        assert!(parse_exif_datetime("not-a-date").is_none());
        assert!(parse_exif_datetime("").is_none());
        assert!(parse_exif_datetime("2023-06-15").is_none()); // Wrong separator
    }

    #[test]
    fn dms_to_decimal_converts_correctly() {
        // 37° 46' 26.52" N => 37 + 46/60 + 26.52/3600
        let rationals = vec![
            exif::Rational { num: 37, denom: 1 },
            exif::Rational { num: 46, denom: 1 },
            exif::Rational {
                num: 2652,
                denom: 100,
            },
        ];
        let result = dms_to_decimal(&rationals).unwrap();
        let expected = 37.0 + 46.0 / 60.0 + 26.52 / 3600.0;
        assert!((result - expected).abs() < 1e-6);
    }

    #[test]
    fn dms_to_decimal_returns_none_for_zero_denom() {
        let rationals = vec![
            exif::Rational { num: 0, denom: 0 }, // invalid
            exif::Rational { num: 0, denom: 1 },
            exif::Rational { num: 0, denom: 1 },
        ];
        assert!(dms_to_decimal(&rationals).is_none());
    }

    #[test]
    fn dms_to_decimal_returns_none_for_short_slice() {
        let rationals = vec![exif::Rational { num: 37, denom: 1 }];
        assert!(dms_to_decimal(&rationals).is_none());
    }
}
