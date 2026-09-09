use std::collections::HashMap;

use tauri::State;

use crate::db::{self, Tag};
use crate::AppState;

/// Create a new tag. Returns the created tag.
#[tauri::command]
pub fn create_tag(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
) -> Result<Tag, String> {
    let conn = state.lock()?;
    db::create_tag(&conn, &name, color.as_deref()).map_err(|e| e.to_string())
}

/// List all tags ordered by name.
#[tauri::command]
pub fn list_tags(
    state: State<'_, AppState>,
    active_vault_id: Option<String>,
) -> Result<Vec<Tag>, String> {
    let conn = state.lock()?;
    list_tags_impl(&conn, active_vault_id.as_deref())
}

pub(crate) fn list_tags_impl(
    conn: &rusqlite::Connection,
    active_vault_id: Option<&str>,
) -> Result<Vec<Tag>, String> {
    db::list_tags(conn, active_vault_id).map_err(|e| e.to_string())
}

/// Delete a tag by id.
#[tauri::command]
pub fn delete_tag(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_tag(&conn, &id).map_err(|e| e.to_string())
}

/// Tri-state deserializer for an optional-nullable field.
///
/// Stock serde collapses `Option<Option<T>>` so JSON `null` and a missing
/// field both decode to `None` — making "clear the value" indistinguishable
/// from "leave it unchanged". This helper, paired with `#[serde(default)]`,
/// gives us the real three-state form:
///   field absent  → `None`              ("leave unchanged")
///   field is null → `Some(None)`        ("clear")
///   field is "x"  → `Some(Some("x"))`   ("set to x")
fn double_option<'de, T, D>(d: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    Ok(Some(Option::<T>::deserialize(d)?))
}

/// Payload for `update_tag`. A single struct argument is what unlocks serde
/// field attributes — Tauri's `#[tauri::command]` macro doesn't propagate
/// them to individual parameters, but it does respect them on a derived
/// payload type.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTagPayload {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
}

/// Update a tag's name and/or color. Returns the updated tag.
///
/// Frontend payload shape:
///   { id, name?, color?: string | null }
/// `color: undefined` (field absent) means "don't touch",
/// `color: null` means "clear",
/// `color: "#RRGGBB"` means "set to that value".
#[tauri::command]
pub fn update_tag(
    state: State<'_, AppState>,
    payload: UpdateTagPayload,
) -> Result<db::Tag, String> {
    let conn = state.lock()?;
    db::update_tag(
        &conn,
        &payload.id,
        payload.name.as_deref(),
        payload.color.as_ref().map(|c| c.as_deref()),
    )
    .map_err(|e| {
        let msg = e.to_string();
        // SQLite raises "UNIQUE constraint failed: tags.name" on rename clash.
        // Surface a friendly message so the UI doesn't need to parse SQL errors.
        if msg.contains("UNIQUE constraint failed") && msg.contains("tags.name") {
            "A tag with that name already exists".to_string()
        } else {
            msg
        }
    })
}

