use tauri::State;

use crate::db::{self, Journal, Tag};
use crate::AppState;

/// Payload for `create_journal`. Uses a struct (rather than positional args)
/// so we can grow optional fields without breaking the JS call sites and so
/// serde field attributes propagate. `auto_tag_ids` defaults to empty —
/// auto-apply is opt-in.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJournalPayload {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub auto_tag_ids: Vec<String>,
}

/// Payload for `update_journal`. `auto_tag_ids` is `Option<Vec<String>>`:
/// - absent (`None`)        → leave the auto-apply set unchanged.
/// - present (`Some(vec)`)  → replace the auto-apply set with `vec` (empty
///                            vec = disable auto-apply entirely).
///
/// We don't need the `double_option` trick here because `Vec<String>`
/// already encodes "disable" as `[]` — there's no ambiguous third state.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateJournalPayload {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub auto_tag_ids: Option<Vec<String>>,
}

/// Create a new journal. Returns the created journal. Auto-apply tags
/// (if any) are written in the same transaction.
#[tauri::command]
pub fn create_journal(
    state: State<'_, AppState>,
    payload: CreateJournalPayload,
) -> Result<Journal, String> {
    let conn = state.lock()?;
    let journal = db::create_journal(&conn, &payload.name, payload.color.as_deref())
        .map_err(|e| e.to_string())?;
    if !payload.auto_tag_ids.is_empty() {
        db::set_journal_auto_tags(&conn, &journal.id, &payload.auto_tag_ids)
            .map_err(map_set_auto_tags_err)?;
    }
    Ok(journal)
}

/// List all journals. Invisible journals are omitted while no vault session
/// is active (`active_vault_id = None`); when `Some(V)`, only journals in
/// vault V (plus non-invisible) are returned.
#[tauri::command]
pub fn list_journals(
    state: State<'_, AppState>,
    active_vault_id: Option<String>,
) -> Result<Vec<Journal>, String> {
    let conn = state.lock()?;
    db::list_journals(&conn, active_vault_id.as_deref()).map_err(|e| e.to_string())
}

/// Get a single journal by id. Returns None if not found, or if the journal
/// is invisible and not in the active vault (mirrors `get_entry` deniability).
#[tauri::command]
pub fn get_journal(
    state: State<'_, AppState>,
    id: String,
    active_vault_id: Option<String>,
) -> Result<Option<Journal>, String> {
    get_journal_impl(&state, &id, active_vault_id.as_deref())
}

/// Shared by the Tauri command and tests so the vault gate cannot drift
/// from what production actually runs.
fn get_journal_impl(
    state: &AppState,
    id: &str,
    active_vault_id: Option<&str>,
) -> Result<Option<Journal>, String> {
    let conn = state.lock()?;
    if !db::is_journal_visible_for_active_vault(&conn, id, active_vault_id)
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    db::get_journal(&conn, id).map_err(|e| e.to_string())
}

/// Update a journal's name, color, and (optionally) auto-apply tags.
/// Returns the updated journal.
///
/// `db::update_journal` and `db::set_journal_auto_tags` each mark the
/// journal pending on the journal sync channel, so the change rides out
/// to peers on the next tick without needing to re-push every entry.
#[tauri::command]
pub fn update_journal(
    state: State<'_, AppState>,
    payload: UpdateJournalPayload,
) -> Result<Journal, String> {
    let conn = state.lock()?;
    let journal = db::update_journal(&conn, &payload.id, &payload.name, payload.color.as_deref())
        .map_err(|e| e.to_string())?;
    if let Some(tag_ids) = payload.auto_tag_ids.as_ref() {
        db::set_journal_auto_tags(&conn, &journal.id, tag_ids).map_err(map_set_auto_tags_err)?;
    }
    Ok(journal)
}

/// Delete a journal permanently. Returns an error if this is the last journal.
#[tauri::command]
pub fn delete_journal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.lock()?;
    let journals = db::list_journals(&conn, None).map_err(|e| e.to_string())?;
    if journals.len() <= 1 {
        return Err("Cannot delete the last journal".to_string());
    }
    let media_paths = db::delete_journal(&conn, &id).map_err(|e| e.to_string())?;
    // Release the global DB lock BEFORE the (potentially large) filesystem
    // cleanup so bulk unlinks don't block every other Tauri command. The DB
    // transaction already committed inside `delete_journal`.
    drop(conn);
    // Best-effort disk cleanup, only after the DB change committed.
    for (storage_path, thumbnail_path) in &media_paths {
        crate::commands::media::remove_media_files_best_effort(
            storage_path,
            thumbnail_path.as_deref(),
        );
    }
    // Re-arm the throttled own-cloud media prune so the next automatic sync
    // sweeps the deleted journal's now-orphaned cloud media blobs.
    crate::sync::engine::reset_session_own_cloud_reconciled();
    Ok(())
}

