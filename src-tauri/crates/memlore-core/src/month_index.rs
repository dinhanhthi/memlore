//! Per-month entry index and its catalog (read by the web, written by desktop).
//!
//! `MonthIndexPayload` lists the entries of one UTC month (`"YYYY-MM"`) so the
//! web can render lists without opening every entry file. `MonthIndexCatalog`
//! (`index/months.bin`, written last) lists every month with a content hash so
//! the web can revalidate cached months cheaply. Both are JSON sealed like the
//! other device-root bins (`envelope::open_device_bin`).
//!
//! Read-only and lenient: no `deny_unknown_fields`, and every non-identity field
//! is `#[serde(default)]`, so a newer writer can add fields without breaking an
//! older reader.

use serde::{Deserialize, Serialize};

use crate::metadata::SyncMediaItem;

/// Schema version written into both payloads.
pub const MONTH_INDEX_SCHEMA_VERSION: u16 = 1;

/// One month of entries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonthIndexPayload {
    pub schema_version: u16,
    pub device_id: String,
    /// `"YYYY-MM"`, see [`month_key`].
    pub month: String,
    #[serde(default)]
    pub generated_at: i64,
    #[serde(default)]
    pub rows: Vec<MonthIndexRow>,
}

/// List-view summary of one entry. Field names mirror `EntryMetadata`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonthIndexRow {
    pub entry_id: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub entry_date: i64,
    #[serde(default)]
    pub journal_id: String,
    #[serde(default)]
    pub emotion: Option<String>,
    #[serde(default)]
    pub is_favorite: bool,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub word_count: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub preview_text: Option<String>,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    #[serde(default)]
    pub location_label: Option<String>,
    #[serde(default)]
    pub media: Vec<SyncMediaItem>,
    #[serde(default)]
    pub versions: Vec<MonthIndexVersionRef>,
}

/// Pointer to one version file of the entry (`<device>/versions/<id>.bin`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonthIndexVersionRef {
    pub version_id: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub created_at: i64,
}

/// Catalog of every month index (`index/months.bin`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonthIndexCatalog {
    pub schema_version: u16,
    pub device_id: String,
    #[serde(default)]
    pub generated_at: i64,
    #[serde(default)]
    pub months: Vec<MonthIndexCatalogMonth>,
}

/// One catalog line: month, hash of its index plaintext, row count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonthIndexCatalogMonth {
    pub month: String,
    #[serde(default)]
    pub hash_hex: String,
    #[serde(default)]
    pub row_count: u64,
}

/// UTC month bucket `"YYYY-MM"` of a unix timestamp in seconds. Floors toward
/// negative infinity, so pre-1970 instants land in the right month
/// (`-1` → `"1969-12"`). No chrono: civil-from-days (H. Hinnant).
pub fn month_key(entry_date_secs: i64) -> String {
    let days = entry_date_secs.div_euclid(86_400);
    let (year, month) = civil_year_month(days);
    format!("{year:04}-{month:02}")
}

/// True for the names `index/` may hold: a `<YYYY-MM>.bin` month file or the
/// `months.bin` catalog. Anything else in that folder is a stray to ignore.
pub fn is_month_index_file_name(name: &str) -> bool {
    match name.strip_suffix(".bin") {
        Some("months") => true,
        Some(stem) => is_month_key(stem),
        None => false,
    }
}

/// True for a `"YYYY-MM"` month key as produced by [`month_key`] (shape only).
pub fn is_month_key(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || c.is_ascii_digit())
}

