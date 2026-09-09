//! AI tag suggestions — single-entry generation feature.

use crate::ai::error::AiError;
use crate::ai::provider::settings_keys;
use crate::ai::provider::{ChatOpts, Message, MessageRole};
use crate::ai::provider_registry::ProviderRegistry;
use crate::commands::ai_provider::slot_provider_privacy_accepted;
use crate::db;
use crate::AppState;
use tauri::State;

const SUGGEST_TAGS_SYSTEM_PROMPT: &str = "Suggest 3-8 short tags for this journal entry. \
Prefer tags from the user's existing vocabulary when they fit. Return ONLY a JSON array \
of tag name strings, no preamble, no markdown fences. Use lowercase unless a proper noun \
requires otherwise. Do not repeat tags already on the entry.";

const SUGGEST_TAGS_MAX_INPUT_CHARS: usize = 16 * 1024;
const SUGGEST_TAGS_MAX_TAGS: usize = 8;

fn truncate_for_suggest_tags(text: &str) -> String {
    match text.char_indices().nth(SUGGEST_TAGS_MAX_INPUT_CHARS) {
        Some((cut, _)) => format!("{}\n\n[entry truncated]", &text[..cut]),
        None => text.to_string(),
    }
}

fn build_user_content(entry_text: &str, existing_tags: &[String], vocabulary: &[String]) -> String {
    let mut parts = vec![format!("Entry:\n{entry_text}")];
    if !existing_tags.is_empty() {
        parts.push(format!(
            "Tags already on this entry (do not suggest these): {}",
            existing_tags.join(", ")
        ));
    }
    if !vocabulary.is_empty() {
        parts.push(format!(
            "User's existing tag vocabulary (prefer these when relevant): {}",
            vocabulary.join(", ")
        ));
    }
    parts.join("\n\n")
}

/// Parse provider output into tag names. JSON array first, comma/newline fallback.
pub(crate) fn parse_suggest_tags_response(raw: &str) -> Result<Vec<String>, AiError> {
    let stripped = raw.trim();
    if stripped.is_empty() {
        return Err(AiError::EmptyResponse);
    }

    if let Ok(arr) = serde_json::from_str::<Vec<String>>(stripped) {
        let cleaned: Vec<String> = arr
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(SUGGEST_TAGS_MAX_TAGS)
            .collect();
        if !cleaned.is_empty() {
            return Ok(cleaned);
        }
    }

    let tags: Vec<String> = stripped
        .split([',', '\n'])
        .map(|s| {
            s.trim()
                .trim_matches(|c: char| c == '"' || c == '\'' || c == '[' || c == ']')
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .take(SUGGEST_TAGS_MAX_TAGS)
        .collect();

    if tags.is_empty() {
        return Err(AiError::EmptyResponse);
    }
    Ok(tags)
}

/// Pure-state pipeline for unit tests.
pub(crate) async fn suggest_tags_inner(
    entry_id: &str,
    state: &AppState,
    registry: &ProviderRegistry,
) -> Result<Vec<String>, AiError> {
    let toggle_on = state
        .with_conn(|conn| {
            Ok(crate::commands::ai_settings::read_feature_toggle_on(
                conn,
                settings_keys::TAG_SUGGESTIONS_ENABLED,
            )
            .map_err(|e| e.to_string())?)
        })
        .map_err(AiError::IoError)?;
    if !toggle_on {
        return Err(AiError::FeatureDisabled("AI_TAG_SUGGESTIONS_DISABLED"));
    }

    let provider = registry
        .generation()
        .ok_or(AiError::ProviderNotConfigured)?;
    let accepted = state
        .with_conn(|conn| {
            slot_provider_privacy_accepted(conn, settings_keys::gen::PROVIDER)
                .map_err(|e| e.to_string())
        })
        .map_err(AiError::IoError)?;
    if !accepted {
        return Err(AiError::PrivacyNotAccepted);
    }

    let (entry_text, existing_tag_names, vocabulary): (String, Vec<String>, Vec<String>) = state
        .with_conn(|conn| {
            let entry = db::queries::get_entry_for_provider(conn, entry_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "entry not found".to_string())?;
            let body = entry
                .content_text
                .filter(|t| !t.trim().is_empty())
                .ok_or_else(|| "entry empty".to_string())?;
            let entry_text =
                crate::ai::indexer::build_indexable_text(entry.title.as_deref(), Some(&body));
            let entry_text = truncate_for_suggest_tags(&entry_text);

            let existing: Vec<String> = db::get_tags_for_entry(conn, entry_id)
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|t| t.name)
                .collect();
            // `None`: the AI vocabulary must never contain invisible-only
            // tag names, even while a vault is unlocked (privacy guarantee).
            let vocab: Vec<String> = db::list_tags(conn, None)
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|t| t.name)
                .collect();
            Ok((entry_text, existing, vocab))
        })
        .map_err(|e: String| AiError::ProviderError(e))?;

    let user_content = build_user_content(&entry_text, &existing_tag_names, &vocabulary);
    let messages = vec![
        Message {
            role: MessageRole::System,
            content: SUGGEST_TAGS_SYSTEM_PROMPT.to_string(),
        },
        Message {
            role: MessageRole::User,
            content: user_content,
        },
    ];
    let opts = ChatOpts {
        max_tokens: Some(200),
        temperature: Some(0.5),
        model: None,
    };
    let raw = crate::ai::audit::with_feature("suggest_tags", async {
        provider.chat(&messages, opts).await
    })
    .await?;

    parse_suggest_tags_response(&raw)
}

