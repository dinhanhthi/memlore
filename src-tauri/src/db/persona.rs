//! Database access for the singleton Build Your Persona document.
//!
//! The three text columns deliberately remain independent: interview answers
//! are user-authored, while traits and writing style are generated (and may be
//! edited by the user). Writers update only the columns they own.

use crate::ai::persona_builder::{sanitize_persona_text, validate_and_sanitize_persona_answers};
use crate::utils::time::now_unix;
use rusqlite::{params, Connection, Result};

/// The persisted persona document. SQLite stores booleans as integers; this
/// DTO exposes normal Rust booleans to command and sync callers.
///
/// Timestamps (`updated_at`, `generated_at`) are unix **seconds**, matching
/// `memory_items` and the sync engine's `now_unix()` LWW clamp. Milliseconds
/// would always beat a peer after clamp and break multi-device merge.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaRow {
    pub answers_json: String,
    pub traits_text: String,
    pub style_text: String,
    pub enabled: bool,
    pub user_edited: bool,
    pub generated_at: Option<i64>,
    pub updated_at: i64,
}

fn next_updated_at(conn: &Connection, now: i64) -> Result<i64> {
    conn.query_row(
        "SELECT MAX(updated_at + 1, ?1) FROM user_persona WHERE id = 1",
        [now],
        |row| row.get(0),
    )
}

/// Read the materialized singleton persona row.
pub fn read_persona(conn: &Connection) -> Result<PersonaRow> {
    conn.query_row(
        "SELECT answers_json, traits_text, style_text, enabled, user_edited,
                generated_at, updated_at
         FROM user_persona WHERE id = 1",
        [],
        |row| {
            Ok(PersonaRow {
                answers_json: row.get(0)?,
                traits_text: row.get(1)?,
                style_text: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                user_edited: row.get::<_, i64>(4)? != 0,
                generated_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
}

/// Apply a peer persona only when it is strictly newer than the local
/// singleton. Equal timestamps keep the local document, matching the LWW
/// convention used by other singleton sync surfaces without inventing a
/// device-id tie-breaker that this payload does not carry.
pub fn upsert_persona_lww(
    conn: &Connection,
    answers_json: &str,
    traits_text: &str,
    style_text: &str,
    enabled: bool,
    user_edited: bool,
    generated_at: Option<i64>,
    updated_at: i64,
) -> Result<bool> {
    // LWW short-circuit: an older (or equal) peer must not replace local
    // content. Check the clock first so a stale peer with malformed payload
    // is ignored rather than rejecting the whole merge.
    let local_updated_at: i64 = conn.query_row(
        "SELECT updated_at FROM user_persona WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    if updated_at <= local_updated_at {
        return Ok(false);
    }

    let answers_json = validate_and_sanitize_persona_answers(answers_json).map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            error,
        )))
    })?;
    let traits_text = sanitize_persona_text(traits_text);
    let style_text = sanitize_persona_text(style_text);
    let changed = conn.execute(
        "UPDATE user_persona
         SET answers_json = ?1, traits_text = ?2, style_text = ?3,
             enabled = ?4, user_edited = ?5, generated_at = ?6, updated_at = ?7
         WHERE id = 1 AND updated_at < ?7",
        params![
            answers_json,
            traits_text,
            style_text,
            enabled as i64,
            user_edited as i64,
            generated_at,
            updated_at,
        ],
    )?;
    Ok(changed == 1)
}

/// Save interview answers without disturbing either generated section or the
/// user's edit-state for those sections.
pub fn write_persona_answers(conn: &Connection, answers_json: &str) -> Result<()> {
    let answers_json = validate_and_sanitize_persona_answers(answers_json).map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            error,
        )))
    })?;
    let updated_at = next_updated_at(conn, now_unix())?;
    conn.execute(
        "UPDATE user_persona
         SET answers_json = ?1, updated_at = ?2
         WHERE id = 1",
        params![answers_json, updated_at],
    )?;
    Ok(())
}

/// Replace machine-generated traits/style. This is the only writer that
/// clears `user_edited`; answers remain byte-for-byte untouched.
pub fn write_persona_generated(
    conn: &Connection,
    traits_text: &str,
    style_text: &str,
    generated_at: i64,
) -> Result<()> {
    let traits_text = sanitize_persona_text(traits_text);
    let style_text = sanitize_persona_text(style_text);
    let updated_at = next_updated_at(conn, now_unix())?;
    conn.execute(
        "UPDATE user_persona
         SET traits_text = ?1, style_text = ?2, user_edited = 0,
             generated_at = ?3, updated_at = ?4
         WHERE id = 1",
        params![traits_text, style_text, generated_at, updated_at],
    )?;
    Ok(())
}