/// List the tags currently configured as auto-apply for `journal_id`.
/// Ordered by tag name ASC.
#[tauri::command]
pub fn list_journal_auto_tags(
    state: State<'_, AppState>,
    journal_id: String,
) -> Result<Vec<Tag>, String> {
    let conn = state.lock()?;
    db::list_journal_auto_tags(&conn, &journal_id).map_err(|e| e.to_string())
}

fn map_set_auto_tags_err(e: rusqlite::Error) -> String {
    let msg = e.to_string();
    // FK violation on `journal_auto_tags(tag_id)` happens when the caller
    // passes a tag id that no longer exists. SQLite's default text is
    // "FOREIGN KEY constraint failed" — surface something more actionable.
    if msg.contains("FOREIGN KEY constraint failed") {
        "One of the selected tags no longer exists".to_string()
    } else {
        msg
    }
}

#[cfg(test)]
mod tests {
    use crate::db::{self, schema::migrate, Journal};
    use crate::AppState;
    use rusqlite::Connection;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    #[test]
    fn appstate_lock_works() {
        let state = make_state();
        let conn = state.lock().expect("lock should succeed");
        let journals = db::list_journals(&conn, None).expect("list_journals should work");
        assert!(
            !journals.is_empty(),
            "at least one journal should exist after migration"
        );
    }