#[tauri::command]
pub async fn suggest_tags(
    entry_id: String,
    state: State<'_, AppState>,
    registry: State<'_, ProviderRegistry>,
) -> Result<Vec<String>, String> {
    suggest_tags_inner(&entry_id, &state, &registry)
        .await
        .map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::ai::provider_registry::ProviderRegistry;
    use crate::ai::providers::testing::MockAIProvider;

    use crate::db::schema::migrate;
    use rusqlite::Connection;
    use std::sync::Arc;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    fn enable_tag_suggestions(state: &AppState) {
        state
            .with_conn(|conn| {
                db::set_setting(conn, settings_keys::gen::PROVIDER, "mock")
                    .map_err(|e| e.to_string())?;
                db::set_setting(conn, settings_keys::gen::PROVIDER, "openai")
                    .map_err(|e| e.to_string())?;
                db::set_setting(conn, settings_keys::PRIVACY_ACCEPTED_AT, "1")
                    .map_err(|e| e.to_string())?;
                db::set_setting(conn, settings_keys::TAG_SUGGESTIONS_ENABLED, "true")
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
    }

    fn seed_entry(state: &AppState, id: &str, text: &str) {
        state
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO journals (id, name, color, created_at, updated_at, sort_order)
                     VALUES ('j1', 'j', NULL, 1, 1, 0) ON CONFLICT DO NOTHING",
                    [],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO entries (id, journal_id, title, content_text, entry_date, created_at, updated_at)
                     VALUES (?1, 'j1', 't', ?2, 1, 1, 1)",
                    rusqlite::params![id, text],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn parse_suggest_tags_response_accepts_json_array() {
        let tags = parse_suggest_tags_response(r#"["work", "focus", "deadline"]"#).unwrap();
        assert_eq!(tags, vec!["work", "focus", "deadline"]);
    }

    #[test]
    fn build_user_content_includes_vocabulary() {
        let out = build_user_content(
            "body",
            &["existing".into()],
            &["work".into(), "health".into()],
        );
        assert!(out.contains("work, health"));
        assert!(out.contains("existing"));
    }

    #[tokio::test]
    async fn suggest_tags_disabled_when_toggle_off() {
        let state = make_state();
        // Tag suggestions default to ON now — explicitly opt out.
        state
            .with_conn(|conn| {
                db::set_setting(conn, settings_keys::TAG_SUGGESTIONS_ENABLED, "false")
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        seed_entry(&state, "e1", "enough text for tags here");
        let registry = ProviderRegistry::default();
        let err = suggest_tags_inner("e1", &state, &registry)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            AiError::FeatureDisabled("AI_TAG_SUGGESTIONS_DISABLED")
        ));
    }

    #[tokio::test]
    async fn suggest_tags_returns_parsed_tags() {
        let state = make_state();
        enable_tag_suggestions(&state);
        seed_entry(&state, "e1", "Today I shipped a big feature at work.");
        state
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO tags (id, name, color, updated_at, is_deleted) VALUES ('t1', 'work', '#fff', 1, 0)",
                    [],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();

        let mock = Arc::new(
            MockAIProvider::new("mock", "v1")
                .with_chat_response(r#"["work", "shipping", "momentum"]"#),
        );
        let registry = ProviderRegistry::default();
        registry.swap_generation(mock);

        let tags = suggest_tags_inner("e1", &state, &registry).await.unwrap();
        assert_eq!(tags, vec!["work", "shipping", "momentum"]);
    }
}
