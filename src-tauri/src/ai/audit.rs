//! AI audit-log instrumentation (Phase 6 Stretch S2-1).
//!
//! Every `AIProvider` call that enters `ProviderRegistry` is wrapped by
//! [`AuditingProvider`] which records timing, token counts (when the inner
//! provider supports it), and the call outcome to `ai_audit_log`.
//!
//! ## Privacy guarantee
//! **No content fields.** The audit row never contains message text, embedding
//! vectors, image bytes, image prompts, or API keys. Only metadata is recorded.
//!
//! ## Token-usage plumbing (`TokenUsageSlot`)
//!
//! The `AIProvider` trait cannot return token counts without changing existing
//! method signatures (which would require updating ~10 call sites). Instead:
//!
//! 1. `AuditingProvider::new()` creates a `TokenUsageSlot`
//!    (`Arc<Mutex<Option<TokenUsage>>>`).
//! 2. It calls `inner.set_usage_sink(slot.clone())` once at construction time.
//! 3. The inner provider stores the slot reference in an `RwLock<Option<…>>`
//!    and, just before returning from `embed` / `chat`, writes the token counts
//!    into it.
//! 4. After the inner call returns, the wrapper reads and clears the slot.
//!
//! **Known limitation:** this pattern is NOT safe for concurrent calls to the
//! same provider instance. Two concurrent tasks sharing one provider would race
//! on the slot — Task A's tokens could be attributed to Task B's row.
//! `ProviderRegistry` returns `Arc<dyn AIProvider>` clones so this is only an
//! issue if callers hold onto the same Arc and call it concurrently, which no
//! current feature code does. Document here so a future reviewer doesn't add
//! concurrency assuming it's safe.
//!
//! ## Feature attribution (`with_feature` / `current_feature`)
//!
//! Call sites can annotate their provider calls with a stable feature label:
//!
//! ```rust,ignore
//! ai::audit::with_feature("smart_title", async {
//!     provider.chat(&messages, opts).await
//! }).await;
//! ```
//!
//! Without a scope the feature field defaults to `"unknown"`.
//! `"unknown"` rows in the S2-2 panel are a quality signal for missing
//! instrumentation.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::Connection;

use crate::ai::error::AiError;
use crate::ai::provider::{AIProvider, ChatOpts, EndpointClass, ImageOpts, Message};
use crate::db::queries::{
    get_or_create_device_id, insert_ai_audit_log_with_device_id, AiAuditLogInsert,
};

// ─── Token usage ──────────────────────────────────────────────────────────────

/// Token counts for one AI call. `None` means the provider did not report
/// counts for that direction (e.g. CLI providers never report tokens).
#[derive(Debug, Clone, Default)]
pub struct TokenUsage {
    pub tokens_in: Option<u32>,
    pub tokens_out: Option<u32>,
}

/// Per-provider-instance scratch slot. Written by the inner provider just
/// before its async fn returns; read and cleared by `AuditingProvider` after
/// the call returns. See module-level doc for the concurrency caveat.
pub type TokenUsageSlot = Arc<Mutex<Option<TokenUsage>>>;

// ─── Feature-attribution task-local ───────────────────────────────────────────

tokio::task_local! {
    static CURRENT_FEATURE: String;
}

/// Wrap a future so that `current_feature()` returns `feature` for the
/// duration of that future (including any `.await` points within it,
/// within the same task).
pub async fn with_feature<F, T>(feature: &str, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    CURRENT_FEATURE.scope(feature.to_string(), fut).await
}

/// Return the feature label set by the innermost enclosing `with_feature`
/// scope, or `"unknown"` if no scope is active.
pub fn current_feature() -> String {
    CURRENT_FEATURE
        .try_with(|f| f.clone())
        .unwrap_or_else(|_| "unknown".into())
}

// ─── Token-capture task-local ─────────────────────────────────────────────────
//
// Call sites that need the same token counts the audit layer already computed
// (e.g. persisting per-message metadata) wrap their provider call:
//
// ```rust,ignore
// let (result, usage) = ai::audit::with_token_capture(async {
//     provider.chat(&messages, opts).await
// }).await;
// ```
//
// The slot is an `Arc` so spawned child tasks (streaming) can re-enter the same
// capture via [`with_token_capture_slot`] after cloning the slot from
// [`current_token_capture_slot`].

