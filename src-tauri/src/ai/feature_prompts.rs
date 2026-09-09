//! Default system prompts + per-feature override resolution.
//!
//! Keeps hardcoded defaults in one place so `commands/ai.rs` only needs
//! thin call-site swaps. User overrides live in `settings` as
//! `ai_{feature}_system_prompt` rows (empty = use default).

use crate::ai::provider::settings_keys;
use crate::db;
use rusqlite::Connection;

/// Features whose system prompt can be overridden from Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeaturePromptKind {
    TitleSuggestions,
    EntryHighlights,
    MultiEntrySummary,
    GoDeeper,
}

impl FeaturePromptKind {
    pub fn wire_id(self) -> &'static str {
        match self {
            Self::TitleSuggestions => "title_suggestions",
            Self::EntryHighlights => "entry_highlights",
            Self::MultiEntrySummary => "multi_entry_summary",
            Self::GoDeeper => "go_deeper",
        }
    }

    pub fn setting_key(self) -> &'static str {
        match self {
            Self::TitleSuggestions => settings_keys::TITLE_SUGGESTIONS_SYSTEM_PROMPT,
            Self::EntryHighlights => settings_keys::ENTRY_HIGHLIGHTS_SYSTEM_PROMPT,
            Self::MultiEntrySummary => settings_keys::MULTI_ENTRY_SUMMARY_SYSTEM_PROMPT,
            Self::GoDeeper => settings_keys::GO_DEEPER_SYSTEM_PROMPT,
        }
    }

    pub fn default_text(self) -> &'static str {
        match self {
            Self::TitleSuggestions => DEFAULT_TITLE_SUGGESTIONS,
            Self::EntryHighlights => DEFAULT_ENTRY_HIGHLIGHTS,
            Self::MultiEntrySummary => DEFAULT_MULTI_ENTRY_SUMMARY,
            Self::GoDeeper => DEFAULT_GO_DEEPER,
        }
    }
}

pub const FEATURE_PROMPT_MAX_CHARS: usize = 4000;

pub const DEFAULT_TITLE_SUGGESTIONS: &str =
    "Suggest a 3-7 word title for the following journal entry. Return ONLY the title, no quotes, no explanation.";

pub const DEFAULT_ENTRY_HIGHLIGHTS: &str = "Summarize the key themes, emotions, and moments \
from this journal entry. Output 3-5 short bullet points in Markdown. \
Match the language of the entry. Return ONLY the bullet list, no header, no preamble.";

pub const DEFAULT_MULTI_ENTRY_SUMMARY: &str = "Summarise the following journal \
entries as a short Markdown bulleted list (use `-` bullets, 3\u{2013}7 items, one line \
each). No preamble, no headings, no closing remarks. Match the language of the \
entries. Highlight concrete moments, recurring themes, and notable contrasts \
\u{2014} and if the entries span multiple years on the same date, surface the \
cross-year arc. If only one entry is provided, distil it to its key points.";

pub const DEFAULT_GO_DEEPER: &str = "You are a thoughtful journaling companion. \
Read this journal entry and propose 3 short, open-ended reflection prompts that \
help the writer explore the themes more deeply. Each prompt should be a single \
question, under 20 words. Output ONLY a JSON array of 3 strings, no preamble, \
no commentary, no surrounding markdown fences. Match the language of the entry.";

/// Parse a frontend / IPC feature id into a [`FeaturePromptKind`].
pub fn parse_feature_prompt_kind(feature: &str) -> Result<FeaturePromptKind, String> {
    Ok(match feature {
        "title_suggestions" => FeaturePromptKind::TitleSuggestions,
        "entry_highlights" => FeaturePromptKind::EntryHighlights,
        "multi_entry_summary" => FeaturePromptKind::MultiEntrySummary,
        "go_deeper" => FeaturePromptKind::GoDeeper,
        other => return Err(format!("unknown feature prompt: `{other}`")),
    })
}

/// Read the stored override for `kind`, or `None` when unset / empty.
pub fn read_prompt_override(conn: &Connection, kind: FeaturePromptKind) -> Option<String> {
    db::get_setting(conn, kind.setting_key())
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve the effective system prompt: user override when set, else default.
pub fn resolve_system_prompt(conn: &Connection, kind: FeaturePromptKind) -> String {
    read_prompt_override(conn, kind).unwrap_or_else(|| kind.default_text().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use rusqlite::Connection;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("db");
        migrate(&c).expect("migrate");
        c
    }

    #[test]
    fn parse_feature_prompt_kind_accepts_known_features() {
        assert_eq!(
            parse_feature_prompt_kind("go_deeper").unwrap(),
            FeaturePromptKind::GoDeeper
        );
    }

    #[test]
    fn parse_feature_prompt_kind_rejects_unknown() {
        assert!(parse_feature_prompt_kind("nope").is_err());
    }

    #[test]
    fn resolve_system_prompt_falls_back_to_default_when_empty() {
        let c = conn();
        let out = resolve_system_prompt(&c, FeaturePromptKind::TitleSuggestions);
        assert_eq!(out, DEFAULT_TITLE_SUGGESTIONS);
    }

    #[test]
    fn resolve_system_prompt_uses_override_when_set() {
        let c = conn();
        db::set_setting(
            &c,
            settings_keys::GO_DEEPER_SYSTEM_PROMPT,
            "custom go deeper",
        )
        .unwrap();
        let out = resolve_system_prompt(&c, FeaturePromptKind::GoDeeper);
        assert_eq!(out, "custom go deeper");
    }

    #[test]
    fn feature_prompt_max_chars_is_positive() {
        assert!(FEATURE_PROMPT_MAX_CHARS >= 1000);
    }
}
