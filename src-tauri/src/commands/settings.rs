use tauri::State;

use crate::db;
use crate::AppState;

/// Get a setting value by key. Returns None if the key does not exist.
#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.lock()?;
    db::get_setting(&conn, &key).map_err(|e| e.to_string())
}

/// Set a setting key/value pair. Upserts on conflict.
#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

/// Remove a setting by key. No-op if the key does not exist.
#[tauri::command]
pub fn delete_setting(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_setting(&conn, &key).map_err(|e| e.to_string())
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
    fn set_and_get_setting_roundtrip() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, "theme", "dark").unwrap();
        let val = db::get_setting(&conn, "theme").unwrap();
        assert_eq!(val.as_deref(), Some("dark"));
    }

    #[test]
    fn get_nonexistent_setting_returns_none() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let val = db::get_setting(&conn, "missing_key").unwrap();
        assert!(val.is_none());
    }

    #[test]
    fn set_setting_upserts_on_conflict() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, "theme", "light").unwrap();
        db::set_setting(&conn, "theme", "dark").unwrap();
        let val = db::get_setting(&conn, "theme").unwrap();
        assert_eq!(val.as_deref(), Some("dark"));
    }

    #[test]
    fn delete_setting_removes_existing_key() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, "theme", "dark").unwrap();
        db::delete_setting(&conn, "theme").unwrap();
        assert!(db::get_setting(&conn, "theme").unwrap().is_none());
    }

    #[test]
    fn delete_setting_on_missing_key_is_ok() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::delete_setting(&conn, "never_set").unwrap();
    }

    #[test]
    fn multiple_settings_are_independent() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::set_setting(&conn, "theme", "dark").unwrap();
        db::set_setting(&conn, "font_size", "16").unwrap();
        db::set_setting(&conn, "locale", "en-US").unwrap();
        assert_eq!(
            db::get_setting(&conn, "theme").unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(
            db::get_setting(&conn, "font_size").unwrap().as_deref(),
            Some("16")
        );
        assert_eq!(
            db::get_setting(&conn, "locale").unwrap().as_deref(),
            Some("en-US")
        );
    }
}