/// Shared slot written by `AuditingProvider::write_row` when a capture scope
/// is active. Held behind `Arc` so parent + spawned stream tasks can share it.
pub type TokenCaptureSlot = Arc<Mutex<Option<TokenUsage>>>;

tokio::task_local! {
    static TOKEN_CAPTURE: TokenCaptureSlot;
}

/// Run `fut` inside a token-capture scope; return the result and any usage
/// written by an `AuditingProvider` during the future.
pub async fn with_token_capture<F, T>(fut: F) -> (T, Option<TokenUsage>)
where
    F: std::future::Future<Output = T>,
{
    let slot: TokenCaptureSlot = Arc::new(Mutex::new(None));
    let result = TOKEN_CAPTURE.scope(slot.clone(), fut).await;
    let usage = slot.lock().ok().and_then(|mut g| g.take());
    (result, usage)
}

/// Re-enter a token-capture scope with an existing shared slot (for spawned
/// tasks that must write into the parent scope's capture).
pub async fn with_token_capture_slot<F, T>(slot: TokenCaptureSlot, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    TOKEN_CAPTURE.scope(slot, fut).await
}

/// Clone of the active capture slot, if any. Used to hand the slot into a
/// spawned task before re-entering via [`with_token_capture_slot`].
pub fn current_token_capture_slot() -> Option<TokenCaptureSlot> {
    TOKEN_CAPTURE.try_with(|s| s.clone()).ok()
}

/// Map `EndpointClass` to the stable string stored in audit rows and
/// per-message metadata columns.
pub fn endpoint_class_str(class: EndpointClass) -> &'static str {
    match class {
        EndpointClass::Local => "local",
        EndpointClass::Remote => "remote",
        EndpointClass::Subscription => "subscription",
        EndpointClass::OnDevice => "on-device",
    }
}

// ─── AuditSink ────────────────────────────────────────────────────────────────

/// Recipient for completed audit rows. Best-effort: implementations MUST NOT
/// propagate errors to callers — log with `log::warn!` and drop on failure.
pub trait AuditSink: Send + Sync {
    fn record(&self, row: AiAuditLogInsert);
}

/// Production sink: writes to SQLite via the shared connection.
///
/// The local `device_id` is cached on first successful read so subsequent
/// AI provider calls avoid the settings-table lookup. The cache stays
/// behind a `Mutex<Option<String>>` (not a `OnceLock`) because the very
/// first audit call after app start may race with database initialisation
/// — a failed read must remain retryable.
pub struct SqliteAuditSink {
    db: Arc<Mutex<Connection>>,
    device_id: Mutex<Option<String>>,
}

impl SqliteAuditSink {
    pub fn new(db: Arc<Mutex<Connection>>) -> Self {
        Self {
            db,
            device_id: Mutex::new(None),
        }
    }

    /// Return the cached device id, fetching from the DB on first call.
    /// Returns `None` if the lookup failed; the caller logs and drops
    /// the row (audit is best-effort).
    fn cached_device_id(&self, conn: &Connection) -> Option<String> {
        if let Ok(mut guard) = self.device_id.lock() {
            if let Some(id) = guard.as_ref() {
                return Some(id.clone());
            }
            match get_or_create_device_id(conn) {
                Ok(id) => {
                    *guard = Some(id.clone());
                    Some(id)
                }
                Err(e) => {
                    log::warn!("ai audit: device_id lookup failed: {e}");
                    None
                }
            }
        } else {
            None
        }
    }
}

impl AuditSink for SqliteAuditSink {
    fn record(&self, row: AiAuditLogInsert) {
        match self.db.lock() {
            Ok(conn) => {
                let Some(device_id) = self.cached_device_id(&conn) else {
                    return;
                };
                if let Err(e) = insert_ai_audit_log_with_device_id(&conn, &device_id, &row) {
                    log::warn!("ai audit: failed to write audit row: {e}");
                }
            }
            Err(e) => {
                log::warn!("ai audit: failed to acquire db lock for audit row: {e}");
            }
        }
    }
}

