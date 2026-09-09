//! Search filter types shared across FTS5 keyword search and semantic search.
//!
//! These types are serialised / deserialised from the Tauri command layer and
//! are intentionally kept separate from `queries.rs` so that `db::embeddings`
//! (and future modules) can import them without a circular dependency.

use serde::Deserialize;

// ─── Types ───────────────────────────────────────────────────────────────────

/// The 3 emotion keys recognised by the DB layer. Matches the TS
/// `EmotionKey` union in `src/types/entry.ts` and the backend
/// validator in `db::queries::update_entry_emotion`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Hash)]
pub enum EmotionKey {
    #[serde(rename = "bad")]
    Bad,
    #[serde(rename = "neutral")]
    Neutral,
    #[serde(rename = "good")]
    Good,
}

impl EmotionKey {
    pub fn as_str(self) -> &'static str {
        match self {
            EmotionKey::Bad => "bad",
            EmotionKey::Neutral => "neutral",
            EmotionKey::Good => "good",
        }
    }
}

/// Aggregated filter parameters that can be applied to both keyword search and
/// semantic search.  Every field is optional; `None` (or an empty `Vec`) means
/// "no restriction on this dimension".
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    pub time_range: Option<TimeRangeFilter>,
    pub journal_ids: Option<Vec<String>>,
    pub tag_ids: Option<Vec<String>>,
    pub emotions: Option<Vec<EmotionKey>>,
    pub has_media: Option<HasMediaFilter>,
}

impl SearchFilters {
    /// Returns `true` when no filter would actually restrict the result set.
    ///
    /// An empty `Vec` is treated as "no filter" so the frontend can send arrays
    /// unconditionally without semantic surprises.
    pub fn is_empty(&self) -> bool {
        self.time_range.is_none()
            && self.journal_ids.as_ref().map_or(true, |v| v.is_empty())
            && self.tag_ids.as_ref().map_or(true, |v| v.is_empty())
            && self.emotions.as_ref().map_or(true, |v| v.is_empty())
            && self.has_media.is_none()
    }
}

/// Inclusive start / exclusive end date range expressed as **Unix seconds**
/// (matches the `entries.entry_date` column). The frontend converts its
/// `TimeRange` ADT via `timeRangeBounds()` in
/// `src/lib/entryFilterSort.ts`, which already produces seconds.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimeRangeFilter {
    pub from: i64,
    pub to_exclusive: i64,
}

/// Whether an entry must have attached media or must have none.
///
/// The variant is named `None_` (with a trailing underscore) to avoid
/// shadowing `Option::None`.  The serde wire name is `"none"` — no underscore.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub enum HasMediaFilter {
    #[serde(rename = "has")]
    Has,
    #[serde(rename = "none")]
    None_,
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emotion_key_deserializes_lowercase_strings() {
        assert_eq!(
            serde_json::from_str::<EmotionKey>("\"good\"").unwrap(),
            EmotionKey::Good
        );
        assert_eq!(
            serde_json::from_str::<EmotionKey>("\"bad\"").unwrap(),
            EmotionKey::Bad
        );
        assert_eq!(
            serde_json::from_str::<EmotionKey>("\"neutral\"").unwrap(),
            EmotionKey::Neutral
        );
    }

    #[test]
    fn emotion_key_rejects_unknown_string() {
        assert!(serde_json::from_str::<EmotionKey>("\"happy\"").is_err());
    }

    #[test]
    fn emotion_key_rejects_capitalised_string() {
        assert!(serde_json::from_str::<EmotionKey>("\"Good\"").is_err());
    }

    #[test]
    fn searchfilters_with_invalid_emotion_fails_to_deserialize() {
        let result = serde_json::from_str::<SearchFilters>(r#"{"emotions":["bad","wrong"]}"#);
        assert!(result.is_err());
    }

    #[test]
    fn searchfilters_default_is_empty() {
        assert!(SearchFilters::default().is_empty());
    }

    #[test]
    fn searchfilters_is_empty_treats_empty_vec_as_no_filter() {
        let f = SearchFilters {
            journal_ids: Some(vec![]),
            ..Default::default()
        };
        assert!(f.is_empty());
    }

    #[test]
    fn searchfilters_with_time_range_is_not_empty() {
        let f = SearchFilters {
            time_range: Some(TimeRangeFilter {
                from: 0,
                to_exclusive: 1_000,
            }),
            ..Default::default()
        };
        assert!(!f.is_empty());
    }

    #[test]
    fn searchfilters_with_one_journal_is_not_empty() {
        let f = SearchFilters {
            journal_ids: Some(vec!["a".into()]),
            ..Default::default()
        };
        assert!(!f.is_empty());
    }

    /// Confirm that "Any" (no media filter) is represented by `has_media: None`.
    /// The frontend simply omits `hasMedia` from the JSON payload.
    #[test]
    fn searchfilters_with_has_media_any_uses_none_field() {
        let f = SearchFilters {
            has_media: None,
            ..Default::default()
        };
        assert!(f.has_media.is_none());
        assert!(f.is_empty());
    }

    #[test]
    fn searchfilters_deserializes_from_camelcase_json() {
        let json = r#"{"journalIds":["a","b"],"hasMedia":"has"}"#;
        let f: SearchFilters = serde_json::from_str(json).unwrap();
        assert_eq!(f.journal_ids, Some(vec!["a".to_string(), "b".to_string()]));
        assert_eq!(f.has_media, Some(HasMediaFilter::Has));
        assert!(f.time_range.is_none());
    }

    #[test]
    fn has_media_none_serde_name() {
        let json = r#"{"hasMedia":"none"}"#;
        let f: SearchFilters = serde_json::from_str(json).unwrap();
        assert_eq!(f.has_media, Some(HasMediaFilter::None_));
    }
}