/// Year and month (1-12) of a day count since 1970-01-01 (proleptic Gregorian).
fn civil_year_month(days: i64) -> (i64, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], March-based
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media() -> SyncMediaItem {
        SyncMediaItem {
            id: "media-12345678".to_string(),
            file_name: "a.jpg".to_string(),
            file_type: "image/jpeg".to_string(),
            file_size: Some(10),
            sort_order: 0,
            created_at: 1,
            insertion_mode: "inline".to_string(),
            width: Some(2),
            height: Some(3),
            duration_seconds: None,
            exif_date: None,
            exif_latitude: Some(1.5),
            exif_longitude: None,
        }
    }

    fn row() -> MonthIndexRow {
        MonthIndexRow {
            entry_id: "entry-12345678".to_string(),
            updated_at: 1_700_000_100,
            entry_date: 1_700_000_000,
            journal_id: "journal-12345678".to_string(),
            emotion: Some("good".to_string()),
            is_favorite: true,
            tag_ids: vec!["tag-12345678".to_string()],
            word_count: 42,
            title: Some("Title".to_string()),
            preview_text: Some("Preview".to_string()),
            latitude: Some(10.5),
            longitude: Some(-3.25),
            location_label: Some("Hanoi".to_string()),
            media: vec![media()],
            versions: vec![MonthIndexVersionRef {
                version_id: "version-12345678".to_string(),
                device_id: "device-a".to_string(),
                created_at: 1_700_000_050,
            }],
        }
    }

    #[test]
    fn payload_round_trips() {
        let p = MonthIndexPayload {
            schema_version: MONTH_INDEX_SCHEMA_VERSION,
            device_id: "device-a".to_string(),
            month: "2023-11".to_string(),
            generated_at: 1_700_000_200,
            rows: vec![row()],
        };
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(serde_json::from_str::<MonthIndexPayload>(&json).unwrap(), p);
    }

    #[test]
    fn catalog_round_trips() {
        let c = MonthIndexCatalog {
            schema_version: MONTH_INDEX_SCHEMA_VERSION,
            device_id: "device-a".to_string(),
            generated_at: 5,
            months: vec![MonthIndexCatalogMonth {
                month: "2023-11".to_string(),
                hash_hex: "ab".repeat(32),
                row_count: 3,
            }],
        };
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(serde_json::from_str::<MonthIndexCatalog>(&json).unwrap(), c);
    }

    #[test]
    fn unknown_fields_ignored_and_optional_fields_default() {
        let p: MonthIndexPayload = serde_json::from_str(
            r#"{"schema_version":1,"device_id":"d","month":"2024-02","future":true,
                "rows":[{"entry_id":"entry-12345678","new_field":[1,2],
                         "versions":[{"version_id":"v","extra":0}]}]}"#,
        )
        .unwrap();
        assert_eq!(p.generated_at, 0);
        let r = &p.rows[0];
        assert_eq!(r.entry_id, "entry-12345678");
        assert_eq!((r.word_count, r.is_favorite), (0, false));
        assert!(r.title.is_none() && r.media.is_empty() && r.tag_ids.is_empty());
        assert_eq!(r.versions[0].version_id, "v");

        let c: MonthIndexCatalog = serde_json::from_str(
            r#"{"schema_version":1,"device_id":"d","x":1,"months":[{"month":"2024-02","y":2}]}"#,
        )
        .unwrap();
        assert_eq!(c.months[0].row_count, 0);
        assert_eq!(c.months[0].hash_hex, "");
    }

    #[test]
    fn identity_fields_are_required() {
        assert!(serde_json::from_str::<MonthIndexRow>("{}").is_err());
        assert!(serde_json::from_str::<MonthIndexPayload>(
            r#"{"schema_version":1,"device_id":"d"}"#
        )
        .is_err());
    }

    #[test]
    fn month_index_file_name_accepts_months_and_catalog_only() {
        for ok in ["2026-01.bin", "1969-12.bin", "months.bin"] {
            assert!(is_month_index_file_name(ok), "{ok}");
        }
        for bad in [
            "junk.bin",
            "2026-1.bin",
            "2026-01",
            "months",
            "2026_01.bin",
            "2026-01.bin.tmp",
            "x2026-01.bin",
            "",
        ] {
            assert!(!is_month_index_file_name(bad), "{bad}");
        }
        assert!(is_month_key("2026-01"));
        assert!(!is_month_key("catalog"));
        assert!(!is_month_key("fingerprint"));
    }

    #[test]
    fn month_key_utc_boundaries() {
        assert_eq!(month_key(0), "1970-01");
        assert_eq!(month_key(2_678_399), "1970-01"); // 1970-01-31T23:59:59Z
        assert_eq!(month_key(2_678_400), "1970-02");
        // Leap day 2024-02-29 and the switch to March.
        assert_eq!(month_key(1_709_251_199), "2024-02"); // 2024-02-29T23:59:59Z
        assert_eq!(month_key(1_709_251_200), "2024-03");
        // Year boundary.
        assert_eq!(month_key(1_704_067_199), "2023-12"); // 2023-12-31T23:59:59Z
        assert_eq!(month_key(1_704_067_200), "2024-01");
        // Century non-leap: 2100-02-28T23:59:59Z then 2100-03-01.
        assert_eq!(month_key(4_107_542_399), "2100-02");
        assert_eq!(month_key(4_107_542_400), "2100-03");
    }

    #[test]
    fn month_key_pre_1970_floors() {
        assert_eq!(month_key(-1), "1969-12");
        assert_eq!(month_key(-86_400), "1969-12");
        assert_eq!(month_key(-2_678_400), "1969-12"); // 1969-12-01T00:00:00Z
        assert_eq!(month_key(-2_678_401), "1969-11");
        assert_eq!(month_key(-2_208_988_800), "1900-01"); // 1900-01-01T00:00:00Z
                                                          // Extremes must not panic.
        let _ = month_key(i64::MIN);
        let _ = month_key(i64::MAX);
    }
}
