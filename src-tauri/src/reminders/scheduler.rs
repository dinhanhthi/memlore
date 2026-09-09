//! Background reminder scheduler.
//!
//! Runs on a tokio task spawned in `run()` at app setup. Ticks immediately on
//! start, then aligns each subsequent wake to the next wall-clock minute
//! boundary (`:00` second), loads enabled reminders from the DB, and for each
//! one calls `is_due` to decide whether to fire. When a reminder fires, the
//! scheduler:
//!
//! 1. Emits the `reminder:fire` Tauri event with `{ id, label }` payload.
//! 2. Calls `mark_reminder_fired` to stamp `last_fired_at` in the DB, so the
//!    same minute is not fired twice.
//!
//! The frontend hook `useReminderNotifications` listens for `reminder:fire`
//! and calls the OS notification API (`sendNotification`).
//!
//! ## Due logic (`is_due`)
//!
//! A reminder is due when:
//! - Its `time_of_day` (HH:MM) matches the current local HH:MM.
//! - Its `weekdays` bitmask has the current weekday's bit set (bit 0 = Mon …
//!   bit 6 = Sun).
//! - It has not fired in the current minute: `last_fired_at` is either absent
//!   or older than the start of the current minute.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{Datelike, Timelike};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;
use crate::db::queries::Reminder;
use crate::AppState;

/// Nominal tick cadence. Actual sleep is aligned to the next `:00` second so
/// the scheduler doesn't drift across wall-clock minute boundaries.
const TICK: Duration = Duration::from_secs(60);

/// Compute the duration until the next `:00` wall-clock second. Clamped to
/// `[1s, 60s]` so we never busy-loop on a clock skew and never wait longer
/// than one nominal `TICK` on a backwards-jumping clock.
fn sleep_until_next_minute(now: chrono::DateTime<chrono::Local>) -> Duration {
    let tick_ms = TICK.as_millis() as i64;
    let sub_minute_ms = (now.second() as i64) * 1000 + (now.timestamp_subsec_millis() as i64);
    let remaining = tick_ms - sub_minute_ms;
    let clamped = remaining.clamp(1_000, tick_ms);
    Duration::from_millis(clamped as u64)
}

/// Payload emitted on `reminder:fire`.
#[derive(Debug, Clone, Serialize)]
pub struct ReminderFirePayload {
    pub id: String,
    pub label: String,
}

/// Scheduler handle — stop by calling `stop()` or dropping.
pub struct ReminderScheduler {
    cancel: Arc<AtomicBool>,
}

impl ReminderScheduler {
    /// Spawn the scheduler task and return a handle.
    ///
    /// Loop order is `tick → sleep` (not `sleep → tick`) so a reminder
    /// scheduled for the same minute the app launches still fires. Sleep is
    /// aligned to the next `:00` second so the loop doesn't drift across
    /// wall-clock minutes after a few ticks.
    pub fn start(app: AppHandle) -> Arc<Self> {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel.clone();

        tauri::async_runtime::spawn(async move {
            loop {
                if cancel_clone.load(Ordering::Relaxed) {
                    break;
                }
                tick(&app);
                let sleep_for = sleep_until_next_minute(chrono::Local::now());
                tokio::time::sleep(sleep_for).await;
            }
        });

        Arc::new(Self { cancel })
    }

    /// Signal the background task to exit on its next wake.
    pub fn stop(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// One scheduler tick: load enabled reminders, check each, fire if due.
fn tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    let reminders = match state.lock() {
        Ok(conn) => match db::list_enabled_reminders(&conn) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("reminder scheduler: failed to load reminders: {e}");
                return;
            }
        },
        Err(e) => {
            log::warn!("reminder scheduler: failed to acquire DB lock: {e}");
            return;
        }
    };

    let now = chrono::Local::now();
    let current_hhmm = now.format("%H:%M").to_string();
    let current_weekday = now.weekday().num_days_from_monday() as u8; // 0=Mon … 6=Sun

    let minute_start_ms = now
        .with_second(0)
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(now)
        .timestamp()
        * 1000;

    log::info!(
        "reminder tick: now={current_hhmm} weekday={current_weekday} enabled_count={}",
        reminders.len()
    );

    for reminder in reminders {
        let due = is_due(&reminder, &current_hhmm, current_weekday, minute_start_ms);
        log::info!(
            "reminder check: id={} time={} weekdays={:#09b} last_fired_at={:?} due={due}",
            reminder.id,
            reminder.time_of_day,
            reminder.weekdays,
            reminder.last_fired_at,
        );
        if due {
            // Fire the event.
            let payload = ReminderFirePayload {
                id: reminder.id.clone(),
                label: reminder.label.clone(),
            };
            log::info!(
                "reminder fire: id={} label={:?}",
                reminder.id,
                reminder.label
            );
            if let Err(e) = app.emit("reminder:fire", &payload) {
                log::warn!("reminder scheduler: failed to emit reminder:fire: {e}");
            }

            // Mark fired so the same minute is not fired again.
            match state.lock() {
                Ok(conn) => {
                    if let Err(e) = db::mark_reminder_fired(&conn, &reminder.id) {
                        log::warn!(
                            "reminder scheduler: failed to mark reminder {} fired: {e}",
                            reminder.id
                        );
                    }
                }
                Err(e) => {
                    log::warn!("reminder scheduler: failed to acquire DB lock for mark_fired: {e}");
                }
            }
        }
    }
}

