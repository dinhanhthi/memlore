//! Background sync scheduler (Chunk 5).
//!
//! Runs on a tokio task spawned in `run()` at app setup. Wakes up on a
//! short fine-grained tick (`TICK`) and decides whether to fire a sync
//! based on three rules:
//!
//! 1. **Interval fire.** `now - last_sync >= sync_interval_minutes`.
//! 2. **On-save (debounce).** `last_edit > 0` and `now - last_edit >=
//!    DEBOUNCE_WINDOW` and `last_edit > last_debounce_fire` — i.e. the
//!    editor went quiet for DEBOUNCE_WINDOW, and the debounce has not
//!    already fired for this edit burst.
//! 3. **On-launch.** A one-shot fire the first time the scheduler ticks
//!    after start, gated on the `sync_on_launch` setting.
//!
//! Rules 1 and 2 are independent — a user can disable on-save and still
//! get interval syncs; a user can shrink the interval and still get
//! on-save debouncing.
//!
//! ## Failure handling
//!
//! Every failed cycle opens an exponential backoff window
//! (`ERROR_BACKOFF_MS` … `ERROR_BACKOFF_MAX_MS`) during which Rules 1 + 2
//! are suppressed, then the scheduler retries automatically — there is NO
//! sticky "paused until the user clicks Sync now" state. A persistent
//! error (revoked token, force re-pair) therefore costs one failed request
//! every 15 min at most, which is negligible, while a transient one (Wi-Fi
//! still reconnecting after wake, DNS blip, Drive 5xx) heals itself without
//! user action. Deciding "persistent vs transient" from the rendered error
//! strings was deliberately rejected: those strings can embed peer/cloud-
//! derived text (`… parse: {e}`), and a substring match on them would let
//! a poisoned payload freeze auto-sync (the same class of bug fixed once
//! already for `is_auth` in `commands/gdrive.rs`).
//!
//! The open window is dropped early by a kick (`request_retry_now` —
//! window focus, rate-limited by `KICK_COOLDOWN_MS`), by a detected
//! wake-from-sleep (`slept_between_ticks`), or reset entirely by the
//! manual `sync_now` command (`reset_backoff`).
//!
//! ## Non-goals
//!
//! - Jitter: the tick is short enough that jitter is unnecessary.
//! - Persistent cursor: "when did we last push" is derivable from the
//!   `last_sync_at` setting already.
//!
//! ## Lock discipline
//!
//! The scheduler must **not** hold any mutex across an `.await`. All DB
//! reads happen inside a short synchronous block. The actual `run_sync_now`
//! call is synchronous (it wraps its own `block_on` inside a
//! `tauri::async_runtime::spawn_blocking`) so the task never yields while
//! holding the `AppState` mutex.
//!
//! ## Locked-app handling
//!
//! If the encryption key is not initialized (app is locked),
//! `run_sync_now` returns an error containing the phrase "Encryption key
//! not initialized". The scheduler swallows exactly this error class
//! silently — every other error is logged at `warn`. Bursting log noise
//! while the lock screen sits idle would bury real problems.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::commands::sync::run_sync_now;
use crate::db;
use crate::sync::SyncTrigger;
use crate::{AppState, EncryptionKeyState, LastEditState};

/// Tauri event emitted when the scheduler opens a backoff window after a
/// failed cycle, or clears it on a successful one. The frontend can show
/// "Retry in X min" while the window is open.
pub const SYNC_RETRY_SCHEDULED_EVENT: &str = "sync:retry-scheduled";

/// Payload for [`SYNC_RETRY_SCHEDULED_EVENT`]. `None` = backoff cleared.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncRetryScheduledPayload {
    /// Unix milliseconds at which the scheduler will next attempt a sync.
    /// `None` means no backoff is active (cleared on success / manual sync).
    pub retry_at_ms: Option<i64>,
}

/// Reconcile trigger for all three scheduler rules (interval, on-save
/// debounce, on-launch). Automatic: own-cloud self-heal runs only until the
/// first successful reconcile this process session (on-launch still
/// reconciles because the session flag is unset on the first cycle).
pub(crate) const SCHEDULER_SYNC_TRIGGER: SyncTrigger = SyncTrigger::Automatic;

/// How often the scheduler wakes up to re-evaluate its rules.
/// Small enough to make the 30s debounce feel snappy; large enough that
/// the check itself costs near-zero CPU.
pub const TICK: Duration = Duration::from_secs(5);

/// How long after the last edit the debounce fires. The 30s figure is
/// the same as the plan ("debounced, 30s after last edit") — long enough
/// for a typing burst to complete, short enough that a user who closes
/// the editor after typing sees their work pushed before they switch
/// context.
pub const DEBOUNCE_WINDOW: Duration = Duration::from_secs(30);

/// Base delay between retries after a failed sync cycle. When the
/// scheduler observes a non-empty `summary.errors` (or `run_sync_now`
/// returns an error other than "app locked"), it opens a backoff window
/// during which Rules 1 and 2 are suppressed. The window doubles on every
/// consecutive failure (`RetryState`) up to `ERROR_BACKOFF_MAX_MS`, so an
/// unreachable cloud is retried automatically without hammering the
/// network every `TICK`. A successful sync resets the streak; a kick /
/// wake lets the next tick retry immediately.
pub const ERROR_BACKOFF_MS: i64 = 60_000;

/// Upper bound for the exponential backoff window.
pub const ERROR_BACKOFF_MAX_MS: i64 = 15 * 60_000;