/// No-op sink — drops every row. Used by `ProviderRegistry::default()` and
/// in tests that don't need to assert on audit rows.
pub struct NoopAuditSink;

impl AuditSink for NoopAuditSink {
    fn record(&self, _row: AiAuditLogInsert) {}
}

// ─── AuditingProvider ─────────────────────────────────────────────────────────

/// Decorator that wraps any `Arc<dyn AIProvider>`, forwarding every method to
/// the inner provider while recording one `ai_audit_log` row per call.
pub struct AuditingProvider {
    inner: Arc<dyn AIProvider>,
    sink: Arc<dyn AuditSink>,
    usage_slot: TokenUsageSlot,
}

impl AuditingProvider {
    /// Wrap `inner` with the given audit sink. Calls `set_usage_sink` on the
    /// inner provider so it can write token counts back into the slot.
    pub fn new(inner: Arc<dyn AIProvider>, sink: Arc<dyn AuditSink>) -> Self {
        let usage_slot: TokenUsageSlot = Arc::new(Mutex::new(None));
        // One-time injection — inner provider holds a weak clone so it can
        // fill in token counts when a call completes.
        inner.set_usage_sink(usage_slot.clone());
        Self {
            inner,
            sink,
            usage_slot,
        }
    }

    /// Now-unix-ms helper.
    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// Drain the token-usage slot after an inner call completes.
    fn take_usage(&self) -> Option<TokenUsage> {
        self.usage_slot.lock().ok().and_then(|mut g| g.take())
    }

    /// Write one audit row. Never panics, never propagates errors.
    fn write_row(
        &self,
        operation: &str,
        payload_bytes: usize,
        latency_ms: u64,
        status: &str,
        error_code: Option<&str>,
        usage: Option<TokenUsage>,
    ) {
        // Surface token counts to an enclosing `with_token_capture` scope
        // (if any) without disturbing the audit write.
        if let Some(slot) = current_token_capture_slot() {
            if let Ok(mut guard) = slot.lock() {
                *guard = usage.clone();
            }
        }
        let row = AiAuditLogInsert {
            created_at: Self::now_ms(),
            feature: current_feature(),
            operation: operation.to_string(),
            provider_id: self.inner.id().to_string(),
            model_id: self.inner.chat_model_id().to_string(),
            endpoint_host: self.inner.endpoint_host(),
            endpoint_class: endpoint_class_str(self.inner.endpoint_class()).into(),
            payload_bytes: payload_bytes as i64,
            latency_ms: latency_ms as i64,
            status: status.to_string(),
            error_code: error_code.map(|s| s.to_string()),
            tokens_in: usage.as_ref().and_then(|u| u.tokens_in).map(|v| v as i64),
            tokens_out: usage.as_ref().and_then(|u| u.tokens_out).map(|v| v as i64),
        };
        self.sink.record(row);
    }

    /// Extract a stable error-code string from an `AiError` for the audit row.
    fn error_code(e: &AiError) -> &'static str {
        match e {
            AiError::ProviderNotConfigured => "ProviderNotConfigured",
            AiError::PrivacyNotAccepted => "PrivacyNotAccepted",
            AiError::BulkContextNotAccepted => "BulkContextNotAccepted",
            AiError::ProviderUnsupported(_) => "ProviderUnsupported",
            AiError::ProviderError(_) => "ProviderError",
            AiError::FeatureDisabled(_) => "FeatureDisabled",
            AiError::AuthFailed => "AuthFailed",
            AiError::RateLimited => "RateLimited",
            AiError::IoError(_) => "IoError",
            AiError::Cancelled => "Cancelled",
            AiError::EmptyResponse => "EmptyResponse",
            AiError::ModelNotReady(_) => "ModelNotReady",
            AiError::ChatContextRefused(_) => "ChatContextRefused",
        }
    }
}

#[async_trait]
impl AIProvider for AuditingProvider {
    // ── Forwarded identity methods ─────────────────────────────────────────

