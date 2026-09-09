use tauri::State;

use crate::db::{self, StreakInfo};
use crate::AppState;

/// Return the cached streak info. Reads from streak_cache without
/// recalculating. Fast — suitable for display on app load.
#[tauri::command]
pub fn get_streak(state: State<'_, AppState>) -> Result<StreakInfo, String> {
    let conn = state.lock()?;
    db::get_streak_cache(&conn).map_err(|e| e.to_string())
}

/// Scan all non-deleted entries, recompute streak, persist to streak_cache,
/// and return the updated values.
#[tauri::command]
pub fn recalculate_streak(state: State<'_, AppState>) -> Result<StreakInfo, String> {
    let conn = state.lock()?;
    db::recalculate_streak(&conn).map_err(|e| e.to_string())
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
    fn get_streak_returns_zeros_when_no_cache() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let info = db::get_streak_cache(&conn).unwrap();
        assert_eq!(info.current_streak, 0);
        assert_eq!(info.longest_streak, 0);
        assert!(info.last_entry_date.is_none());
    }

    #[test]
    fn recalculate_streak_returns_zero_with_no_entries() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let info = db::recalculate_streak(&conn).unwrap();
        assert_eq!(info.current_streak, 0);
        assert_eq!(info.longest_streak, 0);
    }

    #[test]
    fn recalculate_then_get_streak_are_consistent() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::recalculate_streak(&conn).unwrap();
        let cached = db::get_streak_cache(&conn).unwrap();
        assert_eq!(cached.current_streak, 0);
        assert_eq!(cached.longest_streak, 0);
    }
}
