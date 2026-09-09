use tauri::State;

use crate::db::{self, Template};
use crate::AppState;

#[tauri::command]
pub fn create_template(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    content: Option<Vec<u8>>,
) -> Result<Template, String> {
    let conn = state.lock()?;
    db::create_template(&conn, &name, description.as_deref(), content.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_templates(state: State<'_, AppState>) -> Result<Vec<Template>, String> {
    let conn = state.lock()?;
    db::list_templates(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_template(state: State<'_, AppState>, id: String) -> Result<Option<Template>, String> {
    let conn = state.lock()?;
    db::get_template(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_template(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: Option<String>,
    content: Option<Vec<u8>>,
) -> Result<Template, String> {
    let conn = state.lock()?;
    db::update_template(
        &conn,
        &id,
        &name,
        description.as_deref(),
        content.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_template(&conn, &id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use crate::db::{self, schema::migrate};
    use crate::AppState;
    use rusqlite::Connection;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    #[test]
    fn create_and_list_templates() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let t = db::create_template(&conn, "Test", Some("desc"), None).unwrap();
        assert_eq!(t.name, "Test");
        let all = db::list_templates(&conn).unwrap();
        assert!(all.iter().any(|tmpl| tmpl.id == t.id));
    }

    #[test]
    fn update_template_roundtrip() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let t = db::create_template(&conn, "Original", None, None).unwrap();
        let updated = db::update_template(&conn, &t.id, "Updated", Some("new desc"), None).unwrap();
        assert_eq!(updated.name, "Updated");
        assert_eq!(updated.description.as_deref(), Some("new desc"));
    }

    #[test]
    fn delete_template_roundtrip() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let t = db::create_template(&conn, "ToRemove", None, None).unwrap();
        db::delete_template(&conn, &t.id).unwrap();
        assert!(db::get_template(&conn, &t.id).unwrap().is_none());
    }

    #[test]
    fn migrate_seeds_predefined_templates() {
        // Seeding runs inside `migrate()` now; `list_templates` via the
        // command path should already surface the 3 predefined rows.
        let state = make_state();
        let conn = state.lock().unwrap();
        let all = db::list_templates(&conn).unwrap();
        let predefined: Vec<_> = all.iter().filter(|t| t.is_predefined).collect();
        assert_eq!(predefined.len(), 3);
        // name field now stores slug keys; display names are resolved by the
        // frontend via t('editor.templates.' + name + '.label')
        for expected in ["blank", "daily-reflection", "morning-pages"] {
            assert!(
                predefined.iter().any(|t| t.name == expected),
                "missing predefined template: {expected}"
            );
        }
    }
}