/// Replace generated text only when the persona is still the exact revision
/// that started synthesis. Provider calls happen outside the DB lock, so a
/// user edit (or any other concurrent persona mutation) must win instead of
/// being silently overwritten when the provider returns.
pub fn write_persona_generated_if_current(
    conn: &Connection,
    traits_text: &str,
    style_text: &str,
    generated_at: i64,
    expected_updated_at: i64,
) -> Result<bool> {
    let traits_text = sanitize_persona_text(traits_text);
    let style_text = sanitize_persona_text(style_text);
    let changed = conn.execute(
        "UPDATE user_persona
         SET traits_text = ?1, style_text = ?2, user_edited = 0,
             generated_at = ?3, updated_at = MAX(updated_at + 1, ?4)
         WHERE id = 1 AND updated_at = ?5",
        params![
            traits_text,
            style_text,
            generated_at,
            now_unix(),
            expected_updated_at,
        ],
    )?;
    Ok(changed == 1)
}

/// Persist user edits to the generated sections. Interview answers and the
/// last generation timestamp belong to other lifetimes and are retained.
pub fn write_persona_user_edit(
    conn: &Connection,
    traits_text: &str,
    style_text: &str,
) -> Result<()> {
    let traits_text = sanitize_persona_text(traits_text);
    let style_text = sanitize_persona_text(style_text);
    let updated_at = next_updated_at(conn, now_unix())?;
    conn.execute(
        "UPDATE user_persona
         SET traits_text = ?1, style_text = ?2, user_edited = 1,
             updated_at = ?3
         WHERE id = 1",
        params![traits_text, style_text, updated_at],
    )?;
    Ok(())
}

/// Toggle persona injection without changing its content.
pub fn set_persona_enabled(conn: &Connection, enabled: bool) -> Result<()> {
    let updated_at = next_updated_at(conn, now_unix())?;
    conn.execute(
        "UPDATE user_persona SET enabled = ?1, updated_at = ?2 WHERE id = 1",
        params![enabled as i64, updated_at],
    )?;
    Ok(())
}