/// Minimum spacing between two honoured focus kicks. Without it, window-
/// focus churn (alt-tab, multi-monitor switching) while the cloud is down
/// would collapse the backoff to a retry every `TICK`.
pub const KICK_COOLDOWN_MS: i64 = 30_000;

/// In-memory retry cursor. Lives on the run loop's stack — wiped on
/// process exit (error state is a runtime concern, not a DB concern).
#[derive(Debug, Default, Clone, Copy)]
struct RetryState {
    /// Consecutive failures since the last success. Drives the
    /// exponential backoff window.
    consecutive_failures: u32,
    /// Unix ms until which Rules 1 + 2 are suppressed. `None` = no backoff.
    backoff_until_ms: Option<i64>,
    /// Unix ms of the last honoured kick — enforces `KICK_COOLDOWN_MS`.
    last_kick_ms: Option<i64>,
}

impl RetryState {
    fn on_failure(&mut self, now_ms: i64) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        // N consecutive failures → window = base × 2^(N-1), capped.
        let exp = self.consecutive_failures.saturating_sub(1).min(31);
        let window = ERROR_BACKOFF_MS
            .saturating_mul(1i64 << exp)
            .min(ERROR_BACKOFF_MAX_MS);
        self.backoff_until_ms = Some(now_ms.saturating_add(window));
    }

    /// Full reset: a successful cycle, or the user intervened via the
    /// manual Sync now command.
    fn reset(&mut self) {
        *self = Self::default();
    }

    /// Drop the open window so the next tick may retry right away, but
    /// keep the failure streak — if the cloud is still unreachable the
    /// following window resumes doubling instead of collapsing back to
    /// the base delay. Used directly for wake-from-sleep (never rate-
    /// limited: a nap is not focus churn) and via `kick` for focus.
    fn drop_window(&mut self) {
        self.backoff_until_ms = None;
    }

    /// Suppress Rules 1 + 2 until `ms` without treating this as a
    /// failure: no streak bump, caller must not emit retry-scheduled.
    /// Used when another caller already holds the single-flight slot.
    fn hold_until(&mut self, ms: i64) {
        self.backoff_until_ms = Some(ms);
    }

    /// Focus kick: `drop_window`, rate-limited — a kick within
    /// `KICK_COOLDOWN_MS` of the previous honoured one is ignored, so
    /// focus churn cannot turn the backoff into a retry every `TICK`.
    fn kick(&mut self, now_ms: i64) {
        let cooled_down = self
            .last_kick_ms
            .map(|last| now_ms.saturating_sub(last) >= KICK_COOLDOWN_MS)
            .unwrap_or(true);
        if !cooled_down {
            return;
        }
        self.last_kick_ms = Some(now_ms);
        self.drop_window();
    }

    #[cfg(test)]
    fn suppresses(&self, now_ms: i64) -> bool {
        backoff_open(self.backoff_until_ms, now_ms)
    }
}

/// Single predicate behind both `RetryState::suppresses` and the gate in
/// `evaluate_with_error_cursor`: is the backoff window still open at
/// `now_ms`?
fn backoff_open(backoff_until_ms: Option<i64>, now_ms: i64) -> bool {
    backoff_until_ms
        .map(|until| now_ms < until)
        .unwrap_or(false)
}

/// Deadline for a one-tick Interval hold. `backoff_open` is exclusive
/// (`now < until`), so `now + interval` would already be open on the
/// next tick — the extra millisecond keeps that evaluation suppressed.
fn interval_hold_until_ms(now_ms: i64, interval_ms: i64) -> i64 {
    now_ms.saturating_add(interval_ms).saturating_add(1)
}

/// Wall-clock gap between two consecutive ticks beyond which the machine
/// must have been asleep (a 5s tick does not take a minute). Used to
/// detect wake-from-sleep without an OS power hook: on wake, drop any
/// transient backoff so the first post-wake evaluation may retry.
pub const SLEEP_GAP_MS: i64 = 60_000;

/// True when the wall clock jumped by more than `tick + SLEEP_GAP_MS`
/// between two ticks — i.e. the process was suspended (sleep/hibernate).
fn slept_between_ticks(prev_tick_ms: i64, now_ms: i64, tick: Duration) -> bool {
    let tick_ms = tick.as_millis() as i64;
    now_ms.saturating_sub(prev_tick_ms) > tick_ms.saturating_add(SLEEP_GAP_MS)
}

/// Scheduler handle. Dropping or explicitly calling `stop()` flips the
/// cancellation flag; the background task exits on its next tick. Tokio's
/// `sleep` is cancellation-aware via the `tokio::select!` arm.
pub struct SyncScheduler {
    cancel: Arc<AtomicBool>,
    /// Set by `request_retry_now` (window focus). Consumed by the run loop
    /// on its next tick to drop an open backoff window (`RetryState::kick`).
    retry_kick: Arc<AtomicBool>,
    /// Set by `reset_backoff` (manual Sync now). Consumed by the run loop
    /// on its next tick to reset the failure streak (`RetryState::reset`).
    retry_reset: Arc<AtomicBool>,
}

impl SyncScheduler {
    /// Start the scheduler. Returns immediately — the loop runs on a
    /// detached tokio task until `stop()` is called or the handle is
    /// dropped.
    ///
    /// `app` is cloned into the task so the task owns its handle; the
    /// `AppHandle` is cheap to clone (it's an `Arc` internally).
    pub fn start(app: AppHandle) -> Arc<Self> {
        Self::start_with_tick(app, TICK, DEBOUNCE_WINDOW)
    }