/// Wrap `entry_tags` insert + `touch_entry_updated_at` + `mark_entry_pending`
/// in one transaction so the tag change and the pending mark are atomic.
pub(crate) fn add_tag_to_entry_impl(
    conn: &rusqlite::Connection,
    entry_id: &str,
    tag_id: &str,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::add_tag_to_entry(&tx, entry_id, tag_id).map_err(|e| e.to_string())?;
    db::touch_entry_updated_at(&tx, entry_id).map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, entry_id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Wrap `entry_tags` delete + `touch_entry_updated_at` + `mark_entry_pending`
/// in one transaction so the tag removal and the pending mark are atomic.
pub(crate) fn remove_tag_from_entry_impl(
    conn: &rusqlite::Connection,
    entry_id: &str,
    tag_id: &str,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::remove_tag_from_entry(&tx, entry_id, tag_id).map_err(|e| e.to_string())?;
    db::touch_entry_updated_at(&tx, entry_id).map_err(|e| e.to_string())?;
    db::mark_entry_pending(&tx, entry_id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Associate a tag with an entry.
#[tauri::command]
pub fn add_tag_to_entry(
    state: State<'_, AppState>,
    entry_id: String,
    tag_id: String,
) -> Result<(), String> {
    let conn = state.lock()?;
    add_tag_to_entry_impl(&conn, &entry_id, &tag_id)
}

/// Remove a tag association from an entry.
#[tauri::command]
pub fn remove_tag_from_entry(
    state: State<'_, AppState>,
    entry_id: String,
    tag_id: String,
) -> Result<(), String> {
    let conn = state.lock()?;
    remove_tag_from_entry_impl(&conn, &entry_id, &tag_id)
}

/// Get all tags associated with an entry.
#[tauri::command]
pub fn get_tags_for_entry(
    state: State<'_, AppState>,
    entry_id: String,
    active_vault_id: Option<String>,
) -> Result<Vec<Tag>, String> {
    let conn = state.lock()?;
    get_tags_for_entry_impl(&conn, &entry_id, active_vault_id.as_deref())
}

pub(crate) fn get_tags_for_entry_impl(
    conn: &rusqlite::Connection,
    entry_id: &str,
    active_vault_id: Option<&str>,
) -> Result<Vec<Tag>, String> {
    if !db::is_entry_visible_for_active_vault(conn, entry_id, active_vault_id.as_deref())
        .map_err(|e| e.to_string())?
    {
        return Ok(Vec::new());
    }
    db::get_tags_for_entry(conn, entry_id).map_err(|e| e.to_string())
}

/// Get tags associated with multiple entries in one batched query.
#[tauri::command]
pub fn get_tags_for_entries(
    state: State<'_, AppState>,
    entry_ids: Vec<String>,
    active_vault_id: Option<String>,
) -> Result<HashMap<String, Vec<Tag>>, String> {
    let conn = state.lock()?;
    get_tags_for_entries_impl(&conn, &entry_ids, active_vault_id.as_deref())
}

pub(crate) fn get_tags_for_entries_impl(
    conn: &rusqlite::Connection,
    entry_ids: &[String],
    active_vault_id: Option<&str>,
) -> Result<HashMap<String, Vec<Tag>>, String> {
    let mut visible_entry_ids = Vec::with_capacity(entry_ids.len());
    for entry_id in entry_ids {
        if db::is_entry_visible_for_active_vault(conn, entry_id, active_vault_id.as_deref())
            .map_err(|e| e.to_string())?
        {
            visible_entry_ids.push(entry_id.clone());
        }
    }
    db::get_tags_for_entries(conn, &visible_entry_ids).map_err(|e| e.to_string())
}

/// List all tags with their non-deleted entry counts.
/// Returns `Vec<(Tag, u64)>` serialised as a JSON array of `[Tag, number]` pairs.
#[tauri::command]
pub fn get_tags_with_counts(
    state: State<'_, AppState>,
    active_vault_id: Option<String>,
) -> Result<Vec<(Tag, u64)>, String> {
    let conn = state.lock()?;
    get_tags_with_counts_impl(&conn, active_vault_id.as_deref())
}

pub(crate) fn get_tags_with_counts_impl(
    conn: &rusqlite::Connection,
    active_vault_id: Option<&str>,
) -> Result<Vec<(Tag, u64)>, String> {
    db::list_tags_with_counts(conn, active_vault_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        get_tags_for_entries_impl, get_tags_for_entry_impl, get_tags_with_counts_impl,
        list_tags_impl,
    };
    use crate::db::{self, schema::migrate, CreateEntryParams};
    use crate::AppState;
    use rusqlite::Connection;

    // ── helpers ──────────────────────────────────────────────────────────────

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    fn make_journal(state: &AppState, name: &str) -> String {
        let conn = state.lock().unwrap();
        db::create_journal(&conn, name, None).unwrap().id
    }

    fn make_entry(state: &AppState, journal_id: &str, title: &str) -> String {
        let conn = state.lock().unwrap();
        db::create_entry(
            &conn,
            CreateEntryParams {
                journal_id,
                title: Some(title),
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn tag_list_impls_pass_active_vault_through() {
        // Guards the command-layer seam: a reversion to `None` here would
        // typecheck and pass every db-layer test while shipping a no-op.
        let state = make_state();
        let jid = make_journal(&state, "J");
        let eid = make_entry(&state, &jid, "Hidden");
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "vault-tag", None).unwrap();
        db::add_tag_to_entry(&conn, &eid, &tag.id).unwrap();
        db::set_entry_invisible(&conn, &eid, true, Some("vault-1")).unwrap();

        let hidden = list_tags_impl(&conn, None).unwrap();
        assert!(!hidden.iter().any(|t| t.id == tag.id));
        let visible = list_tags_impl(&conn, Some("vault-1")).unwrap();
        assert!(visible.iter().any(|t| t.id == tag.id));

        let hidden_counts = get_tags_with_counts_impl(&conn, None).unwrap();
        assert!(!hidden_counts.iter().any(|(t, _)| t.id == tag.id));
        let visible_counts = get_tags_with_counts_impl(&conn, Some("vault-1")).unwrap();
        assert!(visible_counts
            .iter()
            .any(|(t, c)| t.id == tag.id && *c == 1));
    }

    #[test]
    fn create_tag_roundtrip() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "rust", Some("#FF6600")).unwrap();
        assert_eq!(tag.name, "rust");
        assert_eq!(tag.color.as_deref(), Some("#FF6600"));
    }

    #[test]
    fn list_tags_returns_all() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::create_tag(&conn, "alpha", None).unwrap();
        db::create_tag(&conn, "beta", Some("#AABBCC")).unwrap();
        let tags = db::list_tags(&conn, None).unwrap();
        assert!(tags.len() >= 2);
        assert!(tags.iter().any(|t| t.name == "alpha"));
        assert!(tags.iter().any(|t| t.name == "beta"));
    }

    #[test]
    fn delete_tag_removes_record() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "temp", None).unwrap();
        db::delete_tag(&conn, &tag.id).unwrap();
        let tags = db::list_tags(&conn, None).unwrap();
        assert!(!tags.iter().any(|t| t.id == tag.id));
    }

    #[test]
    fn add_tag_to_entry_and_retrieve() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let eid = make_entry(&state, &jid, "My Entry");
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "tagged", None).unwrap();
        db::add_tag_to_entry(&conn, &eid, &tag.id).unwrap();
        let entry_tags = db::get_tags_for_entry(&conn, &eid).unwrap();
        assert_eq!(entry_tags.len(), 1);
        assert_eq!(entry_tags[0].name, "tagged");
    }

    #[test]
    fn remove_tag_from_entry_clears_association() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let eid = make_entry(&state, &jid, "Entry");
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "removeme", None).unwrap();
        db::add_tag_to_entry(&conn, &eid, &tag.id).unwrap();
        db::remove_tag_from_entry(&conn, &eid, &tag.id).unwrap();
        let entry_tags = db::get_tags_for_entry(&conn, &eid).unwrap();
        assert!(entry_tags.is_empty());
    }

    #[test]
    fn get_tags_for_entry_returns_only_entry_tags() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let eid1 = make_entry(&state, &jid, "Entry1");
        let eid2 = make_entry(&state, &jid, "Entry2");
        let conn = state.lock().unwrap();
        let t1 = db::create_tag(&conn, "tag1", None).unwrap();
        let t2 = db::create_tag(&conn, "tag2", None).unwrap();
        db::add_tag_to_entry(&conn, &eid1, &t1.id).unwrap();
        db::add_tag_to_entry(&conn, &eid2, &t2.id).unwrap();
        let tags = db::get_tags_for_entry(&conn, &eid1).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].id, t1.id);
    }

    #[test]
    fn get_tags_for_entry_hides_invisible_entry_tags_by_default() {
        let state = make_state();
        let visible_jid = make_journal(&state, "J");
        let invisible_jid = make_journal(&state, "Invisible J");
        let visible_eid = make_entry(&state, &visible_jid, "Visible");
        let direct_invisible_eid = make_entry(&state, &visible_jid, "Direct invisible");
        let inherited_invisible_eid = make_entry(&state, &invisible_jid, "Inherited invisible");
        let conn = state.lock().unwrap();
        let visible_tag = db::create_tag(&conn, "visible", None).unwrap();
        let direct_hidden_tag = db::create_tag(&conn, "direct-hidden", None).unwrap();
        let inherited_hidden_tag = db::create_tag(&conn, "inherited-hidden", None).unwrap();
        db::add_tag_to_entry(&conn, &visible_eid, &visible_tag.id).unwrap();
        db::add_tag_to_entry(&conn, &direct_invisible_eid, &direct_hidden_tag.id).unwrap();
        db::add_tag_to_entry(&conn, &inherited_invisible_eid, &inherited_hidden_tag.id).unwrap();
        db::set_entry_invisible(&conn, &direct_invisible_eid, true, Some("test-vault")).unwrap();
        db::set_journal_invisible(&conn, &invisible_jid, true, Some("test-vault")).unwrap();

        assert_eq!(
            get_tags_for_entry_impl(&conn, &visible_eid, None)
                .unwrap()
                .len(),
            1
        );
        assert!(get_tags_for_entry_impl(&conn, &direct_invisible_eid, None)
            .unwrap()
            .is_empty());
        assert!(
            get_tags_for_entry_impl(&conn, &inherited_invisible_eid, None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            get_tags_for_entry_impl(&conn, &direct_invisible_eid, Some("test-vault"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            get_tags_for_entry_impl(&conn, &inherited_invisible_eid, Some("test-vault"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn get_tags_for_entries_filters_effectively_invisible_entries_per_id() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let invisible_jid = make_journal(&state, "Invisible J");
        let visible_eid = make_entry(&state, &jid, "Visible");
        let direct_invisible_eid = make_entry(&state, &jid, "Direct invisible");
        let inherited_invisible_eid = make_entry(&state, &invisible_jid, "Inherited invisible");
        let conn = state.lock().unwrap();
        let visible_tag = db::create_tag(&conn, "visible", None).unwrap();
        let direct_invisible_tag = db::create_tag(&conn, "direct-invisible", None).unwrap();
        let inherited_invisible_tag = db::create_tag(&conn, "inherited-invisible", None).unwrap();
        db::add_tag_to_entry(&conn, &visible_eid, &visible_tag.id).unwrap();
        db::add_tag_to_entry(&conn, &direct_invisible_eid, &direct_invisible_tag.id).unwrap();
        db::add_tag_to_entry(&conn, &inherited_invisible_eid, &inherited_invisible_tag.id).unwrap();
        db::set_entry_invisible(&conn, &direct_invisible_eid, true, Some("test-vault")).unwrap();
        db::set_journal_invisible(&conn, &invisible_jid, true, Some("test-vault")).unwrap();
        let entry_ids = vec![
            visible_eid.clone(),
            direct_invisible_eid.clone(),
            inherited_invisible_eid.clone(),
        ];

        let hidden = get_tags_for_entries_impl(&conn, &entry_ids, None).unwrap();
        assert_eq!(hidden[&visible_eid][0].id, visible_tag.id);
        assert!(!hidden.contains_key(&direct_invisible_eid));
        assert!(!hidden.contains_key(&inherited_invisible_eid));

        let revealed = get_tags_for_entries_impl(&conn, &entry_ids, Some("test-vault")).unwrap();
        assert_eq!(revealed[&visible_eid][0].id, visible_tag.id);
        assert_eq!(
            revealed[&direct_invisible_eid][0].id,
            direct_invisible_tag.id
        );
        assert_eq!(
            revealed[&inherited_invisible_eid][0].id,
            inherited_invisible_tag.id
        );
    }

    #[test]
    fn get_tags_for_entries_returns_empty_map_for_empty_ids() {
        let state = make_state();
        let conn = state.lock().unwrap();

        let tags = get_tags_for_entries_impl(&conn, &[], None).unwrap();

        assert!(tags.is_empty());
    }

    #[test]
    fn get_tags_for_entries_omits_unknown_id() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let unknown_id = "unknown-entry".to_string();

        let tags =
            get_tags_for_entries_impl(&conn, std::slice::from_ref(&unknown_id), None).unwrap();

        assert!(!tags.contains_key(&unknown_id));
    }

    #[test]
    fn get_tags_for_entries_returns_name_sorted_tags_for_each_entry() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let first_eid = make_entry(&state, &jid, "First");
        let second_eid = make_entry(&state, &jid, "Second");
        let conn = state.lock().unwrap();
        let alpha = db::create_tag(&conn, "alpha", None).unwrap();
        let beta = db::create_tag(&conn, "beta", None).unwrap();
        let zeta = db::create_tag(&conn, "zeta", None).unwrap();
        db::add_tag_to_entry(&conn, &first_eid, &zeta.id).unwrap();
        db::add_tag_to_entry(&conn, &first_eid, &alpha.id).unwrap();
        db::add_tag_to_entry(&conn, &second_eid, &beta.id).unwrap();
        let entry_ids = vec![first_eid.clone(), second_eid.clone()];

        let tags = get_tags_for_entries_impl(&conn, &entry_ids, None).unwrap();

        let first_names: Vec<_> = tags[&first_eid]
            .iter()
            .map(|tag| tag.name.as_str())
            .collect();
        let second_names: Vec<_> = tags[&second_eid]
            .iter()
            .map(|tag| tag.name.as_str())
            .collect();
        assert_eq!(first_names, ["alpha", "zeta"]);
        assert_eq!(second_names, ["beta"]);
    }

    #[test]
    fn get_tags_for_entries_omits_entry_with_only_soft_deleted_tag() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let eid = make_entry(&state, &jid, "Entry");
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "deleted", None).unwrap();
        db::add_tag_to_entry(&conn, &eid, &tag.id).unwrap();
        db::delete_tag(&conn, &tag.id).unwrap();

        let tags = get_tags_for_entries_impl(&conn, std::slice::from_ref(&eid), None).unwrap();

        assert!(!tags.contains_key(&eid));
    }

    /// Pins the tri-state JSON semantics the rest of the system relies on.
    /// Stock `Option<Option<T>>` collapses `null` and missing to `None` —
    /// the `double_option` deserializer in `UpdateTagPayload` is what makes
    /// "clear color" distinguishable from "leave color alone". If this test
    /// ever fails, the "✕ No color" flow in the UI silently no-ops.
    #[test]
    fn update_tag_payload_distinguishes_null_from_missing_color() {
        use super::UpdateTagPayload;
        let missing: UpdateTagPayload =
            serde_json::from_str(r#"{"id":"t1"}"#).expect("decode missing");
        let null_val: UpdateTagPayload =
            serde_json::from_str(r#"{"id":"t1","color":null}"#).expect("decode null");
        let string_val: UpdateTagPayload =
            serde_json::from_str(r##"{"id":"t1","color":"#abcdef"}"##).expect("decode string");
        assert_eq!(missing.color, None, "missing must be None (leave alone)");
        assert_eq!(
            null_val.color,
            Some(None),
            "null must be Some(None) (clear)"
        );
        assert_eq!(
            string_val.color,
            Some(Some("#abcdef".to_string())),
            "string must be Some(Some(_))",
        );
    }

    #[test]
    fn update_tag_renames_and_recolors() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "old", Some("#111111")).unwrap();
        let updated = db::update_tag(&conn, &tag.id, Some("new"), Some(Some("#222222"))).unwrap();
        assert_eq!(updated.name, "new");
        assert_eq!(updated.color.as_deref(), Some("#222222"));
    }

    #[test]
    fn update_tag_clears_color_when_explicit_none() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "colored", Some("#abcdef")).unwrap();
        let updated = db::update_tag(&conn, &tag.id, None, Some(None)).unwrap();
        assert_eq!(updated.color, None);
    }

    #[test]
    fn update_tag_name_only_keeps_color() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "a", Some("#abcdef")).unwrap();
        let updated = db::update_tag(&conn, &tag.id, Some("b"), None).unwrap();
        assert_eq!(updated.name, "b");
        assert_eq!(updated.color.as_deref(), Some("#abcdef"));
    }

    #[test]
    fn update_tag_rejects_invalid_color() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "t", None).unwrap();
        let err = db::update_tag(&conn, &tag.id, None, Some(Some("red"))).unwrap_err();
        assert!(err.to_string().contains("invalid tag color"));
    }

    #[test]
    fn update_tag_rejects_empty_name() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "t", None).unwrap();
        let err = db::update_tag(&conn, &tag.id, Some("   "), None).unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[test]
    fn create_tag_rejects_empty_name() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let err = db::create_tag(&conn, "   ", None).unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[test]
    fn create_tag_trims_name() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "  work  ", None).unwrap();
        assert_eq!(tag.name, "work");
    }

    #[test]
    fn update_tag_duplicate_name_errors() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::create_tag(&conn, "taken", None).unwrap();
        let other = db::create_tag(&conn, "other", None).unwrap();
        let err = db::update_tag(&conn, &other.id, Some("taken"), None).unwrap_err();
        assert!(err.to_string().contains("UNIQUE"));
    }

    #[test]
    fn add_duplicate_tag_to_entry_is_idempotent() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let eid = make_entry(&state, &jid, "Entry");
        let conn = state.lock().unwrap();
        let tag = db::create_tag(&conn, "dup", None).unwrap();
        // Adding the same tag twice should not error (INSERT OR IGNORE)
        db::add_tag_to_entry(&conn, &eid, &tag.id).unwrap();
        db::add_tag_to_entry(&conn, &eid, &tag.id).unwrap();
        let entry_tags = db::get_tags_for_entry(&conn, &eid).unwrap();
        assert_eq!(entry_tags.len(), 1);
    }

    // ── sync regression tests ─────────────────────────────────────────────────
    //
    // Regression: add_tag_to_entry / remove_tag_from_entry were not calling
    // mark_entry_pending, so tag changes never entered the sync queue.

    /// Returns the (local_version, sync_status) sync_state row for an entry,
    /// or None if no row exists yet.
    fn sync_row(state: &AppState, entry_id: &str) -> Option<(i64, String)> {
        let conn = state.lock().unwrap();
        conn.query_row(
            "SELECT local_version, sync_status FROM sync_state WHERE entry_id = ?1",
            [entry_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .ok()
    }

    /// Create an entry via the command-layer impl (marks it pending at v1),
    /// then mark it synced so we have a clean `synced` baseline to test
    /// that the tag operations flip it back to `pending`.
    fn make_synced_entry(state: &AppState, journal_id: &str, title: &str) -> String {
        use crate::commands::entries::create_entry_impl;
        let eid = {
            let conn = state.lock().unwrap();
            create_entry_impl(&conn, journal_id, Some(title), None, None, 1_700_000_000)
                .unwrap()
                .id
        };
        // Force a known `synced` baseline so the test isn't a false positive
        // from the initial pending state left by create_entry_impl.
        {
            let conn = state.lock().unwrap();
            db::queries::mark_entry_synced(&conn, &eid, 1).unwrap();
        }
        eid
    }

    #[test]
    fn add_tag_to_entry_marks_entry_pending() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let eid = make_synced_entry(&state, &jid, "Tagged Entry");
        // Precondition: entry is synced.
        let (_, status) = sync_row(&state, &eid).unwrap();
        assert_eq!(status, "synced", "precondition: entry must start synced");

        let tag_id = {
            let conn = state.lock().unwrap();
            db::create_tag(&conn, "sync-test", None).unwrap().id
        };

        // Act.
        {
            let conn = state.lock().unwrap();
            super::add_tag_to_entry_impl(&conn, &eid, &tag_id).unwrap();
        }

        // Assert: sync_status flipped to pending.
        let (local_version, status) = sync_row(&state, &eid).unwrap();
        assert_eq!(
            status, "pending",
            "sync_status must be 'pending' after add_tag_to_entry"
        );
        assert_eq!(
            local_version, 2,
            "local_version must increment after add_tag_to_entry"
        );

        // Assert: entry appears in list_pending_entry_ids.
        let conn = state.lock().unwrap();
        let pending_ids = db::list_pending_entry_ids(&conn).unwrap();
        assert!(
            pending_ids.contains(&eid),
            "entry must appear in list_pending_entry_ids after add_tag_to_entry"
        );
    }

    #[test]
    fn remove_tag_from_entry_marks_entry_pending() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let eid = make_synced_entry(&state, &jid, "Tagged Entry 2");

        let tag_id = {
            let conn = state.lock().unwrap();
            let tag = db::create_tag(&conn, "sync-test-remove", None).unwrap();
            db::add_tag_to_entry(&conn, &eid, &tag.id).unwrap();
            // Re-sync after tag add so we have a clean synced baseline.
            db::queries::mark_entry_synced(&conn, &eid, 2).unwrap();
            tag.id
        };

        // Precondition: entry is synced.
        let (_, status) = sync_row(&state, &eid).unwrap();
        assert_eq!(status, "synced", "precondition: entry must start synced");

        // Act.
        {
            let conn = state.lock().unwrap();
            super::remove_tag_from_entry_impl(&conn, &eid, &tag_id).unwrap();
        }

        // Assert: sync_status flipped to pending.
        // local_version starts at 1 (from create_entry_impl); mark_entry_synced
        // does NOT bump local_version, so after one mark_entry_pending call it
        // is 1+1 = 2.
        let (local_version, status) = sync_row(&state, &eid).unwrap();
        assert_eq!(
            status, "pending",
            "sync_status must be 'pending' after remove_tag_from_entry"
        );
        assert_eq!(
            local_version, 2,
            "local_version must increment after remove_tag_from_entry"
        );

        // Assert: entry appears in list_pending_entry_ids.
        let conn = state.lock().unwrap();
        let pending_ids = db::list_pending_entry_ids(&conn).unwrap();
        assert!(
            pending_ids.contains(&eid),
            "entry must appear in list_pending_entry_ids after remove_tag_from_entry"
        );
    }

    #[test]
    fn add_tag_bumps_entry_updated_at() {
        let state = make_state();
        let jid = make_journal(&state, "J");
        let eid = make_synced_entry(&state, &jid, "Bump Test");

        // Set a sentinel updated_at so we can assert it was bumped.
        {
            let conn = state.lock().unwrap();
            conn.execute(
                "UPDATE entries SET updated_at = 1 WHERE id = ?1",
                rusqlite::params![&eid],
            )
            .unwrap();
        }

        let tag_id = {
            let conn = state.lock().unwrap();
            db::create_tag(&conn, "bump-test", None).unwrap().id
        };

        {
            let conn = state.lock().unwrap();
            super::add_tag_to_entry_impl(&conn, &eid, &tag_id).unwrap();
        }

        let conn = state.lock().unwrap();
        let updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM entries WHERE id = ?1",
                rusqlite::params![&eid],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            updated_at > 1,
            "updated_at must be bumped after add_tag_to_entry (got {updated_at})"
        );
    }
}
