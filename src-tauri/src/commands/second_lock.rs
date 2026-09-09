use rusqlite::Connection;
use tauri::State;

use crate::db;
use crate::utils::second_lock::{
    hash_second_lock_password, verify_second_lock_password as verify_second_lock_password_phc,
};
use crate::AppState;

fn require_second_lock_enabled(conn: &Connection) -> Result<(), String> {
    if second_lock_status_impl(conn)? {
        Ok(())
    } else {
        Err("Second lock is not enabled".to_string())
    }
}

/// Minimum length for a second-lock password. Counted in Unicode code
/// points so multi-byte characters (emoji, accents, etc.) count as one each.
pub(crate) const MIN_SECOND_LOCK_PASSWORD_LEN: usize = 4;

fn validate_second_lock_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_SECOND_LOCK_PASSWORD_LEN {
        Err(format!(
            "Second-lock password must be at least {} characters",
            MIN_SECOND_LOCK_PASSWORD_LEN
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn second_lock_status_impl(conn: &Connection) -> Result<bool, String> {
    db::get_second_lock_verifier(conn)
        .map(|verifier| verifier.is_some())
        .map_err(|e| e.to_string())
}

pub(crate) fn set_second_lock_password_impl(
    conn: &Connection,
    password: &str,
) -> Result<(), String> {
    if second_lock_status_impl(conn)? {
        return Err("Second lock is already enabled".to_string());
    }
    validate_second_lock_password(password)?;
    let verifier = hash_second_lock_password(password)?;
    db::set_second_lock_verifier(conn, &verifier).map_err(|e| e.to_string())
}

pub(crate) fn verify_second_lock_password_impl(
    conn: &Connection,
    password: &str,
) -> Result<bool, String> {
    let Some(verifier) = db::get_second_lock_verifier(conn).map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    Ok(verify_second_lock_password_phc(password, &verifier))
}

pub(crate) fn change_second_lock_password_impl(
    conn: &Connection,
    old_password: &str,
    new_password: &str,
) -> Result<(), String> {
    if !verify_second_lock_password_impl(conn, old_password)? {
        return Err("Invalid second-lock password".to_string());
    }
    validate_second_lock_password(new_password)?;
    let verifier = hash_second_lock_password(new_password)?;
    db::set_second_lock_verifier(conn, &verifier).map_err(|e| e.to_string())
}

pub(crate) fn disable_second_lock_impl(conn: &Connection, password: &str) -> Result<(), String> {
    if !verify_second_lock_password_impl(conn, password)? {
        return Err("Invalid second-lock password".to_string());
    }
    db::clear_second_lock_verifier_and_all_locks(conn).map_err(|e| e.to_string())
}

pub(crate) fn set_entry_locked_impl(
    conn: &Connection,
    entry_id: &str,
    locked: bool,
) -> Result<(), String> {
    require_second_lock_enabled(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::set_entry_locked(&tx, entry_id, locked).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub(crate) fn set_journal_locked_impl(
    conn: &Connection,
    journal_id: &str,
    locked: bool,
) -> Result<(), String> {
    require_second_lock_enabled(conn)?;
    db::set_journal_locked(conn, journal_id, locked).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn second_lock_status(state: State<'_, AppState>) -> Result<bool, String> {
    let conn = state.lock()?;
    second_lock_status_impl(&conn)
}

#[tauri::command]
pub fn set_second_lock_password(
    state: State<'_, AppState>,
    password: String,
) -> Result<(), String> {
    let conn = state.lock()?;
    set_second_lock_password_impl(&conn, &password)
}

#[tauri::command]
pub fn change_second_lock_password(
    state: State<'_, AppState>,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    let conn = state.lock()?;
    change_second_lock_password_impl(&conn, &old_password, &new_password)
}

#[tauri::command]
pub fn verify_second_lock_password(
    state: State<'_, AppState>,
    password: String,
) -> Result<bool, String> {
    let conn = state.lock()?;
    verify_second_lock_password_impl(&conn, &password)
}

#[tauri::command]
pub fn disable_second_lock(state: State<'_, AppState>, password: String) -> Result<(), String> {
    let conn = state.lock()?;
    disable_second_lock_impl(&conn, &password)
}

#[tauri::command]
pub fn set_entry_locked(
    state: State<'_, AppState>,
    entry_id: String,
    locked: bool,
) -> Result<(), String> {
    let conn = state.lock()?;
    set_entry_locked_impl(&conn, &entry_id, locked)
}

#[tauri::command]
pub fn set_journal_locked(
    state: State<'_, AppState>,
    journal_id: String,
    locked: bool,
) -> Result<(), String> {
    let conn = state.lock()?;
    set_journal_locked_impl(&conn, &journal_id, locked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, schema::migrate, CreateEntryParams};

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    fn make_entry(conn: &Connection) -> String {
        let journal_id = db::list_journals(conn, None).unwrap()[0].id.clone();
        db::create_entry(
            conn,
            CreateEntryParams {
                journal_id: &journal_id,
                title: Some("Private"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: 1,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn status_set_verify_change_roundtrip() {
        let conn = setup();
        assert!(!second_lock_status_impl(&conn).unwrap());

        set_second_lock_password_impl(&conn, "secret one").unwrap();
        assert!(second_lock_status_impl(&conn).unwrap());
        assert!(verify_second_lock_password_impl(&conn, "secret one").unwrap());
        assert!(!verify_second_lock_password_impl(&conn, "wrong").unwrap());

        change_second_lock_password_impl(&conn, "secret one", "secret two").unwrap();
        assert!(!verify_second_lock_password_impl(&conn, "secret one").unwrap());
        assert!(verify_second_lock_password_impl(&conn, "secret two").unwrap());
    }

    #[test]
    fn set_password_rejects_when_already_enabled() {
        let conn = setup();
        set_second_lock_password_impl(&conn, "secret one").unwrap();

        let err = set_second_lock_password_impl(&conn, "secret two").unwrap_err();
        assert!(err.contains("already enabled"));
        assert!(verify_second_lock_password_impl(&conn, "secret one").unwrap());
    }

    #[test]
    fn change_password_rejects_wrong_old_password() {
        let conn = setup();
        set_second_lock_password_impl(&conn, "secret one").unwrap();

        let err = change_second_lock_password_impl(&conn, "wrong", "secret two").unwrap_err();
        assert!(err.contains("Invalid second-lock password"));
        assert!(verify_second_lock_password_impl(&conn, "secret one").unwrap());
    }

    #[test]
    fn disable_requires_password_and_clears_flags() {
        let conn = setup();
        let entry_id = make_entry(&conn);
        let journal_id = db::get_entry(&conn, &entry_id).unwrap().unwrap().journal_id;
        set_second_lock_password_impl(&conn, "secret").unwrap();
        set_entry_locked_impl(&conn, &entry_id, true).unwrap();
        set_journal_locked_impl(&conn, &journal_id, true).unwrap();

        let err = disable_second_lock_impl(&conn, "wrong").unwrap_err();
        assert!(err.contains("Invalid second-lock password"));
        assert!(second_lock_status_impl(&conn).unwrap());
        assert!(db::get_entry(&conn, &entry_id).unwrap().unwrap().is_locked);
        assert!(
            db::get_journal(&conn, &journal_id)
                .unwrap()
                .unwrap()
                .is_locked
        );

        disable_second_lock_impl(&conn, "secret").unwrap();
        assert!(!second_lock_status_impl(&conn).unwrap());
        assert!(!db::get_entry(&conn, &entry_id).unwrap().unwrap().is_locked);
        assert!(
            !db::get_journal(&conn, &journal_id)
                .unwrap()
                .unwrap()
                .is_locked
        );
    }

    #[test]
    fn set_password_rejects_below_minimum_length() {
        let conn = setup();
        let err = set_second_lock_password_impl(&conn, "abc").unwrap_err();
        assert!(err.contains("at least 4 characters"));
        assert!(!second_lock_status_impl(&conn).unwrap());
    }

    #[test]
    fn set_password_accepts_minimum_length_any_characters() {
        let conn = setup();
        // 4 code points, including a multi-byte emoji -> still valid.
        set_second_lock_password_impl(&conn, "a😊b ").unwrap();
        assert!(second_lock_status_impl(&conn).unwrap());
        assert!(verify_second_lock_password_impl(&conn, "a😊b ").unwrap());
    }

    #[test]
    fn set_password_rejects_empty() {
        let conn = setup();
        assert!(set_second_lock_password_impl(&conn, "").is_err());
        assert!(!second_lock_status_impl(&conn).unwrap());
    }

    #[test]
    fn change_password_rejects_new_password_below_minimum_length() {
        let conn = setup();
        set_second_lock_password_impl(&conn, "secret").unwrap();
        let err = change_second_lock_password_impl(&conn, "secret", "ab").unwrap_err();
        assert!(err.contains("at least 4 characters"));
        // Old password still works.
        assert!(verify_second_lock_password_impl(&conn, "secret").unwrap());
    }

    #[test]
    fn change_password_accepts_minimum_length_any_characters() {
        let conn = setup();
        set_second_lock_password_impl(&conn, "secret").unwrap();
        change_second_lock_password_impl(&conn, "secret", "1️⃣2️⃣3️⃣4️⃣").unwrap();
        assert!(verify_second_lock_password_impl(&conn, "1️⃣2️⃣3️⃣4️⃣").unwrap());
    }

    #[test]
    fn lock_flag_setters_require_feature_enabled() {
        let conn = setup();
        let entry_id = make_entry(&conn);
        let journal_id = db::get_entry(&conn, &entry_id).unwrap().unwrap().journal_id;

        assert!(set_entry_locked_impl(&conn, &entry_id, true)
            .unwrap_err()
            .contains("not enabled"));
        assert!(set_journal_locked_impl(&conn, &journal_id, true)
            .unwrap_err()
            .contains("not enabled"));

        set_second_lock_password_impl(&conn, "secret").unwrap();
        let before_version = db::get_entry_local_version(&conn, &entry_id)
            .unwrap()
            .unwrap_or(0);
        set_entry_locked_impl(&conn, &entry_id, true).unwrap();
        let after_version = db::get_entry_local_version(&conn, &entry_id)
            .unwrap()
            .unwrap_or(0);
        set_journal_locked_impl(&conn, &journal_id, true).unwrap();
        assert!(db::get_entry(&conn, &entry_id).unwrap().unwrap().is_locked);
        assert_eq!(
            after_version,
            before_version + 1,
            "entry lock command should queue sync exactly once"
        );
        assert!(
            db::get_journal(&conn, &journal_id)
                .unwrap()
                .unwrap()
                .is_locked
        );
    }
}