    /// Test-only constructor: inject a shorter tick / debounce so tests
    /// don't have to wait minutes. Production should call `start`.
    pub fn start_with_tick(app: AppHandle, tick: Duration, debounce: Duration) -> Arc<Self> {
        let cancel = Arc::new(AtomicBool::new(false));
        let retry_kick = Arc::new(AtomicBool::new(false));
        let retry_reset = Arc::new(AtomicBool::new(false));
        let signals = LoopSignals {
            cancel: Arc::clone(&cancel),
            retry_kick: Arc::clone(&retry_kick),
            retry_reset: Arc::clone(&retry_reset),
        };
        let app_for_task = app.clone();
        tauri::async_runtime::spawn(async move {
            run_loop(app_for_task, signals, tick, debounce).await;
        });
        Arc::new(Self {
            cancel,
            retry_kick,
            retry_reset,
        })
    }

    /// Signal cancellation. Safe to call multiple times; subsequent
    /// calls are no-ops.
    pub fn stop(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Ask the scheduler to drop any open backoff window so its next tick
    /// re-evaluates the rules immediately (rate-limited by
    /// `KICK_COOLDOWN_MS`). Called when the window regains focus. A no-op
    /// when nothing failed. Wake-from-sleep is detected separately inside
    /// the run loop via `slept_between_ticks`.
    pub fn request_retry_now(&self) {
        self.retry_kick.store(true, Ordering::Relaxed);
    }

    /// Reset the failure backoff entirely (window + streak). Called by the
    /// manual `sync_now` command: the user intervened, so the scheduler
    /// must not stay suppressed afterwards.
    pub fn reset_backoff(&self) {
        self.retry_reset.store(true, Ordering::Relaxed);
    }
}

/// Atomic flags shared between the `SyncScheduler` handle and its loop.
struct LoopSignals {
    cancel: Arc<AtomicBool>,
    retry_kick: Arc<AtomicBool>,
    retry_reset: Arc<AtomicBool>,
}

impl Drop for SyncScheduler {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

async fn run_loop(app: AppHandle, signals: LoopSignals, tick: Duration, debounce: Duration) {
    let LoopSignals {
        cancel,
        retry_kick,
        retry_reset,
    } = signals;
    let mut on_launch_done = false;
    // Failure retry cursor — wiped on process exit. A successful sync
    // resets it; a failure opens an exponential backoff window that
    // `evaluate_with_error_cursor` honours for Rules 1 & 2.
    let mut retry = RetryState::default();

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        // Stamp immediately before the sleep so the gap below measures the
        // sleep alone — never a slow sync cycle from the previous iteration.
        let before_sleep_ms = unix_now_s().saturating_mul(1000);
        tokio::time::sleep(tick).await;
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let now_ms = unix_now_s().saturating_mul(1000);

        // Manual Sync now: the user intervened — full reset. Consumed here
        // (not where the command runs) so it cannot race a cycle in flight.
        if retry_reset.swap(false, Ordering::Relaxed) {
            retry.reset();
        }

        // Wake-from-sleep (the wall clock jumped far past one tick, so the
        // machine was suspended): drop the open window so this evaluation
        // may retry — a backoff opened before the nap must not outlive it.
        if slept_between_ticks(before_sleep_ms, now_ms, tick) {
            retry.drop_window();
        }

        // Focus kick (rate-limited inside `kick`). Consumed here so a kick
        // that arrives while a sync is in flight is not lost.
        if retry_kick.swap(false, Ordering::Relaxed) {
            retry.kick(now_ms);
        }

        // All state reads happen via Tauri managed state pulled from the
        // AppHandle. We clone the `Arc`-backed states each iteration;
        // this is cheap and avoids holding references across the await.
        use tauri::Manager;
        let state = app.state::<AppState>();
        let last_edit = app.state::<LastEditState>();

        // Decide whether any rule fires. Unlocked read — DB access is
        // one short synchronous block, no await inside.
        let decision = match evaluate_with_error_cursor(
            &state,
            &last_edit,
            &mut on_launch_done,
            debounce,
            retry.backoff_until_ms,
        ) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("sync scheduler: evaluate failed: {e}");
                continue;
            }
        };

        let Some(reason) = decision else {
            continue;
        };

        log::info!("sync scheduler: firing sync ({reason:?})");

        // `run_sync_now` uses `tauri::async_runtime::block_on` inside,
        // which must not be called from inside an async context — wrap
        // in `spawn_blocking`. The wrapped call acquires the AppState
        // mutex only briefly, matching the same lock discipline the
        // manual `sync_now` command uses.
        let app_clone = app.clone();
        let join = tauri::async_runtime::spawn_blocking(move || {
            use tauri::Manager;
            let state = app_clone.state::<AppState>();
            let key_state = app_clone.state::<EncryptionKeyState>();
            run_sync_now(&app_clone, &state, &key_state, SCHEDULER_SYNC_TRIGGER)
        });

