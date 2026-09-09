use rusqlite::Connection;
use tauri::State;

use crate::db;
use crate::utils::invisible_lock::hash_invisible_lock_password;
use crate::utils::invisible_lock::verify_invisible_lock_password;
use crate::AppState;

/// Minimum length for an invisible-lock password. Counted in Unicode code
/// points so multi-byte characters (emoji, accents, etc.) count as one each.
pub(crate) const MIN_INVISIBLE_PASSWORD_LEN: usize = 4;

/// Generic error for flag/vault updates — avoids leaking whether a vault
/// exists, is configured, or was empty (deniability).
const UNABLE_TO_UPDATE: &str = "Unable to update";

fn validate_invisible_lock_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_INVISIBLE_PASSWORD_LEN {
        Err(format!(
            "Invisible-lock password must be at least {} characters",
            MIN_INVISIBLE_PASSWORD_LEN
        ))
    } else {
        Ok(())
    }
}

/// Open matching vault or create a new empty vault for `password`.
/// Returns only the vault id — never whether created vs matched.
pub(crate) fn open_or_create_invisible_vault_impl(
    conn: &Connection,
    password: &str,
) -> Result<String, String> {
    validate_invisible_lock_password(password)?;
    if let Some(id) = db::find_vault_id_by_password(conn, password).map_err(|e| e.to_string())? {
        return Ok(id);
    }
    let verifier = hash_invisible_lock_password(password)?;
    let vault = db::insert_invisible_vault(conn, &verifier).map_err(|e| e.to_string())?;
    Ok(vault.id)
}

/// Change password for `vault_id`. If `new` already opens vault B, MERGE
/// this vault into B and return B's id; otherwise re-key and return same id.
pub(crate) fn change_invisible_vault_password_impl(
    conn: &Connection,
    vault_id: &str,
    current: &str,
    new: &str,
) -> Result<String, String> {
    validate_invisible_lock_password(new)?;

    let vault = db::get_invisible_vault(conn, vault_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| UNABLE_TO_UPDATE.to_string())?;

    if !verify_invisible_lock_password(current, &vault.verifier) {
        return Err("Invalid invisible-lock password".to_string());
    }

    // If `new` already opens another vault B → MERGE into B.
    if let Some(other_id) = db::find_vault_id_by_password(conn, new).map_err(|e| e.to_string())? {
        if other_id != vault_id {
            db::merge_vaults(conn, vault_id, &other_id).map_err(|e| e.to_string())?;
            return Ok(other_id);
        }
        // Same vault already matches `new` (re-key to same password): still
        // refresh the PHC so updated_at moves and salts rotate.
    }

    let verifier = hash_invisible_lock_password(new)?;
    db::update_invisible_vault_verifier(conn, vault_id, &verifier).map_err(|e| e.to_string())?;
    Ok(vault_id.to_string())
}

pub(crate) fn remove_empty_invisible_vaults_impl(conn: &Connection) -> Result<(), String> {
    db::delete_empty_invisible_vaults(conn).map_err(|e| e.to_string())
}

fn require_existing_vault(conn: &Connection, vault_id: &str) -> Result<(), String> {
    match db::get_invisible_vault(conn, vault_id).map_err(|e| e.to_string())? {
        Some(_) => Ok(()),
        None => Err(UNABLE_TO_UPDATE.to_string()),
    }
}