/// Return `true` if the reminder should fire right now.
///
/// Parameters:
/// - `reminder` — the reminder to evaluate.
/// - `current_hhmm` — current local time as "HH:MM".
/// - `current_weekday` — 0=Monday … 6=Sunday (from `chrono`).
/// - `minute_start_ms` — Unix ms for the start of the current minute; used to
///   detect whether `last_fired_at` is already within this minute.
pub fn is_due(
    reminder: &Reminder,
    current_hhmm: &str,
    current_weekday: u8,
    minute_start_ms: i64,
) -> bool {
    // Time must match.
    if reminder.time_of_day != current_hhmm {
        return false;
    }

    // Already fired in this minute.
    if let Some(last) = reminder.last_fired_at {
        if last >= minute_start_ms {
            return false;
        }
    }

    // Weekday bitmask check: is the current day's bit set?
    if current_weekday >= 7 {
        return false;
    }
    (reminder.weekdays >> current_weekday) & 1 == 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::Reminder;

    const DAILY: i64 = 0b1111111; // 127 — all 7 days
    const WEEKDAYS_MASK: i64 = 0b0011111; // 31 — Mon..Fri
    const TUESDAY_ONLY: i64 = 0b0000010; // 2 — bit 1

    fn make_reminder(time_of_day: &str, weekdays: i64, last_fired_at: Option<i64>) -> Reminder {
        Reminder {
            id: "test-id".to_string(),
            label: "Test".to_string(),
            time_of_day: time_of_day.to_string(),
            weekdays,
            enabled: true,
            last_fired_at,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn is_due_daily_fires_when_time_matches() {
        let r = make_reminder("09:00", DAILY, None);
        assert!(is_due(&r, "09:00", 2, 1_700_000_000_000)); // Wednesday
    }

    #[test]
    fn is_due_daily_does_not_fire_on_time_mismatch() {
        let r = make_reminder("09:00", DAILY, None);
        assert!(!is_due(&r, "10:00", 2, 1_700_000_000_000));
    }

    #[test]
    fn is_due_weekdays_fires_mon_to_fri() {
        let r = make_reminder("09:00", WEEKDAYS_MASK, None);
        for wd in 0u8..=4 {
            assert!(is_due(&r, "09:00", wd, 1_700_000_000_000), "weekday {wd}");
        }
    }

    #[test]
    fn is_due_weekdays_does_not_fire_on_weekend() {
        let r = make_reminder("09:00", WEEKDAYS_MASK, None);
        assert!(!is_due(&r, "09:00", 5, 1_700_000_000_000)); // Saturday
        assert!(!is_due(&r, "09:00", 6, 1_700_000_000_000)); // Sunday
    }

    #[test]
    fn is_due_single_weekday_fires_on_correct_day_only() {
        let r = make_reminder("09:00", TUESDAY_ONLY, None);
        assert!(is_due(&r, "09:00", 1, 1_700_000_000_000)); // Tuesday
        assert!(!is_due(&r, "09:00", 0, 1_700_000_000_000)); // Monday — wrong day
        assert!(!is_due(&r, "09:00", 2, 1_700_000_000_000)); // Wednesday — wrong day
    }

    #[test]
    fn is_due_skips_if_already_fired_this_minute() {
        let minute_start = 1_700_000_000_000i64;
        let r = make_reminder("09:00", DAILY, Some(minute_start + 5));
        // last_fired_at >= minute_start → already fired
        assert!(!is_due(&r, "09:00", 2, minute_start));
    }

    #[test]
    fn sleep_until_next_minute_aligns_to_zero_second() {
        use chrono::TimeZone;
        // 09:00:00.000 → exactly one full minute until 09:01:00.
        let t = chrono::Local.with_ymd_and_hms(2026, 1, 1, 9, 0, 0).unwrap();
        assert_eq!(super::sleep_until_next_minute(t), Duration::from_secs(60));
        // 09:00:30.000 → 30 s until 09:01:00.
        let t = chrono::Local
            .with_ymd_and_hms(2026, 1, 1, 9, 0, 30)
            .unwrap();
        assert_eq!(super::sleep_until_next_minute(t), Duration::from_secs(30));
        // 09:00:30.500 → 29.5 s until 09:01:00 (sub-second resolution).
        let t = chrono::Local
            .with_ymd_and_hms(2026, 1, 1, 9, 0, 30)
            .unwrap()
            + chrono::Duration::milliseconds(500);
        assert_eq!(
            super::sleep_until_next_minute(t),
            Duration::from_millis(29_500)
        );
        // 09:00:59.999 → ~1 ms until 09:01:00 → clamped to 1 s minimum.
        let t = chrono::Local
            .with_ymd_and_hms(2026, 1, 1, 9, 0, 59)
            .unwrap()
            + chrono::Duration::milliseconds(999);
        assert!(super::sleep_until_next_minute(t) >= Duration::from_secs(1));
    }

    #[test]
    fn is_due_fires_if_last_fired_was_in_previous_minute() {
        let minute_start = 1_700_000_060_000i64; // next minute
        let r = make_reminder("09:00", DAILY, Some(minute_start - 1000));
        // last_fired_at < minute_start → stale, fire again
        assert!(is_due(&r, "09:00", 2, minute_start));
    }
}