    fn id(&self) -> &str {
        self.inner.id()
    }

    fn display_name(&self) -> &str {
        self.inner.display_name()
    }

    fn embedding_model_id(&self) -> &str {
        self.inner.embedding_model_id()
    }

    fn chat_model_id(&self) -> &str {
        self.inner.chat_model_id()
    }

    fn endpoint_host(&self) -> String {
        self.inner.endpoint_host()
    }

    fn endpoint_class(&self) -> EndpointClass {
        self.inner.endpoint_class()
    }

    // set_usage_sink is intentionally NOT forwarded — the slot belongs to
    // this decorator, not the inner provider. An outer decorator calling
    // set_usage_sink on us would replace our slot reference; we don't support
    // nesting decorators in the current design.

    // ── Instrumented operations ────────────────────────────────────────────

    async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        let payload_bytes: usize = texts.iter().map(|t| t.len()).sum();
        let start = Instant::now();
        let result = self.inner.embed(texts).await;
        let latency_ms = start.elapsed().as_millis() as u64;
        let usage = self.take_usage();
        match &result {
            Ok(_) => self.write_row("embed", payload_bytes, latency_ms, "ok", None, usage),
            Err(e) => self.write_row(
                "embed",
                payload_bytes,
                latency_ms,
                "err",
                Some(Self::error_code(e)),
                None,
            ),
        }
        result
    }

    async fn embed_query(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        // Forwards to `inner.embed_query` (not `inner.embed`) — the trait's
        // default `embed_query` would otherwise dispatch through THIS
        // decorator's own `embed` override, never reaching an asymmetric
        // inner provider's (e.g. on-device E5/Nomic) query-prefixed path.
        // Logged under the same "embed" operation label as `embed` — audit
        // rows/tests don't currently distinguish doc vs query embed calls.
        let payload_bytes: usize = texts.iter().map(|t| t.len()).sum();
        let start = Instant::now();
        let result = self.inner.embed_query(texts).await;
        let latency_ms = start.elapsed().as_millis() as u64;
        let usage = self.take_usage();
        match &result {
            Ok(_) => self.write_row("embed", payload_bytes, latency_ms, "ok", None, usage),
            Err(e) => self.write_row(
                "embed",
                payload_bytes,
                latency_ms,
                "err",
                Some(Self::error_code(e)),
                None,
            ),
        }
        result
    }

    async fn chat(&self, messages: &[Message], opts: ChatOpts) -> Result<String, AiError> {
        let payload_bytes: usize = messages.iter().map(|m| m.content.len()).sum();
        let start = Instant::now();
        let result = self.inner.chat(messages, opts).await;
        let latency_ms = start.elapsed().as_millis() as u64;
        let usage = self.take_usage();
        match &result {
            Ok(_) => self.write_row("chat", payload_bytes, latency_ms, "ok", None, usage),
            Err(e) => self.write_row(
                "chat",
                payload_bytes,
                latency_ms,
                "err",
                Some(Self::error_code(e)),
                None,
            ),
        }
        result
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        opts: ChatOpts,
        tx: tokio::sync::mpsc::Sender<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(), AiError> {
        let payload_bytes: usize = messages.iter().map(|m| m.content.len()).sum();
        let start = Instant::now();
        let result = self.inner.chat_stream(messages, opts, tx, cancel).await;
        let latency_ms = start.elapsed().as_millis() as u64;
        let usage = self.take_usage();
        match &result {
            Ok(_) => self.write_row("chat_stream", payload_bytes, latency_ms, "ok", None, usage),
            Err(e) => self.write_row(
                "chat_stream",
                payload_bytes,
                latency_ms,
                "err",
                Some(Self::error_code(e)),
                None,
            ),
        }
        result
    }

    async fn generate_image(&self, prompt: &str, opts: ImageOpts) -> Result<Vec<u8>, AiError> {
        let payload_bytes = prompt.len();
        let start = Instant::now();
        let result = self.inner.generate_image(prompt, opts).await;
        let latency_ms = start.elapsed().as_millis() as u64;
        let usage = self.take_usage();
        match &result {
            Ok(_) => self.write_row(
                "generate_image",
                payload_bytes,
                latency_ms,
                "ok",
                None,
                usage,
            ),
            Err(e) => self.write_row(
                "generate_image",
                payload_bytes,
                latency_ms,
                "err",
                Some(Self::error_code(e)),
                None,
            ),
        }
        result
    }
}