pub(crate) fn set_entry_invisible_impl(
    conn: &Connection,
    entry_id: &str,
    invisible: bool,
    active_vault_id: Option<&str>,
) -> Result<(), String> {
    if invisible {
        let vault_id = active_vault_id.ok_or_else(|| UNABLE_TO_UPDATE.to_string())?;
        require_existing_vault(conn, vault_id)?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        db::set_entry_invisible(&tx, entry_id, true, Some(vault_id)).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    } else {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        db::set_entry_invisible(&tx, entry_id, false, None).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
}

pub(crate) fn set_journal_invisible_impl(
    conn: &Connection,
    journal_id: &str,
    invisible: bool,
    active_vault_id: Option<&str>,
) -> Result<(), String> {
    if invisible {
        let vault_id = active_vault_id.ok_or_else(|| UNABLE_TO_UPDATE.to_string())?;
        require_existing_vault(conn, vault_id)?;
        // set_journal_invisible opens its own tx (includes cascade).
        db::set_journal_invisible(conn, journal_id, true, Some(vault_id)).map_err(|e| e.to_string())
    } else {
        db::set_journal_invisible(conn, journal_id, false, None).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn open_or_create_invisible_vault(
    state: State<'_, AppState>,
    password: String,
) -> Result<String, String> {
    let conn = state.lock()?;
    open_or_create_invisible_vault_impl(&conn, &password)
}

#[tauri::command]
pub fn change_invisible_vault_password(
    state: State<'_, AppState>,
    vault_id: String,
    current: String,
    new: String,
) -> Result<String, String> {
    let conn = state.lock()?;
    change_invisible_vault_password_impl(&conn, &vault_id, &current, &new)
}

#[tauri::command]
pub fn remove_empty_invisible_vaults(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.lock()?;
    remove_empty_invisible_vaults_impl(&conn)
}

#[tauri::command]
pub fn set_entry_invisible(
    state: State<'_, AppState>,
    entry_id: String,
    invisible: bool,
    active_vault_id: Option<String>,
) -> Result<(), String> {
    let conn = state.lock()?;
    set_entry_invisible_impl(&conn, &entry_id, invisible, active_vault_id.as_deref())
}

#[tauri::command]
pub fn set_journal_invisible(
    state: State<'_, AppState>,
    journal_id: String,
    invisible: bool,
    active_vault_id: Option<String>,
) -> Result<(), String> {
    let conn = state.lock()?;
    set_journal_invisible_impl(&conn, &journal_id, invisible, active_vault_id.as_deref())
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

    // ── 3.1 open_or_create_invisible_vault ──────────────────────────────

    #[test]
    fn open_or_create_creates_vault_then_matches_same_password() {
        let conn = setup();
        let first = open_or_create_invisible_vault_impl(&conn, "secret one").unwrap();
        let second = open_or_create_invisible_vault_impl(&conn, "secret one").unwrap();
        assert_eq!(first, second, "same password must reopen the same vault");

        let other = open_or_create_invisible_vault_impl(&conn, "secret two").unwrap();
        assert_ne!(first, other, "different password creates a second vault");

        let listed = db::list_invisible_vaults(&conn).unwrap();
        assert_eq!(listed.len(), 2);
    }

    #[test]
    fn open_or_create_rejects_short_password() {
        let conn = setup();
        let err = open_or_create_invisible_vault_impl(&conn, "abc").unwrap_err();
        assert!(err.contains("at least 4 characters"));
        assert!(db::list_invisible_vaults(&conn).unwrap().is_empty());
    }

    #[test]
    fn open_or_create_accepts_minimum_length_unicode() {
        let conn = setup();
        // 4 Unicode scalars: a, 😊, b, space
        let id = open_or_create_invisible_vault_impl(&conn, "a😊b ").unwrap();
        assert_eq!(
            open_or_create_invisible_vault_impl(&conn, "a😊b ").unwrap(),
            id
        );
    }

    // ── 3.2 change_invisible_vault_password ─────────────────────────────

    #[test]
    fn change_password_rekeys_vault() {
        let conn = setup();
        let vault_id = open_or_create_invisible_vault_impl(&conn, "old-pass").unwrap();
        let returned =
            change_invisible_vault_password_impl(&conn, &vault_id, "old-pass", "new-pass").unwrap();
        assert_eq!(returned, vault_id);

        // Old password no longer opens anything; new password reopens same id.
        let old_match = db::find_vault_id_by_password(&conn, "old-pass").unwrap();
        assert!(old_match.is_none());
        assert_eq!(
            open_or_create_invisible_vault_impl(&conn, "new-pass").unwrap(),
            vault_id
        );
    }

    #[test]
    fn change_password_merges_into_existing_vault() {
        let conn = setup();
        let vault_a = open_or_create_invisible_vault_impl(&conn, "pass-a").unwrap();
        let vault_b = open_or_create_invisible_vault_impl(&conn, "pass-b").unwrap();

        let entry_id = make_entry(&conn);
        set_entry_invisible_impl(&conn, &entry_id, true, Some(&vault_a)).unwrap();

        let active =
            change_invisible_vault_password_impl(&conn, &vault_a, "pass-a", "pass-b").unwrap();
        assert_eq!(active, vault_b, "merge must return destination vault id");

        assert!(db::get_invisible_vault(&conn, &vault_a).unwrap().is_none());
        assert!(db::get_invisible_vault(&conn, &vault_b).unwrap().is_some());
        let entry = db::get_entry(&conn, &entry_id).unwrap().unwrap();
        assert_eq!(entry.vault_id.as_deref(), Some(vault_b.as_str()));
    }

    #[test]
    fn change_password_rejects_wrong_current() {
        let conn = setup();
        let vault_id = open_or_create_invisible_vault_impl(&conn, "correct").unwrap();
        let err = change_invisible_vault_password_impl(&conn, &vault_id, "wrong", "new-pass")
            .unwrap_err();
        assert!(err.contains("Invalid invisible-lock password"));
        // Vault still opens with original password.
        assert_eq!(
            open_or_create_invisible_vault_impl(&conn, "correct").unwrap(),
            vault_id
        );
    }

    #[test]
    fn change_password_rejects_short_new_password() {
        let conn = setup();
        let vault_id = open_or_create_invisible_vault_impl(&conn, "correct").unwrap();
        let err =
            change_invisible_vault_password_impl(&conn, &vault_id, "correct", "abc").unwrap_err();
        assert!(err.contains("at least 4 characters"));
    }

    #[test]
    fn change_password_unknown_vault_is_generic() {
        let conn = setup();
        let err =
            change_invisible_vault_password_impl(&conn, "missing-id", "x", "new-pass").unwrap_err();
        assert_eq!(err, UNABLE_TO_UPDATE);
    }

    // ── 3.3 remove_empty_invisible_vaults ───────────────────────────────

    #[test]
    fn remove_empty_keeps_non_empty_removes_empty() {
        let conn = setup();
        let empty = open_or_create_invisible_vault_impl(&conn, "empty-pass").unwrap();
        let owned = open_or_create_invisible_vault_impl(&conn, "owned-pass").unwrap();
        let entry_id = make_entry(&conn);
        set_entry_invisible_impl(&conn, &entry_id, true, Some(&owned)).unwrap();

        remove_empty_invisible_vaults_impl(&conn).unwrap();

        assert!(db::get_invisible_vault(&conn, &empty).unwrap().is_none());
        assert!(db::get_invisible_vault(&conn, &owned).unwrap().is_some());
        // Zero empties → still Ok(())
        remove_empty_invisible_vaults_impl(&conn).unwrap();
        assert!(db::get_invisible_vault(&conn, &owned).unwrap().is_some());
    }

    // ── 3.4 flag setters ────────────────────────────────────────────────

    #[test]
    fn flag_setters_require_existing_vault_and_use_generic_error() {
        let conn = setup();
        let entry_id = make_entry(&conn);
        let journal_id = db::get_entry(&conn, &entry_id).unwrap().unwrap().journal_id;

        // No active vault id.
        assert_eq!(
            set_entry_invisible_impl(&conn, &entry_id, true, None).unwrap_err(),
            UNABLE_TO_UPDATE
        );
        assert_eq!(
            set_journal_invisible_impl(&conn, &journal_id, true, None).unwrap_err(),
            UNABLE_TO_UPDATE
        );

        // Unknown vault id.
        assert_eq!(
            set_entry_invisible_impl(&conn, &entry_id, true, Some("nope")).unwrap_err(),
            UNABLE_TO_UPDATE
        );
        assert_eq!(
            set_journal_invisible_impl(&conn, &journal_id, true, Some("nope")).unwrap_err(),
            UNABLE_TO_UPDATE
        );
    }

    #[test]
    fn flag_setters_bind_clear_and_clear_second_lock() {
        let conn = setup();
        let entry_id = make_entry(&conn);
        let journal_id = db::get_entry(&conn, &entry_id).unwrap().unwrap().journal_id;
        let vault = open_or_create_invisible_vault_impl(&conn, "secret").unwrap();

        db::set_entry_locked(&conn, &entry_id, true).unwrap();
        db::set_journal_locked(&conn, &journal_id, true).unwrap();
        let before_version = db::get_entry_local_version(&conn, &entry_id)
            .unwrap()
            .unwrap_or(0);

        set_entry_invisible_impl(&conn, &entry_id, true, Some(&vault)).unwrap();
        let after_version = db::get_entry_local_version(&conn, &entry_id)
            .unwrap()
            .unwrap_or(0);
        set_journal_invisible_impl(&conn, &journal_id, true, Some(&vault)).unwrap();

        let entry = db::get_entry(&conn, &entry_id).unwrap().unwrap();
        let journal = db::get_journal(&conn, &journal_id).unwrap().unwrap();
        assert!(entry.is_invisible);
        assert_eq!(entry.vault_id.as_deref(), Some(vault.as_str()));
        assert!(!entry.is_locked);
        assert_eq!(
            after_version,
            before_version + 1,
            "entry invisible command should queue sync exactly once"
        );
        assert!(journal.is_invisible);
        assert_eq!(journal.vault_id.as_deref(), Some(vault.as_str()));
        assert!(!journal.is_locked);

        // Clear flags.
        set_entry_invisible_impl(&conn, &entry_id, false, None).unwrap();
        set_journal_invisible_impl(&conn, &journal_id, false, None).unwrap();
        let entry = db::get_entry(&conn, &entry_id).unwrap().unwrap();
        let journal = db::get_journal(&conn, &journal_id).unwrap().unwrap();
        assert!(!entry.is_invisible);
        assert!(entry.vault_id.is_none());
        assert!(!journal.is_invisible);
        assert!(journal.vault_id.is_none());
    }

    #[test]
    fn set_journal_invisible_cascades_child_entry_vault() {
        let conn = setup();
        let vault_a = open_or_create_invisible_vault_impl(&conn, "pass-a").unwrap();
        let vault_b = open_or_create_invisible_vault_impl(&conn, "pass-b").unwrap();
        let entry_id = make_entry(&conn);
        let journal_id = db::get_entry(&conn, &entry_id).unwrap().unwrap().journal_id;

        // Entry first in vault A.
        set_entry_invisible_impl(&conn, &entry_id, true, Some(&vault_a)).unwrap();
        // Journal mark to vault B must reassign the child.
        set_journal_invisible_impl(&conn, &journal_id, true, Some(&vault_b)).unwrap();

        let entry = db::get_entry(&conn, &entry_id).unwrap().unwrap();
        assert!(entry.is_invisible);
        assert_eq!(
            entry.vault_id.as_deref(),
            Some(vault_b.as_str()),
            "cascade must rebind child invisible entries to journal vault"
        );
    }
}
