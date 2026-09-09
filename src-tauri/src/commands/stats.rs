use tauri::State;

use crate::db::{
    self, EmotionTrendBucket, EntriesOverTimePoint, LocationPoint, MoodHistogramRow,
    MoodTrendPoint, StreakCalendarDay, TagFrequencyRow, WritingVolumePoint,
};
use crate::AppState;

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn stats_entries_over_time(
    period: String,
    range: u32,
    state: State<'_, AppState>,
) -> Result<Vec<EntriesOverTimePoint>, String> {
    let range = range.min(3650);
    let conn = state.lock()?;
    db::query_entries_over_time(&conn, &period, range).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_mood_histogram(
    range_days: u32,
    state: State<'_, AppState>,
) -> Result<Vec<MoodHistogramRow>, String> {
    let range_days = range_days.min(3650);
    let conn = state.lock()?;
    db::query_mood_histogram(&conn, range_days).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_mood_trend(
    range_days: u32,
    state: State<'_, AppState>,
) -> Result<Vec<MoodTrendPoint>, String> {
    let range_days = range_days.min(3650);
    let conn = state.lock()?;
    db::query_mood_trend(&conn, range_days).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_emotion_trend(
    period: String,
    range_days: u32,
    state: State<'_, AppState>,
) -> Result<Vec<EmotionTrendBucket>, String> {
    let range_days = range_days.min(3650);
    let period = match period.as_str() {
        "day" | "week" => period,
        _ => "day".to_string(),
    };
    let conn = state.lock()?;
    db::query_emotion_trend(&conn, &period, range_days).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_tag_frequency(state: State<'_, AppState>) -> Result<Vec<TagFrequencyRow>, String> {
    let conn = state.lock()?;
    db::query_tag_frequency(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_writing_volume(
    period: String,
    range: u32,
    state: State<'_, AppState>,
) -> Result<Vec<WritingVolumePoint>, String> {
    let range = range.min(3650);
    let conn = state.lock()?;
    db::query_writing_volume(&conn, &period, range).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_streak_calendar(
    year: i32,
    state: State<'_, AppState>,
) -> Result<Vec<StreakCalendarDay>, String> {
    if !(1000..=9999).contains(&year) {
        return Err(format!("year out of range: {year}"));
    }
    let conn = state.lock()?;
    db::query_streak_calendar(&conn, year).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stats_location_density(state: State<'_, AppState>) -> Result<Vec<LocationPoint>, String> {
    let conn = state.lock()?;
    db::select_location_density(&conn).map_err(|e| e.to_string())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::db::{self, schema::migrate, CreateEntryParams};
    use crate::utils::time::now_unix;
    use crate::AppState;
    use rusqlite::Connection;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    /// Helper: get the journal_id from the seeded default journal.
    fn default_journal_id(conn: &Connection) -> String {
        conn.query_row(
            "SELECT id FROM journals WHERE is_deleted = 0 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("default journal")
    }

    /// Helper: insert an entry with a specific unix timestamp.
    fn insert_entry_at(conn: &Connection, journal_id: &str, entry_date: i64) -> String {
        db::create_entry(
            conn,
            CreateEntryParams {
                journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date,
            },
        )
        .unwrap()
        .id
    }

    /// Helper: insert an entry with a 3-state emotion at a specific date.
    fn insert_entry_with_mood(
        conn: &Connection,
        journal_id: &str,
        entry_date: i64,
        emotion: &str,
    ) -> String {
        let id = insert_entry_at(conn, journal_id, entry_date);
        conn.execute(
            "UPDATE entries SET emotion = ?1 WHERE id = ?2",
            rusqlite::params![emotion, id],
        )
        .unwrap();
        id
    }

    /// Convert a Unix timestamp to a "YYYY-MM-DD" string (UTC), matching SQLite's
    /// `date(ts, 'unixepoch')`. Used to compute expected day strings in tests
    /// without pulling in chrono.
    fn ts_to_date_utc(ts: i64) -> String {
        let days = ts / 86_400;
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!("{:04}-{:02}-{:02}", y, m, d)
    }

    /// Helper: insert an entry with content_text at a specific date.
    fn insert_entry_with_content(
        conn: &Connection,
        journal_id: &str,
        entry_date: i64,
        content: &str,
    ) -> String {
        db::create_entry(
            conn,
            CreateEntryParams {
                journal_id,
                title: None,
                content_text: Some(content),
                preview_text: None,
                entry_date,
            },
        )
        .unwrap()
        .id
    }

    // ── Test 1: entries_over_time groups by month ─────────────────────────────

    #[test]
    fn entries_over_time_groups_by_month() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let now = now_unix();
        let day_a = (now - 75 * 86_400) / 86_400 * 86_400;
        let day_b = (now - 40 * 86_400) / 86_400 * 86_400;
        let day_c = (now - 5 * 86_400) / 86_400 * 86_400;

        let month_a = &ts_to_date_utc(day_a)[..7];
        let month_b = &ts_to_date_utc(day_b)[..7];
        let month_c = &ts_to_date_utc(day_c)[..7];

        assert_ne!(
            month_a, month_b,
            "fixture: A and B must be in different months"
        );
        assert_ne!(
            month_b, month_c,
            "fixture: B and C must be in different months"
        );

        for i in 0..3 {
            insert_entry_at(&conn, &jid, day_a + i * 3600);
        }
        for i in 0..4 {
            insert_entry_at(&conn, &jid, day_b + i * 3600);
        }
        for i in 0..2 {
            insert_entry_at(&conn, &jid, day_c + i * 3600);
        }

        let result = db::query_entries_over_time(&conn, "month", 4).unwrap();

        assert_eq!(
            result.len(),
            3,
            "9 entries in 3 distinct months → 3 buckets"
        );

        let find_count = |prefix: &str| {
            result
                .iter()
                .find(|r| r.period_start.starts_with(prefix))
                .map(|r| r.count)
        };
        assert_eq!(
            find_count(month_a),
            Some(3),
            "bucket A should have 3 entries"
        );
        assert_eq!(
            find_count(month_b),
            Some(4),
            "bucket B should have 4 entries"
        );
        assert_eq!(
            find_count(month_c),
            Some(2),
            "bucket C should have 2 entries"
        );

        let periods: Vec<&str> = result.iter().map(|r| r.period_start.as_str()).collect();
        let mut sorted = periods.clone();
        sorted.sort();
        assert_eq!(periods, sorted, "results should be sorted ASC");
    }

    // ── Test 2: entries_over_time empty returns empty vec ─────────────────────

    #[test]
    fn entries_over_time_empty_returns_empty_vec() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let result = db::query_entries_over_time(&conn, "month", 12).unwrap();
        assert!(result.is_empty(), "empty db should return empty vec");
    }

    // ── Test 3: mood_histogram respects range ─────────────────────────────────

    #[test]
    fn mood_histogram_respects_range() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let now = now_unix();
        let recent_ts = now - 5 * 86_400;
        let old_ts = now - 60 * 86_400;

        insert_entry_with_mood(&conn, &jid, recent_ts, "good");
        insert_entry_with_mood(&conn, &jid, old_ts, "bad");

        let result = db::query_mood_histogram(&conn, 30).unwrap();
        let emotions: Vec<&str> = result.iter().map(|r| r.emotion.as_str()).collect();
        assert!(emotions.contains(&"good"), "good should be in range");
        assert!(
            !emotions.contains(&"bad"),
            "bad is outside range and should be excluded"
        );
    }

    // ── Test 4: mood_histogram empty returns empty ────────────────────────────

    #[test]
    fn mood_histogram_empty_returns_empty() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let result = db::query_mood_histogram(&conn, 30).unwrap();
        assert!(result.is_empty(), "no entries with emotions → empty");
    }

    // ── Test 5a: emotion_trend groups by day with 3-state counts ────────────

    #[test]
    fn emotion_trend_groups_by_day_with_three_states() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let now = now_unix();
        let day1_ts = (now - 5 * 86_400) / 86_400 * 86_400;
        let day2_ts = (now - 4 * 86_400) / 86_400 * 86_400;

        insert_entry_with_mood(&conn, &jid, day1_ts, "good");
        insert_entry_with_mood(&conn, &jid, day1_ts + 3600, "bad");
        insert_entry_with_mood(&conn, &jid, day2_ts, "neutral");

        let day1_str = ts_to_date_utc(day1_ts);
        let day2_str = ts_to_date_utc(day2_ts);

        let result = db::query_emotion_trend(&conn, "day", 30).unwrap();
        let d1 = result.iter().find(|r| r.period_start == day1_str).unwrap();
        let d2 = result.iter().find(|r| r.period_start == day2_str).unwrap();

        assert_eq!(d1.good_count, 1);
        assert_eq!(d1.bad_count, 1);
        assert_eq!(d1.neutral_count, 0);
        assert_eq!(d1.total_count, 2);
        assert_eq!(d2.neutral_count, 1);
        assert_eq!(d2.total_count, 1);
    }

    #[test]
    fn emotion_trend_week_buckets_respect_range_boundary() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let now = now_unix();
        let recent = (now - 2 * 86_400) / 86_400 * 86_400 + 43_200;
        let old = (now - 40 * 86_400) / 86_400 * 86_400 + 43_200;

        insert_entry_with_mood(&conn, &jid, recent, "good");
        insert_entry_with_mood(&conn, &jid, old, "bad");

        let result = db::query_emotion_trend(&conn, "week", 30).unwrap();
        let total: u64 = result.iter().map(|r| r.total_count).sum();
        assert_eq!(total, 1, "entry outside 30d range must be excluded");
        assert_eq!(result.iter().map(|r| r.good_count).sum::<u64>(), 1);
    }

    // ── Test 5: mood_trend groups by day ─────────────────────────────────────

    #[test]
    fn mood_trend_groups_by_day() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let now = now_unix();
        // Snap to day boundary to avoid UTC midnight edge cases
        let day1_ts = (now - 5 * 86_400) / 86_400 * 86_400;
        let day2_ts = (now - 4 * 86_400) / 86_400 * 86_400;

        insert_entry_with_mood(&conn, &jid, day1_ts, "good");
        insert_entry_with_mood(&conn, &jid, day1_ts + 3600, "good");
        insert_entry_with_mood(&conn, &jid, day2_ts, "bad");

        let day1_str = ts_to_date_utc(day1_ts);
        let day2_str = ts_to_date_utc(day2_ts);

        let result = db::query_mood_trend(&conn, 30).unwrap();
        let d1 = result.iter().find(|r| r.day == day1_str).unwrap();
        let d2 = result.iter().find(|r| r.day == day2_str).unwrap();

        assert_eq!(d1.sample_count, 2);
        assert_eq!(d2.sample_count, 1);
    }

    // ── Test 6: tag_frequency orders by count desc ────────────────────────────

    #[test]
    fn tag_frequency_orders_by_count_desc() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let tag1 = db::create_tag(&conn, "popular", None).unwrap();
        let tag2 = db::create_tag(&conn, "rare", None).unwrap();

        for _ in 0..3 {
            let eid = insert_entry_at(&conn, &jid, 1_700_000_000);
            db::add_tag_to_entry(&conn, &eid, &tag1.id).unwrap();
        }
        let eid = insert_entry_at(&conn, &jid, 1_700_000_000);
        db::add_tag_to_entry(&conn, &eid, &tag2.id).unwrap();

        let result = db::query_tag_frequency(&conn).unwrap();
        assert!(!result.is_empty());
        let popular_idx = result.iter().position(|r| r.tag_name == "popular").unwrap();
        let rare_idx = result.iter().position(|r| r.tag_name == "rare").unwrap();
        assert!(
            popular_idx < rare_idx,
            "popular (count=3) should come before rare (count=1)"
        );
        assert_eq!(result[popular_idx].count, 3);
    }

    // ── Test 7: writing_volume uses wordcount ─────────────────────────────────

    #[test]
    fn writing_volume_uses_wordcount() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let now = now_unix();
        let ts1 = now - 5 * 86_400;
        let ts2 = now - 3 * 86_400;

        insert_entry_with_content(&conn, &jid, ts1, "hello world");
        insert_entry_with_content(&conn, &jid, ts2, "one two three");

        let result = db::query_writing_volume(&conn, "month", 2).unwrap();
        assert!(!result.is_empty(), "result should not be empty");

        let total_words: u64 = result.iter().map(|r| r.total_words).sum();
        let total_entries: u64 = result.iter().map(|r| r.entry_count).sum();
        assert_eq!(total_entries, 2, "should have 2 entries total");
        assert_eq!(total_words, 5, "should have 2+3=5 total words");
    }

    // ── Test 8: streak_calendar full year returns 365 or 366 days ─────────────

    #[test]
    fn streak_calendar_full_year_returns_365_or_366_days() {
        let state = make_state();
        let conn = state.lock().unwrap();

        let result = db::query_streak_calendar(&conn, 2024).unwrap();
        assert_eq!(result.len(), 366, "2024 leap year should have 366 days");

        let mut dates: Vec<&str> = result.iter().map(|r| r.date.as_str()).collect();
        dates.sort();
        dates.dedup();
        assert_eq!(dates.len(), 366, "all dates should be distinct");

        assert_eq!(result[0].date, "2024-01-01");
        assert_eq!(result[365].date, "2024-12-31");
    }

    // ── Test 9: streak_calendar counts entries correctly ──────────────────────

    #[test]
    fn streak_calendar_counts_entries_correctly() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        // Noon UTC so date('unixepoch','localtime') lands on Jan 15 in all timezones.
        let jan15_noon: i64 = 1_705_276_800 + 43_200;
        insert_entry_at(&conn, &jid, jan15_noon);
        insert_entry_at(&conn, &jid, jan15_noon + 3600);

        let result = db::query_streak_calendar(&conn, 2024).unwrap();
        let jan15 = result.iter().find(|r| r.date == "2024-01-15").unwrap();
        assert_eq!(jan15.entry_count, 2, "Jan 15 should have 2 entries");

        let jan16 = result.iter().find(|r| r.date == "2024-01-16").unwrap();
        assert_eq!(jan16.entry_count, 0, "Jan 16 should have 0 entries");
    }

    // ── Test 10: entries_over_time with period="day" ──────────────────────────

    #[test]
    fn entries_over_time_day_period() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let now = now_unix();
        // Use noon UTC so localtime conversion is unambiguous for all CI timezones.
        let day1 = (now - 3 * 86_400) / 86_400 * 86_400 + 43_200;
        let day2 = (now - 2 * 86_400) / 86_400 * 86_400 + 43_200;

        insert_entry_at(&conn, &jid, day1);
        insert_entry_at(&conn, &jid, day2);
        insert_entry_at(&conn, &jid, day2 + 3600);

        let result = db::query_entries_over_time(&conn, "day", 7).unwrap();
        assert_eq!(result.len(), 2, "2 distinct days → 2 buckets");

        let d1_str = ts_to_date_utc(day1);
        let d2_str = ts_to_date_utc(day2);
        let find_count = |prefix: &str| {
            result
                .iter()
                .find(|r| r.period_start.starts_with(prefix))
                .map(|r| r.count)
        };
        assert_eq!(find_count(&d1_str), Some(1), "day1 should have 1 entry");
        assert_eq!(find_count(&d2_str), Some(2), "day2 should have 2 entries");

        let periods: Vec<&str> = result.iter().map(|r| r.period_start.as_str()).collect();
        let mut sorted = periods.clone();
        sorted.sort();
        assert_eq!(periods, sorted, "results should be sorted ASC");
    }

    // ── Test 11: entries_over_time with period="week" ─────────────────────────

    #[test]
    fn entries_over_time_week_period() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let now = now_unix();
        // Two entries well within the current week, two entries 14+ days ago (different week).
        let this_week = (now - 1 * 86_400) / 86_400 * 86_400 + 43_200;
        let last_week = (now - 8 * 86_400) / 86_400 * 86_400 + 43_200;

        insert_entry_at(&conn, &jid, this_week);
        insert_entry_at(&conn, &jid, last_week);
        insert_entry_at(&conn, &jid, last_week + 3600);

        let result = db::query_entries_over_time(&conn, "week", 4).unwrap();
        assert!(
            result.len() >= 2,
            "entries in 2 distinct weeks → at least 2 buckets"
        );

        let total: u64 = result.iter().map(|r| r.count).sum();
        assert_eq!(total, 3, "all 3 entries should be counted");

        let periods: Vec<&str> = result.iter().map(|r| r.period_start.as_str()).collect();
        let mut sorted = periods.clone();
        sorted.sort();
        assert_eq!(periods, sorted, "results should be sorted ASC");
    }

    // ── Location density tests ──────────────────────────────────────────────

    fn set_entry_coords(conn: &Connection, entry_id: &str, lat: f64, lng: f64) {
        conn.execute(
            "UPDATE entries SET latitude = ?1, longitude = ?2 WHERE id = ?3",
            rusqlite::params![lat, lng, entry_id],
        )
        .unwrap();
    }

    fn insert_media_with_exif(conn: &Connection, entry_id: &str, lat: f64, lng: f64) {
        let media_id = uuid::Uuid::new_v4().to_string();
        let now = crate::utils::time::now_unix();
        conn.execute(
            "INSERT INTO media (id, entry_id, file_name, file_type, storage_provider, storage_path, exif_latitude, exif_longitude, created_at)
             VALUES (?1, ?2, 'photo.jpg', 'image/jpeg', 'local', '/tmp/photo.jpg', ?3, ?4, ?5)",
            rusqlite::params![media_id, entry_id, lat, lng, now],
        )
        .unwrap();
    }

    #[test]
    fn location_density_buckets_nearby_points() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let e1 = insert_entry_at(&conn, &jid, 1_700_000_000);
        let e2 = insert_entry_at(&conn, &jid, 1_700_000_000);
        let e3 = insert_entry_at(&conn, &jid, 1_700_000_000);

        set_entry_coords(&conn, &e1, 48.8561, 2.3521);
        set_entry_coords(&conn, &e2, 48.8562, 2.3522);
        set_entry_coords(&conn, &e3, 48.8563, 2.3523);

        let result = db::select_location_density(&conn).unwrap();
        assert_eq!(result.len(), 1, "3 points within 0.0005° → 1 bucket");
        assert_eq!(result[0].count, 3);
    }

    #[test]
    fn location_density_excludes_null_coords() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        insert_entry_at(&conn, &jid, 1_700_000_000);
        let e2 = insert_entry_at(&conn, &jid, 1_700_000_000);
        set_entry_coords(&conn, &e2, 48.8566, 2.3522);

        let result = db::select_location_density(&conn).unwrap();
        assert_eq!(result.len(), 1, "only entry with coords appears");
        assert_eq!(result[0].count, 1);
    }

    #[test]
    fn location_density_includes_media_exif_points() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let e1 = insert_entry_at(&conn, &jid, 1_700_000_000);
        insert_media_with_exif(&conn, &e1, 35.6762, 139.6503);

        let result = db::select_location_density(&conn).unwrap();
        assert_eq!(result.len(), 1, "EXIF GPS contributes a point");
        assert_eq!(result[0].count, 1);
    }

    #[test]
    fn location_density_empty_returns_empty_vec() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let result = db::select_location_density(&conn).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn location_density_deduplicates_entry_and_media_at_same_location() {
        let state = make_state();
        let conn = state.lock().unwrap();
        let jid = default_journal_id(&conn);

        let e1 = insert_entry_at(&conn, &jid, 1_700_000_000);
        set_entry_coords(&conn, &e1, 48.8566, 2.3522);
        insert_media_with_exif(&conn, &e1, 48.8566, 2.3522);

        let result = db::select_location_density(&conn).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].count, 1,
            "media at same location as entry should not double-count"
        );
    }
}