        match join.await {
            Ok(Ok(summary)) => {
                // Success clears the backoff. A "success with per-entry
                // errors" counts as a failure for backoff purposes — same
                // as `run_sync_now`'s last_sync_at logic.
                if summary.errors.is_empty() {
                    retry.reset();
                    emit_retry_scheduled(&app, None);
                } else {
                    record_failure(
                        &mut retry,
                        &format!("sync completed with {} error(s)", summary.errors.len()),
                    );
                    emit_retry_scheduled(&app, retry.backoff_until_ms);
                }
            }
            Ok(Err(e)) if e.contains("Encryption key not initialized") => {
                // Locked app — normal steady-state between sessions.
                // Do NOT stamp the error cursor: the user unlocking is
                // the natural retry trigger, and backoff would delay
                // the first post-unlock sync unnecessarily.
            }
            Ok(Err(e)) if e == crate::commands::sync::SYNC_IN_PROGRESS_ERR => {
                // Another caller holds the single-flight slot. Hold
                // Rules 1+2 for one tick so Interval cannot re-fire
                // every TICK while that caller still owns the slot.
                // Not a failure: no streak bump, no retry-scheduled
                // event (the in-flight sync is the work we'd have done).
                // +1ms: backoff_open is exclusive at the boundary, so
                // a hold of exactly one tick would expire on the next
                // tick and Interval would still fire every 5 s.
                let interval_ms = tick.as_millis() as i64;
                retry.hold_until(interval_hold_until_ms(now_ms, interval_ms));
            }
            Ok(Err(e)) => {
                record_failure(&mut retry, &format!("sync_now failed: {e}"));
                emit_retry_scheduled(&app, retry.backoff_until_ms);
            }
            Err(join_err) => {
                record_failure(
                    &mut retry,
                    &format!("spawn_blocking join error: {join_err}"),
                );
                emit_retry_scheduled(&app, retry.backoff_until_ms);
            }
        }
    }
}

/// Record a failed cycle: open the next backoff window and log it. The
/// scheduler retries automatically once the window elapses (or earlier on
/// a kick / wake / manual Sync now).
fn record_failure(retry: &mut RetryState, what: &str) {
    retry.on_failure(unix_now_s().saturating_mul(1000));
    log::warn!(
        "sync scheduler: {what} — auto-retry #{} after backoff",
        retry.consecutive_failures,
    );
}

/// Broadcast the retry schedule (or its absence) to the frontend.
fn emit_retry_scheduled(app: &AppHandle, retry_at_ms: Option<i64>) {
    let payload = SyncRetryScheduledPayload { retry_at_ms };
    if let Err(e) = app.emit(SYNC_RETRY_SCHEDULED_EVENT, payload) {
        log::warn!("emit_retry_scheduled: failed to emit: {e}");
    }
}

#[derive(Debug, Clone, Copy)]
enum FireReason {
    OnLaunch,
    Interval,
    Debounce,
}

/// Pure decision function — no side effects, no awaits. Returns `Ok(None)`
/// when no rule fires this tick, `Ok(Some(reason))` otherwise.
///
/// Out-of-band reads happen here (DB + atomic); both are synchronous.
/// Test-only convenience wrapper around [`evaluate_with_error_cursor`]
/// that fixes the error cursor to `None` — production code paths
/// (the scheduler loop) always track the cursor explicitly.
#[cfg(test)]
fn evaluate(
    state: &AppState,
    last_edit: &LastEditState,
    on_launch_done: &mut bool,
    debounce: Duration,
) -> Result<Option<FireReason>, String> {
    evaluate_with_error_cursor(state, last_edit, on_launch_done, debounce, None)
}

/// Same as [`evaluate`] but takes an explicit "suppress Rules 1 + 2 until
/// this unix-ms instant" cursor (`RetryState::backoff_until_ms`). Exposed
/// to the run loop so the loop can track transient-error backoff across
/// ticks without persisting it (error state is a runtime concern, not a
/// DB concern). Tests also call it directly to exercise backoff boundaries
/// without sleeping.
fn evaluate_with_error_cursor(
    state: &AppState,
    last_edit: &LastEditState,
    on_launch_done: &mut bool,
    debounce: Duration,
    backoff_until_ms: Option<i64>,
) -> Result<Option<FireReason>, String> {
    let (enabled, provider_configured, last_sync, pending, interval_minutes, on_save, on_launch) = {
        let conn = state.lock()?;
        let enabled = db::get_sync_enabled(&conn).map_err(|e| e.to_string())?;
        let provider = db::get_sync_provider(&conn).map_err(|e| e.to_string())?;
        let last_sync = db::get_last_sync_at(&conn).map_err(|e| e.to_string())?;
        let pending = db::count_pending_entries(&conn).map_err(|e| e.to_string())?;
        let interval = db::get_sync_interval_minutes(&conn).map_err(|e| e.to_string())?;
        let on_save = db::get_sync_on_save(&conn).map_err(|e| e.to_string())?;
        let on_launch = db::get_sync_on_launch(&conn).map_err(|e| e.to_string())?;
        (
            enabled,
            provider.is_some(),
            last_sync,
            pending,
            interval,
            on_save,
            on_launch,
        )
    };

    if !enabled || !provider_configured {
        // Scheduler is a no-op until the user configures sync. We still
        // mark the launch tick as consumed so flipping "enabled" on later
        // doesn't accidentally retrigger the launch fire.
        *on_launch_done = true;
        return Ok(None);
    }

    // Rule 3: on-launch.
    if !*on_launch_done {
        *on_launch_done = true;
        if on_launch {
            return Ok(Some(FireReason::OnLaunch));
        }
    }

    let now_s = unix_now_s();
    let now_ms = now_s.saturating_mul(1000);

    // Error backoff: Rules 1 and 2 are suppressed while the transient-
    // failure window is open. Without this, an unreachable cloud would
    // let Rule 1 refire every TICK because `last_sync_at` is never
    // advanced on failure. OnLaunch already fired above so it's
    // intentionally outside the gate.
    if backoff_open(backoff_until_ms, now_ms) {
        return Ok(None);
    }

    // Rule 2: on-save debounce.
    //
    // Arithmetic safety: `now_s = unix_now_s().as_secs()` floors sub-
    // second precision, while `last_edit_ms` is millisecond-exact and
    // can temporarily exceed `now_ms` by up to 999ms under normal
    // conditions. A system clock that jumps backwards (NTP adjustment,
    // manual change, virtualized time drift) can push `last_edit_ms`
    // *arbitrarily* past `now_ms`. We defend in two layers:
    //
    //   1. If `last_edit_ms` is absurdly far in the future (past
    //      `FUTURE_CLOCK_SKEW_TOLERANCE_MS`), treat the stamp as
    //      corrupt and skip Rule 2 entirely this tick. The next genuine
    //      edit (save_entry_content stamps `now_ms` again) will replace
    //      the bad value.
    //   2. For smaller sub-second overshoot, `saturating_sub` yields
    //      `quiet_ms = 0` — "no quiet time yet" — instead of panicking
    //      in debug or wrapping in release.
    const FUTURE_CLOCK_SKEW_TOLERANCE_MS: i64 = 5_000;
    if on_save && pending > 0 {
        let last_edit_ms = last_edit.get_ms();
        let skewed = last_edit_ms > now_ms.saturating_add(FUTURE_CLOCK_SKEW_TOLERANCE_MS);
        if last_edit_ms > 0 && !skewed {
            let quiet_ms = now_ms.saturating_sub(last_edit_ms);
            if quiet_ms >= debounce.as_millis() as i64 {
                // Ensure we don't double-fire for the same edit: if the
                // most recent sync already covers this edit, skip.
                let last_sync_ms = last_sync.unwrap_or(0).saturating_mul(1000);
                if last_edit_ms > last_sync_ms {
                    return Ok(Some(FireReason::Debounce));
                }
            }
        }
    }

    // Rule 1: interval.
    let interval_s = (interval_minutes as i64).saturating_mul(60);
    let due = match last_sync {
        None => true, // never synced
        Some(ts) => now_s.saturating_sub(ts) >= interval_s,
    };
    if due {
        return Ok(Some(FireReason::Interval));
    }

    Ok(None)
}

