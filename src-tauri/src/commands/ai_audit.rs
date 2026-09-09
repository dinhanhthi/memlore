//! Tauri commands for the AI audit log (Phase 6 Stretch S2-2 + S3).
//!
//! Provides five commands:
//! - [`list_ai_audit_log`]       — paginated, filterable fetch (newest-first)
//! - [`clear_ai_audit_log`]      — delete all rows, returns count
//! - [`get_ai_audit_retention_days`] — read retention setting (default 90)
//! - [`set_ai_audit_retention_days`] — write one of the retention presets
//! - [`summarize_ai_usage`]      — aggregate usage statistics for a time period
//!
//! ## Dual-range design
//! The user-facing presets are capped at **365 days** (reasonable journal
//! retention). The backend constant `MAX_RETENTION_DAYS = 36_500` is a
//! defensive cap against hand-edited DB values or future code bugs — a row
//! that somehow stores "100 years" would still compute a safe cutoff
//! instead of overflowing `i64`.

use crate::ai::audit::{AUDIT_RETENTION_DAYS_KEY, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS};
use crate::db;
use crate::db::queries::{AiAuditLogFilter, AiAuditLogRow, AiUsageSummary};
use crate::AppState;

/// Maximum days the **user-facing** selector allows. The internal
/// `MAX_RETENTION_DAYS` in `audit.rs` is larger — it guards against
/// hand-edited DB rows, not UI input.
const UI_MAX_DAYS: u32 = 365;

const UI_RETENTION_PRESETS: [u32; 4] = [30, 90, 180, UI_MAX_DAYS];

fn normalize_retention_days(days: u32) -> u32 {
    UI_RETENTION_PRESETS
        .into_iter()
        .min_by_key(|preset| preset.abs_diff(days))
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

fn read_normalized_retention(conn: &rusqlite::Connection) -> Result<u32, String> {
    let raw = db::queries::get_setting(conn, AUDIT_RETENTION_DAYS_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS);
    let normalized = normalize_retention_days(raw.min(MAX_RETENTION_DAYS));
    if normalized != raw {
        db::queries::set_setting(conn, AUDIT_RETENTION_DAYS_KEY, &normalized.to_string())
            .map_err(|e| e.to_string())?;
    }
    Ok(normalized)
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Return up to `limit` audit rows (newest-first) starting at `offset`,
/// with optional multi-value filters.
#[tauri::command]
pub async fn list_ai_audit_log(
    state: tauri::State<'_, AppState>,
    filter: AiAuditLogFilter,
    limit: u32,
    offset: u32,
) -> Result<Vec<AiAuditLogRow>, String> {
    state.with_conn(|conn| {
        db::queries::list_ai_audit_log(conn, &filter, limit as i64, offset as i64)
            .map_err(|e| e.to_string())
    })
}

/// Delete every row in `ai_audit_log`. Returns the number of rows deleted.
#[tauri::command]
pub async fn clear_ai_audit_log(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    state.with_conn(|conn| {
        db::queries::clear_ai_audit_log(conn)
            .map(|n| n as u64)
            .map_err(|e| e.to_string())
    })
}

/// Read the retention setting. Returns `DEFAULT_RETENTION_DAYS` (90) when
/// unset. Legacy free-form values are atomically normalized to the nearest
/// current preset so every consumer sees the same stored value.
#[tauri::command]
pub async fn get_ai_audit_retention_days(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    state.with_conn(read_normalized_retention)
}

/// Persist a new retention value.
///
/// Free-form callers are normalized to the nearest supported preset as a
/// defence-in-depth guard; the UI only submits exact preset values.
#[tauri::command]
pub async fn set_ai_audit_retention_days(
    state: tauri::State<'_, AppState>,
    days: u32,
) -> Result<(), String> {
    let normalized = normalize_retention_days(days);
    state.with_conn(|conn| {
        db::queries::set_setting(conn, AUDIT_RETENTION_DAYS_KEY, &normalized.to_string())
            .map_err(|e| e.to_string())
    })
}

// ─── Usage period ─────────────────────────────────────────────────────────────

/// Time-range selector for the Usage dashboard.
/// Serialized to/from the wire as `"24h"`, `"7d"`, `"30d"`, `"90d"`, `"all"`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum UsagePeriod {
    #[serde(rename = "24h")]
    H24,
    #[serde(rename = "7d")]
    D7,
    #[serde(rename = "30d")]
    D30,
    #[serde(rename = "90d")]
    D90,
    #[serde(rename = "all")]
    All,
}

impl UsagePeriod {
    /// Return the wire key for serialisation and the `since_ms` lower-bound.
    pub fn to_since_ms(&self) -> (String, i64) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let (key, ms) = match self {
            UsagePeriod::H24 => ("24h", now_ms - 24 * 3_600_000),
            UsagePeriod::D7 => ("7d", now_ms - 7 * 86_400_000),
            UsagePeriod::D30 => ("30d", now_ms - 30 * 86_400_000),
            UsagePeriod::D90 => ("90d", now_ms - 90 * 86_400_000),
            UsagePeriod::All => ("all", 0),
        };
        (key.to_string(), ms)
    }
}

