//! Reflection-lens presets for Go Deeper + Daily Chat.
//!
//! Short, hardcoded coaching-framework prompts — no new DB tables.
//! Go Deeper lenses select the system prompt (unless the user has a
//! custom `ai_go_deeper_system_prompt` override). Daily Chat treats
//! lenses as additional built-in personas snapshotted at session create.

use crate::ai::feature_prompts::{self, FeaturePromptKind};
use rusqlite::Connection;

/// Wire ids accepted by Go Deeper and Daily Chat persona pickers.
pub const LENS_IDS: &[&str] = &["default", "cbt_reframe", "gratitude", "inversion", "stoic"];

pub fn is_lens_id(id: &str) -> bool {
    LENS_IDS.contains(&id)
}

/// Go Deeper system prompt for a lens (ignores user override).
pub fn go_deeper_lens_prompt(lens: &str) -> &'static str {
    match lens {
        "cbt_reframe" => GO_DEEPER_CBT_REFRAME,
        "gratitude" => GO_DEEPER_GRATITUDE,
        "inversion" => GO_DEEPER_INVERSION,
        "stoic" => GO_DEEPER_STOIC,
        // "default" + unknown → generic reflection companion.
        _ => feature_prompts::DEFAULT_GO_DEEPER,
    }
}

/// Daily Chat persona body for a reflection lens.
pub fn daily_chat_lens_prompt(lens: &str) -> Option<&'static str> {
    match lens {
        "cbt_reframe" => Some(DAILY_CHAT_CBT_REFRAME),
        "gratitude" => Some(DAILY_CHAT_GRATITUDE),
        "inversion" => Some(DAILY_CHAT_INVERSION),
        "stoic" => Some(DAILY_CHAT_STOIC),
        _ => None,
    }
}

/// Effective Go Deeper system prompt: custom override wins, else lens preset.
pub fn resolve_go_deeper_system_prompt(conn: &Connection, lens: Option<&str>) -> String {
    if let Some(custom) = feature_prompts::read_prompt_override(conn, FeaturePromptKind::GoDeeper) {
        return custom;
    }
    let lens_id = lens.filter(|l| !l.is_empty()).unwrap_or("default");
    go_deeper_lens_prompt(lens_id).to_string()
}

const GO_DEEPER_CBT_REFRAME: &str = "You are a CBT-informed journaling companion. \
Read this journal entry and propose 3 short reflection prompts that gently surface \
automatic thoughts, evidence for/against them, and a kinder reframe. Each prompt \
must be one question under 20 words. Output ONLY a JSON array of 3 strings, no \
preamble, no markdown fences. Match the language of the entry.";

const GO_DEEPER_GRATITUDE: &str = "You are a gratitude-focused journaling companion. \
Read this journal entry and propose 3 short prompts that help the writer notice \
specific people, moments, and small wins worth appreciating — including hard days. \
Each prompt must be one question under 20 words. Output ONLY a JSON array of 3 \
strings, no preamble, no markdown fences. Match the language of the entry.";

const GO_DEEPER_INVERSION: &str = "You are a first-principles journaling companion. \
Read this journal entry and propose 3 short prompts using inversion and assumption-\
challenging: what would make this worse, what must be true, what is one contrarian \
angle. Each prompt must be one question under 20 words. Output ONLY a JSON array \
of 3 strings, no preamble, no markdown fences. Match the language of the entry.";

const GO_DEEPER_STOIC: &str = "You are a stoic journaling companion. \
Read this journal entry and propose 3 short prompts about what is in the writer's \
control vs not, what virtue they practiced or could practice, and what they would \
advise a friend in the same situation. Each prompt must be one question under \
20 words. Output ONLY a JSON array of 3 strings, no preamble, no markdown fences. \
Match the language of the entry.";

const DAILY_CHAT_CBT_REFRAME: &str = "You are a CBT-informed journaling companion. \
Ask one question at a time that helps the user notice automatic thoughts, check \
evidence, and find a kinder reframe. Reflect back what you hear before asking the \
next question. Keep replies short (1-3 sentences). Match the language the user \
writes in.";

const DAILY_CHAT_GRATITUDE: &str = "You are a gratitude-focused journaling companion. \
Ask one question at a time that helps the user notice specific people, moments, and \
small wins — even on difficult days. Keep replies warm and short (1-3 sentences). \
Match the language the user writes in.";

const DAILY_CHAT_INVERSION: &str = "You are a first-principles journaling companion. \
Ask one sharp question at a time that challenges assumptions, inverts the problem, \
or asks what must be true. Stay curious, not cynical. Keep replies short (1-3 \
sentences). Match the language the user writes in.";

const DAILY_CHAT_STOIC: &str = "You are a stoic journaling companion. \
Ask one question at a time about control vs acceptance, practiced virtue, and what \
a wise friend would say. Calm, direct, never preachy. Keep replies short (1-3 \
sentences). Match the language the user writes in.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::settings_keys;
    use crate::db;
    use crate::db::schema::migrate;
    use rusqlite::Connection;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("db");
        migrate(&c).expect("migrate");
        c
    }

    #[test]
    fn each_lens_selects_distinct_go_deeper_prompt() {
        let cbt = go_deeper_lens_prompt("cbt_reframe");
        let gratitude = go_deeper_lens_prompt("gratitude");
        let inversion = go_deeper_lens_prompt("inversion");
        let stoic = go_deeper_lens_prompt("stoic");
        let default = go_deeper_lens_prompt("default");
        assert!(cbt.contains("CBT"));
        assert!(gratitude.contains("gratitude"));
        assert!(inversion.contains("inversion"));
        assert!(stoic.contains("stoic"));
        assert_eq!(default, feature_prompts::DEFAULT_GO_DEEPER);
        assert_ne!(cbt, gratitude);
    }

    #[test]
    fn resolve_go_deeper_uses_lens_when_no_override() {
        let c = conn();
        let out = resolve_go_deeper_system_prompt(&c, Some("stoic"));
        assert_eq!(out, GO_DEEPER_STOIC);
    }

    #[test]
    fn resolve_go_deeper_custom_override_beats_lens() {
        let c = conn();
        db::set_setting(&c, settings_keys::GO_DEEPER_SYSTEM_PROMPT, "my custom").unwrap();
        let out = resolve_go_deeper_system_prompt(&c, Some("cbt_reframe"));
        assert_eq!(out, "my custom");
    }

    #[test]
    fn daily_chat_lens_prompt_returns_some_for_each_lens() {
        for id in ["cbt_reframe", "gratitude", "inversion", "stoic"] {
            assert!(daily_chat_lens_prompt(id).is_some());
        }
        assert!(daily_chat_lens_prompt("empathetic").is_none());
    }
}