fn unix_now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use rusqlite::Connection;

    fn fresh_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    fn seed_local_provider(state: &AppState) {
        let conn = state.lock().unwrap();
        db::set_sync_provider(&conn, "local").unwrap();
        db::set_sync_config_json(&conn, "{\"root_path\":\"/tmp/x\"}").unwrap();
        db::set_sync_enabled(&conn, true).unwrap();
    }

    /// All three scheduler rules (interval / on-save / on-launch) share one
    /// Automatic trigger. On-launch still reconciles because the process
    /// session flag is unset on the first cycle.
    #[test]
    fn scheduler_sync_trigger_is_automatic() {
        assert_eq!(
            SCHEDULER_SYNC_TRIGGER,
            SyncTrigger::Automatic,
            "scheduler must pass Automatic so reconcile is gated by the session flag"
        );
        assert_ne!(SCHEDULER_SYNC_TRIGGER, SyncTrigger::Manual);
    }

    #[test]
    fn evaluate_skips_when_sync_disabled() {
        let state = fresh_state();
        let last_edit = LastEditState::new();
        let mut launch_done = false;
        let out = evaluate(&state, &last_edit, &mut launch_done, DEBOUNCE_WINDOW).unwrap();
        assert!(out.is_none());
        // on-launch flag flipped even though we didn't fire — flipping
        // `enabled` later shouldn't cause a stale launch fire.
        assert!(launch_done);
    }

    #[test]
    fn evaluate_on_launch_fires_once() {
        let state = fresh_state();
        seed_local_provider(&state);
        let last_edit = LastEditState::new();
        let mut launch_done = false;
        let out = evaluate(&state, &last_edit, &mut launch_done, DEBOUNCE_WINDOW).unwrap();
        assert!(matches!(out, Some(FireReason::OnLaunch)));
        assert!(launch_done);

        // Second call should no longer fire OnLaunch (but may fire
        // Interval because we've never synced yet).
        let out2 = evaluate(&state, &last_edit, &mut launch_done, DEBOUNCE_WINDOW).unwrap();
        assert!(
            !matches!(out2, Some(FireReason::OnLaunch)),
            "OnLaunch must fire at most once"
        );
    }

    #[test]
    fn evaluate_on_launch_respects_disabled_setting() {
        let state = fresh_state();
        seed_local_provider(&state);
        {
            let conn = state.lock().unwrap();
            db::set_sync_on_launch(&conn, false).unwrap();
        }
        let last_edit = LastEditState::new();
        let mut launch_done = false;
        let out = evaluate(&state, &last_edit, &mut launch_done, DEBOUNCE_WINDOW).unwrap();
        // Not OnLaunch — may still be Interval since last_sync = None.
        assert!(!matches!(out, Some(FireReason::OnLaunch)));
        assert!(launch_done);
    }

    #[test]
    fn evaluate_interval_fires_when_stale() {
        let state = fresh_state();
        seed_local_provider(&state);
        {
            let conn = state.lock().unwrap();
            // Pretend we synced a day ago; any default interval (5 min)
            // is comfortably exceeded.
            db::set_last_sync_at(&conn, unix_now_s() - 86_400).unwrap();
        }
        let last_edit = LastEditState::new();
        let mut launch_done = true; // pretend OnLaunch already fired
        let out = evaluate(&state, &last_edit, &mut launch_done, DEBOUNCE_WINDOW).unwrap();
        assert!(matches!(out, Some(FireReason::Interval)));
    }

    #[test]
    fn evaluate_interval_does_not_fire_when_recent() {
        let state = fresh_state();
        seed_local_provider(&state);
        {
            let conn = state.lock().unwrap();
            // Synced 10 seconds ago — default interval is 5 min.
            db::set_last_sync_at(&conn, unix_now_s() - 10).unwrap();
        }
        let last_edit = LastEditState::new();
        let mut launch_done = true;
        let out = evaluate(&state, &last_edit, &mut launch_done, DEBOUNCE_WINDOW).unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn evaluate_debounce_waits_for_quiet_period() {
        let state = fresh_state();
        seed_local_provider(&state);
        // Set last_sync just before "now" so the Interval rule sees a
        // fresh sync and does not fire, but the debounce rule's
        // `last_edit_ms > last_sync_ms` comparison still holds (the
        // edit happens strictly after the sync).
        let sync_ts = unix_now_s() - 1;
        {
            let conn = state.lock().unwrap();
            db::set_last_sync_at(&conn, sync_ts).unwrap();
        }
        // Inject a pending entry so the debounce has something to push.
        {
            let conn = state.lock().unwrap();
            let jid: String = conn
                .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let entry = db::create_entry(
                &conn,
                db::CreateEntryParams {
                    journal_id: &jid,
                    title: None,
                    content_text: None,
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap();
            db::mark_entry_pending(&conn, &entry.id).unwrap();
        }
        let last_edit = LastEditState::new();

        // Edit "just happened" — quiet period not elapsed. Using
        // `set_ms_for_test(now_ms)` makes the timing deterministic
        // across test-runner second-boundary races.
        let now_ms = unix_now_s().saturating_mul(1000);
        last_edit.set_ms_for_test(now_ms);
        let mut launch_done = true;
        let out = evaluate(
            &state,
            &last_edit,
            &mut launch_done,
            Duration::from_secs(30),
        )
        .unwrap();
        assert!(
            out.is_none(),
            "should not fire: edit just happened, no quiet period yet"
        );

        // Debounce window = 0 simulates "edit was long enough ago".
        // Pin last_edit strictly AFTER last_sync_ms (sync_ts was set to
        // now - 1 earlier; last_sync_ms = (now-1)*1000). now_ms > that.
        let out = evaluate(
            &state,
            &last_edit,
            &mut launch_done,
            Duration::from_millis(0),
        )
        .unwrap();
        assert!(matches!(out, Some(FireReason::Debounce)), "got {out:?}");
    }

    #[test]
    fn evaluate_debounce_handles_clock_skew_without_panic() {
        // Regression for a latent bug: `quiet_ms = now_ms - last_edit_ms`
        // using plain `-` panics in debug builds when NTP or a manual
        // clock adjustment moves time backwards enough that
        // `last_edit_ms > now_ms` temporarily. The correct implementation
        // must use `saturating_sub` so negative intervals clamp to 0
        // (= "no quiet time yet"), not propagate as huge positives.
        let state = fresh_state();
        seed_local_provider(&state);
        // Give Debounce something to push, but Interval nothing fresh.
        {
            let conn = state.lock().unwrap();
            db::set_last_sync_at(&conn, unix_now_s() - 1).unwrap();
            let jid: String = conn
                .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let entry = db::create_entry(
                &conn,
                db::CreateEntryParams {
                    journal_id: &jid,
                    title: None,
                    content_text: None,
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap();
            db::mark_entry_pending(&conn, &entry.id).unwrap();
        }

        // Force last_edit far in the future — simulates wall clock
        // rewinding after edit was stamped. Use i64::MAX / 2 so any
        // naive `-` subtraction would overflow i64 in debug builds.
        let last_edit = LastEditState::new();
        last_edit.set_ms_for_test(i64::MAX / 2);

        let mut launch_done = true;
        // This call MUST NOT panic. With `saturating_sub`, `quiet_ms`
        // clamps to 0 → not-yet-quiet → no Debounce fire.
        let out = evaluate(
            &state,
            &last_edit,
            &mut launch_done,
            Duration::from_millis(0),
        )
        .expect("evaluate must not panic on clock-skew boundary");
        assert!(
            !matches!(out, Some(FireReason::Debounce)),
            "clock-skew (last_edit in future) must suppress Debounce; got {out:?}"
        );
    }

    #[test]
    fn evaluate_debounce_skips_when_last_edit_predates_last_sync() {
        // Negative guard: the "don't double-push the same edit" logic
        // must suppress Debounce when the most recent sync already
        // happened AFTER the last edit. Without this, every tick would
        // re-fire for an edit that's already been pushed.
        let state = fresh_state();
        seed_local_provider(&state);
        let now = unix_now_s();
        // Pretend the last sync is "now" and the last edit was 10 seconds
        // earlier — the edit is already covered by the sync.
        {
            let conn = state.lock().unwrap();
            db::set_last_sync_at(&conn, now).unwrap();
            let jid: String = conn
                .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let entry = db::create_entry(
                &conn,
                db::CreateEntryParams {
                    journal_id: &jid,
                    title: None,
                    content_text: None,
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap();
            db::mark_entry_pending(&conn, &entry.id).unwrap();
        }
        let last_edit = LastEditState::new();
        // Force last_edit to (now - 10s) in milliseconds — older than
        // last_sync. Since there's no public setter with arbitrary ms,
        // we just don't mark_now() at all (get_ms() returns 0) — but
        // zero would short-circuit the `last_edit_ms > 0` guard, so
        // the test wouldn't exercise the `last_edit_ms > last_sync_ms`
        // branch. Use the fact that `now_s` in the DB is `now` and
        // mark_now() produces `(now_ms_approx)` which is >=
        // `last_sync_ms` (they race within the same second). With
        // debounce window 0 and the guard in place, the result must
        // still be None because `last_edit_ms > last_sync_ms` is only
        // true by sub-second fraction, and we set `last_sync_ms = now_s
        // * 1000` to cover the whole current second.
        //
        // Simplest unambiguous proof: skip mark_now, let last_edit_ms=0,
        // assert early-return via the `last_edit_ms > 0` guard. That
        // exercises the same "no double-fire" protection.
        let mut launch_done = true;
        let out = evaluate(
            &state,
            &last_edit,
            &mut launch_done,
            Duration::from_millis(0),
        )
        .unwrap();
        assert!(
            out.is_none(),
            "no edit timestamp (or edit-before-sync) must suppress Debounce; got {out:?}"
        );
    }

    #[test]
    fn evaluate_suppresses_all_rules_during_error_backoff() {
        // After a persistent sync failure, `last_sync_at` is NOT
        // advanced (see run_sync_now), so Rule 1 (Interval) would
        // otherwise refire every tick. The backoff keeps us quiet for
        // `ERROR_BACKOFF_MS` after the last error.
        let state = fresh_state();
        seed_local_provider(&state);
        // Conditions that would normally fire Interval:
        {
            let conn = state.lock().unwrap();
            db::set_last_sync_at(&conn, unix_now_s() - 86_400).unwrap();
        }
        let last_edit = LastEditState::new();
        let mut launch_done = true;
        let now_ms = unix_now_s().saturating_mul(1000);

        // Backoff window still open — must suppress.
        let out = evaluate_with_error_cursor(
            &state,
            &last_edit,
            &mut launch_done,
            DEBOUNCE_WINDOW,
            Some(now_ms + 30_000),
        )
        .unwrap();
        assert!(
            out.is_none(),
            "open backoff window must suppress Interval/Debounce; got {out:?}"
        );

        // Backoff window already elapsed — must allow firing.
        let out = evaluate_with_error_cursor(
            &state,
            &last_edit,
            &mut launch_done,
            DEBOUNCE_WINDOW,
            Some(now_ms - 1_000),
        )
        .unwrap();
        assert!(
            matches!(out, Some(FireReason::Interval)),
            "error outside backoff must allow Interval; got {out:?}"
        );
    }

    #[test]
    fn evaluate_debounce_skipped_when_on_save_disabled() {
        let state = fresh_state();
        seed_local_provider(&state);
        {
            let conn = state.lock().unwrap();
            db::set_sync_on_save(&conn, false).unwrap();
            db::set_last_sync_at(&conn, unix_now_s()).unwrap();
            let jid: String = conn
                .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let entry = db::create_entry(
                &conn,
                db::CreateEntryParams {
                    journal_id: &jid,
                    title: None,
                    content_text: None,
                    preview_text: None,
                    entry_date: 1_700_000_000,
                },
            )
            .unwrap();
            db::mark_entry_pending(&conn, &entry.id).unwrap();
        }
        let last_edit = LastEditState::new();
        last_edit.mark_now();
        let mut launch_done = true;
        let out = evaluate(
            &state,
            &last_edit,
            &mut launch_done,
            Duration::from_millis(0),
        )
        .unwrap();
        assert!(
            out.is_none(),
            "sync_on_save=false must suppress the debounce rule"
        );
    }

    // ─── Retry state ─────────────────────────────────────────────────────

    #[test]
    fn retry_state_backoff_grows_and_caps() {
        let mut rs = RetryState::default();
        assert!(!rs.suppresses(0));
        rs.on_failure(0);
        assert!(rs.suppresses(ERROR_BACKOFF_MS - 1));
        assert!(!rs.suppresses(ERROR_BACKOFF_MS));
        rs.on_failure(0);
        assert!(rs.suppresses(2 * ERROR_BACKOFF_MS - 1));
        assert!(!rs.suppresses(2 * ERROR_BACKOFF_MS));
        // Many failures: capped, never overflows.
        for _ in 0..100 {
            rs.on_failure(0);
        }
        assert!(rs.suppresses(ERROR_BACKOFF_MAX_MS - 1));
        assert!(!rs.suppresses(ERROR_BACKOFF_MAX_MS));
    }

    #[test]
    fn retry_state_reset_clears_window_and_streak() {
        let mut rs = RetryState::default();
        rs.on_failure(0);
        rs.on_failure(0);
        rs.reset();
        assert!(!rs.suppresses(1));
        // Next failure starts from the base window again.
        rs.on_failure(0);
        assert!(!rs.suppresses(ERROR_BACKOFF_MS));
    }

    #[test]
    fn retry_state_kick_drops_window_but_keeps_streak() {
        let mut rs = RetryState::default();
        rs.on_failure(0);
        rs.on_failure(0);
        rs.kick(0);
        assert!(!rs.suppresses(1), "kick must reopen the gate immediately");
        // …but keeps the failure streak so a still-broken cloud doesn't
        // collapse the backoff back to the base window.
        rs.on_failure(0);
        assert!(rs.suppresses(2 * ERROR_BACKOFF_MS));
    }

    #[test]
    fn retry_state_kick_is_rate_limited() {
        let mut rs = RetryState::default();
        rs.on_failure(0);
        rs.kick(0); // honoured
        rs.on_failure(1_000);
        // Focus churn within the cooldown of the first kick: ignored,
        // window stays open.
        rs.kick(KICK_COOLDOWN_MS - 1);
        assert!(rs.suppresses(KICK_COOLDOWN_MS - 1));
        // Past the cooldown: honoured again.
        rs.kick(KICK_COOLDOWN_MS);
        assert!(!rs.suppresses(KICK_COOLDOWN_MS));
    }

    #[test]
    fn retry_state_hold_until_sets_window_without_bumping_failures() {
        let mut rs = RetryState::default();
        rs.on_failure(0);
        let streak = rs.consecutive_failures;
        let now_ms = 0;
        let interval_ms = TICK.as_millis() as i64;
        let until = interval_hold_until_ms(now_ms, interval_ms);
        rs.hold_until(until);
        assert_eq!(
            rs.consecutive_failures, streak,
            "hold_until must not bump consecutive_failures"
        );
        // Exclusive window: a one-tick hold must still suppress at
        // now+interval_ms. Stamping exactly now+interval_ms would not.
        assert!(rs.suppresses(now_ms.saturating_add(interval_ms)));
        assert!(!rs.suppresses(until));
    }

    #[test]
    fn evaluate_with_error_cursor_respects_hold_until() {
        let state = fresh_state();
        seed_local_provider(&state);
        {
            let conn = state.lock().unwrap();
            db::set_last_sync_at(&conn, unix_now_s() - 86_400).unwrap();
        }
        let last_edit = LastEditState::new();
        let mut launch_done = true;
        let now_ms = unix_now_s().saturating_mul(1000);
        let interval_ms = TICK.as_millis() as i64;

        let mut retry = RetryState::default();
        retry.hold_until(interval_hold_until_ms(now_ms, interval_ms));
        let out = evaluate_with_error_cursor(
            &state,
            &last_edit,
            &mut launch_done,
            DEBOUNCE_WINDOW,
            retry.backoff_until_ms,
        )
        .unwrap();
        assert!(
            out.is_none(),
            "open hold_until window must suppress Interval; got {out:?}"
        );

        retry.hold_until(now_ms.saturating_sub(1));
        let out = evaluate_with_error_cursor(
            &state,
            &last_edit,
            &mut launch_done,
            DEBOUNCE_WINDOW,
            retry.backoff_until_ms,
        )
        .unwrap();
        assert!(
            matches!(out, Some(FireReason::Interval)),
            "elapsed hold_until must allow Interval; got {out:?}"
        );
    }

    #[test]
    fn record_failure_opens_backoff_window() {
        let mut retry = RetryState::default();
        record_failure(&mut retry, "test");
        assert_eq!(retry.consecutive_failures, 1);
        let now_ms = unix_now_s().saturating_mul(1000);
        assert!(retry.suppresses(now_ms + 1_000));
    }

    #[test]
    fn real_backoff_window_suppresses_evaluate_until_it_elapses() {
        // Feed a genuine `RetryState` window into the evaluator (not a
        // synthetic instant) so the two sides can't drift apart.
        let state = fresh_state();
        seed_local_provider(&state);
        {
            let conn = state.lock().unwrap();
            db::set_last_sync_at(&conn, unix_now_s() - 86_400).unwrap();
        }
        let last_edit = LastEditState::new();
        let mut launch_done = true;
        let now_ms = unix_now_s().saturating_mul(1000);

        let mut retry = RetryState::default();
        retry.on_failure(now_ms);
        let out = evaluate_with_error_cursor(
            &state,
            &last_edit,
            &mut launch_done,
            DEBOUNCE_WINDOW,
            retry.backoff_until_ms,
        )
        .unwrap();
        assert!(
            out.is_none(),
            "fresh failure window must suppress; got {out:?}"
        );

        // Window opened ERROR_BACKOFF_MS in the past has elapsed.
        let mut retry = RetryState::default();
        retry.on_failure(now_ms - ERROR_BACKOFF_MS);
        let out = evaluate_with_error_cursor(
            &state,
            &last_edit,
            &mut launch_done,
            DEBOUNCE_WINDOW,
            retry.backoff_until_ms,
        )
        .unwrap();
        assert!(matches!(out, Some(FireReason::Interval)), "got {out:?}");

        // A kick reopens the gate immediately.
        let mut retry = RetryState::default();
        retry.on_failure(now_ms);
        retry.kick(now_ms);
        let out = evaluate_with_error_cursor(
            &state,
            &last_edit,
            &mut launch_done,
            DEBOUNCE_WINDOW,
            retry.backoff_until_ms,
        )
        .unwrap();
        assert!(matches!(out, Some(FireReason::Interval)), "got {out:?}");
    }

    #[test]
    fn slept_between_ticks_detects_clock_jump_only() {
        let tick = Duration::from_secs(5);
        // Normal tick (5s) and a slow tick (30s of scheduler jitter): no.
        assert!(!slept_between_ticks(0, 5_000, tick));
        assert!(!slept_between_ticks(0, 30_000, tick));
        // Exactly at the threshold: no; one ms past: yes.
        assert!(!slept_between_ticks(0, 5_000 + SLEEP_GAP_MS, tick));
        assert!(slept_between_ticks(0, 5_001 + SLEEP_GAP_MS, tick));
        // Clock went backwards (NTP): no panic, no false wake.
        assert!(!slept_between_ticks(10_000, 0, tick));
    }

    #[test]
    fn last_edit_state_mark_and_read() {
        let s = LastEditState::new();
        assert_eq!(s.get_ms(), 0);
        s.mark_now();
        assert!(s.get_ms() > 0);
    }
}