/// Clear persona content while preserving the independent enabled toggle.
pub fn clear_persona(conn: &Connection) -> Result<()> {
    let updated_at = next_updated_at(conn, now_unix())?;
    conn.execute(
        "UPDATE user_persona
         SET answers_json = '', traits_text = '', style_text = '',
             user_edited = 0, generated_at = NULL, updated_at = ?1
         WHERE id = 1",
        [updated_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        schema::migrate(&conn).expect("migrate");
        conn
    }

    #[test]
    fn user_edit_flag_survives_read_and_answer_write_preserves_generated_columns() {
        let conn = open_test_db();
        write_persona_generated(&conn, "thoughtful", "brief", 100).expect("generate");
        write_persona_user_edit(&conn, "direct", "warm").expect("user edit");
        write_persona_answers(&conn, r#"{"length_preference":"brief"}"#).expect("answers");

        let persona = read_persona(&conn).expect("read");
        assert!(persona.user_edited, "a read must retain the user edit flag");
        assert_eq!(persona.traits_text, "direct");
        assert_eq!(persona.style_text, "warm");
        assert_eq!(persona.answers_json, r#"{"length_preference":"brief"}"#);
        assert_eq!(persona.generated_at, Some(100));
    }

    #[test]
    fn generation_is_the_only_writer_that_clears_user_edit_and_preserves_answers_bytes() {
        let conn = open_test_db();
        let answers = r#"{"journal_goal":"my future self","languages":"vi/en"}"#;
        write_persona_answers(&conn, answers).expect("answers");
        write_persona_user_edit(&conn, "custom traits", "custom style").expect("user edit");
        set_persona_enabled(&conn, false).expect("toggle");

        let before = read_persona(&conn).expect("read before generation");
        assert!(before.user_edited);

        write_persona_generated(&conn, "generated traits", "generated style", 500)
            .expect("generate");

        let after = read_persona(&conn).expect("read after generation");
        assert!(
            !after.user_edited,
            "only generation clears the user edit flag"
        );
        // Generation must leave answers_json byte-identical to what was
        // stored (post-sanitize) — never touch the user-authored column.
        assert_eq!(
            after.answers_json.as_bytes(),
            before.answers_json.as_bytes()
        );
        assert_eq!(after.traits_text, "generated traits");
        assert_eq!(after.style_text, "generated style");
        assert!(!after.enabled, "content writers must not alter the toggle");
    }

    #[test]
    fn conditional_generation_refuses_to_overwrite_a_newer_user_edit() {
        let conn = open_test_db();
        let snapshot = read_persona(&conn)
            .expect("read initial persona")
            .updated_at;
        write_persona_user_edit(&conn, "user traits", "user style").expect("concurrent edit");

        assert!(
            !write_persona_generated_if_current(
                &conn,
                "generated traits",
                "generated style",
                500,
                snapshot
            )
            .expect("conditional generation"),
            "a generation based on an old snapshot must be discarded"
        );
        let row = read_persona(&conn).expect("read preserved persona");
        assert_eq!(row.traits_text, "user traits");
        assert_eq!(row.style_text, "user style");
        assert!(row.user_edited);
    }

    #[test]
    fn clear_removes_content_but_preserves_the_enabled_toggle() {
        let conn = open_test_db();
        set_persona_enabled(&conn, false).expect("disable");
        write_persona_answers(&conn, r#"{"journal_goal":"journal"}"#).expect("answers");
        write_persona_generated(&conn, "traits", "style", 100).expect("generate");

        clear_persona(&conn).expect("clear");

        let persona = read_persona(&conn).expect("read");
        assert_eq!(persona.answers_json, "");
        assert_eq!(persona.traits_text, "");
        assert_eq!(persona.style_text, "");
        assert!(!persona.user_edited);
        assert_eq!(persona.generated_at, None);
        assert!(!persona.enabled);
    }

    #[test]
    fn lww_upsert_only_replaces_an_older_persona() {
        let conn = open_test_db();
        write_persona_user_edit(&conn, "local", "local style").expect("local edit");
        conn.execute("UPDATE user_persona SET updated_at = 200 WHERE id = 1", [])
            .expect("set local timestamp");

        assert!(
            !upsert_persona_lww(
                &conn,
                r#"{"preferred_name":"peer"}"#,
                "older peer",
                "peer style",
                false,
                false,
                Some(10),
                100,
            )
            .expect("merge older peer"),
            "an older peer persona must not replace local content"
        );
        assert_eq!(
            read_persona(&conn)
                .expect("read after older peer")
                .traits_text,
            "local"
        );

        assert!(
            upsert_persona_lww(
                &conn,
                r#"{"preferred_name":"peer"}"#,
                "newer peer",
                "peer style",
                false,
                false,
                Some(10),
                300,
            )
            .expect("merge newer peer"),
            "a newer peer persona must replace local content"
        );
        assert_eq!(
            read_persona(&conn)
                .expect("read after newer peer")
                .traits_text,
            "newer peer"
        );
    }

    #[test]
    fn direct_user_edit_sanitizes_and_caps_persona_sections() {
        let conn = open_test_db();
        let oversized = format!("  Calm\u{0007} writer\n{}", "word ".repeat(400));

        write_persona_user_edit(&conn, &oversized, &oversized).expect("save direct edit");

        let persona = read_persona(&conn).expect("read saved edit");
        assert!(!persona.traits_text.contains('\u{0007}'));
        assert!(!persona.traits_text.contains('\n'));
        assert!(
            persona.traits_text.chars().count()
                <= crate::ai::persona_builder::PERSONA_SECTION_MAX_CHARS
        );
        assert!(
            persona.style_text.chars().count()
                <= crate::ai::persona_builder::PERSONA_SECTION_MAX_CHARS
        );
    }

    #[test]
    fn lww_upsert_rejects_malformed_answers_without_replacing_local_persona() {
        let conn = open_test_db();
        write_persona_user_edit(&conn, "local", "local style").expect("seed local persona");
        conn.execute("UPDATE user_persona SET updated_at = 100 WHERE id = 1", [])
            .expect("set local timestamp");

        assert!(upsert_persona_lww(
            &conn,
            r#"{"not_an_interview_key":"peer"}"#,
            "peer traits",
            "peer style",
            true,
            false,
            Some(200),
            200,
        )
        .is_err());
        assert_eq!(
            read_persona(&conn)
                .expect("read preserved local")
                .traits_text,
            "local"
        );
    }
}