// ─── Startup retention purge ──────────────────────────────────────────────────

/// Retention setting key stored in the `settings` table.
pub const AUDIT_RETENTION_DAYS_KEY: &str = "ai_audit_retention_days";

/// Default retention: 90 days.
pub const DEFAULT_RETENTION_DAYS: u32 = 90;

/// Called once during app startup (after `db::migrate`). Reads the
/// `ai_audit_retention_days` setting (default 90) and deletes rows older than
/// that many days. Returns the count of rows deleted. Failures are logged and
/// returned as an error so the caller can decide whether to propagate.
/// Hard upper bound on the retention window in days. Caps `u32` settings
/// at 100 years so the cutoff math (`days * 86_400_000`) can never overflow
/// `i64`. The S2-2 UI slider clamps to 365 days; this guards against a
/// hand-edited DB row, a bug in a future setter, or an out-of-band script
/// writing a garbage value.
pub const MAX_RETENTION_DAYS: u32 = 36_500;

pub fn run_startup_retention_purge(conn: &Connection, now_ms: i64) -> rusqlite::Result<usize> {
    let days_raw = crate::db::queries::get_setting(conn, AUDIT_RETENTION_DAYS_KEY)
        .unwrap_or(None)
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS);
    let days = days_raw.min(MAX_RETENTION_DAYS);
    if days != days_raw {
        log::warn!(
            "ai audit: retention setting {days_raw} exceeds maximum {MAX_RETENTION_DAYS}; clamping"
        );
    }

    let cutoff_ms = now_ms - (days as i64) * 86_400_000;
    let deleted = crate::db::queries::purge_ai_audit_log_older_than(conn, cutoff_ms)?;
    if deleted > 0 {
        log::info!("ai audit: purged {deleted} rows older than {days} days (cutoff {cutoff_ms}ms)");
    }
    Ok(deleted)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::error::AiError;
    use crate::ai::provider::{ChatOpts, Message, MessageRole};
    use crate::db::queries::{insert_ai_audit_log, list_ai_audit_log, AiAuditLogFilter};
    use crate::db::schema::migrate;
    use async_trait::async_trait;
    use rusqlite::Connection;
    use std::sync::Arc;
    use tokio::runtime::Runtime;

    // ── Test helpers ────────────────────────────────────────────────────────

    fn setup_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        Arc::new(Mutex::new(conn))
    }

    fn sink(db: Arc<Mutex<Connection>>) -> Arc<dyn AuditSink> {
        Arc::new(SqliteAuditSink::new(db))
    }

    fn list_rows(db: &Arc<Mutex<Connection>>) -> Vec<crate::db::queries::AiAuditLogRow> {
        let conn = db.lock().unwrap();
        list_ai_audit_log(&conn, &AiAuditLogFilter::default(), 100, 0).unwrap()
    }

    // A minimal fake provider for testing the decorator.
    //
    // Matches the production semantics from `OpenAICompatibleProvider`: the
    // `set_usage_sink` method stores the slot in a per-instance field via
    // interior mutability (`Mutex<Option<TokenUsageSlot>>`) so two
    // independently wrapped instances never share slot state. The previous
    // thread-local design worked for the single-threaded tests but masked
    // the real concurrency model — switched to the per-instance field so
    // tests exercise the same shape production uses.
    struct FakeProvider {
        pub id: String,
        pub embed_result: Result<Vec<Vec<f32>>, AiError>,
        /// Distinct from `embed_result` so tests can prove `embed_query`
        /// calls are routed to THIS field, not silently reused from
        /// `embed_result` via the wrong forwarding path.
        pub embed_query_result: Result<Vec<Vec<f32>>, AiError>,
        pub chat_result: Result<String, AiError>,
        /// If Some, write this usage to the slot before returning.
        pub usage_to_write: Option<TokenUsage>,
        /// Simulated latency in milliseconds.
        pub sleep_ms: u64,
        /// Per-instance usage-slot handle, populated by `set_usage_sink`.
        usage_slot: Mutex<Option<TokenUsageSlot>>,
    }

    impl FakeProvider {
        fn ok(id: &str) -> Self {
            Self {
                id: id.into(),
                embed_result: Ok(vec![vec![1.0, 0.0]]),
                embed_query_result: Ok(vec![vec![0.0, 1.0]]),
                chat_result: Ok("hello".into()),
                usage_to_write: None,
                sleep_ms: 0,
                usage_slot: Mutex::new(None),
            }
        }

        fn with_sleep(mut self, ms: u64) -> Self {
            self.sleep_ms = ms;
            self
        }

        fn with_usage(mut self, usage: TokenUsage) -> Self {
            self.usage_to_write = Some(usage);
            self
        }

        fn with_embed_err(mut self, e: AiError) -> Self {
            self.embed_result = Err(e);
            self
        }

        /// Write configured usage into the AuditingProvider slot (if any).
        fn publish_usage(&self) {
            if let Some(ref usage) = self.usage_to_write {
                if let Ok(guard) = self.usage_slot.lock() {
                    if let Some(ref slot) = *guard {
                        if let Ok(mut g) = slot.lock() {
                            *g = Some(usage.clone());
                        }
                    }
                }
            }
        }
    }

    #[async_trait]
    impl AIProvider for FakeProvider {
        fn id(&self) -> &str {
            &self.id
        }
        fn display_name(&self) -> &str {
            "Fake"
        }
        fn embedding_model_id(&self) -> &str {
            "fake-embed"
        }
        fn chat_model_id(&self) -> &str {
            "fake-chat"
        }

        fn set_usage_sink(&self, slot: TokenUsageSlot) {
            // Mirror production semantics — store per-instance, not in a
            // thread-local. This means two independently wrapped instances
            // each get their own slot.
            if let Ok(mut guard) = self.usage_slot.lock() {
                *guard = Some(slot);
            }
        }

        async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            if self.sleep_ms > 0 {
                tokio::time::sleep(tokio::time::Duration::from_millis(self.sleep_ms)).await;
            }
            self.publish_usage();
            let _ = texts; // payload_bytes computed by wrapper
            self.embed_result.clone()
        }

        async fn embed_query(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            let _ = texts;
            self.embed_query_result.clone()
        }

        async fn chat(&self, messages: &[Message], _opts: ChatOpts) -> Result<String, AiError> {
            if self.sleep_ms > 0 {
                tokio::time::sleep(tokio::time::Duration::from_millis(self.sleep_ms)).await;
            }
            self.publish_usage();
            let _ = messages;
            self.chat_result.clone()
        }
    }

    // ── Tests ────────────────────────────────────────────────────────────────

    #[test]
    fn auditing_provider_forwards_id_display_name_and_models() {
        let db = setup_db();
        let inner: Arc<dyn AIProvider> = Arc::new(FakeProvider::ok("my-provider"));
        let ap = AuditingProvider::new(inner, sink(db));
        assert_eq!(ap.id(), "my-provider");
        assert_eq!(ap.display_name(), "Fake");
        assert_eq!(ap.embedding_model_id(), "fake-embed");
        assert_eq!(ap.chat_model_id(), "fake-chat");
    }

    #[test]
    fn auditing_provider_writes_ok_row_for_successful_embed() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let db = setup_db();
            let inner: Arc<dyn AIProvider> = Arc::new(FakeProvider::ok("test").with_sleep(5));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));
            ap.embed(&["hello"]).await.unwrap();

            let rows = list_rows(&db);
            assert_eq!(rows.len(), 1);
            let r = &rows[0];
            assert_eq!(r.status, "ok");
            assert_eq!(r.operation, "embed");
            assert!(r.latency_ms >= 5, "latency_ms={}", r.latency_ms);
            assert_eq!(r.payload_bytes, 5); // "hello".len() == 5
        });
    }

    #[test]
    fn auditing_provider_embed_query_forwards_to_inner_embed_query_not_embed() {
        // The regression this guards: a default `embed_query` on
        // `AuditingProvider` (i.e. not overridden) would dispatch through
        // `AuditingProvider`'s OWN `embed` — reaching `inner.embed`
        // instead of `inner.embed_query` — silently losing the query-side
        // prefix on any asymmetric inner provider (on-device E5/Nomic).
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let db = setup_db();
            let inner: Arc<dyn AIProvider> = Arc::new(FakeProvider::ok("test"));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));
            let out = ap.embed_query(&["hello"]).await.unwrap();
            assert_eq!(
                out,
                vec![vec![0.0, 1.0]],
                "must return embed_query_result, not embed_result"
            );

            let rows = list_rows(&db);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].status, "ok");
            assert_eq!(rows[0].operation, "embed");
        });
    }

    #[test]
    fn auditing_provider_writes_err_row_with_error_code() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let db = setup_db();
            let inner: Arc<dyn AIProvider> =
                Arc::new(FakeProvider::ok("test").with_embed_err(AiError::AuthFailed));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));
            let _ = ap.embed(&["hello"]).await;

            let rows = list_rows(&db);
            assert_eq!(rows.len(), 1);
            let r = &rows[0];
            assert_eq!(r.status, "err");
            assert_eq!(r.error_code.as_deref(), Some("AuthFailed"));
        });
    }

    #[test]
    fn auditing_provider_captures_token_usage_when_slot_populated() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let db = setup_db();
            let inner: Arc<dyn AIProvider> =
                Arc::new(FakeProvider::ok("test").with_usage(TokenUsage {
                    tokens_in: Some(120),
                    tokens_out: Some(30),
                }));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));
            ap.embed(&["hello"]).await.unwrap();

            let rows = list_rows(&db);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].tokens_in, Some(120));
            assert_eq!(rows[0].tokens_out, Some(30));
        });
    }

    #[test]
    fn auditing_provider_records_null_tokens_when_slot_empty() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let db = setup_db();
            let inner: Arc<dyn AIProvider> = Arc::new(FakeProvider::ok("test"));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));
            ap.embed(&["hello"]).await.unwrap();

            let rows = list_rows(&db);
            assert_eq!(rows.len(), 1);
            assert!(rows[0].tokens_in.is_none());
            assert!(rows[0].tokens_out.is_none());
        });
    }

    #[test]
    fn with_token_capture_returns_usage_from_write_row() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let db = setup_db();
            let inner: Arc<dyn AIProvider> =
                Arc::new(FakeProvider::ok("test").with_usage(TokenUsage {
                    tokens_in: Some(42),
                    tokens_out: Some(7),
                }));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));

            let (result, usage) = with_token_capture(ap.embed(&["hi"])).await;
            result.unwrap();
            let usage = usage.expect("capture must surface tokens");
            assert_eq!(usage.tokens_in, Some(42));
            assert_eq!(usage.tokens_out, Some(7));
            // Audit row still written.
            assert_eq!(list_rows(&db).len(), 1);
        });
    }

    /// Regression: Daily Chat streams inside `tauri::async_runtime::spawn`,
    /// so token capture must re-enter the shared slot in the child task —
    /// same hand-off as `stream_chat_with_fallback`. Without re-entry,
    /// `write_row` sees no capture scope and tokens stay NULL forever.
    #[test]
    fn with_token_capture_survives_spawn_reentry_on_chat_stream() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let db = setup_db();
            let inner: Arc<dyn AIProvider> =
                Arc::new(FakeProvider::ok("test").with_usage(TokenUsage {
                    tokens_in: Some(99),
                    tokens_out: Some(11),
                }));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));

            let (stream_result, usage) = with_token_capture(async {
                // Mirror stream_chat_with_fallback: capture slot on parent,
                // re-enter on spawned task before chat_stream/write_row.
                let slot =
                    current_token_capture_slot().expect("with_token_capture must install a slot");
                let ap_spawn = Arc::clone(&ap);
                let handle = tokio::spawn(async move {
                    with_token_capture_slot(slot, async {
                        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
                        let cancel = tokio_util::sync::CancellationToken::new();
                        let messages = [Message {
                            role: MessageRole::User,
                            content: "hi".into(),
                        }];
                        let call = ap_spawn.chat_stream(&messages, ChatOpts::default(), tx, cancel);
                        // Drain deltas concurrently with the stream task
                        // (default chat_stream falls back to chat → one delta).
                        let drain = async { while rx.recv().await.is_some() {} };
                        let (outcome, _) = tokio::join!(call, drain);
                        outcome
                    })
                    .await
                });
                handle.await.expect("join spawn").expect("chat_stream ok")
            })
            .await;

            let _ = stream_result;
            let usage = usage.expect("spawn re-entry must surface stream tokens");
            assert_eq!(usage.tokens_in, Some(99));
            assert_eq!(usage.tokens_out, Some(11));
            assert_eq!(list_rows(&db).len(), 1);
            assert_eq!(list_rows(&db)[0].operation, "chat_stream");
        });
    }

    #[test]
    fn auditing_provider_records_feature_from_task_local() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let db = setup_db();
            let inner: Arc<dyn AIProvider> = Arc::new(FakeProvider::ok("test"));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));

            // Call inside with_feature scope.
            with_feature("smart_title", ap.embed(&["hi"]))
                .await
                .unwrap();

            let rows = list_rows(&db);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].feature, "smart_title");
        });

        // Without scope → "unknown".
        let rt2 = Runtime::new().unwrap();
        rt2.block_on(async {
            let db = setup_db();
            let inner: Arc<dyn AIProvider> = Arc::new(FakeProvider::ok("test"));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));
            ap.embed(&["hi"]).await.unwrap();

            let rows = list_rows(&db);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].feature, "unknown");
        });
    }

    #[test]
    fn auditing_provider_chat_stream_writes_one_row_at_stream_end() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let db = setup_db();
            // The default chat_stream falls back to chat, which FakeProvider
            // returns "hello" for. One row should appear after the stream ends.
            let inner: Arc<dyn AIProvider> = Arc::new(FakeProvider::ok("test").with_sleep(5));
            let ap = Arc::new(AuditingProvider::new(inner, sink(db.clone())));

            let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(16);
            let cancel = tokio_util::sync::CancellationToken::new();
            let msg = Message {
                role: MessageRole::User,
                content: "hello world".into(),
            };

            ap.chat_stream(&[msg], ChatOpts::default(), tx, cancel)
                .await
                .unwrap();
            // Drain any deltas.
            while rx.try_recv().is_ok() {}

            let rows = list_rows(&db);
            assert_eq!(rows.len(), 1, "chat_stream must write exactly one row");
            let r = &rows[0];
            assert_eq!(r.operation, "chat_stream");
            assert!(r.latency_ms >= 5, "latency_ms={}", r.latency_ms);
        });
    }

    #[test]
    fn retention_purge_runs_on_startup_with_default_90_days() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        let now_ms = 100 * 86_400_000i64; // arbitrary "now"
        let old_ms = now_ms - 100 * 86_400_000; // 100 days ago — beyond default 90d
        let recent_ms = now_ms - 1 * 86_400_000; // 1 day ago

        let old_row = AiAuditLogInsert {
            created_at: old_ms,
            feature: "test".into(),
            operation: "chat".into(),
            provider_id: "p".into(),
            model_id: "m".into(),
            endpoint_host: "h".into(),
            endpoint_class: "remote".into(),
            payload_bytes: 1,
            latency_ms: 1,
            status: "ok".into(),
            error_code: None,
            tokens_in: None,
            tokens_out: None,
        };
        let recent_row = AiAuditLogInsert {
            created_at: recent_ms,
            ..old_row.clone()
        };
        insert_ai_audit_log(&conn, &old_row).unwrap();
        insert_ai_audit_log(&conn, &recent_row).unwrap();

        let deleted = run_startup_retention_purge(&conn, now_ms).unwrap();
        assert_eq!(deleted, 1, "only the old row should be purged");

        let rows = list_ai_audit_log(&conn, &AiAuditLogFilter::default(), 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].created_at, recent_ms);
    }
}
