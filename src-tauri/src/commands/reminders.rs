use tauri::State;

use crate::db;
use crate::db::queries::Reminder;
use crate::AppState;

/// Validate user input for create/update.
///
/// - `time_of_day` must be `HH:MM` in `00:00..=23:59`.
/// - `weekdays` is a 7-bit bitmask; at least one bit must be set (`1..=127`).
fn validate_reminder_input(_label: &str, time_of_day: &str, weekdays: i64) -> Result<(), String> {
    // Label is optional — no validation needed.
    let parts: Vec<&str> = time_of_day.split(':').collect();
    if parts.len() != 2
        || parts[0].parse::<u8>().map_or(true, |h| h > 23)
        || parts[1].parse::<u8>().map_or(true, |m| m > 59)
    {
        return Err("time_of_day must be HH:MM (00:00-23:59)".to_string());
    }
    if !(1..=127).contains(&weekdays) {
        return Err("weekdays bitmask must be in 1..=127 (at least one day)".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn list_reminders(state: State<'_, AppState>) -> Result<Vec<Reminder>, String> {
    let conn = state.lock()?;
    db::list_reminders(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_reminder(
    state: State<'_, AppState>,
    label: String,
    time_of_day: String,
    weekdays: i64,
) -> Result<Reminder, String> {
    validate_reminder_input(&label, &time_of_day, weekdays)?;
    let conn = state.lock()?;
    db::create_reminder(&conn, &label, &time_of_day, weekdays).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_reminder(
    state: State<'_, AppState>,
    id: String,
    label: String,
    time_of_day: String,
    weekdays: i64,
    enabled: bool,
) -> Result<Reminder, String> {
    validate_reminder_input(&label, &time_of_day, weekdays)?;
    let conn = state.lock()?;
    db::update_reminder(&conn, &id, &label, &time_of_day, weekdays, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_reminder(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_reminder(&conn, &id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db::schema::migrate;
    use crate::AppState;

    // Bitmask helpers shared by tests: mirror the values used by the frontend.
    const DAILY: i64 = 0b1111111; // 127 — all 7 days
    const WEEKDAYS_MASK: i64 = 0b0011111; // 31 — Mon–Fri
    const MONDAY_ONLY: i64 = 0b0000001; // 1

    fn setup() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    #[test]
    fn create_and_list_reminders() {
        let state = setup();
        let conn = state.lock().unwrap();
        let created = crate::db::create_reminder(&conn, "Morning", "09:00", DAILY).unwrap();
        assert_eq!(created.label, "Morning");
        assert_eq!(created.time_of_day, "09:00");
        assert_eq!(created.weekdays, DAILY);
        assert!(created.enabled);

        let reminders = crate::db::list_reminders(&conn).unwrap();
        assert_eq!(reminders.len(), 1);
        assert_eq!(reminders[0].id, created.id);
    }

    #[test]
    fn update_reminder_fields() {
        let state = setup();
        let conn = state.lock().unwrap();
        let created = crate::db::create_reminder(&conn, "Morning", "09:00", DAILY).unwrap();
        let updated = crate::db::update_reminder(
            &conn,
            &created.id,
            "Evening",
            "21:00",
            WEEKDAYS_MASK,
            false,
        )
        .unwrap();
        assert_eq!(updated.label, "Evening");
        assert_eq!(updated.time_of_day, "21:00");
        assert_eq!(updated.weekdays, WEEKDAYS_MASK);
        assert!(!updated.enabled);
    }

    #[test]
    fn delete_reminder_removes_row() {
        let state = setup();
        let conn = state.lock().unwrap();
        let created = crate::db::create_reminder(&conn, "Yoga", "07:30", DAILY).unwrap();
        crate::db::delete_reminder(&conn, &created.id).unwrap();
        let reminders = crate::db::list_reminders(&conn).unwrap();
        assert!(reminders.is_empty());
    }

    #[test]
    fn single_weekday_reminder_stores_bitmask() {
        let state = setup();
        let conn = state.lock().unwrap();
        let created =
            crate::db::create_reminder(&conn, "Monday review", "10:00", MONDAY_ONLY).unwrap();
        assert_eq!(created.weekdays, MONDAY_ONLY);
    }

    #[test]
    fn mark_reminder_fired_updates_last_fired_at() {
        let state = setup();
        let conn = state.lock().unwrap();
        let created = crate::db::create_reminder(&conn, "Daily", "08:00", DAILY).unwrap();
        assert!(created.last_fired_at.is_none());
        crate::db::mark_reminder_fired(&conn, &created.id).unwrap();
        let reminders = crate::db::list_reminders(&conn).unwrap();
        assert!(reminders[0].last_fired_at.is_some());
    }

    #[test]
    fn list_enabled_reminders_excludes_disabled() {
        let state = setup();
        let conn = state.lock().unwrap();
        let r1 = crate::db::create_reminder(&conn, "Active", "09:00", DAILY).unwrap();
        let r2 = crate::db::create_reminder(&conn, "Inactive", "10:00", DAILY).unwrap();
        // Disable r2
        crate::db::update_reminder(&conn, &r2.id, "Inactive", "10:00", DAILY, false).unwrap();

        let enabled = crate::db::list_enabled_reminders(&conn).unwrap();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].id, r1.id);
    }

    #[test]
    fn create_reminder_rejects_invalid_bitmask() {
        let state = setup();
        let conn = state.lock().unwrap();
        // 0 = no days selected → CHECK constraint should reject.
        let result = crate::db::create_reminder(&conn, "Bad", "09:00", 0);
        assert!(result.is_err(), "empty bitmask should violate CHECK");
        // 128 = bit 7 set, out of range → CHECK constraint should reject.
        let result = crate::db::create_reminder(&conn, "Bad", "09:00", 128);
        assert!(result.is_err(), "out-of-range bitmask should violate CHECK");
    }

    #[test]
    fn validate_accepts_empty_label() {
        let result = super::validate_reminder_input("", "09:00", DAILY);
        assert!(result.is_ok(), "empty label is allowed (optional field)");
    }

    #[test]
    fn validate_rejects_malformed_time() {
        assert!(super::validate_reminder_input("OK", "99:00", DAILY).is_err());
        assert!(super::validate_reminder_input("OK", "hello", DAILY).is_err());
        assert!(super::validate_reminder_input("OK", "12:60", DAILY).is_err());
    }

    #[test]
    fn validate_rejects_empty_weekdays() {
        assert!(super::validate_reminder_input("OK", "09:00", 0).is_err());
    }

    #[test]
    fn validate_rejects_out_of_range_weekdays() {
        assert!(super::validate_reminder_input("OK", "09:00", 128).is_err());
        assert!(super::validate_reminder_input("OK", "09:00", -1).is_err());
    }

    #[test]
    fn validate_accepts_valid_input() {
        assert!(super::validate_reminder_input("Morning", "09:00", DAILY).is_ok());
        assert!(super::validate_reminder_input("Weekly", "23:59", MONDAY_ONLY).is_ok());
    }
}