/// Aggregate usage statistics over the given time period.
///
/// Returns headline totals, a per-provider breakdown, a grouped
/// provider×model×feature table, and a daily tokens-out series.
/// No cost or pricing information is included.
#[tauri::command]
pub async fn summarize_ai_usage(
    state: tauri::State<'_, AppState>,
    period: UsagePeriod,
) -> Result<AiUsageSummary, String> {
    let (period_key, since_ms) = period.to_since_ms();
    state.with_conn(|conn| {
        db::queries::summarize_ai_audit(conn, &period_key, since_ms).map_err(|e| e.to_string())
    })
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::{insert_ai_audit_log, AiAuditLogInsert};
    use crate::db::schema::migrate;
    use rusqlite::Connection;

    fn make_state() -> AppState {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        AppState::new(conn)
    }

    /// Helper: build a sample insert row with configurable fields.
    fn row(created_at: i64) -> AiAuditLogInsert {
        AiAuditLogInsert {
            created_at,
            feature: "smart_title".into(),
            operation: "chat".into(),
            provider_id: "openai".into(),
            model_id: "gpt-4o-mini".into(),
            endpoint_host: "api.openai.com".into(),
            endpoint_class: "remote".into(),
            payload_bytes: 42,
            latency_ms: 150,
            status: "ok".into(),
            error_code: None,
            tokens_in: Some(100),
            tokens_out: Some(50),
        }
    }

    // ── Test 1: list returns rows ordered by created_at DESC ───────────────

    #[test]
    fn list_ai_audit_log_returns_rows_ordered_by_created_at_desc() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // Insert 3 rows with timestamps 100, 300, 200
        for ts in [100i64, 300, 200] {
            insert_ai_audit_log(&conn, &row(ts)).unwrap();
        }
        drop(conn);

        let rows = state
            .with_conn(|c| {
                db::queries::list_ai_audit_log(c, &AiAuditLogFilter::default(), 10, 0)
                    .map_err(|e| e.to_string())
            })
            .unwrap();

        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].created_at, 300);
        assert_eq!(rows[1].created_at, 200);
        assert_eq!(rows[2].created_at, 100);
    }

    // ── Test 2: list respects limit + offset ──────────────────────────────

    #[test]
    fn list_ai_audit_log_respects_limit_offset() {
        let state = make_state();
        let conn = state.lock().unwrap();
        // Insert 5 rows: timestamps 100..500
        for ts in [100i64, 200, 300, 400, 500] {
            insert_ai_audit_log(&conn, &row(ts)).unwrap();
        }
        drop(conn);

        // Ordered desc: [500, 400, 300, 200, 100]
        // limit=2, offset=1 → [400, 300]
        let rows = state
            .with_conn(|c| {
                db::queries::list_ai_audit_log(c, &AiAuditLogFilter::default(), 2, 1)
                    .map_err(|e| e.to_string())
            })
            .unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].created_at, 400);
        assert_eq!(rows[1].created_at, 300);
    }

    // ── Test 3: list filters by feature ───────────────────────────────────

    #[test]
    fn list_ai_audit_log_filters_by_feature() {
        let state = make_state();
        let conn = state.lock().unwrap();

        let mut r1 = row(100);
        r1.feature = "smart_title".into();
        insert_ai_audit_log(&conn, &r1).unwrap();

        let mut r2 = row(200);
        r2.feature = "daily_chat".into();
        insert_ai_audit_log(&conn, &r2).unwrap();

        let mut r3 = row(300);
        r3.feature = "smart_title".into();
        insert_ai_audit_log(&conn, &r3).unwrap();

        drop(conn);

        let filter = AiAuditLogFilter {
            features: Some(vec!["smart_title".into()]),
            ..Default::default()
        };
        let rows = state
            .with_conn(|c| {
                db::queries::list_ai_audit_log(c, &filter, 10, 0).map_err(|e| e.to_string())
            })
            .unwrap();

        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.feature == "smart_title"));
    }

    // ── Test 4: list filters by provider + classification combined ─────────

    #[test]
    fn list_ai_audit_log_filters_by_provider_and_classification_combined() {
        let state = make_state();
        let conn = state.lock().unwrap();

        // r1: openai + remote
        let mut r1 = row(100);
        r1.provider_id = "openai".into();
        r1.endpoint_class = "remote".into();
        insert_ai_audit_log(&conn, &r1).unwrap();

        // r2: ollama + local
        let mut r2 = row(200);
        r2.provider_id = "ollama".into();
        r2.endpoint_class = "local".into();
        insert_ai_audit_log(&conn, &r2).unwrap();

        // r3: anthropic + remote
        let mut r3 = row(300);
        r3.provider_id = "anthropic".into();
        r3.endpoint_class = "remote".into();
        insert_ai_audit_log(&conn, &r3).unwrap();

        // r4: claude-cli + subscription
        let mut r4 = row(400);
        r4.provider_id = "claude-cli".into();
        r4.endpoint_class = "subscription".into();
        insert_ai_audit_log(&conn, &r4).unwrap();

        drop(conn);

        // Multi-value providers + single classification
        // providers: [openai, anthropic], classifications: [remote]
        // Expected: r1 (openai+remote) and r3 (anthropic+remote)
        let filter = AiAuditLogFilter {
            providers: Some(vec!["openai".into(), "anthropic".into()]),
            classifications: Some(vec!["remote".into()]),
            ..Default::default()
        };
        let rows = state
            .with_conn(|c| {
                db::queries::list_ai_audit_log(c, &filter, 10, 0).map_err(|e| e.to_string())
            })
            .unwrap();

        assert_eq!(rows.len(), 2);
        let provider_ids: Vec<&str> = rows.iter().map(|r| r.provider_id.as_str()).collect();
        assert!(provider_ids.contains(&"openai"));
        assert!(provider_ids.contains(&"anthropic"));
    }

    // ── Test 5: list filters by since ─────────────────────────────────────

    #[test]
    fn list_ai_audit_log_since_filter_excludes_older_rows() {
        let state = make_state();
        let conn = state.lock().unwrap();

        // Insert rows at t=100, t=500, t=1000
        for ts in [100i64, 500, 1000] {
            insert_ai_audit_log(&conn, &row(ts)).unwrap();
        }
        drop(conn);

        // since=500 → only rows with created_at >= 500 (t=500 and t=1000)
        let filter = AiAuditLogFilter {
            since: Some(500),
            ..Default::default()
        };
        let rows = state
            .with_conn(|c| {
                db::queries::list_ai_audit_log(c, &filter, 10, 0).map_err(|e| e.to_string())
            })
            .unwrap();

        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.created_at >= 500));
        // Row at t=100 must be excluded
        assert!(!rows.iter().any(|r| r.created_at == 100));
    }

    // ── Test 6: clear returns deletion count ──────────────────────────────

    #[test]
    fn clear_ai_audit_log_returns_deletion_count() {
        let state = make_state();
        let conn = state.lock().unwrap();

        for ts in [100i64, 200, 300] {
            insert_ai_audit_log(&conn, &row(ts)).unwrap();
        }
        drop(conn);

        let deleted = state
            .with_conn(|c| {
                db::queries::clear_ai_audit_log(c)
                    .map(|n| n as u64)
                    .map_err(|e| e.to_string())
            })
            .unwrap();

        assert_eq!(deleted, 3);

        let remaining = state
            .with_conn(|c| {
                db::queries::list_ai_audit_log(c, &AiAuditLogFilter::default(), 100, 0)
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(remaining.is_empty());
    }

    // ── Test 7: retention values normalize to the nearest preset ────────────

    #[test]
    fn normalize_retention_days_uses_nearest_preset_and_breaks_ties_lower() {
        assert_eq!(normalize_retention_days(0), 30);
        assert_eq!(normalize_retention_days(30), 30);
        assert_eq!(normalize_retention_days(60), 30);
        assert_eq!(normalize_retention_days(61), 90);
        assert_eq!(normalize_retention_days(135), 90);
        assert_eq!(normalize_retention_days(136), 180);
        assert_eq!(normalize_retention_days(272), 180);
        assert_eq!(normalize_retention_days(273), 365);
        assert_eq!(normalize_retention_days(9_999), 365);
    }

    // ── Test 8: get defaults to 90 when unset ─────────────────────────────

    #[test]
    fn get_ai_audit_retention_days_defaults_to_90_when_unset() {
        let state = make_state();

        // No setting written — should return DEFAULT_RETENTION_DAYS (90)
        let days = state.with_conn(read_normalized_retention).unwrap();

        assert_eq!(days, 90);
    }

    #[test]
    fn get_ai_audit_retention_days_persists_normalized_legacy_value() {
        let state = make_state();
        let conn = state.lock().unwrap();
        db::queries::set_setting(&conn, AUDIT_RETENTION_DAYS_KEY, "31").unwrap();

        assert_eq!(read_normalized_retention(&conn).unwrap(), 30);
        assert_eq!(
            db::queries::get_setting(&conn, AUDIT_RETENTION_DAYS_KEY)
                .unwrap()
                .as_deref(),
            Some("30")
        );
    }
}