    #[test]
    fn create_and_list_via_db_layer() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::create_journal(&conn, "Test Journal", Some("#FF0000")).unwrap();
        let list = db::list_journals(&conn, None).unwrap();
        assert!(list.iter().any(|j| j.name == "Test Journal"));
    }

    #[test]
    fn get_journal_returns_correct_record() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let j = db::create_journal(&conn, "Alpha", Some("#112233")).unwrap();
        let fetched = db::get_journal(&conn, &j.id).unwrap();
        assert!(fetched.is_some());
        let fetched = fetched.unwrap();
        assert_eq!(fetched.id, j.id);
        assert_eq!(fetched.name, "Alpha");
        assert_eq!(fetched.color.as_deref(), Some("#112233"));
    }

    #[test]
    fn get_journal_returns_none_for_missing_id() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let result = db::get_journal(&conn, "nonexistent-0000").unwrap();
        assert!(result.is_none());
    }

    /// Phase 7 leak audit: by-id journal fetch must not return invisible
    /// journals unless the matching vault is active.
    #[test]
    fn get_journal_command_hides_invisible_unless_active_vault() {
        let state = make_state();
        let (public_id, invisible_id) = {
            let conn = state.lock().unwrap();
            let public = db::create_journal(&conn, "Public", None).unwrap();
            let invisible = db::create_journal(&conn, "Secret vault journal", None).unwrap();
            db::set_journal_invisible(&conn, &invisible.id, true, Some("vault-a")).unwrap();
            (public.id, invisible.id)
        };

        // Session locked.
        assert!(
            super::get_journal_impl(&state, &public_id, None)
                .unwrap()
                .is_some(),
            "public journal stays visible"
        );
        assert!(
            super::get_journal_impl(&state, &invisible_id, None)
                .unwrap()
                .is_none(),
            "invisible journal must not leak while locked"
        );

        // Wrong vault.
        assert!(
            super::get_journal_impl(&state, &invisible_id, Some("vault-b"))
                .unwrap()
                .is_none()
        );

        // Matching vault.
        let revealed = super::get_journal_impl(&state, &invisible_id, Some("vault-a"))
            .unwrap()
            .expect("visible under matching vault");
        assert!(revealed.is_invisible);
        assert_eq!(revealed.vault_id.as_deref(), Some("vault-a"));
    }

    #[test]
    fn update_journal_persists_changes() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let j = db::create_journal(&conn, "Old Name", None).unwrap();
        let updated = db::update_journal(&conn, &j.id, "New Name", Some("#FFCC00")).unwrap();
        assert_eq!(updated.name, "New Name");
        assert_eq!(updated.color.as_deref(), Some("#FFCC00"));
    }

    #[test]
    fn delete_journal_soft_deletes_it() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let j = db::create_journal(&conn, "Temp", None).unwrap();
        db::delete_journal(&conn, &j.id).unwrap();
        let result = db::get_journal(&conn, &j.id).unwrap();
        assert!(
            result.is_some(),
            "soft-deleted journal should still exist in DB"
        );
        assert!(
            result.unwrap().is_deleted,
            "journal should be marked as deleted"
        );
        let listed = db::list_journals(&conn, None).unwrap();
        assert!(
            !listed.iter().any(|j2| j2.id == j.id),
            "soft-deleted journal should not appear in list"
        );
    }

    fn guard_delete_journal(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
        let journals = db::list_journals(conn, None).map_err(|e| e.to_string())?;
        if journals.len() <= 1 {
            return Err("Cannot delete the last journal".to_string());
        }
        db::delete_journal(conn, id).map_err(|e| e.to_string())?;
        Ok(())
    }

    #[test]
    fn delete_last_journal_returns_error() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let journals = db::list_journals(&conn, None).unwrap();
        assert_eq!(
            journals.len(),
            1,
            "migration should seed exactly one default journal"
        );
        let result = guard_delete_journal(&conn, &journals[0].id);
        assert!(result.is_err(), "should reject deleting the last journal");
        assert!(
            result
                .unwrap_err()
                .contains("Cannot delete the last journal"),
            "error message should mention last journal"
        );
    }

    #[test]
    fn delete_journal_succeeds_when_multiple_exist() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let second = db::create_journal(&conn, "Second", None).unwrap();
        let journals = db::list_journals(&conn, None).unwrap();
        assert!(journals.len() >= 2, "should have at least two journals");
        let result = guard_delete_journal(&conn, &second.id);
        assert!(
            result.is_ok(),
            "should be able to delete a journal when others exist"
        );
        let fetched = db::get_journal(&conn, &second.id).unwrap();
        assert!(fetched.is_some(), "soft-deleted journal still exists in DB");
        assert!(
            fetched.unwrap().is_deleted,
            "journal should be marked deleted"
        );
        let remaining = db::list_journals(&conn, None).unwrap();
        assert!(!remaining.iter().any(|j| j.id == second.id));
    }

    // ── Auto-apply tags ──────────────────────────────────────────────────────

    #[test]
    fn set_and_list_journal_auto_tags() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let t1 = db::create_tag(&conn, "a", None).unwrap();
        let t2 = db::create_tag(&conn, "b", None).unwrap();
        let j = db::create_journal(&conn, "J", None).unwrap();

        db::set_journal_auto_tags(&conn, &j.id, &[t1.id.clone(), t2.id.clone()]).unwrap();

        let ids = db::list_journal_auto_tag_ids(&conn, &j.id).unwrap();
        let mut got = ids.clone();
        got.sort();
        let mut want = vec![t1.id.clone(), t2.id.clone()];
        want.sort();
        assert_eq!(got, want);

        // The Tag variant returns them ordered by name ASC.
        let tags = db::list_journal_auto_tags(&conn, &j.id).unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].name, "a");
        assert_eq!(tags[1].name, "b");
    }

    #[test]
    fn set_journal_auto_tags_replaces_existing() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let t1 = db::create_tag(&conn, "old1", None).unwrap();
        let t2 = db::create_tag(&conn, "old2", None).unwrap();
        let t3 = db::create_tag(&conn, "new", None).unwrap();
        let j = db::create_journal(&conn, "J", None).unwrap();

        db::set_journal_auto_tags(&conn, &j.id, &[t1.id.clone(), t2.id.clone()]).unwrap();
        db::set_journal_auto_tags(&conn, &j.id, &[t3.id.clone()]).unwrap();

        let ids = db::list_journal_auto_tag_ids(&conn, &j.id).unwrap();
        assert_eq!(ids, vec![t3.id]);
    }

    #[test]
    fn set_journal_auto_tags_empty_clears_all() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let t1 = db::create_tag(&conn, "t", None).unwrap();
        let j = db::create_journal(&conn, "J", None).unwrap();
        db::set_journal_auto_tags(&conn, &j.id, &[t1.id]).unwrap();

        db::set_journal_auto_tags(&conn, &j.id, &[]).unwrap();

        let ids = db::list_journal_auto_tag_ids(&conn, &j.id).unwrap();
        assert!(ids.is_empty());
    }

    #[test]
    fn delete_tag_cascades_into_journal_auto_tags() {
        let state = make_state();
        // Enable FK enforcement so the ON DELETE CASCADE actually fires.
        // `migrate()` runs `PRAGMA foreign_keys = ON;` already, but the
        // pragma is per-connection — the test's connection inherits it via
        // make_state(), so this is just a belt-and-braces assertion.
        let conn = state.lock().unwrap();
        let t1 = db::create_tag(&conn, "doomed", None).unwrap();
        let t2 = db::create_tag(&conn, "survivor", None).unwrap();
        let j = db::create_journal(&conn, "J", None).unwrap();
        db::set_journal_auto_tags(&conn, &j.id, &[t1.id.clone(), t2.id.clone()]).unwrap();

        db::delete_tag(&conn, &t1.id).unwrap();

        let ids = db::list_journal_auto_tag_ids(&conn, &j.id).unwrap();
        assert_eq!(ids, vec![t2.id], "FK CASCADE should drop the deleted tag");
    }

    #[test]
    fn delete_journal_soft_deletes_its_entries() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let j1 = db::list_journals(&conn, None).unwrap()[0].id.clone();
        let j2 = db::create_journal(&conn, "Second", None).unwrap();

        db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &j2.id,
                title: Some("Entry in J2"),
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &j1,
                title: Some("Entry in J1"),
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();

        db::delete_journal(&conn, &j2.id).unwrap();

        let j2_entries = db::list_entries(&conn, &j2.id).unwrap();
        assert!(
            j2_entries.is_empty(),
            "soft-deleted journal entries should not appear in list"
        );

        let j1_entries = db::list_entries(&conn, &j1).unwrap();
        assert_eq!(
            j1_entries.len(),
            1,
            "other journal's entries should be unaffected"
        );
    }
}
